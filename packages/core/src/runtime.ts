import { createHash, randomUUID } from "node:crypto";
import type {
  InitializeResponse,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { builtinProfiles, executable, type WireMessage, Worker } from "@harnesshub/acp";
import {
  AppError,
  type ChangeEvent,
  type ConversationEvent,
  type HarnessProfile,
  type RuntimeStatus,
  sensitiveEnvKeys,
  type settingInput,
  type turnInput,
} from "@harnesshub/shared";
import { RuntimeStore, type Store } from "@harnesshub/storage";
import type { z } from "zod";
import { Handoffs } from "./handoff";
import { projectRoot } from "./index";

export type Live = {
  id: string;
  conversationId: string;
  harnessId: string;
  worker?: Worker;
  initialize?: InitializeResponse;
  session?: NewSessionResponse;
  turnId: string | null;
  configuring: boolean;
};
type Pending = { live: Live; resolve: (result: RequestPermissionResponse) => void };
export class Runtime {
  readonly data: RuntimeStore;
  readonly handoffs: Handoffs;
  readonly epoch = randomUUID();
  readonly live = new Map<string, Live>();
  readonly pending = new Map<string, Pending>();
  closing = false;
  readonly deleting = new Set<string>();
  assertAvailable(id: string) {
    if (this.deleting.has(id)) throw new AppError(409, "Conversation deletion is in progress");
    this.store.assertWorkspaceAvailable(this.store.getConversation(id).workspacePath);
  }
  async deleteConversation(id: string) {
    this.assertAvailable(id);
    this.store.assertConversationDeletable(id);
    if (
      [...this.handoffs.operations].some((h) => this.handoffs.data.get(h).conversationId === id) ||
      [...this.handoffs.sources.values()].some((l) => l.conversationId === id)
    )
      throw new AppError(409, "Wait for Handoff Worker cleanup before deleting Conversation");
    const live = this.live.get(id);
    if (live && (!live.session || live.configuring))
      throw new AppError(409, "Wait for session operation to finish");
    this.deleting.add(id);
    try {
      await this.closeSession(id, false);
      return this.store.deleteConversation(id);
    } finally {
      this.deleting.delete(id);
    }
  }
  constructor(
    readonly store: Store,
    readonly publish: (event: ConversationEvent) => void,
    readonly metadata: (event: ChangeEvent) => void,
  ) {
    this.data = new RuntimeStore(store);
    this.data.recover();
    this.handoffs = new Handoffs(this);
  }
  profiles() {
    return [
      ...builtinProfiles().filter((p) => !this.data.profiles().some((c) => c.id === p.id)),
      ...this.data.profiles(),
    ];
  }
  profile(id: string) {
    const profile = this.profiles().find((p) => p.id === id);
    if (!profile) throw new AppError(404, "Harness profile not found");
    return profile;
  }
  saveProfile(profile: HarnessProfile) {
    if (sensitiveEnvKeys(profile).length)
      throw new AppError(
        400,
        "Credential environment overrides cannot be stored in a Profile; inherit the native process environment instead",
      );
    if (
      [...this.live.values(), ...this.handoffs.sources.values()].some(
        (l) => l.harnessId === profile.id,
      )
    )
      throw new AppError(409, "Stop the profile's Workers before editing it");
    this.data.saveProfile(profile);
    return profile;
  }
  diagnostics() {
    return this.profiles().map((p) => ({
      id: p.id,
      name: p.name,
      command: p.command,
      args: p.args,
      executableAvailable: !!executable(p.command, { ...process.env, ...p.envOverrides }),
      // A process lookup is intentionally not reported as a successful ACP handshake.
      handshake: "not-run" as const,
      available: !!executable(p.command, { ...process.env, ...p.envOverrides }),
      capabilities: "Run an explicit session to negotiate; executable presence is not a handshake",
    }));
  }
  event(
    live: Live | null,
    conversationId: string,
    kind: string,
    payload: unknown,
    raw: unknown = null,
    origin: ConversationEvent["origin"] = "runtime",
    turnId: string | null = live?.turnId ?? null,
  ) {
    const event = this.data.append({
      conversationId,
      nativeSessionId: live?.id ?? null,
      turnId,
      kind,
      payload,
      raw,
      origin,
      purpose:
        live?.turnId && this.data.turn(live.turnId).origin === "handoff_internal"
          ? "handoff_internal"
          : kind === "user_message_chunk" &&
              this.handoffs.data.open(conversationId)?.userTurnId === turnId
            ? "handoff_delivery"
            : "user",
    });
    this.publish(event);
    return event;
  }
  status(id: string, status: RuntimeStatus) {
    this.metadata(this.data.status(id, status));
  }
  wire(live: Live, origin: "agent" | "client", raw: WireMessage) {
    let kind = typeof raw.method === "string" ? raw.method : "acp.response";
    let payload: unknown = raw.params ?? raw.result ?? raw.error ?? raw;
    if (origin === "agent" && raw.method === "session/update") {
      const params = raw.params as
        | {
            sessionId?: string;
            update?: {
              sessionUpdate?: string;
              configOptions?: SessionConfigOption[];
              currentModeId?: string;
            };
          }
        | undefined;
      const update = params?.update;
      const known = new Set([
        "agent_message_chunk",
        "user_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "plan",
        "available_commands_update",
        "current_mode_update",
        "config_option_update",
        "session_info_update",
        "usage_update",
      ]);
      kind =
        update?.sessionUpdate && known.has(update.sessionUpdate) ? update.sessionUpdate : "custom";
      payload = update ?? raw.params;
      if (live.session && update?.sessionUpdate === "config_option_update" && update.configOptions)
        live.session.configOptions = update.configOptions;
      if (
        live.session?.modes &&
        update?.sessionUpdate === "current_mode_update" &&
        update.currentModeId
      )
        live.session.modes.currentModeId = update.currentModeId;
      if (
        live.session &&
        (update?.sessionUpdate === "config_option_update" ||
          update?.sessionUpdate === "current_mode_update")
      )
        this.capabilities(live);
    } else if (origin === "agent" && raw.method && raw.method !== "session/request_permission")
      kind = "custom";
    const event = this.event(live, live.conversationId, kind, payload, raw, origin);
    if (kind === "tool_call" && event.purpose === "handoff_internal")
      this.event(null, live.conversationId, "handoff.report_tool_warning", {
        message:
          "Source used native tools during report generation. Inspect Changes and source events; degraded confirmation is required before target execution.",
        sourceNativeSessionId: live.id,
        sourceTurnId: live.turnId,
        sourceEventSeq: event.seq,
        tool: payload,
      });
  }
  capabilities(live: Live) {
    const snapshot = {
      initialize: live.initialize,
      session: live.session,
      client: { fs: false, terminal: false },
    };
    this.data.updateSession(live.id, { capabilities: snapshot });
    return snapshot;
  }
  async ensure(conversationId: string, harnessId: string): Promise<Live> {
    this.assertAvailable(conversationId);
    if (this.closing) throw new AppError(503, "Runtime is stopping");
    this.store.getConversation(conversationId);
    this.profile(harnessId);
    const existing = this.live.get(conversationId);
    if (existing) {
      if (existing.harnessId !== harnessId)
        throw new AppError(409, "Submit a message to perform Context Handoff");
      if (existing.worker?.closed || !existing.session)
        throw new AppError(409, "Native session is not usable");
      return existing;
    }
    const conversation = this.store.getConversation(conversationId);
    if (
      conversation.activeNativeSessionId &&
      this.data.session(conversation.activeNativeSessionId).harnessId !== harnessId
    )
      throw new AppError(409, "Submit a message to perform Context Handoff");
    if (this.handoffs.data.open(conversationId))
      throw new AppError(409, "Handoff operation in progress");
    return this.createLive(conversationId, harnessId, true);
  }
  async createLive(
    conversationId: string,
    harnessId: string,
    activate: boolean,
    handoffId?: string,
  ): Promise<Live> {
    const conversation = this.store.getConversation(conversationId);
    const cwd = projectRoot(conversation.workspacePath);
    const row = this.data.addSession(conversationId, harnessId, cwd, this.epoch);
    const live: Live = {
      id: row.id,
      conversationId,
      harnessId,
      turnId: activate
        ? (this.data.active(conversationId).find((t) => t.origin === "user")?.id ?? null)
        : null,
      configuring: false,
    };
    if (activate) this.live.set(conversationId, live);
    if (handoffId) this.handoffs.data.patch(handoffId, { targetNativeSessionId: live.id });
    try {
      const worker = new Worker(this.profile(harnessId), cwd, {
        wire: (direction, message) => this.wire(live, direction, message),
        permission: (request, id, signal) => this.permission(live, request, id, signal),
        lost: () => this.lost(live),
      });
      live.worker = worker;
      this.event(live, conversationId, "runtime.worker_started", {
        workerPid: worker.child.pid ?? null,
        processGroupId: worker.child.pid ?? null,
        epoch: this.epoch,
        harnessId,
        cwd,
      });
      live.initialize = await worker.initialize();
      this.capabilities(live);
      live.session = await worker.bounded(
        worker.agent.request("session/new", { cwd, mcpServers: [] }),
      );
      if (worker.closed) throw new AppError(503, "Worker disconnected during preparation");
      this.data.updateSession(live.id, { status: "READY", agentSessionId: live.session.sessionId });
      this.capabilities(live);
      if (activate)
        this.metadata(this.handoffs.data.bind(conversationId, { activeNativeSessionId: live.id }));
      this.event(live, conversationId, "runtime.session_ready", {
        cwd,
        harnessId,
        handoffId: handoffId ?? null,
      });
      return live;
    } catch (error) {
      let exited = !live.worker;
      if (live.worker) {
        try {
          await live.worker.stop();
          exited = true;
        } catch {
          /* Keep handle until explicit stop. */
        }
      }
      this.data.updateSession(live.id, { status: "ERROR", endedAt: exited ? Date.now() : null });
      this.event(live, conversationId, "runtime.session_error", {
        handoffId: handoffId ?? null,
        reason:
          error instanceof AppError
            ? error.message
            : "ACP preparation failed; inspect raw protocol events",
        stderrBytes: live.worker?.stderrBytes ?? 0,
        exitCode: live.worker?.child.exitCode ?? null,
        signal: live.worker?.child.signalCode ?? null,
      });
      if (exited && this.live.get(conversationId) === live) this.live.delete(conversationId);
      if (!exited && !activate) this.handoffs.sources.set(live.id, live);
      throw error;
    }
  }
  submit(conversationId: string, input: z.infer<typeof turnInput>) {
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ conversationId, ...input }))
      .digest("hex");
    const previous = this.data.byRequest(input.requestId);
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new AppError(409, "requestId already used for different content");
      this.store.consumeDraft(conversationId, input.requestId);
      return previous;
    }
    this.assertAvailable(conversationId);
    const conversation = this.store.getConversation(conversationId);
    if (this.closing) throw new AppError(503, "Runtime is stopping");
    if (conversation.runtimeStatus === "UNCERTAIN")
      throw new AppError(
        409,
        "Previous execution is UNCERTAIN; inspect history before explicitly starting a new Conversation",
      );
    if (this.data.active(conversationId).length || this.live.get(conversationId)?.configuring)
      throw new AppError(409, "Conversation already has an active operation");
    if (this.handoffs.data.open(conversationId))
      throw new AppError(409, "Resolve the existing Handoff first");
    const sourceId = conversation.activeNativeSessionId;
    const switching = !!sourceId && this.data.session(sourceId).harnessId !== input.harnessId;
    const current = this.live.get(conversationId);
    if (
      current &&
      (!current.session || current.worker?.closed) &&
      !(switching && current.worker?.closed && current.worker.exitedConfirmed)
    )
      throw new AppError(
        409,
        "Native session is not usable; inspect process state before continuing",
      );
    this.profile(input.harnessId);
    projectRoot(conversation.workspacePath);
    const turn = this.data.addTurn(conversationId, input.harnessId, input.requestId, requestHash);
    const live = this.live.get(conversationId) ?? null;
    if (live && !switching) live.turnId = turn.id;
    const event = this.event(
      switching ? null : live,
      conversationId,
      "user.message",
      { text: input.message, requestId: input.requestId },
      null,
      "client",
      turn.id,
    );
    this.data.updateTurn(turn.id, { startEventSeq: event.seq });
    this.store.consumeDraft(conversationId, input.requestId);
    if (
      this.data
        .active()
        .some(
          (t) =>
            t.conversationId !== conversationId &&
            this.store.getConversation(t.conversationId).workspacePath ===
              conversation.workspacePath,
        )
    ) {
      this.event(
        live,
        conversationId,
        "runtime.workspace_warning",
        {
          message:
            "Another Conversation is active in this shared workspace; concurrent edits can conflict",
          workspacePath: conversation.workspacePath,
        },
        null,
        "runtime",
        turn.id,
      );
    }
    this.status(conversationId, "PREPARING");
    this.metadata(this.handoffs.data.bind(conversationId, { selectedHarnessId: input.harnessId }));
    if (switching && sourceId) {
      const h = this.handoffs.reserve(turn.id, input.message, sourceId);
      this.handoffs.data.patch(h.id, { sourceEventEnd: event.seq - 1 });
      void this.handoffs.generate(h.id);
    } else void this.run(turn.id, input.message);
    return this.data.turn(turn.id);
  }
  async run(turnId: string, message: string) {
    const turn = this.data.turn(turnId);
    let live: Live | undefined;
    let submitted = false;
    try {
      live = await this.ensure(turn.conversationId, turn.harnessId);
      if (this.data.turn(turnId).endedAt !== null) return;
      live.turnId = turnId;
      this.data.updateTurn(turnId, { nativeSessionId: live.id });
      if (this.data.turn(turnId).state === "CANCELLING" || this.closing) {
        this.finish(live, "CANCELLED", "cancelled_before_prompt");
        return;
      }
      this.data.updateTurn(turnId, { state: "RUNNING" });
      this.status(turn.conversationId, "RUNNING");
      submitted = true;
      const response = await live.worker?.agent.request("session/prompt", {
        sessionId: live.session?.sessionId ?? "",
        prompt: [{ type: "text", text: message }],
      });
      if (!response) throw new Error("Worker unavailable");
      if (this.data.turn(turnId).endedAt !== null) return;
      // The SDK wire tap commits every preceding update synchronously before this response settles.
      this.finish(
        live,
        response.stopReason === "cancelled" ? "CANCELLED" : "COMPLETED",
        response.stopReason,
      );
    } catch {
      if (this.data.turn(turnId).endedAt !== null) return;
      const state = submitted ? "UNCERTAIN" : "ERROR";
      if (live)
        this.finish(live, state, submitted ? "prompt_result_unknown" : "preparation_failed");
      else {
        const orphan = this.event(
          null,
          turn.conversationId,
          "runtime.turn_finished",
          {
            turnId,
            state,
            reason: "preparation_failed",
          },
          null,
          "runtime",
          turnId,
        );
        this.data.updateTurn(turnId, { state, endedAt: Date.now(), finishEventSeq: orphan.seq });
        this.status(turn.conversationId, state);
        const handle = this.live.get(turn.conversationId);
        if (handle) handle.turnId = null;
      }
    }
  }
  finish(live: Live, state: string, stopReason: string) {
    if (!live.turnId) return;
    const turnId = live.turnId;
    this.expire(live, "CANCELLED");
    const event = this.event(live, live.conversationId, "runtime.turn_finished", {
      state,
      stopReason,
    });
    this.data.updateTurn(turnId, {
      state,
      stopReason,
      endedAt: Date.now(),
      finishEventSeq: event.seq,
    });
    live.turnId = null;
    this.status(
      live.conversationId,
      state === "UNCERTAIN" ? "UNCERTAIN" : state === "ERROR" ? "ERROR" : "IDLE",
    );
  }
  lost(live: Live) {
    this.data.updateSession(live.id, {
      status: "INTERRUPTED",
      endedAt: live.worker?.exitedConfirmed ? Date.now() : null,
    });
    this.expire(live, "EXPIRED");
    if (live.turnId && this.data.turn(live.turnId).state !== "PREPARING")
      this.finish(live, "UNCERTAIN", "worker_connection_lost");
    else if (!live.turnId && this.live.get(live.conversationId) === live)
      this.status(live.conversationId, "INTERRUPTED");
    this.event(live, live.conversationId, "runtime.worker_lost", { state: "INTERRUPTED" });
    // Retain the handle until child exit is confirmed; a lost stream is not proof of process exit.
  }
  permission(
    live: Live,
    request: RequestPermissionRequest,
    requestId: string,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (
      !live.turnId ||
      request.sessionId !== live.session?.sessionId ||
      this.data.turn(live.turnId).state === "CANCELLING" ||
      signal.aborted
    )
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const approval = this.data.addApproval(
      live.conversationId,
      live.id,
      live.turnId,
      requestId,
      request,
    );
    this.data.updateTurn(live.turnId, { state: "WAITING_APPROVAL" });
    this.status(live.conversationId, "WAITING_APPROVAL");
    return new Promise((resolve) => {
      const done = (response: RequestPermissionResponse) => {
        signal.removeEventListener("abort", aborted);
        resolve(response);
      };
      const aborted = () => {
        if (this.data.decide(approval.id, "CANCELLED")) {
          this.pending.delete(approval.id);
          this.event(live, live.conversationId, "approval.cancelled", { approvalId: approval.id });
          this.resumeAfterApproval(live);
          done({ outcome: { outcome: "cancelled" } });
        }
      };
      this.pending.set(approval.id, { live, resolve: done });
      signal.addEventListener("abort", aborted, { once: true });
      this.event(live, live.conversationId, "approval.requested", approval);
    });
  }
  resumeAfterApproval(live: Live) {
    if (!live.turnId) return;
    if (this.data.turn(live.turnId).state === "CANCELLING") return;
    const state = this.data.pending(live.conversationId).length ? "WAITING_APPROVAL" : "RUNNING";
    this.data.updateTurn(live.turnId, { state });
    this.status(live.conversationId, state);
  }
  decide(id: string, optionId: string) {
    const approval = this.data.approval(id);
    const pending = this.pending.get(id);
    if (!pending || approval.status !== "PENDING" || pending.live.worker?.closed)
      throw new AppError(409, "Approval is already decided or no longer live");
    const request = approval.request as RequestPermissionRequest;
    if (!request.options.some((o) => o.optionId === optionId))
      throw new AppError(400, "optionId must be one of the Agent's original options");
    const decided = this.data.decide(id, "DECIDED", optionId);
    if (!decided) throw new AppError(409, "Approval already decided");
    this.pending.delete(id);
    this.event(pending.live, approval.conversationId, "approval.decided", {
      approvalId: id,
      optionId,
    });
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    this.resumeAfterApproval(pending.live);
    return decided;
  }
  expire(live: Live, status: string) {
    for (const [id, pending] of this.pending)
      if (pending.live === live) {
        this.data.decide(id, status);
        this.pending.delete(id);
        this.event(live, live.conversationId, "approval.expired", { approvalId: id, status });
        pending.resolve({ outcome: { outcome: "cancelled" } });
      }
  }
  async cancel(turnId: string) {
    const turn = this.data.turn(turnId);
    if (turn.endedAt !== null || turn.state === "CANCELLING") return turn;
    this.data.updateTurn(turnId, { state: "CANCELLING" });
    this.status(turn.conversationId, "CANCELLING");
    const h = this.handoffs.data.open(turn.conversationId);
    if (h?.userTurnId === turnId && h.status === "FAILED") {
      // Daemon shutdown owns this cancellation even while new user actions are blocked.
      this.handoffs.cancelReserved(h);
      return this.data.turn(turnId);
    }
    const live = this.live.get(turn.conversationId);
    if (live) {
      if (h?.userTurnId === turnId && live.turnId && live.turnId !== turnId)
        this.data.updateTurn(live.turnId, { state: "CANCELLING" });
      this.event(live, turn.conversationId, "runtime.cancel_requested", { turnId });
      this.expire(live, "CANCELLED");
      if (live.session && live.worker)
        await live.worker.agent
          .notify("session/cancel", { sessionId: live.session.sessionId })
          .catch(() => {
            this.finish(live, "UNCERTAIN", "cancel_delivery_failed");
          });
    }
    return this.data.turn(turnId);
  }
  async settings(conversationId: string, input: z.infer<typeof settingInput>) {
    this.assertAvailable(conversationId);
    const live = this.live.get(conversationId);
    if (!live?.session || !live.worker || live.worker.closed)
      throw new AppError(409, "Create a live session first");
    if (this.data.active(conversationId).length || live.configuring)
      throw new AppError(409, "Wait for the active operation to finish");
    live.configuring = true;
    try {
      if (input.kind === "mode") {
        if (!live.session.modes?.availableModes.some((m) => m.id === input.modeId))
          throw new AppError(400, "Mode not advertised by Agent");
        await live.worker.bounded(
          live.worker.agent.request("session/set_mode", {
            sessionId: live.session.sessionId,
            modeId: input.modeId,
          }),
        );
        live.session.modes.currentModeId = input.modeId;
      } else {
        const option = live.session.configOptions?.find((o) => o.id === input.configId);
        if (!option) throw new AppError(400, "Config option not advertised by Agent");
        if (
          option.type === "boolean"
            ? typeof input.value !== "boolean"
            : typeof input.value !== "string" ||
              !option.options.some((entry) =>
                "group" in entry
                  ? entry.options.some((o) => o.value === input.value)
                  : entry.value === input.value,
              )
        )
          throw new AppError(400, "Value not advertised by Agent");
        const request = {
          sessionId: live.session.sessionId,
          configId: input.configId,
          ...(typeof input.value === "boolean"
            ? { type: "boolean" as const, value: input.value }
            : { value: input.value }),
        };
        const response = await live.worker.bounded(
          live.worker.agent.request<SetSessionConfigOptionResponse>(
            "session/set_config_option",
            request,
          ),
        );
        live.session.configOptions = response.configOptions;
      }
      return this.capabilities(live);
    } finally {
      live.configuring = false;
    }
  }
  async closeSession(conversationId: string, force: boolean) {
    const live = this.live.get(conversationId);
    if (!live) return;
    const unconfirmedWorker =
      this.store.getConversation(conversationId).runtimeStatus === "UNCERTAIN" &&
      live.worker &&
      !live.worker.exitedConfirmed;
    if ((this.data.active(conversationId).length || unconfirmedWorker) && !force)
      throw new AppError(
        409,
        "Active or UNCERTAIN Worker; use normal cancel and wait, or explicitly confirm force",
      );
    if (force && live.turnId) this.finish(live, "UNCERTAIN", "user_confirmed_force_stop");
    this.expire(live, "EXPIRED");
    if (live.configuring && !force)
      throw new AppError(409, "Session has an active configuration or stop operation");
    await this.disposeLive(live, force);
  }
  async disposeLive(live: Live, force = false) {
    if (live.configuring) throw new AppError(409, "Worker operation already in progress");
    live.configuring = true;
    live.worker?.beginStop();
    this.data.updateSession(live.id, { status: "CLOSING" });
    try {
      if (
        live.session &&
        live.worker &&
        !live.worker.closed &&
        live.initialize?.agentCapabilities?.sessionCapabilities?.close
      ) {
        try {
          await live.worker.bounded(
            live.worker.agent.request("session/close", { sessionId: live.session.sessionId }),
            2000,
          );
        } catch {
          /* Close is cooperative. Still close stdio and await the actual process exit. */
        }
      }
      await live.worker?.stop(force);
      this.data.updateSession(live.id, { status: "CLOSED", endedAt: Date.now() });
      if (this.live.get(live.conversationId) === live) this.live.delete(live.conversationId);
    } finally {
      live.configuring = false;
    }
  }

  async shutdown(cancelActive = false) {
    if (this.closing) throw new AppError(409, "Runtime is already stopping");
    if (this.store.workspaceOperations.size || this.store.projectOperations.size)
      throw new AppError(409, "Wait for pending Git operations before stopping Daemon");
    if (this.data.active().length && !cancelActive)
      throw new AppError(
        409,
        "Active Turns prevent daemon stop; cancel them and wait, or use hhu daemon stop --cancel-active",
      );
    this.closing = true;
    try {
      for (const turn of this.data.active()) await this.cancel(turn.id);
      const deadline = Date.now() + 5000;
      while (this.data.active().length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (this.data.active().length)
        throw new AppError(409, "Agent has not confirmed cancellation; Daemon remains running");
      const results = await Promise.allSettled(
        [...this.live.keys()].map((id) => this.closeSession(id, false)),
      );
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      for (const [id, source] of this.handoffs.sources) {
        await this.disposeLive(source);
        this.handoffs.sources.delete(id);
      }
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }
}
