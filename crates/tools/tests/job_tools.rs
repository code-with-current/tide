//! Stage 2 job-tool coverage: the `bash background:true` → `job_output` →
//! `job_kill` flow over the process-global job registry, read/wait
//! behavior, admission copy, the `bash_output` / `kill_shell` alias
//! forwarding, and the stale-id copy. Tests isolate through unique session
//! ids and build [`ToolContext`]s by hand (`runtime: None`).

use std::time::{Duration, Instant};

use protocol::model::{BackgroundWorkKey, BackgroundWorkKind, BackgroundWorkStatus};
use serde_json::json;
use tools::jobs::{global_job_registry, Reader};
use tools::{
    AbortFlag, BashOutputTool, BashTool, JobKillTool, JobListTool, JobOutputTool, KillShellTool,
    OutcomeStatus, TodoState, Tool, ToolContext,
};

fn test_session(tag: &str) -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "job-tools-it-{}-{}",
        tag,
        N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    )
}

/// The full hand-built context the parent's tools run with — `runtime` is
/// `None`, exactly like the tool-only binaries.
fn ctx_for(session_id: &str) -> ToolContext {
    ToolContext {
        session_id: session_id.to_string(),
        workspace_root: std::env::temp_dir(),
        extra_read_roots: Vec::new(),
        workspace_id: String::new(),
        todo_state: TodoState::shared(),
        abort: AbortFlag::new(),
        runtime: None,
    }
}

/// Pull the minted job id out of the bash ack (`started background job bash-N. …`).
fn job_id_of(ack: &str) -> String {
    ack.trim_start_matches("started background job ")
        .split('.')
        .next()
        .unwrap()
        .to_string()
}

/// Start one background job the way the model does.
fn start_background(ctx: &ToolContext, command: &str) -> String {
    let out = BashTool
        .execute(ctx, json!({ "command": command, "background": true }))
        .unwrap();
    assert_eq!(out.status, OutcomeStatus::Executed, "{}", out.output);
    assert!(matches!(
        out.display,
        Some(tools::ToolDisplay::Command { .. })
    ));
    assert_eq!(out.meta.as_deref(), Some("backgrounded"));
    job_id_of(&out.output)
}

fn key_of(id: &str) -> BackgroundWorkKey {
    BackgroundWorkKey::new(BackgroundWorkKind::Process, id)
}

fn wait_until(deadline_msg: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "{deadline_msg}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// background sleep → job_output deltas → job_kill settles `Stopped`.
#[test]
fn background_flow_deltas_kill_and_stopped_settlement() {
    let session = test_session("flow");
    let ctx = ctx_for(&session);
    let id = start_background(&ctx, "echo jt-flow; sleep 30");
    assert!(id.starts_with("bash-"), "{id}");

    // The ack points at the job tools, not the retired aliases.
    // (Read once off the ack text itself.)
    let read_ack = BashTool
        .execute(
            &ctx,
            json!({ "command": "echo ack-check; sleep 30", "background": true }),
        )
        .unwrap();
    assert!(read_ack.output.contains("job_output(job_id:"));
    assert!(read_ack.output.contains("job_kill(job_id:"));
    let extra = job_id_of(&read_ack.output);
    JobKillTool
        .execute(&ctx, json!({ "job_id": extra }))
        .unwrap();

    // job_output: first delta carries the echo, the next is empty while
    // the sleep keeps running.
    let job_output = JobOutputTool;
    let mut seen = String::new();
    wait_until("job_output never delivered the echo", || {
        let out = job_output
            .execute(&ctx_for(&session), json!({ "job_id": id }))
            .unwrap();
        if out.output != "(no new output)" {
            seen.push_str(&out.output);
        }
        seen.contains("jt-flow")
    });
    let out = job_output
        .execute(&ctx_for(&session), json!({ "job_id": id }))
        .unwrap();
    assert_eq!(out.output, "(no new output)");
    assert!(
        out.meta.as_deref().unwrap().starts_with("running"),
        "{:?}",
        out.meta
    );

    // A bounded registry wait on the live job times out and leaves it
    // untouched.
    let key = key_of(&id);
    let snapshot = global_job_registry()
        .wait(
            &session,
            &key,
            Duration::from_millis(150),
            &AbortFlag::new(),
            Reader::Model,
        )
        .unwrap();
    assert_eq!(snapshot.status, BackgroundWorkStatus::Running);
    assert!(snapshot.detail.is_none());

    // job_list shows the live job with its id and command.
    let out = JobListTool.execute(&ctx_for(&session), json!({})).unwrap();
    assert!(out.output.contains(&id), "{}", out.output);
    assert!(out.output.contains("jt-flow"), "{}", out.output);
    assert!(out.output.contains("running"), "{}", out.output);

    // job_kill requests the stop…
    let out = JobKillTool
        .execute(&ctx_for(&session), json!({ "job_id": id }))
        .unwrap();
    assert_eq!(out.status, OutcomeStatus::Executed);
    assert!(
        out.output
            .contains(&format!("Stopping background job {id}")),
        "{}",
        out.output
    );
    assert_eq!(out.meta.as_deref(), Some("stopping"));

    // …and the job settles `Stopped` with an exit-code detail.
    let registry = global_job_registry();
    wait_until("job never settled after kill", || {
        registry
            .list_session(&session)
            .into_iter()
            .find(|item| item.key == key)
            .map(|item| !item.status.is_live())
            .unwrap_or(false)
    });
    let item = registry
        .list_session(&session)
        .into_iter()
        .find(|item| item.key == key)
        .unwrap();
    assert_eq!(item.status, BackgroundWorkStatus::Stopped);
    assert!(
        item.detail
            .as_deref()
            .unwrap_or("")
            .starts_with("exit code:"),
        "{item:?}"
    );

    // The final job_output read delivers the completion footer.
    let out = job_output
        .execute(&ctx_for(&session), json!({ "job_id": id }))
        .unwrap();
    assert!(
        out.output
            .contains(&format!("[background job {id} finished — stopped")),
        "{}",
        out.output
    );
    assert!(
        out.meta.as_deref().unwrap().starts_with("stopped"),
        "{:?}",
        out.meta
    );
}

/// Natural completion settles `Completed` with `exit code: 0` and the
/// read reports it.
#[test]
fn natural_exit_settles_completed_and_reads_back_the_code() {
    let session = test_session("completed");
    let ctx = ctx_for(&session);
    let id = start_background(&ctx, "echo jt-done; exit 0");
    let key = key_of(&id);
    let registry = global_job_registry();
    wait_until("job never completed", || {
        registry
            .list_session(&session)
            .into_iter()
            .find(|item| item.key == key)
            .map(|item| !item.status.is_live())
            .unwrap_or(false)
    });
    let out = JobOutputTool
        .execute(&ctx_for(&session), json!({ "job_id": id }))
        .unwrap();
    assert!(out.output.contains("jt-done"), "{}", out.output);
    assert!(
        out.output.contains(&format!(
            "[background job {id} finished — completed, exit code: 0]"
        )),
        "{}",
        out.output
    );
    assert!(
        out.meta
            .as_deref()
            .unwrap()
            .starts_with("completed (exit code: 0)"),
        "{:?}",
        out.meta
    );
}

/// The 11th live job for one session reports the registry's admission copy.
#[test]
fn admission_limit_reports_the_registry_copy() {
    let session = test_session("admission");
    let ctx = ctx_for(&session);
    let mut ids = Vec::new();
    for _ in 0..10 {
        ids.push(start_background(&ctx, "sleep 30"));
    }
    let out = BashTool
        .execute(&ctx, json!({ "command": "sleep 30", "background": true }))
        .unwrap();
    assert_eq!(out.status, OutcomeStatus::Failed);
    assert!(
        out.output.contains("background job limit reached"),
        "{}",
        out.output
    );
    assert!(out.output.contains("limit: 10"), "{}", out.output);
    assert!(
        out.output.contains("kill one with job_kill"),
        "{}",
        out.output
    );

    // No id was minted for the rejected start; clean up the ten live ones.
    let list = JobListTool.execute(&ctx_for(&session), json!({})).unwrap();
    assert_eq!(list.meta.as_deref(), Some("10 job(s)"));
    for id in &ids {
        let out = JobKillTool
            .execute(&ctx_for(&session), json!({ "job_id": id }))
            .unwrap();
        assert_eq!(out.status, OutcomeStatus::Executed);
    }
}

/// The retired `bash_output` / `kill_shell` envelopes forward verbatim to
/// the job tools with `shell_id` read as the job id.
#[test]
fn aliases_forward_to_the_job_registry() {
    let session = test_session("alias");
    let ctx = ctx_for(&session);
    let id = start_background(&ctx, "echo jt-alias; sleep 30");

    let mut seen = String::new();
    wait_until("bash_output never delivered the echo", || {
        let out = BashOutputTool
            .execute(&ctx_for(&session), json!({ "shell_id": id }))
            .unwrap();
        if out.output != "(no new output)" {
            seen.push_str(&out.output);
        }
        seen.contains("jt-alias")
    });

    let out = KillShellTool
        .execute(&ctx_for(&session), json!({ "shell_id": id }))
        .unwrap();
    assert_eq!(out.status, OutcomeStatus::Executed);
    assert!(
        out.output
            .contains(&format!("Stopping background job {id}")),
        "{}",
        out.output
    );
}

/// A stale `sh_` id — the retired registry's id shape — reports the job
/// tools' unknown-id copy, for reads, kills, and both aliases.
#[test]
fn stale_shell_id_reports_the_unknown_job_copy() {
    let session = test_session("stale");
    let ctx = ctx_for(&session);
    for (tool, args) in [
        ("job_output", json!({ "job_id": "sh_000042" })),
        ("job_kill", json!({ "job_id": "sh_000042" })),
        ("bash_output", json!({ "shell_id": "sh_000042" })),
        ("kill_shell", json!({ "shell_id": "sh_000042" })),
    ] {
        let outcome = match tool {
            "job_output" => JobOutputTool.execute(&ctx, args).unwrap(),
            "job_kill" => JobKillTool.execute(&ctx, args).unwrap(),
            "bash_output" => BashOutputTool.execute(&ctx, args).unwrap(),
            "kill_shell" => KillShellTool.execute(&ctx, args).unwrap(),
            _ => unreachable!(),
        };
        assert_eq!(
            outcome.status,
            OutcomeStatus::Failed,
            "{tool}: {}",
            outcome.output
        );
        assert!(
            outcome.output.starts_with("Unknown job id: sh_000042."),
            "{tool}: {}",
            outcome.output
        );
        assert!(
            outcome.output.contains("job_list"),
            "{tool}: {}",
            outcome.output
        );
    }
    // And job_list on a fresh session says exactly this.
    let out = JobListTool
        .execute(&ctx_for(&test_session("stale-empty")), json!({}))
        .unwrap();
    assert_eq!(out.output, "No background jobs in this session.");
}
