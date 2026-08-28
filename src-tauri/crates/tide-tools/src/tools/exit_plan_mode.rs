//! exit_plan_mode — port of `app/core/agent/tools/exit-plan-mode.ts`
//! (). The TS presentation: the plan rides the tool result's text
//! display; the output tells the model a human decision is pending. The
//! TS left the IPC approval flow "to be wired later" — here the app
//! crate's turn loop intercepts plan-mode calls and presents the plan via
//! the permission hub's ask/escalation machinery (approve + `new_mode`
//! escalates the turn out of plan mode); `Tool::execute` is the bare TS
//! body for non-turn callers.

use serde_json::json;

use crate::permission::RiskTier;
use crate::tools::arg_str;
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

const DESCRIPTION: &str = "Signal that planning is complete. Use ONLY when autonomyMode is \"plan\" (read-only) and you have produced a concrete, actionable plan. Present the plan as the `plan` argument. The user reviews it and decides whether to proceed. Do not call this in other modes \u{2014} it's a no-op there.";

pub fn run_exit_plan_mode(plan: &str) -> ToolOutcome {
    if plan.is_empty() {
        return ToolOutcome::failed("Missing required arg: plan");
    }
    ToolOutcome::executed(
        "Plan submitted. Waiting for user approval \u{2014} if approved, switch to a write-enabled mode and proceed.",
    )
    .with_meta("plan ready")
    .with_display(crate::ToolDisplay::Text { text: plan.to_owned() })
}

pub struct ExitPlanModeTool;

impl Tool for ExitPlanModeTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "exit_plan_mode".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "plan": {
                        "type": "string",
                        "description": "The complete plan in markdown. Include the steps, files affected, and risks."
                    }
                },
                "required": ["plan"]
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
        Ok(run_exit_plan_mode(&arg_str(&args, "plan")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;

    #[test]
    fn presentation_matches_the_ts_shape() {
        let out = run_exit_plan_mode("1. Do it");
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(
            out.output,
            "Plan submitted. Waiting for user approval \u{2014} if approved, switch to a write-enabled mode and proceed."
        );
        assert_eq!(out.meta.as_deref(), Some("plan ready"));
        let crate::ToolDisplay::Text { text } = out.display.unwrap() else {
            panic!("text display");
        };
        assert_eq!(text, "1. Do it");
    }

    #[test]
    fn empty_plan_fails() {
        let out = run_exit_plan_mode("");
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Missing required arg: plan");
    }

    #[test]
    fn spec_and_tier_match_the_sidecar() {
        let tool = ExitPlanModeTool;
        assert_eq!(tool.spec().name, "exit_plan_mode");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
    }
}
