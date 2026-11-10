import { expect, test } from "bun:test";
import type { Conversation, ConversationEvent, Draft } from "@harnesshub/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { type DesktopApi, type DesktopState, desktopRequest } from "../src/contracts";
import { Composer, inputAction } from "../src/renderer/Composer";
import { DesktopDraft } from "../src/renderer/drafts";
import { DesktopTranscript } from "../src/renderer/history";
import { Markdown } from "../src/renderer/Markdown";
import { MessageView } from "../src/renderer/Message";
import { NewConversation } from "../src/renderer/NewConversation";

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
test("composer keeps one native model and approval selector, with legacy fallbacks and Chinese labels", async () => {
  const backend = editorBackend();
  const draft = new DesktopDraft(backend.api, id);
  await draft.load();
  const conversation: Conversation = {
    id,
    title: "Composer",
    projectId: null,
    archivedAt: null,
    workspaceMode: "shared",
    workspacePath: "/tmp/test",
    runtimeStatus: "IDLE",
    activeNativeSessionId: id,
    selectedHarnessId: "mock",
    createdAt: 0,
    updatedAt: 0,
  };
  const render = (native: unknown, selectedHarnessId = "mock") =>
    renderToStaticMarkup(
      <Composer
        api={backend.api}
        draft={draft}
        conversation={{ ...conversation, selectedHarnessId }}
        state={{
          ...state,
          profiles: [{ id: "mock", name: "Mock Harness" }],
          interaction: {
            conversationId: id,
            approvals: [],
            handoffs: [],
            sessions: [
              {
                id,
                conversationId: id,
                harnessId: "mock",
                agentSessionId: "native",
                workerId: id,
                epoch: id,
                status: "READY",
                cwd: conversation.workspacePath,
                capabilities: { session: native },
                createdAt: 0,
                endedAt: null,
                exitConfirmed: false,
              },
            ],
          },
        }}
      />,
    );
  const modes = {
    currentModeId: "full",
    availableModes: [{ id: "full", name: "Full access" }],
  };
  const models = { currentModelId: "native-model[high]" };
  const configOptions = [
    {
      id: "native-model-id",
      category: "model",
      type: "select",
      name: "Model",
      currentValue: "native-model",
      options: [{ group: "native", options: [{ value: "native-model", name: "Native Model" }] }],
    },
    {
      id: "mode",
      type: "select",
      name: "Mode",
      currentValue: "full",
      options: [{ value: "full", name: "Full access" }],
    },
    {
      id: "collaboration_mode",
      type: "select",
      name: "Collaboration mode",
      currentValue: "default",
      options: [{ value: "default", name: "Default" }],
    },
    { id: "fast", type: "boolean", name: "Fast mode", currentValue: true },
  ];
  const html = render({ configOptions: [...configOptions, ...configOptions], modes, models });
  expect(html.match(/<select\b/g)).toHaveLength(3);
  expect(html.match(/>模型<\/span>/g)).toHaveLength(1);
  expect(html.match(/>审批模式<\/span>/g)).toHaveLength(1);
  expect(html).toContain('value="native-model" selected=""');
  expect(html).toContain("Native Model");
  expect(html.match(/Full access/g)).toHaveLength(1);
  expect(html).not.toContain("native-model[high]");
  expect(html).not.toContain("Collaboration mode");
  expect(html).not.toContain("Fast mode");
  expect(html).not.toContain('type="checkbox"');

  const legacy = render({ modes, models });
  expect(legacy.match(/<select\b/g)).toHaveLength(2);
  expect(legacy).toContain("模型 · native-model[high]");
  expect(legacy).toContain("审批模式");
  expect(render({}).match(/<select\b/g)).toHaveLength(1);
  const switching = render({ configOptions, modes, models }, "target");
  expect(switching.match(/<select\b/g)).toHaveLength(1);
  expect(switching).not.toContain("Native Model");
  expect(backend.count()).toBe(0);
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
test("new conversation picker prefers the previous Harness and falls back when its profile is unavailable", () => {
  const conversation: Conversation = {
    id,
    title: "Previous",
    projectId: null,
    archivedAt: null,
    workspaceMode: "shared",
    workspacePath: "/tmp/test",
    runtimeStatus: "IDLE",
    selectedHarnessId: "grok",
    createdAt: 0,
    updatedAt: 0,
  };
  const current: DesktopState = {
    ...state,
    profiles: [
      { id: "codex", name: "Codex" },
      { id: "grok", name: "Grok" },
    ],
    snapshot: {
      projects: [],
      conversations: [conversation],
      cursor: 0,
      activity: { running: 0, waitingApproval: 0, pendingApprovals: 0, problems: 0, items: [] },
    },
  };
  const backend = editorBackend();
  const draft = new DesktopDraft(backend.api, "desktop-new");
  const render = () =>
    renderToStaticMarkup(
      <NewConversation
        api={backend.api}
        draft={draft}
        state={current}
        value={{ projectId: "", workspace: "/tmp/test" }}
        change={() => {}}
        created={async () => {}}
        busyChanged={() => {}}
      />,
    );
  expect(render()).toContain('value="grok" selected=""');
  current.profiles = [{ id: "codex", name: "Codex" }];
  expect(render()).toContain('value="codex" selected=""');
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

for (const saveFails of [false, true])
  test(`RC-05 reload cannot erase edits while a save ${saveFails ? "fails" : "succeeds"}`, async () => {
    const backend = editorBackend();
    const a = new DesktopDraft(backend.api, id),
      b = new DesktopDraft(backend.api, id);
    await Promise.all([a.load(), b.load()]);
    b.update("client B draft");
    await b.flush();
    a.update("client A conflict");
    await expect(a.flush()).rejects.toThrow();
    let release!: () => void;
    const original = backend.api.request;
    let loading!: () => void;
    const started = new Promise<void>((resolve) => {
      loading = resolve;
    });
    backend.api.request = async (request) => {
      if (request.type === "draft.load") {
        const response = await original(request);
        loading();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return response;
      }
      if (request.type === "draft.save" && !saveFails) {
        // Another save may legitimately succeed after a revision synchronization.
        const current = backend.drafts.get(id);
        if (!current) throw new Error("Missing test draft");
        return original({ ...request, draft: { ...request.draft, revision: current.revision } });
      }
      return original(request);
    };
    const reload = a.reload();
    await started;
    a.update("new input must survive");
    release();
    await reload;
    await a.flush().catch(() => {});
    expect(a.text).toBe("new input must survive");
    expect(backend.count()).toBe(0);
  });

test("RC-05 latest reload wins; invalidated component loads cannot overwrite cached editor", async () => {
  const backend = editorBackend(),
    a = new DesktopDraft(backend.api, id);
  await a.load();
  const original = backend.api.request;
  const releases: (() => void)[] = [];
  backend.api.request = async (request) => {
    const response = await original(request);
    if (request.type === "draft.load") await new Promise<void>((resolve) => releases.push(resolve));
    return response;
  };
  const first = a.reload();
  while (releases.length < 1) await Promise.resolve();
  backend.drafts.set(id, {
    conversationId: id,
    revision: 2,
    text: "latest",
    pendingSubmission: null,
  });
  const second = a.reload();
  while (releases.length < 2) await Promise.resolve();
  releases[1]?.();
  await second;
  releases[0]?.();
  await first;
  expect(a.text).toBe("latest");
  backend.drafts.set(id, {
    conversationId: id,
    revision: 3,
    text: "stale after unmount",
    pendingSubmission: null,
  });
  const stale = a.reload();
  while (releases.length < 3) await Promise.resolve();
  a.invalidateLoads();
  const other = new DesktopDraft({ ...backend.api, request: original }, "other-conversation");
  await other.load();
  other.update("other text");
  releases[2]?.();
  await stale;
  expect(a.text).toBe("latest");
  expect(other.text).toBe("other text");
});

test("RC-02/03 Desktop shows explicit context recovery and independently blocks uncertain delivery", async () => {
  const backend = editorBackend(),
    draft = new DesktopDraft(backend.api, id);
  await draft.load();
  draft.update("do not silently submit");
  await draft.flush();
  const conversation = {
    id,
    title: "RC",
    projectId: null,
    archivedAt: null,
    workspaceMode: "shared" as const,
    workspacePath: "/tmp/test",
    runtimeStatus: "INTERRUPTED" as const,
    activeNativeSessionId: id,
    selectedHarnessId: "mock",
    createdAt: 0,
    updatedAt: 0,
  };
  const session = {
    id,
    conversationId: id,
    harnessId: "mock",
    agentSessionId: "native",
    workerId: id,
    epoch: id,
    status: "INTERRUPTED",
    cwd: "/tmp/test",
    capabilities: {},
    createdAt: 0,
    endedAt: 1,
    exitConfirmed: true,
  };
  const current = {
    ...state,
    snapshot: {
      projects: [],
      conversations: [conversation],
      cursor: 0,
      activity: { running: 0, waitingApproval: 0, pendingApprovals: 0, problems: 1, items: [] },
    },
    interaction: { conversationId: id, sessions: [session], approvals: [], handoffs: [] },
  };
  const render = () =>
    renderToStaticMarkup(
      <Composer api={backend.api} draft={draft} state={current} conversation={conversation} />,
    );
  expect(render()).toContain("使用新原生上下文继续");
  session.exitConfirmed = false;
  expect(render()).toContain("Worker 退出尚未确认");
  expect(render()).not.toContain("使用新原生上下文继续");
  // Even a stale IDLE Conversation cannot enable submission over the input journal.
  const uncertain = {
    ...current,
    snapshot: {
      ...current.snapshot,
      pendingInputs: [
        {
          conversationId: id,
          requestId: id,
          state: "UNCERTAIN" as const,
          turnId: id,
          reason: "ACK lost",
          input: { requestId: id, harnessId: "mock", message: "steer", delivery: "steer" as const },
        },
      ],
    },
  };
  const html = renderToStaticMarkup(
    <Composer
      api={backend.api}
      draft={draft}
      state={uncertain}
      conversation={{ ...conversation, runtimeStatus: "IDLE" }}
    />,
  );
  expect(html).toContain("输入投递结果不确定（UNCERTAIN）");
  expect(html).toContain("requestId");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>↑ 发送/);
  expect(backend.count()).toBe(0);
});

test("RC-04 expired approval replay clears waiting without rewriting native tool status", () => {
  const make = (seq: number, kind: string, payload: unknown): ConversationEvent => ({
    id: String(seq),
    conversationId: id,
    nativeSessionId: id,
    turnId: id,
    seq,
    kind,
    payload,
    raw: null,
    origin: "runtime",
    createdAt: 0,
  });
  const requested = make(1, "approval.requested", {
    id: "approval",
    request: {
      toolCall: { toolCallId: "tool", title: "Native tool", status: "pending" },
      options: [{ optionId: "deny", name: "Reject" }],
    },
  });
  const expired = make(2, "approval.expired", {
    approvalId: "approval",
    status: "EXPIRED",
    reason: "daemon_restart",
  });
  const transcript = new DesktopTranscript();
  transcript.append([requested]);
  expect(transcript.rows.find((r) => r.tool)?.waiting).toBe(true);
  transcript.append([expired]);
  transcript.append([requested, expired]);
  const row = transcript.rows.find((r) => r.tool);
  if (!row) throw new Error("Missing tool projection");
  expect(row.waiting).toBe(false);
  expect(row.tool?.status).toBe("pending");
  const html = renderToStaticMarkup(
    <MessageView row={row} api={editorBackend().api} expanded={new Map()} />,
  );
  expect(html).toContain("审批已过期");
  expect(html).not.toContain("等待审批");
});
