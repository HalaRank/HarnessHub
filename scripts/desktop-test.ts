import { spawnSync } from "node:child_process";

const build = spawnSync(process.execPath, ["run", "build"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const desktop = spawnSync(process.execPath, ["run", "desktop:build"], { stdio: "inherit" });
if (desktop.status !== 0) process.exit(desktop.status ?? 1);
const unit = spawnSync(process.execPath, ["test", "tests"], {
  stdio: "inherit",
  cwd: "apps/desktop",
});
if (unit.status !== 0) process.exit(unit.status ?? 1);
// Integration runs with Node so better-sqlite3 uses the existing Node ABI.
const bundle = await Bun.build({
  entrypoints: ["apps/desktop/src/main/connection.ts"],
  target: "node",
  outdir: "dist/desktop/test",
  external: ["ws", "zod"],
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Desktop test build failed");
const integration = spawnSync("node", ["--test", "tests/integration/desktop.test.mjs"], {
  stdio: "inherit",
  env: { ...process.env, HARNESSHUB_BUN: process.execPath },
});
process.exitCode = integration.status ?? 1;
