//! Stage 1 registry coverage: ids, admission, cursors, settlement,
//! kill/report, waits, listener containment, and close_session teardown.
//! Tests isolate through unique session ids — the registry is process-global.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use protocol::model::{BackgroundWorkEvent, BackgroundWorkKey, BackgroundWorkKind, BackgroundWorkStatus};
use tools::jobs::{
    global_job_registry, JobDone, JobError, JobHooks, JobOutcome, JobStart,
    KillOutcome, Reader, SettledStatus,
};
use tools::AbortFlag;

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

fn test_session(tag: &str) -> String {
    // Unique per test: the global registry keys everything by session.
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!("jobs-test-{}-{}", tag, N.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
}

type EventLog = Arc<Mutex<Vec<String>>>;

fn wire_sink(log: EventLog) -> Box<dyn Fn(BackgroundWorkEvent) + Send + Sync> {
    Box::new(move |event| match event {
        BackgroundWorkEvent::Upsert(item) => {
            log.lock().unwrap().push(format!("upsert:{}", status_word(item.status)))
        }
        BackgroundWorkEvent::StopRequested(_) => log.lock().unwrap().push("stop-requested".into()),
        _ => {}
    })
}

fn start_streaming(session: &str, prefix: &'static str, label: &str) -> Result<BackgroundWorkKey, JobError> {
    global_job_registry().start(JobStart {
        kind: match prefix {
            "bash" => BackgroundWorkKind::Process,
            _ => BackgroundWorkKind::Subagent,
        },
        prefix,
        id: None,
        label: label.into(),
        owner_session: session.into(),
        output_limit: None,
        streams: true,
        run: Box::new(|_handle| Ok(JobHooks { cancel: Box::new(|_| {}), done: JobDone::new() })),
    })
}

fn subagent_start(session: &str, id: Option<&str>, label: &str) -> JobStart {
    JobStart {
        kind: BackgroundWorkKind::Subagent,
        prefix: "sub",
        id: id.map(str::to_string),
        label: label.into(),
        owner_session: session.into(),
        output_limit: None,
        streams: false,
        run: Box::new(|handle| {
            Ok(JobHooks { cancel: Box::new(|_| {}), done: handle.done.clone() })
        }),
    }
}

#[test]
fn ids_mint_per_prefix_and_per_session() {
    let session = test_session("mint");
    let registry = global_job_registry();
    let bash_one = start_streaming(&session, "bash", "first").unwrap();
    let sub_one = registry.start(subagent_start(&session, None, "delegate")).unwrap();
    let bash_two = start_streaming(&session, "bash", "second").unwrap();

    assert_eq!(bash_one.provider_id, "bash-1");
    assert_eq!(bash_two.provider_id, "bash-2");
    assert_eq!(sub_one.provider_id, "sub-1");

    // A second session mints from its own counters.
    let other = test_session("mint-other");
    let other_bash = start_streaming(&other, "bash", "theirs").unwrap();
    assert_eq!(other_bash.provider_id, "bash-1");
}

#[test]
fn supplied_ids_are_adopted() {
    let session = test_session("adopt");
    let key = global_job_registry()
        .start(subagent_start(&session, Some("child-7"), "delegate"))
        .unwrap();
    assert_eq!(key.provider_id, "child-7");
}

/// Decision 10: a subagent job's id IS the child's durable id, so a resumed
/// child re-registers under it. A terminal record is replaced in place; a
/// live one still collides.
#[test]
fn a_terminal_supplied_id_is_replaced_a_live_one_collides() {
    let session = test_session("re-adopt");
    let registry = global_job_registry();
    let key = registry
        .start(subagent_start(&session, Some("child-8"), "first run"))
        .unwrap();
    assert_eq!(
        registry.kill(&session, &key, None).unwrap(),
        KillOutcome::Requested
    );
    registry.settle(&session, &key, JobOutcome {
        status: SettledStatus::Stopped,
        detail: None,
        output: None,
    });

    // The resume: same id, new run — the old terminal record is replaced
    // and keeps its registration-order slot.
    let second = registry
        .start(subagent_start(&session, Some("child-8"), "resumed run"))
        .unwrap();
    assert_eq!(second.provider_id, "child-8");
    let listed = registry.list_session(&session);
    assert_eq!(listed.len(), 1, "no duplicate records: {listed:?}");
    assert_eq!(listed[0].title, "resumed run");

    let error = registry
        .start(subagent_start(&session, Some("child-8"), "ghost"))
        .unwrap_err();
    assert!(error.to_string().contains("already exists"), "{error}");
    registry.close_session(&session, Duration::from_millis(50));
}

#[test]
fn failed_start_consumes_the_counter_and_settles_failed() {
    let session = test_session("fail-start");
    let log: EventLog = Arc::new(Mutex::new(Vec::new()));
    global_job_registry().set_event_sink(&session, wire_sink(log.clone()));

    let error = global_job_registry()
        .start(JobStart {
            kind: BackgroundWorkKind::Process,
            prefix: "bash",
            id: None,
            label: "boom".into(),
            owner_session: session.clone(),
            output_limit: None,
            streams: true,
            run: Box::new(|_handle| Err("starter broke".into())),
        })
        .unwrap_err();
    assert!(error.to_string().contains("start failed"));

    // The counter is consumed: the next start is bash-2.
    let next = start_streaming(&session, "bash", "next").unwrap();
    assert_eq!(next.provider_id, "bash-2");

    let kinds = log.lock().unwrap().clone();
    assert!(kinds.contains(&"upsert:failed".to_string()));
}

#[test]
fn admission_rejects_at_the_configured_budget() {
    let session = test_session("admission");
    // Default budget is 10; fill it with 10 live jobs.
    for _ in 0..10 {
        start_streaming(&session, "bash", "filler").unwrap();
    }
    let error = start_streaming(&session, "bash", "over").unwrap_err();
    assert!(error.to_string().contains("background job limit reached"));
}

#[test]
fn stopping_occupies_capacity_and_terminals_release_it() {
    let session = test_session("stopping");
    let registry = global_job_registry();
    // Fill the default budget of 10 live jobs.
    let mut keys = Vec::new();
    for n in 0..10 {
        keys.push(start_streaming(&session, "bash", &format!("job-{n}")).unwrap());
    }
    let error = start_streaming(&session, "sub", "over").unwrap_err();
    assert!(error.to_string().contains("background job limit reached"));

    // `Stopping` still occupies the budget.
    registry.kill(&session, &keys[0], None).unwrap();
    let error = start_streaming(&session, "sub", "over-2").unwrap_err();
    assert!(error.to_string().contains("background job limit reached"));

    // Terminal release frees capacity.
    registry.settle(&session, &keys[0], JobOutcome {
        status: SettledStatus::Stopped,
        detail: None,
        output: None,
    });
    let third = start_streaming(&session, "sub", "three").unwrap();
    assert_eq!(third.provider_id, "sub-1");
}

#[test]
fn cursors_are_isolated_in_both_directions() {
    let session = test_session("cursors");
    let key = global_job_registry()
        .start(JobStart {
            kind: BackgroundWorkKind::Process,
            prefix: "bash",
            id: None,
            label: "one".into(),
            owner_session: session.clone(),
            output_limit: None,
            streams: true,
            run: Box::new(|handle| {
                handle.output.append("abc");
                Ok(JobHooks { cancel: Box::new(|_| {}), done: JobDone::new() })
            }),
        })
        .unwrap();
    let registry = global_job_registry();

    // The model reads "abc"; a second model read is empty (cursor advanced).
    let model = registry.read(&session, &key, Reader::Model).unwrap();
    assert_eq!(model.text, "abc");
    let model_again = registry.read(&session, &key, Reader::Model).unwrap();
    assert_eq!(model_again.text, "");

    // More output arrives; the UI reader sees everything since ITS last read.
    let ui = registry.read(&session, &key, Reader::Ui).unwrap();
    assert!(ui.text.contains("abc"));
}

#[test]
fn ring_trim_keeps_both_cursors_valid() {
    let session = test_session("trim");
    let key = global_job_registry()
        .start(JobStart {
            kind: BackgroundWorkKind::Process,
            prefix: "bash",
            id: None,
            label: "one".into(),
            owner_session: session.clone(),
            output_limit: None,
            streams: true,
            run: Box::new(|handle| {
                // Multibyte pushes well past a small cap.
                for _ in 0..40 {
                    handle.output.append("界界界界");
                }
                Ok(JobHooks { cancel: Box::new(|_| {}), done: JobDone::new() })
            }),
        })
        .unwrap();
    let registry = global_job_registry();

    let model = registry.read(&session, &key, Reader::Model).unwrap();
    assert!(!model.text.is_empty());
    assert!(model.text.len() <= 256 * 1024);
    assert!(model.text.chars().all(|c| c == '界'));
}

#[test]
fn settlement_is_first_wins_against_a_late_outcome() {
    let session = test_session("first-wins");
    let log: EventLog = Arc::new(Mutex::new(Vec::new()));
    global_job_registry().set_event_sink(&session, wire_sink(log.clone()));
    let key = start_streaming(&session, "bash", "one").unwrap();
    let registry = global_job_registry();

    registry.settle(&session, &key, JobOutcome {
        status: SettledStatus::Completed,
        detail: Some("first".into()),
        output: Some("done".into()),
    });
    registry.settle(&session, &key, JobOutcome {
        status: SettledStatus::Failed,
        detail: Some("late".into()),
        output: None,
    });

    let item = registry
        .list_session(&session)
        .into_iter()
        .find(|item| item.key == key)
        .unwrap();
    assert_eq!(item.status, BackgroundWorkStatus::Completed);
    assert_eq!(item.detail.as_deref(), Some("first"));
    let kinds = log.lock().unwrap().clone();
    assert_eq!(kinds.iter().filter(|k| k == &&"upsert:completed".to_string()).count(), 1);
    assert!(!kinds.contains(&"upsert:failed".to_string()));
}

#[test]
fn kill_marks_stopping_and_emits_stop_requested() {
    let session = test_session("kill");
    let log: EventLog = Arc::new(Mutex::new(Vec::new()));
    global_job_registry().set_event_sink(&session, wire_sink(log.clone()));
    let key = start_streaming(&session, "bash", "one").unwrap();

    assert_eq!(
        global_job_registry().kill(&session, &key, Some("done with it".into())).unwrap(),
        KillOutcome::Requested
    );
    // A live-but-stopping job is still `Requested` (idempotent cancellation),
    // not `AlreadyFinished` — that is reserved for terminal jobs.
    assert_eq!(
        global_job_registry().kill(&session, &key, None).unwrap(),
        KillOutcome::Requested
    );

    // After settlement the same kill reports the terminal status.
    global_job_registry().settle(&session, &key, JobOutcome {
        status: SettledStatus::Stopped,
        detail: Some("terminated".into()),
        output: None,
    });
    assert_eq!(
        global_job_registry().kill(&session, &key, None).unwrap(),
        KillOutcome::AlreadyFinished
    );

    let kinds = log.lock().unwrap().clone();
    assert!(kinds.contains(&"stop-requested".to_string()));
}

#[test]
fn wait_settles_timeouts_out_and_honors_abort() {
    let session = test_session("wait");
    let registry = global_job_registry();
    let abort = AbortFlag::new();
    let live = start_streaming(&session, "bash", "one").unwrap();

    // Timeout: still running, job untouched.
    let snapshot = registry.wait(&session, &live, Duration::from_millis(80), &abort, Reader::Model).unwrap();
    assert_eq!(snapshot.status, BackgroundWorkStatus::Running);

    // Abort: same live snapshot, job untouched.
    abort.abort();
    let snapshot = registry.wait(&session, &live, Duration::from_secs(10), &abort, Reader::Model).unwrap();
    assert_eq!(snapshot.status, BackgroundWorkStatus::Running);

    // Settlement: the wait returns the terminal snapshot.
    registry.settle(&session, &live, JobOutcome {
        status: SettledStatus::Completed,
        detail: None,
        output: Some("final".into()),
    });
    let snapshot = registry.wait(&session, &live, Duration::from_secs(10), &abort, Reader::Model).unwrap();
    assert_eq!(snapshot.status, BackgroundWorkStatus::Completed);
}

#[test]
fn wake_listener_panics_are_contained() {
    let session = test_session("panic-listener");
    global_job_registry().set_waker(&session, Box::new(|_| panic!("listener exploded")));
    let key = start_streaming(&session, "bash", "one").unwrap();

    global_job_registry().settle(&session, &key, JobOutcome {
        status: SettledStatus::Completed,
        detail: None,
        output: None,
    });
    let item = global_job_registry()
        .list_session(&session)
        .into_iter()
        .find(|item| item.key == key)
        .unwrap();
    assert_eq!(item.status, BackgroundWorkStatus::Completed);
}

#[test]
fn close_session_force_fails_a_straggler() {
    let session = test_session("close");
    let log: EventLog = Arc::new(Mutex::new(Vec::new()));
    global_job_registry().set_event_sink(&session, wire_sink(log.clone()));

    start_streaming(&session, "bash", "never settles").unwrap();
    global_job_registry().close_session(&session, Duration::from_millis(80));

    // The reaper is asynchronous; poll for the force-fail event.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let kinds = log.lock().unwrap().clone();
        if kinds.contains(&"upsert:failed".to_string()) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "close_session never force-failed the straggler: {kinds:?}"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn settle_during_start_cannot_reorder_events() {
    let session = test_session("order");
    let log: EventLog = Arc::new(Mutex::new(Vec::new()));
    global_job_registry().set_event_sink(&session, wire_sink(log.clone()));

    global_job_registry()
        .start(JobStart {
            kind: BackgroundWorkKind::Process,
            prefix: "bash",
            id: None,
            label: "instant".into(),
            owner_session: session.clone(),
            output_limit: None,
            streams: true,
            run: Box::new(|handle| {
                handle.done.resolve(JobOutcome {
                    status: SettledStatus::Completed,
                    detail: None,
                    output: Some("fast".into()),
                });
                Ok(JobHooks { cancel: Box::new(|_| {}), done: handle.done.clone() })
            }),
        })
        .unwrap();

    std::thread::sleep(Duration::from_millis(150));
    let kinds = log.lock().unwrap().clone();
    let starting = kinds.iter().position(|k| k == "upsert:starting").unwrap();
    let running = kinds.iter().position(|k| k == "upsert:running").unwrap();
    let completed = kinds.iter().position(|k| k == "upsert:completed").unwrap();
    assert!(starting < running);
    assert!(running < completed);
}

#[test]
fn final_output_jobs_read_from_outcome_and_never_from_a_buffer() {
    let session = test_session("final-output");
    let key = global_job_registry()
        .start(subagent_start(&session, Some("child-1"), "delegate"))
        .unwrap();

    global_job_registry().settle(&session, &key, JobOutcome {
        status: SettledStatus::Completed,
        detail: None,
        output: Some("the report".into()),
    });

    let read = global_job_registry().read(&session, &key, Reader::Model).unwrap();
    assert_eq!(read.text, "the report");
    let again = global_job_registry().read(&session, &key, Reader::Model).unwrap();
    assert_eq!(again.text, "the report");
}

#[test]
fn session_fence_hides_other_sessions_from_listing() {
    let session = test_session("fence");
    start_streaming(&session, "bash", "mine").unwrap();
    assert!(global_job_registry().list_session(&test_session("fence-other")).is_empty());
    assert_eq!(global_job_registry().list_session(&session).len(), 1);
}
