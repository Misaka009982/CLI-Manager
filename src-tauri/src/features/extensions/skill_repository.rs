use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteRow};
use sqlx::{Connection, Row};

use super::model::ExtensionCli;

const DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The durable identity of one immutable Skill package stored below the app data root.
#[derive(Clone)]
pub(crate) struct SkillPackageRecord {
    pub package_id: String,
    pub name: String,
    pub description: String,
    pub source_kind: String,
    pub source_identity: String,
    pub source_ref: String,
    pub resolved_commit: Option<String>,
    pub subdirectory: String,
    pub content_hash: String,
    pub version: Option<String>,
    pub package_path: PathBuf,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// The durable state needed to decide whether a deployed target is still owned by us.
#[derive(Clone)]
pub(crate) struct SkillInstallationRecord {
    pub installation_id: String,
    pub package_id: String,
    pub environment_kind: String,
    pub environment_id: String,
    pub cli: ExtensionCli,
    pub home_path: PathBuf,
    pub target_path: PathBuf,
    pub requested_mode: String,
    pub actual_mode: String,
    pub link_target: Option<PathBuf>,
    pub deployed_hash: String,
    pub owned: bool,
    pub external_modified: bool,
    pub backup_path: Option<PathBuf>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

// 读取当前应用数据根的主库，保持 Skill 元数据与 MCP 规范记录共用同一数据库。
async fn open_database() -> Result<SqliteConnection, String> {
    let path = crate::app_paths::db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "extensions_skill_db_parent_create_failed".to_string())?;
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(DB_BUSY_TIMEOUT);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "extensions_skill_db_open_failed".to_string())?;
    super::database::ensure_schema(&mut connection).await?;
    Ok(connection)
}

// 读取全部受管包，排序与前端列表稳定一致；源路径只作为受管元数据返回，不读取包正文。
pub(crate) async fn list_packages() -> Result<Vec<SkillPackageRecord>, String> {
    let mut connection = open_database().await?;
    let rows = sqlx::query(
        "SELECT package_id, name, description, source_kind, source_identity,
                source_ref, resolved_commit, subdirectory, content_hash, version,
                package_path, created_at, updated_at
         FROM extension_skill_packages
         ORDER BY name ASC, package_id ASC",
    )
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "extensions_skill_list_packages_failed".to_string())?;
    rows.into_iter().map(decode_package).collect()
}

// 按包 ID 读取完整包元数据；调用方随后必须再次验证 package_path 的受管边界。
pub(crate) async fn get_package(package_id: &str) -> Result<SkillPackageRecord, String> {
    let mut connection = open_database().await?;
    let row = sqlx::query(
        "SELECT package_id, name, description, source_kind, source_identity,
                source_ref, resolved_commit, subdirectory, content_hash, version,
                package_path, created_at, updated_at
         FROM extension_skill_packages WHERE package_id = ?1",
    )
    .bind(package_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "extensions_skill_get_package_failed".to_string())?
    .ok_or_else(|| "extensions_skill_package_not_found".to_string())?;
    decode_package(row)
}

// 以来源身份、子目录和内容摘要查找重复包；名称不参与身份判断。
pub(crate) async fn find_package_by_identity_hash(
    source_kind: &str,
    source_identity: &str,
    subdirectory: &str,
    content_hash: &str,
) -> Result<Option<SkillPackageRecord>, String> {
    let mut connection = open_database().await?;
    let row = sqlx::query(
        "SELECT package_id, name, description, source_kind, source_identity,
                source_ref, resolved_commit, subdirectory, content_hash, version,
                package_path, created_at, updated_at
         FROM extension_skill_packages
         WHERE source_kind = ?1 AND source_identity = ?2
           AND subdirectory = ?3 AND content_hash = ?4
         LIMIT 1",
    )
    .bind(source_kind)
    .bind(source_identity)
    .bind(subdirectory)
    .bind(content_hash)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "extensions_skill_duplicate_check_failed".to_string())?;
    row.map(decode_package).transpose()
}

// 发布后写入包元数据；同一来源与哈希重复时只更新可读元数据，不生成第二份包。
pub(crate) async fn upsert_package(record: &SkillPackageRecord) -> Result<(), String> {
    let mut connection = open_database().await?;
    begin_immediate(&mut connection).await?;
    let result = sqlx::query(
        "INSERT INTO extension_skill_packages
         (package_id, name, description, source_kind, source_identity, source_ref,
          resolved_commit, subdirectory, content_hash, version, package_path,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(source_kind, source_identity, subdirectory, content_hash)
         DO UPDATE SET name = excluded.name, description = excluded.description,
           source_ref = excluded.source_ref, resolved_commit = excluded.resolved_commit,
           version = excluded.version, package_path = excluded.package_path,
           updated_at = excluded.updated_at",
    )
    .bind(&record.package_id)
    .bind(&record.name)
    .bind(&record.description)
    .bind(&record.source_kind)
    .bind(&record.source_identity)
    .bind(&record.source_ref)
    .bind(&record.resolved_commit)
    .bind(&record.subdirectory)
    .bind(&record.content_hash)
    .bind(&record.version)
    .bind(record.package_path.to_string_lossy().as_ref())
    .bind(record.created_at_ms)
    .bind(record.updated_at_ms)
    .execute(&mut connection)
    .await
    .map(|_| ())
    .map_err(|_| "extensions_skill_package_write_failed".to_string());
    finish_transaction(&mut connection, result).await
}

// 读取全部部署实例；安装记录排序后供全局页和项目页复用。
pub(crate) async fn list_installations() -> Result<Vec<SkillInstallationRecord>, String> {
    let mut connection = open_database().await?;
    let rows = sqlx::query(
        "SELECT installation_id, package_id, environment_kind, environment_id, cli,
                home_path, target_path, requested_mode, actual_mode, link_target,
                deployed_hash, owned, external_modified, backup_path, created_at, updated_at
         FROM extension_skill_installations
         ORDER BY environment_kind ASC, environment_id ASC, cli ASC, target_path ASC",
    )
    .fetch_all(&mut connection)
    .await
    .map_err(|_| "extensions_skill_list_installations_failed".to_string())?;
    rows.into_iter().map(decode_installation).collect()
}

// 按安装 ID读取实例，用于外部修改检测、卸载与恢复。
pub(crate) async fn get_installation(
    installation_id: &str,
) -> Result<SkillInstallationRecord, String> {
    let mut connection = open_database().await?;
    let row = sqlx::query(
        "SELECT installation_id, package_id, environment_kind, environment_id, cli,
                home_path, target_path, requested_mode, actual_mode, link_target,
                deployed_hash, owned, external_modified, backup_path, created_at, updated_at
         FROM extension_skill_installations WHERE installation_id = ?1",
    )
    .bind(installation_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "extensions_skill_get_installation_failed".to_string())?
    .ok_or_else(|| "extensions_skill_installation_not_found".to_string())?;
    decode_installation(row)
}

// 按目标位置读取现有安装，避免同一 CLI/环境/目标产生多条互相覆盖的记录。
pub(crate) async fn get_installation_for_target(
    environment_kind: &str,
    environment_id: &str,
    cli: ExtensionCli,
    target_path: &Path,
) -> Result<Option<SkillInstallationRecord>, String> {
    let mut connection = open_database().await?;
    let query = if cfg!(target_os = "windows") {
        "SELECT installation_id, package_id, environment_kind, environment_id, cli,
                home_path, target_path, requested_mode, actual_mode, link_target,
                deployed_hash, owned, external_modified, backup_path, created_at, updated_at
         FROM extension_skill_installations
         WHERE environment_kind = ?1 AND environment_id = ?2 AND cli = ?3
           AND LOWER(target_path) = LOWER(?4) LIMIT 1"
    } else {
        "SELECT installation_id, package_id, environment_kind, environment_id, cli,
                home_path, target_path, requested_mode, actual_mode, link_target,
                deployed_hash, owned, external_modified, backup_path, created_at, updated_at
         FROM extension_skill_installations
         WHERE environment_kind = ?1 AND environment_id = ?2 AND cli = ?3
           AND target_path = ?4 LIMIT 1"
    };
    let row = sqlx::query(query)
        .bind(environment_kind)
        .bind(environment_id)
        .bind(cli.key())
        .bind(target_path.to_string_lossy().as_ref())
        .fetch_optional(&mut connection)
        .await
        .map_err(|_| "extensions_skill_target_lookup_failed".to_string())?;
    row.map(decode_installation).transpose()
}

// 保存部署实例并保留首次创建时间；目标唯一约束使并发部署不能产生重复所有权记录。
pub(crate) async fn upsert_installation(record: &SkillInstallationRecord) -> Result<(), String> {
    let mut connection = open_database().await?;
    begin_immediate(&mut connection).await?;
    let result = sqlx::query(
        "INSERT INTO extension_skill_installations
         (installation_id, package_id, environment_kind, environment_id, cli, home_path,
          target_path, requested_mode, actual_mode, link_target, deployed_hash, owned,
          external_modified, backup_path, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(environment_kind, environment_id, cli, target_path)
         DO UPDATE SET installation_id = excluded.installation_id,
           package_id = excluded.package_id, home_path = excluded.home_path,
           requested_mode = excluded.requested_mode, actual_mode = excluded.actual_mode,
           link_target = excluded.link_target, deployed_hash = excluded.deployed_hash,
           owned = excluded.owned, external_modified = excluded.external_modified,
           backup_path = excluded.backup_path, updated_at = excluded.updated_at",
    )
    .bind(&record.installation_id)
    .bind(&record.package_id)
    .bind(&record.environment_kind)
    .bind(&record.environment_id)
    .bind(record.cli.key())
    .bind(record.home_path.to_string_lossy().as_ref())
    .bind(record.target_path.to_string_lossy().as_ref())
    .bind(&record.requested_mode)
    .bind(&record.actual_mode)
    .bind(
        record
            .link_target
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
    )
    .bind(&record.deployed_hash)
    .bind(if record.owned { 1 } else { 0 })
    .bind(if record.external_modified { 1 } else { 0 })
    .bind(
        record
            .backup_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
    )
    .bind(record.created_at_ms)
    .bind(record.updated_at_ms)
    .execute(&mut connection)
    .await
    .map(|_| ())
    .map_err(|_| "extensions_skill_installation_write_failed".to_string());
    finish_transaction(&mut connection, result).await
}

// 仅删除数据库安装记录，调用方必须先完成并验证目标文件的安全清理。
pub(crate) async fn delete_installation(installation_id: &str) -> Result<(), String> {
    let mut connection = open_database().await?;
    begin_immediate(&mut connection).await?;
    let result =
        sqlx::query("DELETE FROM extension_skill_installations WHERE installation_id = ?1")
            .bind(installation_id)
            .execute(&mut connection)
            .await
            .map_err(|_| "extensions_skill_installation_delete_failed".to_string())
            .and_then(|result| {
                if result.rows_affected() == 1 {
                    Ok(())
                } else {
                    Err("extensions_skill_installation_not_found".to_string())
                }
            });
    finish_transaction(&mut connection, result).await
}

// 更新外部修改标记而不改变部署所有权与哈希，列表刷新可以记录当前文件状态。
pub(crate) async fn mark_external_modified(
    installation_id: &str,
    external_modified: bool,
) -> Result<(), String> {
    let mut connection = open_database().await?;
    begin_immediate(&mut connection).await?;
    let result = sqlx::query(
        "UPDATE extension_skill_installations
         SET external_modified = ?1, updated_at = ?2 WHERE installation_id = ?3",
    )
    .bind(if external_modified { 1 } else { 0 })
    .bind(now_ms())
    .bind(installation_id)
    .execute(&mut connection)
    .await
    .map(|result| {
        if result.rows_affected() == 1 {
            Ok(())
        } else {
            Err("extensions_skill_installation_not_found".to_string())
        }
    })
    .map_err(|_| "extensions_skill_installation_update_failed".to_string())
    .and_then(|value| value);
    finish_transaction(&mut connection, result).await
}

// 在短事务中完成提交或回滚；文件系统发布失败不会写入孤立的成功记录。
async fn finish_transaction(
    connection: &mut SqliteConnection,
    result: Result<(), String>,
) -> Result<(), String> {
    match result {
        Ok(()) => match commit(connection).await {
            Ok(()) => Ok(()),
            Err(error) => {
                rollback(connection).await;
                Err(error)
            }
        },
        Err(error) => {
            rollback(connection).await;
            Err(error)
        }
    }
}

// 提交已经完成的 Skill 元数据事务，调用方不会把提交失败误报为成功。
async fn commit(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("COMMIT")
        .execute(connection)
        .await
        .map(|_| ())
        .map_err(|_| "extensions_skill_db_commit_failed".to_string())
}

// 尽力回滚失败事务，避免后续连接继续处于写事务状态。
async fn rollback(connection: &mut SqliteConnection) {
    let _ = sqlx::query("ROLLBACK").execute(connection).await;
}

// 显式抢占 SQLite 写锁，短超时返回稳定错误而不把原始数据库错误回传 IPC。
async fn begin_immediate(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("BEGIN IMMEDIATE")
        .execute(connection)
        .await
        .map(|_| ())
        .map_err(|_| "extensions_skill_db_busy".to_string())
}

// 将数据库包行解码为内部记录；路径字符串不在这里执行文件系统访问。
fn decode_package(row: SqliteRow) -> Result<SkillPackageRecord, String> {
    Ok(SkillPackageRecord {
        package_id: row
            .try_get("package_id")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        name: row
            .try_get("name")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        description: row
            .try_get("description")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        source_kind: row
            .try_get("source_kind")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        source_identity: row
            .try_get("source_identity")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        source_ref: row
            .try_get("source_ref")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        resolved_commit: row
            .try_get("resolved_commit")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        subdirectory: row
            .try_get("subdirectory")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        content_hash: row
            .try_get("content_hash")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        version: row
            .try_get("version")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        package_path: PathBuf::from(
            row.try_get::<String, _>("package_path")
                .map_err(|_| "extensions_storage_corrupt".to_string())?,
        ),
        created_at_ms: row
            .try_get("created_at")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        updated_at_ms: row
            .try_get("updated_at")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
    })
}

// 将数据库安装行解码并校验 CLI/布尔字段，阻止非法记录流入删除和恢复流程。
fn decode_installation(row: SqliteRow) -> Result<SkillInstallationRecord, String> {
    let cli = ExtensionCli::parse(
        row.try_get::<String, _>("cli")
            .map_err(|_| "extensions_storage_corrupt".to_string())?
            .as_str(),
    )
    .ok_or_else(|| "extensions_storage_corrupt".to_string())?;
    let owned = decode_bool(&row, "owned")?;
    let external_modified = decode_bool(&row, "external_modified")?;
    Ok(SkillInstallationRecord {
        installation_id: row
            .try_get("installation_id")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        package_id: row
            .try_get("package_id")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        environment_kind: row
            .try_get("environment_kind")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        environment_id: row
            .try_get("environment_id")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        cli,
        home_path: PathBuf::from(
            row.try_get::<String, _>("home_path")
                .map_err(|_| "extensions_storage_corrupt".to_string())?,
        ),
        target_path: PathBuf::from(
            row.try_get::<String, _>("target_path")
                .map_err(|_| "extensions_storage_corrupt".to_string())?,
        ),
        requested_mode: row
            .try_get("requested_mode")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        actual_mode: row
            .try_get("actual_mode")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        link_target: row
            .try_get::<Option<String>, _>("link_target")
            .map_err(|_| "extensions_storage_corrupt".to_string())?
            .map(PathBuf::from),
        deployed_hash: row
            .try_get("deployed_hash")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        owned,
        external_modified,
        backup_path: row
            .try_get::<Option<String>, _>("backup_path")
            .map_err(|_| "extensions_storage_corrupt".to_string())?
            .map(PathBuf::from),
        created_at_ms: row
            .try_get("created_at")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
        updated_at_ms: row
            .try_get("updated_at")
            .map_err(|_| "extensions_storage_corrupt".to_string())?,
    })
}

// SQLite 布尔列只接受 0/1，避免任意整数被当作有效所有权。
fn decode_bool(row: &SqliteRow, column: &str) -> Result<bool, String> {
    match row
        .try_get::<i64, _>(column)
        .map_err(|_| "extensions_storage_corrupt".to_string())?
    {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err("extensions_storage_corrupt".to_string()),
    }
}

// 返回可持久化的 UNIX 毫秒时间，系统时钟异常时使用零。
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}
