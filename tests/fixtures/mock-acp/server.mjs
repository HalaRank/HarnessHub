import { Readable, Writable } from "node:stream";
import { AgentApp, ndJsonStream } from "@agentclientprotocol/sdk";

let current;
let cancelled = false;
let prompts = 0;
const sessionId = "mock-native-session";
const configOptions = [
  {
    id: "model",
    name: "Native Model",
    type: "select",
    category: "model",
    currentValue: "mock-model",
    options: [
      { value: "mock-model", name: "Mock" },
      { value: "other", name: "Other" },
    ],
  },
];
const update = (client, value) => client.notify("session/update", { sessionId, update: value });
const text = (client, value) =>
  update(client, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
const app = new AgentApp()
  .onRequest("initialize", async ({ params }) => {
    if (process.env.HHU_MOCK_INIT_DELAY)
      await new Promise((r) => setTimeout(r, Number(process.env.HHU_MOCK_INIT_DELAY)));
    return {
      protocolVersion: params.protocolVersion,
      agentInfo: { name: "HarnessHub Mock", version: "1" },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        sessionCapabilities: { close: {} },
      },
    };
  })
  .onRequest("session/new", ({ params }) => {
    if (params.cwd !== process.cwd() || !params.cwd.startsWith("/"))
      throw new Error("Incorrect cwd");
    return {
      sessionId,
      configOptions,
      modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Native ask" }] },
      _meta: { workerCwd: process.cwd(), inheritedCredential: !!process.env.HHU_TEST_API_KEY },
    };
  })
  .onRequest("session/set_config_option", ({ params }) => ({
    configOptions: configOptions.map((o) => ({ ...o, currentValue: params.value })),
  }))
  .onRequest("session/set_mode", () => ({}))
  .onRequest("session/close", async () => {
    if (process.env.HHU_MOCK_CLOSE_DELAY)
      await new Promise((r) => setTimeout(r, Number(process.env.HHU_MOCK_CLOSE_DELAY)));
    return {};
  })
  .onNotification("session/cancel", () => {
    cancelled = true;
    current?.();
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    prompts++;
    cancelled = false;
    const message = params.prompt[0].text;
    if (message === "long-history" || message === "timed") {
      const count = message === "long-history" ? 2505 : 35;
      for (let i = 0; i < count; i++) {
        await text(client, `native-${i} 世界\n`);
        if (message === "timed") await new Promise((r) => setTimeout(r, 35));
      }
      return { stopReason: "end_turn" };
    }
    if (message === "crash") {
      await text(client, "before crash");
      setTimeout(() => process.exit(17), 30);
      await new Promise(() => {});
    }
    if (message === "disconnect") {
      await text(client, "before disconnect");
      process.stdout.end();
      await new Promise(() => {});
    }
    if (message === "wait" || message === "ignore-cancel") {
      await text(client, "started");
      if (message === "ignore-cancel") await new Promise(() => {});
      else
        await new Promise((resolve) => {
          current = resolve;
          if (cancelled) resolve();
        });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await text(client, "native tail after cancellation");
      await update(client, {
        sessionUpdate: "tool_call_update",
        toolCallId: "native-tool",
        status: "failed",
        rawOutput: "cancel tail",
      });
      return { stopReason: "cancelled" };
    }
    if (message === "permission" || message === "permissions") {
      const request = () =>
        client.request("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: "native-tool",
            title: "Native Dangerous Tool",
            rawInput: { command: "mock only" },
          },
          options: [
            { optionId: "native-allow-once", name: "Allow once (native)", kind: "allow_once" },
            { optionId: "native-reject", name: "Reject (native)", kind: "reject_once" },
          ],
        });
      const result = await Promise.all(
        Array.from({ length: message === "permissions" ? 2 : 1 }, request),
      );
      await text(client, JSON.stringify(result));
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    }
    await text(client, `cwd=${process.cwd()};prompts=${prompts}\n`);
    await Promise.all(Array.from({ length: 40 }, (_, i) => text(client, `**native-${i}**\n`)));
    await update(client, {
      sessionUpdate: "tool_call",
      toolCallId: "native-tool",
      title: "Exact Native Tool Name",
      status: "in_progress",
      rawInput: { value: "verbatim", api_key: "not-a-real-secret" },
    });
    await update(client, {
      sessionUpdate: "tool_call_update",
      toolCallId: "native-tool",
      status: "completed",
      rawOutput: { markdown: "```native\noutput\n```" },
    });
    await client.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "future_update", content: { untouched: true } },
    });
    await client.notify("_custom/notice", { original: "unknown extension" });
    return { stopReason: "end_turn" };
  });
const conn = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
await conn.closed;
process.exit(0);
