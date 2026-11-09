import { expect, test } from "bun:test";
import type { ConversationEvent, Draft } from "@harnesshub/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { type DesktopApi, type DesktopState, desktopRequest } from "../src/contracts";
import { inputAction } from "../src/renderer/Composer";
import { DesktopDraft } from "../src/renderer/drafts";
import { DesktopTranscript } from "../src/renderer/history";
import { Markdown } from "../src/renderer/Markdown";
import { MessageView } from "../src/renderer/Message";

const id = "7ad657ec-2001-405b-801a-3d86b092f1b0";
const state: DesktopState = {
  revision: 0,
  status: "connected",
  detail: "",
  distribution: "test",
  snapshot: null,
  conversationId: id,
  events: [],
  historyLoading: false,
};
function editorBackend() {
  const drafts = new Map<string, Draft>();
  let submissions = 0;
  let loseAck = false;
  const requests = new Map<string, unknown>();
  const api: DesktopApi = {
    subscribe: () => () => {},
    request: async (request) => {
      const key = "conversationId" in request ? request.conversationId : id;
      const draft = drafts.get(key) ?? {
        conversationId: key,
        revision: 0,
        text: "",
        pendingSubmission: null,
      };
      const ok = (data: unknown) => ({ ok: true as const, state, data });
      if (request.type === "draft.load") return ok(structuredClone(draft));
      if (request.type === "draft.save") {
        if (request.draft.revision !== draft.revision)
          return { ok: false, status: 409, error: "Draft CAS" };
        const next = { ...request.draft, conversationId: key, revision: draft.revision + 1 };
        drafts.set(key, structuredClone(next));
        return ok(next);
      }
      if (request.type === "turn.submit") {
        if (request.revision !== draft.revision)
          return { ok: false, status: 409, error: "Draft CAS" };
        drafts.set(key, {
          ...draft,
          text: "",
          pendingSubmission: null,
          revision: draft.revision + 2,
        });
        submissions++;
        const turn = { conversationId: key, requestId: request.input.requestId, state: "RUNNING" };
        if (request.input.message.startsWith("/path"))
          expect(request.input.nativeCommand).toBeUndefined();
        requests.set(request.input.requestId, turn);
        if (loseAck) throw new Error("ACK lost");
        return ok(turn);
      }
      if (request.type === "request.lookup")
        return requests.has(request.requestId)
          ? ok(requests.get(request.requestId))
          : { ok: false, status: 404, error: "Not recorded" };
      return { ok: false, error: "Unexpected action" };
    },
  };
  return {
    api,
    drafts,
    count: () => submissions,
    loseAck: () => {
      loseAck = true;
    },
  };
}

test("Enter sends, Shift+Enter preserves newline, IME/229 and composition confirmation never send", () => {
  expect(inputAction({ key: "Enter", shiftKey: false }, false, false)).toBe("send");
  expect(inputAction({ key: "Enter", shiftKey: true }, false, false)).toBe("none");
  expect(inputAction({ key: "Enter", shiftKey: true }, false, true)).toBe("none");
  for (const event of [
    { key: "Enter", isComposing: true },
    { key: "Enter", keyCode: 229 },
  ])
    expect(inputAction({ ...event, shiftKey: false }, false, false)).toBe("none");
  expect(inputAction({ key: "Enter", shiftKey: false }, true, false)).toBe("none");
  for (const key of ["Enter", "Tab"])
    expect(inputAction({ key, shiftKey: false }, false, true)).toBe("complete");
  for (const key of ["c", "v", "a", "z", "y"])
    expect(inputAction({ key, shiftKey: false }, false, false)).toBe("none");
});
test("independent drafts persist across editors and rapid conversation switches", async () => {
  const backend = editorBackend();
  const a = new DesktopDraft(backend.api, id),
    b = new DesktopDraft(backend.api, "other");
  await Promise.all([a.load(), b.load()]);
  a.update("中文\n草稿 A");
  b.update("draft B");
  await Promise.all([a.flush(), b.flush()]);
  const reopened = new DesktopDraft(backend.api, id);
  await reopened.load();
  expect(reopened.text).toBe("中文\n草稿 A");
  expect(b.text).toBe("draft B");
});
test("two clients obey CAS; failed save and send preserve local text without silent overwrite", async () => {
  const backend = editorBackend();
  const desktop = new DesktopDraft(backend.api, id),
    tui = new DesktopDraft(backend.api, id);
  await Promise.all([desktop.load(), tui.load()]);
  tui.update("TUI wins");
  await tui.flush();
  desktop.update("Desktop local");
  await desktop.flush().catch(() => {});
  await desktop.submit("mock");
  await desktop.submit("mock");
  expect(backend.count()).toBe(0);
  expect(backend.drafts.get(id)?.text).toBe("TUI wins");
  expect(desktop.text).toBe("Desktop local");
  expect(desktop.error).toContain("提交未完成");
});
test("a competing reserved draft never replaces different unsaved local text", async () => {
  const backend = editorBackend();
  const editor = new DesktopDraft(backend.api, id);
  await editor.load();
  backend.drafts.set(id, {
    conversationId: id,
    revision: 1,
    text: "other pending",
    pendingSubmission: {
      requestId: crypto.randomUUID(),
      message: "other pending",
      harnessId: "mock",
    },
  });
  editor.update("my unsaved text");
  await editor.submit("mock");
  expect(editor.text).toBe("my unsaved text");
  expect(editor.value.pendingSubmission).toBeNull();
  expect(editor.value.revision).toBe(0);
  expect(backend.drafts.get(id)?.pendingSubmission).not.toBeNull();
  expect(backend.count()).toBe(0);
});
test("double send dispatches one turn and clears only an accepted draft", async () => {
  const backend = editorBackend(),
    editor = new DesktopDraft(backend.api, id);
  await editor.load();
  editor.update("hello");
  await Promise.all([editor.submit("mock"), editor.submit("mock")]);
  expect(backend.count()).toBe(1);
  expect(editor.text).toBe("");
});
test("lost ACK keeps request ID locked; explicit lookup recovers without another prompt", async () => {
  const backend = editorBackend(),
    editor = new DesktopDraft(backend.api, id);
  await editor.load();
  editor.update("side effect");
  backend.loseAck();
  await editor.submit("mock");
  const requestId = editor.value.pendingSubmission?.requestId;
  expect(requestId).toBeTruthy();
  expect(editor.text).toBe("side effect");
  await editor.submit("mock");
  expect(backend.count()).toBe(1);
  await editor.lookup();
  expect(editor.value.pendingSubmission).toBeNull();
  expect(editor.text).toBe("");
  expect(editor.result).toContain(requestId ?? "missing");
  expect(backend.count()).toBe(1);
});
test("confirmed unpublished slash text uses one plain Prompt and lost ACK never repeats it", async () => {
  const backend = editorBackend();
  const editor = new DesktopDraft(backend.api, id);
  await editor.load();
  editor.update("/path is ordinary text");
  backend.loseAck();
  await Promise.all([editor.submit("mock"), editor.submit("mock")]);
  expect(backend.count()).toBe(1);
  expect(editor.value.pendingSubmission?.nativeCommand).toBeUndefined();
  const requestId = editor.value.pendingSubmission?.requestId;
  await editor.submit("mock");
  await editor.lookup();
  expect(editor.result).toContain(requestId ?? "missing");
  expect(backend.count()).toBe(1);
});
test("reopening a durable unconfirmed request never automatically sends or releases it on 404", async () => {
  const backend = editorBackend();
  backend.drafts.set(id, {
    conversationId: id,
    revision: 3,
    text: "reserved",
    pendingSubmission: { requestId: crypto.randomUUID(), harnessId: "mock", message: "reserved" },
  });
  const editor = new DesktopDraft(backend.api, id);
  await editor.load();
  await editor.lookup();
  expect(editor.value.pendingSubmission).not.toBeNull();
  expect(editor.text).toBe("reserved");
  expect(backend.count()).toBe(0);
});
const event = (
  seq: number,
  kind: string,
  payload: unknown,
  session = "session",
): ConversationEvent => ({
  id: String(seq),
  conversationId: id,
  nativeSessionId: session,
  turnId: "turn",
  seq,
  raw: payload,
  payload,
  kind,
  origin: "agent",
  createdAt: 0,
});
test("10k events append incrementally, merge native tools by session, preserve old rows and reject gaps", () => {
  const transcript = new DesktopTranscript();
  transcript.append([event(1, "user.message", { text: "start" })]);
  const first = transcript.rows[0];
  const started = performance.now();
  for (let i = 2; i <= 10001; i++)
    transcript.append([
      event(i, i % 2 ? "tool_call_update" : "tool_call", {
        toolCallId: `tool-${Math.floor(i / 2)}`,
        title: "Native tool",
        status: i % 2 ? "completed" : "in_progress",
        rawOutput: `output-${i}`,
      }),
    ]);
  expect(transcript.rows[0]).toBe(first);
  expect(transcript.rows.length).toBe(5001);
  transcript.append([
    event(
      10002,
      "tool_call",
      { toolCallId: "tool-1", title: "Other harness", status: "failed" },
      "new-session",
    ),
  ]);
  expect(transcript.rows.length).toBe(5002);
  expect(() =>
    transcript.append([event(10004, "agent_message_chunk", { content: { text: "gap" } })]),
  ).toThrow();
  expect(performance.now() - started).toBeLessThan(3000);
});
test("successful tools collapse, failed/waiting expand, manual preference wins", () => {
  const transcript = new DesktopTranscript();
  transcript.append([
    event(1, "tool_call", {
      toolCallId: "tool",
      title: "Exact tool",
      status: "completed",
      rawOutput: "full output",
    }),
  ]);
  const row = transcript.rows[0];
  if (!row) throw new Error("missing row");
  const api = editorBackend().api;
  const html = (expanded: Map<string, boolean>, status = row.text, waiting = false) =>
    renderToStaticMarkup(
      <MessageView row={{ ...row, text: status, waiting }} api={api} expanded={expanded} />,
    );
  expect(html(new Map())).not.toContain("full output");
  expect(html(new Map(), "failed")).toContain("full output");
  expect(html(new Map(), "completed", true)).toContain("full output");
  expect(html(new Map([[row.id, false]]), "failed")).not.toContain("full output");
  expect(html(new Map([[row.id, true]]))).toContain("full output");
});
test("Markdown supports GFM/code highlights while HTML, event handlers and unsafe URLs stay inert", () => {
  const html = renderToStaticMarkup(
    <Markdown
      api={editorBackend().api}
      text={
        '# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n> quote\n\n- list\n\n```js\nconst a = 1;\n```\n\n<img src=x onerror="alert(1)"><script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://evil.test/track)'
      }
    />,
  );
  expect(html).toContain("<table>");
  expect(html).toContain("<blockquote>");
  expect(html).toContain("hljs-keyword");
  for (const unsafe of ["<script", "onerror", "javascript:", "<img src=", "<a href="])
    expect(html).not.toContain(unsafe);
});
test("typed write actions reject arbitrary methods, paths, native configs, unconfirmed deletion", () => {
  for (const request of [
    {
      type: "turn.submit",
      conversationId: id,
      revision: 0,
      input: { requestId: id, message: "hi", harnessId: "mock" },
      method: "DELETE",
    },
    { type: "conversation.delete", conversationId: id, confirmed: false },
    { type: "session.settings", conversationId: id, setting: { kind: "apiKey", value: "secret" } },
    { type: "turn.cancel", conversationId: id, turnId: "../daemon/stop" },
    { type: "history", conversationId: id, after: -1 },
  ])
    expect(desktopRequest.safeParse(request).success).toBe(false);
});

test("handoff records merge by ID and keep the expandable native report without internal prompt", () => {
  const transcript = new DesktopTranscript();
  transcript.append([
    event(1, "handoff.record", {
      id: "handoff",
      status: "GENERATING",
      sourceHarness: "a",
      targetHarness: "b",
    }),
    event(2, "handoff.record", {
      id: "handoff",
      status: "COMMITTED",
      sourceHarness: "a",
      targetHarness: "b",
      reportText: "# Exact report",
      userMessage: "private internal envelope",
    }),
  ]);
  expect(transcript.rows.length).toBe(1);
  const row = transcript.rows[0];
  if (!row) throw new Error("missing handoff");
  const html = renderToStaticMarkup(
    <MessageView row={row} api={editorBackend().api} expanded={new Map()} />,
  );
  expect(html).toContain("查看交接报告");
  expect(html).toContain("Exact report");
  expect(html).not.toContain("private internal envelope");
});
