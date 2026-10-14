use super::{normalize_source, ClaudeHookRequest};
use crate::desktop_pet_e_agent::DesktopPetEAgentBroker;
use serde_json::json;

pub(crate) const DESKTOP_PET_E_COMPLETION_EVENT: &str = "DesktopPetEComplete";

// 仅在 HTTP 鉴权、来源校验及去重之后调用；消费后必须停止向通知/子任务界面分发。
pub(super) fn consume(payload: &ClaudeHookRequest, broker: &DesktopPetEAgentBroker) -> bool {
    if payload.event != DESKTOP_PET_E_COMPLETION_EVENT
        || normalize_source(payload.source.as_deref()) != "claude"
    {
        return false;
    }
    // 只向 broker 提交既有的完成证据，不改变匹配规则，也不把内部事件广播给 UI。
    broker.observe_hook(&json!({
        "source": "claude",
        "event": "ToolStop",
        "tabId": payload.tab_id,
        "sessionId": payload.session_id,
        "toolUseId": payload.tool_use_id,
    }));
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::is_valid_payload;
    use cli_manager_hook_schema::normalize_hook_input;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};

    // 直接调用内存处理入口，不创建端口或运行任何 CLI。
    fn request(broker: &DesktopPetEAgentBroker, operation: &str, payload: Value) -> Value {
        let response = broker.handle_http(
            &format!("/api/desktop-pet-e-agent/{operation}"),
            &serde_json::to_vec(&payload).unwrap(),
        );
        assert_eq!(response.status, "200 OK", "{operation}: {:?}", response.body);
        serde_json::from_slice(&response.body).unwrap()
    }

    fn open_question(broker: &DesktopPetEAgentBroker) -> String {
        request(broker, "availability", json!({
            "instanceId": "frontend-1", "available": true, "acceptNew": true,
        }));
        let opened = request(broker, "open", json!({
            "source": "claude", "event": "PermissionRequest", "protocol": "claude-hook",
            "tabId": "tab-1", "agentSessionId": "agent-1", "toolUseId": "tool-1",
            "toolName": "AskUserQuestion", "requestId": "question-1",
            "hookInput": { "tool_input": { "questions": [{
                "question": "选择一个方案", "options": [{ "label": "A" }],
            }] } },
        }));
        assert_eq!(opened["status"], "pending");
        opened["pendingActionId"].as_str().unwrap().to_string()
    }

    fn poll(broker: &DesktopPetEAgentBroker, id: &str) -> Value {
        request(broker, "poll", json!({ "pendingActionId": id, "waitMs": 1 }))
    }

    fn completion(tab_id: &str, tool_use_id: Option<&str>) -> ClaudeHookRequest {
        serde_json::from_value(json!({
            "source": "claude", "event": DESKTOP_PET_E_COMPLETION_EVENT,
            "tabId": tab_id, "sessionId": "agent-1", "toolUseId": tool_use_id,
        })).unwrap()
    }

    #[test]
    fn private_completion_is_admitted_only_for_claude() {
        let broker = DesktopPetEAgentBroker::new();
        for source in ["claude", "codex", "pi", "grok", "kimi", "opencode", "unknown"] {
            let mut payload = completion("tab-1", Some("tool-1"));
            payload.source = Some(source.to_string());
            assert_eq!(is_valid_payload(&payload), source == "claude");
            assert_eq!(consume(&payload, &broker), source == "claude");
        }
        let mut invalid = completion("", Some("tool-1"));
        assert!(!is_valid_payload(&invalid));
        invalid.tab_id = "tab-1".to_string();
        invalid.remote_event_id = Some(String::new());
        assert!(!is_valid_payload(&invalid));
    }

    // 只有专用完成事件能进入此通道，开始/心跳和子任务事件都交回原分发路径。
    #[test]
    fn non_completion_events_are_not_consumed() {
        let broker = DesktopPetEAgentBroker::new();
        for event in ["ToolStart", "ToolStop", "AgentToolStop", "UserPromptSubmit", "Notification"] {
            let mut payload = completion("tab-1", Some("tool-1"));
            payload.event = event.to_string();
            assert!(!consume(&payload, &broker));
        }
    }

    // 专用事件不先转成普通 ToolStop，避免 Agent/Task 的输入在客户端归一化时被丢弃。
    #[test]
    fn private_completion_normalizes_question_agent_and_task_ids() {
        for tool in ["AskUserQuestion", "Bash", "Agent", "Task"] {
            let raw = json!({ "tool_name": tool, "tool_use_id": "tool-1" });
            let normalized = normalize_hook_input(DESKTOP_PET_E_COMPLETION_EVENT, &raw).unwrap();
            assert_eq!(normalized.tool_use_id.as_deref(), Some("tool-1"));
            assert_eq!(normalized.tool_name.as_deref(), Some(tool));
        }
    }

    // 清理经真实 broker 并验证其取消事件；重复完成不重复发布，也不放宽会话/工具匹配。
    #[test]
    fn private_completion_clears_only_the_matching_terminal_question() {
        let broker = DesktopPetEAgentBroker::new();
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = Arc::clone(&events);
        broker.set_event_sink(Arc::new(move |event| captured.lock().unwrap().push(event)));
        let id = open_question(&broker);
        for payload in [
            completion("tab-other", Some("tool-1")),
            completion("tab-1", Some("tool-other")),
            completion("tab-1", None),
        ] {
            assert!(consume(&payload, &broker));
            assert_eq!(poll(&broker, &id)["status"], "pending");
        }
        for event in ["ToolStart", "UserPromptSubmit"] {
            let mut payload = completion("tab-1", Some("tool-1"));
            payload.event = event.to_string();
            assert!(!consume(&payload, &broker));
            assert_eq!(poll(&broker, &id)["status"], "pending");
        }
        let payload = completion("tab-1", Some("tool-1"));
        assert!(consume(&payload, &broker));
        assert_eq!(poll(&broker, &id)["status"], "cancelled");
        assert!(consume(&payload, &broker));
        let events = events.lock().unwrap();
        let cancelled = events.iter().filter(|event| event["phase"] == "cancelled").collect::<Vec<_>>();
        assert_eq!(cancelled.len(), 1);
        assert_eq!(cancelled[0]["pendingActionId"], id);
    }

    #[test]
    fn private_completion_does_not_revoke_a_submitted_answer_before_ack() {
        let broker = DesktopPetEAgentBroker::new();
        let id = open_question(&broker);
        request(&broker, "submit", json!({
            "pendingActionId": id, "transportActionId": "response-1",
            "answers": [{ "questionId": "0", "values": ["A"] }],
        }));
        assert!(consume(&completion("tab-1", Some("tool-1")), &broker));
        assert_eq!(poll(&broker, &id)["status"], "resolved");
        let acknowledged = request(&broker, "ack", json!({
            "pendingActionId": id, "transportActionId": "response-1", "success": true,
        }));
        assert_eq!(acknowledged["status"], "accepted");
    }
}
