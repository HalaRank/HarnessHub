import { z } from "zod";
import { type RuntimeStatus, turnInput } from "./runtime";

export const draftInput = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    text: z.string().max(100000),
    pendingSubmission: turnInput.nullable().default(null),
  })
  .strict()
  .refine((d) => !d.pendingSubmission || d.text === "" || d.pendingSubmission.message === d.text);
export type Draft = z.infer<typeof draftInput> & { conversationId: string };
export const navigationShortcuts = {
  quit: "",
  project: "",
  conversation: "n",
  standaloneConversation: "ctrl+n",
  actions: "",
  activity: "",
  message: "",
  approval: "",
  harness: "",
  cancel: "escape",
  cancelSwitch: "",
  handoff: "",
  nextTool: "",
  expand: "",
  source: "",
  copySource: "",
  refreshChanges: "",
} as const;
export const shortcutNames = ["palette", "sidebar", "newline", "changes", "copy"] as const;
export const defaultShortcuts = {
  palette: "",
  sidebar: "",
  newline: "ctrl+j",
  changes: "",
  copy: "ctrl+o",
};
export const shortcutInput = z
  .partialRecord(
    z.enum(shortcutNames),
    z
      .string()
      .regex(/^(?:(?:ctrl\+)?(?:meta\+)?(?:shift\+)?[a-z0-9]+)?$/)
      .max(60),
  )
  .refine((value) => {
    // Context matters: reject editor/navigation chords even when all strings differ.
    // Ctrl+B is the explicitly supported sidebar override of native cursor-left.
    const editing = new Set([
      "ctrl+a",
      "ctrl+e",
      "ctrl+f",
      "ctrl+b",
      "ctrl+w",
      "ctrl+d",
      "ctrl+k",
      "ctrl+u",
      "ctrl+h",
      "ctrl+i",
      "ctrl+m",
      "ctrl+j",
      "ctrl+shift+a",
      "ctrl+shift+e",
      "ctrl+shift+d",
      "meta+a",
      "meta+e",
      "meta+d",
      "meta+f",
      "meta+b",
      "meta+shift+a",
      "meta+shift+e",
    ]);
    const effective = { ...defaultShortcuts, ...value };
    return (
      Object.entries(value).every(([action, key]) => {
        if (key === "") return true;
        if (["ctrl+r", "ctrl+t"].includes(key)) return false;
        if (action === "copy" && key === defaultShortcuts.copy) return true;
        if (Object.values(navigationShortcuts).some((reserved) => reserved === key)) return false;
        if (action === "newline" && key === "meta+return") return true;
        const name = key.split("+").at(-1) ?? "";
        if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/.test(name)) return false;
        if (!/^(ctrl|meta)\+/.test(key) || /^(?:ctrl\+)?(?:meta\+)?(?:shift\+)?[cq]$/.test(key))
          return false;
        if (editing.has(key))
          return (
            (action === "sidebar" && key === "ctrl+b") ||
            (action === "newline" && key === "ctrl+j") ||
            (action === "changes" && key === "ctrl+d")
          );
        return true;
      }) &&
      new Set(Object.values(effective).filter(Boolean)).size ===
        Object.values(effective).filter(Boolean).length
    );
  }, "Use distinct canonical Ctrl/Meta shortcuts; editor, fixed navigation and quit keys are reserved (Changes is navigation-only)");
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
    projectId: string | null;
    status: RuntimeStatus;
    activeTurnId: string | null;
    pendingApprovals: number;
  }[];
};
