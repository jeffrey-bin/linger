import { contextBridge, ipcRenderer } from "electron";

import {
  IPC,
  type ComputerStatus,
  type LingerDesktopApi,
} from "../shared/api.js";

// Sandboxed preload: exposes only window.lingerDesktop, never ipcRenderer.
declare const __DESKTOP_VERSION__: string;

const api: LingerDesktopApi = {
  version: __DESKTOP_VERSION__,
  platform: process.platform as LingerDesktopApi["platform"],
  computer: {
    getStatus: () => ipcRenderer.invoke(IPC.computerStatus),
    onStatus: (callback) => {
      const listener = (_event: unknown, status: ComputerStatus): void =>
        callback(status);
      ipcRenderer.on(IPC.computerStatusEvent, listener);
      return () => {
        ipcRenderer.off(IPC.computerStatusEvent, listener);
      };
    },
    enroll: () => ipcRenderer.invoke(IPC.computerEnroll),
    unenroll: () => ipcRenderer.invoke(IPC.computerUnenroll),
  },
  workspace: {
    pick: () => ipcRenderer.invoke(IPC.workspacePick),
    list: () => ipcRenderer.invoke(IPC.workspaceList),
    revoke: (grantId) => ipcRenderer.invoke(IPC.workspaceRevoke, grantId),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  },
  localAccount: {
    available: () => ipcRenderer.invoke(IPC.localAccountAvailable),
    signIn: () => ipcRenderer.invoke(IPC.localAccountSignIn),
  },
  ...(process.platform === "darwin"
    ? {
        permissions: {
          act: (step) => ipcRenderer.invoke(IPC.permissionAct, step),
        },
      }
    : {}),
};

contextBridge.exposeInMainWorld("lingerDesktop", api);

// On macOS the page runs under the traffic lights with no title bar; pages
// style html[data-desktop-chrome="inset"] to leave room and a drag region.
if (process.platform === "darwin") {
  // The root element may not exist yet when the preload runs.
  const mark = (): void =>
    document.documentElement?.setAttribute("data-desktop-chrome", "inset");
  mark();
  document.addEventListener("DOMContentLoaded", mark, { once: true });
}
