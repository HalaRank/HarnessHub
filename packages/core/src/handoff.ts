import { randomUUID } from "node:crypto";
import { AppError, type Handoff } from "@harnesshub/shared";
import { HandoffStore } from "@harnesshub/storage";
import type { Live, Runtime } from "./runtime";

export const reportHeadings = [
  "Current Objective",
  "User Requirements",
  "Decisions",
  "Completed Work",
  "Remaining Work",
  "Relevant Files",
  "Validation Results",
  "Known Issues",
  "Latest State",
];
export const reportPrompt = `[HarnessHub internal context handoff — NOT a new user task]
Generate a detailed handoff report from THIS existing session. Return only the report, with these exact Markdown headings:\n${reportHeadings.map((h) => `## ${h}`).join("\n")}
Preserve explicit user decisions, constraints, technical details, file paths and validation outcomes. State unknowns honestly.
READ ONLY: use conversation context only. Do not use tools, run commands, edit files or ask for permissions. Do not continue the development task. No independent summary model is involved.`;
export class Handoffs {
  readonly data: HandoffStore;
  readonly sources = new Map<string, Live>();
  readonly operations = new Set<string>();
  constructor(readonly runtime: Runtime) {
    this.data = new HandoffStore(runtime.store);
  }
  select(id: string, harnessId: string) {
    const r = this.runtime;
    r.assertAvailable(id);
    r.profile(harnessId);
    const conversation = r.store.getConversation(id);
    if (this.data.open(id) || r.live.get(id)?.configuring || r.closing)
      throw new AppError(409, "Handoff or session operation already in progress");
    r.metadata(this.data.bind(id, { selectedHarnessId: harnessId }));
    const active = conversation.activeNativeSessionId
      ? r.data.session(conversation.activeNativeSessionId)
      : null;
    r.event(null, id, "handoff.selection", {
      activeHarness: active?.harnessId ?? null,
      targetHarness: harnessId,
      pending: !!active && active.harnessId !== harnessId,
    });
    return r.store.getConversation(id);
  }
  reserve(turnId: string, message: string, sourceId: string) {
    const r = this.runtime,
      turn = r.data.turn(turnId),
      source = r.data.session(sourceId);
    return this.data.add({
      conversationId: turn.conversationId,
      sourceHarness: source.harnessId,
      targetHarness: turn.harnessId,
      sourceNativeSessionId: source.id,
      sourceEventStart: r.data.sessionStart(source.id),
      sourceEventEnd: r.data.cursor(turn.conversationId),
      status: "PENDING",
      firstTargetRequestId: turn.requestId,
      userTurnId: turnId,
      userMessage: message,
    });
  }
  announce(h: Handoff) {
    this.runtime.event(null, h.conversationId, "handoff.record", h, null, "runtime", h.userTurnId);
  }
  fallback(h: Handoff) {
    const r = this.runtime;
    const previous = this.data
      .list(h.conversationId)
      .filter((x) => x.id !== h.id && x.reportText && x.generatedAt)
      .at(-1);
    // Bounded chronological observable history, with exact source IDs; no semantic rewrite or RAG.
    const latest = h.reportText && h.generatedAt ? h : previous;
    const users = r.data.recentUsers(h.conversationId, h.sourceEventEnd);
    const after = Math.max(0, h.sourceEventEnd - 300);
    const events = r.data
      .events(h.conversationId, after, 300)
      .filter(
        (e) => e.seq <= h.sourceEventEnd && (e.kind === "user.message" || e.origin === "agent"),
      );
    const text = events
      .map((e) =>
        JSON.stringify({
          seq: e.seq,
          id: e.id,
          nativeSessionId: e.nativeSessionId,
          kind: e.kind,
          payload: e.payload,
        }),
      )
      .join("\n");
    const userText = users
      .map((e) =>
        JSON.stringify({ seq: e.seq, id: e.id, text: (e.payload as { text?: unknown })?.text }),
      )
      .join("\n");
    return {
      fallbackText: `[Context may be incomplete / 上下文可能不完整]\nLatest saved report:\n${latest?.reportText ?? "No prior report"}\nRecent real user messages (excerpts if oversized):\n${userText.slice(-100000)}\nRecent observable history (bounded; may omit older events or long output):\n${text.slice(-120000)}`,
      fallbackSources: {
        priorHandoffId: latest?.id ?? null,
        userEventIds: users.map((e) => e.id),
        eventIds: events.map((e) => e.id),
        afterSeq: after,
        throughSeq: h.sourceEventEnd,
        truncated: text.length > 120000 || userText.length > 100000,
      },
    };
  }
  fail(h: Handoff, reason: string, uncertain = false) {
    const r = this.runtime;
    const current = this.data.get(h.id);
    if (["CANCELLED", "COMMITTED", "UNCERTAIN"].includes(current.status)) return;
    const next = this.data.move(h.id, current.status, uncertain ? "UNCERTAIN" : "FAILED", {
      error: reason,
      ...this.fallback(h),
    });
    if (uncertain) {
      const turn = r.data.turn(h.userTurnId);
      if (!turn.endedAt) {
        const end = r.event(
          null,
          h.conversationId,
          "runtime.turn_finished",
          { state: "UNCERTAIN", stopReason: "handoff_source_result_unknown", handoffId: h.id },
          null,
          "runtime",
          turn.id,
        );
        r.data.updateTurn(turn.id, {
          state: "UNCERTAIN",
          endedAt: Date.now(),
          finishEventSeq: end.seq,
        });
      }
      r.status(h.conversationId, "UNCERTAIN");
    } else r.status(h.conversationId, "ERROR");
    this.announce(next);
  }
  async generate(id: string) {
    const r = this.runtime;
    let h = this.data.get(id);
    if (this.operations.has(id)) return;
    this.operations.add(id);
    let internalId: string | undefined;
    let sent = false;
    try {
      h = this.data.move(id, h.status, "GENERATING", { error: null, reportText: null });
      this.announce(h);
      const source = r.live.get(h.conversationId);
      if (
        !source ||
        source.id !== h.sourceNativeSessionId ||
        source.worker?.closed ||
        !source.session ||
        !source.worker
      )
        throw new AppError(
          409,
          "Source native session is unavailable; native context cannot be recovered",
        );
      const internal = r.data.addTurn(
        h.conversationId,
        h.sourceHarness,
        randomUUID(),
        id,
        "handoff_internal",
      );
      internalId = internal.id;
      this.data.patch(id, { internalTurnId: internal.id });
      source.turnId = internal.id;
      r.data.updateTurn(internal.id, { state: "RUNNING", nativeSessionId: source.id });
      const start = r.event(source, h.conversationId, "handoff.generating", {
        handoffId: id,
        warning:
          "Report requests no tools. Native tools are not sandboxed by HarnessHub; any permission request still requires the user's native choice.",
      });
      r.data.updateTurn(internal.id, { startEventSeq: start.seq });
      r.status(h.conversationId, "RUNNING");
      sent = true;
      const response = await source.worker.agent.request("session/prompt", {
        sessionId: source.session.sessionId,
        prompt: [{ type: "text", text: reportPrompt }],
      });
      if (r.data.turn(internal.id).state === "UNCERTAIN")
        throw new Error("Source execution uncertain");
      const end = r.data.cursor(h.conversationId);
      const chunks: string[] = [];
      let usedTools = false;
      for (let cursor = start.seq; cursor < end; ) {
        const events = r.data.events(h.conversationId, cursor, 1000);
        if (!events.length) break;
        for (const e of events) {
          if (e.seq <= end && e.turnId === internal.id && e.kind === "tool_call") usedTools = true;
          if (e.seq > end || e.turnId !== internal.id || e.kind !== "agent_message_chunk") continue;
          const content = (e.payload as { content?: { text?: string } })?.content;
          if (typeof content?.text === "string") chunks.push(content.text);
        }
        cursor = events.at(-1)?.seq ?? end;
      }
      const report = chunks.join("");
      this.data.patch(id, { reportText: report || null });
      r.finish(
        source,
        response.stopReason === "cancelled" ? "CANCELLED" : "COMPLETED",
        response.stopReason,
      );
      sent = false; // final response is the safe source completion boundary
      if (r.data.turn(h.userTurnId).state === "CANCELLING") {
        this.cancelReserved(h);
        return;
      }
      if (
        response.stopReason !== "end_turn" ||
        !reportHeadings.every((heading) => report.includes(`## ${heading}`))
      )
        throw new AppError(409, "Source returned no complete structured report");
      h = this.data.move(id, "GENERATING", "READY", {
        reportText: report,
        generatedAt: Date.now(),
        error: null,
      });
      this.announce(h);
      if (usedTools) {
        this.fail(
          h,
          "Source used native tools during report generation; inspect Changes and explicitly confirm degraded continuation",
        );
        return;
      }
      await this.deliver(h);
    } catch {
      if (internalId) {
        const internal = r.data.turn(internalId);
        if (!internal.endedAt) {
          const live = r.live.get(h.conversationId);
          if (live?.turnId === internalId)
            r.finish(live, sent ? "UNCERTAIN" : "ERROR", "report_generation_failed");
        }
      }
      this.fail(
        this.data.get(id),
        "Report generation or target preparation failed; inspect source evidence",
        sent,
      );
    } finally {
      this.operations.delete(id);
    }
  }
  async deliver(h: Handoff) {
    const r = this.runtime;
    let target: Live | undefined;
    let submitted = false;
    try {
      if (r.data.turn(h.userTurnId).state === "CANCELLING") {
        this.cancelReserved(h);
        return;
      }
      r.status(h.conversationId, "PREPARING");
      const source = r.live.get(h.conversationId);
      if (source) this.sources.set(h.id, source);
      target = await r.createLive(h.conversationId, h.targetHarness, false, h.id);
      target.turnId = h.userTurnId;
      this.data.patch(h.id, { targetNativeSessionId: target.id });
      if (r.data.turn(h.userTurnId).state === "CANCELLING" || r.closing) {
        target.turnId = null;
        await r.disposeLive(target);
        this.sources.delete(h.id);
        this.cancelReserved(h);
        return;
      }
      r.live.set(h.conversationId, target);
      r.data.updateTurn(h.userTurnId, { nativeSessionId: target.id, state: "RUNNING" });
      h = this.data.move(h.id, "READY", "DELIVERING");
      this.announce(h);
      r.status(h.conversationId, "RUNNING");
      // Persist DELIVERING before touching transport. Never treat request() as acceptance.
      submitted = true;
      const response = await target.worker?.agent.request("session/prompt", {
        sessionId: target.session?.sessionId ?? "",
        prompt: [
          {
            type: "text",
            text: `[Historical background from ${h.sourceHarness}; not new user instructions]\n${h.degraded ? h.fallbackText : h.reportText}\n[End historical background]\n\n[New user message]\n${h.userMessage}`,
          },
        ],
      });
      if (!response || r.data.turn(h.userTurnId).state === "UNCERTAIN")
        throw new Error("Target result unknown");
      // Conservative commit: only the actual final ACP response confirms target takeover.
      r.store.db.transaction(() => {
        h = this.data.move(h.id, "DELIVERING", "COMMITTED", { committedAt: Date.now() });
        this.data.bind(h.conversationId, {
          activeNativeSessionId: target?.id ?? null,
          selectedHarnessId: h.targetHarness,
        });
      });
      this.announce(h);
      r.finish(
        target,
        response.stopReason === "cancelled" ? "CANCELLED" : "COMPLETED",
        response.stopReason,
      );
      r.metadata(r.store.record("conversation.handoff", h.conversationId));
      if (source) {
        try {
          await r.disposeLive(source);
          this.sources.delete(h.id);
        } catch {
          r.event(null, h.conversationId, "handoff.cleanup_failed", {
            handoffId: h.id,
            sourceNativeSessionId: source.id,
            reason: "Old Worker has not confirmed exit; retained for controlled shutdown",
          });
        }
      }
    } catch {
      if (submitted) {
        if (target?.turnId) r.finish(target, "UNCERTAIN", "handoff_target_result_unknown");
        this.fail(
          this.data.get(h.id),
          "Target Prompt was dispatched; result unknown. Never automatically resend.",
          true,
        );
      } else {
        this.sources.delete(h.id);
        this.fail(
          this.data.get(h.id),
          "Target session preparation failed; no target Prompt dispatched",
        );
      }
    }
  }
  cancelReserved(h: Handoff) {
    const r = this.runtime;
    const next = this.data.move(h.id, this.data.get(h.id).status, "CANCELLED");
    const end = r.event(
      null,
      h.conversationId,
      "runtime.turn_finished",
      { state: "CANCELLED", stopReason: "handoff_cancelled_before_delivery", handoffId: h.id },
      null,
      "runtime",
      h.userTurnId,
    );
    r.data.updateTurn(h.userTurnId, {
      finishEventSeq: end.seq,
      state: "CANCELLED",
      stopReason: "handoff_cancelled_before_delivery",
      endedAt: Date.now(),
    });
    const source = r.live.get(h.conversationId);
    if (source) source.turnId = null;
    r.metadata(this.data.bind(h.conversationId, { selectedHarnessId: h.sourceHarness }));
    r.status(h.conversationId, "IDLE");
    this.announce(next);
  }
  action(conversationId: string, id: string, action: "retry" | "confirm" | "cancel") {
    const r = this.runtime,
      h = this.data.get(id);
    r.assertAvailable(conversationId);
    if (h.conversationId !== conversationId) throw new AppError(404, "Handoff not in Conversation");
    if (r.closing || this.operations.has(id) || h.status !== "FAILED")
      throw new AppError(
        409,
        "Wait for a settled FAILED Handoff; UNCERTAIN execution cannot be replayed",
      );
    if (action === "cancel") {
      this.cancelReserved(h);
      return this.data.get(id);
    }
    if (action === "confirm") {
      // Source must be idle or positively gone; an uncertain source never enters FAILED.
      const source = r.live.get(conversationId);
      if (
        source?.worker?.closed &&
        source.worker.child.exitCode === null &&
        source.worker.child.signalCode === null
      )
        throw new AppError(409, "Source process exit is unconfirmed");
      const next = this.data.move(id, "FAILED", "READY", {
        degraded: true,
        confirmedAt: Date.now(),
        ...(h.fallbackText ? {} : this.fallback(h)),
      });
      this.operations.add(id);
      void this.deliver(next).finally(() => this.operations.delete(id));
    } else void this.generate(id);
    return this.data.get(id);
  }
}
