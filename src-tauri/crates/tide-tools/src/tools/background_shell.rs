//! bash_output + kill_shell — ports of the tool envelopes in
//! `app/core/agent/tools/background-shell.ts` (91ec558). Neither reads the
//! workspace: both address the process-wide
//! [`ShellRegistry`](crate::shell_registry) by shell id (the bash tool
//! registers shells there when spawned with `background:true`).

use serde_json::json;

use crate::permission::RiskTier;
use crate::shell_registry::{global_shell_registry, ShellRegistry, MAX_BUFFER};
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

const BASH_OUTPUT_DESCRIPTION: &str = "Read new output from a backgrounded bash shell since the last read. Use after starting a long-running command (e.g. a dev server) via bash with background:true. Returns the incremental stdout+stderr. The shell keeps running; call kill_shell to stop it.";

const KILL_SHELL_DESCRIPTION: &str = "Kill a backgrounded bash shell by id. Use when a long-running command (dev server, watcher, etc.) is no longer needed. Sends SIGTERM.";

pub struct BashOutputTool;

pub struct KillShellTool;

pub(crate) fn run_bash_output(shell_id: &str) -> ToolOutcome {
    if shell_id.is_empty() {
        return ToolOutcome::failed("Missing required arg: shell_id");
    }
    let Some((new_output, status)) = global_shell_registry().read_new(shell_id) else {
        return ToolOutcome::failed(format!(
            "Unknown shell_id: {shell_id}. It may have been killed or never started."
        ));
    };
    let byte_len = new_output.len();
    let trimmed = if new_output.len() > MAX_BUFFER {
        // Unreachable while the ring buffer caps at MAX_BUFFER (the TS kept
        // the branch for the same reason) — ported for parity.
        format!(
            "{}\n[…output truncated at {MAX_BUFFER} bytes]",
            &new_output[new_output.len() - MAX_BUFFER..]
        )
    } else {
        new_output
    };
    let status_line = if status.exited {
        // TS printed `code null` for signal deaths.
        let code = status
            .exit_code
            .map(|c| c.to_string())
            .unwrap_or_else(|| "null".to_string());
        format!("exited (code {code})")
    } else {
        "running".to_string()
    };
    let output = if trimmed.is_empty() {
        "(no new output)".to_string()
    } else {
        trimmed
    };
    ToolOutcome::executed(output).with_meta(format!("{status_line} · {byte_len} bytes"))
}

pub(crate) fn run_kill_shell(shell_id: &str) -> ToolOutcome {
    if shell_id.is_empty() {
        return ToolOutcome::failed("Missing required arg: shell_id");
    }
    if !global_shell_registry().kill(shell_id) {
        return ToolOutcome::failed(format!(
            "Unknown shell_id: {shell_id}. Nothing to kill."
        ));
    }
    ToolOutcome::executed(format!("Killed shell {shell_id}.")).with_meta("killed")
}

/// Spawn into a caller-provided registry (the bash tool's background path;
/// tests pass their own registry).
pub(crate) fn spawn_backgrounded(
    registry: &ShellRegistry,
    command: &str,
    cwd: &std::path::Path,
    abort: &crate::AbortFlag,
) -> std::io::Result<String> {
    let id = crate::shell_registry::next_shell_id();
    registry.spawn(&id, command, cwd, abort)?;
    Ok(id)
}

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

    fn execute(&self, _ctx: &ToolContext, args: serde_json::Value) -> Result<ToolOutcome, ToolError> {
        Ok(run_bash_output(&arg_str(&args, "shell_id")))
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

    fn execute(&self, _ctx: &ToolContext, args: serde_json::Value) -> Result<ToolOutcome, ToolError> {
        Ok(run_kill_shell(&arg_str(&args, "shell_id")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;
    use std::time::{Duration, Instant};

    fn wait_for_output(registry: &ShellRegistry, id: &str, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some((out, _)) = registry.read_new(id) {
                if out.contains(needle) {
                    return out;
                }
            }
            if Instant::now() > deadline {
                panic!("no output containing {needle:?} within 10s");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The tools address the process-wide registry; drive one end-to-end:
    /// spawn (as the bash tool would) → bash_output reads → kill_shell stops.
    #[test]
    fn background_flow_spawn_read_kill() {
        let registry = global_shell_registry();
        let tmp = tempfile::tempdir().unwrap();
        let id = spawn_backgrounded(
            registry,
            "echo server-up; sleep 10",
            tmp.path(),
            &crate::AbortFlag::new(),
        )
        .unwrap();
        assert!(id.starts_with("sh_"));

        wait_for_output(registry, &id, "server-up");

        let out = run_bash_output(&id);
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(out.output, "(no new output)");
        assert!(out.meta.as_deref().unwrap().starts_with("running · "));

        let out = run_kill_shell(&id);
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(out.output, format!("Killed shell {id}."));
        assert_eq!(out.meta.as_deref(), Some("killed"));

        let out = run_bash_output(&id);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(
            out.output,
            format!("Unknown shell_id: {id}. It may have been killed or never started.")
        );
    }

    #[test]
    fn exited_shell_reports_exit_code() {
        let registry = global_shell_registry();
        let tmp = tempfile::tempdir().unwrap();
        let id = spawn_backgrounded(
            registry,
            "echo done; exit 4",
            tmp.path(),
            &crate::AbortFlag::new(),
        )
        .unwrap();
        // Drain output until the process is gone.
        let mut seen = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some((out, s)) = registry.read_new(&id) {
                seen.push_str(&out);
                if s.exited {
                    break;
                }
            }
            assert!(Instant::now() < deadline, "shell never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(seen.contains("done"));
        let out = run_bash_output(&id);
        assert_eq!(out.output, "(no new output)");
        assert_eq!(out.meta.as_deref(), Some("exited (code 4) · 0 bytes"));
    }

    #[test]
    fn missing_and_unknown_ids_fail() {
        let out = run_bash_output("");
        assert_eq!(out.output, "Missing required arg: shell_id");
        let out = run_kill_shell("");
        assert_eq!(out.output, "Missing required arg: shell_id");
        let out = run_bash_output("sh_nope");
        assert!(out.output.starts_with("Unknown shell_id: sh_nope."));
        let out = run_kill_shell("sh_nope");
        assert_eq!(out.output, "Unknown shell_id: sh_nope. Nothing to kill.");
    }

    #[test]
    fn traits_expose_specs_and_tiers() {
        let bash_output = BashOutputTool;
        assert_eq!(bash_output.spec().name, "bash_output");
        assert_eq!(bash_output.risk_tier(), RiskTier::ReadOnly);
        let kill_shell = KillShellTool;
        assert_eq!(kill_shell.spec().name, "kill_shell");
        assert_eq!(kill_shell.risk_tier(), RiskTier::Write);
        let out = bash_output
            .execute(
                &ToolContext::new(std::path::PathBuf::from("/tmp")),
                json!({ "shell_id": "" }),
            )
            .unwrap();
        assert_eq!(out.status, OutcomeStatus::Failed);
    }
}
