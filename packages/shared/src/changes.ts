import { z } from "zod";

// Only provenance references cross Desktop IPC. The Daemon resolves actual paths.
export const workspaceLocationInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z.object({ kind: z.literal("change"), path: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      kind: z.literal("tool"),
      seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      collection: z.enum(["locations", "content"]),
      index: z.number().int().nonnegative().max(10000),
    })
    .strict(),
]);
export type WorkspaceLocation = z.infer<typeof workspaceLocationInput>;
export type GitFile = { path: string; previousPath?: string; index: string; worktree: string };
export type GitChanges = {
  workspace: string;
  repository: string | null;
  files: GitFile[];
  observedAt: number;
  notice: string;
};
export type GitPatch = {
  path: string;
  staged: string;
  unstaged: string;
  untracked: string;
  observedAt: number;
};
