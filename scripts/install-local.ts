import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
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
import { paths, privateDir, securePaths } from "../packages/shared/src/paths";

import { bridgeLauncher } from "./desktop-bootstrap";

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
const bridgeDir = join(homedir(), ".local/lib/harnesshub");
privateDir(bridgeDir);
const bridgeTarget = join(bridgeDir, "desktop-bridge");
if (
  existsSync(bridgeTarget) &&
  (lstatSync(bridgeTarget).isSymbolicLink() ||
    !readFileSync(bridgeTarget, "utf8").includes("# HarnessHub desktop bridge launcher"))
)
  throw new Error("Refusing to overwrite an unrelated desktop bridge launcher");
const releases = resolve("dist/releases");
mkdirSync(releases, { recursive: true, mode: 0o700 });
const releaseId = randomUUID(),
  staging = join(releases, `.staging-${releaseId}`),
  release = join(releases, releaseId);
mkdirSync(staging, { mode: 0o700 });
const build = spawnSync(process.execPath, ["run", "build", "--outdir", staging], {
  stdio: "inherit",
});
if (build.status !== 0)
  throw new Error(
    `Build failed; previous launcher and release were not changed. Inspect ${staging}`,
  );
// The old launcher references an immutable complete release, including its daemon
// and migrations. Neither a failed install nor a later development build mutates it.
renameSync(staging, release);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const staged = `${target}.${process.pid}.tmp`;
writeFileSync(
  staged,
  `#!/bin/sh\n# HarnessHub local launcher\nexec ${quote(process.execPath)} ${quote(join(release, "cli/hhu.js"))} "$@"\n`,
  { mode: 0o755, flag: "wx" },
);
chmodSync(staged, 0o755);
const bridgeStaged = `${bridgeTarget}.${process.pid}.tmp`;
writeFileSync(
  bridgeStaged,
  bridgeLauncher(process.execPath, release, process.env.PATH ?? "/usr/bin:/bin", p),
  { mode: 0o700, flag: "wx" },
);
chmodSync(bridgeStaged, 0o700);
// Keep the exact previous launcher pair beside this immutable release for recovery.
// Never infer a prior version from mtime or overwrite/delete SQLite during rollback.
const previous = join(release, "previous-launchers");
privateDir(previous);
for (const [source, name] of [
  [target, "hhu"],
  [bridgeTarget, "desktop-bridge"],
] as const) {
  if (existsSync(source)) {
    copyFileSync(source, join(previous, name));
    chmodSync(join(previous, name), 0o700);
  }
}
writeFileSync(
  join(release, "install-receipt.json"),
  JSON.stringify({ release, previous, installedAt: new Date().toISOString() }, null, 2),
  { mode: 0o600 },
);
renameSync(bridgeStaged, bridgeTarget);
try {
  renameSync(staged, target);
} catch (error) {
  // If replacing the second launcher fails, restore the prior Bridge atomically.
  // First installation has no prior Bridge; its complete new release remains usable.
  if (existsSync(join(previous, "desktop-bridge"))) {
    copyFileSync(join(previous, "desktop-bridge"), bridgeStaged);
    renameSync(bridgeStaged, bridgeTarget);
  }
  throw error;
}
console.log(
  `Installed ${target}\nRecovery launchers: ${previous}\nKeep this source checkout and node_modules in place.\nEnsure ${bin} is on PATH. No shell configuration was changed.`,
);
