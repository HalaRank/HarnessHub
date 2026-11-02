import { z } from "zod";
import type { NativeSession } from "./runtime";

// ACP v1 only. Do not interpret v2/draft command variants as v1 commands.
export const nativeCommandList = z.array(
  z.object({
    name: z.string(),
    description: z.string(),
    input: z.object({ hint: z.string() }).nullish(),
  }),
);
export type NativeCommand = z.infer<typeof nativeCommandList>[number];
export type NativeCommands = { agentSessionId: string; availableCommands: NativeCommand[] };
export function sessionCommands(session: NativeSession | undefined): NativeCommand[] | undefined {
  if (session?.status !== "READY" || session.endedAt !== null) return undefined;
  const state = (session.capabilities as { commands?: NativeCommands } | null)?.commands;
  if (!state || state.agentSessionId !== session.agentSessionId) return undefined;
  const parsed = nativeCommandList.safeParse(state.availableCommands);
  return parsed.success ? parsed.data : undefined;
}
