use super::circuit::{CircuitPermit, CircuitPolicy, CircuitRegistry, CircuitSnapshot};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderName, HeaderValue, ALLOW, CONTENT_TYPE, HOST};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use reqwest::header::{
    AUTHORIZATION, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE as REQ_CONTENT_TYPE,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::error::Error;
use std::net::TcpListener;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const KEY_COOLDOWN_DEFAULT: Duration = Duration::from_secs(30);
const KEY_COOLDOWN_MAX: Duration = Duration::from_secs(60);

type BoxError = Box<dyn Error + Send + Sync>;
type RouteBody = http_body_util::combinators::BoxBody<Bytes, BoxError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteKind {
    ClaudeMessages,
    CodexResponses,
    CodexChatCompletions,
    Grok,
}

#[derive(Debug, Clone)]
struct ProviderSnapshot {
    app_type: &'static str,
    provider_id: String,
    base_url: String,
    claude_api_key_field: Option<String>,
    claude_api_format: Option<String>,
    pool_id: String,
    key_candidates: Vec<KeyCandidate>,
    model_mappings: Vec<ModelMapping>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpstreamErrorClass {
    Success,
    Key,
    Provider,
    Capability,
    Client,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpstreamSendFailure {
    Timeout,
    Request,
}

enum ProviderAttemptOutcome {
    Response(reqwest::Response),
    Failure(StatusCode, &'static str),
    KeyExhausted,
}

#[derive(Debug, Clone, Copy)]
enum BodyTimeoutMode {
    Streaming {
        first_byte: Duration,
        idle: Duration,
        received_first: bool,
    },
    NonStreaming {
        deadline: Instant,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamCommitKind {
    GenericSse,
    ResponsesSse,
}

#[derive(Debug)]
struct StreamCommitTracker {
    kind: StreamCommitKind,
    buffer: String,
    committed: bool,
}

impl StreamCommitTracker {
    fn new(kind: StreamCommitKind) -> Self {
        Self {
            kind,
            buffer: String::new(),
            committed: false,
        }
    }

    fn observe(&mut self, chunk: &Bytes) -> bool {
        if self.committed {
            return true;
        }
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        while let Some(end) = self.buffer.find("\n\n") {
            let event = self.buffer[..end].to_string();
            self.buffer.drain(..end + 2);
            if self.event_commits(&event) {
                self.committed = true;
                return true;
            }
        }
        false
    }

    fn event_commits(&self, event: &str) -> bool {
        let mut event_name = None;
        let mut data = String::new();
        for line in event.lines() {
            let line = line.trim_end_matches('\r');
            if line.starts_with(':') {
                continue;
            }
            if let Some(value) = line.strip_prefix("event:") {
                event_name = Some(value.trim());
            } else if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value.trim_start());
            }
        }
        if data.is_empty() {
            return false;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) else {
            return false;
        };
        let semantic_type = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .or(event_name)
            .unwrap_or_default();
        match self.kind {
            StreamCommitKind::GenericSse => true,
            StreamCommitKind::ResponsesSse => {
                semantic_type == "error"
                    || semantic_type == "response.failed"
                    || semantic_type.starts_with("response.output")
            }
        }
    }
}

struct CircuitCommit {
    state: Arc<RouteState>,
    permit: Option<CircuitPermit>,
    policy: CircuitPolicy,
    hot_switch: Option<HotSwitchCommit>,
}

struct HotSwitchCommit {
    app_type: &'static str,
    provider_id: String,
}

struct TimedBodyState<S> {
    stream: Pin<Box<S>>,
    mode: BodyTimeoutMode,
    tracker: Option<StreamCommitTracker>,
    circuit: Option<CircuitCommit>,
}

impl<S> Drop for TimedBodyState<S> {
    fn drop(&mut self) {
        if let Some(circuit) = self.circuit.take() {
            if let Some(permit) = circuit.permit {
                circuit.state.circuits.release(permit);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ModelMapping {
    source: String,
    target: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct KeyCandidate {
    id: String,
    api_key: String,
}

#[derive(Debug)]
struct KeyPool {
    generation: u64,
    candidates: Vec<KeyCandidate>,
    cursor: usize,
    cooldowns: HashMap<String, Instant>,
}

#[derive(Debug, Default)]
pub(crate) struct RouteState {
    pools: Mutex<HashMap<String, KeyPool>>,
    circuits: CircuitRegistry,
}

impl RouteState {
    fn select_key(
        &self,
        pool_id: &str,
        candidates: Vec<KeyCandidate>,
    ) -> Result<KeyCandidate, String> {
        let mut pools = self
            .pools
            .lock()
            .map_err(|_| "routing_key_pool_unavailable".to_string())?;
        let pool = pools.entry(pool_id.to_string()).or_insert_with(|| KeyPool {
            generation: 1,
            candidates: candidates.clone(),
            cursor: 0,
            cooldowns: HashMap::new(),
        });
        if pool.candidates != candidates {
            pool.generation = pool.generation.saturating_add(1);
            pool.candidates = candidates;
            pool.cursor = 0;
            pool.cooldowns.clear();
        }
        pool.next_key(&HashSet::new())
            .ok_or_else(|| "routing_provider_keys_cooling_down".to_string())
    }

    fn next_key(&self, pool_id: &str, used: &HashSet<String>) -> Option<KeyCandidate> {
        let mut pools = self.pools.lock().ok()?;
        pools.get_mut(pool_id)?.next_key(used)
    }

    fn mark_cooldown(
        &self,
        pool_id: &str,
        key_id: &str,
        status: u16,
        headers: &reqwest::header::HeaderMap,
    ) {
        let Ok(mut pools) = self.pools.lock() else {
            return;
        };
        let Some(pool) = pools.get_mut(pool_id) else {
            return;
        };
        let duration = retry_cooldown(status, headers);
        pool.cooldowns
            .insert(key_id.to_string(), Instant::now() + duration);
    }
}

impl KeyPool {
    fn next_key(&mut self, used: &HashSet<String>) -> Option<KeyCandidate> {
        let now = Instant::now();
        self.cooldowns.retain(|_, deadline| *deadline > now);
        if self.candidates.is_empty() {
            return None;
        }
        for _ in 0..self.candidates.len() {
            let index = self.cursor % self.candidates.len();
            self.cursor = (self.cursor + 1) % self.candidates.len();
            let candidate = &self.candidates[index];
            if !used.contains(&candidate.id) && !self.cooldowns.contains_key(&candidate.id) {
                return Some(candidate.clone());
            }
        }
        None
    }
}

pub(crate) struct RouteHttpServer {
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
    state: Arc<RouteState>,
}

impl RouteHttpServer {
    pub(crate) fn start(listeners: &[TcpListener]) -> Result<Self, String> {
        Self::start_with_state(listeners, None)
    }

    pub(crate) fn start_with_state(
        listeners: &[TcpListener],
        existing_state: Option<Arc<RouteState>>,
    ) -> Result<Self, String> {
        if listeners.is_empty() {
            return Err("routing_listener_missing".to_string());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let state = existing_state.unwrap_or_default();
        let mut workers = Vec::with_capacity(listeners.len());
        for source in listeners {
            let listener = match source.try_clone() {
                Ok(listener) => listener,
                Err(_) => {
                    stop_workers(&stop, &mut workers);
                    return Err("routing_listener_clone_failed".to_string());
                }
            };
            if listener.set_nonblocking(true).is_err() {
                stop_workers(&stop, &mut workers);
                return Err("routing_listener_nonblocking_failed".to_string());
            }
            let worker_stop = Arc::clone(&stop);
            let worker_state = Arc::clone(&state);
            let worker = thread::Builder::new()
                .name("cli-manager-route-http".to_string())
                .spawn(move || {
                    let runtime = match tokio::runtime::Builder::new_current_thread()
                        .enable_io()
                        .enable_time()
                        .build()
                    {
                        Ok(runtime) => runtime,
                        Err(_) => return,
                    };
                    let local = tokio::task::LocalSet::new();
                    local.block_on(
                        &runtime,
                        serve_listener(listener, worker_stop, Arc::clone(&worker_state)),
                    );
                })
                .map_err(|_| "routing_listener_worker_failed".to_string());
            match worker {
                Ok(worker) => workers.push(worker),
                Err(error) => {
                    stop_workers(&stop, &mut workers);
                    return Err(error);
                }
            }
        }
        Ok(Self {
            stop,
            workers,
            state,
        })
    }

    pub(crate) fn circuit_snapshots(&self) -> Vec<CircuitSnapshot> {
        self.state.circuits.snapshots()
    }

    pub(crate) fn shared_state(&self) -> Arc<RouteState> {
        Arc::clone(&self.state)
    }

    pub(crate) fn reset_circuit(&self, app_type: &str, provider_id: &str) {
        self.state.circuits.reset(app_type, provider_id);
    }
}

fn stop_workers(stop: &Arc<AtomicBool>, workers: &mut Vec<JoinHandle<()>>) {
    stop.store(true, Ordering::Release);
    for worker in workers.drain(..) {
        let _ = worker.join();
    }
}

impl Drop for RouteHttpServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

async fn serve_listener(listener: TcpListener, stop: Arc<AtomicBool>, state: Arc<RouteState>) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        return;
    };
    while !stop.load(Ordering::Acquire) {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(50)) => {},
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let connection_state = Arc::clone(&state);
                tokio::task::spawn_local(async move {
                    let io = TokioIo::new(stream);
                    let service = service_fn(move |request| {
                        handle_request(request, Arc::clone(&connection_state))
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, service)
                        .await;
                });
            }
        }
    }
}

async fn handle_request(
    request: Request<Incoming>,
    state: Arc<RouteState>,
) -> Result<Response<RouteBody>, Infallible> {
    Ok(match forward_request(request, state).await {
        Ok(response) => response,
        Err((status, message)) => error_response(status, message),
    })
}

async fn forward_request(
    request: Request<Incoming>,
    state: Arc<RouteState>,
) -> Result<Response<RouteBody>, (StatusCode, &'static str)> {
    let request_path = request.uri().path().to_string();
    let route = classify_route(request.method(), &request_path)?;
    if header_bytes(request.headers()) > MAX_HEADER_BYTES {
        return Err((
            StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
            "routing_headers_too_large",
        ));
    }
    let headers = request_headers(&request);
    let body = Limited::new(request.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
        .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "routing_body_too_large"))?
        .to_bytes();
    let request_json = serde_json::from_slice::<serde_json::Value>(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "routing_request_json_invalid"))?;
    if !request_json.is_object() {
        return Err((
            StatusCode::BAD_REQUEST,
            "routing_request_body_must_be_object",
        ));
    }
    let rectifier_config = crate::provider::routing::load_rectifier_config()
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "routing_rectifier_config_unavailable",
            )
        })?;
    let mut retry_context = crate::provider::routing::RoutingRetryContext::default();
    let failover_config =
        crate::provider::routing::load_failover_config_for_daemon(route_app_type(route))
            .await
            .map_err(|_| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "routing_failover_config_unavailable",
                )
            })?;
    let streaming = request_json
        .get("stream")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let circuit_policy = CircuitPolicy {
        failure_threshold: failover_config.circuit_failure_threshold,
        success_threshold: failover_config.circuit_success_threshold,
        timeout: Duration::from_secs(failover_config.circuit_timeout_seconds),
        error_rate_threshold: failover_config.circuit_error_rate_threshold,
        min_requests: failover_config.circuit_min_requests,
    };
    let snapshots = load_provider_snapshots(route, failover_config.auto_failover_enabled)
        .await
        .map_err(|error| {
            log::warn!("routing provider snapshot unavailable: {error}");
            if error.starts_with("provider_model_mapping_") {
                (StatusCode::BAD_REQUEST, "routing_model_mapping_invalid")
            } else {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "routing_provider_unavailable",
                )
            }
        })?;
    crate::provider::network_client::current_client_from_persisted()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_client_failed"))?;
    let mut client_builder =
        crate::provider::network_client::configure_builder(reqwest::Client::builder())
            .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_client_failed"))?;
    if !streaming {
        client_builder =
            client_builder.timeout(Duration::from_secs(failover_config.non_streaming_timeout));
    }
    let client = client_builder
        .build()
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_client_failed"))?;
    let max_provider_attempts = if failover_config.auto_failover_enabled {
        max_attempts(failover_config.max_retries) as usize
    } else {
        1
    };
    let mut provider_index = 0usize;
    let mut terminal_failure = None;
    let selected = loop {
        if provider_index >= snapshots.len() || provider_index >= max_provider_attempts {
            break None;
        }
        let snapshot = snapshots[provider_index].clone();
        let mut circuit_permit = if failover_config.auto_failover_enabled {
            match state.circuits.acquire(
                route_app_type(route),
                &snapshot.provider_id,
                circuit_policy,
            ) {
                Ok(permit) => Some(permit),
                Err(_) => {
                    provider_index = provider_index.saturating_add(1);
                    continue;
                }
            }
        } else {
            None
        };
        let url = match upstream_url(&snapshot.base_url, route, &request_path) {
            Ok(url) => url,
            Err(_) => {
                if let Some(permit) = circuit_permit.take() {
                    state.circuits.release(permit);
                }
                terminal_failure =
                    Some((StatusCode::BAD_GATEWAY, "routing_provider_endpoint_invalid"));
                provider_index = provider_index.saturating_add(1);
                continue;
            }
        };
        let mut selected_key =
            match state.select_key(&snapshot.pool_id, snapshot.key_candidates.clone()) {
                Ok(key) => key,
                Err(_) => {
                    if !failover_config.auto_failover_enabled {
                        return Err((
                            StatusCode::SERVICE_UNAVAILABLE,
                            "routing_provider_unavailable",
                        ));
                    }
                    if let Some(permit) = circuit_permit.take() {
                        state.circuits.release(permit);
                    }
                    terminal_failure =
                        Some((StatusCode::BAD_GATEWAY, "routing_provider_key_exhausted"));
                    provider_index = provider_index.saturating_add(1);
                    continue;
                }
            };
        let mut used_keys = HashSet::from([selected_key.id.clone()]);
        let mut provider_request = request_json.clone();
        let outcome = loop {
            let mut upstream = client.post(&url);
            for (name, value) in &headers {
                upstream = upstream.header(name, value);
            }
            if use_claude_api_key_header(&snapshot) {
                upstream = upstream.header("x-api-key", selected_key.api_key.clone());
            } else {
                upstream = upstream.header(
                    AUTHORIZATION.as_str(),
                    format!("Bearer {}", selected_key.api_key),
                );
            }
            let attempt_body = apply_model_mapping(&provider_request, &snapshot.model_mappings)
                .map_err(|_| (StatusCode::BAD_REQUEST, "routing_model_mapping_invalid"))?;
            let send_result = if streaming {
                match tokio::time::timeout(
                    Duration::from_secs(failover_config.streaming_first_byte_timeout),
                    upstream
                        .header(REQ_CONTENT_TYPE.as_str(), "application/json")
                        .body(attempt_body)
                        .send(),
                )
                .await
                {
                    Ok(result) => result.map_err(|error| {
                        if error.is_timeout() {
                            UpstreamSendFailure::Timeout
                        } else {
                            UpstreamSendFailure::Request
                        }
                    }),
                    Err(_) => Err(UpstreamSendFailure::Timeout),
                }
            } else {
                upstream
                    .header(REQ_CONTENT_TYPE.as_str(), "application/json")
                    .body(attempt_body)
                    .send()
                    .await
                    .map_err(|error| {
                        if error.is_timeout() {
                            UpstreamSendFailure::Timeout
                        } else {
                            UpstreamSendFailure::Request
                        }
                    })
            };
            let response = match send_result {
                Ok(response) => response,
                Err(UpstreamSendFailure::Timeout) => {
                    break ProviderAttemptOutcome::Failure(
                        StatusCode::GATEWAY_TIMEOUT,
                        "routing_upstream_timeout",
                    )
                }
                Err(UpstreamSendFailure::Request) => {
                    break ProviderAttemptOutcome::Failure(
                        StatusCode::BAD_GATEWAY,
                        "routing_upstream_request_failed",
                    )
                }
            };
            if !streaming
                && response.status() == StatusCode::BAD_REQUEST
                && snapshot.app_type == "claude"
                && snapshot.claude_api_format.as_deref() == Some("anthropic")
                && retry_context.can_retry(
                    &rectifier_config,
                    crate::provider::routing::RoutingRectifierRule::ThinkingSignature,
                )
            {
                let error_body = response
                    .bytes()
                    .await
                    .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_body_failed"))?;
                if is_thinking_signature_error(&error_body) {
                    remove_invalid_thinking_blocks(&mut provider_request);
                    retry_context.mark_used(
                        crate::provider::routing::RoutingRectifierRule::ThinkingSignature,
                    );
                    continue;
                }
                return Err((StatusCode::BAD_REQUEST, "routing_upstream_client_error"));
            }
            if !streaming
                && response.status() == StatusCode::BAD_REQUEST
                && snapshot.app_type == "claude"
                && snapshot.claude_api_format.as_deref() == Some("anthropic")
                && retry_context.can_retry(
                    &rectifier_config,
                    crate::provider::routing::RoutingRectifierRule::ThinkingBudget,
                )
            {
                let error_body = response
                    .bytes()
                    .await
                    .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_body_failed"))?;
                if is_thinking_budget_error(&error_body) {
                    if rectify_thinking_budget(&mut provider_request) {
                        retry_context.mark_used(
                            crate::provider::routing::RoutingRectifierRule::ThinkingBudget,
                        );
                        continue;
                    }
                }
                return Err((StatusCode::BAD_REQUEST, "routing_upstream_client_error"));
            }
            if classify_upstream_status(response.status()) == UpstreamErrorClass::Provider {
                break ProviderAttemptOutcome::Failure(
                    StatusCode::BAD_GATEWAY,
                    "routing_upstream_provider_failed",
                );
            }
            if !is_key_retryable(response.status()) {
                break ProviderAttemptOutcome::Response(response);
            }
            state.mark_cooldown(
                &snapshot.pool_id,
                &selected_key.id,
                response.status().as_u16(),
                response.headers(),
            );
            let Some(next_key) = state.next_key(&snapshot.pool_id, &used_keys) else {
                break if failover_config.auto_failover_enabled {
                    ProviderAttemptOutcome::KeyExhausted
                } else {
                    ProviderAttemptOutcome::Response(response)
                };
            };
            used_keys.insert(next_key.id.clone());
            selected_key = next_key;
        };
        match outcome {
            ProviderAttemptOutcome::Response(response) => {
                break Some((
                    response,
                    circuit_permit,
                    provider_index,
                    snapshot.provider_id,
                ));
            }
            ProviderAttemptOutcome::Failure(status, message) => {
                record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
                terminal_failure = Some((status, message));
            }
            ProviderAttemptOutcome::KeyExhausted => {
                if let Some(permit) = circuit_permit.take() {
                    state.circuits.release(permit);
                }
                terminal_failure =
                    Some((StatusCode::BAD_GATEWAY, "routing_provider_key_exhausted"));
            }
        }
        provider_index = provider_index.saturating_add(1);
    };
    let Some((response, mut circuit_permit, selected_provider_index, selected_provider_id)) =
        selected
    else {
        return Err(terminal_failure.unwrap_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "routing_provider_circuit_open",
        )));
    };
    let status = response.status();
    let headers = response.headers().clone();
    if !streaming {
        let body = match tokio::time::timeout(
            Duration::from_secs(failover_config.non_streaming_timeout),
            response.bytes(),
        )
        .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => {
                record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
                return Err((StatusCode::BAD_GATEWAY, "routing_upstream_body_failed"));
            }
            Err(_) => {
                record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
                return Err((StatusCode::GATEWAY_TIMEOUT, "routing_upstream_timeout"));
            }
        };
        if selected_provider_index > 0
            && classify_upstream_status(status) == UpstreamErrorClass::Success
        {
            if let Err(error) = crate::provider::routing::apply_hot_switch_for_active_homes(
                route_app_type(route),
                &selected_provider_id,
            )
            .await
            {
                log::warn!("routing hot switch failed: {error}");
            }
        }
        if classify_upstream_status(status) == UpstreamErrorClass::Success {
            record_circuit_success(&state, &mut circuit_permit, circuit_policy);
        } else if let Some(permit) = circuit_permit.take() {
            state.circuits.release(permit);
        }
        let body = Full::new(body).map_err(|error| match error {}).boxed();
        let mut builder = Response::builder().status(status);
        for (name, value) in headers {
            let Some(name) = name else { continue };
            if is_hop_by_hop(name.as_str()) {
                continue;
            }
            builder = builder.header(name, value);
        }
        return builder
            .body(body)
            .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_response_build_failed"));
    }
    let timeout_mode = if streaming {
        BodyTimeoutMode::Streaming {
            first_byte: Duration::from_secs(failover_config.streaming_first_byte_timeout),
            idle: Duration::from_secs(failover_config.streaming_idle_timeout),
            received_first: false,
        }
    } else {
        BodyTimeoutMode::NonStreaming {
            deadline: Instant::now() + Duration::from_secs(failover_config.non_streaming_timeout),
        }
    };
    let commit_kind = if matches!(route, RouteKind::CodexResponses) {
        StreamCommitKind::ResponsesSse
    } else {
        StreamCommitKind::GenericSse
    };
    let stream = timed_body_stream(
        response.bytes_stream(),
        timeout_mode,
        Some(StreamCommitTracker::new(commit_kind)),
        circuit_permit.take().map(|permit| CircuitCommit {
            state: Arc::clone(&state),
            permit: Some(permit),
            policy: circuit_policy,
            hot_switch: (selected_provider_index > 0
                && classify_upstream_status(status) == UpstreamErrorClass::Success)
                .then(|| HotSwitchCommit {
                    app_type: route_app_type(route),
                    provider_id: selected_provider_id,
                }),
        }),
    );
    let body = BodyExt::boxed(StreamBody::new(stream));
    let mut builder = Response::builder().status(status);
    for (name, value) in headers {
        let Some(name) = name else { continue };
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder
        .body(body)
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_response_build_failed"))
}

fn classify_route(method: &Method, path: &str) -> Result<RouteKind, (StatusCode, &'static str)> {
    if *method != Method::POST {
        let known = matches!(
            path,
            "/v1/messages" | "/v1/responses" | "/v1/chat/completions"
        ) || path.starts_with("/grokbuild/v1/");
        return Err(if known {
            (StatusCode::METHOD_NOT_ALLOWED, "routing_method_not_allowed")
        } else {
            (StatusCode::NOT_FOUND, "routing_path_not_found")
        });
    }
    match path {
        "/v1/messages" => Ok(RouteKind::ClaudeMessages),
        "/v1/responses" => Ok(RouteKind::CodexResponses),
        "/v1/chat/completions" => Ok(RouteKind::CodexChatCompletions),
        path if path.starts_with("/grokbuild/v1/") && path.len() > "/grokbuild/v1/".len() => {
            Ok(RouteKind::Grok)
        }
        _ => Err((StatusCode::NOT_FOUND, "routing_path_not_found")),
    }
}

fn route_app_type(route: RouteKind) -> &'static str {
    match route {
        RouteKind::ClaudeMessages => "claude",
        RouteKind::CodexResponses | RouteKind::CodexChatCompletions => "codex",
        RouteKind::Grok => "grokbuild",
    }
}

fn route_path(route: RouteKind) -> &'static str {
    match route {
        RouteKind::ClaudeMessages => "/v1/messages",
        RouteKind::CodexResponses => "/v1/responses",
        RouteKind::CodexChatCompletions => "/v1/chat/completions",
        RouteKind::Grok => "/grokbuild/v1/",
    }
}

async fn load_provider_snapshot(route: RouteKind) -> Result<ProviderSnapshot, String> {
    let app_type = route_app_type(route);
    let providers = crate::provider::repository::list_providers(Some(app_type.to_string())).await?;
    let card = providers
        .into_iter()
        .find(|provider| provider.is_current && provider.enabled)
        .ok_or_else(|| "routing_provider_not_ready".to_string())?;
    load_provider_snapshot_for_provider(route, &card.id).await
}

async fn load_provider_snapshot_for_provider(
    route: RouteKind,
    provider_id: &str,
) -> Result<ProviderSnapshot, String> {
    let app_type = route_app_type(route);
    let detail =
        crate::provider::repository::get_provider(app_type.to_string(), provider_id.to_string())
            .await?;
    let mut keys = detail
        .keys
        .into_iter()
        .filter(|key| key.enabled)
        .collect::<Vec<_>>();
    keys.sort_by(|left, right| {
        left.sort_index
            .cmp(&right.sort_index)
            .then_with(|| left.id.cmp(&right.id))
    });
    if let Some(active_index) = keys.iter().position(|key| key.is_active) {
        let active = keys.remove(active_index);
        keys.insert(0, active);
    }
    if keys.is_empty() {
        return Err("routing_provider_key_not_active".to_string());
    }
    let provider_id = detail.card.id.clone();
    let mut candidates = Vec::with_capacity(keys.len());
    for key in keys {
        let api_key = crate::provider::repository::reveal_key(
            app_type.to_string(),
            provider_id.clone(),
            key.id.clone(),
        )
        .await?;
        candidates.push(KeyCandidate {
            id: key.id,
            api_key,
        });
    }
    let pool_id = format!("{app_type}:{provider_id}");
    let model_mappings = if app_type == "claude" {
        let config = detail
            .claude_config
            .as_ref()
            .ok_or_else(|| "provider_config_invalid".to_string())?;
        let fallback = |value: &str, fallback: &str| {
            if value.trim().is_empty() {
                fallback.to_string()
            } else {
                value.trim().to_string()
            }
        };
        let opus = fallback(&config.default_opus_model, &config.model);
        let sonnet = fallback(&config.default_sonnet_model, &config.model);
        let haiku = fallback(&config.default_haiku_model, &sonnet);
        let fable = fallback(&config.default_fable_model, &opus);
        vec![
            ModelMapping {
                source: "sonnet".to_string(),
                target: sonnet,
            },
            ModelMapping {
                source: "opus".to_string(),
                target: opus.clone(),
            },
            ModelMapping {
                source: "haiku".to_string(),
                target: haiku,
            },
            ModelMapping {
                source: "fable".to_string(),
                target: fable,
            },
        ]
    } else {
        parse_model_mappings(app_type, &detail.settings_config)?
    };
    let base_url = detail
        .card
        .base_url
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "routing_provider_endpoint_missing".to_string())?;
    Ok(ProviderSnapshot {
        app_type,
        provider_id: detail.card.id,
        base_url,
        claude_api_key_field: detail
            .claude_config
            .as_ref()
            .map(|config| config.api_key_field.clone()),
        claude_api_format: detail.claude_config.map(|config| config.api_format),
        pool_id,
        key_candidates: candidates,
        model_mappings,
    })
}

async fn load_provider_snapshots(
    route: RouteKind,
    auto_failover_enabled: bool,
) -> Result<Vec<ProviderSnapshot>, String> {
    let app_type = route_app_type(route);
    if !auto_failover_enabled {
        return Ok(vec![load_provider_snapshot(route).await?]);
    }
    let provider_ids =
        crate::provider::routing::load_failover_provider_ids_for_daemon(app_type).await?;
    if provider_ids.is_empty() {
        return Err("routing_provider_not_ready".to_string());
    }
    let mut snapshots = Vec::with_capacity(provider_ids.len());
    let mut last_error = None;
    for provider_id in provider_ids {
        match load_provider_snapshot_for_provider(route, &provider_id).await {
            Ok(snapshot) => snapshots.push(snapshot),
            Err(error) => last_error = Some(error),
        }
    }
    if snapshots.is_empty() {
        return Err(last_error.unwrap_or_else(|| "routing_provider_not_ready".to_string()));
    }
    Ok(snapshots)
}

fn parse_model_mappings(
    app_type: &str,
    settings_config: &str,
) -> Result<Vec<ModelMapping>, String> {
    if app_type == "claude" {
        return Ok(Vec::new());
    }
    let settings = serde_json::from_str::<serde_json::Value>(settings_config)
        .map_err(|_| "provider_config_invalid".to_string())?;
    let Some(mappings) = settings
        .get("advanced")
        .and_then(|advanced| advanced.get("modelMappings"))
    else {
        return Ok(Vec::new());
    };
    let mappings = mappings
        .as_array()
        .ok_or_else(|| "provider_model_mapping_invalid".to_string())?;
    let mut result = Vec::with_capacity(mappings.len());
    let mut sources = HashSet::new();
    for mapping in mappings {
        let source = mapping
            .get("source")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "provider_model_mapping_source_required".to_string())?;
        let target = mapping
            .get("target")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "provider_model_mapping_target_required".to_string())?;
        if !sources.insert(source.to_string()) {
            return Err("provider_model_mapping_duplicate_source".to_string());
        }
        result.push(ModelMapping {
            source: source.to_string(),
            target: target.to_string(),
        });
    }
    Ok(result)
}

fn apply_model_mapping(
    request: &serde_json::Value,
    mappings: &[ModelMapping],
) -> Result<Vec<u8>, String> {
    let mut request = request.clone();
    let Some(object) = request.as_object_mut() else {
        return Err("routing_request_body_must_be_object".to_string());
    };
    let Some(model) = object.get("model").and_then(serde_json::Value::as_str) else {
        return serde_json::to_vec(&request)
            .map_err(|_| "routing_request_serialize_failed".to_string());
    };
    if let Some(mapping) = mappings.iter().find(|mapping| mapping.source == model) {
        object.insert(
            "model".to_string(),
            serde_json::Value::String(mapping.target.clone()),
        );
    }
    serde_json::to_vec(&request).map_err(|_| "routing_request_serialize_failed".to_string())
}

fn is_thinking_signature_error(body: &[u8]) -> bool {
    let body = String::from_utf8_lossy(body).to_ascii_lowercase();
    body.contains("signature")
        && (body.contains("invalid")
            || body.contains("missing")
            || body.contains("extra")
            || body.contains("modified")
            || body.contains("altered"))
}

fn is_thinking_budget_error(body: &[u8]) -> bool {
    let body = String::from_utf8_lossy(body).to_ascii_lowercase();
    let mentions_budget = body.contains("budget")
        || body.contains("max_tokens")
        || body.contains("max token")
        || body.contains("thinking");
    mentions_budget
        && (body.contains("constraint")
            || body.contains("less than")
            || body.contains("must be")
            || body.contains("invalid")
            || body.contains("too small")
            || body.contains("too large"))
}

fn rectify_thinking_budget(request: &mut serde_json::Value) -> bool {
    let Some(object) = request.as_object_mut() else {
        return false;
    };
    if object
        .get("thinking")
        .and_then(serde_json::Value::as_object)
        .and_then(|thinking| thinking.get("type"))
        .and_then(serde_json::Value::as_str)
        == Some("adaptive")
    {
        return false;
    }
    match object.get_mut("thinking") {
        Some(serde_json::Value::Object(thinking)) => {
            thinking.insert("type".to_string(), serde_json::json!("enabled"));
            thinking.insert("budget_tokens".to_string(), serde_json::json!(32000));
        }
        _ => {
            object.insert(
                "thinking".to_string(),
                serde_json::json!({"type":"enabled", "budget_tokens":32000}),
            );
        }
    }
    let max_tokens_too_small = object
        .get("max_tokens")
        .and_then(serde_json::Value::as_u64)
        .is_none_or(|value| value < 64_000);
    if max_tokens_too_small {
        object.insert("max_tokens".to_string(), serde_json::json!(64_000));
    }
    true
}

fn remove_invalid_thinking_blocks(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            items.retain(|item| {
                !matches!(
                    item.get("type").and_then(serde_json::Value::as_str),
                    Some("thinking" | "redacted_thinking")
                )
            });
            for item in items {
                remove_invalid_thinking_blocks(item);
            }
        }
        serde_json::Value::Object(object) => {
            for item in object.values_mut() {
                remove_invalid_thinking_blocks(item);
            }
        }
        _ => {}
    }
}

fn upstream_url(base_url: &str, route: RouteKind, request_path: &str) -> Result<String, ()> {
    let mut url = reqwest::Url::parse(base_url.trim()).map_err(|_| ())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(());
    }
    let base_path = url.path().trim_end_matches('/');
    let route_path = if route == RouteKind::Grok {
        request_path
    } else {
        route_path(route)
    };
    let path = if route == RouteKind::Grok {
        format!("{base_path}{route_path}")
    } else if base_path.ends_with("/v1") && route_path.starts_with("/v1/") {
        format!("{base_path}{}", &route_path[3..])
    } else {
        format!("{base_path}{route_path}")
    };
    url.set_path(if path.is_empty() { "/" } else { &path });
    url.set_query(None);
    Ok(url.to_string())
}

fn classify_upstream_status(status: StatusCode) -> UpstreamErrorClass {
    match status.as_u16() {
        401 | 403 | 429 => UpstreamErrorClass::Key,
        400 | 405 | 406 | 413 | 414 | 415 | 422 | 501 => UpstreamErrorClass::Capability,
        400..=499 => UpstreamErrorClass::Client,
        500..=599 => UpstreamErrorClass::Provider,
        _ if status.is_success() => UpstreamErrorClass::Success,
        _ => UpstreamErrorClass::Client,
    }
}

fn record_circuit_success(
    state: &RouteState,
    permit: &mut Option<CircuitPermit>,
    policy: CircuitPolicy,
) {
    if let Some(permit) = permit.take() {
        state.circuits.record_success(permit, policy);
    }
}

fn record_circuit_failure(
    state: &RouteState,
    permit: &mut Option<CircuitPermit>,
    policy: CircuitPolicy,
) {
    if let Some(permit) = permit.take() {
        state.circuits.record_failure(permit, policy);
    }
}

fn max_attempts(max_retries: u32) -> u32 {
    max_retries.saturating_add(1)
}

fn timed_body_stream<S>(
    stream: S,
    mode: BodyTimeoutMode,
    tracker: Option<StreamCommitTracker>,
    circuit: Option<CircuitCommit>,
) -> impl Stream<Item = Result<Frame<Bytes>, BoxError>>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
{
    futures_util::stream::unfold(
        Some(TimedBodyState {
            stream: Box::pin(stream),
            mode,
            tracker,
            circuit,
        }),
        |state| async move {
            let mut state = state?;
            let timeout = match state.mode {
                BodyTimeoutMode::Streaming {
                    first_byte,
                    idle,
                    received_first,
                } => {
                    if received_first {
                        idle
                    } else {
                        first_byte
                    }
                }
                BodyTimeoutMode::NonStreaming { deadline } => {
                    deadline.saturating_duration_since(Instant::now())
                }
            };
            match tokio::time::timeout(timeout, state.stream.next()).await {
                Ok(Some(Ok(chunk))) => {
                    if let BodyTimeoutMode::Streaming {
                        ref mut received_first,
                        ..
                    } = state.mode
                    {
                        *received_first |= !chunk.is_empty();
                    }
                    if state
                        .tracker
                        .as_mut()
                        .is_some_and(|tracker| tracker.observe(&chunk))
                    {
                        if let Some(circuit) = state.circuit.as_mut() {
                            if let Some(permit) = circuit.permit.take() {
                                circuit
                                    .state
                                    .circuits
                                    .record_success(permit, circuit.policy);
                            }
                            if let Some(hot_switch) = circuit.hot_switch.take() {
                                tokio::task::spawn_local(async move {
                                    if let Err(error) =
                                        crate::provider::routing::apply_hot_switch_for_active_homes(
                                            hot_switch.app_type,
                                            &hot_switch.provider_id,
                                        )
                                        .await
                                    {
                                        log::warn!("routing hot switch failed: {error}");
                                    }
                                });
                            }
                        }
                    }
                    Some((
                        Ok::<Frame<Bytes>, BoxError>(Frame::data(chunk)),
                        Some(state),
                    ))
                }
                Ok(Some(Err(error))) => {
                    if let Some(circuit) = state.circuit.take() {
                        if let Some(permit) = circuit.permit {
                            circuit.state.circuits.release(permit);
                        }
                    }
                    Some((Err::<Frame<Bytes>, BoxError>(Box::new(error)), None))
                }
                Ok(None) => {
                    if let Some(circuit) = state.circuit.take() {
                        if let Some(permit) = circuit.permit {
                            circuit.state.circuits.release(permit);
                        }
                    }
                    None
                }
                Err(_) => {
                    if let Some(circuit) = state.circuit.take() {
                        if let Some(permit) = circuit.permit {
                            circuit.state.circuits.release(permit);
                        }
                    }
                    Some((
                        Err::<Frame<Bytes>, BoxError>(Box::new(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "routing_upstream_stream_timeout",
                        ))),
                        None,
                    ))
                }
            }
        },
    )
}

fn is_key_retryable(status: reqwest::StatusCode) -> bool {
    classify_upstream_status(status) == UpstreamErrorClass::Key
}

fn retry_cooldown(status: u16, headers: &reqwest::header::HeaderMap) -> Duration {
    if let Some(seconds) = headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
    {
        return Duration::from_secs(seconds.min(KEY_COOLDOWN_MAX.as_secs()));
    }
    if status == 429 {
        Duration::from_secs(5)
    } else {
        KEY_COOLDOWN_DEFAULT
    }
}

fn use_claude_api_key_header(snapshot: &ProviderSnapshot) -> bool {
    snapshot.app_type == "claude"
        && snapshot
            .claude_api_format
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("anthropic"))
        && snapshot
            .claude_api_key_field
            .as_deref()
            .is_some_and(|value| value == "ANTHROPIC_API_KEY")
}

fn request_headers(request: &Request<Incoming>) -> Vec<(HeaderName, HeaderValue)> {
    request
        .headers()
        .iter()
        .filter(|(name, _)| {
            !is_hop_by_hop(name.as_str())
                && *name != HOST
                && *name != AUTHORIZATION
                && *name != HeaderName::from_static("x-api-key")
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn header_bytes(headers: &hyper::HeaderMap) -> usize {
    headers
        .iter()
        .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
        .sum()
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
    ) || name.eq_ignore_ascii_case(CONNECTION.as_str())
        || name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
}

fn error_response(status: StatusCode, message: &'static str) -> Response<RouteBody> {
    let body = Full::new(Bytes::from(json!({ "error": message }).to_string()))
        .map_err(|error| match error {})
        .boxed();
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .header(ALLOW, "POST")
        .body(body)
        .expect("static error response is valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::thread;

    #[test]
    fn route_matrix_is_fixed_and_rejects_connect() {
        assert_eq!(
            classify_route(&Method::POST, "/v1/messages"),
            Ok(RouteKind::ClaudeMessages)
        );
        assert_eq!(
            classify_route(&Method::POST, "/v1/responses"),
            Ok(RouteKind::CodexResponses)
        );
        assert_eq!(
            classify_route(&Method::POST, "/v1/chat/completions"),
            Ok(RouteKind::CodexChatCompletions)
        );
        assert_eq!(
            classify_route(&Method::POST, "/grokbuild/v1/chat/completions"),
            Ok(RouteKind::Grok)
        );
        assert_eq!(
            classify_route(&Method::CONNECT, "/v1/messages"),
            Err((StatusCode::METHOD_NOT_ALLOWED, "routing_method_not_allowed"))
        );
        assert_eq!(
            classify_route(&Method::POST, "/v1/anything"),
            Err((StatusCode::NOT_FOUND, "routing_path_not_found"))
        );
    }

    #[test]
    fn failover_protocol_matrix_covers_all_supported_apps() {
        let cases = [
            (RouteKind::ClaudeMessages, "/v1/messages", "claude"),
            (RouteKind::CodexResponses, "/v1/responses", "codex"),
            (
                RouteKind::CodexChatCompletions,
                "/v1/chat/completions",
                "codex",
            ),
            (
                RouteKind::Grok,
                "/grokbuild/v1/chat/completions",
                "grokbuild",
            ),
        ];

        for (route, path, app_type) in cases {
            assert_eq!(classify_route(&Method::POST, path), Ok(route));
            assert_eq!(route_app_type(route), app_type);
            assert!(upstream_url("https://upstream.example/v1", route, path).is_ok());

            let kind = if route == RouteKind::CodexResponses {
                StreamCommitKind::ResponsesSse
            } else {
                StreamCommitKind::GenericSse
            };
            let mut tracker = StreamCommitTracker::new(kind);
            assert!(!tracker.observe(&Bytes::from_static(b": keepalive\n\n")));
            let event = if kind == StreamCommitKind::ResponsesSse {
                b"data: {\"type\":\"response.output_text.delta\"}\n\n".as_slice()
            } else {
                b"data: {\"type\":\"message_start\"}\n\n".as_slice()
            };
            assert!(tracker.observe(&Bytes::from_static(event)));
        }
    }

    #[test]
    fn upstream_error_classifier_separates_key_provider_and_capability_failures() {
        assert_eq!(
            classify_upstream_status(StatusCode::UNAUTHORIZED),
            UpstreamErrorClass::Key
        );
        assert_eq!(
            classify_upstream_status(StatusCode::TOO_MANY_REQUESTS),
            UpstreamErrorClass::Key
        );
        assert_eq!(
            classify_upstream_status(StatusCode::BAD_GATEWAY),
            UpstreamErrorClass::Provider
        );
        assert_eq!(
            classify_upstream_status(StatusCode::UNPROCESSABLE_ENTITY),
            UpstreamErrorClass::Capability
        );
        assert_eq!(
            classify_upstream_status(StatusCode::BAD_REQUEST),
            UpstreamErrorClass::Capability
        );
        assert_eq!(
            classify_upstream_status(StatusCode::NOT_FOUND),
            UpstreamErrorClass::Client
        );
        assert_eq!(
            classify_upstream_status(StatusCode::OK),
            UpstreamErrorClass::Success
        );
    }

    #[test]
    fn max_attempts_is_initial_attempt_plus_retry_budget() {
        assert_eq!(max_attempts(0), 1);
        assert_eq!(max_attempts(3), 4);
        assert_eq!(max_attempts(u32::MAX), u32::MAX);
    }

    #[test]
    fn signature_classifier_requires_explicit_signature_error_language() {
        assert!(is_thinking_signature_error(
            br#"{"error":"invalid thinking signature"}"#
        ));
        assert!(is_thinking_signature_error(
            br#"{"error":"missing signature"}"#
        ));
        assert!(!is_thinking_signature_error(
            br#"{"error":"invalid JSON body"}"#
        ));
        assert!(!is_thinking_signature_error(
            br#"{"error":"signature is valid"}"#
        ));
    }

    #[test]
    fn signature_rectifier_removes_only_thinking_blocks_and_preserves_request_data() {
        let mut request = serde_json::json!({
            "model": "fixture",
            "messages": [{
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "secret reasoning", "signature": "bad"},
                    {"type": "text", "text": "keep this"},
                    {"type": "redacted_thinking", "data": "opaque"}
                ]
            }]
        });
        remove_invalid_thinking_blocks(&mut request);
        assert_eq!(request["model"], "fixture");
        assert_eq!(
            request["messages"][0]["content"].as_array().unwrap().len(),
            1
        );
        assert_eq!(request["messages"][0]["content"][0]["text"], "keep this");
    }

    #[test]
    fn upstream_url_does_not_duplicate_v1_and_rejects_non_http() {
        assert_eq!(
            upstream_url(
                "https://example.test/v1",
                RouteKind::CodexResponses,
                "/v1/responses",
            )
            .unwrap(),
            "https://example.test/v1/responses"
        );
        assert_eq!(
            upstream_url(
                "https://example.test",
                RouteKind::ClaudeMessages,
                "/v1/messages",
            )
            .unwrap(),
            "https://example.test/v1/messages"
        );
        assert!(upstream_url("file:///secret", RouteKind::ClaudeMessages, "/v1/messages").is_err());
        assert_eq!(
            upstream_url(
                "https://example.test",
                RouteKind::Grok,
                "/grokbuild/v1/chat/completions",
            )
            .unwrap(),
            "https://example.test/grokbuild/v1/chat/completions"
        );
    }

    #[test]
    fn budget_classifier_requires_explicit_budget_or_thinking_constraint() {
        assert!(is_thinking_budget_error(
            br#"{"error":"budget_tokens must be less than max_tokens"}"#
        ));
        assert!(is_thinking_budget_error(
            br#"{"error":"thinking budget constraint"}"#
        ));
        assert!(!is_thinking_budget_error(
            br#"{"error":"invalid JSON body"}"#
        ));
        assert!(!is_thinking_budget_error(
            br#"{"error":"model is unavailable"}"#
        ));
    }

    #[test]
    fn budget_rectifier_sets_safe_values_and_keeps_adaptive_thinking() {
        let mut request = serde_json::json!({
            "thinking": {"type": "enabled", "budget_tokens": 65536, "effort": "max"},
            "max_tokens": 1024
        });
        assert!(rectify_thinking_budget(&mut request));
        assert_eq!(request["thinking"]["type"], "enabled");
        assert_eq!(request["thinking"]["budget_tokens"], 32000);
        assert_eq!(request["thinking"]["effort"], "max");
        assert_eq!(request["max_tokens"], 64000);

        let mut adaptive = serde_json::json!({
            "thinking": {"type": "adaptive"},
            "max_tokens": 4096
        });
        assert!(!rectify_thinking_budget(&mut adaptive));
        assert_eq!(adaptive["thinking"]["type"], "adaptive");
        assert_eq!(adaptive["max_tokens"], 4096);
    }

    #[test]
    fn hop_by_hop_headers_are_not_forwarded() {
        assert!(is_hop_by_hop("Connection"));
        assert!(is_hop_by_hop("Content-Length"));
        assert!(!is_hop_by_hop("anthropic-version"));
    }

    fn candidate(id: &str) -> KeyCandidate {
        KeyCandidate {
            id: id.to_string(),
            api_key: format!("secret-{id}"),
        }
    }

    #[test]
    fn key_pool_is_active_first_then_round_robin_without_duplicate_attempts() {
        let state = RouteState::default();
        let candidates = vec![candidate("active"), candidate("second"), candidate("third")];
        assert_eq!(
            state.select_key("claude:provider", candidates).unwrap().id,
            "active"
        );
        let used = HashSet::from(["active".to_string()]);
        assert_eq!(
            state.next_key("claude:provider", &used).unwrap().id,
            "second"
        );
        let used = HashSet::from(["active".to_string(), "second".to_string()]);
        assert_eq!(
            state.next_key("claude:provider", &used).unwrap().id,
            "third"
        );
        let used = HashSet::from([
            "active".to_string(),
            "second".to_string(),
            "third".to_string(),
        ]);
        assert!(state.next_key("claude:provider", &used).is_none());
    }

    #[test]
    fn key_pool_reload_resets_cursor_and_generation() {
        let state = RouteState::default();
        state
            .select_key(
                "codex:provider",
                vec![candidate("active"), candidate("second")],
            )
            .unwrap();
        assert_eq!(state.pools.lock().unwrap()["codex:provider"].generation, 1);
        assert_eq!(
            state
                .select_key(
                    "codex:provider",
                    vec![candidate("second"), candidate("active")]
                )
                .unwrap()
                .id,
            "second"
        );
        assert_eq!(state.pools.lock().unwrap()["codex:provider"].generation, 2);
    }

    #[test]
    fn key_pool_cooldown_skips_key_and_bounds_retry_after() {
        let state = RouteState::default();
        state
            .select_key(
                "grokbuild:provider",
                vec![candidate("one"), candidate("two")],
            )
            .unwrap();
        let headers = reqwest::header::HeaderMap::new();
        state.mark_cooldown("grokbuild:provider", "one", 401, &headers);
        assert_eq!(
            state
                .next_key("grokbuild:provider", &HashSet::new())
                .unwrap()
                .id,
            "two"
        );
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("999"));
        assert_eq!(retry_cooldown(429, &headers), KEY_COOLDOWN_MAX);
    }

    #[test]
    fn key_cooldown_is_runtime_only_and_reload_rebuilds_the_pool() {
        let state = RouteState::default();
        let candidates = vec![candidate("one"), candidate("two")];
        state
            .select_key("claude:provider", candidates.clone())
            .unwrap();
        state.mark_cooldown(
            "claude:provider",
            "one",
            401,
            &reqwest::header::HeaderMap::new(),
        );
        assert_eq!(
            state
                .next_key("claude:provider", &HashSet::new())
                .unwrap()
                .id,
            "two"
        );

        let restarted = RouteState::default();
        assert_eq!(
            restarted
                .select_key("claude:provider", candidates)
                .unwrap()
                .id,
            "one"
        );
    }

    #[test]
    fn model_mapping_is_trimmed_exact_and_finally_pinned() {
        let mappings = parse_model_mappings(
            "codex",
            r#"{"advanced":{"modelMappings":[{"source":" a ","target":" b "}]}}"#,
        )
        .unwrap();
        let body = apply_model_mapping(
            &serde_json::json!({"model":"a","messages":[],"override":{"model":"c"}}),
            &mappings,
        )
        .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["model"], "b");
        assert_eq!(body["override"]["model"], "c");
        let unchanged = apply_model_mapping(&serde_json::json!({"model":"A"}), &mappings).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&unchanged).unwrap()["model"],
            "A"
        );
    }

    #[test]
    fn model_mapping_rejects_empty_and_duplicate_sources() {
        assert_eq!(
            parse_model_mappings(
                "grokbuild",
                r#"{"advanced":{"modelMappings":[{"source":" ","target":"b"}]}}"#,
            )
            .unwrap_err(),
            "provider_model_mapping_source_required"
        );
        assert_eq!(
            parse_model_mappings(
                "grokbuild",
                r#"{"advanced":{"modelMappings":[{"source":"a","target":"b"},{"source":"a","target":"c"}]}}"#,
            )
            .unwrap_err(),
            "provider_model_mapping_duplicate_source"
        );
    }

    #[test]
    fn failover_mapping_restarts_from_original_source_for_each_provider() {
        let request = serde_json::json!({"model":"a","messages":[]});
        let first = parse_model_mappings(
            "codex",
            r#"{"advanced":{"modelMappings":[{"source":"a","target":"targetA"}]}}"#,
        )
        .unwrap();
        let fallback = parse_model_mappings(
            "codex",
            r#"{"advanced":{"modelMappings":[{"source":"a","target":"targetB"}]}}"#,
        )
        .unwrap();
        let first_body: serde_json::Value =
            serde_json::from_slice(&apply_model_mapping(&request, &first).unwrap()).unwrap();
        assert_eq!(first_body["model"], "targetA");
        let fallback_body: serde_json::Value =
            serde_json::from_slice(&apply_model_mapping(&request, &fallback).unwrap()).unwrap();
        assert_eq!(fallback_body["model"], "targetB");
    }

    #[test]
    fn generic_sse_commits_on_first_parseable_event_and_ignores_keepalive() {
        let mut tracker = StreamCommitTracker::new(StreamCommitKind::GenericSse);
        assert!(!tracker.observe(&Bytes::from_static(b": ping\n\n")));
        assert!(!tracker.observe(&Bytes::from_static(b"data: {")));
        assert!(tracker.observe(&Bytes::from_static(b"\"type\":\"message_start\"}\n\n")));
        assert!(tracker.observe(&Bytes::from_static(b"data: {\"later\":true}\n\n")));
    }

    #[test]
    fn responses_sse_waits_for_output_or_error_event() {
        let mut tracker = StreamCommitTracker::new(StreamCommitKind::ResponsesSse);
        assert!(!tracker.observe(&Bytes::from_static(b": keepalive\n\n")));
        assert!(!tracker.observe(&Bytes::from_static(
            b"data: {\"type\":\"response.created\"}\n\n"
        )));
        assert!(tracker.observe(&Bytes::from_static(
            b"data: {\"type\":\"response.output_text.delta\"}\n\n"
        )));
    }

    #[test]
    fn responses_sse_error_is_a_commit_boundary() {
        let mut tracker = StreamCommitTracker::new(StreamCommitKind::ResponsesSse);
        assert!(tracker.observe(&Bytes::from_static(
            b"event: error\ndata: {\"message\":\"upstream failed\"}\n\n"
        )));
    }

    #[test]
    fn listener_serves_fixed_router_errors_without_provider_data() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = RouteHttpServer::start(&[listener]).unwrap();
        let mut stream = None;
        for _ in 0..20 {
            if let Ok(candidate) = TcpStream::connect(address) {
                stream = Some(candidate);
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let mut stream = stream.expect("route listener should accept connections");
        stream
            .write_all(
                b"GET /not-registered HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut buffer = [0_u8; 4096];
        let size = stream.read(&mut buffer).unwrap();
        let response = String::from_utf8_lossy(&buffer[..size]);
        assert!(response.starts_with("HTTP/1.1 404"));
        assert!(response.contains("routing_path_not_found"));
        drop(stream);
        drop(server);
    }
}
