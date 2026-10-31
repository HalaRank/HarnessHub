#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Project, VERSION } from "@harnesshub/shared";
import { connect, readInstance } from "@harnesshub/shared/client";
import { paths } from "@harnesshub/shared/paths";
import { ensureDaemon, stopDaemon } from "./lifecycle";

process.umask(0o077);
try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`HarnessHub: ${error instanceof Error ? error.message : "Command failed"}`);
  process.exitCode = 1;
}

async function main(args: string[]) {
  const [command, action] = args;
  if (command === "--version") {
    console.log(`HarnessHub ${VERSION}`);
    return;
  }
  if (command === "--help" || command === "-h") {
    console.log(
      "HarnessHub\n  hhu [project-path]\n  hhu doctor\n  hhu daemon start|stop|status|logs\n  hhu --version",
    );
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command === "daemon") {
    if (args.length !== 2) throw new Error("Usage: hhu daemon start|stop|status|logs");
    switch (action) {
      case "start": {
        const client = await ensureDaemon();
        console.log(
          `HarnessHub Daemon running pid=${client.instance.pid} 127.0.0.1:${client.instance.port}`,
        );
        return;
      }
      case "stop":
        console.log(
          (await stopDaemon()) ? "HarnessHub Daemon stopped" : "HarnessHub Daemon is not running",
        );
        return;
      case "status": {
        const client = await connect();
        console.log(
          client
            ? `HarnessHub Daemon running pid=${client.instance.pid} 127.0.0.1:${client.instance.port}`
            : "HarnessHub Daemon is not reachable",
        );
        if (!client) process.exitCode = 1;
        return;
      }
      case "logs":
        for (const name of ["daemon.log.1", "daemon.log", "startup.log.1", "startup.log"]) {
          const file = join(paths().logs, name);
          if (existsSync(file)) console.log(readFileSync(file, "utf8").slice(-16000));
        }
        return;
      default:
        throw new Error("Usage: hhu daemon start|stop|status|logs");
    }
  }
  if (args.length > 1 || command?.startsWith("-")) throw new Error("Usage: hhu [project-path]");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "TUI requires an interactive terminal. Use hhu daemon start/status or hhu doctor for scripts.",
    );
  const client = await ensureDaemon();
  let projectId: string | undefined;
  if (command) {
    const project = await client.request<Project>("/v1/projects", "POST", {
      rootPath: resolve(command),
    });
    projectId = project.id;
  }
  const { openTui } = await import("@harnesshub/tui");
  await openTui(projectId);
}
async function doctor() {
  let failed = false;
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "OK" : "FAIL"} ${name}: ${detail}`);
    failed ||= !ok;
  };
  check(
    "Platform",
    process.platform === "linux" && process.arch === "x64",
    `${process.platform}/${process.arch}; ${readFileSync("/proc/sys/kernel/osrelease", "utf8").trim()}`,
  );
  check("Bun", Bun.version === "1.4.4", `${Bun.version} (tested 1.4.4)`);
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  const match = /^v24\.(\d+)\./.exec(node.stdout ?? "");
  check("Node LTS", !!match && Number(match[1]) >= 18, node.stdout?.trim() || "not found");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sqlite = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      "import Database from 'better-sqlite3'; const db=new Database(':memory:'); console.log(db.prepare('select sqlite_version() as version').get().version); db.close();",
    ],
    { cwd: root, encoding: "utf8" },
  );
  check(
    "SQLite native / Node",
    sqlite.status === 0,
    sqlite.status === 0
      ? sqlite.stdout.trim()
      : "binding failed; run bun install with Node 24 on PATH",
  );
  try {
    await import("@opentui/core");
    check("OpenTUI", true, "0.8.0 native library loaded in Bun");
  } catch {
    check("OpenTUI", false, "native library failed to load");
  }
  for (const executable of ["flock", "git"]) {
    const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
    check(executable, result.status === 0, result.stdout?.split("\n")[0] || "not found");
  }
  const p = paths();
  console.log(
    `Data: ${p.db}\nState: ${p.state}\nConfig: ${join(p.config, "config.json")} (optional; not created in phase 1)`,
  );
  const client = await connect();
  console.log(
    client
      ? `Daemon: connected, pid=${client.instance.pid}, port=${client.instance.port}, runtime=Node ${(await client.health()).nodeVersion}`
      : `Daemon: ${readInstance() ? "unreachable/stale/incompatible instance metadata" : "not running"}`,
  );
  console.log("ACP: not implemented in phase 1; no Agent configuration was read.");
  if (failed) process.exitCode = 1;
}
