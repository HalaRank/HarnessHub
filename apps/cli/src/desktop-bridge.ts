import { PROTOCOL_VERSION, VERSION } from "@harnesshub/shared";
import { ensureDaemon } from "./lifecycle";

// Private stdout protocol for the Windows main process. Never log this response.
export async function desktopBridge(args: string[]) {
  if (args.length !== 2 || args[0] !== VERSION || args[1] !== String(PROTOCOL_VERSION)) {
    console.log(JSON.stringify({ bridgeVersion: 1, error: "INCOMPATIBLE" }));
    process.exitCode = 1;
    return;
  }
  try {
    const client = await ensureDaemon();
    await client.health();
    console.log(JSON.stringify({ bridgeVersion: 1, instance: client.instance }));
  } catch (error) {
    console.log(
      JSON.stringify({
        bridgeVersion: 1,
        error:
          error instanceof Error && /incompatible|mismatch/i.test(error.message)
            ? "INCOMPATIBLE"
            : "START_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
