import { expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { NativeEvents } from "../../apps/tui/src/native-events";
import { Transcript } from "../../apps/tui/src/transcript";
import type { ConversationEvent } from "../../packages/shared/src/index";
import { clickControl } from "./ui-actions";

const message = (seq: number): ConversationEvent => ({
  id: `message-${seq}`,
  conversationId: "conversation",
  nativeSessionId: null,
  turnId: `turn-${seq}`,
  seq,
  kind: "user.message",
  payload: { text: `MESSAGE_${seq}\n${"original line\n".repeat(8)}` },
  origin: "client",
  raw: null,
  createdAt: seq,
});
async function settle(screen: Awaited<ReturnType<typeof testRender>>) {
  for (let count = 0; count < 4; count++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await screen.renderOnce();
  }
}
function history() {
  const model = new Transcript();
  model.append(Array.from({ length: 120 }, (_, index) => message(index + 1)));
  return model;
}

test("the 181st Guardian Review keeps context and the wheel reaches all history in both directions", async () => {
  const model = new Transcript();
  const shortMessage = (seq: number) => ({ ...message(seq), payload: { text: `MESSAGE_${seq}` } });
  model.append(Array.from({ length: 180 }, (_, index) => shortMessage(index + 1)));
  const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
    width: 120,
    height: 36,
  });
  const frame = async (text: string) => {
    for (let n = 0; n < 100; n++) {
      await settle(screen);
      if (screen.captureCharFrame().includes(text)) return;
    }
    throw new Error(`Missing ${text}\n${screen.captureCharFrame()}`);
  };
  try {
    await frame("MESSAGE_180");
    model.append([
      {
        ...message(181),
        kind: "tool_call",
        payload: {
          toolCallId: "review",
          title: "Guardian Review",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Risk: high\nAuthorization: high\nRationale: Original review text",
              },
            },
          ],
        },
      },
    ]);
    await frame("Guardian Review");
    expect(screen.captureCharFrame()).toContain("MESSAGE_180");
    expect(screen.captureCharFrame()).not.toMatch(/History \d+\/\d+/);
    const scroll = screen.renderer.root.findDescendantById("native-history") as ScrollBoxRenderable;
    const seen = new Set<number>();
    const collect = (frame: string) => {
      for (const match of frame.matchAll(/MESSAGE_(\d+)\s/g)) seen.add(Number(match[1]));
    };
    // Only wheel events: no page keys or explicit scrollTo calls are needed.
    // The native renderer may begin another frame during a timer yield. Acquire
    // snapshots through its frame waiter instead of reading a busy output lease.
    let current = await screen.waitForFrame(() => true);
    collect(current);
    for (let n = 0; n < 300 && !current.includes("MESSAGE_1 "); n++) {
      await screen.mockMouse.scroll(scroll.x + 3, scroll.y + 2, "up");
      await screen.renderOnce();
      current = await screen.waitForFrame(() => true);
      collect(current);
    }
    await frame("MESSAGE_1 ");
    expect(scroll.getChildrenCount()).toBeLessThanOrEqual(63);
    current = await screen.waitForFrame(() => true);
    for (let n = 0; n < 300 && !current.includes("Guardian Review"); n++) {
      await screen.mockMouse.scroll(scroll.x + 3, scroll.y + 2, "down");
      await screen.renderOnce();
      current = await screen.waitForFrame(() => true);
      collect(current);
    }
    await frame("Guardian Review");
    expect(screen.captureCharFrame()).toContain("MESSAGE_180");
    expect(scroll.getChildrenCount()).toBeLessThanOrEqual(63);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 180 }, (_, i) => i + 1));
    expect(model.events).toHaveLength(181);
    expect(model.rows).toHaveLength(181);
  } finally {
    await screen.dispose();
  }
}, 20000);

test("each chat wheel event scrolls five lines in either direction, clamped at the edges", async () => {
  const screen = await testRender(() => <NativeEvents model={history()} disabled={false} />, {
    width: 120,
    height: 30,
  });
  try {
    await settle(screen);
    const scroll = screen.renderer.root.findDescendantById("native-history") as ScrollBoxRenderable;
    scroll.scrollTo(30);
    await settle(screen);
    for (const direction of ["up", "up", "down", "down"] as const) {
      const before = scroll.scrollTop;
      await screen.mockMouse.scroll(scroll.x + 3, scroll.y + 2, direction);
      await settle(screen);
      expect(scroll.scrollTop - before).toBe(direction === "up" ? -5 : 5);
    }
    scroll.scrollTo(2);
    await screen.mockMouse.scroll(scroll.x + 3, scroll.y + 2, "up");
    await settle(screen);
    expect(scroll.scrollTop).toBe(0);
    scroll.scrollTo(Infinity);
    await settle(screen);
    const bottom = scroll.scrollTop;
    await screen.mockMouse.scroll(scroll.x + 3, scroll.y + 2, "down");
    await settle(screen);
    expect(scroll.scrollTop).toBe(bottom);
  } finally {
    await screen.dispose();
  }
});

test("Esc returns from scrolled history to the newest message and resumes following", async () => {
  const model = history();
  const screen = await testRender(() => <NativeEvents model={model} disabled={false} />, {
    width: 120,
    height: 30,
  });
  try {
    await settle(screen);
    const scroll = screen.renderer.root.findDescendantById("native-history") as ScrollBoxRenderable;
    await screen.mockMouse.scroll(scroll.x + 3, scroll.y + 2, "up");
    await settle(screen);
    model.append([message(121)]);
    await settle(screen);
    expect(screen.captureCharFrame()).not.toContain("MESSAGE_121");
    screen.mockInput.pressEscape();
    await settle(screen);
    expect(screen.captureCharFrame()).toContain("MESSAGE_121");
    expect(scroll.scrollTop + scroll.viewport.height).toBeGreaterThanOrEqual(
      scroll.scrollHeight - 1,
    );
    model.append([message(122)]);
    await settle(screen);
    expect(screen.captureCharFrame()).toContain("MESSAGE_122");
    const before = scroll.scrollTop;
    screen.mockInput.pressKey("\x1b[5;5~");
    await settle(screen);
    expect(scroll.scrollTop).toBeLessThan(before);
    screen.mockInput.pressEscape();
    await settle(screen);
    expect(screen.captureCharFrame()).toContain("MESSAGE_122");
  } finally {
    await screen.dispose();
  }
});

test("modal Esc preserves scroll; an explicit editor follow request returns to the latest message", async () => {
  const model = history();
  const [disabled, setDisabled] = createSignal(false);
  const [followRequest, setFollowRequest] = createSignal(0);
  const screen = await testRender(
    () => <NativeEvents model={model} disabled={disabled()} followRequest={followRequest()} />,
    { width: 120, height: 30 },
  );
  try {
    await settle(screen);
    const scroll = screen.renderer.root.findDescendantById("native-history") as ScrollBoxRenderable;
    scroll.scrollTo(20);
    await settle(screen);
    setDisabled(true);
    screen.mockInput.pressEscape();
    await settle(screen);
    expect(scroll.scrollTop).toBe(20);
    setDisabled(false);
    await clickControl(screen, "transcript-raw");
    await settle(screen);
    screen.mockInput.pressEscape();
    await settle(screen);
    expect(scroll.scrollTop).toBe(20);
    setFollowRequest(1);
    await settle(screen);
    expect(screen.captureCharFrame()).toContain("MESSAGE_120");
  } finally {
    await screen.dispose();
  }
});
