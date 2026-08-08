use super::grok::{self, CredentialProjection};
use super::home::{self, HomeIdentity, HomeSelectInput, ProviderHomeState};
use crate::{app_paths, shell_resolver, wsl};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use toml_edit::{DocumentMut, Item, Table, Value as TomlValue};
use uuid::Uuid;

const WSL_OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
const CLAUDE_SETTINGS_FILE: &str = "settings.json";
const CODEX_AUTH_FILE: &str = "auth.json";
const CODEX_CONFIG_FILE: &str = "config.toml";
const GROK_CONFIG_FILE: &str = "config.toml";
const CODEX_DEFAULT_PROVIDER_NAME: &str = "cli_manager";

const CLAUDE_OWNED_ENV_KEYS: [&str; 14] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];
const CODEX_OWNED_AUTH_KEYS: [&str; 2] = ["OPENAI_API_KEY", "api_key"];
const CODEX_OWNED_CONFIG_KEYS: [&str; 3] = ["model", "model_provider", "model_providers"];
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeIdentityInput {
    pub environment_kind: String,
    pub environment_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalPreviewInput {
    pub app_type: String,
    pub provider_id: String,
    pub home_identity: HomeIdentityInput,
    #[serde(default)]
    pub projection: Option<LocalRouteProjection>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalApplyInput {
    pub app_type: String,
    pub provider_id: String,
    pub home_identity: HomeIdentityInput,
    pub preview_fingerprint: String,
    #[serde(default)]
    pub projection: Option<LocalRouteProjection>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalRouteProjection {
    pub endpoint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalCurrentInput {
    pub app_type: String,
    pub home_identity: HomeIdentityInput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalTargetPreview {
    pub target: String,
    pub path: String,
    pub exists: bool,
    pub live_fingerprint: String,
    pub desired_fingerprint: String,
    pub changed: bool,
    pub action: String,
    pub owned_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalPreview {
    pub app_type: String,
    pub provider_id: String,
    pub provider_name: String,
    pub home: ProviderHomeState,
    pub fingerprint: String,
    pub targets: Vec<GlobalTargetPreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalApplyResult {
    pub app_type: String,
    pub provider_id: String,
    pub home_identity: HomeIdentity,
    pub journal_id: String,
    pub state: String,
    pub changed_targets: Vec<String>,
    pub verified_fingerprints: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalCurrent {
    pub app_type: String,
    pub home: ProviderHomeState,
    pub provider_id: Option<String>,
    pub provider_name: Option<String>,
    pub active_key_present: bool,
    pub state: String,
    pub pending_recovery: bool,
    pub targets: Vec<GlobalTargetPreview>,
}

#[derive(Debug, Clone)]
struct ProviderPlan {
    app_type: String,
    provider_id: String,
    provider_name: String,
    home: ProviderHomeState,
    targets: Vec<PlannedTarget>,
}

#[derive(Debug, Clone)]
struct CurrentCandidate {
    id: String,
    name: String,
    is_current: bool,
    active_key_present: bool,
}

#[derive(Debug, Clone)]
struct PlannedTarget {
    target: String,
    path: String,
    before: Option<Vec<u8>>,
    desired: Vec<u8>,
    owned_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalTarget {
    target: String,
    backup_path: Option<String>,
    stage_path: String,
    existed: bool,
}

struct ApplyLock {
    key: String,
}

static APPLY_LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn acquire_apply_lock(app_type: &str, home_identity: &str) -> Result<ApplyLock, String> {
    let locks = APPLY_LOCKS.get_or_init(|| Mutex::new(HashSet::new()));
    let key = format!("{app_type}:{home_identity}");
    let mut values = locks
        .lock()
        .map_err(|_| "provider_apply_lock_unavailable".to_string())?;
    if !values.insert(key.clone()) {
        return Err("provider_apply_busy".to_string());
    }
    Ok(ApplyLock { key })
}

impl Drop for ApplyLock {
    fn drop(&mut self) {
        if let Some(locks) = APPLY_LOCKS.get() {
            if let Ok(mut values) = locks.lock() {
                values.remove(&self.key);
            }
        }
    }
}

enum LivePath {
    Local(PathBuf),
    Wsl { distro: String, linux_path: String },
}

fn normalize_type(value: &str) -> Result<String, String> {
    crate::provider::repository::normalize_app_type(value)
}

fn home_input(identity: &HomeIdentityInput) -> HomeSelectInput {
    HomeSelectInput {
        environment_kind: identity.environment_kind.clone(),
        environment_id: identity.environment_id.clone(),
        mode: "auto".to_string(),
        home_path: None,
    }
}

fn target_path(home: &ProviderHomeState, app_type: &str, name: &str) -> String {
    let root = match app_type {
        "claude" => &home.targets.claude_config_dir,
        "codex" => &home.targets.codex_config_dir,
        _ => &home.targets.grok_config_dir,
    };
    PathBuf::from(root)
        .join(name)
        .to_string_lossy()
        .into_owned()
}

fn live_path(path: &str) -> LivePath {
    if let Some((distro, linux_path)) = wsl::parse_wsl_unc_path(path) {
        LivePath::Wsl { distro, linux_path }
    } else {
        LivePath::Local(PathBuf::from(path))
    }
}

fn wsl_command(distro: &str, program: &str, args: &[&str]) -> Result<Command, String> {
    let exe = wsl::find_wsl_exe().ok_or_else(|| "provider_wsl_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg(program)
        .args(args);
    Ok(command)
}

fn run_wsl(distro: &str, program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    shell_resolver::output_with_timeout(wsl_command(distro, program, args)?, WSL_OPERATION_TIMEOUT)
        .map_err(|_| "provider_wsl_operation_failed".to_string())
}

fn run_wsl_with_input(
    distro: &str,
    program: &str,
    args: &[&str],
    input: &[u8],
) -> Result<(), String> {
    let mut command = wsl_command(distro, program, args)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "provider_wsl_operation_failed".to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        if stdin.write_all(input).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("provider_wsl_operation_failed".to_string());
        }
    }
    let deadline = std::time::Instant::now() + WSL_OPERATION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("provider_wsl_operation_failed".to_string())
                };
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("provider_wsl_operation_timeout".to_string());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("provider_wsl_operation_failed".to_string());
            }
        }
    }
}

pub(crate) fn read_live(path: &str) -> Result<Option<Vec<u8>>, String> {
    match live_path(path) {
        LivePath::Local(path) => match fs::read(path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("provider_target_read_failed".to_string()),
        },
        LivePath::Wsl { distro, linux_path } => {
            let exists = run_wsl(&distro, "test", &["-e", &linux_path])
                .map_err(|_| "provider_target_read_failed".to_string())?;
            if !exists.status.success() {
                return Ok(None);
            }
            let output = run_wsl(&distro, "cat", &[&linux_path])?;
            if !output.status.success() {
                return Err("provider_target_read_failed".to_string());
            }
            Ok(Some(output.stdout))
        }
    }
}

pub(crate) fn live_is_file(path: &str) -> bool {
    match live_path(path) {
        LivePath::Local(path) => path.is_file(),
        LivePath::Wsl { distro, linux_path } => run_wsl(&distro, "test", &["-f", &linux_path])
            .ok()
            .is_some_and(|output| output.status.success()),
    }
}

pub(crate) fn live_is_dir(path: &str) -> bool {
    match live_path(path) {
        LivePath::Local(path) => path.is_dir(),
        LivePath::Wsl { distro, linux_path } => run_wsl(&distro, "test", &["-d", &linux_path])
            .ok()
            .is_some_and(|output| output.status.success()),
    }
}

pub(crate) fn create_live_dir_all(path: &str) -> Result<(), String> {
    match live_path(path) {
        LivePath::Local(path) => {
            fs::create_dir_all(path).map_err(|_| "provider_target_directory_failed".to_string())
        }
        LivePath::Wsl { distro, linux_path } => {
            let output = run_wsl(&distro, "mkdir", &["-p", &linux_path])?;
            if output.status.success() {
                Ok(())
            } else {
                Err("provider_target_directory_failed".to_string())
            }
        }
    }
}

pub(crate) fn target_writable(path: &str) -> bool {
    match live_path(path) {
        LivePath::Local(path) => match fs::metadata(&path) {
            Ok(metadata) => metadata.is_file() && !metadata.permissions().readonly(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => path
                .parent()
                .and_then(|parent| {
                    let existing = parent.ancestors().find(|candidate| candidate.is_dir())?;
                    fs::metadata(existing).ok()
                })
                .map(|metadata| !metadata.permissions().readonly())
                .unwrap_or(false),
            Err(_) => false,
        },
        LivePath::Wsl { distro, linux_path } => {
            let parent =
                linux_path
                    .rsplit_once('/')
                    .map(|(parent, _)| if parent.is_empty() { "/" } else { parent });
            match run_wsl(&distro, "test", &["-e", &linux_path]) {
                Ok(output) if output.status.success() => {
                    run_wsl(&distro, "test", &["-f", &linux_path])
                        .ok()
                        .filter(|output| output.status.success())
                        .and_then(|_| run_wsl(&distro, "test", &["-w", &linux_path]).ok())
                        .map(|output| output.status.success())
                        .unwrap_or(false)
                }
                Ok(_) => parent
                    .map(|_| wsl_writable_parent(&distro, &linux_path))
                    .unwrap_or(false),
                Err(_) => false,
            }
        }
    }
}

fn wsl_writable_parent(distro: &str, linux_path: &str) -> bool {
    let mut current = linux_path
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or("/")
        .to_string();
    loop {
        if run_wsl(distro, "test", &["-d", &current])
            .ok()
            .is_some_and(|output| output.status.success())
        {
            return run_wsl(distro, "test", &["-w", &current])
                .ok()
                .is_some_and(|output| output.status.success());
        }
        if current == "/" {
            return false;
        }
        current = current
            .rsplit_once('/')
            .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
            .unwrap_or("/")
            .to_string();
    }
}

fn ensure_parent(path: &str) -> Result<(), String> {
    match live_path(path) {
        LivePath::Local(path) => path
            .parent()
            .ok_or_else(|| "provider_target_parent_invalid".to_string())
            .and_then(|parent| {
                fs::create_dir_all(parent)
                    .map_err(|_| "provider_target_directory_failed".to_string())
            }),
        LivePath::Wsl { distro, linux_path } => {
            let parent = linux_path
                .rsplit_once('/')
                .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
                .ok_or_else(|| "provider_target_parent_invalid".to_string())?;
            let output = run_wsl(&distro, "mkdir", &["-p", parent])?;
            if output.status.success() {
                Ok(())
            } else {
                Err("provider_target_directory_failed".to_string())
            }
        }
    }
}

pub(crate) fn write_live(path: &str, bytes: &[u8]) -> Result<(), String> {
    ensure_parent(path)?;
    match live_path(path) {
        LivePath::Local(path) => {
            fs::write(path, bytes).map_err(|_| "provider_target_write_failed".to_string())
        }
        LivePath::Wsl { distro, linux_path } => run_wsl_with_input(
            &distro,
            "sh",
            &["-c", "cat > \"$1\"", "cli-manager", &linux_path],
            bytes,
        ),
    }
}

pub(crate) fn remove_live(path: &str) -> Result<(), String> {
    match live_path(path) {
        LivePath::Local(path) => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("provider_target_restore_failed".to_string()),
        },
        LivePath::Wsl { distro, linux_path } => {
            let output = run_wsl(&distro, "rm", &["-f", &linux_path])?;
            if output.status.success() {
                Ok(())
            } else {
                Err("provider_target_restore_failed".to_string())
            }
        }
    }
}

fn fingerprint(bytes: Option<&[u8]>) -> String {
    let Some(bytes) = bytes else {
        return "missing".to_string();
    };
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn aggregate_fingerprint(values: &BTreeMap<String, String>) -> String {
    let raw = serde_json::to_vec(values).unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(raw))
}

fn parse_json_object(bytes: Option<&[u8]>) -> Result<Map<String, Value>, String> {
    let Some(bytes) = bytes else {
        return Ok(Map::new());
    };
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Map::new());
    }
    let value = serde_json::from_slice::<Value>(bytes)
        .map_err(|_| "provider_config_invalid".to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "provider_config_invalid".to_string())
}

fn json_bytes(object: Map<String, Value>) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(&Value::Object(object))
        .map_err(|_| "provider_config_invalid".to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn toml_document(bytes: Option<&[u8]>) -> Result<DocumentMut, String> {
    let Some(bytes) = bytes else {
        return Ok(DocumentMut::new());
    };
    let raw = std::str::from_utf8(bytes).map_err(|_| "provider_config_invalid".to_string())?;
    if raw.trim().is_empty() {
        return Ok(DocumentMut::new());
    }
    raw.parse::<DocumentMut>()
        .map_err(|_| "provider_config_invalid".to_string())
}

fn settings_config(value: &str) -> Result<Value, String> {
    let settings =
        serde_json::from_str::<Value>(value).map_err(|_| "provider_config_invalid".to_string())?;
    if settings.is_object() {
        Ok(settings)
    } else {
        Err("provider_config_invalid".to_string())
    }
}

fn provider_owned_env(effective: &Value, secret: &str) -> Result<Map<String, Value>, String> {
    let env = effective
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut desired = Map::new();
    for key in CLAUDE_OWNED_ENV_KEYS {
        if let Some(value) = env.get(key) {
            desired.insert(key.to_string(), value.clone());
        }
    }
    let credential_key = match (
        env.contains_key("ANTHROPIC_AUTH_TOKEN"),
        env.contains_key("ANTHROPIC_API_KEY"),
    ) {
        (true, true) => {
            let auth_token_non_empty = env
                .get("ANTHROPIC_AUTH_TOKEN")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
            let api_key_non_empty = env
                .get("ANTHROPIC_API_KEY")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
            if !auth_token_non_empty && api_key_non_empty {
                "ANTHROPIC_AUTH_TOKEN"
            } else if auth_token_non_empty && !api_key_non_empty {
                "ANTHROPIC_API_KEY"
            } else {
                "ANTHROPIC_AUTH_TOKEN"
            }
        }
        (false, true) => "ANTHROPIC_API_KEY",
        _ => "ANTHROPIC_AUTH_TOKEN",
    };
    desired.insert(
        credential_key.to_string(),
        Value::String(secret.to_string()),
    );
    desired.remove(if credential_key == "ANTHROPIC_API_KEY" {
        "ANTHROPIC_AUTH_TOKEN"
    } else {
        "ANTHROPIC_API_KEY"
    });
    Ok(desired)
}

pub(crate) fn materialize_claude(
    before: Option<&[u8]>,
    effective: &Value,
    secret: &str,
) -> Result<(Vec<u8>, Vec<String>), String> {
    let mut root = parse_json_object(before)?;
    let mut env = root
        .remove("env")
        .unwrap_or_else(|| Value::Object(Map::new()))
        .as_object()
        .cloned()
        .ok_or_else(|| "provider_config_invalid".to_string())?;
    let desired = provider_owned_env(effective, secret)?;
    for key in CLAUDE_OWNED_ENV_KEYS {
        if let Some(value) = desired.get(key) {
            env.insert(key.to_string(), value.clone());
        } else {
            env.remove(key);
        }
    }
    root.insert("env".to_string(), Value::Object(env));
    Ok((
        json_bytes(root)?,
        CLAUDE_OWNED_ENV_KEYS
            .iter()
            .map(|key| key.to_string())
            .collect(),
    ))
}

pub(crate) fn materialize_codex_auth(
    before: Option<&[u8]>,
    _effective: &Value,
    secret: &str,
) -> Result<(Vec<u8>, Vec<String>), String> {
    let mut root = parse_json_object(before)?;
    for key in CODEX_OWNED_AUTH_KEYS {
        root.remove(key);
    }
    root.remove("auth");
    root.insert(
        "OPENAI_API_KEY".to_string(),
        Value::String(secret.to_string()),
    );
    Ok((
        json_bytes(root)?,
        CODEX_OWNED_AUTH_KEYS
            .iter()
            .map(|key| key.to_string())
            .collect(),
    ))
}

fn copy_toml_owned(source: &DocumentMut, target: &mut DocumentMut, keys: &[&str]) -> Vec<String> {
    for key in keys {
        if let Some(item) = source.get(key) {
            target[key] = item.clone();
        } else {
            target.remove(key);
        }
    }
    keys.iter().map(|key| (*key).to_string()).collect()
}

pub(crate) fn materialize_codex_config(
    before: Option<&[u8]>,
    effective: &Value,
) -> Result<(Vec<u8>, Vec<String>), String> {
    let source_raw = effective
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source = if source_raw.trim().is_empty() {
        DocumentMut::new()
    } else {
        source_raw
            .parse::<DocumentMut>()
            .map_err(|_| "provider_config_invalid".to_string())?
    };
    let mut target = toml_document(before)?;
    let owned = copy_toml_owned(&source, &mut target, &CODEX_OWNED_CONFIG_KEYS);
    for key in ["base_url", "wire_api", "requires_openai_auth", "env_key"] {
        target.remove(key);
    }
    let provider_name = source
        .get("model_provider")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            let table = source.get("model_providers")?.as_table()?;
            let mut entries = table.iter();
            let (name, _) = entries.next()?;
            entries.next().is_none().then(|| name.to_string())
        })
        .unwrap_or_else(|| CODEX_DEFAULT_PROVIDER_NAME.to_string());
    let base_url = effective.get("base_url").and_then(Value::as_str);
    let model = effective.get("model").and_then(Value::as_str);
    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        target["model"] = toml_edit::value(model);
    }
    if base_url.is_some() {
        target["model_provider"] = toml_edit::value(provider_name.as_str());
        ensure_codex_provider_mapping(&mut target, &provider_name, base_url)?;
    }
    sanitize_codex_model_providers(&mut target);
    Ok((target.to_string().into_bytes(), owned))
}

fn ensure_codex_provider_mapping(
    target: &mut DocumentMut,
    provider_name: &str,
    base_url: Option<&str>,
) -> Result<(), String> {
    if target.get("model_providers").is_none() {
        target["model_providers"] = toml_edit::table();
    }
    let providers = target
        .get_mut("model_providers")
        .and_then(|item| item.as_table_mut())
        .ok_or_else(|| "provider_config_invalid".to_string())?;
    let provider = providers
        .entry(provider_name)
        .or_insert(toml_edit::table())
        .as_table_mut()
        .ok_or_else(|| "provider_config_invalid".to_string())?;
    if provider.get("name").is_none() {
        provider.insert("name", toml_edit::value("CLI-Manager"));
    }
    if let Some(base_url) = base_url {
        provider.insert("base_url", toml_edit::value(base_url));
    }
    Ok(())
}

fn is_toml_secret_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace(['-', '.'], "_");
    matches!(
        normalized.as_str(),
        "access_token"
            | "refresh_token"
            | "oauth_token"
            | "authorization"
            | "auth_header"
            | "bearer"
            | "password"
            | "passwd"
            | "secret"
            | "client_secret"
            | "clientsecret"
            | "api_key"
            | "apikey"
    ) || normalized.ends_with("_token")
        || normalized.ends_with("token")
        || normalized.ends_with("_secret")
        || normalized.ends_with("secret")
        || normalized.ends_with("_password")
        || normalized.ends_with("password")
        || normalized.ends_with("_api_key")
        || normalized.ends_with("apikey")
}

fn remove_toml_secret_fields(item: &mut Item) -> bool {
    match item {
        Item::Table(table) => remove_toml_secret_table(table),
        Item::ArrayOfTables(tables) => {
            let mut removed = false;
            for table in tables.iter_mut() {
                removed |= remove_toml_secret_table(table);
            }
            removed
        }
        Item::Value(value) => remove_toml_secret_value(value),
        Item::None => false,
    }
}

fn remove_toml_secret_table(table: &mut Table) -> bool {
    let secret_keys = table
        .iter()
        .filter(|(key, _)| is_toml_secret_key(key))
        .map(|(key, _)| key.to_string())
        .collect::<Vec<_>>();
    let mut removed = false;
    for key in secret_keys {
        removed |= table.remove(&key).is_some();
    }
    for (_, child) in table.iter_mut() {
        removed |= remove_toml_secret_fields(child);
    }
    removed
}

fn remove_toml_secret_value(value: &mut TomlValue) -> bool {
    let mut removed = false;
    if let Some(table) = value.as_inline_table_mut() {
        let secret_keys = table
            .iter()
            .filter(|(key, _)| is_toml_secret_key(key))
            .map(|(key, _)| key.to_string())
            .collect::<Vec<_>>();
        for key in secret_keys {
            removed |= table.remove(&key).is_some();
        }
        for (_, child) in table.iter_mut() {
            removed |= remove_toml_secret_value(child);
        }
    }
    if let Some(array) = value.as_array_mut() {
        for child in array.iter_mut() {
            removed |= remove_toml_secret_value(child);
        }
    }
    removed
}

fn sanitize_codex_model_providers(target: &mut DocumentMut) {
    let Some(item) = target.get_mut("model_providers") else {
        return;
    };
    let Some(table) = item.as_table_mut() else {
        return;
    };
    for (_, provider) in table.iter_mut() {
        remove_toml_secret_fields(provider);
        let Some(provider_table) = provider.as_table_mut() else {
            continue;
        };
        provider_table.remove("env_key");
    }
}

pub(crate) fn materialize_grok_global_config(
    before: Option<&[u8]>,
    effective: &Value,
    secret: &str,
) -> Result<(Vec<u8>, Vec<String>), String> {
    grok::materialize(before, effective, CredentialProjection::Inline(secret))
}

struct ProviderSource {
    id: String,
    name: String,
    settings_config: String,
    meta: String,
    active_key: String,
}

async fn load_source(app_type: &str, provider_id: &str) -> Result<ProviderSource, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, name, settings_config, meta
         FROM providers WHERE id = ?1 AND app_type = ?2",
    )
    .bind(provider_id.trim())
    .bind(app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .ok_or_else(|| "provider_not_found".to_string())?;

    let id = row
        .try_get::<String, _>("id")
        .map_err(|_| "provider_database_error".to_string())?;
    let name = row
        .try_get::<String, _>("name")
        .map_err(|_| "provider_database_error".to_string())?;
    let settings_config = row
        .try_get::<String, _>("settings_config")
        .map_err(|_| "provider_database_error".to_string())?;
    let meta = row
        .try_get::<String, _>("meta")
        .map_err(|_| "provider_database_error".to_string())?;
    if !crate::provider::repository::meta_enabled(&crate::provider::repository::parse_meta(&meta)) {
        return Err("provider_not_ready".to_string());
    }
    let active_key = sqlx::query(
        "SELECT api_key FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2 AND is_active = 1 AND enabled = 1
         LIMIT 1",
    )
    .bind(&id)
    .bind(app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .and_then(|row| row.try_get::<String, _>("api_key").ok())
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| "provider_key_not_active".to_string())?;

    Ok(ProviderSource {
        id,
        name,
        settings_config,
        meta,
        active_key,
    })
}

async fn effective_settings(
    connection: &mut sqlx::SqliteConnection,
    app_type: &str,
    source: &ProviderSource,
) -> Result<Value, String> {
    let common = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(format!("common_config_{app_type}"))
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| "provider_database_error".to_string())?
        .unwrap_or_default();
    let meta = crate::provider::repository::parse_meta(&source.meta);
    let merged = if crate::provider::repository::meta_common_config_enabled(&meta) {
        crate::provider::repository::merge_common_into_settings(
            app_type,
            &common,
            &source.settings_config,
        )?
    } else {
        source.settings_config.clone()
    };
    let projected = crate::provider::repository::project_key_into_settings(
        app_type,
        &merged,
        &source.active_key,
    )?;
    settings_config(&projected)
}

async fn build_plan(input: &GlobalPreviewInput) -> Result<ProviderPlan, String> {
    let app_type = normalize_type(&input.app_type)?;
    let provider_id = input.provider_id.trim();
    if provider_id.is_empty() {
        return Err("provider_id_required".to_string());
    }
    let home = home::get(home_input(&input.home_identity)).await?;
    let source = load_source(&app_type, provider_id).await?;
    let mut connection = crate::provider::database::open_connection().await?;
    let effective = effective_settings(&mut connection, &app_type, &source).await?;

    let specs: Vec<(&str, &str)> = match app_type.as_str() {
        "claude" => vec![("claude.settings", CLAUDE_SETTINGS_FILE)],
        "codex" => vec![
            ("codex.auth", CODEX_AUTH_FILE),
            ("codex.config", CODEX_CONFIG_FILE),
        ],
        "grokbuild" => vec![("grokbuild.config", GROK_CONFIG_FILE)],
        _ => return Err("provider_invalid_app_type".to_string()),
    };
    let mut targets = Vec::with_capacity(specs.len());
    for (target, name) in specs {
        let path = target_path(&home, &app_type, name);
        let before = read_live(&path)?;
        let (desired, owned_fields) = match (app_type.as_str(), target) {
            ("claude", _) => materialize_claude(before.as_deref(), &effective, &source.active_key)?,
            ("codex", "codex.auth") => {
                materialize_codex_auth(before.as_deref(), &effective, &source.active_key)?
            }
            ("codex", "codex.config") => materialize_codex_config(before.as_deref(), &effective)?,
            ("grokbuild", _) => {
                materialize_grok_global_config(before.as_deref(), &effective, &source.active_key)?
            }
            _ => return Err("provider_invalid_app_type".to_string()),
        };
        targets.push(PlannedTarget {
            target: target.to_string(),
            path,
            before,
            desired,
            owned_fields,
        });
    }
    let mut plan = ProviderPlan {
        app_type,
        provider_id: source.id,
        provider_name: source.name,
        home,
        targets,
    };
    if let Some(projection) = input.projection.as_ref() {
        apply_local_route_projection(&mut plan, projection)?;
    }
    Ok(plan)
}

const ROUTED_CREDENTIAL_SENTINEL: &str = "CLI_MANAGER_ROUTED";

fn route_endpoint_with_suffix(endpoint: &str, suffix: &str) -> Result<String, String> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    let port = endpoint
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .filter(|port| *port >= 1_024)
        .ok_or_else(|| "routing_endpoint_invalid".to_string())?;
    let host = endpoint
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or_default();
    let is_loopback =
        host == "http://127.0.0.1" || host == "http://localhost" || host == "http://[::1]";
    let is_ipv4_gateway = host
        .strip_prefix("http://")
        .and_then(|value| value.parse::<std::net::Ipv4Addr>().ok())
        .is_some_and(|address| {
            !address.is_unspecified() && !address.is_loopback() && !address.is_multicast()
        });
    if !is_loopback && !is_ipv4_gateway {
        return Err("routing_endpoint_invalid".to_string());
    }
    Ok(format!("{host}:{port}{suffix}"))
}

fn apply_local_route_projection(
    plan: &mut ProviderPlan,
    projection: &LocalRouteProjection,
) -> Result<(), String> {
    let endpoint = route_endpoint_with_suffix(&projection.endpoint, "")?;
    let codex_endpoint = route_endpoint_with_suffix(&projection.endpoint, "/v1")?;
    for target in &mut plan.targets {
        target.desired = match target.target.as_str() {
            "claude.settings" => {
                let mut root = parse_json_object(Some(&target.desired))?;
                let mut env = root
                    .remove("env")
                    .unwrap_or_else(|| Value::Object(Map::new()))
                    .as_object()
                    .cloned()
                    .ok_or_else(|| "provider_config_invalid".to_string())?;
                env.insert(
                    "ANTHROPIC_BASE_URL".to_string(),
                    Value::String(endpoint.clone()),
                );
                env.insert(
                    "ANTHROPIC_API_KEY".to_string(),
                    Value::String(ROUTED_CREDENTIAL_SENTINEL.to_string()),
                );
                env.remove("ANTHROPIC_AUTH_TOKEN");
                root.insert("env".to_string(), Value::Object(env));
                json_bytes(root)?
            }
            "codex.auth" => {
                let mut root = parse_json_object(Some(&target.desired))?;
                for key in CODEX_OWNED_AUTH_KEYS {
                    root.remove(key);
                }
                root.insert(
                    "OPENAI_API_KEY".to_string(),
                    Value::String(ROUTED_CREDENTIAL_SENTINEL.to_string()),
                );
                json_bytes(root)?
            }
            "codex.config" => {
                let mut document = toml_document(Some(&target.desired))?;
                let provider_name = document
                    .get("model_provider")
                    .and_then(Item::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(CODEX_DEFAULT_PROVIDER_NAME)
                    .to_string();
                ensure_codex_provider_mapping(
                    &mut document,
                    &provider_name,
                    Some(&codex_endpoint),
                )?;
                document.to_string().into_bytes()
            }
            "grokbuild.config" => {
                let mut document = toml_document(Some(&target.desired))?;
                let profile = document
                    .get("models")
                    .and_then(Item::as_table)
                    .and_then(|models| models.get("default"))
                    .and_then(Item::as_str)
                    .unwrap_or("proxy")
                    .to_string();
                let model = document
                    .get_mut("model")
                    .and_then(Item::as_table_mut)
                    .ok_or_else(|| "provider_config_invalid".to_string())?;
                let selected = model
                    .entry(&profile)
                    .or_insert(toml_edit::table())
                    .as_table_mut()
                    .ok_or_else(|| "provider_config_invalid".to_string())?;
                selected.insert("base_url", toml_edit::value(endpoint.clone()));
                selected.insert("api_key", toml_edit::value(ROUTED_CREDENTIAL_SENTINEL));
                document.to_string().into_bytes()
            }
            _ => return Err("provider_invalid_app_type".to_string()),
        };
    }
    Ok(())
}

fn plan_preview(plan: &ProviderPlan) -> GlobalPreview {
    let mut snapshot = BTreeMap::new();
    snapshot.insert("plan.app_type".to_string(), plan.app_type.clone());
    snapshot.insert("plan.provider_id".to_string(), plan.provider_id.clone());
    snapshot.insert(
        "plan.home_identity".to_string(),
        plan.home.identity.identity.clone(),
    );
    let targets = plan
        .targets
        .iter()
        .map(|target| {
            let live_fingerprint = fingerprint(target.before.as_deref());
            let desired_fingerprint = fingerprint(Some(&target.desired));
            snapshot.insert(format!("live:{}", target.path), live_fingerprint.clone());
            snapshot.insert(
                format!("desired:{}", target.path),
                desired_fingerprint.clone(),
            );
            let changed = target.before.as_deref() != Some(target.desired.as_slice());
            GlobalTargetPreview {
                target: target.target.clone(),
                path: target.path.clone(),
                exists: target.before.is_some(),
                live_fingerprint,
                desired_fingerprint,
                changed,
                action: if !changed {
                    "unchanged".to_string()
                } else if target.before.is_some() {
                    "update".to_string()
                } else {
                    "create".to_string()
                },
                owned_fields: target.owned_fields.clone(),
            }
        })
        .collect();
    GlobalPreview {
        app_type: plan.app_type.clone(),
        provider_id: plan.provider_id.clone(),
        provider_name: plan.provider_name.clone(),
        home: plan.home.clone(),
        fingerprint: aggregate_fingerprint(&snapshot),
        targets,
    }
}

fn plan_matches_live(plan: &ProviderPlan) -> bool {
    !plan.targets.is_empty()
        && plan
            .targets
            .iter()
            .all(|target| target.before.as_deref() == Some(target.desired.as_slice()))
}

fn backup_root(journal_id: &str) -> Result<PathBuf, String> {
    Ok(app_paths::cli_manager_data_dir()?
        .join("backups")
        .join("providers")
        .join(journal_id))
}

fn journal_targets(plan: &ProviderPlan, journal_id: &str) -> Result<Vec<JournalTarget>, String> {
    let backup_root = backup_root(journal_id)?;
    plan.targets
        .iter()
        .enumerate()
        .map(|(index, target)| {
            Ok(JournalTarget {
                target: target.path.clone(),
                backup_path: target.before.as_ref().map(|_| {
                    backup_root
                        .join(format!("{index}.backup"))
                        .to_string_lossy()
                        .into_owned()
                }),
                stage_path: stage_path_for_target(&target.path, journal_id, index)?,
                existed: target.before.is_some(),
            })
        })
        .collect()
}

fn stage_path_for_target(path: &str, journal_id: &str, index: usize) -> Result<String, String> {
    match live_path(path) {
        LivePath::Local(path) => {
            let parent = path
                .parent()
                .ok_or_else(|| "provider_apply_stage_failed".to_string())?;
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "provider_apply_stage_failed".to_string())?;
            Ok(parent
                .join(format!(".{name}.{journal_id}.{index}.stage"))
                .to_string_lossy()
                .into_owned())
        }
        LivePath::Wsl { distro, linux_path } => {
            let (parent, name) = linux_path
                .rsplit_once('/')
                .filter(|(_, name)| !name.is_empty())
                .ok_or_else(|| "provider_apply_stage_failed".to_string())?;
            let parent = if parent.is_empty() { "/" } else { parent };
            let stage = if parent == "/" {
                format!("/.{name}.{journal_id}.{index}.stage")
            } else {
                format!("{parent}/.{name}.{journal_id}.{index}.stage")
            };
            Ok(wsl::linux_to_unc_wsl_path(&stage, &distro))
        }
    }
}

fn replace_local_file(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err("provider_target_write_failed".to_string());
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    fs::rename(source, destination).map_err(|_| "provider_target_write_failed".to_string())
}

pub(crate) fn replace_live_from_stage(target_path: &str, stage_path: &str) -> Result<(), String> {
    match (live_path(stage_path), live_path(target_path)) {
        (LivePath::Local(stage), LivePath::Local(target)) => replace_local_file(&stage, &target),
        (
            LivePath::Wsl {
                distro: stage_distro,
                linux_path: stage_path,
            },
            LivePath::Wsl {
                distro: target_distro,
                linux_path: target_path,
            },
        ) if stage_distro.eq_ignore_ascii_case(&target_distro) => {
            let output = run_wsl(&target_distro, "mv", &["-f", &stage_path, &target_path])
                .map_err(|_| "provider_target_write_failed".to_string())?;
            if output.status.success() {
                Ok(())
            } else {
                Err("provider_target_write_failed".to_string())
            }
        }
        _ => Err("provider_target_write_failed".to_string()),
    }
}

fn stage_plan(plan: &ProviderPlan, journal_targets: &[JournalTarget]) -> Result<(), String> {
    let backup_parent = journal_targets
        .iter()
        .find_map(|target| target.backup_path.as_deref())
        .and_then(|path| PathBuf::from(path).parent().map(PathBuf::from));
    if let Some(backup_parent) = backup_parent {
        fs::create_dir_all(backup_parent)
            .map_err(|_| "provider_apply_backup_failed".to_string())?;
    }
    for (index, target) in plan.targets.iter().enumerate() {
        let journal_target = journal_targets
            .get(index)
            .ok_or_else(|| "provider_apply_stage_failed".to_string())?;
        write_live(&journal_target.stage_path, &target.desired)
            .map_err(|_| "provider_apply_stage_failed".to_string())?;
        let staged = read_live(&journal_target.stage_path)
            .map_err(|_| "provider_apply_stage_failed".to_string())?
            .ok_or_else(|| "provider_apply_stage_failed".to_string())?;
        parse_staged_target(target, &staged)?;
        if let (Some(before), Some(backup_path)) = (&target.before, &journal_target.backup_path) {
            fs::write(backup_path, before)
                .map_err(|_| "provider_apply_backup_failed".to_string())?;
        }
    }
    Ok(())
}

fn parse_staged_target(target: &PlannedTarget, bytes: &[u8]) -> Result<(), String> {
    let result = match target.target.as_str() {
        "claude.settings" | "codex.auth" => parse_json_object(Some(bytes)).map(|_| ()),
        "codex.config" | "grokbuild.config" => toml_document(Some(bytes)).map(|_| ()),
        _ => Err("provider_apply_stage_failed".to_string()),
    };
    result.map_err(|_| "provider_apply_stage_failed".to_string())
}

fn cleanup_stage_files(journal_targets: &[JournalTarget]) {
    for target in journal_targets {
        let _ = remove_live(&target.stage_path);
    }
}

fn cleanup_backup_paths(paths: &[String], allowed_root: Option<&Path>) {
    let mut parents = HashSet::new();
    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        if let Some(root) = allowed_root {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let has_parent_escape = relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            });
            if has_parent_escape
                || path.parent() == Some(root)
                || path.extension().and_then(|value| value.to_str()) != Some("backup")
            {
                continue;
            }
        }
        let _ = fs::remove_file(&path);
        if let Some(parent) = path.parent() {
            if let Some(root) = allowed_root {
                if !parent.starts_with(root) {
                    continue;
                }
            }
            parents.insert(parent.to_path_buf());
        }
    }
    for parent in parents {
        let _ = fs::remove_dir(parent);
    }
}

fn cleanup_backup_files(journal_targets: &[JournalTarget]) {
    let paths = journal_targets
        .iter()
        .filter_map(|target| target.backup_path.clone())
        .collect::<Vec<_>>();
    cleanup_backup_paths(&paths, None);
}

fn cleanup_persisted_backup_paths(paths: &[String]) {
    let Ok(root) =
        app_paths::cli_manager_data_dir().map(|path| path.join("backups").join("providers"))
    else {
        return;
    };
    cleanup_backup_paths(paths, Some(&root));
}

async fn cleanup_finished_journal_backups() -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let rows = sqlx::query(
        "SELECT backup_paths_json
         FROM provider_apply_journal
         WHERE state IN ('committed', 'failed', 'recovered')",
    )
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "provider_journal_read_failed".to_string())?;
    for row in rows {
        let Ok(serialized) = row.try_get::<String, _>("backup_paths_json") else {
            continue;
        };
        let Ok(paths) = serde_json::from_str::<Vec<String>>(&serialized) else {
            continue;
        };
        cleanup_persisted_backup_paths(&paths);
    }
    Ok(())
}

pub(crate) async fn pending_journal(app_type: &str, home_identity: &str) -> Result<bool, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_apply_journal
         WHERE app_type = ?1 AND home_identity = ?2
           AND state IN ('staged', 'replacing', 'verifying', 'recovery_required')",
    )
    .bind(app_type)
    .bind(home_identity)
    .fetch_one(&mut connection)
    .await
    .map_err(|_| "provider_journal_read_failed".to_string())?;
    Ok(count > 0)
}

async fn insert_journal(
    journal_id: &str,
    plan: &ProviderPlan,
    journal_targets: &[JournalTarget],
) -> Result<(), String> {
    let mut expected = BTreeMap::new();
    let mut desired = BTreeMap::new();
    let mut target_paths = Vec::with_capacity(plan.targets.len());
    let mut backup_paths = Vec::new();
    for target in &plan.targets {
        expected.insert(target.path.clone(), fingerprint(target.before.as_deref()));
        desired.insert(target.path.clone(), fingerprint(Some(&target.desired)));
        target_paths.push(target.path.clone());
    }
    for target in journal_targets {
        if let Some(path) = &target.backup_path {
            backup_paths.push(path.clone());
        }
    }
    let mut connection = crate::provider::database::open_connection().await?;
    sqlx::query(
        "INSERT INTO provider_apply_journal
         (id, app_type, provider_id, home_identity, operation, state,
          target_paths_json, backup_paths_json, expected_fingerprints_json,
          desired_fingerprints_json, started_at)
         VALUES (?1, ?2, ?3, ?4, 'global_apply', 'staged', ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(journal_id)
    .bind(&plan.app_type)
    .bind(&plan.provider_id)
    .bind(&plan.home.identity.identity)
    .bind(serde_json::to_string(journal_targets).unwrap_or_else(|_| "[]".to_string()))
    .bind(serde_json::to_string(&backup_paths).unwrap_or_else(|_| "[]".to_string()))
    .bind(serde_json::to_string(&expected).unwrap_or_else(|_| "{}".to_string()))
    .bind(serde_json::to_string(&desired).unwrap_or_else(|_| "{}".to_string()))
    .bind(crate::provider::repository::unix_timestamp_millis())
    .execute(&mut connection)
    .await
    .map_err(|_| "provider_journal_write_failed".to_string())?;
    Ok(())
}

async fn update_journal(
    journal_id: &str,
    state: &str,
    error_code: Option<&str>,
) -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    sqlx::query(
        "UPDATE provider_apply_journal
         SET state = ?1, finished_at = ?2, error_code = ?3
         WHERE id = ?4",
    )
    .bind(state)
    .bind(if matches!(state, "committed" | "failed" | "recovered") {
        Some(crate::provider::repository::unix_timestamp_millis())
    } else {
        None
    })
    .bind(error_code)
    .bind(journal_id)
    .execute(&mut connection)
    .await
    .map_err(|_| "provider_journal_write_failed".to_string())?;
    Ok(())
}

async fn commit_current(plan: &ProviderPlan, journal_id: &str) -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "provider_database_error".to_string())?;
    sqlx::query("UPDATE providers SET is_current = 0 WHERE app_type = ?1")
        .bind(&plan.app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_database_error".to_string())?;
    let result = sqlx::query(
        "UPDATE providers SET is_current = 1
         WHERE id = ?1 AND app_type = ?2",
    )
    .bind(&plan.provider_id)
    .bind(&plan.app_type)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    if result.rows_affected() != 1 {
        return Err("provider_not_found".to_string());
    }
    sqlx::query(
        "UPDATE provider_apply_journal
         SET state = 'committed', finished_at = ?1, error_code = NULL
         WHERE id = ?2",
    )
    .bind(crate::provider::repository::unix_timestamp_millis())
    .bind(journal_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    transaction
        .commit()
        .await
        .map_err(|_| "provider_database_error".to_string())
}

fn restore_targets(plan: &ProviderPlan, changed_paths: &[String]) -> Result<(), String> {
    let mut first_error = None;
    for target in plan.targets.iter().rev() {
        if !changed_paths.iter().any(|path| path == &target.path) {
            continue;
        }
        let current = match read_live(&target.path) {
            Ok(bytes) => bytes,
            Err(error) => {
                first_error.get_or_insert(error);
                continue;
            }
        };
        if fingerprint(current.as_deref()) != fingerprint(Some(&target.desired)) {
            first_error.get_or_insert("provider_recovery_required".to_string());
            continue;
        }
        let result = if let Some(before) = &target.before {
            write_live(&target.path, before)
        } else {
            remove_live(&target.path)
        };
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(crate) async fn preview(input: GlobalPreviewInput) -> Result<GlobalPreview, String> {
    let plan = build_plan(&input).await?;
    Ok(plan_preview(&plan))
}

pub(crate) async fn current(input: GlobalCurrentInput) -> Result<GlobalCurrent, String> {
    let app_type = normalize_type(&input.app_type)?;
    let home = home::get(home_input(&input.home_identity)).await?;
    let pending_recovery = pending_journal(&app_type, &home.identity.identity).await?;
    let mut connection = crate::provider::database::open_connection().await?;
    let row = sqlx::query(
        "SELECT p.id, p.name, p.is_current,
                CASE WHEN EXISTS (
                    SELECT 1 FROM provider_api_keys k
                    WHERE k.provider_id = p.id AND k.app_type = p.app_type
                      AND k.is_active = 1 AND k.enabled = 1
                ) THEN 1 ELSE 0 END AS active_key_present
         FROM providers p
         WHERE p.app_type = ?1
         ORDER BY p.is_current DESC, p.sort_index, p.name COLLATE NOCASE",
    )
    .bind(&app_type)
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?;

    let candidates = row
        .iter()
        .map(|row| {
            Ok(CurrentCandidate {
                id: row
                    .try_get("id")
                    .map_err(|_| "provider_database_error".to_string())?,
                name: row
                    .try_get("name")
                    .map_err(|_| "provider_database_error".to_string())?,
                is_current: row
                    .try_get::<i64, _>("is_current")
                    .map_err(|_| "provider_database_error".to_string())?
                    != 0,
                active_key_present: row
                    .try_get::<i64, _>("active_key_present")
                    .map_err(|_| "provider_database_error".to_string())?
                    != 0,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    drop(connection);

    let mut matched_plan: Option<(CurrentCandidate, ProviderPlan)> = None;
    let mut flagged_plan: Option<(CurrentCandidate, ProviderPlan)> = None;
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate.active_key_present)
    {
        let Ok(plan) = build_plan(&GlobalPreviewInput {
            app_type: app_type.clone(),
            provider_id: candidate.id.clone(),
            home_identity: input.home_identity.clone(),
            projection: None,
        })
        .await
        else {
            continue;
        };
        if candidate.is_current && flagged_plan.is_none() {
            flagged_plan = Some((candidate.clone(), plan.clone()));
        }
        if plan_matches_live(&plan) && matched_plan.is_none() {
            matched_plan = Some((candidate.clone(), plan));
        }
    }

    let selected = matched_plan.or(flagged_plan);
    let Some((candidate, plan)) = selected.or_else(|| {
        candidates
            .iter()
            .find(|candidate| candidate.is_current)
            .cloned()
            .map(|candidate| {
                (
                    candidate,
                    ProviderPlan {
                        app_type: app_type.clone(),
                        provider_id: String::new(),
                        provider_name: String::new(),
                        home: home.clone(),
                        targets: Vec::new(),
                    },
                )
            })
    }) else {
        return Ok(GlobalCurrent {
            app_type,
            home,
            provider_id: None,
            provider_name: None,
            active_key_present: false,
            state: if pending_recovery {
                "recovery_pending"
            } else {
                "not_set"
            }
            .to_string(),
            pending_recovery,
            targets: Vec::new(),
        });
    };
    let active_key_present = candidate.active_key_present;
    let targets = if plan.provider_id.is_empty() {
        Vec::new()
    } else {
        plan_preview(&plan).targets
    };
    let state = if pending_recovery {
        "recovery_pending"
    } else if !active_key_present {
        "key_missing"
    } else if targets.is_empty() {
        "unavailable"
    } else if targets.iter().all(|target| !target.changed) {
        "applied"
    } else {
        "drifted"
    };
    Ok(GlobalCurrent {
        app_type,
        home,
        provider_id: Some(candidate.id),
        provider_name: Some(candidate.name),
        active_key_present,
        state: state.to_string(),
        pending_recovery,
        targets,
    })
}

pub(crate) async fn apply(input: GlobalApplyInput) -> Result<GlobalApplyResult, String> {
    let preview_fingerprint = input.preview_fingerprint.trim();
    if preview_fingerprint.is_empty() {
        return Err("provider_preview_fingerprint_required".to_string());
    }
    let preview_input = GlobalPreviewInput {
        app_type: input.app_type.clone(),
        provider_id: input.provider_id.clone(),
        home_identity: input.home_identity.clone(),
        projection: input.projection.clone(),
    };
    let plan = build_plan(&preview_input).await?;
    let _lock = acquire_apply_lock(&plan.app_type, &plan.home.identity.identity)?;
    if pending_journal(&plan.app_type, &plan.home.identity.identity).await? {
        return Err("provider_recovery_required".to_string());
    }
    let preview = plan_preview(&plan);
    if preview.fingerprint != preview_fingerprint {
        return Err("provider_apply_conflict".to_string());
    }

    let changed_paths = plan
        .targets
        .iter()
        .filter(|target| target.before.as_deref() != Some(target.desired.as_slice()))
        .map(|target| target.path.clone())
        .collect::<Vec<_>>();
    if changed_paths.iter().any(|path| !target_writable(path)) {
        return Err("provider_target_write_failed".to_string());
    }

    let journal_id = Uuid::new_v4().to_string();
    let journal_targets = journal_targets(&plan, &journal_id)?;
    if let Err(error) = insert_journal(&journal_id, &plan, &journal_targets).await {
        return Err(error);
    }
    if let Err(error) = stage_plan(&plan, &journal_targets) {
        cleanup_stage_files(&journal_targets);
        cleanup_backup_files(&journal_targets);
        if update_journal(&journal_id, "failed", Some(error.as_str()))
            .await
            .is_err()
        {
            return Err("provider_journal_write_failed".to_string());
        }
        return Err(error);
    }

    if let Err(error) = update_journal(&journal_id, "replacing", None).await {
        cleanup_stage_files(&journal_targets);
        return Err(error);
    }
    let mut replaced_paths = Vec::new();
    let replacement_result = (|| -> Result<(), String> {
        for (index, target) in plan.targets.iter().enumerate() {
            if !changed_paths.iter().any(|path| path == &target.path) {
                continue;
            }
            let current = read_live(&target.path)?;
            if fingerprint(current.as_deref()) != fingerprint(target.before.as_deref()) {
                return Err("provider_apply_conflict".to_string());
            }
            let journal_target = journal_targets
                .get(index)
                .ok_or_else(|| "provider_target_write_failed".to_string())?;
            replace_live_from_stage(&target.path, &journal_target.stage_path)?;
            replaced_paths.push(target.path.clone());
        }
        Ok(())
    })();
    if let Err(_error) = replacement_result {
        let restore = restore_targets(&plan, &replaced_paths);
        cleanup_stage_files(&journal_targets);
        let conflict = _error == "provider_apply_conflict";
        let _ = update_journal(
            &journal_id,
            if restore.is_ok() {
                "failed"
            } else {
                "recovery_required"
            },
            Some(if !restore.is_ok() {
                "provider_recovery_required"
            } else if conflict {
                "provider_apply_conflict"
            } else {
                "provider_apply_failed"
            }),
        )
        .await;
        return Err(if !restore.is_ok() {
            "provider_recovery_required".to_string()
        } else if conflict {
            "provider_apply_conflict".to_string()
        } else {
            "provider_apply_failed".to_string()
        });
    }

    if let Err(error) = update_journal(&journal_id, "verifying", None).await {
        cleanup_stage_files(&journal_targets);
        return Err(error);
    }
    let mut verified = BTreeMap::new();
    let verification_result = (|| -> Result<(), String> {
        for target in &plan.targets {
            let current = read_live(&target.path)?;
            let actual = fingerprint(current.as_deref());
            let expected = fingerprint(Some(&target.desired));
            if actual != expected {
                return Err("provider_apply_failed".to_string());
            }
            verified.insert(target.path.clone(), actual);
        }
        Ok(())
    })();
    if verification_result.is_err() {
        let restore = restore_targets(&plan, &changed_paths);
        cleanup_stage_files(&journal_targets);
        let _ = update_journal(
            &journal_id,
            if restore.is_ok() {
                "failed"
            } else {
                "recovery_required"
            },
            Some(if restore.is_ok() {
                "provider_apply_failed"
            } else {
                "provider_recovery_required"
            }),
        )
        .await;
        return Err(if restore.is_ok() {
            "provider_apply_failed".to_string()
        } else {
            "provider_recovery_required".to_string()
        });
    }
    if commit_current(&plan, &journal_id).await.is_err() {
        let restore = restore_targets(&plan, &changed_paths);
        cleanup_stage_files(&journal_targets);
        let _ = update_journal(
            &journal_id,
            if restore.is_ok() {
                "failed"
            } else {
                "recovery_required"
            },
            Some(if restore.is_ok() {
                "provider_database_error"
            } else {
                "provider_recovery_required"
            }),
        )
        .await;
        return Err(if restore.is_ok() {
            "provider_database_error".to_string()
        } else {
            "provider_recovery_required".to_string()
        });
    }

    cleanup_stage_files(&journal_targets);
    cleanup_backup_files(&journal_targets);

    Ok(GlobalApplyResult {
        app_type: plan.app_type,
        provider_id: plan.provider_id,
        home_identity: plan.home.identity,
        journal_id,
        state: "committed".to_string(),
        changed_targets: changed_paths,
        verified_fingerprints: verified,
    })
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryReport {
    pub recovered: usize,
    pub completed: usize,
    pub blocked: usize,
}

async fn complete_recovered_journal(
    journal_id: &str,
    app_type: &str,
    provider_id: &str,
) -> Result<(), String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "provider_database_error".to_string())?;
    sqlx::query("UPDATE providers SET is_current = 0 WHERE app_type = ?1")
        .bind(app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|_| "provider_database_error".to_string())?;
    let result = sqlx::query(
        "UPDATE providers SET is_current = 1
         WHERE id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(app_type)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    if result.rows_affected() != 1 {
        return Err("provider_not_found".to_string());
    }
    sqlx::query(
        "UPDATE provider_apply_journal
         SET state = 'committed', finished_at = ?1, error_code = NULL
         WHERE id = ?2",
    )
    .bind(crate::provider::repository::unix_timestamp_millis())
    .bind(journal_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| "provider_database_error".to_string())?;
    transaction
        .commit()
        .await
        .map_err(|_| "provider_database_error".to_string())
}

async fn recover_one(
    id: String,
    app_type: String,
    provider_id: String,
    targets_json: String,
    expected_json: String,
    desired_json: String,
) -> Result<&'static str, String> {
    let targets = serde_json::from_str::<Vec<JournalTarget>>(&targets_json)
        .map_err(|_| "provider_recovery_required".to_string())?;
    let expected = serde_json::from_str::<BTreeMap<String, String>>(&expected_json)
        .map_err(|_| "provider_recovery_required".to_string())?;
    let desired = serde_json::from_str::<BTreeMap<String, String>>(&desired_json)
        .map_err(|_| "provider_recovery_required".to_string())?;
    let mut current = BTreeMap::new();
    for target in &targets {
        let bytes = match read_live(&target.target) {
            Ok(bytes) => bytes,
            Err(error) => {
                cleanup_stage_files(&targets);
                return Err(error);
            }
        };
        current.insert(target.target.clone(), fingerprint(bytes.as_deref()));
    }
    if current
        .iter()
        .any(|(path, value)| expected.get(path) != Some(value) && desired.get(path) != Some(value))
    {
        cleanup_stage_files(&targets);
        return Err("provider_recovery_required".to_string());
    }
    let all_desired = targets
        .iter()
        .all(|target| current.get(&target.target) == desired.get(&target.target));
    let all_expected = targets
        .iter()
        .all(|target| current.get(&target.target) == expected.get(&target.target));
    if all_desired {
        let result = complete_recovered_journal(&id, &app_type, &provider_id).await;
        result?;
        cleanup_stage_files(&targets);
        cleanup_backup_files(&targets);
        return Ok("completed");
    }
    if all_expected {
        let result = update_journal(&id, "recovered", Some("provider_recovery_completed")).await;
        result?;
        cleanup_stage_files(&targets);
        cleanup_backup_files(&targets);
        return Ok("recovered");
    }
    for target in targets.iter().rev() {
        let Some(before) = target.backup_path.as_deref() else {
            if let Err(error) = remove_live(&target.target) {
                cleanup_stage_files(&targets);
                return Err(error);
            }
            continue;
        };
        let bytes = match fs::read(before) {
            Ok(bytes) => bytes,
            Err(_) => {
                cleanup_stage_files(&targets);
                return Err("provider_recovery_required".to_string());
            }
        };
        if let Err(error) = write_live(&target.target, &bytes) {
            cleanup_stage_files(&targets);
            return Err(error);
        }
    }
    for target in &targets {
        let bytes = match read_live(&target.target) {
            Ok(bytes) => bytes,
            Err(error) => {
                cleanup_stage_files(&targets);
                return Err(error);
            }
        };
        if expected.get(&target.target) != Some(&fingerprint(bytes.as_deref())) {
            cleanup_stage_files(&targets);
            return Err("provider_recovery_required".to_string());
        }
    }
    let result = update_journal(&id, "recovered", Some("provider_recovery_completed")).await;
    result?;
    cleanup_stage_files(&targets);
    cleanup_backup_files(&targets);
    Ok("recovered")
}

pub(crate) async fn recover_pending() -> Result<RecoveryReport, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let rows = sqlx::query(
        "SELECT id, app_type, provider_id, home_identity, target_paths_json,
                expected_fingerprints_json, desired_fingerprints_json
         FROM provider_apply_journal
         WHERE state IN ('staged', 'replacing', 'verifying', 'recovery_required')
         ORDER BY started_at",
    )
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "provider_journal_read_failed".to_string())?;
    let mut report = RecoveryReport::default();
    for row in rows {
        let id = row
            .try_get::<String, _>("id")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let app_type = row
            .try_get::<String, _>("app_type")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let provider_id = row
            .try_get::<String, _>("provider_id")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let home_identity = row
            .try_get::<String, _>("home_identity")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let targets = row
            .try_get::<String, _>("target_paths_json")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let expected = row
            .try_get::<String, _>("expected_fingerprints_json")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let desired = row
            .try_get::<String, _>("desired_fingerprints_json")
            .map_err(|_| "provider_journal_read_failed".to_string())?;
        let apply_lock = match acquire_apply_lock(&app_type, &home_identity) {
            Ok(lock) => lock,
            Err(error) if error == "provider_apply_busy" => {
                report.blocked += 1;
                continue;
            }
            Err(_) => {
                report.blocked += 1;
                let _ =
                    update_journal(&id, "recovery_required", Some("provider_recovery_required"))
                        .await;
                continue;
            }
        };
        let result = recover_one(
            id.clone(),
            app_type,
            provider_id,
            targets,
            expected,
            desired,
        )
        .await;
        drop(apply_lock);
        match result {
            Ok("completed") => report.completed += 1,
            Ok("recovered") => report.recovered += 1,
            Ok(_) | Err(_) => {
                report.blocked += 1;
                let _ =
                    update_journal(&id, "recovery_required", Some("provider_recovery_required"))
                        .await;
            }
        }
    }
    if let Err(error) = cleanup_finished_journal_backups().await {
        log::warn!("provider journal backup cleanup skipped: {error}");
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::home::DerivedCliTargets;
    use serde_json::json;

    #[test]
    fn claude_writer_preserves_user_owned_fields() {
        let before = br#"{
          "hooks": {"UserPromptSubmit": []},
          "permissions": {"allow": ["Read"]},
          "env": {"ANTHROPIC_AUTH_TOKEN": "old", "USER_FLAG": "keep"},
          "unknown": {"value": true}
        }"#;
        let effective = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://provider.test",
                "ANTHROPIC_MODEL": "claude-test"
            }
        });
        let (bytes, _) = materialize_claude(Some(before), &effective, "new-secret").unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["hooks"]["UserPromptSubmit"], json!([]));
        assert_eq!(value["permissions"]["allow"], json!(["Read"]));
        assert_eq!(value["unknown"]["value"], json!(true));
        assert_eq!(value["env"]["ANTHROPIC_BASE_URL"], "https://provider.test");
        assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "new-secret");
        assert_eq!(value["env"]["USER_FLAG"], "keep");
        assert!(!String::from_utf8(bytes).unwrap().contains("old"));
    }

    #[test]
    fn claude_writer_prefers_explicit_auth_field_marker() {
        let effective = json!({
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "",
                "ANTHROPIC_API_KEY": "common-value",
                "ANTHROPIC_MODEL": "claude-test"
            }
        });
        let (bytes, _) = materialize_claude(None, &effective, "new-secret").unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "new-secret");
        assert!(value["env"]["ANTHROPIC_API_KEY"].is_null());
    }

    #[test]
    fn claude_writer_honors_api_key_marker_when_token_is_legacy() {
        let effective = json!({
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "legacy-value",
                "ANTHROPIC_API_KEY": "",
                "ANTHROPIC_MODEL": "claude-test"
            }
        });
        let (bytes, _) = materialize_claude(None, &effective, "new-secret").unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["env"]["ANTHROPIC_API_KEY"], "new-secret");
        assert!(value["env"]["ANTHROPIC_AUTH_TOKEN"].is_null());
    }

    #[test]
    fn local_route_projection_replaces_claude_endpoint_and_credential() {
        let mut plan = ProviderPlan {
            app_type: "claude".to_string(),
            provider_id: "provider".to_string(),
            provider_name: "Provider".to_string(),
            home: ProviderHomeState {
                identity: HomeIdentity {
                    environment_kind: "local".to_string(),
                    environment_id: "host".to_string(),
                    identity: "local:host".to_string(),
                },
                mode: "auto".to_string(),
                home_path: "C:\\Users\\test".to_string(),
                source: "detected".to_string(),
                targets: DerivedCliTargets {
                    home_path: String::new(),
                    claude_config_dir: String::new(),
                    claude_history_root: String::new(),
                    codex_config_dir: String::new(),
                    codex_history_root: String::new(),
                    grok_config_dir: String::new(),
                    grok_history_root: String::new(),
                },
            },
            targets: vec![PlannedTarget {
                target: "claude.settings".to_string(),
                path: "settings.json".to_string(),
                before: None,
                desired: br#"{"env":{"ANTHROPIC_AUTH_TOKEN":"secret"},"hooks":{}}"#.to_vec(),
                owned_fields: Vec::new(),
            }],
        };
        apply_local_route_projection(
            &mut plan,
            &LocalRouteProjection {
                endpoint: "http://127.0.0.1:15721".to_string(),
            },
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&plan.targets[0].desired).unwrap();
        assert_eq!(value["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:15721");
        assert_eq!(
            value["env"]["ANTHROPIC_API_KEY"],
            ROUTED_CREDENTIAL_SENTINEL
        );
        assert!(value["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
        assert!(value["hooks"].is_object());
    }

    #[test]
    fn local_route_projection_rejects_non_loopback_endpoint() {
        let result = route_endpoint_with_suffix("http://0.0.0.0:15721", "");
        assert_eq!(result.unwrap_err(), "routing_endpoint_invalid");
    }

    #[test]
    fn local_route_projection_accepts_validated_wsl_gateway_endpoint() {
        assert_eq!(
            route_endpoint_with_suffix("http://172.28.224.1:15721", ""),
            Ok("http://172.28.224.1:15721".to_string())
        );
    }

    #[test]
    fn codex_auth_writer_removes_legacy_top_level_credentials() {
        let before = br#"{
          "OPENAI_API_KEY": "old-root-secret",
          "auth": {"api_key": "old-nested-secret", "account_id": "keep"},
          "unknown": true
        }"#;
        let effective = json!({"auth": {"api_key": "marker"}});
        let (bytes, _) = materialize_codex_auth(Some(before), &effective, "new-secret").unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["OPENAI_API_KEY"], "new-secret");
        assert!(value.get("auth").is_none());
        assert!(!String::from_utf8(bytes)
            .unwrap()
            .contains("old-nested-secret"));
        assert!(value["unknown"].as_bool().unwrap());
    }

    #[test]
    fn codex_writer_preserves_unowned_toml_sections() {
        let before = br#"# keep
[mcp_servers.demo]
command = "demo"
model = "old"
        model_provider = "old-provider"
"#;
        let effective = json!({
            "config": "[model_providers.demo]\nname = \"new\"\nauthorization = \"nested-secret\"\n\nmodel = \"gpt-new\"\nmodel_provider = \"demo\"\n"
        });
        let (bytes, _) = materialize_codex_config(Some(before), &effective).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("# keep"));
        assert!(text.contains("[mcp_servers.demo]"));
        assert!(text.contains("model = \"gpt-new\""));
        assert!(text.contains("model_provider = \"demo\""));
        assert!(!text.contains("env_key"));
        assert!(!text.contains("nested-secret"));
        assert!(!text.contains("authorization"));
    }

    #[test]
    fn codex_secret_cleanup_visits_every_array_of_tables_entry() {
        let mut document = "[[profiles]]\napi_key = \"first-secret\"\n\n[[profiles]]\napi_key = \"second-secret\"\n"
            .parse::<DocumentMut>()
            .unwrap();
        assert!(remove_toml_secret_fields(document.as_item_mut()));
        let text = document.to_string();
        assert!(!text.contains("first-secret"));
        assert!(!text.contains("second-secret"));
    }

    #[test]
    fn codex_writer_projects_typed_endpoint_and_model() {
        let effective = json!({
            "base_url": "https://codex.test",
            "model": "gpt-codex"
        });
        let (bytes, _) = materialize_codex_config(None, &effective).unwrap();
        let document = String::from_utf8(bytes).unwrap();
        assert!(document.contains("model = \"gpt-codex\""));
        assert!(document.contains("model_provider = \"cli_manager\""));
        assert!(document.contains("base_url = \"https://codex.test\""));
        assert!(!document.contains("env_key"));
    }

    #[test]
    fn codex_writer_removes_legacy_root_endpoint_fields() {
        let before = br#"base_url = "https://old.example"
wire_api = "responses"
"#;
        let effective = json!({
            "config": "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://new.example/v1\"\nwire_api = \"responses\"\n",
            "base_url": "https://new.example/v1",
            "model": "gpt-test"
        });
        let (bytes, _) = materialize_codex_config(Some(before), &effective).unwrap();
        let document = String::from_utf8(bytes).unwrap();
        assert!(!document.starts_with("base_url ="));
        assert!(!document.contains("wire_api = \"responses\"\n\n[model_providers]"));
        assert!(document.contains("[model_providers.custom]"));
        assert!(document.contains("base_url = \"https://new.example/v1\""));
    }

    #[test]
    fn grok_global_writer_writes_selected_inline_key() {
        let effective = json!({
            "config": "[models]\ndefault = \"proxy\"\n[model.proxy]\nmodel = \"grok-test\"\nbase_url = \"https://grok.test\"\nname = \"Grok\"\n"
        });
        let (bytes, _) = materialize_grok_global_config(None, &effective, "new-secret").unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("api_key = \"new-secret\""));
        assert!(!text.contains("env_key"));
    }

    #[test]
    fn aggregate_fingerprint_is_order_stable() {
        let mut left = BTreeMap::new();
        left.insert("a".to_string(), "1".to_string());
        left.insert("b".to_string(), "2".to_string());
        let mut right = BTreeMap::new();
        right.insert("b".to_string(), "2".to_string());
        right.insert("a".to_string(), "1".to_string());
        assert_eq!(aggregate_fingerprint(&left), aggregate_fingerprint(&right));
    }

    #[test]
    fn apply_lock_serializes_same_home_and_app_type() {
        let first = acquire_apply_lock("claude", "test:recovery-lock").unwrap();
        assert!(matches!(
            acquire_apply_lock("claude", "test:recovery-lock"),
            Err(error) if error == "provider_apply_busy"
        ));
        drop(first);
        assert!(acquire_apply_lock("claude", "test:recovery-lock").is_ok());
    }

    #[test]
    fn staged_target_parser_validates_json_and_toml_by_target() {
        let json_target = PlannedTarget {
            target: "codex.auth".to_string(),
            path: String::new(),
            before: None,
            desired: Vec::new(),
            owned_fields: Vec::new(),
        };
        assert!(parse_staged_target(&json_target, br#"{}"#).is_ok());
        assert!(parse_staged_target(&json_target, b"[]").is_err());

        let toml_target = PlannedTarget {
            target: "codex.config".to_string(),
            path: String::new(),
            before: None,
            desired: Vec::new(),
            owned_fields: Vec::new(),
        };
        assert!(parse_staged_target(&toml_target, b"model = \"test\"\n").is_ok());
        assert!(parse_staged_target(&toml_target, b"[").is_err());
    }

    #[test]
    fn plan_matches_live_requires_every_target_to_match() {
        let matching = PlannedTarget {
            target: "codex.config".to_string(),
            path: String::new(),
            before: Some(b"model = \"test\"\n".to_vec()),
            desired: b"model = \"test\"\n".to_vec(),
            owned_fields: Vec::new(),
        };
        let changed = PlannedTarget {
            target: "codex.auth".to_string(),
            path: String::new(),
            before: Some(br#"{"old":true}"#.to_vec()),
            desired: br#"{"new":true}"#.to_vec(),
            owned_fields: Vec::new(),
        };
        let mut plan = ProviderPlan {
            app_type: "codex".to_string(),
            provider_id: "provider".to_string(),
            provider_name: "Provider".to_string(),
            home: matching_home(),
            targets: vec![matching],
        };
        assert!(plan_matches_live(&plan));
        plan.targets.push(changed);
        assert!(!plan_matches_live(&plan));
    }

    fn matching_home() -> ProviderHomeState {
        ProviderHomeState {
            identity: HomeIdentity {
                environment_kind: "local".to_string(),
                environment_id: "host".to_string(),
                identity: "local:host".to_string(),
            },
            mode: "auto".to_string(),
            home_path: String::new(),
            source: "auto".to_string(),
            targets: crate::provider::home::DerivedCliTargets {
                home_path: String::new(),
                claude_config_dir: String::new(),
                claude_history_root: String::new(),
                codex_config_dir: String::new(),
                codex_history_root: String::new(),
                grok_config_dir: String::new(),
                grok_history_root: String::new(),
            },
        }
    }

    #[test]
    fn stage_path_stays_beside_local_and_wsl_targets() {
        let local =
            stage_path_for_target(r"C:\Users\tester\.codex\config.toml", "journal", 1).unwrap();
        assert_eq!(
            Path::new(&local).parent().unwrap(),
            Path::new(r"C:\Users\tester\.codex")
        );
        assert!(local.ends_with(".config.toml.journal.1.stage"));

        let wsl = stage_path_for_target(
            r"\\wsl.localhost\Ubuntu\home\tester\.codex\config.toml",
            "journal",
            1,
        )
        .unwrap();
        let (distro, linux_path) = wsl::parse_wsl_unc_path(&wsl).unwrap();
        assert_eq!(distro, "Ubuntu");
        assert_eq!(
            linux_path,
            "/home/tester/.codex/.config.toml.journal.1.stage"
        );
    }

    #[test]
    fn local_stage_replacement_overwrites_existing_target() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("config.toml");
        let stage = directory.path().join(".config.toml.stage");
        fs::write(&target, b"old").unwrap();
        fs::write(&stage, b"new").unwrap();

        replace_live_from_stage(
            target.to_string_lossy().as_ref(),
            stage.to_string_lossy().as_ref(),
        )
        .unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!stage.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_local_stage_replace_keeps_atomic_same_directory_contract() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("settings.json");
        let stage = directory.path().join(".settings.json.route.stage");
        fs::write(&stage, br#"{"route":"local"}"#).unwrap();

        assert_eq!(stage.parent(), target.parent());
        replace_live_from_stage(
            target.to_string_lossy().as_ref(),
            stage.to_string_lossy().as_ref(),
        )
        .unwrap();

        assert_eq!(fs::read(&target).unwrap(), br#"{"route":"local"}"#);
        assert!(!stage.exists());
    }

    #[test]
    fn compensation_restores_existing_and_removes_created_targets() {
        let directory = tempfile::tempdir().unwrap();
        let existing_path = directory.path().join("existing.json");
        let created_path = directory.path().join("created.json");
        fs::write(&existing_path, br#"{"old":true}"#).unwrap();
        fs::write(&existing_path, br#"{"new":true}"#).unwrap();
        fs::write(&created_path, br#"{"created":true}"#).unwrap();

        let plan = ProviderPlan {
            app_type: "codex".to_string(),
            provider_id: "provider".to_string(),
            provider_name: "Provider".to_string(),
            home: ProviderHomeState {
                identity: HomeIdentity {
                    environment_kind: "local".to_string(),
                    environment_id: "host".to_string(),
                    identity: "local:host".to_string(),
                },
                mode: "auto".to_string(),
                home_path: directory.path().to_string_lossy().into_owned(),
                source: "auto".to_string(),
                targets: crate::provider::home::DerivedCliTargets {
                    home_path: directory.path().to_string_lossy().into_owned(),
                    claude_config_dir: directory
                        .path()
                        .join(".claude")
                        .to_string_lossy()
                        .into_owned(),
                    claude_history_root: directory
                        .path()
                        .join(".claude")
                        .join("projects")
                        .to_string_lossy()
                        .into_owned(),
                    codex_config_dir: directory
                        .path()
                        .join(".codex")
                        .to_string_lossy()
                        .into_owned(),
                    codex_history_root: directory
                        .path()
                        .join(".codex")
                        .join("sessions")
                        .to_string_lossy()
                        .into_owned(),
                    grok_config_dir: directory
                        .path()
                        .join(".grok")
                        .to_string_lossy()
                        .into_owned(),
                    grok_history_root: directory
                        .path()
                        .join(".grok")
                        .join("sessions")
                        .to_string_lossy()
                        .into_owned(),
                },
            },
            targets: vec![
                PlannedTarget {
                    target: "codex.auth".to_string(),
                    path: existing_path.to_string_lossy().into_owned(),
                    before: Some(br#"{"old":true}"#.to_vec()),
                    desired: br#"{"new":true}"#.to_vec(),
                    owned_fields: Vec::new(),
                },
                PlannedTarget {
                    target: "codex.config".to_string(),
                    path: created_path.to_string_lossy().into_owned(),
                    before: None,
                    desired: br#"{"created":true}"#.to_vec(),
                    owned_fields: Vec::new(),
                },
            ],
        };

        restore_targets(
            &plan,
            &[
                existing_path.to_string_lossy().into_owned(),
                created_path.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();

        assert_eq!(fs::read(&existing_path).unwrap(), br#"{"old":true}"#);
        assert!(!created_path.exists());

        fs::write(&existing_path, br#"{"external":true}"#).unwrap();
        assert_eq!(
            restore_targets(&plan, &[existing_path.to_string_lossy().into_owned()]),
            Err("provider_recovery_required".to_string())
        );
        assert_eq!(fs::read(&existing_path).unwrap(), br#"{"external":true}"#);
    }

    #[test]
    fn existing_readonly_file_is_not_writable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, b"{}").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();

        assert!(!target_writable(path.to_string_lossy().as_ref()));

        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
    }

    #[test]
    fn cleanup_backup_files_removes_stale_stage_failure_backups_and_directory() {
        let directory = tempfile::tempdir().unwrap();
        let backup_directory = directory.path().join("journal");
        fs::create_dir(&backup_directory).unwrap();
        let backup = backup_directory.join("target.backup");
        fs::write(&backup, b"secret").unwrap();
        let targets = vec![JournalTarget {
            target: "target".to_string(),
            backup_path: Some(backup.to_string_lossy().into_owned()),
            stage_path: "stage".to_string(),
            existed: true,
        }];

        cleanup_backup_files(&targets);

        assert!(!backup.exists());
        assert!(!backup_directory.exists());
    }

    #[test]
    fn cleanup_persisted_backup_paths_stays_inside_provider_backup_root() {
        let directory = tempfile::tempdir().unwrap();
        let outside_directory = tempfile::tempdir().unwrap();
        let backup_directory = directory.path().join("journal");
        fs::create_dir(&backup_directory).unwrap();
        let backup = backup_directory.join("target.backup");
        fs::write(&backup, b"secret").unwrap();
        let rogue = directory.path().join("rogue.txt");
        fs::write(&rogue, b"keep").unwrap();
        let outside = outside_directory.path().join("outside.txt");
        fs::write(&outside, b"keep").unwrap();
        let escaped = directory
            .path()
            .join("journal")
            .join("..")
            .join("..")
            .join("escaped.backup");
        let escaped_target = directory.path().parent().unwrap().join("escaped.backup");
        fs::write(&escaped_target, b"keep").unwrap();

        cleanup_backup_paths(
            &[
                backup.to_string_lossy().into_owned(),
                rogue.to_string_lossy().into_owned(),
                outside.to_string_lossy().into_owned(),
                escaped.to_string_lossy().into_owned(),
            ],
            Some(directory.path()),
        );

        assert!(!backup.exists());
        assert!(!backup_directory.exists());
        assert!(rogue.exists());
        assert!(outside.exists());
        assert!(escaped_target.exists());
    }
}
