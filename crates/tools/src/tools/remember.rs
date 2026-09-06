//! remember — the agent-memory write tool: durably records a fact about
//! this project that future sessions recall through the memory tool's
//! fused search. Unlike the orchestrator-owned specs, this body runs for
//! real — it routes through the [`MemoryWriter`] seam the daemon installs,
//! so the crate stays storage-free exactly like the memory tool.

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolOutcome, ToolSpec};

pub const DESCRIPTION: &str = "Record a durable fact about this project — conventions, decisions, quirks, environment specifics, anything a future session in this workspace would otherwise rediscover the hard way. Facts persist across sessions and resurface through the memory tool's search; write them as one self-contained sentence or short paragraph. Use for knowledge with a shelf life (this repo's test commands beat 'the sky is blue'); call memory first when you need what past sessions learned.";

pub struct RememberTool;

impl Tool for RememberTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "remember".to_owned(),
            description: DESCRIPTION.to_owned(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "fact": {
                        "type": "string",
                        "description":
                            "One self-contained fact, written to be understood in a future session with no other context. Include the 'why', not just the 'what'.",
                    },
                },
                "required": ["fact"],
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        // Appending to the project's own memory store — no workspace files
        // or system state change.
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, crate::ToolError> {
        let fact = super::arg_str(&args, "fact");
        if fact.trim().is_empty() {
            return Ok(ToolOutcome::failed("Missing required arg: fact"));
        }
        let Some(writer) = super::memory::shared_memory_writer() else {
            return Ok(ToolOutcome::failed(
                "Memory is not enabled — enable Memory & RAG for this project in settings first.",
            ));
        };
        match writer.remember(&ctx.workspace_id, fact.trim()) {
            Ok(()) => Ok(ToolOutcome::executed(
                "Remembered. Future sessions in this project recall it via the memory tool.",
            )),
            Err(error) => Ok(ToolOutcome::failed(format!(
                "could not store the memory: {error}"
            ))),
        }
    }
}
