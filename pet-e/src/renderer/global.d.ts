import type {
  DesktopPetEActionResult,
  DesktopPetEChildAction,
  DesktopPetEConfigPayload,
  DesktopPetESnapshot,
} from "../bridge/protocol.js";

declare global {
  interface Window {
    desktopPetE: {
      ready: () => void;
      setMouseInteractive: (interactive: boolean) => void;
      sendAction: (action: DesktopPetEChildAction) => void;
      onConfig: (listener: (payload: DesktopPetEConfigPayload) => void) => () => void;
      onSnapshot: (listener: (payload: DesktopPetESnapshot) => void) => () => void;
      onActionResult: (listener: (payload: DesktopPetEActionResult) => void) => () => void;
    };
  }
}

export {};
