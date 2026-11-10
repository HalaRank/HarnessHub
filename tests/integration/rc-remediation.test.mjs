import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import { Worker } from "../../dist/acp/index.js";
import { Client, watchConversation, watchSnapshot } from "../../dist/client/client.js";

const temp = mkdtempSync("/tmp/hhu-rc-remediation-");
const env = {
  ...process.env,
  HOME: join(temp, "home"),
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_DATA_HOME: join(temp, "data"),
  XDG_STATE_HOME: join(temp, "state"),
};
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
  mkdirSync(env[key], { recursive: true });
  process.env[key] = env[key];
}
const bun = process.env.HARNESSHUB_BUN || "bun";
symlinkSync(resolve("node_modules"), join(temp, "node_modules"));
for (const [entry, name] of [
  ["packages/core/src/changes.ts", "changes"],
  ["apps/desktop/src/main/actions.ts", "actions"],
  ["apps/desktop/src/renderer/history.ts", "history"],
  ["apps/desktop/src/main/connection.ts", "connection"],
]) {
  execFileSync(
    bun,
    [
      "build",
      entry,
      "--target=node",
      `--outfile=${join(temp, `${name}.mjs`)}`,
      "--external=better-sqlite3",
      "--external=ws",
      "--external=@agentclientprotocol/sdk",
    ],
    { env, stdio: "pipe" },
  );
}
const { changes, patch } = await import(join(temp, "changes.mjs"));
const { DesktopConnection } = await import(join(temp, "connection.mjs"));
const { DesktopTranscript } = await import(join(temp, "history.mjs"));
const { performAction } = await import(join(temp, "actions.mjs"));
const cli = (...args) =>
  execFileSync(bun, [resolve("dist/cli/hhu.js"), ...args], {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
cli("daemon", "start");
let client = new Client(
  JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json"))),
);
const api = (path, method, body) => client.request(path, method, body);
after(() => {
  cli("daemon", "stop");
  console.log(`RC evidence: ${temp}`);
});
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
function repository(name) {
  const root = join(temp, name);
  mkdirSync(root);
  git(root, "init", "-b", "main");
  writeFileSync(join(root, "tracked.txt"), "original\n");
  writeFileSync(join(root, ".gitignore"), "ignored\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=RC", "-c", "user.email=rc@localhost", "commit", "-m", "fixture");
  return root;
}
for (const route of ["function", "HTTP", "Desktop", "Worktree"])
  test(`RC-01 ${route}: fsmonitor never executes; changes and files survive`, async () => {
    const root = repository(route),
      sentinel = join(temp, `sentinel-${route}`),
      hook = join(temp, `hook-${route}`);
    writeFileSync(hook, `#!/bin/sh\nprintf called > '${sentinel}'\nprintf 'token\\000'\n`, {
      mode: 0o700,
    });
    git(root, "config", "core.fsmonitor", hook);
    const p = await api("/v1/projects", "POST", { rootPath: root });
    const c = await api(`/v1/projects/${p.id}/conversations`, "POST", {
      workspaceMode: route === "Worktree" ? "worktree" : "shared",
    });
    if (route === "Worktree") {
      await api(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
      const retained = await api(`/v1/worktrees/${c.worktreeId}/cleanup`, "POST", {
        confirmed: true,
      });
      assert.equal(retained.status, "RETAINED");
      assert.equal(readFileSync(join(retained.path, "tracked.txt"), "utf8"), "original\n");
    } else {
      writeFileSync(join(root, "tracked.txt"), "changed\n");
      writeFileSync(join(root, "new.txt"), "new\n");
      writeFileSync(join(root, "ignored"), "ignored content\n");
      const state =
        route === "function"
          ? await changes(root)
          : route === "HTTP"
            ? await api(`/v1/conversations/${c.id}/changes`)
            : await performAction(client, { type: "changes.list", conversationId: c.id });
      assert.deepEqual(state.files.map((f) => f.path).sort(), ["new.txt", "tracked.txt"]);
      const diff =
        route === "function"
          ? await patch(root, "tracked.txt")
          : route === "HTTP"
            ? await api(`/v1/conversations/${c.id}/changes?path=tracked.txt`)
            : await performAction(client, {
                type: "changes.diff",
                conversationId: c.id,
                path: "tracked.txt",
              });
      assert.match(diff.unstaged, /\+changed/);
      assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "changed\n");
      assert.equal(readFileSync(join(root, "ignored"), "utf8"), "ignored content\n");
    }
    assert.equal(existsSync(sentinel), false, "Git invoked the fsmonitor sentinel program");
  });

const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  do {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 20));
  } while (Date.now() < end);
  throw Error("RC regression timeout");
};
async function mockConversation(mode) {
  const root = repository(`mock-${mode}`),
    gate = join(temp, `gate-${mode}`);
  await api("/v1/harness-profiles", "POST", {
    id: mode,
    name: mode,
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/rc.mjs")],
    envOverrides: { HHU_RC_MODE: mode, HHU_RC_GATE: gate },
  });
  const p = await api("/v1/projects", "POST", { rootPath: root });
  const c = await api(`/v1/projects/${p.id}/conversations`, "POST", {});
  return { c, gate, base: `/v1/conversations/${c.id}` };
}
const submit = (base, harnessId) =>
  api(`${base}/turns`, "POST", { harnessId, requestId: crypto.randomUUID(), message: "mock only" });
const completed = (t) => until(async () => (await api(`/v1/turns/${t.id}`)).state === "COMPLETED");
test("RC-02 confirmed idle exit persists end and Desktop explicitly creates a new native context", async () => {
  const { c, base } = await mockConversation("idle-exit");
  const first = await submit(base, "idle-exit");
  await completed(first);
  await until(async () => (await api(base)).runtimeStatus === "INTERRUPTED");
  // Allow close to follow connection.closed, then check persisted exit evidence.
  await new Promise((r) => setTimeout(r, 200));
  const old = (await api(`${base}/sessions`))[0];
  assert.ok(old.endedAt, "connection loss never persisted the later confirmed exit");
  assert.notEqual(old.status, "READY");
  const before = (await api(`${base}/events?limit=1000`)).events;
  const next = await performAction(client, {
    type: "session.recover",
    conversationId: c.id,
    nativeSessionId: old.id,
    confirmed: true,
  });
  assert.notEqual(next.id, old.id);
  assert.equal(next.harnessId, old.harnessId);
  assert.deepEqual((await api(`${base}/events?limit=1000`)).events.slice(0, before.length), before);
  const second = await submit(base, "idle-exit");
  await completed(second);
  assert.equal((await api(`${base}/sessions`)).length, 2);
  assert.equal((await api(`${base}/handoffs`)).length, 0);
});
for (const mode of ["stream-only", "active"])
  test(`RC-02 recovery refuses ${mode} without killing worker`, async () => {
    const { c, base, gate } = await mockConversation(mode);
    const turn = await submit(base, mode);
    try {
      await until(async () => (await api(`${base}/sessions`))[0]?.status === "READY");
      if (mode === "stream-only")
        await until(async () => (await api(base)).runtimeStatus === "INTERRUPTED");
      const old = (await api(`${base}/sessions`))[0];
      assert.equal(old.endedAt, null);
      await assert.rejects(
        performAction(client, {
          type: "session.recover",
          conversationId: c.id,
          nativeSessionId: old.id,
          confirmed: true,
        }),
        (e) => e.status === 409,
      );
      assert.equal((await api(`${base}/sessions`)).length, 1);
    } finally {
      writeFileSync(gate, "exit");
    }
    if (mode === "active") await completed(turn);
  });

for (const mode of ["steer-turn-first", "steer-timeout-first", "steer-ack", "steer-failed"])
  test(`RC-03 ${mode}: input outcome remains independent of completed Turn`, async () => {
    const { c, base, gate } = await mockConversation(mode);
    const turn = await submit(base, mode);
    await until(async () => (await api(`/v1/turns/${turn.id}`)).state === "RUNNING");
    const requestId = crypto.randomUUID();
    await api(`${base}/inputs`, "POST", {
      harnessId: mode,
      requestId,
      message: "steer once",
      delivery: "steer",
    });
    if (mode !== "steer-timeout-first") writeFileSync(gate, "complete original");
    const expected =
      mode === "steer-ack" ? "SENT" : mode === "steer-failed" ? "ERROR" : "UNCERTAIN";
    let record;
    try {
      record = await until(async () => {
        const input = (await api(`${base}/inputs`)).find((i) => i.requestId === requestId);
        return input?.state === expected && input;
      }, 24000);
    } finally {
      writeFileSync(gate, "complete original");
    }
    await completed(turn);
    assert.equal(record.turnId, turn.id);
    const snapshot = await api("/v1/snapshot");
    if (expected === "UNCERTAIN") {
      assert.equal(snapshot.conversations.find((x) => x.id === c.id).runtimeStatus, "UNCERTAIN");
      assert.equal(
        snapshot.pendingInputs.find((x) => x.requestId === requestId).state,
        "UNCERTAIN",
      );
      assert.equal(
        snapshot.activity.items.find((x) => x.conversationId === c.id).status,
        "UNCERTAIN",
      );
      await assert.rejects(submit(base, mode), (e) => e.status === 409);
      const old = (await api(`${base}/sessions`))[0];
      await assert.rejects(
        api(`${base}/session/recover`, "POST", { nativeSessionId: old.id, confirmed: true }),
        (e) => e.status === 409,
      );
      assert.equal((await api("/v1/daemon/upgrade-readiness")).safeToStop, false);
    } else assert.equal(snapshot.conversations.find((x) => x.id === c.id).runtimeStatus, "IDLE");
    const events = (await api(`${base}/events?limit=1000`)).events;
    assert.equal(events.filter((e) => e.raw?.method === "_session/steering").length, 1);
    assert.equal(
      events
        .filter((e) => e.kind === "runtime.input_updated" && e.payload.requestId === requestId)
        .at(-1).payload.state,
      expected,
    );
  });

test("RC-03 Desktop and TUI reconnect to the same durable uncertain delivery after restart", async () => {
  const snapshot = await api("/v1/snapshot");
  const input = snapshot.pendingInputs.find((i) => i.state === "UNCERTAIN");
  assert.ok(input);
  const instanceFile = join(env.XDG_STATE_HOME, "harnesshub/instance.json");
  const desktop = new DesktopConnection(
    { connect: async () => JSON.parse(readFileSync(instanceFile)) },
    50,
  );
  let tui;
  const tuiEvents = [];
  const stopSnapshot = watchSnapshot(
    (value) => {
      tui = value;
    },
    () => {},
  );
  const stopHistory = watchConversation(
    input.conversationId,
    (event) => tuiEvents.push(event),
    () => {},
  );
  try {
    await desktop.connect("isolated-test");
    await until(() => desktop.getState().status === "connected");
    await desktop.select(input.conversationId);
    await until(
      () =>
        desktop.getState().snapshot?.pendingInputs?.some((i) => i.requestId === input.requestId) &&
        tui?.pendingInputs?.some((i) => i.requestId === input.requestId),
    );
    const before = (await api(`/v1/conversations/${input.conversationId}/events?limit=1000`))
      .events;
    const oldPid = client.instance.pid;
    process.kill(oldPid, "SIGKILL"); // Isolated crash; UNCERTAIN intentionally blocks a normal stop.
    await until(() => {
      try {
        process.kill(oldPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    cli("daemon", "start");
    client = new Client(JSON.parse(readFileSync(instanceFile)));
    await until(
      () =>
        desktop.getState().status === "connected" &&
        desktop.getState().backend?.instanceId === client.instance.instanceId,
      10000,
    );
    const after = (await api(`/v1/conversations/${input.conversationId}/events?limit=1000`)).events;
    await until(
      () =>
        desktop.getState().events.length === after.length &&
        tuiEvents.length === after.length &&
        tui?.cursor === desktop.getState().snapshot?.cursor,
      10000,
    );
    assert.deepEqual(desktop.getState().events, tuiEvents);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.deepEqual(desktop.getState().snapshot.pendingInputs, tui.pendingInputs);
    assert.equal((await api(`/v1/turns/${input.turnId}`)).state, "COMPLETED");
    assert.equal(
      (await api(`/v1/conversations/${input.conversationId}/inputs`)).find(
        (i) => i.requestId === input.requestId,
      ).state,
      "UNCERTAIN",
    );
    assert.equal(after.filter((e) => e.raw?.method === "_session/steering").length, 1);
    assert.equal((await api("/v1/daemon/upgrade-readiness")).safeToStop, false);
  } finally {
    desktop.dispose();
    stopHistory();
    stopSnapshot();
  }
});

test("RC-04 crash recovery expires approvals atomically with replayable terminal events", async () => {
  const { base } = await mockConversation("approval");
  const turn = await submit(base, "approval");
  const approval = await until(async () => (await api(`${base}/approvals`))[0]);
  const before = (await api(`${base}/events?limit=1000`)).events;
  const projection = new DesktopTranscript();
  projection.append(before);
  assert.equal(projection.rows.find((r) => r.tool)?.waiting, true);
  const instanceFile = join(env.XDG_STATE_HOME, "harnesshub/instance.json");
  const crashed = JSON.parse(readFileSync(instanceFile));
  process.kill(crashed.pid, "SIGKILL"); // Only this test's isolated Daemon; never default state.
  await until(() => {
    try {
      process.kill(crashed.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  cli("daemon", "start");
  client = new Client(JSON.parse(readFileSync(instanceFile)));
  const events = (await api(`${base}/events?limit=1000`)).events;
  const terminal = events.filter(
    (e) => e.kind === "approval.expired" && e.payload.approvalId === approval.id,
  );
  assert.equal(terminal.length, 1, "EXPIRED approval lacks a replayable terminal event");
  assert.equal(terminal[0].payload.status, "EXPIRED");
  assert.deepEqual(events.slice(0, before.length), before);
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
  );
  projection.append(events.slice(before.length));
  assert.equal(projection.rows.find((r) => r.tool)?.waiting, false);
  const paged = new DesktopTranscript();
  for (let after = 0; after < events.length; ) {
    const page = (await api(`${base}/events?after_seq=${after}&limit=2`)).events;
    paged.append(page);
    after = page.at(-1).seq;
  }
  assert.deepEqual(paged.rows, projection.rows);
  assert.deepEqual(await api(`${base}/approvals`), []);
  const db = new Database(join(env.XDG_DATA_HOME, "harnesshub/harnesshub.db"), { readonly: true });
  assert.equal(
    db.prepare("SELECT status FROM approvals WHERE id=?").get(approval.id).status,
    "EXPIRED",
  );
  db.close();
  await assert.rejects(
    api(`/v1/approvals/${approval.id}/decision`, "POST", { optionId: "deny" }),
    (e) => e.status === 409,
  );
  assert.equal((await api(`/v1/turns/${turn.id}`)).state, "UNCERTAIN");
  cli("daemon", "stop");
  cli("daemon", "start");
  client = new Client(JSON.parse(readFileSync(instanceFile)));
  assert.deepEqual((await api(`${base}/events?limit=1000`)).events, events);
});

test("RC-01 include/filter/diff/textconv/environment commands cannot run; rename/untracked/ignore remain accurate", async () => {
  const root = repository("git-boundary"),
    marker = join(temp, "drivers-called"),
    hook = join(temp, "driver");
  writeFileSync(hook, `#!/bin/sh\nprintf called > '${marker}'\ncat\n`, { mode: 0o700 });
  writeFileSync(join(root, ".gitattributes"), "*.txt filter=rc diff=rc\n");
  const included = join(temp, "included-config");
  writeFileSync(
    included,
    `[core]\n fsmonitor = ${hook}\n[filter "rc"]\n clean = ${hook}\n smudge = ${hook}\n process = ${hook}\n required = true\n[diff "rc"]\n command = ${hook}\n textconv = ${hook}\n[diff]\n external = ${hook}\n`,
  );
  git(root, "add", ".gitattributes");
  git(
    root,
    "-c",
    "user.name=RC",
    "-c",
    "user.email=rc@localhost",
    "commit",
    "-m",
    "attributes fixture",
  );
  // Stage the rename before adding hostile configuration; setup itself stays harmless.
  git(root, "mv", "tracked.txt", "renamed.txt");
  git(root, "config", "include.path", included);
  writeFileSync(join(root, "new.txt"), "untracked content\n");
  writeFileSync(join(root, "ignored"), "kept ignored content\n");
  const injected = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: hook,
    GIT_DIR: join(temp, "nonexistent"),
    GIT_INDEX_FILE: join(temp, "alien-index"),
    GIT_EXTERNAL_DIFF: hook,
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor=should-not-run'",
    BASH_ENV: hook,
    ENV: hook,
  };
  const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
  Object.assign(process.env, injected);
  try {
    const state = await changes(root);
    assert.equal(state.files.find((f) => f.path === "renamed.txt").previousPath, "tracked.txt");
    assert.equal(
      state.files.some((f) => f.path === "ignored"),
      false,
    );
    assert.match((await patch(root, "renamed.txt")).staged, /rename from tracked.txt/);
    assert.match((await patch(root, "new.txt")).untracked, /\+untracked content/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(injected.GIT_INDEX_FILE), false);
    assert.equal(readFileSync(join(root, "renamed.txt"), "utf8"), "original\n");
    assert.equal(readFileSync(join(root, "ignored"), "utf8"), "kept ignored content\n");
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  const p = await api("/v1/projects", "POST", { rootPath: root });
  const c = await api(`/v1/projects/${p.id}/conversations`, "POST", { workspaceMode: "worktree" });
  assert.equal(readFileSync(join(c.workspacePath, "tracked.txt"), "utf8"), "original\n");
  assert.equal(existsSync(marker), false);
});

test("RC-01 status blocks submodule drivers and worktree checkout blocks branch-conditional filters", async () => {
  const parent = repository("submodule-parent"),
    sub = repository("submodule-source");
  writeFileSync(join(sub, ".gitattributes"), "*.txt filter=child\n");
  git(sub, "add", ".gitattributes");
  git(sub, "-c", "user.name=RC", "-c", "user.email=rc@localhost", "commit", "-m", "attributes");
  git(parent, "-c", "protocol.file.allow=always", "submodule", "add", sub, "nested");
  git(parent, "-c", "user.name=RC", "-c", "user.email=rc@localhost", "commit", "-am", "submodule");
  const marker = join(temp, "nested-driver-called"),
    hook = join(temp, "nested-driver");
  writeFileSync(hook, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`, { mode: 0o700 });
  git(join(parent, "nested"), "config", "filter.child.clean", hook);
  writeFileSync(join(parent, "nested/tracked.txt"), "nested changes\n");
  assert.equal((await changes(parent)).files.find((f) => f.path === "nested").worktree, "M");
  await patch(parent, "nested");
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(parent, "nested/tracked.txt"), "utf8"), "nested changes\n");
  const conditional = join(temp, "branch-config");
  writeFileSync(
    conditional,
    `[filter "child"]\n smudge = ${hook}\n required = true\n[core]\n fsmonitor = ${hook}\n`,
  );
  git(sub, "config", "includeIf.onbranch:hhu/**.path", conditional);
  const p = await api("/v1/projects", "POST", { rootPath: sub });
  const c = await api(`/v1/projects/${p.id}/conversations`, "POST", { workspaceMode: "worktree" });
  assert.equal(readFileSync(join(c.workspacePath, "tracked.txt"), "utf8"), "original\n");
  assert.equal(existsSync(marker), false);
});

test("RC-02 child close is not process-group exit; confirmation waits for its descendant", async () => {
  const pidFile = join(temp, "descendant-pid");
  let lost = 0,
    exited = 0;
  const worker = new Worker(
    {
      id: "rc-descendant",
      name: "rc-descendant",
      command: process.execPath,
      args: [resolve("tests/fixtures/mock-acp/descendant.mjs"), "--no-pipes"],
      envOverrides: { HHU_DESCENDANT_PID_FILE: pidFile },
    },
    temp,
    {
      wire() {},
      permission: async () => {
        throw Error("Unexpected permission request");
      },
      lost: () => {
        lost++;
      },
      exited: () => {
        exited++;
      },
    },
  );
  let pid;
  try {
    await worker.initialize();
    pid = Number(readFileSync(pidFile, "utf8"));
    worker.connection.close();
    worker.child.stdin.end();
    await worker.exited;
    assert.equal(worker.closed, true);
    assert.equal(lost, 1);
    assert.equal(worker.exitedConfirmed, false);
    assert.equal(exited, 0);
    process.kill(pid, 0);
    process.kill(pid, "SIGINT"); // Explicit cleanup of this test-owned descendant only.
    await until(() => exited === 1);
    assert.equal(worker.exitedConfirmed, true);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGINT");
      } catch {}
    }
    await worker.stop();
  }
});

test("RC-02 rejected Prompt followed by exit never unlocks an UNCERTAIN Turn", async () => {
  const { c, base } = await mockConversation("uncertain-exit");
  const turn = await submit(base, "uncertain-exit");
  await until(async () => (await api(`/v1/turns/${turn.id}`)).state === "UNCERTAIN");
  const old = await until(async () => {
    const session = (await api(`${base}/sessions`))[0];
    return session?.exitConfirmed && session;
  });
  assert.equal((await api(base)).runtimeStatus, "UNCERTAIN");
  await assert.rejects(
    performAction(client, {
      type: "session.recover",
      conversationId: c.id,
      nativeSessionId: old.id,
      confirmed: true,
    }),
    (e) => e.status === 409,
  );
  assert.equal((await api(`${base}/sessions`)).length, 1);
  assert.equal((await api(`/v1/turns/${turn.id}`)).state, "UNCERTAIN");
});
