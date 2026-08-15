import type {
  DesktopPetEActionResult,
  DesktopPetEChildAction,
  DesktopPetEConfigPayload,
  DesktopPetESnapshot,
} from "./bridge/protocol.js";

// sandbox preload 不能在运行时使用 ESM import/export；此文件必须编译为 CommonJS。
// 上面的导入全部是类型导入，会被 tsc 擦除；运行时值统一通过 polyfill require 获取。
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("desktopPetE", Object.freeze({
  ready: () => ipcRenderer.send("pet-e:renderer-ready"),
  setMouseInteractive: (interactive: boolean) => ipcRenderer.send("pet-e:mouse-interactive", interactive),
  sendAction: (action: DesktopPetEChildAction) => ipcRenderer.send("pet-e:action", action),
  onConfig: (listener: (payload: DesktopPetEConfigPayload) => void) => subscribe("pet-e:config", listener),
  onSnapshot: (listener: (payload: DesktopPetESnapshot) => void) => subscribe("pet-e:snapshot", listener),
  onActionResult: (listener: (payload: DesktopPetEActionResult) => void) => subscribe("pet-e:action-result", listener),
}));
