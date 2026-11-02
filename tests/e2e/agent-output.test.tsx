import { expect, test } from "bun:test";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { NativeEvents } from "../../apps/tui/src/native-events";
import { sourceParts } from "../../apps/tui/src/rich-content";
import { Transcript } from "../../apps/tui/src/transcript";
import type { ConversationEvent } from "../../packages/shared/src/index";

const event = (
  seq: number,
  kind: string,
  payload: unknown,
  nativeSessionId = "native",
): ConversationEvent => ({
  id: `event-${seq}`,
  conversationId: "conversation",
  nativeSessionId,
  turnId: "turn",
  seq,
  kind,
  payload,
  origin: kind === "user.message" ? "client" : "agent",
  raw: { method: "session/update", params: { sessionId: nativeSessionId, update: payload } },
  createdAt: seq,
});
const textEvent = (seq: number, text: string, kind = "agent_message_chunk") =>
  event(seq, kind, { sessionUpdate: kind, content: { type: "text", text } });
async function waitFor(check: () => boolean | Promise<boolean>, label = "state") {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
async function frame(screen: Awaited<ReturnType<typeof testRender>>, text: string) {
  await waitFor(async () => {
    await screen.renderOnce();
    return screen.captureCharFrame().includes(text);
  }, text).catch((error) => {
    throw new Error(`${error.message}\n${screen.captureCharFrame()}`);
  });
}

test("Agent replies and public thinking have distinct gutters and headings without changing native text", async () => {
  const thought = "原生思考 THOUGHT_TEXT",
    reply = "REPLY_FIRST\n\nREPLY_SECOND\n\n```ts\nconst exact = 42;\n```";
  const events = [
    textEvent(1, thought, "agent_thought_chunk"),
    textEvent(2, reply),
    event(3, "runtime.turn_finished", { state: "COMPLETED" }),
  ];
  for (const width of [100, 32]) {
    const model = new Transcript();
    model.append(events);
    const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
      width,
      height: 24,
    });
    try {
      await frame(screen, "const exact = 42;");
      await frame(screen, "THOUGHT_TEXT");
      await frame(screen, "REPLY_FIRST");
      await frame(screen, "REPLY_SECOND");
      const lines = screen.captureSpans().lines;
      for (const [label, marker, color] of [
        ["Public thinking", "▶", "#8b949e"],
        ["Agent", "•", "#a5d6ff"],
      ] as const) {
        const heading = lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes(`${label} · #`),
        );
        if (!heading)
          throw new Error(`Missing ${label} at width ${width}\n${screen.captureCharFrame()}`);
        expect(heading).toBeDefined();
        expect(
          heading?.spans
            .map((span) => span.text)
            .join("")
            .trimStart(),
        ).toStartWith(`${marker} ${label}`);
        for (const text of [marker, label]) {
          expect(
            heading?.spans.some(
              (span) => span.text.includes(text) && span.fg.equals(RGBA.fromHex(color)),
            ),
          ).toBe(true);
        }
        expect(
          heading.spans.some(
            (span) => span.text.includes(label) && (span.attributes & TextAttributes.BOLD) !== 0,
          ),
        ).toBe(true);
      }
      for (const text of ["THOUGHT_TEXT", "REPLY_FIRST", "REPLY_SECOND", "const exact"]) {
        const line = lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes(text),
        );
        if (!line)
          throw new Error(`Missing ${text} at width ${width}\n${screen.captureCharFrame()}`);
        expect(line).toBeDefined();
        expect(line?.spans.map((span) => span.text).join("")).toStartWith("  ");
        expect(line?.spans.some((span) => span.bg.equals(RGBA.fromHex("#2d2d30")))).toBe(false);
      }
      expect(model.rows.map((row) => model.source(row))).toEqual([thought, reply]);
      expect(model.events).toEqual(events);
    } finally {
      await screen.dispose();
    }
  }
});

test("styled streaming replies wrap and copy original Markdown while user backgrounds stay separate", async () => {
  const model = new Transcript();
  const prompt = "USER_PROMPT",
    first = "STREAM_FIRST\n\n",
    rest = `${"原生输出 readable words ".repeat(6)}\n\nSTREAM_LAST`;
  const events = [
    event(1, "user.message", { text: prompt }),
    textEvent(2, first),
    textEvent(3, rest),
    event(4, "runtime.turn_finished", { state: "COMPLETED" }),
  ];
  model.append(events.slice(0, 2));
  const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
    width: 32,
    height: 28,
  });
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
    await frame(screen, prompt);
    await frame(screen, "STREAM_FIRST");
    const reply = model.rows[1];
    if (!reply) throw new Error("Streaming reply missing from transcript");
    expect(reply.value().streaming).toBe(true);
    model.append(events.slice(2));
    await frame(screen, "STREAM_LAST");
    expect(model.rows[1]).toBe(reply);
    expect(reply.value().streaming).toBe(false);
    const userLine = screen.captureSpans().lines.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes(prompt),
    );
    expect(userLine).toBeDefined();
    expect(userLine?.spans.every((span) => span.bg.equals(RGBA.fromHex("#2d2d30")))).toBe(true);
    const replyLine = screen.captureSpans().lines.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes("STREAM_LAST"),
    );
    expect(replyLine).toBeDefined();
    expect(replyLine?.spans.some((span) => span.bg.equals(RGBA.fromHex("#2d2d30")))).toBe(false);
    screen.mockInput.pressKey("]");
    await frame(screen, "▶ Agent");
    screen.mockInput.pressKey("y");
    await frame(screen, "Original Markdown / text");
    screen.mockInput.pressEnter();
    await waitFor(() => copied.length > 0);
    expect(copied.at(-1)).toBe(first + rest);
    expect(model.source(reply)).toBe(first + rest);
    expect(model.events).toEqual(events);
  } finally {
    await screen.dispose();
  }
});

test("native tool accents follow streaming status and approvals while preserving expansion and output", async () => {
  for (const width of [100, 32]) {
    const model = new Transcript();
    model.append([
      event(1, "tool_call", {
        toolCallId: "styled-tool",
        title: "NativeExact",
        status: "pending",
        rawOutput: "NATIVE_OUTPUT",
      }),
    ]);
    const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
      width,
      height: 24,
    });
    try {
      let seq = 1;
      for (const [status, color] of [
        ["pending", "#80cbc4"],
        ["in_progress", "#80cbc4"],
        ["completed", "#4ade80"],
        ["failed", "#ef9a9a"],
        ["WAITING_APPROVAL", "#ffcc80"],
      ] as const) {
        if (status === "WAITING_APPROVAL") {
          model.append([
            event(++seq, "approval.requested", {
              id: "styled-approval",
              request: { toolCall: { toolCallId: "styled-tool" } },
            }),
          ]);
        } else if (status !== "pending") {
          model.append([event(++seq, "tool_call_update", { toolCallId: "styled-tool", status })]);
        }
        await frame(screen, status);
        const heading = screen.captureSpans().lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes("NativeExact"),
        );
        expect(
          heading?.spans.some(
            (span) => span.text.includes("NativeExact") && span.fg.equals(RGBA.fromHex(color)),
          ),
        ).toBe(true);
        expect(
          screen
            .captureSpans()
            .lines.some((line) =>
              line.spans.some(
                (span) => span.text.includes("│") && span.fg.equals(RGBA.fromHex(color)),
              ),
            ),
        ).toBe(true);
        if (status === "completed")
          expect(screen.captureCharFrame()).not.toContain("NATIVE_OUTPUT");
        else await frame(screen, "NATIVE_OUTPUT");
      }
      screen.mockInput.pressKey("t");
      await frame(screen, "▶ NativeExact");
      screen.mockInput.pressKey("e");
      await screen.renderOnce();
      expect(screen.captureCharFrame()).not.toContain("NATIVE_OUTPUT");
      screen.mockInput.pressKey("e");
      await frame(screen, "NATIVE_OUTPUT");
      const tool = model.rows[0];
      if (!tool) throw new Error("Native tool missing from transcript");
      expect(sourceParts(model.source(tool), tool.value().tool)).toContainEqual({
        name: "Native tool output",
        text: "NATIVE_OUTPUT",
      });
    } finally {
      await screen.dispose();
    }
  }
});
