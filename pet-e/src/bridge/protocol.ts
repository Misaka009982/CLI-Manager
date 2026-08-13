export const DESKTOP_PET_E_PROTOCOL_VERSION = 1;
export const DESKTOP_PET_E_MAX_LINE_BYTES = 1024 * 1024;
export const DESKTOP_PET_E_EVENT = "desktop-pet-e-event";
export const DESKTOP_PET_E_RUNTIME_STATE_EVENT = "desktop-pet-e-runtime-state";
export const DESKTOP_PET_E_SIZE_MIN_PERCENT = 50;
export const DESKTOP_PET_E_SIZE_MAX_PERCENT = 200;
export const DESKTOP_PET_E_SIZE_STEP_PERCENT = 5;
export const DESKTOP_PET_E_SIZE_DEFAULT_PERCENT = 100;

export const DESKTOP_PET_E_THEMES = ["clawd", "calico", "cloudling"] as const;
export type DesktopPetETheme = (typeof DESKTOP_PET_E_THEMES)[number];

export type DesktopPetEColor = "green" | "yellow" | "red" | "blue";
export type DesktopPetEMood = DesktopPetEColor | "idle";
export type DesktopPetEAgentSource = "claude" | "codex" | "pi" | "grok" | "other";
export type DesktopPetEAdapterMode = "interactive" | "jump-only" | "unavailable";
export type DesktopPetEActionKind = "question" | "questionnaire" | "approval";
export type DesktopPetEQuestionMode = "single" | "multiple" | "text";

export interface DesktopPetEPosition {
  x: number;
  y: number;
}

export interface DesktopPetESettings {
  enabled: boolean;
  theme: DesktopPetETheme;
  size: number;
  position: DesktopPetEPosition | null;
  lockPosition: boolean;
  alwaysOnTop: boolean;
  soundEnabled: boolean;
  showStatus: boolean;
  showCliLabel: boolean;
  showTaskArea: boolean;
  openOnHover: boolean;
  autoHideFullscreen: boolean;
  notificationsEnabled: boolean;
  agentInteractionEnabled: boolean;
}

export const DEFAULT_DESKTOP_PET_E_SETTINGS: Readonly<DesktopPetESettings> = Object.freeze({
  enabled: false,
  theme: "clawd",
  size: DESKTOP_PET_E_SIZE_DEFAULT_PERCENT,
  position: null,
  lockPosition: false,
  alwaysOnTop: true,
  soundEnabled: true,
  showStatus: true,
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

export interface DesktopPetEConfigPayload {
  language: "zh-CN" | "zh-TW" | "en-US";
  visible: boolean;
  settings: DesktopPetESettings;
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
    theme: isDesktopPetETheme(raw.theme) ? raw.theme : fallback.theme,
    size: normalizeDesktopPetESize(raw.size, fallback.size),
    position: normalizePosition(raw.position),
    lockPosition: normalizeBoolean(raw.lockPosition, fallback.lockPosition),
    alwaysOnTop: normalizeBoolean(raw.alwaysOnTop, fallback.alwaysOnTop),
    soundEnabled: normalizeBoolean(raw.soundEnabled, fallback.soundEnabled),
    showStatus: normalizeBoolean(raw.showStatus, fallback.showStatus),
    showCliLabel: normalizeBoolean(raw.showCliLabel, fallback.showCliLabel),
    showTaskArea: normalizeBoolean(raw.showTaskArea, fallback.showTaskArea),
    openOnHover: normalizeBoolean(raw.openOnHover, fallback.openOnHover),
    autoHideFullscreen: normalizeBoolean(raw.autoHideFullscreen, fallback.autoHideFullscreen),
    notificationsEnabled: normalizeBoolean(raw.notificationsEnabled, fallback.notificationsEnabled),
    agentInteractionEnabled: normalizeBoolean(raw.agentInteractionEnabled, fallback.agentInteractionEnabled),
  };
}

export function isDesktopPetETheme(value: unknown): value is DesktopPetETheme {
  return typeof value === "string" && DESKTOP_PET_E_THEMES.includes(value as DesktopPetETheme);
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
