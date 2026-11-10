import { contextBridge, ipcRenderer } from "electron";

import {
  SETUP_IPC,
  type SetupState,
  type LingerSetupApi,
} from "../shared/setup.js";

// Sandboxed preload for the local setup page only.
const api: LingerSetupApi = {
  getState: () => ipcRenderer.invoke(SETUP_IPC.state),
  onState: (callback) => {
    const listener = (_event: unknown, state: SetupState): void =>
      callback(state);
    ipcRenderer.on(SETUP_IPC.stateEvent, listener);
    return () => ipcRenderer.off(SETUP_IPC.stateEvent, listener);
  },
  run: (command) => ipcRenderer.invoke(SETUP_IPC.run, command),
};

contextBridge.exposeInMainWorld("lingerSetup", api);
