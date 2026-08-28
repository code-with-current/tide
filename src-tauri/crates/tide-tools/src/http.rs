//! Synchronous HTTP for tools — a dedicated worker thread owns a
//! current-thread tokio runtime plus an async reqwest client; tool code
//! (which runs in synchronous [`crate::Tool::execute`]) posts a job and
//! blocks on the reply channel.
//!
//! reqwest's own `blocking` client cannot be used here: its debug builds
//! panic when called from inside any tokio context, and the orchestrator
//! invokes tools on `spawn_blocking` threads, which carry the runtime
//! context. Owning the runtime on a plain thread sidesteps the guard
//! entirely. Shared by `git_repo`'s REST fast path and web_fetch
//! + web_search.

use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    Timeout,
    Network(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::Timeout => write!(f, "timeout"),
            HttpError::Network(m) => write!(f, "{m}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct HttpReply {
    pub status: u16,
    /// Response `Content-Type` header, `""` when absent — web_fetch's
    /// HTML-detection branch keys off it.
    pub content_type: String,
    pub body: String,
}

impl HttpReply {
    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

struct Job {
    url: String,
    headers: Vec<(String, String)>,
    timeout: Duration,
    reply: Sender<Result<HttpReply, HttpError>>,
}

static WORKER: OnceLock<Sender<Job>> = OnceLock::new();

fn worker() -> &'static Sender<Job> {
    WORKER.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        std::thread::Builder::new()
            .name("tide-tools-http".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("tide-tools http runtime");
                rt.block_on(async move {
                    let client = reqwest::Client::new();
                    while let Ok(job) = rx.recv() {
                        let out = fetch(&client, &job).await;
                        let _ = job.reply.send(out);
                    }
                });
            })
            .expect("spawn tide-tools-http thread");
        tx
    })
}

async fn fetch(client: &reqwest::Client, job: &Job) -> Result<HttpReply, HttpError> {
    let mut req = client.get(&job.url).timeout(job.timeout);
    for (name, value) in &job.headers {
        let name = reqwest::header::HeaderName::try_from(name.as_str())
            .map_err(|e| HttpError::Network(format!("invalid header name {name:?}: {e}")))?;
        let value = reqwest::header::HeaderValue::try_from(value.as_str())
            .map_err(|e| HttpError::Network(format!("invalid header value for {name}: {e}")))?;
        req = req.header(name, value);
    }
    let resp = req.send().await.map_err(map_reqwest_err)?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await.map_err(map_reqwest_err)?;
    Ok(HttpReply {
        status,
        content_type,
        body,
    })
}

fn map_reqwest_err(e: reqwest::Error) -> HttpError {
    if e.is_timeout() {
        HttpError::Timeout
    } else {
        HttpError::Network(e.to_string())
    }
}

/// Blocking GET returning the status and body regardless of status code —
/// callers decide how non-2xx maps to their error surface.
pub fn get(
    url: &str,
    headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<HttpReply, HttpError> {
    let (reply_tx, reply_rx) = channel();
    let job = Job {
        url: url.to_string(),
        headers: headers
            .iter()
            .map(|(n, v)| ((*n).to_string(), (*v).to_string()))
            .collect(),
        timeout,
        reply: reply_tx,
    };
    worker()
        .send(job)
        .map_err(|_| HttpError::Network("http worker unavailable".into()))?;
    reply_rx
        .recv()
        .map_err(|_| HttpError::Network("http worker died".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Minimal canned HTTP server: accepts N requests, answers each with
    /// `response` (a full HTTP/1.1 reply), then exits when the listener
    /// closes. Returns the bound base URL.
    fn mock_server(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}")
    }

    #[test]
    fn get_returns_status_and_body() {
        let base = mock_server(
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        );
        let reply = get(&format!("{base}/x"), &[("User-Agent", "test")], Duration::from_secs(5))
            .unwrap();
        assert_eq!(reply.status, 200);
        assert!(reply.is_ok());
        assert_eq!(reply.body, "hello");
    }

    #[test]
    fn get_surfaces_non_2xx_status() {
        let base = mock_server("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        let reply = get(&format!("{base}/missing"), &[], Duration::from_secs(5)).unwrap();
        assert_eq!(reply.status, 404);
        assert!(!reply.is_ok());
    }

    #[test]
    fn get_times_out() {
        // A socket that accepts but never answers.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                std::thread::sleep(Duration::from_secs(5));
            }
        });
        let err = get(&format!("http://{addr}/"), &[], Duration::from_millis(300)).unwrap_err();
        assert_eq!(err, HttpError::Timeout);
    }

    #[test]
    fn get_reports_network_errors() {
        // Port with nothing listening.
        let err = get("http://127.0.0.1:1/", &[], Duration::from_secs(2)).unwrap_err();
        assert!(matches!(err, HttpError::Network(_)));
    }
}
