import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../../apps/tui/src/index";
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
    await screen.mockInput.typeText(temp);
    screen.mockInput.pressEnter();
    await waitFor("Press n to create");
    screen.mockInput.pressKey("n");
    await waitFor("New conversation title");
    await screen.mockInput.typeText("Real empty conversation");
    screen.mockInput.pressEnter();
    await waitFor("└ Real empty");
    screen.mockInput.pressArrow("down");
    await waitFor("Empty conversation");
    expect(screen.captureCharFrame()).toContain("not implemented in phase 1");
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
