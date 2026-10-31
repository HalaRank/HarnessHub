import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import { Client } from "../../dist/client/client.js";

const temp = mkdtempSync(join(tmpdir(), "hhu-phase5-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_DATA_HOME: join(temp, "data"),
  XDG_STATE_HOME: join(temp, "state"),
};
const cli = (...args) =>
  execFileSync(process.env.HARNESSHUB_BUN, [resolve("dist/cli/hhu.js"), ...args], {
    env,
    timeout: 30000,
    encoding: "utf8",
  });
const dbFile = join(env.XDG_DATA_HOME, "harnesshub/harnesshub.db");
const instance = () =>
  JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json")));
cli("daemon", "start");
let client = new Client(instance());
const api = (path, method, body) => client.request(path, method, body);
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const root = join(temp, "git project 世界");
mkdirSync(root);
git(root, "init", "-b", "main");
writeFileSync(join(root, "tracked.txt"), "source\n");
git(root, "add", ".");
git(root, "-c", "user.name=HHU", "-c", "user.email=test@localhost", "commit", "-m", "fixture");
const project = await api("/v1/projects", "POST", { rootPath: root });
const conv = async (workspaceMode = "shared") =>
  api(`/v1/projects/${project.id}/conversations`, "POST", { title: "Phase 5", workspaceMode });
const path = (c) => `/v1/conversations/${c.id}`;
const events = async (c) => (await api(`${path(c)}/events?limit=1000`)).events;
const sessions = (c) => api(`${path(c)}/sessions`);
const handoffs = (c) => api(`${path(c)}/handoffs`);
const select = (c, harnessId) => api(`${path(c)}/harness`, "PUT", { harnessId });
const submit = (c, harnessId = "a", message = "stream", requestId = crypto.randomUUID()) =>
  api(`${path(c)}/turns`, "POST", { harnessId, message, requestId });
const profiles = new Map();
async function profile(id, overrides = {}) {
  profiles.set(id, overrides);
  await api("/v1/harness-profiles", "POST", {
    id,
    name: id,
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: overrides,
  });
}
async function until(check) {
  for (let n = 0; n < 500; n++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Phase 5 state timed out");
}
const settled = (turn) =>
  until(async () => {
    const t = await api(`/v1/turns/${turn.id}`);
    return t.endedAt && t;
  });
const hstate = (c, state) =>
  until(async () => {
    const h = (await handoffs(c)).at(-1);
    return h?.status === state && h;
  });
const action = (c, h, action) =>
  api(`${path(c)}/handoff/action`, "POST", { handoffId: h.id, action });
const conflict = (promise) => assert.rejects(promise, (e) => e.status === 409);
await profile("a");
await profile("b");
after(() => {
  cli("daemon", "stop", "--cancel-active");
  console.log(`Phase-5 integration evidence: ${temp}`);
});

test("A → B → A creates three native sessions, same Harness reuses, pending selection has zero model calls and cancels", async () => {
  const c = await conv();
  assert.equal(c.workspaceMode, "shared");
  assert.equal(c.workspacePath, root);
  await settled(await submit(c));
  const first = (await sessions(c))[0];
  await settled(await submit(c));
  assert.equal((await sessions(c)).length, 1);
  const before = (await events(c)).filter((e) => e.raw?.method === "session/prompt").length;
  await select(c, "b");
  await select(c, "a");
  assert.equal((await events(c)).filter((e) => e.raw?.method === "session/prompt").length, before);
  assert.equal((await handoffs(c)).length, 0);
  await settled(await submit(c));
  assert.equal((await sessions(c))[0].id, first.id);
  await select(c, "b");
  const t = await submit(c, "b", "second segment");
  assert.equal((await settled(t)).state, "COMPLETED");
  const h = await hstate(c, "COMMITTED");
  await until(async () => (await sessions(c)).find((s) => s.id === first.id).status === "CLOSED");
  assert.equal(h.sourceNativeSessionId, first.id);
  assert.equal(h.firstTargetRequestId, t.requestId);
  assert.match(h.reportText, /## Current Objective/);
  assert.ok(h.sourceEventEnd > 0);
  assert.ok(h.generatedAt);
  assert.equal((await api(path(c))).activeNativeSessionId, h.targetNativeSessionId);
  await settled(await submit(c, "a", "return to first"));
  await hstate(c, "COMMITTED");
  const ss = await sessions(c);
  assert.equal(ss.length, 3);
  assert.deepEqual(
    ss.map((s) => s.harnessId),
    ["a", "b", "a"],
  );
  assert.notEqual(ss[0].id, ss[2].id);
  assert.ok(ss.every((s) => s.cwd === root));
  const es = await events(c);
  assert.equal(es.filter((e) => e.kind === "user.message").length, 5);
  assert.equal(
    es.filter((e) => e.raw?.method === "session/prompt" && e.purpose === "handoff_internal").length,
    2,
  );
  const targetPrompt = es.find(
    (e) => e.raw?.method === "session/prompt" && e.nativeSessionId === ss[1].id,
  );
  assert.match(targetPrompt.payload.prompt[0].text, /Historical background/);
  assert.match(targetPrompt.payload.prompt[0].text, /\[New user message\]\nsecond segment$/);
  assert.equal(
    es.find((e) => e.turnId === t.id && e.kind === "user.message").payload.text,
    "second segment",
  );
  assert.equal(
    es.filter((e) => e.seq <= h.sourceEventEnd).some((e) => e.turnId === t.id),
    false,
  );
});

test("two clients duplicate target submissions use one reservation/report/Prompt; cross-content and overlapping requests are rejected", async () => {
  await profile("slow", { HHU_MOCK_REPORT_DELAY: "200" });
  const c = await conv();
  await settled(await submit(c, "slow"));
  const requestId = crypto.randomUUID();
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      new Client(instance()).request(`${path(c)}/turns`, "POST", {
        harnessId: "b",
        message: "unique",
        requestId,
      }),
    ),
  );
  assert.equal(new Set(attempts.map((t) => t.id)).size, 1);
  await conflict(submit(c, "a", "overlap"));
  await conflict(submit(c, "b", "different", requestId));
  await conflict(select(c, "a"));
  await settled(attempts[0]);
  assert.equal((await handoffs(c)).length, 1);
  assert.equal((await events(c)).filter((e) => e.raw?.method === "session/prompt").length, 3);
  const before = (await events(c)).length;
  const replay = await submit(c, "b", "unique", requestId);
  assert.equal(replay.id, attempts[0].id);
  await api(`${path(c)}/events?after_seq=${before}`);
  assert.equal((await events(c)).length, before);
});

test("generation failure holds target, explicit cancel never sends; explicit retry stays on same request", async () => {
  await profile("bad-report", { HHU_MOCK_REPORT_FAIL: "1" });
  const c = await conv();
  await settled(await submit(c, "bad-report"));
  const t = await submit(c, "b", "reserved once");
  const h = await hstate(c, "FAILED");
  assert.equal((await sessions(c)).length, 1);
  assert.match(h.fallbackText, /Context may be incomplete/);
  assert.ok(h.fallbackSources.eventIds.length);
  assert.equal((await api(`/v1/turns/${t.id}`)).endedAt, null);
  await action(c, h, "retry");
  await hstate(c, "FAILED");
  assert.equal(
    (await events(c)).filter((e) => e.kind === "user.message" && e.turnId === t.id).length,
    1,
  );
  await action(c, h, "cancel");
  assert.equal((await api(`/v1/turns/${t.id}`)).state, "CANCELLED");
  assert.equal((await sessions(c)).length, 1);
  assert.equal((await handoffs(c))[0].status, "CANCELLED");
  await settled(await submit(c, "bad-report", "source continues"));
  assert.equal((await sessions(c)).length, 1);
});

test("degraded continuation requires confirmation, uses prior saved report and observable history without another user message", async () => {
  const c = await conv();
  await settled(await submit(c));
  await settled(await submit(c, "bad-report", "first switch"));
  const prior = (await handoffs(c))[0];
  assert.ok(prior.reportText);
  const t = await submit(c, "b", "degraded target");
  const h = await hstate(c, "FAILED");
  assert.equal(h.fallbackSources.priorHandoffId, prior.id);
  assert.ok(h.fallbackText.includes(prior.reportText));
  assert.equal((await sessions(c)).length, 2);
  await action(c, h, "confirm");
  assert.equal((await settled(t)).state, "COMPLETED");
  const done = await hstate(c, "COMMITTED");
  assert.equal(done.degraded, true);
  assert.ok(done.confirmedAt);
  assert.equal(
    (await events(c)).filter((e) => e.kind === "user.message" && e.turnId === t.id).length,
    1,
  );
  await conflict(action(c, done, "confirm"));
});

test("target Session creation failure preserves source and report; target RPC rejection is UNCERTAIN and never resends", async () => {
  await profile("new-fail", { HHU_MOCK_NEW_FAIL: "1" });
  await profile("reject-target", { HHU_MOCK_TARGET_REJECT: "1" });
  const c = await conv();
  await settled(await submit(c));
  const source = (await sessions(c))[0];
  const t = await submit(c, "new-fail");
  const h = await hstate(c, "FAILED");
  assert.ok(h.reportText);
  assert.equal((await api(path(c))).activeNativeSessionId, source.id);
  assert.equal(
    (await events(c)).some(
      (e) => e.raw?.method === "session/prompt" && e.nativeSessionId !== source.id,
    ),
    false,
  );
  await action(c, h, "cancel");
  assert.equal((await settled(t)).state, "CANCELLED");
  const u = await submit(c, "reject-target", "cannot safely retry");
  assert.equal((await settled(u)).state, "UNCERTAIN");
  const uncertain = await hstate(c, "UNCERTAIN");
  assert.ok(uncertain.targetNativeSessionId);
  const count = (await events(c)).filter((e) => e.raw?.method === "session/prompt").length;
  await submit(c, "reject-target", "cannot safely retry", u.requestId);
  await conflict(action(c, uncertain, "retry"));
  await conflict(submit(c));
  assert.equal((await events(c)).filter((e) => e.raw?.method === "session/prompt").length, count);
  await api(`${path(c)}/session/stop`, "POST", { force: true, confirmed: true }); // explicit disposal of test-only uncertain Mock
});

test("source running, approval and cancellation block target execution; internal report permissions remain native user decisions", async () => {
  for (const message of ["wait", "permission"]) {
    const c = await conv(),
      t = await submit(c, "a", message);
    await until(async () =>
      (await events(c)).some(
        (e) => e.kind === (message === "wait" ? "agent_message_chunk" : "approval.requested"),
      ),
    );
    await select(c, "b");
    await conflict(submit(c, "b"));
    assert.equal((await sessions(c)).length, 1);
    await api(`/v1/turns/${t.id}/cancel`, "POST");
    await settled(t);
    await select(c, "a");
    await settled(await submit(c));
    assert.equal((await sessions(c)).length, 1);
  }
  await profile("report-permission", { HHU_MOCK_REPORT_PERMISSION: "1" });
  const c = await conv();
  await settled(await submit(c, "report-permission"));
  const t = await submit(c, "b");
  const approvals = await until(async () => {
    const a = await api(`${path(c)}/approvals`);
    return a.length && a;
  });
  assert.equal((await sessions(c)).length, 1);
  await conflict(submit(c, "b"));
  assert.equal(approvals[0].request.options[0].optionId, "reject");
  await api(`/v1/approvals/${approvals[0].id}/decision`, "POST", { optionId: "reject" });
  assert.equal((await settled(t)).state, "COMPLETED");
});

test("isolated worktrees bind actual cwd, preserve on Conversation deletion, reject dirty/ignored files and preserve branch on safe cleanup", async () => {
  const c = await conv("worktree"),
    d = await conv("worktree");
  assert.notEqual(c.workspacePath, root);
  assert.notEqual(c.workspacePath, d.workspacePath);
  const w = (await api("/v1/worktrees")).find((w) => w.id === c.worktreeId);
  assert.equal(c.workspacePath, w.path);
  assert.equal(git(w.path, "branch", "--show-current").trim(), w.branch);
  const ts = await Promise.all([
    submit(c, "a", "timed"),
    submit(d, "b", "timed"),
    submit(await conv(), "a", "timed"),
  ]);
  assert.ok((await api("/v1/snapshot")).activity.running >= 3);
  await Promise.all(ts.map(settled));
  const ss = (await sessions(c))[0];
  assert.equal(ss.cwd, c.workspacePath);
  assert.equal(ss.capabilities.session._meta.workerCwd, c.workspacePath);
  assert.equal(
    (await events(c)).find((e) => e.raw?.method === "session/new").payload.cwd,
    c.workspacePath,
  );
  await settled(await submit(c, "b"));
  assert.ok((await sessions(c)).every((s) => s.cwd === w.path));
  assert.equal((await api(`${path(c)}/changes`)).workspace, w.path);
  await conflict(api(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true }));
  writeFileSync(join(w.path, "untracked.txt"), "user data");
  await api(path(c), "DELETE", { confirmed: true });
  assert.ok(existsSync(join(w.path, "untracked.txt")));
  await conflict(api(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true }));
  unlinkSync(join(w.path, "untracked.txt"));
  writeFileSync(join(w.path, "tracked.txt"), "dirty");
  await conflict(api(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true }));
  writeFileSync(join(w.path, "tracked.txt"), "source\n");
  const exclude = git(w.path, "rev-parse", "--git-path", "info/exclude").trim();
  writeFileSync(exclude, "ignored-file\n");
  writeFileSync(join(w.path, "ignored-file"), "precious");
  await conflict(api(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true }));
  unlinkSync(join(w.path, "ignored-file"));
  await assert.rejects(api(`/v1/worktrees/${w.id}/cleanup`, "POST", {}), (e) => e.status === 400);
  assert.equal(
    (await api(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true })).status,
    "REMOVED",
  );
  assert.equal(existsSync(w.path), false);
  assert.equal(git(root, "rev-parse", "--verify", `refs/heads/${w.branch}`).trim().length, 40);
  assert.ok(existsSync(d.workspacePath));
});

test("non-Git projects refuse worktree creation; ownership/branch mismatches refuse cleanup", async () => {
  const plain = join(temp, "plain");
  mkdirSync(plain);
  const p = await api("/v1/projects", "POST", { rootPath: plain });
  await conflict(
    api(`/v1/projects/${p.id}/conversations`, "POST", {
      title: "invalid",
      workspaceMode: "worktree",
    }),
  );
  assert.deepEqual(await api(`/v1/projects/${p.id}/conversations`), []);
  const c = await conv("worktree");
  const w = (await api("/v1/worktrees")).find((w) => w.id === c.worktreeId);
  await api(path(c), "DELETE", { confirmed: true });
  git(w.path, "switch", "-c", "user-branch");
  await conflict(api(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true }));
  assert.ok(existsSync(w.path));
});

test("shared Conversations remain parallel with conflict warning and never mix native history", async () => {
  const c = await conv(),
    d = await conv();
  const ts = await Promise.all([submit(c, "a", "timed"), submit(d, "b", "timed")]);
  await Promise.all(ts.map(settled));
  const both = await Promise.all([events(c), events(d)]);
  assert.ok(both.flat().some((e) => e.kind === "runtime.workspace_warning"));
  assert.ok(both[0].every((e) => e.conversationId === c.id));
  assert.ok(both[1].every((e) => e.conversationId === d.id));
  assert.notEqual((await sessions(c))[0].id, (await sessions(d))[0].id);
});

test("restart from failed report preserves reservation and requires explicit confirmation without replaying source", async () => {
  const c = await conv();
  await settled(await submit(c, "bad-report"));
  const t = await submit(c, "b", "restart reserved");
  const h = await hstate(c, "FAILED");
  // A clean stop cannot discard a held user request; explicitly cancel test reservation then seed its crash snapshot offline.
  await action(c, h, "cancel");
  cli("daemon", "stop");
  const db = new Database(dbFile);
  db.prepare("UPDATE handoffs SET status='READY' WHERE id=?").run(h.id);
  db.prepare("UPDATE turns SET state='RUNNING', ended_at=NULL WHERE id=?").run(t.id);
  db.close();
  cli("daemon", "start");
  client = new Client(instance());
  const failed = await hstate(c, "FAILED");
  assert.match(failed.error, /daemon_restart/);
  assert.equal((await api(`/v1/turns/${t.id}`)).state, "PREPARING");
  assert.equal(
    (await events(c)).filter((e) => e.kind === "handoff.record").at(-1).payload.status,
    "FAILED",
  );
  const count = (await events(c)).filter((e) => e.raw?.method === "session/prompt").length;
  assert.equal(count, 2);
  await conflict(submit(c));
  await action(c, failed, "confirm");
  assert.equal((await settled(t)).state, "COMPLETED");
  assert.equal((await events(c)).filter((e) => e.raw?.method === "session/prompt").length, 3);
  assert.equal(
    (await events(c)).filter((e) => e.kind === "user.message" && e.turnId === t.id).length,
    1,
  );
});

test("daemon recovery never commits/replays GENERATING or DELIVERING and blocks UNCERTAIN request actions", async () => {
  for (const state of ["PENDING", "GENERATING", "DELIVERING"]) {
    const c = await conv();
    await settled(await submit(c, "bad-report"));
    const t = await submit(c, "b", `crash-${state}`);
    const h = await hstate(c, "FAILED");
    await action(c, h, "cancel");
    cli("daemon", "stop");
    const db = new Database(dbFile);
    db.prepare("UPDATE handoffs SET status=? WHERE id=?").run(state, h.id);
    db.prepare("UPDATE turns SET state='PREPARING', ended_at=NULL WHERE id=?").run(t.id);
    db.close();
    cli("daemon", "start");
    client = new Client(instance());
    const recovered = (await handoffs(c))[0];
    assert.equal(recovered.status, state === "PENDING" ? "FAILED" : "UNCERTAIN");
    assert.equal(
      (await events(c)).filter((e) => e.kind === "handoff.record").at(-1).payload.status,
      recovered.status,
    );
    assert.equal((await events(c)).filter((e) => e.raw?.method === "session/prompt").length, 2);
    if (state === "PENDING") await action(c, recovered, "cancel");
    else {
      await conflict(action(c, recovered, "confirm"));
      assert.equal((await api(`/v1/turns/${t.id}`)).state, "UNCERTAIN");
    }
  }
});

test("interrupted worktree creation is not treated as usable; unregistered directories are never removed", async () => {
  const c = await conv("worktree");
  const w = (await api("/v1/worktrees")).find((w) => w.id === c.worktreeId);
  await api(path(c), "DELETE", { confirmed: true });
  cli("daemon", "stop");
  const db = new Database(dbFile);
  db.prepare("UPDATE managed_worktrees SET status='CREATING' WHERE id=?").run(w.id);
  db.close();
  cli("daemon", "start");
  client = new Client(instance());
  assert.equal((await api("/v1/worktrees")).find((x) => x.id === w.id).status, "ERROR");
  await api(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true });
  const id = crypto.randomUUID(),
    owner = join(env.XDG_DATA_HOME, "harnesshub/worktrees"),
    orphanPath = join(owner, id);
  mkdirSync(orphanPath);
  writeFileSync(join(orphanPath, "user.txt"), "do not delete");
  cli("daemon", "stop");
  const d = new Database(dbFile);
  d.prepare(
    "INSERT INTO managed_worktrees(id,repository_path,path,branch,owner_root,status,created_at,updated_at) VALUES(?,?,?,?,?,'ERROR',1,1)",
  ).run(id, root, orphanPath, `hhu/${id}`, owner);
  d.close();
  cli("daemon", "start");
  client = new Client(instance());
  await conflict(api(`/v1/worktrees/${id}/cleanup`, "POST", { confirmed: true }));
  assert.ok(existsSync(join(orphanPath, "user.txt")));
});

test("real schema 5 SQL migrates all existing data to 6 with backup and explicit session binding", async () => {
  const legacy = join(temp, "schema5");
  mkdirSync(legacy);
  const data = join(legacy, "data/harnesshub");
  mkdirSync(data, { recursive: true });
  const file = join(data, "harnesshub.db"),
    db = new Database(file);
  const migrations = resolve("packages/storage/migrations"),
    journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json")));
  db.exec(
    "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
  );
  for (const entry of journal.entries.slice(0, 5)) {
    db.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8"));
    db.prepare("INSERT INTO __drizzle_migrations(hash,created_at) VALUES('fixture',?)").run(
      entry.when,
    );
  }
  db.exec(`PRAGMA user_version=5;
    INSERT INTO projects VALUES('p','legacy','${root.replaceAll("'", "''")}',1,1);
    INSERT INTO conversations(id,project_id,title,workspace_path,archived_at,created_at,updated_at) VALUES('c','p','history','${root.replaceAll("'", "''")}',2,1,1);
    INSERT INTO native_sessions(id,conversation_id,harness_id,worker_id,epoch,status,cwd,created_at,ended_at) VALUES('n','c','a','w','old','CLOSED','${root.replaceAll("'", "''")}',1,2);
    INSERT INTO turns(id,conversation_id,native_session_id,request_id,request_hash,harness_id,state,created_at,ended_at) VALUES('t','c','n','req','hash','a','COMPLETED',1,2);
    INSERT INTO conversation_events(id,conversation_id,native_session_id,turn_id,seq,normalized_kind,origin,created_at) VALUES('e','c','n','t',1,'user.message','client',1);
    INSERT INTO conversation_drafts VALUES('c','draft',4,NULL);
    INSERT INTO approvals(id,conversation_id,native_session_id,turn_id,acp_request_id,request_json,status,created_at) VALUES('approval','c','n','t','1','{}','DECIDED',1);`);
  db.close();
  const e = {
    ...env,
    XDG_DATA_HOME: join(legacy, "data"),
    XDG_STATE_HOME: join(legacy, "state"),
    XDG_CONFIG_HOME: join(legacy, "config"),
  };
  const run = (...args) =>
    execFileSync(process.env.HARNESSHUB_BUN, [resolve("dist/cli/hhu.js"), ...args], {
      env: e,
      timeout: 30000,
    });
  run("daemon", "start");
  run("daemon", "stop");
  const migrated = new Database(file, { readonly: true });
  assert.equal(migrated.pragma("user_version", { simple: true }), 6);
  assert.deepEqual(migrated.pragma("foreign_key_check"), []);
  const c = migrated.prepare("SELECT * FROM conversations").get();
  assert.equal(c.active_native_session_id, "n");
  assert.equal(c.archived_at, 2);
  assert.equal(migrated.prepare("SELECT text FROM conversation_drafts").get().text, "draft");
  assert.equal(migrated.prepare("SELECT * FROM approvals").all().length, 1);
  assert.equal(migrated.prepare("SELECT origin FROM turns").get().origin, "user");
  assert.equal(migrated.prepare("SELECT purpose FROM conversation_events").get().purpose, "user");
  migrated.close();
  assert.ok(readdirSync(data).some((name) => name.startsWith("harnesshub.db.backup-")));
});

test("real concurrent Git path/branch conflicts and partial creation never bind a Conversation or delete pre-existing data", async () => {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  for (const mode of ["path", "branch", "partial"]) {
    const isolated = join(temp, `git-failure-${mode}`);
    const fixtureEnv = {
      ...env,
      XDG_DATA_HOME: join(isolated, "data"),
      XDG_STATE_HOME: join(isolated, "state"),
      XDG_CONFIG_HOME: join(isolated, "config"),
      PATH: `${resolve("tests/fixtures/git-fail")}:${process.env.PATH}`,
      HHU_REAL_GIT: realGit,
      HHU_TEST_GIT_FAILURE: mode,
    };
    const run = (...args) =>
      execFileSync(process.env.HARNESSHUB_BUN, [resolve("dist/cli/hhu.js"), ...args], {
        env: fixtureEnv,
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    run("daemon", "start");
    const local = new Client(
      JSON.parse(readFileSync(join(fixtureEnv.XDG_STATE_HOME, "harnesshub/instance.json"))),
    );
    try {
      const p = await local.request("/v1/projects", "POST", { rootPath: root });
      await conflict(
        local.request(`/v1/projects/${p.id}/conversations`, "POST", {
          title: "must not bind",
          workspaceMode: "worktree",
        }),
      );
      assert.deepEqual(await local.request(`/v1/projects/${p.id}/conversations`), []);
      const [w] = await local.request("/v1/worktrees");
      assert.equal(w.status, "ERROR");
      if (mode === "path") {
        assert.equal(readFileSync(join(w.path, "user.txt"), "utf8"), "preserve concurrent path\n");
        await conflict(local.request(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true }));
      } else {
        assert.ok(git(root, "show-ref", "--verify", `refs/heads/${w.branch}`).includes(w.branch));
        if (mode === "partial") assert.ok(existsSync(join(w.path, "tracked.txt")));
        await local.request(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true });
        assert.ok(git(root, "show-ref", "--verify", `refs/heads/${w.branch}`).includes(w.branch));
      }
    } finally {
      run("daemon", "stop");
    }
  }
});

test("actual isolated daemon crashes during GENERATING and DELIVERING recover UNCERTAIN with no Prompt replay", async () => {
  await profile("crash-window", { HHU_MOCK_REPORT_DELAY: "3000" });
  for (const phase of ["GENERATING", "DELIVERING"]) {
    const c = await conv();
    await settled(await submit(c, phase === "GENERATING" ? "crash-window" : "a"));
    const t = await submit(c, "b", "timed");
    const h = await hstate(c, phase);
    const before = (await events(c)).filter((e) => e.raw?.method === "session/prompt").length;
    process.kill(instance().pid, "SIGKILL"); // only this explicitly isolated Mock daemon
    await new Promise((r) => setTimeout(r, 150));
    cli("daemon", "start");
    client = new Client(instance());
    const recovered = await hstate(c, "UNCERTAIN");
    assert.equal(recovered.id, h.id);
    assert.equal((await api(`/v1/turns/${t.id}`)).state, "UNCERTAIN");
    await conflict(action(c, recovered, "retry"));
    await conflict(submit(c));
    assert.equal(
      (await events(c)).filter((e) => e.raw?.method === "session/prompt").length,
      before,
    );
  }
});

test("unexpected source report tools preserve native evidence and require explicit risk/degraded confirmation", async () => {
  await profile("report-tool", { HHU_MOCK_REPORT_TOOL: "1" });
  const c = await conv();
  await settled(await submit(c, "report-tool"));
  const t = await submit(c, "b", "after report tool");
  const h = await hstate(c, "FAILED");
  assert.match(h.error, /native tools/);
  assert.ok(h.reportText);
  assert.ok(h.generatedAt);
  assert.equal((await sessions(c)).length, 1);
  const warning = (await events(c)).find((e) => e.kind === "handoff.report_tool_warning");
  assert.equal(warning.payload.tool.title, "Exact native report tool");
  assert.equal(warning.purpose, "user");
  assert.ok(
    (await events(c)).some(
      (e) =>
        e.kind === "tool_call" &&
        e.purpose === "handoff_internal" &&
        e.payload.title === "Exact native report tool",
    ),
  );
  const decisions = await Promise.allSettled([action(c, h, "confirm"), action(c, h, "confirm")]);
  assert.equal(decisions.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await settled(t)).state, "COMPLETED");
  assert.equal((await events(c)).filter((e) => e.raw?.method === "session/prompt").length, 3);
});
