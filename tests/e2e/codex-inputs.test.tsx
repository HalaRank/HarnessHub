import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TextareaRenderable } from "@opentui/core";
import { createMockKeys } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import { flushDrafts } from "../../apps/tui/src/draft-session";
import { App } from "../../apps/tui/src/index";
import { connect } from "../../packages/shared/src/client";
import type {
  Conversation,
  ConversationEvent,
  Draft,
  PendingInput,
  Turn,
} from "../../packages/shared/src/index";
import { clickControl, invoke, openCommands } from "./ui-actions";

const root = mkdtempSync(join(tmpdir(), "hhu-codex-input-ui-"));
const previous = { ...process.env };
const cli = resolve("dist/cli/hhu.js");
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const client = await connect();
  if (!client) throw new Error("Missing isolated Daemon");
  return client.request<T>(path, method, body);
}
beforeAll(async () => {
  Object.assign(process.env, {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
  });
  expect(spawnSync(process.execPath, [cli, "daemon", "start"]).status).toBe(0);
  await api("/v1/harness-profiles", "POST", {
    id: "mock",
    name: "Mock",
    command: "node",
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: { HHU_MOCK_STEERING: "yes" },
  });
});
afterAll(() => {
  expect(spawnSync(process.execPath, [cli, "daemon", "stop", "--cancel-active"]).status).toBe(0);
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 350; i++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Codex input UI timeout");
}
type Screen = Awaited<ReturnType<typeof testRender>>;
const editor = (screen: Screen) =>
  screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable;
async function frame(screen: Screen, text: string) {
  await until(async () => {
    await screen.renderOnce();
    return screen.captureCharFrame().includes(text);
  });
}
async function setup() {
  const p = await api<{ id: string }>("/v1/projects", "POST", { rootPath: root });
  const c = await api<Conversation>(`/v1/projects/${p.id}/conversations`, "POST", {});
  await api(`/v1/conversations/${c.id}/harness`, "PUT", { harnessId: "mock" });
  await api(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId: "mock" });
  await api("/v1/preferences", "PATCH", {
    lastConversationId: c.id,
    showSidebar: false,
    shortcuts: {},
  });
  const screen = await testRender(() => <App onExit={() => {}} />, {
    width: 120,
    height: 36,
    kittyKeyboard: true,
  });
  await frame(screen, "Esc interrupt");
  screen.mockInput.pressEnter();
  await until(() => editor(screen).focused);
  return { screen, c };
}
const inputs = (c: Conversation) => api<PendingInput[]>(`/v1/conversations/${c.id}/inputs`);
const events = async (c: Conversation) =>
  (await api<{ events: ConversationEvent[] }>(`/v1/conversations/${c.id}/events?limit=1000`))
    .events;

test("folded pastes expand for editing and send original text exactly once", async () => {
  const { screen, c } = await setup();
  const pasted = "中文 👋\nsecond\nthird\nfourth\nfifth\nsixth";
  try {
    await screen.mockInput.pasteBracketedText(pasted);
    await frame(screen, "[粘贴 #1 · 6 行]");
    await flushDrafts();
    expect((await api<Draft>(`/v1/conversations/${c.id}/draft`)).text).toBe(pasted);
    expect((await events(c)).filter((event) => event.kind === "user.message")).toHaveLength(0);
    screen.mockInput.pressKey("F2");
    await screen.renderOnce();
    expect(editor(screen).plainText).toBe(pasted);
    expect(screen.renderer.root.findDescendantById("expand-pasted-text")).toBeUndefined();
    await screen.mockInput.typeText(" edited");
    expect(editor(screen).plainText).toBe(`${pasted} edited`);
    editor(screen).setText("");
    await screen.mockInput.pasteBracketedText(pasted);
    await clickControl(screen, "expand-pasted-text");
    expect(editor(screen).plainText).toBe(pasted);
    editor(screen).setText("");
    await screen.mockInput.typeText("Review this: ");
    await screen.mockInput.pasteBracketedText(pasted);
    await screen.mockInput.typeText(" suffix");
    screen.mockInput.pressEnter();
    await until(async () =>
      (await events(c)).some((event) => event.kind === "runtime.turn_finished"),
    );
    const prompts = (await events(c)).filter(
      (event) => (event.raw as { method?: string } | null)?.method === "session/prompt",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.raw).toMatchObject({
      params: { prompt: [{ type: "text", text: `Review this: ${pasted} suffix` }] },
    });
    await until(() => editor(screen).plainText === "");
    expect(screen.renderer.root.findDescendantById("expand-pasted-text")).toBeUndefined();
    expect((await api<Draft>(`/v1/conversations/${c.id}/draft`)).text).toBe("");
    await screen.mockInput.pasteBracketedText(pasted);
    screen.mockInput.pressArrow("up");
    await screen.renderOnce();
    expect(editor(screen).plainText).toBe(`Review this: ${pasted} suffix`);
    screen.mockInput.pressArrow("down");
    await screen.renderOnce();
    expect(editor(screen).plainText).toBe(pasted);
  } finally {
    await screen.dispose();
    await flushDrafts();
  }
});

test("folded drafts survive reopening as full editable text without submitting", async () => {
  const { screen, c } = await setup();
  const pasted = "restored\n中文\nthird\nfourth\nfifth\nsixth";
  try {
    await screen.mockInput.pasteBracketedText(pasted);
    await frame(screen, "[粘贴 #1 · 6 行]");
  } finally {
    await screen.dispose();
    await flushDrafts();
  }
  const reopened = await testRender(() => <App onExit={() => {}} />, { width: 100, height: 30 });
  try {
    await until(async () => {
      await reopened.renderOnce();
      return editor(reopened)?.plainText === pasted;
    });
    expect((await api<Draft>(`/v1/conversations/${c.id}/draft`)).text).toBe(pasted);
    expect((await events(c)).filter((event) => event.kind === "user.message")).toHaveLength(0);
    expect(reopened.renderer.root.findDescendantById("expand-pasted-text")).toBeUndefined();
  } finally {
    await reopened.dispose();
    await flushDrafts();
  }
});

test("queueing folded text persists the original payload without submitting a new Turn", async () => {
  const { screen, c } = await setup();
  const pasted = "queued\n中文\nthird\nfourth\nfifth\nsixth";
  try {
    await screen.mockInput.typeText("wait");
    screen.mockInput.pressEnter();
    await frame(screen, "RUNNING");
    await until(() => editor(screen).focused && editor(screen).plainText === "");
    await screen.mockInput.pasteBracketedText(pasted);
    screen.mockInput.pressTab();
    await until(async () => (await inputs(c)).some((input) => input.state === "QUEUED"));
    expect((await inputs(c))[0]?.input.message).toBe(pasted);
    expect(
      (await events(c)).filter(
        (event) => (event.raw as { method?: string } | null)?.method === "session/prompt",
      ),
    ).toHaveLength(1);
    await until(() => editor(screen).focused && editor(screen).plainText === "");
    screen.mockInput.pressEscape();
    await until(async () => (await inputs(c)).some((input) => input.state === "HELD"));
    expect((await inputs(c))[0]?.input.message).toBe(pasted);
  } finally {
    await screen.dispose();
    await flushDrafts();
  }
});

test("folding never bypasses confirmation for unadvertised slash text", async () => {
  const { screen, c } = await setup();
  const pasted = "/unknown\nsecond\nthird\nfourth\nfifth\nsixth";
  try {
    await screen.mockInput.pasteBracketedText(pasted);
    screen.mockInput.pressEnter();
    await frame(screen, "Unadvertised slash text");
    await flushDrafts();
    expect((await api<Draft>(`/v1/conversations/${c.id}/draft`)).text).toBe(pasted);
    expect((await events(c)).filter((event) => event.kind === "user.message")).toHaveLength(0);
    screen.mockInput.pressEscape();
    await frame(screen, "[粘贴 #1 · 6 行]");
  } finally {
    await screen.dispose();
    await flushDrafts();
  }
});

test("Enter steers while running, Tab queues, Esc dismisses suggestions before interrupting and preserves a draft", async () => {
  const { screen, c } = await setup();
  try {
    await screen.mockInput.typeText("wait");
    screen.mockInput.pressEnter();
    await frame(screen, "RUNNING");
    await until(() => editor(screen).focused && editor(screen).plainText === "");
    await screen.mockInput.typeText("steer-me");
    screen.mockInput.pressEnter();
    await until(async () =>
      (await inputs(c)).some(
        (input) => input.input.message === "steer-me" && input.state === "SENT",
      ),
    );
    await until(() => editor(screen).focused && editor(screen).plainText === "");
    await screen.mockInput.typeText("queued-message");
    screen.mockInput.pressTab();
    await until(async () => (await inputs(c)).some((input) => input.state === "QUEUED"));
    await until(() => editor(screen).focused && editor(screen).plainText === "");
    await screen.mockInput.typeText("/");
    await frame(screen, "Agent has not published any ACP commands.");
    screen.mockInput.pressEscape();
    await screen.renderOnce();
    expect((await api<Conversation>(`/v1/conversations/${c.id}`)).runtimeStatus).toBe("RUNNING");
    screen.mockInput.pressEscape();
    await until(async () => (await inputs(c)).some((input) => input.state === "HELD"));
    await until(
      async () => (await api<Conversation>(`/v1/conversations/${c.id}`)).runtimeStatus === "IDLE",
    );
    expect(editor(screen).plainText).toBe("/");
    expect(editor(screen).focused).toBe(true);
    const history = await events(c);
    expect(
      history.filter((event) => (event.raw as { method?: string })?.method === "session/prompt")
        .length,
    ).toBe(1);
    expect(history.filter((event) => event.kind === "user.message").length).toBe(2);
    editor(screen).setText("");
    await invoke(screen, "Message Queue");
    await frame(screen, "Message queue");
    screen.mockInput.pressEnter();
    await until(async () =>
      (await inputs(c)).some(
        (input) => input.input.message === "queued-message" && input.state === "SENT",
      ),
    );
    const queued = (await inputs(c)).find((input) => input.input.message === "queued-message");
    await until(async () => (await api<Turn>(`/v1/turns/${queued?.turnId}`)).endedAt !== null);
    screen.mockInput.pressEscape();
    await until(() => editor(screen).focused);
    await screen.mockInput.typeText("wait");
    screen.mockInput.pressEnter();
    await frame(screen, "RUNNING");
    await until(() => editor(screen).focused && editor(screen).plainText === "");
    screen.mockInput.pressKey("t", { ctrl: true });
    screen.mockInput.pressEscape();
    expect((await api<Conversation>(`/v1/conversations/${c.id}`)).runtimeStatus).toBe("RUNNING");
    screen.mockInput.pressEscape();
    await until(
      async () => (await api<Conversation>(`/v1/conversations/${c.id}`)).runtimeStatus === "IDLE",
    );
  } finally {
    await screen.dispose();
  }
});

test("retired shortcuts leave editing keys available and HHU settings stay in the command palette", async () => {
  const { screen, c } = await setup();
  try {
    await screen.mockInput.typeText("abcdef");
    screen.mockInput.pressKey("a", { ctrl: true });
    screen.mockInput.pressKey("d", { ctrl: true });
    expect(editor(screen).plainText).toBe("bcdef");
    screen.mockInput.pressKey("e", { ctrl: true });
    screen.mockInput.pressKey("w", { ctrl: true });
    expect(editor(screen).plainText).toBe("");
    for (const key of ["p", "x", "f"]) screen.mockInput.pressKey(key, { ctrl: true });
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("Command palette");
    await invoke(screen, "HarnessHub ACP settings");
    await frame(screen, "HarnessHub ACP settings");
    screen.mockInput.pressEscape();
    expect((await events(c)).filter((event) => event.kind === "user.message").length).toBe(0);
  } finally {
    await screen.dispose();
  }
});

test("prompt history uses Up/Down and Ctrl+R while Ctrl+T opens transcript navigation", async () => {
  const { screen, c } = await setup();
  try {
    await screen.mockInput.typeText("history-message");
    screen.mockInput.pressEnter();
    await until(
      async () =>
        (await api<Conversation>(`/v1/conversations/${c.id}`)).runtimeStatus === "IDLE" &&
        (await events(c)).some((event) => event.kind === "runtime.turn_finished"),
    );
    await until(() => editor(screen).focused && editor(screen).plainText === "");
    await screen.mockInput.typeText("unsent-draft");
    screen.mockInput.pressArrow("up");
    expect(editor(screen).plainText).toBe("history-message");
    screen.mockInput.pressArrow("down");
    expect(editor(screen).plainText).toBe("unsent-draft");
    screen.mockInput.pressKey("r", { ctrl: true });
    await frame(screen, "Search prompt history");
    await screen.mockInput.typeText("history-");
    screen.mockInput.pressEnter();
    await until(() => editor(screen).focused);
    expect(editor(screen).plainText).toBe("history-message");
    await invoke(screen, "Toggle Changes / Chat");
    await frame(screen, "Changes");
    screen.mockInput.pressKey("t", { ctrl: true });
    await frame(screen, "Chat · History");
    await screen.renderOnce();
    expect(editor(screen).focused).toBe(false);
    screen.mockInput.pressKey("t", { ctrl: true });
    await screen.renderOnce();
    expect(editor(screen).focused).toBe(true);
    expect((await events(c)).filter((event) => event.kind === "user.message").length).toBe(1);
  } finally {
    await screen.dispose();
  }
});

test("Agent/model remain visible and Ctrl+H switches without editing drafts or starting Handoff", async () => {
  const { screen, c } = await setup();
  try {
    await frame(screen, "mock · mock-model");
    await api(`/v1/conversations/${c.id}/settings`, "POST", {
      kind: "config",
      configId: "model",
      value: "other",
    });
    await frame(screen, "mock · other");
    await screen.mockInput.typeText("preserved draft!");
    screen.mockInput.pressBackspace();
    expect(editor(screen).plainText).toBe("preserved draft");
    const profiles = await api<{ id: string }[]>("/v1/harness-profiles");
    let index = profiles.findIndex((profile) => profile.id === "mock");
    const switchHarness = async (press: () => void) => {
      press();
      index = (index + 1) % profiles.length;
      await until(
        async () =>
          (await api<Conversation>(`/v1/conversations/${c.id}`)).selectedHarnessId ===
          profiles[index]?.id,
      );
      await frame(screen, "PENDING_SWITCH");
      expect(editor(screen).plainText).toBe("preserved draft");
      expect(screen.captureCharFrame()).toContain("mock ·");
      expect(screen.captureCharFrame()).toContain("mock · other");
    };
    await switchHarness(() => screen.mockInput.pressKey("h", { ctrl: true }));
    await until(() => editor(screen).focused);
    // Exercise the real parser's legacy BS encoding as well as Kitty Ctrl+H.
    const legacy = createMockKeys(screen.renderer);
    await switchHarness(() => legacy.pressKey("h", { ctrl: true }));
    await until(() => editor(screen).focused);
    legacy.pressKey("\x7f");
    expect(editor(screen).plainText).toBe("preserved draf");
    await screen.mockInput.typeText("t");
    screen.mockInput.pressKey("t", { ctrl: true });
    await frame(screen, "Chat · History");
    await switchHarness(() => screen.mockInput.pressKey("h", { ctrl: true }));
    await invoke(screen, "Toggle Changes / Chat");
    await frame(screen, "Changes");
    await switchHarness(() => screen.mockInput.pressKey("h", { ctrl: true }));
    await openCommands(screen);
    screen.mockInput.pressKey("h", { ctrl: true });
    await screen.renderOnce();
    expect((await api<Conversation>(`/v1/conversations/${c.id}`)).selectedHarnessId).toBe(
      profiles[index]?.id,
    );
    screen.mockInput.pressEscape();
    await frame(screen, "mock · other");
    for (const width of [80, 32]) {
      screen.resize(width, 36);
      await frame(screen, "mock · other");
      expect(screen.captureCharFrame()).toContain("mock ·");
      const identity = screen.renderer.root.findDescendantById("harness-identity");
      const toolbar = screen.renderer.root.findDescendantById("conversation-toolbar");
      expect(identity && toolbar && identity.y >= toolbar.y).toBe(true);
      expect(identity?.height).toBe(1);
    }
    expect((await events(c)).filter((event) => event.kind === "user.message")).toHaveLength(0);
    expect(
      (await events(c)).filter(
        (event) => (event.raw as { method?: string } | null)?.method === "session/prompt",
      ),
    ).toHaveLength(0);
    expect(await api<unknown[]>(`/v1/conversations/${c.id}/sessions`)).toHaveLength(1);
    expect(await api<unknown[]>(`/v1/conversations/${c.id}/handoffs`)).toHaveLength(0);
  } finally {
    await screen.dispose();
  }
  const reopened = await testRender(() => <App onExit={() => {}} />, { width: 80, height: 36 });
  try {
    await frame(reopened, "mock · other");
    expect(reopened.captureCharFrame()).toContain("mock ·");
    await frame(reopened, "PENDING_SWITCH");
    await until(() => editor(reopened)?.plainText === "preserved draft");
  } finally {
    await reopened.dispose();
  }
}, 20000);
