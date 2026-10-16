use super::super::codex_deletion::{
    collect_codex_deletion_paths, delete_codex_session_with_backup_root,
};
use super::*;
use std::path::PathBuf;
use uuid::Uuid;

// 使用独立 Codex Home，不访问真实日志/索引或应用备份目录。
fn deletion_roots(temp: &TempDir) -> HistoryRoots {
    HistoryRoots {
        codex_config_dir: Some(temp.path().join(".codex")),
        ..HistoryRoots::default()
    }
}

// 原始 metadata 与真实日期 rollout 布局；fork 和 thread_spawn 分开构造。
fn rollout(root: &Path, day: &str, id: u128, parent: Option<u128>, fork: Option<u128>) -> PathBuf {
    let id = Uuid::from_u128(id).to_string();
    let mut payload = json!({ "id": id, "cwd": "F:/removed-project" });
    if let Some(parent) = parent {
        let parent = Uuid::from_u128(parent).to_string();
        payload["parent_thread_id"] = json!(parent);
        payload["source"] =
            json!({ "subagent": { "thread_spawn": { "parent_thread_id": parent, "depth": 1 } } });
    }
    if let Some(fork) = fork {
        payload["forked_from_id"] = json!(Uuid::from_u128(fork).to_string());
    }
    let path = root
        .join(day)
        .join(format!("rollout-2026-07-17T22-37-25-{id}.jsonl"));
    write_text(
        &path,
        &format!(
            "{}\n{}\n",
            json!({"type": "session_meta", "payload": payload}),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "keep exact bytes" } })
        ),
    );
    path
}

// 通过正式来源/项目校验获取待删除对象，证明项目目录不存在不会阻止删除。
fn validated(path: &Path, roots: &HistoryRoots) -> SessionFileRef {
    validate_session_file_ref_for_deletion(
        &path.to_string_lossy(),
        "codex",
        "removed-project",
        roots,
    )
    .unwrap()
}

// 所有目标备份都应保留原始完整字节，而非仅元数据。
fn backup_bytes(backups: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect_files_recursive(backups, &mut files, &|path| is_jsonl(path));
    files
        .into_iter()
        .map(|path| fs::read_to_string(path).unwrap())
        .collect()
}

#[test]
// 孤立子代理及其后代可删除，父文件不需要存在，兄弟和无关日志保留。
fn codex_history_delete_orphan_with_descendants() {
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let child = rollout(&root, "2026/07/17", 2, Some(1), None);
    let grandchild = rollout(&root, "2026/07/18", 3, Some(2), None);
    let sibling = rollout(&root, "2026/07/19", 4, Some(1), None);
    let unrelated = rollout(&root, "2026/07/19", 5, None, None);
    let originals = [
        fs::read_to_string(&child).unwrap(),
        fs::read_to_string(&grandchild).unwrap(),
    ];
    let backups = temp.path().join("backups");
    let deleted =
        delete_codex_session_with_backup_root(&validated(&child, &roots), &root, &backups).unwrap();
    assert_eq!(deleted.len(), 2);
    assert!(!child.exists());
    assert!(!grandchild.exists());
    assert!(sibling.exists());
    assert!(unrelated.exists());
    let snapshots = backup_bytes(&backups);
    assert_eq!(snapshots.len(), 2);
    assert!(originals.iter().all(|bytes| snapshots.contains(bytes)));
}

#[test]
// 父仍存在时删除子代理，不追删父或其他同父子代理。
fn codex_history_delete_child_preserves_existing_parent_and_sibling() {
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let parent = rollout(&root, "2026/07/15", 1, None, None);
    let child = rollout(&root, "2026/07/17", 2, Some(1), None);
    let sibling = rollout(&root, "2026/07/18", 3, Some(1), None);
    let deleted = delete_codex_session_with_backup_root(
        &validated(&child, &roots),
        &root,
        &temp.path().join("backups"),
    )
    .unwrap();
    assert_eq!(deleted.len(), 1);
    assert!(!child.exists());
    assert!(parent.exists());
    assert!(sibling.exists());
}

#[test]
// 父删除跨日期/工作目录级联，但普通 fork、元数据 parent 和另一根记录不被混入。
fn codex_history_delete_parent_cascades_only_explicit_thread_spawn() {
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let parent = rollout(&root, "2026/07/15", 1, None, None);
    let child = rollout(&root, "2026/07/17", 2, Some(1), None);
    let grandchild = rollout(&root, "2026/08/18", 3, Some(2), None);
    let raw = fs::read_to_string(&grandchild)
        .unwrap()
        .replace("F:/removed-project", "D:/another-project");
    write_text(&grandchild, &raw);
    let fork = rollout(&root, "2026/07/19", 4, None, Some(1));
    let metadata_only = rollout(&root, "2026/07/19", 5, None, None);
    let raw = fs::read_to_string(&metadata_only).unwrap().replace(
        "\"id\":",
        &format!("\"parent_thread_id\":\"{}\",\"id\":", Uuid::from_u128(1)),
    );
    write_text(&metadata_only, &raw);
    let outside = rollout(
        &temp.path().join("another-home"),
        "2026/07/17",
        2,
        Some(1),
        None,
    );
    let paths = collect_codex_deletion_paths(&validated(&parent, &roots), &root).unwrap();
    assert_eq!(
        paths,
        [
            grandchild.canonicalize().unwrap(),
            child.canonicalize().unwrap(),
            parent.canonicalize().unwrap()
        ]
    );
    let deleted = delete_codex_session_with_backup_root(
        &validated(&parent, &roots),
        &root,
        &temp.path().join("backups"),
    )
    .unwrap();
    assert_eq!(deleted.len(), 3);
    for path in [&parent, &child, &grandchild] {
        assert!(!path.exists());
    }
    for path in [&fork, &metadata_only, &outside] {
        assert!(path.exists());
    }
}

#[test]
// 普通分叉自身可删除，不连带它的 fork 来源或同源子代理。
fn codex_history_delete_fork_is_independent() {
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let parent = rollout(&root, "2026/07/15", 1, None, None);
    let child = rollout(&root, "2026/07/17", 2, Some(1), None);
    let fork = rollout(&root, "2026/07/19", 3, None, Some(1));
    delete_codex_session_with_backup_root(
        &validated(&fork, &roots),
        &root,
        &temp.path().join("backups"),
    )
    .unwrap();
    assert!(!fork.exists());
    assert!(parent.exists());
    assert!(child.exists());
}

#[test]
// 重复选中或后代 UUID 不能靠文件排序决定误删范围。
fn codex_history_delete_rejects_ambiguous_identity_before_backup() {
    for duplicate_id in [1, 2] {
        let temp = TempDir::new().unwrap();
        let roots = deletion_roots(&temp);
        let root = resolve_codex_history_root(&roots);
        let parent = rollout(&root, "2026/07/15", 1, None, None);
        let child = rollout(&root, "2026/07/17", 2, Some(1), None);
        let duplicate = rollout(&root, "2026/08/17", duplicate_id, None, None);
        let backups = temp.path().join("backups");
        assert_eq!(
            delete_codex_session_with_backup_root(&validated(&parent, &roots), &root, &backups)
                .unwrap_err(),
            "history_codex_deletion_ambiguous"
        );
        assert!(parent.exists() && child.exists() && duplicate.exists());
        assert!(!backups.exists());
    }
}

#[test]
// 不完整/错配 metadata 和循环关系全部在备份前拒绝。
fn codex_history_delete_rejects_invalid_metadata_and_cycles() {
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let parent = rollout(&root, "2026/07/15", 1, Some(2), None);
    let child = rollout(&root, "2026/07/17", 2, Some(1), None);
    assert_eq!(
        collect_codex_deletion_paths(&validated(&parent, &roots), &root).unwrap_err(),
        "history_codex_deletion_ambiguous"
    );
    let target = validated(&parent, &roots);
    write_text(&parent, "{}\n");
    assert_eq!(
        collect_codex_deletion_paths(&target, &root).unwrap_err(),
        "history_codex_deletion_metadata_invalid"
    );
    assert!(parent.exists() && child.exists());
}

#[test]
// 备份无法创建时全部原日志保持不变。
fn codex_history_delete_backup_failure_preserves_tree() {
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let parent = rollout(&root, "2026/07/15", 1, None, None);
    let child = rollout(&root, "2026/07/17", 2, Some(1), None);
    let backups = temp.path().join("backups");
    write_text(&backups, "not a directory");
    assert!(
        delete_codex_session_with_backup_root(&validated(&parent, &roots), &root, &backups)
            .is_err()
    );
    assert!(parent.exists() && child.exists());
}

#[test]
// 即使调用专用删除器，也不能通过另一 Home 的路径绕过根限制。
fn codex_history_delete_rejects_other_root_and_source() {
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let parent = rollout(&root, "2026/07/15", 1, None, None);
    let mut target = validated(&parent, &roots);
    target.path = rollout(&temp.path().join("outside"), "2026/07/15", 1, None, None);
    assert_eq!(
        collect_codex_deletion_paths(&target, &root).unwrap_err(),
        "session_file_outside_history_scope"
    );
    target.source = "claude".into();
    assert_eq!(
        collect_codex_deletion_paths(&target, &root).unwrap_err(),
        "unsupported_history_mutation_source"
    );
}

#[cfg(windows)]
#[test]
// 父日志被 Windows 句柄锁定时，已经删除的后代从精确备份恢复。
fn codex_history_delete_locked_parent_rolls_back_descendants() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let parent = rollout(&root, "2026/07/15", 1, None, None);
    let child = rollout(&root, "2026/07/17", 2, Some(1), None);
    let child_bytes = fs::read(&child).unwrap();
    let handle = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&parent)
        .unwrap();
    let error = delete_codex_session_with_backup_root(
        &validated(&parent, &roots),
        &root,
        &temp.path().join("backups"),
    )
    .unwrap_err();
    assert!(error.starts_with("failedRolledBack:"), "{error}");
    assert_eq!(fs::read(&child).unwrap(), child_bytes);
    assert!(parent.exists());
    drop(handle);
}

#[test]
// CamelCase thread_spawn 与 session_id 头部兼容，长消息正文不会进入关系扫描。
fn codex_history_delete_compatible_header_fields() {
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let parent = rollout(&root, "2026/07/15", 1, None, None);
    let child = rollout(&root, "2026/07/17", 2, Some(1), None);
    let mut header: Value =
        serde_json::from_str(fs::read_to_string(&child).unwrap().lines().next().unwrap()).unwrap();
    let payload = header.get_mut("payload").unwrap().as_object_mut().unwrap();
    let id = payload.remove("id").unwrap();
    payload.insert("session_id".into(), id);
    let spawn = payload
        .get_mut("source")
        .unwrap()
        .pointer_mut("/subagent/thread_spawn")
        .unwrap()
        .as_object_mut()
        .unwrap();
    let id = spawn.remove("parent_thread_id").unwrap();
    spawn.insert("parentThreadId".into(), id);
    write_text(
        &child,
        &format!("{}\n{}", header, "x".repeat(2 * 1024 * 1024)),
    );
    let paths = collect_codex_deletion_paths(&validated(&parent, &roots), &root).unwrap();
    assert_eq!(
        paths,
        [
            child.canonicalize().unwrap(),
            parent.canonicalize().unwrap()
        ]
    );
}

#[test]
// 原身份与文件名不一致或头部读取达到上限，不能报告删除成功。
fn codex_history_delete_rejects_header_mismatch_and_unbounded_header() {
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let parent = rollout(&root, "2026/07/15", 1, None, None);
    let target = validated(&parent, &roots);
    let raw = fs::read_to_string(&parent).unwrap().replace(
        &Uuid::from_u128(1).to_string(),
        &Uuid::from_u128(2).to_string(),
    );
    write_text(&parent, &raw);
    assert_eq!(
        collect_codex_deletion_paths(&target, &root).unwrap_err(),
        "history_codex_deletion_metadata_invalid"
    );
    write_text(&parent, &"x".repeat(2 * 1024 * 1024));
    assert_eq!(
        collect_codex_deletion_paths(&target, &root).unwrap_err(),
        "history_codex_deletion_inventory_incomplete"
    );
    assert!(parent.exists());
}

#[cfg(any(unix, windows))]
#[test]
// 根内目录链接不被跟随，另一 Home 的同 ID 不参与歧义判断或级联。
fn codex_history_delete_does_not_follow_directory_links() {
    let temp = TempDir::new().unwrap();
    let roots = deletion_roots(&temp);
    let root = resolve_codex_history_root(&roots);
    let parent = rollout(&root, "2026/07/15", 1, None, None);
    let child = rollout(&root, "2026/07/17", 2, Some(1), None);
    let outside_root = temp.path().join("outside");
    let outside = rollout(&outside_root, "2026/07/17", 2, Some(1), None);
    let link = root.join("linked-home");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside_root, &link).unwrap();
    #[cfg(windows)]
    {
        let output = crate::shell_resolver::silent_command("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside_root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let deleted = delete_codex_session_with_backup_root(
        &validated(&parent, &roots),
        &root,
        &temp.path().join("backups"),
    )
    .unwrap();
    assert_eq!(deleted.len(), 2);
    assert!(!parent.exists() && !child.exists());
    assert!(outside.exists());
    assert!(link.exists());
}
