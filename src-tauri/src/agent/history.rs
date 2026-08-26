//! sessions-v2 parts (reader wire) → engine [`HistoryMessage`]s — the T4
//! mapping the engine's `history` module docs specify:
//! - `text` part → [`HistoryPart::Text`]
//! - `thinking` part → [`HistoryPart::Thinking`]
//! - stored `tool` part (`{toolName, input, output, status, durationMs}`) →
//!   an assistant-side [`HistoryPart::ToolCall`] followed, once results are
//!   known, by a user-side [`HistoryPart::ToolResult`] — the split the wire
//!   protocols require (assistant tool_use blocks / user tool_result blocks).
//!   Tool-call ids: the stored part id on both sides of the split, so a
//!   replayed request stays internally consistent even for Anthropic's
//!   id-matching replay rule.
//!
//! Empty messages (no mappable parts — e.g. a user message whose part hasn't
//! committed yet) are skipped, matching the TS `toCoreMessage` null filter.

use tide_engine::{HistoryMessage, HistoryPart, HistoryRole};
use tide_store::sessions_v2::{SessionMessageV2, SessionPartV2};

pub fn history_from_messages(messages: &[SessionMessageV2]) -> Vec<HistoryMessage> {
    let mut out = Vec::new();
    for message in messages {
        match message.role.as_str() {
            "user" => {
                let parts = message
                    .parts
                    .iter()
                    .filter_map(user_part)
                    .collect::<Vec<_>>();
                if !parts.is_empty() {
                    out.push(HistoryMessage {
                        role: HistoryRole::User,
                        parts,
                    });
                }
            }
            "assistant" => {
                let mut parts = Vec::new();
                let mut results = Vec::new();
                for part in &message.parts {
                    match part.kind.as_str() {
                        "text" => {
                            if let Some(text) = part_text(part) {
                                parts.push(HistoryPart::Text { text });
                            }
                        }
                        "thinking" => {
                            if let Some(text) = part_text(part) {
                                parts.push(HistoryPart::Thinking { text });
                            }
                        }
                        "tool" => {
                            if let Some((call, result)) = tool_part(part) {
                                parts.push(call);
                                results.push(result);
                            }
                        }
                        _ => {}
                    }
                }
                if !parts.is_empty() {
                    out.push(HistoryMessage {
                        role: HistoryRole::Assistant,
                        parts,
                    });
                }
                if !results.is_empty() {
                    out.push(HistoryMessage {
                        role: HistoryRole::User,
                        parts: results,
                    });
                }
            }
            "system" => {
                let joined = message
                    .parts
                    .iter()
                    .filter(|p| p.kind == "text")
                    .filter_map(part_text)
                    .collect::<Vec<_>>()
                    .join("\n");
                if !joined.is_empty() {
                    out.push(HistoryMessage {
                        role: HistoryRole::System,
                        parts: vec![HistoryPart::Text { text: joined }],
                    });
                }
            }
            _ => {}
        }
    }
    out
}

fn part_text(part: &SessionPartV2) -> Option<String> {
    let text = part
        .data
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_owned();
    Some(text).filter(|t| !t.is_empty())
}

fn user_part(part: &SessionPartV2) -> Option<HistoryPart> {
    match part.kind.as_str() {
        "text" => part_text(part).map(|text| HistoryPart::Text { text }),
        // Defensive: tool results are stored on the assistant message's
        // parts, but a user-side tool part (if one ever lands) is still a
        // result answer, not a call.
        "tool" => tool_part(part).map(|(_, result)| result),
        _ => None,
    }
}

fn tool_part(part: &SessionPartV2) -> Option<(HistoryPart, HistoryPart)> {
    let tool_name = part.data.get("toolName")?.as_str()?.to_owned();
    let input = part.data.get("input").cloned().unwrap_or_else(|| serde_json::json!({}));
    let output = part
        .data
        .get("output")
        .and_then(|o| o.as_str())
        .unwrap_or_default()
        .to_owned();
    let call = HistoryPart::ToolCall {
        id: part.id.clone(),
        tool_name: tool_name.clone(),
        arguments: input,
    };
    let result = HistoryPart::ToolResult {
        call_id: part.id.clone(),
        tool_name,
        output,
    };
    Some((call, result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tide_store::sessions_v2::SessionPartV2;

    fn msg(role: &str, parts: Vec<SessionPartV2>) -> SessionMessageV2 {
        SessionMessageV2 {
            id: format!("m_{role}"),
            role: role.to_owned(),
            model: None,
            time_created: 0,
            time_completed: None,
            parts,
        }
    }

    fn part(id: &str, seq: i64, kind: &str, data: serde_json::Value) -> SessionPartV2 {
        SessionPartV2 {
            id: id.to_owned(),
            seq,
            kind: kind.to_owned(),
            data,
        }
    }

    #[test]
    fn text_and_thinking_map_directly() {
        let history = history_from_messages(&[
            msg(
                "user",
                vec![part("p_1", 0, "text", json!({ "text": "hello" }))],
            ),
            msg(
                "assistant",
                vec![
                    part("p_2", 0, "thinking", json!({ "text": "hm" })),
                    part("p_3", 1, "text", json!({ "text": "hi back" })),
                ],
            ),
        ]);
        assert_eq!(
            history,
            vec![
                HistoryMessage::user_text("hello"),
                HistoryMessage {
                    role: HistoryRole::Assistant,
                    parts: vec![
                        HistoryPart::Thinking { text: "hm".into() },
                        HistoryPart::Text { text: "hi back".into() },
                    ],
                },
            ]
        );
    }

    #[test]
    fn tool_part_splits_into_assistant_call_plus_user_result() {
        let history = history_from_messages(&[msg(
            "assistant",
            vec![
                part("p_1", 0, "text", json!({ "text": "checking" })),
                part(
                    "p_2",
                    1,
                    "tool",
                    json!({
                        "toolName": "bash",
                        "input": { "command": "ls" },
                        "output": "x\n",
                        "status": "executed",
                        "durationMs": 5,
                    }),
                ),
                part("p_3", 2, "text", json!({ "text": "done" })),
            ],
        )]);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].role, HistoryRole::Assistant);
        assert_eq!(history[0].parts.len(), 3, "text + call + text");
        assert_eq!(
            history[0].parts[1],
            HistoryPart::ToolCall {
                id: "p_2".into(),
                tool_name: "bash".into(),
                arguments: json!({ "command": "ls" }),
            }
        );
        assert_eq!(history[1].role, HistoryRole::User);
        assert_eq!(
            history[1].parts[0],
            HistoryPart::ToolResult {
                call_id: "p_2".into(),
                tool_name: "bash".into(),
                output: "x\n".into(),
            }
        );
    }

    #[test]
    fn empty_and_unknown_kinds_are_skipped() {
        assert!(history_from_messages(&[msg("user", vec![])]).is_empty());
        assert!(history_from_messages(&[msg(
            "assistant",
            vec![part("p_1", 0, "future-kind", json!({}))]
        )])
        .is_empty());
    }

    #[test]
    fn system_parts_join_into_one_message() {
        let history = history_from_messages(&[msg(
            "system",
            vec![
                part("p_1", 0, "text", json!({ "text": "a" })),
                part("p_2", 1, "text", json!({ "text": "b" })),
            ],
        )]);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].role, HistoryRole::System);
        assert_eq!(history[0].parts.len(), 1);
    }
}
