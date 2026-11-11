// Run explicitly from WSL after desktop:package. Uses only isolated HOME/XDG/Windows userData.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeWsl, parseDistributions } from "../apps/desktop/src/main/wsl";
import { Client } from "../packages/shared/src/client";
import { VERSION } from "../packages/shared/src/index";
import { paths } from "../packages/shared/src/paths";
import { bridgeLauncher } from "./desktop-bootstrap";

if (process.platform !== "linux") throw new Error("Run from WSL with Windows interop enabled");
const wsl = "/mnt/c/Windows/System32/wsl.exe";
const distributions = parseDistributions(decodeWsl(execFileSync(wsl, ["--list", "--verbose"])));
const distro = process.env.WSL_DISTRO_NAME;
if (!distro || !distributions.some((d) => d.name === distro && d.version === 2))
  throw new Error("Current WSL2 distro not found");
const temp = mkdtempSync(join(tmpdir(), "hhu-windows-smoke-"));
const env = {
  ...process.env,
  XDG_STATE_HOME: join(temp, "state"),
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_DATA_HOME: join(temp, "data"),
};
const p = paths(env);
const cliFile = resolve("dist/cli/hhu.js");
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [cliFile, ...args], { env, timeout: 30000 }).toString();
const bridgeDir = join(temp, ".local/lib/harnesshub");
mkdirSync(bridgeDir, { recursive: true });
writeFileSync(
  join(bridgeDir, "desktop-bridge"),
  bridgeLauncher(process.execPath, resolve("dist"), process.env.PATH ?? "/usr/bin:/bin", p).replace(
    "# HarnessHub desktop bridge launcher",
    `# HarnessHub desktop bridge launcher\nexport HOME='${(process.env.HOME ?? "").replaceAll("'", "'\\''")}'`,
  ),
  { mode: 0o700 },
);
const winTemp = execFileSync(
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  ["-NoProfile", "-Command", "[System.IO.Path]::GetTempPath()"],
  { encoding: "utf8" },
).trim();
const winMount = execFileSync("wslpath", ["-u", winTemp], { encoding: "utf8" }).trim();
const output = mkdtempSync(join(winMount, "hhu-desktop-smoke-"));
let companion: ReturnType<typeof spawn> | undefined;
let companionDone: Promise<unknown> | undefined;
const windowsPath = (path: string) =>
  execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim();
console.log(`Windows smoke evidence: ${output}\nIsolated WSL data: ${temp}`);
try {
  const i = JSON.parse(cli("desktop-bridge", VERSION, "1")).instance;
  const client = new Client(i);
  const workspace = join(temp, "project");
  mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
  git("init", "-b", "main");
  writeFileSync(join(workspace, "deleted.txt"), "deleted fixture\n");
  writeFileSync(join(workspace, "sentinel.txt"), "original\n");
  writeFileSync(join(workspace, "branch.txt"), "main\n");
  git("add", ".");
  git("-c", "user.name=HHU Test", "-c", "user.email=test@localhost", "commit", "-m", "fixture");
  git("switch", "-c", "feature/shared");
  writeFileSync(join(workspace, "branch.txt"), "shared feature\n");
  git("add", "branch.txt");
  git(
    "-c",
    "user.name=HHU Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "branch fixture",
  );
  git("switch", "main");
  unlinkSync(join(workspace, "deleted.txt"));
  writeFileSync(join(workspace, "added.txt"), "added fixture\n");
  git("add", "added.txt");
  writeFileSync(
    join(workspace, "large.ts"),
    Array.from({ length: 1200 }, (_, i) => `const line${i} = ${i};`).join("\n"),
  );
  writeFileSync(join(workspace, "untracked 世界 & #%.txt"), "untracked fixture\n");
  writeFileSync(join(workspace, "sentinel.txt"), "HARNESSHUB_DESKTOP_PHASE3_世界\n", {
    mode: 0o600,
  });
  const project = await client.request<{ id: string }>("/v1/projects", "POST", {
    rootPath: workspace,
    name: "HarnessHub Desktop",
  });
  const conversation = await client.request<{ id: string }>(
    `/v1/projects/${project.id}/conversations`,
    "POST",
    { title: "Windows 与 WSL 的同一段对话" },
  );
  const other = await client.request<{ id: string }>(
    `/v1/projects/${project.id}/conversations`,
    "POST",
    { title: "Bridge 架构与安全检查" },
  );
  const node = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
  await client.request("/v1/harness-profiles", "POST", {
    id: "desktop-smoke",
    name: "Desktop smoke",
    command: node,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: {
      ...(process.env.HHU_DESKTOP_IMAGES_ONLY === "1" ? { HHU_MOCK_IMAGES: "1" } : {}),
      HHU_MOCK_COMMANDS: JSON.stringify([
        { name: "silent", description: "Real ACP published mock command" },
      ]),
    },
  });
  await client.request("/v1/harness-profiles", "POST", {
    id: "desktop-grok-mock",
    name: "Grok (Mock ACP)",
    command: node,
    args: [resolve("tests/fixtures/mock-acp/server.mjs")],
    envOverrides: {},
  });
  const turn = await client.request<{ id: string }>(
    `/v1/conversations/${conversation.id}/turns`,
    "POST",
    {
      requestId: crypto.randomUUID(),
      harnessId: "desktop-smoke",
      message:
        'Desktop smoke · 保留 Linux Workspace\n<img src=x onerror="window.hhuInjected=true">',
    },
  );
  const end = Date.now() + 15000;
  while ((await client.request<{ state: string }>(`/v1/turns/${turn.id}`)).state !== "COMPLETED") {
    if (Date.now() > end) throw new Error("Seed turn timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  cli("daemon", "stop");
  cpSync("dist/desktop/app", join(output, "app"), { recursive: true });
  const result = await Bun.build({
    entrypoints: ["apps/desktop/tests/windows-smoke.ts"],
    target: "node",
    format: "cjs",
    outdir: join(output, "app/main"),
    naming: "smoke.cjs",
    external: ["electron", "bufferutil", "utf-8-validate"],
  });
  if (!result.success) throw new AggregateError(result.logs, "Windows smoke build failed");
  writeFileSync(join(output, "app/package.json"), JSON.stringify({ main: "main/smoke.cjs" }));
  writeFileSync(
    join(output, "app/smoke-config.json"),
    JSON.stringify({
      linuxHome: temp,
      distro,
      conversationId: conversation.id,
      otherId: other.id,
      workspace,
      output: windowsPath(output),
      ...(process.env.HHU_DESKTOP_REAL === "1"
        ? {
            realHarnesses:
              process.env.HHU_DESKTOP_HANDOFF === "1" ? ["claude", "opencode"] : ["codex", "grok"],
          }
        : {}),
      realHandoff: process.env.HHU_DESKTOP_HANDOFF === "1",
      newConversationOnly: process.env.HHU_DESKTOP_NEW_ONLY === "1",
      imagesOnly: process.env.HHU_DESKTOP_IMAGES_ONLY === "1",
    }),
  );
  // Run official Electron executable from a separately extracted, checksum-verified archive.
  const archive = Array.from(
    new Bun.Glob("*/electron-v45.2.3-win32-x64.zip").scanSync(
      join(process.env.HOME ?? "", ".cache/electron"),
    ),
  )[0];
  if (!archive)
    throw new Error("Run desktop:package first to download the Windows Electron archive");
  const archivePath = join(process.env.HOME ?? "", ".cache/electron", archive);
  const checksums = JSON.parse(
    readFileSync("apps/desktop/node_modules/electron/checksums.json", "utf8"),
  );
  if (
    createHash("sha256").update(readFileSync(archivePath)).digest("hex") !==
    checksums["electron-v45.2.3-win32-x64.zip"]
  )
    throw new Error("Electron archive checksum mismatch");
  const electronDir = join(output, "electron");
  mkdirSync(electronDir);
  execFileSync("python3", [
    "-m",
    "zipfile",
    "-e",
    join(process.env.HOME ?? "", ".cache/electron", archive),
    electronDir,
  ]);
  const log = Bun.file(join(output, "stdout.log"));
  companion = spawn(
    "python3",
    [resolve("tests/e2e/desktop-companion.py"), process.execPath, cliFile, output],
    { env, stdio: "ignore" },
  );
  companionDone = new Promise((resolve) => companion?.on("exit", resolve));
  const child = spawn(join(electronDir, "electron.exe"), [windowsPath(join(output, "app"))], {
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE"),
    ),
  });
  let outputText = "";
  child.stdout.on("data", (chunk) => {
    outputText += String(chunk);
    appendFileSync(join(output, "stdout.log"), String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    outputText += String(chunk);
    appendFileSync(join(output, "stdout.log"), String(chunk));
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  await Bun.write(log, outputText);
  const evidence = JSON.parse(readFileSync(join(output, "evidence.json"), "utf8"));
  console.log(JSON.stringify(evidence, null, 2));
  if (code !== 0 || !evidence.passed) throw new Error(`Windows smoke failed; see ${output}`);
} finally {
  writeFileSync(join(output, "stop-tui"), "stop");
  await companionDone;
  try {
    cli("daemon", "stop");
  } catch {
    console.error(`Isolated Daemon cleanup requires inspection: ${temp}`);
  }
}
