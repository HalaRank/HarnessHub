import { mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { app, type BrowserWindow } from "electron";
import type { DesktopConnection } from "./connection";
import { openDesktopWindow } from "./window";

app.setName("HarnessHub");
// Explicit per-client configuration override for portable use and isolated acceptance.
// It never changes WSL HOME/XDG, Agent credentials, or the business database.
const dataDirectory = process.argv
  .find((arg) => arg.startsWith("--client-data-dir="))
  ?.slice("--client-data-dir=".length);
if (dataDirectory) {
  if (!isAbsolute(dataDirectory))
    throw new Error("--client-data-dir requires an absolute Windows directory");
  mkdirSync(dataDirectory, { recursive: true });
  app.setPath("userData", dataDirectory);
}
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
  app.on("will-quit", () => connection?.dispose());
  void app.whenReady().then(async () => {
    ({ window, connection } = await openDesktopWindow());
  });
}
