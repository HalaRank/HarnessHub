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
