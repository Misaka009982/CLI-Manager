import type { ExtensionCli, ExtensionImportSourceKind } from "../../../shared/types/extensions";
import type { NativeProviderHomeState } from "../../settings/api/nativeProviderTypes";

export interface ImportSourceSuggestion { path: string; origin: "hook" | "home" }

/** Suggest read-only import sources; these paths never change the native apply target. */
export function suggestImportSources(
  cli: ExtensionCli,
  kind: ExtensionImportSourceKind,
  hookRoot: string | null,
  home: NativeProviderHomeState | null,
): ImportSourceSuggestion[] {
  if (kind === "ccswitch") return [];
  const join = (root: string, leaf: string) => `${root.replace(/[\\/]+$/, "")}${root.includes("\\") ? "\\" : "/"}${leaf}`;
  const suggestions: ImportSourceSuggestion[] = [];
  const hook = hookRoot?.trim();
  if (hook) {
    if (kind === "skillDirectory") suggestions.push({ path: join(hook, "skills"), origin: "hook" });
    else if (cli !== "claude") suggestions.push({ path: join(hook, "config.toml"), origin: "hook" });
    else {
      // A selected .claude folder can be the default root, not an explicit CLAUDE_CONFIG_DIR.
      // Offer both layouts; the read-only scan verifies the selected file instead of assuming it exists.
      if (/[\\/]\.claude[\\/]*$/i.test(hook)) {
        suggestions.push({ path: join(hook.replace(/[\\/]\.claude[\\/]*$/i, ""), ".claude.json"), origin: "hook" });
      }
      suggestions.push({ path: join(hook, ".claude.json"), origin: "hook" });
    }
  }
  if (home) {
    const root = home.targets[`${cli}ConfigDir`];
    suggestions.push({ path: kind === "skillDirectory" ? join(root, "skills")
      : cli === "claude" ? join(home.homePath, ".claude.json") : join(root, "config.toml"), origin: "home" });
  }
  return suggestions.filter((entry, index) => suggestions.findIndex(other => other.path.replace(/\\/g, "/") === entry.path.replace(/\\/g, "/")) === index);
}
