// Replay actual real-Harness events into OpenTUI, preserving original report and source metadata.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { NativeEvents } from "../apps/tui/src/native-events";
import { newViewState, object, Transcript } from "../apps/tui/src/transcript";
import { Client } from "../packages/shared/src/client";
import type { ConversationEvent, Instance } from "../packages/shared/src/index";

const file = process.argv[2];
if (!file || !process.env.XDG_STATE_HOME)
  throw new Error("Provide real Phase 5 evidence and isolated XDG environment");
const evidence = JSON.parse(readFileSync(file, "utf8"));
const client = new Client(
  JSON.parse(
    readFileSync(join(process.env.XDG_STATE_HOME, "harnesshub/instance.json"), "utf8"),
  ) as Instance,
);
const events: ConversationEvent[] = [];
for (;;) {
  const page = await client.request<{ events: ConversationEvent[]; cursor: number }>(
    `/v1/conversations/${evidence.conversationId}/events?after_seq=${events.at(-1)?.seq ?? 0}&limit=1000`,
  );
  events.push(...page.events);
  if ((events.at(-1)?.seq ?? 0) >= page.cursor) break;
}
const model = new Transcript();
model.append(events);
for (const e of events.filter((e) => object(e.raw).method === "session/update"))
  assert.deepEqual(object(object(e.raw).params).update, e.payload);
const rows = model.rows.filter((r) => r.value().kind === "handoff");
assert.equal(rows.length, 2);
const captures = [];
for (const row of rows) {
  const view = newViewState(),
    index = model.rows.indexOf(row);
  view.selected = index;
  view.page = Math.floor(index / 60);
  view.manual[row.id] = true;
  view.following = false;
  const screen = await testRender(
    () => <NativeEvents model={model} view={view} disabled={false} />,
    { width: 170, height: 50 },
  );
  const copied: string[] = [];
  Object.defineProperty(screen.renderer, "capabilities", {
    get: () => ({ remote: true, osc52_support: "supported" }),
    configurable: true,
  });
  screen.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text);
    return true;
  };
  try {
    for (let i = 0; i < 8; i++) await screen.renderOnce();
    const history = screen.renderer.root.findDescendantById(
      "native-history",
    ) as import("@opentui/core").ScrollBoxRenderable;
    history.scrollChildIntoView(`native-${row.id}`, { align: "start" });
    for (let i = 0; i < 4; i++) await screen.renderOnce();
    for (let i = 0; i < 150 && !screen.captureCharFrame().includes("Current Objective"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await screen.renderOnce();
    }
    history.scrollChildIntoView(`native-${row.id}`, { align: "start" });
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await screen.renderOnce();
    }
    const frame = screen.captureCharFrame();
    assert.match(frame, /Handoff/);
    assert.match(frame, /Current Objective/);
    screen.mockInput.pressKey("y");
    for (let i = 0; i < 5; i++) await screen.renderOnce();
    screen.mockInput.pressEnter();
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 15));
      await screen.renderOnce();
    }
    assert.equal(copied[0], model.source(row));
    const filename = `handoff-${row.sources[0]?.id}-frame.txt`;
    writeFileSync(join(evidence.directory, filename), frame, { mode: 0o600 });
    captures.push({ label: row.value().label, exactReportCopy: true, frame: filename });
  } finally {
    screen.renderer.destroy();
  }
}
console.log(
  JSON.stringify({
    realEvents: events.length,
    handoffRows: rows.length,
    captures,
    nativeRawPreserved: true,
  }),
);
