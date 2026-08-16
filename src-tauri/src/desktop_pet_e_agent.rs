use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const DESKTOP_PET_E_AGENT_EVENT: &str = "desktop-pet-e-agent";
pub const DESKTOP_PET_E_AGENT_MARKER: &str = "desktopPetEAgent";
pub const DESKTOP_PET_E_AGENT_PATH_PREFIX: &str = "/api/desktop-pet-e-agent/";
pub const DESKTOP_PET_E_AGENT_MAX_BODY_BYTES: usize = 1024 * 1024;

const AVAILABILITY_LEASE: Duration = Duration::from_secs(15);
const PENDING_ACTION_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING_ACTIONS: usize = 128;
const MAX_COMPLETED_ACTIONS: usize = 1024;
const PI_DECISION_BROKER_EPOCH: &str = "desktop-pet-e-v1";
const MAX_ID_LENGTH: usize = 512;
const MAX_ACTION_ID_LENGTH: usize = 160;
const MAX_QUESTIONS: usize = 32;
const MAX_OPTIONS: usize = 64;
const MAX_ANSWER_VALUES: usize = 64;
const MAX_TEXT_LENGTH: usize = 16_384;
const MAX_HTTP_RESPONSE_BYTES: usize = 1024 * 1024;

pub type DesktopPetEAgentEventSink = Arc<dyn Fn(Value) + Send + Sync + 'static>;

#[derive(Clone, Default)]
pub struct DesktopPetEAgentBroker {
    shared: Arc<(Mutex<BrokerState>, Condvar)>,
    event_sink: Arc<Mutex<Option<DesktopPetEAgentEventSink>>>,
}

#[derive(Default)]
struct BrokerState {
    available_instances: HashMap<String, AvailabilityLease>,
    pending: HashMap<String, PendingEntry>,
    request_keys: HashMap<String, String>,
    completed: HashMap<String, CompletedEntry>,
    completed_order: VecDeque<String>,
    pi_requests: HashMap<String, String>,
    next_generation: u64,
}

#[derive(Clone, Copy)]
struct AvailabilityLease {
    updated_at: Instant,
    accept_new: bool,
}

#[derive(Clone)]
struct CompletedEntry {
    pending_action_id: String,
    response: Value,
    transport_action_id: String,
    completed_at: Instant,
}

#[derive(Clone)]
struct PendingEntry {
    request_key: String,
    pending_action_id: String,
    session_id: String,
    source: String,
    protocol: String,
    method: Option<String>,
    request_id: Option<Value>,
    hook_input: Value,
    action: Value,
    state: PendingState,
    created_at: Instant,
    expires_at: Instant,
}

#[derive(Clone)]
enum PendingState {
    Waiting,
    Submitted {
        transport_action_id: String,
        response: Value,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AvailabilityRequest {
    instance_id: String,
    available: bool,
    #[serde(default = "default_accept_new")]
    accept_new: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenRequest {
    source: String,
    event: String,
    protocol: String,
    tab_id: String,
    #[serde(default)]
    agent_session_id: Option<String>,
    #[serde(default)]
    tool_use_id: Option<String>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    request_id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    hook_input: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PollRequest {
    pending_action_id: String,
    #[serde(default)]
    wait_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetEAgentAnswer {
    pub question_id: String,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub custom_value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitRequest {
    pending_action_id: String,
    transport_action_id: String,
    #[serde(default)]
    answers: Vec<DesktopPetEAgentAnswer>,
    #[serde(default)]
    approval_value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AckRequest {
    pending_action_id: String,
    #[serde(default)]
    transport_action_id: Option<String>,
    success: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelRequest {
    pending_action_id: String,
    #[serde(default)]
    reason: Option<String>,
}

pub struct DesktopPetEAgentHttpResponse {
    pub status: &'static str,
    pub body: Vec<u8>,
}

struct ActionBlueprint {
    kind: &'static str,
    title: Option<String>,
    message: Option<String>,
    questions: Vec<Value>,
    approval_choices: Vec<Value>,
    interactive_supported: bool,
    adapter_reason: Option<&'static str>,
}

impl DesktopPetEAgentBroker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_event_sink(&self, sink: DesktopPetEAgentEventSink) {
        if let Ok(mut current) = self.event_sink.lock() {
            *current = Some(sink);
        }
    }

    pub fn is_agent_path(path: &str) -> bool {
        path.starts_with(DESKTOP_PET_E_AGENT_PATH_PREFIX)
            || path.starts_with("/api/pi-decision/")
    }

    pub fn handle_http(&self, path: &str, body: &[u8]) -> DesktopPetEAgentHttpResponse {
        if body.len() > DESKTOP_PET_E_AGENT_MAX_BODY_BYTES {
            return error_response("413 Payload Too Large", "desktop_pet_e_agent_body_too_large");
        }
        if path.starts_with("/api/pi-decision/") {
            return self.handle_pi_http(path, body);
        }
        match path {
            "/api/desktop-pet-e-agent/availability" => {
                let request = match serde_json::from_slice::<AvailabilityRequest>(body) {
                    Ok(request) => request,
                    Err(_) => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
                };
                match self.set_available(request) {
                    Ok(()) => json_response("200 OK", json!({ "status": "accepted" })),
                    Err(error) => error_response("400 Bad Request", &error),
                }
            }
            "/api/desktop-pet-e-agent/open" => {
                let request = match serde_json::from_slice::<OpenRequest>(body) {
                    Ok(request) => request,
                    Err(_) => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
                };
                match self.open(request) {
                    Ok(response) => json_response("200 OK", response),
                    Err(error) => error_response("400 Bad Request", &error),
                }
            }
            "/api/desktop-pet-e-agent/poll" => {
                let request = match serde_json::from_slice::<PollRequest>(body) {
                    Ok(request) => request,
                    Err(_) => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
                };
                match self.poll(request) {
                    Ok(response) => json_response("200 OK", response),
                    Err(error) => error_response("400 Bad Request", &error),
                }
            }
            "/api/desktop-pet-e-agent/submit" => {
                let request = match serde_json::from_slice::<SubmitRequest>(body) {
                    Ok(request) => request,
                    Err(_) => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
                };
                match self.submit(request) {
                    Ok(response) => json_response("200 OK", response),
                    Err(error) => error_response("409 Conflict", &error),
                }
            }
            "/api/desktop-pet-e-agent/ack" => {
                let request = match serde_json::from_slice::<AckRequest>(body) {
                    Ok(request) => request,
                    Err(_) => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
                };
                match self.ack(request) {
                    Ok(response) => json_response("200 OK", response),
                    Err(error) => error_response("409 Conflict", &error),
                }
            }
            "/api/desktop-pet-e-agent/cancel" => {
                let request = match serde_json::from_slice::<CancelRequest>(body) {
                    Ok(request) => request,
                    Err(_) => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
                };
                match self.cancel(request) {
                    Ok(response) => json_response("200 OK", response),
                    Err(error) => error_response("409 Conflict", &error),
                }
            }
            _ => error_response("404 Not Found", "desktop_pet_e_agent_endpoint_unknown"),
        }
    }

    fn handle_pi_http(&self, path: &str, body: &[u8]) -> DesktopPetEAgentHttpResponse {
        let request = match serde_json::from_slice::<Value>(body) {
            Ok(value) => value,
            Err(_) => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
        };
        match path {
            "/api/pi-decision/open" => self.pi_open(request),
            "/api/pi-decision/poll" => self.pi_poll(request),
            "/api/pi-decision/ack" => self.pi_ack(request),
            "/api/pi-decision/cancel" => self.pi_cancel(request),
            _ => error_response("404 Not Found", "desktop_pet_e_agent_endpoint_unknown"),
        }
    }

    fn pi_open(&self, request: Value) -> DesktopPetEAgentHttpResponse {
        let request_id = match request.get("requestId").and_then(Value::as_str) {
            Some(value) => value.to_string(),
            None => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
        };
        let source_instance_id = match request.get("sourceInstanceId").and_then(Value::as_str) {
            Some(value) => value.to_string(),
            None => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
        };
        let tab_id = match request.get("tabId").and_then(Value::as_str) {
            Some(value) => value.to_string(),
            None => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
        };
        let session_id = match request.get("sessionId").and_then(Value::as_str) {
            Some(value) => value.to_string(),
            None => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
        };
        let kind = match request.get("kind").and_then(Value::as_str) {
            Some("question") | Some("questionnaire") | Some("permission") =>
                request.get("kind").and_then(Value::as_str).unwrap_or_default(),
            _ => return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid"),
        };
        for value in [&request_id, &source_instance_id, &tab_id, &session_id] {
            if validate_id(value, MAX_ID_LENGTH, "desktop_pet_e_agent_field_invalid").is_err() {
                return error_response("400 Bad Request", "desktop_pet_e_agent_field_invalid");
            }
        }
        let questions = request.get("questions").cloned().unwrap_or_else(|| json!([]));
        let event = if kind == "permission" {
            "PermissionRequest"
        } else {
            "Notification"
        };
        let open_request = OpenRequest {
            source: "pi".to_string(),
            event: event.to_string(),
            protocol: "pi-extension".to_string(),
            tab_id: tab_id.clone(),
            agent_session_id: Some(session_id.clone()),
            tool_use_id: Some(request_id.clone()),
            tool_name: Some(kind.to_string()),
            request_id: Some(Value::String(request_id.clone())),
            method: None,
            hook_input: json!({
                "questions": questions,
                "message": request.get("message"),
                "title": request.get("title"),
                "kind": kind,
            }),
        };
        let opened = match self.open(open_request) {
            Ok(value) => value,
            Err(error) => return error_response("400 Bad Request", &error),
        };
        let status = opened.get("status").and_then(Value::as_str).unwrap_or("unavailable");
        let broker_epoch = PI_DECISION_BROKER_EPOCH;
        if status != "pending" && status != "resolved" {
            if let Some(pending_action_id) = opened
                .get("pendingActionId")
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                let _ = self.cancel(CancelRequest {
                    pending_action_id,
                    reason: Some("pi-adapter-unavailable".to_string()),
                });
            }
            return json_response("200 OK", json!({
                "status": "unavailable",
                "brokerEpoch": broker_epoch,
            }));
        }
        if status == "resolved" {
            return json_response("200 OK", json!({
                "status": "resolved",
                "brokerEpoch": broker_epoch,
                "answer": pi_answer_from_response(opened.get("response")),
                "payload": {
                    "requestId": request_id,
                    "brokerEpoch": broker_epoch,
                    "sourceInstanceId": source_instance_id,
                    "tabId": tab_id,
                    "sessionId": session_id,
                    "kind": kind,
                    "title": request.get("title").and_then(Value::as_str).unwrap_or("Pi decision"),
                    "message": request.get("message").cloned().unwrap_or(Value::Null),
                    "questions": request.get("questions").cloned().unwrap_or_else(|| json!([])),
                    "createdAt": now_millis(),
                },
            }));
        }
        let Some(pending_action_id) = opened
            .get("pendingActionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return error_response("409 Conflict", "desktop_pet_e_agent_pending_unknown");
        };
        let mapping_key = pi_mapping_key(broker_epoch, &source_instance_id, &request_id);
        if let Ok(mut state) = self.shared.0.lock() {
            state.pi_requests.insert(mapping_key, pending_action_id);
        } else {
            return error_response("409 Conflict", "desktop_pet_e_agent_lock_poisoned");
        }
        let action = opened.get("pendingAction").cloned().unwrap_or_else(|| json!({}));
        let action_questions = if kind == "permission" {
            json!([{
                "id": "permission",
                "label": "Permission",
                "prompt": request.get("message").and_then(Value::as_str).unwrap_or("Allow this operation?"),
                "allowOther": false,
                "options": [
                    { "value": "allow", "label": "Allow" },
                    { "value": "deny", "label": "Deny" }
                ]
            }])
        } else {
            action.get("questions").cloned().unwrap_or_else(|| json!([]))
        };
        json_response("200 OK", json!({
            "status": status,
            "brokerEpoch": broker_epoch,
            "payload": {
                "requestId": request_id,
                "brokerEpoch": broker_epoch,
                "sourceInstanceId": source_instance_id,
                "tabId": tab_id,
                "sessionId": session_id,
                "kind": kind,
                "title": request.get("title").and_then(Value::as_str).unwrap_or("Pi decision"),
                "message": request.get("message").cloned().unwrap_or(Value::Null),
                "questions": action_questions,
                "createdAt": now_millis(),
            }
        }))
    }

    fn pi_poll(&self, request: Value) -> DesktopPetEAgentHttpResponse {
        let Some(request_id) = request.get("requestId").and_then(Value::as_str) else {
            return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid");
        };
        let source_instance_id = request.get("sourceInstanceId").and_then(Value::as_str);
        if request.get("brokerEpoch").and_then(Value::as_str) != Some(PI_DECISION_BROKER_EPOCH) {
            return json_response("200 OK", json!({ "status": "unavailable" }));
        }
        let (key, pending_action_id) = match self.shared.0.lock().ok().and_then(|state| {
            pi_lookup_pending(&state, source_instance_id, request_id)
        }) {
            Some(value) => value,
            None => return json_response("200 OK", json!({ "status": "cancelled" })),
        };
        let _ = key;
        let response = match self.poll(PollRequest {
            pending_action_id,
            wait_ms: Some(1),
        }) {
            Ok(value) => value,
            Err(error) => return error_response("409 Conflict", &error),
        };
        if response.get("status").and_then(Value::as_str) != Some("resolved") {
            return json_response("200 OK", response);
        }
        let answer = pi_answer_from_response(response.get("response"));
        json_response("200 OK", json!({
            "status": "resolved",
            "brokerEpoch": PI_DECISION_BROKER_EPOCH,
            "answer": answer,
        }))
    }

    fn pi_ack(&self, request: Value) -> DesktopPetEAgentHttpResponse {
        if request.get("requestId").and_then(Value::as_str).is_none()
            || request.get("brokerEpoch").and_then(Value::as_str) != Some(PI_DECISION_BROKER_EPOCH)
        {
            return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid");
        }
        let Some((pending_action_id, key)) = self.pi_pending_from_request(&request) else {
            return json_response("200 OK", json!({ "status": "accepted" }));
        };
        let result = self.ack(AckRequest {
            pending_action_id,
            transport_action_id: None,
            success: true,
            error: None,
        });
        if result.is_ok() {
            if let Ok(mut state) = self.shared.0.lock() {
                state.pi_requests.remove(&key);
            }
            json_response("200 OK", json!({ "status": "accepted" }))
        } else {
            error_response("409 Conflict", "desktop_pet_e_agent_pending_unknown")
        }
    }

    fn pi_cancel(&self, request: Value) -> DesktopPetEAgentHttpResponse {
        if request.get("requestId").and_then(Value::as_str).is_none()
            || request.get("brokerEpoch").and_then(Value::as_str) != Some(PI_DECISION_BROKER_EPOCH)
        {
            return error_response("400 Bad Request", "desktop_pet_e_agent_request_invalid");
        }
        let Some((pending_action_id, key)) = self.pi_pending_from_request(&request) else {
            return json_response("200 OK", json!({ "status": "accepted" }));
        };
        let result = self.cancel(CancelRequest {
            pending_action_id,
            reason: Some("pi-cancelled".to_string()),
        });
        if result.is_ok() {
            if let Ok(mut state) = self.shared.0.lock() {
                state.pi_requests.remove(&key);
            }
            json_response("200 OK", json!({ "status": "accepted" }))
        } else {
            error_response("409 Conflict", "desktop_pet_e_agent_pending_unknown")
        }
    }

    fn pi_pending_from_request(&self, request: &Value) -> Option<(String, String)> {
        let request_id = request.get("requestId").and_then(Value::as_str)?;
        if request.get("brokerEpoch").and_then(Value::as_str) != Some(PI_DECISION_BROKER_EPOCH) {
            return None;
        }
        let source_instance_id = request.get("sourceInstanceId").and_then(Value::as_str);
        let state = self.shared.0.lock().ok()?;
        pi_lookup_pending(&state, source_instance_id, request_id)
            .map(|(key, pending_action_id)| (pending_action_id, key))
    }

    pub fn observe_hook(&self, payload: &Value) {
        let event = payload.get("event").and_then(Value::as_str).unwrap_or_default();
        if !matches!(event, "UserPromptSubmit" | "Stop" | "StopFailure") {
            return;
        }
        let session_id = payload
            .get("tabId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(session_id) = session_id else {
            return;
        };

        let mut removed = Vec::new();
        if let Ok(mut state) = self.shared.0.lock() {
            let ids = state
                .pending
                .iter()
                .filter(|(_, entry)| {
                    matches!(&entry.state, PendingState::Waiting)
                        && entry.session_id == session_id
                        && (matches!(event, "Stop" | "StopFailure")
                            || action_adapter_mode(&entry.action) != Some("interactive"))
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in ids {
                if let Some(entry) = remove_pending(&mut state, &id) {
                    removed.push(entry);
                }
            }
            self.shared.1.notify_all();
        }
        for entry in removed {
            self.publish(agent_event(
                "cancelled",
                &entry,
                pending_transport_action_id(&entry),
                None,
            ));
        }
    }

    fn set_available(&self, request: AvailabilityRequest) -> Result<(), String> {
        validate_id(&request.instance_id, MAX_ACTION_ID_LENGTH, "desktop_pet_e_agent_instance_invalid")?;
        let pending = {
            let mut state = self
                .shared
                .0
                .lock()
                .map_err(|_| "desktop_pet_e_agent_lock_poisoned".to_string())?;
            prune_availability(&mut state, Instant::now());
            if request.available {
                let is_new_instance = state
                    .available_instances
                    .insert(
                        request.instance_id,
                        AvailabilityLease {
                            updated_at: Instant::now(),
                            accept_new: request.accept_new,
                        },
                    )
                    .is_none();
                if is_new_instance {
                    state.pending.values().cloned().collect::<Vec<_>>()
                } else {
                    Vec::new()
                }
            } else {
                state.available_instances.remove(&request.instance_id);
                Vec::new()
            }
            self.shared.1.notify_all();
        };
        for entry in pending {
            self.publish(agent_event("pending", &entry, None, None));
        }
        Ok(())
    }

    fn open(&self, request: OpenRequest) -> Result<Value, String> {
        validate_open_request(&request)?;
        let request_key = request_key(&request);
        let blueprint = action_blueprint(&request);
        let now = Instant::now();
        let mut replaced = Vec::new();
        let entry;
        let accepted;
        {
            let mut state = self
                .shared
                .0
                .lock()
                .map_err(|_| "desktop_pet_e_agent_lock_poisoned".to_string())?;
            prune_availability(&mut state, now);
            prune_completed(&mut state, now);
            if let Some(completed) = state.completed.get(&request_key) {
                return Ok(json!({
                    "status": "resolved",
                    "pendingActionId": completed.pending_action_id,
                    "transportActionId": completed.transport_action_id,
                    "response": completed.response,
                }));
            }
            if let Some(existing_id) = state.request_keys.get(&request_key).cloned() {
                if let Some(existing) = state.pending.get(&existing_id) {
                    return Ok(json!({
                        "status": if action_adapter_mode(&existing.action) == Some("interactive") { "pending" } else { "unavailable" },
                        "pendingActionId": existing.pending_action_id,
                        "pendingAction": existing.action,
                    }));
                }
                state.request_keys.remove(&request_key);
            }

            let accepts_new = state.available_instances.values().any(|lease| lease.accept_new);
            if blueprint.interactive_supported && !accepts_new {
                state.next_generation = state.next_generation.saturating_add(1).max(1);
                let pending_action_id = Uuid::new_v4().to_string();
                return Ok(json!({
                    "status": "unavailable",
                    "pendingActionId": pending_action_id,
                    "pendingAction": {
                        "id": pending_action_id,
                        "kind": blueprint.kind,
                        "title": blueprint.title,
                        "message": blueprint.message,
                        "requestGeneration": state.next_generation,
                        "adapterMode": "jump-only",
                        "adapterReason": "desktopPetE.agent.adapterUnavailable",
                        "questions": if blueprint.questions.is_empty() { Value::Null } else { Value::Array(blueprint.questions) },
                        "approvalChoices": if blueprint.approval_choices.is_empty() { Value::Null } else { Value::Array(blueprint.approval_choices) },
                        "submitting": false,
                        "error": Value::Null,
                    },
                }));
            }

            let stale_ids = state
                .pending
                .iter()
                .filter(|(_, current)| {
                    current.session_id == request.tab_id
                        && matches!(&current.state, PendingState::Waiting)
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in stale_ids {
                if let Some(current) = remove_pending(&mut state, &id) {
                    replaced.push(current);
                }
            }
            while state.pending.len() >= MAX_PENDING_ACTIONS {
                let oldest = state
                    .pending
                    .iter()
                    .filter(|(_, current)| matches!(&current.state, PendingState::Waiting))
                    .min_by_key(|(_, current)| current.created_at)
                    .map(|(id, _)| id.clone());
                let Some(oldest) = oldest else {
                    return Err("desktop_pet_e_agent_capacity".to_string());
                };
                if let Some(current) = remove_pending(&mut state, &oldest) {
                    replaced.push(current);
                }
            }

            state.next_generation = state.next_generation.saturating_add(1).max(1);
            let pending_action_id = Uuid::new_v4().to_string();
            accepted = blueprint.interactive_supported
                && state.available_instances.values().any(|lease| lease.accept_new);
            let adapter_reason = if accepted {
                None
            } else {
                blueprint
                    .adapter_reason
                    .or(Some("desktopPetE.agent.adapterUnavailable"))
            };
            let action = json!({
                "id": pending_action_id,
                "kind": blueprint.kind,
                "title": blueprint.title,
                "message": blueprint.message,
                "requestGeneration": state.next_generation,
                "adapterMode": if accepted { "interactive" } else { "jump-only" },
                "adapterReason": adapter_reason,
                "questions": if blueprint.questions.is_empty() { Value::Null } else { Value::Array(blueprint.questions) },
                "approvalChoices": if blueprint.approval_choices.is_empty() { Value::Null } else { Value::Array(blueprint.approval_choices) },
                "submitting": false,
                "error": Value::Null,
            });
            entry = PendingEntry {
                request_key: request_key.clone(),
                pending_action_id: pending_action_id.clone(),
                session_id: request.tab_id,
                source: request.source,
                protocol: request.protocol,
                method: request.method,
                request_id: request.request_id,
                hook_input: request.hook_input,
                action,
                state: PendingState::Waiting,
                created_at: now,
                expires_at: now + PENDING_ACTION_TTL,
            };
            state
                .request_keys
                .insert(request_key, pending_action_id.clone());
            state.pending.insert(pending_action_id, entry.clone());
            self.shared.1.notify_all();
        }

        for current in replaced {
            self.publish(agent_event(
                "cancelled",
                &current,
                pending_transport_action_id(&current),
                None,
            ));
        }
        self.publish(agent_event("pending", &entry, None, None));
        Ok(json!({
            "status": if accepted { "pending" } else { "unavailable" },
            "pendingActionId": entry.pending_action_id,
            "pendingAction": entry.action,
        }))
    }

    fn poll(&self, request: PollRequest) -> Result<Value, String> {
        validate_id(
            &request.pending_action_id,
            MAX_ID_LENGTH,
            "desktop_pet_e_agent_pending_id_invalid",
        )?;
        let wait = Duration::from_millis(request.wait_ms.unwrap_or(30_000).clamp(1, 590_000));
        let deadline = Instant::now() + wait;
        let mut state = self
            .shared
            .0
            .lock()
            .map_err(|_| "desktop_pet_e_agent_lock_poisoned".to_string())?;
        loop {
            let now = Instant::now();
            prune_availability(&mut state, now);
            if state.available_instances.is_empty() {
                let entry = remove_pending(&mut state, &request.pending_action_id);
                self.shared.1.notify_all();
                drop(state);
                if let Some(entry) = entry {
                    self.publish(agent_event(
                        "cancelled",
                        &entry,
                        pending_transport_action_id(&entry),
                        Some("desktopPetE.agent.adapterUnavailable"),
                    ));
                }
                return Ok(json!({ "status": "unavailable" }));
            }
            let expired = state
                .pending
                .get(&request.pending_action_id)
                .is_some_and(|entry| entry.expires_at <= now);
            if !expired {
                if let Some(entry) = state.pending.get_mut(&request.pending_action_id) {
                    entry.expires_at = now + PENDING_ACTION_TTL;
                }
            }
            if expired {
                let entry = remove_pending(&mut state, &request.pending_action_id);
                self.shared.1.notify_all();
                drop(state);
                if let Some(mut entry) = entry {
                    set_action_unavailable(
                        &mut entry.action,
                        "desktopPetE.agent.requestExpired",
                    );
                    self.publish(agent_event(
                        "failed",
                        &entry,
                        pending_transport_action_id(&entry),
                        Some("desktopPetE.agent.requestExpired"),
                    ));
                }
                return Ok(json!({ "status": "expired" }));
            }

            let Some(entry) = state.pending.get(&request.pending_action_id) else {
                return Ok(json!({ "status": "cancelled" }));
            };
            if action_adapter_mode(&entry.action) != Some("interactive") {
                return Ok(json!({ "status": "unavailable" }));
            }
            if let PendingState::Submitted {
                transport_action_id,
                response,
            } = &entry.state
            {
                return Ok(json!({
                    "status": "resolved",
                    "pendingActionId": entry.pending_action_id,
                    "transportActionId": transport_action_id,
                    "response": response,
                }));
            }

            let Some(remaining) = deadline.checked_duration_since(now) else {
                return Ok(json!({ "status": "pending" }));
            };
            if remaining.is_zero() {
                return Ok(json!({ "status": "pending" }));
            }
            let (next_state, timeout) = self
                .shared
                .1
                .wait_timeout(state, remaining)
                .map_err(|_| "desktop_pet_e_agent_lock_poisoned".to_string())?;
            state = next_state;
            if timeout.timed_out() {
                return Ok(json!({ "status": "pending" }));
            }
        }
    }

    fn submit(&self, request: SubmitRequest) -> Result<Value, String> {
        validate_id(
            &request.pending_action_id,
            MAX_ID_LENGTH,
            "desktop_pet_e_agent_pending_id_invalid",
        )?;
        validate_id(
            &request.transport_action_id,
            MAX_ACTION_ID_LENGTH,
            "desktop_pet_e_agent_transport_id_invalid",
        )?;
        let mut state = self
            .shared
            .0
            .lock()
            .map_err(|_| "desktop_pet_e_agent_lock_poisoned".to_string())?;
        prune_completed(&mut state, Instant::now());
        if let Some(completed) = state
            .completed
            .values()
            .find(|entry| entry.pending_action_id == request.pending_action_id)
        {
            if completed.transport_action_id == request.transport_action_id {
                return Ok(json!({
                    "status": "accepted",
                    "accepted": true,
                    "pendingActionId": request.pending_action_id,
                    "transportActionId": request.transport_action_id,
                }));
            }
            return Err("desktop_pet_e_agent_transport_mismatch".to_string());
        }
        let snapshot = state
            .pending
            .get(&request.pending_action_id)
            .cloned()
            .ok_or_else(|| "desktop_pet_e_agent_pending_unknown".to_string())?;
        if snapshot.expires_at <= Instant::now() {
            return Err("desktop_pet_e_agent_pending_expired".to_string());
        }
        if action_adapter_mode(&snapshot.action) != Some("interactive") {
            return Err("desktop_pet_e_agent_adapter_unavailable".to_string());
        }
        if let PendingState::Submitted {
            transport_action_id,
            ..
        } = &snapshot.state
        {
            if transport_action_id == &request.transport_action_id {
                return Ok(json!({
                    "status": "accepted",
                    "accepted": true,
                    "pendingActionId": request.pending_action_id,
                    "transportActionId": request.transport_action_id,
                }));
            }
            return Err("desktop_pet_e_agent_already_submitted".to_string());
        }
        validate_submission(&snapshot.action, &request)?;
        let response = build_protocol_response(&snapshot, &request)?;
        let current = state
            .pending
            .get_mut(&request.pending_action_id)
            .ok_or_else(|| "desktop_pet_e_agent_pending_unknown".to_string())?;
        set_action_status(&mut current.action, true, None);
        current.state = PendingState::Submitted {
            transport_action_id: request.transport_action_id.clone(),
            response,
        };
        let event_entry = current.clone();
        self.shared.1.notify_all();
        drop(state);
        self.publish(agent_event(
            "submitted",
            &event_entry,
            Some(&request.transport_action_id),
            None,
        ));
        Ok(json!({
            "status": "accepted",
            "accepted": true,
            "pendingActionId": request.pending_action_id,
            "transportActionId": request.transport_action_id,
        }))
    }

    fn ack(&self, request: AckRequest) -> Result<Value, String> {
        validate_id(
            &request.pending_action_id,
            MAX_ID_LENGTH,
            "desktop_pet_e_agent_pending_id_invalid",
        )?;
        validate_optional_error(request.error.as_deref())?;
        let mut state = self
            .shared
            .0
            .lock()
            .map_err(|_| "desktop_pet_e_agent_lock_poisoned".to_string())?;
        prune_completed(&mut state, Instant::now());
        if let Some(completed) = state
            .completed
            .values()
            .find(|entry| entry.pending_action_id == request.pending_action_id)
        {
            if request
                .transport_action_id
                .as_deref()
                .is_some_and(|value| value != completed.transport_action_id)
            {
                return Err("desktop_pet_e_agent_transport_mismatch".to_string());
            }
            return Ok(json!({ "status": "accepted" }));
        }
        let current_transport_id = state
            .pending
            .get(&request.pending_action_id)
            .and_then(|entry| match &entry.state {
                PendingState::Submitted {
                    transport_action_id,
                    ..
                } => Some(transport_action_id.clone()),
                PendingState::Waiting => None,
            })
            .ok_or_else(|| "desktop_pet_e_agent_not_submitted".to_string())?;
        if request
            .transport_action_id
            .as_deref()
            .is_some_and(|value| value != current_transport_id)
        {
            return Err("desktop_pet_e_agent_transport_mismatch".to_string());
        }

        if request.success {
            let entry = remove_pending(&mut state, &request.pending_action_id)
                .ok_or_else(|| "desktop_pet_e_agent_pending_unknown".to_string())?;
            if let PendingState::Submitted {
                transport_action_id,
                response,
            } = &entry.state
            {
                remember_completed(
                    &mut state,
                    entry.request_key.clone(),
                    CompletedEntry {
                        pending_action_id: entry.pending_action_id.clone(),
                        response: response.clone(),
                        transport_action_id: transport_action_id.clone(),
                        completed_at: Instant::now(),
                    },
                );
            }
            self.shared.1.notify_all();
            drop(state);
            self.publish(agent_event(
                "resolved",
                &entry,
                Some(&current_transport_id),
                None,
            ));
            return Ok(json!({ "status": "accepted" }));
        }

        let error = request
            .error
            .as_deref()
            .and_then(non_empty_text)
            .unwrap_or_else(|| "desktopPetE.agent.deliveryFailed".to_string());
        let entry = state
            .pending
            .get_mut(&request.pending_action_id)
            .ok_or_else(|| "desktop_pet_e_agent_pending_unknown".to_string())?;
        entry.state = PendingState::Waiting;
        set_action_status(&mut entry.action, false, Some(&error));
        let event_entry = entry.clone();
        self.shared.1.notify_all();
        drop(state);
        self.publish(agent_event(
            "failed",
            &event_entry,
            Some(&current_transport_id),
            Some(&error),
        ));
        Ok(json!({ "status": "accepted" }))
    }

    fn cancel(&self, request: CancelRequest) -> Result<Value, String> {
        validate_id(
            &request.pending_action_id,
            MAX_ID_LENGTH,
            "desktop_pet_e_agent_pending_id_invalid",
        )?;
        validate_optional_error(request.reason.as_deref())?;
        let mut state = self
            .shared
            .0
            .lock()
            .map_err(|_| "desktop_pet_e_agent_lock_poisoned".to_string())?;
        let entry = remove_pending(&mut state, &request.pending_action_id)
            .ok_or_else(|| "desktop_pet_e_agent_pending_unknown".to_string())?;
        let transport_action_id = match &entry.state {
            PendingState::Submitted {
                transport_action_id,
                ..
            } => Some(transport_action_id.as_str()),
            PendingState::Waiting => None,
        };
        self.shared.1.notify_all();
        drop(state);
        self.publish(agent_event(
            "cancelled",
            &entry,
            transport_action_id,
            request.reason.as_deref(),
        ));
        Ok(json!({ "status": "accepted" }))
    }

    fn publish(&self, value: Value) {
        let sink = self
            .event_sink
            .lock()
            .ok()
            .and_then(|sink| sink.as_ref().cloned());
        if let Some(sink) = sink {
            sink(value);
        }
    }
}

fn validate_open_request(request: &OpenRequest) -> Result<(), String> {
    if !matches!(request.source.as_str(), "claude" | "codex" | "pi" | "grok") {
        return Err("desktop_pet_e_agent_source_invalid".to_string());
    }
    if !matches!(
        request.protocol.as_str(),
        "claude-hook" | "codex-hook" | "codex-app-server" | "pi-extension" | "notification-only"
    ) {
        return Err("desktop_pet_e_agent_protocol_invalid".to_string());
    }
    validate_id(&request.event, MAX_ACTION_ID_LENGTH, "desktop_pet_e_agent_event_invalid")?;
    validate_id(&request.tab_id, MAX_ID_LENGTH, "desktop_pet_e_agent_tab_invalid")?;
    validate_optional_id(request.agent_session_id.as_deref())?;
    validate_optional_id(request.tool_use_id.as_deref())?;
    validate_optional_id(request.tool_name.as_deref())?;
    validate_optional_id(request.method.as_deref())?;
    if let Some(request_id) = &request.request_id {
        match request_id {
            Value::String(value) => {
                validate_id(value, MAX_ID_LENGTH, "desktop_pet_e_agent_request_id_invalid")?;
            }
            Value::Number(_) => {}
            _ => return Err("desktop_pet_e_agent_request_id_invalid".to_string()),
        }
    }
    Ok(())
}

fn validate_optional_id(value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value {
        validate_id(value, MAX_ID_LENGTH, "desktop_pet_e_agent_field_invalid")?;
    }
    Ok(())
}

fn validate_optional_error(value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value {
        if value.chars().count() > 512
            || value
                .chars()
                .any(|character| matches!(character, '\0' | '\r' | '\n'))
        {
            return Err("desktop_pet_e_agent_error_invalid".to_string());
        }
    }
    Ok(())
}

fn validate_id(value: &str, max: usize, error: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > max
        || trimmed.chars().any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err(error.to_string());
    }
    Ok(())
}

fn pi_lookup_pending(
    state: &BrokerState,
    source_instance_id: Option<&str>,
    request_id: &str,
) -> Option<(String, String)> {
    if let Some(source_instance_id) = source_instance_id {
        let key = pi_mapping_key(PI_DECISION_BROKER_EPOCH, source_instance_id, request_id);
        return state.pi_requests.get(&key).cloned().map(|id| (key, id));
    }
    state
        .pi_requests
        .iter()
        .find(|(key, _)| key.ends_with(&format!("|{request_id}")))
        .map(|(key, id)| (key.clone(), id.clone()))
}

fn pi_mapping_key(epoch: &str, instance_id: &str, request_id: &str) -> String {
    format!("{epoch}|{instance_id}|{request_id}")
}

fn pi_answer_from_response(response: Option<&Value>) -> Value {
    let Some(items) = response
        .and_then(|value| value.get("answers"))
        .and_then(Value::as_array)
    else {
        return json!({ "answers": [] });
    };
    let answers = items
        .iter()
        .filter_map(|item| {
            let question_id = item.get("questionId").and_then(Value::as_str)?;
            let custom = item.get("customValue").and_then(Value::as_str).filter(|value| !value.trim().is_empty());
            let value = custom
                .map(str::to_string)
                .or_else(|| item.get("values").and_then(Value::as_array)?.first().and_then(Value::as_str).map(str::to_string))?;
            Some(json!({
                "questionId": question_id,
                "value": value,
                "wasCustom": custom.is_some(),
            }))
        })
        .collect::<Vec<_>>();
    json!({ "answers": answers })
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn default_accept_new() -> bool {
    true
}

fn prune_availability(state: &mut BrokerState, now: Instant) {
    state
        .available_instances
        .retain(|_, lease| now.duration_since(lease.updated_at) <= AVAILABILITY_LEASE);
}

fn prune_completed(state: &mut BrokerState, now: Instant) {
    while let Some(key) = state.completed_order.front().cloned() {
        let expired = match state.completed.get(&key) {
            Some(entry) => now.duration_since(entry.completed_at) > PENDING_ACTION_TTL,
            None => true,
        };
        if !expired && state.completed.len() <= MAX_COMPLETED_ACTIONS {
            break;
        }
        state.completed_order.pop_front();
        state.completed.remove(&key);
    }
}

fn remember_completed(state: &mut BrokerState, key: String, entry: CompletedEntry) {
    if !state.completed.contains_key(&key) {
        state.completed_order.push_back(key.clone());
    }
    state.completed.insert(key, entry);
    prune_completed(state, Instant::now());
}

fn remove_pending(state: &mut BrokerState, pending_action_id: &str) -> Option<PendingEntry> {
    let entry = state.pending.remove(pending_action_id)?;
    if state.request_keys.get(&entry.request_key).map(String::as_str) == Some(pending_action_id) {
        state.request_keys.remove(&entry.request_key);
    }
    state.pi_requests.retain(|_, value| value != pending_action_id);
    Some(entry)
}

fn request_key(request: &OpenRequest) -> String {
    let request_id = request
        .request_id
        .as_ref()
        .and_then(|value| serde_json::to_string(value).ok())
        .unwrap_or_default();
    serde_json::to_string(&[
        request.source.as_str(),
        request.protocol.as_str(),
        request.tab_id.as_str(),
        request.agent_session_id.as_deref().unwrap_or_default(),
        request.event.as_str(),
        request.tool_use_id.as_deref().unwrap_or_default(),
        request.method.as_deref().unwrap_or_default(),
        request_id.as_str(),
    ])
    .unwrap_or_default()
}

fn has_known_tool_name(request: &OpenRequest) -> bool {
    request
        .tool_name
        .as_deref()
        .and_then(non_empty_text)
        .is_some_and(|value| !value.eq_ignore_ascii_case("unknown"))
}

fn action_blueprint(request: &OpenRequest) -> ActionBlueprint {
    let notification_only = request.protocol == "notification-only";
    let title = request
        .tool_name
        .as_deref()
        .and_then(non_empty_text)
        .map(|value| value.chars().take(160).collect());
    let message = approval_message(&request.hook_input);

    if request.source == "claude" {
        if request.tool_name.as_deref() == Some("AskUserQuestion") {
            let questions = claude_questions(&request.hook_input);
            if questions.is_empty() {
                return ActionBlueprint {
                    kind: "question",
                    title,
                    message,
                    questions,
                    approval_choices: Vec::new(),
                    interactive_supported: false,
                    adapter_reason: Some("desktopPetE.agent.requestUnsupported"),
                };
            }
            return ActionBlueprint {
                kind: if questions.len() > 1 { "questionnaire" } else { "question" },
                title,
                message,
                questions,
                approval_choices: Vec::new(),
                interactive_supported: !notification_only,
                adapter_reason: notification_only.then_some("desktopPetE.agent.notificationOnly"),
            };
        }
        if request.event == "PermissionRequest" && has_known_tool_name(request) {
            return ActionBlueprint {
                kind: "approval",
                title,
                message,
                questions: Vec::new(),
                approval_choices: claude_approval_choices(&request.hook_input),
                interactive_supported: !notification_only,
                adapter_reason: notification_only.then_some("desktopPetE.agent.notificationOnly"),
            };
        }
    }

    if request.source == "codex"
        && request.protocol == "notification-only"
        && request.tool_name.as_deref() == Some("request_user_input")
    {
        let questions = codex_hook_questions(&request.hook_input);
        return ActionBlueprint {
            kind: if questions.len() > 1 { "questionnaire" } else { "question" },
            title,
            message,
            questions,
            approval_choices: Vec::new(),
            interactive_supported: false,
            adapter_reason: Some("desktopPetE.agent.notificationOnly"),
        };
    }

    if request.source == "codex" && request.protocol == "codex-app-server" {
        let method = request.method.as_deref().unwrap_or_default();
        if matches!(method, "item/tool/requestUserInput" | "tool/requestUserInput") {
            let questions = codex_questions(&request.hook_input);
            return ActionBlueprint {
                kind: if questions.len() > 1 { "questionnaire" } else { "question" },
                title,
                message,
                interactive_supported: !questions.is_empty(),
                adapter_reason: questions
                    .is_empty()
                    .then_some("desktopPetE.agent.requestUnsupported"),
                questions,
                approval_choices: Vec::new(),
            };
        }
        if method == "mcpServer/elicitation/request" {
            let questions = mcp_questions(&request.hook_input);
            return ActionBlueprint {
                kind: if questions.len() > 1 { "questionnaire" } else { "question" },
                title,
                message,
                interactive_supported: !questions.is_empty(),
                adapter_reason: questions
                    .is_empty()
                    .then_some("desktopPetE.agent.requestUnsupported"),
                questions,
                approval_choices: Vec::new(),
            };
        }
        if is_codex_approval_method(method) {
            let approval_choices = codex_approval_choices(method, &request.hook_input);
            let interactive_supported = !approval_choices.is_empty();
            return ActionBlueprint {
                kind: "approval",
                title,
                message,
                questions: Vec::new(),
                approval_choices,
                interactive_supported,
                adapter_reason: (!interactive_supported)
                    .then_some("desktopPetE.agent.requestUnsupported"),
            };
        }
    }

    if request.source == "codex"
        && request.protocol == "codex-hook"
        && request.event == "PermissionRequest"
        && has_known_tool_name(request)
    {
        return ActionBlueprint {
            kind: "approval",
            title,
            message,
            questions: Vec::new(),
            approval_choices: default_approval_choices(false),
            interactive_supported: true,
            adapter_reason: None,
        };
    }

    if request.source == "pi"
        && request.protocol == "pi-extension"
        && request.event == "PermissionRequest"
    {
        return ActionBlueprint {
            kind: "approval",
            title,
            message,
            questions: Vec::new(),
            approval_choices: default_approval_choices(false),
            interactive_supported: true,
            adapter_reason: None,
        };
    }

    if request.source == "pi" && request.protocol == "pi-extension" {
        let questions = normalized_questions(request.hook_input.get("questions"), false);
        if !questions.is_empty() {
            return ActionBlueprint {
                kind: if questions.len() > 1 { "questionnaire" } else { "question" },
                title,
                message,
                questions,
                approval_choices: Vec::new(),
                interactive_supported: true,
                adapter_reason: None,
            };
        }
    }

    ActionBlueprint {
        kind: if request.event == "PermissionRequest" { "approval" } else { "question" },
        title,
        message,
        questions: Vec::new(),
        approval_choices: Vec::new(),
        interactive_supported: false,
        adapter_reason: Some(if request.source == "grok" {
            "desktopPetE.agent.grokJumpOnly"
        } else if notification_only {
            "desktopPetE.agent.notificationOnly"
        } else {
            "desktopPetE.agent.requestUnsupported"
        }),
    }
}

fn claude_questions(hook_input: &Value) -> Vec<Value> {
    let questions = hook_input
        .get("tool_input")
        .and_then(|value| value.get("questions"));
    normalized_questions(questions, true)
}

fn codex_questions(hook_input: &Value) -> Vec<Value> {
    let questions = hook_input
        .get("params")
        .and_then(|value| value.get("questions"));
    if questions
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("is_secret")
                    .or_else(|| item.get("isSecret"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
        })
    {
        return Vec::new();
    }
    normalized_questions(questions, true)
}

fn codex_hook_questions(hook_input: &Value) -> Vec<Value> {
    let questions = hook_input
        .get("tool_input")
        .and_then(|value| value.get("questions"))
        .or_else(|| hook_input.get("questions"));
    normalized_questions(questions, true)
}

fn normalized_questions(value: Option<&Value>, default_allow_other: bool) -> Vec<Value> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    if items.is_empty() || items.len() > MAX_QUESTIONS {
        return Vec::new();
    }

    let mut normalized = Vec::with_capacity(items.len());
    let mut seen_ids = std::collections::HashSet::new();
    for (index, item) in items.iter().enumerate() {
        let Some(prompt) = first_string(item, &["question", "prompt"]) else {
            return Vec::new();
        };
        if prompt.chars().count() > MAX_TEXT_LENGTH {
            return Vec::new();
        }
        let id = first_string(item, &["id"]).unwrap_or_else(|| index.to_string());
        if validate_id(&id, MAX_ID_LENGTH, "desktop_pet_e_agent_question_invalid").is_err()
            || !seen_ids.insert(id.clone())
        {
            return Vec::new();
        }
        let label = first_string(item, &["header", "label"]);
        if label
            .as_deref()
            .is_some_and(|value| value.chars().count() > 160)
        {
            return Vec::new();
        }

        let mut options = Vec::new();
        if let Some(raw_options) = item.get("options") {
            if !raw_options.is_null() {
                let Some(raw_options) = raw_options.as_array() else {
                    return Vec::new();
                };
                if raw_options.len() > MAX_OPTIONS {
                    return Vec::new();
                }
                let mut seen_values = std::collections::HashSet::new();
                for option in raw_options {
                    let Some(option_label) = option
                        .as_str()
                        .and_then(non_empty_text)
                        .or_else(|| first_string(option, &["label", "value"]))
                    else {
                        return Vec::new();
                    };
                    let option_value = first_string(option, &["value"])
                        .unwrap_or_else(|| option_label.clone());
                    let description = first_string(option, &["description"]);
                    if option_label.chars().count() > 160
                        || option_value.chars().count() > MAX_TEXT_LENGTH
                        || description
                            .as_deref()
                            .is_some_and(|value| value.chars().count() > 320)
                        || !seen_values.insert(option_value.clone())
                    {
                        return Vec::new();
                    }
                    options.push(json!({
                        "value": option_value,
                        "label": option_label,
                        "description": description,
                    }));
                }
            }
        }

        let multiple = item
            .get("multiSelect")
            .or_else(|| item.get("multi_select"))
            .or_else(|| item.get("multiple"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allow_other = item
            .get("allowOther")
            .or_else(|| item.get("allow_other"))
            .or_else(|| item.get("isOther"))
            .or_else(|| item.get("is_other"))
            .and_then(Value::as_bool)
            .unwrap_or(default_allow_other);
        if options.is_empty() && !allow_other {
            return Vec::new();
        }
        normalized.push(json!({
            "id": id,
            "label": label,
            "prompt": prompt,
            "mode": if options.is_empty() { "text" } else if multiple { "multiple" } else { "single" },
            "required": true,
            "allowOther": allow_other,
            "options": options,
        }));
    }
    normalized
}

fn mcp_questions(hook_input: &Value) -> Vec<Value> {
    let params = match hook_input.get("params") {
        Some(params) => params,
        None => return Vec::new(),
    };
    let mode = params.get("mode").and_then(Value::as_str).unwrap_or("form");
    if !matches!(mode, "form" | "openai/form") {
        return Vec::new();
    }
    let Some(schema) = params
        .get("requestedSchema")
        .or_else(|| params.get("requested_schema"))
    else {
        return Vec::new();
    };
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return Vec::new();
    }
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    if properties.is_empty() || properties.len() > MAX_QUESTIONS {
        return Vec::new();
    }
    let mut required_ids = std::collections::HashSet::<String>::new();
    if let Some(required) = schema.get("required") {
        let Some(required) = required.as_array() else {
            return Vec::new();
        };
        for required_id in required {
            let Some(required_id) = required_id.as_str() else {
                return Vec::new();
            };
            if !properties.contains_key(required_id) || !required_ids.insert(required_id.to_string()) {
                return Vec::new();
            }
        }
    }

    let mut questions = Vec::with_capacity(properties.len());
    for (id, property) in properties {
        if validate_id(id, MAX_ID_LENGTH, "desktop_pet_e_agent_question_invalid").is_err() {
            return Vec::new();
        }
        let label = first_string(property, &["title"]);
        let prompt = first_string(property, &["description", "title"])
            .unwrap_or_else(|| id.clone());
        if label
            .as_deref()
            .is_some_and(|value| value.chars().count() > 160)
            || prompt.chars().count() > MAX_TEXT_LENGTH
        {
            return Vec::new();
        }
        let Some(options) = mcp_options(property) else {
            return Vec::new();
        };
        let value_type = property.get("type").and_then(Value::as_str).unwrap_or("string");
        let multiple = value_type == "array";
        if !matches!(value_type, "string" | "number" | "integer" | "boolean" | "array")
            || (multiple && options.is_empty())
        {
            return Vec::new();
        }
        questions.push(json!({
            "id": id,
            "label": label,
            "prompt": prompt,
            "mode": if options.is_empty() { "text" } else if multiple { "multiple" } else { "single" },
            "required": required_ids.contains(id),
            "allowOther": false,
            "options": options,
        }));
    }
    questions
}

fn mcp_options(property: &Value) -> Option<Vec<Value>> {
    let direct_values = property.get("enum").and_then(Value::as_array);
    let source = direct_values.or_else(|| {
        property
            .get("items")
            .and_then(|value| value.get("enum"))
            .and_then(Value::as_array)
    });
    if let Some(values) = source {
        if values.len() > MAX_OPTIONS {
            return None;
        }
        let enum_names = if direct_values.is_some() {
            match property.get("enumNames") {
                Some(value) => Some(value.as_array()?),
                None => None,
            }
        } else {
            None
        };
        if enum_names.is_some_and(|names| names.len() != values.len()) {
            return None;
        }
        let mut seen_values = std::collections::HashSet::new();
        return values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                let value = value.as_str()?.trim();
                let label = enum_names
                    .and_then(|names| names.get(index))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or(value);
                if value.is_empty()
                    || value.chars().count() > MAX_TEXT_LENGTH
                    || label.is_empty()
                    || label.chars().count() > 160
                    || !seen_values.insert(value.to_string())
                {
                    return None;
                }
                Some(json!({ "value": value, "label": label, "description": Value::Null }))
            })
            .collect::<Option<Vec<_>>>();
    }

    let titled = property
        .get("oneOf")
        .or_else(|| property.get("anyOf"))
        .or_else(|| property.get("items").and_then(|value| value.get("anyOf")))
        .or_else(|| property.get("items").and_then(|value| value.get("oneOf")))
        .and_then(Value::as_array);
    if let Some(titled) = titled {
        if titled.len() > MAX_OPTIONS {
            return None;
        }
        let mut seen_values = std::collections::HashSet::new();
        return titled
            .iter()
            .map(|item| {
                let value = first_string(item, &["const"])?;
                let label = first_string(item, &["title"]).unwrap_or_else(|| value.clone());
                if value.chars().count() > MAX_TEXT_LENGTH
                    || label.chars().count() > 160
                    || !seen_values.insert(value.clone())
                {
                    return None;
                }
                Some(json!({ "value": value, "label": label, "description": Value::Null }))
            })
            .collect::<Option<Vec<_>>>();
    }

    let value_type = property
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| {
            property
                .get("items")
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str)
        });
    if value_type == Some("boolean") {
        return Some(vec![
            json!({ "value": "true", "label": "true", "description": Value::Null }),
            json!({ "value": "false", "label": "false", "description": Value::Null }),
        ]);
    }
    Some(Vec::new())
}

fn is_supported_claude_permission_suggestion(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let supported_type = matches!(
        object.get("type").and_then(Value::as_str),
        Some(
            "addRules"
                | "replaceRules"
                | "removeRules"
                | "setMode"
                | "addDirectories"
                | "removeDirectories"
        )
    );
    let supported_destination = matches!(
        object.get("destination").and_then(Value::as_str),
        Some("session" | "localSettings" | "projectSettings" | "userSettings")
    );
    supported_type && supported_destination
}

fn claude_permission_suggestions(hook_input: &Value) -> &[Value] {
    hook_input
        .get("permission_suggestions")
        .or_else(|| hook_input.get("permissionSuggestions"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn claude_approval_choices(hook_input: &Value) -> Vec<Value> {
    let mut choices = vec![json!({
        "value": "allow",
        "label": "desktopPetE.approval.allow",
        "destructive": false,
    })];
    for (index, suggestion) in claude_permission_suggestions(hook_input)
        .iter()
        .take(8)
        .enumerate()
    {
        if !is_supported_claude_permission_suggestion(suggestion) {
            continue;
        }
        let label = match suggestion.get("destination").and_then(Value::as_str) {
            Some("session") => "desktopPetE.approval.allowForSession",
            Some("localSettings") => "desktopPetE.approval.alwaysAllowLocal",
            Some("projectSettings") => "desktopPetE.approval.alwaysAllowProject",
            Some("userSettings") => "desktopPetE.approval.alwaysAllowUser",
            _ => "desktopPetE.approval.alwaysAllow",
        };
        choices.push(json!({
            "value": format!("suggestion:{index}"),
            "label": label,
            "destructive": false,
        }));
    }
    choices.push(json!({
        "value": "deny",
        "label": "desktopPetE.approval.deny",
        "destructive": true,
    }));
    choices
}

fn default_approval_choices(allow_session: bool) -> Vec<Value> {
    let mut choices = vec![json!({
        "value": "allow",
        "label": "desktopPetE.approval.allow",
        "destructive": false,
    })];
    if allow_session {
        choices.push(json!({
            "value": "allow-session",
            "label": "desktopPetE.approval.allowForSession",
            "destructive": false,
        }));
    }
    choices.push(json!({
        "value": "deny",
        "label": "desktopPetE.approval.deny",
        "destructive": true,
    }));
    choices
}

fn is_supported_codex_native_command_decision(decision: &Value) -> bool {
    let execpolicy = decision
        .get("acceptWithExecpolicyAmendment")
        .and_then(Value::as_object)
        .and_then(|value| {
            value
                .get("execpolicy_amendment")
                .or_else(|| value.get("execpolicyAmendment"))
        })
        .and_then(Value::as_object)
        .and_then(|amendment| amendment.get("command"))
        .and_then(Value::as_array)
        .is_some_and(|command| {
            !command.is_empty()
                && command
                    .iter()
                    .all(|argument| argument.as_str().is_some_and(|value| !value.is_empty()))
        });
    if execpolicy {
        return true;
    }
    decision
        .get("applyNetworkPolicyAmendment")
        .and_then(Value::as_object)
        .and_then(|value| {
            value
                .get("network_policy_amendment")
                .or_else(|| value.get("networkPolicyAmendment"))
        })
        .and_then(Value::as_object)
        .is_some_and(|amendment| {
            amendment.get("action").and_then(Value::as_str) == Some("allow")
                && amendment
                    .get("host")
                    .and_then(Value::as_str)
                    .is_some_and(|host| !host.trim().is_empty())
        })
}

fn codex_approval_choices(method: &str, hook_input: &Value) -> Vec<Value> {
    if method == "item/permissions/requestApproval" {
        return default_approval_choices(true);
    }
    let decisions = hook_input
        .get("params")
        .and_then(|value| value.get("availableDecisions"));
    let Some(decisions) = decisions else {
        return default_approval_choices(true);
    };
    let Some(decisions) = decisions.as_array() else {
        return Vec::new();
    };

    let mut choices = Vec::new();
    for (index, decision) in decisions.iter().take(8).enumerate() {
        let choice = match decision.as_str() {
            Some("accept") => Some((
                "allow".to_string(),
                "desktopPetE.approval.allow",
                false,
            )),
            Some("acceptForSession") => Some((
                "allow-session".to_string(),
                "desktopPetE.approval.allowForSession",
                false,
            )),
            Some("decline") => Some((
                "deny".to_string(),
                "desktopPetE.approval.deny",
                true,
            )),
            Some("cancel") => Some((
                "cancel".to_string(),
                "desktopPetE.approval.cancel",
                true,
            )),
            _ if method == "item/commandExecution/requestApproval"
                && is_supported_codex_native_command_decision(decision) => Some((
                format!("native:{index}"),
                "desktopPetE.approval.alwaysAllow",
                false,
            )),
            _ => None,
        };
        let Some((value, label, destructive)) = choice else {
            continue;
        };
        if choices.iter().any(|item: &Value| {
            item.get("value").and_then(Value::as_str) == Some(value.as_str())
        }) {
            continue;
        }
        choices.push(json!({
            "value": value,
            "label": label,
            "destructive": destructive,
        }));
    }
    choices
}

fn approval_message(hook_input: &Value) -> Option<String> {
    first_string(hook_input, &["reason", "message", "description", "command"])
        .or_else(|| {
            hook_input
                .get("params")
                .and_then(|value| first_string(value, &["reason", "message", "command", "cwd"]))
        })
        .or_else(|| {
            hook_input
                .get("tool_input")
                .and_then(|value| first_string(value, &["description", "prompt", "command", "file_path"]))
        })
        .map(|value| value.chars().take(2000).collect())
}

fn is_codex_approval_method(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "applyPatchApproval"
            | "execCommandApproval"
    )
}

fn validate_submission(action: &Value, request: &SubmitRequest) -> Result<(), String> {
    let kind = action.get("kind").and_then(Value::as_str).unwrap_or_default();
    if kind == "approval" {
        let approval = request
            .approval_value
            .as_deref()
            .and_then(non_empty_text)
            .ok_or_else(|| "desktop_pet_e_agent_approval_missing".to_string())?;
        if approval.len() > MAX_TEXT_LENGTH {
            return Err("desktop_pet_e_agent_approval_invalid".to_string());
        }
        let allowed = action
            .get("approvalChoices")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices.iter().any(|choice| {
                    choice.get("value").and_then(Value::as_str) == Some(approval.as_str())
                })
            });
        return allowed
            .then_some(())
            .ok_or_else(|| "desktop_pet_e_agent_approval_invalid".to_string());
    }

    if request.answers.len() > MAX_QUESTIONS {
        return Err("desktop_pet_e_agent_answers_too_many".to_string());
    }
    let questions = action
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| "desktop_pet_e_agent_questions_missing".to_string())?;
    if questions.len() != request.answers.len() {
        return Err("desktop_pet_e_agent_answers_incomplete".to_string());
    }
    let question_ids = questions
        .iter()
        .filter_map(|question| question.get("id").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    if question_ids.len() != questions.len()
        || request.answers.iter().any(|answer| !question_ids.contains(answer.question_id.as_str()))
    {
        return Err("desktop_pet_e_agent_answer_invalid".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for question in questions {
        let id = question
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "desktop_pet_e_agent_question_invalid".to_string())?;
        let answer = request
            .answers
            .iter()
            .find(|answer| answer.question_id == id)
            .ok_or_else(|| "desktop_pet_e_agent_answers_incomplete".to_string())?;
        if !seen.insert(answer.question_id.as_str()) || answer.values.len() > MAX_ANSWER_VALUES {
            return Err("desktop_pet_e_agent_answer_invalid".to_string());
        }
        if answer.values.iter().any(|value| value.trim().is_empty() || value.len() > MAX_TEXT_LENGTH)
            || answer
                .custom_value
                .as_deref()
                .is_some_and(|value| value.trim().is_empty() || value.len() > MAX_TEXT_LENGTH)
        {
            return Err("desktop_pet_e_agent_answer_invalid".to_string());
        }
        let mode = question.get("mode").and_then(Value::as_str).unwrap_or("single");
        let allow_other = question
            .get("allowOther")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let has_custom = answer.custom_value.as_deref().is_some_and(|value| !value.trim().is_empty());
        let required = question
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if !required && answer.values.is_empty() && !has_custom {
            continue;
        }
        if has_custom && mode != "text" && !allow_other {
            return Err("desktop_pet_e_agent_answer_invalid".to_string());
        }
        if mode == "text" {
            if !has_custom && answer.values.is_empty() {
                return Err("desktop_pet_e_agent_answers_incomplete".to_string());
            }
        } else if answer.values.is_empty() && !(allow_other && has_custom) {
            return Err("desktop_pet_e_agent_answers_incomplete".to_string());
        } else if mode == "single" && answer.values.len() > 1 {
            return Err("desktop_pet_e_agent_answer_invalid".to_string());
        }
        let option_values = question
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|option| option.get("value").and_then(Value::as_str))
            .collect::<std::collections::HashSet<_>>();
        if answer.values.iter().any(|value| !option_values.contains(value.as_str())) {
            return Err("desktop_pet_e_agent_answer_invalid".to_string());
        }
    }
    Ok(())
}

fn build_protocol_response(entry: &PendingEntry, request: &SubmitRequest) -> Result<Value, String> {
    match entry.protocol.as_str() {
        "claude-hook" => build_claude_response(entry, request),
        "codex-hook" => build_hook_approval_response(request),
        "codex-app-server" => build_codex_response(entry, request),
        "pi-extension" => {
            if let Some(approval) = request.approval_value.as_deref().and_then(non_empty_text) {
                Ok(json!({
                    "answers": [{
                        "questionId": "permission",
                        "values": [approval],
                        "customValue": Value::Null,
                    }]
                }))
            } else {
                Ok(json!({ "answers": request.answers }))
            }
        }
        _ => Err("desktop_pet_e_agent_protocol_unavailable".to_string()),
    }
}

fn build_hook_approval_response(request: &SubmitRequest) -> Result<Value, String> {
    let approval = request
        .approval_value
        .as_deref()
        .ok_or_else(|| "desktop_pet_e_agent_approval_missing".to_string())?;
    if approval_allows(approval) {
        return Ok(json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "allow" }
            }
        }));
    }
    Ok(json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {
                "behavior": "deny",
                "message": "Denied in Desktop Pet E",
            }
        }
    }))
}

fn build_claude_approval_response(
    entry: &PendingEntry,
    request: &SubmitRequest,
) -> Result<Value, String> {
    let approval = request
        .approval_value
        .as_deref()
        .and_then(non_empty_text)
        .ok_or_else(|| "desktop_pet_e_agent_approval_missing".to_string())?;
    if approval == "allow" {
        return Ok(json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "allow" }
            }
        }));
    }
    if approval == "deny" {
        return Ok(json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "deny",
                    "message": "Denied in Desktop Pet E",
                }
            }
        }));
    }
    let index = approval
        .strip_prefix("suggestion:")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| "desktop_pet_e_agent_approval_invalid".to_string())?;
    let suggestion = claude_permission_suggestions(&entry.hook_input)
        .get(index)
        .filter(|value| is_supported_claude_permission_suggestion(value))
        .cloned()
        .ok_or_else(|| "desktop_pet_e_agent_approval_invalid".to_string())?;
    Ok(json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {
                "behavior": "allow",
                "updatedPermissions": [suggestion],
            }
        }
    }))
}

fn build_claude_response(entry: &PendingEntry, request: &SubmitRequest) -> Result<Value, String> {
    if entry.action.get("kind").and_then(Value::as_str) == Some("approval") {
        return build_claude_approval_response(entry, request);
    }
    let tool_input = entry
        .hook_input
        .get("tool_input")
        .and_then(Value::as_object)
        .ok_or_else(|| "desktop_pet_e_agent_questions_missing".to_string())?;
    let raw_questions = tool_input
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| "desktop_pet_e_agent_questions_missing".to_string())?;
    if raw_questions.is_empty() || raw_questions.len() > MAX_QUESTIONS {
        return Err("desktop_pet_e_agent_questions_invalid".to_string());
    }
    let mut answers = Map::new();
    let mut wire_keys = std::collections::HashSet::new();
    for (index, question) in raw_questions.iter().enumerate() {
        let key = first_string(question, &["question", "prompt"])
            .ok_or_else(|| "desktop_pet_e_agent_question_invalid".to_string())?;
        if !wire_keys.insert(key.clone()) {
            return Err("desktop_pet_e_agent_question_invalid".to_string());
        }
        let id = first_string(question, &["id"]).unwrap_or_else(|| index.to_string());
        let answer = request
            .answers
            .iter()
            .find(|answer| answer.question_id == id)
            .ok_or_else(|| "desktop_pet_e_agent_answers_incomplete".to_string())?;
        let value = answer
            .custom_value
            .as_deref()
            .and_then(non_empty_text)
            .unwrap_or_else(|| answer.values.join(", "));
        if value.trim().is_empty() {
            return Err("desktop_pet_e_agent_answers_incomplete".to_string());
        }
        answers.insert(key, Value::String(value));
    }
    let mut updated_input = tool_input.clone();
    updated_input.insert("answers".to_string(), Value::Object(answers));
    Ok(json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {
                "behavior": "allow",
                "updatedInput": updated_input,
            }
        }
    }))
}

fn mcp_schema_property<'a>(hook_input: &'a Value, question_id: &str) -> Option<&'a Value> {
    let params = hook_input.get("params")?;
    let schema = params
        .get("requestedSchema")
        .or_else(|| params.get("requested_schema"))?;
    schema.get("properties")?.get(question_id)
}

fn mcp_schema_property_required(hook_input: &Value, question_id: &str) -> bool {
    let Some(required) = hook_input
        .get("params")
        .and_then(|params| {
            params
                .get("requestedSchema")
                .or_else(|| params.get("requested_schema"))
        })
        .and_then(|schema| schema.get("required"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    required.iter().any(|value| value.as_str() == Some(question_id))
}

fn mcp_answer_value(
    hook_input: &Value,
    answer: &DesktopPetEAgentAnswer,
) -> Result<Value, String> {
    let property = mcp_schema_property(hook_input, &answer.question_id)
        .ok_or_else(|| "desktop_pet_e_agent_question_invalid".to_string())?;
    let value_type = property
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("string");
    if value_type == "array" {
        return Ok(Value::Array(
            answer.values.iter().cloned().map(Value::String).collect(),
        ));
    }
    let text = answer
        .custom_value
        .as_deref()
        .and_then(non_empty_text)
        .or_else(|| answer.values.first().cloned())
        .ok_or_else(|| "desktop_pet_e_agent_answers_incomplete".to_string())?;
    match value_type {
        "boolean" => text
            .parse::<bool>()
            .map(Value::Bool)
            .map_err(|_| "desktop_pet_e_agent_answer_invalid".to_string()),
        "integer" => text
            .parse::<i64>()
            .map(|value| Value::Number(value.into()))
            .map_err(|_| "desktop_pet_e_agent_answer_invalid".to_string()),
        "number" => text
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .ok_or_else(|| "desktop_pet_e_agent_answer_invalid".to_string()),
        _ => Ok(Value::String(text)),
    }
}

fn build_codex_response(entry: &PendingEntry, request: &SubmitRequest) -> Result<Value, String> {
    let id = entry
        .request_id
        .clone()
        .ok_or_else(|| "desktop_pet_e_agent_request_id_missing".to_string())?;
    let method = entry.method.as_deref().unwrap_or_default();
    let result = match method {
        "item/tool/requestUserInput" | "tool/requestUserInput" => {
            let mut answers = Map::new();
            for answer in &request.answers {
                let mut values = answer.values.clone();
                if let Some(custom) = answer.custom_value.as_deref().and_then(non_empty_text) {
                    values.push(custom);
                }
                answers.insert(answer.question_id.clone(), json!({ "answers": values }));
            }
            json!({ "answers": answers })
        }
        "item/commandExecution/requestApproval" => {
            json!({ "decision": codex_command_decision(entry, request)? })
        }
        "item/fileChange/requestApproval" => {
            json!({ "decision": codex_decision(request.approval_value.as_deref(), false) })
        }
        "item/permissions/requestApproval" => {
            let approval = request.approval_value.as_deref().unwrap_or("deny");
            if approval_allows(approval) {
                let permissions = entry
                    .hook_input
                    .get("params")
                    .and_then(|value| value.get("permissions"))
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                json!({
                    "permissions": permissions,
                    "scope": if approval == "allow-session" { "session" } else { "turn" },
                })
            } else {
                json!({ "permissions": {}, "scope": "turn" })
            }
        }
        "mcpServer/elicitation/request" => {
            let mut content = Map::new();
            for answer in &request.answers {
                let is_empty = answer.values.is_empty()
                    && answer.custom_value.as_deref().and_then(non_empty_text).is_none();
                if is_empty && !mcp_schema_property_required(&entry.hook_input, &answer.question_id) {
                    continue;
                }
                content.insert(
                    answer.question_id.clone(),
                    mcp_answer_value(&entry.hook_input, answer)?,
                );
            }
            json!({ "action": "accept", "content": content, "_meta": Value::Null })
        }
        "applyPatchApproval" | "execCommandApproval" => {
            let approval = request.approval_value.as_deref().unwrap_or("deny");
            json!({
                "decision": if approval == "allow-session" {
                    "approvedForSession"
                } else if approval_allows(approval) {
                    "approved"
                } else if approval == "cancel" {
                    "abort"
                } else {
                    "denied"
                }
            })
        }
        _ => return Err("desktop_pet_e_agent_request_unsupported".to_string()),
    };
    Ok(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn codex_command_decision(
    entry: &PendingEntry,
    request: &SubmitRequest,
) -> Result<Value, String> {
    let approval = request
        .approval_value
        .as_deref()
        .and_then(non_empty_text)
        .ok_or_else(|| "desktop_pet_e_agent_approval_missing".to_string())?;
    if let Some(index) = approval
        .strip_prefix("native:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let decision = entry
            .hook_input
            .get("params")
            .and_then(|value| value.get("availableDecisions"))
            .and_then(Value::as_array)
            .and_then(|decisions| decisions.get(index))
            .filter(|decision| is_supported_codex_native_command_decision(decision))
            .cloned()
            .ok_or_else(|| "desktop_pet_e_agent_approval_invalid".to_string())?;
        return Ok(decision);
    }
    Ok(Value::String(codex_decision(Some(&approval), false).to_string()))
}

fn codex_decision(value: Option<&str>, legacy: bool) -> &'static str {
    match value.unwrap_or("deny") {
        "allow-session" => if legacy { "approvedForSession" } else { "acceptForSession" },
        "allow" => if legacy { "approved" } else { "accept" },
        "cancel" => if legacy { "abort" } else { "cancel" },
        _ => if legacy { "denied" } else { "decline" },
    }
}

fn approval_allows(value: &str) -> bool {
    matches!(value, "allow" | "allow-session" | "accept" | "acceptForSession" | "approved" | "approvedForSession")
}

fn set_action_unavailable(action: &mut Value, reason: &str) {
    let Some(object) = action.as_object_mut() else {
        return;
    };
    object.insert("adapterMode".to_string(), Value::String("jump-only".to_string()));
    object.insert("adapterReason".to_string(), Value::String(reason.to_string()));
    object.insert("submitting".to_string(), Value::Bool(false));
    object.insert("error".to_string(), Value::String(reason.to_string()));
}

fn set_action_status(action: &mut Value, submitting: bool, error: Option<&str>) {
    let Some(object) = action.as_object_mut() else {
        return;
    };
    object.insert("submitting".to_string(), Value::Bool(submitting));
    object.insert(
        "error".to_string(),
        error.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
    );
}

fn pending_transport_action_id(entry: &PendingEntry) -> Option<&str> {
    match &entry.state {
        PendingState::Submitted {
            transport_action_id,
            ..
        } => Some(transport_action_id),
        PendingState::Waiting => None,
    }
}

fn action_adapter_mode(action: &Value) -> Option<&str> {
    action.get("adapterMode").and_then(Value::as_str)
}

fn agent_broker_epoch() -> &'static str {
    static EPOCH: OnceLock<String> = OnceLock::new();
    EPOCH.get_or_init(|| Uuid::new_v4().to_string()).as_str()
}

fn agent_event(
    phase: &str,
    entry: &PendingEntry,
    transport_action_id: Option<&str>,
    error: Option<&str>,
) -> Value {
    json!({
        DESKTOP_PET_E_AGENT_MARKER: {
            "brokerEpoch": agent_broker_epoch(),
            "phase": phase,
            "sessionId": entry.session_id,
            "source": entry.source,
            "pendingActionId": entry.pending_action_id,
            "transportActionId": transport_action_id,
            "pendingAction": entry.action,
            "error": error,
        }
    })
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .and_then(non_empty_text)
    })
}

fn non_empty_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn json_response(status: &'static str, value: Value) -> DesktopPetEAgentHttpResponse {
    let body = serde_json::to_vec(&value)
        .unwrap_or_else(|_| br#"{"status":"error","error":"desktop_pet_e_agent_serialize_failed"}"#.to_vec());
    DesktopPetEAgentHttpResponse { status, body }
}

fn error_response(status: &'static str, error: &str) -> DesktopPetEAgentHttpResponse {
    json_response(status, json!({ "status": "error", "error": error }))
}

pub(crate) fn post_desktop_pet_e_agent_json(
    port: u16,
    token: &str,
    path: &str,
    payload: &Value,
    read_timeout: Duration,
) -> Result<Value, String> {
    if port == 0 || token.trim().is_empty() || !DesktopPetEAgentBroker::is_agent_path(path) {
        return Err("desktop_pet_e_agent_target_invalid".to_string());
    }
    let body = serde_json::to_vec(payload)
        .map_err(|_| "desktop_pet_e_agent_serialize_failed".to_string())?;
    if body.len() > DESKTOP_PET_E_AGENT_MAX_BODY_BYTES {
        return Err("desktop_pet_e_agent_body_too_large".to_string());
    }
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|_| "desktop_pet_e_agent_connect_failed".to_string())?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(read_timeout));
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .and_then(|_| stream.flush())
        .map_err(|_| "desktop_pet_e_agent_write_failed".to_string())?;

    let mut response = Vec::new();
    stream
        .take((MAX_HTTP_RESPONSE_BYTES + 16 * 1024 + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|_| "desktop_pet_e_agent_read_failed".to_string())?;
    if response.len() > MAX_HTTP_RESPONSE_BYTES + 16 * 1024 {
        return Err("desktop_pet_e_agent_response_too_large".to_string());
    }
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "desktop_pet_e_agent_response_invalid".to_string())?;
    let header = std::str::from_utf8(&response[..header_end])
        .map_err(|_| "desktop_pet_e_agent_response_invalid".to_string())?;
    let status_line = header.lines().next().unwrap_or_default();
    if !status_line.starts_with("HTTP/1.1 2") && !status_line.starts_with("HTTP/1.0 2") {
        return Err("desktop_pet_e_agent_response_rejected".to_string());
    }
    let body = &response[header_end + 4..];
    if body.is_empty() {
        return Ok(json!({ "status": "accepted" }));
    }
    serde_json::from_slice(body).map_err(|_| "desktop_pet_e_agent_response_invalid".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_request(protocol: &str, source: &str, event: &str, hook_input: Value) -> OpenRequest {
        OpenRequest {
            source: source.to_string(),
            event: event.to_string(),
            protocol: protocol.to_string(),
            tab_id: "tab-1".to_string(),
            agent_session_id: Some("agent-1".to_string()),
            tool_use_id: Some("tool-1".to_string()),
            tool_name: Some("AskUserQuestion".to_string()),
            request_id: Some(json!(11)),
            method: None,
            hook_input,
        }
    }

    #[test]
    fn claude_question_is_interactive_only_with_an_active_lease() {
        let broker = DesktopPetEAgentBroker::new();
        let request = open_request(
            "claude-hook",
            "claude",
            "PermissionRequest",
            json!({
                "tool_input": {
                    "questions": [{
                        "question": "Choose",
                        "header": "Choice",
                        "multiSelect": false,
                        "options": [{ "label": "A", "description": "First" }]
                    }]
                }
            }),
        );
        let unavailable = broker.open(request).unwrap();
        assert_eq!(unavailable["status"], "unavailable");

        broker
            .set_available(AvailabilityRequest {
                instance_id: "frontend-1".to_string(),
                available: true,
                accept_new: true,
            })
            .unwrap();
        let mut retry = open_request(
            "claude-hook",
            "claude",
            "PermissionRequest",
            json!({
                "tool_input": {
                    "questions": [{
                        "question": "Choose again",
                        "options": [{ "label": "A" }]
                    }]
                }
            }),
        );
        retry.tool_use_id = Some("tool-2".to_string());
        let opened = broker.open(retry).unwrap();
        assert_eq!(opened["status"], "pending");
        assert_eq!(opened["pendingAction"]["adapterMode"], "interactive");
    }

    #[test]
    fn draining_lease_finishes_existing_actions_without_accepting_new_ones() {
        let broker = DesktopPetEAgentBroker::new();
        broker
            .set_available(AvailabilityRequest {
                instance_id: "frontend-1".to_string(),
                available: true,
                accept_new: true,
            })
            .unwrap();
        let first_request = open_request(
            "claude-hook",
            "claude",
            "PermissionRequest",
            json!({
                "tool_input": {
                    "questions": [{
                        "question": "First",
                        "options": [{ "label": "A" }]
                    }]
                }
            }),
        );
        let first = broker.open(first_request).unwrap();
        let first_id = first["pendingActionId"].as_str().unwrap().to_string();

        broker
            .set_available(AvailabilityRequest {
                instance_id: "frontend-1".to_string(),
                available: true,
                accept_new: false,
            })
            .unwrap();
        let duplicate = broker
            .open(open_request(
                "claude-hook",
                "claude",
                "PermissionRequest",
                json!({
                    "tool_input": {
                        "questions": [{
                            "question": "First",
                            "options": [{ "label": "A" }]
                        }]
                    }
                }),
            ))
            .unwrap();
        assert_eq!(duplicate["pendingActionId"], first_id);
        assert_eq!(duplicate["status"], "pending");

        let mut second_request = open_request(
            "claude-hook",
            "claude",
            "PermissionRequest",
            json!({
                "tool_input": {
                    "questions": [{
                        "question": "Second",
                        "options": [{ "label": "B" }]
                    }]
                }
            }),
        );
        second_request.tool_use_id = Some("tool-2".to_string());
        second_request.request_id = Some(json!(12));
        let second = broker.open(second_request).unwrap();
        assert_eq!(second["status"], "unavailable");

        let state = broker.shared.0.lock().unwrap();
        assert_eq!(state.pending.len(), 1);
        assert!(state.pending.contains_key(&first_id));
        drop(state);
        assert_eq!(
            broker
                .poll(PollRequest {
                    pending_action_id: first_id,
                    wait_ms: Some(1),
                })
                .unwrap()["status"],
            "pending"
        );
    }

    #[test]
    fn claude_question_permission_request_replaces_notification_preview() {
        let broker = DesktopPetEAgentBroker::new();
        broker
            .set_available(AvailabilityRequest {
                instance_id: "frontend-1".to_string(),
                available: true,
                accept_new: true,
            })
            .unwrap();
        let preview = broker
            .open(open_request(
                "notification-only",
                "claude",
                "Notification",
                json!({
                    "tool_input": {
                        "questions": [{
                            "question": "Choose",
                            "options": [{ "label": "A" }]
                        }]
                    }
                }),
            ))
            .unwrap();
        assert_eq!(preview["status"], "unavailable");
        let preview_id = preview["pendingActionId"].as_str().unwrap().to_string();

        let interactive = broker
            .open(open_request(
                "claude-hook",
                "claude",
                "PermissionRequest",
                json!({
                    "tool_input": {
                        "questions": [{
                            "question": "Choose",
                            "options": [{ "label": "A" }]
                        }]
                    }
                }),
            ))
            .unwrap();
        assert_eq!(interactive["status"], "pending");
        assert_eq!(interactive["pendingAction"]["adapterMode"], "interactive");
        let interactive_id = interactive["pendingActionId"].as_str().unwrap();
        assert_ne!(interactive_id, preview_id);

        let state = broker.shared.0.lock().unwrap();
        assert_eq!(state.pending.len(), 1);
        assert!(!state.pending.contains_key(&preview_id));
        assert!(state.pending.contains_key(interactive_id));
    }

    #[test]
    fn a_new_request_never_replaces_a_submitted_response_before_ack() {
        let broker = DesktopPetEAgentBroker::new();
        broker
            .set_available(AvailabilityRequest {
                instance_id: "frontend-1".to_string(),
                available: true,
                accept_new: true,
            })
            .unwrap();
        let first = broker
            .open(open_request(
                "claude-hook",
                "claude",
                "PermissionRequest",
                json!({
                    "tool_input": {
                        "questions": [{
                            "question": "First",
                            "options": [{ "label": "A" }]
                        }]
                    }
                }),
            ))
            .unwrap();
        let first_id = first["pendingActionId"].as_str().unwrap().to_string();
        broker
            .submit(SubmitRequest {
                pending_action_id: first_id.clone(),
                transport_action_id: "transport-1".to_string(),
                answers: vec![DesktopPetEAgentAnswer {
                    question_id: "0".to_string(),
                    values: vec!["A".to_string()],
                    custom_value: None,
                }],
                approval_value: None,
            })
            .unwrap();

        let mut second_request = open_request(
            "claude-hook",
            "claude",
            "PermissionRequest",
            json!({
                "tool_input": {
                    "questions": [{
                        "question": "Second",
                        "options": [{ "label": "B" }]
                    }]
                }
            }),
        );
        second_request.tool_use_id = Some("tool-2".to_string());
        second_request.request_id = Some(json!(12));
        let second = broker.open(second_request).unwrap();
        let second_id = second["pendingActionId"].as_str().unwrap();

        let state = broker.shared.0.lock().unwrap();
        assert_eq!(state.pending.len(), 2);
        assert!(matches!(
            state.pending.get(&first_id).map(|entry| &entry.state),
            Some(PendingState::Submitted { .. })
        ));
        assert!(state.pending.contains_key(second_id));
        drop(state);
        assert_eq!(
            broker
                .poll(PollRequest {
                    pending_action_id: first_id,
                    wait_ms: Some(1),
                })
                .unwrap()["status"],
            "resolved"
        );
    }

    #[test]
    fn codex_user_input_response_keeps_the_native_request_id() {
        let mut entry = PendingEntry {
            request_key: "key".to_string(),
            pending_action_id: "pending".to_string(),
            session_id: "tab".to_string(),
            source: "codex".to_string(),
            protocol: "codex-app-server".to_string(),
            method: Some("item/tool/requestUserInput".to_string()),
            request_id: Some(json!(27)),
            hook_input: json!({}),
            action: json!({ "kind": "question" }),
            state: PendingState::Waiting,
            created_at: Instant::now(),
            expires_at: Instant::now() + PENDING_ACTION_TTL,
        };
        let request = SubmitRequest {
            pending_action_id: "pending".to_string(),
            transport_action_id: "transport".to_string(),
            answers: vec![DesktopPetEAgentAnswer {
                question_id: "choice".to_string(),
                values: vec!["A".to_string()],
                custom_value: None,
            }],
            approval_value: None,
        };
        let response = build_codex_response(&entry, &request).unwrap();
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], 27);
        assert_eq!(response["result"]["answers"]["choice"]["answers"][0], "A");
        entry.state = PendingState::Submitted {
            transport_action_id: "transport".to_string(),
            response,
        };
        assert!(matches!(entry.state, PendingState::Submitted { .. }));
    }

    #[test]
    fn completed_submission_is_idempotent_for_the_same_transport_action() {
        let broker = DesktopPetEAgentBroker::new();
        broker
            .set_available(AvailabilityRequest {
                instance_id: "frontend-1".to_string(),
                available: true,
                accept_new: true,
            })
            .unwrap();
        let opened = broker
            .open(open_request(
                "claude-hook",
                "claude",
                "PermissionRequest",
                json!({
                    "tool_input": {
                        "questions": [{
                            "question": "Choose",
                            "options": [{ "label": "A" }]
                        }]
                    }
                }),
            ))
            .unwrap();
        let pending_action_id = opened["pendingActionId"].as_str().unwrap().to_string();
        let submission = SubmitRequest {
            pending_action_id: pending_action_id.clone(),
            transport_action_id: "transport-1".to_string(),
            answers: vec![DesktopPetEAgentAnswer {
                question_id: "0".to_string(),
                values: vec!["A".to_string()],
                custom_value: None,
            }],
            approval_value: None,
        };
        assert_eq!(broker.submit(submission).unwrap()["status"], "accepted");
        broker
            .ack(AckRequest {
                pending_action_id: pending_action_id.clone(),
                transport_action_id: Some("transport-1".to_string()),
                success: true,
                error: None,
            })
            .unwrap();
        let duplicate = broker
            .submit(SubmitRequest {
                pending_action_id,
                transport_action_id: "transport-1".to_string(),
                answers: Vec::new(),
                approval_value: None,
            })
            .unwrap();
        assert_eq!(duplicate["status"], "accepted");
    }

    #[test]
    fn codex_user_input_accepts_null_options_for_free_text() {
        let mut request = open_request(
            "codex-app-server",
            "codex",
            "PermissionRequest",
            json!({
                "params": {
                    "questions": [{
                        "id": "details",
                        "header": "Details",
                        "question": "Explain",
                        "isOther": true,
                        "isSecret": false,
                        "options": null
                    }]
                }
            }),
        );
        request.method = Some("tool/requestUserInput".to_string());
        request.tool_name = Some("request_user_input".to_string());
        let blueprint = action_blueprint(&request);
        assert!(blueprint.interactive_supported);
        assert_eq!(blueprint.kind, "question");
        assert_eq!(blueprint.questions[0]["mode"], "text");
        assert_eq!(blueprint.questions[0]["allowOther"], true);
    }

    #[test]
    fn request_keys_are_scoped_to_the_agent_session() {
        let first = open_request("codex-app-server", "codex", "PermissionRequest", json!({}));
        let mut second = open_request("codex-app-server", "codex", "PermissionRequest", json!({}));
        second.agent_session_id = Some("agent-2".to_string());
        assert_ne!(request_key(&first), request_key(&second));
    }

    #[test]
    fn codex_available_decisions_preserve_native_amendments() {
        let hook_input = json!({
            "params": {
                "availableDecisions": [
                    {
                        "acceptWithExecpolicyAmendment": {
                            "execpolicy_amendment": {
                                "command": ["git", "status"]
                            }
                        }
                    },
                    "decline"
                ]
            }
        });
        let choices = codex_approval_choices(
            "item/commandExecution/requestApproval",
            &hook_input,
        );
        assert_eq!(choices.len(), 2);
        assert_eq!(choices[0]["value"], "native:0");
        assert_eq!(choices[1]["value"], "deny");
        assert!(!choices.iter().any(|choice| choice["value"] == "allow-session"));

        let entry = PendingEntry {
            request_key: "key".to_string(),
            pending_action_id: "pending".to_string(),
            session_id: "tab".to_string(),
            source: "codex".to_string(),
            protocol: "codex-app-server".to_string(),
            method: Some("item/commandExecution/requestApproval".to_string()),
            request_id: Some(json!(29)),
            hook_input,
            action: json!({ "kind": "approval", "approvalChoices": choices }),
            state: PendingState::Waiting,
            created_at: Instant::now(),
            expires_at: Instant::now() + PENDING_ACTION_TTL,
        };
        let request = SubmitRequest {
            pending_action_id: "pending".to_string(),
            transport_action_id: "transport".to_string(),
            answers: Vec::new(),
            approval_value: Some("native:0".to_string()),
        };
        let response = build_codex_response(&entry, &request).unwrap();
        assert_eq!(
            response["result"]["decision"],
            entry.hook_input["params"]["availableDecisions"][0]
        );
    }

    #[test]
    fn mcp_elicitation_rejects_unknown_modes_and_preserves_option_titles() {
        let mut request = open_request(
            "codex-app-server",
            "codex",
            "PermissionRequest",
            json!({
                "params": {
                    "mode": "future-mode",
                    "requestedSchema": {
                        "type": "object",
                        "properties": {
                            "choice": { "type": "string", "enum": ["a"] }
                        }
                    }
                }
            }),
        );
        request.method = Some("mcpServer/elicitation/request".to_string());
        let unsupported = action_blueprint(&request);
        assert!(!unsupported.interactive_supported);

        let legacy = mcp_options(&json!({
            "type": "string",
            "enum": ["a", "b"],
            "enumNames": ["Option A", "Option B"]
        }))
        .unwrap();
        assert_eq!(legacy[0]["label"], "Option A");
        assert_eq!(legacy[1]["value"], "b");

        let titled_array = mcp_options(&json!({
            "type": "array",
            "items": {
                "oneOf": [
                    { "const": "a", "title": "Option A" },
                    { "const": "b", "title": "Option B" }
                ]
            }
        }))
        .unwrap();
        assert_eq!(titled_array[1]["label"], "Option B");
    }

    #[test]
    fn mcp_optional_fields_can_be_omitted() {
        let hook_input = json!({
            "params": {
                "mode": "form",
                "requestedSchema": {
                    "type": "object",
                    "properties": {
                        "requiredField": { "type": "string", "title": "Required" },
                        "optionalField": { "type": "string", "title": "Optional" }
                    },
                    "required": ["requiredField"]
                }
            }
        });
        let questions = mcp_questions(&hook_input);
        let required = questions
            .iter()
            .find(|question| question["id"] == "requiredField")
            .unwrap();
        let optional = questions
            .iter()
            .find(|question| question["id"] == "optionalField")
            .unwrap();
        assert_eq!(required["required"], true);
        assert_eq!(optional["required"], false);
        let action = json!({ "kind": "questionnaire", "questions": questions });
        let request = SubmitRequest {
            pending_action_id: "pending".to_string(),
            transport_action_id: "transport".to_string(),
            answers: vec![
                DesktopPetEAgentAnswer {
                    question_id: "requiredField".to_string(),
                    values: Vec::new(),
                    custom_value: Some("value".to_string()),
                },
                DesktopPetEAgentAnswer {
                    question_id: "optionalField".to_string(),
                    values: Vec::new(),
                    custom_value: None,
                },
            ],
            approval_value: None,
        };
        validate_submission(&action, &request).unwrap();
        let entry = PendingEntry {
            request_key: "key".to_string(),
            pending_action_id: "pending".to_string(),
            session_id: "tab".to_string(),
            source: "codex".to_string(),
            protocol: "codex-app-server".to_string(),
            method: Some("mcpServer/elicitation/request".to_string()),
            request_id: Some(json!(28)),
            hook_input,
            action,
            state: PendingState::Waiting,
            created_at: Instant::now(),
            expires_at: Instant::now() + PENDING_ACTION_TTL,
        };
        let response = build_codex_response(&entry, &request).unwrap();
        assert_eq!(response["result"]["content"]["requiredField"], "value");
        assert!(response["result"]["content"].get("optionalField").is_none());
    }

    #[test]
    fn stop_does_not_cancel_a_submitted_action_before_ack() {
        let broker = DesktopPetEAgentBroker::new();
        broker
            .set_available(AvailabilityRequest {
                instance_id: "frontend-1".to_string(),
                available: true,
                accept_new: true,
            })
            .unwrap();
        let opened = broker
            .open(open_request(
                "claude-hook",
                "claude",
                "PermissionRequest",
                json!({
                    "tool_input": {
                        "questions": [{
                            "question": "Choose",
                            "options": [{ "label": "A" }]
                        }]
                    }
                }),
            ))
            .unwrap();
        let pending_action_id = opened["pendingActionId"].as_str().unwrap().to_string();
        broker
            .submit(SubmitRequest {
                pending_action_id: pending_action_id.clone(),
                transport_action_id: "transport-1".to_string(),
                answers: vec![DesktopPetEAgentAnswer {
                    question_id: "0".to_string(),
                    values: vec!["A".to_string()],
                    custom_value: None,
                }],
                approval_value: None,
            })
            .unwrap();
        broker.observe_hook(&json!({ "event": "Stop", "tabId": "tab-1" }));
        broker
            .ack(AckRequest {
                pending_action_id,
                transport_action_id: Some("transport-1".to_string()),
                success: true,
                error: None,
            })
            .unwrap();
    }

    #[test]
    fn malformed_claude_question_never_becomes_an_approval() {
        let broker = DesktopPetEAgentBroker::new();
        broker
            .set_available(AvailabilityRequest {
                instance_id: "frontend-1".to_string(),
                available: true,
                accept_new: true,
            })
            .unwrap();
        let opened = broker
            .open(open_request(
                "claude-hook",
                "claude",
                "PermissionRequest",
                json!({ "tool_input": { "questions": [] } }),
            ))
            .unwrap();
        assert_eq!(opened["pendingAction"]["kind"], "question");
        assert_eq!(opened["pendingAction"]["adapterMode"], "jump-only");
        assert!(opened["pendingAction"]["approvalChoices"].is_null());
    }
}
