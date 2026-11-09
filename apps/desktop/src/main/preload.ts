import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopState } from "../contracts";

// Sandbox preload is a single CJS bundle; do not expose ipcRenderer or event objects.
const api: DesktopApi = {
  request: (request) => ipcRenderer.invoke("hhu:desktop:request", request),
  subscribe: (callback) => {
    const listener = (_event: unknown, state: DesktopState) => callback(state);
    ipcRenderer.on("hhu:desktop:state", listener);
    return () => ipcRenderer.removeListener("hhu:desktop:state", listener);
  },
};
contextBridge.exposeInMainWorld("harnessHub", Object.freeze(api));
