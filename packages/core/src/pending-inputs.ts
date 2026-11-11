import { AppError, type PendingInput, type turnInput } from "@harnesshub/shared";
import type { z } from "zod";
import type { Live, Runtime } from "./runtime";

export function supportsSteering(live: Live | undefined) {
  const meta = live?.initialize?._meta;
  const steering = meta?.steering;
  return (
    typeof steering === "object" &&
    steering !== null &&
    "supported" in steering &&
    steering.supported === true
  );
}

// The event journal is the durable queue. Only this Daemon's explicit accept/resume
// and confirmed normal completion can dispatch it. Reopening a TUI only reads it.
export class PendingInputs {
  private readonly processing = new Set<string>();
  constructor(readonly runtime: Runtime) {
    for (const input of runtime.data.inputs()) {
      if (input.state === "SENDING") {
        const turn = runtime.data.byRequest(input.requestId);
        this.update(input, turn ? "SENT" : "UNCERTAIN", "daemon_restart", turn?.id);
      } else if (input.state === "UNCERTAIN") {
        runtime.status(input.conversationId, "UNCERTAIN");
      } else if (input.state === "QUEUED") {
        this.update(input, "HELD", "daemon_restart; use /queue to resume explicitly");
      }
    }
  }
  list(id: string) {
    return this.runtime.data.inputs(id);
  }
  isProcessing(id: string) {
    return this.processing.has(id);
  }
  uncertain(id: string) {
    return this.list(id).some((input) => input.state === "UNCERTAIN");
  }
  private update(
    input: PendingInput,
    state: PendingInput["state"],
    reason: string,
    turnId = input.turnId,
  ) {
    const next = { ...input, state, reason, turnId };
    this.runtime.event(
      null,
      input.conversationId,
      "runtime.input_updated",
      next,
      null,
      "runtime",
      turnId,
    );
    // Publish metadata too: snapshot subscribers must observe delivery independently
    // of the original Turn's lifecycle, including a timeout after COMPLETED.
    this.runtime.status(
      input.conversationId,
      state === "UNCERTAIN"
        ? "UNCERTAIN"
        : this.runtime.store.getConversation(input.conversationId).runtimeStatus,
    );
    return next;
  }
  accept(id: string, input: z.infer<typeof turnInput>) {
    if (input.images?.length) throw new AppError(400, "图片请在空闲会话中提交。");
    if (!input.delivery) throw new AppError(400, "Follow-up input requires a delivery mode");
    const runtime = this.runtime;
    const previous = runtime.data.inputs().find((item) => item.requestId === input.requestId);
    if (previous) {
      if (
        previous.conversationId !== id ||
        JSON.stringify(previous.input) !== JSON.stringify(input)
      )
        throw new AppError(409, "requestId already used for different content");
      runtime.store.consumeDraft(id, input.requestId);
      return previous;
    }
    if (runtime.data.byRequest(input.requestId))
      throw new AppError(409, "requestId already used for a Turn");
    runtime.assertAvailable(id);
    const conversation = runtime.store.getConversation(id);
    if (runtime.closing) throw new AppError(503, "Runtime is stopping");
    if (conversation.runtimeStatus === "UNCERTAIN" || this.uncertain(id))
      throw new AppError(
        409,
        "Previous input delivery is UNCERTAIN; inspect history before continuing",
      );
    const live = runtime.live.get(id);
    if (
      runtime.handoffs.data.open(id) ||
      live?.configuring ||
      (conversation.activeNativeSessionId &&
        runtime.data.session(conversation.activeNativeSessionId).harnessId !== input.harnessId) ||
      (conversation.selectedHarnessId && conversation.selectedHarnessId !== input.harnessId)
    )
      throw new AppError(
        409,
        "Resolve the Harness switch or session operation before sending follow-ups",
      );
    if (conversation.runtimeStatus === "CANCELLING")
      throw new AppError(409, "Wait for confirmed cancellation before sending");
    runtime.profile(input.harnessId);
    const record: PendingInput = {
      requestId: input.requestId,
      conversationId: id,
      input,
      state: "QUEUED",
      turnId: live?.turnId ?? null,
      reason:
        input.delivery === "steer" && !supportsSteering(live)
          ? "Native steering unavailable; queued for the next turn"
          : "Waiting for delivery",
    };
    runtime.store.db.transaction(() => {
      this.update(record, "QUEUED", record.reason);
      runtime.store.consumeDraft(id, input.requestId);
    });
    void this.drain(id);
    return this.list(id).find((item) => item.requestId === input.requestId) ?? record;
  }
  hold(id: string, reason: string) {
    for (const input of this.list(id))
      if (input.state === "QUEUED") this.update(input, "HELD", reason);
  }
  resume(id: string) {
    this.runtime.assertAvailable(id);
    if (
      this.runtime.closing ||
      this.uncertain(id) ||
      this.runtime.store.getConversation(id).runtimeStatus === "UNCERTAIN"
    )
      throw new AppError(409, "Cannot resume while stopping or delivery is UNCERTAIN");
    for (const input of this.list(id))
      if (input.state === "HELD") this.update(input, "QUEUED", "Explicitly resumed by user");
    void this.drain(id);
    return this.list(id);
  }
  remove(id: string, requestId: string) {
    const input = this.list(id).find((item) => item.requestId === requestId);
    if (!input) throw new AppError(404, "Queued input not found");
    if (!["QUEUED", "HELD", "ERROR"].includes(input.state))
      throw new AppError(409, "Input has already been dispatched; inspect its delivery state");
    return this.update(input, "CANCELLED", "Removed by user");
  }
  async drain(id: string) {
    if (
      this.processing.has(id) ||
      this.runtime.closing ||
      this.runtime.deleting.has(id) ||
      this.uncertain(id)
    )
      return;
    this.processing.add(id);
    try {
      for (;;) {
        const input = this.list(id).find((item) => item.state === "QUEUED");
        if (!input || this.runtime.closing || this.runtime.deleting.has(id) || this.uncertain(id))
          return;
        const runtime = this.runtime;
        const live = runtime.live.get(id);
        const active = runtime.data.active(id);
        const conversation = runtime.store.getConversation(id);
        if (
          conversation.selectedHarnessId &&
          conversation.selectedHarnessId !== input.input.harnessId
        ) {
          this.hold(id, "Harness selection changed; select the original Harness before resuming");
          return;
        }
        if (
          runtime.handoffs.data.open(id) ||
          live?.configuring ||
          ["CANCELLING", "UNCERTAIN"].includes(conversation.runtimeStatus)
        )
          return;
        const steer =
          input.input.delivery === "steer" &&
          !input.input.nativeCommand &&
          supportsSteering(live) &&
          live?.session &&
          live.worker &&
          active.length === 1 &&
          active[0]?.id === live.turnId &&
          ["RUNNING", "WAITING_APPROVAL"].includes(conversation.runtimeStatus);
        if (active.length && !steer) return;
        this.update(input, "SENDING", steer ? "Delivering native steering" : "Starting next turn");
        try {
          if (steer && live?.worker && live.session) {
            const result = (await live.worker.bounded(
              live.worker.agent.request("_session/steering", {
                sessionId: live.session.sessionId,
                prompt: [{ type: "text", text: input.input.message }],
                _meta: { steering: { idleBehavior: "promptRequired" } },
              }),
            )) as { outcome?: string };
            if (result.outcome === "promptRequired") {
              const interrupted =
                input.turnId &&
                runtime.data.turn(input.turnId).endedAt !== null &&
                runtime.data.turn(input.turnId).state !== "COMPLETED";
              this.update(
                input,
                interrupted ? "HELD" : "QUEUED",
                interrupted
                  ? "Previous turn interrupted; use /queue to resume explicitly"
                  : "Turn ended before steering; waiting for next turn",
              );
              if (interrupted) return;
              // Wait for the original prompt's confirmed completion before a new prompt.
              if (runtime.data.active(id).length) return;
              continue;
            }
            if (result.outcome !== "injected") {
              this.update(
                input,
                result.outcome === "failed" ? "ERROR" : "UNCERTAIN",
                "Native steering was not confirmed",
              );
              return;
            }
            runtime.event(
              null,
              id,
              "user.message",
              {
                text: input.input.message,
                requestId: input.requestId,
                delivery: "steer",
              },
              null,
              "client",
              input.turnId,
            );
            this.update(input, "SENT", "Injected into the current turn");
          } else {
            const { delivery: _, ...prompt } = input.input;
            const turn = runtime.submit(id, prompt, true);
            this.update(input, "SENT", "Sent as next turn", turn.id);
          }
        } catch (error) {
          // A transport error may follow successful delivery. Never replay it.
          this.update(
            input,
            error instanceof AppError && error.status < 500 ? "ERROR" : "UNCERTAIN",
            error instanceof AppError && error.status < 500
              ? error.message
              : "Input delivery result unknown; no automatic retry",
          );
          return;
        }
      }
    } finally {
      this.processing.delete(id);
    }
  }
}
