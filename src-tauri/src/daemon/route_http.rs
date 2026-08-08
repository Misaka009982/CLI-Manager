use bytes::Bytes;
use futures_util::StreamExt;
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
use std::convert::Infallible;
use std::error::Error;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(120);

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
    base_url: String,
    api_key: String,
    claude_api_key_field: Option<String>,
    claude_api_format: Option<String>,
}

pub(crate) struct RouteHttpServer {
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
}

impl RouteHttpServer {
    pub(crate) fn start(listeners: &[TcpListener]) -> Result<Self, String> {
        if listeners.is_empty() {
            return Err("routing_listener_missing".to_string());
        }
        let stop = Arc::new(AtomicBool::new(false));
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
                    local.block_on(&runtime, serve_listener(listener, worker_stop));
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
        Ok(Self { stop, workers })
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

async fn serve_listener(listener: TcpListener, stop: Arc<AtomicBool>) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        return;
    };
    while !stop.load(Ordering::Acquire) {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(50)) => {},
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                tokio::task::spawn_local(async move {
                    let io = TokioIo::new(stream);
                    let service = service_fn(handle_request);
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, service)
                        .await;
                });
            }
        }
    }
}

async fn handle_request(request: Request<Incoming>) -> Result<Response<RouteBody>, Infallible> {
    Ok(match forward_request(request).await {
        Ok(response) => response,
        Err((status, message)) => error_response(status, message),
    })
}

async fn forward_request(
    request: Request<Incoming>,
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
    let snapshot = load_provider_snapshot(route).await.map_err(|error| {
        log::warn!("routing provider snapshot unavailable: {error}");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "routing_provider_unavailable",
        )
    })?;
    let url = upstream_url(&snapshot.base_url, route, &request_path)
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_provider_endpoint_invalid"))?;
    let client = reqwest::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        .build()
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_client_failed"))?;
    let mut upstream = client.post(url);
    for (name, value) in headers {
        upstream = upstream.header(name, value);
    }
    if use_claude_api_key_header(&snapshot) {
        upstream = upstream.header("x-api-key", snapshot.api_key.clone());
    } else {
        upstream = upstream.header(
            AUTHORIZATION.as_str(),
            format!("Bearer {}", snapshot.api_key),
        );
    }
    let response = upstream
        .header(REQ_CONTENT_TYPE.as_str(), "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "routing_upstream_request_failed"))?;
    let status = response.status();
    let headers = response.headers().clone();
    let stream = response.bytes_stream().map(|chunk| {
        chunk
            .map(Frame::data)
            .map_err(|error| -> BoxError { Box::new(error) })
    });
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
    let detail = crate::provider::repository::get_provider(app_type.to_string(), card.id).await?;
    let key = detail
        .keys
        .iter()
        .find(|key| key.is_active && key.enabled)
        .ok_or_else(|| "routing_provider_key_not_active".to_string())?;
    let api_key = crate::provider::repository::reveal_key(
        app_type.to_string(),
        detail.card.id.clone(),
        key.id.clone(),
    )
    .await?;
    let base_url = detail
        .card
        .base_url
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "routing_provider_endpoint_missing".to_string())?;
    Ok(ProviderSnapshot {
        app_type,
        base_url,
        api_key,
        claude_api_key_field: detail
            .claude_config
            .as_ref()
            .map(|config| config.api_key_field.clone()),
        claude_api_format: detail.claude_config.map(|config| config.api_format),
    })
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
