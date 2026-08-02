use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCard {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    pub sort_index: i64,
    pub created_at: i64,
    pub is_current: bool,
    pub enabled: bool,
    pub key_count: i64,
    pub active_key_label: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_format: Option<String>,
    pub settings_valid: bool,
    pub common_config_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderDetail {
    pub card: ProviderCard,
    pub settings_config: String,
    pub effective_settings_config: String,
    pub settings_has_secret: bool,
    pub keys: Vec<ProviderKeySummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderKeySummary {
    pub id: String,
    pub provider_id: String,
    pub app_type: String,
    pub label: String,
    pub masked_api_key: String,
    pub tags: Vec<String>,
    pub notes: String,
    pub enabled: bool,
    pub sort_index: i64,
    pub is_active: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommonConfigDocument {
    pub app_type: String,
    pub value: String,
    pub format: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCreateInput {
    pub app_type: String,
    pub name: String,
    pub settings_config: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_format: Option<String>,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    pub common_config_enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderUpdateInput {
    pub app_type: String,
    pub provider_id: String,
    pub name: Option<String>,
    pub settings_config: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_format: Option<String>,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    pub common_config_enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderKeyCreateInput {
    pub provider_id: String,
    pub app_type: String,
    pub label: String,
    pub api_key: String,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
    pub enabled: Option<bool>,
    pub activate: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderKeyUpdateInput {
    pub id: String,
    pub provider_id: String,
    pub app_type: String,
    pub label: Option<String>,
    pub api_key: Option<String>,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommonConfigSetInput {
    pub app_type: String,
    pub value: String,
    pub format: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderRecord {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub settings_config: String,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub created_at: i64,
    pub sort_index: i64,
    pub notes: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    pub meta: String,
    pub is_current: bool,
}
