import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../../apps/tui/src/index";
import { NativeEvents } from "../../apps/tui/src/native-events";
import { newViewState, Transcript } from "../../apps/tui/src/transcript";
import { connect } from "../../packages/shared/src/client";
import type {
  Conversation,
  ConversationEvent,
  Handoff,
  Turn,
} from "../../packages/shared/src/index";

const temp = mkdtempSync(join(tmpdir(), "hhu-phase5-ui-")),
  previous = { ...process.env },
  cli = resolve("dist/cli/hhu.js");
beforeAll(async () => {
  Object.assign(process.env, {
    XDG_CONFIG_HOME: join(temp, "config"),
    XDG_DATA_HOME: join(temp, "data"),
    XDG_STATE_HOME: join(temp, "state"),
  });
  expect(spawnSync(process.execPath, [cli, "daemon", "start"]).status).toBe(0);
  for (const id of ["a", "b", "bad"])
    await api("/v1/harness-profiles", "POST", {
      id,
      name: id,
      command: "node",
      args: [resolve("tests/fixtures/mock-acp/server.mjs")],
      envOverrides: id === "bad" ? { HHU_MOCK_REPORT_FAIL: "1" } : {},
    });
});
afterAll(() => {
  spawnSync(process.execPath, [cli, "daemon", "stop", "--cancel-active"]);
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k];
  }
  console.log(`Phase-5 UI evidence: ${temp}`);
});
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const c = await connect();
  if (!c) throw new Error("Test Daemon unavailable");
  return c.request<T>(path, method, body);
}
async function until(check: () => boolean | Promise<boolean>, label = "Phase 5 UI") {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(label);
}
async function frame(s: Awaited<ReturnType<typeof testRender>>, text: string) {
  await until(async () => {
    await s.renderOnce();
    return s.captureCharFrame().includes(text);
  }, text);
}
async function setup(title: string) {
  const root = join(temp, title);
  mkdirSync(root);
  const p = await api<{ id: string }>("/v1/projects", "POST", { rootPath: root, name: title });
  const c = await api<Conversation>(`/v1/projects/${p.id}/conversations`, "POST", { title });
  await api("/v1/preferences", "PATCH", {
    lastConversationId: c.id,
    showSidebar: false,
    shortcuts: {},
  });
  return { c, p, root };
}
const submit = (c: Conversation, harnessId = "a", message = "stream") =>
  api<Turn>(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId,
    message,
  });
const settle = (t: Turn) =>
  until(async () => (await api<Turn>(`/v1/turns/${t.id}`)).endedAt !== null);
const es = (c: Conversation) =>
  api<{ events: ConversationEvent[] }>(`/v1/conversations/${c.id}/events?limit=1000`);

const event = (
  seq: number,
  kind: string,
  payload: unknown,
  purpose: "user" | "handoff_internal" = "user",
): ConversationEvent => ({
  id: `event-${seq}`,
  conversationId: "c",
  nativeSessionId: "n",
  turnId: "t",
  seq,
  raw: { exact: true },
  kind,
  payload,
  purpose,
  origin: "agent",
  createdAt: seq,
});

test("internal report events remain available in Debug without appearing as user/agent chat; one expandable Handoff row preserves complete report and sources", async () => {
  const model = new Transcript(),
    report = "## Current Objective\nExact user decision 世界\n\n```ts\n  keepIndent();\n```";
  const record = {
    id: "h",
    sourceHarness: "Codex",
    targetHarness: "Grok",
    status: "GENERATING",
    sourceEventStart: 1,
    sourceEventEnd: 8,
    sourceNativeSessionId: "source-native",
    generatedAt: 1000,
  };
  model.append([
    event(1, "user.message", { text: "real user" }),
    event(2, "session/prompt", { text: "INTERNAL SECRET PROMPT" }, "handoff_internal"),
    event(3, "agent_message_chunk", { content: { text: "INTERNAL STREAM" } }, "handoff_internal"),
    event(4, "handoff.record", record),
    event(5, "handoff.record", { ...record, status: "COMMITTED", reportText: report }),
  ]);
  expect(model.events.length).toBe(5);
  expect(model.rows.length).toBe(2);
  expect(model.rows.some((r) => r.value().text.includes("INTERNAL"))).toBe(false);
  const row = model.rows[1];
  expect(row?.sources.map((e) => e.seq)).toEqual([4, 5]);
  expect(row?.value().text).toContain(report);
  const view = newViewState();
  view.selected = 1;
  const screen = await testRender(
    () => <NativeEvents model={model} view={view} disabled={false} />,
    { width: 140, height: 35 },
  );
  try {
    await frame(screen, "Codex → Grok");
    expect(screen.captureCharFrame()).not.toContain("Exact user decision");
    screen.mockInput.pressKey("e");
    await frame(screen, "Exact user decision");
    await frame(screen, "source-native");
    screen.mockInput.pressKey("y");
    await frame(screen, "Original Markdown");
  } finally {
    screen.renderer.destroy();
  }
}, 20000);

test("TUI Harness selection persists pending state, x cancels, and first message performs one Handoff with retained draft CAS", async () => {
  const { c } = await setup("Pending real API");
  await settle(await submit(c));
  const before = (await es(c)).events.filter(
    (e) => e.raw && (e.raw as { method?: string }).method === "session/prompt",
  ).length;
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 38 });
  try {
    await frame(screen, "ACP · a");
    await frame(screen, "m Message");
    screen.mockInput.pressKey("h");
    await frame(screen, "PENDING_SWITCH");
    expect((await api<Conversation>(`/v1/conversations/${c.id}`)).selectedHarnessId).toBe("b");
    expect(
      (await es(c)).events.filter(
        (e) => (e.raw as { method?: string } | null)?.method === "session/prompt",
      ).length,
    ).toBe(before);
    screen.mockInput.pressKey("x");
    await until(
      async () => (await api<Conversation>(`/v1/conversations/${c.id}`)).selectedHarnessId === "a",
    );
    screen.mockInput.pressKey("h");
    await frame(screen, "PENDING_SWITCH");
    screen.mockInput.pressKey("m");
    await screen.renderOnce();
    await screen.mockInput.typeText("timed");
    screen.mockInput.pressEnter();
    screen.mockInput.pressEnter();
    await frame(screen, "Handoff a → b · DELIVERING");
    expect(screen.captureCharFrame()).toContain("ACP · b");
    await until(
      async () =>
        (await api<Handoff[]>(`/v1/conversations/${c.id}/handoffs`))[0]?.status === "COMMITTED",
    );
    await frame(screen, "ACP · b");
    expect((await es(c)).events.filter((e) => e.kind === "user.message").length).toBe(2);
    expect(
      (await es(c)).events.filter(
        (e) => (e.raw as { method?: string } | null)?.method === "session/prompt",
      ).length,
    ).toBe(3);
    expect((await api<{ text: string }>(`/v1/conversations/${c.id}/draft`)).text).toBe("");
  } finally {
    screen.renderer.destroy();
  }
}, 20000);

test("failed Handoff TUI exposes saved materials and requires explicit degraded confirmation before dispatch", async () => {
  const { c } = await setup("Degraded confirmation");
  await settle(await submit(c, "bad"));
  await submit(c, "b", "reserved UI user");
  await until(
    async () =>
      (await api<Handoff[]>(`/v1/conversations/${c.id}/handoffs`))[0]?.status === "FAILED",
  );
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 160, height: 45 });
  try {
    await frame(screen, "Target task has NOT been sent.");
    await frame(screen, "m Message");
    screen.mockInput.pressKey("f");
    await frame(screen, "View saved context");
    expect((await api<unknown[]>(`/v1/conversations/${c.id}/sessions`)).length).toBe(1);
    screen.mockInput.pressArrow("down");
    screen.mockInput.pressEnter();
    await until(
      async () =>
        (await api<Handoff[]>(`/v1/conversations/${c.id}/handoffs`))[0]?.status === "COMMITTED",
    );
    const h = (await api<Handoff[]>(`/v1/conversations/${c.id}/handoffs`))[0];
    expect(h?.degraded).toBe(true);
    expect(h?.confirmedAt).toBeTruthy();
    expect((await es(c)).events.filter((e) => e.kind === "user.message").length).toBe(2);
  } finally {
    screen.renderer.destroy();
  }
}, 20000);

test("TUI creates independent Worktree with Ctrl+W; safe cleanup is independent and asks for CLEAN confirmation", async () => {
  const { p, root } = await setup("Worktree UI");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  writeFileSync(join(root, "test.txt"), "safe");
  git("add", ".");
  git("-c", "user.name=HHU", "-c", "user.email=test@localhost", "commit", "-m", "fixture");
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 160, height: 40 });
  try {
    await frame(screen, "m Message");
    screen.mockInput.pressKey("n");
    await frame(screen, "Ctrl+W");
    screen.mockInput.pressKey("w", { ctrl: true });
    await frame(screen, "worktree");
    await screen.mockInput.typeText("Isolated UI");
    screen.mockInput.pressEnter();
    let created: Conversation | undefined;
    await until(async () => {
      created = (await api<Conversation[]>(`/v1/projects/${p.id}/conversations`)).find(
        (c) => c.title === "Isolated UI",
      );
      return !!created;
    });
    expect(created?.workspaceMode).toBe("worktree");
    expect(existsSync(created?.workspacePath ?? "")).toBe(true);
    await api(`/v1/conversations/${created?.id}`, "DELETE", { confirmed: true });
    expect(existsSync(created?.workspacePath ?? "")).toBe(true);
    screen.mockInput.pressKey("p", { ctrl: true });
    await frame(screen, "Command palette");
    await screen.mockInput.typeText("Manage Worktrees");
    screen.mockInput.pressEnter();
    await frame(screen, "Managed Worktrees");
    screen.mockInput.pressEnter();
    await frame(screen, "Type CLEAN");
    expect(existsSync(created?.workspacePath ?? "")).toBe(true);
    await screen.mockInput.typeText("CLEAN");
    screen.mockInput.pressEnter();
    await until(() => !existsSync(created?.workspacePath ?? ""));
  } finally {
    screen.renderer.destroy();
  }
}, 20000);
