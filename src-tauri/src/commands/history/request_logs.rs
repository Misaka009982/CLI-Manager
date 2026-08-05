use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, QueryBuilder, Row, Sqlite, SqliteConnection};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;

const REQUEST_LOG_PARSER_VERSION: i64 = 1;
const DEFAULT_PAGE_SIZE: u32 = 20;
const MAX_PAGE_SIZE: u32 = 100;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RequestLogFilters {
    source: Option<String>,
    project_key: Option<String>,
    model: Option<String>,
    session_query: Option<String>,
    start_at: Option<i64>,
    end_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogSyncResult {
    scanned_files: u64,
    changed_files: u64,
    removed_files: u64,
    written_rows: u64,
    failed_files: u64,
    synced_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogItem {
    request_id: String,
    source: String,
    project_key: String,
    session_id: String,
    file_path: String,
    event_index: u64,
    timestamp_ms: i64,
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
    status: &'static str,
    session_available: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct RequestLogSummary {
    total: u64,
    total_tokens: u64,
    total_cost_usd: f64,
    unpriced_tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogPage {
    data: Vec<RequestLogItem>,
    summary: RequestLogSummary,
    total: u64,
    page: u32,
    page_size: u32,
}

#[derive(Clone)]
struct RequestLogDocument {
    source: String,
    project_key: String,
    session_id: String,
    file_path: String,
    fingerprint: SessionFileFingerprint,
    events: Vec<SessionUsageEventScan>,
}

#[derive(Clone, Copy)]
struct RequestLogSyncState {
    source: &'static str,
    fingerprint: SessionFileFingerprint,
    parser_version: i64,
}

fn request_log_sync_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

async fn open_cli_manager_db() -> Result<SqliteConnection, String> {
    let path = crate::app_paths::db_path()?;
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(15));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| format!("request_logs_db_open_failed: {err}"))
}

fn fingerprint_matches(state: RequestLogSyncState, current: SessionFileFingerprint) -> bool {
    state.parser_version == REQUEST_LOG_PARSER_VERSION && state.fingerprint == current
}

fn history_root_available(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&path_str) {
        let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&path_str) else {
            return false;
        };
        let program = crate::wsl::find_wsl_exe()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| "wsl.exe".to_string());
        return wsl_command_output(
            &program,
            &["-d", &distro, "--exec", "test", "-d", &linux_path],
        )
        .is_ok_and(|output| output.status.success());
    }
    std::fs::read_dir(path).is_ok()
}

fn available_cleanup_sources(roots: &HistoryRoots) -> HashSet<&'static str> {
    let mut sources = HashSet::new();
    if history_root_available(&resolve_claude_history_root(roots)) {
        sources.insert("claude");
    }
    if history_root_available(&resolve_codex_history_root(roots)) {
        sources.insert("codex");
    }
    sources
}

fn session_file_available(file_path: &str) -> bool {
    crate::wsl::is_wsl_config_dir(file_path) || Path::new(file_path).is_file()
}

fn fallback_event_key(event: &SessionUsageEventScan, index: usize) -> String {
    format!(
        "fallback:{}:{}:{}:{}:{}:{}",
        event.timestamp_ms.unwrap_or(index as i64),
        event.model.as_deref().unwrap_or("unknown"),
        event.usage.input_tokens,
        event.usage.output_tokens,
        event.usage.cache_read_tokens,
        event.usage.cache_creation_tokens
    )
}

fn document_from_entry(entry: HistoryIndexEntry) -> RequestLogDocument {
    let summary = summary_from_computation(&entry.file_ref, &entry.computed);
    let mut events = stats_usage_events_or_fallback(&summary, &entry.computed.stats);
    for (index, event) in events.iter_mut().enumerate() {
        if event.event_key.trim().is_empty() {
            event.event_key = fallback_event_key(event, index);
        }
        event.event_index = index;
    }

    RequestLogDocument {
        source: entry.file_ref.source,
        project_key: entry.file_ref.project_key,
        session_id: entry.computed.session_id,
        file_path: path_to_key(&entry.file_ref.path),
        fingerprint: entry.fingerprint,
        events,
    }
}

async fn load_sync_state(
    conn: &mut SqliteConnection,
) -> Result<HashMap<String, RequestLogSyncState>, String> {
    let rows = sqlx::query(
        "SELECT file_path, source, file_created_at, file_updated_at, file_size, parser_version FROM request_log_sync",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("request_logs_sync_state_failed: {err}"))?;
    let mut states = HashMap::with_capacity(rows.len());
    for row in rows {
        let file_path: String = row.try_get("file_path").map_err(|err| err.to_string())?;
        states.insert(
            file_path,
            RequestLogSyncState {
                source: match row
                    .try_get::<String, _>("source")
                    .map_err(|err| err.to_string())?
                    .as_str()
                {
                    "claude" => "claude",
                    "codex" => "codex",
                    _ => "unknown",
                },
                fingerprint: SessionFileFingerprint {
                    created_at: row
                        .try_get("file_created_at")
                        .map_err(|err| err.to_string())?,
                    updated_at: row
                        .try_get("file_updated_at")
                        .map_err(|err| err.to_string())?,
                    size: row
                        .try_get::<i64, _>("file_size")
                        .map_err(|err| err.to_string())?
                        .max(0) as u64,
                },
                parser_version: row
                    .try_get("parser_version")
                    .map_err(|err| err.to_string())?,
            },
        );
    }
    Ok(states)
}

fn request_id(source: &str, file_path: &str, event_key: &str) -> String {
    let digest = Sha256::digest(format!("{source}|{file_path}|{event_key}").as_bytes());
    format!("{digest:x}")
}

async fn replace_document(
    conn: &mut SqliteConnection,
    document: &RequestLogDocument,
    synced_at_ms: i64,
) -> Result<u64, String> {
    let mut tx = conn
        .begin()
        .await
        .map_err(|err| format!("request_logs_transaction_failed: {err}"))?;
    sqlx::query("DELETE FROM request_logs WHERE file_path = ?1")
        .bind(&document.file_path)
        .execute(&mut *tx)
        .await
        .map_err(|err| format!("request_logs_delete_failed: {err}"))?;

    for event in &document.events {
        let timestamp_ms = event
            .timestamp_ms
            .unwrap_or(document.fingerprint.updated_at);
        sqlx::query(
            "INSERT INTO request_logs(
                request_id, source, project_key, session_id, file_path, event_key, event_index,
                timestamp_ms, model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )
        .bind(request_id(
            &document.source,
            &document.file_path,
            &event.event_key,
        ))
        .bind(&document.source)
        .bind(&document.project_key)
        .bind(&document.session_id)
        .bind(&document.file_path)
        .bind(&event.event_key)
        .bind(event.event_index as i64)
        .bind(timestamp_ms)
        .bind(&event.model)
        .bind(event.usage.input_tokens as i64)
        .bind(event.usage.output_tokens as i64)
        .bind(event.usage.cache_read_tokens as i64)
        .bind(event.usage.cache_creation_tokens as i64)
        .bind(synced_at_ms)
        .bind(synced_at_ms)
        .execute(&mut *tx)
        .await
        .map_err(|err| format!("request_logs_insert_failed: {err}"))?;
    }

    sqlx::query(
        "INSERT INTO request_log_sync(
            file_path, source, file_created_at, file_updated_at, file_size, parser_version, last_synced_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(file_path) DO UPDATE SET
            source = excluded.source,
            file_created_at = excluded.file_created_at,
            file_updated_at = excluded.file_updated_at,
            file_size = excluded.file_size,
            parser_version = excluded.parser_version,
            last_synced_at_ms = excluded.last_synced_at_ms",
    )
    .bind(&document.file_path)
    .bind(&document.source)
    .bind(document.fingerprint.created_at)
    .bind(document.fingerprint.updated_at)
    .bind(document.fingerprint.size as i64)
    .bind(REQUEST_LOG_PARSER_VERSION)
    .bind(synced_at_ms)
    .execute(&mut *tx)
    .await
    .map_err(|err| format!("request_logs_sync_state_write_failed: {err}"))?;

    tx.commit()
        .await
        .map_err(|err| format!("request_logs_commit_failed: {err}"))?;
    Ok(document.events.len() as u64)
}

async fn remove_missing_files(
    conn: &mut SqliteConnection,
    stale_paths: &[String],
) -> Result<u64, String> {
    if stale_paths.is_empty() {
        return Ok(0);
    }
    let mut tx = conn
        .begin()
        .await
        .map_err(|err| format!("request_logs_cleanup_transaction_failed: {err}"))?;
    for path in stale_paths {
        sqlx::query("DELETE FROM request_logs WHERE file_path = ?1")
            .bind(path)
            .execute(&mut *tx)
            .await
            .map_err(|err| format!("request_logs_cleanup_failed: {err}"))?;
        sqlx::query("DELETE FROM request_log_sync WHERE file_path = ?1")
            .bind(path)
            .execute(&mut *tx)
            .await
            .map_err(|err| format!("request_logs_cleanup_failed: {err}"))?;
    }
    tx.commit()
        .await
        .map_err(|err| format!("request_logs_cleanup_commit_failed: {err}"))?;
    Ok(stale_paths.len() as u64)
}

async fn sync_request_logs_with_connection(
    conn: &mut SqliteConnection,
    roots: HistoryRoots,
    force: bool,
) -> Result<RequestLogSyncResult, String> {
    let (index, cleanup_sources) = tokio::task::spawn_blocking(move || {
        let cleanup_sources = available_cleanup_sources(&roots);
        let index = refresh_history_index_snapshot(&roots, force);
        (index, cleanup_sources)
    })
    .await
    .map_err(|err| format!("request_logs_scan_join_failed: {err}"))?;
    let synced_at_ms = now_millis();
    let sync_state = load_sync_state(conn).await?;
    let request_log_entries: Vec<HistoryIndexEntry> = index
        .entries
        .into_iter()
        .filter(|entry| matches!(entry.file_ref.source.as_str(), "claude" | "codex"))
        .collect();
    let current_paths: HashSet<String> = request_log_entries
        .iter()
        .map(|entry| path_to_key(&entry.file_ref.path))
        .collect();
    let stale_paths: Vec<String> = sync_state
        .iter()
        .filter(|(path, state)| {
            cleanup_sources.contains(state.source) && !current_paths.contains(*path)
        })
        .map(|(path, _)| path.clone())
        .collect();
    let scanned_files = request_log_entries.len() as u64;
    let changed_documents: Vec<RequestLogDocument> = request_log_entries
        .into_iter()
        .filter(|entry| {
            let file_path = path_to_key(&entry.file_ref.path);
            force
                || sync_state
                    .get(&file_path)
                    .map(|state| !fingerprint_matches(*state, entry.fingerprint))
                    .unwrap_or(true)
        })
        .map(document_from_entry)
        .collect();

    let changed_files = changed_documents.len() as u64;
    let mut written_rows = 0u64;
    let mut failed_files = 0u64;
    for document in &changed_documents {
        match replace_document(conn, document, synced_at_ms).await {
            Ok(count) => written_rows = written_rows.saturating_add(count),
            Err(err) => {
                failed_files = failed_files.saturating_add(1);
                warn!(
                    "request log sync skipped file: source={} path={} error={err}",
                    document.source, document.file_path
                );
            }
        }
    }

    let removed_files = remove_missing_files(conn, &stale_paths).await?;
    Ok(RequestLogSyncResult {
        scanned_files,
        changed_files,
        removed_files,
        written_rows,
        failed_files,
        synced_at_ms,
    })
}

#[tauri::command]
pub async fn history_sync_request_logs(
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
    force: Option<bool>,
) -> Result<RequestLogSyncResult, String> {
    let _guard = request_log_sync_lock().lock().await;
    let mut conn = open_cli_manager_db().await?;
    sync_request_logs_with_connection(
        &mut conn,
        history_roots(claude_config_dir, codex_config_dir, grok_session_root),
        force.unwrap_or(false),
    )
    .await
}

fn normalized_filter(value: Option<&String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn like_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn push_filters(builder: &mut QueryBuilder<'_, Sqlite>, filters: &RequestLogFilters) {
    builder.push(" WHERE 1 = 1");
    if let Some(source) = normalized_filter(filters.source.as_ref()) {
        if source == "claude" || source == "codex" {
            builder.push(" AND source = ").push_bind(source);
        }
    }
    if let Some(project_key) = normalized_filter(filters.project_key.as_ref()) {
        builder
            .push(" AND project_key LIKE ")
            .push_bind(like_pattern(&project_key))
            .push(" ESCAPE '\\'");
    }
    if let Some(model) = normalized_filter(filters.model.as_ref()) {
        builder
            .push(" AND COALESCE(model, '') LIKE ")
            .push_bind(like_pattern(&model))
            .push(" ESCAPE '\\'");
    }
    if let Some(session_query) = normalized_filter(filters.session_query.as_ref()) {
        let pattern = like_pattern(&session_query);
        builder
            .push(" AND (session_id LIKE ")
            .push_bind(pattern.clone())
            .push(" ESCAPE '\\' OR file_path LIKE ")
            .push_bind(pattern)
            .push(" ESCAPE '\\')");
    }
    if let Some(start_at) = filters.start_at {
        builder.push(" AND timestamp_ms >= ").push_bind(start_at);
    }
    if let Some(end_at) = filters.end_at {
        builder.push(" AND timestamp_ms <= ").push_bind(end_at);
    }
}

async fn list_request_logs_with_connection(
    conn: &mut SqliteConnection,
    filters: RequestLogFilters,
    page: u32,
    page_size: u32,
) -> Result<RequestLogPage, String> {
    if normalized_filter(filters.source.as_ref())
        .is_some_and(|source| source != "claude" && source != "codex")
    {
        return Err("request_logs_invalid_source".to_string());
    }
    if filters
        .start_at
        .zip(filters.end_at)
        .is_some_and(|(start, end)| end < start)
    {
        return Err("request_logs_invalid_range".to_string());
    }
    let page_size = page_size.clamp(1, MAX_PAGE_SIZE);

    let mut count_builder =
        QueryBuilder::<Sqlite>::new("SELECT COUNT(*) AS total FROM request_logs");
    push_filters(&mut count_builder, &filters);
    let total = count_builder
        .build()
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| format!("request_logs_count_failed: {err}"))?
        .try_get::<i64, _>("total")
        .map_err(|err| err.to_string())?
        .max(0) as u64;

    let mut summary_builder = QueryBuilder::<Sqlite>::new(
        "SELECT model,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_creation_tokens) AS cache_creation_tokens
         FROM request_logs",
    );
    push_filters(&mut summary_builder, &filters);
    summary_builder.push(" GROUP BY model");
    let summary_rows = summary_builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("request_logs_summary_failed: {err}"))?;
    let mut summary = RequestLogSummary {
        total,
        ..RequestLogSummary::default()
    };
    for row in summary_rows {
        let model: Option<String> = row.try_get("model").map_err(|err| err.to_string())?;
        let usage = UsageTokenScan {
            input_tokens: row
                .try_get::<i64, _>("input_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            output_tokens: row
                .try_get::<i64, _>("output_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            cache_read_tokens: row
                .try_get::<i64, _>("cache_read_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            cache_creation_tokens: row
                .try_get::<i64, _>("cache_creation_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            explicit_cost_usd: None,
        };
        let priced = calculate_usage_cost(model.as_deref(), usage);
        summary.total_tokens = summary
            .total_tokens
            .saturating_add(usage_total_tokens(usage));
        summary.total_cost_usd += priced.total_cost_usd;
        summary.unpriced_tokens = summary
            .unpriced_tokens
            .saturating_add(priced.unpriced_tokens);
    }

    let mut page_builder = QueryBuilder::<Sqlite>::new(
        "SELECT request_id, source, project_key, session_id, file_path, event_index,
            timestamp_ms, model, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens
         FROM request_logs",
    );
    push_filters(&mut page_builder, &filters);
    page_builder
        .push(" ORDER BY timestamp_ms DESC, request_id DESC LIMIT ")
        .push_bind(page_size as i64)
        .push(" OFFSET ")
        .push_bind(
            (page as u64)
                .saturating_mul(page_size as u64)
                .min(i64::MAX as u64) as i64,
        );
    let rows = page_builder
        .build()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("request_logs_query_failed: {err}"))?;
    let mut data = Vec::with_capacity(rows.len());
    for row in rows {
        let model: Option<String> = row.try_get("model").map_err(|err| err.to_string())?;
        let usage = UsageTokenScan {
            input_tokens: row
                .try_get::<i64, _>("input_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            output_tokens: row
                .try_get::<i64, _>("output_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            cache_read_tokens: row
                .try_get::<i64, _>("cache_read_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            cache_creation_tokens: row
                .try_get::<i64, _>("cache_creation_tokens")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            explicit_cost_usd: None,
        };
        let priced = calculate_usage_cost(model.as_deref(), usage);
        let file_path: String = row.try_get("file_path").map_err(|err| err.to_string())?;
        data.push(RequestLogItem {
            request_id: row.try_get("request_id").map_err(|err| err.to_string())?,
            source: row.try_get("source").map_err(|err| err.to_string())?,
            project_key: row.try_get("project_key").map_err(|err| err.to_string())?,
            session_id: row.try_get("session_id").map_err(|err| err.to_string())?,
            session_available: session_file_available(&file_path),
            file_path,
            event_index: row
                .try_get::<i64, _>("event_index")
                .map_err(|err| err.to_string())?
                .max(0) as u64,
            timestamp_ms: row.try_get("timestamp_ms").map_err(|err| err.to_string())?,
            model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            total_tokens: usage_total_tokens(usage),
            total_cost_usd: priced.total_cost_usd,
            unpriced_tokens: priced.unpriced_tokens,
            status: "recorded",
        });
    }

    Ok(RequestLogPage {
        data,
        summary,
        total,
        page,
        page_size,
    })
}

#[tauri::command]
pub async fn history_list_request_logs(
    filters: Option<RequestLogFilters>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<RequestLogPage, String> {
    let mut conn = open_cli_manager_db().await?;
    list_request_logs_with_connection(
        &mut conn,
        filters.unwrap_or_default(),
        page.unwrap_or(0),
        page_size.unwrap_or(DEFAULT_PAGE_SIZE),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    async fn test_connection() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for statement in crate::MIGRATION_CREATE_REQUEST_LOGS_SQL.split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&mut conn).await.unwrap();
            }
        }
        conn
    }

    fn write_claude_session(config: &Path, content: &str) -> std::path::PathBuf {
        let path = config
            .join("projects")
            .join("project-a")
            .join("session-a.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }

    #[tokio::test]
    async fn sync_is_idempotent_and_replaces_changed_files() {
        let temp = TempDir::new().unwrap();
        let claude = temp.path().join("claude");
        let codex = temp.path().join("codex");
        fs::create_dir_all(&codex).unwrap();
        let file = write_claude_session(
            &claude,
            concat!(
                r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-test","usage":{"input_tokens":10,"output_tokens":5}}}"#,
                "\n",
                r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-test","usage":{"input_tokens":10,"output_tokens":5}}}"#,
                "\n",
            ),
        );
        let roots = history_roots(
            Some(claude.to_string_lossy().to_string()),
            Some(codex.to_string_lossy().to_string()),
            None,
        );
        let mut conn = test_connection().await;

        let first = sync_request_logs_with_connection(&mut conn, roots.clone(), true)
            .await
            .unwrap();
        assert_eq!(first.written_rows, 1);
        let second = sync_request_logs_with_connection(&mut conn, roots.clone(), false)
            .await
            .unwrap();
        assert_eq!(second.changed_files, 0);

        fs::write(
            &file,
            r#"{"type":"assistant","requestId":"r2","message":{"id":"m2","model":"claude-test","usage":{"input_tokens":20,"output_tokens":8}}}"#,
        )
        .unwrap();
        let replaced = sync_request_logs_with_connection(&mut conn, roots.clone(), true)
            .await
            .unwrap();
        assert_eq!(replaced.written_rows, 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_logs")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 1);

        fs::remove_file(file).unwrap();
        let removed = sync_request_logs_with_connection(&mut conn, roots, true)
            .await
            .unwrap();
        assert_eq!(removed.removed_files, 1);
    }

    #[tokio::test]
    async fn list_filters_and_caps_page_size() {
        let mut conn = test_connection().await;
        sqlx::query(
            "INSERT INTO request_logs(
                request_id, source, project_key, session_id, file_path, event_key, event_index,
                timestamp_ms, model, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, created_at_ms, updated_at_ms
             ) VALUES ('r1', 'claude', 'project-a', 'session-a', 'missing.jsonl', 'e1', 0,
                1000, 'claude-test', 10, 5, 2, 1, 1000, 1000)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let page = list_request_logs_with_connection(
            &mut conn,
            RequestLogFilters {
                source: Some("claude".to_string()),
                project_key: Some("project".to_string()),
                ..RequestLogFilters::default()
            },
            0,
            500,
        )
        .await
        .unwrap();

        assert_eq!(page.total, 1);
        assert_eq!(page.page_size, MAX_PAGE_SIZE);
        assert_eq!(page.data[0].total_tokens, 18);
        assert!(!page.data[0].session_available);
    }

    #[tokio::test]
    async fn unavailable_root_does_not_purge_existing_logs() {
        let temp = TempDir::new().unwrap();
        let claude = temp.path().join("claude");
        let codex = temp.path().join("codex");
        write_claude_session(
            &claude,
            r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","model":"claude-test","usage":{"input_tokens":10,"output_tokens":5}}}"#,
        );
        let roots = history_roots(
            Some(claude.to_string_lossy().to_string()),
            Some(codex.to_string_lossy().to_string()),
            None,
        );
        let mut conn = test_connection().await;

        sync_request_logs_with_connection(&mut conn, roots.clone(), true)
            .await
            .unwrap();
        fs::remove_dir_all(&claude).unwrap();

        let result = sync_request_logs_with_connection(&mut conn, roots, true)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_logs")
            .fetch_one(&mut conn)
            .await
            .unwrap();

        assert_eq!(result.removed_files, 0);
        assert_eq!(count, 1);
    }

    #[test]
    fn wsl_session_path_remains_openable_without_native_metadata_check() {
        assert!(session_file_available(
            r"\\wsl.localhost\Ubuntu\home\me\.claude\projects\p\session.jsonl"
        ));
    }
}
