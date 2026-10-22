use serde_json::Value;

// 仅消费已通过 Hook 鉴权与接纳门的本机/WSL Pi 正式会话边界。
// 明确的 none 与没有上报不同，后台消费者不能将它当作仍在运行。
pub(super) fn reset_status(payload: &Value) -> Option<&'static str> {
    let identity = |key| {
        payload.get(key).and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    (payload.get("source").and_then(Value::as_str) == Some("pi")
        && payload.get("event").and_then(Value::as_str) == Some("SessionStart")
        && payload.get("environmentType").and_then(Value::as_str) != Some("ssh")
        && identity("tabId")
        && identity("sessionId"))
        .then_some("none")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn start() -> Value {
        json!({"source": "pi", "event": "SessionStart", "tabId": "tab", "sessionId": "new"})
    }

    #[test]
    fn pi_session_start_resets_local_and_wsl_to_explicit_idle() {
        for environment in [Value::Null, json!("local"), json!("wsl")] {
            let mut payload = start();
            payload["environmentType"] = environment;
            assert_eq!(reset_status(&payload), Some("none"));
        }
    }

    #[test]
    fn unrelated_events_and_missing_identity_do_not_reset() {
        for (key, value) in [
            ("source", json!("claude")), ("source", json!("codex")),
            ("environmentType", json!("ssh")), ("event", json!("UserPromptSubmit")),
            ("event", json!("StopFailure")), ("event", json!("DesktopPetEUiPrompt")),
            ("tabId", json!(" ")), ("sessionId", json!("")), ("sessionId", Value::Null),
        ] {
            let mut payload = start();
            payload[key] = value;
            assert_eq!(reset_status(&payload), None);
        }
    }
}
