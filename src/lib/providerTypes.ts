export type CliType = "claude" | "codex" | "grok";
export type ProviderStatus = "draft" | "ready" | "disabled";

export interface ProviderKeySummary {
  id: string;
  providerId: string;
  label: string;
  hasSecret: boolean;
  secretHint: string;
  fingerprint: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderSummary {
  id: string;
  cliType: CliType;
  name: string;
  status: ProviderStatus;
  configFormat: "json" | "toml" | string;
  inheritCommon: boolean;
  sortOrder: number;
  keyCount: number;
  activeKeyId: string | null;
  activeKeyHint: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderDetail extends ProviderSummary {
  configText: string;
  keys: ProviderKeySummary[];
}

export interface ProviderCreateInput {
  cliType: CliType;
  name: string;
  configText: string;
  inheritCommon: boolean;
  sortOrder: number;
}

export interface ProviderUpdateInput {
  name: string;
  configText: string;
  inheritCommon: boolean;
  sortOrder: number;
}

export interface ProviderKeyCreateInput {
  label: string;
  secret: string;
  sortOrder: number;
}

export type KeySecretAction = "keep" | "replace";

export interface ProviderKeyUpdateInput {
  label: string;
  secretAction: KeySecretAction;
  secret?: string;
  sortOrder: number;
}

export interface ProviderCommonConfig {
  cliType: CliType;
  configFormat: "json" | "toml" | string;
  configText: string;
  revision: number;
  updatedAt: number;
}

export interface ProviderConfigValidationInput {
  cliType: CliType;
  commonText: string;
  providerText: string;
  inheritCommon: boolean;
}

export interface ProviderConfigValidation {
  valid: boolean;
  errorCode: string | null;
  effectiveText: string | null;
}

export interface ProviderEffectivePreview {
  providerId: string;
  cliType: CliType;
  configFormat: string;
  effectiveText: string;
}

export const CLI_TYPES: CliType[] = ["claude", "codex", "grok"];

export function configFormatForCliType(cliType: CliType): "json" | "toml" {
  return cliType === "claude" ? "json" : "toml";
}

