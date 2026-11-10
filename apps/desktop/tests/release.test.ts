import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VERSION } from "../../../packages/shared/src/index";
import { inspectArchive, windowsConfig } from "../../../scripts/desktop-release";
import { checkVersions } from "../../../scripts/version";
import { WslBridge } from "../src/main/wsl";

function archive(files: object) {
  const json = Buffer.from(JSON.stringify({ files }));
  const buffer = Buffer.alloc(16 + json.length);
  buffer.writeUInt32LE(json.length, 12);
  json.copy(buffer, 16);
  return buffer;
}
test("Windows archive rejects unexpected native modules, workers and linked payloads", () => {
  for (const files of [
    { node_modules: { files: { "better-sqlite3": {} } } },
    { "worker.js": {} },
    { "sqlite.node": {} },
    { assets: { link: "/linux" } },
    { main: { unpacked: true } },
  ])
    expect(() => inspectArchive(archive(files))).toThrow();
});
test("release configuration preserves app identity, data and explicit unsigned manual distribution", () => {
  const config = windowsConfig("/staging", "/output", "45.2.3");
  expect(config.appId).toBe("org.harnesshub.desktop");
  expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
  expect(config.nsis.runAfterFinish).toBe(false);
  expect(config.nsis.perMachine).toBe(false);
  expect(config.win.signExecutable).toBe(false);
  expect(config.publish).toBeNull();
  expect(config.nsis.artifactName).toContain("unsigned");
  expect(checkVersions(resolve("../..")).canonical).toBe(VERSION);
  const entry = readFileSync(resolve("src/main/index.ts"), "utf8");
  expect(entry).not.toContain("daemon/stop");
});
test("mismatch diagnostics expose validated versions and blockers without token or stop calls", async () => {
  const calls: string[][] = [];
  const bridge = new WslBridge(async (args) => {
    calls.push(args);
    return {
      code: args[0] === "--list" ? 0 : 1,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from(
        args[0] === "--list"
          ? "* Ubuntu    Running    2"
          : JSON.stringify({
              bridgeVersion: 1,
              error: "INCOMPATIBLE",
              diagnostics: {
                bridgeVersion: "0.5.0",
                bridgeProtocol: 1,
                daemonVersion: "0.5.0",
                daemonProtocol: 1,
                instanceId: "fc88fd5a-6d4b-4a03-b48f-64ed9d5e8d05",
                token: "secret",
                readiness: { safeToStop: false, checkedAt: 1, blockers: ["Active Turns"] },
              },
            }),
      ),
    };
  });
  try {
    await bridge.connect("Ubuntu");
    throw new Error("Expected refusal");
  } catch (error) {
    expect(String(error)).toContain("0.5.0");
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(
      (error as { diagnostics: { readiness: { safeToStop: boolean } } }).diagnostics.readiness
        .safeToStop,
    ).toBe(false);
  }
  expect(calls).toHaveLength(2);
});

test("real Harness evidence reader follows the server cursor beyond 1000 events", async () => {
  const { readHandoffEvents } = await import("./windows-handoff");
  const calls: string[] = [];
  const client = {
    request: async (path: string) => {
      calls.push(path);
      const after = Number(new URL(`http://localhost${path}`).searchParams.get("after_seq"));
      return {
        cursor: 1001,
        events: Array.from({ length: after === 0 ? 1000 : 1 }, (_, i) => ({ seq: after + i + 1 })),
      };
    },
  };
  const page = await readHandoffEvents(client as never, "test-conversation");
  expect(page.events).toHaveLength(1001);
  expect(calls[1]).toContain("after_seq=1000&limit=1000");
  await expect(
    readHandoffEvents(
      { request: async () => ({ events: [], cursor: 1 }) } as never,
      "test-conversation",
    ),
  ).rejects.toThrow("Incomplete");
});
