import { spawnSync } from "node:child_process";

const build = spawnSync(process.execPath, ["run", "build"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const integration = spawnSync(
  "node",
  [
    "--test",
    "--test-concurrency=1",
    "tests/integration/phase1.test.mjs",
    "tests/integration/phase2.test.mjs",
    "tests/integration/phase3.test.mjs",
  ],
  { stdio: "inherit", env: { ...process.env, HARNESSHUB_BUN: process.execPath } },
);
if (integration.status !== 0) process.exit(integration.status ?? 1);
const ui = spawnSync(process.execPath, ["test", "tests/e2e/tui.test.tsx"], { stdio: "inherit" });
process.exitCode = ui.status ?? 1;
