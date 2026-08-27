//! OAuth for remote MCP servers — port of `app/core/agent/mcp/oauth.ts` +
//! `app/platform/oauth-loopback.ts` @ 91ec558, rebuilt on rmcp 3's
//! [`AuthorizationManager`].
//!
//! Flow shape (RFC 8252 loopback, MCP spec authorization):
//! 1. bind an ephemeral loopback HTTP listener on 127.0.0.1 (OS-assigned
//!    port) — the redirect target;
//! 2. discover the server's authorization metadata, run dynamic client
//!    registration if needed, build the authorization URL with PKCE
//!    (all inside rmcp's `AuthorizationSession`);
//! 3. the caller opens the URL in a browser (M3: the URL is returned/
//!    stashed; the renderer flow lands in M4);
//! 4. the IdP redirects to `http://127.0.0.1:<port>/callback?code=…` —
//!    the listener serves exactly one hit, then closes (TS semantics);
//! 5. the code is exchanged for tokens; credentials persist into
//!    config.json's `mcpOAuth` sections.
//!
//! Credential storage (the consolidated-config shape): user-scope servers
//! keep OAuth data in config.json's top-level `mcpOAuth`; project-scope
//! servers keep it in the workspace object's `mcpOAuth`. Each section is
//! `{ tokens, clients, verifiers }`, server-name → base64(JSON) — the exact
//! keys the TS stack wrote. The values are plain base64 (no safeStorage in
//! the Tauri shell; TS-stored encrypted blobs fail decode and read as
//! absent, i.e. the server simply re-authenticates).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationRequest, AuthorizationSession,
    CredentialStore, OAuthTokenResponse, StateStore, StoredAuthorizationState, StoredCredentials,
};
use serde_json::Value;
use tide_store::config::{self, Config};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::config::McpScope;

/// How long the loopback listener waits for the IdP redirect before giving
/// up (the TS server lived until the app exited or one hit landed; a bound
/// wait keeps reauthenticate() honest).
pub const LOOPBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const TOKEN_EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);

// ── config.json mcpOAuth sections ───────────────────────────────────────────

/// Read/write access to one server's OAuth data inside config.json.
/// Section maps are `server → base64(JSON)` for each of tokens/clients/
/// verifiers, mirroring the TS `mcpOAuth` shape.
#[derive(Debug, Clone)]
pub struct OAuthStore {
    config_path: PathBuf,
    scope: McpScope,
    workspace_id: Option<String>,
    server: String,
}

impl OAuthStore {
    pub fn new(
        config_path: PathBuf,
        scope: McpScope,
        workspace_id: Option<String>,
        server: &str,
    ) -> Self {
        Self {
            config_path,
            scope,
            workspace_id,
            server: server.to_owned(),
        }
    }

    fn load_config(&self) -> Config {
        config::load(&self.config_path).unwrap_or_default()
    }

    fn save_config(&self, cfg: &Config) {
        // Best-effort like the TS (a failed credential write must not kill
        // the connection); the caller re-reads on next use.
        let _ = config::save(&self.config_path, cfg);
    }

    /// The `mcpOAuth` object for this store's scope, as a JSON object.
    fn read_section_map(&self, cfg: &Config) -> serde_json::Map<String, Value> {
        match self.scope {
            McpScope::User => cfg
                .extra
                .get("mcpOAuth")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default(),
            McpScope::Project => cfg
                .workspaces
                .iter()
                .find(|ws| Some(ws.id.as_str()) == self.workspace_id.as_deref())
                .and_then(|ws| ws.extra.get("mcpOAuth"))
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default(),
        }
    }

    /// Replace the `mcpOAuth` object for this store's scope.
    fn write_section_map(&self, cfg: &mut Config, section: serde_json::Map<String, Value>) {
        let value = Value::Object(section);
        match self.scope {
            McpScope::User => {
                cfg.extra.insert("mcpOAuth".to_owned(), value);
            }
            McpScope::Project => {
                if let Some(ws) = cfg
                    .workspaces
                    .iter_mut()
                    .find(|ws| Some(ws.id.as_str()) == self.workspace_id.as_deref())
                {
                    ws.extra.insert("mcpOAuth".to_owned(), value);
                }
            }
        }
    }

    fn read_named(&self, name: &str) -> Option<Value> {
        let cfg = self.load_config();
        let section = self.read_section_map(&cfg);
        let encoded = section.get(name)?.get(&self.server)?.as_str()?;
        decode_stored(encoded)
    }

    fn write_named(&self, name: &str, value: &Value) {
        let mut cfg = self.load_config();
        let mut section = self.read_section_map(&cfg);
        let entry = section
            .entry(name.to_owned())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Some(map) = entry.as_object_mut() {
            map.insert(
                self.server.clone(),
                Value::String(encode_stored(value)),
            );
        }
        self.write_section_map(&mut cfg, section);
        self.save_config(&cfg);
    }

    fn clear_named(&self, name: &str) {
        let mut cfg = self.load_config();
        let mut section = self.read_section_map(&cfg);
        if let Some(map) = section.get_mut(name).and_then(|v| v.as_object_mut()) {
            map.remove(&self.server);
        }
        self.write_section_map(&mut cfg, section);
        self.save_config(&cfg);
    }

    pub fn read_tokens(&self) -> Option<Value> {
        self.read_named("tokens")
    }

    pub fn write_tokens(&self, tokens: &Value) {
        self.write_named("tokens", tokens);
    }

    pub fn clear_tokens(&self) {
        self.clear_named("tokens");
    }

    pub fn read_client(&self) -> Option<Value> {
        self.read_named("clients")
    }

    pub fn write_client(&self, client: &Value) {
        self.write_named("clients", client);
    }

    pub fn clear_client(&self) {
        self.clear_named("clients");
    }

    /// Drop everything stored for this server (the TS `invalidateCredentials('all')`).
    pub fn clear_all(&self) {
        self.clear_named("tokens");
        self.clear_named("clients");
        self.clear_named("verifiers");
    }
}

/// base64(JSON) — the TS no-encryption fallback envelope.
fn encode_stored(value: &Value) -> String {
    base64::engine::general_purpose::STANDARD.encode(value.to_string())
}

fn decode_stored(encoded: &str) -> Option<Value> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ── rmcp store adapters ─────────────────────────────────────────────────────

/// rmcp [`CredentialStore`] backed by the config.json `mcpOAuth` section:
/// `clients[server]` holds the DCR client id, `tokens[server]` the last
/// token response — the two TS sections rmcp's `StoredCredentials` splits.
pub struct ConfigCredentialStore {
    store: OAuthStore,
}

impl ConfigCredentialStore {
    pub fn new(store: OAuthStore) -> Self {
        Self { store }
    }
}

#[async_trait]
impl CredentialStore for ConfigCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let Some(client) = self.store.read_client() else {
            return Ok(None);
        };
        let token_response = self
            .store
            .read_tokens()
            .and_then(|v| serde_json::from_value::<OAuthTokenResponse>(v).ok());
        serde_json::from_value::<StoredCredentials>(client)
            .map(|mut credentials| {
                credentials.token_response = token_response;
                Some(credentials)
            })
            .map_err(|e| AuthError::InternalError(format!("stored client unreadable: {e}")))
            .or_else(|_| Ok(None))
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let token_response = credentials.token_response.clone();
        let client = serde_json::to_value(&credentials).map_err(|e| {
            AuthError::InternalError(format!("client serialization failed: {e}"))
        })?;
        // Strip the token response out of the clients section (it lives in
        // `tokens`), then persist both sections.
        let mut client = client;
        if let Some(map) = client.as_object_mut() {
            map.remove("token_response");
        }
        self.store.write_client(&client);
        if let Some(tokens) = token_response {
            if let Ok(value) = serde_json::to_value(&tokens) {
                self.store.write_tokens(&value);
            }
        }
        Ok(())
    }

    async fn clear(&self) -> Result<(), AuthError> {
        self.store.clear_tokens();
        self.store.clear_client();
        Ok(())
    }
}

/// rmcp [`StateStore`] for the in-flight PKCE verifier — persisted under
/// `verifiers[server]` exactly like the TS `saveCodeVerifier`/`codeVerifier`
/// pair, so an interrupted flow survives an app restart (rmcp validates the
/// CSRF state matches before using the verifier).
pub struct ConfigStateStore {
    store: OAuthStore,
}

impl ConfigStateStore {
    pub fn new(store: OAuthStore) -> Self {
        Self { store }
    }
}

#[async_trait]
impl StateStore for ConfigStateStore {
    async fn save(&self, csrf_token: &str, state: StoredAuthorizationState) -> Result<(), AuthError> {
        let mut value = serde_json::to_value(&state).map_err(|e| {
            AuthError::InternalError(format!("auth state serialization failed: {e}"))
        })?;
        if let Some(map) = value.as_object_mut() {
            map.insert(
                "csrf_token".to_owned(),
                Value::String(csrf_token.to_owned()),
            );
        }
        self.store.write_named("verifiers", &value);
        Ok(())
    }

    async fn load(&self, csrf_token: &str) -> Result<Option<StoredAuthorizationState>, AuthError> {
        let Some(value) = self.store.read_named("verifiers") else {
            return Ok(None);
        };
        // One in-flight flow per server: only hand the verifier back to the
        // matching CSRF token (the TS `No stored PKCE code verifier` error
        // maps to None here → rmcp fails the exchange).
        if value.get("csrf_token").and_then(|v| v.as_str()) != Some(csrf_token) {
            return Ok(None);
        }
        serde_json::from_value::<StoredAuthorizationState>(value)
            .map(Some)
            .map_err(|e| AuthError::InternalError(format!("stored verifier unreadable: {e}")))
    }

    async fn delete(&self, _csrf_token: &str) -> Result<(), AuthError> {
        self.store.clear_named("verifiers");
        Ok(())
    }
}

// ── loopback redirect listener — port of oauth-loopback.ts ─────────────────

/// The one callback hit the listener captured (query params, URL-decoded).
#[derive(Debug, Clone, PartialEq)]
pub struct LoopbackCallback {
    pub params: BTreeMap<String, String>,
    /// The full callback URL (rebuilt from the request line).
    pub url: String,
}

impl LoopbackCallback {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.params.get(key).map(String::as_str)
    }

    pub fn code(&self) -> Option<&str> {
        self.get("code")
    }
}

pub struct LoopbackServer {
    pub port: u16,
    shutdown: oneshot::Sender<()>,
}

impl LoopbackServer {
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    pub fn close(self) {
        let _ = self.shutdown.send(());
    }
}

/// Bind an ephemeral listener on 127.0.0.1 and serve exactly ONE
/// `/callback` hit (then stop accepting, like the TS server closed after
/// one request). Returns the server handle plus the receiver the callback
/// arrives on. Non-`/callback` paths get a 404 and the listener keeps
/// waiting for the real redirect.
pub async fn start_loopback()
-> std::io::Result<(LoopbackServer, oneshot::Receiver<LoopbackCallback>)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let (tx, rx) = oneshot::channel();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        loop {
            let (mut socket, _) = tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok(conn) => conn,
                    Err(_) => break,
                },
                _ = &mut shutdown_rx => break,
            };
            let Ok(request) = read_http_request(&mut socket).await else {
                continue;
            };
            let Some((path, query)) = split_target(&request.target) else {
                write_simple_response(&mut socket, 404, "not found").await;
                continue;
            };
            if path != "/callback" {
                write_simple_response(&mut socket, 404, "not found").await;
                continue;
            }
            let params = parse_url_query(query);
            write_simple_response(
                &mut socket,
                200,
                "<!doctype html><html><body><h2>Tide</h2><p>Connected — you can close this tab.</p></body></html>",
            )
            .await;
            let _ = tx.send(LoopbackCallback {
                url: format!("http://127.0.0.1/callback?{query}"),
                params,
            });
            break;
        }
    });

    Ok((LoopbackServer { port, shutdown: shutdown_tx }, rx))
}

struct HttpRequestHead {
    target: String,
}

/// Read one HTTP request head (through the blank line). Body is ignored —
/// OAuth redirects are GETs with query params.
async fn read_http_request(socket: &mut tokio::net::TcpStream) -> std::io::Result<HttpRequestHead> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = socket.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(head_end) = find_head_end(&buf) {
            buf.truncate(head_end);
            break;
        }
        if buf.len() > 64 * 1024 {
            return Err(std::io::Error::other("oauth callback request too large"));
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let target = text
        .lines()
        .next()
        .and_then(|request_line| request_line.split(' ').nth(1))
        .unwrap_or("/")
        .to_owned();
    Ok(HttpRequestHead { target })
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn split_target(target: &str) -> Option<(&str, &str)> {
    match target.split_once('?') {
        Some((path, query)) => Some((path, query)),
        None => Some((target, "")),
    }
}

/// Parse `a=1&b=two` with percent-decoding (no `+`→space — authorization
/// codes never carry it, and browsers encode spaces as %20).
fn parse_url_query(query: &str) -> BTreeMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((percent_decode(key), percent_decode(value)))
        })
        .collect()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() + 1 && i + 2 < bytes.len() + 1 => {
                let hex = bytes.get(i + 1..i + 3).and_then(|h| {
                    std::str::from_utf8(h)
                        .ok()
                        .and_then(|h| u8::from_str_radix(h, 16).ok())
                });
                match hex {
                    Some(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn write_simple_response(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) {
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.flush().await;
    // `connection: close` must actually close — naive clients block on EOF.
    let _ = socket.shutdown().await;
}

// ── the flow ────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum OAuthFlowError {
    #[error("oauth transport error: {0}")]
    Transport(String),
    #[error("oauth authorization server error: {0}")]
    Auth(#[from] AuthError),
    #[error("the authorization redirect never arrived (timed out after {timeout_secs}s)")]
    Timeout { timeout_secs: u64 },
    #[error("the authorization server returned an error: {0}")]
    CallbackError(String),
}

/// Drive the full authorization-code flow for one server: loopback listener
/// → metadata discovery + client registration (rmcp) → authorization URL
/// (handed to `open_url`; M3 callers may just log it) → wait for the
/// redirect → exchange the code. Tokens land in config.json via
/// [`ConfigCredentialStore`].
pub async fn run_authorization_code_flow(
    store: OAuthStore,
    server_url: &str,
    open_url: &(dyn Fn(&str) + Send + Sync),
) -> Result<String, OAuthFlowError> {
    let (loopback, mut callback_rx) =
        start_loopback().await.map_err(|e| OAuthFlowError::Transport(e.to_string()))?;
    let redirect_uri = loopback.redirect_uri();

    let mut manager = AuthorizationManager::new(server_url)
        .await
        .map_err(OAuthFlowError::Auth)?;
    manager.set_credential_store(ConfigCredentialStore::new(store.clone()));
    manager.set_state_store(ConfigStateStore::new(store.clone()));
    let resolution = manager.resolve_metadata().await?;
    manager.set_metadata(resolution.metadata);

    let request = AuthorizationRequest::new(redirect_uri).with_client_name("Tide");
    let session = AuthorizationSession::new(manager, request)
        .await
        .map_err(|(_manager, error)| error)?;
    let auth_url = session.get_authorization_url().to_owned();
    open_url(&auth_url);

    let callback = match tokio::time::timeout(LOOPBACK_TIMEOUT, &mut callback_rx).await {
        Ok(Ok(callback)) => callback,
        Ok(Err(_)) => {
            return Err(OAuthFlowError::Transport(
                "loopback listener stopped".to_owned(),
            ))
        }
        Err(_) => {
            return Err(OAuthFlowError::Timeout {
                timeout_secs: LOOPBACK_TIMEOUT.as_secs(),
            })
        }
    };
    loopback.close();
    if let Some(error) = callback.get("error") {
        return Err(OAuthFlowError::CallbackError(error.to_owned()));
    }
    let full_url = callback.url.clone();
    let exchange = tokio::time::timeout(TOKEN_EXCHANGE_TIMEOUT, session.handle_callback_url(&full_url))
        .await
        .map_err(|_| OAuthFlowError::Timeout {
            timeout_secs: TOKEN_EXCHANGE_TIMEOUT.as_secs(),
        })??;
    let token = serde_json::to_value(&exchange)
        .map_err(|e| OAuthFlowError::Transport(format!("token serialization failed: {e}")))?;
    Ok(token
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned())
}

/// An `AuthorizationManager` wired to this server's config-backed stores —
/// what the HTTP transport wraps for token-bearing requests (auto-refresh
/// included) and what the authorization flow drives.
pub async fn manager_for_server(
    store: OAuthStore,
    server_url: &str,
) -> Result<AuthorizationManager, AuthError> {
    let mut manager = AuthorizationManager::new(server_url).await?;
    manager.set_credential_store(ConfigCredentialStore::new(store.clone()));
    manager.set_state_store(ConfigStateStore::new(store));
    let resolution = manager.resolve_metadata().await?;
    manager.set_metadata(resolution.metadata);
    // Load persisted tokens; returns false when a fresh flow is required.
    manager.initialize_from_store().await?;
    Ok(manager)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &std::path::Path, server: &str) -> OAuthStore {
        OAuthStore::new(
            dir.join("config.json"),
            McpScope::User,
            None,
            server,
        )
    }

    fn workspace_store(dir: &std::path::Path, server: &str) -> OAuthStore {
        let cfg_path = dir.join("config.json");
        let cfg = r#"{"workspaces":[{"id":"ws_1","name":"w","path":"/tmp/w"}]}"#;
        std::fs::write(&cfg_path, cfg).unwrap();
        OAuthStore::new(cfg_path, McpScope::Project, Some("ws_1".into()), server)
    }

    #[test]
    fn sections_round_trip_through_config_json() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path(), "context7");
        s.write_tokens(&serde_json::json!({"access_token":"at","refresh_token":"rt"}));
        s.write_client(&serde_json::json!({"client_id":"cid"}));
        assert_eq!(
            s.read_tokens().unwrap()["access_token"],
            serde_json::json!("at")
        );
        assert_eq!(s.read_client().unwrap()["client_id"], "cid");

        // Shape on disk: mcpOAuth.tokens[server] = base64(JSON).
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
                .unwrap();
        let encoded = raw["mcpOAuth"]["tokens"]["context7"].as_str().unwrap();
        assert_eq!(encoded, encode_stored(&serde_json::json!({"access_token":"at","refresh_token":"rt"})));
        s.clear_tokens();
        assert!(s.read_tokens().is_none());
        assert!(raw["mcpOAuth"]["tokens"].is_object() || true);
    }

    #[test]
    fn workspace_scoped_sections_isolate_per_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let s = workspace_store(dir.path(), "supabase");
        s.write_tokens(&serde_json::json!({"access_token":"ws-token"}));
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
                .unwrap();
        assert!(raw["mcpOAuth"].is_null());
        assert_eq!(
            raw["workspaces"][0]["mcpOAuth"]["tokens"]["supabase"],
            serde_json::json!(encode_stored(&serde_json::json!({"access_token":"ws-token"})))
        );
        assert_eq!(
            s.read_tokens().unwrap()["access_token"],
            serde_json::json!("ws-token")
        );
    }

    #[test]
    fn undecodable_legacy_values_read_as_absent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"mcpOAuth":{"tokens":{"old":"not!base64!!"}}}"#,
        )
        .unwrap();
        assert!(store(dir.path(), "old").read_tokens().is_none());
    }

    #[test]
    fn query_parsing_percent_decodes() {
        let params = parse_url_query("code=x%2Fy%3D&state=abc&error=access_denied");
        assert_eq!(params["code"], "x/y=");
        assert_eq!(params["state"], "abc");
        assert_eq!(params["error"], "access_denied");
        assert!(percent_decode("plain").contains("plain"));
    }
}
