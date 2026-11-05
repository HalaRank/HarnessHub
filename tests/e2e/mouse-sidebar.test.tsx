import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type BoxRenderable,
  type InputRenderable,
  RGBA,
  type ScrollBoxRenderable,
  TextAttributes,
  type TextareaRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { App } from "../../apps/tui/src/index";
import { ProjectDirectory } from "../../apps/tui/src/project-directory";
import { conversationKey, projectKey } from "../../apps/tui/src/project-tree";
import { connect } from "../../packages/shared/src/client";
import type { Conversation, Project } from "../../packages/shared/src/index";
import { focusMessage, invoke, openCommands, selectLastRow } from "./ui-actions";

const temp = mkdtempSync(join(tmpdir(), "hhu-mouse-sidebar-"));
const previous = { ...process.env };
const cli = resolve("dist/cli/hhu.js");
type Screen = Awaited<ReturnType<typeof testRender>>;
beforeAll(async () => {
  Object.assign(process.env, {
    XDG_CONFIG_HOME: join(temp, "config"),
    XDG_DATA_HOME: join(temp, "data"),
    XDG_STATE_HOME: join(temp, "state"),
  });
  expect(spawnSync(process.execPath, [cli, "daemon", "start"]).status).toBe(0);
  await api("/v1/harness-profiles", "POST", {
    id: "mock",
    name: "Mouse Mock",
    command: "node",
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
  });
});
afterAll(() => {
  spawnSync(process.execPath, [cli, "daemon", "stop", "--cancel-active"]);
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  console.log(`Mouse sidebar evidence: ${temp}`);
});
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const client = await connect();
  if (!client) throw new Error("No test Daemon");
  return client.request<T>(path, method, body);
}
async function waitFor(check: () => boolean | Promise<boolean>, label = "state") {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
async function frame(screen: Screen, text: string) {
  try {
    await waitFor(async () => {
      await screen.renderOnce();
      return screen.captureCharFrame().includes(text);
    }, text);
  } catch (error) {
    console.error(screen.captureCharFrame());
    throw error;
  }
}
function node(screen: Screen, id: string) {
  const result = screen.renderer.root.findDescendantById(id);
  if (!result) {
    console.error(screen.captureCharFrame());
    throw new Error(`Missing ${id}`);
  }
  return result;
}
async function point(screen: Screen, id: string, inset = 0) {
  const tree = screen.renderer.root.findDescendantById("project-tree") as ScrollBoxRenderable;
  if (tree?.findDescendantById(id)) tree.scrollChildIntoView(id);
  await screen.renderOnce();
  await screen.renderOnce();
  const target = node(screen, id);
  return { x: target.x + inset, y: target.y };
}
async function click(screen: Screen, id: string, inset = 0) {
  const p = await point(screen, id, inset);
  await screen.mockMouse.click(p.x, p.y);
  await screen.renderOnce();
}
async function setup(name: string, count = 2) {
  const root = join(temp, name);
  mkdirSync(root);
  const project = await api<Project>("/v1/projects", "POST", { rootPath: root, name });
  const conversations: Conversation[] = [];
  for (let i = 0; i < count; i++)
    conversations.push(
      await api<Conversation>(`/v1/projects/${project.id}/conversations`, "POST", {
        title: `${name}-${i}`,
      }),
    );
  await api("/v1/preferences", "PATCH", {
    lastProjectId: project.id,
    lastConversationId: conversations[0]?.id ?? null,
    showSidebar: true,
    shortcuts: {},
  });
  const [a, b] = conversations;
  if (!a || !b) throw new Error("Expected two conversations");
  return { project, conversations, a, b };
}
async function command(screen: Screen, text: string) {
  await openCommands(screen);
  await frame(screen, "Command palette");
  await screen.mockInput.typeText(text);
  screen.mockInput.pressEnter();
  await screen.renderOnce();
}
async function current(screen: Screen, conversation: Conversation) {
  await frame(screen, `Conversation · ${conversation.title}`);
  await frame(screen, "Model (ACP)");
  await waitFor(async () => {
    await screen.renderOnce();
    return (
      !!screen.renderer.root.findDescendantById("message-draft") &&
      !screen.captureCharFrame().includes("ACP operation pending")
    );
  }, "draft ready");
}

test("sidebar spacing preserves names and keeps project headings more prominent", async () => {
  const { project, a, b } = await setup("列表 Spacing");
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  try {
    await current(screen, a);
    for (const width of [150, 100]) {
      screen.resize(width, 35);
      await screen.renderOnce();
      const heading = node(screen, projectKey(project.id));
      const first = node(screen, conversationKey(a.id));
      const second = node(screen, conversationKey(b.id));
      expect(heading.height).toBe(3);
      expect(first.height).toBe(2);
      expect(second.height).toBe(2);
      expect(first.y).toBe(heading.y + heading.height);
      expect(second.y).toBe(first.y + first.height);
      const lines = screen.captureSpans().lines;
      const projectLine = lines[heading.y + 1];
      const conversationLine = lines[first.y + 1];
      expect(projectLine?.spans.map((span) => span.text).join("")).toContain(project.name);
      expect(conversationLine?.spans.map((span) => span.text).join("")).toContain(a.title);
      const projectSpans = projectLine?.spans.filter((span) =>
        span.fg.equals(RGBA.fromHex("#b2dfdb")),
      );
      const conversationSpans = conversationLine?.spans.filter((span) =>
        span.fg.equals(RGBA.fromHex("#edf2f7")),
      );
      expect(projectSpans?.length).toBeGreaterThan(0);
      expect(conversationSpans?.length).toBeGreaterThan(0);
      expect(projectSpans?.every((span) => (span.attributes & TextAttributes.BOLD) !== 0)).toBe(
        true,
      );
      expect(
        conversationSpans?.every((span) => (span.attributes & TextAttributes.BOLD) === 0),
      ).toBe(true);
      const arrow = node(screen, `arrow-${project.id}`);
      const actions = node(screen, `actions-${a.id}`);
      expect(arrow.y).toBe(heading.y + 1);
      expect(arrow.x).toBe(heading.x + 1);
      expect(actions.y).toBe(first.y + 1);
      expect(actions.x + actions.width).toBe(first.x + first.width - 1);
    }
    await click(screen, conversationKey(b.id), 5);
    await current(screen, b);
    await click(screen, `arrow-${project.id}`);
    expect(screen.renderer.root.findDescendantById(conversationKey(a.id))).toBeFalsy();
    await click(screen, `arrow-${project.id}`);
    expect(screen.renderer.root.findDescendantById(conversationKey(a.id))).toBeTruthy();
  } finally {
    await screen.dispose();
  }
});

test("project arrows collapse independently; names expand/select; hover, selected highlight and keyboard/palette work", async () => {
  const one = await setup("Tree-one"),
    two = await setup("Tree-two");
  mkdirSync(join(one.project.rootPath, "src"));
  writeFileSync(join(one.project.rootPath, "src", "index.ts"), "sentinel");
  writeFileSync(join(one.project.rootPath, "README.md"), "sentinel");
  symlinkSync(one.project.rootPath, join(one.project.rootPath, "self-link"));
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  try {
    await current(screen, two.a);
    await click(screen, `arrow-${one.project.id}`);
    expect(screen.renderer.root.findDescendantById(conversationKey(one.a.id))).toBeFalsy();
    expect(screen.renderer.root.findDescendantById(conversationKey(two.a.id))).toBeTruthy();
    await click(screen, `arrow-${two.project.id}`);
    expect(screen.renderer.root.findDescendantById(conversationKey(two.a.id))).toBeFalsy();
    // Collapsing the active project's children does not leave the conversation.
    await current(screen, two.a);
    await click(screen, projectKey(one.project.id), 4);
    await frame(screen, `Workspace · ${one.project.rootPath}`);
    expect(screen.renderer.root.findDescendantById(conversationKey(one.a.id))).toBeTruthy();
    expect(screen.renderer.root.findDescendantById(conversationKey(two.a.id))).toBeFalsy();
    await frame(screen, "Project directory");
    await frame(screen, "README.md");
    await frame(screen, "self-link @");
    await click(screen, "directory-src", 1);
    await frame(screen, "index.ts");
    await click(screen, "directory-src", 1);
    expect(screen.renderer.root.findDescendantById("directory-src/index.ts")).toBeFalsy();
    await click(screen, projectKey(one.project.id), 4);
    expect(screen.renderer.root.findDescendantById(conversationKey(one.a.id))).toBeFalsy();
    await frame(screen, "Project directory");
    await click(screen, projectKey(one.project.id), 4);
    expect(screen.renderer.root.findDescendantById(conversationKey(one.a.id))).toBeTruthy();
    await click(screen, conversationKey(one.a.id), 5);
    await current(screen, one.a);
    const selected = node(screen, conversationKey(one.a.id)) as BoxRenderable;
    expect(selected.backgroundColor.equals(RGBA.fromHex("#294456"))).toBe(true);
    const p = await point(screen, conversationKey(one.b.id), 5);
    await screen.mockMouse.moveTo(p.x, p.y);
    await screen.renderOnce();
    expect(
      (node(screen, conversationKey(one.b.id)) as BoxRenderable).backgroundColor.equals(
        RGBA.fromHex("#233342"),
      ),
    ).toBe(true);
    expect(selected.backgroundColor.equals(RGBA.fromHex("#294456"))).toBe(true);
    await screen.mockMouse.moveTo(100, 0);
    await screen.renderOnce();
    expect((node(screen, conversationKey(one.b.id)) as BoxRenderable).backgroundColor.a).toBe(0);
    screen.mockInput.pressArrow("down");
    await current(screen, one.b);
    await command(screen, `Conversation · ${two.project.name} / ${two.b.title}`);
    await current(screen, two.b);
    expect(screen.renderer.root.findDescendantById(conversationKey(one.a.id))).toBeTruthy();
    screen.resize(72, 30);
    await screen.renderOnce();
    expect(screen.renderer.root.findDescendantById("project-tree")).toBeFalsy();
    await invoke(screen, "Toggle Sidebar");
    await waitFor(async () => {
      await screen.renderOnce();
      return !!screen.renderer.root.findDescendantById("project-tree");
    });
    await click(screen, conversationKey(one.a.id), 5);
    await current(screen, one.a);
    await invoke(screen, "Toggle Sidebar");
    await screen.renderOnce();
    expect(screen.renderer.root.findDescendantById("project-tree")).toBeFalsy();
  } finally {
    await screen.dispose();
  }
}, 20000);

test("large sidebar wheel is isolated from chat, selection and metadata refresh; offscreen rows are clickable", async () => {
  const { a, conversations } = await setup("Wheel", 60);
  const turn = await api<{ id: string }>(`/v1/conversations/${a.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "mock",
    message: Array.from({ length: 80 }, (_, i) => `Wheel line ${i}`).join("\n"),
  });
  await waitFor(
    async () => (await api<{ endedAt: number | null }>(`/v1/turns/${turn.id}`)).endedAt !== null,
  );
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 30 });
  try {
    await current(screen, a);
    await frame(screen, "Exact Native Tool Name");
    await frame(screen, "completed");
    const tree = node(screen, "project-tree") as ScrollBoxRenderable;
    const history = node(screen, "native-history") as ScrollBoxRenderable;
    history.scrollTo(4);
    await screen.renderOnce();
    const position = history.scrollTop;
    const p = await point(screen, conversationKey(a.id), 5);
    const start = tree.scrollTop;
    for (let i = 0; i < 8; i++) await screen.mockMouse.scroll(p.x, p.y, "down");
    await screen.renderOnce();
    expect(tree.scrollTop).toBeGreaterThan(start);
    expect(history.scrollTop).toBe(position);
    await current(screen, a);
    const offset = tree.scrollTop;
    await api(`/v1/conversations/${a.id}`, "PATCH", { title: "Wheel-renamed" });
    await frame(screen, "Conversation · Wheel-renamed");
    expect(tree.scrollTop).toBe(offset);
    const last = conversations[59],
      prior = conversations[58];
    if (!last || !prior) throw new Error("Expected 60 conversations");
    await click(screen, conversationKey(last.id), 5);
    await current(screen, last);
    screen.mockInput.pressArrow("up");
    await current(screen, prior);
  } finally {
    await screen.dispose();
  }
}, 20000);

test("mouse navigation preserves unsent drafts, scroll and manual tools; background Worker keeps its Turn", async () => {
  const { a, b } = await setup("Draft-mouse");
  const turn = await api<{ id: string }>(`/v1/conversations/${a.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "mock",
    message: Array.from({ length: 60 }, (_, i) => `Line ${i}`).join("\n"),
  });
  await waitFor(
    async () => (await api<{ endedAt: number | null }>(`/v1/turns/${turn.id}`)).endedAt !== null,
  );
  const running = await api<{ id: string }>(`/v1/conversations/${b.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "mock",
    message: "wait",
  });
  await waitFor(
    async () =>
      (await api<Conversation>(`/v1/conversations/${b.id}`)).activeNativeSessionId !== null,
  );
  const before = await api<Conversation>(`/v1/conversations/${b.id}`);
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  try {
    await current(screen, a);
    await frame(screen, "Exact Native Tool Name");
    await selectLastRow(screen);
    screen.mockInput.pressEnter();
    await frame(screen, "Show less");
    const history = node(screen, "native-history") as ScrollBoxRenderable;
    history.scrollTo(4);
    await screen.renderOnce();
    const position = history.scrollTop;
    await focusMessage(screen);
    await screen.mockInput.typeText("Alpha unsent\n草稿");
    await click(screen, conversationKey(b.id), 5);
    await current(screen, b);
    await focusMessage(screen);
    await screen.mockInput.typeText("Beta draft");
    await click(screen, conversationKey(a.id), 5);
    await current(screen, a);
    await frame(screen, "Alpha unsent");
    expect((node(screen, "message-draft") as TextareaRenderable).plainText).toBe(
      "Alpha unsent\n草稿",
    );
    expect((node(screen, "native-history") as ScrollBoxRenderable).scrollTop).toBe(position);
    (node(screen, "native-history") as ScrollBoxRenderable).scrollTo(Infinity);
    await frame(screen, "Show less"); // manual expansion survived remount
    await click(screen, conversationKey(b.id), 5);
    await current(screen, b);
    await frame(screen, "Beta draft");
    const after = await api<Conversation>(`/v1/conversations/${b.id}`);
    expect(after.activeNativeSessionId).toBe(before.activeNativeSessionId);
    expect((await api<{ endedAt: number | null }>(`/v1/turns/${running.id}`)).endedAt).toBeFalsy();
    const events = await api<{ events: { kind: string; raw: { method?: string } }[] }>(
      `/v1/conversations/${b.id}/events?limit=1000`,
    );
    expect(events.events.filter((e) => e.kind === "user.message")).toHaveLength(1);
    expect(events.events.some((e) => e.raw?.method === "session/cancel")).toBe(false);
    expect((await api<{ text: string }>(`/v1/conversations/${a.id}/draft`)).text).toBe(
      "Alpha unsent\n草稿",
    );
  } finally {
    await screen.dispose();
    await api(`/v1/turns/${running.id}/cancel`, "POST");
    await waitFor(
      async () =>
        (await api<{ endedAt: number | null }>(`/v1/turns/${running.id}`)).endedAt !== null,
    );
  }
}, 20000);

test("Enter focuses the selected conversation at the draft end without sending it", async () => {
  const { a, b } = await setup("Enter-focus");
  await api(`/v1/conversations/${a.id}/harness`, "PUT", { harnessId: "mock" });
  const screen = await testRender(() => <App onExit={() => {}} />, {
    width: 150,
    height: 35,
    kittyKeyboard: true,
  });
  const editor = () => node(screen, "message-draft") as TextareaRenderable;
  const messages = async () =>
    (
      await api<{ events: { kind: string }[] }>(`/v1/conversations/${a.id}/events?limit=1000`)
    ).events.filter((event) => event.kind === "user.message");
  try {
    await current(screen, a);
    expect(editor().focused).toBe(false);
    screen.mockInput.pressEnter();
    await waitFor(() => editor().focused, "Enter focuses empty editor");
    expect(editor().plainText).toBe("");
    const draft = "First line\n中文 👋 e\u0301";
    editor().insertText(draft);
    editor().gotoBufferHome();
    screen.mockInput.pressEscape();
    await waitFor(() => !editor().focused);
    screen.mockInput.pressEnter();
    await waitFor(() => editor().focused);
    expect(editor().getTextRange(0, editor().cursorOffset)).toBe(draft);
    await screen.mockInput.typeText(" appended");
    expect(editor().plainText).toBe(`${draft} appended`);
    expect(await messages()).toHaveLength(0);

    await click(screen, conversationKey(b.id), 5);
    await current(screen, b);
    await click(screen, conversationKey(a.id), 5);
    await current(screen, a);
    expect(editor().focused).toBe(false);
    screen.mockInput.pressEnter();
    await waitFor(() => editor().focused);
    expect(editor().getTextRange(0, editor().cursorOffset)).toBe(`${draft} appended`);
    expect(await messages()).toHaveLength(0);
    screen.mockInput.pressEnter({ shift: true });
    await screen.mockInput.typeText("last line");
    expect(editor().plainText).toBe(`${draft} appended\nlast line`);
    expect(await messages()).toHaveLength(0);
    screen.mockInput.pressEnter();
    await waitFor(async () => (await messages()).length === 1, "next Enter sends once");
  } finally {
    await screen.dispose();
  }
}, 20000);

test("chat area clicks focus the draft without sending or stealing modal focus", async () => {
  const { a, b } = await setup("Chat-click-focus");
  const turn = await api<{ id: string }>(`/v1/conversations/${a.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "mock",
    message: "click focus history",
  });
  await waitFor(
    async () => (await api<{ endedAt: number | null }>(`/v1/turns/${turn.id}`)).endedAt !== null,
  );
  const screen = await testRender(() => <App onExit={() => {}} />, {
    width: 150,
    height: 40,
    kittyKeyboard: true,
  });
  const editor = () => node(screen, "message-draft") as TextareaRenderable;
  try {
    await current(screen, a);
    await frame(screen, "Exact Native Tool Name");
    const history = node(screen, "native-history") as ScrollBoxRenderable;
    history.scrollTo(0);
    await frame(screen, "click focus history");
    await screen.mockMouse.click(history.x + history.width - 3, history.y + history.height - 2);
    await waitFor(() => editor().focused, "history whitespace focuses draft");
    await screen.mockInput.pressKeys(Array.from("中文 👋 draft"));
    screen.mockInput.pressEscape();
    await waitFor(() => !editor().focused);
    await screen.renderOnce();
    editor().gotoBufferHome();
    history.scrollTo(0);
    await frame(screen, "click focus history");
    const lines = screen.captureCharFrame().split("\n");
    const messageY = lines.findIndex((line) => line.includes("click focus history"));
    const messageX = lines[messageY]?.indexOf("click focus history") ?? -1;
    expect(messageX).toBeGreaterThan(0);
    await screen.mockMouse.click(messageX + 2, messageY);
    await waitFor(() => editor().focused, "user message focuses draft");
    expect(editor().getTextRange(0, editor().cursorOffset)).toBe("中文 👋 draft");
    await screen.mockInput.typeText(" appended");
    await frame(screen, "native-0");
    const agentLines = screen.captureCharFrame().split("\n");
    const agentY = agentLines.findIndex((line) => line.includes("native-0"));
    const agentX = agentLines[agentY]?.indexOf("native-0") ?? -1;
    expect(agentX).toBeGreaterThan(0);
    editor().gotoBufferHome();
    await screen.mockMouse.click(agentX, agentY);
    await screen.renderOnce();
    expect(editor().focused).toBe(true);
    expect(editor().getTextRange(0, editor().cursorOffset)).toBe("中文 👋 draft appended");
    screen.mockInput.pressEscape();
    await waitFor(() => !editor().focused);
    const composer = node(screen, "message-composer");
    await screen.mockMouse.click(composer.x, composer.y);
    await waitFor(() => editor().focused, "input border focuses draft");
    await screen.mockInput.typeText(" border");
    await screen.mockMouse.click(editor().x, editor().y);
    await screen.renderOnce();
    expect(editor().cursorOffset).toBe(0);
    await screen.mockInput.typeText("prefix ");
    expect(editor().plainText).toBe("prefix 中文 👋 draft appended border");

    await openCommands(screen);
    await frame(screen, "Command palette");
    await screen.mockMouse.click(history.x + 3, history.y + 2);
    await screen.renderOnce();
    expect(editor().focused).toBe(false);
    screen.mockInput.pressEscape();
    screen.mockInput.pressEscape();
    await waitFor(() => !editor().focused);
    await screen.mockMouse.click(history.x + 3, history.y + 2, 2);
    await screen.renderOnce();
    expect(editor().focused).toBe(false);
    await screen.mockMouse.scroll(history.x + 3, history.y + 2, "up");
    await screen.renderOnce();
    expect(editor().focused).toBe(false);

    await click(screen, conversationKey(b.id), 5);
    await current(screen, b);
    expect(editor().focused).toBe(false);
    await click(screen, conversationKey(a.id), 5);
    await current(screen, a);
    await frame(screen, "prefix 中文 👋 draft appended border");
    expect(editor().focused).toBe(false);
    const events = await api<{ events: { kind: string }[] }>(
      `/v1/conversations/${a.id}/events?limit=1000`,
    );
    expect(events.events.filter((event) => event.kind === "user.message")).toHaveLength(1);
    await click(screen, "message-composer");
    await waitFor(() => editor().focused);
    screen.mockInput.pressEnter({ shift: true });
    await screen.mockInput.typeText("last line");
    expect(editor().plainText).toBe("prefix 中文 👋 draft appended border\nlast line");
    screen.mockInput.pressEnter();
    await waitFor(async () => {
      const result = await api<{ events: { kind: string }[] }>(
        `/v1/conversations/${a.id}/events?limit=1000`,
      );
      return result.events.filter((event) => event.kind === "user.message").length === 2;
    }, "Enter sends exactly one new message");
  } finally {
    await screen.dispose();
  }
}, 20000);

test("sidebar click/drag and chat selection do not cross-trigger; Ctrl+C copies, clears then quits", async () => {
  const { a, b } = await setup("Gestures");
  const turn = await api<{ id: string }>(`/v1/conversations/${a.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "mock",
    message: "alpha beta gamma\nsecond line exact",
  });
  await waitFor(
    async () => (await api<{ endedAt: number | null }>(`/v1/turns/${turn.id}`)).endedAt !== null,
  );
  let exited = false;
  const screen = await testRender(
    () => (
      <App
        onExit={() => {
          exited = true;
        }}
      />
    ),
    { width: 150, height: 40, exitOnCtrlC: false, exitSignals: [] },
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
    await current(screen, a);
    const from = await point(screen, conversationKey(a.id), 5),
      to = await point(screen, conversationKey(b.id), 5);
    await screen.mockMouse.drag(from.x, from.y, to.x, to.y);
    await current(screen, a);
    await screen.mockMouse.click(to.x, to.y, 2); // right click cannot navigate
    await current(screen, a);
    await screen.mockMouse.drag(to.x, to.y, to.x + 3, to.y);
    await current(screen, a);
    expect(copied).toHaveLength(0);
    const history = node(screen, "native-history") as ScrollBoxRenderable;
    history.scrollTo(0);
    await frame(screen, "alpha beta gamma");
    const lines = screen.captureCharFrame().split("\n"),
      y = lines.findIndex((l) => l.includes("alpha beta gamma")),
      x = lines[y]?.indexOf("alpha beta gamma") ?? -1;
    expect(x).toBeGreaterThan(0);
    // A chat selection ending on the sidebar must not activate a row.
    await screen.mockMouse.drag(x, y, to.x, to.y);
    await current(screen, a);
    screen.renderer.clearSelection();
    await screen.mockMouse.drag(x, y, x + 5, y);
    await waitFor(() => copied.at(-1)?.startsWith("alpha") ?? false, "selected alpha copied");
    expect((node(screen, "message-draft") as TextareaRenderable).focused).toBe(true);
    await screen.mockInput.typeText("preserve draft");
    screen.mockInput.pressKey("c", { ctrl: true });
    await waitFor(
      () => !screen.renderer.getSelection()?.getSelectedText(),
      "Ctrl+C cleared selection",
    );
    expect((node(screen, "message-draft") as TextareaRenderable).plainText).toBe("preserve draft");
    expect(exited).toBe(false);
    const copies = copied.length;
    await click(screen, conversationKey(b.id), 5);
    await current(screen, b);
    expect(copied).toHaveLength(copies);
    await click(screen, conversationKey(a.id), 5);
    await current(screen, a);
    await frame(screen, "preserve draft");
    screen.mockInput.pressKey("c", { ctrl: true });
    await screen.renderOnce();
    expect((node(screen, "message-draft") as TextareaRenderable).plainText).toBe("");
    expect(exited).toBe(false);
    screen.mockInput.pressKey("c", { ctrl: true });
    await waitFor(() => exited, "Ctrl+C exited");
  } finally {
    await screen.dispose();
  }
}, 20000);

test("mouse rename targets the clicked conversation, supports cancel and syncs another TUI", async () => {
  const { a, b } = await setup("Rename-mouse");
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  const other = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  try {
    await current(screen, a);
    await current(other, a);
    await click(other, conversationKey(b.id), 5);
    await current(other, b);
    await click(screen, `actions-${b.id}`);
    await click(screen, "conversation-action-rename", 2);
    await frame(screen, "Rename Conversation");
    const input = node(screen, "conversation-title") as InputRenderable;
    expect(input.value).toBe(b.title);
    input.value = "Cancelled title";
    screen.mockInput.pressEscape();
    await waitFor(async () => {
      await screen.renderOnce();
      return !screen.renderer.root.findDescendantById("conversation-title");
    }, "rename cancelled");
    expect((await api<Conversation>(`/v1/conversations/${b.id}`)).title).toBe(b.title);
    await click(screen, `actions-${b.id}`);
    await click(screen, "conversation-action-rename", 2);
    await frame(screen, "Rename Conversation");
    (node(screen, "conversation-title") as InputRenderable).value = "Renamed by mouse";
    screen.mockInput.pressEnter();
    await frame(screen, "Conversation renamed");
    await frame(other, "Renamed by mouse");
    await current(screen, a);
    expect((await api<Conversation>(`/v1/conversations/${a.id}`)).title).toBe(a.title);
    expect((await api<Conversation>(`/v1/conversations/${b.id}`)).title).toBe("Renamed by mouse");
  } finally {
    await screen.dispose();
    await other.dispose();
  }
}, 20000);

test("row actions archive/restore/delete the intended ID without selecting a neighbor; delete still requires confirmation", async () => {
  const { a, b, project } = await setup("Lifecycle-mouse");
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 35 });
  try {
    await current(screen, a);
    await click(screen, `actions-${b.id}`);
    await frame(screen, "Conversation actions");
    await click(screen, "conversation-action-archive", 2);
    await frame(screen, "Conversation archived");
    await waitFor(async () => !!(await api<Conversation>(`/v1/conversations/${b.id}`)).archivedAt);
    await waitFor(async () => {
      await screen.renderOnce();
      return !screen.renderer.root.findDescendantById(conversationKey(b.id));
    });
    await current(screen, a); // operating on another row never changes the current conversation
    await click(screen, `actions-${a.id}`);
    await click(screen, "conversation-action-archive", 2);
    await waitFor(async () => {
      await screen.renderOnce();
      return !screen.renderer.root.findDescendantById("conversation-action-archive");
    });
    await frame(screen, `Workspace · ${project.rootPath}`);
    await command(screen, "View Archived Conversations");
    await click(screen, conversationKey(a.id), 5);
    await frame(screen, "[archived]");
    await click(screen, `actions-${a.id}`);
    await click(screen, "conversation-action-archive", 2);
    await waitFor(
      async () => (await api<Conversation>(`/v1/conversations/${a.id}`)).archivedAt === null,
    );
    await frame(screen, `Workspace · ${project.rootPath}`);
    await waitFor(async () => {
      await screen.renderOnce();
      return !screen.renderer.root.findDescendantById("conversation-action-archive");
    });
    await click(screen, `actions-${b.id}`);
    await frame(screen, "Conversation actions");
    await click(screen, "conversation-action-archive", 2);
    await waitFor(
      async () => (await api<Conversation>(`/v1/conversations/${b.id}`)).archivedAt === null,
    );
    await command(screen, "Hide Archived Conversations");
    await click(screen, conversationKey(a.id), 5);
    await current(screen, a);
    await click(screen, `actions-${b.id}`);
    await frame(screen, "Conversation actions");
    await click(screen, "conversation-action-delete", 2);
    await frame(screen, "Confirm Conversation deletion");
    screen.mockInput.pressEscape();
    await waitFor(async () => {
      await screen.renderOnce();
      return !screen.renderer.root.findDescendantById("delete-confirm");
    });
    await current(screen, a);
    expect((await api<Conversation>(`/v1/conversations/${b.id}`)).id).toBe(b.id);
    await click(screen, `actions-${b.id}`);
    await click(screen, "conversation-action-delete", 2);
    await frame(screen, "Confirm Conversation deletion");
    await click(screen, "delete-confirm", 2);
    await waitFor(
      async () =>
        !(await api<{ conversations: Conversation[] }>("/v1/snapshot")).conversations.some(
          (c) => c.id === b.id,
        ),
    );
    await current(screen, a);
    await waitFor(async () => {
      await screen.renderOnce();
      return !screen.renderer.root.findDescendantById("delete-confirm");
    });
    await click(screen, `actions-${a.id}`);
    await click(screen, "conversation-action-delete", 2);
    await frame(screen, "Confirm Conversation deletion");
    await click(screen, "delete-confirm", 2);
    await frame(screen, `Workspace · ${project.rootPath}`);
    expect(screen.renderer.root.findDescendantById(conversationKey(a.id))).toBeFalsy();
  } finally {
    await screen.dispose();
  }
}, 20000);

test("project directory reports an unavailable root without creating or modifying it", async () => {
  const screen = await testRender(
    () => <ProjectDirectory rootPath={join(temp, "missing-root")} />,
    { width: 100, height: 20 },
  );
  try {
    await frame(screen, "Cannot read");
  } finally {
    await screen.dispose();
  }
});
