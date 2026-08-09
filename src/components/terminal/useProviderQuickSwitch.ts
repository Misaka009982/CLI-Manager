import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { providerErrorCode, type NativeProviderAppType, type NativeProviderCard, type NativeProviderFailoverState, type NativeProviderGlobalCurrent, type NativeProviderGlobalPreview, type NativeProviderGlobalApplyResult, type NativeProviderRoutingState } from "../settings/providers/nativeProviderTypes";

export const LOCAL_PROVIDER_HOME_IDENTITY = {
  environmentKind: "local" as const,
  environmentId: "host",
  identity: "local:host",
};

export interface ProviderQuickSwitchSnapshot {
  providers: NativeProviderCard[];
  current: NativeProviderGlobalCurrent | null;
  routing: NativeProviderRoutingState | null;
  failover: NativeProviderFailoverState | null;
}

export interface UseProviderQuickSwitchResult extends ProviderQuickSwitchSnapshot {
  loading: boolean;
  failoverLoading: boolean;
  action: string | null;
  errorCode: string | null;
  hasLocalTakeover: boolean;
  refresh: () => Promise<void>;
  refreshFailover: () => Promise<void>;
  previewGlobal: (providerId: string) => Promise<NativeProviderGlobalPreview>;
  applyGlobal: (preview: NativeProviderGlobalPreview) => Promise<NativeProviderGlobalApplyResult>;
  setFailoverQueue: (providerIds: string[]) => Promise<void>;
  reorderFailoverQueue: (providerIds: string[]) => Promise<void>;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return providerErrorCode(error);
}

export function useProviderQuickSwitch(
  appType: NativeProviderAppType,
  open: boolean,
): UseProviderQuickSwitchResult {
  const [snapshot, setSnapshot] = useState<ProviderQuickSwitchSnapshot>({
    providers: [],
    current: null,
    routing: null,
    failover: null,
  });
  const [loading, setLoading] = useState(false);
  const [failoverLoading, setFailoverLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [errorCodeState, setErrorCodeState] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  const refreshFailover = useCallback(async () => {
    const version = ++requestVersionRef.current;
    setFailoverLoading(true);
    try {
      const next = await invoke<NativeProviderFailoverState>("routing_get_failover_queue", { appType });
      if (version !== requestVersionRef.current) return;
      setSnapshot((current) => ({
        ...current,
        failover: current.failover
          ? { ...current.failover, circuit: next.circuit, circuits: next.circuits }
          : next,
      }));
    } catch (error) {
      if (version === requestVersionRef.current) setErrorCodeState(errorCode(error));
    } finally {
      if (version === requestVersionRef.current) setFailoverLoading(false);
    }
  }, [appType]);

  const refresh = useCallback(async () => {
    const version = ++requestVersionRef.current;
    setLoading(true);
    setErrorCodeState(null);
    try {
      const [providersResult, currentResult, routingResult, failoverResult] = await Promise.allSettled([
        invoke<NativeProviderCard[]>("provider_catalog_list", { appType }),
        invoke<NativeProviderGlobalCurrent>("provider_global_current", {
          input: { appType, homeIdentity: LOCAL_PROVIDER_HOME_IDENTITY },
        }),
        invoke<NativeProviderRoutingState>("routing_get_state"),
        invoke<NativeProviderFailoverState>("routing_get_failover_queue", { appType }),
      ]);
      if (version !== requestVersionRef.current) return;
      if (providersResult.status === "rejected") throw providersResult.reason;
      setSnapshot({
        providers: providersResult.value.filter((provider) => provider.appType === appType),
        current: currentResult.status === "fulfilled" ? currentResult.value : null,
        routing: routingResult.status === "fulfilled" ? routingResult.value : null,
        failover: failoverResult.status === "fulfilled" ? failoverResult.value : null,
      });
      if (currentResult.status === "rejected" && failoverResult.status === "rejected") {
        setErrorCodeState(errorCode(currentResult.reason));
      }
    } catch (error) {
      if (version === requestVersionRef.current) setErrorCodeState(errorCode(error));
    } finally {
      if (version === requestVersionRef.current) setLoading(false);
    }
  }, [appType]);

  useEffect(() => {
    requestVersionRef.current += 1;
    if (!open) return;
    void refresh();
  }, [appType, open, refresh]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      if (!action && !failoverLoading) void refreshFailover();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [action, failoverLoading, open, refreshFailover]);

  const runMutation = useCallback(async <T,>(name: string, work: () => Promise<T>): Promise<T> => {
    setAction(name);
    setErrorCodeState(null);
    try {
      return await work();
    } catch (error) {
      setErrorCodeState(errorCode(error));
      throw error;
    } finally {
      setAction(null);
    }
  }, []);

  const previewGlobal = useCallback((providerId: string) => runMutation(
    "preview-global",
    () => invoke<NativeProviderGlobalPreview>("provider_global_preview", {
      input: { appType, providerId, homeIdentity: LOCAL_PROVIDER_HOME_IDENTITY },
    }),
  ), [appType, runMutation]);

  const applyGlobal = useCallback((preview: NativeProviderGlobalPreview) => runMutation(
    "apply-global",
    async () => {
      const result = await invoke<NativeProviderGlobalApplyResult>("provider_global_apply", {
        input: {
          appType,
          providerId: preview.providerId,
          homeIdentity: LOCAL_PROVIDER_HOME_IDENTITY,
          previewFingerprint: preview.fingerprint,
        },
      });
      await refresh();
      return result;
    },
  ), [appType, refresh, runMutation]);

  const setFailoverQueue = useCallback((providerIds: string[]) => runMutation(
    "failover-queue",
    async () => {
      await invoke<NativeProviderFailoverState>("routing_set_failover_queue", {
        input: { appType, providerIds },
      });
      await refresh();
    },
  ), [appType, refresh, runMutation]);

  const reorderFailoverQueue = useCallback((providerIds: string[]) => runMutation(
    "failover-reorder",
    async () => {
      await invoke("provider_catalog_reorder", { appType, providerIds });
      await refreshFailover();
    },
  ), [appType, refreshFailover, runMutation]);

  const hasLocalTakeover = Boolean(snapshot.routing?.persisted.takeovers.some(
    (takeover) => takeover.appType === appType && takeover.homeIdentity.identity === LOCAL_PROVIDER_HOME_IDENTITY.identity,
  ));

  return {
    ...snapshot,
    loading,
    failoverLoading,
    action,
    errorCode: errorCodeState,
    hasLocalTakeover,
    refresh,
    refreshFailover,
    previewGlobal,
    applyGlobal,
    setFailoverQueue,
    reorderFailoverQueue,
  };
}
