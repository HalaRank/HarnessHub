import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { AppError } from "@harnesshub/shared";

// Read-only, bounded to the Conversation workspace; never opens or executes a file.
export async function workspaceFolder(workspace: string, path?: string) {
  if (
    path &&
    (path.includes("\\") ||
      Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      path.split("/").some((p) => p === ".." || p === "."))
  )
    throw new AppError(400, "Unsafe navigation path");
  const root = await realpath(workspace);
  const inside = (value: string) => {
    const rel = relative(root, value);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new AppError(400, "Navigation is outside Conversation workspace");
  };
  let candidate = path ? resolve(root, path) : root;
  inside(candidate);
  // Deleted files locate the closest existing parent. Resolve symlinks in WSL.
  for (;;) {
    try {
      const actual = await realpath(candidate);
      inside(actual);
      const info = await stat(actual);
      return { linuxPath: info.isDirectory() ? actual : dirname(actual) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || candidate === root) throw error;
      candidate = dirname(candidate);
      inside(candidate);
    }
  }
}
