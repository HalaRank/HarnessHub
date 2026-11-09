import { app, type BrowserWindow } from "electron";
import type { DesktopConnection } from "./connection";
import { openDesktopWindow } from "./window";

app.setName("HarnessHub");
if (process.platform === "win32") app.setAppUserModelId("org.harnesshub.desktop");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | undefined;
  let connection: DesktopConnection | undefined;
  app.on("second-instance", () => {
    window?.restore();
    window?.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => connection?.dispose());
  void app.whenReady().then(async () => {
    ({ window, connection } = await openDesktopWindow());
  });
}
