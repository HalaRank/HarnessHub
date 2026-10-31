import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { watchConversation } from "../../dist/client/client.js";
import { openStore } from "../../dist/storage/index.js";

const run = promisify(execFile),
  bun = process.env.HARNESSHUB_BUN;
const temp = mkdtempSync(join(tmpdir(), "hhu-phase2-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_DATA_HOME: join(temp, "data"),
  XDG_STATE_HOME: join(temp, "state"),
};
const instanceFile = join(env.XDG_STATE_HOME, "harnesshub/instance.json");
const dbFile = join(env.XDG_DATA_HOME, "harnesshub/harnesshub.db");
const cli = (...args) =>
  run(bun, [resolve("dist/cli/hhu.js"), ...args], { env, cwd: tmpdir(), timeout: 25000 });
const instance = () => JSON.parse(readFileSync(instanceFile, "utf8"));
async function request(path, method = "GET", body) {
  const i = instance();
  return fetch(`http://127.0.0.1:${i.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${i.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12000),
  });
}
async function api(path, method, body) {
  const r = await request(path, method, body);
  assert.ok(r.ok, await r.clone().text());
  return r.json();
}
async function waitFor(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("Timed out waiting for runtime state");
}
let project;
const newConversation = async () =>
  api(`/v1/projects/${project.id}/conversations`, "POST", { title: "ACP test" });
const submit = (c, message, requestId = randomUUID()) =>
  api(`/v1/conversations/${c.id}/turns`, "POST", { message, requestId, harnessId: "mock" });
const turnDone = (turn) =>
  waitFor(async () => {
    const t = await api(`/v1/turns/${turn.id}`);
    return t.endedAt !== null && t;
  });
const events = async (c) => (await api(`/v1/conversations/${c.id}/events?limit=1000`)).events;
const stopSession = (c, force = false) =>
  api(`/v1/conversations/${c.id}/session/stop`, "POST", { force, confirmed: force });
after(async () => {
  await cli("daemon", "stop", "--cancel-active").catch(() => {});
  console.log(`Phase-2 test evidence: ${temp}`);
});

test("migration upgrades a real Phase-1 database without losing projects/conversations", async () => {
  const dir = join(temp, "phase1-migrations");
  mkdirSync(join(dir, "meta"), { recursive: true });
  const migrationDir = resolve("packages/storage/migrations");
  const journal = JSON.parse(readFileSync(join(migrationDir, "meta/_journal.json"), "utf8"));
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
  );
  writeFileSync(
    join(dir, `${journal.entries[0].tag}.sql`),
    readFileSync(join(migrationDir, `${journal.entries[0].tag}.sql`)),
  );
  mkdirSync(join(env.XDG_DATA_HOME, "harnesshub"), { recursive: true });
  const store = await openStore(dbFile, dir);
  project = store.addProject(temp, "Existing Phase-1 Project").value;
  const c = { id: crypto.randomUUID(), title: "Preserve this conversation" };
  store.sqlite
    .prepare(
      "INSERT INTO conversations (id, project_id, title, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(c.id, project.id, c.title, temp, Date.now(), Date.now());
  store.close();
  await cli("daemon", "start");
  assert.equal((await api(`/v1/conversations/${c.id}`)).title, c.title);
  assert.equal((await api("/v1/projects"))[0].name, project.name);
  assert.ok(readdirSync(join(env.XDG_DATA_HOME, "harnesshub")).some((p) => p.includes(".backup-")));
  const db = new Database(dbFile);
  assert.equal(db.pragma("user_version", { simple: true }), 6);
  db.close();
  await api("/v1/harness-profiles", "POST", {
    id: "mock",
    name: "Mock ACP",
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: { HHU_TEST_ONLY: "test" },
  });
  const listed = await api("/v1/harness-profiles");
  assert.equal(listed.length, 5);
  assert.equal(JSON.stringify(listed).includes("not-a-secret"), false);
});

test("SDK initialization, both cwd values, native settings, ordered raw streams and unknown events", async () => {
  const c = await newConversation();
  const s = await api(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId: "mock" });
  assert.equal(s.cwd, temp);
  assert.equal(s.capabilities.session._meta.workerCwd, temp);
  assert.equal(s.capabilities.initialize.agentInfo.name, "HarnessHub Mock");
  assert.deepEqual(s.capabilities.client, { fs: false, terminal: false });
  const config = await api(`/v1/conversations/${c.id}/settings`, "POST", {
    kind: "config",
    configId: "model",
    value: "other",
  });
  assert.equal(config.session.configOptions[0].currentValue, "other");
  assert.equal(
    (
      await request(`/v1/conversations/${c.id}/settings`, "POST", {
        kind: "config",
        configId: "model",
        value: "invented",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(`/v1/projects/${project.id}`, "PATCH", { rootPath: tmpdir() })).status,
    409,
  );
  assert.equal((await request(`/v1/conversations/${c.id}`, "DELETE", {})).status, 400);
  const turn = await submit(c, "stream");
  assert.equal((await turnDone(turn)).state, "COMPLETED");
  const all = await events(c),
    chunks = all.filter((e) => e.kind === "agent_message_chunk");
  assert.equal(chunks.length, 41);
  assert.equal(chunks[0].payload.content.text, `cwd=${temp};prompts=1\n`);
  assert.deepEqual(
    chunks.slice(1).map((e) => e.payload.content.text),
    Array.from({ length: 40 }, (_, i) => `**native-${i}**\n`),
  );
  assert.deepEqual(
    all.map((e) => e.seq),
    all.map((_, i) => i + 1),
  );
  assert.ok(
    all.some((e) => e.kind === "custom" && e.raw.params.update?.sessionUpdate === "future_update"),
  );
  assert.ok(all.some((e) => e.kind === "custom" && e.raw.method === "_custom/notice"));
  const tool = all.find((e) => e.kind === "tool_call");
  assert.equal(tool.payload.title, "Exact Native Tool Name");
  assert.equal(tool.raw.params.update.rawInput.api_key, "[REDACTED]");
  assert.equal(all.find((e) => e.kind === "user.message").turnId, turn.id);
  assert.equal(
    (await api(`/v1/conversations/${c.id}/events?after_seq=10&limit=3`)).events.length,
    3,
  );
  assert.equal((await request(`/v1/conversations/${c.id}/events?after_seq=-1`)).status, 400);
  await stopSession(c);
});

test("concurrent duplicate prompts execute once; different content and overlapping Turns are rejected", async () => {
  const c = await newConversation(),
    key = randomUUID();
  const turns = await Promise.all(Array.from({ length: 8 }, () => submit(c, "stream", key)));
  assert.equal(new Set(turns.map((t) => t.id)).size, 1);
  assert.equal((await turnDone(turns[0])).state, "COMPLETED");
  const same = await submit(c, "stream", key);
  assert.equal(same.id, turns[0].id);
  assert.equal(
    (
      await request(`/v1/conversations/${c.id}/turns`, "POST", {
        message: "different",
        requestId: key,
        harnessId: "mock",
      })
    ).status,
    409,
  );
  assert.equal(
    (await events(c)).filter((e) => e.origin === "client" && e.raw?.method === "session/prompt")
      .length,
    1,
  );
  const waiting = await submit(c, "wait");
  await waitFor(async () => (await api(`/v1/turns/${waiting.id}`)).state === "RUNNING");
  assert.equal(
    (
      await request(`/v1/conversations/${c.id}/turns`, "POST", {
        message: "duplicate side effect",
        requestId: randomUUID(),
        harnessId: "mock",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/v1/conversations/${c.id}/turns`, "POST", {
        message: "switch",
        requestId: randomUUID(),
        harnessId: "grok",
      })
    ).status,
    409,
  );
  await api(`/v1/turns/${waiting.id}/cancel`, "POST");
  await turnDone(waiting);
  await stopSession(c);
});

test("native concurrent permissions block, validate optionId, and accept only one racing decision", async () => {
  const c = await newConversation(),
    turn = await submit(c, "permissions");
  const pending = await waitFor(async () => {
    const a = await api(`/v1/conversations/${c.id}/approvals`);
    return a.length === 2 && a;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await api(`/v1/turns/${turn.id}`)).state, "WAITING_APPROVAL");
  assert.equal(
    (await request(`/v1/approvals/${pending[0].id}/decision`, "POST", { optionId: "fabricated" }))
      .status,
    400,
  );
  const decisions = await Promise.all(
    Array.from({ length: 6 }, () =>
      request(`/v1/approvals/${pending[0].id}/decision`, "POST", { optionId: "native-reject" }),
    ),
  );
  assert.equal(decisions.filter((r) => r.ok).length, 1);
  assert.equal(decisions.filter((r) => r.status === 409).length, 5);
  assert.equal((await api(`/v1/turns/${turn.id}`)).state, "WAITING_APPROVAL");
  await api(`/v1/approvals/${pending[1].id}/decision`, "POST", { optionId: "native-reject" });
  assert.equal((await turnDone(turn)).state, "COMPLETED");
  const ev = await events(c);
  assert.equal(ev.filter((e) => e.kind === "approval.decided").length, 2);
  assert.match(
    ev.find((e) => e.kind === "agent_message_chunk").payload.content.text,
    /native-reject/,
  );
  await stopSession(c);
});

test("cancel expires approvals and commits native trailing chunks before completion", async () => {
  const c = await newConversation();
  const p = await submit(c, "permission");
  const [approval] = await waitFor(async () => {
    const a = await api(`/v1/conversations/${c.id}/approvals`);
    return a.length && a;
  });
  await api(`/v1/turns/${p.id}/cancel`, "POST");
  await turnDone(p);
  assert.equal(
    (
      await request(`/v1/approvals/${approval.id}/decision`, "POST", {
        optionId: "native-allow-once",
      })
    ).status,
    409,
  );
  const turn = await submit(c, "wait");
  await waitFor(async () =>
    (await events(c)).some((e) => e.turnId === turn.id && e.kind === "agent_message_chunk"),
  );
  const cancelled = await api(`/v1/turns/${turn.id}/cancel`, "POST");
  assert.equal(cancelled.state, "CANCELLING");
  await api(`/v1/turns/${turn.id}/cancel`, "POST");
  const final = await turnDone(turn);
  assert.equal(final.state, "CANCELLED");
  const all = await events(c),
    tail = all.find((e) => e.payload?.content?.text === "native tail after cancellation");
  assert.ok(tail.seq < final.finishEventSeq);
  assert.ok(
    all.some(
      (e) => e.turnId === turn.id && e.kind === "tool_call_update" && e.seq < final.finishEventSeq,
    ),
  );
  assert.equal(
    all.filter((e) => e.turnId === turn.id && e.raw?.method === "session/cancel").length,
    1,
  );
  await stopSession(c);
});

test("independent Conversation sequences, committed WS events, pagination and real watcher reconnect", async () => {
  const first = await newConversation(),
    second = await newConversation();
  const previous = Object.fromEntries(
    ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: env.XDG_DATA_HOME,
    XDG_STATE_HOME: env.XDG_STATE_HOME,
  });
  let dispose;
  try {
    const i = instance();
    const ws = new WebSocket(`ws://127.0.0.1:${i.port}/v1/ws`, {
      headers: { authorization: `Bearer ${i.token}` },
    });
    await once(ws, "message");
    const received = [];
    ws.on("message", (m) => {
      const p = JSON.parse(m.toString());
      if (p.type === "conversation.event" && p.event.conversationId === first.id)
        received.push(p.event);
    });
    const turns = await Promise.all([submit(first, "stream"), submit(second, "stream")]);
    await Promise.all(turns.map(turnDone));
    const a = await events(first),
      b = await events(second);
    await waitFor(() => received.length === a.length);
    assert.deepEqual(received, a);
    assert.deepEqual(
      b.map((e) => e.seq),
      b.map((_, i) => i + 1),
    );
    assert.ok(a.every((e) => e.conversationId === first.id));
    assert.equal(a[0].seq, 1);
    ws.close();
    const seen = [];
    dispose = watchConversation(
      first.id,
      (e) => seen.push(e),
      () => {},
      0,
    );
    await waitFor(() => seen.length === a.length);
    dispose();
    const more = await submit(first, "stream");
    await turnDone(more);
    const seq = seen.at(-1).seq;
    dispose = watchConversation(
      first.id,
      (e) => seen.push(e),
      () => {},
      seq,
    );
    await waitFor(async () => seen.length === (await events(first)).length);
    assert.equal(new Set(seen.map((e) => e.id)).size, seen.length);
    assert.equal(
      (await events(first)).filter(
        (e) => e.raw?.method === "session/prompt" && e.origin === "client",
      ).length,
      2,
    );
    await stopSession(first);
    await stopSession(second);
  } finally {
    dispose?.();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Worker crash and lost stdio become UNCERTAIN without replay or usable stale approvals", async () => {
  for (const message of ["crash", "disconnect"]) {
    const c = await newConversation(),
      key = randomUUID(),
      t = await submit(c, message, key);
    assert.equal((await turnDone(t)).state, "UNCERTAIN");
    assert.equal((await submit(c, message, key)).id, t.id);
    assert.equal(
      (
        await request(`/v1/conversations/${c.id}/turns`, "POST", {
          message: "retry",
          harnessId: "mock",
          requestId: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (await events(c)).filter((e) => e.origin === "client" && e.raw?.method === "session/prompt")
        .length,
      1,
    );
    if (message === "disconnect") {
      assert.equal(
        (await request(`/v1/conversations/${c.id}/session/stop`, "POST", { force: false })).status,
        409,
      );
      await stopSession(c, true);
    } else await stopSession(c);
  }
});

test("daemon stop refuses active Turns; explicit cancel-active waits for tail and closes idle Workers", async () => {
  const c = await newConversation(),
    t = await submit(c, "wait");
  await waitFor(async () => (await api(`/v1/turns/${t.id}`)).state === "RUNNING");
  const pid = instance().pid;
  await assert.rejects(cli("daemon", "stop"), /Active Turns/);
  assert.equal(instance().pid, pid);
  assert.equal((await api(`/v1/turns/${t.id}`)).endedAt, null);
  await cli("daemon", "stop", "--cancel-active");
  assert.equal(existsSync(instanceFile), false);
  await cli("daemon", "start");
  assert.equal((await api(`/v1/turns/${t.id}`)).state, "CANCELLED");
  assert.ok(
    (await events(c)).some((e) => e.payload?.content?.text === "native tail after cancellation"),
  );
});

test("uncooperative cancellation keeps Daemon alive; forced stop needs explicit confirmation", async () => {
  const c = await newConversation(),
    t = await submit(c, "ignore-cancel");
  await waitFor(async () => (await events(c)).some((e) => e.kind === "agent_message_chunk"));
  await assert.rejects(cli("daemon", "stop", "--cancel-active"), /has not confirmed cancellation/);
  assert.ok(await api("/v1/health"));
  assert.equal(
    (
      await request(`/v1/conversations/${c.id}/session/stop`, "POST", {
        force: true,
        confirmed: false,
      })
    ).status,
    400,
  );
  await stopSession(c, true);
  assert.equal((await api(`/v1/turns/${t.id}`)).state, "UNCERTAIN");
});

test("Daemon crash recovers persisted history, expires approvals and never resumes/replays a Turn", async () => {
  const c = await newConversation(),
    t = await submit(c, "permission");
  const [approval] = await waitFor(async () => {
    const a = await api(`/v1/conversations/${c.id}/approvals`);
    return a.length && a;
  });
  const before = await events(c);
  process.kill(instance().pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 100));
  await cli("daemon", "start");
  assert.equal((await api(`/v1/turns/${t.id}`)).state, "UNCERTAIN");
  assert.equal((await api(`/v1/conversations/${c.id}/approvals`)).length, 0);
  assert.equal(
    (
      await request(`/v1/approvals/${approval.id}/decision`, "POST", {
        optionId: "native-allow-once",
      })
    ).status,
    409,
  );
  assert.deepEqual((await events(c)).slice(0, before.length), before);
  assert.equal(
    (await events(c)).filter((e) => e.origin === "client" && e.raw?.method === "session/prompt")
      .length,
    1,
  );
  assert.equal((await api(`/v1/conversations/${c.id}/sessions`))[0].status, "INTERRUPTED");
});

test("cancel during initialization never submits a prompt; unavailable executables leave traceable errors", async () => {
  await api("/v1/harness-profiles", "POST", {
    id: "slow-mock",
    name: "Slow mock",
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: { HHU_MOCK_INIT_DELAY: "250" },
  });
  const c = await newConversation();
  const t = await api(`/v1/conversations/${c.id}/turns`, "POST", {
    message: "must never execute",
    harnessId: "slow-mock",
    requestId: randomUUID(),
  });
  await api(`/v1/turns/${t.id}/cancel`, "POST");
  assert.equal((await turnDone(t)).state, "CANCELLED");
  assert.equal((await events(c)).filter((e) => e.raw?.method === "session/prompt").length, 0);
  await stopSession(c);
  await api("/v1/harness-profiles", "POST", {
    id: "absent",
    name: "Missing",
    command: "/not-an-installed-hhu-test-executable",
    args: [],
  });
  const missing = await newConversation();
  const failed = await api(`/v1/conversations/${missing.id}/turns`, "POST", {
    message: "must not execute",
    harnessId: "absent",
    requestId: randomUUID(),
  });
  assert.equal((await turnDone(failed)).state, "ERROR");
  assert.ok((await events(missing)).some((e) => e.kind === "runtime.session_error"));
  assert.equal(
    (await events(missing)).find((e) => e.kind === "runtime.turn_finished").turnId,
    failed.id,
  );
});

test("application logs contain no prompts, native tool output or profile environment values", () => {
  const logDir = join(env.XDG_STATE_HOME, "harnesshub/logs");
  const logs = readdirSync(logDir)
    .map((p) => readFileSync(join(logDir, p), "utf8"))
    .join("\n");
  for (const forbidden of [
    "must never execute",
    "**native-",
    "not-a-secret",
    "Exact Native Tool Name",
    "native tail after cancellation",
  ])
    assert.equal(logs.includes(forbidden), false);
});

test("negotiated session/close blocks racing prompts and closes before Worker termination", async () => {
  await api("/v1/harness-profiles", "POST", {
    id: "closing-mock",
    name: "Closing mock",
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: { HHU_MOCK_CLOSE_DELAY: "200" },
  });
  const c = await newConversation();
  await api(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId: "closing-mock" });
  const closing = stopSession(c);
  await waitFor(
    async () => (await api(`/v1/conversations/${c.id}/sessions`)).at(-1).status === "CLOSING",
  );
  assert.equal(
    (
      await request(`/v1/conversations/${c.id}/turns`, "POST", {
        message: "must not race shutdown",
        harnessId: "closing-mock",
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  await closing;
  assert.equal((await api(`/v1/conversations/${c.id}/sessions`)).at(-1).status, "CLOSED");
  assert.equal(
    (await events(c)).filter((e) => e.raw?.method === "session/close" && e.origin === "client")
      .length,
    1,
  );
  assert.equal((await events(c)).filter((e) => e.raw?.method === "session/prompt").length, 0);
});
