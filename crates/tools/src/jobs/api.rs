//! The registry's public operations: start, read, wait, kill, list, settle,
//! close, and the two injected observation seams (event sink, wake listener).
//!
//! Locking discipline: the state lock guards registration, status, and
//! settlement ordering. `start` holds it across `run` — the starter is
//! contractually quick and non-blocking — so an instantly-finishing producer
//! cannot reorder `Starting → Running → terminal`. The output sink is the
//! one exception: it locks only the job's own buffer mutex, so `run` may
//! append freely while `start` holds the registry lock.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use protocol::model::{
    BackgroundWorkEvent, BackgroundWorkItem, BackgroundWorkKey, BackgroundWorkKind,
    BackgroundWorkStatus,
};

use super::wake::{JobNotice, NoticeSource};
use super::{JobBuffer, JobDone, Shared, State};
use crate::AbortFlag;

/// The process-global background-job registry. Tools resolve jobs through it
/// with `ToolContext::session_id` as the fence — the same shape
/// `global_shell_registry()` established.
pub fn global_job_registry() -> &'static JobRegistry {
    static GLOBAL: OnceLock<JobRegistry> = OnceLock::new();
    GLOBAL.get_or_init(|| JobRegistry {
        shared: Arc::new(Shared {
            config: super::JobRegistryConfig::default(),
            state: Mutex::new(State {
                sessions: HashMap::new(),
                session_order: Vec::new(),
            }),
            runtime: Mutex::new(None),
        }),
    })
}

/// Handle to the process-global background-job registry.
#[derive(Clone)]
pub struct JobRegistry {
    pub(crate) shared: Arc<Shared>,
}

fn state_lock() -> std::sync::MutexGuard<'static, State> {
    let registry = global_job_registry();
    registry.shared.state.lock().unwrap()
}

fn runtime_lock() -> std::sync::MutexGuard<'static, Option<tokio::runtime::Handle>> {
    let registry = global_job_registry();
    registry.shared.runtime.lock().unwrap()
}

// All state lives in `Shared`/`State`/`SessionRegistry` (see mod.rs); the
// handle is a zero-sized marker because the registry is a process global.

/// Producer declaration passed to
/// [`JobRegistry::start`](global_job_registry().start). The registry
/// completes preflight (validation, admission) before invoking
/// [`JobStart::run`] and commits the registration without a later failable
/// step.
pub struct JobStart {
    /// Wire discriminator.
    pub kind: BackgroundWorkKind,
    /// Id namespace (`bash`, `sub`); minted ids are `<prefix>-N`.
    pub prefix: &'static str,
    /// Adopt a producer-native id (a dispatched child's `child_id`) instead
    /// of minting one.
    pub id: Option<String>,
    /// One-line model-facing label (the command; the dispatch task).
    pub label: String,
    /// Owning session; jobs are fenced to it.
    pub owner_session: String,
    /// Producer-owned cap on model-facing reads and completion notices.
    pub output_limit: Option<usize>,
    /// Whether the job streams output through [`JobHandle::output`].
    /// `false` declares a final-output job: reads come from
    /// [`JobOutcome::output`] after settlement.
    pub streams: bool,
    /// Start the work; quick and non-blocking, no awaits. Called once under
    /// the registry lock. A panic or error settles the record `Failed` —
    /// nothing vanishes silently and the counter is still consumed.
    pub run: Box<dyn FnOnce(&JobHandle) -> Result<JobHooks, String> + Send>,
}

/// Hooks through which the registry controls and observes producer work.
pub struct JobHooks {
    /// Request termination. Synchronous, idempotent, must cause `done` to
    /// resolve. The reason is forwarded verbatim.
    pub cancel: Box<dyn FnOnce(Option<String>) + Send>,
    /// The producer's copy of the done handle; resolve it when the
    /// producer has released its resources.
    pub done: JobDone,
}

/// Terminal result resolved by a producer through its done handle.
#[derive(Clone, Debug)]
pub struct JobOutcome {
    /// `Completed` finished on its own; `Stopped` was cancelled; `Failed`
    /// broke.
    pub status: SettledStatus,
    /// Kind-specific status detail (`exit code: 3`).
    pub detail: Option<String>,
    /// Final output for jobs without a stream buffer.
    pub output: Option<String>,
}

/// The subset of status values a producer settles with.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettledStatus {
    Completed,
    Failed,
    Stopped,
}

impl SettledStatus {
    fn wire(self) -> BackgroundWorkStatus {
        match self {
            SettledStatus::Completed => BackgroundWorkStatus::Completed,
            SettledStatus::Failed => BackgroundWorkStatus::Failed,
            SettledStatus::Stopped => BackgroundWorkStatus::Stopped,
        }
    }
}

/// Which consuming cursor a read advances.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reader {
    /// The model's `job_output` cursor. A terminal read marks the job
    /// reported — this read *is* the completion delivery.
    Model,
    /// The UI's `OutputDelta` cursor. Never changes `reported`; the UI is
    /// not the model's reader.
    Ui,
}

/// Output plus the post-read snapshot returned by a read.
pub struct JobRead {
    /// Stream kinds: the delta since this reader's previous read. Final-
    /// output kinds: the stored result, idempotent after settlement.
    pub text: String,
    pub snapshot: BackgroundWorkItem,
}

/// Why a kill did what it did.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KillOutcome {
    /// Cancel was requested; the job settles `Stopped` when its hooks finish.
    Requested,
    /// The job was already terminal; its settled snapshot stands.
    AlreadyFinished,
    /// No such job in this registry.
    Unknown,
}

/// Typed start/lookup failures. `Display` renders the model-facing copy.
#[derive(Debug, thiserror::Error)]
pub enum JobError {
    #[error(
        "background job limit reached for this session (limit: {limit}); kill one with job_kill, wait for it to finish, then retry"
    )]
    AdmissionLimit { limit: usize },
    #[error("unknown job {0}")]
    Unknown(String),
    #[error("job {0} belongs to another session")]
    Foreign(String),
    #[error("{0}")]
    Invalid(String),
}

/// The per-job handle handed to a producer's `run`.
pub struct JobHandle {
    pub key: BackgroundWorkKey,
    /// Stream output sink — appends into the job's ring buffer. Locks only
    /// the buffer, never the registry state. A no-op for final-output jobs.
    pub output: JobOutputSink,
    /// Clone this into [`JobHooks::done`]; resolve it when the producer has
    /// released its resources.
    pub done: JobDone,
}

/// Appends stream bytes into one job's ring buffer.
#[derive(Clone)]
pub struct JobOutputSink {
    buffer: Option<Arc<JobBuffer>>,
}

impl JobOutputSink {
    pub fn append(&self, bytes: &str) {
        if let Some(buffer) = &self.buffer {
            buffer.push(bytes);
        }
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic".into()
    }
}

fn render_notice(snapshot: &BackgroundWorkItem) -> String {
    let detail = snapshot
        .detail
        .as_ref()
        .map(|detail| format!(", {detail}"))
        .unwrap_or_default();
    let status = match snapshot.status {
        BackgroundWorkStatus::Starting => "starting",
        BackgroundWorkStatus::Running => "running",
        BackgroundWorkStatus::Stopping => "stopping",
        BackgroundWorkStatus::Completed => "completed",
        BackgroundWorkStatus::Failed => "failed",
        BackgroundWorkStatus::Stopped => "stopped",
        BackgroundWorkStatus::Lost => "lost",
    };
    format!(
        "background job {} finished [status: {status}{detail}]. Read its output with job_output.",
        snapshot.key.provider_id
    )
}

impl JobRegistry {
    /// Wire the session's event sink. Called once at driver construction;
    /// the sink is invoked while the registry lock is held so event order
    /// matches commit order, and must therefore be quick and non-blocking.
    pub fn set_event_sink(
        &self,
        session: &str,
        sink: Box<dyn Fn(BackgroundWorkEvent) + Send + Sync>,
    ) {
        let mut state = state_lock();
        state
            .sessions
            .entry(session.to_string())
            .or_insert_with(|| super::SessionRegistry::new(session))
            .event_sink = Some(Arc::new(sink));
    }

    /// Wire the session's wake listener. Called once at driver construction.
    pub fn set_waker(
        &self,
        session: &str,
        listener: Box<dyn Fn(JobNotice) + Send + Sync>,
    ) {
        let mut state = state_lock();
        state
            .sessions
            .entry(session.to_string())
            .or_insert_with(|| super::SessionRegistry::new(session))
            .waker = Some(Arc::new(listener));
    }

    /// Runtime handle for `close_session`'s reaper task.
    pub fn set_runtime(&self, handle: tokio::runtime::Handle) {
        *runtime_lock() = Some(handle);
    }

    /// Runtime handle accessor for stages that must spawn bounded reapers.
    pub fn runtime(&self) -> Option<tokio::runtime::Handle> {
        runtime_lock().clone()
    }

    fn emit(session_registry: &super::SessionRegistry, event: BackgroundWorkEvent) {
        if let Some(sink) = &session_registry.event_sink {
            sink(event);
        }
    }

    /// Emit through the named session's sink; no-op for unknown sessions.
    fn emit_named(&self, session: &str, event: BackgroundWorkEvent) {
        if let Some(session_registry) = state_lock().sessions.get(session) {
            Self::emit(session_registry, event);
        }
    }

    /// Preflight, admit, register, and start work — atomically under the
    /// state lock. Any rejection leaves no id and no record; a failed
    /// `run` settles the record `Failed` and still consumes the counter.
    pub fn start(&self, spec: JobStart) -> Result<BackgroundWorkKey, JobError> {
        if spec.label.trim().is_empty() {
            return Err(JobError::Invalid("job label must not be empty".into()));
        }
        if let Some(limit) = spec.output_limit {
            if limit == 0 {
                return Err(JobError::Invalid("output_limit must be positive".into()));
            }
        }
        let kind = match spec.prefix {
            "bash" => BackgroundWorkKind::Process,
            "sub" => BackgroundWorkKind::Subagent,
            other => return Err(JobError::Invalid(format!("unknown job prefix {other}"))),
        };

        // The lock is held across registration and `run`; the settle bridge
        // queues on this same lock, so event order is Starting → Running →
        // terminal even for an instantly-finishing producer.
        let mut state = state_lock();
        let config = &self.shared.config;
        let session_registry = state
            .sessions
            .entry(spec.owner_session.clone())
            .or_insert_with(|| super::SessionRegistry::new(&spec.owner_session));

        let live = session_registry
            .items
            .values()
            .filter(|record| record.is_live())
            .count();
        if live >= config.max_concurrent_jobs_per_owner {
            return Err(JobError::AdmissionLimit {
                limit: config.max_concurrent_jobs_per_owner,
            });
        }

        let counter = session_registry.counters.entry(spec.prefix).or_insert(0);
        *counter += 1;
        let id = spec
            .id
            .clone()
            .unwrap_or_else(|| format!("{}-{}", spec.prefix, counter));
        // Decision 10: a subagent job's id IS the child's durable id, and a
        // resumed child re-registers under it. A live record with that id is
        // a real collision (the child is already running); a terminal one is
        // the child's previous run and is replaced in place — its order slot
        // is kept so the panel's registration order survives the resume.
        let mut replaces_terminal = false;
        if let Some(existing_key) = session_registry
            .items
            .keys()
            .find(|key| key.provider_id == id)
            .cloned()
        {
            let record = session_registry.items.get(&existing_key).unwrap();
            if record.is_live() {
                return Err(JobError::Invalid(format!("job id {id} already exists")));
            }
            session_registry.items.remove(&existing_key);
            replaces_terminal = true;
        }

        let key = BackgroundWorkKey { kind, provider_id: id };
        let buffer = spec.streams.then(|| Arc::new(JobBuffer::new(config.stream_buffer_bytes)));
        let record = super::JobRecord {
            key: key.clone(),
            label: spec.label,
            output_limit: spec.output_limit,
            status: BackgroundWorkStatus::Starting,
            detail: None,
            started_at_ms: unix_ms(),
            finished_at_ms: None,
            reported: false,
            buffer: buffer.clone(),
            output: None,
            hooks: None,
            settled: tokio::sync::watch::channel(None),
        };
        session_registry.items.insert(key.clone(), record);
        if !replaces_terminal {
            session_registry.order.push(key.clone());
        }
        let snapshot = session_registry.items[&key].snapshot();
        Self::emit(session_registry, BackgroundWorkEvent::Upsert(snapshot));

        let producer_done = JobDone::new();
        let handle = JobHandle {
            key: key.clone(),
            output: JobOutputSink { buffer },
            done: producer_done.clone(),
        };
        let started =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (spec.run)(&handle)));

        match started {
            Ok(Ok(hooks)) => {
                let record = session_registry.items.get_mut(&key).unwrap();
                record.hooks = Some(hooks);
                record.status = BackgroundWorkStatus::Running;
                let snapshot = record.snapshot();
                Self::emit(session_registry, BackgroundWorkEvent::Upsert(snapshot));
            }
            Ok(Err(message)) => {
                let record = session_registry.items.get_mut(&key).unwrap();
                record.status = BackgroundWorkStatus::Failed;
                record.detail = Some(message);
                record.finished_at_ms = Some(unix_ms());
                let snapshot = record.snapshot();
                Self::emit(session_registry, BackgroundWorkEvent::Upsert(snapshot));
                return Err(JobError::Invalid("job start failed".into()));
            }
            Err(panic) => {
                let message = panic_message(panic.as_ref());
                let record = session_registry.items.get_mut(&key).unwrap();
                record.status = BackgroundWorkStatus::Failed;
                record.detail = Some(format!("job start panicked: {message}"));
                record.finished_at_ms = Some(unix_ms());
                let snapshot = record.snapshot();
                Self::emit(session_registry, BackgroundWorkEvent::Upsert(snapshot));
                return Err(JobError::Invalid("job start panicked".into()));
            }
        }

        // Bridge the producer's done resolution into `settle` from a detached
        // thread: the bridge queues on the state lock, so a same-tick settle
        // still commits after the `Running` flip above.
        let bridge = self.clone();
        let bridge_key = key.clone();
        let bridge_session = spec.owner_session.clone();
        let _ = std::thread::Builder::new()
            .name(format!("jobs-settle-{}", key.provider_id))
            .spawn(move || loop {
                if let Some(outcome) = producer_done.wait_bounded(Duration::from_secs(60)) {
                    bridge.settle(&bridge_session, &bridge_key, outcome);
                    break;
                }
            });
        Ok(key)
    }

    /// Read the next delta for `reader`, fenced to `session`. A terminal
    /// Model read marks the job reported.
    pub fn read(
        &self,
        session: &str,
        key: &BackgroundWorkKey,
        reader: Reader,
    ) -> Result<JobRead, JobError> {
        let mut state = state_lock();
        let session_registry = state
            .sessions
            .get_mut(session)
            .ok_or_else(|| JobError::Unknown(key.provider_id.clone()))?;
        let record = session_registry
            .items
            .get_mut(key)
            .ok_or_else(|| JobError::Unknown(key.provider_id.clone()))?;
        let text = match (&record.buffer, reader) {
            (Some(buffer), Reader::Model) => buffer.read_model(record.output_limit),
            (Some(buffer), Reader::Ui) => buffer.read_ui(),
            (None, _) => record.output.clone().unwrap_or_default(),
        };
        if record.is_terminal() && reader == Reader::Model {
            record.reported = true;
        }
        Ok(JobRead { text, snapshot: record.snapshot() })
    }

    /// Wait for settlement, timeout, or abort — the job is never touched by
    /// a timeout or an abort. A settled Model wait marks the job reported.
    /// Synchronous: tool bodies run under `spawn_blocking`.
    pub fn wait(
        &self,
        session: &str,
        key: &BackgroundWorkKey,
        timeout: Duration,
        abort: &AbortFlag,
        reader: Reader,
    ) -> Result<BackgroundWorkItem, JobError> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let mut state = state_lock();
                if let Some(record) = state
                    .sessions
                    .get_mut(session)
                    .and_then(|session_registry| session_registry.items.get_mut(key))
                {
                    if record.is_terminal() {
                        if reader == Reader::Model {
                            record.reported = true;
                        }
                        return Ok(record.snapshot());
                    }
                }
            }
            if abort.is_aborted() || Instant::now() >= deadline {
                let state = state_lock();
                return state
                    .sessions
                    .get(session)
                    .and_then(|session_registry| session_registry.items.get(key))
                    .map(|record| record.snapshot())
                    .ok_or_else(|| JobError::Unknown(key.provider_id.clone()));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Request cancellation. Sets `Stopping` + `reported`, emits the
    /// `Stopping` snapshot, calls the producer's cancel hook, then emits
    /// `StopRequested` for the UI path.
    pub fn kill(
        &self,
        session: &str,
        key: &BackgroundWorkKey,
        reason: Option<String>,
    ) -> Result<KillOutcome, JobError> {
        let snapshot = {
            let mut state = state_lock();
            let Some(record) = state
                .sessions
                .get_mut(session)
                .and_then(|session_registry| session_registry.items.get_mut(key))
            else {
                return Ok(KillOutcome::Unknown);
            };
            if record.is_terminal() {
                return Ok(KillOutcome::AlreadyFinished);
            }
            record.status = BackgroundWorkStatus::Stopping;
            record.reported = true;
            let snapshot = record.snapshot();
            if let Some(hooks) = record.hooks.take() {
                (hooks.cancel)(reason.clone());
            }
            snapshot
        };
        self.emit_named(session, BackgroundWorkEvent::Upsert(snapshot));
        self.emit_named(session, BackgroundWorkEvent::StopRequested(key.clone()));
        Ok(KillOutcome::Requested)
    }

    /// Snapshots in registration order — feeds `ReconcileLive`.
    pub fn list_session(&self, session: &str) -> Vec<BackgroundWorkItem> {
        let state = state_lock();
        state
            .sessions
            .get(session)
            .map(|session_registry| {
                session_registry
                    .order
                    .iter()
                    .filter_map(|key| session_registry.items.get(key).map(|record| record.snapshot()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Keys of the session's LIVE stream jobs (records with a ring buffer),
    /// in registration order — the orchestrator's `OutputDelta` pusher
    /// polls exactly these. Final-output jobs (no buffer) never appear:
    /// their result is delivered once at settlement, not streamed, so a
    /// pusher that read them would re-emit the same text every tick.
    pub fn ui_stream_keys(&self, session: &str) -> Vec<BackgroundWorkKey> {
        let state = state_lock();
        state
            .sessions
            .get(session)
            .map(|session_registry| {
                session_registry
                    .order
                    .iter()
                    .filter_map(|key| session_registry.items.get(key))
                    .filter(|record| record.buffer.is_some() && record.is_live())
                    .map(|record| record.key.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Commit the first terminal outcome: writes terminal fields, resolves
    /// waiters, emits the terminal `Upsert`, then runs the wake listener
    /// last — after the lock drops — contained. A late producer outcome
    /// cannot overwrite a committed settlement.
    pub fn settle(&self, session: &str, key: &BackgroundWorkKey, outcome: JobOutcome) {
        let (snapshot, notice, waker) = {
            let mut state = state_lock();
            let Some(session_registry) = state.sessions.get_mut(session) else {
                return;
            };
            let Some(record) = session_registry.items.get_mut(key) else {
                return;
            };
            if record.is_terminal() {
                return; // first-wins
            }
            record.status = outcome.status.wire();
            record.detail.clone_from(&outcome.detail);
            if let Some(output) = &outcome.output {
                record.output = Some(output.clone());
            }
            record.finished_at_ms = Some(unix_ms());
            let snapshot = record.snapshot();
            let notice = (!record.reported).then(|| JobNotice {
                text: render_notice(&snapshot),
                snapshot: snapshot.clone(),
                source: NoticeSource::Job,
            });
            let _ = record.settled.0.send(Some(outcome.clone()));
            record.hooks = None;
            (snapshot, notice, session_registry.waker.clone())
        };
        self.emit_named(session, BackgroundWorkEvent::Upsert(snapshot));
        // Announce last, after the lock drops: a reporter may open a turn.
        if let (Some(notice), Some(waker)) = (notice, waker) {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                waker(JobNotice { text: notice.text, snapshot: notice.snapshot, source: notice.source })
            }));
        }
    }

    /// Cancel live hooks synchronously (signals now), then reap bounded:
    /// wait `grace` for each `done`, force-fail stragglers with an orphan
    /// detail, mark everything reported, and emit final `Upsert`s. The
    /// reaper runs on the runtime handle when one is set, else on a plain
    /// thread — the caller (driver `Drop`) may be any thread and must not
    /// `block_on`.
    pub fn close_session(&self, session: &str, grace: Duration) {
        let session = session.to_string();
        let cancels = {
            let mut state = state_lock();
            let Some(session_registry) = state.sessions.get_mut(session.as_str()) else {
                return;
            };
            let mut cancels = Vec::new();
            for record in session_registry.items.values_mut() {
                if record.is_live() {
                    record.reported = true;
                    if let Some(hooks) = record.hooks.take() {
                        (hooks.cancel)(Some("session closed".into()));
                        cancels.push((record.key.clone(), hooks.done));
                    }
                }
            }
            cancels
        };
        if cancels.is_empty() {
            return;
        }
        let registry = global_job_registry();
        let reap = move || {
            for (key, producer_done) in cancels {
                let outcome = producer_done
                    .wait_bounded(grace)
                    .unwrap_or(JobOutcome {
                        status: SettledStatus::Failed,
                        detail: Some(
                            "cancel returned during teardown; work may be orphaned".into(),
                        ),
                        output: None,
                    });
                registry.settle(&session, &key, outcome);
            }
        };
        let handle = runtime_lock().clone();
        if let Some(handle) = handle {
            handle.spawn_blocking(reap);
        } else {
            std::thread::Builder::new()
                .name("jobs-close-reaper".into())
                .spawn(reap)
                .ok();
        }
    }
}
