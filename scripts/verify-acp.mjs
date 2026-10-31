// Explicit, opt-in real-Harness verification. Native settings/credentials are never read here.
// This uses the user's existing Daemon environment and leaves evidence/history for inspection.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "../dist/client/client.js";

const cli = resolve("dist/cli/hhu.js");
execFileSync(process.env.HARNESSHUB_BUN ?? "bun", [cli, "daemon", "start"], { stdio: "inherit" });
const state = join(
  process.env.XDG_STATE_HOME ?? join(process.env.HOME, ".local/state"),
  "harnesshub/instance.json",
);
const client = new Client(JSON.parse(readFileSync(state, "utf8")));
const root = mkdtempSync(join(tmpdir(), "hhu-real-acp-"));
writeFileSync(join(root, "smoke.txt"), "HARNESSHUB_REAL_ACP_SENTINEL\n", { mode: 0o600 });
writeFileSync(
  join(root, "smoke.test.mjs"),
  "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; test('HarnessHub real ACP smoke', () => assert.equal(readFileSync(new URL('./smoke.txt', import.meta.url), 'utf8').trim(), 'HARNESSHUB_REAL_ACP_SENTINEL'));\n",
  { mode: 0o600 },
);
const project = await client.request("/v1/projects", "POST", {
  rootPath: root,
  name: "Phase 2 real ACP verification",
});
const evidence = {
  date: new Date().toISOString(),
  workspace: root,
  projectId: project.id,
  results: [],
};
writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(`Real ACP evidence: ${root}`);
for (const harnessId of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["codex", "claude", "grok", "opencode"]) {
  const conversation = await client.request(`/v1/projects/${project.id}/conversations`, "POST", {
    title: `Phase 2 ${harnessId}`,
  });
  const result = { harnessId, conversationId: conversation.id };
  evidence.results.push(result);
  try {
    const session = await client.request(
      `/v1/conversations/${conversation.id}/sessions`,
      "POST",
      { harnessId },
      45000,
    );
    result.sessionId = session.id;
    result.cwd = session.cwd;
    result.capabilities = session.capabilities;
    console.log(
      JSON.stringify({
        harnessId,
        initialized: true,
        agent: session.capabilities.initialize.agentInfo,
        configIds: session.capabilities.session.configOptions?.map((o) => o.id),
        modeIds: session.capabilities.session.modes?.availableModes.map((m) => m.id),
      }),
    );
  } catch (e) {
    result.error = e.message;
    console.log(JSON.stringify({ harnessId, error: e.message }));
  }
  writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
}
// A prompt is opt-in after handshake so the same script is useful for installation diagnostics.
if (process.env.HARNESSHUB_REAL_PROMPT === "1") {
  const result = evidence.results.find((r) => r.sessionId);
  if (result) {
    const turn = await client.request(`/v1/conversations/${result.conversationId}/turns`, "POST", {
      requestId: randomUUID(),
      harnessId: result.harnessId,
      message:
        "Use native tools to read smoke.txt, report the current working directory and run node --test smoke.test.mjs. Do not modify files, use network, or spawn subagents. Return the sentinel and test result. Use your native permissions if approval is needed.",
    });
    result.turnId = turn.id;
    console.log(JSON.stringify({ harnessId: result.harnessId, turnId: turn.id }));
    writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
}
