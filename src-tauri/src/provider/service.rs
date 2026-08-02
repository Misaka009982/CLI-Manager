use super::config_engine;
use super::repository;
use super::{
    CliType, KeySecretAction, ProviderCommonConfig, ProviderConfigValidation,
    ProviderConfigValidationInput, ProviderCreateInput, ProviderDetail, ProviderEffectivePreview,
    ProviderKeyCreateInput, ProviderKeyUpdateInput, ProviderStatus, ProviderSummary,
};
use sha2::{Digest, Sha256};
use sqlx::{Executor, Row, SqliteConnection};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_PROVIDER_NAME_CHARS: usize = 120;
const MAX_KEY_LABEL_CHARS: usize = 120;
const MAX_CONFIG_BYTES: usize = 1024 * 1024;
const MAX_SECRET_BYTES: usize = 64 * 1024;

pub(crate) async fn list(cli_type: Option<CliType>) -> Result<Vec<ProviderSummary>, String> {
    let mut conn = repository::open_database().await?;
    repository::list_provider_summaries(&mut conn, cli_type).await
}

pub(crate) async fn get(provider_id: String) -> Result<ProviderDetail, String> {
    let provider_id = validate_id(&provider_id)?;
    let mut conn = repository::open_database().await?;
    repository::get_provider_detail(&mut conn, provider_id).await
}

pub(crate) async fn create(input: ProviderCreateInput) -> Result<ProviderDetail, String> {
    let mut conn = repository::open_database().await?;
    create_with_conn(&mut conn, input).await
}

pub(crate) async fn update(
    provider_id: String,
    input: super::ProviderUpdateInput,
) -> Result<ProviderDetail, String> {
    let provider_id = validate_id(&provider_id)?.to_string();
    let mut conn = repository::open_database().await?;
    update_with_conn(&mut conn, &provider_id, input).await
}

pub(crate) async fn duplicate(provider_id: String) -> Result<ProviderDetail, String> {
    let provider_id = validate_id(&provider_id)?.to_string();
    let mut conn = repository::open_database().await?;
    duplicate_with_conn(&mut conn, &provider_id).await
}

pub(crate) async fn delete(provider_id: String) -> Result<(), String> {
    let provider_id = validate_id(&provider_id)?.to_string();
    let mut conn = repository::open_database().await?;
    delete_with_conn(&mut conn, &provider_id).await
}

pub(crate) async fn set_status(
    provider_id: String,
    status: ProviderStatus,
) -> Result<ProviderDetail, String> {
    let provider_id = validate_id(&provider_id)?.to_string();
    let mut conn = repository::open_database().await?;
    set_status_with_conn(&mut conn, &provider_id, status).await
}

pub(crate) async fn key_create(
    provider_id: String,
    input: ProviderKeyCreateInput,
) -> Result<ProviderDetail, String> {
    let provider_id = validate_id(&provider_id)?.to_string();
    let mut conn = repository::open_database().await?;
    key_create_with_conn(&mut conn, &provider_id, input).await
}

pub(crate) async fn key_update(
    provider_id: String,
    key_id: String,
    input: ProviderKeyUpdateInput,
) -> Result<ProviderDetail, String> {
    let provider_id = validate_id(&provider_id)?.to_string();
    let key_id = validate_id(&key_id)?.to_string();
    let mut conn = repository::open_database().await?;
    key_update_with_conn(&mut conn, &provider_id, &key_id, input).await
}

pub(crate) async fn key_activate(
    provider_id: String,
    key_id: String,
) -> Result<ProviderDetail, String> {
    let provider_id = validate_id(&provider_id)?.to_string();
    let key_id = validate_id(&key_id)?.to_string();
    let mut conn = repository::open_database().await?;
    key_activate_with_conn(&mut conn, &provider_id, &key_id).await
}

pub(crate) async fn key_delete(
    provider_id: String,
    key_id: String,
    replacement_key_id: Option<String>,
) -> Result<ProviderDetail, String> {
    let provider_id = validate_id(&provider_id)?.to_string();
    let key_id = validate_id(&key_id)?.to_string();
    let replacement_key_id = replacement_key_id
        .as_deref()
        .map(validate_id)
        .transpose()?
        .map(str::to_string);
    let mut conn = repository::open_database().await?;
    key_delete_with_conn(
        &mut conn,
        &provider_id,
        &key_id,
        replacement_key_id.as_deref(),
    )
    .await
}

pub(crate) async fn common_get(cli_type: CliType) -> Result<ProviderCommonConfig, String> {
    let mut conn = repository::open_database().await?;
    common_get_with_conn(&mut conn, cli_type).await
}

pub(crate) async fn common_update(
    cli_type: CliType,
    config_text: String,
) -> Result<ProviderCommonConfig, String> {
    validate_config_size(&config_text)?;
    config_engine::validate_common_text(cli_type, &config_text)?;
    let mut conn = repository::open_database().await?;
    let now = now_ms();
    sqlx::query(
        "INSERT INTO managed_provider_common_configs
         (cli_type, config_format, config_text, revision, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT(cli_type) DO UPDATE SET
           config_format = excluded.config_format,
           config_text = excluded.config_text,
           revision = managed_provider_common_configs.revision + 1,
           updated_at = excluded.updated_at",
    )
    .bind(cli_type.as_str())
    .bind(cli_type.config_format())
    .bind(config_text)
    .bind(now)
    .execute(&mut conn)
    .await
    .map_err(map_query_error)?;
    common_get_with_conn(&mut conn, cli_type).await
}

pub(crate) fn validate_config(input: ProviderConfigValidationInput) -> ProviderConfigValidation {
    if validate_config_size(&input.common_text).is_err()
        || validate_config_size(&input.provider_text).is_err()
    {
        return ProviderConfigValidation {
            valid: false,
            error_code: Some("provider_config_invalid".to_string()),
            effective_text: None,
        };
    }
    config_engine::validation_result(&input)
}

pub(crate) async fn preview_effective(
    provider_id: String,
) -> Result<ProviderEffectivePreview, String> {
    let provider_id = validate_id(&provider_id)?.to_string();
    let mut conn = repository::open_database().await?;
    let detail = repository::get_provider_detail(&mut conn, &provider_id).await?;
    let common = common_get_with_conn(&mut conn, detail.summary.cli_type).await?;
    let input = ProviderConfigValidationInput {
        cli_type: detail.summary.cli_type,
        common_text: common.config_text,
        provider_text: detail.config_text,
        inherit_common: detail.summary.inherit_common,
    };
    let effective_text = config_engine::validate_and_render(&input)?;
    Ok(ProviderEffectivePreview {
        provider_id,
        cli_type: detail.summary.cli_type,
        config_format: detail.summary.config_format,
        effective_text,
    })
}

pub(crate) async fn create_with_conn(
    conn: &mut SqliteConnection,
    input: ProviderCreateInput,
) -> Result<ProviderDetail, String> {
    let name = validate_name(&input.name)?;
    validate_config_size(&input.config_text)?;
    config_engine::validate_provider_text(input.cli_type, &input.config_text)?;
    ensure_name_available(conn, input.cli_type, name, None).await?;
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO managed_providers
         (id, cli_type, name, name_normalized, status, config_format, config_text,
          inherit_common, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?7, ?8, ?9, ?9)",
    )
    .bind(&id)
    .bind(input.cli_type.as_str())
    .bind(name)
    .bind(normalize_name(name))
    .bind(input.cli_type.config_format())
    .bind(input.config_text)
    .bind(i64::from(input.inherit_common))
    .bind(input.sort_order)
    .bind(now)
    .execute(&mut *conn)
    .await
    .map_err(map_name_write_error)?;
    repository::get_provider_detail(conn, &id).await
}

pub(crate) async fn update_with_conn(
    conn: &mut SqliteConnection,
    provider_id: &str,
    input: super::ProviderUpdateInput,
) -> Result<ProviderDetail, String> {
    let current = repository::get_provider_detail(conn, provider_id).await?;
    let name = validate_name(&input.name)?;
    validate_config_size(&input.config_text)?;
    config_engine::validate_provider_text(current.summary.cli_type, &input.config_text)?;
    ensure_name_available(conn, current.summary.cli_type, name, Some(provider_id)).await?;
    sqlx::query(
        "UPDATE managed_providers SET
           name = ?1, name_normalized = ?2, config_text = ?3,
           inherit_common = ?4, sort_order = ?5, updated_at = ?6
         WHERE id = ?7",
    )
    .bind(name)
    .bind(normalize_name(name))
    .bind(input.config_text)
    .bind(i64::from(input.inherit_common))
    .bind(input.sort_order)
    .bind(now_ms())
    .bind(provider_id)
    .execute(&mut *conn)
    .await
    .map_err(map_name_write_error)?;
    repository::get_provider_detail(conn, provider_id).await
}

pub(crate) async fn duplicate_with_conn(
    conn: &mut SqliteConnection,
    provider_id: &str,
) -> Result<ProviderDetail, String> {
    let current = repository::get_provider_detail(conn, provider_id).await?;
    let name = next_copy_name(conn, current.summary.cli_type, &current.summary.name).await?;
    create_with_conn(
        conn,
        ProviderCreateInput {
            cli_type: current.summary.cli_type,
            name,
            config_text: current.config_text,
            inherit_common: current.summary.inherit_common,
            sort_order: current.summary.sort_order + 1,
        },
    )
    .await
}

pub(crate) async fn delete_with_conn(
    conn: &mut SqliteConnection,
    provider_id: &str,
) -> Result<(), String> {
    repository::get_provider_detail(conn, provider_id).await?;
    let references = reference_counts(conn, provider_id).await?;
    if references.total() > 0 {
        return Err(references.error());
    }
    sqlx::query("DELETE FROM managed_providers WHERE id = ?1")
        .bind(provider_id)
        .execute(&mut *conn)
        .await
        .map_err(map_query_error)?;
    Ok(())
}

pub(crate) async fn set_status_with_conn(
    conn: &mut SqliteConnection,
    provider_id: &str,
    status: ProviderStatus,
) -> Result<ProviderDetail, String> {
    let current = repository::get_provider_detail(conn, provider_id).await?;
    if current.summary.status == status {
        return Ok(current);
    }
    match status {
        ProviderStatus::Draft => return Err("provider_status_invalid".to_string()),
        ProviderStatus::Ready => {
            if current.summary.active_key_id.is_none() {
                return Err("provider_status_invalid".to_string());
            }
        }
        ProviderStatus::Disabled => {
            if current.summary.active_key_id.is_none() {
                return Err("provider_status_invalid".to_string());
            }
            let references = reference_counts(conn, provider_id).await?;
            if references.total() > 0 {
                return Err(references.error());
            }
        }
    }
    sqlx::query("UPDATE managed_providers SET status = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(status.as_str())
        .bind(now_ms())
        .bind(provider_id)
        .execute(&mut *conn)
        .await
        .map_err(map_query_error)?;
    repository::get_provider_detail(conn, provider_id).await
}

pub(crate) async fn key_create_with_conn(
    conn: &mut SqliteConnection,
    provider_id: &str,
    input: ProviderKeyCreateInput,
) -> Result<ProviderDetail, String> {
    let provider = repository::get_provider_detail(conn, provider_id).await?;
    let label = validate_key_label(&input.label)?;
    let secret = validate_secret(&input.secret)?;
    begin_immediate(conn).await?;
    let result = async {
        let key_id = Uuid::new_v4().to_string();
        let is_first = provider.summary.key_count == 0;
        let now = now_ms();
        sqlx::query(
            "INSERT INTO managed_provider_keys
             (id, provider_id, label, secret_text, secret_hint, secret_fingerprint,
              is_active, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        )
        .bind(key_id)
        .bind(provider_id)
        .bind(label)
        .bind(secret)
        .bind(mask_secret(secret))
        .bind(secret_fingerprint(secret))
        .bind(i64::from(is_first))
        .bind(input.sort_order)
        .bind(now)
        .execute(&mut *conn)
        .await
        .map_err(map_query_error)?;
        if is_first && provider.summary.status == ProviderStatus::Draft {
            sqlx::query(
                "UPDATE managed_providers SET status = 'ready', updated_at = ?1 WHERE id = ?2",
            )
            .bind(now)
            .bind(provider_id)
            .execute(&mut *conn)
            .await
            .map_err(map_query_error)?;
        } else {
            touch_provider(conn, provider_id, now).await?;
        }
        Ok(())
    }
    .await;
    finish_transaction(conn, result).await?;
    repository::get_provider_detail(conn, provider_id).await
}

pub(crate) async fn key_update_with_conn(
    conn: &mut SqliteConnection,
    provider_id: &str,
    key_id: &str,
    input: ProviderKeyUpdateInput,
) -> Result<ProviderDetail, String> {
    repository::get_provider_detail(conn, provider_id).await?;
    ensure_key_belongs(conn, provider_id, key_id).await?;
    let label = validate_key_label(&input.label)?;
    let now = now_ms();
    match input.secret_action {
        KeySecretAction::Keep => {
            if input.secret.is_some() {
                return Err("provider_key_secret_invalid".to_string());
            }
            sqlx::query(
                "UPDATE managed_provider_keys
                 SET label = ?1, sort_order = ?2, updated_at = ?3
                 WHERE id = ?4 AND provider_id = ?5",
            )
            .bind(label)
            .bind(input.sort_order)
            .bind(now)
            .bind(key_id)
            .bind(provider_id)
            .execute(&mut *conn)
            .await
            .map_err(map_query_error)?;
        }
        KeySecretAction::Replace => {
            let secret = input
                .secret
                .as_deref()
                .ok_or_else(|| "provider_key_secret_invalid".to_string())?;
            let secret = validate_secret(secret)?;
            sqlx::query(
                "UPDATE managed_provider_keys
                 SET label = ?1, secret_text = ?2, secret_hint = ?3,
                     secret_fingerprint = ?4, sort_order = ?5, updated_at = ?6
                 WHERE id = ?7 AND provider_id = ?8",
            )
            .bind(label)
            .bind(secret)
            .bind(mask_secret(secret))
            .bind(secret_fingerprint(secret))
            .bind(input.sort_order)
            .bind(now)
            .bind(key_id)
            .bind(provider_id)
            .execute(&mut *conn)
            .await
            .map_err(map_query_error)?;
        }
    }
    touch_provider(conn, provider_id, now).await?;
    repository::get_provider_detail(conn, provider_id).await
}

pub(crate) async fn key_activate_with_conn(
    conn: &mut SqliteConnection,
    provider_id: &str,
    key_id: &str,
) -> Result<ProviderDetail, String> {
    repository::get_provider_detail(conn, provider_id).await?;
    ensure_key_belongs(conn, provider_id, key_id).await?;
    begin_immediate(conn).await?;
    let result = async {
        let now = now_ms();
        sqlx::query("UPDATE managed_provider_keys SET is_active = 0, updated_at = ?1 WHERE provider_id = ?2")
            .bind(now)
            .bind(provider_id)
            .execute(&mut *conn)
            .await
            .map_err(map_query_error)?;
        sqlx::query(
            "UPDATE managed_provider_keys SET is_active = 1, updated_at = ?1
             WHERE id = ?2 AND provider_id = ?3",
        )
        .bind(now)
        .bind(key_id)
        .bind(provider_id)
        .execute(&mut *conn)
        .await
        .map_err(map_query_error)?;
        sqlx::query(
            "UPDATE managed_providers
             SET status = CASE WHEN status = 'draft' THEN 'ready' ELSE status END,
                 updated_at = ?1 WHERE id = ?2",
        )
        .bind(now)
        .bind(provider_id)
        .execute(&mut *conn)
        .await
        .map_err(map_query_error)?;
        Ok(())
    }
    .await;
    finish_transaction(conn, result).await?;
    repository::get_provider_detail(conn, provider_id).await
}

pub(crate) async fn key_delete_with_conn(
    conn: &mut SqliteConnection,
    provider_id: &str,
    key_id: &str,
    replacement_key_id: Option<&str>,
) -> Result<ProviderDetail, String> {
    repository::get_provider_detail(conn, provider_id).await?;
    let active = ensure_key_belongs(conn, provider_id, key_id).await?;
    let replacement = if active {
        let replacement = replacement_key_id
            .filter(|replacement| *replacement != key_id)
            .ok_or_else(|| "provider_key_replacement_required".to_string())?;
        ensure_key_belongs(conn, provider_id, replacement).await?;
        Some(replacement.to_string())
    } else {
        None
    };
    begin_immediate(conn).await?;
    let result = async {
        let now = now_ms();
        sqlx::query("DELETE FROM managed_provider_keys WHERE id = ?1 AND provider_id = ?2")
            .bind(key_id)
            .bind(provider_id)
            .execute(&mut *conn)
            .await
            .map_err(map_query_error)?;
        if let Some(replacement) = replacement.as_deref() {
            sqlx::query(
                "UPDATE managed_provider_keys SET is_active = 1, updated_at = ?1
                 WHERE id = ?2 AND provider_id = ?3",
            )
            .bind(now)
            .bind(replacement)
            .bind(provider_id)
            .execute(&mut *conn)
            .await
            .map_err(map_query_error)?;
        }
        touch_provider(conn, provider_id, now).await?;
        Ok(())
    }
    .await;
    finish_transaction(conn, result).await?;
    repository::get_provider_detail(conn, provider_id).await
}

async fn common_get_with_conn(
    conn: &mut SqliteConnection,
    cli_type: CliType,
) -> Result<ProviderCommonConfig, String> {
    let row = sqlx::query(
        "SELECT config_format, config_text, revision, updated_at
         FROM managed_provider_common_configs WHERE cli_type = ?1",
    )
    .bind(cli_type.as_str())
    .fetch_optional(&mut *conn)
    .await
    .map_err(map_query_error)?;
    match row {
        Some(row) => Ok(ProviderCommonConfig {
            cli_type,
            config_format: row
                .try_get("config_format")
                .map_err(|_| "provider_database_query_failed".to_string())?,
            config_text: row
                .try_get("config_text")
                .map_err(|_| "provider_database_query_failed".to_string())?,
            revision: row
                .try_get("revision")
                .map_err(|_| "provider_database_query_failed".to_string())?,
            updated_at: row
                .try_get("updated_at")
                .map_err(|_| "provider_database_query_failed".to_string())?,
        }),
        None => Ok(ProviderCommonConfig {
            cli_type,
            config_format: cli_type.config_format().to_string(),
            config_text: String::new(),
            revision: 0,
            updated_at: 0,
        }),
    }
}

async fn ensure_name_available(
    conn: &mut SqliteConnection,
    cli_type: CliType,
    name: &str,
    except_provider_id: Option<&str>,
) -> Result<(), String> {
    let conflict: Option<String> = sqlx::query_scalar(
        "SELECT id FROM managed_providers
         WHERE cli_type = ?1 AND name_normalized = ?2 AND (?3 IS NULL OR id != ?3)
         LIMIT 1",
    )
    .bind(cli_type.as_str())
    .bind(normalize_name(name))
    .bind(except_provider_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(map_query_error)?;
    if conflict.is_some() {
        Err("provider_name_conflict".to_string())
    } else {
        Ok(())
    }
}

async fn next_copy_name(
    conn: &mut SqliteConnection,
    cli_type: CliType,
    source_name: &str,
) -> Result<String, String> {
    for suffix in 1..=999 {
        let candidate = if suffix == 1 {
            format!("{source_name} Copy")
        } else {
            format!("{source_name} Copy {suffix}")
        };
        if candidate.chars().count() > MAX_PROVIDER_NAME_CHARS {
            continue;
        }
        if ensure_name_available(conn, cli_type, &candidate, None)
            .await
            .is_ok()
        {
            return Ok(candidate);
        }
    }
    Err("provider_name_conflict".to_string())
}

async fn ensure_key_belongs(
    conn: &mut SqliteConnection,
    provider_id: &str,
    key_id: &str,
) -> Result<bool, String> {
    sqlx::query_scalar::<_, i64>(
        "SELECT is_active FROM managed_provider_keys WHERE id = ?1 AND provider_id = ?2",
    )
    .bind(key_id)
    .bind(provider_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(map_query_error)?
    .map(|active| active != 0)
    .ok_or_else(|| "provider_key_not_found".to_string())
}

#[derive(Default)]
struct ReferenceCounts {
    global: i64,
    projects: usize,
    worktrees: usize,
}

impl ReferenceCounts {
    fn total(&self) -> usize {
        self.global.max(0) as usize + self.projects + self.worktrees
    }

    fn error(&self) -> String {
        format!(
            "provider_referenced:global={};projects={};worktrees={}",
            self.global, self.projects, self.worktrees
        )
    }
}

async fn reference_counts(
    conn: &mut SqliteConnection,
    provider_id: &str,
) -> Result<ReferenceCounts, String> {
    let global: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM managed_provider_global_state WHERE provider_id = ?1",
    )
    .bind(provider_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(map_query_error)?;
    let mut counts = ReferenceCounts {
        global,
        ..ReferenceCounts::default()
    };
    if table_exists(conn, "projects").await? {
        let rows = sqlx::query("SELECT provider_overrides FROM projects")
            .fetch_all(&mut *conn)
            .await
            .map_err(map_query_error)?;
        counts.projects = rows
            .iter()
            .filter_map(|row| row.try_get::<String, _>("provider_overrides").ok())
            .filter(|payload| native_override_references(payload, provider_id))
            .count();
    }
    if table_exists(conn, "worktrees").await? {
        let rows = sqlx::query("SELECT provider_overrides FROM worktrees")
            .fetch_all(&mut *conn)
            .await
            .map_err(map_query_error)?;
        counts.worktrees = rows
            .iter()
            .filter_map(|row| row.try_get::<String, _>("provider_overrides").ok())
            .filter(|payload| native_override_references(payload, provider_id))
            .count();
    }
    Ok(counts)
}

fn native_override_references(payload: &str, provider_id: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return false;
    };
    if value.get("schemaVersion").and_then(|value| value.as_i64()) != Some(2)
        || value.get("providerSource").and_then(|value| value.as_str()) != Some("native")
    {
        return false;
    }
    ["claude", "codex", "grok"].iter().any(|cli_type| {
        value
            .get(cli_type)
            .and_then(|value| value.get("providerId"))
            .and_then(|value| value.as_str())
            == Some(provider_id)
    })
}

async fn table_exists(conn: &mut SqliteConnection, table: &str) -> Result<bool, String> {
    sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
    )
    .bind(table)
    .fetch_optional(&mut *conn)
    .await
    .map(|value| value.is_some())
    .map_err(map_query_error)
}

async fn touch_provider(
    conn: &mut SqliteConnection,
    provider_id: &str,
    updated_at: i64,
) -> Result<(), String> {
    sqlx::query("UPDATE managed_providers SET updated_at = ?1 WHERE id = ?2")
        .bind(updated_at)
        .bind(provider_id)
        .execute(&mut *conn)
        .await
        .map_err(map_query_error)?;
    Ok(())
}

async fn begin_immediate(conn: &mut SqliteConnection) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE")
        .await
        .map_err(map_query_error)?;
    Ok(())
}

async fn finish_transaction(
    conn: &mut SqliteConnection,
    result: Result<(), String>,
) -> Result<(), String> {
    if result.is_ok() {
        conn.execute("COMMIT").await.map_err(map_query_error)?;
    } else {
        let _ = conn.execute("ROLLBACK").await;
    }
    result
}

fn validate_id(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 128 || trimmed != value {
        Err("provider_not_found".to_string())
    } else {
        Ok(trimmed)
    }
}

fn validate_name(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_PROVIDER_NAME_CHARS {
        Err("provider_name_invalid".to_string())
    } else {
        Ok(trimmed)
    }
}

fn normalize_name(value: &str) -> String {
    value.trim().to_lowercase()
}

fn validate_key_label(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_KEY_LABEL_CHARS {
        Err("provider_key_label_invalid".to_string())
    } else {
        Ok(trimmed)
    }
}

fn validate_secret(value: &str) -> Result<&str, String> {
    if value.is_empty() || value.as_bytes().len() > MAX_SECRET_BYTES {
        Err("provider_key_secret_invalid".to_string())
    } else {
        Ok(value)
    }
}

fn validate_config_size(value: &str) -> Result<(), String> {
    if value.as_bytes().len() > MAX_CONFIG_BYTES {
        Err("provider_config_invalid".to_string())
    } else {
        Ok(())
    }
}

fn mask_secret(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 12 {
        return "***".to_string();
    }
    let prefix: String = chars.iter().take(4).collect();
    let suffix: String = chars.iter().rev().take(4).rev().collect();
    format!("{prefix}...{suffix}")
}

fn secret_fingerprint(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn map_query_error(_error: sqlx::Error) -> String {
    "provider_database_query_failed".to_string()
}

fn map_name_write_error(error: sqlx::Error) -> String {
    if error
        .as_database_error()
        .is_some_and(|error| error.is_unique_violation())
    {
        "provider_name_conflict".to_string()
    } else {
        map_query_error(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::MIGRATION_CREATE_NATIVE_PROVIDERS_SQL;
    use sqlx::Connection;

    async fn database() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute("PRAGMA foreign_keys = ON").await.unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_NATIVE_PROVIDERS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        conn.execute(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, provider_overrides TEXT NOT NULL DEFAULT '{}')",
        )
        .await
        .unwrap();
        conn.execute(
            "CREATE TABLE worktrees (id TEXT PRIMARY KEY, provider_overrides TEXT NOT NULL DEFAULT '{}')",
        )
        .await
        .unwrap();
        conn
    }

    async fn provider(conn: &mut SqliteConnection, cli_type: CliType) -> ProviderDetail {
        create_with_conn(
            conn,
            ProviderCreateInput {
                cli_type,
                name: "Example".to_string(),
                config_text: String::new(),
                inherit_common: true,
                sort_order: 0,
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn first_key_promotes_provider_and_only_redacted_fields_serialize() {
        let mut conn = database().await;
        let created = provider(&mut conn, CliType::Claude).await;
        assert_eq!(created.summary.status, ProviderStatus::Draft);
        let detail = key_create_with_conn(
            &mut conn,
            &created.summary.id,
            ProviderKeyCreateInput {
                label: "Production".to_string(),
                secret: "sk-plain-text-provider-key".to_string(),
                sort_order: 0,
            },
        )
        .await
        .unwrap();
        assert_eq!(detail.summary.status, ProviderStatus::Ready);
        assert_eq!(detail.keys.len(), 1);
        assert!(detail.keys[0].is_active);
        let serialized = serde_json::to_string(&detail).unwrap();
        assert!(!serialized.contains("sk-plain-text-provider-key"));
        assert!(!serialized.contains("secretText"));

        let stored: String = sqlx::query_scalar(
            "SELECT secret_text FROM managed_provider_keys WHERE provider_id = ?1",
        )
        .bind(&created.summary.id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(stored, "sk-plain-text-provider-key");
    }

    #[tokio::test]
    async fn manual_activation_and_active_delete_are_atomic() {
        let mut conn = database().await;
        let created = provider(&mut conn, CliType::Codex).await;
        let detail = key_create_with_conn(
            &mut conn,
            &created.summary.id,
            ProviderKeyCreateInput {
                label: "A".to_string(),
                secret: "secret-a-long-value".to_string(),
                sort_order: 0,
            },
        )
        .await
        .unwrap();
        let first_id = detail.keys[0].id.clone();
        let detail = key_create_with_conn(
            &mut conn,
            &created.summary.id,
            ProviderKeyCreateInput {
                label: "B".to_string(),
                secret: "secret-b-long-value".to_string(),
                sort_order: 1,
            },
        )
        .await
        .unwrap();
        let second_id = detail
            .keys
            .iter()
            .find(|key| key.id != first_id)
            .unwrap()
            .id
            .clone();
        let activated = key_activate_with_conn(&mut conn, &created.summary.id, &second_id)
            .await
            .unwrap();
        assert_eq!(activated.keys.iter().filter(|key| key.is_active).count(), 1);
        assert!(
            activated
                .keys
                .iter()
                .find(|key| key.id == second_id)
                .unwrap()
                .is_active
        );

        assert_eq!(
            key_delete_with_conn(&mut conn, &created.summary.id, &second_id, None)
                .await
                .unwrap_err(),
            "provider_key_replacement_required"
        );
        let after =
            key_delete_with_conn(&mut conn, &created.summary.id, &second_id, Some(&first_id))
                .await
                .unwrap();
        assert_eq!(after.keys.len(), 1);
        assert_eq!(
            after.summary.active_key_id.as_deref(),
            Some(first_id.as_str())
        );
    }

    #[tokio::test]
    async fn native_v2_references_block_disable_and_delete() {
        let mut conn = database().await;
        let created = provider(&mut conn, CliType::Grok).await;
        let detail = key_create_with_conn(
            &mut conn,
            &created.summary.id,
            ProviderKeyCreateInput {
                label: "Primary".to_string(),
                secret: "grok-secret-long-value".to_string(),
                sort_order: 0,
            },
        )
        .await
        .unwrap();
        let payload = serde_json::json!({
            "schemaVersion": 2,
            "providerSource": "native",
            "grok": { "providerId": detail.summary.id }
        })
        .to_string();
        sqlx::query("INSERT INTO projects (id, provider_overrides) VALUES ('project', ?1)")
            .bind(payload)
            .execute(&mut conn)
            .await
            .unwrap();
        let error = set_status_with_conn(&mut conn, &created.summary.id, ProviderStatus::Disabled)
            .await
            .unwrap_err();
        assert!(error.starts_with("provider_referenced:"));
        assert!(delete_with_conn(&mut conn, &created.summary.id)
            .await
            .unwrap_err()
            .starts_with("provider_referenced:"));
    }

    #[tokio::test]
    async fn duplicate_copies_configuration_without_copying_plaintext_keys() {
        let mut conn = database().await;
        let created = provider(&mut conn, CliType::Claude).await;
        key_create_with_conn(
            &mut conn,
            &created.summary.id,
            ProviderKeyCreateInput {
                label: "Primary".to_string(),
                secret: "secret-to-not-copy".to_string(),
                sort_order: 0,
            },
        )
        .await
        .unwrap();
        let duplicated = duplicate_with_conn(&mut conn, &created.summary.id)
            .await
            .unwrap();
        assert_eq!(duplicated.summary.status, ProviderStatus::Draft);
        assert!(duplicated.keys.is_empty());
    }

    #[test]
    fn secret_hint_is_masked_without_plaintext() {
        let hint = mask_secret("sk-plain-text-provider-key");
        assert_eq!(hint, "sk-p...-key");
        assert!(!hint.contains("plain-text"));
        assert_eq!(mask_secret("short-key"), "***");
    }
}
