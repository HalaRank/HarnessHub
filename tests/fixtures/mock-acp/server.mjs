import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { AgentApp, ndJsonStream } from "@agentclientprotocol/sdk";

let current;
let cancelled = false;
let prompts = 0;
if (process.env.HHU_MOCK_EXIT_GATE) process.on("SIGTERM", () => {});
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
      ...(process.env.HHU_MOCK_STEERING ? { _meta: { steering: { supported: true } } } : {}),
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: process.env.HHU_MOCK_IMAGES ? { image: true } : {},
        sessionCapabilities: { close: {} },
      },
    };
  })
  .onRequest("session/new", async ({ params, client }) => {
    if (process.env.HHU_MOCK_NEW_FAIL) throw new Error("mock new failed");
    if (params.cwd !== process.cwd() || !params.cwd.startsWith("/"))
      throw new Error("Incorrect cwd");
    if (process.env.HHU_MOCK_CHAT_DIAGNOSTICS)
      await client.notify("_auth/status_update", {
        authStatus: { kind: "gateway", label: "Custom model gateway", detail: "codeforce" },
      });
    if (process.env.HHU_MOCK_COMMANDS)
      await update(client, {
        sessionUpdate: "available_commands_update",
        availableCommands: JSON.parse(process.env.HHU_MOCK_COMMANDS),
      });
    return {
      sessionId,
      configOptions,
      modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Native ask" }] },
      _meta: {
        workerCwd: process.cwd(),
        workerPid: process.pid,
        inheritedCredential: !!process.env.HHU_TEST_API_KEY,
      },
    };
  })
  .onRequest("session/set_config_option", async ({ params }) => {
    if (process.env.HHU_MOCK_CONFIG_DELAY)
      await new Promise((r) => setTimeout(r, Number(process.env.HHU_MOCK_CONFIG_DELAY)));
    return { configOptions: configOptions.map((o) => ({ ...o, currentValue: params.value })) };
  })
  .onRequest("session/set_mode", () => ({}))
  .onRequest("session/close", async () => {
    if (process.env.HHU_MOCK_CLOSE_DELAY)
      await new Promise((r) => setTimeout(r, Number(process.env.HHU_MOCK_CLOSE_DELAY)));
    return {};
  })
  .onRequest(
    "_session/steering",
    (params) => params,
    async ({ params, client }) => {
      if (process.env.HHU_MOCK_STEERING === "disconnect") {
        process.stdout.end();
        setTimeout(() => process.exit(19), 30);
        await new Promise(() => {});
      }
      if (process.env.HHU_MOCK_STEERING === "idle") return { outcome: "promptRequired" };
      await text(client, `steered=${params.prompt[0].text}\n`);
      return { outcome: "injected" };
    },
  )
  .onNotification("session/cancel", () => {
    cancelled = true;
    current?.();
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    prompts++;
    cancelled = false;
    let message = params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const images = params.prompt.filter((block) => block.type === "image");
    if (images.length) {
      if (!process.env.HHU_MOCK_IMAGES) throw new Error("Image capability was not negotiated");
      await text(
        client,
        JSON.stringify({
          images: images.map((image) => ({
            mimeType: image.mimeType,
            digest: createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"),
          })),
        }),
      );
      return { stopReason: "end_turn" };
    }
    if (message === "replace-commands" || message === "clear-commands") {
      await update(client, {
        sessionUpdate: "available_commands_update",
        availableCommands:
          message === "clear-commands"
            ? []
            : [{ name: "fresh", description: "Replacement snapshot" }],
      });
      await text(client, "Commands updated");
      return { stopReason: "end_turn" };
    }
    if (message === "/silent") {
      await text(client, "");
      return { stopReason: "end_turn" };
    }
    if (process.env.HHU_MOCK_CHAT_DIAGNOSTICS && message === "hello") {
      await text(client, "Hello from Agent.");
      return { stopReason: "end_turn" };
    }
    if (message.startsWith("[HarnessHub internal context handoff")) {
      if (process.env.HHU_MOCK_REPORT_DELAY)
        await new Promise((r) => setTimeout(r, Number(process.env.HHU_MOCK_REPORT_DELAY)));
      if (process.env.HHU_MOCK_REPORT_CRASH) {
        process.stdout.end();
        await new Promise(() => {});
      }
      if (process.env.HHU_MOCK_REPORT_FAIL) {
        await text(client, "incomplete report");
        return { stopReason: "end_turn" };
      }
      if (process.env.HHU_MOCK_REPORT_PERMISSION) {
        await client.request("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "report-tool", title: "Native report tool (risk)" },
          options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
        });
      }
      if (process.env.HHU_MOCK_REPORT_TOOL) {
        await update(client, {
          sessionUpdate: "tool_call",
          toolCallId: "report-tool",
          title: "Exact native report tool",
          status: "completed",
          rawOutput: "Mock observable operation",
        });
      }
      if (cancelled) return { stopReason: "cancelled" };
      await text(
        client,
        [
          "Current Objective",
          "User Requirements",
          "Decisions",
          "Completed Work",
          "Remaining Work",
          "Relevant Files",
          "Validation Results",
          "Known Issues",
          "Latest State",
        ]
          .map((h) => `## ${h}\nExact source ${process.cwd()} prompt count ${prompts}\n`)
          .join("\n"),
      );
      return { stopReason: "end_turn" };
    }
    if (message.startsWith("[Historical background")) {
      if (process.env.HHU_MOCK_TARGET_REJECT) throw new Error("target rejection");
      message = message.split("[New user message]\n")[1];
    }
    if (message === "desktop-native-diff") {
      await update(client, {
        sessionUpdate: "tool_call",
        toolCallId: "native-diff",
        title: "Mock native Diff",
        status: "completed",
        locations: [{ path: `${process.cwd()}/sentinel.txt`, line: 1 }],
        content: [
          {
            type: "diff",
            path: `${process.cwd()}/sentinel.txt`,
            oldText: "original\n",
            newText: "native proposed text\n",
          },
        ],
      });
      await text(client, "Native Diff fixture; no files were written");
      return { stopReason: "end_turn" };
    }
    if (message === "desktop-many-tools") {
      for (let i = 0; i < 600; i++) {
        await update(client, {
          sessionUpdate: "tool_call",
          toolCallId: `desktop-${i}`,
          title: `Native tool ${i}`,
          status: "in_progress",
          rawInput: { index: i },
        });
        await update(client, {
          sessionUpdate: "tool_call_update",
          toolCallId: `desktop-${i}`,
          status: "completed",
          rawOutput: `Complete output ${i}`,
        });
      }
      await text(client, "Desktop tools complete");
      return { stopReason: "end_turn" };
    }
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
while (process.env.HHU_MOCK_EXIT_GATE && !existsSync(process.env.HHU_MOCK_EXIT_GATE))
  await new Promise((resolve) => setTimeout(resolve, 25));
process.exit(0);
