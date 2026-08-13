import { create } from "zustand";
import type { DesktopPetERuntimeState } from "../lib/desktopPetE";

const DEFAULT_RUNTIME_STATE: DesktopPetERuntimeState = {
  enabled: false,
  running: false,
  ready: false,
  generation: 0,
  restartCount: 0,
  lastError: null,
};

interface DesktopPetERuntimeStore extends DesktopPetERuntimeState {
  replace: (state: DesktopPetERuntimeState) => void;
}

export const useDesktopPetERuntimeStore = create<DesktopPetERuntimeStore>((set) => ({
  ...DEFAULT_RUNTIME_STATE,
  replace: (state) => set(state),
}));
