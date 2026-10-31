import { z } from "zod";
import { type RuntimeStatus, turnInput } from "./runtime";

export const draftInput = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    text: z.string().max(100000),
    pendingSubmission: turnInput.nullable().default(null),
  })
  .strict()
  .refine((d) => !d.pendingSubmission || d.pendingSubmission.message === d.text);
export type Draft = z.infer<typeof draftInput> & { conversationId: string };
export const preferencesPatch = z
  .object({
    lastProjectId: z.string().uuid().nullable().optional(),
    lastConversationId: z.string().uuid().nullable().optional(),
    showActivity: z.boolean().optional(),
  })
  .strict();
export type Preferences = {
  lastProjectId: string | null;
  lastConversationId: string | null;
  showActivity: boolean;
};
export const activeStates = new Set<RuntimeStatus>([
  "PREPARING",
  "RUNNING",
  "WAITING_APPROVAL",
  "CANCELLING",
]);
export const problemStates = new Set<RuntimeStatus>(["ERROR", "INTERRUPTED", "UNCERTAIN"]);
export type Activity = {
  running: number;
  waitingApproval: number;
  pendingApprovals: number;
  problems: number;
  items: {
    conversationId: string;
    projectId: string;
    status: RuntimeStatus;
    activeTurnId: string | null;
    pendingApprovals: number;
  }[];
};
