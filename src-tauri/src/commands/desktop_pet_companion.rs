use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "windows")]
use std::{
    io::{BufRead, BufReader, BufWriter, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};
#[cfg(target_os = "windows")]
use tauri::path::BaseDirectory;
#[cfg(target_os = "windows")]
use uuid::Uuid;

const MAIN_WINDOW_LABEL: &str = "main";
const PROTOCOL_VERSION: u32 = 1;
const MESSAGE_PREFIX: &str = "CLI_MANAGER_DESKTOP_PET ";
const MAX_PROTOCOL_LINE_LENGTH: usize = 1024 * 1024;
const STATUS_EVENT: &str = "desktop-pet-companion-status";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetCompanionGeneration {
    lifecycle_token: String,
    pet_surface_epoch: String,
    bubble_surface_epoch: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetCompanionSyncRequest {
    protocol_version: u32,
    kind: String,
    generation: DesktopPetCompanionGeneration,
    delivery_revision: u64,
    config: Value,
    snapshot: Value,
    pet: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetCompanionActionResultRequest {
    protocol_version: u32,
    kind: String,
    generation: DesktopPetCompanionGeneration,
    request_id: String,
    broker_epoch: String,
    accepted: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetCompanionStatus {
    supported: bool,
    available: bool,
    active: bool,
    protocol_version: u32,
    reason: Option<String>,
}

#[derive(Default)]
struct DesktopPetCompanionInner {
    #[cfg(target_os = "windows")]
    process: Option<DesktopPetCompanionProcess>,
    last_error: Option<String>,
}

#[cfg(target_os = "windows")]
struct DesktopPetCompanionProcess {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    token: String,
    generation: DesktopPetCompanionGeneration,
    delivery_revision: u64,
}

pub struct DesktopPetCompanionState {
    operation: Mutex<()>,
    inner: Mutex<DesktopPetCompanionInner>,
}

impl Default for DesktopPetCompanionState {
    fn default() -> Self {
        Self {
            operation: Mutex::new(()),
            inner: Mutex::new(DesktopPetCompanionInner::default()),
        }
    }
}

impl DesktopPetCompanionState {
    pub fn shutdown(&self) {
        let Ok(_operation) = self.operation.lock() else {
            return;
        };
        #[cfg(target_os = "windows")]
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(process) = inner.process.take() {
                stop_process(process);
            }
        }
    }
}

fn validate_identifier(value: &str, error: &str) -> Result<(), String> {
    let value = value.trim();
    if value.len() < 8 || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(error.to_string());
    }
    Ok(())
}

fn validate_generation(generation: &DesktopPetCompanionGeneration) -> Result<(), String> {
    validate_identifier(
        &generation.lifecycle_token,
        "desktop_pet_companion_lifecycle_invalid",
    )?;
    validate_identifier(
        &generation.pet_surface_epoch,
        "desktop_pet_companion_pet_epoch_invalid",
    )?;
    validate_identifier(
        &generation.bubble_surface_epoch,
        "desktop_pet_companion_bubble_epoch_invalid",
    )
}

fn validate_sync_request(request: &DesktopPetCompanionSyncRequest) -> Result<(), String> {
    if request.protocol_version != PROTOCOL_VERSION || request.kind != "sync" {
        return Err("desktop_pet_companion_protocol_incompatible".to_string());
    }
    if request.delivery_revision == 0 {
        return Err("desktop_pet_companion_revision_invalid".to_string());
    }
    validate_generation(&request.generation)
}

fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("desktop_pet_companion_caller_forbidden".to_string());
    }
    Ok(())
}

fn emit_status(app: &AppHandle, status: &str, reason: Option<String>) {
    let _ = app.emit(
        STATUS_EVENT,
        json!({
            "status": status,
            "protocolVersion": PROTOCOL_VERSION,
            "reason": reason,
        }),
    );
}

fn status_from_state(
    app: &AppHandle,
    state: &DesktopPetCompanionState,
) -> DesktopPetCompanionStatus {
    #[cfg(target_os = "windows")]
    {
        let available = resolve_runtime_paths(app).is_ok();
        let (active, reason) = state
            .inner
            .lock()
            .map(|inner| (inner.process.is_some(), inner.last_error.clone()))
            .unwrap_or_else(|_| {
                (
                    false,
                    Some("desktop_pet_companion_state_unavailable".to_string()),
                )
            });
        return DesktopPetCompanionStatus {
            supported: true,
            available,
            active,
            protocol_version: PROTOCOL_VERSION,
            reason,
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        DesktopPetCompanionStatus {
            supported: false,
            available: false,
            active: false,
            protocol_version: PROTOCOL_VERSION,
            reason: Some("desktop_pet_companion_windows_only".to_string()),
        }
    }
}

#[tauri::command]
pub fn desktop_pet_companion_status(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, DesktopPetCompanionState>,
) -> Result<DesktopPetCompanionStatus, String> {
    require_main_window(&window)?;
    Ok(status_from_state(&app, &state))
}

#[tauri::command]
pub async fn desktop_pet_companion_sync(
    app: AppHandle,
    window: tauri::WebviewWindow,
    request: DesktopPetCompanionSyncRequest,
) -> Result<DesktopPetCompanionStatus, String> {
    require_main_window(&window)?;
    validate_sync_request(&request)?;

    #[cfg(target_os = "windows")]
    {
        let worker_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = worker_app.state::<DesktopPetCompanionState>();
            let _operation = state
                .operation
                .lock()
                .map_err(|_| "desktop_pet_companion_state_unavailable".to_string())?;
            match sync_or_start(&worker_app, &state, &request) {
                Ok(()) => Ok(status_from_state(&worker_app, &state)),
                Err(error) => {
                    record_failure(&state, error.clone());
                    emit_status(&worker_app, "fallback", Some(error));
                    Ok(status_from_state(&worker_app, &state))
                }
            }
        })
        .await
        .map_err(|error| format!("desktop_pet_companion_task_failed: {error}"))?
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = request;
        let state = app.state::<DesktopPetCompanionState>();
        Ok(status_from_state(&app, &state))
    }
}

#[tauri::command]
pub fn desktop_pet_companion_send_action_result(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, DesktopPetCompanionState>,
    request: DesktopPetCompanionActionResultRequest,
) -> Result<(), String> {
    require_main_window(&window)?;
    if request.protocol_version != PROTOCOL_VERSION || request.kind != "actionResult" {
        return Err("desktop_pet_companion_protocol_incompatible".to_string());
    }
    validate_generation(&request.generation)?;
    validate_identifier(
        &request.request_id,
        "desktop_pet_companion_request_id_invalid",
    )?;
    validate_identifier(
        &request.broker_epoch,
        "desktop_pet_companion_broker_epoch_invalid",
    )?;

    #[cfg(target_os = "windows")]
    {
        let _operation = state
            .operation
            .lock()
            .map_err(|_| "desktop_pet_companion_state_unavailable".to_string())?;
        write_action_result(&state, request)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state, request);
        Err("desktop_pet_companion_windows_only".to_string())
    }
}

#[tauri::command]
pub async fn desktop_pet_companion_stop(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<DesktopPetCompanionStatus, String> {
    require_main_window(&window)?;

    #[cfg(target_os = "windows")]
    {
        let worker_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = worker_app.state::<DesktopPetCompanionState>();
            let _operation = state
                .operation
                .lock()
                .map_err(|_| "desktop_pet_companion_state_unavailable".to_string())?;
            if let Ok(mut inner) = state.inner.lock() {
                if let Some(process) = inner.process.take() {
                    stop_process(process);
                }
                inner.last_error = None;
            }
            emit_status(&worker_app, "stopped", None);
            Ok(status_from_state(&worker_app, &state))
        })
        .await
        .map_err(|error| format!("desktop_pet_companion_task_failed: {error}"))?
    }

    #[cfg(not(target_os = "windows"))]
    {
        let state = app.state::<DesktopPetCompanionState>();
        emit_status(&app, "stopped", None);
        Ok(status_from_state(&app, &state))
    }
}

#[cfg(target_os = "windows")]
fn resolve_runtime_paths(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let root = app
        .path()
        .resolve("resources/electron-pet", BaseDirectory::Resource)
        .map_err(|error| format!("desktop_pet_companion_resource_resolve_failed: {error}"))?;
    let executable = root.join("electron.exe");
    let app_dir = root.join("app");
    if !executable.is_file() || !app_dir.join("main.cjs").is_file() {
        return Err("desktop_pet_companion_runtime_missing".to_string());
    }
    Ok((executable, app_dir))
}

#[cfg(target_os = "windows")]
fn sync_or_start(
    app: &AppHandle,
    state: &DesktopPetCompanionState,
    request: &DesktopPetCompanionSyncRequest,
) -> Result<(), String> {
    if sync_running_process(state, request)? {
        return Ok(());
    }
    start_process(app, state, request)
}

#[cfg(target_os = "windows")]
fn sync_running_process(
    state: &DesktopPetCompanionState,
    request: &DesktopPetCompanionSyncRequest,
) -> Result<bool, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_pet_companion_state_unavailable".to_string())?;
    let Some(mut process) = inner.process.take() else {
        return Ok(false);
    };
    if process
        .child
        .try_wait()
        .map_err(|error| format!("desktop_pet_companion_status_failed: {error}"))?
        .is_some()
    {
        inner.last_error = Some("desktop_pet_companion_exited".to_string());
        return Ok(false);
    }
    if request.delivery_revision <= process.delivery_revision {
        inner.process = Some(process);
        return Ok(true);
    }

    process.generation = request.generation.clone();
    process.delivery_revision = request.delivery_revision;
    let token = process.token.clone();
    if let Err(error) = write_protocol_message(&mut process.stdin, request, &token) {
        inner.last_error = Some(error.clone());
        drop(inner);
        stop_process(process);
        return Err(error);
    }
    inner.last_error = None;
    inner.process = Some(process);
    Ok(true)
}

#[cfg(target_os = "windows")]
fn start_process(
    app: &AppHandle,
    state: &DesktopPetCompanionState,
    request: &DesktopPetCompanionSyncRequest,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

    let (executable, app_dir) = resolve_runtime_paths(app)?;
    let token = Uuid::new_v4().to_string();
    let mut command = Command::new(executable);
    command
        .arg(&app_dir)
        .arg(format!("--cli-manager-pet-token={token}"))
        .arg(format!("--cli-manager-pet-parent-pid={}", std::process::id()))
        .current_dir(app_dir.parent().unwrap_or(&app_dir))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("desktop_pet_companion_start_failed: {error}"))?;
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop_pet_companion_stdin_missing".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop_pet_companion_stdout_missing".to_string());
        }
    };
    let mut stdin = BufWriter::new(stdin);
    let (handshake_tx, handshake_rx) = mpsc::sync_channel(8);
    let reader_app = app.clone();
    let reader_token = token.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("desktop-pet-companion-reader".to_string())
        .spawn(move || read_child_messages(reader_app, reader_token, stdout, handshake_tx))
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "desktop_pet_companion_reader_start_failed: {error}"
        ));
    }

    match handshake_rx.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(HandshakeEvent::Hello) => {}
        Ok(HandshakeEvent::Error(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(HandshakeEvent::Ready) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop_pet_companion_ready_before_hello".to_string());
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop_pet_companion_hello_timeout".to_string());
        }
    }

    if let Err(error) = write_protocol_message(&mut stdin, request, &token) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    match handshake_rx.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(HandshakeEvent::Ready) => {}
        Ok(HandshakeEvent::Error(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(HandshakeEvent::Hello) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop_pet_companion_duplicate_hello".to_string());
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop_pet_companion_ready_timeout".to_string());
        }
    }
    if child
        .try_wait()
        .map_err(|error| format!("desktop_pet_companion_status_failed: {error}"))?
        .is_some()
    {
        return Err("desktop_pet_companion_exited_during_start".to_string());
    }

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_pet_companion_state_unavailable".to_string())?;
    inner.last_error = None;
    inner.process = Some(DesktopPetCompanionProcess {
        child,
        stdin,
        token,
        generation: request.generation.clone(),
        delivery_revision: request.delivery_revision,
    });
    drop(inner);
    emit_status(app, "ready", None);
    Ok(())
}

#[cfg(target_os = "windows")]
fn write_protocol_message<T: Serialize>(
    stdin: &mut BufWriter<ChildStdin>,
    message: &T,
    token: &str,
) -> Result<(), String> {
    let mut value = serde_json::to_value(message)
        .map_err(|error| format!("desktop_pet_companion_serialize_failed: {error}"))?;
    value
        .as_object_mut()
        .ok_or_else(|| "desktop_pet_companion_message_invalid".to_string())?
        .insert("token".to_string(), Value::String(token.to_string()));
    let encoded = serde_json::to_string(&value)
        .map_err(|error| format!("desktop_pet_companion_serialize_failed: {error}"))?;
    if encoded.len() > MAX_PROTOCOL_LINE_LENGTH {
        return Err("desktop_pet_companion_message_too_large".to_string());
    }
    stdin
        .write_all(MESSAGE_PREFIX.as_bytes())
        .and_then(|_| stdin.write_all(encoded.as_bytes()))
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("desktop_pet_companion_write_failed: {error}"))
}

#[cfg(target_os = "windows")]
fn write_action_result(
    state: &DesktopPetCompanionState,
    request: DesktopPetCompanionActionResultRequest,
) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_pet_companion_state_unavailable".to_string())?;
    let process = inner
        .process
        .as_mut()
        .ok_or_else(|| "desktop_pet_companion_not_running".to_string())?;
    if process.generation != request.generation {
        return Err("desktop_pet_companion_generation_stale".to_string());
    }
    write_protocol_message(&mut process.stdin, &request, &process.token)
}

#[cfg(target_os = "windows")]
enum HandshakeEvent {
    Hello,
    Ready,
    Error(String),
}

#[cfg(target_os = "windows")]
fn read_child_messages(
    app: AppHandle,
    token: String,
    stdout: std::process::ChildStdout,
    handshake: mpsc::SyncSender<HandshakeEvent>,
) {
    let reader = BufReader::new(stdout);
    let mut failure = "desktop_pet_companion_exited".to_string();
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                failure = format!("desktop_pet_companion_read_failed: {error}");
                break;
            }
        };
        if line.len() > MAX_PROTOCOL_LINE_LENGTH {
            failure = "desktop_pet_companion_message_too_large".to_string();
            let _ = handshake.try_send(HandshakeEvent::Error(failure.clone()));
            break;
        }
        let Some(json_line) = line.strip_prefix(MESSAGE_PREFIX) else {
            continue;
        };
        let Ok(message) = serde_json::from_str::<Value>(json_line) else {
            continue;
        };
        if message.get("token").and_then(Value::as_str) != Some(token.as_str()) {
            continue;
        }
        if message.get("protocolVersion").and_then(Value::as_u64)
            != Some(u64::from(PROTOCOL_VERSION))
        {
            failure = "desktop_pet_companion_protocol_incompatible".to_string();
            let _ = handshake.try_send(HandshakeEvent::Error(failure.clone()));
            break;
        }
        match message.get("kind").and_then(Value::as_str) {
            Some("hello") => {
                let _ = handshake.try_send(HandshakeEvent::Hello);
            }
            Some("ready") => {
                let _ = handshake.try_send(HandshakeEvent::Ready);
            }
            Some("action") => {
                if let Some(action) = message.get("action") {
                    if let Err(error) = forward_action(&app, &token, action) {
                        log::warn!("Desktop pet companion action rejected: {error}");
                    }
                }
            }
            Some("error") => {
                failure = message
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("desktop_pet_companion_runtime_error")
                    .to_string();
                let _ = handshake.try_send(HandshakeEvent::Error(failure.clone()));
                break;
            }
            _ => {}
        }
    }
    mark_process_failed(&app, &token, failure);
}

#[cfg(target_os = "windows")]
fn current_generation(
    app: &AppHandle,
    token: &str,
) -> Result<DesktopPetCompanionGeneration, String> {
    let state = app.state::<DesktopPetCompanionState>();
    let inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_pet_companion_state_unavailable".to_string())?;
    let process = inner
        .process
        .as_ref()
        .filter(|process| process.token == token)
        .ok_or_else(|| "desktop_pet_companion_generation_unavailable".to_string())?;
    Ok(process.generation.clone())
}

#[cfg(target_os = "windows")]
fn forward_action(app: &AppHandle, token: &str, action: &Value) -> Result<(), String> {
    let generation = current_generation(app, token)?;
    let action_type = action
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "desktop_pet_companion_action_invalid".to_string())?;
    let lifecycle_token = action
        .get("lifecycleToken")
        .and_then(Value::as_str)
        .ok_or_else(|| "desktop_pet_companion_action_invalid".to_string())?;
    let surface_epoch = action
        .get("surfaceEpoch")
        .and_then(Value::as_str)
        .ok_or_else(|| "desktop_pet_companion_action_invalid".to_string())?;
    if lifecycle_token != generation.lifecycle_token {
        return Err("desktop_pet_companion_generation_stale".to_string());
    }
    let is_pet = surface_epoch == generation.pet_surface_epoch;
    let is_bubble = surface_epoch == generation.bubble_surface_epoch;
    if !is_pet && !is_bubble {
        return Err("desktop_pet_companion_generation_stale".to_string());
    }

    let emit = |event: &str, payload: Value| {
        app.emit(event, payload)
            .map_err(|error| format!("desktop_pet_companion_action_emit_failed: {error}"))
    };
    match action_type {
        "openTarget" => {
            let session_id = optional_bounded_string(action, "sessionId", 256)?;
            emit(
                "desktop-pet-open-target",
                json!({
                    "lifecycleToken": lifecycle_token,
                    "surfaceEpoch": surface_epoch,
                    "sessionId": session_id,
                    "daemonOnly": action.get("daemonOnly").and_then(Value::as_bool).unwrap_or(false),
                }),
            )
        }
        "openSettings" => emit(
            "desktop-pet-open-settings",
            json!({
                "lifecycleToken": lifecycle_token,
                "surfaceEpoch": surface_epoch,
            }),
        ),
        "positionChanged" if is_pet => emit(
            "desktop-pet-position",
            json!({
                "lifecycleToken": lifecycle_token,
                "petSurfaceEpoch": surface_epoch,
                "x": finite_number_in_range(action, "x", i32::MIN as f64, i32::MAX as f64)?,
                "y": finite_number_in_range(action, "y", i32::MIN as f64, i32::MAX as f64)?,
            }),
        ),
        "sizeChanged" if is_pet => emit(
            "desktop-pet-size-change",
            json!({
                "lifecycleToken": lifecycle_token,
                "petSurfaceEpoch": surface_epoch,
                "x": finite_number_in_range(action, "x", i32::MIN as f64, i32::MAX as f64)?,
                "y": finite_number_in_range(action, "y", i32::MIN as f64, i32::MAX as f64)?,
                "size": finite_number_in_range(action, "size", 40.0, 150.0)?,
            }),
        ),
        "handoffStart" if is_pet => emit(
            "remote-handoff-start-request",
            json!({
                "sessionId": bounded_string(action, "sessionId", 256)?,
                "platform": platform_string(action)?,
            }),
        ),
        "handoffCancel" if is_pet => emit("remote-handoff-cancel-request", json!(null)),
        "decisionResolve" if is_bubble => emit(
            "desktop-pet-decision-resolve",
            json!({
                "lifecycleToken": lifecycle_token,
                "bubbleSurfaceEpoch": surface_epoch,
                "requestId": bounded_string(action, "requestId", 256)?,
                "brokerEpoch": bounded_string(action, "brokerEpoch", 256)?,
                "answer": action.get("answer").cloned().unwrap_or(Value::Null),
            }),
        ),
        "incidentAcknowledge" if is_bubble => emit(
            "desktop-pet-incident-ack",
            json!({
                "lifecycleToken": lifecycle_token,
                "bubbleSurfaceEpoch": surface_epoch,
                "incidentId": bounded_string(action, "incidentId", 512)?,
            }),
        ),
        "hide" if is_pet => emit(
            "desktop-pet-hidden",
            json!({
                "lifecycleToken": lifecycle_token,
                "petSurfaceEpoch": surface_epoch,
            }),
        ),
        "bubbleDismiss" if is_bubble => {
            let completion_id = optional_bounded_string(action, "completionId", 512)?;
            emit(
                "desktop-pet-bubble-empty",
                json!({
                    "lifecycleToken": lifecycle_token,
                    "bubbleSurfaceEpoch": surface_epoch,
                    "completionId": completion_id,
                }),
            )
        }
        _ => Err("desktop_pet_companion_action_forbidden".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn finite_number_in_range(
    action: &Value,
    key: &str,
    minimum: f64,
    maximum: f64,
) -> Result<f64, String> {
    let value = action
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= minimum && *value <= maximum)
        .ok_or_else(|| "desktop_pet_companion_action_invalid".to_string())?;
    Ok(value)
}

#[cfg(target_os = "windows")]
fn optional_bounded_string(
    action: &Value,
    key: &str,
    max_len: usize,
) -> Result<Option<String>, String> {
    match action.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => bounded_string(action, key, max_len).map(Some),
    }
}

#[cfg(target_os = "windows")]
fn bounded_string(action: &Value, key: &str, max_len: usize) -> Result<String, String> {
    let value = action
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= max_len)
        .ok_or_else(|| "desktop_pet_companion_action_invalid".to_string())?;
    Ok(value.to_string())
}

#[cfg(target_os = "windows")]
fn platform_string(action: &Value) -> Result<String, String> {
    let platform = bounded_string(action, "platform", 16)?;
    match platform.as_str() {
        "telegram" | "feishu" | "weixin" | "wecom" => Ok(platform),
        _ => Err("desktop_pet_companion_action_invalid".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn mark_process_failed(app: &AppHandle, token: &str, reason: String) {
    let state = app.state::<DesktopPetCompanionState>();
    let process = state.inner.lock().ok().and_then(|mut inner| {
        if inner.process.as_ref().map(|process| process.token.as_str()) != Some(token) {
            return None;
        }
        inner.last_error = Some(reason.clone());
        inner.process.take()
    });
    if let Some(process) = process {
        stop_process(process);
        emit_status(app, "fallback", Some(reason));
    }
}

#[cfg(target_os = "windows")]
fn record_failure(state: &DesktopPetCompanionState, error: String) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.last_error = Some(error);
    }
}

#[cfg(target_os = "windows")]
fn stop_process(mut process: DesktopPetCompanionProcess) {
    let shutdown = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "shutdown",
        "generation": process.generation.clone(),
    });
    let token = process.token.clone();
    let _ = write_protocol_message(&mut process.stdin, &shutdown, &token);
    for _ in 0..10 {
        match process.child.try_wait() {
            Ok(Some(_)) => return,
            Err(_) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let _ = process.child.kill();
    let _ = process.child.wait();
}
