use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteRow};
use sqlx::{Connection, Row};

use super::adapters::parse_native_config;
use super::model::{
    derive_resource_id, redact_resource, ExtensionCli, McpResource, McpResourceRedacted,
    McpResourceSource,
};
use super::repository;
use super::skill_deployment::{
    candidates_fingerprint, publish_skill_candidate, scan_skill_candidates, SkillCandidate,
    SkillSourceMetadata,
};
use super::skill_repository;
use crate::{app_paths, ccswitch_db, wsl};

const MAX_NATIVE_CONFIG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SOURCE_DB_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CCSWITCH_ROWS: usize = 2048;
const MAX_CCSWITCH_ITEMS: usize = 4096;
const MAX_CCSWITCH_CONFIG_BYTES: usize = 8 * 1024 * 1024;
const MAX_CCSWITCH_TEXT_BYTES: usize = 16 * 1024;
const MAX_CCSWITCH_PATH_BYTES: usize = 4096;
const SOURCE_KIND_NATIVE: &str = "nativeMcp";
const SOURCE_KIND_CCSWITCH: &str = "ccswitch";
const SOURCE_KIND_SKILL_DIRECTORY: &str = "skillDirectory";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionImportRequest {
    pub source_kind: String,
    pub cli: Option<ExtensionCli>,
    pub source_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionImportApplyRequest {
    pub source_kind: String,
    pub cli: Option<ExtensionCli>,
    pub source_path: Option<String>,
    pub expected_fingerprint: String,
    #[serde(default)]
    pub selected_resource_ids: Vec<String>,
    #[serde(default)]
    pub selected_skill_ids: Vec<String>,
    #[serde(default = "default_conflict_policy")]
    pub conflict_policy: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionImportItemPreview {
    pub candidate_id: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub content_hash: String,
    pub action: String,
    pub reason: Option<String>,
    pub resource: Option<McpResourceRedacted>,
    pub skill: Option<SkillImportPreview>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillImportPreview {
    pub package_id: String,
    pub source_identity: String,
    pub source_ref: String,
    pub subdirectory: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionImportPreview {
    pub source_kind: String,
    pub source_identity: String,
    pub source_path: String,
    pub source_fingerprint: String,
    pub items: Vec<ExtensionImportItemPreview>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionImportItemResult {
    pub candidate_id: String,
    pub kind: String,
    pub status: String,
    pub resource_id: Option<String>,
    pub package_id: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionImportResult {
    pub source_kind: String,
    pub source_identity: String,
    pub source_fingerprint: String,
    pub items: Vec<ExtensionImportItemResult>,
    pub imported: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub failed: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone)]
struct ResourceCandidate {
    candidate_id: String,
    resource: McpResource,
    content_hash: String,
}

struct ImportSnapshot {
    source_kind: String,
    source_identity: String,
    source_path: PathBuf,
    source_fingerprint: String,
    resources: Vec<ResourceCandidate>,
    skills: Vec<SkillCandidate>,
    warnings: Vec<String>,
    temporary_sources: Vec<TemporaryImportDirectory>,
}

struct TemporaryImportDirectory {
    path: PathBuf,
}

impl TemporaryImportDirectory {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryImportDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Clone, Copy)]
enum ConflictPolicy {
    Skip,
    Replace,
    SaveAs,
}

// 只读扫描外部 MCP/Skill 来源，preview 不创建应用包、不改写源数据库或原生配置。
pub(crate) async fn preview(
    request: ExtensionImportRequest,
) -> Result<ExtensionImportPreview, String> {
    let snapshot = scan_source(&request).await?;
    build_preview(snapshot).await
}

// apply 会以同一请求再次扫描并核对指纹，然后才进入应用数据写入和包发布阶段。
pub(crate) async fn apply(
    request: ExtensionImportApplyRequest,
) -> Result<ExtensionImportResult, String> {
    let source_request = ExtensionImportRequest {
        source_kind: request.source_kind.clone(),
        cli: request.cli,
        source_path: request.source_path.clone(),
    };
    let snapshot = scan_source(&source_request).await?;
    let _ = snapshot.temporary_sources.len();
    if snapshot.source_fingerprint != request.expected_fingerprint.trim() {
        return Err("extensions_import_source_changed".to_string());
    }
    let policy = parse_conflict_policy(&request.conflict_policy)?;
    let selected_resources = selected_ids(&request.selected_resource_ids);
    let selected_skills = selected_ids(&request.selected_skill_ids);
    validate_selected_ids(
        &selected_resources,
        &snapshot
            .resources
            .iter()
            .map(|item| item.candidate_id.clone())
            .collect::<HashSet<_>>(),
        "resource",
    )?;
    validate_selected_ids(
        &selected_skills,
        &snapshot
            .skills
            .iter()
            .map(|item| item.candidate_id.clone())
            .collect::<HashSet<_>>(),
        "skill",
    )?;
    let mut result = ExtensionImportResult {
        source_kind: snapshot.source_kind.clone(),
        source_identity: snapshot.source_identity.clone(),
        source_fingerprint: snapshot.source_fingerprint.clone(),
        items: Vec::new(),
        imported: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        failed: 0,
        warnings: snapshot.warnings.clone(),
    };
    let existing_resources = repository::list_mcp_resource_records().await?;
    let mut resources_by_id = existing_resources
        .iter()
        .map(|record| (record.resource.resource_id.clone(), record.resource.clone()))
        .collect::<HashMap<_, _>>();
    let mut keys = existing_resources
        .iter()
        .map(|record| {
            (
                record.resource.server_key.clone(),
                record.resource.resource_id.clone(),
            )
        })
        .collect::<HashMap<_, _>>();
    for candidate in snapshot.resources {
        let candidate_id = candidate.candidate_id.clone();
        let resource_id = candidate.resource.resource_id.clone();
        if !selected_resources.is_empty() && !selected_resources.contains(&candidate.candidate_id) {
            result.skipped += 1;
            result.items.push(item_result(
                &candidate_id,
                "mcp",
                "skipped",
                Some(resource_id.clone()),
                None,
                Some("not_selected"),
            ));
            continue;
        }
        match apply_resource(candidate, policy, &mut resources_by_id, &mut keys).await {
            Ok(outcome) => {
                match outcome.status.as_str() {
                    "imported" => result.imported += 1,
                    "updated" => result.updated += 1,
                    "unchanged" => result.unchanged += 1,
                    "skipped" => result.skipped += 1,
                    _ => result.failed += 1,
                }
                result.items.push(outcome);
            }
            Err(error) => {
                result.failed += 1;
                result.items.push(item_result(
                    &candidate_id,
                    "mcp",
                    "failed",
                    Some(resource_id),
                    None,
                    Some(&error),
                ));
            }
        }
    }
    for candidate in snapshot.skills {
        if !selected_skills.is_empty() && !selected_skills.contains(&candidate.candidate_id) {
            result.skipped += 1;
            result.items.push(item_result(
                &candidate.candidate_id,
                "skill",
                "skipped",
                None,
                Some(candidate.candidate_id.clone()),
                Some("not_selected"),
            ));
            continue;
        }
        match skill_repository::find_package_by_identity_hash(
            &candidate.source.source_kind,
            &candidate.source.source_identity,
            &candidate.source.subdirectory,
            &candidate.content_hash,
        )
        .await
        {
            Ok(Some(package)) => {
                result.unchanged += 1;
                result.items.push(item_result(
                    &candidate.candidate_id,
                    "skill",
                    "unchanged",
                    None,
                    Some(package.package_id),
                    None,
                ));
            }
            Ok(None) => match publish_skill_candidate(&candidate).await {
                Ok(package) => {
                    result.imported += 1;
                    result.items.push(item_result(
                        &candidate.candidate_id,
                        "skill",
                        "imported",
                        None,
                        Some(package.package_id),
                        None,
                    ));
                }
                Err(error) => {
                    result.failed += 1;
                    result.items.push(item_result(
                        &candidate.candidate_id,
                        "skill",
                        "failed",
                        None,
                        None,
                        Some(&error),
                    ));
                }
            },
            Err(error) => {
                result.failed += 1;
                result.items.push(item_result(
                    &candidate.candidate_id,
                    "skill",
                    "failed",
                    None,
                    None,
                    Some(&error),
                ));
            }
        }
    }
    Ok(result)
}

async fn build_preview(snapshot: ImportSnapshot) -> Result<ExtensionImportPreview, String> {
    let _ = snapshot.temporary_sources.len();
    let existing_resources = repository::list_mcp_resource_records().await?;
    let existing_packages = skill_repository::list_packages().await?;
    let resources_by_id = existing_resources
        .iter()
        .map(|record| (&record.resource.resource_id, &record.resource))
        .collect::<HashMap<_, _>>();
    let packages_by_identity = existing_packages
        .iter()
        .map(|package| {
            (
                (
                    package.source_kind.as_str(),
                    package.source_identity.as_str(),
                    package.subdirectory.as_str(),
                    package.content_hash.as_str(),
                ),
                package,
            )
        })
        .collect::<HashMap<_, _>>();
    let mut items = Vec::with_capacity(snapshot.resources.len() + snapshot.skills.len());
    for candidate in snapshot.resources {
        let (action, reason) = match resources_by_id.get(&candidate.resource.resource_id) {
            None => ("create", None),
            Some(existing) if resource_hash(existing)? == candidate.content_hash => {
                ("unchanged", None)
            }
            Some(_) => ("update", Some("existing_resource".to_string())),
        };
        items.push(ExtensionImportItemPreview {
            candidate_id: candidate.candidate_id,
            kind: "mcp".to_string(),
            name: candidate.resource.name.clone(),
            description: candidate.resource.server_key.clone(),
            content_hash: candidate.content_hash,
            action: action.to_string(),
            reason,
            resource: Some(redact_resource(&candidate.resource)),
            skill: None,
        });
    }
    for candidate in snapshot.skills {
        let key = (
            candidate.source.source_kind.as_str(),
            candidate.source.source_identity.as_str(),
            candidate.source.subdirectory.as_str(),
            candidate.content_hash.as_str(),
        );
        let (action, reason) = if packages_by_identity.contains_key(&key) {
            ("unchanged", None)
        } else {
            ("create", None)
        };
        items.push(ExtensionImportItemPreview {
            candidate_id: candidate.candidate_id.clone(),
            kind: "skill".to_string(),
            name: candidate.name.clone(),
            description: candidate.description.clone(),
            content_hash: candidate.content_hash.clone(),
            action: action.to_string(),
            reason,
            resource: None,
            skill: Some(SkillImportPreview {
                package_id: candidate.candidate_id,
                source_identity: candidate.source.source_identity.clone(),
                source_ref: candidate.source.source_ref.clone(),
                subdirectory: candidate.source.subdirectory.clone(),
                file_count: candidate.file_count,
                total_bytes: candidate.total_bytes,
            }),
        });
    }
    Ok(ExtensionImportPreview {
        source_kind: snapshot.source_kind,
        source_identity: snapshot.source_identity,
        source_path: snapshot.source_path.to_string_lossy().into_owned(),
        source_fingerprint: snapshot.source_fingerprint,
        items,
        warnings: snapshot.warnings,
    })
}

async fn scan_source(request: &ExtensionImportRequest) -> Result<ImportSnapshot, String> {
    match request.source_kind.trim() {
        SOURCE_KIND_NATIVE => scan_native(request).await,
        SOURCE_KIND_CCSWITCH => scan_ccswitch(request).await,
        SOURCE_KIND_SKILL_DIRECTORY => scan_skill_directory(request).await,
        _ => Err("extensions_import_source_kind_invalid".to_string()),
    }
}

async fn scan_native(request: &ExtensionImportRequest) -> Result<ImportSnapshot, String> {
    let cli = request
        .cli
        .ok_or_else(|| "extensions_import_cli_required".to_string())?;
    let path = required_source_path(request.source_path.as_deref())?;
    validate_native_extension(&path, cli)?;
    let bytes = read_source_file(&path, MAX_NATIVE_CONFIG_BYTES as usize)?;
    let source = String::from_utf8(bytes.clone())
        .map_err(|_| "extensions_import_native_invalid_encoding".to_string())?;
    let parsed = parse_native_config(cli, &source)?;
    let source_identity = path.to_string_lossy().into_owned();
    let resources = parsed
        .resources
        .into_iter()
        .map(|mut resource| {
            resource.source = Some(McpResourceSource {
                kind: format!("native:{}", cli.key()),
                identity: source_identity.clone(),
                label: Some(cli.display_name().to_string()),
            });
            resource_candidate(resource)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ImportSnapshot {
        source_kind: SOURCE_KIND_NATIVE.to_string(),
        source_identity,
        source_path: path,
        source_fingerprint: bytes_fingerprint(&bytes),
        resources,
        skills: Vec::new(),
        warnings: Vec::new(),
        temporary_sources: Vec::new(),
    })
}

async fn scan_skill_directory(request: &ExtensionImportRequest) -> Result<ImportSnapshot, String> {
    let path = required_source_path(request.source_path.as_deref())?;
    let source_identity = path.to_string_lossy().into_owned();
    let source = SkillSourceMetadata {
        source_kind: SOURCE_KIND_SKILL_DIRECTORY.to_string(),
        source_identity: source_identity.clone(),
        source_ref: String::new(),
        resolved_commit: None,
        subdirectory: String::new(),
        version: None,
    };
    let temporary_source = if wsl::is_wsl_config_dir(&source_identity) {
        Some(snapshot_wsl_skill_directory(&path)?)
    } else {
        None
    };
    let scan_path = temporary_source
        .as_ref()
        .map(|temporary| temporary.path())
        .unwrap_or(&path);
    let skills = scan_skill_candidates(scan_path, source)?;
    let source_fingerprint = candidates_fingerprint(&source_identity, &skills);
    Ok(ImportSnapshot {
        source_kind: SOURCE_KIND_SKILL_DIRECTORY.to_string(),
        source_identity,
        source_path: path,
        source_fingerprint,
        resources: Vec::new(),
        skills,
        warnings: Vec::new(),
        temporary_sources: temporary_source.into_iter().collect(),
    })
}

async fn scan_ccswitch(request: &ExtensionImportRequest) -> Result<ImportSnapshot, String> {
    let path = ccswitch_source_path(request.source_path.as_deref())?;
    let exists = if wsl::is_wsl_config_dir(&path.to_string_lossy()) {
        ccswitch_db::wsl_file_exists(&path)?
    } else {
        fs::symlink_metadata(&path)
            .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
            .unwrap_or(false)
    };
    if !exists {
        return Err("extensions_import_source_missing".to_string());
    }
    let prepared = ccswitch_db::prepare_read_path(&path).await?;
    let database_bytes = read_source_file(prepared.path(), MAX_SOURCE_DB_BYTES as usize)?;
    let database_fingerprint = bytes_fingerprint(&database_bytes);
    let mut connection = open_read_only_database(prepared.path()).await?;
    let source_identity = path.to_string_lossy().into_owned();
    let mut warnings = Vec::new();
    let resources =
        read_ccswitch_resources(&mut connection, &source_identity, &mut warnings).await?;
    let (skills, temporary_sources) =
        read_ccswitch_skills(&mut connection, &path, &source_identity, &mut warnings).await?;
    let source_fingerprint =
        parsed_source_fingerprint(&source_identity, &database_fingerprint, &resources, &skills);
    Ok(ImportSnapshot {
        source_kind: SOURCE_KIND_CCSWITCH.to_string(),
        source_identity,
        source_path: path,
        source_fingerprint,
        resources,
        skills,
        warnings,
        temporary_sources,
    })
}

async fn read_ccswitch_resources(
    connection: &mut SqliteConnection,
    source_identity: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<ResourceCandidate>, String> {
    if !table_exists(connection, "mcp_servers").await? {
        warnings.push("ccswitch_mcp_servers_missing".to_string());
        return Ok(Vec::new());
    }
    let rows = sqlx::query("SELECT * FROM mcp_servers LIMIT ?1")
        .bind((MAX_CCSWITCH_ROWS + 1) as i64)
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| "extensions_import_ccswitch_query_failed".to_string())?;
    if rows.len() > MAX_CCSWITCH_ROWS {
        return Err("extensions_import_ccswitch_too_many_rows".to_string());
    }
    let mut resources = Vec::new();
    for row in rows {
        let Some(server_key) = row_string_with_limit(&row, "id", MAX_CCSWITCH_TEXT_BYTES)
            .or_else(|| row_string_with_limit(&row, "name", MAX_CCSWITCH_TEXT_BYTES))
        else {
            warnings.push("ccswitch_mcp_row_missing_id".to_string());
            continue;
        };
        let Some(raw_config) =
            row_string_with_limit(&row, "server_config", MAX_CCSWITCH_CONFIG_BYTES)
                .or_else(|| row_string_with_limit(&row, "config", MAX_CCSWITCH_CONFIG_BYTES))
        else {
            warnings.push(format!(
                "ccswitch_mcp_config_missing:{}",
                warning_label(&server_key)
            ));
            continue;
        };
        let value = match serde_json::from_str::<Value>(&raw_config) {
            Ok(Value::Object(object)) => Value::Object(object),
            _ => {
                warnings.push(format!(
                    "ccswitch_mcp_config_invalid:{}",
                    warning_label(&server_key)
                ));
                continue;
            }
        };
        let root = if value.get("mcpServers").is_some() {
            value
        } else {
            serde_json::json!({ "mcpServers": { server_key.clone(): value } })
        };
        let parsed = match parse_native_config(ExtensionCli::Claude, &root.to_string()) {
            Ok(parsed) => parsed,
            Err(error) => {
                warnings.push(format!(
                    "ccswitch_mcp_skipped:{}:{}",
                    warning_label(&server_key),
                    warning_label(&error)
                ));
                continue;
            }
        };
        let row_name = row_string_with_limit(&row, "name", MAX_CCSWITCH_TEXT_BYTES);
        for mut resource in parsed.resources {
            if let Some(name) = row_name.as_ref() {
                resource.name = name.clone();
            }
            resource.source = Some(McpResourceSource {
                kind: SOURCE_KIND_CCSWITCH.to_string(),
                identity: format!("{source_identity}#mcp:{server_key}"),
                label: Some("cc-switch".to_string()),
            });
            match resource_candidate(resource) {
                Ok(candidate) if resources.len() < MAX_CCSWITCH_ITEMS => resources.push(candidate),
                Ok(_) => return Err("extensions_import_ccswitch_too_many_items".to_string()),
                Err(error) => warnings.push(format!(
                    "ccswitch_mcp_skipped:{}:{}",
                    warning_label(&server_key),
                    warning_label(&error)
                )),
            }
        }
    }
    Ok(resources)
}

async fn read_ccswitch_skills(
    connection: &mut SqliteConnection,
    database_path: &Path,
    source_identity: &str,
    warnings: &mut Vec<String>,
) -> Result<(Vec<SkillCandidate>, Vec<TemporaryImportDirectory>), String> {
    if !table_exists(connection, "skills").await? {
        warnings.push("ccswitch_skills_missing".to_string());
        return Ok((Vec::new(), Vec::new()));
    }
    let rows = sqlx::query("SELECT * FROM skills LIMIT ?1")
        .bind((MAX_CCSWITCH_ROWS + 1) as i64)
        .fetch_all(&mut *connection)
        .await
        .map_err(|_| "extensions_import_ccswitch_query_failed".to_string())?;
    if rows.len() > MAX_CCSWITCH_ROWS {
        return Err("extensions_import_ccswitch_too_many_rows".to_string());
    }
    let root = database_path
        .parent()
        .ok_or_else(|| "extensions_import_source_invalid".to_string())?
        .join("skills");
    let mut skills = Vec::new();
    let mut temporary_sources = Vec::new();
    let source_is_wsl = wsl::is_wsl_config_dir(&database_path.to_string_lossy());
    for row in rows {
        let Some(directory) = row_string_with_limit(&row, "directory", MAX_CCSWITCH_PATH_BYTES)
        else {
            warnings.push("ccswitch_skill_directory_missing".to_string());
            continue;
        };
        let directory = match normalize_relative_path(&directory) {
            Ok(value) if !value.is_empty() => value,
            _ => {
                warnings.push("ccswitch_skill_directory_invalid".to_string());
                continue;
            }
        };
        let package_path = root.join(directory.replace('/', std::path::MAIN_SEPARATOR_STR));
        let skill_id = row_string_with_limit(&row, "id", MAX_CCSWITCH_TEXT_BYTES)
            .unwrap_or_else(|| directory.clone());
        let scan_path = if source_is_wsl {
            match snapshot_wsl_skill_directory(&package_path) {
                Ok(temporary) => {
                    let scan_path = temporary.path().to_path_buf();
                    temporary_sources.push(temporary);
                    scan_path
                }
                Err(error) => {
                    warnings.push(format!(
                        "ccswitch_skill_source_unavailable:{}:{}",
                        warning_label(&skill_id),
                        warning_label(&error)
                    ));
                    continue;
                }
            }
        } else {
            if !package_path.is_dir() {
                warnings.push(format!(
                    "ccswitch_skill_source_missing:{}",
                    warning_label(&skill_id)
                ));
                continue;
            }
            package_path.clone()
        };
        let source = SkillSourceMetadata {
            source_kind: SOURCE_KIND_CCSWITCH.to_string(),
            source_identity: format!("{source_identity}#skill:{skill_id}"),
            source_ref: row_string_with_limit(&row, "repo_branch", MAX_CCSWITCH_TEXT_BYTES)
                .unwrap_or_default(),
            resolved_commit: None,
            subdirectory: directory,
            version: None,
        };
        match scan_skill_candidates(&scan_path, source) {
            Ok(mut candidates) => {
                if skills.len().saturating_add(candidates.len()) > MAX_CCSWITCH_ITEMS {
                    return Err("extensions_import_ccswitch_too_many_items".to_string());
                }
                skills.append(&mut candidates);
            }
            Err(error) => warnings.push(format!(
                "ccswitch_skill_skipped:{}:{}",
                warning_label(&skill_id),
                warning_label(&error)
            )),
        }
    }
    Ok((skills, temporary_sources))
}

async fn open_read_only_database(path: &Path) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(15));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "extensions_import_source_corrupt".to_string())
}

async fn table_exists(connection: &mut SqliteConnection, table: &str) -> Result<bool, String> {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
    )
    .bind(table)
    .fetch_one(&mut *connection)
    .await
    .map(|count| count > 0)
    .map_err(|_| "extensions_import_source_corrupt".to_string())
}

fn row_string_with_limit(row: &SqliteRow, column: &str, limit: usize) -> Option<String> {
    row.try_get::<String, _>(column)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .filter(|value| value.len() <= limit)
}

fn warning_label(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(128)
        .collect()
}

fn resource_candidate(resource: McpResource) -> Result<ResourceCandidate, String> {
    let candidate_id = resource.resource_id.clone();
    let content_hash = resource_hash(&resource)?;
    Ok(ResourceCandidate {
        candidate_id,
        resource,
        content_hash,
    })
}

fn resource_hash(resource: &McpResource) -> Result<String, String> {
    let bytes = serde_json::to_vec(resource)
        .map_err(|_| "extensions_import_resource_serialize_failed".to_string())?;
    Ok(bytes_fingerprint(&bytes))
}

fn bytes_fingerprint(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

// 以数据库字节指纹和实际候选内容生成 cc-switch 指纹，覆盖 SQLite 与外部 Skill 变更。
fn parsed_source_fingerprint(
    source_identity: &str,
    database_fingerprint: &str,
    resources: &[ResourceCandidate],
    skills: &[SkillCandidate],
) -> String {
    let mut values = vec![format!("database:{database_fingerprint}")];
    values.extend(
        resources
            .iter()
            .map(|candidate| {
                format!(
                    "mcp:{}:{}:{}",
                    candidate.candidate_id, candidate.content_hash, candidate.resource.server_key
                )
            })
            .chain(skills.iter().map(|candidate| {
                format!(
                    "skill:{}:{}:{}:{}",
                    candidate.source.source_identity,
                    candidate.source.source_ref,
                    candidate.source.subdirectory,
                    candidate.content_hash
                )
            })),
    );
    values.sort();
    let mut hasher = Sha256::new();
    hasher.update((source_identity.len() as u64).to_le_bytes());
    hasher.update(source_identity.as_bytes());
    for value in values {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn required_source_path(value: Option<&str>) -> Result<PathBuf, String> {
    let value = value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "extensions_import_source_path_required".to_string())?;
    if value.chars().any(char::is_control) {
        return Err("extensions_import_source_invalid".to_string());
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("extensions_import_source_invalid".to_string());
    }
    Ok(path)
}

fn ccswitch_source_path(value: Option<&str>) -> Result<PathBuf, String> {
    let raw_value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if raw_value
        .as_deref()
        .is_some_and(|value| value.chars().any(char::is_control))
    {
        return Err("extensions_import_source_invalid".to_string());
    }
    let path = raw_value.map(PathBuf::from).map(Ok).unwrap_or_else(|| {
        app_paths::home_dir_from_env()
            .map(|home| home.join(".cc-switch").join("cc-switch.db"))
            .map_err(|_| "extensions_import_home_unavailable".to_string())
    })?;
    if path.extension().and_then(|value| value.to_str()) != Some("db") {
        return Err("extensions_import_source_unsupported_format".to_string());
    }
    if !path.is_absolute() {
        return Err("extensions_import_source_invalid".to_string());
    }
    Ok(path)
}

fn validate_native_extension(path: &Path, cli: ExtensionCli) -> Result<(), String> {
    let expected = match cli {
        ExtensionCli::Claude => "json",
        ExtensionCli::Codex | ExtensionCli::Grok => "toml",
    };
    if path.extension().and_then(|value| value.to_str()) != Some(expected) {
        return Err("extensions_import_native_format_invalid".to_string());
    }
    Ok(())
}

fn read_source_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    if wsl::is_wsl_config_dir(&path.to_string_lossy()) {
        return read_wsl_file(path, limit);
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "extensions_import_source_missing".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("extensions_import_source_link_unsupported".to_string());
    }
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("extensions_import_source_invalid".to_string());
    }
    let mut file =
        fs::File::open(path).map_err(|_| "extensions_import_source_unreadable".to_string())?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "extensions_import_source_unreadable".to_string())?;
    if bytes.len() > limit {
        return Err("extensions_import_source_too_large".to_string());
    }
    Ok(bytes)
}

#[cfg(target_os = "windows")]
fn read_wsl_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let (distro, linux_path) = wsl::parse_wsl_unc_path(&path.to_string_lossy())
        .ok_or_else(|| "extensions_wsl_path_invalid".to_string())?;
    let executable = wsl::find_wsl_exe().ok_or_else(|| "extensions_wsl_unavailable".to_string())?;
    let script = r#"
import os, sys
path = sys.argv[1]
if not os.path.isfile(path):
    raise SystemExit(2)
with open(path, 'rb') as source:
    data = source.read(int(sys.argv[2]) + 1)
sys.stdout.buffer.write(data)
"#;
    let mut command = crate::shell_resolver::silent_command(executable.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .args(["--exec", "python3", "-c", script])
        .arg(linux_path)
        .arg(limit.to_string());
    let output =
        crate::shell_resolver::output_with_timeout_bounded(command, Duration::from_secs(15), limit)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::TimedOut {
                    "extensions_wsl_timeout".to_string()
                } else {
                    "extensions_wsl_read_failed".to_string()
                }
            })?;
    if !output.status.success() {
        return Err("extensions_import_source_missing".to_string());
    }
    if output.stdout_truncated || output.stdout.len() > limit {
        return Err("extensions_import_source_too_large".to_string());
    }
    Ok(output.stdout)
}

#[cfg(not(target_os = "windows"))]
fn read_wsl_file(_path: &Path, _limit: usize) -> Result<Vec<u8>, String> {
    Err("extensions_wsl_unsupported".to_string())
}

#[cfg(target_os = "windows")]
fn snapshot_wsl_skill_directory(path: &Path) -> Result<TemporaryImportDirectory, String> {
    let (distro, source_linux) = wsl::parse_wsl_unc_path(&path.to_string_lossy())
        .ok_or_else(|| "extensions_wsl_path_invalid".to_string())?;
    if !is_safe_wsl_distro(&distro) || !is_safe_wsl_linux_path(&source_linux) {
        return Err("extensions_wsl_path_invalid".to_string());
    }
    let temporary_path = std::env::temp_dir().join(format!(
        "cli-manager-extension-import-{}",
        uuid::Uuid::new_v4()
    ));
    if fs::symlink_metadata(&temporary_path).is_ok() {
        return Err("extensions_wsl_snapshot_unavailable".to_string());
    }
    let target_linux = match wsl::windows_path_to_wsl(&temporary_path.to_string_lossy()) {
        Some(value) if is_safe_wsl_linux_path(&value) => value,
        _ => {
            let _ = fs::remove_dir_all(&temporary_path);
            return Err("extensions_wsl_snapshot_unavailable".to_string());
        }
    };
    let output = run_wsl_python(
        &distro,
        WSL_IMPORT_COPY_SCRIPT,
        &[&source_linux, &target_linux],
    )?;
    if !output.status.success() || output.stdout_truncated {
        let missing = first_wsl_line(&output.stdout) == "missing";
        let _ = fs::remove_dir_all(&temporary_path);
        return Err(if missing {
            "extensions_import_source_missing".to_string()
        } else {
            "extensions_wsl_snapshot_failed".to_string()
        });
    }
    if first_wsl_line(&output.stdout) != "ok" {
        let _ = fs::remove_dir_all(&temporary_path);
        return Err("extensions_wsl_snapshot_failed".to_string());
    }
    Ok(TemporaryImportDirectory {
        path: temporary_path,
    })
}

#[cfg(not(target_os = "windows"))]
fn snapshot_wsl_skill_directory(_path: &Path) -> Result<TemporaryImportDirectory, String> {
    Err("extensions_wsl_unsupported".to_string())
}

#[cfg(target_os = "windows")]
fn run_wsl_python(
    distro: &str,
    script: &str,
    args: &[&str],
) -> Result<crate::shell_resolver::BoundedOutput, String> {
    let executable = wsl::find_wsl_exe().ok_or_else(|| "extensions_wsl_unavailable".to_string())?;
    let mut command = crate::shell_resolver::silent_command(executable.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .args(["--exec", "python3", "-c", script])
        .args(args);
    crate::shell_resolver::output_with_timeout_bounded(command, Duration::from_secs(30), 8 * 1024)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                "extensions_wsl_timeout".to_string()
            } else {
                "extensions_wsl_command_failed".to_string()
            }
        })
}

#[cfg(target_os = "windows")]
fn is_safe_wsl_distro(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

#[cfg(target_os = "windows")]
fn is_safe_wsl_linux_path(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= MAX_CCSWITCH_PATH_BYTES
        && !value.chars().any(char::is_control)
        && !value.split('/').any(|part| part == "." || part == "..")
}

#[cfg(target_os = "windows")]
fn first_wsl_line(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|text| text.lines().next())
        .unwrap_or_default()
}

const WSL_IMPORT_COPY_SCRIPT: &str = r#"
import os, stat, sys
source, target = sys.argv[1], sys.argv[2]
MAX_FILES = 2048
MAX_BYTES = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_DEPTH = 24
count = 0
total = 0
def safe_name(name):
    return name not in ('.', '..') and '/' not in name and '\x00' not in name and not any(ord(c) < 32 for c in name)
def safe_parent(path):
    parent = os.path.dirname(path)
    if not parent.startswith('/'):
        return False
    current = '/'
    parts = parent.strip('/').split('/') if parent != '/' else []
    for part in parts:
        if not part or part in ('.', '..'):
            return False
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except OSError:
            return False
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return False
    return True
def copy_tree(src, dst, depth):
    global count, total
    if depth > MAX_DEPTH:
        raise RuntimeError('depth')
    st = os.lstat(src)
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
        raise RuntimeError('source')
    os.mkdir(dst)
    for name in sorted(os.listdir(src)):
        if not safe_name(name):
            raise RuntimeError('name')
        src_child = os.path.join(src, name)
        dst_child = os.path.join(dst, name)
        st = os.lstat(src_child)
        if stat.S_ISLNK(st.st_mode):
            raise RuntimeError('link')
        if stat.S_ISDIR(st.st_mode):
            copy_tree(src_child, dst_child, depth + 1)
        elif stat.S_ISREG(st.st_mode):
            if st.st_size > MAX_FILE:
                raise RuntimeError('file')
            count += 1
            if count > MAX_FILES:
                raise RuntimeError('files')
            with open(src_child, 'rb') as inp, open(dst_child, 'xb') as out:
                copied = 0
                while True:
                    data = inp.read(1024 * 1024)
                    if not data:
                        break
                    copied += len(data)
                    total += len(data)
                    if copied > MAX_FILE or total > MAX_BYTES:
                        raise RuntimeError('bytes')
                    out.write(data)
                if copied != st.st_size:
                    raise RuntimeError('changed')
        else:
            raise RuntimeError('special')
try:
    if not safe_parent(source) or not safe_parent(target):
        raise RuntimeError('parent')
    if not os.path.lexists(source):
        print('missing')
        raise SystemExit(0)
    if os.path.lexists(target):
        raise RuntimeError('target')
    copy_tree(source, target, 0)
    print('ok')
except SystemExit:
    raise
except Exception:
    if os.path.lexists(target):
        import shutil
        shutil.rmtree(target, ignore_errors=True)
    raise SystemExit(1)
"#;

async fn apply_resource(
    candidate: ResourceCandidate,
    policy: ConflictPolicy,
    resources_by_id: &mut HashMap<String, McpResource>,
    keys: &mut HashMap<String, String>,
) -> Result<ExtensionImportItemResult, String> {
    let original_id = candidate.resource.resource_id.clone();
    if let Some(existing) = resources_by_id.get(&original_id) {
        if resource_hash(existing)? == candidate.content_hash {
            return Ok(item_result(
                &candidate.candidate_id,
                "mcp",
                "unchanged",
                Some(original_id),
                None,
                None,
            ));
        }
        if matches!(policy, ConflictPolicy::Skip) {
            return Ok(item_result(
                &candidate.candidate_id,
                "mcp",
                "skipped",
                Some(original_id),
                None,
                Some("conflict"),
            ));
        }
    }
    let mut resource = candidate.resource;
    let mut status = if resources_by_id.contains_key(&original_id) {
        "updated"
    } else {
        "imported"
    };
    if matches!(policy, ConflictPolicy::SaveAs)
        && (resources_by_id.contains_key(&original_id)
            || keys
                .get(&resource.server_key)
                .is_some_and(|owner| owner != &original_id))
    {
        let suffix = candidate
            .content_hash
            .strip_prefix("sha256:")
            .unwrap_or(&candidate.content_hash)
            .chars()
            .take(8)
            .collect::<String>();
        resource.server_key = format!("{}-{}", resource.server_key, suffix);
        resource.resource_id = derive_resource_id(&resource.server_key);
        status = "imported";
    }
    if let Some(owner) = keys.get(&resource.server_key).cloned() {
        if owner != resource.resource_id {
            if matches!(policy, ConflictPolicy::Replace) {
                resource.resource_id = owner;
                status = "updated";
            } else {
                return Ok(item_result(
                    &candidate.candidate_id,
                    "mcp",
                    "skipped",
                    Some(resource.resource_id),
                    None,
                    Some("server_key_conflict"),
                ));
            }
        }
    }
    let saved = repository::upsert_mcp_resource(resource.clone()).await?;
    keys.insert(resource.server_key.clone(), resource.resource_id.clone());
    resources_by_id.insert(resource.resource_id.clone(), resource);
    Ok(item_result(
        &candidate.candidate_id,
        "mcp",
        status,
        Some(saved.resource_id),
        None,
        None,
    ))
}

fn selected_ids(values: &[String]) -> HashSet<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn validate_selected_ids(
    selected: &HashSet<String>,
    available: &HashSet<String>,
    kind: &str,
) -> Result<(), String> {
    if selected.iter().any(|value| !available.contains(value)) {
        return Err(format!("extensions_import_{kind}_selection_invalid"));
    }
    Ok(())
}

fn default_conflict_policy() -> String {
    "skip".to_string()
}

fn parse_conflict_policy(value: &str) -> Result<ConflictPolicy, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "skip" => Ok(ConflictPolicy::Skip),
        "replace" | "update" => Ok(ConflictPolicy::Replace),
        "saveas" | "save_as" => Ok(ConflictPolicy::SaveAs),
        _ => Err("extensions_import_conflict_policy_invalid".to_string()),
    }
}

fn item_result(
    candidate_id: &str,
    kind: &str,
    status: &str,
    resource_id: Option<String>,
    package_id: Option<String>,
    reason: Option<&str>,
) -> ExtensionImportItemResult {
    ExtensionImportItemResult {
        candidate_id: candidate_id.to_string(),
        kind: kind.to_string(),
        status: status.to_string(),
        resource_id,
        package_id,
        reason: reason.map(str::to_string),
    }
}

fn normalize_relative_path(value: &str) -> Result<String, String> {
    let value = value.trim().trim_matches('/');
    if value.is_empty() {
        return Ok(String::new());
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.contains('\\')
            || part.contains('\0')
            || part.chars().any(char::is_control)
        {
            return Err("extensions_import_path_invalid".to_string());
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // 内容摘要只返回哈希；不同原生正文会触发 apply 的源变更保护。
    fn source_fingerprint_is_content_based() {
        assert_ne!(bytes_fingerprint(b"one"), bytes_fingerprint(b"two"));
        assert!(bytes_fingerprint(b"one").starts_with("sha256:"));
    }

    #[test]
    // 冲突策略只接受明确的 skip/replace/saveAs，避免 UI 拼写导致隐式覆盖。
    fn conflict_policy_is_explicit() {
        assert!(matches!(
            parse_conflict_policy("skip"),
            Ok(ConflictPolicy::Skip)
        ));
        assert!(matches!(
            parse_conflict_policy("replace"),
            Ok(ConflictPolicy::Replace)
        ));
        assert!(matches!(
            parse_conflict_policy("saveAs"),
            Ok(ConflictPolicy::SaveAs)
        ));
        assert!(parse_conflict_policy("overwrite-all").is_err());
    }

    #[test]
    // 外部 Skill 目录只能使用仓库内相对路径，禁止 parent 组件和反斜杠绕过检查。
    fn relative_skill_paths_are_bounded() {
        assert_eq!(
            normalize_relative_path("skills/demo").unwrap(),
            "skills/demo"
        );
        assert!(normalize_relative_path("../demo").is_err());
        assert!(normalize_relative_path("skills\\demo").is_err());
    }
}
