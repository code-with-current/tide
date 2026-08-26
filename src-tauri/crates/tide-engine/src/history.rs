//! Engine history — the normalized message shapes the orchestrator feeds
//! [`crate::stream_step`] and receives back on
//! [`crate::EngineEvent::StepEnd`].
//!
//! Designed after BOTH sides it bridges:
//! - rig's input types (`Message` / `UserContent` / `AssistantContent`) —
//!   [`HistoryMessage::to_rig`] converts losslessly;
//! - the sessions-v2 part kinds (`text` / `thinking` / `tool`) — a stored
//!   tool part (`{toolName, input, output, status}`) maps to an assistant
//!   [`HistoryPart::ToolCall`] followed by a user-side
//!   [`HistoryPart::ToolResult`] once execution completed. That v2-parts →
//!   engine-history mapping is the orchestrator's (T4) job.
//!
//! Thinking parts round-trip for Anthropic (reasoning blocks replay on the
//! wire); OpenAI-compatible endpoints get them mapped per rig's wire rules.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::quirk::clamp_tool_result_output;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryRole {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HistoryPart {
    /// v2 part kind `text` — `{ text }`.
    Text { text: String },
    /// v2 part kind `thinking` — `{ text }`.
    Thinking { text: String },
    /// Assistant-emitted tool call. `id` is the PROVIDER-issued tool-call id
    /// when one exists (required for Anthropic wire replay); the
    /// orchestrator keeps its own engine correlator in sync via the
    /// `toolCallId` on the streaming events.
    ToolCall {
        id: String,
        tool_name: String,
        arguments: Value,
    },
    /// Executed tool result (user-side answer to a call). Output is clamped
    /// to the engine-side floor before it reaches the model.
    ToolResult {
        call_id: String,
        tool_name: String,
        output: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub role: HistoryRole,
    pub parts: Vec<HistoryPart>,
}

impl HistoryMessage {
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: HistoryRole::User,
            parts: vec![HistoryPart::Text { text: text.into() }],
        }
    }

    pub fn system_text(text: impl Into<String>) -> Self {
        Self {
            role: HistoryRole::System,
            parts: vec![HistoryPart::Text { text: text.into() }],
        }
    }

    /// Convert into rig's provider-agnostic message. Tool results are
    /// clamped here — the last stop before the wire.
    pub fn to_rig(&self) -> rig_core::completion::Message {
        use rig_core::message::{
            AssistantContent, Message, Reasoning, Text, ToolCall as RigToolCall, ToolCallId,
            ToolFunction, ToolResult as RigToolResult, ToolResultContent, UserContent,
        };

        match self.role {
            HistoryRole::System => {
                let joined = self
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        HistoryPart::Text { text } | HistoryPart::Thinking { text } => {
                            Some(text.as_str())
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                Message::system(joined)
            }
            HistoryRole::User => Message::User {
                content: self
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        HistoryPart::Text { text } => {
                            Some(UserContent::Text(Text::new(text.clone())))
                        }
                        HistoryPart::ToolResult {
                            call_id,
                            tool_name,
                            output,
                        } => Some(UserContent::ToolResult(RigToolResult {
                            call: ToolCallId::new_or_mint(call_id.clone()),
                            provider: None,
                            name: tool_name.clone(),
                            content: vec![ToolResultContent::text(clamp_tool_result_output(
                                output,
                            ))],
                        })),
                        HistoryPart::Thinking { .. } | HistoryPart::ToolCall { .. } => None,
                    })
                    .collect(),
            },
            HistoryRole::Assistant => Message::Assistant {
                id: None,
                content: self
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        HistoryPart::Text { text } => {
                            Some(AssistantContent::Text(Text::new(text.clone())))
                        }
                        HistoryPart::Thinking { text } => {
                            Some(AssistantContent::Reasoning(Reasoning::new(text)))
                        }
                        HistoryPart::ToolCall {
                            id,
                            tool_name,
                            arguments,
                        } => Some(AssistantContent::ToolCall(RigToolCall::new(
                            ToolCallId::new_or_mint(id.clone()),
                            ToolFunction::new(tool_name.clone(), arguments.clone()),
                        ))),
                        HistoryPart::ToolResult { .. } => None,
                    })
                    .collect(),
            },
        }
    }
}

/// Map one aggregated assistant content block onto a history part. Media
/// output has no sessions-v2 part representation yet and maps to `None`.
pub(crate) fn history_part_from_rig(
    content: &rig_core::message::AssistantContent,
) -> Option<HistoryPart> {
    use rig_core::message::AssistantContent;
    match content {
        AssistantContent::Text(text) => Some(HistoryPart::Text {
            text: text.text().to_owned(),
        }),
        AssistantContent::Reasoning(reasoning) => Some(HistoryPart::Thinking {
            text: reasoning.display_text(),
        }),
        AssistantContent::ToolCall(call) => Some(HistoryPart::ToolCall {
            id: call.id.to_string(),
            tool_name: call.function.name.clone(),
            arguments: call.function.arguments.clone(),
        }),
        AssistantContent::Image(_) => None,
    }
}
