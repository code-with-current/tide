//! jobs — the session-scoped background-job registry.
//!
//! One [`JobRegistry`](api::JobRegistry) owns every piece of background
//! work in the process, keyed by owner session inside a single mutex (the
//! tools crate is sync; callers bridge with their runtime, the same
//! discipline `ShellRegistry` follows). Producers call
//! [`JobRegistry::start`](api::JobRegistry::start) with a synchronous
//! starter that returns [`JobHooks`]; the registry owns ids, status,
//! settlement, admission, and observation. Consumers read through
//! [`Reader::Model`](api::Reader::Model) (the model's consuming
//! `job_output` cursor) or [`Reader::Ui`](api::Reader::Ui) (the
//! `OutputDelta` pusher) — two cursors over one ring buffer, never shared
//! (design decision 6).
//!
//! Engine-free and driver-free: the registry talks to the orchestrator
//! through two injected per-session closures — the event sink (wire
//! `BackgroundWorkEvent`s) and the wake listener (settlement notices) — and
//! imports only protocol types. Jobs die only by
//! [`job_kill`](api::JobRegistry::kill), session close, or daemon teardown
//! (design decision 4: they are never tied to the spawning turn's abort
//! flag).

mod api;
mod wake;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use protocol::model::{
    BackgroundWorkEvent, BackgroundWorkItem, BackgroundWorkKey, BackgroundWorkStatus,
};

pub use api::{
    global_job_registry, JobError, JobHandle, JobHooks, JobOutcome, JobOutputSink, JobRead,
    JobRegistry, JobStart, KillOutcome, Reader, SettledStatus,
};
pub use wake::{JobNotice, JobWake, NoticeSource, WakeListener};

/// Default live-job budget per owner session (design decision 8).
pub const DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER: usize = 10;
/// Default per-job stream-buffer cap — the 256 KB ring.
pub const DEFAULT_STREAM_BUFFER_BYTES: usize = 256 * 1024;

/// Validated construction-time configuration. Defaults are correct without
/// a settings surface; wiring one is a later, optional slice.
#[derive(Clone, Debug)]
pub struct JobRegistryConfig {
    /// Live jobs (`Starting`/`Running`/`Stopping`) admitted per owner
    /// session before [`JobRegistry::start`](api::JobRegistry::start)
    /// rejects with [`JobError::AdmissionLimit`].
    pub max_concurrent_jobs_per_owner: usize,
    /// Per-job stream-buffer cap in bytes (the ring `push` trims to).
    pub stream_buffer_bytes: usize,
}

impl Default for JobRegistryConfig {
    fn default() -> Self {
        Self {
            max_concurrent_jobs_per_owner: DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER,
            stream_buffer_bytes: DEFAULT_STREAM_BUFFER_BYTES,
        }
    }
}

/// Everything behind the registry's single mutex.
pub struct Shared {
    pub config: JobRegistryConfig,
    pub state: Mutex<State>,
    /// Runtime handle for watch-based waits and the `close_session` reaper;
    /// `None` falls back to bounded polling on the calling thread.
    pub runtime: Mutex<Option<tokio::runtime::Handle>>,
}

pub struct State {
    /// Per-session records, insertion order, counters, and seams.
    pub sessions: HashMap<String, SessionRegistry>,
    /// Session insertion order, so producer `settle` calls scan
    /// deterministically.
    pub session_order: Vec<String>,
}

/// One session's slice of the registry. The UI reorders freely; the
/// registry preserves registration order.
pub struct SessionRegistry {
    /// This slice's session id — the tool-call fence value.
    pub items: HashMap<BackgroundWorkKey, JobRecord>,
    pub order: Vec<BackgroundWorkKey>,
    /// Per-prefix id counters — `bash` and `sub` mint independently.
    pub counters: HashMap<&'static str, u64>,
    /// Set once at wiring: receives every
    /// `Upsert`/`OutputDelta`/`StopRequested`/`StopFailed`. Must be quick
    /// and must not re-enter the registry (it is invoked under the lock so
    /// event order matches commit order).
    pub event_sink: Option<EventSink>,
    /// Set once at wiring: runs after a settlement commits, after the lock
    /// drops, contained. May open a turn, so it must never be invoked under
    /// the lock.
    pub waker: Option<WakeListenerSlot>,
}

impl SessionRegistry {
    pub(crate) fn new(_session_id: &str) -> Self {
        Self {
            items: HashMap::new(),
            order: Vec::new(),
            counters: HashMap::new(),
            event_sink: None,
            waker: None,
        }
    }
}

/// `Box<dyn Fn(..) + Send>` seam set once per session beside the state —
/// cloned out as an `Arc` so listeners can run after the lock drops.
pub(crate) type EventSink = Arc<dyn Fn(BackgroundWorkEvent) + Send + Sync>;
pub(crate) type WakeListenerSlot = Arc<dyn Fn(JobNotice) + Send + Sync>;

pub struct JobRecord {
    pub(crate) key: BackgroundWorkKey,
    pub(crate) label: String,
    /// Producer-owned cap on model-facing reads (the UI cursor is not
    /// limited).
    pub(crate) output_limit: Option<usize>,
    pub(crate) status: BackgroundWorkStatus,
    pub(crate) detail: Option<String>,
    pub(crate) started_at_ms: u64,
    pub(crate) finished_at_ms: Option<u64>,
    /// Set by kill, a terminal Model read, a settled Model wait, or a
    /// teardown cancel; the wake listener skips reported jobs.
    pub(crate) reported: bool,
    /// Stream jobs append through the sink; final-output jobs leave it
    /// unset and serve `output` instead.
    pub(crate) buffer: Option<Arc<JobBuffer>>,
    /// Final-output jobs store their result once at settlement.
    pub(crate) output: Option<String>,
    pub(crate) hooks: Option<JobHooks>,
    /// Settlement fan-out: `settle` sends the first outcome here (releasing
    /// `wait` promptly) and the cached value doubles as the first-wins
    /// check.
    pub(crate) settled: (
        tokio::sync::watch::Sender<Option<JobOutcome>>,
        tokio::sync::watch::Receiver<Option<JobOutcome>>,
    ),
}

impl JobRecord {
    pub(crate) fn is_live(&self) -> bool {
        self.status.is_live()
    }

    pub(crate) fn is_terminal(&self) -> bool {
        !self.is_live()
    }

    /// Project a fresh wire snapshot; never hands out registry state.
    pub(crate) fn snapshot(&self) -> BackgroundWorkItem {
        let mut item = BackgroundWorkItem::new(
            self.key.kind,
            self.key.provider_id.clone(),
            self.label.clone(),
            self.status,
        );
        item.detail.clone_from(&self.detail);
        item.started_at_ms = self.started_at_ms;
        if let Some(finished) = self.finished_at_ms {
            item.duration_ms = Some(finished.saturating_sub(self.started_at_ms));
        }
        item.background = true;
        item.can_stop = self.status.is_stoppable();
        // One rule everywhere: the job id is the provider_id is the
        // control_id (design decision 10).
        item.control_id = Some(self.key.provider_id.clone());
        if self.output.is_some() {
            item.output.clone_from(&self.output);
        }
        item
    }
}

/// Two-cursor ring buffer over one job's stream output. `push` trims from
/// the front past the cap and min-clamps both cursors, so neither reader
/// ever sees out-of-bounds bytes or advances the other's cursor (the
/// discipline `ShellRegistry` applied to its single cursor).
pub struct JobBuffer {
    inner: Mutex<BufferState>,
}

struct BufferState {
    text: String,
    model_cursor: usize,
    ui_cursor: usize,
    cap: usize,
}

impl JobBuffer {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            inner: Mutex::new(BufferState {
                text: String::new(),
                model_cursor: 0,
                ui_cursor: 0,
                cap: cap.max(1),
            }),
        }
    }

    /// Append text, trimming from the front past the cap on a char
    /// boundary and min-clamping BOTH cursors by the trimmed amount.
    pub(crate) fn push(&self, bytes: &str) {
        let mut state = self.inner.lock().unwrap();
        state.text.push_str(bytes);
        if state.text.len() > state.cap {
            let overflow = state.text.len() - state.cap;
            let mut cut = overflow;
            while cut < state.text.len() && !state.text.is_char_boundary(cut) {
                cut += 1;
            }
            state.text.drain(..cut);
            state.model_cursor = state.model_cursor.saturating_sub(cut).min(state.text.len());
            state.ui_cursor = state.ui_cursor.saturating_sub(cut).min(state.text.len());
        }
    }

    /// Consume the delta since the model cursor's last read, advancing only
    /// that cursor and clamping to the job's remaining `output_limit`.
    pub(crate) fn read_model(&self, output_limit: Option<usize>) -> String {
        let BufferState {
            text, model_cursor, ..
        } = &mut *self.inner.lock().unwrap();
        read_at(model_cursor, text, output_limit)
    }

    /// Consume the delta since the UI cursor's last read, advancing only
    /// that cursor. Never limited: the UI stream is not the model's read.
    pub(crate) fn read_ui(&self) -> String {
        let BufferState {
            text, ui_cursor, ..
        } = &mut *self.inner.lock().unwrap();
        read_at(ui_cursor, text, None)
    }
}

fn read_at(cursor: &mut usize, text: &mut String, limit: Option<usize>) -> String {
    let start = (*cursor).min(text.len());
    let end = text.len();
    let mut delta = text[start..end].to_string();
    if let Some(limit) = limit {
        let remaining = limit.saturating_sub(start);
        if delta.len() > remaining {
            let mut cut = remaining.min(delta.len());
            while cut > 0 && !delta.is_char_boundary(cut) {
                cut -= 1;
            }
            delta.truncate(cut);
        }
    }
    *cursor = start + delta.len();
    delta
}

/// Producer-side resource-release signal (design: "watch channel; settles
/// after resources release"). Resolve exactly once when the job's
/// resources are gone; `kill`'s cancel hook must cause a resolve, and the
/// `close_session` reaper awaits it bounded before force-failing
/// stragglers.
#[derive(Clone)]
pub struct JobDone {
    inner: Arc<DoneInner>,
}

struct DoneInner {
    tx: tokio::sync::watch::Sender<Option<JobOutcome>>,
    rx: tokio::sync::watch::Receiver<Option<JobOutcome>>,
    resolved: AtomicBool,
}

impl JobDone {
    pub fn new() -> Self {
        let (tx, rx) = tokio::sync::watch::channel(None);
        Self {
            inner: Arc::new(DoneInner {
                tx,
                rx,
                resolved: AtomicBool::new(false),
            }),
        }
    }

    /// First-wins resolve; later resolves are ignored.
    pub fn resolve(&self, outcome: JobOutcome) {
        if !self.inner.resolved.swap(true, Ordering::SeqCst) {
            let _ = self.inner.tx.send(Some(outcome));
        }
    }

    /// Bounded blocking wait — the reaper's fallback thread and
    /// `spawn_blocking` path. `None` when `timeout` elapses unresolved.
    pub(crate) fn wait_bounded(&self, timeout: Duration) -> Option<JobOutcome> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if let Some(outcome) = self.inner.rx.borrow().clone() {
                return Some(outcome);
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Default for JobDone {
    fn default() -> Self {
        Self::new()
    }
}
