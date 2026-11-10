import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Conversation,
  ConversationEvent,
  GitChanges,
  Handoff,
  ManagedWorktree,
  Turn,
} from "@harnesshub/shared";
import type { Client } from "@harnesshub/shared/client";
import { type BrowserWindow, clipboard } from "electron";
import type { DesktopConnection } from "../src/main/connection";

export async function workspaceSmoke(
  win: BrowserWindow,
  connection: DesktopConnection,
  client: Client,
  output: string,
  helpers: {
    click: (win: BrowserWindow, selector: string) => Promise<void>;
    fill: (win: BrowserWindow, text: string) => Promise<void>;
    waitFor: (check: () => unknown | Promise<unknown>) => Promise<void>;
  },
) {
  const { click, fill, waitFor } = helpers;
  const checks: string[] = [];
  const js = (source: string) =>
    win.webContents.executeJavaScript(source).catch((error) => {
      throw new Error(`${source}: ${String(error)}`);
    });
  const capture = async (name: string) => {
    win.show();
    win.focus();
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await new Promise((resolve) => setTimeout(resolve, 350));
    writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG());
  };
  const project = connection.getState().snapshot?.projects[0];
  assert.ok(project);
  const c = (await connection.action({
    type: "conversation.create",
    projectId: project.id,
    title: "Coding Workspace Phase 3",
    workspaceMode: "shared",
  })) as Conversation;
  await connection.select(c.id);
  await connection.action({
    type: "harness.select",
    conversationId: c.id,
    harnessId: "desktop-smoke",
  });
  await waitFor(() =>
    js(
      "document.querySelector('h1').textContent === 'Coding Workspace Phase 3' && document.querySelector('select[aria-label=Harness]').value === 'desktop-smoke'",
    ),
  );
  const events = async () =>
    (
      await client.request<{ events: ConversationEvent[] }>(
        `/v1/conversations/${c.id}/events?limit=1000`,
      )
    ).events;
  await fill(win, "/path ordinary text");
  await click(win, '[aria-label="发送"]');
  await waitFor(() =>
    js("document.querySelector('dialog')?.textContent.includes('作为普通文本发送')"),
  );
  await js(
    "document.querySelector('dialog').dispatchEvent(new Event('cancel', {cancelable: true}))",
  );
  assert.equal((await events()).filter((e) => e.kind === "user.message").length, 0);
  assert.equal(await js("document.querySelector('textarea').value"), "/path ordinary text");
  await click(win, '[aria-label="发送"]');
  await waitFor(() => js("!!document.querySelector('dialog')"));
  await js(
    "const confirmButton = document.querySelector('dialog footer button:last-child'); confirmButton.click(); confirmButton.click();",
  );
  await waitFor(async () => (await events()).filter((e) => e.kind === "user.message").length === 1);
  await waitFor(async () => {
    const first = (await events()).find((e) => e.kind === "user.message");
    return first?.turnId && (await client.request<Turn>(`/v1/turns/${first.turnId}`)).endedAt;
  });
  await waitFor(
    () =>
      connection.getState().snapshot?.conversations.find((v) => v.id === c.id)?.runtimeStatus ===
      "IDLE",
  );
  checks.push(
    "Unpublished /path: cancel preserves draft, explicit plain-text confirmation and rapid double click produce exactly one Prompt",
  );
  const send = async (text: string) => {
    const before = (await events()).filter((e) => e.kind === "user.message").length;
    await fill(win, text);
    await click(win, '[aria-label="发送"]');
    await waitFor(
      async () => (await events()).filter((e) => e.kind === "user.message").length === before + 1,
    );
    await waitFor(async () => {
      const last = (await events()).filter((e) => e.kind === "user.message").at(-1);
      return last?.turnId && (await client.request<Turn>(`/v1/turns/${last.turnId}`)).endedAt;
    });
    await waitFor(
      () =>
        connection.getState().snapshot?.conversations.find((v) => v.id === c.id)?.runtimeStatus ===
        "IDLE",
    );
  };
  await send("desktop-native-diff");
  await waitFor(() => js("!!document.querySelector('.tool-activity')"));
  await js(
    "document.querySelectorAll('.activity-heading[aria-expanded=\"false\"]').forEach(b => b.click())",
  );
  await waitFor(() =>
    js(
      "Array.from(document.querySelectorAll('.tool-heading')).some(b => b.textContent.includes('Mock native Diff'))",
    ),
  );
  await js(
    "Array.from(document.querySelectorAll('.tool-heading')).find(b => b.textContent.includes('Mock native Diff')).click()",
  );
  assert.ok(
    await js("document.querySelector('.native-diff').textContent.includes('原生 ACP Diff')"),
  );
  await click(win, ".native-diff details:last-child summary");
  assert.ok(
    await js("document.querySelector('.native-diff').textContent.includes('native proposed text')"),
  );
  if (!(await js("!!document.querySelector('.work-panel')")))
    await click(win, '[aria-label="切换工作面板"]');
  const tab = async (name: string) => {
    await waitFor(() => js("!!document.querySelector('.work-panel > header')"));
    await js(
      `Array.from(document.querySelectorAll('.work-panel > header button')).find(b => b.textContent === ${JSON.stringify(name)}).click()`,
    );
  };
  await tab("Changes");
  await waitFor(() => js("document.querySelectorAll('.change-file').length >= 5"));
  const changes = (await connection.action({
    type: "changes.list",
    conversationId: c.id,
  })) as GitChanges;
  assert.equal(changes.workspace, c.workspacePath);
  for (const status of ["Added", "Modified", "Deleted", "Untracked"])
    assert.ok(
      await js(
        `document.querySelector('.changes').textContent.includes(${JSON.stringify(status)})`,
      ),
    );
  await js(
    "Array.from(document.querySelectorAll('.change-file')).find(b => b.textContent.includes('large.ts')).click()",
  );
  await waitFor(() => js("document.querySelectorAll('.work-panel .diff-line').length >= 200"));
  assert.ok(await js("document.querySelectorAll('.work-panel .diff-line').length <= 210"));
  await js(
    "Array.from(document.querySelectorAll('.work-panel .diff-code')).at(-1).scrollTop = 1000",
  );
  assert.ok(
    await js(
      "Array.from(document.querySelectorAll('.work-panel .diff-code')).at(-1).scrollTop > 0",
    ),
  );
  await js(
    "Array.from(document.querySelectorAll('.diff-pages button')).find(b => b.textContent === '下一页行').click()",
  );
  await waitFor(() => js("document.querySelector('.diff-pages').textContent.includes('201')"));
  await click(win, '.diff-heading button[title="复制完整原文"]');
  await waitFor(async () => (await clipboard.readText()).includes("const line1199"));
  // Only the fixed provenance action is available to Renderer; actually opens a WSL folder.
  await click(win, '.work-panel .path-actions button[title="在 Windows Explorer 打开 WSL 文件夹"]');
  await waitFor(() =>
    js("document.querySelector('.work-panel .path-actions').textContent.includes('已打开')"),
  );
  checks.push(
    "Real Git statuses, file Diff, 1200-line paging/scroll/highlight/copy, separate native ACP Diff and controlled Explorer folder navigation",
  );
  await capture("desktop-phase3-diff.png");
  await fill(win, "保留输入，不因工作面板丢失");
  await click(win, '[aria-label="关闭工作面板"]');
  assert.equal(await js("document.querySelector('textarea').value"), "保留输入，不因工作面板丢失");
  await connection.action({
    type: "harness.select",
    conversationId: c.id,
    harnessId: "desktop-grok-mock",
  });
  await waitFor(() =>
    js("document.querySelector('select[aria-label=Harness]').value === 'desktop-grok-mock'"),
  );
  assert.equal((await client.request<Handoff[]>(`/v1/conversations/${c.id}/handoffs`)).length, 0);
  await send("continue target");
  await connection.action({
    type: "harness.select",
    conversationId: c.id,
    harnessId: "desktop-smoke",
  });
  await waitFor(() =>
    js("document.querySelector('select[aria-label=Harness]').value === 'desktop-smoke'"),
  );
  await send("return source");
  await click(win, '[aria-label="切换工作面板"]');
  await tab("Details");
  await waitFor(() => js("document.querySelectorAll('.handoff-record').length === 2"));
  const handoffs = await client.request<Handoff[]>(`/v1/conversations/${c.id}/handoffs`);
  assert.ok(handoffs.every((h) => h.status === "COMMITTED"));
  assert.notEqual(handoffs[0]?.sourceNativeSessionId, handoffs[1]?.targetNativeSessionId);
  await js(
    "Array.from(document.querySelectorAll('.handoff-record summary')).find(b => b.textContent === '完整交接报告').click()",
  );
  checks.push(
    "Windows cross-Harness roundtrip uses fresh target sessions, visible COMMITTED reports/source boundaries; selection alone starts no Handoff",
  );
  await capture("desktop-phase3-handoff.png");
  // Create a managed worktree through the actual modal, then explicitly delete only its Conversation.
  await click(win, '.project-heading button[aria-label="新建会话"]');
  await waitFor(() => js("!!document.querySelector('dialog select')"));
  await js(
    "const select = document.querySelector('dialog select'); select.value = 'worktree'; select.dispatchEvent(new Event('change', { bubbles: true }));",
  );
  await click(win, 'dialog button[type="submit"]');
  await waitFor(
    () =>
      connection.getState().conversationId !== c.id &&
      connection
        .getState()
        .snapshot?.conversations.some(
          (v) => v.id === connection.getState().conversationId && v.workspaceMode === "worktree",
        ),
  );
  const work = connection
    .getState()
    .snapshot?.conversations.find((v) => v.id === connection.getState().conversationId);
  assert.ok(work?.worktreeId);
  assert.notEqual(work.workspacePath, c.workspacePath);
  await tab("Changes");
  await waitFor(() => js("document.querySelector('.changes').textContent.includes('工作区干净')"));
  await tab("Details");
  await click(win, ".panel-content details > summary");
  await click(win, ".management-actions button:last-child");
  await click(win, 'dialog button[type="submit"]');
  await waitFor(() => !connection.getState().snapshot?.conversations.some((v) => v.id === work.id));
  await connection.select(c.id);
  await waitFor(() => js("document.querySelectorAll('.handoff-record').length === 2"));
  await waitFor(() => js("!!document.querySelector('.worktree-record button:not([disabled])')"));
  await click(win, ".worktree-record > button:last-of-type");
  await waitFor(() => js("document.querySelector('dialog')?.textContent.includes('保留式清理')"));
  assert.ok(await js("document.querySelector('dialog').textContent.includes('/retained/')"));
  await click(win, "dialog footer button:first-child");
  assert.equal(
    ((await connection.action({ type: "worktrees.list" })) as ManagedWorktree[]).find(
      (w) => w.id === work.worktreeId,
    )?.status,
    "READY",
  );
  await click(win, ".worktree-record > button:last-of-type");
  await click(win, "dialog footer button:last-child");
  await waitFor(() =>
    js("document.querySelector('.managed-worktrees').textContent.includes('RETAINED')"),
  );
  checks.push(
    "Windows Worktree creation, workspace-specific Changes, delete preserves worktree; cleanup cancel is inert and explicit confirm retains directory/branch",
  );
  await capture("desktop-phase3-worktree.png");
  win.setSize(860, 640);
  await tab("Changes");
  await waitFor(() => js("!!document.querySelector('.changes')"));
  assert.ok(
    await js(
      "document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.querySelector('.work-panel')).position === 'absolute'",
    ),
  );
  await capture("desktop-phase3-narrow.png");
  win.setSize(1280, 860);
  await click(win, '[aria-label="关闭工作面板"]');
  return checks;
}
