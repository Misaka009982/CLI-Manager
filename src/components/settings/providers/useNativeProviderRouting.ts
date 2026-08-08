import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { providerErrorCode } from "./nativeProviderTypes";
import type {
  NativeProviderAppType,
  NativeProviderFailoverConfig,
  NativeProviderFailoverState,
  NativeProviderHomeIdentity,
  NativeProviderRoutingState,
} from "./nativeProviderTypes";

export interface UseNativeProviderRoutingResult {
  state: NativeProviderRoutingState | null;
  failoverState: Partial<Record<NativeProviderAppType, NativeProviderFailoverState>>;
  loading: boolean;
  failoverLoading: Partial<Record<NativeProviderAppType, boolean>>;
  action: string | null;
  errorCode: string | null;
  refresh: () => Promise<void>;
  refreshFailover: (appType: NativeProviderAppType) => Promise<void>;
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
  setFailoverEnabled: (appType: NativeProviderAppType, enabled: boolean) => Promise<void>;
  setFailoverQueue: (appType: NativeProviderAppType, providerIds: string[]) => Promise<void>;
  updateFailoverConfig: (appType: NativeProviderAppType, config: NativeProviderFailoverConfig) => Promise<void>;
  resetCircuit: (appType: NativeProviderAppType) => Promise<void>;
  clearError: () => void;
}

export function useNativeProviderRouting(): UseNativeProviderRoutingResult {
  const [state, setState] = useState<NativeProviderRoutingState | null>(null);
  const [failoverState, setFailoverState] = useState<Partial<Record<NativeProviderAppType, NativeProviderFailoverState>>>({});
  const [loading, setLoading] = useState(true);
  const [failoverLoading, setFailoverLoading] = useState<Partial<Record<NativeProviderAppType, boolean>>>({});
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

  const refreshFailover = useCallback(async (appType: NativeProviderAppType) => {
    setFailoverLoading((current) => ({ ...current, [appType]: true }));
    try {
      const next = await invoke<NativeProviderFailoverState>("routing_get_failover_queue", { appType });
      setFailoverState((current) => ({ ...current, [appType]: next }));
      setErrorCode(null);
    } catch (error) {
      setErrorCode(providerErrorCode(error));
    } finally {
      setFailoverLoading((current) => ({ ...current, [appType]: false }));
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

  const runFailover = useCallback(async <T,>(name: string, work: () => Promise<T>): Promise<T> => {
    setAction(name);
    setErrorCode(null);
    try {
      return await work();
    } catch (error) {
      setErrorCode(providerErrorCode(error));
      throw error;
    } finally {
      setAction(null);
    }
  }, []);

  const setFailoverEnabled = useCallback((appType: NativeProviderAppType, enabled: boolean) => runFailover(
    "failover-enabled",
    async () => {
      const next = await invoke<NativeProviderFailoverState>("routing_set_failover_enabled", { appType, enabled });
      setFailoverState((current) => ({ ...current, [appType]: next }));
    },
  ), [runFailover]);

  const setFailoverQueue = useCallback((appType: NativeProviderAppType, providerIds: string[]) => runFailover(
    "failover-queue",
    async () => {
      const next = await invoke<NativeProviderFailoverState>("routing_set_failover_queue", {
        input: { appType, providerIds },
      });
      setFailoverState((current) => ({ ...current, [appType]: next }));
    },
  ), [runFailover]);

  const updateFailoverConfig = useCallback((appType: NativeProviderAppType, config: NativeProviderFailoverConfig) => runFailover(
    "failover-config",
    async () => {
      const next = await invoke<NativeProviderFailoverState>("routing_update_failover_config", {
        input: { appType, config },
      });
      setFailoverState((current) => ({ ...current, [appType]: next }));
    },
  ), [runFailover]);

  const resetCircuit = useCallback((appType: NativeProviderAppType) => runFailover(
    "circuit-reset",
    async () => {
      const next = await invoke<NativeProviderFailoverState>("routing_reset_circuit", { appType });
      setFailoverState((current) => ({ ...current, [appType]: next }));
    },
  ), [runFailover]);

  return {
    state,
    failoverState,
    loading,
    failoverLoading,
    action,
    errorCode,
    refresh,
    refreshFailover,
    setServiceEnabled,
    setQuickControls,
    setTakeover,
    setFailoverEnabled,
    setFailoverQueue,
    updateFailoverConfig,
    resetCircuit,
    clearError: () => setErrorCode(null),
  };
}
