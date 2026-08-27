//! `dispatch_agent` — port of `app/core/agent/tools/dispatch-agent.ts`
//! @ 91ec558. The tool's *spec* lives here (schema byte-matches the
//! fixtures entry, name enum from the catalog); the *body* cannot —
//! spawning a child turn needs the orchestrator (engine stream, hub,
//! permission inheritance). The orchestrator intercepts the call by name
//! and runs the dispatch runner; this stub's `execute` only fires when
//! something bypasses the turn loop and must fail loudly, never silently.

use crate::agents::agent_names;
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolOutcome, ToolSpec};

pub const DESCRIPTION: &str = "Spawn a specialized sub-agent for a focused subtask — the agent runs its own multi-step tool loop and returns a report. Dispatch PROACTIVELY when a specialty fits: code-reviewer to review a diff, simplifier for a cleanup pass, explore to locate code, general-purpose for broad research. Dispatch multiple agents in one response to run them in parallel. For simple lookups (one file, one grep) use the direct tools instead. The result includes a dispatchId; pass it as resumeFrom to continue that sub-agent with a follow-up task (it keeps its prior context — keep follow-up instructions brief; brief is intentional, not ambiguous). Every dispatch without resumeFrom starts completely fresh.";

pub struct DispatchAgentTool;

impl Tool for DispatchAgentTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "dispatch_agent".to_owned(),
            description: DESCRIPTION.to_owned(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "enum": agent_names(),
                        "description": "The agent to dispatch.",
                    },
                    "title": {
                        "type": "string",
                        "description": "Short human-readable label for this dispatch (3-6 words). Shown in the UI so parallel dispatches are distinguishable.",
                    },
                    "task": {
                        "type": "string",
                        "description": "Self-contained task description. The agent sees only this string — include any context it needs (file paths, snippets, constraints). Do not assume the agent can see the prior conversation.",
                    },
                    "resumeFrom": {
                        "type": "string",
                        "description": "Dispatch id from a previous dispatch_agent result (the dispatchId field in its output metadata). Continues that same sub-agent with its prior context instead of starting fresh. Only use it to follow up on an earlier dispatch in this same session.",
                    },
                    "background": {
                        "type": "boolean",
                        "description": "Run the sub-agent in the background and continue your turn. You will be notified when it completes. DO NOT sleep, poll, or check its progress — work on non-overlapping tasks or end your response.",
                    },
                },
                "required": ["name", "task"],
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        // Single-shot LLM call, no direct mutations — the target's toolset
        // tier is gated separately (plan-mode dispatch gate).
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        _ctx: &ToolContext,
        _args: serde_json::Value,
    ) -> Result<ToolOutcome, crate::ToolError> {
        Ok(ToolOutcome::failed(
            "dispatch_agent runs inside the orchestrator's turn loop (it spawns a child turn); \
             direct execution is not available.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_execution_fails_loudly() {
        let tool = DispatchAgentTool;
        let outcome = tool
            .execute(&ToolContext::new(std::env::temp_dir()), serde_json::json!({}))
            .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        assert!(outcome.output.contains("orchestrator"));
    }
}
