import type { ConversationEvent, Snapshot } from "@harnesshub/shared";
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
};
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
  z.object({ type: z.literal("select"), conversationId: z.string().uuid() }).strict(),
]);
export type DesktopRequest = z.infer<typeof desktopRequest>;
export type DesktopReply =
  | { ok: true; state: DesktopState; distributions?: Distribution[] }
  | { ok: false; error: string };
export type DesktopApi = {
  request: (request: DesktopRequest) => Promise<DesktopReply>;
  subscribe: (callback: (state: DesktopState) => void) => () => void;
};
export const IPC_REQUEST = "hhu:desktop:request";
export const IPC_STATE = "hhu:desktop:state";
