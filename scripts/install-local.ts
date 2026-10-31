import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client, readInstance } from "../packages/shared/src/client";

const instance = readInstance();
if (instance) {
  let live = false;
  try {
    await new Client(instance).request("/v1/health");
    live = true;
  } catch {
    /* Stale metadata. */
  }
  if (live)
    throw new Error("Stop the running HarnessHub Daemon before installation: hhu daemon stop");
}
const bin = join(homedir(), ".local/bin");
mkdirSync(bin, { recursive: true });
const target = join(bin, "hhu");
if (existsSync(target) && !readFileSync(target, "utf8").includes("# HarnessHub local launcher"))
  throw new Error(`Refusing to overwrite an existing unrelated executable: ${target}`);
const build = spawnSync(process.execPath, ["run", "build"], { stdio: "inherit" });
if (build.status !== 0) throw new Error("Build failed; launcher was not changed");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(
  target,
  `#!/bin/sh\n# HarnessHub local launcher\nexec ${quote(process.execPath)} ${quote(resolve("dist/cli/hhu.js"))} "$@"\n`,
  { mode: 0o755 },
);
chmodSync(target, 0o755);
console.log(
  `Installed ${target}\nKeep this source checkout and node_modules in place.\nEnsure ${bin} is on PATH. No shell configuration was changed.`,
);
