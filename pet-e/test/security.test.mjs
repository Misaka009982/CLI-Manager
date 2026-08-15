import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Electron 窗口保持最小权限配置", () => {
  const main = read("../src/main.ts");
  const preload = read("../src/preload.cts");
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /webSecurity: true/);
  assert.match(main, /devTools: false/);
  assert.match(main, /setPermissionRequestHandler[\s\S]*callback\(false\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.match(preload, /function subscribe<T>/);
  assert.match(preload, /ipcRenderer\.on\(channel, handler\)/);
  assert.match(preload, /setMouseInteractive: \(interactive: boolean\)/);
  assert.match(main, /setIgnoreMouseEvents\(true, \{ forward: true \}\)/);
  assert.match(main, /typeof value !== "boolean"/);
});

test("自定义协议只服务固定 renderer 文件和当前精灵", () => {
  const main = read("../src/main.ts");
  const html = read("../src/renderer/index.html");
  assert.match(main, /STATIC_FILES = new Map/);
  assert.match(main, /task-state\.js/);
  assert.match(main, /agent-action\.js/);
  assert.match(main, /url\.pathname !== "\/current"/);
  assert.doesNotMatch(main, /TcpListener|UdpSocket|127\.0\.0\.1/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /unsafe-inline/);
});

test("父子 JSON Lines 边界和 renderer action 校验存在", () => {
  const main = read("../src/main.ts");
  const protocol = read("../src/bridge/protocol.ts");
  assert.match(main, /DESKTOP_PET_E_MAX_LINE_BYTES/);
  assert.match(main, /isDesktopPetEEnvelope/);
  assert.match(main, /isDesktopPetEChildAction/);
  assert.match(main, /event\.sender === windowRef\.webContents/);
  assert.match(protocol, /DESKTOP_PET_E_MAX_ACTION_ID_LENGTH/);
  assert.match(protocol, /DESKTOP_PET_E_MAX_ANSWERS/);
});
