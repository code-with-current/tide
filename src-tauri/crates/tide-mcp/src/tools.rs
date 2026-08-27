//! Dynamic tool bridging — one [`tide_tools::Tool`] handle per discovered
//! MCP tool (the TS `mcpToolsetForWorkspace` port, minus the per-call tool
//! refresh which lands with the pool's own refresh API).
//!
//! The handle's spec name is `mcp__<server>__<tool>`; the orchestrator's
//! name-based dispatch finds it in the turn's tool list with zero special
//! casing, and the permission gate auto-allows the read tier per the TS
//! toolMeta `mcp` entry (risk read-only, all modes — MCP servers were never
//! wrapped by the TS permission wrapper either).

use tide_tools::{RiskTier, Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

use crate::pool::{namespaced_tool_name, sanitize_input_schema, McpPool, McpToolDef};

/// A callable MCP tool owned by a pool. `pool` is a weak handle so adapters
/// dropped after a pool swap don't keep dead connections alive.
pub struct McpToolHandle {
    pub pool: std::sync::Weak<McpPool>,
    pub server: String,
    pub tool: McpToolDef,
}

impl McpToolHandle {
    fn namespaced_name(&self) -> String {
        namespaced_tool_name(&self.server, &self.tool.name)
    }
}

impl Tool for McpToolHandle {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.namespaced_name(),
            description: format!("{}: {}", self.server, self.tool.description),
            parameters: sanitize_input_schema(&self.tool.input_schema),
        }
    }

    /// TS toolMeta `mcp` entry: risk read-only, auto-approve in all modes.
    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(&self, _ctx: &ToolContext, args: serde_json::Value) -> Result<ToolOutcome, ToolError> {
        let Some(pool) = self.pool.upgrade() else {
            return Ok(ToolOutcome::failed(
                "MCP pool is no longer available (server was reloaded).",
            ));
        };
        let call = pool.call(&self.server, &self.tool.name, args);
        let outcome = block_on_call(call);
        Ok(match outcome {
            Ok(call) if call.is_error => ToolOutcome::failed(
                if call.text.is_empty() {
                    "MCP tool returned an error".to_owned()
                } else {
                    call.text
                },
            ),
            Ok(call) => ToolOutcome::executed(call.text),
            Err(message) => ToolOutcome::failed(format!("MCP call failed: {message}")),
        }
        .with_meta(format!("server {}", self.server)))
    }
}

/// Run the async pool call from the sync tool contract. The orchestrator
/// invokes `execute` inside `spawn_blocking`, so a runtime handle is
/// available; the blocking fallback covers callers off-runtime (tests).
fn block_on_call<F: std::future::Future>(future: F) -> F::Output {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => handle.block_on(future),
        Err(_) => futures::executor::block_on(future),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tide_tools::OutcomeStatus;

    #[test]
    fn namespaced_spec_shape() {
        let handle = McpToolHandle {
            pool: std::sync::Weak::new(),
            server: "context7".into(),
            tool: McpToolDef {
                name: "resolve-library-id".into(),
                description: "Resolve a library".into(),
                input_schema: serde_json::json!({
                    "$schema": "x",
                    "type": "object",
                    "properties": {"q": {"type": "string"}}
                }),
            },
        };
        let spec = handle.spec();
        assert_eq!(spec.name, "mcp__context7__resolve-library-id");
        assert_eq!(spec.description, "context7: Resolve a library");
        assert!(spec.parameters.get("$schema").is_none());
        assert_eq!(spec.parameters["type"], "object");
        assert_eq!(handle.risk_tier(), RiskTier::ReadOnly);
    }

    #[test]
    fn dead_pool_maps_to_failed_outcome() {
        let handle = McpToolHandle {
            pool: std::sync::Weak::new(),
            server: "gone".into(),
            tool: McpToolDef {
                name: "t".into(),
                description: String::new(),
                input_schema: serde_json::json!({}),
            },
        };
        let outcome = handle
            .execute(&ToolContext::new("/tmp"), serde_json::json!({}))
            .unwrap();
        assert_eq!(outcome.status, OutcomeStatus::Failed);
        assert!(outcome.output.contains("no longer available"));
    }
}
