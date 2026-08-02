use crate::app_paths;
use sha2::{Digest, Sha384};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode};
use sqlx::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const PROVIDER_SCHEMA_VERSION: i64 = 1;
const PROVIDER_DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const PROVIDER_SCHEMA_DESCRIPTION: &str = "create_ccs_provider_domain";

/// The provider domain is intentionally independent from the historical
/// provider tables in `cli-manager.db`. Keep this schema CCS-shaped for the
/// provider core, then add only the CLI-Manager-owned boundaries needed for
/// manual keys, Home selection, import, repair, and live-apply recovery.
pub(crate) const PROVIDER_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS provider_schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
    id                TEXT NOT NULL,
    app_type          TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    name              TEXT NOT NULL,
    settings_config   TEXT NOT NULL,
    website_url       TEXT,
    category          TEXT,
    created_at        INTEGER NOT NULL,
    sort_index        INTEGER NOT NULL DEFAULT 0,
    notes             TEXT,
    icon              TEXT,
    icon_color        TEXT,
    meta              TEXT NOT NULL DEFAULT '{}',
    is_current        INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
    in_failover_queue INTEGER NOT NULL DEFAULT 0 CHECK (in_failover_queue IN (0, 1)),
    PRIMARY KEY (id, app_type)
);

CREATE INDEX IF NOT EXISTS idx_providers_app_type_sort
    ON providers(app_type, sort_index, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_one_current
    ON providers(app_type)
    WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_api_keys (
    id          TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    app_type    TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    label       TEXT NOT NULL,
    api_key     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    notes       TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    sort_index  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (provider_id, app_type)
        REFERENCES providers(id, app_type) ON DELETE CASCADE,
    UNIQUE (provider_id, app_type, label)
);

CREATE INDEX IF NOT EXISTS idx_provider_api_keys_pool
    ON provider_api_keys(provider_id, app_type, sort_index, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_api_keys_one_active
    ON provider_api_keys(provider_id, app_type)
    WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS provider_home_preferences (
    environment_kind TEXT NOT NULL CHECK (environment_kind IN ('local', 'wsl')),
    environment_id   TEXT NOT NULL,
    mode             TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
    home_path        TEXT,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (environment_kind, environment_id)
);

CREATE TABLE IF NOT EXISTS provider_apply_journal (
    id                         TEXT PRIMARY KEY,
    app_type                  TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    provider_id               TEXT NOT NULL,
    home_identity             TEXT NOT NULL,
    operation                 TEXT NOT NULL,
    state                     TEXT NOT NULL,
    target_paths_json         TEXT NOT NULL DEFAULT '[]',
    backup_paths_json         TEXT NOT NULL DEFAULT '[]',
    expected_fingerprints_json TEXT NOT NULL DEFAULT '{}',
    desired_fingerprints_json  TEXT NOT NULL DEFAULT '{}',
    started_at                INTEGER NOT NULL,
    finished_at               INTEGER,
    error_code                TEXT
);

CREATE INDEX IF NOT EXISTS idx_provider_apply_journal_recovery
    ON provider_apply_journal(state, app_type, home_identity);

CREATE TABLE IF NOT EXISTS provider_import_refs (
    source_kind        TEXT NOT NULL,
    source_identity    TEXT NOT NULL,
    source_app_type    TEXT NOT NULL CHECK (source_app_type IN ('claude', 'codex', 'grokbuild')),
    source_provider_id TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    provider_id        TEXT NOT NULL,
    app_type           TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    imported_at        INTEGER NOT NULL,
    PRIMARY KEY (source_kind, source_identity, source_app_type, source_provider_id),
    FOREIGN KEY (provider_id, app_type)
        REFERENCES providers(id, app_type) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_provider_import_refs_native
    ON provider_import_refs(provider_id, app_type);

CREATE TABLE IF NOT EXISTS provider_migration_issues (
    id            TEXT PRIMARY KEY,
    scope_kind    TEXT NOT NULL CHECK (scope_kind IN ('project', 'worktree')),
    scope_id      TEXT NOT NULL,
    app_type      TEXT NOT NULL CHECK (app_type IN ('claude', 'codex', 'grokbuild')),
    legacy_payload TEXT NOT NULL,
    reason        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_provider_migration_issues_open
    ON provider_migration_issues(scope_kind, scope_id, app_type)
    WHERE resolved_at IS NULL;
"#;

pub(crate) async fn initialize() -> Result<(), String> {
    let path = app_paths::providers_db_path()?;
    initialize_at(&path).await
}

async fn initialize_at(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "provider_db_parent_unavailable".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("provider_db_directory_failed: {err}"))?;

    let existing_database = path.is_file()
        && fs::metadata(path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
    let options = connection_options(path);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| format!("provider_db_open_failed: {err}"))?;

    configure_connection(&mut connection).await?;
    let current_version = read_user_version(&mut connection).await?;
    if current_version > PROVIDER_SCHEMA_VERSION {
        return Err(format!(
            "provider_db_version_unsupported: {current_version}"
        ));
    }

    if current_version < PROVIDER_SCHEMA_VERSION && existing_database {
        checkpoint_before_backup(&mut connection).await?;
        backup_existing_database(path)?;
    }

    sqlx::raw_sql(PROVIDER_SCHEMA_SQL)
        .execute(&mut connection)
        .await
        .map_err(|err| format!("provider_db_schema_failed: {err}"))?;
    ensure_common_config_settings(&mut connection).await?;

    if current_version < PROVIDER_SCHEMA_VERSION {
        record_schema_migration(&mut connection).await?;
        set_user_version(&mut connection, PROVIDER_SCHEMA_VERSION).await?;
    }

    verify_required_tables(&mut connection).await
}

fn connection_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(PROVIDER_DB_BUSY_TIMEOUT)
        .foreign_keys(true)
}

async fn configure_connection(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_foreign_keys_failed: {err}"))?;
    sqlx::query("PRAGMA synchronous = NORMAL")
        .execute(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_synchronous_failed: {err}"))?;
    Ok(())
}

async fn checkpoint_before_backup(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_one(&mut *connection)
        .await
        .map(|_| ())
        .map_err(|err| format!("provider_db_checkpoint_failed: {err}"))
}

async fn read_user_version(connection: &mut SqliteConnection) -> Result<i64, String> {
    sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_version_read_failed: {err}"))
}

async fn set_user_version(connection: &mut SqliteConnection, version: i64) -> Result<(), String> {
    sqlx::query(&format!("PRAGMA user_version = {version}"))
        .execute(&mut *connection)
        .await
        .map(|_| ())
        .map_err(|err| format!("provider_db_version_write_failed: {err}"))
}

async fn record_schema_migration(connection: &mut SqliteConnection) -> Result<(), String> {
    let checksum = format!("{:x}", Sha384::digest(PROVIDER_SCHEMA_SQL.as_bytes()));
    sqlx::query(
        "INSERT OR REPLACE INTO provider_schema_migrations
         (version, description, checksum, applied_at)
         VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(PROVIDER_SCHEMA_VERSION)
    .bind(PROVIDER_SCHEMA_DESCRIPTION)
    .bind(checksum)
    .bind(unix_timestamp_millis())
    .execute(&mut *connection)
    .await
    .map(|_| ())
    .map_err(|err| format!("provider_db_migration_record_failed: {err}"))
}

async fn ensure_common_config_settings(connection: &mut SqliteConnection) -> Result<(), String> {
    for key in [
        "common_config_claude",
        "common_config_codex",
        "common_config_grokbuild",
    ] {
        sqlx::query("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, '{}')")
            .bind(key)
            .execute(&mut *connection)
            .await
            .map_err(|err| format!("provider_db_common_config_seed_failed: {err}"))?;
    }
    Ok(())
}

async fn verify_required_tables(connection: &mut SqliteConnection) -> Result<(), String> {
    for table in [
        "providers",
        "settings",
        "provider_api_keys",
        "provider_home_preferences",
        "provider_apply_journal",
        "provider_import_refs",
        "provider_migration_issues",
    ] {
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        )
        .bind(table)
        .fetch_one(&mut *connection)
        .await
        .map_err(|err| format!("provider_db_schema_check_failed: {err}"))?;
        if exists != 1 {
            return Err(format!("provider_db_table_missing: {table}"));
        }
    }
    Ok(())
}

fn backup_existing_database(path: &Path) -> Result<PathBuf, String> {
    let data_dir = path
        .parent()
        .ok_or_else(|| "provider_db_backup_parent_unavailable".to_string())?;
    let backup_dir = data_dir.join("backups").join("providers");
    fs::create_dir_all(&backup_dir)
        .map_err(|err| format!("provider_db_backup_directory_failed: {err}"))?;

    let backup_name = format!(
        "providers.db.backup-{}-{}.db",
        unix_timestamp_millis(),
        std::process::id()
    );
    let backup_path = backup_dir.join(backup_name);
    fs::copy(path, &backup_path).map_err(|err| format!("provider_db_backup_failed: {err}"))?;
    Ok(backup_path)
}

fn unix_timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;
    use tempfile::tempdir;

    async fn open_test_connection(path: &Path) -> SqliteConnection {
        SqliteConnection::connect_with(&connection_options(path))
            .await
            .unwrap()
    }

    async fn insert_provider(
        connection: &mut SqliteConnection,
        id: &str,
        app_type: &str,
        is_current: i64,
    ) {
        sqlx::query(
            "INSERT INTO providers
             (id, app_type, name, settings_config, created_at, is_current)
             VALUES (?1, ?2, ?3, '{}', 1, ?4)",
        )
        .bind(id)
        .bind(app_type)
        .bind(format!("{app_type} provider"))
        .bind(is_current)
        .execute(&mut *connection)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn initializes_fresh_database_with_pragmas_and_domain_tables() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");

        initialize_at(&path).await.unwrap();

        let mut connection = open_test_connection(&path).await;
        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(foreign_keys, 1);

        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");

        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(version, PROVIDER_SCHEMA_VERSION);

        let migration = sqlx::query(
            "SELECT description, checksum
             FROM provider_schema_migrations WHERE version = ?1",
        )
        .bind(PROVIDER_SCHEMA_VERSION)
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            migration.get::<String, _>("description"),
            PROVIDER_SCHEMA_DESCRIPTION
        );
        assert_eq!(migration.get::<String, _>("checksum").len(), 96);
        let common_config_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key LIKE 'common_config_%'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(common_config_count, 3);
        assert!(!temp.path().join("backups").exists());
    }

    #[tokio::test]
    async fn composite_identity_and_active_key_index_are_enforced() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        initialize_at(&path).await.unwrap();
        let mut connection = open_test_connection(&path).await;

        insert_provider(&mut connection, "same-id", "claude", 1).await;
        insert_provider(&mut connection, "same-id", "codex", 1).await;

        let duplicate = sqlx::query(
            "INSERT INTO providers
             (id, app_type, name, settings_config, created_at)
             VALUES ('same-id', 'claude', 'duplicate', '{}', 1)",
        )
        .execute(&mut connection)
        .await;
        assert!(duplicate.is_err());

        sqlx::query(
            "INSERT INTO provider_api_keys
             (id, provider_id, app_type, label, api_key, is_active, created_at, updated_at)
             VALUES ('claude-key-1', 'same-id', 'claude', 'Primary', 'secret-1', 1, 1, 1),
                    ('codex-key-1', 'same-id', 'codex', 'Primary', 'secret-2', 1, 1, 1)",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let second_active = sqlx::query(
            "INSERT INTO provider_api_keys
             (id, provider_id, app_type, label, api_key, is_active, created_at, updated_at)
             VALUES ('claude-key-2', 'same-id', 'claude', 'Backup', 'secret-3', 1, 1, 1)",
        )
        .execute(&mut connection)
        .await;
        assert!(second_active.is_err());

        let wrong_owner = sqlx::query(
            "INSERT INTO provider_api_keys
             (id, provider_id, app_type, label, api_key, created_at, updated_at)
             VALUES ('wrong-key', 'same-id', 'grokbuild', 'Wrong', 'secret-4', 1, 1)",
        )
        .execute(&mut connection)
        .await;
        assert!(wrong_owner.is_err());

        sqlx::query("DELETE FROM providers WHERE id = 'same-id' AND app_type = 'claude'")
            .execute(&mut connection)
            .await
            .unwrap();
        let remaining_keys: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM provider_api_keys WHERE app_type = 'claude'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(remaining_keys, 0);

        let remaining_codex: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM providers WHERE id = 'same-id' AND app_type = 'codex'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(remaining_codex, 1);
    }

    #[tokio::test]
    async fn existing_database_is_backed_up_before_schema_initialization() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");
        let mut old_connection = open_test_connection(&path).await;
        sqlx::query("CREATE TABLE legacy_marker (value TEXT NOT NULL)")
            .execute(&mut old_connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO legacy_marker (value) VALUES ('keep')")
            .execute(&mut old_connection)
            .await
            .unwrap();
        old_connection.close().await.unwrap();

        initialize_at(&path).await.unwrap();

        let backup_dir = temp.path().join("backups").join("providers");
        let backups: Vec<PathBuf> = fs::read_dir(&backup_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        assert!(backups[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("providers.db.backup-"));

        let mut backup_connection = open_test_connection(&backups[0]).await;
        let marker: String = sqlx::query_scalar("SELECT value FROM legacy_marker")
            .fetch_one(&mut backup_connection)
            .await
            .unwrap();
        assert_eq!(marker, "keep");
    }

    #[tokio::test]
    async fn initialization_is_idempotent_after_schema_version_is_set() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("providers.db");

        initialize_at(&path).await.unwrap();
        initialize_at(&path).await.unwrap();

        let backup_dir = temp.path().join("backups").join("providers");
        assert!(!backup_dir.exists());
        let mut connection = open_test_connection(&path).await;
        let table_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'provider_api_keys'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(table_count, 1);
    }
}
