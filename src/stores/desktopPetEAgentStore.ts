import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type {
  DesktopPetEAgentEvent,
  DesktopPetEAnswer,
  DesktopPetEPendingAction,
} from "../lib/desktopPetE";

interface ActionCursor {
  pendingActionId: string;
  requestGeneration: number;
  actionFingerprint: string;
  closed: boolean;
}

interface ReducedAgentState {
  pendingActions: ReadonlyMap<string, DesktopPetEPendingAction>;
  cursors: ReadonlyMap<string, ActionCursor>;
}

export interface DesktopPetEAgentSubmitRequest {
  pendingActionId: string;
  transportActionId: string;
  answers: DesktopPetEAnswer[];
  approvalValue: string | null;
}

interface DesktopPetEAgentState extends ReducedAgentState {
  applyEvent: (event: DesktopPetEAgentEvent) => void;
  submit: (request: DesktopPetEAgentSubmitRequest) => Promise<void>;
}

function agentEventFingerprint(event: DesktopPetEAgentEvent): string {
  const action = event.pendingAction;
  return [
    event.phase,
    action.submitting ? "1" : "0",
    action.error ?? "",
    action.adapterMode,
    action.adapterReason ?? "",
  ].join("\u0000");
}

function reduceAgentEvent(
  state: ReducedAgentState,
  event: DesktopPetEAgentEvent,
): ReducedAgentState {
  const cursor = state.cursors.get(event.sessionId);
  const isTerminal = event.phase === "resolved" || event.phase === "cancelled";
  const actionFingerprint = agentEventFingerprint(event);
  if (
    cursor
    && (event.pendingAction.requestGeneration < cursor.requestGeneration
      || (event.pendingAction.requestGeneration === cursor.requestGeneration
        && event.pendingAction.id !== cursor.pendingActionId))
  ) {
    return state;
  }

  if (
    cursor
    && cursor.pendingActionId === event.pendingAction.id
    && cursor.requestGeneration === event.pendingAction.requestGeneration
    && cursor.actionFingerprint === actionFingerprint
    && cursor.closed === isTerminal
  ) {
    return state;
  }
  if (cursor?.closed && cursor.pendingActionId === event.pendingAction.id && !isTerminal) {
    return state;
  }

  const nextCursors = new Map(state.cursors);
  nextCursors.set(event.sessionId, {
    pendingActionId: event.pendingAction.id,
    requestGeneration: event.pendingAction.requestGeneration,
    actionFingerprint,
    closed: isTerminal,
  });

  const nextActions = new Map(state.pendingActions);
  if (isTerminal) {
    if (nextActions.get(event.sessionId)?.id === event.pendingAction.id) {
      nextActions.delete(event.sessionId);
    }
  } else {
    nextActions.set(event.sessionId, event.pendingAction);
  }

  return { pendingActions: nextActions, cursors: nextCursors };
}

export function reduceDesktopPetEAgentEvent(
  state: ReducedAgentState,
  event: DesktopPetEAgentEvent,
): ReducedAgentState {
  return reduceAgentEvent(state, event);
}

export const useDesktopPetEAgentStore = create<DesktopPetEAgentState>((set, get) => ({
  pendingActions: new Map(),
  cursors: new Map(),
  applyEvent: (event) => set((current) => reduceAgentEvent(current, event)),
  submit: async (request) => {
    const pendingAction = [...get().pendingActions.values()]
      .find((action) => action.id === request.pendingActionId);
    if (!pendingAction) throw new Error("desktop_pet_e_agent_pending_unknown");
    if (pendingAction.adapterMode !== "interactive") {
      throw new Error("desktop_pet_e_agent_adapter_unavailable");
    }
    await invoke("desktop_pet_e_agent_submit", {
      pendingActionId: request.pendingActionId,
      transportActionId: request.transportActionId,
      answers: request.answers,
      approvalValue: request.approvalValue,
    });
  },
}));
