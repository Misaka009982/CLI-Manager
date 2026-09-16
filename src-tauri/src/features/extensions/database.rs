use std::borrow::Cow;

use sqlx::migrate::{Migration, MigrationType, Migrator};
use sqlx::SqliteConnection;

static SCHEMA_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// Native IPC can open the main database before the renderer SQL plugin migrates it.
// Reuse the registered extension migrations, including their SQLx checksums/history.
pub(super) async fn ensure_schema(connection: &mut SqliteConnection) -> Result<(), String> {
    let _guard = SCHEMA_LOCK.lock().await;
    let migrations = crate::migrations()
        .into_iter()
        .filter(|migration| (38..=40).contains(&migration.version))
        .map(|migration| {
            Migration::new(
                migration.version,
                Cow::Borrowed(migration.description),
                MigrationType::Simple,
                Cow::Borrowed(migration.sql),
                false,
            )
        })
        .collect::<Vec<_>>();
    let mut migrator = Migrator {
        migrations: Cow::Owned(migrations),
        ..Migrator::DEFAULT
    };
    // Earlier application migrations belong to the startup SQL plugin, not this domain.
    migrator.set_ignore_missing(true);
    migrator.run_direct(connection).await.map_err(|error| {
        log::error!("Extension schema initialization failed: {error}");
        "extensions_schema_initialization_failed".to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::migrate::Migrate;
    use sqlx::{Connection, Row};

    // Reproduce a v37 database with no extension tables, then check plugin compatibility.
    #[tokio::test]
    async fn upgrades_legacy_database_and_preserves_existing_data() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects VALUES ('existing-project')")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.ensure_migrations_table().await.unwrap();
        sqlx::query("INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (37, 'legacy', 1, X'01', 0)")
            .execute(&mut connection).await.unwrap();
        ensure_schema(&mut connection).await.unwrap();
        ensure_schema(&mut connection).await.unwrap();
        for table in [
            "extension_mcp_resources",
            "extension_skill_packages",
            "extension_skill_installations",
            "extension_scope_policies",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(count, 0);
        }
        let project: String = sqlx::query_scalar("SELECT id FROM projects")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(project, "existing-project");
        for migration in crate::migrations()
            .into_iter()
            .filter(|m| (38..=40).contains(&m.version))
        {
            let row =
                sqlx::query("SELECT checksum, description FROM _sqlx_migrations WHERE version = ?")
                    .bind(migration.version)
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            let expected = Migration::new(
                migration.version,
                Cow::Borrowed(migration.description),
                MigrationType::Simple,
                Cow::Borrowed(migration.sql),
                false,
            );
            assert_eq!(
                row.get::<Vec<u8>, _>("checksum"),
                expected.checksum.as_ref()
            );
            assert_eq!(row.get::<String, _>("description"), migration.description);
        }
    }

    // The global page requests MCP and Skill lists concurrently on separate connections.
    #[tokio::test]
    async fn concurrent_first_reads_share_migration_history() {
        let directory = tempfile::tempdir().unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(directory.path().join("extensions.db"))
            .create_if_missing(true);
        let mut first = SqliteConnection::connect_with(&options).await.unwrap();
        let mut second = SqliteConnection::connect_with(&options).await.unwrap();
        let (a, b) = tokio::join!(ensure_schema(&mut first), ensure_schema(&mut second));
        a.unwrap();
        b.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&mut first)
            .await
            .unwrap();
        assert_eq!(count, 3);
        first.close().await.unwrap();
        second.close().await.unwrap();
    }

    // A failed migration stays an error; never return an apparently empty resource list.
    #[tokio::test]
    async fn rejects_checksum_drift() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        ensure_schema(&mut connection).await.unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 38")
            .execute(&mut connection)
            .await
            .unwrap();
        assert_eq!(
            ensure_schema(&mut connection).await.unwrap_err(),
            "extensions_schema_initialization_failed"
        );
    }
}
