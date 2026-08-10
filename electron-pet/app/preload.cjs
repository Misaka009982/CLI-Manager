"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cliManagerPet", {
  onState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop-pet-state", listener);
    return () => ipcRenderer.removeListener("desktop-pet-state", listener);
  },
  onActionResult: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop-pet-action-result", listener);
    return () => ipcRenderer.removeListener("desktop-pet-action-result", listener);
  },
  sendAction: (action) => ipcRenderer.send("desktop-pet-action", action),
  patchUi: (patch) => ipcRenderer.send("desktop-pet-ui-patch", patch),
  previewSize: (size) => ipcRenderer.send("desktop-pet-size-preview", size),
  commitSize: (size) => ipcRenderer.send("desktop-pet-size-commit", size),
  reportShape: (rects) => ipcRenderer.send("desktop-pet-hit-shape", rects),
  dragStart: () => ipcRenderer.send("desktop-pet-drag-start"),
  dragMove: () => ipcRenderer.send("desktop-pet-drag-move"),
  dragEnd: (moved) => ipcRenderer.send("desktop-pet-drag-end", Boolean(moved)),
});
