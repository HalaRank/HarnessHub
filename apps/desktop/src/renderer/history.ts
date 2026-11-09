import type { ConversationEvent } from "@harnesshub/shared";
import { object, projectEvent } from "@harnesshub/shared/event-projection";
export type Message = {
  id: string;
  role: string;
  text: string;
  kind: "text" | "activity" | "notice";
  turn: string | null;
};
export function messages(events: ConversationEvent[]): Message[] {
  const rows: Message[] = [];
  for (const event of events) {
    const projection = projectEvent(event);
    if (projection.category === "INTERNAL_DIAGNOSTIC") continue;
    const p = object(event.payload);
    const chunk = ["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(
      event.kind,
    );
    const text =
      event.kind === "user.message" ? p.text : chunk ? object(p.content).text : projection.text;
    if (typeof text === "string" && text.length) {
      const role =
        event.kind === "user.message" || event.kind === "user_message_chunk"
          ? "You"
          : event.kind === "agent_thought_chunk"
            ? "Thinking"
            : event.kind === "agent_message_chunk"
              ? "Agent"
              : (projection.label ?? "Notice");
      const tail = rows.at(-1);
      if (chunk && tail?.role === role && tail.turn === event.turnId) tail.text += text;
      else
        rows.push({
          id: event.id,
          role,
          text,
          turn: event.turnId,
          kind:
            projection.category === "CHAT_CONTENT"
              ? "text"
              : projection.category === "AGENT_ACTIVITY"
                ? "activity"
                : "notice",
        });
    } else if (["tool_call", "tool_call_update"].includes(event.kind)) {
      const id = `tool:${event.nativeSessionId}:${String(p.toolCallId)}`;
      let row = rows.find((row) => row.id === id);
      if (!row) {
        row = { id, role: "Tool", text: "", kind: "activity", turn: event.turnId };
        rows.push(row);
      }
      if (typeof p.title === "string") row.role = p.title;
      if (typeof p.status === "string") row.text = p.status;
    } else if (event.kind === "plan") {
      const text = Array.isArray(p.entries)
        ? p.entries
            .map((entry) => {
              const e = object(entry);
              return typeof e.content === "string" ? e.content : "";
            })
            .filter(Boolean)
            .join("\n")
        : "";
      if (text)
        rows.push({ id: event.id, role: "Plan", text, kind: "activity", turn: event.turnId });
    } else if (event.kind === "handoff.record") {
      rows.push({
        id: event.id,
        role: "Handoff",
        text: typeof p.status === "string" ? p.status : "交接记录 · 原文见 Debug",
        kind: "notice",
        turn: event.turnId,
      });
    }
  }
  return rows;
}
