// Opt-in investigation only: fresh workspace/session, no retries, settings or approvals.
// native-login additionally requires explicit permission to use existing native data/login.
// Usage: node scripts/verify-opencode.mjs cli|acp|runtime isolated|native-config|native-login
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "../dist/client/client.js";

const [transport, configuration] = process.argv.slice(2);
if (
  !["cli", "acp", "runtime"].includes(transport) ||
  !["isolated", "native-config", "native-login"].includes(configuration)
) {
  throw new Error("Usage: verify-opencode.mjs cli|acp|runtime isolated|native-config|native-login");
}
process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "hhu-opencode-followup-"));
const workspace = join(root, "project");
mkdirSync(workspace);
const env = {
  ...process.env,
  XDG_CONFIG_HOME:
    configuration === "isolated"
      ? join(root, "config")
      : process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  XDG_DATA_HOME:
    configuration === "native-login"
      ? process.env.XDG_DATA_HOME || join(homedir(), ".local/share")
      : join(root, "data"),
  XDG_STATE_HOME:
    configuration === "native-login"
      ? process.env.XDG_STATE_HOME || join(homedir(), ".local/state")
      : join(root, "state"),
  XDG_CACHE_HOME:
    configuration === "native-login"
      ? process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
      : join(root, "cache"),
};
// Never inspect/copy credentials or config. HarnessHub's own XDG is always temporary,
// including native-login; only the OpenCode child receives the native paths.
const daemonEnv = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, "hhu-config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
};
const evidence = {
  at: new Date().toISOString(),
  root,
  workspace,
  transport,
  configuration,
  version: execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim(),
  environment: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("XDG_"))),
  daemonEnvironment: Object.fromEntries(
    Object.entries(daemonEnv).filter(([key]) => key.startsWith("XDG_")),
  ),
  timeoutMs: 120000,
  cancelGraceMs: 15000,
  stages: [],
};
const save = () => writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
const record = (file, entry) =>
  appendFileSync(join(root, file), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function boundary(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const sentinel = `HHU_READ_${randomUUID()}`;
writeFileSync(join(workspace, "sentinel.txt"), `${sentinel}\n`);
const marker = `HHU_TEXT_${randomUUID()}`;
const stages = [
  {
    name: "text",
    expected: marker,
    prompt: `Reply with exactly ${marker}. Do not use tools, read files, or spawn subagents.`,
  },
  {
    name: "read",
    expected: sentinel,
    prompt:
      "Read only sentinel.txt in this temporary workspace using your native read tool and return its exact contents. Do not edit files, run commands, use network or spawn subagents. Respect native permissions.",
  },
  {
    name: "tool",
    expected: workspace,
    prompt:
      "Use a native shell tool to run pwd once in this temporary workspace and return its output. Do not edit files, use network, or spawn subagents. Respect native permissions.",
  },
];
console.log(`OpenCode followup evidence: ${root}`);
save();

function child(args, file) {
  const proc = spawn("opencode", args, { cwd: workspace, env, stdio: "pipe" });
  proc.stderr.on("data", (chunk) => appendFileSync(join(root, `${file}-stderr.txt`), chunk));
  const closed = new Promise((resolve) =>
    proc.once("close", (code, signal) => resolve({ code, signal })),
  );
  proc.on("error", (error) => record(`${file}.jsonl`, { error: error.message }));
  return { proc, closed };
}
async function stopChild(proc, closed) {
  proc.stdin.end();
  let ended = await boundary(closed, 1000);
  if (ended.timedOut) {
    proc.kill("SIGTERM");
    ended = await boundary(closed, 5000);
  }
  if (ended.timedOut) throw new Error("Process exit unconfirmed; retained, no force kill");
  return ended.value;
}
async function cliProbe() {
  for (const stage of stages) {
    const result = { name: stage.name, prompt: stage.prompt, sentAt: Date.now() };
    evidence.stages.push(result);
    save();
    // OpenCode's native run has an explicit directory selector. Do not rely on its
    // resolution of inherited shell PWD when child_process already sets cwd.
    const args = ["run", "--dir", workspace, "--format", "json", stage.prompt];
    const { proc, closed } = child(args, stage.name);
    // Native run consumes piped stdin before submitting; EOF is required for an argv-only prompt.
    proc.stdin.end();
    const events = [];
    createInterface({ input: proc.stdout }).on("line", (line) => {
      record(`${stage.name}.jsonl`, { direction: "server", line });
      try {
        events.push(JSON.parse(line));
      } catch {
        /* Keep non-JSON output as evidence. */
      }
    });
    record(`${stage.name}.jsonl`, {
      direction: "client",
      cwd: workspace,
      args,
    });
    let outcome = await boundary(closed, evidence.timeoutMs);
    if (outcome.timedOut) {
      result.timedOutAt = Date.now();
      result.cancelSentAt = Date.now();
      record(`${stage.name}.jsonl`, { direction: "client", signal: "SIGINT" });
      proc.kill("SIGINT");
      outcome = await boundary(closed, evidence.cancelGraceMs);
      if (outcome.timedOut) result.cleanup = await stopChild(proc, closed);
    }
    result.endedAt = Date.now();
    result.exit = outcome.value;
    result.events = events;
    result.verified =
      !result.timedOutAt &&
      outcome.value?.code === 0 &&
      events.some((event) => event.type === "text" && event.part?.text?.includes(stage.expected)) &&
      (stage.name === "text" || events.some((event) => event.type === "tool_use"));
    save();
    if (!result.verified) break; // Never replay or escalate an uncertain task.
  }
}
async function acpProbe() {
  const { proc, closed } = child(["acp"], "acp");
  let nextId = 0;
  const pending = new Map();
  const messages = [];
  let permissionRequired = false;
  const send = (message) => {
    record("wire.jsonl", { direction: "client", message });
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      record("wire.jsonl", { invalidLine: line });
      return;
    }
    messages.push(message);
    record("wire.jsonl", { direction: "server", message });
    if (message.method === "session/request_permission") permissionRequired = true;
    if (message.id !== undefined && !message.method) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  try {
    for (const [method, params] of [
      [
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "HarnessHub", version: "0.6.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
      ],
      ["session/new", { cwd: workspace, mcpServers: [] }],
    ]) {
      const response = await boundary(request(method, params), 20000);
      evidence[method] = response;
      save();
      if (!response.value?.result) return;
    }
    const sessionId = evidence["session/new"].value.result.sessionId;
    for (const stage of stages) {
      const result = { name: stage.name, prompt: stage.prompt, sentAt: Date.now() };
      evidence.stages.push(result);
      save();
      const start = messages.length;
      const response = request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: stage.prompt }],
      });
      let settled = false;
      const completion = response.then((value) => {
        settled = true;
        return value;
      });
      const deadline = Date.now() + evidence.timeoutMs;
      while (!settled && !permissionRequired && Date.now() < deadline) await delay(100);
      if (!settled) {
        result.permissionRequired = permissionRequired;
        if (!permissionRequired) result.timedOutAt = Date.now();
        result.cancelSentAt = Date.now();
        send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      }
      result.response = await boundary(completion, evidence.cancelGraceMs);
      result.endedAt = Date.now();
      result.received = messages.slice(start);
      const updates = result.received.map((m) => m.params?.update).filter(Boolean);
      result.text = updates
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content?.text || "")
        .join("");
      result.toolCalls = updates.filter((u) => u.sessionUpdate === "tool_call").length;
      result.verified =
        !result.cancelSentAt &&
        result.response.value?.result?.stopReason === "end_turn" &&
        result.text.includes(stage.expected) &&
        (stage.name === "text" || result.toolCalls > 0);
      save();
      if (!result.verified) break;
    }
    // Closing is attempted only after prompt completion, with the negotiated capability.
    if (
      !evidence.stages.some((s) => s.response?.timedOut) &&
      evidence.initialize.value.result.agentCapabilities?.sessionCapabilities?.close
    ) {
      evidence.close = await boundary(request("session/close", { sessionId }), 5000);
    }
  } finally {
    evidence.processExit = await stopChild(proc, closed);
    save();
  }
}
async function runtimeProbe() {
  const cli = (...args) =>
    execFileSync(process.env.HARNESSHUB_BUN || "bun", [resolve("dist/cli/hhu.js"), ...args], {
      env: daemonEnv,
      encoding: "utf8",
      timeout: 30000,
    });
  cli("daemon", "start");
  const client = new Client(
    JSON.parse(readFileSync(join(daemonEnv.XDG_STATE_HOME, "harnesshub/instance.json"))),
  );
  const api = (path, method, body) => client.request(path, method, body, 45000);
  try {
    await api("/v1/harness-profiles", "POST", {
      id: "opencode",
      name: "OpenCode",
      command: "opencode",
      args: ["acp"],
      envOverrides: Object.fromEntries(
        ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map((key) => [
          key,
          env[key],
        ]),
      ),
    });
    const project = await api("/v1/projects", "POST", { rootPath: workspace });
    const conversation = await api(`/v1/projects/${project.id}/conversations`, "POST", {
      title: `OpenCode followup ${configuration}`,
    });
    evidence.project = project;
    evidence.conversation = conversation;
    evidence.session = await api(`/v1/conversations/${conversation.id}/sessions`, "POST", {
      harnessId: "opencode",
    });
    save();
    for (const stage of stages) {
      const result = {
        name: stage.name,
        prompt: stage.prompt,
        sentAt: Date.now(),
        requestId: randomUUID(),
      };
      evidence.stages.push(result);
      save();
      const turn = await api(`/v1/conversations/${conversation.id}/turns`, "POST", {
        harnessId: "opencode",
        requestId: result.requestId,
        message: stage.prompt,
      });
      result.turnId = turn.id;
      const wait = async (ms, checkApproval) => {
        const deadline = Date.now() + ms;
        do {
          const current = await api(`/v1/turns/${turn.id}`);
          if (current.endedAt) return current;
          if (checkApproval && (await api(`/v1/conversations/${conversation.id}/approvals`)).length)
            return { ...current, permissionRequired: true };
          await delay(100);
        } while (Date.now() < deadline);
        return { ...(await api(`/v1/turns/${turn.id}`)), timedOutAt: Date.now() };
      };
      result.beforeCancel = await wait(evidence.timeoutMs, true);
      if (!result.beforeCancel.endedAt) {
        result.cancelSentAt = Date.now();
        await api(`/v1/turns/${turn.id}/cancel`, "POST");
        result.afterCancel = await wait(evidence.cancelGraceMs, false);
      }
      result.endedAt = Date.now();
      const exported = await api(`/v1/conversations/${conversation.id}/export?format=debug`);
      writeFileSync(join(root, "runtime-debug.json"), JSON.stringify(exported, null, 2));
      const events = exported.events.filter((e) => e.turnId === turn.id);
      result.text = events
        .filter((e) => e.kind === "agent_message_chunk")
        .map((e) => e.payload?.content?.text || "")
        .join("");
      result.toolCalls = events.filter((e) => e.kind === "tool_call").length;
      result.verified =
        !result.cancelSentAt &&
        result.beforeCancel.state === "COMPLETED" &&
        result.text.includes(stage.expected) &&
        (stage.name === "text" || result.toolCalls > 0);
      save();
      if (!result.verified) break;
    }
  } finally {
    try {
      evidence.shutdown = cli("daemon", "stop").trim();
    } catch {
      evidence.shutdown = "Unconfirmed; isolated Daemon retained. No force/retry.";
    }
    save();
  }
}
try {
  await { cli: cliProbe, acp: acpProbe, runtime: runtimeProbe }[transport]();
} catch (error) {
  evidence.error = error.message;
}
evidence.passed =
  evidence.stages.length === stages.length &&
  evidence.stages.every((s) => s.verified) &&
  !evidence.error &&
  !evidence.shutdown?.startsWith("Unconfirmed");
save();
console.log(
  JSON.stringify({
    transport,
    configuration,
    passed: evidence.passed,
    stages: evidence.stages.map((s) => ({ name: s.name, verified: s.verified })),
  }),
);
if (!evidence.passed) process.exitCode = 1;
