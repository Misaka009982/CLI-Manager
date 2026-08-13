use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};

pub const DESKTOP_PET_E_PROTOCOL_VERSION: u32 = 1;
pub const DESKTOP_PET_E_MAX_LINE_BYTES: usize = 1024 * 1024;
const RECENT_ACTION_ID_LIMIT: usize = 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetEEnvelope {
    pub protocol_version: u32,
    pub instance_id: String,
    pub generation: u64,
    pub revision: u64,
    #[serde(rename = "type")]
    pub message_type: String,
    pub payload: Value,
}

#[derive(Debug)]
pub enum DesktopPetEInboundMessage {
    Hello,
    Ready,
    Action(Value),
    Diagnostic(Value),
}

#[derive(Default)]
pub struct DesktopPetELineDecoder {
    current: Vec<u8>,
    discarding_oversized: bool,
}

impl DesktopPetELineDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Result<Vec<u8>, String>> {
        let mut lines = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                if self.discarding_oversized {
                    lines.push(Err("desktop_pet_e_line_too_large".to_string()));
                } else {
                    if self.current.last() == Some(&b'\r') {
                        self.current.pop();
                    }
                    if !self.current.is_empty() {
                        lines.push(Ok(std::mem::take(&mut self.current)));
                    }
                }
                self.current.clear();
                self.discarding_oversized = false;
                continue;
            }
            if self.discarding_oversized {
                continue;
            }
            if self.current.len() >= DESKTOP_PET_E_MAX_LINE_BYTES {
                self.current.clear();
                self.discarding_oversized = true;
                continue;
            }
            self.current.push(byte);
        }
        lines
    }

    pub fn finish(&mut self) -> Option<Result<Vec<u8>, String>> {
        if self.discarding_oversized {
            self.discarding_oversized = false;
            self.current.clear();
            return Some(Err("desktop_pet_e_line_too_large".to_string()));
        }
        if self.current.is_empty() {
            return None;
        }
        if self.current.last() == Some(&b'\r') {
            self.current.pop();
        }
        (!self.current.is_empty()).then(|| Ok(std::mem::take(&mut self.current)))
    }
}

pub struct DesktopPetEInboundValidator {
    instance_id: String,
    generation: u64,
    last_revision: u64,
    recent_action_ids: HashSet<String>,
    recent_action_order: VecDeque<String>,
}

impl DesktopPetEInboundValidator {
    pub fn new(instance_id: String, generation: u64) -> Self {
        Self {
            instance_id,
            generation,
            last_revision: 0,
            recent_action_ids: HashSet::new(),
            recent_action_order: VecDeque::new(),
        }
    }

    pub fn parse_line(&mut self, line: &[u8]) -> Result<DesktopPetEInboundMessage, String> {
        if line.is_empty() || line.len() > DESKTOP_PET_E_MAX_LINE_BYTES {
            return Err("desktop_pet_e_line_size_invalid".to_string());
        }
        let envelope: DesktopPetEEnvelope = serde_json::from_slice(line)
            .map_err(|error| format!("desktop_pet_e_json_invalid: {error}"))?;
        if envelope.protocol_version != DESKTOP_PET_E_PROTOCOL_VERSION {
            return Err("desktop_pet_e_protocol_version_mismatch".to_string());
        }
        if envelope.instance_id != self.instance_id {
            return Err("desktop_pet_e_instance_mismatch".to_string());
        }
        if envelope.generation != self.generation {
            return Err("desktop_pet_e_generation_mismatch".to_string());
        }
        if envelope.revision <= self.last_revision {
            return Err("desktop_pet_e_revision_not_increasing".to_string());
        }
        self.last_revision = envelope.revision;

        match envelope.message_type.as_str() {
            "hello" => Ok(DesktopPetEInboundMessage::Hello),
            "ready" => Ok(DesktopPetEInboundMessage::Ready),
            "diagnostic" => Ok(DesktopPetEInboundMessage::Diagnostic(envelope.payload)),
            "action" => {
                let action_id = envelope
                    .payload
                    .get("actionId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && value.len() <= 160)
                    .ok_or_else(|| "desktop_pet_e_action_id_invalid".to_string())?
                    .to_string();
                if !self.recent_action_ids.insert(action_id.clone()) {
                    return Err("desktop_pet_e_action_duplicate".to_string());
                }
                self.recent_action_order.push_back(action_id);
                while self.recent_action_order.len() > RECENT_ACTION_ID_LIMIT {
                    if let Some(expired) = self.recent_action_order.pop_front() {
                        self.recent_action_ids.remove(&expired);
                    }
                }
                Ok(DesktopPetEInboundMessage::Action(envelope.payload))
            }
            _ => Err("desktop_pet_e_message_type_unknown".to_string()),
        }
    }
}

pub fn encode_host_message(
    instance_id: &str,
    generation: u64,
    revision: u64,
    message_type: &str,
    payload: Value,
) -> Result<Vec<u8>, String> {
    if instance_id.is_empty() || message_type.is_empty() {
        return Err("desktop_pet_e_host_message_invalid".to_string());
    }
    let envelope = DesktopPetEEnvelope {
        protocol_version: DESKTOP_PET_E_PROTOCOL_VERSION,
        instance_id: instance_id.to_string(),
        generation,
        revision,
        message_type: message_type.to_string(),
        payload,
    };
    let mut encoded = serde_json::to_vec(&envelope)
        .map_err(|error| format!("desktop_pet_e_host_serialize_failed: {error}"))?;
    if encoded.len() > DESKTOP_PET_E_MAX_LINE_BYTES {
        return Err("desktop_pet_e_host_line_too_large".to_string());
    }
    encoded.push(b'\n');
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decoder_rejects_oversized_lines_without_poisoning_the_next_line() {
        let mut decoder = DesktopPetELineDecoder::default();
        let mut bytes = vec![b'x'; DESKTOP_PET_E_MAX_LINE_BYTES + 1];
        bytes.extend_from_slice(b"\n{}\n");
        let lines = decoder.push(&bytes);
        assert_eq!(lines.len(), 2);
        assert!(matches!(&lines[0], Err(error) if error == "desktop_pet_e_line_too_large"));
        assert_eq!(lines[1].as_ref().unwrap(), b"{}");
    }

    #[test]
    fn validator_rejects_old_generation_revision_and_duplicate_actions() {
        let mut validator = DesktopPetEInboundValidator::new("instance".to_string(), 2);
        let action = |revision| {
            serde_json::to_vec(&json!({
                "protocolVersion": 1,
                "instanceId": "instance",
                "generation": 2,
                "revision": revision,
                "type": "action",
                "payload": { "actionId": "action-1", "kind": "open-settings", "snapshotRevision": 1 }
            }))
            .unwrap()
        };
        assert!(matches!(validator.parse_line(&action(1)), Ok(DesktopPetEInboundMessage::Action(_))));
        assert!(matches!(validator.parse_line(&action(2)), Err(error) if error == "desktop_pet_e_action_duplicate"));
        assert!(matches!(validator.parse_line(&action(1)), Err(error) if error == "desktop_pet_e_revision_not_increasing"));
    }

    #[test]
    fn host_messages_are_newline_delimited_and_versioned() {
        let encoded = encode_host_message("instance", 3, 4, "snapshot", json!({ "tasks": [] })).unwrap();
        assert_eq!(encoded.last(), Some(&b'\n'));
        let value: Value = serde_json::from_slice(&encoded[..encoded.len() - 1]).unwrap();
        assert_eq!(value["protocolVersion"], 1);
        assert_eq!(value["generation"], 3);
        assert_eq!(value["revision"], 4);
    }
}
