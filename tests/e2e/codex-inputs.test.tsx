import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { App } from "../../apps/tui/src/index";
import { connect } from "../../packages/shared/src/client";
import type {
  Conversation,
  ConversationEvent,
  PendingInput,
  Turn,
} from "../../packages/shared/src/index";

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
    await frame(screen, "/help");
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
    await screen.mockInput.typeText("/queue");
    screen.mockInput.pressEnter();
    screen.mockInput.pressEnter();
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

test("retired shortcuts leave native editing keys available and local slash commands make no model calls", async () => {
  const { screen, c } = await setup();
  try {
    await screen.mockInput.typeText("abcdef");
    screen.mockInput.pressKey("a", { ctrl: true });
    screen.mockInput.pressKey("d", { ctrl: true });
    expect(editor(screen).plainText).toBe("bcdef");
    screen.mockInput.pressKey("e", { ctrl: true });
    screen.mockInput.pressKey("w", { ctrl: true });
    expect(editor(screen).plainText).toBe("");
    for (const key of ["p", "n", "x", "f"]) screen.mockInput.pressKey(key, { ctrl: true });
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("Command palette");
    await screen.mockInput.typeText("/model");
    screen.mockInput.pressEnter();
    screen.mockInput.pressEnter();
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
    editor(screen).setText("/diff");
    screen.mockInput.pressEnter();
    screen.mockInput.pressEnter();
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
