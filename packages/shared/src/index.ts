import { z } from "zod";

export const VERSION = "0.2.0";
export * from "./runtime";

import type { RuntimeStatus } from "./runtime";
export const PROTOCOL_VERSION = 1;
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
export const conversationInput = z.object({ title: z.string().trim().min(1).max(200) }).strict();
export type Project = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
};
export type Conversation = {
  id: string;
  projectId: string;
  title: string;
  workspaceMode: "shared";
  workspacePath: string;
  runtimeStatus: RuntimeStatus;
  createdAt: number;
  updatedAt: number;
};
export type ChangeEvent = { seq: number; type: string; entityId: string; createdAt: number };
export type Snapshot = { projects: Project[]; conversations: Conversation[]; cursor: number };
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
