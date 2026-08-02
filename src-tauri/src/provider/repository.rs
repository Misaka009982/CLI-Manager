use super::database;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{Connection, Row, SqliteConnection};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SECRET_KEY_MARKERS: [&str; 6] = [
    "token",
    "key",
    "secret",
    "password",
    "credential",
    "authorization",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCard {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    pub sort_index: i64,
    pub created_at: i64,
    pub is_current: bool,
    pub enabled: bool,
    pub key_count: i64,
    pub active_key_label: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_format: Option<String>,
    pub settings_valid: bool,
    pub common_config_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderDetail {
    pub card: ProviderCard,
    pub settings_config: String,
    pub effective_settings_config: String,
    pub settings_has_secret: bool,
    pub keys: Vec<ProviderKeySummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderKeySummary {
    pub id: String,
    pub provider_id: String,
    pub app_type: String,
    pub label: String,
    pub masked_api_key: String,
    pub tags: Vec<String>,
    pub notes: String,
    pub enabled: bool,
    pub sort_index: i64,
    pub is_active: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommonConfigDocument {
    pub app_type: String,
    pub value: String,
    pub format: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCreateInput {
    pub app_type: String,
    pub name: String,
    pub settings_config: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_format: Option<String>,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    pub common_config_enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderUpdateInput {
    pub app_type: String,
    pub provider_id: String,
    pub name: Option<String>,
    pub settings_config: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_format: Option<String>,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    pub common_config_enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderKeyCreateInput {
    pub provider_id: String,
    pub app_type: String,
    pub label: String,
    pub api_key: String,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
    pub enabled: Option<bool>,
    pub activate: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderKeyUpdateInput {
    pub id: String,
    pub provider_id: String,
    pub app_type: String,
    pub label: Option<String>,
    pub api_key: Option<String>,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommonConfigSetInput {
    pub app_type: String,
    pub value: String,
    pub format: Option<String>,
}

#[derive(Debug, Clone)]
struct ProviderRecord {
    id: String,
    app_type: String,
    name: String,
    settings_config: String,
    website_url: Option<String>,
    category: Option<String>,
    created_at: i64,
    sort_index: i64,
    notes: Option<String>,
    icon: Option<String>,
    icon_color: Option<String>,
    meta: String,
    is_current: bool,
}

fn error(code: &str, detail: impl AsRef<str>) -> String {
    let detail = detail.as_ref().trim();
    if detail.is_empty() {
        code.to_string()
    } else {
        format!("{code}:{detail}")
    }
}

fn map_database_error(context: &str, err: sqlx::Error) -> String {
    let text = err.to_string().to_ascii_lowercase();
    if text.contains("idx_providers_one_current") {
        return error("provider_current_conflict", context);
    }
    if text.contains("idx_provider_api_keys_one_active") {
        return error("provider_key_active_conflict", context);
    }
    if text.contains("unique constraint") && text.contains("label") {
        return error("provider_key_label_conflict", context);
    }
    error("provider_database_error", context)
}

pub(crate) fn normalize_app_type(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "claude" => Ok("claude".to_string()),
        "codex" => Ok("codex".to_string()),
        "grok" | "grokbuild" | "grok-build" | "grok_build" => Ok("grokbuild".to_string()),
        _ => Err(error("provider_invalid_app_type", value)),
    }
}

fn required_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(error("provider_name_required", "name"));
    }
    if value.chars().count() > 120 {
        return Err(error("provider_name_too_long", "name"));
    }
    Ok(value.to_string())
}

fn optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

fn optional_text_value(value: String) -> Option<String> {
    optional_text(Some(value))
}

fn normalize_settings_config(value: Option<String>) -> Result<String, String> {
    let value = value.unwrap_or_else(|| "{}".to_string());
    let trimmed = value.trim();
    let parsed: Value = serde_json::from_str(trimmed)
        .map_err(|_| error("provider_settings_invalid_json", "settings_config"))?;
    if !parsed.is_object() {
        return Err(error("provider_settings_must_be_object", "settings_config"));
    }
    serde_json::to_string(&parsed).map_err(|_| error("provider_settings_serialize_failed", ""))
}

fn set_optional_json_string(object: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    let Some(value) = value.map(str::trim) else {
        return;
    };
    if value.is_empty() {
        object.remove(key);
    } else {
        object.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn apply_config_fields(
    app_type: &str,
    raw: &str,
    base_url: Option<&str>,
    model: Option<&str>,
    api_format: Option<&str>,
) -> Result<String, String> {
    if base_url.is_none() && model.is_none() && api_format.is_none() {
        return Ok(raw.to_string());
    }

    let mut value = serde_json::from_str::<Value>(raw)
        .map_err(|_| error("provider_settings_invalid_json", "settings_config"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| error("provider_settings_must_be_object", "settings_config"))?;

    match app_type {
        "claude" => {
            let env = object
                .entry("env")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| error("provider_settings_env_invalid", "env"))?;
            set_optional_json_string(env, "ANTHROPIC_BASE_URL", base_url);
            set_optional_json_string(env, "ANTHROPIC_MODEL", model);
            set_optional_json_string(object, "api_format", api_format);
        }
        "codex" | "grokbuild" => {
            set_optional_json_string(object, "base_url", base_url);
            set_optional_json_string(object, "model", model);
            set_optional_json_string(object, "api_format", api_format);
        }
        _ => return Err(error("provider_invalid_app_type", app_type)),
    }

    serde_json::to_string(&value).map_err(|_| error("provider_settings_serialize_failed", ""))
}

fn unix_timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn parse_meta(raw: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn meta_enabled(meta: &Map<String, Value>) -> bool {
    meta.get("enabled").and_then(Value::as_bool).unwrap_or(true)
}

fn meta_common_config_enabled(meta: &Map<String, Value>) -> bool {
    meta.get("commonConfigEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn serialize_meta(meta: Map<String, Value>) -> Result<String, String> {
    serde_json::to_string(&Value::Object(meta))
        .map_err(|_| error("provider_meta_serialize_failed", ""))
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    SECRET_KEY_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
}

fn mask_secret(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 12 {
        return "***".to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

fn redact_json(value: &mut Value) -> bool {
    match value {
        Value::Object(object) => {
            let mut found_secret = false;
            for (key, child) in object.iter_mut() {
                if is_secret_key(key) {
                    let replacement = match child {
                        Value::String(value) => Value::String(mask_secret(value)),
                        _ => Value::String("[REDACTED]".to_string()),
                    };
                    *child = replacement;
                    found_secret = true;
                } else if redact_json(child) {
                    found_secret = true;
                }
            }
            found_secret
        }
        Value::Array(items) => items.iter_mut().any(redact_json),
        _ => false,
    }
}

fn redact_settings_config(raw: &str) -> (String, bool, bool) {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        let has_secret = SECRET_KEY_MARKERS
            .iter()
            .any(|marker| raw.to_ascii_lowercase().contains(marker));
        return (
            if has_secret {
                "[REDACTED SETTINGS CONFIG]".to_string()
            } else {
                raw.to_string()
            },
            has_secret,
            false,
        );
    };
    let has_secret = redact_json(&mut value);
    let redacted = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string());
    (redacted, has_secret, true)
}

fn strip_json_secrets(value: &mut Value) -> bool {
    match value {
        Value::Object(object) => {
            let secret_keys = object
                .keys()
                .filter(|key| is_secret_key(key))
                .cloned()
                .collect::<Vec<_>>();
            let mut found_secret = !secret_keys.is_empty();
            for key in secret_keys {
                object.remove(&key);
            }
            for (key, child) in object.iter_mut() {
                if key.eq_ignore_ascii_case("config") {
                    if let Value::String(text) = child {
                        let lower = text.to_ascii_lowercase();
                        if SECRET_KEY_MARKERS
                            .iter()
                            .any(|marker| lower.contains(marker))
                        {
                            *child = Value::String(String::new());
                            found_secret = true;
                            continue;
                        }
                    }
                }
                if strip_json_secrets(child) {
                    found_secret = true;
                }
            }
            found_secret
        }
        Value::Array(items) => items.iter_mut().any(strip_json_secrets),
        _ => false,
    }
}

fn duplicate_settings_config(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return "{}".to_string();
    };
    strip_json_secrets(&mut value);
    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

fn first_json_string(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(found) = object
                    .get(*key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    return Some(found.to_string());
                }
            }
            object
                .values()
                .find_map(|child| first_json_string(child, keys))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| first_json_string(child, keys)),
        _ => None,
    }
}

fn first_toml_string(value: &toml::Value, keys: &[&str]) -> Option<String> {
    match value {
        toml::Value::Table(table) => {
            for key in keys {
                if let Some(found) = table
                    .get(*key)
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    return Some(found.to_string());
                }
            }
            table
                .values()
                .find_map(|child| first_toml_string(child, keys))
        }
        toml::Value::Array(items) => items
            .iter()
            .find_map(|child| first_toml_string(child, keys)),
        _ => None,
    }
}

fn config_summary(app_type: &str, raw: &str) -> (Option<String>, Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return (None, None, None);
    };
    let mut base_url = first_json_string(
        &value,
        &[
            "ANTHROPIC_BASE_URL",
            "OPENAI_BASE_URL",
            "base_url",
            "baseUrl",
            "api_base_url",
            "apiBaseUrl",
            "endpoint",
        ],
    );
    let mut model = first_json_string(
        &value,
        &[
            "ANTHROPIC_MODEL",
            "GROK_DEFAULT_MODEL",
            "default_model",
            "defaultModel",
            "model",
            "model_name",
            "modelName",
        ],
    );
    if let Some(config) = value.get("config").and_then(Value::as_str) {
        if let Ok(toml_value) = toml::from_str::<toml::Value>(config) {
            base_url = base_url
                .or_else(|| first_toml_string(&toml_value, &["base_url", "baseUrl", "endpoint"]));
            model = model.or_else(|| {
                first_toml_string(&toml_value, &["model", "default_model", "model_provider"])
            });
        }
    }
    let api_format = first_json_string(&value, &["api_format", "apiFormat", "format"]);
    let _ = app_type;
    (base_url, model, api_format)
}

fn provider_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<ProviderRecord, String> {
    Ok(ProviderRecord {
        id: row
            .try_get("id")
            .map_err(|_| error("provider_row_invalid", "id"))?,
        app_type: row
            .try_get("app_type")
            .map_err(|_| error("provider_row_invalid", "app_type"))?,
        name: row
            .try_get("name")
            .map_err(|_| error("provider_row_invalid", "name"))?,
        settings_config: row
            .try_get("settings_config")
            .map_err(|_| error("provider_row_invalid", "settings_config"))?,
        website_url: row.try_get("website_url").ok(),
        category: row.try_get("category").ok(),
        created_at: row
            .try_get("created_at")
            .map_err(|_| error("provider_row_invalid", "created_at"))?,
        sort_index: row
            .try_get("sort_index")
            .map_err(|_| error("provider_row_invalid", "sort_index"))?,
        notes: row.try_get("notes").ok(),
        icon: row.try_get("icon").ok(),
        icon_color: row.try_get("icon_color").ok(),
        meta: row
            .try_get("meta")
            .map_err(|_| error("provider_row_invalid", "meta"))?,
        is_current: row
            .try_get::<i64, _>("is_current")
            .map_err(|_| error("provider_row_invalid", "is_current"))?
            != 0,
    })
}

async fn load_provider(
    connection: &mut SqliteConnection,
    app_type: &str,
    provider_id: &str,
) -> Result<ProviderRecord, String> {
    let row = sqlx::query(
        "SELECT id, app_type, name, settings_config, website_url, category,
                created_at, sort_index, notes, icon, icon_color, meta, is_current
         FROM providers WHERE id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(app_type)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|err| map_database_error("provider_load_failed", err))?
    .ok_or_else(|| error("provider_not_found", provider_id))?;
    provider_from_row(&row)
}

async fn key_count(
    connection: &mut SqliteConnection,
    app_type: &str,
    provider_id: &str,
) -> Result<i64, String> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_api_keys WHERE provider_id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(app_type)
    .fetch_one(&mut *connection)
    .await
    .map_err(|err| map_database_error("provider_key_count_failed", err))
}

async fn active_key_label(
    connection: &mut SqliteConnection,
    app_type: &str,
    provider_id: &str,
) -> Result<Option<String>, String> {
    sqlx::query_scalar(
        "SELECT label FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2 AND is_active = 1 AND enabled = 1
         LIMIT 1",
    )
    .bind(provider_id)
    .bind(app_type)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|err| map_database_error("provider_active_key_failed", err))
}

fn card_from_record(
    record: &ProviderRecord,
    key_count: i64,
    active_key_label: Option<String>,
) -> ProviderCard {
    let meta = parse_meta(&record.meta);
    let (base_url, model, api_format) = config_summary(&record.app_type, &record.settings_config);
    let settings_valid = serde_json::from_str::<Value>(&record.settings_config)
        .map(|value| value.is_object())
        .unwrap_or(false);
    ProviderCard {
        id: record.id.clone(),
        app_type: record.app_type.clone(),
        name: record.name.clone(),
        website_url: record.website_url.clone(),
        category: record.category.clone(),
        notes: record.notes.clone(),
        icon: record.icon.clone(),
        icon_color: record.icon_color.clone(),
        sort_index: record.sort_index,
        created_at: record.created_at,
        is_current: record.is_current,
        enabled: meta_enabled(&meta),
        key_count,
        active_key_label,
        base_url,
        model,
        api_format,
        settings_valid,
        common_config_enabled: meta_common_config_enabled(&meta),
    }
}

async fn card_from_record_with_connection(
    connection: &mut SqliteConnection,
    record: &ProviderRecord,
) -> Result<ProviderCard, String> {
    let count = key_count(connection, &record.app_type, &record.id).await?;
    let active = active_key_label(connection, &record.app_type, &record.id).await?;
    Ok(card_from_record(record, count, active))
}

fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::trim).map(str::to_string))
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalize_tags(tags: Option<Vec<String>>) -> Result<String, String> {
    let tags = tags
        .unwrap_or_default()
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    serde_json::to_string(&tags).map_err(|_| error("provider_key_tags_invalid", "tags"))
}

fn key_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<ProviderKeySummary, String> {
    let api_key: String = row
        .try_get("api_key")
        .map_err(|_| error("provider_key_row_invalid", "api_key"))?;
    let enabled: i64 = row
        .try_get("enabled")
        .map_err(|_| error("provider_key_row_invalid", "enabled"))?;
    let is_active: i64 = row
        .try_get("is_active")
        .map_err(|_| error("provider_key_row_invalid", "is_active"))?;
    Ok(ProviderKeySummary {
        id: row
            .try_get("id")
            .map_err(|_| error("provider_key_row_invalid", "id"))?,
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| error("provider_key_row_invalid", "provider_id"))?,
        app_type: row
            .try_get("app_type")
            .map_err(|_| error("provider_key_row_invalid", "app_type"))?,
        label: row
            .try_get("label")
            .map_err(|_| error("provider_key_row_invalid", "label"))?,
        masked_api_key: mask_secret(&api_key),
        tags: parse_tags(
            &row.try_get::<String, _>("tags")
                .map_err(|_| error("provider_key_row_invalid", "tags"))?,
        ),
        notes: row
            .try_get("notes")
            .map_err(|_| error("provider_key_row_invalid", "notes"))?,
        enabled: enabled != 0,
        sort_index: row
            .try_get("sort_index")
            .map_err(|_| error("provider_key_row_invalid", "sort_index"))?,
        is_active: is_active != 0,
        created_at: row
            .try_get("created_at")
            .map_err(|_| error("provider_key_row_invalid", "created_at"))?,
        updated_at: row
            .try_get("updated_at")
            .map_err(|_| error("provider_key_row_invalid", "updated_at"))?,
    })
}

async fn list_keys_for_provider(
    connection: &mut SqliteConnection,
    app_type: &str,
    provider_id: &str,
) -> Result<Vec<ProviderKeySummary>, String> {
    let rows = sqlx::query(
        "SELECT id, provider_id, app_type, label, api_key, tags, notes, enabled,
                sort_index, is_active, created_at, updated_at
         FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2
         ORDER BY sort_index, created_at, label",
    )
    .bind(provider_id)
    .bind(app_type)
    .fetch_all(&mut *connection)
    .await
    .map_err(|err| map_database_error("provider_key_list_failed", err))?;
    rows.iter().map(key_from_row).collect()
}

pub(crate) async fn list_providers(app_type: Option<String>) -> Result<Vec<ProviderCard>, String> {
    let normalized_type = app_type.as_deref().map(normalize_app_type).transpose()?;
    let mut connection = database::open_connection().await?;
    let rows = sqlx::query(
        "SELECT id, app_type, name, settings_config, website_url, category,
                created_at, sort_index, notes, icon, icon_color, meta, is_current
         FROM providers
         WHERE (?1 IS NULL OR app_type = ?1)
         ORDER BY app_type, sort_index, name COLLATE NOCASE",
    )
    .bind(normalized_type.as_deref())
    .fetch_all(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_list_failed", err))?;

    let mut providers = Vec::with_capacity(rows.len());
    for row in &rows {
        let record = provider_from_row(row)?;
        providers.push(card_from_record_with_connection(&mut connection, &record).await?);
    }
    Ok(providers)
}

pub(crate) async fn get_provider(
    app_type: String,
    provider_id: String,
) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let record = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    let card = card_from_record_with_connection(&mut connection, &record).await?;
    let keys = list_keys_for_provider(&mut connection, &app_type, &record.id).await?;
    let (settings_config, settings_has_secret, _) = redact_settings_config(&record.settings_config);
    let common = get_common_config_value(&mut connection, &app_type).await?;
    let effective_settings_config = if card.common_config_enabled {
        merge_json_documents(&common, &record.settings_config)
            .unwrap_or_else(|_| settings_config.clone())
    } else {
        settings_config.clone()
    };
    let (effective_settings_config, _, _) = redact_settings_config(&effective_settings_config);
    Ok(ProviderDetail {
        card,
        settings_config,
        effective_settings_config,
        settings_has_secret,
        keys,
    })
}

pub(crate) async fn create_provider(input: ProviderCreateInput) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let name = required_name(&input.name)?;
    let normalized_settings = normalize_settings_config(input.settings_config)?;
    let settings_config = apply_config_fields(
        &app_type,
        &normalized_settings,
        input.base_url.as_deref(),
        input.model.as_deref(),
        input.api_format.as_deref(),
    )?;
    let common_config_enabled = input.common_config_enabled.unwrap_or(true);
    let mut meta = Map::new();
    meta.insert("enabled".to_string(), Value::Bool(true));
    meta.insert(
        "commonConfigEnabled".to_string(),
        Value::Bool(common_config_enabled),
    );
    let now = unix_timestamp_millis();
    let id = Uuid::new_v4().to_string();
    let mut connection = database::open_connection().await?;
    let sort_index: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM providers WHERE app_type = ?1",
    )
    .bind(&app_type)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_sort_index_failed", err))?;
    sqlx::query(
        "INSERT INTO providers
         (id, app_type, name, settings_config, website_url, category, created_at,
          sort_index, notes, icon, icon_color, meta, is_current)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0)",
    )
    .bind(&id)
    .bind(&app_type)
    .bind(name)
    .bind(settings_config)
    .bind(optional_text(input.website_url))
    .bind(optional_text(input.category))
    .bind(now)
    .bind(sort_index)
    .bind(optional_text(input.notes))
    .bind(optional_text(input.icon))
    .bind(optional_text(input.icon_color))
    .bind(serialize_meta(meta)?)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_create_failed", err))?;
    get_provider(app_type, id).await
}

pub(crate) async fn update_provider(input: ProviderUpdateInput) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let provider_id = input.provider_id.trim();
    if provider_id.is_empty() {
        return Err(error("provider_id_required", "providerId"));
    }
    let mut connection = database::open_connection().await?;
    let existing = load_provider(&mut connection, &app_type, provider_id).await?;
    let name = input
        .name
        .as_deref()
        .map(required_name)
        .transpose()?
        .unwrap_or(existing.name.clone());
    let normalized_settings = match input.settings_config {
        Some(value) => normalize_settings_config(Some(value))?,
        None => existing.settings_config.clone(),
    };
    let settings_config = apply_config_fields(
        &app_type,
        &normalized_settings,
        input.base_url.as_deref(),
        input.model.as_deref(),
        input.api_format.as_deref(),
    )?;
    let mut meta = parse_meta(&existing.meta);
    if let Some(enabled) = input.common_config_enabled {
        meta.insert("commonConfigEnabled".to_string(), Value::Bool(enabled));
    }
    sqlx::query(
        "UPDATE providers SET name = ?1, settings_config = ?2, website_url = ?3,
         category = ?4, notes = ?5, icon = ?6, icon_color = ?7, meta = ?8
         WHERE id = ?9 AND app_type = ?10",
    )
    .bind(name)
    .bind(settings_config)
    .bind(
        input
            .website_url
            .map(optional_text_value)
            .unwrap_or(existing.website_url),
    )
    .bind(
        input
            .category
            .map(optional_text_value)
            .unwrap_or(existing.category),
    )
    .bind(
        input
            .notes
            .map(optional_text_value)
            .unwrap_or(existing.notes),
    )
    .bind(input.icon.map(optional_text_value).unwrap_or(existing.icon))
    .bind(
        input
            .icon_color
            .map(optional_text_value)
            .unwrap_or(existing.icon_color),
    )
    .bind(serialize_meta(meta)?)
    .bind(provider_id)
    .bind(&app_type)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_update_failed", err))?;
    get_provider(app_type, provider_id.to_string()).await
}

pub(crate) async fn duplicate_provider(
    app_type: String,
    provider_id: String,
    name: Option<String>,
) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let existing = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    let new_name = name
        .as_deref()
        .map(required_name)
        .transpose()?
        .unwrap_or_else(|| format!("{} Copy", existing.name));
    let new_id = Uuid::new_v4().to_string();
    let sort_index: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM providers WHERE app_type = ?1",
    )
    .bind(&app_type)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_sort_index_failed", err))?;
    let mut meta = parse_meta(&existing.meta);
    meta.insert("enabled".to_string(), Value::Bool(true));
    meta.insert(
        "commonConfigEnabled".to_string(),
        Value::Bool(meta_common_config_enabled(&meta)),
    );
    sqlx::query(
        "INSERT INTO providers
         (id, app_type, name, settings_config, website_url, category, created_at,
          sort_index, notes, icon, icon_color, meta, is_current)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0)",
    )
    .bind(&new_id)
    .bind(&app_type)
    .bind(new_name)
    .bind(duplicate_settings_config(&existing.settings_config))
    .bind(existing.website_url)
    .bind(existing.category)
    .bind(unix_timestamp_millis())
    .bind(sort_index)
    .bind(existing.notes)
    .bind(existing.icon)
    .bind(existing.icon_color)
    .bind(serialize_meta(meta)?)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_duplicate_failed", err))?;
    get_provider(app_type, new_id).await
}

async fn provider_reference_count(
    connection: &mut SqliteConnection,
    app_type: &str,
    provider_id: &str,
) -> Result<i64, String> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_import_refs
         WHERE provider_id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(app_type)
    .fetch_one(&mut *connection)
    .await
    .map_err(|err| map_database_error("provider_reference_check_failed", err))
}

pub(crate) async fn delete_provider(app_type: String, provider_id: String) -> Result<(), String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let provider = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    if provider.is_current {
        return Err(error("provider_current_cannot_delete", "providerId"));
    }
    if provider_reference_count(&mut connection, &app_type, &provider.id).await? > 0 {
        return Err(error("provider_referenced_cannot_delete", "providerId"));
    }
    sqlx::query("DELETE FROM providers WHERE id = ?1 AND app_type = ?2")
        .bind(&provider.id)
        .bind(&app_type)
        .execute(&mut connection)
        .await
        .map_err(|err| map_database_error("provider_delete_failed", err))?;
    Ok(())
}

pub(crate) async fn set_provider_enabled(
    app_type: String,
    provider_id: String,
    enabled: bool,
) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let provider = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    if !enabled && provider.is_current {
        return Err(error("provider_current_cannot_disable", "providerId"));
    }
    if !enabled && provider_reference_count(&mut connection, &app_type, &provider.id).await? > 0 {
        return Err(error("provider_referenced_cannot_disable", "providerId"));
    }
    let mut meta = parse_meta(&provider.meta);
    meta.insert("enabled".to_string(), Value::Bool(enabled));
    sqlx::query("UPDATE providers SET meta = ?1 WHERE id = ?2 AND app_type = ?3")
        .bind(serialize_meta(meta)?)
        .bind(&provider.id)
        .bind(&app_type)
        .execute(&mut connection)
        .await
        .map_err(|err| map_database_error("provider_enabled_update_failed", err))?;
    get_provider(app_type, provider.id).await
}

pub(crate) async fn set_current_provider(
    app_type: String,
    provider_id: String,
) -> Result<ProviderDetail, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let provider = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    let meta = parse_meta(&provider.meta);
    if !meta_enabled(&meta) {
        return Err(error("provider_disabled_cannot_current", "providerId"));
    }
    if active_key_label(&mut connection, &app_type, &provider.id)
        .await?
        .is_none()
    {
        return Err(error("provider_current_requires_active_key", "providerId"));
    }
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_current_begin_failed", err))?;
    sqlx::query("UPDATE providers SET is_current = 0 WHERE app_type = ?1")
        .bind(&app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|err| map_database_error("provider_current_clear_failed", err))?;
    sqlx::query("UPDATE providers SET is_current = 1 WHERE id = ?1 AND app_type = ?2")
        .bind(&provider.id)
        .bind(&app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|err| map_database_error("provider_current_set_failed", err))?;
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_current_commit_failed", err))?;
    get_provider(app_type, provider.id).await
}

pub(crate) async fn reorder_providers(
    app_type: String,
    provider_ids: Vec<String>,
) -> Result<Vec<ProviderCard>, String> {
    let app_type = normalize_app_type(&app_type)?;
    if provider_ids.is_empty() {
        return Err(error("provider_reorder_empty", "providerIds"));
    }
    let mut connection = database::open_connection().await?;
    let expected: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM providers WHERE app_type = ?1")
        .bind(&app_type)
        .fetch_one(&mut connection)
        .await
        .map_err(|err| map_database_error("provider_reorder_count_failed", err))?;
    let unique_count = provider_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::HashSet<_>>()
        .len() as i64;
    if unique_count != expected || unique_count != provider_ids.len() as i64 {
        return Err(error("provider_reorder_mismatch", "providerIds"));
    }
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_reorder_begin_failed", err))?;
    for (sort_index, provider_id) in provider_ids.iter().enumerate() {
        let affected =
            sqlx::query("UPDATE providers SET sort_index = ?1 WHERE id = ?2 AND app_type = ?3")
                .bind(sort_index as i64)
                .bind(provider_id.trim())
                .bind(&app_type)
                .execute(&mut *transaction)
                .await
                .map_err(|err| map_database_error("provider_reorder_update_failed", err))?
                .rows_affected();
        if affected != 1 {
            return Err(error("provider_not_found", provider_id));
        }
    }
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_reorder_commit_failed", err))?;
    drop(connection);
    list_providers(Some(app_type)).await
}

fn set_json_secret(value: &mut Value, app_type: &str, secret: &str) -> Result<(), String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| error("provider_settings_must_be_object", "settings_config"))?;
    match app_type {
        "claude" => {
            let env = object
                .entry("env")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| error("provider_settings_env_invalid", "env"))?;
            let key = if env.contains_key("ANTHROPIC_API_KEY") {
                "ANTHROPIC_API_KEY"
            } else {
                "ANTHROPIC_AUTH_TOKEN"
            };
            env.insert(key.to_string(), Value::String(secret.to_string()));
        }
        "codex" => {
            let auth = object
                .entry("auth")
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(auth_object) = auth.as_object_mut() {
                let key = if auth_object.contains_key("api_key") {
                    "api_key"
                } else if auth_object.contains_key("OPENAI_API_KEY") {
                    "OPENAI_API_KEY"
                } else {
                    "OPENAI_API_KEY"
                };
                auth_object.insert(key.to_string(), Value::String(secret.to_string()));
            } else {
                *auth = Value::String(secret.to_string());
            }
        }
        "grokbuild" => {
            let key = if object.contains_key("apiKey") {
                "apiKey"
            } else {
                "api_key"
            };
            object.insert(key.to_string(), Value::String(secret.to_string()));
        }
        _ => return Err(error("provider_invalid_app_type", app_type)),
    }
    Ok(())
}

fn project_key_into_settings(app_type: &str, raw: &str, secret: &str) -> Result<String, String> {
    let mut value = serde_json::from_str::<Value>(raw)
        .map_err(|_| error("provider_settings_invalid_json", "settings_config"))?;
    set_json_secret(&mut value, app_type, secret)?;
    serde_json::to_string(&value).map_err(|_| error("provider_settings_serialize_failed", ""))
}

async fn activate_key_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    provider_id: &str,
    app_type: &str,
    key_id: &str,
) -> Result<(), String> {
    let key = sqlx::query(
        "SELECT api_key, enabled FROM provider_api_keys
         WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(key_id)
    .bind(provider_id)
    .bind(app_type)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?
    .ok_or_else(|| error("provider_key_not_found", key_id))?;
    let enabled: i64 = key
        .try_get("enabled")
        .map_err(|_| error("provider_key_row_invalid", "enabled"))?;
    if enabled == 0 {
        return Err(error("provider_key_disabled_cannot_activate", key_id));
    }
    let api_key: String = key
        .try_get("api_key")
        .map_err(|_| error("provider_key_row_invalid", "api_key"))?;
    sqlx::query(
        "UPDATE provider_api_keys SET is_active = 0
         WHERE provider_id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(app_type)
    .execute(&mut **transaction)
    .await
    .map_err(|err| map_database_error("provider_key_clear_active_failed", err))?;
    sqlx::query(
        "UPDATE provider_api_keys SET is_active = 1, updated_at = ?1
         WHERE id = ?2 AND provider_id = ?3 AND app_type = ?4",
    )
    .bind(unix_timestamp_millis())
    .bind(key_id)
    .bind(provider_id)
    .bind(app_type)
    .execute(&mut **transaction)
    .await
    .map_err(|err| map_database_error("provider_key_set_active_failed", err))?;
    let provider =
        sqlx::query("SELECT settings_config FROM providers WHERE id = ?1 AND app_type = ?2")
            .bind(provider_id)
            .bind(app_type)
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|err| map_database_error("provider_load_failed", err))?
            .ok_or_else(|| error("provider_not_found", provider_id))?;
    let settings_config: String = provider
        .try_get("settings_config")
        .map_err(|_| error("provider_row_invalid", "settings_config"))?;
    let projected = project_key_into_settings(app_type, &settings_config, &api_key)?;
    sqlx::query("UPDATE providers SET settings_config = ?1 WHERE id = ?2 AND app_type = ?3")
        .bind(projected)
        .bind(provider_id)
        .bind(app_type)
        .execute(&mut **transaction)
        .await
        .map_err(|err| map_database_error("provider_key_projection_failed", err))?;
    Ok(())
}

pub(crate) async fn list_keys(
    app_type: String,
    provider_id: String,
) -> Result<Vec<ProviderKeySummary>, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let _ = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    list_keys_for_provider(&mut connection, &app_type, provider_id.trim()).await
}

pub(crate) async fn create_key(
    input: ProviderKeyCreateInput,
) -> Result<ProviderKeySummary, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let provider_id = input.provider_id.trim();
    let label = required_name(&input.label)?;
    let api_key = input.api_key.trim();
    if api_key.is_empty() {
        return Err(error("provider_key_required", "apiKey"));
    }
    let tags = normalize_tags(input.tags)?;
    let enabled = input.enabled.unwrap_or(true);
    if input.activate.unwrap_or(false) && !enabled {
        return Err(error("provider_key_disabled_cannot_activate", "apiKey"));
    }
    let now = unix_timestamp_millis();
    let key_id = Uuid::new_v4().to_string();
    let mut connection = database::open_connection().await?;
    let _ = load_provider(&mut connection, &app_type, provider_id).await?;
    let sort_index: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM provider_api_keys
         WHERE provider_id = ?1 AND app_type = ?2",
    )
    .bind(provider_id)
    .bind(&app_type)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_sort_index_failed", err))?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_key_create_begin_failed", err))?;
    sqlx::query(
        "INSERT INTO provider_api_keys
         (id, provider_id, app_type, label, api_key, tags, notes, enabled,
          sort_index, is_active, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
    )
    .bind(&key_id)
    .bind(provider_id)
    .bind(&app_type)
    .bind(label)
    .bind(api_key)
    .bind(tags)
    .bind(optional_text(input.notes).unwrap_or_default())
    .bind(if enabled { 1 } else { 0 })
    .bind(sort_index)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(|err| map_database_error("provider_key_create_failed", err))?;
    if input.activate.unwrap_or(false) {
        activate_key_in_transaction(&mut transaction, provider_id, &app_type, &key_id).await?;
    }
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_key_create_commit_failed", err))?;
    drop(connection);
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, provider_id, app_type, label, api_key, tags, notes, enabled,
                sort_index, is_active, created_at, updated_at
         FROM provider_api_keys WHERE id = ?1",
    )
    .bind(key_id)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?;
    key_from_row(&row)
}

pub(crate) async fn update_key(
    input: ProviderKeyUpdateInput,
) -> Result<ProviderKeySummary, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let provider_id = input.provider_id.trim();
    let mut connection = database::open_connection().await?;
    let _ = load_provider(&mut connection, &app_type, provider_id).await?;
    let existing = sqlx::query(
        "SELECT label, api_key, tags, notes, enabled, is_active
         FROM provider_api_keys WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(input.id.trim())
    .bind(provider_id)
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?
    .ok_or_else(|| error("provider_key_not_found", input.id.trim()))?;
    let old_enabled: i64 = existing.try_get("enabled").unwrap_or(1);
    let active: i64 = existing.try_get("is_active").unwrap_or(0);
    let enabled = input.enabled.unwrap_or(old_enabled != 0);
    if active != 0 && !enabled {
        return Err(error("provider_key_active_cannot_disable", input.id.trim()));
    }
    let label = input
        .label
        .as_deref()
        .map(required_name)
        .transpose()?
        .unwrap_or_else(|| existing.try_get("label").unwrap_or_default());
    let api_key = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| existing.try_get("api_key").unwrap_or_default());
    if api_key.is_empty() {
        return Err(error("provider_key_required", "apiKey"));
    }
    let tags = match input.tags {
        Some(tags) => normalize_tags(Some(tags))?,
        None => existing
            .try_get("tags")
            .unwrap_or_else(|_| "[]".to_string()),
    };
    let notes = input
        .notes
        .map(|value| optional_text(Some(value)).unwrap_or_default())
        .unwrap_or_else(|| existing.try_get("notes").unwrap_or_default());
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_key_update_begin_failed", err))?;
    sqlx::query(
        "UPDATE provider_api_keys SET label = ?1, api_key = ?2, tags = ?3,
         notes = ?4, enabled = ?5, updated_at = ?6
         WHERE id = ?7 AND provider_id = ?8 AND app_type = ?9",
    )
    .bind(label)
    .bind(api_key)
    .bind(tags)
    .bind(notes)
    .bind(if enabled { 1 } else { 0 })
    .bind(unix_timestamp_millis())
    .bind(input.id.trim())
    .bind(provider_id)
    .bind(&app_type)
    .execute(&mut *transaction)
    .await
    .map_err(|err| map_database_error("provider_key_update_failed", err))?;
    if active != 0 {
        activate_key_in_transaction(&mut transaction, provider_id, &app_type, input.id.trim())
            .await?;
    }
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_key_update_commit_failed", err))?;
    drop(connection);
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, provider_id, app_type, label, api_key, tags, notes, enabled,
                sort_index, is_active, created_at, updated_at
         FROM provider_api_keys WHERE id = ?1",
    )
    .bind(input.id.trim())
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?;
    key_from_row(&row)
}

pub(crate) async fn delete_key(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<(), String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT is_active FROM provider_api_keys
         WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(key_id.trim())
    .bind(provider_id.trim())
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?
    .ok_or_else(|| error("provider_key_not_found", key_id.trim()))?;
    if row.try_get::<i64, _>("is_active").unwrap_or(0) != 0 {
        return Err(error("provider_key_active_cannot_delete", key_id.trim()));
    }
    sqlx::query(
        "DELETE FROM provider_api_keys WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(key_id.trim())
    .bind(provider_id.trim())
    .bind(&app_type)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_delete_failed", err))?;
    Ok(())
}

pub(crate) async fn set_key_enabled(
    app_type: String,
    provider_id: String,
    key_id: String,
    enabled: bool,
) -> Result<ProviderKeySummary, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT is_active FROM provider_api_keys
         WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(key_id.trim())
    .bind(provider_id.trim())
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?
    .ok_or_else(|| error("provider_key_not_found", key_id.trim()))?;
    if !enabled && row.try_get::<i64, _>("is_active").unwrap_or(0) != 0 {
        return Err(error("provider_key_active_cannot_disable", key_id.trim()));
    }
    sqlx::query(
        "UPDATE provider_api_keys SET enabled = ?1, updated_at = ?2
         WHERE id = ?3 AND provider_id = ?4 AND app_type = ?5",
    )
    .bind(if enabled { 1 } else { 0 })
    .bind(unix_timestamp_millis())
    .bind(key_id.trim())
    .bind(provider_id.trim())
    .bind(&app_type)
    .execute(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_enabled_update_failed", err))?;
    drop(connection);
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, provider_id, app_type, label, api_key, tags, notes, enabled,
                sort_index, is_active, created_at, updated_at
         FROM provider_api_keys WHERE id = ?1",
    )
    .bind(key_id.trim())
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?;
    key_from_row(&row)
}

pub(crate) async fn activate_key(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<ProviderKeySummary, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let _ = load_provider(&mut connection, &app_type, provider_id.trim()).await?;
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_key_activate_begin_failed", err))?;
    activate_key_in_transaction(
        &mut transaction,
        provider_id.trim(),
        &app_type,
        key_id.trim(),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_key_activate_commit_failed", err))?;
    drop(connection);
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT id, provider_id, app_type, label, api_key, tags, notes, enabled,
                sort_index, is_active, created_at, updated_at
         FROM provider_api_keys WHERE id = ?1",
    )
    .bind(key_id.trim())
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_load_failed", err))?;
    key_from_row(&row)
}

pub(crate) async fn reorder_keys(
    app_type: String,
    provider_id: String,
    key_ids: Vec<String>,
) -> Result<Vec<ProviderKeySummary>, String> {
    let app_type = normalize_app_type(&app_type)?;
    if key_ids.is_empty() {
        return Err(error("provider_key_reorder_empty", "keyIds"));
    }
    let mut connection = database::open_connection().await?;
    let expected: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_api_keys WHERE provider_id = ?1 AND app_type = ?2",
    )
    .bind(provider_id.trim())
    .bind(&app_type)
    .fetch_one(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_reorder_count_failed", err))?;
    let unique_count = key_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::HashSet<_>>()
        .len() as i64;
    if unique_count != expected || unique_count != key_ids.len() as i64 {
        return Err(error("provider_key_reorder_mismatch", "keyIds"));
    }
    let mut transaction = connection
        .begin()
        .await
        .map_err(|err| map_database_error("provider_key_reorder_begin_failed", err))?;
    for (sort_index, key_id) in key_ids.iter().enumerate() {
        let affected = sqlx::query(
            "UPDATE provider_api_keys SET sort_index = ?1, updated_at = ?2
             WHERE id = ?3 AND provider_id = ?4 AND app_type = ?5",
        )
        .bind(sort_index as i64)
        .bind(unix_timestamp_millis())
        .bind(key_id.trim())
        .bind(provider_id.trim())
        .bind(&app_type)
        .execute(&mut *transaction)
        .await
        .map_err(|err| map_database_error("provider_key_reorder_update_failed", err))?
        .rows_affected();
        if affected != 1 {
            return Err(error("provider_key_not_found", key_id));
        }
    }
    transaction
        .commit()
        .await
        .map_err(|err| map_database_error("provider_key_reorder_commit_failed", err))?;
    drop(connection);
    list_keys(app_type, provider_id).await
}

pub(crate) async fn reveal_key(
    app_type: String,
    provider_id: String,
    key_id: String,
) -> Result<String, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    sqlx::query_scalar(
        "SELECT api_key FROM provider_api_keys
         WHERE id = ?1 AND provider_id = ?2 AND app_type = ?3",
    )
    .bind(key_id.trim())
    .bind(provider_id.trim())
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|err| map_database_error("provider_key_reveal_failed", err))?
    .ok_or_else(|| error("provider_key_not_found", key_id.trim()))
}

async fn get_common_config_value(
    connection: &mut SqliteConnection,
    app_type: &str,
) -> Result<String, String> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(format!("common_config_{app_type}"))
        .fetch_optional(&mut *connection)
        .await
        .map_err(|err| map_database_error("provider_common_config_read_failed", err))?
        .ok_or_else(|| error("provider_common_config_not_found", app_type))
}

fn merge_json_values(common: &mut Value, provider: Value) {
    if let (Some(common_object), Some(provider_object)) =
        (common.as_object_mut(), provider.as_object())
    {
        for (key, value) in provider_object {
            if let Some(existing) = common_object.get_mut(key) {
                merge_json_values(existing, value.clone());
            } else {
                common_object.insert(key.clone(), value.clone());
            }
        }
    } else {
        *common = provider;
    }
}

fn merge_json_documents(common: &str, provider: &str) -> Result<String, String> {
    let mut common = serde_json::from_str::<Value>(common)
        .map_err(|_| error("provider_common_config_invalid_json", "common"))?;
    let provider = serde_json::from_str::<Value>(provider)
        .map_err(|_| error("provider_settings_invalid_json", "provider"))?;
    merge_json_values(&mut common, provider);
    serde_json::to_string_pretty(&common).map_err(|_| error("provider_config_merge_failed", ""))
}

pub(crate) async fn get_common_config(app_type: String) -> Result<CommonConfigDocument, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let value = get_common_config_value(&mut connection, &app_type).await?;
    let (value, _, valid_json) = redact_settings_config(&value);
    Ok(CommonConfigDocument {
        app_type,
        value,
        format: if valid_json { "json" } else { "text" }.to_string(),
    })
}

pub(crate) async fn set_common_config(
    input: CommonConfigSetInput,
) -> Result<CommonConfigDocument, String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let value = input.value.trim().to_string();
    if value.is_empty() {
        return Err(error("provider_common_config_required", "value"));
    }
    let format = input.format.unwrap_or_else(|| "json".to_string());
    if format.eq_ignore_ascii_case("json") {
        let parsed = serde_json::from_str::<Value>(&value)
            .map_err(|_| error("provider_common_config_invalid_json", "value"))?;
        if !parsed.is_object() {
            return Err(error("provider_common_config_must_be_object", "value"));
        }
    }
    let mut connection = database::open_connection().await?;
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)")
        .bind(format!("common_config_{app_type}"))
        .bind(&value)
        .execute(&mut connection)
        .await
        .map_err(|err| map_database_error("provider_common_config_write_failed", err))?;
    let (value, _, _) = redact_settings_config(&value);
    Ok(CommonConfigDocument {
        app_type,
        value,
        format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn normalizes_public_grok_aliases() {
        assert_eq!(normalize_app_type("grok").unwrap(), "grokbuild");
        assert_eq!(normalize_app_type("grok-build").unwrap(), "grokbuild");
        assert!(normalize_app_type("gemini").is_err());
    }

    #[test]
    fn redacts_nested_secret_values_without_changing_non_secrets() {
        let raw = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"secret-token","ANTHROPIC_BASE_URL":"https://example.test"}}"#;
        let (redacted, has_secret, valid) = redact_settings_config(raw);
        assert!(has_secret);
        assert!(valid);
        assert!(!redacted.contains("secret-token"));
        assert!(redacted.contains("https://example.test"));
    }

    #[test]
    fn duplicate_config_drops_projected_credentials() {
        let duplicate = duplicate_settings_config(
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"secret-token","ANTHROPIC_BASE_URL":"https://example.test"},"model":"x"}"#,
        );
        assert!(!duplicate.contains("secret-token"));
        assert!(duplicate.contains("https://example.test"));
        assert!(duplicate.contains("\"model\":\"x\""));
    }

    #[test]
    fn projects_active_key_into_app_specific_json_fields() {
        let claude = project_key_into_settings("claude", r#"{"env":{}}"#, "sk-claude").unwrap();
        assert!(claude.contains("ANTHROPIC_AUTH_TOKEN"));
        let codex = project_key_into_settings("codex", r#"{}"#, "sk-codex").unwrap();
        assert!(codex.contains("OPENAI_API_KEY"));
        let grok = project_key_into_settings("grokbuild", r#"{}"#, "sk-grok").unwrap();
        assert!(grok.contains("api_key"));
    }

    #[test]
    fn applies_visible_config_fields_without_overwriting_credentials() {
        let updated = apply_config_fields(
            "claude",
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"secret","OTHER":"keep"}}"#,
            Some("https://api.example.test"),
            Some("claude-test"),
            Some("anthropic"),
        )
        .unwrap();
        let value: Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
        assert_eq!(value["env"]["OTHER"], "keep");
        assert_eq!(
            value["env"]["ANTHROPIC_BASE_URL"],
            "https://api.example.test"
        );
        assert_eq!(value["env"]["ANTHROPIC_MODEL"], "claude-test");
        assert_eq!(value["api_format"], "anthropic");
    }

    #[test]
    fn common_config_merge_keeps_provider_override() {
        let merged = merge_json_documents(
            r#"{"env":{"A":"common","B":"common"},"timeout":1}"#,
            r#"{"env":{"A":"provider"},"timeout":2}"#,
        )
        .unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["env"]["A"], "provider");
        assert_eq!(value["env"]["B"], "common");
        assert_eq!(value["timeout"], 2);
    }

    #[tokio::test]
    async fn catalog_and_key_projection_round_trip_without_ccs() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        database::open_connection_at(path.clone()).await.unwrap();

        let mut connection = database::open_connection_at(path).await.unwrap();
        let provider_id = "p1";
        sqlx::query(
            "INSERT INTO providers
             (id, app_type, name, settings_config, created_at, meta)
             VALUES (?1, 'claude', 'Claude', '{\"env\":{}}', 1, '{\"enabled\":true}')",
        )
        .bind(provider_id)
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO provider_api_keys
             (id, provider_id, app_type, label, api_key, enabled, created_at, updated_at)
             VALUES ('k1', ?1, 'claude', 'Primary', 'sk-secret', 1, 1, 1)",
        )
        .bind(provider_id)
        .execute(&mut connection)
        .await
        .unwrap();
        let mut transaction = connection.begin().await.unwrap();
        activate_key_in_transaction(&mut transaction, provider_id, "claude", "k1")
            .await
            .unwrap();
        transaction.commit().await.unwrap();

        let settings: String = sqlx::query_scalar(
            "SELECT settings_config FROM providers WHERE id = ?1 AND app_type = 'claude'",
        )
        .bind(provider_id)
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert!(settings.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(settings.contains("sk-secret"));
        let rows = list_keys_for_provider(&mut connection, "claude", provider_id)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].masked_api_key.contains("sk-secret"));
    }
}
