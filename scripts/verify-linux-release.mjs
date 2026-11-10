import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const output = resolve(process.argv[2] ?? "");
const manifest = JSON.parse(readFileSync(join(output, "release-manifest.json"), "utf8"));
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "hhu-release-verification-"));
const home = join(temp, "home with spaces and 'quote");
mkdirSync(home);
const systems = join(temp, "system-bin");
mkdirSync(systems);
// No host Node, Bun, npm or ACP executables are visible to the installed program.
for (const name of [
  "sh",
  "dirname",
  "uname",
  "getconf",
  "tar",
  "gzip",
  "sha256sum",
  "awk",
  "mktemp",
  "flock",
  "git",
  "cp",
  "rm",
  "basename",
  "true",
])
  symlinkSync(`/usr/bin/${name}`, join(systems, name));
const env = {
  HOME: home,
  PATH: systems,
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  TMPDIR: temp,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"),
};
const runFile = promisify(execFile);
const run = (file, args, overrides = {}) =>
  runFile(file, args, {
    env,
    cwd: home,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    ...overrides,
  });
const cliPath = join(home, ".local/bin/hhu");
const cli = (...args) => run(cliPath, args);
const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`PASS ${name}`);
}
const instanceFile = join(env.XDG_STATE_HOME, "harnesshub/instance.json");
const instance = () => JSON.parse(readFileSync(instanceFile, "utf8"));
const api = async (path, method = "GET", body) => {
  const info = instance();
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
};
const waitFor = async (fn) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Release smoke timeout");
};
const name = `harnesshub-${manifest.version}-linux-x64`;
const archive = join(output, `${name}.tar.gz`);
const installer = join(output, "install.sh");
const extracted = join(temp, name);
let installed;
try {
  await check("download checksum rejection leaves installation untouched", async () => {
    const corrupt = join(temp, "corrupt");
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, `${name}.tar.gz`), "not an archive");
    copyFileSync(join(output, "SHA256SUMS.txt"), join(corrupt, "SHA256SUMS.txt"));
    await assert.rejects(
      run("/bin/sh", [installer, "--archive", join(corrupt, `${name}.tar.gz`)]),
      /checksum mismatch/,
    );
    assert.equal(existsSync(cliPath), false);
  });
  await check("offline installation with no system Node/Bun or source dependency", async () => {
    await run("/bin/sh", [installer, "--archive", archive]);
    const releases = join(home, ".local/lib/harnesshub/releases");
    installed = join(releases, readdirSync(releases)[0]);
    assert.match(
      (await cli("--version")).stdout,
      new RegExp(manifest.version.replaceAll(".", "\\.")),
    );
    const doctor = (await cli("doctor")).stdout;
    for (const required of ["OK Bun", "OK Node LTS", "OK SQLite native / Node", "OK OpenTUI"])
      assert.ok(doctor.includes(required), doctor);
    assert.ok(doctor.includes(installed), doctor);
    assert.equal(readFileSync(cliPath, "utf8").includes(root), false);
    assert.equal(existsSync(join(installed, "apps")), false);
    assert.equal(existsSync(join(installed, "node_modules/electron")), false);
  });
  await check("payload tampering fails before launcher replacement", async () => {
    await run("/usr/bin/tar", ["-xzf", archive, "-C", temp]);
    const file = join(extracted, "README.md");
    const original = readFileSync(file);
    const launcher = readFileSync(cliPath);
    writeFileSync(file, "tampered");
    try {
      await assert.rejects(
        run(join(extracted, "runtime/node"), [join(extracted, "lib/install.js")]),
        /integrity check failed/,
      );
      assert.deepEqual(readFileSync(cliPath), launcher);
    } finally {
      writeFileSync(file, original);
    }
  });
  await check(
    "bundled Codex and Claude adapters perform real ACP initialize without login or prompts",
    async () => {
      for (const name of ["codex-acp", "claude-agent-acp"]) {
        const { stdout } = await run(
          join(installed, "runtime/node"),
          [
            "--input-type=module",
            "-e",
            `console.log(new URL('./index.js', import.meta.resolve('@agentclientprotocol/${name}')).pathname)`,
          ],
          { cwd: installed },
        );
        // URL paths can contain escaped spaces and quotes in the isolated installation prefix.
        const entry = decodeURIComponent(stdout.trim());
        const child = spawn(join(installed, "runtime/node"), [entry], {
          cwd: home,
          env: { ...env, PATH: `${join(installed, "runtime")}:${systems}` },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let pending = "";
        child.stderr.resume();
        try {
          const initialized = new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`${name} initialize timed out`)),
              20000,
            );
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once("exit", (code) => {
              clearTimeout(timer);
              reject(new Error(`${name} exited: ${code}`));
            });
            child.stdout.on("data", (data) => {
              pending += data.toString();
              while (pending.includes("\n")) {
                const end = pending.indexOf("\n");
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                try {
                  const response = JSON.parse(line);
                  if (response.id === 1) {
                    clearTimeout(timer);
                    if (response.error) reject(new Error(`${name} rejected initialize`));
                    else resolve(response.result);
                  }
                } catch (error) {
                  clearTimeout(timer);
                  reject(error);
                }
              }
            });
          });
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: 1,
                clientCapabilities: {},
                clientInfo: { name: "HarnessHub-release-check", version: "1" },
              },
            })}\n`,
          );
          assert.equal((await initialized).protocolVersion, 1);
        } finally {
          child.stdin.end();
          if (child.exitCode === null) {
            const closed = new Promise((resolve) => child.once("close", resolve));
            child.kill("SIGTERM"); // Only this verifier's own prompt-free adapter process.
            await closed;
          }
        }
      }
    },
  );
  await check("a held daemon lock blocks installation even without instance metadata", async () => {
    assert.equal(existsSync(instanceFile), false);
    const holder = spawn(
      "/usr/bin/flock",
      [
        "--no-fork",
        "--nonblock",
        join(env.XDG_STATE_HOME, "harnesshub/daemon.lock"),
        join(installed, "runtime/node"),
        "-e",
        "console.log('locked'); setInterval(() => {}, 1000)",
      ],
      { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] },
    );
    holder.stderr.resume();
    try {
      await new Promise((resolve, reject) => {
        holder.once("error", reject);
        holder.once("exit", (code) => reject(new Error(`Lock fixture exited: ${code}`)));
        holder.stdout.once("data", resolve);
      });
      const launcher = readFileSync(cliPath);
      await assert.rejects(
        run(join(extracted, "runtime/node"), [join(extracted, "lib/install.js")]),
        /Stop the running HarnessHub Daemon/,
      );
      assert.deepEqual(readFileSync(cliPath), launcher);
    } finally {
      const closed = new Promise((resolve) => holder.once("close", resolve));
      holder.kill("SIGTERM");
      await closed;
    }
  });
  await check(
    "Daemon and Desktop Bridge use bundled Node and preserve instance identity",
    async () => {
      await cli("daemon", "start");
      const health = await api("/v1/health");
      assert.equal(health.version, manifest.version);
      const { stdout } = await run(join(home, ".local/lib/harnesshub/desktop-bridge"), [
        manifest.version,
        String(manifest.protocolVersion),
      ]);
      assert.equal(JSON.parse(stdout).instance.instanceId, instance().instanceId);
      assert.equal(
        await (await import("node:fs/promises")).readlink(`/proc/${instance().pid}/exe`),
        join(installed, "runtime/node"),
      );
    },
  );
  await check("running Daemon blocks install without touching launchers or SQLite", async () => {
    const before = readFileSync(cliPath);
    const id = instance().instanceId;
    await assert.rejects(
      run(join(extracted, "runtime/node"), [join(extracted, "lib/install.js")]),
      /Stop the running HarnessHub Daemon/,
    );
    assert.deepEqual(readFileSync(cliPath), before);
    assert.equal((await api("/v1/health")).instanceId, id);
  });
  let conversation;
  await check(
    "packaged ACP SDK handles workspace, permission, cancellation and deduplication",
    async () => {
      // Copy fixture outside the checkout; resolve SDK from the installed production graph.
      const fixture = join(temp, "mock-acp");
      mkdirSync(fixture);
      copyFileSync(join(root, "tests/fixtures/mock-acp/server.mjs"), join(fixture, "server.mjs"));
      symlinkSync(join(installed, "node_modules"), join(fixture, "node_modules"));
      await api("/v1/harness-profiles", "POST", {
        id: "release-mock",
        name: "Release mock",
        command: join(installed, "runtime/node"),
        args: [join(fixture, "server.mjs")],
        envOverrides: {},
      });
      const project = await api("/v1/projects", "POST", {
        name: "Release workspace",
        rootPath: fixture,
      });
      conversation = await api(`/v1/projects/${project.id}/conversations`, "POST", {
        title: "Release history",
      });
      const prompt = async (message, requestId = randomUUID()) =>
        api(`/v1/conversations/${conversation.id}/turns`, "POST", {
          harnessId: "release-mock",
          requestId,
          message,
        });
      const permission = await prompt("permission");
      const approvals = await waitFor(async () => {
        const list = await api(`/v1/conversations/${conversation.id}/approvals`);
        return list.length && list;
      });
      assert.equal((await api(`/v1/turns/${permission.id}`)).endedAt, null);
      const approval = approvals[0];
      await api(`/v1/approvals/${approval.id}/decision`, "POST", {
        optionId: approval.request.options.find((option) => option.kind === "reject_once").optionId,
      });
      await waitFor(async () => (await api(`/v1/turns/${permission.id}`)).endedAt);
      const requestId = randomUUID();
      const waiting = await prompt("wait", requestId);
      assert.equal((await prompt("wait", requestId)).id, waiting.id);
      await waitFor(async () => (await api(`/v1/turns/${waiting.id}`)).state === "RUNNING");
      await api(`/v1/turns/${waiting.id}/cancel`, "POST");
      await waitFor(async () => (await api(`/v1/turns/${waiting.id}`)).endedAt);
      assert.equal((await api(`/v1/turns/${waiting.id}`)).state, "CANCELLED");
      assert.equal(conversation.workspacePath, fixture);
    },
  );
  await check(
    "installed TUI opens in a real Linux PTY and exits without stopping Daemon",
    async () => {
      const id = instance().instanceId;
      const script = join(temp, "release_terminal.py");
      copyFileSync(join(root, "scripts/verify-linux-release-pty.py"), script);
      await run("/usr/bin/python3", [script, cliPath], { timeout: 30000 });
      assert.equal((await api("/v1/health")).instanceId, id);
    },
  );
  await cli("daemon", "stop");
  await check("unrelated and dangling symlink launchers are never overwritten", async () => {
    const saved = `${cliPath}.saved`;
    renameSync(cliPath, saved);
    try {
      writeFileSync(cliPath, "#!/bin/sh\n# unrelated command\n");
      // Use the original archive: installed releases also contain receipts/backups.
      await assert.rejects(
        run(join(extracted, "runtime/node"), [join(extracted, "lib/install.js")]),
        /unrelated executable/,
      );
      assert.match(readFileSync(cliPath, "utf8"), /unrelated command/);
      unlinkSync(cliPath);
      symlinkSync(join(temp, "missing"), cliPath);
      await assert.rejects(
        run(join(extracted, "runtime/node"), [join(extracted, "lib/install.js")]),
        /unrelated executable/,
      );
      unlinkSync(cliPath);
    } finally {
      renameSync(saved, cliPath);
    }
  });
  await check(
    "reinstallation preserves old release, exact launcher backups and conversation history",
    async () => {
      const oldCli = readFileSync(cliPath);
      const oldBridge = readFileSync(join(home, ".local/lib/harnesshub/desktop-bridge"));
      await run("/bin/sh", [installer, "--archive", archive]);
      const releases = join(home, ".local/lib/harnesshub/releases");
      const next = readdirSync(releases)
        .map((entry) => join(releases, entry))
        .find((entry) => entry !== installed);
      assert.ok(next);
      assert.deepEqual(readFileSync(join(next, "previous-launchers/hhu")), oldCli);
      assert.deepEqual(readFileSync(join(next, "previous-launchers/desktop-bridge")), oldBridge);
      assert.ok(existsSync(join(installed, "runtime/node")));
      await cli("daemon", "start");
      assert.equal((await api(`/v1/conversations/${conversation.id}`)).title, "Release history");
    },
  );
  console.log(`Verified ${results.length} release checks. Evidence: ${temp}`);
} finally {
  if (existsSync(instanceFile))
    await cli("daemon", "stop").catch((error) =>
      console.error(`Test Daemon cleanup needs inspection: ${error.message}`),
    );
  writeFileSync(
    join(temp, "evidence.json"),
    JSON.stringify(
      {
        version: manifest.version,
        archive,
        results,
        checksPassed: results.length,
        home,
      },
      null,
      2,
    ),
  );
}
