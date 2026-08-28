//! ask_followup_question — port of `app/core/agent/tools/ask-followup.ts`
//! (). Two envelopes share one body, exactly like the TS:
//! - `Tool::execute` = the legacy echo path (`runAskFollowup`): validates,
//!   normalizes, renders the question for model + UI — no parking.
//! - The live turn path (the TS Phase-3 SDK factory) is orchestrated: the
//!   app crate's turn loop intercepts the call, emits a `followup_required`
//!   AgentEvent, parks the turn on the hub's followup registry until the
//!   renderer answers via `chat_submit_followup` (or abort/end resolves
//!   null), then returns the pick as the tool result. The arg
//!   normalization + the GLM mis-split JSON repair live here so both
//!   envelopes stay drift-free.

use serde_json::{json, Value};

use crate::permission::RiskTier;
use crate::tools::{arg_bool, arg_str};
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

const DESCRIPTION: &str = "Ask the user a structured question when you need them to decide between concrete options. Use for approach selection, file-path choice, API-style decisions \u{2014} not for every response. The user picks one option (or types a custom answer) and the turn resumes. Use sparingly: for a simple missing detail, just ask in plain text.\n\nFORMAT REQUIREMENT \u{2014} options MUST be an array of objects with a `label` field:\n  options: [{ \"label\": \"Approach A\", \"description\": \"optional one-liner\" }, ...]\nPlain strings ([\"A\", \"B\"]) are REJECTED. Max 4 options.\n\nIMPORTANT: When you call this tool, DO NOT also write the question or options as text, Markdown, JSON blocks, or numbered lists. The tool call alone surfaces the popup \u{2014} emitting a duplicate as prose causes the user to see the question twice. Either call this tool (no prose) OR ask in plain text (no tool call) \u{2014} never both.\n\nStop emitting text after the tool call. The turn ends here; the user answers via the popup.";

#[derive(Debug, Clone, PartialEq)]
pub struct FollowupOption {
    pub label: String,
    pub description: Option<String>,
}

/// Normalized ask — what the parked path emits and awaits around.
#[derive(Debug, Clone, PartialEq)]
pub struct FollowupAsk {
    pub question: String,
    pub options: Vec<FollowupOption>,
    pub multiple: bool,
}

/// Port of the GLM mis-split repair: when `options` is absent but the
/// question string swallowed the rest of the args JSON, try re-parsing the
/// glued fragments back into shape.
fn repair_split_args(question: &mut String, options: &mut Option<Vec<FollowupOption>>, multiple: &mut bool) {
    let candidates: Vec<String> = if question.trim().starts_with('{') {
        vec![question.clone(), format!("{}}}", question)]
    } else {
        vec![format!("{{\"question\": \"{}}}", question)]
    };
    for candidate in candidates {
        if let Ok(parsed) = serde_json::from_str::<Value>(&candidate) {
            if let Some(raw) = parsed.get("options").and_then(Value::as_array) {
                let repaired = raw
                    .iter()
                    .map(|o| FollowupOption {
                        label: o.get("label").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        description: o
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    })
                    .collect::<Vec<_>>();
                if let Some(q) = parsed.get("question").and_then(Value::as_str) {
                    *question = q.to_owned();
                }
                if let Some(m) = parsed.get("multiple").and_then(Value::as_bool) {
                    *multiple = m;
                }
                *options = Some(repaired);
                return;
            }
        }
    }
}

/// Normalize raw tool args into a [`FollowupAsk`] — the forgiving TS
/// coercion: plain-string options wrap into `{label}`, object options read
/// `label`/`value`/`text` + optional `description`. `None` when the
/// question is missing.
pub fn normalize_followup_args(args: &Value) -> Option<FollowupAsk> {
    let mut question = arg_str(args, "question");
    if question.is_empty() {
        return None;
    }
    let mut options = args.get("options").and_then(Value::as_array).map(|raw| {
        raw.iter()
            .map(|o| {
                if let Some(label) = o.as_str() {
                    FollowupOption {
                        label: label.to_owned(),
                        description: None,
                    }
                } else if let Some(obj) = o.as_object() {
                    let label = ["label", "value", "text"]
                        .iter()
                        .find_map(|k| obj.get(*k).and_then(Value::as_str))
                        .unwrap_or_default()
                        .to_owned();
                    let description = obj
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    FollowupOption { label, description }
                } else {
                    FollowupOption {
                        label: o.to_string(),
                        description: None,
                    }
                }
            })
            .collect::<Vec<_>>()
    });
    let mut multiple = arg_bool(args, "multiple");
    if options.as_ref().is_none_or(Vec::is_empty) && question.contains("\"options\"") {
        repair_split_args(&mut question, &mut options, &mut multiple);
    }
    Some(FollowupAsk {
        question,
        options: options.unwrap_or_default(),
        multiple,
    })
}

/// Render the question for model + UI (`**Q**` + numbered options).
pub fn render_followup_text(ask: &FollowupAsk) -> String {
    let option_text = if ask.options.is_empty() {
        String::new()
    } else {
        let lines: Vec<String> = ask.options.iter().enumerate().map(|(i, o)| {
            let desc = o
                .description
                .as_deref()
                .map(|d| format!(" \u{2014} {d}"))
                .unwrap_or_default();
            format!("{}. {}{}", i + 1, o.label, desc)
        }).collect();
        format!("\n\n{}", lines.join("\n"))
    };
    format!("**{}**{}", ask.question, option_text)
}

/// The echo body — validates and renders without parking. The outcome the
/// parked path produces on a MISSING question mirrors this failure.
pub fn run_ask_followup(ask: &FollowupAsk) -> ToolOutcome {
    if ask.options.len() > 4 {
        return ToolOutcome::failed(format!(
            "Too many options ({}). Max 4 \u{2014} narrow it down.",
            ask.options.len()
        ));
    }
    let meta = if ask.options.is_empty() {
        "open-ended".to_owned()
    } else {
        format!("{} options", ask.options.len())
    };
    ToolOutcome::executed(
        "Question surfaced to the user. Stop here and wait for their answer \u{2014} do not proceed with an assumption.",
    )
    .with_meta(meta)
    .with_display(crate::ToolDisplay::Text {
        text: render_followup_text(ask),
    })
}

/// The parked path's outcome once the user answered (None = dismissed /
/// aborted / timed out).
pub fn followup_pick_outcome(answer: Option<&str>) -> ToolOutcome {
    match answer {
        Some(answer) => ToolOutcome::executed(format!("User picked: {answer}")).with_display(
            crate::ToolDisplay::Text {
                text: format!("**{answer}**"),
            },
        ),
        None => ToolOutcome::rejected("User did not answer the question.").with_display(
            crate::ToolDisplay::Text {
                text: "_(no answer)_".to_owned(),
            },
        ),
    }
}

pub struct AskFollowupTool;

impl Tool for AskFollowupTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "ask_followup_question".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question to ask."
                    },
                    "options": {
                        "type": "array",
                        "description": "Concrete options the user can pick from. Max 4. Each item MUST be an object with at least a `label` field — plain strings are rejected.",
                        "minItems": 1,
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {
                                    "type": "string",
                                    "description": "Short option label (one line)."
                                },
                                "description": {
                                    "type": "string",
                                    "description": "Optional one-line context for this option."
                                }
                            },
                            "required": ["label"]
                        }
                    },
                    "multiple": {
                        "type": "boolean",
                        "description": "True if the user can pick multiple options. Default false (single-select)."
                    }
                },
                "required": ["question"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        _ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        let Some(ask) = normalize_followup_args(&args) else {
            return Ok(ToolOutcome::failed("Missing required arg: question"));
        };
        Ok(run_ask_followup(&ask))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;

    #[test]
    fn echo_path_validates_and_renders() {
        let ask = normalize_followup_args(&json!({
            "question": "Which DB?",
            "options": [
                { "label": "SQLite", "description": "local" },
                { "label": "Postgres" }
            ]
        }))
        .unwrap();
        let out = run_ask_followup(&ask);
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(out.meta.as_deref(), Some("2 options"));
        let crate::ToolDisplay::Text { text } = out.display.unwrap() else {
            panic!("text display");
        };
        assert_eq!(
            text,
            "**Which DB?**\n\n1. SQLite \u{2014} local\n2. Postgres"
        );

        let open = normalize_followup_args(&json!({ "question": "Why?" })).unwrap();
        let out = run_ask_followup(&open);
        assert_eq!(out.meta.as_deref(), Some("open-ended"));
    }

    #[test]
    fn more_than_four_options_fail() {
        let ask = normalize_followup_args(&json!({
            "question": "Q",
            "options": [
                { "label": "1" }, { "label": "2" }, { "label": "3" }, { "label": "4" }, { "label": "5" }
            ]
        }))
        .unwrap();
        let out = run_ask_followup(&ask);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Too many options (5). Max 4 \u{2014} narrow it down.");
    }

    #[test]
    fn missing_question_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let out = AskFollowupTool
            .execute(&ToolContext::new(tmp.path()), json!({ "options": [] }))
            .unwrap();
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Missing required arg: question");
    }

    #[test]
    fn plain_string_options_wrap_with_label() {
        let ask = normalize_followup_args(
            &json!({ "question": "Q", "options": ["A", "B"], "multiple": true }),
        )
        .unwrap();
        assert!(ask.multiple);
        assert_eq!(
            ask.options,
            vec![
                FollowupOption { label: "A".into(), description: None },
                FollowupOption { label: "B".into(), description: None },
            ]
        );
    }

    #[test]
    fn object_options_fall_back_to_value_then_text() {
        let ask = normalize_followup_args(&json!({
            "question": "Q",
            "options": [{ "value": "v" }, { "text": "t" }, {}]
        }))
        .unwrap();
        assert_eq!(ask.options[0].label, "v");
        assert_eq!(ask.options[1].label, "t");
        assert_eq!(ask.options[2].label, "");
    }

    /// The GLM mis-split: everything after `{"question": "` lands inside the
    /// question string — repair recovers the options.
    #[test]
    fn mis_split_json_question_gets_repaired() {
        // Object-shaped glue missing its closing brace: `question + '}'`
        // parses and carries the options.
        let glued = "{\"question\": \"Which?\", \"options\": [{\"label\": \"A\"}]";
        let ask = normalize_followup_args(&json!({ "question": glued })).unwrap();
        assert_eq!(ask.question, "Which?");
        assert_eq!(ask.options.len(), 1);
        assert_eq!(ask.options[0].label, "A");

        // Already-balanced glue parses directly.
        let balanced = "{\"question\": \"Q2\", \"options\": [{\"label\": \"B\"}], \"multiple\": true}";
        let ask = normalize_followup_args(&json!({ "question": balanced })).unwrap();
        assert_eq!(ask.question, "Q2");
        assert_eq!(ask.options[0].label, "B");
        assert!(ask.multiple);

        // Glue without an options array stays verbatim (no false repair).
        let plain = "just a question mentioning \"options\" in prose";
        let ask = normalize_followup_args(&json!({ "question": plain })).unwrap();
        assert_eq!(ask.question, plain);
        assert!(ask.options.is_empty());
    }

    #[test]
    fn pick_outcomes_match_the_ts_shapes() {
        let answered = followup_pick_outcome(Some("Approach A"));
        assert_eq!(answered.status, OutcomeStatus::Executed);
        assert_eq!(answered.output, "User picked: Approach A");
        let crate::ToolDisplay::Text { text } = answered.display.unwrap() else {
            panic!("text display");
        };
        assert_eq!(text, "**Approach A**");

        let none = followup_pick_outcome(None);
        assert_eq!(none.status, OutcomeStatus::Rejected);
        assert_eq!(none.output, "User did not answer the question.");
        let crate::ToolDisplay::Text { text } = none.display.unwrap() else {
            panic!("text display");
        };
        assert_eq!(text, "_(no answer)_");
    }

    #[test]
    fn spec_and_tier_match_the_sidecar() {
        let tool = AskFollowupTool;
        assert_eq!(tool.spec().name, "ask_followup_question");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
    }
}
