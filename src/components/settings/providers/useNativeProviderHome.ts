import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getHistoryPathArgs } from "@/lib/historyPathArgs";
import {
  providerErrorCode,
  type NativeProviderAppType,
  type NativeProviderEnvironmentInspectInput,
  type NativeProviderEnvironmentKind,
  type NativeProviderEnvironmentReport,
  type NativeProviderGlobalApplyResult,
  type NativeProviderGlobalCurrent,
  type NativeProviderGlobalPreview,
  type NativeProviderHomeInput,
  type NativeProviderHomeState,
} from "./nativeProviderTypes";

type NativeProviderRootOverrides = {
  claude: string | null;
  codex: string | null;
  grok: string | null;
};

type NativeProviderHistoryRootOverrides = NativeProviderRootOverrides;

export interface UseNativeProviderHomeResult {
  environmentKind: NativeProviderEnvironmentKind;
  environmentId: string;
  mode: "auto" | "manual";
  homePath: string;
  home: NativeProviderHomeState | null;
  previewHome: NativeProviderHomeState | null;
  homeDraftDirty: boolean;
  current: NativeProviderGlobalCurrent | null;
  preview: NativeProviderGlobalPreview | null;
  report: NativeProviderEnvironmentReport | null;
  loading: boolean;
  action: string | null;
  errorCode: string | null;
  setEnvironmentKind: (kind: NativeProviderEnvironmentKind) => void;
  setEnvironmentId: (id: string) => void;
  setMode: (mode: "auto" | "manual") => void;
  setHomePath: (path: string) => void;
  refreshHome: () => Promise<void>;
  selectHome: () => Promise<void>;
  resetHome: () => Promise<void>;
  previewGlobal: () => Promise<NativeProviderGlobalPreview | null>;
  applyGlobal: (previewOverride?: NativeProviderGlobalPreview) => Promise<NativeProviderGlobalApplyResult | null>;
  inspectEnvironment: (
    roots?: NativeProviderRootOverrides,
    historyRoots?: NativeProviderHistoryRootOverrides,
    homeInputOverride?: NativeProviderHomeInput,
  ) => Promise<void>;
  repair: () => Promise<void>;
  clearError: () => void;
}

export function useNativeProviderHome(
  appType: NativeProviderAppType,
  providerId: string | null,
  configuredRoots: NativeProviderRootOverrides,
): UseNativeProviderHomeResult {
  const [environmentKind, setEnvironmentKindState] = useState<NativeProviderEnvironmentKind>("local");
  const [environmentId, setEnvironmentId] = useState("host");
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [homePath, setHomePath] = useState("");
  const [home, setHome] = useState<NativeProviderHomeState | null>(null);
  const [previewHome, setPreviewHome] = useState<NativeProviderHomeState | null>(null);
  const [current, setCurrent] = useState<NativeProviderGlobalCurrent | null>(null);
  const [preview, setPreview] = useState<NativeProviderGlobalPreview | null>(null);
  const [report, setReport] = useState<NativeProviderEnvironmentReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const setEnvironmentKind = useCallback((kind: NativeProviderEnvironmentKind) => {
    setEnvironmentKindState(kind);
    setEnvironmentId(kind === "local" ? "host" : "");
  }, []);

  const identity = useCallback(() => ({
    environmentKind,
    environmentId: environmentId.trim() || null,
  }), [environmentId, environmentKind]);

  const homeInput = useCallback((): NativeProviderHomeInput => ({
    environmentKind,
    environmentId: environmentId.trim() || null,
    mode,
    homePath: mode === "manual" ? homePath.trim() : null,
  }), [environmentId, environmentKind, homePath, mode]);

  const run = useCallback(async <T,>(name: string, work: () => Promise<T>): Promise<T> => {
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

  const refreshCurrent = useCallback(async () => {
    try {
      const next = await invoke<NativeProviderGlobalCurrent>("provider_global_current", {
        input: { appType, homeIdentity: identity() },
      });
      setCurrent(next);
    } catch {
      setCurrent(null);
    }
  }, [appType, identity]);

  const refreshHome = useCallback(async () => {
    setLoading(true);
    setErrorCode(null);
    try {
      const next = await invoke<NativeProviderHomeState>("provider_home_get", {
        environmentKind,
        environmentId: environmentId.trim() || null,
      });
      setHome(next);
      setEnvironmentKindState(next.identity.environmentKind);
      setEnvironmentId(next.identity.environmentId);
      setMode(next.mode);
      setHomePath(next.homePath);
      setPreviewHome(null);
      await refreshCurrent();
      setPreview(null);
      setReport(null);
    } catch (error) {
      setHome(null);
      setCurrent(null);
      setPreviewHome(null);
      setPreview(null);
      setReport(null);
      setErrorCode(providerErrorCode(error));
    } finally {
      setLoading(false);
    }
  }, [environmentId, environmentKind, refreshCurrent]);

  const previewDraftHome = useCallback(async (): Promise<NativeProviderHomeState | null> => {
    try {
      return await invoke<NativeProviderHomeState>("provider_home_preview", {
        input: homeInput(),
      });
    } catch {
      return null;
    }
  }, [homeInput]);

  const homeDraftDirty = Boolean(home && (
    home.identity.identity !== `${environmentKind}:${environmentId.trim() || "host"}`
      || home.mode !== mode
      || (mode === "manual" && home.homePath !== homePath.trim())
  ));

  useEffect(() => {
    if (!home || !homeDraftDirty) {
      setPreviewHome(null);
      return;
    }
    setPreviewHome(null);
    setPreview(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      void previewDraftHome().then((next) => {
        if (!cancelled) setPreviewHome(next);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [home, homeDraftDirty, previewDraftHome]);

  useEffect(() => {
    setPreview(null);
  }, [appType, providerId]);

  useEffect(() => {
    void refreshHome();
  }, [refreshHome]);

  const selectHome = useCallback(async () => {
    const input = homeInput();
    await run("select-home", async () => {
      const next = await invoke<NativeProviderHomeState>("provider_home_select", { input });
      setHome(next);
      setEnvironmentKindState(next.identity.environmentKind);
      setEnvironmentId(next.identity.environmentId);
      setHomePath(next.homePath);
      setPreviewHome(null);
      await refreshCurrent();
      setPreview(null);
      setReport(null);
    });
  }, [homeInput, refreshCurrent, run]);

  const resetHome = useCallback(async () => {
    await run("reset-home", async () => {
      const next = await invoke<NativeProviderHomeState>("provider_home_reset", {
        environmentKind,
        environmentId: environmentId.trim() || null,
      });
      setHome(next);
      setEnvironmentKindState(next.identity.environmentKind);
      setEnvironmentId(next.identity.environmentId);
      setMode(next.mode);
      setHomePath(next.homePath);
      setPreviewHome(null);
      await refreshCurrent();
      setPreview(null);
      setReport(null);
    });
  }, [environmentId, environmentKind, refreshCurrent, run]);

  const previewGlobal = useCallback(async () => {
    if (!providerId) return null;
    return run("preview-global", async () => {
      const next = await invoke<NativeProviderGlobalPreview>("provider_global_preview", {
        input: { appType, providerId, homeIdentity: identity() },
      });
      setPreview(next);
      return next;
    });
  }, [appType, identity, providerId, run]);

  const applyGlobal = useCallback(async (previewOverride?: NativeProviderGlobalPreview) => {
    if (!providerId) return null;
    return run("apply-global", async () => {
      const applyPreview = previewOverride ?? preview ?? await invoke<NativeProviderGlobalPreview>("provider_global_preview", {
        input: { appType, providerId, homeIdentity: identity() },
      });
      const result = await invoke<NativeProviderGlobalApplyResult>("provider_global_apply", {
        input: {
          appType,
          providerId,
          homeIdentity: identity(),
          previewFingerprint: applyPreview.fingerprint,
        },
      });
      setPreview(null);
      await refreshHome();
      return result;
    });
  }, [appType, identity, preview, providerId, refreshHome, run]);

  const inspectEnvironment = useCallback(async (
    roots: NativeProviderRootOverrides = configuredRoots,
    historyRoots?: NativeProviderHistoryRootOverrides,
    homeInputOverride?: NativeProviderHomeInput,
  ) => {
    await run("inspect-environment", async () => {
      const pathArgs = historyRoots
        ? null
        : await getHistoryPathArgs();
      const input: NativeProviderEnvironmentInspectInput = {
        appType,
        homeIdentity: identity(),
        homeInput: homeInputOverride ?? homeInput(),
        configuredRoots: roots,
        historyRoots: historyRoots ?? {
          claude: pathArgs?.claudeConfigDir ?? null,
          codex: pathArgs?.codexConfigDir ?? null,
          grok: pathArgs?.grokSessionRoot ?? null,
        },
      };
      setReport(await invoke<NativeProviderEnvironmentReport>("provider_environment_inspect", { input }));
    });
  }, [appType, configuredRoots, homeInput, identity, run]);

  const repair = useCallback(async () => {
    await run("repair", async () => {
      await invoke("provider_global_repair");
      await inspectEnvironment();
    });
  }, [inspectEnvironment, run]);

  return {
    environmentKind,
    environmentId,
    mode,
    homePath,
    home,
    previewHome,
    homeDraftDirty,
    current,
    preview,
    report,
    loading,
    action,
    errorCode,
    setEnvironmentKind,
    setEnvironmentId,
    setMode,
    setHomePath,
    refreshHome,
    selectHome,
    resetHome,
    previewGlobal,
    applyGlobal,
    inspectEnvironment,
    repair,
    clearError: () => setErrorCode(null),
  };
}
