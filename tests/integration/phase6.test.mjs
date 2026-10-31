import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
import Database from "better-sqlite3";
import WebSocket from "ws";
import { Worker } from "../../dist/acp/index.js";
import { Client } from "../../dist/client/client.js";
import { appendPrivateLog, paths, securePaths } from "../../dist/paths/paths.js";
import { openStore, RuntimeStore } from "../../dist/storage/index.js";

const temp = mkdtempSync(join(tmpdir(), "hhu-phase6-"));
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
const instance = () =>
  JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json"), "utf8"));
cli("daemon", "start");
let client = new Client(instance());
const api = (path, method, body) => client.request(path, method, body);
const until = async (check) => {
  for (let i = 0; i < 300; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Phase 6 state timed out");
};
const root = join(temp, "project");
mkdirSync(root);
const project = await api("/v1/projects", "POST", { rootPath: root });
const conversation = await api(`/v1/projects/${project.id}/conversations`, "POST", {
  title: "Phase 6 export",
});
await api("/v1/harness-profiles", "POST", {
  id: "mock6",
  name: "Mock Phase 6",
  command: process.execPath,
  args: [resolve("tests/fixtures/mock-acp/server.mjs")],
});

after(() => {
  cli("daemon", "stop", "--cancel-active");
  console.log(`Phase-6 integration evidence: ${temp}`);
});

test("conversation export separates readable records from raw ACP debug data", async () => {
  const turn = await api(`/v1/conversations/${conversation.id}/turns`, "POST", {
    harnessId: "mock6",
    message: "phase6 export message",
    requestId: crypto.randomUUID(),
  });
  await until(async () => {
    const result = await api(`/v1/turns/${turn.id}`);
    return result.endedAt ? result : null;
  });
  const chat = await api(`/v1/conversations/${conversation.id}/export?format=chat`);
  assert.equal(chat.format, "chat");
  assert.ok(chat.messages.some((message) => message.content === "phase6 export message"));
  assert.equal(chat.events, undefined);
  assert.match(chat.markdown, /phase6 export message/);
  assert.equal(chat.markdown.includes("session/new"), false);
  const debug = await api(`/v1/export/conversations/${conversation.id}?format=debug`);
  assert.equal(debug.format, "debug");
  assert.ok(debug.events.some((event) => event.raw?.method === "session/prompt"));
  assert.ok(debug.sessions.length >= 1);
  const destination = join(temp, "conversation.md");
  cli("agent", "export", conversation.id, "chat", destination);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.equal(readFileSync(destination, "utf8"), chat.markdown);
  assert.throws(() => cli("agent", "export", conversation.id, "chat", destination), /EEXIST/);
  await assert.rejects(
    api(`/v1/conversations/${conversation.id}/export?format=invalid`),
    (error) => error.status === 400,
  );
});

test("private data and actual multi-generation log rotation retain user-only permissions", () => {
  const dataDir = join(env.XDG_DATA_HOME, "harnesshub");
  const stateDir = join(env.XDG_STATE_HOME, "harnesshub");
  for (const path of [dataDir, stateDir, join(stateDir, "logs")])
    assert.equal(statSync(path).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataDir, "harnesshub.db")).mode & 0o777, 0o600);
  const rotated = join(stateDir, "logs", "rotation-test.log");
  for (let index = 0; index < 10; index++)
    appendPrivateLog(rotated, `entry-${index}`.padEnd(128, "x"), 128, 3);
  assert.deepEqual(
    readdirSync(join(stateDir, "logs"))
      .filter((name) => name.startsWith("rotation-test"))
      .sort(),
    ["rotation-test.log", "rotation-test.log.1", "rotation-test.log.2", "rotation-test.log.3"],
  );
  assert.match(readFileSync(`${rotated}.3`, "utf8"), /entry-6/);
  for (const suffix of ["", ".1", ".2", ".3"])
    assert.equal(statSync(`${rotated}${suffix}`).mode & 0o777, 0o600);
});

test("failed migration rolls back all SQL, preserves schema 6 and a restorable private backup", async () => {
  const dir = join(temp, "migration-failure");
  mkdirSync(dir);
  const file = join(dir, "harnesshub.db"),
    migrations = resolve("packages/storage/migrations");
  let store = await openStore(file, migrations);
  const p = store.addProject(root, "preserve").value;
  const c = store.addConversation(p.id, "history").value;
  store.saveDraft(c.id, { revision: 0, text: "private preserved draft", pendingSubmission: null });
  store.close();
  const failing = join(dir, "migrations");
  cpSync(migrations, failing, { recursive: true });
  const journalFile = join(failing, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalFile));
  journal.entries.push({
    idx: 6,
    version: "6",
    when: journal.entries.at(-1).when + 1000,
    tag: "0006_failure",
    breakpoints: true,
  });
  writeFileSync(journalFile, JSON.stringify(journal));
  writeFileSync(
    join(failing, "0006_failure.sql"),
    "CREATE TABLE must_rollback (value text);--> statement-breakpoint\nINSERT INTO not_a_table VALUES (1);",
  );
  await assert.rejects(openStore(file, failing), /not_a_table/);
  const db = new Database(file);
  assert.equal(db.pragma("user_version", { simple: true }), 6);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='must_rollback'").get(),
    undefined,
  );
  assert.equal(
    db.prepare("SELECT text FROM conversation_drafts WHERE conversation_id=?").get(c.id).text,
    "private preserved draft",
  );
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  db.close();
  const backup = readdirSync(dir).find((name) => name.includes(".backup-"));
  assert.ok(backup);
  assert.equal(statSync(join(dir, backup)).mode & 0o777, 0o600);
  const restored = new Database(join(dir, backup), { readonly: true });
  assert.equal(
    restored.prepare("SELECT title FROM conversations WHERE id=?").get(c.id).title,
    "history",
  );
  restored.close();
  store = await openStore(file, migrations);
  assert.equal(store.getProject(p.id).name, "preserve");
  store.close();
});

test("unsafe SQLite/sidecar symlinks are rejected before touching external files; permissions are repaired", async () => {
  const dir = join(temp, "unsafe-data");
  mkdirSync(dir);
  const outside = join(temp, "user-file");
  writeFileSync(outside, "do not change", { mode: 0o644 });
  const file = join(dir, "harnesshub.db");
  symlinkSync(outside, file);
  await assert.rejects(
    openStore(file, resolve("packages/storage/migrations")),
    /Unsafe HarnessHub file/,
  );
  assert.equal(readFileSync(outside, "utf8"), "do not change");
  assert.equal(statSync(outside).mode & 0o777, 0o644);
  const isolated = {
    ...env,
    XDG_CONFIG_HOME: join(temp, "modes/config"),
    XDG_DATA_HOME: join(temp, "modes/data"),
    XDG_STATE_HOME: join(temp, "modes/state"),
  };
  const p = paths(isolated);
  securePaths(p);
  writeFileSync(p.instance, "{}", { mode: 0o666 });
  chmodSync(p.instance, 0o666);
  chmodSync(p.state, 0o777);
  securePaths(p);
  assert.equal(statSync(p.instance).mode & 0o777, 0o600);
  assert.equal(statSync(p.state).mode & 0o777, 0o700);
});

test("structured secrets are redacted in raw, normalized and debug export; native prose remains exact", async () => {
  const dir = join(temp, "redaction");
  mkdirSync(dir);
  const invalidProfile = join(dir, "invalid-profile.json");
  writeFileSync(invalidProfile, "PRIVATE_SYNTAX_ERROR_CONTENT");
  assert.throws(
    () => cli("agent", "register", invalidProfile),
    (error) => {
      assert.match(String(error.stderr), /Invalid JSON input/);
      assert.equal(String(error.stderr).includes("PRIVATE_SYNTAX_ERROR_CONTENT"), false);
      return true;
    },
  );
  const store = await openStore(join(dir, "harnesshub.db"), resolve("packages/storage/migrations"));
  try {
    const p = store.addProject(root, "redaction").value;
    const c = store.addConversation(p.id, "redaction").value;
    const data = new RuntimeStore(store);
    const prose = "Original source code can contain token=literal and must stay unchanged. 世界";
    const secret = "phase6-structured-secret";
    const payload = {
      content: { text: prose },
      headers: { Authorization: secret, "Set-Cookie": secret },
      env: { OPENAI_API_KEY: secret, AWS_SECRET_ACCESS_KEY: secret, DB_PASSWORD: secret },
      clientSecret: secret,
      accessToken: secret,
      tokenCount: 12,
    };
    data.append({
      conversationId: c.id,
      nativeSessionId: null,
      turnId: null,
      kind: "agent_message_chunk",
      origin: "agent",
      raw: { result: payload },
      payload,
    });
    const exported = data.exportConversation(c.id, "debug");
    assert.equal(JSON.stringify(exported).includes(secret), false);
    assert.equal(exported.messages[0].content, prose);
    assert.equal(exported.events[0].payload.tokenCount, 12);
  } finally {
    store.close();
  }
});

test("an adapter exiting before its stubborn descendant closes stdio cannot report cleanup success", async () => {
  const worker = new Worker(
    {
      id: "descendant",
      name: "descendant",
      command: process.execPath,
      args: [resolve("tests/fixtures/mock-acp/descendant.mjs")],
      envOverrides: {},
    },
    root,
    { wire() {}, permission: async () => ({ outcome: { outcome: "cancelled" } }), lost() {} },
  );
  try {
    await worker.initialize();
    await assert.rejects(worker.stop(), /has not confirmed exit/);
    assert.equal(worker.exitedConfirmed, false);
    await worker.stop(true); // explicit test-only confirmation against this isolated process group
    assert.equal(worker.exitedConfirmed, true);
  } finally {
    if (!worker.exitedConfirmed) await worker.stop(true);
  }
});

test("explicit doctor handshake sends initialize/session/new without any prompt", async () => {
  const result = cli("doctor", "--acp", conversation.id, "mock6");
  assert.match(result, /Explicit ACP initialize/);
  const before = (
    await api(`/v1/conversations/${conversation.id}/events?limit=1000`)
  ).events.filter((event) => event.raw?.method === "session/prompt").length;
  cli("doctor");
  const after = (await api(`/v1/conversations/${conversation.id}/events?limit=1000`)).events.filter(
    (event) => event.raw?.method === "session/prompt",
  ).length;
  assert.equal(before, after);
});

test("WS rejects browser Origins and incorrect tokens; client rejects an instance identity substitution", async () => {
  for (const headers of [
    { Authorization: `Bearer ${"0".repeat(64)}` },
    { Authorization: `Bearer ${instance().token}`, Origin: "http://localhost" },
  ]) {
    const ws = new WebSocket(`${client.base.replace("http", "ws")}/v1/ws`, { headers });
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("WS auth timed out"));
      }, 3000);
      ws.on("open", () => {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error("Unauthorized WebSocket opened"));
      });
      ws.on("error", () => {});
      ws.on("unexpected-response", (_req, response) => {
        clearTimeout(timer);
        response.resume();
        resolve(response.statusCode);
      });
    });
    ws.terminate();
    assert.equal(status, headers.Origin ? 403 : 401);
  }
  await assert.rejects(
    new Client({ ...instance(), instanceId: crypto.randomUUID() }).health(),
    /identity mismatch/,
  );
});

test("cancel-active safely cancels a FAILED Handoff and restart accepts new work without replay", async () => {
  const c = await api(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "shutdown failed handoff",
  });
  await api("/v1/harness-profiles", "POST", {
    id: "fail6",
    name: "fail6",
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: { HHU_MOCK_REPORT_FAIL: "1" },
  });
  const first = await api(`/v1/conversations/${c.id}/turns`, "POST", {
    harnessId: "fail6",
    message: "stream",
    requestId: crypto.randomUUID(),
  });
  await until(async () => (await api(`/v1/turns/${first.id}`)).endedAt);
  const second = await api(`/v1/conversations/${c.id}/turns`, "POST", {
    harnessId: "mock6",
    message: "target",
    requestId: crypto.randomUUID(),
  });
  await until(
    async () => (await api(`/v1/conversations/${c.id}/handoffs`))[0]?.status === "FAILED",
  );
  const previous = await api(`/v1/conversations/${c.id}/events?limit=1000`);
  cli("daemon", "stop", "--cancel-active");
  cli("daemon", "start");
  client = new Client(instance());
  assert.equal((await api(`/v1/turns/${second.id}`)).state, "CANCELLED");
  assert.equal((await api(`/v1/conversations/${c.id}/handoffs`))[0].status, "CANCELLED");
  const after = await api(`/v1/conversations/${c.id}/events?limit=1000`);
  assert.equal(
    after.events.filter((event) => event.raw?.method === "session/prompt").length,
    previous.events.filter((event) => event.raw?.method === "session/prompt").length,
  );
  const next = await api(`/v1/conversations/${conversation.id}/turns`, "POST", {
    harnessId: "mock6",
    message: "after shutdown",
    requestId: crypto.randomUUID(),
  });
  await until(async () => (await api(`/v1/turns/${next.id}`)).endedAt);
});

test("installer locks out an unresponsive instance even when instance metadata is missing", async () => {
  const dir = join(temp, "installer-lock");
  const isolated = {
    ...env,
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_STATE_HOME: join(dir, "state"),
  };
  const p = paths(isolated);
  securePaths(p);
  const ready = join(dir, "ready");
  const lock = spawn("flock", [
    "--no-fork",
    p.lock,
    process.execPath,
    "-e",
    "require('fs').writeFileSync(process.argv[1], 'ready');setInterval(()=>{},1000)",
    ready,
  ]);
  try {
    await until(() => existsSync(ready));
    const before = statSync(resolve("dist/cli/hhu.js")).mtimeMs;
    assert.throws(
      () =>
        execFileSync(process.env.HARNESSHUB_BUN, [resolve("scripts/install-local.ts")], {
          env: isolated,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10000,
        }),
      /lock is held/,
    );
    assert.equal(statSync(resolve("dist/cli/hhu.js")).mtimeMs, before);
  } finally {
    lock.kill("SIGTERM");
    await new Promise((resolve) => lock.once("close", resolve));
  }
});

test("failed source release retains the handle, blocks shutdown and never kills another Conversation", async () => {
  const gate = join(temp, "release-source");
  await api("/v1/harness-profiles", "POST", {
    id: "retained6",
    name: "retained6",
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: { HHU_MOCK_EXIT_GATE: gate },
  });
  const c = await api(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "source release",
  });
  const submit = (id, harnessId) =>
    api(`/v1/conversations/${id}/turns`, "POST", {
      harnessId,
      message: "stream",
      requestId: crypto.randomUUID(),
    });
  const first = await submit(c.id, "retained6");
  await until(async () => (await api(`/v1/turns/${first.id}`)).endedAt);
  const other = (await api(`/v1/conversations/${conversation.id}/sessions`)).at(-1);
  const otherPid = other.capabilities.session._meta.workerPid;
  const source = (await api(`/v1/conversations/${c.id}/sessions`))[0];
  const sourcePid = source.capabilities.session._meta.workerPid;
  try {
    const target = await submit(c.id, "mock6");
    await until(async () => (await api(`/v1/turns/${target.id}`)).endedAt);
    await until(async () =>
      (await api(`/v1/conversations/${c.id}/events?limit=1000`)).events.some(
        (event) => event.kind === "handoff.cleanup_failed",
      ),
    );
    process.kill(sourcePid, 0);
    process.kill(otherPid, 0);
    const retained = (await api(`/v1/conversations/${c.id}/sessions`))[0];
    assert.equal(retained.endedAt, null);
    await assert.rejects(
      api(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      client.request("/v1/daemon/stop", "POST", { cancelActive: false }, 12000),
      (error) => error.status === 409,
    );
    assert.equal((await api("/v1/health")).pid, instance().pid);
  } finally {
    writeFileSync(gate, "cooperative exit now");
    await until(() => !existsSync(`/proc/${sourcePid}`));
    cli("daemon", "stop");
    cli("daemon", "start");
    client = new Client(instance());
  }
});

test("slow Git creation/removal leaves Daemon responsive and reservations block rebind, shutdown and cleanup races", async () => {
  const dir = join(temp, "slow-git");
  mkdirSync(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync("/usr/bin/git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-b", "main");
  writeFileSync(join(repo, "tracked.txt"), "safe fixture\n");
  git("add", ".");
  git("-c", "user.name=HHU", "-c", "user.email=test@localhost", "commit", "-m", "fixture");
  const marker = join(dir, "marker");
  const isolated = {
    ...env,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_STATE_HOME: join(dir, "state"),
    PATH: `${resolve("tests/fixtures/git-fail")}:${env.PATH}`,
    HHU_REAL_GIT: "/usr/bin/git",
    HHU_TEST_GIT_DELAY: "1800",
    HHU_TEST_GIT_MARKER: marker,
  };
  const run = (...args) =>
    execFileSync(process.env.HARNESSHUB_BUN, [resolve("dist/cli/hhu.js"), ...args], {
      env: isolated,
      encoding: "utf8",
      timeout: 30000,
    });
  run("daemon", "start");
  const local = new Client(
    JSON.parse(readFileSync(join(isolated.XDG_STATE_HOME, "harnesshub/instance.json"))),
  );
  try {
    const p = await local.request("/v1/projects", "POST", { rootPath: repo });
    const creating = local.request(
      `/v1/projects/${p.id}/conversations`,
      "POST",
      { title: "worktree", workspaceMode: "worktree" },
      10000,
    );
    await until(() => existsSync(marker));
    const began = Date.now();
    await local.health();
    assert.ok(Date.now() - began < 1000, "Git must not block the event loop");
    await Promise.all(
      [
        local.request(`/v1/projects/${p.id}`, "DELETE"),
        local.request(`/v1/projects/${p.id}`, "PATCH", { rootPath: root }),
        local.request("/v1/daemon/stop", "POST", {}),
        local.request(`/v1/projects/${p.id}/conversations`, "POST", {
          title: "racing",
          workspaceMode: "worktree",
        }),
      ].map((command) => assert.rejects(command, (error) => error.status === 409)),
    );
    const c = await creating;
    const w = (await local.request("/v1/worktrees"))[0];
    const registered = await local.request("/v1/projects", "POST", { rootPath: w.path });
    await local.request(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
    const removing = local.request(
      `/v1/worktrees/${w.id}/cleanup`,
      "POST",
      { confirmed: true },
      10000,
    );
    await until(() => readFileSync(marker, "utf8") === "remove");
    await local.health();
    await assert.rejects(
      local.request(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      local.request(`/v1/projects/${registered.id}/conversations`, "POST", {
        title: "cannot bind during removal",
      }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      local.request("/v1/daemon/stop", "POST", {}),
      (error) => error.status === 409,
    );
    assert.equal((await removing).status, "REMOVED");
    assert.ok(git("branch", "--list", w.branch).includes(w.branch));
  } finally {
    run("daemon", "stop", "--cancel-active");
  }
});

test("user-level installation is atomic, runnable from Home and refuses an active old-version instance", async () => {
  const dir = join(temp, "installed");
  const isolated = {
    ...env,
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_STATE_HOME: join(dir, "state"),
  };
  mkdirSync(isolated.HOME, { recursive: true });
  const install = () =>
    execFileSync(process.env.HARNESSHUB_BUN, [resolve("scripts/install-local.ts")], {
      env: isolated,
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  assert.match(install(), /Installed/);
  const launcher = join(isolated.HOME, ".local/bin/hhu");
  assert.equal(statSync(launcher).mode & 0o777, 0o755);
  const run = (...args) =>
    execFileSync(launcher, args, {
      env: isolated,
      cwd: isolated.HOME,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  assert.equal(run("--version").trim(), "HarnessHub 0.6.0");
  run("daemon", "start");
  try {
    const file = join(isolated.XDG_STATE_HOME, "harnesshub/instance.json");
    const live = JSON.parse(readFileSync(file));
    // Simulate old client metadata: installation still probes identity with auth, not VERSION.
    writeFileSync(file, JSON.stringify({ ...live, version: "0.5.0" }), { mode: 0o600 });
    const before = statSync(resolve("dist/cli/hhu.js")).mtimeMs;
    assert.throws(install, /Stop the running HarnessHub Daemon/);
    assert.equal(statSync(resolve("dist/cli/hhu.js")).mtimeMs, before);
    assert.equal((await new Client(live).request("/v1/health")).pid, live.pid);
  } finally {
    run("daemon", "stop");
  }
  assert.match(install(), /Installed/);
  assert.equal(run("--version").trim(), "HarnessHub 0.6.0");
});

test("unborn repositories and locked Worktrees fail safely without deleting files or branches", async () => {
  const repo = join(temp, "git-safety");
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  const p = await api("/v1/projects", "POST", { rootPath: repo });
  await assert.rejects(
    api(`/v1/projects/${p.id}/conversations`, "POST", {
      title: "unborn",
      workspaceMode: "worktree",
    }),
    (error) => error.status === 409,
  );
  assert.equal((await api(`/v1/projects/${p.id}/conversations`)).length, 0);
  writeFileSync(join(repo, "tracked.txt"), "preserve\n");
  git("add", ".");
  git("-c", "user.name=HHU", "-c", "user.email=test@localhost", "commit", "-m", "fixture");
  const c = await api(`/v1/projects/${p.id}/conversations`, "POST", {
    title: "locked",
    workspaceMode: "worktree",
  });
  const w = (await api("/v1/worktrees")).find((row) => row.id === c.worktreeId);
  await api(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
  git("worktree", "lock", w.path);
  await assert.rejects(
    api(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true }),
    (error) => error.status === 409,
  );
  assert.equal(readFileSync(join(w.path, "tracked.txt"), "utf8"), "preserve\n");
  git("worktree", "unlock", w.path);
  assert.equal(
    (await api(`/v1/worktrees/${w.id}/cleanup`, "POST", { confirmed: true })).status,
    "REMOVED",
  );
  assert.ok(git("branch", "--list", w.branch).includes(w.branch));
});
