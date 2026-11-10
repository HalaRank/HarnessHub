import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, privateDir, securePaths } from "../packages/shared/src/paths";
import { launchScript, shellQuote, validateManifest } from "./linux-release-lib";

process.umask(0o077);
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("This release supports Linux x64 / WSL2 only");
const payload = resolve(fileURLToPath(new URL("../", import.meta.url)));
const p = paths();
securePaths(p);
if (!process.argv.includes("--lock-held")) {
  const child = spawnSync(
    "flock",
    [
      "--no-fork",
      "--nonblock",
      "--conflict-exit-code",
      "73",
      p.lock,
      process.execPath,
      fileURLToPath(import.meta.url),
      "--lock-held",
    ],
    { stdio: "inherit" },
  );
  if (child.status === 73)
    throw new Error(
      "Stop the running HarnessHub Daemon before installation: hhu daemon stop. No tasks were interrupted.",
    );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const manifest = validateManifest(payload);
const home = homedir();
const base = join(home, ".local/lib/harnesshub");
privateDir(base);
const releases = join(base, "releases");
privateDir(releases);
const bin = join(home, ".local/bin");
mkdirSync(bin, { recursive: true });
if (!lstatSync(bin).isDirectory() || lstatSync(bin).uid !== process.getuid?.())
  throw new Error(`Unsafe executable directory: ${bin}`);
const targets = [join(bin, "hhu"), join(base, "desktop-bridge")];
for (const target of targets) {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    stat &&
    (!stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      !/^# HarnessHub (?:local launcher|release launcher|desktop bridge launcher)$/m.test(
        readFileSync(target, "utf8"),
      ))
  )
    throw new Error(`Refusing to overwrite an unrelated executable or link: ${target}`);
}
const id = `${manifest.version}-${randomUUID()}`;
const staging = join(releases, `.staging-${id}`);
const release = join(releases, id);
cpSync(payload, staging, { recursive: true, verbatimSymlinks: true });
validateManifest(staging);
renameSync(staging, release);
const previous = join(release, "previous-launchers");
privateDir(previous);
for (const target of targets) {
  if (existsSync(target)) {
    copyFileSync(target, join(previous, target === targets[0] ? "hhu" : "desktop-bridge"));
  }
}
const bridge = launchScript(release, "desktop-bridge ").replace(
  "# HarnessHub release launcher",
  `# HarnessHub desktop bridge launcher
export PATH=${shellQuote(process.env.PATH ?? "/usr/bin:/bin")}
export XDG_CONFIG_HOME=${shellQuote(dirname(p.config))}
export XDG_DATA_HOME=${shellQuote(dirname(p.data))}
export XDG_STATE_HOME=${shellQuote(dirname(p.state))}`,
);
const contents = [launchScript(release), bridge];
const replaced: string[] = [];
try {
  for (const [index, target] of targets.entries()) {
    const temporary = `${target}.${id}.tmp`;
    writeFileSync(temporary, contents[index] ?? "", { mode: 0o700, flag: "wx" });
    renameSync(temporary, target);
    replaced.push(target);
  }
} catch (error) {
  for (const target of replaced.reverse()) {
    const backup = join(previous, target === targets[0] ? "hhu" : "desktop-bridge");
    if (existsSync(backup)) {
      const temporary = `${target}.${id}.restore`;
      copyFileSync(backup, temporary);
      renameSync(temporary, target);
    } else unlinkSync(target); // Only our just-created launcher; no pre-existing file existed.
  }
  throw error;
}
chmodSync(release, 0o700);
writeFileSync(
  join(release, "install-receipt.json"),
  JSON.stringify(
    {
      version: manifest.version,
      release,
      previous,
      installedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  { mode: 0o600, flag: "wx" },
);
console.log(
  `Installed HarnessHub ${manifest.version}: ${targets[0]}\nRelease: ${release}\nPrevious launchers: ${previous}\nNo source checkout or system Node/Bun is required.`,
);
if (!(process.env.PATH ?? "").split(":").includes(bin))
  console.log(`Add to your shell PATH: export PATH="$HOME/.local/bin:$PATH"`);
