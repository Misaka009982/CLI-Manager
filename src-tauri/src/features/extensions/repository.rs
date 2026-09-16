use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};

use super::model::{
    redact_resource, validate_resource, ExtensionCli, McpResource, McpResourceRedacted,
};

const DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(crate) struct McpResourceRecord {
    pub resource: McpResource,
    pub revision: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl McpResourceRecord {
    // 统一校验持久化元数据，供解码和后续导入/部署流程复用。
    fn metadata_is_valid(&self) -> bool {
        self.revision >= 1 && self.created_at_ms >= 0 && self.updated_at_ms >= self.created_at_ms
    }
}

// 读取主数据库中的 MCP 记录；返回前端的列表始终使用脱敏 DTO。
pub(crate) async fn list_mcp_resources() -> Result<Vec<McpResourceRedacted>, String> {
    let records = list_mcp_resource_records().await?;
    Ok(records
        .iter()
        .map(|record| redact_resource(&record.resource))
        .collect())
}

// 为导入、作用域和后续部署提供带 revision 的规范记录，不向 IPC 暴露秘密值。
pub(crate) async fn list_mcp_resource_records() -> Result<Vec<McpResourceRecord>, String> {
    let mut connection = open_database().await?;
    let rows = sqlx::query(
        "SELECT resource_id, server_key, name, definition_json, revision, created_at, updated_at
         FROM extension_mcp_resources
         ORDER BY updated_at DESC, resource_id ASC",
    )
    .fetch_all(&mut connection)
    .await
    .map_err(|error| database_error("extensions_mcp_list_failed", error))?;
    rows.into_iter().map(decode_record).collect()
}

// 按稳定 resourceId 读取单项规范资源；不存在时返回可区分的 not found 错误。
pub(crate) async fn get_mcp_resource(resource_id: &str) -> Result<McpResourceRedacted, String> {
    Ok(redact_resource(
        &get_mcp_resource_record(resource_id).await?.resource,
    ))
}

// 按稳定 resourceId 读取内部记录，供服务层复用同一校验和损坏检测。
pub(crate) async fn get_mcp_resource_record(
    resource_id: &str,
) -> Result<McpResourceRecord, String> {
    let mut connection = open_database().await?;
    let row = sqlx::query(
        "SELECT resource_id, server_key, name, definition_json, revision, created_at, updated_at
         FROM extension_mcp_resources
         WHERE resource_id = ?1",
    )
    .bind(resource_id)
    .fetch_optional(&mut connection)
    .await
    .map_err(|error| database_error("extensions_mcp_get_failed", error))?
    .ok_or_else(|| "extensions_mcp_not_found".to_string())?;
    decode_record(row)
}

// 以短 BEGIN IMMEDIATE 事务保存完整规范 JSON，避免并发读改写覆盖并递增 revision。
pub(crate) async fn upsert_mcp_resource(
    mut resource: McpResource,
) -> Result<McpResourceRedacted, String> {
    let mut connection = open_database().await?;
    begin_immediate(&mut connection).await?;
    let result = async {
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT definition_json FROM extension_mcp_resources WHERE resource_id = ?",
        )
        .bind(&resource.resource_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(|error| database_error("extensions_mcp_get_failed", error))?;
        if let Some(existing) = existing {
            let original: McpResource =
                serde_json::from_str(&existing).map_err(|_| "extensions_storage_corrupt")?;
            resource = super::editing::preserve_secrets(resource.clone(), &original)?;
        }
        let issues = validate_resource(&resource);
        if !issues.is_empty() {
            return Err(format!("extensions_invalid_resource:{}", issues[0].code));
        }
        let definition_json = serde_json::to_string(&resource)
            .map_err(|_| "extensions_definition_serialize_failed")?;
        upsert_mcp_resource_in_transaction(&mut connection, &resource, &definition_json).await
    }
    .await;
    match result {
        Ok(()) => match commit(&mut connection).await {
            Ok(()) => Ok(redact_resource(&resource)),
            Err(error) => {
                rollback(&mut connection).await;
                Err(error)
            }
        },
        Err(error) => {
            rollback(&mut connection).await;
            Err(error)
        }
    }
}

// 只更新目标 CLI 的开关并保留数据库中的秘密字段，避免前端脱敏 DTO 覆盖完整 canonical 记录。
pub(crate) async fn set_mcp_resource_enabled(
    resource_id: &str,
    cli: ExtensionCli,
    enabled: bool,
) -> Result<McpResourceRedacted, String> {
    let mut connection = open_database().await?;
    begin_immediate(&mut connection).await?;
    let result = async {
        let row = sqlx::query(
            "SELECT resource_id, server_key, name, definition_json, revision, created_at, updated_at
             FROM extension_mcp_resources
             WHERE resource_id = ?1",
        )
        .bind(resource_id)
        .fetch_optional(&mut connection)
        .await
        .map_err(|error| database_error("extensions_mcp_get_failed", error))?
        .ok_or_else(|| "extensions_mcp_not_found".to_string())?;
        let mut resource = decode_record(row)?.resource;
        resource
            .enabled_by_cli
            .insert(cli.key().to_string(), enabled);
        let issues = validate_resource(&resource);
        if !issues.is_empty() {
            return Err("extensions_storage_corrupt".to_string());
        }
        let definition_json = serde_json::to_string(&resource)
            .map_err(|_| "extensions_definition_serialize_failed".to_string())?;
        upsert_mcp_resource_in_transaction(&mut connection, &resource, &definition_json).await?;
        Ok::<McpResourceRedacted, String>(redact_resource(&resource))
    }
    .await;
    match result {
        Ok(resource) => match commit(&mut connection).await {
            Ok(()) => Ok(resource),
            Err(error) => {
                rollback(&mut connection).await;
                Err(error)
            }
        },
        Err(error) => {
            rollback(&mut connection).await;
            Err(error)
        }
    }
}

// 在已持有写锁的事务内检查 ID/serverKey 冲突并执行插入或更新。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpSelectionItem {
    resource_id: String,
    enabled_by_cli: std::collections::BTreeMap<String, bool>,
}

// 一次显式操作的显示基线原子入库：只更新布尔开关，保留秘密；失败整批回滚。
pub(crate) async fn set_mcp_selection(
    items: Vec<McpSelectionItem>,
    home_identity: String,
) -> Result<Vec<McpResourceRedacted>, String> {
    if items.len() > 5000 {
        return Err("extensions_selection_too_large".into());
    }
    let mut connection = open_database().await?;
    begin_immediate(&mut connection).await?;
    let result = async {
        let updated = apply_mcp_selection_in_transaction(&mut connection, items).await?;
        if crate::provider::home::active()?.identity.identity != home_identity {
            return Err("extensions_native_preview_changed".into());
        }
        commit(&mut connection).await?;
        Ok(updated)
    }
    .await;
    if result.is_err() {
        rollback(&mut connection).await;
    }
    result
}

// 调用者必须已持有写事务，失败由外层统一回滚，便于验证真实 SQL 的原子性。
async fn apply_mcp_selection_in_transaction(
    connection: &mut SqliteConnection,
    items: Vec<McpSelectionItem>,
) -> Result<Vec<McpResourceRedacted>, String> {
    let mut updated = Vec::new();
    for item in items {
        if item
            .enabled_by_cli
            .keys()
            .any(|key| !["claude", "codex", "grok"].contains(&key.as_str()))
        {
            return Err("extensions_selection_invalid".to_string());
        }
        let json: String = sqlx::query_scalar(
            "SELECT definition_json FROM extension_mcp_resources WHERE resource_id = ?",
        )
        .bind(&item.resource_id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| database_error("extensions_mcp_get_failed", error))?
        .ok_or("extensions_mcp_not_found")?;
        let mut resource: McpResource =
            serde_json::from_str(&json).map_err(|_| "extensions_storage_corrupt")?;
        resource.enabled_by_cli.extend(item.enabled_by_cli);
        if !validate_resource(&resource).is_empty() {
            return Err("extensions_storage_corrupt".into());
        }
        let json = serde_json::to_string(&resource)
            .map_err(|_| "extensions_definition_serialize_failed")?;
        upsert_mcp_resource_in_transaction(&mut *connection, &resource, &json).await?;
        updated.push(redact_resource(&resource));
    }
    Ok(updated)
}

// 在已持有写锁的事务内检查 ID/serverKey 冲突并执行插入或更新。
async fn upsert_mcp_resource_in_transaction(
    connection: &mut SqliteConnection,
    resource: &McpResource,
    definition_json: &str,
) -> Result<(), String> {
    let owner = sqlx::query_scalar::<_, String>(
        "SELECT resource_id
         FROM extension_mcp_resources
         WHERE server_key = ?1
         LIMIT 1",
    )
    .bind(&resource.server_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| database_error("extensions_mcp_conflict_check_failed", error))?;
    if owner
        .as_deref()
        .is_some_and(|owner| owner != resource.resource_id)
    {
        return Err("extensions_mcp_server_key_conflict".to_string());
    }

    let now = now_ms();
    let existing = sqlx::query(
        "SELECT revision
         FROM extension_mcp_resources
         WHERE resource_id = ?1",
    )
    .bind(&resource.resource_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| database_error("extensions_mcp_revision_read_failed", error))?;
    if let Some(row) = existing {
        let revision: i64 = row
            .try_get("revision")
            .map_err(|_| "extensions_mcp_revision_read_failed".to_string())?;
        if revision < 1 {
            return Err("extensions_storage_corrupt".to_string());
        }
        let next_revision = revision
            .checked_add(1)
            .ok_or_else(|| "extensions_mcp_revision_exhausted".to_string())?;
        sqlx::query(
            "UPDATE extension_mcp_resources
             SET server_key = ?1, name = ?2, definition_json = ?3,
                 source_kind = ?4, source_identity = ?5, revision = ?6,
                 updated_at = ?7
             WHERE resource_id = ?8",
        )
        .bind(&resource.server_key)
        .bind(&resource.name)
        .bind(definition_json)
        .bind(
            resource
                .source
                .as_ref()
                .map(|source| source.kind.as_str())
                .unwrap_or(""),
        )
        .bind(
            resource
                .source
                .as_ref()
                .map(|source| source.identity.as_str())
                .unwrap_or(""),
        )
        .bind(next_revision)
        .bind(now)
        .bind(&resource.resource_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| database_error("extensions_mcp_update_failed", error))?;
    } else {
        sqlx::query(
            "INSERT INTO extension_mcp_resources
             (resource_id, server_key, name, definition_json, source_kind,
              source_identity, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)",
        )
        .bind(&resource.resource_id)
        .bind(&resource.server_key)
        .bind(&resource.name)
        .bind(definition_json)
        .bind(
            resource
                .source
                .as_ref()
                .map(|source| source.kind.as_str())
                .unwrap_or(""),
        )
        .bind(
            resource
                .source
                .as_ref()
                .map(|source| source.identity.as_str())
                .unwrap_or(""),
        )
        .bind(now)
        .execute(&mut *connection)
        .await
        .map_err(|error| database_error("extensions_mcp_insert_failed", error))?;
    }
    Ok(())
}

// 删除单项受管 MCP 记录；只影响应用数据中的规范表，不触碰 CLI 原生配置文件。
pub(crate) async fn delete_mcp_resource(resource_id: &str) -> Result<(), String> {
    let mut connection = open_database().await?;
    begin_immediate(&mut connection).await?;
    let result = sqlx::query("DELETE FROM extension_mcp_resources WHERE resource_id = ?1")
        .bind(resource_id)
        .execute(&mut connection)
        .await
        .map_err(|error| database_error("extensions_mcp_delete_failed", error));
    match result {
        Ok(result) if result.rows_affected() == 1 => match commit(&mut connection).await {
            Ok(()) => Ok(()),
            Err(error) => {
                rollback(&mut connection).await;
                Err(error)
            }
        },
        Ok(_) => {
            rollback(&mut connection).await;
            Err("extensions_mcp_not_found".to_string())
        }
        Err(error) => {
            rollback(&mut connection).await;
            Err(error)
        }
    }
}

// 按当前应用数据根打开主 SQLite，并设置创建、外键和有界忙等待选项。
async fn open_database() -> Result<SqliteConnection, String> {
    let path = crate::app_paths::db_path()?;
    ensure_database_parent(&path)?;
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(DB_BUSY_TIMEOUT);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| database_error("extensions_db_open_failed", error))?;
    super::database::ensure_schema(&mut connection).await?;
    Ok(connection)
}

// 主数据库通常已由启动阶段创建；此处只确保命令单独调用时父目录存在。
fn ensure_database_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "extensions_db_parent_create_failed".to_string())?;
    }
    Ok(())
}

// 解码 SQLx 记录并再次校验，避免损坏的规范 JSON 被继续投影或部署。
fn decode_record(row: sqlx::sqlite::SqliteRow) -> Result<McpResourceRecord, String> {
    let stored_resource_id: String = row
        .try_get("resource_id")
        .map_err(|_| "extensions_storage_corrupt".to_string())?;
    let stored_server_key: String = row
        .try_get("server_key")
        .map_err(|_| "extensions_storage_corrupt".to_string())?;
    let stored_name: String = row
        .try_get("name")
        .map_err(|_| "extensions_storage_corrupt".to_string())?;
    let definition_json: String = row
        .try_get("definition_json")
        .map_err(|_| "extensions_storage_corrupt".to_string())?;
    let resource: McpResource = serde_json::from_str(&definition_json)
        .map_err(|_| "extensions_storage_corrupt".to_string())?;
    if stored_resource_id != resource.resource_id
        || stored_server_key != resource.server_key
        || stored_name != resource.name
        || !validate_resource(&resource).is_empty()
    {
        return Err("extensions_storage_corrupt".to_string());
    }
    let revision: i64 = row
        .try_get("revision")
        .map_err(|_| "extensions_storage_corrupt".to_string())?;
    let created_at_ms: i64 = row
        .try_get("created_at")
        .map_err(|_| "extensions_storage_corrupt".to_string())?;
    let updated_at_ms: i64 = row
        .try_get("updated_at")
        .map_err(|_| "extensions_storage_corrupt".to_string())?;
    let record = McpResourceRecord {
        resource,
        revision,
        created_at_ms,
        updated_at_ms,
    };
    if !record.metadata_is_valid() {
        return Err("extensions_storage_corrupt".to_string());
    }
    Ok(record)
}

// 获取 UNIX 毫秒时间戳；系统时钟异常时使用零，保证写入字段仍为确定整数。
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

// 显式抢占短写锁，让共享主数据库的竞争返回稳定的本地持久化错误。
async fn begin_immediate(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("BEGIN IMMEDIATE")
        .execute(connection)
        .await
        .map(|_| ())
        .map_err(|error| database_error("extensions_db_busy", error))
}

// 提交规范记录变更；提交失败不再尝试伪造成功结果。
async fn commit(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("COMMIT")
        .execute(connection)
        .await
        .map(|_| ())
        .map_err(|error| database_error("extensions_db_commit_failed", error))
}

// 尽力回滚失败事务，调用方继续返回原始业务错误。
async fn rollback(connection: &mut SqliteConnection) {
    let _ = sqlx::query("ROLLBACK").execute(connection).await;
}

// 将 SQLx 错误收敛为不含数据库路径、配置正文或秘密值的稳定错误码。
fn database_error(prefix: &str, error: sqlx::Error) -> String {
    let text = error.to_string().to_ascii_lowercase();
    if text.contains("database is locked") || text.contains("busy") {
        "extensions_db_busy".to_string()
    } else {
        prefix.to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::extensions::model::{derive_resource_id, McpTransport};

    static NEXT_TEST_DATABASE: AtomicU64 = AtomicU64::new(0);

    #[tokio::test]
    async fn selection_preserves_secrets_and_rolls_back_the_entire_batch() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        create_test_schema(&mut connection).await;
        let mut resource = test_resource("demo", "Demo");
        resource.env.insert("TOKEN".into(), "secret-value".into());
        resource.enabled_by_cli.insert("codex".into(), true);
        let original = serde_json::to_string(&resource).unwrap();
        upsert_mcp_resource_in_transaction(&mut connection, &resource, &original)
            .await
            .unwrap();
        let selection = || McpSelectionItem {
            resource_id: resource.resource_id.clone(),
            enabled_by_cli: BTreeMap::from([("claude".into(), false)]),
        };
        begin_immediate(&mut connection).await.unwrap();
        let result = apply_mcp_selection_in_transaction(
            &mut connection,
            vec![
                selection(),
                McpSelectionItem {
                    resource_id: "missing".into(),
                    enabled_by_cli: BTreeMap::new(),
                },
            ],
        )
        .await;
        assert!(result.is_err());
        rollback(&mut connection).await;
        let after: String =
            sqlx::query_scalar("SELECT definition_json FROM extension_mcp_resources")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(after, original);
        begin_immediate(&mut connection).await.unwrap();
        let result = apply_mcp_selection_in_transaction(&mut connection, vec![selection()])
            .await
            .unwrap();
        commit(&mut connection).await.unwrap();
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("secret-value"));
        let after: String =
            sqlx::query_scalar("SELECT definition_json FROM extension_mcp_resources")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let stored: McpResource = serde_json::from_str(&after).unwrap();
        assert_eq!(stored.env["TOKEN"], "secret-value");
        assert_eq!(stored.enabled_by_cli["claude"], false);
        assert_eq!(stored.enabled_by_cli["codex"], true);
    }

    // 构造不含秘密字段的最小合法 stdio 资源，供仓储事务测试复用。
    fn test_resource(server_key: &str, name: &str) -> McpResource {
        McpResource {
            schema_version: super::super::model::MCP_MODEL_SCHEMA_VERSION,
            resource_id: derive_resource_id(server_key),
            server_key: server_key.to_string(),
            name: name.to_string(),
            transport: McpTransport::Stdio,
            command: Some("node".to_string()),
            args: vec!["server.js".to_string()],
            cwd: None,
            url: None,
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            secret_refs: BTreeMap::new(),
            timeout: None,
            per_cli_extensions: BTreeMap::new(),
            enabled_by_cli: BTreeMap::new(),
            source: None,
            extra: BTreeMap::new(),
        }
    }

    // 使用共享文件数据库验证不同连接之间的 SQLite 写锁行为。
    async fn connect_test_database(path: &Path) -> SqliteConnection {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(2));
        SqliteConnection::connect_with(&options).await.unwrap()
    }

    // 建立与生产迁移相同字段的最小表结构，测试只关注仓储事务。
    async fn create_test_schema(connection: &mut SqliteConnection) {
        sqlx::query(
            "CREATE TABLE extension_mcp_resources (
                resource_id TEXT PRIMARY KEY NOT NULL,
                server_key TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                definition_json TEXT NOT NULL,
                source_kind TEXT NOT NULL DEFAULT '',
                source_identity TEXT NOT NULL DEFAULT '',
                revision INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&mut *connection)
        .await
        .unwrap();
    }

    // 在给定连接上执行完整的锁定、写入、提交/回滚流程。
    async fn upsert_on_connection(
        mut connection: SqliteConnection,
        resource: McpResource,
    ) -> Result<(), String> {
        let definition_json = serde_json::to_string(&resource).unwrap();
        begin_immediate(&mut connection).await?;
        match upsert_mcp_resource_in_transaction(&mut connection, &resource, &definition_json).await
        {
            Ok(()) => match commit(&mut connection).await {
                Ok(()) => Ok(()),
                Err(error) => {
                    rollback(&mut connection).await;
                    Err(error)
                }
            },
            Err(error) => {
                rollback(&mut connection).await;
                Err(error)
            }
        }
    }

    // 为每个测试分配独立临时文件，避免并行测试共享旧数据库。
    fn test_database_path() -> PathBuf {
        let sequence = NEXT_TEST_DATABASE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "cli-manager-extension-repository-{}-{sequence}.db",
            std::process::id()
        ))
    }

    #[tokio::test]
    // 验证共享 SQLite 写锁让两个并发保存串行递增 revision，而不是互相覆盖。
    async fn concurrent_upserts_increment_revision() {
        let path = test_database_path();
        let _ = std::fs::remove_file(&path);
        let mut setup = connect_test_database(&path).await;
        create_test_schema(&mut setup).await;
        drop(setup);

        let first = connect_test_database(&path).await;
        let second = connect_test_database(&path).await;
        let resource = test_resource("shared", "first");
        let (first_result, second_result) = tokio::join!(
            upsert_on_connection(first, resource.clone()),
            upsert_on_connection(second, resource),
        );
        assert!(first_result.is_ok(), "first upsert: {first_result:?}");
        assert!(second_result.is_ok(), "second upsert: {second_result:?}");

        let mut reader = connect_test_database(&path).await;
        let revision: i64 = sqlx::query_scalar(
            "SELECT revision FROM extension_mcp_resources WHERE server_key = 'shared'",
        )
        .fetch_one(&mut reader)
        .await
        .unwrap();
        assert_eq!(revision, 2);
        drop(reader);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    // 验证 serverKey 冲突会回滚事务，之后的合法写入仍可继续执行。
    async fn server_key_conflict_rolls_back_transaction() {
        let path = test_database_path();
        let _ = std::fs::remove_file(&path);
        let mut connection = connect_test_database(&path).await;
        create_test_schema(&mut connection).await;
        let first = test_resource("shared", "first");
        let definition_json = serde_json::to_string(&first).unwrap();
        begin_immediate(&mut connection).await.unwrap();
        upsert_mcp_resource_in_transaction(&mut connection, &first, &definition_json)
            .await
            .unwrap();
        commit(&mut connection).await.unwrap();

        let mut conflicting = test_resource("shared", "conflicting");
        conflicting.resource_id = derive_resource_id("different-resource");
        let conflicting_json = serde_json::to_string(&conflicting).unwrap();
        begin_immediate(&mut connection).await.unwrap();
        let error =
            upsert_mcp_resource_in_transaction(&mut connection, &conflicting, &conflicting_json)
                .await
                .unwrap_err();
        assert_eq!(error, "extensions_mcp_server_key_conflict");
        rollback(&mut connection).await;

        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM extension_mcp_resources WHERE server_key = 'shared'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(count, 1);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }
}
