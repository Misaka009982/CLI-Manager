use crate::provider::{network_client, repository};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchModelsInput {
    pub app_type: String,
    pub provider_id: String,
    pub base_url: String,
    pub is_full_url: Option<bool>,
    pub api_format: Option<String>,
    pub api_key_field: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchModelsResult {
    pub models: Vec<String>,
}

pub(crate) async fn fetch(input: FetchModelsInput) -> Result<FetchModelsResult, String> {
    let app_type = repository::normalize_app_type(&input.app_type)?;
    let detail = repository::get_provider(app_type.clone(), input.provider_id.clone()).await?;
    let key = detail
        .keys
        .iter()
        .find(|item| item.is_active && item.enabled)
        .ok_or_else(|| "provider_models_active_key_required".to_string())?;
    let api_key =
        repository::reveal_key(app_type.clone(), input.provider_id, key.id.clone()).await?;
    let is_full_url = input.is_full_url.unwrap_or_else(|| {
        detail
            .claude_config
            .as_ref()
            .map(|item| item.is_full_url)
            .unwrap_or(false)
    });
    let url = build_models_url(&input.base_url, is_full_url)?;
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let api_format = input
        .api_format
        .or_else(|| detail.card.api_format.clone())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let api_key_field = input
        .api_key_field
        .or_else(|| {
            detail
                .claude_config
                .as_ref()
                .map(|item| item.api_key_field.clone())
        })
        .unwrap_or_default();
    if app_type == "claude" && api_key_field == "ANTHROPIC_API_KEY" && api_format == "anthropic" {
        headers.insert(
            HeaderName::from_static("x-api-key"),
            HeaderValue::try_from(api_key.as_str())
                .map_err(|_| "provider_models_invalid_key".to_string())?,
        );
    } else {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::try_from(format!("Bearer {api_key}"))
                .map_err(|_| "provider_models_invalid_key".to_string())?,
        );
    }
    let client = network_client::configure_builder(reqwest::Client::builder())?
        .default_headers(headers)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "provider_models_client_failed".to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "provider_models_request_failed".to_string())?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|_| "provider_models_invalid_response".to_string())?;
    if !status.is_success() {
        return Err(format!("provider_models_http_{}", status.as_u16()));
    }
    let models = parse_model_ids(&body);
    if models.is_empty() {
        return Err("provider_models_empty".to_string());
    }
    Ok(FetchModelsResult { models })
}

fn build_models_url(base_url: &str, is_full_url: bool) -> Result<String, String> {
    let base = base_url.trim();
    if base.is_empty() {
        return Err("provider_models_base_url_required".to_string());
    }
    if is_full_url {
        return Ok(base.to_string());
    }
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/models") {
        Ok(trimmed.to_string())
    } else if trimmed.ends_with("/v1") {
        Ok(format!("{trimmed}/models"))
    } else {
        Ok(format!("{trimmed}/v1/models"))
    }
}

fn parse_model_ids(value: &Value) -> Vec<String> {
    let candidates = match value {
        Value::Array(items) => Some(items),
        Value::Object(map) => map
            .get("data")
            .or_else(|| map.get("models"))
            .and_then(Value::as_array),
        _ => None,
    };
    let Some(items) = candidates else {
        return Vec::new();
    };
    let mut models = items
        .iter()
        .filter_map(|item| match item {
            Value::String(value) => Some(value.trim().to_string()),
            Value::Object(map) => map
                .get("id")
                .or_else(|| map.get("name"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    models.sort_by_key(|value| value.to_ascii_lowercase());
    models.dedup();
    models
}

#[cfg(test)]
mod tests {
    use super::{build_models_url, parse_model_ids};
    use serde_json::json;

    #[test]
    fn full_url_is_not_extended() {
        assert_eq!(
            build_models_url("https://example.test/v1/messages", true).unwrap(),
            "https://example.test/v1/messages"
        );
    }
    #[test]
    fn base_url_gets_models_endpoint() {
        assert_eq!(
            build_models_url("https://example.test/v1/", false).unwrap(),
            "https://example.test/v1/models"
        );
    }

    #[test]
    fn root_base_url_gets_v1_models_endpoint() {
        assert_eq!(
            build_models_url("https://example.test", false).unwrap(),
            "https://example.test/v1/models"
        );
    }
    #[test]
    fn parses_common_model_shapes() {
        assert_eq!(
            parse_model_ids(&json!({"data": [{"id": "b"}, {"id": "a"}, {"id": "a"}]})),
            vec!["a", "b"]
        );
        assert_eq!(
            parse_model_ids(&json!({"models": ["z", "y"]})),
            vec!["y", "z"]
        );
    }
}
