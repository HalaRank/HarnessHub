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
export const shortcutNames = ["palette", "sidebar", "newline", "changes", "copy"] as const;
export const defaultShortcuts = {
  palette: "ctrl+p",
  sidebar: "ctrl+b",
  newline: "ctrl+j",
  changes: "ctrl+d",
  copy: "ctrl+y",
};
export const shortcutInput = z
  .partialRecord(
    z.enum(shortcutNames),
    z
      .string()
      .regex(/^(?:ctrl\+)?(?:meta\+)?(?:shift\+)?[a-z0-9]+$/)
      .max(60),
  )
  .refine((value) => {
    const reserved = new Set(["return", "shift+return", "escape", "ctrl+c", "ctrl+q"]);
    const effective = { ...defaultShortcuts, ...value };
    return (
      Object.values(value).every((key) => !reserved.has(key) && /^(ctrl|meta)\+/.test(key)) &&
      new Set(Object.values(effective)).size === Object.values(effective).length
    );
  }, "Use distinct Ctrl/Meta shortcuts; Enter, Shift+Enter, Esc and quit are reserved");
export type Shortcuts = z.infer<typeof shortcutInput>;
export const preferencesPatch = z
  .object({
    lastProjectId: z.string().uuid().nullable().optional(),
    lastConversationId: z.string().uuid().nullable().optional(),
    showActivity: z.boolean().optional(),
    showSidebar: z.boolean().optional(),
    shortcuts: shortcutInput.optional(),
  })
  .strict();
export type Preferences = {
  lastProjectId: string | null;
  lastConversationId: string | null;
  showActivity: boolean;
  showSidebar: boolean;
  shortcuts: Shortcuts;
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
