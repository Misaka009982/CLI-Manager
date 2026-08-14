use sqlx::{Connection, SqliteConnection};
use std::time::Duration;

pub(crate) async fn ensure_usage_schema(connection: &mut SqliteConnection) -> Result<(), String> {
    for (name, sql) in [
        ("request_logs", crate::MIGRATION_CREATE_REQUEST_LOGS_SQL),
        ("usage_records", crate::MIGRATION_CREATE_USAGE_RECORDS_SQL),
        (
            "unified_usage_records",
            crate::MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_SQL,
        ),
        (
            "optimized_unified_usage_records",
            crate::MIGRATION_OPTIMIZE_UNIFIED_USAGE_RECORDS_SQL,
        ),
    ] {
        for statement in sql
            .split(';')
            .map(str::trim)
            .filter(|statement| !statement.is_empty())
        {
            sqlx::query(statement)
                .execute(&mut *connection)
                .await
                .map_err(|err| format!("usage_schema_bootstrap_failed:{name}:{err}"))?;
        }
    }
    Ok(())
}

pub(crate) async fn open_usage_database() -> Result<SqliteConnection, String> {
    let path = crate::app_paths::db_path()?;
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .busy_timeout(Duration::from_secs(15));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| format!("usage_db_open_failed: {err}"))?;
    ensure_usage_schema(&mut connection).await?;
    Ok(connection)
}
