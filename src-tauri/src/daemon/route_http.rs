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
    selected_key: KeyCandidate,
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
    let snapshot = match load_provider_snapshot(route, &state).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            log::warn!("routing provider snapshot unavailable: {error}");
            return Err(if error.starts_with("provider_model_mapping_") {
                (StatusCode::BAD_REQUEST, "routing_model_mapping_invalid")
            } else {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "routing_provider_unavailable",
                )
            });
        }
    };
    let circuit_policy = CircuitPolicy {
        failure_threshold: failover_config.circuit_failure_threshold,
        success_threshold: failover_config.circuit_success_threshold,
        timeout: Duration::from_secs(failover_config.circuit_timeout_seconds),
        error_rate_threshold: failover_config.circuit_error_rate_threshold,
        min_requests: failover_config.circuit_min_requests,
    };
    let mut circuit_permit = if failover_config.auto_failover_enabled {
        Some(
            state
                .circuits
                .acquire(route_app_type(route), &snapshot.provider_id, circuit_policy)
                .map_err(|_| {
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "routing_provider_circuit_open",
                    )
                })?,
        )
    } else {
        None
    };
    let url = upstream_url(&snapshot.base_url, route, &request_path)
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_provider_endpoint_invalid"))?;
    let mut client_builder = reqwest::Client::builder();
    if !streaming {
        client_builder =
            client_builder.timeout(Duration::from_secs(failover_config.non_streaming_timeout));
    }
    let client = client_builder
        .build()
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_client_failed"))?;
    let mut used_keys = HashSet::from([snapshot.selected_key.id.clone()]);
    let mut selected_key = snapshot.selected_key.clone();
    let mut provider_attempt: u32 = 0;
    let max_attempts = if failover_config.auto_failover_enabled {
        max_attempts(failover_config.max_retries)
    } else {
        1
    };
    let response = loop {
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
        let attempt_body = apply_model_mapping(&request_json, &snapshot.model_mappings)
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
            Err(_failure) if provider_attempt.saturating_add(1) < max_attempts => {
                provider_attempt = provider_attempt.saturating_add(1);
                continue;
            }
            Err(UpstreamSendFailure::Timeout) => {
                record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
                return Err((StatusCode::GATEWAY_TIMEOUT, "routing_upstream_timeout"));
            }
            Err(UpstreamSendFailure::Request) => {
                record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
                return Err((StatusCode::BAD_GATEWAY, "routing_upstream_request_failed"));
            }
        };
        if classify_upstream_status(response.status()) == UpstreamErrorClass::Provider {
            if provider_attempt.saturating_add(1) < max_attempts {
                provider_attempt = provider_attempt.saturating_add(1);
                continue;
            }
            record_circuit_failure(&state, &mut circuit_permit, circuit_policy);
            return Err((StatusCode::BAD_GATEWAY, "routing_upstream_provider_failed"));
        }
        if !is_key_retryable(response.status()) {
            break response;
        }
        state.mark_cooldown(
            &snapshot.pool_id,
            &selected_key.id,
            response.status().as_u16(),
            response.headers(),
        );
        let Some(next_key) = state.next_key(&snapshot.pool_id, &used_keys) else {
            break response;
        };
        used_keys.insert(next_key.id.clone());
        selected_key = next_key;
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

async fn load_provider_snapshot(
    route: RouteKind,
    state: &RouteState,
) -> Result<ProviderSnapshot, String> {
    let app_type = route_app_type(route);
    let providers = crate::provider::repository::list_providers(Some(app_type.to_string())).await?;
    let card = providers
        .into_iter()
        .find(|provider| provider.is_current && provider.enabled)
        .ok_or_else(|| "routing_provider_not_ready".to_string())?;
    let detail = crate::provider::repository::get_provider(app_type.to_string(), card.id).await?;
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
    let selected_key = state.select_key(&pool_id, candidates)?;
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
        selected_key,
        model_mappings,
    })
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
