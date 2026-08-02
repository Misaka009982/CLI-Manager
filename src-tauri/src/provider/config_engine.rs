use super::{CliType, ProviderConfigValidation, ProviderConfigValidationInput};
use serde_json::{Map as JsonMap, Value as JsonValue};
use toml::Value as TomlValue;

pub(crate) fn validate_and_render(input: &ProviderConfigValidationInput) -> Result<String, String> {
    match input.cli_type {
        CliType::Claude => validate_and_render_json(input),
        CliType::Codex | CliType::Grok => validate_and_render_toml(input),
    }
}

pub(crate) fn validation_result(input: &ProviderConfigValidationInput) -> ProviderConfigValidation {
    match validate_and_render(input) {
        Ok(effective_text) => ProviderConfigValidation {
            valid: true,
            error_code: None,
            effective_text: Some(effective_text),
        },
        Err(error_code) => ProviderConfigValidation {
            valid: false,
            error_code: Some(error_code),
            effective_text: None,
        },
    }
}

pub(crate) fn validate_provider_text(cli_type: CliType, text: &str) -> Result<(), String> {
    let input = ProviderConfigValidationInput {
        cli_type,
        common_text: String::new(),
        provider_text: text.to_string(),
        inherit_common: false,
    };
    validate_and_render(&input).map(|_| ())
}

pub(crate) fn validate_common_text(cli_type: CliType, text: &str) -> Result<(), String> {
    let input = ProviderConfigValidationInput {
        cli_type,
        common_text: text.to_string(),
        provider_text: String::new(),
        inherit_common: true,
    };
    validate_and_render(&input).map(|_| ())
}

fn validate_and_render_json(input: &ProviderConfigValidationInput) -> Result<String, String> {
    let common = parse_json_object(&input.common_text)?;
    let provider = parse_json_object(&input.provider_text)?;
    reject_json_secrets(&common)?;
    reject_json_secrets(&provider)?;
    let effective = if input.inherit_common {
        merge_json(JsonValue::Object(common), JsonValue::Object(provider))
    } else {
        JsonValue::Object(provider)
    };
    serde_json::to_string_pretty(&effective).map_err(|_| "provider_config_invalid".to_string())
}

fn parse_json_object(text: &str) -> Result<JsonMap<String, JsonValue>, String> {
    if text.trim().is_empty() {
        return Ok(JsonMap::new());
    }
    serde_json::from_str::<JsonValue>(text)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| "provider_config_invalid".to_string())
}

fn merge_json(base: JsonValue, overlay: JsonValue) -> JsonValue {
    match (base, overlay) {
        (JsonValue::Object(mut base), JsonValue::Object(overlay)) => {
            for (key, value) in overlay {
                let merged = base
                    .remove(&key)
                    .map(|current| merge_json(current, value.clone()))
                    .unwrap_or(value);
                base.insert(key, merged);
            }
            JsonValue::Object(base)
        }
        (_, overlay) => overlay,
    }
}

fn reject_json_secrets(value: &JsonMap<String, JsonValue>) -> Result<(), String> {
    fn visit(value: &JsonValue) -> bool {
        match value {
            JsonValue::Object(map) => map
                .iter()
                .any(|(key, value)| is_secret_config_key(key) || visit(value)),
            JsonValue::Array(values) => values.iter().any(visit),
            _ => false,
        }
    }
    if visit(&JsonValue::Object(value.clone())) {
        Err("provider_config_contains_secret".to_string())
    } else {
        Ok(())
    }
}

fn validate_and_render_toml(input: &ProviderConfigValidationInput) -> Result<String, String> {
    let common = parse_toml_table(&input.common_text)?;
    let provider = parse_toml_table(&input.provider_text)?;
    reject_toml_secrets(&common)?;
    reject_toml_secrets(&provider)?;
    let effective = if input.inherit_common {
        merge_toml(TomlValue::Table(common), TomlValue::Table(provider))
    } else {
        TomlValue::Table(provider)
    };
    toml::to_string_pretty(&effective).map_err(|_| "provider_config_invalid".to_string())
}

fn parse_toml_table(text: &str) -> Result<toml::map::Map<String, TomlValue>, String> {
    if text.trim().is_empty() {
        return Ok(toml::map::Map::new());
    }
    toml::from_str::<TomlValue>(text)
        .ok()
        .and_then(|value| value.as_table().cloned())
        .ok_or_else(|| "provider_config_invalid".to_string())
}

fn merge_toml(base: TomlValue, overlay: TomlValue) -> TomlValue {
    match (base, overlay) {
        (TomlValue::Table(mut base), TomlValue::Table(overlay)) => {
            for (key, value) in overlay {
                let merged = base
                    .remove(&key)
                    .map(|current| merge_toml(current, value.clone()))
                    .unwrap_or(value);
                base.insert(key, merged);
            }
            TomlValue::Table(base)
        }
        (_, overlay) => overlay,
    }
}

fn reject_toml_secrets(value: &toml::map::Map<String, TomlValue>) -> Result<(), String> {
    fn visit(value: &TomlValue) -> bool {
        match value {
            TomlValue::Table(table) => table
                .iter()
                .any(|(key, value)| is_secret_config_key(key) || visit(value)),
            TomlValue::Array(values) => values.iter().any(visit),
            _ => false,
        }
    }
    if visit(&TomlValue::Table(value.clone())) {
        Err("provider_config_contains_secret".to_string())
    } else {
        Ok(())
    }
}

fn is_secret_config_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace('-', "_");
    if normalized == "env_key" {
        return false;
    }
    let exact = [
        "key",
        "api_key",
        "token",
        "auth_token",
        "password",
        "secret",
        "authorization",
    ];
    exact.contains(&normalized.as_str())
        || ["_api_key", "_token", "_password", "_secret"]
            .iter()
            .any(|suffix| normalized.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(
        cli_type: CliType,
        common_text: &str,
        provider_text: &str,
        inherit_common: bool,
    ) -> ProviderConfigValidationInput {
        ProviderConfigValidationInput {
            cli_type,
            common_text: common_text.to_string(),
            provider_text: provider_text.to_string(),
            inherit_common,
        }
    }

    #[test]
    fn json_merge_recurses_and_replaces_arrays_and_nulls() {
        let rendered = validate_and_render(&input(
            CliType::Claude,
            r#"{"permissions":{"allow":["Read"],"mode":"ask"},"model":"old"}"#,
            r#"{"permissions":{"allow":["Write"]},"model":null}"#,
            true,
        ))
        .unwrap();
        let value: JsonValue = serde_json::from_str(&rendered).unwrap();
        assert_eq!(value["permissions"]["allow"], serde_json::json!(["Write"]));
        assert_eq!(value["permissions"]["mode"], "ask");
        assert!(value["model"].is_null());
    }

    #[test]
    fn inherit_common_false_skips_common_json() {
        let rendered = validate_and_render(&input(
            CliType::Claude,
            r#"{"permissions":{"mode":"ask"}}"#,
            r#"{"model":"provider"}"#,
            false,
        ))
        .unwrap();
        let value: JsonValue = serde_json::from_str(&rendered).unwrap();
        assert!(value.get("permissions").is_none());
        assert_eq!(value["model"], "provider");
    }

    #[test]
    fn toml_merge_recurses_and_replaces_assignments() {
        let rendered = validate_and_render(&input(
            CliType::Codex,
            "model = 'common'\n[features]\nhooks = true\nsearch = false\n",
            "model = 'provider'\n[features]\nsearch = true\n",
            true,
        ))
        .unwrap();
        let value: TomlValue = toml::from_str(&rendered).unwrap();
        assert_eq!(value["model"].as_str(), Some("provider"));
        assert_eq!(value["features"]["hooks"].as_bool(), Some(true));
        assert_eq!(value["features"]["search"].as_bool(), Some(true));
    }

    #[test]
    fn secret_fields_are_rejected_but_env_key_is_allowed() {
        assert_eq!(
            validate_provider_text(CliType::Claude, r#"{"env":{"ANTHROPIC_API_KEY":"secret"}}"#)
                .unwrap_err(),
            "provider_config_contains_secret"
        );
        assert!(validate_provider_text(
            CliType::Codex,
            "[model_providers.custom]\nenv_key = 'OPENAI_API_KEY'\nbase_url = 'https://example.test'\n"
        )
        .is_ok());
    }

    #[test]
    fn invalid_root_shapes_are_rejected() {
        assert_eq!(
            validate_provider_text(CliType::Claude, "[]").unwrap_err(),
            "provider_config_invalid"
        );
        assert_eq!(
            validate_provider_text(CliType::Grok, "not = [valid").unwrap_err(),
            "provider_config_invalid"
        );
    }
}
