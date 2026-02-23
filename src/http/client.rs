//! Minimal streaming HTTP client for Pi.
//!
//! This is intentionally small and purpose-built for provider streaming (SSE).
//! Internally uses reqwest for HTTP transport.

use crate::error::{Error, Result};
use crate::vcr::{RecordedRequest, VcrRecorder};
use futures::Stream;
use futures::StreamExt;
use futures::TryStreamExt;
use futures::stream::BoxStream;
use std::pin::Pin;
use std::sync::OnceLock;

const DEFAULT_USER_AGENT: &str = concat!("pi_agent_rust/", env!("CARGO_PKG_VERSION"));
const ANTIGRAVITY_VERSION_ENV: &str = "PI_AI_ANTIGRAVITY_VERSION";
const MAX_TEXT_BODY_BYTES: usize = 50 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 60;

fn default_request_timeout_from_env() -> Option<std::time::Duration> {
    static REQUEST_TIMEOUT: OnceLock<Option<std::time::Duration>> = OnceLock::new();
    *REQUEST_TIMEOUT.get_or_init(|| {
        let timeout_secs = std::env::var("PI_HTTP_REQUEST_TIMEOUT_SECS")
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_REQUEST_TIMEOUT_SECS);
        if timeout_secs == 0 {
            None
        } else {
            Some(std::time::Duration::from_secs(timeout_secs))
        }
    })
}

fn build_user_agent() -> String {
    std::env::var(ANTIGRAVITY_VERSION_ENV).map_or_else(
        |_| DEFAULT_USER_AGENT.to_string(),
        |v| format!("{DEFAULT_USER_AGENT} Antigravity/{v}"),
    )
}

#[derive(Debug, Clone)]
pub struct Client {
    inner: reqwest::Client,
    user_agent: String,
    vcr: Option<VcrRecorder>,
}

impl Client {
    #[must_use]
    pub fn new() -> Self {
        let user_agent = build_user_agent();
        let inner = reqwest::Client::builder()
            .user_agent(&user_agent)
            .http1_only()
            .build()
            .expect("build reqwest client");

        Self {
            inner,
            user_agent,
            vcr: None,
        }
    }

    pub fn post(&self, url: &str) -> RequestBuilder<'_> {
        RequestBuilder::new(self, Method::Post, url)
    }

    pub fn get(&self, url: &str) -> RequestBuilder<'_> {
        RequestBuilder::new(self, Method::Get, url)
    }

    #[must_use]
    pub fn with_vcr(mut self, recorder: VcrRecorder) -> Self {
        self.vcr = Some(recorder);
        self
    }

    pub const fn vcr(&self) -> Option<&VcrRecorder> {
        self.vcr.as_ref()
    }
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy)]
enum Method {
    Get,
    Post,
}

impl Method {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

pub struct RequestBuilder<'a> {
    client: &'a Client,
    method: Method,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    timeout: Option<std::time::Duration>,
}

impl<'a> RequestBuilder<'a> {
    fn new(client: &'a Client, method: Method, url: &str) -> Self {
        Self {
            client,
            method,
            url: url.to_string(),
            headers: Vec::new(),
            body: Vec::new(),
            timeout: default_request_timeout_from_env(),
        }
    }

    #[must_use]
    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }

    #[must_use]
    pub const fn timeout(mut self, duration: std::time::Duration) -> Self {
        self.timeout = Some(duration);
        self
    }

    /// Remove the timeout entirely. Use for requests that are expected to take
    /// an arbitrarily long time (e.g. long-polling SSE streams).
    #[must_use]
    pub const fn no_timeout(mut self) -> Self {
        self.timeout = None;
        self
    }

    /// Set raw body bytes.
    #[must_use]
    pub fn body(mut self, body: Vec<u8>) -> Self {
        self.body = body;
        self
    }

    pub fn json<T: serde::Serialize>(mut self, payload: &T) -> Result<Self> {
        self.headers
            .push(("Content-Type".to_string(), "application/json".to_string()));
        self.body = serde_json::to_vec(payload)?;
        Ok(self)
    }

    pub async fn send(self) -> Result<Response> {
        let RequestBuilder {
            client,
            method,
            url,
            headers,
            body,
            timeout,
        } = self;

        if let Some(recorder) = client.vcr() {
            let recorded_request = build_recorded_request(method, &url, &headers, &body);
            let recorded = recorder
                .request_streaming_with(recorded_request, || async {
                    let (status, response_headers, stream) =
                        send_parts(client, method, &url, &headers, &body, timeout).await?;
                    Ok((status, response_headers, stream))
                })
                .await?;
            let status = recorded.status;
            let response_headers = recorded.headers.clone();
            let stream = recorded.into_byte_stream();
            return Ok(Response {
                status,
                headers: response_headers,
                stream,
            });
        }

        let (status, response_headers, stream) =
            send_parts(client, method, &url, &headers, &body, timeout).await?;

        Ok(Response {
            status,
            headers: response_headers,
            stream,
        })
    }
}

async fn send_parts(
    client: &Client,
    method: Method,
    url: &str,
    headers: &[(String, String)],
    body: &[u8],
    timeout: Option<std::time::Duration>,
) -> Result<(
    u16,
    Vec<(String, String)>,
    BoxStream<'static, std::io::Result<Vec<u8>>>,
)> {
    let reqwest_method = match method {
        Method::Get => reqwest::Method::GET,
        Method::Post => reqwest::Method::POST,
    };

    let mut builder = client.inner.request(reqwest_method, url);

    for (key, value) in headers {
        builder = builder.header(key, value);
    }

    if !body.is_empty() {
        builder = builder.body(body.to_vec());
    }

    if let Some(duration) = timeout {
        builder = builder.timeout(duration);
    }

    let response = builder.send().await.map_err(|e| {
        if e.is_timeout() {
            Error::api("Request timed out")
        } else {
            Error::api(format!("HTTP request failed: {e}"))
        }
    })?;

    let status = response.status().as_u16();

    let response_headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or("").to_string(),
            )
        })
        .collect();

    let stream = response
        .bytes_stream()
        .map(|result| {
            result
                .map(|bytes| bytes.to_vec())
                .map_err(|e| std::io::Error::other(e.to_string()))
        })
        .boxed();

    Ok((status, response_headers, stream))
}

fn build_recorded_request(
    method: Method,
    url: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> RecordedRequest {
    let mut body_value = None;
    let mut body_text = None;

    if !body.is_empty() {
        let is_json = headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("content-type")
                && value.to_ascii_lowercase().contains("application/json")
        });

        if is_json {
            match serde_json::from_slice::<serde_json::Value>(body) {
                Ok(value) => body_value = Some(value),
                Err(_) => body_text = Some(String::from_utf8_lossy(body).to_string()),
            }
        } else {
            body_text = Some(String::from_utf8_lossy(body).to_string());
        }
    }

    RecordedRequest {
        method: method.as_str().to_string(),
        url: url.to_string(),
        headers: headers.to_vec(),
        body: body_value,
        body_text,
    }
}

pub struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    stream: Pin<Box<dyn Stream<Item = std::io::Result<Vec<u8>>> + Send>>,
}

impl Response {
    #[must_use]
    pub const fn status(&self) -> u16 {
        self.status
    }

    #[must_use]
    pub fn headers(&self) -> &[(String, String)] {
        &self.headers
    }

    #[must_use]
    pub fn bytes_stream(self) -> Pin<Box<dyn Stream<Item = std::io::Result<Vec<u8>>> + Send>> {
        self.stream
    }

    pub async fn text(self) -> Result<String> {
        let bytes = self
            .stream
            .try_fold(Vec::new(), |mut acc, chunk| async move {
                if acc.len().saturating_add(chunk.len()) > MAX_TEXT_BODY_BYTES {
                    return Err(std::io::Error::other("response body too large"));
                }
                acc.extend_from_slice(&chunk);
                Ok::<_, std::io::Error>(acc)
            })
            .await
            .map_err(Error::from)?;

        match String::from_utf8(bytes) {
            Ok(s) => Ok(s),
            Err(e) => Ok(String::from_utf8_lossy(e.as_bytes()).into_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── Method ──────────────────────────────────────────────────────────
    #[test]
    fn method_as_str_get() {
        assert_eq!(Method::Get.as_str(), "GET");
    }

    #[test]
    fn method_as_str_post() {
        assert_eq!(Method::Post.as_str(), "POST");
    }

    // ── build_recorded_request ─────────────────────────────────────────
    #[test]
    fn build_recorded_request_empty_body() {
        let req = build_recorded_request(Method::Post, "https://api.test.com/v1", &[], &[]);
        assert_eq!(req.method, "POST");
        assert_eq!(req.url, "https://api.test.com/v1");
        assert!(req.body.is_none());
        assert!(req.body_text.is_none());
    }

    #[test]
    fn build_recorded_request_json_body() {
        let headers = vec![("Content-Type".to_string(), "application/json".to_string())];
        let body = serde_json::to_vec(&json!({"model": "test"})).unwrap();
        let req = build_recorded_request(Method::Post, "https://api.test.com/v1", &headers, &body);
        assert!(req.body.is_some());
        assert_eq!(req.body.unwrap()["model"], "test");
        assert!(req.body_text.is_none());
    }

    #[test]
    fn build_recorded_request_text_body() {
        let headers = vec![("Content-Type".to_string(), "text/plain".to_string())];
        let body = b"hello world";
        let req = build_recorded_request(Method::Post, "https://api.test.com/v1", &headers, body);
        assert!(req.body.is_none());
        assert_eq!(req.body_text.as_deref(), Some("hello world"));
    }

    #[test]
    fn build_recorded_request_invalid_json_body_falls_back_to_text() {
        let headers = vec![("Content-Type".to_string(), "application/json".to_string())];
        let body = b"not json {{{";
        let req = build_recorded_request(Method::Post, "https://api.test.com/v1", &headers, body);
        assert!(req.body.is_none());
        assert_eq!(req.body_text.as_deref(), Some("not json {{{"));
    }

    #[test]
    fn build_recorded_request_preserves_headers() {
        let headers = vec![
            ("Authorization".to_string(), "Bearer key".to_string()),
            ("X-Trace".to_string(), "abc123".to_string()),
        ];
        let req = build_recorded_request(Method::Get, "https://test.com", &headers, &[]);
        assert_eq!(req.headers.len(), 2);
        assert_eq!(req.headers[0].0, "Authorization");
    }

    // ── Client builder methods ─────────────────────────────────────────
    #[test]
    fn client_default() {
        let client = Client::default();
        assert!(client.vcr().is_none());
    }

    #[test]
    fn client_with_vcr() {
        let recorder = VcrRecorder::new_with(
            "test",
            crate::vcr::VcrMode::Playback,
            std::path::Path::new("/tmp"),
        );
        let client = Client::new().with_vcr(recorder);
        assert!(client.vcr().is_some());
    }

    // ── RequestBuilder ─────────────────────────────────────────────────
    #[test]
    fn request_builder_header_chaining() {
        let client = Client::new();
        let builder = client
            .post("https://api.example.com")
            .header("Authorization", "Bearer test")
            .header("X-Custom", "value");
        assert_eq!(builder.headers.len(), 2);
    }

    #[test]
    fn request_builder_json() {
        let client = Client::new();
        let builder = client
            .post("https://api.example.com")
            .json(&json!({"key": "value"}))
            .unwrap();
        assert!(!builder.body.is_empty());
        // Should have auto-added Content-Type header
        assert!(
            builder
                .headers
                .iter()
                .any(|(k, v)| k == "Content-Type" && v == "application/json")
        );
    }

    #[test]
    fn request_builder_body() {
        let client = Client::new();
        let builder = client
            .post("https://api.example.com")
            .body(b"raw bytes".to_vec());
        assert_eq!(builder.body, b"raw bytes");
    }

    #[test]
    fn request_builder_default_timeout() {
        let client = Client::new();
        let builder = client.get("https://api.example.com");
        assert_eq!(
            builder.timeout,
            Some(std::time::Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS))
        );
    }

    #[test]
    fn request_builder_timeout() {
        let client = Client::new();
        let builder = client
            .get("https://api.example.com")
            .timeout(std::time::Duration::from_secs(30));
        assert_eq!(builder.timeout, Some(std::time::Duration::from_secs(30)));
    }

    #[test]
    fn request_builder_no_timeout() {
        let client = Client::new();
        let builder = client.get("https://api.example.com").no_timeout();
        assert_eq!(builder.timeout, None);
    }

    // ── Response ───────────────────────────────────────────────────────
    #[test]
    fn response_accessors() {
        let response = Response {
            status: 200,
            headers: vec![("Content-Type".to_string(), "text/plain".to_string())],
            stream: Box::pin(futures::stream::empty()),
        };
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers().len(), 1);
        assert_eq!(response.headers()[0].0, "Content-Type");
    }

    #[tokio::test]
    async fn response_text() {
        let chunks = vec![Ok(b"hello ".to_vec()), Ok(b"world".to_vec())];
        let response = Response {
            status: 200,
            headers: Vec::new(),
            stream: Box::pin(futures::stream::iter(chunks)),
        };
        let text = response.text().await.unwrap();
        assert_eq!(text, "hello world");
    }

    #[tokio::test]
    async fn response_text_empty() {
        let response = Response {
            status: 200,
            headers: Vec::new(),
            stream: Box::pin(futures::stream::empty()),
        };
        let text = response.text().await.unwrap();
        assert_eq!(text, "");
    }

    #[tokio::test]
    async fn response_bytes_stream() {
        let chunks = vec![Ok(b"data".to_vec())];
        let response = Response {
            status: 200,
            headers: Vec::new(),
            stream: Box::pin(futures::stream::iter(chunks)),
        };
        let mut stream = response.bytes_stream();
        let first = stream.next().await.unwrap().unwrap();
        assert_eq!(first, b"data");
        assert!(stream.next().await.is_none());
    }

    // ── Body stream via Response (in-memory) ──────────────────────────
    #[tokio::test]
    async fn body_stream_content_length_via_response() {
        let body = b"Hello, World!";
        let chunks: Vec<std::io::Result<Vec<u8>>> = vec![Ok(body.to_vec())];
        let response = Response {
            status: 200,
            headers: vec![("Content-Length".to_string(), "13".to_string())],
            stream: Box::pin(futures::stream::iter(chunks)),
        };
        let text = response.text().await.unwrap();
        assert_eq!(text, "Hello, World!");
    }

    #[tokio::test]
    async fn body_stream_multiple_chunks_via_response() {
        let chunks: Vec<std::io::Result<Vec<u8>>> = vec![
            Ok(b"chunk1".to_vec()),
            Ok(b"chunk2".to_vec()),
            Ok(b"chunk3".to_vec()),
        ];
        let response = Response {
            status: 200,
            headers: Vec::new(),
            stream: Box::pin(futures::stream::iter(chunks)),
        };
        let text = response.text().await.unwrap();
        assert_eq!(text, "chunk1chunk2chunk3");
    }

    #[tokio::test]
    async fn body_stream_error_propagation() {
        let chunks: Vec<std::io::Result<Vec<u8>>> = vec![
            Ok(b"data".to_vec()),
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "connection reset",
            )),
        ];
        let response = Response {
            status: 200,
            headers: Vec::new(),
            stream: Box::pin(futures::stream::iter(chunks)),
        };
        let result = response.text().await;
        assert!(result.is_err());
    }

    // ── Edge cases ─────────────────────────────────────────────────────

    #[test]
    fn build_recorded_request_content_type_case_insensitive() {
        let headers = vec![("content-type".to_string(), "APPLICATION/JSON".to_string())];
        let body = serde_json::to_vec(&json!({"test": true})).unwrap();
        let req = build_recorded_request(Method::Post, "https://test.com", &headers, &body);
        // Should detect JSON despite case differences
        assert!(req.body.is_some());
    }

    // ── Response body size limit ──────────────────────────────────────
    #[tokio::test]
    async fn response_text_rejects_oversized_body() {
        // Create a stream that would exceed MAX_TEXT_BODY_BYTES
        let big_chunk = vec![0u8; MAX_TEXT_BODY_BYTES + 1];
        let chunks: Vec<std::io::Result<Vec<u8>>> = vec![Ok(big_chunk)];
        let response = Response {
            status: 200,
            headers: Vec::new(),
            stream: Box::pin(futures::stream::iter(chunks)),
        };
        let result = response.text().await;
        assert!(result.is_err());
        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("too large"),
            "error should mention size: {err_msg}"
        );
    }

    #[tokio::test]
    async fn response_text_accepts_body_at_limit() {
        let chunk = vec![b'a'; MAX_TEXT_BODY_BYTES];
        let chunks: Vec<std::io::Result<Vec<u8>>> = vec![Ok(chunk)];
        let response = Response {
            status: 200,
            headers: Vec::new(),
            stream: Box::pin(futures::stream::iter(chunks)),
        };
        let result = response.text().await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), MAX_TEXT_BODY_BYTES);
    }

    // ── PI_AI_ANTIGRAVITY_VERSION env var ─────────────────────────────

    #[test]
    fn antigravity_user_agent_format() {
        // Verify the format string used when PI_AI_ANTIGRAVITY_VERSION is set.
        let version = "1.2.3";
        let ua = format!("{DEFAULT_USER_AGENT} Antigravity/{version}");
        assert!(ua.starts_with("pi_agent_rust/"));
        assert!(ua.contains("Antigravity/1.2.3"));

        // Verify default user agent contains crate version.
        assert!(DEFAULT_USER_AGENT.starts_with("pi_agent_rust/"));
    }
}
