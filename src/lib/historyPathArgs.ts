import { useHistorySourceSettingsStore } from "../stores/historySourceSettingsStore";
import { useSettingsStore } from "../stores/settingsStore";

export type HistoryPathArgs = {
  claudeConfigDir: string | null;
  codexConfigDir: string | null;
  grokSessionRoot: string | null;
  kimiConfigDir: string | null;
};

let historySourceSettingsLoadPromise: Promise<void> | null = null;

function activeHistoryConfigRoot(sourceId: "claude" | "codex" | "kimi"): string | null {
  const source = useHistorySourceSettingsStore.getState().settings[sourceId];
  const configRoot = source?.enabled ? source.activeInstance?.locations.configRoot?.trim() : "";
  return configRoot || null;
}

function activeHistorySessionRoot(sourceId: "grok"): string | null {
  const source = useHistorySourceSettingsStore.getState().settings[sourceId];
  const sessionRoot = source?.enabled ? source.activeInstance?.locations.sessionRoot?.trim() : "";
  return sessionRoot || null;
}

export async function ensureHistorySourceSettingsLoaded(): Promise<void> {
  const store = useHistorySourceSettingsStore.getState();
  if (store.loaded) return;
  if (!historySourceSettingsLoadPromise) {
    historySourceSettingsLoadPromise = store.load().finally(() => {
      historySourceSettingsLoadPromise = null;
    });
  }
  await historySourceSettingsLoadPromise;
}

export function getHistoryPathArgsSync(): HistoryPathArgs {
  const settings = useSettingsStore.getState();
  return {
    claudeConfigDir: (activeHistoryConfigRoot("claude") ?? settings.claudeHookConfigDir?.trim()) || null,
    codexConfigDir: (activeHistoryConfigRoot("codex") ?? settings.codexHookConfigDir?.trim()) || null,
    grokSessionRoot: activeHistorySessionRoot("grok"),
    kimiConfigDir: (activeHistoryConfigRoot("kimi") ?? settings.kimiHookConfigDir?.trim()) || null,
  };
}

export async function getHistoryPathArgs(): Promise<HistoryPathArgs> {
  await ensureHistorySourceSettingsLoaded();
  return getHistoryPathArgsSync();
}
