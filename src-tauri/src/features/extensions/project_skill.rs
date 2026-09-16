use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::skill_deployment;
use super::skill_repository::SkillPackageRecord;

const PROJECT_AGENTS_DIR: &str = ".agents";
const PROJECT_SKILLS_DIR: &str = "skills";
const SNAPSHOT_DIR: &str = "project-snapshots";
const SNAPSHOT_MANIFEST: &str = "manifest.json";
const MAX_DISCOVERED_SKILLS: usize = 4096;
const MAX_DISCOVERY_DEPTH: usize = 12;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSkillTarget {
    pub name: String,
    pub path: String,
    pub content_hash: String,
    #[serde(default)]
    pub managed: bool,
    // Runtime-only marker. It is intentionally not persisted in the snapshot manifest;
    // a target created by a previous snapshot is still eligible for normal release checks,
    // but must never be removed by cleanup for a later failed preparation.
    #[serde(skip)]
    pub created: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotTargets {
    #[serde(default)]
    project_skill_targets: Vec<ProjectSkillTarget>,
}

// Codex 只会发现项目目录的 .agents/skills；应用数据包必须先以临时受管副本进入该目录。
pub(crate) fn materialize_local(
    project_path: &Path,
    packages: &[SkillPackageRecord],
    selected_ids: &[String],
    managed_paths: &BTreeSet<String>,
) -> Result<Vec<ProjectSkillTarget>, String> {
    let root = project_skills_root(project_path)?;
    let selected = selected_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut selected_packages = BTreeMap::new();
    for package in packages {
        if selected.contains(package.package_id.as_str())
            && selected_packages
                .insert(package.name.clone(), package)
                .is_some()
        {
            return Err("extensions_project_skill_name_conflict".to_string());
        }
    }

    let mut targets = Vec::with_capacity(selected_packages.len());
    let result = (|| {
        for (name, package) in selected_packages {
            skill_deployment::validate_skill_display_name(&name)?;
            let target = root.join(&name);
            let target_text = target.to_string_lossy().into_owned();
            let (managed, created) = if path_exists(&target)? {
                let metadata = fs::symlink_metadata(&target)
                    .map_err(|_| "extensions_project_skill_target_unreadable".to_string())?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("extensions_project_skill_target_conflict".to_string());
                }
                let hash = skill_deployment::managed_package_content_hash(&target)
                    .map_err(|_| "extensions_project_skill_target_conflict".to_string())?;
                if hash != package.content_hash {
                    return Err("extensions_project_skill_target_conflict".to_string());
                }
                (managed_paths.contains(&target_text), false)
            } else {
                skill_deployment::copy_managed_package_to_target(package, &target)?;
                let hash = skill_deployment::managed_package_content_hash(&target)?;
                if hash != package.content_hash {
                    let _ = skill_deployment::remove_path_if_present(&target);
                    return Err("extensions_project_skill_target_verification_failed".to_string());
                }
                (true, true)
            };
            targets.push(ProjectSkillTarget {
                name,
                path: target_text,
                content_hash: package.content_hash.clone(),
                managed,
                created,
            });
        }
        Ok(std::mem::take(&mut targets))
    })();
    if result.is_err() {
        cleanup_uncommitted(&targets);
    }
    result
}

// 当前实现只在本机直接启动时物化；WSL 的 Windows UNC 路径不能被本机复制逻辑误当作 Linux 目录。
pub(crate) fn reject_non_local(environment_kind: &str) -> Result<(), String> {
    if environment_kind == "local" {
        Ok(())
    } else {
        Err("extensions_project_codex_skill_environment_unsupported".to_string())
    }
}

// 枚举 Codex 的用户根和项目祖先根；skills.config 只能筛选已发现文件，不能加载应用数据目录中的包。
pub(crate) fn discovered_codex_skill_paths(project_path: &Path) -> Result<Vec<PathBuf>, String> {
    let project_root = project_skills_root(project_path)?;
    let config_root = crate::provider::home::default_config_root("codex")
        .ok_or_else(|| "extensions_project_codex_skill_root_unavailable".to_string())?;
    let home = config_root
        .parent()
        .ok_or_else(|| "extensions_project_codex_skill_root_unavailable".to_string())?;
    let mut roots = BTreeSet::from([
        home.join(PROJECT_AGENTS_DIR).join(PROJECT_SKILLS_DIR),
        config_root.join("plugins").join("cache"),
        config_root.join(PROJECT_SKILLS_DIR),
        project_root,
    ]);
    let mut ancestor = project_path.to_path_buf();
    loop {
        roots.insert(ancestor.join(PROJECT_AGENTS_DIR).join(PROJECT_SKILLS_DIR));
        if !ancestor.pop() {
            break;
        }
    }
    let mut paths = BTreeSet::new();
    for root in roots {
        collect_skill_paths(&root, 0, &mut paths);
    }
    Ok(paths.into_iter().collect())
}

// 读取仍在使用中的快照，避免另一个 Codex 会话退出时删除共享的项目 Skill 副本。
pub(crate) fn managed_target_paths() -> BTreeSet<String> {
    let Ok(root) = snapshot_directory() else {
        return BTreeSet::new();
    };
    let Ok(entries) = fs::read_dir(root) else {
        return BTreeSet::new();
    };
    let mut paths = BTreeSet::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(bytes) = fs::read(path.join(SNAPSHOT_MANIFEST)) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<SnapshotTargets>(&bytes) else {
            continue;
        };
        for target in manifest.project_skill_targets {
            if target.managed && validate_target_path(Path::new(&target.path)).is_ok() {
                paths.insert(target.path);
            }
        }
    }
    paths
}

// 释放快照时只删除最后一个引用的、且仍保持原始摘要的项目副本；外部同名目录永不删除。
pub(crate) fn release_targets(
    snapshot_id: &str,
    targets: &[ProjectSkillTarget],
) -> Result<(), String> {
    let active_paths = referenced_by_other_snapshots(snapshot_id);
    let mut seen = BTreeSet::new();
    for target in targets {
        if !target.managed
            || !seen.insert(target.path.clone())
            || active_paths.contains(&target.path)
        {
            continue;
        }
        remove_managed_target(target)?;
    }
    Ok(())
}

// 准备流程中途失败时只清理本次创建的目标；已有用户目录即使摘要相同也不拥有。
pub(crate) fn cleanup_uncommitted(targets: &[ProjectSkillTarget]) {
    for target in targets {
        if target.created {
            let _ = remove_managed_target(target);
        }
    }
}

fn project_skills_root(project_path: &Path) -> Result<PathBuf, String> {
    if !project_path.is_absolute() || project_path.to_string_lossy().chars().any(char::is_control) {
        return Err("extensions_project_skill_project_invalid".to_string());
    }
    let metadata = fs::symlink_metadata(project_path)
        .map_err(|_| "extensions_project_skill_project_missing".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("extensions_project_skill_project_invalid".to_string());
    }
    Ok(project_path
        .join(PROJECT_AGENTS_DIR)
        .join(PROJECT_SKILLS_DIR))
}

fn snapshot_directory() -> Result<PathBuf, String> {
    Ok(crate::app_paths::cli_manager_data_dir()?
        .join("extensions")
        .join(SNAPSHOT_DIR))
}

fn referenced_by_other_snapshots(snapshot_id: &str) -> BTreeSet<String> {
    let Ok(root) = snapshot_directory() else {
        return BTreeSet::new();
    };
    let Ok(entries) = fs::read_dir(root) else {
        return BTreeSet::new();
    };
    let mut paths = BTreeSet::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().and_then(|value| value.to_str()) == Some(snapshot_id) {
            continue;
        }
        let Ok(bytes) = fs::read(path.join(SNAPSHOT_MANIFEST)) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<SnapshotTargets>(&bytes) else {
            continue;
        };
        for target in manifest.project_skill_targets {
            if validate_target_path(Path::new(&target.path)).is_ok() {
                paths.insert(target.path);
            }
        }
    }
    paths
}

fn remove_managed_target(target: &ProjectSkillTarget) -> Result<(), String> {
    let path = PathBuf::from(&target.path);
    validate_target_path(&path)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("extensions_project_skill_release_conflict".to_string())
        }
        Ok(_) => {
            let hash = skill_deployment::managed_package_content_hash(&path)
                .map_err(|_| "extensions_project_skill_release_conflict".to_string())?;
            if hash != target.content_hash {
                return Err("extensions_project_skill_release_conflict".to_string());
            }
            skill_deployment::remove_path_if_present(&path)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("extensions_project_skill_release_failed".to_string()),
    }
}

fn validate_target_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.to_string_lossy().chars().any(char::is_control) {
        return Err("extensions_project_skill_target_invalid".to_string());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "extensions_project_skill_target_invalid".to_string())?;
    skill_deployment::validate_skill_display_name(name)?;
    let skills = path
        .parent()
        .filter(|value| {
            value.file_name().and_then(|item| item.to_str()) == Some(PROJECT_SKILLS_DIR)
        })
        .ok_or_else(|| "extensions_project_skill_target_invalid".to_string())?;
    if skills
        .parent()
        .and_then(|value| value.file_name().and_then(|item| item.to_str()))
        != Some(PROJECT_AGENTS_DIR)
    {
        return Err("extensions_project_skill_target_invalid".to_string());
    }
    Ok(())
}

fn path_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("extensions_project_skill_target_unreadable".to_string()),
    }
}

fn collect_skill_paths(root: &Path, depth: usize, output: &mut BTreeSet<PathBuf>) {
    if depth > MAX_DISCOVERY_DEPTH || output.len() >= MAX_DISCOVERED_SKILLS {
        return;
    }
    let Ok(metadata) = fs::symlink_metadata(root) else {
        return;
    };
    if metadata.file_type().is_symlink() {
        if root.join("SKILL.md").is_file() {
            output.insert(root.join("SKILL.md"));
        }
        return;
    }
    if !metadata.is_dir() {
        return;
    }
    if root.join("SKILL.md").is_file() {
        output.insert(root.join("SKILL.md"));
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        collect_skill_paths(&entry.path(), depth + 1, output);
        if output.len() >= MAX_DISCOVERED_SKILLS {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_path_must_be_direct_child_of_project_agents_skills() {
        let valid = if cfg!(windows) {
            PathBuf::from(r"C:\project\.agents\skills\weekly-report")
        } else {
            PathBuf::from("/project/.agents/skills/weekly-report")
        };
        assert!(validate_target_path(&valid).is_ok());
        assert!(validate_target_path(&valid.join("nested")).is_err());
    }

    #[test]
    fn cleanup_marker_is_not_serialized_or_applied_to_existing_targets() {
        let target = ProjectSkillTarget {
            name: "weekly-report".to_string(),
            path: if cfg!(windows) {
                r"C:\project\.agents\skills\weekly-report".to_string()
            } else {
                "/project/.agents/skills/weekly-report".to_string()
            },
            content_hash: "sha256-test".to_string(),
            managed: true,
            created: false,
        };
        let value = serde_json::to_value(&target).unwrap();
        assert_eq!(
            value.get("managed").and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert!(value.get("created").is_none());
    }

    #[test]
    fn non_local_project_skill_materialization_is_explicitly_rejected() {
        assert!(reject_non_local("local").is_ok());
        assert_eq!(
            reject_non_local("wsl").unwrap_err(),
            "extensions_project_codex_skill_environment_unsupported"
        );
    }
}
