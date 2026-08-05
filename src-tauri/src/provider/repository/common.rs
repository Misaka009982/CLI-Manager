use super::documents::{redact_common_document, redact_toml_document};
use super::dto::{CommonConfigDocument, CommonConfigSetInput};
use super::support::{contains_secret_fields, error, map_database_error, normalize_app_type};
use crate::provider::database;
use serde_json::Value;
use sqlx::SqliteConnection;

pub(crate) async fn get_common_config_value(
    connection: &mut SqliteConnection,
    app_type: &str,
) -> Result<String, String> {
    let value = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(format!("common_config_{app_type}"))
        .fetch_optional(&mut *connection)
        .await
        .map_err(|err| map_database_error("provider_common_config_read_failed", err))?
        .ok_or_else(|| error("provider_common_config_not_found", app_type))?;
    if app_type != "claude" && value.trim() == "{}" {
        return Ok(String::new());
    }
    Ok(value)
}

pub(crate) async fn get_common_config(app_type: String) -> Result<CommonConfigDocument, String> {
    let app_type = normalize_app_type(&app_type)?;
    let mut connection = database::open_connection().await?;
    let value = get_common_config_value(&mut connection, &app_type).await?;
    let (value, _, _, format) = redact_common_document(&app_type, &value);
    Ok(CommonConfigDocument {
        app_type,
        value,
        format,
    })
}

pub(crate) fn validate_common_config(input: CommonConfigSetInput) -> Result<(), String> {
    validate_common_config_input(&input)
}

pub(crate) async fn set_common_config(
    input: CommonConfigSetInput,
) -> Result<CommonConfigDocument, String> {
    validate_common_config_input(&input)?;
    let app_type = normalize_app_type(&input.app_type)?;
    let value = input.value.trim().to_string();
    let expected_format = if app_type == "claude" { "json" } else { "toml" };
    let mut connection = database::open_connection().await?;
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)")
        .bind(format!("common_config_{app_type}"))
        .bind(&value)
        .execute(&mut connection)
        .await
        .map_err(|err| map_database_error("provider_common_config_write_failed", err))?;
    let (value, _, _, _) = redact_common_document(&app_type, &value);
    Ok(CommonConfigDocument {
        app_type,
        value,
        format: expected_format.to_string(),
    })
}

fn validate_common_config_input(input: &CommonConfigSetInput) -> Result<(), String> {
    let app_type = normalize_app_type(&input.app_type)?;
    let value = input.value.trim();
    if value.is_empty() {
        return Err(error("provider_common_config_required", "value"));
    }
    let expected_format = if app_type == "claude" { "json" } else { "toml" };
    let format = input
        .format
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| expected_format.to_string());
    if format != expected_format {
        return Err(error(
            "provider_common_config_format_invalid",
            expected_format,
        ));
    }
    if app_type == "claude" {
        let parsed = serde_json::from_str::<Value>(value)
            .map_err(|_| error("provider_common_config_invalid_json", "value"))?;
        if !parsed.is_object() {
            return Err(error("provider_common_config_must_be_object", "value"));
        }
        if contains_secret_fields(&parsed) {
            return Err(error("provider_common_config_contains_secret", "value"));
        }
    } else {
        let (_, has_secret, valid) = redact_toml_document(value);
        if !valid {
            return Err(error("provider_common_config_invalid_toml", "value"));
        }
        if has_secret {
            return Err(error("provider_common_config_contains_secret", "value"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_common_config, CommonConfigSetInput};

    fn input(app_type: &str, value: &str, format: Option<&str>) -> CommonConfigSetInput {
        CommonConfigSetInput {
            app_type: app_type.to_string(),
            value: value.to_string(),
            format: format.map(str::to_string),
        }
    }

    #[test]
    fn validates_claude_json_object() {
        assert!(
            validate_common_config(input("claude", r#"{"model":"sonnet"}"#, Some("json"))).is_ok()
        );
    }

    #[test]
    fn rejects_claude_non_object() {
        assert_eq!(
            validate_common_config(input("claude", "[]", Some("json"))).unwrap_err(),
            "provider_common_config_must_be_object:value"
        );
    }

    #[test]
    fn validates_codex_toml() {
        assert!(validate_common_config(input("codex", "model = \"gpt-5\"", Some("toml"))).is_ok());
    }

    #[test]
    fn rejects_invalid_grok_toml() {
        assert_eq!(
            validate_common_config(input("grok", "model =", Some("toml"))).unwrap_err(),
            "provider_common_config_invalid_toml:value"
        );
    }
}
