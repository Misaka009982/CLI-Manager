import type { ExtensionCli, SkillInstallationView, SkillPackageView } from "../../../shared/types/extensions";
import type { SkillInventoryEntry } from "../api/native";

export type ExtensionSortOrder = "nameAsc" | "nameDesc";

/** Sort a copy, keeping equivalent names stable and numbers human-readable. */
export function sortExtensions<T extends { name: string }>(items: readonly T[], order: ExtensionSortOrder): T[] {
  const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...items].sort((left, right) => compare.compare(left.name, right.name) * (order === "nameDesc" ? -1 : 1));
}

/** Never turn unknown/protected/multiple installations into a destructive shortcut. */
export function skillCliPresentation(items: SkillInstallationView[], cli: ExtensionCli, inventory: SkillInventoryEntry[] = [], name = "", complete = true) {
  const matches = items.filter(item => item.cli === cli);
  const installation = matches[0];
  // Same-name external presence is not proof of content equality or ownership. Show it, but never delete it.
  const discovered = inventory.filter(item => item.cli === cli && item.name === name && !item.managed);
  const shared = discovered.filter(item => (item.sourceKind === "agent-compatible" && cli !== "codex") || item.sourceKind === "claude-compatible");
  const external = discovered.filter(item => !shared.includes(item));
  const present = external.some(item => item.status === "present");
  const enabled = present || matches.some(item => item.status === "active" || item.externalModified || item.status === "externalModified");
  const blocked = external.length > 0 || (!complete && !enabled) || matches.length > 1 || matches.some(item => !item.owned || item.externalModified
    || !["active", "missing"].includes(item.status));
  return { installation, enabled, blocked, external, shared };
}

/** One row per exact Skill name; keep every source/version ID for selection and installation ownership. */
export function groupSkillPackages(packages: SkillPackageView[]): SkillPackageView[][] {
  const groups = new Map<string, SkillPackageView[]>();
  for (const item of packages) {
    const group = groups.get(item.name) ?? [];
    group.push(item);
    groups.set(item.name, group);
  }
  return [...groups.values()];
}
