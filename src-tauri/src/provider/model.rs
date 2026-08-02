use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CliType {
    Claude,
    Codex,
    Grok,
}

impl CliType {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Grok => "grok",
        }
    }

    pub(crate) fn config_format(self) -> &'static str {
        match self {
            Self::Claude => "json",
            Self::Codex | Self::Grok => "toml",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "grok" => Ok(Self::Grok),
            _ => Err("provider_cli_type_invalid".to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProviderStatus {
    Draft,
    Ready,
    Disabled,
}

impl ProviderStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Ready => "ready",
            Self::Disabled => "disabled",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "draft" => Ok(Self::Draft),
            "ready" => Ok(Self::Ready),
            "disabled" => Ok(Self::Disabled),
            _ => Err("provider_status_invalid".to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderKeySummary {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub has_secret: bool,
    pub secret_hint: String,
    pub fingerprint: String,
    pub is_active: bool,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderSummary {
    pub id: String,
    pub cli_type: CliType,
    pub name: String,
    pub status: ProviderStatus,
    pub config_format: String,
    pub inherit_common: bool,
    pub sort_order: i64,
    pub key_count: i64,
    pub active_key_id: Option<String>,
    pub active_key_hint: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderDetail {
    #[serde(flatten)]
    pub summary: ProviderSummary,
    pub config_text: String,
    pub keys: Vec<ProviderKeySummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCreateInput {
    pub cli_type: CliType,
    pub name: String,
    #[serde(default)]
    pub config_text: String,
    #[serde(default = "default_true")]
    pub inherit_common: bool,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderUpdateInput {
    pub name: String,
    pub config_text: String,
    pub inherit_common: bool,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderKeyCreateInput {
    pub label: String,
    pub secret: String,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum KeySecretAction {
    Keep,
    Replace,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderKeyUpdateInput {
    pub label: String,
    pub secret_action: KeySecretAction,
    pub secret: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCommonConfig {
    pub cli_type: CliType,
    pub config_format: String,
    pub config_text: String,
    pub revision: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderConfigValidationInput {
    pub cli_type: CliType,
    #[serde(default)]
    pub common_text: String,
    #[serde(default)]
    pub provider_text: String,
    #[serde(default = "default_true")]
    pub inherit_common: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderConfigValidation {
    pub valid: bool,
    pub error_code: Option<String>,
    pub effective_text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderEffectivePreview {
    pub provider_id: String,
    pub cli_type: CliType,
    pub config_format: String,
    pub effective_text: String,
}

fn default_true() -> bool {
    true
}
