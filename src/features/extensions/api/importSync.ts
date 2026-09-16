import { invoke } from "@tauri-apps/api/core";
import { trackMcpMutation } from "../state/mcpPendingStore";
import { MCP_CLIS } from "../lib/mcpPending";

import type {
  ExtensionImportApplyRequest,
  ExtensionImportPreview,
  ExtensionImportRequest,
  ExtensionImportResult,
  GithubSkillInstallResult,
  GithubSkillPreview,
  GithubSkillRequest,
  SkillDeploymentRequest,
  SkillDeploymentResult,
  SkillInstallationView,
  SkillPackageView,
  SkillRestoreResult,
  SkillUninstallResult,
} from "../../../shared/types/extensions";

/** 只读预览原生 MCP、cc-switch 或外部 Skill 来源。 */
export function previewExtensionImport(
  request: ExtensionImportRequest,
): Promise<ExtensionImportPreview> {
  return invoke<ExtensionImportPreview>("extensions_import_preview", { request });
}

/** 以预览指纹为前提应用导入，并使用明确的冲突策略。 */
export function applyExtensionImport(
  request: ExtensionImportApplyRequest,
): Promise<ExtensionImportResult> {
  return trackMcpMutation(MCP_CLIS,
    () => invoke<ExtensionImportResult>("extensions_import_apply", { request }),
    result => result.items.some(item => item.kind === "mcp" && ["imported", "updated"].includes(item.status)));
}

/** 读取应用数据中的完整 Skill 包目录。 */
export function listManagedSkillPackages(): Promise<SkillPackageView[]> {
  return invoke<SkillPackageView[]>("extensions_skills_list_packages");
}

/** 读取指定供应商 Home 下的 Skill 部署实例和外部修改状态。 */
export function listManagedSkillInstallations(
  environmentKind: string,
  environmentId: string,
): Promise<SkillInstallationView[]> {
  return invoke<SkillInstallationView[]>("extensions_skills_list_installations", {
    environmentKind,
    environmentId,
  });
}

/** 将 Skill 包按 auto/symlink/copy 策略部署到明确环境。 */
export function deployManagedSkill(
  request: SkillDeploymentRequest,
): Promise<SkillDeploymentResult> {
  return invoke<SkillDeploymentResult>("extensions_skills_deploy", { request });
}

/** 卸载仍由应用所有的 Skill 目标。 */
export function uninstallManagedSkill(installationId: string): Promise<SkillUninstallResult> {
  return invoke<SkillUninstallResult>("extensions_skills_uninstall", { installationId });
}

/** 恢复最近一次受管备份。 */
export function restoreManagedSkill(installationId: string): Promise<SkillRestoreResult> {
  return invoke<SkillRestoreResult>("extensions_skills_restore", { installationId });
}

/** 预览 GitHub 固定 ref/commit 下的 Skill 候选。 */
export function previewGithubSkill(request: GithubSkillRequest): Promise<GithubSkillPreview> {
  return invoke<GithubSkillPreview>("extensions_github_skill_preview", { request });
}

/** 下载固定 commit 的完整 Skill 包并发布到应用数据目录。 */
export function installGithubSkill(request: GithubSkillRequest): Promise<GithubSkillInstallResult> {
  return invoke<GithubSkillInstallResult>("extensions_github_skill_install", { request });
}

/** 取消 GitHub 预览或安装请求。 */
export function cancelGithubSkill(operationId: string): Promise<void> {
  return invoke<void>("extensions_github_skill_cancel", { operationId });
}
