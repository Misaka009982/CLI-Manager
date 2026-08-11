"use strict";

const path = require("node:path");
const { realpathSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
} = require("electron");
const {
  MESSAGE_PREFIX,
  MAX_PROTOCOL_LINE_LENGTH,
  PROTOCOL_VERSION,
  encodeMessage,
  isProtocolMessage,
  parseMessage,
} = require("../protocol.cjs");
const {
  clampPetPosition,
  computeWindowLayout,
  defaultPetPosition,
  normalizeShapeRects,
  normalizeSize,
  petSize,
} = require("./geometry.cjs");

const COMPANION_VERSION = "1.0.0";
const PLATFORM_VALUES = new Set(["telegram", "feishu", "weixin", "wecom"]);
const STATUS_FILTERS = new Set(["green", "red", "blue"]);
const TARGET_MODES = new Set(["open", "platforms", "handoff"]);
const MOODS = ["idle", "working", "waiting", "success", "error", "sleeping"];

function readArgument(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : "";
}

const token = readArgument("cli-manager-pet-token");
const parentPid = Number(readArgument("cli-manager-pet-parent-pid"));
if (
  token.length < 8
  || token.length > 256
  || !Number.isInteger(parentPid)
  || parentPid <= 0
) {
  process.exit(2);
}

let renderWin = null;
let hitWin = null;
let hostState = null;
let pendingSync = null;
let petPosition = null;
let currentLayout = null;
let deliveryRevision = 0;
let windowsReadyCount = 0;
let readySent = false;
let shuttingDown = false;
let dragState = null;
let lastHostPositionKey = null;
let parentTimer = null;
let uiState = {
  menuOpen: false,
  targetMode: "open",
  selectedPlatform: null,
  statusFilter: null,
  hoveredId: null,
  previewSize: null,
  dismissedCompletionId: null,
  completionTimer: null,
  decisionUi: {},
};

function sendProtocol(message) {
  process.stdout.write(encodeMessage({
    protocolVersion: PROTOCOL_VERSION,
    token,
    ...message,
  }));
}

function sendFatal(code, message) {
  if (shuttingDown) return;
  sendProtocol({
    kind: "error",
    code,
    message: typeof message === "string" ? message.slice(0, 2_000) : code,
  });
  shuttingDown = true;
  app.quit();
}

function isIdentifier(value) {
  return typeof value === "string"
    && value.trim().length >= 8
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isGeneration(value) {
  return Boolean(
    value
      && typeof value === "object"
      && isIdentifier(value.lifecycleToken)
      && isIdentifier(value.petSurfaceEpoch)
      && isIdentifier(value.bubbleSurfaceEpoch)
  );
}

function generationsMatch(left, right) {
  return Boolean(
    left
      && right
      && left.lifecycleToken === right.lifecycleToken
      && left.petSurfaceEpoch === right.petSurfaceEpoch
      && left.bubbleSurfaceEpoch === right.bubbleSurfaceEpoch
  );
}

function hasAlertContent(snapshot) {
  return Boolean(
    snapshot
      && (
        (Array.isArray(snapshot.decisionRequests) && snapshot.decisionRequests.length > 0)
        || (Array.isArray(snapshot.incidents) && snapshot.incidents.length > 0)
      )
  );
}

function currentCompletion(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.targets)) return null;
  let result = null;
  for (const target of snapshot.targets) {
    if (!target || target.status !== "done" || typeof target.sessionId !== "string") continue;
    if (!Number.isFinite(target.updatedAt)) continue;
    if (
      !result
      || target.updatedAt > result.updatedAt
      || (target.updatedAt === result.updatedAt && target.sessionId < result.sessionId)
    ) {
      result = target;
    }
  }
  if (!result) return null;
  return {
    id: `${result.sessionId}:${result.updatedAt}`,
    sessionId: result.sessionId,
    daemonOnly: Boolean(result.daemonOnly),
    sessionTitle: typeof result.sessionTitle === "string" ? result.sessionTitle : null,
    projectName: typeof result.projectName === "string" ? result.projectName : null,
    message: typeof result.message === "string" ? result.message : null,
    updatedAt: result.updatedAt,
  };
}

function visibleCompletion() {
  const completion = currentCompletion(hostState?.snapshot);
  if (!completion || completion.id === uiState.dismissedCompletionId) {
    uiState.completionTimer = null;
    return null;
  }
  if (!uiState.completionTimer || uiState.completionTimer.id !== completion.id) {
    const expiresAt = completion.updatedAt + 8_000;
    uiState.completionTimer = {
      id: completion.id,
      expiresAt,
      remainingMs: Math.max(0, expiresAt - Date.now()),
      paused: false,
    };
  }
  const timer = uiState.completionTimer;
  if (timer.paused) return timer.remainingMs > 0 ? completion : null;
  timer.remainingMs = Math.max(0, timer.expiresAt - Date.now());
  return timer.remainingMs > 0 ? completion : null;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative);
}

function preparePet(rawPet) {
  if (!rawPet || typeof rawPet !== "object") return null;
  const manifest = rawPet.manifest;
  if (!manifest || typeof manifest !== "object" || typeof rawPet.baseDir !== "string") {
    return null;
  }
  let root;
  try {
    root = realpathSync(rawPet.baseDir);
  } catch {
    return null;
  }
  const states = {};
  for (const mood of MOODS) {
    const state = manifest.states?.[mood] || manifest.states?.idle;
    if (!state || typeof state.file !== "string") continue;
    let assetPath;
    try {
      assetPath = realpathSync(path.resolve(root, state.file));
    } catch {
      continue;
    }
    if (!isInside(root, assetPath)) continue;
    states[mood] = {
      url: pathToFileURL(assetPath).href,
      row: Number.isInteger(state.row) ? state.row : 0,
      frames: Number.isInteger(state.frames) ? state.frames : 1,
    };
  }
  if (!states.idle) return null;
  return {
    manifest: {
      id: typeof manifest.id === "string" ? manifest.id : "desktop-pet",
      name: manifest.name && typeof manifest.name === "object" ? manifest.name : null,
      engine: manifest.engine === "codex-sprite" ? "codex-sprite" : "image-v1",
      spriteVersionNumber: manifest.spriteVersionNumber === 2 ? 2 : 1,
      states,
    },
  };
}

function displayForPet(position = petPosition) {
  const point = position || screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint({
    x: Math.round(point.x),
    y: Math.round(point.y),
  });
}

function physicalToDip(position) {
  const point = { x: Math.round(position.x), y: Math.round(position.y) };
  return typeof screen.screenToDipPoint === "function"
    ? screen.screenToDipPoint(point)
    : point;
}

function dipToPhysical(position) {
  const point = { x: Math.round(position.x), y: Math.round(position.y) };
  return typeof screen.dipToScreenPoint === "function"
    ? screen.dipToScreenPoint(point)
    : point;
}

function windowPayload() {
  if (!hostState || !currentLayout) return null;
  const completion = hostState.config.bubbleVisible ? visibleCompletion() : null;
  return {
    config: hostState.config,
    snapshot: hostState.snapshot,
    pet: hostState.pet,
    generation: hostState.generation,
    deliveryRevision: hostState.deliveryRevision,
    layout: currentLayout,
    ui: uiState,
    completion,
    completionTimer: completion ? uiState.completionTimer : null,
  };
}

function sendToWindow(win, channel, payload) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function broadcastState() {
  const payload = windowPayload();
  if (!payload) return;
  sendToWindow(renderWin, "desktop-pet-state", payload);
  sendToWindow(hitWin, "desktop-pet-state", payload);
}

function updateWindowBounds(win, bounds) {
  if (!win || win.isDestroyed()) return;
  const current = win.getBounds();
  if (
    current.x !== bounds.x
    || current.y !== bounds.y
    || current.width !== bounds.width
    || current.height !== bounds.height
  ) {
    win.setBounds(bounds, false);
  }
}

function syncWindows() {
  if (!hostState || !renderWin || !hitWin || !petPosition) return;
  const sizePercent = normalizeSize(uiState.previewSize ?? hostState.config.settings.size);
  const display = displayForPet();
  const workArea = display.workArea;
  const size = petSize(sizePercent);
  petPosition = clampPetPosition(petPosition, workArea, size);
  const completion = visibleCompletion();
  const bubbleOpen = Boolean(
    hostState.config.visible
      && hostState.config.bubbleVisible
      && (hasAlertContent(hostState.snapshot) || completion)
  );
  const menuOpen = Boolean(hostState.config.visible && uiState.menuOpen);
  currentLayout = computeWindowLayout({
    sizePercent,
    petPosition,
    workArea,
    menuOpen,
    bubbleOpen,
    snapshot: hostState.snapshot,
    includeCompletion: Boolean(completion),
  });
  petPosition = currentLayout.petPosition;
  const alwaysOnTop = Boolean(hostState.config.settings.alwaysOnTop);
  for (const win of [renderWin, hitWin]) {
    updateWindowBounds(win, currentLayout.bounds);
    win.setAlwaysOnTop(alwaysOnTop, "floating");
    win.setSkipTaskbar(true);
  }
  if (hostState.config.visible) {
    renderWin.showInactive();
    hitWin.showInactive();
  } else {
    renderWin.hide();
    hitWin.hide();
  }
  broadcastState();
}

function markWindowReady() {
  windowsReadyCount += 1;
  if (windowsReadyCount < 2) return;
  if (pendingSync) {
    const sync = pendingSync;
    pendingSync = null;
    applySync(sync);
  } else if (hostState) {
    syncWindows();
  }
  if (hostState && !readySent) {
    readySent = true;
    sendProtocol({ kind: "ready" });
  }
}

function createWindow(surface) {
  const isRender = surface === "render";
  const win = new BrowserWindow({
    width: 190,
    height: 210,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: !isRender,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.setSkipTaskbar(true);
  win.setIgnoreMouseEvents(true, { forward: false });
  win.webContents.on("did-finish-load", markWindowReady);
  win.webContents.on("did-fail-load", (_event, code, description) => {
    sendFatal("desktop_pet_companion_window_load_failed", `${code}: ${description}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    if (!shuttingDown) {
      sendFatal(
        "desktop_pet_companion_renderer_gone",
        `${surface}: ${details.reason || "unknown"}`
      );
    }
  });
  win.on("unresponsive", () => {
    sendFatal("desktop_pet_companion_renderer_unresponsive", surface);
  });
  win.on("closed", () => {
    if (!shuttingDown) sendFatal("desktop_pet_companion_window_closed", surface);
  });
  void win.loadFile(path.join(__dirname, "index.html"), {
    query: { surface },
  });
  return win;
}

function sanitizeDecisionAnswer(answer) {
  if (!answer || !Array.isArray(answer.answers) || answer.answers.length > 64) return null;
  const answers = [];
  for (const item of answer.answers) {
    if (
      !item
      || typeof item.questionId !== "string"
      || item.questionId.length > 256
      || typeof item.value !== "string"
      || item.value.length > 4_000
    ) {
      return null;
    }
    answers.push({
      questionId: item.questionId,
      value: item.value,
      wasCustom: Boolean(item.wasCustom),
    });
  }
  return { answers };
}

function boundedString(value, maxLength, nullable = false) {
  if (nullable && value === null) return null;
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function knownOpenTarget(sessionId) {
  if (sessionId === null) return true;
  const snapshot = hostState?.snapshot;
  if (!snapshot) return false;
  if (snapshot.sessionId === sessionId) return true;
  if ((snapshot.targets || []).some((target) => target.sessionId === sessionId)) return true;
  if ((snapshot.incidents || []).some(
    (incident) => incident.tabId === sessionId || incident.sessionId === sessionId
  )) {
    return true;
  }
  return currentCompletion(snapshot)?.sessionId === sessionId;
}

function decisionAnswerMatches(request, answer) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  if (!answer || answer.answers.length !== questions.length) return false;
  const answers = new Map(answer.answers.map((item) => [item.questionId, item]));
  if (answers.size !== questions.length) return false;
  return questions.every((question) => {
    const item = answers.get(question.id);
    if (!item || !item.value.trim()) return false;
    if (item.wasCustom) return Boolean(question.allowOther);
    return (question.options || []).some((option) => option.value === item.value);
  });
}

function sanitizeRendererAction(raw) {
  if (!hostState || !raw || typeof raw !== "object" || !hostState.config.visible) return null;
  const generation = hostState.generation;
  const bubble = raw.surface === "bubble";
  const surfaceEpoch = bubble
    ? generation.bubbleSurfaceEpoch
    : generation.petSurfaceEpoch;
  const base = {
    lifecycleToken: generation.lifecycleToken,
    surfaceEpoch,
  };
  let sessionId;
  switch (raw.type) {
    case "openTarget":
      sessionId = boundedString(raw.sessionId, 256, true);
      if (sessionId === undefined || !knownOpenTarget(sessionId)) return null;
      return {
        ...base,
        type: "openTarget",
        sessionId,
        daemonOnly: Boolean(raw.daemonOnly),
      };
    case "openSettings":
      return { ...base, type: "openSettings" };
    case "handoffStart": {
      const sessionId = boundedString(raw.sessionId, 256);
      const target = (hostState.snapshot.targets || []).find(
        (candidate) => candidate.sessionId === sessionId
      );
      const platform = (hostState.snapshot.handoffPlatforms || []).find(
        (candidate) => candidate.platform === raw.platform
      );
      if (
        !sessionId
        || !target?.handoffCandidate
        || (!target.handoffEligible && !target.handoffRecoverable)
        || !platform?.enabled
        || !platform.ready
        || !PLATFORM_VALUES.has(raw.platform)
      ) {
        return null;
      }
      return { ...base, type: "handoffStart", sessionId, platform: raw.platform };
    }
    case "handoffCancel":
      return { ...base, type: "handoffCancel" };
    case "decisionResolve": {
      const requestId = boundedString(raw.requestId, 256);
      const brokerEpoch = boundedString(raw.brokerEpoch, 256);
      const answer = sanitizeDecisionAnswer(raw.answer);
      const request = (hostState.snapshot.decisionRequests || []).find(
        (candidate) => (
          candidate.requestId === requestId && candidate.brokerEpoch === brokerEpoch
        )
      );
      if (!requestId || !brokerEpoch || !answer || !decisionAnswerMatches(request, answer)) {
        return null;
      }
      return {
        ...base,
        type: "decisionResolve",
        requestId,
        brokerEpoch,
        answer,
      };
    }
    case "incidentAcknowledge": {
      const incidentId = boundedString(raw.incidentId, 512);
      const incidentExists = (hostState.snapshot.incidents || []).some(
        (incident) => incident.id === incidentId
      );
      return incidentId && incidentExists
        ? { ...base, type: "incidentAcknowledge", incidentId }
        : null;
    }
    case "hide":
      return hasAlertContent(hostState.snapshot) ? null : { ...base, type: "hide" };
    case "bubbleDismiss": {
      const completionId = boundedString(raw.completionId, 512, true);
      const alertsPresent = hasAlertContent(hostState.snapshot);
      const currentCompletionId = currentCompletion(hostState.snapshot)?.id ?? null;
      if (
        completionId === undefined
        || alertsPresent
        || completionId !== currentCompletionId
      ) {
        return null;
      }
      return { ...base, type: "bubbleDismiss", completionId };
    }
    default:
      return null;
  }
}

function emitAction(action) {
  sendProtocol({ kind: "action", action });
}

function isHitSender(event) {
  return Boolean(
    hitWin
      && !hitWin.isDestroyed()
      && event.sender.id === hitWin.webContents.id
  );
}

function sanitizeDecisionUi(value) {
  if (!value || typeof value !== "object") return {};
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length > 64_000) return {};
    return JSON.parse(encoded);
  } catch {
    return {};
  }
}

function applyUiPatch(patch) {
  if (!patch || typeof patch !== "object") return;
  if (typeof patch.menuOpen === "boolean") uiState.menuOpen = patch.menuOpen;
  if (TARGET_MODES.has(patch.targetMode)) uiState.targetMode = patch.targetMode;
  if (patch.selectedPlatform === null || PLATFORM_VALUES.has(patch.selectedPlatform)) {
    uiState.selectedPlatform = patch.selectedPlatform;
  }
  if (patch.statusFilter === null || STATUS_FILTERS.has(patch.statusFilter)) {
    uiState.statusFilter = patch.statusFilter;
  }
  if (patch.hoveredId === null || typeof patch.hoveredId === "string") {
    uiState.hoveredId = patch.hoveredId?.slice(0, 512) ?? null;
  }
  if (patch.dismissedCompletionId === null || typeof patch.dismissedCompletionId === "string") {
    uiState.dismissedCompletionId = patch.dismissedCompletionId?.slice(0, 512) ?? null;
    if (uiState.dismissedCompletionId) uiState.completionTimer = null;
  }
  if (typeof patch.completionPaused === "boolean" && uiState.completionTimer) {
    const timer = uiState.completionTimer;
    if (patch.completionPaused && !timer.paused) {
      timer.remainingMs = Math.max(0, timer.expiresAt - Date.now());
      timer.paused = true;
    } else if (!patch.completionPaused && timer.paused) {
      timer.expiresAt = Date.now() + timer.remainingMs;
      timer.paused = false;
    }
    if (patch.completionPaused && Object.keys(patch).length === 1) return;
  }
  if (patch.decisionUi && typeof patch.decisionUi === "object") {
    uiState.decisionUi = sanitizeDecisionUi(patch.decisionUi);
  }
  syncWindows();
}

function emitPositionAction(type, sizePercent) {
  if (!hostState || !petPosition) return;
  const physical = dipToPhysical(petPosition);
  const action = {
    lifecycleToken: hostState.generation.lifecycleToken,
    surfaceEpoch: hostState.generation.petSurfaceEpoch,
    type,
    x: physical.x,
    y: physical.y,
  };
  if (type === "sizeChanged") action.size = normalizeSize(sizePercent);
  emitAction(action);
}

function registerIpc() {
  ipcMain.on("desktop-pet-action", (event, raw) => {
    if (!isHitSender(event)) return;
    const action = sanitizeRendererAction(raw);
    if (action) emitAction(action);
  });
  ipcMain.on("desktop-pet-ui-patch", (event, patch) => {
    if (!isHitSender(event)) return;
    applyUiPatch(patch);
  });
  ipcMain.on("desktop-pet-size-preview", (event, value) => {
    if (!isHitSender(event)) return;
    uiState.previewSize = normalizeSize(Number(value));
    syncWindows();
  });
  ipcMain.on("desktop-pet-size-commit", (event, value) => {
    if (!isHitSender(event)) return;
    const size = normalizeSize(Number(value));
    uiState.previewSize = null;
    syncWindows();
    emitPositionAction("sizeChanged", size);
  });
  ipcMain.on("desktop-pet-hit-shape", (event, report) => {
    if (!isHitSender(event) || !hitWin || hitWin.isDestroyed() || !currentLayout) return;
    const rects = Array.isArray(report) ? report : report?.rects;
    const scaleFactor = Array.isArray(report) ? 1 : report?.scaleFactor;
    const shape = normalizeShapeRects(rects, currentLayout.bounds, scaleFactor);
    hitWin.setShape(shape);
    hitWin.setIgnoreMouseEvents(shape.length === 0, { forward: false });
  });
  ipcMain.on("desktop-pet-drag-start", (event) => {
    if (!isHitSender(event) || !hostState || !petPosition) return;
    if (hostState.config.settings.lockPosition) return;
    dragState = {
      cursor: screen.getCursorScreenPoint(),
      petPosition: { ...petPosition },
    };
  });
  ipcMain.on("desktop-pet-drag-move", (event) => {
    if (!isHitSender(event) || !dragState || !hostState) return;
    const cursor = screen.getCursorScreenPoint();
    const size = petSize(normalizeSize(uiState.previewSize ?? hostState.config.settings.size));
    const next = {
      x: dragState.petPosition.x + cursor.x - dragState.cursor.x,
      y: dragState.petPosition.y + cursor.y - dragState.cursor.y,
    };
    const display = screen.getDisplayNearestPoint(cursor);
    petPosition = clampPetPosition(next, display.workArea, size);
    syncWindows();
  });
  ipcMain.on("desktop-pet-drag-end", (event, moved) => {
    if (!isHitSender(event) || !dragState) return;
    dragState = null;
    if (!moved) return;
    uiState.menuOpen = false;
    syncWindows();
    emitPositionAction("positionChanged");
  });
}

function applySync(message) {
  if (!app.isReady() || windowsReadyCount < 2) {
    pendingSync = message;
    return;
  }
  if (message.deliveryRevision <= deliveryRevision) {
    if (!readySent) {
      readySent = true;
      sendProtocol({ kind: "ready" });
    }
    return;
  }
  deliveryRevision = message.deliveryRevision;
  const position = message.config.settings.position;
  const positionKey = position && Number.isFinite(position.x) && Number.isFinite(position.y)
    ? `${Math.round(position.x)}:${Math.round(position.y)}`
    : "default";
  if (!petPosition || positionKey !== lastHostPositionKey) {
    if (positionKey !== "default") {
      petPosition = physicalToDip(position);
    } else if (!petPosition || lastHostPositionKey !== "default") {
      const display = screen.getPrimaryDisplay();
      petPosition = defaultPetPosition(
        display.workArea,
        petSize(normalizeSize(message.config.settings.size))
      );
    }
    lastHostPositionKey = positionKey;
  }
  const generationChanged = Boolean(
    hostState && !generationsMatch(message.generation, hostState.generation)
  );
  hostState = {
    generation: message.generation,
    deliveryRevision: message.deliveryRevision,
    config: message.config,
    snapshot: message.snapshot,
    pet: preparePet(message.pet),
  };
  if (generationChanged) {
    uiState.decisionUi = {};
    uiState.menuOpen = false;
  }
  if (!hostState.config.visible) {
    uiState.menuOpen = false;
    uiState.hoveredId = null;
  }
  syncWindows();
  if (!readySent) {
    readySent = true;
    sendProtocol({ kind: "ready" });
  }
}

function handleHostMessage(message) {
  if (!message || message.token !== token || message.protocolVersion !== PROTOCOL_VERSION) return;
  if (isProtocolMessage(message, "sync")) {
    if (
      !isGeneration(message.generation)
      || !Number.isSafeInteger(message.deliveryRevision)
      || message.deliveryRevision <= 0
      || !message.config
      || typeof message.config !== "object"
      || !message.config.settings
      || typeof message.config.settings !== "object"
      || !message.snapshot
      || typeof message.snapshot !== "object"
    ) {
      sendFatal("desktop_pet_companion_sync_invalid", "Invalid sync payload");
      return;
    }
    applySync(message);
    return;
  }
  if (isProtocolMessage(message, "actionResult")) {
    if (!hostState || !generationsMatch(message.generation, hostState.generation)) return;
    const payload = {
      requestId: boundedString(message.requestId, 256),
      brokerEpoch: boundedString(message.brokerEpoch, 256),
      accepted: Boolean(message.accepted),
    };
    if (!payload.requestId || !payload.brokerEpoch) return;
    sendToWindow(renderWin, "desktop-pet-action-result", payload);
    sendToWindow(hitWin, "desktop-pet-action-result", payload);
    return;
  }
  if (isProtocolMessage(message, "shutdown")) {
    if (hostState && !generationsMatch(message.generation, hostState.generation)) return;
    shuttingDown = true;
    app.quit();
  }
}

function readStdin() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_PROTOCOL_LINE_LENGTH * 2) {
      sendFatal("desktop_pet_companion_message_too_large", "Input buffer exceeded limit");
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.length > MAX_PROTOCOL_LINE_LENGTH) {
        sendFatal("desktop_pet_companion_message_too_large", "Input line exceeded limit");
        return;
      }
      if (line.startsWith(MESSAGE_PREFIX)) {
        handleHostMessage(parseMessage(line));
      }
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    if (!shuttingDown) {
      shuttingDown = true;
      app.quit();
    }
  });
}

function monitorParent() {
  parentTimer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      shuttingDown = true;
      app.quit();
    }
  }, 2_000);
  parentTimer.unref();
}

app.on("before-quit", () => {
  shuttingDown = true;
  if (parentTimer) clearInterval(parentTimer);
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {});

sendProtocol({
  kind: "hello",
  companionVersion: COMPANION_VERSION,
});
readStdin();
monitorParent();

void app.whenReady().then(() => {
  app.setAppUserModelId("com.climanager.desktop-pet");
  registerIpc();
  renderWin = createWindow("render");
  hitWin = createWindow("hit");
  screen.on("display-added", syncWindows);
  screen.on("display-removed", syncWindows);
  screen.on("display-metrics-changed", syncWindows);
});
