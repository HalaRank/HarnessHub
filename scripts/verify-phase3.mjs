// Opt-in real Harness verification in isolated XDG directories. No native config is read or edited.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "../dist/client/client.js";

const root = mkdtempSync(join(tmpdir(), "hhu-real-phase3-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
};
const bun =
  process.env.HARNESSHUB_BUN ?? execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
const cli = resolve("dist/cli/hhu.js");
const harnesses = process.argv.slice(2).length ? process.argv.slice(2) : ["codex", "grok"];
if (harnesses.length !== 2) throw new Error("Provide exactly two real Harness IDs");
execFileSync(bun, [cli, "daemon", "start"], { env, cwd: homedir(), stdio: "inherit" });
const client = new Client(
  JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json"))),
);
const setup = { evidence: root, date: new Date().toISOString(), conversations: [] };
const file = join(root, "evidence.json");
console.log(`Real Phase 3 evidence: ${root}`);
try {
  for (const [index, harnessId] of harnesses.entries()) {
    const workspace = join(root, `project-${index + 1}`);
    mkdirSync(workspace, { mode: 0o700 });
    const sentinel = `HARNESSHUB_PHASE3_PROJECT_${index + 1}`;
    writeFileSync(join(workspace, "smoke.txt"), `${sentinel}\n`, { mode: 0o600 });
    writeFileSync(
      join(workspace, "smoke.test.mjs"),
      `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; test('workspace sentinel', () => assert.equal(readFileSync('smoke.txt', 'utf8').trim(), '${sentinel}'));\n`,
      { mode: 0o600 },
    );
    const project = await client.request("/v1/projects", "POST", {
      rootPath: workspace,
      name: `Phase 3 ${harnessId} project`,
    });
    const c = await client.request(`/v1/projects/${project.id}/conversations`, "POST", {
      title: `Phase 3 ${harnessId}`,
    });
    await client.request(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId }, 60000);
    setup.conversations.push({
      projectId: project.id,
      conversationId: c.id,
      harnessId,
      workspace,
      sentinel,
      message:
        "Use native tools to read smoke.txt, print the actual working directory with pwd, then execute sleep 12 followed by node --test smoke.test.mjs. Report the sentinel, working directory and test result. Do not modify files, use network or spawn subagents. Use native permissions if needed.",
    });
  }
  writeFileSync(file, JSON.stringify(setup, null, 2), { mode: 0o600 });
  const child = spawn("python3", [resolve("tests/e2e/phase3-terminal.py"), bun, cli, file], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  const code = await new Promise((resolveExit) => child.on("exit", resolveExit));
  setup.terminalOutput = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  setup.passed = code === 0;
  writeFileSync(file, JSON.stringify(setup, null, 2), { mode: 0o600 });
  if (code !== 0)
    throw new Error("Real PTY verification failed; inspect private evidence/SQLite history");
} finally {
  // Native cancellation is permitted by this explicitly invoked test; never force-kill Workers.
  try {
    execFileSync(bun, [cli, "daemon", "stop", "--cancel-active"], {
      env,
      stdio: "inherit",
      timeout: 30000,
    });
  } catch {
    console.error(`Isolated Daemon could not safely stop; inspect ${root}`);
  }
}
