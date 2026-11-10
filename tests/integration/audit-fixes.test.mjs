import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  cpSync,
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
import { Client } from "../../dist/client/client.js";
import { smokeEvidence } from "../../scripts/smoke-evidence.mjs";

const temp = mkdtempSync("/tmp/hhu-audit-fixes-");
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_DATA_HOME: join(temp, "data"),
  XDG_STATE_HOME: join(temp, "state"),
};
const cli = (environment, ...args) =>
  execFileSync(process.env.HARNESSHUB_BUN, [resolve("dist/cli/hhu.js"), ...args], {
    env: environment,
    encoding: "utf8",
    timeout: 30000,
  });
const connect = (environment) =>
  new Client(
    JSON.parse(readFileSync(join(environment.XDG_STATE_HOME, "harnesshub/instance.json"))),
  );
cli(env, "daemon", "start");
let client = connect(env);
const api = (path, method, body, timeout = 4000) => client.request(path, method, body, timeout);
const until = async (f, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  do {
    const result = await f();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 20));
  } while (Date.now() < deadline);
  throw Error("audit regression state timed out");
};
const git = (cwd, ...args) =>
  execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const root = join(temp, "repo");
mkdirSync(root);
git(root, "init", "-b", "main");
writeFileSync(join(root, "tracked.txt"), "original\n");
writeFileSync(join(root, ".gitignore"), "late.ignored\n");
git(root, "add", ".");
git(root, "-c", "user.name=HHU", "-c", "user.email=test@localhost", "commit", "-m", "fixture");
const project = await api("/v1/projects", "POST", { rootPath: root });
const conversation = (mode = "shared") =>
  api(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "audit fixes",
    workspaceMode: mode,
  });
const path = (c) => `/v1/conversations/${c.id}`;
const submit = (c, harnessId, message = "test") =>
  api(`${path(c)}/turns`, "POST", { harnessId, message, requestId: crypto.randomUUID() });
const settled = (t) =>
  until(async () => {
    const turn = await api(`/v1/turns/${t.id}`);
    return turn.endedAt && turn;
  });
const profile = (id, overrides = {}) =>
  api("/v1/harness-profiles", "POST", {
    id,
    name: id,
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/audit.mjs")],
    envOverrides: overrides,
  });
const handoff = (c, status) =>
  until(async () => {
    const h = (await api(`${path(c)}/handoffs`)).at(-1);
    return h?.status === status && h;
  });
after(() => {
  cli(env, "daemon", "stop");
  console.log(`Audit remediation evidence: ${temp}`);
});

test("cleanup rejects assume-unchanged and skip-worktree without losing hidden edits", async () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const c = await conversation("worktree");
    await api(path(c), "DELETE", { confirmed: true });
    git(c.workspacePath, "update-index", flag, "tracked.txt");
    writeFileSync(join(c.workspacePath, "tracked.txt"), `precious ${flag}`);
    assert.equal(git(c.workspacePath, "status", "--porcelain", "--ignored=matching"), "");
    await assert.rejects(
      api(`/v1/worktrees/${c.worktreeId}/cleanup`, "POST", { confirmed: true }),
      (e) => e.status === 409 && /Index flags/.test(e.message),
    );
    assert.equal(readFileSync(join(c.workspacePath, "tracked.txt"), "utf8"), `precious ${flag}`);
    assert.ok(git(root, "worktree", "list", "--porcelain").includes(c.workspacePath));
  }
});

test("a file written after preflight survives retained cleanup and interrupted move reconciliation", async () => {
  const isolated = {
    ...env,
    XDG_CONFIG_HOME: join(temp, "race/config"),
    XDG_DATA_HOME: join(temp, "race/data"),
    XDG_STATE_HOME: join(temp, "race/state"),
    PATH: `${resolve("tests/fixtures/git-fail")}:${env.PATH}`,
    HHU_REAL_GIT: "/usr/bin/git",
    HHU_TEST_GIT_LATE_IGNORED: "1",
  };
  cli(isolated, "daemon", "start");
  let local = connect(isolated);
  try {
    const p = await local.request("/v1/projects", "POST", { rootPath: root });
    const c = await local.request(`/v1/projects/${p.id}/conversations`, "POST", {
      title: "race",
      workspaceMode: "worktree",
    });
    const original = (await local.request("/v1/worktrees"))[0];
    await local.request(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
    const kept = await local.request(`/v1/worktrees/${c.worktreeId}/cleanup`, "POST", {
      confirmed: true,
    });
    assert.equal(kept.status, "RETAINED");
    assert.equal(existsSync(c.workspacePath), false);
    assert.equal(
      readFileSync(join(kept.path, "late.ignored"), "utf8"),
      "precious after preflight\n",
    );
    assert.equal(readFileSync(join(kept.path, "tracked.txt"), "utf8"), "original\n");
    assert.ok(git(root, "worktree", "list", "--porcelain").includes(kept.path));
    cli(isolated, "daemon", "stop");
    // Simulate the durable crash boundary after Git move, before metadata commit.
    const db = new Database(join(isolated.XDG_DATA_HOME, "harnesshub/harnesshub.db"));
    db.prepare(
      "UPDATE managed_worktrees SET path=?,owner_root=?,status='PRESERVING' WHERE id=?",
    ).run(original.path, original.ownerRoot, original.id);
    db.close();
    cli(isolated, "daemon", "start");
    local = connect(isolated);
    assert.equal((await local.request("/v1/worktrees"))[0].status, "ERROR");
    const recovered = await local.request(`/v1/worktrees/${c.worktreeId}/cleanup`, "POST", {
      confirmed: true,
    });
    assert.equal(recovered.path, kept.path);
    assert.equal(recovered.status, "RETAINED");
    assert.equal(
      readFileSync(join(recovered.path, "late.ignored"), "utf8"),
      "precious after preflight\n",
    );
  } finally {
    cli(isolated, "daemon", "stop");
  }
});

for (const cooperative of [false, true])
  test(`no-pipe descendant ${cooperative ? "exits cooperatively" : "blocks stop until explicit force"}`, async () => {
    const marker = join(temp, `tick-${cooperative}`),
      pidFile = join(temp, `pid-${cooperative}`);
    const worker = new Worker(
      {
        id: "descendant",
        name: "descendant",
        command: process.execPath,
        args: [resolve("tests/fixtures/mock-acp/descendant.mjs"), "--no-pipes"],
        envOverrides: {
          HHU_DESCENDANT_TICK: marker,
          HHU_DESCENDANT_PID_FILE: pidFile,
          ...(cooperative ? { HHU_DESCENDANT_COOPERATIVE: "1" } : {}),
        },
      },
      root,
      { wire() {}, lost() {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) },
    );
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    try {
      await worker.initialize();
      await until(() => existsSync(marker));
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (cooperative) await worker.stop();
      else {
        await assert.rejects(worker.stop(), /has not confirmed exit/);
        assert.equal(worker.child.exitCode, 0);
        assert.equal(worker.exitedConfirmed, false);
        const before = readFileSync(marker, "utf8");
        await new Promise((r) => setTimeout(r, 100));
        assert.notEqual(readFileSync(marker, "utf8"), before);
        process.kill(pid, 0);
        await worker.stop(true); // explicitly scoped force against this test-owned Worker
      }
      assert.equal(worker.exitedConfirmed, true);
      process.kill(other.pid, 0);
      const final = readFileSync(marker, "utf8");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(readFileSync(marker, "utf8"), final);
    } finally {
      if (!worker.exitedConfirmed) await worker.stop(true);
      const closed = once(other, "close");
      other.kill("SIGTERM");
      await closed;
    }
  });

test("retry after degraded target preparation failure delivers the fresh report exactly once", async () => {
  const reportGate = join(temp, "report-ready"),
    targetGate = join(temp, "target-ready");
  await profile("audit-source", { HHU_AUDIT_REPORT_GATE: reportGate });
  await profile("audit-target", { HHU_AUDIT_NEW_GATE: targetGate });
  const c = await conversation();
  await settled(await submit(c, "audit-source"));
  const target = await submit(c, "audit-target", "reserved user request");
  let h = await handoff(c, "FAILED");
  await api(`${path(c)}/handoff/action`, "POST", { handoffId: h.id, action: "confirm" });
  h = await handoff(c, "FAILED");
  assert.equal(h.degraded, true);
  writeFileSync(reportGate, "ready");
  writeFileSync(targetGate, "ready");
  await api(`${path(c)}/handoff/action`, "POST", { handoffId: h.id, action: "retry" });
  assert.equal((await settled(target)).state, "COMPLETED");
  h = await handoff(c, "COMMITTED");
  assert.equal(h.degraded, false);
  assert.equal(h.confirmedAt, null);
  assert.equal(h.fallbackText, null);
  const events = (await api(`${path(c)}/events?limit=1000`)).events;
  const delivery = events.filter(
    (e) => e.raw?.method === "session/prompt" && e.nativeSessionId === h.targetNativeSessionId,
  );
  assert.equal(delivery.length, 1);
  assert.match(delivery[0].payload.prompt[0].text, /FRESH_REPORT/);
  assert.equal(events.filter((e) => e.kind === "user.message" && e.turnId === target.id).length, 1);
});

test("explicit native close and clean restart persist a visible lost-context boundary", async () => {
  await profile("audit-context");
  const c = await conversation();
  await settled(await submit(c, "audit-context", "remember unique-old-context"));
  await api(`${path(c)}/session/stop`, "POST", { force: false });
  assert.equal((await api(path(c))).runtimeStatus, "INTERRUPTED");
  assert.ok(
    (await api(`${path(c)}/events?limit=1000`)).events.some(
      (e) => e.kind === "runtime.context_ended",
    ),
  );
  await settled(await submit(c, "audit-context", "next native segment"));
  cli(env, "daemon", "stop");
  // Simulate an older build's clean shutdown: the native session is already
  // closed but the Conversation incorrectly persisted IDLE.
  const db = new Database(join(env.XDG_DATA_HOME, "harnesshub/harnesshub.db"));
  assert.equal(
    db.prepare("SELECT runtime_status FROM conversations WHERE id=?").get(c.id).runtime_status,
    "INTERRUPTED",
  );
  db.prepare("UPDATE conversations SET runtime_status='IDLE' WHERE id=?").run(c.id);
  db.close();
  cli(env, "daemon", "start");
  client = connect(env);
  assert.equal((await api(path(c))).runtimeStatus, "INTERRUPTED");
  assert.ok(
    (await api(`${path(c)}/events?limit=1000`)).events.some(
      (e) =>
        e.kind === "runtime.context_ended" && e.payload.reason === "native_session_already_closed",
    ),
  );
  assert.equal((await api(`${path(c)}/sessions`)).length, 2);
  const t = await settled(await submit(c, "audit-context", "fresh-only-message"));
  const es = (await api(`${path(c)}/events?limit=1000`)).events;
  const prompt = es.find((e) => e.turnId === t.id && e.raw?.method === "session/prompt");
  assert.equal(prompt.payload.prompt[0].text, "fresh-only-message");
  assert.equal((await api(`${path(c)}/sessions`)).length, 3);
});

test("timed-out native settings block new Turns until late response or confirmed stop", async () => {
  await profile("audit-slow", { HHU_AUDIT_SETTING_DELAY: "22000" });
  await profile("audit-hang", { HHU_AUDIT_SETTING_WAIT: "1" });
  const slow = await conversation(),
    hang = await conversation();
  await api(`${path(slow)}/sessions`, "POST", { harnessId: "audit-slow" });
  await api(`${path(hang)}/sessions`, "POST", { harnessId: "audit-hang" });
  const requests = [slow, hang].map((c) =>
    assert.rejects(
      api(`${path(c)}/settings`, "POST", { kind: "mode", modeId: "new" }, 26000),
      (e) => e.status === 503 && /timed out/.test(e.message),
    ),
  );
  await Promise.all(requests);
  for (const [c, h] of [
    [slow, "audit-slow"],
    [hang, "audit-hang"],
  ]) {
    assert.equal((await api(`${path(c)}/sessions`)).at(-1).status, "CONFIGURING");
    await assert.rejects(submit(c, h), (e) => e.status === 409);
    await assert.rejects(
      api(`${path(c)}/settings`, "POST", { kind: "mode", modeId: "old" }),
      (e) => e.status === 409,
    );
    assert.equal(
      (await api(`${path(c)}/events?limit=1000`)).events.filter(
        (e) => e.raw?.method === "session/prompt",
      ).length,
      0,
    );
  }
  await until(async () => (await api(`${path(slow)}/sessions`)).at(-1).status === "READY");
  const ready = (await api(`${path(slow)}/sessions`)).at(-1);
  assert.equal(ready.capabilities.session.modes.currentModeId, "new");
  await settled(await submit(slow, "audit-slow"));
  assert.ok(
    (await api(`${path(slow)}/events?limit=1000`)).events.some(
      (e) => e.payload?.content?.text === "executing in new",
    ),
  );
  await assert.rejects(
    api(`${path(hang)}/session/stop`, "POST", { force: false }),
    (e) => e.status === 409,
  );
  await assert.rejects(
    api(`${path(hang)}/session/stop`, "POST", { force: true }),
    (e) => e.status === 400,
  );
  await api(`${path(hang)}/session/stop`, "POST", { force: true, confirmed: true }, 12000);
  assert.equal((await api(`${path(hang)}/sessions`)).at(-1).status, "CLOSED");
  assert.equal((await api(path(hang))).runtimeStatus, "INTERRUPTED");
});

test("failed partial installation preserves the entire previous runnable release", async () => {
  const copy = join(temp, "install/source");
  mkdirSync(copy, { recursive: true });
  for (const dir of ["apps", "packages", "scripts"])
    cpSync(resolve(dir), join(copy, dir), { recursive: true, verbatimSymlinks: true });
  for (const file of ["package.json", "bunfig.toml", "tsconfig.json"])
    cpSync(resolve(file), join(copy, file));
  symlinkSync(resolve("node_modules"), join(copy, "node_modules"));
  const isolated = {
    ...env,
    HOME: join(temp, "install/home"),
    XDG_CONFIG_HOME: join(temp, "install/config"),
    XDG_DATA_HOME: join(temp, "install/data"),
    XDG_STATE_HOME: join(temp, "install/state"),
  };
  mkdirSync(isolated.HOME, { recursive: true });
  const install = () =>
    execFileSync(process.env.HARNESSHUB_BUN, ["scripts/install-local.ts"], {
      cwd: copy,
      env: isolated,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  assert.match(install(), /Installed/);
  const launcher = join(isolated.HOME, ".local/bin/hhu"),
    before = readFileSync(launcher, "utf8");
  const cliFile = before.match(/'([^']+\/cli\/hhu\.js)'/)[1],
    daemonFile = join(cliFile, "../../daemon/index.js");
  const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const old = { cli: hash(cliFile), daemon: hash(daemonFile) };
  const shared = join(copy, "packages/shared/src/index.ts");
  writeFileSync(
    shared,
    readFileSync(shared, "utf8").replace(
      /export const VERSION = "[^"]+";/,
      'export const VERSION = "999.0.0";',
    ),
  );
  const entry = join(copy, "apps/cli/src/index.ts");
  writeFileSync(entry, `${readFileSync(entry, "utf8")}\nconst invalid = ;\n`);
  assert.throws(install, /Build failed; previous launcher and release were not changed/);
  assert.equal(readFileSync(launcher, "utf8"), before);
  assert.equal(hash(cliFile), old.cli);
  assert.equal(hash(daemonFile), old.daemon);
  const run = (...args) =>
    execFileSync(launcher, args, {
      env: isolated,
      cwd: isolated.HOME,
      encoding: "utf8",
      timeout: 30000,
    });
  assert.equal(
    run("--version").trim(),
    `HarnessHub ${JSON.parse(readFileSync("package.json", "utf8")).version}`,
  );
  run("daemon", "start");
  run("daemon", "stop");
});

test("real smoke evidence rejects later-Turn tools, failed outputs and input-only cwd", () => {
  const turn = { id: "smoke" },
    workspace = "/tmp/workspace",
    sentinel = "UNIQUE_SENTINEL";
  const event = (turnId, kind, payload) => ({ turnId, kind, payload });
  const text = event("smoke", "agent_message_chunk", { content: { text: sentinel } });
  const completed = event("cancel", "tool_call", {
    toolCallId: "later",
    status: "completed",
    rawOutput: `${workspace}\n${sentinel}\n`,
  });
  assert.equal(smokeEvidence([text, completed], turn, workspace, sentinel).toolsVerified, false);
  const native = { ...completed, turnId: "smoke" };
  assert.equal(smokeEvidence([text, native], turn, workspace, sentinel).toolsVerified, true);
  assert.equal(
    smokeEvidence(
      [text, { ...native, payload: { ...native.payload, status: "failed" } }],
      turn,
      workspace,
      sentinel,
    ).toolsVerified,
    false,
  );
  assert.equal(
    smokeEvidence(
      [
        text,
        {
          ...native,
          payload: {
            toolCallId: "x",
            status: "completed",
            rawInput: `${workspace}\n${sentinel}\n`,
          },
        },
      ],
      turn,
      workspace,
      sentinel,
    ).toolsVerified,
    false,
  );
});
