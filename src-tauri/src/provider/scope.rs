use super::global;
use crate::{app_paths, provider::repository, wsl};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{Connection, Row};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const GENERATED_ROOT: &str = "generated";
const SNAPSHOT_KEY_FILE: &str = "provider.key";
const CODEX_PROVIDER_ENV_KEY: &str = "CLI_MANAGER_PROVIDER_KEY";
const GROK_PROVIDER_ENV_KEY: &str = "XAI_API_KEY";
const SNAPSHOT_APP_TYPES: [&str; 3] = ["claude", "codex", "grokbuild"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopePrepareInput {
    pub app_type: String,
    pub project_id: Option<String>,
    pub worktree_id: Option<String>,
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeResolveInput {
    pub app_type: String,
    pub project_id: Option<String>,
    pub worktree_id: Option<String>,
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderLaunchConfig {
    pub app_type: String,
    pub provider_id: String,
    pub snapshot_id: String,
    pub claude_settings_path: Option<String>,
    pub generated_home: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedProvider {
    pub app_type: String,
    pub provider_id: String,
    pub provider_name: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderLaunchSnapshot {
    pub app_type: String,
    pub provider_id: String,
    pub provider_name: String,
    pub source: String,
    pub snapshot_id: String,
    pub claude_settings_path: Option<String>,
    pub generated_home: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    app_type: String,
    provider_id: String,
    active_key_id: String,
    snapshot_id: String,
}

#[derive(Clone)]
struct NativeProvider {
    id: String,
    name: String,
    app_type: String,
    settings_config: String,
    meta: String,
    active_key_id: String,
    active_key: String,
}

struct ResolvedSelection {
    provider: NativeProvider,
    source: &'static str,
}

fn normalize_type(value: &str) -> Result<String, String> {
    repository::normalize_app_type(value)
}

async fn load_provider(
    app_type: String,
    provider_id: String,
    active_key_id: Option<String>,
) -> Result<NativeProvider, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, name, settings_config, meta
         FROM providers WHERE id = ?1 AND app_type = ?2",
    )
    .bind(&provider_id)
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .ok_or_else(|| "provider_not_found".to_string())?;

    let meta: String = row
        .try_get("meta")
        .map_err(|_| "provider_database_error".to_string())?;
    if !repository::meta_enabled(&repository::parse_meta(&meta)) {
        return Err("provider_not_ready".to_string());
    }
    let id: String = row
        .try_get("id")
        .map_err(|_| "provider_database_error".to_string())?;
    let name: String = row
        .try_get("name")
        .map_err(|_| "provider_database_error".to_string())?;
    let settings_config: String = row
        .try_get("settings_config")
        .map_err(|_| "provider_database_error".to_string())?;
    let key_row = if let Some(active_key_id) = active_key_id {
        sqlx::query(
            "SELECT id, api_key, enabled
             FROM provider_api_keys
             WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
        )
        .bind(active_key_id)
        .bind(&id)
        .bind(&app_type)
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "provider_database_error".to_string())?
    } else {
        sqlx::query(
            "SELECT id, api_key, enabled
             FROM provider_api_keys
             WHERE provider_id = ?1 AND app_type = ?2
               AND is_active = 1 AND enabled = 1
             LIMIT 1",
        )
        .bind(&id)
        .bind(&app_type)
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "provider_database_error".to_string())?
    };
    let key_row = key_row.ok_or_else(|| "provider_key_not_active".to_string())?;
    let enabled: i64 = key_row
        .try_get("enabled")
        .map_err(|_| "provider_database_error".to_string())?;
    if enabled != 1 {
        return Err("provider_key_not_active".to_string());
    }
    let active_key_id: String = key_row
        .try_get("id")
        .map_err(|_| "provider_database_error".to_string())?;
    let active_key: String = key_row
        .try_get("api_key")
        .map_err(|_| "provider_database_error".to_string())?;
    if active_key.trim().is_empty() {
        return Err("provider_key_not_active".to_string());
    }

    Ok(NativeProvider {
        id,
        name,
        app_type,
        settings_config,
        meta,
        active_key_id,
        active_key,
    })
}

async fn effective_settings(provider: NativeProvider) -> Result<Value, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    let common = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(format!("common_config_{}", provider.app_type))
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "provider_database_error".to_string())?
        .unwrap_or_default();
    let meta = repository::parse_meta(&provider.meta);
    let merged = if repository::meta_common_config_enabled(&meta) {
        repository::merge_common_into_settings(
            &provider.app_type,
            &common,
            &provider.settings_config,
        )?
    } else {
        provider.settings_config.clone()
    };
    let projected =
        repository::project_key_into_settings(&provider.app_type, &merged, &provider.active_key)?;
    serde_json::from_str(&projected).map_err(|_| "provider_config_invalid".to_string())
}

async fn open_app_database() -> Result<Option<SqliteConnection>, String> {
    let path = app_paths::db_path()?;
    if !path.is_file() {
        return Ok(None);
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .busy_timeout(Duration::from_secs(5));
    SqliteConnection::connect_with(&options)
        .await
        .map(Some)
        .map_err(|_| "provider_scope_database_error".to_string())
}

async fn read_scope_override(
    connection: &mut SqliteConnection,
    table: String,
    id: String,
) -> Result<Option<String>, String> {
    let query = match table.as_str() {
        "projects" => "SELECT provider_overrides FROM projects WHERE id = ?1",
        "worktrees" => "SELECT provider_overrides FROM worktrees WHERE id = ?1",
        _ => return Err("provider_scope_database_error".to_string()),
    };
    sqlx::query_scalar::<_, String>(query)
        .bind(id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| "provider_scope_database_error".to_string())
}

fn parse_provider_reference(raw: Option<&str>, app_type: &str) -> Result<Option<String>, String> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(raw)
        .map_err(|_| "provider_reference_migration_required".to_string())?;
    let Some(root) = parsed.as_object() else {
        return Err("provider_reference_migration_required".to_string());
    };
    let candidate = root
        .get(app_type)
        .or_else(|| {
            if app_type == "grokbuild" {
                root.get("grok")
            } else {
                None
            }
        })
        .or_else(|| (root.get("providerId").is_some()).then_some(&parsed));
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    let Some(reference) = candidate.as_object() else {
        return Err("provider_reference_migration_required".to_string());
    };
    if reference.is_empty() {
        return Ok(None);
    }
    let schema_version = reference
        .get("schemaVersion")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let source = reference.get("source").and_then(Value::as_str);
    let reference_type = reference.get("appType").and_then(Value::as_str);
    if schema_version != 2 || source != Some("cli-manager") || reference_type != Some(app_type) {
        return Err("provider_reference_migration_required".to_string());
    }
    let provider_id = reference
        .get("providerId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider_reference_migration_required".to_string())?;
    Ok(Some(provider_id.to_string()))
}

async fn current_provider_id(app_type: String) -> Result<String, String> {
    let mut connection = crate::provider::database::open_connection().await?;
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM providers WHERE app_type = ?1 AND is_current = 1 LIMIT 1",
    )
    .bind(app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "provider_database_error".to_string())?
    .ok_or_else(|| "provider_current_not_set".to_string())
}

async fn resolve_selection(input: ScopeResolveInput) -> Result<ResolvedSelection, String> {
    let app_type = normalize_type(&input.app_type)?;
    if let Some(provider_id) = input
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(ResolvedSelection {
            provider: load_provider(app_type.clone(), provider_id.to_string(), None).await?,
            source: "explicit",
        });
    }

    let mut selected_id = None;
    let mut selected_source = "global";
    if let Some(project_id) = input
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if let Some(mut connection) = open_app_database().await? {
            if let Some(worktree_id) = input
                .worktree_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
            {
                let worktree = sqlx::query_scalar::<_, String>(
                    "SELECT provider_overrides FROM worktrees
                     WHERE id = ?1 AND project_id = ?2 AND status = 'active'",
                )
                .bind(worktree_id)
                .bind(project_id)
                .fetch_optional(&mut connection)
                .await
                .map_err(|_| "provider_scope_database_error".to_string())?;
                if let Some(provider_id) = parse_provider_reference(worktree.as_deref(), &app_type)?
                {
                    selected_id = Some(provider_id);
                    selected_source = "worktree";
                }
            }
            if selected_id.is_none() {
                let project = read_scope_override(
                    &mut connection,
                    "projects".to_string(),
                    project_id.to_string(),
                )
                .await?;
                if let Some(provider_id) = parse_provider_reference(project.as_deref(), &app_type)?
                {
                    selected_id = Some(provider_id);
                    selected_source = "project";
                }
            }
        }
    }
    let provider_id = match selected_id {
        Some(provider_id) => provider_id,
        None => current_provider_id(app_type.clone()).await?,
    };
    Ok(ResolvedSelection {
        provider: load_provider(app_type, provider_id, None).await?,
        source: selected_source,
    })
}

fn snapshot_id_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn generated_root(app_type: &str, snapshot_id: &str) -> Result<PathBuf, String> {
    let app_type = normalize_type(app_type)?;
    if !snapshot_id_valid(snapshot_id) {
        return Err("provider_snapshot_invalid".to_string());
    }
    Ok(app_paths::providers_dir()?
        .join(GENERATED_ROOT)
        .join(app_type)
        .join(snapshot_id))
}

fn write_snapshot_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "provider_snapshot_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "provider_snapshot_write_failed".to_string())?;
    fs::write(path, bytes).map_err(|_| "provider_snapshot_write_failed".to_string())
}

fn snapshot_manifest_path(root: &Path) -> PathBuf {
    root.join("manifest.json")
}

fn write_manifest(root: &Path, manifest: &SnapshotManifest) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(manifest).map_err(|_| "provider_snapshot_write_failed".to_string())?;
    write_snapshot_file(&snapshot_manifest_path(root), &bytes)
}

fn read_manifest(app_type: &str, snapshot_id: &str) -> Result<(PathBuf, SnapshotManifest), String> {
    let root = generated_root(app_type, snapshot_id)?;
    let bytes = fs::read(snapshot_manifest_path(&root))
        .map_err(|_| "provider_snapshot_missing".to_string())?;
    let manifest =
        serde_json::from_slice(&bytes).map_err(|_| "provider_snapshot_invalid".to_string())?;
    Ok((root, manifest))
}

fn wsl_shell(shell: Option<&str>) -> bool {
    cfg!(target_os = "windows")
        && matches!(
            shell.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
            Some("wsl") | Some("bash")
        )
}

fn path_for_shell(path: &Path, shell: Option<&str>) -> String {
    let value = path.to_string_lossy().into_owned();
    if wsl_shell(shell) {
        return wsl::windows_path_to_wsl(&value).unwrap_or(value);
    }
    value
}

fn path_matches(expected: &Path, actual: Option<&str>) -> bool {
    actual
        .map(PathBuf::from)
        .is_some_and(|path| path == expected)
}

fn write_snapshot_bundle(
    root: &Path,
    provider: &NativeProvider,
    effective: &Value,
    snapshot_id: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let mut claude_settings_path = None;
    let mut generated_home = None;

    match provider.app_type.as_str() {
        "claude" => {
            let (bytes, _) = global::materialize_claude(None, effective, &provider.active_key)?;
            let path = root.join("claude").join("settings.json");
            write_snapshot_file(&path, &bytes)?;
            claude_settings_path = Some(path.to_string_lossy().into_owned());
        }
        "codex" => {
            let (auth, _) = global::materialize_codex_auth(None, effective, &provider.active_key)?;
            let (config, _) = global::materialize_codex_config(None, effective)?;
            let home = root.join("codex");
            write_snapshot_file(&home.join("auth.json"), &auth)?;
            write_snapshot_file(&home.join("config.toml"), &config)?;
            generated_home = Some(home.to_string_lossy().into_owned());
        }
        "grokbuild" => {
            let (config, _) = global::materialize_grok_config(None, effective)?;
            let home = root.join("grok");
            write_snapshot_file(&home.join("config.toml"), &config)?;
            generated_home = Some(home.to_string_lossy().into_owned());
        }
        _ => return Err("provider_invalid_app_type".to_string()),
    }

    write_snapshot_file(
        &root.join(SNAPSHOT_KEY_FILE),
        provider.active_key.as_bytes(),
    )?;
    write_manifest(
        root,
        &SnapshotManifest {
            app_type: provider.app_type.clone(),
            provider_id: provider.id.clone(),
            active_key_id: provider.active_key_id.clone(),
            snapshot_id: snapshot_id.to_string(),
        },
    )?;
    Ok((claude_settings_path, generated_home))
}

fn write_snapshot_bundle_or_cleanup(
    root: &Path,
    provider: &NativeProvider,
    effective: &Value,
    snapshot_id: &str,
) -> Result<(Option<String>, Option<String>), String> {
    match write_snapshot_bundle(root, provider, effective, snapshot_id) {
        Ok(paths) => Ok(paths),
        Err(error) => {
            let _ = fs::remove_dir_all(root);
            Err(error)
        }
    }
}

pub(crate) async fn resolve(input: ScopeResolveInput) -> Result<ResolvedProvider, String> {
    let selection = resolve_selection(input).await?;
    Ok(ResolvedProvider {
        app_type: selection.provider.app_type,
        provider_id: selection.provider.id,
        provider_name: selection.provider.name,
        source: selection.source.to_string(),
    })
}

pub(crate) async fn prepare(input: ScopePrepareInput) -> Result<ProviderLaunchSnapshot, String> {
    let resolve_input = ScopeResolveInput {
        app_type: input.app_type,
        project_id: input.project_id,
        worktree_id: input.worktree_id,
        provider_id: input.provider_id,
    };
    let selection = resolve_selection(resolve_input).await?;
    let effective = effective_settings(selection.provider.clone()).await?;
    let snapshot_id = Uuid::new_v4().to_string();
    let root = generated_root(&selection.provider.app_type, &snapshot_id)?;
    fs::create_dir_all(&root).map_err(|_| "provider_snapshot_write_failed".to_string())?;
    let (claude_settings_path, generated_home) =
        write_snapshot_bundle_or_cleanup(&root, &selection.provider, &effective, &snapshot_id)?;

    Ok(ProviderLaunchSnapshot {
        app_type: selection.provider.app_type,
        provider_id: selection.provider.id,
        provider_name: selection.provider.name,
        source: selection.source.to_string(),
        snapshot_id,
        claude_settings_path,
        generated_home,
    })
}

pub(crate) async fn release_snapshot(snapshot_id: String) -> Result<(), String> {
    let snapshot_id = snapshot_id.trim();
    if !snapshot_id_valid(snapshot_id) {
        return Err("provider_snapshot_invalid".to_string());
    }
    for app_type in SNAPSHOT_APP_TYPES {
        let root = generated_root(app_type, snapshot_id)?;
        if !root.is_dir() {
            continue;
        }
        let Ok((_, manifest)) = read_manifest(app_type, snapshot_id) else {
            continue;
        };
        if manifest.snapshot_id != snapshot_id || manifest.app_type != app_type {
            continue;
        }
        fs::remove_dir_all(root).map_err(|_| "provider_snapshot_release_failed".to_string())?;
    }
    Ok(())
}

pub(crate) async fn garbage_collect_snapshots(
    active_snapshot_ids: Vec<String>,
) -> Result<(), String> {
    let active_snapshot_ids = active_snapshot_ids
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if active_snapshot_ids
        .iter()
        .any(|snapshot_id| !snapshot_id_valid(snapshot_id))
    {
        return Err("provider_snapshot_invalid".to_string());
    }
    let generated_root = app_paths::providers_dir()?.join(GENERATED_ROOT);
    if !generated_root.is_dir() {
        return Ok(());
    }
    for app_type in SNAPSHOT_APP_TYPES {
        let app_root = generated_root.join(app_type);
        let Ok(entries) = fs::read_dir(&app_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(snapshot_id) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !snapshot_id_valid(snapshot_id)
                || active_snapshot_ids
                    .iter()
                    .any(|active| active == snapshot_id)
            {
                continue;
            }
            let Ok((_, manifest)) = read_manifest(app_type, snapshot_id) else {
                continue;
            };
            if manifest.snapshot_id != snapshot_id || manifest.app_type != app_type {
                continue;
            }
            fs::remove_dir_all(path).map_err(|_| "provider_snapshot_release_failed".to_string())?;
        }
    }
    Ok(())
}

pub(crate) async fn apply_launch_environment(
    config: ProviderLaunchConfig,
    shell: Option<String>,
    env_vars: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(apply_launch_environment_inner(config, shell, env_vars))
    })
    .await
    .map_err(|_| "provider_snapshot_apply_failed".to_string())?
}

async fn apply_launch_environment_inner(
    config: ProviderLaunchConfig,
    shell: Option<String>,
    mut env_vars: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let app_type = normalize_type(&config.app_type)?;
    let (root, manifest) = read_manifest(&app_type, &config.snapshot_id)?;
    if manifest.app_type != app_type
        || manifest.provider_id != config.provider_id.trim()
        || manifest.snapshot_id != config.snapshot_id
    {
        return Err("provider_snapshot_mismatch".to_string());
    }
    let expected_home = match app_type.as_str() {
        "codex" => root.join("codex"),
        "grokbuild" => root.join("grok"),
        _ => root.clone(),
    };
    if app_type == "claude" {
        let expected = root.join("claude").join("settings.json");
        if !path_matches(&expected, config.claude_settings_path.as_deref()) || !expected.is_file() {
            return Err("provider_snapshot_missing".to_string());
        }
        return Ok(env_vars);
    }
    if !path_matches(&expected_home, config.generated_home.as_deref()) {
        return Err("provider_snapshot_mismatch".to_string());
    }
    let required_files = if app_type == "codex" {
        vec![
            expected_home.join("auth.json"),
            expected_home.join("config.toml"),
        ]
    } else {
        vec![expected_home.join("config.toml")]
    };
    if required_files.iter().any(|path| !path.is_file()) {
        return Err("provider_snapshot_missing".to_string());
    }
    let active_key = fs::read(root.join(SNAPSHOT_KEY_FILE))
        .map_err(|_| "provider_snapshot_missing".to_string())
        .and_then(|bytes| {
            String::from_utf8(bytes).map_err(|_| "provider_snapshot_invalid".to_string())
        })?;
    if active_key.trim().is_empty() {
        return Err("provider_snapshot_invalid".to_string());
    }
    let env_key = if app_type == "codex" {
        CODEX_PROVIDER_ENV_KEY
    } else {
        GROK_PROVIDER_ENV_KEY
    };
    env_vars.insert(
        "CLI_MANAGER_PROVIDER_KEY_SCOPE".to_string(),
        "snapshot".to_string(),
    );
    env_vars.insert(env_key.to_string(), active_key);
    let home_value = path_for_shell(&expected_home, shell.as_deref());
    env_vars.insert(
        if app_type == "codex" {
            "CODEX_HOME".to_string()
        } else {
            "GROK_HOME".to_string()
        },
        home_value,
    );
    Ok(env_vars)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_reference_is_required_for_runtime_scope() {
        let raw = r#"{"claude":{"schemaVersion":2,"source":"cli-manager","appType":"claude","providerId":"p1"}}"#;
        assert_eq!(
            parse_provider_reference(Some(raw), "claude").unwrap(),
            Some("p1".to_string())
        );
        let legacy = r#"{"claude":{"providerId":"ccs-p1","settingsPath":"old"}}"#;
        assert_eq!(
            parse_provider_reference(Some(legacy), "claude").unwrap_err(),
            "provider_reference_migration_required"
        );
    }

    #[test]
    fn grok_legacy_reference_alias_is_accepted() {
        let raw = r#"{"grok":{"schemaVersion":2,"source":"cli-manager","appType":"grokbuild","providerId":"p1"}}"#;
        assert_eq!(
            parse_provider_reference(Some(raw), "grokbuild").unwrap(),
            Some("p1".to_string())
        );
    }

    #[test]
    fn snapshot_ids_cannot_escape_generated_root() {
        assert!(snapshot_id_valid("snapshot-1"));
        assert!(!snapshot_id_valid("..\\outside"));
        assert!(!snapshot_id_valid(""));
    }

    #[test]
    fn snapshot_app_types_are_native_only() {
        assert_eq!(SNAPSHOT_APP_TYPES, ["claude", "codex", "grokbuild"]);
    }

    #[test]
    fn failed_snapshot_materialization_removes_partial_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("snapshot");
        fs::create_dir_all(&root).unwrap();
        let provider = NativeProvider {
            id: "provider-1".to_string(),
            name: "Provider".to_string(),
            app_type: "codex".to_string(),
            settings_config: "{}".to_string(),
            meta: "{}".to_string(),
            active_key_id: "key-1".to_string(),
            active_key: "secret".to_string(),
        };

        let result = write_snapshot_bundle_or_cleanup(
            &root,
            &provider,
            &json!({"config": "["}),
            "snapshot-1",
        );

        assert_eq!(result, Err("provider_config_invalid".to_string()));
        assert!(!root.exists());
    }

    #[test]
    fn wsl_shell_converts_generated_windows_path() {
        let path = Path::new(r"C:\Users\me\.cli-manager\generated\codex");
        if cfg!(target_os = "windows") {
            assert_eq!(
                path_for_shell(path, Some("wsl")),
                "/mnt/c/Users/me/.cli-manager/generated/codex"
            );
        }
        assert_eq!(
            path_for_shell(path, Some("powershell")),
            path.to_string_lossy()
        );
    }
}
