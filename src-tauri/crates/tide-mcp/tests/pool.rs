//! Pool integration tests against the scripted stdio fixture server
//! (`src/bin/mcp-echo-fixture.rs`). Exercises the real rmcp wire protocol:
//! start → initialize → tools/list → tools/call, naming bridging, failure
//! and crash-recovery lifecycle, and config-driven construction.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use tide_mcp::config::{McpServerConfig, McpTransportType};
use tide_mcp::{ConnStatus, McpPool};
use tide_store::config::Config;
use tide_tools::OutcomeStatus;

fn fixture_config(mode: &str) -> McpServerConfig {
    McpServerConfig {
        r#type: Some(McpTransportType::Stdio),
        command: Some(env!("CARGO_BIN_EXE_mcp-echo-fixture").to_owned()),
        args: None,
        env: Some(BTreeMap::from([(
            "FIXTURE_MODE".to_owned(),
            mode.to_owned(),
        )])),
        ..Default::default()
    }
}

fn user_config(servers: &[(&str, McpServerConfig)]) -> Config {
    let mut config = Config::default();
    let mut map = serde_json::Map::new();
    for (name, server) in servers {
        map.insert(
            (*name).to_owned(),
            serde_json::to_value(server).unwrap(),
        );
    }
    config.mcp_servers = Some(map);
    config
}

async fn pool(servers: &[(&str, McpServerConfig)]) -> Arc<McpPool> {
    let dir = tempfile::tempdir().unwrap();
    McpPool::from_config(dir.path().to_path_buf(), &user_config(servers), None).await
}

async fn wait_status(pool: &Arc<McpPool>, name: &str, want: ConnStatus) -> ServerRow {
    for _ in 0..300 {
        if let Some(row) = pool
            .status_list()
            .await
            .into_iter()
            .find(|row| row.name == name)
        {
            if row.status == want {
                return ServerRow::from(&row);
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "server {name} never reached {want:?}; last: {:?}",
        pool.status_list().await
    );
}

#[derive(Debug)]
struct ServerRow {
    status: ConnStatus,
    error: Option<String>,
    tool_names: Vec<String>,
}

impl ServerRow {
    fn from(row: &tide_mcp::ServerStatusRow) -> Self {
        Self {
            status: row.status,
            error: row.error.clone(),
            tool_names: row.tool_names.clone(),
        }
    }
}

#[tokio::test]
async fn stdio_server_start_tools_list_call_and_naming() {
    let pool = pool(&[("echo-server", fixture_config("ok"))]).await;
    let row = wait_status(&pool, "echo-server", ConnStatus::Connected).await;
    assert_eq!(
        row.tool_names,
        vec!["echo".to_owned(), "fail".to_owned()]
    );

    // Naming bridge: mcp__<server>__<tool>.
    let specs = pool.tool_specs().await;
    let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"mcp__echo-server__echo"), "{names:?}");
    assert!(names.contains(&"mcp__echo-server__fail"));
    let echo_spec = specs.iter().find(|s| s.name == "mcp__echo-server__echo").unwrap();
    assert_eq!(echo_spec.description, "echo-server: Echo the text back");
    assert_eq!(echo_spec.parameters["type"], "object");
    assert_eq!(echo_spec.parameters["properties"]["text"]["type"], "string");

    // Direct call.
    let outcome = pool
        .call("echo-server", "echo", serde_json::json!({"text": "hi"}))
        .await
        .unwrap();
    assert!(!outcome.is_error);
    assert_eq!(outcome.text, "echo: hi");

    // Tool-trait dispatch (the orchestrator path): spawn_blocking like the
    // turn loop does, so block_on_call has a runtime handle.
    let tools = pool.mcp_tools().await;
    let echo = tools
        .iter()
        .find(|t| t.spec().name == "mcp__echo-server__echo")
        .expect("bridged echo tool present");
    let echo = Arc::clone(echo);
    let outcome = tokio::task::spawn_blocking(move || {
        let ctx = tide_tools::ToolContext::new("/tmp");
        echo.execute(&ctx, serde_json::json!({"text": "from tool"}))
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(outcome.status, OutcomeStatus::Executed);
    assert_eq!(outcome.output, "echo: from tool");
    assert_eq!(outcome.meta.as_deref(), Some("server echo-server"));

    // A server error result maps to a failed outcome, not an Err.
    let fail = tools
        .iter()
        .find(|t| t.spec().name == "mcp__echo-server__fail")
        .unwrap();
    let outcome = tokio::task::spawn_blocking({
        let fail = Arc::clone(fail);
        move || {
            let ctx = tide_tools::ToolContext::new("/tmp");
            fail.execute(&ctx, serde_json::json!({}))
        }
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(outcome.status, OutcomeStatus::Failed);
    assert_eq!(outcome.output, "fixture tool error");
    pool.shutdown().await;
}

#[tokio::test]
async fn bad_command_lands_in_error_status() {
    let mut config = fixture_config("ok");
    config.command = Some("definitely-not-a-real-command-xyz".to_owned());
    let pool = pool(&[("broken", config)]).await;
    let row = wait_status(&pool, "broken", ConnStatus::Error).await;
    // The login shell spawns fine; the missing command surfaces as a
    // transport/initialize failure once the child exits 127.
    assert!(row.error.is_some());
    assert!(pool.tool_specs().await.is_empty());
    assert!(pool.call("broken", "echo", serde_json::json!({})).await.is_err());
}

#[tokio::test]
async fn missing_secret_lands_in_needs_credentials() {
    let mut config = fixture_config("ok");
    config.env = Some(BTreeMap::from([(
        "API_KEY".to_owned(),
        "{{secret:NOT_THERE}}".to_owned(),
    )]));
    let pool = pool(&[("locked", config)]).await;
    let row = wait_status(&pool, "locked", ConnStatus::NeedsCredentials).await;
    assert_eq!(row.error.as_deref(), Some("Missing secrets: NOT_THERE"));
}

#[tokio::test]
async fn invalid_config_rows_surface_as_errors() {
    let invalid = McpServerConfig {
        r#type: Some(McpTransportType::Http),
        url: None,
        ..Default::default()
    };
    let pool = pool(&[("bad-http", invalid), ("ok", fixture_config("ok"))]).await;
    let bad = wait_status(&pool, "bad-http", ConnStatus::Error).await;
    assert!(bad.error.unwrap().contains("url"));
    wait_status(&pool, "ok", ConnStatus::Connected).await;
}

#[tokio::test]
async fn crash_recovery_restarts_with_backoff_then_gives_up() {
    let dir = tempfile::tempdir().unwrap();
    let pool = McpPool::new(dir.path().to_path_buf())
        .with_restart_backoff_base(Duration::from_millis(20));
    let pool = Arc::new(pool);
    pool.connect_entry(tide_mcp::ResolvedServer {
        name: "crasher".to_owned(),
        config: fixture_config("crash"),
        scope: tide_mcp::McpScope::User,
        workspace_id: None,
        workspace_root: None,
    })
    .await;
    // The fixture serves normally, then dies ~300ms after initialize:
    // crash → restart (×3 with backoff) → exhausted → error. With a 20ms
    // base the cycle (3 × ~320ms) fits the poll budget.
    let row = wait_status(&pool, "crasher", ConnStatus::Error).await;
    let error = row.error.unwrap();
    assert!(error.contains("crashed 3×"), "{error}");
    assert!(error.contains("fixture crashing on purpose"), "{error}");
}

#[tokio::test]
async fn intentional_disconnect_never_restarts() {
    let pool = pool(&[("stable", fixture_config("ok"))]).await;
    wait_status(&pool, "stable", ConnStatus::Connected).await;
    pool.disconnect("stable").await;
    let row = ServerRow::from(
        &pool
            .status_list()
            .await
            .into_iter()
            .find(|r| r.name == "stable")
            .unwrap(),
    );
    assert_eq!(row.status, ConnStatus::Disconnected);
    assert!(row.tool_names.is_empty());
    // Give any (wrong) restart time to fire.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let row = ServerRow::from(
        &pool
            .status_list()
            .await
            .into_iter()
            .find(|r| r.name == "stable")
            .unwrap(),
    );
    assert_eq!(row.status, ConnStatus::Disconnected, "no crash recovery");
    assert!(pool.tool_specs().await.is_empty());
}

#[tokio::test]
async fn refresh_server_tools_returns_live_count() {
    let pool = pool(&[("echo-server", fixture_config("ok"))]).await;
    wait_status(&pool, "echo-server", ConnStatus::Connected).await;
    assert_eq!(pool.refresh_server_tools("echo-server").await, Some(2));
    pool.disconnect("echo-server").await;
    assert_eq!(pool.refresh_server_tools("echo-server").await, None);
    assert_eq!(pool.refresh_server_tools("nope").await, None);
}

#[tokio::test]
async fn retry_server_reconnects_with_stored_config() {
    let pool = pool(&[("flaky", fixture_config("ok"))]).await;
    wait_status(&pool, "flaky", ConnStatus::Connected).await;
    pool.disconnect("flaky").await;
    assert!(pool.retry_server("flaky").await);
    wait_status(&pool, "flaky", ConnStatus::Connected).await;
    assert!(!pool.retry_server("unknown").await);
}
