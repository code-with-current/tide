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
        let _ = body;
        write_sse_head(&mut stream)?;
        let frame = format!(
            "event: message_start\ndata: {}\n\n",
            serde_json::json!({"type": "message_start"})
        );
        write_chunk(&mut stream, frame.as_bytes())?;
        end_chunks(&mut stream)
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

    #[test]
    fn bridge_serves_sse_to_a_post() {
        set_cloud_url_for_tests(None);
        let blob = r#"{"userId":"1","accessToken":"t"}"#;
        let bridge = shared_bridge(blob).unwrap();
        let mut stream =
            std::net::TcpStream::connect(bridge.base_url().trim_start_matches("http://")).unwrap();
        use std::io::Write as _;
        let body = r#"{"model":"claude-haiku-4-5","messages":[]}"#;
        write!(stream, "POST /v1/messages HTTP/1.1\r\nHost: zb\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("text/event-stream"));
        assert!(response.contains("event: message_start"));
    }
}
