import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { AppError, type ProjectBranches } from "@harnesshub/shared";
import type { Store } from "@harnesshub/storage";
import { safeGit } from "./git";
import { Worktrees } from "./worktrees";

export function projectRoot(input: string) {
  if (!isAbsolute(input)) throw new AppError(400, "Project root must be an absolute Linux path");
  try {
    const root = realpathSync(input);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    accessSync(root, constants.R_OK | constants.X_OK);
    return root;
  } catch {
    throw new AppError(
      400,
      "Project path does not exist or is not a readable directory; no directory was created",
    );
  }
}
export class Projects {
  readonly worktrees: Worktrees;
  constructor(readonly store: Store) {
    this.worktrees = new Worktrees(store);
  }
  create(rootPath: string, name?: string) {
    const root = projectRoot(rootPath);
    return this.store.addProject(root, name ?? (basename(root) || root));
  }
  update(id: string, patch: { rootPath?: string | undefined; name?: string | undefined }) {
    return this.store.updateProject(id, {
      ...patch,
      ...(patch.rootPath ? { rootPath: projectRoot(patch.rootPath) } : {}),
    });
  }
  createStandaloneConversation(workspacePath: string, title?: string) {
    return this.store.addConversation(null, title, undefined, projectRoot(workspacePath));
  }
  async branches(projectId: string): Promise<ProjectBranches> {
    const cwd = projectRoot(this.store.getProject(projectId).rootPath);
    try {
      await safeGit(cwd, ["rev-parse", "--show-toplevel"]);
    } catch (error) {
      if (/not a git repository/.test((error as { stderr?: string }).stderr ?? ""))
        return { isGit: false, hasCommits: false, currentBranch: null, branches: [] };
      throw new AppError(409, "Unable to read project Git branches");
    }
    const [current, refs] = await Promise.all([
      safeGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
        (error: { code?: number }) => {
          if (error.code === 1) return { stdout: "" };
          throw error;
        },
      ),
      safeGit(cwd, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"]),
    ]);
    const branches = refs.stdout.split("\n").filter(Boolean);
    return {
      isGit: true,
      hasCommits: branches.length > 0 || !current.stdout.trim(),
      currentBranch: current.stdout.trim() || null,
      branches,
    };
  }
  async createConversation(
    projectId: string,
    title?: string,
    workspaceMode: "shared" | "worktree" = "shared",
    baseBranch?: string,
  ) {
    if (baseBranch && workspaceMode === "shared")
      return this.createSharedOnBranch(projectId, title, baseBranch);
    projectRoot(this.store.getProject(projectId).rootPath);
    const workspace =
      workspaceMode === "worktree" ? await this.worktrees.create(projectId, baseBranch) : undefined;
    try {
      return this.store.addConversation(projectId, title, workspace);
    } catch (error) {
      if (workspace)
        this.worktrees.data.updateWorktree(workspace.id, {
          status: "ERROR",
          error:
            "Worktree created but Conversation binding failed; inspect and explicitly clean up",
        });
      throw error;
    }
  }
  private async createSharedOnBranch(projectId: string, title: string | undefined, branch: string) {
    const cwd = projectRoot(this.store.getProject(projectId).rootPath);
    if (this.store.projectOperations.has(projectId))
      throw new AppError(409, "Project has a pending operation; wait for it to finish");
    this.store.assertWorkspaceAvailable(cwd);
    this.store.projectOperations.add(projectId);
    this.store.workspaceOperations.add(cwd);
    let repositoryPath = cwd;
    let reservedPath = cwd;
    const release = () => {
      this.store.projectOperations.delete(projectId);
      this.store.workspaceOperations.delete(reservedPath);
    };
    try {
      repositoryPath = projectRoot(
        (await safeGit(cwd, ["rev-parse", "--show-toplevel"])).stdout.replace(/\n$/, ""),
      );
      // Extend the reservation to the repository root, including nested Projects
      // and standalone Conversations. No await while replacing the reservation.
      this.store.workspaceOperations.delete(cwd);
      this.store.assertWorkspaceAvailable(repositoryPath);
      this.store.workspaceOperations.add(repositoryPath);
      reservedPath = repositoryPath;
      await safeGit(cwd, ["check-ref-format", "--branch", branch]);
      await safeGit(cwd, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `refs/heads/${branch}^{commit}`,
      ]);
      const current = await safeGit(cwd, ["symbolic-ref", "--quiet", "HEAD"]).catch(
        (error: { code?: number }) => {
          if (error.code === 1) return { stdout: "" };
          throw error;
        },
      );
      if (current.stdout.trim() !== `refs/heads/${branch}`) {
        const affected = this.store
          .listConversations()
          .filter(
            (c) =>
              c.workspacePath === repositoryPath ||
              c.workspacePath.startsWith(`${repositoryPath}/`) ||
              repositoryPath.startsWith(`${c.workspacePath}/`),
          );
        for (const c of affected) {
          try {
            this.store.assertConversationDeletable(c.id);
          } catch {
            throw new AppError(
              409,
              "Shared workspace has an active or unresolved Conversation; finish it before switching branches, or create a Worktree",
            );
          }
        }
        const flags = await safeGit(cwd, ["ls-files", "-v", "-z"]);
        if (flags.stdout.split("\0").some((entry) => /^[a-zS]/.test(entry)))
          throw new AppError(
            409,
            "Index flags can hide changes (assume-unchanged/skip-worktree); branch switch refused",
          );
        // Git preserves conflicting tracked, untracked AND ignored files. Never
        // force, stash, reset, create a branch or bypass another worktree's owner.
        await safeGit(cwd, ["switch", "--no-guess", "--no-overwrite-ignore", "--", branch]);
      }
      // Release immediately before the synchronous binding so no other HHU
      // operation can switch branches between checkout and Conversation creation.
      release();
      return this.store.addConversation(projectId, title);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        409,
        "Unable to switch shared workspace branch. Check the local branch, conflicting changes or another Worktree using it; no force or stash was attempted",
      );
    } finally {
      release();
    }
  }
}

export { changes, patch } from "./changes";
export { Runtime } from "./runtime";

export { workspaceFolder } from "./workspace-location";
