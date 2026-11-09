import type {
  Approval,
  ConversationEvent,
  Handoff,
  NativeSession,
  Snapshot,
} from "@harnesshub/shared";
import {
  conversationPatch,
  draftInput,
  handoffAction,
  settingInput,
  turnInput,
  workspaceLocationInput,
} from "@harnesshub/shared";
import { z } from "zod";

export type Distribution = { name: string; version: 1 | 2; state: string; isDefault: boolean };
export type ConnectionStatus =
  | "idle"
  | "starting"
  | "connected"
  | "disconnected"
  | "incompatible"
  | "error";
export type DesktopState = {
  revision: number;
  status: ConnectionStatus;
  detail: string;
  distribution: string | null;
  snapshot: Snapshot | null;
  conversationId: string | null;
  events: ConversationEvent[];
  historyLoading: boolean;
  historyVersion?: number;
  eventCursor?: number;
  interaction?: {
    conversationId: string;
    sessions: NativeSession[];
    approvals: Approval[];
    handoffs: Handoff[];
  } | null;
  profiles?: { id: string; name: string }[];
};
const conversationId = z.string().uuid();
const action = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const desktopRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }).strict(),
  z.object({ type: z.literal("discover") }).strict(),
  z
    .object({
      type: z.literal("connect"),
      distribution: z
        .string()
        .min(1)
        .max(256)
        .refine((v) => Array.from(v).every((char) => char.charCodeAt(0) >= 32)),
    })
    .strict(),
  z.object({ type: z.literal("reconnect") }).strict(),
  z.object({ type: z.literal("select"), conversationId }).strict(),
  action({
    type: z.literal("history"),
    conversationId,
    after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  action({ type: z.literal("changes.list"), conversationId }),
  action({ type: z.literal("changes.diff"), conversationId, path: z.string().min(1).max(4096) }),
  action({ type: z.literal("worktrees.list") }),
  action({
    type: z.literal("worktrees.cleanup"),
    worktreeId: z.string().uuid(),
    confirmed: z.literal(true),
  }),
  action({ type: z.literal("workspace.open"), conversationId, location: workspaceLocationInput }),
  action({ type: z.literal("draft.load"), conversationId }),
  action({ type: z.literal("draft.save"), conversationId, draft: draftInput }),
  action({
    type: z.literal("turn.submit"),
    conversationId,
    revision: z.number().int().nonnegative(),
    input: turnInput,
  }),
  action({ type: z.literal("request.lookup"), conversationId, requestId: z.string().uuid() }),
  action({ type: z.literal("turn.cancel"), conversationId, turnId: z.string().uuid() }),
  action({
    type: z.literal("approval.decide"),
    conversationId,
    approvalId: z.string().uuid(),
    optionId: z.string().min(1).max(1000),
  }),
  action({
    type: z.literal("harness.select"),
    conversationId,
    harnessId: z.string().min(1).max(80),
  }),
  action({
    type: z.literal("session.prepare"),
    conversationId,
    harnessId: z.string().min(1).max(80),
  }),
  action({ type: z.literal("session.settings"), conversationId, setting: settingInput }),
  action({ type: z.literal("handoff.action"), conversationId, input: handoffAction }),
  action({
    type: z.literal("conversation.create"),
    workspaceMode: z.enum(["shared", "worktree"]).optional(),
    projectId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
  }),
  action({
    type: z.literal("conversation.standalone"),
    workspacePath: z.string().startsWith("/").max(4096),
    title: z.string().trim().min(1).max(200),
  }),
  action({ type: z.literal("conversation.patch"), conversationId, patch: conversationPatch }),
  action({ type: z.literal("conversation.delete"), conversationId, confirmed: z.literal(true) }),
  action({ type: z.literal("window.close") }),
  action({ type: z.literal("clipboard.copy"), text: z.string().max(4000000) }),
]);
export type DesktopRequest = z.infer<typeof desktopRequest>;
export type DesktopReply =
  | { ok: true; state: DesktopState; distributions?: Distribution[]; data?: unknown }
  | { ok: false; error: string; status?: number };
export type DesktopApi = {
  request: (request: DesktopRequest) => Promise<DesktopReply>;
  subscribe: (callback: (state: DesktopState) => void) => () => void;
};
export const IPC_REQUEST = "hhu:desktop:request";
export const IPC_STATE = "hhu:desktop:state";
