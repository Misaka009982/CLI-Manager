use crate::daemon::client::DaemonBridge;
use crate::desktop_pet_e_agent::{
    post_desktop_pet_e_agent_json, DesktopPetEAgentAnswer,
};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::State;

const AGENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

fn agent_target(bridge: &State<'_, DaemonBridge>) -> Result<(u16, String), String> {
    let client = bridge
        .get()
        .ok_or_else(|| "desktop_pet_e_agent_daemon_unavailable".to_string())?;
    let info = client.info();
    if info.hook_port == 0 || info.token.trim().is_empty() {
        return Err("desktop_pet_e_agent_daemon_unavailable".to_string());
    }
    Ok((info.hook_port, info.token.clone()))
}

#[tauri::command]
pub fn desktop_pet_e_agent_availability(
    instance_id: String,
    available: bool,
    bridge: State<'_, DaemonBridge>,
) -> Result<Value, String> {
    let (port, token) = agent_target(&bridge)?;
    post_desktop_pet_e_agent_json(
        port,
        &token,
        "/api/desktop-pet-e-agent/availability",
        &json!({
            "instanceId": instance_id,
            "available": available,
        }),
        AGENT_REQUEST_TIMEOUT,
    )
}

#[tauri::command]
pub fn desktop_pet_e_agent_submit(
    pending_action_id: String,
    transport_action_id: String,
    answers: Vec<DesktopPetEAgentAnswer>,
    approval_value: Option<String>,
    bridge: State<'_, DaemonBridge>,
) -> Result<Value, String> {
    let (port, token) = agent_target(&bridge)?;
    post_desktop_pet_e_agent_json(
        port,
        &token,
        "/api/desktop-pet-e-agent/submit",
        &json!({
            "pendingActionId": pending_action_id,
            "transportActionId": transport_action_id,
            "answers": answers,
            "approvalValue": approval_value,
        }),
        AGENT_REQUEST_TIMEOUT,
    )
}

#[tauri::command]
pub fn desktop_pet_e_agent_cancel(
    pending_action_id: String,
    reason: Option<String>,
    bridge: State<'_, DaemonBridge>,
) -> Result<Value, String> {
    let (port, token) = agent_target(&bridge)?;
    post_desktop_pet_e_agent_json(
        port,
        &token,
        "/api/desktop-pet-e-agent/cancel",
        &json!({
            "pendingActionId": pending_action_id,
            "reason": reason,
        }),
        AGENT_REQUEST_TIMEOUT,
    )
}
