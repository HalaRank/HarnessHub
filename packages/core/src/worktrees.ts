import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "@harnesshub/shared";
import { privateDir } from "@harnesshub/shared/paths";
import { HandoffStore, type Store } from "@harnesshub/storage";
import { projectRoot } from "./index";

// Synchronous bounded argv operations keep creation/removal and SQLite ownership checks
// serialized with Runtime submission in this daemon. No shell, force, branch deletion or hooks.
function git(cwd: string, args: string[]) {
  try {
    return execFileSync("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    throw new AppError(
      409,
      "Git worktree operation failed; inspect managed record and repository. No force or branch deletion was attempted.",
    );
  }
}
function registered(cwd: string) {
  return git(cwd, ["worktree", "list", "--porcelain", "-z"])
    .split("\0\0")
    .filter(Boolean)
    .map((entry) => {
      const fields = entry.split("\0");
      return {
        path: fields.find((x) => x.startsWith("worktree "))?.slice(9),
        branch: fields.find((x) => x.startsWith("branch "))?.slice(7),
        locked: fields.some((x) => x.startsWith("locked")),
      };
    });
}
export class Worktrees {
  readonly data: HandoffStore;
  readonly root: string;
  constructor(readonly store: Store) {
    this.data = new HandoffStore(store);
    this.root = join(dirname(store.sqlite.name), "worktrees");
    // Crashes leave evidence, never an implicitly usable workspace or an automatic deletion.
    for (const w of this.data.worktrees())
      if (["CREATING", "REMOVING"].includes(w.status))
        this.data.updateWorktree(w.id, {
          status: "ERROR",
          error:
            "Interrupted operation; inspect Git registration and path, then explicitly clean up",
        });
  }
  create(projectId: string) {
    const project = this.store.getProject(projectId);
    const cwd = projectRoot(project.rootPath);
    const repositoryPath = projectRoot(
      git(cwd, ["rev-parse", "--show-toplevel"]).replace(/\n$/, ""),
    );
    git(cwd, ["rev-parse", "--verify", "HEAD"]); // reject unborn / non-Git / bare repositories
    privateDir(this.root);
    const ownerRoot = realpathSync(this.root),
      id = randomUUID();
    const path = join(ownerRoot, id),
      branch = `hhu/${id}`;
    if (
      existsSync(path) ||
      registered(repositoryPath).some((w) => w.path === path || w.branch === `refs/heads/${branch}`)
    )
      throw new AppError(
        409,
        "Worktree path or branch collision; no existing directory or branch was changed",
      );
    const refs = git(cwd, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]).trim();
    if (refs) throw new AppError(409, "Branch collision; no user branch was changed");
    this.data.addWorktree({
      id,
      projectId,
      repositoryPath,
      path,
      branch,
      ownerRoot,
      status: "CREATING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    try {
      git(repositoryPath, ["worktree", "add", "-b", branch, "--", path, "HEAD"]);
      if (
        projectRoot(path) !== path ||
        !registered(repositoryPath).some(
          (w) => w.path === path && w.branch === `refs/heads/${branch}`,
        )
      )
        throw new AppError(409, "Created worktree failed ownership verification");
      this.data.updateWorktree(id, { status: "READY" });
      return this.data.worktree(id);
    } catch (error) {
      this.data.updateWorktree(id, {
        status: "ERROR",
        error:
          "Creation incomplete; path/branch may remain. No Conversation was bound. Inspect and explicitly clean up.",
      });
      throw error;
    }
  }
  cleanup(id: string, confirmed: boolean) {
    if (!confirmed) throw new AppError(400, "Worktree cleanup requires explicit confirmation");
    const w = this.data.worktree(id);
    if (w.status === "REMOVED") return w;
    if (
      this.store
        .listConversations()
        .some(
          (c) =>
            c.worktreeId === id ||
            c.workspacePath === w.path ||
            c.workspacePath.startsWith(`${w.path}/`),
        )
    )
      throw new AppError(
        409,
        "Worktree is bound to a Conversation; delete the idle Conversation first. Deletion alone never removes files.",
      );
    if (
      w.ownerRoot !== realpathSync(this.root) ||
      dirname(w.path) !== w.ownerRoot ||
      w.path !== join(w.ownerRoot, w.id)
    )
      throw new AppError(409, "Worktree ownership/path verification failed");
    const entries = registered(projectRoot(w.repositoryPath));
    const entry = entries.find((e) => e.path === w.path);
    if (!entry) {
      if (existsSync(w.path))
        throw new AppError(409, "Unregistered directory exists; HarnessHub will not delete it");
      this.data.updateWorktree(id, { status: "REMOVED", error: null });
      return this.data.worktree(id); // Git already removed it; preserve the branch.
    }
    if (
      entry.branch !== `refs/heads/${w.branch}` ||
      entry.locked ||
      !existsSync(w.path) ||
      lstatSync(w.path).isSymbolicLink() ||
      realpathSync(w.path) !== w.path
    )
      throw new AppError(
        409,
        "Worktree path, lock or branch no longer matches HarnessHub ownership",
      );
    if (
      git(w.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"])
        .length
    )
      throw new AppError(
        409,
        "Worktree is dirty (including untracked/ignored files); cleanup refused",
      );
    this.data.updateWorktree(id, { status: "REMOVING" });
    try {
      git(w.repositoryPath, ["worktree", "remove", "--", w.path]);
      this.data.updateWorktree(id, { status: "REMOVED", error: null });
      return this.data.worktree(id);
    } catch (error) {
      this.data.updateWorktree(id, {
        status: "ERROR",
        error: "Cleanup incomplete; inspect Git before explicitly retrying",
      });
      throw error;
    }
  }
}
