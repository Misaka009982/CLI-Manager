import { app, BrowserWindow, ipcMain, protocol, screen, shell } from "electron";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DESKTOP_PET_E_MAX_ACTION_ID_LENGTH,
  DESKTOP_PET_E_MAX_LINE_BYTES,
  DESKTOP_PET_E_PROTOCOL_VERSION,
  isDesktopPetEChildAction,
  isDesktopPetEEnvelope,
  type DesktopPetEChildAction,
  type DesktopPetEChildMessage,
  type DesktopPetEConfigPayload,
  type DesktopPetEEnvelope,
  type DesktopPetEHostMessage,
  type DesktopPetESnapshot,
} from "./bridge/protocol.js";

const APP_SCHEME = "pet-e-app";
const ASSET_SCHEME = "pet-e-asset";
const BASE_WIDTH = 380;
const BASE_HEIGHT = 540;
const MAX_SPRITE_BYTES = 20 * 1024 * 1024;
const STATIC_FILES = new Map([
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/task-state.js", "task-state.js"],
  ["/agent-action.js", "agent-action.js"],
  ["/bridge/agent-action.js", "../bridge/agent-action.js"],
  ["/styles.css", "styles.css"],
]);

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`desktop_pet_e_argument_missing:${name}`);
  return value;
}

const instanceId = argument("--instance-id");
const generation = Number(argument("--generation"));
if (!Number.isSafeInteger(generation) || generation < 0) {
  throw new Error("desktop_pet_e_generation_invalid");
}

let childRevision = 0;
let hostRevision = 0;
let windowRef: BrowserWindow | null = null;
let latestConfig: DesktopPetEConfigPayload | null = null;
let latestSnapshot: DesktopPetESnapshot | null = null;
let spritePath: string | null = null;
let spriteRevision = 0;
let expectedExit = false;
let programmaticMoveTarget: { x: number; y: number } | null = null;
let programmaticMoveTimer: ReturnType<typeof setTimeout> | null = null;
let geometryConfigKey: string | null = null;
let movePublishTimer: ReturnType<typeof setTimeout> | null = null;
let hostMessageQueue = Promise.resolve();

function rememberProgrammaticMove(bounds: Electron.Rectangle): void {
  programmaticMoveTarget = { x: bounds.x, y: bounds.y };
  if (programmaticMoveTimer !== null) clearTimeout(programmaticMoveTimer);
  programmaticMoveTimer = setTimeout(() => {
    programmaticMoveTarget = null;
    programmaticMoveTimer = null;
  }, 1000);
}

function isProgrammaticMove(x: number, y: number): boolean {
  if (!programmaticMoveTarget) return false;
  return Math.abs(programmaticMoveTarget.x - x) <= 2
    && Math.abs(programmaticMoveTarget.y - y) <= 2;
}

function clearProgrammaticMoveTarget(): void {
  programmaticMoveTarget = null;
  if (programmaticMoveTimer !== null) {
    clearTimeout(programmaticMoveTimer);
    programmaticMoveTimer = null;
  }
}

function writeMessage<T extends DesktopPetEChildMessage["type"]>(
  type: T,
  payload: Extract<DesktopPetEChildMessage, { type: T }>["payload"],
): void {
  childRevision += 1;
  const message = {
    protocolVersion: DESKTOP_PET_E_PROTOCOL_VERSION,
    instanceId,
    generation,
    revision: childRevision,
    type,
    payload,
  } satisfies DesktopPetEEnvelope<T, typeof payload>;
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, "utf8") > DESKTOP_PET_E_MAX_LINE_BYTES) {
    if (type !== "diagnostic") diagnostic("desktop_pet_e_child_line_too_large", "Child message exceeded 1 MiB");
    return;
  }
  process.stdout.write(`${line}\n`);
}

function diagnostic(code: string, detail: string): void {
  writeMessage("diagnostic", {
    code,
    message: code,
    detail,
    occurredAt: Date.now(),
  });
}

function failCompanion(code: string, detail: string): void {
  if (expectedExit) return;
  expectedExit = true;
  diagnostic(code, detail);
  app.exit(1);
}

function rendererConfig(config: DesktopPetEConfigPayload): DesktopPetEConfigPayload {
  return {
    ...config,
    pet: config.pet
      ? { ...config.pet, spritePath: `${ASSET_SCHEME}://sprite/current?v=${spriteRevision}` }
      : null,
  };
}

async function acceptSpritePath(config: DesktopPetEConfigPayload): Promise<void> {
  const candidate = config.pet?.spritePath ?? null;
  if (!candidate) {
    if (spritePath !== null) spriteRevision += 1;
    spritePath = null;
    return;
  }
  const resolved = path.resolve(candidate);
  if (path.extname(resolved).toLowerCase() !== ".webp") {
    throw new Error("desktop_pet_e_sprite_type_invalid");
  }
  const metadata = await stat(resolved);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_SPRITE_BYTES) {
    throw new Error("desktop_pet_e_sprite_size_invalid");
  }
  if (spritePath !== resolved) spriteRevision += 1;
  spritePath = resolved;
}

function scaleForWorkArea(sizePercent: number, area: Electron.Rectangle): number {
  const requestedScale = Math.min(2, Math.max(0.5, sizePercent / 100));
  return Math.max(0.1, Math.min(requestedScale, area.width / BASE_WIDTH, area.height / BASE_HEIGHT));
}

function windowBounds(config: DesktopPetEConfigPayload): { bounds: Electron.Rectangle; scale: number } {
  const preferred = config.settings.position;
  const display = preferred
    ? screen.getDisplayNearestPoint(preferred)
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const scale = scaleForWorkArea(config.settings.size, area);
  const width = Math.min(area.width, Math.round(BASE_WIDTH * scale));
  const height = Math.min(area.height, Math.round(BASE_HEIGHT * scale));
  const x = preferred
    ? Math.min(area.x + area.width - width, Math.max(area.x, Math.round(preferred.x)))
    : Math.max(area.x, area.x + area.width - width - 24);
  const y = preferred
    ? Math.min(area.y + area.height - height, Math.max(area.y, Math.round(preferred.y)))
    : Math.max(area.y, area.y + area.height - height - 24);
  return { bounds: { x, y, width, height }, scale };
}

function geometryKey(config: DesktopPetEConfigPayload): string {
  const position = config.settings.position;
  return JSON.stringify({
    size: config.settings.size,
    x: position?.x ?? null,
    y: position?.y ?? null,
  });
}

function setWindowMouseInteractive(interactive: boolean): void {
  const win = windowRef;
  if (!win || win.isDestroyed()) return;
  if (interactive) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
}

function applyConfig(config: DesktopPetEConfigPayload): void {
  const win = windowRef;
  if (!win || win.isDestroyed()) return;
  const { bounds, scale } = windowBounds(config);
  const nextGeometryKey = geometryKey(config);
  if (geometryConfigKey !== nextGeometryKey) {
    geometryConfigKey = nextGeometryKey;
    const current = win.getBounds();
    if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) {
      rememberProgrammaticMove(bounds);
      win.setBounds(bounds, false);
    }
  }
  win.webContents.setZoomFactor(scale);
  win.setAlwaysOnTop(config.settings.alwaysOnTop, "floating");
  win.setMovable(!config.settings.lockPosition);
  if (config.visible) win.showInactive();
  else {
    setWindowMouseInteractive(false);
    win.hide();
  }
  win.webContents.send("pet-e:config", rendererConfig(config));
}

function isTrustedSender(event: Electron.IpcMainEvent): boolean {
  return Boolean(windowRef && !windowRef.isDestroyed() && event.sender === windowRef.webContents);
}

function sendAction(action: DesktopPetEChildAction): void {
  writeMessage("action", action);
}

async function handleHostMessage(message: DesktopPetEHostMessage): Promise<void> {
  if (message.type === "shutdown") {
    expectedExit = true;
    app.quit();
    return;
  }
  if (message.type === "config") {
    try {
      await acceptSpritePath(message.payload);
      latestConfig = message.payload;
      applyConfig(message.payload);
    } catch (error) {
      if (spritePath !== null) spriteRevision += 1;
      spritePath = null;
      const rejectedConfig = { ...message.payload, pet: null };
      latestConfig = rejectedConfig;
      applyConfig(rejectedConfig);
      diagnostic("desktop_pet_e_sprite_rejected", String(error));
    }
    return;
  }
  if (message.type === "snapshot") {
    const previousSnapshot = latestSnapshot;
    latestSnapshot = message.payload;
    const notificationChanged = message.payload.notification?.id !== previousSnapshot?.notification?.id;
    const previousYellowTaskIds = new Set(
      previousSnapshot?.tasks.filter((task) => task.color === "yellow").map((task) => task.id) ?? [],
    );
    const yellowArrived = message.payload.tasks.some(
      (task) => task.color === "yellow" && !previousYellowTaskIds.has(task.id),
    );
    if (latestConfig?.settings.soundEnabled && (yellowArrived || (notificationChanged && latestConfig.settings.notificationsEnabled))) {
      try {
        shell.beep();
      } catch (error) {
        diagnostic("desktop_pet_e_sound_failed", String(error));
      }
    }
    windowRef?.webContents.send("pet-e:snapshot", message.payload);
    return;
  }
  windowRef?.webContents.send("pet-e:action-result", message.payload);
}

function consumeInput(): void {
  const pending = Buffer.allocUnsafe(DESKTOP_PET_E_MAX_LINE_BYTES);
  let pendingLength = 0;
  let discarding = false;
  process.stdin.on("data", (chunk: Buffer) => {
    for (const byte of chunk) {
      if (byte === 10) {
        if (!discarding && pendingLength > 0) {
          const line = pending.subarray(0, pendingLength).toString("utf8").replace(/\r$/, "");
          try {
            const value: unknown = JSON.parse(line);
            if (!isDesktopPetEEnvelope(value)) throw new Error("desktop_pet_e_host_envelope_invalid");
            if (value.instanceId !== instanceId || value.generation !== generation) {
              throw new Error("desktop_pet_e_host_identity_mismatch");
            }
            if (value.revision <= hostRevision) throw new Error("desktop_pet_e_host_revision_stale");
            if (!["config", "snapshot", "action-result", "shutdown"].includes(value.type)) {
              throw new Error("desktop_pet_e_host_type_invalid");
            }
            hostRevision = value.revision;
            hostMessageQueue = hostMessageQueue
              .then(() => handleHostMessage(value as DesktopPetEHostMessage))
              .catch((error) => diagnostic("desktop_pet_e_host_message_failed", String(error)));
          } catch (error) {
            diagnostic("desktop_pet_e_host_message_rejected", String(error));
          }
        } else if (discarding) {
          diagnostic("desktop_pet_e_host_line_too_large", "Host message exceeded 1 MiB");
        }
        pendingLength = 0;
        discarding = false;
      } else if (!discarding) {
        if (pendingLength >= DESKTOP_PET_E_MAX_LINE_BYTES) {
          pendingLength = 0;
          discarding = true;
        } else {
          pending[pendingLength] = byte;
          pendingLength += 1;
        }
      }
    }
  });
  process.stdin.on("end", () => {
    expectedExit = true;
    app.quit();
  });
}

async function registerProtocols(): Promise<void> {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const file = STATIC_FILES.get(url.pathname === "/" ? "/index.html" : url.pathname);
    if (!file) return new Response("Not found", { status: 404 });
    const body = await readFile(path.join(import.meta.dirname, "renderer", file));
    const contentType = file.endsWith(".html")
      ? "text/html; charset=utf-8"
      : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
    return new Response(body, { headers: { "content-type": contentType } });
  });
  protocol.handle(ASSET_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "sprite" || url.pathname !== "/current" || !spritePath) {
      return new Response("Not found", { status: 404 });
    }
    const body = await readFile(spritePath);
    return new Response(body, { headers: { "content-type": "image/webp", "cache-control": "no-store" } });
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      // .cts 固定编译为 .cjs，sandbox preload 因而不依赖 ESM 运行时加载。
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    },
  });
  windowRef = win;
  setWindowMouseInteractive(false);
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) => {
    failCompanion("desktop_pet_e_renderer_gone", `${details.reason}: ${details.exitCode}`);
  });
  win.on("unresponsive", () => {
    failCompanion("desktop_pet_e_renderer_unresponsive", "Renderer stopped responding");
  });
  win.on("move", () => {
    if (!latestSnapshot || latestConfig?.settings.lockPosition) return;
    const [x, y] = win.getPosition();
    if (isProgrammaticMove(x, y)) return;
    clearProgrammaticMoveTarget();
    if (movePublishTimer !== null) clearTimeout(movePublishTimer);
    movePublishTimer = setTimeout(() => {
      movePublishTimer = null;
      if (!latestSnapshot || !latestConfig || latestConfig.settings.lockPosition || win.isDestroyed()) return;
      const display = screen.getDisplayMatching(win.getBounds());
      const area = display.workArea;
      const scale = scaleForWorkArea(latestConfig.settings.size, area);
      const width = Math.min(area.width, Math.round(BASE_WIDTH * scale));
      const height = Math.min(area.height, Math.round(BASE_HEIGHT * scale));
      const [currentX, currentY] = win.getPosition();
      const nextX = Math.min(area.x + area.width - width, Math.max(area.x, currentX));
      const nextY = Math.min(area.y + area.height - height, Math.max(area.y, currentY));
      const currentBounds = win.getBounds();
      if (
        nextX !== currentX
        || nextY !== currentY
        || currentBounds.width !== width
        || currentBounds.height !== height
      ) {
        rememberProgrammaticMove({ x: nextX, y: nextY, width, height });
        win.setBounds({ x: nextX, y: nextY, width, height }, false);
        win.webContents.setZoomFactor(scale);
      }
      sendAction({
        actionId: crypto.randomUUID(),
        kind: "window-state",
        snapshotRevision: latestSnapshot.revision,
        position: { x: nextX, y: nextY },
      });
    }, 150);
  });
  win.on("closed", () => {
    windowRef = null;
    if (!expectedExit && latestSnapshot) {
      sendAction({
        actionId: crypto.randomUUID(),
        kind: "close-pet",
        snapshotRevision: latestSnapshot.revision,
      });
    }
  });
  void win.loadURL(`${APP_SCHEME}://app/index.html`);
}

ipcMain.on("pet-e:renderer-ready", (event) => {
  if (!isTrustedSender(event)) return;
  if (latestConfig) applyConfig(latestConfig);
  if (latestSnapshot) event.sender.send("pet-e:snapshot", latestSnapshot);
  writeMessage("ready", { rendererReady: true });
});
ipcMain.on("pet-e:mouse-interactive", (event, value: unknown) => {
  if (!isTrustedSender(event) || typeof value !== "boolean") return;
  setWindowMouseInteractive(value);
});
ipcMain.on("pet-e:action", (event, value: unknown) => {
  if (!isTrustedSender(event)) return;
  if (!isDesktopPetEChildAction(value)) {
    diagnostic("desktop_pet_e_action_invalid", "Renderer action failed protocol validation");
    const actionId = value && typeof value === "object"
      ? (value as Record<string, unknown>).actionId
      : null;
    if (typeof actionId === "string" && actionId.length <= DESKTOP_PET_E_MAX_ACTION_ID_LENGTH) {
      event.sender.send("pet-e:action-result", {
        actionId,
        accepted: false,
        confirmed: false,
        error: "desktop_pet_e_action_invalid",
      });
    }
    return;
  }
  if (latestSnapshot && value.snapshotRevision !== latestSnapshot.revision) {
    diagnostic("desktop_pet_e_action_revision_stale", "Renderer action does not target the current snapshot");
    event.sender.send("pet-e:action-result", {
      actionId: value.actionId,
      accepted: false,
      confirmed: false,
      error: "desktop_pet_e_action_revision_stale",
    });
    return;
  }
  sendAction(value);
});

process.on("uncaughtException", (error) => {
  failCompanion("desktop_pet_e_uncaught_exception", String(error));
});
process.on("unhandledRejection", (error) => {
  failCompanion("desktop_pet_e_unhandled_rejection", String(error));
});

app.whenReady().then(async () => {
  app.setAppUserModelId("com.cli-manager.desktop-pet-e");
  app.on("web-contents-created", (_event, contents) => {
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  });
  await registerProtocols();
  const reapplyForDisplayChange = () => {
    geometryConfigKey = null;
    if (latestConfig) applyConfig(latestConfig);
  };
  screen.on("display-added", reapplyForDisplayChange);
  screen.on("display-removed", reapplyForDisplayChange);
  screen.on("display-metrics-changed", reapplyForDisplayChange);
  createWindow();
  writeMessage("hello", { runtimeVersion: process.versions.electron, appVersion: app.getVersion() });
}).catch((error) => {
  failCompanion("desktop_pet_e_startup_failed", String(error));
});

app.on("window-all-closed", () => app.quit());
consumeInput();
