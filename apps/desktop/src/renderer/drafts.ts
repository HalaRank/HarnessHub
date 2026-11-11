import {
  type Draft,
  type ImageAttachment,
  imageAttachments,
  sameImages,
  type Turn,
} from "@harnesshub/shared";
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

export function newConversationDraft(api: DesktopApi) {
  return new DesktopDraft(
    {
      subscribe: api.subscribe,
      request: (request) => {
        if (request.type === "draft.load") return api.request({ type: "new-draft.load" });
        if (request.type === "draft.save")
          return api.request({ type: "new-draft.save", draft: request.draft });
        throw new Error("新建页仅保存草稿，发送前须创建 Conversation。");
      },
    },
    "desktop-new",
  );
}

// A framework-independent editor queue, deliberately separate from the TUI lifecycle.
// Failed CAS never overwrites local text. No pending submission is sent by load/recovery.
export class DesktopDraft {
  value: Draft;
  text = "";
  images: ImageAttachment[] = [];
  get hasContent() {
    return !!this.text.trim() || this.images.length > 0;
  }
  loaded = false;
  busy = false;
  error = "";
  result = "";
  private queue: Promise<unknown> = Promise.resolve();
  private loading: Promise<void> | undefined;
  private imageRead: Promise<void> | undefined;
  private editGeneration = 0;
  private loadGeneration = 0;
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
  invalidateLoads() {
    this.loadGeneration++;
    this.loading = undefined;
  }
  async reload() {
    const request = ++this.loadGeneration;
    const edit = this.editGeneration;
    await this.queue.catch(() => {});
    if (request !== this.loadGeneration) return;
    const revision = this.value.revision;
    const pendingRequestId = this.value.pendingSubmission?.requestId;
    const value = await call<Draft>(this.api, {
      type: "draft.load",
      conversationId: this.conversationId,
    });
    if (request !== this.loadGeneration) return;
    if (
      edit !== this.editGeneration ||
      revision !== this.value.revision ||
      pendingRequestId !== this.value.pendingSubmission?.requestId
    ) {
      this.error = "重载期间草稿已变更；保留了本地新输入，请重新确认后再载入。";
      this.changed();
      return;
    }
    this.value = value;
    this.text = value.text;
    this.images = value.images ?? [];
    this.loaded = true;
    this.error = "";
    this.changed();
  }
  update(text: string) {
    if (!this.loaded || this.busy || this.value.pendingSubmission) return;
    this.editGeneration++;
    this.text = text;
    this.changed();
    void this.flush().catch(() => {});
  }
  updateImages(images: ImageAttachment[]) {
    if (!this.loaded || this.busy || this.value.pendingSubmission) return;
    this.images = imageAttachments.parse(images);
    this.editGeneration++;
    this.changed();
    void this.flush().catch(() => {});
  }
  async readImages(load: Promise<ImageAttachment[]>) {
    if (this.imageRead || !this.loaded || this.busy || this.value.pendingSubmission) return;
    this.imageRead = load.then((images) => {
      this.updateImages([...this.images, ...images]);
    });
    try {
      await this.imageRead;
    } finally {
      this.imageRead = undefined;
    }
    await this.flush();
  }
  async flush() {
    await this.imageRead;
    return this.enqueue(async () => {
      if (
        !this.loaded ||
        this.value.pendingSubmission ||
        (this.text === this.value.text && sameImages(this.images, this.value.images))
      )
        return;
      try {
        this.value = await call<Draft>(this.api, {
          type: "draft.save",
          conversationId: this.conversationId,
          draft: {
            revision: this.value.revision,
            text: this.text,
            images: this.images,
            pendingSubmission: null,
          },
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
    if (
      this.busy ||
      this.imageRead ||
      !this.loaded ||
      !this.hasContent ||
      this.value.pendingSubmission
    )
      return;
    this.invalidateLoads();
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
        ...(this.images.length ? { images: this.images } : {}),
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
          if (latest.text === this.text && sameImages(latest.images, this.images))
            this.value = latest;
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
    this.invalidateLoads();
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
          draft: { revision: latest.revision, text: "", images: [], pendingSubmission: null },
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
