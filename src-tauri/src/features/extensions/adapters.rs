use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use toml_edit::{value, DocumentMut, Item, Table};

use super::model::{
    cli_supports_transport, default_enabled_by_cli, derive_resource_id, redact_resource,
    validate_resource, ExtensionCli, McpConfigFormat, McpProjectionIssue, McpProjectionPreview,
    McpResource, McpResourceSource, McpTimeout, McpTransport, ProjectionStatus,
};

const CLAUDE_MCP_ROOT: &str = "mcpServers";
const TOML_MCP_ROOT: &str = "mcp_servers";

// Full projection stays in Rust; global apply merges only explicitly managed keys.
pub(crate) fn project_for_apply(
    cli: ExtensionCli,
    base: &str,
    resources: &[McpResource],
) -> Result<String, String> {
    let selected: Vec<_> = resources
        .iter()
        .filter(|r| r.enabled_for(cli))
        .cloned()
        .collect();
    if selected.iter().any(|r| !r.secret_refs.is_empty()) {
        return Err("extensions_secret_reference_unresolved".into());
    }
    if let Some(issue) = projection_issues(cli, &selected).first() {
        return Err(format!("extensions_projection_unsupported:{}", issue.code));
    }
    match cli {
        ExtensionCli::Claude => project_claude_json(base, &selected),
        ExtensionCli::Codex => project_toml(base, cli, &selected, "http_headers"),
        ExtensionCli::Grok => project_toml(base, cli, &selected, "headers"),
    }
}

#[derive(Clone)]
pub struct ParsedNativeConfig {
    pub cli: ExtensionCli,
    pub format: McpConfigFormat,
    pub resources: Vec<McpResource>,
}

// 解析指定 CLI 的原生配置，仅提取 MCP；其它配置由投影器从原文保留。
pub fn parse_native_config(cli: ExtensionCli, source: &str) -> Result<ParsedNativeConfig, String> {
    match cli {
        ExtensionCli::Claude => parse_claude_json(source),
        ExtensionCli::Codex => parse_toml_config(cli, source, "http_headers"),
        ExtensionCli::Grok => parse_toml_config(cli, source, "headers"),
    }
}

// 先校验原文与候选资源，再只替换目标 CLI 的 MCP 节点并返回脱敏预览。
pub fn project_native_config(
    cli: ExtensionCli,
    base_config: &str,
    resources: &[McpResource],
) -> Result<McpProjectionPreview, String> {
    let _ = parse_native_config(cli, base_config)?;
    let selected_resources = resources
        .iter()
        .filter(|resource| resource.enabled_for(cli))
        .cloned()
        .collect::<Vec<_>>();
    let issues = projection_issues(cli, &selected_resources);
    let format = format_for(cli);
    if !issues.is_empty() {
        return Ok(McpProjectionPreview {
            cli,
            format,
            status: ProjectionStatus::Unsupported,
            content: String::new(),
            resources: selected_resources.iter().map(redact_resource).collect(),
            issues,
            omitted_fields: omitted_fields(),
            changed: false,
        });
    }

    let projected = match cli {
        ExtensionCli::Claude => project_claude_json(base_config, &selected_resources)?,
        ExtensionCli::Codex => project_toml(base_config, cli, &selected_resources, "http_headers")?,
        ExtensionCli::Grok => project_toml(base_config, cli, &selected_resources, "headers")?,
    };
    Ok(McpProjectionPreview {
        cli,
        format,
        status: ProjectionStatus::Ready,
        content: redact_projected_content(cli, &projected)?,
        resources: selected_resources.iter().map(redact_resource).collect(),
        issues: Vec::new(),
        omitted_fields: omitted_fields(),
        changed: projected != base_config,
    })
}

// 为 CLI-Manager 启动快照生成受管 MCP 配置；与脱敏预览共用同一校验和投影路径，
// 但完整正文只写入应用数据目录，不跨 IPC 返回，避免秘密字段进入 WebView。
pub(crate) fn project_native_config_for_launch(
    cli: ExtensionCli,
    resources: &[McpResource],
) -> Result<String, String> {
    let selected_resources = resources
        .iter()
        .filter(|resource| resource.enabled_for(cli))
        .cloned()
        .collect::<Vec<_>>();
    let issues = projection_issues(cli, &selected_resources);
    if let Some(issue) = issues.first() {
        return Err(format!(
            "extensions_project_mcp_projection_unsupported:{}:{}",
            issue.code, issue.field
        ));
    }
    let base_config = match cli {
        ExtensionCli::Claude => "{}",
        ExtensionCli::Codex | ExtensionCli::Grok => "",
    };
    match cli {
        ExtensionCli::Claude => project_claude_json(base_config, &selected_resources),
        ExtensionCli::Codex => project_toml(base_config, cli, &selected_resources, "http_headers"),
        ExtensionCli::Grok => project_toml(base_config, cli, &selected_resources, "headers"),
    }
}

// 将字段级模型问题与目标 CLI 能力问题合并，禁止调用方把不支持字段当作成功。
fn projection_issues(cli: ExtensionCli, resources: &[McpResource]) -> Vec<McpProjectionIssue> {
    let mut issues = Vec::new();
    let mut keys = BTreeSet::new();
    for resource in resources {
        let resource_id = Some(resource.resource_id.clone());
        for validation in validate_resource(resource) {
            issues.push(McpProjectionIssue {
                code: validation.code,
                field: validation.field,
                resource_id: resource_id.clone(),
            });
        }
        if !keys.insert(resource.server_key.clone()) {
            issues.push(McpProjectionIssue {
                code: "duplicate_server_key".to_string(),
                field: "serverKey".to_string(),
                resource_id: resource_id.clone(),
            });
        }
        if !cli_supports_transport(cli, resource.transport) {
            issues.push(McpProjectionIssue {
                code: "transport_unsupported".to_string(),
                field: "transport".to_string(),
                resource_id: resource_id.clone(),
            });
        }
        if resource.timeout.is_some() && cli != ExtensionCli::Codex {
            issues.push(McpProjectionIssue {
                code: "timeout_unsupported".to_string(),
                field: "timeout".to_string(),
                resource_id: resource_id.clone(),
            });
        }
        if cli == ExtensionCli::Codex && has_non_second_timeout(resource.timeout.as_ref()) {
            issues.push(McpProjectionIssue {
                code: "timeout_unit_not_representable".to_string(),
                field: "timeout".to_string(),
                resource_id: resource_id.clone(),
            });
        }
        if !matches!(resource.transport, McpTransport::Stdio) && !resource.env.is_empty() {
            issues.push(McpProjectionIssue {
                code: "env_unsupported_for_network_transport".to_string(),
                field: "env".to_string(),
                resource_id,
            });
        }
        issues.extend(extension_projection_issues(cli, resource));
    }
    issues
}

// 检查目标厂商扩展是否能无损写入 TOML/JSON；其它 CLI 的扩展不会被转发。
fn extension_projection_issues(
    cli: ExtensionCli,
    resource: &McpResource,
) -> Vec<McpProjectionIssue> {
    let mut issues = Vec::new();
    let Some(values) = extension_for(resource, cli) else {
        return issues;
    };
    for (field, value) in values {
        if is_reserved_native_field(cli, field) {
            issues.push(McpProjectionIssue {
                code: "reserved_cli_extension_field".to_string(),
                field: format!("perCliExtensions.{}.{}", cli.key(), field),
                resource_id: Some(resource.resource_id.clone()),
            });
        } else if !toml_value_supported(value) && cli != ExtensionCli::Claude {
            issues.push(McpProjectionIssue {
                code: "toml_extension_not_representable".to_string(),
                field: format!("perCliExtensions.{}.{}", cli.key(), field),
                resource_id: Some(resource.resource_id.clone()),
            });
        }
    }
    issues
}

// 解析 Claude JSON 根对象及 mcpServers，拒绝错误类型而不回显配置正文。
fn parse_claude_json(source: &str) -> Result<ParsedNativeConfig, String> {
    let root: Value =
        serde_json::from_str(source).map_err(|_| "extensions_invalid_claude_json".to_string())?;
    let root_object = root
        .as_object()
        .ok_or_else(|| "extensions_claude_root_not_object".to_string())?;
    let servers = match root_object.get(CLAUDE_MCP_ROOT) {
        None => Map::new(),
        Some(value) => value
            .as_object()
            .cloned()
            .ok_or_else(|| "extensions_claude_mcp_servers_not_object".to_string())?,
    };
    let mut resources = Vec::new();
    for (server_key, server_value) in servers {
        let object = server_value
            .as_object()
            .ok_or_else(|| "extensions_claude_server_not_object".to_string())?;
        resources.push(parse_json_resource(
            ExtensionCli::Claude,
            server_key,
            object,
            "headers",
            &[
                "type",
                "command",
                "args",
                "cwd",
                "url",
                "env",
                "headers",
                "name",
                "resourceId",
                "schemaVersion",
                "secretRefs",
                "source",
                "timeout",
            ],
        )?);
    }
    Ok(ParsedNativeConfig {
        cli: ExtensionCli::Claude,
        format: McpConfigFormat::Json,
        resources,
    })
}

// 解析 Codex/Grok TOML 的 mcp_servers 表，保持两者 header 字段名差异在适配器内。
fn parse_toml_config(
    cli: ExtensionCli,
    source: &str,
    header_key: &str,
) -> Result<ParsedNativeConfig, String> {
    let root: toml::Value =
        toml::from_str(source).map_err(|_| "extensions_invalid_toml".to_string())?;
    let servers = match root.get(TOML_MCP_ROOT) {
        None => toml::map::Map::new(),
        Some(value) => value
            .as_table()
            .ok_or_else(|| "extensions_mcp_servers_not_table".to_string())?
            .clone(),
    };
    let mut resources = Vec::new();
    for (server_key, server_value) in servers {
        let object = server_value
            .as_table()
            .ok_or_else(|| "extensions_mcp_server_not_table".to_string())?;
        resources.push(parse_toml_resource(cli, server_key, object, header_key)?);
    }
    Ok(ParsedNativeConfig {
        cli,
        format: McpConfigFormat::Toml,
        resources,
    })
}

// 从 JSON MCP 条目提取规范字段，并将未识别字段保留在当前 CLI 的扩展命名空间。
fn parse_json_resource(
    cli: ExtensionCli,
    server_key: String,
    object: &Map<String, Value>,
    header_key: &str,
    known_fields: &[&str],
) -> Result<McpResource, String> {
    let transport = parse_transport(
        object.get("type").and_then(Value::as_str),
        object.contains_key("url"),
    )?;
    let resource = McpResource {
        schema_version: object
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .map(|value| value as u32)
            .unwrap_or(super::model::MCP_MODEL_SCHEMA_VERSION),
        resource_id: object
            .get("resourceId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| derive_resource_id(&server_key)),
        server_key: server_key.clone(),
        name: object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&server_key)
            .to_string(),
        transport,
        command: optional_string(object, "command")?,
        args: string_array(object.get("args"), "args")?,
        cwd: optional_string(object, "cwd")?,
        url: optional_string(object, "url")?,
        env: string_map(object.get("env"), "env")?,
        headers: string_map(object.get(header_key), header_key)?,
        secret_refs: string_map(object.get("secretRefs"), "secretRefs")?,
        timeout: json_timeout(object.get("timeout"))?,
        per_cli_extensions: unknown_json_fields(cli, object, known_fields),
        enabled_by_cli: default_enabled_by_cli(),
        source: Some(native_source(cli, &server_key)),
        extra: BTreeMap::new(),
    };
    ensure_parsed_resource(resource)
}

// 从 TOML MCP 条目提取规范字段，并映射 Codex 的 http_headers 与秒级超时。
fn parse_toml_resource(
    cli: ExtensionCli,
    server_key: String,
    object: &toml::map::Map<String, toml::Value>,
    header_key: &str,
) -> Result<McpResource, String> {
    let transport = parse_transport(
        object.get("type").and_then(toml::Value::as_str),
        object.contains_key("url"),
    )?;
    let mut secret_refs = string_map_toml(object.get("secretRefs"), "secretRefs")?;
    if let Some(reference) = object
        .get("bearer_token_env_var")
        .and_then(toml::Value::as_str)
    {
        secret_refs.insert("header:Authorization".to_string(), reference.to_string());
    }
    let resource = McpResource {
        schema_version: object
            .get("schemaVersion")
            .and_then(toml::Value::as_integer)
            .map(|value| value as u32)
            .unwrap_or(super::model::MCP_MODEL_SCHEMA_VERSION),
        resource_id: object
            .get("resourceId")
            .and_then(toml::Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| derive_resource_id(&server_key)),
        server_key: server_key.clone(),
        name: object
            .get("name")
            .and_then(toml::Value::as_str)
            .unwrap_or(&server_key)
            .to_string(),
        transport,
        command: optional_toml_string(object, "command")?,
        args: string_array_toml(object.get("args"), "args")?,
        cwd: optional_toml_string(object, "cwd")?,
        url: optional_toml_string(object, "url")?,
        env: string_map_toml(object.get("env"), "env")?,
        headers: string_map_toml(object.get(header_key), header_key)?,
        secret_refs,
        timeout: toml_timeout(object)?,
        per_cli_extensions: unknown_toml_fields(cli, object, header_key)?,
        enabled_by_cli: default_enabled_by_cli(),
        source: Some(native_source(cli, &server_key)),
        extra: BTreeMap::new(),
    };
    ensure_parsed_resource(resource)
}

// 解析原生 transport；无 type 时按 command/url 推断，未知 type 直接报错。
fn parse_transport(value: Option<&str>, has_url: bool) -> Result<McpTransport, String> {
    match value.map(|value| value.trim().to_ascii_lowercase()) {
        None if has_url => Ok(McpTransport::StreamableHttp),
        None => Ok(McpTransport::Stdio),
        Some(value) => match value.as_str() {
            "stdio" => Ok(McpTransport::Stdio),
            "sse" => Ok(McpTransport::Sse),
            "http" | "streamablehttp" | "streamable-http" => Ok(McpTransport::StreamableHttp),
            _ => Err("extensions_unknown_transport".to_string()),
        },
    }
}

// 解析并校验单项资源，阻止损坏的原生配置进入后续导入或写库流程。
fn ensure_parsed_resource(resource: McpResource) -> Result<McpResource, String> {
    let issues = validate_resource(&resource);
    if issues.is_empty() {
        Ok(resource)
    } else {
        Err(format!("extensions_invalid_resource:{}", issues[0].code))
    }
}

// 创建导入来源标识；来源正文不进入日志，只用于后续冲突与重复识别。
fn native_source(cli: ExtensionCli, server_key: &str) -> McpResourceSource {
    McpResourceSource {
        kind: format!("native:{}", cli.key()),
        identity: format!("{}:{server_key}", cli.key()),
        label: Some(cli.display_name().to_string()),
    }
}

// 从 JSON 对象读取可选字符串，并把类型错误转换成稳定错误码。
fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(Value::Null) => Ok(None),
        Some(_) => Err(format!("extensions_field_not_string:{key}")),
    }
}

// 从 TOML 表读取可选字符串，并把类型错误转换成稳定错误码。
fn optional_toml_string(
    object: &toml::map::Map<String, toml::Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(toml::Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("extensions_field_not_string:{key}")),
    }
}

// 解析 JSON 字符串数组，拒绝数字、对象和 null，避免投影时发生隐式格式转换。
fn string_array(value: Option<&Value>, field: &str) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let array = value
        .as_array()
        .ok_or_else(|| format!("extensions_field_not_string_array:{field}"))?;
    array
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("extensions_field_not_string_array:{field}"))
        })
        .collect()
}

// 解析 TOML 字符串数组，拒绝非字符串元素，保持 command args 的语义一致。
fn string_array_toml(value: Option<&toml::Value>, field: &str) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let array = value
        .as_array()
        .ok_or_else(|| format!("extensions_field_not_string_array:{field}"))?;
    array
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("extensions_field_not_string_array:{field}"))
        })
        .collect()
}

// 将 JSON 对象映射转换成有序字符串表，避免把未知 JSON 值悄悄转成文本。
fn string_map(value: Option<&Value>, field: &str) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let object = value
        .as_object()
        .ok_or_else(|| format!("extensions_field_not_string_map:{field}"))?;
    object
        .iter()
        .map(|(key, value)| {
            value
                .as_str()
                .map(|value| (key.clone(), value.to_string()))
                .ok_or_else(|| format!("extensions_field_not_string_map:{field}"))
        })
        .collect()
}

// 将 TOML 表映射转换成有序字符串表，保留 headers/env 的精确键值。
fn string_map_toml(
    value: Option<&toml::Value>,
    field: &str,
) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let object = value
        .as_table()
        .ok_or_else(|| format!("extensions_field_not_string_map:{field}"))?;
    object
        .iter()
        .map(|(key, value)| {
            value
                .as_str()
                .map(|value| (key.clone(), value.to_string()))
                .ok_or_else(|| format!("extensions_field_not_string_map:{field}"))
        })
        .collect()
}

// 将 JSON timeout 的毫秒字段解析为规范模型。
fn json_timeout(value: Option<&Value>) -> Result<Option<McpTimeout>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| "extensions_timeout_not_object".to_string())?;
    Ok(Some(McpTimeout {
        startup_ms: optional_u64(object.get("startupMs"), "timeout.startupMs")?,
        request_ms: optional_u64(object.get("requestMs"), "timeout.requestMs")?,
    }))
}

// 将 TOML 秒级 timeout 解析为规范模型；单位转换仅发生在适配器边界。
fn toml_timeout(
    object: &toml::map::Map<String, toml::Value>,
) -> Result<Option<McpTimeout>, String> {
    let startup = optional_seconds(object.get("startup_timeout_sec"), "startup_timeout_sec")?;
    let request = optional_seconds(object.get("tool_timeout_sec"), "tool_timeout_sec")?;
    if startup.is_none() && request.is_none() {
        Ok(None)
    } else {
        Ok(Some(McpTimeout {
            startup_ms: startup,
            request_ms: request,
        }))
    }
}

// 读取非负整数毫秒，避免浮点或负值在跨格式转换时改变含义。
fn optional_u64(value: Option<&Value>, field: &str) -> Result<Option<u64>, String> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("extensions_field_not_u64:{field}")),
        Some(_) => Err(format!("extensions_field_not_u64:{field}")),
    }
}

// 读取 TOML 秒数并转换为毫秒；超过整数范围或非正值均拒绝。
fn optional_seconds(value: Option<&toml::Value>, field: &str) -> Result<Option<u64>, String> {
    match value {
        None => Ok(None),
        Some(toml::Value::Integer(seconds)) if *seconds > 0 => (*seconds as u64)
            .checked_mul(1000)
            .map(Some)
            .ok_or_else(|| format!("extensions_invalid_timeout:{field}")),
        Some(_) => Err(format!("extensions_invalid_timeout:{field}")),
    }
}

// 收集 JSON 条目中未被规范字段占用的值，按当前 CLI 隔离存放。
fn unknown_json_fields(
    cli: ExtensionCli,
    object: &Map<String, Value>,
    known_fields: &[&str],
) -> BTreeMap<String, Map<String, Value>> {
    let known: BTreeSet<&str> = known_fields.iter().copied().collect();
    let values: Map<String, Value> = object
        .iter()
        .filter(|(key, _)| !known.contains(key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if values.is_empty() {
        BTreeMap::new()
    } else {
        BTreeMap::from([(cli.key().to_string(), values)])
    }
}

// 收集 TOML 条目中未被规范字段占用的值，避免不同 CLI 的未知字段互相污染。
fn unknown_toml_fields(
    cli: ExtensionCli,
    object: &toml::map::Map<String, toml::Value>,
    header_key: &str,
) -> Result<BTreeMap<String, Map<String, Value>>, String> {
    let known = [
        "type",
        "command",
        "args",
        "cwd",
        "url",
        "env",
        "headers",
        header_key,
        "name",
        "resourceId",
        "schemaVersion",
        "secretRefs",
        "source",
        "bearer_token_env_var",
        "startup_timeout_sec",
        "tool_timeout_sec",
    ];
    let values: Map<String, Value> = object
        .iter()
        .filter(|(key, _)| !known.contains(&key.as_str()))
        .map(|(key, value)| toml_to_json(value).map(|value| (key.clone(), value)))
        .collect::<Result<_, _>>()?;
    if values.is_empty() {
        Ok(BTreeMap::new())
    } else {
        Ok(BTreeMap::from([(cli.key().to_string(), values)]))
    }
}

// 将可保留的 TOML 值转换为 JSON 扩展值；无法表示的类型不会静默丢失。
fn toml_to_json(value: &toml::Value) -> Result<Value, String> {
    match value {
        toml::Value::String(value) => Ok(Value::String(value.clone())),
        toml::Value::Integer(value) => Ok(Value::Number((*value).into())),
        toml::Value::Float(value) => serde_json::Number::from_f64(*value)
            .map(Value::Number)
            .ok_or_else(|| "extensions_toml_float_invalid".to_string()),
        toml::Value::Boolean(value) => Ok(Value::Bool(*value)),
        toml::Value::Datetime(value) => Ok(Value::String(value.to_string())),
        toml::Value::Array(values) => values
            .iter()
            .map(toml_to_json)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        toml::Value::Table(values) => values
            .iter()
            .map(|(key, value)| toml_to_json(value).map(|value| (key.clone(), value)))
            .collect::<Result<Map<_, _>, _>>()
            .map(Value::Object),
    }
}

// 将 JSON 配置中的 MCP 节点替换为规范资源，根级非 MCP 字段保持原值。
fn project_claude_json(source: &str, resources: &[McpResource]) -> Result<String, String> {
    let mut root: Value =
        serde_json::from_str(source).map_err(|_| "extensions_invalid_claude_json".to_string())?;
    let root_object = root
        .as_object_mut()
        .ok_or_else(|| "extensions_claude_root_not_object".to_string())?;
    let mut servers = Map::new();
    for resource in sorted_resources(resources) {
        let mut entry = Map::new();
        if let Some(existing) = root_object
            .get(CLAUDE_MCP_ROOT)
            .and_then(Value::as_object)
            .and_then(|servers| servers.get(&resource.server_key))
            .and_then(Value::as_object)
        {
            entry.extend(existing.clone());
        }
        project_json_entry(&mut entry, &resource)?;
        servers.insert(resource.server_key.clone(), Value::Object(entry));
    }
    root_object.insert(CLAUDE_MCP_ROOT.to_string(), Value::Object(servers));
    serde_json::to_string_pretty(&root).map_err(|_| "extensions_json_serialize_failed".to_string())
}

// 写入单个 Claude 条目；删除旧规范字段后再合并当前 CLI 的厂商扩展。
fn project_json_entry(
    entry: &mut Map<String, Value>,
    resource: &McpResource,
) -> Result<(), String> {
    for field in [
        "type",
        "command",
        "args",
        "cwd",
        "url",
        "env",
        "headers",
        "name",
        "resourceId",
        "schemaVersion",
        "secretRefs",
        "source",
        "timeout",
    ] {
        entry.remove(field);
    }
    let transport = match resource.transport {
        McpTransport::Stdio => "stdio",
        McpTransport::Sse => "sse",
        McpTransport::StreamableHttp => "http",
    };
    entry.insert("type".to_string(), Value::String(transport.to_string()));
    if let Some(command) = resource.command.as_deref() {
        entry.insert("command".to_string(), Value::String(command.to_string()));
    }
    if !resource.args.is_empty() {
        entry.insert(
            "args".to_string(),
            Value::Array(
                resource
                    .args
                    .iter()
                    .map(|value| Value::String(value.clone()))
                    .collect(),
            ),
        );
    }
    if let Some(cwd) = resource.cwd.as_deref() {
        entry.insert("cwd".to_string(), Value::String(cwd.to_string()));
    }
    if let Some(url) = resource.url.as_deref() {
        entry.insert("url".to_string(), Value::String(url.to_string()));
    }
    insert_json_string_map(entry, "env", &resource.env);
    insert_json_string_map(entry, "headers", &resource.headers);
    if let Some(values) = extension_for(resource, ExtensionCli::Claude) {
        for (field, value) in values {
            if !is_reserved_native_field(ExtensionCli::Claude, field) {
                entry.insert(field.clone(), value.clone());
            }
        }
    }
    Ok(())
}

// 将 JSON 字符串表按稳定顺序写回原生条目。
fn insert_json_string_map(
    entry: &mut Map<String, Value>,
    field: &str,
    values: &BTreeMap<String, String>,
) {
    if values.is_empty() {
        return;
    }
    entry.insert(
        field.to_string(),
        Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                .collect(),
        ),
    );
}

// 使用 toml_edit 修改 mcp_servers，保留根级无关字段、注释和未知子字段。
fn project_toml(
    source: &str,
    cli: ExtensionCli,
    resources: &[McpResource],
    header_key: &str,
) -> Result<String, String> {
    let mut document = source
        .parse::<DocumentMut>()
        .map_err(|_| "extensions_invalid_toml".to_string())?;
    let root = document.as_table_mut();
    let servers_item = root
        .entry(TOML_MCP_ROOT)
        .or_insert_with(|| Item::Table(Table::new()));
    let servers = servers_item
        .as_table_mut()
        .ok_or_else(|| "extensions_mcp_servers_not_table".to_string())?;
    let desired: BTreeSet<String> = resources
        .iter()
        .map(|resource| resource.server_key.clone())
        .collect();
    let old_keys: Vec<String> = servers.iter().map(|(key, _)| key.to_string()).collect();
    for key in old_keys {
        if !desired.contains(&key) {
            servers.remove(&key);
        }
    }
    for resource in sorted_resources(resources) {
        let existing = servers.get(&resource.server_key).cloned();
        let mut entry = existing.unwrap_or_else(|| Item::Table(Table::new()));
        let entry_table = entry
            .as_table_mut()
            .ok_or_else(|| "extensions_mcp_server_not_table".to_string())?;
        project_toml_entry(entry_table, cli, &resource, header_key)?;
        servers.insert(&resource.server_key, entry);
    }
    Ok(document.to_string())
}

// 写入 Codex/Grok 单项 MCP 表；只清理规范字段，保留未知厂商字段和注释。
fn project_toml_entry(
    entry: &mut Table,
    cli: ExtensionCli,
    resource: &McpResource,
    header_key: &str,
) -> Result<(), String> {
    for field in [
        "type",
        "command",
        "args",
        "cwd",
        "url",
        "env",
        "headers",
        "http_headers",
        "name",
        "resourceId",
        "schemaVersion",
        "secretRefs",
        "source",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "bearer_token_env_var",
    ] {
        entry.remove(field);
    }
    if let Some(command) = resource.command.as_deref() {
        entry.insert("command", value(command));
    }
    if !resource.args.is_empty() {
        let mut args = toml_edit::Array::new();
        for argument in &resource.args {
            args.push(argument);
        }
        entry.insert("args", Item::Value(args.into()));
    }
    if let Some(cwd) = resource.cwd.as_deref() {
        entry.insert("cwd", value(cwd));
    }
    if let Some(url) = resource.url.as_deref() {
        entry.insert("url", value(url));
    }
    if cli == ExtensionCli::Grok && resource.transport == McpTransport::Sse {
        entry.insert("type", value("sse"));
    }
    insert_toml_string_map(entry, "env", &resource.env);
    insert_toml_string_map(entry, header_key, &resource.headers);
    if cli == ExtensionCli::Codex {
        if let Some(reference) = resource.secret_refs.get("header:Authorization") {
            entry.insert("bearer_token_env_var", value(reference));
        }
    }
    if let Some(timeout) = resource.timeout.as_ref() {
        if let Some(startup_ms) = timeout.startup_ms {
            entry.insert("startup_timeout_sec", value((startup_ms / 1000) as i64));
        }
        if let Some(request_ms) = timeout.request_ms {
            entry.insert("tool_timeout_sec", value((request_ms / 1000) as i64));
        }
    }
    if let Some(values) = extension_for(resource, cli) {
        for (field, json_value) in values {
            if !is_reserved_native_field(cli, field) {
                let item = json_to_toml_item(json_value)?;
                entry.insert(field, item);
            }
        }
    }
    Ok(())
}

// 将有序字符串表写成 TOML 子表，不影响根级配置内容。
fn insert_toml_string_map(entry: &mut Table, field: &str, values: &BTreeMap<String, String>) {
    if values.is_empty() {
        return;
    }
    let mut table = Table::new();
    for (key, text) in values {
        table.insert(key, toml_edit::value(text));
    }
    entry.insert(field, Item::Table(table));
}

// 将有限 JSON 值转换为 toml_edit Item，保证厂商扩展不因格式差异静默丢失。
fn json_to_toml_item(json_value: &Value) -> Result<Item, String> {
    match json_value {
        Value::String(text) => Ok(toml_edit::value(text)),
        Value::Bool(boolean) => Ok(toml_edit::value(*boolean)),
        Value::Number(number) if number.is_i64() => {
            Ok(toml_edit::value(number.as_i64().unwrap_or_default()))
        }
        Value::Number(number) if number.is_u64() => number
            .as_u64()
            .and_then(|number| i64::try_from(number).ok())
            .map(toml_edit::value)
            .ok_or_else(|| "extensions_toml_integer_out_of_range".to_string()),
        Value::Number(number) => number
            .as_f64()
            .map(toml_edit::value)
            .ok_or_else(|| "extensions_toml_float_invalid".to_string()),
        Value::Array(values) => {
            let mut array = toml_edit::Array::new();
            for child in values {
                let item = json_to_toml_item(child)?;
                let child_value = item
                    .as_value()
                    .cloned()
                    .ok_or_else(|| "extensions_toml_nested_table_not_supported".to_string())?;
                array.push(child_value);
            }
            Ok(Item::Value(array.into()))
        }
        Value::Object(values) => {
            let mut table = Table::new();
            for (key, child) in values {
                table.insert(key, json_to_toml_item(child)?);
            }
            Ok(Item::Table(table))
        }
        Value::Null => Err("extensions_toml_null_not_supported".to_string()),
    }
}

// 返回单项资源的目标 CLI 扩展，绝不读取其它 CLI 命名空间。
fn extension_for(resource: &McpResource, cli: ExtensionCli) -> Option<&Map<String, Value>> {
    if let Some(values) = resource.per_cli_extensions.get(cli.key()) {
        return Some(values);
    }
    if cli == ExtensionCli::Grok {
        return resource.per_cli_extensions.get("grokbuild");
    }
    None
}

// 保留字段按目标 CLI 判断：Claude 导入的未知 TOML 同名字段需原样保留，不能拒绝或跨 CLI 转发。
fn is_reserved_native_field(cli: ExtensionCli, field: &str) -> bool {
    if cli == ExtensionCli::Claude {
        match field {
            "startup_timeout_sec"
            | "tool_timeout_sec"
            | "http_headers"
            | "bearer_token_env_var" => return false,
            "timeout" => return true,
            _ => {}
        }
    }
    [
        "type",
        "command",
        "args",
        "cwd",
        "url",
        "env",
        "headers",
        "http_headers",
        "name",
        "resourceId",
        "schemaVersion",
        "secretRefs",
        "source",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "bearer_token_env_var",
    ]
    .contains(&field)
}

// 检查扩展值是否能表示为 TOML；null 和数组内对象/null 必须显式失败。
fn toml_value_supported(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Array(values) => values
            .iter()
            .all(|value| !matches!(value, Value::Object(_)) && toml_value_supported(value)),
        Value::Object(values) => values.values().all(toml_value_supported),
        _ => true,
    }
}

// 只按 serverKey 排序投影，避免前端传入顺序造成三 CLI 输出漂移。
fn sorted_resources(resources: &[McpResource]) -> Vec<McpResource> {
    let mut sorted = resources.to_vec();
    sorted.sort_by(|left, right| left.server_key.cmp(&right.server_key));
    sorted
}

// 适配器输出中的 canonical-only 字段统一列出，供高级预览解释字段去向。
fn omitted_fields() -> Vec<String> {
    [
        "schemaVersion",
        "resourceId",
        "name",
        "source",
        "secretRefs",
        "perCliExtensions.otherCli",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

// 将投影原文脱敏后返回 IPC；JSON/TOML 解析失败仍返回稳定错误而不泄漏正文。
pub(crate) fn redact_projected_content(cli: ExtensionCli, source: &str) -> Result<String, String> {
    match cli {
        ExtensionCli::Claude => {
            let value: Value = serde_json::from_str(source)
                .map_err(|_| "extensions_json_serialize_failed".to_string())?;
            let redacted = redact_json_native(value, false);
            serde_json::to_string_pretty(&redacted)
                .map_err(|_| "extensions_json_serialize_failed".to_string())
        }
        ExtensionCli::Codex | ExtensionCli::Grok => {
            let value: toml::Value = toml::from_str(source)
                .map_err(|_| "extensions_toml_serialize_failed".to_string())?;
            let redacted = redact_toml_native(value, false);
            toml::to_string_pretty(&redacted)
                .map_err(|_| "extensions_toml_serialize_failed".to_string())
        }
    }
}

// 脱敏 JSON 的 MCP 节点与敏感字段，同时保留非敏感根级配置以便审阅。
fn redact_json_native(value: Value, force: bool) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, child)| {
                    if key == CLAUDE_MCP_ROOT {
                        (key, redact_json_mcp_servers(child))
                    } else {
                        let child_force = force || is_sensitive_config_key(&key);
                        (key, redact_json_native(child, child_force))
                    }
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_json_native(value, force))
                .collect(),
        ),
        Value::String(text) if force || is_sensitive_text(&text) => {
            Value::String("[redacted]".to_string())
        }
        value => value,
    }
}

// 对 MCP 服务表逐项处理；未知厂商字段全部按不透明值脱敏，避免预览泄漏扩展秘密。
fn redact_json_mcp_servers(value: Value) -> Value {
    match value {
        Value::Object(servers) => Value::Object(
            servers
                .into_iter()
                .map(|(key, value)| (key, redact_json_mcp_entry(value)))
                .collect(),
        ),
        value => redact_json_native(value, true),
    }
}

// 保留 MCP 的非秘密标准字段；env、headers、secretRefs 和未知字段始终脱敏。
fn redact_json_mcp_entry(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, child)| {
                    let force = matches!(key.as_str(), "env" | "headers" | "secretRefs" | "source")
                        || !is_known_json_mcp_field(&key);
                    (key, redact_json_native(child, force))
                })
                .collect(),
        ),
        value => redact_json_native(value, true),
    }
}

// 判断 JSON 条目中的字段是否属于可读回的规范字段。
fn is_known_json_mcp_field(key: &str) -> bool {
    [
        "type",
        "command",
        "args",
        "cwd",
        "url",
        "env",
        "headers",
        "name",
        "resourceId",
        "schemaVersion",
        "secretRefs",
        "source",
        "timeout",
    ]
    .contains(&key)
}

// 脱敏 TOML 的 MCP 节点与敏感字段；非扩展设置继续保留。
fn redact_toml_native(value: toml::Value, force: bool) -> toml::Value {
    match value {
        toml::Value::Table(table) => toml::Value::Table(
            table
                .into_iter()
                .map(|(key, child)| {
                    if key == TOML_MCP_ROOT {
                        (key, redact_toml_mcp_servers(child))
                    } else {
                        let child_force = force || is_sensitive_config_key(&key);
                        (key, redact_toml_native(child, child_force))
                    }
                })
                .collect(),
        ),
        toml::Value::Array(values) => toml::Value::Array(
            values
                .into_iter()
                .map(|value| redact_toml_native(value, force))
                .collect(),
        ),
        toml::Value::String(text) if force || is_sensitive_text(&text) => {
            toml::Value::String("[redacted]".to_string())
        }
        value => value,
    }
}

// 对 TOML MCP 服务表逐项处理；未知厂商字段不返回原始字符串。
fn redact_toml_mcp_servers(value: toml::Value) -> toml::Value {
    match value {
        toml::Value::Table(servers) => toml::Value::Table(
            servers
                .into_iter()
                .map(|(key, value)| (key, redact_toml_mcp_entry(value)))
                .collect(),
        ),
        value => redact_toml_native(value, true),
    }
}

// 保留 TOML MCP 的安全标准字段，强制隐藏认证、来源和未知扩展值。
fn redact_toml_mcp_entry(value: toml::Value) -> toml::Value {
    match value {
        toml::Value::Table(table) => toml::Value::Table(
            table
                .into_iter()
                .map(|(key, child)| {
                    let force = matches!(
                        key.as_str(),
                        "env"
                            | "headers"
                            | "http_headers"
                            | "secretRefs"
                            | "source"
                            | "bearer_token_env_var"
                    ) || !is_known_toml_mcp_field(&key);
                    (key, redact_toml_native(child, force))
                })
                .collect(),
        ),
        value => redact_toml_native(value, true),
    }
}

// 判断 TOML 条目中的字段是否属于适配器已知字段。
fn is_known_toml_mcp_field(key: &str) -> bool {
    [
        "type",
        "command",
        "args",
        "cwd",
        "url",
        "env",
        "headers",
        "http_headers",
        "name",
        "resourceId",
        "schemaVersion",
        "secretRefs",
        "source",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "bearer_token_env_var",
    ]
    .contains(&key)
}

// 识别需要递归脱敏的配置键，同时不把所有无关根级设置变成空白。
fn is_sensitive_config_key(key: &str) -> bool {
    key.eq_ignore_ascii_case("env")
        || key.eq_ignore_ascii_case("headers")
        || key.eq_ignore_ascii_case("http_headers")
        || super::model::is_secret_key_for_adapter(key)
}

// 识别标准字段值中的明显秘密或带用户信息的 URL。
fn is_sensitive_text(value: &str) -> bool {
    super::model::is_secret_key_for_adapter(value) || value.contains("@") && value.contains("://")
}

// 按目标 CLI 选择原生预览格式；canonical JSON 不在此处生成可编辑副本。
fn format_for(cli: ExtensionCli) -> McpConfigFormat {
    match cli {
        ExtensionCli::Claude => McpConfigFormat::Json,
        ExtensionCli::Codex | ExtensionCli::Grok => McpConfigFormat::Toml,
    }
}

// 检查 Codex 秒级 timeout 是否会丢失毫秒精度。
fn has_non_second_timeout(timeout: Option<&McpTimeout>) -> bool {
    timeout.is_some_and(|timeout| {
        timeout.startup_ms.is_some_and(|value| value % 1000 != 0)
            || timeout.request_ms.is_some_and(|value| value % 1000 != 0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::model::{McpResourceSource, MCP_MODEL_SCHEMA_VERSION};

    // 复现 Claude 导入成功、项目 MCP 投影却拒绝其他 CLI 同名字段的不对称行为。
    #[test]
    fn claude_unknown_timeout_survives_import_and_project_projection() {
        let source = r#"{"mcpServers":{"filesystem":{"command":"node","args":["server.js"],"startup_timeout_sec":60}}}"#;
        let parsed = parse_claude_json(source).unwrap();
        let content =
            project_native_config_for_launch(ExtensionCli::Claude, &parsed.resources).unwrap();
        let output: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            output["mcpServers"]["filesystem"]["startup_timeout_sec"],
            60
        );
        assert_eq!(
            parse_claude_json(&content).unwrap().resources[0].per_cli_extensions,
            parsed.resources[0].per_cli_extensions
        );
        let codex =
            project_native_config_for_launch(ExtensionCli::Codex, &parsed.resources).unwrap();
        assert!(!codex.contains("startup_timeout_sec"));
    }

    // 目标字段冲突仍拒绝；放行 Claude 未知字段不等于允许覆盖 command 或 Codex 规范超时。
    #[test]
    fn reserved_fields_are_target_specific_without_allowing_canonical_overrides() {
        for cli in ExtensionCli::all() {
            let mut resource = safe_stdio_resource();
            resource.per_cli_extensions.insert(
                cli.key().to_string(),
                Map::from_iter([("command".into(), Value::String("other".into()))]),
            );
            assert!(project_native_config_for_launch(cli, &[resource])
                .unwrap_err()
                .contains("reserved_cli_extension_field"));
        }
        for cli in [ExtensionCli::Codex, ExtensionCli::Grok] {
            assert!(is_reserved_native_field(cli, "startup_timeout_sec"));
            assert!(is_reserved_native_field(cli, "http_headers"));
        }
        for field in [
            "startup_timeout_sec",
            "tool_timeout_sec",
            "http_headers",
            "bearer_token_env_var",
        ] {
            assert!(!is_reserved_native_field(ExtensionCli::Claude, field));
        }
        assert!(is_reserved_native_field(ExtensionCli::Claude, "timeout"));
    }

    // 显式选择主库/项目后，仅只读重放已保存的 MCP 投影；不生成文件、不开 CLI、不输出配置秘密。
    #[tokio::test]
    #[ignore = "requires EXTENSION_AUDIT_DB and EXTENSION_AUDIT_PROJECT; read-only saved-data audit"]
    async fn saved_project_mcp_projection_read_only() {
        use sqlx::{Connection, Row};
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(std::env::var("EXTENSION_AUDIT_DB").expect("audit database required"))
            .read_only(true);
        let mut connection = sqlx::SqliteConnection::connect_with(&options)
            .await
            .unwrap();
        let project = std::env::var("EXTENSION_AUDIT_PROJECT").expect("audit project required");
        let row = sqlx::query("SELECT selected_ids_json FROM extension_scope_policies WHERE scope_kind='project' AND scope_id=? AND cli='claude' AND extension_kind='mcp' AND mode='custom'")
            .bind(project).fetch_one(&mut connection).await.unwrap();
        let ids: Vec<String> =
            serde_json::from_str(row.get::<&str, _>("selected_ids_json")).unwrap();
        let mut resources = Vec::new();
        for id in &ids {
            let row = sqlx::query(
                "SELECT definition_json FROM extension_mcp_resources WHERE resource_id=?",
            )
            .bind(id)
            .fetch_one(&mut connection)
            .await
            .unwrap();
            let mut resource: McpResource =
                serde_json::from_str(row.get::<&str, _>("definition_json")).unwrap();
            resource.enabled_by_cli.insert("claude".into(), true);
            resources.push(resource);
        }
        let content = project_native_config_for_launch(ExtensionCli::Claude, &resources).unwrap();
        let output: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(output["mcpServers"].as_object().unwrap().len(), ids.len());
    }

    // 构造含环境变量和来源信息的 stdio 资源，验证脱敏与投影边界。
    fn stdio_resource() -> McpResource {
        McpResource {
            schema_version: MCP_MODEL_SCHEMA_VERSION,
            resource_id: derive_resource_id("demo"),
            server_key: "demo".to_string(),
            name: "demo".to_string(),
            transport: McpTransport::Stdio,
            command: Some("node".to_string()),
            args: vec!["server.js".to_string()],
            cwd: None,
            url: None,
            env: BTreeMap::from([("TOKEN".to_string(), "secret".to_string())]),
            headers: BTreeMap::new(),
            secret_refs: BTreeMap::from([("env:TOKEN".to_string(), "keychain/demo".to_string())]),
            timeout: None,
            per_cli_extensions: BTreeMap::new(),
            enabled_by_cli: default_enabled_by_cli(),
            source: Some(McpResourceSource {
                kind: "test".to_string(),
                identity: "test:demo".to_string(),
                label: None,
            }),
            extra: BTreeMap::new(),
        }
    }

    // 构造含 Authorization header 的网络资源，覆盖网络传输校验。
    fn network_resource() -> McpResource {
        McpResource {
            transport: McpTransport::StreamableHttp,
            command: None,
            args: Vec::new(),
            cwd: None,
            url: Some("https://example.test/mcp".to_string()),
            headers: BTreeMap::from([("Authorization".to_string(), "secret".to_string())]),
            env: BTreeMap::new(),
            secret_refs: BTreeMap::from([(
                "header:Authorization".to_string(),
                "keychain/demo".to_string(),
            )]),
            ..stdio_resource()
        }
    }

    // 移除秘密和来源后构造可直接跨三个 CLI 投影的 stdio 资源。
    fn safe_stdio_resource() -> McpResource {
        let mut resource = stdio_resource();
        resource.env.clear();
        resource.secret_refs.clear();
        resource.source = None;
        resource
    }

    // 移除 header 和来源后构造可直接跨三个 CLI 投影的网络资源。
    fn safe_network_resource() -> McpResource {
        let mut resource = network_resource();
        resource.headers.clear();
        resource.secret_refs.clear();
        resource.source = None;
        resource
    }

    #[test]
    // 验证 Claude 投影保留无关根字段，并可读回为相同 stdio 语义。
    fn claude_projection_round_trips_without_touching_unrelated_fields() {
        let source = r#"{"theme":"dark","mcpServers":{"old":{"command":"old"}}}"#;
        let preview =
            project_native_config(ExtensionCli::Claude, source, &[stdio_resource()]).unwrap();
        assert!(matches!(preview.status, ProjectionStatus::Ready));
        assert!(!preview.content.contains("secret"));
        let parsed = parse_native_config(ExtensionCli::Claude, &preview.content).unwrap();
        assert_eq!(parsed.resources[0].server_key, "demo");
        assert_eq!(parsed.resources[0].command.as_deref(), Some("node"));
        let value: Value = serde_json::from_str(&preview.content).unwrap();
        assert_eq!(value.get("theme").and_then(Value::as_str), Some("dark"));
    }

    #[test]
    // 验证 Codex 使用 http_headers 与秒级 timeout，并拒绝不可整秒表达的 timeout。
    fn codex_projection_maps_headers_and_reports_timeout_precision() {
        let mut resource = network_resource();
        resource.timeout = Some(McpTimeout {
            startup_ms: Some(2500),
            request_ms: None,
        });
        let preview = project_native_config(ExtensionCli::Codex, "[other]\nvalue=1\n", &[resource]);
        let preview = preview.unwrap();
        assert!(matches!(preview.status, ProjectionStatus::Unsupported));
        assert!(preview
            .issues
            .iter()
            .any(|issue| issue.code == "timeout_unit_not_representable"));
    }

    #[test]
    // 验证 Codex 与 Grok 不会接收其它 CLI 的 perCliExtensions。
    fn projection_isolates_cli_extensions() {
        let mut resource = stdio_resource();
        resource.per_cli_extensions.insert(
            "claude".to_string(),
            Map::from_iter([("x-claude".to_string(), Value::String("yes".to_string()))]),
        );
        resource.per_cli_extensions.insert(
            "codex".to_string(),
            Map::from_iter([("x-codex".to_string(), Value::String("yes".to_string()))]),
        );
        let preview = project_native_config(ExtensionCli::Codex, "", &[resource]).unwrap();
        assert!(preview.content.contains("x-codex"));
        assert!(!preview.content.contains("x-claude"));
    }

    #[test]
    // 验证同一 stdio 资源经过三个 CLI 投影后仍保留命令、参数和传输语义。
    fn all_cli_stdio_projection_round_trips() {
        let resource = safe_stdio_resource();
        for cli in ExtensionCli::all() {
            let base = match cli {
                ExtensionCli::Claude => "{}",
                ExtensionCli::Codex | ExtensionCli::Grok => "",
            };
            let preview =
                project_native_config(cli, base, std::slice::from_ref(&resource)).unwrap();
            assert!(matches!(preview.status, ProjectionStatus::Ready));
            let parsed = parse_native_config(cli, &preview.content).unwrap();
            assert_eq!(parsed.resources[0].transport, McpTransport::Stdio);
            assert_eq!(parsed.resources[0].command, resource.command);
            assert_eq!(parsed.resources[0].args, resource.args);
        }
    }

    #[test]
    // 全局开关只影响目标 CLI 投影；关闭后应删除该 CLI 的 MCP 条目而不改变其它目标。
    fn projection_omits_resource_when_cli_switch_is_disabled() {
        let mut resource = safe_stdio_resource();
        resource.enabled_by_cli.insert("codex".to_string(), false);
        let claude =
            project_native_config(ExtensionCli::Claude, "{}", std::slice::from_ref(&resource))
                .unwrap();
        let codex = project_native_config(ExtensionCli::Codex, "", std::slice::from_ref(&resource))
            .unwrap();
        assert!(claude.content.contains("demo"));
        assert!(!codex.content.contains("demo"));
        assert!(codex.resources.is_empty());
    }

    #[test]
    // 验证网络资源在 Claude、Codex、Grok 的 URL 投影中读回统一为 streamableHttp。
    fn all_cli_network_projection_round_trips() {
        let resource = safe_network_resource();
        for cli in ExtensionCli::all() {
            let base = match cli {
                ExtensionCli::Claude => "{}",
                ExtensionCli::Codex | ExtensionCli::Grok => "",
            };
            let preview =
                project_native_config(cli, base, std::slice::from_ref(&resource)).unwrap();
            assert!(matches!(preview.status, ProjectionStatus::Ready));
            let parsed = parse_native_config(cli, &preview.content).unwrap();
            assert_eq!(parsed.resources[0].transport, McpTransport::StreamableHttp);
            assert_eq!(parsed.resources[0].url, resource.url);
        }
    }

    #[test]
    // 验证 Grok 的 SSE 需要显式 type 字段，否则 URL 推断会错误变成 HTTP。
    fn grok_sse_projection_preserves_transport() {
        let mut resource = safe_network_resource();
        resource.transport = McpTransport::Sse;
        let preview = project_native_config(ExtensionCli::Grok, "", &[resource]).unwrap();
        assert!(matches!(preview.status, ProjectionStatus::Ready));
        let parsed = parse_native_config(ExtensionCli::Grok, &preview.content).unwrap();
        assert_eq!(parsed.resources[0].transport, McpTransport::Sse);
    }

    #[test]
    // 验证 Codex 只在整秒边界映射毫秒 timeout，读回后不改变单位语义。
    fn codex_timeout_round_trips_at_second_precision() {
        let mut resource = safe_network_resource();
        resource.timeout = Some(McpTimeout {
            startup_ms: Some(2000),
            request_ms: Some(3000),
        });
        let preview = project_native_config(ExtensionCli::Codex, "", &[resource]).unwrap();
        assert!(matches!(preview.status, ProjectionStatus::Ready));
        let parsed = parse_native_config(ExtensionCli::Codex, &preview.content).unwrap();
        assert_eq!(
            parsed.resources[0].timeout,
            Some(McpTimeout {
                startup_ms: Some(2000),
                request_ms: Some(3000),
            })
        );
    }

    #[test]
    // 验证投影只替换 MCP 节点，根级设置和已有 MCP 未知字段仍保持可读。
    fn projection_preserves_unrelated_and_unknown_fields() {
        let source = r#"{
            "theme": "dark",
            "mcpServers": {
                "demo": {
                    "command": "old",
                    "x-vendor": {"enabled": true, "opaque": "opaque-secret"}
                }
            }
        }"#;
        let preview =
            project_native_config(ExtensionCli::Claude, source, &[safe_stdio_resource()]).unwrap();
        assert!(!preview.content.contains("opaque-secret"));
        let value: Value = serde_json::from_str(&preview.content).unwrap();
        assert_eq!(value.get("theme").and_then(Value::as_str), Some("dark"));
        assert_eq!(
            value["mcpServers"]["demo"]["x-vendor"]["enabled"],
            Value::Bool(true)
        );
        assert_eq!(
            value["mcpServers"]["demo"]["x-vendor"]["opaque"],
            Value::String("[redacted]".to_string())
        );
        let parsed = parse_native_config(ExtensionCli::Claude, &preview.content).unwrap();
        assert_eq!(
            parsed.resources[0].per_cli_extensions["claude"]["x-vendor"]["enabled"],
            Value::Bool(true)
        );
    }

    #[test]
    // 验证 TOML 未知嵌套值完整保留，不能因 JSON 转换失败而静默丢字段。
    fn toml_unknown_fields_are_preserved_without_silent_drop() {
        let source = r#"
            [mcp_servers.demo]
            command = "node"
            x_vendor = { enabled = true, labels = ["one", "two"] }
        "#;
        let parsed = parse_native_config(ExtensionCli::Codex, source).unwrap();
        assert_eq!(
            parsed.resources[0].per_cli_extensions["codex"]["x_vendor"]["labels"],
            serde_json::json!(["one", "two"])
        );
    }

    #[test]
    // 验证 Codex bearer token 环境变量被转成规范 secretRef，并可重新投影。
    fn codex_bearer_token_env_ref_round_trips() {
        let source = r#"
            [mcp_servers.demo]
            url = "https://example.test/mcp"
            bearer_token_env_var = "MCP_TOKEN"
        "#;
        let parsed = parse_native_config(ExtensionCli::Codex, source).unwrap();
        assert_eq!(
            parsed.resources[0].secret_refs["header:Authorization"],
            "MCP_TOKEN"
        );
        let preview = project_native_config(
            ExtensionCli::Codex,
            "",
            &[safe_network_resource_with_ref("MCP_TOKEN")],
        )
        .unwrap();
        assert!(preview.content.contains("bearer_token_env_var"));
        assert!(preview.content.contains("[redacted]"));
    }

    #[test]
    // 验证 TOML 无法表达的数组内对象在预览阶段返回结构化 unsupported，而非半写入。
    fn toml_extension_array_of_objects_is_unsupported() {
        let mut resource = safe_stdio_resource();
        resource.per_cli_extensions.insert(
            "codex".to_string(),
            Map::from_iter([(
                "profiles".to_string(),
                serde_json::json!([{"name": "demo"}]),
            )]),
        );
        let preview = project_native_config(ExtensionCli::Codex, "", &[resource]).unwrap();
        assert!(matches!(preview.status, ProjectionStatus::Unsupported));
        assert!(preview
            .issues
            .iter()
            .any(|issue| issue.code == "toml_extension_not_representable"));
    }

    // 为 Codex bearer token 投影补回外部 secretRef，但不携带 token 原文。
    fn safe_network_resource_with_ref(reference: &str) -> McpResource {
        let mut resource = safe_network_resource();
        resource
            .secret_refs
            .insert("header:Authorization".to_string(), reference.to_string());
        resource
    }
}
