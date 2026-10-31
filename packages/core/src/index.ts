import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { AppError } from "@harnesshub/shared";
import type { Store } from "@harnesshub/storage";

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
  constructor(readonly store: Store) {}
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
  createConversation(projectId: string, title: string) {
    projectRoot(this.store.getProject(projectId).rootPath);
    return this.store.addConversation(projectId, title);
  }
}
