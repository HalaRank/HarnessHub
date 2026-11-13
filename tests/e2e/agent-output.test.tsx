import { expect, test } from "bun:test";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { NativeEvents } from "../../apps/tui/src/native-events";
import { sourceParts } from "../../apps/tui/src/rich-content";
import { newViewState, projectEvent, Transcript } from "../../apps/tui/src/transcript";
import { chat } from "../../apps/tui/src/ui";
import type { ConversationEvent } from "../../packages/shared/src/index";
import { clickControl } from "./ui-actions";

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

test("model metadata fallback warning stays in raw events while replies render live and on replay", async () => {
  for (const modelId of ["baizhi-cloud/gpt-6.1-sol", "`gpt-6-astra`", "vendor/custom-model"]) {
    const warning = `Warning: Model metadata for ${modelId} not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\n\n`;
    const warningEvent = textEvent(1, warning);
    const events = [
      warningEvent,
      textEvent(2, `${warning}REPLY_FIRST\n\n`),
      textEvent(3, "REPLY_SECOND"),
      event(4, "runtime.turn_finished", { state: "COMPLETED" }),
    ];
    const original = JSON.stringify(events);
    const model = new Transcript();
    model.append(events.slice(0, 1));
    expect(model.rows).toHaveLength(0);
    model.append(events.slice(1));
    const replay = new Transcript();
    replay.append(events);
    for (const transcript of [model, replay]) {
      expect(transcript.rows.map((row) => row.value().text)).toEqual([
        "REPLY_FIRST\n\nREPLY_SECOND",
      ]);
      expect(transcript.rows[0]?.value().streaming).toBe(false);
      expect(transcript.events).toEqual(events);
      const first = transcript.rows[0];
      if (!first) throw new Error("Missing reply row");
      expect(transcript.source(first)).toBe("REPLY_FIRST\n\nREPLY_SECOND");
    }
    expect(JSON.stringify(events)).toBe(original);
    expect(projectEvent(warningEvent).category).toBe("INTERNAL_DIAGNOSTIC");
    expect(projectEvent(textEvent(1, warning.trimEnd())).category).toBe("INTERNAL_DIAGNOSTIC");
    const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
      width: 100,
      height: 16,
    });
    try {
      await frame(screen, "REPLY_SECOND");
      expect(screen.captureCharFrame()).not.toContain("Model metadata");
    } finally {
      await screen.dispose();
    }
  }
});

test("warning filter preserves user quotes, tool output, other warnings and errors", () => {
  const warning =
    "Warning: Model metadata for vendor/model not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
  const quoted = ["```text", warning, "```"].join("\n");
  const explanation = `The agent reported:\n${warning}`;
  const otherWarning = "Warning: Model metadata unavailable because authentication failed.";
  const events = [
    event(1, "user.message", { text: warning }),
    textEvent(2, warning, "user_message_chunk"),
    textEvent(3, explanation),
    textEvent(4, otherWarning),
    textEvent(5, quoted),
    event(6, "runtime.warning", { message: warning }),
    event(7, "runtime.session_error", { message: "Model request failed" }),
    event(8, "tool_call", { toolCallId: "tool", title: "Native tool", rawOutput: warning }),
  ];
  const model = new Transcript();
  model.append(events);
  expect(model.rows.map((row) => row.value().text)).toEqual([
    warning,
    warning,
    explanation + otherWarning + quoted,
    warning,
    "Model request failed",
    "",
  ]);
  expect(model.rows.at(-1)?.value().tool?.rawOutput).toBe(warning);
});

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
        ["Public thinking", "▶", chat.muted],
        ["Agent", "•", chat.muted],
      ] as const) {
        const heading = lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes(label),
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
            (span) => span.text.includes(label) && (span.attributes & TextAttributes.BOLD) === 0,
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
        if (["THOUGHT_TEXT", "REPLY_FIRST", "REPLY_SECOND"].includes(text))
          expect(
            line.spans.some(
              (span) =>
                span.text.includes(text) &&
                span.fg.equals(RGBA.fromHex(text === "THOUGHT_TEXT" ? chat.muted : chat.text)),
            ),
          ).toBe(true);
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
    screen.mockInput.pressArrow("down");
    await frame(screen, "▶ Agent");
    await clickControl(screen, "transcript-source");
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
        rawInput: { command: "NATIVE_PARAMETERS" },
        rawOutput: "NATIVE_OUTPUT",
        content: [{ type: "content", content: { type: "text", text: "NATIVE_CONTENT" } }],
      }),
    ]);
    const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
      width,
      height: 24,
    });
    try {
      let seq = 1;
      for (const [status, color] of [
        ["pending", chat.operator],
        ["in_progress", chat.operator],
        ["completed", chat.success],
        ["failed", chat.error],
        ["WAITING_APPROVAL", chat.warning],
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
            (span) =>
              span.text.includes("NativeExact") && span.fg.equals(RGBA.fromHex(chat.heading)),
          ),
        ).toBe(true);
        expect(
          heading?.spans.some(
            (span) => /[•▶]/.test(span.text) && span.fg.equals(RGBA.fromHex(color)),
          ),
        ).toBe(true);
        expect(
          heading?.spans.some(
            (span) =>
              span.text.includes(status) &&
              span.fg.equals(RGBA.fromHex(status === "completed" ? chat.muted : color)),
          ),
        ).toBe(true);
        await frame(screen, "NATIVE_CONTENT");
        expect(screen.captureCharFrame()).not.toContain(" · #");
        for (const detail of ["NATIVE_PARAMETERS", "NATIVE_OUTPUT", "Parameters"])
          expect(screen.captureCharFrame()).not.toContain(detail);
      }
      screen.mockInput.pressArrow("up");
      await frame(screen, "▶ NativeExact");
      screen.mockInput.pressEnter();
      await frame(screen, "NATIVE_OUTPUT");
      await frame(screen, "NATIVE_PARAMETERS");
      await frame(screen, "NATIVE_CONTENT");
      model.append([
        event(++seq, "approval.decided", { approvalId: "styled-approval", optionId: "deny" }),
        event(++seq, "tool_call_update", { toolCallId: "styled-tool", status: "completed" }),
      ]);
      await frame(screen, "NATIVE_OUTPUT");
      screen.mockInput.pressEnter();
      await screen.renderOnce();
      expect(screen.captureCharFrame()).not.toContain("NATIVE_OUTPUT");
      model.append([
        event(++seq, "tool_call_update", { toolCallId: "styled-tool", status: "failed" }),
      ]);
      await frame(screen, "failed");
      expect(screen.captureCharFrame()).not.toContain("NATIVE_OUTPUT");
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

test("command syntax keeps its colors across tool states and narrow layouts", async () => {
  const title = "git -C 'a' | pwd\nprintf 'NATIVE_SECOND_LINE'";
  for (const width of [100, 32]) {
    const model = new Transcript();
    model.append([
      event(1, "tool_call", {
        toolCallId: "command",
        title,
        rawInput: { command: title },
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "NATIVE_PREVIEW" } }],
      }),
    ]);
    const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
      width,
      height: 18,
    });
    try {
      let seq = 1;
      for (const status of ["completed", "failed", "in_progress"]) {
        model.append([event(++seq, "tool_call_update", { toolCallId: "command", status })]);
        await frame(screen, status);
        const heading = screen.captureSpans().lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes("git -C"),
        );
        for (const [text, color] of [
          ["git", chat.command],
          ["-C", chat.option],
          ["'a'", chat.string],
          ["|", chat.operator],
          ["pwd", chat.command],
        ] as const)
          expect(
            heading?.spans.some(
              (span) =>
                span.text.includes(text) &&
                span.fg.equals(RGBA.fromHex(color)) &&
                !(span.attributes & TextAttributes.BOLD),
            ),
          ).toBe(true);
        expect(screen.captureCharFrame()).not.toContain("NATIVE_SECOND_LINE");
      }
      await frame(screen, "NATIVE_PREVIEW");
      expect(
        screen
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .some(
            (span) =>
              span.text.includes("NATIVE_PREVIEW") && span.fg.equals(RGBA.fromHex(chat.muted)),
          ),
      ).toBe(true);
      screen.mockInput.pressEnter();
      await frame(screen, "NATIVE_SECOND_LINE");
      const row = model.rows[0];
      if (!row) throw new Error("Missing native command");
      expect(JSON.parse(model.source(row)).title).toBe(title);
      model.append([
        event(++seq, "tool_call_update", {
          toolCallId: "command",
          kind: "execute",
          title: "git --short",
          rawInput: { command: ["/bin/bash", "-lc", "git --short"] },
        }),
      ]);
      await frame(screen, "git --short");
      expect(
        screen
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .some(
            (span) => span.text.includes("--short") && span.fg.equals(RGBA.fromHex(chat.option)),
          ),
      ).toBe(true);
    } finally {
      await screen.dispose();
    }
  }
});

test("historical terminal and Guardian Review details stay folded without changing native events", async () => {
  const events = [
    event(1, "tool_call", {
      toolCallId: "terminal-call",
      title: "Native terminal command",
      status: "in_progress",
      rawInput: { command: "TERMINAL_PARAMETERS" },
      content: [{ type: "terminal", terminalId: "native-terminal-id" }],
    }),
    event(2, "tool_call", {
      toolCallId: "guardian-review",
      title: "Guardian Review",
      status: "failed",
      rawInput: { reviewId: "GUARDIAN_PARAMETERS" },
      rawOutput: { review: { status: "aborted", rationale: "GUARDIAN_RESULT" } },
    }),
  ];
  const model = new Transcript(),
    view = newViewState();
  const original = JSON.stringify(events);
  model.append(events);
  let screen = await testRender(() => <NativeEvents model={model} view={view} disabled={false} />, {
    width: 120,
    height: 30,
  });
  try {
    await frame(screen, "Guardian Review");
    expect(screen.captureCharFrame()).toContain("in_progress");
    expect(screen.captureCharFrame()).toContain("failed");
    for (const detail of [
      "TERMINAL_PARAMETERS",
      "native-terminal-id",
      "GUARDIAN_PARAMETERS",
      "GUARDIAN_RESULT",
    ])
      expect(screen.captureCharFrame()).not.toContain(detail);
    screen.mockInput.pressKey("e", { meta: true });
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain("GUARDIAN_RESULT");
    screen.mockInput.pressEnter();
    await frame(screen, "TERMINAL_PARAMETERS");
    expect(screen.captureCharFrame()).not.toContain("native-terminal-id");
    screen.mockInput.pressArrow("down");
    screen.mockInput.pressEnter();
    await frame(screen, "Show less");
    expect(screen.captureCharFrame()).not.toContain("GUARDIAN_RESULT");
    await screen.dispose();
    expect(Object.values(view.manual)).toEqual([true, true]);
    screen = await testRender(() => <NativeEvents model={model} view={view} disabled={false} />, {
      width: 120,
      height: 30,
    });
    await frame(screen, "Show less");
    await clickControl(screen, "transcript-raw");
    await frame(screen, "GUARDIAN_PARAMETERS");
    expect(model.events).toEqual(events);
    expect(JSON.stringify(events)).toBe(original);
  } finally {
    await screen.dispose();
  }
});

test("tool summaries bound multiline commands and stdout without exposing protocol data", async () => {
  const title = `apply_patch <<'PATCH'\nPATCH_BODY_ONLY\n${"+ native patch line\n".repeat(200)}PATCH`;
  const output = `${"hidden old output\n".repeat(197)}  tail first\n${"long native output ".repeat(50)}\nTAIL_LAST\n`;
  const events = [
    event(1, "tool_call", {
      toolCallId: "internal-tool-id",
      title,
      status: "failed",
      rawInput: { command: title, cwd: "/native-workspace", reviewId: "PRIVATE_REVIEW_ID" },
      rawOutput: { review: { status: "aborted", rationale: "PRIVATE_REVIEW_RESULT" } },
      _meta: { terminal_info: { terminal_id: "internal-terminal-id", cwd: "/native-workspace" } },
    }),
    event(2, "tool_call_update", {
      toolCallId: "internal-tool-id",
      _meta: { terminal_output_delta: { terminal_id: "internal-terminal-id", data: output } },
    }),
    textEvent(3, "VISIBLE_AGENT_REPLY"),
  ];
  const original = JSON.stringify(events);
  for (const width of [100, 32]) {
    const model = new Transcript();
    model.append(events);
    const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
      width,
      height: 18,
    });
    try {
      await frame(screen, "VISIBLE_AGENT_REPLY");
      await frame(screen, "TAIL_LAST");
      const rendered = screen.captureCharFrame();
      for (const visible of ["failed", "tail first", "+ 197 lines"])
        expect(rendered).toContain(visible);
      for (const hidden of [
        "PATCH_BODY_ONLY",
        "hidden old output",
        "internal-tool-id",
        "internal-terminal-id",
        "PRIVATE_REVIEW_ID",
        "PRIVATE_REVIEW_RESULT",
        "Parameters",
        "Native details:",
        "expand/collapse",
      ])
        expect(rendered).not.toContain(hidden);
      const tool = model.rows[0];
      if (!tool) throw new Error("Native tool missing");
      expect(
        sourceParts(model.source(tool), tool.value().tool, tool.value().terminals),
      ).toContainEqual({
        name: "Terminal internal-terminal-id output",
        text: output,
      });
      await clickControl(screen, "transcript-raw");
      await frame(screen, "Original source");
      expect(JSON.parse(model.source(tool)).title).toBe(title);
      expect(model.events).toEqual(events);
      expect(JSON.stringify(events)).toBe(original);
    } finally {
      await screen.dispose();
    }
  }
});

test("tool detail links toggle the clicked tool, preserve selection and survive updates and remounts", async () => {
  for (const width of [100, 32]) {
    const model = new Transcript(),
      view = newViewState();
    const events = [
      event(1, "tool_call", {
        toolCallId: "command",
        title: "python3 - <<'PY'",
        rawInput: { command: "python3 - <<'PY'\nprint('COMMAND_BODY')\nPY" },
        rawOutput: "COMMAND_RESULT",
        status: "completed",
      }),
      event(2, "tool_call", {
        toolCallId: "review",
        title: "Guardian Review",
        content: [
          {
            type: "content",
            content: { type: "text", text: "REVIEW_FIRST\nsecond\nthird\nfourth\nfifth" },
          },
        ],
        status: "in_progress",
      }),
    ];
    model.append(events);
    const [command, review] = model.rows;
    if (!command || !review) throw new Error("Missing native tools");
    const commandId = `tool-details-${command.id}`,
      reviewId = `tool-details-${review.id}`;
    let screen = await testRender(
      () => <NativeEvents model={model} view={view} disabled={false} />,
      {
        width,
        height: 30,
      },
    );
    try {
      await frame(screen, "+ Show details");
      await frame(screen, "+ 2 lines");
      const control = screen.renderer.root.findDescendantById(reviewId);
      if (!control) throw new Error("Missing review detail link");
      await screen.mockMouse.click(control.x, control.y, 2);
      await screen.mockMouse.drag(control.x, control.y, control.x + 5, control.y);
      await screen.renderOnce();
      expect(screen.captureCharFrame()).not.toContain("REVIEW_FIRST");
      await clickControl(screen, reviewId);
      await frame(screen, "REVIEW_FIRST");
      await frame(screen, "▶ Guardian Review");
      expect(screen.captureCharFrame()).not.toContain("COMMAND_BODY");
      screen.mockInput.pressEnter();
      await frame(screen, "+ 2 lines");
      expect(screen.captureCharFrame()).not.toContain("REVIEW_FIRST");
      await clickControl(screen, commandId);
      await frame(screen, "COMMAND_BODY");
      await frame(screen, "COMMAND_RESULT");
      await clickControl(screen, reviewId);
      model.append([event(3, "tool_call_update", { toolCallId: "review", status: "completed" })]);
      await frame(screen, "REVIEW_FIRST");
      await screen.dispose();
      expect(view.manual[command.id]).toBe(true);
      expect(view.manual[review.id]).toBe(true);
      expect(view.selected).toBe(1);
      screen = await testRender(() => <NativeEvents model={model} view={view} disabled={false} />, {
        width,
        height: 30,
      });
      await frame(screen, "COMMAND_RESULT");
      await frame(screen, "REVIEW_FIRST");
      await clickControl(screen, commandId);
      await frame(screen, "+ Show details");
      expect(screen.captureCharFrame()).not.toContain("COMMAND_RESULT");
      expect(screen.captureCharFrame()).toContain("REVIEW_FIRST");
      expect(model.events.slice(0, 2)).toEqual(events);
    } finally {
      await screen.dispose();
    }
  }
});

test("RC-04 expired approval replay clears TUI waiting and preserves the native pending tool", async () => {
  const model = new Transcript();
  const requested = event(1, "approval.requested", {
    id: "expired",
    request: {
      toolCall: { toolCallId: "expired-tool", title: "Native pending", status: "pending" },
    },
  });
  const expired = event(2, "approval.expired", {
    approvalId: "expired",
    status: "EXPIRED",
    reason: "daemon_restart",
  });
  model.append([requested]);
  const tool = model.rows.find((row) => row.value().tool);
  expect(tool?.value().waiting).toBe(true);
  model.append([expired]);
  model.append([requested, expired]);
  expect(tool?.value().waiting).toBe(false);
  expect(tool?.value().tool?.status).toBe("pending");
  const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
    width: 100,
    height: 24,
  });
  try {
    await frame(screen, "EXPIRED");
    expect(screen.captureCharFrame()).not.toContain("WAITING_APPROVAL");
    expect(model.events).toEqual([requested, expired]);
  } finally {
    screen.renderer.destroy();
  }
});
