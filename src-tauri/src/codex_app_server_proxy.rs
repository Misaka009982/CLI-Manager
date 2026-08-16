#[cfg(target_os = "windows")]
use crate::shell_resolver::silent_command;
use crate::hook_client::{
    acknowledge_desktop_pet_e_agent, request_desktop_pet_e_agent,
};
use crate::ssh_transport::{
    format_remote_home_path, posix_quote, validate_remote_home_path, SshOneShotOptions,
    SshTransportLaunch, SshTransportSpec,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub const HELPER_SUBCOMMAND: &str = "__codex_app_server_proxy";
pub(crate) const PROXY_EXECUTABLE_ENV: &str = "CLI_MANAGER_CODEX_APP_SERVER_PROXY";
pub(crate) const EXPECTED_SESSION_ID_ENV: &str = "CLI_MANAGER_CODEX_EXPECTED_SESSION_ID";
pub(crate) const CODEX_LAUNCHER_ENV: &str = "CLI_MANAGER_CODEX_LAUNCHER";
pub(crate) const CODEX_BASE_URL_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_BASE_URL_OVERRIDE";
pub(crate) const CODEX_ENV_KEY_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_ENV_KEY_OVERRIDE";
pub(crate) const CODEX_MODEL_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_MODEL_OVERRIDE";
pub(crate) const CODEX_MODEL_CATALOG_OVERRIDE_ENV: &str =
    "CLI_MANAGER_CODEX_MODEL_CATALOG_OVERRIDE";
pub(crate) const CODEX_WIRE_API_OVERRIDE_ENV: &str = "CLI_MANAGER_CODEX_WIRE_API_OVERRIDE";
pub(crate) const CODEX_SSH_LAUNCH_ENV: &str = "CLI_MANAGER_CODEX_SSH_LAUNCH";
pub(crate) const CODEX_REMOTE_PROVIDER_NAME: &str = "cli_manager_remote";

// A resumed Codex thread can legitimately exceed cc-connect's 10 MB scanner limit.
// Keep a finite ceiling so a broken child cannot exhaust the host process indefinitely.
const MAX_PROTOCOL_LINE_BYTES: usize = 512 * 1024 * 1024;
const STRICT_RESUME_ERROR_CODE: i64 = -32091;
const SSH_HANDOFF_HOOK_QUEUE_CAPACITY: usize = 32;
const MAX_AGENT_REQUEST_WORKERS: usize = 32;
const LOCAL_HANDOFF_DELIVERY_INSTRUCTION: &str = "CLI-Manager remote handoff: deliver output files with `cc-connect send --file <absolute-path>` and output images with `cc-connect send --image <absolute-path>`.";

#[derive(Debug, Deserialize)]
struct RpcProbe {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeResponseEnvelope {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    result: Option<ResumeResult>,
    #[serde(default)]
    error: Option<MinimalRpcError>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeResult {
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    thread: ResumeThread,
}

#[derive(Debug, Default, Deserialize)]
struct ResumeThread {
    #[serde(default)]
    id: String,
}

#[derive(Debug, Deserialize)]
struct MinimalRpcError {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone)]
struct PendingResume {
    requested_thread_id: String,
    expected_thread_id: Option<String>,
}

enum ClientLineAction {
    Forward(Vec<u8>),
    Reject(Vec<u8>),
}

struct SshHandoffHookForwarder {
    sender: SyncSender<Value>,
    tab_id: String,
    expected_thread_id: Option<String>,
}

impl SshHandoffHookForwarder {
    fn from_environment(expected_thread_id: Option<String>) -> Option<Self> {
        let tab_id = env::var("CLI_MANAGER_TAB_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        let (sender, receiver) = sync_channel::<Value>(SSH_HANDOFF_HOOK_QUEUE_CAPACITY);
        std::thread::spawn(move || {
            while let Ok(payload) = receiver.recv() {
                let _ = crate::hook_client::try_notify_prepared_payload(&payload);
            }
        });
        Some(Self {
            sender,
            tab_id,
            expected_thread_id,
        })
    }

    fn inspect_server_line(&self, line: &[u8]) {
        let Some(payload) =
            ssh_handoff_hook_payload(line, &self.tab_id, self.expected_thread_id.as_deref())
        else {
            return;
        };
        match self.sender.try_send(payload) {
            Ok(()) | Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshCodexLaunch {
    pub(crate) transport: SshTransportSpec,
    pub(crate) remote_path: String,
    #[serde(default)]
    pub(crate) environment_overrides: HashMap<String, String>,
    #[serde(default)]
    pub(crate) initialization_command: Option<String>,
}

impl SshCodexLaunch {
    pub(crate) fn encode(&self) -> Result<String, String> {
        self.validate()?;
        let payload = serde_json::to_vec(self)
            .map_err(|err| format!("serialize SSH Codex launch failed: {err}"))?;
        Ok(BASE64_STANDARD.encode(payload))
    }

    fn from_environment() -> Result<Option<Self>, String> {
        let Some(encoded) = optional_unicode_env(CODEX_SSH_LAUNCH_ENV)? else {
            return Ok(None);
        };
        let payload = BASE64_STANDARD
            .decode(encoded)
            .map_err(|err| format!("decode SSH Codex launch failed: {err}"))?;
        let launch: Self = serde_json::from_slice(&payload)
            .map_err(|err| format!("parse SSH Codex launch failed: {err}"))?;
        launch.validate()?;
        Ok(Some(launch))
    }

    fn validate(&self) -> Result<(), String> {
        self.transport.validate()?;
        validate_remote_work_dir(&self.remote_path)?;
        if matches!(
            self.transport.auth_mode.as_str(),
            "password_prompt" | "interactive"
        ) {
            return Err("handoff_ssh_interactive_auth_unsupported".to_string());
        }
        if self
            .environment_overrides
            .keys()
            .any(|key| !is_valid_environment_key(key))
        {
            return Err("ssh_environment_key_invalid".to_string());
        }
        if self
            .environment_overrides
            .values()
            .any(|value| value.contains('\0'))
        {
            return Err("ssh_environment_value_invalid".to_string());
        }
        if let Some(codex_home) = self.environment_overrides.get("CODEX_HOME") {
            validate_remote_home_path(codex_home)
                .map_err(|_| "ssh_tool_config_root_invalid".to_string())?;
        }
        if self
            .initialization_command
            .as_deref()
            .is_some_and(|command| command.contains('\0'))
        {
            return Err("ssh_startup_command_invalid".to_string());
        }
        Ok(())
    }

    fn build_launch(&self, args: &[String]) -> Result<SshTransportLaunch, String> {
        self.validate()?;
        self.transport
            .build_one_shot_launch(self.remote_command(args), SshOneShotOptions::default())
    }

    fn remote_command(&self, args: &[String]) -> String {
        let mut commands = Vec::new();
        if let Some(command) = self
            .initialization_command
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            commands.push(command.to_string());
        }
        let mut environment = self.environment_overrides.iter().collect::<Vec<_>>();
        environment.sort_by(|left, right| left.0.cmp(right.0));
        commands.extend(environment.into_iter().map(|(key, value)| {
            let value = if key == "CODEX_HOME" {
                format_remote_home_path(value)
            } else {
                posix_quote(value)
            };
            format!("export {key}={value}")
        }));
        let invocation = std::iter::once("codex".to_string())
            .chain(args.iter().cloned())
            .map(|argument| posix_quote(&argument))
            .collect::<Vec<_>>()
            .join(" ");
        commands.push(format!("exec {invocation} 1>&3 3>&-"));
        format!(
            "cd -- {} && exec 3>&1 && exec \"${{SHELL:-/bin/sh}}\" -lic {} 1>&2",
            posix_quote(self.remote_path.trim()),
            posix_quote(&commands.join("\n"))
        )
    }
}

pub fn is_helper_request(args: &[String]) -> bool {
    args.get(1).map(String::as_str) == Some(HELPER_SUBCOMMAND)
}

pub fn run_helper_and_exit(args: &[String]) -> ! {
    let child_args = args
        .get(2..)
        .ok_or_else(|| "missing Codex app-server arguments".to_string());
    exit_after_proxy(child_args.and_then(run_proxy))
}

pub fn run_shim_and_exit(args: &[String]) -> ! {
    let child_args = args
        .get(1..)
        .ok_or_else(|| "missing Codex arguments".to_string());
    exit_after_proxy(child_args.and_then(|child_args| {
        if is_app_server_command(child_args) {
            run_proxy(child_args)
        } else {
            run_passthrough(child_args)
        }
    }))
}

fn exit_after_proxy(result: Result<i32, String>) -> ! {
    let exit_code = match result {
        Ok(code) => code,
        Err(err) => {
            eprintln!("CLI-Manager Codex app-server proxy: {err}");
            1
        }
    };
    std::process::exit(exit_code);
}

fn run_proxy(child_args: &[String]) -> Result<i32, String> {
    if !is_app_server_command(child_args) {
        return Err("refusing to proxy a non app-server Codex command".to_string());
    }

    let ssh_launch = SshCodexLaunch::from_environment()?;
    let expected_thread_id = env::var(EXPECTED_SESSION_ID_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut command = if let Some(ssh_launch) = ssh_launch.as_ref() {
        command_from_ssh_launch(ssh_launch.build_launch(child_args)?)
    } else {
        let launcher = codex_launcher_from_environment()?;
        let provider_overrides = CodexProviderOverrides::from_environment()?;
        let child_args = build_codex_child_args(child_args, &provider_overrides)?;
        codex_command(&launcher, &child_args)
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command
        .spawn()
        .map_err(|err| format!("start real Codex app-server failed: {err}"))?;
    let child_stdin = Arc::new(Mutex::new(Some(
        child
            .stdin
            .take()
            .ok_or_else(|| "real Codex stdin pipe is unavailable".to_string())?,
    )));
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| "real Codex stdout pipe is unavailable".to_string())?;

    let pending = Arc::new(Mutex::new(HashMap::<String, PendingResume>::new()));
    let parent_output = Arc::new(Mutex::new(io::stdout()));
    let input_pending = Arc::clone(&pending);
    let input_output = Arc::clone(&parent_output);
    let hook_forwarder = ssh_launch
        .as_ref()
        .and_then(|_| SshHandoffHookForwarder::from_environment(expected_thread_id.clone()));
    let remote_work_dir = ssh_launch.as_ref().map(|launch| launch.remote_path.clone());
    let input_child_stdin = Arc::clone(&child_stdin);
    let input_expected_thread_id = expected_thread_id.clone();
    std::thread::spawn(move || {
        let result = forward_parent_input(
            &input_child_stdin,
            input_expected_thread_id.as_deref(),
            remote_work_dir.as_deref(),
            &input_pending,
            &input_output,
        );
        if let Ok(mut writer) = input_child_stdin.lock() {
            writer.take();
        }
        if let Err(err) = result {
            eprintln!("CLI-Manager Codex app-server proxy input failed: {err}");
        }
    });

    if let Err(err) = forward_child_output(
        child_stdout,
        &pending,
        &parent_output,
        hook_forwarder.as_ref(),
        &child_stdin,
        expected_thread_id.as_deref(),
    ) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }
    let status = child
        .wait()
        .map_err(|err| format!("wait for real Codex app-server failed: {err}"))?;
    Ok(status.code().unwrap_or(1))
}

fn is_app_server_command(child_args: &[String]) -> bool {
    child_args.first().map(String::as_str) == Some("app-server")
}

fn run_passthrough(child_args: &[String]) -> Result<i32, String> {
    if let Some(ssh_launch) = SshCodexLaunch::from_environment()? {
        let status = command_from_ssh_launch(ssh_launch.build_launch(child_args)?)
            .status()
            .map_err(|err| format!("start remote Codex command failed: {err}"))?;
        return Ok(status.code().unwrap_or(1));
    }
    let launcher = codex_launcher_from_environment()?;
    let child_args =
        build_codex_child_args(child_args, &CodexProviderOverrides::from_environment()?)?;
    let status = codex_command(&launcher, &child_args)
        .status()
        .map_err(|err| format!("start real Codex command failed: {err}"))?;
    Ok(status.code().unwrap_or(1))
}

fn validate_remote_work_dir(path: &str) -> Result<(), String> {
    let path = path.trim();
    if !path.starts_with('/') || path.contains(['\0', '\r', '\n', '\\']) {
        return Err("ssh_remote_path_invalid".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("ssh_remote_path_parent_forbidden".to_string());
    }
    Ok(())
}

fn is_valid_environment_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|character| matches!(character, '_' | 'A'..='Z' | 'a'..='z' | '0'..='9'))
}

#[cfg(target_os = "windows")]
fn command_from_ssh_launch(launch: SshTransportLaunch) -> Command {
    let mut command = silent_command(&launch.executable);
    command.args(launch.args).envs(launch.env);
    command
}

#[cfg(not(target_os = "windows"))]
fn command_from_ssh_launch(launch: SshTransportLaunch) -> Command {
    let mut command = Command::new(&launch.executable);
    command.args(launch.args).envs(launch.env);
    command
}

fn codex_launcher_from_environment() -> Result<PathBuf, String> {
    env::var_os(CODEX_LAUNCHER_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "real Codex launcher is unavailable".to_string())
}

#[derive(Debug, Default, PartialEq, Eq)]
struct CodexProviderOverrides {
    base_url: Option<String>,
    env_key: Option<String>,
    model: Option<String>,
    model_catalog: Option<String>,
    wire_api: Option<String>,
}

impl CodexProviderOverrides {
    fn from_environment() -> Result<Self, String> {
        Ok(Self {
            base_url: optional_unicode_env(CODEX_BASE_URL_OVERRIDE_ENV)?,
            env_key: optional_unicode_env(CODEX_ENV_KEY_OVERRIDE_ENV)?,
            model: optional_unicode_env(CODEX_MODEL_OVERRIDE_ENV)?,
            model_catalog: optional_unicode_env(CODEX_MODEL_CATALOG_OVERRIDE_ENV)?,
            wire_api: optional_unicode_env(CODEX_WIRE_API_OVERRIDE_ENV)?,
        })
    }

    fn command_args(&self) -> Result<Vec<String>, String> {
        let has_any = self.base_url.is_some()
            || self.env_key.is_some()
            || self.model.is_some()
            || self.model_catalog.is_some()
            || self.wire_api.is_some();
        if !has_any {
            return Ok(Vec::new());
        }
        let base_url = self
            .base_url
            .as_ref()
            .ok_or_else(|| "Codex Provider base URL override is missing".to_string())?;
        let env_key = self
            .env_key
            .as_ref()
            .ok_or_else(|| "Codex Provider environment key override is missing".to_string())?;
        let wire_api = self
            .wire_api
            .as_ref()
            .ok_or_else(|| "Codex Provider wire API override is missing".to_string())?;
        let model_catalog = self
            .model_catalog
            .as_ref()
            .ok_or_else(|| "Codex model catalog override is missing".to_string())?;
        let mut args = vec![
            "-c".to_string(),
            format!("model_provider={CODEX_REMOTE_PROVIDER_NAME}"),
            "-c".to_string(),
            format!("model_providers.{CODEX_REMOTE_PROVIDER_NAME}.name=CLI-Manager remote"),
            "-c".to_string(),
            base_url.clone(),
            "-c".to_string(),
            env_key.clone(),
            "-c".to_string(),
            wire_api.clone(),
            "-c".to_string(),
            model_catalog.clone(),
        ];
        if let Some(model) = self.model.as_ref() {
            args.extend(["-c".to_string(), model.clone()]);
        }
        Ok(args)
    }
}

fn optional_unicode_env(key: &str) -> Result<Option<String>, String> {
    match env::var(key) {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{key} is not valid Unicode")),
    }
}

fn build_codex_child_args(
    child_args: &[String],
    overrides: &CodexProviderOverrides,
) -> Result<Vec<String>, String> {
    let mut args = overrides.command_args()?;
    args.extend_from_slice(child_args);
    Ok(args)
}

#[cfg(target_os = "windows")]
fn codex_command(launcher: &Path, args: &[String]) -> Command {
    let is_script = launcher
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat")
        });
    if is_script {
        let mut command = silent_command("cmd.exe");
        command.args(["/d", "/c"]).arg(launcher).args(args);
        command
    } else {
        let mut command = silent_command(&launcher.to_string_lossy());
        command.args(args);
        command
    }
}

#[cfg(not(target_os = "windows"))]
fn codex_command(launcher: &Path, args: &[String]) -> Command {
    let mut command = Command::new(launcher);
    command.args(args);
    command
}

fn forward_parent_input<W: Write>(
    child_stdin: &Arc<Mutex<Option<W>>>,
    expected_thread_id: Option<&str>,
    remote_work_dir: Option<&str>,
    pending: &Arc<Mutex<HashMap<String, PendingResume>>>,
    parent_output: &Arc<Mutex<io::Stdout>>,
) -> Result<(), String> {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut delivery_instruction_pending =
        expected_thread_id.is_some() && remote_work_dir.is_none();
    while let Some(line) = read_protocol_line(&mut reader, MAX_PROTOCOL_LINE_BYTES)
        .map_err(|err| format!("read cc-connect request failed: {err}"))?
    {
        let action = {
            let mut pending = pending
                .lock()
                .map_err(|_| "resume request state lock poisoned".to_string())?;
            inspect_client_line(
                &line,
                expected_thread_id,
                remote_work_dir,
                &mut pending,
                &mut delivery_instruction_pending,
            )
        };
        match action {
            ClientLineAction::Forward(line) => {
                let mut child_stdin = child_stdin
                    .lock()
                    .map_err(|_| "real Codex stdin lock poisoned".to_string())?;
                let child_stdin = child_stdin
                    .as_mut()
                    .ok_or_else(|| "real Codex stdin pipe is closed".to_string())?;
                child_stdin
                    .write_all(&line)
                    .and_then(|_| child_stdin.flush())
                    .map_err(|err| format!("write real Codex request failed: {err}"))?;
            }
            ClientLineAction::Reject(response) => {
                write_parent_line(parent_output, &response)?;
            }
        }
    }
    Ok(())
}

struct CodexAgentRequest {
    open_payload: Value,
    hook_payload: Value,
}

fn first_protocol_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
    })
}

fn codex_agent_request(line: &[u8], expected_thread_id: Option<&str>) -> Option<CodexAgentRequest> {
    let message = serde_json::from_slice::<Value>(trim_line_ending(line)).ok()?;
    let method = message.get("method").and_then(Value::as_str)?;
    if !matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "item/tool/requestUserInput"
            | "tool/requestUserInput"
            | "mcpServer/elicitation/request"
            | "applyPatchApproval"
            | "execCommandApproval"
    ) {
        return None;
    }
    let request_id = message.get("id")?.clone();
    if !matches!(request_id, Value::String(_) | Value::Number(_)) {
        return None;
    }
    let params = message.get("params")?;
    let session_id = first_protocol_string(
        params,
        &["threadId", "thread_id", "conversationId", "conversation_id"],
    )
    .or(expected_thread_id)?;
    if expected_thread_id.is_some_and(|expected| expected != session_id) {
        return None;
    }
    let tab_id = env::var("CLI_MANAGER_TAB_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("external:codex:{session_id}"));
    let tool_use_id = first_protocol_string(
        params,
        &["itemId", "item_id", "approvalId", "approval_id", "callId", "call_id"],
    );
    let notification_tool_name = if matches!(method, "item/tool/requestUserInput" | "tool/requestUserInput") {
        "request_user_input"
    } else {
        method
    };
    let hook_payload = json!({
        "tabId": tab_id.clone(),
        "source": "codex",
        "event": "PermissionRequest",
        "sessionId": session_id,
        "toolUseId": tool_use_id,
        "toolName": notification_tool_name,
        "remoteEventId": uuid::Uuid::new_v4().to_string(),
    });
    let open_payload = json!({
        "source": "codex",
        "event": "PermissionRequest",
        "protocol": "codex-app-server",
        "tabId": tab_id,
        "agentSessionId": session_id,
        "toolUseId": tool_use_id,
        "toolName": method,
        "requestId": request_id,
        "method": method,
        "hookInput": message,
    });
    Some(CodexAgentRequest {
        open_payload,
        hook_payload,
    })
}

fn handle_codex_agent_request<W: Write + Send + 'static>(
    request: CodexAgentRequest,
    original_line: Vec<u8>,
    child_stdin: Arc<Mutex<Option<W>>>,
    parent_output: Arc<Mutex<io::Stdout>>,
) {
    match request_desktop_pet_e_agent(&request.open_payload) {
        Ok(Some(decision)) => {
            let response = json_line(&decision.response);
            let write_result = child_stdin
                .lock()
                .map_err(|_| "real Codex stdin lock poisoned".to_string())
                .and_then(|mut writer| {
                    let writer = writer
                        .as_mut()
                        .ok_or_else(|| "real Codex stdin pipe is closed".to_string())?;
                    writer
                        .write_all(&response)
                        .and_then(|_| writer.flush())
                        .map_err(|error| format!("write Codex agent response failed: {error}"))
                });
            if let Err(error) = write_result {
                acknowledge_desktop_pet_e_agent(&decision, false);
                eprintln!("CLI-Manager Codex decision delivery failed: {error}");
                return;
            }
            acknowledge_desktop_pet_e_agent(&decision, true);
        }
        Ok(None) => {
            if let Err(error) = write_parent_line(&parent_output, &original_line) {
                eprintln!("CLI-Manager Codex native decision fallback failed: {error}");
            }
        }
        Err(error) => {
            eprintln!("CLI-Manager Codex decision bridge unavailable: {}", error.code());
            if let Err(write_error) = write_parent_line(&parent_output, &original_line) {
                eprintln!("CLI-Manager Codex native decision fallback failed: {write_error}");
            }
        }
    }
}

fn forward_child_output<R: io::Read, W: Write + Send + 'static>(
    child_stdout: R,
    pending: &Arc<Mutex<HashMap<String, PendingResume>>>,
    parent_output: &Arc<Mutex<io::Stdout>>,
    hook_forwarder: Option<&SshHandoffHookForwarder>,
    child_stdin: &Arc<Mutex<Option<W>>>,
    expected_thread_id: Option<&str>,
) -> Result<(), String> {
    let mut reader = BufReader::new(child_stdout);
    let agent_workers = Arc::new(AtomicUsize::new(0));
    while let Some(line) = read_protocol_line(&mut reader, MAX_PROTOCOL_LINE_BYTES)
        .map_err(|err| format!("read real Codex response failed: {err}"))?
    {
        if let Some(forwarder) = hook_forwarder {
            forwarder.inspect_server_line(&line);
        }
        if let Some(request) = codex_agent_request(&line, expected_thread_id) {
            if hook_forwarder.is_none() {
                let _ = crate::hook_client::try_notify_prepared_payload(&request.hook_payload);
            }
            if agent_workers
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    (current < MAX_AGENT_REQUEST_WORKERS).then_some(current + 1)
                })
                .is_err()
            {
                write_parent_line(parent_output, &line)?;
                continue;
            }
            let request_child_stdin = Arc::clone(child_stdin);
            let request_parent_output = Arc::clone(parent_output);
            let request_workers = Arc::clone(&agent_workers);
            std::thread::spawn(move || {
                handle_codex_agent_request(
                    request,
                    line,
                    request_child_stdin,
                    request_parent_output,
                );
                request_workers.fetch_sub(1, Ordering::AcqRel);
            });
            continue;
        }
        let transformed = {
            let mut pending = pending
                .lock()
                .map_err(|_| "resume response state lock poisoned".to_string())?;
            transform_server_line(&line, &mut pending)
        };
        write_parent_line(parent_output, transformed.as_deref().unwrap_or(&line))?;
    }
    Ok(())
}

fn inspect_client_line(
    line: &[u8],
    expected_thread_id: Option<&str>,
    remote_work_dir: Option<&str>,
    pending: &mut HashMap<String, PendingResume>,
    delivery_instruction_pending: &mut bool,
) -> ClientLineAction {
    let Ok(mut message) = serde_json::from_slice::<Value>(trim_line_ending(line)) else {
        return ClientLineAction::Forward(line.to_vec());
    };
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return ClientLineAction::Forward(line.to_vec());
    };
    let method = method.to_string();

    if method == "turn/start"
        && *delivery_instruction_pending
        && expected_thread_id.is_some()
        && remote_work_dir.is_none()
        && prepend_local_handoff_delivery_instruction(&mut message)
    {
        *delivery_instruction_pending = false;
        return ClientLineAction::Forward(json_line(&message));
    }

    let Some(id) = message.get("id") else {
        return ClientLineAction::Forward(line.to_vec());
    };
    let id = id.clone();

    if method == "thread/start" {
        if let Some(expected) = expected_thread_id {
            return ClientLineAction::Reject(rpc_error_response(
                &id,
                format!(
                    "CLI-Manager blocked a fresh thread because remote handoff requires session {expected}"
                ),
            ));
        }
        return ClientLineAction::Forward(line.to_vec());
    }
    if method != "thread/resume" {
        return ClientLineAction::Forward(line.to_vec());
    }

    let requested_thread_id = message
        .pointer("/params/threadId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if let Some(expected) = expected_thread_id {
        if requested_thread_id != expected {
            return ClientLineAction::Reject(rpc_error_response(
                &id,
                format!(
                    "CLI-Manager detected Codex session drift: expected {expected}, received {}",
                    if requested_thread_id.is_empty() {
                        "an empty session ID"
                    } else {
                        &requested_thread_id
                    }
                ),
            ));
        }
    }
    let mut request_changed = false;
    if remote_work_dir.is_some() {
        let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) else {
            return ClientLineAction::Reject(rpc_error_response(
                &id,
                "CLI-Manager received an invalid Codex resume request".to_string(),
            ));
        };
        if let Some(remote_work_dir) = remote_work_dir {
            params.insert(
                "cwd".to_string(),
                Value::String(remote_work_dir.to_string()),
            );
            request_changed = true;
        }
    }
    if let Some(key) = rpc_id_key(&id) {
        pending.insert(
            key,
            PendingResume {
                requested_thread_id,
                expected_thread_id: expected_thread_id.map(str::to_string),
            },
        );
    }
    if request_changed {
        ClientLineAction::Forward(json_line(&message))
    } else {
        ClientLineAction::Forward(line.to_vec())
    }
}

fn prepend_local_handoff_delivery_instruction(message: &mut Value) -> bool {
    let Some(inputs) = message
        .pointer_mut("/params/input")
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let Some(text) = inputs.iter_mut().find_map(|input| {
        if input.get("type").and_then(Value::as_str) != Some("text") {
            return None;
        }
        input.get_mut("text").filter(|value| value.is_string())
    }) else {
        return false;
    };
    let original = text.as_str().unwrap_or_default();
    *text = Value::String(format!(
        "{LOCAL_HANDOFF_DELIVERY_INSTRUCTION}\n\n{original}"
    ));
    true
}

fn ssh_handoff_hook_payload(
    line: &[u8],
    tab_id: &str,
    expected_thread_id: Option<&str>,
) -> Option<Value> {
    let message = serde_json::from_slice::<Value>(trim_line_ending(line)).ok()?;
    let method = message.get("method").and_then(Value::as_str)?;
    let params = message.get("params").and_then(Value::as_object)?;
    let session_id = first_protocol_string(
        params,
        &["threadId", "thread_id", "conversationId", "conversation_id"],
    )
    .or(expected_thread_id)?;
    if expected_thread_id.is_some_and(|expected| session_id != expected) {
        return None;
    }

    let event = match method {
        "turn/started" => "UserPromptSubmit",
        "turn/completed" => match params
            .get("turn")
            .and_then(Value::as_object)
            .and_then(|turn| turn.get("status"))
            .and_then(Value::as_str)
        {
            Some("failed") => "StopFailure",
            Some("completed" | "interrupted") => "Stop",
            _ => return None,
        },
        "error"
            if !params
                .get("willRetry")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            "StopFailure"
        }
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval"
        | "item/tool/requestUserInput"
        | "tool/requestUserInput"
        | "mcpServer/elicitation/request"
        | "applyPatchApproval"
        | "execCommandApproval" => "PermissionRequest",
        _ => return None,
    };
    let tool_use_id = first_protocol_string(
        params,
        &["itemId", "item_id", "approvalId", "approval_id", "callId", "call_id"],
    );
    Some(json!({
        "tabId": tab_id,
        "source": "codex",
        "event": event,
        "sessionId": session_id,
        "toolUseId": tool_use_id,
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "remoteEventId": uuid::Uuid::new_v4().to_string(),
    }))
}

fn transform_server_line(
    line: &[u8],
    pending: &mut HashMap<String, PendingResume>,
) -> Option<Vec<u8>> {
    let payload = trim_line_ending(line);
    let probe = serde_json::from_slice::<RpcProbe>(payload).ok()?;
    if probe.method.is_some() {
        return None;
    }
    let id = probe.id.as_ref()?;
    let resume = pending.remove(&rpc_id_key(id)?)?;
    Some(compact_resume_response(payload, id, &resume))
}

fn compact_resume_response(payload: &[u8], fallback_id: &Value, resume: &PendingResume) -> Vec<u8> {
    let envelope = match serde_json::from_slice::<ResumeResponseEnvelope>(payload) {
        Ok(envelope) => envelope,
        Err(err) => {
            return rpc_error_response(
                fallback_id,
                format!("CLI-Manager could not decode the Codex resume response: {err}"),
            )
        }
    };
    let response_id = envelope.id.as_ref().unwrap_or(fallback_id);
    if let Some(error) = envelope.error {
        return json_line(&json!({
            "jsonrpc": "2.0",
            "id": response_id,
            "error": {
                "code": error.code,
                "message": error.message,
            }
        }));
    }
    let Some(result) = envelope.result else {
        return rpc_error_response(
            response_id,
            "CLI-Manager received an empty Codex resume response".to_string(),
        );
    };
    if result.thread.id.trim().is_empty() {
        return rpc_error_response(
            response_id,
            "CLI-Manager received an empty Codex thread ID while resuming".to_string(),
        );
    }
    if let Some(expected) = resume.expected_thread_id.as_deref() {
        if result.thread.id != expected {
            return rpc_error_response(
                response_id,
                format!(
                    "CLI-Manager detected Codex session drift after resume: expected {expected}, received {}",
                    result.thread.id
                ),
            );
        }
    }

    let compact = json_line(&json!({
        "jsonrpc": "2.0",
        "id": response_id,
        "result": {
            "cwd": result.cwd,
            "model": result.model,
            "reasoningEffort": result.reasoning_effort,
            "thread": { "id": result.thread.id },
        }
    }));
    if payload.len() > 10 * 1024 * 1024 {
        eprintln!(
            "CLI-Manager compacted Codex thread/resume response from {} to {} bytes for session {}",
            payload.len(),
            compact.len(),
            resume.requested_thread_id
        );
    }
    compact
}

fn rpc_id_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(_) | Value::String(_) => serde_json::to_string(id).ok(),
        _ => None,
    }
}

fn rpc_error_response(id: &Value, message: String) -> Vec<u8> {
    json_line(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": STRICT_RESUME_ERROR_CODE,
            "message": message,
        }
    }))
}

fn json_line(value: &Value) -> Vec<u8> {
    let mut line = serde_json::to_vec(value).unwrap_or_else(|_| {
        b"{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"CLI-Manager proxy serialization failed\"}}".to_vec()
    });
    line.push(b'\n');
    line
}

fn trim_line_ending(mut line: &[u8]) -> &[u8] {
    while line
        .last()
        .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
    {
        line = &line[..line.len() - 1];
    }
    line
}

fn read_protocol_line(reader: &mut impl BufRead, max_bytes: usize) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(consumed) > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("app-server protocol line exceeds {max_bytes} bytes"),
            ));
        }
        line.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if line.last() == Some(&b'\n') {
            return Ok(Some(line));
        }
    }
}

fn write_parent_line(output: &Arc<Mutex<io::Stdout>>, line: &[u8]) -> Result<(), String> {
    let mut output = output
        .lock()
        .map_err(|_| "parent output lock poisoned".to_string())?;
    output
        .write_all(line)
        .and_then(|_| output.flush())
        .map_err(|err| format!("write cc-connect response failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh_transport(auth_mode: &str) -> SshTransportSpec {
        SshTransportSpec {
            host: "example.com".to_string(),
            port: 22,
            username: "dev".to_string(),
            config_alias: String::new(),
            config_file: String::new(),
            auth_mode: auth_mode.to_string(),
            identity_file: if auth_mode == "identity_file" {
                "/home/dev/.ssh/id ed25519".to_string()
            } else {
                String::new()
            },
            credential_ref: if auth_mode == "credential_ref" {
                "cli-manager:ssh:host-1".to_string()
            } else {
                String::new()
            },
            jump_target: String::new(),
            proxy_type: "none".to_string(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_command: String::new(),
            connect_timeout_sec: 10,
            server_alive_interval_sec: 30,
            server_alive_count_max: 3,
        }
    }

    fn ssh_codex_launch(auth_mode: &str) -> SshCodexLaunch {
        SshCodexLaunch {
            transport: ssh_transport(auth_mode),
            remote_path: "/srv/project dir".to_string(),
            environment_overrides: HashMap::from([
                ("CODEX_HOME".to_string(), "~/codex config".to_string()),
                ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
                ("GIT_CONFIG_KEY_0".to_string(), "safe.directory".to_string()),
                (
                    "GIT_CONFIG_VALUE_0".to_string(),
                    "/srv/project dir".to_string(),
                ),
            ]),
            initialization_command: Some("source ~/.profile".to_string()),
        }
    }

    #[test]
    fn provider_overrides_are_inserted_before_app_server_without_secrets() {
        let args = build_codex_child_args(
            &[
                "app-server".to_string(),
                "--listen".to_string(),
                "stdio://".to_string(),
            ],
            &CodexProviderOverrides {
                base_url: Some(
                    "model_providers.cli_manager_remote.base_url=https://provider.example.com/v1"
                        .to_string(),
                ),
                env_key: Some(
                    "model_providers.cli_manager_remote.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY"
                        .to_string(),
                ),
                model: Some("model=gpt-5.4".to_string()),
                model_catalog: Some(
                    r#"model_catalog_json="C:/Users/test/CLI Manager/cli-manager-model-catalog.json""#
                        .to_string(),
                ),
                wire_api: Some("model_providers.cli_manager_remote.wire_api=responses".to_string()),
            },
        )
        .unwrap();

        assert_eq!(
            args,
            vec![
                "-c",
                "model_provider=cli_manager_remote",
                "-c",
                "model_providers.cli_manager_remote.name=CLI-Manager remote",
                "-c",
                "model_providers.cli_manager_remote.base_url=https://provider.example.com/v1",
                "-c",
                "model_providers.cli_manager_remote.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY",
                "-c",
                "model_providers.cli_manager_remote.wire_api=responses",
                "-c",
                r#"model_catalog_json="C:/Users/test/CLI Manager/cli-manager-model-catalog.json""#,
                "-c",
                "model=gpt-5.4",
                "app-server",
                "--listen",
                "stdio://",
            ]
        );
        assert!(!args.iter().any(|arg| arg.contains("sk-provider-secret")));
    }

    #[test]
    fn app_server_arguments_pass_through_without_provider_overrides() {
        let original = vec![
            "app-server".to_string(),
            "--listen".to_string(),
            "stdio://".to_string(),
        ];
        assert_eq!(
            build_codex_child_args(&original, &CodexProviderOverrides::default()).unwrap(),
            original
        );
    }

    #[test]
    fn only_the_first_argument_selects_app_server_proxying() {
        assert!(is_app_server_command(&["app-server".to_string()]));
        assert!(!is_app_server_command(&[
            "--version".to_string(),
            "app-server".to_string(),
        ]));
        assert!(!is_app_server_command(&[]));
    }

    #[test]
    fn partial_provider_overrides_are_rejected() {
        let error = CodexProviderOverrides {
            base_url: Some(
                "model_providers.cli_manager_remote.base_url=https://example.com".into(),
            ),
            ..CodexProviderOverrides::default()
        }
        .command_args()
        .unwrap_err();
        assert!(error.contains("environment key"));
    }

    #[test]
    fn provider_overrides_require_the_managed_model_catalog() {
        let error = CodexProviderOverrides {
            base_url: Some(
                "model_providers.cli_manager_remote.base_url=https://example.com".into(),
            ),
            env_key: Some(
                "model_providers.cli_manager_remote.env_key=CLI_MANAGER_CODEX_PROVIDER_API_KEY"
                    .into(),
            ),
            wire_api: Some("model_providers.cli_manager_remote.wire_api=responses".into()),
            ..CodexProviderOverrides::default()
        }
        .command_args()
        .unwrap_err();
        assert!(error.contains("model catalog"));
    }

    #[test]
    fn compacts_a_resume_response_larger_than_cc_connects_limit() {
        let huge_history = "x".repeat(11 * 1024 * 1024);
        let source = json_line(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "cwd": "F:\\repo",
                "model": "gpt-5.4",
                "reasoningEffort": "high",
                "thread": {
                    "id": "thread-original",
                    "turns": [{"items": [{"type": "message", "text": huge_history}]}]
                }
            }
        }));
        assert!(source.len() > 10 * 1024 * 1024);
        let mut pending = HashMap::from([(
            "2".to_string(),
            PendingResume {
                requested_thread_id: "thread-original".to_string(),
                expected_thread_id: Some("thread-original".to_string()),
            },
        )]);

        let compact = transform_server_line(&source, &mut pending).unwrap();
        assert!(compact.len() < 1024);
        let value: Value = serde_json::from_slice(trim_line_ending(&compact)).unwrap();
        assert_eq!(value["result"]["thread"]["id"], "thread-original");
        assert_eq!(value["result"]["cwd"], r"F:\repo");
        assert_eq!(value["result"]["model"], "gpt-5.4");
        assert_eq!(value["result"]["reasoningEffort"], "high");
        assert!(value["result"]["thread"].get("turns").is_none());
        assert!(pending.is_empty());
    }

    #[test]
    fn strict_handoff_rejects_session_drift_and_fresh_thread_fallback() {
        let mut pending = HashMap::new();
        let mut delivery_instruction_pending = false;
        let drifted = br#"{"jsonrpc":"2.0","id":3,"method":"thread/resume","params":{"threadId":"thread-new"}}
"#;
        let ClientLineAction::Reject(response) = inspect_client_line(
            drifted,
            Some("thread-original"),
            None,
            &mut pending,
            &mut delivery_instruction_pending,
        ) else {
            panic!("drifted resume must be rejected");
        };
        let response: Value = serde_json::from_slice(trim_line_ending(&response)).unwrap();
        assert_eq!(response["id"], 3);
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("session drift"));
        assert!(pending.is_empty());

        let fresh = br#"{"jsonrpc":"2.0","id":4,"method":"thread/start","params":{}}
"#;
        assert!(matches!(
            inspect_client_line(
                fresh,
                Some("thread-original"),
                None,
                &mut pending,
                &mut delivery_instruction_pending,
            ),
            ClientLineAction::Reject(_)
        ));
    }

    #[test]
    fn matching_resume_is_forwarded_and_tracked() {
        let mut pending = HashMap::new();
        let mut delivery_instruction_pending = false;
        let request = br#"{"jsonrpc":"2.0","id":7,"method":"thread/resume","params":{"threadId":"thread-original"}}
"#;
        assert!(matches!(
            inspect_client_line(
                request,
                Some("thread-original"),
                None,
                &mut pending,
                &mut delivery_instruction_pending,
            ),
            ClientLineAction::Forward(_)
        ));
        assert_eq!(
            pending
                .get("7")
                .map(|item| item.requested_thread_id.as_str()),
            Some("thread-original")
        );
    }

    #[test]
    fn local_handoff_resume_does_not_inject_synthetic_provider() {
        let mut pending = HashMap::new();
        let mut delivery_instruction_pending = false;
        let request = br#"{"jsonrpc":"2.0","id":14,"method":"thread/resume","params":{"threadId":"thread-original"}}
"#;
        let ClientLineAction::Forward(forwarded) = inspect_client_line(
            request,
            Some("thread-original"),
            None,
            &mut pending,
            &mut delivery_instruction_pending,
        ) else {
            panic!("managed local resume must be forwarded");
        };
        let forwarded: Value = serde_json::from_slice(trim_line_ending(&forwarded)).unwrap();
        assert!(forwarded["params"].get("modelProvider").is_none());
        assert_eq!(forwarded["params"]["threadId"], "thread-original");
        assert!(pending.contains_key("14"));
    }

    #[test]
    fn ssh_resume_rewrites_placeholder_cwd_to_remote_directory() {
        let mut pending = HashMap::new();
        let mut delivery_instruction_pending = false;
        let request = br#"{"jsonrpc":"2.0","id":8,"method":"thread/resume","params":{"threadId":"thread-original","cwd":"C:\\placeholder"}}
"#;
        let ClientLineAction::Forward(forwarded) = inspect_client_line(
            request,
            Some("thread-original"),
            Some("/srv/project"),
            &mut pending,
            &mut delivery_instruction_pending,
        ) else {
            panic!("matching SSH resume must be forwarded");
        };
        let forwarded: Value = serde_json::from_slice(trim_line_ending(&forwarded)).unwrap();
        assert_eq!(forwarded["params"]["cwd"], "/srv/project");
        assert!(pending.contains_key("8"));
    }

    #[test]
    fn local_managed_resume_injects_delivery_instruction_only_once() {
        let mut pending = HashMap::new();
        let mut delivery_instruction_pending = true;
        let first = br#"{"jsonrpc":"2.0","id":9,"method":"turn/start","params":{"threadId":"thread-original","input":[{"type":"localImage","path":"C:\\tmp\\source.png"},{"type":"text","text":"Create the report"}]}}
"#;
        let ClientLineAction::Forward(first) = inspect_client_line(
            first,
            Some("thread-original"),
            None,
            &mut pending,
            &mut delivery_instruction_pending,
        ) else {
            panic!("managed local turn must be forwarded");
        };
        let first: Value = serde_json::from_slice(trim_line_ending(&first)).unwrap();
        assert_eq!(first["params"]["input"][0]["path"], r"C:\tmp\source.png");
        assert_eq!(
            first["params"]["input"][1]["text"],
            format!("{LOCAL_HANDOFF_DELIVERY_INSTRUCTION}\n\nCreate the report")
        );
        assert!(!delivery_instruction_pending);

        let second = br#"{"jsonrpc":"2.0","id":10,"method":"turn/start","params":{"threadId":"thread-original","input":[{"type":"text","text":"Continue"}]}}
"#;
        let ClientLineAction::Forward(forwarded) = inspect_client_line(
            second,
            Some("thread-original"),
            None,
            &mut pending,
            &mut delivery_instruction_pending,
        ) else {
            panic!("subsequent managed local turn must be forwarded");
        };
        assert_eq!(forwarded, second);
    }

    #[test]
    fn delivery_instruction_ignores_ssh_and_unmanaged_turns() {
        let request = br#"{"jsonrpc":"2.0","id":11,"method":"turn/start","params":{"threadId":"thread-original","input":[{"type":"text","text":"Create a file"}]}}
"#;
        let mut pending = HashMap::new();
        let mut ssh_instruction_pending = true;
        let ClientLineAction::Forward(ssh_forwarded) = inspect_client_line(
            request,
            Some("thread-original"),
            Some("/srv/project"),
            &mut pending,
            &mut ssh_instruction_pending,
        ) else {
            panic!("SSH turn must be forwarded");
        };
        assert_eq!(ssh_forwarded, request);
        assert!(ssh_instruction_pending);

        let mut unmanaged_instruction_pending = true;
        let ClientLineAction::Forward(unmanaged_forwarded) = inspect_client_line(
            request,
            None,
            None,
            &mut pending,
            &mut unmanaged_instruction_pending,
        ) else {
            panic!("unmanaged turn must be forwarded");
        };
        assert_eq!(unmanaged_forwarded, request);
        assert!(unmanaged_instruction_pending);
    }

    #[test]
    fn delivery_instruction_waits_for_the_first_text_input() {
        let mut pending = HashMap::new();
        let mut delivery_instruction_pending = true;
        let image_only = br#"{"jsonrpc":"2.0","id":12,"method":"turn/start","params":{"threadId":"thread-original","input":[{"type":"localImage","path":"C:\\tmp\\source.png"}]}}
"#;
        let ClientLineAction::Forward(forwarded) = inspect_client_line(
            image_only,
            Some("thread-original"),
            None,
            &mut pending,
            &mut delivery_instruction_pending,
        ) else {
            panic!("image-only turn must be forwarded");
        };
        assert_eq!(forwarded, image_only);
        assert!(delivery_instruction_pending);

        let text_turn = br#"{"jsonrpc":"2.0","id":13,"method":"turn/start","params":{"threadId":"thread-original","input":[{"type":"text","text":"Now create it"}]}}
"#;
        let ClientLineAction::Forward(forwarded) = inspect_client_line(
            text_turn,
            Some("thread-original"),
            None,
            &mut pending,
            &mut delivery_instruction_pending,
        ) else {
            panic!("text turn must be forwarded");
        };
        let forwarded: Value = serde_json::from_slice(trim_line_ending(&forwarded)).unwrap();
        assert_eq!(
            forwarded["params"]["input"][0]["text"],
            format!("{LOCAL_HANDOFF_DELIVERY_INSTRUCTION}\n\nNow create it")
        );
        assert!(!delivery_instruction_pending);
    }

    #[test]
    fn ssh_codex_command_quotes_paths_environment_and_arguments() {
        let launch = ssh_codex_launch("identity_file");
        let args = vec![
            "app-server".to_string(),
            "--listen".to_string(),
            "stdio://".to_string(),
        ];
        let command = launch.remote_command(&args);

        assert!(command.starts_with("cd -- '/srv/project dir' && exec 3>&1 && exec"));
        assert!(command.contains("\"${SHELL:-/bin/sh}\" -lic"));
        assert!(command.ends_with("1>&2"));
        assert!(command.contains("1>&3 3>&-"));
        assert!(command.contains("source ~/.profile"));
        assert_eq!(
            format_remote_home_path("~/codex config"),
            "\"${HOME}\"/'codex config'"
        );
        for expected in [
            "CODEX_HOME",
            "${HOME}",
            "GIT_CONFIG_KEY_0",
            "safe.directory",
            "codex",
            "app-server",
            "--listen",
            "stdio://",
        ] {
            assert!(command.contains(expected), "missing {expected}: {command}");
        }

        let transport = launch.build_launch(&args).unwrap();
        assert_eq!(transport.args.first().map(String::as_str), Some("-T"));
        assert_eq!(transport.args.last(), Some(&command));
    }

    #[test]
    fn ssh_codex_launch_rejects_interactive_authentication() {
        for auth_mode in ["password_prompt", "interactive"] {
            assert_eq!(
                ssh_codex_launch(auth_mode).encode().unwrap_err(),
                "handoff_ssh_interactive_auth_unsupported"
            );
        }
    }

    #[test]
    fn ssh_codex_launch_serialization_contains_only_the_credential_reference() {
        let launch = ssh_codex_launch("credential_ref");
        let encoded = launch.encode().unwrap();
        let decoded = BASE64_STANDARD.decode(encoded).unwrap();
        let document: Value = serde_json::from_slice(&decoded).unwrap();

        assert_eq!(
            document.pointer("/transport/credentialRef"),
            Some(&Value::String("cli-manager:ssh:host-1".to_string()))
        );
        assert!(document.pointer("/transport/password").is_none());
        assert!(document.get("password").is_none());
    }

    #[test]
    fn ssh_app_server_events_drive_handoff_notifications() {
        let started = json_line(&json!({
            "jsonrpc": "2.0",
            "method": "turn/started",
            "params": {
                "threadId": "thread-original",
                "turn": { "id": "turn-1", "status": "inProgress" }
            }
        }));
        let started =
            ssh_handoff_hook_payload(&started, "local-session", Some("thread-original")).unwrap();
        assert_eq!(started["tabId"], "local-session");
        assert_eq!(started["event"], "UserPromptSubmit");
        assert_eq!(started["sessionId"], "thread-original");

        let approval = json_line(&json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thread-original",
                "turnId": "turn-1",
                "itemId": "item-1"
            }
        }));
        let approval =
            ssh_handoff_hook_payload(&approval, "local-session", Some("thread-original")).unwrap();
        assert_eq!(approval["event"], "PermissionRequest");
        assert_eq!(approval["toolUseId"], "item-1");

        let completed = json_line(&json!({
            "jsonrpc": "2.0",
            "method": "turn/completed",
            "params": {
                "threadId": "thread-original",
                "turn": { "id": "turn-1", "status": "failed" }
            }
        }));
        let completed =
            ssh_handoff_hook_payload(&completed, "local-session", Some("thread-original")).unwrap();
        assert_eq!(completed["event"], "StopFailure");
    }

    #[test]
    fn ssh_handoff_notifications_ignore_retrying_errors_and_session_drift() {
        let retrying = json_line(&json!({
            "jsonrpc": "2.0",
            "method": "error",
            "params": {
                "threadId": "thread-original",
                "turnId": "turn-1",
                "willRetry": true,
                "error": { "message": "temporary" }
            }
        }));
        assert!(
            ssh_handoff_hook_payload(&retrying, "local-session", Some("thread-original"),)
                .is_none()
        );

        let drifted = json_line(&json!({
            "jsonrpc": "2.0",
            "method": "turn/started",
            "params": {
                "threadId": "thread-other",
                "turn": { "id": "turn-2", "status": "inProgress" }
            }
        }));
        assert!(
            ssh_handoff_hook_payload(&drifted, "local-session", Some("thread-original"),).is_none()
        );
    }
}
