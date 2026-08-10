use log::{debug, warn};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::third_party_notification::HookNotificationJob;

const REQUEST_PATH: &str = "/api/claude-hook";
const PI_DECISION_OPEN_PATH: &str = "/api/pi-decision/open";
const PI_DECISION_POLL_PATH: &str = "/api/pi-decision/poll";
const PI_DECISION_RESOLVE_PATH: &str = "/api/pi-decision/resolve";
const PI_DECISION_ACK_PATH: &str = "/api/pi-decision/ack";
const PI_DECISION_CANCEL_PATH: &str = "/api/pi-decision/cancel";
const PI_DECISION_APP_ACTIVATION_GRACE: Duration = Duration::from_secs(15);
const PI_DECISION_REBROADCAST_INTERVAL: Duration = Duration::from_secs(5);
const MAX_PENDING_PI_DECISIONS: usize = 128;
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const RECENT_HOOK_EVENT_LIMIT: usize = 1024;
const CLAUDE_QUESTION_TOOL_NAME: &str = "AskUserQuestion";
const CODEX_QUESTION_TOOL_NAME: &str = "request_user_input";

#[derive(Default)]
struct RecentHookEvents {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl RecentHookEvents {
    fn accept(&mut self, event_id: Option<&str>) -> bool {
        let Some(event_id) = event_id.map(str::trim).filter(|value| !value.is_empty()) else {
            return true;
        };
        if self.ids.contains(event_id) {
            return false;
        }
        let event_id = event_id.to_string();
        self.ids.insert(event_id.clone());
        self.order.push_back(event_id);
        while self.order.len() > RECENT_HOOK_EVENT_LIMIT {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiDecisionOption {
    value: String,
    label: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiDecisionQuestion {
    id: String,
    label: String,
    prompt: String,
    allow_other: bool,
    options: Vec<PiDecisionOption>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiDecisionOpenRequest {
    request_id: String,
    source_instance_id: String,
    tab_id: String,
    session_id: Option<String>,
    kind: String,
    title: String,
    message: Option<String>,
    questions: Vec<PiDecisionQuestion>,
    created_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiDecisionPayload {
    request_id: String,
    broker_epoch: String,
    source_instance_id: String,
    tab_id: String,
    session_id: Option<String>,
    kind: String,
    title: String,
    message: Option<String>,
    questions: Vec<PiDecisionQuestion>,
    created_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiDecisionAnswerItem {
    question_id: String,
    value: String,
    was_custom: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiDecisionAnswer {
    answers: Vec<PiDecisionAnswerItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiDecisionLookupRequest {
    request_id: String,
    broker_epoch: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiDecisionResolveRequest {
    request_id: String,
    broker_epoch: String,
    answer: PiDecisionAnswer,
}

struct PendingPiDecision {
    payload: PiDecisionPayload,
    answer: Option<PiDecisionAnswer>,
    opened_at: Instant,
    last_emitted_at: Instant,
    expires_at: Instant,
    consumer_seen: bool,
    consumer_generation: u64,
}

struct HookBridgeState {
    recent_events: Mutex<RecentHookEvents>,
    pending_pi_decisions: Mutex<HashMap<String, PendingPiDecision>>,
    pi_decision_events: Mutex<()>,
    broker_epoch: String,
}

impl HookBridgeState {
    fn new() -> Self {
        Self {
            recent_events: Mutex::new(RecentHookEvents::default()),
            pending_pi_decisions: Mutex::new(HashMap::new()),
            pi_decision_events: Mutex::new(()),
            broker_epoch: uuid::Uuid::new_v4().to_string(),
        }
    }
}

fn prune_expired_pi_decisions(
    pending: &mut HashMap<String, PendingPiDecision>,
) -> Vec<PiDecisionPayload> {
    let now = Instant::now();
    let expired_ids: Vec<String> = pending
        .iter()
        .filter(|(_, item)| item.expires_at <= now)
        .map(|(request_id, _)| request_id.clone())
        .collect();
    expired_ids
        .into_iter()
        .filter_map(|request_id| pending.remove(&request_id).map(|item| item.payload))
        .collect()
}

fn emit_pi_decision_closed(sink: &HookPayloadSink, payloads: Vec<PiDecisionPayload>) {
    for payload in payloads {
        sink(pi_decision_closed_hook_payload(payload));
    }
}

/// hook 上报的消费出口：主进程实现为 Tauri 事件，daemon 实现为帧广播 + 缓存
/// （Issue #123 Phase 2 复用点：HTTP 解析/校验逻辑两侧共享，只有出口不同）。
pub type HookPayloadSink = Arc<dyn Fn(ClaudeHookPayload) + Send + Sync + 'static>;
pub type HookConsumerProbe = Arc<dyn Fn() -> (bool, u64) + Send + Sync + 'static>;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeHookRequest {
    tab_id: String,
    source: Option<String>,
    event: String,
    title: Option<String>,
    message: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    // 仅 SubagentStart 等子 Agent 事件携带：用于定位子 Agent 转录 jsonl。
    agent_id: Option<String>,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    mcp_server: Option<String>,
    skill_name: Option<String>,
    agent_type: Option<String>,
    agent_transcript_path: Option<String>,
    transcript_path: Option<String>,
    reasoning_effort: Option<String>,
    wsl_distro_name: Option<String>,
    environment_type: Option<String>,
    remote_host_id: Option<String>,
    remote_project_id: Option<String>,
    remote_transcript_ref: Option<String>,
    remote_agent_transcript_ref: Option<String>,
    remote_event_id: Option<String>,
    remote_sequence: Option<u64>,
    heartbeat: Option<bool>,
    source_instance_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookPayload {
    tab_id: String,
    source: String,
    event: String,
    title: Option<String>,
    message: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    agent_id: Option<String>,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    mcp_server: Option<String>,
    skill_name: Option<String>,
    agent_type: Option<String>,
    agent_transcript_path: Option<String>,
    transcript_path: Option<String>,
    reasoning_effort: Option<String>,
    wsl_distro_name: Option<String>,
    environment_type: Option<String>,
    remote_host_id: Option<String>,
    remote_project_id: Option<String>,
    remote_project_name: Option<String>,
    remote_transcript_ref: Option<String>,
    remote_agent_transcript_ref: Option<String>,
    remote_event_id: Option<String>,
    remote_sequence: Option<u64>,
    heartbeat: Option<bool>,
    source_instance_id: Option<String>,
    pi_decision: Option<PiDecisionPayload>,
    pi_decision_closed_request_id: Option<String>,
}

pub(crate) fn pi_heartbeat_timeout_payload(
    tab_id: String,
    session_id: String,
    source_instance_id: String,
    last_heartbeat_at_ms: u64,
) -> ClaudeHookPayload {
    let timeout_at_ms = (chrono::Utc::now().timestamp_millis().max(0) as u64)
        .max(last_heartbeat_at_ms.saturating_add(1))
        .min(i64::MAX as u64);
    let timestamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timeout_at_ms as i64)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    ClaudeHookPayload {
        tab_id,
        source: "pi".to_string(),
        event: "StopFailure".to_string(),
        title: Some("Pi Agent interrupted".to_string()),
        message: Some("Pi heartbeat timed out".to_string()),
        session_id: Some(session_id),
        cwd: None,
        timestamp: Some(timestamp),
        agent_id: None,
        tool_use_id: None,
        tool_name: None,
        mcp_server: None,
        skill_name: None,
        agent_type: None,
        agent_transcript_path: None,
        transcript_path: None,
        reasoning_effort: None,
        wsl_distro_name: None,
        environment_type: None,
        remote_host_id: None,
        remote_project_id: None,
        remote_project_name: None,
        remote_transcript_ref: None,
        remote_agent_transcript_ref: None,
        remote_event_id: Some(format!(
            "pi-heartbeat:{source_instance_id}:{last_heartbeat_at_ms}"
        )),
        remote_sequence: None,
        heartbeat: None,
        source_instance_id: Some(source_instance_id),
        pi_decision: None,
        pi_decision_closed_request_id: None,
    }
}

impl ClaudeHookPayload {
    pub fn tab_id(&self) -> &str {
        &self.tab_id
    }

    pub fn requires_user_response(&self) -> bool {
        self.pi_decision.is_some()
            || self.event == "PermissionRequest"
            || (self.event == "Notification"
                && matches!(
                    (self.source.as_str(), self.tool_name.as_deref()),
                    ("claude", Some(CLAUDE_QUESTION_TOOL_NAME))
                        | ("codex", Some(CODEX_QUESTION_TOOL_NAME))
                ))
    }

    pub fn with_remote_project_name(mut self, project_name: String) -> Self {
        self.remote_project_name =
            (!project_name.trim().is_empty()).then(|| project_name.trim().to_string());
        self
    }

    pub fn is_heartbeat(&self) -> bool {
        self.heartbeat == Some(true)
    }

    pub fn is_pi_decision(&self) -> bool {
        self.pi_decision.is_some() || self.pi_decision_closed_request_id.is_some()
    }

    pub fn is_pi_decision_open(&self) -> bool {
        self.pi_decision.is_some()
    }

    pub fn to_notification_job(&self) -> HookNotificationJob {
        let is_ssh = self.environment_type.as_deref() == Some("ssh");
        HookNotificationJob {
            source: self.source.clone(),
            event: self.event.clone(),
            cwd: (!is_ssh).then(|| self.cwd.clone()).flatten(),
            project: is_ssh.then(|| self.remote_project_name.clone()).flatten(),
            timestamp: self.timestamp.clone(),
        }
    }
}

/// 在给定 listener 上运行 Hook HTTP 服务：解析、鉴权、校验后把 payload 交给 sink，
/// 并通过 consumer_probe 判断 Pi 决策前端是否仍可用。
pub fn spawn_hook_listener(
    listener: TcpListener,
    token: String,
    sink: HookPayloadSink,
    consumer_probe: HookConsumerProbe,
) {
    let state = Arc::new(HookBridgeState::new());
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let token = token.clone();
                    let sink = Arc::clone(&sink);
                    let state = Arc::clone(&state);
                    let consumer_probe = Arc::clone(&consumer_probe);
                    thread::spawn(move || {
                        handle_stream(stream, sink, &token, state, consumer_probe)
                    });
                }
                Err(err) => warn!("cli hook bridge accept failed: {}", err),
            }
        }
    });
}

fn handle_stream(
    mut stream: TcpStream,
    sink: HookPayloadSink,
    token: &str,
    state: Arc<HookBridgeState>,
    consumer_probe: HookConsumerProbe,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(status) => {
            write_response(&mut stream, status, "bad request");
            return;
        }
    };

    if request.method != "POST" || !is_supported_request_path(&request.path) {
        write_response(&mut stream, "404 Not Found", "not found");
        return;
    }

    let expected_auth = format!("Bearer {token}");
    if request
        .headers
        .get("authorization")
        .map(|value| value.as_str())
        != Some(expected_auth.as_str())
    {
        write_response(&mut stream, "401 Unauthorized", "unauthorized");
        return;
    }
    let content_type_is_json = request
        .headers
        .get("content-type")
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"));
    if !content_type_is_json {
        write_response(&mut stream, "415 Unsupported Media Type", "unsupported content type");
        return;
    }

    if request.path != REQUEST_PATH {
        handle_pi_decision_request(&mut stream, &request, sink, &state, &consumer_probe);
        return;
    }

    let payload = match serde_json::from_slice::<ClaudeHookRequest>(&request.body) {
        Ok(payload) => payload,
        Err(err) => {
            debug!("cli hook bridge payload parse failed: {}", err);
            write_response(&mut stream, "400 Bad Request", "invalid json");
            return;
        }
    };

    if !is_valid_payload(&payload) {
        write_response(&mut stream, "400 Bad Request", "invalid payload");
        return;
    }

    let accepted = state
        .recent_events
        .lock()
        .map(|mut recent| recent.accept(payload.remote_event_id.as_deref()))
        .unwrap_or(true);
    if !accepted {
        write_response(&mut stream, "204 No Content", "");
        return;
    }

    log_hook_payload_diagnostic(&payload);

    let payload = ClaudeHookPayload {
        tab_id: payload.tab_id,
        source: normalize_source(payload.source.as_deref()).to_string(),
        event: payload.event,
        title: payload.title,
        message: payload.message,
        session_id: payload.session_id,
        cwd: payload.cwd,
        timestamp: payload.timestamp,
        agent_id: payload.agent_id,
        tool_use_id: payload.tool_use_id,
        tool_name: payload.tool_name,
        mcp_server: payload.mcp_server,
        skill_name: payload.skill_name,
        agent_type: payload.agent_type,
        agent_transcript_path: payload.agent_transcript_path,
        transcript_path: payload.transcript_path,
        reasoning_effort: payload.reasoning_effort,
        wsl_distro_name: payload.wsl_distro_name,
        environment_type: payload.environment_type,
        remote_host_id: payload.remote_host_id,
        remote_project_id: payload.remote_project_id,
        remote_project_name: None,
        remote_transcript_ref: payload.remote_transcript_ref,
        remote_agent_transcript_ref: payload.remote_agent_transcript_ref,
        remote_event_id: payload.remote_event_id,
        remote_sequence: payload.remote_sequence,
        heartbeat: payload.heartbeat,
        source_instance_id: payload.source_instance_id,
        pi_decision: None,
        pi_decision_closed_request_id: None,
    };

    sink(payload);

    write_response(&mut stream, "204 No Content", "");
}

fn is_supported_request_path(path: &str) -> bool {
    matches!(
        path,
        REQUEST_PATH
            | PI_DECISION_OPEN_PATH
            | PI_DECISION_POLL_PATH
            | PI_DECISION_RESOLVE_PATH
            | PI_DECISION_ACK_PATH
            | PI_DECISION_CANCEL_PATH
    )
}

fn valid_identifier(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.len() <= max_len
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.'))
}

fn valid_decision_text(value: &str, max_len: usize, allow_empty: bool) -> bool {
    let value = value.trim();
    (allow_empty || !value.is_empty())
        && value.len() <= max_len
        && !value.contains('\0')
}

fn is_valid_pi_decision_open(request: &PiDecisionOpenRequest) -> bool {
    if !valid_identifier(&request.request_id, 128)
        || !valid_identifier(&request.source_instance_id, 128)
        || !valid_identifier(&request.tab_id, 128)
        || !request
            .session_id
            .as_deref()
            .is_some_and(|value| valid_identifier(value, 128))
        || !matches!(request.kind.as_str(), "question" | "questionnaire" | "permission")
        || !valid_decision_text(&request.title, 240, false)
        || request
            .message
            .as_deref()
            .is_some_and(|value| !valid_decision_text(value, 2_000, true))
        || request.created_at == 0
        || request.created_at > i64::MAX as u64
        || request.questions.is_empty()
        || request.questions.len() > 16
    {
        return false;
    }
    let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
    if request.created_at > now_ms.saturating_add(5 * 60 * 1_000)
        || now_ms.saturating_sub(request.created_at) > 24 * 60 * 60 * 1_000
        || (matches!(request.kind.as_str(), "question" | "permission")
            && request.questions.len() != 1)
    {
        return false;
    }

    let mut question_ids = HashSet::new();
    for question in &request.questions {
        if !valid_identifier(&question.id, 128)
            || !question_ids.insert(question.id.as_str())
            || !valid_decision_text(&question.label, 160, true)
            || !valid_decision_text(&question.prompt, 4_000, false)
            || question.options.is_empty()
            || question.options.len() > 32
        {
            return false;
        }
        let mut option_values = HashSet::new();
        for option in &question.options {
            if !valid_decision_text(&option.value, 512, false)
                || !option_values.insert(option.value.as_str())
                || !valid_decision_text(&option.label, 500, false)
                || option
                    .description
                    .as_deref()
                    .is_some_and(|value| !valid_decision_text(value, 1_000, true))
            {
                return false;
            }
        }
    }

    if request.kind == "permission" {
        let question = &request.questions[0];
        let values: HashSet<&str> = question.options.iter().map(|option| option.value.as_str()).collect();
        if question.allow_other || values != HashSet::from(["allow", "deny"]) {
            return false;
        }
    }
    true
}

fn is_valid_pi_decision_answer(
    payload: &PiDecisionPayload,
    answer: &PiDecisionAnswer,
) -> bool {
    if answer.answers.len() != payload.questions.len() {
        return false;
    }
    let mut answer_ids = HashSet::new();
    for item in &answer.answers {
        if !answer_ids.insert(item.question_id.as_str())
            || !valid_decision_text(&item.value, 4_000, false)
        {
            return false;
        }
        let Some(question) = payload
            .questions
            .iter()
            .find(|question| question.id == item.question_id)
        else {
            return false;
        };
        if item.was_custom {
            if !question.allow_other {
                return false;
            }
        } else if !question
            .options
            .iter()
            .any(|option| option.value == item.value)
        {
            return false;
        }
    }
    true
}

fn pi_decision_hook_payload(payload: PiDecisionPayload) -> ClaudeHookPayload {
    let permission = payload.kind == "permission";
    let message = payload
        .message
        .clone()
        .or_else(|| payload.questions.first().map(|question| question.prompt.clone()));
    ClaudeHookPayload {
        tab_id: payload.tab_id.clone(),
        source: "pi".to_string(),
        event: if permission { "PermissionRequest" } else { "Notification" }.to_string(),
        title: Some(payload.title.clone()),
        message,
        session_id: payload.session_id.clone(),
        cwd: None,
        timestamp: chrono::DateTime::<chrono::Utc>::from_timestamp_millis(payload.created_at as i64)
            .map(|value| value.to_rfc3339())
            .or_else(|| Some(chrono::Utc::now().to_rfc3339())),
        agent_id: None,
        tool_use_id: Some(payload.request_id.clone()),
        tool_name: Some(payload.kind.clone()),
        mcp_server: None,
        skill_name: None,
        agent_type: None,
        agent_transcript_path: None,
        transcript_path: None,
        reasoning_effort: None,
        wsl_distro_name: None,
        environment_type: None,
        remote_host_id: None,
        remote_project_id: None,
        remote_project_name: None,
        remote_transcript_ref: None,
        remote_agent_transcript_ref: None,
        remote_event_id: Some(payload.request_id.clone()),
        remote_sequence: None,
        heartbeat: None,
        source_instance_id: Some(payload.source_instance_id.clone()),
        pi_decision: Some(payload),
        pi_decision_closed_request_id: None,
    }
}

fn pi_decision_closed_hook_payload(payload: PiDecisionPayload) -> ClaudeHookPayload {
    let request_id = payload.request_id.clone();
    let mut hook_payload = pi_decision_hook_payload(payload);
    hook_payload.event = "Notification".to_string();
    hook_payload.title = None;
    hook_payload.message = None;
    hook_payload.timestamp = Some(chrono::Utc::now().to_rfc3339_opts(
        chrono::SecondsFormat::Millis,
        true,
    ));
    hook_payload.remote_event_id = Some(format!("pi-decision-closed:{request_id}"));
    hook_payload.pi_decision = None;
    hook_payload.pi_decision_closed_request_id = Some(request_id);
    hook_payload
}

fn parse_json_body<T: for<'de> Deserialize<'de>>(
    stream: &mut TcpStream,
    body: &[u8],
) -> Option<T> {
    match serde_json::from_slice(body) {
        Ok(value) => Some(value),
        Err(err) => {
            debug!("pi decision payload parse failed: {err}");
            write_response(stream, "400 Bad Request", "invalid json");
            None
        }
    }
}

fn handle_pi_decision_request(
    stream: &mut TcpStream,
    request: &HttpRequest,
    sink: HookPayloadSink,
    state: &Arc<HookBridgeState>,
    consumer_probe: &HookConsumerProbe,
) {
    let Ok(_event_guard) = state.pi_decision_events.lock() else {
        write_json_response(
            stream,
            "503 Service Unavailable",
            &serde_json::json!({ "status": "unavailable" }),
        );
        return;
    };
    match request.path.as_str() {
        PI_DECISION_OPEN_PATH => {
            let Some(open) = parse_json_body::<PiDecisionOpenRequest>(stream, &request.body) else {
                return;
            };
            if !is_valid_pi_decision_open(&open) {
                write_response(stream, "400 Bad Request", "invalid decision request");
                return;
            }
            let payload = PiDecisionPayload {
                request_id: open.request_id,
                broker_epoch: state.broker_epoch.clone(),
                source_instance_id: open.source_instance_id,
                tab_id: open.tab_id,
                session_id: open.session_id,
                kind: open.kind,
                title: open.title,
                message: open.message,
                questions: open.questions,
                created_at: open.created_at,
            };
            let mut should_emit = false;
            let mut expired_payloads = Vec::new();
            let (consumer_available, consumer_generation) = consumer_probe();
            let accepted = state.pending_pi_decisions.lock().map(|mut pending| {
                expired_payloads = prune_expired_pi_decisions(&mut pending);
                if let Some(existing) = pending.get(&payload.request_id) {
                    return existing.payload == payload;
                }
                if pending.len() >= MAX_PENDING_PI_DECISIONS {
                    return false;
                }
                pending.insert(
                    payload.request_id.clone(),
                    PendingPiDecision {
                        payload: payload.clone(),
                        answer: None,
                        opened_at: Instant::now(),
                        last_emitted_at: Instant::now(),
                        expires_at: Instant::now() + Duration::from_secs(24 * 60 * 60),
                        consumer_seen: consumer_available,
                        consumer_generation,
                    },
                );
                should_emit = true;
                true
            });
            emit_pi_decision_closed(&sink, expired_payloads);
            match accepted {
                Ok(true) => {}
                Ok(false) => {
                    write_json_response(
                        stream,
                        "409 Conflict",
                        &serde_json::json!({ "status": "rejected" }),
                    );
                    return;
                }
                Err(_) => {
                    write_json_response(
                        stream,
                        "503 Service Unavailable",
                        &serde_json::json!({ "status": "unavailable" }),
                    );
                    return;
                }
            }
            if should_emit {
                sink(pi_decision_hook_payload(payload.clone()));
            }
            write_json_response(
                stream,
                "200 OK",
                &serde_json::json!({
                    "status": "pending",
                    "brokerEpoch": state.broker_epoch.clone(),
                    "payload": payload,
                }),
            );
        }
        PI_DECISION_POLL_PATH => {
            let Some(lookup) = parse_json_body::<PiDecisionLookupRequest>(stream, &request.body) else {
                return;
            };
            let (consumer_available, consumer_generation) = consumer_probe();
            let mut replay_payload = None;
            let mut expired_payloads = Vec::new();
            let response = state.pending_pi_decisions.lock().ok().and_then(|mut pending| {
                expired_payloads = prune_expired_pi_decisions(&mut pending);
                if lookup.broker_epoch != state.broker_epoch {
                    return None;
                }
                let item = pending.get_mut(&lookup.request_id)?;
                if let Some(answer) = &item.answer {
                    return Some(serde_json::json!({ "status": "resolved", "answer": answer }));
                }
                if consumer_available {
                    if item.consumer_generation != consumer_generation
                        || item.last_emitted_at.elapsed() >= PI_DECISION_REBROADCAST_INTERVAL
                    {
                        replay_payload = Some(item.payload.clone());
                        item.last_emitted_at = Instant::now();
                    }
                    item.consumer_seen = true;
                    item.consumer_generation = consumer_generation;
                    return Some(serde_json::json!({ "status": "pending" }));
                }
                let unavailable = item.consumer_seen
                    || item.opened_at.elapsed() >= PI_DECISION_APP_ACTIVATION_GRACE;
                Some(if unavailable {
                    serde_json::json!({ "status": "unavailable" })
                } else {
                    serde_json::json!({ "status": "pending" })
                })
            });
            emit_pi_decision_closed(&sink, expired_payloads);
            if let Some(payload) = replay_payload {
                sink(pi_decision_hook_payload(payload));
            }
            match response {
                Some(response) => write_json_response(stream, "200 OK", &response),
                None => write_json_response(
                    stream,
                    "404 Not Found",
                    &serde_json::json!({ "status": "unavailable" }),
                ),
            }
        }
        PI_DECISION_RESOLVE_PATH => {
            let Some(resolve) = parse_json_body::<PiDecisionResolveRequest>(stream, &request.body) else {
                return;
            };
            let mut expired_payloads = Vec::new();
            let outcome = state.pending_pi_decisions.lock().ok().and_then(|mut pending| {
                expired_payloads = prune_expired_pi_decisions(&mut pending);
                if resolve.broker_epoch != state.broker_epoch {
                    return None;
                }
                let item = pending.get_mut(&resolve.request_id)?;
                if !is_valid_pi_decision_answer(&item.payload, &resolve.answer) {
                    return Some(Err("invalid answer"));
                }
                if let Some(existing) = &item.answer {
                    return Some(if existing == &resolve.answer {
                        Ok(())
                    } else {
                        Err("already resolved")
                    });
                }
                item.answer = Some(resolve.answer);
                Some(Ok(()))
            });
            emit_pi_decision_closed(&sink, expired_payloads);
            match outcome {
                Some(Ok(())) => write_json_response(
                    stream,
                    "200 OK",
                    &serde_json::json!({ "status": "accepted" }),
                ),
                Some(Err(reason)) => write_json_response(
                    stream,
                    "409 Conflict",
                    &serde_json::json!({ "status": "rejected", "reason": reason }),
                ),
                None => write_json_response(
                    stream,
                    "404 Not Found",
                    &serde_json::json!({ "status": "unavailable" }),
                ),
            }
        }
        PI_DECISION_ACK_PATH | PI_DECISION_CANCEL_PATH => {
            let Some(lookup) = parse_json_body::<PiDecisionLookupRequest>(stream, &request.body) else {
                return;
            };
            let mut expired_payloads = Vec::new();
            let removed = state.pending_pi_decisions.lock().ok().and_then(|mut pending| {
                expired_payloads = prune_expired_pi_decisions(&mut pending);
                if lookup.broker_epoch != state.broker_epoch {
                    return None;
                }
                let can_remove = pending
                    .get(&lookup.request_id)
                    .is_some_and(|item| request.path == PI_DECISION_CANCEL_PATH || item.answer.is_some());
                if can_remove {
                    pending.remove(&lookup.request_id)
                } else {
                    None
                }
            });
            emit_pi_decision_closed(&sink, expired_payloads);
            if let Some(removed) = removed {
                sink(pi_decision_closed_hook_payload(removed.payload));
                write_response(stream, "204 No Content", "");
            } else {
                write_json_response(
                    stream,
                    "404 Not Found",
                    &serde_json::json!({ "status": "unavailable" }),
                );
            }
        }
        _ => write_response(stream, "404 Not Found", "not found"),
    }
}

pub fn resolve_pi_decision(
    port: u16,
    token: &str,
    request_id: String,
    broker_epoch: String,
    answer: PiDecisionAnswer,
) -> Result<(), String> {
    if port == 0 || token.is_empty() {
        return Err("pi_decision_bridge_unavailable".to_string());
    }
    if !valid_identifier(&request_id, 128) || !valid_identifier(&broker_epoch, 128) {
        return Err("pi_decision_answer_invalid".to_string());
    }
    let body = serde_json::to_vec(&PiDecisionResolveRequest {
        request_id,
        broker_epoch,
        answer,
    })
    .map_err(|_| "pi_decision_answer_invalid".to_string())?;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| "pi_decision_bridge_unavailable".to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "POST {PI_DECISION_RESOLVE_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .and_then(|_| stream.flush())
        .map_err(|_| "pi_decision_bridge_unavailable".to_string())?;
    let mut response = Vec::new();
    stream
        .take(16 * 1024)
        .read_to_end(&mut response)
        .map_err(|_| "pi_decision_bridge_unavailable".to_string())?;
    let response_text = String::from_utf8_lossy(&response);
    let status_line = response_text
        .split("\r\n")
        .next()
        .unwrap_or_default();
    let mut status_parts = status_line.split_whitespace();
    if status_parts.next() != Some("HTTP/1.1") {
        return Err("pi_decision_bridge_unavailable".to_string());
    }
    match status_parts.next() {
        Some("200") => Ok(()),
        Some("404") => Err("pi_decision_request_expired".to_string()),
        Some("409") => Err("pi_decision_answer_rejected".to_string()),
        _ => Err("pi_decision_bridge_unavailable".to_string()),
    }
}

pub fn remote_hook_payload_from_spool(
    value: &serde_json::Value,
) -> Result<ClaudeHookPayload, String> {
    for key in [
        "tabId",
        "source",
        "event",
        "sessionId",
        "agentId",
        "toolUseId",
        "toolName",
        "mcpServer",
        "skillName",
        "agentType",
        "hostId",
        "projectId",
        "eventId",
    ] {
        if value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| text.len() > 256 || text.contains(['\0', '\r', '\n']))
        {
            return Err("remote_hook_payload_invalid".to_string());
        }
    }
    for key in ["remoteCwd", "remoteTranscriptRef", "agentTranscriptPath"] {
        if value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| text.len() > 4096 || text.contains(['\0', '\r', '\n']))
        {
            return Err("remote_hook_payload_invalid".to_string());
        }
    }
    let string = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let occurred_at = value
        .get("occurredAt")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default();
    let request = ClaudeHookRequest {
        tab_id: string("tabId").ok_or_else(|| "remote_hook_tab_missing".to_string())?,
        source: string("source"),
        event: string("event").ok_or_else(|| "remote_hook_event_missing".to_string())?,
        title: None,
        message: None,
        session_id: string("sessionId"),
        cwd: string("remoteCwd"),
        timestamp: chrono::DateTime::<chrono::Utc>::from_timestamp_millis(occurred_at as i64)
            .map(|value| value.to_rfc3339()),
        agent_id: string("agentId"),
        tool_use_id: string("toolUseId"),
        tool_name: string("toolName"),
        mcp_server: string("mcpServer"),
        skill_name: string("skillName"),
        agent_type: string("agentType"),
        agent_transcript_path: None,
        transcript_path: None,
        reasoning_effort: string("reasoningEffort"),
        wsl_distro_name: None,
        environment_type: Some("ssh".to_string()),
        remote_host_id: string("hostId"),
        remote_project_id: string("projectId"),
        remote_transcript_ref: string("remoteTranscriptRef"),
        remote_agent_transcript_ref: string("agentTranscriptPath"),
        remote_event_id: string("eventId"),
        remote_sequence: value.get("sequence").and_then(serde_json::Value::as_u64),
        heartbeat: None,
        source_instance_id: None,
    };
    if !is_valid_payload(&request) {
        return Err("remote_hook_payload_invalid".to_string());
    }
    Ok(ClaudeHookPayload {
        tab_id: request.tab_id,
        source: normalize_source(request.source.as_deref()).to_string(),
        event: request.event,
        title: request.title,
        message: request.message,
        session_id: request.session_id,
        cwd: request.cwd,
        timestamp: request.timestamp,
        agent_id: request.agent_id,
        tool_use_id: request.tool_use_id,
        tool_name: request.tool_name,
        mcp_server: request.mcp_server,
        skill_name: request.skill_name,
        agent_type: request.agent_type,
        agent_transcript_path: None,
        transcript_path: None,
        reasoning_effort: request.reasoning_effort,
        wsl_distro_name: None,
        environment_type: request.environment_type,
        remote_host_id: request.remote_host_id,
        remote_project_id: request.remote_project_id,
        remote_project_name: None,
        remote_transcript_ref: request.remote_transcript_ref,
        remote_agent_transcript_ref: request.remote_agent_transcript_ref,
        remote_event_id: request.remote_event_id,
        remote_sequence: request.remote_sequence,
        heartbeat: request.heartbeat,
        source_instance_id: request.source_instance_id,
        pi_decision: None,
        pi_decision_closed_request_id: None,
    })
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, &'static str> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let bytes_read = stream.read(&mut chunk).map_err(|_| "400 Bad Request")?;
        if bytes_read == 0 {
            return Err("400 Bad Request");
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);
        if buffer.len() > MAX_HEADER_BYTES + MAX_BODY_BYTES {
            return Err("413 Payload Too Large");
        }
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err("431 Request Header Fields Too Large");
        }
    };

    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or("400 Bad Request")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().ok_or("400 Bad Request")?.to_string();
    let path = request_parts.next().ok_or("400 Bad Request")?.to_string();
    if request_parts.next() != Some("HTTP/1.1") || request_parts.next().is_some() {
        return Err("400 Bad Request");
    }

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            if name.is_empty() || headers.contains_key(&name) {
                return Err("400 Bad Request");
            }
            headers.insert(name, value.trim().to_string());
        } else {
            return Err("400 Bad Request");
        }
    }

    let content_length = headers
        .get("content-length")
        .ok_or("411 Length Required")?
        .parse::<usize>()
        .map_err(|_| "400 Bad Request")?;
    if content_length > MAX_BODY_BYTES {
        return Err("413 Payload Too Large");
    }

    let body_start = header_end + 4;
    while buffer.len().saturating_sub(body_start) < content_length {
        let bytes_read = stream.read(&mut chunk).map_err(|_| "400 Bad Request")?;
        if bytes_read == 0 {
            return Err("400 Bad Request");
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);
        if buffer.len().saturating_sub(body_start) > MAX_BODY_BYTES {
            return Err("413 Payload Too Large");
        }
    }

    let body = buffer[body_start..body_start + content_length].to_vec();
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn is_valid_payload(payload: &ClaudeHookRequest) -> bool {
    let tab_id = payload.tab_id.trim();
    if tab_id.is_empty()
        || payload.tab_id != tab_id
        || tab_id.len() > 128
        || tab_id.contains(['\0', '\r', '\n'])
    {
        return false;
    }
    if payload
        .remote_event_id
        .as_deref()
        .is_some_and(|value| {
            value.trim().is_empty()
                || value.len() > 128
                || value.contains(['\0', '\r', '\n'])
        })
    {
        return false;
    }

    if payload
        .source_instance_id
        .as_deref()
        .is_some_and(|value| !valid_identifier(value, 128))
    {
        return false;
    }
    let source = normalize_source(payload.source.as_deref());
    if source == "pi"
        && !payload
            .source_instance_id
            .as_deref()
            .is_some_and(|value| valid_identifier(value, 128))
    {
        return false;
    }
    if payload.heartbeat == Some(true)
        && (source != "pi" || payload.event != "UserPromptSubmit")
    {
        return false;
    }

    for value in [
        payload.title.as_deref(),
        payload.message.as_deref(),
        payload.session_id.as_deref(),
        payload.cwd.as_deref(),
        payload.timestamp.as_deref(),
    ] {
        if value.is_some_and(|value| value.contains('\0')) {
            return false;
        }
    }
    if payload.title.as_deref().is_some_and(|value| value.len() > 240)
        || payload.message.as_deref().is_some_and(|value| value.len() > 4_000)
        || payload
            .session_id
            .as_deref()
            .is_some_and(|value| value.len() > 256 || value.contains(['\r', '\n']))
        || payload.cwd.as_deref().is_some_and(|value| value.len() > 4_096)
        || payload
            .timestamp
            .as_deref()
            .is_some_and(|value| value.len() > 128 || chrono::DateTime::parse_from_rfc3339(value).is_err())
    {
        return false;
    }

    if source == "pi" {
        let Some(timestamp) = payload
            .timestamp
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        else {
            return false;
        };
        let timestamp_ms = timestamp.timestamp_millis();
        let now_ms = chrono::Utc::now().timestamp_millis();
        if !payload
            .session_id
            .as_deref()
            .is_some_and(|value| valid_identifier(value, 128))
            || timestamp_ms > now_ms.saturating_add(5 * 60 * 1_000)
            || now_ms.saturating_sub(timestamp_ms) > 24 * 60 * 60 * 1_000
        {
            return false;
        }
    }

    match source {
        "claude" => matches!(
            payload.event.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "Notification"
                | "Stop"
                | "StopFailure"
                | "SubagentStart"
                | "SubagentStop"
                | "AgentToolStart"
                | "AgentToolStop"
                | "ToolStart"
                | "ToolStop"
        ),
        "grok" => matches!(
            payload.event.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "Notification"
                | "PermissionRequest"
                | "Stop"
                | "StopFailure"
                | "SubagentStart"
                | "SubagentStop"
                | "AgentToolStart"
                | "AgentToolStop"
                | "ToolStart"
                | "ToolStop"
        ),
        "codex" => matches!(
            payload.event.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "Notification"
                | "PermissionRequest"
                | "Stop"
                | "SubagentStart"
                | "SubagentStop"
        ),
        "pi" => matches!(
            payload.event.as_str(),
            "SessionStart" | "UserPromptSubmit" | "Stop" | "StopFailure"
        ),
        _ => false,
    }
}

fn log_hook_payload_diagnostic(payload: &ClaudeHookRequest) {
    if !matches!(
        payload.event.as_str(),
        "SubagentStart"
            | "SubagentStop"
            | "AgentToolStart"
            | "AgentToolStop"
            | "ToolStart"
            | "ToolStop"
            | "Notification"
    ) {
        return;
    }

    debug!(
        "cli hook payload diagnostic: source={} event={} tabId={} sessionId={:?} agentId={:?} toolUseId={:?} toolName={:?} mcpServer={:?} skillName={:?} agentType={:?} hasAgentTranscriptPath={} hasTranscriptPath={} wslDistro={:?} cwd={:?}",
        normalize_source(payload.source.as_deref()),
        payload.event,
        payload.tab_id,
        payload.session_id,
        payload.agent_id,
        payload.tool_use_id,
        payload.tool_name,
        payload.mcp_server,
        payload.skill_name,
        payload.agent_type,
        payload
            .agent_transcript_path
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        payload
            .transcript_path
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        payload.wsl_distro_name,
        payload.cwd,
    );

    // AgentTool 事件详细诊断：记录完整 payload JSON 以定位 Claude Code 实际字段。
    if matches!(payload.event.as_str(), "AgentToolStart" | "AgentToolStop") {
        if let Ok(full_json) = serde_json::to_string_pretty(payload) {
            debug!(
                "[agent_tool_diagnostic] {} full payload:\n{}",
                payload.event, full_json
            );
        }
    }
}

fn normalize_source(source: Option<&str>) -> &str {
    match source {
        Some("codex") => "codex",
        Some("pi") => "pi",
        Some("grok") => "grok",
        Some("claude") | None => "claude",
        _ => "",
    }
}

fn write_json_response<T: Serialize>(stream: &mut TcpStream, status: &str, body: &T) {
    let body = serde_json::to_string(body).unwrap_or_else(|_| "{\"status\":\"error\"}".to_string());
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[cfg(test)]
mod validation_tests {
    use super::{
        is_valid_payload, is_valid_pi_decision_answer, is_valid_pi_decision_open,
        normalize_source, pi_decision_closed_hook_payload, ClaudeHookRequest, PiDecisionAnswer,
        PiDecisionOpenRequest, PiDecisionPayload, RecentHookEvents, RECENT_HOOK_EVENT_LIMIT,
    };
    use serde_json::json;

    #[test]
    fn normalizes_and_accepts_grok_hook_events() {
        assert_eq!(normalize_source(Some("grok")), "grok");

        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "Notification",
            "PermissionRequest",
            "Stop",
            "StopFailure",
            "SubagentStart",
            "SubagentStop",
            "AgentToolStart",
            "AgentToolStop",
            "ToolStart",
            "ToolStop",
        ] {
            let request: ClaudeHookRequest = serde_json::from_value(json!({
                "tabId": "external:grok:session",
                "source": "grok",
                "event": event,
            }))
            .expect("test payload should deserialize");
            assert!(
                is_valid_payload(&request),
                "Grok event should be valid: {event}"
            );
        }
    }

    #[test]
    fn rejects_unknown_grok_hook_events() {
        let request: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "external:grok:session",
            "source": "grok",
            "event": "UnknownEvent",
        }))
        .expect("test payload should deserialize");

        assert!(!is_valid_payload(&request));
    }

    #[test]
    fn accepts_codex_question_notification_and_rejects_unknown_event() {
        let notification: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "external:codex:session",
            "source": "codex",
            "event": "Notification",
            "toolName": "request_user_input",
        }))
        .expect("test payload should deserialize");
        assert!(is_valid_payload(&notification));

        let unknown: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "external:codex:session",
            "source": "codex",
            "event": "UnknownEvent",
        }))
        .expect("test payload should deserialize");
        assert!(!is_valid_payload(&unknown));
    }

    #[test]
    fn deduplicates_bounded_hook_event_ids() {
        let mut recent = RecentHookEvents::default();
        assert!(recent.accept(Some("event-1")));
        assert!(!recent.accept(Some("event-1")));
        assert!(recent.accept(None));

        for index in 0..=RECENT_HOOK_EVENT_LIMIT {
            assert!(recent.accept(Some(&format!("event-{index}-next"))));
        }
        assert!(recent.accept(Some("event-1")));
    }

    fn pi_decision_request() -> PiDecisionOpenRequest {
        serde_json::from_value(json!({
            "requestId": "request-1",
            "sourceInstanceId": "pi-instance-1",
            "tabId": "tab-1",
            "sessionId": "pi-session-1",
            "kind": "permission",
            "title": "Permission required",
            "message": "Allow the operation?",
            "questions": [{
                "id": "permission",
                "label": "Permission",
                "prompt": "Allow the operation?",
                "allowOther": false,
                "options": [
                    { "value": "allow", "label": "Allow", "description": null },
                    { "value": "deny", "label": "Deny", "description": null }
                ]
            }],
            "createdAt": chrono::Utc::now().timestamp_millis()
        }))
        .expect("test decision should deserialize")
    }

    #[test]
    fn validates_permission_decisions_and_rejects_custom_permission_answers() {
        let request = pi_decision_request();
        assert!(is_valid_pi_decision_open(&request));
        let mut missing_session = request.clone();
        missing_session.session_id = None;
        assert!(!is_valid_pi_decision_open(&missing_session));
        let payload = PiDecisionPayload {
            request_id: request.request_id,
            broker_epoch: "epoch-1".to_string(),
            source_instance_id: request.source_instance_id,
            tab_id: request.tab_id,
            session_id: request.session_id,
            kind: request.kind,
            title: request.title,
            message: request.message,
            questions: request.questions,
            created_at: request.created_at,
        };
        let accepted: PiDecisionAnswer = serde_json::from_value(json!({
            "answers": [{
                "questionId": "permission",
                "value": "allow",
                "wasCustom": false
            }]
        }))
        .expect("test answer should deserialize");
        assert!(is_valid_pi_decision_answer(&payload, &accepted));

        let custom: PiDecisionAnswer = serde_json::from_value(json!({
            "answers": [{
                "questionId": "permission",
                "value": "always allow",
                "wasCustom": true
            }]
        }))
        .expect("test custom answer should deserialize");
        assert!(!is_valid_pi_decision_answer(&payload, &custom));
    }

    #[test]
    fn pi_decision_close_tombstone_keeps_only_request_identity() {
        let request = pi_decision_request();
        let payload = PiDecisionPayload {
            request_id: request.request_id,
            broker_epoch: "epoch-1".to_string(),
            source_instance_id: request.source_instance_id,
            tab_id: request.tab_id,
            session_id: request.session_id,
            kind: request.kind,
            title: request.title,
            message: request.message,
            questions: request.questions,
            created_at: request.created_at,
        };
        let closed = pi_decision_closed_hook_payload(payload);
        assert!(closed.is_pi_decision());
        assert!(!closed.is_pi_decision_open());
        let serialized = serde_json::to_value(closed).unwrap();
        assert_eq!(serialized["piDecisionClosedRequestId"], "request-1");
        assert!(serialized["piDecision"].is_null());
    }

    #[test]
    fn pi_heartbeat_is_scoped_to_running_events() {
        let timestamp = chrono::Utc::now().to_rfc3339();
        let valid: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "tab-1",
            "source": "pi",
            "event": "UserPromptSubmit",
            "sessionId": "pi-session-1",
            "timestamp": &timestamp,
            "heartbeat": true,
            "sourceInstanceId": "pi-instance-1"
        }))
        .expect("test heartbeat should deserialize");
        assert!(is_valid_payload(&valid));

        let invalid: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "tab-1",
            "source": "pi",
            "event": "Stop",
            "sessionId": "pi-session-1",
            "timestamp": &timestamp,
            "heartbeat": true,
            "sourceInstanceId": "pi-instance-1"
        }))
        .expect("test heartbeat should deserialize");
        assert!(!is_valid_payload(&invalid));

        let missing_identity: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "tab-1",
            "source": "pi",
            "event": "UserPromptSubmit",
            "heartbeat": true
        }))
        .expect("test missing-identity heartbeat should deserialize");
        assert!(!is_valid_payload(&missing_identity));

        for timestamp in [
            (chrono::Utc::now() - chrono::Duration::hours(25)).to_rfc3339(),
            (chrono::Utc::now() + chrono::Duration::minutes(6)).to_rfc3339(),
        ] {
            let out_of_range: ClaudeHookRequest = serde_json::from_value(json!({
                "tabId": "tab-1",
                "source": "pi",
                "event": "UserPromptSubmit",
                "sessionId": "pi-session-1",
                "timestamp": timestamp,
                "sourceInstanceId": "pi-instance-1"
            }))
            .expect("test out-of-range heartbeat should deserialize");
            assert!(!is_valid_payload(&out_of_range));
        }
    }

    #[test]
    fn rejects_invalid_hook_event_id() {
        let request: ClaudeHookRequest = serde_json::from_value(json!({
            "tabId": "tab",
            "source": "grok",
            "event": "SessionStart",
            "remoteEventId": ""
        }))
        .expect("test payload should deserialize");
        assert!(!is_valid_payload(&request));
    }
}

#[cfg(test)]
mod remote_tests {
    use super::remote_hook_payload_from_spool;
    use serde_json::json;

    fn remote_notification_job(source: &str) -> super::ClaudeHookPayload {
        let payload = remote_hook_payload_from_spool(&json!({
            "kind": "hookEvent",
            "eventId": "00000000-0000-4000-8000-000000000001",
            "sequence": 1,
            "hostId": "host",
            "projectId": "project",
            "tabId": "00000000-0000-4000-8000-000000000002",
            "source": source,
            "event": "Stop",
            "remoteCwd": "/srv/private-project",
            "occurredAt": 1
        }))
        .unwrap();
        payload
    }

    fn remote_question_notification(source: &str, tool_name: &str) -> super::ClaudeHookPayload {
        remote_hook_payload_from_spool(&json!({
            "kind": "hookEvent",
            "eventId": "00000000-0000-4000-8000-000000000001",
            "sequence": 1,
            "hostId": "host",
            "projectId": "project",
            "tabId": "00000000-0000-4000-8000-000000000002",
            "source": source,
            "event": "Notification",
            "toolName": tool_name,
            "remoteCwd": "/srv/private-project",
            "occurredAt": 1
        }))
        .unwrap()
    }

    #[test]
    fn question_notifications_require_user_response() {
        assert!(remote_question_notification("claude", "AskUserQuestion").requires_user_response());
        assert!(
            remote_question_notification("codex", "request_user_input").requires_user_response()
        );
        assert!(!remote_question_notification("codex", "Read").requires_user_response());
    }

    #[test]
    fn remote_claude_notification_omits_cwd_and_keeps_safe_project_label() {
        let payload = remote_notification_job("claude")
            .with_remote_project_name("Sidebar Project".to_string());
        let job = payload.to_notification_job();
        assert_eq!(job.cwd, None);
        assert_eq!(job.project.as_deref(), Some("Sidebar Project"));
    }

    #[test]
    fn remote_codex_notification_omits_cwd_and_keeps_safe_project_label() {
        let payload = remote_notification_job("codex")
            .with_remote_project_name("Sidebar Project".to_string());
        let job = payload.to_notification_job();
        assert_eq!(job.cwd, None);
        assert_eq!(job.project.as_deref(), Some("Sidebar Project"));
    }
}
