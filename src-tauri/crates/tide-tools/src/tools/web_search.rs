//! web_search — port of `app/core/agent/tools/web-search.ts` (91ec558):
//! proxies through the Tide search Cloudflare Worker (→ DuckDuckGo
//! scrape) so server-side IP/anti-bot handling, markup fixes, and ad
//! filtering stay in one place; returns up to 10 results.
//!
//! Keyless by design — the worker owns the scraping, so there is no API
//! key to resolve (no config.json field, no keychain entry) and hence no
//! no-key degradation path in the TS either. The only configuration is
//! the worker URL override via the `TIDE_SEARCH_WORKER_URL` env var
//! (self-hosted / different Cloudflare account), read per call.

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::http::{self, HttpError};
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

pub(crate) const MAX_RESULTS: usize = 10;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(12);
const DEFAULT_WORKER_URL: &str = "https://sumo-search.nmapp.workers.dev";

const DESCRIPTION: &str = "Search the web for a query and return up to 10 results with title, URL, and snippet. Use to find documentation, library APIs, error messages, or recent information. Pair with web_fetch to read a specific result in full.";

pub struct WebSearchTool;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

/// The worker's response envelope — only the fields the tool consumes are
/// declared (`query`/`count` echo back and serde skips them).
#[derive(Debug, Default, Deserialize)]
struct WorkerResponse {
    engine: Option<String>,
    results: Option<Vec<SearchResult>>,
    error: Option<String>,
}

/// Shared body — network-only, no ctx dependency (mirrors `runWebSearch`).
pub(crate) fn run_web_search(query: &str) -> ToolOutcome {
    run_web_search_at(query, &worker_url())
}

/// `TIDE_SEARCH_WORKER_URL` override, defaulting to the shared worker
/// deployment (TS read it at module load; per-call keeps a runtime
/// override live, which is what the TS comment promised anyway).
fn worker_url() -> String {
    std::env::var("TIDE_SEARCH_WORKER_URL").unwrap_or_else(|_| DEFAULT_WORKER_URL.to_string())
}

fn run_web_search_at(query: &str, worker_url: &str) -> ToolOutcome {
    let q = query.trim();
    if q.is_empty() {
        return ToolOutcome::failed("Missing required arg: query");
    }

    let url = format!(
        "{worker_url}/search?q={}&count={MAX_RESULTS}",
        encode_uri_component(q)
    );
    let reply = match http::get(&url, &[("Accept", "application/json")], SEARCH_TIMEOUT) {
        Ok(r) => r,
        Err(HttpError::Timeout) => return ToolOutcome::failed("Search failed: timed out after 12s"),
        Err(HttpError::Network(m)) => return ToolOutcome::failed(format!("Search failed: {m}")),
    };
    if !reply.is_ok() {
        let body: String = reply.body.chars().take(200).collect();
        return ToolOutcome::failed(format!(
            "Search failed: Worker HTTP {}: {}",
            reply.status, body
        ));
    }
    let data: WorkerResponse = match serde_json::from_str(&reply.body) {
        Ok(d) => d,
        Err(e) => return ToolOutcome::failed(format!("Search failed: {e}")),
    };
    if let Some(err) = data.error {
        return ToolOutcome::failed(format!("Search failed: Worker: {err}"));
    }

    let results = data.results.unwrap_or_default();
    if results.is_empty() {
        return ToolOutcome::failed(format!("No results for \"{q}\"."));
    }
    let top: Vec<&SearchResult> = results.iter().take(MAX_RESULTS).collect();
    let text = top
        .iter()
        .enumerate()
        .map(|(i, r)| format!("{}. {}\n   {}\n   {}", i + 1, r.title, r.url, r.snippet))
        .collect::<Vec<_>>()
        .join("\n\n");
    let engine = data.engine.as_deref().unwrap_or("unknown");
    ToolOutcome::executed(text.clone())
        .with_meta(format!("{} results · {}", top.len(), engine))
        .with_display(ToolDisplay::Text { text })
}

/// JS `encodeURIComponent`: everything outside the unreserved set
/// `A-Za-z0-9 - _ . ! ~ * ' ( )` becomes uppercase-hex UTF-8 bytes
/// (space → `%20`, not `+`).
fn encode_uri_component(s: &str) -> String {
    const SAFE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if SAFE.as_bytes().contains(b) {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl Tool for WebSearchTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "web_search".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query." }
                },
                "required": ["query"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        _ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        Ok(run_web_search(&arg_str(&args, "query")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn mock_server(handler: Arc<dyn Fn(&str) -> String + Send + Sync>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 8192];
                let Ok(n) = stream.read(&mut buf) else { continue };
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let resp = handler(&path);
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}")
    }

    fn json_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn missing_query_fails() {
        let out = run_web_search_at("", "http://unused.invalid");
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Missing required arg: query");
        let out = run_web_search_at("   ", "http://unused.invalid");
        assert_eq!(out.output, "Missing required arg: query");
    }

    #[test]
    fn formats_results_and_reports_engine() {
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let base = mock_server(Arc::new(move |path: &str| {
            recorder.lock().unwrap().push(path.to_string());
            json_response(
                r#"{"query":"rust async","count":2,"engine":"duckduckgo","results":[
                    {"title":"Async in Rust","url":"https://async.rs/","snippet":"Async Rust primer."},
                    {"title":"Tokio","url":"https://tokio.rs/","snippet":"Runtime docs."}
                ]}"#,
            )
        }));
        let out = run_web_search_at("rust async", &base);
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(
            out.output,
            "1. Async in Rust\n   https://async.rs/\n   Async Rust primer.\n\n\
             2. Tokio\n   https://tokio.rs/\n   Runtime docs."
        );
        assert_eq!(out.meta.as_deref(), Some("2 results · duckduckgo"));
        let ToolDisplay::Text { text } = out.display.unwrap() else {
            panic!("text display");
        };
        assert_eq!(text, out.output);
        // The worker call carries the encoded query and the count cap.
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen[0],
            format!("/search?q=rust%20async&count={MAX_RESULTS}")
        );
    }

    #[test]
    fn caps_at_ten_results_and_defaults_engine() {
        let results: Vec<String> = (0..12)
            .map(|i| format!(r#"{{"title":"t{i}","url":"u{i}","snippet":"s{i}"}}"#))
            .collect();
        let body = format!("{{\"results\":[{}]}}", results.join(","));
        let base = mock_server(Arc::new(move |p: &str| {
            assert!(p.starts_with("/search"), "{p}");
            json_response(&body)
        }));
        let out = run_web_search_at("q", &base);
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.starts_with("1. t0\n"));
        assert!(out.output.ends_with("s9"));
        assert!(!out.output.contains("t10"));
        assert_eq!(out.meta.as_deref(), Some("10 results · unknown"));
    }

    #[test]
    fn worker_non_2xx_fails_with_status_and_body() {
        let base = mock_server(Arc::new(|_p: &str| {
            "HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\nboom".to_string()
        }));
        let out = run_web_search_at("q", &base);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Search failed: Worker HTTP 500: boom");
    }

    #[test]
    fn worker_error_field_fails() {
        let base = mock_server(Arc::new(|_p: &str| {
            json_response(r#"{"error":"rate limited"}"#)
        }));
        let out = run_web_search_at("q", &base);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Search failed: Worker: rate limited");
    }

    #[test]
    fn empty_results_fails_with_no_results_message() {
        let base = mock_server(Arc::new(|_p: &str| {
            json_response(r#"{"query":"ghost query","count":0,"engine":"duckduckgo","results":[]}"#)
        }));
        let out = run_web_search_at("ghost query", &base);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "No results for \"ghost query\".");
        // Missing results array entirely — same degradation.
        let base = mock_server(Arc::new(|_p: &str| json_response("{}")));
        let out = run_web_search_at("ghost query", &base);
        assert_eq!(out.output, "No results for \"ghost query\".");
    }

    #[test]
    fn malformed_json_fails_gracefully() {
        let base = mock_server(Arc::new(|_p: &str| json_response("not json")));
        let out = run_web_search_at("q", &base);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.starts_with("Search failed: "), "{}", out.output);
    }

    #[test]
    fn network_failure_fails_gracefully() {
        // Nothing listens on port 1.
        let out = run_web_search_at("q", "http://127.0.0.1:1");
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.starts_with("Search failed: "), "{}", out.output);
    }

    #[test]
    fn env_var_overrides_worker_url() {
        // Serialize env mutation across tests in this binary.
        static ENV_LOCK: Mutex<()> = Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("TIDE_SEARCH_WORKER_URL", "http://127.0.0.1:9/w");
        assert_eq!(worker_url(), "http://127.0.0.1:9/w");
        let out = run_web_search("q");
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.starts_with("Search failed: "), "{}", out.output);
        std::env::remove_var("TIDE_SEARCH_WORKER_URL");
        assert_eq!(worker_url(), DEFAULT_WORKER_URL);
    }

    #[test]
    fn encodes_like_js_encode_uri_component() {
        assert_eq!(encode_uri_component("rust async"), "rust%20async");
        assert_eq!(encode_uri_component("a+b&c=d"), "a%2Bb%26c%3Dd");
        assert_eq!(encode_uri_component("héllo"), "h%C3%A9llo");
        assert_eq!(encode_uri_component("safe-._~*'()"), "safe-._~*'()");
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = WebSearchTool;
        assert_eq!(tool.spec().name, "web_search");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let out = tool
            .execute(&ToolContext::new(tmp.path().to_path_buf()), json!({}))
            .unwrap();
        assert_eq!(out.output, "Missing required arg: query");
    }
}
