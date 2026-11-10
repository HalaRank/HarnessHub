import { PROTOCOL_VERSION, VERSION } from "@harnesshub/shared";
import { Client, readInstance } from "@harnesshub/shared/client";
import {
  type BridgeDiagnostics,
  upgradeReadinessSchema,
} from "../../../packages/shared/src/desktop-release";
import { ensureDaemon } from "./lifecycle";

async function diagnostics(): Promise<BridgeDiagnostics> {
  const result: BridgeDiagnostics = {
    bridgeVersion: VERSION,
    bridgeProtocol: PROTOCOL_VERSION,
    daemonVersion: null,
    daemonProtocol: null,
    instanceId: null,
    readiness: null,
  };
  const instance = readInstance();
  if (!instance) return result;
  try {
    const client = new Client(instance);
    const health = await client.request<{
      product: string;
      runtime: string;
      pid: number;
      instanceId: string;
      version: string;
      protocolVersion: number;
    }>("/v1/health");
    if (
      health.product !== "HarnessHub" ||
      health.runtime !== "node" ||
      health.pid !== instance.pid ||
      health.instanceId !== instance.instanceId
    )
      return result;
    result.daemonVersion = health.version;
    result.daemonProtocol = health.protocolVersion;
    result.instanceId = health.instanceId;
    if (health.protocolVersion === PROTOCOL_VERSION) {
      const parsed = upgradeReadinessSchema.safeParse(
        await client.request("/v1/daemon/upgrade-readiness"),
      );
      if (parsed.success) result.readiness = parsed.data;
    }
  } catch {
    /* Unreachable or older backend: readiness stays unknown. No stop/start side effect. */
  }
  return result;
}

// Private stdout protocol for the Windows main process. Never log this response.
export async function desktopBridge(args: string[]) {
  if (args.length !== 2 || args[0] !== VERSION || args[1] !== String(PROTOCOL_VERSION)) {
    console.log(
      JSON.stringify({ bridgeVersion: 1, error: "INCOMPATIBLE", diagnostics: await diagnostics() }),
    );
    process.exitCode = 1;
    return;
  }
  try {
    const client = await ensureDaemon();
    await client.health();
    console.log(
      JSON.stringify({
        bridgeVersion: 1,
        instance: client.instance,
        diagnostics: await diagnostics(),
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        bridgeVersion: 1,
        diagnostics: await diagnostics(),
        error:
          error instanceof Error && /incompatible|mismatch/i.test(error.message)
            ? "INCOMPATIBLE"
            : "START_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
