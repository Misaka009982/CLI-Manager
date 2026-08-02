use super::{CliType, ProviderDetail, ProviderKeySummary, ProviderStatus, ProviderSummary};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::time::Duration;

pub(crate) async fn open_database() -> Result<SqliteConnection, String> {
    let path = crate::app_paths::db_path().map_err(|_| "provider_database_open_failed")?;
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "provider_database_open_failed".to_string())
}

pub(crate) async fn list_provider_summaries(
    conn: &mut SqliteConnection,
    cli_type: Option<CliType>,
) -> Result<Vec<ProviderSummary>, String> {
    let rows = sqlx::query(
        "SELECT p.id, p.cli_type, p.name, p.status, p.config_format,
                p.inherit_common, p.sort_order, p.created_at, p.updated_at,
                COUNT(k.id) AS key_count,
                MAX(CASE WHEN k.is_active = 1 THEN k.id END) AS active_key_id,
                MAX(CASE WHEN k.is_active = 1 THEN k.secret_hint END) AS active_key_hint
         FROM managed_providers p
         LEFT JOIN managed_provider_keys k ON k.provider_id = p.id
         WHERE (?1 IS NULL OR p.cli_type = ?1)
         GROUP BY p.id
         ORDER BY p.cli_type, p.sort_order, p.created_at, p.id",
    )
    .bind(cli_type.map(CliType::as_str))
    .fetch_all(&mut *conn)
    .await
    .map_err(|_| "provider_database_query_failed".to_string())?;
    rows.iter().map(provider_summary_from_row).collect()
}

pub(crate) async fn get_provider_detail(
    conn: &mut SqliteConnection,
    provider_id: &str,
) -> Result<ProviderDetail, String> {
    let row = sqlx::query(
        "SELECT p.id, p.cli_type, p.name, p.status, p.config_format, p.config_text,
                p.inherit_common, p.sort_order, p.created_at, p.updated_at,
                COUNT(k.id) AS key_count,
                MAX(CASE WHEN k.is_active = 1 THEN k.id END) AS active_key_id,
                MAX(CASE WHEN k.is_active = 1 THEN k.secret_hint END) AS active_key_hint
         FROM managed_providers p
         LEFT JOIN managed_provider_keys k ON k.provider_id = p.id
         WHERE p.id = ?1
         GROUP BY p.id",
    )
    .bind(provider_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|_| "provider_database_query_failed".to_string())?
    .ok_or_else(|| "provider_not_found".to_string())?;
    let summary = provider_summary_from_row(&row)?;
    let config_text = row
        .try_get::<String, _>("config_text")
        .map_err(|_| "provider_database_query_failed".to_string())?;
    let key_rows = sqlx::query(
        "SELECT id, provider_id, label, secret_hint, secret_fingerprint, is_active,
                sort_order, created_at, updated_at
         FROM managed_provider_keys
         WHERE provider_id = ?1
         ORDER BY is_active DESC, sort_order, created_at, id",
    )
    .bind(provider_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|_| "provider_database_query_failed".to_string())?;
    let keys = key_rows
        .iter()
        .map(provider_key_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ProviderDetail {
        summary,
        config_text,
        keys,
    })
}

fn provider_summary_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<ProviderSummary, String> {
    let cli_type = CliType::parse(
        &row.try_get::<String, _>("cli_type")
            .map_err(|_| "provider_database_query_failed".to_string())?,
    )?;
    let status = ProviderStatus::parse(
        &row.try_get::<String, _>("status")
            .map_err(|_| "provider_database_query_failed".to_string())?,
    )?;
    Ok(ProviderSummary {
        id: row
            .try_get("id")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        cli_type,
        name: row
            .try_get("name")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        status,
        config_format: row
            .try_get("config_format")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        inherit_common: row
            .try_get::<i64, _>("inherit_common")
            .map_err(|_| "provider_database_query_failed".to_string())?
            != 0,
        sort_order: row
            .try_get("sort_order")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        key_count: row
            .try_get("key_count")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        active_key_id: row
            .try_get("active_key_id")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        active_key_hint: row
            .try_get("active_key_hint")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        created_at: row
            .try_get("created_at")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        updated_at: row
            .try_get("updated_at")
            .map_err(|_| "provider_database_query_failed".to_string())?,
    })
}

fn provider_key_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<ProviderKeySummary, String> {
    Ok(ProviderKeySummary {
        id: row
            .try_get("id")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        label: row
            .try_get("label")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        has_secret: true,
        secret_hint: row
            .try_get("secret_hint")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        fingerprint: row
            .try_get("secret_fingerprint")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        is_active: row
            .try_get::<i64, _>("is_active")
            .map_err(|_| "provider_database_query_failed".to_string())?
            != 0,
        sort_order: row
            .try_get("sort_order")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        created_at: row
            .try_get("created_at")
            .map_err(|_| "provider_database_query_failed".to_string())?,
        updated_at: row
            .try_get("updated_at")
            .map_err(|_| "provider_database_query_failed".to_string())?,
    })
}
