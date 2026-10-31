import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { watchSnapshot } from "../../dist/client/client.js";
import { openStore } from "../../dist/storage/index.js";

const run = promisify(execFile);
const bun = process.env.HARNESSHUB_BUN;
const cli = resolve("dist/cli/hhu.js");
const migrations = resolve("packages/storage/migrations");
const temp = mkdtempSync(join(tmpdir(), "hhu-phase1-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_DATA_HOME: join(temp, "data"),
  XDG_STATE_HOME: join(temp, "state"),
};
const state = join(env.XDG_STATE_HOME, "harnesshub");
const data = join(env.XDG_DATA_HOME, "harnesshub");
const instanceFile = join(state, "instance.json");
const cliRun = (...args) => run(bun, [cli, ...args], { env, cwd: tmpdir(), timeout: 15000 });
const instance = () => JSON.parse(readFileSync(instanceFile, "utf8"));
const sockets = [];
async function request(path, method = "GET", body, headers = {}) {
  const i = instance();
  return fetch(`http://127.0.0.1:${i.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${i.token}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
}
async function api(path, method, body) {
  const response = await request(path, method, body);
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function wsOpen() {
  const i = instance();
  const ws = new WebSocket(`ws://127.0.0.1:${i.port}/v1/ws`, {
    headers: { authorization: `Bearer ${i.token}` },
  });
  sockets.push(ws);
  const [message] = await once(ws, "message");
  assert.equal(JSON.parse(message.toString()).type, "hello");
  return ws;
}
after(async () => {
  for (const socket of sockets) socket.terminate();
  await cliRun("daemon", "stop").catch(() => {});
  console.log(`Phase-1 test evidence: ${temp}`);
});

test("simultaneous CLI starts share one authenticated Node Daemon, with empty global state", async () => {
  const starts = await Promise.all(Array.from({ length: 6 }, () => cliRun("daemon", "start")));
  const pids = starts.map((r) => /pid=(\d+)/.exec(r.stdout)?.[1]);
  assert.equal(new Set(pids).size, 1);
  assert.equal(Number(pids[0]), instance().pid);
  const health = await api("/v1/health");
  assert.equal(health.runtime, "node");
  assert.equal(health.nodeVersion, process.versions.node);
  assert.deepEqual(await api("/v1/snapshot"), {
    projects: [],
    conversations: [],
    cursor: 0,
    activity: { running: 0, waitingApproval: 0, pendingApprovals: 0, problems: 0, items: [] },
  });
  assert.equal((await request("/v1/health", "GET", undefined, { authorization: "" })).status, 401);
  assert.equal(
    (await request("/v1/health", "GET", undefined, { origin: "http://evil.invalid" })).status,
    403,
  );
  assert.equal(
    (await request("/v1/health", "OPTIONS", undefined, { origin: "http://evil.invalid" })).status,
    403,
  );
  assert.equal(
    (await request("/v1/daemon/stop", "POST", undefined, { authorization: "" })).status,
    401,
  );
  const socket = new WebSocket(`ws://127.0.0.1:${instance().port}/v1/ws`);
  const status = await new Promise((resolve, reject) => {
    socket.on("unexpected-response", (_req, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.on("open", () => reject(new Error("Unauthorized WS opened")));
    socket.on("error", () => {});
  });
  socket.terminate();
  assert.equal(status, 401);
});

let project;
let conversation;
test("Project/Conversation CRUD validates actual paths, canonicalizes duplicates, and preserves files", async () => {
  const missing = join(temp, "missing");
  assert.equal((await request("/v1/projects", "POST", { rootPath: missing })).status, 400);
  assert.equal(existsSync(missing), false);
  assert.equal((await request("/v1/projects", "POST", { rootPath: "." })).status, 400);
  const root = join(temp, "actual project");
  mkdirSync(root);
  writeFileSync(join(root, "keep.txt"), "user file");
  const alias = join(temp, "alias");
  symlinkSync(root, alias);
  project = await api("/v1/projects", "POST", { rootPath: alias, name: "Real workspace" });
  assert.equal(project.rootPath, root);
  const duplicate = await api("/v1/projects", "POST", { rootPath: `${root}/.` });
  assert.equal(duplicate.id, project.id);
  conversation = await api(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "Empty persisted conversation",
  });
  assert.equal(conversation.workspacePath, root);
  assert.equal(conversation.runtimeStatus, "IDLE");
  assert.equal(
    (await api(`/v1/conversations/${conversation.id}`, "PATCH", { title: "Renamed" })).title,
    "Renamed",
  );
  assert.equal(
    (await api(`/v1/projects/${project.id}`, "PATCH", { name: "Renamed project" })).name,
    "Renamed project",
  );
  const other = await api("/v1/projects", "POST", { rootPath: temp });
  assert.equal(
    (await request(`/v1/projects/${other.id}`, "PATCH", { rootPath: root })).status,
    409,
  );
  const rebound = join(temp, "rebound");
  mkdirSync(rebound);
  await api(`/v1/projects/${other.id}/conversations`, "POST", { title: "To be cascaded" });
  await api(`/v1/projects/${other.id}`, "PATCH", { rootPath: rebound });
  assert.equal((await api(`/v1/projects/${other.id}/conversations`))[0].workspacePath, rebound);
  await api(`/v1/projects/${other.id}`, "DELETE");
  assert.ok(existsSync(rebound));
  const extra = await api(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "Delete metadata",
  });
  await api(`/v1/conversations/${extra.id}`, "DELETE");
  assert.equal((await request(`/v1/conversations/${extra.id}`)).status, 404);
  assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "user file");
  assert.equal(
    (await request("/v1/projects", "POST", { rootPath: root, unknown: true })).status,
    400,
  );
  assert.equal((await request("/v1/events?after=-1")).status, 400);
});

test("real WS invalidations commit before broadcast; reconnect recovers missed changes", async () => {
  const ws = await wsOpen();
  const before = (await api("/v1/snapshot")).cursor;
  const event = once(ws, "message");
  await api(`/v1/conversations/${conversation.id}`, "PATCH", { title: "Live WS update" });
  const packet = JSON.parse((await event)[0].toString());
  assert.equal(packet.type, "change");
  const persisted = await api(`/v1/events?after=${before}`);
  assert.deepEqual(packet.event, persisted[0]);
  ws.close();
  await once(ws, "close");
  await api(`/v1/conversations/${conversation.id}`, "PATCH", { title: "While disconnected" });
  const second = await wsOpen();
  assert.equal(
    (await api("/v1/snapshot")).conversations.find((c) => c.id === conversation.id).title,
    "While disconnected",
  );
  assert.equal((await api(`/v1/events?after=${packet.event.seq}`)).length, 1);
  second.close();
});

test("SQLite uses WAL, foreign keys, schema version, and private permissions", async () => {
  for (const dir of [data, state, join(state, "logs"), join(env.XDG_CONFIG_HOME, "harnesshub")])
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const file of [
    instanceFile,
    join(state, "daemon.lock"),
    join(data, "harnesshub.db"),
    join(data, "harnesshub.db-wal"),
    join(data, "harnesshub.db-shm"),
  ])
    assert.equal(statSync(file).mode & 0o777, 0o600);
  const db = new Database(join(data, "harnesshub.db"));
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("user_version", { simple: true }), 3);
  db.pragma("foreign_keys = ON");
  assert.throws(() =>
    db
      .prepare("insert into conversations values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("invalid", "absent", "x", "shared", "/tmp", "IDLE", 1, 1),
  );
  db.close();
});

test("graceful stop and fresh Node process recover real SQLite history", async () => {
  const previous = instance().instanceId;
  await cliRun("daemon", "stop");
  assert.equal(existsSync(instanceFile), false);
  await cliRun("daemon", "start");
  assert.notEqual(instance().instanceId, previous);
  assert.equal((await api(`/v1/conversations/${conversation.id}`)).title, "While disconnected");
  assert.equal((await api("/v1/projects")).length, 1);
});

test("kernel lock recovers after Daemon crash and stale instance metadata is safely replaced", async () => {
  const old = instance();
  process.kill(old.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Deliberately point stale metadata at this unrelated live test process. CLI must never kill it.
  writeFileSync(instanceFile, JSON.stringify({ ...old, pid: process.pid }), { mode: 0o600 });
  await cliRun("daemon", "start");
  assert.notEqual(instance().pid, old.pid);
  assert.equal((await api(`/v1/conversations/${conversation.id}`)).workspacePath, project.rootPath);
});

test("doctor reports real runtime and native binding; CLI errors are explicit", async () => {
  const { stdout } = await cliRun("doctor");
  assert.match(stdout, /OK SQLite native \/ Node/);
  assert.match(stdout, /runtime=Node/);
  assert.match(stdout, /ACP: Generic SDK runtime/);
  const buildTime = statSync(cli).mtimeMs;
  await assert.rejects(
    run(bun, [resolve("scripts/install-local.ts")], { env, cwd: resolve("."), timeout: 10000 }),
    /Stop the running HarnessHub Daemon/,
  );
  assert.equal(statSync(cli).mtimeMs, buildTime, "installation guard must run before build");
  assert.equal((await cliRun("--version")).stdout.trim(), "HarnessHub 0.3.0");
  await assert.rejects(cliRun("daemon", "bogus"), /Usage/);
  await assert.rejects(cliRun(), /interactive terminal/);
});

test("pending migrations back up existing database; newer schema is refused intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hhu-migrate-"));
  const file = join(dir, "existing.db");
  let db = new Database(file);
  db.exec("create table sentinel(value text); insert into sentinel values ('keep');");
  db.close();
  const store = await openStore(file, migrations);
  store.close();
  const backup = readdirSync(dir).find((name) => name.includes(".backup-"));
  assert.ok(backup);
  assert.equal(statSync(join(dir, backup)).mode & 0o777, 0o600);
  db = new Database(join(dir, backup));
  assert.equal(db.prepare("select value from sentinel").get().value, "keep");
  assert.equal(db.pragma("user_version", { simple: true }), 0);
  db.close();
  db = new Database(file);
  db.pragma("user_version = 999");
  db.close();
  await assert.rejects(openStore(file, migrations), /newer than supported/);
  db = new Database(file);
  assert.equal(db.pragma("user_version", { simple: true }), 999);
  assert.equal(db.prepare("select value from sentinel").get().value, "keep");
  db.close();
});

test("built hhu cold-starts from home in two real PTYs; closing clients keeps the Daemon alive", async () => {
  const before = instance().instanceId;
  await cliRun("daemon", "stop");
  const { stdout } = await run("python3", [resolve("tests/e2e/terminal.py"), bun, cli], {
    env: { ...env, HARNESSHUB_PTY_PROJECT: project.rootPath },
    timeout: 45000,
  });
  assert.equal(JSON.parse(stdout).twoConcurrent, true);
  assert.equal(JSON.parse(stdout).tabCompletedRegistration, true);
  assert.notEqual(instance().instanceId, before);
  assert.equal((await api("/v1/projects")).length, 1);
});

test("actual client subscription reconnects across Daemon restart and refreshes SQLite without command replay", async () => {
  const previous = Object.fromEntries(
    ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: env.XDG_DATA_HOME,
    XDG_STATE_HOME: env.XDG_STATE_HOME,
  });
  let latest;
  const states = [];
  const stop = watchSnapshot(
    (snapshot) => {
      latest = snapshot;
    },
    (state) => states.push(state),
  );
  const waitFor = async (condition) => {
    const deadline = Date.now() + 7000;
    while (!condition() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(condition(), "Client did not reconnect to canonical snapshot");
  };
  try {
    await waitFor(() => latest?.conversations.length === 1);
    const oldId = instance().instanceId;
    await cliRun("daemon", "stop");
    await cliRun("daemon", "start");
    assert.notEqual(instance().instanceId, oldId);
    await api(`/v1/conversations/${conversation.id}`, "PATCH", {
      title: "Reconnected real client",
    });
    await waitFor(() => latest?.conversations[0]?.title === "Reconnected real client");
    assert.ok(states.includes("Disconnected · reconnecting"));
    assert.equal((await api("/v1/snapshot")).conversations.length, 1);
  } finally {
    stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
