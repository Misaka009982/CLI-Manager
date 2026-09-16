import { invoke } from "@tauri-apps/api/core";
import type { ExtensionCli } from "../../../shared/types/extensions";

export interface NativeMcpPreview {
  cli: ExtensionCli;
  format: "json" | "toml";
  path: string;
  fingerprint: string;
  existingKeys: string[];
  enabledKeys: string[];
  removedKeys: string[];
  changed: boolean;
  content: string;
}

export function previewNativeMcp(cli: ExtensionCli): Promise<NativeMcpPreview> {
  return invoke("extensions_mcp_native_preview", { cli });
}

export function readNativeMcpStatus(cli: ExtensionCli): Promise<{ homeIdentity: string; enabledKeys: string[] }> {
  return invoke("extensions_mcp_native_status", { cli });
}

export function applyNativeMcp(cli: ExtensionCli, fingerprint: string): Promise<{ path: string; backupPath: string | null; changed: boolean }> {
  return invoke("extensions_mcp_native_apply", { cli, fingerprint });
}

export interface SkillInventoryEntry {
  cli: ExtensionCli;
  name: string;
  path: string;
  sourceKind: string;
  status: string;
  linkTarget: string | null;
  importPath: string | null;
  managed: boolean;
}

export function inspectSkillInventory(): Promise<{ entries: SkillInventoryEntry[]; warnings: string[] }> {
  return invoke("extensions_skills_inventory");
}
