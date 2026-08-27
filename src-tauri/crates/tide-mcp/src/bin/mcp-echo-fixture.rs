//! Scripted stdio MCP server for tide-mcp tests — a hand-rolled
//! newline-delimited JSON-RPC server (no rmcp server side), so the pool's
//! rmcp client is exercised against the real wire protocol.
//!
//! Behavior knobs (env):
//! - `FIXTURE_MODE=ok`        — normal server: `echo` + `fail` tools
//! - `FIXTURE_MODE=crash`     — serve normally, then exit(1) ~300ms after
//!   the initialize response (dies while connected, exercising crash
//!   recovery)
//! - `FIXTURE_MODE=slow-tool` — `echo` answers, but 2s late
//! - `FIXTURE_STALL_HANDSHAKE` — never answer initialize (connect-timeout path)

use std::io::{BufRead, Write};

fn main() {
    let mode = std::env::var("FIXTURE_MODE").unwrap_or_else(|_| "ok".into());
    let stall_handshake = std::env::var("FIXTURE_STALL_HANDSHAKE").is_ok();

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
        if id.is_none() {
            // Notification (notifications/initialized) — no response.
            continue;
        }
        if stall_handshake {
            continue;
        }
        let result = match method {
            "initialize" => serde_json::json!({
                "protocolVersion": request["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "echo-fixture", "version": "1.0.0" }
            }),
            "tools/list" => serde_json::json!({
                "tools": [
                    {
                        "name": "echo",
                        "description": "Echo the text back",
                        "inputSchema": {
                            "type": "object",
                            "properties": { "text": { "type": "string" } },
                            "required": ["text"]
                        }
                    },
                    {
                        "name": "fail",
                        "description": "Always returns an error result",
                        "inputSchema": { "type": "object" }
                    }
                ]
            }),
            "tools/call" => {
                let name = request["params"]["name"].as_str().unwrap_or_default();
                match name {
                    "echo" if mode == "slow-tool" => {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        let text = request["params"]["arguments"]["text"]
                            .as_str()
                            .unwrap_or_default();
                        serde_json::json!({
                            "content": [{ "type": "text", "text": format!("echo: {text}") }]
                        })
                    }
                    "echo" => {
                        let text = request["params"]["arguments"]["text"]
                            .as_str()
                            .unwrap_or_default();
                        serde_json::json!({
                            "content": [{ "type": "text", "text": format!("echo: {text}") }]
                        })
                    }
                    _ => serde_json::json!({
                        "content": [{ "type": "text", "text": "fixture tool error" }],
                        "isError": true
                    }),
                }
            }
            "ping" => serde_json::json!({}),
            _ => serde_json::json!({}),
        };
        let response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        });
        let mut stdout = std::io::stdout();
        if writeln!(stdout, "{response}").and_then(|_| stdout.flush()).is_err() {
            break;
        }
        if mode == "crash" && method == "initialize" {
            let delay_ms = std::env::var("FIXTURE_CRASH_AFTER_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(300);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                eprintln!("fixture crashing on purpose");
                std::process::exit(1);
            });
        }
    }
}
