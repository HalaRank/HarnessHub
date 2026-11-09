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
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function pretty(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "null");
}

export type EventCategory =
  | "CHAT_CONTENT"
  | "AGENT_ACTIVITY"
  | "USER_ACTION_REQUIRED"
  | "USER_NOTICE"
  | "INTERNAL_DIAGNOSTIC"
  | "UNKNOWN_EXTENSION";
export type EventProjection = {
  category: EventCategory;
  label?: string;
  text?: string | undefined;
};

const contentEvents = new Set(["user.message", "user_message_chunk", "agent_message_chunk"]);
const activityEvents = new Set(["agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);
const metadataEvents = new Set([
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
]);
const metadataKeys = new Set([
  "authStatus",
  "authMethods",
  "authentication",
  "config",
  "configuration",
  "configOptions",
  "capabilities",
  "agentCapabilities",
  "clientCapabilities",
  "models",
  "modelId",
  "modelGateway",
  "gateway",
  "currentModelId",
  "availableModels",
]);

// Only explicit text fields are evidence of user-facing extension content. Labels, detail,
// arbitrary nested strings and JSON serialization are never a chat fallback.
function visibleText(payload: unknown): string | undefined {
  const p = object(payload),
    content = object(p.content);
  for (const value of [content.text, p.text, p.message])
    if (typeof value === "string" && value.trim()) return value;
  return undefined;
}
function errorText(error: unknown): string | undefined {
  if (typeof error === "string" && error.trim()) return error;
  const value = object(error);
  if (typeof value.message === "string") return value.message;
  if (value.code !== undefined) return `Error code: ${String(value.code)}`;
  return undefined;
}

// This projection is shared by live append and history replay. It never changes the event,
// the runtime state machine, or the complete source retained for Raw Events / Debug.
export function projectEvent(event: ConversationEvent): EventProjection {
  const p = object(event.payload),
    raw = object(event.raw);
  const diagnostic: EventProjection = { category: "INTERNAL_DIAGNOSTIC" };
  if (
    event.purpose === "handoff_internal" ||
    (event.purpose === "handoff_delivery" && event.kind === "user_message_chunk")
  )
    return diagnostic;
  if (contentEvents.has(event.kind)) return { category: "CHAT_CONTENT" };
  if (activityEvents.has(event.kind)) return { category: "AGENT_ACTIVITY" };
  if (event.kind === "approval.requested") {
    const request = object(p.request);
    const options = Array.isArray(request.options) ? request.options.map(object) : [];
    return {
      category: "USER_ACTION_REQUIRED",
      label: "Native permission · user decision required",
      text:
        options.map((option) => String(option.name ?? option.optionId)).join(" · ") ||
        "The Agent is waiting for your permission. Use /approval to review the native options.",
    };
  }
  if (event.kind === "handoff.record")
    return {
      category: p.status === "FAILED" ? "USER_ACTION_REQUIRED" : "USER_NOTICE",
    };
  const extension = String(p.sessionUpdate ?? raw.method ?? event.kind);
  const failureKind = /(?:^|[._/])(error|failed|failure|fatal)(?:$|[._/])/i;
  const error = errorText(raw.error) ?? errorText(p.error);
  if (
    (raw.error != null && raw.error !== false) ||
    (p.error != null && p.error !== false) ||
    ["error", "fatal"].includes(String(p.level ?? p.severity)) ||
    failureKind.test(event.kind) ||
    failureKind.test(extension)
  ) {
    return {
      category: "USER_NOTICE",
      label: `Error · ${event.kind}`,
      text:
        error ??
        visibleText(p) ??
        errorText(event.payload) ??
        errorText(p.reason) ??
        "Agent operation failed. Inspect the source events for details.",
    };
  }
  if (
    ["warn", "warning"].includes(String(p.level ?? p.severity)) ||
    [event.kind, extension].some((kind) => /(?:^|[._/])warn(?:ing)?(?:$|[._/])/i.test(kind))
  )
    return {
      category: "USER_NOTICE",
      label: `Warning · ${event.kind}`,
      text: visibleText(p) ?? "Agent reported a warning. Open Source to inspect the event.",
    };
  if (event.kind === "runtime.context_ended")
    return {
      category: "USER_NOTICE",
      label: "Native context ended",
      text:
        visibleText(p) ??
        "Native context ended. The next message starts a new native session without the previous native context.",
    };
  if (event.kind === "runtime.command_result" && p.observable === false)
    return {
      category: "USER_NOTICE",
      label: "ACP command response · effect unconfirmed",
      text: visibleText(p),
    };
  if (["runtime.interrupted", "runtime.worker_lost"].includes(event.kind))
    return {
      category: "USER_NOTICE",
      label: "Agent interrupted",
      text:
        visibleText(p) ??
        (p.state === "UNCERTAIN"
          ? `Execution result unknown (${String(p.reason ?? "worker connection lost")}). Inspect history and workspace; no task will be replayed.`
          : `Native session interrupted (${String(p.reason ?? "worker connection lost")}). The next message starts a new native session.`),
    };
  if (event.kind === "runtime.workspace_warning")
    return {
      category: "USER_NOTICE",
      label: "Workspace warning",
      text: visibleText(p),
    };
  if (
    event.kind === "runtime.turn_finished" &&
    ["ERROR", "UNCERTAIN", "CANCELLED"].includes(String(p.state))
  )
    return {
      category: "USER_NOTICE",
      label: `Turn ${String(p.state)}`,
      text:
        visibleText(p) ??
        `${String(p.stopReason ?? p.reason ?? p.state)}${p.state === "UNCERTAIN" ? ". Execution result unknown; no task will be replayed." : ""}`,
    };
  if (
    event.kind.startsWith("runtime.") ||
    event.kind.startsWith("approval.") ||
    event.kind.startsWith("handoff.") ||
    metadataEvents.has(event.kind) ||
    /^(initialize|initialized|authenticate|acp\.response)$/.test(event.kind) ||
    /^(session|fs|terminal)\//.test(event.kind) ||
    event.kind.startsWith("$/")
  )
    return diagnostic;

  // Runtime normalizes unrecognized Agent notifications to custom. Inspect their semantic
  // envelope as well as their kind, without exposing auth/config/capability metadata.
  if (
    Object.keys(p).some((key) => metadataKeys.has(key)) ||
    metadataEvents.has(extension) ||
    /auth|config|capabilit|model|gateway|usage/i.test(extension)
  )
    return diagnostic;
  return {
    category: "UNKNOWN_EXTENSION",
    label: `Agent notice · ${event.kind}`,
    text: visibleText(p),
  };
}
export function chatVisible(event: ConversationEvent) {
  const projection = projectEvent(event);
  return (
    projection.category !== "INTERNAL_DIAGNOSTIC" &&
    (projection.category !== "UNKNOWN_EXTENSION" || !!projection.text)
  );
}

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
