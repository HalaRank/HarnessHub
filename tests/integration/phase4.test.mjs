import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import { Client } from "../../dist/client/client.js";

const temp = mkdtempSync(join(tmpdir(), "hhu-phase4-"));
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
  });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
cli("daemon", "start");
let client = new Client(
  JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json"))),
);
const api = (path, method, body) => client.request(path, method, body);
after(() => {
  cli("daemon", "stop");
  console.log(`Phase-4 integration evidence: ${temp}`);
});
const root = join(temp, "real git 世界");
mkdirSync(root);
git(root, "init", "-b", "main");
const write = (path, text) => writeFileSync(join(root, path), text);
write("tracked.ts", "export const value = 1;\n");
write("rename before.txt", "rename me\n");
write("delete.txt", "keep history\n");
git(root, "add", ".");
git(
  root,
  "-c",
  "user.name=HarnessHub Test",
  "-c",
  "user.email=test@localhost",
  "commit",
  "-m",
  "fixture",
);
const p = await api("/v1/projects", "POST", { rootPath: root });
const c = await api(`/v1/projects/${p.id}/conversations`, "POST", { title: "Git state" });
const url = `/v1/conversations/${c.id}/changes`;

test("Changes returns actual staged, unstaged, untracked, rename, delete and binary data", async () => {
  assert.deepEqual((await api(url)).files, []);
  write("tracked.ts", "export const value = 2;\n");
  git(root, "add", "tracked.ts");
  write("tracked.ts", "export const value = 3;\n");
  renameSync(join(root, "rename before.txt"), join(root, "rename after.txt"));
  git(root, "add", "--", "rename before.txt", "rename after.txt");
  unlinkSync(join(root, "delete.txt"));
  write("-option 世界\nfile.txt", "native file\n  exact indentation\n");
  write(":(glob)*.txt", "literal pathspec\n");
  write("binary.dat", Buffer.from([0, 1, 2, 3]));
  const state = await api(url);
  assert.equal(state.repository, root);
  assert.match(state.notice, /not attributed/);
  assert.equal(state.files.find((f) => f.path === "tracked.ts").index, "M");
  assert.equal(state.files.find((f) => f.path === "tracked.ts").worktree, "M");
  assert.equal(
    state.files.find((f) => f.path === "rename after.txt").previousPath,
    "rename before.txt",
  );
  assert.equal(state.files.find((f) => f.path === "delete.txt").worktree, "D");
  for (const file of state.files) {
    const diff = await api(`${url}?path=${encodeURIComponent(file.path)}`);
    if (file.path === "tracked.ts") {
      assert.equal(
        diff.staged,
        git(
          root,
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--cached",
          "--",
          file.path,
        ),
      );
      assert.equal(
        diff.unstaged,
        git(root, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path),
      );
      assert.match(diff.staged, /value = 2/);
      assert.match(diff.unstaged, /value = 3/);
    }
    if (file.index === "?")
      assert.ok(
        diff.untracked.includes(
          file.path === "binary.dat"
            ? "Binary files"
            : file.path === ":(glob)*.txt"
              ? "literal pathspec"
              : "exact indentation",
        ),
      );
  }
  assert.equal(readFileSync(join(root, "tracked.ts"), "utf8"), "export const value = 3;\n");
});

test("Changes uses bound workspace, handles non-repositories and rejects arbitrary paths", async () => {
  for (const path of ["../outside", "/etc/passwd", "--output=/tmp/hhu-no-write", ":(glob)**"])
    await assert.rejects(
      api(`${url}?path=${encodeURIComponent(path)}`),
      (error) => error.status === 404,
    );
  const other = join(temp, "not-git");
  mkdirSync(other);
  const q = await api("/v1/projects", "POST", { rootPath: other });
  const d = await api(`/v1/projects/${q.id}/conversations`, "POST", { title: "non Git" });
  assert.equal((await api(`/v1/conversations/${d.id}/changes`)).repository, null);
  const inside = join(root, "inside");
  mkdirSync(inside);
  write("inside/child.txt", "child\n");
  const sub = await api("/v1/projects", "POST", { rootPath: inside });
  const e = await api(`/v1/projects/${sub.id}/conversations`, "POST", { title: "subdirectory" });
  const state = await api(`/v1/conversations/${e.id}/changes`);
  assert.equal(state.workspace, inside);
  assert.ok(state.files.every((f) => f.path.startsWith("inside/")));
  await assert.rejects(
    api(`/v1/conversations/${e.id}/changes?path=tracked.ts`),
    (error) => error.status === 404,
  );
  symlinkSync("/etc/passwd", join(root, "symlink.txt"));
  const link = await api(`${url}?path=symlink.txt`);
  assert.match(link.untracked, /\+\/etc\/passwd/);
  assert.ok(!link.untracked.includes("root:x:"));
});

test("oversized Git output is an explicit error and does not silently truncate", async () => {
  write("large.txt", "x".repeat(2200000));
  await assert.rejects(api(`${url}?path=large.txt`), /2 MiB/);
  unlinkSync(join(root, "large.txt"));
});

test("sidebar and validated shortcut preferences persist across daemon restart in private SQLite", async () => {
  const shortcuts = { palette: "ctrl+o", sidebar: "ctrl+s", newline: "meta+return" };
  await api("/v1/preferences", "PATCH", {
    lastConversationId: c.id,
    showSidebar: false,
    shortcuts,
  });
  for (const invalid of [
    { palette: "return" },
    { palette: "ctrl+b" },
    { newline: "ctrl+c" },
    { invalid: "ctrl+o" },
  ])
    await assert.rejects(
      api("/v1/preferences", "PATCH", { shortcuts: invalid }),
      (error) => error.status === 400,
    );
  cli("daemon", "stop");
  cli("daemon", "start");
  client = new Client(
    JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json"))),
  );
  const result = await api("/v1/preferences");
  assert.equal(result.lastConversationId, c.id);
  assert.equal(result.showSidebar, false);
  assert.deepEqual(result.shortcuts, shortcuts);
  const db = new Database(join(env.XDG_DATA_HOME, "harnesshub/harnesshub.db"), { readonly: true });
  assert.equal(db.pragma("user_version", { simple: true }), 6);
  db.close();
  assert.ok(readdirSync(join(env.XDG_DATA_HOME, "harnesshub")).includes("harnesshub.db"));
});

test("Bun and Node clients reach only the local Daemon even with proxy environment variables", async () => {
  const { createServer } = await import("node:http");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  let hits = 0;
  const proxy = createServer((_req, res) => {
    hits++;
    res.writeHead(502);
    res.end("proxy must not receive local credentials");
  });
  await new Promise((resolveListen) => proxy.listen(0, "127.0.0.1", resolveListen));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const script = `import {Client} from ${JSON.stringify(new URL("../../dist/client/client.js", import.meta.url).href)}; import {readFileSync} from 'node:fs'; const c = new Client(JSON.parse(readFileSync(process.argv[1]))); console.log((await c.health()).version);`;
    for (const executable of [process.execPath, process.env.HARNESSHUB_BUN]) {
      const result = await promisify(execFile)(
        executable,
        ["--input-type=module", "-e", script, join(env.XDG_STATE_HOME, "harnesshub/instance.json")],
        {
          env: {
            ...env,
            HTTP_PROXY: url,
            HTTPS_PROXY: url,
            ALL_PROXY: url,
            http_proxy: url,
            https_proxy: url,
            NO_PROXY: "",
            no_proxy: "",
            NODE_USE_ENV_PROXY: "1",
          },
          timeout: 10000,
        },
      );
      assert.equal(result.stdout.trim(), "0.6.0");
    }
    assert.equal(hits, 0);
  } finally {
    await new Promise((resolveClose) => proxy.close(resolveClose));
  }
});

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for refinement state");
}
const dbFile = join(env.XDG_DATA_HOME, "harnesshub/harnesshub.db");

test("archive/restore survives restart; confirmed deletion removes app relations and preserves workspace", async () => {
  await api("/v1/harness-profiles", "POST", {
    id: "refinement",
    name: "Refinement Mock",
    command: "node",
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: { HHU_MOCK_CLOSE_DELAY: "300" },
  });
  const c = await api(`/v1/projects/${p.id}/conversations`, "POST", { title: "Archive fixture" });
  const path = `/v1/conversations/${c.id}`;
  const turn = await api(`${path}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "refinement",
    message: "stream",
  });
  await until(async () => (await api(`/v1/turns/${turn.id}`)).endedAt !== null);
  await api(`${path}/draft`, "PUT", {
    text: "retained draft",
    revision: 0,
    pendingSubmission: null,
  });
  await api("/v1/preferences", "PATCH", { lastConversationId: c.id });
  const before = await api(`${path}/events?limit=1000`);
  const archived = await api(path, "PATCH", { archived: true });
  assert.equal(typeof archived.archivedAt, "number");
  assert.deepEqual((await api(`${path}/events?limit=1000`)).events, before.events);
  assert.equal((await api(`${path}/draft`)).text, "retained draft");
  // A second client reads canonical state; metadata carries the same archive invalidation.
  assert.equal(
    (await new Client(client.instance).request("/v1/snapshot")).conversations.find(
      (v) => v.id === c.id,
    ).archivedAt,
    archived.archivedAt,
  );
  assert.equal((await api(path, "PATCH", { archived: false })).archivedAt, null);
  await api(path, "PATCH", { archived: true });
  cli("daemon", "stop");
  cli("daemon", "start");
  client = new Client(
    JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json"))),
  );
  assert.ok((await api(path)).archivedAt);
  await api(path, "PATCH", { archived: false });
  await api(`${path}/sessions`, "POST", { harnessId: "refinement" });
  await assert.rejects(api(path, "DELETE", {}), (e) => e.status === 400);
  const deleting = api(path, "DELETE", { confirmed: true });
  await new Promise((r) => setTimeout(r, 60));
  await assert.rejects(
    api(`${path}/turns`, "POST", {
      requestId: crypto.randomUUID(),
      harnessId: "refinement",
      message: "must not run",
    }),
    (e) => e.status === 409,
  );
  assert.equal((await deleting).projectFilesDeleted, false);
  await assert.rejects(api(path), (e) => e.status === 404);
  assert.equal((await api("/v1/preferences")).lastConversationId, null);
  const db = new Database(dbFile, { readonly: true });
  for (const table of [
    "native_sessions",
    "turns",
    "conversation_events",
    "approvals",
    "conversation_drafts",
  ])
    assert.equal(
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE conversation_id = ?`).get(c.id).n,
      0,
    );
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.ok(
    db
      .prepare(
        "SELECT * FROM metadata_changes WHERE type = 'conversation.deleted' AND entity_id = ?",
      )
      .get(c.id),
  );
  db.close();
  assert.ok(readFileSync(join(root, "tracked.ts"), "utf8").includes("value"));
  assert.ok(readdirSync(root).includes(".git"));
});

test("running, pending approval and UNCERTAIN conversations cannot be deleted or bypassed through project deletion", async () => {
  for (const message of ["wait", "permission", "crash"]) {
    const c = await api(`/v1/projects/${p.id}/conversations`, "POST", { title: message });
    const path = `/v1/conversations/${c.id}`;
    const turn = await api(`${path}/turns`, "POST", {
      requestId: crypto.randomUUID(),
      harnessId: "refinement",
      message,
    });
    await until(async () =>
      message === "permission"
        ? (await api(`${path}/approvals`)).length > 0
        : message === "crash"
          ? (await api(`/v1/turns/${turn.id}`)).endedAt !== null
          : (await api(`${path}/events?limit=1000`)).events.some(
              (e) => e.kind === "agent_message_chunk",
            ),
    );
    await assert.rejects(api(path, "DELETE", { confirmed: true }), (e) => e.status === 409);
    await assert.rejects(api(`/v1/projects/${p.id}`, "DELETE"), (e) => e.status === 409);
    // Archiving a running task only changes list visibility, never cancels its Turn.
    await api(path, "PATCH", { archived: true });
    if (message !== "crash") {
      assert.equal((await api(`/v1/turns/${turn.id}`)).endedAt, null);
      await api(`/v1/turns/${turn.id}/cancel`, "POST");
      await until(async () => (await api(`/v1/turns/${turn.id}`)).endedAt !== null);
      await api(path, "DELETE", { confirmed: true });
    } else {
      assert.equal((await api(path)).runtimeStatus, "UNCERTAIN");
    }
  }
});

test("built TUI handles raw Ctrl+C and OS SIGINT; exiting leaves the running Worker intact", async () => {
  const c = await api(`/v1/projects/${p.id}/conversations`, "POST", { title: "PTY interrupt" });
  await api("/v1/preferences", "PATCH", { lastConversationId: c.id, shortcuts: {} });
  const turn = await api(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "refinement",
    message: "wait",
  });
  await until(async () =>
    (await api(`/v1/conversations/${c.id}/events?limit=1000`)).events.some(
      (e) => e.kind === "agent_message_chunk",
    ),
  );
  const sessions = await api(`/v1/conversations/${c.id}/sessions`);
  try {
    const output = await new Promise((ok, fail) =>
      execFile(
        "python3",
        [
          resolve("tests/e2e/refinement-terminal.py"),
          process.env.HARNESSHUB_BUN,
          resolve("dist/cli/hhu.js"),
          c.id,
        ],
        { env, timeout: 45000, encoding: "utf8" },
        (error, stdout) => (error ? fail(error) : ok(stdout)),
      ),
    );
    assert.equal(JSON.parse(output.trim()).sigintClears, true);
    assert.equal((await api(`/v1/turns/${turn.id}`)).endedAt, null);
    assert.deepEqual(await api(`/v1/conversations/${c.id}/sessions`), sessions);
    assert.equal(
      (await api(`/v1/conversations/${c.id}/events?limit=1000`)).events.some(
        (e) => e.raw?.method === "session/cancel",
      ),
      false,
    );
  } finally {
    await api(`/v1/turns/${turn.id}/cancel`, "POST");
    await until(async () => (await api(`/v1/turns/${turn.id}`)).endedAt !== null);
    await api(`/v1/conversations/${c.id}/session/stop`, "POST", {});
  }
});
