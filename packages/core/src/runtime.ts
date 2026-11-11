import { createHash, randomUUID } from "node:crypto";
import type {
  ContentBlock,
  InitializeResponse,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import {
  AcpTimeoutError,
  builtinProfiles,
  executable,
  type WireMessage,
  Worker,
} from "@harnesshub/acp";
import {
  AppError,
  type ChangeEvent,
  type ConversationEvent,
  type HarnessProfile,
  type ImageAttachment,
  imageAttachments,
  type NativeCommands,
  nativeCommandList,
  type RuntimeStatus,
  sensitiveEnvKeys,
  type settingInput,
  type turnInput,
} from "@harnesshub/shared";
import { RuntimeStore, type Store } from "@harnesshub/storage";
import type { z } from "zod";
import { Handoffs } from "./handoff";
import { projectRoot } from "./index";
import { PendingInputs } from "./pending-inputs";

export type Live = {
  id: string;
  conversationId: string;
  harnessId: string;
  worker?: Worker;
  initialize?: InitializeResponse;
  session?: NewSessionResponse;
  turnId: string | null;
  configuring: boolean;
  settingsOperation?: { timedOut: boolean };
  commands?: NativeCommands;
};
type Pending = { live: Live; resolve: (result: RequestPermissionResponse) => void };
export class Runtime {
  readonly data: RuntimeStore;
  readonly handoffs: Handoffs;
  readonly inputs: PendingInputs;
  readonly epoch = randomUUID();
  readonly live = new Map<string, Live>();
  readonly pending = new Map<string, Pending>();
  closing = false;
  readonly deleting = new Set<string>();
  private readonly recovering = new Set<string>();
  private readonly operations = new Map<Promise<unknown>, string>();
  private track<T>(id: string, operation: Promise<T>): Promise<T> {
    this.operations.set(operation, id);
    const settled = () => this.operations.delete(operation);
    void operation.then(settled, settled);
    return operation;
  }
  assertAvailable(id: string) {
    if (this.deleting.has(id)) throw new AppError(409, "Conversation deletion is in progress");
    if (this.recovering.has(id)) throw new AppError(409, "Conversation recovery is in progress");
    this.store.assertWorkspaceAvailable(this.store.getConversation(id).workspacePath);
  }
  private assertDeletable(id: string) {
    this.assertAvailable(id);
    this.store.assertConversationDeletable(id);
    if (this.inputs.list(id).some((input) => ["SENDING", "UNCERTAIN"].includes(input.state)))
      throw new AppError(409, "Inspect pending input delivery before deleting Conversation");
    if (
      [...this.handoffs.operations].some((h) => this.handoffs.data.get(h).conversationId === id) ||
      [...this.handoffs.sources.values()].some((l) => l.conversationId === id)
    )
      throw new AppError(409, "Wait for Handoff Worker cleanup before deleting Conversation");
    const live = this.live.get(id);
    if (live && (!live.session || live.configuring))
      throw new AppError(409, "Wait for session operation to finish");
  }
  async deleteConversation(id: string) {
    if (this.closing) throw new AppError(503, "Runtime is stopping");
    this.assertAvailable(id);
    this.deleting.add(id);
    try {
      this.inputs.hold(id, "Conversation deletion requested");
      for (const turn of this.data.active(id)) this.track(id, this.cancel(turn.id));
      const busy = () =>
        [...this.operations.values()].includes(id) ||
        this.inputs.isProcessing(id) ||
        [...this.handoffs.operations].some((h) => this.handoffs.data.get(h).conversationId === id);
      // Give native cancellation a chance to finish before the confirmed deletion
      // closes the owned Workers. Keep the DB until every async writer has settled.
      const cancelDeadline = Date.now() + 1500;
      while (busy() && Date.now() < cancelDeadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      const workers = new Set([
        ...[...this.live.values()].filter((live) => live.conversationId === id),
        ...[...this.handoffs.sources.values()].filter((live) => live.conversationId === id),
      ]);
      for (const live of workers) {
        // A native setting RPC is invalidated by closing its transport. Other
        // close operations retain their lock until their bounded cleanup ends.
        const deadline = Date.now() + 10000;
        while (live.configuring && !live.settingsOperation && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        if (live.settingsOperation) {
          delete live.settingsOperation;
          live.configuring = false;
        }
        this.expire(live, "CANCELLED");
        await this.disposeLive(live, true);
      }
      const deadline = Date.now() + 25000;
      while (busy() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (busy()) throw new AppError(409, "Conversation cleanup is still settling; retry deletion");
      for (const [key, live] of this.handoffs.sources)
        if (live.conversationId === id) this.handoffs.sources.delete(key);
      return this.store.deleteConversation(id, true);
    } finally {
      this.deleting.delete(id);
    }
  }
  async deleteProject(id: string) {
    if (this.closing) throw new AppError(503, "Runtime is stopping");
    this.store.getProject(id);
    if (this.store.projectOperations.has(id))
      throw new AppError(409, "Project has a pending operation; wait for it to finish");
    const conversations = this.store.listConversations(id);
    // Check every child before closing any Worker. Reserve all children and the
    // Project across cooperative shutdown so other clients cannot start work or
    // create a Conversation that would be silently included in the cascade.
    for (const c of conversations) this.assertDeletable(c.id);
    this.store.projectOperations.add(id);
    for (const c of conversations) this.deleting.add(c.id);
    try {
      for (const c of conversations) await this.closeSession(c.id, false);
      // No await between releasing the reservation and the atomic DB cascade.
      this.store.projectOperations.delete(id);
      return this.store.deleteProject(id);
    } finally {
      this.store.projectOperations.delete(id);
      for (const c of conversations) this.deleting.delete(c.id);
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
    this.inputs = new PendingInputs(this);
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
    this.metadata(this.data.status(id, this.inputs?.uncertain(id) ? "UNCERTAIN" : status));
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
              availableCommands?: unknown;
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
      if (
        update?.sessionUpdate === "available_commands_update" &&
        typeof params?.sessionId === "string" &&
        (!live.session || live.session.sessionId === params.sessionId)
      ) {
        const parsed = nativeCommandList.safeParse(update.availableCommands);
        if (parsed.success) {
          live.commands = { agentSessionId: params.sessionId, availableCommands: parsed.data };
          this.capabilities(live);
        }
      }
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
      commands: live.commands,
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
    if (
      this.inputs
        .list(conversationId)
        .some(
          (i) =>
            i.state === "UNCERTAIN" ||
            (i.state === "SENDING" &&
              !this.data.active(conversationId).some((t) => t.requestId === i.requestId)),
        )
    )
      throw new AppError(409, "Input delivery is unresolved");
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
  createLive(
    conversationId: string,
    harnessId: string,
    activate: boolean,
    handoffId?: string,
  ): Promise<Live> {
    this.assertAvailable(conversationId);
    return this.track(
      conversationId,
      this.prepareLive(conversationId, harnessId, activate, handoffId),
    );
  }
  private async prepareLive(
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
    if (handoffId) {
      this.handoffs.data.patch(handoffId, { targetNativeSessionId: live.id });
      this.handoffs.sources.set(live.id, live);
    }
    try {
      const worker = new Worker(this.profile(harnessId), cwd, {
        wire: (direction, message) => this.wire(live, direction, message),
        permission: (request, id, signal) => this.permission(live, request, id, signal),
        lost: () => this.lost(live),
        exited: () => this.workerExited(live),
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
      if (exited) this.handoffs.sources.delete(live.id);
      if (!exited && !activate) this.handoffs.sources.set(live.id, live);
      throw error;
    }
  }
  submit(conversationId: string, input: z.infer<typeof turnInput>, fromQueue = false) {
    if (input.delivery)
      throw new AppError(400, "Use the conversation inputs endpoint for follow-ups");
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
    if (this.inputs.uncertain(conversationId))
      throw new AppError(
        409,
        "Previous input delivery is UNCERTAIN; inspect history before continuing",
      );
    const reservedInput = this.data.inputs().find((item) => item.requestId === input.requestId);
    if (
      reservedInput &&
      (!fromQueue ||
        reservedInput.conversationId !== conversationId ||
        reservedInput.state !== "SENDING")
    )
      throw new AppError(409, "requestId belongs to an existing queued input");
    if (
      this.inputs
        .list(conversationId)
        .some(
          (item) =>
            item.state === "SENDING" && item.requestId !== (fromQueue ? input.requestId : null),
        )
    )
      throw new AppError(409, "Wait for pending input delivery before starting a new Turn");
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
    if (input.images?.length && current && !switching)
      this.prompt(current, input.message, input.images);
    if (input.nativeCommand) {
      const command = input.nativeCommand;
      if (
        switching ||
        !current ||
        current.id !== command.nativeSessionId ||
        current.id !== sourceId ||
        current.harnessId !== input.harnessId ||
        (conversation.selectedHarnessId !== null &&
          conversation.selectedHarnessId !== input.harnessId) ||
        current.worker?.closed ||
        !current.session ||
        this.data.session(current.id).status !== "READY" ||
        current.commands?.agentSessionId !== current.session.sessionId ||
        !current.commands.availableCommands.some((c) => c.name === command.name) ||
        input.message.split(/\s/, 1)[0] !== `/${command.name}`
      )
        throw new AppError(
          409,
          "ACP command is no longer available in the current NativeSession; inspect and send again explicitly",
        );
    }
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
      {
        text: input.message,
        ...(input.images?.length ? { images: input.images } : {}),
        requestId: input.requestId,
        ...(input.nativeCommand ? { nativeCommand: input.nativeCommand } : {}),
      },
      null,
      "client",
      turn.id,
    );
    this.data.updateTurn(turn.id, { startEventSeq: event.seq });
    const titleEvent = this.store.nameConversationFromMessage(conversationId, input.message);
    if (titleEvent) this.metadata(titleEvent);
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
    } else
      void this.track(
        conversationId,
        this.run(turn.id, input.message, !!input.nativeCommand, input.images),
      );
    return this.data.turn(turn.id);
  }
  imagesForTurn(turnId: string): ImageAttachment[] {
    const turn = this.data.turn(turnId);
    if (!turn.startEventSeq) return [];
    const event = this.data.events(turn.conversationId, turn.startEventSeq - 1, 1)[0];
    const payload = event?.payload as { images?: unknown } | undefined;
    return imageAttachments.parse(payload?.images ?? []);
  }
  prompt(live: Live, message: string, images: ImageAttachment[] = []): ContentBlock[] {
    if (images.length && live.initialize?.agentCapabilities?.promptCapabilities?.image !== true)
      throw new AppError(409, "当前 Agent 未声明 ACP 图片输入能力，请选择支持图片的 Harness。");
    return [
      ...(message ? [{ type: "text" as const, text: message }] : []),
      ...images.map((image) => ({
        type: "image" as const,
        mimeType: image.mimeType,
        data: image.data,
      })),
    ];
  }
  async run(
    turnId: string,
    message: string,
    nativeCommand = false,
    images: ImageAttachment[] = [],
  ) {
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
      const prompt = this.prompt(live, message, images);
      submitted = true;
      const response = await live.worker?.agent.request("session/prompt", {
        sessionId: live.session?.sessionId ?? "",
        prompt,
      });
      if (!response) throw new Error("Worker unavailable");
      if (this.data.turn(turnId).endedAt !== null) return;
      // The SDK wire tap commits every preceding update synchronously before this response settles.
      if (nativeCommand) {
        const observable = this.data.hasObservableOutput(turnId);
        this.event(live, live.conversationId, "runtime.command_result", {
          stopReason: response.stopReason,
          observable,
          message: observable
            ? `ACP command response: ${response.stopReason}`
            : `ACP returned ${response.stopReason} without observable command output; execution effect is not confirmed. Inspect Raw Events.`,
        });
      }
      this.finish(
        live,
        response.stopReason === "cancelled" ? "CANCELLED" : "COMPLETED",
        response.stopReason,
      );
    } catch (error) {
      if (this.data.turn(turnId).endedAt !== null) return;
      if (!submitted && error instanceof AppError)
        this.event(
          live ?? null,
          turn.conversationId,
          "runtime.input_error",
          { message: error.message },
          null,
          "runtime",
          turnId,
        );
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
        this.inputs.hold(
          turn.conversationId,
          "Preparation failed; use /queue to resume explicitly",
        );
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
    if (state === "COMPLETED") void this.inputs.drain(live.conversationId);
    else
      this.inputs.hold(
        live.conversationId,
        "Previous turn did not complete normally; use /queue to resume explicitly",
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
    else if (
      !live.turnId &&
      this.live.get(live.conversationId) === live &&
      this.store.getConversation(live.conversationId).runtimeStatus !== "UNCERTAIN"
    )
      this.status(live.conversationId, "INTERRUPTED");
    this.event(live, live.conversationId, "runtime.worker_lost", { state: "INTERRUPTED" });
    // Retain the handle until child exit is confirmed; a lost stream is not proof of process exit.
  }
  private workerExited(live: Live) {
    if (!live.worker?.exitedConfirmed) return;
    this.data.updateSession(live.id, { status: "INTERRUPTED", endedAt: Date.now() });
    this.event(live, live.conversationId, "runtime.worker_exited", {
      message:
        "Native context ended; Worker process group exit confirmed. Continue only with a new native context.",
      nativeSessionRecovered: false,
    });
    // Retain the ended Live until an explicit recovery, Handoff or close operation.
    // In particular, exit does not resolve an UNCERTAIN Turn or input delivery.
  }
  async recoverSession(
    conversationId: string,
    nativeSessionId: string,
    options: {
      acknowledgeUncertain?: true | undefined;
      externalWorkerStopped?: true | undefined;
    } = {},
  ) {
    if (options.acknowledgeUncertain)
      return this.track(
        conversationId,
        this.continueSession(
          conversationId,
          nativeSessionId,
          options.externalWorkerStopped === true,
        ),
      );
    this.assertAvailable(conversationId);
    const conversation = this.store.getConversation(conversationId);
    const live = this.live.get(conversationId);
    const old = this.data.session(nativeSessionId);
    if (
      this.closing ||
      conversation.activeNativeSessionId !== nativeSessionId ||
      old.conversationId !== conversationId ||
      old.status !== "INTERRUPTED" ||
      !old.endedAt ||
      this.data.sessionHasUncertainTurn(old.id) ||
      conversation.runtimeStatus === "UNCERTAIN" ||
      this.data.active(conversationId).length ||
      this.data.pending(conversationId).length ||
      live?.configuring ||
      this.inputs.list(conversationId).some((i) => ["SENDING", "UNCERTAIN"].includes(i.state)) ||
      this.inputs.isProcessing(conversationId) ||
      this.handoffs.data.open(conversationId) ||
      (conversation.selectedHarnessId && conversation.selectedHarnessId !== old.harnessId) ||
      (live && (live.id !== old.id || !live.worker?.exitedConfirmed)) ||
      !this.data.workerExitConfirmed(old.id)
    )
      throw new AppError(
        409,
        "Cannot safely start a new native context: exit is unconfirmed or an operation is unresolved",
      );
    this.live.delete(conversationId);
    const next = await this.createLive(conversationId, old.harnessId, true);
    this.event(next, conversationId, "runtime.context_restarted", {
      previousNativeSessionId: old.id,
      message:
        "User explicitly continued with a new native context. Original history is preserved; old native context was not restored.",
    });
    this.status(conversationId, "IDLE");
    return this.data.session(next.id);
  }
  private async continueSession(
    conversationId: string,
    nativeSessionId: string,
    externalWorkerStopped: boolean,
  ) {
    this.assertAvailable(conversationId);
    const conversation = this.store.getConversation(conversationId);
    const old = this.data.session(nativeSessionId);
    const live = this.live.get(conversationId);
    if (
      this.closing ||
      conversation.activeNativeSessionId !== old.id ||
      old.conversationId !== conversationId ||
      !["UNCERTAIN", "INTERRUPTED"].includes(conversation.runtimeStatus) ||
      this.data.active(conversationId).length ||
      this.data.pending(conversationId).length ||
      live?.configuring ||
      (live && live.id !== old.id) ||
      this.inputs.isProcessing(conversationId) ||
      this.inputs.list(conversationId).some((i) => i.state === "SENDING") ||
      this.handoffs.data.open(conversationId) ||
      (conversation.selectedHarnessId && conversation.selectedHarnessId !== old.harnessId)
    )
      throw new AppError(
        409,
        "Wait for outstanding operations and resolve the Harness switch before continuing",
      );
    // A previous Daemon's PID is insufficient evidence to terminate its processes.
    // The user must check those tasks externally when no owned handle remains.
    if (!live && !this.data.workerExitConfirmed(old.id) && !externalWorkerStopped)
      throw new AppError(409, "Confirm external Worker tasks have stopped before continuing");
    this.recovering.add(conversationId);
    try {
      if (live) await this.closeSession(conversationId, true);
      if (this.closing) throw new AppError(503, "Runtime is stopping");
      this.store.db.transaction(() => {
        this.inputs.hold(conversationId, "Context restarted; explicitly resume saved messages");
        this.inputs.acknowledge(conversationId);
        this.event(null, conversationId, "runtime.uncertainty_acknowledged", {
          previousNativeSessionId: old.id,
          externalWorkerStopped,
          workerExitConfirmed: this.data.workerExitConfirmed(old.id),
          message:
            "User checked the workspace and acknowledged the previous unknown outcome. Original requests remain recorded and will not be replayed.",
        });
        this.status(conversationId, "INTERRUPTED");
      });
      // createLive synchronously reserves the new Live before its first await.
      this.recovering.delete(conversationId);
      const next = await this.createLive(conversationId, old.harnessId, true);
      this.event(next, conversationId, "runtime.context_restarted", {
        previousNativeSessionId: old.id,
        nativeSessionRecovered: false,
        message:
          "User continued with a new native context. Original history is preserved; saved messages await explicit submission.",
      });
      this.status(conversationId, "IDLE");
      return this.data.session(next.id);
    } finally {
      this.recovering.delete(conversationId);
    }
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
    this.inputs.hold(turn.conversationId, "Interrupted by user; use /queue to resume explicitly");
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
    if (this.inputs.list(conversationId).some((item) => item.state === "SENDING"))
      throw new AppError(409, "Wait for pending input delivery before changing session options");
    const live = this.live.get(conversationId);
    if (!live?.session || !live.worker || live.worker.closed)
      throw new AppError(409, "Create a live session first");
    if (this.data.active(conversationId).length || live.configuring)
      throw new AppError(409, "Wait for the active operation to finish");
    const worker = live.worker,
      session = live.session;
    live.configuring = true;
    const operation = { timedOut: false };
    live.settingsOperation = operation;
    this.data.updateSession(live.id, { status: "CONFIGURING" });
    this.status(conversationId, "PREPARING");
    const apply = async () => {
      try {
        if (input.kind === "mode") {
          if (!session.modes?.availableModes.some((m) => m.id === input.modeId))
            throw new AppError(400, "Mode not advertised by Agent");
          await worker.agent.request("session/set_mode", {
            sessionId: session.sessionId,
            modeId: input.modeId,
          });
          if (live.settingsOperation !== operation || worker.closed)
            throw new AppError(409, "Native session ended during configuration");
          session.modes.currentModeId = input.modeId;
        } else {
          const option = session.configOptions?.find((o) => o.id === input.configId);
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
            sessionId: session.sessionId,
            configId: input.configId,
            ...(typeof input.value === "boolean"
              ? { type: "boolean" as const, value: input.value }
              : { value: input.value }),
          };
          const response = await worker.agent.request<SetSessionConfigOptionResponse>(
            "session/set_config_option",
            request,
          );
          if (live.settingsOperation !== operation || worker.closed)
            throw new AppError(409, "Native session ended during configuration");
          session.configOptions = response.configOptions;
        }
        return this.capabilities(live);
      } finally {
        // Only the original RPC settling releases this lock. A caller timeout does
        // not cancel it. A confirmed stop invalidates this operation's ownership.
        if (live.settingsOperation === operation) {
          delete live.settingsOperation;
          live.configuring = false;
          if (!worker.closed) {
            this.data.updateSession(live.id, { status: "READY" });
            this.event(live, conversationId, "runtime.settings_settled", {
              message:
                "Native configuration request settled; refreshed session options are available.",
            });
            this.status(conversationId, "IDLE");
          }
        }
      }
    };
    try {
      return await worker.bounded(this.track(conversationId, apply()));
    } catch (error) {
      if (error instanceof AcpTimeoutError && live.settingsOperation === operation) {
        operation.timedOut = true;
        this.event(live, conversationId, "runtime.settings_pending", {
          message:
            "Native setting result is unknown; wait for the response or explicitly confirm force stop of this session. New Turns are blocked.",
        });
      }
      throw error;
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
    if (force && live.settingsOperation?.timedOut) {
      delete live.settingsOperation;
      live.configuring = false;
    }
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
      const conversation = this.store.getConversation(live.conversationId);
      if (conversation.activeNativeSessionId === live.id) {
        this.event(live, live.conversationId, "runtime.context_ended", {
          message:
            "Native context ended. The next message starts a new native session without the previous native context.",
          nativeSessionRecovered: false,
        });
        if (conversation.runtimeStatus !== "UNCERTAIN")
          this.status(live.conversationId, "INTERRUPTED");
      }
      if (this.live.get(live.conversationId) === live) this.live.delete(live.conversationId);
    } finally {
      live.configuring = false;
    }
  }

  upgradeReadiness() {
    const blockers: string[] = [];
    const conversations = this.store.listConversations();
    if (this.closing) blockers.push("Daemon is stopping");
    if (this.data.active().length) blockers.push("Active Turns");
    if (this.pending.size || conversations.some((c) => this.data.pending(c.id).length))
      blockers.push("Pending approvals");
    if (this.handoffs.operations.size || conversations.some((c) => this.handoffs.data.open(c.id)))
      blockers.push("Unresolved Handoff");
    if (
      conversations.some(
        (c) =>
          c.runtimeStatus === "UNCERTAIN" ||
          this.inputs.list(c.id).some((i) => ["SENDING", "UNCERTAIN"].includes(i.state)),
      )
    )
      blockers.push("Uncertain execution or input delivery");
    if ([...this.live.values()].some((l) => !l.session || l.configuring) || this.operations.size)
      blockers.push("Session operation in progress");
    if (
      this.deleting.size ||
      this.store.workspaceOperations.size ||
      this.store.projectOperations.size
    )
      blockers.push("Project, Worktree or Conversation operation in progress");
    return { safeToStop: blockers.length === 0, checkedAt: Date.now(), blockers };
  }
  async shutdown(cancelActive = false, forUpgrade = false) {
    if (this.closing) throw new AppError(409, "Runtime is already stopping");
    if (this.deleting.size)
      throw new AppError(409, "Wait for Conversation deletion before stopping Daemon");
    if (this.store.workspaceOperations.size || this.store.projectOperations.size)
      throw new AppError(409, "Wait for pending Git operations before stopping Daemon");
    if (this.data.active().length && !cancelActive)
      throw new AppError(
        409,
        "Active Turns prevent daemon stop; cancel them and wait, or use hhu daemon stop --cancel-active",
      );
    // Recheck synchronously before reserving shutdown: a read-only readiness response
    // is advisory and can become stale as another Desktop/TUI starts a Turn.
    const readiness = this.upgradeReadiness();
    if (forUpgrade && !readiness.safeToStop)
      throw new AppError(409, `Unsafe upgrade/stop: ${readiness.blockers.join(", ")}`);
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
