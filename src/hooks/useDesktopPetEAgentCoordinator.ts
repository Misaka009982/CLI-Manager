import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DESKTOP_PET_E_AGENT_EVENT,
  isDesktopPetEAgentEvent,
} from "../lib/desktopPetE";
import { logWarn } from "../lib/logger";
import { useDesktopPetEAgentStore } from "../stores/desktopPetEAgentStore";
import { useDesktopPetERuntimeStore } from "../stores/desktopPetERuntimeStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";

const SESSION_UI_AVAILABILITY_INTERVAL_MS = 5000;
const RUNTIME_FAILURE_AVAILABILITY_GRACE_MS = 15_000;

function createSessionUiInstanceId(): string {
  return `cli-manager-session-ui-${crypto.randomUUID()}`;
}

/** 主窗口是问题/审批的独立承载面，不能依赖 Electron 宠物进程是否存活。 */
export function useDesktopPetEAgentCoordinator(appReady: boolean): void {
  const attachInFlightRef = useRef(new Set<string>());
  const [runtimeFailureGrace, setRuntimeFailureGrace] = useState(false);
  const applyEvent = useDesktopPetEAgentStore((state) => state.applyEvent);
  const resetForDaemonRestart = useDesktopPetEAgentStore((state) => state.resetForDaemonRestart);
  const hasInteractivePendingActions = useDesktopPetEAgentStore((state) => (
    [...state.pendingActions.values()].some((action) => action.adapterMode === "interactive")
  ));
  const desktopPetEEnabled = useSettingsStore((state) => state.desktopPetE.enabled);
  const runtimeError = useDesktopPetERuntimeStore((state) => state.lastError);
  const agentInteractionEnabled = useSettingsStore((state) => state.desktopPetE.agentInteractionEnabled);
  const sessionAcceptsNewActions = appReady
    && agentInteractionEnabled
    && (desktopPetEEnabled || runtimeFailureGrace);
  const sessionInteractionAvailable = sessionAcceptsNewActions
    || (appReady && agentInteractionEnabled && hasInteractivePendingActions);
  const sessionActionDisplayEnabled = appReady && desktopPetEEnabled;

  useEffect(() => {
    window.addEventListener("cli-manager-pty-daemon-restarted", resetForDaemonRestart);
    return () => {
      window.removeEventListener("cli-manager-pty-daemon-restarted", resetForDaemonRestart);
    };
  }, [resetForDaemonRestart]);

  useEffect(() => {
    if (!runtimeError) {
      setRuntimeFailureGrace(false);
      return;
    }
    setRuntimeFailureGrace(true);
    const timer = window.setTimeout(
      () => setRuntimeFailureGrace(false),
      RUNTIME_FAILURE_AVAILABILITY_GRACE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [runtimeError?.code, runtimeError?.detail]);

  useEffect(() => {
    if (!isTauri()) return;
    const available = sessionInteractionAvailable;
    const instanceId = createSessionUiInstanceId();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let availabilityTimer: number | null = null;
    let unsubscribeTerminalStore: (() => void) | null = null;
    const owningSessionRecoveryTimers = new Map<string, number>();

    const publishAvailability = () => {
      if (!available) return;
      void invoke("desktop_pet_e_agent_availability", {
        instanceId,
        available: true,
        acceptNew: sessionAcceptsNewActions,
      }).catch((error) => {
        if (!disposed) logWarn("Failed to publish CLI-Manager session action availability", error);
      });
    };

    const releaseUnownedAction = async (sessionId: string, pendingActionId: string) => {
      const terminalState = useTerminalStore.getState();
      if (terminalState.sessions.some((session) => session.id === sessionId)) return;
      const currentAction = useDesktopPetEAgentStore.getState().pendingActions.get(sessionId);
      if (currentAction?.id !== pendingActionId) return;
      await invoke("desktop_pet_e_agent_cancel", {
        pendingActionId,
        reason: "owning-session-unavailable",
      }).catch((error) => logWarn("Failed to release an unowned Desktop Pet E action", error));
    };

    const ensureOwningSession = (sessionId: string, pendingActionId: string) => {
      const currentAction = useDesktopPetEAgentStore.getState().pendingActions.get(sessionId);
      if (currentAction?.id !== pendingActionId) return;
      const terminalState = useTerminalStore.getState();
      if (terminalState.sessions.some((session) => session.id === sessionId)) return;
      if (attachInFlightRef.current.has(sessionId)) return;
      attachInFlightRef.current.add(sessionId);
      void (async () => {
        let attached = false;
        for (let attempt = 0; attempt < 3 && !attached && !disposed; attempt += 1) {
          const pending = useDesktopPetEAgentStore.getState().pendingActions.get(sessionId);
          if (pending?.id !== pendingActionId) return;
          try {
            attached = await terminalState.attachDaemonSession(sessionId, {
              activate: false,
              requireAlive: true,
            });
          } catch (error) {
            logWarn("Failed to attach the owning session for Desktop Pet E", error);
          }
          if (!attached && attempt < 2 && !disposed) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
          }
        }
        if (!attached && !disposed) await releaseUnownedAction(sessionId, pendingActionId);
      })().catch((error) => {
        logWarn("Failed to finish Desktop Pet E owning-session recovery", error);
      }).finally(() => attachInFlightRef.current.delete(sessionId));
    };

    const scheduleOwningSessionRecovery = (sessionId: string, pendingActionId: string) => {
      const currentTimer = owningSessionRecoveryTimers.get(sessionId);
      if (currentTimer !== undefined) window.clearTimeout(currentTimer);
      const timer = window.setTimeout(() => {
        owningSessionRecoveryTimers.delete(sessionId);
        if (!disposed) ensureOwningSession(sessionId, pendingActionId);
      }, 250);
      owningSessionRecoveryTimers.set(sessionId, timer);
    };

    unsubscribeTerminalStore = useTerminalStore.subscribe((next, previous) => {
      if (next.sessions === previous.sessions) return;
      const nextSessionIds = new Set(next.sessions.map((session) => session.id));
      for (const session of previous.sessions) {
        if (nextSessionIds.has(session.id)) continue;
        const action = useDesktopPetEAgentStore.getState().pendingActions.get(session.id);
        if (action) scheduleOwningSessionRecovery(session.id, action.id);
      }
    });

    void listen<unknown>(DESKTOP_PET_E_AGENT_EVENT, (event) => {
      if (!isDesktopPetEAgentEvent(event.payload)) return;
      const agentEvent = event.payload;
      const terminalPhase = agentEvent.phase === "resolved" || agentEvent.phase === "cancelled";
      const displayOnlyEvent = sessionActionDisplayEnabled
        && agentEvent.pendingAction.adapterMode !== "interactive";
      if (!available && !terminalPhase && !displayOnlyEvent) return;
      applyEvent(agentEvent);
      if (!terminalPhase) {
        ensureOwningSession(agentEvent.sessionId, agentEvent.pendingActionId);
      }
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
        return;
      }
      unlisten = stopListening;
      publishAvailability();
      if (available) {
        availabilityTimer = window.setInterval(
          publishAvailability,
          SESSION_UI_AVAILABILITY_INTERVAL_MS,
        );
      }
    }).catch((error) => {
      if (!disposed) logWarn("Failed to listen for CLI-Manager session actions", error);
    });

    return () => {
      disposed = true;
      if (availabilityTimer !== null) window.clearInterval(availabilityTimer);
      for (const timer of owningSessionRecoveryTimers.values()) window.clearTimeout(timer);
      owningSessionRecoveryTimers.clear();
      unsubscribeTerminalStore?.();
      unlisten?.();
      if (available) {
        void invoke("desktop_pet_e_agent_availability", {
          instanceId,
          available: false,
          acceptNew: false,
        }).catch(() => undefined);
      }
    };
  }, [applyEvent, sessionAcceptsNewActions, sessionActionDisplayEnabled, sessionInteractionAvailable]);
}
