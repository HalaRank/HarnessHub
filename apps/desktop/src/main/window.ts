import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, session } from "electron";
import { type DesktopReply, desktopRequest, IPC_REQUEST, IPC_STATE } from "../contracts";
import { DesktopConnection } from "./connection";
import { trustedSender, windowSecurity } from "./security";
import { loadDistribution, saveDistribution } from "./settings";
import { BridgeError, WslBridge } from "./wsl";

export async function openDesktopWindow(
  bridge = new WslBridge(),
  settingsPath = join(app.getPath("userData"), "desktop-settings.json"),
) {
  const controller = new DesktopConnection(bridge);
  const page = pathToFileURL(join(app.getAppPath(), "renderer/index.html")).href;
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (event) => event.preventDefault());
  const win = new BrowserWindow({
    title: "HarnessHub",
    icon: join(app.getAppPath(), "assets/icon.png"),
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: "#18191b",
    show: false,
    webPreferences: { ...windowSecurity, preload: join(app.getAppPath(), "main/preload.cjs") },
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "HarnessHub", submenu: [{ role: "quit" }] },
      { label: "Edit", submenu: [{ role: "copy" }, { role: "selectAll" }] },
      {
        label: "View",
        submenu: [
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "resetZoom" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  controller.onState((state) => {
    if (!win.isDestroyed() && win.webContents.getURL() === page)
      win.webContents.send(IPC_STATE, state);
  });
  let connectSequence = 0;
  ipcMain.handle(IPC_REQUEST, async (event, input: unknown): Promise<DesktopReply> => {
    if (
      !trustedSender(
        event,
        { contents: win.webContents, frame: win.webContents.mainFrame, url: page },
        event.senderFrame?.url,
      )
    )
      return { ok: false, error: "IPC 调用来源无效。" };
    const parsed = desktopRequest.safeParse(input);
    if (!parsed.success) return { ok: false, error: "不支持的 Desktop 操作或参数。" };
    try {
      const request = parsed.data;
      if (request.type === "discover")
        return { ok: true, state: controller.getState(), distributions: await bridge.discover() };
      if (request.type === "connect") {
        const sequence = ++connectSequence;
        const rows = await bridge.discover();
        if (!rows.some((row) => row.name === request.distribution && row.version === 2))
          throw new BridgeError("DISCOVERY", "请选择已安装的 WSL2 发行版。");
        if (sequence !== connectSequence || win.isDestroyed())
          return { ok: true, state: controller.getState() };
        saveDistribution(settingsPath, request.distribution);
        void controller.connect(request.distribution);
      }
      if (request.type === "reconnect" && controller.getState().distribution)
        void controller.connect(controller.getState().distribution as string);
      if (request.type === "select") await controller.select(request.conversationId);
      return { ok: true, state: controller.getState() };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof BridgeError
            ? error.message
            : "操作失败。请检查连接后重试；未发送 Agent 任务。",
      };
    }
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    controller.dispose();
    ipcMain.removeHandler(IPC_REQUEST);
  });
  await win.loadURL(page);
  const saved = loadDistribution(settingsPath);
  if (saved) void controller.connect(saved);
  return { window: win, connection: controller };
}
