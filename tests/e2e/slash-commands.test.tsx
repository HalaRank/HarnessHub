import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { App } from "../../apps/tui/src/index";
import { slashQuery } from "../../apps/tui/src/slash-commands";
import { connect } from "../../packages/shared/src/client";
import {
  type Conversation,
  type ConversationEvent,
  type NativeSession,
  sessionCommands,
  shortcutInput,
  type Turn,
} from "../../packages/shared/src/index";
import { focusMessage, invoke, openCommands } from "./ui-actions";

const temp = mkdtempSync(join(tmpdir(), "hhu-slash-ui-"));
const previous = { ...process.env };
const cli = resolve("dist/cli/hhu.js");
const advertised = [
  { name: "compact", description: "Native compact", input: { hint: "optional context" } },
  { name: "review", description: "原生审查" },
  { name: "status", description: "Native status" },
  { name: "silent", description: "No output" },
  ...Array.from({ length: 30 }, (_, i) => ({ name: `item${i}`, description: `Native item ${i}` })),
];
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const client = await connect();
  if (!client) throw new Error("No isolated Daemon");
  return client.request<T>(path, method, body);
}
beforeAll(async () => {
  Object.assign(process.env, {
    XDG_CONFIG_HOME: join(temp, "config"),
    XDG_DATA_HOME: join(temp, "data"),
    XDG_STATE_HOME: join(temp, "state"),
  });
  expect(spawnSync(process.execPath, [cli, "daemon", "start"]).status).toBe(0);
  for (const id of ["a", "b", "none"])
    await api("/v1/harness-profiles", "POST", {
      id,
      name: id,
      command: "node",
      args: [resolve("tests/fixtures/mock-acp/server.mjs")],
      envOverrides:
        id === "none"
          ? {}
          : {
              HHU_MOCK_COMMANDS: JSON.stringify(
                id === "a" ? advertised : [{ name: "other", description: "B only" }],
              ),
            },
    });
});
afterAll(() => {
  expect(spawnSync(process.execPath, [cli, "daemon", "stop", "--cancel-active"]).status).toBe(0);
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k];
  }
  console.log(`Slash command evidence: ${temp}`);
});
async function until(check: () => boolean | Promise<boolean>, label = "state") {
  for (let i = 0; i < 350; i++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out: ${label}`);
}
type Screen = Awaited<ReturnType<typeof testRender>>;
async function frame(s: Screen, text: string) {
  await until(async () => {
    await s.renderOnce();
    return s.captureCharFrame().includes(text);
  }, text).catch((e) => {
    throw new Error(`${e.message}\n${s.captureCharFrame()}`);
  });
}
const editor = (s: Screen) =>
  s.renderer.root.findDescendantById("message-draft") as TextareaRenderable;
const popup = (s: Screen) => s.renderer.root.findDescendantById("slash-popup");
const events = async (c: Conversation) =>
  (await api<{ events: ConversationEvent[] }>(`/v1/conversations/${c.id}/events?limit=1000`))
    .events;
const users = async (c: Conversation) => (await events(c)).filter((e) => e.kind === "user.message");
const sessions = (c: Conversation) => api<NativeSession[]>(`/v1/conversations/${c.id}/sessions`);
async function setup(name: string, harness = "a", initialize = true) {
  const root = join(temp, name);
  mkdirSync(root);
  const p = await api<{ id: string }>("/v1/projects", "POST", { rootPath: root, name });
  const c = await api<Conversation>(`/v1/projects/${p.id}/conversations`, "POST", { title: name });
  await api(`/v1/conversations/${c.id}/harness`, "PUT", { harnessId: harness });
  if (initialize) await api(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId: harness });
  await api("/v1/preferences", "PATCH", {
    lastConversationId: c.id,
    showSidebar: false,
    shortcuts: {},
  });
  return c;
}
async function screenFor(c: Conversation, onExit = () => {}) {
  const s = await testRender(() => <App onExit={onExit} />, {
    width: 105,
    height: 32,
    kittyKeyboard: true,
  });
  await frame(s, "ACP ·");
  await until(() => !!editor(s));
  await focusMessage(s);
  await until(() => editor(s).focused, "initial editor focus");
  // Initial loading finishes before the editor accepts keyboard input.
  await until(async () => (await api<Conversation>(`/v1/conversations/${c.id}`)).id === c.id);
  return s;
}
async function prompt(c: Conversation, message: string, harnessId = "a", extra = {}) {
  const t = await api<Turn>(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId,
    message,
    ...extra,
  });
  await until(async () => (await api<Turn>(`/v1/turns/${t.id}`)).endedAt !== null);
  return t;
}

test("shortcut validation rejects editor collisions, terminal aliases and nonexistent keys", () => {
  for (const keys of [
    { palette: "ctrl+a" },
    { palette: "ctrl+k" },
    { sidebar: "ctrl+d" },
    { copy: "ctrl+j" },
    { changes: "ctrl+b" },
    { palette: "ctrl+enter" },
    { palette: "ctrl+tab" },
    { palette: "ctrl+madeup" },
    { palette: "ctrl+m" },
  ])
    expect(shortcutInput.safeParse(keys).success).toBe(false);
  expect(shortcutInput.safeParse({}).success).toBe(true);
  expect(
    shortcutInput.safeParse({ palette: "ctrl+s", sidebar: "meta+s", newline: "ctrl+0" }).success,
  ).toBe(true);
});

test("slash trigger uses the actual cursor prefix and rejects paths, code and later lines", () => {
  expect(slashQuery("/review 参数", "/rev")).toBe("rev");
  for (const text of [
    "/home/user",
    "/foo\\bar",
    "text /co",
    "代码\n/co",
    "```\n/co",
    "/review 参数",
  ])
    expect(slashQuery(text, text)).toBeNull();
});

test("slash filters native names, Tab and Enter complete without a Turn; explicit send has one idempotent Prompt", async () => {
  const c = await setup("completion");
  const s = await screenFor(c);
  try {
    await s.mockInput.typeText("/");
    await frame(s, "/compact");
    expect(s.captureCharFrame()).toContain("optional context");
    await s.mockInput.typeText("co");
    await frame(s, "Native compact");
    expect(s.captureCharFrame()).not.toContain("原生审查");
    s.mockInput.pressTab();
    await until(() => editor(s).plainText === "/compact", "Tab completion");
    expect(editor(s).focused).toBe(true);
    expect((await users(c)).length).toBe(0);
    editor(s).setText("");
    await s.mockInput.typeText("/rev");
    await frame(s, "原生审查");
    s.mockInput.pressEnter();
    await until(() => editor(s).plainText === "/review", "Enter completion");
    expect((await users(c)).length).toBe(0);
    s.mockInput.pressEnter();
    await frame(s, "You");
    await until(async () => (await users(c)).length === 1, "explicit command Turn");
    await until(
      async () => (await api<Conversation>(`/v1/conversations/${c.id}`)).runtimeStatus === "IDLE",
    );
    const ev = (await users(c))[0];
    const payload = ev?.payload as {
      requestId: string;
      nativeCommand: { nativeSessionId: string; name: string };
    };
    expect(payload.nativeCommand.name).toBe("review");
    await api(`/v1/conversations/${c.id}/turns`, "POST", {
      requestId: payload.requestId,
      harnessId: "a",
      message: "/review",
      nativeCommand: payload.nativeCommand,
    });
    expect((await users(c)).length).toBe(1);
    const wire = (await events(c)).filter(
      (e) => e.origin === "client" && (e.raw as { method?: string })?.method === "session/prompt",
    );
    expect(wire.length).toBe(1);
  } finally {
    s.renderer.destroy();
  }
}, 20000);

test("Esc closes suggestions first, then editor; unmatched Enter never creates a Turn", async () => {
  const c = await setup("escape");
  const s = await screenFor(c);
  try {
    await s.mockInput.typeText("/missing");
    await frame(s, "No matching ACP commands");
    s.mockInput.pressEnter();
    expect((await users(c)).length).toBe(0);
    s.mockInput.pressEscape();
    await s.renderOnce();
    expect(popup(s)).toBeFalsy();
    expect(editor(s).focused).toBe(true);
    s.mockInput.pressEscape();
    await until(() => !editor(s).focused);
    expect(editor(s).plainText).toBe("/missing");
    expect((await users(c)).length).toBe(0);
  } finally {
    s.renderer.destroy();
  }
});

test("ordinary letters, Ctrl+D/Y, arrows, Shift+Enter and Ctrl+J retain editor semantics", async () => {
  const c = await setup("editing");
  let exits = 0;
  const s = await screenFor(c, () => exits++);
  try {
    const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    await s.mockInput.typeText(letters);
    expect(editor(s).plainText).toBe(letters);
    expect(exits).toBe(0);
    editor(s).cursorOffset = 0;
    s.mockInput.pressKey("d", { ctrl: true });
    expect(editor(s).plainText).toBe(letters.slice(1));
    expect(editor(s).focused).toBe(true);
    const before = editor(s).plainText;
    s.mockInput.pressKey("y", { ctrl: true });
    expect(editor(s).plainText).toBe(before);
    editor(s).gotoBufferEnd();
    s.mockInput.pressEnter({ shift: true });
    await s.mockInput.pasteBracketedText("中文🙂");
    s.mockInput.pressKey("j", { ctrl: true });
    await s.mockInput.typeText("last");
    expect(editor(s).plainText).toBe(`${before}\n中文🙂\nlast`);
    s.mockInput.pressArrow("up");
    expect(editor(s).logicalCursor.row).toBe(1);
    expect((await users(c)).length).toBe(0);
  } finally {
    s.renderer.destroy();
  }
});

test("command menu owns keys, restores draft/cursor and sidebar actions preserve both", async () => {
  const c = await setup("palette");
  const s = await screenFor(c);
  try {
    await s.mockInput.pasteBracketedText("中文🙂 draft");
    editor(s).moveCursorLeft();
    const cursor = editor(s).cursorOffset;
    await openCommands(s);
    await frame(s, "Command palette");
    s.mockInput.pressKey("d", { ctrl: true });
    expect(editor(s).plainText).toBe("中文🙂 draft");
    s.mockInput.pressEscape();
    await until(() => editor(s).focused);
    expect(editor(s).cursorOffset).toBe(cursor);
    await invoke(s, "Toggle Sidebar");
    expect(editor(s).cursorOffset).toBe(cursor);
    expect(editor(s).plainText).toBe("中文🙂 draft");
    await openCommands(s);
    await frame(s, "Command palette");
    await openCommands(s);
    await until(() => editor(s).focused);
    expect(editor(s).cursorOffset).toBe(cursor);
    expect((await users(c)).length).toBe(0);
  } finally {
    s.renderer.destroy();
  }
});

test("Ctrl+C copies valid editor selection, then clears draft, then exits without stopping Daemon/session", async () => {
  const c = await setup("interrupt");
  let exits = 0;
  const s = await screenFor(c, () => exits++);
  try {
    const native = (await sessions(c))[0]?.id;
    await s.mockInput.typeText("selected text");
    editor(s).setSelection(0, 8);
    s.mockInput.pressCtrlC();
    expect(editor(s).plainText).toBe("selected text");
    expect(exits).toBe(0);
    s.mockInput.pressCtrlC();
    expect(editor(s).plainText).toBe("");
    expect(exits).toBe(0);
    s.mockInput.pressCtrlC();
    await until(() => exits === 1);
    expect((await sessions(c))[0]?.id).toBe(native);
    expect((await sessions(c))[0]?.status).toBe("READY");
    expect((await users(c)).length).toBe(0);
  } finally {
    s.renderer.destroy();
  }
});

test("bracketed paste /path is never auto-executed and requires explicit ordinary-text sending", async () => {
  const c = await setup("paste");
  const s = await screenFor(c);
  try {
    await s.mockInput.pasteBracketedText("/path\n中文 🙂\ntext /review");
    await s.renderOnce();
    expect(popup(s)).toBeFalsy();
    s.mockInput.pressEnter();
    await frame(s, "Unadvertised slash text");
    expect((await users(c)).length).toBe(0);
    s.mockInput.pressEscape();
    await until(() => editor(s).focused);
    expect(editor(s).plainText).toContain("/path\n中文");
    s.mockInput.pressEnter();
    await frame(s, "Unadvertised slash text");
    s.mockInput.pressArrow("down");
    s.mockInput.pressEnter();
    await until(async () => (await users(c)).length === 1);
    expect(((await users(c))[0]?.payload as { text?: string } | undefined)?.text).toBe(
      "/path\n中文 🙂\ntext /review",
    );
  } finally {
    s.renderer.destroy();
  }
});

test("snapshot replacement/empty clearing is isolated; two TUI subscribers and reopen rebuild state", async () => {
  const c = await setup("snapshots");
  const other = await setup("isolated", "b");
  await api("/v1/preferences", "PATCH", { lastConversationId: c.id });
  const one = await screenFor(c);
  const two = await screenFor(c);
  try {
    // Test renderers share stdin. Set each real editor independently, then use
    // their independent websocket consumers to observe the same Daemon update.
    editor(one).setText("/");
    editor(one).gotoBufferEnd();
    editor(two).setText("/");
    editor(two).gotoBufferEnd();
    await frame(one, "/compact");
    await frame(two, "/compact");
    await prompt(c, "replace-commands");
    await frame(one, "/fresh");
    await frame(two, "/fresh");
    expect(sessionCommands((await sessions(c))[0])?.map((x) => x.name)).toEqual(["fresh"]);
    expect(sessionCommands((await sessions(other))[0])?.map((x) => x.name)).toEqual(["other"]);
    const reopened = await screenFor(c);
    try {
      editor(reopened).setText("/");
      editor(reopened).gotoBufferEnd();
      await frame(reopened, "/fresh");
    } finally {
      reopened.renderer.destroy();
    }
    await prompt(c, "clear-commands");
    await frame(one, "Agent has not published");
    await frame(two, "Agent has not published");
    expect(sessionCommands((await sessions(c))[0])).toEqual([]);
  } finally {
    one.renderer.destroy();
    two.renderer.destroy();
  }
}, 25000);

test("pending switch hides source commands; A → B → A creates fresh session and stale command submission is rejected", async () => {
  const c = await setup("switch");
  const original = (await sessions(c))[0] as NativeSession;
  await prompt(c, "replace-commands");
  await api(`/v1/conversations/${c.id}/harness`, "PUT", { harnessId: "b" });
  await expect(
    prompt(c, "/fresh", "a", { nativeCommand: { nativeSessionId: original.id, name: "fresh" } }),
  ).rejects.toThrow("no longer available");
  const s = await screenFor(c);
  try {
    await s.mockInput.typeText("/");
    await frame(s, "Target Handoff has not completed");
    expect(s.captureCharFrame()).not.toContain("/fresh");
    expect((await users(c)).length).toBe(1);
    await prompt(c, "hello B", "b");
    await frame(s, "/other");
    await api(`/v1/conversations/${c.id}/harness`, "PUT", { harnessId: "a" });
    await frame(s, "Target Handoff has not completed");
    await prompt(c, "hello A", "a");
    await frame(s, "/compact");
    expect(s.captureCharFrame()).not.toContain("/fresh");
    const current = (await api<Conversation>(`/v1/conversations/${c.id}`)).activeNativeSessionId;
    expect(current).not.toBe(original.id);
    await expect(
      prompt(c, "/compact", "a", {
        nativeCommand: { nativeSessionId: original.id, name: "compact" },
      }),
    ).rejects.toThrow("no longer available");
  } finally {
    s.renderer.destroy();
  }
}, 25000);

test("uninitialized/unpublished/closed sessions show precise status and initialize never sends a Prompt", async () => {
  const c = await setup("uninitialized", "none", false);
  const s = await screenFor(c);
  try {
    await s.mockInput.typeText("/");
    await frame(s, "NativeSession not initialized");
    expect((await sessions(c)).length).toBe(0);
    await openCommands(s);
    await frame(s, "Command palette");
    await s.mockInput.typeText("Initialize ACP session");
    s.mockInput.pressEnter();
    await frame(s, "Agent has not published");
    expect((await users(c)).length).toBe(0);
    expect((await sessions(c)).length).toBe(1);
    await api(`/v1/conversations/${c.id}/session/stop`, "POST", {});
    await frame(s, "no longer live");
    expect(sessionCommands((await sessions(c))[0])).toBeUndefined();
  } finally {
    s.renderer.destroy();
  }
});

test("long popup supports keyboard scrolling, mouse completion, narrow resize and Unicode parameters", async () => {
  const c = await setup("long-menu");
  const s = await screenFor(c);
  try {
    await s.mockInput.typeText("/");
    await frame(s, "/compact");
    const scroll = s.renderer.root.findDescendantById("slash-options") as ScrollBoxRenderable;
    for (let i = 0; i < 14; i++) s.mockInput.pressArrow("down");
    await s.renderOnce();
    await s.renderOnce();
    expect(scroll.scrollTop).toBeGreaterThan(0);
    const before = scroll.scrollTop;
    await s.mockMouse.scroll(scroll.x + 2, scroll.y + 1, "down");
    await s.renderOnce();
    expect(scroll.scrollTop).toBeGreaterThanOrEqual(before);
    editor(s).setText("/rev");
    editor(s).gotoBufferEnd();
    await frame(s, "原生审查");
    const item = s.renderer.root.findDescendantById("slash-0");
    if (!item) throw new Error("Missing command row");
    await s.mockMouse.click(item.x + 2, item.y);
    await until(() => editor(s).plainText === "/review");
    expect(editor(s).focused).toBe(true);
    await s.mockInput.pasteBracketedText(" 中文🙂");
    expect(editor(s).plainText).toBe("/review 中文🙂");
    s.mockInput.pressCtrlC();
    await s.mockInput.typeText("/");
    s.resize(35, 12);
    await s.renderOnce();
    await frame(s, "Native compact");
    expect(popup(s)?.height).toBeLessThanOrEqual(6);
    expect(popup(s)?.y).toBeGreaterThanOrEqual(0);
    expect((await users(c)).length).toBe(0);
  } finally {
    s.renderer.destroy();
  }
});

test("advertised command without output records actual ACP response and does not claim success", async () => {
  const c = await setup("silent");
  const nativeSessionId = (await sessions(c))[0]?.id;
  await prompt(c, "/silent", "a", { nativeCommand: { nativeSessionId, name: "silent" } });
  const es = await events(c);
  const result = es.find((e) => e.kind === "runtime.command_result")?.payload as {
    observable: boolean;
    message: string;
    stopReason: string;
  };
  expect(result.observable).toBe(false);
  expect(result.stopReason).toBe("end_turn");
  expect(result.message).toContain("not confirmed");
  expect(
    es.some(
      (e) =>
        e.kind === "acp.response" &&
        (e.raw as { result?: { stopReason?: string } })?.result?.stopReason === "end_turn",
    ),
  ).toBe(true);
});

test("daemon restart reconnects without replay and old persisted command snapshots cannot execute", async () => {
  const c = await setup("restart");
  const old = (await sessions(c))[0] as NativeSession;
  const s = await screenFor(c);
  try {
    await s.mockInput.typeText("/");
    await frame(s, "/compact");
    expect(spawnSync(process.execPath, [cli, "daemon", "stop"]).status).toBe(0);
    await frame(s, "Daemon disconnected");
    expect(spawnSync(process.execPath, [cli, "daemon", "start"]).status).toBe(0);
    await frame(s, "no longer live");
    const rows = await sessions(c);
    expect((rows[0]?.capabilities as { commands?: unknown } | undefined)?.commands).toBeTruthy();
    expect(sessionCommands(rows[0])).toBeUndefined();
    expect((await users(c)).length).toBe(0);
    await expect(
      prompt(c, "/compact", "a", { nativeCommand: { nativeSessionId: old.id, name: "compact" } }),
    ).rejects.toThrow("no longer available");
    expect((await users(c)).length).toBe(0);
  } finally {
    s.renderer.destroy();
  }
}, 20000);
