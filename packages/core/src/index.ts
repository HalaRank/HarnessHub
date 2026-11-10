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
    if (baseBranch && workspaceMode !== "worktree")
      throw new AppError(400, "A starting branch requires a Git Worktree");
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
}

export { changes, patch } from "./changes";
export { Runtime } from "./runtime";

export { workspaceFolder } from "./workspace-location";
