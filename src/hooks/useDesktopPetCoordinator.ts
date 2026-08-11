import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import {
  DESKTOP_PET_BUBBLE_EMPTY_EVENT,
  DESKTOP_PET_BUBBLE_READY_EVENT,
  DESKTOP_PET_BUBBLE_WINDOW_LABEL,
  DESKTOP_PET_CLOSE_MENU_EVENT,
  DESKTOP_PET_CONFIG_EVENT,
  DESKTOP_PET_COORDINATOR_READY_EVENT,
  DESKTOP_PET_DECISION_RESOLVE_EVENT,
  DESKTOP_PET_DECISION_RESULT_EVENT,
  DESKTOP_PET_INCIDENT_ACK_EVENT,
  DESKTOP_PET_HIDDEN_EVENT,
  DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS,
  DESKTOP_PET_OPEN_SETTINGS_EVENT,
  DESKTOP_PET_OPEN_TARGET_EVENT,
  DESKTOP_PET_POSITION_EVENT,
  DESKTOP_PET_READY_EVENT,
  DESKTOP_PET_SIZE_CHANGE_EVENT,
  DESKTOP_PET_SNAPSHOT_EVENT,
  DESKTOP_PET_WINDOW_LABEL,
  buildDesktopPetLabels,
  deriveDesktopPetSnapshot,
  desktopPetScale,
  normalizeDesktopPetSizePercent,
  type BackgroundPetTask,
  type DesktopPetBubbleEmptyPayload,
  type DesktopPetConfigPayload,
  type DesktopPetDecisionAnswer,
  type DesktopPetHiddenPayload,
  type DesktopPetOpenSettingsPayload,
  type DesktopPetOpenTargetPayload,
  type DesktopPetPositionPayload,
  type DesktopPetSizeChangePayload,
  type DesktopPetSnapshot,
  type DesktopPetSurfaceReadyPayload,
  type InstalledPet,
} from "../lib/desktopPet";
import {
  commitDesktopPetDeliveryPlan,
  createDesktopPetDeliveryPlan,
  createDesktopPetLifecycleToken,
  createDesktopPetSurfaceEventPayload,
  desktopPetLifecycleTokenMatches,
  desktopPetSnapshotFingerprint,
  executeDesktopPetDeliveryPlan,
  nextDesktopPetDeliveryRevision,
  sameBackgroundPetTasks,
  shouldAcceptDesktopPetSurfaceEpoch,
  type DesktopPetDeliveryFingerprintState,
} from "../lib/desktopPetTransport";
import {
  DESKTOP_PET_COMPANION_PROTOCOL_VERSION,
  DESKTOP_PET_COMPANION_STATUS_EVENT,
  type DesktopPetCompanionActionResultMessage,
  type DesktopPetCompanionGeneration,
  type DesktopPetCompanionStatus,
  type DesktopPetCompanionStatusEvent,
  type DesktopPetCompanionSyncMessage,
} from "../lib/desktopPetCompanion";
import {
  deriveDesktopPetBubbleContent,
  updateDesktopPetActiveCompletionId,
} from "../lib/desktopPetBubble";
import { debugConsoleInfo } from "../lib/debugConsole";
import { useI18n } from "../lib/i18n";
import { logWarn } from "../lib/logger";
import { useProjectStore } from "../stores/projectStore";
import { useSessionStore } from "../stores/sessionStore";
import {
  BUILTIN_DESKTOP_PET_ID,
  useSettingsStore,
} from "../stores/settingsStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useWorktreeStore } from "../stores/worktreeStore";
import { useRemoteHandoffStore } from "../stores/remoteHandoffStore";
import { useDesktopPetAlertStore } from "../stores/desktopPetAlertStore";
import { useSshHostStore } from "../stores/sshHostStore";

interface DesktopPetDecisionResolvePayload {
  requestId: string;
  brokerEpoch: string;
  lifecycleToken: string;
  bubbleSurfaceEpoch: string;
  answer: DesktopPetDecisionAnswer;
}

interface DesktopPetIncidentAckPayload {
  incidentId: string;
  lifecycleToken: string;
  bubbleSurfaceEpoch: string;
}

interface UseDesktopPetCoordinatorOptions {
  appReady: boolean;
  terminalFullscreen: boolean;
  onOpenSettings: () => void;
  onActivateSession: (sessionId: string) => Promise<void>;
}

export function useDesktopPetCoordinator({
  appReady,
  terminalFullscreen,
  onOpenSettings,
  onActivateSession,
}: UseDesktopPetCoordinatorOptions) {
  const { language } = useI18n();
  const desktopPet = useSettingsStore((state) => state.desktopPet);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const updateSetting = useSettingsStore((state) => state.update);
  const projects = useProjectStore((state) => state.projects);
  const worktrees = useWorktreeStore((state) => state.worktrees);
  const remoteHandoffStatus = useRemoteHandoffStore((state) => state.status);
  const remoteHandoffPlatforms = useRemoteHandoffStore((state) => state.platforms);
  const remoteHandoffBusy = useRemoteHandoffStore((state) => state.busy);
  const sshHosts = useSshHostStore((state) => state.hosts);
  const sshHostsLoaded = useSshHostStore((state) => state.loaded);
  const persistedSessions = useSessionStore((state) => state.sessions);
  const {
    sessions,
    activeSessionId,
    sessionStatuses,
    tabNotifications,
    tabStatusDetails,
    ptyOutputActivityAt,
  } = useTerminalStore(
    useShallow((state) => ({
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
      sessionStatuses: state.sessionStatuses,
      tabNotifications: state.tabNotifications,
      tabStatusDetails: state.tabStatusDetails,
      ptyOutputActivityAt: state.ptyOutputActivityAt,
    }))
  );
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundPetTask[]>([]);
  const [activityExpiryRevision, setActivityExpiryRevision] = useState(0);
  const [dismissedCompletionId, setDismissedCompletionId] = useState<string | null>(null);
  const [activeCompletionId, setActiveCompletionId] = useState<string | null>(null);
  const [temporarilyHidden, setTemporarilyHidden] = useState(false);
  const [lifecycleToken, setLifecycleToken] = useState("");
  const [companionActive, setCompanionActive] = useState(false);
  const [companionBlocked, setCompanionBlocked] = useState(false);
  const [companionStatusListening, setCompanionStatusListening] = useState(false);
  const [companionPet, setCompanionPet] = useState<InstalledPet | null>(null);
  const decisionRequests = useDesktopPetAlertStore((state) => state.decisionRequests);
  const incidents = useDesktopPetAlertStore((state) => state.incidents);
  const hasActionablePetItem = decisionRequests.length > 0 || incidents.length > 0;
  const companionRequested = desktopPet.runtime === "electron";
  const companionShouldRun = appReady
    && settingsLoaded
    && companionRequested
    && (desktopPet.enabled || hasActionablePetItem);
  const petWindowVisible = appReady
    && settingsLoaded
    && (hasActionablePetItem || (desktopPet.enabled && !temporarilyHidden))
    && !(desktopPet.autoHideFullscreen && terminalFullscreen && !hasActionablePetItem);
  const tauriPetWindowVisible = petWindowVisible && !companionActive;

  useEffect(() => {
    if (!desktopPet.enabled) setTemporarilyHidden(false);
  }, [desktopPet.enabled]);

  useEffect(() => {
    if (!appReady || sshHostsLoaded || !projects.some((project) => project.environment_type === "ssh")) {
      return;
    }
    void useSshHostStore.getState().fetchHosts().catch((error) => {
      logWarn("Failed to load SSH hosts for desktop pet handoff", error);
    });
  }, [appReady, projects, sshHostsLoaded]);

  useEffect(() => {
    if (!petWindowVisible) return;
    const now = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const activityAt of Object.values(ptyOutputActivityAt)) {
      const expiresAt = activityAt + DESKTOP_PET_OUTPUT_ACTIVITY_TTL_MS;
      if (expiresAt > now) nextExpiry = Math.min(nextExpiry, expiresAt);
    }
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setActivityExpiryRevision((revision) => revision + 1),
      Math.max(16, nextExpiry - now + 50)
    );
    return () => window.clearTimeout(timer);
  }, [activityExpiryRevision, petWindowVisible, ptyOutputActivityAt]);

  const snapshot = useMemo(
    () => deriveDesktopPetSnapshot({
      sessions,
      persistedSessions,
      activeSessionId,
      sessionStatuses,
      tabNotifications,
      tabStatusDetails,
      ptyOutputActivityAt,
      projects,
      worktrees,
      sshHosts,
      backgroundTasks,
      agentSessionsOnly: desktopPet.agentSessionsOnly,
      activeHandoff: remoteHandoffStatus.info,
      handoffBusy: remoteHandoffBusy,
      now: Date.now(),
    }),
    [
      activeSessionId,
      activityExpiryRevision,
      backgroundTasks,
      desktopPet.agentSessionsOnly,
      persistedSessions,
      projects,
      ptyOutputActivityAt,
      remoteHandoffBusy,
      remoteHandoffStatus.info,
      sessions,
      sessionStatuses,
      sshHosts,
      tabNotifications,
      tabStatusDetails,
      worktrees,
    ]
  );

  const publicSnapshot = useMemo<DesktopPetSnapshot>(() => {
    const tabIdsByCliSessionId = new Map<string, string[]>();
    for (const session of sessions) {
      const cliSessionId = session.cliSessionId?.trim();
      if (!cliSessionId) continue;
      const tabIds = tabIdsByCliSessionId.get(cliSessionId) ?? [];
      tabIds.push(session.id);
      tabIdsByCliSessionId.set(cliSessionId, tabIds);
    }
    const targetIdsFor = (item: { tabId: string; sessionId: string | null }) => [
      item.tabId,
      ...(item.sessionId ? tabIdsByCliSessionId.get(item.sessionId) ?? [] : []),
    ];
    const decisionTargetIds = new Set(decisionRequests.flatMap(targetIdsFor));
    const publicIncidents = incidents.map((incident) => {
      const targetIds = targetIdsFor(incident);
      const matchingTarget = snapshot.targets.find((target) => targetIds.includes(target.sessionId));
      const matchesOpenSession = sessions.some((session) => targetIds.includes(session.id));
      const matchesBackgroundTask = backgroundTasks.some((task) => targetIds.includes(task.sessionId));
      let daemonOnly = incident.daemonOnly;
      if (matchingTarget) {
        daemonOnly = matchingTarget.daemonOnly;
      } else if (matchesOpenSession) {
        daemonOnly = false;
      } else if (matchesBackgroundTask) {
        daemonOnly = true;
      }
      return incident.daemonOnly !== daemonOnly
        ? { ...incident, daemonOnly }
        : incident;
    });
    const latestIncidentAtByTargetId = new Map<string, number>();
    for (const incident of publicIncidents) {
      for (const targetId of targetIdsFor(incident)) {
        latestIncidentAtByTargetId.set(
          targetId,
          Math.max(latestIncidentAtByTargetId.get(targetId) ?? 0, incident.createdAt)
        );
      }
    }
    const targets = snapshot.targets.filter((target) => {
      if (decisionTargetIds.has(target.sessionId)) return false;
      const incidentAt = latestIncidentAtByTargetId.get(target.sessionId);
      if (incidentAt === undefined) return true;
      return target.status !== "failed" && incidentAt < target.updatedAt;
    });
    const statusCounts = {
      green: targets.filter((target) => target.status === "running").length,
      red: publicIncidents.length + targets.filter((target) => target.status === "failed").length,
      blue: decisionRequests.length
        + targets.filter((target) => target.status === "attention" || target.status === "done").length,
    };
    const selectedTarget = targets[0] ?? null;
    let mood: DesktopPetSnapshot["mood"] = "sleeping";
    if (statusCounts.red > 0) {
      mood = "error";
    } else if (decisionRequests.length > 0) {
      mood = "waiting";
    } else if (selectedTarget) {
      const moodByStatus: Record<typeof selectedTarget.status, DesktopPetSnapshot["mood"]> = {
        none: "idle",
        running: "working",
        attention: "waiting",
        done: "success",
        failed: "error",
      };
      mood = moodByStatus[selectedTarget.status];
    }
    return {
      ...snapshot,
      mood,
      statusCounts,
      targets,
      sessionId: selectedTarget?.sessionId ?? null,
      daemonOnly: selectedTarget?.daemonOnly ?? false,
      updatedAt: selectedTarget?.updatedAt ?? snapshot.updatedAt,
      runningCount: statusCounts.green,
      attentionCount: decisionRequests.length
        + targets.filter((target) => target.status === "attention").length,
      decisionRequests,
      incidents: publicIncidents,
      handoffPlatforms: remoteHandoffPlatforms,
      sessionTitle: desktopPet.showSessionName ? selectedTarget?.sessionTitle ?? null : null,
      projectName: desktopPet.showSessionName ? selectedTarget?.projectName ?? null : null,
    };
  }, [
    backgroundTasks,
    decisionRequests,
    desktopPet.showSessionName,
    incidents,
    remoteHandoffPlatforms,
    sessions,
    snapshot,
  ]);

  const bubbleContent = useMemo(
    () => deriveDesktopPetBubbleContent(publicSnapshot),
    [publicSnapshot]
  );

  useEffect(() => {
    setActiveCompletionId((current) => (
      petWindowVisible
        ? updateDesktopPetActiveCompletionId(
            current,
            bubbleContent.completion,
            dismissedCompletionId,
            Date.now()
          )
        : null
    ));
  }, [
    bubbleContent.completion?.id,
    bubbleContent.completion?.updatedAt,
    dismissedCompletionId,
    petWindowVisible,
  ]);

  const bubbleWindowVisible = useMemo(() => {
    const completionVisible = Boolean(
      bubbleContent.completion
        && bubbleContent.completion.id === activeCompletionId
        && bubbleContent.completion.id !== dismissedCompletionId
    );
    return petWindowVisible
      && (
        bubbleContent.decisions.length > 0
        || bubbleContent.incidents.length > 0
        || completionVisible
      );
  }, [
    activeCompletionId,
    bubbleContent.completion,
    bubbleContent.decisions.length,
    bubbleContent.incidents.length,
    dismissedCompletionId,
    petWindowVisible,
  ]);

  const tauriBubbleWindowVisible = bubbleWindowVisible && !companionActive;
  const configPayload = useMemo<DesktopPetConfigPayload>(() => ({
    language,
    visible: tauriPetWindowVisible,
    bubbleVisible: tauriBubbleWindowVisible,
    lifecycleToken,
    settings: desktopPet,
    labels: buildDesktopPetLabels(language),
  }), [
    desktopPet,
    language,
    lifecycleToken,
    tauriBubbleWindowVisible,
    tauriPetWindowVisible,
  ]);
  const companionConfigPayload = useMemo<DesktopPetConfigPayload>(() => ({
    ...configPayload,
    visible: petWindowVisible,
    bubbleVisible: bubbleWindowVisible,
  }), [bubbleWindowVisible, configPayload, petWindowVisible]);

  const configPayloadRef = useRef(configPayload);
  const publicSnapshotRef = useRef(publicSnapshot);
  const deliveryFingerprintRef = useRef<DesktopPetDeliveryFingerprintState>({
    configKey: null,
    snapshotKey: null,
  });
  const stateSendInFlightRef = useRef(false);
  const stateSendPendingRef = useRef(false);
  const stateSendForceRef = useRef(false);
  const deliveryStatsRef = useRef({ requests: 0, emitted: 0, skipped: 0, coalesced: 0 });
  const deliveryRevisionRef = useRef(0);
  const companionDeliveryRevisionRef = useRef(0);
  const companionActiveRef = useRef(companionActive);
  const companionRequestedRef = useRef(companionRequested);
  const companionShouldRunRef = useRef(companionShouldRun);
  const onActivateSessionRef = useRef(onActivateSession);
  const onOpenSettingsRef = useRef(onOpenSettings);
  const updateSettingRef = useRef(updateSetting);
  const petAppliedWindowConfigKeyRef = useRef<string | null>(null);
  const petNativeGeometryKeyRef = useRef<string | null>(null);
  const petWindowVisibleRef = useRef(petWindowVisible);
  const bubbleWindowVisibleRef = useRef(bubbleWindowVisible);
  const lifecycleTokenRef = useRef(lifecycleToken);
  const bubbleCompletionIdRef = useRef<string | null>(bubbleContent.completion?.id ?? null);
  const nativeVisibilityKeyRef = useRef<string | null>(null);
  const petSurfaceEpochRef = useRef<string | null>(null);
  const bubbleSurfaceEpochRef = useRef<string | null>(null);
  const petSurfaceEpochsSeenRef = useRef(new Set<string>());
  const bubbleSurfaceEpochsSeenRef = useRef(new Set<string>());
  const lastActionableItemIdsRef = useRef<Set<string>>(new Set());
  const windowSyncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const nativeSyncRetryTimerRef = useRef<number | null>(null);
  const stateSendRetryTimerRef = useRef<number | null>(null);
  const synchronizeDesktopPetWindowRef = useRef<
    (closeMenu?: boolean) => Promise<string | null>
  >(async () => null);
  const sendStateRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  configPayloadRef.current = {
    ...configPayload,
    lifecycleToken: lifecycleTokenRef.current || configPayload.lifecycleToken,
  };
  publicSnapshotRef.current = publicSnapshot;
  onActivateSessionRef.current = onActivateSession;
  onOpenSettingsRef.current = onOpenSettings;
  updateSettingRef.current = updateSetting;
  petWindowVisibleRef.current = tauriPetWindowVisible;
  bubbleWindowVisibleRef.current = tauriBubbleWindowVisible;
  bubbleCompletionIdRef.current = bubbleContent.completion?.id ?? null;
  companionActiveRef.current = companionActive;
  companionRequestedRef.current = companionRequested;
  companionShouldRunRef.current = companionShouldRun;

  const synchronizeDesktopPetWindow = useCallback(
    (closeMenu = true): Promise<string | null> => {
      const run = windowSyncQueueRef.current.catch(() => {}).then(async () => {
        const settingsState = useSettingsStore.getState();
        if (!settingsState.loaded) return null;
        const current = settingsState.desktopPet;
        const token = createDesktopPetLifecycleToken();
        const petVisible = petWindowVisibleRef.current;
        const bubbleVisible = bubbleWindowVisibleRef.current;
        if (closeMenu) {
          await emitTo(DESKTOP_PET_WINDOW_LABEL, DESKTOP_PET_CLOSE_MENU_EVENT);
        }
        await invoke("desktop_pet_window_sync", {
          config: {
            enabled: petVisible,
            bubbleEnabled: bubbleVisible,
            alwaysOnTop: current.alwaysOnTop,
            syncPetGeometry: closeMenu,
            scale: desktopPetScale(current.size),
            position: current.position,
            lifecycleToken: token,
            petSurfaceEpoch: petSurfaceEpochRef.current,
            bubbleSurfaceEpoch: bubbleSurfaceEpochRef.current,
          },
        });
        if (nativeSyncRetryTimerRef.current !== null) {
          window.clearTimeout(nativeSyncRetryTimerRef.current);
          nativeSyncRetryTimerRef.current = null;
        }

        if (closeMenu) {
          petNativeGeometryKeyRef.current = desktopPetNativeGeometryKey(
            current.size,
            current.position,
            current.alwaysOnTop,
            petVisible
          );
        }
        lifecycleTokenRef.current = token;
        nativeVisibilityKeyRef.current = desktopPetVisibilityKey(petVisible, bubbleVisible);
        deliveryFingerprintRef.current = {
          ...deliveryFingerprintRef.current,
          snapshotKey: null,
        };
        configPayloadRef.current = {
          ...configPayloadRef.current,
          visible: petVisible,
          bubbleVisible,
          lifecycleToken: token,
          settings: current,
        };
        setLifecycleToken(token);
        return token;
      });
      const scheduledRun = run.catch((error) => {
        if (nativeSyncRetryTimerRef.current === null) {
          nativeSyncRetryTimerRef.current = window.setTimeout(() => {
            nativeSyncRetryTimerRef.current = null;
            void synchronizeDesktopPetWindowRef.current(closeMenu)
              .then((token) => token ? sendStateRef.current(true) : undefined)
              .catch((retryError) => {
                logWarn("Failed to retry desktop pet native synchronization", retryError);
              });
          }, 1_000);
        }
        throw error;
      });
      windowSyncQueueRef.current = scheduledRun.then(() => undefined, () => undefined);
      return scheduledRun;
    },
    []
  );
  synchronizeDesktopPetWindowRef.current = synchronizeDesktopPetWindow;

  const sendState = useCallback(async (force = false) => {
    const stats = deliveryStatsRef.current;
    stats.requests += 1;
    stateSendPendingRef.current = true;
    stateSendForceRef.current = stateSendForceRef.current || force;
    if (stateSendInFlightRef.current) {
      stats.coalesced += 1;
      return;
    }

    stateSendInFlightRef.current = true;
    try {
      while (stateSendPendingRef.current) {
        stateSendPendingRef.current = false;
        const forceNext = stateSendForceRef.current;
        stateSendForceRef.current = false;
        const currentConfig = configPayloadRef.current;
        const currentSnapshot = publicSnapshotRef.current;
        const currentVisibilityKey = desktopPetVisibilityKey(
          currentConfig.visible,
          currentConfig.bubbleVisible
        );
        if (
          !desktopPetLifecycleTokenMatches(
            lifecycleTokenRef.current || null,
            currentConfig.lifecycleToken
          )
          || nativeVisibilityKeyRef.current !== currentVisibilityKey
        ) {
          stateSendPendingRef.current = true;
          stateSendForceRef.current = stateSendForceRef.current || forceNext;
          break;
        }

        if (forceNext && !currentConfig.visible) {
          deliveryFingerprintRef.current = {
            ...deliveryFingerprintRef.current,
            snapshotKey: null,
          };
        }
        const configKey = JSON.stringify(currentConfig);
        const snapshotKey = desktopPetSnapshotFingerprint(currentSnapshot);
        const plan = createDesktopPetDeliveryPlan({
          force: forceNext,
          petVisible: currentConfig.visible,
          bubbleVisible: currentConfig.bubbleVisible,
          configKey,
          snapshotKey,
          previous: deliveryFingerprintRef.current,
        });
        if (plan.configTargets.length === 0 && plan.snapshotTargets.length === 0) {
          stats.skipped += 1;
          continue;
        }

        const deliveryRevision = nextDesktopPetDeliveryRevision(
          deliveryRevisionRef.current
        );
        deliveryRevisionRef.current = deliveryRevision;
        const surfaceEpochFor = (target: "desktop-pet" | "desktop-pet-bubble") => (
          target === DESKTOP_PET_WINDOW_LABEL
            ? petSurfaceEpochRef.current
            : bubbleSurfaceEpochRef.current
        );
        const assertCurrentDelivery = () => {
          if (
            lifecycleTokenRef.current !== currentConfig.lifecycleToken
            || nativeVisibilityKeyRef.current !== currentVisibilityKey
          ) {
            throw new Error("desktop_pet_delivery_generation_stale");
          }
        };
        try {
          // 隐藏表面必须先消费清空配置，随后才可保留任何新快照。
          await executeDesktopPetDeliveryPlan(
            plan,
            (target) => {
              assertCurrentDelivery();
              return emitTo(
                target,
                DESKTOP_PET_CONFIG_EVENT,
                createDesktopPetSurfaceEventPayload(
                  currentConfig,
                  currentConfig.lifecycleToken,
                  surfaceEpochFor(target),
                  deliveryRevision
                )
              );
            },
            (target) => {
              assertCurrentDelivery();
              return emitTo(
                target,
                DESKTOP_PET_SNAPSHOT_EVENT,
                createDesktopPetSurfaceEventPayload(
                  currentSnapshot,
                  currentConfig.lifecycleToken,
                  surfaceEpochFor(target),
                  deliveryRevision
                )
              );
            }
          );
          deliveryFingerprintRef.current = commitDesktopPetDeliveryPlan(
            deliveryFingerprintRef.current,
            plan,
            true
          );
          if (stateSendRetryTimerRef.current !== null) {
            window.clearTimeout(stateSendRetryTimerRef.current);
            stateSendRetryTimerRef.current = null;
          }
          stats.emitted += plan.configTargets.length + plan.snapshotTargets.length;
        } catch {
          deliveryFingerprintRef.current = commitDesktopPetDeliveryPlan(
            deliveryFingerprintRef.current,
            plan,
            false
          );
          stateSendPendingRef.current = true;
          stateSendForceRef.current = stateSendForceRef.current || forceNext;
          if (stateSendRetryTimerRef.current === null) {
            stateSendRetryTimerRef.current = window.setTimeout(() => {
              stateSendRetryTimerRef.current = null;
              void sendStateRef.current(true);
            }, 1_000);
          }
          break;
        }
      }
    } finally {
      stateSendInFlightRef.current = false;
      if (stats.requests % 120 === 0) {
        debugConsoleInfo("[desktop-pet:delivery]", { ...stats });
      }
    }
  }, []);
  sendStateRef.current = sendState;

  useEffect(() => {
    let disposed = false;
    const unlistenStatus = listen<DesktopPetCompanionStatusEvent>(
      DESKTOP_PET_COMPANION_STATUS_EVENT,
      (event) => {
        if (event.payload.protocolVersion !== DESKTOP_PET_COMPANION_PROTOCOL_VERSION) {
          setCompanionActive(false);
          setCompanionBlocked(true);
          return;
        }
        if (event.payload.status === "ready") {
          if (companionRequestedRef.current && companionShouldRunRef.current) {
            setCompanionBlocked(false);
            setCompanionActive(true);
          } else {
            setCompanionActive(false);
            void invoke("desktop_pet_companion_stop").catch((error) => {
              logWarn("Failed to stop stale desktop pet companion", error);
            });
          }
          return;
        }
        setCompanionActive(false);
        if (event.payload.status === "fallback") {
          setCompanionBlocked(companionRequestedRef.current);
        }
      }
    ).then((unlisten) => {
      if (disposed) {
        unlisten();
        return null;
      }
      setCompanionStatusListening(true);
      return unlisten;
    }).catch((error) => {
      if (!disposed) {
        logWarn("Failed to listen for desktop pet companion status", error);
      }
      return null;
    });
    return () => {
      disposed = true;
      void unlistenStatus.then((unlisten) => unlisten?.());
    };
  }, []);

  useEffect(() => {
    if (companionRequested) {
      setCompanionBlocked(false);
      return;
    }
    if (!companionActiveRef.current) {
      setCompanionActive(false);
      return;
    }
    void invoke("desktop_pet_companion_stop")
      .then(() => setCompanionActive(false))
      .catch((error) => {
        logWarn("Failed to stop desktop pet companion after runtime switch", error);
      });
  }, [companionRequested]);

  useEffect(() => {
    if (!companionRequested || desktopPet.petId === BUILTIN_DESKTOP_PET_ID) {
      setCompanionPet(null);
      return;
    }
    let disposed = false;
    setCompanionPet(null);
    void invoke<InstalledPet | null>("desktop_pet_get_installed", {
      petId: desktopPet.petId,
    }).then((pet) => {
      if (!disposed) setCompanionPet(pet);
    }).catch((error) => {
      if (!disposed) setCompanionPet(null);
      logWarn("Failed to resolve desktop pet companion artwork", error);
    });
    return () => {
      disposed = true;
    };
  }, [companionRequested, desktopPet.petId]);

  useEffect(() => {
    // 先建立状态监听，避免快速启动的 companion 在监听注册完成前发出唯一的 ready 事件。
    if (!appReady || !settingsLoaded || !companionRequested || !companionStatusListening) return;
    if (!companionShouldRun) {
      if (companionActiveRef.current) {
        void invoke("desktop_pet_companion_stop")
          .then(() => setCompanionActive(false))
          .catch((error) => {
            logWarn("Failed to stop idle desktop pet companion", error);
          });
      }
      return;
    }
    if (companionBlocked) return;
    const currentLifecycleToken = lifecycleTokenRef.current;
    const petSurfaceEpoch = petSurfaceEpochRef.current;
    const bubbleSurfaceEpoch = bubbleSurfaceEpochRef.current;
    if (!currentLifecycleToken || !petSurfaceEpoch || !bubbleSurfaceEpoch) return;

    const generation: DesktopPetCompanionGeneration = {
      lifecycleToken: currentLifecycleToken,
      petSurfaceEpoch,
      bubbleSurfaceEpoch,
    };
    const deliveryRevision = nextDesktopPetDeliveryRevision(
      companionDeliveryRevisionRef.current
    );
    companionDeliveryRevisionRef.current = deliveryRevision;
    const request: DesktopPetCompanionSyncMessage = {
      protocolVersion: DESKTOP_PET_COMPANION_PROTOCOL_VERSION,
      kind: "sync",
      generation,
      deliveryRevision,
      config: {
        ...companionConfigPayload,
        lifecycleToken: currentLifecycleToken,
      },
      snapshot: publicSnapshot,
      pet: companionPet,
    };
    let disposed = false;
    void invoke<DesktopPetCompanionStatus>("desktop_pet_companion_sync", { request })
      .then((status) => {
        if (disposed) return;
        if (
          status.active
          && status.protocolVersion === DESKTOP_PET_COMPANION_PROTOCOL_VERSION
        ) {
          if (companionRequestedRef.current && companionShouldRunRef.current) {
            setCompanionBlocked(false);
            setCompanionActive(true);
          } else {
            setCompanionActive(false);
            void invoke("desktop_pet_companion_stop").catch((error) => {
              logWarn("Failed to stop stale desktop pet companion synchronization", error);
            });
          }
          return;
        }
        setCompanionActive(false);
        setCompanionBlocked(companionRequestedRef.current);
        if (status.reason) {
          logWarn("Desktop pet companion unavailable; using Tauri fallback", status.reason);
        }
      })
      .catch((error) => {
        if (disposed) return;
        setCompanionActive(false);
        setCompanionBlocked(companionRequestedRef.current);
        logWarn("Desktop pet companion synchronization failed; using Tauri fallback", error);
      });
    return () => {
      disposed = true;
    };
  }, [
    appReady,
    companionBlocked,
    companionConfigPayload,
    companionPet,
    companionRequested,
    companionShouldRun,
    companionStatusListening,
    lifecycleToken,
    publicSnapshot,
    settingsLoaded,
  ]);

  useEffect(() => () => {
    if (nativeSyncRetryTimerRef.current !== null) {
      window.clearTimeout(nativeSyncRetryTimerRef.current);
      nativeSyncRetryTimerRef.current = null;
    }
    if (stateSendRetryTimerRef.current !== null) {
      window.clearTimeout(stateSendRetryTimerRef.current);
      stateSendRetryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!petWindowVisible) {
      setBackgroundTasks((current) => (current.length === 0 ? current : []));
      return;
    }
    let disposed = false;
    const refresh = async () => {
      try {
        const tasks = await invoke<BackgroundPetTask[]>("pty_daemon_sessions");
        if (!disposed) {
          setBackgroundTasks((current) => (
            sameBackgroundPetTasks(current, tasks) ? current : tasks
          ));
        }
      } catch {
        if (!disposed) {
          setBackgroundTasks((current) => (current.length === 0 ? current : []));
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [petWindowVisible]);

  useEffect(() => {
    if (!appReady || !settingsLoaded) return;
    const geometryKey = desktopPetNativeGeometryKey(
      desktopPet.size,
      desktopPet.position,
      desktopPet.alwaysOnTop,
      tauriPetWindowVisible
    );
    const visibilityKey = desktopPetVisibilityKey(
      tauriPetWindowVisible,
      tauriBubbleWindowVisible
    );
    const geometryAlreadyApplied = petAppliedWindowConfigKeyRef.current === geometryKey;
    if (geometryAlreadyApplied) {
      petAppliedWindowConfigKeyRef.current = null;
      petNativeGeometryKeyRef.current = geometryKey;
      if (nativeVisibilityKeyRef.current === visibilityKey) return;
    }
    const syncPetGeometry = petNativeGeometryKeyRef.current !== geometryKey;
    void (async () => {
      await synchronizeDesktopPetWindow(syncPetGeometry);
      await sendState(true);
    })().catch((err) => {
      logWarn("Failed to synchronize desktop pet windows", err);
    });
  }, [
    appReady,
    desktopPet.alwaysOnTop,
    desktopPet.position,
    desktopPet.size,
    sendState,
    settingsLoaded,
    synchronizeDesktopPetWindow,
    tauriBubbleWindowVisible,
    tauriPetWindowVisible,
  ]);

  useEffect(() => {
    if (!appReady || !settingsLoaded) return;
    void sendState();
  }, [appReady, configPayload, publicSnapshot, sendState, settingsLoaded]);

  useEffect(() => {
    const itemIds = [
      ...decisionRequests.map((item) => `decision:${item.requestId}`),
      ...incidents.map((item) => `incident:${item.id}`),
    ];
    const previous = lastActionableItemIdsRef.current;
    const hasNewItem = itemIds.some((itemId) => !previous.has(itemId));
    lastActionableItemIdsRef.current = new Set(itemIds);
    if (!hasNewItem || !appReady || !settingsLoaded) return;
    setTemporarilyHidden(false);
    void (async () => {
      await synchronizeDesktopPetWindow(false);
      await sendState(true);
    })().catch((error) => {
      logWarn("Failed to show desktop pet surfaces for a new actionable item", error);
    });
  }, [
    appReady,
    decisionRequests,
    incidents,
    sendState,
    settingsLoaded,
    synchronizeDesktopPetWindow,
  ]);

  useEffect(() => {
    let disposed = false;
    const restoreReadySurface = (
      surface: "pet" | "bubble",
      candidateEpoch: unknown
    ) => {
      if (disposed) return;
      const epochRef = surface === "pet" ? petSurfaceEpochRef : bubbleSurfaceEpochRef;
      const seenRef = surface === "pet" ? petSurfaceEpochsSeenRef : bubbleSurfaceEpochsSeenRef;
      if (!shouldAcceptDesktopPetSurfaceEpoch(
        epochRef.current,
        candidateEpoch,
        seenRef.current
      )) {
        return;
      }
      epochRef.current = candidateEpoch;
      seenRef.current.add(candidateEpoch);
      if (seenRef.current.size > 64) {
        const oldest = seenRef.current.values().next().value;
        if (oldest) seenRef.current.delete(oldest);
      }
      void (async () => {
        await synchronizeDesktopPetWindow(surface === "pet");
        await sendState(true);
      })().catch((err) => {
        logWarn(`Failed to restore ready desktop pet ${surface} surface`, err);
      });
    };
    const unlistenReady = listen<DesktopPetSurfaceReadyPayload>(
      DESKTOP_PET_READY_EVENT,
      (event) => restoreReadySurface("pet", event.payload?.surfaceEpoch)
    );
    const unlistenBubbleReady = listen<DesktopPetSurfaceReadyPayload>(
      DESKTOP_PET_BUBBLE_READY_EVENT,
      (event) => restoreReadySurface("bubble", event.payload?.surfaceEpoch)
    );
    const unlistenHidden = listen<DesktopPetHiddenPayload>(
      DESKTOP_PET_HIDDEN_EVENT,
      (event) => {
        if (
          desktopPetLifecycleTokenMatches(
            lifecycleTokenRef.current || null,
            event.payload.lifecycleToken
          )
          && event.payload.petSurfaceEpoch === petSurfaceEpochRef.current
        ) {
          setTemporarilyHidden(true);
        }
      }
    );
    const unlistenBubbleEmpty = listen<DesktopPetBubbleEmptyPayload>(
      DESKTOP_PET_BUBBLE_EMPTY_EVENT,
      (event) => {
        if (
          !desktopPetLifecycleTokenMatches(
            lifecycleTokenRef.current || null,
            event.payload.lifecycleToken
          )
          || event.payload.bubbleSurfaceEpoch !== bubbleSurfaceEpochRef.current
        ) {
          return;
        }
        const alerts = useDesktopPetAlertStore.getState();
        if (alerts.decisionRequests.length > 0 || alerts.incidents.length > 0) return;
        if (event.payload.completionId !== bubbleCompletionIdRef.current) return;
        setDismissedCompletionId(event.payload.completionId);
      }
    );
    const currentSurfaceAction = (payload: DesktopPetOpenSettingsPayload) => (
      desktopPetLifecycleTokenMatches(
        lifecycleTokenRef.current || null,
        payload.lifecycleToken
      )
      && (
        payload.surfaceEpoch === petSurfaceEpochRef.current
        || payload.surfaceEpoch === bubbleSurfaceEpochRef.current
      )
    );
    const unlistenOpenTarget = listen<DesktopPetOpenTargetPayload>(DESKTOP_PET_OPEN_TARGET_EVENT, (event) => {
      if (!currentSurfaceAction(event.payload)) return;
      void (async () => {
        await invoke("app_show_main_window");
        const sessionId = event.payload.sessionId;
        if (!sessionId) return;
        if (event.payload.daemonOnly) {
          const restored = await useTerminalStore.getState().attachDaemonSession(sessionId);
          if (!restored) {
            await onActivateSessionRef.current(sessionId);
            return;
          }
        }
        await onActivateSessionRef.current(sessionId);
      })().catch((err) => logWarn("Failed to activate desktop pet target", err));
    });
    const unlistenOpenSettings = listen<DesktopPetOpenSettingsPayload>(
      DESKTOP_PET_OPEN_SETTINGS_EVENT,
      (event) => {
        if (!currentSurfaceAction(event.payload)) return;
        void invoke("app_show_main_window")
          .then(() => onOpenSettingsRef.current())
          .catch((err) => logWarn("Failed to open desktop pet settings", err));
      }
    );
    const unlistenPosition = listen<DesktopPetPositionPayload>(DESKTOP_PET_POSITION_EVENT, (event) => {
      if (
        !desktopPetLifecycleTokenMatches(
          lifecycleTokenRef.current || null,
          event.payload.lifecycleToken
        )
        || event.payload.petSurfaceEpoch !== petSurfaceEpochRef.current
      ) {
        return;
      }
      const current = useSettingsStore.getState().desktopPet;
      if (current.lockPosition) return;
      const nextPosition = { x: Math.round(event.payload.x), y: Math.round(event.payload.y) };
      if (current.position?.x === nextPosition.x && current.position?.y === nextPosition.y) return;
      const key = desktopPetNativeGeometryKey(
        current.size,
        nextPosition,
        current.alwaysOnTop,
        petWindowVisibleRef.current
      );
      petAppliedWindowConfigKeyRef.current = key;
      void updateSettingRef.current("desktopPet", { ...current, position: nextPosition }).catch((err) => {
        if (petAppliedWindowConfigKeyRef.current === key) {
          petAppliedWindowConfigKeyRef.current = null;
        }
        logWarn("Failed to persist desktop pet position", err);
      });
    });
    const unlistenSizeChange = listen<DesktopPetSizeChangePayload>(
      DESKTOP_PET_SIZE_CHANGE_EVENT,
      (event) => {
        if (
          !desktopPetLifecycleTokenMatches(
            lifecycleTokenRef.current || null,
            event.payload.lifecycleToken
          )
          || event.payload.petSurfaceEpoch !== petSurfaceEpochRef.current
        ) {
          return;
        }
        if (
          !Number.isFinite(event.payload.size)
          || !Number.isFinite(event.payload.x)
          || !Number.isFinite(event.payload.y)
        ) {
          return;
        }
        const current = useSettingsStore.getState().desktopPet;
        const size = normalizeDesktopPetSizePercent(event.payload.size, current.size);
        const position = {
          x: Math.round(event.payload.x),
          y: Math.round(event.payload.y),
        };
        if (
          current.size === size
          && current.position?.x === position.x
          && current.position?.y === position.y
        ) {
          return;
        }
        const key = desktopPetNativeGeometryKey(
          size,
          position,
          current.alwaysOnTop,
          petWindowVisibleRef.current
        );
        petAppliedWindowConfigKeyRef.current = key;
        void updateSettingRef.current("desktopPet", { ...current, size, position }).catch((err) => {
          if (petAppliedWindowConfigKeyRef.current === key) {
            petAppliedWindowConfigKeyRef.current = null;
          }
          logWarn("Failed to persist desktop pet size", err);
        });
      }
    );
    const sendCompanionDecisionResult = (
      requestId: string,
      brokerEpoch: string,
      requestLifecycleToken: string,
      bubbleSurfaceEpoch: string,
      accepted: boolean
    ) => {
      const petSurfaceEpoch = petSurfaceEpochRef.current;
      if (!companionActiveRef.current || !petSurfaceEpoch) return Promise.resolve();
      const request: DesktopPetCompanionActionResultMessage = {
        protocolVersion: DESKTOP_PET_COMPANION_PROTOCOL_VERSION,
        kind: "actionResult",
        generation: {
          lifecycleToken: requestLifecycleToken,
          petSurfaceEpoch,
          bubbleSurfaceEpoch,
        },
        requestId,
        brokerEpoch,
        accepted,
      };
      return invoke("desktop_pet_companion_send_action_result", { request }).catch((error) => {
        logWarn("Failed to return desktop pet companion decision result", error);
      });
    };
    const unlistenDecisionResolve = listen<DesktopPetDecisionResolvePayload>(
      DESKTOP_PET_DECISION_RESOLVE_EVENT,
      (event) => {
        const {
          requestId,
          brokerEpoch,
          lifecycleToken: requestLifecycleToken,
          bubbleSurfaceEpoch,
          answer,
        } = event.payload;
        if (
          !desktopPetLifecycleTokenMatches(
            lifecycleTokenRef.current || null,
            requestLifecycleToken
          )
          || bubbleSurfaceEpoch !== bubbleSurfaceEpochRef.current
        ) {
          return;
        }
        const resultPayload = {
          requestId,
          brokerEpoch,
          lifecycleToken: requestLifecycleToken,
          bubbleSurfaceEpoch,
        };
        void invoke("desktop_pet_resolve_pi_decision", {
          requestId,
          brokerEpoch,
          answer,
        }).then(() => {
          useDesktopPetAlertStore.getState().removeDecision(requestId);
          void emitTo(DESKTOP_PET_BUBBLE_WINDOW_LABEL, DESKTOP_PET_DECISION_RESULT_EVENT, {
            ...resultPayload,
            accepted: true,
          }).catch((error) => {
            logWarn("Failed to return Tauri desktop pet decision result", error);
          });
          void sendCompanionDecisionResult(
            requestId,
            brokerEpoch,
            requestLifecycleToken,
            bubbleSurfaceEpoch,
            true
          );
        }).catch((err) => {
          logWarn("Failed to resolve Pi decision from desktop pet", err);
          void emitTo(DESKTOP_PET_BUBBLE_WINDOW_LABEL, DESKTOP_PET_DECISION_RESULT_EVENT, {
            ...resultPayload,
            accepted: false,
          }).catch(() => {});
          void sendCompanionDecisionResult(
            requestId,
            brokerEpoch,
            requestLifecycleToken,
            bubbleSurfaceEpoch,
            false
          );
        });
      }
    );
    const unlistenIncidentAck = listen<DesktopPetIncidentAckPayload>(
      DESKTOP_PET_INCIDENT_ACK_EVENT,
      (event) => {
        if (
          !desktopPetLifecycleTokenMatches(
            lifecycleTokenRef.current || null,
            event.payload.lifecycleToken
          )
          || event.payload.bubbleSurfaceEpoch !== bubbleSurfaceEpochRef.current
        ) {
          return;
        }
        useDesktopPetAlertStore.getState().acknowledgeIncident(event.payload.incidentId);
      }
    );
    void Promise.all([unlistenReady, unlistenBubbleReady])
      .then(() => {
        if (!disposed) return emit(DESKTOP_PET_COORDINATOR_READY_EVENT);
      })
      .catch((error) => {
        logWarn("Failed to initialize desktop pet surface readiness", error);
      });
    return () => {
      disposed = true;
      void unlistenReady.then((unlisten) => unlisten());
      void unlistenBubbleReady.then((unlisten) => unlisten());
      void unlistenHidden.then((unlisten) => unlisten());
      void unlistenBubbleEmpty.then((unlisten) => unlisten());
      void unlistenOpenTarget.then((unlisten) => unlisten());
      void unlistenOpenSettings.then((unlisten) => unlisten());
      void unlistenPosition.then((unlisten) => unlisten());
      void unlistenSizeChange.then((unlisten) => unlisten());
      void unlistenDecisionResolve.then((unlisten) => unlisten());
      void unlistenIncidentAck.then((unlisten) => unlisten());
    };
  }, [sendState, synchronizeDesktopPetWindow]);
}

function desktopPetNativeGeometryKey(
  size: number,
  position: { x: number; y: number } | null,
  alwaysOnTop: boolean,
  visible: boolean
): string {
  return [
    size,
    position?.x ?? "default",
    position?.y ?? "default",
    alwaysOnTop ? "top" : "normal",
    visible ? "visible" : "hidden",
  ].join(":");
}

function desktopPetVisibilityKey(petVisible: boolean, bubbleVisible: boolean): string {
  return `${petVisible ? "pet" : "no-pet"}:${bubbleVisible ? "bubble" : "no-bubble"}`;
}
