use super::super::codex_status::build_codex_status_for_profile;
use super::*;

// 全局保留八项，当前 profile 保存剩余一项，复现 Codex 实际分层持久化。
fn layered_fixture() -> (TempDir, PathBuf, PathBuf) {
    let temp = TempDir::new().unwrap();
    let dir = temp.path().to_path_buf();
    install_codex_hooks(&dir).unwrap();
    trust_installed_codex_hooks(&dir);
    let base_path = dir.join("config.toml");
    let mut base: toml::Value = toml::from_str(&fs::read_to_string(&base_path).unwrap()).unwrap();
    let state = base["hooks"]["state"].as_table_mut().unwrap();
    let key = state
        .keys()
        .find(|key| key.contains(":pre_tool_use:0:0"))
        .unwrap()
        .clone();
    let confirmation = state.remove(&key).unwrap();
    let profile = toml::toml! { hooks = { state = {} } };
    let mut profile = toml::Value::Table(profile);
    profile["hooks"]["state"]
        .as_table_mut()
        .unwrap()
        .insert(key, confirmation);
    let path = dir.join("managed.config.toml");
    fs::write(&path, toml::to_string(&profile).unwrap()).unwrap();
    fs::write(base_path, toml::to_string(&base).unwrap()).unwrap();
    (temp, dir, path)
}

// 把临时 Home 中真实九项哈希、profile 确认、生成写入和状态检测串起来验证。

#[test]
fn codex_profile_rebuild_keeps_effective_hook_review_complete() {
    let (_temp, dir, path) = layered_fixture();
    for _ in 0..3 {
        crate::provider::codex_profile::write_preserving_hook_state(&path, "model='updated'\n")
            .unwrap();
        let status = build_codex_status_for_profile(Some(dir.clone()), Some("managed")).unwrap();
        assert!(matches!(status.status, HookInstallStatus::Installed));
    }
}

// 读取有效配置为绿色，但全局和其他 profile 仍不能冒用此确认；所有字节不变。

#[test]
fn codex_status_combines_only_selected_profile_without_writing() {
    let (_temp, dir, path) = layered_fixture();
    let base_path = dir.join("config.toml");
    let base = fs::read(&base_path).unwrap();
    let profile = fs::read(&path).unwrap();
    assert!(matches!(
        build_codex_status(Some(dir.clone())).unwrap().status,
        HookInstallStatus::PartialInstalled
    ));
    let status = build_codex_status_for_profile(Some(dir.clone()), Some("managed")).unwrap();
    assert!(matches!(status.status, HookInstallStatus::Installed));
    assert!(status.hooks_trusted);
    assert_eq!(
        status.effective_config_path.as_deref(),
        Some(path_to_string(&path).as_str())
    );
    assert_eq!(
        status.feature_config_path.as_deref(),
        Some(path_to_string(&base_path).as_str())
    );
    fs::write(dir.join("other.config.toml"), "model='other'\n").unwrap();
    assert!(
        !build_codex_status_for_profile(Some(dir), Some("other"))
            .unwrap()
            .hooks_trusted
    );
    assert_eq!(fs::read(base_path).unwrap(), base);
    assert_eq!(fs::read(path).unwrap(), profile);
}

// 当前 profile 的显式禁用、旧哈希、空确认必须覆盖全局或保持待审核，不能自动修复。

#[test]
fn codex_profile_disabled_or_changed_decisions_stay_pending() {
    let (_temp, dir, path) = layered_fixture();
    let trusted = fs::read_to_string(&path).unwrap();
    for mutation in ["disabled", "stale", "missing"] {
        let mut profile: toml::Value = toml::from_str(&trusted).unwrap();
        let saved = profile["hooks"]["state"]
            .as_table_mut()
            .unwrap()
            .iter_mut()
            .next()
            .unwrap()
            .1
            .as_table_mut()
            .unwrap();
        match mutation {
            "disabled" => {
                saved.insert("enabled".into(), false.into());
            }
            "stale" => {
                saved.insert("trusted_hash".into(), "sha256:stale".into());
            }
            _ => {
                saved.remove("trusted_hash");
            }
        }
        let bytes = toml::to_string(&profile).unwrap();
        fs::write(&path, &bytes).unwrap();
        let status = build_codex_status_for_profile(Some(dir.clone()), Some("managed")).unwrap();
        assert!(!status.hooks_trusted, "{mutation}");
        assert!(matches!(status.status, HookInstallStatus::PartialInstalled));
        assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
    }
}

// 全局已经信任也不能压过 profile 中的禁用；特性开关同样按叠加结果读取。

#[test]
fn codex_profile_overrides_global_trust_and_features() {
    let (_temp, dir, path) = layered_fixture();
    // 把剩余确认写回全局，使全局完整，然后 profile 禁用同一键。
    let mut base: toml::Value =
        toml::from_str(&fs::read_to_string(dir.join("config.toml")).unwrap()).unwrap();
    let profile: toml::Value = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let (key, decision) = profile["hooks"]["state"]
        .as_table()
        .unwrap()
        .iter()
        .next()
        .unwrap();
    base["hooks"]["state"]
        .as_table_mut()
        .unwrap()
        .insert(key.clone(), decision.clone());
    fs::write(dir.join("config.toml"), toml::to_string(&base).unwrap()).unwrap();
    let mut overlay = profile.clone();
    overlay["hooks"]["state"][key]
        .as_table_mut()
        .unwrap()
        .insert("enabled".into(), false.into());
    fs::write(&path, toml::to_string(&overlay).unwrap()).unwrap();
    assert!(
        !build_codex_status_for_profile(Some(dir.clone()), Some("managed"))
            .unwrap()
            .hooks_trusted
    );
    for (base_flag, profile_flag) in [(true, false), (false, true)] {
        base["features"]["hooks"] = base_flag.into();
        fs::write(dir.join("config.toml"), toml::to_string(&base).unwrap()).unwrap();
        fs::write(&path, format!("[features]\nhooks={profile_flag}\n")).unwrap();
        let status = build_codex_status_for_profile(Some(dir.clone()), Some("managed")).unwrap();
        assert_eq!(status.hooks_feature_installed, profile_flag);
        assert!(status.hooks_trusted);
    }
}

// 指定 profile 失效时不能悄悄回退全局绿色；文件名边界不能被用来跳出 Home。

#[test]
fn codex_profile_invalid_or_missing_is_not_a_global_success() {
    let (_temp, dir, path) = layered_fixture();
    for name in ["../config", "..\\config", "a.config.toml", "", "a/b"] {
        assert!(
            build_codex_status_for_profile(Some(dir.clone()), Some(name))
                .unwrap_err()
                .contains("name_invalid")
        );
    }
    assert!(
        build_codex_status_for_profile(Some(dir.clone()), Some("missing"))
            .unwrap_err()
            .contains("profile_missing")
    );
    fs::write(&path, "[broken").unwrap();
    assert!(build_codex_status_for_profile(Some(dir), Some("managed"))
        .unwrap_err()
        .contains("config_invalid"));
    assert_eq!(fs::read_to_string(path).unwrap(), "[broken");
}
