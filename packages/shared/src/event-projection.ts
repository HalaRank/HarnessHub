import type { ConversationEvent } from "./runtime";

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
export function visibleText(payload: unknown): string | undefined {
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
