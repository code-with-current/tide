//! send_message / list_agents — the agent-messaging pair. Like
//! `dispatch_agent`, the *spec* lives here (schema byte-matches the
//! fixtures entry) while the *body* cannot: routing a message needs the
//! orchestrator's child registry (who is running, who is parked, where
//! each inbox lives). The orchestrator intercepts the calls by name; these
//! stubs' `execute` only fire when something bypasses the turn loop and
//! must fail loudly, never silently.

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolOutcome, ToolSpec};

pub const SEND_MESSAGE_DESCRIPTION: &str = "Send a short text message to another agent in this session — a running sub-agent receives it at its next step (like steering), a finished one receives it the next time it is resumed, and `main` is this conversation's lead agent. Use it to hand off a finding, ask a sibling for a fact it owns, or report upward mid-task. Fire-and-forget: delivery is confirmed, but a reply only comes if the other agent chooses to send one back. Discover ids with list_agents; dispatch results also carry a dispatchId usable here.";

pub const LIST_AGENTS_DESCRIPTION: &str =
    "List the agents in this session: the lead agent (`main`) and every dispatched sub-agent with its dispatchId, name, status (running / completed / failed), and title. Use before send_message or dispatch_agent's resumeFrom to discover ids.";

pub struct SendMessageTool;

impl Tool for SendMessageTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "send_message".to_owned(),
            description: SEND_MESSAGE_DESCRIPTION.to_owned(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "agentId": {
                        "type": "string",
                        "description":
                            "Recipient: a dispatchId from dispatch_agent or list_agents, or `main` for this conversation's lead agent.",
                    },
                    "message": {
                        "type": "string",
                        "description":
                            "The message body. Keep it short and self-contained — a finding, a question, or a directive the recipient can act on at its next step.",
                    },
                },
                "required": ["agentId", "message"],
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        // Pure message routing — no direct effects beyond in-memory queues.
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        _ctx: &ToolContext,
        _args: serde_json::Value,
    ) -> Result<ToolOutcome, crate::ToolError> {
        Err(crate::ToolError::Internal(
            "send_message is orchestrator-owned; it must run through the dispatch turn loop"
                .to_owned(),
        ))
    }
}

pub struct ListAgentsTool;

impl Tool for ListAgentsTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "list_agents".to_owned(),
            description: LIST_AGENTS_DESCRIPTION.to_owned(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        _ctx: &ToolContext,
        _args: serde_json::Value,
    ) -> Result<ToolOutcome, crate::ToolError> {
        Err(crate::ToolError::Internal(
            "list_agents is orchestrator-owned; it must run through the dispatch turn loop"
                .to_owned(),
        ))
    }
}
