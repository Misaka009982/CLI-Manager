export type NativeProviderAppType = "claude" | "codex" | "grokbuild";

export const NATIVE_PROVIDER_APP_TYPES: readonly NativeProviderAppType[] = [
  "claude",
  "codex",
  "grokbuild",
];

export interface NativeProviderCard {
  id: string;
  appType: string;
  name: string;
  websiteUrl: string | null;
  category: string | null;
  notes: string | null;
  icon: string | null;
  iconColor: string | null;
  sortIndex: number;
  createdAt: number;
  isCurrent: boolean;
  enabled: boolean;
  keyCount: number;
  activeKeyLabel: string | null;
  baseUrl: string | null;
  model: string | null;
  apiFormat: string | null;
  settingsValid: boolean;
  commonConfigEnabled: boolean;
}

export interface NativeProviderKeySummary {
  id: string;
  providerId: string;
  appType: string;
  label: string;
  maskedApiKey: string;
  tags: string[];
  notes: string;
  enabled: boolean;
  sortIndex: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NativeProviderDetail {
  card: NativeProviderCard;
  settingsConfig: string;
  effectiveSettingsConfig: string;
  settingsHasSecret: boolean;
  keys: NativeProviderKeySummary[];
}

export interface NativeProviderCommonConfig {
  appType: string;
  value: string;
  format: string;
}

export interface NativeProviderCreateInput {
  appType: NativeProviderAppType;
  name: string;
  settingsConfig?: string;
  baseUrl?: string;
  model?: string;
  apiFormat?: string;
  websiteUrl?: string;
  category?: string;
  notes?: string;
  icon?: string;
  iconColor?: string;
  commonConfigEnabled?: boolean;
}

export interface NativeProviderUpdateInput extends NativeProviderCreateInput {
  providerId: string;
}

export interface NativeProviderKeyCreateInput {
  providerId: string;
  appType: NativeProviderAppType;
  label: string;
  apiKey: string;
  tags?: string[];
  notes?: string;
  enabled?: boolean;
  activate?: boolean;
}

export function providerErrorCode(error: unknown): string {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : "provider_unknown_error";

  return message.split(":", 1)[0] || "provider_unknown_error";
}
