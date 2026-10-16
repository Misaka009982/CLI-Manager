use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use toml_edit::{DocumentMut, Item, Table};

// 只读取本次同名普通文件；不沿 profile 符号链接覆盖用户其他配置。
fn read_profile(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => fs::read(path)
            .map(Some)
            .map_err(|err| format!("codex_profile_read_failed: {err}")),
        Ok(_) => Err("codex_profile_not_regular_file".to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("codex_profile_read_failed: {err}")),
    }
}

// 项目信任来自同名文件中用户已保存的决定，不能由供应商输入或其他 profile 授予。
fn preserve_project_trust(
    document: &mut DocumentMut,
    previous: Option<&DocumentMut>,
) -> Result<(), String> {
    if let Some(projects) = document.get_mut("projects") {
        for (_, project) in projects
            .as_table_like_mut()
            .ok_or("codex_profile_invalid_projects")?
            .iter_mut()
        {
            project
                .as_table_like_mut()
                .ok_or("codex_profile_invalid_project")?
                .remove("trust_level");
        }
    }
    let Some(projects) = previous.and_then(|doc| doc.get("projects")) else {
        return Ok(());
    };
    for (path, project) in projects
        .as_table_like()
        .ok_or("codex_profile_existing_invalid_projects")?
        .iter()
    {
        let project = project
            .as_table_like()
            .ok_or("codex_profile_existing_invalid_project")?;
        let Some(trust) = project.get("trust_level") else {
            continue;
        };
        if !matches!(trust.as_str(), Some("trusted" | "untrusted")) {
            return Err("codex_profile_existing_invalid_project_trust".to_string());
        }
        if document.get("projects").is_none() {
            document.insert("projects", Item::Table(Table::new()));
        }
        let target = document
            .get_mut("projects")
            .and_then(Item::as_table_like_mut)
            .ok_or("codex_profile_invalid_projects")?;
        if target.get(path).is_none() {
            target.insert(path, Item::Table(Table::new()));
        }
        target
            .get_mut(path)
            .and_then(Item::as_table_like_mut)
            .ok_or("codex_profile_invalid_project")?
            .insert("trust_level", trust.clone());
    }
    Ok(())
}

// 保留同名文件的 Hook 和目录信任；生成配置仍负责其他供应商选项。
fn profile_with_saved_state(generated: &str, previous: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut document = generated
        .parse::<DocumentMut>()
        .map_err(|err| format!("codex_profile_invalid: {err}"))?;
    if let Some(hooks) = document.get_mut("hooks") {
        hooks
            .as_table_like_mut()
            .ok_or("codex_profile_invalid_hooks")?
            .remove("state");
    }
    let previous = previous
        .map(|previous| {
            let text = std::str::from_utf8(previous).map_err(|_| "codex_profile_invalid_utf8")?;
            text.parse::<DocumentMut>()
                .map_err(|err| format!("codex_profile_existing_invalid: {err}"))
        })
        .transpose()?;
    preserve_project_trust(&mut document, previous.as_ref())?;
    if let Some(previous) = previous {
        if let Some(state) = previous.get("hooks").and_then(|hooks| hooks.get("state")) {
            if state.as_table_like().is_none() {
                return Err("codex_profile_existing_invalid_state".to_string());
            }
            if document.get("hooks").is_none() {
                document.insert("hooks", Item::Table(Table::new()));
            }
            document
                .get_mut("hooks")
                .and_then(Item::as_table_like_mut)
                .ok_or("codex_profile_invalid_hooks")?
                .insert("state", state.clone());
        }
    }
    Ok(document.to_string().into_bytes())
}

// 替换前重新核对源字节；发现其他写入者的新决定时拒绝覆盖，不声称跨进程 CAS。
fn replace_unchanged(path: &Path, staged: &Path, previous: Option<&[u8]>) -> Result<(), String> {
    if read_profile(path)?.as_deref() != previous {
        return Err("codex_profile_changed_during_write".to_string());
    }
    fs::rename(staged, path).map_err(|err| format!("codex_profile_replace_failed: {err}"))
}

// 生成配置先写同目录临时文件，再替换；任何解析/写入失败不截断原 profile。
pub(crate) fn write_preserving_hook_state(path: &Path, generated: &str) -> Result<(), String> {
    let previous = read_profile(path)?;
    let content = profile_with_saved_state(generated, previous.as_deref())?;
    let parent = path.parent().ok_or("codex_profile_parent_missing")?;
    fs::create_dir_all(parent).map_err(|err| format!("codex_profile_directory_failed: {err}"))?;
    let name = path
        .file_name()
        .ok_or("codex_profile_name_missing")?
        .to_string_lossy();
    let staged = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged)
        .map_err(|err| format!("codex_profile_stage_failed: {err}"))?;
    let outcome = (|| {
        file.write_all(&content)
            .and_then(|_| file.sync_all())
            .map_err(|err| format!("codex_profile_write_failed: {err}"))?;
        drop(file);
        replace_unchanged(path, &staged, previous.as_deref())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(&staged);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn repeated_runtime_launch_preserves_project_decisions_without_importing_supplier_trust() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("managed.config.toml");
        fs::write(
            &path,
            r#"
model = 'old'
[projects.'f:\gitrepository\cli-manager']
trust_level = 'trusted'
old_option = 42
[projects.'F:\worktree']
trust_level = 'untrusted'
[hooks.state.saved]
trusted_hash = 'confirmed'
"#,
        )
        .unwrap();
        let profile = crate::provider::runtime::CodexProviderProfile {
            profile_name: "managed".into(),
            model_provider: "provider".into(),
            profile_text: r#"
model = 'new'
[projects.'f:\gitrepository\cli-manager']
custom = 7
[projects.'F:\worktree']
trust_level = 'trusted'
[projects.foreign]
trust_level = 'trusted'
"#
            .into(),
        };
        for _ in 0..3 {
            crate::provider::runtime::write_codex_profile_to_dir(dir.path(), &profile).unwrap();
            let actual: toml::Value = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(actual["model"].as_str(), Some("new"));
            let trusted = &actual["projects"][r"f:\gitrepository\cli-manager"];
            assert_eq!(trusted["trust_level"].as_str(), Some("trusted"));
            assert_eq!(trusted["custom"].as_integer(), Some(7));
            assert!(trusted.get("old_option").is_none());
            assert_eq!(
                actual["projects"][r"F:\worktree"]["trust_level"].as_str(),
                Some("untrusted")
            );
            assert!(actual["projects"]["foreign"].get("trust_level").is_none());
            assert_eq!(
                actual["hooks"]["state"]["saved"]["trusted_hash"].as_str(),
                Some("confirmed")
            );
        }
        let second = dir.path().join("other.config.toml");
        write_preserving_hook_state(&second, &profile.profile_text).unwrap();
        let actual: toml::Value = toml::from_str(&fs::read_to_string(second).unwrap()).unwrap();
        for project in actual["projects"].as_table().unwrap().values() {
            assert!(project.get("trust_level").is_none());
        }
    }

    #[test]
    fn inline_project_tables_preserve_only_exact_saved_trust_keys() {
        let previous = br#"projects = { 'C:\repo' = { trust_level = 'untrusted', old = 1 } }"#;
        let bytes = profile_with_saved_state(
            r#"projects = { 'C:\repo' = { trust_level = 'trusted', fresh = 2 }, 'c:\repo' = { trust_level = 'trusted' } }"#,
            Some(previous),
        ).unwrap();
        let actual: toml::Value = toml::from_str(std::str::from_utf8(&bytes).unwrap()).unwrap();
        assert_eq!(
            actual["projects"][r"C:\repo"]["trust_level"].as_str(),
            Some("untrusted")
        );
        assert_eq!(
            actual["projects"][r"C:\repo"]["fresh"].as_integer(),
            Some(2)
        );
        assert!(actual["projects"][r"C:\repo"].get("old").is_none());
        assert!(actual["projects"][r"c:\repo"].get("trust_level").is_none());
    }

    #[test]
    fn invalid_project_decisions_never_overwrite_the_profile() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("managed.config.toml");
        for old in [
            "projects=1",
            "[projects]\nrepo=1",
            "[projects.repo]\ntrust_level='typo'",
            "[projects.repo]\ntrust_level=true",
        ] {
            fs::write(&path, old).unwrap();
            assert!(write_preserving_hook_state(&path, "model='new'").is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), old);
        }
    }

    // 远程托管的真实入口必须与普通启动共用状态保留写入，不只是测试私有合并函数。

    #[test]
    fn runtime_writer_preserves_codex_saved_trust_when_regenerating() {
        let dir = TempDir::new().unwrap();
        let profile = crate::provider::runtime::CodexProviderProfile {
            profile_name: "managed".into(),
            model_provider: "provider".into(),
            profile_text: "model='updated'\n".into(),
        };
        let path = dir.path().join("managed.config.toml");
        fs::write(&path, "[hooks.state.saved]\ntrusted_hash='confirmed'\n").unwrap();
        crate::provider::runtime::write_codex_profile_to_dir(dir.path(), &profile).unwrap();
        let actual: toml::Value = toml::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(actual["model"].as_str(), Some("updated"));
        assert_eq!(
            actual["hooks"]["state"]["saved"]["trusted_hash"].as_str(),
            Some("confirmed")
        );
    }

    // 模拟 Codex 在同名 profile 写入确认后，后续供应商重建仍保留，且模型更新生效。

    #[test]
    fn rebuilding_same_profile_preserves_saved_decisions_without_importing_supplier_state() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("managed.config.toml");
        let generated = "model='new'\n[hooks.state.supplied]\ntrusted_hash='must-not-import'\n";
        write_preserving_hook_state(&path, generated).unwrap();
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("must-not-import"));
        fs::write(&path, "model='old'\n[hooks.state.confirmed]\ntrusted_hash='saved'\n[hooks.state.disabled]\nenabled=false\ntrusted_hash='stale'\n").unwrap();
        for _ in 0..3 {
            write_preserving_hook_state(&path, generated).unwrap();
            let actual: toml::Value = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(actual["model"].as_str(), Some("new"));
            assert_eq!(
                actual["hooks"]["state"]["confirmed"]["trusted_hash"].as_str(),
                Some("saved")
            );
            assert_eq!(
                actual["hooks"]["state"]["disabled"]["enabled"].as_bool(),
                Some(false)
            );
            assert_eq!(
                actual["hooks"]["state"]["disabled"]["trusted_hash"].as_str(),
                Some("stale")
            );
            assert!(actual["hooks"]["state"].get("supplied").is_none());
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    // 不同 profile 不共享决定；全局配置和旧文件中的非 state 选项不被复制。

    #[test]
    fn decisions_stay_in_their_original_profile() {
        let dir = TempDir::new().unwrap();
        let first = dir.path().join("one.config.toml");
        let second = dir.path().join("two.config.toml");
        let home = dir.path().join("config.toml");
        fs::write(&home, "[hooks.state.global]\ntrusted_hash='global'\n").unwrap();
        fs::write(
            &first,
            "[hooks.state.local]\nenabled=false\n[notice]\nkey='old'\n",
        )
        .unwrap();
        write_preserving_hook_state(&first, "model='first'\n").unwrap();
        write_preserving_hook_state(&second, "model='second'\n").unwrap();
        assert!(!fs::read_to_string(&first).unwrap().contains("notice"));
        assert!(!fs::read_to_string(&second).unwrap().contains("hooks"));
        assert_eq!(
            fs::read_to_string(&home).unwrap(),
            "[hooks.state.global]\ntrusted_hash='global'\n"
        );
    }

    // 损坏旧配置或非法新配置都应报错而不丢失原字节。

    #[test]
    fn invalid_input_never_overwrites_existing_profile() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("managed.config.toml");
        for old in ["not valid toml", "[hooks]\nstate=1\n"] {
            fs::write(&path, old).unwrap();
            assert!(write_preserving_hook_state(&path, "model='new'\n").is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), old);
        }
        fs::write(&path, "model='old'\n").unwrap();
        assert!(write_preserving_hook_state(&path, "invalid!").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "model='old'\n");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    // 在替换前出现新的确认、禁用或文件创建时，保护其他写入者而不是覆盖。

    #[test]
    fn changed_source_is_preserved_and_reported() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("managed.config.toml");
        let staged = dir.path().join("stage.tmp");
        fs::write(&path, "new decision").unwrap();
        fs::write(&staged, "generated").unwrap();
        for previous in [None, Some(b"old decision".as_slice())] {
            assert_eq!(
                replace_unchanged(&path, &staged, previous).unwrap_err(),
                "codex_profile_changed_during_write"
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), "new decision");
        }
    }
}
