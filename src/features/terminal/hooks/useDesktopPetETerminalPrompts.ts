import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DesktopPetETerminalPrompt } from "../../../shared/lib/desktopPetE";
import {
  createDesktopPetETerminalPromptState,
  nextDesktopPetETerminalPromptExpiry,
  reduceDesktopPetETerminalPrompt,
  sameDesktopPetETerminalPrompts,
  selectDesktopPetETerminalPrompts,
} from "../../../shared/lib/desktopPetETerminalPrompt";
import { logWarn } from "../../../shared/platform/logger";

const EMPTY_TERMINAL_PROMPTS: ReadonlyMap<string, DesktopPetETerminalPrompt> = new Map();

// 与普通通知及答题可用性分离，只服从宠物总开关；本模块不写终端或答题 store。
export function useDesktopPetETerminalPrompts(enabled: boolean): ReadonlyMap<string, DesktopPetETerminalPrompt> {
  const stateRef = useRef(createDesktopPetETerminalPromptState());
  const [prompts, setPrompts] = useState<ReadonlyMap<string, DesktopPetETerminalPrompt>>(() => new Map());

  useEffect(() => {
    if (!enabled || !isTauri()) {
      stateRef.current = createDesktopPetETerminalPromptState(Date.now());
      setPrompts((current) => current.size ? new Map() : current);
      return;
    }
    let disposed = false;
    let expiryTimer: number | null = null;
    const refresh = () => {
      if (disposed) return;
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
      expiryTimer = null;
      const now = Date.now();
      const next = selectDesktopPetETerminalPrompts(stateRef.current, now);
      setPrompts((current) => sameDesktopPetETerminalPrompts(current, next) ? current : next);
      const expiresAt = nextDesktopPetETerminalPromptExpiry(stateRef.current, now);
      if (Number.isFinite(expiresAt)) {
        expiryTimer = window.setTimeout(refresh, Math.max(16, expiresAt - now + 25));
      }
    };
    const resetForDaemonRestart = () => {
      stateRef.current = createDesktopPetETerminalPromptState(Date.now());
      refresh();
    };
    const unlisten = listen<unknown>("claude-hook-notification", (event) => {
      if (disposed) return;
      const next = reduceDesktopPetETerminalPrompt(stateRef.current, event.payload, Date.now());
      if (next === stateRef.current) return;
      stateRef.current = next;
      refresh();
    });
    void unlisten.catch((error) => logWarn("Failed to listen for Pi terminal prompt status", error));
    window.addEventListener("cli-manager-pty-daemon-restarted", resetForDaemonRestart);
    refresh();
    return () => {
      disposed = true;
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
      window.removeEventListener("cli-manager-pty-daemon-restarted", resetForDaemonRestart);
      void unlisten.then((stopListening) => stopListening()).catch(() => undefined);
    };
  }, [enabled]);

  return enabled ? prompts : EMPTY_TERMINAL_PROMPTS;
}
