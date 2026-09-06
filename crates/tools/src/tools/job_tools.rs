//! Job tools: `job_output`, `job_list`, `job_kill` over the native
//! background-job registry, plus the deprecation-alias envelopes for the
//! legacy `bash_output` / `kill_shell` ids (see
//! [`crate::tools::background_shell`], which forwards here).
//!
//! Every tool fences on [`ToolContext::session_id`] — jobs from other
//! sessions are invisible, and an unknown id reports the same copy
//! whether it never existed, already finished and was reaped, or belongs
//! to another session.

use serde_json::json;
use protocol::model::{BackgroundWorkItem, BackgroundWorkKey, BackgroundWorkStatus};

use crate::jobs::{global_job_registry, KillOutcome, Reader};
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

pub const JOB_OUTPUT_NAME: &str = "job_output";
pub const JOB_LIST_NAME: &str = "job_list";
pub const JOB_KILL_NAME: &str = "job_kill";
pub const BASH_OUTPUT_ALIAS: &str = "bash_output";
pub const KILL_SHELL_ALIAS: &str = "kill_shell";

const JOB_OUTPUT_DESCRIPTION: &str = "Read new output from a background job since the last read. Use after starting a long-running command (dev server, watcher, etc.) via bash with background:true. Returns the incremental stdout+stderr and the job status; a read after the job finishes also reports its exit code. Reading a finished job delivers its completion, so always read the final delta.";

const JOB_LIST_DESCRIPTION: &str = "List this session's background jobs — id, status, and command for each, in start order. Use it to recover a job id, e.g. after starting long-running work earlier in the session. Finished jobs stay listed until the session ends.";

const JOB_KILL_DESCRIPTION: &str = "Stop a background job by id. Use when a long-running command (dev server, watcher, etc.) is no longer needed. The job settles as stopped; read its remaining output with job_output.";

const JOB_ID_DESCRIPTION: &str = "The background job id, e.g. bash-1.";

pub struct JobOutputTool;

pub struct JobListTool;

pub struct JobKillTool;

/// The status word the model-facing copy uses (matches the settlement
/// notice wording in the registry).
fn status_word(status: BackgroundWorkStatus) -> &'static str {
    match status {
        BackgroundWorkStatus::Starting => "starting",
        BackgroundWorkStatus::Running => "running",
        BackgroundWorkStatus::Stopping => "stopping",
        BackgroundWorkStatus::Completed => "completed",
        BackgroundWorkStatus::Failed => "failed",
        BackgroundWorkStatus::Stopped => "stopped",
        BackgroundWorkStatus::Lost => "lost",
    }
}

/// Resolve a model-facing job id to its registry key within one session.
/// The registry keys by `(kind, provider_id)`; ids minted here are unique
/// per provider, so matching on the provider id is exact.
fn find_item(session: &str, job_id: &str) -> Option<(BackgroundWorkKey, BackgroundWorkItem)> {
    global_job_registry()
        .list_session(session)
        .into_iter()
        .find(|item| item.key.provider_id == job_id)
        .map(|item| (item.key.clone(), item))
}

/// One unknown-id copy for every miss (never started / already finished /
/// foreign session) — the model gets the same recovery hint regardless.
fn unknown_job(job_id: &str) -> String {
    format!(
        "Unknown job id: {job_id}. It may have never started, already finished, or belong to another session. Use job_list to see this session's jobs."
    )
}

/// `job_output` body — also the `bash_output` alias target (`shell_id` is
/// read as the job id). Returns the delta since this reader's last read
/// plus the status; a terminal read delivers the completion.
pub(crate) fn run_job_output(session: &str, job_id: &str) -> ToolOutcome {
    if job_id.is_empty() {
        return ToolOutcome::failed("Missing required arg: job_id");
    }
    let Some((key, _)) = find_item(session, job_id) else {
        return ToolOutcome::failed(unknown_job(job_id));
    };
    let registry = global_job_registry();
    let Ok(read) = registry.read(session, &key, Reader::Model) else {
        return ToolOutcome::failed(unknown_job(job_id));
    };
    let snapshot = read.snapshot;
    let status = status_word(snapshot.status);
    let detail = snapshot
        .detail
        .as_deref()
        .map(|detail| format!(" ({detail})"))
        .unwrap_or_default();
    let bytes = read.text.len();
    let mut output = if read.text.is_empty() {
        "(no new output)".to_string()
    } else {
        read.text
    };
    if !snapshot.status.is_live() {
        // The completion delivery: the terminal read carries the exit
        // status right in the output, not only in meta.
        let detail_note = snapshot
            .detail
            .as_deref()
            .map(|detail| format!(", {detail}"))
            .unwrap_or_default();
        output.push_str(&format!(
            "\n[background job {job_id} finished — {status}{detail_note}]"
        ));
    }
    ToolOutcome::executed(output).with_meta(format!("{status}{detail} · {bytes} bytes"))
}

/// `job_list` body — every job of this session in registration order.
pub(crate) fn run_job_list(session: &str) -> ToolOutcome {
    let items = global_job_registry().list_session(session);
    if items.is_empty() {
        return ToolOutcome::executed("No background jobs in this session.");
    }
    let count = items.len();
    let mut output = String::from("Background jobs in this session:");
    for item in items {
        let status = status_word(item.status);
        let detail = item
            .detail
            .as_deref()
            .map(|detail| format!(" ({detail})"))
            .unwrap_or_default();
        let mut label = item.title;
        if label.len() > 120 {
            label.truncate(label
                .char_indices()
                .take(120)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(120));
            label.push('…');
        }
        output.push_str(&format!(
            "\n- {} · {status}{detail} · {label}",
            item.key.provider_id
        ));
    }
    ToolOutcome::executed(output).with_meta(format!("{count} job(s)"))
}

/// `job_kill` body — also the `kill_shell` alias target. Cancellation is
/// synchronous; the job settles `Stopped` once its process is gone.
pub(crate) fn run_job_kill(session: &str, job_id: &str) -> ToolOutcome {
    if job_id.is_empty() {
        return ToolOutcome::failed("Missing required arg: job_id");
    }
    let Some((key, _)) = find_item(session, job_id) else {
        return ToolOutcome::failed(unknown_job(job_id));
    };
    match global_job_registry().kill(session, &key, None) {
        Ok(KillOutcome::Requested) => ToolOutcome::executed(format!(
            "Stopping background job {job_id}. Read its final output with job_output once it settles."
        ))
        .with_meta("stopping"),
        Ok(KillOutcome::AlreadyFinished) => ToolOutcome::executed(format!(
            "Background job {job_id} already finished; nothing to stop."
        )),
        Ok(KillOutcome::Unknown) => ToolOutcome::failed(unknown_job(job_id)),
        Err(error) => ToolOutcome::failed(error.to_string()),
    }
}

impl Tool for JobOutputTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: JOB_OUTPUT_NAME.into(),
            description: JOB_OUTPUT_DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": JOB_ID_DESCRIPTION
                    }
                },
                "required": ["job_id"]
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
        Ok(run_job_output(&ctx.session_id, &super::arg_str(&args, "job_id")))
    }
}

impl Tool for JobListTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: JOB_LIST_NAME.into(),
            description: JOB_LIST_DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {}
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        _args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        Ok(run_job_list(&ctx.session_id))
    }
}

impl Tool for JobKillTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: JOB_KILL_NAME.into(),
            description: JOB_KILL_DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": JOB_ID_DESCRIPTION
                    }
                },
                "required": ["job_id"]
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
        Ok(run_job_kill(&ctx.session_id, &super::arg_str(&args, "job_id")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(tag: &str) -> String {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        format!(
            "job-tools-{}-{}",
            tag,
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        )
    }

    #[test]
    fn specs_and_tiers() {
        let output = JobOutputTool;
        assert_eq!(output.spec().name, "job_output");
        assert_eq!(output.risk_tier(), RiskTier::ReadOnly);
        let list = JobListTool;
        assert_eq!(list.spec().name, "job_list");
        assert_eq!(list.risk_tier(), RiskTier::ReadOnly);
        let kill = JobKillTool;
        assert_eq!(kill.spec().name, "job_kill");
        assert_eq!(kill.risk_tier(), RiskTier::Write);
    }

    #[test]
    fn empty_and_unknown_ids_report_the_unknown_copy() {
        let session = session("unknown");
        let out = run_job_output(&session, "");
        assert_eq!(out.output, "Missing required arg: job_id");
        let out = run_job_kill(&session, "");
        assert_eq!(out.output, "Missing required arg: job_id");
        let out = run_job_output(&session, "bash-9");
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.starts_with("Unknown job id: bash-9."), "{}", out.output);
        assert!(out.output.contains("job_list"));
        let out = run_job_kill(&session, "bash-9");
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.starts_with("Unknown job id: bash-9."), "{}", out.output);
    }

    #[test]
    fn session_fence_hides_foreign_jobs() {
        let owner = session("fence");
        let key = global_job_registry()
            .start(crate::jobs::JobStart {
                kind: protocol::model::BackgroundWorkKind::Process,
                prefix: "bash",
                id: None,
                label: "foreign".into(),
                owner_session: owner.clone(),
                output_limit: None,
                streams: true,
                run: Box::new(|handle| {
                    handle.output.append("secret");
                    Ok(crate::jobs::JobHooks {
                        cancel: Box::new(|_| {}),
                        done: crate::jobs::JobDone::new(),
                    })
                }),
            })
            .unwrap();
        let outsider = session("fence-other");
        let out = run_job_output(&outsider, &key.provider_id);
        assert!(out.output.starts_with("Unknown job id:"), "{}", out.output);
        let out = run_job_kill(&outsider, &key.provider_id);
        assert!(out.output.starts_with("Unknown job id:"), "{}", out.output);
        let out = run_job_list(&outsider);
        assert_eq!(out.output, "No background jobs in this session.");
    }
}
