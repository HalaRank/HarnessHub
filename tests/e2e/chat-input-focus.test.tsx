import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { AgentPane } from "../../apps/tui/src/agent-pane";
import { DraftSession, flushDrafts } from "../../apps/tui/src/draft-session";
import type { Conversation, Draft } from "../../packages/shared/src/index";

test("chat whitespace and input borders focus the editor; native clicks, scroll and modals stay intact", async () => {
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "hhu-chat-focus-offline-"));
  const conversation: Conversation = {
    id: "offline-click-focus",
    projectId: "project",
    title: "Click focus",
    archivedAt: null,
    workspaceMode: "shared",
    workspacePath: "/tmp",
    runtimeStatus: "IDLE",
    createdAt: 0,
    updatedAt: 0,
  };
  let saved: Draft = {
    conversationId: conversation.id,
    text: "中文 👋 draft",
    revision: 0,
    pendingSubmission: null,
  };
  const request = spyOn(DraftSession.prototype, "request").mockImplementation(
    async <Response,>(_path: string, method = "GET", body?: unknown): Promise<Response> => {
      if (method === "PUT") saved = { ...saved, ...(body as Draft), revision: saved.revision + 1 };
      return { ...saved } as Response;
    },
  );
  type Form = "message" | "approval" | "details" | "settings" | null;
  const [form, setForm] = createSignal<Form>(null);
  const [action, setAction] = createSignal({ id: 0, name: "none" });
  const screen = await testRender(
    () => (
      <AgentPane
        conversation={conversation}
        form={form()}
        setForm={setForm}
        onDraftError={() => {}}
        action={action()}
      />
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  );
  const editor = () =>
    screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable;
  const settle = async () => {
    for (let count = 0; count < 5; count++) {
      await screen.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await settle();
    const history = screen.renderer.root.findDescendantById("native-history");
    const composer = screen.renderer.root.findDescendantById("message-composer");
    if (!history || !composer || !editor()) throw new Error("Missing chat renderables");
    expect(editor().focused).toBe(false);
    await screen.mockMouse.click(history.x + 10, history.y + 3);
    await settle();
    expect(form()).toBe("message");
    expect(editor().focused).toBe(true);
    expect(editor().getTextRange(0, editor().cursorOffset)).toBe(saved.text);
    await screen.mockInput.typeText(" appended");
    expect(editor().plainText).toBe("中文 👋 draft appended");

    screen.mockInput.pressEscape();
    await settle();
    expect(editor().focused).toBe(false);
    await screen.mockMouse.click(composer.x, composer.y);
    await settle();
    expect(editor().focused).toBe(true);
    await screen.mockInput.typeText(" border");
    await screen.mockMouse.click(editor().x, editor().y);
    await settle();
    expect(editor().cursorOffset).toBe(0);
    await screen.mockInput.typeText("prefix ");
    expect(editor().plainText).toBe("prefix 中文 👋 draft appended border");

    setForm("details");
    await settle();
    await screen.mockMouse.click(history.x + 10, history.y + 3);
    await screen.mockMouse.click(editor().x, editor().y);
    await settle();
    expect(form()).toBe("details");
    expect(editor().focused).toBe(false);
    setForm(null);
    await settle();
    await screen.mockMouse.click(history.x + 10, history.y + 3, 2);
    await screen.mockMouse.scroll(history.x + 10, history.y + 3, "up");
    await settle();
    expect(form()).toBeNull();
    expect(editor().focused).toBe(false);

    await screen.mockMouse.click(composer.x, composer.y);
    await settle();
    screen.mockInput.pressEnter({ shift: true });
    await screen.mockInput.typeText("last line");
    expect(editor().plainText).toBe("prefix 中文 👋 draft appended border\nlast line");
    const changesPoint = { x: history.x + 10, y: history.y + 3 };
    setForm(null);
    setAction({ id: 1, name: "changes" });
    await settle();
    expect(screen.captureCharFrame()).toContain("Changes · Conversation workspace");
    await screen.mockMouse.click(changesPoint.x, changesPoint.y);
    await settle();
    expect(form()).toBeNull();
    await screen.mockMouse.click(composer.x, composer.y);
    await settle();
    expect(editor().focused).toBe(true);
  } finally {
    await screen.dispose();
    await flushDrafts();
    request.mockRestore();
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
  }
});
