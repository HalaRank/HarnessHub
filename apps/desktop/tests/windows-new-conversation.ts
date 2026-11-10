import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, ConversationEvent } from "@harnesshub/shared";
import type { BrowserWindow } from "electron";
import type { DesktopConnection } from "../src/main/connection";

export async function newConversationSmoke(
  win: BrowserWindow,
  connection: DesktopConnection,
  output: string,
  helpers: {
    click: (win: BrowserWindow, selector: string) => Promise<void>;
    fill: (win: BrowserWindow, text: string) => Promise<void>;
    waitFor: (check: () => unknown | Promise<unknown>) => Promise<void>;
  },
) {
  const { click, fill, waitFor } = helpers;
  const js = (source: string) => win.webContents.executeJavaScript(source);
  const original = connection.getState().conversationId;
  await click(win, '.project-heading button[aria-label="新建会话"]');
  await waitFor(() =>
    js(
      "!!document.querySelector('.new-conversation') && !document.querySelector('textarea').disabled",
    ),
  );
  assert.equal(await js("!!document.querySelector('input[aria-label=会话名称]')"), false);
  assert.equal(await js("!!document.querySelector('dialog')"), false);
  assert.ok(
    await js(
      "document.querySelector('.new-conversation h2').textContent.includes('HarnessHub Desktop')",
    ),
  );
  await fill(win, "切换页面仍保存首条消息");
  await click(win, ".conversation-item");
  await waitFor(() => js("!document.querySelector('.new-conversation')"));
  await click(win, '.project-heading button[aria-label="新建会话"]');
  await waitFor(() => js("document.querySelector('textarea')?.value === '切换页面仍保存首条消息'"));
  console.log("New page restored the first-message SQLite draft after switching conversations");
  await waitFor(() => js("!document.querySelector('input[aria-label=创建工作树]').disabled"));
  await click(win, 'input[aria-label="创建工作树"]');
  assert.equal(await js("document.querySelector('select[aria-label=分支]').disabled"), false);
  await js(
    "const s = document.querySelector('select[aria-label=Harness]'); s.value = 'desktop-smoke'; s.dispatchEvent(new Event('change', {bubbles:true}));",
  );
  await fill(win, "新建页自动命名 smoke");
  win.setSize(1440, 940);
  await new Promise((resolve) => setTimeout(resolve, 250));
  writeFileSync(
    join(output, "desktop-new-conversation.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js("const b = document.querySelector('[aria-label=发送消息]'); b.click(); b.click();");
  await waitFor(() =>
    js(
      "!document.querySelector('.new-conversation') && document.querySelector('h1').textContent === '新建页自动命名 smoke'",
    ),
  );
  const id = connection.getState().conversationId;
  console.log("New page sent one unnamed Worktree conversation");
  assert.ok(id && id !== original);
  const conversation = connection.getState().snapshot?.conversations.find((c) => c.id === id);
  assert.ok(conversation);
  assert.equal(conversation.workspaceMode, "worktree");
  assert.ok(conversation.worktreeId);
  const events = async () =>
    (
      (await connection.action({ type: "history", conversationId: id, after: 0 })) as {
        events: ConversationEvent[];
      }
    ).events;
  await waitFor(async () => {
    return (await events()).some((e) => e.kind === "runtime.turn_finished");
  });
  assert.equal((await events()).filter((e) => e.kind === "user.message").length, 1);
  assert.equal(connection.getState().interaction?.sessions[0]?.cwd, conversation.workspacePath);
  const targetRow =
    "Array.from(document.querySelectorAll('.conversation-row')).find(r => r.querySelector('.conversation-item')?.getAttribute('aria-current') === 'page')";
  await js(`${targetRow}.querySelector('.conversation-actions button:first-child').click()`);
  await waitFor(() => js("!!document.querySelector('dialog[open]')"));
  await js(
    "const i = document.querySelector('input[aria-label=会话名称]'); i.focus(); i.select();",
  );
  await win.webContents.insertText("手动重命名 smoke");
  await click(win, 'dialog button[type="submit"]');
  await waitFor(() => js("document.querySelector('h1').textContent === '手动重命名 smoke'"));
  await js(`${targetRow}.querySelector('.conversation-actions button:last-child').click()`);
  await waitFor(
    () => connection.getState().snapshot?.conversations.find((c) => c.id === id)?.archivedAt,
  );
  await js(
    "Array.from(document.querySelectorAll('.tree-toolbar button')).find(b => b.textContent === '查看归档').click()",
  );
  await waitFor(() =>
    js(
      "!!document.querySelector('.conversation-row .conversation-actions button[title=恢复归档]')",
    ),
  );
  await click(win, '.conversation-actions button[title="恢复归档"]');
  await waitFor(
    () =>
      connection.getState().snapshot?.conversations.find((c) => c.id === id)?.archivedAt === null,
  );
  await js(
    "Array.from(document.querySelectorAll('.tree-toolbar button')).find(b => b.textContent === '返回会话').click()",
  );
  await js(`${targetRow}.querySelector('.conversation-actions button:first-child').focus()`);
  const standalone = (await connection.action({
    type: "conversation.standalone",
    workspacePath: conversation.workspacePath,
    title: "独立底部 smoke",
  })) as Conversation;
  await waitFor(() =>
    js("!!document.querySelector('.standalone-conversations .standalone-label')"),
  );
  assert.equal(
    await js("!!document.querySelector('.standalone-conversations .project-heading')"),
    false,
  );
  assert.equal(
    await js("document.querySelector('.tree > section:last-child').className"),
    "standalone-conversations",
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  writeFileSync(
    join(output, "desktop-conversation-actions.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await connection.action({ type: "conversation.delete", conversationId: id, confirmed: true });
  await connection.action({
    type: "conversation.delete",
    conversationId: standalone.id,
    confirmed: true,
  });
  if (original) await connection.select(original);
  return [
    "New page shows HarnessHub logo/project sentence and inline project, real branch and Worktree controls without a title dialog",
    "Unsent first-message draft survives leaving and reopening the new page through SQLite",
    "Double send creates one user Turn, automatic title and native cwd in the real managed Worktree",
    "Conversation row rename, archive and restore operate on the target conversation",
    "Standalone rows follow every project, use root indentation and row-level labels without a project heading",
  ];
}
