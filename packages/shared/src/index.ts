import { z } from "zod";

export const VERSION = "0.6.2";
export * from "./changes";
export * from "./handoff";
export * from "./native-commands";
export * from "./runtime";
export * from "./session-state";

import type { RuntimeStatus } from "./runtime";
export const PROTOCOL_VERSION = 1;
export const NEW_CONVERSATION_TITLE = "New conversation";
export const projectInput = z
  .object({
    rootPath: z.string().min(1).max(4096),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export const projectPatch = z
  .object({
    rootPath: z.string().min(1).max(4096).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const conversationInput = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    workspaceMode: z.enum(["shared", "worktree"]).optional(),
    baseBranch: z.string().min(1).max(1024).optional(),
  })
  .strict();
export const conversationPatch = conversationInput
  .omit({ workspaceMode: true, baseBranch: true })
  .partial()
  .extend({ archived: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const standaloneConversationInput = z
  .object({
    workspacePath: z.string().min(1).max(4096),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const conversationDeleteInput = z.object({ confirmed: z.literal(true) }).strict();
export const projectDeleteInput = conversationDeleteInput;
export type Project = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
};
export type ProjectBranches = {
  isGit: boolean;
  hasCommits: boolean;
  currentBranch: string | null;
  branches: string[];
};
export type Conversation = {
  id: string;
  projectId: string | null;
  title: string;
  archivedAt: number | null;
  workspaceMode: "shared" | "worktree";
  activeNativeSessionId?: string | null;
  selectedHarnessId?: string | null;
  worktreeId?: string | null;
  workspacePath: string;
  runtimeStatus: RuntimeStatus;
  createdAt: number;
  updatedAt: number;
};
export type ChangeEvent = { seq: number; type: string; entityId: string; createdAt: number };
export type Snapshot = {
  pendingInputs?: import("./runtime").PendingInput[];
  projects: Project[];
  conversations: Conversation[];
  cursor: number;
  activity: import("./session-state").Activity;
};
export type Instance = {
  pid: number;
  port: number;
  token: string;
  instanceId: string;
  version: string;
  protocolVersion: number;
};
export class AppError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
