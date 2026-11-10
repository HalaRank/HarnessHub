import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, VERSION } from "../packages/shared/src/index";

// No signing credentials are consulted by this test-release pipeline.
export function windowsConfig(staging: string, output: string, electronVersion: string) {
  return {
    appId: "org.harnesshub.desktop",
    productName: "HarnessHub",
    electronVersion,
    directories: { app: staging, output },
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
    publish: null,
    extraFiles: [{ from: "DESKTOP.md", to: "DESKTOP.md" }],
    win: {
      icon: join(staging, "assets/icon.ico"),
      signExecutable: false,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder artifact macros
      artifactName: "HarnessHub-${version}-windows-${arch}-unsigned.${ext}",
    },
    nsis: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder artifact macros
      artifactName: "HarnessHub-${version}-windows-${arch}-unsigned-setup.${ext}",
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      createStartMenuShortcut: true,
      createDesktopShortcut: true,
      shortcutName: "HarnessHub",
      uninstallDisplayName: "HarnessHub",
      deleteAppDataOnUninstall: false,
      runAfterFinish: false,
      differentialPackage: false,
    },
  };
}

export function inspectArchive(archive: Buffer): string[] {
  const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString("utf8"));
  const paths: string[] = [];
  const visit = (
    files: Record<string, { files?: Record<string, unknown>; link?: string; unpacked?: boolean }>,
    prefix = "",
  ) => {
    for (const [name, entry] of Object.entries(files)) {
      const path = `${prefix}${name}`;
      if (entry.link || entry.unpacked || /(^|\/)(node_modules|[^/]*\.node)$/.test(path))
        throw new Error(`Unexpected dependency/link in Windows archive: ${path}`);
      if (entry.files) visit(entry.files as typeof files, `${path}/`);
      else {
        if (
          !/^(main\/(index|preload)\.cjs|renderer\/index\.(html|js|css)|assets\/(logo\.png|icon\.(png|ico))|package\.json)$/.test(
            path,
          )
        )
          throw new Error(`Unexpected Windows payload: ${path}`);
        paths.push(path);
      }
    }
  };
  visit(header.files);
  for (const required of [
    "main/index.cjs",
    "main/preload.cjs",
    "renderer/index.html",
    "renderer/index.js",
    "renderer/index.css",
    "assets/icon.ico",
    "package.json",
  ])
    if (!paths.includes(required)) throw new Error(`Missing Windows payload: ${required}`);
  return paths.sort();
}

export function writeReleaseManifest(output: string, payload: string[]) {
  const names = [
    `HarnessHub-${VERSION}-windows-x64-unsigned-setup.exe`,
    `HarnessHub-${VERSION}-windows-x64-unsigned.zip`,
  ];
  const artifacts = names.map((file) => {
    const data = readFileSync(join(output, file));
    return { file, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  });
  if (readdirSync(output).some((name) => /latest.*\.yml$/.test(name)))
    throw new Error("Unexpected update feed in manual release");
  const manifest = {
    product: "HarnessHub",
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform: "win32",
    arch: "x64",
    signing: "unsigned",
    autoUpdate: false,
    payload,
    artifacts,
  };
  writeFileSync(join(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(output, "SHA256SUMS.txt"),
    `${artifacts.map((a) => `${a.sha256}  ${a.file}`).join("\n")}\n`,
  );
  return manifest;
}
