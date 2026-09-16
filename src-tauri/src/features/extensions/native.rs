use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    adapters,
    model::{ExtensionCli, McpConfigFormat, McpResource},
    repository,
};
use crate::provider::{global, home};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePreview {
    cli: ExtensionCli,
    format: McpConfigFormat,
    path: String,
    fingerprint: String,
    existing_keys: Vec<String>,
    enabled_keys: Vec<String>,
    removed_keys: Vec<String>,
    changed: bool,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeApplyResult {
    pub path: String,
    pub backup_path: Option<String>,
    pub changed: bool,
}

struct Plan {
    view: NativePreview,
    before: Option<Vec<u8>>,
    desired: Vec<u8>,
    ledger: PathBuf,
    managed_keys: BTreeSet<String>,
    home_identity: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeStatus {
    home_identity: String,
    enabled_keys: Vec<String>,
}

// 仅读取实际文件，不依赖受管投影是否成功，不将磁盘差异转为用户编辑。
pub(crate) fn status(cli: ExtensionCli) -> Result<NativeStatus, String> {
    let home = home::active()?;
    let path = target_path(&home, cli);
    let bytes = global::read_live(&path)?.unwrap_or_else(|| {
        if cli == ExtensionCli::Claude {
            b"{}".to_vec()
        } else {
            Vec::new()
        }
    });
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("extensions_native_config_too_large".into());
    }
    let base = std::str::from_utf8(&bytes).map_err(|_| "extensions_native_encoding_invalid")?;
    Ok(NativeStatus {
        home_identity: home.identity.identity,
        enabled_keys: active_keys(cli, base)?,
    })
}

// 原生 enabled/disabled 标记独立于 canonical enabledByCli，不能默认全部为 true。
fn active_keys(cli: ExtensionCli, base: &str) -> Result<Vec<String>, String> {
    let root: serde_json::Value = if cli == ExtensionCli::Claude {
        serde_json::from_str(base).map_err(|_| "extensions_invalid_claude_json")?
    } else {
        let parsed: toml::Value = toml::from_str(base).map_err(|_| "extensions_invalid_toml")?;
        serde_json::to_value(parsed).map_err(|_| "extensions_invalid_toml")?
    };
    let root_key = if cli == ExtensionCli::Claude {
        "mcpServers"
    } else {
        "mcp_servers"
    };
    let disabled = root
        .get("disabledMcpServers")
        .or_else(|| root.get("disabled_mcp_servers"))
        .and_then(|v| v.as_array());
    let Some(servers) = root.get(root_key) else {
        return Ok(Vec::new());
    };
    let servers = servers
        .as_object()
        .ok_or("extensions_mcp_servers_not_table")?;
    Ok(servers
        .iter()
        .filter(|(key, value)| {
            value.is_object()
                && value.get("enabled").and_then(|v| v.as_bool()) != Some(false)
                && value.get("disabled").and_then(|v| v.as_bool()) != Some(true)
                && !disabled
                    .is_some_and(|items| items.iter().any(|v| v.as_str() == Some(key.as_str())))
        })
        .map(|(key, _)| key.clone())
        .collect())
}

// Claude's personal MCP lives beside .claude, not in settings.json.
fn target_path(home: &home::ProviderHomeState, cli: ExtensionCli) -> String {
    let path = match cli {
        ExtensionCli::Claude => PathBuf::from(&home.home_path).join(".claude.json"),
        ExtensionCli::Codex => PathBuf::from(&home.targets.codex_config_dir).join("config.toml"),
        ExtensionCli::Grok => PathBuf::from(&home.targets.grok_config_dir).join("config.toml"),
    };
    if home.identity.environment_kind == "wsl"
        && !crate::wsl::is_wsl_config_dir(&path.to_string_lossy())
    {
        crate::wsl::linux_to_unc_wsl_path(
            &path.to_string_lossy().replace('\\', "/"),
            &home.identity.environment_id,
        )
    } else {
        path.to_string_lossy().into_owned()
    }
}

// Merge native entries without rewriting unmanaged MCP definitions or unrelated settings.
fn merge(
    cli: ExtensionCli,
    base: &str,
    resources: &[McpResource],
    managed: &BTreeSet<String>,
) -> Result<String, String> {
    // Explicit managed selection supersedes imported per-server disable flags.
    let mut selected = resources.to_vec();
    for resource in &mut selected {
        if let Some(fields) = resource.per_cli_extensions.get_mut(cli.key()) {
            fields.remove("enabled");
            fields.remove("disabled");
        }
    }
    let projected = adapters::project_for_apply(cli, base, &selected)?;
    let enabled: BTreeSet<_> = selected
        .iter()
        .filter(|r| r.enabled_for(cli))
        .map(|r| r.server_key.as_str())
        .collect();
    if cli == ExtensionCli::Claude {
        let mut root: serde_json::Value =
            serde_json::from_str(base).map_err(|_| "extensions_invalid_claude_json")?;
        let output: serde_json::Value =
            serde_json::from_str(&projected).map_err(|_| "extensions_invalid_claude_json")?;
        if root.get("mcpServers").is_none() {
            root["mcpServers"] = serde_json::json!({});
        }
        let servers = root["mcpServers"]
            .as_object_mut()
            .ok_or("extensions_mcp_servers_not_table")?;
        for key in managed {
            servers.remove(key);
        }
        for (key, entry) in output["mcpServers"]
            .as_object()
            .ok_or("extensions_mcp_servers_not_table")?
        {
            servers.insert(key.clone(), entry.clone());
        }
        for field in ["disabledMcpServers", "disabled_mcp_servers"] {
            if let Some(keys) = root.get_mut(field).and_then(|v| v.as_array_mut()) {
                keys.retain(|key| !key.as_str().is_some_and(|key| enabled.contains(key)));
            }
        }
        serde_json::to_string_pretty(&root).map_err(|_| "extensions_json_serialize_failed".into())
    } else {
        let mut root = base
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "extensions_invalid_toml")?;
        let output = projected
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "extensions_invalid_toml")?;
        if root.get("mcp_servers").is_none() {
            root["mcp_servers"] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        let servers = root["mcp_servers"]
            .as_table_mut()
            .ok_or("extensions_mcp_servers_not_table")?;
        for key in managed {
            servers.remove(key);
        }
        if let Some(projected_servers) = output
            .get("mcp_servers")
            .and_then(toml_edit::Item::as_table)
        {
            for (key, entry) in projected_servers {
                servers.insert(key, entry.clone());
            }
        }
        for field in ["disabledMcpServers", "disabled_mcp_servers"] {
            if let Some(keys) = root.get_mut(field).and_then(|v| v.as_array_mut()) {
                keys.retain(|key| !key.as_str().is_some_and(|key| enabled.contains(key)));
            }
        }
        Ok(root.to_string())
    }
}

// Rebuild from the active provider Home and persisted full resources; the renderer sends no paths/secrets.
async fn plan(cli: ExtensionCli) -> Result<Plan, String> {
    let home = home::active()?;
    let path = target_path(&home, cli);
    let before = global::read_live(&path)?;
    if before.as_ref().is_some_and(|b| b.len() > 8 * 1024 * 1024) {
        return Err("extensions_native_config_too_large".into());
    }
    let base = match &before {
        Some(bytes) => {
            std::str::from_utf8(bytes).map_err(|_| "extensions_native_encoding_invalid")?
        }
        None if cli == ExtensionCli::Claude => "{}",
        None => "",
    };
    let existing = adapters::parse_native_config(cli, base)?.resources;
    let resources: Vec<_> = repository::list_mcp_resource_records()
        .await?
        .into_iter()
        .map(|r| r.resource)
        .collect();
    let identity = format!("{}:{}:{path}", home.identity.identity, cli.key());
    let ledger = crate::app_paths::cli_manager_data_dir()?
        .join("extensions/mcp-targets")
        .join(format!("{:x}.json", Sha256::digest(identity.as_bytes())));
    let ledger_bytes = match std::fs::read(&ledger) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => b"[]".to_vec(),
        Err(_) => return Err("extensions_native_state_read_failed".into()),
    };
    let mut managed: BTreeSet<String> =
        serde_json::from_slice(&ledger_bytes).map_err(|_| "extensions_native_state_invalid")?;
    managed.extend(resources.iter().map(|r| r.server_key.clone()));
    let enabled: BTreeSet<_> = resources
        .iter()
        .filter(|r| r.enabled_for(cli))
        .map(|r| r.server_key.clone())
        .collect();
    let desired = merge(cli, base, &resources, &managed)?.into_bytes();
    let desired_text =
        std::str::from_utf8(&desired).map_err(|_| "extensions_native_encoding_invalid")?;
    let content = adapters::redact_projected_content(cli, desired_text)?;
    let format = match cli {
        ExtensionCli::Claude => McpConfigFormat::Json,
        ExtensionCli::Codex | ExtensionCli::Grok => McpConfigFormat::Toml,
    };
    let mut hash = Sha256::new();
    for bytes in [
        identity.as_bytes(),
        before.as_deref().unwrap_or_default(),
        &ledger_bytes,
        &serde_json::to_vec(&resources).map_err(|_| "extensions_json_serialize_failed")?,
    ] {
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    let existing_keys: Vec<_> = existing.iter().map(|r| r.server_key.clone()).collect();
    let removed_keys = existing_keys
        .iter()
        .filter(|k| managed.contains(*k) && !enabled.contains(*k))
        .cloned()
        .collect();
    Ok(Plan {
        view: NativePreview {
            cli,
            format,
            path,
            fingerprint: format!("{:x}", hash.finalize()),
            existing_keys,
            enabled_keys: enabled.into_iter().collect(),
            removed_keys,
            changed: before.as_deref() != Some(desired.as_slice()),
            content,
        },
        before,
        desired,
        ledger,
        managed_keys: managed,
        home_identity: home.identity.identity,
    })
}

pub(crate) async fn preview(cli: ExtensionCli) -> Result<NativePreview, String> {
    Ok(plan(cli).await?.view)
}

// Preview confirmation is mandatory. A changed Home, database or native file invalidates it.
pub(crate) async fn apply(
    cli: ExtensionCli,
    fingerprint: String,
) -> Result<NativeApplyResult, String> {
    let home = home::active()?;
    let app_type = if cli == ExtensionCli::Grok {
        "grokbuild"
    } else {
        cli.key()
    };
    let _lock = global::acquire_apply_lock(app_type, &home.identity.identity)?;
    let plan = plan(cli).await?;
    if plan.view.fingerprint != fingerprint || plan.home_identity != home.identity.identity {
        return Err("extensions_native_preview_changed".into());
    }
    let path = &plan.view.path;
    let operation = Uuid::new_v4();
    // Persist ownership intent first so a crash after replacement remains recoverable on the next apply.
    std::fs::create_dir_all(
        plan.ledger
            .parent()
            .ok_or("extensions_native_state_invalid")?,
    )
    .map_err(|_| "extensions_native_state_write_failed")?;
    let ledger_stage = plan.ledger.with_extension(format!("{operation}.stage"));
    std::fs::write(
        &ledger_stage,
        serde_json::to_vec(&plan.managed_keys).map_err(|_| "extensions_json_serialize_failed")?,
    )
    .map_err(|_| "extensions_native_state_write_failed")?;
    global::replace_live_from_stage(
        &plan.ledger.to_string_lossy(),
        &ledger_stage.to_string_lossy(),
    )?;
    let backup = if plan.view.changed {
        super::native_files::publish(path, plan.before.as_deref(), &plan.desired)?
    } else {
        None
    };
    // Completed removals relinquish their keys; later external entries with those names are not owned.
    std::fs::write(
        &ledger_stage,
        serde_json::to_vec(&plan.view.enabled_keys)
            .map_err(|_| "extensions_json_serialize_failed")?,
    )
    .map_err(|_| "extensions_native_state_write_failed")?;
    global::replace_live_from_stage(
        &plan.ledger.to_string_lossy(),
        &ledger_stage.to_string_lossy(),
    )?;
    Ok(NativeApplyResult {
        path: path.clone(),
        backup_path: if plan.view.changed { backup } else { None },
        changed: plan.view.changed,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn explicit_enable_clears_only_selected_native_disable_flags() {
        use super::*;
        let mut resources = adapters::parse_native_config(
            ExtensionCli::Claude,
            r#"{"mcpServers":{"demo":{"command":"x","enabled":false,"disabled":true}}}"#,
        )
        .unwrap()
        .resources;
        for cli in ExtensionCli::all() {
            resources[0].per_cli_extensions.insert(
                cli.key().into(),
                serde_json::Map::from_iter([
                    ("enabled".into(), serde_json::json!(false)),
                    ("disabled".into(), serde_json::json!(true)),
                ]),
            );
            let base = if cli == ExtensionCli::Claude {
                r#"{"mcpServers":{},"disabledMcpServers":["demo","other"]}"#
            } else {
                "disabled_mcp_servers=['demo','other']"
            };
            let output = merge(cli, base, &resources, &BTreeSet::from(["demo".into()])).unwrap();
            assert_eq!(active_keys(cli, &output).unwrap(), vec!["demo"]);
            assert!(output.contains("other"));
        }
    }
    #[test]
    fn native_status_uses_file_switches_without_canonical_projection() {
        use super::*;
        let json = r#"{"mcpServers":{"on":{"command":"x"},"off":{"enabled":false},"blocked":{"disabled":true},"listed":{}},"disabledMcpServers":["listed"]}"#;
        assert_eq!(active_keys(ExtensionCli::Claude, json).unwrap(), vec!["on"]);
        let toml = "disabled_mcp_servers=['listed']\n[mcp_servers.on]\ncommand='x'\n[mcp_servers.off]\nenabled=false\n[mcp_servers.listed]\ncommand='x'";
        for cli in [ExtensionCli::Codex, ExtensionCli::Grok] {
            assert_eq!(active_keys(cli, toml).unwrap(), vec!["on"]);
            assert!(active_keys(cli, "").unwrap().is_empty());
            assert!(active_keys(cli, "invalid=[").is_err());
        }
    }

    #[test]
    fn native_preview_content_is_redacted_before_ipc() {
        let resources = adapters::parse_native_config(
            ExtensionCli::Claude,
            r#"{"mcpServers":{"demo":{"command":"node","env":{"TOKEN":"managed-secret"}}}}"#,
        )
        .unwrap()
        .resources;
        for cli in ExtensionCli::all() {
            let base = if cli == ExtensionCli::Claude {
                r#"{"oauthToken":"root-secret","theme":"dark","mcpServers":{"foreign":{"command":"external","env":{"KEY":"foreign-secret"}}}}"#
            } else {
                "api_key = \"root-secret\"\ntheme = \"dark\"\n[mcp_servers.foreign]\ncommand = \"external\"\n[mcp_servers.foreign.env]\nKEY = \"foreign-secret\"\n"
            };
            let desired = merge(cli, base, &resources, &BTreeSet::from(["demo".into()])).unwrap();
            let content = adapters::redact_projected_content(cli, &desired).unwrap();
            let format = if cli == ExtensionCli::Claude {
                McpConfigFormat::Json
            } else {
                McpConfigFormat::Toml
            };
            let dto = NativePreview {
                cli,
                format,
                path: "test-config".into(),
                fingerprint: "test-fingerprint".into(),
                existing_keys: vec!["foreign".into()],
                enabled_keys: vec!["demo".into()],
                removed_keys: vec![],
                changed: true,
                content,
            };
            let serialized = serde_json::to_string(&dto).unwrap();
            for secret in ["root-secret", "foreign-secret", "managed-secret"] {
                assert!(desired.contains(secret));
                assert!(!serialized.contains(secret));
            }
            let value = serde_json::to_value(&dto).unwrap();
            assert_eq!(
                value["format"],
                if cli == ExtensionCli::Claude {
                    "json"
                } else {
                    "toml"
                }
            );
            assert!(dto.content.contains("dark"));
            assert!(dto.content.contains("[redacted]"));
            let parsed = adapters::parse_native_config(cli, &dto.content).unwrap();
            assert_eq!(parsed.resources.len(), 2);
        }
    }
    use super::*;

    // Opt-in Windows smoke test: the installed CLIs read generated files in a disposable Home.
    #[test]
    #[ignore = "requires installed Claude, Codex and Grok CLIs"]
    #[cfg(windows)]
    fn installed_clis_read_generated_native_configuration() {
        let root = tempfile::tempdir().unwrap();
        let resources = adapters::parse_native_config(ExtensionCli::Claude,
            r#"{"mcpServers":{"cli-manager-smoke":{"command":"cmd","args":["/d","/c","exit","0"]}}}"#).unwrap().resources;
        for cli in ExtensionCli::all() {
            let path = match cli {
                ExtensionCli::Claude => root.path().join(".claude.json"),
                ExtensionCli::Codex => root.path().join(".codex/config.toml"),
                ExtensionCli::Grok => root.path().join(".grok/config.toml"),
            };
            let content = merge(
                cli,
                if cli == ExtensionCli::Claude {
                    "{}"
                } else {
                    ""
                },
                &resources,
                &BTreeSet::from(["cli-manager-smoke".into()]),
            )
            .unwrap();
            super::super::native_files::publish(&path.to_string_lossy(), None, content.as_bytes())
                .unwrap();
            let mut command = crate::shell_resolver::silent_command("cmd.exe");
            command.args(["/d", "/c"]);
            match cli {
                ExtensionCli::Claude => {
                    command.args(["claude.cmd", "mcp", "get", "cli-manager-smoke"]);
                }
                ExtensionCli::Codex => {
                    command.args(["codex.cmd", "mcp", "get", "cli-manager-smoke", "--json"]);
                }
                ExtensionCli::Grok => {
                    command.args(["grok.cmd", "mcp", "list"]);
                }
            }
            command
                .current_dir(root.path())
                .env("HOME", root.path())
                .env("USERPROFILE", root.path())
                .env("CODEX_HOME", root.path().join(".codex"))
                .env("GROK_HOME", root.path().join(".grok"))
                .env_remove("CLAUDE_CONFIG_DIR");
            let output = crate::shell_resolver::output_with_timeout_bounded(
                command,
                std::time::Duration::from_secs(30),
                64 * 1024,
            )
            .unwrap();
            let text = String::from_utf8_lossy(&output.stdout);
            assert!(
                text.contains("cli-manager-smoke"),
                "{} did not discover the generated server: {}",
                cli.key(),
                text
            );
            assert!(
                output.status.success(),
                "{} rejected its native configuration",
                cli.key()
            );
        }
    }

    #[test]
    fn merges_claude_preserving_external_entries_and_auth() {
        let base = r#"{"oauthAccount":{"id":"keep"},"mcpServers":{"external":{"command":"external"},"managed":{"command":"old"}}}"#;
        let mut resources = adapters::parse_native_config(
            ExtensionCli::Claude,
            r#"{"mcpServers":{"managed":{"command":"new","env":{"TOKEN":"secret"}}}}"#,
        )
        .unwrap()
        .resources;
        let managed = BTreeSet::from(["managed".into()]);
        let result = merge(ExtensionCli::Claude, base, &resources, &managed).unwrap();
        let value: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["oauthAccount"]["id"], "keep");
        assert_eq!(value["mcpServers"]["external"]["command"], "external");
        assert_eq!(value["mcpServers"]["managed"]["env"]["TOKEN"], "secret");
        resources[0].enabled_by_cli.insert("claude".into(), false);
        let disabled: serde_json::Value = serde_json::from_str(
            &merge(ExtensionCli::Claude, &result, &resources, &managed).unwrap(),
        )
        .unwrap();
        assert!(disabled["mcpServers"].get("managed").is_none());
        assert!(disabled["mcpServers"].get("external").is_some());
    }

    #[test]
    fn merges_toml_and_removes_previously_managed_deleted_resources() {
        let base = "# keep comment\nmodel = 'keep'\n[mcp_servers.external]\ncommand = 'external'\n[mcp_servers.deleted]\ncommand = 'old'\n";
        for cli in [ExtensionCli::Codex, ExtensionCli::Grok] {
            let output = merge(cli, base, &[], &BTreeSet::from(["deleted".into()])).unwrap();
            assert!(output.contains("# keep comment"));
            let doc: toml::Value = toml::from_str(&output).unwrap();
            assert_eq!(doc["model"].as_str(), Some("keep"));
            assert!(doc["mcp_servers"].get("external").is_some());
            assert!(doc["mcp_servers"].get("deleted").is_none());
        }
    }
}
