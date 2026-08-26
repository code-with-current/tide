//! The streaming turn step — ONE completion request driven as an event
//! stream. This is not the agentic loop: tool execution, permission checks,
//! retries and abort live in the app crate's orchestrator (T4), which
//! consumes [`EngineEvent`]s, appends the [`crate::EngineEvent::StepEnd`]
//! message to history, and calls [`stream_step`] again until the turn ends.
//!
//! Per-step quirk computation happens here — the carve math is re-derived
//! from the request every call, so budgets never compound across steps.

use std::collections::HashMap;

use futures::{Stream, StreamExt};
use rig_core::completion::{CompletionModel, CompletionRequest, ToolDefinition};
use rig_core::message::ToolChoice as MessageToolChoice;
use rig_core::streaming::{StreamedAssistantContent, ToolCallDeltaContent};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::events::{EngineEvent, EngineStopReason, EngineUsage};
use crate::history::{history_part_from_rig, HistoryMessage, HistoryPart, HistoryRole};
use crate::model::{EngineModel, ProviderApiStyle};
use crate::quirk::{
    anthropic_call_options, openai_call_options, repair_json_tool_input, resolve_reasoning,
    ProtocolContext, ReasoningOption, ThinkingLevel,
};
use crate::EngineError;

/// A tool offered to the model this step — shape mirrors
/// `fixtures/schemas/tools.json` entries (name / description / JSON schema).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// Per-turn (and per-step) knobs the orchestrator resolves from session
/// settings plus the model catalog.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnParams {
    /// System prompt (the request preamble).
    pub system: Option<String>,
    pub thinking_level: ThinkingLevel,
    /// The model's published reasoning contracts (models.dev); empty for
    /// manually-entered models.
    pub reasoning_contracts: Vec<ReasoningOption>,
    /// The model's max output tokens from the catalog; `None` → 8192
    /// default (floored to 16384 when tools are present).
    pub model_max_output_tokens: Option<u64>,
}

/// One completion step's input.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnRequest {
    /// Full normalized history, including the just-added user message.
    pub messages: Vec<HistoryMessage>,
    pub tools: Vec<ToolSpec>,
    pub params: TurnParams,
}

#[derive(Default)]
struct PendingToolCall {
    name: Option<String>,
    buffer: String,
    started: bool,
    delivered: bool,
}

/// Run one completion step. Deltas stream first; `Usage` arrives on the
/// provider's terminal record; the stream closes with `StepEnd` carrying the
/// aggregated assistant message (text/thinking/tool-call parts in emission
/// order, provider tool-call ids for wire replay) and the normalized stop
/// reason. Errors surface as `Err` items — a mid-stream failure still yields
/// `StepEnd` for the partial content first (partial parts stay persistable).
pub fn stream_step(
    model: EngineModel,
    request: TurnRequest,
) -> impl Stream<Item = Result<EngineEvent, EngineError>> {
    async_stream::stream! {
        let TurnRequest { messages, tools, params } = request;

        let ctx = ProtocolContext {
            has_tools: !tools.is_empty(),
            model_id: Some(model.model_id().to_owned()),
            max_output_tokens: params.model_max_output_tokens,
            provider_base_url: Some(model.provider_base_url().to_owned()),
        };
        let reasoning = resolve_reasoning(
            params.thinking_level,
            &params.reasoning_contracts,
            model.api_style(),
            params.model_max_output_tokens.unwrap_or(crate::quirk::DEFAULT_MAX_TOKENS),
        );
        let options = match model.api_style() {
            ProviderApiStyle::Anthropic => anthropic_call_options(reasoning.as_ref(), &ctx),
            ProviderApiStyle::OpenAi => openai_call_options(reasoning.as_ref(), &ctx),
        };

        let chat_history: Vec<_> = messages.iter().map(HistoryMessage::to_rig).collect();
        if chat_history.is_empty() {
            yield Err(EngineError::Config("turn request has no messages".to_owned()));
            return;
        }
        let has_tools = !tools.is_empty();
        let completion_request = CompletionRequest {
            model: None,
            preamble: params.system.clone(),
            chat_history,
            documents: Vec::new(),
            tools: tools
                .into_iter()
                .map(|t| ToolDefinition {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                })
                .collect(),
            temperature: None,
            max_tokens: Some(options.max_tokens),
            tool_choice: has_tools.then_some(MessageToolChoice::Auto),
            additional_params: options.additional_params.clone(),
            output_schema: None,
            record_telemetry_content: false,
        };

        let response = match model.inner_model() {
            crate::model::EngineModelRef::Anthropic(m) => m.stream(completion_request).await,
            crate::model::EngineModelRef::OpenAiCompatible(m) => m.stream(completion_request).await,
        };
        let mut response = match response {
            Ok(r) => r,
            Err(e) => {
                yield Err(EngineError::Stream(e));
                return;
            }
        };

        let mut pending: HashMap<String, PendingToolCall> = HashMap::new();
        let mut held_error: Option<EngineError> = None;
        let mut final_usage: Option<EngineUsage> = None;
        let mut final_stop: Option<EngineStopReason> = None;

        while let Some(item) = response.next().await {
            let part = match item {
                Ok(part) => part,
                Err(e) => {
                    // Hold stream errors: a later repair (or the drain)
                    // decides whether they are fatal. Real transport
                    // failures surface after StepEnd.
                    held_error = Some(EngineError::Stream(e));
                    continue;
                }
            };
            match part {
                StreamedAssistantContent::Text(text) => {
                    if !text.text.is_empty() {
                        yield Ok(EngineEvent::Delta { text: text.text });
                    }
                }
                StreamedAssistantContent::ReasoningDelta { reasoning, .. } => {
                    if !reasoning.is_empty() {
                        yield Ok(EngineEvent::Reasoning { delta: reasoning });
                    }
                }
                StreamedAssistantContent::Reasoning { .. } => {
                    // Whole-block restatement supersedes the deltas already
                    // streamed; the StepEnd message carries the aggregate.
                }
                StreamedAssistantContent::ToolCallDelta { internal_call_id, content } => {
                    let entry = pending.entry(internal_call_id.clone()).or_default();
                    match content {
                        ToolCallDeltaContent::Name(name) => {
                            if entry.name.is_none() {
                                entry.name = Some(name.clone());
                            }
                            if !entry.started {
                                entry.started = true;
                                yield Ok(EngineEvent::ToolCallStart {
                                    tool_call_id: internal_call_id.clone(),
                                    tool_name: name,
                                });
                            }
                        }
                        ToolCallDeltaContent::Delta(delta) => {
                            if !entry.started {
                                entry.started = true;
                                yield Ok(EngineEvent::ToolCallStart {
                                    tool_call_id: internal_call_id.clone(),
                                    tool_name: entry.name.clone().unwrap_or_default(),
                                });
                            }
                            entry.buffer.push_str(&delta);
                            if !delta.is_empty() {
                                yield Ok(EngineEvent::ToolCallDelta {
                                    tool_call_id: internal_call_id.clone(),
                                    delta,
                                });
                            }
                        }
                    }
                }
                StreamedAssistantContent::ToolCall { tool_call, internal_call_id } => {
                    if let Some(entry) = pending.get_mut(&internal_call_id) {
                        entry.delivered = true;
                    }
                    yield Ok(EngineEvent::ToolCall {
                        tool_call_id: internal_call_id,
                        tool_name: tool_call.function.name.clone(),
                        arguments: tool_call.function.arguments.clone(),
                    });
                }
                StreamedAssistantContent::Final(final_record) => {
                    final_usage = Some(EngineUsage::from(&final_record.usage));
                    final_stop = final_record.finish_reason.map(EngineStopReason::from);
                }
                StreamedAssistantContent::Unknown(_) => {}
            }
        }

        // Drain done. Recover any tool call whose input never parsed: GLM
        // streams duplicated fragments, and the repair keeps the LAST
        // parseable object (the model's latest attempt).
        let mut recovered: Vec<HistoryPart> = Vec::new();
        let mut recovered_any = false;
        for (call_id, entry) in &pending {
            if entry.delivered || entry.buffer.trim().is_empty() {
                continue;
            }
            if let Some(repaired) = repair_json_tool_input(&entry.buffer)
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            {
                let name = entry.name.clone().unwrap_or_default();
                recovered.push(HistoryPart::ToolCall {
                    id: call_id.clone(),
                    tool_name: name.clone(),
                    arguments: repaired.clone(),
                });
                recovered_any = true;
                yield Ok(EngineEvent::ToolCall {
                    tool_call_id: call_id.clone(),
                    tool_name: name,
                    arguments: repaired,
                });
            }
        }
        if recovered_any {
            held_error = None;
        }

        if let Some(usage) = final_usage {
            yield Ok(EngineEvent::Usage { tokens: usage });
        }

        let mut parts: Vec<HistoryPart> = response
            .choice
            .iter()
            .filter_map(history_part_from_rig)
            .collect();
        parts.extend(recovered);

        let stop_reason = final_stop.unwrap_or_else(|| {
            if parts.iter().any(|p| matches!(p, HistoryPart::ToolCall { .. })) {
                EngineStopReason::ToolUse
            } else {
                // No terminal record: truncation, never a clean end.
                EngineStopReason::Other("truncated".to_owned())
            }
        });
        yield Ok(EngineEvent::StepEnd {
            stop_reason,
            message: HistoryMessage { role: HistoryRole::Assistant, parts },
        });

        if let Some(err) = held_error {
            yield Err(err);
        }
    }
}
