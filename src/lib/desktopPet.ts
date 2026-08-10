import type {
  Project,
  RemoteHandoffPhase,
  SshHost,
  TerminalSession,
  WorktreeRecord,
} from "./types";
import {
  getRemoteHandoffEligibility,
  type CcConnectHandoffInfo,
  type CcConnectHandoffPlatformTarget,
} from "./remoteHandoff";
import {
  convertChineseForLanguage,
  isEnglishLanguage,
  resolveLanguagePreference,
  translate,
  type AppLanguage,
} from "./i18n";
import type {
  SessionStatus,
  TabNotificationState,
  TabStatusDetails,
} from "../stores/terminalStore";
import type { DesktopPetSettings, LanguagePreference } from "../stores/settingsStore";
import { shouldIncludeAgentTerminal } from "./agentTerminal";
import { desktopPetScaleFromPercent } from "./desktopPetSize";
import { resolveDesktopPetOpenSessionStatus } from "./desktopPetStatus";

export {
  calculateDesktopPetMenuWindowGeometry,
  DESKTOP_PET_MENU_MAX_VISIBLE_PLATFORMS,
  DESKTOP_PET_MENU_MAX_VISIBLE_TARGETS,
  resizeDesktopPetCollapsedWindowBounds,
  createLatestAsyncTaskRunner,
  type DesktopPetMenuHorizontalPlacement,
  type DesktopPetMenuVerticalPlacement,
  type DesktopPetMenuWindowOptions,
  type DesktopPetMenuWindowGeometry,
  type DesktopPetWindowRect,
  type LatestAsyncTaskContext,
  type LatestAsyncTaskRunner,
} from "./desktopPetMenu";
export {
  DESKTOP_PET_SIZE_DEFAULT_PERCENT,
  DESKTOP_PET_SIZE_MAX_PERCENT,
  DESKTOP_PET_SIZE_MIN_PERCENT,
  DESKTOP_PET_SIZE_STEP_PERCENT,
  normalizeDesktopPetSizePercent,
  stepDesktopPetSizePercent,
} from "./desktopPetSize";

export const DESKTOP_PET_WINDOW_LABEL = "desktop-pet";
export const DESKTOP_PET_BUBBLE_WINDOW_LABEL = "desktop-pet-bubble";
export const DESKTOP_PET_CONFIG_EVENT = "desktop-pet-config";
export const DESKTOP_PET_SNAPSHOT_EVENT = "desktop-pet-snapshot";
export const DESKTOP_PET_READY_EVENT = "desktop-pet-ready";
export const DESKTOP_PET_BUBBLE_READY_EVENT = "desktop-pet-bubble-ready";
export const DESKTOP_PET_COORDINATOR_READY_EVENT = "desktop-pet-coordinator-ready";
export const DESKTOP_PET_BUBBLE_LAYOUT_REQUEST_EVENT = "desktop-pet-bubble-layout-request";
export const DESKTOP_PET_BUBBLE_MEASURE_EVENT = "desktop-pet-bubble-measure";
export const DESKTOP_PET_BUBBLE_GEOMETRY_EVENT = "desktop-pet-bubble-geometry";
export const DESKTOP_PET_BUBBLE_EMPTY_EVENT = "desktop-pet-bubble-empty";
export const DESKTOP_PET_BUBBLE_FOCUS_EVENT = "desktop-pet-bubble-focus";
export const DESKTOP_PET_HIDDEN_EVENT = "desktop-pet-hidden";
export const DESKTOP_PET_OPEN_TARGET_EVENT = "desktop-pet-open-target";
export const DESKTOP_PET_OPEN_SETTINGS_EVENT = "desktop-pet-open-settings";
export const DESKTOP_PET_CLOSE_MENU_EVENT = "desktop-pet-close-menu";
export const DESKTOP_PET_POSITION_EVENT = "desktop-pet-position";
export const DESKTOP_PET_SIZE_CHANGE_EVENT = "desktop-pet-size-change";
export const DESKTOP_PET_HANDOFF_START_EVENT = "remote-handoff-start-request";
export const DESKTOP_PET_HANDOFF_CANCEL_EVENT = "remote-handoff-cancel-request";
export const DESKTOP_PET_DECISION_RESOLVE_EVENT = "desktop-pet-decision-resolve";
export const DESKTOP_PET_DECISION_RESULT_EVENT = "desktop-pet-decision-result";
export const DESKTOP_PET_INCIDENT_ACK_EVENT = "desktop-pet-incident-ack";

export type DesktopPetMood = "idle" | "working" | "waiting" | "success" | "error" | "sleeping";
export type DesktopPetStatusColor = "green" | "red" | "blue";
export type DesktopPetAttentionKind = "permission" | "question" | "questionnaire" | "attention";

export interface DesktopPetStatusCounts {
  green: number;
  red: number;
  blue: number;
}

export interface PiDecisionOption {
  value: string;
  label: string;
  description?: string | null;
}

export interface PiDecisionQuestion {
  id: string;
  label: string;
  prompt: string;
  allowOther: boolean;
  options: PiDecisionOption[];
}

export interface DesktopPetDecisionRequest {
  requestId: string;
  brokerEpoch: string;
  sourceInstanceId: string;
  tabId: string;
  sessionId: string | null;
  kind: "question" | "questionnaire" | "permission";
  title: string;
  message: string | null;
  questions: PiDecisionQuestion[];
  createdAt: number;
}

export interface DesktopPetDecisionAnswerItem {
  questionId: string;
  value: string;
  wasCustom: boolean;
}

export interface DesktopPetDecisionAnswer {
  answers: DesktopPetDecisionAnswerItem[];
}

export interface DesktopPetDecisionResult {
  requestId: string;
  brokerEpoch: string;
  lifecycleToken: string;
  bubbleSurfaceEpoch: string;
  accepted: boolean;
}

export interface DesktopPetIncident {
  id: string;
  tabId: string;
  sessionId: string | null;
  daemonOnly: boolean;
  title: string;
  message: string | null;
  createdAt: number;
}

export interface PetLocalizedText {
  "zh-CN": string;
  "en-US": string;
}

export interface PetStateAsset {
  file: string;
  row?: number;
  frames?: number;
}

export interface PetManifest {
  schemaVersion: number;
  id: string;
  version: string;
  name: PetLocalizedText;
  description: PetLocalizedText;
  author: string;
  license: string;
  engine: "image-v1" | "codex-sprite";
  canvas: { width: number; height: number };
  states: Partial<Record<DesktopPetMood, PetStateAsset>> & { idle: PetStateAsset };
  spriteVersionNumber?: 1 | 2;
}

export interface PetCatalogEntry {
  id: string;
  version: string;
  name: PetLocalizedText;
  description: PetLocalizedText;
  author: string;
  license: string;
  minAppVersion: string;
  previewUrl: string;
  previewDataUrl?: string | null;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
}

export interface PetCatalogResponse {
  items: PetCatalogEntry[];
  source: "remote" | "cache" | "bundled" | string;
  warning?: string | null;
}

export interface InstalledPet {
  manifest: PetManifest;
  baseDir: string;
  source: "cli-manager" | "codex";
  format: "clipet" | "codex";
  removable: boolean;
}

export interface BackgroundPetTask {
  sessionId: string;
  cwd?: string | null;
  alive: boolean;
  taskStatus?: TabNotificationState | null;
  taskUpdatedAtMs?: number | null;
  createdAtMs: number;
}

export interface DesktopPetTarget {
  sessionId: string;
  daemonOnly: boolean;
  sessionTitle: string | null;
  projectName: string | null;
  status: TabNotificationState;
  attentionKind: DesktopPetAttentionKind | null;
  message: string | null;
  active: boolean;
  updatedAt: number;
  handoffCandidate: boolean;
  handoffEligible: boolean;
  handoffRecoverable: boolean;
  handoffReason: import("./remoteHandoff").RemoteHandoffEligibilityReason | null;
  handedOff: boolean;
  handoffPhase: RemoteHandoffPhase | null;
}

export interface DesktopPetSnapshot {
  mood: DesktopPetMood;
  sessionId: string | null;
  daemonOnly: boolean;
  sessionTitle: string | null;
  projectName: string | null;
  runningCount: number;
  attentionCount: number;
  statusCounts: DesktopPetStatusCounts;
  updatedAt: number;
  targets: DesktopPetTarget[];
  decisionRequests: DesktopPetDecisionRequest[];
  incidents: DesktopPetIncident[];
  handoff: CcConnectHandoffInfo | null;
  handoffPlatforms: CcConnectHandoffPlatformTarget[];
  handoffBusy: boolean;
}

export interface DesktopPetSurfaceDeliveryMeta {
  lifecycleToken: string;
  surfaceEpoch: string;
  deliveryRevision: number;
}

export type DesktopPetSnapshotEventPayload = DesktopPetSnapshot & DesktopPetSurfaceDeliveryMeta;

export interface DesktopPetConfigPayload {
  language: AppLanguage;
  visible: boolean;
  bubbleVisible: boolean;
  lifecycleToken: string;
  settings: DesktopPetSettings;
  labels: {
    openMain: string;
    openSettings: string;
    size: string;
    hide: string;
    idle: string;
    working: string;
    waiting: string;
    success: string;
    error: string;
    sleeping: string;
    runningCount: string;
    taskList: string;
    currentTask: string;
    unnamedTask: string;
    openCurrent: string;
    remoteHandoff: string;
    cancelHandoff: string;
    handoffPlatforms: string;
    handoffSessions: string;
    handoffBack: string;
    platformReady: string;
    platformNotRunning: string;
    platformCredentialsMissing: string;
    platformUserMissing: string;
    platformSessionMissing: string;
    platformUnavailable: string;
    platformTelegram: string;
    platformFeishu: string;
    platformWeixin: string;
    platformWecom: string;
    handoffPending: string;
    handoffCancelling: string;
    handedOff: string;
    handoffRecoveryFailed: string;
    noHandoffSessions: string;
    handoffReady: string;
    handoffResolveRemoteSession: string;
    handoffTaskRunning: string;
    handoffStateUnknown: string;
    handoffUnavailable: string;
    acknowledge: string;
    submit: string;
    customAnswer: string;
    sendAnswer: string;
    permissionRequest: string;
    questionRequest: string;
    questionnaireRequest: string;
    decisionSubmitFailed: string;
  };
}

export type DesktopPetConfigEventPayload = DesktopPetConfigPayload & DesktopPetSurfaceDeliveryMeta;

export interface DesktopPetPositionPayload {
  x: number;
  y: number;
  lifecycleToken: string;
  petSurfaceEpoch: string;
}

export function buildDesktopPetLabels(
  language: DesktopPetConfigPayload["language"]
): DesktopPetConfigPayload["labels"] {
  return {
    openMain: translate(language, "desktopPet.actions.openMain"),
    openSettings: translate(language, "desktopPet.actions.openSettings"),
    size: translate(language, "desktopPet.settings.size"),
    hide: translate(language, "desktopPet.actions.hide"),
    idle: translate(language, "desktopPet.mood.idle"),
    working: translate(language, "desktopPet.mood.working"),
    waiting: translate(language, "desktopPet.mood.waiting"),
    success: translate(language, "desktopPet.mood.success"),
    error: translate(language, "desktopPet.mood.error"),
    sleeping: translate(language, "desktopPet.mood.sleeping"),
    runningCount: translate(language, "desktopPet.mood.runningCount"),
    taskList: translate(language, "desktopPet.actions.taskList"),
    currentTask: translate(language, "desktopPet.actions.currentTask"),
    unnamedTask: translate(language, "desktopPet.actions.unnamedTask"),
    openCurrent: translate(language, "desktopPet.actions.openCurrent"),
    remoteHandoff: translate(language, "desktopPet.actions.remoteHandoff"),
    cancelHandoff: translate(language, "desktopPet.actions.cancelHandoff"),
    handoffPlatforms: translate(language, "desktopPet.actions.handoffPlatforms"),
    handoffSessions: translate(language, "desktopPet.actions.handoffSessions"),
    handoffBack: translate(language, "desktopPet.actions.handoffBack"),
    platformReady: translate(language, "desktopPet.actions.platformReady"),
    platformNotRunning: translate(language, "desktopPet.actions.platformNotRunning"),
    platformCredentialsMissing: translate(
      language,
      "desktopPet.actions.platformCredentialsMissing"
    ),
    platformUserMissing: translate(language, "desktopPet.actions.platformUserMissing"),
    platformSessionMissing: translate(language, "desktopPet.actions.platformSessionMissing"),
    platformUnavailable: translate(language, "desktopPet.actions.platformUnavailable"),
    platformTelegram: translate(language, "settings.ccConnect.platformTelegram"),
    platformFeishu: translate(language, "settings.ccConnect.platformFeishu"),
    platformWeixin: translate(language, "settings.ccConnect.platformWeixin"),
    platformWecom: translate(language, "settings.ccConnect.platformWecom"),
    handoffPending: translate(language, "remoteHandoff.overlay.pending"),
    handoffCancelling: translate(language, "remoteHandoff.overlay.cancelling"),
    handedOff: translate(language, "desktopPet.actions.handedOff"),
    handoffRecoveryFailed: translate(language, "desktopPet.actions.handoffRecoveryFailed"),
    noHandoffSessions: translate(language, "desktopPet.actions.noHandoffSessions"),
    handoffReady: translate(language, "desktopPet.actions.handoffReady"),
    handoffResolveRemoteSession: translate(
      language,
      "desktopPet.actions.handoffResolveRemoteSession"
    ),
    handoffTaskRunning: translate(language, "desktopPet.actions.handoffTaskRunning"),
    handoffStateUnknown: translate(language, "desktopPet.actions.handoffStateUnknown"),
    handoffUnavailable: translate(language, "desktopPet.actions.handoffUnavailable"),
    acknowledge: translate(language, "desktopPet.actions.acknowledge"),
    submit: translate(language, "desktopPet.actions.submit"),
    customAnswer: translate(language, "desktopPet.actions.customAnswer"),
    sendAnswer: translate(language, "desktopPet.actions.sendAnswer"),
    permissionRequest: translate(language, "desktopPet.decision.permission"),
    questionRequest: translate(language, "desktopPet.decision.question"),
    questionnaireRequest: translate(language, "desktopPet.decision.questionnaire"),
    decisionSubmitFailed: translate(language, "desktopPet.decision.submitFailed"),
  };
}

export interface DesktopPetSizeChangePayload extends DesktopPetPositionPayload {
  size: number;
}

export interface DesktopPetSurfaceReadyPayload {
  surfaceEpoch: string;
}

export interface DesktopPetBubbleLayoutRequestPayload {
  lifecycleToken: string;
  petSurfaceEpoch: string;
  revision: number;
}

export interface DesktopPetBubbleMeasurementPayload extends DesktopPetBubbleLayoutRequestPayload {
  bubbleSurfaceEpoch: string;
  measurementRevision: number;
  contentFingerprint: string;
  naturalWidth: number;
  naturalHeight: number;
}

export interface DesktopPetBubbleGeometryPayload extends DesktopPetBubbleLayoutRequestPayload {
  bubbleSurfaceEpoch: string;
  measurementRevision: number;
  geometryRevision: number;
  placement: "above" | "below" | "left" | "right";
  logicalWidth: number;
  logicalHeight: number;
  arrowOffset: number;
}

export interface DesktopPetBubbleEmptyPayload {
  lifecycleToken: string;
  bubbleSurfaceEpoch: string;
  completionId: string | null;
}

export interface DesktopPetBubbleFocusPayload {
  lifecycleToken: string;
  color: DesktopPetStatusColor;
}

export interface DesktopPetHiddenPayload {
  lifecycleToken: string;
  petSurfaceEpoch: string;
}

export interface DesktopPetHitRegion {
  kind: "stage" | "panel" | "control";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopPetSurfaceActionPayload {
  lifecycleToken: string;
  surfaceEpoch: string;
}

export interface DesktopPetOpenTargetPayload extends DesktopPetSurfaceActionPayload {
  sessionId: string | null;
  daemonOnly: boolean;
}

export type DesktopPetOpenSettingsPayload = DesktopPetSurfaceActionPayload;

export { DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS } from "./desktopPetStatus";

const STATUS_PRIORITY: Record<TabNotificationState, number> = {
  none: 0,
  running: 1,
  done: 2,
  attention: 3,
  failed: 4,
};

function moodFromStatus(status: TabNotificationState): DesktopPetMood {
  if (status === "running") return "working";
  if (status === "attention") return "waiting";
  if (status === "done") return "success";
  if (status === "failed") return "error";
  return "idle";
}

function daemonTaskStatus(task: BackgroundPetTask): TabNotificationState {
  const explicitStatus = explicitDaemonTaskStatus(task);
  if (explicitStatus) return explicitStatus;
  return task.alive ? "running" : "done";
}

function daemonTaskUpdatedAt(task: BackgroundPetTask): number {
  if (explicitDaemonTaskStatus(task)) {
    return task.taskUpdatedAtMs ?? task.createdAtMs;
  }
  return task.alive ? 0 : task.createdAtMs;
}

function explicitDaemonTaskStatus(task: BackgroundPetTask | undefined): TabNotificationState | null {
  if (
    task?.taskStatus === "running" ||
    task?.taskStatus === "attention" ||
    task?.taskStatus === "done" ||
    task?.taskStatus === "failed"
  ) {
    return task.taskStatus;
  }
  return null;
}

interface DeriveDesktopPetSnapshotInput {
  sessions: TerminalSession[];
  persistedSessions: TerminalSession[];
  activeSessionId: string | null;
  tabNotifications: Record<string, TabNotificationState>;
  sessionStatuses: Record<string, SessionStatus>;
  tabStatusDetails: Record<string, TabStatusDetails>;
  ptyOutputActivityAt: Record<string, number>;
  projects: Project[];
  worktrees: WorktreeRecord[];
  sshHosts: SshHost[];
  backgroundTasks: BackgroundPetTask[];
  agentSessionsOnly: boolean;
  activeHandoff: CcConnectHandoffInfo | null;
  handoffBusy: boolean;
  now?: number;
}

function compareDesktopPetTargets(left: DesktopPetTarget, right: DesktopPetTarget): number {
  const priority = STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status];
  if (priority !== 0) return priority;
  if (left.active !== right.active) return left.active ? -1 : 1;
  return right.updatedAt - left.updatedAt;
}

function snapshotFromTargets(
  targets: DesktopPetTarget[],
  now: number,
  handoff: CcConnectHandoffInfo | null,
  handoffBusy: boolean
): DesktopPetSnapshot {
  if (targets.length === 0) {
    return {
      mood: "sleeping",
      sessionId: null,
      daemonOnly: false,
      sessionTitle: null,
      projectName: null,
      runningCount: 0,
      attentionCount: 0,
      statusCounts: { green: 0, red: 0, blue: 0 },
      updatedAt: now,
      targets: [],
      decisionRequests: [],
      incidents: [],
      handoff,
      handoffPlatforms: [],
      handoffBusy,
    };
  }

  const candidates = [...targets].sort(compareDesktopPetTargets);
  const selected = candidates[0];
  return {
    mood: moodFromStatus(selected.status),
    sessionId: selected.sessionId,
    daemonOnly: selected.daemonOnly,
    sessionTitle: selected.sessionTitle,
    projectName: selected.projectName,
    runningCount: candidates.filter((candidate) => candidate.status === "running").length,
    attentionCount: candidates.filter((candidate) => candidate.status === "attention").length,
    statusCounts: {
      green: candidates.filter((candidate) => candidate.status === "running").length,
      red: candidates.filter((candidate) => candidate.status === "failed").length,
      blue: candidates.filter((candidate) => candidate.status === "attention" || candidate.status === "done").length,
    },
    updatedAt: selected.updatedAt || now,
    targets: candidates,
    decisionRequests: [],
    incidents: [],
    handoff,
    handoffPlatforms: [],
    handoffBusy,
  };
}

export function deriveDesktopPetSnapshot(input: DeriveDesktopPetSnapshotInput): DesktopPetSnapshot {
  const now = input.now ?? Date.now();
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const worktreeById = new Map(input.worktrees.map((worktree) => [worktree.id, worktree]));
  const sshHostById = new Map(input.sshHosts.map((host) => [host.id, host]));
  const persistedById = new Map(input.persistedSessions.map((session) => [session.id, session]));
  const backgroundById = new Map(input.backgroundTasks.map((task) => [task.sessionId, task]));
  const allOpenPtySessions = input.sessions.filter((session) => !session.kind || session.kind === "pty");
  const openIds = new Set(allOpenPtySessions.map((session) => session.id));
  const openPtySessions = allOpenPtySessions.filter((session) => (
    shouldIncludeAgentTerminal(
      session,
      session.projectId ? projectById.get(session.projectId) : undefined,
      input.agentSessionsOnly
    )
  ));
  const candidates: DesktopPetTarget[] = openPtySessions.map((session) => {
    const frontendDetails = input.tabStatusDetails[session.id];
    const { status, updatedAt } = resolveDesktopPetOpenSessionStatus({
      frontendStatus: input.tabNotifications[session.id] ?? "none",
      frontendDetails,
      daemonTask: backgroundById.get(session.id),
      outputActivityAt: input.ptyOutputActivityAt[session.id] ?? 0,
      now,
    });
    const project = session.projectId ? projectById.get(session.projectId) : undefined;
    const handoffPhase = session.remoteHandoff?.phase
      ?? (input.activeHandoff?.localSessionId === session.id ? "active" : null);
    const handedOff = handoffPhase !== null && handoffPhase !== "recovery_failed";
    const eligibility = getRemoteHandoffEligibility({
      session,
      project,
      sshHost: project?.ssh_host_id ? sshHostById.get(project.ssh_host_id) : undefined,
      worktree: session.worktreeId ? worktreeById.get(session.worktreeId) ?? null : null,
      notification: status,
      processStatus: input.sessionStatuses[session.id],
      activeHandoff: input.activeHandoff,
    });
    const handoffCandidate = eligibility.reason !== "codex_only"
      && eligibility.reason !== "missing_project"
      && eligibility.reason !== "unsupported_session";
    const handoffRecoverable = project?.environment_type === "ssh"
      && eligibility.reason === "missing_cli_session_id";
    return {
      sessionId: session.id,
      daemonOnly: false,
      status,
      attentionKind: frontendDetails?.attentionKind ?? null,
      message: frontendDetails?.message ?? null,
      updatedAt,
      sessionTitle: session.title || null,
      projectName: project?.name ?? null,
      active: session.id === input.activeSessionId,
      handoffCandidate,
      handoffEligible: eligibility.eligible,
      handoffRecoverable,
      handoffReason: eligibility.reason,
      handedOff,
      handoffPhase,
    };
  });
  for (const task of input.backgroundTasks) {
    if (openIds.has(task.sessionId)) continue;
    const persisted = persistedById.get(task.sessionId);
    const project = persisted?.projectId ? projectById.get(persisted.projectId) : undefined;
    if (!shouldIncludeAgentTerminal(persisted, project, input.agentSessionsOnly)) continue;
    candidates.push({
      sessionId: task.sessionId,
      daemonOnly: true,
      status: daemonTaskStatus(task),
      attentionKind: null,
      message: null,
      updatedAt: daemonTaskUpdatedAt(task),
      sessionTitle: persisted?.title || task.cwd || null,
      projectName: project?.name ?? null,
      active: false,
      handoffCandidate: false,
      handoffEligible: false,
      handoffRecoverable: false,
      handoffReason: "unsupported_session",
      handedOff: false,
      handoffPhase: null,
    });
  }
  if (
    input.activeHandoff
    && !candidates.some((candidate) => candidate.sessionId === input.activeHandoff?.localSessionId)
  ) {
    candidates.push({
      sessionId: input.activeHandoff.localSessionId,
      daemonOnly: false,
      status: "none",
      attentionKind: null,
      message: null,
      updatedAt: input.activeHandoff.startedAtMs,
      sessionTitle: null,
      projectName: input.activeHandoff.projectName,
      active: false,
      handoffCandidate: true,
      handoffEligible: false,
      handoffRecoverable: false,
      handoffReason: "already_handed_off",
      handedOff: true,
      handoffPhase: "active",
    });
  }

  return snapshotFromTargets(candidates, now, input.activeHandoff, input.handoffBusy);
}

export function desktopPetScale(size: DesktopPetSettings["size"]): number {
  return desktopPetScaleFromPercent(size);
}

export function localizedPetText(text: PetLocalizedText, language: LanguagePreference): string {
  const resolvedLanguage = resolveLanguagePreference(language);
  return isEnglishLanguage(resolvedLanguage)
    ? text["en-US"]
    : convertChineseForLanguage(resolvedLanguage, text["zh-CN"]);
}

export function joinPetAssetPath(baseDir: string, relativePath: string): string {
  const separator = baseDir.includes("\\") ? "\\" : "/";
  return `${baseDir.replace(/[\\/]$/, "")}${separator}${relativePath.replace(/^[\\/]/, "")}`;
}
