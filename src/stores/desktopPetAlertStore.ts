import { create } from "zustand";
import { translateCurrent } from "../lib/i18n";
import type { CliHookPayload } from "./terminalStore";
import type {
  DesktopPetDecisionRequest,
  DesktopPetIncident,
} from "../lib/desktopPet";

const INCIDENT_STORAGE_KEY = "cli-manager.desktop-pet.incidents.v1";
const MAX_INCIDENTS = 100;
const MAX_INCIDENT_TITLE_LENGTH = 240;
const MAX_INCIDENT_MESSAGE_LENGTH = 4_000;
const MAX_HOOK_TIMELINES = 1024;
const latestHookTimestampByScope = new Map<string, number>();

function boundedText(
  value: string | null | undefined,
  maxLength = MAX_INCIDENT_MESSAGE_LENGTH
): string | null {
  const normalized = value?.replace(/\0/g, "").trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, maxLength).join("");
}

function hookTimelineKeys(payload: CliHookPayload): string[] {
  const keys = [JSON.stringify(["tab", payload.tabId])];
  const sourceInstanceId = payload.sourceInstanceId?.trim();
  const sessionId = payload.sessionId?.trim();
  if (payload.source === "pi" && sourceInstanceId && sessionId) {
    keys.push(JSON.stringify(["pi", sourceInstanceId, sessionId]));
  }
  return keys;
}

function acceptHookTimelinePayload(payload: CliHookPayload): boolean {
  const parsedTimestamp = payload.timestamp
    ? Date.parse(payload.timestamp)
    : payload.piDecision?.createdAt ?? Number.NaN;
  if (!Number.isFinite(parsedTimestamp)) return true;
  const keys = hookTimelineKeys(payload);
  if (!payload.piDecision && keys.some((key) => {
    const current = latestHookTimestampByScope.get(key);
    return current !== undefined && parsedTimestamp < current;
  })) {
    return false;
  }
  for (const key of keys) {
    const current = latestHookTimestampByScope.get(key);
    if (current === undefined || parsedTimestamp > current) {
      latestHookTimestampByScope.delete(key);
      latestHookTimestampByScope.set(key, parsedTimestamp);
    }
  }
  while (latestHookTimestampByScope.size > MAX_HOOK_TIMELINES) {
    const oldest = latestHookTimestampByScope.keys().next().value;
    if (oldest === undefined) break;
    latestHookTimestampByScope.delete(oldest);
  }
  return true;
}

function hookIncidentTitle(payload: CliHookPayload): string {
  const supplied = boundedText(payload.title, MAX_INCIDENT_TITLE_LENGTH);
  if (payload.source === "pi" && (!supplied || supplied === "Pi Agent interrupted")) {
    return translateCurrent("desktopPet.incident.piInterruptedTitle");
  }
  return supplied || translateCurrent("desktopPet.incident.interruptedTitle");
}

function hookIncidentMessage(payload: CliHookPayload): string | null {
  if (payload.source === "pi" && payload.message === "Pi heartbeat timed out") {
    return translateCurrent("desktopPet.incident.piHeartbeatMessage");
  }
  return boundedText(payload.message);
}

type PersistedDesktopPetIncident = Omit<DesktopPetIncident, "daemonOnly"> & {
  daemonOnly?: boolean;
};

function isValidIncident(item: unknown): item is PersistedDesktopPetIncident {
  if (!item || typeof item !== "object") return false;
  const incident = item as Partial<PersistedDesktopPetIncident>;
  return typeof incident.id === "string"
    && incident.id.trim().length > 0
    && incident.id.length <= 512
    && typeof incident.tabId === "string"
    && incident.tabId.trim().length > 0
    && incident.tabId.length <= 128
    && (incident.sessionId === null || (
      typeof incident.sessionId === "string" && incident.sessionId.length <= 256
    ))
    && (incident.daemonOnly === undefined || typeof incident.daemonOnly === "boolean")
    && typeof incident.title === "string"
    && incident.title.trim().length > 0
    && (incident.message === null || typeof incident.message === "string")
    && typeof incident.createdAt === "number"
    && Number.isFinite(incident.createdAt);
}

function loadIncidents(): DesktopPetIncident[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(INCIDENT_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isValidIncident)
      .map((incident) => ({
        ...incident,
        id: incident.id.trim(),
        tabId: incident.tabId.trim(),
        sessionId: incident.sessionId?.trim() || null,
        daemonOnly: incident.daemonOnly === true,
        title: boundedText(incident.title, MAX_INCIDENT_TITLE_LENGTH)
          || translateCurrent("desktopPet.incident.interruptedTitle"),
        message: boundedText(incident.message),
      }))
      .slice(-MAX_INCIDENTS);
  } catch {
    return [];
  }
}

function persistIncidents(incidents: DesktopPetIncident[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INCIDENT_STORAGE_KEY, JSON.stringify(incidents));
  } catch {
    // 提醒持久化失败不能影响终端与 Hook 主链路。
  }
}

interface DesktopPetAlertState {
  decisionRequests: DesktopPetDecisionRequest[];
  incidents: DesktopPetIncident[];
  recordHookPayload: (payload: CliHookPayload) => void;
  addIncident: (incident: DesktopPetIncident) => void;
  removeDecision: (requestId: string) => void;
  acknowledgeIncident: (incidentId: string) => void;
}

export const useDesktopPetAlertStore = create<DesktopPetAlertState>((set) => ({
  decisionRequests: [],
  incidents: loadIncidents(),

  recordHookPayload: (payload) => {
    const closedRequestId = payload.piDecisionClosedRequestId?.trim();
    if (closedRequestId) {
      set((state) => {
        const decisionRequests = state.decisionRequests.filter((item) => (
          item.requestId !== closedRequestId
        ));
        return decisionRequests.length === state.decisionRequests.length
          ? state
          : { decisionRequests };
      });
      return;
    }
    if (!acceptHookTimelinePayload(payload)) return;
    const decision = payload.piDecision;
    if (decision) {
      set((state) => ({
        decisionRequests: [
          ...state.decisionRequests.filter((item) => item.requestId !== decision.requestId),
          decision,
        ].sort((left, right) => left.createdAt - right.createdAt),
      }));
    }

    if ((payload.event === "Stop" || payload.event === "StopFailure") && !decision) {
      const terminalAt = payload.timestamp ? Date.parse(payload.timestamp) : Number.NaN;
      set((state) => ({
        decisionRequests: state.decisionRequests.filter((item) => {
          const terminalIsCurrent = Number.isFinite(terminalAt) && terminalAt >= item.createdAt;
          const sameTab = terminalIsCurrent && item.tabId === payload.tabId;
          const samePiSource = terminalIsCurrent
            && payload.source === "pi"
            && Boolean(payload.sourceInstanceId)
            && item.sourceInstanceId === payload.sourceInstanceId
            && Boolean(payload.sessionId)
            && item.sessionId === payload.sessionId;
          return !sameTab && !samePiSource;
        }),
      }));
    }

    if (payload.event !== "StopFailure" || payload.heartbeat) return;
    const createdAt = payload.timestamp ? Date.parse(payload.timestamp) : Date.now();
    const incident: DesktopPetIncident = {
      id: payload.remoteEventId?.trim()
        || `hook:${payload.tabId}:${Number.isFinite(createdAt) ? createdAt : Date.now()}`,
      tabId: payload.tabId,
      sessionId: payload.sessionId?.trim() || null,
      daemonOnly: false,
      title: hookIncidentTitle(payload),
      message: hookIncidentMessage(payload),
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    };
    set((state) => {
      if (state.incidents.some((item) => item.id === incident.id)) return state;
      const incidents = [...state.incidents, incident].slice(-MAX_INCIDENTS);
      persistIncidents(incidents);
      return { incidents };
    });
  },

  addIncident: (incident) => {
    const normalized: DesktopPetIncident = {
      ...incident,
      daemonOnly: incident.daemonOnly === true,
      title: boundedText(incident.title, MAX_INCIDENT_TITLE_LENGTH)
        || translateCurrent("desktopPet.incident.interruptedTitle"),
      message: boundedText(incident.message),
    };
    set((state) => {
      if (state.incidents.some((item) => item.id === normalized.id)) return state;
      const incidents = [...state.incidents, normalized].slice(-MAX_INCIDENTS);
      persistIncidents(incidents);
      return { incidents };
    });
  },

  removeDecision: (requestId) => set((state) => {
    const decisionRequests = state.decisionRequests.filter((item) => item.requestId !== requestId);
    return decisionRequests.length === state.decisionRequests.length
      ? state
      : { decisionRequests };
  }),

  acknowledgeIncident: (incidentId) => set((state) => {
    const incidents = state.incidents.filter((item) => item.id !== incidentId);
    persistIncidents(incidents);
    return { incidents };
  }),
}));
