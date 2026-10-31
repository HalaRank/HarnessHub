import { z } from "zod";

export const runtimeStates = [
  "IDLE",
  "PREPARING",
  "RUNNING",
  "WAITING_APPROVAL",
  "CANCELLING",
  "ERROR",
  "INTERRUPTED",
  "UNCERTAIN",
] as const;
export type RuntimeStatus = (typeof runtimeStates)[number];
export const profileInput = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    name: z.string().min(1).max(120),
    command: z.string().min(1).max(4096),
    args: z.array(z.string()).max(100).default([]),
    envOverrides: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  })
  .strict();
export type HarnessProfile = z.infer<typeof profileInput>;
// Overrides are private launch metadata, never a credential store. Workers inherit process.env.
export function sensitiveEnvKeys(profile: HarnessProfile) {
  return Object.keys(profile.envOverrides).filter((key) =>
    /api_?key|(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTHORIZATION|COOKIE|PRIVATE_KEY)(?:_|$)/i.test(
      key,
    ),
  );
}
export const turnInput = z
  .object({
    requestId: z.string().uuid(),
    harnessId: z.string().min(1).max(80),
    message: z.string().min(1).max(100000),
  })
  .strict();
export const decisionInput = z.object({ optionId: z.string().min(1) }).strict();
export const settingInput = z.union([
  z.object({ kind: z.literal("mode"), modeId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("config"),
      configId: z.string().min(1),
      value: z.union([z.string(), z.boolean()]),
    })
    .strict(),
]);
export type ConversationEvent = {
  id: string;
  conversationId: string;
  nativeSessionId: string | null;
  turnId: string | null;
  seq: number;
  raw: unknown;
  kind: string;
  payload: unknown;
  origin: "agent" | "client" | "runtime";
  createdAt: number;
};
export type Turn = {
  id: string;
  conversationId: string;
  nativeSessionId: string | null;
  requestId: string;
  requestHash: string;
  harnessId: string;
  state: string;
  stopReason: string | null;
  startEventSeq: number | null;
  finishEventSeq: number | null;
  createdAt: number;
  endedAt: number | null;
};
export type NativeSession = {
  id: string;
  conversationId: string;
  harnessId: string;
  agentSessionId: string | null;
  workerId: string;
  epoch: string;
  status: string;
  capabilities: unknown;
  cwd: string;
  createdAt: number;
  endedAt: number | null;
};
export type Approval = {
  id: string;
  conversationId: string;
  nativeSessionId: string;
  turnId: string;
  acpRequestId: string;
  request: unknown;
  status: string;
  selectedOptionId: string | null;
  createdAt: number;
  endedAt: number | null;
};
// Redact only structured credential fields. Native prose/Markdown/tool output is left intact.
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(authorization|proxy-authorization|(?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token)|token|password|secret)$/i.test(
          key,
        )
          ? "[REDACTED]"
          : redact(entry),
      ]),
    );
  return value;
}
