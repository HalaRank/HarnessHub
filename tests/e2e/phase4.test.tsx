import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RGBA, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { App } from "../../apps/tui/src/index";
import { HISTORY_WINDOW_SIZE, NativeEvents } from "../../apps/tui/src/native-events";
import { RawEvents } from "../../apps/tui/src/raw-events";
import { Markdown, sourceParts, UnifiedDiff } from "../../apps/tui/src/rich-content";
import { SourceViewer } from "../../apps/tui/src/source-viewer";
import { chatVisible, newViewState, projectEvent, Transcript } from "../../apps/tui/src/transcript";
import { connect } from "../../packages/shared/src/client";
import type { Conversation, ConversationEvent } from "../../packages/shared/src/index";
import {
  clickControl,
  focusMessage,
  invoke,
  navigate,
  openCommands,
  selectLastRow,
} from "./ui-actions";

const temp = mkdtempSync(join(tmpdir(), "hhu-phase4-ui-"));
const previous = { ...process.env };
const cli = resolve("dist/cli/hhu.js");
beforeAll(async () => {
  Object.assign(process.env, {
    XDG_CONFIG_HOME: join(temp, "config"),
    XDG_DATA_HOME: join(temp, "data"),
    XDG_STATE_HOME: join(temp, "state"),
  });
  expect(spawnSync(process.execPath, [cli, "daemon", "start"]).status).toBe(0);
  await api("/v1/harness-profiles", "POST", {
    id: "mock",
    name: "Phase 4 Mock",
    command: "node",
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
  });
});
afterAll(() => {
  spawnSync(process.execPath, [cli, "daemon", "stop", "--cancel-active"]);
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k];
  }
  console.log(`Phase-4 UI evidence: ${temp}`);
});
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const client = await connect();
  if (!client) throw new Error("No test Daemon");
  return client.request<T>(path, method, body);
}
const event = (
  seq: number,
  kind: string,
  payload: unknown,
  nativeSessionId = "native",
): ConversationEvent => ({
  id: `event-${seq}`,
  conversationId: "conversation",
  nativeSessionId,
  turnId: "turn",
  seq,
  kind,
  payload,
  origin: kind === "user.message" ? "client" : "agent",
  raw: { method: "session/update", params: { sessionId: nativeSessionId, update: payload } },
  createdAt: seq,
});
const textEvent = (seq: number, text: string, kind = "agent_message_chunk") =>
  event(seq, kind, { sessionUpdate: kind, content: { type: "text", text } });
const messageEvent = (seq: number, text: string) => ({
  ...event(seq, "user.message", { text }),
  turnId: `turn-${seq}`,
});
async function waitFor(check: () => boolean | Promise<boolean>, label = "state") {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
async function frame(screen: Awaited<ReturnType<typeof testRender>>, text: string) {
  await waitFor(async () => {
    await screen.renderOnce();
    return screen.captureCharFrame().includes(text);
  }, text).catch((error) => {
    throw new Error(`${error.message}\n${screen.captureCharFrame()}`);
  });
}
async function setup(title: string) {
  const root = join(temp, title);
  mkdirSync(root);
  const p = await api<{ id: string }>("/v1/projects", "POST", { rootPath: root, name: title });
  const c = await api<Conversation>(`/v1/projects/${p.id}/conversations`, "POST", { title });
  await api("/v1/preferences", "PATCH", {
    lastConversationId: c.id,
    showSidebar: true,
    shortcuts: {},
  });
  return { p, c, root };
}

test("native projection preserves Markdown, public thinking, tools, plans, unknown events and source correspondence", () => {
  const model = new Transcript();
  const markdown = "# Original 标题\n\n```ts\n  const x = 1;\n    x++;\n```\n";
  const events = [
    event(1, "user.message", { text: "USER" }),
    textEvent(2, "THINK", "agent_thought_chunk"),
    textEvent(3, markdown.slice(0, 20)),
    textEvent(4, markdown.slice(20)),
    event(5, "tool_call", {
      toolCallId: "id",
      title: "Codex.exec_command",
      status: "in_progress",
      rawInput: { cmd: "pwd" },
    }),
    event(6, "tool_call_update", {
      toolCallId: "id",
      status: "completed",
      rawOutput: "  native\n\noutput",
    }),
    event(7, "plan", { entries: [{ content: "原始计划", status: "pending", priority: "high" }] }),
    event(8, "custom", { text: "exact payload", futureKind: "metadata stays in source" }),
    event(
      9,
      "tool_call",
      { toolCallId: "id", title: "Grok.run", status: "failed" },
      "another-native",
    ),
  ];
  model.append(events.slice(0, 4));
  const stable = model.rows[2];
  model.append(events.slice(4));
  model.append(events);
  expect(model.events).toEqual(events);
  expect(model.rows[2]).toBe(stable);
  expect(model.rows.filter((r) => r.value().kind === "text").map((r) => model.source(r))).toEqual([
    "USER",
    "THINK",
    markdown,
  ]);
  const tools = model.rows.filter((r) => r.value().tool);
  expect(tools.length).toBe(2);
  expect(tools[0]?.value().tool?.title).toBe("Codex.exec_command");
  expect(tools[1]?.value().tool?.title).toBe("Grok.run");
  expect(tools[0]?.sources.map((e) => e.seq)).toEqual([5, 6]);
  expect(model.rows.some((r) => r.value().text.includes("原始计划"))).toBe(true);
  expect(model.rows.some((r) => r.value().text.includes("exact payload"))).toBe(true);
  expect(sourceParts(markdown, null)[1]?.text).toBe("  const x = 1;\n    x++;\n");
  expect(() => model.append([textEvent(11, "gap")])).toThrow("Non-contiguous");
  expect(() =>
    new Transcript().append([{ ...textEvent(1, "x"), conversationId: "other" }, textEvent(2, "y")]),
  ).toThrow("mismatch");
});

test("Markdown headings, lists, quotes, tables, code indentation and colored Diff render with OpenTUI", async () => {
  const markdown =
    "# Native Heading\n\n- List item\n\n> Quoted text\n\n| Name | Value |\n| --- | --- |\n| Alpha | Beta |\n\n```ts\n  const original = 1;\n    original++;\n```\n";
  const screen = await testRender(
    () => (
      <box flexDirection="column">
        <Markdown text={markdown} />
        <UnifiedDiff
          value={"--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-const old = 1;\n+const next = 2;\n"}
          path="file.ts"
        />
      </box>
    ),
    { width: 100, height: 35 },
  );
  try {
    await frame(screen, "const next = 2");
    await frame(screen, "Native Heading");
    const rendered = screen.captureCharFrame();
    for (const value of [
      "Native Heading",
      "List item",
      "Quoted text",
      "Alpha",
      "Beta",
      "  const original",
      "    original++",
      "const old = 1",
    ])
      expect(rendered).toContain(value);
    const lines = screen.captureSpans().lines;
    expect(
      lines.some(
        (line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes("const next") &&
          line.spans.some((span) => span.bg.equals(RGBA.fromHex("#142b20"))),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes("const old") &&
          line.spans.some((span) => span.bg.equals(RGBA.fromHex("#351b23"))),
      ),
    ).toBe(true);
  } finally {
    await screen.dispose();
  }
});

test("user messages have full-width gray backgrounds without coloring Agent replies at wide and narrow widths", async () => {
  const prompt =
    "# USER_HEADING\n\nUSER_FIRST\n\nUSER_WRAPPED " +
    "readable words ".repeat(8) +
    "\n\n```ts\nconst original = 1;\n```";
  const events = [event(1, "user.message", { text: prompt }), textEvent(2, "AGENT_REPLY")];
  for (const width of [100, 32]) {
    const model = new Transcript();
    model.append(events);
    const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
      width,
      height: 40,
    });
    try {
      await frame(screen, "USER_HEADING");
      await frame(screen, "const original = 1;");
      await frame(screen, "AGENT_REPLY");
      const gray = RGBA.fromHex("#2d2d30");
      const lines = screen.captureSpans().lines;
      for (const content of [
        "You",
        "USER_HEADING",
        "USER_FIRST",
        "USER_WRAPPED",
        "const original",
      ]) {
        const line = lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes(content),
        );
        expect(line).toBeDefined();
        expect(line?.spans.every((span) => span.bg.equals(gray))).toBe(true);
      }
      const reply = lines.find((line) =>
        line.spans
          .map((span) => span.text)
          .join("")
          .includes("AGENT_REPLY"),
      );
      expect(reply).toBeDefined();
      expect(reply?.spans.some((span) => span.bg.equals(gray))).toBe(false);
      const user = model.rows[0];
      if (!user) throw new Error("User message missing from transcript");
      expect(model.source(user)).toBe(prompt);
      expect(model.events).toEqual(events);
    } finally {
      await screen.dispose();
    }
  }
});

test("tool details default to collapsed, explicit expansion survives status and pane remount", async () => {
  const model = new Transcript(),
    view = newViewState();
  model.append([
    event(1, "tool_call", {
      toolCallId: "tool",
      title: "NativeExact",
      status: "completed",
      rawOutput: "EXACT_RESULT",
    }),
  ]);
  let screen = await testRender(() => <NativeEvents model={model} view={view} disabled={false} />, {
    width: 120,
    height: 25,
  });
  try {
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("EXACT_RESULT");
    screen.mockInput.pressEnter();
    await frame(screen, "EXACT_RESULT");
    model.append([
      event(2, "tool_call_update", { toolCallId: "tool", status: "in_progress" }),
      event(3, "tool_call_update", { toolCallId: "tool", status: "completed" }),
    ]);
    await frame(screen, "EXACT_RESULT");
    await screen.dispose();
    screen = await testRender(() => <NativeEvents model={model} view={view} disabled={false} />, {
      width: 120,
      height: 25,
    });
    await frame(screen, "EXACT_RESULT");
    const failed = new Transcript();
    failed.append([
      event(1, "tool_call", {
        toolCallId: "failed",
        status: "failed",
        rawOutput: "FAILURE_NATIVE",
      }),
    ]);
    const small = await testRender(() => <NativeEvents model={failed} disabled={false} />, {
      width: 100,
      height: 20,
    });
    try {
      await frame(small, "failed");
      expect(small.captureCharFrame()).not.toContain("FAILURE_NATIVE");
      small.mockInput.pressEnter();
      await frame(small, "FAILURE_NATIVE");
    } finally {
      await small.dispose();
    }
    model.append([
      event(4, "approval.requested", {
        id: "approval",
        request: { toolCall: { toolCallId: "tool" } },
      }),
    ]);
    await frame(screen, "WAITING_APPROVAL");
  } finally {
    await screen.dispose();
  }
});

test("source viewer copies exact original Markdown, code and native tool output using OSC52", async () => {
  const markdown = "# Raw\n\n```ts\n  original();\n\n```\n",
    output = "  tool output\n\n";
  const parts = sourceParts(markdown, { rawOutput: output });
  const screen = await testRender(() => <SourceViewer parts={parts} onClose={() => {}} />, {
    width: 120,
    height: 35,
  });
  const copied: string[] = [];
  Object.defineProperty(screen.renderer, "capabilities", {
    get: () => ({ remote: true, osc52_support: "supported" }),
    configurable: true,
  });
  screen.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text);
    return true;
  };
  try {
    await screen.renderOnce();
    screen.mockInput.pressEnter();
    await screen.renderOnce();
    await waitFor(() => copied.length > 0);
    expect(copied.at(-1)).toBe(markdown);
    screen.mockInput.pressArrow("down");
    screen.mockInput.pressEnter();
    await screen.renderOnce();
    await waitFor(() => copied.at(-1) === output);
    expect(copied.at(-1)).toBe(output);
    screen.mockInput.pressArrow("down");
    screen.mockInput.pressEnter();
    await screen.renderOnce();
    await waitFor(() => copied.at(-1) === "  original();\n\n");
    expect(copied.at(-1)).toBe("  original();\n\n");
  } finally {
    await screen.dispose();
  }
});

test("unknown events expose raw and normalized payloads with event IDs and sequence numbers", async () => {
  const model = new Transcript();
  model.append([event(1, "custom", { content: { type: "text", text: "UNCHANGED_FUTURE" } })]);
  const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
    width: 140,
    height: 35,
  });
  try {
    await frame(screen, "UNCHANGED_FUTURE");
    await clickControl(screen, "transcript-raw");
    await frame(screen, "Original source");
    expect(screen.captureCharFrame()).toContain('"eventId": "event-1"');
    expect(screen.captureCharFrame()).toContain('"normalized"');
    expect(screen.captureCharFrame()).toContain('"raw"');
  } finally {
    await screen.dispose();
  }
});

test("long history has bounded mounted rows, incremental content, scroll lock, bottom following and scroll restore", async () => {
  const model = new Transcript(),
    view = newViewState();
  const started = performance.now();
  for (let n = 0; n < 100; n++)
    model.append(
      Array.from({ length: 200 }, (_, i) =>
        textEvent(n * 200 + i + 1, `native-${n * 200 + i} 世界\n`),
      ),
    );
  const elapsed = performance.now() - started;
  expect(model.events.length).toBe(20000);
  expect(model.rows.length).toBeLessThan(40);
  expect(model.rows.map((r) => r.value().text).join("")).toBe(
    model.events.map((e) => (e.payload as { content: { text: string } }).content.text).join(""),
  );
  const long = new Transcript();
  long.append(
    Array.from({ length: 10000 }, (_, i) =>
      messageEvent(i + 1, `row-${i}\n${"content\n".repeat(5)}`),
    ),
  );
  expect(long.rows.length).toBe(10000);
  expect(long.rows[0]?.value().text).toContain("row-0");
  expect(long.rows[9999]?.value().text).toContain("row-9999");
  let screen = await testRender(() => <NativeEvents model={long} view={view} disabled={false} />, {
    width: 150,
    height: 35,
  });
  try {
    await frame(screen, "row-9999");
    const scroll = () =>
      screen.renderer.root.findDescendantById("native-history") as ScrollBoxRenderable;
    expect(scroll().getChildrenCount()).toBeLessThanOrEqual(HISTORY_WINDOW_SIZE + 3);
    scroll().scrollTo(20);
    await screen.renderOnce();
    const top = scroll().scrollTop;
    long.append([messageEvent(10001, "last-row-new")]);
    await screen.renderOnce();
    expect(scroll().scrollTop).toBe(top);
    await screen.dispose();
    screen = await testRender(() => <NativeEvents model={long} view={view} disabled={false} />, {
      width: 150,
      height: 35,
    });
    await screen.renderOnce();
    await screen.renderOnce();
    expect(scroll().scrollTop).toBe(top);
    screen.mockInput.pressKey("END");
    await frame(screen, "last-row-new");
    long.append([messageEvent(10002, "FOLLOW_LATEST")]);
    await frame(screen, "FOLLOW_LATEST");
    screen.mockInput.pressKey("\x1b[5;5~");
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("FOLLOW_LATEST");
    console.log(
      JSON.stringify({
        phase4Performance: true,
        chunks: 20000,
        projectionMs: Math.round(elapsed),
        displaySegments: model.rows.length,
        historyRows: 10000,
        mountedRowLimit: HISTORY_WINDOW_SIZE,
      }),
    );
  } finally {
    await screen.dispose();
  }
}, 20000);

test("App Esc returns chat to the bottom from navigation or the editor without discarding drafts; modals take priority", async () => {
  const { c } = await setup("Chat scroll shortcuts");
  const turn = await api<{ id: string }>(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "mock",
    message: Array.from({ length: 80 }, (_, index) => `scroll line ${index}`).join("\n"),
  });
  await waitFor(
    async () => (await api<{ endedAt: number | null }>(`/v1/turns/${turn.id}`)).endedAt !== null,
  );
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  try {
    await frame(screen, "Chat · History");
    await frame(screen, "Connected");
    await frame(screen, "Exact Native Tool Name");
    for (let count = 0; count < 4; count++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await screen.renderOnce();
    }
    const scroll = screen.renderer.root.findDescendantById("native-history") as ScrollBoxRenderable;
    const atBottom = () => scroll.scrollTop + scroll.viewport.height >= scroll.scrollHeight - 1;
    scroll.scrollTo(10);
    await screen.renderOnce();
    expect(atBottom()).toBe(false);
    screen.mockInput.pressEscape();
    await waitFor(async () => {
      await screen.renderOnce();
      return atBottom();
    }, "Esc from chat navigation");
    screen.mockInput.pressEnter();
    const editor = screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable;
    await waitFor(() => editor.focused);
    await screen.mockInput.typeText("unsent draft");
    scroll.scrollTo(10);
    await screen.renderOnce();
    expect(atBottom()).toBe(false);
    screen.mockInput.pressEscape();
    await waitFor(async () => {
      await screen.renderOnce();
      return !editor.focused && atBottom();
    }, "Esc from message editor");
    expect(editor.plainText).toBe("unsent draft");
    scroll.scrollTo(10);
    await screen.renderOnce();
    await openCommands(screen);
    await frame(screen, "Command palette");
    screen.mockInput.pressEscape();
    await waitFor(async () => {
      await screen.renderOnce();
      return !screen.captureCharFrame().includes("Command palette");
    });
    expect(scroll.scrollTop).toBe(10);
    expect(editor.plainText).toBe("unsent draft");
    expect(
      (
        await api<{ events: ConversationEvent[] }>(`/v1/conversations/${c.id}/events`)
      ).events.filter((event) => event.kind === "user.message"),
    ).toHaveLength(1);
  } finally {
    await screen.dispose();
  }
}, 20000);

test("unmodified letters other than N never invoke navigation, Harness or transcript actions", async () => {
  const { p, c } = await setup("Modified shortcuts only");
  let exited = false;
  const screen = await testRender(() => <App onExit={() => (exited = true)} />, {
    width: 170,
    height: 45,
  });
  try {
    await frame(screen, "Esc interrupt");
    const input = screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable;
    const original = await api<Conversation>(`/v1/conversations/${c.id}`);
    await screen.mockInput.typeText(
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".replaceAll(/n/gi, ""),
    );
    await screen.renderOnce();
    expect(exited).toBe(false);
    expect(input.focused).toBe(false);
    expect(input.plainText).toBe("");
    expect(await api<Conversation>(`/v1/conversations/${c.id}`)).toEqual(original);
    expect(await api<Conversation[]>(`/v1/projects/${p.id}/conversations`)).toHaveLength(1);
    for (const title of ["Existing project", "Conversation / Project actions", "Original source"])
      expect(screen.captureCharFrame()).not.toContain(title);
    await focusMessage(screen);
    await waitFor(() => input.focused);
    await screen.mockInput.typeText("mahcxfpnoqgterya");
    expect(input.plainText).toBe("mahcxfpnoqgterya");
  } finally {
    await screen.dispose();
  }
});

test("Enter sends once, Kitty Shift+Enter and Ctrl+J insert newlines without submitting", async () => {
  const { c } = await setup("Keyboard compatibility");
  await api(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId: "mock" });
  const screen = await testRender(() => <App onExit={() => {}} />, {
    width: 150,
    height: 45,
    kittyKeyboard: true,
  });
  try {
    await frame(screen, "Esc interrupt");
    expect(screen.captureCharFrame()).toContain("Model (ACP) · mock-model");
    await frame(screen, "Esc interrupt");
    await focusMessage(screen);
    await frame(screen, "Esc navigate");
    await screen.mockInput.typeText("one");
    screen.mockInput.pressEnter({ shift: true });
    await screen.mockInput.typeText("two");
    screen.mockInput.pressKey("j", { ctrl: true });
    await screen.mockInput.typeText("three");
    await screen.renderOnce();
    const editor = screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable;
    expect(editor.plainText).toBe("one\ntwo\nthree");
    expect(
      (await api<{ events: unknown[] }>(`/v1/conversations/${c.id}/events`)).events.some(
        (e) => (e as { kind: string }).kind === "user.message",
      ),
    ).toBe(false);
    screen.mockInput.pressEnter();
    screen.mockInput.pressEnter();
    await waitFor(async () =>
      (
        await api<{ events: ConversationEvent[] }>(`/v1/conversations/${c.id}/events?limit=1000`)
      ).events.some((e) => e.kind === "runtime.turn_finished"),
    );
    const events = (
      await api<{ events: ConversationEvent[] }>(`/v1/conversations/${c.id}/events?limit=1000`)
    ).events;
    expect(
      events
        .filter((e) => e.kind === "user.message")
        .map((e) => (e.payload as { text: string }).text),
    ).toEqual(["one\ntwo\nthree"]);
    expect(
      events.filter(
        (e) => e.origin === "client" && (e.raw as { method?: string })?.method === "session/prompt",
      ).length,
    ).toBe(1);
  } finally {
    await screen.dispose();
    await api(`/v1/conversations/${c.id}/session/stop`, "POST", {});
  }
}, 20000);

test("command palette searches projects and conversations, responsive sidebar hides and configured shortcuts work", async () => {
  const { p, c } = await setup("Palette project");
  const b = await api<Conversation>(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "Unique Palette Beta",
  });
  await api("/v1/preferences", "PATCH", {
    shortcuts: { palette: "ctrl+s", sidebar: "ctrl+v", newline: "meta+return" },
  });
  const screen = await testRender(() => <App onExit={() => {}} />, {
    width: 150,
    height: 45,
    kittyKeyboard: true,
  });
  try {
    await frame(screen, "Esc interrupt");
    screen.mockInput.pressKey("s", { ctrl: true });
    await frame(screen, "Command palette");
    await screen.mockInput.typeText("Unique Palette Beta");
    screen.mockInput.pressEnter();
    await frame(screen, "Conversation · Unique Palette Beta");
    await waitFor(
      async () =>
        (await api<{ lastConversationId: string }>("/v1/preferences")).lastConversationId === b.id,
    );
    screen.mockInput.pressKey("v", { ctrl: true });
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("Projects → Conversations");
    screen.mockInput.pressKey("v", { ctrl: true });
    await frame(screen, "Projects → Conversations");
    screen.resize(72, 28);
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("Projects → Conversations");
    screen.resize(150, 45);
    await frame(screen, "Projects → Conversations");
    await frame(screen, "Esc interrupt");
    await focusMessage(screen);
    await screen.mockInput.typeText("alternative");
    screen.mockInput.pressEnter({ meta: true });
    await screen.mockInput.typeText("newline");
    await screen.renderOnce();
    expect(
      (screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable).plainText,
    ).toBe("alternative\nnewline");
    screen.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    expect(
      (await api<{ events: unknown[] }>(`/v1/conversations/${b.id}/events`)).events.length,
    ).toBe(0);
    expect(
      (await api<{ events: unknown[] }>(`/v1/conversations/${c.id}/events`)).events.length,
    ).toBe(0);
  } finally {
    await screen.dispose();
  }
}, 20000);

test("two concurrently streaming Conversations switch without mixing output, losing drafts or cancelling Workers", async () => {
  const { p, c } = await setup("Concurrent Alpha");
  const b = await api<Conversation>(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "Concurrent Beta",
  });
  const turns = await Promise.all(
    [c, b].map((value) =>
      api<{ id: string }>(`/v1/conversations/${value.id}/turns`, "POST", {
        requestId: crypto.randomUUID(),
        harnessId: "mock",
        message: "timed",
      }),
    ),
  );
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 160, height: 45 });
  try {
    await frame(screen, "Global · Running 2");
    await frame(screen, "native-");
    await frame(screen, "Esc interrupt");
    await focusMessage(screen);
    await screen.mockInput.typeText("Alpha isolated draft");
    await invoke(screen, "Conversation · Concurrent Alpha / Concurrent Beta");
    await frame(screen, "Conversation · Concurrent Beta");
    await frame(screen, "native-");
    await frame(screen, "Esc interrupt");
    await focusMessage(screen);
    await screen.mockInput.typeText("Beta isolated draft");
    await invoke(screen, "Conversation · Concurrent Alpha / Concurrent Alpha");
    await frame(screen, "Conversation · Concurrent Alpha");
    await frame(screen, "Alpha isolated draft");
    await waitFor(async () =>
      (
        await Promise.all(turns.map((t) => api<{ endedAt: number | null }>(`/v1/turns/${t.id}`)))
      ).every((t) => t.endedAt !== null),
    );
    for (const value of [c, b]) {
      const page = await api<{ events: ConversationEvent[] }>(
        `/v1/conversations/${value.id}/events?limit=1000`,
      );
      expect(page.events.every((e) => e.conversationId === value.id)).toBe(true);
      expect(
        page.events.filter(
          (e) =>
            e.origin === "client" && (e.raw as { method?: string })?.method === "session/cancel",
        ).length,
      ).toBe(0);
    }
  } finally {
    await screen.dispose();
    for (const value of [c, b]) await api(`/v1/conversations/${value.id}/session/stop`, "POST", {});
  }
}, 20000);

test("Changes panel reads actual workspace Git state and exposes an inline patch", async () => {
  const { root } = await setup("Changes UI");
  spawnSync("git", ["init", "-b", "main"], { cwd: root });
  writeFileSync(join(root, "hello.ts"), "export const hello = 'native';\n");
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 170, height: 45 });
  try {
    await frame(screen, "Esc interrupt");
    await invoke(screen, "Toggle Changes / Chat");
    await frame(screen, "Changes · Conversation workspace");
    await frame(screen, "hello.ts");
    await frame(screen, "export const hello");
    expect(screen.captureCharFrame()).toContain("Untracked");
    await screen.mockInput.typeText("gyGY");
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("Original source");
    writeFileSync(join(root, "refreshed.ts"), "export const refreshed = true;\n");
    await clickControl(screen, "changes-refresh");
    await frame(screen, "refreshed.ts");
    await frame(screen, "export const hello");
    await clickControl(screen, "changes-source");
    await frame(screen, "Original source");
    screen.mockInput.pressEscape();
    await waitFor(async () => {
      await screen.renderOnce();
      return !screen.captureCharFrame().includes("Original source");
    });
    await invoke(screen, "Toggle Changes / Chat");
    await frame(screen, "Start a conversation");
  } finally {
    await screen.dispose();
  }
});

test("Codex terminal metadata deltas render and copy without changing native payloads; tool Diff stays inline", async () => {
  const model = new Transcript();
  const events = [
    event(1, "tool_call", {
      toolCallId: "exec",
      name: "exec_command",
      title: "Native command title",
      status: "in_progress",
      _meta: { terminal_info: { terminal_id: "terminal", cwd: "/bound" } },
    }),
    event(2, "tool_call_update", {
      toolCallId: "exec",
      _meta: { terminal_output_delta: { terminal_id: "terminal", data: "  first\n" } },
    }),
    event(3, "tool_call_update", {
      toolCallId: "exec",
      _meta: { terminal_output_delta: { terminal_id: "terminal", data: "second\n\n" } },
    }),
    event(4, "tool_call_update", {
      toolCallId: "exec",
      status: "completed",
      _meta: { terminal_exit: { terminal_id: "terminal", exit_code: 0, signal: null } },
    }),
    event(5, "tool_call", {
      toolCallId: "edit",
      title: "Native Edit",
      status: "in_progress",
      content: [
        {
          type: "diff",
          path: "file.ts",
          oldText: "const before = 1;\n",
          newText: "const after = 2;\n",
        },
      ],
    }),
  ];
  const original = JSON.stringify(events);
  model.append(events);
  expect(JSON.stringify(events)).toBe(original);
  expect(model.rows[0]?.value().terminals.terminal?.output).toBe("  first\nsecond\n\n");
  const view = newViewState();
  view.manual[model.rows[0]?.id ?? ""] = true;
  view.manual[model.rows[1]?.id ?? ""] = true;
  const screen = await testRender(
    () => <NativeEvents model={model} view={view} disabled={false} />,
    { width: 140, height: 45 },
  );
  const copied: string[] = [];
  Object.defineProperty(screen.renderer, "capabilities", {
    get: () => ({ remote: true, osc52_support: "supported" }),
    configurable: true,
  });
  screen.renderer.copyToClipboardOSC52 = (value) => {
    copied.push(value);
    return true;
  };
  try {
    await frame(screen, "const after = 2");
    expect(screen.captureCharFrame()).toContain("Native command title");
    expect(screen.captureCharFrame()).toContain("  first");
    expect(screen.captureCharFrame()).toContain("second");
    await clickControl(screen, "transcript-source");
    await frame(screen, "Original source");
    screen.mockInput.pressArrow("down");
    screen.mockInput.pressEnter();
    await screen.renderOnce();
    await waitFor(() => copied.length > 0);
    expect(copied.at(-1)).toBe("  first\nsecond\n\n");
  } finally {
    await screen.dispose();
  }
});

test("rapidly returning to a Conversation waits for its departing editor's pending CAS save", async () => {
  const { DraftSession } = await import("../../apps/tui/src/draft-session");
  const { c } = await setup("Fast draft switch");
  const first = new DraftSession(
    c.id,
    () => {},
    () => {},
  );
  await first.load();
  first.update("last local text");
  const original = first.request.bind(first);
  let release: () => void = () => {};
  const gate = new Promise<void>((ok) => {
    release = ok;
  });
  first.request = async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
    if (method === "PUT") await gate;
    return original<T>(path, method, body);
  };
  const saving = first.dispose();
  const second = new DraftSession(
    c.id,
    () => {},
    () => {},
  );
  let loaded = false;
  const loading = second.load().then(() => {
    loaded = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(loaded).toBe(false);
  release();
  await saving;
  await loading;
  expect(second.text).toBe("last local text");
  await second.dispose();
});

test("long text segments keep surrogate pairs and original full-message copying intact", () => {
  for (const chunks of [
    [`${"x".repeat(15999)}🙂tail`],
    [`${"x".repeat(15999)}\ud83d`, "\ude42tail"],
  ]) {
    const model = new Transcript();
    model.append(chunks.map((chunk, i) => textEvent(i + 1, chunk)));
    expect(model.rows.map((row) => row.value().text).join("")).toBe(chunks.join(""));
    expect(model.source(model.rows[0] as NonNullable<(typeof model.rows)[0]>)).toBe(
      chunks.join(""),
    );
    expect(
      model.rows.every(
        (row) =>
          !/[\ud800-\udbff]$/.test(row.value().text) && !/^[\udc00-\udfff]/.test(row.value().text),
      ),
    ).toBe(true);
  }
});

test("new messages cannot replace the history being read after the user scrolls up", async () => {
  const model = new Transcript();
  model.append(
    Array.from({ length: 120 }, (_, i) =>
      messageEvent(i + 1, `boundary-${i}\n${"native line\n".repeat(4)}`),
    ),
  );
  expect(model.rows.length).toBe(120);
  const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
    width: 140,
    height: 30,
  });
  try {
    await frame(screen, "boundary-119");
    const scroll = screen.renderer.root.findDescendantById("native-history") as ScrollBoxRenderable;
    scroll.scrollTo(10);
    await screen.renderOnce();
    const before = scroll.scrollTop;
    model.append([messageEvent(121, "DO_NOT_JUMP_NEW_PAGE")]);
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("DO_NOT_JUMP_NEW_PAGE");
    expect(scroll.scrollTop).toBe(before);
    screen.mockInput.pressKey("END");
    await frame(screen, "DO_NOT_JUMP_NEW_PAGE");
  } finally {
    await screen.dispose();
  }
});

test("refinement hides ACP control traffic, retains real errors and all raw sources", async () => {
  const model = new Transcript();
  const events = [
    event(1, "initialize", { secretMarker: "HANDSHAKE_ONLY" }),
    event(2, "acp.response", { result: "CONTROL_ONLY" }),
    textEvent(3, "visible original Markdown"),
    event(4, "config_option_update", { configOptions: [] }),
    textEvent(5, " continuation"),
    {
      ...event(6, "acp.response", { message: "REAL_PROTOCOL_ERROR" }),
      raw: { id: 2, error: { code: -1, message: "REAL_PROTOCOL_ERROR" } },
    },
    event(7, "custom", { message: "UNKNOWN_VISIBLE" }),
    event(8, "runtime.session_error", { message: "REAL_RUNTIME_ERROR" }),
  ];
  model.append(events);
  expect(model.events).toEqual(events);
  expect(model.rows[0]?.value().text).toBe("visible original Markdown continuation");
  const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
    width: 140,
    height: 30,
  });
  try {
    await frame(screen, "REAL_RUNTIME_ERROR");
    expect(screen.captureCharFrame()).toContain("REAL_PROTOCOL_ERROR");
    expect(screen.captureCharFrame()).toContain("UNKNOWN_VISIBLE");
    expect(screen.captureCharFrame()).not.toContain("HANDSHAKE_ONLY");
    expect(screen.captureCharFrame()).not.toContain("CONTROL_ONLY");
  } finally {
    await screen.dispose();
  }
});

test("Ctrl+C clears draft, second Ctrl+C exits; selection takes precedence and does not cancel running Agent", async () => {
  const { c } = await setup("Ctrl C states");
  const turn = await api<{ id: string }>(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "mock",
    message: "wait",
  });
  let exits = 0;
  const screen = await testRender(
    () => (
      <App
        onExit={() => {
          exits++;
        }}
      />
    ),
    { width: 150, height: 35, exitOnCtrlC: false, exitSignals: [] },
  );
  const copied: string[] = [];
  Object.defineProperty(screen.renderer, "capabilities", {
    get: () => ({ remote: true, osc52_support: "supported" }),
    configurable: true,
  });
  screen.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text);
    return true;
  };
  try {
    await frame(screen, "started");
    await frame(screen, "Esc interrupt");
    await focusMessage(screen);
    await screen.mockInput.typeText("unsent draft");
    const input = screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable;
    screen.mockInput.pressKey("c", { ctrl: true });
    await screen.renderOnce();
    expect(input.plainText).toBe("");
    expect(exits).toBe(0);
    await screen.mockInput.typeText("preserve this draft");
    await navigate(screen);
    await new Promise((r) => setTimeout(r, 60));
    await screen.renderOnce();
    const lines = screen.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("started")),
      x = lines[y]?.indexOf("started") ?? -1;
    expect(x).toBeGreaterThan(0);
    await screen.mockMouse.drag(x, y, x + 6, y);
    await waitFor(() => copied.includes("started"));
    const before = copied.length;
    screen.mockInput.pressKey("c", { ctrl: true });
    await waitFor(() => copied.length > before);
    expect(copied.at(-1)).toBe("started");
    expect(screen.renderer.getSelection()).toBeNull();
    expect(input.plainText).toBe("preserve this draft");
    expect(exits).toBe(0);
    screen.mockInput.pressKey("c", { ctrl: true });
    expect(input.plainText).toBe("");
    expect(exits).toBe(0);
    screen.mockInput.pressKey("c", { ctrl: true });
    await waitFor(() => exits === 1);
    expect((await api<{ endedAt: number | null }>(`/v1/turns/${turn.id}`)).endedAt).toBeNull();
    const events = (
      await api<{ events: ConversationEvent[] }>(`/v1/conversations/${c.id}/events?limit=1000`)
    ).events;
    expect(events.some((e) => (e.raw as { method?: string })?.method === "session/cancel")).toBe(
      false,
    );
    expect((await api<{ text: string }>(`/v1/conversations/${c.id}/draft`)).text).toBe("");
  } finally {
    await screen.dispose();
    await api(`/v1/turns/${turn.id}/cancel`, "POST");
    await waitFor(
      async () => (await api<{ endedAt: number | null }>(`/v1/turns/${turn.id}`)).endedAt !== null,
    );
    await api(`/v1/conversations/${c.id}/session/stop`, "POST", {});
  }
}, 20000);

test("mouse release copies multiline chat and code; double click selects a word and triple click selects a line", async () => {
  const { c } = await setup("Selection gestures");
  const message = "alpha beta gamma\nsecond line exact\n\n```ts\n  codeIndent();\n```";
  const turn = await api<{ id: string }>(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "mock",
    message,
  });
  await waitFor(
    async () => (await api<{ endedAt: number | null }>(`/v1/turns/${turn.id}`)).endedAt !== null,
  );
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 40 });
  const copied: string[] = [];
  Object.defineProperty(screen.renderer, "capabilities", {
    get: () => ({ remote: true, osc52_support: "supported" }),
    configurable: true,
  });
  screen.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text);
    return true;
  };
  try {
    await frame(screen, "Esc interrupt");
    const scroll = screen.renderer.root.findDescendantById("native-history") as ScrollBoxRenderable;
    scroll.scrollTo(0);
    await frame(screen, "alpha beta gamma");
    const locate = (text: string) => {
      const lines = screen.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes(text));
      return { x: lines[y]?.indexOf(text) ?? -1, y };
    };
    const first = locate("alpha beta gamma"),
      second = locate("second line exact");
    await screen.mockMouse.doubleClick(first.x + 7, first.y);
    await waitFor(() => copied.at(-1) === "beta");
    await screen.mockMouse.click(first.x + 7, first.y);
    await waitFor(() => copied.at(-1)?.includes("alpha beta gamma") ?? false);
    expect(screen.renderer.getSelection()?.behavior).toBe("line");
    screen.renderer.clearSelection();
    await screen.mockMouse.drag(first.x, first.y, second.x + 16, second.y);
    await waitFor(() => copied.at(-1)?.includes("second line exact") ?? false);
    expect(copied.at(-1)).toContain("alpha beta gamma\nsecond line exact");
    screen.renderer.clearSelection();
    const code = locate("  codeIndent();");
    await screen.mockMouse.drag(code.x, code.y, code.x + 14, code.y);
    await waitFor(() => copied.at(-1)?.includes("codeIndent();") ?? false);
    expect(copied.at(-1)).toContain("  codeIndent();");
    screen.renderer.clearSelection();
    screen.mockInput.pressEscape();
    await screen.renderOnce();
    await waitFor(
      () =>
        !(screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable).focused,
    );
    await selectLastRow(screen);
    screen.mockInput.pressEnter();
    await screen.renderOnce();
    scroll.scrollTo(Infinity);
    await frame(screen, "Show less");
    await clickControl(screen, "transcript-source");
    await frame(screen, "output\\n");
    const output = locate("output\\n");
    expect(output.x).toBeGreaterThan(0);
    await screen.mockMouse.drag(output.x, output.y, output.x + 5, output.y);
    await waitFor(() => copied.at(-1) === "output");
  } finally {
    await screen.dispose();
    await api(`/v1/conversations/${c.id}/session/stop`, "POST", {});
  }
}, 20000);

async function command(screen: Awaited<ReturnType<typeof testRender>>, query: string) {
  await openCommands(screen);
  await frame(screen, "Command palette");
  await screen.mockInput.typeText(query);
  screen.mockInput.pressEnter();
  await screen.renderOnce();
}

test("archive, restore, Raw Events and delete confirmation synchronize between two TUI clients", async () => {
  const { c } = await setup("Lifecycle UI");
  await api(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId: "mock" });
  const one = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  const two = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  try {
    await frame(one, "Esc interrupt");
    await frame(two, "Esc interrupt");
    await command(one, "Raw Events");
    await frame(one, "Raw Events #");
    expect(one.captureCharFrame()).toContain('"raw"');
    one.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    await one.renderOnce();
    await command(one, "Archive Conversation");
    await waitFor(async () => !!(await api<Conversation>(`/v1/conversations/${c.id}`)).archivedAt);
    await frame(two, "/new creates a conversation");
    expect(two.captureCharFrame()).not.toContain("└ Lifecycle UI");
    await command(one, "View Archived");
    await frame(one, "Archives visible");
    await command(one, "Conversation · Lifecycle UI");
    await frame(one, "[archived]");
    await frame(one, "Esc interrupt");
    await command(one, "Restore Archived");
    await waitFor(
      async () => (await api<Conversation>(`/v1/conversations/${c.id}`)).archivedAt === null,
    );
    await command(one, "Hide Archived");
    await command(one, "Conversation · Lifecycle UI");
    await command(two, "Conversation · Lifecycle UI");
    await frame(two, "Conversation · Lifecycle UI");
    await command(one, "Delete Conversation");
    await frame(one, "Confirm Conversation deletion");
    one.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    await one.renderOnce();
    expect((await api<Conversation>(`/v1/conversations/${c.id}`)).id).toBe(c.id);
    await command(one, "Delete Conversation");
    await frame(one, "This cannot be undone");
    one.mockInput.pressTab();
    one.mockInput.pressEnter();
    await waitFor(
      async () =>
        !(await api<{ conversations: Conversation[] }>("/v1/snapshot")).conversations.some(
          (v) => v.id === c.id,
        ),
    );
    await frame(two, "/new creates a conversation");
    expect(two.captureCharFrame()).not.toContain("└ Lifecycle UI");
  } finally {
    await one.dispose();
    await two.dispose();
  }
}, 20000);

test("two Delete presses confirm Conversation and Project deletion", async () => {
  for (const kind of ["Conversation", "Project"] as const) {
    const { p, c, root } = await setup(`Double Delete ${kind}`);
    const screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
    try {
      await frame(screen, "Esc interrupt");
      if (kind === "Project") {
        screen.mockInput.pressArrow("up");
        await frame(screen, "/new creates a conversation");
      }
      await invoke(screen, `Delete ${kind}`);
      await frame(screen, `Confirm ${kind} deletion`);
      await frame(screen, "Delete to delete");
      expect((await api<{ id: string }>(`/v1/projects/${p.id}`)).id).toBe(p.id);
      expect((await api<Conversation>(`/v1/conversations/${c.id}`)).id).toBe(c.id);
      screen.mockInput.pressKey("DELETE");
      await waitFor(async () => {
        const snapshot = await api<{
          projects: { id: string }[];
          conversations: Conversation[];
        }>("/v1/snapshot");
        return (
          !snapshot.conversations.some((v) => v.id === c.id) &&
          snapshot.projects.some((v) => v.id === p.id) === (kind === "Conversation")
        );
      }, `${kind} removed after second Delete`);
      expect(spawnSync("test", ["-d", root]).status).toBe(0);
    } finally {
      await screen.dispose();
    }
  }
}, 20000);

test("compact layout gives transcript most rows; input grows and narrow sidebar collapses", async () => {
  await setup("Layout refinement");
  const screen = await testRender(() => <App onExit={() => {}} />, {
    width: 120,
    height: 30,
    kittyKeyboard: true,
  });
  try {
    await frame(screen, "Esc interrupt");
    const history = screen.renderer.root.findDescendantById(
      "native-history",
    ) as ScrollBoxRenderable;
    const input = screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable;
    expect(history.height).toBeGreaterThanOrEqual(20);
    expect(input.height).toBe(1);
    await focusMessage(screen);
    await screen.mockInput.typeText("one");
    screen.mockInput.pressEnter({ shift: true });
    await screen.mockInput.typeText("two");
    screen.mockInput.pressEnter({ shift: true });
    await screen.mockInput.typeText("three");
    await screen.renderOnce();
    expect(input.height).toBe(3);
    screen.resize(70, 24);
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("Projects → Conversations");
    expect(input.plainText).toBe("one\ntwo\nthree");
    screen.resize(120, 30);
    await frame(screen, "Projects → Conversations");
  } finally {
    await screen.dispose();
  }
});

test("action menu archives without confirmation, archive view isolates history, project deletion offers Cancel and Delete", async () => {
  const { p, c, root } = await setup("Delete project UI");
  const archived = await api<Conversation>(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "Previously archived",
  });
  await api(`/v1/conversations/${archived.id}`, "PATCH", { archived: true });
  const one = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  const two = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  try {
    await frame(one, "Esc interrupt");
    await frame(two, "Esc interrupt");
    await invoke(one, "Delete Conversation");
    await frame(one, "Confirm Conversation deletion");
    one.mockInput.pressEnter(); // Cancel is selected initially.
    await frame(one, "Esc interrupt");
    expect((await api<Conversation>(`/v1/conversations/${c.id}`)).id).toBe(c.id);
    await invoke(one, "Project and Conversation Actions");
    await frame(one, "Conversation / Project actions");
    await one.mockInput.typeText("Archive Conversation");
    one.mockInput.pressEnter();
    await waitFor(
      async () => !!(await api<Conversation>(`/v1/conversations/${c.id}`)).archivedAt,
      "archive from action menu",
    );
    await frame(two, "/new creates a conversation");
    expect(two.captureCharFrame()).not.toContain("Previously archived");
    await command(one, "View Archived");
    await frame(one, "Previously archived");
    await command(one, "Conversation · Delete project UI / Delete project UI");
    await command(one, "Restore Archived Conversation");
    await waitFor(
      async () => (await api<Conversation>(`/v1/conversations/${c.id}`)).archivedAt === null,
    );
    await frame(one, "/new creates a conversation");
    expect(one.captureCharFrame()).not.toContain("Delete project UI [archived]");
    await frame(one, "Previously archived");
    await command(one, "Delete Project");
    await frame(one, "Confirm Project deletion");
    await frame(one, "all 2 Conversations (including archived)");
    await one.renderOnce();
    const cancelButton = one.renderer.root.findDescendantById("delete-cancel");
    if (!cancelButton) throw new Error("Missing Cancel button");
    await one.mockMouse.click(cancelButton.x + 2, cancelButton.y);
    expect((await api<{ id: string }>(`/v1/projects/${p.id}`)).id).toBe(p.id);
    await invoke(one, "Delete Project");
    await frame(one, "Confirm Project deletion");
    await one.renderOnce();
    const deleteButton = one.renderer.root.findDescendantById("delete-confirm");
    if (!deleteButton) throw new Error("Missing Delete button");
    await one.mockMouse.click(deleteButton.x + 2, deleteButton.y);
    await waitFor(
      async () =>
        !(await api<{ projects: { id: string }[] }>("/v1/snapshot")).projects.some(
          (v) => v.id === p.id,
        ),
      "project removed after mouse confirmation",
    ).catch((error) => {
      console.error(one.captureCharFrame());
      throw error;
    });
    await waitFor(async () => {
      await two.renderOnce();
      return !two.captureCharFrame().includes("Delete project UI");
    }, "other TUI removed deleted project");
    expect(
      (await api<{ conversations: Conversation[] }>("/v1/snapshot")).conversations.some(
        (v) => v.projectId === p.id,
      ),
    ).toBe(false);
    expect(spawnSync("test", ["-d", root]).status).toBe(0);
  } finally {
    await one.dispose();
    await two.dispose();
  }
}, 20000);

test("a deleted Conversation retires another client's dirty draft saver without blocking remaining drafts", async () => {
  const { DraftSession, flushDrafts } = await import("../../apps/tui/src/draft-session");
  const { c } = await setup("Deleted draft saver");
  const draft = new DraftSession(
    c.id,
    () => {},
    () => {},
  );
  await draft.load();
  draft.update("unsaved in a second client");
  await api(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
  await draft.flush();
  await draft.dispose();
  await flushDrafts();
  expect(
    (await api<{ conversations: Conversation[] }>("/v1/snapshot")).conversations.some(
      (v) => v.id === c.id,
    ),
  ).toBe(false);
});

test("clearing an unconfirmed draft persists empty input while retaining the reserved requestId", async () => {
  const { DraftSession } = await import("../../apps/tui/src/draft-session");
  const { c } = await setup("Clear reserved draft");
  const first = new DraftSession(
    c.id,
    () => {},
    () => {},
  );
  await first.load();
  first.update("original uncertain message");
  const reserved = await first.prepare("mock");
  first.update("");
  await first.flush();
  await first.dispose();
  const second = new DraftSession(
    c.id,
    () => {},
    () => {},
  );
  await second.load();
  try {
    expect(second.text).toBe("");
    expect(second.value.pendingSubmission?.requestId).toBe(reserved.requestId);
    expect((await api<{ events: unknown[] }>(`/v1/conversations/${c.id}/events`)).events).toEqual(
      [],
    );
    second.update(reserved.message);
    expect((await second.prepare("mock")).requestId).toBe(reserved.requestId);
  } finally {
    await second.dispose();
  }
});

test("semantic projection classifies chat, activity, actions, notices, diagnostics and unknown extensions", () => {
  const cases = [
    [event(1, "user.message", { text: "hello" }), "CHAT_CONTENT", true],
    [textEvent(1, "Hello"), "CHAT_CONTENT", true],
    [textEvent(1, "Thinking", "agent_thought_chunk"), "AGENT_ACTIVITY", true],
    [event(1, "tool_call", { toolCallId: "t" }), "AGENT_ACTIVITY", true],
    [event(1, "tool_call_update", { toolCallId: "t", status: "failed" }), "AGENT_ACTIVITY", true],
    [event(1, "plan", { entries: [] }), "AGENT_ACTIVITY", true],
    [event(1, "approval.requested", { request: { options: [] } }), "USER_ACTION_REQUIRED", true],
    [event(1, "handoff.record", { status: "FAILED" }), "USER_ACTION_REQUIRED", true],
    [event(1, "runtime.context_ended", {}), "USER_NOTICE", true],
    [event(1, "runtime.worker_lost", {}), "USER_NOTICE", true],
    [event(1, "runtime.interrupted", { state: "UNCERTAIN" }), "USER_NOTICE", true],
    [event(1, "runtime.turn_finished", { state: "UNCERTAIN" }), "USER_NOTICE", true],
    [event(1, "runtime.session_error", { reason: "Actual native failure" }), "USER_NOTICE", true],
    [
      {
        ...event(1, "custom", { reason: "Native extension failure" }),
        raw: { method: "_auth/error" },
      },
      "USER_NOTICE",
      true,
    ],
    [event(1, "runtime.warning", { message: "Important runtime warning" }), "USER_NOTICE", true],
    [event(1, "custom", { error: { message: "Actual extension error" } }), "USER_NOTICE", true],
    [
      event(1, "custom", { error: { detail: "Opaque native failure" }, authStatus: {} }),
      "USER_NOTICE",
      true,
    ],
    [
      event(1, "future_warning", { severity: "warning", message: "Important warning" }),
      "USER_NOTICE",
      true,
    ],
    [
      event(1, "runtime.worker_started", {
        workerPid: 42,
        processGroupId: 42,
        epoch: "e",
        harnessId: "codex",
        cwd: "/project",
      }),
      "INTERNAL_DIAGNOSTIC",
      false,
    ],
    [
      event(1, "custom", {
        authStatus: { kind: "gateway", label: "Custom model gateway", detail: "codeforce" },
      }),
      "INTERNAL_DIAGNOSTIC",
      false,
    ],
    [
      event(1, "custom", { configOptions: [], text: "Configuration metadata" }),
      "INTERNAL_DIAGNOSTIC",
      false,
    ],
    [
      event(1, "custom", { capabilities: {}, message: "Capability metadata" }),
      "INTERNAL_DIAGNOSTIC",
      false,
    ],
    [
      event(1, "custom", { sessionUpdate: "model_gateway", text: "Gateway metadata" }),
      "INTERNAL_DIAGNOSTIC",
      false,
    ],
    ...[
      "initialize",
      "initialized",
      "acp.response",
      "session/new",
      "session/load",
      "session/prompt",
      "session/cancel",
      "session/set_config_option",
      "runtime.session_ready",
      "runtime.turn_finished",
      "config_option_update",
      "usage_update",
    ].map(
      (kind) =>
        [event(1, kind, { message: "Control metadata" }), "INTERNAL_DIAGNOSTIC", false] as const,
    ),
    [
      event(1, "future_extension", { content: { type: "text", text: "Public extension text" } }),
      "UNKNOWN_EXTENSION",
      true,
    ],
    [
      event(1, "custom", { label: "Metadata label", detail: "metadata", workerPid: 42 }),
      "UNKNOWN_EXTENSION",
      false,
    ],
    [
      event(1, "future_extension", {
        revision: 1,
        nested: { text: "Not explicit public content" },
      }),
      "UNKNOWN_EXTENSION",
      false,
    ],
  ] as const;
  expect(
    projectEvent({
      ...event(1, "custom", { reason: "Native extension failure" }),
      raw: { method: "_auth/error" },
    }).text,
  ).toBe("Native extension failure");
  for (const [source, category, visible] of cases) {
    expect(projectEvent(source).category).toBe(category);
    expect(chatVisible(source)).toBe(visible);
  }
});

test("diagnostic floods and legacy history replay produce the same clean chat without changing sources", () => {
  const diagnostics = Array.from({ length: 10000 }, (_, i) =>
    event(
      i + 1,
      i % 2 ? "custom" : "runtime.worker_started",
      i % 2
        ? { authStatus: { kind: "gateway", label: "Custom model gateway", detail: "codeforce" } }
        : { workerPid: i, processGroupId: i, epoch: "epoch", harnessId: "codex", cwd: "/project" },
    ),
  );
  const events = [
    ...diagnostics,
    messageEvent(10001, "hello"),
    textEvent(10002, "Hello!"),
    event(10003, "runtime.turn_finished", { state: "COMPLETED" }),
  ];
  const original = JSON.stringify(events);
  const live = new Transcript();
  live.append(diagnostics);
  expect(live.rows).toHaveLength(0);
  live.append(events.slice(10000));
  const history = new Transcript();
  history.append(JSON.parse(original) as ConversationEvent[]);
  expect(live.rows.map((row) => row.value())).toEqual(history.rows.map((row) => row.value()));
  expect(history.rows.map((row) => row.value().text)).toEqual(["hello", "Hello!"]);
  expect(history.rows[1]?.value().streaming).toBe(false);
  expect(history.events).toEqual(events);
  expect(live.events).toEqual(events);
  expect(JSON.stringify(events)).toBe(original);
});

test("public thinking, plans, tools, permission options and context/error notices render without metadata JSON", async () => {
  const model = new Transcript();
  model.append([
    textEvent(1, "Public thinking content", "agent_thought_chunk"),
    event(2, "plan", {
      entries: [{ content: "Public plan content", status: "pending", priority: "high" }],
    }),
    event(3, "tool_call", {
      toolCallId: "t",
      title: "Native.exec",
      status: "in_progress",
      rawInput: { command: "pwd" },
    }),
    event(4, "approval.requested", {
      id: "a",
      request: {
        toolCall: { toolCallId: "t" },
        options: [{ optionId: "deny", name: "Deny exact native option", kind: "reject_once" }],
      },
    }),
    event(5, "runtime.context_ended", {
      message: "Native context ended. Next message starts fresh.",
      nativeSessionRecovered: false,
    }),
    event(6, "runtime.session_error", { reason: "NATIVE_PREPARATION_FAILURE", stderrBytes: 42 }),
    {
      ...event(7, "acp.response", {}),
      raw: {
        id: 8,
        error: {
          code: -9,
          message: "NATIVE_PROTOCOL_FAILURE",
          data: { source: "FULL_ERROR_SOURCE" },
        },
      },
    },
  ]);
  const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
    width: 150,
    height: 50,
  });
  try {
    await frame(screen, "NATIVE_PROTOCOL_FAILURE");
    await frame(screen, "Public thinking content");
    await frame(screen, "Public plan content");
    for (const text of [
      "Public thinking content",
      "Public plan content",
      "Native.exec",
      "WAITING_APPROVAL",
      "Deny exact native option",
      "Native context ended",
      "NATIVE_PREPARATION_FAILURE",
    ])
      expect(screen.captureCharFrame()).toContain(text);
    expect(screen.captureCharFrame()).not.toContain('"stderrBytes"');
    expect(screen.captureCharFrame()).not.toContain('"nativeSessionRecovered"');
    for (let i = 0; i < model.rows.length - 1; i++) screen.mockInput.pressArrow("down");
    await clickControl(screen, "transcript-raw");
    await frame(screen, "FULL_ERROR_SOURCE");
    expect(screen.captureCharFrame()).toContain('"code": -9');
    model.append([event(8, "approval.decided", { approvalId: "a", optionId: "deny" })]);
    expect(model.tools.get("native:t")?.value().waiting).toBe(false);
    expect(model.rows).toHaveLength(7);
  } finally {
    await screen.dispose();
  }
}, 10000);

test("unknown visible text is concise by default, expandable, and linked to its full source", async () => {
  const model = new Transcript();
  const text = `PUBLIC_EXTENSION ${"native text ".repeat(30)}EXPANDED_EXTENSION_END`;
  model.append([
    event(1, "future_extension", {
      content: { type: "text", text },
      extra: "SOURCE_ONLY_METADATA",
    }),
  ]);
  const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
    width: 140,
    height: 35,
  });
  try {
    await frame(screen, "PUBLIC_EXTENSION");
    expect(screen.captureCharFrame()).not.toContain("EXPANDED_EXTENSION_END");
    expect(screen.captureCharFrame()).not.toContain("SOURCE_ONLY_METADATA");
    screen.mockInput.pressEnter();
    await frame(screen, "EXPANDED_EXTENSION_END");
    await clickControl(screen, "transcript-raw");
    await frame(screen, "SOURCE_ONLY_METADATA");
    expect(screen.captureCharFrame()).toContain('"eventId": "event-1"');
    const row = model.rows[0];
    if (!row) throw new Error("Missing extension notice");
    expect(model.source(row)).toBe(text);
  } finally {
    await screen.dispose();
  }
});

test("Raw Events Debug retains and copies full worker and authStatus sources hidden from chat", async () => {
  const model = new Transcript();
  const sources = [
    event(1, "runtime.worker_started", {
      workerPid: 1234,
      processGroupId: 1234,
      epoch: "epoch-original",
      harnessId: "codex",
      cwd: "/project",
    }),
    event(2, "custom", {
      authStatus: { kind: "gateway", label: "Custom model gateway", detail: "codeforce" },
    }),
  ];
  model.append(sources);
  expect(model.rows).toHaveLength(0);
  const screen = await testRender(
    () => <RawEvents events={model.events} count={model.eventCount()} onClose={() => {}} />,
    { width: 150, height: 50 },
  );
  const copied: string[] = [];
  Object.defineProperty(screen.renderer, "capabilities", {
    get: () => ({ remote: true, osc52_support: "supported" }),
    configurable: true,
  });
  screen.renderer.copyToClipboardOSC52 = (value) => {
    copied.push(value);
    return true;
  };
  try {
    await frame(screen, '"workerPid": 1234');
    screen.mockInput.pressEnter();
    await waitFor(() => copied.length === 1);
    expect(JSON.parse(copied[0] ?? "null")).toEqual(sources[0]);
    screen.mockInput.pressArrow("down");
    await frame(screen, '"authStatus"');
    screen.mockInput.pressEnter();
    await waitFor(() => copied.length === 2);
    expect(JSON.parse(copied[1] ?? "null")).toEqual(sources[1]);
    expect(screen.captureCharFrame()).toContain("Custom model gateway");
    expect(screen.captureCharFrame()).toContain("codeforce");
  } finally {
    await screen.dispose();
  }
});

test("new Conversation stays empty after worker/auth startup, shows hello and reloads clean persisted history", async () => {
  await api("/v1/harness-profiles", "POST", {
    id: "projection-mock",
    name: "Codex diagnostic reproduction",
    command: "node",
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: { HHU_MOCK_CHAT_DIAGNOSTICS: "1" },
  });
  const { c } = await setup("Clean new chat");
  let screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 45 });
  try {
    await frame(screen, "Start a conversation");
    await api(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId: "projection-mock" });
    await frame(screen, "Model (ACP) · mock-model");
    expect(screen.captureCharFrame()).toContain("Start a conversation");
    expect(screen.captureCharFrame()).toContain("0 items");
    await focusMessage(screen);
    await frame(screen, "Esc navigate");
    await screen.mockInput.typeText("hello");
    screen.mockInput.pressEnter();
    await frame(screen, "Hello from Agent.");
    expect(screen.captureCharFrame()).toContain("2 items");
    const stored = (
      await api<{ events: ConversationEvent[] }>(`/v1/conversations/${c.id}/events?limit=1000`)
    ).events;
    expect(stored.some((e) => e.kind === "runtime.worker_started")).toBe(true);
    const auth = stored.find(
      (e) => e.kind === "custom" && (e.payload as { authStatus?: unknown }).authStatus,
    );
    expect(auth?.payload).toEqual({
      authStatus: { kind: "gateway", label: "Custom model gateway", detail: "codeforce" },
    });
    if (!auth) throw new Error("Missing persisted authStatus");
    expect((auth.raw as { params: unknown }).params).toEqual(auth.payload);
    await screen.dispose();
    screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 45 });
    await frame(screen, "Hello from Agent.");
    expect(screen.captureCharFrame()).toContain("2 items");
    for (const marker of [
      "runtime.worker_started",
      "workerPid",
      "processGroupId",
      "authStatus",
      "Custom model gateway",
      "codeforce",
    ])
      expect(screen.captureCharFrame()).not.toContain(marker);
    expect(
      (await api<{ events: ConversationEvent[] }>(`/v1/conversations/${c.id}/events?limit=1000`))
        .events,
    ).toEqual(stored);
  } finally {
    await screen.dispose();
    await api(`/v1/conversations/${c.id}/session/stop`, "POST", {});
  }
}, 15000);

test("diagnostic-only chat has a clean empty state and a concise running indicator", async () => {
  const model = new Transcript();
  model.append([
    event(1, "runtime.worker_started", { workerPid: 42 }),
    event(2, "custom", { capabilities: {} }),
  ]);
  const screen = await testRender(() => <NativeEvents model={model} running disabled={false} />, {
    width: 120,
    height: 30,
  });
  try {
    await frame(screen, "Agent is working");
    expect(screen.captureCharFrame()).toContain("Start a conversation");
    expect(screen.captureCharFrame()).toContain("0 items");
    expect(screen.captureCharFrame()).not.toContain("workerPid");
    expect(screen.renderer.root.findDescendantById("native-history")?.getChildrenCount()).toBe(1);
  } finally {
    await screen.dispose();
  }
});
