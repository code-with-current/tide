//! MCP connection pool — port of `app/core/agent/mcp/pool.ts` on
//! rmcp 3. User servers are app-lifetime; project servers are
//! workspace-lifetime (the caller swaps pools on workspace switch).
//!
//! Lifecycle semantics (TS parity):
//! - eager start: every configured server connects at pool construction;
//! - crash recovery: an stdio server subprocess that exits while connected
//!   restarts with exponential backoff (2s → 4s → 8s), max 3 attempts, then
//!   `error` ("Server crashed 3×"); an intentional disconnect never
//!   restarts (status flips to `disconnected` BEFORE the kill — the TS
//!   onclose trick);
//! - connect timeouts: 30s stdio (login shell + npx downloads), 10s remote;
//! - a remote server that answers 401 lands in `needs_oauth`; the
//!   authorization flow runs through [`crate::oauth`] and the pool
//!   reconnects once tokens exist.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, ClientCapabilities, ClientInfo, Implementation, Tool as RmcpTool};
use rmcp::transport::async_rw::AsyncRwTransport;
use rmcp::transport::auth::{AuthClient, AuthorizationRequest, AuthorizationSession};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use rmcp::service::{RoleClient, RunningService};
use rmcp::ServiceExt;
use futures::FutureExt;
use serde::Serialize;
use tide_store::config::Config;
use tokio::sync::{oneshot, Mutex};

use crate::config::{McpScope, McpServerConfig, McpTransportType, ResolvedServer, resolve_servers};
use crate::oauth::{self, LoopbackServer, OAuthStore};
use crate::secrets::{resolve_args_secrets, resolve_secrets};

pub const MCP_TOOL_PREFIX: &str = "mcp__";
const STDIO_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const REMOTE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESTARTS: u32 = 3;
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(8);
const RESTART_BACKOFF_BASE: Duration = Duration::from_secs(2);

type ClientService = RunningService<RoleClient, ClientInfo>;

/// `mcp__<server>__<tool>` — the TS namespaced tool name.
pub fn namespaced_tool_name(server: &str, tool: &str) -> String {
    format!("{MCP_TOOL_PREFIX}{server}__{tool}")
}

/// Split an `mcp__<server>__<tool>` name back into its parts.
pub fn split_namespaced_tool_name(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix(MCP_TOOL_PREFIX)?;
    let (server, tool) = rest.split_once("__")?;
    (!server.is_empty() && !tool.is_empty()).then(|| (server.to_owned(), tool.to_owned()))
}

/// A discovered MCP tool (the TS `McpTool`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// Connection state — the TS `McpConnectionStatus` strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ConnStatus {
    #[serde(rename = "connecting")]
    Connecting,
    #[serde(rename = "connected")]
    Connected,
    #[serde(rename = "disconnected")]
    Disconnected,
    #[serde(rename = "needs_oauth")]
    NeedsOAuth,
    #[serde(rename = "needs_credentials")]
    NeedsCredentials,
    #[serde(rename = "error")]
    Error,
}

/// Status row for the management UI — the TS `McpServerStatus`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusRow {
    pub name: String,
    pub scope: McpScope,
    pub status: ConnStatus,
    pub tool_count: usize,
    pub tool_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub transport: McpTransportType,
    pub config: McpServerConfig,
}

struct Connection {
    scope: McpScope,
    workspace_id: Option<String>,
    workspace_root: Option<PathBuf>,
    config: McpServerConfig,
    status: ConnStatus,
    error: Option<String>,
    tools: Vec<McpToolDef>,
    restart_count: u32,
    service: Option<Arc<ClientService>>,
    /// Kill switch for the stdio watcher task (oneshot send = intentional
    /// shutdown: kill the child, no crash recovery).
    kill: Option<oneshot::Sender<()>>,
}

/// A `tools/call` result mapped the way the TS toolset did: text content
/// blocks joined with newlines, plus the server's `isError` flag.
#[derive(Debug, Clone, PartialEq)]
pub struct CallOutcome {
    pub is_error: bool,
    pub text: String,
}

/// One in-flight authorization flow (started by
/// [`McpPool::start_authorization`], completed by
/// [`McpPool::complete_authorization`]).
struct PendingFlow {
    session: AuthorizationSession,
    callback_rx: oneshot::Receiver<oauth::LoopbackCallback>,
    loopback: LoopbackServer,
}

enum ConnectFailure {
    NeedsCredentials(Vec<String>),
    NeedsOAuth,
    Error(String),
}

/// The authorization-URL opener slot (the browser launch). Interior-
/// mutable so the app shell can install the opener-plugin hook on an
/// already-built pool; the default is a no-op (the URL is returned to the
/// caller instead). Replaces the TS `openInBrowser` call.
type UrlOpener = Box<dyn Fn(&str) + Send + Sync>;
/// The status-transition listener slot (the TS `notifyStatusChange` → the
/// panel's `mcpEvents` push). Default no-op.
type StatusNotifier = Box<dyn Fn() + Send + Sync>;

pub struct McpPool {
    data_dir: PathBuf,
    config_path: PathBuf,
    servers: Mutex<HashMap<String, Connection>>,
    pending_flows: StdMutex<HashMap<String, PendingFlow>>,
    restart_backoff_base: Duration,
    url_opener: StdMutex<UrlOpener>,
    status_notifier: StdMutex<StatusNotifier>,
}

impl McpPool {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        Self {
            config_path: data_dir.join("config.json"),
            data_dir,
            servers: Mutex::new(HashMap::new()),
            pending_flows: StdMutex::new(HashMap::new()),
            restart_backoff_base: RESTART_BACKOFF_BASE,
            url_opener: StdMutex::new(Box::new(|_url| {})),
            status_notifier: StdMutex::new(Box::new(|| {})),
        }
    }

    /// Install the browser opener for OAuth authorization URLs (the app
    /// shell passes the opener plugin here).
    pub fn set_url_opener(&self, opener: Box<dyn Fn(&str) + Send + Sync>) {
        *self.url_opener.lock().unwrap() = opener;
    }

    /// Install the status-transition listener (the app shell forwards it to
    /// the renderer as an `mcpEvents` push). Called outside the servers
    /// lock wherever the TS pool called `notifyStatusChange`.
    pub fn set_status_notifier(&self, notifier: Box<dyn Fn() + Send + Sync>) {
        *self.status_notifier.lock().unwrap() = notifier;
    }

    fn open_url(&self, url: &str) {
        (self.url_opener.lock().unwrap())(url);
    }

    fn notify_status(&self) {
        (self.status_notifier.lock().unwrap())();
    }

    /// Shrink the crash-recovery backoff for tests.
    pub fn with_restart_backoff_base(mut self, base: Duration) -> Self {
        self.restart_backoff_base = base;
        self
    }

    fn oauth_store(&self, name: &str, conn: &Connection) -> OAuthStore {
        OAuthStore::new(
            self.config_path.clone(),
            conn.scope,
            conn.workspace_id.clone(),
            name,
        )
    }

    /// Build the pool from config: user servers + the workspace's project
    /// servers, connected eagerly (TS `initUserServers` +
    /// `activateWorkspace`). Invalid entries become `error` rows instead of
    /// being dropped silently.
    pub async fn from_config(
        data_dir: impl Into<PathBuf>,
        config: &Config,
        workspace: Option<(&str, &Path)>,
    ) -> Arc<Self> {
        let pool = Arc::new(Self::new(data_dir));
        let (resolved, invalid) = resolve_servers(config, workspace);
        if !invalid.is_empty() {
            let mut servers = pool.servers.lock().await;
            for (name, error) in invalid {
                servers.insert(
                    name.clone(),
                    Connection {
                        scope: McpScope::User,
                        workspace_id: None,
                        workspace_root: None,
                        config: McpServerConfig::default(),
                        status: ConnStatus::Error,
                        error: Some(error),
                        tools: Vec::new(),
                        restart_count: 0,
                        service: None,
                        kill: None,
                    },
                );
            }
        }
        for server in resolved {
            pool.connect_entry(server).await;
        }
        pool
    }

    /// (Re)connect one resolved server. Never panics — every failure lands
    /// in the connection's status/error (the TS `connectServer` contract).
    /// Boxed: the crash-recovery watcher recurses through this entry point
    /// (connect → watcher → on_child_exit → connect), which would otherwise
    /// build an infinite future type.
    pub fn connect_entry(self: &Arc<Self>, server: ResolvedServer) -> futures::future::BoxFuture<'static, ()> {
        let pool = Arc::clone(self);
        async move {
        pool.reset_connection(
            &server.name,
            server.config.clone(),
            server.scope,
            server.workspace_id.clone(),
            server.workspace_root.clone(),
        )
        .await;
        pool.run_connect(server.name, server.config, server.scope, server.workspace_id)
            .await;
        }
        .boxed()
    }

    /// Retry a tracked server with its stored config (the TS `retryServer`;
    /// re-reading edited config from disk is the app layer's reload job).
    /// A MANUAL retry earns a fresh crash-recovery budget.
    pub async fn retry_server(self: &Arc<Self>, name: &str) -> bool {
        self.reload_server(name, None).await
    }

    /// Retry with an optional fresh config (the app layer re-reads the
    /// config source first so external edits are picked up, TS `retryServer`
    /// semantics); `None` reuses the stored config.
    pub async fn reload_server(
        self: &Arc<Self>,
        name: &str,
        fresh_config: Option<McpServerConfig>,
    ) -> bool {
        let Some(mut server) = self.stored_server(name).await else {
            return false;
        };
        if let Some(config) = fresh_config {
            server.config = config;
        }
        {
            let mut servers = self.servers.lock().await;
            if let Some(conn) = servers.get_mut(name) {
                conn.restart_count = 0;
            }
        }
        self.connect_entry(server).await;
        true
    }

    async fn stored_server(&self, name: &str) -> Option<ResolvedServer> {
        let servers = self.servers.lock().await;
        let conn = servers.get(name)?;
        Some(ResolvedServer {
            name: name.to_owned(),
            config: conn.config.clone(),
            scope: conn.scope,
            workspace_id: conn.workspace_id.clone(),
            workspace_root: conn.workspace_root.clone(),
        })
    }

    async fn reset_connection(
        &self,
        name: &str,
        config: McpServerConfig,
        scope: McpScope,
        workspace_id: Option<String>,
        workspace_root: Option<PathBuf>,
    ) {
        let old = {
            let mut servers = self.servers.lock().await;
            // The crash counter survives across attempts (only a manual
            // retry earns a fresh budget) — otherwise a crash-after-connect
            // server would restart forever.
            let restart_count = servers
                .get(name)
                .map(|conn| conn.restart_count)
                .unwrap_or(0);
            servers.insert(
                name.to_owned(),
                Connection {
                    scope,
                    workspace_id,
                    workspace_root,
                    config,
                    status: ConnStatus::Connecting,
                    error: None,
                    tools: Vec::new(),
                    restart_count,
                    service: None,
                    kill: None,
                },
            )
        };
        if let Some(old) = old {
            if let Some(kill) = old.kill {
                let _ = kill.send(());
            }
            drop_service(old.service).await;
        }
        self.notify_status();
    }

    async fn run_connect(
        self: &Arc<Self>,
        name: String,
        config: McpServerConfig,
        scope: McpScope,
        workspace_id: Option<String>,
    ) {
        let attempt = match config.transport() {
            McpTransportType::Stdio => {
                self.connect_stdio(&name, &config).await
            }
            McpTransportType::Sse | McpTransportType::Http => {
                self.connect_http(&name, &config, scope, workspace_id.as_deref()).await
            }
        };
        let outcome = match attempt {
            Ok(Connected { service, tools, kill }) => {
                let mut servers = self.servers.lock().await;
                match servers.get_mut(&name) {
                    Some(conn) => {
                        conn.status = ConnStatus::Connected;
                        conn.error = None;
                        conn.tools = tools;
                        conn.service = Some(service);
                        conn.kill = kill;
                    }
                    None => {
                        if let Some(kill) = kill {
                            let _ = kill.send(());
                        }
                        drop_service(Some(service)).await;
                    }
                }
                drop(servers);
                self.notify_status();
                return;
            }
            Err(failure) => failure,
        };
        let mut servers = self.servers.lock().await;
        let Some(conn) = servers.get_mut(&name) else {
            return;
        };
        match outcome {
            ConnectFailure::NeedsCredentials(missing) => {
                conn.status = ConnStatus::NeedsCredentials;
                conn.error = Some(format!("Missing secrets: {}", missing.join(", ")));
            }
            ConnectFailure::NeedsOAuth => {
                conn.status = ConnStatus::NeedsOAuth;
                conn.error = None;
            }
            ConnectFailure::Error(message) => {
                conn.status = ConnStatus::Error;
                conn.error = Some(explain_connect_error(&message, &name));
            }
        }
        drop(servers);
        self.notify_status();
    }

    async fn connect_stdio(
        self: &Arc<Self>,
        name: &str,
        config: &McpServerConfig,
    ) -> Result<Connected, ConnectFailure> {
        // Secret placeholders gate the spawn (needs_credentials).
        let mut env: HashMap<String, String> = std::env::vars().collect();
        let mut missing: Vec<String> = Vec::new();
        if let Some(config_env) = &config.env {
            let (resolved, env_missing) = resolve_secrets(&self.data_dir, config_env);
            env.extend(resolved);
            missing.extend(env_missing);
        }
        let mut args: Vec<String> = Vec::new();
        if let Some(config_args) = &config.args {
            let (resolved, args_missing) = resolve_args_secrets(&self.data_dir, config_args);
            args = resolved;
            missing.extend(args_missing);
        }
        if !missing.is_empty() {
            missing.sort();
            missing.dedup();
            return Err(ConnectFailure::NeedsCredentials(missing));
        }
        let Some(command) = config.command.clone().filter(|c| !c.is_empty()) else {
            return Err(ConnectFailure::Error(
                r#"stdio servers require "command""#.to_owned(),
            ));
        };

        let mut child = spawn_shell_child(&command, &args, env)
            .await
            .map_err(|e| ConnectFailure::Error(format!("failed to spawn server process: {e}")))?;
        let (stdin, stdout) = match (child.stdin.take(), child.stdout.take()) {
            (Some(stdin), Some(stdout)) => (stdin, stdout),
            _ => {
                let _ = child.kill().await;
                return Err(ConnectFailure::Error(
                    "server process did not provide piped stdio".to_owned(),
                ));
            }
        };
        // Drain stderr so a chatty server never blocks on a full pipe; the
        // last line is kept for crash diagnostics.
        let stderr_tail = Arc::new(StdMutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        *tail.lock().unwrap() = line.chars().take(500).collect();
                    }
                }
            });
        }

        let transport = AsyncRwTransport::<RoleClient, _, _>::new(stdout, stdin);
        let (service, tools) = match tokio::time::timeout(
            STDIO_CONNECT_TIMEOUT,
            connect_service(transport),
        )
        .await
        {
            Ok(Ok(connected)) => connected,
            Ok(Err(failure)) => {
                let _ = child.kill().await;
                return Err(failure);
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err(ConnectFailure::Error(format!(
                    "connect timed out after {}s",
                    STDIO_CONNECT_TIMEOUT.as_secs()
                )));
            }
        };

        // Crash recovery watcher: owns the child. A natural exit while the
        // connection is still connected restarts with backoff; a kill
        // signal (intentional disconnect) just terminates.
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let pool = Arc::clone(self);
        let watched = name.to_owned();
        tokio::spawn(async move {
            tokio::select! {
                status = child.wait() => {
                    let tail = stderr_tail.lock().unwrap().clone();
                    let exit_ok = status.map(|s| s.success()).unwrap_or(false);
                    pool.on_child_exit(&watched, &tail, exit_ok).await;
                }
                _ = kill_rx => {
                    let _ = child.kill().await;
                }
            }
        });

        Ok(Connected {
            service,
            tools,
            kill: Some(kill_tx),
        })
    }

    async fn connect_http(
        &self,
        name: &str,
        config: &McpServerConfig,
        scope: McpScope,
        workspace_id: Option<&str>,
    ) -> Result<Connected, ConnectFailure> {
        let Some(url) = config.url.clone().filter(|u| !u.is_empty()) else {
            return Err(ConnectFailure::Error(
                r#"remote servers require "url""#.to_owned(),
            ));
        };
        let mut transport_config = StreamableHttpClientTransportConfig::with_uri(url.clone());
        if let Some(headers) = &config.headers {
            let mut custom = HashMap::new();
            for (key, value) in headers {
                match (
                    http::HeaderName::try_from(key.as_str()),
                    http::HeaderValue::try_from(value.as_str()),
                ) {
                    (Ok(header_name), Ok(header_value)) => {
                        custom.insert(header_name, header_value);
                    }
                    _ => {
                        return Err(ConnectFailure::Error(format!(
                            "invalid header {key}: {value}"
                        )))
                    }
                }
            }
            transport_config = transport_config.custom_headers(custom);
        }

        let connected = if config.auth.as_deref() == Some("oauth") {
            // Stored credentials ride every request automatically (refresh
            // included); a 401 challenge propagates as AuthRequired.
            let store = OAuthStore::new(
                self.config_path.clone(),
                scope,
                workspace_id.map(str::to_owned),
                name,
            );
            let manager = oauth::manager_for_server(store, &url)
                .await
                .map_err(|e| ConnectFailure::Error(format!("oauth setup failed: {e}")))?;
            let transport = StreamableHttpClientTransport::with_client(
                AuthClient::new(reqwest::Client::new(), manager),
                transport_config,
            );
            serve_with_timeout(transport, REMOTE_CONNECT_TIMEOUT).await?
        } else {
            let transport =
                StreamableHttpClientTransport::with_client(reqwest::Client::new(), transport_config);
            serve_with_timeout(transport, REMOTE_CONNECT_TIMEOUT).await?
        };
        Ok(Connected {
            service: connected.0,
            tools: connected.1,
            kill: None,
        })
    }

    /// The stdio child exited on its own. Intentional disconnects and
    /// mid-connect exits never restart (status is not `connected`).
    fn on_child_exit(self: &Arc<Self>, name: &str, stderr_tail: &str, exit_ok: bool) -> futures::future::BoxFuture<'static, ()> {
        let pool = Arc::clone(self);
        let name = name.to_owned();
        let stderr_tail = stderr_tail.to_owned();
        async move {
        let backoff = {
            let mut servers = pool.servers.lock().await;
            let Some(conn) = servers.get_mut(&name) else {
                return;
            };
            if conn.status != ConnStatus::Connected {
                return;
            }
            if conn.restart_count >= MAX_RESTARTS {
                conn.status = ConnStatus::Error;
                conn.error = Some(format!(
                    "Server crashed {MAX_RESTARTS}× — check its configuration.{}",
                    detail_suffix(&stderr_tail, exit_ok)
                ));
                drop(servers);
                pool.notify_status();
                return;
            }
            conn.restart_count += 1;
            conn.status = ConnStatus::Connecting;
            conn.error = None;
            conn.tools.clear();
            conn.service = None;
            conn.kill = None;
            pool.restart_backoff_base
                .saturating_mul(1 << (conn.restart_count - 1).min(4))
                .min(RESTART_BACKOFF_MAX)
        };
        pool.notify_status();
        tokio::time::sleep(backoff).await;
        if let Some(server) = pool.stored_server(&name).await {
            pool.connect_entry(server).await;
        }
        }
        .boxed()
    }

    /// Intentional disconnect — the row stays (TS `disableServer`: greyed
    /// out, not removed).
    pub async fn disconnect(&self, name: &str) {
        let (kill, service) = {
            let mut servers = self.servers.lock().await;
            let Some(conn) = servers.get_mut(name) else {
                return;
            };
            // Status flips BEFORE the kill so the watcher's exit handler
            // sees a non-connected state and skips crash recovery.
            conn.status = ConnStatus::Disconnected;
            conn.tools.clear();
            conn.error = None;
            (conn.kill.take(), conn.service.take())
        };
        if let Some(kill) = kill {
            let _ = kill.send(());
        }
        drop_service(service).await;
        self.notify_status();
    }

    /// Remove a server from the pool entirely — disconnect + drop the row
    /// (the TS `unloadServer`, called after a config remove; contrast
    /// [`McpPool::disconnect`], which keeps a greyed-out row for toggling).
    pub async fn unload(&self, name: &str) {
        self.disconnect(name).await;
        let removed = {
            let mut servers = self.servers.lock().await;
            servers.remove(name).is_some()
        };
        if removed {
            self.notify_status();
        }
    }

    /// Disconnect everything (TS `disconnectAll`).
    pub async fn shutdown(&self) {
        let names: Vec<String> = {
            let servers = self.servers.lock().await;
            servers.keys().cloned().collect()
        };
        for name in names {
            self.disconnect(&name).await;
        }
        self.pending_flows.lock().unwrap().clear();
    }

    /// Re-fetch a connected server's tool list (TS `refreshServerTools`):
    /// returns the new count, or `None` when not connected / listing
    /// failed.
    pub async fn refresh_server_tools(&self, name: &str) -> Option<usize> {
        let peer = {
            let servers = self.servers.lock().await;
            let conn = servers.get(name)?;
            if conn.status != ConnStatus::Connected {
                return None;
            }
            conn.service.as_ref().map(|s| s.peer().clone())?
        };
        let tools = peer.list_tools(None).await.ok()?;
        let defs = to_tool_defs(&tools.tools);
        let count = defs.len();
        let mut servers = self.servers.lock().await;
        if let Some(conn) = servers.get_mut(name) {
            conn.tools = defs;
        }
        drop(servers);
        self.notify_status();
        Some(count)
    }

    /// Every connected server's tools as specs, named `mcp__<server>__<tool>`
    /// (the TS `getToolsForWorkspace` → namespacedName mapping).
    pub async fn tool_specs(self: &Arc<Self>) -> Vec<tide_tools::ToolSpec> {
        self.mcp_tools()
            .await
            .iter()
            .map(|tool| tool.spec())
            .collect()
    }

    /// The connected servers' tools as live [`tide_tools::Tool`] handles —
    /// what the orchestrator appends to the turn's tool list.
    pub async fn mcp_tools(self: &Arc<Self>) -> Vec<Arc<dyn tide_tools::Tool>> {
        let weak = Arc::downgrade(self);
        let servers = self.servers.lock().await;
        let mut handles: Vec<Arc<dyn tide_tools::Tool>> = Vec::new();
        for (name, conn) in servers.iter() {
            if conn.status != ConnStatus::Connected {
                continue;
            }
            for tool in &conn.tools {
                handles.push(Arc::new(crate::tools::McpToolHandle {
                    pool: weak.clone(),
                    server: name.clone(),
                    tool: tool.clone(),
                }));
            }
        }
        handles
    }

    /// Call one tool on one server. Text content blocks join with newlines
    /// (TS toolset behavior); transport failures return Err.
    pub async fn call(
        &self,
        server: &str,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<CallOutcome, String> {
        let peer = {
            let servers = self.servers.lock().await;
            let conn = servers
                .get(server)
                .ok_or_else(|| format!("Unknown MCP server: {server}"))?;
            if conn.status != ConnStatus::Connected {
                return Err(format!(
                    "MCP server {server} is not connected (status {})",
                    serde_json::to_value(conn.status)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default()
                ));
            }
            conn.service
                .as_ref()
                .map(|s| s.peer().clone())
                .ok_or_else(|| format!("MCP server {server} has no live connection"))?
        };
        let arguments = args.as_object().cloned().unwrap_or_default();
        let result = peer
            .call_tool(
                CallToolRequestParams::new(tool.to_owned()).with_arguments(arguments),
            )
            .await
            .map_err(|e| format!("MCP call failed: {e}"))?;
        let mut text_parts = Vec::new();
        for block in &result.content {
            if let rmcp::model::ContentBlock::Text(text) = block {
                text_parts.push(text.text.to_string());
            }
        }
        Ok(CallOutcome {
            is_error: result.is_error.unwrap_or(false),
            text: text_parts.join("\n"),
        })
    }

    /// Status rows for the management UI, sorted by name.
    pub async fn status_list(&self) -> Vec<ServerStatusRow> {
        let servers = self.servers.lock().await;
        let mut rows: Vec<ServerStatusRow> = servers
            .iter()
            .map(|(name, conn)| ServerStatusRow {
                name: name.clone(),
                scope: conn.scope,
                status: conn.status,
                tool_count: conn.tools.len(),
                tool_names: conn.tools.iter().map(|t| t.name.clone()).collect(),
                error: conn.error.clone(),
                transport: conn.config.transport(),
                config: conn.config.clone(),
            })
            .collect();
        rows.sort_by(|a, b| a.name.cmp(&b.name));
        rows
    }

    // ── OAuth entry points ─────────────────────────────────────────────

    /// Start the authorization flow for a `needs_oauth` server: bind the
    /// loopback listener, discover the authorization metadata, register the
    /// client (DCR) and return the authorization URL for the caller to open
    /// in a browser (also handed to `url_opener`). Complete with
    /// [`McpPool::complete_authorization`]. The TS `authenticateServer` +
    /// `createAuthProvider` pair.
    pub async fn start_authorization(&self, name: &str) -> Result<String, String> {
        let (scope, workspace_id, url) = {
            let servers = self.servers.lock().await;
            let conn = servers
                .get(name)
                .ok_or_else(|| format!("Unknown MCP server: {name}"))?;
            let url = conn
                .config
                .url
                .clone()
                .filter(|u| !u.is_empty())
                .ok_or_else(|| format!("Server {name} is not a remote server"))?;
            (conn.scope, conn.workspace_id.clone(), url)
        };
        let (loopback, callback_rx) = oauth::start_loopback()
            .await
            .map_err(|e| format!("loopback listener failed: {e}"))?;
        let store = OAuthStore::new(
            self.config_path.clone(),
            scope,
            workspace_id,
            name,
        );
        let manager = oauth::manager_for_server(store, &url)
            .await
            .map_err(|e| format!("oauth setup failed: {e}"))?;
        let request = AuthorizationRequest::new(loopback.redirect_uri()).with_client_name("Tide");
        let session = AuthorizationSession::new(manager, request)
            .await
            .map_err(|(_manager, error)| error.to_string())?;
        let auth_url = session.get_authorization_url().to_owned();
        self.pending_flows.lock().unwrap().insert(
            name.to_owned(),
            PendingFlow {
                session,
                callback_rx,
                loopback,
            },
        );
        self.open_url(&auth_url);
        Ok(auth_url)
    }

    /// Finish a pending flow: wait for the loopback redirect, exchange the
    /// code (tokens persist via the credential store), reconnect the
    /// server. The TS `completeOAuthCallback` port — the loopback listener
    /// plays the role the `tide://` deep link played there.
    pub async fn complete_authorization(self: &Arc<Self>, name: &str) -> Result<(), String> {
        let flow = self
            .pending_flows
            .lock()
            .unwrap()
            .remove(name)
            .ok_or_else(|| format!("No pending authorization flow for {name}"))?;
        let PendingFlow {
            session,
            mut callback_rx,
            loopback,
        } = flow;
        let callback = tokio::time::timeout(oauth::LOOPBACK_TIMEOUT, &mut callback_rx)
            .await
            .map_err(|_| "authorization redirect timed out".to_owned())?
            .map_err(|e| format!("loopback listener stopped: {e}"))?;
        // Close only AFTER the redirect landed — closing earlier would kill
        // the listener the browser is about to hit.
        loopback.close();
        session
            .handle_callback_url(&callback.url)
            .await
            .map_err(|e| e.to_string())?;
        self.retry_server(name).await;
        Ok(())
    }

    /// One-shot re-authentication: drop stored credentials, run the flow
    /// end-to-end (the browser open is `url_opener`'s job — without one
    /// this waits on the redirect up to the loopback timeout), reconnect.
    pub async fn reauthenticate(self: &Arc<Self>, name: &str) -> Result<(), String> {
        {
            let servers = self.servers.lock().await;
            if let Some(conn) = servers.get(name) {
                self.oauth_store(name, conn).clear_all();
            } else {
                return Err(format!("Unknown MCP server: {name}"));
            }
        }
        self.start_authorization(name).await?;
        self.complete_authorization(name).await
    }
}

struct Connected {
    service: Arc<ClientService>,
    tools: Vec<McpToolDef>,
    kill: Option<oneshot::Sender<()>>,
}

async fn connect_service<T, E, A>(
    transport: T,
) -> Result<(Arc<ClientService>, Vec<McpToolDef>), ConnectFailure>
where
    T: rmcp::transport::IntoTransport<RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    let client_info = ClientInfo::new(
        ClientCapabilities::default(),
        Implementation::new("tide", env!("CARGO_PKG_VERSION")),
    );
    let service = client_info
        .serve(transport)
        .await
        .map_err(|e| classify_connect_error(e.to_string()))?;
    let tools = service
        .peer()
        .list_tools(None)
        .await
        .map_err(|e| ConnectFailure::Error(format!("tools/list failed: {e}")))?;
    Ok((Arc::new(service), to_tool_defs(&tools.tools)))
}

/// `connect_service` with the given wall-clock cap (kill-on-timeout is the
/// caller's job for stdio children).
async fn serve_with_timeout<T, E, A>(
    transport: T,
    timeout: Duration,
) -> Result<(Arc<ClientService>, Vec<McpToolDef>), ConnectFailure>
where
    T: rmcp::transport::IntoTransport<RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    match tokio::time::timeout(timeout, connect_service(transport)).await {
        Ok(result) => result,
        Err(_) => Err(ConnectFailure::Error(format!(
            "connect timed out after {}s",
            timeout.as_secs()
        ))),
    }
}

/// The SDK's auth signal: a 401 during initialize (the TS caught
/// `Unauthorized` there) means "needs user sign-in", not an error.
fn classify_connect_error(message: String) -> ConnectFailure {
    let lower = message.to_lowercase();
    if lower.contains("authorization required")
        || lower.contains("authrequired")
        || (lower.contains("401") && lower.contains("unauthorized"))
    {
        ConnectFailure::NeedsOAuth
    } else {
        ConnectFailure::Error(message)
    }
}

async fn drop_service(service: Option<Arc<ClientService>>) {
    if let Some(service) = service {
        if let Ok(mut owned) = Arc::try_unwrap(service) {
            let _ = owned.close().await;
        }
    }
}

/// Spawn the server through the user's login shell (unix) or cmd.exe
/// (Windows), with process env + resolved config env — GUI apps inherit a
/// minimal PATH; the login shell sources version-manager paths.
#[cfg(unix)]
async fn spawn_shell_child(
    command: &str,
    args: &[String],
    env: HashMap<String, String>,
) -> std::io::Result<tokio::process::Child> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned());
    let mut full_command = shell_quote(command);
    for arg in args {
        full_command.push(' ');
        full_command.push_str(&shell_quote(arg));
    }
    let mut cmd = tokio::process::Command::new(&shell);
    cmd.arg("-l").arg("-c").arg(&full_command);
    cmd.env_clear().envs(env);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    cmd.spawn()
}

#[cfg(windows)]
async fn spawn_shell_child(
    command: &str,
    args: &[String],
    env: HashMap<String, String>,
) -> std::io::Result<tokio::process::Child> {
    let mut full_command = command.to_owned();
    for arg in args {
        full_command.push(' ');
        full_command.push_str(&shell_quote(arg));
    }
    let mut cmd = tokio::process::Command::new("cmd.exe");
    cmd.arg("/c").arg(&full_command);
    cmd.env_clear().envs(env);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    cmd.spawn()
}

/// POSIX-flavored shell quoting (safe subset left bare).
fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/:=@%+".contains(&b))
    {
        return value.to_owned();
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn to_tool_defs(tools: &[RmcpTool]) -> Vec<McpToolDef> {
    tools
        .iter()
        .map(|tool| McpToolDef {
            name: tool.name.to_string(),
            description: tool
                .description
                .as_deref()
                .unwrap_or_default()
                .to_owned(),
            input_schema: serde_json::to_value(tool.input_schema.as_ref())
                .unwrap_or(serde_json::json!({})),
        })
        .collect()
}

/// Strip JSON Schema meta-keys and ensure the root is an object — the TS
/// `sanitizeInputSchema` (model providers reject `$defs`-carrying schemas).
pub fn sanitize_input_schema(schema: &serde_json::Value) -> serde_json::Value {
    let mut cleaned = serde_json::Map::new();
    if let Some(object) = schema.as_object() {
        for (key, value) in object {
            if matches!(key.as_str(), "$schema" | "$defs" | "$comment") {
                continue;
            }
            cleaned.insert(key.clone(), value.clone());
        }
    }
    let type_is_object = cleaned
        .get("type")
        .and_then(|t| t.as_str())
        .is_some_and(|t| t.eq_ignore_ascii_case("object"));
    if !type_is_object {
        cleaned.insert("type".to_owned(), serde_json::json!("object"));
    }
    serde_json::Value::Object(cleaned)
}

fn detail_suffix(stderr_tail: &str, exit_ok: bool) -> String {
    let mut suffix = String::new();
    if !exit_ok {
        suffix.push_str(" (process exited with an error)");
    }
    if !stderr_tail.trim().is_empty() {
        suffix.push_str(&format!(" Last stderr: {stderr_tail}"));
    }
    suffix
}

/// Port of the TS `explainConnectError` — actionable wording for the opaque
/// auth failures the settings UI used to show raw.
fn explain_connect_error(raw: &str, name: &str) -> String {
    let lower = raw.to_lowercase();
    let auth_related = ["oauth", "register", "client", "auth"]
        .iter()
        .any(|needle| lower.contains(needle));
    if (lower.contains("http 403") || lower.contains("forbidden")) && auth_related {
        return format!(
            "\"{name}\" rejected the connection (HTTP 403). This server likely does not \
             support dynamic client registration and requires a pre-registered OAuth \
             client. Use a server that supports DCR, or provide a client_id/client_secret \
             for this server."
        );
    }
    if lower.contains("does not support dynamic client registration") {
        return format!(
            "\"{name}\" does not support dynamic client registration (DCR). It must be \
             pre-registered with the server before it can connect."
        );
    }
    if lower.contains("no stored pkce code verifier") {
        return format!(
            "Authorization for \"{name}\" was interrupted. Re-initialize to restart the \
             sign-in flow."
        );
    }
    raw.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip() {
        let name = namespaced_tool_name("context7", "resolve-library-id");
        assert_eq!(name, "mcp__context7__resolve-library-id");
        assert_eq!(
            split_namespaced_tool_name(&name),
            Some(("context7".into(), "resolve-library-id".into()))
        );
        assert_eq!(split_namespaced_tool_name("read_file"), None);
        assert_eq!(split_namespaced_tool_name("mcp__onlyserver"), None);
    }

    #[test]
    fn schema_sanitizer_strips_meta_and_forces_object() {
        let schema = serde_json::json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "$defs": {"a": {"type": "string"}},
            "type": "object",
            "properties": {"q": {"type": "string"}}
        });
        let clean = sanitize_input_schema(&schema);
        assert!(clean.get("$schema").is_none());
        assert!(clean.get("$defs").is_none());
        assert_eq!(clean["type"], "object");
        assert!(clean["properties"].is_object());

        let typed = sanitize_input_schema(&serde_json::json!({"type": "string"}));
        assert_eq!(typed["type"], "object");
    }

    #[test]
    fn connect_errors_translate_to_actionable_messages() {
        let msg = explain_connect_error(
            "HTTP 403 Forbidden during oauth client register",
            "figma",
        );
        assert!(msg.contains("dynamic client registration"));
        let raw = explain_connect_error("connection reset by peer", "x");
        assert_eq!(raw, "connection reset by peer");
    }

    #[test]
    fn auth_required_classifies_as_needs_oauth() {
        assert!(matches!(
            classify_connect_error("authorization required: WWW-Authenticate: Bearer".into()),
            ConnectFailure::NeedsOAuth
        ));
        assert!(matches!(
            classify_connect_error("transport closed before initialize".into()),
            ConnectFailure::Error(_)
        ));
    }
}

