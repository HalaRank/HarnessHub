import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { AgentApp, ndJsonStream } from "@agentclientprotocol/sdk";

if (process.argv.includes("--descendant")) {
  if (!process.env.HHU_DESCENDANT_COOPERATIVE) process.on("SIGTERM", () => {});
  if (process.env.HHU_DESCENDANT_PID_FILE)
    writeFileSync(process.env.HHU_DESCENDANT_PID_FILE, String(process.pid));
  process.send?.("ready");
  const tick = () => {
    if (process.env.HHU_DESCENDANT_TICK)
      writeFileSync(process.env.HHU_DESCENDANT_TICK, String(Date.now()));
  };
  tick();
  setInterval(tick, 25);
} else {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--descendant"], {
    stdio: [
      "ignore",
      process.argv.includes("--no-pipes") ? "ignore" : process.stdout,
      process.argv.includes("--no-pipes") ? "ignore" : process.stderr,
      "ipc",
    ],
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
