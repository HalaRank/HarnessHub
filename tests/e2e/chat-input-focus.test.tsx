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

test("message composer grows upward for newlines and wrapped text, then shrinks", async () => {
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "hhu-composer-height-"));
  const conversation: Conversation = {
    id: "offline-composer-height",
    projectId: "project",
    title: "Composer height",
    archivedAt: null,
    workspaceMode: "shared",
    workspacePath: "/tmp",
    runtimeStatus: "IDLE",
    createdAt: 0,
    updatedAt: 0,
  };
  let saved: Draft = {
    conversationId: conversation.id,
    text: "restored\ndraft",
    revision: 0,
    pendingSubmission: null,
  };
  const request = spyOn(DraftSession.prototype, "request").mockImplementation(
    async <Response,>(_path: string, method = "GET", body?: unknown): Promise<Response> => {
      if (method === "PUT") saved = { ...saved, ...(body as Draft), revision: saved.revision + 1 };
      return { ...saved } as Response;
    },
  );
  const [form, setForm] = createSignal<Parameters<typeof AgentPane>[0]["form"]>("message");
  const screen = await testRender(
    () => (
      <AgentPane
        conversation={conversation}
        form={form()}
        setForm={setForm}
        onDraftError={() => {}}
      />
    ),
    { width: 60, height: 30, kittyKeyboard: true },
  );
  const settle = async () => {
    for (let count = 0; count < 5; count++) {
      await screen.renderOnce();
      await Bun.sleep(20);
    }
  };
  try {
    await settle();
    const editor = screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable;
    const composer = screen.renderer.root.findDescendantById("message-composer");
    if (!composer) throw new Error("Missing composer");
    const bottom = composer.y + composer.height;
    const expectLines = (lines: number) => {
      expect(editor.height).toBe(lines);
      expect(composer.height).toBe(lines + 2);
      expect(composer.y + composer.height).toBe(bottom);
    };
    expectLines(2);
    editor.setText("");
    await screen.mockInput.typeText("first");
    await settle();
    expectLines(1);
    screen.mockInput.pressEnter({ shift: true });
    await screen.mockInput.typeText("second");
    await settle();
    expectLines(2);
    expect(screen.captureCharFrame()).toContain("first");
    expect(screen.captureCharFrame()).toContain("second");
    for (let count = 0; count < "second".length + 1; count++) screen.mockInput.pressBackspace();
    await settle();
    expectLines(1);
    expect(editor.plainText).toBe("first");

    editor.setText("");
    await screen.mockInput.typeText("word ".repeat(16));
    await settle();
    expect(editor.width).toBeLessThanOrEqual(58);
    expect(editor.editorView.getTotalVirtualLineCount()).toBe(2);
    expectLines(2);
    screen.resize(32, 30);
    await settle();
    expectLines(3);
    screen.resize(100, 30);
    await settle();
    expectLines(1);

    editor.setText("");
    await screen.mockInput.pasteBracketedText("中文👋".repeat(20));
    await settle();
    expectLines(2);
    editor.setText("x".repeat(120));
    await settle();
    expectLines(2);

    editor.setText("");
    await screen.mockInput.pasteBracketedText("中文 👋\n第二行\n第三行");
    await settle();
    expectLines(3);
    editor.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
    editor.gotoBufferEnd();
    await settle();
    expectLines(8);
    expect(screen.captureCharFrame()).toContain("line 12");
    editor.setText("short");
    await settle();
    expectLines(1);
    editor.setText("");
    await settle();
    expectLines(1);
    setForm(null);
    screen.resize(32, 30);
    await settle();
    expectLines(1);
  } finally {
    await screen.dispose();
    await flushDrafts();
    request.mockRestore();
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
  }
});

test("message placeholder clears on focus before IME composition and returns only outside editing", async () => {
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "hhu-placeholder-offline-"));
  const conversation: Conversation = {
    id: "offline-placeholder",
    projectId: "project",
    title: "Placeholder",
    archivedAt: null,
    workspaceMode: "shared",
    workspacePath: "/tmp",
    runtimeStatus: "IDLE",
    createdAt: 0,
    updatedAt: 0,
  };
  let saved: Draft = {
    conversationId: conversation.id,
    text: "",
    revision: 0,
    pendingSubmission: null,
  };
  const request = spyOn(DraftSession.prototype, "request").mockImplementation(
    async <Response,>(_path: string, method = "GET", body?: unknown): Promise<Response> => {
      if (method === "PUT") saved = { ...saved, ...(body as Draft), revision: saved.revision + 1 };
      return { ...saved } as Response;
    },
  );
  const [form, setForm] = createSignal<Parameters<typeof AgentPane>[0]["form"]>(null);
  const screen = await testRender(
    () => (
      <AgentPane
        conversation={conversation}
        form={form()}
        setForm={setForm}
        onDraftError={() => {}}
      />
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  );
  const placeholder = "Type a message, / for commands, ? for shortcuts";
  try {
    for (let count = 0; count < 5; count++) {
      await screen.renderOnce();
      await Bun.sleep(20);
    }
    const editor = screen.renderer.root.findDescendantById("message-draft") as TextareaRenderable;
    expect(screen.captureCharFrame()).toContain(placeholder);
    screen.mockInput.pressEnter();
    await screen.renderOnce();
    expect(editor.focused).toBe(true);
    expect(editor.plainText).toBe("");
    expect(screen.captureCharFrame()).not.toContain(placeholder);

    await screen.mockInput.typeText("pu");
    await screen.renderOnce();
    expect(editor.plainText).toBe("pu");
    expect(screen.captureCharFrame()).not.toContain(placeholder);
    screen.mockInput.pressBackspace();
    screen.mockInput.pressBackspace();
    await screen.renderOnce();
    expect(editor.plainText).toBe("");
    expect(screen.captureCharFrame()).not.toContain(placeholder);

    await screen.mockInput.pasteBracketedText("普通输入 👋\n第二行");
    await screen.renderOnce();
    expect(editor.plainText).toBe("普通输入 👋\n第二行");
    screen.mockInput.pressEscape();
    await screen.renderOnce();
    expect(screen.captureCharFrame()).not.toContain(placeholder);
    editor.setText("");
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain(placeholder);

    const composer = screen.renderer.root.findDescendantById("message-composer");
    if (!composer) throw new Error("Missing composer");
    await screen.mockMouse.click(composer.x, composer.y);
    await screen.renderOnce();
    expect(editor.focused).toBe(true);
    expect(screen.captureCharFrame()).not.toContain(placeholder);
  } finally {
    await screen.dispose();
    await flushDrafts();
    request.mockRestore();
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
  }
});

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
