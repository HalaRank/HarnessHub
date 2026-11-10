import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION } from "../packages/shared/src/index";
import { inspectArchive, windowsConfig, writeReleaseManifest } from "./desktop-release";
import { checkVersions } from "./version";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const action = process.argv[2] ?? "build";
if (!["build", "dev", "package"].includes(action))
  throw new Error("Usage: desktop.ts build|dev|package");
if (action === "dev" && process.platform !== "win32")
  throw new Error(
    "Run desktop:dev using Windows Bun in PowerShell. The WSL backend is built separately.",
  );
checkVersions(process.cwd());
const output = mkdtempSync(join(tmpdir(), "hhu-desktop-build-"));
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
cpSync(output, resolve("dist/desktop/app"), { recursive: true });
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
  cpSync("docs/DESKTOP.md", join(staging, "DESKTOP.md"));
  const releaseOutput = resolve(`dist/desktop/releases/${VERSION}-unsigned`);
  // A failed rebuild must never leave an old success manifest beside new partial artifacts.
  if (existsSync(releaseOutput))
    renameSync(releaseOutput, `${releaseOutput}-previous-${Date.now()}`);
  const desktopPackage = JSON.parse(readFileSync("apps/desktop/package.json", "utf8"));
  // Always explicit: no CI environment variable can publish or sign this build.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  await build({
    projectDir: staging,
    targets: Platform.WINDOWS.createTarget(["nsis", "zip"], Arch.x64),
    publish: "never",
    config: windowsConfig(staging, releaseOutput, desktopPackage.devDependencies.electron),
  });
  const archive = readFileSync(join(releaseOutput, "win-unpacked/resources/app.asar"));
  const payload = inspectArchive(archive);
  console.log(JSON.stringify(writeReleaseManifest(releaseOutput, payload), null, 2));
}
