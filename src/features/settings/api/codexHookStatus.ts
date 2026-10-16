import type { TranslationKey } from "../../../shared/i18n/index";

/** Shared projection for settings and the sidebar; absence is never proof of trust. */
export interface CodexHookReadiness {
  hooksTrusted?: boolean;
  hooksFeatureInstalled?: boolean;
  sessionStartHookInstalled?: boolean;
  runningHookInstalled?: boolean;
  attentionHookInstalled?: boolean;
  stopHookInstalled?: boolean;
  subagentStartHookInstalled?: boolean;
}

export function codexHookNeedsReview(status: CodexHookReadiness | null | undefined): boolean {
  return Boolean(status && status.hooksTrusted === false && status.hooksFeatureInstalled
    && status.sessionStartHookInstalled && status.runningHookInstalled && status.attentionHookInstalled
    && status.stopHookInstalled && status.subagentStartHookInstalled);
}
export function codexHookStatusErrorMessage(error: unknown, t: (key: TranslationKey) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  const codes = {
    codex_hook_profile_name_invalid: "settings.hooks.codex.profileNameInvalid",
    codex_hook_profile_missing: "settings.hooks.codex.profileMissing",
    codex_hook_config_invalid: "settings.hooks.codex.configInvalid",
    codex_effective_config_invalid: "settings.hooks.codex.configInvalid",
  } as const;
  for (const [code, key] of Object.entries(codes)) {
    if (message === code) return t(key);
    if (message.startsWith(`${code}: `)) return `${t(key)} ${message.slice(code.length + 2)}`;
  }
  return message;
}
