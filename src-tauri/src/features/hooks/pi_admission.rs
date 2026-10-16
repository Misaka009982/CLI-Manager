use super::ClaudeHookRequest;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const MAX_TABS: usize = 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PiHookIdentity {
    instance_id: String,
    instance_started_at: u64,
    sequence: u64,
    run_id: u64,
}

impl PiHookIdentity {
    // 有界身份与单调序号是桥接协议，不从提示词或路径推断运行归属。
    pub(super) fn valid(&self) -> bool {
        !self.instance_id.trim().is_empty()
            && self.instance_id.len() <= 64
            && self.instance_started_at > 0
            && self.sequence > 0
            && self.run_id > 0
    }
}

struct AcceptedRun {
    identity: PiHookIdentity,
    session_id: String,
    ended: bool,
    timestamp: i64,
}

#[derive(Default)]
pub(super) struct PiHookAdmission {
    tabs: HashMap<String, AcceptedRun>,
}

impl PiHookAdmission {
    // 必须在所有 sink 副作用之前、同一锁内调用；旧无身份客户端只在未被新版接管时兼容。
    pub(super) fn accept(&mut self, request: &ClaudeHookRequest) -> bool {
        if request.source.as_deref() != Some("pi") {
            return true;
        }
        let Some(identity) = request.pi.as_ref() else {
            return !self.tabs.contains_key(&request.tab_id);
        };
        let Some(session_id) = request
            .session_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
        else {
            return false;
        };
        let Some(timestamp) = request
            .timestamp
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.timestamp_millis())
        else {
            return false;
        };
        let ended = matches!(request.event.as_str(), "Stop" | "StopFailure" | "Interrupt");
        if let Some(previous) = self.tabs.get(&request.tab_id) {
            let same_instance = identity.instance_id == previous.identity.instance_id;
            if same_instance {
                if identity.instance_started_at != previous.identity.instance_started_at
                    || identity.sequence <= previous.identity.sequence
                    || identity.run_id < previous.identity.run_id
                {
                    return false;
                }
                if identity.run_id == previous.identity.run_id
                    && (previous.ended || session_id != previous.session_id)
                {
                    return false;
                }
            } else if identity.instance_started_at <= previous.identity.instance_started_at
                || timestamp < previous.timestamp
            {
                return false;
            }
        }
        if self.tabs.len() >= MAX_TABS && !self.tabs.contains_key(&request.tab_id) {
            if let Some(oldest) = self
                .tabs
                .iter()
                .min_by_key(|(_, value)| value.timestamp)
                .map(|(key, _)| key.clone())
            {
                self.tabs.remove(&oldest);
            }
        }
        self.tabs.insert(
            request.tab_id.clone(),
            AcceptedRun {
                identity: identity.clone(),
                session_id: session_id.to_string(),
                ended,
                timestamp,
            },
        );
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 真实 serde 入口构造协议载荷，缺失可选字段保持旧客户端兼容。
    fn request(instance: &str, sequence: u64, run_id: u64, event: &str) -> ClaudeHookRequest {
        serde_json::from_value(json!({
            "tabId": "tab", "source": "pi", "event": event, "sessionId": "parent",
            "timestamp": "2026-10-15T01:00:00Z",
            "pi": {"instanceId": instance, "instanceStartedAt": 100, "sequence": sequence, "runId": run_id}
        })).unwrap()
    }

    #[test]
    fn rejects_repeated_ends_and_old_runs_but_allows_next_run() {
        let mut gate = PiHookAdmission::default();
        assert!(gate.accept(&request("root", 1, 1, "UserPromptSubmit")));
        assert!(gate.accept(&request("root", 2, 1, "Stop")));
        assert!(!gate.accept(&request("root", 3, 1, "Stop")));
        assert!(gate.accept(&request("root", 4, 2, "UserPromptSubmit")));
        assert!(!gate.accept(&request("root", 5, 1, "Stop")));
        assert!(gate.accept(&request("root", 6, 2, "Interrupt")));
    }

    #[test]
    fn rejects_reordered_delivery_and_session_rebinding_within_run() {
        let mut gate = PiHookAdmission::default();
        assert!(gate.accept(&request("root", 2, 1, "UserPromptSubmit")));
        assert!(!gate.accept(&request("root", 1, 1, "SessionStart")));
        let mut child = request("root", 3, 1, "Stop");
        child.session_id = Some("child".into());
        assert!(!gate.accept(&child));
        child.pi.as_mut().unwrap().run_id = 2;
        child.event = "SessionStart".into();
        assert!(gate.accept(&child));
    }

    #[test]
    fn retired_instances_cannot_take_over_new_root() {
        let mut gate = PiHookAdmission::default();
        assert!(gate.accept(&request("root", 1, 1, "SessionStart")));
        let mut replacement = request("replacement", 1, 1, "Stop");
        replacement.pi.as_mut().unwrap().instance_started_at = 101;
        assert!(gate.accept(&replacement)); // stop-only installation / new root
        assert!(!gate.accept(&request("root", 99, 99, "Stop")));
        let mut legacy = request("root", 1, 1, "Stop");
        legacy.pi = None;
        assert!(!gate.accept(&legacy));
        legacy.tab_id = "legacy-tab".into();
        assert!(gate.accept(&legacy));
        legacy.source = Some("claude".into());
        legacy.tab_id = "tab".into();
        assert!(gate.accept(&legacy));
    }

    #[test]
    fn cancellation_and_failure_close_only_their_own_run() {
        let mut gate = PiHookAdmission::default();
        assert!(gate.accept(&request("root", 1, 1, "StopFailure")));
        assert!(!gate.accept(&request("root", 2, 1, "Stop")));
        assert!(gate.accept(&request("root", 3, 2, "Stop")));
    }

    #[test]
    fn http_rejection_happens_before_every_delivery_side_effect() {
        use super::super::{
            handle_stream, ClaudeHookPayload, HookPayloadSink, RecentHookEvents,
        };
        use crate::desktop_pet_e_agent::DesktopPetEAgentBroker;
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::{Arc, Mutex};

        let broker = DesktopPetEAgentBroker::new();
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&delivered);
        let sink: HookPayloadSink = Arc::new(move |payload: ClaudeHookPayload| {
            output
                .lock()
                .unwrap()
                .push((payload.event, payload.session_id));
        });
        let recent = Arc::new(Mutex::new(RecentHookEvents::default()));
        let mut attempts = vec![
            request("root", 1, 1, "UserPromptSubmit"),
            request("root", 3, 2, "UserPromptSubmit"),
            request("root", 2, 1, "Stop"), // 旧 Stop 晚于新 running
            request("root", 4, 2, "StopFailure"),
            request("root", 5, 2, "Stop"), // 同一代际换 ID 再投也不能报成功
            request("root", 6, 3, "Interrupt"),
        ];
        let mut invalid = request("root", 7, 4, "Stop");
        invalid.pi.as_mut().unwrap().sequence = 0;
        attempts.push(invalid);
        for (index, payload) in attempts.into_iter().enumerate() {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (stream, _) = listener.accept().unwrap();
            let sink = Arc::clone(&sink);
            let recent = Arc::clone(&recent);
            let broker = broker.clone();
            let worker =
                std::thread::spawn(move || handle_stream(stream, sink, "test", recent, broker));
            let body = serde_json::to_string(&payload).unwrap();
            write!(client, "POST /api/claude-hook HTTP/1.1\r\nAuthorization: Bearer test\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            worker.join().unwrap();
            assert!(response.contains(if index == 6 {
                "400 Bad Request"
            } else {
                "204 No Content"
            }));
        }
        let actual = delivered.lock().unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|(event, _)| event.as_str())
                .collect::<Vec<_>>(),
            [
                "UserPromptSubmit",
                "UserPromptSubmit",
                "StopFailure",
                "Interrupt"
            ]
        );
        assert!(actual
            .iter()
            .all(|(_, session)| session.as_deref() == Some("parent")));
    }
}
