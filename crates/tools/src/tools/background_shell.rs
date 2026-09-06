//! bash_output + kill_shell — deprecation aliases. The registry behind
//! them (and the `sh_*` ids it minted) was retired: `bash background:true`
//! now starts a job in the session-scoped background-job registry
//! ([`crate::jobs`]) and returns a `bash-N` job id. Both envelopes
//! therefore forward verbatim to the job tools — the `shell_id` argument
//! is read as the job id — so old model habits keep working against the
//! new registry. The schemas/descriptions stay as shipped (the engine
//! fixture pins them); new callers should use `job_output` / `job_kill`.

use serde_json::json;

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;
use super::job_tools::{run_job_kill, run_job_output};

const BASH_OUTPUT_DESCRIPTION: &str = "Read new output from a backgrounded bash shell since the last read. Use after starting a long-running command (e.g. a dev server) via bash with background:true. Returns the incremental stdout+stderr. The shell keeps running; call kill_shell to stop it.";

const KILL_SHELL_DESCRIPTION: &str = "Kill a backgrounded bash shell by id. Use when a long-running command (dev server, watcher, etc.) is no longer needed. Sends SIGTERM.";

pub struct BashOutputTool;

pub struct KillShellTool;

impl Tool for BashOutputTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "bash_output".into(),
            description: BASH_OUTPUT_DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "shell_id": {
                        "type": "string",
                        "description": "The background shell id returned by bash."
                    }
                },
                "required": ["shell_id"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        Ok(run_job_output(&ctx.session_id, &arg_str(&args, "shell_id")))
    }
}

impl Tool for KillShellTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "kill_shell".into(),
            description: KILL_SHELL_DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "shell_id": {
                        "type": "string",
                        "description": "The background shell id to kill."
                    }
                },
                "required": ["shell_id"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        Ok(run_job_kill(&ctx.session_id, &arg_str(&args, "shell_id")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;
    use std::time::{Duration, Instant};

    fn session(tag: &str) -> String {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        format!(
            "bash-alias-{}-{}",
            tag,
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        )
    }

    fn ctx_for(session_id: &str) -> ToolContext {
        let mut ctx = ToolContext::new(std::env::temp_dir());
        ctx.session_id = session_id.to_string();
        ctx
    }

    /// Start one real background job the way the bash tool does and pull
    /// the minted id out of the ack.
    fn start_background(session_id: &str, command: &str) -> String {
        // Stable scratch cwd — the process outlives this function.
        let out = super::super::bash::run_bash(
            command,
            std::path::Path::new(&std::env::temp_dir()),
            30_000,
            true,
            &crate::AbortFlag::new(),
            session_id,
        );
        assert_eq!(out.status, OutcomeStatus::Executed, "{}", out.output);
        out.output
            .trim_start_matches("started background job ")
            .split('.')
            .next()
            .unwrap()
            .to_string()
    }

    /// The alias flow end-to-end: bash background:true → bash_output reads
    /// the job's delta → kill_shell stops the job.
    #[test]
    fn aliases_forward_to_the_job_registry() {
        let session = session("forward");
        let id = start_background(&session, "echo alias-live; sleep 30");

        let ctx = ctx_for(&session);
        // Cursor reads are incremental: poll until the first delta lands.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = String::new();
        loop {
            let out = BashOutputTool
                .execute(&ctx, json!({ "shell_id": id }))
                .unwrap();
            seen.push_str(&out.output);
            if seen.contains("alias-live") {
                assert_eq!(out.status, OutcomeStatus::Executed);
                assert!(out.meta.as_deref().unwrap().contains("running"), "{:?}", out.meta);
                break;
            }
            assert!(Instant::now() < deadline, "output never arrived: {seen:?}");
            std::thread::sleep(Duration::from_millis(10));
        }

        let out = KillShellTool.execute(&ctx, json!({ "shell_id": id })).unwrap();
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(
            out.output.contains(&format!("Stopping background job {id}")),
            "{}",
            out.output
        );

        // The stop settles the underlying job as `Stopped`.
        let registry = crate::jobs::global_job_registry();
        let key = protocol::model::BackgroundWorkKey::new(
            protocol::model::BackgroundWorkKind::Process,
            &id,
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let settled = registry
                .list_session(&session)
                .into_iter()
                .find(|item| item.key == key)
                .unwrap();
            if !settled.status.is_live() {
                assert_eq!(
                    settled.status,
                    protocol::model::BackgroundWorkStatus::Stopped
                );
                break;
            }
            assert!(Instant::now() < deadline, "job never settled");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn alias_specs_and_tiers_are_unchanged() {
        let bash_output = BashOutputTool;
        assert_eq!(bash_output.spec().name, "bash_output");
        assert_eq!(bash_output.risk_tier(), RiskTier::ReadOnly);
        let kill_shell = KillShellTool;
        assert_eq!(kill_shell.spec().name, "kill_shell");
        assert_eq!(kill_shell.risk_tier(), RiskTier::Write);
    }

    #[test]
    fn alias_errors_mirror_the_job_copy() {
        let session = session("errors");
        let ctx = ctx_for(&session);
        let out = BashOutputTool.execute(&ctx, json!({ "shell_id": "" })).unwrap();
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Missing required arg: job_id");
        let out = KillShellTool.execute(&ctx, json!({ "shell_id": "" })).unwrap();
        assert_eq!(out.output, "Missing required arg: job_id");
        // A stale `sh_` id — the retired registry's id shape — reports the
        // job tools' unknown-id copy.
        let out = BashOutputTool
            .execute(&ctx, json!({ "shell_id": "sh_nope" }))
            .unwrap();
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(
            out.output.starts_with("Unknown job id: sh_nope."),
            "{}",
            out.output
        );
        let out = KillShellTool
            .execute(&ctx, json!({ "shell_id": "sh_nope" }))
            .unwrap();
        assert!(out.output.starts_with("Unknown job id: sh_nope."));
    }
}
