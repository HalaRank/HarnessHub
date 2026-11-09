import { expect, test } from "bun:test";
import type { ConversationEvent } from "@harnesshub/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/renderer/App";
import { messages } from "../src/renderer/history";

const event = (
  kind: string,
  payload: unknown,
  seq: number,
  purpose?: ConversationEvent["purpose"],
): ConversationEvent => ({
  id: String(seq),
  conversationId: "conversation",
  nativeSessionId: "session",
  turnId: "turn",
  seq,
  raw: payload,
  kind,
  payload,
  origin: "agent",
  createdAt: 0,
  ...(purpose ? { purpose } : {}),
});
test("basic history preserves user/Agent text and concatenates chunks without diagnostics", () => {
  const rows = messages([
    event("initialize", { workerPid: 99, authStatus: "private" }, 1),
    event("user.message", { text: "你好\n**Markdown**" }, 2),
    event("agent_message_chunk", { content: { text: "Hello " } }, 3),
    event("agent_message_chunk", { content: { text: "world" } }, 4),
    event("agent_thought_chunk", { content: { text: "Thinking text" } }, 5),
    event("runtime.worker_started", { pid: 999 }, 6),
    event("agent_message_chunk", { content: { text: "Internal report" } }, 7, "handoff_internal"),
    event(
      "user_message_chunk",
      { content: { text: "Private handoff background" } },
      8,
      "handoff_delivery",
    ),
  ]);
  expect(rows.map((row) => row.text)).toEqual([
    "你好\n**Markdown**",
    "Hello world",
    "Thinking text",
  ]);
});
test("native tool titles and status retained, protocol body stays out of chat", () => {
  const rows = messages([
    event(
      "tool_call",
      {
        toolCallId: "t",
        title: "Read README",
        status: "in_progress",
        rawInput: { authStatus: "secret" },
      },
      1,
    ),
    event("tool_call_update", { toolCallId: "t", status: "completed" }, 2),
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ role: "Read README", text: "completed" });
  expect(rows[0]?.tool?.rawInput).toEqual({ authStatus: "secret" });
});
test("React renders safe layout with navigation, composer and empty states", () => {
  const html = renderToStaticMarkup(
    <App
      api={{ request: async () => ({ ok: false, error: "unused" }), subscribe: () => () => {} }}
    />,
  );
  expect(html).toContain("项目与会话");
  expect(html).toContain("会话列表");
  expect(html).toContain("切换工作面板");
  expect(html).toContain("新建会话");
  expect(html).toContain("继续你的项目");
  expect(html).not.toContain("dangerouslySetInnerHTML");
});
