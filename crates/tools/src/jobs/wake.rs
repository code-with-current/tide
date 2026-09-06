//! The wake seam: settlement notices delivered to the orchestrator, which
//! owns lane policy (idle vs busy) and the wake budget — loop state the
//! registry must not see.

use protocol::model::BackgroundWorkItem;

/// One settlement notice rendered by the registry and routed by the
/// orchestrator's [`JobWake`] implementation.
#[derive(Clone)]
pub struct JobNotice {
    /// `background job {id} finished [status: ...]. Read its output with
    /// job_output.`
    pub text: String,
    /// The terminal snapshot (the model fetches output via `job_output`).
    pub snapshot: BackgroundWorkItem,
    pub source: NoticeSource,
}

/// Where a notice came from. One variant today; the enum keeps the door
/// open for non-job notices without a wire change.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NoticeSource {
    Job,
}

/// The registry's view of the loop. Implemented by the orchestrator beside
/// the driver's `Inner`; injected via `JobRegistry::set_waker`'s listener.
pub trait JobWake: Send + Sync {
    /// True while the session's loop is between turns.
    fn is_idle(&self) -> bool;
    /// Busy lane: the notice lands at the running turn's next step boundary.
    fn inject_step(&self, notice: JobNotice);
    /// Idle lane: the notice opens a follow-up turn. Returns `false` when
    /// the wake budget refuses; the caller then falls back to
    /// [`JobWake::inject_step`].
    fn wake_turn(&self, notice: JobNotice) -> bool;
}

/// Contained settlement listener installed by the orchestrator.
pub type WakeListener = Box<dyn Fn(JobNotice) + Send>;
