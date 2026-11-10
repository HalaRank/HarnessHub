// Real Harness acceptance only. Never bundled in the application, never approves tools.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationEvent, Handoff, NativeSession, Turn } from "@harnesshub/shared";
import type { Client } from "@harnesshub/shared/client";
import type { BrowserWindow } from "electron";

export async function readHandoffEvents(client: Client, id: string) {
  const events: ConversationEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await client.request<{ events: ConversationEvent[]; cursor: number }>(
      `/v1/conversations/${id}/events?after_seq=${cursor}&limit=1000`,
    );
    events.push(...page.events);
    const next = page.events.at(-1)?.seq ?? cursor;
    if (next >= page.cursor) return { events };
    if (next <= cursor) throw new Error("Incomplete handoff event history");
    cursor = next;
  }
}
export function validateRealHandoff(
  evidence: { turns: { turn: Turn }[] },
  sessions: NativeSession[],
  handoffs: Handoff[],
  events: ConversationEvent[],
  id: string,
  workspace: string,
) {
  assert.equal(sessions.length, 3);
  assert.equal(new Set(sessions.map((s) => s.id)).size, 3);
  assert.equal(new Set(sessions.map((s) => s.agentSessionId)).size, 3);
  assert.ok(sessions.every((s) => s.conversationId === id && s.cwd === workspace));
  assert.equal(handoffs.length, 2);
  assert.ok(
    handoffs.every((h) => h.status === "COMMITTED" && h.reportText?.includes("violet lantern 47")),
  );
  assert.equal(events.filter((e) => e.kind === "user.message").length, 3);
  for (const entry of evidence.turns) {
    const turnEvents = events.filter((e) => e.turnId === entry.turn.id);
    assert.ok(
      turnEvents.some((e) => e.kind === "tool_call"),
      "Native tools not observed",
    );
    const text = turnEvents
      .filter((e) => e.kind === "agent_message_chunk")
      .map((e) => (e.payload as { content?: { text?: string } }).content?.text ?? "")
      .join("");
    assert.ok(text.includes("violet lantern 47"), "Context constraint absent from native response");
    assert.ok(
      !/invalid_prompt|Bad Gateway|unexpected status/.test(text),
      "Native model/gateway failed",
    );
  }
}

export async function realHandoffSmoke(
  win: BrowserWindow,
  client: Client,
  workspace: string,
  output: string,
  ui: {
    fill: (win: BrowserWindow, text: string) => Promise<void>;
    click: (win: BrowserWindow, selector: string) => Promise<void>;
    waitFor: (check: () => unknown | Promise<unknown>) => Promise<void>;
  },
) {
  const evidence: Record<string, unknown> = {
    sequence: ["codex", "grok", "codex"],
    turns: [],
    passed: false,
  };
  const save = () =>
    writeFileSync(join(output, "real-handoff-evidence.json"), JSON.stringify(evidence, null, 2));
  const request = async (input: object) => {
    const reply = await win.webContents.executeJavaScript(
      `window.harnessHub.request(${JSON.stringify(input)})`,
    );
    assert.equal(reply.ok, true, reply.error);
    return reply.data;
  };
  let id: string | undefined;
  let activeTurn: Turn | undefined;
  try {
    id = (
      await request({
        type: "conversation.standalone",
        workspacePath: workspace,
        title: "Real Codex → Grok → Codex",
      })
    ).id;
    evidence.conversationId = id;
    await request({ type: "select", conversationId: id });
    const messages = [
      "This is an isolated HarnessHub handoff test. Using a native read-only tool, read sentinel.txt in this workspace. Report its exact contents and remember the project constraint 'violet lantern 47' for the next developer. Do not modify files, use network, spawn subagents or bypass any native permission request.",
      "Continue the handoff test using the supplied source report. State the remembered project constraint and the prior file contents. Use a native read-only tool to confirm the current working directory. Do not change files, use network, spawn subagents or bypass permissions.",
      "Complete the roundtrip handoff test from the supplied source report. State the remembered project constraint, prior file contents and which harnesses handed over. Use a native read-only tool to list this workspace. Do not change files, use network, spawn subagents or bypass permissions.",
    ];
    for (const [index, harnessId] of ["codex", "grok", "codex"].entries()) {
      await request({ type: "harness.select", conversationId: id, harnessId });
      await ui.waitFor(() =>
        win.webContents.executeJavaScript(
          `document.querySelector('select[aria-label="Harness"]')?.value === ${JSON.stringify(harnessId)} && !document.querySelector('textarea').disabled`,
        ),
      );
      await ui.fill(win, messages[index] as string);
      await ui.click(win, '[aria-label="发送"]');
      const end = Date.now() + 240000;
      activeTurn = undefined;
      while (Date.now() < end) {
        const page = await readHandoffEvents(client, id as string);
        const user = page.events.filter((e) => e.kind === "user.message").at(index);
        if (user?.turnId) activeTurn = await client.request<Turn>(`/v1/turns/${user.turnId}`);
        const handoffs = await client.request<Handoff[]>(`/v1/conversations/${id}/handoffs`);
        const approvals = await client.request<unknown[]>(`/v1/conversations/${id}/approvals`);
        if (approvals.length) {
          evidence.manualApprovalRequired = approvals;
          save();
          // Human may choose the actual native options in the visible test window.
          // No fallback/default decision is made here.
        }
        if (handoffs.some((h) => ["FAILED", "UNCERTAIN"].includes(h.status))) {
          evidence.handoffs = handoffs;
          throw new Error(
            "Real Handoff failed/uncertain; no retry, confirmation or replay performed",
          );
        }
        if (
          activeTurn?.endedAt &&
          !handoffs.some((h) => !["COMMITTED", "CANCELLED"].includes(h.status))
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      (evidence.turns as unknown[]).push({ index, harnessId, turn: activeTurn });
      save();
      assert.equal(
        activeTurn?.state,
        "COMPLETED",
        "Real Harness did not complete; inspect native errors/permissions",
      );
    }
    const sessions = await client.request<NativeSession[]>(`/v1/conversations/${id}/sessions`);
    const handoffs = await client.request<Handoff[]>(`/v1/conversations/${id}/handoffs`);
    const page = await readHandoffEvents(client, id as string);
    evidence.sessions = sessions;
    evidence.handoffs = handoffs;
    writeFileSync(join(output, "real-handoff-events.json"), JSON.stringify(page, null, 2));
    validateRealHandoff(
      evidence as { turns: { turn: Turn }[] },
      sessions,
      handoffs,
      page.events,
      id as string,
      workspace,
    );
    evidence.passed = true;
    writeFileSync(join(output, "real-handoff.png"), (await win.webContents.capturePage()).toPNG());
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    // Only cancel this isolated test Turn through normal ACP, never force/replay.
    if (id && activeTurn && !activeTurn.endedAt && activeTurn.state !== "UNCERTAIN")
      evidence.cancel = await request({
        type: "turn.cancel",
        conversationId: id,
        turnId: activeTurn.id,
      }).catch(() => "unconfirmed");
    if (id) {
      evidence.handoffs = await client.request(`/v1/conversations/${id}/handoffs`);
      evidence.sessions = await client.request(`/v1/conversations/${id}/sessions`);
      writeFileSync(
        join(output, "real-handoff-events.json"),
        JSON.stringify(await readHandoffEvents(client, id), null, 2),
      );
    }
  } finally {
    save();
  }
  return evidence;
}
