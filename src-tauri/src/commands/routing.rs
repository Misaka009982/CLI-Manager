use crate::daemon::client::{DaemonBridge, DaemonClient};
use crate::daemon::protocol::{
    ensure_local_routing_capability, routing_control_id, ClientFrame, DaemonFrame, RoutingError,
    RoutingEvent, RoutingStatus,
};
use crate::provider::home::{self, HomeSelectInput};
use crate::provider::repository::normalize_app_type;
use crate::provider::routing::{self, RoutingPersistedState, TakeoverKey};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingQuickControlsInput {
    pub show_local_quick_control: bool,
    pub show_failover_quick_control: bool,
    pub usage_logging_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingTakeoverInput {
    pub app_type: String,
    pub home_identity: crate::provider::home::HomeIdentity,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDaemonState {
    pub status: String,
    pub connected: bool,
    pub capability_supported: bool,
    pub error: Option<RoutingError>,
    pub preferred_port: Option<u16>,
    pub actual_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingState {
    pub persisted: RoutingPersistedState,
    pub daemon: RoutingDaemonState,
}

fn command_error(code: &str, hint: &str) -> RoutingError {
    RoutingError {
        code: code.to_string(),
        params: BTreeMap::new(),
        hint: hint.to_string(),
    }
}

fn map_input_error(error: String) -> RoutingError {
    let code = error.split(':').next().unwrap_or("routing_input_invalid");
    command_error(code, "fix_input")
}

fn map_persistence_error(error: String) -> RoutingError {
    let code = error
        .split(':')
        .next()
        .unwrap_or("routing_persistence_failed");
    command_error(code, "retry_or_restart_daemon")
}

fn sanitize_runtime_status(kind: &str) -> String {
    match kind {
        "running" | "stopped" | "degraded" | "recovering" => kind.to_string(),
        _ => "unknown".to_string(),
    }
}

fn daemon_state(client: Option<Arc<DaemonClient>>) -> RoutingDaemonState {
    let Some(client) = client else {
        return RoutingDaemonState {
            status: "unavailable".to_string(),
            connected: false,
            capability_supported: false,
            error: Some(RoutingError::service_unavailable()),
            preferred_port: None,
            actual_port: None,
        };
    };
    if let Err(error) = ensure_local_routing_capability(&client.info().features) {
        return RoutingDaemonState {
            status: "unsupported".to_string(),
            connected: true,
            capability_supported: false,
            error: Some(error),
            preferred_port: None,
            actual_port: None,
        };
    }

    let id = client.next_request_id();
    match client.request(id, &ClientFrame::RoutingStatus { id }) {
        Ok(DaemonFrame::RoutingEvent { event }) => routing_event_state(event),
        Ok(DaemonFrame::Err { .. }) | Err(_) => RoutingDaemonState {
            status: "unavailable".to_string(),
            connected: true,
            capability_supported: true,
            error: Some(RoutingError::service_unavailable()),
            preferred_port: None,
            actual_port: None,
        },
        Ok(_) => RoutingDaemonState {
            status: "unknown".to_string(),
            connected: true,
            capability_supported: true,
            error: Some(command_error(
                "routing_daemon_response_invalid",
                "restart_daemon",
            )),
            preferred_port: None,
            actual_port: None,
        },
    }
}

fn routing_event_state(event: RoutingEvent) -> RoutingDaemonState {
    let status = event
        .error
        .as_ref()
        .map(|_| "unavailable".to_string())
        .unwrap_or_else(|| sanitize_runtime_status(&event.kind));
    RoutingDaemonState {
        status,
        connected: true,
        capability_supported: true,
        error: event.error,
        preferred_port: event.status.as_ref().map(|status| status.preferred_port),
        actual_port: event.status.and_then(|status| status.actual_port),
    }
}

fn routing_status(event: RoutingEvent) -> Result<RoutingStatus, RoutingError> {
    event
        .status
        .ok_or_else(|| command_error("routing_daemon_response_invalid", "restart_daemon"))
}

fn block_on<T>(future: impl Future<Output = Result<T, String>>) -> Result<T, RoutingError> {
    tauri::async_runtime::block_on(future).map_err(map_persistence_error)
}

fn state(client: Option<Arc<DaemonClient>>) -> Result<RoutingState, RoutingError> {
    let persisted = block_on(routing::load_persisted_state())?;
    Ok(RoutingState {
        persisted,
        daemon: daemon_state(client),
    })
}

fn request_control(
    client: Option<Arc<DaemonClient>>,
    frame: ClientFrame,
) -> Result<RoutingEvent, RoutingError> {
    let Some(client) = client else {
        return Err(RoutingError::service_unavailable());
    };
    ensure_local_routing_capability(&client.info().features)?;
    let id = routing_control_id(&frame)
        .ok_or_else(|| command_error("routing_daemon_request_invalid", "restart_daemon"))?;
    match client.request(id, &frame) {
        Ok(DaemonFrame::RoutingEvent { event }) => {
            if let Some(error) = event.error.clone() {
                Err(error)
            } else {
                Ok(event)
            }
        }
        Ok(DaemonFrame::Err { .. }) | Err(_) => Err(RoutingError::service_unavailable()),
        Ok(_) => Err(command_error(
            "routing_daemon_response_invalid",
            "restart_daemon",
        )),
    }
}

#[tauri::command]
pub fn routing_get_state(
    daemon_bridge: State<'_, DaemonBridge>,
) -> Result<RoutingState, RoutingError> {
    state(daemon_bridge.get())
}

#[tauri::command]
pub fn routing_set_service_enabled(
    daemon_bridge: State<'_, DaemonBridge>,
    enabled: bool,
) -> Result<RoutingState, RoutingError> {
    let client = daemon_bridge.get();
    let mut persisted = block_on(routing::load_persisted_state())?;
    if persisted.service.service_enabled == enabled {
        return Ok(RoutingState {
            persisted,
            daemon: daemon_state(client),
        });
    }

    let client_ref = client
        .as_ref()
        .ok_or_else(RoutingError::service_unavailable)?;
    let id = client_ref.next_request_id();
    let frame = if enabled {
        ClientFrame::RoutingStart {
            id,
            listen_address: Some(persisted.service.listen_address.clone()),
            preferred_port: Some(persisted.service.preferred_port),
            last_actual_port: persisted.service.actual_port,
        }
    } else {
        ClientFrame::RoutingStop { id }
    };
    let event = request_control(client.clone(), frame)?;
    let previous_service = persisted.service.clone();
    if enabled {
        let status = routing_status(event)?;
        persisted.service.actual_port = status.actual_port;
    }
    persisted.service.service_enabled = enabled;
    if let Err(error) = block_on(routing::save_service_config(&persisted.service)) {
        let rollback_id = client_ref.next_request_id();
        let rollback_frame = if enabled {
            ClientFrame::RoutingStop { id: rollback_id }
        } else {
            ClientFrame::RoutingStart {
                id: rollback_id,
                listen_address: Some(previous_service.listen_address),
                preferred_port: Some(previous_service.preferred_port),
                last_actual_port: previous_service.actual_port,
            }
        };
        let _ = request_control(client, rollback_frame);
        return Err(error);
    }
    Ok(RoutingState {
        persisted,
        daemon: daemon_state(client),
    })
}

#[tauri::command]
pub fn routing_set_quick_controls(
    daemon_bridge: State<'_, DaemonBridge>,
    input: RoutingQuickControlsInput,
) -> Result<RoutingState, RoutingError> {
    let client = daemon_bridge.get();
    let mut persisted = block_on(routing::load_persisted_state())?;
    persisted.service.show_local_quick_control = input.show_local_quick_control;
    persisted.service.show_failover_quick_control = input.show_failover_quick_control;
    persisted.service.usage_logging_enabled = input.usage_logging_enabled;
    block_on(routing::save_service_config(&persisted.service))?;
    Ok(RoutingState {
        persisted,
        daemon: daemon_state(client),
    })
}

#[tauri::command]
pub fn routing_set_takeover(
    daemon_bridge: State<'_, DaemonBridge>,
    input: RoutingTakeoverInput,
) -> Result<RoutingState, RoutingError> {
    let app_type = normalize_app_type(&input.app_type)
        .map_err(|_| command_error("routing_app_type_invalid", "fix_input"))?;
    let home = tauri::async_runtime::block_on(home::get(HomeSelectInput {
        environment_kind: input.home_identity.environment_kind.clone(),
        environment_id: Some(input.home_identity.environment_id.clone()),
        mode: "auto".to_string(),
        home_path: None,
    }))
    .map_err(map_input_error)?;
    if home.identity != input.home_identity {
        return Err(command_error(
            "routing_home_identity_mismatch",
            "reload_home_preferences",
        ));
    }
    let _key: TakeoverKey =
        routing::takeover_key(&app_type, &home.identity).map_err(map_input_error)?;
    if input.enabled {
        tauri::async_runtime::block_on(routing::ensure_current_provider_ready(&app_type))
            .map_err(map_input_error)?;
    }

    let client = daemon_bridge
        .get()
        .ok_or_else(RoutingError::service_unavailable)?;
    ensure_local_routing_capability(&client.info().features)?;

    // P1-01 only establishes the command boundary. A takeover item is a
    // committed Live projection, so it must not be written before the writer
    // and listener transaction exists in later P1 cases.
    Err(RoutingError::service_unavailable())
}
