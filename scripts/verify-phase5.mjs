// Opt-in real Codex → Grok → Codex. Isolated project/XDG; no credential/config inspection or auto approvals.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "../dist/client/client.js";

const root = mkdtempSync(join(tmpdir(), "hhu-real-phase5-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
};
const bun =
    process.env.HARNESSHUB_BUN ?? execFileSync("which", ["bun"], { encoding: "utf8" }).trim(),
  cli = resolve("dist/cli/hhu.js");
const run = (...args) =>
  execFileSync(bun, [cli, ...args], { env, cwd: homedir(), timeout: 30000, stdio: "inherit" });
const evidence = { directory: root, date: new Date().toISOString(), stages: [], passed: false };
const save = () =>
  writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(`Real Phase 5 evidence: ${root}`);
save();
run("daemon", "start");
const client = new Client(
  JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json"))),
);
const api = (path, method, body) => client.request(path, method, body, 60000);
const wait = async (check, ms = 240000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Real Harness timeout; inspect SQLite, native permissions and network");
};
const command = async (cmd, args) => {
  const child = spawn(cmd, args, { env, cwd: resolve("."), stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (c) => {
    output += c;
  });
  const code = await new Promise((r) => child.on("exit", r));
  if (code !== 0) throw new Error(`${cmd} validation exited ${code}`);
  return output;
};
let c;
try {
  const projectPath = join(root, "project");
  mkdirSync(projectPath, { mode: 0o700 });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: projectPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-b", "main");
  writeFileSync(join(projectPath, "handoff.txt"), "HARNESSHUB_PHASE5_SENTINEL\n", { mode: 0o600 });
  git("add", ".");
  git("-c", "user.name=HHU", "-c", "user.email=test@localhost", "commit", "-m", "real fixture");
  const p = await api("/v1/projects", "POST", { rootPath: projectPath });
  c = await api(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "Real Codex → Grok → Codex",
    workspaceMode: "worktree",
  });
  Object.assign(evidence, {
    conversationId: c.id,
    projectId: p.id,
    workspace: c.workspacePath,
    worktreeId: c.worktreeId,
  });
  save();
  await api("/v1/preferences", "PATCH", { lastConversationId: c.id, showSidebar: false });
  const messages = [
    "In this temporary test project, use native tools to read handoff.txt and print pwd. Create progress.txt containing exactly stage=1 on its own line. Remember this explicit user decision for the handoff: the release color is cobalt, and the final answer must include PHASE5_COBALT. Then sleep 15 so I can close the TUI while you work, and report the observed sentinel and stage. Do not change any other files, use network tools or spawn subagents. Use native permissions if needed.",
    "Continue the task from the historical context. State the release color chosen by the user and its exact required final marker. Use native tools to read progress.txt and print pwd. Update progress.txt to exactly stage=2 on its own line, then report the previous and new stages and sentinel from context. Do not change any other files, use network tools or spawn subagents. Use native permissions if needed.",
    "Continue from the historical context. State the explicit release color and required final marker. Use native tools to read progress.txt and print pwd. Update progress.txt to exactly stage=3 on its own line, and report the previous and new stages. Do not change any other files, use network tools or spawn subagents. Use native permissions if needed.",
  ];
  const history = async () => {
    const es = [];
    for (let after = 0; ; ) {
      const page = await api(`/v1/conversations/${c.id}/events?after_seq=${after}&limit=1000`);
      es.push(...page.events);
      after = es.at(-1)?.seq ?? 0;
      if (after >= page.cursor) break;
    }
    return es;
  };
  for (const [index, harnessId] of ["codex", "grok", "codex"].entries()) {
    const before = (await history()).filter((e) => e.raw?.method === "session/prompt").length;
    await api(`/v1/conversations/${c.id}/harness`, "PUT", { harnessId });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(
      (await history()).filter((e) => e.raw?.method === "session/prompt").length,
      before,
    );
    const requestId = crypto.randomUUID(),
      t = await api(`/v1/conversations/${c.id}/turns`, "POST", {
        requestId,
        harnessId,
        message: messages[index],
      });
    evidence.stages.push({ harnessId, requestId, turnId: t.id, selectionMadeNoModelCall: true });
    save();
    console.log(`Submitted real stage ${index + 1}: ${harnessId}, ${t.id}`);
    if (index === 0) {
      await wait(async () => (await history()).some((e) => e.kind === "tool_call"));
      const output = await command("python3", [
        resolve("tests/e2e/refinement-terminal.py"),
        bun,
        cli,
        c.id,
      ]);
      evidence.terminal = JSON.parse(output.trim());
      const still = await api(`/v1/turns/${t.id}`);
      assert.equal(still.endedAt, null);
      evidence.backgroundSurvivedTuiExit = true;
      save();
    }
    const result = await wait(async () => {
      const approvals = await api(`/v1/conversations/${c.id}/approvals`);
      if (approvals.length) {
        evidence.pendingApprovals = approvals;
        save();
        throw new Error(
          "Native permission requires user decision; no option was selected automatically. Inspect evidence and approve explicitly before continuing.",
        );
      }
      const hs = await api(`/v1/conversations/${c.id}/handoffs`);
      const blocked = hs.find((h) => ["FAILED", "UNCERTAIN"].includes(h.status));
      if (blocked) {
        evidence.blockedHandoff = blocked;
        save();
        throw new Error(`Real handoff ${blocked.status}: ${blocked.error}`);
      }
      const row = await api(`/v1/turns/${t.id}`);
      return row.endedAt && row;
    });
    assert.equal(result.state, "COMPLETED");
    const content = readFileSync(join(c.workspacePath, "progress.txt"), "utf8");
    assert.equal(content.trim(), `stage=${index + 1}`);
    const es = await history(),
      native = await api(`/v1/conversations/${c.id}/sessions`);
    Object.assign(evidence.stages[index], {
      state: result.state,
      nativeSessionId: result.nativeSessionId,
      progress: content,
      eventCount: es.length,
      finalText: es
        .filter((e) => e.turnId === t.id && e.kind === "agent_message_chunk")
        .map((e) => e.payload.content?.text ?? "")
        .join(""),
    });
    assert.ok(native.every((s) => s.cwd === c.workspacePath));
    if (index) assert.match(evidence.stages[index].finalText, /cobalt/i);
    save();
  }
  evidence.sessions = await api(`/v1/conversations/${c.id}/sessions`);
  evidence.handoffs = await api(`/v1/conversations/${c.id}/handoffs`);
  assert.equal(evidence.sessions.length, 3);
  assert.notEqual(evidence.sessions[0].id, evidence.sessions[2].id);
  assert.ok(
    evidence.handoffs.every(
      (h) => h.status === "COMMITTED" && h.reportText.includes("PHASE5_COBALT"),
    ),
  );
  const es = await history();
  assert.equal(es.filter((e) => e.raw?.method === "session/prompt").length, 5);
  assert.equal(es.filter((e) => e.kind === "user.message").length, 3);
  assert.equal(
    es.filter((e) => e.purpose === "handoff_internal" && e.raw?.method === "session/prompt").length,
    2,
  );
  evidence.promptCount = 5;
  save();
  evidence.render = JSON.parse(
    (
      await command(bun, [resolve("scripts/verify-phase5-render.tsx"), join(root, "evidence.json")])
    ).trim(),
  );
  evidence.passed = true;
  save();
  console.log(`Real Codex → Grok → Codex passed: ${root}`);
} catch (error) {
  evidence.error = error.message;
  save();
  process.exitCode = 1;
  console.error(error.message);
} finally {
  // No forced termination or permission choices; normal cancellation/stop only.
  try {
    run("daemon", "stop", "--cancel-active");
  } catch {
    console.error(`Isolated daemon retained; inspect ${root}`);
  }
}
