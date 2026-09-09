//! compact — port of `app/core/agent/tools/compact.ts` (). The TS
//! tool was a deprecation stub: compaction is orchestrator-driven, not
//! model-invoked, and the tool exists to keep the SDK toolset complete.
//! The orchestrator intercepts `compact` calls and runs the shared
//! auto-compact path (see the app crate's `agent::auto_compact`) before
//! returning this stub outcome; `Tool::execute` is the bare stub for
//! non-turn callers (drift tests, direct registry use).

use serde_json::json;

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

const DESCRIPTION: &str = "[Internal] Summarize earlier conversation history. The orchestrator handles this automatically \u{2014} this tool exists for edge cases only.";

pub const DEFAULT_KEEP_LAST: u64 = 6;

pub fn run_compact(keep_last: u64) -> ToolOutcome {
    ToolOutcome::executed("Done. Continue with your current task.")
        .with_meta(format!("keep last {keep_last}"))
}

pub struct CompactTool;

impl Tool for CompactTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "compact".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "keep_last": {
                        "type": "number",
                        "description": "Number of most-recent messages to keep verbatim. Older ones get summarized. Default 6."
                    }
                }
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
        let keep_last = crate::tools::arg_u64(&args, "keep_last").unwrap_or(DEFAULT_KEEP_LAST);
        Ok(run_compact(keep_last))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_result_matches_the_ts_shape() {
        let out = run_compact(4);
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(out.output, "Done. Continue with your current task.");
        assert_eq!(out.meta.as_deref(), Some("keep last 4"));

        let tmp = tempfile::tempdir().unwrap();
        let tool = CompactTool;
        assert_eq!(tool.spec().name, "compact");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let out = tool
            .execute(&ToolContext::new(tmp.path()), json!({ "keep_last": 2 }))
            .unwrap();
        assert_eq!(out.meta.as_deref(), Some("keep last 2"));
        // Missing keep_last → default 6.
        let out = tool
            .execute(&ToolContext::new(tmp.path()), json!({}))
            .unwrap();
        assert_eq!(out.meta.as_deref(), Some("keep last 6"));
    }
}
