import type { ConversationEvent } from "@harnesshub/shared";
import { object, pretty, projectEvent } from "@harnesshub/shared/event-projection";
export type Message = {
  id: string;
  role: string;
  text: string;
  kind: "text" | "activity" | "notice";
  turn: string | null;
  session?: string | null;
  toolSources?: { content?: number; locations?: number };
  tool?: Record<string, unknown>;
  waiting?: boolean;
  approvalExpired?: boolean;
  handoff?: { report: string; incomplete: boolean; source: string; target: string };
};

export type TranscriptItem = Message | { id: string; tools: Message[] };

// Group only adjacent tools from the same native turn, within the mounted history page.
export function groupToolActivity(rows: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const row of rows) {
    const tail = items.at(-1);
    if (!row.tool) {
      items.push(row);
    } else if (
      tail &&
      "tools" in tail &&
      tail.tools[0]?.turn === row.turn &&
      tail.tools[0]?.session === row.session
    ) {
      tail.tools.push(row);
    } else {
      items.push({ id: `activity:${row.id}`, tools: [row] });
    }
  }
  return items;
}

// O(new events), stable row identities, O(1) native tool lookup. Raw events stay in SQLite.
export class DesktopTranscript {
  constructor(readonly identity = "") {}
  readonly rows: Message[] = [];
  cursor = 0;
  private tools = new Map<string, number>();
  private handoffs = new Map<string, number>();
  private approvals = new Map<string, string>();
  append(events: ConversationEvent[]) {
    for (const event of events) {
      if (event.seq <= this.cursor) continue;
      if (event.seq !== this.cursor + 1) throw new Error("聊天事件序号不连续");
      this.cursor = event.seq;
      this.add(event);
    }
  }
  private add(event: ConversationEvent) {
    const projection = projectEvent(event);
    const p = object(event.payload);
    if (event.kind.startsWith("approval.")) {
      const request = object(p.request);
      const tool = object(request.toolCall);
      if (event.kind === "approval.requested") {
        const key = `${event.nativeSessionId}:${event.turnId}:${String(tool.toolCallId)}`;
        this.approvals.set(String(p.id), key);
        this.mergeTool(event, tool, true);
      } else {
        const key = this.approvals.get(String(p.approvalId));
        const index = key ? this.tools.get(key) : undefined;
        this.approvals.delete(String(p.approvalId));
        if (index !== undefined && this.rows[index])
          this.rows[index] = {
            ...this.rows[index],
            waiting: [...this.approvals.values()].includes(key ?? ""),
            approvalExpired: event.kind === "approval.expired" && p.status === "EXPIRED",
          };
      }
    }
    if (projection.category === "INTERNAL_DIAGNOSTIC") return;
    if (["tool_call", "tool_call_update"].includes(event.kind)) {
      this.mergeTool(event, p);
      return;
    }
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
      const tail = this.rows.at(-1);
      if (
        chunk &&
        tail?.role === role &&
        tail.turn === event.turnId &&
        tail.session === event.nativeSessionId &&
        tail.text.length < 16000
      )
        this.rows[this.rows.length - 1] = { ...tail, text: tail.text + text };
      else
        this.rows.push({
          id: event.id,
          role,
          text,
          turn: event.turnId,
          session: event.nativeSessionId,
          kind:
            projection.category === "CHAT_CONTENT"
              ? "text"
              : projection.category === "AGENT_ACTIVITY"
                ? "activity"
                : "notice",
        });
    } else if (event.kind === "plan") {
      this.rows.push({
        id: event.id,
        role: "Plan",
        text: Array.isArray(p.entries)
          ? p.entries
              .map((entry) => {
                const e = object(entry);
                return `${String(e.status ?? "")} · ${String(e.content ?? "")}`;
              })
              .join("\n")
          : pretty(p),
        kind: "activity",
        turn: event.turnId,
      });
    } else if (event.kind === "handoff.record") {
      const key = String(p.id ?? event.id);
      const index = this.handoffs.get(key) ?? this.rows.length;
      this.rows[index] = {
        id: `handoff:${key}`,
        role: "Handoff",
        text: `${String(p.status)}${p.error ? ` · ${String(p.error)}` : ""}`,
        kind: "notice",
        turn: event.turnId,
        handoff: {
          report: typeof p.reportText === "string" ? p.reportText : "",
          incomplete: p.degraded === true || p.status === "FAILED",
          source: String(p.sourceHarness ?? ""),
          target: String(p.targetHarness ?? ""),
        },
      };
      this.handoffs.set(key, index);
    }
  }
  private mergeTool(event: ConversationEvent, patch: Record<string, unknown>, waiting?: boolean) {
    if (typeof patch.toolCallId !== "string") return;
    const key = `${event.nativeSessionId}:${event.turnId}:${patch.toolCallId}`;
    const index = this.tools.get(key) ?? this.rows.length;
    const previous = this.rows[index];
    const tool = { ...previous?.tool, ...patch };
    const meta = object(patch._meta);
    const delta = object(meta.terminal_output_delta);
    if (typeof delta.data === "string" || typeof delta.output === "string")
      tool.terminalOutput =
        String(previous?.tool?.terminalOutput ?? "") + String(delta.data ?? delta.output);
    this.rows[index] = {
      id: `tool:${key}`,
      role: String(tool.title ?? patch.toolCallId),
      text: String(tool.status ?? "pending"),
      kind: "activity",
      turn: event.turnId,
      session: event.nativeSessionId,
      tool,
      toolSources: {
        ...previous?.toolSources,
        ...(Array.isArray(patch.content) ? { content: event.seq } : {}),
        ...(Array.isArray(patch.locations) ? { locations: event.seq } : {}),
      },
      waiting: waiting ?? previous?.waiting ?? false,
      approvalExpired: waiting ? false : (previous?.approvalExpired ?? false),
    };
    this.tools.set(key, index);
  }
}
export function messages(events: ConversationEvent[]): Message[] {
  // Compatibility helper for fixtures which omit diagnostic sequence numbers.
  const transcript = new DesktopTranscript();
  transcript.append(events);
  return transcript.rows;
}
