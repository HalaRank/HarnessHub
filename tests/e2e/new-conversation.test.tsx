import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TextareaRenderable, TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { App } from "../../apps/tui/src/index";
import { conversationKey, projectKey } from "../../apps/tui/src/project-tree";
import { connect } from "../../packages/shared/src/client";
import type { Conversation, Draft, Project, Snapshot } from "../../packages/shared/src/index";
import { clickControl, openCommands } from "./ui-actions";

const temp = mkdtempSync(join(tmpdir(), "hhu-new-conversation-"));
const launchCwd = join(temp, "launch");
const previous = { ...process.env };
const cli = resolve("dist/cli/hhu.js");
type Screen = Awaited<ReturnType<typeof testRender>>;

beforeAll(async () => {
  mkdirSync(launchCwd);
  Object.assign(process.env, {
    XDG_CONFIG_HOME: join(temp, "config"),
    XDG_DATA_HOME: join(temp, "data"),
    XDG_STATE_HOME: join(temp, "state"),
  });
  expect(spawnSync(process.execPath, [cli, "daemon", "start"]).status).toBe(0);
});

afterAll(() => {
  spawnSync(process.execPath, [cli, "daemon", "stop", "--cancel-active"]);
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  console.log(`New conversation evidence: ${temp}`);
});

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const client = await connect();
  if (!client) throw new Error("No test Daemon");
  return client.request<T>(path, method, body);
}

async function waitFor(screen: Screen, check: () => boolean | Promise<boolean>) {
  for (let count = 0; count < 300; count++) {
    await screen.renderOnce();
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${screen.captureCharFrame()}`);
}

function editor(screen: Screen) {
  return screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable | undefined;
}

async function conversations() {
  return (await api<Snapshot>("/v1/snapshot")).conversations;
}

async function setup(name: string) {
  const rootPath = join(temp, name);
  mkdirSync(rootPath);
  const project = await api<Project>("/v1/projects", "POST", { rootPath, name });
  const conversation = await api<Conversation>(`/v1/projects/${project.id}/conversations`, "POST", {
    title: `${name} existing`,
  });
  return { project, conversation };
}

test("Ctrl+N works without projects and restores an ungrouped conversation at the captured launch path", async () => {
  let screen = await testRender(() => <App launchCwd={launchCwd} onExit={() => {}} />, {
    width: 140,
    height: 35,
  });
  let created: Conversation | undefined;
  try {
    await waitFor(screen, () => screen.captureCharFrame().includes("No projects yet"));
    screen.mockInput.pressKey("n");
    await screen.renderOnce();
    expect(await conversations()).toHaveLength(0);
    screen.mockInput.pressKey("n", { ctrl: true });
    screen.mockInput.pressKey("n", { ctrl: true });
    screen.mockInput.pressKey("n", { ctrl: true });
    await waitFor(screen, async () => {
      created = (await conversations())[0];
      return !!created && !!editor(screen)?.focused;
    });
    expect(created?.projectId).toBeNull();
    expect(created?.workspacePath).toBe(launchCwd);
    expect(await conversations()).toHaveLength(1);
    expect((await api<Snapshot>("/v1/snapshot")).projects).toEqual([]);
    expect(
      screen.renderer.root.findDescendantById(conversationKey(created?.id ?? "")),
    ).toBeDefined();
    await waitFor(screen, async () => {
      const prefs = await api<{ lastConversationId: string; lastProjectId: string | null }>(
        "/v1/preferences",
      );
      return prefs.lastConversationId === created?.id && prefs.lastProjectId === null;
    });
  } finally {
    screen.renderer.destroy();
  }
  screen = await testRender(() => <App launchCwd={temp} onExit={() => {}} />, {
    width: 140,
    height: 35,
  });
  try {
    await waitFor(
      screen,
      () =>
        (screen.renderer.root.findDescendantById("workspace-path") as TextRenderable | undefined)
          ?.plainText === launchCwd,
    );
    expect(screen.captureCharFrame()).toContain("New conversation");
    expect((await api<Conversation>(`/v1/conversations/${created?.id}`)).workspacePath).toBe(
      launchCwd,
    );
    screen.mockInput.pressKey("n", { ctrl: true });
    await waitFor(
      screen,
      async () => (await conversations()).length === 2 && !!editor(screen)?.focused,
    );
    expect((await conversations()).at(-1)?.workspacePath).toBe(temp);
    expect((await api<Snapshot>("/v1/snapshot")).projects).toEqual([]);
  } finally {
    screen.renderer.destroy();
  }
});

test("N uses the selected project or child, does not steal chat input, and Ctrl+N preserves the draft", async () => {
  const { project, conversation } = await setup("selected-project");
  const { project: other } = await setup("other-project");
  await api("/v1/preferences", "PATCH", { lastProjectId: other.id, lastConversationId: null });
  const screen = await testRender(
    () => <App initialProjectId={project.id} launchCwd={launchCwd} onExit={() => {}} />,
    { width: 150, height: 35 },
  );
  try {
    await waitFor(screen, () =>
      screen.captureCharFrame().includes(`Workspace · ${project.rootPath}`),
    );
    const before = (await conversations()).length;
    screen.mockInput.pressKey("n");
    await waitFor(
      screen,
      async () => (await conversations()).length === before + 1 && !!editor(screen)?.focused,
    );
    const first = (await conversations()).find(
      (value) => value.projectId === project.id && value.id !== conversation.id,
    );
    expect(first?.workspacePath).toBe(project.rootPath);
    await screen.mockInput.typeText("nN draft");
    await screen.renderOnce();
    expect(editor(screen)?.plainText).toBe("nN draft");
    expect(await conversations()).toHaveLength(before + 1);
    screen.mockInput.pressKey("n", { ctrl: true });
    await waitFor(
      screen,
      async () => (await conversations()).length === before + 2 && editor(screen)?.plainText === "",
    );
    const standalone = (await conversations()).filter((value) => value.projectId === null).at(-1);
    expect(standalone?.workspacePath).toBe(launchCwd);
    expect((await api<Draft>(`/v1/conversations/${first?.id}/draft`)).text).toBe("nN draft");
    await clickControl(screen, conversationKey(conversation.id));
    screen.mockInput.pressKey("n", { shift: true });
    await waitFor(
      screen,
      async () => (await conversations()).length === before + 3 && !!editor(screen)?.focused,
    );
    expect((await conversations()).filter((value) => value.projectId === project.id)).toHaveLength(
      3,
    );
    expect((await api<Snapshot>("/v1/snapshot")).projects).toHaveLength(2);
  } finally {
    screen.renderer.destroy();
  }
});

test("conversation shortcuts do not create while a modal or chat history owns the keys", async () => {
  const { project, conversation } = await setup("focus-routing");
  const screen = await testRender(
    () => <App initialProjectId={project.id} launchCwd={launchCwd} onExit={() => {}} />,
    { width: 150, height: 35 },
  );
  try {
    await waitFor(screen, () =>
      screen.captureCharFrame().includes(`Workspace · ${project.rootPath}`),
    );
    const before = (await conversations()).length;
    await openCommands(screen);
    await screen.mockInput.typeText("n");
    screen.mockInput.pressKey("n", { ctrl: true });
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("Command palette");
    expect(await conversations()).toHaveLength(before);
    screen.mockInput.pressEscape();
    await waitFor(screen, () => !screen.captureCharFrame().includes("Command palette"));
    await clickControl(screen, conversationKey(conversation.id));
    screen.mockInput.pressKey("t", { ctrl: true });
    await screen.renderOnce();
    screen.mockInput.pressKey("n");
    await screen.renderOnce();
    expect(await conversations()).toHaveLength(before);
    screen.mockInput.pressKey("n", { ctrl: true });
    await waitFor(
      screen,
      async () => (await conversations()).length === before + 1 && !!editor(screen)?.focused,
    );
    expect((await conversations()).at(-1)?.projectId).toBeNull();
    screen.mockInput.pressEscape();
    await clickControl(screen, projectKey(project.id));
    screen.mockInput.pressKey("n", { meta: true });
    await screen.renderOnce();
    expect(await conversations()).toHaveLength(before + 1);
  } finally {
    screen.renderer.destroy();
  }
});

test("workspace overview opens conversations and creates in the selected project without starting an Agent", async () => {
  const { project, conversation } = await setup("HarnessHub workspace");
  mkdirSync(join(project.rootPath, "src"));
  writeFileSync(join(project.rootPath, "README.md"), "# Workspace fixture\n");
  const screen = await testRender(
    () => <App initialProjectId={project.id} launchCwd={launchCwd} onExit={() => {}} />,
    { width: 150, height: 35 },
  );
  try {
    await waitFor(
      screen,
      () => !!screen.renderer.root.findDescendantById("project-new-conversation"),
    );
    for (const [width, height] of [
      [150, 35],
      [100, 30],
      [70, 24],
      [35, 12],
      [150, 35],
    ] as const) {
      screen.resize(width, height);
      for (let i = 0; i < 5; i++) await screen.renderOnce();
      const button = screen.renderer.root.findDescendantById("project-new-conversation");
      const directory = screen.renderer.root.findDescendantById("project-directory");
      if (!button || !directory) throw new Error("Missing project controls after resize");
      expect(button.x + button.width).toBeLessThanOrEqual(width);
      expect(directory.y + directory.height).toBeLessThanOrEqual(height - 1);
      expect(screen.captureCharFrame()).toContain("README.md");
      writeFileSync(join(temp, `workspace-${width}.txt`), screen.captureCharFrame());
      writeFileSync(join(temp, `workspace-${width}.json`), JSON.stringify(screen.captureSpans()));
    }
    await clickControl(screen, `recent-${conversation.id}`);
    await waitFor(screen, () => !!editor(screen));
    expect(
      (screen.renderer.root.findDescendantById("workspace-heading") as TextRenderable).plainText,
    ).toBe(conversation.title);
    await clickControl(screen, projectKey(project.id));
    await waitFor(
      screen,
      () => !!screen.renderer.root.findDescendantById("project-new-conversation"),
    );
    const before = (await conversations()).length;
    await clickControl(screen, "project-new-conversation");
    await waitFor(
      screen,
      async () => (await conversations()).length === before + 1 && !!editor(screen)?.focused,
    );
    const created = (await conversations()).find(
      (c) => c.projectId === project.id && c.id !== conversation.id,
    );
    expect(created?.workspacePath).toBe(project.rootPath);
    expect(created?.workspacePath).not.toBe(launchCwd);
    expect(created?.activeNativeSessionId).toBeNull();
    expect(created?.runtimeStatus).toBe("IDLE");
    await screen.mockInput.typeText("Keep this local draft");
    await clickControl(screen, "sidebar-add-project");
    expect(screen.captureCharFrame()).toContain("Add existing project");
    screen.mockInput.pressEscape();
    await screen.renderOnce();
    expect(editor(screen)?.plainText).toBe("Keep this local draft");
  } finally {
    await screen.dispose();
  }
});
