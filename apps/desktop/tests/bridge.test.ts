import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, VERSION } from "@harnesshub/shared";
import { paths } from "../../../packages/shared/src/paths";
import { bridgeLauncher } from "../../../scripts/desktop-bootstrap";
import { desktopRequest } from "../src/contracts";
import { trustedSender, windowSecurity } from "../src/main/security";
import { loadDistribution, saveDistribution } from "../src/main/settings";
import {
  BOOTSTRAP,
  decodeWsl,
  parseDistributions,
  type RunResult,
  WslBridge,
} from "../src/main/wsl";

const listing =
  "  NAME                 STATE           VERSION\r\n* Ubuntu-26.04         Running         2\r\n  Old Ubuntu           Stopped         1\r\n  测试 Linux           已停止          2\r\n";
const response = (text: string, code = 0): RunResult => ({
  stdout: Buffer.from(text),
  stderr: Buffer.alloc(0),
  code,
});
const instance = {
  pid: 123,
  port: 43210,
  token: "a".repeat(64),
  instanceId: "fc88fd5a-6d4b-4a03-b48f-64ed9d5e8d05",
  version: VERSION,
  protocolVersion: PROTOCOL_VERSION,
};
const bridge = (envelope: unknown, code = 0, calls: string[][] = []) =>
  new WslBridge(async (args) => {
    calls.push(args);
    return args[0] === "--list" ? response(listing) : response(JSON.stringify(envelope), code);
  });

describe("WSL discovery and bootstrap boundary", () => {
  test("UTF-16LE/BOM/UTF-8 and localized state, names containing spaces", () => {
    expect(parseDistributions(decodeWsl(Buffer.from(`\ufeff${listing}`, "utf16le")))).toEqual([
      { name: "Ubuntu-26.04", version: 2, state: "Running", isDefault: true },
      { name: "Old Ubuntu", version: 1, state: "Stopped", isDefault: false },
      { name: "测试 Linux", version: 2, state: "已停止", isDefault: false },
    ]);
    expect(decodeWsl(Buffer.from(listing))).toBe(listing);
  });
  test("missing WSL and empty discovery give actionable errors", async () => {
    await expect(
      new WslBridge(async () => response("WSL unavailable", 1)).discover(),
    ).rejects.toThrow("WSL 不可用");
    await expect(
      new WslBridge(async () => response("no distributions")).discover(),
    ).rejects.toThrow("未找到");
  });
  test("WSL1 and unknown names cannot execute bootstrap", async () => {
    const calls: string[][] = [];
    await expect(bridge({}, 0, calls).connect("Old Ubuntu")).rejects.toThrow("WSL2");
    await expect(bridge({}, 0, calls).connect("Ubuntu; touch /tmp/escape")).rejects.toThrow("WSL2");
    expect(calls.every((args) => args[0] === "--list")).toBe(true);
  });
  test("known distro and untrusted-looking names are argv, not shell interpolation", async () => {
    const calls: string[][] = [];
    expect(await bridge({ bridgeVersion: 1, instance }, 0, calls).connect("Ubuntu-26.04")).toEqual(
      instance,
    );
    expect(calls[1]).toEqual([
      "--distribution",
      "Ubuntu-26.04",
      "--cd",
      "~",
      "--exec",
      "/bin/sh",
      "-c",
      BOOTSTRAP,
      "hhu-desktop",
      VERSION,
      String(PROTOCOL_VERSION),
    ]);
    const maliciousName = "Ubuntu $(touch PWNED)";
    const fake = new WslBridge(async (args) => {
      calls.push(args);
      return args[0] === "--list"
        ? response(`* ${maliciousName}    Running    2`)
        : response(JSON.stringify({ bridgeVersion: 1, instance }));
    });
    await fake.connect(maliciousName);
    expect(calls.at(-1)?.[1]).toBe(maliciousName);
    expect(calls.at(-1)?.[7]).toBe(BOOTSTRAP);
  });
  test("missing installation, incompatible and broken startup do not expose stdout/stderr", async () => {
    for (const [error, expected] of [
      ["NOT_INSTALLED", "尚未安装"],
      ["INCOMPATIBLE", "任务未停止"],
      ["START_FAILED", "无法启动"],
    ]) {
      await expect(bridge({ bridgeVersion: 1, error }, 1).connect("Ubuntu-26.04")).rejects.toThrow(
        expected,
      );
    }
    await expect(
      new WslBridge(async (args) =>
        args[0] === "--list" ? response(listing) : response("secret token output", 1),
      ).connect("Ubuntu-26.04"),
    ).rejects.toThrow("无效响应");
  });
  test("dynamic ports, identity schema, protocol and version validated", async () => {
    for (const patch of [
      { port: 0 },
      { port: 65536 },
      { token: "wrong" },
      { instanceId: "not-uuid" },
    ]) {
      await expect(
        bridge({ bridgeVersion: 1, instance: { ...instance, ...patch } }).connect("Ubuntu-26.04"),
      ).rejects.toThrow("实例信息无效");
    }
    for (const patch of [{ version: "old" }, { protocolVersion: 99 }]) {
      await expect(
        bridge({ bridgeVersion: 1, instance: { ...instance, ...patch } }).connect("Ubuntu-26.04"),
      ).rejects.toThrow("版本不匹配");
    }
  });
  test("fixed bootstrap finds Linux HOME with no interactive shell or Windows PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "hhu-bridge-shell-"));
    const directory = join(home, ".local/lib/harnesshub");
    mkdirSync(directory, { recursive: true });
    const missing = (() => {
      try {
        execFileSync("/bin/sh", ["-c", BOOTSTRAP], {
          env: { HOME: home, PATH: "/not-windows-path" },
        });
      } catch (error) {
        return String((error as { stdout: Buffer }).stdout);
      }
    })();
    expect(missing).toContain("NOT_INSTALLED");
    writeFileSync(join(directory, "desktop-bridge"), '#!/bin/sh\nprintf \'%s|%s\' "$1" "$2"\n', {
      mode: 0o700,
    });
    expect(
      execFileSync("/bin/sh", ["-c", BOOTSTRAP, "hhu", VERSION, "1"], {
        env: { HOME: home, PATH: "/not-windows-path" },
      }).toString(),
    ).toBe(`${VERSION}|1`);
  });
  test("installed launcher restores PATH/XDG, quoted absolute executable/release from foreign cwd", () => {
    const temp = mkdtempSync(join(tmpdir(), "hhu-launcher's path-"));
    const executable = join(temp, "fake bun");
    writeFileSync(executable, '#!/bin/sh\nprintf \'%s\\n\' "$@" "$PATH" "$XDG_STATE_HOME"\n', {
      mode: 0o700,
    });
    const p = paths({
      XDG_STATE_HOME: join(temp, "state"),
      XDG_DATA_HOME: join(temp, "data"),
      XDG_CONFIG_HOME: join(temp, "config"),
    });
    const launcher = join(temp, "bridge");
    writeFileSync(
      launcher,
      bridgeLauncher(executable, join(temp, "release"), "/linux/node:/linux/bun:/usr/bin:/bin", p),
      { mode: 0o700 },
    );
    const result = execFileSync("/bin/sh", [launcher, VERSION, "1"], {
      cwd: "/",
      env: { PATH: "C:\\Windows" },
    }).toString();
    expect(result).toContain(
      `${temp}/release/cli/hhu.js\ndesktop-bridge\n${VERSION}\n1\n/linux/node:/linux/bun:/usr/bin:/bin\n${temp}/state`,
    );
  });
});

describe("Electron boundary", () => {
  test("IPC exact allowlist rejects arbitrary HTTP, shell, file paths and extra fields", () => {
    for (const request of [
      { type: "request", path: "/v1/daemon/stop" },
      { type: "connect", distribution: "Ubuntu", command: "bad" },
      { type: "select", conversationId: "../../etc/passwd" },
      { type: "approve", optionId: "yes" },
      { type: "connect", distribution: "bad\nname" },
    ])
      expect(desktopRequest.safeParse(request).success).toBe(false);
    expect(
      desktopRequest.safeParse({ type: "select", conversationId: instance.instanceId }).success,
    ).toBe(true);
  });
  test("only the exact window main frame and document can invoke IPC", () => {
    const contents = {},
      frame = {},
      url = "file:///app/renderer/index.html";
    expect(
      trustedSender({ sender: contents, senderFrame: frame }, { contents, frame, url }, url),
    ).toBe(true);
    expect(trustedSender({ sender: {}, senderFrame: frame }, { contents, frame, url }, url)).toBe(
      false,
    );
    expect(
      trustedSender({ sender: contents, senderFrame: {} }, { contents, frame, url }, url),
    ).toBe(false);
    expect(
      trustedSender(
        { sender: contents, senderFrame: frame },
        { contents, frame, url },
        "https://example.com",
      ),
    ).toBe(false);
    expect(windowSecurity).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
  });
  test("local settings persist only selected distro and reject malformed data", () => {
    const file = join(mkdtempSync(join(tmpdir(), "hhu-desktop-settings-")), "settings.json");
    expect(loadDistribution(file)).toBeNull();
    saveDistribution(file, "Ubuntu-26.04");
    expect(loadDistribution(file)).toBe("Ubuntu-26.04");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ distribution: "Ubuntu-26.04" });
    writeFileSync(file, '{"distribution":"Ubuntu","token":"should never persist"}');
    expect(loadDistribution(file)).toBeNull();
  });
  test("renderer bundle excludes Node/native modules and preload exposes no token", () => {
    const renderer = readFileSync("../../dist/desktop/app/renderer/index.js", "utf8");
    for (const forbidden of [
      "Bearer ",
      "child_process",
      "better-sqlite3",
      "@opentui",
      "instance.json",
    ])
      expect(renderer).not.toContain(forbidden);
    const preload = readFileSync("../../dist/desktop/app/main/preload.cjs", "utf8");
    expect(preload).not.toContain("Bearer");
    expect(preload).not.toContain("child_process");
    const main = readFileSync("../../dist/desktop/app/main/index.cjs", "utf8");
    expect(main).toContain("getAppPath()");
    expect(main).not.toMatch(/var __dirname =/);
    const html = readFileSync("../../dist/desktop/app/renderer/index.html", "utf8");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("unsafe-inline");
    expect(html).not.toContain("unsafe-eval");
  });
});
