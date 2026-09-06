//! Fixture-replay tests — drive [`crate::stream_step`] against a local mock
//! SSE server serving each M0 fixture's recorded bytes, then assert:
//! 1. the request body rig sent matches the fixture's `request` section on
//!    every quirk-computed field (carved `max_tokens`, `thinking`
//!    presence/absence per the host allowlist, `reasoning_effort`, tool
//!    schemas, tool floor);
//! 2. the streamed events project onto the fixture's `tideEvents` sequence
//!    (deltas, tool-input fragments, parsed calls, usage numbers);
//! 3. `StepEnd` aggregates the assistant message with provider tool-call
//!    ids, and the malformed-input repair recovers GLM's duplicated
//!    fragments.

use std::collections::HashMap;
use std::path::Path;

use futures::StreamExt;
use serde_json::Value;

use crate::events::{EngineEvent, EngineStopReason, EngineUsage};
use crate::history::{HistoryMessage, HistoryPart, HistoryRole};
use crate::mock_sse::{CapturedRequest, MockSse};
use crate::model::{EngineModel, EngineModelConfig, ProviderApiStyle};
use crate::quirk::{ReasoningOption, TOOL_OUTPUT_FLOOR};
use crate::turn::{stream_step, ToolSpec, TurnParams, TurnRequest};
use crate::EngineError;

fn load_fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/sse")
        .join(format!("{name}.json"));
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{name}: {e}"));
    serde_json::from_str(&raw).unwrap()
}

fn fixture_config(fixture: &Value) -> EngineModelConfig {
    let provider = &fixture["input"]["provider"];
    EngineModelConfig {
        api_style: match provider["apiStyle"].as_str().unwrap() {
            "anthropic" => ProviderApiStyle::Anthropic,
            "openai" => ProviderApiStyle::OpenAi,
            other => panic!("unknown apiStyle {other}"),
        },
        base_url: provider["baseUrl"].as_str().unwrap().to_owned(),
        api_key: "test-key-local-mock".to_owned(),
        model_id: provider["modelId"].as_str().unwrap().to_owned(),
    }
}

/// Feed the fixture's own recorded tool schemas (from its `request` body —
/// what the TS stack sent) so the engine's wire output is comparable 1:1.
fn fixture_tools(fixture: &Value, api_style: ProviderApiStyle) -> Vec<ToolSpec> {
    let wire_tools = fixture["request"]["body"]["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    wire_tools
        .into_iter()
        .map(|t| match api_style {
            ProviderApiStyle::Anthropic => ToolSpec {
                name: t["name"].as_str().unwrap().to_owned(),
                description: t["description"].as_str().unwrap_or_default().to_owned(),
                parameters: t["input_schema"].clone(),
            },
            ProviderApiStyle::OpenAi => ToolSpec {
                name: t["function"]["name"].as_str().unwrap().to_owned(),
                description: t["function"]["description"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                parameters: t["function"]["parameters"].clone(),
            },
        })
        .collect()
}

fn fixture_turn_request(fixture: &Value, api_style: ProviderApiStyle) -> TurnRequest {
    let input = &fixture["input"];
    let messages: Vec<HistoryMessage> = input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| match m["role"].as_str().unwrap() {
            "system" => HistoryMessage::system_text(m["content"].as_str().unwrap()),
            _ => HistoryMessage::user_text(m["content"].as_str().unwrap()),
        })
        .collect();
    let contracts: Vec<ReasoningOption> = input["reasoningContracts"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|c| serde_json::from_value(c.clone()).unwrap())
        .collect();
    TurnRequest {
        messages,
        tools: fixture_tools(fixture, api_style),
        params: TurnParams {
            system: input["system"].as_str().map(str::to_owned),
            thinking_level: serde_json::from_value(input["thinkingLevel"].clone()).unwrap(),
            reasoning_contracts: contracts,
            model_max_output_tokens: input["modelMaxOutputTokens"].as_u64(),
        },
    }
}

async fn replay(
    name: &str,
) -> (
    Value,
    Vec<CapturedRequest>,
    Vec<Result<EngineEvent, EngineError>>,
) {
    let fixture = load_fixture(name);
    let server = MockSse::spawn(fixture["sse"].as_str().unwrap()).unwrap();
    let config = fixture_config(&fixture);
    let model = EngineModel::from_config_with_transport(&config, server.base_url()).unwrap();
    let request = fixture_turn_request(&fixture, config.api_style);
    let events = stream_step(model, request).collect::<Vec<_>>().await;
    (fixture, server.captured(), events)
}

/// Assigns ordinals to distinct tool-call ids by first appearance.
#[derive(Default)]
struct IdNormalizer {
    ids: HashMap<String, usize>,
}

impl IdNormalizer {
    fn of(&mut self, key: &str) -> usize {
        let next = self.ids.len();
        *self.ids.entry(key.to_owned()).or_insert(next)
    }

    fn existing(&self, key: &str) -> usize {
        *self
            .ids
            .get(key)
            .unwrap_or_else(|| panic!("id {key} referenced before its start event"))
    }
}

/// Event projection with tool-call ids normalized to first-appearance
/// ordinals — the engine's stream correlator differs in spelling from the
/// provider id the fixtures recorded, never in structure.
#[derive(Debug, Clone, PartialEq)]
enum Norm {
    Delta(String),
    Reasoning(String),
    ToolStart(usize, String),
    ToolDelta(usize, String),
    ToolCall(usize, String, Value),
    Usage(EngineUsage),
    StepEnd(EngineStopReason, Vec<HistoryPart>),
    Error(String),
}

fn normalize_events(events: Vec<Result<EngineEvent, EngineError>>) -> Vec<Norm> {
    let mut norm_ids = IdNormalizer::default();
    events
        .into_iter()
        .map(|item| match item {
            Ok(EngineEvent::Delta { text }) => Norm::Delta(text),
            Ok(EngineEvent::Reasoning { delta }) => Norm::Reasoning(delta),
            Ok(EngineEvent::ToolCallStart {
                tool_call_id,
                tool_name,
            }) => Norm::ToolStart(norm_ids.of(&tool_call_id), tool_name),
            Ok(EngineEvent::ToolCallDelta {
                tool_call_id,
                delta,
            }) => Norm::ToolDelta(norm_ids.of(&tool_call_id), delta),
            Ok(EngineEvent::ToolCall {
                tool_call_id,
                tool_name,
                arguments,
            }) => Norm::ToolCall(norm_ids.of(&tool_call_id), tool_name, arguments),
            Ok(EngineEvent::Usage { tokens }) => Norm::Usage(tokens),
            Ok(EngineEvent::StepEnd {
                stop_reason,
                message,
            }) => Norm::StepEnd(stop_reason, message.parts),
            Err(e) => Norm::Error(e.to_string()),
        })
        .collect()
}

/// Expected projection from the fixture's `tideEvents` — the recorded TS
/// orchestrator boundary.
fn expected_events(fixture: &Value) -> Vec<Norm> {
    let mut want_ids = IdNormalizer::default();
    fixture["tideEvents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let tool_call_id = || e["toolCallId"].as_str().unwrap_or_default();
            match e["type"].as_str().unwrap() {
                "delta" => Norm::Delta(e["text"].as_str().unwrap().to_owned()),
                "reasoning" => Norm::Reasoning(e["delta"].as_str().unwrap().to_owned()),
                "tool_call_start" => Norm::ToolStart(
                    want_ids.of(tool_call_id()),
                    e["toolName"].as_str().unwrap().to_owned(),
                ),
                "tool_call_delta" => Norm::ToolDelta(
                    want_ids.existing(tool_call_id()),
                    e["delta"].as_str().unwrap().to_owned(),
                ),
                "tool_call" => Norm::ToolCall(
                    want_ids.existing(tool_call_id()),
                    e["toolName"].as_str().unwrap().to_owned(),
                    e["arguments"].clone(),
                ),
                "usage" => {
                    let t = &e["tokens"];
                    let num = |segments: &[&str]| {
                        let mut v = &t[segments[0]];
                        for seg in &segments[1..] {
                            v = &v[seg];
                        }
                        v.as_u64().unwrap_or(0)
                    };
                    Norm::Usage(EngineUsage {
                        input_tokens: num(&["inputTokens"]),
                        output_tokens: num(&["outputTokens"]),
                        cache_read: num(&["inputTokenDetails", "cacheReadTokens"]),
                        cache_write: 0,
                        reasoning_tokens: num(&["outputTokenDetails", "reasoningTokens"]),
                        calls: 1,
                        cost_usd: 0.0,
                    })
                }
                other => panic!("unhandled tideEvent type {other}"),
            }
        })
        .collect()
}

fn step_end(norm: &[Norm]) -> &Norm {
    norm.iter()
        .find(|n| matches!(n, Norm::StepEnd(..)))
        .unwrap_or_else(|| panic!("no StepEnd in {norm:?}"))
}

fn fixture_stop_reason(fixture: &Value) -> EngineStopReason {
    let has_tool_call = fixture["tideEvents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["type"] == "tool_call");
    if has_tool_call {
        EngineStopReason::ToolUse
    } else {
        EngineStopReason::EndTurn
    }
}

/// Full replay against the mock server: request captured, stream events
/// match the fixture projection, StepEnd present, no error items.
fn assert_stream_matches_fixture(name: &str) {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (fixture, captured, events) = rt.block_on(replay(name));
    assert!(!captured.is_empty(), "{name}: no request captured");

    let norm = normalize_events(events);
    let want: Vec<Norm> = expected_events(&fixture);
    let streamed: Vec<Norm> = norm
        .iter()
        .take_while(|n| !matches!(n, Norm::StepEnd(..)))
        .cloned()
        .collect();
    assert_eq!(streamed, want, "{name}: stream events diverge");
    assert!(
        !norm.iter().any(|n| matches!(n, Norm::Error(_))),
        "{name}: unexpected error item: {:?}",
        norm.iter().find(|n| matches!(n, Norm::Error(_)))
    );

    match step_end(&norm) {
        Norm::StepEnd(reason, parts) => {
            assert_eq!(
                *reason,
                fixture_stop_reason(&fixture),
                "{name}: stop reason"
            );
            assert!(!parts.is_empty(), "{name}: StepEnd must aggregate content");
        }
        other => panic!("{name}: expected StepEnd, got {other:?}"),
    }
}

#[test]
fn anthropic_plain_text_stream_and_request() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (fixture, captured, _) = rt.block_on(replay("anthropic-plain-text"));
    let body = &captured[0].body;
    let want = &fixture["request"]["body"];
    assert_eq!(body["model"], want["model"]);
    assert_eq!(body["max_tokens"], want["max_tokens"]);
    assert_eq!(
        body.get("thinking"),
        None,
        "thinking must be absent when off"
    );
    assert_eq!(body["system"][0]["text"], want["system"][0]["text"]);
    assert_eq!(body["messages"], want["messages"]);
    assert_eq!(body["stream"], want["stream"]);
    assert!(
        captured[0].path.ends_with("/v1/messages"),
        "path: {}",
        captured[0].path
    );
    drop(fixture);
    assert_stream_matches_fixture("anthropic-plain-text");
}

#[test]
fn anthropic_thinking_budget_carves_not_stacks() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (fixture, captured, events) = rt.block_on(replay("anthropic-thinking-budget"));
    let body = &captured[0].body;
    let want = &fixture["request"]["body"];

    // Carve-not-stack: wire max_tokens stays the floored pool (16384: tools
    // present) with the budget carved inside it — never pool + budget.
    assert_eq!(body["max_tokens"], want["max_tokens"]);
    assert_eq!(body["max_tokens"], serde_json::json!(TOOL_OUTPUT_FLOOR));
    assert_eq!(body["thinking"], want["thinking"]);
    assert_eq!(body["thinking"]["budget_tokens"], serde_json::json!(6553));
    assert_eq!(body["cache_control"], want["cache_control"]);
    assert_eq!(
        body["tools"][0]["input_schema"], want["tools"][0]["input_schema"],
        "tool schema must round-trip the fixture wire schema"
    );
    assert_eq!(body["tool_choice"], want["tool_choice"]);

    let norm = normalize_events(events);
    assert_eq!(norm[..norm.len() - 1], expected_events(&fixture)[..]);

    // StepEnd aggregates thinking + text parts in emission order, with the
    // reasoning text taken from the fixture's own delta sequence.
    let expected_thinking: String = fixture["tideEvents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "reasoning")
        .map(|e| e["delta"].as_str().unwrap())
        .collect();
    match step_end(&norm) {
        Norm::StepEnd(reason, parts) => {
            assert_eq!(reason, &EngineStopReason::EndTurn);
            assert_eq!(parts.len(), 2);
            assert_eq!(
                parts[0],
                HistoryPart::Thinking {
                    text: expected_thinking
                }
            );
            assert!(
                matches!(&parts[1], HistoryPart::Text { text } if text.contains("local-time fixture"))
            );
        }
        other => panic!("expected StepEnd, got {other:?}"),
    }
}

#[test]
fn anthropic_tool_floor_and_streamed_input() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (fixture, captured, events) = rt.block_on(replay("anthropic-tool-call-streamed-input"));
    let body = &captured[0].body;
    let want = &fixture["request"]["body"];
    // Thinking off + tools: no thinking block, but the tool floor raises
    // max_tokens from the 8192 model max to 16384.
    assert_eq!(body["max_tokens"], serde_json::json!(TOOL_OUTPUT_FLOOR));
    assert_eq!(body["max_tokens"], want["max_tokens"]);
    assert_eq!(body.get("thinking"), None);
    assert_eq!(
        body["tools"][0]["input_schema"],
        want["tools"][0]["input_schema"]
    );
    assert_eq!(normalize_events(events)[..8], expected_events(&fixture)[..]);

    // StepEnd carries the provider tool-call id (wire replay) + parsed args.
    let norm = normalize_events(rt.block_on(replay("anthropic-tool-call-streamed-input")).2);
    match step_end(&norm) {
        Norm::StepEnd(reason, parts) => {
            assert_eq!(reason, &EngineStopReason::ToolUse);
            assert_eq!(
                parts[1],
                HistoryPart::ToolCall {
                    id: "toolu_mock_anthropic_01".to_owned(),
                    tool_name: "read_file".to_owned(),
                    arguments: serde_json::json!({ "path": "/tmp/example.txt" }),
                }
            );
        }
        other => panic!("expected StepEnd, got {other:?}"),
    }
}

#[test]
fn anthropic_non_native_host_strips_thinking() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (fixture, captured, _) = rt.block_on(replay("anthropic-non-native-thinking-strip"));
    let body = &captured[0].body;
    let want = &fixture["request"]["body"];
    // OpenRouter-style host: reasoning resolved but the thinking block (and
    // cache_control) never reach the wire; max_tokens still tool-floored.
    assert_eq!(
        body.get("thinking"),
        None,
        "thinking must be stripped off-allowlist"
    );
    assert_eq!(
        body.get("cache_control"),
        None,
        "cache_control must be stripped off-allowlist"
    );
    assert_eq!(body["max_tokens"], want["max_tokens"]);
    assert_eq!(body["max_tokens"], serde_json::json!(TOOL_OUTPUT_FLOOR));
    assert!(captured[0].path.ends_with("/v1/messages"));
    drop(fixture);
    assert_stream_matches_fixture("anthropic-non-native-thinking-strip");
}

#[test]
fn openai_plain_text_stream_and_request() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (fixture, captured, _) = rt.block_on(replay("openai-plain-text"));
    let body = &captured[0].body;
    let want = &fixture["request"]["body"];
    assert_eq!(body["model"], want["model"]);
    // rig modernizes the output-cap spelling for gpt-5+/o-series models
    // (`max_completion_tokens`); the fixture's TS SDK sent the legacy
    // `max_tokens`. Same quirk-computed value, wire spelling delegated to rig.
    let cap = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
        .expect("output cap present");
    assert_eq!(*cap, want["max_tokens"]);
    assert_eq!(body.get("reasoning_effort"), None);
    // rig serializes the preamble's system message as a text-part array
    // (legal chat-completions content form) where the TS SDK sent a plain
    // string — same text, same position, wire spelling delegated to rig.
    let got_system = &body["messages"][0];
    assert_eq!(got_system["role"], "system");
    let got_system_text = got_system["content"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            got_system["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_owned()
        });
    assert_eq!(got_system_text, want["messages"][0]["content"]);
    assert_eq!(body["messages"][1], want["messages"][1]);
    assert_eq!(body["stream"], want["stream"]);
    assert!(
        captured[0].path.ends_with("/chat/completions"),
        "path: {}",
        captured[0].path
    );
    drop(fixture);
    assert_stream_matches_fixture("openai-plain-text");
}

#[test]
fn openai_zai_thinking_derives_effort() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (fixture, captured, events) = rt.block_on(replay("openai-zai-thinking"));
    let body = &captured[0].body;
    let want = &fixture["request"]["body"];
    // Budget contract over the effort-only wire: lossily derived
    // reasoning_effort=low (6553 < 8000), max_tokens stays the 8192 pool
    // (no tools → no floor; reasoning spends inside the pool).
    assert_eq!(body["reasoning_effort"], serde_json::json!("low"));
    assert_eq!(body["reasoning_effort"], want["reasoning_effort"]);
    assert_eq!(body["max_tokens"], want["max_tokens"]);
    assert_eq!(body["max_tokens"], serde_json::json!(8192));

    let norm = normalize_events(events);
    // reasoning_content deltas split into reasoning vs text, and usage
    // separates reasoningTokens (384) from output (412).
    assert!(norm.iter().any(
        |n| matches!(n, Norm::Usage(u) if u.reasoning_tokens == 384 && u.output_tokens == 412)
    ));
    match step_end(&norm) {
        Norm::StepEnd(reason, parts) => {
            assert_eq!(reason, &EngineStopReason::EndTurn);
            assert_eq!(parts.len(), 2);
            assert!(
                matches!(&parts[0], HistoryPart::Thinking { text } if text.contains("timezone-dependent"))
            );
            assert!(
                matches!(&parts[1], HistoryPart::Text { text } if text.contains("local-time fixture"))
            );
        }
        other => panic!("expected StepEnd, got {other:?}"),
    }
    drop(fixture);
}

#[test]
fn openai_zai_tool_call_interleaves_content() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (fixture, captured, _) = rt.block_on(replay("openai-zai-tool-call"));
    let body = &captured[0].body;
    let want = &fixture["request"]["body"];
    assert_eq!(
        body["max_tokens"],
        serde_json::json!(TOOL_OUTPUT_FLOOR),
        "tool floor"
    );
    assert_eq!(body["max_tokens"], want["max_tokens"]);
    assert_eq!(body.get("reasoning_effort"), None, "thinking off");
    assert_eq!(
        body["tools"][0]["function"]["parameters"],
        want["tools"][0]["function"]["parameters"]
    );
    drop(fixture);
    assert_stream_matches_fixture("openai-zai-tool-call");
}

#[test]
fn openai_zai_malformed_tool_input_repairs_to_last_object() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (fixture, _, events) = rt.block_on(replay("openai-zai-malformed-tool-input"));
    let norm = normalize_events(events);
    let want = expected_events(&fixture);
    // Both duplicated fragments stream through, then the parsed call keeps
    // the LAST parseable object (the remend parity case — rig's own flush
    // recovers this shape; the engine's repair layer is the safety net when
    // it doesn't).
    let streamed: Vec<Norm> = norm
        .iter()
        .take_while(|n| !matches!(n, Norm::StepEnd(..)))
        .cloned()
        .collect();
    assert_eq!(streamed, want);
    match step_end(&norm) {
        Norm::StepEnd(reason, parts) => {
            assert_eq!(reason, &EngineStopReason::ToolUse);
            let (name, arguments) = parts
                .iter()
                .find_map(|p| match p {
                    HistoryPart::ToolCall {
                        tool_name,
                        arguments,
                        ..
                    } => Some((tool_name.clone(), arguments.clone())),
                    _ => None,
                })
                .expect("recovered tool call part");
            assert_eq!(name, "read_file");
            assert_eq!(arguments, serde_json::json!({ "path": "/tmp/example.txt" }));
        }
        other => panic!("expected StepEnd, got {other:?}"),
    }
}

#[test]
fn all_fixtures_replay_cleanly() {
    for name in [
        "anthropic-plain-text",
        "anthropic-thinking-budget",
        "anthropic-tool-call-streamed-input",
        "anthropic-non-native-thinking-strip",
        "openai-plain-text",
        "openai-zai-thinking",
        "openai-zai-tool-call",
        "openai-zai-malformed-tool-input",
    ] {
        assert_stream_matches_fixture(name);
    }
}

/// The engine's normalized history round-trips through rig into the wire
/// shape Tide's providers expect: thinking on the assistant, tool calls
/// paired with user-side tool results (output floor applied).
#[test]
fn history_to_rig_maps_parts() {
    use crate::history::HistoryPart;
    let big_output = "x".repeat(20000);
    let history = [
        HistoryMessage::system_text("sys"),
        HistoryMessage::user_text("hello"),
        HistoryMessage {
            role: HistoryRole::Assistant,
            parts: vec![
                HistoryPart::Thinking {
                    text: "ponder".to_owned(),
                },
                HistoryPart::Text {
                    text: "answer".to_owned(),
                },
                HistoryPart::ToolCall {
                    id: "toolu_1".to_owned(),
                    tool_name: "bash".to_owned(),
                    arguments: serde_json::json!({ "cmd": "ls" }),
                },
            ],
        },
        HistoryMessage {
            role: HistoryRole::User,
            parts: vec![HistoryPart::ToolResult {
                call_id: "toolu_1".to_owned(),
                tool_name: "bash".to_owned(),
                output: big_output,
            }],
        },
    ];
    let rig_messages: Vec<_> = history.iter().map(HistoryMessage::to_rig).collect();
    assert_eq!(rig_messages.len(), 4);
    let wire = serde_json::to_value(&rig_messages).unwrap();
    let rendered = wire.to_string();
    assert!(rendered.contains("ponder"), "thinking survives");
    assert!(rendered.contains("toolu_1"), "tool call id survives");
    assert!(
        rendered.contains("truncated at 16384 chars"),
        "output floor applied"
    );
    assert!(
        !rendered.contains(&"x".repeat(17000)),
        "oversized output clamped"
    );
}
