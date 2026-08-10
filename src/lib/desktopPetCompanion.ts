import type { CcConnectPlatform } from "./remoteHandoff";
import type {
  DesktopPetConfigPayload,
  DesktopPetDecisionAnswer,
  DesktopPetSnapshot,
  InstalledPet,
} from "./desktopPet";

export const DESKTOP_PET_COMPANION_PROTOCOL_VERSION = 1 as const;
export const DESKTOP_PET_COMPANION_EVENT = "desktop-pet-companion-action";
export const DESKTOP_PET_COMPANION_STATUS_EVENT = "desktop-pet-companion-status";

export interface DesktopPetCompanionStatus {
  supported: boolean;
  available: boolean;
  active: boolean;
  protocolVersion: number;
  reason: string | null;
}

export interface DesktopPetCompanionStatusEvent {
  status: "ready" | "fallback" | "stopped";
  protocolVersion: number;
  reason: string | null;
}

export interface DesktopPetCompanionGeneration {
  lifecycleToken: string;
  petSurfaceEpoch: string;
  bubbleSurfaceEpoch: string;
}

export interface DesktopPetCompanionSyncMessage {
  protocolVersion: typeof DESKTOP_PET_COMPANION_PROTOCOL_VERSION;
  kind: "sync";
  generation: DesktopPetCompanionGeneration;
  deliveryRevision: number;
  config: DesktopPetConfigPayload;
  snapshot: DesktopPetSnapshot;
  pet: InstalledPet | null;
}

export interface DesktopPetCompanionShutdownMessage {
  protocolVersion: typeof DESKTOP_PET_COMPANION_PROTOCOL_VERSION;
  kind: "shutdown";
  generation: DesktopPetCompanionGeneration;
}

export interface DesktopPetCompanionActionResultMessage {
  protocolVersion: typeof DESKTOP_PET_COMPANION_PROTOCOL_VERSION;
  kind: "actionResult";
  generation: DesktopPetCompanionGeneration;
  requestId: string;
  brokerEpoch: string;
  accepted: boolean;
}

export type DesktopPetCompanionHostMessage =
  | DesktopPetCompanionSyncMessage
  | DesktopPetCompanionShutdownMessage
  | DesktopPetCompanionActionResultMessage;

interface DesktopPetCompanionActionBase {
  lifecycleToken: string;
  surfaceEpoch: string;
}

export type DesktopPetCompanionAction =
  | (DesktopPetCompanionActionBase & {
      type: "openTarget";
      sessionId: string | null;
      daemonOnly: boolean;
    })
  | (DesktopPetCompanionActionBase & {
      type: "openSettings";
    })
  | (DesktopPetCompanionActionBase & {
      type: "positionChanged";
      x: number;
      y: number;
    })
  | (DesktopPetCompanionActionBase & {
      type: "sizeChanged";
      x: number;
      y: number;
      size: number;
    })
  | (DesktopPetCompanionActionBase & {
      type: "handoffStart";
      sessionId: string;
      platform: CcConnectPlatform;
    })
  | (DesktopPetCompanionActionBase & {
      type: "handoffCancel";
    })
  | (DesktopPetCompanionActionBase & {
      type: "decisionResolve";
      requestId: string;
      brokerEpoch: string;
      answer: DesktopPetDecisionAnswer;
    })
  | (DesktopPetCompanionActionBase & {
      type: "incidentAcknowledge";
      incidentId: string;
    })
  | (DesktopPetCompanionActionBase & {
      type: "hide";
    })
  | (DesktopPetCompanionActionBase & {
      type: "bubbleDismiss";
      completionId: string | null;
    });

export interface DesktopPetCompanionActionMessage {
  protocolVersion: typeof DESKTOP_PET_COMPANION_PROTOCOL_VERSION;
  kind: "action";
  token: string;
  action: DesktopPetCompanionAction;
}

export type DesktopPetCompanionChildMessage =
  | {
      protocolVersion: typeof DESKTOP_PET_COMPANION_PROTOCOL_VERSION;
      kind: "hello";
      token: string;
      companionVersion: string;
    }
  | {
      protocolVersion: typeof DESKTOP_PET_COMPANION_PROTOCOL_VERSION;
      kind: "ready";
      token: string;
    }
  | DesktopPetCompanionActionMessage
  | {
      protocolVersion: typeof DESKTOP_PET_COMPANION_PROTOCOL_VERSION;
      kind: "error";
      token: string;
      code: string;
      message: string;
    };
