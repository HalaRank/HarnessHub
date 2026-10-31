import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { App } from "../../apps/tui/src/index";
import { expandProjectPath } from "../../apps/tui/src/project-path";
import { ProjectPathInput } from "../../apps/tui/src/project-path-input";
import { connect } from "../../packages/shared/src/client";

const temp = mkdtempSync(join(tmpdir(), "hhu-tui-"));
const cli = resolve("dist/cli/hhu.js");
const previous = {
  config: process.env.XDG_CONFIG_HOME,
  data: process.env.XDG_DATA_HOME,
  state: process.env.XDG_STATE_HOME,
};
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = join(temp, "config");
  process.env.XDG_DATA_HOME = join(temp, "data");
  process.env.XDG_STATE_HOME = join(temp, "state");
  const result = spawnSync(process.execPath, [cli, "daemon", "start"], { env: process.env });
  expect(result.status).toBe(0);
});
afterAll(() => {
  spawnSync(process.execPath, [cli, "daemon", "stop"], { env: process.env });
  for (const [key, value] of [
    ["XDG_CONFIG_HOME", previous.config],
    ["XDG_DATA_HOME", previous.data],
    ["XDG_STATE_HOME", previous.state],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
test("Solid view registers real workspace and empty conversation through authenticated Daemon", async () => {
  let exited = false;
  const screen = await testRender(
    () => (
      <App
        onExit={() => {
          exited = true;
        }}
      />
    ),
    { width: 100, height: 30 },
  );
  const waitFor = async (text: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await screen.renderOnce();
      if (screen.captureCharFrame().includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Frame did not contain ${text}:\n${screen.captureCharFrame()}`);
  };
  try {
    await waitFor("Connected");
    await waitFor("No projects");
    screen.mockInput.pressKey("p");
    await waitFor("Existing project");
    expect(screen.captureCharFrame()).toContain("~/");
    await screen.mockInput.typeText(relative(homedir(), temp).slice(0, -1));
    screen.mockInput.pressTab();
    await waitFor(`${temp.split("/").at(-1)}/`);
    screen.mockInput.pressEnter();
    await waitFor("Press n to create");
    screen.mockInput.pressKey("n");
    await waitFor("New conversation title");
    await screen.mockInput.typeText("Real empty conversation");
    screen.mockInput.pressEnter();
    await waitFor("└ Real empty");
    screen.mockInput.pressArrow("down");
    await waitFor("Conversation · IDLE");
    expect(screen.captureCharFrame()).toContain("No Agent output yet");
    const client = await connect();
    const snapshot = await client?.request<{
      projects: { rootPath: string }[];
      conversations: { workspacePath: string }[];
    }>("/v1/snapshot");
    expect(snapshot?.projects[0]?.rootPath).toBe(temp);
    expect(snapshot?.conversations[0]?.workspacePath).toBe(temp);
    screen.mockInput.pressKey("q");
    for (let i = 0; i < 100 && !exited; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exited).toBe(true);
  } finally {
    await screen.dispose();
  }
  expect(await connect()).not.toBeNull();
}, 15000);

test("project directory Tab completes common prefixes, spaces, Unicode and symlinks without submitting", async () => {
  const root = join(temp, "completion");
  for (const name of ["project alpha", "project alpine", "项目", ".hidden"])
    mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, "project file"), "not a directory");
  symlinkSync(join(root, "项目"), join(root, "linked"));
  symlinkSync(join(root, "missing"), join(root, "broken"));
  let submitted = "";
  const screen = await testRender(
    () => (
      <ProjectPathInput
        busy={false}
        onSubmit={(value) => {
          submitted = value;
        }}
      />
    ),
    { width: 120, height: 15 },
  );
  const input = screen.renderer.root.findDescendantById("project-path") as InputRenderable;
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      await screen.renderOnce();
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Completion did not settle: ${screen.captureCharFrame()}`);
  };
  try {
    expect(input.value).toBe("~/");
    input.value = `${root}/project `;
    screen.mockInput.pressTab();
    await waitFor(() => input.value === `${root}/project alp`);
    expect(screen.captureCharFrame()).toContain("project alpha/");
    expect(screen.captureCharFrame()).toContain("project alpine/");
    expect(screen.captureCharFrame()).not.toContain("project file");
    await screen.mockInput.typeText("h");
    screen.mockInput.pressTab();
    await waitFor(() => input.value === `${root}/project alpha/`);
    expect(submitted).toBe("");
    screen.mockInput.pressEnter();
    expect(submitted).toBe(`${root}/project alpha/`);

    for (const [prefix, expected] of [
      ["项", "项目/"],
      ["link", "linked/"],
      [".h", ".hidden/"],
    ]) {
      input.value = `${root}/${prefix}`;
      screen.mockInput.pressTab();
      await waitFor(() => input.value === `${root}/${expected}`);
    }
    input.value = `${root}/`;
    screen.mockInput.pressTab();
    await waitFor(() => screen.captureCharFrame().includes("linked/"));
    expect(screen.captureCharFrame()).not.toContain(".hidden/");
    expect(screen.captureCharFrame()).not.toContain("broken/");

    input.value = `${root}/missing`;
    screen.mockInput.pressTab();
    await waitFor(() => screen.captureCharFrame().includes("No matching directories"));
    expect(input.value).toBe(`${root}/missing`);
    input.value = `${root}/missing/`;
    screen.mockInput.pressTab();
    await waitFor(() => screen.captureCharFrame().includes("Cannot read this directory"));
    input.value = `${root}/project alph/suffix`;
    input.cursorOffset = `${root}/project alph`.length;
    screen.mockInput.pressTab();
    await waitFor(() => input.value === `${root}/project alpha/suffix`);

    input.value = `${root}/link`;
    screen.mockInput.pressTab();
    await screen.mockInput.typeText("x");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(input.value).toBe(`${root}/linkx`);
    expect(expandProjectPath("~")).toBe(homedir());
    expect(expandProjectPath(`~/${relative(homedir(), temp)}`)).toBe(temp);
    expect(expandProjectPath(relative(homedir(), temp))).toBe(temp);
  } finally {
    await screen.dispose();
  }
});

test("minimal ACP view sends once, preserves native choices and waits for a user decision", async () => {
  const client = await connect();
  if (!client) throw new Error("Daemon not running");
  await client.request("/v1/harness-profiles", "POST", {
    id: "mock",
    name: "Mock ACP",
    command: "node",
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
  });
  const project = await client.request<{ id: string }>("/v1/projects", "POST", { rootPath: temp });
  const c = await client.request<{ id: string }>(
    `/v1/projects/${project.id}/conversations`,
    "POST",
    { title: "UI ACP permission" },
  );
  const screen = await testRender(() => <App onExit={() => {}} />, { width: 120, height: 42 });
  const waitFor = async (text: string) => {
    for (let i = 0; i < 150; i++) {
      await screen.renderOnce();
      if (screen.captureCharFrame().includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Missing ${text}:\n${screen.captureCharFrame()}`);
  };
  try {
    await waitFor("UI ACP permission");
    screen.mockInput.pressArrow("down");
    screen.mockInput.pressArrow("down");
    await waitFor("No Agent output yet");
    await waitFor("m Message");
    for (let i = 0; i < 4; i++) screen.mockInput.pressKey("h");
    await waitFor("ACP · mock");
    screen.mockInput.pressKey("m");
    await waitFor("Enter send");
    await screen.mockInput.typeText("permission");
    screen.mockInput.pressEnter();
    await waitFor("Native permission");
    await waitFor("Reject (native)");
    expect((await client.request<unknown[]>(`/v1/conversations/${c.id}/approvals`)).length).toBe(1);
    screen.mockInput.pressKey("a");
    await waitFor("Option number");
    await screen.mockInput.typeText("2");
    screen.mockInput.pressEnter();
    await waitFor('"outcome":"selected"');
    expect((await client.request<unknown[]>(`/v1/conversations/${c.id}/approvals`)).length).toBe(0);
    const page = await client.request<{ events: { raw?: { method?: string }; origin: string }[] }>(
      `/v1/conversations/${c.id}/events?limit=1000`,
    );
    expect(
      page.events.filter((e) => e.origin === "client" && e.raw?.method === "session/prompt").length,
    ).toBe(1);
  } finally {
    await screen.dispose();
    await client.request(`/v1/conversations/${c.id}/session/stop`, "POST", {
      force: true,
      confirmed: true,
    });
  }
}, 20000);

test("native tool success collapses by default and manual expansion survives updates", async () => {
  const { createSignal } = await import("solid-js");
  const { NativeEvents } = await import("../../apps/tui/src/native-events");
  const [events, setEvents] = createSignal<
    import("../../packages/shared/src/runtime").ConversationEvent[]
  >([]);
  const event = (
    payload: unknown,
    seq: number,
  ): import("../../packages/shared/src/runtime").ConversationEvent => ({
    id: String(seq),
    conversationId: "ui",
    nativeSessionId: "native",
    turnId: "turn",
    seq,
    raw: null,
    payload,
    kind: seq === 1 ? "tool_call" : "tool_call_update",
    origin: "agent",
    createdAt: seq,
  });
  const screen = await testRender(() => <NativeEvents events={events()} disabled={false} />, {
    width: 100,
    height: 20,
  });
  try {
    setEvents([
      event(
        {
          toolCallId: "tool",
          title: "Native Exact Tool",
          status: "in_progress",
          rawOutput: "RUNNING_NATIVE_CONTENT",
        },
        1,
      ),
    ]);
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("RUNNING_NATIVE_CONTENT");
    setEvents((e) => [
      ...e,
      event({ toolCallId: "tool", status: "completed", rawOutput: "SUCCESS_NATIVE_CONTENT" }, 2),
    ]);
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("SUCCESS_NATIVE_CONTENT");
    screen.mockInput.pressKey("e");
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("SUCCESS_NATIVE_CONTENT");
    setEvents((e) => [...e, event({ toolCallId: "tool", rawOutput: "UPDATED_NATIVE_CONTENT" }, 3)]);
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("UPDATED_NATIVE_CONTENT");
  } finally {
    await screen.dispose();
  }
});

async function waitFrame(screen: Awaited<ReturnType<typeof testRender>>, text: string) {
  for (let i = 0; i < 200; i++) {
    await screen.renderOnce();
    if (screen.captureCharFrame().includes(text)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Missing ${text}:\n${screen.captureCharFrame()}`);
}

test("drafts stay isolated when switching Conversations and restore with recent selection and preference after TUI exit", async () => {
  const client = await connect();
  if (!client) throw new Error("Daemon not running");
  const root = join(temp, "draft-workspace");
  mkdirSync(root);
  const p = await client.request<{ id: string }>("/v1/projects", "POST", {
    rootPath: root,
    name: "Draft project",
  });
  const a = await client.request<{ id: string }>(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "Draft Alpha",
  });
  const b = await client.request<{ id: string }>(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "Draft Beta",
  });
  await client.request("/v1/preferences", "PATCH", {
    lastConversationId: a.id,
    showActivity: true,
  });
  let exited = false;
  let screen = await testRender(
    () => (
      <App
        onExit={() => {
          exited = true;
        }}
      />
    ),
    { width: 150, height: 45 },
  );
  try {
    await waitFrame(screen, "m Message");
    screen.mockInput.pressKey("m");
    await waitFrame(screen, "Enter send");
    await screen.mockInput.typeText("Alpha 草稿");
    screen.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    screen.mockInput.pressArrow("down");
    await waitFrame(screen, "│ Draft Beta");
    await waitFrame(screen, "m Message");
    screen.mockInput.pressKey("m");
    await waitFrame(screen, "Enter send");
    await screen.mockInput.typeText("Beta pending");
    screen.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    screen.mockInput.pressArrow("up");
    await waitFrame(screen, "│ Draft Alpha");
    await waitFrame(screen, "m Message");
    screen.mockInput.pressKey("m");
    await waitFrame(screen, "Alpha 草稿");
    screen.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    screen.mockInput.pressKey("g", { ctrl: true });
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("Global · Running");
    screen.mockInput.pressKey("q");
    for (let i = 0; i < 100 && !exited; i++) await new Promise((r) => setTimeout(r, 20));
    expect(exited).toBe(true);
    expect((await client.request<{ text: string }>(`/v1/conversations/${a.id}/draft`)).text).toBe(
      "Alpha 草稿",
    );
    expect((await client.request<{ text: string }>(`/v1/conversations/${b.id}/draft`)).text).toBe(
      "Beta pending",
    );
    await screen.dispose();
    screen = await testRender(() => <App onExit={() => {}} />, { width: 150, height: 45 });
    await waitFrame(screen, "m Message");
    expect(screen.captureCharFrame()).not.toContain("Global · Running");
    screen.mockInput.pressKey("m");
    await waitFrame(screen, "Alpha 草稿");
    expect(
      (await client.request<{ events: unknown[] }>(`/v1/conversations/${a.id}/events`)).events
        .length,
    ).toBe(0);
  } finally {
    await screen.dispose();
  }
}, 20000);

test("background approval is discoverable in another Project, survives TUI exit and reconnects to the same Worker", async () => {
  const client = await connect();
  if (!client) throw new Error("Daemon not running");
  const root = join(temp, "background-workspace");
  mkdirSync(root);
  const p = await client.request<{ id: string }>("/v1/projects", "POST", {
    rootPath: root,
    name: "Background project",
  });
  const c = await client.request<{ id: string }>(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "Background permission",
  });
  const t = await client.request<{ id: string }>(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    message: "permission",
    harnessId: "mock",
  });
  await client.request("/v1/preferences", "PATCH", {
    lastConversationId: null,
    lastProjectId: p.id,
    showActivity: true,
  });
  let screen = await testRender(() => <App onExit={() => {}} />, { width: 160, height: 45 });
  try {
    await waitFrame(screen, "Approval 1 (1 requests)");
    await waitFrame(screen, "WAITING_APPROVAL");
    const before = await client.request<{ id: string; workerId: string }[]>(
      `/v1/conversations/${c.id}/sessions`,
    );
    await screen.dispose();
    expect((await client.request<{ state: string }>(`/v1/turns/${t.id}`)).state).toBe(
      "WAITING_APPROVAL",
    );
    await client.request("/v1/preferences", "PATCH", { lastConversationId: c.id });
    screen = await testRender(() => <App onExit={() => {}} />, { width: 160, height: 45 });
    await waitFrame(screen, "Native permission");
    expect(await client.request<typeof before>(`/v1/conversations/${c.id}/sessions`)).toEqual(
      before,
    );
    await waitFrame(screen, "m Message");
    screen.mockInput.pressKey("a");
    await waitFrame(screen, "Option number");
    await screen.mockInput.typeText("2");
    screen.mockInput.pressEnter();
    await waitFrame(screen, '"outcome":"selected"');
    expect((await client.request<unknown[]>(`/v1/conversations/${c.id}/approvals`)).length).toBe(0);
  } finally {
    await screen.dispose();
    await client.request(`/v1/conversations/${c.id}/session/stop`, "POST", {
      force: true,
      confirmed: true,
    });
  }
}, 20000);

test("persisted unconfirmed submission is read on reopen and explicit retries retain one requestId", async () => {
  const { DraftSession } = await import("../../apps/tui/src/draft-session");
  const client = await connect();
  if (!client) throw new Error("Daemon not running");
  const p = await client.request<{ id: string }>("/v1/projects", "POST", { rootPath: temp });
  const c = await client.request<{ id: string }>(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "Lost ACK draft",
  });
  const editor = () =>
    new DraftSession(
      c.id,
      () => {},
      (e) => {
        throw e;
      },
    );
  const first = editor();
  await first.load();
  first.update("stream");
  const input = await first.prepare("mock");
  await first.dispose();
  const reopened = editor();
  await reopened.load();
  expect(reopened.value.pendingSubmission?.requestId).toBe(input.requestId);
  expect(
    (await client.request<{ events: unknown[] }>(`/v1/conversations/${c.id}/events`)).events.length,
  ).toBe(0);
  const same = await reopened.prepare("mock");
  expect(same).toEqual(input);
  const turn = await client.request<{ id: string }>(
    `/v1/conversations/${c.id}/turns`,
    "POST",
    same,
  );
  // Simulate the HTTP ACK being lost: destroy the editor without calling accepted().
  await reopened.dispose();
  // Simulate a crash after Turn commit and before consuming its reserved draft.
  const reserved = await client.request<{ revision: number }>(`/v1/conversations/${c.id}/draft`);
  await client.request(`/v1/conversations/${c.id}/draft`, "PUT", {
    revision: reserved.revision,
    text: input.message,
    pendingSubmission: input,
  });
  const recovered = editor();
  await recovered.load();
  expect(recovered.text).toBe("");
  expect(recovered.value.pendingSubmission).toBeNull();
  expect((await client.request<{ id: string }>(`/v1/requests/${input.requestId}`)).id).toBe(
    turn.id,
  );
  for (let i = 0; i < 150; i++) {
    if ((await client.request<{ endedAt: number | null }>(`/v1/turns/${turn.id}`)).endedAt) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(
    (await client.request<{ id: string }>(`/v1/conversations/${c.id}/turns`, "POST", input)).id,
  ).toBe(turn.id);
  const page = await client.request<{
    events: { raw: { method?: string } | null; origin: string }[];
  }>(`/v1/conversations/${c.id}/events?limit=1000`);
  expect(
    page.events.filter((e) => e.raw?.method === "session/prompt" && e.origin === "client").length,
  ).toBe(1);
  await recovered.dispose();
  await client.request(`/v1/conversations/${c.id}/session/stop`, "POST", {});
});

test("a failed save while leaving a Conversation remains available for the next exit flush", async () => {
  const { DraftSession, flushDrafts } = await import("../../apps/tui/src/draft-session");
  const client = await connect();
  if (!client) throw new Error("Daemon not running");
  const p = await client.request<{ id: string }>("/v1/projects", "POST", { rootPath: temp });
  const c = await client.request<{ id: string }>(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "Offline draft",
  });
  const draft = new DraftSession(
    c.id,
    () => {},
    () => {},
  );
  await draft.load();
  draft.update("unsaved while switching Conversation");
  const realRequest = draft.request.bind(draft);
  let offline = true;
  draft.request = async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
    if (offline && method === "PUT") throw new Error("Injected network disconnect");
    return realRequest<T>(path, method, body);
  };
  await expect(draft.dispose()).rejects.toThrow("Injected network disconnect");
  expect((await client.request<{ text: string }>(`/v1/conversations/${c.id}/draft`)).text).toBe("");
  offline = false;
  await flushDrafts();
  expect((await client.request<{ text: string }>(`/v1/conversations/${c.id}/draft`)).text).toBe(
    "unsaved while switching Conversation",
  );
});
