use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::model::ExtensionCli;
use super::skill_repository::{self, SkillInstallationRecord, SkillPackageRecord};

pub(crate) const MAX_SKILL_FILES: usize = 2048;
pub(crate) const MAX_SKILL_BYTES: u64 = 128 * 1024 * 1024;
pub(super) const MAX_SKILL_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const MAX_SKILL_DEPTH: usize = 24;
const MAX_SKILL_NAME_LENGTH: usize = 128;
const MAX_SKILL_DESCRIPTION_LENGTH: usize = 4096;
const MAX_SKILL_MD_BYTES: usize = 512 * 1024;

static DEPLOYMENT_LOCKS: OnceLock<
    Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
> = OnceLock::new();

/// A requested deployment strategy. `auto` is the only strategy allowed to fall back.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SkillSyncMode {
    Auto,
    Symlink,
    Copy,
}

/// Metadata supplied by an import source; it never contains package contents.
#[derive(Clone, Debug)]
pub(crate) struct SkillSourceMetadata {
    pub source_kind: String,
    pub source_identity: String,
    pub source_ref: String,
    pub resolved_commit: Option<String>,
    pub subdirectory: String,
    pub version: Option<String>,
}

/// A safe, fully scanned local package candidate ready for staging or preview.
#[derive(Clone, Debug)]
pub(crate) struct SkillCandidate {
    pub candidate_id: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub source: SkillSourceMetadata,
    pub source_path: PathBuf,
    pub content_hash: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

/// Package metadata returned to the WebView; source files remain backend-owned.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillPackageView {
    pub package_id: String,
    pub name: String,
    pub description: String,
    pub source_kind: String,
    pub source_identity: String,
    pub source_ref: String,
    pub resolved_commit: Option<String>,
    pub subdirectory: String,
    pub content_hash: String,
    pub version: Option<String>,
    pub package_path: String,
    pub updated_at_ms: i64,
}

/// Installation state with both requested and actually used sync modes.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillInstallationView {
    pub installation_id: String,
    pub package_id: String,
    pub environment_kind: String,
    pub environment_id: String,
    pub cli: ExtensionCli,
    pub home_path: String,
    pub target_path: String,
    pub requested_mode: String,
    pub actual_mode: String,
    pub link_target: Option<String>,
    pub deployed_hash: String,
    pub owned: bool,
    pub external_modified: bool,
    pub backup_path: Option<String>,
    pub status: String,
    pub updated_at_ms: i64,
}

/// A deployment request is explicit about environment and Home, preventing WSL writes from
/// silently landing in the Windows Home.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillDeploymentRequest {
    pub package_id: String,
    pub environment_kind: String,
    pub environment_id: String,
    pub cli: ExtensionCli,
    pub home_path: String,
    pub mode: SkillSyncMode,
}

/// Result of one deployment, including the durable ownership record and backup if replaced.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillDeploymentResult {
    pub installation: SkillInstallationView,
    pub changed: bool,
    pub backup_path: Option<String>,
}

/// Result of a safe uninstall. An externally modified target is never removed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillUninstallResult {
    pub installation_id: String,
    pub removed: bool,
    pub external_modified: bool,
    pub backup_path: Option<String>,
}

/// Result of restoring the latest backup belonging to one installation.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillRestoreResult {
    pub installation: SkillInstallationView,
    pub restored_from: String,
}

// 扫描一个目录或其直接子目录中的 SKILL.md，来源目录只读且不因预览发生改动。
pub(crate) fn scan_skill_candidates(
    source_path: &Path,
    source: SkillSourceMetadata,
) -> Result<Vec<SkillCandidate>, String> {
    validate_source_path(source_path)?;
    let mut roots = Vec::new();
    if source_path.join("SKILL.md").is_file() {
        roots.push((source_path.to_path_buf(), source.subdirectory.clone()));
    } else {
        let entries = fs::read_dir(source_path)
            .map_err(|_| "extensions_skill_source_unreadable".to_string())?;
        for entry in entries {
            let entry = entry.map_err(|_| "extensions_skill_source_unreadable".to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| "extensions_skill_source_unreadable".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            if path.join("SKILL.md").is_file() {
                let subdirectory = join_relative(&source.subdirectory, entry.file_name());
                roots.push((path, subdirectory));
            }
        }
    }
    roots.sort_by(|left, right| left.1.cmp(&right.1));
    let mut candidates = Vec::with_capacity(roots.len());
    for (root, subdirectory) in roots {
        let mut source = source.clone();
        source.subdirectory = subdirectory;
        candidates.push(scan_skill_package(&root, source)?);
    }
    Ok(candidates)
}

// 扫描单个 Skill 包的完整树，拒绝链接、特殊节点、路径穿越和超出大小/深度上限的输入。
pub(crate) fn scan_skill_package(
    package_path: &Path,
    source: SkillSourceMetadata,
) -> Result<SkillCandidate, String> {
    validate_source_path(package_path)?;
    let mut files = Vec::new();
    collect_package_files(package_path, package_path, 0, &mut files)?;
    if files.is_empty() || !files.iter().any(|(relative, _, _)| relative == "SKILL.md") {
        return Err("extensions_skill_manifest_missing".to_string());
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    let mut total_bytes = 0_u64;
    for (relative, path, size) in &files {
        total_bytes = total_bytes
            .checked_add(*size)
            .ok_or_else(|| "extensions_skill_package_too_large".to_string())?;
        if total_bytes > MAX_SKILL_BYTES {
            return Err("extensions_skill_package_too_large".to_string());
        }
        hasher.update((relative.len() as u64).to_le_bytes());
        hasher.update(relative.as_bytes());
        let bytes = read_bounded_file(path, *size, MAX_SKILL_FILE_BYTES)?;
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    let content_hash = format!("sha256:{:x}", hasher.finalize());
    let manifest = read_skill_manifest(&package_path.join("SKILL.md"))?;
    let source_version = source.version.clone();
    let name = manifest
        .name
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            package_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill")
                .to_string()
        });
    validate_skill_display_name(&name)?;
    let description = manifest.description.unwrap_or_default();
    let candidate_id = derive_package_id(&source, &content_hash);
    Ok(SkillCandidate {
        candidate_id,
        name,
        description,
        version: manifest.version.or(source_version),
        source,
        source_path: package_path.to_path_buf(),
        content_hash,
        file_count: files.len(),
        total_bytes,
    })
}

// 将本地包候选的身份与内容摘要合成为预览指纹，apply 会重新扫描并严格比较。
pub(crate) fn candidates_fingerprint(
    source_identity: &str,
    candidates: &[SkillCandidate],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source_identity.as_bytes());
    let mut ordered = candidates
        .iter()
        .map(|candidate| {
            (
                candidate.source.subdirectory.clone(),
                candidate.content_hash.clone(),
            )
        })
        .collect::<Vec<_>>();
    ordered.sort();
    for (subdirectory, content_hash) in ordered {
        hasher.update((subdirectory.len() as u64).to_le_bytes());
        hasher.update(subdirectory.as_bytes());
        hasher.update(content_hash.as_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

// 将完整包经 staging 发布到 appDataRoot/extensions/skills/packages，不把外部目录当作所有物。
pub(crate) async fn publish_skill_candidate(
    candidate: &SkillCandidate,
) -> Result<SkillPackageRecord, String> {
    let root = skills_root()?;
    ensure_owned_directory(&root)?;
    let staging_root = root.join("staging");
    let packages_root = root.join("packages");
    ensure_owned_directory(&staging_root)?;
    ensure_owned_directory(&packages_root)?;

    let package_parent = packages_root.join(&candidate.candidate_id);
    ensure_child_path(&packages_root, &package_parent)?;
    ensure_owned_directory(&package_parent)?;
    let destination = package_parent.join(&candidate.content_hash.replace(':', "-"));
    ensure_child_path(&package_parent, &destination)?;
    let mut created_destination = false;
    if !path_exists_without_following(&destination)? {
        let stage = staging_root.join(Uuid::new_v4().to_string());
        ensure_child_path(&staging_root, &stage)?;
        if let Err(error) = (|| {
            copy_package_tree(&candidate.source_path, &stage)?;
            let staged = scan_skill_package(&stage, candidate.source.clone())?;
            if staged.content_hash != candidate.content_hash {
                return Err("extensions_skill_source_changed".to_string());
            }
            fs::rename(&stage, &destination)
                .map_err(|_| "extensions_skill_package_publish_failed".to_string())?;
            Ok::<(), String>(())
        })() {
            let _ = remove_path_if_present(&stage);
            return Err(error);
        }
        created_destination = true;
    } else {
        let stored = scan_skill_package(&destination, candidate.source.clone())?;
        if stored.content_hash != candidate.content_hash {
            return Err("extensions_skill_package_storage_corrupt".to_string());
        }
    }

    let now = skill_repository::now_ms();
    let record = SkillPackageRecord {
        package_id: candidate.candidate_id.clone(),
        name: candidate.name.clone(),
        description: candidate.description.clone(),
        source_kind: candidate.source.source_kind.clone(),
        source_identity: candidate.source.source_identity.clone(),
        source_ref: candidate.source.source_ref.clone(),
        resolved_commit: candidate.source.resolved_commit.clone(),
        subdirectory: candidate.source.subdirectory.clone(),
        content_hash: candidate.content_hash.clone(),
        version: candidate.version.clone(),
        package_path: destination.clone(),
        created_at_ms: now,
        updated_at_ms: now,
    };
    if let Err(error) = skill_repository::upsert_package(&record).await {
        if created_destination {
            let _ = remove_path_if_present(&destination);
        }
        return Err(error);
    }
    Ok(record)
}

// 解析受管包列表并按文件实际状态标出缺失或损坏，供全局页显示可靠状态。
pub(crate) async fn list_package_views() -> Result<Vec<SkillPackageView>, String> {
    let records = skill_repository::list_packages().await?;
    records
        .iter()
        .map(package_view)
        .collect::<Result<Vec<_>, _>>()
}

// 按目标环境先筛选再探测，避免某个不可用的 WSL 发行版阻塞本机项目策略读取。
pub(crate) async fn list_installation_views_for_environment(
    environment_kind: Option<&str>,
    environment_id: Option<&str>,
) -> Result<Vec<SkillInstallationView>, String> {
    let records = skill_repository::list_installations().await?;
    let mut views = Vec::with_capacity(records.len());
    for record in records {
        if environment_kind.is_some_and(|kind| record.environment_kind != kind)
            || environment_id.is_some_and(|id| record.environment_id != id)
        {
            continue;
        }
        let status = inspect_installation(&record).await?;
        if status == "externalModified" && !record.external_modified {
            let _ = skill_repository::mark_external_modified(&record.installation_id, true).await;
        }
        views.push(installation_view(&record, status));
    }
    Ok(views)
}

// 执行一项可恢复部署；文件发布完成后才落库，数据库失败时清理本次新目标。
pub(crate) async fn deploy(
    request: SkillDeploymentRequest,
) -> Result<SkillDeploymentResult, String> {
    validate_deployment_request(&request)?;
    let package = skill_repository::get_package(&request.package_id).await?;
    validate_managed_package(&package)?;
    validate_skill_display_name(&package.name)?;
    let target_root = skill_target(&request.home_path, request.cli)?;
    let target_name = package.name.clone();
    let target_key = format!(
        "{}:{}:{}:{}",
        request.environment_kind,
        request.environment_id,
        request.cli.key(),
        target_root.join(&target_name).to_string_lossy()
    );
    let lock = deployment_lock(&target_key)?;
    let _guard = lock.lock().await;
    if request.environment_kind == "wsl" {
        return super::skill_wsl::deploy(request, package, target_root).await;
    }
    let target = target_root.join(target_name);
    deploy_local(request, package, target).await
}

fn deployment_lock(key: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let locks = DEPLOYMENT_LOCKS.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let mut values = locks
        .lock()
        .map_err(|_| "extensions_skill_lock_unavailable".to_string())?;
    Ok(values
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone())
}

// 本机部署路径：先检查已有归属和外部改动，再以临时同级目录原子发布。
async fn deploy_local(
    request: SkillDeploymentRequest,
    package: SkillPackageRecord,
    target: PathBuf,
) -> Result<SkillDeploymentResult, String> {
    let existing = skill_repository::get_installation_for_target(
        &request.environment_kind,
        &request.environment_id,
        request.cli,
        &target,
    )
    .await?;
    let previous_backup_path = existing
        .as_ref()
        .and_then(|record| record.backup_path.clone());
    let mut backup_path = None;
    let mut remove_target = false;
    if let Some(record) = existing.as_ref() {
        validate_local_record_target(record)?;
        match inspect_local_target(record)? {
            TargetState::External => {
                let _ =
                    skill_repository::mark_external_modified(&record.installation_id, true).await;
                return Err("extensions_skill_external_modified".to_string());
            }
            TargetState::Error(error) => return Err(error),
            TargetState::Owned => {
                if record.package_id == package.package_id
                    && record.deployed_hash == package.content_hash
                {
                    let view = installation_view(record, "active".to_string());
                    return Ok(SkillDeploymentResult {
                        installation: view,
                        changed: false,
                        backup_path: record.backup_path.as_ref().map(|path| path_string(path)),
                    });
                }
                remove_target = true;
                backup_path = backup_existing_target(&target, record)?;
            }
            TargetState::Missing => {}
        }
    } else if path_exists_without_following(&target)? {
        return Err("extensions_skill_target_conflict".to_string());
    }

    let parent = target
        .parent()
        .ok_or_else(|| "extensions_skill_target_invalid".to_string())?;
    ensure_directory_chain_without_links(parent)?;
    let stage = parent.join(format!(".cli-manager-skill-{}", Uuid::new_v4()));
    let (actual_mode, link_target) =
        match stage_deployment(&package.package_path, &stage, request.mode) {
            Ok(value) => value,
            Err(error) => {
                let _ = remove_path_if_present(&stage);
                if let Some(backup) = backup_path.as_ref() {
                    let _ = remove_path_if_present(backup);
                }
                return Err(error);
            }
        };
    // Re-read ownership after staging. A user may have replaced a missing or owned target while
    // the package was being copied; in that case preserve the new external target.
    if let Some(record) = existing.as_ref() {
        let current_state = match inspect_local_target(record) {
            Ok(state) => state,
            Err(error) => {
                let _ = remove_path_if_present(&stage);
                if let Some(backup) = backup_path.as_ref() {
                    let _ = remove_path_if_present(backup);
                }
                return Err(error);
            }
        };
        match current_state {
            TargetState::Owned => remove_target = true,
            TargetState::Missing => remove_target = false,
            TargetState::External => {
                let _ = remove_path_if_present(&stage);
                if let Some(backup) = backup_path.as_ref() {
                    let _ = remove_path_if_present(backup);
                }
                let _ =
                    skill_repository::mark_external_modified(&record.installation_id, true).await;
                return Err("extensions_skill_external_modified".to_string());
            }
            TargetState::Error(error) => {
                let _ = remove_path_if_present(&stage);
                if let Some(backup) = backup_path.as_ref() {
                    let _ = remove_path_if_present(backup);
                }
                return Err(error);
            }
        }
    } else {
        match path_exists_without_following(&target) {
            Ok(true) => {
                let _ = remove_path_if_present(&stage);
                return Err("extensions_skill_target_conflict".to_string());
            }
            Ok(false) => {}
            Err(error) => {
                let _ = remove_path_if_present(&stage);
                return Err(error);
            }
        }
    }
    if remove_target {
        let removal = existing
            .as_ref()
            .ok_or_else(|| "extensions_skill_target_conflict".to_string())
            .and_then(remove_owned_local_target);
        if let Err(error) = removal {
            let _ = remove_path_if_present(&stage);
            if let Some(backup) = backup_path.as_ref() {
                if restore_backup_payload(backup, &target).is_ok() {
                    let _ = remove_path_if_present(backup);
                }
            }
            return Err(error);
        }
    }
    match path_exists_without_following(&target) {
        Ok(true) => {
            let _ = remove_path_if_present(&stage);
            if let Some(backup) = backup_path.as_ref() {
                let _ = remove_path_if_present(backup);
            }
            return Err("extensions_skill_target_conflict".to_string());
        }
        Ok(false) => {}
        Err(error) => {
            let _ = remove_path_if_present(&stage);
            if let Some(backup) = backup_path.as_ref() {
                let _ = remove_path_if_present(backup);
            }
            return Err(error);
        }
    }
    if let Err(error) = fs::rename(&stage, &target) {
        let _ = remove_path_if_present(&stage);
        if let Some(backup) = backup_path.as_ref() {
            if restore_backup_payload(backup, &target).is_ok() {
                let _ = remove_path_if_present(backup);
            }
        }
        return Err(format!("extensions_skill_target_publish_failed:{error}"));
    }
    let now = skill_repository::now_ms();
    let installation_id = existing
        .as_ref()
        .map(|record| record.installation_id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let created_at_ms = existing
        .as_ref()
        .map(|record| record.created_at_ms)
        .unwrap_or(now);
    let record = SkillInstallationRecord {
        installation_id,
        package_id: package.package_id,
        environment_kind: request.environment_kind,
        environment_id: request.environment_id,
        cli: request.cli,
        home_path: PathBuf::from(request.home_path),
        target_path: target,
        requested_mode: mode_string(request.mode).to_string(),
        actual_mode: actual_mode.to_string(),
        link_target,
        deployed_hash: package.content_hash,
        owned: true,
        external_modified: false,
        backup_path,
        created_at_ms,
        updated_at_ms: now,
    };
    if let Err(error) = skill_repository::upsert_installation(&record).await {
        let _ = remove_owned_local_target(&record);
        if let Some(backup) = record.backup_path.as_ref() {
            if restore_backup_payload(backup, &record.target_path).is_ok() {
                let _ = remove_path_if_present(backup);
            }
        }
        return Err(error);
    }
    if let Some(previous) = previous_backup_path
        .as_ref()
        .filter(|previous| Some(*previous) != record.backup_path.as_ref())
    {
        if validate_managed_backup_path(previous).is_ok() {
            let _ = remove_path_if_present(previous);
        }
    }
    let view = installation_view(&record, "active".to_string());
    Ok(SkillDeploymentResult {
        installation: view,
        changed: true,
        backup_path: record.backup_path.as_ref().map(|path| path_string(path)),
    })
}

// 卸载只移除能由链接目标或内容哈希证明归属的目标，外部修改和外部同名目录均保留。
pub(crate) async fn uninstall(installation_id: &str) -> Result<SkillUninstallResult, String> {
    let record = skill_repository::get_installation(installation_id).await?;
    if record.environment_kind == "wsl" {
        return super::skill_wsl::uninstall(record).await;
    }
    validate_local_record_target(&record)?;
    let target_state = inspect_local_target(&record)?;
    match target_state {
        TargetState::Missing => {}
        TargetState::Owned => match inspect_local_target(&record)? {
            TargetState::Owned => remove_owned_local_target(&record)?,
            TargetState::Missing => {}
            TargetState::External => {
                let _ = skill_repository::mark_external_modified(installation_id, true).await;
                return Err("extensions_skill_external_modified".to_string());
            }
            TargetState::Error(error) => return Err(error),
        },
        TargetState::External => {
            let _ = skill_repository::mark_external_modified(installation_id, true).await;
            return Err("extensions_skill_external_modified".to_string());
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
        skill_repository::delete_installation(installation_id).await?;
    }
    Ok(SkillUninstallResult {
        installation_id: installation_id.to_string(),
        removed: true,
        external_modified: false,
        backup_path,
    })
}

// 从受管备份恢复已安装目标；恢复仍走临时目录，不覆盖外部修改的当前目标。
pub(crate) async fn restore(installation_id: &str) -> Result<SkillRestoreResult, String> {
    let record = skill_repository::get_installation(installation_id).await?;
    let backup = record
        .backup_path
        .clone()
        .ok_or_else(|| "extensions_skill_backup_not_found".to_string())?;
    if record.environment_kind == "wsl" {
        return super::skill_wsl::restore(record).await;
    }
    validate_local_record_target(&record)?;
    validate_managed_backup_path(&backup)?;
    if matches!(inspect_local_target(&record)?, TargetState::External) {
        return Err("extensions_skill_external_modified".to_string());
    }
    let payload = backup.join("payload");
    let link_file = backup.join("link-target.txt");
    let payload_exists = backup_entry_is_directory(&payload)?;
    let link_file_exists = backup_entry_is_file(&link_file)?;
    if payload_exists && link_file_exists {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    let candidate = if payload_exists {
        Some(scan_skill_package(
            &payload,
            SkillSourceMetadata {
                source_kind: "backup".to_string(),
                source_identity: path_string(&backup),
                source_ref: String::new(),
                resolved_commit: None,
                subdirectory: String::new(),
                version: None,
            },
        )?)
    } else {
        None
    };
    if candidate.is_none() && !link_file_exists {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    let backup_metadata = read_backup_metadata(&backup)?;
    let parent = record
        .target_path
        .parent()
        .ok_or_else(|| "extensions_skill_target_invalid".to_string())?;
    ensure_directory_chain_without_links(parent)?;
    let stage = parent.join(format!(".cli-manager-skill-restore-{}", Uuid::new_v4()));
    let (actual_mode, deployed_hash, link_target, package_id) = if let Some(candidate) = candidate {
        if let Some(metadata) = backup_metadata.as_ref() {
            if metadata.actual_mode != "copy" || metadata.deployed_hash != candidate.content_hash {
                return Err("extensions_skill_backup_invalid".to_string());
            }
        }
        copy_package_tree(&payload, &stage)?;
        (
            "copy".to_string(),
            candidate.content_hash,
            None,
            backup_metadata
                .as_ref()
                .map(|metadata| metadata.package_id.clone())
                .unwrap_or_else(|| record.package_id.clone()),
        )
    } else {
        if backup_metadata
            .as_ref()
            .is_some_and(|metadata| metadata.actual_mode != "symlink")
        {
            return Err("extensions_skill_backup_invalid".to_string());
        }
        let link = read_local_backup_link(&link_file)?;
        let expected = backup_metadata
            .as_ref()
            .and_then(|metadata| metadata.link_target.as_deref().map(Path::new))
            .or_else(|| record.link_target.as_deref());
        if !link.is_absolute() || expected.is_none_or(|expected| !same_path(&link, expected)) {
            return Err("extensions_skill_backup_invalid".to_string());
        }
        validate_source_path(&link)?;
        create_directory_symlink(&link, &stage)?;
        (
            "symlink".to_string(),
            backup_metadata
                .as_ref()
                .map(|metadata| metadata.deployed_hash.clone())
                .unwrap_or_else(|| record.deployed_hash.clone()),
            Some(link),
            backup_metadata
                .as_ref()
                .map(|metadata| metadata.package_id.clone())
                .unwrap_or_else(|| record.package_id.clone()),
        )
    };
    let package = match skill_repository::get_package(&package_id).await {
        Ok(package) => package,
        Err(error) => {
            let _ = remove_path_if_present(&stage);
            return Err(error);
        }
    };
    if package.content_hash != deployed_hash {
        let _ = remove_path_if_present(&stage);
        return Err("extensions_skill_backup_package_mismatch".to_string());
    }
    if actual_mode == "symlink" {
        let Some(link_target) = link_target.as_ref() else {
            let _ = remove_path_if_present(&stage);
            return Err("extensions_skill_backup_invalid".to_string());
        };
        if !same_path(link_target, &package.package_path) {
            let _ = remove_path_if_present(&stage);
            return Err("extensions_skill_backup_invalid".to_string());
        }
        if let Err(error) = validate_managed_package(&package) {
            let _ = remove_path_if_present(&stage);
            return Err(error);
        }
    }
    match inspect_local_target(&record)? {
        TargetState::External => {
            let _ = remove_path_if_present(&stage);
            return Err("extensions_skill_external_modified".to_string());
        }
        TargetState::Error(error) => {
            let _ = remove_path_if_present(&stage);
            return Err(error);
        }
        TargetState::Missing | TargetState::Owned => {}
    }
    let rollback_backup = match inspect_local_target(&record)? {
        TargetState::Owned => match backup_existing_target(&record.target_path, &record) {
            Ok(backup) => backup,
            Err(error) => {
                let _ = remove_path_if_present(&stage);
                return Err(error);
            }
        },
        TargetState::Missing => None,
        TargetState::External => {
            let _ = remove_path_if_present(&stage);
            return Err("extensions_skill_external_modified".to_string());
        }
        TargetState::Error(error) => {
            let _ = remove_path_if_present(&stage);
            return Err(error);
        }
    };
    match inspect_local_target(&record)? {
        TargetState::Owned => {
            if let Err(error) = remove_owned_local_target(&record) {
                let _ = remove_path_if_present(&stage);
                if let Some(backup) = rollback_backup.as_ref() {
                    let _ = remove_path_if_present(backup);
                }
                return Err(error);
            }
        }
        TargetState::Missing => {}
        TargetState::External => {
            let _ = remove_path_if_present(&stage);
            if let Some(backup) = rollback_backup.as_ref() {
                let _ = remove_path_if_present(backup);
            }
            return Err("extensions_skill_external_modified".to_string());
        }
        TargetState::Error(error) => {
            let _ = remove_path_if_present(&stage);
            if let Some(backup) = rollback_backup.as_ref() {
                let _ = remove_path_if_present(backup);
            }
            return Err(error);
        }
    }
    if let Err(error) = fs::rename(&stage, &record.target_path) {
        let _ = remove_path_if_present(&stage);
        if let Some(backup) = rollback_backup.as_ref() {
            let _ = restore_backup_payload(backup, &record.target_path);
        }
        return Err(format!("extensions_skill_restore_failed:{error}"));
    }
    let mut restored = record.clone();
    restored.package_id = package_id;
    restored.deployed_hash = deployed_hash;
    restored.actual_mode = actual_mode;
    restored.link_target = link_target;
    restored.external_modified = false;
    restored.updated_at_ms = skill_repository::now_ms();
    if let Err(error) = skill_repository::upsert_installation(&restored).await {
        let _ = remove_owned_local_target(&restored);
        if let Some(backup) = rollback_backup.as_ref() {
            let _ = restore_backup_payload(backup, &restored.target_path);
        }
        return Err(error);
    }
    if let Some(backup) = rollback_backup.as_ref() {
        let _ = remove_path_if_present(backup);
    }
    Ok(SkillRestoreResult {
        installation: installation_view(&restored, "restored".to_string()),
        restored_from: path_string(&backup),
    })
}

// 将数据库包映射成不触发文件扫描的稳定 DTO；损坏状态由列表调用方单独判断。
fn package_view(record: &SkillPackageRecord) -> Result<SkillPackageView, String> {
    Ok(SkillPackageView {
        package_id: record.package_id.clone(),
        name: record.name.clone(),
        description: record.description.clone(),
        source_kind: record.source_kind.clone(),
        source_identity: record.source_identity.clone(),
        source_ref: record.source_ref.clone(),
        resolved_commit: record.resolved_commit.clone(),
        subdirectory: record.subdirectory.clone(),
        content_hash: record.content_hash.clone(),
        version: record.version.clone(),
        package_path: path_string(&record.package_path),
        updated_at_ms: record.updated_at_ms,
    })
}

// 将安装记录与实时状态合成全局页所需 DTO，不把错误原文或文件内容放入状态。
pub(super) fn installation_view(
    record: &SkillInstallationRecord,
    status: String,
) -> SkillInstallationView {
    SkillInstallationView {
        installation_id: record.installation_id.clone(),
        package_id: record.package_id.clone(),
        environment_kind: record.environment_kind.clone(),
        environment_id: record.environment_id.clone(),
        cli: record.cli,
        home_path: path_string(&record.home_path),
        target_path: path_string(&record.target_path),
        requested_mode: record.requested_mode.clone(),
        actual_mode: record.actual_mode.clone(),
        link_target: record.link_target.as_ref().map(|path| path_string(path)),
        deployed_hash: record.deployed_hash.clone(),
        owned: record.owned,
        external_modified: record.external_modified,
        backup_path: record.backup_path.as_ref().map(|path| path_string(path)),
        status,
        updated_at_ms: record.updated_at_ms,
    }
}

// 删除前再次确认链接目标或副本哈希仍归属于该安装，避免竞态下清理外部目标。
fn remove_owned_local_target(record: &SkillInstallationRecord) -> Result<(), String> {
    match inspect_local_target(record)? {
        TargetState::Missing => Ok(()),
        TargetState::Owned => remove_path_if_present(&record.target_path),
        TargetState::External => Err("extensions_skill_external_modified".to_string()),
        TargetState::Error(error) => Err(error),
    }
}

// 读取本机安装状态，只有精确链接目标或内容哈希匹配才算仍归 CLI-Manager 所有。
fn inspect_local_target(record: &SkillInstallationRecord) -> Result<TargetState, String> {
    if !record.owned {
        return Ok(TargetState::External);
    }
    let metadata = match fs::symlink_metadata(&record.target_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(TargetState::Missing),
        Err(error) => {
            return Ok(TargetState::Error(format!(
                "extensions_skill_target_unreadable:{error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        let link_target = fs::read_link(&record.target_path)
            .map_err(|_| "extensions_skill_target_unreadable".to_string())?;
        let resolved = if link_target.is_absolute() {
            link_target
        } else {
            record
                .target_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(link_target)
        };
        let expected = record
            .link_target
            .as_ref()
            .ok_or_else(|| "extensions_skill_external_modified".to_string())?;
        if same_path(&resolved, expected) {
            Ok(TargetState::Owned)
        } else {
            Ok(TargetState::External)
        }
    } else if metadata.is_dir() && record.actual_mode == "copy" {
        let source = scan_skill_package(
            &record.target_path,
            SkillSourceMetadata {
                source_kind: "installed".to_string(),
                source_identity: path_string(&record.target_path),
                source_ref: String::new(),
                resolved_commit: None,
                subdirectory: String::new(),
                version: None,
            },
        );
        match source {
            Ok(candidate) if candidate.content_hash == record.deployed_hash => {
                Ok(TargetState::Owned)
            }
            Ok(_) => Ok(TargetState::External),
            Err(error) => Ok(TargetState::Error(error)),
        }
    } else {
        Ok(TargetState::External)
    }
}

// 重新由记录中的 Home/CLI 推导目标父目录，拒绝被篡改的安装记录指向任意本机路径。
fn validate_local_record_target(record: &SkillInstallationRecord) -> Result<(), String> {
    let root = skill_target(&path_string(&record.home_path), record.cli)?;
    let parent = record
        .target_path
        .parent()
        .ok_or_else(|| "extensions_skill_target_invalid".to_string())?;
    if !same_path(parent, &root) {
        return Err("extensions_skill_target_invalid".to_string());
    }
    let name = record
        .target_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "extensions_skill_target_invalid".to_string())?;
    validate_skill_display_name(name)?;
    ensure_child_path(&root, &record.target_path)
}

// 数据库写入失败时尽力把刚替换的受管目标恢复到备份，恢复失败也不触碰备份本身。
fn restore_backup_payload(backup: &Path, target: &Path) -> Result<(), String> {
    validate_managed_backup_path(backup)?;
    let parent = target
        .parent()
        .ok_or_else(|| "extensions_skill_target_invalid".to_string())?;
    ensure_directory_chain_without_links(parent)?;
    let stage = parent.join(format!(".cli-manager-skill-recovery-{}", Uuid::new_v4()));
    let payload = backup.join("payload");
    let link_file = backup.join("link-target.txt");
    let result = if backup_entry_is_directory(&payload)? {
        copy_package_tree(&payload, &stage)
    } else if backup_entry_is_file(&link_file)? {
        let link = read_local_backup_link(&link_file)?;
        validate_source_path(&link)?;
        create_directory_symlink(&link, &stage)
    } else {
        return Err("extensions_skill_backup_invalid".to_string());
    };
    result?;
    if path_exists_without_following(target)? {
        let _ = remove_path_if_present(&stage);
        return Err("extensions_skill_restore_conflict".to_string());
    }
    if let Err(error) = fs::rename(&stage, target) {
        let _ = remove_path_if_present(&stage);
        return Err(format!("extensions_skill_restore_failed:{error}"));
    }
    Ok(())
}

fn backup_entry_is_directory(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("extensions_skill_backup_invalid".to_string())
        }
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err("extensions_skill_backup_invalid".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("extensions_skill_backup_invalid".to_string()),
    }
}

fn backup_entry_is_file(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("extensions_skill_backup_invalid".to_string())
        }
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err("extensions_skill_backup_invalid".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("extensions_skill_backup_invalid".to_string()),
    }
}

fn read_local_backup_link(path: &Path) -> Result<PathBuf, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "extensions_skill_backup_invalid".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4096 {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    let value = fs::read_to_string(path)
        .map_err(|_| "extensions_skill_backup_invalid".to_string())?
        .trim_end_matches(['\r', '\n'])
        .to_string();
    let link = PathBuf::from(value);
    if !link.is_absolute() || link.to_string_lossy().chars().any(char::is_control) {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    Ok(link)
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum TargetState {
    Missing,
    Owned,
    External,
    Error(String),
}

// 根据 CLI 规范把用户 Home 映射到技能目录，并拒绝把 CLI 子目录再次当作 Home。
pub(crate) fn skill_target(home_path: &str, cli: ExtensionCli) -> Result<PathBuf, String> {
    let home = PathBuf::from(home_path.trim());
    if home_path.trim().is_empty() || !home.is_absolute() {
        return Err("extensions_skill_home_invalid".to_string());
    }
    let basename = home
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(basename.as_str(), ".claude" | ".codex" | ".grok") {
        return Err("extensions_skill_home_must_be_parent".to_string());
    }
    let root = match cli {
        ExtensionCli::Claude => home.join(".claude").join("skills"),
        ExtensionCli::Codex => home.join(".agents").join("skills"),
        ExtensionCli::Grok => home.join(".grok").join("skills"),
    };
    Ok(root)
}

// 校验部署环境、身份和 Home 的路径类型，SSH 以及隐式跨环境目标在本层直接拒绝。
fn validate_deployment_request(request: &SkillDeploymentRequest) -> Result<(), String> {
    let kind = request.environment_kind.trim().to_ascii_lowercase();
    if kind != "local" && kind != "wsl" {
        return Err("extensions_skill_environment_unsupported".to_string());
    }
    if request.environment_kind.trim() != kind {
        return Err("extensions_skill_environment_invalid".to_string());
    }
    if request.environment_id.trim().is_empty()
        || request.environment_id.len() > 128
        || request.environment_id.chars().any(char::is_control)
    {
        return Err("extensions_skill_environment_invalid".to_string());
    }
    if request.home_path.chars().any(char::is_control) {
        return Err("extensions_skill_home_invalid".to_string());
    }
    let home_is_wsl = crate::wsl::is_wsl_config_dir(&request.home_path);
    if (kind == "wsl") != home_is_wsl {
        return Err("extensions_skill_environment_mismatch".to_string());
    }
    if kind == "wsl" {
        let (distro, _) = crate::wsl::parse_wsl_unc_path(&request.home_path)
            .ok_or_else(|| "extensions_skill_environment_mismatch".to_string())?;
        if request.environment_id != distro {
            return Err("extensions_skill_environment_mismatch".to_string());
        }
    }
    Ok(())
}

// 确认数据库包路径仍在当前应用数据根，且正文哈希与记录一致后才允许部署。
pub(crate) fn validate_managed_package(package: &SkillPackageRecord) -> Result<(), String> {
    ensure_managed_package_path(&package.package_path)?;
    let candidate = scan_skill_package(
        &package.package_path,
        SkillSourceMetadata {
            source_kind: package.source_kind.clone(),
            source_identity: package.source_identity.clone(),
            source_ref: package.source_ref.clone(),
            resolved_commit: package.resolved_commit.clone(),
            subdirectory: package.subdirectory.clone(),
            version: package.version.clone(),
        },
    )?;
    if candidate.content_hash != package.content_hash
        || candidate.candidate_id != package.package_id
        || candidate.name != package.name
    {
        return Err("extensions_skill_package_changed".to_string());
    }
    Ok(())
}

// 项目级 Codex Skill 复用同一套包校验与安全复制实现，不把应用数据目录直接交给 Codex 扫描。
pub(crate) fn copy_managed_package_to_target(
    package: &SkillPackageRecord,
    target: &Path,
) -> Result<(), String> {
    validate_managed_package(package)?;
    let target_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "extensions_skill_target_invalid".to_string())?;
    if target_name != package.name || validate_skill_display_name(target_name).is_err() {
        return Err("extensions_skill_target_invalid".to_string());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "extensions_skill_target_invalid".to_string())?;
    ensure_directory_chain_without_links(parent)?;
    copy_package_tree(&package.package_path, target)
}

// 检查项目发现目录中的包摘要；只返回摘要，不把 Skill 正文带入项目策略或日志。
pub(crate) fn managed_package_content_hash(path: &Path) -> Result<String, String> {
    scan_skill_package(
        path,
        SkillSourceMetadata {
            source_kind: "project-target".to_string(),
            source_identity: path_string(path),
            source_ref: String::new(),
            resolved_commit: None,
            subdirectory: String::new(),
            version: None,
        },
    )
    .map(|candidate| candidate.content_hash)
}

// 按请求决定链接或复制；auto 仅在明确权限/能力失败时回退复制。
fn stage_deployment(
    source: &Path,
    stage: &Path,
    mode: SkillSyncMode,
) -> Result<(&'static str, Option<PathBuf>), String> {
    match mode {
        SkillSyncMode::Copy => {
            copy_package_tree(source, stage)?;
            Ok(("copy", None))
        }
        SkillSyncMode::Symlink => {
            create_directory_symlink(source, stage)?;
            Ok(("symlink", Some(source.to_path_buf())))
        }
        SkillSyncMode::Auto => match create_directory_symlink(source, stage) {
            Ok(()) => Ok(("symlink", Some(source.to_path_buf()))),
            Err(error) if is_link_fallback_error(&error) => {
                let _ = remove_path_if_present(stage);
                copy_package_tree(source, stage)?;
                Ok(("copy", None))
            }
            Err(error) => Err(error),
        },
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillBackupMetadata {
    pub package_id: String,
    pub actual_mode: String,
    pub deployed_hash: String,
    pub link_target: Option<String>,
}

// 读取应用数据根内的备份元数据；缺失元数据兼容早期备份，损坏元数据不静默恢复。
pub(super) fn read_backup_metadata(backup: &Path) -> Result<Option<SkillBackupMetadata>, String> {
    let metadata_path = backup.join("metadata.json");
    let metadata = match fs::symlink_metadata(&metadata_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("extensions_skill_backup_invalid".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    let bytes = read_bounded_file(&metadata_path, metadata.len(), 16 * 1024)?;
    let value: SkillBackupMetadata = serde_json::from_slice(&bytes)
        .map_err(|_| "extensions_skill_backup_invalid".to_string())?;
    if value.package_id.is_empty()
        || value.package_id.len() > 256
        || value.deployed_hash.is_empty()
        || value.deployed_hash.len() > 256
        || !matches!(value.actual_mode.as_str(), "copy" | "symlink")
        || value.link_target.as_deref().is_some_and(|target| {
            target.is_empty() || target.len() > 4096 || target.chars().any(char::is_control)
        })
    {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    if value.actual_mode == "symlink" && value.link_target.is_none() {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    Ok(Some(value))
}

// 备份元数据只记录受管包身份和摘要，不写入 Skill 正文或任何凭据。
pub(super) fn write_backup_metadata(
    backup: &Path,
    record: &SkillInstallationRecord,
) -> Result<(), String> {
    let value = SkillBackupMetadata {
        package_id: record.package_id.clone(),
        actual_mode: record.actual_mode.clone(),
        deployed_hash: record.deployed_hash.clone(),
        link_target: record.link_target.as_ref().map(|path| path_string(path)),
    };
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| "extensions_skill_backup_write_failed".to_string())?;
    write_new_file(
        &backup.join("metadata.json"),
        &bytes,
        "extensions_skill_backup_write_failed",
    )
}

// 备份被替换的受管目标；链接保存目标文本，复制保存完整 payload，均位于应用数据根。
fn backup_existing_target(
    target: &Path,
    record: &SkillInstallationRecord,
) -> Result<Option<PathBuf>, String> {
    if !path_exists_without_following(target)? {
        return Ok(None);
    }
    let root = skills_root()?.join("backups");
    ensure_owned_directory(&root)?;
    let backup = root.join(format!("{}-{}", record.installation_id, Uuid::new_v4()));
    ensure_child_path(&root, &backup)?;
    ensure_owned_directory(&backup)?;
    let result = (|| {
        let metadata = fs::symlink_metadata(target)
            .map_err(|_| "extensions_skill_backup_read_failed".to_string())?;
        if metadata.file_type().is_symlink() {
            let link = fs::read_link(target)
                .map_err(|_| "extensions_skill_backup_read_failed".to_string())?;
            let link_text = path_string(&link);
            if link_text.len() > 4096 || !link.is_absolute() {
                return Err("extensions_skill_backup_target_invalid".to_string());
            }
            write_new_file(
                &backup.join("link-target.txt"),
                link_text.as_bytes(),
                "extensions_skill_backup_write_failed",
            )?;
        } else if metadata.is_dir() {
            copy_package_tree(target, &backup.join("payload"))?;
        } else {
            return Err("extensions_skill_backup_target_invalid".to_string());
        }
        write_backup_metadata(&backup, record)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        let _ = remove_path_if_present(&backup);
        return Err(error);
    }
    Ok(Some(backup))
}

fn write_new_file(path: &Path, bytes: &[u8], error_code: &'static str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| error_code.to_string())?;
    file.write_all(bytes).map_err(|_| error_code.to_string())
}

// 递归复制仅复制普通文件和目录，源包中的链接或特殊节点永不跟随，并复用扫描上限。
fn copy_package_tree(source: &Path, target: &Path) -> Result<(), String> {
    validate_source_path(source)?;
    if path_exists_without_following(target)? {
        return Err("extensions_skill_stage_exists".to_string());
    }
    fs::create_dir(target).map_err(|_| "extensions_skill_copy_create_failed".to_string())?;
    let mut budget = CopyBudget::default();
    let result = copy_package_tree_inner(source, target, 0, &mut budget);
    if result.is_err() {
        let _ = remove_path_if_present(target);
    }
    result
}

#[derive(Default)]
struct CopyBudget {
    files: usize,
    bytes: u64,
}

fn copy_package_tree_inner(
    source: &Path,
    target: &Path,
    depth: usize,
    budget: &mut CopyBudget,
) -> Result<(), String> {
    if depth > MAX_SKILL_DEPTH {
        return Err("extensions_skill_package_too_deep".to_string());
    }
    let entries =
        fs::read_dir(source).map_err(|_| "extensions_skill_source_unreadable".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "extensions_skill_source_unreadable".to_string())?;
        let source_child = entry.path();
        let target_child = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_child)
            .map_err(|_| "extensions_skill_source_unreadable".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("extensions_skill_symlink_rejected".to_string());
        }
        if metadata.is_dir() {
            if path_exists_without_following(&target_child)? {
                return Err("extensions_skill_stage_exists".to_string());
            }
            fs::create_dir(&target_child)
                .map_err(|_| "extensions_skill_copy_create_failed".to_string())?;
            copy_package_tree_inner(&source_child, &target_child, depth + 1, budget)?;
        } else if metadata.is_file() {
            if budget.files >= MAX_SKILL_FILES {
                return Err("extensions_skill_package_too_many_files".to_string());
            }
            if metadata.len() > MAX_SKILL_FILE_BYTES {
                return Err("extensions_skill_file_too_large".to_string());
            }
            budget.files += 1;
            budget.bytes = budget
                .bytes
                .checked_add(metadata.len())
                .ok_or_else(|| "extensions_skill_package_too_large".to_string())?;
            if budget.bytes > MAX_SKILL_BYTES {
                return Err("extensions_skill_package_too_large".to_string());
            }
            let bytes = read_bounded_file(&source_child, metadata.len(), MAX_SKILL_FILE_BYTES)?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target_child)
                .map_err(|_| "extensions_skill_copy_file_failed".to_string())?;
            file.write_all(&bytes)
                .map_err(|_| "extensions_skill_copy_file_failed".to_string())?;
        } else {
            return Err("extensions_skill_special_file_rejected".to_string());
        }
    }
    Ok(())
}

// 限深递归枚举并记录相对路径、文件路径和长度；只使用 symlink_metadata 做安全判断。
fn collect_package_files(
    root: &Path,
    current: &Path,
    depth: usize,
    output: &mut Vec<(String, PathBuf, u64)>,
) -> Result<(), String> {
    if depth > MAX_SKILL_DEPTH {
        return Err("extensions_skill_package_too_deep".to_string());
    }
    let entries =
        fs::read_dir(current).map_err(|_| "extensions_skill_source_unreadable".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "extensions_skill_source_unreadable".to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "extensions_skill_source_unreadable".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("extensions_skill_symlink_rejected".to_string());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "extensions_skill_path_invalid".to_string())?;
        let relative = relative_to_slashes(relative)?;
        if relative.is_empty() || relative.split('/').any(|part| part == "." || part == "..") {
            return Err("extensions_skill_path_invalid".to_string());
        }
        if metadata.is_dir() {
            collect_package_files(root, &path, depth + 1, output)?;
        } else if metadata.is_file() {
            if output.len() >= MAX_SKILL_FILES {
                return Err("extensions_skill_package_too_many_files".to_string());
            }
            if metadata.len() > MAX_SKILL_FILE_BYTES {
                return Err("extensions_skill_file_too_large".to_string());
            }
            output.push((relative, path, metadata.len()));
        } else {
            return Err("extensions_skill_special_file_rejected".to_string());
        }
    }
    Ok(())
}

// 读取单文件并在读取前后都限制长度，防止检查与读取之间的增长绕过上限。
fn read_bounded_file(path: &Path, expected_size: u64, limit: u64) -> Result<Vec<u8>, String> {
    if expected_size > limit {
        return Err("extensions_skill_file_too_large".to_string());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "extensions_skill_source_unreadable".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > limit {
        return Err("extensions_skill_source_changed".to_string());
    }
    let file =
        fs::File::open(path).map_err(|_| "extensions_skill_source_unreadable".to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "extensions_skill_source_unreadable".to_string())?;
    if bytes.len() as u64 > limit || bytes.len() as u64 != expected_size {
        return Err("extensions_skill_source_changed".to_string());
    }
    Ok(bytes)
}

#[derive(Default)]
struct SkillManifest {
    name: Option<String>,
    description: Option<String>,
    version: Option<String>,
}

// 仅解析 front matter 的短文本字段；Skill 正文不会进入日志或 IPC 预览。
fn read_skill_manifest(path: &Path) -> Result<SkillManifest, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "extensions_skill_manifest_missing".to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_SKILL_MD_BYTES as u64
    {
        return Err("extensions_skill_manifest_invalid".to_string());
    }
    let bytes = read_bounded_file(path, metadata.len(), MAX_SKILL_MD_BYTES as u64)?;
    let text =
        String::from_utf8(bytes).map_err(|_| "extensions_skill_manifest_invalid".to_string())?;
    let mut manifest = SkillManifest::default();
    let mut in_front_matter = false;
    for (index, line) in text.lines().enumerate() {
        if index == 0 && line.trim() == "---" {
            in_front_matter = true;
            continue;
        }
        if in_front_matter && line.trim() == "---" {
            break;
        }
        if !in_front_matter {
            if index > 30 {
                break;
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(['"', '\'']);
        if value.is_empty() {
            continue;
        }
        match key.trim().to_ascii_lowercase().as_str() {
            "name" => manifest.name = Some(limit_text(value, MAX_SKILL_NAME_LENGTH)?),
            "description" => {
                manifest.description = Some(limit_text(value, MAX_SKILL_DESCRIPTION_LENGTH)?)
            }
            "version" => manifest.version = Some(limit_text(value, 128)?),
            _ => {}
        }
    }
    Ok(manifest)
}

// 显示名只允许单个安全组件；不把名称转小写，避免大小写敏感文件系统上的误合并。
pub(crate) fn validate_skill_display_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > MAX_SKILL_NAME_LENGTH
        || validate_portable_path_component(name).is_err()
    {
        return Err("extensions_skill_name_invalid".to_string());
    }
    Ok(())
}

// 共享归档、包目录和部署名称的文件系统组件校验；Windows 额外拒绝设备名和非法尾字符。
pub(crate) fn validate_portable_path_component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.chars().any(|character| character.is_control())
        || value.contains('/')
        || value.contains('\\')
    {
        return Err("extensions_skill_path_invalid".to_string());
    }
    if cfg!(target_os = "windows")
        && (value.ends_with('.')
            || value.ends_with(' ')
            || value
                .chars()
                .any(|character| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
            || is_windows_reserved_name(value))
    {
        return Err("extensions_skill_path_invalid".to_string());
    }
    Ok(())
}

// 拒绝 Windows 设备名，即使名称附带扩展名或大小写变化也不写入目标目录。
fn is_windows_reserved_name(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

// 限制 front matter 文本，避免错误信息和列表对象承载超大用户输入。
fn limit_text(value: &str, limit: usize) -> Result<String, String> {
    if value.len() > limit || value.chars().any(|value| value.is_control()) {
        return Err("extensions_skill_manifest_invalid".to_string());
    }
    Ok(value.to_string())
}

// 校验来源根目录为普通目录；源可读但不可通过链接逃逸到未知树。
fn validate_source_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("extensions_skill_source_invalid".to_string());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| "extensions_skill_source_missing".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("extensions_skill_symlink_rejected".to_string());
        }
        if !metadata.is_dir() {
            return Err("extensions_skill_source_invalid".to_string());
        }
    }
    Ok(())
}

// 创建应用数据下的普通目录，并拒绝已有链接/重解析点。
pub(super) fn ensure_owned_directory(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("extensions_skill_managed_path_is_link".to_string())
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Err("extensions_skill_managed_path_invalid".to_string()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|_| "extensions_skill_directory_create_failed".to_string())?;
            }
            Err(_) => return Err("extensions_skill_directory_create_failed".to_string()),
        }
    }
    Ok(())
}

// 检查候选路径的词法祖先关系，并在已有前缀上逐级拒绝链接。
pub(super) fn ensure_child_path(root: &Path, child: &Path) -> Result<(), String> {
    if !same_path_or_child(root, child)
        || child
            .components()
            .any(|component| component == Component::ParentDir)
    {
        return Err("extensions_skill_path_escape".to_string());
    }
    let mut current = PathBuf::new();
    for component in child.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("extensions_skill_managed_path_is_link".to_string())
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("extensions_skill_path_unreadable".to_string()),
        }
    }
    Ok(())
}

// 目标父目录必须是普通目录链，避免目标路径中的任一既有组件重定向写入。
fn ensure_directory_chain_without_links(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("extensions_skill_target_parent_is_link".to_string())
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Err("extensions_skill_target_parent_invalid".to_string()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|_| "extensions_skill_target_parent_create_failed".to_string())?;
            }
            Err(_) => return Err("extensions_skill_target_parent_unreadable".to_string()),
        }
    }
    Ok(())
}

// 删除时先读不跟随链接的元数据，链接本身只用 remove_file，不会递归删除其目标。
pub(super) fn remove_path_if_present(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("extensions_skill_target_unreadable".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        fs::remove_file(path).map_err(|_| "extensions_skill_target_remove_failed".to_string())
    } else {
        fs::remove_dir_all(path).map_err(|_| "extensions_skill_target_remove_failed".to_string())
    }
}

// 备份路径必须位于应用数据根下的备份目录，且路径链和备份目录本身都不能是链接。
pub(super) fn validate_managed_backup_path(path: &Path) -> Result<(), String> {
    let root = skills_root()?.join("backups");
    ensure_child_path(&root, path)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "extensions_skill_backup_not_found".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("extensions_skill_backup_invalid".to_string());
    }
    Ok(())
}

// 仅用 metadata 判定路径存在，避免 broken symlink 被 is_dir/is_file 当成不存在。
fn path_exists_without_following(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("extensions_skill_target_unreadable".to_string()),
    }
}

// 目录链接只在平台标准实现下创建；Linux/macOS 不复用 Windows API。
fn create_directory_symlink(source: &Path, target: &Path) -> Result<(), String> {
    if path_exists_without_following(target)? {
        return Err("extensions_skill_stage_exists".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::os::windows::fs::symlink_dir(source, target)
            // Numeric OS codes remain stable on localized Windows installations.
            .map_err(|error| {
                format!(
                    "extensions_skill_symlink_failed:{}:{error}",
                    error.raw_os_error().unwrap_or(0)
                )
            })?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::os::unix::fs::symlink(source, target)
            .map_err(|error| format!("extensions_skill_symlink_failed:{error}"))?;
    }
    Ok(())
}

// 仅把权限不足或平台未实现识别为 auto 的复制回退，磁盘/路径等错误仍向上报错。
fn is_link_fallback_error(error: &str) -> bool {
    error.contains("Permission denied")
        || error.contains("permission denied")
        || error.contains("operation not supported")
        || error.contains("not supported")
        || error.contains(":1314")
        || error.contains(":4390")
}

// 规范化显示路径，错误中不携带文件内容。
pub(super) fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// 将路径转为正斜杠相对表示，拒绝非普通组件。
fn relative_to_slashes(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(value) = component else {
            return Err("extensions_skill_path_invalid".to_string());
        };
        let text = value
            .to_str()
            .ok_or_else(|| "extensions_skill_path_invalid".to_string())?;
        if text.is_empty()
            || text == "."
            || text == ".."
            || text.contains('/')
            || text.contains('\\')
        {
            return Err("extensions_skill_path_invalid".to_string());
        }
        parts.push(text);
    }
    Ok(parts.join("/"))
}

// 拼接来源子目录，不让相对路径输入改变来源根。
fn join_relative(prefix: &str, suffix: impl AsRef<Path>) -> String {
    let suffix = suffix.as_ref().to_string_lossy().replace('\\', "/");
    if prefix.is_empty() {
        suffix
    } else if suffix.is_empty() {
        prefix.to_string()
    } else {
        format!("{}/{}", prefix.trim_matches('/'), suffix.trim_matches('/'))
    }
}

// 用完整组件比较路径，避免同名前缀误判；Windows 比较时不区分大小写。
fn same_path_or_child(root: &Path, child: &Path) -> bool {
    let root = root
        .components()
        .map(|component| path_component_key(component.as_os_str()))
        .collect::<Vec<_>>();
    let child = child
        .components()
        .map(|component| path_component_key(component.as_os_str()))
        .collect::<Vec<_>>();
    root.len() <= child.len() && root.iter().zip(&child).all(|(left, right)| left == right)
}

// 跨平台路径组件比较键；不把 macOS 当作 Windows 处理。
fn path_component_key(component: &std::ffi::OsStr) -> String {
    let value = component.to_string_lossy();
    if cfg!(target_os = "windows") {
        value.to_ascii_lowercase()
    } else {
        value.into_owned()
    }
}

// 规范化链接目标与期望目标后比较；不因目标不存在而失败。
fn same_path(left: &Path, right: &Path) -> bool {
    let left = lexical_normalize(left);
    let right = lexical_normalize(right);
    let left = left.to_string_lossy();
    let right = right.to_string_lossy();
    if cfg!(target_os = "windows") {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

// 去除 . 组件并保留 .. 以便上层的祖先检查仍能拒绝逃逸路径。
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            _ => output.push(component.as_os_str()),
        }
    }
    output
}

// 由来源身份、子目录和真实内容哈希生成稳定包 ID；名称变化不会产生第二份内容。
fn derive_package_id(source: &SkillSourceMetadata, content_hash: &str) -> String {
    let mut hasher = Sha256::new();
    for value in [
        source.source_kind.as_str(),
        source.source_identity.as_str(),
        source.subdirectory.as_str(),
        content_hash,
    ] {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    let digest = hasher.finalize();
    format!(
        "skill-{}",
        digest
            .iter()
            .take(16)
            .map(|value| format!("{value:02x}"))
            .collect::<String>()
    )
}

// 计算当前应用数据下的 Skill 专属目录，不与外部 CLI Home 混用。
pub(crate) fn skills_root() -> Result<PathBuf, String> {
    Ok(crate::app_paths::cli_manager_data_dir()?
        .join("extensions")
        .join("skills"))
}

// 统一模式文本，供数据库 CHECK 和前端显示共用。
pub(super) fn mode_string(mode: SkillSyncMode) -> &'static str {
    match mode {
        SkillSyncMode::Auto => "auto",
        SkillSyncMode::Symlink => "symlink",
        SkillSyncMode::Copy => "copy",
    }
}

// 根据安装状态返回可读稳定状态码，不把 IO 详情直接暴露到列表。
async fn inspect_installation(record: &SkillInstallationRecord) -> Result<String, String> {
    if record.environment_kind == "wsl" {
        return super::skill_wsl::inspect_installation(record).await;
    }
    Ok(match inspect_local_target(record)? {
        TargetState::Missing => "missing".to_string(),
        TargetState::Owned if record.external_modified => "active".to_string(),
        TargetState::Owned => "active".to_string(),
        TargetState::External => "externalModified".to_string(),
        TargetState::Error(_) => "unreadable".to_string(),
    })
}

// 按应用数据根的受管边界检查包路径，拒绝数据库被手工改成外部目录。
fn ensure_managed_package_path(path: &Path) -> Result<(), String> {
    let root = skills_root()?.join("packages");
    ensure_child_path(&root, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn source_metadata() -> SkillSourceMetadata {
        SkillSourceMetadata {
            source_kind: "native".to_string(),
            source_identity: "fixture".to_string(),
            source_ref: String::new(),
            resolved_commit: None,
            subdirectory: String::new(),
            version: None,
        }
    }

    fn write_skill(root: &Path, name: &str) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: demo\n---\n# body\n"),
        )
        .unwrap();
        fs::write(root.join("helper.txt"), "helper").unwrap();
    }

    #[test]
    // 验证包哈希包含相对路径和正文，修改外部源后预览指纹会变化且源目录不被写入。
    fn skill_scan_is_deterministic_and_detects_content_changes() {
        let directory = tempdir().unwrap();
        let package = directory.path().join("demo");
        write_skill(&package, "demo");
        let first = scan_skill_package(&package, source_metadata()).unwrap();
        let second = scan_skill_package(&package, source_metadata()).unwrap();
        assert_eq!(first.content_hash, second.content_hash);
        fs::write(package.join("helper.txt"), "changed").unwrap();
        let changed = scan_skill_package(&package, source_metadata()).unwrap();
        assert_ne!(first.content_hash, changed.content_hash);
    }

    #[test]
    // 验证链接文件不会被扫描或复制到受管包，避免包内容通过链接逃逸源目录。
    fn skill_scan_rejects_symlink_entries() {
        let directory = tempdir().unwrap();
        let package = directory.path().join("demo");
        write_skill(&package, "demo");
        let outside = directory.path().join("outside.txt");
        fs::write(&outside, "outside").unwrap();
        let link = package.join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
            return;
        }
        assert_eq!(
            scan_skill_package(&package, source_metadata()).unwrap_err(),
            "extensions_skill_symlink_rejected"
        );
    }

    #[test]
    // 验证名称保留大小写但拒绝路径分隔符和 Windows 设备名。
    fn skill_names_are_portable_without_lowercase_deduplication() {
        assert!(validate_skill_display_name("Foo-Bar").is_ok());
        assert!(validate_skill_display_name("foo/bar").is_err());
        if cfg!(target_os = "windows") {
            assert!(validate_skill_display_name("CON").is_err());
        }
    }

    #[test]
    // 验证 auto 只由权限/能力错误触发回退，普通目标冲突不被吞成复制成功。
    fn auto_fallback_error_classification_is_narrow() {
        assert!(is_link_fallback_error(
            "extensions_skill_symlink_failed:1314:客户端没有所需的特权。"
        ));
        assert!(is_link_fallback_error(
            "extensions_skill_symlink_failed:Permission denied"
        ));
        assert!(is_link_fallback_error(
            "extensions_skill_symlink_failed:operation not supported"
        ));
        assert!(!is_link_fallback_error(
            "extensions_skill_symlink_failed:disk full"
        ));
    }

    #[test]
    fn auto_deployment_uses_real_temporary_directory() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        write_skill(&source, "docx");
        let target = root.path().join("target");
        let (mode, _) = stage_deployment(&source, &target, SkillSyncMode::Auto).unwrap();
        assert!(target.join("SKILL.md").is_file());
        assert!(matches!(mode, "copy" | "symlink"));
        println!("temporary auto deployment mode: {mode}");
        remove_path_if_present(&target).unwrap();
        assert!(source.join("SKILL.md").is_file());
    }

    #[test]
    // 应用数据目录的任一既有前缀为链接时，受管目录创建和子路径检查都失败关闭。
    fn managed_path_helpers_reject_link_ancestors() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("managed");
        fs::create_dir(&root).unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let link = root.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
            return;
        }
        assert!(ensure_child_path(&root, &link.join("child")).is_err());
        assert!(ensure_owned_directory(&link.join("created")).is_err());
    }
}
