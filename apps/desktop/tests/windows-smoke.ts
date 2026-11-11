// Explicit Windows integration harness, never bundled in the production app.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@harnesshub/shared/client";
import { app, type BrowserWindow } from "electron";
import { openDesktopWindow } from "../src/main/window";
import { runWsl, WslBridge } from "../src/main/wsl";
import { realHandoffSmoke } from "./windows-handoff";
import { imageSmoke } from "./windows-images";
import { newConversationSmoke } from "./windows-new-conversation";
import { workspaceSmoke } from "./windows-workspace";

const config = JSON.parse(readFileSync(join(app.getAppPath(), "smoke-config.json"), "utf8")) as {
  linuxHome: string;
  distro: string;
  conversationId: string;
  otherId: string;
  workspace: string;
  output: string;
  realHarnesses?: string[];
  realHandoff?: boolean;
  newConversationOnly?: boolean;
  imagesOnly?: boolean;
};
mkdirSync(join(config.output, "electron-user-data"), { recursive: true });
app.setPath("userData", join(config.output, "electron-user-data"));
const bridge = new WslBridge((args) =>
  runWsl(
    args[0] === "--list"
      ? args
      : [
          ...args.slice(0, 5),
          "/usr/bin/env",
          `HOME=${config.linuxHome}`,
          "PATH=/usr/bin:/bin",
          ...args.slice(5),
        ],
  ),
);
app.on("window-all-closed", () => {});
const evidence: Record<string, unknown> = {
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  checks: [],
};
const checks = evidence.checks as string[];
const pushCheck = checks.push.bind(checks);
checks.push = (...values: string[]) => {
  console.log(values.join("\n"));
  return pushCheck(...values);
};
let win: BrowserWindow | undefined;
const deadline = setTimeout(
  () => {
    writeFileSync(
      join(config.output, "evidence.json"),
      JSON.stringify(
        { ...evidence, passed: false, error: "Windows smoke deadline exceeded" },
        null,
        2,
      ),
    );
    app.exit(1);
  },
  config.realHandoff ? 1200000 : config.realHarnesses?.length ? 780000 : 180000,
);
const waitFor = async (check: () => unknown | Promise<unknown>) => {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Windows smoke state timeout");
};
const click = async (window: BrowserWindow, selector: string) => {
  await waitFor(() =>
    window.webContents.executeJavaScript(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); const modal = document.querySelector('dialog[open]'); return e && !e.disabled && e.getBoundingClientRect().height > 0 && (!modal || modal.contains(e)); })()`,
    ),
  );
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center', behavior:'instant'})`,
  );
  await window.webContents.executeJavaScript(
    "Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise((_, reject) => setTimeout(() => reject(new Error('Compositor frames unavailable')), 8000))])",
  );
  // Invoke the actual DOM control once. Physical pointer resize is tested separately;
  // click coordinates can race Windows compositor/layout after async panel updates.
  await window.webContents.executeJavaScript(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.click(); })()`,
  );
  await window.webContents.executeJavaScript(
    "Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise((_, reject) => setTimeout(() => reject(new Error('Compositor frames unavailable')), 8000))])",
  );
};

const fill = async (window: BrowserWindow, text: string) => {
  await waitFor(() =>
    window.webContents.executeJavaScript(
      "!!document.querySelector('textarea') && !document.querySelector('textarea').readOnly && !document.querySelector('textarea').disabled",
    ),
  );
  await click(window, 'textarea[aria-label="消息输入"]');
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
  window.webContents.insertText(text);
  await waitFor(() =>
    window.webContents.executeJavaScript(
      `document.querySelector('textarea').value === ${JSON.stringify(text)}`,
    ),
  );
};
const press = (window: BrowserWindow, keyCode: string, modifiers: ("shift" | "control")[] = []) => {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  if (keyCode === "Enter")
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
};

void app.whenReady().then(async () => {
  try {
    assert.equal(process.platform, "win32");
    const rows = await bridge.discover();
    assert.ok(rows.some((row) => row.name === config.distro && row.version === 2));
    checks.push("Real Windows wsl.exe UTF-16 discovery");
    const opened = await openDesktopWindow(bridge);
    win = opened.window;
    const first = win;
    first.webContents.setBackgroundThrottling(false);
    await waitFor(() =>
      first.webContents.executeJavaScript("!!document.querySelector('.welcome')"),
    );
    await first.webContents.executeJavaScript(
      `window.harnessHub.request({ type: 'connect', distribution: ${JSON.stringify(config.distro)} })`,
    );
    await waitFor(() => opened.connection.getState().status === "connected");
    checks.push(
      "Sandboxed Electron window, real WSL bootstrap auto-start and Windows localhost HTTP/WS",
    );
    await waitFor(() =>
      first.webContents.executeJavaScript(
        "document.querySelectorAll('.conversation-item').length === 2",
      ),
    );
    const index =
      opened.connection
        .getState()
        .snapshot?.conversations.findIndex((c) => c.id === config.conversationId) ?? 0;
    await click(first, `.conversation-row:nth-child(${index + 1}) .conversation-item`);
    await waitFor(
      () =>
        opened.connection.getState().conversationId === config.conversationId &&
        !opened.connection.getState().historyLoading,
    );
    await waitFor(() =>
      first.webContents.executeJavaScript(
        "document.querySelector('.history').textContent.includes('Desktop smoke')",
      ),
    );
    const state = opened.connection.getState();
    assert.equal(
      state.snapshot?.conversations.find((c) => c.id === config.conversationId)?.workspacePath,
      config.workspace,
    );
    if (config.imagesOnly) {
      checks.push(...(await imageSmoke(first, opened.connection, config.output)));
      evidence.passed = true;
      return;
    }
    if (config.newConversationOnly) {
      checks.push(
        ...(await newConversationSmoke(first, opened.connection, config.output, {
          click,
          fill,
          waitFor,
        })),
      );
      evidence.passed = true;
      return;
    }
    const instance = await bridge.connect(config.distro);
    const client = new Client(instance);
    assert.ok(!JSON.stringify(state).includes(instance.token));
    const boundary = await first.webContents.executeJavaScript(
      "({ node: typeof require, process: typeof process, api: Object.keys(window.harnessHub), injected: window.hhuInjected === true })",
    );
    assert.equal(boundary.node, "undefined");
    assert.equal(boundary.process, "undefined");
    assert.equal(boundary.injected, false);
    assert.deepEqual(boundary.api.sort(), ["request", "subscribe"]);
    assert.equal(
      (
        await first.webContents.executeJavaScript(
          "window.harnessHub.request({type:'request',path:'/v1/daemon/stop'})",
        )
      ).ok,
      false,
    );
    assert.equal(
      await first.webContents.executeJavaScript(
        "fetch('http://127.0.0.1:1234').then(() => false, () => true)",
      ),
      true,
    );
    checks.push(
      "Real Chromium conversation controls, Linux cwd preserved, HTML inert, renderer Node/token/HTTP denied",
    );
    await click(first, ".project-toggle");
    await waitFor(() =>
      first.webContents.executeJavaScript(
        "document.querySelectorAll('.conversation-item').length === 0",
      ),
    );
    await click(first, ".project-toggle");
    await waitFor(() =>
      first.webContents.executeJavaScript(
        "document.querySelectorAll('.conversation-item').length === 2",
      ),
    );
    checks.push("Project expand/collapse");
    const otherIndex =
      opened.connection
        .getState()
        .snapshot?.conversations.findIndex((c) => c.id === config.otherId) ?? 0;
    await click(first, `.conversation-row:nth-child(${otherIndex + 1}) .conversation-item`);
    await waitFor(
      () =>
        opened.connection.getState().conversationId === config.otherId &&
        !opened.connection.getState().historyLoading,
    );
    await waitFor(() =>
      first.webContents.executeJavaScript("!!document.querySelector('.empty-chat')"),
    );
    await click(first, `.conversation-row:nth-child(${index + 1}) .conversation-item`);
    await waitFor(
      () =>
        opened.connection.getState().conversationId === config.conversationId &&
        !opened.connection.getState().historyLoading,
    );
    checks.push("Empty conversation switching");
    await click(first, '[aria-label="应用设置"]');
    await waitFor(() =>
      first.webContents.executeJavaScript(
        "!!document.querySelector('.app-settings[open] .environment')",
      ),
    );
    assert.ok(
      await first.webContents.executeJavaScript(
        "!!document.querySelector('.sidebar') && !document.querySelector('[aria-label=隐藏侧边栏]')",
      ),
    );
    await click(first, '[aria-label="关闭应用设置"]');
    checks.push("Top-left application settings preserve the permanent sidebar");
    await first.webContents.executeJavaScript(
      "window.pointerTrace = []; for (const t of ['pointerdown','pointermove','pointerup']) document.querySelector('.resize-handle').addEventListener(t,e => window.pointerTrace.push({type:t,x:e.clientX, capture:e.target.hasPointerCapture(e.pointerId)}))",
    );
    const divider = await first.webContents.executeJavaScript(
      "(() => { const r = document.querySelector('.resize-handle').getBoundingClientRect(); return { x: Math.round(r.x + 2), y: Math.round(r.y + 150) }; })()",
    );
    first.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      ...divider,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    first.webContents.sendInputEvent({
      type: "mouseMove",
      modifiers: ["leftbuttondown"],
      x: divider.x + 40,
      y: divider.y,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    first.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      x: divider.x + 40,
      y: divider.y,
    });
    await waitFor(() =>
      first.webContents.executeJavaScript(
        "document.querySelector('.sidebar').getBoundingClientRect().width > 280",
      ),
    );
    checks.push("Empty conversation switching, application settings and mouse resize");

    writeFileSync(join(config.output, "start-tui"), "start");
    await waitFor(() => existsSync(join(config.output, "tui-ready")));
    checks.push("Real WSL hhu TUI running concurrently in a PTY against the same Daemon");
    await fill(first, "跨会话持久草稿");
    await click(first, `.conversation-row:nth-child(${otherIndex + 1}) .conversation-item`);
    await waitFor(() => opened.connection.getState().conversationId === config.otherId);
    await click(first, `.conversation-row:nth-child(${index + 1}) .conversation-item`);
    await waitFor(() =>
      first.webContents.executeJavaScript(
        "document.querySelector('textarea')?.value === '跨会话持久草稿'",
      ),
    );
    checks.push("Native Windows editor and SQLite per-conversation draft restore");
    await fill(first, "timed");
    // Composition Enter is dispatched on the real Chromium textarea, with isComposing.
    await first.webContents.executeJavaScript(
      "document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', keyCode:229, isComposing:true, bubbles:true}))",
    );
    assert.equal(
      (await client.request<{ text: string }>(`/v1/conversations/${config.conversationId}/draft`))
        .text,
      "timed",
    );
    await click(first, '[aria-label="发送"]');
    await waitFor(
      () =>
        opened.connection
          .getState()
          .snapshot?.conversations.find((c) => c.id === config.conversationId)?.runtimeStatus ===
        "RUNNING",
    );
    await first.webContents.executeJavaScript(
      "document.querySelector('.history').scrollTop = 0; document.querySelector('.history').dispatchEvent(new Event('scroll'))",
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(
      await first.webContents.executeJavaScript("document.querySelector('.history').scrollTop"),
      0,
    );
    await waitFor(
      () =>
        opened.connection
          .getState()
          .snapshot?.conversations.find((c) => c.id === config.conversationId)?.runtimeStatus ===
        "IDLE",
    );
    await waitFor(() =>
      first.webContents.executeJavaScript(
        "document.querySelector('.history').textContent.includes('native-34')",
      ),
    );
    checks.push(
      "IME confirmation does not send, real timed streaming, manual scrolling suspends follow",
    );
    await fill(first, "多行");
    press(first, "End");
    press(first, "Enter", ["shift"]);
    await waitFor(() =>
      first.webContents.executeJavaScript(
        "document.querySelector('textarea').value.includes(String.fromCharCode(10))",
      ),
    );
    await fill(first, "/");
    await waitFor(() =>
      first.webContents.executeJavaScript("!!document.querySelector('.slash-menu')"),
    );
    press(first, "Enter");
    await waitFor(() =>
      first.webContents.executeJavaScript(
        "document.querySelector('textarea').value.startsWith('/silent ')",
      ),
    );
    const beforeSlash = (
      await client.request<{ events: { kind: string }[] }>(
        `/v1/conversations/${config.conversationId}/events?limit=1000`,
      )
    ).events.filter((e) => e.kind === "user.message").length;
    press(first, "Enter");
    await waitFor(
      async () =>
        (
          await client.request<{ events: { kind: string }[] }>(
            `/v1/conversations/${config.conversationId}/events?limit=1000`,
          )
        ).events.filter((e) => e.kind === "user.message").length ===
        beforeSlash + 1,
    );
    await waitFor(
      () =>
        opened.connection
          .getState()
          .snapshot?.conversations.find((c) => c.id === config.conversationId)?.runtimeStatus ===
        "IDLE",
    );
    checks.push(
      "Windows Shift+Enter newline and native ACP Slash Enter completes before explicit second Enter sends",
    );
    await waitFor(async () => {
      const page = await client.request<{ events: { kind: string; turnId: string }[] }>(
        `/v1/conversations/${config.conversationId}/events?limit=1000`,
      );
      const last = page.events.filter((e) => e.kind === "user.message").at(-1);
      return (
        last &&
        (await client.request<{ endedAt: number | null }>(`/v1/turns/${last.turnId}`)).endedAt
      );
    });
    await waitFor(() =>
      first.webContents.executeJavaScript("!document.querySelector('textarea').readOnly"),
    );
    await fill(first, "permission");
    await click(first, '[aria-label="发送"]');
    await waitFor(() =>
      first.webContents.executeJavaScript("!!document.querySelector('.approval')"),
    );
    await click(first, '.approval button[title="native-reject"]');
    await waitFor(() =>
      first.webContents.executeJavaScript("!document.querySelector('.approval')"),
    );
    checks.push("Native approval UI displays actual options and explicit reject resolves once");
    await fill(first, "关闭后保留草稿");
    await click(first, '[aria-label="切换工作面板"]');
    await waitFor(() =>
      first.webContents.executeJavaScript("!!document.querySelector('.work-panel')"),
    );
    await first.webContents.executeJavaScript("document.querySelector('.history').scrollTop = 0");
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(
      join(config.output, "desktop-wide.png"),
      (await first.webContents.capturePage()).toPNG(),
    );
    first.setSize(860, 640);
    first.webContents.setZoomFactor(1.1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await first.webContents.executeJavaScript(
        "document.documentElement.scrollWidth <= innerWidth",
      ),
      true,
    );
    writeFileSync(
      join(config.output, "desktop-narrow.png"),
      (await first.webContents.capturePage()).toPNG(),
    );
    checks.push(
      "Project expand/collapse, details panel, resize/110% zoom without horizontal overflow",
    );
    first.webContents.setZoomFactor(1);
    first.setSize(1280, 860);
    const active = await client.request<{ id: string }>(
      `/v1/conversations/${config.conversationId}/turns`,
      "POST",
      { requestId: crypto.randomUUID(), harnessId: "desktop-smoke", message: "wait" },
    );
    first.close();
    await waitFor(() => first.isDestroyed());
    await client.health();
    assert.equal((await bridge.connect(config.distro)).instanceId, instance.instanceId);
    checks.push("Closing the real Windows window preserves Daemon and active Mock ACP Worker");
    const reopened = await openDesktopWindow(bridge);
    win = reopened.window;
    win.webContents.setBackgroundThrottling(false);
    await waitFor(
      () =>
        reopened.connection.getState().status === "connected" &&
        reopened.connection.getState().conversationId === config.conversationId &&
        !reopened.connection.getState().historyLoading,
    );
    checks.push("Reopened Electron restores WSL distro and SQLite conversation selection");
    await client.request(`/v1/turns/${active.id}/cancel`, "POST");
    await waitFor(async () =>
      ["CANCELLED", "COMPLETED"].includes(
        (await client.request<{ state: string }>(`/v1/turns/${active.id}`)).state,
      ),
    );
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "document.querySelector('textarea')?.value === '关闭后保留草稿'",
      ),
    );
    checks.push("Closing/reopening Electron persists SQLite drafts while active Agent survives");
    // New-conversation landing page sends the first message without a title dialog.
    await click(reopened.window, '.project-heading button[aria-label="新建会话"]');
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "!!document.querySelector('.new-conversation')",
      ),
    );
    assert.equal(
      await reopened.window.webContents.executeJavaScript("!!document.querySelector('dialog')"),
      false,
    );
    await reopened.window.webContents.executeJavaScript(
      "(() => { const h = document.querySelector('select[aria-label=Harness]'); h.value = 'desktop-smoke'; h.dispatchEvent(new Event('change', {bubbles:true})); })()",
    );
    await fill(reopened.window, "Desktop 自动命名任务");
    await click(reopened.window, '[aria-label="发送消息"]');
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "!document.querySelector('.new-conversation') && document.querySelector('h1').textContent === 'Desktop 自动命名任务'",
      ),
    );
    checks.push("New page creates and auto-names on first send without requesting a title");
    await click(reopened.window, '[aria-label="切换工作面板"]');
    await click(reopened.window, ".panel-content details > summary");
    await click(reopened.window, ".management-actions button:first-child");
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript("!!document.querySelector('dialog[open]')"),
    );
    await click(reopened.window, 'input[aria-label="会话名称"]');
    press(reopened.window, "A", ["control"]);
    reopened.window.webContents.insertText("Managed Desktop conversation");
    await click(reopened.window, 'dialog button[type="submit"]');
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "document.querySelector('h1').textContent === 'Managed Desktop conversation'",
      ),
    );
    await click(reopened.window, ".management-actions button:nth-child(2)");
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "document.querySelector('.management-actions').textContent.includes('恢复归档')",
      ),
    );
    await click(reopened.window, ".management-actions button:nth-child(2)");
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "!document.querySelector('.management-actions').textContent.includes('恢复归档')",
      ),
    );
    await click(reopened.window, ".management-actions button:last-child");
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript("!!document.querySelector('dialog[open]')"),
    );
    await click(reopened.window, 'dialog button[type="submit"]');
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "!document.querySelector('dialog') && !!document.querySelector('.welcome')",
      ),
    );
    assert.equal(
      await reopened.window.webContents.executeJavaScript(
        "!!document.querySelector('.work-panel')",
      ),
      false,
    );
    checks.push(
      "Windows create/rename/archive/restore/delete dialogs and explicit delete confirmation",
    );
    const large = (await reopened.connection.action({
      type: "conversation.standalone",
      workspacePath: config.workspace,
      title: "Long tool history",
    })) as { id: string };
    await reopened.connection.select(large.id);
    await reopened.connection.action({
      type: "harness.select",
      conversationId: large.id,
      harnessId: "desktop-smoke",
    });
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "document.querySelector('h1').textContent === 'Long tool history'",
      ),
    );
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "document.querySelector('select[aria-label=\"Harness\"]')?.value === 'desktop-smoke'",
      ),
    );
    await fill(reopened.window, "desktop-many-tools");
    await click(reopened.window, '[aria-label="发送"]');
    await waitFor(
      () =>
        reopened.connection.getState().eventCursor !== undefined &&
        (reopened.connection.getState().eventCursor ?? 0) > 1200 &&
        reopened.connection.getState().snapshot?.conversations.find((c) => c.id === large.id)
          ?.runtimeStatus === "IDLE",
    );
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "document.querySelector('.history').textContent.includes('Desktop tools complete')",
      ),
    );
    assert.ok(
      await reopened.window.webContents.executeJavaScript(
        "document.querySelectorAll('.message').length <= 100",
      ),
    );
    await reopened.window.webContents.executeJavaScript(
      "document.querySelector('.history').scrollTop = 0",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await click(reopened.window, ".transcript > button");
    await waitFor(() =>
      reopened.window.webContents.executeJavaScript(
        "!document.querySelector('.history').textContent.includes('Desktop tools complete')",
      ),
    );
    assert.ok(
      await reopened.window.webContents.executeJavaScript(
        "document.querySelectorAll('.message').length <= 100",
      ),
    );
    checks.push(
      "600 native tools / 1200 updates: bounded DOM mounts, history paging, full SQLite events retained",
    );
    reopened.window.show();
    reopened.window.focus();
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(
      join(config.output, "desktop-tools.png"),
      (await reopened.window.webContents.capturePage()).toPNG(),
    );
    checks.push(
      ...(await workspaceSmoke(reopened.window, reopened.connection, client, config.output, {
        click,
        fill,
        waitFor,
      })),
    );
    for (const scale of [1.25, 1.5, 2]) {
      reopened.window.webContents.setZoomFactor(scale);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        await reopened.window.webContents.executeJavaScript(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
        true,
      );
    }
    reopened.window.webContents.setZoomFactor(1);
    reopened.window.minimize();
    await waitFor(() => reopened.window.isMinimized());
    reopened.window.restore();
    reopened.window.maximize();
    await waitFor(() => reopened.window.isMaximized());
    reopened.window.unmaximize();
    reopened.window.setFullScreen(true);
    await waitFor(() => reopened.window.isFullScreen());
    reopened.window.setFullScreen(false);
    checks.push(
      "125/150/200 percent Chromium zoom layout; minimize/restore/maximize/fullscreen (not physical monitor DPI)",
    );
    if (config.realHandoff)
      evidence.realHandoff = await realHandoffSmoke(
        reopened.window,
        client,
        config.workspace,
        config.output,
        { click, fill, waitFor },
      );
    if (config.realHarnesses?.length) {
      const results: Record<string, unknown>[] = [];
      evidence.realHarnesses = results;
      for (const harnessId of config.realHarnesses) {
        const result: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
        results.push(result);
        try {
          const created = await reopened.window.webContents.executeJavaScript(
            `window.harnessHub.request({type:'conversation.standalone',workspacePath:${JSON.stringify(config.workspace)},title:${JSON.stringify("Real ")}+${JSON.stringify(harnessId)}})`,
          );
          assert.equal(created.ok, true);
          const id = created.data.id;
          result.conversationId = id;
          await reopened.window.webContents.executeJavaScript(
            `window.harnessHub.request({type:'select',conversationId:${JSON.stringify(id)}})`,
          );
          await reopened.window.webContents.executeJavaScript(
            `window.harnessHub.request({type:'harness.select',conversationId:${JSON.stringify(id)},harnessId:${JSON.stringify(harnessId)}})`,
          );
          await waitFor(() =>
            reopened.window.webContents.executeJavaScript(
              `document.querySelector('select[aria-label="Harness"]')?.value === ${JSON.stringify(harnessId)} && !document.querySelector('textarea').disabled`,
            ),
          );
          await fill(
            reopened.window,
            `In this temporary Git test directory only, use native tools to read sentinel.txt, then create a NEW file phase3-${harnessId}.txt containing exactly HARNESSHUB_PHASE3_${harnessId}_TOOL_WRITE followed by a newline. Do not change other files or directories, use network, or spawn subagents. Respect native permissions; do not work around an approval request. Report the file path and result.`,
          );
          await click(reopened.window, '[aria-label="发送"]');
          let turn:
            | {
                id: string;
                state: string;
                endedAt: number | null;
                requestId: string;
                stopReason: string | null;
              }
            | undefined;
          const end = Date.now() + 145000;
          while (Date.now() < end) {
            const page = await client.request<{
              events: { kind: string; turnId: string; payload: unknown }[];
            }>(`/v1/conversations/${id}/events?limit=1000`);
            const user = page.events.find((e) => e.kind === "user.message");
            if (user) turn = await client.request(`/v1/turns/${user.turnId}`);
            const approvals = await client.request<unknown[]>(`/v1/conversations/${id}/approvals`);
            if (turn?.endedAt || approvals.length) {
              result.manualApprovalRequired = approvals.length > 0;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          result.turn = turn;
          result.timedOut = !turn?.endedAt && !result.manualApprovalRequired;
          if (turn && !turn.endedAt && turn.state !== "UNCERTAIN") {
            result.cancel = await reopened.window.webContents.executeJavaScript(
              `window.harnessHub.request({type:'turn.cancel',conversationId:${JSON.stringify(id)},turnId:${JSON.stringify(turn.id)}})`,
            );
          }
          const page = await client.request<{ events: { kind: string; payload: unknown }[] }>(
            `/v1/conversations/${id}/events?limit=1000`,
          );
          result.messageChunks = page.events.filter((e) => e.kind === "agent_message_chunk").length;
          result.toolCalls = page.events.filter((e) => e.kind === "tool_call").length;
          result.failures = page.events.filter(
            (e) =>
              /error|failed|worker_lost/.test(e.kind) ||
              (e.kind === "agent_message_chunk" &&
                /invalid_prompt|unexpected status|Bad Gateway/.test(JSON.stringify(e.payload))),
          );
          const changes = (await reopened.connection.action({
            type: "changes.list",
            conversationId: id,
          })) as { files: { path: string }[]; workspace: string };
          result.gitChanges = changes;
          const changed = changes.files.some((f) => f.path === `phase3-${harnessId}.txt`);
          if (changed) {
            result.gitDiff = await reopened.connection.action({
              type: "changes.diff",
              conversationId: id,
              path: `phase3-${harnessId}.txt`,
            });
            if (
              !(await reopened.window.webContents.executeJavaScript(
                "!!document.querySelector('.work-panel')",
              ))
            )
              await click(reopened.window, '[aria-label="切换工作面板"]');
            await reopened.window.webContents.executeJavaScript(
              "Array.from(document.querySelectorAll('.work-panel > header button')).find(b => b.textContent === 'Changes').click()",
            );
            await waitFor(() =>
              reopened.window.webContents.executeJavaScript(
                `document.querySelector('.changes').textContent.includes(${JSON.stringify(`phase3-${harnessId}.txt`)})`,
              ),
            );
            result.changesVisible = true;
          }
          result.passed =
            changed &&
            result.changesVisible === true &&
            turn?.state === "COMPLETED" &&
            Number(result.messageChunks) > 0 &&
            Number(result.toolCalls) > 0 &&
            (result.failures as unknown[]).length === 0;
          writeFileSync(
            join(config.output, `real-${harnessId}-events.json`),
            JSON.stringify(page, null, 2),
          );
          await waitFor(() =>
            reopened.window.webContents.executeJavaScript(
              `document.querySelector('h1').textContent === ${JSON.stringify("Real ")}+${JSON.stringify(harnessId)}`,
            ),
          );
          result.renderer = await reopened.window.webContents.executeJavaScript(
            "({title:document.querySelector('h1').textContent,tools:document.querySelectorAll('.tool-card').length,body:document.querySelector('.history').textContent})",
          );
          reopened.window.show();
          reopened.window.focus();
          await new Promise((resolve) => setTimeout(resolve, 300));
          writeFileSync(
            join(config.output, `real-${harnessId}.png`),
            (await reopened.window.webContents.capturePage()).toPNG(),
          );
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
          result.passed = false;
        }
        writeFileSync(
          join(config.output, "real-harness-evidence.json"),
          JSON.stringify(results, null, 2),
        );
      }
    }
    win.close();
    await waitFor(() => reopened.window.isDestroyed());
    await client.health();
    evidence.passed = true;
  } catch (error) {
    if (win && !win.isDestroyed()) {
      writeFileSync(
        join(config.output, "failure.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      evidence.dom = await win.webContents.executeJavaScript(
        "({ sidebar: document.querySelector('.sidebar')?.getBoundingClientRect().width, selected: document.querySelector('.selected')?.textContent, text: document.querySelector('textarea')?.value, body: document.body.innerText.slice(-1800), pointerTrace: window.pointerTrace, divider: document.querySelector('.resize-handle')?.getBoundingClientRect().toJSON() })",
      );
    }
    evidence.passed = false;
    evidence.error = error instanceof Error ? error.message : "Windows smoke failed";
    evidence.stack = error instanceof Error ? error.stack : undefined;
  } finally {
    win?.destroy();
    clearTimeout(deadline);
    writeFileSync(join(config.output, "evidence.json"), JSON.stringify(evidence, null, 2));
    app.exit(evidence.passed ? 0 : 1);
  }
});
