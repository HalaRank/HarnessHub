import { z } from "zod";

export const handoffStates = [
  "PENDING",
  "GENERATING",
  "READY",
  "DELIVERING",
  "COMMITTED",
  "FAILED",
  "UNCERTAIN",
  "CANCELLED",
] as const;
export type HandoffStatus = (typeof handoffStates)[number];
export const harnessSelection = z.object({ harnessId: z.string().min(1).max(80) }).strict();
export const handoffAction = z
  .object({ handoffId: z.string().uuid(), action: z.enum(["retry", "confirm", "cancel"]) })
  .strict();
export type Handoff = {
  id: string;
  conversationId: string;
  sourceHarness: string;
  targetHarness: string;
  sourceNativeSessionId: string;
  targetNativeSessionId: string | null;
  sourceEventStart: number;
  sourceEventEnd: number;
  reportText: string | null;
  fallbackText: string | null;
  fallbackSources: unknown;
  status: HandoffStatus;
  firstTargetRequestId: string;
  userTurnId: string;
  internalTurnId: string | null;
  userMessage: string;
  degraded: boolean;
  confirmedAt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  generatedAt: number | null;
  committedAt: number | null;
};
export type ManagedWorktree = {
  id: string;
  projectId: string | null;
  repositoryPath: string;
  path: string;
  branch: string;
  ownerRoot: string;
  status: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
