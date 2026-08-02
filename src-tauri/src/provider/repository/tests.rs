use super::common::merge_json_documents;
use super::keys::activate_key_in_transaction;
use super::support::{
    apply_config_fields, contains_secret_fields, duplicate_settings_config, normalize_app_type,
    project_key_into_settings, redact_settings_config,
};
use crate::provider::database;
use serde_json::Value;
use sqlx::Connection;
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
fn common_config_detects_nested_secret_fields() {
    let value: Value = serde_json::from_str(
        r#"{"env":{"ANTHROPIC_BASE_URL":"https://example.test","OPENAI_API_KEY":"secret"}}"#,
    )
    .unwrap();
    assert!(contains_secret_fields(&value));
    let safe: Value = serde_json::from_str(r#"{"timeout":30,"features":{"hooks":true}}"#).unwrap();
    assert!(!contains_secret_fields(&safe));
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
    let rows = super::support::list_keys_for_provider(&mut connection, "claude", provider_id)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].masked_api_key.contains("sk-secret"));
}
