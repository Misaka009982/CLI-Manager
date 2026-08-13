import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import {
  DESKTOP_PET_E_ACTION_EVENT,
  DESKTOP_PET_E_RUNTIME_STATE_EVENT,
  type DesktopPetEChildAction,
  type DesktopPetEConfigPayload,
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
  type BackgroundPetTask,
} from "../lib/desktopPet";
import { sameBackgroundPetTasks } from "../lib/desktopPetTransport";
import { useI18n } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import { useProjectStore } from "../stores/projectStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useTerminalStore } from "../stores/terminalStore";
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

function createInstanceId(): string {
  return `cli-manager-${crypto.randomUUID()}`;
}

function isDesktopPetEChildAction(value: unknown): value is DesktopPetEChildAction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const kinds = ["open-task", "clear-task", "submit-action", "open-settings", "close-pet", "window-state"];
  return typeof candidate.actionId === "string"
    && candidate.actionId.length > 0
    && typeof candidate.kind === "string"
    && kinds.includes(candidate.kind)
    && Number.isSafeInteger(candidate.snapshotRevision)
    && (candidate.snapshotRevision as number) >= 0;
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

export function useDesktopPetECoordinator({
  appReady,
  terminalFullscreen,
  onOpenSettings,
  onActivateSession,
}: UseDesktopPetECoordinatorOptions) {
  const { language, t } = useI18n();
  const settings = useSettingsStore((state) => state.desktopPetE);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
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
  const [activityExpiryRevision, setActivityExpiryRevision] = useState(0);
  const [runtimeState, setRuntimeState] = useState<DesktopPetERuntimeState>(EMPTY_RUNTIME_STATE);
  const [viewedTerminalTaskIds, setViewedTerminalTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [clearedTaskIds, setClearedTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const instanceIdRef = useRef<string>(createInstanceId());
  const terminalHistoryRef = useRef<DesktopPetETaskCandidate[]>([]);
  const revisionRef = useRef({ generation: -1, contentKey: "", revision: 0, generatedAt: Date.now() });
  const settingsRef = useRef(settings);
  const snapshotRef = useRef<DesktopPetESnapshot | null>(null);
  const onOpenSettingsRef = useRef(onOpenSettings);
  const onActivateSessionRef = useRef(onActivateSession);
  settingsRef.current = settings;
  onOpenSettingsRef.current = onOpenSettings;
  onActivateSessionRef.current = onActivateSession;

  const tracking = appReady && settingsLoaded && settings.enabled;
  const visible = tracking && !(settings.autoHideFullscreen && terminalFullscreen);

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
    tabNotifications,
    tabStatusDetails,
    ptyOutputActivityAt,
    backgroundTasks,
  }), [
    activeSessionId,
    activityExpiryRevision,
    backgroundTasks,
    persistedSessions,
    projects,
    ptyOutputActivityAt,
    runtimeState.generation,
    sessionStatuses,
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
  }, activeSessionId), [
    activeSessionId,
    candidates,
    clearedTaskIds,
    runtimeState.generation,
    viewedTerminalTaskIds,
  ]);

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
  const snapshot: DesktopPetESnapshot = {
    ...unversionedSnapshot,
    revision: revisionRef.current.revision,
    generatedAt: revisionRef.current.generatedAt,
  };
  snapshotRef.current = snapshot;

  const config = useMemo<DesktopPetEConfigPayload>(() => ({
    language,
    visible,
    settings,
    labels: {
      openMain: t("desktopPet.actions.openMain"),
      openSettings: t("desktopPet.actions.openSettings"),
      idle: t("desktopPet.mood.idle"),
      working: t("desktopPet.mood.working"),
      waiting: t("desktopPet.mood.waiting"),
      success: t("desktopPet.mood.success"),
      error: t("desktopPet.mood.error"),
      sleeping: t("desktopPet.mood.sleeping"),
    },
  }), [language, settings, t, visible]);

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
    const unlistenRuntime = listen<DesktopPetERuntimeState>(DESKTOP_PET_E_RUNTIME_STATE_EVENT, (event) => {
      setRuntimeState(event.payload);
    });
    return () => {
      void unlistenAction.then((unlisten) => unlisten());
      void unlistenRuntime.then((unlisten) => unlisten());
    };
  }, []);

  return { snapshot, config, runtimeState, visible };
}
