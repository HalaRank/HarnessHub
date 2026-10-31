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
