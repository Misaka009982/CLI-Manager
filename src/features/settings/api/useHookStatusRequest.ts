import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { HookSettingsStatus } from "../lib/hookSettingsModel";
import { codexHookNeedsReview, codexHookStatusErrorMessage } from "./codexHookStatus";
import { translateCurrent } from "../../../shared/i18n/index";

type StatusArgs = Record<string, unknown>;

/** All status/mutation responses share the same profile and stale-response guard. */
export function useHookStatusRequest(context: StatusArgs) {
  const key = JSON.stringify(context);
  const current = useRef({ key, sequence: 0, pending: 0 });
  current.current.key = key;
  const [result, setResult] = useState<{ key: string; value: HookSettingsStatus } | null>(null);
  const reviewPending = useRef(false);
  reviewPending.current = result?.key === key && codexHookNeedsReview(result.value.codex);
  const invokeStatus = useCallback(async (command: string, overrides: StatusArgs = {}) => {
    if (current.current.key !== key) return null;
    const requestedKey = key;
    const sequence = ++current.current.sequence;
    current.current.pending += 1;
    const isCurrent = () => current.current.key === requestedKey && current.current.sequence === sequence;
    try {
      const value = await invoke<HookSettingsStatus>(command, {
        ...context, ...overrides, codexProfileName: context.codexProfileName,
      });
      if (!isCurrent()) return null;
      setResult({ key: requestedKey, value });
      return value;
    } catch (error) {
      if (!isCurrent()) return null;
      setResult(null);
      throw new Error(codexHookStatusErrorMessage(error, translateCurrent));
    } finally {
      current.current.pending -= 1;
    }
  }, [key]);

  useEffect(() => {
    let disposed = false;
    // Codex saves confirmation in-place while our window remains focused.
    const refresh = () => {
      if (disposed || document.visibilityState !== "visible" || current.current.pending) return;
      void invokeStatus("hook_settings_get_status", { autoRepair: false }).catch(() => {});
    };
    const timer = window.setInterval(() => { if (reviewPending.current) refresh(); }, 10000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      current.current.sequence += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [invokeStatus]);

  return { status: result?.key === key ? result.value : null, invokeStatus };
}
