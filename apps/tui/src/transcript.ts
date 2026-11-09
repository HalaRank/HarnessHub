import type { ConversationEvent } from "@harnesshub/shared";
import { type Accessor, batch, createSignal, type Setter } from "solid-js";

export type NativeTool = {
  toolCallId: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
};
export type TerminalContent = { output: string; info: unknown; exit: unknown };
export type RowData = {
  kind: "text" | "tool" | "plan" | "notice" | "handoff";
  label: string;
  text: string;
  tool: NativeTool | null;
  waiting: boolean;
  streaming: boolean;
  terminals: Record<string, TerminalContent>;
  handoff?: { error: string | null; incomplete: boolean; fallbackAvailable: boolean };
};
export type TranscriptRow = {
  id: string;
  group: string;
  sources: ConversationEvent[];
  value: Accessor<RowData>;
  update: Setter<RowData>;
};

import { object, pretty, projectEvent, visibleText } from "@harnesshub/shared/event-projection";

export type { EventCategory, EventProjection } from "@harnesshub/shared/event-projection";
export { chatVisible, object, pretty, projectEvent } from "@harnesshub/shared/event-projection";

// Stable row identities and per-row signals: a streaming chunk updates its row, not the history.
// Display segments are bounded; source events remain intact and linked by seq/id.
export class Transcript {
  readonly rows: TranscriptRow[] = [];
  readonly events: ConversationEvent[] = [];
  readonly tools = new Map<string, TranscriptRow>();
  private handoffs = new Map<string, TranscriptRow>();
  private approvals = new Map<string, TranscriptRow>();
  private tail: TranscriptRow | undefined;
  private seen = 0;
  private group = "";
  private conversationId = "";
  private readonly sizeSignal = createSignal(0);
  readonly size = this.sizeSignal[0];
  private readonly eventSignal = createSignal(0);
  readonly eventCount = this.eventSignal[0];
  append(events: ConversationEvent[]) {
    batch(() => {
      for (const event of events) {
        if (this.conversationId && event.conversationId !== this.conversationId)
          throw new Error("Conversation event mismatch");
        this.conversationId = event.conversationId;
        if (event.seq <= this.seen) continue;
        if (event.seq !== this.seen + 1) throw new Error("Non-contiguous native event sequence");
        this.seen = event.seq;
        this.events.push(event);
        this.add(event);
      }
      this.sizeSignal[1](this.rows.length);
      this.eventSignal[1](this.events.length);
    });
  }
  private row(event: ConversationEvent, value: RowData, group = event.id) {
    const [read, update] = createSignal(value);
    const row = {
      id: `${event.id}:${this.rows.length}`,
      group,
      sources: [event],
      value: read,
      update,
    };
    this.rows.push(row);
    return row;
  }
  private tool(event: ConversationEvent, payload: Record<string, unknown>) {
    const key = `${event.nativeSessionId}:${payload.toolCallId}`;
    let row = this.tools.get(key);
    if (!row) {
      row = this.row(event, {
        kind: "tool",
        label: "",
        text: "",
        tool: { toolCallId: String(payload.toolCallId) },
        waiting: false,
        streaming: false,
        terminals: {},
      });
      this.tools.set(key, row);
    } else row.sources.push(event);
    row.update((v) => {
      const terminals = { ...v.terminals };
      const meta = object(payload._meta);
      for (const key of ["terminal_info", "terminal_output_delta", "terminal_exit"]) {
        const value = object(meta[key]);
        if (typeof value.terminal_id !== "string") continue;
        const previous = terminals[value.terminal_id] ?? { output: "", info: null, exit: null };
        terminals[value.terminal_id] = {
          ...previous,
          ...(key === "terminal_info" ? { info: value } : {}),
          ...(key === "terminal_exit" ? { exit: value } : {}),
          ...(key === "terminal_output_delta" && typeof value.data === "string"
            ? { output: previous.output + value.data }
            : {}),
        };
      }
      return { ...v, terminals, tool: { ...v.tool, ...payload } as NativeTool };
    });
    return row;
  }
  private add(event: ConversationEvent) {
    const p = object(event.payload);
    // Completion must settle streaming even when it has no chat row.
    if (
      ["runtime.turn_finished", "runtime.interrupted", "runtime.worker_lost"].includes(event.kind)
    ) {
      this.tail?.update((v) => ({ ...v, streaming: false }));
      this.tail = undefined;
      this.group = "";
    }
    if (event.kind.startsWith("approval.") && event.kind !== "approval.requested") {
      const row = this.approvals.get(String(p.approvalId));
      if (row) {
        row.sources.push(event);
        row.update((v) => ({ ...v, waiting: false }));
      }
      this.approvals.delete(String(p.approvalId));
    }
    const projection = projectEvent(event);
    if (
      projection.category === "INTERNAL_DIAGNOSTIC" ||
      (projection.category === "UNKNOWN_EXTENSION" && !projection.text)
    )
      return;
    if (event.kind === "handoff.record") {
      const legacySourceEnded =
        p.error === "Report generation or target preparation failed; inspect source evidence" &&
        !p.internalTurnId &&
        !p.targetNativeSessionId &&
        this.events.some(
          (e) =>
            e.kind === "runtime.context_ended" && e.nativeSessionId === p.sourceNativeSessionId,
        );
      const value: RowData = {
        kind: "handoff",
        label: `Handoff · ${p.sourceHarness} → ${p.targetHarness} · ${p.status}${p.degraded ? " · Context may be incomplete" : ""}`,
        text: typeof p.reportText === "string" ? p.reportText : "",
        handoff: {
          error: legacySourceEnded
            ? "Source native session has ended. Review saved context and confirm degraded continuation, or cancel the switch."
            : typeof p.error === "string"
              ? p.error
              : null,
          incomplete: p.degraded === true || p.status === "FAILED" || p.status === "UNCERTAIN",
          fallbackAvailable: typeof p.fallbackText === "string" && !!p.fallbackText,
        },
        tool: null,
        waiting: p.status === "FAILED",
        streaming: false,
        terminals: {},
      };
      const existing = this.handoffs.get(String(p.id));
      if (existing) {
        existing.sources.push(event);
        existing.update(value);
      } else this.handoffs.set(String(p.id), this.row(event, value));
      return;
    }
    const chunk = ["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(
      event.kind,
    );
    if (event.kind === "user.message" || (chunk && typeof object(p.content).text === "string")) {
      const text =
        event.kind === "user.message" ? String(p.text ?? "") : String(object(p.content).text);
      const lane = `${event.nativeSessionId}:${event.turnId}:${event.kind}`;
      if (lane !== this.group || !this.tail) {
        this.tail?.update((v) => ({ ...v, streaming: false }));
        this.group = lane;
        this.tail = undefined;
      }
      // Split only the display, preserving every code unit and the complete message for copying.
      for (let offset = 0; offset < text.length || (text.length === 0 && offset === 0); ) {
        let end = Math.min(offset + 16000, text.length);
        const high = (value: number) => value >= 0xd800 && value <= 0xdbff;
        const low = (value: number) => value >= 0xdc00 && value <= 0xdfff;
        if (high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end++;
        let part = text.slice(offset, end);
        offset = end;
        if (
          this.tail &&
          this.tail.value().text.length + part.length > 16000 &&
          high(this.tail.value().text.charCodeAt(this.tail.value().text.length - 1)) &&
          low(part.charCodeAt(0))
        ) {
          const tail = this.tail;
          if (tail.sources.at(-1)?.id !== event.id) tail.sources.push(event);
          tail.update((v) => ({ ...v, text: v.text + part[0] }));
          part = part.slice(1);
          if (!part.length) break;
        }
        if (!this.tail || this.tail.value().text.length + part.length > 16000) {
          this.tail = this.row(
            event,
            {
              kind: "text",
              label:
                event.kind === "user.message" || event.kind === "user_message_chunk"
                  ? "You"
                  : event.kind === "agent_thought_chunk"
                    ? "Public thinking"
                    : "Agent",
              text: part,
              tool: null,
              waiting: false,
              streaming: chunk,
              terminals: {},
            },
            this.tail?.group ?? event.id,
          );
        } else {
          if (this.tail.sources.at(-1)?.id !== event.id) this.tail.sources.push(event);
          this.tail.update((v) => ({ ...v, text: v.text + part, streaming: chunk }));
        }
        if (!text.length) break;
      }
      return;
    }
    this.tail?.update((v) => ({ ...v, streaming: false }));
    this.tail = undefined;
    this.group = "";
    if (
      ["tool_call", "tool_call_update"].includes(event.kind) &&
      typeof p.toolCallId === "string"
    ) {
      this.tool(event, p);
      return;
    }
    if (event.kind === "approval.requested") {
      const tool = object(object(p.request).toolCall);
      if (typeof tool.toolCallId === "string") {
        const row = this.tool(event, tool);
        row.update((v) => ({ ...v, waiting: true }));
        this.approvals.set(String(p.id), row);
      }
    }
    this.row(event, {
      kind: event.kind === "plan" ? "plan" : "notice",
      label: projection.label ?? (event.kind === "plan" ? "Plan" : event.kind),
      text:
        projection.text ??
        (event.kind === "plan"
          ? pretty(event.payload)
          : (visibleText(p) ??
            `Agent sent ${String(object(p.content).type ?? "non-text")} content. Open Source to inspect the event.`)),
      tool: null,
      waiting: false,
      streaming: false,
      terminals: {},
    });
  }
  source(row: TranscriptRow) {
    if (row.value().kind === "handoff") {
      const latest = object(row.sources.at(-1)?.payload);
      return [latest.reportText, latest.fallbackText]
        .filter((text): text is string => typeof text === "string" && !!text)
        .join("\n\n");
    }
    if (row.value().kind === "text")
      return this.rows
        .filter((r) => r.group === row.group)
        .map((r) => r.value().text)
        .join("");
    const tool = row.value().tool;
    return tool ? pretty(tool) : row.value().text;
  }
}
export function toolExpanded(manual: boolean | undefined) {
  return manual ?? false;
}
export type ViewState = {
  manual: Record<string, boolean>;
  selected: number;
  start: number | null;
  scrollTop: number;
  following: boolean;
};
export function newViewState(): ViewState {
  return { manual: {}, selected: 0, start: null, scrollTop: 0, following: true };
}
