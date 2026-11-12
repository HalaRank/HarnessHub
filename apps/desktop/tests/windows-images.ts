import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationEvent, Draft, Turn } from "@harnesshub/shared";
import { type BrowserWindow, ClipboardItem, clipboard, nativeImage } from "electron";
import type { DesktopConnection } from "../src/main/connection";

export async function imageSmoke(
  win: BrowserWindow,
  connection: DesktopConnection,
  output: string,
) {
  const previous: ClipboardItem[] = [];
  for (const item of await clipboard.read()) {
    const entries = await Promise.all(
      item.types.map(async (type) => [type, await item.getType(type)]),
    );
    previous.push(new ClipboardItem(Object.fromEntries(entries)));
  }
  try {
    return await verifyImages(win, connection, output);
  } finally {
    await clipboard.write(previous);
  }
}

async function verifyImages(win: BrowserWindow, connection: DesktopConnection, output: string) {
  const js = (source: string) => win.webContents.executeJavaScript(source, true);
  const until = async (check: () => unknown | Promise<unknown>) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Image smoke timeout");
  };
  const id = connection.getState().conversationId;
  assert.ok(id);
  const pixels = Buffer.alloc(64 * 64 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 40;
    pixels[index + 1] = 70;
    pixels[index + 2] = 230;
    pixels[index + 3] = 255;
  }
  const png = nativeImage.createFromBitmap(pixels, { width: 64, height: 64 }).toPNG();
  const file = join(output, "上传图片.png");
  writeFileSync(file, png);
  const readDraft = () =>
    connection.action({ type: "draft.load", conversationId: id }) as Promise<Draft>;
  await until(() =>
    js("!!document.querySelector('textarea') && !document.querySelector('textarea').disabled"),
  );
  // Exercise the upload button and Chromium file selection without an unattended OS dialog.
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Page.enable");
  await win.webContents.debugger.sendCommand("Page.setInterceptFileChooserDialog", {
    enabled: true,
  });
  let fileNode: number | undefined;
  win.webContents.debugger.on("message", (_event, method, params) => {
    if (method === "Page.fileChooserOpened") fileNode = params.backendNodeId;
  });
  await js("document.querySelector('[aria-label=添加附件]').click()");
  await until(() => !!fileNode);
  await win.webContents.debugger.sendCommand("DOM.setFileInputFiles", {
    files: [file],
    backendNodeId: fileNode,
  });
  await until(async () => (await readDraft()).images?.length === 1);
  console.log("Windows file selection persisted an image");
  assert.equal((await readDraft()).images?.[0]?.name, "上传图片.png");
  win.webContents.debugger.detach();
  // Real Windows clipboard and Ctrl+V reach the same React paste handler as a screenshot.
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)]) })]);
  await js("document.querySelector('textarea').focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
  await until(async () => (await readDraft()).images?.length === 2);
  console.log("Windows Ctrl+V pasted a second image");
  const draft = await readDraft();
  assert.ok(draft.images?.every((image) => image.mimeType === "image/png"));
  await until(() =>
    js(
      "[...document.querySelectorAll('.image-attachment img')].every(i => i.complete && i.naturalWidth > 0)",
    ),
  );
  writeFileSync(join(output, "desktop-images.png"), (await win.webContents.capturePage()).toPNG());
  await js("document.querySelector('.image-attachment button').click()");
  await until(async () => (await readDraft()).images?.length === 1);
  // Reopening the conversation restores the same SQLite image draft.
  await connection.select(id);
  assert.equal((await readDraft()).images?.length, 1);
  await until(() => js("!document.querySelector('button[aria-label=发送]').disabled"));
  await js("const b = document.querySelector('button[aria-label=发送]'); b.click(); b.click();");
  let events: ConversationEvent[] = [];
  await until(async () => {
    const history = (await connection.action({
      type: "history",
      conversationId: id,
      after: 0,
    })) as { events: ConversationEvent[] };
    events = history.events;
    return events.some(
      (event) =>
        event.kind === "user.message" && (event.payload as { images?: unknown[] }).images?.length,
    );
  });
  const user = events.filter(
    (event) =>
      event.kind === "user.message" && (event.payload as { images?: unknown[] }).images?.length,
  );
  assert.equal(user.length, 1);
  const message = user[0];
  assert.ok(message);
  const turn = (await connection.action({
    type: "request.lookup",
    conversationId: id,
    requestId: (message.payload as { requestId: string }).requestId,
  })) as Turn;
  await until(async () => {
    const result = (await connection.action({
      type: "request.lookup",
      conversationId: id,
      requestId: turn.requestId,
    })) as Turn;
    return result.endedAt && result.state === "COMPLETED";
  });
  assert.deepEqual((await readDraft()).images, []);
  await until(() => js("!!document.querySelector('.history .image-attachment img')"));

  // The first-message composer has the same upload and paste entry points.
  await js("document.querySelector('.project-heading button[aria-label=新建会话]').click()");
  await until(() =>
    js(
      "!!document.querySelector('.new-conversation textarea') && !document.querySelector('textarea').disabled",
    ),
  );
  await js("document.querySelector('textarea').focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
  await until(() =>
    js("document.querySelectorAll('.new-conversation .image-attachment').length === 1"),
  );
  const newDraft = (await connection.action({ type: "new-draft.load" })) as Draft;
  assert.equal(newDraft.images?.length, 1);
  await js("document.querySelector('button[aria-label=发送消息]').click()");
  await until(() =>
    js(
      "!document.querySelector('.new-conversation') && !!document.querySelector('.history .image-attachment img')",
    ),
  );
  assert.deepEqual(((await connection.action({ type: "new-draft.load" })) as Draft).images, []);
  return [
    "Windows upload button/file selection",
    "Windows clipboard Ctrl+V image",
    "Thumbnails decoded and removal saved",
    "Image-only send deduplicated and native ACP completed",
    "History preview and cleared draft",
    "New-conversation image paste and first-message send",
  ];
}
