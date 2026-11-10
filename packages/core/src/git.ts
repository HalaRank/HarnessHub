import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
// Git runs in the Conversation workspace, never in an inherited GIT_DIR/index or
// with injected GIT_CONFIG_* / loader / shell startup settings. Preserve HOME/XDG
// so ordinary excludes, attributes and repository ownership checks still apply.
function environment() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "TMPDIR"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return {
    ...env,
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
}
const boundary = [
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.alternateRefsCommand=",
  "-c",
  "diff.external=",
  "-c",
  "submodule.recurse=false",
  "-c",
  "protocol.allow=never",
];
export async function safeGit(cwd: string, args: string[], allowDiffExit = false) {
  const options = {
    cwd,
    encoding: "utf8" as const,
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
    env: environment(),
    signal: AbortSignal.timeout(15000),
  };
  // Config reads and index enumeration do not invoke drivers. Status/diff may
  // recurse into initialized submodules, whose driver names need overrides too.
  const overrides = new Set<string>();
  const visited = new Set<string>();
  const inspect = async (directory: string) => {
    const local = { ...options, cwd: directory };
    const { stdout: config } = await exec(
      "git",
      [...boundary, "config", "--includes", "--null", "--list"],
      local,
    );
    for (const entry of config.split("\0")) {
      const key = entry.split("\n", 1)[0] ?? "";
      if (
        /^filter\..*\.(clean|smudge|process)$/i.test(key) ||
        /^diff\..*\.(command|textconv)$/i.test(key)
      )
        overrides.add(`${key}=`);
      if (/^filter\..*\.required$/i.test(key)) overrides.add(`${key}=false`);
    }
    let root: string;
    try {
      root = (
        await exec("git", [...boundary, "rev-parse", "--show-toplevel"], local)
      ).stdout.replace(/\n$/, "");
    } catch (error) {
      if (
        /not a git repository|must be run in a work tree/.test(
          (error as { stderr?: string }).stderr ?? "",
        )
      )
        return;
      throw error;
    }
    if (visited.has(root)) return;
    if (visited.size >= 128) throw new Error("Too many Git submodules for a bounded query");
    visited.add(root);
    const { stdout: index } = await exec(
      "git",
      [...boundary, "ls-files", "--stage", "--full-name", "-z"],
      { ...local, cwd: root },
    );
    for (const entry of index.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const path = entry.slice(entry.indexOf("\t") + 1);
      const child = join(root, path);
      if (!existsSync(join(child, ".git"))) continue; // uninitialized gitlink
      const within = relative(root, realpathSync(child));
      if (!within || within === ".." || within.startsWith("../") || isAbsolute(within))
        throw new Error("Unsafe submodule path");
      await inspect(child);
    }
  };
  await inspect(cwd);
  try {
    return await exec(
      "git",
      [...boundary, ...[...overrides].flatMap((value) => ["-c", value]), ...args],
      options,
    );
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    if (allowDiffExit && result.code === 1)
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    throw error;
  }
}
