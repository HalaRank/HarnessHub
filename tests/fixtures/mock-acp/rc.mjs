import { existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { AgentApp, ndJsonStream } from "@agentclientprotocol/sdk";

const mode = process.env.HHU_RC_MODE;
const wait = async () => {
  while (!existsSync(process.env.HHU_RC_GATE)) await new Promise((r) => setTimeout(r, 20));
};
const app = new AgentApp()
  .onRequest("initialize", ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
    _meta: { steering: { supported: true } },
  }))
  .onRequest("session/new", () => ({ sessionId: "rc-native" }))
  .onRequest("session/prompt", async ({ client }) => {
    if (mode === "uncertain-exit") {
      setTimeout(() => process.exit(0), 300);
      throw new Error("Prompt outcome remains unknown to host");
    }
    if (mode === "approval") {
      const toolCall = {
        toolCallId: "rc-tool",
        title: "Harmless mock permission",
        status: "pending",
        kind: "other",
      };
      await client.notify("session/update", {
        sessionId: "rc-native",
        update: { sessionUpdate: "tool_call", ...toolCall },
      });
      await client.request("session/request_permission", {
        sessionId: "rc-native",
        toolCall,
        options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
      });
    }
    if (mode === "active" || mode?.startsWith("steer-")) await wait();
    if (mode === "idle-exit") setTimeout(() => process.exit(0), 150);
    if (mode === "stream-only")
      setTimeout(() => {
        process.stdout.end();
        void wait().then(() => process.exit(0));
      }, 150);
    return { stopReason: "end_turn" };
  })
  .onRequest("*", async ({ method }) => {
    if (method !== "_session/steering") throw new Error("Unsupported request");
    if (mode === "steer-ack") return { outcome: "injected" };
    if (mode === "steer-failed") return { outcome: "failed" };
    if (mode === "steer-unknown") return { outcome: "unknown" };
    await new Promise(() => {});
  });
app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
