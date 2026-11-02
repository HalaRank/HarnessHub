// Deterministic post-audit fault combinations. No native credentials or tools.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const headings = [
  "Current Objective",
  "User Requirements",
  "Decisions",
  "Completed Work",
  "Remaining Work",
  "Relevant Files",
  "Validation Results",
  "Known Issues",
  "Latest State",
];
let mode = "old";
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize")
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
      },
    });
  else if (m.method === "session/new") {
    if (process.env.HHU_AUDIT_NEW_GATE && !existsSync(process.env.HHU_AUDIT_NEW_GATE))
      send({ id: m.id, error: { code: -32603, message: "injected preparation failure" } });
    else
      send({
        id: m.id,
        result: {
          sessionId: "audit",
          modes: {
            currentModeId: mode,
            availableModes: [
              { id: "old", name: "Old" },
              { id: "new", name: "New" },
            ],
          },
        },
      });
  } else if (m.method === "session/set_mode") {
    if (process.env.HHU_AUDIT_SETTING_WAIT) return;
    await new Promise((r) => setTimeout(r, Number(process.env.HHU_AUDIT_SETTING_DELAY ?? 0)));
    mode = m.params.modeId;
    send({ id: m.id, result: {} }); // Deliberately no mode-update notification.
  } else if (m.method === "session/prompt") {
    const prompt = m.params.prompt[0].text;
    const report = prompt.startsWith("[HarnessHub internal");
    const complete =
      !process.env.HHU_AUDIT_REPORT_GATE || existsSync(process.env.HHU_AUDIT_REPORT_GATE);
    const text = report
      ? complete
        ? headings.map((h) => `## ${h}\nFRESH_REPORT`).join("\n")
        : "incomplete report"
      : `executing in ${mode}`;
    send({
      method: "session/update",
      params: {
        sessionId: "audit",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  } else send({ id: m.id, result: {} });
});
