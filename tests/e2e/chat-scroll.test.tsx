import { expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { NativeEvents } from "../../apps/tui/src/native-events";
import { Transcript } from "../../apps/tui/src/transcript";
import type { ConversationEvent } from "../../packages/shared/src/index";

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

test("Esc returns from scrolled and paginated history to the newest message and resumes following", async () => {
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
    expect(screen.captureCharFrame()).toContain("History 2/3");
    expect(screen.captureCharFrame()).not.toContain("MESSAGE_121");
    screen.mockInput.pressEscape();
    await settle(screen);
    expect(screen.captureCharFrame()).toContain("History 3/3");
    expect(screen.captureCharFrame()).toContain("MESSAGE_121");
    expect(scroll.scrollTop + scroll.viewport.height).toBeGreaterThanOrEqual(
      scroll.scrollHeight - 1,
    );
    model.append([message(122)]);
    await settle(screen);
    expect(screen.captureCharFrame()).toContain("MESSAGE_122");
    screen.mockInput.pressKey("\x1b[5;5~");
    await settle(screen);
    expect(screen.captureCharFrame()).toContain("History 2/3");
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
    screen.mockInput.pressKey("r", { meta: true });
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
