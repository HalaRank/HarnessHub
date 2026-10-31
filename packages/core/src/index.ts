import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { AppError } from "@harnesshub/shared";
import type { Store } from "@harnesshub/storage";
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
  async createConversation(
    projectId: string,
    title: string,
    workspaceMode: "shared" | "worktree" = "shared",
  ) {
    projectRoot(this.store.getProject(projectId).rootPath);
    const workspace =
      workspaceMode === "worktree" ? await this.worktrees.create(projectId) : undefined;
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
