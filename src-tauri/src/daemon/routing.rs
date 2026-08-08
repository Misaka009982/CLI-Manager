use std::io;
use std::net::TcpListener;

pub(crate) const FALLBACK_PORT_START: u16 = 15_721;
pub(crate) const FALLBACK_PORT_END: u16 = 15_799;
pub(crate) const MIN_PORT: u16 = 1_024;

#[derive(Debug)]
pub(crate) struct RoutingListenerLease {
    _listener: TcpListener,
    pub(crate) actual_port: u16,
}

pub(crate) struct RoutingRuntime {
    lease: Option<RoutingListenerLease>,
    preferred_port: u16,
    actual_port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoutingRuntimeSnapshot {
    pub(crate) status: String,
    pub(crate) preferred_port: u16,
    pub(crate) actual_port: Option<u16>,
}

impl RoutingRuntime {
    pub(crate) fn new() -> Self {
        Self {
            lease: None,
            preferred_port: FALLBACK_PORT_START,
            actual_port: None,
        }
    }

    pub(crate) fn is_running(&self) -> bool {
        self.lease.is_some()
    }

    pub(crate) fn snapshot(&self) -> RoutingRuntimeSnapshot {
        RoutingRuntimeSnapshot {
            status: if self.is_running() {
                "running".to_string()
            } else {
                "stopped".to_string()
            },
            preferred_port: self.preferred_port,
            actual_port: self.actual_port,
        }
    }

    pub(crate) fn start(
        &mut self,
        listen_address: &str,
        preferred_port: u16,
        last_actual_port: Option<u16>,
    ) -> Result<RoutingRuntimeSnapshot, String> {
        if self.is_running() {
            return Ok(self.snapshot());
        }
        let lease = PortAllocator::bind(listen_address, preferred_port, last_actual_port)?;
        self.preferred_port = preferred_port;
        self.actual_port = Some(lease.actual_port);
        self.lease = Some(lease);
        Ok(self.snapshot())
    }

    pub(crate) fn stop(&mut self) -> RoutingRuntimeSnapshot {
        self.lease = None;
        self.snapshot()
    }
}

pub(crate) struct PortAllocator;

impl PortAllocator {
    pub(crate) fn bind(
        listen_address: &str,
        preferred_port: u16,
        last_actual_port: Option<u16>,
    ) -> Result<RoutingListenerLease, String> {
        bind_with(
            listen_address,
            preferred_port,
            last_actual_port,
            |address, port| TcpListener::bind((address, port)),
        )
    }

    #[cfg(test)]
    fn candidates(preferred_port: u16, last_actual_port: Option<u16>) -> Result<Vec<u16>, String> {
        candidate_ports(preferred_port, last_actual_port)
    }
}

fn candidate_ports(preferred_port: u16, last_actual_port: Option<u16>) -> Result<Vec<u16>, String> {
    if preferred_port < MIN_PORT {
        return Err("routing_port_invalid".to_string());
    }
    if last_actual_port.is_some_and(|port| port < MIN_PORT) {
        return Err("routing_port_invalid".to_string());
    }

    let mut candidates =
        Vec::with_capacity(2 + usize::from(FALLBACK_PORT_END - FALLBACK_PORT_START));
    let mut add = |port: u16| {
        if !candidates.contains(&port) {
            candidates.push(port);
        }
    };
    if let Some(port) = last_actual_port {
        add(port);
    }
    add(preferred_port);
    for port in FALLBACK_PORT_START..=FALLBACK_PORT_END {
        add(port);
    }
    Ok(candidates)
}

fn bind_with<F>(
    listen_address: &str,
    preferred_port: u16,
    last_actual_port: Option<u16>,
    mut bind: F,
) -> Result<RoutingListenerLease, String>
where
    F: FnMut(&str, u16) -> io::Result<TcpListener>,
{
    let listen_address = listen_address.trim();
    if !matches!(listen_address, "127.0.0.1" | "::1" | "localhost") {
        return Err("routing_listen_address_invalid".to_string());
    }
    let candidates = candidate_ports(preferred_port, last_actual_port)?;
    for port in candidates {
        if let Ok(listener) = bind(listen_address, port) {
            return Ok(RoutingListenerLease {
                _listener: listener,
                actual_port: port,
            });
        }
    }
    Err("routing_port_range_exhausted".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_order_is_last_actual_then_preferred_then_fallback_without_duplicates() {
        assert_eq!(
            PortAllocator::candidates(15_721, Some(15_722)).unwrap()[..4],
            [15_722, 15_721, 15_723, 15_724]
        );
        assert_eq!(
            PortAllocator::candidates(15_721, Some(15_721)).unwrap()[..3],
            [15_721, 15_722, 15_723]
        );
    }

    #[test]
    fn preferred_port_occupied_falls_back_to_next_candidate() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let preferred = occupied.local_addr().unwrap().port();
        let lease = PortAllocator::bind("127.0.0.1", preferred, None).unwrap();
        assert_ne!(lease.actual_port, preferred);
    }

    #[test]
    fn invalid_port_is_rejected_before_bind() {
        assert_eq!(
            PortAllocator::bind("127.0.0.1", 0, None).unwrap_err(),
            "routing_port_invalid"
        );
    }

    #[test]
    fn exhausted_candidates_return_stable_error() {
        let result = bind_with("127.0.0.1", 15_721, None, |_address, _port| {
            Err(io::Error::new(io::ErrorKind::AddrInUse, "occupied"))
        });
        assert_eq!(result.unwrap_err(), "routing_port_range_exhausted");
    }

    #[test]
    fn stopping_keeps_actual_port_for_restart_reuse() {
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let preferred = probe.local_addr().unwrap().port();
        drop(probe);
        let mut runtime = RoutingRuntime::new();
        let running = runtime.start("127.0.0.1", preferred, None).unwrap();
        let actual = running.actual_port.expect("actual port");
        assert_eq!(runtime.stop().actual_port, Some(actual));
        assert_eq!(runtime.snapshot().actual_port, Some(actual));

        let mut restarted = RoutingRuntime::new();
        let reused = restarted
            .start("127.0.0.1", preferred + 1, Some(actual))
            .unwrap();
        assert_eq!(reused.actual_port, Some(actual));
    }
}
