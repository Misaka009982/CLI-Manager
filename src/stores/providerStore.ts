import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type {
  CliType,
  KeySecretAction,
  ProviderCommonConfig,
  ProviderConfigValidation,
  ProviderConfigValidationInput,
  ProviderCreateInput,
  ProviderDetail,
  ProviderEffectivePreview,
  ProviderKeyCreateInput,
  ProviderKeyUpdateInput,
  ProviderStatus,
  ProviderSummary,
  ProviderUpdateInput,
} from "@/lib/providerTypes";

interface ProviderStore {
  cliType: CliType;
  providers: ProviderSummary[];
  selectedProviderId: string | null;
  selectedProvider: ProviderDetail | null;
  common: ProviderCommonConfig | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  loadProviders: (cliType?: CliType) => Promise<void>;
  selectProvider: (id: string | null) => Promise<void>;
  createProvider: (input: ProviderCreateInput) => Promise<ProviderDetail>;
  updateProvider: (id: string, input: ProviderUpdateInput) => Promise<ProviderDetail>;
  duplicateProvider: (id: string) => Promise<ProviderDetail>;
  deleteProvider: (id: string) => Promise<void>;
  setProviderStatus: (id: string, status: ProviderStatus) => Promise<ProviderDetail>;
  createKey: (providerId: string, input: ProviderKeyCreateInput) => Promise<ProviderDetail>;
  updateKey: (providerId: string, keyId: string, input: ProviderKeyUpdateInput) => Promise<ProviderDetail>;
  activateKey: (providerId: string, keyId: string) => Promise<ProviderDetail>;
  deleteKey: (providerId: string, keyId: string, replacementKeyId?: string) => Promise<ProviderDetail>;
  loadCommon: (cliType?: CliType) => Promise<ProviderCommonConfig>;
  updateCommon: (cliType: CliType, configText: string) => Promise<ProviderCommonConfig>;
  validateConfig: (input: ProviderConfigValidationInput) => Promise<ProviderConfigValidation>;
  previewEffective: (providerId: string) => Promise<ProviderEffectivePreview>;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "provider_operation_failed";
}

function argsForCliType(cliType?: CliType): Record<string, unknown> {
  return cliType ? { cliType } : {};
}

function mergeSummary(providers: ProviderSummary[], detail: ProviderDetail): ProviderSummary[] {
  const next = providers.filter((provider) => provider.id !== detail.id);
  return [...next, detail].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export const useProviderStore = create<ProviderStore>((set, get) => {
  const commitDetail = (detail: ProviderDetail) => {
    set((state) => ({
      providers: mergeSummary(state.providers, detail),
      selectedProviderId: detail.id,
      selectedProvider: detail,
      error: null,
    }));
    return detail;
  };

  const runMutation = async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      const result = await request();
      set({ error: null });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      set({ error: message });
      throw error;
    }
  };

  return {
    cliType: "claude",
    providers: [],
    selectedProviderId: null,
    selectedProvider: null,
    common: null,
    loaded: false,
    loading: false,
    error: null,

    loadProviders: async (cliType) => {
      const nextCliType = cliType ?? get().cliType;
      set({ cliType: nextCliType, loading: true, error: null });
      try {
        const providers = await invoke<ProviderSummary[]>("provider_list", argsForCliType(nextCliType));
        const selectedId = get().selectedProviderId;
        const selectedStillExists = selectedId && providers.some((provider) => provider.id === selectedId);
        set({
          providers,
          loaded: true,
          loading: false,
          selectedProviderId: selectedStillExists ? selectedId : providers[0]?.id ?? null,
          selectedProvider: selectedStillExists ? get().selectedProvider : null,
        });
        if (selectedStillExists) {
          await get().selectProvider(selectedId);
        } else if (providers[0]) {
          await get().selectProvider(providers[0].id);
        }
        await get().loadCommon(nextCliType);
      } catch (error) {
        set({ loading: false, loaded: false, error: errorMessage(error) });
        throw error;
      }
    },

    selectProvider: async (id) => {
      if (!id) {
        set({ selectedProviderId: null, selectedProvider: null });
        return;
      }
      set({ selectedProviderId: id });
      try {
        const detail = await invoke<ProviderDetail>("provider_get", { id });
        set((state) => ({ selectedProvider: detail, providers: mergeSummary(state.providers, detail), error: null }));
      } catch (error) {
        set({ error: errorMessage(error), selectedProvider: null });
        throw error;
      }
    },

    createProvider: (input) => runMutation(async () => commitDetail(await invoke<ProviderDetail>("provider_create", { input }))),
    updateProvider: (id, input) => runMutation(async () => commitDetail(await invoke<ProviderDetail>("provider_update", { id, input }))),
    duplicateProvider: (id) => runMutation(async () => commitDetail(await invoke<ProviderDetail>("provider_duplicate", { id }))),
    deleteProvider: (id) => runMutation(async () => {
      await invoke("provider_delete", { id });
      set((state) => ({
        providers: state.providers.filter((provider) => provider.id !== id),
        selectedProviderId: state.selectedProviderId === id ? null : state.selectedProviderId,
        selectedProvider: state.selectedProviderId === id ? null : state.selectedProvider,
      }));
    }),
    setProviderStatus: (id, status) => runMutation(async () => commitDetail(await invoke<ProviderDetail>("provider_set_status", { id, status }))),
    createKey: (providerId, input) => runMutation(async () => commitDetail(await invoke<ProviderDetail>("provider_key_create", { providerId, input }))),
    updateKey: (providerId, keyId, input) => runMutation(async () => commitDetail(await invoke<ProviderDetail>("provider_key_update", { providerId, keyId, input }))),
    activateKey: (providerId, keyId) => runMutation(async () => commitDetail(await invoke<ProviderDetail>("provider_key_activate", { providerId, keyId }))),
    deleteKey: (providerId, keyId, replacementKeyId) => runMutation(async () => commitDetail(await invoke<ProviderDetail>("provider_key_delete", { providerId, keyId, replacementKeyId }))),

    loadCommon: async (cliType) => {
      const target = cliType ?? get().cliType;
      const common = await invoke<ProviderCommonConfig>("provider_common_get", { cliType: target });
      set({ common });
      return common;
    },
    updateCommon: (cliType, configText) => runMutation(async () => {
      const common = await invoke<ProviderCommonConfig>("provider_common_update", { cliType, configText });
      if (get().cliType === cliType) set({ common });
      return common;
    }),
    validateConfig: async (input) => invoke<ProviderConfigValidation>("provider_validate_config", { input }),
    previewEffective: async (providerId) => invoke<ProviderEffectivePreview>("provider_preview_effective", { providerId }),
  };
});

export type { KeySecretAction };

