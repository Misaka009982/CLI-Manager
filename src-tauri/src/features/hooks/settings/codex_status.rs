use super::*;
use toml_edit::DocumentMut;

// 兼容不指定 profile 的全局状态测试和旧调用语义。

#[cfg(test)]
pub(super) fn build_codex_status(dir: Option<PathBuf>) -> Result<ToolHookSettingsStatus, String> {
    build_codex_status_for_profile(dir, None)
}

// profile 仅是 Codex Home 内的文件名，不接受路径、扩展名或任意文件读取。
fn validate_profile_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("codex_hook_profile_name_invalid".to_string());
    }
    Ok(name)
}

// 与 --profile 一致：全局为底，当前 profile 深度覆盖；指定文件缺失必须显式失败。
fn read_effective_config(
    dir: &Path,
    profile: Option<&str>,
) -> Result<(DocumentMut, PathBuf), String> {
    let base_path = dir.join(CODEX_CONFIG_FILE_NAME);
    let base = read_text_if_exists(&base_path)?.unwrap_or_default();
    let mut document = base.parse::<DocumentMut>().map_err(|err| {
        format!(
            "codex_hook_config_invalid: {}: {err}",
            path_to_string(&base_path)
        )
    })?;
    let Some(profile) = profile else {
        return Ok((document, base_path));
    };
    let path = dir.join(format!("{profile}.config.toml"));
    let text = read_text_if_exists(&path)?
        .ok_or_else(|| format!("codex_hook_profile_missing: {}", path_to_string(&path)))?;
    let overlay = text.parse::<DocumentMut>().map_err(|err| {
        format!(
            "codex_hook_config_invalid: {}: {err}",
            path_to_string(&path)
        )
    })?;
    crate::provider::repository::merge_toml_items(document.as_item_mut(), overlay.into_item());
    Ok((document, path))
}

// 检查 Codex 事件、提问 matcher、hooks 开关和信任哈希并汇总状态。
pub(super) fn build_codex_status_for_profile(
    codex_dir: Option<PathBuf>,
    profile_name: Option<&str>,
) -> Result<ToolHookSettingsStatus, String> {
    let profile_name = profile_name.map(validate_profile_name).transpose()?;
    let Some(codex_dir) = codex_dir else {
        return missing_status();
    };

    let hooks_dir = codex_dir.join("hooks");
    let hooks_path = codex_dir.join(CODEX_HOOKS_FILE_NAME);
    let config_path = codex_dir.join(CODEX_CONFIG_FILE_NAME);
    let (effective, effective_path) = read_effective_config(&codex_dir, profile_name)?;
    let exe = hook_exe_for_dir(&codex_dir).ok();
    let settings = read_json_if_exists(&hooks_path)?;
    let registered = |event: &str| {
        exe.as_deref().is_some_and(|exe| {
            exact_command_registered(&settings, event, &build_command(exe, "codex", event))
        })
    };
    let checks = ToolChecks {
        attention_script_installed: exe.is_some(),
        finished_script_installed: exe.is_some(),
        session_start_hook_installed: registered("SessionStart"),
        running_hook_installed: registered("UserPromptSubmit"),
        attention_hook_installed: registered("PermissionRequest")
            && registered_exact_command_with_matcher(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "codex",
                "Notification",
                CODEX_QUESTION_TOOL_MATCHER,
            ),
        attention_hook_required: true,
        stop_hook_installed: registered("Stop"),
        failure_hook_installed: false,
        failure_hook_required: false,
        subagent_start_hook_installed: registered("SubagentStart")
            && registered("SubagentStop")
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PreToolUse",
                "codex",
                "ToolStart",
            )
            && registered_exact_command(
                &settings,
                exe.as_deref(),
                "PostToolUse",
                "codex",
                "ToolStop",
            ),
        subagent_start_hook_required: true,
        hooks_feature_installed: effective
            .get("features")
            .and_then(|v| v.get("hooks"))
            .and_then(toml_edit::Item::as_bool)
            == Some(true),
        hooks_trusted: codex::codex_hooks_trusted_in_config(
            &settings,
            &hooks_path,
            &toml::from_str(&effective.to_string())
                .map_err(|err| format!("codex_effective_config_invalid: {err}"))?,
        )?,
    };

    let mut status = status_from_checks(
        Some(codex_dir),
        Some(hooks_dir),
        Some(hooks_path),
        Some(config_path),
        checks,
    );
    status.effective_config_path = Some(path_to_string(&effective_path));
    Ok(status)
}
