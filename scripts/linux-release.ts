import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../packages/shared/src/index";
import { copyDependencies, inventory, sha256 } from "./linux-release-lib";
import { checkVersions } from "./version";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = checkVersions(root).canonical;
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--outdir"))
  throw new Error("Usage: bun scripts/linux-release.ts [--outdir new-directory]");
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("Build the Linux release on Linux x64 with glibc");
const run = (command: string, argv: string[], cwd = root) => {
  const result = spawnSync(command, argv, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
};
const node = realpathSync(Bun.which("node") ?? "node");
const nodeVersion = spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim();
const expectedNode = /\d+\.\d+\.\d+/.exec(pkg.engines.node)?.[0];
if (nodeVersion !== `v${expectedNode}` || Bun.version !== pkg.engines.bun)
  throw new Error(`Release builds require Node ${expectedNode} and Bun ${pkg.engines.bun}`);
run("getconf", ["GNU_LIBC_VERSION"]);
const output = resolve(args[1] ?? join(root, "dist/linux/releases", version));
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output); // Never overwrite an existing release or its checksums.
const work = mkdtempSync(join(tmpdir(), "hhu-linux-release-"));
console.log(`Release staging: ${work}`);
const dependencies = join(work, "dependencies");
mkdirSync(dependencies);
for (const file of [
  "package.json",
  "bun.lock",
  ...["apps", "packages"].flatMap((directory) =>
    readdirSync(join(root, directory)).map((name) => `${directory}/${name}/package.json`),
  ),
]) {
  mkdirSync(dirname(join(dependencies, file)), { recursive: true });
  copyFileSync(join(root, file), join(dependencies, file));
}
run(
  process.execPath,
  [
    "install",
    "--filter",
    "harnesshub",
    "--production",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--backend",
    "copyfile",
  ],
  dependencies,
);
const name = `harnesshub-${version}-linux-x64`;
const payload = join(work, name);
mkdirSync(payload);
const build = join(work, "build");
run(process.execPath, ["scripts/build.ts", "--outdir", build]);
for (const directory of ["cli", "daemon"])
  cpSync(join(build, directory), join(payload, "dist", directory), {
    recursive: true,
    filter: (path) => !path.endsWith(".map"),
  });
const runtimeDependencies = Object.keys(pkg.dependencies).filter(
  (name) => name !== "@opentui/solid" && name !== "solid-js",
);
const packages = copyDependencies(dependencies, payload, runtimeDependencies);
writeFileSync(
  join(payload, "package.json"),
  `${JSON.stringify(
    {
      name: "harnesshub",
      version,
      private: true,
      type: "module",
      dependencies: Object.fromEntries(
        runtimeDependencies.map((name) => [name, pkg.dependencies[name]]),
      ),
    },
    null,
    2,
  )}\n`,
);
mkdirSync(join(payload, "runtime"));
copyFileSync(node, join(payload, "runtime/node"));
copyFileSync(realpathSync(process.execPath), join(payload, "runtime/bun"));
for (const binary of ["node", "bun"]) chmodSync(join(payload, "runtime", binary), 0o755);
mkdirSync(join(payload, "licenses"));
// Preserve upstream notices for the runtimes and the two libraries bundled into CLI JavaScript.
for (const [name, url] of [
  ["node-LICENSE", `https://raw.githubusercontent.com/nodejs/node/v${expectedNode}/LICENSE`],
  [
    "bun-LICENSE.md",
    `https://raw.githubusercontent.com/oven-sh/bun/bun-v${Bun.version}/LICENSE.md`,
  ],
])
  run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--connect-timeout",
    "15",
    "--max-time",
    "120",
    "--retry",
    "2",
    url ?? "",
    "-o",
    join(payload, "licenses", name ?? ""),
  ]);
for (const name of ["solid-js", "@opentui/solid"]) {
  const source = join(dependencies, "node_modules", name);
  const notices = readdirSync(source).filter((file) => /^(license|notice|copying)/i.test(file));
  if (!notices.length) throw new Error(`Missing bundled library notices: ${name}`);
  for (const notice of notices)
    cpSync(
      join(source, notice),
      join(payload, "licenses", `${name.replaceAll("/", "-")}-${notice}`),
      { recursive: true },
    );
}
writeFileSync(
  join(payload, "licenses/dependencies.json"),
  `${JSON.stringify(packages, null, 2)}\n`,
);
writeFileSync(
  join(payload, "licenses/README.txt"),
  "Third-party package license and notice files are preserved in node_modules. dependencies.json lists their exact installed locations. Runtime and bundled library notices are adjacent. HarnessHub's source is at https://github.com/HalaRank/HarnessHub.\n",
);
const installer = await Bun.build({
  entrypoints: [join(root, "scripts/install-release.ts")],
  target: "node",
  outdir: join(payload, "lib"),
  naming: "install.js",
});
if (!installer.success) throw new AggregateError(installer.logs, "Installer build failed");
mkdirSync(join(payload, "bin"));
const portable = `#!/bin/sh
# HarnessHub portable release launcher
release=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
export PATH="$release/runtime:$PATH"
exec "$release/runtime/bun" --no-env-file "$release/dist/cli/hhu.js" "$@"
`;
writeFileSync(join(payload, "bin/hhu"), portable, { mode: 0o755 });
writeFileSync(
  join(payload, "bin/desktop-bridge"),
  portable.replace('"$@"', 'desktop-bridge "$@"'),
  { mode: 0o755 },
);
const install = readFileSync(join(root, "scripts/install.sh"), "utf8").replaceAll(
  "@HHU_VERSION@",
  version,
);
writeFileSync(join(payload, "install.sh"), install, { mode: 0o755 });
copyFileSync(join(root, "docs/DISTRIBUTION.md"), join(payload, "README.md"));
const manifest = {
  product: "HarnessHub",
  version,
  protocolVersion: PROTOCOL_VERSION,
  platform: "linux",
  arch: "x64",
  libc: "glibc",
  runtimes: { node: nodeVersion.slice(1), bun: Bun.version },
  sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim(),
  sourceDirty:
    spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim()
      .length > 0,
  lockfileSha256: sha256(join(root, "bun.lock")),
  files: inventory(payload),
};
writeFileSync(join(payload, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// Load SQLite with the bundled Node before spending time compressing a broken native package.
run(
  join(payload, "runtime/node"),
  [
    "--input-type=module",
    "-e",
    "import Database from 'better-sqlite3'; const db = new Database(':memory:'); console.log(db.prepare('select sqlite_version() AS version').get()); db.close();",
  ],
  payload,
);
run(
  join(payload, "runtime/bun"),
  ["--no-env-file", "-e", "await import('@opentui/core'); console.log('OpenTUI native loaded')"],
  payload,
);
const archive = `${name}.tar.gz`;
run("tar", ["-czf", join(output, archive), "-C", work, name]);
copyFileSync(join(payload, "install.sh"), join(output, "install.sh"));
copyFileSync(join(payload, "release-manifest.json"), join(output, "release-manifest.json"));
const artifacts = [archive, "install.sh", "release-manifest.json"];
writeFileSync(
  join(output, "SHA256SUMS.txt"),
  `${artifacts.map((file) => `${sha256(join(output, file))}  ${file}`).join("\n")}\n`,
);
console.log(
  `Built ${join(output, archive)}\nStaging retained for inspection: ${work}\nValidate before publishing: bun run release:verify -- ${output}`,
);
