use crate::desktop_pet_e_bridge::{
    encode_host_message, DesktopPetEInboundMessage, DesktopPetEInboundValidator,
    DesktopPetELineDecoder,
};
use crate::shell_resolver::silent_command;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, Runtime};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use crate::process_job::ChildJob;

const ACTION_EVENT: &str = "desktop-pet-e-action";
const RUNTIME_STATE_EVENT: &str = "desktop-pet-e-runtime-state";
const DIAGNOSTIC_EVENT: &str = "desktop-pet-e-event";
const PET_E_RESOURCE_ROOT: &str = "pet-e";
const READY_TIMEOUT: Duration = Duration::from_secs(5);
const ELECTRON_RUNTIME_RELATIVE_PATH: &str = "pet-e/runtime/electron.exe";
const ELECTRON_ENTRY_RELATIVE_PATH: &str = "pet-e/app/main.js";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetESyncRequest {
    pub enabled: bool,
    pub existing_desktop_pet_enabled: bool,
    pub config: Value,
    pub snapshot: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetEDiagnostic {
    code: String,
    message: String,
    detail: Option<String>,
    occurred_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetERuntimeState {
    enabled: bool,
    running: bool,
    ready: bool,
    generation: u64,
    restart_count: u32,
    last_error: Option<DesktopPetEDiagnostic>,
}

struct ManagedCompanion {
    child: Child,
    stdin: ChildStdin,
    #[cfg(target_os = "windows")]
    job: ChildJob,
    instance_id: String,
    generation: u64,
    expected_exit: bool,
}

struct ManagerState {
    process: Option<ManagedCompanion>,
    enabled: bool,
    ready: bool,
    generation: u64,
    restart_count: u32,
    host_revision: u64,
    latest_config: Option<Value>,
    latest_snapshot: Option<Value>,
    last_error: Option<DesktopPetEDiagnostic>,
    existing_desktop_pet_enabled: bool,
    shutting_down: bool,
}

impl Default for ManagerState {
    fn default() -> Self {
        Self {
            process: None,
            enabled: false,
            ready: false,
            generation: 0,
            restart_count: 0,
            host_revision: 0,
            latest_config: None,
            latest_snapshot: None,
            last_error: None,
            existing_desktop_pet_enabled: false,
            shutting_down: false,
        }
    }
}

#[derive(Clone, Default)]
pub struct DesktopPetEManager {
    state: Arc<Mutex<ManagerState>>,
}

impl DesktopPetEManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn synchronize_existing_desktop_pet(&self, enabled: bool) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "desktop_pet_e_manager_lock_poisoned".to_string())?;
        if enabled && state.enabled {
            return Err("desktop_pet_mutual_exclusion".to_string());
        }
        state.existing_desktop_pet_enabled = enabled;
        Ok(())
    }

    pub fn shutdown<R: Runtime>(&self, app: &AppHandle<R>) {
        if let Ok(mut state) = self.state.lock() {
            state.shutting_down = true;
            state.enabled = false;
            stop_process(&mut state, "cli-manager-exit");
            emit_runtime_state(app, &state);
        }
    }

    fn synchronize<R: Runtime>(
        &self,
        app: AppHandle<R>,
        request: DesktopPetESyncRequest,
    ) -> Result<DesktopPetERuntimeState, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "desktop_pet_e_manager_lock_poisoned".to_string())?;
        state.latest_config = Some(request.config);
        state.latest_snapshot = Some(request.snapshot);
        state.shutting_down = false;

        if request.enabled
            && (request.existing_desktop_pet_enabled || state.existing_desktop_pet_enabled)
        {
            return Err("desktop_pet_e_mutual_exclusion".to_string());
        }
        if !request.enabled {
            state.enabled = false;
            state.restart_count = 0;
            stop_process(&mut state, "disabled");
            emit_runtime_state(&app, &state);
            return Ok(runtime_state(&state));
        }

        state.enabled = true;
        if state.process.is_none() {
            if let Err(first_error) = start_process(self.clone(), app.clone(), &mut state) {
                state.last_error = Some(diagnostic("desktop_pet_e_start_failed", first_error));
                restart_after_failure(self.clone(), app.clone(), &mut state);
            }
        }
        if state.ready {
            if let Err(error) = send_latest_state(&mut state) {
                state.last_error = Some(diagnostic("desktop_pet_e_state_send_failed", error));
                finish_current_process(&mut state);
                restart_after_failure(self.clone(), app.clone(), &mut state);
            }
        }
        emit_runtime_state(&app, &state);
        Ok(runtime_state(&state))
    }

    fn handle_stdout_line<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        generation: u64,
        message: DesktopPetEInboundMessage,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation != generation || state.process.is_none() {
            return;
        }
        match message {
            DesktopPetEInboundMessage::Hello => {}
            DesktopPetEInboundMessage::Ready => {
                state.ready = true;
                state.last_error = None;
                if let Err(error) = send_latest_state(&mut state) {
                    state.last_error = Some(diagnostic("desktop_pet_e_state_send_failed", error));
                    finish_current_process(&mut state);
                    restart_after_failure(self.clone(), app.clone(), &mut state);
                }
                emit_runtime_state(app, &state);
            }
            DesktopPetEInboundMessage::Action(payload) => {
                if payload.get("kind").and_then(Value::as_str) == Some("close-pet") {
                    state.enabled = false;
                    state.restart_count = 0;
                    stop_process(&mut state, "pet-close");
                    emit_runtime_state(app, &state);
                }
                drop(state);
                let _ = app.emit(ACTION_EVENT, payload);
            }
            DesktopPetEInboundMessage::Diagnostic(payload) => {
                drop(state);
                let _ = app.emit(DIAGNOSTIC_EVENT, json!({
                    "type": "diagnostic",
                    "payload": payload,
                }));
            }
        }
    }

    fn handle_ready_timeout<R: Runtime>(&self, app: AppHandle<R>, generation: u64) {
        let should_restart;
        {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.generation != generation || state.ready || state.process.is_none() {
                return;
            }
            finish_current_process(&mut state);
            state.last_error = Some(diagnostic(
                "desktop_pet_e_ready_timeout",
                format!("generation {generation} did not become ready within 5 seconds"),
            ));
            should_restart = schedule_restart_after_failure(&mut state);
            emit_runtime_state(&app, &state);
        }
        if should_restart {
            let manager = self.clone();
            thread::spawn(move || {
                let Ok(mut state) = manager.state.lock() else {
                    return;
                };
                if !state.enabled || state.shutting_down || state.process.is_some() {
                    return;
                }
                if let Err(error) = start_process(manager.clone(), app.clone(), &mut state) {
                    state.enabled = false;
                    state.last_error = Some(diagnostic("desktop_pet_e_restart_failed", error));
                    emit_runtime_state(&app, &state);
                }
            });
        }
    }

    fn handle_reader_end<R: Runtime>(&self, app: AppHandle<R>, generation: u64, detail: String) {
        let should_restart;
        {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.generation != generation {
                return;
            }
            let expected_exit = finish_current_process(&mut state);
            if expected_exit || state.shutting_down || !state.enabled {
                emit_runtime_state(&app, &state);
                return;
            }
            state.ready = false;
            state.last_error = Some(diagnostic("desktop_pet_e_process_exited", detail));
            should_restart = schedule_restart_after_failure(&mut state);
            emit_runtime_state(&app, &state);
        }

        if should_restart {
            let manager = self.clone();
            thread::spawn(move || {
                let Ok(mut state) = manager.state.lock() else {
                    return;
                };
                if !state.enabled || state.shutting_down || state.process.is_some() {
                    return;
                }
                if let Err(error) = start_process(manager.clone(), app.clone(), &mut state) {
                    state.enabled = false;
                    state.last_error = Some(diagnostic("desktop_pet_e_restart_failed", error));
                    emit_runtime_state(&app, &state);
                }
            });
        }
    }
}

fn restart_after_failure<R: Runtime>(
    manager: DesktopPetEManager,
    app: AppHandle<R>,
    state: &mut ManagerState,
) {
    if !schedule_restart_after_failure(state) {
        return;
    }
    if let Err(error) = start_process(manager, app, state) {
        state.enabled = false;
        state.last_error = Some(diagnostic("desktop_pet_e_restart_failed", error));
    }
}

fn schedule_restart_after_failure(state: &mut ManagerState) -> bool {
    if state.restart_count == 0 && state.enabled && !state.shutting_down {
        state.restart_count = 1;
        true
    } else {
        state.enabled = false;
        false
    }
}

fn runtime_state(state: &ManagerState) -> DesktopPetERuntimeState {
    DesktopPetERuntimeState {
        enabled: state.enabled,
        running: state.process.is_some(),
        ready: state.ready,
        generation: state.generation,
        restart_count: state.restart_count,
        last_error: state.last_error.clone(),
    }
}

fn emit_runtime_state<R: Runtime>(app: &AppHandle<R>, state: &ManagerState) {
    let _ = app.emit(RUNTIME_STATE_EVENT, runtime_state(state));
}

fn diagnostic(code: &str, detail: String) -> DesktopPetEDiagnostic {
    DesktopPetEDiagnostic {
        code: code.to_string(),
        message: code.to_string(),
        detail: Some(detail),
        occurred_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    }
}

fn resolve_runtime_paths<R: Runtime>(app: &AppHandle<R>) -> Result<(PathBuf, PathBuf), String> {
    let runtime = std::env::var_os("CLI_MANAGER_PET_E_RUNTIME")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| {
            app.path()
                .resolve(ELECTRON_RUNTIME_RELATIVE_PATH, BaseDirectory::Resource)
                .map_err(|error| format!("desktop_pet_e_runtime_resolve_failed: {error}"))
        })?;
    let entry = std::env::var_os("CLI_MANAGER_PET_E_ENTRY")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| {
            app.path()
                .resolve(ELECTRON_ENTRY_RELATIVE_PATH, BaseDirectory::Resource)
                .map_err(|error| format!("desktop_pet_e_entry_resolve_failed: {error}"))
        })?;
    if !runtime.is_file() {
        return Err(format!(
            "desktop_pet_e_runtime_missing: {}",
            runtime.to_string_lossy()
        ));
    }
    if !entry.is_file() {
        return Err(format!(
            "desktop_pet_e_entry_missing: {}",
            entry.to_string_lossy()
        ));
    }
    Ok((runtime, entry))
}

fn start_process<R: Runtime>(
    manager: DesktopPetEManager,
    app: AppHandle<R>,
    state: &mut ManagerState,
) -> Result<(), String> {
    let (runtime, entry) = resolve_runtime_paths(&app)?;
    state.generation = state.generation.saturating_add(1);
    state.host_revision = 0;
    state.ready = false;
    let generation = state.generation;
    let instance_id = Uuid::new_v4().to_string();
    let mut command = silent_command(&runtime.to_string_lossy());
    command
        .arg(&entry)
        .arg("--cli-manager-pet-e")
        .arg("--instance-id")
        .arg(&instance_id)
        .arg("--generation")
        .arg(generation.to_string())
        .env("CLI_MANAGER_PET_E_RESOURCE_ROOT", PET_E_RESOURCE_ROOT)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("desktop_pet_e_spawn_failed: {error}"))?;
    #[cfg(target_os = "windows")]
    let job = match ChildJob::assign(&child, "Desktop Pet E") {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            #[cfg(target_os = "windows")]
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop_pet_e_stdin_unavailable".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            #[cfg(target_os = "windows")]
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop_pet_e_stdout_unavailable".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            #[cfg(target_os = "windows")]
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop_pet_e_stderr_unavailable".to_string());
        }
    };
    state.process = Some(ManagedCompanion {
        child,
        stdin,
        #[cfg(target_os = "windows")]
        job,
        instance_id: instance_id.clone(),
        generation,
        expected_exit: false,
    });
    state.last_error = None;
    emit_runtime_state(&app, state);

    let timeout_manager = manager.clone();
    let timeout_app = app.clone();
    thread::spawn(move || {
        thread::sleep(READY_TIMEOUT);
        timeout_manager.handle_ready_timeout(timeout_app, generation);
    });
    let reader_manager = manager.clone();
    let reader_app = app.clone();
    thread::spawn(move || {
        read_stdout(reader_manager, reader_app, stdout, instance_id, generation);
    });
    thread::spawn(move || drain_stderr(stderr));
    Ok(())
}

fn read_stdout<R: Runtime>(
    manager: DesktopPetEManager,
    app: AppHandle<R>,
    mut stdout: impl Read,
    instance_id: String,
    generation: u64,
) {
    let mut decoder = DesktopPetELineDecoder::default();
    let mut validator = DesktopPetEInboundValidator::new(instance_id, generation);
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                for line in decoder.push(&buffer[..count]) {
                    match line.and_then(|line| validator.parse_line(&line)) {
                        Ok(message) => manager.handle_stdout_line(&app, generation, message),
                        Err(error) => {
                            let _ = app.emit(DIAGNOSTIC_EVENT, json!({
                                "type": "diagnostic",
                                "payload": diagnostic("desktop_pet_e_inbound_rejected", error),
                            }));
                        }
                    }
                }
            }
            Err(error) => {
                manager.handle_reader_end(app, generation, format!("stdout read failed: {error}"));
                return;
            }
        }
    }
    if let Some(line) = decoder.finish() {
        if let Ok(line) = line {
            if let Ok(message) = validator.parse_line(&line) {
                manager.handle_stdout_line(&app, generation, message);
            }
        }
    }
    manager.handle_reader_end(app, generation, "stdout closed".to_string());
}

fn drain_stderr(mut stderr: impl Read) {
    let mut buffer = [0u8; 4096];
    while let Ok(count) = stderr.read(&mut buffer) {
        if count == 0 {
            break;
        }
        log::warn!(
            "Desktop Pet E stderr: {}",
            String::from_utf8_lossy(&buffer[..count]).trim()
        );
    }
}

fn send_latest_state(state: &mut ManagerState) -> Result<(), String> {
    let config = state.latest_config.clone();
    let snapshot = state.latest_snapshot.clone().map(|mut snapshot| {
        if let Some(process) = state.process.as_ref() {
            if let Some(object) = snapshot.as_object_mut() {
                object.insert("protocolVersion".to_string(), json!(1));
                object.insert("instanceId".to_string(), json!(process.instance_id.clone()));
                object.insert("generation".to_string(), json!(process.generation));
            }
        }
        snapshot
    });
    if let Some(config) = config {
        send_message(state, "config", config)?;
    }
    if let Some(snapshot) = snapshot {
        send_message(state, "snapshot", snapshot)?;
    }
    Ok(())
}

fn send_message(state: &mut ManagerState, message_type: &str, payload: Value) -> Result<(), String> {
    state.host_revision = state.host_revision.saturating_add(1);
    let host_revision = state.host_revision;
    let process = state
        .process
        .as_mut()
        .ok_or_else(|| "desktop_pet_e_not_running".to_string())?;
    let encoded = encode_host_message(
        &process.instance_id,
        process.generation,
        host_revision,
        message_type,
        payload,
    )?;
    process
        .stdin
        .write_all(&encoded)
        .and_then(|_| process.stdin.flush())
        .map_err(|error| format!("desktop_pet_e_write_failed: {error}"))
}

fn finish_current_process(state: &mut ManagerState) -> bool {
    let Some(mut process) = state.process.take() else {
        state.ready = false;
        return true;
    };
    let expected_exit = process.expected_exit;
    let deadline = std::time::Instant::now() + Duration::from_millis(250);
    let successful_exit = loop {
        match process.child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) | Err(_) => break false,
        }
    };
    if !successful_exit {
        #[cfg(target_os = "windows")]
        process.job.terminate();
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    state.ready = false;
    expected_exit
}

fn stop_process(state: &mut ManagerState, reason: &str) {
    let Some(mut process) = state.process.take() else {
        state.ready = false;
        return;
    };
    process.expected_exit = true;
    state.host_revision = state.host_revision.saturating_add(1);
    if let Ok(message) = encode_host_message(
        &process.instance_id,
        process.generation,
        state.host_revision,
        "shutdown",
        json!({ "reason": reason }),
    ) {
        let _ = process.stdin.write_all(&message);
        let _ = process.stdin.flush();
    }
    #[cfg(target_os = "windows")]
    process.job.terminate();
    let _ = process.child.kill();
    let _ = process.child.wait();
    state.ready = false;
}

#[tauri::command]
pub fn desktop_pet_e_sync(
    app: AppHandle,
    manager: tauri::State<'_, DesktopPetEManager>,
    request: DesktopPetESyncRequest,
) -> Result<DesktopPetERuntimeState, String> {
    manager.synchronize(app, request)
}

#[tauri::command]
pub fn desktop_pet_e_runtime_state(
    manager: tauri::State<'_, DesktopPetEManager>,
) -> Result<DesktopPetERuntimeState, String> {
    let state = manager
        .state
        .lock()
        .map_err(|_| "desktop_pet_e_manager_lock_poisoned".to_string())?;
    Ok(runtime_state(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_state_does_not_report_ready_without_a_process() {
        let state = ManagerState {
            enabled: true,
            ready: false,
            generation: 3,
            restart_count: 1,
            ..ManagerState::default()
        };
        let runtime = runtime_state(&state);
        assert!(runtime.enabled);
        assert!(!runtime.running);
        assert!(!runtime.ready);
        assert_eq!(runtime.generation, 3);
        assert_eq!(runtime.restart_count, 1);
    }

    #[test]
    fn lifecycle_restarts_only_once_before_disabling() {
        let mut state = ManagerState {
            enabled: true,
            ..ManagerState::default()
        };
        assert!(schedule_restart_after_failure(&mut state));
        assert!(state.enabled);
        assert_eq!(state.restart_count, 1);

        assert!(!schedule_restart_after_failure(&mut state));
        assert!(!state.enabled);
        assert_eq!(state.restart_count, 1);
    }

    #[test]
    fn lifecycle_never_restarts_during_shutdown() {
        let mut state = ManagerState {
            enabled: true,
            shutting_down: true,
            ..ManagerState::default()
        };
        assert!(!schedule_restart_after_failure(&mut state));
        assert!(!state.enabled);
        assert_eq!(state.restart_count, 0);
    }

    #[test]
    fn diagnostic_uses_stable_code_and_timestamp() {
        let value = diagnostic("desktop_pet_e_test", "detail".to_string());
        assert_eq!(value.code, "desktop_pet_e_test");
        assert_eq!(value.message, "desktop_pet_e_test");
        assert!(value.occurred_at > 0);
    }
}
