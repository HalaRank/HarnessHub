import { expect, test } from "bun:test";
import type { TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { PasteBlocks, shouldFoldPaste } from "../../apps/tui/src/paste-blocks";

const large = "第一行 👋\nsecond\nthird\nfourth\nfifth\nsixth";

async function setup() {
  let editor!: TextareaRenderable;
  let pastes!: PasteBlocks;
  let saved = "";
  const screen = await testRender(
    () => (
      <textarea
        width={60}
        height={8}
        focused
        keyBindings={[{ name: "return", shift: true, action: "newline" }]}
        ref={(element) => {
          editor = element;
          pastes = new PasteBlocks(element);
        }}
        onPaste={(event) => pastes.paste(event)}
        onKeyDown={(key) => pastes.onKeyDown(key, key.name === "return" && key.shift)}
        onContentChange={() => {
          saved = pastes.text;
        }}
      />
    ),
    { width: 60, height: 12, kittyKeyboard: true },
  );
  await screen.renderOnce();
  return { ...screen, editor, pastes, saved: () => saved };
}

test("paste folding thresholds count lines and Unicode characters, not UTF-16 units", () => {
  expect(shouldFoldPaste("one\ntwo\nthree\nfour\nfive")).toBe(false);
  expect(shouldFoldPaste(large)).toBe(true);
  expect(shouldFoldPaste("a".repeat(999))).toBe(false);
  expect(shouldFoldPaste("a".repeat(1000))).toBe(true);
  expect(shouldFoldPaste("👋".repeat(999))).toBe(false);
  expect(shouldFoldPaste("👋".repeat(1000))).toBe(true);
});

test("multiple paste blocks preserve original text, Unicode prefixes and literal labels", async () => {
  const screen = await setup();
  try {
    await screen.mockInput.pasteBracketedText("前缀 👋 ");
    await screen.mockInput.pasteBracketedText(large);
    expect(screen.editor.plainText).toBe("前缀 👋 [粘贴 #1 · 6 行]");
    expect(screen.saved()).toBe(`前缀 👋 ${large}`);
    await screen.mockInput.typeText(" suffix ");
    await screen.mockInput.pasteBracketedText("b".repeat(1000));
    await screen.mockInput.pasteBracketedText("[粘贴 #1 · 6 行]");
    expect(screen.pastes.blocks).toHaveLength(2);
    const original = `前缀 👋 ${large} suffix ${"b".repeat(1000)}[粘贴 #1 · 6 行]`;
    expect(screen.pastes.text).toBe(original);
    expect(screen.saved()).toBe(original);
    screen.pastes.expand();
    expect(screen.pastes.blocks).toHaveLength(0);
    expect(screen.editor.plainText).toBe(original);
    expect(screen.saved()).toBe(original);
  } finally {
    await screen.dispose();
  }
});

test("backspace deletes a whole block and undo/redo restore its full original payload", async () => {
  const screen = await setup();
  try {
    await screen.mockInput.typeText("prefix ");
    await screen.mockInput.pasteBracketedText(large);
    screen.mockInput.pressBackspace();
    await screen.renderOnce();
    expect(screen.editor.plainText).toBe("prefix ");
    expect(screen.saved()).toBe("prefix ");
    screen.editor.undo();
    await screen.renderOnce();
    expect(screen.pastes.text).toBe(`prefix ${large}`);
    expect(screen.saved()).toBe(`prefix ${large}`);
    screen.editor.redo();
    await screen.renderOnce();
    expect(screen.pastes.text).toBe("prefix ");
    expect(screen.saved()).toBe("prefix ");
    screen.editor.undo();
    screen.editor.undo();
    await screen.renderOnce();
    expect(screen.pastes.blocks).toHaveLength(0);
    expect(screen.pastes.text).toBe("prefix ");
    screen.editor.redo();
    await screen.renderOnce();
    expect(screen.pastes.text).toBe(`prefix ${large}`);
  } finally {
    await screen.dispose();
  }
});

test("partial selections replace complete blocks without leaving placeholder fragments", async () => {
  const screen = await setup();
  try {
    await screen.mockInput.typeText("before ");
    await screen.mockInput.pasteBracketedText(large);
    await screen.mockInput.typeText(" after");
    const block = screen.pastes.blocks[0];
    if (!block) throw new Error("Missing block");
    screen.editor.setSelection(block.start + 2, block.end - 2);
    await screen.mockInput.typeText("replacement");
    expect(screen.pastes.blocks).toHaveLength(0);
    expect(screen.saved()).toBe("before replacement after");
  } finally {
    await screen.dispose();
  }
});

test("replacing a selection with a paste, clearing and restoring drafts never leak markers", async () => {
  const screen = await setup();
  try {
    await screen.mockInput.typeText("replace me");
    screen.editor.selectAll();
    await screen.mockInput.pasteBracketedText(large);
    expect(screen.saved()).toBe(large);
    const saved = screen.saved();
    screen.editor.setText("");
    await screen.renderOnce();
    expect(screen.saved()).toBe("");
    expect(screen.pastes.blocks).toHaveLength(0);
    screen.editor.undo();
    await screen.renderOnce();
    expect(screen.pastes.text).toBe("");
    screen.editor.setText(saved);
    await screen.renderOnce();
    expect(screen.pastes.text).toBe(large);
    expect(screen.editor.plainText).toBe(large);
    expect(screen.pastes.blocks).toHaveLength(0);
  } finally {
    await screen.dispose();
  }
});

test("ordinary typing stays expanded and paste uses the terminal's existing ANSI sanitization", async () => {
  const screen = await setup();
  try {
    screen.editor.insertText(large);
    expect(screen.pastes.blocks).toHaveLength(0);
    screen.editor.setText("");
    await screen.mockInput.pasteBracketedText(`\u001b[31m${large}\u001b[0m`);
    expect(screen.saved()).toBe(large);
    expect(screen.pastes.blocks).toHaveLength(1);
  } finally {
    await screen.dispose();
  }
});

test("word deletion and forward delete treat folded text as an indivisible block", async () => {
  const screen = await setup();
  try {
    for (const name of ["w", "BACKSPACE"]) {
      screen.editor.setText("prefix ");
      screen.editor.gotoBufferEnd();
      await screen.mockInput.pasteBracketedText(large);
      screen.mockInput.pressKey(name, { ctrl: true });
      await screen.renderOnce();
      expect(screen.saved()).toBe("prefix ");
      expect(screen.pastes.blocks).toHaveLength(0);
    }
    screen.editor.setText("");
    await screen.mockInput.pasteBracketedText(large);
    await screen.mockInput.typeText(" suffix");
    screen.editor.gotoBufferHome();
    screen.mockInput.pressKey("DELETE", { ctrl: true });
    await screen.renderOnce();
    expect(screen.saved()).toBe(" suffix");
    expect(screen.pastes.blocks).toHaveLength(0);
    screen.editor.setText("");
    await screen.mockInput.pasteBracketedText(large);
    screen.editor.gotoBufferHome();
    screen.mockInput.pressKey("DELETE");
    await screen.renderOnce();
    expect(screen.saved()).toBe("");
    expect(screen.pastes.blocks).toHaveLength(0);
  } finally {
    await screen.dispose();
  }
});

test("expansion can be undone and line-edit shortcuts never strand a partial marker", async () => {
  const screen = await setup();
  try {
    await screen.mockInput.pasteBracketedText(large);
    screen.pastes.expand();
    await screen.renderOnce();
    expect(screen.saved()).toBe(large);
    screen.editor.undo();
    await screen.renderOnce();
    expect(screen.pastes.blocks).toHaveLength(1);
    expect(screen.saved()).toBe(large);
    screen.editor.redo();
    await screen.renderOnce();
    expect(screen.pastes.blocks).toHaveLength(0);
    expect(screen.saved()).toBe(large);
    for (const name of ["u", "k", "d"]) {
      screen.editor.setText("");
      await screen.mockInput.pasteBracketedText(large);
      if (name === "k") screen.editor.gotoBufferHome();
      screen.mockInput.pressKey(name, { ctrl: true, shift: name === "d" });
      await screen.renderOnce();
      expect(screen.pastes.blocks).toHaveLength(0);
      expect(screen.saved()).toBe("");
    }
  } finally {
    await screen.dispose();
  }
});

test("newline and line deletion cannot split a selected paste marker", async () => {
  const screen = await setup();
  try {
    for (const action of ["newline", "u", "k"]) {
      screen.editor.setText("");
      await screen.mockInput.pasteBracketedText(large);
      const block = screen.pastes.blocks[0];
      if (!block) throw new Error("Missing paste");
      screen.editor.setCursor(0, block.end - 2);
      screen.editor.setSelection(block.start + 2, block.end - 2);
      if (action === "newline") screen.mockInput.pressEnter({ shift: true });
      else screen.mockInput.pressKey(action, { ctrl: true });
      await screen.renderOnce();
      expect(screen.pastes.text).toBe(action === "newline" ? "\n" : "");
    }
  } finally {
    await screen.dispose();
  }
});
