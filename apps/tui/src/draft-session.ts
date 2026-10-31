import { randomUUID } from "node:crypto";
import type { Draft, Turn } from "@harnesshub/shared";
import { connect, HttpError } from "@harnesshub/shared/client";

const savers = new Set<() => Promise<void>>();
const departing = new Map<string, DraftSession>();
export async function flushDrafts() {
  await Promise.all([...savers].map((save) => save()));
}

// One queue per editor orders autosaves and reserves the request ID before sending a Prompt.
// CAS rejects stale clients; a persisted submission is queried on reopen, never auto-sent.
export class DraftSession {
  value: Draft;
  text = "";
  private queue = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly saveOnExit = async () => {
    await this.flush();
    if (this.disposed) {
      savers.delete(this.saveOnExit);
      if (departing.get(this.conversationId) === this) departing.delete(this.conversationId);
    }
  };
  constructor(
    readonly conversationId: string,
    readonly changed: () => void,
    readonly failed: (error: unknown) => void,
  ) {
    this.value = { conversationId, text: "", revision: 0, pendingSubmission: null };
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const client = await connect();
    if (!client) throw new Error("Daemon disconnected; draft has not been saved");
    return client.request<T>(path, method, body);
  }
  async load() {
    // Rapidly returning to a pane must wait for its prior editor's queued CAS save.
    // A failed save is retried explicitly by reopening; its local text stays registered.
    const previous = departing.get(this.conversationId);
    if (previous && previous !== this) await previous.saveOnExit();
    this.value = await this.request<Draft>(`/v1/conversations/${this.conversationId}/draft`);
    this.text = this.value.text;
    // Recover an ACK lost after the Turn was committed. Reads do not dispatch tasks.
    const pending = this.value.pendingSubmission;
    if (pending) {
      try {
        const turn = await this.request<Turn>(`/v1/requests/${pending.requestId}`);
        if (turn.conversationId === this.conversationId) {
          this.text = "";
          try {
            await this.save(null);
          } catch (error) {
            if (!(error instanceof HttpError && error.status === 409)) throw error;
            // Runtime/another TUI may already have consumed it. Reload without overwriting.
            this.value = await this.request<Draft>(
              `/v1/conversations/${this.conversationId}/draft`,
            );
            this.text = this.value.text;
          }
        }
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) throw error;
      }
    }
    savers.add(this.saveOnExit);
    this.changed();
  }
  update(text: string) {
    this.text = text;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(this.failed);
    }, 150);
  }
  private async save(pendingSubmission = this.value.pendingSubmission) {
    const saved = await this.request<Draft>(
      `/v1/conversations/${this.conversationId}/draft`,
      "PUT",
      {
        text: this.text,
        revision: this.value.revision,
        pendingSubmission,
      },
    );
    this.value = saved;
    this.changed();
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  flush() {
    clearTimeout(this.timer);
    return this.enqueue(async () => {
      if (this.text !== this.value.text) await this.save();
    });
  }
  prepare(harnessId: string) {
    clearTimeout(this.timer);
    return this.enqueue(async () => {
      const pending = this.value.pendingSubmission;
      if (pending && (pending.message !== this.text || pending.harnessId !== harnessId))
        throw new Error(
          `Unconfirmed request ${pending.requestId}; check its status or explicitly retry the original message`,
        );
      if (!pending) await this.save({ requestId: randomUUID(), message: this.text, harnessId });
      return this.value.pendingSubmission as NonNullable<Draft["pendingSubmission"]>;
    });
  }
  async accepted() {
    // The Runtime consumes only the matching reserved draft, alongside request acceptance.
    this.value = await this.request<Draft>(`/v1/conversations/${this.conversationId}/draft`);
    this.text = this.value.text;
    this.changed();
  }
  rejected() {
    return this.enqueue(() => this.save(null));
  }
  async dispose() {
    this.disposed = true;
    departing.set(this.conversationId, this);
    // Keep a failed save registered so leaving the Conversation cannot silently drop its text.
    await this.saveOnExit();
  }
}
