import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import {
  DESKTOP_PET_E_ACTION_EVENT,
  DESKTOP_PET_E_AGENT_EVENT,
  DESKTOP_PET_E_EVENT,
  DESKTOP_PET_E_PETS_CHANGED_EVENT,
  DESKTOP_PET_E_RUNTIME_STATE_EVENT,
  isDesktopPetEAgentEvent,
  isDesktopPetEChildAction,
  type DesktopPetEActionResult,
  type DesktopPetEConfigPayload,
  type DesktopPetENotification,
  type DesktopPetEPetAsset,
  type DesktopPetEPosition,
  type DesktopPetERuntimeState,
  type DesktopPetESnapshot,
} from "../lib/desktopPetE";
import {
  deriveDesktopPetECandidates,
  deriveDesktopPetESnapshot,
  mergeDesktopPetECandidatesWithHistory,
  type DesktopPetETaskCandidate,
} from "../lib/desktopPetEState";
import {
  DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS,
  joinPetAssetPath,
  localizedPetText,
  type BackgroundPetTask,
  type InstalledPet,
} from "../lib/desktopPet";
import { sameBackgroundPetTasks } from "../lib/desktopPetTransport";
import { desktopPetESyncFingerprint } from "../lib/desktopPetETransport";
import { useI18n } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import { useProjectStore } from "../stores/projectStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useTerminalStore, type CliHookPayload } from "../stores/terminalStore";
import { useDesktopPetERuntimeStore } from "../stores/desktopPetERuntimeStore";
import { useDesktopPetEAgentStore } from "../stores/desktopPetEAgentStore";
import { findPaneLeafBySession } from "../stores/terminalPaneTree";

interface UseDesktopPetECoordinatorOptions {
  appReady: boolean;
  terminalFullscreen: boolean;
  onOpenSettings: () => void;
  onActivateSession: (sessionId: string) => Promise<void>;
}

const EMPTY_RUNTIME_STATE: DesktopPetERuntimeState = {
  enabled: false,
  running: false,
  ready: false,
  generation: 0,
  restartCount: 0,
  lastError: null,
};

const DESKTOP_PET_E_NOTIFICATION_DURATION_MS = 5_000;
const CLAUDE_QUESTION_TOOL_NAME = "AskUserQuestion";
const CODEX_QUESTION_TOOL_NAME = "request_user_input";

function createInstanceId(): string {
  return `cli-manager-${crypto.randomUUID()}`;
}

function isDesktopPetEOrdinaryNotification(payload: CliHookPayload): boolean {
  if (payload.event !== "Stop" && payload.event !== "StopFailure" && payload.event !== "Notification") {
    return false;
  }
  return !(
    payload.event === "Notification"
    && ((payload.source === "claude" && payload.toolName === CLAUDE_QUESTION_TOOL_NAME)
      || (payload.source === "codex" && payload.toolName === CODEX_QUESTION_TOOL_NAME))
  );
}

function desktopPetENotificationSource(payload: CliHookPayload): string {
  if (payload.source === "codex") return "Codex CLI";
  if (payload.source === "pi") return "Pi Agent";
  if (payload.source === "grok") return "Grok Build";
  return "Claude Code";
}

function desktopPetENotificationId(payload: CliHookPayload): string {
  const remoteEventId = payload.remoteEventId?.trim();
  return remoteEventId ? remoteEventId.slice(0, 160) : crypto.randomUUID();
}

function normalizeDesktopPetEPosition(position: DesktopPetEPosition): DesktopPetEPosition | null {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  return { x: Math.round(position.x), y: Math.round(position.y) };
}

function desktopPetESnapshotContentKey(snapshot: DesktopPetESnapshot): string {
  return JSON.stringify({
    tasks: snapshot.tasks,
    counts: snapshot.counts,
    mood: snapshot.mood,
    cliLabel: snapshot.cliLabel,
    notification: snapshot.notification,
    diagnostics: snapshot.diagnostics,
  });
}

function desktopPetEPetAsset(pet: InstalledPet | null, language: Parameters<typeof localizedPetText>[1]): DesktopPetEPetAsset | null {
  if (!pet || pet.format !== "codex" || pet.manifest.engine !== "codex-sprite") return null;
  const spriteFile = pet.manifest.states.idle.file;
  const state = (mood: "idle" | "working" | "waiting" | "success" | "error") => {
    const asset = pet.manifest.states[mood] ?? pet.manifest.states.idle;
    return { row: asset.row ?? 0, frames: asset.frames ?? 1 };
  };
  return {
    id: pet.manifest.id,
    displayName: localizedPetText(pet.manifest.name, language),
    spritePath: joinPetAssetPath(pet.baseDir, spriteFile),
    spriteVersionNumber: pet.manifest.spriteVersionNumber === 2 ? 2 : 1,
    states: {
      idle: state("idle"),
      green: state("working"),
      yellow: state("waiting"),
      red: state("error"),
      blue: state("success"),
    },
  };
}

export function useDesktopPetECoordinator({
  appReady,
  terminalFullscreen,
  onOpenSettings,
  onActivateSession,
}: UseDesktopPetECoordinatorOptions) {
  const { language, t } = useI18n();
  const settings = useSettingsStore((state) => state.desktopPetE);
  const existingDesktopPetEnabled = useSettingsStore((state) => state.desktopPet.enabled);
  const existingDesktopPetId = useSettingsStore((state) => state.desktopPet.petId);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const replaceRuntimeState = useDesktopPetERuntimeStore((state) => state.replace);
  const pendingActions = useDesktopPetEAgentStore((state) => state.pendingActions);
  const projects = useProjectStore((state) => state.projects);
  const persistedSessions = useSessionStore((state) => state.sessions);
  const {
    sessions,
    workspans,
    activeSessionId,
    sessionStatuses,
    tabNotifications,
    tabStatusDetails,
    ptyOutputActivityAt,
  } = useTerminalStore(
    useShallow((state) => ({
      sessions: state.sessions,
      workspans: state.workspans,
      activeSessionId: state.activeSessionId,
      sessionStatuses: state.sessionStatuses,
      tabNotifications: state.tabNotifications,
      tabStatusDetails: state.tabStatusDetails,
      ptyOutputActivityAt: state.ptyOutputActivityAt,
    })),
  );
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundPetTask[]>([]);
  const [installedCodexPets, setInstalledCodexPets] = useState<InstalledPet[]>([]);
  const [notification, setNotification] = useState<DesktopPetENotification | null>(null);
  const [activityExpiryRevision, setActivityExpiryRevision] = useState(0);
  const [runtimeState, setRuntimeState] = useState<DesktopPetERuntimeState>(EMPTY_RUNTIME_STATE);
  const [viewedTerminalTaskIds, setViewedTerminalTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [clearedTaskIds, setClearedTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const instanceIdRef = useRef<string>(createInstanceId());
  const terminalHistoryRef = useRef<DesktopPetETaskCandidate[]>([]);
  const sessionStatusObservationsRef = useRef(new Map<string, { status: string; updatedAt: number }>());
  const revisionRef = useRef({ generation: -1, contentKey: "", revision: 0, generatedAt: Date.now() });
  const settingsRef = useRef(settings);
  const snapshotRef = useRef<DesktopPetESnapshot | null>(null);
  const onOpenSettingsRef = useRef(onOpenSettings);
  const onActivateSessionRef = useRef(onActivateSession);
  const lastSyncKeyRef = useRef<string | null>(null);
  const petSubmissionActionIdsRef = useRef<Set<string>>(new Set());
  settingsRef.current = settings;
  onOpenSettingsRef.current = onOpenSettings;
  onActivateSessionRef.current = onActivateSession;

  const tracking = appReady && settingsLoaded && settings.enabled;
  const visible = tracking && !(settings.autoHideFullscreen && terminalFullscreen);
  const selectedPet = useMemo(() => {
    const preferredId = settings.petId ?? existingDesktopPetId;
    const selected = installedCodexPets.find((pet) => pet.manifest.id === preferredId) ?? null;
    const fallback = settings.petId ? null : installedCodexPets[0] ?? null;
    return desktopPetEPetAsset(selected ?? fallback, language);
  }, [existingDesktopPetId, installedCodexPets, language, settings.petId]);

  const targetBySessionId = useMemo(() => {
    const targets = new Map<string, { workspanId: string; paneId: string }>();
    for (const workspan of workspans) {
      for (const session of sessions) {
        if (targets.has(session.id)) continue;
        const pane = findPaneLeafBySession(workspan.paneTree, session.id);
        if (pane) targets.set(session.id, { workspanId: workspan.id, paneId: pane.id });
      }
    }
    return targets;
  }, [sessions, workspans]);

  const sessionStatusUpdatedAt = useMemo(() => {
    const observedAt = Date.now();
    const observations = sessionStatusObservationsRef.current;
    const currentSessionIds = new Set(Object.keys(sessionStatuses));
    for (const sessionId of observations.keys()) {
      if (!currentSessionIds.has(sessionId)) observations.delete(sessionId);
    }
    const result: Record<string, number> = {};
    for (const [sessionId, status] of Object.entries(sessionStatuses)) {
      const current = observations.get(sessionId);
      if (!current || current.status !== status) {
        observations.set(sessionId, { status, updatedAt: observedAt });
      }
      result[sessionId] = observations.get(sessionId)?.updatedAt ?? observedAt;
    }
    return result;
  }, [sessionStatuses]);

  const currentCandidates = useMemo(() => deriveDesktopPetECandidates({
    instanceId: instanceIdRef.current,
    generation: runtimeState.generation,
    revision: 0,
    sessions,
    persistedSessions,
    projects,
    targetBySessionId,
    activeSessionId,
    sessionStatuses,
    sessionStatusUpdatedAt,
    tabNotifications,
    tabStatusDetails,
    ptyOutputActivityAt,
    backgroundTasks,
    pendingActions,
  }), [
    activeSessionId,
    activityExpiryRevision,
    backgroundTasks,
    pendingActions,
    persistedSessions,
    projects,
    ptyOutputActivityAt,
    runtimeState.generation,
    sessionStatuses,
    sessionStatusUpdatedAt,
    sessions,
    tabNotifications,
    tabStatusDetails,
    targetBySessionId,
  ]);

  const liveSessionIds = useMemo(() => new Set([
    ...sessions.map((session) => session.id),
    ...backgroundTasks.map((task) => task.sessionId),
  ]), [backgroundTasks, sessions]);

  const candidates = useMemo(() => mergeDesktopPetECandidatesWithHistory(
    terminalHistoryRef.current,
    currentCandidates,
    liveSessionIds,
  ), [currentCandidates, liveSessionIds]);

  useEffect(() => {
    terminalHistoryRef.current = candidates;
  }, [candidates]);

  const unversionedSnapshot = useMemo(() => deriveDesktopPetESnapshot({
    instanceId: instanceIdRef.current,
    generation: runtimeState.generation,
    revision: 0,
    generatedAt: 0,
    candidates,
    viewedTerminalTaskIds,
    clearedTaskIds,
    notification,
  }, activeSessionId), [
    activeSessionId,
    candidates,
    clearedTaskIds,
    notification,
    runtimeState.generation,
    viewedTerminalTaskIds,
  ]);

  const snapshot = useMemo<DesktopPetESnapshot>(() => {
    const contentKey = desktopPetESnapshotContentKey(unversionedSnapshot);
    if (
      revisionRef.current.generation !== runtimeState.generation
      || revisionRef.current.contentKey !== contentKey
    ) {
      revisionRef.current = {
        generation: runtimeState.generation,
        contentKey,
        revision: revisionRef.current.generation === runtimeState.generation
          ? revisionRef.current.revision + 1
          : 1,
        generatedAt: Date.now(),
      };
    }
    return {
      ...unversionedSnapshot,
      revision: revisionRef.current.revision,
      generatedAt: revisionRef.current.generatedAt,
    };
  }, [runtimeState.generation, unversionedSnapshot]);
  snapshotRef.current = snapshot;

  const config = useMemo<DesktopPetEConfigPayload>(() => ({
    language,
    visible,
    settings,
    pet: selectedPet,
    labels: {
      openMain: t("desktopPet.actions.openMain"),
      openSettings: t("desktopPet.actions.openSettings"),
      idle: t("desktopPet.mood.idle"),
      working: t("desktopPet.mood.working"),
      waiting: t("desktopPet.mood.waiting"),
      success: t("desktopPet.mood.success"),
      error: t("desktopPet.mood.error"),
      sleeping: t("desktopPet.mood.sleeping"),
      "desktopPetE.renderer.taskStatus": t("desktopPetE.renderer.taskStatus"),
      "desktopPetE.renderer.running": t("desktopPetE.renderer.running"),
      "desktopPetE.renderer.actionNeeded": t("desktopPetE.renderer.actionNeeded"),
      "desktopPetE.renderer.failed": t("desktopPetE.renderer.failed"),
      "desktopPetE.renderer.stopped": t("desktopPetE.renderer.stopped"),
      "desktopPetE.renderer.otherTasks": t("desktopPetE.renderer.otherTasks"),
      "desktopPetE.renderer.collapse": t("desktopPetE.renderer.collapse"),
      "desktopPetE.renderer.expand": t("desktopPetE.renderer.expand"),
      "desktopPetE.renderer.noTasks": t("desktopPetE.renderer.noTasks"),
      "desktopPetE.renderer.sessionEnded": t("desktopPetE.renderer.sessionEnded"),
      "desktopPetE.renderer.respond": t("desktopPetE.renderer.respond"),
      "desktopPetE.renderer.open": t("desktopPetE.renderer.open"),
      "desktopPetE.renderer.clear": t("desktopPetE.renderer.clear"),
      "desktopPetE.renderer.terminal": t("desktopPetE.renderer.terminal"),
      "desktopPetE.renderer.submit": t("desktopPetE.renderer.submit"),
      "desktopPetE.renderer.retry": t("desktopPetE.renderer.retry"),
      "desktopPetE.renderer.submitting": t("desktopPetE.renderer.submitting"),
      "desktopPetE.renderer.typeAnswer": t("desktopPetE.renderer.typeAnswer"),
      "desktopPetE.renderer.optional": t("desktopPetE.renderer.optional"),
      "desktopPetE.renderer.selectPet": t("desktopPetE.renderer.selectPet"),
      "desktopPetE.renderer.close": t("desktopPetE.renderer.close"),
      "desktopPetE.renderer.actionFailed": t("desktopPetE.renderer.actionFailed"),
      "desktopPetE.approval.allow": t("desktopPetE.approval.allow"),
      "desktopPetE.approval.allowForSession": t("desktopPetE.approval.allowForSession"),
      "desktopPetE.approval.alwaysAllow": t("desktopPetE.approval.alwaysAllow"),
      "desktopPetE.approval.alwaysAllowLocal": t("desktopPetE.approval.alwaysAllowLocal"),
      "desktopPetE.approval.alwaysAllowProject": t("desktopPetE.approval.alwaysAllowProject"),
      "desktopPetE.approval.alwaysAllowUser": t("desktopPetE.approval.alwaysAllowUser"),
      "desktopPetE.approval.deny": t("desktopPetE.approval.deny"),
      "desktopPetE.approval.cancel": t("desktopPetE.approval.cancel"),
      "desktopPetE.agent.adapterUnavailable": t("desktopPetE.agent.adapterUnavailable"),
      "desktopPetE.agent.notificationOnly": t("desktopPetE.agent.notificationOnly"),
      "desktopPetE.agent.requestUnsupported": t("desktopPetE.agent.requestUnsupported"),
      "desktopPetE.agent.grokJumpOnly": t("desktopPetE.agent.grokJumpOnly"),
      "desktopPetE.agent.requestExpired": t("desktopPetE.agent.requestExpired"),
      "desktopPetE.agent.deliveryFailed": t("desktopPetE.agent.deliveryFailed"),
    },
  }), [language, selectedPet, settings, t, visible]);

  useEffect(() => {
    if (!appReady || !settingsLoaded || !isTauri()) return;
    let disposed = false;
    const refreshPets = () => {
      void invoke<InstalledPet[]>("desktop_pet_list_installed")
        .then((installed) => {
          if (!disposed) {
            setInstalledCodexPets(installed.filter(
              (pet) => pet.format === "codex" && pet.manifest.engine === "codex-sprite",
            ));
          }
        })
        .catch((error) => logWarn("Failed to resolve Desktop Pet E Codex pet", error));
    };
    refreshPets();
    window.addEventListener(DESKTOP_PET_E_PETS_CHANGED_EVENT, refreshPets);
    return () => {
      disposed = true;
      window.removeEventListener(DESKTOP_PET_E_PETS_CHANGED_EVENT, refreshPets);
    };
  }, [appReady, settingsLoaded]);

  useEffect(() => {
    if (!tracking || !settings.notificationsEnabled) {
      setNotification(null);
    }
  }, [settings.notificationsEnabled, tracking]);

  useEffect(() => {
    if (!appReady || !settingsLoaded || !isTauri()) return;
    let disposed = false;
    let clearTimer: number | null = null;
    const unlisten = listen<CliHookPayload>("claude-hook-notification", (event) => {
      if (disposed || !settingsRef.current.enabled || !settingsRef.current.notificationsEnabled) return;
      const payload = event.payload;
      if (!isDesktopPetEOrdinaryNotification(payload)) return;
      const now = Date.now();
      const parsedTimestamp = payload.timestamp ? Date.parse(payload.timestamp) : Number.NaN;
      const createdAt = Number.isFinite(parsedTimestamp)
        ? Math.min(parsedTimestamp, now)
        : now;
      const expiresAt = createdAt + DESKTOP_PET_E_NOTIFICATION_DURATION_MS;
      if (expiresAt <= now) return;
      const source = desktopPetENotificationSource(payload);
      const fallbackTitle = payload.event === "Stop"
        ? t("notifications.hookToast.finished")
        : payload.event === "StopFailure"
          ? t("notifications.hookToast.failed")
          : t("notifications.hookToast.attention");
      const title = payload.title?.trim() || fallbackTitle;
      const message = payload.message?.trim() || source;
      const nextNotification: DesktopPetENotification = {
        id: desktopPetENotificationId(payload),
        title: title.slice(0, 160),
        message: message.slice(0, 1_000),
        createdAt,
        expiresAt,
      };
      setNotification(nextNotification);
      if (clearTimer !== null) window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        if (!disposed) {
          setNotification((current) => current?.id === nextNotification.id ? null : current);
        }
      }, Math.max(0, expiresAt - now));
    });
    return () => {
      disposed = true;
      if (clearTimer !== null) window.clearTimeout(clearTimer);
      void unlisten.then((unlistenNotification) => unlistenNotification());
    };
  }, [appReady, settingsLoaded, t]);

  useEffect(() => {
    if (!tracking) return;
    const now = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const activityAt of Object.values(ptyOutputActivityAt)) {
      const expiresAt = activityAt + DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS;
      if (expiresAt > now) nextExpiry = Math.min(nextExpiry, expiresAt);
    }
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setActivityExpiryRevision((current) => current + 1),
      Math.max(16, nextExpiry - now + 50),
    );
    return () => window.clearTimeout(timer);
  }, [activityExpiryRevision, ptyOutputActivityAt, tracking]);

  useEffect(() => {
    if (!tracking || !isTauri()) {
      setBackgroundTasks((current) => current.length === 0 ? current : []);
      return;
    }
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await invoke<BackgroundPetTask[]>("pty_daemon_sessions");
        if (!disposed) {
          setBackgroundTasks((current) => sameBackgroundPetTasks(current, next) ? current : next);
        }
      } catch {
        if (!disposed) setBackgroundTasks((current) => current.length === 0 ? current : []);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [tracking]);

  const applyRuntimeState = (nextRuntimeState: DesktopPetERuntimeState) => {
    setRuntimeState(nextRuntimeState);
    replaceRuntimeState(nextRuntimeState);
    if (settingsRef.current.enabled && !nextRuntimeState.enabled) {
      const current = useSettingsStore.getState().desktopPetE;
      void useSettingsStore.getState().update("desktopPetE", { ...current, enabled: false })
        .catch((error) => logWarn("Failed to persist Desktop Pet E stopped state", error));
    }
  };

  useEffect(() => {
    if (!appReady || !settingsLoaded || !isTauri()) return;
    const syncPayload = {
      enabled: settings.enabled,
      existingDesktopPetEnabled,
      config,
      snapshot,
    };
    const syncKey = desktopPetESyncFingerprint(syncPayload);
    if (lastSyncKeyRef.current === syncKey) return;
    lastSyncKeyRef.current = syncKey;
    void invoke<DesktopPetERuntimeState>("desktop_pet_e_sync", {
      request: syncPayload,
    }).then(applyRuntimeState).catch((error) => {
      lastSyncKeyRef.current = null;
      logWarn("Failed to synchronize Desktop Pet E process", error);
    });
  }, [appReady, config, existingDesktopPetEnabled, replaceRuntimeState, settings.enabled, settingsLoaded, snapshot]);

  useEffect(() => {
    if (!appReady || !settingsLoaded || !isTauri()) return;
    const available = tracking
      && visible
      && runtimeState.ready
      && selectedPet !== null
      && settings.agentInteractionEnabled;
    let disposed = false;
    const publishAvailability = () => {
      void invoke("desktop_pet_e_agent_availability", {
        instanceId: instanceIdRef.current,
        available,
        acceptNew: available,
      }).catch((error) => {
        if (!disposed && available) {
          logWarn("Failed to publish Desktop Pet E agent availability", error);
        }
      });
    };
    publishAvailability();
    const timer = available ? window.setInterval(publishAvailability, 5000) : null;
    return () => {
      disposed = true;
      if (timer !== null) window.clearInterval(timer);
      if (available) {
        void invoke("desktop_pet_e_agent_availability", {
          instanceId: instanceIdRef.current,
          available: false,
          acceptNew: false,
        }).catch(() => undefined);
      }
    };
  }, [appReady, runtimeState.ready, selectedPet, settings.agentInteractionEnabled, settingsLoaded, tracking, visible]);

  const sendActionResult = (result: DesktopPetEActionResult) => invoke("desktop_pet_e_action_result", { result })
    .catch((error) => logWarn("Failed to send Desktop Pet E action result", error));

  useEffect(() => {
    if (!isTauri()) return;
    const unlistenAction = listen<unknown>(DESKTOP_PET_E_ACTION_EVENT, (event) => {
      const action = event.payload;
      const currentSnapshot = snapshotRef.current;
      if (
        !currentSnapshot
        || !isDesktopPetEChildAction(action)
        || action.snapshotRevision !== currentSnapshot.revision
      ) {
        return;
      }
      if (action.kind === "open-settings") {
        void invoke("app_show_main_window")
          .then(() => onOpenSettingsRef.current())
          .catch((error) => logWarn("Failed to open Desktop Pet E settings", error));
        return;
      }
      if (action.kind === "close-pet") {
        const current = useSettingsStore.getState().desktopPetE;
        void useSettingsStore.getState().update("desktopPetE", { ...current, enabled: false });
        return;
      }
      if (action.kind === "window-state") {
        const position = normalizeDesktopPetEPosition(action.position);
        if (!position || settingsRef.current.lockPosition) return;
        const current = useSettingsStore.getState().desktopPetE;
        void useSettingsStore.getState().update("desktopPetE", { ...current, position })
          .catch((error) => logWarn("Failed to persist Desktop Pet E position", error));
        return;
      }
      const task = currentSnapshot.tasks.find((item) => item.id === action.taskId);
      if (!task) return;
      if (action.kind === "submit-action") {
        if (
          task.pendingAction?.id !== action.pendingActionId
          || task.pendingAction.adapterMode !== "interactive"
          || !settingsRef.current.agentInteractionEnabled
        ) {
          void sendActionResult({
            actionId: action.actionId,
            accepted: false,
            confirmed: false,
            error: "desktopPetE.renderer.actionFailed",
          });
          return;
        }
        petSubmissionActionIdsRef.current.add(action.actionId);
        void useDesktopPetEAgentStore.getState().submit({
          pendingActionId: action.pendingActionId,
          transportActionId: action.actionId,
          answers: action.answers ?? [],
          approvalValue: action.approvalValue ?? null,
        }).then(() => sendActionResult({
          actionId: action.actionId,
          accepted: true,
          confirmed: false,
        })).catch((error) => {
          petSubmissionActionIdsRef.current.delete(action.actionId);
          logWarn("Failed to submit Desktop Pet E agent action", error);
          return sendActionResult({
            actionId: action.actionId,
            accepted: false,
            confirmed: false,
            error: "desktopPetE.renderer.actionFailed",
          });
        });
        return;
      }
      if (action.kind === "clear-task") {
        if (task.sessionAlive || (task.color !== "red" && task.color !== "blue")) return;
        setClearedTaskIds((current) => new Set(current).add(task.id));
        return;
      }
      if (action.kind !== "open-task" || !task.sessionAlive) return;
      void (async () => {
        if (task.daemonOnly) {
          const restored = await useTerminalStore.getState().attachDaemonSession(task.sessionId);
          if (!restored) return;
        }
        await onActivateSessionRef.current(task.sessionId);
        if (task.color === "red" || task.color === "blue") {
          setViewedTerminalTaskIds((current) => new Set(current).add(task.id));
        }
      })().catch((error) => logWarn("Failed to activate Desktop Pet E task", error));
    });
    const unlistenAgent = listen<unknown>(DESKTOP_PET_E_AGENT_EVENT, (event) => {
      if (!isDesktopPetEAgentEvent(event.payload)) return;
      const agentEvent = event.payload;
      const transportActionId = agentEvent.transportActionId;
      if (!transportActionId || !petSubmissionActionIdsRef.current.has(transportActionId)) return;
      if (agentEvent.phase === "resolved") {
        petSubmissionActionIdsRef.current.delete(transportActionId);
        void sendActionResult({
          actionId: transportActionId,
          accepted: true,
          confirmed: true,
        });
      } else if (agentEvent.phase === "failed" || agentEvent.phase === "cancelled") {
        petSubmissionActionIdsRef.current.delete(transportActionId);
        void sendActionResult({
          actionId: transportActionId,
          accepted: false,
          confirmed: false,
          error: agentEvent.error ?? "desktopPetE.agent.deliveryFailed",
        });
      }
    });
    const unlistenRuntime = listen<DesktopPetERuntimeState>(DESKTOP_PET_E_RUNTIME_STATE_EVENT, (event) => {
      applyRuntimeState(event.payload);
    });
    const unlistenDiagnostic = listen<unknown>(DESKTOP_PET_E_EVENT, (event) => {
      logWarn("Desktop Pet E diagnostic", event.payload);
    });
    return () => {
      void unlistenAction.then((unlisten) => unlisten());
      void unlistenAgent.then((unlisten) => unlisten());
      void unlistenRuntime.then((unlisten) => unlisten());
      void unlistenDiagnostic.then((unlisten) => unlisten());
    };
  }, []);

  return { snapshot, config, runtimeState, visible };
}
