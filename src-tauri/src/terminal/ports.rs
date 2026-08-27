//! Dev-server port detection + liveness — port of the scanning/reaping half
//! of `91ec558:app/rpc/terminal.ts`. Output is scanned for `host:port`
//! patterns; each detected port is resolved to its owning pid (lsof/netstat,
//! best-effort) and periodically reaped when the owner dies or nothing
//! accepts connections anymore.

use std::collections::BTreeMap;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::commands::misc::is_process_alive;

/// `TerminalPort` (shared/rpc.ts) — the chip the renderer renders per port.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPortWire {
    pub port: u16,
    pub url: String,
    pub label: &'static str,
}

/// A port observed in a terminal's output, plus its reaper bookkeeping.
#[derive(Debug, Clone, Copy)]
pub struct TrackedPort {
    /// Pid of the process listening on the port, resolved via lsof/netstat
    /// when the port was detected. `None` when resolution failed.
    pub pid: Option<u32>,
    /// Consecutive failed liveness probes — a port is only reaped after two
    /// misses so a dev server mid-restart keeps its chip.
    pub misses: u32,
}

pub type TrackedPorts = BTreeMap<u16, TrackedPort>;

/// Scan PTY output for dev-server port patterns. Requires a hostname prefix
/// (localhost/127.0.0.1/0.0.0.0/::1 with optional IPv6 brackets) to avoid
/// matching timestamps like `12:34:56`; returns unique ports in 10–65535.
/// Hand-rolled equivalent of the TS regex
/// `(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?):(\d{2,5})\b`
/// — the optional scheme prefix needs no handling because scanning starts at
/// the hostname wherever it appears.
pub fn scan_ports(data: &str) -> Vec<u16> {
    let bytes = data.as_bytes();
    let mut out: Vec<u16> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let Some(after_host) = match_host(bytes, i) else {
            i += 1;
            continue;
        };
        let (after, digits) = match digits_after_colon(bytes, after_host) {
            Some(found) => found,
            None => {
                i += 1;
                continue;
            }
        };
        // The regex's `\d{2,5}\b` only matches when the whole digit run is
        // 2–5 long and followed by a non-word character (or end) — longer
        // or shorter runs fail even with backtracking.
        let boundary_ok = bytes
            .get(after)
            .is_none_or(|&b| !(b.is_ascii_alphanumeric() || b == b'_'));
        let run = &data[digits..after];
        if (2..=5).contains(&run.len()) && boundary_ok {
            if let Ok(port) = run.parse::<u16>() {
                if (10..=65535).contains(&port) && !out.contains(&port) {
                    out.push(port);
                }
            }
        }
        i = after.max(digits);
    }
    out
}

/// If a host pattern starts at `i`, the offset just past it (for `::1` the
/// optional trailing `]` is consumed too — the TS `\[?::1\]?` made both
/// brackets independently optional).
fn match_host(bytes: &[u8], i: usize) -> Option<usize> {
    for host in ["localhost", "127.0.0.1", "0.0.0.0"] {
        if bytes[i..].starts_with(host.as_bytes()) {
            return Some(i + host.len());
        }
    }
    if bytes[i..].starts_with(b"[::1") {
        let mut after = i + 4;
        if bytes.get(after) == Some(&b']') {
            after += 1;
        }
        return Some(after);
    }
    if bytes[i..].starts_with(b"::1") {
        return Some(i + 3);
    }
    None
}

/// The digit run following the `:` after a host: returns (run_end, run_start)
/// when a colon is present, else `None`.
fn digits_after_colon(bytes: &[u8], after_host: usize) -> Option<(usize, usize)> {
    if bytes.get(after_host) != Some(&b':') {
        return None;
    }
    let start = after_host + 1;
    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    Some((end, start))
}

/// The sorted chip snapshot pushed on every port-set change.
pub fn ports_snapshot(tracked: &TrackedPorts) -> Vec<TerminalPortWire> {
    tracked
        .keys()
        .map(|&port| TerminalPortWire {
            port,
            url: format!("http://localhost:{port}"),
            label: "Dev server",
        })
        .collect()
}

/// Resolve which process is listening on a port (lsof on macOS/Linux,
/// netstat on Windows). Best-effort — resolves `None` on timeout/absence.
pub async fn resolve_port_pid(port: u16) -> Option<u32> {
    let output = if cfg!(windows) {
        run_with_timeout("netstat", &["-ano"], 1500).await?
    } else {
        run_with_timeout(
            "lsof",
            &["-nP", "-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"],
            1500,
        )
        .await?
    };
    parse_listened_pid(&output, port)
}

async fn run_with_timeout(cmd: &str, args: &[&str], timeout_ms: u64) -> Option<String> {
    let out = tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        tokio::process::Command::new(cmd).args(args).output(),
    )
    .await
    .ok()?
    .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn parse_listened_pid(out: &str, port: u16) -> Option<u32> {
    if cfg!(windows) {
        for line in out.lines() {
            let t: Vec<&str> = line.split_whitespace().collect();
            if t.len() >= 5 && t[0].eq_ignore_ascii_case("TCP") && t[3].contains("LISTENING") {
                let local = t[1];
                let local_port = local.rsplit(':').next()?.parse::<u16>().ok()?;
                let pid = t[t.len() - 1].parse::<u32>().ok()?;
                if local_port == port && pid > 0 {
                    return Some(pid);
                }
            }
        }
        return None;
    }
    let pid = out.lines().next()?.trim().parse::<u32>().ok()?;
    (pid > 0).then_some(pid)
}

/// Probe whether anything still accepts connections on the port. Tries IPv4
/// first, then IPv6 — a server bound to `::1` only must not read as dead.
/// A connect *timeout* resolves false without the IPv6 retry (the TS socket
/// 'timeout' path did the same); only a hard error falls back.
pub async fn is_port_open(port: u16) -> bool {
    match probe_tcp(&format!("127.0.0.1:{port}")).await {
        ProbeOutcome::Connected => true,
        ProbeOutcome::TimedOut => false,
        ProbeOutcome::Refused => {
            matches!(probe_tcp(&format!("[::1]:{port}")).await, ProbeOutcome::Connected)
        }
    }
}

enum ProbeOutcome {
    Connected,
    Refused,
    TimedOut,
}

async fn probe_tcp(addr: &str) -> ProbeOutcome {
    let socket = match addr.to_socket_addrs() {
        Ok(mut addrs) => addrs.next(),
        Err(_) => return ProbeOutcome::Refused,
    };
    let Some(socket) = socket else {
        return ProbeOutcome::Refused;
    };
    // connect_timeout is blocking but sub-750ms bounded — the reaper probes
    // a handful of ports every 2s, well within a blocking allowance.
    match TcpStream::connect_timeout(&socket, Duration::from_millis(750)) {
        Ok(_) => ProbeOutcome::Connected,
        Err(e)
            if e.kind() == std::io::ErrorKind::TimedOut
                || e.kind() == std::io::ErrorKind::WouldBlock =>
        {
            ProbeOutcome::TimedOut
        }
        Err(_) => ProbeOutcome::Refused,
    }
}

/// Reaper predicate: the port keeps its chip while its owning process (when
/// known) is alive AND something still accepts connections.
pub async fn port_is_alive(tracked: &TrackedPort, port: u16) -> bool {
    (tracked.pid.is_none()
        || tracked
            .pid
            .map(|pid| is_process_alive(pid as i64))
            .unwrap_or(false))
        && is_port_open(port).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_host_prefixed_ports() {
        assert_eq!(scan_ports("ready on http://localhost:3000"), vec![3000]);
        assert_eq!(scan_ports("127.0.0.1:8080/"), vec![8080]);
        assert_eq!(scan_ports("0.0.0.0:5173"), vec![5173]);
        assert_eq!(scan_ports("listening at [::1]:4000"), vec![4000]);
        assert_eq!(scan_ports("::1:4000"), vec![4000]);
        assert_eq!(scan_ports("localhost:3000 and localhost:3000"), vec![3000]);
        assert_eq!(
            scan_ports("localhost:3000 then 127.0.0.1:3001"),
            vec![3000, 3001]
        );
        // No left word-boundary in the TS regex — embedded hosts still match.
        assert_eq!(scan_ports("xlocalhost:3000"), vec![3000]);
    }

    #[test]
    fn ignores_timestamps_and_non_ports() {
        // No hostname prefix — a clock must never become a port.
        assert!(scan_ports("12:34:56 task started").is_empty());
        // Single digit — `\d{2,5}` floor.
        assert!(scan_ports("localhost:9").is_empty());
        // 6+ digit runs fail even with backtracking.
        assert!(scan_ports("localhost:123456").is_empty());
        // Word char right after the digits — no `\b` boundary.
        assert!(scan_ports("localhost:3000abc").is_empty());
        // Leading zero below the 10 floor.
        assert!(scan_ports("127.0.0.1:09").is_empty());
        // 65536 is past the u16 ceiling.
        assert!(scan_ports("localhost:65536").is_empty());
        // Host-like but not a host.
        assert!(scan_ports("0.0.1:1234").is_empty());
        // A colon alone is not enough.
        assert!(scan_ports("localhost-nothing").is_empty());
    }

    #[test]
    fn snapshot_is_sorted_with_dev_server_label() {
        let mut m = TrackedPorts::new();
        for port in [5173, 3000, 40000] {
            m.insert(port, TrackedPort { pid: None, misses: 0 });
        }
        let snap = ports_snapshot(&m);
        assert_eq!(
            snap,
            vec![
                TerminalPortWire {
                    port: 3000,
                    url: "http://localhost:3000".into(),
                    label: "Dev server",
                },
                TerminalPortWire {
                    port: 5173,
                    url: "http://localhost:5173".into(),
                    label: "Dev server",
                },
                TerminalPortWire {
                    port: 40000,
                    url: "http://localhost:40000".into(),
                    label: "Dev server",
                },
            ]
        );
    }

    #[test]
    fn wire_serializes_camel_case() {
        let wire = TerminalPortWire {
            port: 3000,
            url: "http://localhost:3000".into(),
            label: "Dev server",
        };
        assert_eq!(
            serde_json::to_value(&wire).unwrap(),
            serde_json::json!({ "port": 3000, "url": "http://localhost:3000", "label": "Dev server" })
        );
    }

    #[tokio::test]
    async fn port_open_tracks_a_real_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_port_open(port).await);
        drop(listener);
        assert!(!is_port_open(port).await || {
            // Rare retry: a recycled bind could briefly re-open the port.
            tokio::time::sleep(Duration::from_millis(150)).await;
            !is_port_open(port).await
        });
    }

    #[tokio::test]
    async fn liveness_requires_an_open_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let alive = TrackedPort { pid: None, misses: 0 };
        assert!(port_is_alive(&alive, port).await);
        drop(listener);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!port_is_alive(&alive, port).await);
    }
}
