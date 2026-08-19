export const DESKTOP_PET_E_PROTOCOL_VERSION = 1;
export const DESKTOP_PET_E_MAX_LINE_BYTES = 1024 * 1024;
export const DESKTOP_PET_E_EVENT = "desktop-pet-e-event";
export const DESKTOP_PET_E_ACTION_EVENT = "desktop-pet-e-action";
export const DESKTOP_PET_E_RUNTIME_STATE_EVENT = "desktop-pet-e-runtime-state";
export const DESKTOP_PET_E_AGENT_EVENT = "desktop-pet-e-agent";
export const DESKTOP_PET_E_PETS_CHANGED_EVENT = "desktop-pet-e-pets-changed";
export const DESKTOP_PET_E_MAX_ACTION_ID_LENGTH = 160;
export const DESKTOP_PET_E_MAX_FIELD_ID_LENGTH = 512;
export const DESKTOP_PET_E_MAX_ANSWERS = 32;
export const DESKTOP_PET_E_MAX_ANSWER_VALUES = 64;
export const DESKTOP_PET_E_MAX_ANSWER_TEXT_LENGTH = 16_384;
export const DESKTOP_PET_E_SIZE_MIN_PERCENT = 50;
export const DESKTOP_PET_E_SIZE_MAX_PERCENT = 200;
export const DESKTOP_PET_E_SIZE_STEP_PERCENT = 5;
export const DESKTOP_PET_E_SIZE_DEFAULT_PERCENT = 100;

export type DesktopPetEColor = "green" | "yellow" | "red" | "blue";
export type DesktopPetEMood = DesktopPetEColor | "idle";
export type DesktopPetEAgentSource = "claude" | "codex" | "pi" | "grok" | "other";
export type DesktopPetEAdapterMode = "interactive" | "jump-only" | "unavailable";
export type DesktopPetEActionKind = "question" | "questionnaire" | "approval";
export type DesktopPetEQuestionMode = "single" | "multiple" | "text";
export type DesktopPetEBubbleDirection = "up" | "down";

export interface DesktopPetEPosition {
  x: number;
  y: number;
}

export interface DesktopPetESettings {
  enabled: boolean;
  petId: string | null;
  size: number;
  position: DesktopPetEPosition | null;
  lockPosition: boolean;
  clickThroughEnabled: boolean;
  alwaysOnTop: boolean;
  soundEnabled: boolean;
  showStatusLabel: boolean;
  showCliLabel: boolean;
  showTaskArea: boolean;
  openOnHover: boolean;
  autoHideFullscreen: boolean;
  notificationsEnabled: boolean;
  agentInteractionEnabled: boolean;
}

export const DEFAULT_DESKTOP_PET_E_SETTINGS: Readonly<DesktopPetESettings> = Object.freeze({
  enabled: false,
  petId: null,
  size: DESKTOP_PET_E_SIZE_DEFAULT_PERCENT,
  position: null,
  lockPosition: false,
  clickThroughEnabled: false,
  alwaysOnTop: true,
  soundEnabled: true,
  showStatusLabel: false,
  showCliLabel: true,
  showTaskArea: true,
  openOnHover: true,
  autoHideFullscreen: true,
  notificationsEnabled: true,
  agentInteractionEnabled: true,
});

export interface DesktopPetEOption {
  value: string;
  label: string;
  description?: string | null;
}

export interface DesktopPetEQuestion {
  id: string;
  label?: string | null;
  prompt: string;
  mode: DesktopPetEQuestionMode;
  required?: boolean;
  allowOther: boolean;
  options: DesktopPetEOption[];
}

export interface DesktopPetEApprovalChoice {
  value: string;
  label: string;
  destructive?: boolean;
}

export interface DesktopPetEPendingAction {
  id: string;
  kind: DesktopPetEActionKind;
  title?: string | null;
  message?: string | null;
  requestGeneration: number;
  adapterMode: DesktopPetEAdapterMode;
  adapterReason?: string | null;
  questions?: DesktopPetEQuestion[];
  approvalChoices?: DesktopPetEApprovalChoice[];
  submitting: boolean;
  error?: string | null;
}

export interface DesktopPetETask {
  id: string;
  sessionId: string;
  source: DesktopPetEAgentSource;
  agentLabel: string;
  title: string;
  projectName?: string | null;
  workspanId?: string | null;
  paneId?: string | null;
  daemonOnly: boolean;
  sessionAlive: boolean;
  color: DesktopPetEColor;
  updatedAt: number;
  viewedAt?: number | null;
  pendingAction?: DesktopPetEPendingAction | null;
}

export interface DesktopPetEColorCounts {
  green: number;
  yellow: number;
  red: number;
  blue: number;
}

export interface DesktopPetENotification {
  id: string;
  title: string;
  message: string;
  createdAt: number;
  expiresAt: number;
}

export interface DesktopPetECliLabel {
  agentLabel: string;
  color: DesktopPetEColor;
  otherTaskCount: number;
}

export interface DesktopPetEDiagnostic {
  code: string;
  message: string;
  detail?: string | null;
  occurredAt: number;
}

export interface DesktopPetESnapshot {
  protocolVersion: typeof DESKTOP_PET_E_PROTOCOL_VERSION;
  instanceId: string;
  generation: number;
  revision: number;
  generatedAt: number;
  tasks: DesktopPetETask[];
  counts: DesktopPetEColorCounts;
  mood: DesktopPetEMood;
  cliLabel: DesktopPetECliLabel | null;
  notification: DesktopPetENotification | null;
  diagnostics: DesktopPetEDiagnostic[];
}

export interface DesktopPetEPetAsset {
  id: string;
  displayName: string;
  spritePath: string;
  spriteVersionNumber: 1 | 2;
  states: Record<"idle" | DesktopPetEColor, { row: number; frames: number }>;
}

export interface DesktopPetEConfigPayload {
  language: "zh-CN" | "zh-TW" | "en-US";
  visible: boolean;
  bubbleDirection?: DesktopPetEBubbleDirection;
  settings: DesktopPetESettings;
  pet: DesktopPetEPetAsset | null;
  labels: Record<string, string>;
}

export interface DesktopPetEEnvelope<TType extends string, TPayload> {
  protocolVersion: typeof DESKTOP_PET_E_PROTOCOL_VERSION;
  instanceId: string;
  generation: number;
  revision: number;
  type: TType;
  payload: TPayload;
}

export interface DesktopPetEAnswer {
  questionId: string;
  values: string[];
  customValue?: string | null;
}

export type DesktopPetEChildAction =
  | {
      actionId: string;
      kind: "open-task";
      snapshotRevision: number;
      taskId: string;
    }
  | {
      actionId: string;
      kind: "clear-task";
      snapshotRevision: number;
      taskId: string;
    }
  | {
      actionId: string;
      kind: "submit-action";
      snapshotRevision: number;
      taskId: string;
      pendingActionId: string;
      answers?: DesktopPetEAnswer[];
      approvalValue?: string;
    }
  | {
      actionId: string;
      kind: "open-settings";
      snapshotRevision: number;
    }
  | {
      actionId: string;
      kind: "close-pet";
      snapshotRevision: number;
    }
  | {
      actionId: string;
      kind: "window-state";
      snapshotRevision: number;
      position: DesktopPetEPosition;
    };

export interface DesktopPetEAgentEvent {
  brokerEpoch: string;
  phase: "pending" | "submitted" | "resolved" | "failed" | "cancelled";
  sessionId: string;
  source: Exclude<DesktopPetEAgentSource, "other">;
  pendingActionId: string;
  transportActionId?: string | null;
  pendingAction: DesktopPetEPendingAction;
  error?: string | null;
}

export interface DesktopPetEActionResult {
  actionId: string;
  accepted: boolean;
  confirmed: boolean;
  error?: string | null;
}

export type DesktopPetEHostMessage =
  | DesktopPetEEnvelope<"config", DesktopPetEConfigPayload>
  | DesktopPetEEnvelope<"snapshot", DesktopPetESnapshot>
  | DesktopPetEEnvelope<"action-result", DesktopPetEActionResult>
  | DesktopPetEEnvelope<"shutdown", { reason: string }>;

export type DesktopPetEChildMessage =
  | DesktopPetEEnvelope<"hello", { runtimeVersion: string; appVersion: string }>
  | DesktopPetEEnvelope<"ready", { rendererReady: boolean }>
  | DesktopPetEEnvelope<"action", DesktopPetEChildAction>
  | DesktopPetEEnvelope<"diagnostic", DesktopPetEDiagnostic>;

export interface DesktopPetERuntimeState {
  enabled: boolean;
  running: boolean;
  ready: boolean;
  generation: number;
  restartCount: number;
  lastError?: DesktopPetEDiagnostic | null;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePosition(value: unknown): DesktopPetEPosition | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.x !== "number" ||
    !Number.isFinite(candidate.x) ||
    typeof candidate.y !== "number" ||
    !Number.isFinite(candidate.y)
  ) {
    return null;
  }
  return {
    x: Math.round(Math.min(100_000, Math.max(-100_000, candidate.x))),
    y: Math.round(Math.min(100_000, Math.max(-100_000, candidate.y))),
  };
}

export function normalizeDesktopPetESize(
  value: unknown,
  fallback = DESKTOP_PET_E_SIZE_DEFAULT_PERCENT,
): number {
  const safeFallback = typeof fallback === "number" && Number.isFinite(fallback)
    ? fallback
    : DESKTOP_PET_E_SIZE_DEFAULT_PERCENT;
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : safeFallback;
  const clamped = Math.min(DESKTOP_PET_E_SIZE_MAX_PERCENT, Math.max(DESKTOP_PET_E_SIZE_MIN_PERCENT, numeric));
  return Math.round(clamped / DESKTOP_PET_E_SIZE_STEP_PERCENT) * DESKTOP_PET_E_SIZE_STEP_PERCENT;
}

export function normalizeDesktopPetESettings(
  value: unknown,
  fallback: DesktopPetESettings = DEFAULT_DESKTOP_PET_E_SETTINGS,
): DesktopPetESettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    petId: normalizePetId(raw.petId, fallback.petId),
    size: normalizeDesktopPetESize(raw.size, fallback.size),
    position: normalizePosition(raw.position),
    lockPosition: normalizeBoolean(raw.lockPosition, fallback.lockPosition),
    clickThroughEnabled: normalizeBoolean(raw.clickThroughEnabled, fallback.clickThroughEnabled),
    alwaysOnTop: normalizeBoolean(raw.alwaysOnTop, fallback.alwaysOnTop),
    soundEnabled: normalizeBoolean(raw.soundEnabled, fallback.soundEnabled),
    showStatusLabel: normalizeBoolean(raw.showStatusLabel, fallback.showStatusLabel),
    showCliLabel: normalizeBoolean(raw.showCliLabel, fallback.showCliLabel),
    showTaskArea: normalizeBoolean(raw.showTaskArea, fallback.showTaskArea),
    openOnHover: normalizeBoolean(raw.openOnHover, fallback.openOnHover),
    autoHideFullscreen: normalizeBoolean(raw.autoHideFullscreen, fallback.autoHideFullscreen),
    notificationsEnabled: normalizeBoolean(raw.notificationsEnabled, fallback.notificationsEnabled),
    agentInteractionEnabled: normalizeBoolean(raw.agentInteractionEnabled, fallback.agentInteractionEnabled),
  };
}

function normalizePetId(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 160 ? normalized : fallback;
}

export function isDesktopPetEAgentEvent(value: unknown): value is DesktopPetEAgentEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    !isBoundedString(candidate.brokerEpoch, DESKTOP_PET_E_MAX_ACTION_ID_LENGTH)
    || !["pending", "submitted", "resolved", "failed", "cancelled"].includes(String(candidate.phase))
    || !isBoundedString(candidate.sessionId, DESKTOP_PET_E_MAX_FIELD_ID_LENGTH)
    || !["claude", "codex", "pi", "grok"].includes(String(candidate.source))
    || !isBoundedString(candidate.pendingActionId, DESKTOP_PET_E_MAX_FIELD_ID_LENGTH)
    || (candidate.transportActionId !== undefined
      && candidate.transportActionId !== null
      && !isBoundedString(candidate.transportActionId, DESKTOP_PET_E_MAX_ACTION_ID_LENGTH))
  ) {
    return false;
  }
  const action = candidate.pendingAction;
  if (!action || typeof action !== "object") return false;
  const pendingAction = action as Record<string, unknown>;
  return pendingAction.id === candidate.pendingActionId
    && ["question", "questionnaire", "approval"].includes(String(pendingAction.kind))
    && Number.isSafeInteger(pendingAction.requestGeneration)
    && (pendingAction.requestGeneration as number) >= 0
    && ["interactive", "jump-only", "unavailable"].includes(String(pendingAction.adapterMode))
    && typeof pendingAction.submitting === "boolean";
}

export function isDesktopPetEChildAction(value: unknown): value is DesktopPetEChildAction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    !isBoundedString(candidate.actionId, DESKTOP_PET_E_MAX_ACTION_ID_LENGTH)
    || !Number.isSafeInteger(candidate.snapshotRevision)
    || (candidate.snapshotRevision as number) < 0
  ) {
    return false;
  }
  if (candidate.kind === "open-settings" || candidate.kind === "close-pet") return true;
  if (candidate.kind === "window-state") {
    const position = candidate.position;
    if (!position || typeof position !== "object") return false;
    const point = position as Record<string, unknown>;
    return typeof point.x === "number" && Number.isFinite(point.x)
      && typeof point.y === "number" && Number.isFinite(point.y);
  }
  if (candidate.kind === "open-task" || candidate.kind === "clear-task") {
    return isBoundedString(candidate.taskId, DESKTOP_PET_E_MAX_FIELD_ID_LENGTH);
  }
  if (candidate.kind !== "submit-action") return false;
  if (
    !isBoundedString(candidate.taskId, DESKTOP_PET_E_MAX_FIELD_ID_LENGTH)
    || !isBoundedString(candidate.pendingActionId, DESKTOP_PET_E_MAX_FIELD_ID_LENGTH)
    || (candidate.approvalValue !== undefined
      && !isBoundedString(candidate.approvalValue, DESKTOP_PET_E_MAX_ANSWER_TEXT_LENGTH))
  ) {
    return false;
  }
  if (candidate.answers === undefined) return true;
  if (!Array.isArray(candidate.answers) || candidate.answers.length > DESKTOP_PET_E_MAX_ANSWERS) {
    return false;
  }
  return candidate.answers.every((answer) => {
    if (!answer || typeof answer !== "object") return false;
    const item = answer as Record<string, unknown>;
    return isBoundedString(item.questionId, DESKTOP_PET_E_MAX_FIELD_ID_LENGTH)
      && Array.isArray(item.values)
      && item.values.length <= DESKTOP_PET_E_MAX_ANSWER_VALUES
      && item.values.every((entry) => isBoundedString(entry, DESKTOP_PET_E_MAX_ANSWER_TEXT_LENGTH))
      && (item.customValue === undefined
        || item.customValue === null
        || isBoundedString(item.customValue, DESKTOP_PET_E_MAX_ANSWER_TEXT_LENGTH));
  });
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function isDesktopPetEEnvelope(value: unknown): value is DesktopPetEEnvelope<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocolVersion === DESKTOP_PET_E_PROTOCOL_VERSION
    && typeof candidate.instanceId === "string"
    && candidate.instanceId.length > 0
    && Number.isSafeInteger(candidate.generation)
    && (candidate.generation as number) >= 0
    && Number.isSafeInteger(candidate.revision)
    && (candidate.revision as number) >= 0
    && typeof candidate.type === "string"
    && candidate.type.length > 0
    && "payload" in candidate;
}

export function canEnableDesktopPetE(desktopPetEnabled: boolean): boolean {
  return !desktopPetEnabled;
}

export function canEnableDesktopPet(desktopPetEEnabled: boolean): boolean {
  return !desktopPetEEnabled;
}
