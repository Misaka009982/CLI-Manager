import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { providerErrorCode } from "./nativeProviderTypes";
import type {
  NativeProviderAppType,
  NativeProviderHomeIdentity,
  NativeProviderRoutingState,
} from "./nativeProviderTypes";

export interface UseNativeProviderRoutingResult {
  state: NativeProviderRoutingState | null;
  loading: boolean;
  action: string | null;
  errorCode: string | null;
  refresh: () => Promise<void>;
  setServiceEnabled: (enabled: boolean) => Promise<void>;
  setQuickControls: (input: {
    showLocalQuickControl: boolean;
    showFailoverQuickControl: boolean;
    usageLoggingEnabled: boolean;
  }) => Promise<void>;
  setTakeover: (
    appType: NativeProviderAppType,
    homeIdentity: NativeProviderHomeIdentity,
    enabled: boolean,
  ) => Promise<void>;
  clearError: () => void;
}

export function useNativeProviderRouting(): UseNativeProviderRoutingResult {
  const [state, setState] = useState<NativeProviderRoutingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await invoke<NativeProviderRoutingState>("routing_get_state"));
      setErrorCode(null);
    } catch (error) {
      setErrorCode(providerErrorCode(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(async (name: string, work: () => Promise<NativeProviderRoutingState>) => {
    setAction(name);
    setErrorCode(null);
    try {
      setState(await work());
    } catch (error) {
      setErrorCode(providerErrorCode(error));
      throw error;
    } finally {
      setAction(null);
    }
  }, []);

  const setServiceEnabled = useCallback((enabled: boolean) => run(
    "service",
    () => invoke<NativeProviderRoutingState>("routing_set_service_enabled", { enabled }),
  ), [run]);

  const setQuickControls = useCallback((input: {
    showLocalQuickControl: boolean;
    showFailoverQuickControl: boolean;
    usageLoggingEnabled: boolean;
  }) => run(
    "quick-controls",
    () => invoke<NativeProviderRoutingState>("routing_set_quick_controls", { input }),
  ), [run]);

  const setTakeover = useCallback((appType: NativeProviderAppType, homeIdentity: NativeProviderHomeIdentity, enabled: boolean) => run(
    "takeover",
    () => invoke<NativeProviderRoutingState>("routing_set_takeover", {
      input: { appType, homeIdentity, enabled },
    }),
  ), [run]);

  return {
    state,
    loading,
    action,
    errorCode,
    refresh,
    setServiceEnabled,
    setQuickControls,
    setTakeover,
    clearError: () => setErrorCode(null),
  };
}
