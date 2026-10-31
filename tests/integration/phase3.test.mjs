import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { watchConversation, watchSnapshot } from "../../dist/client/client.js";
import { openStore } from "../../dist/storage/index.js";

const temp = mkdtempSync(join(tmpdir(), "hhu-phase3-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_DATA_HOME: join(temp, "data"),
  XDG_STATE_HOME: join(temp, "state"),
  HHU_TEST_API_KEY: "private-inherited-test-credential",
};
const instanceFile = join(env.XDG_STATE_HOME, "harnesshub/instance.json");
const dbFile = join(env.XDG_DATA_HOME, "harnesshub/harnesshub.db");
const run = promisify(execFile);
const cli = (...args) =>
  run(process.env.HARNESSHUB_BUN, [resolve("dist/cli/hhu.js"), ...args], {
    env,
    cwd: process.env.HOME,
    timeout: 30000,
  });
const instance = () => JSON.parse(readFileSync(instanceFile, "utf8"));
async function response(path, method = "GET", body) {
  const i = instance();
  return fetch(`http://127.0.0.1:${i.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${i.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
}
async function api(path, method, body) {
  const r = await response(path, method, body);
  assert.ok(r.ok, `${r.status} ${await r.clone().text()}`);
  return r.json();
}
async function waitFor(fn) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("Phase 3 state timeout");
}
const conversation = (project) =>
  api(`/v1/projects/${project.id}/conversations`, "POST", { title: randomUUID() });
const submit = (c, message, requestId = randomUUID()) =>
  api(`/v1/conversations/${c.id}/turns`, "POST", { message, requestId, harnessId: "mock" });
const done = (turn) =>
  waitFor(async () => {
    const t = await api(`/v1/turns/${turn.id}`);
    return t.endedAt && t;
  });
const page = (c, after = 0, limit = 1000) =>
  api(`/v1/conversations/${c.id}/events?after_seq=${after}&limit=${limit}`);
async function history(c) {
  const events = [];
  let cursor = 0;
  for (;;) {
    const p = await page(c, cursor);
    events.push(...p.events);
    cursor = events.at(-1)?.seq ?? 0;
    if (cursor === p.cursor) return events;
  }
}
const stop = (c) => api(`/v1/conversations/${c.id}/session/stop`, "POST", {});
let first, second;
const previous = Object.fromEntries(
  ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].map((k) => [k, process.env[k]]),
);
Object.assign(process.env, {
  XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: env.XDG_DATA_HOME,
  XDG_STATE_HOME: env.XDG_STATE_HOME,
});
after(async () => {
  await cli("daemon", "stop", "--cancel-active").catch(() => {});
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  console.log(`Phase-3 test evidence: ${temp}`);
});

test("incremental Phase 2 migration preserves history and privately stored legacy profiles", async () => {
  const migrations = resolve("packages/storage/migrations");
  const dir = join(temp, "phase2-migrations");
  mkdirSync(join(dir, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json")));
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }),
  );
  for (const e of journal.entries.slice(0, 2))
    writeFileSync(join(dir, `${e.tag}.sql`), readFileSync(join(migrations, `${e.tag}.sql`)));
  const store = await openStore(dbFile, dir);
  const p = store.addProject(temp, "Legacy Project").value;
  const c = store.addConversation(p.id, "Legacy Conversation").value;
  store.sqlite.prepare("INSERT INTO harness_profiles VALUES (?, ?)").run(
    "legacy",
    JSON.stringify({
      id: "legacy",
      name: "Legacy",
      command: "node",
      args: [],
      envOverrides: { API_KEY: "legacy-private-secret" },
    }),
  );
  store.close();
  await cli("daemon", "start");
  assert.equal((await api(`/v1/conversations/${c.id}`)).title, c.title);
  assert.ok(readdirSync(join(env.XDG_DATA_HOME, "harnesshub")).some((f) => f.includes(".backup-")));
  const db = new Database(dbFile);
  assert.equal(db.pragma("user_version", { simple: true }), 4);
  db.close();
  for (const name of ["first project", "第二项目"]) mkdirSync(join(temp, name));
  first = await api("/v1/projects", "POST", { rootPath: join(temp, "first project") });
  second = await api("/v1/projects", "POST", { rootPath: join(temp, "第二项目") });
  await api("/v1/harness-profiles", "POST", {
    id: "mock",
    name: "Phase 3 Mock",
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
  });
});

test("parallel projects have separate native sessions, cwd, events, cancellation and background approvals", async () => {
  const a = await conversation(first),
    b = await conversation(second);
  const [ta, tb] = await Promise.all([submit(a, "wait"), submit(b, "permissions")]);
  await waitFor(async () => (await api(`/v1/conversations/${b.id}/approvals`)).length === 2);
  const snapshot = await api("/v1/snapshot");
  assert.equal(snapshot.activity.running, 2);
  assert.equal(snapshot.activity.waitingApproval, 1);
  assert.equal(snapshot.activity.pendingApprovals, 2);
  assert.ok(
    snapshot.activity.items.some((i) => i.conversationId === b.id && i.activeTurnId === tb.id),
  );
  const sa = (await api(`/v1/conversations/${a.id}/sessions`))[0],
    sb = (await api(`/v1/conversations/${b.id}/sessions`))[0];
  assert.notEqual(sa.id, sb.id);
  assert.notEqual(sa.workerId, sb.workerId);
  assert.equal(sa.cwd, first.rootPath);
  assert.equal(sb.cwd, second.rootPath);
  assert.equal(sa.capabilities.session._meta.workerCwd, first.rootPath);
  assert.equal(sb.capabilities.session._meta.workerCwd, second.rootPath);
  assert.equal(
    (await history(a)).some((e) => e.kind === "approval.requested"),
    false,
  );
  await api(`/v1/turns/${ta.id}/cancel`, "POST");
  await done(ta);
  assert.equal((await api(`/v1/turns/${tb.id}`)).state, "WAITING_APPROVAL");
  for (const approval of await api(`/v1/conversations/${b.id}/approvals`))
    await api(`/v1/approvals/${approval.id}/decision`, "POST", { optionId: "native-reject" });
  assert.equal((await done(tb)).state, "COMPLETED");
  for (const c of [a, b]) {
    const events = await history(c);
    assert.ok(events.every((e) => e.conversationId === c.id));
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, i) => i + 1),
    );
    await stop(c);
  }
});

test("shared workspaces allow concurrent Turns and emit file-conflict warning without a global lock", async () => {
  const a = await conversation(first),
    b = await conversation(first);
  const ta = await submit(a, "wait");
  await waitFor(async () => (await api(`/v1/turns/${ta.id}`)).state === "RUNNING");
  const tb = await submit(b, "wait");
  await waitFor(async () => (await api(`/v1/turns/${tb.id}`)).state === "RUNNING");
  assert.ok((await history(b)).some((e) => e.kind === "runtime.workspace_warning"));
  for (const [c, t] of [
    [a, ta],
    [b, tb],
  ]) {
    await api(`/v1/turns/${t.id}/cancel`, "POST");
    await done(t);
    await stop(c);
  }
});

test("draft CAS, durable request reservation, duplicate clients and preferences survive restart", async () => {
  const c = await conversation(first);
  const path = `/v1/conversations/${c.id}/draft`;
  const original = await api(path);
  assert.equal(original.revision, 0);
  let d = await api(path, "PUT", { revision: 0, text: "未发送\n**native**" });
  assert.equal((await response(path, "PUT", { revision: 0, text: "stale client" })).status, 409);
  assert.equal((await api(path)).text, d.text);
  await api("/v1/preferences", "PATCH", {
    lastProjectId: first.id,
    lastConversationId: c.id,
    showActivity: false,
  });
  await cli("daemon", "stop");
  await cli("daemon", "start");
  assert.deepEqual(await api(path), d);
  assert.deepEqual(await api("/v1/preferences"), {
    lastProjectId: first.id,
    lastConversationId: c.id,
    showActivity: false,
    showSidebar: true,
    shortcuts: {},
  });
  const input = { requestId: randomUUID(), harnessId: "mock", message: "stream" };
  d = await api(path, "PUT", {
    revision: d.revision,
    text: input.message,
    pendingSubmission: input,
  });
  assert.equal((await response(`/v1/requests/${input.requestId}`)).status, 404);
  assert.equal((await history(c)).length, 0); // Reopen/read is not a submission.
  const turns = await Promise.all(
    Array.from({ length: 10 }, () => api(`/v1/conversations/${c.id}/turns`, "POST", input)),
  );
  assert.equal(new Set(turns.map((t) => t.id)).size, 1);
  await done(turns[0]);
  assert.equal((await api(`/v1/requests/${input.requestId}`)).id, turns[0].id);
  assert.equal((await api(path)).text, "");
  assert.equal((await api(path)).pendingSubmission, null);
  assert.equal(
    (await response(path, "PUT", { revision: d.revision, text: "late autosave" })).status,
    409,
  );
  assert.equal(
    (await history(c)).filter((e) => e.origin === "client" && e.raw?.method === "session/prompt")
      .length,
    1,
  );
  await stop(c);
  await cli("daemon", "stop");
  await cli("daemon", "start");
  assert.equal((await api(`/v1/requests/${input.requestId}`)).id, turns[0].id);
  assert.equal((await api(`/v1/conversations/${c.id}/turns`, "POST", input)).id, turns[0].id);
  assert.equal((await api(path)).text, "");
});

// A TCP/HTTP proxy severs actual WebSocket connections while leaving the Daemon/Workers alive.
async function disconnectProxy() {
  const target = instance(),
    tunnels = new Set();
  const server = createServer((req, res) => {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = tcpConnect(target.port, "127.0.0.1", () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    tunnels.add(socket);
    socket.on("close", () => {
      tunnels.delete(socket);
      upstream.destroy();
    });
    upstream.on("error", () => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeFileSync(instanceFile, JSON.stringify({ ...target, port: server.address().port }), {
    mode: 0o600,
  });
  return {
    drop: () => {
      for (const s of tunnels) s.destroy();
    },
    close: async () => {
      writeFileSync(instanceFile, JSON.stringify(target), { mode: 0o600 });
      for (const s of tunnels) s.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

test("two clients reconnect across real WS disconnects, page long history in order and never send a Prompt", async () => {
  const c = await conversation(second);
  await done(await submit(c, "long-history"));
  const initial = await history(c);
  assert.ok(initial.length > 2500);
  const proxy = await disconnectProxy();
  const disposers = [],
    seen = [[], []],
    states = [],
    batches = [];
  let latest;
  try {
    disposers.push(
      watchSnapshot(
        (s) => {
          latest = s;
        },
        () => {},
      ),
    );
    for (let n = 0; n < 2; n++)
      disposers.push(
        watchConversation(
          c.id,
          () => {},
          (s) => states.push(s),
          0,
          (batch) => {
            seen[n].push(...batch);
            batches.push(batch.length);
          },
        ),
      );
    await waitFor(() => seen.every((s) => s.length === initial.length));
    assert.ok(batches.length > 20);
    assert.ok(batches.every((n) => n <= 200));
    const sessionBefore = (await api(`/v1/conversations/${c.id}/sessions`)).at(-1).id;
    const t = await submit(c, "timed");
    await waitFor(() => seen[0].length > initial.length + 5);
    proxy.drop();
    await waitFor(() => states.includes("Disconnected · reconnecting"));
    await done(t);
    const all = await history(c);
    await waitFor(() => seen.every((s) => s.length === all.length));
    for (const s of seen) {
      assert.deepEqual(s, all);
      assert.equal(new Set(s.map((e) => e.id)).size, all.length);
    }
    await waitFor(() => latest?.conversations.find((v) => v.id === c.id)?.runtimeStatus === "IDLE");
    assert.equal((await api(`/v1/conversations/${c.id}/sessions`)).at(-1).id, sessionBefore);
    assert.equal(
      all.filter((e) => e.raw?.method === "session/prompt" && e.origin === "client").length,
      2,
    );
  } finally {
    for (const d of disposers) d();
    await proxy.close();
    await stop(c);
  }
});

test("Daemon SIGKILL expires background approvals, marks idle sessions INTERRUPTED and active execution UNCERTAIN", async () => {
  const idle = await conversation(first),
    active = await conversation(second);
  await done(await submit(idle, "stream"));
  const input = { requestId: randomUUID(), harnessId: "mock", message: "permission" };
  const turn = await api(`/v1/conversations/${active.id}/turns`, "POST", input);
  const approvals = await waitFor(async () => {
    const a = await api(`/v1/conversations/${active.id}/approvals`);
    return a.length && a;
  });
  const before = await history(active),
    seen = [];
  const states = [];
  const dispose = watchConversation(
    active.id,
    (e) => seen.push(e),
    (s) => states.push(s),
  );
  try {
    await waitFor(() => seen.length === before.length);
    process.kill(instance().pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 150));
    await cli("daemon", "start");
    const all = await history(active);
    await waitFor(() => seen.length === all.length);
    assert.deepEqual(seen, all);
    assert.ok(states.includes("Disconnected · reconnecting"));
    assert.equal((await api(`/v1/turns/${turn.id}`)).state, "UNCERTAIN");
    assert.equal((await api(`/v1/conversations/${idle.id}`)).runtimeStatus, "INTERRUPTED");
    assert.equal((await api(`/v1/conversations/${active.id}`)).runtimeStatus, "UNCERTAIN");
    assert.equal((await api(`/v1/conversations/${active.id}/approvals`)).length, 0);
    assert.equal(
      (
        await response(`/v1/approvals/${approvals[0].id}/decision`, "POST", {
          optionId: "native-allow-once",
        })
      ).status,
      409,
    );
    assert.equal((await api(`/v1/conversations/${active.id}/turns`, "POST", input)).id, turn.id);
    assert.equal(
      (
        await response(`/v1/conversations/${active.id}/turns`, "POST", {
          ...input,
          requestId: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      all.filter((e) => e.raw?.method === "session/prompt" && e.origin === "client").length,
      1,
    );
    assert.ok((await api("/v1/snapshot")).activity.problems >= 2);
    for (const c of [idle, active])
      assert.equal((await api(`/v1/conversations/${c.id}/sessions`)).at(-1).status, "INTERRUPTED");
  } finally {
    dispose();
  }
});

test("invalid project roots are never recreated; rebinding updates only stopped Conversation workspaces", async () => {
  const root = join(temp, "rebind-source");
  mkdirSync(root);
  const p = await api("/v1/projects", "POST", { rootPath: root }),
    c = await conversation(p);
  renameSync(root, `${root}-moved`);
  assert.equal(
    (
      await response(`/v1/conversations/${c.id}/turns`, "POST", {
        requestId: randomUUID(),
        message: "stream",
        harnessId: "mock",
      })
    ).status,
    400,
  );
  await api(`/v1/projects/${p.id}`, "PATCH", { rootPath: `${root}-moved` });
  assert.equal((await api(`/v1/conversations/${c.id}`)).workspacePath, `${root}-moved`);
  await done(await submit(c, "stream"));
  assert.equal((await api(`/v1/conversations/${c.id}/sessions`))[0].cwd, `${root}-moved`);
  await stop(c);
});

test("Profiles inherit native credentials, reject new credential overrides and disclose only legacy key names", async () => {
  const c = await conversation(first);
  const s = await api(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId: "mock" });
  assert.equal(s.capabilities.session._meta.inheritedCredential, true);
  const listed = await api("/v1/harness-profiles");
  assert.deepEqual(listed.find((p) => p.id === "legacy").sensitiveEnvOverrideKeys, ["API_KEY"]);
  for (const name of [
    "OPENAI_API_KEY",
    "TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "PASSWORD",
    "GITHUB_TOKEN",
  ]) {
    const r = await response("/v1/harness-profiles", "POST", {
      id: "unsafe",
      name: "Unsafe",
      command: "node",
      envOverrides: { [name]: "never-store-this" },
    });
    assert.equal(r.status, 400);
    assert.equal((await r.text()).includes("never-store-this"), false);
  }
  const db = new Database(dbFile, { readonly: true });
  assert.equal(
    JSON.stringify(db.prepare("SELECT * FROM harness_profiles").all()).includes("never-store-this"),
    false,
  );
  db.close();
  const logs = readdirSync(join(env.XDG_STATE_HOME, "harnesshub/logs"))
    .map((f) => readFileSync(join(env.XDG_STATE_HOME, "harnesshub/logs", f), "utf8"))
    .join("");
  for (const secret of [
    "private-inherited-test-credential",
    "legacy-private-secret",
    "never-store-this",
  ])
    assert.equal((JSON.stringify(listed) + logs).includes(secret), false);
  await stop(c);
});

test("large Unicode drafts obey schema bounds; CAS races and metadata deletion preserve user files", async () => {
  const root = join(temp, "draft-limits");
  mkdirSync(root);
  writeFileSync(join(root, "keep.txt"), "user file");
  const p = await api("/v1/projects", "POST", { rootPath: root }),
    c = await conversation(p);
  const path = `/v1/conversations/${c.id}/draft`,
    text = "项目🙂\n".repeat(10000);
  const pendingSubmission = { requestId: randomUUID(), message: text, harnessId: "mock" };
  const d = await api(path, "PUT", { revision: 0, text, pendingSubmission });
  assert.deepEqual(await api(path), d);
  assert.equal((await history(c)).length, 0);
  assert.equal(
    (await response(path, "PUT", { revision: d.revision, text: "x".repeat(100001) })).status,
    400,
  );
  const races = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      response(path, "PUT", { revision: d.revision, text: `client-${i}` }),
    ),
  );
  assert.equal(races.filter((r) => r.status === 200).length, 1);
  assert.equal(races.filter((r) => r.status === 409).length, 7);
  await api("/v1/preferences", "PATCH", { lastProjectId: p.id, lastConversationId: c.id });
  assert.equal(
    (
      await response("/v1/preferences", "PATCH", {
        lastProjectId: second.id,
        lastConversationId: c.id,
      })
    ).status,
    400,
  );
  await api(`/v1/conversations/${c.id}`, "DELETE");
  assert.equal((await response(path)).status, 404);
  assert.equal((await api("/v1/preferences")).lastConversationId, null);
  await api(`/v1/projects/${p.id}`, "DELETE");
  assert.equal((await api("/v1/preferences")).lastProjectId, null);
  assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "user file");
  const db = new Database(dbFile, { readonly: true });
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM conversation_drafts WHERE conversation_id=?").get(c.id).n,
    0,
  );
  db.close();
});
