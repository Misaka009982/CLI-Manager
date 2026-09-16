use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use uuid::Uuid;

use super::skill_deployment::{
    ensure_child_path, ensure_owned_directory, installation_view, mode_string, path_string,
    read_backup_metadata, remove_path_if_present, scan_skill_package, skills_root,
    validate_managed_backup_path, validate_managed_package, validate_skill_display_name,
    SkillDeploymentRequest, SkillDeploymentResult, SkillRestoreResult, SkillSourceMetadata,
    SkillSyncMode, SkillUninstallResult, TargetState,
};
use super::skill_repository::{self, SkillInstallationRecord, SkillPackageRecord};

const WSL_FS_TIMEOUT: Duration = Duration::from_secs(30);
const WSL_OUTPUT_LIMIT: usize = 8 * 1024;

// 统一 WSL 分支入口；非 Windows 编译目标只返回不可用，不把 UNC 当成本机路径写入。
pub(crate) async fn deploy(
    request: SkillDeploymentRequest,
    package: SkillPackageRecord,
    target_root: PathBuf,
) -> Result<SkillDeploymentResult, String> {
    #[cfg(target_os = "windows")]
    {
        return deploy_windows(request, package, target_root).await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (request, package, target_root);
        Err("extensions_wsl_unsupported".to_string())
    }
}

// WSL 记录使用发行版内实时检查；非 Windows 明确显示不支持。
pub(crate) async fn inspect_installation(
    record: &SkillInstallationRecord,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        return inspect_installation_windows(record).await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = record;
        Ok("unsupported".to_string())
    }
}

// WSL 卸载只删除由链接目标或副本哈希证明归属的单层 Skill 目录。
pub(crate) async fn uninstall(
    record: SkillInstallationRecord,
) -> Result<SkillUninstallResult, String> {
    #[cfg(target_os = "windows")]
    {
        return uninstall_windows(record).await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = record;
        Err("extensions_wsl_unsupported".to_string())
    }
}

// WSL 恢复复用同一份受管备份，并在发行版内完成临时发布。
pub(crate) async fn restore(record: SkillInstallationRecord) -> Result<SkillRestoreResult, String> {
    #[cfg(target_os = "windows")]
    {
        return restore_windows(record).await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = record;
        Err("extensions_wsl_unsupported".to_string())
    }
}

#[cfg(target_os = "windows")]
fn validate_wsl_record_target(record: &SkillInstallationRecord) -> Result<(), String> {
    if record.environment_kind != "wsl" {
        return Err("extensions_skill_environment_mismatch".to_string());
    }
    if !record.owned {
        return Err("extensions_skill_not_owned".to_string());
    }
    let root = super::skill_deployment::skill_target(&path_string(&record.home_path), record.cli)?;
    let (root_distro, root_linux) = crate::wsl::parse_wsl_unc_path(&path_string(&root))
        .ok_or_else(|| "extensions_skill_environment_mismatch".to_string())?;
    let (target_distro, target_linux) =
        crate::wsl::parse_wsl_unc_path(&path_string(&record.target_path))
            .ok_or_else(|| "extensions_skill_environment_mismatch".to_string())?;
    if !is_safe_wsl_distro(&root_distro)
        || root_distro != target_distro
        || record.environment_id != root_distro
        || !is_safe_linux_absolute(&root_linux)
        || !is_safe_linux_absolute(&target_linux)
        || !is_direct_child_linux_path(&root_linux, &target_linux)
    {
        return Err("extensions_skill_target_invalid".to_string());
    }
    let name = target_linux
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "extensions_skill_target_invalid".to_string())?;
    validate_skill_display_name(name)
}

#[cfg(target_os = "windows")]
fn is_safe_wsl_distro(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

#[cfg(target_os = "windows")]
fn is_safe_linux_absolute(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && !path.starts_with("//")
        && !path.split('/').any(|part| part == "." || part == "..")
}

#[cfg(target_os = "windows")]
fn is_direct_child_linux_path(root: &str, child: &str) -> bool {
    let root = root.trim_end_matches('/');
    let Some(relative) = child.strip_prefix(root) else {
        return false;
    };
    let Some(name) = relative.strip_prefix('/') else {
        return false;
    };
    !name.is_empty() && !name.contains('/') && name != "." && name != ".."
}

#[cfg(target_os = "windows")]
async fn inspect_installation_windows(record: &SkillInstallationRecord) -> Result<String, String> {
    if !record.owned {
        return Ok("externalModified".to_string());
    }
    if validate_wsl_record_target(record).is_err() {
        return Ok("unreadable".to_string());
    }
    let Some((distro, linux_path)) =
        crate::wsl::parse_wsl_unc_path(&path_string(&record.target_path))
    else {
        return Ok("unreadable".to_string());
    };
    let expected_link = record.link_target.as_ref().map(|path| path_to_linux(path));
    let expected_hash = (record.actual_mode == "copy").then_some(record.deployed_hash.as_str());
    match inspect_wsl_target_sync(
        &distro,
        &linux_path,
        expected_link.as_deref(),
        expected_hash,
    )? {
        TargetState::Missing => Ok("missing".to_string()),
        TargetState::External => Ok("externalModified".to_string()),
        TargetState::Owned => Ok("active".to_string()),
        TargetState::Error(_) => Ok("unreadable".to_string()),
    }
}

#[cfg(target_os = "windows")]
async fn deploy_windows(
    request: SkillDeploymentRequest,
    package: SkillPackageRecord,
    target_root: PathBuf,
) -> Result<SkillDeploymentResult, String> {
    let skill_name = package.name.clone();
    validate_skill_display_name(&skill_name)?;
    let target_path = target_root.join(&skill_name);
    let target_text = path_string(&target_path);
    let (distro, target_linux) = crate::wsl::parse_wsl_unc_path(&target_text)
        .ok_or_else(|| "extensions_skill_environment_mismatch".to_string())?;
    let root_text = path_string(&target_root);
    let (root_distro, target_linux_root) = crate::wsl::parse_wsl_unc_path(&root_text)
        .ok_or_else(|| "extensions_skill_environment_mismatch".to_string())?;
    if root_distro != distro
        || request.environment_id != distro
        || !is_safe_wsl_distro(&distro)
        || !is_safe_linux_absolute(&target_linux_root)
        || !is_safe_linux_absolute(&target_linux)
        || !is_direct_child_linux_path(&target_linux_root, &target_linux)
    {
        return Err("extensions_skill_environment_mismatch".to_string());
    }
    let source_linux = crate::wsl::windows_path_to_wsl(&path_string(&package.package_path))
        .ok_or_else(|| "extensions_wsl_source_unavailable".to_string())?;
    if !is_safe_linux_absolute(&source_linux) {
        return Err("extensions_wsl_source_unavailable".to_string());
    }
    let parent_linux = target_linux_root.trim_end_matches('/');
    ensure_wsl_directory_chain(&distro, parent_linux)?;

    let existing = skill_repository::get_installation_for_target(
        &request.environment_kind,
        &request.environment_id,
        request.cli,
        &target_path,
    )
    .await?;
    let mut backup_path = None;
    if let Some(record) = existing.as_ref() {
        validate_wsl_record_target(record)?;
        if record.external_modified {
            return Err("extensions_skill_external_modified".to_string());
        }
        let expected_link = record.link_target.as_ref().map(|path| path_to_linux(path));
        let expected_hash = (record.actual_mode == "copy").then_some(record.deployed_hash.as_str());
        match inspect_wsl_target_sync(
            &distro,
            &target_linux,
            expected_link.as_deref(),
            expected_hash,
        )? {
            TargetState::Owned => {
                if record.package_id == package.package_id
                    && record.deployed_hash == package.content_hash
                {
                    return Ok(SkillDeploymentResult {
                        installation: installation_view(record, "active".to_string()),
                        changed: false,
                        backup_path: record.backup_path.as_ref().map(|path| path_string(path)),
                    });
                }
                backup_path = backup_wsl_target(&distro, &target_linux, record)?;
            }
            TargetState::Missing => {}
            TargetState::External => return Err("extensions_skill_external_modified".to_string()),
            TargetState::Error(error) => return Err(error),
        }
    } else {
        match inspect_wsl_target_sync(&distro, &target_linux, None, None)? {
            TargetState::Missing => {}
            TargetState::External | TargetState::Owned => {
                return Err("extensions_skill_target_conflict".to_string())
            }
            TargetState::Error(error) => return Err(error),
        }
    }

    let stage_linux = format!("{}/.cli-manager-skill-{}", parent_linux, Uuid::new_v4());
    let (actual_mode, link_target) =
        match stage_wsl_package(&distro, &source_linux, &stage_linux, request.mode) {
            Ok(value) => value,
            Err(error) => {
                let _ = remove_wsl_path(&distro, &stage_linux);
                return Err(error);
            }
        };

    if let Some(record) = existing.as_ref() {
        let expected_link = record.link_target.as_ref().map(|path| path_to_linux(path));
        let expected_hash = (record.actual_mode == "copy").then_some(record.deployed_hash.as_str());
        match inspect_wsl_target_sync(
            &distro,
            &target_linux,
            expected_link.as_deref(),
            expected_hash,
        )? {
            TargetState::Owned | TargetState::Missing => {}
            TargetState::External => {
                let _ = remove_wsl_path(&distro, &stage_linux);
                let _ =
                    skill_repository::mark_external_modified(&record.installation_id, true).await;
                return Err("extensions_skill_external_modified".to_string());
            }
            TargetState::Error(error) => {
                let _ = remove_wsl_path(&distro, &stage_linux);
                return Err(error);
            }
        }
        match inspect_wsl_target_sync(
            &distro,
            &target_linux,
            expected_link.as_deref(),
            expected_hash,
        )? {
            TargetState::Owned => {
                if let Err(error) = remove_wsl_target(
                    &distro,
                    &target_linux,
                    expected_link.as_deref(),
                    expected_hash,
                ) {
                    let _ = remove_wsl_path(&distro, &stage_linux);
                    return Err(error);
                }
            }
            TargetState::Missing => {}
            TargetState::External => {
                let _ = remove_wsl_path(&distro, &stage_linux);
                let _ =
                    skill_repository::mark_external_modified(&record.installation_id, true).await;
                return Err("extensions_skill_external_modified".to_string());
            }
            TargetState::Error(error) => {
                let _ = remove_wsl_path(&distro, &stage_linux);
                return Err(error);
            }
        }
    } else if inspect_wsl_target_sync(&distro, &target_linux, None, None)? != TargetState::Missing {
        let _ = remove_wsl_path(&distro, &stage_linux);
        return Err("extensions_skill_target_conflict".to_string());
    }

    if let Err(error) = publish_wsl_stage(&distro, &stage_linux, &target_linux) {
        let _ = remove_wsl_path(&distro, &stage_linux);
        if let Some(backup) = backup_path.as_ref() {
            let _ = restore_wsl_backup_target(&distro, &target_linux, parent_linux, backup);
        }
        return Err(error);
    }
    let deployed_link = link_target.as_ref().map(|path| path_to_linux(path));
    let deployed_hash = (actual_mode == "copy").then_some(package.content_hash.as_str());
    if !matches!(
        inspect_wsl_target_sync(
            &distro,
            &target_linux,
            deployed_link.as_deref(),
            deployed_hash,
        )?,
        TargetState::Owned
    ) {
        return Err("extensions_skill_target_verification_failed".to_string());
    }
    let now = skill_repository::now_ms();
    let record = SkillInstallationRecord {
        installation_id: existing
            .as_ref()
            .map(|record| record.installation_id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        package_id: package.package_id,
        environment_kind: request.environment_kind,
        environment_id: request.environment_id,
        cli: request.cli,
        home_path: PathBuf::from(request.home_path),
        target_path: target_path.clone(),
        requested_mode: mode_string(request.mode).to_string(),
        actual_mode,
        link_target,
        deployed_hash: package.content_hash.clone(),
        owned: true,
        external_modified: false,
        backup_path: backup_path.clone(),
        created_at_ms: existing
            .as_ref()
            .map(|record| record.created_at_ms)
            .unwrap_or(now),
        updated_at_ms: now,
    };
    if let Err(error) = skill_repository::upsert_installation(&record).await {
        let _ = remove_wsl_target(
            &distro,
            &target_linux,
            deployed_link.as_deref(),
            deployed_hash,
        );
        if let Some(backup) = backup_path.as_ref() {
            let _ = restore_wsl_backup_target(&distro, &target_linux, parent_linux, backup);
        }
        return Err(error);
    }
    if let Some(previous) = existing
        .as_ref()
        .and_then(|record| record.backup_path.as_ref())
        .filter(|previous| Some(*previous) != record.backup_path.as_ref())
    {
        if validate_managed_backup_path(previous).is_ok() {
            let _ = remove_path_if_present(previous);
        }
    }
    Ok(SkillDeploymentResult {
        installation: installation_view(&record, "active".to_string()),
        changed: true,
        backup_path: backup_path.map(|path| path_string(&path)),
    })
}

#[cfg(target_os = "windows")]
fn stage_wsl_package(
    distro: &str,
    source: &str,
    stage: &str,
    mode: SkillSyncMode,
) -> Result<(String, Option<PathBuf>), String> {
    match mode {
        SkillSyncMode::Copy => {
            copy_tree_in_wsl(distro, source, stage)?;
            Ok(("copy".to_string(), None))
        }
        SkillSyncMode::Symlink => {
            let output = run_wsl_command(distro, "ln", &["-s", "--", source, stage])?;
            require_wsl_success(output, "extensions_skill_symlink_failed")?;
            Ok(("symlink".to_string(), Some(PathBuf::from(source))))
        }
        SkillSyncMode::Auto => match run_wsl_command(distro, "ln", &["-s", "--", source, stage]) {
            Ok(output) if output.status.success() => {
                Ok(("symlink".to_string(), Some(PathBuf::from(source))))
            }
            Ok(output) if is_wsl_link_fallback_error(&output) => {
                let _ = remove_wsl_path(distro, stage);
                copy_tree_in_wsl(distro, source, stage)?;
                Ok(("copy".to_string(), None))
            }
            Ok(_) => Err("extensions_skill_symlink_failed".to_string()),
            Err(error) => Err(error),
        },
    }
}

#[cfg(target_os = "windows")]
fn copy_tree_in_wsl(distro: &str, source: &str, target: &str) -> Result<(), String> {
    let output = run_wsl_python(distro, WSL_COPY_TREE_SCRIPT, &[source, target])?;
    require_bounded_success(output, "extensions_skill_copy_failed")
}

#[cfg(target_os = "windows")]
fn publish_wsl_stage(distro: &str, stage: &str, target: &str) -> Result<(), String> {
    let parent = target
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .ok_or_else(|| "extensions_skill_target_invalid".to_string())?;
    ensure_wsl_directory_chain(distro, parent)?;
    let output = run_wsl_command(distro, "mv", &["-nT", "--", stage, target])?;
    if !output.status.success() {
        return Err("extensions_skill_target_publish_failed".to_string());
    }
    let state = run_wsl_python(distro, WSL_PUBLISH_STATE_SCRIPT, &[stage, target])?;
    if !state.status.success() || state.stdout_truncated {
        return Err("extensions_skill_target_publish_failed".to_string());
    }
    match first_line(&state.stdout) {
        "moved" => Ok(()),
        "target" => Err("extensions_skill_target_conflict".to_string()),
        _ => Err("extensions_skill_target_publish_failed".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn backup_wsl_target(
    distro: &str,
    target: &str,
    record: &SkillInstallationRecord,
) -> Result<Option<PathBuf>, String> {
    let root = skills_root()?.join("backups");
    ensure_owned_directory(&root)?;
    let backup = root.join(format!("{}-{}", record.installation_id, Uuid::new_v4()));
    ensure_child_path(&root, &backup)?;
    let backup_linux = crate::wsl::windows_path_to_wsl(&path_string(&backup))
        .ok_or_else(|| "extensions_wsl_backup_unavailable".to_string())?;
    let output = run_wsl_python(distro, WSL_BACKUP_SCRIPT, &[target, &backup_linux])?;
    if !output.status.success() || output.stdout_truncated {
        let _ = remove_path_if_present(&backup);
        return Err("extensions_skill_backup_failed".to_string());
    }
    match first_line(&output.stdout) {
        "missing" => Ok(None),
        "ok" => {
            if let Err(error) = super::skill_deployment::write_backup_metadata(&backup, record) {
                let _ = remove_path_if_present(&backup);
                return Err(error);
            }
            Ok(Some(backup))
        }
        _ => {
            let _ = remove_path_if_present(&backup);
            Err("extensions_skill_backup_failed".to_string())
        }
    }
}

#[cfg(target_os = "windows")]
async fn restore_windows(record: SkillInstallationRecord) -> Result<SkillRestoreResult, String> {
    validate_wsl_record_target(&record)?;
    let backup = record
        .backup_path
        .clone()
        .ok_or_else(|| "extensions_skill_backup_not_found".to_string())?;
    validate_managed_backup_path(&backup)?;
    let metadata = read_backup_metadata(&backup)?;
    let Some((distro, target_linux)) =
        crate::wsl::parse_wsl_unc_path(&path_string(&record.target_path))
    else {
        return Err("extensions_skill_environment_mismatch".to_string());
    };
    let parent_linux = target_linux
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .ok_or_else(|| "extensions_skill_target_invalid".to_string())?;
    ensure_wsl_directory_chain(&distro, parent_linux)?;
    let current_link = record.link_target.as_ref().map(|path| path_to_linux(path));
    let current_hash = (record.actual_mode == "copy").then_some(record.deployed_hash.as_str());
    match inspect_wsl_target_sync(
        &distro,
        &target_linux,
        current_link.as_deref(),
        current_hash,
    )? {
        TargetState::External => return Err("extensions_skill_external_modified".to_string()),
        TargetState::Error(error) => return Err(error),
        TargetState::Missing | TargetState::Owned => {}
    }

    let payload = backup.join("payload");
    let link_file = backup.join("link-target.txt");
    let (expected_mode, deployed_hash, link_target, package_id) = if payload.is_dir() {
        let candidate = scan_skill_package(
            &payload,
            SkillSourceMetadata {
                source_kind: "backup".to_string(),
                source_identity: path_string(&backup),
                source_ref: String::new(),
                resolved_commit: None,
                subdirectory: String::new(),
                version: None,
            },
        )?;
        if let Some(metadata) = metadata.as_ref() {
            if metadata.actual_mode != "copy" || metadata.deployed_hash != candidate.content_hash {
                return Err("extensions_skill_backup_invalid".to_string());
            }
        }
        (
            "copy",
            candidate.content_hash,
            None,
            metadata
                .as_ref()
                .map(|value| value.package_id.clone())
                .unwrap_or_else(|| record.package_id.clone()),
        )
    } else {
        if metadata
            .as_ref()
            .is_some_and(|value| value.actual_mode != "symlink")
        {
            return Err("extensions_skill_backup_invalid".to_string());
        }
        let link = read_backup_link(&link_file)?;
        let expected = metadata
            .as_ref()
            .and_then(|value| value.link_target.as_deref())
            .or_else(|| current_link.as_deref())
            .ok_or_else(|| "extensions_skill_backup_invalid".to_string())?;
        if !same_linux_path(&link, expected) {
            return Err("extensions_skill_backup_invalid".to_string());
        }
        (
            "symlink",
            metadata
                .as_ref()
                .map(|value| value.deployed_hash.clone())
                .unwrap_or_else(|| record.deployed_hash.clone()),
            Some(link),
            metadata
                .as_ref()
                .map(|value| value.package_id.clone())
                .unwrap_or_else(|| record.package_id.clone()),
        )
    };
    let package = skill_repository::get_package(&package_id).await?;
    if package.content_hash != deployed_hash {
        return Err("extensions_skill_backup_package_mismatch".to_string());
    }
    if expected_mode == "symlink" {
        let Some(link_target) = link_target.as_ref() else {
            return Err("extensions_skill_backup_invalid".to_string());
        };
        let package_source = crate::wsl::windows_path_to_wsl(&path_string(&package.package_path))
            .ok_or_else(|| "extensions_wsl_source_unavailable".to_string())?;
        if !same_linux_path(link_target, &package_source) {
            return Err("extensions_skill_backup_invalid".to_string());
        }
        validate_managed_package(&package)?;
    }

    let backup_linux = crate::wsl::windows_path_to_wsl(&path_string(&backup))
        .ok_or_else(|| "extensions_wsl_backup_unavailable".to_string())?;
    let stage_linux = format!(
        "{}/.cli-manager-skill-restore-{}",
        parent_linux,
        Uuid::new_v4()
    );
    let staged_mode = stage_wsl_backup(&distro, &backup_linux, &stage_linux)?;
    if staged_mode != expected_mode {
        let _ = remove_wsl_path(&distro, &stage_linux);
        return Err("extensions_skill_backup_invalid".to_string());
    }
    match inspect_wsl_target_sync(
        &distro,
        &target_linux,
        current_link.as_deref(),
        current_hash,
    )? {
        TargetState::Owned | TargetState::Missing => {}
        TargetState::External => {
            let _ = remove_wsl_path(&distro, &stage_linux);
            return Err("extensions_skill_external_modified".to_string());
        }
        TargetState::Error(error) => {
            let _ = remove_wsl_path(&distro, &stage_linux);
            return Err(error);
        }
    }
    let rollback_backup = match inspect_wsl_target_sync(
        &distro,
        &target_linux,
        current_link.as_deref(),
        current_hash,
    )? {
        TargetState::Owned => match backup_wsl_target(&distro, &target_linux, &record) {
            Ok(backup) => backup,
            Err(error) => {
                let _ = remove_wsl_path(&distro, &stage_linux);
                return Err(error);
            }
        },
        TargetState::Missing => None,
        TargetState::External => {
            let _ = remove_wsl_path(&distro, &stage_linux);
            return Err("extensions_skill_external_modified".to_string());
        }
        TargetState::Error(error) => {
            let _ = remove_wsl_path(&distro, &stage_linux);
            return Err(error);
        }
    };
    match inspect_wsl_target_sync(
        &distro,
        &target_linux,
        current_link.as_deref(),
        current_hash,
    )? {
        TargetState::Owned => {
            if let Err(error) = remove_wsl_target(
                &distro,
                &target_linux,
                current_link.as_deref(),
                current_hash,
            ) {
                let _ = remove_wsl_path(&distro, &stage_linux);
                if let Some(rollback) = rollback_backup.as_ref() {
                    let _ = remove_path_if_present(rollback);
                }
                return Err(error);
            }
        }
        TargetState::Missing => {}
        TargetState::External => {
            let _ = remove_wsl_path(&distro, &stage_linux);
            if let Some(backup) = rollback_backup.as_ref() {
                let _ = remove_path_if_present(backup);
            }
            return Err("extensions_skill_external_modified".to_string());
        }
        TargetState::Error(error) => {
            let _ = remove_wsl_path(&distro, &stage_linux);
            if let Some(backup) = rollback_backup.as_ref() {
                let _ = remove_path_if_present(backup);
            }
            return Err(error);
        }
    }
    if let Err(error) = publish_wsl_stage(&distro, &stage_linux, &target_linux) {
        let _ = remove_wsl_path(&distro, &stage_linux);
        if let Some(backup) = rollback_backup.as_ref() {
            let _ = restore_wsl_backup_target(&distro, &target_linux, parent_linux, backup);
        }
        return Err(error);
    }
    let restored_link = link_target.clone();
    let restored_hash = (expected_mode == "copy").then_some(deployed_hash.as_str());
    if !matches!(
        inspect_wsl_target_sync(
            &distro,
            &target_linux,
            restored_link.as_deref(),
            restored_hash,
        )?,
        TargetState::Owned
    ) {
        return Err("extensions_skill_target_verification_failed".to_string());
    }
    let mut restored = record.clone();
    restored.package_id = package_id;
    restored.actual_mode = expected_mode.to_string();
    restored.deployed_hash = deployed_hash.to_string();
    restored.link_target = link_target.map(PathBuf::from);
    restored.external_modified = false;
    restored.updated_at_ms = skill_repository::now_ms();
    if let Err(error) = skill_repository::upsert_installation(&restored).await {
        let _ = remove_wsl_target(
            &distro,
            &target_linux,
            restored_link.as_deref(),
            restored_hash,
        );
        if let Some(rollback) = rollback_backup.as_ref() {
            let _ = restore_wsl_backup_target(&distro, &target_linux, parent_linux, rollback);
        }
        return Err(error);
    }
    if let Some(rollback) = rollback_backup.as_ref() {
        let _ = remove_path_if_present(rollback);
    }
    Ok(SkillRestoreResult {
        installation: installation_view(&restored, "restored".to_string()),
        restored_from: path_string(&backup),
    })
}

#[cfg(target_os = "windows")]
fn read_backup_link(path: &Path) -> Result<String, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "extensions_skill_backup_invalid".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4096 {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    let value = fs::read_to_string(path)
        .map_err(|_| "extensions_skill_backup_invalid".to_string())?
        .trim_end_matches(['\r', '\n'])
        .to_string();
    if !is_safe_linux_absolute(&value) {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    Ok(value)
}

#[cfg(target_os = "windows")]
fn stage_wsl_backup(distro: &str, backup: &str, stage: &str) -> Result<String, String> {
    let output = run_wsl_python(distro, WSL_RESTORE_SCRIPT, &[backup, stage])?;
    if !output.status.success() || output.stdout_truncated {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    match first_line(&output.stdout) {
        "copy" | "symlink" => Ok(first_line(&output.stdout).to_string()),
        _ => Err("extensions_skill_backup_invalid".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn restore_wsl_backup_target(
    distro: &str,
    target: &str,
    parent: &str,
    backup: &Path,
) -> Result<(), String> {
    let backup_linux = crate::wsl::windows_path_to_wsl(&path_string(backup))
        .ok_or_else(|| "extensions_wsl_backup_unavailable".to_string())?;
    let stage = format!("{}/.cli-manager-skill-recovery-{}", parent, Uuid::new_v4());
    stage_wsl_backup(distro, &backup_linux, &stage)?;
    match inspect_wsl_target_sync(distro, target, None, None)? {
        TargetState::Missing => {}
        TargetState::External | TargetState::Owned => {
            let _ = remove_wsl_path(distro, &stage);
            return Err("extensions_skill_restore_conflict".to_string());
        }
        TargetState::Error(error) => {
            let _ = remove_wsl_path(distro, &stage);
            return Err(error);
        }
    }
    publish_wsl_stage(distro, &stage, target)
}

#[cfg(target_os = "windows")]
async fn uninstall_windows(
    record: SkillInstallationRecord,
) -> Result<SkillUninstallResult, String> {
    validate_wsl_record_target(&record)?;
    let Some((distro, linux_path)) =
        crate::wsl::parse_wsl_unc_path(&path_string(&record.target_path))
    else {
        return Err("extensions_skill_environment_mismatch".to_string());
    };
    let expected_link = record.link_target.as_ref().map(|path| path_to_linux(path));
    let expected_hash = (record.actual_mode == "copy").then_some(record.deployed_hash.as_str());
    match inspect_wsl_target_sync(
        &distro,
        &linux_path,
        expected_link.as_deref(),
        expected_hash,
    )? {
        TargetState::Missing => {}
        TargetState::External => {
            let _ = skill_repository::mark_external_modified(&record.installation_id, true).await;
            return Err("extensions_skill_external_modified".to_string());
        }
        TargetState::Owned => {
            remove_wsl_target(
                &distro,
                &linux_path,
                expected_link.as_deref(),
                expected_hash,
            )?;
        }
        TargetState::Error(error) => return Err(error),
    }
    let backup_path = record.backup_path.as_ref().map(|path| path_string(path));
    if record.backup_path.is_some() {
        let mut retained = record.clone();
        retained.external_modified = false;
        retained.updated_at_ms = skill_repository::now_ms();
        skill_repository::upsert_installation(&retained).await?;
    } else {
        skill_repository::delete_installation(&record.installation_id).await?;
    }
    Ok(SkillUninstallResult {
        installation_id: record.installation_id,
        removed: true,
        external_modified: false,
        backup_path,
    })
}

#[cfg(target_os = "windows")]
fn remove_wsl_target(
    distro: &str,
    path: &str,
    expected_link: Option<&str>,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    let output = run_wsl_python(
        distro,
        WSL_REMOVE_OWNED_SCRIPT,
        &[
            path,
            expected_link.unwrap_or_default(),
            expected_hash.unwrap_or_default(),
        ],
    )?;
    if !output.status.success() || output.stdout_truncated {
        return Err("extensions_skill_target_remove_failed".to_string());
    }
    match first_line(&output.stdout) {
        "removed" | "missing" => Ok(()),
        "external" => Err("extensions_skill_external_modified".to_string()),
        _ => Err("extensions_skill_target_remove_failed".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn remove_wsl_path(distro: &str, path: &str) -> Result<(), String> {
    let output = run_wsl_python(distro, WSL_REMOVE_STAGING_SCRIPT, &[path])?;
    if !output.status.success() || output.stdout_truncated {
        return Err("extensions_skill_target_remove_failed".to_string());
    }
    match first_line(&output.stdout) {
        "removed" | "missing" => Ok(()),
        _ => Err("extensions_skill_target_remove_failed".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn is_wsl_link_fallback_error(output: &std::process::Output) -> bool {
    let text = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    text.contains("permission denied")
        || text.contains("operation not permitted")
        || text.contains("operation not supported")
        || text.contains("not supported")
}

#[cfg(target_os = "windows")]
fn require_wsl_success(
    output: std::process::Output,
    error_code: &'static str,
) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(error_code.to_string())
    }
}

#[cfg(target_os = "windows")]
fn require_bounded_success(
    output: crate::shell_resolver::BoundedOutput,
    error_code: &'static str,
) -> Result<(), String> {
    if output.status.success() && !output.stdout_truncated {
        Ok(())
    } else {
        Err(error_code.to_string())
    }
}

#[cfg(target_os = "windows")]
fn run_wsl_python(
    distro: &str,
    script: &str,
    args: &[&str],
) -> Result<crate::shell_resolver::BoundedOutput, String> {
    let exe = crate::wsl::find_wsl_exe().ok_or_else(|| "extensions_wsl_unavailable".to_string())?;
    let mut command = crate::shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .args(["--exec", "python3", "-c", script])
        .args(args);
    crate::shell_resolver::output_with_timeout_bounded(command, WSL_FS_TIMEOUT, WSL_OUTPUT_LIMIT)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::TimedOut {
                "extensions_wsl_timeout".to_string()
            } else {
                "extensions_wsl_command_failed".to_string()
            }
        })
}

#[cfg(target_os = "windows")]
fn ensure_wsl_directory_chain(distro: &str, path: &str) -> Result<(), String> {
    let output = run_wsl_python(distro, WSL_ENSURE_DIRECTORY_SCRIPT, &[path])?;
    require_bounded_success(output, "extensions_skill_target_parent_create_failed")
}

#[cfg(target_os = "windows")]
fn run_wsl_command(
    distro: &str,
    program: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    let exe = crate::wsl::find_wsl_exe().ok_or_else(|| "extensions_wsl_unavailable".to_string())?;
    let mut command = crate::shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg(program)
        .args(args);
    crate::shell_resolver::output_with_timeout(command, WSL_FS_TIMEOUT).map_err(|error| {
        if error.kind() == io::ErrorKind::TimedOut {
            "extensions_wsl_timeout".to_string()
        } else {
            "extensions_wsl_command_failed".to_string()
        }
    })
}

#[cfg(target_os = "windows")]
fn inspect_wsl_target_sync(
    distro: &str,
    path: &str,
    expected_link: Option<&str>,
    expected_hash: Option<&str>,
) -> Result<TargetState, String> {
    let output = run_wsl_python(
        distro,
        WSL_INSPECT_SCRIPT,
        &[
            path,
            expected_link.unwrap_or_default(),
            expected_hash.unwrap_or_default(),
        ],
    )?;
    if !output.status.success() || output.stdout_truncated {
        return Err("extensions_wsl_command_failed".to_string());
    }
    match first_line(&output.stdout) {
        "missing" => Ok(TargetState::Missing),
        "owned-dir" | "owned-link" => Ok(TargetState::Owned),
        "external" => Ok(TargetState::External),
        _ => Err("extensions_wsl_target_unreadable".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn path_to_linux(path: &Path) -> String {
    path_string(path).replace('\\', "/")
}

#[cfg(target_os = "windows")]
fn same_linux_path(left: &str, right: &str) -> bool {
    left.replace('\\', "/").trim_end_matches('/') == right.replace('\\', "/").trim_end_matches('/')
}

#[cfg(target_os = "windows")]
fn first_line(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|text| text.lines().next())
        .unwrap_or_default()
}

const WSL_ENSURE_DIRECTORY_SCRIPT: &str = r#"
import os, stat, sys
path = sys.argv[1]
if not path.startswith('/') or any(part in ('.', '..', '') for part in path[1:].split('/')):
    raise SystemExit(1)
current = '/'
try:
    for part in path.strip('/').split('/') if path != '/' else []:
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            os.mkdir(current)
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise SystemExit(1)
    print('ok')
except Exception:
    raise SystemExit(1)
"#;

const WSL_INSPECT_SCRIPT: &str = r#"
import hashlib, os, stat, struct, sys
p = sys.argv[1]
expected_link = sys.argv[2]
expected_hash = sys.argv[3]
def safe_parent(path):
    parent = os.path.dirname(path)
    if not parent.startswith('/'):
        return False
    current = '/'
    parts = parent.strip('/').split('/') if parent != '/' else []
    for part in parts:
        if not part or part in ('.', '..'):
            return False
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except OSError:
            return False
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return False
    return True
if not safe_parent(p):
    print('external')
    raise SystemExit(0)
if not os.path.lexists(p):
    print('missing')
    raise SystemExit(0)
if os.path.islink(p):
    link = os.readlink(p)
    if expected_link and os.path.normpath(link) == os.path.normpath(expected_link):
        print('owned-link')
    else:
        print('external')
    raise SystemExit(0)
if not os.path.isdir(p):
    print('external')
    raise SystemExit(0)
h = hashlib.sha256()
files = []
for root, dirs, names in os.walk(p, topdown=True, followlinks=False):
    dirs[:] = sorted(dirs)
    names = sorted(names)
    if root.count(os.sep) - p.count(os.sep) > 24:
        print('external')
        raise SystemExit(0)
    if any(os.path.islink(os.path.join(root, name)) for name in dirs):
        print('external')
        raise SystemExit(0)
    for name in names:
        full = os.path.join(root, name)
        if os.path.islink(full) or not os.path.isfile(full):
            print('external')
            raise SystemExit(0)
        rel = os.path.relpath(full, p).replace(os.sep, '/')
        if os.path.getsize(full) > 16 * 1024 * 1024:
            print('external')
            raise SystemExit(0)
        files.append((rel, full))
        if len(files) > 2048:
            print('external')
            raise SystemExit(0)
files.sort(key=lambda item: item[0])
total_bytes = 0
for rel, full in files:
    with open(full, 'rb') as f:
        data = f.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024:
        print('external')
        raise SystemExit(0)
    total_bytes += len(data)
    if total_bytes > 128 * 1024 * 1024:
        print('external')
        raise SystemExit(0)
    rel_bytes = rel.encode()
    h.update(struct.pack('<Q', len(rel_bytes)) + rel_bytes)
    h.update(struct.pack('<Q', len(data)) + data)
digest = 'sha256:' + h.hexdigest()
print('owned-dir' if expected_hash and digest == expected_hash else 'external')
"#;

const WSL_COPY_TREE_SCRIPT: &str = r#"
import os, stat, sys
source, target = sys.argv[1], sys.argv[2]
MAX_FILES = 2048
MAX_BYTES = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_DEPTH = 24
count = 0
total = 0
def safe_name(name):
    return name not in ('.', '..') and '/' not in name and '\x00' not in name
def safe_parent(path):
    parent = os.path.dirname(path)
    if not parent.startswith('/'):
        return False
    current = '/'
    parts = parent.strip('/').split('/') if parent != '/' else []
    for part in parts:
        if not part or part in ('.', '..'):
            return False
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except OSError:
            return False
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return False
    return True
def copy_tree(src, dst, depth):
    global count, total
    if depth > MAX_DEPTH:
        raise RuntimeError('depth')
    st = os.lstat(src)
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
        raise RuntimeError('source')
    os.mkdir(dst)
    for name in sorted(os.listdir(src)):
        if not safe_name(name):
            raise RuntimeError('name')
        src_child = os.path.join(src, name)
        dst_child = os.path.join(dst, name)
        st = os.lstat(src_child)
        if stat.S_ISLNK(st.st_mode):
            raise RuntimeError('link')
        if stat.S_ISDIR(st.st_mode):
            copy_tree(src_child, dst_child, depth + 1)
        elif stat.S_ISREG(st.st_mode):
            if st.st_size > MAX_FILE:
                raise RuntimeError('file')
            count += 1
            if count > MAX_FILES:
                raise RuntimeError('files')
            with open(src_child, 'rb') as inp, open(dst_child, 'xb') as out:
                copied = 0
                while True:
                    data = inp.read(1024 * 1024)
                    if not data:
                        break
                    copied += len(data)
                    total += len(data)
                    if copied > MAX_FILE or total > MAX_BYTES:
                        raise RuntimeError('bytes')
                    out.write(data)
                if copied != st.st_size:
                    raise RuntimeError('changed')
        else:
            raise RuntimeError('special')
try:
    if not safe_parent(source) or not safe_parent(target):
        raise RuntimeError('parent')
    if os.path.lexists(target):
        raise RuntimeError('target')
    copy_tree(source, target, 0)
    print('ok')
except Exception:
    if os.path.lexists(target):
        import shutil
        shutil.rmtree(target, ignore_errors=True)
    raise SystemExit(1)
"#;

const WSL_REMOVE_OWNED_SCRIPT: &str = r#"
import hashlib, os, shutil, stat, struct, sys
p = sys.argv[1]
expected_link = sys.argv[2]
expected_hash = sys.argv[3]
def safe_parent(path):
    parent = os.path.dirname(path)
    if not parent.startswith('/'):
        return False
    current = '/'
    parts = parent.strip('/').split('/') if parent != '/' else []
    for part in parts:
        if not part or part in ('.', '..'):
            return False
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except OSError:
            return False
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return False
    return True
def directory_hash(path):
    files = []
    for root, dirs, names in os.walk(path, topdown=True, followlinks=False):
        dirs[:] = sorted(dirs)
        names = sorted(names)
        if root.count(os.sep) - path.count(os.sep) > 24:
            return None
        if any(os.path.islink(os.path.join(root, name)) for name in dirs):
            return None
        for name in names:
            full = os.path.join(root, name)
            if os.path.islink(full) or not os.path.isfile(full):
                return None
            rel = os.path.relpath(full, path).replace(os.sep, '/')
            if os.path.getsize(full) > 16 * 1024 * 1024 or len(files) >= 2048:
                return None
            files.append((rel, full))
    files.sort(key=lambda item: item[0])
    digest = hashlib.sha256()
    total = 0
    for rel, full in files:
        with open(full, 'rb') as source:
            data = source.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024:
            return None
        total += len(data)
        if total > 128 * 1024 * 1024:
            return None
        rel_bytes = rel.encode()
        digest.update(struct.pack('<Q', len(rel_bytes)) + rel_bytes)
        digest.update(struct.pack('<Q', len(data)) + data)
    return 'sha256:' + digest.hexdigest()
try:
    if not safe_parent(p):
        print('external')
        raise SystemExit(0)
    if not os.path.lexists(p):
        print('missing')
        raise SystemExit(0)
    if os.path.islink(p):
        link = os.readlink(p)
        if not expected_link or os.path.normpath(link) != os.path.normpath(expected_link):
            print('external')
            raise SystemExit(0)
        os.unlink(p)
    elif os.path.isdir(p) and expected_hash and directory_hash(p) == expected_hash:
        if not safe_parent(p) or os.path.islink(p):
            print('external')
            raise SystemExit(0)
        shutil.rmtree(p)
    else:
        print('external')
        raise SystemExit(0)
    print('removed')
except SystemExit:
    raise
except Exception:
    raise SystemExit(1)
"#;

const WSL_PUBLISH_STATE_SCRIPT: &str = r#"
import os, sys
stage, target = sys.argv[1], sys.argv[2]
if os.path.lexists(stage):
    print('target')
elif os.path.lexists(target):
    print('moved')
else:
    print('missing')
"#;

const WSL_REMOVE_STAGING_SCRIPT: &str = r#"
import os, shutil, stat, sys
p = sys.argv[1]
def safe_parent(path):
    parent = os.path.dirname(path)
    if not parent.startswith('/'):
        return False
    current = '/'
    parts = parent.strip('/').split('/') if parent != '/' else []
    for part in parts:
        if not part or part in ('.', '..'):
            return False
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except OSError:
            return False
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return False
    return True
try:
    if not os.path.basename(p).startswith('.cli-manager-skill-') or not safe_parent(p):
        raise RuntimeError('path')
    if not os.path.lexists(p):
        print('missing')
        raise SystemExit(0)
    info = os.lstat(p)
    if stat.S_ISLNK(info.st_mode) or stat.S_ISREG(info.st_mode):
        os.unlink(p)
    elif stat.S_ISDIR(info.st_mode):
        shutil.rmtree(p)
    else:
        raise RuntimeError('special')
    print('removed')
except SystemExit:
    raise
except Exception:
    raise SystemExit(1)
"#;

const WSL_BACKUP_SCRIPT: &str = r#"
import os, stat, sys
source, backup = sys.argv[1], sys.argv[2]
MAX_FILES = 2048
MAX_BYTES = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_DEPTH = 24
count = 0
total = 0
def safe_name(name):
    return name not in ('.', '..') and '/' not in name and '\x00' not in name
def safe_parent(path):
    parent = os.path.dirname(path)
    if not parent.startswith('/'):
        return False
    current = '/'
    parts = parent.strip('/').split('/') if parent != '/' else []
    for part in parts:
        if not part or part in ('.', '..'):
            return False
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except OSError:
            return False
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return False
    return True
def copy_tree(src, dst, depth):
    global count, total
    if depth > MAX_DEPTH:
        raise RuntimeError('depth')
    st = os.lstat(src)
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
        raise RuntimeError('source')
    os.mkdir(dst)
    for name in sorted(os.listdir(src)):
        if not safe_name(name):
            raise RuntimeError('name')
        src_child = os.path.join(src, name)
        dst_child = os.path.join(dst, name)
        st = os.lstat(src_child)
        if stat.S_ISLNK(st.st_mode):
            raise RuntimeError('link')
        if stat.S_ISDIR(st.st_mode):
            copy_tree(src_child, dst_child, depth + 1)
        elif stat.S_ISREG(st.st_mode):
            if st.st_size > MAX_FILE:
                raise RuntimeError('file')
            count += 1
            if count > MAX_FILES:
                raise RuntimeError('files')
            with open(src_child, 'rb') as inp, open(dst_child, 'xb') as out:
                copied = 0
                while True:
                    data = inp.read(1024 * 1024)
                    if not data:
                        break
                    copied += len(data)
                    total += len(data)
                    if copied > MAX_FILE or total > MAX_BYTES:
                        raise RuntimeError('bytes')
                    out.write(data)
                if copied != st.st_size:
                    raise RuntimeError('changed')
        else:
            raise RuntimeError('special')
try:
    if not safe_parent(source) or not safe_parent(backup):
        raise RuntimeError('parent')
    if not os.path.lexists(source):
        print('missing')
        raise SystemExit(0)
    if os.path.lexists(backup):
        raise RuntimeError('target')
    os.mkdir(backup)
    if os.path.islink(source):
        link = os.readlink(source)
        if not link.startswith('/') or any(c in link for c in '\x00\r\n'):
            raise RuntimeError('link')
        with open(os.path.join(backup, 'link-target.txt'), 'xb') as out:
            out.write((link + '\n').encode())
    elif os.path.isdir(source):
        copy_tree(source, os.path.join(backup, 'payload'), 0)
    else:
        raise RuntimeError('source')
    print('ok')
except SystemExit:
    raise
except Exception:
    if os.path.lexists(backup):
        import shutil
        shutil.rmtree(backup, ignore_errors=True)
    raise SystemExit(1)
"#;

const WSL_RESTORE_SCRIPT: &str = r#"
import os, stat, sys
backup, target = sys.argv[1], sys.argv[2]
MAX_FILES = 2048
MAX_BYTES = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_DEPTH = 24
count = 0
total = 0
def safe_name(name):
    return name not in ('.', '..') and '/' not in name and '\x00' not in name
def safe_parent(path):
    parent = os.path.dirname(path)
    if not parent.startswith('/'):
        return False
    current = '/'
    parts = parent.strip('/').split('/') if parent != '/' else []
    for part in parts:
        if not part or part in ('.', '..'):
            return False
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except OSError:
            return False
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return False
    return True
def copy_tree(src, dst, depth):
    global count, total
    if depth > MAX_DEPTH:
        raise RuntimeError('depth')
    st = os.lstat(src)
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
        raise RuntimeError('source')
    os.mkdir(dst)
    for name in sorted(os.listdir(src)):
        if not safe_name(name):
            raise RuntimeError('name')
        src_child = os.path.join(src, name)
        dst_child = os.path.join(dst, name)
        st = os.lstat(src_child)
        if stat.S_ISLNK(st.st_mode):
            raise RuntimeError('link')
        if stat.S_ISDIR(st.st_mode):
            copy_tree(src_child, dst_child, depth + 1)
        elif stat.S_ISREG(st.st_mode):
            if st.st_size > MAX_FILE:
                raise RuntimeError('file')
            count += 1
            if count > MAX_FILES:
                raise RuntimeError('files')
            with open(src_child, 'rb') as inp, open(dst_child, 'xb') as out:
                copied = 0
                while True:
                    data = inp.read(1024 * 1024)
                    if not data:
                        break
                    copied += len(data)
                    total += len(data)
                    if copied > MAX_FILE or total > MAX_BYTES:
                        raise RuntimeError('bytes')
                    out.write(data)
                if copied != st.st_size:
                    raise RuntimeError('changed')
        else:
            raise RuntimeError('special')
try:
    if not safe_parent(backup) or not safe_parent(target):
        raise RuntimeError('parent')
    if not os.path.isdir(backup) or os.path.islink(backup):
        raise RuntimeError('backup')
    if os.path.lexists(target):
        raise RuntimeError('target')
    payload = os.path.join(backup, 'payload')
    link_file = os.path.join(backup, 'link-target.txt')
    if os.path.isdir(payload) and not os.path.islink(payload):
        copy_tree(payload, target, 0)
        print('copy')
    elif os.path.isfile(link_file) and not os.path.islink(link_file):
        with open(link_file, 'rb') as inp:
            link = inp.read(4097).decode()
        link = link.rstrip('\r\n')
        if not link.startswith('/') or any(c in link for c in '\x00\r\n'):
            raise RuntimeError('link')
        os.symlink(link, target)
        print('symlink')
    else:
        raise RuntimeError('backup')
except Exception:
    if os.path.lexists(target):
        if os.path.islink(target) or not os.path.isdir(target):
            os.unlink(target)
        else:
            import shutil
            shutil.rmtree(target, ignore_errors=True)
    raise SystemExit(1)
"#;

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn wsl_paths_are_absolute_and_single_component_targets() {
        assert!(is_safe_wsl_distro("Ubuntu"));
        assert!(!is_safe_wsl_distro("../Ubuntu"));
        assert!(is_safe_linux_absolute("/home/user/.claude"));
        assert!(!is_safe_linux_absolute("//mnt/c/outside"));
        assert!(!is_safe_linux_absolute("/home/../outside"));
        assert!(is_direct_child_linux_path(
            "/home/user/.claude/skills",
            "/home/user/.claude/skills/demo"
        ));
        assert!(!is_direct_child_linux_path(
            "/home/user/.claude/skills",
            "/home/user/.claude/skills/demo/file"
        ));
    }
}
