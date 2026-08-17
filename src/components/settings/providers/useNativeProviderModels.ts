import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NativeProviderAppType, NativeProviderClaudeConfig } from "./nativeProviderTypes";

interface FetchModelsResponse { models: string[] }

interface FetchModelsOptions {
  appType: NativeProviderAppType;
  providerId?: string;
  baseUrl: string;
  claude?: Pick<NativeProviderClaudeConfig, "isFullUrl" | "apiFormat" | "apiKeyField">;
  apiFormat?: string;
}

export function useNativeProviderModels() {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback(async (options: FetchModelsOptions) => {
    if (!options.providerId) {
      setError("provider_models_active_key_required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<FetchModelsResponse>("provider_fetch_models", {
        input: {
          appType: options.appType,
          providerId: options.providerId,
          baseUrl: options.baseUrl,
          isFullUrl: options.claude?.isFullUrl,
          apiFormat: options.claude?.apiFormat ?? options.apiFormat,
          apiKeyField: options.claude?.apiKeyField,
        },
      });
      setModels(result.models);
    } catch (reason) {
      setModels([]);
      setError(typeof reason === "string" ? reason : "provider_models_request_failed");
    } finally {
      setLoading(false);
    }
  }, []);

  return { models, loading, error, fetchModels };
}
