import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION } from "../packages/shared/src/index";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const action = process.argv[2] ?? "build";
if (!["build", "dev", "package"].includes(action))
  throw new Error("Usage: desktop.ts build|dev|package");
if (action === "dev" && process.platform !== "win32")
  throw new Error(
    "Run desktop:dev using Windows Bun in PowerShell. The WSL backend is built separately.",
  );
const output = resolve("dist/desktop/app");
mkdirSync(output, { recursive: true });
for (const name of ["index", "preload"]) {
  const result = await Bun.build({
    entrypoints: [`apps/desktop/src/main/${name}.ts`],
    target: "node",
    format: "cjs",
    outdir: join(output, "main"),
    naming: `${name}.cjs`,
    external: ["electron", "bufferutil", "utf-8-validate"],
    minify: false,
  });
  if (!result.success) throw new AggregateError(result.logs, "Desktop main build failed");
}
const renderer = await Bun.build({
  entrypoints: ["apps/desktop/src/renderer/index.tsx"],
  target: "browser",
  outdir: join(output, "renderer"),
  tsconfig: "apps/desktop/tsconfig.json",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  minify: true,
});
if (!renderer.success) throw new AggregateError(renderer.logs, "Desktop renderer build failed");
cpSync("apps/desktop/src/renderer/index.html", join(output, "renderer/index.html"));
cpSync("apps/desktop/assets", join(output, "assets"), { recursive: true });
// A dependency-free staging app: all JS is bundled; no Linux SQLite/OpenTUI/ACP modules.
writeFileSync(
  join(output, "package.json"),
  JSON.stringify(
    {
      name: "harnesshub-desktop",
      productName: "HarnessHub",
      version: VERSION,
      description: "HarnessHub Windows client for WSL2",
      author: "HarnessHub contributors",
      private: true,
      dependencies: {},
      main: "main/index.cjs",
    },
    null,
    2,
  ),
);
console.log(`Built Windows Desktop assets: ${output}`);
if (action === "dev") {
  const electron = resolve("apps/desktop/node_modules/electron/cli.js");
  const result = spawnSync("node", [electron, output], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
if (action === "package") {
  const { build, Platform, Arch } = await import(
    pathToFileURL(createRequire(resolve("apps/desktop/package.json")).resolve("electron-builder"))
      .href
  );
  // Stage outside the monorepo so electron-builder cannot infer Linux workspace dependencies.
  const staging = mkdtempSync(join(tmpdir(), "hhu-windows-package-"));
  cpSync(output, staging, { recursive: true });
  await build({
    projectDir: staging,
    targets: Platform.WINDOWS.createTarget(["dir"], Arch.x64),
    config: {
      appId: "org.harnesshub.desktop",
      productName: "HarnessHub",
      electronVersion: "45.2.3",
      directories: { app: staging, output: resolve("dist/desktop/windows") },
      files: [
        "main/**",
        "renderer/**",
        "assets/logo.png",
        "assets/icon.png",
        "assets/icon.ico",
        "package.json",
        "!node_modules/**",
      ],
      asar: true,
      npmRebuild: false,
      win: { icon: join(staging, "assets/icon.ico"), signExecutable: false },
    },
  });
  const archive = readFileSync(resolve("dist/desktop/windows/win-unpacked/resources/app.asar"));
  const header = archive.subarray(16, 16 + archive.readUInt32LE(12)).toString("utf8");
  if (/node_modules|better-sqlite3|opentui|\.node"/.test(header))
    throw new Error("Unexpected native/workspace dependency in Windows archive");
  console.log("Verified Windows archive: bundled main/preload/renderer only");
}
