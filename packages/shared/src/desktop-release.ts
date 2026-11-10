import { z } from "zod";

// Safe, non-secret diagnostics. Unknown/older backends never imply upgrade readiness.
export const upgradeReadinessSchema = z.object({
  safeToStop: z.boolean(),
  checkedAt: z.number(),
  blockers: z.array(z.string().max(200)),
});
export const bridgeDiagnosticsSchema = z.object({
  bridgeVersion: z.string().max(100),
  bridgeProtocol: z.number().int(),
  daemonVersion: z.string().max(100).nullable(),
  daemonProtocol: z.number().int().nullable(),
  instanceId: z.string().uuid().nullable(),
  readiness: upgradeReadinessSchema.nullable(),
});
export type BridgeDiagnostics = z.infer<typeof bridgeDiagnosticsSchema>;
