// Explicit real-Agent smoke/cancel checks in private temporary XDG and source directories.
// Never reads native configuration, chooses approvals, resumes, or retries model prompts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "../dist/client/client.js";

process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "hhu-real-phase6-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
};
const cli = (...args) =>
  execFileSync(process.env.HARNESSHUB_BUN ?? "bun", [resolve("dist/cli/hhu.js"), ...args], {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
const evidence = { at: new Date().toISOString(), root, results: [] };
const save = () =>
  writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(`Real Phase 6 evidence: ${root}`);
cli("daemon", "start");
const client = new Client(
  JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json"))),
);
const api = (path, method, body) => client.request(path, method, body, 45000);
writeFileSync(join(root, "sentinel.txt"), "HARNESSHUB_PHASE6_世界\n", { mode: 0o600 });
const project = await api("/v1/projects", "POST", { rootPath: root });
const wait = async (turn, conversationId, timeout = 120000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await api(`/v1/turns/${turn.id}`);
    if (current.endedAt) return current;
    const approvals = await api(`/v1/conversations/${conversationId}/approvals`);
    if (approvals.length) return { ...current, manualApprovalRequired: true, approvals };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ...(await api(`/v1/turns/${turn.id}`)), timedOut: true };
};
try {
  evidence.diagnostics = await api("/v1/diagnostics");
  for (const harnessId of ["codex", "claude", "grok", "opencode"]) {
    const result = { harnessId, recovery: "not-tested; HarnessHub never auto-resumes" };
    evidence.results.push(result);
    try {
      try {
        result.nativeVersion = execFileSync(
          harnessId === "claude" ? "claude" : harnessId,
          ["--version"],
          { env, encoding: "utf8", timeout: 10000 },
        ).trim();
      } catch {
        result.nativeVersion = "unavailable";
      }
      const conversation = await api(`/v1/projects/${project.id}/conversations`, "POST", {
        title: `Phase 6 real ${harnessId}`,
      });
      result.conversationId = conversation.id;
      result.session = await api(`/v1/conversations/${conversation.id}/sessions`, "POST", {
        harnessId,
      });
      const turn = await api(`/v1/conversations/${conversation.id}/turns`, "POST", {
        harnessId,
        requestId: crypto.randomUUID(),
        message:
          "In this temporary test directory only, use native tools to print pwd and read sentinel.txt. Return its exact text and a small Markdown code block. Do not edit files, use network, or spawn subagents. Respect native permissions; do not work around an approval request.",
      });
      result.smoke = await wait(turn, conversation.id);
      if (result.smoke.manualApprovalRequired || result.smoke.timedOut) {
        // Cancel through ACP only; never select a native permission option for the user.
        await api(`/v1/turns/${turn.id}/cancel`, "POST");
        result.smokeAfterCancel = await wait(turn, conversation.id, 15000);
      } else if (result.smoke.state === "COMPLETED") {
        const cancelTurn = await api(`/v1/conversations/${conversation.id}/turns`, "POST", {
          harnessId,
          requestId: crypto.randomUUID(),
          message:
            "Cancellation smoke test in this temporary directory: use a native shell tool to run sleep 20, then say done. Do not modify files, use network, or spawn subagents. Respect native permissions.",
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        result.cancelRequest = await api(`/v1/turns/${cancelTurn.id}/cancel`, "POST");
        result.cancel = await wait(cancelTurn, conversation.id, 30000);
      }
      const exported = await api(`/v1/conversations/${conversation.id}/export?format=debug`);
      result.eventCount = exported.events.length;
      result.toolCalls = exported.events.filter((event) => event.kind === "tool_call").length;
      result.agentText = exported.events
        .filter((event) => event.kind === "agent_message_chunk" && event.turnId === turn.id)
        .map((event) => event.payload?.content?.text ?? "")
        .join("");
      result.cwdMatched =
        result.session.cwd === root &&
        exported.events.some(
          (event) => event.raw?.method === "session/new" && event.raw.params.cwd === root,
        );
      result.smokeVerified =
        result.smoke.state === "COMPLETED" &&
        result.cwdMatched &&
        result.toolCalls > 0 &&
        result.agentText.includes("HARNESSHUB_PHASE6_世界");
      result.cancelVerified =
        result.cancel?.state === "CANCELLED" && result.cancel.stopReason === "cancelled";
      writeFileSync(join(root, `${harnessId}-debug.json`), JSON.stringify(exported, null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      result.error = error.message;
    }
    save();
    console.log(
      JSON.stringify({
        harnessId,
        smoke: result.smoke?.state,
        approval: result.smoke?.manualApprovalRequired,
        cancel: result.cancel?.state,
        error: result.error,
      }),
    );
  }
} finally {
  evidence.passed =
    evidence.results.length === 4 &&
    evidence.results.every((result) => result.smokeVerified && result.cancelVerified);
  save();
  try {
    console.log(cli("daemon", "stop", "--cancel-active").trim());
  } catch (error) {
    evidence.shutdownError = error.message;
    save();
    console.error(`Isolated Daemon retained; inspect ${root}`);
  }
  if (!evidence.passed || evidence.shutdownError) process.exitCode = 1;
}
