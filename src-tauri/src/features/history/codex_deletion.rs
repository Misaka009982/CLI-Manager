use super::deletion::delete_session_files_with_backup_root;
use super::{extract_session_meta_id, path_within_history_scope, SessionFileRef};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const META_BYTE_LIMIT: u64 = 1024 * 1024;

struct CodexDeletionEntry {
    path: PathBuf,
    id: String,
    subagent_parent: Option<String>,
}

// 不复用会吞读取错误的历史扫描；只枚举普通 rollout，WSL 沿用 guest find 边界。
fn rollout_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let root_text = root.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&root_text) {
        let (distro, linux_root) = crate::wsl::parse_wsl_unc_path(&root_text)
            .ok_or_else(|| "history_source_not_found".to_string())?;
        let program = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
        let (stdout, _) = super::wsl_command_text(
            &program.to_string_lossy(),
            &[
                "-d",
                &distro,
                "--exec",
                "find",
                &linux_root,
                "-type",
                "f",
                "-name",
                "rollout-*.jsonl",
                "-print0",
            ],
        )?;
        if !stdout.is_empty() && !stdout.ends_with('\0') {
            return Err("history_codex_deletion_inventory_incomplete".to_string());
        }
        return Ok(stdout
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(|path| PathBuf::from(crate::wsl::linux_to_unc_wsl_path(path, &distro)))
            .collect());
    }

    let mut dirs = vec![root.to_path_buf()];
    let mut paths = Vec::new();
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|err| err.to_string())?;
            if is_link(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                dirs.push(entry.path());
            } else if metadata.is_file() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                    paths.push(entry.path());
                }
            }
        }
    }
    Ok(paths)
}

// Windows junction 等 reparse 与符号链接一样不能扩大删除范围。
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

// 只读有界头部；fork/普通 parent 字段不证明子代理归属，不能据此级联删除。
fn read_entry(path: &Path) -> Result<Option<CodexDeletionEntry>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    let mut reader = BufReader::new(file).take(META_BYTE_LIMIT);
    let mut line = String::new();
    for _ in 0..32 {
        line.clear();
        if reader.read_line(&mut line).map_err(|err| err.to_string())? == 0 {
            break;
        }
        if reader.limit() == 0 {
            return Err("history_codex_deletion_inventory_incomplete".to_string());
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim().trim_start_matches('\u{feff}'))
        else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let Some(id) = extract_session_meta_id(&value)
            .or_else(|| {
                value
                    .pointer("/payload/session_id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .and_then(|id| Uuid::parse_str(id.trim()).ok())
        else {
            return Ok(None);
        };
        let id = id.to_string();
        if !path.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(&format!("-{id}.jsonl"))
        }) {
            return Ok(None);
        }
        let spawn = value.pointer("/payload/source/subagent/thread_spawn");
        let subagent_parent = spawn
            .and_then(|spawn| {
                spawn
                    .get("parent_thread_id")
                    .or_else(|| spawn.get("parentThreadId"))
            })
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id.trim()).ok())
            .map(|id| id.to_string());
        return Ok(Some(CodexDeletionEntry {
            path: path.to_path_buf(),
            id,
            subagent_parent,
        }));
    }
    Ok(None)
}

// 全根原始元数据决定后代；规范路径、UUID 歧义和关系环在备份/删除前失败关闭。
pub(super) fn collect_codex_deletion_paths(
    file_ref: &SessionFileRef,
    history_root: &Path,
) -> Result<Vec<PathBuf>, String> {
    if file_ref.source != "codex" {
        return Err("unsupported_history_mutation_source".to_string());
    }
    let root = history_root.canonicalize().map_err(|err| err.to_string())?;
    let target = file_ref
        .path
        .canonicalize()
        .map_err(|err| err.to_string())?;
    if !path_within_history_scope(&target, &root) {
        return Err("session_file_outside_history_scope".to_string());
    }
    let target_entry = read_entry(&target)?
        .ok_or_else(|| "history_codex_deletion_metadata_invalid".to_string())?;
    let target_id = target_entry.id;
    let inventory_root = if crate::wsl::is_wsl_config_dir(&history_root.to_string_lossy()) {
        history_root
    } else {
        &root
    };
    let mut entries: HashMap<String, Vec<CodexDeletionEntry>> = HashMap::new();
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for path in rollout_paths(inventory_root)? {
        let canonical = path.canonicalize().map_err(|err| err.to_string())?;
        if !path_within_history_scope(&canonical, &root) {
            return Err("session_file_outside_history_scope".to_string());
        }
        let Some(entry) = read_entry(&canonical)? else {
            continue;
        };
        if let Some(parent) = &entry.subagent_parent {
            children
                .entry(parent.clone())
                .or_default()
                .push(entry.id.clone());
        }
        entries.entry(entry.id.clone()).or_default().push(entry);
    }
    let mut pending = vec![(target_id, false)];
    let mut visiting = HashSet::new();
    let mut paths = Vec::new();
    while let Some((id, expanded)) = pending.pop() {
        let matches = entries
            .get(&id)
            .filter(|entries| entries.len() == 1)
            .ok_or_else(|| "history_codex_deletion_ambiguous".to_string())?;
        if expanded {
            visiting.remove(&id);
            paths.push(matches[0].path.clone());
            continue;
        }
        if !visiting.insert(id.clone()) {
            return Err("history_codex_deletion_ambiguous".to_string());
        }
        pending.push((id.clone(), true));
        if let Some(descendants) = children.get(&id) {
            pending.extend(descendants.iter().cloned().map(|child| (child, false)));
        }
    }
    if paths.last() != Some(&target) {
        return Err("history_codex_deletion_ambiguous".to_string());
    }
    for path in &paths {
        let metadata = fs::symlink_metadata(path).map_err(|err| err.to_string())?;
        if is_link(&metadata)
            || !metadata.is_file()
            || path.canonicalize().ok().as_ref() != Some(path)
        {
            return Err("session_file_outside_history_scope".to_string());
        }
    }
    Ok(paths)
}

// 复用完整目标集备份/回滚，成功才向前端报告实际删除范围。
pub(super) fn delete_codex_session_with_backup_root(
    file_ref: &SessionFileRef,
    history_root: &Path,
    backups_dir: &Path,
) -> Result<Vec<String>, String> {
    let paths = collect_codex_deletion_paths(file_ref, history_root)?;
    delete_session_files_with_backup_root(file_ref, paths.clone(), backups_dir)?;
    Ok(paths
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}
