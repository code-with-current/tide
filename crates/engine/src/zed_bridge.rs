//! The Zed transport bridge: a localhost listener that rig's Anthropic
//! client posts to. Translates between Anthropic wire format and Zed's
//! cloud protocol (envelope + NDJSON). One bridge per credential,
//! process-wide, so the LLM-token cache survives across turns.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::Value;

const CLOUD_URL: &str = "https://cloud.zed.dev";
/// Pinned client version header — the server gates behavior on it. Bump
/// when the live API rejects requests (undocumented API; see design doc).
const ZED_VERSION: &str = "1.19.2";

static CLOUD_OVERRIDE: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

pub(crate) fn set_cloud_url_for_tests(url: Option<String>) {
    *CLOUD_OVERRIDE.lock().unwrap_or_else(|p| p.into_inner()) = url;
}

fn cloud_url() -> String {
    CLOUD_OVERRIDE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_else(|| CLOUD_URL.to_owned())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZedCredential {
    pub user_id: String,
    pub access_token: String,
    #[serde(default)]
    pub organization_id: Option<String>,
}

pub(crate) struct ZedBridge {
    base_url: String,
    credential: ZedCredential,
    llm_token: Mutex<Option<String>>,
    _keep: Arc<TcpListener>,
}

static BRIDGES: LazyLock<Mutex<HashMap<String, Arc<ZedBridge>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// One shared bridge per credential blob. String errors — the caller wraps
/// them in `EngineError::Config`.
pub(crate) fn shared_bridge(blob: &str) -> Result<Arc<ZedBridge>, String> {
    let credential: ZedCredential =
        serde_json::from_str(blob).map_err(|e| format!("invalid zed credential blob: {e}"))?;
    if credential.user_id.is_empty() || credential.access_token.is_empty() {
        return Err("zed credential blob missing user id or access token".to_owned());
    }
    let mut bridges = BRIDGES.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(bridge) = bridges.get(blob) {
        return Ok(bridge.clone());
    }
    let bridge = ZedBridge::spawn(credential).map_err(|e| format!("zed bridge: {e}"))?;
    bridges.insert(blob.to_owned(), Arc::clone(&bridge));
    Ok(bridge)
}

impl ZedBridge {
    /// Bind an ephemeral port; the accept loop owns a listener Arc clone
    /// AND an Arc<Self> clone (captured before spawn) so connection threads
    /// can call `self.handle(stream)`.
    fn spawn(credential: ZedCredential) -> std::io::Result<Arc<Self>> {
        let listener = Arc::new(TcpListener::bind("127.0.0.1:0")?);
        let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let bridge = Arc::new(Self {
            base_url,
            credential,
            llm_token: Mutex::new(None),
            _keep: Arc::clone(&listener),
        });
        let accept_bridge = Arc::clone(&bridge);
        let accept_listener = Arc::clone(&listener);
        std::thread::Builder::new()
            .name("zed-bridge".into())
            .spawn(move || {
                for stream in accept_listener.incoming().flatten() {
                    let bridge = Arc::clone(&accept_bridge);
                    std::thread::spawn(move || {
                        let _ = bridge.handle(stream);
                    });
                }
            })?;
        Ok(bridge)
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    fn handle(&self, mut stream: TcpStream) -> std::io::Result<()> {
        let (_start, _headers, body) = read_request(&mut stream)?;
        let Ok(mut provider_request) = serde_json::from_slice::<Value>(&body) else {
            return write_plain_error(&mut stream, "400 Bad Request", "request body was not JSON");
        };
        let Some(model) = provider_request.get("model").and_then(Value::as_str).map(str::to_owned)
        else {
            return write_plain_error(&mut stream, "400 Bad Request", "request missing model id");
        };
        // v1 scope: only Claude models speak Anthropic format natively on
        // Zed's cloud (the preset's routing needles filter the wizard list
        // to match).
        if !model.contains("claude") {
            return write_plain_error(
                &mut stream,
                "400 Bad Request",
                "the zed provider currently supports claude models only",
            );
        }
        coerce_block_arrays(&mut provider_request);

        let envelope = serde_json::json!({
            "intent": "user_prompt",
            "provider": "anthropic",
            "model": model,
            "provider_request": provider_request,
        });
        match self.cloud_completion(&envelope) {
            Ok(events) => {
                write_sse_head(&mut stream)?;
                for event in events {
                    let ty = event.get("type").and_then(Value::as_str).unwrap_or("event");
                    let frame = format!("event: {ty}\ndata: {event}\n\n");
                    write_chunk(&mut stream, frame.as_bytes())?;
                }
                end_chunks(&mut stream)
            }
            Err(error) => write_plain_error(&mut stream, "502 Bad Gateway", &error),
        }
    }

    /// One NDJSON response from cloud.zed.dev/completions as parsed inner
    /// events. v1 buffers the full body before emitting SSE — verify
    /// first-token latency in the Task 17 smoke test; switch to a
    /// line-by-line Read loop writing chunks as they arrive if it lags.
    fn cloud_completion(&self, envelope: &Value) -> Result<Vec<Value>, String> {
        let token = self.llm_token(false)?;
        let response = self.post_completions(&token, envelope)?;
        let status = response.status();
        if should_refresh(status.as_u16(), response.headers()) {
            let token = self.llm_token(true)?;
            let response = self.post_completions(&token, envelope)?;
            return self.read_ndjson(response);
        }
        if !status.is_success() {
            return Err(format!("zed cloud HTTP {status}"));
        }
        self.read_ndjson(response)
    }

    fn post_completions(
        &self,
        token: &str,
        envelope: &Value,
    ) -> Result<reqwest::blocking::Response, String> {
        let client = reqwest::blocking::Client::new();
        client
            .post(format!("{}/completions", cloud_url()))
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .header("x-zed-version", ZED_VERSION)
            .header("x-zed-client-supports-status-messages", "true")
            .header("x-zed-client-supports-stream-ended-request-completion-status", "true")
            .json(envelope)
            .send()
            .map_err(|e| format!("cloud.zed.dev unreachable: {e}"))
    }

    fn read_ndjson(&self, response: reqwest::blocking::Response) -> Result<Vec<Value>, String> {
        let text = response.text().map_err(|e| format!("cloud stream read: {e}"))?;
        let mut events = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() { continue; }
            if let Ok(wrapped) = serde_json::from_str::<Value>(line) {
                if let Some(event) = wrapped.get("event") {
                    events.push(event.clone());
                }
            }
        }
        Ok(events)
    }

    fn llm_token(&self, force: bool) -> Result<String, String> {
        let mut cache = self.llm_token.lock().unwrap_or_else(|p| p.into_inner());
        if force {
            *cache = None;
        }
        if let Some(token) = cache.clone() {
            return Ok(token);
        }
        let client = reqwest::blocking::Client::new();
        let mut body = serde_json::Map::new();
        if let Some(org) = &self.credential.organization_id {
            body.insert("organization_id".into(), Value::String(org.clone()));
        }
        let response = client
            .post(format!("{}/client/llm_tokens", cloud_url()))
            .header("Authorization", format!("{} {}", self.credential.user_id, self.credential.access_token))
            .json(&body)
            .send()
            .map_err(|e| format!("cloud.zed.dev unreachable: {e}"))?;
        if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
            return Err("Zed sign-in expired — sign in to Zed desktop, then re-add or re-sign-in the provider".to_owned());
        }
        if !response.status().is_success() {
            return Err(format!("llm-token HTTP {}", response.status()));
        }
        let token = response
            .json::<Value>()
            .ok()
            .and_then(|v| v.get("token").and_then(Value::as_str).map(str::to_owned))
            .ok_or_else(|| "llm-token response missing token".to_owned())?;
        *cache = Some(token.clone());
        Ok(token)
    }
}

fn read_request(
    stream: &mut TcpStream,
) -> std::io::Result<(String, Vec<(String, String)>, Vec<u8>)> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut start = String::new();
    reader.read_line(&mut start)?;
    let mut headers = Vec::new();
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let trimmed = line.trim_end().to_owned();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    Ok((start, headers, body))
}

/// Zed's Anthropic parser rejects string message content ("expected a
/// sequence") — always send block arrays.
fn coerce_block_arrays(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages.iter_mut() {
        let Some(text) = message.get("content").and_then(Value::as_str).map(str::to_owned)
        else { continue };
        message["content"] = serde_json::json!([{ "type": "text", "text": text }]);
    }
}

fn should_refresh(status: u16, headers: &reqwest::header::HeaderMap) -> bool {
    status == 401
        || headers.contains_key("x-zed-expired-token")
        || headers.contains_key("x-zed-outdated-token")
}

fn write_sse_head(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
    )
}

fn write_chunk(stream: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    stream.write_all(format!("{:x}\r\n", bytes.len()).as_bytes())?;
    stream.write_all(bytes)?;
    stream.write_all(b"\r\n")
}

fn end_chunks(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.write_all(b"0\r\n\r\n")
}

fn write_plain_error(stream: &mut TcpStream, status: &str, message: &str) -> std::io::Result<()> {
    let body = format!("{{\"error\":{{\"message\":\"{message}\"}}}}");
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes tests that point the process-wide cloud URL override at a
    /// FakeCloud — same shape as the backend's tide_zed tests.
    static CLOUD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Points the global cloud URL override at `url` until the guard drops.
    /// The held lock serializes FakeCloud tests, and Drop clears the
    /// override even when a failing assertion unwinds, so a later test
    /// can't inherit a URL pointing at a dead listener.
    struct CloudGuard(std::sync::MutexGuard<'static, ()>);

    fn cloud_guard(url: String) -> CloudGuard {
        let guard = CloudGuard(CLOUD_LOCK.lock().unwrap_or_else(|p| p.into_inner()));
        set_cloud_url_for_tests(Some(url));
        guard
    }

    impl Drop for CloudGuard {
        fn drop(&mut self) {
            set_cloud_url_for_tests(None);
        }
    }

    /// A fake cloud.zed.dev: serves one canned raw HTTP response per
    /// connection (in order) and captures each request's start line,
    /// headers (minus content-length), and body. When the canned responses
    /// run out the accept thread exits and closes the listener, so an
    /// overrun request fails immediately instead of stalling until the
    /// client timeout.
    struct FakeCloud {
        base_url: String,
        requests: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>, // (start line + headers, body)
    }

    impl FakeCloud {
        fn spawn(responses: Vec<String>) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let srv_requests = requests.clone();
            std::thread::spawn(move || {
                let mut remaining = responses.into_iter();
                for stream in listener.incoming().flatten() {
                    let Some(response) = remaining.next() else { break };
                    let mut stream = stream;
                    use std::io::{BufRead, BufReader, Read, Write};
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut captured = String::new();
                    let mut length = 0usize;
                    // read start line + headers, capture them, then the body
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        let trimmed_end = line.trim_end();
                        if trimmed_end.is_empty() {
                            break;
                        }
                        if let Some((n, v)) = trimmed_end.split_once(':') {
                            if n.trim().eq_ignore_ascii_case("content-length") {
                                length = v.trim().parse().unwrap_or(0);
                            }
                        }
                        if !trimmed_end.to_ascii_lowercase().starts_with("content-length") {
                            captured.push_str(trimmed_end);
                            captured.push('\n');
                        }
                    }
                    let mut body = vec![0u8; length];
                    reader.read_exact(&mut body).unwrap();
                    srv_requests.lock().unwrap().push((
                        captured.trim().to_owned(),
                        String::from_utf8_lossy(&body).into_owned(),
                    ));
                    stream.write_all(response.as_bytes()).unwrap();
                }
            });
            Self { base_url, requests }
        }
    }

    fn http_ok_json(json: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", json.len(), json)
    }

    fn ndjson_ok(events: &[Value]) -> String {
        let body = events
            .iter()
            .map(|e| serde_json::json!({ "event": e }).to_string())
            .collect::<Vec<_>>()
            .join("\n");
        format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", body.len(), body)
    }

    fn post_to_bridge(bridge: &ZedBridge, body: &Value) -> String {
        let mut stream =
            std::net::TcpStream::connect(bridge.base_url().trim_start_matches("http://")).unwrap();
        let body = body.to_string();
        use std::io::{Read, Write as _};
        write!(stream, "POST /v1/messages HTTP/1.1\r\nHost: zb\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn bridge_serves_sse_to_a_post() {
        let cloud = FakeCloud::spawn(vec![
            http_ok_json(r#"{"token":"llm-tok"}"#),
            ndjson_ok(&[serde_json::json!({"type": "message_start"})]),
        ]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let blob = r#"{"userId":"1","accessToken":"t"}"#;
        let bridge = shared_bridge(blob).unwrap();
        let response = post_to_bridge(
            &bridge,
            &serde_json::json!({"model":"claude-haiku-4-5","messages":[]}),
        );
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("text/event-stream"));
        assert!(response.contains("event: message_start"));
    }

    #[test]
    fn bridge_wraps_envelope_and_coerces_content() {
        // request 1: /client/llm_tokens, request 2: /completions
        let cloud = FakeCloud::spawn(vec![
            http_ok_json(r#"{"token":"llm-tok"}"#),
            ndjson_ok(&[
                serde_json::json!({"type":"message_stop"}),
            ]),
        ]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let bridge = shared_bridge(r#"{"userId":"9","accessToken":"acc"}"#).unwrap();
        let response = post_to_bridge(&bridge, &serde_json::json!({
            "model": "claude-haiku-4-5", "max_tokens": 32, "stream": true,
            "messages": [{ "role": "user", "content": "Say OK" }]
        }));
        assert!(response.contains("event:"), "{response}");
        let (line, cloud_body) = cloud.requests.lock().unwrap()[1].clone();
        assert!(line.starts_with("POST /completions"), "{line}");
        let sent: Value = serde_json::from_str(&cloud_body).unwrap();
        assert_eq!(sent["intent"], "user_prompt");
        assert_eq!(sent["provider"], "anthropic");
        assert_eq!(sent["model"], "claude-haiku-4-5");
        assert_eq!(
            sent["provider_request"]["messages"][0]["content"],
            serde_json::json!([{ "type": "text", "text": "Say OK" }]),
            "string content coerced to block array"
        );
    }

    #[test]
    fn bridge_refuses_non_claude_models() {
        let cloud = FakeCloud::spawn(vec![]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let bridge = shared_bridge(r#"{"userId":"9","accessToken":"acc2"}"#).unwrap();
        let response = post_to_bridge(&bridge, &serde_json::json!({
            "model": "gpt-5.6-sol", "messages": []
        }));
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
        assert!(response.contains("claude"));
    }
}
