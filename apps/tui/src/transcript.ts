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
  kind: "text" | "tool" | "raw";
  label: string;
  text: string;
  tool: NativeTool | null;
  waiting: boolean;
  streaming: boolean;
  terminals: Record<string, TerminalContent>;
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

// Stable row identities and per-row signals: a streaming chunk updates its row, not the history.
// Display segments are bounded; source events remain intact and linked by seq/id.
export class Transcript {
  readonly rows: TranscriptRow[] = [];
  readonly events: ConversationEvent[] = [];
  readonly tools = new Map<string, TranscriptRow>();
  private approvals = new Map<string, TranscriptRow>();
  private tail: TranscriptRow | undefined;
  private seen = 0;
  private group = "";
  private conversationId = "";
  private readonly sizeSignal = createSignal(0);
  readonly size = this.sizeSignal[0];
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
    const chunk = ["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(
      event.kind,
    );
    if (event.kind === "runtime.turn_finished" || event.kind === "runtime.interrupted") {
      this.tail?.update((v) => ({ ...v, streaming: false }));
    }
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
    } else if (event.kind.startsWith("approval.")) {
      const row = this.approvals.get(String(p.approvalId));
      row?.update((v) => ({ ...v, waiting: false }));
      this.approvals.delete(String(p.approvalId));
    }
    // Every other event is reachable, including protocol responses and future extensions.
    this.row(event, {
      kind: "raw",
      label: event.kind,
      text: pretty(event.payload),
      tool: null,
      waiting: false,
      streaming: false,
      terminals: {},
    });
  }
  source(row: TranscriptRow) {
    if (row.value().kind === "text")
      return this.rows
        .filter((r) => r.group === row.group)
        .map((r) => r.value().text)
        .join("");
    const tool = row.value().tool;
    return tool ? pretty(tool) : row.value().text;
  }
}
export function toolExpanded(value: RowData, manual: boolean | undefined) {
  return manual ?? (value.waiting || value.tool?.status !== "completed");
}
export type ViewState = {
  manual: Record<string, boolean>;
  selected: number;
  page: number | null;
  scrollTop: number;
  following: boolean;
};
export function newViewState(): ViewState {
  return { manual: {}, selected: 0, page: null, scrollTop: 0, following: true };
}
