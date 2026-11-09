// Explicit Windows integration harness, never bundled in the production app.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@harnesshub/shared/client";
import { app, type BrowserWindow } from "electron";
import { openDesktopWindow } from "../src/main/window";
import { runWsl, WslBridge } from "../src/main/wsl";

const config = JSON.parse(readFileSync(join(app.getAppPath(), "smoke-config.json"), "utf8")) as {
  linuxHome: string;
  distro: string;
  conversationId: string;
  otherId: string;
  workspace: string;
  output: string;
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
let win: BrowserWindow | undefined;
const deadline = setTimeout(() => {
  writeFileSync(
    join(config.output, "evidence.json"),
    JSON.stringify(
      { ...evidence, passed: false, error: "Windows smoke deadline exceeded" },
      null,
      2,
    ),
  );
  app.exit(1);
}, 90000);
const waitFor = async (check: () => unknown | Promise<unknown>) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Windows smoke state timeout");
};
const click = async (window: BrowserWindow, selector: string) => {
  const point = await window.webContents.executeJavaScript(
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Element missing'); const rect = element.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`,
  );
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
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
    await click(first, `.conversation-item:nth-child(${index + 1})`);
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
      "Real mouse conversation switching, Linux cwd preserved, HTML inert, renderer Node/token/HTTP denied",
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
    await click(first, `.conversation-item:nth-child(${otherIndex + 1})`);
    await waitFor(
      () =>
        opened.connection.getState().conversationId === config.otherId &&
        !opened.connection.getState().historyLoading,
    );
    await waitFor(() =>
      first.webContents.executeJavaScript("!!document.querySelector('.empty-chat')"),
    );
    await click(first, `.conversation-item:nth-child(${index + 1})`);
    await waitFor(
      () =>
        opened.connection.getState().conversationId === config.conversationId &&
        !opened.connection.getState().historyLoading,
    );
    checks.push("Empty conversation switching");
    await click(first, '[aria-label="隐藏侧边栏"]');
    await waitFor(() => first.webContents.executeJavaScript("!document.querySelector('.sidebar')"));
    await click(first, '[aria-label="显示侧边栏"]');
    await waitFor(() =>
      first.webContents.executeJavaScript("!!document.querySelector('.sidebar')"),
    );
    checks.push("Sidebar hide/restore");
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
    checks.push("Empty conversation switching, sidebar hide/restore and mouse resize");
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
      { requestId: crypto.randomUUID(), harnessId: "desktop-smoke", message: "slow" },
    );
    first.close();
    await client.health();
    assert.equal((await bridge.connect(config.distro)).instanceId, instance.instanceId);
    checks.push("Closing the real Windows window preserves Daemon and active Mock ACP Worker");
    const reopened = await openDesktopWindow(bridge);
    win = reopened.window;
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
    win.close();
    await client.health();
    evidence.passed = true;
  } catch (error) {
    if (win && !win.isDestroyed()) {
      writeFileSync(
        join(config.output, "failure.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      evidence.dom = await win.webContents.executeJavaScript(
        "({ sidebar: document.querySelector('.sidebar')?.getBoundingClientRect().width, selected: document.querySelector('.selected')?.textContent, pointerTrace: window.pointerTrace, divider: document.querySelector('.resize-handle')?.getBoundingClientRect().toJSON() })",
      );
    }
    evidence.passed = false;
    evidence.error = error instanceof Error ? error.message : "Windows smoke failed";
  } finally {
    win?.destroy();
    clearTimeout(deadline);
    writeFileSync(join(config.output, "evidence.json"), JSON.stringify(evidence, null, 2));
    app.exit(evidence.passed ? 0 : 1);
  }
});
