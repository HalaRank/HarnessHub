import { isAbsolute, relative, resolve } from "node:path";
import { AppError, type GitChanges, type GitFile, type GitPatch } from "@harnesshub/shared";
import { safeGit } from "./git";
import { projectRoot } from "./index";

async function git(cwd: string, args: string[], allowDiffExit = false) {
  try {
    return (await safeGit(cwd, args, allowDiffExit)).stdout;
  } catch {
    throw new AppError(
      503,
      "Git query failed (unavailable, timeout, unsafe repository or output exceeds 2 MiB); inspect workspace with git",
    );
  }
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
    try {
      await safeGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    } catch (error) {
      if (/not a git repository/.test((error as { stderr?: string }).stderr ?? ""))
        return {
          workspace: cwd,
          repository: null,
          files: [],
          observedAt: Date.now(),
          notice: "Workspace is not a Git repository",
        };
    }
    throw new AppError(503, "Cannot inspect Git workspace");
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
