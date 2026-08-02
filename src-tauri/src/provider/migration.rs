pub(crate) const MIGRATION_CREATE_NATIVE_PROVIDERS_VERSION: i64 = 25;
pub(crate) const MIGRATION_CREATE_NATIVE_PROVIDERS_DESCRIPTION: &str =
    "create_native_provider_management";
pub(crate) const MIGRATION_CREATE_NATIVE_PROVIDERS_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS managed_providers (
    id TEXT PRIMARY KEY,
    cli_type TEXT NOT NULL CHECK (cli_type IN ('claude', 'codex', 'grok')),
    name TEXT NOT NULL,
    name_normalized TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'disabled')),
    config_format TEXT NOT NULL CHECK (
        (cli_type = 'claude' AND config_format = 'json') OR
        (cli_type IN ('codex', 'grok') AND config_format = 'toml')
    ),
    config_text TEXT NOT NULL DEFAULT '',
    inherit_common INTEGER NOT NULL DEFAULT 1 CHECK (inherit_common IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (cli_type, name_normalized)
);

CREATE TABLE IF NOT EXISTS managed_provider_keys (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    label TEXT NOT NULL,
    secret_text TEXT NOT NULL CHECK (length(secret_text) > 0),
    secret_hint TEXT NOT NULL,
    secret_fingerprint TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (provider_id) REFERENCES managed_providers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_provider_keys_one_active
    ON managed_provider_keys(provider_id) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_managed_provider_keys_provider
    ON managed_provider_keys(provider_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_managed_providers_type_sort
    ON managed_providers(cli_type, sort_order, created_at);

CREATE TABLE IF NOT EXISTS managed_provider_common_configs (
    cli_type TEXT PRIMARY KEY CHECK (cli_type IN ('claude', 'codex', 'grok')),
    config_format TEXT NOT NULL CHECK (config_format IN ('json', 'toml')),
    config_text TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_provider_global_state (
    cli_type TEXT PRIMARY KEY CHECK (cli_type IN ('claude', 'codex', 'grok')),
    provider_id TEXT,
    applied_revision INTEGER NOT NULL DEFAULT 0,
    live_hash TEXT,
    applied_home TEXT,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (provider_id) REFERENCES managed_providers(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS provider_import_refs (
    source TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    cli_type TEXT NOT NULL CHECK (cli_type IN ('claude', 'codex', 'grok')),
    external_id TEXT NOT NULL,
    native_provider_id TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (source, source_ref, cli_type, external_id),
    FOREIGN KEY (native_provider_id) REFERENCES managed_providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_migration_issues (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    cli_type TEXT NOT NULL CHECK (cli_type IN ('claude', 'codex', 'grok')),
    legacy_payload TEXT NOT NULL,
    reason TEXT NOT NULL,
    resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS provider_apply_journal (
    id TEXT PRIMARY KEY,
    cli_type TEXT NOT NULL CHECK (cli_type IN ('claude', 'codex', 'grok')),
    operation TEXT NOT NULL,
    state TEXT NOT NULL,
    target_paths_json TEXT NOT NULL DEFAULT '[]',
    backup_paths_json TEXT NOT NULL DEFAULT '[]',
    desired_hash TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error_code TEXT
);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor, Row, SqliteConnection};

    #[tokio::test]
    async fn native_provider_schema_enforces_active_key_and_cascade_contracts() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute("PRAGMA foreign_keys = ON").await.unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_NATIVE_PROVIDERS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();

        let now = 1_i64;
        sqlx::query(
            "INSERT INTO managed_providers
             (id, cli_type, name, name_normalized, status, config_format, created_at, updated_at)
             VALUES ('p1', 'claude', 'Provider', 'provider', 'ready', 'json', ?1, ?1)",
        )
        .bind(now)
        .execute(&mut conn)
        .await
        .unwrap();

        for id in ["k1", "k2"] {
            let result = sqlx::query(
                "INSERT INTO managed_provider_keys
                 (id, provider_id, label, secret_text, secret_hint, secret_fingerprint,
                  is_active, created_at, updated_at)
                 VALUES (?1, 'p1', ?1, 'plain-secret', 'plain...cret', ?1, 1, ?2, ?2)",
            )
            .bind(id)
            .bind(now)
            .execute(&mut conn)
            .await;
            if id == "k1" {
                result.unwrap();
            } else {
                assert!(result.is_err(), "a second active key must be rejected");
            }
        }

        sqlx::query("DELETE FROM managed_providers WHERE id = 'p1'")
            .execute(&mut conn)
            .await
            .unwrap();
        let remaining: i64 = sqlx::query("SELECT COUNT(*) AS count FROM managed_provider_keys")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .get("count");
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    async fn native_provider_schema_rejects_cross_type_config_formats() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_NATIVE_PROVIDERS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        let result = sqlx::query(
            "INSERT INTO managed_providers
             (id, cli_type, name, name_normalized, status, config_format, created_at, updated_at)
             VALUES ('p1', 'codex', 'Provider', 'provider', 'draft', 'json', 1, 1)",
        )
        .execute(&mut conn)
        .await;
        assert!(result.is_err());
    }
}
