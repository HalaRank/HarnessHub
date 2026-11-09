import type { Draft, Turn } from "@harnesshub/shared";
import type { DesktopApi, DesktopRequest } from "../contracts";

export class DesktopActionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export async function call<T>(api: DesktopApi, request: DesktopRequest): Promise<T> {
  const reply = await api.request(request);
  if (!reply.ok) throw new DesktopActionError(reply.error, reply.status);
  return reply.data as T;
}

// A framework-independent editor queue, deliberately separate from the TUI lifecycle.
// Failed CAS never overwrites local text. No pending submission is sent by load/recovery.
export class DesktopDraft {
  value: Draft;
  text = "";
  loaded = false;
  busy = false;
  error = "";
  result = "";
  private queue: Promise<unknown> = Promise.resolve();
  private loading: Promise<void> | undefined;
  private listeners = new Set<() => void>();
  constructor(
    readonly api: DesktopApi,
    readonly conversationId: string,
  ) {
    this.value = { conversationId, revision: 0, text: "", pendingSubmission: null };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed() {
    for (const listener of this.listeners) listener();
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result;
    return result;
  }
  load() {
    if (this.loaded) return Promise.resolve();
    this.loading ??= this.reload().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }
  async reload() {
    await this.queue.catch(() => {});
    this.value = await call<Draft>(this.api, {
      type: "draft.load",
      conversationId: this.conversationId,
    });
    this.text = this.value.text;
    this.loaded = true;
    this.error = "";
    this.changed();
  }
  update(text: string) {
    if (!this.loaded || this.busy || this.value.pendingSubmission) return;
    this.text = text;
    this.changed();
    void this.flush().catch(() => {});
  }
  flush() {
    return this.enqueue(async () => {
      if (!this.loaded || this.text === this.value.text || this.value.pendingSubmission) return;
      try {
        this.value = await call<Draft>(this.api, {
          type: "draft.save",
          conversationId: this.conversationId,
          draft: { revision: this.value.revision, text: this.text, pendingSubmission: null },
        });
        this.error = "";
      } catch (error) {
        this.error = `草稿未保存（可能被 TUI 修改）。本地文字已保留：${String(error)}`;
        throw error;
      } finally {
        this.changed();
      }
    });
  }
  async submit(
    harnessId: string,
    nativeCommand?: NonNullable<Draft["pendingSubmission"]>["nativeCommand"],
  ) {
    if (this.busy || !this.loaded || !this.text.trim() || this.value.pendingSubmission) return;
    this.busy = true;
    this.error = "";
    this.result = "";
    this.changed();
    try {
      await this.flush();
      const input = {
        requestId: crypto.randomUUID(),
        harnessId,
        message: this.text,
        ...(nativeCommand ? { nativeCommand } : {}),
      };
      // Retain the ID in memory even if the IPC response itself is lost.
      const revision = this.value.revision;
      this.value = { ...this.value, pendingSubmission: input };
      const turn = await call<Turn>(this.api, {
        type: "turn.submit",
        conversationId: this.conversationId,
        revision,
        input,
      });
      this.result = `已发送 · ${turn.state === "UNCERTAIN" ? "执行结果不确定" : "请求已记录"}`;
      await this.reload();
    } catch (error) {
      this.error = `提交未完成：${String(error)}。若有未确认 requestId，请先查询；不会自动重发。`;
      // Only an explicit rejection can release a local reservation. Unknown outcomes
      // retain it for lookup, even when Runtime has already consumed the SQLite draft.
      if (error instanceof DesktopActionError && [400, 409].includes(error.status ?? 0)) {
        this.value = { ...this.value, pendingSubmission: null };
        try {
          const latest = await call<Draft>(this.api, {
            type: "draft.load",
            conversationId: this.conversationId,
          });
          if (latest.text === this.text) this.value = latest;
        } catch {
          /* Keep the old CAS revision and local text. */
        }
      }
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async lookup() {
    const pending = this.value.pendingSubmission;
    if (!pending || this.busy) return;
    this.busy = true;
    this.changed();
    try {
      const turn = await call<Turn>(this.api, {
        type: "request.lookup",
        conversationId: this.conversationId,
        requestId: pending.requestId,
      });
      this.result = `${turn.state} · requestId ${pending.requestId} · 已记录，未重发`;
      // Runtime normally consumes the reservation atomically. For a stale cross-client
      // draft, clear only the same request, with CAS; never erase another editor's draft.
      const latest = await call<Draft>(this.api, {
        type: "draft.load",
        conversationId: this.conversationId,
      });
      if (latest.pendingSubmission?.requestId === pending.requestId) {
        await call(this.api, {
          type: "draft.save",
          conversationId: this.conversationId,
          draft: { revision: latest.revision, text: "", pendingSubmission: null },
        });
      }
      await this.reload();
    } catch (error) {
      this.error = `请求仍未确认：${String(error)}。未重发；请检查历史和工作区。`;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
