// Explicit real-Agent probe: initialize/session/new only, never session/prompt,
// set_config_option, set_mode, native configuration reads, or approval grants.
// Run after build: node scripts/verify-acp-commands.mjs [codex claude grok opencode]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProfiles, Worker } from "../dist/acp/index.js";

process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "hhu-real-commands-"));
const workspace = join(root, "project");
mkdirSync(workspace);
const evidence = {
  at: new Date().toISOString(),
  workspace,
  protocol: "ACP v1",
  promptRequests: 0,
  results: [],
};
const save = () =>
  writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(`ACP command evidence: ${root}`);
for (const id of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["codex", "claude", "grok", "opencode"]) {
  const profile = builtinProfiles().find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown builtin Harness: ${id}`);
  const result = {
    harness: id,
    command: profile.command,
    args: profile.args,
    commandUpdates: [],
    clientMethods: [],
    permissionRequests: 0,
  };
  evidence.results.push(result);
  let worker;
  try {
    worker = new Worker(profile, workspace, {
      wire(direction, raw) {
        if (direction === "client" && raw.method) {
          result.clientMethods.push(raw.method);
          if (raw.method === "session/prompt") throw new Error("Probe must never send a Prompt");
        }
        if (
          direction === "agent" &&
          raw.method === "session/update" &&
          raw.params?.update?.sessionUpdate === "available_commands_update"
        ) {
          // Exact native names, descriptions and hints; no full Prompts/tool logs.
          result.commandUpdates.push({ at: Date.now(), params: raw.params });
          save();
        }
      },
      permission: async () => {
        result.permissionRequests++;
        return { outcome: { outcome: "cancelled" } };
      },
      lost: () => {
        result.connectionLost = true;
      },
    });
    result.workerPid = worker.child.pid;
    const init = await worker.initialize();
    result.agentInfo = init.agentInfo;
    result.protocolVersion = init.protocolVersion;
    const session = await worker.bounded(
      worker.agent.request("session/new", { cwd: workspace, mcpServers: [] }),
    );
    result.agentSessionId = session.sessionId;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    result.availableCommands =
      result.commandUpdates.filter((u) => u.params.sessionId === session.sessionId).at(-1)?.params
        .update.availableCommands ?? null;
    result.initialized = true;
    if (init.agentCapabilities?.sessionCapabilities?.close)
      result.closeResponse = await worker.bounded(
        worker.agent.request("session/close", { sessionId: session.sessionId }),
        5000,
      );
  } catch (error) {
    result.error = error.message;
    process.exitCode = 1;
  } finally {
    if (worker) {
      try {
        await worker.stop();
        result.exitedConfirmed = worker.exitedConfirmed;
      } catch (error) {
        result.initialShutdownError = error.message;
        // A slow native descendant may still be draining. Retry only cooperative
        // shutdown with the same owned handle; never force or issue another Prompt.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        try {
          await worker.stop();
          result.exitedConfirmed = worker.exitedConfirmed;
        } catch (finalError) {
          result.shutdownError = finalError.message;
          process.exitCode = 1;
        }
      }
      result.stderrBytes = worker.stderrBytes;
    }
    evidence.promptRequests += result.clientMethods.filter((m) => m === "session/prompt").length;
    save();
    console.log(
      JSON.stringify({
        harness: id,
        initialized: result.initialized ?? false,
        agent: result.agentInfo,
        commands: result.availableCommands?.map((c) => c.name) ?? null,
        error: result.error,
        exited: result.exitedConfirmed,
      }),
    );
  }
}
