import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  providerErrorCode,
  type NativeProviderAppType,
  type NativeProviderCard,
  type NativeProviderCreateInput,
  type NativeProviderDetail,
  type NativeProviderKeyCreateInput,
  type NativeProviderKeySummary,
  type NativeProviderUpdateInput,
} from "./nativeProviderTypes";

interface UseNativeProviderCatalogResult {
  providers: NativeProviderCard[];
  detail: NativeProviderDetail | null;
  selectedProviderId: string | null;
  loading: boolean;
  detailLoading: boolean;
  action: string | null;
  errorCode: string | null;
  setSelectedProviderId: (providerId: string | null) => void;
  refresh: () => Promise<void>;
  createProvider: (input: NativeProviderCreateInput) => Promise<void>;
  updateProvider: (input: NativeProviderUpdateInput) => Promise<void>;
  duplicateProvider: (providerId: string, name?: string) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  setProviderEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  setCurrentProvider: (providerId: string) => Promise<void>;
  createKey: (input: NativeProviderKeyCreateInput) => Promise<void>;
  activateKey: (providerId: string, keyId: string) => Promise<void>;
  setKeyEnabled: (providerId: string, keyId: string, enabled: boolean) => Promise<void>;
  deleteKey: (providerId: string, keyId: string) => Promise<void>;
  clearError: () => void;
}

export function useNativeProviderCatalog(appType: NativeProviderAppType): UseNativeProviderCatalogResult {
  const [providers, setProviders] = useState<NativeProviderCard[]>([]);
  const [detail, setDetail] = useState<NativeProviderDetail | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const fetchDetail = useCallback(async (providerId: string | null) => {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    if (!providerId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }

    setDetailLoading(true);
    try {
      const next = await invoke<NativeProviderDetail>("provider_catalog_get", {
        appType,
        providerId,
      });
      if (detailRequestRef.current === requestId) setDetail(next);
    } catch (error) {
      if (detailRequestRef.current === requestId) {
        setDetail(null);
        setErrorCode(providerErrorCode(error));
      }
    } finally {
      if (detailRequestRef.current === requestId) setDetailLoading(false);
    }
  }, [appType]);

  const refresh = useCallback(async () => {
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;
    setLoading(true);
    setErrorCode(null);
    try {
      const next = await invoke<NativeProviderCard[]>("provider_catalog_list", { appType });
      if (listRequestRef.current === requestId) {
        setProviders(next);
        setSelectedProviderId((current) => {
          if (current && next.some((provider) => provider.id === current)) return current;
          return next[0]?.id ?? null;
        });
      }
    } catch (error) {
      if (listRequestRef.current === requestId) {
        setProviders([]);
        setSelectedProviderId(null);
        setDetail(null);
        setErrorCode(providerErrorCode(error));
      }
    } finally {
      if (listRequestRef.current === requestId) setLoading(false);
    }
  }, [appType]);

  useEffect(() => {
    setProviders([]);
    setDetail(null);
    setSelectedProviderId(null);
    void refresh();
  }, [appType, refresh]);

  useEffect(() => {
    void fetchDetail(selectedProviderId);
  }, [fetchDetail, selectedProviderId]);

  const runAction = useCallback(async (name: string, work: () => Promise<void>) => {
    setAction(name);
    setErrorCode(null);
    try {
      await work();
    } catch (error) {
      setErrorCode(providerErrorCode(error));
      throw error;
    } finally {
      setAction(null);
    }
  }, []);

  const refreshSelection = useCallback(async (providerId: string | null) => {
    if (providerId) setSelectedProviderId(providerId);
    await refresh();
    await fetchDetail(providerId);
  }, [fetchDetail, refresh]);

  const createProvider = useCallback(async (input: NativeProviderCreateInput) => {
    await runAction("create-provider", async () => {
      const created = await invoke<NativeProviderDetail>("provider_catalog_create", { input });
      await refreshSelection(created.card.id);
    });
  }, [refreshSelection, runAction]);

  const updateProvider = useCallback(async (input: NativeProviderUpdateInput) => {
    await runAction("update-provider", async () => {
      const updated = await invoke<NativeProviderDetail>("provider_catalog_update", { input });
      await refreshSelection(updated.card.id);
    });
  }, [refreshSelection, runAction]);

  const duplicateProvider = useCallback(async (providerId: string, name?: string) => {
    await runAction("duplicate-provider", async () => {
      const duplicated = await invoke<NativeProviderDetail>("provider_catalog_duplicate", {
        appType,
        providerId,
        name,
      });
      await refreshSelection(duplicated.card.id);
    });
  }, [appType, refreshSelection, runAction]);

  const deleteProvider = useCallback(async (providerId: string) => {
    await runAction("delete-provider", async () => {
      await invoke<void>("provider_catalog_delete", { appType, providerId });
      await refresh();
    });
  }, [appType, refresh, runAction]);

  const setProviderEnabled = useCallback(async (providerId: string, enabled: boolean) => {
    await runAction("set-provider-enabled", async () => {
      await invoke<NativeProviderDetail>("provider_catalog_set_enabled", {
        appType,
        providerId,
        enabled,
      });
      await refreshSelection(providerId);
    });
  }, [appType, refreshSelection, runAction]);

  const setCurrentProvider = useCallback(async (providerId: string) => {
    await runAction("set-current-provider", async () => {
      await invoke<NativeProviderDetail>("provider_catalog_set_current", { appType, providerId });
      await refreshSelection(providerId);
    });
  }, [appType, refreshSelection, runAction]);

  const createKey = useCallback(async (input: NativeProviderKeyCreateInput) => {
    await runAction("create-key", async () => {
      await invoke<NativeProviderKeySummary>("provider_key_create", { input });
      await refreshSelection(input.providerId);
    });
  }, [refreshSelection, runAction]);

  const activateKey = useCallback(async (providerId: string, keyId: string) => {
    await runAction("activate-key", async () => {
      await invoke<NativeProviderKeySummary>("provider_key_activate", {
        appType,
        providerId,
        keyId,
      });
      await refreshSelection(providerId);
    });
  }, [appType, refreshSelection, runAction]);

  const setKeyEnabled = useCallback(async (providerId: string, keyId: string, enabled: boolean) => {
    await runAction("set-key-enabled", async () => {
      await invoke<NativeProviderKeySummary>("provider_key_set_enabled", {
        appType,
        providerId,
        keyId,
        enabled,
      });
      await refreshSelection(providerId);
    });
  }, [appType, refreshSelection, runAction]);

  const deleteKey = useCallback(async (providerId: string, keyId: string) => {
    await runAction("delete-key", async () => {
      await invoke<void>("provider_key_delete", { appType, providerId, keyId });
      await refreshSelection(providerId);
    });
  }, [appType, refreshSelection, runAction]);

  return {
    providers,
    detail,
    selectedProviderId,
    loading,
    detailLoading,
    action,
    errorCode,
    setSelectedProviderId,
    refresh,
    createProvider,
    updateProvider,
    duplicateProvider,
    deleteProvider,
    setProviderEnabled,
    setCurrentProvider,
    createKey,
    activateKey,
    setKeyEnabled,
    deleteKey,
    clearError: () => setErrorCode(null),
  };
}
