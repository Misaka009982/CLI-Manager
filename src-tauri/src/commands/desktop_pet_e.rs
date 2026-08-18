use crate::desktop_pet_e_bridge::{
    encode_host_message, DesktopPetEInboundMessage, DesktopPetEInboundValidator,
    DesktopPetELineDecoder,
};
use crate::shell_resolver::silent_command;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(target_os = "windows")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
#[cfg(target_os = "windows")]
use std::ffi::OsStr;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use std::os::windows::io::FromRawHandle;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, Runtime};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use crate::process_job::ChildJob;

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, INVALID_HANDLE_VALUE,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, SetNamedPipeHandleState, PIPE_NOWAIT,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};

const ACTION_EVENT: &str = "desktop-pet-e-action";
const RUNTIME_STATE_EVENT: &str = "desktop-pet-e-runtime-state";
const DIAGNOSTIC_EVENT: &str = "desktop-pet-e-event";
const READY_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const HOST_PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_DIAGNOSTIC_CODE_LIMIT: usize = 160;
const CHILD_DIAGNOSTIC_DETAIL_LIMIT: usize = 512;
const ELECTRON_RUNTIME_RELATIVE_PATH: &str = "pet-e/runtime/electron.exe";
const ELECTRON_ENTRY_RELATIVE_PATH: &str = "pet-e/app/main.js";
#[cfg(target_os = "windows")]
const PET_E_PACKAGE_MANIFEST_RELATIVE_PATH: &str = "pet-e/package-manifest.json";
#[cfg(target_os = "windows")]
const ELECTRON_RUNTIME_VERSION: &str = "41.10.2";
#[cfg(target_os = "windows")]
const ELECTRON_RUNTIME_ARCHIVE: &str = "electron-v41.10.2-win32-x64.zip";
#[cfg(target_os = "windows")]
const ELECTRON_RUNTIME_SOURCE_URL: &str =
    "https://github.com/electron/electron/releases/download/v41.10.2/electron-v41.10.2-win32-x64.zip";
#[cfg(target_os = "windows")]
const ELECTRON_RUNTIME_CHECKSUM_URL: &str =
    "https://github.com/electron/electron/releases/download/v41.10.2/SHASUMS256.txt";
#[cfg(target_os = "windows")]
const ELECTRON_RUNTIME_SHA256: &str =
    "7665990f65b7d2f61671eb342b08c4b6f2e7ce302a269d56c2f3554fc8c8ce72";

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPetERuntimeManifest {
    schema_version: u32,
    runtime: String,
    version: String,
    platform: String,
    arch: String,
    archive: String,
    source_url: String,
    checksum_url: String,
    sha256: String,
    entry: String,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPetEPackageFile {
    path: String,
    size: u64,
    sha256: String,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPetEPackageManifest {
    schema_version: u32,
    component: String,
    runtime: DesktopPetERuntimeManifest,
    files: Vec<DesktopPetEPackageFile>,
}

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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetEActionResult {
    action_id: String,
    accepted: bool,
    confirmed: bool,
    error: Option<String>,
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

#[cfg(target_os = "windows")]
struct DesktopPetEHostPipe {
    name: String,
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
impl DesktopPetEHostPipe {
    fn create() -> Result<Self, String> {
        let name = format!(r"\\.\pipe\cli-manager-desktop-pet-e-{}", Uuid::new_v4());
        let wide_name: Vec<u16> = OsStr::new(&name).encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateNamedPipeW(
                wide_name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE
                    | PIPE_READMODE_BYTE
                    | PIPE_NOWAIT
                    | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                1024 * 1024,
                4096,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!("desktop_pet_e_host_pipe_create_failed:{}", unsafe {
                GetLastError()
            }));
        }
        Ok(Self { name, handle })
    }

    fn connect(mut self, timeout: Duration) -> Result<Box<dyn Write + Send>, String> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let connected = unsafe { ConnectNamedPipe(self.handle, std::ptr::null_mut()) } != 0;
            let error = if connected { 0 } else { unsafe { GetLastError() } };
            if connected || error == ERROR_PIPE_CONNECTED {
                let mut mode = PIPE_READMODE_BYTE | PIPE_WAIT;
                let updated = unsafe {
                    SetNamedPipeHandleState(
                        self.handle,
                        &mut mode,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                } != 0;
                if !updated {
                    return Err(format!("desktop_pet_e_host_pipe_mode_failed:{}", unsafe {
                        GetLastError()
                    }));
                }
                let handle = std::mem::replace(&mut self.handle, INVALID_HANDLE_VALUE);
                let file = unsafe { fs::File::from_raw_handle(handle) };
                return Ok(Box::new(file));
            }
            if error != ERROR_PIPE_LISTENING {
                return Err(format!("desktop_pet_e_host_pipe_connect_failed:{error}"));
            }
            if std::time::Instant::now() >= deadline {
                return Err("desktop_pet_e_host_pipe_connect_timeout".to_string());
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for DesktopPetEHostPipe {
    fn drop(&mut self) {
        if self.handle != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

struct ManagedCompanion {
    child: Child,
    input: Box<dyn Write + Send>,
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
    // 子进程最近一次自报诊断/标准错误输出（code, detail），仅在进程异常退出时用于还原真正原因。
    child_diagnostic: Option<(String, String)>,
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
            child_diagnostic: None,
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

    fn send_action_result<R: Runtime>(
        &self,
        app: AppHandle<R>,
        result: DesktopPetEActionResult,
    ) -> Result<(), String> {
        if result.action_id.trim().is_empty() || result.action_id.len() > 160 {
            return Err("desktop_pet_e_action_result_id_invalid".to_string());
        }
        if result
            .error
            .as_deref()
            .is_some_and(|error| {
                error.len() > 512
                    || error
                        .chars()
                        .any(|character| matches!(character, '\0' | '\r' | '\n'))
            })
        {
            return Err("desktop_pet_e_action_result_error_invalid".to_string());
        }
        let payload = serde_json::to_value(result)
            .map_err(|error| format!("desktop_pet_e_action_result_invalid: {error}"))?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "desktop_pet_e_manager_lock_poisoned".to_string())?;
        if !state.ready {
            return Err("desktop_pet_e_not_ready".to_string());
        }
        if let Err(error) = send_message(&mut state, "action-result", payload) {
            state.last_error = Some(diagnostic("desktop_pet_e_state_send_failed", error.clone()));
            finish_current_process(&mut state);
            restart_after_failure(self.clone(), app.clone(), &mut state);
            emit_runtime_state(&app, &state);
            return Err(error);
        }
        Ok(())
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
                state.child_diagnostic = None;
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
                if let Some(summary) = child_diagnostic_summary(&payload) {
                    state.child_diagnostic = Some(summary);
                }
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
            state.last_error = Some(child_failure_diagnostic(
                &mut state,
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
            state.last_error = Some(child_failure_diagnostic(
                &mut state,
                "desktop_pet_e_process_exited",
                detail,
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

// 子进程异常结束时优先使用 Electron 自报的真实错误，避免只看到 "stdout closed"。
fn child_failure_diagnostic(
    state: &mut ManagerState,
    fallback_code: &str,
    fallback_detail: String,
) -> DesktopPetEDiagnostic {
    match state.child_diagnostic.take() {
        Some((code, cause)) => {
            diagnostic(&code, format!("{cause} ({fallback_code}: {fallback_detail})"))
        }
        None => diagnostic(fallback_code, fallback_detail),
    }
}

fn clamp_diagnostic_text(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn child_diagnostic_summary(payload: &Value) -> Option<(String, String)> {
    let code = payload.get("code").and_then(Value::as_str)?.trim();
    if code.is_empty() {
        return None;
    }
    let cause = payload
        .get("detail")
        .and_then(Value::as_str)
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or(code)
        .trim();
    Some((
        clamp_diagnostic_text(code, CHILD_DIAGNOSTIC_CODE_LIMIT),
        clamp_diagnostic_text(cause, CHILD_DIAGNOSTIC_DETAIL_LIMIT),
    ))
}

#[cfg(target_os = "windows")]
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("desktop_pet_e_package_file_hash_failed:{}:{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("desktop_pet_e_package_file_hash_failed:{}:{error}", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_packaged_runtime<R: Runtime>(
    app: &AppHandle<R>,
    runtime: &PathBuf,
    entry: &PathBuf,
) -> Result<(), String> {
    if std::env::var_os("CLI_MANAGER_PET_E_RUNTIME").is_some()
        || std::env::var_os("CLI_MANAGER_PET_E_ENTRY").is_some()
    {
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, runtime, entry);
        return Err("desktop_pet_e_platform_unsupported".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let manifest_path = app
            .path()
            .resolve(PET_E_PACKAGE_MANIFEST_RELATIVE_PATH, BaseDirectory::Resource)
            .map_err(|error| format!("desktop_pet_e_package_manifest_resolve_failed: {error}"))?;
        let manifest_bytes = fs::read(&manifest_path)
            .map_err(|error| format!("desktop_pet_e_package_manifest_missing: {error}"))?;
        let manifest: DesktopPetEPackageManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|error| format!("desktop_pet_e_package_manifest_invalid: {error}"))?;
        let runtime_manifest = &manifest.runtime;
        if manifest.schema_version != 1
            || manifest.component != "desktop-pet-e"
            || runtime_manifest.schema_version != 1
            || runtime_manifest.runtime != "electron"
            || runtime_manifest.version != ELECTRON_RUNTIME_VERSION
            || runtime_manifest.platform != "win32"
            || runtime_manifest.arch != "x64"
            || runtime_manifest.archive != ELECTRON_RUNTIME_ARCHIVE
            || runtime_manifest.entry != "electron.exe"
            || runtime_manifest.source_url != ELECTRON_RUNTIME_SOURCE_URL
            || runtime_manifest.checksum_url != ELECTRON_RUNTIME_CHECKSUM_URL
            || runtime_manifest.sha256 != ELECTRON_RUNTIME_SHA256
        {
            return Err("desktop_pet_e_package_manifest_mismatch".to_string());
        }
        let app_package_path = entry.with_file_name("package.json");
        let app_package_bytes = fs::read(&app_package_path)
            .map_err(|error| format!("desktop_pet_e_package_app_manifest_missing: {error}"))?;
        let app_package: Value = serde_json::from_slice(&app_package_bytes)
            .map_err(|error| format!("desktop_pet_e_package_app_manifest_invalid: {error}"))?;
        if app_package.get("name").and_then(Value::as_str)
            != Some("cli-manager-desktop-pet-e-runtime")
            || app_package.get("version").and_then(Value::as_str) != Some("1.0.0")
            || app_package.get("private").and_then(Value::as_bool) != Some(true)
            || app_package.get("type").and_then(Value::as_str) != Some("module")
            || app_package.get("main").and_then(Value::as_str) != Some("main.js")
        {
            return Err("desktop_pet_e_package_app_manifest_mismatch".to_string());
        }
        for (relative_path, actual_path) in [
            ("runtime/electron.exe", runtime.as_path()),
            ("app/main.js", entry.as_path()),
            ("app/package.json", app_package_path.as_path()),
        ] {
            let metadata = fs::metadata(actual_path)
                .map_err(|error| format!("desktop_pet_e_package_file_missing:{relative_path}:{error}"))?;
            let Some(recorded) = manifest.files.iter().find(|file| file.path == relative_path) else {
                return Err(format!("desktop_pet_e_package_file_unlisted:{relative_path}"));
            };
            let actual_sha256 = sha256_file(actual_path)?;
            if recorded.size != metadata.len()
                || recorded.sha256.len() != 64
                || !recorded.sha256.eq_ignore_ascii_case(&actual_sha256)
            {
                return Err(format!("desktop_pet_e_package_file_mismatch:{relative_path}"));
            }
        }
        Ok(())
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
    validate_packaged_runtime(app, &runtime, &entry)?;
    Ok((runtime, entry))
}

#[cfg(target_os = "windows")]
fn normalize_process_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy().into_owned();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        PathBuf::from(value)
    }
}

#[cfg(not(target_os = "windows"))]
fn normalize_process_path(path: PathBuf) -> PathBuf {
    path
}

fn electron_app_dir_argument(entry: &Path) -> Result<PathBuf, String> {
    let app_dir = entry
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "desktop_pet_e_app_dir_missing".to_string())?;
    Ok(normalize_process_path(app_dir.to_path_buf()))
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
    let app_dir_arg = electron_app_dir_argument(&entry)?;
    let runtime_arg = normalize_process_path(runtime);
    #[cfg(target_os = "windows")]
    let host_pipe = DesktopPetEHostPipe::create()?;
    let mut command = silent_command(&runtime_arg.to_string_lossy());
    command
        .arg(&app_dir_arg)
        .arg("--cli-manager-pet-e")
        .arg("--instance-id")
        .arg(&instance_id)
        .arg("--generation")
        .arg(generation.to_string());
    #[cfg(target_os = "windows")]
    command
        .arg("--host-pipe")
        .arg(&host_pipe.name)
        .stdin(Stdio::null());
    #[cfg(not(target_os = "windows"))]
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
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
    #[cfg(target_os = "windows")]
    let input = match host_pipe.connect(HOST_PIPE_CONNECT_TIMEOUT) {
        Ok(input) => input,
        Err(error) => {
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    #[cfg(not(target_os = "windows"))]
    let input: Box<dyn Write + Send> = match child.stdin.take() {
        Some(stdin) => Box::new(stdin),
        None => {
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
        input,
        #[cfg(target_os = "windows")]
        job,
        instance_id: instance_id.clone(),
        generation,
        expected_exit: false,
    });
    state.last_error = None;
    state.child_diagnostic = None;
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
    let stderr_manager = manager.clone();
    let stderr_app = app.clone();
    thread::spawn(move || drain_stderr(stderr_manager, stderr_app, generation, stderr));
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

fn drain_stderr<R: Runtime>(
    manager: DesktopPetEManager,
    app: AppHandle<R>,
    generation: u64,
    mut stderr: impl Read,
) {
    let mut buffer = [0u8; 4096];
    while let Ok(count) = stderr.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let detail = String::from_utf8_lossy(&buffer[..count]).trim().to_string();
        if detail.is_empty() {
            continue;
        }
        log::warn!("Desktop Pet E stderr: {}", detail);
        let summary = clamp_diagnostic_text(&detail, CHILD_DIAGNOSTIC_DETAIL_LIMIT);
        let payload = diagnostic(
            "desktop_pet_e_stderr",
            format!("generation {generation}: {summary}"),
        );
        {
            let Ok(mut state) = manager.state.lock() else {
                return;
            };
            if state.generation != generation || state.process.is_none() {
                return;
            }
            // Electron 的 stderr 包含无害噪音，所以只暂存为退出原因候选，不直接当成错误展示。
            state.child_diagnostic = Some(("desktop_pet_e_stderr".to_string(), summary));
        }
        let _ = app.emit(DIAGNOSTIC_EVENT, json!({
            "type": "diagnostic",
            "payload": payload,
        }));
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
        .input
        .write_all(&encoded)
        .and_then(|_| process.input.flush())
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
        let _ = process.input.write_all(&message);
        let _ = process.input.flush();
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
pub fn desktop_pet_e_action_result(
    app: AppHandle,
    manager: tauri::State<'_, DesktopPetEManager>,
    result: DesktopPetEActionResult,
) -> Result<(), String> {
    manager.send_action_result(app, result)
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

    #[cfg(target_os = "windows")]
    #[test]
    fn electron_receives_the_app_directory_argument() {
        assert_eq!(
            electron_app_dir_argument(Path::new(
                r"\\?\C:\Program Files\CLI-Manager\pet-e\app\main.js",
            ))
            .unwrap(),
            PathBuf::from(r"C:\Program Files\CLI-Manager\pet-e\app"),
        );
        assert_eq!(
            electron_app_dir_argument(Path::new(
                r"\\?\UNC\server\share\CLI-Manager\pet-e\app\main.js",
            ))
            .unwrap(),
            PathBuf::from(r"\\server\share\CLI-Manager\pet-e\app"),
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn process_paths_remove_windows_verbatim_prefixes() {
        assert_eq!(
            normalize_process_path(PathBuf::from(
                r"\\?\C:\Program Files\CLI-Manager\pet-e\app\main.js",
            )),
            PathBuf::from(r"C:\Program Files\CLI-Manager\pet-e\app\main.js"),
        );
        assert_eq!(
            normalize_process_path(PathBuf::from(
                r"\\?\UNC\server\share\CLI-Manager\pet-e\app\main.js",
            )),
            PathBuf::from(r"\\server\share\CLI-Manager\pet-e\app\main.js"),
        );
    }

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

    #[test]
    fn child_reported_failures_survive_the_stdout_close() {
        let mut state = ManagerState {
            enabled: true,
            ..ManagerState::default()
        };
        let summary = child_diagnostic_summary(&json!({
            "code": "desktop_pet_e_load_failed",
            "message": "desktop_pet_e_load_failed",
            "detail": "-6: ERR_FILE_NOT_FOUND (pet-e-app://app/index.html)",
        }))
        .expect("child diagnostic should be accepted");
        state.child_diagnostic = Some(summary);

        let failure = child_failure_diagnostic(
            &mut state,
            "desktop_pet_e_process_exited",
            "stdout closed".to_string(),
        );
        assert_eq!(failure.code, "desktop_pet_e_load_failed");
        let detail = failure.detail.expect("detail should be present");
        assert!(detail.contains("ERR_FILE_NOT_FOUND"));
        assert!(detail.contains("stdout closed"));
        assert!(state.child_diagnostic.is_none());
    }

    #[test]
    fn exit_without_child_diagnostics_keeps_the_transport_reason() {
        let mut state = ManagerState::default();
        let failure = child_failure_diagnostic(
            &mut state,
            "desktop_pet_e_process_exited",
            "stdout closed".to_string(),
        );
        assert_eq!(failure.code, "desktop_pet_e_process_exited");
        assert_eq!(failure.detail.as_deref(), Some("stdout closed"));
    }

    #[test]
    fn child_diagnostics_require_a_code_and_stay_bounded() {
        assert!(child_diagnostic_summary(&json!({ "detail": "no code" })).is_none());
        assert!(child_diagnostic_summary(&json!({ "code": "   " })).is_none());
        let (code, detail) = child_diagnostic_summary(&json!({
            "code": "x".repeat(CHILD_DIAGNOSTIC_CODE_LIMIT + 40),
            "detail": "y".repeat(CHILD_DIAGNOSTIC_DETAIL_LIMIT + 40),
        }))
        .expect("child diagnostic should be accepted");
        assert_eq!(code.chars().count(), CHILD_DIAGNOSTIC_CODE_LIMIT);
        assert_eq!(detail.chars().count(), CHILD_DIAGNOSTIC_DETAIL_LIMIT);
    }
}
