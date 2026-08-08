use crate::provider::database;
use crate::provider::home::HomeIdentity;
use crate::provider::repository::{meta_enabled, normalize_app_type, parse_meta};
use crate::{shell_resolver, wsl};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection};
use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use windows_sys::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
#[cfg(windows)]
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_INCLUDE_PREFIX, IP_ADAPTER_ADDRESSES_LH,
};
#[cfg(windows)]
use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

pub(crate) const SERVICE_SETTINGS_KEY: &str = "routing.service.v1";
pub(crate) const TAKEOVERS_SETTINGS_KEY: &str = "routing.takeovers.v1";
#[allow(dead_code)]
pub(crate) const DEFAULT_LISTEN_ADDRESS: &str = "127.0.0.1";
#[allow(dead_code)]
pub(crate) const DEFAULT_PREFERRED_PORT: u16 = 15_721;
const MIN_PORT: u16 = 1_024;
#[allow(dead_code)]
const ROUTING_LOG_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
#[allow(dead_code)]
const ROUTING_LOG_MAX_ROWS: i64 = 100_000;
const WSL_MIRRORED_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingServiceConfig {
    pub schema_version: u32,
    pub service_enabled: bool,
    pub listen_address: String,
    pub preferred_port: u16,
    pub actual_port: Option<u16>,
    pub show_local_quick_control: bool,
    pub show_failover_quick_control: bool,
    pub usage_logging_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingTakeoverItem {
    pub app_type: String,
    pub home_identity: HomeIdentity,
    pub endpoint_mode: String,
    pub advertised_host: String,
    pub applied_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingTakeoversDocument {
    pub schema_version: u32,
    pub items: Vec<RoutingTakeoverItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct TakeoverKey {
    pub app_type: String,
    pub home_identity: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutingPersistedState {
    pub service: RoutingServiceConfig,
    pub takeovers: Vec<RoutingTakeoverItem>,
}

pub(crate) async fn load_persisted_state() -> Result<RoutingPersistedState, String> {
    let mut connection = database::open_connection().await?;
    let service = load_service_config(&mut connection).await?;
    let takeovers = load_takeovers(&mut connection).await?;
    Ok(RoutingPersistedState { service, takeovers })
}

pub(crate) async fn save_service_config(config: &RoutingServiceConfig) -> Result<(), String> {
    validate_service_config(config)?;
    let mut connection = database::open_connection().await?;
    let result = sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
        .bind(serialize_json(config, SERVICE_SETTINGS_KEY)?)
        .bind(SERVICE_SETTINGS_KEY)
        .execute(&mut connection)
        .await
        .map_err(|_| "routing_settings_write_failed:routing.service.v1".to_string())?;
    if result.rows_affected() != 1 {
        return Err("routing_settings_missing:routing.service.v1".to_string());
    }
    Ok(())
}

pub(crate) async fn ensure_current_provider_ready(app_type: &str) -> Result<(), String> {
    let app_type = normalize_routing_app_type(app_type)?;
    let mut connection = database::open_connection().await?;
    let row = sqlx::query(
        "SELECT p.meta, k.id AS active_key_id
         FROM providers p
         LEFT JOIN provider_api_keys k
           ON k.provider_id = p.id
          AND k.app_type = p.app_type
          AND k.is_active = 1
          AND k.enabled = 1
         WHERE p.app_type = ?1 AND p.is_current = 1
         LIMIT 1",
    )
    .bind(&app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "routing_provider_read_failed".to_string())?
    .ok_or_else(|| "routing_provider_not_ready".to_string())?;

    let meta = row
        .try_get::<String, _>("meta")
        .map_err(|_| "routing_provider_read_failed".to_string())?;
    if !meta_enabled(&parse_meta(&meta)) {
        return Err("routing_provider_not_ready".to_string());
    }
    if row
        .try_get::<Option<String>, _>("active_key_id")
        .map_err(|_| "routing_provider_read_failed".to_string())?
        .is_none()
    {
        return Err("routing_provider_key_not_active".to_string());
    }
    Ok(())
}

pub(crate) async fn current_provider_id(app_type: &str) -> Result<String, String> {
    let app_type = normalize_routing_app_type(app_type)?;
    let mut connection = database::open_connection().await?;
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM providers WHERE app_type = ?1 AND is_current = 1 LIMIT 1",
    )
    .bind(app_type)
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| "routing_provider_read_failed".to_string())?
    .ok_or_else(|| "routing_provider_not_ready".to_string())
}

pub(crate) fn probe_wsl_mirrored(distro: &str, port: u16) -> Result<(), String> {
    probe_wsl_endpoint(distro, "127.0.0.1", port)
}

pub(crate) fn probe_wsl_gateway(distro: &str, gateway: Ipv4Addr, port: u16) -> Result<(), String> {
    probe_wsl_endpoint(distro, &gateway.to_string(), port)
}

fn probe_wsl_endpoint(distro: &str, host: &str, port: u16) -> Result<(), String> {
    let exe =
        wsl::find_wsl_exe().ok_or_else(|| "routing_wsl_probe_tool_unavailable".to_string())?;
    let script = format!(
        "if command -v nc >/dev/null 2>&1; then nc -z -w 3 {host} {port}; elif command -v bash >/dev/null 2>&1; then exec bash -lc 'exec 3<>/dev/tcp/{host}/{port}'; elif command -v curl >/dev/null 2>&1; then curl --connect-timeout 3 --max-time 4 -fsS http://{host}:{port}/ >/dev/null; elif command -v wget >/dev/null 2>&1; then wget -q -T 3 -O /dev/null http://{host}:{port}/; else exit 127; fi"
    );
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg("sh")
        .arg("-lc")
        .arg(script);
    let output = shell_resolver::output_with_timeout(command, WSL_MIRRORED_PROBE_TIMEOUT)
        .map_err(|_| "routing_wsl_probe_failed".to_string())?;
    if output.status.success() {
        Ok(())
    } else if output.status.code() == Some(127) {
        Err("routing_wsl_probe_tool_unavailable".to_string())
    } else {
        Err("routing_wsl_probe_failed".to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WslNatGateway {
    pub address: Ipv4Addr,
    pub network: Ipv4Addr,
    pub prefix_length: u8,
}

pub(crate) fn resolve_wsl_nat_gateway(distro: &str) -> Result<WslNatGateway, String> {
    let route = run_wsl_output(distro, &["ip", "-4", "route", "show", "default"])?;
    let (gateway, device) = parse_default_route(&route)?;
    let addresses = run_wsl_output(distro, &["ip", "-4", "addr", "show", "dev", &device])?;
    let (network, prefix_length) = parse_interface_cidr(&addresses)?;
    if !ipv4_in_cidr(gateway, network, prefix_length) {
        return Err("routing_wsl_gateway_outside_interface".to_string());
    }
    if !is_local_unicast_address(&gateway.to_string()) {
        return Err("routing_wsl_gateway_not_local".to_string());
    }
    Ok(WslNatGateway {
        address: gateway,
        network,
        prefix_length,
    })
}

fn run_wsl_output(distro: &str, args: &[&str]) -> Result<String, String> {
    let exe =
        wsl::find_wsl_exe().ok_or_else(|| "routing_wsl_route_tool_unavailable".to_string())?;
    let mut command = shell_resolver::silent_command(exe.to_string_lossy().as_ref());
    command.arg("-d").arg(distro).arg("--exec").args(args);
    let output = shell_resolver::output_with_timeout(command, WSL_MIRRORED_PROBE_TIMEOUT)
        .map_err(|_| "routing_wsl_route_failed".to_string())?;
    if !output.status.success() {
        return if output.status.code() == Some(127) {
            Err("routing_wsl_route_tool_unavailable".to_string())
        } else {
            Err("routing_wsl_route_failed".to_string())
        };
    }
    String::from_utf8(output.stdout).map_err(|_| "routing_wsl_route_failed".to_string())
}

fn parse_default_route(output: &str) -> Result<(Ipv4Addr, String), String> {
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.first() != Some(&"default") {
            continue;
        }
        let gateway = fields
            .windows(2)
            .find_map(|pair| (pair[0] == "via").then_some(pair[1]))
            .and_then(|value| value.parse::<Ipv4Addr>().ok())
            .ok_or_else(|| "routing_wsl_default_route_invalid".to_string())?;
        let device = fields
            .windows(2)
            .find_map(|pair| (pair[0] == "dev").then_some(pair[1]))
            .ok_or_else(|| "routing_wsl_default_route_invalid".to_string())?;
        if device.is_empty()
            || device.starts_with('-')
            || !device
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ".:_-".contains(character))
        {
            return Err("routing_wsl_default_route_invalid".to_string());
        }
        return Ok((gateway, device.to_string()));
    }
    Err("routing_wsl_default_route_missing".to_string())
}

fn parse_interface_cidr(output: &str) -> Result<(Ipv4Addr, u8), String> {
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let Some(cidr) = fields
            .windows(2)
            .find_map(|pair| (pair[0] == "inet").then_some(pair[1]))
        else {
            continue;
        };
        let (address, prefix) = cidr
            .split_once('/')
            .ok_or_else(|| "routing_wsl_interface_cidr_invalid".to_string())?;
        let address = address
            .parse::<Ipv4Addr>()
            .map_err(|_| "routing_wsl_interface_cidr_invalid".to_string())?;
        let prefix_length = prefix
            .parse::<u8>()
            .ok()
            .filter(|prefix| *prefix <= 32)
            .ok_or_else(|| "routing_wsl_interface_cidr_invalid".to_string())?;
        return Ok((network_address(address, prefix_length), prefix_length));
    }
    Err("routing_wsl_interface_cidr_missing".to_string())
}

fn network_address(address: Ipv4Addr, prefix_length: u8) -> Ipv4Addr {
    let mask = if prefix_length == 0 {
        0
    } else {
        u32::MAX << (32 - prefix_length)
    };
    Ipv4Addr::from(u32::from(address) & mask)
}

fn ipv4_in_cidr(address: Ipv4Addr, network: Ipv4Addr, prefix_length: u8) -> bool {
    network_address(address, prefix_length) == network
}

pub(crate) fn is_local_unicast_address(address: &str) -> bool {
    let Ok(address) = address.parse::<Ipv4Addr>() else {
        return false;
    };
    local_ipv4_unicast_addresses()
        .map(|addresses| addresses.contains(&address))
        .unwrap_or(false)
}

#[cfg(windows)]
fn local_ipv4_unicast_addresses() -> Result<Vec<Ipv4Addr>, String> {
    let mut size = 15 * 1024u32;
    let mut resize_attempts = 0;
    loop {
        let mut buffer = vec![0u64; (size as usize).div_ceil(std::mem::size_of::<u64>())];
        let result = unsafe {
            GetAdaptersAddresses(
                AF_INET as u32,
                GAA_FLAG_INCLUDE_PREFIX,
                std::ptr::null(),
                buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut size,
            )
        };
        if result == ERROR_BUFFER_OVERFLOW {
            resize_attempts += 1;
            if resize_attempts > 3 {
                return Err("routing_windows_adapters_unavailable".to_string());
            }
            continue;
        }
        if result != 0 {
            return Err("routing_windows_adapters_unavailable".to_string());
        }

        let mut addresses = Vec::new();
        let mut adapter = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !adapter.is_null() {
            let mut unicast = unsafe { (*adapter).FirstUnicastAddress };
            while !unicast.is_null() {
                let socket_address = unsafe { (*unicast).Address };
                if !socket_address.lpSockaddr.is_null()
                    && unsafe { (*socket_address.lpSockaddr).sa_family } == AF_INET
                {
                    let address = unsafe {
                        let sockaddr = socket_address.lpSockaddr.cast::<SOCKADDR_IN>();
                        let bytes = (*sockaddr).sin_addr.S_un.S_un_b;
                        Ipv4Addr::new(bytes.s_b1, bytes.s_b2, bytes.s_b3, bytes.s_b4)
                    };
                    if !addresses.contains(&address) {
                        addresses.push(address);
                    }
                }
                unicast = unsafe { (*unicast).Next };
            }
            adapter = unsafe { (*adapter).Next };
        }
        return Ok(addresses);
    }
}

#[cfg(not(windows))]
fn local_ipv4_unicast_addresses() -> Result<Vec<Ipv4Addr>, String> {
    Err("routing_wsl_gateway_platform_unsupported".to_string())
}

pub(crate) fn takeover_key(
    app_type: &str,
    home_identity: &HomeIdentity,
) -> Result<TakeoverKey, String> {
    let app_type = normalize_routing_app_type(app_type)?;
    validate_home_identity(home_identity)?;
    Ok(TakeoverKey {
        app_type,
        home_identity: home_identity.identity.clone(),
    })
}

pub(crate) fn validate_service_config(config: &RoutingServiceConfig) -> Result<(), String> {
    if config.schema_version != 1 {
        return Err("routing_schema_version_unsupported:routing.service.v1".to_string());
    }
    if !matches!(
        config.listen_address.trim(),
        "127.0.0.1" | "::1" | "localhost"
    ) {
        return Err("routing_listen_address_invalid".to_string());
    }
    if config.preferred_port < MIN_PORT {
        return Err("routing_port_invalid".to_string());
    }
    if let Some(actual_port) = config.actual_port {
        if actual_port < MIN_PORT {
            return Err("routing_port_invalid".to_string());
        }
    }
    Ok(())
}

fn validate_home_identity(home_identity: &HomeIdentity) -> Result<(), String> {
    if !matches!(home_identity.environment_kind.as_str(), "local" | "wsl") {
        return Err("routing_home_invalid".to_string());
    }
    if home_identity.environment_id.trim().is_empty()
        || home_identity.identity.trim().is_empty()
        || home_identity.identity
            != format!(
                "{}:{}",
                home_identity.environment_kind, home_identity.environment_id
            )
    {
        return Err("routing_home_identity_mismatch".to_string());
    }
    if home_identity.environment_kind == "local" && home_identity.environment_id != "host" {
        return Err("routing_home_identity_mismatch".to_string());
    }
    Ok(())
}

async fn load_service_config(
    connection: &mut SqliteConnection,
) -> Result<RoutingServiceConfig, String> {
    let raw = load_setting(connection, SERVICE_SETTINGS_KEY).await?;
    let config = serde_json::from_str::<RoutingServiceConfig>(&raw)
        .map_err(|_| "routing_settings_invalid:routing.service.v1".to_string())?;
    validate_service_config(&config)?;
    Ok(config)
}

async fn load_takeovers(
    connection: &mut SqliteConnection,
) -> Result<Vec<RoutingTakeoverItem>, String> {
    let raw = load_setting(connection, TAKEOVERS_SETTINGS_KEY).await?;
    let document = serde_json::from_str::<RoutingTakeoversDocument>(&raw)
        .map_err(|_| "routing_settings_invalid:routing.takeovers.v1".to_string())?;
    if document.schema_version != 1 {
        return Err("routing_schema_version_unsupported:routing.takeovers.v1".to_string());
    }

    let mut keys = HashSet::with_capacity(document.items.len());
    for item in &document.items {
        let normalized_app_type = normalize_routing_app_type(&item.app_type)?;
        if normalized_app_type != item.app_type {
            return Err("routing_app_type_invalid".to_string());
        }
        let key = takeover_key(&item.app_type, &item.home_identity)?;
        if !keys.insert(key) {
            return Err("routing_takeover_duplicate".to_string());
        }
        if !matches!(
            item.endpoint_mode.as_str(),
            "loopback" | "wsl_mirrored" | "wsl_gateway"
        ) || item.advertised_host.trim().is_empty()
            || !is_safe_advertised_host(&item.endpoint_mode, &item.advertised_host)
            || item.applied_port < MIN_PORT
        {
            return Err("routing_takeover_invalid".to_string());
        }
    }
    Ok(document.items)
}

pub(crate) async fn save_takeovers(items: &[RoutingTakeoverItem]) -> Result<(), String> {
    let mut keys = HashSet::with_capacity(items.len());
    for item in items {
        let normalized_app_type = normalize_routing_app_type(&item.app_type)?;
        if normalized_app_type != item.app_type {
            return Err("routing_app_type_invalid".to_string());
        }
        let key = takeover_key(&item.app_type, &item.home_identity)?;
        if !keys.insert(key)
            || !matches!(
                item.endpoint_mode.as_str(),
                "loopback" | "wsl_mirrored" | "wsl_gateway"
            )
            || item.advertised_host.trim().is_empty()
            || !is_safe_advertised_host(&item.endpoint_mode, &item.advertised_host)
            || item.applied_port < MIN_PORT
        {
            return Err("routing_takeover_invalid".to_string());
        }
    }
    let document = RoutingTakeoversDocument {
        schema_version: 1,
        items: items.to_vec(),
    };
    let mut connection = database::open_connection().await?;
    let result = sqlx::query("UPDATE settings SET value = ?1 WHERE key = ?2")
        .bind(serialize_json(&document, TAKEOVERS_SETTINGS_KEY)?)
        .bind(TAKEOVERS_SETTINGS_KEY)
        .execute(&mut connection)
        .await
        .map_err(|_| "routing_settings_write_failed:routing.takeovers.v1".to_string())?;
    if result.rows_affected() != 1 {
        return Err("routing_settings_missing:routing.takeovers.v1".to_string());
    }
    Ok(())
}

fn is_safe_advertised_host(endpoint_mode: &str, host: &str) -> bool {
    let host = host.trim();
    if host
        .chars()
        .any(|ch| matches!(ch, '/' | '\\' | '\r' | '\n' | ' '))
        || matches!(host, "0.0.0.0" | "::" | "*")
    {
        return false;
    }
    if matches!(endpoint_mode, "loopback" | "wsl_mirrored") {
        matches!(host, "127.0.0.1" | "::1" | "localhost")
    } else {
        host.parse::<Ipv4Addr>().is_ok()
    }
}

fn normalize_routing_app_type(app_type: &str) -> Result<String, String> {
    normalize_app_type(app_type).map_err(|_| "routing_app_type_invalid".to_string())
}

async fn load_setting(connection: &mut SqliteConnection, key: &str) -> Result<String, String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| format!("routing_settings_read_failed:{key}"))?
        .ok_or_else(|| format!("routing_settings_missing:{key}"))
}

fn serialize_json<T: Serialize>(value: &T, key: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| format!("routing_settings_serialize_failed:{key}"))
}

#[allow(dead_code)]
pub(crate) async fn cleanup_request_logs(
    connection: &mut SqliteConnection,
    now_ms: i64,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM routing_request_logs
         WHERE created_at_ms < ?1",
    )
    .bind(now_ms.saturating_sub(ROUTING_LOG_RETENTION_MS))
    .execute(&mut *connection)
    .await
    .map_err(|_| "routing_request_logs_cleanup_failed".to_string())?;

    sqlx::query(
        "DELETE FROM routing_request_logs
         WHERE request_id IN (
             SELECT request_id FROM routing_request_logs
             ORDER BY created_at_ms DESC, request_id DESC
             LIMIT -1 OFFSET ?1
         )",
    )
    .bind(ROUTING_LOG_MAX_ROWS)
    .execute(&mut *connection)
    .await
    .map_err(|_| "routing_request_logs_cleanup_failed".to_string())?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> RoutingServiceConfig {
        RoutingServiceConfig {
            schema_version: 1,
            service_enabled: false,
            listen_address: DEFAULT_LISTEN_ADDRESS.to_string(),
            preferred_port: DEFAULT_PREFERRED_PORT,
            actual_port: None,
            show_local_quick_control: false,
            show_failover_quick_control: false,
            usage_logging_enabled: true,
        }
    }

    fn home() -> HomeIdentity {
        HomeIdentity {
            environment_kind: "local".to_string(),
            environment_id: "host".to_string(),
            identity: "local:host".to_string(),
        }
    }

    #[test]
    fn service_config_accepts_loopback_and_rejects_wildcard() {
        assert!(validate_service_config(&service()).is_ok());
        let mut wildcard = service();
        wildcard.listen_address = "0.0.0.0".to_string();
        assert_eq!(
            validate_service_config(&wildcard).unwrap_err(),
            "routing_listen_address_invalid"
        );
    }

    #[test]
    fn takeover_key_is_app_and_home_identity() {
        let key = takeover_key("grok", &home()).unwrap();
        assert_eq!(key.app_type, "grokbuild");
        assert_eq!(key.home_identity, "local:host");
    }

    #[test]
    fn malformed_home_identity_is_rejected() {
        let mut invalid = home();
        invalid.identity = "local:other".to_string();
        assert_eq!(
            takeover_key("claude", &invalid).unwrap_err(),
            "routing_home_identity_mismatch"
        );
    }

    #[test]
    fn advertised_host_rejects_wildcards_and_non_loopback_loopback_modes() {
        assert!(!is_safe_advertised_host("loopback", "0.0.0.0"));
        assert!(!is_safe_advertised_host("loopback", "192.168.1.4"));
        assert!(is_safe_advertised_host("wsl_mirrored", "127.0.0.1"));
        assert!(!is_safe_advertised_host("wsl_mirrored", "172.28.224.1"));
        assert!(is_safe_advertised_host("wsl_gateway", "172.28.224.1"));
    }

    #[test]
    fn wsl_home_identity_is_valid_for_takeover_storage() {
        let home = HomeIdentity {
            environment_kind: "wsl".to_string(),
            environment_id: "Ubuntu".to_string(),
            identity: "wsl:Ubuntu".to_string(),
        };
        assert!(takeover_key("claude", &home).is_ok());
    }

    #[test]
    fn parses_wsl_default_route_and_interface_cidr() {
        let (gateway, device) =
            parse_default_route("default via 172.28.224.1 dev eth0 proto kernel\n").unwrap();
        assert_eq!(gateway, Ipv4Addr::new(172, 28, 224, 1));
        assert_eq!(device, "eth0");

        let (network, prefix) = parse_interface_cidr(
            "2: eth0@if3: <BROADCAST>\n    inet 172.28.224.2/20 brd 172.28.239.255 scope global eth0\n",
        )
        .unwrap();
        assert_eq!(network, Ipv4Addr::new(172, 28, 224, 0));
        assert_eq!(prefix, 20);
        assert!(ipv4_in_cidr(gateway, network, prefix));
    }

    #[test]
    fn rejects_wsl_default_route_without_gateway_or_interface_cidr() {
        assert_eq!(
            parse_default_route("default dev eth0\n").unwrap_err(),
            "routing_wsl_default_route_invalid"
        );
        assert_eq!(
            parse_interface_cidr("2: eth0:\n").unwrap_err(),
            "routing_wsl_interface_cidr_missing"
        );
    }
}
