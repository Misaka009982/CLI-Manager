use super::dto::{CommonConfigDocument, CommonConfigSetInput};
use super::support::{
    contains_secret_fields, error, map_database_error, normalize_app_type, redact_settings_config,
};
use crate::provider::database;
use serde_json::Value;
use sqlx::SqliteConnection;

pub(crate) async fn get_common_config_value(
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

pub(crate) fn merge_json_documents(common: &str, provider: &str) -> Result<String, String> {
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
        if contains_secret_fields(&parsed) {
            return Err(error("provider_common_config_contains_secret", "value"));
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
