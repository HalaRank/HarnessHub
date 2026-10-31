import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  assert.equal(db.pragma("user_version", { simple: true }), 4);
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
      assert.equal(result.stdout.trim(), "0.4.0");
    }
    assert.equal(hits, 0);
  } finally {
    await new Promise((resolveClose) => proxy.close(resolveClose));
  }
});
