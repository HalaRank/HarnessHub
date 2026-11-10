// Explicit isolated WSL + actual NSIS lifecycle acceptance. Never uses the default database.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "../packages/shared/src/client";
import { VERSION } from "../packages/shared/src/index";
import { paths } from "../packages/shared/src/paths";

if (process.platform !== "linux" || !process.env.WSL_DISTRO_NAME)
  throw new Error("Run from WSL2 with Windows interop and a built release directory argument");
const release = resolve(process.argv[2] ?? `dist/desktop/releases/${VERSION}-unsigned`);
const root = mkdtempSync(join(tmpdir(), "hhu-release-backend-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_DATA_HOME: join(root, "data"),
};
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [resolve("dist/cli/hhu.js"), ...args], {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
const p = paths(env);
const evidence: Record<string, unknown> = { root, passed: false };
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const until = async (fn: () => Promise<unknown>) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test backend did not reach expected state");
};
let client: Client | undefined;
let turnId: string | undefined;
try {
  cli("daemon", "start");
  const instance = JSON.parse(readFileSync(p.instance, "utf8"));
  client = new Client(instance);
  const api = client;
  const repo = join(root, "project");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  writeFileSync(join(repo, "source.txt"), "preserve source\n");
  git("add", ".");
  git("-c", "user.name=HHU Test", "-c", "user.email=test@localhost", "commit", "-m", "fixture");
  const fakeNative = join(root, "native-config-sentinel");
  writeFileSync(fakeNative, "isolated fixture, not user native credentials\n", { mode: 0o600 });
  const project = await api.request<{ id: string }>("/v1/projects", "POST", { rootPath: repo });
  const c = await api.request<{ id: string; workspacePath: string }>(
    `/v1/projects/${project.id}/conversations`,
    "POST",
    { title: "Release retention", workspaceMode: "worktree" },
  );
  await api.request("/v1/harness-profiles", "POST", {
    id: "release-mock",
    name: "Release mock",
    command:
      process.env.HARNESSHUB_TEST_NODE ??
      execFileSync("which", ["node"], { encoding: "utf8" }).trim(),
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
  });
  const turn = await api.request<{ id: string }>(`/v1/conversations/${c.id}/turns`, "POST", {
    requestId: crypto.randomUUID(),
    harnessId: "release-mock",
    message: "wait",
  });
  turnId = turn.id;
  await until(async () =>
    (
      await api.request<{ events: { kind: string }[] }>(`/v1/conversations/${c.id}/events`)
    ).events.some((e) => e.kind === "agent_message_chunk"),
  );
  // While awaiting normal ACP cancellation this fixture emits no further events.
  const files = [p.db, join(repo, "source.txt"), join(c.workspacePath, "source.txt"), fakeNative];
  if (existsSync(`${p.db}-wal`)) files.push(`${p.db}-wal`);
  const before = Object.fromEntries(files.map((file) => [file, hash(file)]));
  evidence.instanceId = instance.instanceId;
  evidence.before = before;
  const windows = (path: string) =>
    execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim();
  const ps = spawn(
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      windows(resolve("scripts/verify-windows-installer.ps1")),
      "-ReleaseDirectory",
      windows(release),
      ...(process.argv[3] ? ["-PreviousReleaseDirectory", windows(resolve(process.argv[3]))] : []),
    ],
    { stdio: "inherit" },
  );
  const exit = await new Promise<number>((resolve, reject) => {
    ps.once("error", reject);
    ps.once("exit", (code) => resolve(code ?? 1));
  });
  if (exit !== 0) throw new Error(`Windows installer acceptance failed (${exit})`);
  const after = Object.fromEntries(files.map((file) => [file, hash(file)]));
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Installation lifecycle changed isolated WSL data");
  if ((await api.health()).instanceId !== instance.instanceId)
    throw new Error("Daemon replaced during Windows lifecycle");
  if ((await api.request<{ endedAt: number | null }>(`/v1/turns/${turn.id}`)).endedAt)
    throw new Error("Active Agent was stopped by Windows lifecycle");
  evidence.after = after;
  evidence.activeAgentSurvived = true;
  evidence.conversation = await api.request(`/v1/conversations/${c.id}`);
  evidence.passed = true;
} finally {
  if (client && turnId) {
    await client.request(`/v1/turns/${turnId}/cancel`, "POST").catch(() => {});
    await until(
      async () =>
        (await client?.request<{ endedAt: number | null }>(`/v1/turns/${turnId}`))?.endedAt,
    ).catch(() => {});
  }
  try {
    cli("daemon", "stop");
  } catch {
    evidence.cleanup = "Unconfirmed; inspect isolated test root, no force used";
  }
  writeFileSync(join(root, "release-backend-evidence.json"), JSON.stringify(evidence, null, 2));
  copyFileSync(
    join(root, "release-backend-evidence.json"),
    resolve("docs/acceptance/evidence/desktop-phase-4/release-backend-evidence.json"),
  );
  console.log(`WSL release evidence: ${root}`);
}
