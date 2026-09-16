use super::model::{redact_resource, McpResource};
use serde_json::Value;

// Restore unchanged masked leaves under the repository transaction, accepting explicit edits/removals.
pub(super) fn preserve_secrets(
    draft: McpResource,
    original: &McpResource,
) -> Result<McpResource, String> {
    let mut draft =
        serde_json::to_value(draft).map_err(|_| "extensions_definition_serialize_failed")?;
    let masked = serde_json::to_value(redact_resource(original))
        .map_err(|_| "extensions_definition_serialize_failed")?;
    let original =
        serde_json::to_value(original).map_err(|_| "extensions_definition_serialize_failed")?;
    restore(&mut draft, &masked, &original);
    serde_json::from_value(draft).map_err(|_| "extensions_invalid_resource".into())
}

fn restore(draft: &mut Value, masked: &Value, original: &Value) {
    match draft {
        Value::Object(values) => {
            for (key, value) in values {
                if let (Some(masked), Some(original)) = (masked.get(key), original.get(key)) {
                    restore(value, masked, original);
                }
            }
        }
        Value::Array(values) => {
            for (index, value) in values.iter_mut().enumerate() {
                if let (Some(masked), Some(original)) = (masked.get(index), original.get(index)) {
                    restore(value, masked, original);
                }
            }
        }
        _ if draft == masked && masked != original => *draft = original.clone(),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::{adapters::parse_native_config, model::ExtensionCli};
    #[test]
    fn editing_name_preserves_masks_but_accepts_new_and_removed_secrets() {
        let original = parse_native_config(
            ExtensionCli::Claude,
            r#"{"mcpServers":{"test":{"command":"node","env":{"TOKEN":"old","OTHER":"value"}}}}"#,
        )
        .unwrap()
        .resources
        .remove(0);
        let mut draft: McpResource =
            serde_json::from_value(serde_json::to_value(redact_resource(&original)).unwrap())
                .unwrap();
        draft.name = "renamed".into();
        let saved = preserve_secrets(draft.clone(), &original).unwrap();
        assert_eq!(saved.env["TOKEN"], "old");
        assert_eq!(saved.name, "renamed");
        draft.env.insert("TOKEN".into(), "new".into());
        assert_eq!(
            preserve_secrets(draft.clone(), &original).unwrap().env["TOKEN"],
            "new"
        );
        draft.env.remove("TOKEN");
        assert!(!preserve_secrets(draft, &original)
            .unwrap()
            .env
            .contains_key("TOKEN"));
    }
}
