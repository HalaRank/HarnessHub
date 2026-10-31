import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fchmodSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@harnesshub/shared";
import { Client, connect, readInstance } from "@harnesshub/shared/client";
import { appendPrivateLog, paths, securePaths } from "@harnesshub/shared/paths";

export async function ensureDaemon(): Promise<Client> {
  const existing = await connect();
  if (existing) return existing;
  const stale = readInstance();
  if (stale) {
    // An incompatible live instance must be stopped explicitly; do not replace its metadata.
    const probe = new Client(stale);
    try {
      await probe.request("/v1/health", "GET", undefined, 750);
      throw new Error(
        "A live incompatible Daemon exists. Stop it with its matching hhu version first.",
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("A live incompatible")) throw error;
    }
  }
  const version = spawnSync("node", ["--version"], { encoding: "utf8" });
  const match = /^v24\.(\d+)\./.exec(version.stdout ?? "");
  if (!match || Number(match[1]) < 18)
    throw new Error("HarnessHub requires tested Node 24.18+ LTS (<25) on PATH");
  const p = paths();
  securePaths(p);
  const launch = () => {
    const startupLog = join(p.logs, "startup.log");
    if (existsSync(startupLog) && statSync(startupLog).size > 1024 * 1024)
      appendPrivateLog(startupLog, "launcher log rotated");
    const fd = openSync(startupLog, "a", 0o600);
    fchmodSync(fd, 0o600);
    // Acquire the kernel lock before loading Hono/SQLite. The child becomes Node via exec.
    const child = spawn(
      "flock",
      [
        "--no-fork",
        "--nonblock",
        "--conflict-exit-code",
        "73",
        p.lock,
        "node",
        fileURLToPath(new URL("../daemon/index.js", import.meta.url)),
        "--lock-held",
      ],
      {
        detached: true,
        stdio: ["ignore", fd, fd],
        cwd: p.data,
        env: process.env,
      },
    );
    child.on("error", () => {
      startupError = true;
    });
    closeSync(fd);
    child.unref();
    return child;
  };
  let startupError = false;
  let child = launch();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (startupError) break;
    const client = await connect();
    // A losing launcher must finish before returning, so it cannot acquire the lock later.
    if (client && (client.instance.pid === child.pid || child.exitCode !== null)) return client;
    if (!client && child.exitCode === 73) child = launch();
    if (!client && child.exitCode !== null && child.exitCode !== 73) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Daemon did not start. Run hhu daemon logs; check Node/native SQLite, flock and schema compatibility (${p.logs}).`,
  );
}
export async function stopDaemon(cancelActive = false) {
  const instance = readInstance();
  if (!instance) return false;
  const client = new Client(instance);
  try {
    // A compatible older patch may be stopped for migration, with the same identity/auth checks.
    const health = await client.request<{ instanceId: string; protocolVersion: number }>(
      "/v1/health",
    );
    if (health.instanceId !== instance.instanceId || health.protocolVersion !== PROTOCOL_VERSION)
      throw new Error("Daemon identity or protocol mismatch");
  } catch {
    throw new Error("Daemon is unreachable or incompatible; no PID was signalled. Run hhu doctor.");
  }
  await client.request("/v1/daemon/stop", "POST", { cancelActive }, 15000);
  for (let attempt = 0; attempt < 200; attempt++) {
    const remaining = readInstance();
    if (remaining && remaining.instanceId !== instance.instanceId) return true;
    if (!remaining && spawnSync("flock", ["--nonblock", paths().lock, "true"]).status === 0)
      return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Daemon has not confirmed shutdown; it was not force-killed");
}
