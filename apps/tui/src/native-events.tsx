import type { ConversationEvent } from "@harnesshub/shared";
import { useKeyboard } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";

type NativeTool = { toolCallId: string; title?: string; status?: string; [key: string]: unknown };
type Row =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: NativeTool }
  | { kind: "raw"; text: string };
export function NativeEvents(props: { events: ConversationEvent[]; disabled: boolean }) {
  const [manual, setManual] = createSignal<Record<string, boolean>>({});
  const [selectedTool, setSelectedTool] = createSignal(0);
  const rows = createMemo(() => {
    const result: Row[] = [],
      tools = new Map<string, NativeTool>();
    for (const event of props.events) {
      if (
        event.kind === "runtime.workspace_warning" ||
        event.kind === "runtime.interrupted" ||
        event.kind === "runtime.worker_lost" ||
        event.kind === "runtime.session_ready" ||
        event.kind === "runtime.session_error" ||
        event.kind === "runtime.turn_finished"
      ) {
        result.push({ kind: "raw", text: JSON.stringify(event.payload) });
        continue;
      }
      if (event.kind === "user.message") {
        result.push({ kind: "text", text: (event.payload as { text: string }).text });
        continue;
      }
      if (event.origin !== "agent") continue;
      if ((event.raw as { error?: unknown } | null)?.error) {
        result.push({ kind: "raw", text: JSON.stringify((event.raw as { error: unknown }).error) });
        continue;
      }
      const payload = event.payload as (NativeTool & { content?: { text?: string } }) | null;
      if (
        ["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(event.kind)
      ) {
        if (typeof payload?.content?.text === "string") {
          const previous = result.at(-1);
          if (previous?.kind === "text") previous.text += payload.content.text;
          else result.push({ kind: "text", text: payload.content.text });
        } else result.push({ kind: "raw", text: JSON.stringify(event.payload) });
      } else if (
        (event.kind === "tool_call" || event.kind === "tool_call_update") &&
        payload?.toolCallId
      ) {
        let tool = tools.get(payload.toolCallId);
        if (!tool) {
          tool = { toolCallId: payload.toolCallId };
          tools.set(tool.toolCallId, tool);
          result.push({ kind: "tool", tool });
        }
        Object.assign(tool, payload);
      } else if (["custom", "plan", "session/request_permission"].includes(event.kind))
        result.push({ kind: "raw", text: JSON.stringify(event.payload) });
    }
    return result;
  });
  const toggle = (tool: NativeTool) =>
    setManual((previous) => ({
      ...previous,
      [tool.toolCallId]: !(previous[tool.toolCallId] ?? tool.status !== "completed"),
    }));
  useKeyboard((key) => {
    if (props.disabled) return;
    const tools = rows().filter((row) => row.kind === "tool");
    if (key.name === "t") setSelectedTool((value) => (value + 1) % Math.max(1, tools.length));
    const row = tools[selectedTool() % Math.max(1, tools.length)];
    if (key.name === "e" && row?.kind === "tool") toggle(row.tool);
  });
  const selectedId = () => {
    const tools = rows().filter((row) => row.kind === "tool");
    const row = tools[selectedTool() % Math.max(1, tools.length)];
    return row?.kind === "tool" ? row.tool.toolCallId : null;
  };
  return (
    <Show
      when={rows().length}
      fallback={<text>No Agent output yet. Press m to send a message.</text>}
    >
      <For each={rows()}>
        {(row) =>
          row.kind === "tool" ? (
            <box
              flexDirection="column"
              flexShrink={0}
              border
              title={row.tool.title ?? row.tool.toolCallId}
            >
              <text>
                {selectedId() === row.tool.toolCallId ? "▶ " : ""}
                {row.tool.status ?? "pending"} · t select tool / e expand/collapse
              </text>
              <Show when={manual()[row.tool.toolCallId] ?? row.tool.status !== "completed"}>
                <text>{JSON.stringify(row.tool)}</text>
              </Show>
            </box>
          ) : (
            <text flexShrink={0}>{row.text}</text>
          )
        }
      </For>
    </Show>
  );
}
