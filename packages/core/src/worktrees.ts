import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "@harnesshub/shared";
import { privateDir } from "@harnesshub/shared/paths";
import { HandoffStore, type Store } from "@harnesshub/storage";
import { safeGit } from "./git";
import { projectRoot } from "./index";

// Await Git so slow repositories never block ACP events or approvals. Reservations below
// protect ownership and Workspace bindings across awaits. Cleanup retains files because
// neither these reservations nor Git status can exclude external writers.
async function git(cwd: string, args: string[]) {
  try {
    const result = await safeGit(cwd, args);
    return result.stdout;
  } catch {
    throw new AppError(
      409,
      "Git worktree operation failed; inspect managed record and repository. No force or branch deletion was attempted.",
    );
  }
}
async function registered(cwd: string) {
  return (await git(cwd, ["worktree", "list", "--porcelain", "-z"]))
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
  readonly operations = new Set<string>();
  constructor(readonly store: Store) {
    this.data = new HandoffStore(store);
    this.root = join(dirname(store.sqlite.name), "worktrees");
    // Crashes leave evidence, never an implicitly usable workspace or an automatic deletion.
    for (const w of this.data.worktrees())
      if (["CREATING", "REMOVING", "PRESERVING"].includes(w.status))
        this.data.updateWorktree(w.id, {
          status: "ERROR",
          error:
            "Interrupted operation; inspect Git registration and path, then explicitly clean up",
        });
  }
  async create(projectId: string) {
    if (this.store.projectOperations.has(projectId))
      throw new AppError(409, "Project already has a Worktree operation");
    this.store.projectOperations.add(projectId);
    try {
      return await this.createReserved(projectId);
    } finally {
      this.store.projectOperations.delete(projectId);
    }
  }
  private async createReserved(projectId: string) {
    const project = this.store.getProject(projectId);
    const cwd = projectRoot(project.rootPath);
    const repositoryPath = projectRoot(
      (await git(cwd, ["rev-parse", "--show-toplevel"])).replace(/\n$/, ""),
    );
    await git(cwd, ["rev-parse", "--verify", "HEAD"]); // reject unborn / non-Git / bare repositories
    privateDir(this.root);
    const ownerRoot = realpathSync(this.root),
      id = randomUUID();
    const path = join(ownerRoot, id),
      branch = `hhu/${id}`;
    if (
      existsSync(path) ||
      (await registered(repositoryPath)).some(
        (w) => w.path === path || w.branch === `refs/heads/${branch}`,
      )
    )
      throw new AppError(
        409,
        "Worktree path or branch collision; no existing directory or branch was changed",
      );
    const refs = (
      await git(cwd, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])
    ).trim();
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
    this.store.workspaceOperations.add(path);
    try {
      await git(repositoryPath, [
        "worktree",
        "add",
        "--no-checkout",
        "-b",
        branch,
        "--",
        path,
        "HEAD",
      ]);
      // Resolve branch/worktree-conditional config in the new directory before
      // checkout. checkout-index without --force refuses concurrently created files.
      await git(path, ["read-tree", "HEAD"]);
      await git(path, ["checkout-index", "--all"]);
      if (
        projectRoot(path) !== path ||
        !(await registered(repositoryPath)).some(
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
    } finally {
      this.store.workspaceOperations.delete(path);
    }
  }
  async cleanup(id: string, confirmed: boolean) {
    if (!confirmed) throw new AppError(400, "Worktree cleanup requires explicit confirmation");
    const w = this.data.worktree(id);
    if (["REMOVED", "RETAINED"].includes(w.status)) return w;
    if (this.operations.has(id) || this.store.workspaceOperations.has(w.path))
      throw new AppError(409, "Worktree operation already in progress");
    this.operations.add(id);
    this.store.workspaceOperations.add(w.path);
    const retainedPath = join(this.root, "retained", id);
    this.store.workspaceOperations.add(retainedPath);
    try {
      return await this.cleanupReserved(id);
    } finally {
      this.operations.delete(id);
      this.store.workspaceOperations.delete(w.path);
      this.store.workspaceOperations.delete(retainedPath);
    }
  }
  private async cleanupReserved(id: string) {
    const w = this.data.worktree(id);
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
    const entries = await registered(projectRoot(w.repositoryPath));
    const retainedRoot = join(w.ownerRoot, "retained"),
      retainedPath = join(retainedRoot, w.id);
    const retained = entries.find((e) => e.path === retainedPath);
    const finish = () => {
      this.data.updateWorktree(id, {
        path: retainedPath,
        ownerRoot: retainedRoot,
        status: "RETAINED",
        error: "Files and branch retained. Inspect this directory before any manual removal.",
      });
      return this.data.worktree(id);
    };
    // A crash can occur after Git moves the directory but before SQLite records it.
    // Reconcile only on an explicit retry, without deleting either path.
    if (retained) {
      if (
        existsSync(w.path) ||
        retained.branch !== `refs/heads/${w.branch}` ||
        !existsSync(retainedPath) ||
        realpathSync(retainedPath) !== retainedPath
      )
        throw new AppError(409, "Retained worktree ownership is uncertain; inspect both paths");
      return finish();
    }
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
    const flags = await git(w.path, ["ls-files", "-v", "-z"]);
    if (flags.split("\0").some((entry) => /^[a-zS]/.test(entry)))
      throw new AppError(
        409,
        "Index flags can hide changes (assume-unchanged/skip-worktree); cleanup refused",
      );
    if (
      (
        await git(w.path, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
        ])
      ).length
    )
      throw new AppError(
        409,
        "Worktree is dirty (including untracked/ignored files); cleanup refused",
      );
    privateDir(retainedRoot);
    if (realpathSync(retainedRoot) !== retainedRoot || existsSync(retainedPath))
      throw new AppError(409, "Retained worktree destination is unsafe or already exists");
    this.data.updateWorktree(id, { status: "PRESERVING" });
    try {
      // Move preserves even ignored/hidden data written after the preflight. Never
      // follow this with remove: external editors can still hold open file handles.
      await git(w.repositoryPath, ["worktree", "move", "--", w.path, retainedPath]);
      if (
        realpathSync(retainedPath) !== retainedPath ||
        !(await registered(w.repositoryPath)).some(
          (e) => e.path === retainedPath && e.branch === `refs/heads/${w.branch}`,
        )
      )
        throw new AppError(409, "Retained worktree needs ownership inspection");
      return finish();
    } catch (error) {
      this.data.updateWorktree(id, {
        status: "ERROR",
        error: "Cleanup incomplete; inspect Git before explicitly retrying",
      });
      throw error;
    }
  }
}
