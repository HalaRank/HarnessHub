import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { Client, watchConversation, watchSnapshot } from "../../dist/client/client.js";
import { DesktopConnection } from "../../dist/desktop/test/connection.js";

const temp = mkdtempSync(join(tmpdir(), "hhu-desktop-integration-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_STATE_HOME: join(temp, "state"),
  XDG_DATA_HOME: join(temp, "data"),
};
for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"])
  process.env[key] = env[key];
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const run = promisify(execFile);
const cli = (...args) =>
  run(process.env.HARNESSHUB_BUN, [resolve("dist/cli/hhu.js"), ...args], {
    env,
    cwd: "/",
    timeout: 30000,
  });
const instanceFile = join(env.XDG_STATE_HOME, "harnesshub/instance.json");
const instance = () => JSON.parse(readFileSync(instanceFile, "utf8"));
const bridge = async () => JSON.parse((await cli("desktop-bridge", version, "1")).stdout).instance;
const waitFor = async (fn) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Desktop integration timeout");
};
let discoveries = 0;
const desktop = new DesktopConnection(
  {
    connect: async () => {
      discoveries++;
      return bridge();
    },
  },
  100,
);
const states = [];
desktop.onState((state) => states.push(state));
const cleanups = [() => desktop.dispose()];
after(async () => {
  for (const cleanup of cleanups) cleanup();
  await cli("daemon", "stop").catch(() => {});
  console.log(`Desktop integration evidence: ${temp}`);
});
let client, project, conversation;

test("Bridge starts absent Daemon, concurrent/repeated starts reuse existing pid and token", async () => {
  const [first, second] = await Promise.all([bridge(), bridge()]);
  assert.deepEqual(second, first);
  client = new Client(first);
  await client.health();
  assert.equal((await bridge()).instanceId, first.instanceId);
  const root = join(temp, "Linux project with spaces");
  mkdirSync(root);
  project = await client.request("/v1/projects", "POST", {
    rootPath: root,
    name: "Desktop integration",
  });
  conversation = await client.request(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "Shared history",
  });
  assert.equal(conversation.workspacePath, root);
  await client.request("/v1/harness-profiles", "POST", {
    id: "desktop-mock",
    name: "Desktop mock",
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: {},
  });
});
test("Bridge incompatible client/version refuses without signalling or replacing Daemon", async () => {
  const before = instance();
  await assert.rejects(cli("desktop-bridge", "incompatible", "99"), (error) => {
    const envelope = JSON.parse(error.stdout);
    assert.equal(envelope.error, "INCOMPATIBLE");
    assert.equal(envelope.diagnostics.bridgeVersion, version);
    assert.equal(envelope.diagnostics.daemonVersion, version);
    assert.equal(envelope.diagnostics.instanceId, before.instanceId);
    assert.equal(envelope.diagnostics.readiness.safeToStop, true);
    assert.ok(!error.stdout.includes(before.token));
    return true;
  });
  assert.deepEqual(instance(), before);
  await client.health();
});
test("Desktop and TUI clients share real SQLite/WS history and exact Linux workspace", async () => {
  let tuiSnapshot;
  const tuiEvents = [];
  cleanups.push(
    watchSnapshot(
      (value) => {
        tuiSnapshot = value;
      },
      () => {},
    ),
  );
  cleanups.push(
    watchConversation(
      conversation.id,
      (event) => tuiEvents.push(event),
      () => {},
    ),
  );
  await desktop.connect("Ubuntu-test");
  await waitFor(() => desktop.getState().status === "connected");
  await desktop.select(conversation.id);
  const turn = await client.request(`/v1/conversations/${conversation.id}/turns`, "POST", {
    requestId: randomUUID(),
    harnessId: "desktop-mock",
    message: "hello",
  });
  await waitFor(async () => (await client.request(`/v1/turns/${turn.id}`)).state === "COMPLETED");
  const canonical = await client.request(`/v1/conversations/${conversation.id}/events?limit=1000`);
  await waitFor(
    () =>
      desktop.getState().events.length === canonical.events.length &&
      tuiEvents.length === canonical.events.length &&
      tuiSnapshot?.conversations.length,
  );
  assert.deepEqual(desktop.getState().events, tuiEvents);
  assert.equal(desktop.getState().snapshot.conversations[0].workspacePath, project.rootPath);
  assert.equal(
    (await client.request(`/v1/conversations/${conversation.id}/sessions`))[0].cwd,
    project.rootPath,
  );
  assert.equal((await client.request("/v1/preferences")).lastConversationId, conversation.id);
  const safeState = JSON.stringify(states);
  assert.ok(!safeState.includes(instance().token));
  assert.ok(!safeState.includes('"port":'));
  assert.equal(desktop.getState().backend.instanceId, instance().instanceId);
});
test("Daemon restart rediscovers token/port/identity and catches up by seq without duplicate turns", async () => {
  const before = instance();
  const historyBefore = desktop.getState().events.length;
  const requestCount = desktop
    .getState()
    .events.filter((event) => event.kind === "user.message").length;
  await cli("daemon", "stop");
  await waitFor(
    () =>
      desktop.getState().status === "connected" &&
      discoveries > 1 &&
      instance().instanceId !== before.instanceId,
  );
  client = new Client(instance());
  assert.notEqual(instance().token, before.token);
  assert.ok(states.some((state) => state.status === "disconnected"));
  await waitFor(
    () => desktop.getState().events.length >= historyBefore && !desktop.getState().historyLoading,
  );
  const events = desktop.getState().events;
  assert.equal(new Set(events.map((event) => event.seq)).size, events.length);
  assert.equal(events.filter((event) => event.kind === "user.message").length, requestCount);
  assert.equal(desktop.getState().conversationId, conversation.id);
});
test("rapid selection cannot mix histories or persist stale preference", async () => {
  const other = await client.request(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "Other",
  });
  await waitFor(() => desktop.getState().snapshot.conversations.some((c) => c.id === other.id));
  await Promise.all([
    desktop.select(other.id),
    desktop.select(conversation.id),
    desktop.select(other.id),
  ]);
  assert.equal(desktop.getState().conversationId, other.id);
  assert.deepEqual(desktop.getState().events, []);
  assert.equal((await client.request("/v1/preferences")).lastConversationId, other.id);
  await desktop.select(conversation.id);
});
test("closing Desktop during active turn leaves Daemon/Worker alive; reopening restores selection", async () => {
  const turn = await client.request(`/v1/conversations/${conversation.id}/turns`, "POST", {
    requestId: randomUUID(),
    harnessId: "desktop-mock",
    message: "slow",
  });
  const before = instance();
  desktop.dispose();
  await client.health();
  assert.equal(instance().pid, before.pid);
  await client.request(`/v1/turns/${turn.id}/cancel`, "POST");
  await waitFor(async () =>
    ["CANCELLED", "COMPLETED"].includes((await client.request(`/v1/turns/${turn.id}`)).state),
  );
  const reopened = new DesktopConnection({ connect: bridge });
  cleanups.push(() => reopened.dispose());
  await reopened.connect("Ubuntu-test");
  await waitFor(
    () => reopened.getState().status === "connected" && !reopened.getState().historyLoading,
  );
  assert.equal(reopened.getState().conversationId, conversation.id);
  assert.equal(instance().pid, before.pid);
});
test("forwarded wrong identity/version is rejected without lifecycle writes or renderer token", async () => {
  for (const mismatch of ["identity", "version"]) {
    const current = instance();
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          instanceId: mismatch === "identity" ? randomUUID() : current.instanceId,
          pid: current.pid,
          version: mismatch === "version" ? "old" : version,
          protocolVersion: 1,
          product: "HarnessHub",
          runtime: "node",
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const wrong = new DesktopConnection({
      connect: async () => ({ ...current, port: server.address().port }),
    });
    try {
      await wrong.connect("Ubuntu-test");
      assert.equal(wrong.getState().status, mismatch === "identity" ? "error" : "incompatible");
      assert.ok(!JSON.stringify(wrong.getState()).includes(current.token));
      assert.equal(instance().pid, current.pid);
    } finally {
      wrong.dispose();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("WSL Bridge refuses a live incompatible Daemon without stop, spawn, or metadata replacement", async () => {
  const { writeFileSync } = await import("node:fs");
  const isolated = mkdtempSync(join(tmpdir(), "hhu-desktop-incompatible-"));
  const metadataDir = join(isolated, "harnesshub");
  mkdirSync(metadataDir, { mode: 0o700 });
  let stopRequests = 0;
  const incompatible = { ...instance(), instanceId: randomUUID(), version: "0.0.0" };
  const server = createServer((req, res) => {
    if (req.method !== "GET" || !["/v1/health", "/v1/daemon/upgrade-readiness"].includes(req.url))
      stopRequests++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ ...incompatible, token: undefined, product: "HarnessHub", runtime: "node" }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  incompatible.port = server.address().port;
  const file = join(metadataDir, "instance.json");
  const original = JSON.stringify(incompatible);
  writeFileSync(file, original, { mode: 0o600 });
  try {
    await assert.rejects(
      run(
        process.env.HARNESSHUB_BUN,
        [resolve("dist/cli/hhu.js"), "desktop-bridge", version, "1"],
        { env: { ...env, XDG_STATE_HOME: isolated }, timeout: 5000 },
      ),
      (error) => {
        const envelope = JSON.parse(error.stdout);
        assert.equal(envelope.error, "INCOMPATIBLE");
        assert.equal(envelope.diagnostics.bridgeVersion, version);
        assert.equal(envelope.diagnostics.daemonVersion, "0.0.0");
        assert.equal(envelope.diagnostics.instanceId, incompatible.instanceId);
        assert.equal(envelope.diagnostics.readiness, null);
        return true;
      },
    );
    assert.equal(stopRequests, 0);
    assert.equal(readFileSync(file, "utf8"), original);
    await client.health();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Desktop Phase 2 typed actions: draft CAS, duplicate submit, native settings/slash, approvals, cancellation and management", async () => {
  const connection = new DesktopConnection({ connect: bridge }, 100);
  try {
    await connection.connect("Ubuntu-test");
    await waitFor(() => connection.getState().status === "connected");
    const created = await connection.action({
      type: "conversation.create",
      projectId: project.id,
      title: "Desktop chat",
    });
    const id = created.id;
    await connection.select(id);
    await client.request("/v1/harness-profiles", "POST", {
      id: "desktop-commands",
      name: "Commands",
      command: process.execPath,
      args: [resolve("tests/fixtures/mock-acp/server.mjs")],
      envOverrides: {
        HHU_MOCK_COMMANDS: JSON.stringify([
          { name: "silent", description: "Native silent command" },
        ]),
      },
    });
    await connection.action({
      type: "harness.select",
      conversationId: id,
      harnessId: "desktop-commands",
    });
    assert.equal((await client.request(`/v1/conversations/${id}/sessions`)).length, 0);
    const native = await connection.action({
      type: "session.prepare",
      conversationId: id,
      harnessId: "desktop-commands",
    });
    assert.equal(native.cwd, project.rootPath);
    await connection.action({
      type: "session.settings",
      conversationId: id,
      setting: { kind: "config", configId: "model", value: "other" },
    });
    let draft = await connection.action({ type: "draft.load", conversationId: id });
    const saved = await connection.action({
      type: "draft.save",
      conversationId: id,
      draft: { revision: draft.revision, text: "hello", pendingSubmission: null },
    });
    await assert.rejects(
      connection.action({
        type: "draft.save",
        conversationId: id,
        draft: { revision: draft.revision, text: "stale TUI", pendingSubmission: null },
      }),
    );
    const input = { requestId: randomUUID(), harnessId: "desktop-commands", message: "hello" };
    const actions = await Promise.allSettled([
      connection.action({
        type: "turn.submit",
        conversationId: id,
        revision: saved.revision,
        input,
      }),
      connection.action({
        type: "turn.submit",
        conversationId: id,
        revision: saved.revision,
        input,
      }),
    ]);
    assert.equal(actions.filter((a) => a.status === "fulfilled").length, 1);
    const turn = await connection.action({
      type: "request.lookup",
      conversationId: id,
      requestId: input.requestId,
    });
    assert.match(turn.requestHash, /^[a-f0-9]{64}$/);
    await waitFor(async () => (await client.request(`/v1/turns/${turn.id}`)).state === "COMPLETED");
    draft = await connection.action({ type: "draft.load", conversationId: id });
    assert.equal(draft.text, "");
    assert.equal(draft.pendingSubmission, null);
    const submit = async (message, nativeCommand) => {
      const draft = await connection.action({ type: "draft.load", conversationId: id });
      return connection.action({
        type: "turn.submit",
        conversationId: id,
        revision: draft.revision,
        input: {
          requestId: randomUUID(),
          harnessId: "desktop-commands",
          message,
          ...(nativeCommand ? { nativeCommand } : {}),
        },
      });
    };
    const slash = await submit("/silent", { nativeSessionId: native.id, name: "silent" });
    await waitFor(
      async () => (await client.request(`/v1/turns/${slash.id}`)).state === "COMPLETED",
    );
    const permission = await submit("permission");
    const approval = await waitFor(
      async () => (await client.request(`/v1/conversations/${id}/approvals`))[0],
    );
    const readiness = await client.request("/v1/daemon/upgrade-readiness");
    assert.ok(readiness.blockers.includes("Pending approvals"));
    await assert.rejects(
      client.request("/v1/daemon/stop", "POST", { forUpgrade: true }),
      (e) => e.status === 409,
    );
    const decisions = await Promise.allSettled([
      connection.action({
        type: "approval.decide",
        conversationId: id,
        approvalId: approval.id,
        optionId: "native-reject",
      }),
      client.request(`/v1/approvals/${approval.id}/decision`, "POST", {
        optionId: "native-reject",
      }),
    ]);
    assert.equal(decisions.filter((d) => d.status === "fulfilled").length, 1);
    await waitFor(async () => (await client.request(`/v1/turns/${permission.id}`)).endedAt);
    const waiting = await submit("wait");
    await waitFor(
      async () => (await client.request(`/v1/conversations/${id}`)).runtimeStatus === "RUNNING",
    );
    await connection.action({ type: "turn.cancel", conversationId: id, turnId: waiting.id });
    await waitFor(
      async () => (await client.request(`/v1/turns/${waiting.id}`)).state === "CANCELLED",
    );
    await connection.action({
      type: "conversation.patch",
      conversationId: id,
      patch: { title: "Renamed", archived: true },
    });
    assert.ok((await client.request(`/v1/conversations/${id}`)).archivedAt);
    await connection.action({
      type: "conversation.patch",
      conversationId: id,
      patch: { archived: false },
    });
    assert.equal((await client.request(`/v1/conversations/${id}`)).title, "Renamed");
    await connection.action({ type: "conversation.delete", conversationId: id, confirmed: true });
    await assert.rejects(client.request(`/v1/conversations/${id}`));
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(project.rootPath));
    const standalone = await connection.action({
      type: "conversation.standalone",
      workspacePath: project.rootPath,
      title: "Standalone",
    });
    assert.equal(standalone.projectId, null);
    assert.equal(standalone.workspacePath, project.rootPath);
    await connection.action({
      type: "conversation.delete",
      conversationId: standalone.id,
      confirmed: true,
    });
  } finally {
    connection.dispose();
  }
});

test("Desktop HTTP ACK loss retains one SQLite request and hash; reopening and lookup never replay", async () => {
  const { performAction } = await import("../../dist/desktop/test/connection.js");
  const c = await client.request(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "ACK loss",
  });
  const input = { requestId: randomUUID(), harnessId: "desktop-mock", message: "timed" };
  let posts = 0;
  const dropping = {
    request: async (path, method, body) => {
      const result = await client.request(path, method, body);
      if (path.endsWith("/turns") && method === "POST") {
        posts++;
        throw new Error("HTTP ACK lost after SQLite commit");
      }
      return result;
    },
  };
  await assert.rejects(
    performAction(dropping, { type: "turn.submit", conversationId: c.id, revision: 0, input }),
    /ACK lost/,
  );
  const recorded = await performAction(client, {
    type: "request.lookup",
    conversationId: c.id,
    requestId: input.requestId,
  });
  assert.equal(recorded.requestId, input.requestId);
  assert.match(recorded.requestHash, /^[a-f0-9]{64}$/);
  await waitFor(async () => (await client.request(`/v1/turns/${recorded.id}`)).endedAt);
  const page = await client.request(`/v1/conversations/${c.id}/events?limit=1000`);
  assert.equal(page.events.filter((e) => e.kind === "user.message").length, 1);
  assert.equal(posts, 1);
  await client.request(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
});

test("large streaming history uses bounded Main memory and incremental IPC, paginated replay stays continuous", async () => {
  const c = await client.request(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "Long history",
  });
  const connection = new DesktopConnection({ connect: bridge }, 100);
  const batches = [];
  let transferred = 0;
  connection.onState((state) => {
    assert.ok(state.events.length <= 200);
    transferred += state.events.length;
    if (state.events.length) batches.push(state.events);
  });
  try {
    await connection.connect("Ubuntu-test");
    await waitFor(() => connection.getState().status === "connected");
    await connection.select(c.id);
    const turn = await connection.action({
      type: "turn.submit",
      conversationId: c.id,
      revision: 0,
      input: { requestId: randomUUID(), harnessId: "desktop-mock", message: "long-history" },
    });
    await waitFor(async () => (await client.request(`/v1/turns/${turn.id}`)).endedAt);
    const first = await connection.action({ type: "history", conversationId: c.id, after: 0 });
    await waitFor(() => connection.getState().eventCursor === first.cursor);
    assert.ok(first.cursor > 2500);
    assert.ok(connection.getState().events.length <= 200);
    const flat = batches.flat().filter((e) => e.conversationId === c.id);
    assert.equal(flat.length, first.cursor);
    assert.ok(transferred < first.cursor + 500);
    assert.deepEqual(
      flat.map((e) => e.seq),
      Array.from({ length: first.cursor }, (_, i) => i + 1),
    );
    let after = 0;
    while (after < first.cursor) {
      const page = await connection.action({ type: "history", conversationId: c.id, after });
      for (const event of page.events) {
        assert.equal(event.seq, after + 1);
        after = event.seq;
      }
    }
    assert.equal(after, first.cursor);
  } finally {
    connection.dispose();
    await client.request(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
  }
});

test("Desktop Harness selection is inert; failed Handoff is visible; stale native command is refused", async () => {
  const connection = new DesktopConnection({ connect: bridge }, 100);
  const c = await client.request(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "Handoff failure",
  });
  await client.request("/v1/harness-profiles", "POST", {
    id: "desktop-failed-source",
    name: "Failed source",
    command: process.execPath,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: { HHU_MOCK_REPORT_FAIL: "1" },
  });
  try {
    await connection.connect("Ubuntu-test");
    await waitFor(() => connection.getState().status === "connected");
    await connection.select(c.id);
    const first = await connection.action({
      type: "turn.submit",
      conversationId: c.id,
      revision: 0,
      input: { requestId: randomUUID(), harnessId: "desktop-failed-source", message: "hello" },
    });
    await waitFor(async () => (await client.request(`/v1/turns/${first.id}`)).endedAt);
    await connection.action({
      type: "harness.select",
      conversationId: c.id,
      harnessId: "desktop-mock",
    });
    assert.equal((await client.request(`/v1/conversations/${c.id}/handoffs`)).length, 0);
    const draft = await connection.action({ type: "draft.load", conversationId: c.id });
    const turn = await connection.action({
      type: "turn.submit",
      conversationId: c.id,
      revision: draft.revision,
      input: { requestId: randomUUID(), harnessId: "desktop-mock", message: "target work" },
    });
    await waitFor(() =>
      connection.getState().interaction?.handoffs.some((h) => h.status === "FAILED"),
    );
    assert.ok(connection.getState().interaction.handoffs[0].error);
    assert.ok(
      (await client.request("/v1/daemon/upgrade-readiness")).blockers.includes(
        "Unresolved Handoff",
      ),
    );
    await assert.rejects(
      client.request("/v1/daemon/stop", "POST", { forUpgrade: true }),
      (e) => e.status === 409,
    );
    assert.equal((await client.request(`/v1/conversations/${c.id}/sessions`)).length, 1);
    const handoff = connection.getState().interaction.handoffs[0];
    await connection.action({
      type: "handoff.action",
      conversationId: c.id,
      input: { handoffId: handoff.id, action: "cancel" },
    });
    assert.equal((await client.request(`/v1/turns/${turn.id}`)).state, "CANCELLED");
  } finally {
    connection.dispose();
    await client.request(`/v1/conversations/${c.id}`, "DELETE", { confirmed: true });
  }
});

test("Desktop Changes/Diff match real Git, provenance navigation and RETAINED Worktree cleanup preserve user data", async () => {
  const connection = new DesktopConnection({ connect: bridge }, 100);
  const root = join(temp, "coding workspace 世界 & $");
  mkdirSync(root);
  const git = (...args) => run("git", args, { cwd: root });
  await git("init", "-b", "main");
  writeFileSync(join(root, "sentinel.txt"), "original\n");
  writeFileSync(join(root, "deleted.txt"), "delete fixture\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=HHU Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "fixture",
  );
  const p = await client.request("/v1/projects", "POST", { rootPath: root });
  await connection.connect("Ubuntu-test");
  await waitFor(() => connection.getState().status === "connected");
  try {
    const shared = await connection.action({
      type: "conversation.create",
      projectId: p.id,
      title: "Shared",
      workspaceMode: "shared",
    });
    assert.equal(shared.workspacePath, root);
    writeFileSync(join(root, "sentinel.txt"), "updated 世界\n");
    unlinkSync(join(root, "deleted.txt"));
    writeFileSync(join(root, "added.txt"), "added\n");
    await git("add", "added.txt");
    writeFileSync(join(root, "untracked & #%.ts"), "const x = 2;\n");
    const changes = await connection.action({ type: "changes.list", conversationId: shared.id });
    const actual = (await git("status", "--porcelain=v1", "-z", "--untracked-files=all")).stdout
      .split("\0")
      .filter(Boolean);
    assert.deepEqual(
      changes.files.map((f) => `${f.index}${f.worktree} ${f.path}`),
      actual,
    );
    for (const [path, part, text] of [
      ["sentinel.txt", "unstaged", "+updated 世界"],
      ["deleted.txt", "unstaged", "-delete fixture"],
      ["added.txt", "staged", "+added"],
      ["untracked & #%.ts", "untracked", "+const x = 2;"],
    ]) {
      const diff = await connection.action({
        type: "changes.diff",
        conversationId: shared.id,
        path,
      });
      assert.ok(diff[part].includes(text));
      assert.equal(
        (
          await connection.action({
            type: "workspace.open",
            conversationId: shared.id,
            location: { kind: "change", path },
          })
        ).linuxPath,
        root,
      );
    }
    await assert.rejects(
      connection.action({
        type: "workspace.open",
        conversationId: shared.id,
        location: { kind: "change", path: "../outside" },
      }),
    );
    symlinkSync(temp, join(root, "escape"));
    await assert.rejects(
      connection.action({
        type: "workspace.open",
        conversationId: shared.id,
        location: { kind: "change", path: "escape" },
      }),
    );
    const turn = await connection.action({
      type: "turn.submit",
      conversationId: shared.id,
      revision: 0,
      input: { requestId: randomUUID(), harnessId: "desktop-mock", message: "desktop-native-diff" },
    });
    await waitFor(async () => (await client.request(`/v1/turns/${turn.id}`)).endedAt);
    const events = (await client.request(`/v1/conversations/${shared.id}/events?limit=1000`))
      .events;
    const native = events.find(
      (e) => e.kind === "tool_call" && e.payload.toolCallId === "native-diff",
    );
    assert.ok(native.payload.content[0].newText.includes("native proposed"));
    assert.equal(readFileSync(join(root, "sentinel.txt"), "utf8"), "updated 世界\n");
    assert.equal(
      (
        await connection.action({
          type: "workspace.open",
          conversationId: shared.id,
          location: { kind: "tool", seq: native.seq, collection: "content", index: 0 },
        })
      ).linuxPath,
      root,
    );
    await assert.rejects(
      connection.action({
        type: "workspace.open",
        conversationId: shared.id,
        location: { kind: "tool", seq: 1, collection: "content", index: 0 },
      }),
    );
    const work = await connection.action({
      type: "conversation.create",
      projectId: p.id,
      title: "Isolated",
      workspaceMode: "worktree",
    });
    assert.notEqual(work.workspacePath, root);
    assert.equal(readFileSync(join(work.workspacePath, "sentinel.txt"), "utf8"), "original\n");
    await connection.select(work.id);
    assert.deepEqual(
      (await connection.action({ type: "changes.list", conversationId: work.id })).files,
      [],
    );
    const record = (await connection.action({ type: "worktrees.list" })).find(
      (w) => w.id === work.worktreeId,
    );
    await assert.rejects(
      connection.action({ type: "worktrees.cleanup", worktreeId: record.id, confirmed: true }),
      (e) => e.status === 409,
    );
    await connection.action({
      type: "conversation.delete",
      conversationId: work.id,
      confirmed: true,
    });
    assert.ok(existsSync(work.workspacePath));
    await git("show-ref", "--verify", `refs/heads/${record.branch}`);
    await assert.rejects(
      client.request(`/v1/worktrees/${record.id}/cleanup`, "POST", { confirmed: false }),
      (e) => e.status === 400,
    );
    const retained = await connection.action({
      type: "worktrees.cleanup",
      worktreeId: record.id,
      confirmed: true,
    });
    assert.equal(retained.status, "RETAINED");
    assert.equal(readFileSync(join(retained.path, "sentinel.txt"), "utf8"), "original\n");
    await git("show-ref", "--verify", `refs/heads/${record.branch}`);
    assert.deepEqual(
      await connection.action({
        type: "worktrees.cleanup",
        worktreeId: record.id,
        confirmed: true,
      }),
      retained,
    );
  } finally {
    connection.dispose();
  }
});

test("Desktop normal roundtrip and failed retry/confirm/UNCERTAIN never replay target prompts", async () => {
  const connection = new DesktopConnection({ connect: bridge }, 100);
  await connection.connect("Ubuntu-test");
  await waitFor(() => connection.getState().status === "connected");
  const profile = async (id, envOverrides = {}) =>
    client.request("/v1/harness-profiles", "POST", {
      id,
      name: id,
      command: process.execPath,
      args: [resolve("tests/fixtures/mock-acp/server.mjs")],
      envOverrides,
    });
  await profile("desktop-grok-mock");
  await profile("desktop-uncertain", { HHU_MOCK_TARGET_REJECT: "1" });
  const c = await connection.action({
    type: "conversation.create",
    projectId: project.id,
    title: "Roundtrip",
  });
  const submit = async (harnessId, message = "hello") => {
    const draft = await connection.action({ type: "draft.load", conversationId: c.id });
    return connection.action({
      type: "turn.submit",
      conversationId: c.id,
      revision: draft.revision,
      input: { requestId: randomUUID(), harnessId, message },
    });
  };
  const settled = async (turn) =>
    waitFor(async () => (await client.request(`/v1/turns/${turn.id}`)).endedAt);
  try {
    await connection.select(c.id);
    await settled(await submit("desktop-mock"));
    for (const target of ["desktop-grok-mock", "desktop-mock"]) {
      await connection.action({ type: "harness.select", conversationId: c.id, harnessId: target });
      await settled(await submit(target));
    }
    await waitFor(
      () =>
        connection.getState().interaction?.handoffs.length === 2 &&
        connection.getState().interaction.handoffs.every((h) => h.status === "COMMITTED"),
    );
    const handoffs = connection.getState().interaction.handoffs;
    assert.deepEqual(
      handoffs.map((h) => h.status),
      ["COMMITTED", "COMMITTED"],
    );
    assert.notEqual(handoffs[0].sourceNativeSessionId, handoffs[1].targetNativeSessionId);
    assert.ok(handoffs.every((h) => h.reportText && h.sourceEventEnd >= h.sourceEventStart));
    await settled(await submit("desktop-uncertain"));
    await waitFor(() =>
      connection.getState().interaction?.handoffs.some((h) => h.status === "UNCERTAIN"),
    );
    const uncertain = connection
      .getState()
      .interaction.handoffs.find((h) => h.status === "UNCERTAIN");
    for (const action of ["retry", "confirm", "cancel"])
      await assert.rejects(
        connection.action({
          type: "handoff.action",
          conversationId: c.id,
          input: { handoffId: uncertain.id, action },
        }),
        (e) => e.status === 409,
      );
    const events = (await client.request(`/v1/conversations/${c.id}/events?limit=1000`)).events;
    assert.equal(events.filter((e) => e.kind === "user.message").length, 4);
    const failed = await connection.action({
      type: "conversation.create",
      projectId: project.id,
      title: "Failed fallback",
    });
    const send = async (harnessId) => {
      const d = await connection.action({ type: "draft.load", conversationId: failed.id });
      return connection.action({
        type: "turn.submit",
        conversationId: failed.id,
        revision: d.revision,
        input: { requestId: randomUUID(), harnessId, message: "hello" },
      });
    };
    await connection.select(failed.id);
    await settled(await send("desktop-failed-source"));
    const targetTurn = await send("desktop-mock");
    const getFailed = () =>
      waitFor(async () =>
        (await client.request(`/v1/conversations/${failed.id}/handoffs`)).find(
          (h) => h.status === "FAILED",
        ),
      );
    let h = await getFailed();
    assert.ok(h.fallbackText);
    assert.ok(h.fallbackSources);
    await connection.action({
      type: "handoff.action",
      conversationId: failed.id,
      input: { handoffId: h.id, action: "retry" },
    });
    h = await getFailed();
    await connection.action({
      type: "handoff.action",
      conversationId: failed.id,
      input: { handoffId: h.id, action: "confirm" },
    });
    await settled(targetTurn);
    assert.equal(
      (await client.request(`/v1/conversations/${failed.id}/handoffs`))[0].status,
      "COMMITTED",
    );
    assert.equal(
      (await client.request(`/v1/conversations/${failed.id}/events?limit=1000`)).events.filter(
        (e) => e.kind === "user.message",
      ).length,
      2,
    );
  } finally {
    connection.dispose();
  }
});

test("release readiness refuses active Turns and stale prechecks without stopping the Worker", async () => {
  const c = await client.request(`/v1/projects/${project.id}/conversations`, "POST", {
    title: "Upgrade guard",
  });
  const before = instance();
  const idle = await client.request("/v1/daemon/upgrade-readiness");
  assert.equal(typeof idle.safeToStop, "boolean");
  const turn = await client.request(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: randomUUID(),
    harnessId: "desktop-mock",
    message: "wait",
  });
  await waitFor(async () => (await client.request(`/v1/turns/${turn.id}`)).state === "RUNNING");
  const readiness = await client.request("/v1/daemon/upgrade-readiness");
  assert.equal(readiness.safeToStop, false);
  assert.ok(readiness.blockers.includes("Active Turns"));
  await assert.rejects(cli("daemon", "upgrade-check"));
  await assert.rejects(
    client.request("/v1/daemon/stop", "POST", { cancelActive: false, forUpgrade: true }),
    (e) => e.status === 409,
  );
  assert.equal((await client.health()).instanceId, before.instanceId);
  assert.equal((await client.request(`/v1/turns/${turn.id}`)).state, "RUNNING");
  await client.request(`/v1/turns/${turn.id}/cancel`, "POST", {});
  await waitFor(async () => (await client.request(`/v1/turns/${turn.id}`)).endedAt);
});

test("Desktop new conversations auto-name and shared/worktree workspaces use the selected local branch", async () => {
  // This test owns its backend so it also exercises the normal unnamed creation entry point.
  const connection = new DesktopConnection({ connect: bridge }, 100);
  const i = await bridge();
  const local = new Client(i);
  const root = join(temp, "starting-branch-project");
  mkdirSync(root);
  const git = (...args) => run("git", args, { cwd: root });
  await git("init", "-b", "main");
  writeFileSync(join(root, "branch.txt"), "main\n");
  await git("add", ".");
  await git("-c", "user.name=HHU", "-c", "user.email=test@localhost", "commit", "-m", "main");
  await git("switch", "-c", "feature/start");
  writeFileSync(join(root, "branch.txt"), "feature\n");
  writeFileSync(join(root, "collision.txt"), "tracked on feature\n");
  await git("add", ".");
  await git("-c", "user.name=HHU", "-c", "user.email=test@localhost", "commit", "-m", "feature");
  await git("switch", "main");
  const p = await local.request("/v1/projects", "POST", { rootPath: root });
  try {
    await connection.connect("Ubuntu-test");
    await waitFor(() => connection.getState().status === "connected");
    const branches = await connection.action({ type: "project.branches", projectId: p.id });
    const starter = await connection.action({ type: "new-draft.load" });
    const savedStarter = await connection.action({
      type: "new-draft.save",
      draft: {
        revision: starter.revision,
        text: "离开新建页仍保留的草稿",
        pendingSubmission: null,
      },
    });
    assert.equal(savedStarter.text, "离开新建页仍保留的草稿");
    assert.equal((await local.request("/v1/new-conversation-draft")).text, savedStarter.text);
    await assert.rejects(
      connection.action({
        type: "new-draft.save",
        draft: { revision: starter.revision, text: "过期窗口", pendingSubmission: null },
      }),
      (e) => e.status === 409,
    );
    assert.equal((await connection.action({ type: "new-draft.load" })).text, savedStarter.text);
    assert.deepEqual(branches, {
      isGit: true,
      hasCommits: true,
      currentBranch: "main",
      branches: ["feature/start", "main"],
    });
    const created = await connection.action({ type: "conversation.create", projectId: p.id });
    assert.equal(created.title, "New conversation");
    assert.equal((await local.request(`/v1/conversations/${created.id}/sessions`)).length, 0);
    await local.request("/v1/harness-profiles", "POST", {
      id: "starter-mock",
      name: "Starter mock",
      command: process.execPath,
      args: [resolve("tests/fixtures/mock-acp/server.mjs")],
      envOverrides: {},
    });
    const draft = await connection.action({ type: "draft.load", conversationId: created.id });
    const turn = await connection.action({
      type: "turn.submit",
      conversationId: created.id,
      revision: draft.revision,
      input: { requestId: randomUUID(), harnessId: "starter-mock", message: "自动命名 首条任务" },
    });
    await waitFor(async () => (await local.request(`/v1/turns/${turn.id}`)).endedAt);
    assert.equal(
      (await local.request(`/v1/conversations/${created.id}`)).title,
      "自动命名 首条任务",
    );
    const work = await connection.action({
      type: "conversation.create",
      projectId: p.id,
      workspaceMode: "worktree",
      baseBranch: "feature/start",
    });
    assert.equal(readFileSync(join(work.workspacePath, "branch.txt"), "utf8"), "feature\n");
    assert.equal(readFileSync(join(root, "branch.txt"), "utf8"), "main\n");
    assert.equal((await git("branch", "--show-current")).stdout.trim(), "main");
    const count = (await connection.action({ type: "worktrees.list" })).length;
    for (const baseBranch of ["missing", "main~1", "main@{0}", "--help"]) {
      await assert.rejects(
        connection.action({
          type: "conversation.create",
          projectId: p.id,
          workspaceMode: "worktree",
          baseBranch,
        }),
      );
    }
    assert.equal((await connection.action({ type: "worktrees.list" })).length, count);
    const sharedRequest = {
      type: "conversation.create",
      projectId: p.id,
      workspaceMode: "shared",
      baseBranch: "feature/start",
    };
    const beforeShared = (await local.request(`/v1/projects/${p.id}/conversations`)).length;
    for (const baseBranch of ["missing", "main~1", "main@{0}", "--help"])
      await assert.rejects(
        connection.action({ ...sharedRequest, baseBranch }),
        (e) => e.status === 409,
      );
    assert.equal((await git("branch", "--show-current")).stdout.trim(), "main");
    writeFileSync(join(root, "branch.txt"), "unsaved work\n");
    await assert.rejects(connection.action(sharedRequest), (e) => e.status === 409);
    assert.equal(readFileSync(join(root, "branch.txt"), "utf8"), "unsaved work\n");
    for (const flag of ["assume-unchanged", "skip-worktree"]) {
      await git("update-index", `--${flag}`, "branch.txt");
      await assert.rejects(connection.action(sharedRequest), (e) => e.status === 409);
      assert.equal(readFileSync(join(root, "branch.txt"), "utf8"), "unsaved work\n");
      await git("update-index", `--no-${flag}`, "branch.txt");
    }
    writeFileSync(join(root, "branch.txt"), "main\n");
    // Both untracked and ignored collisions must survive a failed switch.
    writeFileSync(join(root, "collision.txt"), "keep me\n");
    await assert.rejects(connection.action(sharedRequest), (e) => e.status === 409);
    writeFileSync(join(root, ".git", "info", "exclude"), "collision.txt\n");
    await assert.rejects(connection.action(sharedRequest), (e) => e.status === 409);
    assert.equal(readFileSync(join(root, "collision.txt"), "utf8"), "keep me\n");
    unlinkSync(join(root, "collision.txt"));
    assert.equal((await local.request(`/v1/projects/${p.id}/conversations`)).length, beforeShared);
    const shared = await connection.action(sharedRequest);
    assert.equal(shared.workspaceMode, "shared");
    assert.equal(shared.workspacePath, root);
    assert.equal(shared.worktreeId, null);
    assert.equal(readFileSync(join(root, "branch.txt"), "utf8"), "feature\n");
    assert.equal((await git("branch", "--show-current")).stdout.trim(), "feature/start");
    assert.equal((await connection.action({ type: "worktrees.list" })).length, count);
    const running = await local.request(`/v1/conversations/${shared.id}/turns`, "POST", {
      requestId: randomUUID(),
      harnessId: "desktop-mock",
      message: "slow",
    });
    await assert.rejects(
      connection.action({ ...sharedRequest, baseBranch: "main" }),
      (e) => e.status === 409,
    );
    // Keeping the current branch is safe even during a parallel Turn.
    await connection.action(sharedRequest);
    assert.equal((await git("branch", "--show-current")).stdout.trim(), "feature/start");
    await local.request(`/v1/turns/${running.id}/cancel`, "POST", {});
    await waitFor(async () => (await local.request(`/v1/turns/${running.id}`)).endedAt);
    await connection.action({ ...sharedRequest, baseBranch: "main" });
    // A branch already checked out in another worktree remains protected by Git.
    const occupied = join(temp, "occupied-branch");
    await git("worktree", "add", occupied, "feature/start");
    await assert.rejects(connection.action(sharedRequest), (e) => e.status === 409);
    assert.equal((await git("branch", "--show-current")).stdout.trim(), "main");
    const standalone = await connection.action({
      type: "conversation.standalone",
      workspacePath: root,
    });
    assert.equal(standalone.title, "New conversation");
    await git("checkout", "--detach", "HEAD");
    assert.equal(
      (await connection.action({ type: "project.branches", projectId: p.id })).currentBranch,
      null,
    );
    await connection.action({ ...sharedRequest, baseBranch: "main" });
    assert.equal((await git("branch", "--show-current")).stdout.trim(), "main");
    const unborn = join(temp, "unborn-project");
    mkdirSync(unborn);
    await run("git", ["init", "-b", "new"], { cwd: unborn });
    const empty = await local.request("/v1/projects", "POST", { rootPath: unborn });
    assert.deepEqual(await connection.action({ type: "project.branches", projectId: empty.id }), {
      isGit: true,
      hasCommits: false,
      currentBranch: "new",
      branches: [],
    });
    const nonGit = join(temp, "non-git-project");
    mkdirSync(nonGit);
    const plain = await local.request("/v1/projects", "POST", { rootPath: nonGit });
    assert.equal(
      (await connection.action({ type: "project.branches", projectId: plain.id })).isGit,
      false,
    );
  } finally {
    connection.dispose();
  }
});
