//! tide-mcp — MCP client pool, lifecycle, OAuth and dynamic tool bridging
//! on rmcp 3. Port of `app/core/agent/mcp/` @ 91ec558:
//! - pool/lifecycle: [`pool::McpPool`]
//! - OAuth loopback + credential storage: [`oauth`]
//! - dynamic tool bridging (`mcp__<server>__<tool>`): [`tools`]
//! - config resolution (config.json `mcpServers` + workspace `.mcp.json`):
//!   [`config`]
//! - `{{secret:name}}` placeholders: [`secrets`]
//! - import scanner (other tools' config files): [`scanner`]

pub mod config;
pub mod oauth;
pub mod pool;
pub mod scanner;
pub mod secrets;
pub mod tools;

pub use config::{McpConfigFile, McpScope, McpServerConfig, McpTransportType, ResolvedServer};
pub use pool::{
    namespaced_tool_name, split_namespaced_tool_name, CallOutcome, ConnStatus, McpPool,
    McpToolDef, ServerStatusRow,
};
pub use scanner::{DetectedServer, ScanResult};

#[cfg(test)]
mod tests {
    #[test]
    fn crate_version_matches_workspace() {
        assert_eq!(env!("CARGO_PKG_VERSION"), "0.4.0");
    }
}
