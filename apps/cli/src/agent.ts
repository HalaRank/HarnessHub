import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Turn } from "@harnesshub/shared";
import { watchConversation } from "@harnesshub/shared/client";
import { ensureDaemon } from "./lifecycle";

export async function agentCommand(args: string[]) {
  const [action, id, value, message, requestId] = args;
  if (!action || action === "--help") {
    console.log(`HarnessHub ACP (Phase 3)
  hhu agent list
  hhu agent register <profile.json>   # command/args/envOverrides; no shell expansion
  hhu agent session <conversationId> <harnessId>
  hhu agent prompt <conversationId> <harnessId> <message> [requestId]
  hhu agent watch <conversationId> [afterSeq]
  hhu agent status <turnId>
  hhu agent cancel <turnId>
  hhu agent approvals <conversationId>
  hhu agent decide <approvalId> <nativeOptionId>
  hhu agent settings <conversationId> <json>
  hhu agent stop <conversationId>
  hhu agent export <conversationId> [chat|debug] [new-output-file]
Prompt returns immediately. Use watch/status/approvals to follow it. Reuse requestId only for the identical request after an uncertain HTTP response.`);
    return;
  }
  const client = await ensureDaemon();
  const output = (data: unknown) => console.log(JSON.stringify(data, null, 2));
  if (action === "list") {
    output(await client.request("/v1/diagnostics"));
    return;
  }
  if (action === "register" && id) {
    output(
      await client.request("/v1/harness-profiles", "POST", JSON.parse(readFileSync(id, "utf8"))),
    );
    return;
  }
  if (!id) throw new Error("Missing ID; see hhu agent --help");
  switch (action) {
    case "session":
      if (!value) throw new Error("Missing harnessId");
      output(
        await client.request(
          `/v1/conversations/${id}/sessions`,
          "POST",
          { harnessId: value },
          45000,
        ),
      );
      return;
    case "prompt": {
      if (!value || !message) throw new Error("Missing harnessId or message");
      const key = requestId ?? randomUUID();
      // Print the deduplication key before submitting, even if the HTTP response is lost.
      console.error(`requestId=${key}`);
      output(
        await client.request<Turn>(`/v1/conversations/${id}/turns`, "POST", {
          harnessId: value,
          message,
          requestId: key,
        }),
      );
      return;
    }
    case "watch": {
      const after = Number(value ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid event cursor");
      const stop = watchConversation(
        id,
        (event) => console.log(JSON.stringify(event)),
        (state) => console.error(state),
        after,
      );
      await new Promise<void>((resolve) => {
        const end = () => {
          stop();
          resolve();
        };
        process.once("SIGINT", end);
        process.once("SIGTERM", end);
      });
      return;
    }
    case "status":
      output(await client.request(`/v1/turns/${id}`));
      return;
    case "cancel":
      output(await client.request(`/v1/turns/${id}/cancel`, "POST"));
      return;
    case "approvals":
      output(await client.request(`/v1/conversations/${id}/approvals`));
      return;
    case "decide":
      if (!value) throw new Error("Missing Agent optionId");
      output(await client.request(`/v1/approvals/${id}/decision`, "POST", { optionId: value }));
      return;
    case "settings":
      if (!value) throw new Error("Missing settings JSON");
      output(
        await client.request(`/v1/conversations/${id}/settings`, "POST", JSON.parse(value), 30000),
      );
      return;
    case "stop":
      output(
        await client.request(
          `/v1/conversations/${id}/session/stop`,
          "POST",
          { force: false },
          15000,
        ),
      );
      return;
    case "export": {
      const format = value ?? "chat";
      if (format !== "chat" && format !== "debug")
        throw new Error("Export format must be chat or debug");
      const result = await client.request<{ markdown: string }>(
        `/v1/conversations/${id}/export?format=${format}`,
        "GET",
        undefined,
        30000,
      );
      const serialized = format === "chat" ? result.markdown : JSON.stringify(result, null, 2);
      if (message) {
        writeFileSync(message, serialized, { mode: 0o600, flag: "wx" });
        console.log(
          `Exported ${format} to ${message} (private file; native conversation content may be sensitive)`,
        );
      } else console.log(serialized);
      return;
    }
    default:
      throw new Error("Unknown agent command; see hhu agent --help");
  }
}
