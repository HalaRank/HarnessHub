import type {
  Approval,
  ConversationEvent,
  Handoff,
  NativeSession,
  Snapshot,
} from "@harnesshub/shared";
import { Client, HttpError } from "@harnesshub/shared/client";
import WebSocket from "ws";
import type { DesktopRequest, DesktopState } from "../contracts";
import { performAction } from "./actions";
import { BridgeError, type WslBridge } from "./wsl";

export class DesktopConnection {
  private state: DesktopState = {
    revision: 0,
    status: "idle",
    detail: "选择 WSL2 发行版以连接",
    distribution: null,
    snapshot: null,
    conversationId: null,
    events: [],
    historyLoading: false,
  };
  private refreshNow: (() => Promise<void>) | undefined;
  private readonly gitReads = new Map<string, Promise<unknown>>();
  private readonly submissions = new Map<string, Promise<unknown>>();
  private client: Client | undefined;
  private socket: WebSocket | undefined;
  private epoch = 0;
  private metadataRevision = 0;
  private selection = 0;
  private historyRead: Promise<void> = Promise.resolve();
  private preferenceWrite: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private emit: (state: DesktopState) => void = () => {};
  constructor(
    private readonly bridge: Pick<WslBridge, "connect">,
    private readonly retryMs = 2000,
  ) {}
  onState(callback: (state: DesktopState) => void) {
    this.emit = callback;
  }
  getState(): DesktopState {
    return this.state;
  }
  private update(patch: Partial<DesktopState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    // Keep only a bounded inspection tail in Main; IPC carries the new batch once.
    this.emit({ ...this.state, events: patch.events ?? [] });
  }
  private clearTransport() {
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.timer = undefined;
    this.poll = undefined;
    this.client = undefined;
    this.refreshNow = undefined;
    this.socket?.removeAllListeners();
    this.socket?.on("error", () => {});
    this.socket?.terminate();
    this.socket = undefined;
  }
  async connect(distribution: string) {
    if (this.disposed) return;
    const changed = distribution !== this.state.distribution;
    const epoch = ++this.epoch;
    this.clearTransport(); // Discard every old token before rediscovery, even on manual reconnect.
    this.update({
      distribution,
      backend: null,
      status: "starting",
      detail: "正在检查 WSL 与 Daemon…",
      ...(changed
        ? {
            snapshot: null,
            conversationId: null,
            events: [],
            interaction: null,
            eventCursor: 0,
            historyVersion: (this.state.historyVersion ?? 0) + 1,
          }
        : {}),
    });
    try {
      const instance = await this.bridge.connect(distribution);
      if (epoch !== this.epoch || this.disposed) return;
      const client = new Client(instance);
      const health = await client.request<{
        instanceId: string;
        pid: number;
        version: string;
        protocolVersion: number;
        product: string;
        runtime: string;
      }>("/v1/health");
      if (
        health.instanceId !== instance.instanceId ||
        health.pid !== instance.pid ||
        health.product !== "HarnessHub" ||
        health.runtime !== "node"
      )
        throw new BridgeError(
          "IDENTITY",
          "localhost 端口未对应所选 WSL Daemon；请检查端口转发或端口冲突。",
        );
      if (
        health.version !== instance.version ||
        health.protocolVersion !== instance.protocolVersion
      )
        throw new BridgeError(
          "INCOMPATIBLE",
          "Daemon 健康检查版本不匹配；任务未停止，请安全更新匹配版本。",
        );
      if (epoch !== this.epoch || this.disposed) return;
      this.update({
        backend: {
          bridgeVersion: instance.version,
          bridgeProtocol: instance.protocolVersion,
          daemonVersion: health.version,
          daemonProtocol: health.protocolVersion,
          instanceId: health.instanceId,
          readiness: null,
        },
      });
      this.client = client;
      if (!this.state.conversationId) {
        const prefs = await client.request<{ lastConversationId: string | null }>(
          "/v1/preferences",
        );
        if (epoch !== this.epoch || this.disposed) return;
        this.update({ conversationId: prefs.lastConversationId });
      }
      const socket = new WebSocket(`${client.base.replace("http:", "ws:")}/v1/ws`, {
        headers: { Authorization: `Bearer ${instance.token}` },
        handshakeTimeout: 4000,
        maxPayload: 0,
      });
      this.socket = socket;
      this.timer = setTimeout(() => this.failed(new Error("WS hello timeout"), epoch), 5000);
      let busy = false;
      let dirty = false;
      let hello = false;
      const refresh = async () => {
        dirty = true;
        if (busy || !hello) return;
        busy = true;
        try {
          while (dirty && epoch === this.epoch && !this.disposed) {
            dirty = false;
            const metadataRevision = this.metadataRevision;
            const snapshot = await client.request<Snapshot>("/v1/snapshot");
            if (epoch !== this.epoch || this.disposed) return;
            const profiles =
              await client.request<{ id: string; name: string }[]>("/v1/harness-profiles");
            if (epoch !== this.epoch || this.disposed) return;
            if (metadataRevision !== this.metadataRevision) {
              dirty = true;
              continue;
            }
            this.update({
              snapshot,
              profiles: profiles.map(({ id, name }) => ({ id, name })),
              status: "connected",
              detail: `已连接 · ${distribution}`,
            });
            if (
              this.state.conversationId &&
              !snapshot.conversations.some((c) => c.id === this.state.conversationId)
            ) {
              this.selection++;
              this.update({
                conversationId: null,
                events: [],
                interaction: null,
                eventCursor: 0,
                historyLoading: false,
              });
            }
            await this.readHistory(client, epoch);
            const id = this.state.conversationId;
            if (id) {
              const [sessions, approvals, handoffs] = await Promise.all([
                client.request<NativeSession[]>(`/v1/conversations/${id}/sessions`),
                client.request<Approval[]>(`/v1/conversations/${id}/approvals`),
                client.request<Handoff[]>(`/v1/conversations/${id}/handoffs`),
              ]);
              if (epoch === this.epoch && id === this.state.conversationId && !this.disposed) {
                const interaction = { conversationId: id, sessions, approvals, handoffs };
                if (JSON.stringify(interaction) !== JSON.stringify(this.state.interaction))
                  this.update({ interaction });
              }
            }
          }
        } catch (error) {
          // A concurrent confirmed deletion can invalidate a history/session read.
          // Refresh the snapshot, rather than treating a missing entity as lost transport.
          if (error instanceof HttpError && error.status === 404) dirty = true;
          else this.failed(error, epoch);
        } finally {
          busy = false;
          if (dirty && epoch === this.epoch && !this.disposed) void refresh();
        }
      };
      this.refreshNow = refresh;
      let scheduled: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        if (!scheduled)
          scheduled = setTimeout(() => {
            scheduled = undefined;
            if (epoch === this.epoch && !this.disposed) void refresh();
          }, 40);
      };
      socket.on("message", (packet) => {
        if (epoch !== this.epoch || this.disposed) return;
        try {
          const message = JSON.parse(String(packet));
          if (message.type === "hello") {
            if (message.instanceId !== instance.instanceId)
              throw new BridgeError("IDENTITY", "WebSocket 实例身份不匹配。");
            hello = true;
            clearTimeout(this.timer);
            this.timer = undefined;
          }
          if (hello && ["hello", "change", "conversation.event"].includes(message.type)) schedule();
        } catch (error) {
          this.failed(error, epoch);
        }
      });
      socket.on("error", (error) => this.failed(error, epoch));
      socket.on("close", () => this.failed(new Error("Disconnected"), epoch));
      this.poll = setInterval(() => {
        if (hello) void refresh();
      }, 3000);
    } catch (error) {
      this.failed(error, epoch);
    }
  }
  private failed(error: unknown, epoch: number) {
    if (epoch !== this.epoch || this.disposed) return;
    ++this.epoch; // Invalidate pending HTTP reads and socket callbacks before scheduling recovery.
    this.clearTransport();
    const terminal = error instanceof BridgeError && error.code !== "NETWORK";
    this.update({
      status:
        error instanceof BridgeError && error.code === "INCOMPATIBLE"
          ? "incompatible"
          : terminal
            ? "error"
            : "disconnected",
      historyLoading: false,
      backend: error instanceof BridgeError ? error.diagnostics : (this.state.backend ?? null),
      detail:
        error instanceof BridgeError
          ? error.message
          : "连接断开，正在重新发现 WSL 实例。若持续失败，请检查 WSL2 localhost forwarding、VPN/防火墙及端口冲突；不会开放网络监听端口。",
    });
    if (!terminal)
      this.timer = setTimeout(() => {
        if (this.state.distribution) void this.connect(this.state.distribution);
      }, this.retryMs);
  }
  private readHistory(client: Client, epoch: number): Promise<void> {
    const selected = this.selection;
    const next = this.historyRead
      .catch(() => {})
      .then(async () => {
        if (epoch === this.epoch && selected === this.selection && !this.disposed)
          await this.doReadHistory(client, epoch);
      });
    this.historyRead = next;
    return next;
  }
  private async doReadHistory(client: Client, epoch: number) {
    const id = this.state.conversationId;
    if (!id) return;
    const selected = this.selection;
    const valid = () => epoch === this.epoch && selected === this.selection && !this.disposed;
    let cursor = this.state.eventCursor ?? 0;
    this.update({ historyLoading: true });
    while (valid()) {
      const page: { events: ConversationEvent[]; cursor: number } = await client.request<{
        events: ConversationEvent[];
        cursor: number;
      }>(`/v1/conversations/${id}/events?after_seq=${cursor}&limit=200`);
      if (!valid()) return;
      if (page.cursor < cursor) {
        cursor = 0;
        this.update({
          events: [],
          eventCursor: 0,
          historyVersion: (this.state.historyVersion ?? 0) + 1,
        });
        continue;
      }
      const batch: ConversationEvent[] = [];
      for (const event of page.events) {
        if (event.seq <= cursor) continue;
        if (event.conversationId !== id || event.seq !== cursor + 1)
          throw new BridgeError("IDENTITY", "会话事件序列不连续；已停止读取，请重连后检查历史。");
        cursor = event.seq;
        batch.push(event);
      }
      if (batch.length) {
        const tail = [...this.state.events, ...batch].slice(-200);
        this.update({ events: batch, eventCursor: cursor });
        this.state = { ...this.state, events: tail };
      }
      if (cursor >= page.cursor) break;
      if (!batch.length) throw new BridgeError("IDENTITY", "会话历史不完整；未跳过事件。");
    }
    if (valid()) this.update({ historyLoading: false });
  }
  async select(id: string) {
    const client = this.client;
    if (
      !client ||
      this.state.status !== "connected" ||
      !this.state.snapshot?.conversations.some((c) => c.id === id)
    )
      throw new Error("请先连接并选择已有会话。");
    if (id === this.state.conversationId) return;
    this.selection++;
    const epoch = this.epoch;
    this.update({
      conversationId: id,
      events: [],
      interaction: null,
      eventCursor: 0,
      historyVersion: (this.state.historyVersion ?? 0) + 1,
      historyLoading: true,
    });
    try {
      // Selecting a conversation never starts a native session or Turn.
      const write = this.preferenceWrite
        .catch(() => {})
        .then(() => {
          if (epoch === this.epoch && id === this.state.conversationId && !this.disposed)
            return client.request("/v1/preferences", "PATCH", { lastConversationId: id });
        });
      this.preferenceWrite = write;
      await write;
      if (epoch === this.epoch && id === this.state.conversationId) await this.refreshNow?.();
    } catch (error) {
      if (epoch !== this.epoch || id !== this.state.conversationId || this.disposed) return;
      if (error instanceof HttpError && error.status === 404)
        this.update({
          conversationId: null,
          events: [],
          interaction: null,
          eventCursor: 0,
          historyLoading: false,
        });
      else this.failed(error, epoch);
    }
  }
  async action(request: DesktopRequest): Promise<unknown> {
    const client = this.client;
    if (!client || this.state.status !== "connected" || this.disposed)
      throw new Error("Daemon 未连接；未重发任务。");
    if (["changes.list", "changes.diff", "project.branches"].includes(request.type)) {
      const epoch = this.epoch;
      const key = `${epoch}:${JSON.stringify(request)}`;
      const existing = this.gitReads.get(key);
      if (existing) return existing;
      if (this.gitReads.size >= 4) throw new Error("Git 查询繁忙，请稍后刷新。");
      const read = performAction(client, request)
        .then((result) => {
          if (epoch !== this.epoch || this.disposed)
            throw new Error("连接已变化，请刷新 Changes。");
          return result;
        })
        .finally(() => this.gitReads.delete(key));
      this.gitReads.set(key, read);
      return read;
    }
    if (request.type === "turn.submit") {
      const key = `${this.epoch}:${request.conversationId}`;
      if (this.submissions.has(key)) throw new Error("此会话正在提交，请等待或查询请求状态。");
      const promise = performAction(client, request);
      this.submissions.set(key, promise);
      try {
        return await promise;
      } finally {
        this.submissions.delete(key);
        void this.refreshNow?.();
      }
    }
    const epoch = this.epoch;
    const result = await performAction(client, request);
    if (epoch !== this.epoch || this.disposed)
      throw new Error("连接已变化；操作结果请查询，不会重发。");
    if (request.type.startsWith("conversation.") || request.type === "harness.select") {
      this.metadataRevision++;
      const snapshot = await client.request<Snapshot>("/v1/snapshot");
      if (epoch === this.epoch && !this.disposed) this.update({ snapshot });
    }
    if (
      ![
        "history",
        "draft.load",
        "draft.save",
        "new-draft.load",
        "new-draft.save",
        "request.lookup",
        "changes.list",
        "changes.diff",
        "worktrees.list",
        "workspace.open",
      ].includes(request.type)
    )
      await this.refreshNow?.();
    return result;
  }
  dispose() {
    this.disposed = true;
    ++this.epoch;
    this.clearTransport();
  }
}

export { performAction } from "./actions";
