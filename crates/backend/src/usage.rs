//! Shared HTTP and formatting helpers for the usage panels. The per-CLI
//! plan-usage fetchers left with the CLI providers.
//!
//! `http_get` blocks on a subprocess and the network and must run on the
//! background executor. Render reads only parsed snapshots the app entity
//! stores.

use std::io::Write as _;
use std::process::Stdio;

use anyhow::{Context as _, anyhow};

/// The absolute path keeps a shadowed `curl` on `PATH` out of the credential
/// exchange. Windows 10 build 17063 and later ship the same tool in System32.
#[cfg(not(windows))]
const CURL_PATH: &str = "/usr/bin/curl";
#[cfg(windows)]
const CURL_PATH: &str = r"C:\Windows\System32\curl.exe";

pub use protocol::usage::{PlanUsage, PlanWindow, format_tokens, reset_label};

/// GET `url` with the given header lines. Headers travel to curl as a config
/// on stdin, never on argv, so bearer tokens cannot show up in the process
/// table. Shared with the usage-history rate-table fetch.
pub fn http_get(url: &str, headers: &[String]) -> anyhow::Result<(u16, String)> {
    let mut child = crate::command_env::plain_command(CURL_PATH)
        .args(["-sS", "--max-time", "15", "-D", "-", "-K", "-", url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context(tr!("usage_error.run_curl"))?;
    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!(tr!("usage_error.curl_stdin_unavailable")))?;
        for header in headers {
            writeln!(stdin, "header = \"{header}\"").context(tr!("usage_error.configure_curl"))?;
        }
    }
    let output = child
        .wait_with_output()
        .context(tr!("usage_error.curl_did_not_finish"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let error = stderr
            .lines()
            .last()
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| tr!("usage_error.unknown_error"));
        return Err(anyhow!(tr!("usage_error.curl_failed", error = error)));
    }
    split_status_and_body(&String::from_utf8_lossy(&output.stdout))
}

/// `-D -` prefixes the body with the response headers; the status code is on
/// the first line and the body follows the blank separator line.
fn split_status_and_body(raw: &str) -> anyhow::Result<(u16, String)> {
    let status = raw
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| anyhow!(tr!("usage_error.curl_no_status")))?;
    let body = raw
        .split_once("\r\n\r\n")
        .or_else(|| raw.split_once("\n\n"))
        .map(|(_, body)| body)
        .unwrap_or_default();
    Ok((status, body.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_line_and_body_split_from_curl_header_dump() {
        let (status, body) = split_status_and_body(
            "HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{\"ok\":true}",
        )
        .unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, "{\"ok\":true}");

        let (status, body) = split_status_and_body("HTTP/1.1 401 Unauthorized\n\nexpired").unwrap();
        assert_eq!(status, 401);
        assert_eq!(body, "expired");
    }

    #[test]
    fn token_counts_format_like_the_cli_meter() {
        assert_eq!(format_tokens(950), "950");
        assert_eq!(format_tokens(87_650), "87.7k");
        assert_eq!(format_tokens(999_600), "1.0M");
        assert_eq!(format_tokens(1_000_000), "1.0M");
    }

    #[test]
    fn reset_labels_stay_relative_until_a_day_out() {
        let now = 1_700_000_000;
        assert_eq!(reset_label(now + 49 * 60, now), "Resets in 49 min");
        assert_eq!(
            reset_label(now + 3 * 3600 + 120, now),
            "Resets in 3 hr 2 min"
        );
        assert_eq!(reset_label(now - 5, now), "Resets soon");
        // Beyond a day the label goes absolute in local time; the exact text
        // depends on the machine's zone, so assert only the shape.
        let far = reset_label(now + 3 * 24 * 3600, now);
        assert!(far.starts_with("Resets ") && !far.contains(" in "), "{far}");
    }
}
