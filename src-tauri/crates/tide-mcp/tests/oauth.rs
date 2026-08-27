//! OAuth tests against a local mock IdP (std TcpListener thread — no
//! network, no real provider): metadata discovery, dynamic client
//! registration, authorization-URL building (PKCE + loopback redirect),
//! the loopback callback, and the token exchange request rmcp sends.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tide_mcp::config::{McpServerConfig, McpTransportType};
use tide_mcp::oauth::start_loopback;
use tide_mcp::{ConnStatus, McpPool};
use tide_store::config::Config;

/// One request the mock IdP saw: (method, path, body).
type Recorded = Arc<Mutex<Vec<(String, String, String)>>>;

struct MockIdP {
    base: String,
    requests: Recorded,
}

/// A minimal OAuth authorization server: RFC 8414 metadata + DCR + token
/// endpoint. Anything else 404s (including the MCP endpoint itself — these
/// tests never need a working MCP server over HTTP, the pool entries exist
/// to carry the url/auth config).
fn spawn_mock_idp() -> MockIdP {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests: Recorded = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    std::thread::spawn(move || {
        listener
            .set_nonblocking(false)
            .ok();
        // Generous cap: discovery probes + register + token (+ retries).
        for _ in 0..24 {
            let Ok((stream, _)) = listener.accept() else {
                break;
            };
            handle(stream, &recorded, port);
        }
    });
    MockIdP {
        base: format!("http://127.0.0.1:{port}"),
        requests,
    }
}

fn handle(mut stream: TcpStream, recorded: &Recorded, port: u16) {
    let mut reader = BufReader::new(&mut stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();
    let mut content_length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        let _ = reader.read_exact(&mut body);
    }
    let body = String::from_utf8_lossy(&body).into_owned();
    recorded
        .lock()
        .unwrap()
        .push((method.clone(), path.clone(), body));

    let (status, json) = match (method.as_str(), path.as_str()) {
        ("GET", "/.well-known/oauth-authorization-server") => (
            200,
            serde_json::json!({
                "issuer": format!("http://127.0.0.1:{port}"),
                "authorization_endpoint": format!("http://127.0.0.1:{port}/authorize"),
                "token_endpoint": format!("http://127.0.0.1:{port}/token"),
                "registration_endpoint": format!("http://127.0.0.1:{port}/register"),
                "response_types_supported": ["code"],
                "code_challenge_methods_supported": ["S256"],
                "scopes_supported": ["mcp:read", "mcp:write"]
            }),
        ),
        ("POST", "/register") => (
            201,
            serde_json::json!({
                "client_id": "mock-client-id",
                "client_id_issued_at": 1_700_000_000_u64,
                "redirect_uris": []
            }),
        ),
        ("POST", "/token") => (
            200,
            serde_json::json!({
                "access_token": "mock-access-token",
                "refresh_token": "mock-refresh-token",
                "token_type": "Bearer",
                "expires_in": 3600,
                "scope": "mcp:read"
            }),
        ),
        _ => (404, serde_json::json!({"error": "not found"})),
    };
    let payload = serde_json::to_string(&json).unwrap();
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
        payload.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn http_get(url: &str) -> u16 {
    let authority = url.trim_start_matches("http://");
    let path = authority
        .split_once('/')
        .map(|(_, p)| format!("/{p}"))
        .unwrap_or_else(|| "/".into());
    let host = authority.split('/').next().unwrap().to_owned();
    let Ok(mut stream) = tokio::net::TcpStream::connect(&host).await else {
        return 0; // refused = listener gone; the "one hit only" signal
    };
    let request = format!("GET {path} HTTP/1.1\r\nhost: {host}\r\nconnection: close\r\n\r\n");
    tokio::time::timeout(Duration::from_secs(2), async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        stream.write_all(request.as_bytes()).await.unwrap();
        stream.flush().await.unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response).await;
        response
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0)
    })
    .await
    .unwrap_or(0)
}

// ── loopback listener ───────────────────────────────────────────────────────

#[tokio::test]
async fn loopback_serves_exactly_one_callback() {
    let (server, mut rx) = start_loopback().await.unwrap();
    let port = server.port;
    let redirect = format!("http://127.0.0.1:{port}/callback?code=abc&state=xyz");

    // Non-callback paths 404; the listener keeps waiting.
    assert_eq!(http_get(&format!("http://127.0.0.1:{port}/other")).await, 404);

    // The real redirect lands.
    assert_eq!(http_get(&redirect).await, 200);
    let callback = tokio::time::timeout(Duration::from_secs(2), &mut rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(callback.get("code"), Some("abc"));
    assert_eq!(callback.get("state"), Some("xyz"));
    assert_eq!(callback.params.get("code").map(String::as_str), Some("abc"));
    assert!(callback.url.contains("code=abc"));

    // One hit only: a second request can no longer be served.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(http_get(&redirect).await, 0);
    server.close();
}

// ── full flow against the mock IdP ─────────────────────────────────────────

#[tokio::test]
async fn authorization_flow_builds_urls_and_exchanges_code_via_mock_idp() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.json");
    let idp = spawn_mock_idp();
    let pool = std::sync::Arc::new(McpPool::new(dir.path().to_path_buf()));

    // Bring the server entry into the pool (the MCP connect itself fails —
    // the mock has no MCP endpoint — but the row and its config exist).
    pool.connect_entry(tide_mcp::ResolvedServer {
        name: "mock-remote".to_owned(),
        config: McpServerConfig {
            r#type: Some(McpTransportType::Http),
            url: Some(format!("{}/mcp", idp.base)),
            auth: Some("oauth".to_owned()),
            ..Default::default()
        },
        scope: tide_mcp::McpScope::User,
        workspace_id: None,
        workspace_root: None,
    })
    .await;
    for _ in 0..100 {
        let rows = pool.status_list().await;
        if rows.iter().all(|r| r.status != ConnStatus::Connecting) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Start the flow: discovery + DCR + authorize URL (PKCE + loopback).
    let auth_url = pool
        .start_authorization("mock-remote")
        .await
        .expect("authorization url built");
    assert!(auth_url.contains("/authorize?"), "{auth_url}");
    assert!(auth_url.contains("client_id=mock-client-id"), "{auth_url}");
    assert!(auth_url.contains("code_challenge="), "PKCE present: {auth_url}");
    assert!(auth_url.contains("code_challenge_method=S256"), "{auth_url}");
    let redirect_uri = query_param(&auth_url, "redirect_uri").unwrap();
    assert!(redirect_uri.starts_with("http://127.0.0.1:"), "{redirect_uri}");
    let state = query_param(&auth_url, "state").unwrap();

    // The PKCE verifier persisted to config (interrupted flows survive).
    let stored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert!(
        stored["mcpOAuth"]["verifiers"]["mock-remote"].is_string(),
        "verifier section written"
    );

    // Simulate the IdP redirect: the browser lands on the loopback URL.
    let sep = if redirect_uri.contains('?') { '&' } else { '?' };
    let callback_url = format!("{redirect_uri}{sep}code=mock-auth-code&state={state}");
    assert_eq!(http_get(&callback_url).await, 200);

    // Complete: the code is exchanged at the token endpoint, credentials
    // land in config.json's mcpOAuth, and the server reconnects.
    pool.complete_authorization("mock-remote").await.unwrap();

    let requests = idp.requests.lock().unwrap().clone();
    let token_call = requests
        .iter()
        .find(|(method, path, _)| method == "POST" && path == "/token")
        .expect("token endpoint hit");
    let body = &token_call.2;
    assert!(body.contains("grant_type=authorization_code"), "{body}");
    assert!(body.contains("code=mock-auth-code"), "{body}");
    assert!(body.contains("client_id=mock-client-id"), "{body}");
    assert!(body.contains("code_verifier="), "PKCE verifier sent: {body}");

    let stored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert!(
        stored["mcpOAuth"]["tokens"]["mock-remote"].is_string(),
        "tokens section written"
    );
    assert!(
        stored["mcpOAuth"]["clients"]["mock-remote"].is_string(),
        "clients section written"
    );
    let encoded = stored["mcpOAuth"]["tokens"]["mock-remote"].as_str().unwrap();
    use base64::Engine as _;
    let decoded: serde_json::Value = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(decoded["access_token"], "mock-access-token");
    assert_eq!(decoded["refresh_token"], "mock-refresh-token");

    // The connection row exists again (the reconnect re-ran; it still
    // cannot reach a real MCP endpoint, but the flow must not error).
    let rows = pool.status_list().await;
    assert!(rows.iter().any(|r| r.name == "mock-remote"));
}

#[tokio::test]
async fn workspace_scoped_server_stores_credentials_under_its_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.json");
    let idp = spawn_mock_idp();
    // A config with a workspace entry; the project server lives in the
    // workspace's .mcp.json.
    let workspace_dir = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace_dir.path().join(".mcp.json"),
        r#"{"mcpServers": {"proj-oauth": {"type": "http", "url": "PLACEHOLDER/mcp", "auth": "oauth"}}}"#,
    )
    .unwrap();
    let config = Config {
        workspaces: vec![tide_store::config::Workspace {
            id: "ws_proj".into(),
            name: "proj".into(),
            path: workspace_dir.path().to_str().unwrap().to_owned(),
            branch: None,
            archived_at: None,
            extra: Default::default(),
        }],
        ..Default::default()
    };
    std::fs::write(&config_path, serde_json::to_string(&config).unwrap()).unwrap();

    // Build via from_config so scope resolution runs (url swapped for the
    // live mock port after the read — simpler: rewrite the file now that we
    // know the port).
    std::fs::write(
        workspace_dir.path().join(".mcp.json"),
        format!(
            r#"{{"mcpServers": {{"proj-oauth": {{"type": "http", "url": "{}/mcp", "auth": "oauth"}}}}}}"#,
            idp.base
        ),
    )
    .unwrap();
    let pool = McpPool::from_config(
        dir.path().to_path_buf(),
        &config,
        Some(("ws_proj", workspace_dir.path())),
    )
    .await;

    let auth_url = pool.start_authorization("proj-oauth").await.unwrap();
    let redirect_uri = query_param(&auth_url, "redirect_uri").unwrap();
    let state = query_param(&auth_url, "state").unwrap();
    let sep = if redirect_uri.contains('?') { '&' } else { '?' };
    assert_eq!(
        http_get(&format!("{redirect_uri}{sep}code=ws-code&state={state}")).await,
        200
    );
    pool.complete_authorization("proj-oauth").await.unwrap();

    let stored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert!(
        stored["workspaces"][0]["mcpOAuth"]["tokens"]["proj-oauth"].is_string(),
        "credentials under the workspace object: {stored}"
    );
    assert!(stored["mcpOAuth"].is_null(), "user scope untouched");
}
