import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { Client } from "../../dist/client/client.js";
import { openStore, RuntimeStore } from "../../dist/storage/index.js";

const temp = mkdtempSync(join(tmpdir(), "hhu-standalone-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_DATA_HOME: join(temp, "data"),
  XDG_STATE_HOME: join(temp, "state"),
};
const cli = (...args) =>
  execFileSync(process.env.HARNESSHUB_BUN, [resolve("dist/cli/hhu.js"), ...args], { env });
let client;
const start = () => {
  cli("daemon", "start");
  client = new Client(
    JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json"))),
  );
};
const api = (path, method, body) => client.request(path, method, body, 10000);
after(() => {
  cli("daemon", "stop", "--cancel-active");
  console.log(`Standalone Conversation evidence: ${temp}`);
});

test("schema 6 upgrade preserves dependent history, drafts and preferences, backs up and restores FK enforcement", async () => {
  const migrations = resolve("packages/storage/migrations");
  const legacy = join(temp, "legacy-migrations");
  cpSync(migrations, legacy, { recursive: true });
  const journalPath = join(legacy, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath));
  journal.entries = journal.entries.slice(0, 6);
  writeFileSync(journalPath, JSON.stringify(journal));
  const file = join(temp, "migration", "harnesshub.db");
  let store = await openStore(file, legacy);
  const project = store.addProject(temp, "preserved project").value;
  const conversation = store.addConversation(project.id, "preserved history").value;
  const runtime = new RuntimeStore(store);
  const session = runtime.addSession(conversation.id, "mock", temp, randomUUID());
  const turn = runtime.addTurn(conversation.id, "mock", randomUUID(), "hash");
  runtime.updateTurn(turn.id, {
    nativeSessionId: session.id,
    state: "COMPLETED",
    endedAt: Date.now(),
  });
  const event = runtime.append({
    conversationId: conversation.id,
    nativeSessionId: session.id,
    turnId: turn.id,
    harnessId: "mock",
    kind: "agent_message_chunk",
    payload: { content: { type: "text", text: "native history" } },
    raw: { original: "preserved" },
    origin: "agent",
    purpose: "user",
  });
  store.saveDraft(conversation.id, { revision: 0, text: "saved draft", pendingSubmission: null });
  store.savePreferences({ lastConversationId: conversation.id });
  const tables = [
    "projects",
    "conversations",
    "native_sessions",
    "turns",
    "conversation_events",
    "conversation_drafts",
    "ui_preferences",
  ];
  const before = tables.map((table) => store.sqlite.prepare(`SELECT * FROM ${table}`).all());
  store.close();

  store = await openStore(file, migrations);
  try {
    assert.deepEqual(
      tables.map((table) => store.sqlite.prepare(`SELECT * FROM ${table}`).all()),
      before,
    );
    assert.equal(store.getConversation(conversation.id).projectId, project.id);
    assert.equal(new RuntimeStore(store).events(conversation.id, 0, 100)[0].id, event.id);
    assert.equal(store.sqlite.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(store.sqlite.pragma("foreign_key_check"), []);
    assert.throws(() => store.addConversation("missing-project"), /Project not found/);
    const standalone = store.addConversation(null, undefined, undefined, temp).value;
    store.saveDraft(standalone.id, {
      revision: 0,
      text: "ungrouped draft",
      pendingSubmission: null,
    });
    store.savePreferences({ lastConversationId: standalone.id, lastProjectId: null });
    store.sqlite.prepare("DELETE FROM projects WHERE id=?").run(project.id);
    assert.deepEqual(
      store.listConversations().map((value) => value.id),
      [standalone.id],
    );
    assert.equal(store.draft(standalone.id).text, "ungrouped draft");
    assert.equal(store.preferences().lastProjectId, null);
    assert.equal(store.preferences().lastConversationId, standalone.id);
    assert.equal(
      store.sqlite.prepare("SELECT count(*) AS count FROM conversation_events").get().count,
      0,
    );
  } finally {
    store.close();
  }
  const backup = readdirSync(join(temp, "migration")).find((name) => name.includes(".backup-"));
  assert.ok(backup);
  assert.equal(statSync(join(temp, "migration", backup)).mode & 0o777, 0o600);
});

test("standalone creation validates the explicit path, uses it for both ACP cwd values and persists without a project", async () => {
  start();
  const launch = join(temp, "launch");
  mkdirSync(launch);
  await api("/v1/harness-profiles", "POST", {
    id: "standalone-mock",
    name: "Standalone Mock",
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
  });
  for (const body of [
    {},
    { workspacePath: "." },
    { workspacePath: join(temp, "absent") },
    { workspacePath: launch, workspaceMode: "worktree" },
  ])
    await assert.rejects(api("/v1/conversations", "POST", body), (error) => error.status === 400);
  assert.deepEqual((await api("/v1/snapshot")).projects, []);
  const conversation = await api("/v1/conversations", "POST", { workspacePath: launch });
  assert.equal(conversation.projectId, null);
  assert.equal(conversation.workspacePath, launch);
  assert.equal(conversation.workspaceMode, "shared");
  const session = await api(`/v1/conversations/${conversation.id}/sessions`, "POST", {
    harnessId: "standalone-mock",
  });
  assert.equal(session.cwd, launch);
  assert.equal(session.capabilities.session._meta.workerCwd, launch);
  await api(`/v1/conversations/${conversation.id}/draft`, "PUT", {
    revision: 0,
    text: "independent draft",
    pendingSubmission: null,
  });
  await api("/v1/preferences", "PATCH", {
    lastConversationId: conversation.id,
    lastProjectId: null,
  });
  await api(`/v1/conversations/${conversation.id}`, "PATCH", {
    archived: true,
    title: "independent history",
  });
  cli("daemon", "stop");
  start();
  assert.equal((await api(`/v1/conversations/${conversation.id}`)).title, "independent history");
  assert.equal((await api(`/v1/conversations/${conversation.id}/draft`)).text, "independent draft");
  assert.equal((await api("/v1/preferences")).lastConversationId, conversation.id);
  assert.deepEqual((await api("/v1/snapshot")).projects, []);
  await api(`/v1/conversations/${conversation.id}`, "DELETE", { confirmed: true });
  assert.deepEqual((await api("/v1/snapshot")).conversations, []);
  assert.equal((await api("/v1/preferences")).lastConversationId, null);
  assert.ok(statSync(launch).isDirectory());
});
