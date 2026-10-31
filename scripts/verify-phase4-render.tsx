// Render actual stored ACP events from the explicit real-Harness verification, never fixtures.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { NativeEvents } from "../apps/tui/src/native-events";
import { sourceParts } from "../apps/tui/src/rich-content";
import { newViewState, object, pretty, Transcript } from "../apps/tui/src/transcript";
import { Client } from "../packages/shared/src/client";
import type { ConversationEvent, Instance } from "../packages/shared/src/index";

const file = process.argv[2];
if (!file) throw new Error("Provide Phase 4 evidence JSON");
const setup = JSON.parse(readFileSync(file, "utf8"));
const stateHome = process.env.XDG_STATE_HOME;
if (!stateHome) throw new Error("Use isolated verification environment");
const client = new Client(
  JSON.parse(readFileSync(join(stateHome, "harnesshub/instance.json"), "utf8")) as Instance,
);
for (const item of setup.conversations) {
  const events: ConversationEvent[] = [];
  for (;;) {
    const page = await client.request<{ events: ConversationEvent[]; cursor: number }>(
      `/v1/conversations/${item.conversationId}/events?after_seq=${events.at(-1)?.seq ?? 0}&limit=1000`,
    );
    events.push(...page.events);
    if ((events.at(-1)?.seq ?? 0) === page.cursor) break;
  }
  const transcript = new Transcript();
  transcript.append(events);
  for (const event of events.filter(
    (e) => e.origin === "agent" && object(e.raw).method === "session/update",
  ))
    assert.deepEqual(object(object(event.raw).params).update, event.payload);
  for (const row of transcript.rows)
    for (const source of row.sources) assert.equal(events[source.seq - 1]?.id, source.id);
  const toolIndex = transcript.rows.findIndex((r) => {
    const tool = r.value().tool;
    return (
      tool &&
      (Object.values(r.value().terminals).some((terminal) => terminal.output.length > 0) ||
        tool.rawOutput !== undefined ||
        (Array.isArray(tool.content) &&
          tool.content.some((entry) => typeof object(object(entry).content).text === "string")))
    );
  });
  assert.ok(toolIndex >= 0, "Real Harness did not expose native tool output");
  const row = transcript.rows[toolIndex];
  assert.ok(row);
  const tool = row.value().tool;
  assert.ok(tool);
  const parts = sourceParts(pretty(tool), tool, row.value().terminals);
  const outputIndex = parts.findIndex(
    (p) =>
      p.name.startsWith("Terminal ") ||
      p.name === "Native tool output" ||
      p.name.startsWith("Native content "),
  );
  assert.ok(outputIndex >= 0);
  const view = newViewState();
  view.selected = toolIndex;
  view.page = Math.floor(toolIndex / 60);
  view.manual[row.id] = true;
  const copy: string[] = [];
  const exact = await testRender(
    () => <NativeEvents model={transcript} view={view} disabled={false} />,
    { width: 180, height: 55 },
  );
  exact.renderer.copyToClipboardOSC52 = (value) => {
    copy.push(value);
    return true;
  };
  try {
    for (let n = 0; n < 8; n++) await exact.renderOnce();
    const history = exact.renderer.root.findDescendantById(
      "native-history",
    ) as import("@opentui/core").ScrollBoxRenderable;
    history.scrollChildIntoView(`native-${row.id}`, { align: "start" });
    for (let n = 0; n < 4; n++) await exact.renderOnce();
    assert.ok(
      exact.captureCharFrame().includes(String(tool.title ?? tool.toolCallId).slice(0, 50)),
      "Native tool title missing from real transcript render",
    );
    writeFileSync(
      join(setup.evidence, `${item.harnessId}-tool-frame.txt`),
      exact.captureCharFrame(),
      { mode: 0o600 },
    );
    exact.mockInput.pressKey("y");
    for (let n = 0; n < 6; n++) await exact.renderOnce();
    for (let n = 0; n < outputIndex; n++) exact.mockInput.pressArrow("down");
    exact.mockInput.pressEnter();
    await exact.renderOnce();
    assert.equal(copy.at(-1), parts[outputIndex]?.text, "TUI copy changed real native tool output");
    writeFileSync(
      join(setup.evidence, `${item.harnessId}-source-frame.txt`),
      exact.captureCharFrame(),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        harnessId: item.harnessId,
        realEvents: events.length,
        normalizedMatchesRaw: true,
        toolTitle: tool.title,
        nativeOutputCopiedExactly: true,
        copiedCharacters: copy.at(-1)?.length,
        sourceEvents: row.sources.map((e) => e.seq),
      }),
    );
  } finally {
    await exact.dispose();
  }
  const messageIndex = transcript.rows.findLastIndex(
    (r) => r.value().label === "Agent" && transcript.source(r).includes(item.sentinel),
  );
  assert.ok(messageIndex >= 0, "Final real Agent Markdown not found");
  const messageRow = transcript.rows[messageIndex];
  assert.ok(messageRow);
  const markdown = transcript.source(messageRow);
  assert.ok(
    markdown.includes("#") && markdown.includes("```"),
    "Real final answer did not include requested Markdown",
  );
  const source = sourceParts(markdown, null);
  const messageView = newViewState();
  messageView.selected = messageIndex;
  messageView.page = Math.floor(messageIndex / 60);
  const chat = await testRender(
    () => <NativeEvents model={transcript} view={messageView} disabled={false} />,
    { width: 180, height: 55 },
  );
  chat.renderer.copyToClipboardOSC52 = (value) => {
    copy.push(value);
    return true;
  };
  try {
    const history = chat.renderer.root.findDescendantById(
      "native-history",
    ) as import("@opentui/core").ScrollBoxRenderable;
    for (let n = 0; n < 100; n++) {
      history.scrollChildIntoView(`native-${messageRow.id}`, { align: "start" });
      await chat.renderOnce();
      if (chat.captureCharFrame().includes(item.sentinel)) break;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    assert.ok(
      chat.captureCharFrame().includes(item.sentinel),
      "Real Markdown did not render bound workspace sentinel",
    );
    writeFileSync(
      join(setup.evidence, `${item.harnessId}-chat-frame.txt`),
      chat.captureCharFrame(),
      { mode: 0o600 },
    );
    chat.mockInput.pressKey("y");
    for (let n = 0; n < 4; n++) await chat.renderOnce();
    chat.mockInput.pressEnter();
    await chat.renderOnce();
    assert.equal(copy.at(-1), markdown);
    const codeIndex = source.findIndex((part) => part.name.startsWith("Code "));
    assert.ok(codeIndex >= 0);
    for (let n = 0; n < codeIndex; n++) chat.mockInput.pressArrow("down");
    chat.mockInput.pressEnter();
    await chat.renderOnce();
    assert.equal(copy.at(-1), source[codeIndex]?.text);
    console.log(
      JSON.stringify({
        harnessId: item.harnessId,
        realMarkdownRendered: true,
        originalMarkdownCopiedExactly: true,
        originalCodeCopiedExactly: true,
        markdownCharacters: markdown.length,
      }),
    );
  } finally {
    await chat.dispose();
  }
}
