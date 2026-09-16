use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{Connection, Row};

const DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

// 项目策略与启动快照共用数据库中实际的项目/Worktree 路径。
pub(crate) async fn load(project_id: &str, worktree_id: Option<&str>) -> Result<PathBuf, String> {
    let path = crate::app_paths::db_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "extensions_scope_db_parent_create_failed".to_string())?;
    }
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(DB_BUSY_TIMEOUT),
    )
    .await
    .map_err(|_| "extensions_scope_db_open_failed".to_string())?;
    super::database::ensure_schema(&mut connection).await?;
    let path = if let Some(worktree_id) = worktree_id {
        sqlx::query("SELECT path FROM worktrees WHERE id = ?1 AND project_id = ?2")
            .bind(worktree_id)
            .bind(project_id)
            .fetch_optional(&mut connection)
            .await
            .map_err(|_| "extensions_scope_worktree_read_failed".to_string())?
            .ok_or_else(|| "extensions_scope_worktree_not_found".to_string())?
            .try_get::<String, _>("path")
            .map_err(|_| "extensions_scope_worktree_corrupt".to_string())?
    } else {
        sqlx::query("SELECT path FROM projects WHERE id = ?1")
            .bind(project_id)
            .fetch_optional(&mut connection)
            .await
            .map_err(|_| "extensions_scope_project_read_failed".to_string())?
            .ok_or_else(|| "extensions_scope_project_not_found".to_string())?
            .try_get::<String, _>("path")
            .map_err(|_| "extensions_scope_project_corrupt".to_string())?
    };
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() || path.to_string_lossy().chars().any(char::is_control) {
        return Err("extensions_scope_project_path_invalid".to_string());
    }
    Ok(path)
}
