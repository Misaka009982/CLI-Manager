use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const MCP_MODEL_SCHEMA_VERSION: u32 = 1;
const MAX_IDENTIFIER_LENGTH: usize = 128;
const MAX_TEXT_LENGTH: usize = 16 * 1024;
const MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;
const REDACTED_VALUE: &str = "[redacted]";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionCli {
    Claude,
    Codex,
    #[serde(alias = "grokbuild")]
    Grok,
}

impl ExtensionCli {
    // 返回 CLI 的稳定配置键；该键同时用于 perCliExtensions 的命名空间。
    pub fn key(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Grok => "grok",
        }
    }

    // 返回面向设置界面的稳定显示名，不依赖本机是否安装对应 CLI。
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Grok => "Grok",
        }
    }

    // 将外部 CLI 标识规范化为统一枚举；未知值由调用方转换为 IPC 错误。
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "grok" | "grokbuild" | "grok-build" => Some(Self::Grok),
            _ => None,
        }
    }

    // 返回固定顺序的三个受支持本机 CLI，保证能力矩阵和前端列表稳定。
    pub fn all() -> [Self; 3] {
        [Self::Claude, Self::Codex, Self::Grok]
    }
}

// 为旧版 canonical 记录提供三个 CLI 默认开启状态；全局页后续可逐项关闭。
pub(crate) fn default_enabled_by_cli() -> BTreeMap<String, bool> {
    ExtensionCli::all()
        .into_iter()
        .map(|cli| (cli.key().to_string(), true))
        .collect()
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    Stdio,
    Sse,
    #[serde(alias = "http")]
    StreamableHttp,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum McpConfigFormat {
    Json,
    Toml,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTimeout {
    pub startup_ms: Option<u64>,
    pub request_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceSource {
    pub kind: String,
    pub identity: String,
    pub label: Option<String>,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub resource_id: String,
    pub server_key: String,
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_refs: BTreeMap<String, String>,
    pub timeout: Option<McpTimeout>,
    #[serde(default)]
    pub per_cli_extensions: BTreeMap<String, Map<String, Value>>,
    #[serde(default = "default_enabled_by_cli")]
    pub enabled_by_cli: BTreeMap<String, bool>,
    pub source: Option<McpResourceSource>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceRedacted {
    pub schema_version: u32,
    pub resource_id: String,
    pub server_key: String,
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub env: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
    pub secret_refs: BTreeMap<String, String>,
    pub timeout: Option<McpTimeout>,
    pub per_cli_extensions: BTreeMap<String, Map<String, Value>>,
    pub enabled_by_cli: BTreeMap<String, bool>,
    pub source: Option<McpResourceSource>,
    pub extra: BTreeMap<String, Value>,
    pub redacted_fields: Vec<String>,
}

impl McpResource {
    // 返回资源在目标 CLI 的全局开关；缺少旧记录字段时保持兼容并默认开启。
    pub fn enabled_for(&self, cli: ExtensionCli) -> bool {
        self.enabled_by_cli.get(cli.key()).copied().unwrap_or(true)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpValidationIssue {
    pub code: String,
    pub field: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpValidationReport {
    pub valid: bool,
    pub issues: Vec<McpValidationIssue>,
}

pub type CapabilityStatus = &'static str;
pub const CAPABILITY_STATUS_SUPPORTED: CapabilityStatus = "supported";

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityFieldStatus {
    Supported,
    Unsupported,
    CanonicalOnly,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCapabilityField {
    pub status: CapabilityFieldStatus,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCliCapability {
    pub cli: ExtensionCli,
    pub display_name: &'static str,
    pub format: McpConfigFormat,
    pub root_key: &'static str,
    pub version: Option<String>,
    pub status: CapabilityStatus,
    pub transports: Vec<McpTransport>,
    pub fields: BTreeMap<String, McpCapabilityField>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectionStatus {
    Ready,
    Unsupported,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProjectionIssue {
    pub code: String,
    pub field: String,
    pub resource_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProjectionPreview {
    pub cli: ExtensionCli,
    pub format: McpConfigFormat,
    pub status: ProjectionStatus,
    pub content: String,
    pub resources: Vec<McpResourceRedacted>,
    pub issues: Vec<McpProjectionIssue>,
    pub omitted_fields: Vec<String>,
    pub changed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpNativeConfigPreview {
    pub cli: ExtensionCli,
    pub format: McpConfigFormat,
    pub resources: Vec<McpResourceRedacted>,
}

// 为省略版本字段的旧输入提供当前规范版本，写回时仍由调用方显式校验。
fn default_schema_version() -> u32 {
    MCP_MODEL_SCHEMA_VERSION
}

// 根据 serverKey 生成跨 CLI 稳定的默认 ID；配置正文和秘密值不会进入哈希输入。
pub fn derive_resource_id(server_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"cli-manager:mcp-resource:");
    hasher.update(server_key.as_bytes());
    let digest = hasher.finalize();
    let suffix = digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("mcp-{suffix}")
}

// 在 IPC 与写库前执行统一字段校验，返回稳定错误码而不是原始配置内容。
pub fn validate_resource(resource: &McpResource) -> Vec<McpValidationIssue> {
    let mut issues = Vec::new();
    if resource.schema_version != MCP_MODEL_SCHEMA_VERSION {
        issues.push(issue("unsupported_schema_version", "schemaVersion"));
    }
    validate_identifier(&mut issues, "resourceId", &resource.resource_id, false);
    validate_identifier(&mut issues, "serverKey", &resource.server_key, true);
    validate_text(&mut issues, "name", &resource.name, true);

    if resource
        .command
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        issues.push(issue("empty_command", "command"));
    }
    if let Some(command) = resource.command.as_deref() {
        validate_text(&mut issues, "command", command, false);
    }
    for (index, argument) in resource.args.iter().enumerate() {
        validate_text(&mut issues, &format!("args[{index}]"), argument, false);
    }
    if let Some(cwd) = resource.cwd.as_deref() {
        validate_text(&mut issues, "cwd", cwd, false);
    }
    if let Some(url) = resource.url.as_deref() {
        validate_url(&mut issues, "url", url);
    }
    validate_string_map(&mut issues, "env", &resource.env);
    validate_string_map(&mut issues, "headers", &resource.headers);
    validate_secret_refs(&mut issues, &resource.secret_refs);
    validate_timeout(&mut issues, resource.timeout.as_ref());
    validate_extensions(&mut issues, resource);
    validate_enabled_by_cli(&mut issues, resource);
    validate_source(&mut issues, resource.source.as_ref());

    match resource.transport {
        McpTransport::Stdio => {
            if resource
                .command
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
            {
                issues.push(issue("stdio_command_required", "command"));
            }
            if resource.url.is_some() {
                issues.push(issue("stdio_url_not_allowed", "url"));
            }
            if !resource.headers.is_empty() {
                issues.push(issue("stdio_headers_not_allowed", "headers"));
            }
        }
        McpTransport::Sse | McpTransport::StreamableHttp => {
            if resource
                .url
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
            {
                issues.push(issue("network_url_required", "url"));
            }
            if resource.command.is_some() {
                issues.push(issue("network_command_not_allowed", "command"));
            }
            if !resource.args.is_empty() {
                issues.push(issue("network_args_not_allowed", "args"));
            }
            if resource.cwd.is_some() {
                issues.push(issue("network_cwd_not_allowed", "cwd"));
            }
        }
    }

    issues
}

// 将校验结果包装成前端可直接展示的报告，保持 valid 与 issues 一致。
pub fn validation_report(resource: &McpResource) -> McpValidationReport {
    let issues = validate_resource(resource);
    McpValidationReport {
        valid: issues.is_empty(),
        issues,
    }
}

// 将资源转换成可安全跨 IPC 返回的 DTO；环境变量、请求头和厂商扩展值不返回原文。
pub fn redact_resource(resource: &McpResource) -> McpResourceRedacted {
    let mut redacted_fields = Vec::new();
    let env = redact_string_map(&resource.env, "env", &mut redacted_fields);
    let headers = redact_string_map(&resource.headers, "headers", &mut redacted_fields);
    let secret_refs = resource
        .secret_refs
        .keys()
        .map(|key| {
            redacted_fields.push(format!("secretRefs.{key}"));
            (key.clone(), REDACTED_VALUE.to_string())
        })
        .collect();
    let per_cli_extensions = resource
        .per_cli_extensions
        .iter()
        .map(|(cli, values)| {
            (
                cli.clone(),
                values
                    .iter()
                    .map(|(key, value)| {
                        redacted_fields.push(format!("perCliExtensions.{cli}.{key}"));
                        (key.clone(), redact_value(value, true, &mut redacted_fields))
                    })
                    .collect(),
            )
        })
        .collect();
    let extra = resource
        .extra
        .iter()
        .map(|(key, value)| (key.clone(), redact_value(value, true, &mut redacted_fields)))
        .collect();

    McpResourceRedacted {
        schema_version: resource.schema_version,
        resource_id: resource.resource_id.clone(),
        server_key: resource.server_key.clone(),
        name: resource.name.clone(),
        transport: resource.transport,
        command: resource.command.as_deref().map(redact_text),
        args: resource
            .args
            .iter()
            .map(|value| redact_text(value))
            .collect(),
        cwd: resource.cwd.as_deref().map(redact_text),
        url: resource.url.as_deref().map(redact_text),
        env,
        headers,
        secret_refs,
        timeout: resource.timeout.clone(),
        per_cli_extensions,
        enabled_by_cli: resource.enabled_by_cli.clone(),
        source: resource.source.as_ref().map(|source| McpResourceSource {
            kind: source.kind.clone(),
            identity: redact_text(&source.identity),
            label: source.label.as_deref().map(redact_text),
        }),
        extra,
        redacted_fields,
    }
}

// 返回三个 CLI 的静态能力矩阵；动态版本探测和环境能力在后续项目任务中叠加。
pub fn capability_matrix() -> Vec<McpCliCapability> {
    ExtensionCli::all()
        .into_iter()
        .map(|cli| {
            let (format, root_key, transports, timeout_status, timeout_note) = match cli {
                ExtensionCli::Claude => (
                    McpConfigFormat::Json,
                    "mcpServers",
                    vec![
                        McpTransport::Stdio,
                        McpTransport::Sse,
                        McpTransport::StreamableHttp,
                    ],
                    CapabilityFieldStatus::Unsupported,
                    Some("timeout_not_supported"),
                ),
                ExtensionCli::Codex => (
                    McpConfigFormat::Toml,
                    "mcp_servers",
                    vec![McpTransport::Stdio, McpTransport::StreamableHttp],
                    CapabilityFieldStatus::Supported,
                    Some("timeout_whole_seconds_only"),
                ),
                ExtensionCli::Grok => (
                    McpConfigFormat::Toml,
                    "mcp_servers",
                    vec![
                        McpTransport::Stdio,
                        McpTransport::Sse,
                        McpTransport::StreamableHttp,
                    ],
                    CapabilityFieldStatus::Unsupported,
                    Some("timeout_not_supported"),
                ),
            };
            let mut fields = BTreeMap::new();
            for field in [
                "command",
                "args",
                "cwd",
                "url",
                "env",
                "headers",
                "transport",
            ] {
                fields.insert(field.to_string(), supported_field());
            }
            fields.insert(
                "name".to_string(),
                canonical_field("canonical_display_label"),
            );
            fields.insert(
                "resourceId".to_string(),
                canonical_field("canonical_identity"),
            );
            fields.insert(
                "schemaVersion".to_string(),
                canonical_field("canonical_format_metadata"),
            );
            fields.insert(
                "source".to_string(),
                canonical_field("canonical_source_provenance"),
            );
            fields.insert(
                "secretRefs".to_string(),
                canonical_field("canonical_secret_reference"),
            );
            fields.insert(
                "perCliExtensions".to_string(),
                canonical_field("target_cli_namespace_only"),
            );
            fields.insert(
                "timeout.startupMs".to_string(),
                McpCapabilityField {
                    status: timeout_status,
                    note: timeout_note.map(str::to_string),
                },
            );
            fields.insert(
                "timeout.requestMs".to_string(),
                McpCapabilityField {
                    status: timeout_status,
                    note: timeout_note.map(str::to_string),
                },
            );
            McpCliCapability {
                cli,
                display_name: cli.display_name(),
                format,
                root_key,
                version: None,
                status: CAPABILITY_STATUS_SUPPORTED,
                transports,
                fields,
            }
        })
        .collect()
}

// 判断某 CLI 是否原生接受指定传输类型，适配器据此生成明确 unsupported 结果。
pub fn cli_supports_transport(cli: ExtensionCli, transport: McpTransport) -> bool {
    capability_matrix()
        .into_iter()
        .find(|capability| capability.cli == cli)
        .is_some_and(|capability| capability.transports.contains(&transport))
}

// 构造不携带原始配置内容的稳定校验问题。
fn issue(code: &str, field: &str) -> McpValidationIssue {
    McpValidationIssue {
        code: code.to_string(),
        field: field.to_string(),
    }
}

// 校验 resourceId/serverKey 的长度、控制字符及 serverKey 可移植字符集。
fn validate_identifier(
    issues: &mut Vec<McpValidationIssue>,
    field: &str,
    value: &str,
    strict_server_key: bool,
) {
    if value.is_empty() {
        issues.push(issue("required", field));
        return;
    }
    if value.len() > MAX_IDENTIFIER_LENGTH || value.chars().any(|ch| ch.is_control()) {
        issues.push(issue("invalid_identifier", field));
    }
    if strict_server_key
        && !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        issues.push(issue("invalid_server_key", field));
    }
}

// 校验用户可见文本的长度与控制字符，避免配置正文被当成错误协议返回。
fn validate_text(issues: &mut Vec<McpValidationIssue>, field: &str, value: &str, required: bool) {
    if required && value.trim().is_empty() {
        issues.push(issue("required", field));
    }
    if value.len() > MAX_TEXT_LENGTH || value.chars().any(|ch| ch.is_control()) {
        issues.push(issue("invalid_text", field));
    }
}

// 只接受包含非空 scheme/authority 的 URL，并拒绝空白字符。
fn validate_url(issues: &mut Vec<McpValidationIssue>, field: &str, value: &str) {
    validate_text(issues, field, value, false);
    let has_scheme = value
        .split_once("://")
        .is_some_and(|(scheme, rest)| !scheme.is_empty() && !rest.trim().is_empty());
    if !has_scheme || value.chars().any(char::is_whitespace) {
        issues.push(issue("invalid_url", field));
    }
}

// 校验 map 的键和值边界；值可以为空以支持合法的空环境变量。
fn validate_string_map(
    issues: &mut Vec<McpValidationIssue>,
    field: &str,
    values: &BTreeMap<String, String>,
) {
    for (key, value) in values {
        validate_text(issues, &format!("{field}.{key}"), key, true);
        validate_text(issues, &format!("{field}.{key}"), value, false);
    }
}

// 校验 secretRef 的 `env:<name>`/`header:<name>` 形状，不解析或回显引用目标。
fn validate_secret_refs(
    issues: &mut Vec<McpValidationIssue>,
    secret_refs: &BTreeMap<String, String>,
) {
    for (field, reference) in secret_refs {
        let Some((kind, name)) = field.split_once(':') else {
            issues.push(issue(
                "invalid_secret_ref_field",
                &format!("secretRefs.{field}"),
            ));
            continue;
        };
        if reference.trim().is_empty() || name.trim().is_empty() {
            issues.push(issue("invalid_secret_ref", &format!("secretRefs.{field}")));
        }
        if !matches!(kind.to_ascii_lowercase().as_str(), "env" | "header") {
            issues.push(issue(
                "invalid_secret_ref_kind",
                &format!("secretRefs.{field}"),
            ));
        }
    }
}

// 校验语义超时的非空、正值和最大边界。
fn validate_timeout(issues: &mut Vec<McpValidationIssue>, timeout: Option<&McpTimeout>) {
    let Some(timeout) = timeout else {
        return;
    };
    if timeout.startup_ms.is_none() && timeout.request_ms.is_none() {
        issues.push(issue("timeout_empty", "timeout"));
    }
    for (field, value) in [
        ("timeout.startupMs", timeout.startup_ms),
        ("timeout.requestMs", timeout.request_ms),
    ] {
        if value.is_some_and(|value| value == 0 || value > MAX_TIMEOUT_MS) {
            issues.push(issue("invalid_timeout", field));
        }
    }
}

// 校验厂商扩展命名空间与值形状，未知 CLI 不进入可应用投影。
fn validate_extensions(issues: &mut Vec<McpValidationIssue>, resource: &McpResource) {
    for (cli, fields) in &resource.per_cli_extensions {
        if ExtensionCli::parse(cli).is_none() {
            issues.push(issue(
                "unknown_cli_extension",
                &format!("perCliExtensions.{cli}"),
            ));
        }
        if fields.is_empty() {
            continue;
        }
        for (field, value) in fields {
            if value.is_null() {
                issues.push(issue(
                    "null_cli_extension",
                    &format!("perCliExtensions.{cli}.{field}"),
                ));
            }
        }
    }
}

// 只接受三个已知 CLI 的开关键，防止拼写错误形成用户看不见的第四个目标。
fn validate_enabled_by_cli(issues: &mut Vec<McpValidationIssue>, resource: &McpResource) {
    for cli in resource.enabled_by_cli.keys() {
        if !ExtensionCli::all().iter().any(|known| known.key() == cli) {
            issues.push(issue("unknown_cli_enabled", &format!("enabledByCli.{cli}")));
        }
    }
}

// 校验导入来源元数据，但不把来源路径当作可执行配置。
fn validate_source(issues: &mut Vec<McpValidationIssue>, source: Option<&McpResourceSource>) {
    let Some(source) = source else {
        return;
    };
    validate_text(issues, "source.kind", &source.kind, true);
    validate_text(issues, "source.identity", &source.identity, true);
    if let Some(label) = source.label.as_deref() {
        validate_text(issues, "source.label", label, false);
    }
}

// 创建一个没有附加说明的“原生支持”能力字段。
fn supported_field() -> McpCapabilityField {
    McpCapabilityField {
        status: CapabilityFieldStatus::Supported,
        note: None,
    }
}

// 创建只存在于 canonical 模型的字段能力说明。
fn canonical_field(note: &str) -> McpCapabilityField {
    McpCapabilityField {
        status: CapabilityFieldStatus::CanonicalOnly,
        note: Some(note.to_string()),
    }
}

// 保留 map 的键并隐藏所有值，供 env/header/secretRef DTO 使用。
fn redact_string_map(
    values: &BTreeMap<String, String>,
    prefix: &str,
    redacted_fields: &mut Vec<String>,
) -> BTreeMap<String, String> {
    values
        .keys()
        .map(|key| {
            redacted_fields.push(format!("{prefix}.{key}"));
            (key.clone(), REDACTED_VALUE.to_string())
        })
        .collect()
}

// 递归脱敏 JSON 扩展值；force 为真时所有字符串都不返回原文。
fn redact_value(value: &Value, force: bool, redacted_fields: &mut Vec<String>) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, child)| {
                    (
                        key.clone(),
                        redact_value(
                            child,
                            force || is_secret_key_for_adapter(key),
                            redacted_fields,
                        ),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_value(item, force, redacted_fields))
                .collect(),
        ),
        Value::String(text) if force || is_secret_key_for_adapter(text) => {
            redacted_fields.push("value".to_string());
            Value::String(REDACTED_VALUE.to_string())
        }
        _ => value.clone(),
    }
}

pub(crate) fn is_secret_key_for_adapter(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "authorization",
        "credential",
        "private_key",
        "private-key",
        "apikey",
        "api_key",
        "api-key",
        "bearer",
        "cookie",
        "oauth",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

// 隐藏明显秘密文本和带用户信息的 URL，同时保留普通命令/路径的可读性。
fn redact_text(value: &str) -> String {
    if is_secret_key_for_adapter(value) || value.contains('@') && value.contains("://") {
        REDACTED_VALUE.to_string()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 构造覆盖 env、secretRef 和 stdio 约束的最小规范资源。
    fn resource() -> McpResource {
        McpResource {
            schema_version: MCP_MODEL_SCHEMA_VERSION,
            resource_id: derive_resource_id("demo"),
            server_key: "demo".to_string(),
            name: "Demo".to_string(),
            transport: McpTransport::Stdio,
            command: Some("node".to_string()),
            args: vec!["server.js".to_string()],
            cwd: None,
            url: None,
            env: BTreeMap::from([("API_KEY".to_string(), "secret-value".to_string())]),
            headers: BTreeMap::new(),
            secret_refs: BTreeMap::from([("env:API_KEY".to_string(), "keychain/demo".to_string())]),
            timeout: None,
            per_cli_extensions: BTreeMap::new(),
            enabled_by_cli: BTreeMap::new(),
            source: None,
            extra: BTreeMap::new(),
        }
    }

    #[test]
    // 验证默认 ID 只由 serverKey 决定，三个 CLI 导入同名资源可共享身份。
    fn resource_id_is_stable_for_server_key() {
        assert_eq!(derive_resource_id("demo"), derive_resource_id("demo"));
        assert_ne!(derive_resource_id("demo"), derive_resource_id("other"));
    }

    #[test]
    // 验证规范模型拒绝不完整 stdio 定义并保留合法 secretRef 关系。
    fn validation_rejects_incomplete_stdio() {
        let mut value = resource();
        value.command = None;
        let report = validation_report(&value);
        assert!(!report.valid);
        assert!(report
            .issues
            .iter()
            .any(|item| item.code == "stdio_command_required"));
    }

    #[test]
    // 别名不能形成隐形开关键；只有 canonical 的三个 CLI 键可进入持久化模型。
    fn validation_rejects_noncanonical_cli_switch_key() {
        let mut value = resource();
        value.enabled_by_cli.insert("grokbuild".to_string(), false);
        assert!(validate_resource(&value)
            .iter()
            .any(|item| item.code == "unknown_cli_enabled"));
    }

    #[test]
    // 验证脱敏 DTO 不包含环境变量原文、secretRef 内容或扩展中的密钥值。
    fn redaction_never_returns_secret_values() {
        let mut value = resource();
        value.per_cli_extensions.insert(
            "claude".to_string(),
            Map::from_iter([(
                "accessToken".to_string(),
                Value::String("extension-secret".to_string()),
            )]),
        );
        value.extra.insert(
            "vendorData".to_string(),
            serde_json::json!({"opaqueValue": "extra-secret"}),
        );
        let json = serde_json::to_string(&redact_resource(&value)).unwrap();
        assert!(!json.contains("secret-value"));
        assert!(!json.contains("keychain/demo"));
        assert!(!json.contains("extension-secret"));
        assert!(!json.contains("extra-secret"));
    }

    #[test]
    // 验证能力矩阵保持三个 CLI 顺序，并明确 Codex 与 Claude 的超时差异。
    fn capability_matrix_is_explicit() {
        let matrix = capability_matrix();
        assert_eq!(matrix.len(), 3);
        assert_eq!(matrix[0].cli, ExtensionCli::Claude);
        assert!(matches!(
            matrix[1].fields["timeout.startupMs"].status,
            CapabilityFieldStatus::Supported
        ));
        assert!(matches!(
            matrix[0].fields["timeout.startupMs"].status,
            CapabilityFieldStatus::Unsupported
        ));
    }
}
