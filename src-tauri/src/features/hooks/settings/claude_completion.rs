use super::{
    add_hook_command_with_matcher, build_command, registered_exact_command_with_matcher,
    HOOK_COMMAND_MARKER,
};
use crate::claude_hook::DESKTOP_PET_E_COMPLETION_EVENT;
use serde_json::Value;

const COMPLETION_EVENTS: [&str; 2] = ["PostToolUse", "PostToolUseFailure"];

// 问答完成使用仅由 broker 消费的事件，不复用会进入子任务界面的 ToolStop。
pub(super) fn install_claude_completion_hooks(settings: &mut Value, exe: &str) {
    remove_claude_completion_hooks(settings);
    for native_event in COMPLETION_EVENTS {
        add_hook_command_with_matcher(
            settings,
            native_event,
            "",
            build_command(exe, "claude", DESKTOP_PET_E_COMPLETION_EVENT),
        );
    }
}

// 缺少成功/失败回调或 matcher 错误均视为未完整安装，不能只验证开始通知。
pub(super) fn claude_completion_hooks_installed(settings: &Value, exe: Option<&str>) -> bool {
    COMPLETION_EVENTS.iter().all(|native_event| {
        registered_exact_command_with_matcher(
            settings, exe, native_event, "claude", DESKTOP_PET_E_COMPLETION_EVENT, "",
        )
    })
}

// 完成回调归问答模块独立所有；同一原生事件中的子任务/第三方命令不受影响。
pub(super) fn remove_claude_completion_hooks(settings: &mut Value) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    for native_event in COMPLETION_EVENTS {
        let Some(entries) = hooks.get_mut(native_event).and_then(Value::as_array_mut) else {
            continue;
        };
        entries.retain_mut(|entry| {
            let Some(commands) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            commands.retain(|hook| {
                !hook.get("command").and_then(Value::as_str).is_some_and(is_completion_command)
            });
            !commands.is_empty()
        });
        if entries.is_empty() {
            hooks.remove(native_event);
        }
    }
    if hooks.is_empty() {
        settings.as_object_mut().map(|root| root.remove("hooks"));
    }
}

// 匹配生成器的完整命令尾部；兼容旧 exe 与 Windows/POSIX 引号，不使用来源或事件子串。
fn is_completion_command(command: &str) -> bool {
    let suffix = format!(" {HOOK_COMMAND_MARKER} --source claude --event {DESKTOP_PET_E_COMPLETION_EVENT}");
    command.trim_end().trim_end_matches('"').ends_with(&suffix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{
        apply_claude_hook_module, build_claude_status, hook_exe_for_dir, install_claude_hooks,
        read_json, registered_exact_command, remove_claude_hook_module, uninstall_claude_hooks,
        write_json, ClaudeHookModule, CLAUDE_QUESTION_TOOL_NAME, CLAUDE_SETTINGS_FILE_NAME,
    };
    use serde_json::json;
    use tempfile::TempDir;

    const EXE: &str = "C:\\Tools\\CLI-Manager\\cli-manager.exe";

    // 通过真实模块函数安装，覆盖此前只在 broker 中注入事件而漏掉的前置链路。
    fn settings_for(modules: &[ClaudeHookModule], exe: &str) -> Value {
        let mut settings = json!({});
        for module in modules {
            apply_claude_hook_module(&mut settings, exe, *module);
        }
        settings
    }

    fn has_hook(settings: &Value, native_event: &str, event: &str) -> bool {
        registered_exact_command(settings, Some(EXE), native_event, "claude", event)
    }

    fn commands(settings: &Value, native_event: &str) -> Vec<String> {
        settings["hooks"][native_event].as_array().into_iter().flatten()
            .filter_map(|entry| entry["hooks"].as_array())
            .flatten()
            .filter_map(|hook| hook["command"].as_str().map(str::to_string))
            .collect()
    }

    // 只装问答时不得安装会触发子任务分屏/发现的普通工具结束事件。
    #[test]
    fn attention_alone_registers_private_completion_without_subagent_events() {
        let settings = settings_for(&[ClaudeHookModule::Attention], EXE);
        assert!(claude_completion_hooks_installed(&settings, Some(EXE)));
        assert!(!has_hook(&settings, "SubagentStart", "SubagentStart"));
        assert!(!has_hook(&settings, "PreToolUse", "ToolStart"));
        for event in COMPLETION_EVENTS {
            assert_eq!(commands(&settings, event).len(), 1);
            assert!(!has_hook(&settings, event, "ToolStop"));
            assert!(!has_hook(&settings, event, "AgentToolStop"));
        }
    }

    #[test]
    fn subagent_alone_keeps_its_original_lifecycle_hooks() {
        let settings = settings_for(&[ClaudeHookModule::Subagent], EXE);
        assert!(!claude_completion_hooks_installed(&settings, Some(EXE)));
        assert!(has_hook(&settings, "PostToolUse", "ToolStop"));
        assert!(has_hook(&settings, "PostToolUse", "AgentToolStop"));
    }

    #[test]
    fn installation_order_and_repetition_do_not_duplicate_private_hooks() {
        for modules in [
            [ClaudeHookModule::Attention, ClaudeHookModule::Subagent],
            [ClaudeHookModule::Subagent, ClaudeHookModule::Attention],
        ] {
            let mut settings = settings_for(&modules, EXE);
            for module in modules {
                apply_claude_hook_module(&mut settings, EXE, module);
            }
            for event in COMPLETION_EVENTS {
                assert_eq!(commands(&settings, event).iter().filter(|command| is_completion_command(command)).count(), 1);
            }
            assert_eq!(commands(&settings, "PostToolUse").len(), 3);
        }
    }

    // 卸载子任务不能整段移除 PreToolUse/PostToolUse，问答开始与完成均需保留。
    #[test]
    fn removing_subagent_preserves_attention_and_private_completion() {
        let mut settings = settings_for(&[ClaudeHookModule::Attention, ClaudeHookModule::Subagent], EXE);
        remove_claude_hook_module(&mut settings, ClaudeHookModule::Subagent);
        assert!(registered_exact_command_with_matcher(
            &settings, Some(EXE), "PreToolUse", "claude", "Notification", CLAUDE_QUESTION_TOOL_NAME,
        ));
        assert!(has_hook(&settings, "PermissionRequest", "PermissionRequest"));
        assert!(claude_completion_hooks_installed(&settings, Some(EXE)));
        assert!(!has_hook(&settings, "PreToolUse", "ToolStart"));
        assert!(!has_hook(&settings, "PostToolUse", "ToolStop"));
        assert!(!has_hook(&settings, "PostToolUse", "AgentToolStop"));
    }

    #[test]
    fn removing_attention_preserves_only_subagent_lifecycle() {
        let mut settings = settings_for(&[ClaudeHookModule::Attention, ClaudeHookModule::Subagent], EXE);
        remove_claude_hook_module(&mut settings, ClaudeHookModule::Attention);
        assert!(!has_hook(&settings, "PreToolUse", "Notification"));
        assert!(!has_hook(&settings, "PermissionRequest", "PermissionRequest"));
        assert!(!claude_completion_hooks_installed(&settings, Some(EXE)));
        assert!(has_hook(&settings, "PreToolUse", "ToolStart"));
        assert!(has_hook(&settings, "PostToolUse", "ToolStop"));
        assert!(has_hook(&settings, "PostToolUse", "AgentToolStop"));
    }

    #[test]
    fn removing_both_modules_removes_all_owned_completion_hooks() {
        for modules in [
            vec![ClaudeHookModule::Attention],
            vec![ClaudeHookModule::Subagent],
            vec![ClaudeHookModule::Attention, ClaudeHookModule::Subagent],
            vec![ClaudeHookModule::Subagent, ClaudeHookModule::Attention],
        ] {
            let mut settings = settings_for(&modules, EXE);
            for module in modules {
                remove_claude_hook_module(&mut settings, module);
            }
            for event in COMPLETION_EVENTS {
                assert!(commands(&settings, event).is_empty());
            }
        }
    }

    #[test]
    fn old_executable_and_posix_commands_are_removed_without_touching_other_hooks() {
        for exe in [EXE, "/mnt/c/Program Files/CLI-Manager/cli-manager.exe"] {
            let mut settings = settings_for(&[ClaudeHookModule::Attention, ClaudeHookModule::Subagent], exe);
            remove_claude_hook_module(&mut settings, ClaudeHookModule::Subagent);
            assert!(claude_completion_hooks_installed(&settings, Some(exe)));
            remove_claude_hook_module(&mut settings, ClaudeHookModule::Attention);
            for event in COMPLETION_EVENTS {
                assert!(commands(&settings, event).is_empty());
            }
        }
    }

    #[test]
    fn similar_commands_and_user_hooks_survive_reinstall_and_uninstall() {
        let mut settings = settings_for(&[ClaudeHookModule::Attention], EXE);
        settings["unrelated"] = json!({ "enabled": true });
        let similar_event = format!("{DESKTOP_PET_E_COMPLETION_EVENT}Extra");
        let foreign = [
            "foreign-handler".to_string(),
            build_command(EXE, "codex", DESKTOP_PET_E_COMPLETION_EVENT),
            build_command(EXE, "claude-other", DESKTOP_PET_E_COMPLETION_EVENT),
            build_command(EXE, "claude", &similar_event),
        ];
        for event in COMPLETION_EVENTS {
            for command in &foreign {
                add_hook_command_with_matcher(&mut settings, event, "Read", command.clone());
            }
        }
        apply_claude_hook_module(&mut settings, EXE, ClaudeHookModule::Attention);
        remove_claude_hook_module(&mut settings, ClaudeHookModule::Attention);
        assert_eq!(settings["unrelated"], json!({ "enabled": true }));
        for event in COMPLETION_EVENTS {
            assert_eq!(commands(&settings, event), foreign);
        }
    }

    #[test]
    fn reinstall_upgrades_missing_or_wrong_completion_matchers() {
        let mut settings = settings_for(&[ClaudeHookModule::Attention], EXE);
        settings["hooks"]["PostToolUse"][0]["matcher"] = json!("Read");
        settings["hooks"].as_object_mut().unwrap().remove("PostToolUseFailure");
        assert!(!claude_completion_hooks_installed(&settings, Some(EXE)));
        apply_claude_hook_module(&mut settings, EXE, ClaudeHookModule::Attention);
        assert!(claude_completion_hooks_installed(&settings, Some(EXE)));
        for event in COMPLETION_EVENTS {
            assert_eq!(commands(&settings, event).len(), 1);
        }
    }

    #[test]
    fn attention_health_requires_private_completion_hooks() {
        let tmp = TempDir::new().unwrap();
        let exe = hook_exe_for_dir(tmp.path()).unwrap();
        let mut settings = settings_for(&[ClaudeHookModule::Attention], &exe);
        let path = tmp.path().join(CLAUDE_SETTINGS_FILE_NAME);
        write_json(&path, &settings).unwrap();
        let status = build_claude_status(Some(tmp.path().to_path_buf())).unwrap();
        assert!(status.attention_hook_installed);
        assert!(!status.subagent_start_hook_installed);
        settings["hooks"].as_object_mut().unwrap().remove("PostToolUse");
        write_json(&path, &settings).unwrap();
        let status = build_claude_status(Some(tmp.path().to_path_buf())).unwrap();
        assert!(!status.attention_hook_installed);
    }

    #[test]
    fn full_uninstall_cleans_private_failure_completion() {
        let tmp = TempDir::new().unwrap();
        install_claude_hooks(tmp.path()).unwrap();
        let path = tmp.path().join(CLAUDE_SETTINGS_FILE_NAME);
        let installed = read_json(&path).unwrap();
        assert_eq!(commands(&installed, "PostToolUseFailure").len(), 1);
        uninstall_claude_hooks(tmp.path()).unwrap();
        let removed = read_json(&path).unwrap();
        assert!(commands(&removed, "PostToolUseFailure").is_empty());
    }
}
