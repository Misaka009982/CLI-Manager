import type { TranslationKey } from "../../../shared/i18n";

/** Expose only allowlisted codes, never OS diagnostics that may contain paths or secrets. */
export function skillDeploymentErrorKey(error: unknown): TranslationKey {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/^(extensions_[a-z0-9_]+)(?=:|$)/)?.[1];
  if (code === "extensions_skill_target_conflict") return "extensions.skills.errorConflict";
  if (code === "extensions_skill_external_modified") return "extensions.skills.errorModified";
  if (code === "extensions_skill_symlink_failed") return "extensions.skills.errorLink";
  if (code === "extensions_skill_package_missing" || code === "extensions_skill_package_not_found") return "extensions.skills.errorSource";
  return "extensions.skills.deployFailed";
}
