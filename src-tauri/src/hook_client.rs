// 隐藏子命令 `__hook` 的实现：作为 Claude/Codex/Grok 的 hook 命令被高频调用。
// 取代旧版 PowerShell 脚本，做到 Windows / macOS / Linux 跨平台一致。
//
// 流程：读取回调环境变量（或回退到 daemon 发现文件）+ stdin 事件 JSON，
// 向本地通知服务 POST 一条事件，然后无条件退出。失败只写脱敏诊断日志，绝不打断 CLI。
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::exit;
use std::thread;
use std::time::Duration;

use cli_manager_hook_schema::{non_empty_trimmed, normalize_hook_input};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

const NOTIFY_ATTEMPTS: usize = 2;
const NOTIFY_RETRY_DELAY: Duration = Duration::from_millis(80);
const HOOK_NOTIFY_MAX_BODY_BYTES: usize = 64 * 1024;

/// `main` 在初始化 Tauri runtime 之前调用本函数并退出，因此这里
/// 不依赖任何 Tauri/WebView 状态，冷启动开销极小。
pub fn run_and_exit(source: &str, event: &str) -> ! {
    let result = read_hook_input().and_then(|mut hook_input| {
        if is_interactive_event(source, event, &hook_input) {
            let suppressed = should_suppress_codex_permission_request(source, event, &hook_input);
            let notification_result = if suppressed {
                Ok(())
            } else {
                ensure_desktop_pet_e_request_id(&mut hook_input);
                try_notify_input(source, event, hook_input.clone())
            };
            match try_interactive_decision(source, event, hook_input)? {
                Some(decision) => {
                    let mut output = serde_json::to_vec(&decision.response)
                        .map_err(|_| HookNotifyError::PayloadSerialize)?;
                    output.push(b'\n');
                    let delivered = {
                        let stdout = std::io::stdout();
                        let mut stdout = stdout.lock();
                        stdout
                            .write_all(&output)
                            .and_then(|_| stdout.flush())
                            .is_ok()
                    };
                    acknowledge_desktop_pet_e_agent(&decision, delivered);
                    if !delivered {
                        return Err(HookNotifyError::BridgeWrite);
                    }
                    Ok(())
                }
                None => notification_result,
            }
        } else {
            try_notify_input(source, event, hook_input)
        }
    });
    if let Err(err) = result {
        write_failure_diagnostic(source, event, err.code());
    }
    exit(0);
}

fn read_hook_input() -> Result<Value, HookNotifyError> {
    let mut stdin_raw = String::new();
    std::io::stdin()
        .read_to_string(&mut stdin_raw)
        .map_err(|_| HookNotifyError::StdinRead)?;
    serde_json::from_str(stdin_raw.trim()).map_err(|_| HookNotifyError::InvalidInput)
}

pub(crate) fn try_notify_prepared_payload(payload: &Value) -> bool {
    let Ok(body) = serde_json::to_vec(payload) else {
        return false;
    };
    for attempt in 0..NOTIFY_ATTEMPTS {
        for target in resolve_notify_targets() {
            if post(&target.port, &target.token, &body).is_ok() {
                return true;
            }
        }
        if attempt + 1 < NOTIFY_ATTEMPTS {
            thread::sleep(NOTIFY_RETRY_DELAY);
        }
    }
    false
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum HookNotifyError {
    MissingPort,
    MissingToken,
    StdinRead,
    InvalidInput,
    UnsupportedPayload,
    PayloadSerialize,
    InvalidPort,
    BridgeConnect,
    BridgeWrite,
    BridgeResponse,
}

impl HookNotifyError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::MissingPort => "missing_port",
            Self::MissingToken => "missing_token",
            Self::StdinRead => "stdin_read_failed",
            Self::InvalidInput => "invalid_input",
            Self::UnsupportedPayload => "unsupported_payload",
            Self::PayloadSerialize => "payload_serialize_failed",
            Self::InvalidPort => "invalid_port",
            Self::BridgeConnect => "bridge_connect_failed",
            Self::BridgeWrite => "bridge_write_failed",
            Self::BridgeResponse => "bridge_response_failed",
        }
    }
}

pub(crate) struct InteractiveDecision {
    pub(crate) response: Value,
    pub(crate) pending_action_id: String,
    pub(crate) transport_action_id: String,
}

pub(crate) fn acknowledge_desktop_pet_e_agent(decision: &InteractiveDecision, success: bool) {
    let payload = json!({
        "pendingActionId": decision.pending_action_id,
        "transportActionId": decision.transport_action_id,
        "success": success,
    });
    for attempt in 0..NOTIFY_ATTEMPTS {
        for target in resolve_notify_targets() {
            if post_json(
                &target.port,
                &target.token,
                "/api/desktop-pet-e-agent/ack",
                &payload,
                Duration::from_secs(3),
            )
            .is_ok()
            {
                return;
            }
        }
        if attempt + 1 < NOTIFY_ATTEMPTS {
            thread::sleep(NOTIFY_RETRY_DELAY);
        }
    }
}

fn ensure_desktop_pet_e_request_id(hook_input: &mut Value) {
    let existing = hook_input.get("request_id").or_else(|| hook_input.get("requestId"));
    let valid = match existing {
        Some(Value::Number(_)) => true,
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            !trimmed.is_empty()
                && trimmed.len() <= 512
                && !trimmed.chars().any(|character| matches!(character, '\0' | '\r' | '\n'))
        }
        _ => false,
    };
    if valid {
        return;
    }
    if let Some(object) = hook_input.as_object_mut() {
        object.insert(
            "request_id".to_string(),
            Value::String(Uuid::new_v4().to_string()),
        );
        object.remove("requestId");
    }
}

fn is_interactive_event(source: &str, event: &str, _hook_input: &Value) -> bool {
    event == "PermissionRequest" && matches!(source, "claude" | "codex" | "grok")
}

fn is_question_event(source: &str, event: &str, hook_input: &Value) -> bool {
    if !matches!(event, "PreToolUse" | "Notification") {
        return false;
    }
    let tool_name = hook_input
        .get("tool_name")
        .or_else(|| hook_input.get("toolName"))
        .or_else(|| hook_input.get("tool_input").and_then(|value| value.get("name")))
        .and_then(Value::as_str);
    matches!(
        (source, tool_name),
        ("claude", Some("AskUserQuestion")) | ("codex", Some("request_user_input"))
    )
}

fn cancel_desktop_pet_e_agent(
    target: &NotifyTarget,
    pending_action_id: &str,
    reason: &str,
) {
    let _ = post_json(
        &target.port,
        &target.token,
        "/api/desktop-pet-e-agent/cancel",
        &json!({
            "pendingActionId": pending_action_id,
            "reason": reason,
        }),
        Duration::from_secs(3),
    );
}

pub(crate) fn request_desktop_pet_e_agent(
    open_payload: &Value,
) -> Result<Option<InteractiveDecision>, HookNotifyError> {
    let targets = resolve_notify_targets();
    if targets.is_empty() {
        return Ok(None);
    }
    for target in targets {
        let opened = match post_json(
            &target.port,
            &target.token,
            "/api/desktop-pet-e-agent/open",
            open_payload,
            Duration::from_secs(3),
        ) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let status = opened.get("status").and_then(Value::as_str).unwrap_or_default();
        if status == "resolved" {
            let pending_action_id = opened
                .get("pendingActionId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or(HookNotifyError::BridgeResponse)?;
            let response = opened
                .get("response")
                .cloned()
                .ok_or(HookNotifyError::BridgeResponse)?;
            let transport_action_id = opened
                .get("transportActionId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or(HookNotifyError::BridgeResponse)?;
            return Ok(Some(InteractiveDecision {
                response,
                pending_action_id,
                transport_action_id,
            }));
        }
        let pending_action_id = opened
            .get("pendingActionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or(HookNotifyError::BridgeResponse)?;
        if status != "pending" {
            let pending_action = opened.get("pendingAction");
            let keep_jump_only = pending_action
                .and_then(|action| action.get("adapterMode"))
                .and_then(Value::as_str)
                == Some("jump-only")
                && matches!(
                    pending_action
                        .and_then(|action| action.get("adapterReason"))
                        .and_then(Value::as_str),
                    Some(
                        "desktopPetE.agent.notificationOnly"
                            | "desktopPetE.agent.requestUnsupported"
                            | "desktopPetE.agent.grokJumpOnly"
                    )
                );
            if !keep_jump_only {
                cancel_desktop_pet_e_agent(&target, &pending_action_id, "agent-unavailable");
            }
            return Ok(None);
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(590);
        loop {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .unwrap_or_default();
            if remaining.is_zero() {
                cancel_desktop_pet_e_agent(&target, &pending_action_id, "agent-timeout");
                return Ok(None);
            }
            let poll = match post_json(
                &target.port,
                &target.token,
                "/api/desktop-pet-e-agent/poll",
                &json!({
                    "pendingActionId": pending_action_id,
                    "waitMs": remaining.as_millis().clamp(1, 590_000),
                }),
                remaining + Duration::from_secs(2),
            ) {
                Ok(value) => value,
                Err(error) => {
                    cancel_desktop_pet_e_agent(
                        &target,
                        &pending_action_id,
                        "agent-poll-failed",
                    );
                    return Err(error);
                }
            };
            match poll.get("status").and_then(Value::as_str).unwrap_or_default() {
                "resolved" => {
                    let response = poll
                        .get("response")
                        .cloned()
                        .ok_or(HookNotifyError::BridgeResponse)?;
                    let transport_action_id = poll
                        .get("transportActionId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .ok_or(HookNotifyError::BridgeResponse)?;
                    return Ok(Some(InteractiveDecision {
                        response,
                        pending_action_id,
                        transport_action_id,
                    }));
                }
                "pending" => continue,
                "cancelled" | "expired" | "unavailable" => return Ok(None),
                _ => {
                    cancel_desktop_pet_e_agent(
                        &target,
                        &pending_action_id,
                        "agent-response-invalid",
                    );
                    return Err(HookNotifyError::BridgeResponse);
                }
            }
        }
    }
    Ok(None)
}

fn try_interactive_decision(
    source: &str,
    event: &str,
    mut hook_input: Value,
) -> Result<Option<InteractiveDecision>, HookNotifyError> {
    if should_suppress_codex_permission_request(source, event, &hook_input) {
        return Ok(None);
    }
    if source == "grok" {
        return Ok(None);
    }
    let request_id = hook_input
        .get("request_id")
        .or_else(|| hook_input.get("requestId"))
        .cloned()
        .or_else(|| {
            let value = Value::String(Uuid::new_v4().to_string());
            hook_input
                .as_object_mut()
                .map(|object| object.insert("request_id".to_string(), value.clone()));
            Some(value)
        });
    let normalized =
        normalize_hook_input(event, &hook_input).ok_or(HookNotifyError::UnsupportedPayload)?;
    let tab_id = non_empty_env("CLI_MANAGER_TAB_ID").unwrap_or_else(|| format!("external:{source}"));
    let tab_id = if tab_id.starts_with("external:") {
        normalized
            .session_id
            .as_deref()
            .map(|session| format!("external:{source}:{session}"))
            .unwrap_or(tab_id)
    } else {
        tab_id
    };
    let protocol = if source == "codex" { "codex-hook" } else { "claude-hook" };
    let open_payload = json!({
        "source": source,
        "event": event,
        "protocol": protocol,
        "tabId": tab_id,
        "agentSessionId": normalized.session_id,
        "toolUseId": normalized.tool_use_id,
        "toolName": normalized.tool_name,
        "requestId": request_id,
        "hookInput": hook_input.clone(),
    });
    request_desktop_pet_e_agent(&open_payload)
}

fn try_notify_input(source: &str, event: &str, hook_input: Value) -> Result<(), HookNotifyError> {
    if should_suppress_codex_permission_request(source, event, &hook_input) {
        return Ok(());
    }
    let tab_id =
        non_empty_env("CLI_MANAGER_TAB_ID").unwrap_or_else(|| format!("external:{source}"));
    let normalized =
        normalize_hook_input(event, &hook_input).ok_or(HookNotifyError::UnsupportedPayload)?;
    // Prefer explicit env tab id; if external, include session id for uniqueness.
    let tab_id = if tab_id.starts_with("external:") {
        normalized
            .session_id
            .as_deref()
            .map(|session| format!("external:{source}:{session}"))
            .unwrap_or(tab_id)
    } else {
        tab_id
    };

    let reasoning_effort = normalized
        .reasoning_effort
        .or_else(|| non_empty_env("CLAUDE_EFFORT").and_then(|value| non_empty_trimmed(&value)));
    let wsl_distro_name = non_empty_env("WSL_DISTRO_NAME");
    let cwd = env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string());

    // 字段名为 camelCase，对应 claude_hook::ClaudeHookRequest 的 serde(rename_all = "camelCase")。
    let mut payload = json!({
        "tabId": tab_id,
        "source": source,
        "event": event,
        "title": title_for(source, event),
        "message": normalized.message,
        "sessionId": normalized.session_id,
        "cwd": cwd,
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "agentId": normalized.agent_id,
        "toolUseId": normalized.tool_use_id,
        "toolName": normalized.tool_name,
        "mcpServer": normalized.mcp_server,
        "skillName": normalized.skill_name,
        "agentType": normalized.agent_type,
        "agentTranscriptPath": normalized.agent_transcript_path,
        "transcriptPath": normalized.transcript_path,
        "reasoningEffort": reasoning_effort,
        "wslDistroName": wsl_distro_name,
        // 同一次 Hook 进程内的重试复用该 ID，daemon 可幂等去重。
        "remoteEventId": Uuid::new_v4().to_string(),
    });
    if is_interactive_event(source, event, &hook_input)
        || is_question_event(source, event, &hook_input)
    {
        if let Some(object) = payload.as_object_mut() {
            object.insert("hookInput".to_string(), hook_input.clone());
        }
    }
    let mut body = serde_json::to_vec(&payload).map_err(|_| HookNotifyError::PayloadSerialize)?;
    if body.len() > HOOK_NOTIFY_MAX_BODY_BYTES {
        if let Some(object) = payload.as_object_mut() {
            object.remove("hookInput");
        }
        body = serde_json::to_vec(&payload).map_err(|_| HookNotifyError::PayloadSerialize)?;
    }
    if body.len() > HOOK_NOTIFY_MAX_BODY_BYTES {
        return Err(HookNotifyError::PayloadSerialize);
    }

    let mut last_error = if non_empty_env("CLI_MANAGER_NOTIFY_PORT").is_some() {
        HookNotifyError::MissingToken
    } else {
        HookNotifyError::MissingPort
    };
    for attempt in 0..NOTIFY_ATTEMPTS {
        let targets = resolve_notify_targets();
        for target in targets {
            match post(&target.port, &target.token, &body) {
                Ok(()) => return Ok(()),
                Err(error) => last_error = error,
            }
        }
        if attempt + 1 < NOTIFY_ATTEMPTS {
            thread::sleep(NOTIFY_RETRY_DELAY);
        }
    }
    Err(last_error)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NotifyTarget {
    port: String,
    token: String,
}

fn resolve_notify_targets() -> Vec<NotifyTarget> {
    let mut targets = Vec::with_capacity(2);
    if let (Some(port), Some(token)) = (
        non_empty_env("CLI_MANAGER_NOTIFY_PORT"),
        non_empty_env("CLI_MANAGER_NOTIFY_TOKEN"),
    ) {
        targets.push(NotifyTarget { port, token });
    }

    // 外部 CLI 没有注入环境；旧终端也可能仍持有重启前的端口，始终补充当前 daemon 发现目标。
    if let Ok(data_dir) = crate::app_paths::cli_manager_data_dir() {
        for name in ["daemon.dev.json", "daemon.json"] {
            if let Some(target) = read_daemon_notify_target(&data_dir.join(name)) {
                if !targets.contains(&target) {
                    targets.push(target);
                }
                break;
            }
        }
    }
    targets
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonInfoLite {
    hook_port: u16,
    token: String,
    #[serde(default)]
    pid: u32,
}

fn read_daemon_notify_target(path: &PathBuf) -> Option<NotifyTarget> {
    let raw = fs::read_to_string(path).ok()?;
    let info: DaemonInfoLite = serde_json::from_str(&raw).ok()?;
    if info.hook_port == 0 || info.token.trim().is_empty() {
        return None;
    }
    if info.pid != 0 && !crate::daemon::discovery::is_pid_alive(info.pid) {
        return None;
    }
    Some(NotifyTarget {
        port: info.hook_port.to_string(),
        token: info.token,
    })
}

fn post(port: &str, token: &str, body: &[u8]) -> Result<(), HookNotifyError> {
    let port: u16 = port.parse().map_err(|_| HookNotifyError::InvalidPort)?;
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).map_err(|_| HookNotifyError::BridgeConnect)?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));

    let head = format!(
        "POST /api/claude-hook HTTP/1.1\r\n\
         Host: 127.0.0.1\r\n\
         Authorization: Bearer {token}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body))
        .and_then(|_| stream.flush())
        .map_err(|_| HookNotifyError::BridgeWrite)?;

    // 读掉响应，确保服务端已接收；只校验 HTTP 成功状态，不记录响应内容。
    let mut sink = [0u8; 256];
    let size = stream
        .read(&mut sink)
        .map_err(|_| HookNotifyError::BridgeResponse)?;
    let response = std::str::from_utf8(&sink[..size]).unwrap_or_default();
    if !response.starts_with("HTTP/1.1 2") && !response.starts_with("HTTP/1.0 2") {
        return Err(HookNotifyError::BridgeResponse);
    }
    Ok(())
}

fn post_json(
    port: &str,
    token: &str,
    path: &str,
    payload: &Value,
    read_timeout: Duration,
) -> Result<Value, HookNotifyError> {
    let port: u16 = port.parse().map_err(|_| HookNotifyError::InvalidPort)?;
    let body = serde_json::to_vec(payload).map_err(|_| HookNotifyError::PayloadSerialize)?;
    if body.len() > 1024 * 1024 {
        return Err(HookNotifyError::PayloadSerialize);
    }
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).map_err(|_| HookNotifyError::BridgeConnect)?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_read_timeout(Some(read_timeout));
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .and_then(|_| stream.flush())
        .map_err(|_| HookNotifyError::BridgeWrite)?;
    let mut response = Vec::new();
    stream
        .take((1024 * 1024 + 16 * 1024 + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|_| HookNotifyError::BridgeResponse)?;
    if response.len() > 1024 * 1024 + 16 * 1024 {
        return Err(HookNotifyError::BridgeResponse);
    }
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or(HookNotifyError::BridgeResponse)?;
    let header = std::str::from_utf8(&response[..header_end])
        .map_err(|_| HookNotifyError::BridgeResponse)?;
    let status_line = header.lines().next().unwrap_or_default();
    if !status_line.starts_with("HTTP/1.1 2") && !status_line.starts_with("HTTP/1.0 2") {
        return Err(HookNotifyError::BridgeResponse);
    }
    let response_body = &response[header_end + 4..];
    if response_body.is_empty() {
        return Ok(json!({ "status": "accepted" }));
    }
    serde_json::from_slice(response_body).map_err(|_| HookNotifyError::BridgeResponse)
}

fn write_failure_diagnostic(source: &str, event: &str, code: &str) {
    let Ok(log_dir) = crate::app_paths::logs_dir() else {
        return;
    };
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let path = log_dir.join("hook-client.log");
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .write(true)
        .open(path)
    else {
        return;
    };
    if file
        .metadata()
        .is_ok_and(|metadata| metadata.len() >= 1024 * 1024)
    {
        let _ = file.set_len(0);
    }
    let line = failure_diagnostic_line(source, event, code);
    let _ = file.write_all(line.as_bytes());
}

fn failure_diagnostic_line(source: &str, event: &str, code: &str) -> String {
    format!(
        "{} source={} event={} error={}\n",
        chrono::Utc::now().to_rfc3339(),
        diagnostic_source(source),
        diagnostic_event(event),
        diagnostic_error(code)
    )
}

fn diagnostic_source(value: &str) -> &'static str {
    match value {
        "claude" => "claude",
        "codex" => "codex",
        "pi" => "pi",
        "grok" => "grok",
        "opencode" => "opencode",
        _ => "unknown",
    }
}

fn diagnostic_event(value: &str) -> &'static str {
    match value {
        "SessionStart" => "SessionStart",
        "UserPromptSubmit" => "UserPromptSubmit",
        "Notification" => "Notification",
        "PreToolUse" => "PreToolUse",
        "PermissionRequest" => "PermissionRequest",
        "Stop" => "Stop",
        "StopFailure" => "StopFailure",
        "SubagentStart" => "SubagentStart",
        "SubagentStop" => "SubagentStop",
        "AgentToolStart" => "AgentToolStart",
        "AgentToolStop" => "AgentToolStop",
        "ToolStart" => "ToolStart",
        "ToolStop" => "ToolStop",
        _ => "unknown",
    }
}

fn diagnostic_error(value: &str) -> &'static str {
    match value {
        "missing_port" => "missing_port",
        "missing_token" => "missing_token",
        "stdin_read_failed" => "stdin_read_failed",
        "invalid_input" => "invalid_input",
        "unsupported_payload" => "unsupported_payload",
        "payload_serialize_failed" => "payload_serialize_failed",
        "invalid_port" => "invalid_port",
        "bridge_connect_failed" => "bridge_connect_failed",
        "bridge_write_failed" => "bridge_write_failed",
        "bridge_response_failed" => "bridge_response_failed",
        _ => "unknown",
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.trim().is_empty())
}

fn should_suppress_codex_permission_request(source: &str, event: &str, hook_input: &Value) -> bool {
    if event != "PermissionRequest" {
        return false;
    }
    match source {
        "codex" => matches!(
            hook_input.get("permission_mode").and_then(Value::as_str),
            Some("dontAsk" | "bypassPermissions")
        ),
        "grok" => {
            hook_input
                .get("permissionMode")
                .or_else(|| hook_input.get("permission_mode"))
                .and_then(Value::as_str)
                == Some("bypassPermissions")
        }
        _ => false,
    }
}
/// 与旧 PowerShell 脚本保持一致的标题文案；前端在缺省时会自行兜底（App.tsx）。
fn title_for(source: &str, event: &str) -> &'static str {
    match (source, event) {
        ("codex", "SessionStart") => "Codex CLI session started",
        ("codex", "UserPromptSubmit") => "Codex CLI running",
        ("codex", "Stop") => "Codex CLI done",
        ("codex", "SubagentStart") => "Codex CLI subagent started",
        ("codex", "SubagentStop") => "Codex CLI subagent done",
        ("codex", _) => "Codex CLI needs attention", // PermissionRequest
        ("pi", "SessionStart") => "Pi Agent session started",
        ("pi", "UserPromptSubmit") => "Pi Agent running",
        ("pi", "Stop") => "Pi Agent done",
        ("pi", _) => "Pi Agent needs attention",
        ("grok", "SessionStart") => "Grok Build session started",
        ("grok", "UserPromptSubmit") => "Grok Build running",
        ("grok", "Stop") => "Grok Build done",
        ("grok", "StopFailure") => "Grok Build failed",
        ("grok", "SubagentStart") => "Grok Build subagent started",
        ("grok", "SubagentStop") => "Grok Build subagent done",
        ("grok", "AgentToolStart") => "Grok Build Agent tool started",
        ("grok", "AgentToolStop") => "Grok Build Agent tool done",
        ("grok", "ToolStart") => "Grok Build tool started",
        ("grok", "ToolStop") => "Grok Build tool done",
        ("grok", _) => "Grok Build needs attention",
        ("opencode", "SessionStart") => "OpenCode session started",
        ("opencode", "UserPromptSubmit") => "OpenCode running",
        ("opencode", "Stop") => "OpenCode done",
        ("opencode", "StopFailure") => "OpenCode failed",
        ("opencode", _) => "OpenCode needs attention",
        (_, "SessionStart") => "Claude Code session started",
        (_, "UserPromptSubmit") => "Claude Code running",
        (_, "Stop") => "Claude Code done",
        (_, "StopFailure") => "Claude Code failed",
        (_, "SubagentStart") => "Claude Code subagent started",
        (_, "SubagentStop") => "Claude Code subagent done",
        (_, "AgentToolStart") => "Claude Code Agent tool started",
        (_, "AgentToolStop") => "Claude Code Agent tool done",
        (_, "ToolStart") => "Claude Code tool started",
        (_, "ToolStop") => "Claude Code tool done",
        (_, _) => "Claude Code needs attention", // Notification
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_desktop_pet_e_request_id,
        failure_diagnostic_line,
        should_suppress_codex_permission_request,
    };
    use serde_json::{json, Value};

    #[test]
    fn extract_reasoning_effort_reads_claude_hook_effort_level() {
        let input = json!({
            "session_id": "abc",
            "effort": { "level": " high " }
        });

        assert_eq!(
            cli_manager_hook_schema::extract_reasoning_effort(&input).as_deref(),
            Some("high")
        );
    }

    #[test]
    fn extract_reasoning_effort_reads_flat_legacy_keys() {
        let input = json!({
            "session_id": "abc",
            "reasoning_effort": "xhigh"
        });

        assert_eq!(
            cli_manager_hook_schema::extract_reasoning_effort(&input).as_deref(),
            Some("xhigh")
        );
    }

    #[test]
    fn extract_mcp_server_reads_claude_tool_name() {
        assert_eq!(
            cli_manager_hook_schema::extract_mcp_server("mcp__exa__web_search_exa").as_deref(),
            Some("exa")
        );
        assert_eq!(cli_manager_hook_schema::extract_mcp_server("Read"), None);
    }

    #[test]
    fn interactive_events_share_one_request_id_with_the_normal_hook_chain() {
        let mut input = json!({ "tool_name": "AskUserQuestion", "requestId": null });
        ensure_desktop_pet_e_request_id(&mut input);
        let request_id = input.get("request_id").and_then(Value::as_str).unwrap();
        assert!(!request_id.is_empty());
        assert!(input.get("requestId").is_none());

        let preserved = request_id.to_string();
        ensure_desktop_pet_e_request_id(&mut input);
        assert_eq!(input.get("request_id").and_then(Value::as_str), Some(preserved.as_str()));
    }

    #[test]
    fn suppresses_codex_permission_request_without_interactive_approval() {
        for permission_mode in ["dontAsk", "bypassPermissions"] {
            let input = json!({ "permission_mode": permission_mode });
            assert!(should_suppress_codex_permission_request(
                "codex",
                "PermissionRequest",
                &input
            ));
        }
    }

    #[test]
    fn preserves_permission_request_for_interactive_or_unknown_modes() {
        for input in [
            json!({ "permission_mode": "default" }),
            json!({ "permission_mode": "acceptEdits" }),
            json!({ "permission_mode": "plan" }),
            json!({}),
        ] {
            assert!(!should_suppress_codex_permission_request(
                "codex",
                "PermissionRequest",
                &input
            ));
        }

        let bypass = json!({ "permission_mode": "bypassPermissions" });
        assert!(!should_suppress_codex_permission_request(
            "claude",
            "PermissionRequest",
            &bypass
        ));
        assert!(!should_suppress_codex_permission_request(
            "codex", "Stop", &bypass
        ));
    }

    #[test]
    fn hook_failure_diagnostic_is_redacted_and_single_line() {
        let line = failure_diagnostic_line(
            "codex\nAuthorization: Bearer secret",
            "SessionStart\nprompt=private",
            "bridge_connect_failed\ntoken=secret",
        );

        assert!(line.contains("source=unknown"));
        assert!(line.contains("event=unknown"));
        assert!(line.contains("error=unknown"));
        assert_eq!(line.lines().count(), 1);
        assert!(!line.contains("Bearer secret"));
        assert!(!line.contains("prompt=private"));
        assert!(!line.contains("token=secret"));
    }

    #[test]
    fn suppresses_only_bypassed_grok_permission_request() {
        assert!(should_suppress_codex_permission_request(
            "grok",
            "PermissionRequest",
            &json!({ "permissionMode": "bypassPermissions" })
        ));
        for input in [
            json!({ "permissionMode": "auto" }),
            json!({ "permissionMode": "default" }),
            json!({}),
        ] {
            assert!(!should_suppress_codex_permission_request(
                "grok",
                "PermissionRequest",
                &input
            ));
        }
    }

    #[test]
    fn opencode_events_never_enter_permission_suppression() {
        for event in ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"] {
            assert!(!should_suppress_codex_permission_request(
                "opencode",
                event,
                &json!({})
            ));
        }
    }
}
