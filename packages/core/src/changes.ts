import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { AppError, type GitChanges, type GitFile, type GitPatch } from "@harnesshub/shared";
import { projectRoot } from "./index";

// argv only, with literal pathspecs; never invokes a shell, pager, external diff or textconv.
async function git(cwd: string, args: string[], allowDiffExit = false) {
  return new Promise<string>((ok, fail) => {
    execFile(
      "git",
      ["--no-pager", "--literal-pathspecs", ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout) => {
        if (!error || (allowDiffExit && error.code === 1)) ok(stdout);
        else
          fail(
            new AppError(
              503,
              "Git query failed (unavailable, timeout, unsafe repository or output exceeds 2 MiB); inspect workspace with git",
            ),
          );
      },
    );
  });
}
export function parseStatus(value: string): GitFile[] {
  const parts = value.split("\0"),
    files: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const file: GitFile = {
      index: entry[0] ?? " ",
      worktree: entry[1] ?? " ",
      path: entry.slice(3),
    };
    if (/[RC]/.test(file.index + file.worktree)) file.previousPath = parts[++i] ?? "";
    files.push(file);
  }
  return files;
}
export async function changes(workspace: string): Promise<GitChanges> {
  const cwd = projectRoot(workspace);
  // --is-inside-work-tree distinguishes bare repositories; ordinary non-Git directories
  // are an expected empty state, while status errors remain errors.
  let repository: string | null = null;
  try {
    repository = (await git(cwd, ["rev-parse", "--show-toplevel"])).trimEnd();
  } catch {
    // A separate probe preserves useful failures (including missing git / ownership errors).
    return new Promise((ok, fail) => {
      execFile(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        { cwd, encoding: "utf8", timeout: 10000 },
        (error, _stdout, stderr) => {
          if (error && /not a git repository/.test(stderr))
            ok({
              workspace: cwd,
              repository: null,
              files: [],
              observedAt: Date.now(),
              notice: "Workspace is not a Git repository",
            });
          else fail(new AppError(503, "Cannot inspect Git workspace"));
        },
      );
    });
  }
  const files = parseStatus(
    await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
  );
  return {
    workspace: cwd,
    repository,
    files,
    observedAt: Date.now(),
    notice:
      "Real Git state in this workspace; changes are not attributed to any Agent. Refresh for current state.",
  };
}
export async function patch(workspace: string, path: string): Promise<GitPatch> {
  const state = await changes(workspace);
  const file = state.files.find((f) => f.path === path);
  if (!state.repository || !file)
    throw new AppError(404, "File is no longer in workspace Git status; refresh Changes");
  const root = state.repository;
  const absolute = resolve(root, path),
    within = relative(state.workspace, absolute);
  if (isAbsolute(path) || within === ".." || within.startsWith("../") || isAbsolute(within))
    throw new AppError(400, "Path is outside Conversation workspace");
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
  const paths = file.previousPath ? [file.previousPath, file.path] : [file.path];
  let staged = "",
    unstaged = "",
    untracked = "";
  if (file.index === "?" && file.worktree === "?")
    untracked = await git(root, [...args, "--no-index", "--", "/dev/null", absolute], true);
  else {
    // Independent read-only queries; do not hide races behind a claim of atomic Git state.
    [staged, unstaged] = await Promise.all([
      git(root, [...args, "--cached", "--", ...paths]),
      git(root, [...args, "--", ...paths]),
    ]);
  }
  return { path, staged, unstaged, untracked, observedAt: Date.now() };
}
