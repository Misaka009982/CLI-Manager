use super::{normalize_source, ClaudeHookPayload, ClaudeHookRequest, HookPayloadSink};
use serde::{Deserialize, Serialize};

pub(crate) const DESKTOP_PET_E_UI_PROMPT_EVENT: &str = "DesktopPetEUiPrompt";
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DesktopPetEUiPrompt {
    instance_id: String,
    id: String,
    sequence: u64,
    active: bool,
    kind: String,
    title: Option<String>,
}

// 只读状态只经过广播出口，不参与审批、任务状态、通知或远程 handoff。
impl ClaudeHookPayload {
    fn is_desktop_pet_e_ui_prompt(&self) -> bool {
        self.source == "pi" && self.event == DESKTOP_PET_E_UI_PROMPT_EVENT
    }

    // 上游 daemon 只提供广播回调；序列化、失败消费与日志都由外挂维护。
    pub fn dispatch_desktop_pet_e_ui_prompt(&self, emit: impl FnOnce(serde_json::Value)) -> bool {
        if !self.is_desktop_pet_e_ui_prompt() {
            return false;
        }
        match serde_json::to_value(self) {
            Ok(value) => emit(value),
            Err(err) => log::warn!("daemon Pi prompt serialize failed: {err}"),
        }
        true
    }
}

// 专用状态不触发审批仲裁的轮询；普通事件原样交回上游回调。
pub(super) fn route(
    payload: ClaudeHookPayload,
    delivery: &HookPayloadSink,
    ordinary: impl FnOnce(ClaudeHookPayload),
) {
    if payload.is_desktop_pet_e_ui_prompt() {
        delivery(payload);
    } else {
        ordinary(payload);
    }
}

// 身份不作截断或模糊匹配，拒绝空白、控制字符和过长标识。
fn valid_identity(value: Option<&str>, max_length: usize) -> bool {
    value.is_some_and(|text| {
        !text.is_empty()
            && text == text.trim()
            && text.len() <= max_length
            && !text.chars().any(char::is_control)
    })
}

// 普通事件不能夹带等待状态；专用事件仅接受本地/WSL Pi 的完整区间身份。
pub(super) fn is_valid(payload: &ClaudeHookRequest) -> bool {
    if payload.event != DESKTOP_PET_E_UI_PROMPT_EVENT {
        return payload.terminal_prompt.is_none();
    }
    let Some(prompt) = &payload.terminal_prompt else {
        return false;
    };
    normalize_source(payload.source.as_deref()) == "pi"
        && valid_identity(Some(&payload.tab_id), 128)
        && valid_identity(payload.session_id.as_deref(), 256)
        && valid_identity(payload.remote_event_id.as_deref(), 128)
        && valid_identity(Some(&prompt.instance_id), 128)
        && valid_identity(Some(&prompt.id), 128)
        && (1..=MAX_SAFE_SEQUENCE).contains(&prompt.sequence)
        && matches!(prompt.kind.as_str(), "select" | "confirm" | "input" | "editor" | "custom")
        && prompt.title.as_deref().is_none_or(|title| {
            title.chars().count() <= 512 && !title.chars().any(char::is_control)
        })
        && payload.timestamp.as_deref().is_some_and(|timestamp| {
            timestamp.len() <= 64 && chrono::DateTime::parse_from_rfc3339(timestamp).is_ok()
        })
        && matches!(payload.environment_type.as_deref(), None | Some("local" | "wsl"))
        && payload.remote_host_id.is_none()
        && payload.remote_project_id.is_none()
        && payload.remote_transcript_ref.is_none()
        && payload.remote_agent_transcript_ref.is_none()
        && payload.remote_sequence.is_none()
        && payload.hook_input.is_none()
        && payload.agent_id.is_none()
        && payload.tool_use_id.is_none()
        && payload.tool_name.is_none()
        && payload.goal_id.is_none()
        && payload.goal_status.is_none()
        && payload.title.is_none()
        && payload.message.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{is_valid_payload, remote_hook_payload_from_spool};
    use serde_json::{json, Value};
    use std::cell::Cell;
    use std::sync::{Arc, Mutex};

    // 构造专用事件，时间格式与 Pi 生产者一致，不启动 HTTP 服务。
    fn wire() -> Value {
        json!({
            "tabId": "tab-1", "source": "pi", "event": DESKTOP_PET_E_UI_PROMPT_EVENT,
            "sessionId": "pi-1", "timestamp": "2026-10-15T00:00:00.000Z",
            "remoteEventId": "event-1",
            "terminalPrompt": {
                "instanceId": "instance-1", "id": "prompt-1", "sequence": 1,
                "active": true, "kind": "custom", "title": "选择方案",
            },
        })
    }

    // 解析失败和语义校验失败均视为拒绝，覆盖实际 HTTP 入口的两道守卫。
    fn admitted(value: Value) -> bool {
        serde_json::from_value::<ClaudeHookRequest>(value)
            .is_ok_and(|payload| is_valid_payload(&payload))
    }

    #[test]
    fn ui_prompt_accepts_pi_kinds_start_end_and_wsl() {
        for kind in ["select", "confirm", "input", "editor", "custom"] {
            for active in [true, false] {
                let mut value = wire();
                value["terminalPrompt"]["kind"] = json!(kind);
                value["terminalPrompt"]["active"] = json!(active);
                value["wslDistroName"] = json!("Ubuntu");
                assert!(admitted(value));
            }
        }
        let mut value = wire();
        value["terminalPrompt"]["sequence"] = json!(MAX_SAFE_SEQUENCE);
        value["terminalPrompt"]["title"] = json!("问".repeat(512));
        assert!(admitted(value));
    }

    #[test]
    fn ui_prompt_rejects_foreign_sources_and_missing_identity() {
        for source in ["claude", "codex", "grok", "kimi", "opencode", "unknown", ""] {
            let mut value = wire();
            value["source"] = json!(source);
            assert!(!admitted(value), "{source}");
        }
        for field in ["source", "tabId", "sessionId", "timestamp", "remoteEventId", "terminalPrompt"] {
            let mut value = wire();
            value.as_object_mut().unwrap().remove(field);
            assert!(!admitted(value), "{field}");
        }
        for field in ["tabId", "sessionId", "remoteEventId"] {
            for invalid in ["", " ", "id\n", " id", "id\0"] {
                let mut value = wire();
                value[field] = json!(invalid);
                assert!(!admitted(value), "{field}");
            }
        }
    }

    #[test]
    fn ui_prompt_rejects_malformed_or_unbounded_intervals() {
        for (field, invalid) in [
            ("instanceId", json!("")), ("id", json!("x".repeat(129))),
            ("sequence", json!(0)), ("sequence", json!(-1)), ("sequence", json!(1.5)),
            ("sequence", json!(MAX_SAFE_SEQUENCE + 1)), ("active", json!("true")),
            ("kind", json!("unknown")), ("title", json!("问".repeat(513))),
            ("title", json!("line\nline")), ("unexpected", json!(true)),
        ] {
            let mut value = wire();
            value["terminalPrompt"][field] = invalid;
            assert!(!admitted(value), "{field}");
        }
        let mut value = wire();
        value["timestamp"] = json!("not-a-time");
        assert!(!admitted(value));
    }

    #[test]
    fn ui_prompt_plugin_consumes_private_events_and_preserves_ordinary_delivery() {
        let mut value = wire();
        let report = value["terminalPrompt"].clone();
        value["event"] = json!("SessionStart");
        value.as_object_mut().unwrap().remove("terminalPrompt");
        // 复用普通载荷构造器，测试不复制上游的全部字段列表。
        let mut payload = remote_hook_payload_from_spool(&value).unwrap();
        payload.event = DESKTOP_PET_E_UI_PROMPT_EVENT.to_string();
        payload.environment_type = None;
        payload.timestamp = value["timestamp"].as_str().map(str::to_string);
        payload.remote_event_id = Some("event-1".to_string());
        payload.terminal_prompt = Some(serde_json::from_value(report.clone()).unwrap());
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = Arc::clone(&events);
        let delivery: HookPayloadSink = Arc::new(move |payload| {
            assert!(payload.dispatch_desktop_pet_e_ui_prompt(|value| {
                captured.lock().unwrap().push(value);
            }));
        });
        route(payload, &delivery, |_| panic!("私有事件不得进入普通仲裁"));
        {
            let events = events.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["event"], DESKTOP_PET_E_UI_PROMPT_EVENT);
            assert_eq!(events[0]["terminalPrompt"], report);
        }
        let ordinary = remote_hook_payload_from_spool(&value).unwrap();
        assert!(!ordinary.dispatch_desktop_pet_e_ui_prompt(|_| panic!("普通事件不得进入专用广播")));
        let called = Cell::new(false);
        route(ordinary, &delivery, |_| called.set(true));
        assert!(called.get());
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[test]
    fn ui_prompt_cannot_impersonate_ssh_or_a_decision() {
        for (field, invalid) in [
            ("environmentType", json!("ssh")), ("remoteHostId", json!("host")),
            ("remoteProjectId", json!("project")), ("remoteSequence", json!(1)),
            ("hookInput", json!({})), ("toolName", json!("question")),
            ("agentId", json!("agent")), ("message", json!("notification")),
        ] {
            let mut value = wire();
            value[field] = invalid;
            assert!(!admitted(value), "{field}");
        }
        assert!(remote_hook_payload_from_spool(&wire()).is_err());
        for event in ["Notification", "UserPromptSubmit", "Stop", "SessionStart"] {
            let mut value = wire();
            value["event"] = json!(event);
            assert!(!admitted(value.clone()), "{event}");
            assert!(remote_hook_payload_from_spool(&value).is_err(), "{event}");
            value.as_object_mut().unwrap().remove("terminalPrompt");
            let ordinary = remote_hook_payload_from_spool(&value).unwrap();
            assert!(!ordinary.is_desktop_pet_e_ui_prompt());
            assert!(serde_json::to_value(ordinary).unwrap().get("terminalPrompt").is_none());
            assert!(admitted(value), "{event}");
        }
    }
}
