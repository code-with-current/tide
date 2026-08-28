//! bash — port of `app/core/agent/tools/bash.ts` (). Shell execution
//! in the workspace root via `/bin/sh -c` (cmd.exe on Windows), bounded by
//! a hard blocklist for catastrophic patterns, output caps (50 KB per
//! stream / 1000 lines), a wall-clock timeout with an early-kill heuristic
//! for silent commands, and turn-abort support. `background:true` spawns
//! through the [`ShellRegistry`](crate::shell_registry) instead — the call
//! returns a shell id immediately and the model polls via bash_output /
//! kill_shell. The permission gate (destructive tier) runs BEFORE execute
//! in the orchestrator.

use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use regex::{Regex, RegexBuilder};
use serde_json::json;

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_bool;
use super::arg_str;
use super::proc::{kill_and_reap, spawn_reader, tool_env, unix_process_group, StreamReader};

pub(crate) const MAX_OUTPUT: usize = 50 * 1024;
pub(crate) const MAX_LINES: usize = 1000;
pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 500_000;

const DESCRIPTION: &str = "Run a shell command in the workspace root. Supports the full shell: pipes (|), redirects (> >> 2>&1), chaining (&& ||), and any binary on PATH. Use for builds, tests, linters, installs, git operations, and ad-hoc inspection. Output is capped at 50KB / 1000 lines. Avoid destructive system commands — they are blocked. Prefer the dedicated tools (read_file, grep, glob) when they fit; use bash when they do not. For long-running commands (dev servers, watchers), set background:true to spawn in the background — the command returns immediately with a shell_id; poll output via bash_output, stop via kill_shell.";

pub struct BashTool;

/// Hard blocklist: catastrophic/irreversible patterns (rm -rf /, sudo, fork
/// bombs, etc.), matched case-insensitively against the raw command.
/// Escaped for the Rust regex dialect (JS `\/` → `/`; `&` is literal).
const BLOCKED_PATTERN_SRC: &[&str] = &[
    r"\brm\s+(-[a-z]*r[a-z]*f?|--recursive)\s+([-~./]|/(?:usr|etc|var|bin|sbin|System|Library|Users|home|root|boot|dev|proc|sys)\b)",
    r"\brm\s+(-[a-z]*r[a-z]*f?|--recursive)\s+/$",
    r"\bsudo\b",
    r"\bmkfs\b",
    r"\bdd\s+if=.*of=/dev/",
    r":\(\)\s*\{\s*:\|:\s*&\s*\}\s*;:",
    r"\bshutdown\b",
    r"\breboot\b",
    r"\bhalt\b",
    r"\bchmod\s+-R\s+[0-7]{3,4}\s+/",
    r"\bchown\s+-R\b",
    r">\s*/dev/(sda|hda|nvme|disk)",
];

fn blocked_reason(command: &str) -> Option<&'static str> {
    static CI_PATTERNS: std::sync::OnceLock<Vec<Regex>> = std::sync::OnceLock::new();
    let ci = CI_PATTERNS.get_or_init(|| {
        BLOCKED_PATTERN_SRC
            .iter()
            .filter_map(|src| RegexBuilder::new(src).case_insensitive(true).build().ok())
            .collect::<Vec<_>>()
    });
    if ci.iter().any(|re| re.is_match(command)) {
        return Some("Refused: command matches a blocked pattern (catastrophic / irreversible operation).");
    }
    None
}

/// Commands that legitimately go silent for 30s+ (package managers) get a
/// longer early-kill window (TS: 120s vs 60s for anything else).
fn long_runner(command: &str) -> bool {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"\b(npm|npx|pnpm|yarn|pnpx|pip|pip3|uv|poetry|cargo|go\s+mod|bun|brew|apt|dnf|gem\s+install)\b")
            .unwrap()
    });
    re.is_match(command)
}

enum KillReason {
    Timeout,
    Aborted,
}

impl From<KillReason> for crate::OutcomeStatus {
    fn from(r: KillReason) -> Self {
        match r {
            KillReason::Timeout => crate::OutcomeStatus::Timeout,
            KillReason::Aborted => crate::OutcomeStatus::Aborted,
        }
    }
}

pub(crate) fn run_bash(
    command: &str,
    workspace_root: &std::path::Path,
    timeout_ms: u64,
    background: bool,
    abort: &crate::AbortFlag,
) -> ToolOutcome {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return ToolOutcome::failed("Missing required arg: command");
    }

    if let Some(reason) = blocked_reason(trimmed) {
        return ToolOutcome::rejected(reason);
    }

    if background {
        // Background mode: spawn into the shell registry, return immediately
        // with the shell id (TS `spawnBackground`). The model polls output
        // via bash_output and stops it via kill_shell.
        match super::background_shell::spawn_backgrounded(
            crate::shell_registry::global_shell_registry(),
            trimmed,
            workspace_root,
            abort,
        ) {
            Ok(id) => ToolOutcome::executed(format!(
                "Backgrounded as {id}. Use bash_output({{ shell_id: \"{id}\" }}) to read new output, kill_shell({{ shell_id: \"{id}\" }}) to stop it."
            ))
            .with_meta("backgrounded")
            .with_display(ToolDisplay::Command {
                command: trimmed.to_string(),
            }),
            Err(e) => ToolOutcome::failed(format!("Spawn error: {e}")),
        }
    } else {
        run_foreground(trimmed, workspace_root, timeout_ms, abort)
    }
}

fn run_foreground(
    trimmed: &str,
    workspace_root: &std::path::Path,
    timeout_ms: u64,
    abort: &crate::AbortFlag,
) -> ToolOutcome {
    let start = Instant::now();
    let mut cmd = Command::new(shell_binary());
    cmd.arg(if cfg!(windows) { "/c" } else { "-c" })
        .arg(trimmed)
        .current_dir(workspace_root)
        .env_clear()
        .envs(tool_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unix_process_group(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ToolOutcome::failed(format!("Spawn error: {e}")),
    };
    let out_reader = child.stdout.take().map(|p| spawn_reader(p, MAX_OUTPUT, start));
    let err_reader = child.stderr.take().map(|p| spawn_reader(p, MAX_OUTPUT, start));

    let deadline = start + Duration::from_millis(timeout_ms);
    let early_deadline = start
        + Duration::from_millis(if long_runner(trimmed) { 120_000 } else { 60_000 });

    let mut killed: Option<KillReason> = None;
    let exit: Option<i32> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(e) => {
                kill_and_reap(&mut child);
                return ToolOutcome::failed(format!("Spawn error: {e}"));
            }
        }
        if killed.is_none() {
            let now = Instant::now();
            let reason = if abort.is_aborted() {
                Some(KillReason::Aborted)
            } else if now >= deadline {
                Some(KillReason::Timeout)
            } else if now >= early_deadline && no_output_yet(&out_reader, &err_reader) {
                // Early timeout for commands that are likely stuck: no
                // output at all after the early window.
                Some(KillReason::Timeout)
            } else {
                None
            };
            if let Some(reason) = reason {
                killed = Some(reason);
                kill_and_reap(&mut child);
                break None;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    let mut stdout = read_stream(&out_reader);
    let mut stderr = read_stream(&err_reader);
    let truncated = stream_truncated(&out_reader) || stream_truncated(&err_reader);
    trim_to_lines(&mut stdout);
    trim_to_lines(&mut stderr);

    if let Some(reason) = killed {
        let output = match reason {
            KillReason::Timeout => format!(
                "Command timed out after {timeout_ms}ms.\nstdout:\n{stdout}\nstderr:\n{stderr}"
            ),
            KillReason::Aborted => "Command aborted by user.".to_string(),
        };
        return ToolOutcome {
            status: reason.into(),
            output,
            display: Some(ToolDisplay::Command {
                command: trimmed.to_string(),
            }),
            meta: None,
            duration_ms: Some(duration_ms),
        };
    }

    let note = if truncated { " (output truncated)" } else { "" };
    let mut output = stdout;
    if !stderr.is_empty() {
        output.push_str("\n[stderr]\n");
        output.push_str(&stderr);
    }
    output.push_str(note);
    let code = exit.map(|c| c.to_string()).unwrap_or_else(|| "?".to_string());
    let status = if exit == Some(0) {
        crate::OutcomeStatus::Executed
    } else {
        crate::OutcomeStatus::Failed
    };
    ToolOutcome {
        status,
        output,
        display: Some(ToolDisplay::Command {
            command: trimmed.to_string(),
        }),
        meta: Some(format!("exit {code} · {duration_ms}ms{note}")),
        duration_ms: Some(duration_ms),
    }
}

fn no_output_yet(out: &Option<StreamReader>, err: &Option<StreamReader>) -> bool {
    let out_ms = out.as_ref().map(|r| r.last_output_ms.load(Ordering::SeqCst));
    let err_ms = err.as_ref().map(|r| r.last_output_ms.load(Ordering::SeqCst));
    // last_output_ms is set on every chunk; 0 means nothing arrived yet.
    out_ms.unwrap_or(0) == 0 && err_ms.unwrap_or(0) == 0
}

fn read_stream(reader: &Option<StreamReader>) -> String {
    reader
        .as_ref()
        .and_then(|r| r.text.lock().ok().map(|t| t.clone()))
        .unwrap_or_default()
}

fn stream_truncated(reader: &Option<StreamReader>) -> bool {
    reader
        .as_ref()
        .map(|r| r.truncated.load(Ordering::SeqCst))
        .unwrap_or(false)
}

fn trim_to_lines(s: &mut String) {
    let lines = s.split('\n').count();
    if lines > MAX_LINES {
        let kept: Vec<&str> = s.split('\n').take(MAX_LINES).collect();
        *s = format!("{}\n... ({} more lines)", kept.join("\n"), lines - MAX_LINES);
    }
}

fn shell_binary() -> &'static str {
    if cfg!(windows) {
        "cmd.exe"
    } else {
        "/bin/sh"
    }
}

impl Tool for BashTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "bash".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to run." },
                    "background": {
                        "type": "boolean",
                        "description": "If true, spawn in the background and return a shell_id immediately. Use bash_output to poll and kill_shell to stop.",
                        "default": false
                    }
                },
                "required": ["command"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Destructive
    }

    fn execute(&self, ctx: &ToolContext, args: serde_json::Value) -> Result<ToolOutcome, ToolError> {
        let command = arg_str(&args, "command");
        let background = arg_bool(&args, "background");
        Ok(run_bash(
            &command,
            &ctx.workspace_root,
            DEFAULT_TIMEOUT_MS,
            background,
            &ctx.abort,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_abort() -> crate::AbortFlag {
        crate::AbortFlag::new()
    }

    #[test]
    fn rejects_empty_command() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_bash("   ", tmp.path(), 1000, false, &no_abort());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Missing required arg"));
    }

    #[test]
    fn refuses_blocked_patterns() {
        let tmp = tempfile::tempdir().unwrap();
        for cmd in [
            "sudo rm -rf /",
            "SUDO apt-get install x",
            "rm -rf /Users",
            "rm -fr ~",
            "rm -rf /usr",
            "rm --recursive /",
            "rm -rf /",
            "mkfs.ext4 /dev/sda1",
            "dd if=img of=/dev/disk2",
            "shutdown -h now",
            "reboot",
            "halt",
            "chmod -R 777 /",
            "chown -R root /",
            "echo x > /dev/sda",
            ":(){ :|:& };:",
        ] {
            let out = run_bash(cmd, tmp.path(), 1000, false, &no_abort());
            assert_eq!(out.status, crate::OutcomeStatus::Rejected, "cmd: {cmd}");
            assert!(out.output.contains("blocked pattern"), "cmd: {cmd}");
        }
    }

    #[test]
    fn allows_reasonable_scoped_commands() {
        let tmp = tempfile::tempdir().unwrap();
        // Scoped rm -rf inside the workspace is fine (relative target).
        let out = run_bash("rm -rf subdir", tmp.path(), 5000, false, &no_abort());
        assert_ne!(out.status, crate::OutcomeStatus::Rejected);
        // 'sudo' as a substring of another word is fine (\b anchors).
        let out = run_bash("echo desudo", tmp.path(), 5000, false, &no_abort());
        assert_ne!(out.status, crate::OutcomeStatus::Rejected);
    }

    #[test]
    fn executes_safe_command_and_reports_success() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_bash("echo hello-tide", tmp.path(), 10_000, false, &no_abort());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert!(out.output.contains("hello-tide"));
        assert!(out.meta.as_deref().unwrap().starts_with("exit 0 · "));
        assert!(out.duration_ms.unwrap() > 0);
        assert!(matches!(out.display, Some(ToolDisplay::Command { .. })));
    }

    #[test]
    fn reports_failure_with_nonzero_exit() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_bash("exit 7", tmp.path(), 10_000, false, &no_abort());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.meta.as_deref().unwrap().contains("exit 7"));
    }

    #[test]
    fn stderr_is_appended_with_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_bash("echo err-msg >&2", tmp.path(), 10_000, false, &no_abort());
        assert!(out.output.contains("[stderr]"));
        assert!(out.output.contains("err-msg"));
    }

    #[test]
    fn shell_features_work() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_bash("echo a && echo b | tr a-z A-Z", tmp.path(), 10_000, false, &no_abort());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert!(out.output.contains("a\nB"));
    }

    #[test]
    fn timeout_kills_and_reports() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_bash("sleep 5", tmp.path(), 300, false, &no_abort());
        assert_eq!(out.status, crate::OutcomeStatus::Timeout);
        assert!(out.output.contains("Command timed out after 300ms"));
    }

    #[test]
    fn abort_flag_kills_and_reports() {
        let tmp = tempfile::tempdir().unwrap();
        let abort = crate::AbortFlag::new();
        let abort2 = abort.clone();
        let root = tmp.path().to_path_buf();
        let handle = std::thread::spawn(move || {
            run_bash("sleep 5", &root, 10_000, false, &abort2)
        });
        std::thread::sleep(Duration::from_millis(200));
        abort.abort();
        let out = handle.join().unwrap();
        assert_eq!(out.status, crate::OutcomeStatus::Aborted);
        assert!(out.output.contains("aborted"));
    }

    #[test]
    fn output_line_cap_trims() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_bash("seq 1 3000", tmp.path(), 10_000, false, &no_abort());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert!(out.output.contains("... (2001 more lines)"));
        // "(output truncated)" notes the BYTE cap only (TS semantics);
        // 3000 short lines stay under 50 KB.
        assert!(!out.meta.as_deref().unwrap().contains("(output truncated)"));
    }

    #[test]
    fn background_returns_shell_id_immediately() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_bash("echo bg-echo; sleep 10", tmp.path(), 30_000, true, &no_abort());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert!(out.output.starts_with("Backgrounded as sh_"));
        assert!(out.output.contains("bash_output({ shell_id:"));
        assert_eq!(out.meta.as_deref(), Some("backgrounded"));
        assert!(matches!(out.display, Some(ToolDisplay::Command { .. })));
        // Returns immediately (no durationMs — the process keeps running).
        assert_eq!(out.duration_ms, None);

        // The shell really runs in the registry: poll output, then kill.
        let id = out.output.split_whitespace().nth(2).unwrap().trim_end_matches('.');
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some((chunk, _)) =
                crate::shell_registry::global_shell_registry().read_new(id)
            {
                if chunk.contains("bg-echo") {
                    break;
                }
            }
            assert!(std::time::Instant::now() < deadline, "background echo never arrived");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(crate::shell_registry::global_shell_registry().kill(id));
    }

    #[test]
    fn background_blocked_command_still_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_bash("sudo rm -rf /", tmp.path(), 1000, true, &no_abort());
        assert_eq!(out.status, crate::OutcomeStatus::Rejected);
    }

    #[test]
    fn runs_in_workspace_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_bash("pwd", tmp.path(), 10_000, false, &no_abort());
        let shown = out.output.trim();
        // /bin/sh pwd may canonicalize (macOS /var → /private/var); compare
        // canonically.
        let shown_real = std::fs::canonicalize(shown).unwrap_or_default();
        let tmp_real = std::fs::canonicalize(tmp.path()).unwrap_or_default();
        assert_eq!(shown_real, tmp_real);
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = BashTool;
        assert_eq!(tool.spec().name, "bash");
        assert_eq!(tool.risk_tier(), RiskTier::Destructive);
        let out = tool
            .execute(
                &ToolContext::new(tmp.path().to_path_buf()),
                json!({ "command": "echo trait" }),
            )
            .unwrap();
        assert!(out.output.contains("trait"));
    }
}
