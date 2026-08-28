//! web_fetch — port of `app/core/agent/tools/web-fetch.ts` ():
//! fetch a URL and return its content as text, capped at 64 KB to bound
//! token cost.
//!
//! HTML→text is the TS's own minimal `stripHtml` (regex tag-stripping, not
//! a readability extractor): script/style blocks drop wholesale, block
//! closers become newlines, anchor hrefs are NOT preserved, headings carry
//! no `#` markers. That is reproduced verbatim below — an off-the-shelf
//! converter (html2text & friends) emits markdown-ish output (links as
//! `[text](url)`, heading prefixes) which would drift from the frozen TS
//! behavior the model prompts were tuned against. JSON / plain text pass
//! through untouched.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde_json::json;

use crate::http::{self, HttpError};
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

/// 64 KB cap — bounds the response's token cost (TS MAX_BYTES).
pub(crate) const MAX_BYTES: usize = 64 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "Tide/1.0 (coding agent)";

const DESCRIPTION: &str = "Fetch a URL and return its content as text. Strips HTML tags into readable prose. Use for documentation, API references, or any web resource the task requires. Capped at 64KB. Use web_search first if you do not have a specific URL.";

pub struct WebFetchTool;

/// Shared body — network-only, no ctx dependency (mirrors `runWebFetch`).
pub(crate) fn run_web_fetch(url: &str) -> ToolOutcome {
    if url.is_empty() {
        return ToolOutcome::failed("Missing required arg: url");
    }
    if !has_http_scheme(url) {
        return ToolOutcome::failed(format!(
            "URL must start with http:// or https:// (got: {url})"
        ));
    }

    let reply = match http::get(url, &[("User-Agent", USER_AGENT)], FETCH_TIMEOUT) {
        Ok(r) => r,
        Err(HttpError::Timeout) => return ToolOutcome::failed("Fetch failed: timed out after 15s"),
        Err(HttpError::Network(m)) => return ToolOutcome::failed(format!("Fetch failed: {m}")),
    };
    if !reply.is_ok() {
        // TS used fetch's `statusText`; reqwest only exposes canonical
        // reason phrases, which is what fetch served for HTTP/1.x anyway.
        let reason = reqwest::StatusCode::from_u16(reply.status)
            .ok()
            .and_then(|s| s.canonical_reason())
            .unwrap_or("");
        return ToolOutcome::failed(format!("HTTP {} {}", reply.status, reason).trim_end().to_string());
    }

    // JS `.length`/`.slice` count UTF-16 code units; char-based counting
    // keeps the cap from splitting multi-byte sequences.
    let raw_len = reply.body.chars().count();
    let truncated = raw_len > MAX_BYTES;
    let body: String = if truncated {
        reply.body.chars().take(MAX_BYTES).collect()
    } else {
        reply.body.clone()
    };

    // Strip HTML if the content-type says so or the body merely looks like
    // HTML. JSON / plain text pass through.
    let looks_html = reply.content_type.to_ascii_lowercase().contains("text/html")
        || looks_like_html(&body);
    let text = if looks_html { strip_html(&body) } else { body };

    let output: String = text.chars().take(MAX_BYTES).collect();
    let display_text = if truncated {
        format!("{text}\n\n[truncated at {MAX_BYTES} bytes]")
    } else {
        text
    };
    let meta = format!(
        "{} bytes{}",
        thousands(raw_len),
        if truncated { " · truncated" } else { "" }
    );
    ToolOutcome::executed(output)
        .with_meta(meta)
        .with_display(ToolDisplay::Text { text: display_text })
}

/// TS `/^https?:\/\//i` — scheme prefix check, case-insensitive.
fn has_http_scheme(url: &str) -> bool {
    let b = url.as_bytes();
    let starts = |p: &[u8]| b.len() >= p.len() && b[..p.len()].eq_ignore_ascii_case(p);
    starts(b"http://") || starts(b"https://")
}

/// TS `/<<\/?(html|body|div|p|a)\b/i.test(body)` — the content-type
/// fallback sniff.
fn looks_like_html(body: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)</?(?:html|body|div|p|a)\b").unwrap()).is_match(body)
}

/// Minimal HTML-to-text — port of the TS `stripHtml`: drop script/style
/// blocks wholesale, turn block-level closers into newlines, drop all
/// remaining tags (hrefs included), decode the handful of entities the TS
/// handled, collapse blank-line runs, trim.
pub(crate) fn strip_html(html: &str) -> String {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    static STYLE: OnceLock<Regex> = OnceLock::new();
    static BLOCK_CLOSE: OnceLock<Regex> = OnceLock::new();
    static BR: OnceLock<Regex> = OnceLock::new();
    static ANY_TAG: OnceLock<Regex> = OnceLock::new();
    static NL_RUN: OnceLock<Regex> = OnceLock::new();

    let script = SCRIPT.get_or_init(|| Regex::new(r"(?is)<script.*?</script>").unwrap());
    let style = STYLE.get_or_init(|| Regex::new(r"(?is)<style.*?</style>").unwrap());
    let block_close = BLOCK_CLOSE.get_or_init(|| {
        Regex::new(r"(?i)</(?:p|div|li|h[1-6]|tr|br|article|section)>").unwrap()
    });
    let br = BR.get_or_init(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
    let any_tag = ANY_TAG.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let nl_run = NL_RUN.get_or_init(|| Regex::new(r"\n{3,}").unwrap());

    let s = script.replace_all(html, "");
    let s = style.replace_all(&s, "");
    let s = block_close.replace_all(&s, "\n");
    let s = br.replace_all(&s, "\n");
    let s = any_tag.replace_all(&s, "");
    // Sequential (not simultaneous) replaces, exactly like the TS chain —
    // `&amp;lt;` decodes to `&lt;` here and then to `<` next pass.
    let s = s
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    let s = nl_run.replace_all(&s, "\n\n");
    s.trim().to_string()
}

/// `Number.toLocaleString()` (en-US) — digit grouping for the meta line.
fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    let len = digits.len();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (len - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

impl Tool for WebFetchTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "web_fetch".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Absolute http(s) URL to fetch." }
                },
                "required": ["url"]
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
        Ok(run_web_fetch(&arg_str(&args, "url")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    /// Route-aware mock HTTP server (the http.rs test pattern, extended to
    /// dispatch on the request path): accepts connections sequentially,
    /// answers each via `handler(path?query)`, keeps serving until the
    /// process ends. `Connection: close` on every reply keeps reqwest from
    /// pooling a connection the loop would never re-read.
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

    fn response(status: &str, content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    #[test]
    fn missing_url_fails() {
        let out = run_web_fetch("");
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Missing required arg: url");
    }

    #[test]
    fn rejects_non_http_schemes() {
        for url in ["ftp://example.com/x", "example.com", "file:///etc/hosts"] {
            let out = run_web_fetch(url);
            assert_eq!(out.status, OutcomeStatus::Failed, "{url}");
            let expected = format!("URL must start with http:// or https:// (got: {url})");
            assert!(out.output.starts_with(&expected), "{url}: {}", out.output);
        }
        // Case-insensitive scheme prefix passes the gate (network then fails).
        assert!(has_http_scheme("HTTP://x"));
        assert!(has_http_scheme("https://x"));
    }

    #[test]
    fn strips_html_to_prose() {
        let base = mock_server(Arc::new(|path: &str| {
            assert_eq!(path, "/doc");
            response(
                "200 OK",
                "text/html; charset=utf-8",
                "<html><head><style>body { color: red; }</style>\
<script>alert('x')</script></head>\n<body>\n<h1>Hello &amp; Welcome</h1>\n\
<p>First &lt;paragraph&gt;</p>\n<div>Second&nbsp;line</div>\n\
<a href=\"/x\">A link</a>\n<br>After break\n</body></html>",
            )
        }));
        let out = run_web_fetch(&format!("{base}/doc"));
        assert_eq!(out.status, OutcomeStatus::Executed);
        let text = out.output;
        assert!(text.starts_with("Hello & Welcome"), "{text:?}");
        assert!(text.ends_with("After break"), "{text:?}");
        assert!(text.contains("First <paragraph>"), "{text:?}");
        assert!(text.contains("Second line"), "{text:?}");
        assert!(text.contains("A link\n\nAfter break"), "{text:?}");
        // Tags, hrefs, script/style bodies: all gone.
        for gone in ["<", "</", "alert", "color: red", "href", "script", "style"] {
            if gone == "<" {
                // Entities decode to literal angle brackets — only the
                // stripped-region ones, none from tags.
                assert!(!text.contains("<h"), "{text:?}");
                assert!(!text.contains("</"), "{text:?}");
            } else {
                assert!(!text.contains(gone), "{gone} leaked: {text:?}");
            }
        }
        let ToolDisplay::Text { text: display } = out.display.unwrap() else {
            panic!("text display");
        };
        assert_eq!(display, text);
        assert!(out.meta.unwrap().ends_with(" bytes"));
    }

    #[test]
    fn html_sniffed_by_body_when_content_type_is_plain() {
        let base = mock_server(Arc::new(|_path: &str| {
            response("200 OK", "text/plain", "<div>plain-ish</div>")
        }));
        let out = run_web_fetch(&format!("{base}/x"));
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(out.output, "plain-ish");
    }

    #[test]
    fn json_and_text_pass_through_unstripped() {
        let base = mock_server(Arc::new(|path: &str| {
            if path.starts_with("/json") {
                response("200 OK", "application/json", r#"{"a": 1, "b": [2]}"#)
            } else {
                response("200 OK", "text/plain", "line one\nline two\n")
            }
        }));
        let out = run_web_fetch(&format!("{base}/json"));
        assert_eq!(out.output, r#"{"a": 1, "b": [2]}"#);
        let out = run_web_fetch(&format!("{base}/txt"));
        assert_eq!(out.output, "line one\nline two\n");
    }

    #[test]
    fn follows_redirects() {
        let base = mock_server(Arc::new(|path: &str| {
            if path.starts_with("/redirect") {
                "HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string()
            } else {
                assert!(path.starts_with("/final"), "{path}");
                response(
                    "200 OK",
                    "text/html",
                    "<html><body><p>landed</p></body></html>",
                )
            }
        }));
        let out = run_web_fetch(&format!("{base}/redirect"));
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(out.output, "landed");
    }

    #[test]
    fn non_2xx_fails_with_status_line() {
        let base = mock_server(Arc::new(|_p: &str| response("404 Not Found", "text/html", "")));
        let out = run_web_fetch(&format!("{base}/missing"));
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "HTTP 404 Not Found");
    }

    #[test]
    fn caps_response_at_64k_chars() {
        let body = "a".repeat(70_000);
        let len = body.len();
        let base = mock_server(Arc::new(move |_p: &str| {
            response("200 OK", "text/plain", &body)
        }));
        let out = run_web_fetch(&format!("{base}/big"));
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(out.output.chars().count(), MAX_BYTES);
        let expected_meta = format!("{} bytes · truncated", thousands(len));
        assert_eq!(out.meta.as_deref(), Some(expected_meta.as_str()));
        let ToolDisplay::Text { text } = out.display.unwrap() else {
            panic!("text display");
        };
        assert!(text.ends_with(&format!("[truncated at {MAX_BYTES} bytes]")));
        assert!(text.contains(&format!("a\n\n[truncated at {MAX_BYTES} bytes]")));
        // Under the cap: no truncation marker.
        let small_base = mock_server(Arc::new(|_p: &str| response("200 OK", "text/plain", "tiny")));
        let out = run_web_fetch(&format!("{small_base}/small"));
        assert_eq!(out.meta.as_deref(), Some("4 bytes"));
        assert_eq!(out.output, "tiny");
    }

    #[test]
    fn thousands_groups_digits() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(65536), "65,536");
        assert_eq!(thousands(1_234_567), "1,234,567");
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = WebFetchTool;
        assert_eq!(tool.spec().name, "web_fetch");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let out = tool
            .execute(
                &ToolContext::new(tmp.path().to_path_buf()),
                json!({ "url": "ftp://nope" }),
            )
            .unwrap();
        assert!(out.output.contains("URL must start with"));
    }
}
