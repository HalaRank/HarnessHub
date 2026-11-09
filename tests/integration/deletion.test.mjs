import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import { Client } from "../../dist/client/client.js";

const temp = mkdtempSync("/tmp/hhu-deletion-");
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_DATA_HOME: join(temp, "data"),
  XDG_STATE_HOME: join(temp, "state"),
};
const cli = (...args) =>
  execFileSync(process.env.HARNESSHUB_BUN, [resolve("dist/cli/hhu.js"), ...args], { env });
cli("daemon", "start");
const client = new Client(
  JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json"))),
);
const api = (path, method, body) => client.request(path, method, body, 60000);
const until = async (check) => {
  for (let i = 0; i < 300; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Deletion test timed out");
};
const createProject = async (name) => {
  const rootPath = join(temp, name);
  mkdirSync(rootPath);
  writeFileSync(join(rootPath, "sentinel.txt"), "user files must survive\n");
  return api("/v1/projects", "POST", { rootPath, name });
};
const conversation = (p, title) => api(`/v1/projects/${p.id}/conversations`, "POST", { title });
const profile = (id, envOverrides = {}) =>
  api("/v1/harness-profiles", "POST", {
    id,
    name: id,
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides,
  });
await profile("delete-mock");
after(() => {
  cli("daemon", "stop", "--cancel-active");
  console.log(`Deletion integration evidence: ${temp}`);
});

test("confirmed project deletion closes idle Workers and cascades archived history and drafts, preserving files and other projects", async () => {
  const p = await createProject("delete-project");
  const c = await conversation(p, "archived history");
  const git = (...args) => execFileSync("git", args, { cwd: p.rootPath, encoding: "utf8" });
  git("init", "-b", "main");
  git("add", "sentinel.txt");
  git("-c", "user.name=HHU", "-c", "user.email=test@localhost", "commit", "-m", "fixture");
  const worktree = await api(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "Retain dirty Worktree",
    workspaceMode: "worktree",
  });
  writeFileSync(join(worktree.workspacePath, "precious.txt"), "keep untracked files");
  const managed = (await api("/v1/worktrees")).find((w) => w.id === worktree.worktreeId);
  const other = await createProject("keep-project");
  const keep = await conversation(other, "keep history");
  await assert.rejects(api(`/v1/projects/${p.id}`, "DELETE"), (e) => e.status === 400);
  await assert.rejects(
    api(`/v1/projects/${p.id}`, "DELETE", { confirmed: false }),
    (e) => e.status === 400,
  );
  const turn = await api(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    message: "history",
    harnessId: "delete-mock",
  });
  await until(async () => (await api(`/v1/turns/${turn.id}`)).endedAt);
  await api(`/v1/conversations/${keep.id}/sessions`, "POST", { harnessId: "delete-mock" });
  const keepSessions = await api(`/v1/conversations/${keep.id}/sessions`);
  const sessions = await api(`/v1/conversations/${c.id}/sessions`);
  const pid = sessions[0].capabilities.session._meta.workerPid;
  await api(`/v1/conversations/${c.id}/draft`, "PUT", {
    text: "draft to delete",
    revision: 0,
    pendingSubmission: null,
  });
  await api(`/v1/conversations/${c.id}`, "PATCH", { archived: true });
  await api("/v1/preferences", "PATCH", { lastConversationId: c.id });
  assert.ok((await api(`/v1/conversations/${c.id}/events`)).events.length > 0);
  assert.deepEqual(await api(`/v1/projects/${p.id}`, "DELETE", { confirmed: true }), {
    deleted: true,
    projectFilesDeleted: false,
  });
  await assert.rejects(api(`/v1/conversations/${c.id}`), (e) => e.status === 404);
  assert.throws(
    () => process.kill(pid, 0),
    (e) => e.code === "ESRCH",
  );
  assert.equal(readFileSync(join(p.rootPath, "sentinel.txt"), "utf8"), "user files must survive\n");
  assert.equal(
    readFileSync(join(worktree.workspacePath, "precious.txt"), "utf8"),
    "keep untracked files",
  );
  assert.ok(git("worktree", "list", "--porcelain").includes(worktree.workspacePath));
  assert.ok(git("branch", "--list", managed.branch).includes(managed.branch));
  assert.deepEqual(
    (await api("/v1/worktrees")).find((w) => w.id === managed.id),
    managed,
  );
  assert.deepEqual(await api(`/v1/conversations/${keep.id}/sessions`), keepSessions);
  const prefs = await api("/v1/preferences");
  assert.equal(prefs.lastProjectId, null);
  assert.equal(prefs.lastConversationId, null);
  const db = new Database(join(env.XDG_DATA_HOME, "harnesshub/harnesshub.db"), { readonly: true });
  try {
    for (const table of [
      "native_sessions",
      "turns",
      "conversation_events",
      "conversation_drafts",
      "approvals",
      "handoffs",
    ])
      assert.equal(
        db.prepare(`SELECT count(*) AS n FROM ${table} WHERE conversation_id=?`).get(c.id).n,
        0,
      );
    assert.equal(db.pragma("foreign_key_check").length, 0);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM metadata_changes WHERE type='project.deleted' AND entity_id=?",
        )
        .get(p.id).n,
      1,
    );
  } finally {
    db.close();
  }
});

test("project deletion reserves all children during cooperative close and refuses new work or metadata rebinding", async () => {
  await profile("slow-close", { HHU_MOCK_CLOSE_DELAY: "900" });
  const p = await createProject("reserved-project");
  const a = await conversation(p, "first");
  const b = await conversation(p, "second");
  await api(`/v1/conversations/${a.id}/sessions`, "POST", { harnessId: "slow-close" });
  await api(`/v1/conversations/${b.id}/sessions`, "POST", { harnessId: "delete-mock" });
  const deleting = api(`/v1/projects/${p.id}`, "DELETE", { confirmed: true });
  await until(
    async () => (await api(`/v1/conversations/${a.id}/sessions`))[0].status === "CLOSING",
  );
  await Promise.all([
    assert.rejects(conversation(p, "must not be cascaded"), (e) => e.status === 409),
    assert.rejects(api(`/v1/projects/${p.id}`, "PATCH", { name: "race" }), (e) => e.status === 409),
    assert.rejects(
      api(`/v1/projects/${p.id}`, "DELETE", { confirmed: true }),
      (e) => e.status === 409,
    ),
    assert.rejects(
      api(`/v1/conversations/${b.id}/turns`, "POST", {
        requestId: crypto.randomUUID(),
        harnessId: "delete-mock",
        message: "must never run",
      }),
      (e) => e.status === 409,
    ),
    assert.rejects(
      api(`/v1/conversations/${b.id}`, "DELETE", { confirmed: true }),
      (e) => e.status === 409,
    ),
  ]);
  await deleting;
  await assert.rejects(api(`/v1/projects/${p.id}`), (e) => e.status === 404);
});

test("an active child blocks the whole project before any idle sibling is stopped; archiving keeps it running", async () => {
  const p = await createProject("busy-project");
  const idle = await conversation(p, "idle");
  const busy = await conversation(p, "busy");
  await api(`/v1/conversations/${idle.id}/sessions`, "POST", { harnessId: "delete-mock" });
  const sessions = await api(`/v1/conversations/${idle.id}/sessions`);
  const t = await api(`/v1/conversations/${busy.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "delete-mock",
    message: "wait",
  });
  await until(async () =>
    (await api(`/v1/conversations/${busy.id}/events`)).events.some(
      (e) => e.kind === "agent_message_chunk",
    ),
  );
  await api(`/v1/conversations/${busy.id}`, "PATCH", { archived: true });
  assert.equal((await api(`/v1/turns/${t.id}`)).endedAt, null);
  await assert.rejects(
    api(`/v1/projects/${p.id}`, "DELETE", { confirmed: true }),
    (e) => e.status === 409,
  );
  assert.deepEqual(await api(`/v1/conversations/${idle.id}/sessions`), sessions);
  await api(`/v1/turns/${t.id}/cancel`, "POST");
  await until(async () => (await api(`/v1/turns/${t.id}`)).endedAt);
  await api(`/v1/projects/${p.id}`, "DELETE", { confirmed: true });
});

test("unconfirmed Worker exit retains project history and releases reservations for an explicit retry", async () => {
  const gate = join(temp, "allow-worker-exit");
  await profile("blocked-exit", { HHU_MOCK_EXIT_GATE: gate });
  const p = await createProject("failed-close");
  const c = await conversation(p, "keep until exit confirmed");
  await api(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId: "blocked-exit" });
  try {
    await assert.rejects(
      api(`/v1/projects/${p.id}`, "DELETE", { confirmed: true }),
      (e) => e.status === 409,
    );
    assert.equal((await api(`/v1/projects/${p.id}`)).id, p.id);
    assert.equal((await api(`/v1/conversations/${c.id}`)).id, c.id);
    assert.equal((await api(`/v1/conversations/${c.id}/sessions`))[0].endedAt, null);
    await api(`/v1/projects/${p.id}`, "PATCH", { name: "Reservation released" });
  } finally {
    writeFileSync(gate, "cooperative test-owned exit allowed");
  }
  await new Promise((r) => setTimeout(r, 150));
  await api(`/v1/projects/${p.id}`, "DELETE", { confirmed: true });
});

test("confirmed Conversation deletion cancels running work and approvals, terminates unresponsive owned Workers and removes UNCERTAIN history", async () => {
  const gate = join(temp, "never-exit-without-force");
  await profile("delete-force", { HHU_MOCK_EXIT_GATE: gate });
  const p = await createProject("delete-active");
  const keep = await conversation(p, "keep running");
  const submit = (c, message, harnessId = "delete-mock") =>
    api(`/v1/conversations/${c.id}/turns`, "POST", {
      requestId: crypto.randomUUID(),
      harnessId,
      message,
    });
  const other = await submit(keep, "wait");
  for (const message of ["wait", "permission", "ignore-cancel", "disconnect"]) {
    const c = await conversation(p, message);
    const turn = await submit(
      c,
      message,
      message === "ignore-cancel" ? "delete-force" : "delete-mock",
    );
    await until(async () =>
      message === "permission"
        ? (await api(`/v1/conversations/${c.id}/approvals`)).length
        : message === "disconnect"
          ? (await api(`/v1/turns/${turn.id}`)).endedAt
          : (await api(`/v1/conversations/${c.id}/events`)).events.some(
              (e) => e.kind === "agent_message_chunk",
            ),
    );
    const session = (await api(`/v1/conversations/${c.id}/sessions`))[0];
    const pid = session.capabilities.session._meta.workerPid;
    if (message === "wait") {
      await api(`/v1/conversations/${c.id}/inputs`, "POST", {
        requestId: crypto.randomUUID(),
        harnessId: "delete-mock",
        message: "queued input must stay unsent",
        delivery: "queue",
      });
    }
    await assert.rejects(
      api(`/v1/conversations/${c.id}`, "DELETE", { confirmed: false }),
      (e) => e.status === 400,
    );
    await api(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
    await assert.rejects(api(`/v1/conversations/${c.id}`), (e) => e.status === 404);
    assert.throws(
      () => process.kill(pid, 0),
      (e) => e.code === "ESRCH",
    );
    assert.equal((await api(`/v1/turns/${other.id}`)).endedAt, null);
    assert.equal(
      readFileSync(join(p.rootPath, "sentinel.txt"), "utf8"),
      "user files must survive\n",
    );
  }
  await api(`/v1/conversations/${keep.id}`, "DELETE", { confirmed: true });
});

test("deleting an initializing Worker reserves the Conversation, settles async writers and never dispatches its Prompt", async () => {
  await profile("delete-init", { HHU_MOCK_INIT_DELAY: "10000" });
  const p = await createProject("delete-preparing");
  const c = await conversation(p, "initializing");
  await api(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "delete-init",
    message: "must stay unsent",
  });
  await until(async () => (await api(`/v1/conversations/${c.id}/sessions`)).length);
  const deleting = api(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
  await until(async () => (await api(`/v1/conversations/${c.id}`)).runtimeStatus === "CANCELLING");
  await assert.rejects(
    api(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true }),
    (e) => e.status === 409,
  );
  await assert.rejects(
    api("/v1/daemon/stop", "POST", { cancelActive: true }),
    (e) => e.status === 409,
  );
  await assert.rejects(
    api(`/v1/conversations/${c.id}/turns`, "POST", {
      requestId: crypto.randomUUID(),
      harnessId: "delete-mock",
      message: "racing submit",
    }),
    (e) => e.status === 409,
  );
  await deleting;
  await assert.rejects(api(`/v1/conversations/${c.id}`), (e) => e.status === 404);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(await api("/v1/snapshot"));
});

test("deleting during native configuration closes the pending RPC before removing its Conversation", async () => {
  await profile("delete-settings", { HHU_MOCK_CONFIG_DELAY: "10000" });
  const p = await createProject("delete-settings");
  const c = await conversation(p, "configuring");
  await api(`/v1/conversations/${c.id}/sessions`, "POST", { harnessId: "delete-settings" });
  const setting = api(`/v1/conversations/${c.id}/settings`, "POST", {
    kind: "config",
    configId: "model",
    value: "other",
  });
  const rejected = assert.rejects(setting);
  await until(
    async () => (await api(`/v1/conversations/${c.id}/sessions`))[0].status === "CONFIGURING",
  );
  await api(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
  await rejected;
  await assert.rejects(api(`/v1/conversations/${c.id}`), (e) => e.status === 404);
  assert.ok(await api("/v1/snapshot"));
});

test("deleting failed, generating, preparing-target and delivering Handoffs closes both owned sides and releases reservations", async () => {
  for (const [name, sourceEnv, targetEnv, expected] of [
    ["failed", { HHU_MOCK_REPORT_FAIL: "1" }, {}, "FAILED"],
    ["generating", { HHU_MOCK_REPORT_DELAY: "10000" }, {}, "GENERATING"],
    ["preparing-target", {}, { HHU_MOCK_INIT_DELAY: "10000" }, "READY"],
    ["delivering", {}, {}, "DELIVERING"],
  ]) {
    await profile(`source-${name}`, sourceEnv);
    await profile(`target-${name}`, targetEnv);
    const p = await createProject(`delete-handoff-${name}`);
    const c = await conversation(p, name);
    const first = await api(`/v1/conversations/${c.id}/turns`, "POST", {
      requestId: crypto.randomUUID(),
      harnessId: `source-${name}`,
      message: "source",
    });
    await until(async () => (await api(`/v1/turns/${first.id}`)).endedAt);
    await api(`/v1/conversations/${c.id}/turns`, "POST", {
      requestId: crypto.randomUUID(),
      harnessId: `target-${name}`,
      message: "ignore-cancel",
    });
    await until(async () => {
      const h = (await api(`/v1/conversations/${c.id}/handoffs`))[0];
      return h?.status === expected && (name !== "preparing-target" || h.targetNativeSessionId);
    });
    const db = new Database(join(env.XDG_DATA_HOME, "harnesshub/harnesshub.db"), {
      readonly: true,
    });
    const pids = db
      .prepare(
        "SELECT normalized_payload_json FROM conversation_events WHERE conversation_id=? AND normalized_kind='runtime.worker_started'",
      )
      .all(c.id)
      .map((e) => JSON.parse(e.normalized_payload_json).workerPid);
    db.close();
    await api(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
    await assert.rejects(api(`/v1/conversations/${c.id}`), (e) => e.status === 404);
    for (const pid of pids)
      assert.throws(
        () => process.kill(pid, 0),
        (e) => e.code === "ESRCH",
      );
    assert.ok(await api("/v1/snapshot"));
  }
});
