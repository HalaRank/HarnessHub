import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopApi } from "../src/contracts";
import { groupToolActivity, type Message } from "../src/renderer/history";
import { TranscriptView } from "../src/renderer/Message";

const api: DesktopApi = {
  subscribe: () => () => {},
  request: async () => {
    throw new Error("Rendering activity must not invoke the Agent");
  },
};
function tool(id: string, status = "completed"): Message {
  return {
    id,
    turn: "turn",
    session: "session",
    role: `Native command ${id}`,
    text: status,
    kind: "activity",
    tool: { title: `Native command ${id}`, kind: "execute", rawOutput: `Output ${id}` },
  };
}
const render = (rows: Message[], expanded = new Map<string, boolean>()) =>
  renderToStaticMarkup(<TranscriptView rows={rows} expanded={expanded} api={api} />);

test("adjacent tools group within one native turn without crossing messages, sessions or pages", () => {
  const a = tool("a");
  const b = tool("b");
  const message: Message = { id: "text", role: "Agent", text: "原文", kind: "text", turn: "turn" };
  const c = tool("c");
  const d = { ...tool("d"), turn: "next-turn" };
  const e = { ...tool("e"), turn: "next-turn", session: "next-session" };
  const rows = [a, b, message, c, d, e];
  const original = structuredClone(rows);
  const groups = groupToolActivity(rows);
  expect(groups).toEqual([
    { id: "activity:a", tools: [a, b] },
    message,
    { id: "activity:c", tools: [c] },
    { id: "activity:d", tools: [d] },
    { id: "activity:e", tools: [e] },
  ]);
  expect(rows).toEqual(original);
  expect(groupToolActivity(rows.slice(1, 2))).toEqual([{ id: "activity:b", tools: [b] }]);
  expect(groupToolActivity([])).toEqual([]);
});

test("completed activity collapses to one summary with no mounted outputs", () => {
  const html = render([tool("a"), tool("b")]);
  expect(html).toContain("已完成 2 项工具调用");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("Native command");
  expect(html).not.toContain("Output");
  expect(html).not.toContain('class="tool-heading"');
});

test("expanding a group shows original titles and keeps successful tool bodies folded", () => {
  const rows = [{ ...tool("a"), role: "pwd; rg --files | head -90\n原生换行标题" }, tool("b")];
  const html = render(rows, new Map([["activity:a", true]]));
  expect(html).toContain("pwd; rg --files | head -90\n原生换行标题");
  expect(html).toContain("Native command b");
  expect(html).toContain("已完成");
  expect(html).not.toContain("Output a");
  expect(html).not.toContain("Output b");
});

test("running, failed, pending and waiting tools reveal details by default", () => {
  for (const status of ["pending", "in_progress", "failed", "unknown-native-status", "__proto__"]) {
    const html = render([tool("a"), tool("b", status)]);
    expect(html).toContain("Output b");
    expect(html).not.toContain("Output a");
  }
  const waiting = render([{ ...tool("approval"), waiting: true }]);
  expect(waiting).toContain("1 项等待审批");
  expect(waiting).toContain("Output approval");
  const expired = render([{ ...tool("expired"), approvalExpired: true }]);
  expect(expired).toContain("1 项审批已过期");
  expect(expired).not.toContain("运行中");
  expect(render([tool("failure", "failed")])).toContain("1 项失败");
});

test("manual group and individual preferences survive streaming status changes", () => {
  const expanded = new Map<string, boolean>([["activity:a", true]]);
  expect(render([tool("a", "in_progress")], expanded)).toContain("Output a");
  expect(render([tool("a")], expanded)).toContain("Native command a");
  expanded.set("a", true);
  expect(render([tool("a")], expanded)).toContain("Output a");
  // A manually opened tool also keeps an otherwise automatic group open on completion.
  expanded.delete("activity:a");
  expect(render([tool("a")], expanded)).toContain("Output a");
  expanded.set("a", false);
  expect(render([tool("a", "failed")], expanded)).not.toContain("Output a");
  expanded.set("activity:a", false);
  const closed = render([tool("a", "failed")], expanded);
  expect(closed).not.toContain("Native command a");
  expect(closed).toContain("1 项失败");
  expect(render([tool("a"), tool("b")], expanded)).toContain("已完成 2 项工具调用");
});

test("unknown native titles remain inert and complete when expanded", () => {
  const row = {
    ...tool("unsafe"),
    role: '<img src=x onerror="alert(1)"> '.repeat(100),
    tool: { kind: "__proto__" },
  };
  const html = render([row], new Map([["activity:unsafe", true]]));
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("dangerouslySetInnerHTML");
});
