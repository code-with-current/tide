//! Test-only std-TcpListener SSE responder — the pattern of the deleted
//! `build/record-sse-fixtures.mjs` recorder, minus the recorder. Serves a
//! canned SSE byte stream per connection and captures the exact HTTP request
//! (path + JSON body) rig sent, so quirk math can be asserted on real wire
//! bodies. No network leaves 127.0.0.1, no keys, no live providers.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use serde_json::Value;

#[derive(Debug, Clone)]
pub(crate) struct CapturedRequest {
    pub path: String,
    pub body: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct MockSse {
    base_url: String,
    requests: Arc<Mutex<Vec<CapturedRequest>>>,
    /// Keep-alive handle: dropping it ends the accept loop.
    _listener: Arc<TcpListener>,
}

impl MockSse {
    /// Bind on an ephemeral localhost port and serve `sse` bytes to every
    /// connection with a 200 + `text/event-stream` response.
    pub(crate) fn spawn(sse: &str) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let requests: Arc<Mutex<Vec<CapturedRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let server_requests = Arc::clone(&requests);
        let sse = sse.to_owned();
        let listener = Arc::new(listener);
        let accept_listener = Arc::clone(&listener);
        std::thread::spawn(move || {
            for stream in accept_listener.incoming() {
                let Ok(stream) = stream else { break };
                if let Err(e) = serve_connection(stream, &sse, &server_requests) {
                    eprintln!("mock-sse connection error: {e}");
                }
            }
        });
        Ok(Self {
            base_url: format!("http://127.0.0.1:{port}"),
            requests,
            _listener: listener,
        })
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn captured(&self) -> Vec<CapturedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

fn serve_connection(
    stream: TcpStream,
    sse: &str,
    requests: &Mutex<Vec<CapturedRequest>>,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;

    let mut content_length = 0usize;
    loop {
        let mut header = String::new();
        let n = reader.read_line(&mut header)?;
        if n == 0 || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }

    let mut body_bytes = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body_bytes)?;
    }
    let body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_owned();

    requests
        .lock()
        .unwrap()
        .push(CapturedRequest { path, body });

    let mut stream = stream;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        sse.len(),
        sse
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    Ok(())
}
