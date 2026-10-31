import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { AgentApp, ndJsonStream } from "@agentclientprotocol/sdk";

if (process.argv.includes("--descendant")) {
  process.on("SIGTERM", () => {});
  process.send?.("ready");
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--descendant"], {
    stdio: ["ignore", process.stdout, process.stderr, "ipc"],
  });
  const ready = once(child, "message");
  const app = new AgentApp().onRequest("initialize", async ({ params }) => {
    await ready;
    return { protocolVersion: params.protocolVersion };
  });
  const conn = app.connect(
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
  // Inherit the adapter's pipes but not detached: this is the same isolated Worker process group.
  await conn.closed;
  process.exit(0);
}
