import {
  decodePasteBytes,
  type ExtmarksController,
  type KeyEvent,
  type PasteEvent,
  stripAnsiSequences,
  type TextareaRenderable,
} from "@opentui/core";

type PasteContent = { text: string; label: string };

export function shouldFoldPaste(text: string) {
  return text.split("\n").length >= 6 || Array.from(text).length >= 1000;
}

export class PasteBlocks {
  private readonly marks: ExtmarksController;
  private readonly typeId;
  private sequence = 0;

  constructor(private readonly editor: TextareaRenderable) {
    this.marks = editor.editorView.extmarks;
    this.typeId = this.marks.registerType("harnesshub-paste");
  }

  get blocks() {
    return this.marks.getAllForTypeId(this.typeId).sort((left, right) => left.start - right.start);
  }

  get text() {
    let offset = 0;
    const parts: string[] = [];
    for (const block of this.blocks) {
      const content = block.data as PasteContent;
      if (this.editor.getTextRange(block.start, block.end) !== content.label)
        throw new Error("Pasted block was modified; expand pasted text before sending");
      parts.push(this.editor.getTextRange(offset, block.start), content.text);
      offset = block.end;
    }
    parts.push(
      this.editor.getTextRange(offset, this.editor.editBuffer.measureText(this.editor.plainText)),
    );
    return parts.join("");
  }

  prepareEdit() {
    const selection = this.editor.editorView.getSelection();
    if (selection) {
      let start = Math.min(selection.start, selection.end);
      let end = Math.max(selection.start, selection.end);
      for (const block of this.blocks) {
        if (start < block.end && end > block.start) {
          start = Math.min(start, block.start);
          end = Math.max(end, block.end);
        }
      }
      this.editor.setSelection(start, end);
    } else {
      const block = this.blocks.find(
        (entry) => entry.start < this.editor.cursorOffset && this.editor.cursorOffset < entry.end,
      );
      if (block) this.editor.cursorOffset = block.end;
    }
  }

  onKeyDown(key: KeyEvent, newline = false) {
    if (["left", "right", "up", "down", "home", "end", "pageup", "pagedown"].includes(key.name))
      return;
    this.prepareEdit();
    const selection = this.editor.editorView.getSelection();
    if (selection) {
      const start = Math.min(selection.start, selection.end);
      const end = Math.max(selection.start, selection.end);
      if (this.blocks.some((block) => start < block.end && end > block.start)) {
        if (newline) {
          key.preventDefault();
          this.editor.insertText("\n");
        } else if (key.ctrl && (["k", "u"].includes(key.name) || (key.shift && key.name === "d"))) {
          key.preventDefault();
          this.editor.deleteSelection();
        }
      }
      return;
    }
    const backward =
      (key.ctrl && key.name === "w") || ((key.ctrl || key.meta) && key.name === "backspace");
    const forward =
      (key.meta && key.name === "d") || ((key.ctrl || key.meta) && key.name === "delete");
    if (!backward && !forward) return;
    const start = backward
      ? this.editor.editorView.getPrevWordBoundary().offset
      : this.editor.cursorOffset;
    const end = forward
      ? this.editor.editorView.getNextWordBoundary().offset
      : this.editor.cursorOffset;
    if (!this.blocks.some((block) => start < block.end && end > block.start)) return;
    key.preventDefault();
    this.editor.setSelection(start, end);
    this.prepareEdit();
    this.editor.deleteSelection();
  }

  paste(event: PasteEvent) {
    this.prepareEdit();
    const text = stripAnsiSequences(decodePasteBytes(event.bytes));
    if (!shouldFoldPaste(text)) return;
    event.preventDefault();
    const lines = text.split("\n").length;
    const label = `[粘贴 #${++this.sequence} · ${lines} 行]`;
    this.editor.editBuffer.runMutation(() => {
      this.editor.insertText(label);
      const end = this.editor.cursorOffset;
      this.marks.create({
        start: end - this.editor.editBuffer.measureText(label),
        end,
        virtual: true,
        typeId: this.typeId,
        data: { text, label } satisfies PasteContent,
      });
    });
  }

  expand() {
    this.editor.replaceText(this.text);
    this.editor.gotoBufferEnd();
    this.editor.focus();
  }
}
