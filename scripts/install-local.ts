import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, readInstance } from "../packages/shared/src/client";
import { paths, securePaths } from "../packages/shared/src/paths";

process.umask(0o077);
const instance = readInstance();
if (instance) {
  let live = false;
  try {
    const health = await new Client(instance).request<{
      instanceId: string;
      pid: number;
      version: string;
      protocolVersion: number;
    }>("/v1/health");
    if (health.instanceId !== instance.instanceId || health.pid !== instance.pid)
      throw new Error("HarnessHub instance identity mismatch; refusing to replace a live daemon");
    live = true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("instance identity mismatch")) throw error;
    /* Stale metadata. */
  }
  if (live)
    throw new Error("Stop the running HarnessHub Daemon before installation: hhu daemon stop");
}
// Hold the SAME kernel lock as Daemon throughout build and atomic launcher replacement.
// This protects unresponsive instances and a competing hhu start during an upgrade.
const p = paths();
securePaths(p);
if (!process.argv.includes("--lock-held")) {
  const result = spawnSync(
    "flock",
    [
      "--no-fork",
      "--nonblock",
      "--conflict-exit-code",
      "73",
      p.lock,
      process.execPath,
      fileURLToPath(import.meta.url),
      "--lock-held",
    ],
    { stdio: "inherit" },
  );
  if (result.status === 73)
    throw new Error(
      "Stop the running HarnessHub Daemon before installation; its lock is held (including during startup or unresponsive tasks).",
    );
  process.exit(result.status ?? 1);
}
const bin = join(homedir(), ".local/bin");
mkdirSync(bin, { recursive: true });
const target = join(bin, "hhu");
if (existsSync(target) && lstatSync(target).isSymbolicLink())
  throw new Error(`Refusing to overwrite a symlink launcher: ${target}`);
if (existsSync(target) && !readFileSync(target, "utf8").includes("# HarnessHub local launcher"))
  throw new Error(`Refusing to overwrite an existing unrelated executable: ${target}`);
const build = spawnSync(process.execPath, ["run", "build"], { stdio: "inherit" });
if (build.status !== 0) throw new Error("Build failed; launcher was not changed");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const staged = `${target}.${process.pid}.tmp`;
writeFileSync(
  staged,
  `#!/bin/sh\n# HarnessHub local launcher\nexec ${quote(process.execPath)} ${quote(resolve("dist/cli/hhu.js"))} "$@"\n`,
  { mode: 0o755, flag: "wx" },
);
chmodSync(staged, 0o755);
renameSync(staged, target);
console.log(
  `Installed ${target}\nKeep this source checkout and node_modules in place.\nEnsure ${bin} is on PATH. No shell configuration was changed.`,
);
