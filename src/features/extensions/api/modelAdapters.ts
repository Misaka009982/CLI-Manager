import { invoke } from "@tauri-apps/api/core";
import { trackMcpMutation } from "../state/mcpPendingStore";
import { MCP_CLIS } from "../lib/mcpPending";
import { getActiveNativeProviderHome } from "../../settings/api/nativeProviderHome";

import type {
  ExtensionCli,
  McpCliCapability,
  McpNativeConfigPreview,
  McpProjectionPreview,
  McpProjectionRequest,
  McpResource,
  McpResourceRedacted,
  McpValidationReport,
} from "../../../shared/types/extensions";

/** 读取三个 CLI 的静态 MCP 字段能力矩阵。 */
export function fetchExtensionMcpCapabilities(): Promise<McpCliCapability[]> {
  return invoke<McpCliCapability[]>("extensions_mcp_capabilities");
}

/** 在 Rust 边界校验一份规范 MCP 资源。 */
export function validateExtensionMcpResource(resource: McpResource): Promise<McpValidationReport> {
  return invoke<McpValidationReport>("extensions_mcp_validate", { resource });
}

/** 解析原生 MCP 配置，返回用于导入预览的脱敏资源。 */
export function parseExtensionNativeMcpConfig(
  cli: ExtensionCli,
  source: string,
): Promise<McpNativeConfigPreview> {
  return invoke<McpNativeConfigPreview>("extensions_mcp_parse_native", { cli, source });
}

/** 生成目标 CLI 的脱敏字段投影预览；unsupported 结果不可直接应用。 */
export function previewExtensionMcpProjection(
  request: McpProjectionRequest,
): Promise<McpProjectionPreview> {
  return invoke<McpProjectionPreview>("extensions_mcp_preview", { request });
}

/** 读取应用数据中的 MCP 资源列表，所有秘密字段已由后端脱敏。 */
export function listManagedMcpResources(): Promise<McpResourceRedacted[]> {
  return invoke<McpResourceRedacted[]>("extensions_mcp_list");
}

/** 读取单项应用托管 MCP 资源。 */
export function getManagedMcpResource(resourceId: string): Promise<McpResourceRedacted> {
  return invoke<McpResourceRedacted>("extensions_mcp_get", { resourceId });
}

/** 保存规范 MCP 资源；实际校验与 revision 处理由 Rust 仓储负责。 */
export function upsertManagedMcpResource(resource: McpResource): Promise<McpResourceRedacted> {
  return trackMcpMutation(MCP_CLIS, () => invoke<McpResourceRedacted>("extensions_mcp_upsert", { resource }));
}

/** 只更新一个 CLI 的启用开关，避免脱敏资源回写时覆盖受保护字段。 */
export function setManagedMcpResourceEnabled(
  resourceId: string,
  cli: ExtensionCli,
  enabled: boolean,
): Promise<McpResourceRedacted> {
  return trackMcpMutation([cli], () => invoke<McpResourceRedacted>("extensions_mcp_set_enabled", { resourceId, cli, enabled }));
}

/** Capture the displayed selection in one backend transaction; never partially seed a CLI. */
export async function saveManagedMcpSelection(
  resources: McpResourceRedacted[], clis: ExtensionCli[], expectedHome: string | undefined,
): Promise<McpResourceRedacted[]> {
  if (!expectedHome || (await getActiveNativeProviderHome()).identity.identity !== expectedHome) {
    throw new Error("extensions_native_preview_changed");
  }
  return trackMcpMutation(clis, () => invoke<McpResourceRedacted[]>("extensions_mcp_set_selection", {
    homeIdentity: expectedHome,
    items: resources.map(resource => ({ resourceId: resource.resourceId,
      enabledByCli: Object.fromEntries(clis.map(cli => [cli, resource.enabledByCli[cli]])) })),
  }), updated => updated.length > 0);
}

/** Only explicit icon intent changes a selection; the rest comes from the actual displayed baseline. */
export function setManagedMcpCliSelection(
  resources: McpResourceRedacted[], resourceId: string, cli: ExtensionCli, enabled: boolean, expectedHome: string | undefined,
): Promise<McpResourceRedacted[]> {
  return saveManagedMcpSelection(resources.map(resource => resource.resourceId === resourceId
    ? { ...resource, enabledByCli: { ...resource.enabledByCli, [cli]: enabled } } : resource), [cli], expectedHome);
}

/** 删除应用托管记录，不会删除 CLI 原生配置或外部技能文件。 */
export function deleteManagedMcpResource(resourceId: string): Promise<void> {
  return trackMcpMutation(MCP_CLIS, () => invoke<void>("extensions_mcp_delete", { resourceId }));
}
