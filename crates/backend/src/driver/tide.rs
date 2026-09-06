//! The embedded Tide provider: engine's streaming completion core plus
//! tools' builtin toolset, exposed through the `DriverControl` contract
//! like any CLI transport. The whole conversation — history, tool results,
//! permission state — lives in this process; nothing is spawned.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use futures::StreamExt;
use uuid::Uuid;

use crate::driver::hooks::{HookChain, PendingToolCall, StepInputChain, ToolGate};
use crate::driver::inbox::{StepMessage, TurnInbox};
use crate::driver::{DriverEventSender, DriverStartOptions, SessionOptions};
use crate::model::{
    ActivityAgent, ActivityKind, AgentSession, CompactionRecord, DriverEvent, InteractionMode,
    MessageRole, ProviderResumeCursor, UsageBreakdown, UserInputAnswer, UserInputOption,
    UserInputQuestion,
};
use engine::{
    EngineError, EngineEvent, EngineModel, EngineModelConfig, EngineStopReason, HistoryMessage,
    HistoryPart, HistoryRole, ProviderApiStyle, ThinkingLevel, ToolSpec, TurnParams, TurnRequest,
    stream_step,
};
use protocol::model::{
    BackgroundWorkEvent, BackgroundWorkItem, BackgroundWorkKey, BackgroundWorkKind,
    BackgroundWorkStatus, SubagentBlock, SubagentToolStatus,
};
use tools::jobs::{
    JobHooks, JobNotice, JobOutcome, JobRegistry, JobStart, JobWake, KillOutcome, Reader,
    SettledStatus, global_job_registry,
};
use tools::permission::{RiskTier, risk_tier_for_call};
use tools::{AbortFlag, TodoState, Tool, ToolConcurrency, ToolContext, ToolDisplay, ToolOutcome};
use tools::{
    DEFAULT_MAX_STEPS, MAX_AGENT_DEPTH, AgentDef, can_dispatch_to, concurrency_for,
    effective_child_tools, get_agent,
};

/// Tide's system prompt, assembled at first use from the vendored prompt set
/// (system fragments + tool guidance + agent catalog) exactly the way tide's
/// bundler (`build/promptMarkdownUtils.mjs`) and its `buildSystemPrompt`
/// wrapper assemble it, so a session here behaves like a session there.
static SYSTEM_PROMPT: LazyLock<String> = LazyLock::new(tools::prompts::system_prompt);

/// The variable tail appended to a loop's system prompt: environment facts
/// the model needs on every request. dsh registers these as prompt
/// variables (`provider`/`model`/`cwd`); Tide composes the same facts as a
/// short markdown section AFTER the static base, so the long cacheable
/// prefix never shifts mid-session — only the tail re-renders.
fn environment_section(cwd: &Path, model_id: &str) -> String {
    format!(
        "\n\n# Environment\n\n- Working directory: {}\n- Date: {}\n- Model: {}",
        cwd.display(),
        chrono::Utc::now().format("%Y-%m-%d"),
        model_id,
    )
}

/// The Plan-mode notice, phrased to match the gate's rejection language
/// (see [`plan_allows`]) so the model's intent matches what the gate
/// enforces. Build is the unstated default and adds nothing.
const PLAN_MODE_SECTION: &str = "\n\n# Interaction mode\n\nPlan mode is active — work is read-only. Explore, read, and analyze; tools that modify anything are blocked. When a change is warranted, present the plan and what you would run; the user switches the mode to Build to execute it.";

/// Compose one loop's system prompt: the static base (or a sub-agent's own
/// prompt) plus the environment tail, plus the Plan-mode notice when the
/// chip is set. Composed per turn — one short format — so the variables
/// stay fresh with no cache to invalidate, in both root loops and
/// dispatched children (they share the workspace and the mode gate).
fn contextualize_system_prompt(
    base: &str,
    cwd: &Path,
    model_id: &str,
    mode: InteractionMode,
) -> String {
    let mut prompt = format!("{base}{}", environment_section(cwd, model_id));
    if mode == InteractionMode::Plan {
        prompt.push_str(PLAN_MODE_SECTION);
    }
    prompt
}

/// Builtin tools whose turn flow is orchestrator-owned in tide; executing
/// them as plain tools here would misbehave, so they stay out of the spec
/// list until this driver grows the matching flows. `ask_followup_question`
/// used to live here too — the driver now parks it on a
/// [`DriverEvent::UserInputRequested`] ask the way the tide orchestrator
/// does (see [`run_followup`]).
const ORCHESTRATOR_OWNED_TOOLS: [&str; 2] = ["exit_plan_mode", "compact"];

const MAX_STEPS: usize = 100;

/// Ceiling on concurrently-running parallel-safe calls within one step.
/// Mirrors dsh's `maxParallelToolCalls` default shape: overlap reads
/// without letting a wide tool batch saturate the blocking pool.
const MAX_PARALLEL_TOOL_CALLS: usize = 4;

/// How many dispatched children stay resumable per session. Oldest
/// non-running children are evicted when the cap is exceeded.
const MAX_CHILDREN: usize = 8;

/// Per-child inbox depth cap (live step queue + parked mailbox): a pair of
/// agents messaging in a loop must not grow unbounded.
const MAX_CHILD_INBOX_DEPTH: usize = 32;

/// Consecutive turns the wake may open on an unattended session before it
/// degrades to the inject lane — the notice-storm valve (design decision 3).
/// Refilled only by a User-tagged message at the prompt-entry point.
const MAX_CONSECUTIVE_WAKES: u32 = 3;

/// How long a background job's cancel hook gets during session teardown
/// before the reaper force-fails it as orphaned.
const JOB_CLOSE_GRACE: Duration = Duration::from_secs(5);

/// Cadence of the session-lifetime `OutputDelta` pusher. Deliberately
/// independent of the UI's own `output_refresh_delay` throttling: the
/// daemon push cadence and the UI refresh cadence are separate dials
/// (design, Buffers bullet).
const OUTPUT_PUSH_INTERVAL: Duration = Duration::from_millis(250);

/// Occupancy fraction of the context window at which a turn-start
/// compaction runs (dsh compaction-basic's pressure trigger, Rust-shaped).
const COMPACTION_PRESSURE: f64 = 0.85;
/// User turns of tool results pruning never touches (recency window — the
/// tide TS stub's `DEFAULT_KEEP_LAST = 6`).
const COMPACT_KEEP_TURNS: usize = 6;
/// A tool result must exceed this many chars before pruning considers it.
const PRUNE_MIN_CHARS: usize = 2048;
/// Head/tail chars a pruned result keeps around the omission note.
const PRUNE_KEEP_CHARS: usize = 200;
/// The post-compaction tail targets this fraction of the window (chars
/// budget = fraction × window × the chars-per-token estimate).
const COMPACT_TAIL_FRACTION: f64 = 0.25;
/// Rough chars-per-token estimate for size math (measurement only — the
/// provider's own usage stays the authoritative anchor).
const EST_CHARS_PER_TOKEN: f64 = 4.0;
/// Cap on the rendered range handed to the summarizer, so the summary call
/// itself fits any window the session could have had.
const SUMMARY_RENDER_CAP_CHARS: usize = 160_000;

/// One dispatched child's live state, kept warm in the driver's registry so
/// it can be resumed (`resumeFrom`), messaged (`send_message`), and listed
/// (`list_agents`). The Arc'd pieces are shared between the registry and
/// the child's running loop.
struct ChildState {
    agent_name: String,
    title: String,
    key: BackgroundWorkKey,
    history: Arc<Mutex<Vec<HistoryMessage>>>,
    blocks: Arc<Mutex<Vec<SubagentBlock>>>,
    /// The child's own step-boundary inbox — delivered messages land here
    /// exactly like steering on the root loop.
    inbox: Arc<TurnInbox>,
    /// Messages that arrived while the child was stopped; drained into its
    /// history on resume, annotated on its timeline.
    mailbox: Arc<Mutex<VecDeque<StepMessage>>>,
    status: Arc<Mutex<BackgroundWorkStatus>>,
}

impl ChildState {
    fn new(agent_name: String, title: String, key: BackgroundWorkKey) -> Self {
        Self {
            agent_name,
            title,
            key,
            history: Arc::new(Mutex::new(Vec::new())),
            blocks: Arc::new(Mutex::new(Vec::new())),
            inbox: Arc::new(TurnInbox::new()),
            mailbox: Arc::new(Mutex::new(VecDeque::new())),
            status: Arc::new(Mutex::new(BackgroundWorkStatus::Completed)),
        }
    }
}

/// The session's dispatched children: id → live state plus insertion order
/// for listing and LRU eviction. The registry IS the roster the messaging
/// tools read.
#[derive(Default)]
struct Children {
    map: HashMap<String, Arc<ChildState>>,
    order: VecDeque<String>,
}

impl Children {
    /// Insert a child, evicting the oldest non-running one past the cap.
    fn insert(&mut self, id: String, state: Arc<ChildState>) {
        if self.map.len() >= MAX_CHILDREN {
            let victim = self.order.iter().find(|id| {
                self.map.get(*id).is_some_and(|state| {
                    *state.status.lock().unwrap() != BackgroundWorkStatus::Running
                })
            });
            if let Some(victim) = victim.cloned() {
                self.map.remove(&victim);
                self.order.retain(|id| *id != victim);
            }
        }
        self.order.push_back(id.clone());
        self.map.insert(id, state);
    }

    fn get(&self, id: &str) -> Option<Arc<ChildState>> {
        self.map.get(id).cloned()
    }

    /// Children in dispatch order.
    fn snapshot(&self) -> Vec<(String, Arc<ChildState>)> {
        self.order
            .iter()
            .filter_map(|id| self.map.get(id).map(|s| (id.clone(), Arc::clone(s))))
            .collect()
    }
}

/// The orchestrator's [`JobWake`] implementation — the loop policy the
/// registry must not see (design decision 3): advisory idle detection, the
/// busy lane (step injection), and the idle lane (turn claim + budget).
///
/// Holds `Inner` through a `Weak` set right after construction — the wake
/// is created before `Inner` is (it lives inside it) and must never keep a
/// dropped driver alive through the process-global registry's waker slot.
pub(crate) struct OrchestratorWake {
    inner: OnceLock<std::sync::Weak<Inner>>,
    /// Consecutive wake-opened turns left. Spent by a successful
    /// [`JobWake::wake_turn`], refilled only by a `User`-tagged message at
    /// the prompt-entry point.
    wake_budget: AtomicU32,
}

impl OrchestratorWake {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: OnceLock::new(),
            wake_budget: AtomicU32::new(MAX_CONSECUTIVE_WAKES),
        })
    }

    /// Bind the wake to its `Inner`. Called once at driver construction,
    /// before the registry can reach the wake.
    fn attach(&self, inner: &Arc<Inner>) {
        let _ = self.inner.set(Arc::downgrade(inner));
    }

    fn with_inner<R>(&self, f: impl FnOnce(&Arc<Inner>) -> R, default: R) -> R {
        match self.inner.get().and_then(std::sync::Weak::upgrade) {
            Some(inner) => f(&inner),
            None => default,
        }
    }

    /// Spend one unit of the wake budget. `false` when it is exhausted —
    /// the caller degrades to the inject lane.
    fn spend_budget(&self) -> bool {
        let mut current = self.wake_budget.load(Ordering::Acquire);
        loop {
            if current == 0 {
                return false;
            }
            match self.wake_budget.compare_exchange(
                current,
                current - 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(observed) => current = observed,
            }
        }
    }

    /// The prompt-entry refill: a consumed `User` message resets the
    /// budget; Job/Agent-tagged messages never do.
    fn refill_on_user_message(&self, message: &StepMessage) {
        if message.source.refills_budget() {
            self.wake_budget
                .store(MAX_CONSECUTIVE_WAKES, Ordering::Release);
        }
    }
}

impl JobWake for OrchestratorWake {
    fn is_idle(&self) -> bool {
        // Advisory lane-picking only — the claim inside wake_turn is the
        // race guard.
        self.with_inner(
            |inner| !inner.turn_active.load(Ordering::Acquire),
            true,
        )
    }

    fn inject_step(&self, notice: JobNotice) {
        self.with_inner(
            |inner| {
                let message = StepMessage::job(notice.text);
                if !inner.inbox.push_step_message(message.clone()) {
                    // No turn is steering right now (the budget refused on
                    // an idle session): queue the notice on the always-open
                    // non-promotable lane. It waits for whichever turn
                    // opens next and never claims one.
                    inner.inbox.inject_message(message);
                }
            },
            (),
        );
    }

    fn wake_turn(&self, notice: JobNotice) -> bool {
        // Budget first: an exhausted valve degrades the caller to inject.
        if !self.spend_budget() {
            return false;
        }
        self.with_inner(
            |inner| {
                // THE prompt() claim — the exact door user prompts open a
                // turn through (see `claim_and_spawn_turn`). Never
                // push-then-spawn and never spawn unclaimed: an unclaimed
                // spawn would put two turn loops on one `Inner` (each
                // `run_turn` resets the abort flag), and a pushed copy that
                // also spawned would run again when the turn drains its
                // queue at the end.
                claim_and_spawn_turn(inner, StepMessage::job(notice.text));
                true
            },
            false,
        )
    }
}

pub struct TideDriver {
    inner: Arc<Inner>,
}

struct Inner {
    events: DriverEventSender,
    rt: tokio::runtime::Runtime,
    opts: Mutex<MutableOptions>,
    history: Mutex<Vec<HistoryMessage>>,
    todo_state: Arc<TodoState>,
    /// Replaced with a fresh flag at every turn start; cancel and Drop abort
    /// whichever flag is current.
    abort: Mutex<AbortFlag>,
    turn_active: AtomicBool,
    aborted_notify: tokio::sync::Notify,
    /// Pending input, one queue per claim boundary: prompts wait for the
    /// next turn, steering rides the running turn's next step. Replaces the
    /// old steer channel + prompt queue pair.
    inbox: TurnInbox,
    /// Ordered tool gates consulted before any call runs; the first
    /// rejection wins. The Plan/Build chip is the first link.
    tool_gates: HookChain,
    /// Ordered rewrites applied to claimed step-boundary input; identity
    /// while empty, the attachment point for injected context later.
    step_input: StepInputChain,
    /// Parked follow-up questions: request id → the channel that resolves
    /// the ask with the user's answer text (`None` = dismissed). Consumed
    /// by `respond_user_input`, dropped on abort.
    followups: Mutex<HashMap<String, crossbeam_channel::Sender<Option<String>>>>,
    /// Dispatched children of this session: the resume/messaging roster.
    children: Mutex<Children>,
    /// The session's background-job registry — created once per session at
    /// driver start and NEVER recreated (options changes reconfigure in
    /// place; cancel only fires the per-turn flag). The registry is keyed
    /// by session id, so jobs die only by job_kill, session close, or
    /// daemon teardown — never with a turn (design decision 4).
    jobs: Arc<JobRegistry>,
    /// The wake implementation beside `Inner`: lane policy and budget. The
    /// registry's waker slot holds it through a Weak, so a dropped driver
    /// is never kept alive by its own settlement notices.
    wake: Arc<OrchestratorWake>,
    /// The newest step's prompt occupancy (input + cache read + write) —
    /// the pressure signal compaction reads. Updated per Transcript-sink
    /// Usage event.
    last_prompt_tokens: Mutex<u64>,
    /// Whether this root turn already spent its overflow-recovery
    /// compaction; reset at every turn start.
    turn_compacted: AtomicBool,
    cwd: PathBuf,
    /// The stable project identity this session belongs to — the RAG
    /// index key (per-project, shared across sessions). `None` when the
    /// driver started without a prior session projection.
    project_id: Option<String>,
    /// Daemon-owned store directories (attachments, blobs) that read tools
    /// may resolve into on top of the workspace — the composer hands these
    /// paths to the provider as attachments, and path safety would
    /// otherwise refuse them as workspace escapes.
    read_annex_roots: Vec<PathBuf>,
    session_id: String,
    context_window: Mutex<Option<u64>>,
    provider_cursor: Mutex<Option<ProviderResumeCursor>>,
}

#[derive(Clone)]
struct MutableOptions {
    model: Option<String>,
    reasoning_effort: Option<String>,
    interaction_mode: InteractionMode,
}

#[derive(Clone)]
struct EngineSelection {
    api_style: ProviderApiStyle,
    base_url: String,
    api_key: String,
    model_id: String,
    context_window: Option<u64>,
}

impl TideDriver {
    pub fn start(options: DriverStartOptions, events: DriverEventSender) -> anyhow::Result<Self> {
        // The `computer` tool's process-wide backend: install the helper
        // bridge and record the app-level toggle this session carries. A
        // build without the bundled helper leaves the seam unset and the
        // tool reports "not available"; off-macOS this only mirrors the
        // toggle. Safe to repeat — sessions start sequentially per process
        // and every start refreshes both values.
        crate::computer_use::install_computer_backend(options.computer_use_enabled);
        let session_id = options
            .prior_session
            .as_ref()
            .map(|session| session.id.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let project_id = options
            .prior_session
            .as_ref()
            .map(|session| session.project_id.to_string());
        let history = options
            .prior_session
            .as_ref()
            .map(rebuild_history)
            .unwrap_or_default();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("tide-tide-driver")
            .enable_all()
            .build()
            .context("could not start the tide runtime")?;
        let inner = Arc::new(Inner {
            events,
            rt,
            opts: Mutex::new(MutableOptions {
                model: options.model.clone(),
                reasoning_effort: options.reasoning_effort.clone(),
                interaction_mode: options.interaction_mode,
            }),
            history: Mutex::new(history),
            todo_state: TodoState::shared(),
            abort: Mutex::new(AbortFlag::new()),
            turn_active: AtomicBool::new(false),
            aborted_notify: tokio::sync::Notify::new(),
            inbox: TurnInbox::new(),
            tool_gates: HookChain::new(vec![Arc::new(PlanModeGate)]),
            step_input: StepInputChain::new(Vec::new()),
            followups: Mutex::new(HashMap::new()),
            children: Mutex::new(Children::default()),
            last_prompt_tokens: Mutex::new(0),
            turn_compacted: AtomicBool::new(false),
            project_id,
            cwd: options.cwd,
            read_annex_roots: daemon_read_annex_roots(),
            session_id,
            context_window: Mutex::new(None),
            provider_cursor: Mutex::new(options.provider_cursor.clone()),
            jobs: Arc::new(global_job_registry().clone()),
            wake: OrchestratorWake::new(),
        });
        inner.wake.attach(&inner);
        // Fail fast when no tide provider is usable; the session list shows
        // the probe's verdict, but a start arriving anyway deserves a real
        // error rather than a mid-turn one.
        resolve_engine(&inner)?;
        wire_background_jobs(&inner);
        let _ = inner.events.send(DriverEvent::Connected {
            provider_cursor: inner.provider_cursor.lock().unwrap().clone(),
        });
        Ok(Self { inner })
    }
}

impl Drop for TideDriver {
    fn drop(&mut self) {
        self.inner.abort.lock().unwrap().abort();
        self.inner.aborted_notify.notify_waiters();
        // Jobs outlive turns but not the session (design decision 4):
        // cancel live hooks synchronously — processes get their signals
        // now — and reap them bounded (5 s, then force-fail as orphaned).
        // The reaper runs as a spawned task; a Drop can be on any thread
        // and must not block_on.
        self.inner
            .jobs
            .close_session(&self.inner.session_id, JOB_CLOSE_GRACE);
    }
}

/// One-time per-session wiring of the background-job registry: the runtime
/// handle (the `close_session` reaper), the event sink (forwards every
/// registry event onto the driver's emit path), the settlement waker (the
/// wake listener, registered once), and the session-lifetime `OutputDelta`
/// pusher task.
fn wire_background_jobs(inner: &Arc<Inner>) {
    let jobs = Arc::clone(&inner.jobs);
    jobs.set_runtime(inner.rt.handle().clone());
    {
        // Invoked under the registry lock so event order matches commit
        // order — the contract is "quick, non-blocking, no re-entry", and
        // an unbounded channel send is exactly that.
        let inner = Arc::clone(inner);
        let session = inner.session_id.clone();
        jobs.set_event_sink(&session, Box::new(move |event| {
            emit(&inner, DriverEvent::BackgroundWork(event));
        }));
    }
    {
        // Registered once: settle → (already-reported jobs never produce a
        // notice — the registry filters them at settle) → lane choice →
        // deliver. The idle check is advisory; the claim inside
        // `wake_turn` is the race guard.
        let wake = Arc::clone(&inner.wake);
        let session = inner.session_id.clone();
        jobs.set_waker(&session, Box::new(move |notice| {
            // Try the idle lane; on a budget refusal (or a driver already
            // gone) degrade to the busy lane — wake_turn consumes its
            // copy, so the fallback carries the original notice through.
            if wake.is_idle() && wake.wake_turn(notice.clone()) {
                return;
            }
            wake.inject_step(notice);
        }));
    }
    spawn_output_pusher(inner);
}

/// The session-lifetime `OutputDelta` pusher: polls each live stream job's
/// UI cursor every 250 ms and emits `OutputDelta` when the delta is
/// non-empty. Jobs that went terminal since the last tick get exactly one
/// more drain, so the UI receives the final tail before the record is
/// reaped. The task holds the driver only weakly — it ends with the
/// session instead of pinning `Inner` (and its runtime) alive forever.
fn spawn_output_pusher(inner: &Arc<Inner>) {
    let weak = Arc::downgrade(inner);
    let rt = inner.rt.handle().clone();
    rt.spawn(async move {
        // Keys that were live at the last tick — the settlement-tail set.
        let mut tracked: Vec<BackgroundWorkKey> = Vec::new();
        loop {
            tokio::time::sleep(OUTPUT_PUSH_INTERVAL).await;
            let Some(inner) = weak.upgrade() else { break };
            let session = inner.session_id.as_str();
            let live = inner.jobs.ui_stream_keys(session);
            let mut keys = live.clone();
            for key in std::mem::replace(&mut tracked, live) {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
            for key in keys {
                // A Ui read advances only the UI cursor — the model's
                // `job_output` view is untouched (design decision 6).
                let Ok(read) = inner.jobs.read(session, &key, Reader::Ui) else {
                    continue; // record reaped under us; nothing left to push
                };
                if read.text.is_empty() {
                    continue;
                }
                emit(
                    &inner,
                    DriverEvent::BackgroundWork(BackgroundWorkEvent::OutputDelta {
                        key,
                        delta: read.text,
                    }),
                );
            }
        }
    });
}

impl crate::driver::DriverControl for TideDriver {
    fn prompt(&self, prompt: String) {
        claim_and_spawn_turn(&self.inner, StepMessage::user(prompt));
    }

    fn supports_steer(&self) -> bool {
        true
    }

    fn steer(&self, prompt: String) {
        if self.inner.inbox.push_step(prompt.clone()) {
            let _ = self
                .inner
                .events
                .send(DriverEvent::SteerAccepted { message: prompt });
        } else {
            let _ = self.inner.events.send(DriverEvent::SteerRejected {
                message: prompt,
                reason: "no turn is running".into(),
            });
        }
    }

    fn cancel(&self) {
        self.inner.abort.lock().unwrap().abort();
        self.inner.aborted_notify.notify_waiters();
    }

    fn respond(&self, _request_id: String, _option_id: String) {
        // Permission cards are gone — the Plan/Build chip is the whole gate.
        // `respond_user_input` answers the follow-up asks.
    }

    fn respond_user_input(&self, request_id: String, answers: Vec<UserInputAnswer>) {
        let Some(sender) = self.inner.followups.lock().unwrap().remove(&request_id) else {
            return;
        };
        let _ = sender.send(followup_answer_text(&answers));
    }

    fn apply_options(&self, options: SessionOptions) -> bool {
        let mut opts = self.inner.opts.lock().unwrap();
        opts.model = options.model;
        opts.reasoning_effort = options.reasoning_effort;
        opts.interaction_mode = options.interaction_mode;
        true
    }

    fn stop_background_work(&self, key: BackgroundWorkKey, control_id: String) {
        // One rule everywhere: the job id is the provider_id is the
        // control_id (design decision 10) — the control id maps straight
        // onto the registry key; there is no provider negotiation left.
        let job_key = BackgroundWorkKey {
            kind: key.kind,
            provider_id: control_id.clone(),
        };
        let session = self.inner.session_id.as_str();
        match self.inner.jobs.kill(session, &job_key, None) {
            // Requested: the registry already emitted the Stopping `Upsert`
            // and `StopRequested` through the wired sink on its way out.
            // AlreadyFinished: the terminal snapshot stands and there is
            // nothing to revert, so no event goes out.
            Ok(KillOutcome::Requested | KillOutcome::AlreadyFinished) => {}
            Ok(KillOutcome::Unknown) => {
                emit(
                    &self.inner,
                    DriverEvent::BackgroundWork(BackgroundWorkEvent::StopFailed {
                        key,
                        message: format!("no background job {control_id} in this session"),
                    }),
                );
            }
            Err(error) => {
                emit(
                    &self.inner,
                    DriverEvent::BackgroundWork(BackgroundWorkEvent::StopFailed {
                        key,
                        message: error.to_string(),
                    }),
                );
            }
        }
    }

    fn refresh_background_work(&self) {
        // The registry is the only source of background state in the
        // process — reconciliation reads straight from it.
        let items = self.inner.jobs.list_session(&self.inner.session_id);
        emit(
            &self.inner,
            DriverEvent::BackgroundWork(BackgroundWorkEvent::ReconcileLive { items }),
        );
    }

    fn rollback(&self, turns: usize) -> anyhow::Result<Option<ProviderResumeCursor>> {
        let mut history = self.inner.history.lock().unwrap();
        let mut user_starts = history
            .iter()
            .enumerate()
            .filter(|(_, message)| {
                message.role == HistoryRole::User
                    && message
                        .parts
                        .iter()
                        .any(|part| matches!(part, HistoryPart::Text { .. }))
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if turns == 0 || turns > user_starts.len() {
            bail!(
                "cannot roll back {turns} turns of a {}-turn conversation",
                user_starts.len()
            );
        }
        let cut = user_starts.swap_remove(user_starts.len() - turns);
        history.truncate(cut);
        drop(history);
        *self.inner.provider_cursor.lock().unwrap() = Some(ProviderResumeCursor::Tide {
            session_id: self.inner.session_id.clone(),
        });
        Ok(Some(ProviderResumeCursor::Tide {
            session_id: self.inner.session_id.clone(),
        }))
    }
}

fn thinking_level(effort: Option<&str>) -> ThinkingLevel {
    match effort.map(str::to_ascii_lowercase).as_deref() {
        Some("off") | Some("none") => ThinkingLevel::Off,
        Some("minimal") => ThinkingLevel::Minimal,
        Some("low") => ThinkingLevel::Low,
        Some("high") => ThinkingLevel::High,
        Some("xhigh") | Some("extra") | Some("max") => ThinkingLevel::Max,
        _ => ThinkingLevel::Medium,
    }
}

fn parse_api_style(style: &str) -> Option<ProviderApiStyle> {
    match style.trim().to_ascii_lowercase().as_str() {
        "anthropic" => Some(ProviderApiStyle::Anthropic),
        "openai" => Some(ProviderApiStyle::OpenAi),
        _ => None,
    }
}

/// Resolve the engine for the current model selection.
fn resolve_engine(inner: &Inner) -> anyhow::Result<EngineSelection> {
    let config = store::config::load(&store::paths::config_path())
        .map_err(|error| anyhow!("could not load the tide config: {error}"))?;
    let selection = resolve_tide_model(&config, inner.opts.lock().unwrap().model.as_deref())?;
    let api_key = tide_api_key(&config, &selection)?;
    Ok(EngineSelection {
        api_style: selection.api_style,
        base_url: selection.base_url,
        api_key,
        model_id: selection.model_id,
        context_window: selection.context_window,
    })
}

/// The wire-relevant slice of a resolved (provider, model) pair — everything
/// except the keychain-held api key, so selection is unit-testable against a
/// plain `Config` without touching the user's keychain.
#[derive(Clone)]
pub(crate) struct TideModelSelection {
    pub(crate) api_style: ProviderApiStyle,
    pub(crate) base_url: String,
    pub(crate) provider_id: String,
    pub(crate) provider_name: String,
    pub(crate) model_id: String,
    pub(crate) context_window: Option<u64>,
}

fn selection_from_provider(
    provider: &store::config::StoredProvider,
    model_id: &str,
) -> anyhow::Result<TideModelSelection> {
    let api_style = parse_api_style(&provider.api_style)
        .with_context(|| format!("unknown api style {:?}", provider.api_style))?;
    let context_window = provider
        .models
        .iter()
        .find(|model| model.model_id == model_id)
        .map(|model| model.context_window);
    Ok(TideModelSelection {
        api_style,
        base_url: provider.base_url.clone(),
        provider_id: provider.id.clone(),
        provider_name: provider.name.clone(),
        model_id: model_id.to_owned(),
        context_window,
    })
}

/// Resolve a model selection against the config: "provider/model" when the
/// catalog picked one explicitly, else any enabled provider serving the bare
/// model id, else the first enabled provider's first model.
pub(crate) fn resolve_tide_model(
    config: &store::config::Config,
    selection: Option<&str>,
) -> anyhow::Result<TideModelSelection> {
    let enabled: Vec<_> = config
        .providers
        .iter()
        .filter(|provider| provider.enabled)
        .collect();
    if enabled.is_empty() {
        bail!(
            "no enabled tide provider in {}",
            store::paths::config_path().display()
        );
    }
    match selection.and_then(|value| value.split_once('/')) {
        Some((provider_id, model_id)) => {
            let provider = enabled
                .iter()
                .find(|provider| provider.id == provider_id)
                .with_context(|| format!("tide provider {provider_id} is not configured"))?;
            let model_id = provider
                .models
                .iter()
                .find(|model| model.model_id == model_id)
                .map(|model| model.model_id.clone())
                .unwrap_or_else(|| model_id.to_string());
            selection_from_provider(provider, &model_id)
        }
        _ => match selection {
            Some(model_id) => enabled
                .iter()
                .find_map(|provider| {
                    provider
                        .models
                        .iter()
                        .find(|model| model.model_id == model_id || model.id == model_id)
                        .map(|model| (*provider, model.model_id.clone()))
                })
                .map(|(provider, model_id)| selection_from_provider(provider, &model_id))
                .with_context(|| format!("no tide provider serves the model {model_id}"))?,
            None => enabled
                .iter()
                .find_map(|provider| {
                    provider
                        .models
                        .first()
                        .map(|model| (*provider, model.model_id.clone()))
                })
                .map(|(provider, model_id)| selection_from_provider(provider, &model_id))
                .ok_or_else(|| anyhow!("no tide provider has a configured model"))?,
        },
    }
}

/// Resolve a GeneralSettings model override (the `commitMessageModel` /
/// `titleModel` kind): it wins only when its provider is enabled and actually
/// serves the named model, so a stale override falls through to the session's
/// own selection instead of failing generation.
pub(crate) fn override_tide_model(
    config: &store::config::Config,
    r#override: &store::config::ModelRef,
) -> Option<TideModelSelection> {
    let provider = config
        .providers
        .iter()
        .find(|provider| provider.enabled && provider.id == r#override.provider_id)?;
    if !provider
        .models
        .iter()
        .any(|model| model.model_id == r#override.model_id)
    {
        return None;
    }
    selection_from_provider(provider, &r#override.model_id).ok()
}

/// A background task's model choice, resolved to a tide sub-provider and the
/// identifiers the engine one-shot needs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum BackgroundModel {
    /// Tide sub-provider — run through the engine one-shot.
    Tide {
        provider_id: String,
        model_id: String,
    },
}

/// Tolerant resolution of a stored background-model override: a ref whose
/// provider vanished from the config resolves to `None`, not an error, so
/// rendering paths degrade to "use the session's model".
pub(crate) fn resolve_background_model(
    config: &store::config::Config,
    r#override: &store::config::ModelRef,
) -> Option<BackgroundModel> {
    config
        .providers
        .iter()
        .any(|provider| provider.id == r#override.provider_id)
        .then(|| BackgroundModel::Tide {
            provider_id: r#override.provider_id.clone(),
            model_id: r#override.model_id.clone(),
        })
}

/// Strict resolution for the write path: an unresolvable pair is a user error,
/// reported before anything is persisted.
pub(crate) fn resolve_background_model_strict(
    config: &store::config::Config,
    r#override: &store::config::ModelRef,
) -> Result<BackgroundModel, String> {
    resolve_background_model(config, r#override)
        .ok_or_else(|| format!("unknown tide provider {:?}", r#override.provider_id))
}

/// Resolve the configured override for `task` ("title" | "commit-message").
/// `None` → no override (use the session's model). Tolerant by design: a
/// stored ref whose provider vanished resolves to `None`, not an error.
#[allow(dead_code)] // wired up by the settings-UI task; exercised by tests today
pub(crate) fn background_model_override(task: &str) -> Option<BackgroundModel> {
    let config = store::config::load(&store::paths::config_path()).ok()?;
    let effective = config
        .general_settings
        .as_ref()
        .map(|settings| settings.effective());
    let r#override = match task {
        "title" => effective.and_then(|settings| settings.title_model),
        "commit-message" => effective.and_then(|settings| settings.commit_message_model),
        _ => None,
    }?;
    resolve_background_model(&config, &r#override)
}

/// Decrypt the selected provider's stored api key from the keychain.
pub(crate) fn tide_api_key(
    config: &store::config::Config,
    selection: &TideModelSelection,
) -> anyhow::Result<String> {
    store::secrets::get_api_key(config, &selection.provider_id)
        .map_err(|error| anyhow!("could not read the tide api key: {error}"))?
        .with_context(|| {
            format!(
                "tide provider {} has no stored api key",
                selection.provider_name
            )
        })
}

/// The synthetic assistant text that closes an exchange which ended
/// without one — a turn aborted before any assistant output, or a gap
/// healed in a rebuilt session. Chosen neutral: "(stopped)" reads as the
/// driver's own marker without putting words in the model's mouth.
const STOPPED_MARKER: &str = "(stopped)";

/// Model-facing output for a call the turn's cancellation prevented. The
/// `Error:` prefix matches how tool failures reach the model everywhere
/// else, so a canceled batch reads like any other failed batch.
const ABORTED_CALL_OUTPUT: &str = "Error: the turn was canceled before this call ran";

/// The assistant placeholder that separates two exchanges. z.ai's
/// Anthropic-compat endpoint mishandles consecutive user-role messages —
/// the context after them is dropped, so the model answers as if the later
/// tool results never existed — so every user message must arrive after an
/// assistant one.
fn stopped_assistant_message() -> HistoryMessage {
    HistoryMessage {
        role: HistoryRole::Assistant,
        parts: vec![HistoryPart::Text {
            text: STOPPED_MARKER.to_owned(),
        }],
    }
}

/// Close a dangling user tail: when the last message is user-role, append
/// the assistant placeholder so the next user message cannot land adjacent
/// to it. Returns whether a placeholder was added.
fn ensure_assistant_tail(history: &mut Vec<HistoryMessage>) -> bool {
    if history
        .last()
        .is_some_and(|message| message.role == HistoryRole::User)
    {
        history.push(stopped_assistant_message());
        true
    } else {
        false
    }
}

/// Store directories the daemon anchors beside `app.db` — the same parent
/// the backend uses for its attachment and blob stores. Read tools accept
/// absolute paths inside these in addition to the workspace.
fn daemon_read_annex_roots() -> Vec<PathBuf> {
    match crate::persistence::StateStore::default_path().parent() {
        Some(parent) => vec![parent.join("attachments"), parent.join("blobs")],
        None => Vec::new(),
    }
}

/// Push a user message — the only door user-role messages use — keeping
/// the wire shape well-formed: a placeholder goes in first whenever the
/// tail is already user (a steer landing after tool results, a prompt
/// after a turn that produced no assistant output, a second message in
/// one steering batch).
fn push_user_message(history: &Mutex<Vec<HistoryMessage>>, message: HistoryMessage) {
    let mut history = history.lock().unwrap();
    ensure_assistant_tail(&mut history);
    history.push(message);
}

/// Raster image extensions inlinable as vision content, with the MIME types
/// rig maps onto both wire styles (OpenAI data URLs, Anthropic base64
/// sources). Anything else — svg, heic, pdf — stays a plain path mention.
const INLINE_IMAGE_MIME: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

/// The byte cap for one inlined image: read_media_file's 10 MB, comfortably
/// under every provider's per-image limit.
const MAX_INLINE_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// The MIME type of an inline-able image path, by extension.
fn inline_image_mime(path: &Path) -> Option<&'static str> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase();
    INLINE_IMAGE_MIME
        .iter()
        .find(|(candidate, _)| *candidate == extension)
        .map(|(_, mime)| *mime)
}

/// Read one resolved image file into an [`HistoryPart::Image`]. `None` when
/// the file vanished, grew past the cap, or is not a regular file.
fn image_part_for_path(path: &Path, mime: &'static str) -> Option<HistoryPart> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_INLINE_IMAGE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    use base64::Engine as _;
    Some(HistoryPart::Image {
        media_type: mime.to_owned(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// The `@mention` paths a submitted prompt carries. The composer appends
/// each attachment as `@path`, quoting the path when it contains whitespace
/// (`merged_submission`); prose `@`s are tolerated — a mention only becomes
/// image content when it also resolves to a readable raster image.
fn prompt_image_mentions(prompt: &str) -> Vec<String> {
    let bytes = prompt.as_bytes();
    let mut mentions = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'@' {
            index += 1;
            continue;
        }
        let start = index + 1;
        if start < bytes.len() && bytes[start] == b'"' {
            let Some(end) = prompt[start + 1..].find('"').map(|offset| start + 1 + offset)
            else {
                break;
            };
            let mention = &prompt[start + 1..end];
            if !mention.is_empty() {
                mentions.push(mention.to_owned());
            }
            index = end + 1;
        } else {
            let end = prompt[start..]
                .find(char::is_whitespace)
                .map_or(prompt.len(), |offset| start + offset);
            let mention = &prompt[start..end];
            if !mention.is_empty() {
                mentions.push(mention.to_owned());
            }
            index = end;
        }
    }
    mentions
}

/// Build the user history message for a submitted prompt: the prompt text
/// verbatim plus one image part per `@mention` that resolves to a readable
/// raster image inside the workspace or a daemon read annex. A mention that
/// fails to resolve stays plain text — the model still sees the path and
/// can reach it with its read tools.
fn prompt_message(cwd: &Path, read_annex_roots: &[PathBuf], prompt: &str) -> HistoryMessage {
    let mut parts = vec![HistoryPart::Text {
        text: prompt.to_owned(),
    }];
    for mention in prompt_image_mentions(prompt) {
        let Some(mime) = inline_image_mime(Path::new(&mention)) else {
            continue;
        };
        let Ok(path) =
            tools::path_safety::resolve_and_follow_symlinks_roots(cwd, read_annex_roots, &mention)
        else {
            continue;
        };
        if let Some(part) = image_part_for_path(&path, mime) {
            parts.push(part);
        }
    }
    HistoryMessage {
        role: HistoryRole::User,
        parts,
    }
}

/// The outcome a call receives when cancellation stopped the batch before
/// it ran — the same shape the mid-batch abort path feeds through the
/// ordinary completion emission, so canceled cards close like real ones.
fn aborted_call_outcome() -> ToolOutcome {
    ToolOutcome::aborted(ABORTED_CALL_OUTPUT)
}

/// Repair history after a step was cut off by cancellation, so the next
/// request can never carry a dangling tool-call tail (the same endpoint
/// quirk [`push_user_message`] guards against) and a streamed partial
/// answer is not lost:
/// - no `step_message` — the stream died before the assistant message
///   landed, so history has no tool-call parts to answer; keep the
///   interrupted text prefix as the step's assistant message.
/// - `step_message` — its assistant message is already in history with
///   unanswered tool-call parts; append one user message of canceled
///   results, ids mapped provider-side exactly like a completed step.
fn settle_aborted_step(
    history: &mut Vec<HistoryMessage>,
    step_message: Option<&HistoryMessage>,
    pending: &[(String, String, serde_json::Value)],
    partial_text: &str,
) {
    match step_message {
        None => {
            if !partial_text.trim().is_empty() {
                history.push(HistoryMessage {
                    role: HistoryRole::Assistant,
                    parts: vec![HistoryPart::Text {
                        text: partial_text.to_owned(),
                    }],
                });
            }
        }
        Some(message) => {
            let call_ids = map_call_ids(message, pending);
            let parts: Vec<HistoryPart> = pending
                .iter()
                .map(|(call_id, tool_name, _)| {
                    let result_call_id = call_ids
                        .get(call_id)
                        .cloned()
                        .unwrap_or_else(|| call_id.clone());
                    HistoryPart::ToolResult {
                        call_id: result_call_id,
                        tool_name: tool_name.clone(),
                        output: ABORTED_CALL_OUTPUT.to_owned(),
                    }
                })
                .collect();
            if !parts.is_empty() {
                history.push(HistoryMessage {
                    role: HistoryRole::User,
                    parts,
                });
            }
        }
    }
}

/// Close the transcript cards (or sub-agent timeline blocks) that streamed
/// tool calls opened but cancellation will never settle: every assembled
/// `ToolCall` emitted an open activity, and without this they stay open
/// forever.
fn close_canceled_calls(
    inner: &Arc<Inner>,
    sink: &mut LoopSink,
    pending: &[(String, String, serde_json::Value)],
) {
    for (tool_call_id, tool_name, _) in pending {
        match sink {
            LoopSink::Transcript => {
                emit(
                    inner,
                    DriverEvent::Activity {
                        id: Some(tool_call_id.clone()),
                        kind: ActivityKind::from_tool_name(tool_name),
                        title: tool_name.clone(),
                        detail: Some("canceled — the turn ended before this call ran".into()),
                        complete: true,
                    },
                );
            }
            LoopSink::Subagent { .. } => {
                emit_subagent_blocks(inner, sink, |blocks| {
                    subagent_tool_finish(blocks, tool_call_id, false, 0)
                });
            }
        }
    }
}

fn rebuild_history(session: &AgentSession) -> Vec<HistoryMessage> {
    let mut history = Vec::new();
    for message in &session.messages {
        let role = match message.role {
            MessageRole::User => HistoryRole::User,
            MessageRole::Assistant => HistoryRole::Assistant,
            _ => continue,
        };
        let text = message.visible_content().trim();
        if text.is_empty() {
            continue;
        }
        // Heal the older-build shape: a turn interrupted before any
        // assistant output persisted two user messages back-to-back (the
        // placeholder never streamed, so it is not among the stored
        // messages either). Restore it before the gap reaches the engine.
        if role == HistoryRole::User {
            ensure_assistant_tail(&mut history);
        }
        let mut parts = vec![HistoryPart::Text {
            text: text.to_owned(),
        }];
        // Re-inline image attachments from their daemon-host paths so a
        // restart (or a handoff into this driver) replays the same vision
        // content the live turn sent, not just the mention text.
        if role == HistoryRole::User {
            for attachment in &message.attachments {
                if !attachment.is_image {
                    continue;
                }
                let Some(mime) = inline_image_mime(&attachment.path) else {
                    continue;
                };
                if let Some(part) = image_part_for_path(&attachment.path, mime) {
                    parts.push(part);
                }
            }
        }
        history.push(HistoryMessage { role, parts });
    }
    history
}

fn args_preview(args: &serde_json::Value) -> String {
    let rendered = match args {
        serde_json::Value::Object(fields) => fields
            .values()
            .find_map(|value| value.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| args.to_string()),
        other => other.to_string(),
    };
    let mut preview: String = rendered.chars().take(240).collect();
    if preview.len() < rendered.len() {
        preview.push('…');
    }
    preview
}

fn output_preview(outcome: &ToolOutcome) -> String {
    let rendered = outcome.output.trim();
    let mut preview: String = rendered.chars().take(240).collect();
    if preview.len() < rendered.len() {
        preview.push('…');
    }
    if preview.is_empty() {
        preview = match outcome.status {
            tools::OutcomeStatus::Executed => "done".into(),
            tools::OutcomeStatus::Rejected => "rejected".into(),
            tools::OutcomeStatus::Aborted => "aborted".into(),
            _ => "finished".into(),
        };
    }
    preview
}

/// The output the transcript activity carries: the tool's display text when
/// it sent one (tide puts the renderable body there — the todo checklist
/// lines, the follow-up question rendering), else the model-facing output
/// summary.
fn display_output(outcome: &ToolOutcome) -> String {
    match outcome.display.as_ref() {
        Some(tools::ToolDisplay::Text { text }) if !text.trim().is_empty() => text.clone(),
        _ => outcome.output.clone(),
    }
}

/// Longest a tool block's `command`/`task` target shows.
const SUBAGENT_TOOL_TARGET_CHARS: usize = 60;
/// Longest a tool block's `path` target shows (kept as a tail — the filename
/// end of a path is the identifying half).
const SUBAGENT_TOOL_PATH_CHARS: usize = 48;

/// The one-line target a sub-agent tool block names: the `path` (tail-truncated
/// when long), else the first line of `command`, else of `task` — `None` when
/// the arguments name nothing worth a target column.
fn subagent_tool_target(arguments: &serde_json::Value) -> Option<String> {
    if let Some(path) = arguments
        .get("path")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let chars: Vec<char> = path.chars().collect();
        return Some(if chars.len() <= SUBAGENT_TOOL_PATH_CHARS {
            path.to_owned()
        } else {
            let tail: String = chars[chars.len() - SUBAGENT_TOOL_PATH_CHARS..]
                .iter()
                .collect();
            format!("…{tail}")
        });
    }
    for field in ["command", "task"] {
        let Some(text) = arguments.get(field).and_then(serde_json::Value::as_str) else {
            continue;
        };
        if let Some(line) = text.lines().map(str::trim).find(|line| !line.is_empty()) {
            return Some(if line.chars().count() <= SUBAGENT_TOOL_TARGET_CHARS {
                line.to_owned()
            } else {
                let head: String = line.chars().take(SUBAGENT_TOOL_TARGET_CHARS).collect();
                format!("{head}…")
            });
        }
    }
    None
}

// ── Sub-agent block maintenance ──────────────────────────────────────────────
//
// Pure list edits over `Vec<SubagentBlock>` — the timeline the agents panel
// renders. Reasoning and narration append to the open tail block and close
// when any other event takes over — or when the message completes
// (`StepEnd`), so every child assistant message is one Text block. Tool runs
// push a Running block at the assembled call and settle it by id when the
// outcome lands. At settlement the FINAL message's block pops into the
// dispatch report: it renders once, as the Result card, never also as
// narration.

/// Close the tail block's streaming flag: reasoning and narration blocks
/// stay "streaming" only while they remain the live tail. A tool tail (or an
/// empty list) is a no-op.
fn subagent_blocks_close(blocks: &mut Vec<SubagentBlock>) {
    match blocks.last_mut() {
        Some(SubagentBlock::Reasoning { streaming, .. })
        | Some(SubagentBlock::Text { streaming, .. }) => *streaming = false,
        _ => {}
    }
}

/// Append one reasoning delta: extends the open tail block when it is the
/// live reasoning, else closes the tail and opens a fresh block — so a
/// thought interrupted by any other event reads as a new block.
fn subagent_reasoning_delta(blocks: &mut Vec<SubagentBlock>, delta: &str) {
    match blocks.last_mut() {
        Some(SubagentBlock::Reasoning { text, streaming }) if *streaming => text.push_str(delta),
        _ => {
            subagent_blocks_close(blocks);
            blocks.push(SubagentBlock::Reasoning {
                text: delta.to_owned(),
                streaming: true,
            });
        }
    }
}

/// Append one narration delta: same tail rule as reasoning.
fn subagent_text_delta(blocks: &mut Vec<SubagentBlock>, delta: &str) {
    match blocks.last_mut() {
        Some(SubagentBlock::Text { content, streaming }) if *streaming => content.push_str(delta),
        _ => {
            subagent_blocks_close(blocks);
            blocks.push(SubagentBlock::Text {
                content: delta.to_owned(),
                streaming: true,
            });
        }
    }
}

/// Push a tool block at the assembled call — the earliest point the one-line
/// target exists. Any open reasoning/narration tail closes behind it.
fn subagent_tool_start(
    blocks: &mut Vec<SubagentBlock>,
    tool_call_id: &str,
    tool_name: &str,
    arguments: &serde_json::Value,
) {
    subagent_blocks_close(blocks);
    blocks.push(SubagentBlock::Tool {
        id: tool_call_id.to_owned(),
        name: tool_name.to_owned(),
        target: subagent_tool_target(arguments),
        status: SubagentToolStatus::Running,
        duration_ms: None,
    });
}

/// Settle the tool block a call id names: only `Executed` ticks; failed,
/// rejected, timed-out, and aborted calls all cross out. Unknown ids (a
/// block list replaced out from under the call) leave the list untouched.
fn subagent_tool_finish(
    blocks: &mut [SubagentBlock],
    tool_call_id: &str,
    executed: bool,
    duration_ms: u64,
) {
    let status = if executed {
        SubagentToolStatus::Done
    } else {
        SubagentToolStatus::Failed
    };
    for block in blocks.iter_mut().rev() {
        if let SubagentBlock::Tool {
            id,
            status: block_status,
            duration_ms: block_duration,
            ..
        } = block
            && id == tool_call_id
        {
            *block_status = status;
            *block_duration = Some(duration_ms);
            return;
        }
    }
}

/// Close every streaming flag — the run is over, the timeline is final.
fn subagent_blocks_finalize(blocks: &mut [SubagentBlock]) {
    for block in blocks.iter_mut() {
        match block {
            SubagentBlock::Reasoning { streaming, .. } | SubagentBlock::Text { streaming, .. } => {
                *streaming = false
            }
            SubagentBlock::Tool { .. } | SubagentBlock::Message { .. } => {}
        }
    }
}

/// Settle the timeline and resolve the dispatch report. When the run
/// finished with a final narration block, that message IS the report: it
/// pops off the block list (so the shipped snapshot keeps only the
/// intermediate messages as narration) and returns as `output`, where the
/// panel's Result card reads it — rendered once, never twice. A run with no
/// final message — abandoned, errored, or one whose last text is blank —
/// keeps its blocks untouched as the trail and reports the note.
fn settle_subagent_timeline(blocks: &mut Vec<SubagentBlock>, outcome: &LoopOutcome) -> String {
    let mut report = None;
    if !outcome.aborted && outcome.error.is_none() {
        report = match blocks.last() {
            Some(SubagentBlock::Text { content, .. }) if !content.trim().is_empty() => {
                let report = content.trim().to_owned();
                blocks.pop();
                Some(report)
            }
            _ => None,
        };
    }
    subagent_blocks_finalize(blocks);
    report.unwrap_or_else(|| {
        if outcome.aborted {
            "(abandoned)".to_owned()
        } else {
            "(no output)".to_owned()
        }
    })
}

fn emit(inner: &Inner, event: DriverEvent) {
    let _ = inner.events.send(event);
}

#[derive(Clone)]
struct ToolEntry {
    tool: Arc<dyn Tool>,
    spec: ToolSpec,
}

fn toolset() -> Vec<ToolEntry> {
    tools::tools::core_tools()
        .into_iter()
        .filter(|tool| !ORCHESTRATOR_OWNED_TOOLS.contains(&tool.spec().name.as_str()))
        .map(|tool| {
            let spec = tool.spec();
            let tool: Arc<dyn Tool> = Arc::from(tool);
            // tools keeps its own spec type to stay engine-free; the
            // shapes are identical, so the conversion is field-by-field.
            let spec = ToolSpec {
                name: spec.name,
                description: spec.description,
                parameters: spec.parameters,
            };
            ToolEntry { tool, spec }
        })
        .collect()
}

/// Where a loop's output lands: the session transcript, or the background
/// work item a dispatched subagent streams into. The sub-agent sink carries
/// the block timeline it maintains — `run_child_loop` seeds it, `drive_engine`
/// mutates it behind every engine event, and the final snapshot rides the
/// last emit home.
enum LoopSink {
    Transcript,
    Subagent {
        key: BackgroundWorkKey,
        blocks: Vec<SubagentBlock>,
    },
}

impl LoopSink {
    /// The sub-agent sink's key and mutable block list, when this loop
    /// streams into one.
    fn subagent(&mut self) -> Option<(&BackgroundWorkKey, &mut Vec<SubagentBlock>)> {
        match self {
            LoopSink::Transcript => None,
            LoopSink::Subagent { key, blocks } => Some((key, blocks)),
        }
    }
}

struct LoopOutcome {
    text: String,
    usage: Option<engine::EngineUsage>,
    aborted: bool,
    error: Option<String>,
}

/// Apply one block mutation to the sub-agent sink and ship the resulting
/// snapshot as a [`BackgroundWorkEvent::SubagentBlocks`]. Transcript sinks
/// are a no-op — the callers gate on the sink kind for their own emissions,
/// and this helper never needs to invent a key.
fn emit_subagent_blocks(
    inner: &Arc<Inner>,
    sink: &mut LoopSink,
    mutate: impl FnOnce(&mut Vec<SubagentBlock>),
) {
    if let Some((key, blocks)) = sink.subagent() {
        mutate(blocks);
        let event = BackgroundWorkEvent::SubagentBlocks {
            key: key.clone(),
            blocks: blocks.clone(),
        };
        emit(inner, DriverEvent::BackgroundWork(event));
    }
}

/// One scheduling run within a step's tool batch: an exclusive call runs
/// alone (a barrier on both sides), and a maximal run of parallel-safe
/// calls shares one bounded pool.
#[derive(Debug)]
enum ToolRun {
    Exclusive(usize),
    Parallel(Vec<usize>),
}

/// Group a step's calls (model order) into scheduling runs by their
/// concurrency classification. Port of dsh's tool-call scheduler planning:
/// exclusive calls are solo barriers between runs, and maximal runs of
/// parallel calls form pools. Indices reference `pending`.
fn plan_tool_groups(pending: &[(String, String, serde_json::Value)]) -> Vec<ToolRun> {
    let mut runs = Vec::new();
    let mut pool: Vec<usize> = Vec::new();
    for (index, (_, tool_name, _)) in pending.iter().enumerate() {
        if concurrency_for(tool_name) == ToolConcurrency::Parallel {
            pool.push(index);
        } else {
            if !pool.is_empty() {
                runs.push(ToolRun::Parallel(std::mem::take(&mut pool)));
            }
            runs.push(ToolRun::Exclusive(index));
        }
    }
    if !pool.is_empty() {
        runs.push(ToolRun::Parallel(pool));
    }
    runs
}

/// Complete one executed call: close its transcript card (or sub-agent
/// timeline block) and stage its result part at its model-order slot.
#[allow(clippy::too_many_arguments)]
fn finish_tool_call(
    inner: &Arc<Inner>,
    sink: &mut LoopSink,
    call_ids: Option<&HashMap<String, String>>,
    call: &(String, String, serde_json::Value),
    outcome: ToolOutcome,
    started: std::time::Instant,
    index: usize,
    step_results: &mut [Option<HistoryPart>],
) {
    let (tool_call_id, tool_name, arguments) = call;
    match sink {
        LoopSink::Transcript => {
            // The completion event carries the whole activity — arguments
            // and the display text (tide's tool output puts the renderable
            // body there: todo checklists, follow-up questions) — so the
            // transcript card's expanded body has real content, with the
            // short preview staying in the detail the header shows.
            let mut item = super::activity::tool_activity(
                Some(tool_call_id.clone()),
                ActivityKind::from_tool_name(tool_name),
                tool_name.clone(),
                Some(arguments),
                Some(&serde_json::Value::String(display_output(&outcome))),
                None,
                matches!(outcome.status, tools::OutcomeStatus::Failed),
                true,
            );
            item.detail = Some(output_preview(&outcome));
            // The structured dispatch payload rides the activity so the
            // transcript renders a dedicated agent card instead of raw
            // output text.
            if let Some(tools::ToolDisplay::Agent {
                agent_name,
                title,
                task,
                report,
                dispatch_id,
                ..
            }) = outcome.display.as_ref()
            {
                item.agent = Some(ActivityAgent {
                    agent_name: agent_name.clone(),
                    title: title.clone(),
                    task: task.clone(),
                    report: report.clone(),
                    dispatch_id: dispatch_id.clone(),
                });
            }
            emit(inner, DriverEvent::RichActivity(item));
        }
        // The child's tool block settles with the outcome — presentation
        // only, the real result still lands in `step_results` below.
        LoopSink::Subagent { .. } => {
            let executed = matches!(outcome.status, tools::OutcomeStatus::Executed);
            let duration_ms = started.elapsed().as_millis() as u64;
            emit_subagent_blocks(inner, sink, |blocks| {
                subagent_tool_finish(blocks, tool_call_id, executed, duration_ms)
            });
        }
    }
    let result_call_id = call_ids
        .and_then(|map| map.get(tool_call_id).cloned())
        .unwrap_or_else(|| tool_call_id.clone());
    step_results[index] = Some(HistoryPart::ToolResult {
        call_id: result_call_id,
        tool_name: tool_name.clone(),
        output: outcome.output,
    });
    // A completed Computer Use call drives the live preview the same way
    // the helper's preview-file monitor does on the external-CLI paths: the
    // captured target and screenshot push as ComputerUseUpdated, which the
    // app shows as the Picture-in-Picture overlay. The helper echoes the
    // captured window as `meta.computerTarget` next to the screenshot.
    if let Some(tools::ToolDisplay::Media { data_url, .. }) = outcome.display.as_ref() {
        let target = outcome
            .meta
            .as_deref()
            .and_then(|meta| serde_json::from_str::<serde_json::Value>(meta).ok())
            .and_then(|meta| meta.get("computerTarget").cloned());
        if let Some(target) = target {
            if let Ok(target) =
                serde_json::from_value::<crate::computer_use::ComputerTarget>(target)
            {
                emit(
                    inner,
                    DriverEvent::ComputerUseUpdated(crate::computer_use::ComputerUseState {
                        target: Some(target),
                        phase: crate::computer_use::ComputerUsePhase::Running,
                        visible: true,
                        image_url: Some(data_url.clone()),
                    }),
                );
            }
        }
    }
}

/// Where a loop sits in the dispatch tree: nesting depth, the parent
/// agent's name, and this child's registry id (`None` on the root loop).
/// The child id scopes the loop's tool executions — a child's
/// `ToolContext.session_id` keys its todo writes apart from the parent's.
#[derive(Clone)]
struct DispatchCtx {
    depth: u32,
    parent_agent: Option<&'static str>,
    child_id: Option<String>,
}

impl DispatchCtx {
    const ROOT: DispatchCtx = DispatchCtx {
        depth: 0,
        parent_agent: None,
        child_id: None,
    };

    fn child(depth: u32, parent_agent: &'static str, child_id: String) -> Self {
        Self {
            depth,
            parent_agent: Some(parent_agent),
            child_id: Some(child_id),
        }
    }
}

/// Whether a loop that stopped without a clean EndTurn should run one
/// forced tool-less wrap-up step: step budgets and degenerate tool stops
/// otherwise end the turn on unanswered tool results — no final message
/// for the report ("(no output)") and a wire shape resume cannot replay.
/// Aborted and errored turns keep their existing settlement instead.
fn needs_wrap_up(ended_turn: bool, aborted: bool, error_free: bool) -> bool {
    !ended_turn && !aborted && error_free
}

/// The nudge that opens the forced wrap-up step. Model-facing, so it states
/// the constraint rather than the mechanism.
fn wrap_up_prompt() -> String {
    "Step limit reached. Give your final answer now — no further tool calls are possible."
        .to_owned()
}

/// Emit one step's usage breakdown with its timing attached. Called once
/// per step, after the step's tool phase has run (tool_ms measured) or
/// immediately when the step ended without tool calls (tool_ms zero), so
/// the inspector's per-step performance stats see the complete picture.
fn emit_step_usage(
    inner: &Arc<Inner>,
    usage: &engine::EngineUsage,
    llm_ms: Option<u64>,
    ttft_ms: Option<u64>,
    tool_ms: Option<u64>,
) {
    emit(
        inner,
        DriverEvent::UsageUpdated {
            context_tokens: Some(
                usage.input_tokens
                    + usage.output_tokens
                    + usage.cache_read
                    + usage.cache_write,
            ),
            context_window: *inner.context_window.lock().unwrap(),
            breakdown: Some(UsageBreakdown {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read: usage.cache_read,
                cache_write: usage.cache_write,
                reasoning_tokens: usage.reasoning_tokens,
                calls: usage.calls,
                cost_usd: (usage.cost_usd > 0.0).then_some(usage.cost_usd),
                llm_ms,
                ttft_ms,
                tool_ms,
            }),
        },
    );
}

/// The streaming step loop shared by root turns and dispatched subagents:
/// consume engine events into `sink`, execute tools (recursing into
/// `run_dispatch` for dispatch calls), and append results to `history`.
async fn drive_engine(
    inner: &Arc<Inner>,
    engine: &EngineModel,
    tools: &Arc<Vec<ToolEntry>>,
    system: String,
    thinking: ThinkingLevel,
    history: &Mutex<Vec<HistoryMessage>>,
    abort: &AbortFlag,
    sink: &mut LoopSink,
    inbox: Option<&TurnInbox>,
    max_steps: usize,
    dispatch: DispatchCtx,
) -> LoopOutcome {
    let mut outcome = LoopOutcome {
        text: String::new(),
        usage: None,
        aborted: false,
        error: None,
    };
    // Whether the loop ended with the model's own EndTurn — the only clean
    // exit that leaves a final message. Budget exhaustion and degenerate
    // stops fall through to the forced wrap-up below.
    let mut ended_turn = false;
    'steps: for _step in 0..max_steps {
        if abort.is_aborted() {
            outcome.aborted = true;
            break 'steps;
        }
        // Steering messages land between steps as ordinary user turns —
        // pushed through the guarded door, since a steer can arrive while
        // tools run (tail: the batched results) or several can drain in
        // one batch. Agent-delivered messages additionally annotate the
        // sub-agent's timeline so the delivery is visible.
        if let Some(inbox) = inbox {
            let steered = inner.step_input.rewrite(inbox.drain_step());
            if !steered.is_empty() {
                for message in steered {
                    if let Some(from) = message.from.as_deref() {
                        emit_subagent_blocks(inner, sink, |blocks| {
                            blocks.push(SubagentBlock::Message {
                                from: from.to_owned(),
                                text: message.text.clone(),
                            });
                        });
                    }
                    push_user_message(
                        history,
                        prompt_message(&inner.cwd, &inner.read_annex_roots, &message.text),
                    );
                }
                continue 'steps;
            }
        }
        let request = TurnRequest {
            messages: history.lock().unwrap().clone(),
            tools: tools.iter().map(|entry| entry.spec.clone()).collect(),
            params: TurnParams {
                system: Some(system.clone()),
                thinking_level: thinking,
                reasoning_contracts: Vec::new(),
                model_max_output_tokens: None,
            },
        };
        let mut stream = Box::pin(stream_step(engine.clone(), request));
        let mut pending_calls: Vec<(String, String, serde_json::Value)> = Vec::new();
        // Per-step timing for the inspector's performance stats: llm_ms
        // spans the whole model stream, ttft_ms the wait for the first
        // streamed delta, tool_ms the execution phase that follows.
        let step_started = std::time::Instant::now();
        let mut first_token_at: Option<std::time::Instant> = None;
        // The step's usage sample, held until its timing is complete —
        // the UsageUpdated carrying the breakdown fires once the step's
        // tool phase has run, or immediately when it ends without one.
        let mut step_usage: Option<engine::EngineUsage> = None;
        // This step's streamed text only — `outcome.text` accumulates the
        // whole turn, whose earlier steps are already in history via their
        // own StepEnd messages. Aborted-step repair needs the prefix alone.
        let mut step_text = String::new();
        // The step's completed message — kept for its provider-issued tool
        // call ids (see [`map_call_ids`]).
        let mut step_message: Option<HistoryMessage> = None;
        let mut step_stop: Option<EngineStopReason> = None;
        'stream: loop {
            let event = tokio::select! {
                _ = inner.aborted_notify.notified() => {
                    if abort.is_aborted() {
                        break 'stream;
                    }
                    continue 'stream;
                }
                event = stream.next() => event,
            };
            let Some(event) = event else { break 'stream };
            match event {
                Ok(EngineEvent::Delta { text }) => {
                    if first_token_at.is_none() {
                        first_token_at = Some(std::time::Instant::now());
                    }
                    outcome.text.push_str(&text);
                    step_text.push_str(&text);
                    if matches!(sink, LoopSink::Subagent { .. }) {
                        let delta = text.as_str();
                        emit_subagent_blocks(inner, sink, |blocks| {
                            subagent_text_delta(blocks, delta)
                        });
                    } else {
                        emit(inner, DriverEvent::TextDelta(text));
                    }
                }
                Ok(EngineEvent::Reasoning { delta }) => {
                    if first_token_at.is_none() {
                        first_token_at = Some(std::time::Instant::now());
                    }
                    // The child's reasoning streams as timeline blocks —
                    // presentation only, never part of its history.
                    if matches!(sink, LoopSink::Subagent { .. }) {
                        emit_subagent_blocks(inner, sink, |blocks| {
                            subagent_reasoning_delta(blocks, &delta)
                        });
                    } else {
                        emit(inner, DriverEvent::ReasoningDelta(delta));
                    }
                }
                Ok(EngineEvent::ToolCallStart {
                    tool_call_id,
                    tool_name,
                }) => {
                    if matches!(sink, LoopSink::Transcript) {
                        emit(
                            inner,
                            DriverEvent::Activity {
                                id: Some(tool_call_id),
                                kind: ActivityKind::from_tool_name(&tool_name),
                                title: tool_name,
                                detail: None,
                                complete: false,
                            },
                        );
                    }
                }
                Ok(EngineEvent::ToolCallDelta { .. }) => {}
                Ok(EngineEvent::ToolCall {
                    tool_call_id,
                    tool_name,
                    arguments,
                }) => {
                    match sink {
                        LoopSink::Transcript => {
                            emit(
                                inner,
                                DriverEvent::Activity {
                                    id: Some(tool_call_id.clone()),
                                    kind: ActivityKind::from_tool_name(&tool_name),
                                    title: tool_name.clone(),
                                    detail: Some(args_preview(&arguments)),
                                    complete: false,
                                },
                            );
                        }
                        // The child's tool block lands at the assembled call —
                        // the earliest point the one-line target exists.
                        // Presentation only: it never touches the child's
                        // history.
                        LoopSink::Subagent { .. } => {
                            emit_subagent_blocks(inner, sink, |blocks| {
                                subagent_tool_start(blocks, &tool_call_id, &tool_name, &arguments)
                            });
                        }
                    }
                    pending_calls.push((tool_call_id, tool_name, arguments));
                }
                Ok(EngineEvent::Usage { tokens }) => {
                    // The step's own usage is the delta clients sum for
                    // session totals; `outcome.usage` below is the turn's
                    // running total, which is what context occupancy reads.
                    let step = tokens;
                    outcome.usage = Some(match outcome.usage.take() {
                        Some(mut accumulated) => {
                            accumulated.input_tokens += tokens.input_tokens;
                            accumulated.output_tokens += tokens.output_tokens;
                            accumulated.cache_read += tokens.cache_read;
                            accumulated.cache_write += tokens.cache_write;
                            accumulated.reasoning_tokens += tokens.reasoning_tokens;
                            accumulated.calls += tokens.calls;
                            accumulated.cost_usd += tokens.cost_usd;
                            accumulated
                        }
                        None => tokens,
                    });
                    if matches!(sink, LoopSink::Transcript) {
                        // The step's own input side (fresh input + both cache
                        // directions) is the prompt occupancy the provider
                        // just billed — compaction's pressure signal.
                        *inner.last_prompt_tokens.lock().unwrap() =
                            step.input_tokens + step.cache_read + step.cache_write;
                    }
                    // Held, not emitted: the breakdown rides on after the
                    // step's tool phase, so its timing fields are complete.
                    step_usage = Some(step);
                }
                Ok(EngineEvent::StepEnd {
                    stop_reason,
                    message,
                }) => {
                    if !message.parts.is_empty() {
                        step_message = Some(message.clone());
                        history.lock().unwrap().push(message);
                    }
                    // A completed message closes the open narration tail —
                    // the next delta opens a fresh Text block, so each child
                    // assistant message renders as one block and the last one
                    // is the final message (which run_dispatch pops into the
                    // report, so it never renders twice).
                    if sink.subagent().is_some_and(|(_, blocks)| {
                        matches!(
                            blocks.last(),
                            Some(SubagentBlock::Reasoning {
                                streaming: true,
                                ..
                            }) | Some(SubagentBlock::Text {
                                streaming: true,
                                ..
                            })
                        )
                    }) {
                        emit_subagent_blocks(inner, sink, subagent_blocks_close);
                    }
                    step_stop = Some(stop_reason);
                    break 'stream;
                }
                Err(EngineError::Config(message)) => {
                    outcome.error = Some(format!("tide config: {message}"));
                    break 'steps;
                }
                Err(EngineError::Stream(error)) => {
                    // Overflow recovery: a context-window failure gets one
                    // compaction attempt per root turn, then the step
                    // retries against the shorter history. Children keep
                    // the plain error — their budgets are small and the
                    // wrap-up step already bounds them.
                    if dispatch.depth == 0
                        && engine::is_context_overflow_error(&error.to_string())
                        && !inner.turn_compacted.swap(true, Ordering::AcqRel)
                        && compact_history(inner, engine, history).await.is_some()
                    {
                        continue 'steps;
                    }
                    outcome.error = Some(format!("tide stream: {error}"));
                    break 'steps;
                }
            }
        }
        if abort.is_aborted() {
            outcome.aborted = true;
            // Cancellation must not leave the wire or transcript dangling:
            // an interrupted stream keeps its partial answer and closes the
            // cards its streamed calls opened, and a completed-but-
            // unexecuted step gets synthetic canceled results so its tool
            // calls stay paired.
            settle_aborted_step(
                &mut history.lock().unwrap(),
                step_message.as_ref(),
                &pending_calls,
                &step_text,
            );
            close_canceled_calls(inner, sink, &pending_calls);
            break 'steps;
        }
        // The stream is done — llm timing is final. The usage breakdown
        // waits for the tool phase only when the step has calls to run.
        let llm_ms = step_started.elapsed().as_millis() as u64;
        let ttft_ms = first_token_at
            .map(|at| at.duration_since(step_started).as_millis() as u64);
        let runs_tools = step_stop
            .as_ref()
            .is_some_and(|s| matches!(s, EngineStopReason::ToolUse));
        if !runs_tools && matches!(sink, LoopSink::Transcript) {
            if let Some(usage) = step_usage.take() {
                emit_step_usage(inner, &usage, Some(llm_ms), ttft_ms, Some(0));
            }
        }
        let stop = step_stop.unwrap_or(EngineStopReason::Other("stream ended".into()));
        match stop {
            EngineStopReason::ToolUse if !pending_calls.is_empty() => {
                let tools_started = std::time::Instant::now();
                // One user message carrying every result — tide's orchestrator
                // shape. Splitting results across consecutive user messages
                // loses them on some Anthropic-compatible endpoints.
                // Results answer the PROVIDER-issued ids the step message
                // will replay, not the streamed correlator ids.
                let call_ids = step_message
                    .as_ref()
                    .map(|message| map_call_ids(message, &pending_calls));
                // Results stage strictly at their model-order slots no
                // matter what order calls complete in, so the single
                // results message reads exactly like a serial step's.
                let mut step_results: Vec<Option<HistoryPart>> =
                    pending_calls.iter().map(|_| None).collect();
                for run in plan_tool_groups(&pending_calls) {
                    if abort.is_aborted() {
                        break;
                    }
                    match run {
                        ToolRun::Exclusive(index) => {
                            let (tool_call_id, tool_name, arguments) = &pending_calls[index];
                            let call_started = std::time::Instant::now();
                            // Once cancellation landed, remaining calls never
                            // run — a synthetic aborted outcome closes their
                            // cards and keeps the single results message
                            // complete, instead of executing more work after
                            // the user stopped the turn. The fast
                            // orchestrator-owned intercepts run inline: a
                            // follow-up parks on the turn, and the messaging
                            // pair touches only the in-memory registries.
                            let outcome = if abort.is_aborted() {
                                aborted_call_outcome()
                            } else if tool_name == "ask_followup_question" {
                                Box::pin(run_followup(inner, abort, tool_call_id, arguments)).await
                            } else if tool_name == "send_message" {
                                run_send_message(inner, &dispatch, arguments)
                            } else if tool_name == "list_agents" {
                                run_list_agents(inner)
                            } else {
                                join_tool_outcome(spawn_gated_call(
                                    inner,
                                    abort,
                                    tools,
                                    tool_call_id,
                                    tool_name,
                                    arguments,
                                    dispatch.child_id.as_deref(),
                                ))
                                .await
                            };
                            finish_tool_call(
                                inner,
                                sink,
                                call_ids.as_ref(),
                                &pending_calls[index],
                                outcome,
                                call_started,
                                index,
                                &mut step_results,
                            );
                        }
                        ToolRun::Parallel(indices) => {
                            // Parallel-safe calls overlap in bounded chunks —
                            // reads on the blocking pool, dispatched children
                            // on the async runtime (each child owns its
                            // history, sink, and todo key); each chunk's
                            // handles join in model order so results still
                            // commit in the order the model issued them.
                            for chunk in indices.chunks(MAX_PARALLEL_TOOL_CALLS) {
                                if abort.is_aborted() {
                                    break;
                                }
                                let mut handles = Vec::with_capacity(chunk.len());
                                for &index in chunk {
                                    let (tool_call_id, tool_name, arguments) =
                                        &pending_calls[index];
                                    let started = std::time::Instant::now();
                                    let handle = if tool_name == "dispatch_agent" {
                                        spawn_dispatch_call(
                                            inner,
                                            engine,
                                            tools,
                                            abort,
                                            &dispatch,
                                            tool_call_id,
                                            arguments,
                                        )
                                    } else {
                                        spawn_gated_call(
                                            inner,
                                            abort,
                                            tools,
                                            tool_call_id,
                                            tool_name,
                                            arguments,
                                            dispatch.child_id.as_deref(),
                                        )
                                    };
                                    handles.push((index, started, handle));
                                }
                                for (index, started, handle) in handles {
                                    let outcome = join_tool_outcome(handle).await;
                                    finish_tool_call(
                                        inner,
                                        sink,
                                        call_ids.as_ref(),
                                        &pending_calls[index],
                                        outcome,
                                        started,
                                        index,
                                        &mut step_results,
                                    );
                                }
                            }
                        }
                    }
                }
                // Cancellation may have stopped scheduling before every call
                // ran: unanswered ones take synthetic aborted outcomes so
                // the single results message stays complete and paired.
                for index in 0..pending_calls.len() {
                    if step_results[index].is_none() {
                        finish_tool_call(
                            inner,
                            sink,
                            call_ids.as_ref(),
                            &pending_calls[index],
                            aborted_call_outcome(),
                            std::time::Instant::now(),
                            index,
                            &mut step_results,
                        );
                    }
                }
                let step_results: Vec<HistoryPart> = step_results.into_iter().flatten().collect();
                if !step_results.is_empty() {
                    push_user_message(
                        history,
                        HistoryMessage {
                            role: HistoryRole::User,
                            parts: step_results,
                        },
                    );
                }
                if matches!(sink, LoopSink::Transcript) {
                    if let Some(usage) = step_usage.take() {
                        emit_step_usage(
                            inner,
                            &usage,
                            Some(llm_ms),
                            ttft_ms,
                            Some(tools_started.elapsed().as_millis() as u64),
                        );
                    }
                }
                continue 'steps;
            }
            EngineStopReason::EndTurn => {
                ended_turn = true;
                break 'steps;
            }
            EngineStopReason::MaxTokens => {
                outcome.error = Some("the model hit its output limit".into());
                break 'steps;
            }
            EngineStopReason::Refusal | EngineStopReason::ContentFilter => {
                outcome.error = Some("the model refused to continue".into());
                break 'steps;
            }
            _ => break 'steps,
        }
    }
    // A loop that stopped without a clean EndTurn — the step budget ran
    // out, or a degenerate tool stop — would otherwise end the turn on
    // unanswered tool results: no final message for the report ("(no
    // output)") and a wire shape resume cannot replay. One forced
    // tool-less completion makes the model answer in text.
    if needs_wrap_up(ended_turn, outcome.aborted, outcome.error.is_none()) {
        push_user_message(history, HistoryMessage::user_text(wrap_up_prompt()));
        let request = TurnRequest {
            messages: history.lock().unwrap().clone(),
            tools: Vec::new(),
            params: TurnParams {
                system: Some(system.clone()),
                thinking_level: thinking,
                reasoning_contracts: Vec::new(),
                model_max_output_tokens: None,
            },
        };
        let mut stream = Box::pin(stream_step(engine.clone(), request));
        'wrap_up: loop {
            let event = tokio::select! {
                _ = inner.aborted_notify.notified() => {
                    if abort.is_aborted() {
                        break 'wrap_up;
                    }
                    continue 'wrap_up;
                }
                event = stream.next() => event,
            };
            let Some(event) = event else { break 'wrap_up };
            match event {
                Ok(EngineEvent::Delta { text }) => {
                    outcome.text.push_str(&text);
                    if matches!(sink, LoopSink::Subagent { .. }) {
                        let delta = text.as_str();
                        emit_subagent_blocks(inner, sink, |blocks| {
                            subagent_text_delta(blocks, delta)
                        });
                    } else {
                        emit(inner, DriverEvent::TextDelta(text));
                    }
                }
                Ok(EngineEvent::Reasoning { delta }) => {
                    if matches!(sink, LoopSink::Subagent { .. }) {
                        emit_subagent_blocks(inner, sink, |blocks| {
                            subagent_reasoning_delta(blocks, &delta)
                        });
                    } else {
                        emit(inner, DriverEvent::ReasoningDelta(delta));
                    }
                }
                // No tools are offered, so calls cannot legitimately arrive;
                // stream artifacts are ignored rather than trusted.
                Ok(EngineEvent::ToolCallStart { .. })
                | Ok(EngineEvent::ToolCallDelta { .. })
                | Ok(EngineEvent::ToolCall { .. }) => {}
                Ok(EngineEvent::Usage { tokens }) => {
                    outcome.usage = Some(match outcome.usage.take() {
                        Some(mut accumulated) => {
                            accumulated.input_tokens += tokens.input_tokens;
                            accumulated.output_tokens += tokens.output_tokens;
                            accumulated.cache_read += tokens.cache_read;
                            accumulated.cache_write += tokens.cache_write;
                            accumulated.reasoning_tokens += tokens.reasoning_tokens;
                            accumulated.calls += tokens.calls;
                            accumulated.cost_usd += tokens.cost_usd;
                            accumulated
                        }
                        None => tokens,
                    });
                }
                Ok(EngineEvent::StepEnd { message, .. }) => {
                    if !message.parts.is_empty() {
                        history.lock().unwrap().push(message);
                    }
                    if sink.subagent().is_some_and(|(_, blocks)| {
                        matches!(
                            blocks.last(),
                            Some(SubagentBlock::Reasoning {
                                streaming: true,
                                ..
                            }) | Some(SubagentBlock::Text {
                                streaming: true,
                                ..
                            })
                        )
                    }) {
                        emit_subagent_blocks(inner, sink, subagent_blocks_close);
                    }
                    break 'wrap_up;
                }
                Err(EngineError::Config(message)) => {
                    outcome.error = Some(format!("tide config: {message}"));
                    break 'wrap_up;
                }
                Err(EngineError::Stream(error)) => {
                    outcome.error = Some(format!("tide stream: {error}"));
                    break 'wrap_up;
                }
            }
        }
        if abort.is_aborted() {
            outcome.aborted = true;
        }
    }
    outcome
}

/// One dispatched subagent: a child loop over the agent's own prompt and
/// toolset, presented as a background work item streaming its output. The
/// final report becomes the dispatch tool's result. Every dispatch mints a
/// durable child identity (or resumes one via `resumeFrom`): the id keys
/// the work item, the resume registry, and the messaging tools, and rides
/// the result as `dispatchId`.
///
/// The call splits by `background` (stage 5): foreground awaits the child
/// loop and returns its report (`run_dispatch_foreground`); background
/// registers the child with the job registry and acks immediately
/// (`spawn_dispatch_background`), the child running detached under its own
/// abort flag (design decision 4) with its job id set to the durable
/// `child_id` (design decision 10).
#[derive(Clone)]
struct PreparedDispatch {
    started: std::time::Instant,
    child_id: String,
    child_depth: u32,
    state: Arc<ChildState>,
    key: BackgroundWorkKey,
    agent: &'static AgentDef,
    agent_name: String,
    item_title: String,
    task: String,
    child_tools: Arc<Vec<ToolEntry>>,
    thinking: ThinkingLevel,
    system: String,
}

/// Validate the dispatch arguments and resolve the child's identity and
/// warm state — everything both dispatch flavors share before their paths
/// fork. Fails with the model-facing outcome instead of starting anything.
fn prepare_dispatch(
    inner: &Arc<Inner>,
    engine: &EngineModel,
    tools: &Arc<Vec<ToolEntry>>,
    arguments: &serde_json::Value,
    depth: u32,
    parent_agent: Option<&'static str>,
) -> Result<PreparedDispatch, ToolOutcome> {
    let started = std::time::Instant::now();
    let agent_name = arguments
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_owned();
    let task = arguments
        .get("task")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_owned();
    let title = arguments
        .get("title")
        .and_then(|value| value.as_str())
        .map(str::to_owned);
    let resume_from = arguments
        .get("resumeFrom")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_owned();
    let fork_parent = arguments
        .get("forkParent")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let fail = |message: String| ToolOutcome::failed(message);

    // A resume continues an earlier child under its identity: same agent,
    // warm history, same timeline item. Mail parked while it was stopped
    // delivers first, then the new task.
    let resumed = if resume_from.is_empty() {
        None
    } else {
        let state = inner.children.lock().unwrap().get(&resume_from);
        match state {
            Some(state) => {
                let name = state.agent_name.clone();
                Some((resume_from.clone(), state, name))
            }
            None => {
                return Err(fail(format!(
                    "unknown dispatch id {resume_from:?} — call list_agents for this session's dispatch ids"
                )));
            }
        }
    };
    let agent_name = resumed
        .as_ref()
        .map(|(_, _, name)| name.clone())
        .unwrap_or(agent_name);

    let Some(agent) = get_agent(&agent_name) else {
        return Err(fail(format!("unknown agent {agent_name:?}")));
    };
    if task.trim().is_empty() {
        return Err(fail("the dispatch task is empty".into()));
    }
    if let Some(parent_name) = parent_agent
        && let Some(parent) = get_agent(parent_name)
        && !can_dispatch_to(parent, &agent_name)
    {
        return Err(fail(format!(
            "agent {parent_name:?} may not dispatch {agent_name:?}"
        )));
    }
    let child_depth = depth + 1;
    if child_depth >= MAX_AGENT_DEPTH {
        return Err(fail("maximum sub-agent nesting depth reached".into()));
    }
    // Dispatching itself is read-tier (exploration); in Plan mode the child
    // loop's own gating rejects its mutating calls, so no gate is needed
    // here.

    // Resolve the child's durable identity and warm state. A resumed child
    // keeps its agent, history, blocks, and work-item key; a fresh one
    // starts cold — or seeded from the parent's completed context when
    // forkParent is set — and registers under a new id.
    let (child_id, state, item_title) = match &resumed {
        Some((id, state, _)) => {
            let id = id.clone();
            let state = Arc::clone(state);
            let title = state.title.clone();
            (id, state, title)
        }
        None => {
            let child_id = Uuid::new_v4().to_string();
            let item_title = title.unwrap_or_else(|| format!("{} agent", agent.name));
            let key = BackgroundWorkKey {
                kind: BackgroundWorkKind::Subagent,
                provider_id: child_id.clone(),
            };
            let state = Arc::new(ChildState::new(agent_name.clone(), item_title.clone(), key));
            if fork_parent {
                *state.history.lock().unwrap() = fork_seed_history(&inner.history.lock().unwrap());
            }
            inner
                .children
                .lock()
                .unwrap()
                .insert(child_id.clone(), Arc::clone(&state));
            (child_id, state, item_title)
        }
    };
    let key = state.key.clone();

    // Parked mail delivers first — annotated on the timeline when it
    // landed (the park path marks those) — then the task, all through the
    // guarded door.
    for message in state.mailbox.lock().unwrap().drain(..) {
        if let Some(from) = message.from.as_deref()
            && !message.annotated
        {
            state.blocks.lock().unwrap().push(SubagentBlock::Message {
                from: from.to_owned(),
                text: message.text.clone(),
            });
        }
        push_user_message(&state.history, HistoryMessage::user_text(message.text));
    }
    push_user_message(&state.history, HistoryMessage::user_text(task.clone()));

    // The child's inbox opens for the run; anything that arrives for a step
    // boundary after the loop closes parks in the mailbox for next resume.
    state.inbox.open_steering();
    *state.status.lock().unwrap() = BackgroundWorkStatus::Running;

    // The agent's toolset: its allowlist intersected with the driver's, and
    // dispatch included only when the agent grants recursion. An empty
    // allowlist is a single-shot agent with no tools.
    let allowed = effective_child_tools(agent);
    let child_tools: Arc<Vec<ToolEntry>> = if agent.allowed_tools.is_empty() {
        Arc::new(Vec::new())
    } else {
        Arc::new(
            tools
                .iter()
                .filter(|entry| allowed.iter().any(|name| *name == entry.spec.name))
                .cloned()
                .collect(),
        )
    };
    let (inherited_thinking, mode) = {
        let opts = inner.opts.lock().unwrap();
        (
            thinking_level(opts.reasoning_effort.as_deref()),
            opts.interaction_mode,
        )
    };
    let thinking = agent
        .thinking_level
        .clone()
        .map(|level| thinking_level(Some(level.as_str())))
        .unwrap_or(inherited_thinking);
    let system = contextualize_system_prompt(
        &agent.system_prompt,
        &inner.cwd,
        engine.model_id(),
        mode,
    );
    Ok(PreparedDispatch {
        started,
        child_id,
        child_depth,
        state,
        key,
        agent,
        agent_name,
        item_title,
        task,
        child_tools,
        thinking,
        system,
    })
}

/// The shared child loop: seed the timeline sink from the stored blocks,
/// drive the agent's engine loop, settle the timeline (final message pops
/// into the report), and park whatever arrived after the last step
/// boundary. Both dispatch flavors run this — foreground on the calling
/// task under the turn's abort flag, background detached under the child's
/// own flag.
async fn run_child_loop(
    inner: &Arc<Inner>,
    engine: &EngineModel,
    prepared: &PreparedDispatch,
    abort: &AbortFlag,
) -> (String, LoopOutcome) {
    // The timeline continues where a resumed child left off.
    let seed_blocks = prepared.state.blocks.lock().unwrap().clone();
    let mut sink = LoopSink::Subagent {
        key: prepared.key.clone(),
        blocks: seed_blocks,
    };
    let outcome = drive_engine(
        inner,
        engine,
        &prepared.child_tools,
        prepared.system.clone(),
        prepared.thinking,
        &prepared.state.history,
        abort,
        &mut sink,
        Some(&prepared.state.inbox),
        prepared.agent.max_steps.unwrap_or(DEFAULT_MAX_STEPS) as usize,
        DispatchCtx::child(
            prepared.child_depth,
            prepared.agent.name.as_str(),
            prepared.child_id.clone(),
        ),
    )
    .await;

    // Close the timeline: the final message renders once, as the Result
    // card — when the child completed one, its Text block pops into the
    // report and the final snapshot ships without it, leaving the
    // intermediate messages as narration. A child with no final message
    // (abandoned, errored, blank) keeps its blocks and reports the note.
    let report = if let LoopSink::Subagent { key, blocks } = &mut sink {
        let report = settle_subagent_timeline(blocks, &outcome);
        emit(
            inner,
            DriverEvent::BackgroundWork(BackgroundWorkEvent::SubagentBlocks {
                key: key.clone(),
                blocks: blocks.clone(),
            }),
        );
        *prepared.state.blocks.lock().unwrap() = blocks.clone();
        report
    } else {
        unreachable!("a dispatch always runs its child loop on the subagent sink")
    };
    // Whatever arrived after the loop's last step boundary parks in the
    // mailbox — it delivers when the child is resumed.
    for message in prepared.state.inbox.close_and_return_step() {
        prepared
            .state
            .mailbox
            .lock()
            .unwrap()
            .push_back(message);
    }
    (report, outcome)
}

impl PreparedDispatch {
    /// The foreground work item upserts (stage-5 semantics unchanged from
    /// the pre-split `run_dispatch`): `Starting` then `Running`, keyed by
    /// the child's durable id, `background: false` — a settled foreground
    /// dispatch vanishes from the summary while the Agents panel keeps it.
    fn emit_foreground_item(&self, inner: &Arc<Inner>, tool_call_id: &str) {
        let mut item = BackgroundWorkItem::new(
            BackgroundWorkKind::Subagent,
            self.child_id.clone(),
            self.item_title.clone(),
            BackgroundWorkStatus::Starting,
        );
        item.detail = Some(self.agent_name.clone());
        item.origin_activity_id = Some(tool_call_id.to_owned());
        item.background = false;
        // The task rides the item as the timeline's prompt header — the
        // panel renders it above the block stream, not as log text.
        item.task = Some(self.task.clone());
        emit(
            inner,
            DriverEvent::BackgroundWork(BackgroundWorkEvent::Upsert(item.clone())),
        );
        item.status = BackgroundWorkStatus::Running;
        emit(
            inner,
            DriverEvent::BackgroundWork(BackgroundWorkEvent::Upsert(item)),
        );
    }

    /// The background work item's enrichment, emitted once after the
    /// registry's own `Starting`/`Running` upserts: the fields the registry
    /// snapshot cannot carry (agent, origin call, the task header). Title
    /// stays with the registry's label (the task); `background: true`,
    /// `can_stop`, and `control_id = child_id` already ride those upserts.
    fn emit_background_item(&self, inner: &Arc<Inner>, tool_call_id: &str) {
        let mut item = BackgroundWorkItem::new(
            BackgroundWorkKind::Subagent,
            self.child_id.clone(),
            String::new(),
            BackgroundWorkStatus::Running,
        );
        item.detail = Some(self.agent_name.clone());
        item.origin_activity_id = Some(tool_call_id.to_owned());
        item.task = Some(self.task.clone());
        item.background = true;
        item.can_stop = true;
        item.control_id = Some(self.child_id.clone());
        emit(
            inner,
            DriverEvent::BackgroundWork(BackgroundWorkEvent::Upsert(item)),
        );
    }

    /// Undo prepare's run-state after a rejected registry start: the child
    /// never ran, so its roster record rests (resumable) and anything that
    /// queued for the run parks back into the mailbox.
    fn revert_start(&self, _inner: &Arc<Inner>) {
        *self.state.status.lock().unwrap() = BackgroundWorkStatus::Completed;
        for message in self.state.inbox.close_and_return_step() {
            self.state.mailbox.lock().unwrap().push_back(message);
        }
    }
}

/// Map a settled child loop onto the job outcome's vocabulary: a cancel
/// (job_kill, session teardown) aborts the child's own flag, so aborted-
/// with-no-error means stopped; a broken loop means failed.
fn settled_job_status(outcome: &LoopOutcome) -> (SettledStatus, Option<String>) {
    if let Some(error) = &outcome.error {
        (SettledStatus::Failed, Some(error.clone()))
    } else if outcome.aborted {
        (SettledStatus::Stopped, Some("stopped by request".into()))
    } else {
        (SettledStatus::Completed, None)
    }
}

/// The foreground dispatch (today's body): the call awaits the child loop
/// and the final report becomes the tool result.
async fn run_dispatch_foreground(
    inner: &Arc<Inner>,
    engine: &EngineModel,
    tools: &Arc<Vec<ToolEntry>>,
    tool_call_id: &str,
    arguments: &serde_json::Value,
    parent_abort: &AbortFlag,
    depth: u32,
    parent_agent: Option<&'static str>,
) -> ToolOutcome {
    let prepared = match prepare_dispatch(inner, engine, tools, arguments, depth, parent_agent) {
        Ok(prepared) => prepared,
        Err(outcome) => return outcome,
    };
    prepared.emit_foreground_item(inner, tool_call_id);
    let (report, outcome) = run_child_loop(inner, engine, &prepared, parent_abort).await;

    let final_status = if outcome.error.is_some() || outcome.aborted {
        BackgroundWorkStatus::Failed
    } else {
        BackgroundWorkStatus::Completed
    };
    *prepared.state.status.lock().unwrap() = final_status;
    // The report is the timeline's answer element: it rides `output`, where
    // the panel's Result card reads it — never as streamed log text.
    let mut item = BackgroundWorkItem::new(
        BackgroundWorkKind::Subagent,
        prepared.child_id.clone(),
        prepared.item_title.clone(),
        final_status,
    );
    item.detail = Some(prepared.agent_name.clone());
    item.origin_activity_id = Some(tool_call_id.to_owned());
    item.task = Some(prepared.task.clone());
    item.output = Some(report.clone());
    item.duration_ms = Some(prepared.started.elapsed().as_millis() as u64);
    emit(
        inner,
        DriverEvent::BackgroundWork(BackgroundWorkEvent::Upsert(item)),
    );
    // The dispatch id is the durable handle: the schema documents it in the
    // output (for resumeFrom) and the display card carries it for the UI.
    ToolOutcome::executed(format!(
        "{report}\n\ndispatchId: {}",
        prepared.child_id
    ))
    .with_display(ToolDisplay::Agent {
        agent_name: prepared.agent_name.clone(),
        title: Some(prepared.item_title.clone()),
        task: prepared.task.clone(),
        report,
        reasoning: None,
        dispatch_id: Some(prepared.child_id.clone()),
    })
}

/// The background dispatch (stage 5): the child loop detaches onto the
/// session runtime under a CHILD-OWNED abort flag, the producer registers
/// with the job registry (job id = child id, decision 10), and the one-line
/// ack is the tool result. The child's final report lands in the job's
/// `output`; its completion reaches the model as a wake notice. Subagent
/// block streaming is unchanged — it stays on the child-loop emit path.
fn spawn_dispatch_background(
    inner: &Arc<Inner>,
    engine: &EngineModel,
    tools: &Arc<Vec<ToolEntry>>,
    tool_call_id: &str,
    arguments: &serde_json::Value,
    depth: u32,
    parent_agent: Option<&'static str>,
) -> ToolOutcome {
    let prepared = match prepare_dispatch(inner, engine, tools, arguments, depth, parent_agent) {
        Ok(prepared) => prepared,
        Err(outcome) => return outcome,
    };
    // Published jobs are never tied to the spawning turn's abort flag
    // (design decision 4): the child owns its flag, and only the job's
    // cancel hook (job_kill, session teardown) aborts it.
    let child_abort = AbortFlag::new();
    let session = inner.session_id.clone();
    let rt = inner.rt.handle().clone();
    let loop_inner = Arc::clone(inner);
    let loop_engine = engine.clone();
    let loop_prepared = prepared.clone();
    let loop_abort = child_abort.clone();
    let key = prepared.key.clone();
    let child_id = prepared.child_id.clone();
    let started = global_job_registry().start(JobStart {
        kind: BackgroundWorkKind::Subagent,
        prefix: "sub",
        id: Some(child_id.clone()),
        label: prepared.task.clone(),
        owner_session: session,
        output_limit: None,
        streams: false,
        run: Box::new(move |handle| {
            let producer_done = handle.done.clone();
            rt.spawn(async move {
                let (report, outcome) =
                    run_child_loop(&loop_inner, &loop_engine, &loop_prepared, &loop_abort).await;
                // The child state has lived in `Children` since prepare, so
                // the loop settling is the last thing `done` waits on.
                let (status, detail) = settled_job_status(&outcome);
                *loop_prepared.state.status.lock().unwrap() = match status {
                    SettledStatus::Stopped => BackgroundWorkStatus::Stopped,
                    SettledStatus::Failed => BackgroundWorkStatus::Failed,
                    SettledStatus::Completed => BackgroundWorkStatus::Completed,
                };
                producer_done.resolve(JobOutcome {
                    status,
                    detail,
                    output: Some(report),
                });
            });
            Ok(JobHooks {
                cancel: Box::new(move |_| child_abort.abort()),
                done: handle.done.clone(),
            })
        }),
    });
    match started {
        Ok(started_key) => {
            debug_assert_eq!(started_key, key);
            prepared.emit_background_item(inner, tool_call_id);
            ToolOutcome::executed(format!(
                "started background job {child_id}. The sub-agent keeps running in its own context and streams into the Agents panel; you are notified in-session when it completes — read its report then with job_output(job_id: \"{child_id}\"), and stop it early with job_kill(job_id: \"{child_id}\"). Do not poll or sleep on it.\n\ndispatchId: {child_id}"
            ))
            .with_meta("backgrounded")
        }
        // Admission or identity rejection: nothing runs, and the child's
        // warm state reverts to a settled, resumable record with the task
        // parked back into its mailbox.
        Err(error) => {
            prepared.revert_start(inner);
            ToolOutcome::failed(format!("Could not start background job: {error}"))
        }
    }
}

/// Seed for a fork-parented child: the parent's context up to (excluding)
/// the CURRENT turn — dsh's fork backend seeds from the parent's completed
/// history at the same boundary. The turn boundary is the last user Text
/// message that follows a final answer (an assistant message with no tool
/// calls, or the conversation's start); a user Text after tool calls is
/// mid-turn steering and belongs to the turn being dropped.
fn fork_seed_history(history: &[HistoryMessage]) -> Vec<HistoryMessage> {
    let mut boundary = None;
    let mut seen_assistant = false;
    let mut prev_assistant_had_calls = false;
    for (index, message) in history.iter().enumerate() {
        match message.role {
            HistoryRole::Assistant => {
                prev_assistant_had_calls = message
                    .parts
                    .iter()
                    .any(|part| matches!(part, HistoryPart::ToolCall { .. }));
                seen_assistant = true;
            }
            HistoryRole::User
                if message
                    .parts
                    .iter()
                    .any(|part| matches!(part, HistoryPart::Text { .. })) =>
            {
                if !seen_assistant || !prev_assistant_had_calls {
                    boundary = Some(index);
                }
            }
            _ => {}
        }
    }
    match boundary {
        Some(cut) => history[..cut].to_vec(),
        None => history.to_vec(),
    }
}

/// Route one agent-to-agent message (the `send_message` tool). Delivery is
/// fire-and-forget: a running recipient gets it at its next step boundary
/// (exactly like steering on the root loop), a stopped one parks it in its
/// mailbox for delivery on resume, and `main` injects into the root loop's
/// next step. A reply only comes if the recipient sends one back.
fn run_send_message(
    inner: &Arc<Inner>,
    dispatch: &DispatchCtx,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    let agent_id = arguments
        .get("agentId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let message = arguments
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if agent_id.is_empty() {
        return ToolOutcome::failed("Missing required arg: agentId".to_owned());
    }
    if message.is_empty() {
        return ToolOutcome::failed("Missing required arg: message".to_owned());
    }
    // No messaging from a child already at max depth — the tree stays
    // bounded.
    if dispatch.depth >= MAX_AGENT_DEPTH {
        return ToolOutcome::failed(
            "maximum sub-agent nesting depth reached — messaging is unavailable here".to_owned(),
        );
    }
    if agent_id == "main" {
        inner.inbox.inject(message);
        return ToolOutcome::executed(
            "delivered to main — it arrives at the main agent's next step".to_owned(),
        );
    }
    let Some(state) = inner.children.lock().unwrap().get(&agent_id) else {
        return ToolOutcome::failed(format!(
            "unknown agent id {agent_id:?} — call list_agents for this session's ids"
        ));
    };
    let queued = state.inbox.step_depth() + state.mailbox.lock().unwrap().len();
    if queued >= MAX_CHILD_INBOX_DEPTH {
        return ToolOutcome::failed(format!(
            "agent {agent_id:?}'s inbox is full ({MAX_CHILD_INBOX_DEPTH} messages) — it must catch up first"
        ));
    }
    let running = *state.status.lock().unwrap() == BackgroundWorkStatus::Running;
    // The sender's label: "main" from the root loop, else the calling
    // child's own agent name (exactly what DispatchCtx carries).
    let from = dispatch.parent_agent.unwrap_or("main");
    let delivered = running && state.inbox.deliver(from, message.clone());
    if delivered {
        ToolOutcome::executed(format!(
            "delivered to {} — it arrives at that agent's next step",
            state.agent_name
        ))
    } else {
        // Stopped, or a delivery racing the loop's close: park in the
        // mailbox and annotate the stopped child's timeline now — the
        // stored blocks are authoritative while no loop is running. The
        // parked marker keeps the resume drain from duplicating it.
        state
            .mailbox
            .lock()
            .unwrap()
            .push_back(StepMessage::parked(Some(from.to_owned()), message.clone()));
        let blocks = {
            let mut blocks = state.blocks.lock().unwrap();
            blocks.push(SubagentBlock::Message {
                from: from.to_owned(),
                text: message,
            });
            blocks.clone()
        };
        emit(
            inner,
            DriverEvent::BackgroundWork(BackgroundWorkEvent::SubagentBlocks {
                key: state.key.clone(),
                blocks,
            }),
        );
        ToolOutcome::executed(format!(
            "parked for {} — it is not running; the message delivers when it is resumed",
            state.agent_name
        ))
    }
}

/// The session's agent roster (the `list_agents` tool): the lead agent plus
/// every dispatched child with its dispatch id, agent, status, and title.
fn run_list_agents(inner: &Arc<Inner>) -> ToolOutcome {
    let mut lines = vec!["main — running — this conversation's lead agent".to_owned()];
    for (id, state) in inner.children.lock().unwrap().snapshot() {
        let status = match *state.status.lock().unwrap() {
            BackgroundWorkStatus::Running => "running",
            BackgroundWorkStatus::Failed => "failed",
            _ => "completed",
        };
        lines.push(format!(
            "{id} — {} — {status} — {}",
            state.agent_name, state.title
        ));
    }
    ToolOutcome::executed(lines.join("\n"))
}

/// Whether the newest prompt occupancy is high enough to compact before
/// the turn starts.
fn should_compact(last_prompt_tokens: u64, window: Option<u64>) -> bool {
    match window {
        Some(window) if window > 0 => {
            (last_prompt_tokens as f64) >= COMPACTION_PRESSURE * window as f64
        }
        _ => false,
    }
}

/// Rough character size of one history message — measurement for cut
/// selection and stats only.
fn message_chars(message: &HistoryMessage) -> usize {
    message
        .parts
        .iter()
        .map(|part| match part {
            HistoryPart::Text { text } => text.chars().count(),
            HistoryPart::Thinking { text } => text.chars().count(),
            HistoryPart::ToolCall { arguments, .. } => arguments.to_string().chars().count(),
            HistoryPart::ToolResult { output, .. } => output.chars().count(),
            // The base64 payload IS the wire cost of an inlined image, so
            // compaction's budget math weighs it like the transport does.
            HistoryPart::Image { data_base64, .. } => data_base64.chars().count(),
        })
        .sum()
}

fn estimate_tokens(chars: usize) -> u64 {
    (chars as f64 / EST_CHARS_PER_TOKEN) as u64
}

/// Pass A of compaction — the cheap lever: tool results older than the
/// last `keep_turns` user turns get bulky outputs replaced by a head/tail
/// stub, in place. Pairing is untouched (same parts, shorter text), and
/// returns the chars removed.
fn prune_tool_results(
    history: &mut [HistoryMessage],
    keep_turns: usize,
    min_chars: usize,
) -> usize {
    // The recency boundary: the message index of the keep_turns-th user
    // Text message from the end (everything before it is prune-eligible).
    let mut boundary = history.len();
    let mut seen = 0;
    for (index, message) in history.iter().enumerate().rev() {
        if message.role == HistoryRole::User
            && message
                .parts
                .iter()
                .any(|part| matches!(part, HistoryPart::Text { .. }))
        {
            seen += 1;
            if seen == keep_turns {
                boundary = index;
                break;
            }
        }
    }
    if seen < keep_turns {
        return 0; // the whole conversation is inside the recency window
    }
    let mut removed = 0usize;
    for message in history[..boundary].iter_mut() {
        for part in message.parts.iter_mut() {
            if let HistoryPart::ToolResult { output, .. } = part {
                let len = output.chars().count();
                if len > min_chars {
                    let head: String = output.chars().take(PRUNE_KEEP_CHARS).collect();
                    let tail: String = output
                        .chars()
                        .skip(len.saturating_sub(PRUNE_KEEP_CHARS))
                        .collect();
                    let stub = format!(
                        "{head}\n…[pruned {} chars — ask again if you need the full output]\n{tail}",
                        len - 2 * PRUNE_KEEP_CHARS
                    );
                    removed += len - stub.chars().count();
                    *output = stub;
                }
            }
        }
    }
    removed
}

/// Pass B's cut: the index where the kept tail starts. The tail must begin
/// at an ASSISTANT message — pairing-safe by construction (its tool calls'
/// results live inside the tail) and a summary user message before an
/// assistant can never land adjacent to another user message. The latest
/// assistant start whose tail fits the char budget wins; `None` when no
/// assistant exists or everything fits (nothing to shadow).
fn compaction_cut(history: &[HistoryMessage], max_tail_chars: usize) -> Option<usize> {
    if history.is_empty() {
        return None;
    }
    let total: usize = history.iter().map(message_chars).sum();
    if total <= max_tail_chars {
        return None;
    }
    let mut running = 0usize;
    let mut cut = None;
    for (index, message) in history.iter().enumerate().rev() {
        running += message_chars(message);
        if running > max_tail_chars {
            break;
        }
        if message.role == HistoryRole::Assistant {
            cut = Some(index);
        }
    }
    cut
}

/// Render the shadowed range for the summarizer: `user:`/`assistant:`
/// lines with tool results capped, the whole render capped from the front
/// (oldest dropped first, noted) so the summary call itself fits.
fn render_range_for_summary(history: &[HistoryMessage]) -> String {
    let mut lines = Vec::new();
    for message in history {
        let role = match message.role {
            HistoryRole::User => "user",
            HistoryRole::Assistant => "assistant",
            HistoryRole::System => "system",
        };
        for part in &message.parts {
            match part {
                HistoryPart::Text { text } => {
                    lines.push(format!("{role}: {text}"));
                }
                HistoryPart::Thinking { .. } => {}
                HistoryPart::ToolCall {
                    tool_name,
                    arguments,
                    ..
                } => {
                    lines.push(format!("{role} called {tool_name}({arguments})"));
                }
                HistoryPart::ToolResult {
                    tool_name, output, ..
                } => {
                    let len = output.chars().count();
                    let body: String = if len > 400 {
                        output.chars().take(400).collect()
                    } else {
                        output.to_owned()
                    };
                    lines.push(format!("result of {tool_name}: {body}"));
                }
                HistoryPart::Image { .. } => {
                    lines.push(format!("{role}: [image attached]"));
                }
            }
        }
    }
    let mut rendered = lines.join("\n\n");
    if rendered.chars().count() > SUMMARY_RENDER_CAP_CHARS {
        let skip = rendered.chars().count() - SUMMARY_RENDER_CAP_CHARS;
        let kept: String = rendered.chars().skip(skip).collect();
        rendered = format!("[older messages omitted]\n\n{kept}");
    }
    rendered
}

/// One context compaction: prune bulky old tool results first (no model
/// call), then — when the shadowed range still justifies it — summarize it
/// into a leading user message and keep a pairing-safe tail. Returns the
/// record when anything ran, with the transcript card and meter update
/// already emitted. `None` means there was nothing useful to do.
async fn compact_history(
    inner: &Arc<Inner>,
    engine: &EngineModel,
    history: &Mutex<Vec<HistoryMessage>>,
) -> Option<CompactionRecord> {
    let window = (*inner.context_window.lock().unwrap())?;
    let mut messages = history.lock().unwrap().clone();
    let turn = messages
        .iter()
        .filter(|message| {
            message.role == HistoryRole::User
                && message
                    .parts
                    .iter()
                    .any(|part| matches!(part, HistoryPart::Text { .. }))
        })
        .count() as u64
        + 1;
    let before_chars: usize = messages.iter().map(message_chars).sum();
    let tokens_before = {
        let last = *inner.last_prompt_tokens.lock().unwrap();
        if last > 0 {
            last
        } else {
            estimate_tokens(before_chars)
        }
    };

    let removed = prune_tool_results(&mut messages, COMPACT_KEEP_TURNS, PRUNE_MIN_CHARS);
    let target_tail_chars = (window as f64 * COMPACT_TAIL_FRACTION * EST_CHARS_PER_TOKEN) as usize;
    let mut summarized = false;
    let mut summary_text = None;
    if let Some(cut) = compaction_cut(&messages, target_tail_chars)
        && cut > 0
    {
        let rendered = render_range_for_summary(&messages[..cut]);
        if let Some(summary) = summarize_range(engine, rendered).await {
            let tail = messages.split_off(cut);
            messages.clear();
            messages.push(HistoryMessage::user_text(format!(
                "Summary of the earlier conversation (compacted):\n\n{summary}"
            )));
            messages.extend(tail);
            summarized = true;
            summary_text = Some(summary);
        }
    }
    if removed == 0 && !summarized {
        return None;
    }
    let after_chars: usize = messages.iter().map(message_chars).sum();
    let tokens_after = estimate_tokens(after_chars).max(1);
    *history.lock().unwrap() = messages;

    let record = CompactionRecord {
        turn,
        tokens_before,
        tokens_after,
        summarized,
    };
    let detail = format!(
        "turn {turn}: ~{}K → ~{}K tokens{}",
        tokens_before / 1000,
        tokens_after / 1000,
        if summarized {
            " (summarized)"
        } else {
            " (pruned)"
        },
    );
    let body = summary_text.clone().unwrap_or_else(|| {
        format!("Pruned {removed} chars of stale tool output; no summary was needed.")
    });
    let mut item = super::activity::tool_activity(
        None,
        ActivityKind::Compact,
        "context compacted".to_owned(),
        None,
        Some(&serde_json::Value::String(body)),
        None,
        false,
        true,
    );
    item.detail = Some(detail);
    item.compaction = Some(record);
    emit(inner, DriverEvent::RichActivity(item));
    emit(
        inner,
        DriverEvent::UsageUpdated {
            context_tokens: Some(tokens_after),
            context_window: Some(window),
            breakdown: None,
        },
    );
    Some(record)
}

/// The one-shot summarizer: no tools, thinking off, the session engine —
/// the same shape as the commit-message generation. `None` on failure or
/// an empty answer (the caller skips pass B).
async fn summarize_range(engine: &EngineModel, rendered: String) -> Option<String> {
    const SYSTEM: &str = "Summarize the following conversation excerpt so work can continue after it is compacted. Preserve: the task and goals, key decisions and their reasons, current state (files changed, commands run, findings so far), and open questions or next steps. Be dense and factual, in plain prose — no preamble, no headings for their own sake.";
    let request = TurnRequest {
        messages: vec![HistoryMessage::user_text(rendered)],
        tools: Vec::new(),
        params: TurnParams {
            system: Some(SYSTEM.to_owned()),
            thinking_level: ThinkingLevel::Off,
            reasoning_contracts: Vec::new(),
            model_max_output_tokens: None,
        },
    };
    let mut stream = Box::pin(stream_step(engine.clone(), request));
    let mut text = String::new();
    while let Some(event) = stream.next().await {
        match event {
            Ok(EngineEvent::Delta { text: delta }) => text.push_str(&delta),
            Ok(EngineEvent::StepEnd { message, .. }) => {
                if text.trim().is_empty() {
                    for part in &message.parts {
                        if let HistoryPart::Text { text: part_text } = part {
                            text.push_str(part_text);
                        }
                    }
                }
                break;
            }
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

async fn run_turn(inner: &Arc<Inner>, message: StepMessage) {
    // The prompt-entry point: a consumed User message refills the wake
    // budget — the user is back at the wheel. Job/Agent-tagged messages
    // never refill, so an unattended session stays valved (design
    // decision 3).
    inner.wake.refill_on_user_message(&message);
    let turn_abort = {
        let mut flag = inner.abort.lock().unwrap();
        *flag = AbortFlag::new();
        flag.clone()
    };
    inner.inbox.open_steering();

    // The prompt goes through the guarded door: a previous turn that ended
    // without any assistant output (aborted before the engine answered,
    // or failed before it ran) leaves a user message as the tail, and this
    // prompt must not land back-to-back with it. Image attachments ride
    // along as image parts, so a vision model sees the bytes, not a path.
    push_user_message(
        &inner.history,
        prompt_message(&inner.cwd, &inner.read_annex_roots, &message.text),
    );
    emit(inner, DriverEvent::TurnStarted);

    let selection = match resolve_engine(inner) {
        Ok(selection) => selection,
        Err(error) => {
            emit(inner, DriverEvent::Error(error.to_string()));
            finish_turn_emit(inner, false);
            inner.inbox.close_and_rescue();
            turn_finished(inner);
            return;
        }
    };
    if let Some(window) = selection.context_window {
        *inner.context_window.lock().unwrap() = Some(window);
    }
    let engine = match EngineModel::from_config(&EngineModelConfig {
        api_style: selection.api_style,
        base_url: selection.base_url.clone(),
        api_key: selection.api_key.clone(),
        model_id: selection.model_id.clone(),
    }) {
        Ok(engine) => engine,
        Err(error) => {
            emit(inner, DriverEvent::Error(format!("tide engine: {error}")));
            finish_turn_emit(inner, false);
            inner.inbox.close_and_rescue();
            turn_finished(inner);
            return;
        }
    };
    inner.turn_compacted.store(false, Ordering::Release);
    // Pressure compaction: when the last step's prompt already filled most
    // of the window, compact before the turn starts — the transcript keeps
    // everything; the card marks what the model now sees.
    if should_compact(
        *inner.last_prompt_tokens.lock().unwrap(),
        *inner.context_window.lock().unwrap(),
    ) {
        compact_history(inner, &engine, &inner.history).await;
    }
    let tools = Arc::new(toolset());
    let (thinking, mode) = {
        let opts = inner.opts.lock().unwrap();
        (
            thinking_level(opts.reasoning_effort.as_deref()),
            opts.interaction_mode,
        )
    };
    let system = contextualize_system_prompt(&SYSTEM_PROMPT, &inner.cwd, engine.model_id(), mode);
    let mut sink = LoopSink::Transcript;
    let outcome = drive_engine(
        inner,
        &engine,
        &tools,
        system,
        thinking,
        &inner.history,
        &turn_abort,
        &mut sink,
        Some(&inner.inbox),
        MAX_STEPS,
        DispatchCtx::ROOT,
    )
    .await;
    if let Some(ref error) = outcome.error {
        emit(inner, DriverEvent::Error(error.clone()));
    }
    // Close an aborted exchange: when the turn died before any assistant
    // output (or between tool results and the answer), the tail is a user
    // message and the next prompt — or a restart's rebuilt history — would
    // land two user messages back-to-back on the wire. A no-op when the
    // tail is already assistant.
    if outcome.aborted {
        ensure_assistant_tail(&mut inner.history.lock().unwrap());
    }
    // Steering the finished turn never claimed becomes the next prompt;
    // injected context stays queued for whichever turn runs next.
    inner.inbox.close_and_rescue();
    finish_turn_emit(inner, outcome.error.is_none() && !outcome.aborted);
    turn_finished(inner);
}

fn finish_turn_emit(inner: &Arc<Inner>, success: bool) {
    emit(
        inner,
        DriverEvent::TurnFinished {
            success,
            summary: None,
        },
    );
}

fn turn_finished(inner: &Arc<Inner>) {
    inner.turn_active.store(false, Ordering::Release);
    if let Some(message) = inner.inbox.pop_turn() {
        claim_and_spawn_turn(inner, message);
    }
}

/// The ONE door that opens a turn: claim via `turn_active`'s
/// compare_exchange, spawn only on a win, and hold the message for the
/// next turn on a loss. `prompt()`, `turn_finished`, and the wake's idle
/// lane all share it — `spawn_turn` is a raw spawner, so an unclaimed
/// spawn would put two turn loops on one `Inner` (each `run_turn` resets
/// the abort flag), and a pushed copy that also spawned would run twice
/// (the pushed copy is popped again at this turn's end).
fn claim_and_spawn_turn(inner: &Arc<Inner>, message: StepMessage) {
    if inner
        .turn_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        spawn_turn(inner, message);
    } else {
        // The UI steers running turns; a prompt (or a wake notice that
        // lost the claim) that lands mid-turn is held for the next one.
        inner.inbox.push_turn_message(message);
    }
}

/// The `UserInputQuestion` a follow-up tool call's arguments describe, built
/// through tools' forgiving normalization (plain-string options wrap,
/// `label`/`value`/`text` all read, the GLM mis-split question repaired).
/// `None` when the args carry no question — the failed-outcome path.
fn followup_question(arguments: &serde_json::Value) -> Option<UserInputQuestion> {
    let ask = tools::normalize_followup_args(arguments)?;
    Some(UserInputQuestion {
        id: String::new(),
        header: "Follow-up".into(),
        question: ask.question,
        options: ask
            .options
            .iter()
            .map(|option| UserInputOption {
                label: option.label.clone(),
                description: option.description.clone(),
            })
            .collect(),
        multi_select: ask.multiple,
    })
}

/// The answer text the submitted card resolves the parked ask with: every
/// non-empty answer of every question, joined ", " (single-select asks
/// carry one). `None` when the card submitted nothing — the dismissed ask.
fn followup_answer_text(answers: &[UserInputAnswer]) -> Option<String> {
    let joined = answers
        .iter()
        .flat_map(|answer| answer.answers.iter())
        .map(|answer| answer.trim())
        .filter(|answer| !answer.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    (!joined.is_empty()).then_some(joined)
}

/// `ask_followup_question`'s parked body — the tide orchestrator's
/// `run_followup_tool` flow on this driver's seams: normalize the args,
/// surface the question as a [`DriverEvent::UserInputRequested`] (one
/// question per call; the id is the tool call id, so `respond_user_input`
/// resolves the exact ask), park on the followups map until the UI answers
/// or the turn aborts/times out, and return the pick as the tool result.
async fn run_followup(
    inner: &Arc<Inner>,
    turn_abort: &AbortFlag,
    tool_call_id: &str,
    arguments: &serde_json::Value,
) -> ToolOutcome {
    let Some(mut question) = followup_question(arguments) else {
        return ToolOutcome::failed("Missing required arg: question");
    };
    if question.options.len() > 4 {
        return ToolOutcome::failed(format!(
            "Too many options ({}). Max 4 — narrow it down.",
            question.options.len()
        ));
    }
    question.id = tool_call_id.to_owned();
    let (answer_tx, answer_rx) = crossbeam_channel::bounded(1);
    inner
        .followups
        .lock()
        .unwrap()
        .insert(tool_call_id.to_owned(), answer_tx);
    emit(
        inner,
        DriverEvent::UserInputRequested {
            request_id: tool_call_id.to_owned(),
            questions: vec![question],
        },
    );
    let answer = tokio::select! {
        _ = inner.aborted_notify.notified() => {
            if turn_abort.is_aborted() {
                None
            } else {
                answer_rx.recv().ok().flatten()
            }
        }
        answer = tokio::task::spawn_blocking({
            let rx = answer_rx.clone();
            move || {
                // Park until the UI answers; a dropped sender (card
                // dismissed, session closed) reads as unanswered.
                rx.recv().ok().flatten()
            }
        }) => answer.unwrap_or(None),
        // A ghost-held park would own the turn slot forever (the tide
        // orchestrator expires the same way).
        _ = tokio::time::sleep(std::time::Duration::from_secs(600)) => None,
    };
    inner.followups.lock().unwrap().remove(tool_call_id);
    tools::followup_pick_outcome(answer.as_deref())
}

/// The Plan/Build chip as the first link in the tool gate chain — the
/// whole of Tide's permission model, unchanged (see [`plan_allows`]).
struct PlanModeGate;

impl ToolGate for PlanModeGate {
    fn check(&self, call: PendingToolCall<'_>, mode: InteractionMode) -> Result<(), String> {
        plan_allows(mode, call.tool_name, call.arguments)
    }
}

/// Tide's permission model, whole and entire: the composer's Plan/Build
/// chip. Build runs every tool; Plan is read-only — anything past
/// [`RiskTier::ReadOnly`] is rejected with a reason that tells the model to
/// present its plan, and the user escalates by toggling the chip to Build,
/// never through a permission card. The risk tier itself is tool metadata
/// (tide's per-tool table, `git` refined per subcommand), not a policy.
fn plan_allows(
    mode: InteractionMode,
    tool_name: &str,
    arguments: &serde_json::Value,
) -> Result<(), String> {
    if mode == InteractionMode::Build {
        return Ok(());
    }
    match risk_tier_for_call(tool_name, arguments) {
        RiskTier::ReadOnly => Ok(()),
        tier => Err(format!(
            "Plan mode is read-only — {tool_name} (risk tier: {}) is blocked. Present the plan; the user can switch the mode to Build to run it.",
            tier.label()
        )),
    }
}

/// Streamed `ToolCall` events carry rig's internal correlator ids, while the
/// completed step message's `ToolCall` parts carry the provider-issued ids
/// that Anthropic-style replay must pair `tool_result` blocks against (some
/// endpoints silently drop unpaired results — the model then reads its tool
/// output as empty). Match pending calls to the step message's parts by
/// (tool name, arguments), in order — tide orchestrator's `map_call_ids`.
fn map_call_ids(
    step_message: &HistoryMessage,
    pending: &[(String, String, serde_json::Value)],
) -> HashMap<String, String> {
    let mut groups: HashMap<(String, String), VecDeque<String>> = HashMap::new();
    for part in &step_message.parts {
        if let HistoryPart::ToolCall {
            id,
            tool_name,
            arguments,
        } = part
        {
            groups
                .entry((tool_name.clone(), arguments.to_string()))
                .or_default()
                .push_back(id.clone());
        }
    }
    pending
        .iter()
        .map(|(call_id, tool_name, arguments)| {
            let key = (tool_name.clone(), arguments.to_string());
            let mapped = groups
                .get_mut(&key)
                .and_then(|queue| queue.pop_front())
                .unwrap_or_else(|| call_id.clone());
            (call_id.clone(), mapped)
        })
        .collect()
}

/// Gate one call and execute it. Blocking — every caller hands it to the
/// blocking pool, serially awaited or pooled for parallel-safe runs.
fn run_gated_call(
    inner: &Arc<Inner>,
    turn_abort: &AbortFlag,
    tool: &Arc<dyn Tool>,
    tool_call_id: &str,
    tool_name: &str,
    arguments: &serde_json::Value,
    session_override: Option<&str>,
) -> ToolOutcome {
    let mode = inner.opts.lock().unwrap().interaction_mode;
    if let Err(reason) = inner.tool_gates.check(
        PendingToolCall {
            tool_call_id,
            tool_name,
            arguments,
        },
        mode,
    ) {
        // The block is transcript-visible — one completed activity naming
        // the tool and why it was not run.
        emit(
            inner,
            DriverEvent::Activity {
                id: Some(tool_call_id.to_owned()),
                kind: ActivityKind::from_tool_name(tool_name),
                title: tool_name.to_owned(),
                detail: Some(reason.clone()),
                complete: true,
            },
        );
        return rejected_outcome(reason);
    }
    // A dispatched child's executions key apart from the parent's: the
    // session id is the todo store's key, so a child's todo writes land in
    // its own slot instead of clobbering the parent's list. The workspace
    // id is the PROJECT id — the RAG index and agent memory are per
    // project, shared across every session (and child) under it.
    let session_id = session_override
        .unwrap_or(inner.session_id.as_str())
        .to_owned();
    let ctx = ToolContext {
        session_id: session_id.clone(),
        workspace_root: inner.cwd.clone(),
        extra_read_roots: inner.read_annex_roots.clone(),
        workspace_id: inner
            .project_id
            .clone()
            .unwrap_or_else(|| inner.session_id.clone()),
        todo_state: Arc::clone(&inner.todo_state),
        abort: turn_abort.clone(),
        // The session's runtime handle — job_output waits bridge the
        // registry's settlement watch through it (legal here: tool bodies
        // run under spawn_blocking).
        runtime: Some(inner.rt.handle().clone()),
    };
    match tool.execute(&ctx, arguments.clone()) {
        Ok(outcome) => outcome,
        Err(error) => ToolOutcome::failed(format!("{error}")),
    }
}

/// Spawn one gated call on the blocking pool. The unknown-tool rejection
/// lives inside the task so the serial and pooled paths share it.
fn spawn_gated_call(
    inner: &Arc<Inner>,
    turn_abort: &AbortFlag,
    tools: &[ToolEntry],
    tool_call_id: &str,
    tool_name: &str,
    arguments: &serde_json::Value,
    session_override: Option<&str>,
) -> tokio::task::JoinHandle<ToolOutcome> {
    let tool = tools
        .iter()
        .find(|entry| entry.spec.name == tool_name)
        .map(|entry| Arc::clone(&entry.tool));
    let inner = Arc::clone(inner);
    let rt = inner.rt.handle().clone();
    let abort = turn_abort.clone();
    let tool_call_id = tool_call_id.to_owned();
    let tool_name = tool_name.to_owned();
    let arguments = arguments.clone();
    let session_override = session_override.map(str::to_owned);
    rt.spawn_blocking(move || {
        let Some(tool) = tool else {
            return rejected_outcome(format!("unknown tool {tool_name}"));
        };
        run_gated_call(
            &inner,
            &abort,
            &tool,
            &tool_call_id,
            &tool_name,
            &arguments,
            session_override.as_deref(),
        )
    })
}

/// Spawn one dispatched child on the async runtime. Children overlap in a
/// parallel pool; each owns its history, sink, and todo key, and registry
/// insertion commutes — the dsh opt-in invariant. `background: true` flips
/// the call to the detached flavor (stage 5): the registry registration and
/// the child-loop spawn happen inline (both quick and non-blocking) and the
/// ack rides back through an immediately-ready task, so the pooled call
/// path stays uniform.
fn spawn_dispatch_call(
    inner: &Arc<Inner>,
    engine: &EngineModel,
    tools: &Arc<Vec<ToolEntry>>,
    turn_abort: &AbortFlag,
    dispatch: &DispatchCtx,
    tool_call_id: &str,
    arguments: &serde_json::Value,
) -> tokio::task::JoinHandle<ToolOutcome> {
    let inner = Arc::clone(inner);
    let rt = inner.rt.handle().clone();
    let engine = engine.clone();
    let tools = Arc::clone(tools);
    let depth = dispatch.depth;
    let parent_agent = dispatch.parent_agent;
    let tool_call_id = tool_call_id.to_owned();
    let arguments = arguments.clone();
    let background = arguments
        .get("background")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if background {
        let ack = spawn_dispatch_background(
            &inner,
            &engine,
            &tools,
            &tool_call_id,
            &arguments,
            depth,
            parent_agent,
        );
        return rt.spawn(async move { ack });
    }
    let abort = turn_abort.clone();
    rt.spawn(async move {
        run_dispatch_foreground(
            &inner,
            &engine,
            &tools,
            &tool_call_id,
            &arguments,
            &abort,
            depth,
            parent_agent,
        )
        .await
    })
}

async fn join_tool_outcome(handle: tokio::task::JoinHandle<ToolOutcome>) -> ToolOutcome {
    match handle.await {
        Ok(outcome) => outcome,
        Err(error) => ToolOutcome::failed(format!("the tool task failed: {error}")),
    }
}

fn rejected_outcome(reason: String) -> ToolOutcome {
    ToolOutcome::rejected(reason)
}

fn spawn_turn(inner: &Arc<Inner>, message: StepMessage) {
    let handle = inner.rt.handle().clone();
    let inner = Arc::clone(inner);
    handle.spawn(async move {
        run_turn(&inner, message).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prompt_image_mentions_scans_bare_and_quoted_tokens() {
        let mentions = prompt_image_mentions("look at @shot.png and @\"/a b/c d.png\" closely");
        assert_eq!(mentions, vec!["shot.png", "/a b/c d.png"]);
        // Every bare @token is a candidate mention; filtering to images
        // happens at resolution time (prompt_message's extension check).
        assert_eq!(prompt_image_mentions("email @someone"), vec!["someone"]);
        // An unterminated quote ends the scan instead of running past the
        // prompt.
        assert!(prompt_image_mentions("trailing @\"unterminated").is_empty());
    }

    #[test]
    fn prompt_message_inlines_resolvable_image_mentions() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("shot.png"), b"png-bytes").unwrap();
        // A space-containing name rides the quoted-mention path.
        std::fs::write(workspace.path().join("with space.png"), b"png").unwrap();
        let cwd = workspace.path().to_path_buf();

        let message = prompt_message(&cwd, &[], "explain @shot.png and @\"with space.png\"");

        assert_eq!(message.role, HistoryRole::User);
        assert!(matches!(message.parts[0], HistoryPart::Text { .. }));
        assert_eq!(message.parts.len(), 3);
        let HistoryPart::Image {
            media_type,
            data_base64,
        } = &message.parts[1]
        else {
            panic!("first inline should be an image");
        };
        assert_eq!(media_type, "image/png");
        use base64::Engine as _;
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(data_base64)
                .unwrap(),
            b"png-bytes"
        );

        // An unresolvable mention stays plain text; the model keeps the path.
        let miss = prompt_message(&cwd, &[], "explain @ghost.png");
        assert_eq!(miss.parts.len(), 1);
    }

    #[test]
    fn prompt_message_rejects_outside_and_oversized_images() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.png"), b"x").unwrap();
        let oversized = workspace.path().join("huge.png");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_INLINE_IMAGE_BYTES + 1).unwrap();
        drop(file);
        let cwd = workspace.path().to_path_buf();

        let outside_prompt = format!("see @{}", outside.path().join("secret.png").display());
        assert_eq!(prompt_message(&cwd, &[], &outside_prompt).parts.len(), 1);
        assert_eq!(prompt_message(&cwd, &[], "see @huge.png").parts.len(), 1);
        // The daemon annex is a sanctioned absolute-mention root.
        let annex = tempfile::tempdir().unwrap();
        std::fs::write(annex.path().join("stored.png"), b"stored").unwrap();
        let annex_prompt = format!("see @{}", annex.path().join("stored.png").display());
        let message = prompt_message(&cwd, &[annex.path().to_path_buf()], &annex_prompt);
        assert_eq!(message.parts.len(), 2);
    }

    #[test]
    fn rebuild_history_reinlines_image_attachments() {
        let workspace = tempfile::tempdir().unwrap();
        let image_path = workspace.path().join("kept.png");
        std::fs::write(&image_path, b"png").unwrap();
        let attachment_for = |path: &std::path::Path| protocol::model::MessageAttachment {
            path: path.to_path_buf(),
            mention: path.display().to_string(),
            name: "kept.png".into(),
            is_dir: false,
            is_image: true,
            blob_reference: None,
        };
        let mut message = crate::model::Message::new(MessageRole::User, "explain this");
        message.attachments = vec![attachment_for(&image_path)];

        let history = rebuild_history(&rebuilt_session(vec![message]));
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].parts.len(), 2);
        assert!(matches!(history[0].parts[1], HistoryPart::Image { .. }));

        // A missing file degrades to text-only, never a failed replay.
        std::fs::remove_file(&image_path).unwrap();
        let mut message = crate::model::Message::new(MessageRole::User, "explain this");
        message.attachments = vec![attachment_for(&image_path)];
        let degraded = rebuild_history(&rebuilt_session(vec![message]));
        assert_eq!(degraded[0].parts.len(), 1);
    }

    #[test]
    fn build_mode_allows_every_tier() {
        for (name, args) in [
            ("read_file", json!({"path": "a.rs"})),
            ("write_file", json!({"path": "a.rs", "content": "x"})),
            ("bash", json!({"command": "rm -rf /"})),
            ("git", json!({"args": ["push"]})),
        ] {
            assert!(
                plan_allows(InteractionMode::Build, name, &args).is_ok(),
                "{name} should run in Build"
            );
        }
    }

    #[test]
    fn plan_mode_allows_reads_and_rejects_mutations() {
        for name in [
            "read_file",
            "grep",
            "glob",
            "web_search",
            "todo_write",
            "dispatch_agent",
            "ask_followup_question",
        ] {
            assert!(
                plan_allows(InteractionMode::Plan, name, &json!({})).is_ok(),
                "{name} is read-tier and should run in Plan"
            );
        }
        for (name, args) in [
            ("write_file", json!({"path": "a.rs", "content": "x"})),
            ("edit_file", json!({"path": "a.rs"})),
            ("bash", json!({"command": "ls"})),
            ("some_unknown_tool", json!({})),
        ] {
            let Err(reason) = plan_allows(InteractionMode::Plan, name, &args) else {
                panic!("{name} should be blocked in Plan");
            };
            assert!(reason.contains("Plan mode is read-only"), "{reason}");
        }
    }

    #[test]
    fn plan_mode_refines_git_per_subcommand() {
        for sub in ["status", "diff", "log"] {
            assert!(
                plan_allows(InteractionMode::Plan, "git", &json!({"args": [sub]})).is_ok(),
                "git {sub} is a read"
            );
        }
        for sub in ["add", "commit", "push"] {
            assert!(
                plan_allows(InteractionMode::Plan, "git", &json!({"args": [sub]})).is_err(),
                "git {sub} mutates"
            );
        }
    }

    #[test]
    fn map_call_ids_answers_provider_ids_in_order() {
        let step = HistoryMessage {
            role: HistoryRole::Assistant,
            parts: vec![
                HistoryPart::Text {
                    text: "checking".into(),
                },
                HistoryPart::ToolCall {
                    id: "toolu_provider_1".into(),
                    tool_name: "list_dir".into(),
                    arguments: json!({"path": "src"}),
                },
                HistoryPart::ToolCall {
                    id: "toolu_provider_2".into(),
                    tool_name: "read_file".into(),
                    arguments: json!({"path": "a.rs"}),
                },
            ],
        };
        let pending = vec![
            (
                "internal-a".to_owned(),
                "list_dir".to_owned(),
                json!({"path": "src"}),
            ),
            (
                "internal-b".to_owned(),
                "read_file".to_owned(),
                json!({"path": "a.rs"}),
            ),
        ];
        let map = map_call_ids(&step, &pending);
        assert_eq!(map["internal-a"], "toolu_provider_1");
        assert_eq!(map["internal-b"], "toolu_provider_2");
    }

    #[test]
    fn map_call_ids_queues_duplicate_pairs_and_keeps_unmatched_identity() {
        // Same (name, args) twice: provider ids assign in order.
        let step = HistoryMessage {
            role: HistoryRole::Assistant,
            parts: vec![
                HistoryPart::ToolCall {
                    id: "p_first".into(),
                    tool_name: "grep".into(),
                    arguments: json!({"pattern": "x"}),
                },
                HistoryPart::ToolCall {
                    id: "p_second".into(),
                    tool_name: "grep".into(),
                    arguments: json!({"pattern": "x"}),
                },
            ],
        };
        let pending = vec![
            ("i_2".to_owned(), "grep".to_owned(), json!({"pattern": "x"})),
            ("i_1".to_owned(), "grep".to_owned(), json!({"pattern": "x"})),
            ("i_3".to_owned(), "grep".to_owned(), json!({"pattern": "y"})),
        ];
        let map = map_call_ids(&step, &pending);
        assert_eq!(map["i_2"], "p_first");
        assert_eq!(map["i_1"], "p_second");
        // No provider counterpart (e.g. a repaired call the message lacks):
        // keep the streamed id rather than guessing.
        assert_eq!(map["i_3"], "i_3");
    }

    #[test]
    fn settle_aborted_step_midstream_keeps_partial_and_adds_no_results() {
        // Case A: the stream died before the assistant message landed. The
        // partial answer becomes the step's assistant message; nothing in
        // history carries tool-call parts, so no results are fabricated.
        let mut history = vec![HistoryMessage::user_text("find it")];
        let pending = vec![(
            "internal-a".to_owned(),
            "grep".to_owned(),
            json!({"pattern": "x"}),
        )];
        settle_aborted_step(&mut history, None, &pending, "half an ans");
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].role, HistoryRole::Assistant);
        match &history[1].parts[..] {
            [HistoryPart::Text { text }] => assert_eq!(text, "half an ans"),
            parts => panic!("expected one text part, got {parts:?}"),
        }
    }

    #[test]
    fn settle_aborted_step_after_step_end_pairs_canceled_results() {
        // Case B: the assistant message landed with tool-call parts, then
        // cancellation won the race. One user message of canceled results
        // answers the PROVIDER-issued ids, exactly like a completed step.
        let step = HistoryMessage {
            role: HistoryRole::Assistant,
            parts: vec![HistoryPart::ToolCall {
                id: "toolu_provider_1".into(),
                tool_name: "grep".into(),
                arguments: json!({"pattern": "x"}),
            }],
        };
        let mut history = vec![HistoryMessage::user_text("find it"), step.clone()];
        let pending = vec![(
            "internal-a".to_owned(),
            "grep".to_owned(),
            json!({"pattern": "x"}),
        )];
        settle_aborted_step(&mut history, Some(&step), &pending, "unused");
        assert_eq!(history.len(), 3);
        assert_eq!(history[2].role, HistoryRole::User);
        match &history[2].parts[..] {
            [
                HistoryPart::ToolResult {
                    call_id,
                    tool_name,
                    output,
                },
            ] => {
                assert_eq!(call_id, "toolu_provider_1");
                assert_eq!(tool_name, "grep");
                assert_eq!(output, ABORTED_CALL_OUTPUT);
            }
            parts => panic!("expected one tool result, got {parts:?}"),
        }
    }

    #[test]
    fn settle_aborted_step_empty_partial_and_no_step_leaves_history_alone() {
        let mut history = vec![HistoryMessage::user_text("go")];
        settle_aborted_step(&mut history, None, &[], "");
        assert_eq!(history.len(), 1);
    }

    #[test]
    fn settle_aborted_step_unmatched_pending_keeps_streamed_id() {
        // The step message has no counterpart for the pending call (e.g.
        // abort raced a repaired call): the result keeps the streamed id so
        // it still pairs with the part that will replay.
        let step = HistoryMessage {
            role: HistoryRole::Assistant,
            parts: vec![HistoryPart::ToolCall {
                id: "toolu_other".into(),
                tool_name: "glob".into(),
                arguments: json!({"pattern": "*.md"}),
            }],
        };
        let mut history = vec![step.clone()];
        let pending = vec![(
            "internal-x".to_owned(),
            "grep".to_owned(),
            json!({"pattern": "y"}),
        )];
        settle_aborted_step(&mut history, Some(&step), &pending, "");
        match &history[1].parts[..] {
            [HistoryPart::ToolResult { call_id, .. }] => assert_eq!(call_id, "internal-x"),
            parts => panic!("expected one tool result, got {parts:?}"),
        }
    }

    /// Pending calls with the given tool names, ids `c0..cN`.
    fn pending_named(names: &[&str]) -> Vec<(String, String, serde_json::Value)> {
        names
            .iter()
            .enumerate()
            .map(|(index, name)| (format!("c{index}"), (*name).to_owned(), json!({})))
            .collect()
    }

    #[test]
    fn plan_tool_groups_barriers_exclusive_calls_and_pools_parallel_runs() {
        let calls = pending_named(&[
            "read_file",
            "grep",
            "bash",
            "glob",
            "read_file",
            "web_search",
        ]);
        let runs = plan_tool_groups(&calls);
        // [read_file, grep] pool | bash barrier | [glob, read_file, web_search] pool
        assert!(
            matches!(
                &runs[..],
                [ToolRun::Parallel(a), ToolRun::Exclusive(b), ToolRun::Parallel(c)]
                    if a == &vec![0, 1] && *b == 2 && c == &vec![3, 4, 5]
            ),
            "unexpected runs: {runs:?}"
        );
    }

    #[test]
    fn plan_tool_groups_leading_and_trailing_exclusive_calls() {
        let calls = pending_named(&["bash", "grep", "git"]);
        let runs = plan_tool_groups(&calls);
        assert!(
            matches!(
                &runs[..],
                [ToolRun::Exclusive(0), ToolRun::Parallel(p), ToolRun::Exclusive(2)]
                    if p == &vec![1]
            ),
            "unexpected runs: {runs:?}"
        );
    }

    #[test]
    fn plan_tool_groups_all_parallel_and_all_exclusive() {
        let runs = plan_tool_groups(&pending_named(&["glob", "grep"]));
        assert!(matches!(&runs[..], [ToolRun::Parallel(p)] if p == &vec![0, 1]));
        let runs = plan_tool_groups(&pending_named(&["bash", "git"]));
        assert!(
            matches!(&runs[..], [ToolRun::Exclusive(0), ToolRun::Exclusive(1)]),
            "unexpected runs: {runs:?}"
        );
    }

    #[test]
    fn contextualized_prompt_appends_environment_after_the_static_base() {
        let prompt = contextualize_system_prompt(
            "STATIC BASE",
            Path::new("/tmp/repo"),
            "glm-4.7",
            InteractionMode::Build,
        );
        // The static base stays a strict prefix — the cacheable part of the
        // prompt never shifts mid-session.
        assert!(prompt.starts_with("STATIC BASE"));
        assert!(prompt.contains("# Environment"));
        assert!(prompt.contains("- Working directory: /tmp/repo"));
        assert!(prompt.contains("- Model: glm-4.7"));
        // ISO date line is present (its value moves with the clock).
        assert!(prompt.contains("- Date: 20"));
        // Build is the unstated default: no mode section.
        assert!(!prompt.contains("Plan mode is active"));
    }

    #[test]
    fn plan_mode_notice_matches_the_gate_language() {
        let prompt =
            contextualize_system_prompt("BASE", Path::new("/tmp"), "m", InteractionMode::Plan);
        assert!(prompt.contains("Plan mode is active"));
        assert!(prompt.contains("read-only"));
        // The same escalation path the gate's rejection names.
        assert!(prompt.contains("Build"));
    }

    #[test]
    fn subagent_prompts_carry_the_same_environment_tail() {
        // Children share the workspace and the mode gate, so the same
        // contextualization applies to an agent's own base prompt.
        let prompt = contextualize_system_prompt(
            "You are the scout agent.",
            Path::new("/repo"),
            "glm-4.7",
            InteractionMode::Plan,
        );
        assert!(prompt.starts_with("You are the scout agent."));
        assert!(prompt.contains("# Environment"));
        assert!(prompt.contains("Plan mode is active"));
    }

    #[test]
    fn fork_seed_drops_the_current_turn_and_its_steers() {
        // A fork-parented child sees everything BEFORE the current turn.
        // The dispatch runs mid-turn, so the tail is the assistant message
        // requesting it; the turn opened at the prompt after the previous
        // final answer, and a steer between steps belongs to the same turn.
        let history = vec![
            HistoryMessage::user_text("first question"),
            HistoryMessage {
                role: HistoryRole::Assistant,
                parts: vec![HistoryPart::Text {
                    text: "first answer".into(),
                }],
            },
            HistoryMessage::user_text("second question"),
            HistoryMessage {
                role: HistoryRole::Assistant,
                parts: vec![HistoryPart::ToolCall {
                    id: "t1".into(),
                    tool_name: "grep".into(),
                    arguments: json!({"pattern": "x"}),
                }],
            },
            HistoryMessage {
                role: HistoryRole::User,
                parts: vec![HistoryPart::ToolResult {
                    call_id: "t1".into(),
                    tool_name: "grep".into(),
                    output: "hit".into(),
                }],
            },
            HistoryMessage {
                role: HistoryRole::Assistant,
                parts: vec![HistoryPart::Text {
                    text: "second answer".into(),
                }],
            },
            HistoryMessage::user_text("current turn's prompt"),
            HistoryMessage {
                role: HistoryRole::Assistant,
                parts: vec![HistoryPart::ToolCall {
                    id: "t2".into(),
                    tool_name: "dispatch_agent".into(),
                    arguments: json!({"name": "explore"}),
                }],
            },
        ];
        let seed = fork_seed_history(&history);
        // Everything through "second answer"; the current turn (its prompt
        // and the dispatch request) is gone.
        assert_eq!(seed.len(), 6);
        assert!(!format!("{seed:?}").contains("current turn"));
        assert!(!format!("{seed:?}").contains("dispatch_agent"));
    }

    #[test]
    fn fork_seed_treats_steers_as_part_of_the_open_turn() {
        // A steer lands between steps: the preceding assistant carried tool
        // calls, so the steer is mid-turn input and drops with the turn.
        let history = vec![
            HistoryMessage::user_text("question"),
            HistoryMessage {
                role: HistoryRole::Assistant,
                parts: vec![HistoryPart::Text {
                    text: "answer".into(),
                }],
            },
            HistoryMessage::user_text("current turn's prompt"),
            HistoryMessage {
                role: HistoryRole::Assistant,
                parts: vec![HistoryPart::ToolCall {
                    id: "t1".into(),
                    tool_name: "grep".into(),
                    arguments: json!({}),
                }],
            },
            HistoryMessage::user_text("a steer that landed mid-turn"),
        ];
        let seed = fork_seed_history(&history);
        assert_eq!(seed.len(), 2);
        assert!(!format!("{seed:?}").contains("current turn"));
        assert!(!format!("{seed:?}").contains("steer"));
    }

    #[test]
    fn fork_seed_without_a_user_turn_returns_everything() {
        let history = vec![HistoryMessage {
            role: HistoryRole::Assistant,
            parts: vec![HistoryPart::Text {
                text: "orphan answer".into(),
            }],
        }];
        assert_eq!(fork_seed_history(&history).len(), 1);
        assert!(fork_seed_history(&[]).is_empty());
    }

    #[test]
    fn children_registry_lists_in_order_and_evicts_oldest_stopped() {
        let key = |id: &str| BackgroundWorkKey {
            kind: BackgroundWorkKind::Subagent,
            provider_id: id.to_owned(),
        };
        let mut children = Children::default();
        for id in 0..MAX_CHILDREN {
            let id = format!("child-{id}");
            children.insert(
                id.clone(),
                Arc::new(ChildState::new("explore".into(), id.clone(), key(&id))),
            );
        }
        // The newest entry stays running — eviction must skip it.
        let running = children.get("child-7").unwrap();
        *running.status.lock().unwrap() = BackgroundWorkStatus::Running;
        children.insert(
            "child-8".to_owned(),
            Arc::new(ChildState::new(
                "explore".into(),
                "child-8".to_owned(),
                key("child-8"),
            )),
        );
        // Oldest stopped child evicted; the running one and the rest stay.
        assert!(children.get("child-0").is_none());
        assert!(children.get("child-7").is_some());
        assert!(children.get("child-8").is_some());
        // Snapshot preserves dispatch order.
        let order: Vec<String> = children.snapshot().into_iter().map(|(id, _)| id).collect();
        assert_eq!(
            order,
            (1..=8).map(|i| format!("child-{i}")).collect::<Vec<_>>()
        );
    }

    fn tool_result_message(call_id: &str, output: &str) -> HistoryMessage {
        HistoryMessage {
            role: HistoryRole::User,
            parts: vec![HistoryPart::ToolResult {
                call_id: call_id.to_owned(),
                tool_name: "grep".to_owned(),
                output: output.to_owned(),
            }],
        }
    }

    #[test]
    fn prune_only_stale_bulky_results_and_keep_pairing() {
        let bulky = "x".repeat(5000);
        let mut history = vec![
            tool_result_message("t1", &bulky), // before the keep window → pruned
            HistoryMessage {
                role: HistoryRole::Assistant,
                parts: vec![HistoryPart::Text { text: "mid".into() }],
            },
            HistoryMessage::user_text("turn 1"), // keep-turn boundary (oldest kept)
            tool_result_message("t2", &bulky),   // inside keep window → kept
            HistoryMessage::user_text("turn 2"),
            tool_result_message("t3", &bulky), // inside keep window → kept
            HistoryMessage::user_text("turn 3"),
        ];
        let removed = prune_tool_results(&mut history, 3, 2048);
        assert!(removed > 0);
        // Old bulky result got the stub; recent ones untouched.
        let stub = match &history[0].parts[0] {
            HistoryPart::ToolResult { output, .. } => output.clone(),
            other => panic!("unexpected part {other:?}"),
        };
        assert!(stub.contains("[pruned"));
        assert!(stub.starts_with('x') && stub.ends_with('x'));
        match &history[3].parts[0] {
            HistoryPart::ToolResult { output, .. } => assert_eq!(output.len(), bulky.len()),
            other => panic!("unexpected part {other:?}"),
        }
        // Pairing intact: same part counts everywhere.
        assert_eq!(history[0].parts.len(), 1);
    }

    #[test]
    fn prune_skips_short_conversations() {
        let mut history = vec![
            tool_result_message("t1", &"y".repeat(5000)),
            HistoryMessage::user_text("only turn"),
        ];
        assert_eq!(prune_tool_results(&mut history, 6, 2048), 0);
        assert_eq!(history[0].parts.len(), 1);
    }

    #[test]
    fn compaction_cut_lands_on_an_assistant_within_budget() {
        let big = |text: &str| HistoryMessage {
            role: HistoryRole::Assistant,
            parts: vec![HistoryPart::Text {
                text: text.to_owned(),
            }],
        };
        let history = vec![
            HistoryMessage::user_text(&"a".repeat(400)),
            big(&"b".repeat(400)),
            HistoryMessage::user_text(&"c".repeat(400)),
            big(&"d".repeat(400)),
        ];
        // Budget fits only the tail: the cut must be an assistant index.
        let cut = compaction_cut(&history, 700).expect("a cut exists");
        assert_eq!(history[cut].role, HistoryRole::Assistant);
        assert_eq!(cut, 3);
        // Everything fitting means nothing to shadow.
        assert_eq!(compaction_cut(&history, 10_000), None);
        // No assistant → no safe cut.
        let user_only = vec![HistoryMessage::user_text(&"u".repeat(4000))];
        assert_eq!(compaction_cut(&user_only, 100), None);
    }

    #[test]
    fn pressure_threshold_decides_turn_start_compaction() {
        assert!(should_compact(85, Some(100)));
        assert!(should_compact(90, Some(100)));
        assert!(!should_compact(84, Some(100)));
        assert!(!should_compact(100_000, None));
        assert!(!should_compact(0, Some(0)));
    }

    #[test]
    fn summary_render_caps_bulky_results() {
        let history = vec![
            tool_result_message("t1", &"z".repeat(2_000)),
            HistoryMessage {
                role: HistoryRole::Assistant,
                parts: vec![HistoryPart::Text {
                    text: "done".into(),
                }],
            },
        ];
        let rendered = render_range_for_summary(&history);
        assert!(rendered.contains("result of grep: zzz"));
        assert!(rendered.len() < 1_000);
        assert!(rendered.contains("assistant: done"));
    }

    #[test]
    fn wrap_up_triggers_only_on_unclean_exits() {
        // Budget exhaustion / degenerate stop → one forced final answer.
        assert!(needs_wrap_up(false, false, true));
        // Clean EndTurn, cancellation, and errored turns keep their
        // existing settlement instead.
        assert!(!needs_wrap_up(true, false, true));
        assert!(!needs_wrap_up(false, true, true));
        assert!(!needs_wrap_up(false, false, false));
        assert!(wrap_up_prompt().contains("final answer"));
    }

    #[test]
    fn dispatch_groups_put_dispatches_in_the_parallel_pool() {
        let calls = pending_named(&["dispatch_agent", "read_file", "dispatch_agent"]);
        let runs = plan_tool_groups(&calls);
        assert!(
            matches!(&runs[..], [ToolRun::Parallel(p)] if p == &vec![0, 1, 2]),
            "dispatches join the parallel pool: {runs:?}"
        );
    }

    #[test]
    fn followup_question_builds_from_args() {
        let question = followup_question(&json!({
            "question": "Which DB?",
            "options": [
                { "label": "SQLite", "description": "local" },
                { "label": "Postgres" }
            ],
            "multiple": true
        }))
        .expect("a well-formed ask builds a question");
        assert_eq!(question.question, "Which DB?");
        assert!(question.multi_select);
        assert_eq!(question.options.len(), 2);
        assert_eq!(question.options[0].label, "SQLite");
        assert_eq!(question.options[0].description.as_deref(), Some("local"));

        // Plain-string options wrap into labels (the forgiving coercion).
        let wrapped = followup_question(&json!({"question": "Q", "options": ["A", "B"]}))
            .expect("plain options still build");
        assert_eq!(wrapped.options[1].label, "B");
        assert!(!wrapped.multi_select);

        // No question text, no question.
        assert!(followup_question(&json!({"options": []})).is_none());
        assert!(followup_question(&json!({})).is_none());
    }

    #[test]
    fn followup_answer_text_joins_and_drops_empty() {
        let answers = vec![
            UserInputAnswer {
                question_id: "a".into(),
                answers: vec!["SQLite".into()],
            },
            UserInputAnswer {
                question_id: "b".into(),
                answers: vec!["  ".into(), "Later".into()],
            },
        ];
        assert_eq!(
            followup_answer_text(&answers).as_deref(),
            Some("SQLite, Later")
        );
        assert_eq!(followup_answer_text(&[]), None);
        assert_eq!(
            followup_answer_text(&[UserInputAnswer {
                question_id: "a".into(),
                answers: Vec::new(),
            }]),
            None,
            "an all-blank submission reads as dismissed"
        );
    }

    #[test]
    fn followup_tool_ships_in_the_toolset() {
        assert!(
            !ORCHESTRATOR_OWNED_TOOLS.contains(&"ask_followup_question"),
            "the driver owns the ask flow itself, not the filter"
        );
        let names: Vec<String> = toolset().into_iter().map(|entry| entry.spec.name).collect();
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        assert!(names.contains(&"ask_followup_question"));
        assert!(!names.contains(&"exit_plan_mode"));
        assert!(!names.contains(&"compact"));
    }

    #[test]
    fn display_output_prefers_the_text_display() {
        let mut outcome = ToolOutcome::executed("Todo list updated (1/2 done).");
        assert_eq!(display_output(&outcome), "Todo list updated (1/2 done).");

        outcome.display = Some(tools::ToolDisplay::Text {
            text: "[x] 1. a\n[ ] 2. b".into(),
        });
        assert_eq!(display_output(&outcome), "[x] 1. a\n[ ] 2. b");

        // Non-text displays (diffs) are not body text; the summary stands.
        outcome.display = Some(tools::ToolDisplay::Diff {
            path: "p".into(),
            hunks: Vec::new(),
            additions: 0,
            deletions: 0,
        });
        assert_eq!(display_output(&outcome), "Todo list updated (1/2 done).");

        // A blank text display never wins over a real summary.
        outcome.display = Some(tools::ToolDisplay::Text { text: "  ".into() });
        assert_eq!(display_output(&outcome), "Todo list updated (1/2 done).");
    }

    #[test]
    fn subagent_tool_targets_parse_from_arguments() {
        assert_eq!(
            subagent_tool_target(&json!({"command": "cargo test -p backend"})).as_deref(),
            Some("cargo test -p backend")
        );
        // Only the first line of a command shows.
        assert_eq!(
            subagent_tool_target(&json!({"command": "cargo test\nthen report"})).as_deref(),
            Some("cargo test")
        );
        assert_eq!(
            subagent_tool_target(&json!({"path": "src/app/mod.rs"})).as_deref(),
            Some("src/app/mod.rs")
        );
        // dispatch_agent's identifying argument is the task.
        assert_eq!(
            subagent_tool_target(&json!({"task": "map the sinks"})).as_deref(),
            Some("map the sinks")
        );
        // No recognizable target: none.
        assert_eq!(subagent_tool_target(&json!({})), None);
        assert_eq!(
            subagent_tool_target(&json!({"pattern": "", "command": "  "})),
            None
        );
    }

    #[test]
    fn subagent_tool_targets_compact_instead_of_wrapping() {
        // A long path keeps its identifying tail.
        let deep = format!(
            "/very/long/workspace/root/packages/{}/src/lib/deep/mod.rs",
            "x".repeat(40)
        );
        let target = subagent_tool_target(&json!({ "path": deep })).expect("a target");
        assert!(target.starts_with('…'));
        assert!(target.ends_with("src/lib/deep/mod.rs"));
        assert!(target.chars().count() <= SUBAGENT_TOOL_PATH_CHARS + 1);

        // A long command keeps its head.
        let verbose = format!("run {} --flags", "word ".repeat(30));
        let target = subagent_tool_target(&json!({ "command": verbose })).expect("a target");
        assert!(target.starts_with("run word"));
        assert!(target.ends_with('…'));
        assert!(target.chars().count() <= SUBAGENT_TOOL_TARGET_CHARS + 1);
    }

    #[test]
    fn reasoning_deltas_upsert_the_open_tail_block() {
        let mut blocks = Vec::new();
        subagent_reasoning_delta(&mut blocks, "where ");
        subagent_reasoning_delta(&mut blocks, "is the seam?");
        assert_eq!(
            blocks,
            vec![SubagentBlock::Reasoning {
                text: "where is the seam?".into(),
                streaming: true,
            }]
        );

        // A tool call closes the thought; the next reasoning run is a fresh
        // block after it.
        subagent_tool_start(&mut blocks, "t1", "bash", &json!({"command": "ls"}));
        assert_eq!(
            blocks[0],
            SubagentBlock::Reasoning {
                text: "where is the seam?".into(),
                streaming: false,
            }
        );
        subagent_reasoning_delta(&mut blocks, "round two");
        assert_eq!(blocks.len(), 3);
        assert_eq!(
            blocks[2],
            SubagentBlock::Reasoning {
                text: "round two".into(),
                streaming: true,
            }
        );
    }

    #[test]
    fn text_deltas_upsert_and_close_like_reasoning() {
        let mut blocks = Vec::new();
        subagent_reasoning_delta(&mut blocks, "thinking");
        subagent_text_delta(&mut blocks, "found ");
        subagent_text_delta(&mut blocks, "it");
        // The narration opened a new block and closed the thought behind it.
        assert_eq!(
            blocks,
            vec![
                SubagentBlock::Reasoning {
                    text: "thinking".into(),
                    streaming: false,
                },
                SubagentBlock::Text {
                    content: "found it".into(),
                    streaming: true,
                },
            ]
        );
        // A settled tail does not reopen: finalize then append opens a new
        // block rather than gluing onto the closed one.
        subagent_blocks_finalize(&mut blocks);
        subagent_text_delta(&mut blocks, "more");
        assert_eq!(blocks.len(), 3);
        assert_eq!(
            blocks[2],
            SubagentBlock::Text {
                content: "more".into(),
                streaming: true,
            }
        );
    }

    #[test]
    fn tool_blocks_settle_by_call_id_with_duration() {
        let mut blocks = Vec::new();
        subagent_tool_start(&mut blocks, "t1", "bash", &json!({"command": "cargo test"}));
        subagent_tool_start(
            &mut blocks,
            "t2",
            "edit_file",
            &json!({"path": "src/lib.rs"}),
        );
        assert_eq!(
            blocks,
            vec![
                SubagentBlock::Tool {
                    id: "t1".into(),
                    name: "bash".into(),
                    target: Some("cargo test".into()),
                    status: SubagentToolStatus::Running,
                    duration_ms: None,
                },
                SubagentBlock::Tool {
                    id: "t2".into(),
                    name: "edit_file".into(),
                    target: Some("src/lib.rs".into()),
                    status: SubagentToolStatus::Running,
                    duration_ms: None,
                },
            ]
        );

        subagent_tool_finish(&mut blocks, "t1", true, 950);
        subagent_tool_finish(&mut blocks, "t2", false, 2_000);
        assert_eq!(
            blocks[0],
            SubagentBlock::Tool {
                id: "t1".into(),
                name: "bash".into(),
                target: Some("cargo test".into()),
                status: SubagentToolStatus::Done,
                duration_ms: Some(950),
            }
        );
        assert_eq!(
            blocks[1],
            SubagentBlock::Tool {
                id: "t2".into(),
                name: "edit_file".into(),
                target: Some("src/lib.rs".into()),
                status: SubagentToolStatus::Failed,
                duration_ms: Some(2_000),
            }
        );

        // An unknown id settles nothing.
        let before = blocks.clone();
        subagent_tool_finish(&mut blocks, "ghost", true, 1);
        assert_eq!(blocks, before);
    }

    #[test]
    fn finalize_closes_every_streaming_flag() {
        let mut blocks = vec![
            SubagentBlock::Reasoning {
                text: "one".into(),
                streaming: true,
            },
            SubagentBlock::Tool {
                id: "t".into(),
                name: "bash".into(),
                target: None,
                status: SubagentToolStatus::Running,
                duration_ms: None,
            },
            SubagentBlock::Text {
                content: "two".into(),
                streaming: true,
            },
        ];
        subagent_blocks_finalize(&mut blocks);
        assert!(matches!(
            &blocks[0],
            SubagentBlock::Reasoning {
                streaming: false,
                ..
            }
        ));
        assert!(matches!(
            &blocks[2],
            SubagentBlock::Text {
                streaming: false,
                ..
            }
        ));
    }

    #[test]
    fn consecutive_messages_split_at_step_end_and_tool_calls() {
        // Two assistant messages around a tool call: two Text blocks — the
        // first stays as narration, the last becomes the report.
        let mut blocks = Vec::new();
        subagent_text_delta(&mut blocks, "I'll check the sinks.");
        subagent_blocks_close(&mut blocks); // StepEnd: message one completed
        subagent_tool_start(
            &mut blocks,
            "t1",
            "bash",
            &json!({"command": "grep -rn Sink src/"}),
        );
        subagent_tool_finish(&mut blocks, "t1", true, 9);
        subagent_text_delta(&mut blocks, "Here's what I found.");
        subagent_blocks_close(&mut blocks); // StepEnd: message two completed
        assert_eq!(
            blocks,
            vec![
                SubagentBlock::Text {
                    content: "I'll check the sinks.".into(),
                    streaming: false,
                },
                SubagentBlock::Tool {
                    id: "t1".into(),
                    name: "bash".into(),
                    target: Some("grep -rn Sink src/".into()),
                    status: SubagentToolStatus::Done,
                    duration_ms: Some(9),
                },
                SubagentBlock::Text {
                    content: "Here's what I found.".into(),
                    streaming: false,
                },
            ]
        );
    }

    #[test]
    fn step_end_then_more_deltas_open_a_new_text_block() {
        // No tool between the messages: the closed block still reads as a
        // finished message, so the next delta starts a fresh one instead of
        // gluing onto it.
        let mut blocks = Vec::new();
        subagent_text_delta(&mut blocks, "message one");
        subagent_blocks_close(&mut blocks); // StepEnd
        subagent_text_delta(&mut blocks, "message two");
        assert_eq!(
            blocks,
            vec![
                SubagentBlock::Text {
                    content: "message one".into(),
                    streaming: false,
                },
                SubagentBlock::Text {
                    content: "message two".into(),
                    streaming: true,
                },
            ]
        );
    }

    fn child_outcome(aborted: bool, error: Option<&str>) -> LoopOutcome {
        LoopOutcome {
            text: String::new(),
            usage: None,
            aborted,
            error: error.map(str::to_owned),
        }
    }

    #[test]
    fn settle_pops_the_final_message_into_the_report() {
        let mut blocks = vec![
            SubagentBlock::Text {
                content: "I'll map the sinks.".into(),
                streaming: false,
            },
            SubagentBlock::Tool {
                id: "t1".into(),
                name: "bash".into(),
                target: None,
                status: SubagentToolStatus::Done,
                duration_ms: Some(4),
            },
            SubagentBlock::Text {
                content: "  The sinks live in tide.rs.  ".into(),
                streaming: true, // still open when the run ended — settle closes it
            },
        ];
        let report = settle_subagent_timeline(&mut blocks, &child_outcome(false, None));
        // The block's own content (trimmed) is the report — it cannot diverge
        // from what the timeline streamed.
        assert_eq!(report, "The sinks live in tide.rs.");
        // The shipped snapshot lacks the final message; the narration and
        // tool trail stay.
        assert_eq!(
            blocks,
            vec![
                SubagentBlock::Text {
                    content: "I'll map the sinks.".into(),
                    streaming: false,
                },
                SubagentBlock::Tool {
                    id: "t1".into(),
                    name: "bash".into(),
                    target: None,
                    status: SubagentToolStatus::Done,
                    duration_ms: Some(4),
                },
            ]
        );
    }

    #[test]
    fn single_message_child_pops_its_only_block() {
        // A child that answers in one message carries no narration: the pop
        // empties the timeline and the report renders as the Result card
        // (the app keeps the timeline surface alive via the task bubble).
        let mut blocks = vec![SubagentBlock::Text {
            content: "the answer".into(),
            streaming: false,
        }];
        let report = settle_subagent_timeline(&mut blocks, &child_outcome(false, None));
        assert_eq!(report, "the answer");
        assert!(blocks.is_empty());
    }

    #[test]
    fn abandoned_run_keeps_blocks_and_reports_the_note() {
        let mut blocks = vec![
            SubagentBlock::Text {
                content: "I'll check X now…".into(),
                streaming: false,
            },
            SubagentBlock::Text {
                content: "The ans".into(), // mid-message when the parent aborted
                streaming: true,
            },
        ];
        let report = settle_subagent_timeline(&mut blocks, &child_outcome(true, None));
        assert_eq!(report, "(abandoned)");
        assert_eq!(blocks.len(), 2, "an abandoned child's trail stands");
        assert!(matches!(
            &blocks[1],
            SubagentBlock::Text {
                streaming: false,
                ..
            }
        ));
    }

    #[test]
    fn runs_without_a_final_message_report_the_note() {
        // Errored mid-message: the trail stays, the note reports it.
        let mut blocks = vec![SubagentBlock::Text {
            content: "partial".into(),
            streaming: true,
        }];
        assert_eq!(
            settle_subagent_timeline(
                &mut blocks,
                &child_outcome(false, Some("tide stream: boom"))
            ),
            "(no output)"
        );
        assert_eq!(blocks.len(), 1);

        // Completed, but the final message is blank: the intermediate
        // narration stays as blocks and the note stands in for the report.
        let mut blocks = vec![
            SubagentBlock::Text {
                content: "I'll check X.".into(),
                streaming: false,
            },
            SubagentBlock::Tool {
                id: "t".into(),
                name: "bash".into(),
                target: None,
                status: SubagentToolStatus::Done,
                duration_ms: Some(1),
            },
            SubagentBlock::Text {
                content: "   ".into(),
                streaming: false,
            },
        ];
        assert_eq!(
            settle_subagent_timeline(&mut blocks, &child_outcome(false, None)),
            "(no output)"
        );
        assert_eq!(blocks.len(), 3, "nothing pops on a blank final message");
    }

    // ── No two adjacent user messages ──────────────────────────────────────
    //
    // z.ai's Anthropic-compat endpoint mishandles consecutive user-role
    // messages: the context after them is dropped, so the model answers as
    // if the later tool results never existed (the "you said the workspace
    // is empty" failure). Every user message must arrive after an assistant
    // one — these tests hold that wire shape across every path that pushes.

    fn assistant_text(text: &str) -> HistoryMessage {
        HistoryMessage {
            role: HistoryRole::Assistant,
            parts: vec![HistoryPart::Text {
                text: text.to_owned(),
            }],
        }
    }

    fn tool_results_message() -> HistoryMessage {
        HistoryMessage {
            role: HistoryRole::User,
            parts: vec![HistoryPart::ToolResult {
                call_id: "t1".into(),
                tool_name: "bash".into(),
                output: "done".into(),
            }],
        }
    }

    fn no_adjacent_user_messages(history: &[HistoryMessage]) -> bool {
        history
            .windows(2)
            .all(|pair| !(pair[0].role == HistoryRole::User && pair[1].role == HistoryRole::User))
    }

    fn rebuilt_session(messages: Vec<crate::model::Message>) -> AgentSession {
        let mut session = AgentSession::new(Uuid::new_v4(), crate::model::ProviderKind::Tide);
        session.messages = messages;
        session
    }

    #[test]
    fn aborted_turn_with_no_assistant_output_gets_the_placeholder() {
        // The reported bug's shape: turn 1 interrupted before any assistant
        // message, so the tail is the user's own prompt.
        let mut history = vec![HistoryMessage::user_text("deep dive analysis")];
        assert!(ensure_assistant_tail(&mut history));
        assert_eq!(history.len(), 2);
        let tail = history.last().expect("the placeholder landed");
        assert_eq!(tail.role, HistoryRole::Assistant);
        assert_eq!(
            tail.parts,
            vec![HistoryPart::Text {
                text: STOPPED_MARKER.into()
            }]
        );
    }

    #[test]
    fn aborted_turn_after_assistant_output_appends_nothing() {
        // Partial assistant text committed by a StepEnd already closes the
        // exchange — the placeholder would only add noise.
        let mut history = vec![
            HistoryMessage::user_text("hi"),
            assistant_text("partial answer"),
        ];
        assert!(!ensure_assistant_tail(&mut history));
        assert_eq!(history.len(), 2, "the assistant tail stands as-is");
    }

    #[test]
    fn aborted_turn_after_tool_results_gets_the_placeholder() {
        // An abort can also land after results batched into a user message
        // but before the model answered them.
        let mut history = vec![
            HistoryMessage::user_text("run the tests"),
            HistoryMessage {
                role: HistoryRole::Assistant,
                parts: vec![HistoryPart::ToolCall {
                    id: "t1".into(),
                    tool_name: "bash".into(),
                    arguments: json!({"command": "ls"}),
                }],
            },
            tool_results_message(),
        ];
        assert!(ensure_assistant_tail(&mut history));
        assert_eq!(history.len(), 4);
        assert_eq!(history[2].role, HistoryRole::User);
        assert_eq!(history[3].role, HistoryRole::Assistant);
    }

    #[test]
    fn empty_history_needs_no_placeholder() {
        let mut history: Vec<HistoryMessage> = Vec::new();
        assert!(!ensure_assistant_tail(&mut history));
        assert!(history.is_empty());
    }

    #[test]
    fn rebuild_history_heals_adjacent_user_messages() {
        // A session persisted by an older build: turn 1 was interrupted
        // before any assistant output AND the in-memory placeholder never
        // streamed, so it is not among the stored messages either — the
        // restart replays "deep dive analysis" and "continue" back-to-back.
        let session = rebuilt_session(vec![
            crate::model::Message::new(MessageRole::User, "deep dive analysis"),
            crate::model::Message::new(MessageRole::User, "continue"),
        ]);
        let history = rebuild_history(&session);
        let roles: Vec<HistoryRole> = history.iter().map(|message| message.role).collect();
        assert_eq!(
            roles,
            vec![HistoryRole::User, HistoryRole::Assistant, HistoryRole::User]
        );
        assert_eq!(
            history[1].parts,
            vec![HistoryPart::Text {
                text: STOPPED_MARKER.into()
            }]
        );
    }

    #[test]
    fn rebuild_history_heals_every_gap_not_just_the_first() {
        let session = rebuilt_session(vec![
            crate::model::Message::new(MessageRole::User, "a"),
            crate::model::Message::new(MessageRole::User, "b"),
            crate::model::Message::new(MessageRole::Assistant, "reply"),
            crate::model::Message::new(MessageRole::User, "c"),
            crate::model::Message::new(MessageRole::User, "d"),
        ]);
        let history = rebuild_history(&session);
        let roles: Vec<HistoryRole> = history.iter().map(|message| message.role).collect();
        assert_eq!(
            roles,
            vec![
                HistoryRole::User,
                HistoryRole::Assistant,
                HistoryRole::User,
                HistoryRole::Assistant,
                HistoryRole::User,
                HistoryRole::Assistant,
                HistoryRole::User,
            ]
        );
    }

    #[test]
    fn rebuild_history_leaves_well_formed_sessions_untouched() {
        let session = rebuilt_session(vec![
            crate::model::Message::new(MessageRole::User, "one"),
            crate::model::Message::new(MessageRole::Assistant, "answer one"),
            crate::model::Message::new(MessageRole::User, "two"),
        ]);
        let history = rebuild_history(&session);
        assert_eq!(history.len(), 3, "nothing is inserted");
        assert!(!history.iter().any(|message| {
            message.parts.iter().any(|part| match part {
                HistoryPart::Text { text } => text == STOPPED_MARKER,
                _ => false,
            })
        }));
    }

    #[test]
    fn history_never_holds_two_adjacent_user_messages() {
        // The wire-shape invariant, walked through every scenario that
        // pushes into history via the driver's entry points — including
        // worst-case runs of user pushes with no assistant output between
        // them. After each step, no two User-role messages may be adjacent.
        let history = Mutex::new(Vec::new());

        // Turn 1: the prompt lands, the model answers with a tool call,
        // and the results batch into one user message.
        push_user_message(&history, HistoryMessage::user_text("deep dive analysis"));
        assert!(no_adjacent_user_messages(&history.lock().unwrap()));
        history.lock().unwrap().push(assistant_text("checking"));
        history.lock().unwrap().push(tool_results_message());
        assert!(no_adjacent_user_messages(&history.lock().unwrap()));

        // The turn aborts before the model answers the results: the
        // exchange closes with the placeholder.
        ensure_assistant_tail(&mut history.lock().unwrap());
        assert!(no_adjacent_user_messages(&history.lock().unwrap()));

        // Turn 2 — the "continue" after the interruption.
        push_user_message(&history, HistoryMessage::user_text("continue"));
        assert!(no_adjacent_user_messages(&history.lock().unwrap()));

        // Steering: a message landing between steps after tool results,
        // then a second one drained in the same batch.
        push_user_message(&history, HistoryMessage::user_text("also check the tests"));
        assert!(no_adjacent_user_messages(&history.lock().unwrap()));
        push_user_message(&history, HistoryMessage::user_text("and the docs"));
        assert!(no_adjacent_user_messages(&history.lock().unwrap()));

        // A turn that produced nothing (early engine failure) followed by
        // a queued prompt drained back-to-back.
        push_user_message(&history, HistoryMessage::user_text("queued while broken"));
        assert!(no_adjacent_user_messages(&history.lock().unwrap()));
        push_user_message(&history, HistoryMessage::user_text("the queued follow-up"));
        assert!(no_adjacent_user_messages(&history.lock().unwrap()));

        // The placeholder tails are real assistant messages, and the walk
        // never once broke the no-adjacent-users shape.
        let history = history.lock().unwrap();
        assert!(history.last().is_some_and(|m| m.role == HistoryRole::User));
        assert!(no_adjacent_user_messages(&history));
        assert!(
            history
                .iter()
                .filter(|m| m.role == HistoryRole::Assistant)
                .any(|m| m.parts
                    == vec![HistoryPart::Text {
                        text: STOPPED_MARKER.into()
                    }])
        );
    }
}

/// Stages 3-4 fixture tests — the `fixture_tests.rs` / mock-SSE pattern
/// pointed at the real driver: a local SSE server serves canned Anthropic
/// streams, a hermetic `TIDE_DATA_DIR` config resolves the engine against
/// it, and the background-job assertions read the actual `DriverEvent`
/// stream and the captured request bodies. No network leaves 127.0.0.1 and
/// no keychain is touched (the fixture key rides the plaintext passthrough).
#[cfg(test)]
mod background_fixtures {
    use super::*;
    use crate::driver::DriverControl as _;
    use crate::TIDE_DIR_TEST_LOCK;
    use base64::Engine as _;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use tools::jobs::NoticeSource;

    /// The stale-prompt rule: the tests assert the NEW contract text, so a
    /// regression back to "poll output via bash_output" fails loudly here.
    #[test]
    fn bash_spec_promises_notification_not_polling() {
        let spec = tools::BashTool.spec();
        let description = spec.description.as_str();
        assert!(
            description.contains("you are notified in-session when the job finishes"),
            "{description}"
        );
        assert!(description.contains("job_output"));
        assert!(description.contains("job_kill"));
        assert!(!description.contains("poll output via bash_output"));
        assert!(!description.contains("kill_shell"));
        // And the parameter description carries the same flip.
        let background = &spec.parameters["properties"]["background"]["description"];
        assert!(background.as_str().unwrap().contains("job_output"), "{background}");
        assert!(!background.as_str().unwrap().contains("bash_output"));
    }

    // ── the mock model ──────────────────────────────────────────────────

    struct MockModel {
        base_url: String,
        requests: Arc<Mutex<Vec<serde_json::Value>>>,
        _listener: Arc<TcpListener>,
    }

    impl MockModel {
        /// Serve SSE bodies with content routing: a request body containing
        /// a route's needle is answered with that route's body after the
        /// route's delay in milliseconds (routes are scanned in order, the
        /// first match wins). Background dispatches need this — the ack
        /// step's request and the detached child's first request race to
        /// the mock, so queue positions cannot tell them apart, but the
        /// child's prompt (the dispatch task) can; the delay pins WHEN the
        /// child settles relative to the acking turn.
        fn spawn_routed(
            routes: Vec<(&'static str, u64, String)>,
            responses: Vec<String>,
        ) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url =
                format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let requests: Arc<Mutex<Vec<serde_json::Value>>> =
                Arc::new(Mutex::new(Vec::new()));
            let server_requests = Arc::clone(&requests);
            let queue = Arc::new(Mutex::new(VecDeque::from(responses)));
            let routes: Arc<Vec<(String, u64, String)>> = Arc::new(
                routes
                    .into_iter()
                    .map(|(needle, delay, body)| (needle.to_owned(), delay, body))
                    .collect(),
            );
            let listener = Arc::new(listener);
            {
                let listener = Arc::clone(&listener);
                std::thread::Builder::new()
                    .name("mock-model".into())
                    .spawn(move || {
                        for stream in listener.incoming() {
                            let Ok(stream) = stream else { break };
                            // One thread per connection: a route's delay
                            // holds only its own response, never the
                            // accept loop.
                            let requests = Arc::clone(&server_requests);
                            let queue = Arc::clone(&queue);
                            let routes = Arc::clone(&routes);
                            std::thread::Builder::new()
                                .name("mock-model-conn".into())
                                .spawn(move || {
                                    if let Err(error) =
                                        serve(&stream, &queue, &routes, &requests)
                                    {
                                        eprintln!("mock-model connection error: {error}");
                                    }
                                })
                                .ok();
                        }
                    })
                    .unwrap();
            }
            Self {
                base_url,
                requests,
                _listener: listener,
            }
        }

        fn captured(&self) -> Vec<serde_json::Value> {
            self.requests.lock().unwrap().clone()
        }
    }

    fn serve(
        stream: &TcpStream,
        queue: &Mutex<VecDeque<String>>,
        routes: &Arc<Vec<(String, u64, String)>>,
        requests: &Mutex<Vec<serde_json::Value>>,
    ) -> std::io::Result<()> {
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut request_line = String::new();
        reader.read_line(&mut request_line)?;
        let mut content_length = 0usize;
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header)? == 0 || header.trim().is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':')
                && name.trim().eq_ignore_ascii_case("content-length")
            {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
        let mut body_bytes = vec![0u8; content_length];
        if content_length > 0 {
            reader.read_exact(&mut body_bytes)?;
        }
        let body: serde_json::Value =
            serde_json::from_slice(&body_bytes).unwrap_or(serde_json::Value::Null);
        requests.lock().unwrap().push(body);
        let body_text = String::from_utf8_lossy(&body_bytes).into_owned();
        let sse = match routes
            .iter()
            .find(|(needle, _, _)| body_text.contains(needle.as_str()))
        {
            Some((_, delay_ms, body)) => {
                if *delay_ms > 0 {
                    std::thread::sleep(Duration::from_millis(*delay_ms));
                }
                body.clone()
            }
            None => {
                let mut queue = queue.lock().unwrap();
                queue
                    .pop_front()
                    .or_else(|| queue.front().cloned())
                    .unwrap_or_default()
            }
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            sse.len(),
            sse
        );
        let mut stream = stream;
        stream.write_all(response.as_bytes())?;
        stream.flush()?;
        Ok(())
    }

    // ── canned Anthropic SSE bodies (fixture byte shapes) ───────────────

    fn sse_message_start() -> String {
        let payload = serde_json::json!({
            "type": "message_start",
            "message": {
                "id": "msg_fixture", "type": "message", "role": "assistant",
                "model": "fixture-model", "content": [],
                "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": 10, "output_tokens": 1}
            }
        });
        format!("event: message_start\ndata: {payload}\n\n")
    }

    /// One streamed text block ending in `end_turn`.
    fn sse_text(text: &str) -> String {
        format!(
            "{}event: content_block_start\ndata: {}\n\nevent: content_block_delta\ndata: {}\n\nevent: content_block_stop\ndata: {}\n\nevent: message_delta\ndata: {}\n\nevent: message_stop\ndata: {}\n\n",
            sse_message_start(),
            serde_json::json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
            serde_json::json!({"type":"content_block_stop","index":0}),
            serde_json::json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8}}),
            serde_json::json!({"type":"message_stop"}),
        )
    }

    /// One streamed tool_use block (a single whole-JSON input delta) with
    /// `stop_reason: tool_use`.
    fn sse_tool_use(call_id: &str, tool: &str, arguments: &serde_json::Value) -> String {
        let input = arguments.to_string();
        format!(
            "{}event: content_block_start\ndata: {}\n\nevent: content_block_delta\ndata: {}\n\nevent: content_block_stop\ndata: {}\n\nevent: message_delta\ndata: {}\n\nevent: message_stop\ndata: {}\n\n",
            sse_message_start(),
            serde_json::json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":call_id,"name":tool,"input":{}}}),
            serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":input}}),
            serde_json::json!({"type":"content_block_stop","index":0}),
            serde_json::json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":16}}),
            serde_json::json!({"type":"message_stop"}),
        )
    }

    // ── the fixture driver ──────────────────────────────────────────────

    /// A driver wired against a local mock model. Every test holds
    /// [`TIDE_DIR_TEST_LOCK`] for its whole scenario — the data-dir env var
    /// is process-global and the driver re-resolves the config per turn.
    struct FixtureDriver {
        mock: MockModel,
        workspace: tempfile::TempDir,
        data_dir: tempfile::TempDir,
        driver: Arc<TideDriver>,
        events: crossbeam_channel::Receiver<DriverEvent>,
    }

    impl FixtureDriver {
        fn start(responses: Vec<String>) -> Self {
            Self::start_routed(Vec::new(), responses)
        }

        /// [`Self::start`] with content-routed responses for detached child
        /// loops (see [`MockModel::spawn_routed`]).
        fn start_routed(
            routes: Vec<(&'static str, u64, String)>,
            responses: Vec<String>,
        ) -> Self {
            let mock = MockModel::spawn_routed(routes, responses);
            let workspace = tempfile::tempdir().unwrap();
            let data_dir = tempfile::tempdir().unwrap();
            let encrypted = base64::engine::general_purpose::STANDARD.encode("fixture-key");
            let config = serde_json::json!({
                "providers": [{
                    "id": "fixture",
                    "name": "Fixture",
                    "apiStyle": "anthropic",
                    "baseUrl": mock.base_url,
                    "encryptedKey": encrypted,
                    "enabled": true,
                    "models": [{
                        "id": "m1",
                        "alias": "fixture",
                        "modelId": "fixture-model",
                        "contextWindow": 100_000u64,
                        "providerId": "fixture"
                    }]
                }]
            });
            std::fs::write(data_dir.path().join("config.json"), config.to_string())
                .unwrap();
            // Only reachable while the caller holds TIDE_DIR_TEST_LOCK.
            unsafe { std::env::set_var("TIDE_DATA_DIR", data_dir.path()) };
            let (wake, _wakes) = smol::channel::bounded(1);
            let (sender, events) = crate::driver::event_channel(wake);
            let driver = Arc::new(
                TideDriver::start(DriverStartOptions {
                    binary: PathBuf::new(),
                    prior_session: None,
                    cwd: workspace.path().to_path_buf(),
                    mode: protocol::model::RuntimeMode::FullAccess,
                    interaction_mode: InteractionMode::Build,
                    model: None,
                    reasoning_effort: None,
                    service_tier: None,
                    context_window: None,
                    agent_preset: None,
                    computer_use_enabled: false,
                    provider_cursor: None,
                }, sender)
                .expect("fixture driver starts against the mock model"),
            );
            Self {
                mock,
                workspace,
                data_dir,
                driver,
                events,
            }
        }

        fn turn_active(&self) -> bool {
            self.driver.inner.turn_active.load(Ordering::Acquire)
        }
    }

    /// Deconstruct-and-drop teardown: the driver dies first (close_session
    /// reaps live jobs, the pusher task ends), then the process-wide env
    /// var is restored before the fixture data dir vanishes.
    fn teardown(fixture: FixtureDriver) {
        let FixtureDriver {
            mock,
            workspace,
            data_dir,
            driver,
            events,
        } = fixture;
        drop(driver);
        drop(events);
        unsafe { std::env::remove_var("TIDE_DATA_DIR") };
        drop(mock);
        drop(workspace);
        drop(data_dir);
    }

    // ── assertion helpers ───────────────────────────────────────────────

    /// Poll `cond` against freshly drained events until it holds.
    fn collect_until(
        receiver: &crossbeam_channel::Receiver<DriverEvent>,
        timeout: Duration,
        mut cond: impl FnMut(&[DriverEvent]) -> bool,
    ) -> Vec<DriverEvent> {
        let deadline = std::time::Instant::now() + timeout;
        let mut all: Vec<DriverEvent> = Vec::new();
        loop {
            while let Ok(event) = receiver.try_recv() {
                all.push(event);
            }
            if cond(&all) {
                return all;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for driver events; have {} so far",
                all.len()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn turn_starts(events: &[DriverEvent]) -> usize {
        events
            .iter()
            .filter(|event| matches!(event, DriverEvent::TurnStarted))
            .count()
    }

    fn work_events(events: &[DriverEvent]) -> Vec<&BackgroundWorkEvent> {
        events
            .iter()
            .filter_map(|event| match event {
                DriverEvent::BackgroundWork(work) => Some(work),
                _ => None,
            })
            .collect()
    }

    /// Statuses of every `Upsert` the job id received, in arrival order.
    fn upsert_statuses(events: &[DriverEvent], id: &str) -> Vec<BackgroundWorkStatus> {
        work_events(events)
            .into_iter()
            .filter_map(|work| match work {
                BackgroundWorkEvent::Upsert(item) if item.key.provider_id == id => {
                    Some(item.status)
                }
                _ => None,
            })
            .collect()
    }

    /// The user-role message texts a captured request carried.
    fn user_messages(request: &serde_json::Value) -> Vec<String> {
        request["messages"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .filter(|message| message["role"] == "user")
            .map(|message| message["content"].to_string())
            .collect()
    }

    fn notice(text: &str) -> JobNotice {
        JobNotice {
            text: text.to_owned(),
            snapshot: BackgroundWorkItem::new(
                BackgroundWorkKind::Process,
                format!("job-{text}"),
                "fixture job",
                BackgroundWorkStatus::Completed,
            ),
            source: NoticeSource::Job,
        }
    }

    // ── Stage 3: the transport glue ─────────────────────────────────────

    #[test]
    fn job_lifecycle_streams_in_order_and_stop_settles_stopped() {
        let _guard = TIDE_DIR_TEST_LOCK.lock().unwrap();
        let fixture = FixtureDriver::start(vec![
            sse_tool_use(
                "t1",
                "bash",
                &serde_json::json!({"command": "sleep 30", "background": true}),
            ),
            sse_text("Started the long runner in the background."),
        ]);
        let key = BackgroundWorkKey {
            kind: BackgroundWorkKind::Process,
            provider_id: "bash-1".to_owned(),
        };

        fixture.driver.prompt("start the long runner".to_owned());
        // Events accumulate across every wait: drains consume, so the final
        // assertions read one merged transcript of the whole scenario.
        let mut seen: Vec<DriverEvent> = Vec::new();
        seen.extend(collect_until(&fixture.events, Duration::from_secs(20), |events| {
            upsert_statuses(events, "bash-1")
                .contains(&BackgroundWorkStatus::Running)
        }));

        // The control id IS the job id: stop via the trait path.
        fixture
            .driver
            .stop_background_work(key.clone(), "bash-1".to_owned());

        // StopRequested arrives, then the job settles Stopped — the cancel
        // hook terminated the process and the exit watch resolved.
        seen.extend(collect_until(&fixture.events, Duration::from_secs(10), |events| {
            upsert_statuses(events, "bash-1").last() == Some(&BackgroundWorkStatus::Stopped)
                && work_events(events).iter().any(|work| {
                    matches!(work, BackgroundWorkEvent::StopRequested(requested)
                        if requested == &key)
                })
        }));
        let statuses = upsert_statuses(&seen, "bash-1");
        assert!(
            statuses.contains(&BackgroundWorkStatus::Stopping),
            "stop flips through Stopping: {statuses:?}"
        );
        assert_eq!(statuses.last(), Some(&BackgroundWorkStatus::Stopped));

        // Reconciliation answers straight from the registry.
        fixture.driver.refresh_background_work();
        seen.extend(collect_until(&fixture.events, Duration::from_secs(5), |events| {
            work_events(events).iter().any(|work| {
                matches!(work, BackgroundWorkEvent::ReconcileLive { items }
                    if items.iter().any(|item| item.key == key))
            })
        }));
        let items = work_events(&seen)
            .into_iter()
            .find_map(|work| match work {
                BackgroundWorkEvent::ReconcileLive { items } => Some(items.clone()),
                _ => None,
            })
            .unwrap();
        let item = items.iter().find(|item| item.key == key).unwrap();
        assert_eq!(item.status, BackgroundWorkStatus::Stopped);
        assert_eq!(item.control_id.as_deref(), Some("bash-1"));
        assert!(item.background);

        // The kill marked the job reported, so the settlement never wakes a
        // follow-up turn — exactly one turn (the starter) ran.
        wait_for_idle(&fixture);
        seen.extend(drain_all(&fixture.events));
        assert_eq!(turn_starts(&seen), 1, "events: {seen:?}");
        teardown(fixture);
    }

    fn drain_all(receiver: &crossbeam_channel::Receiver<DriverEvent>) -> Vec<DriverEvent> {
        let mut all = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            all.push(event);
        }
        all
    }

    /// Wait until the mock model has served `count` requests.
    fn wait_for_requests(fixture: &FixtureDriver, count: usize, timeout: Duration) {
        let deadline = std::time::Instant::now() + timeout;
        while fixture.mock.captured().len() < count {
            assert!(
                std::time::Instant::now() < deadline,
                "only {} of {count} expected requests arrived",
                fixture.mock.captured().len()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_for_idle(fixture: &FixtureDriver) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while fixture.turn_active() {
            assert!(
                std::time::Instant::now() < deadline,
                "the session never went idle"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    // ── Stage 4: the wake ───────────────────────────────────────────────

    /// A background bash started, the turn ends, the job settles → a NEW
    /// turn opens whose first user message is the notice, and `job_output`
    /// is called into the mock model from that turn.
    #[test]
    fn settling_on_an_idle_session_opens_a_turn_starting_with_the_notice() {
        let _guard = TIDE_DIR_TEST_LOCK.lock().unwrap();
        let fixture = FixtureDriver::start(vec![
            sse_tool_use(
                "t1",
                "bash",
                &serde_json::json!({
                    "command": "sleep 1 && echo tide-bg-marker",
                    "background": true
                }),
            ),
            sse_text("The job is running in the background."),
            // Turn 2: the notice opened it — the model collects the output.
            sse_tool_use("t2", "job_output", &serde_json::json!({"job_id": "bash-1"})),
            sse_text("Collected the background output."),
        ]);

        fixture.driver.prompt("run the marker job in the background".to_owned());
        // Four requests: turn 1's two steps, then turn 2's two steps.
        wait_for_requests(&fixture, 4, Duration::from_secs(20));
        wait_for_idle(&fixture);
        // Give a spurious extra turn (the double-run bug this stage fixes)
        // time to show up before asserting it did not.
        std::thread::sleep(Duration::from_millis(500));

        let requests = fixture.mock.captured();
        // Turn 2's LAST user message is the settlement notice.
        let notice_texts = user_messages(&requests[2]);
        let notice_text = notice_texts.last().expect("turn 2 carries user input");
        assert!(
            notice_text.contains("background job bash-1"),
            "notice: {notice_text}"
        );
        assert!(
            notice_text.contains("Read its output with job_output"),
            "notice: {notice_text}"
        );
        // `job_output` ran against the registry and its result reached the
        // model in turn 2's second step.
        assert!(
            serde_json::to_string(&requests[3])
                .unwrap()
                .contains("tide-bg-marker"),
            "the collected output never reached the model"
        );

        // Exactly two turns opened, and the job's lifecycle streamed
        // Starting → Running → terminal through the DriverEvent stream.
        let events = drain_all(&fixture.events);
        assert_eq!(turn_starts(&events), 2, "events: {events:?}");
        assert_eq!(
            upsert_statuses(&events, "bash-1"),
            vec![
                BackgroundWorkStatus::Starting,
                BackgroundWorkStatus::Running,
                BackgroundWorkStatus::Completed,
            ]
        );
        teardown(fixture);
    }

    /// A notice arriving while a turn is ACTIVE drains at that turn's next
    /// step boundary — no new turn opens.
    #[test]
    fn notice_during_an_active_turn_drains_at_the_next_step_boundary() {
        let _guard = TIDE_DIR_TEST_LOCK.lock().unwrap();
        let fixture = FixtureDriver::start(vec![
            sse_tool_use(
                "t1",
                "bash",
                &serde_json::json!({"command": "echo started; sleep 1", "background": true}),
            ),
            // The foreground call keeps the turn busy past the background
            // job's settlement.
            sse_tool_use("t2", "bash", &serde_json::json!({"command": "sleep 2"})),
            sse_text("Done with the foreground work."),
        ]);

        fixture.driver.prompt("overlap background and foreground work".to_owned());
        wait_for_requests(&fixture, 3, Duration::from_secs(20));
        wait_for_idle(&fixture);
        std::thread::sleep(Duration::from_millis(500));

        let requests = fixture.mock.captured();
        // The third request is the SAME turn's next step, and it carries
        // the notice as a user message.
        let request_text = serde_json::to_string(&requests[2]).unwrap();
        assert!(
            request_text.contains("background job bash-1"),
            "the notice never drained into the running turn: {request_text}"
        );
        // One turn only — the busy lane must never open another.
        let events = drain_all(&fixture.events);
        assert_eq!(turn_starts(&events), 1, "events: {events:?}");
        teardown(fixture);
    }

    /// Three notices open three turns; the fourth is refused (budget) and
    /// falls back to the inject lane; a consumed User message refills.
    #[test]
    fn wake_budget_spends_three_then_refuses_and_a_user_prompt_refills() {
        let _guard = TIDE_DIR_TEST_LOCK.lock().unwrap();
        // No canned responses: the wake turns resolve the fixture engine
        // and end immediately on the empty stream — exactly enough to spend
        // and refill the budget without model behavior in the way.
        let fixture = FixtureDriver::start(Vec::new());
        let wake = Arc::clone(&fixture.driver.inner.wake);

        assert!(wake.is_idle());
        assert!(wake.wake_turn(notice("wake-1")));
        assert!(wake.wake_turn(notice("wake-2")));
        assert!(wake.wake_turn(notice("wake-3")));
        assert_eq!(
            wake.wake_budget_remaining(),
            0,
            "three accepted wakes must spend the whole budget"
        );
        assert!(
            !wake.wake_turn(notice("wake-4")),
            "the fourth consecutive wake must be refused"
        );

        // All three accepted wakes eventually ran as turns.
        collect_until(&fixture.events, Duration::from_secs(15), |events| {
            turn_starts(events) >= 3
        });
        wait_for_idle(&fixture);

        // The refused notice degrades to the inject lane: queued for the
        // next turn's step boundary, never lost.
        wake.inject_step(notice("wake-5-degraded"));
        assert_eq!(fixture.driver.inner.inbox.step_depth(), 1);

        // A user prompt refills the budget the moment its turn consumes it.
        fixture.driver.prompt("the user is back".to_owned());
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while wake.wake_budget_remaining() != MAX_CONSECUTIVE_WAKES {
            assert!(
                std::time::Instant::now() < deadline,
                "the consumed user message never refilled the wake budget"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        wait_for_idle(&fixture);
        teardown(fixture);
    }

    /// `wake_turn` concurrent with `prompt()` — exactly one of them claims
    /// the turn, so a single run_turn runs at a time and each message runs
    /// exactly once.
    #[test]
    fn wake_turn_concurrent_with_prompt_never_yields_two_turn_loops() {
        let _guard = TIDE_DIR_TEST_LOCK.lock().unwrap();
        let fixture = FixtureDriver::start(Vec::new());
        let wake = Arc::clone(&fixture.driver.inner.wake);
        let driver = Arc::clone(&fixture.driver);

        let barrier = Arc::new(std::sync::Barrier::new(2));
        let prompter = {
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                driver.prompt("the user prompt".to_owned());
            })
        };
        let waker = {
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                wake.wake_turn(notice("the job notice"))
            })
        };
        prompter.join().unwrap();
        assert!(
            waker.join().unwrap(),
            "a fresh budget must accept the wake whichever way the race lands"
        );

        // Both messages eventually ran — but only ever ONE loop at a time:
        // TurnStarted strictly alternates with TurnFinished.
        let events = collect_until(&fixture.events, Duration::from_secs(15), |events| {
            turn_starts(events) >= 2
        });
        wait_for_idle(&fixture);
        let events = {
            let mut all = events;
            all.extend(drain_all(&fixture.events));
            all
        };
        assert_eq!(turn_starts(&events), 2, "each message runs exactly once");
        let mut active = false;
        for event in &events {
            match event {
                DriverEvent::TurnStarted => {
                    assert!(!active, "two turn loops ran at once: {events:?}");
                    active = true;
                }
                DriverEvent::TurnFinished { .. } => {
                    assert!(active, "TurnFinished without a running turn");
                    active = false;
                }
                _ => {}
            }
        }
        assert!(!active, "a turn never finished");
        teardown(fixture);
    }

    // ── Stage 5: background dispatch ────────────────────────────────────

    /// The `dispatchId:` line of an ack (or a foreground report), pulled out
    /// of a captured request's tool-result content.
    fn dispatch_id_in(request: &serde_json::Value) -> Option<String> {
        let text = serde_json::to_string(request).ok()?;
        let marker = "dispatchId: ";
        let start = text.find(marker)? + marker.len();
        let rest = &text[start..];
        let end = rest.find('"').unwrap_or(rest.len());
        Some(rest[..end].to_owned())
    }

    /// The dispatch id of the tool result that FOLLOWS `needle` in the
    /// request body — one request can carry several tool results (one step
    /// runs several calls), so the anchor decides which id is meant.
    fn dispatch_id_after(request: &serde_json::Value, needle: &str) -> Option<String> {
        let text = serde_json::to_string(request).ok()?;
        let anchor = text.find(needle)? + needle.len();
        let marker = "dispatchId: ";
        let start = text[anchor..].find(marker)? + anchor + marker.len();
        let rest = &text[start..];
        let end = rest.find('"').unwrap_or(rest.len());
        Some(rest[..end].to_owned())
    }

    /// The first captured request whose serialized body contains `needle`.
    fn request_containing<'a>(
        requests: &'a [serde_json::Value],
        needle: &str,
    ) -> Option<&'a serde_json::Value> {
        requests
            .iter()
            .find(|request| serde_json::to_string(request).unwrap_or_default().contains(needle))
    }

    /// The dispatch id carried by the background ack (the request whose tool
    /// results contain the ack line).
    fn acked_dispatch_id(requests: &[serde_json::Value]) -> Option<String> {
        request_containing(requests, "started background job")
            .and_then(|request| dispatch_id_after(request, "started background job"))
    }

    fn subagent_upserts<'a>(events: &'a [DriverEvent], id: &str) -> Vec<&'a BackgroundWorkItem> {
        work_events(events)
            .into_iter()
            .filter_map(|work| match work {
                BackgroundWorkEvent::Upsert(item)
                    if item.key.kind == BackgroundWorkKind::Subagent
                        && item.key.provider_id == id =>
                {
                    Some(item)
                }
                _ => None,
            })
            .collect()
    }

    /// A background dispatch acks with the job id in the SAME turn's next
    /// step, before the child has even made its first model request — then
    /// the child's settlement opens a follow-up turn whose user input is
    /// the completion notice. The report lands in the job's `output`, and
    /// the Agents-panel stream (SubagentBlocks) reaches settlement.
    #[test]
    fn background_dispatch_acks_immediately_and_wakes_the_parent_on_completion() {
        let _guard = TIDE_DIR_TEST_LOCK.lock().unwrap();
        let fixture = FixtureDriver::start_routed(
            vec![(
                // The detached child's prompt is the dispatch task — route
                // its steps without depending on request arrival order. The
                // delay pins the child's settlement AFTER the acking turn
                // has gone idle, so the notice deterministically takes the
                // idle lane.
                "text\":\"research the background dispatch seam\"",
                1500,
                sse_text("the background child report"),
            )],
            vec![
                // Turn 1, step 1: the model dispatches in the background.
                sse_tool_use(
                    "t1",
                    "dispatch_agent",
                    &serde_json::json!({
                        "name": "explore",
                        "task": "research the background dispatch seam",
                        "title": "Bg explore",
                        "background": true
                    }),
                ),
                // Turn 1, step 2: the ack — the model keeps working and ends.
                sse_text("Dispatched it in the background."),
            ],
        );

        fixture.driver.prompt("delegate research in the background".to_owned());
        // Turn 1's two steps, the child's step, then turn 2's single step
        // (the wake turn ends on the repeated tail response). Drains consume,
        // so events accumulate into one merged transcript as in the stage-3
        // scenario above.
        let mut seen: Vec<DriverEvent> = Vec::new();
        wait_for_requests(&fixture, 4, Duration::from_secs(20));
        wait_for_idle(&fixture);
        std::thread::sleep(Duration::from_millis(500));
        seen.extend(drain_all(&fixture.events));

        let requests = fixture.mock.captured();
        // The tool result the turn committed is the ACK — not the report. A
        // synchronous dispatch would have answered with the child's report,
        // so the ack's presence IS the immediacy proof.
        let ack_request = request_containing(&requests, "started background job")
            .expect("the dispatch result is the ack");
        let ack_text = serde_json::to_string(ack_request).unwrap();
        let child_id = dispatch_id_in(ack_request).expect("ack carries the dispatch id");
        assert!(
            ack_text.contains(&format!("started background job {child_id}")),
            "ack: {ack_text}"
        );
        assert!(
            ack_text.contains("Do not poll"),
            "ack carries the notification contract: {ack_text}"
        );
        assert!(
            !ack_text.contains("the background child report"),
            "the ack must not await the child: {ack_text}"
        );

        // Completion woke the parent: a second turn whose last user message
        // is the settlement notice, addressed by the child id.
        assert_eq!(turn_starts(&seen), 2, "events: {seen:?}");
        let wake_request = request_containing(&requests, "finished [status: completed]")
            .expect("the wake turn's request");
        let notice_texts = user_messages(wake_request);
        let notice = notice_texts.last().expect("wake turn carries user input");
        assert!(
            notice.contains(&format!("background job {child_id} finished [status: completed]")),
            "notice: {notice}"
        );

        // The Agents-panel stream reached settlement: blocks streamed and
        // the terminal upsert carries the report as the job's output.
        let key = BackgroundWorkKey {
            kind: BackgroundWorkKind::Subagent,
            provider_id: child_id.clone(),
        };
        assert!(
            work_events(&seen).iter().any(|work| matches!(
                work,
                BackgroundWorkEvent::SubagentBlocks { key: blocks_key, .. } if *blocks_key == key
            )),
            "blocks never streamed: {seen:?}"
        );
        let terminal = subagent_upserts(&seen, &child_id)
            .into_iter()
            .last()
            .expect("terminal upsert")
            .clone();
        assert_eq!(terminal.status, BackgroundWorkStatus::Completed);
        assert_eq!(terminal.output.as_deref(), Some("the background child report"));
        assert!(terminal.background);
        assert_eq!(terminal.control_id.as_deref(), Some(child_id.as_str()));

        // The job id IS the child id: the model's reader gets the report.
        let read = global_job_registry()
            .read(&fixture.driver.inner.session_id, &key, Reader::Model)
            .expect("job is readable");
        assert_eq!(read.text, "the background child report");
        teardown(fixture);
    }

    /// `job_kill` on a running background dispatch settles the job Stopped
    /// and aborts the child loop — and the kill marked the job reported, so
    /// no wake turn opens afterwards.
    #[test]
    fn job_kill_mid_run_settles_stopped_and_aborts_the_child_loop() {
        let _guard = TIDE_DIR_TEST_LOCK.lock().unwrap();
        let fixture = FixtureDriver::start_routed(
            vec![(
                // The child keeps stepping on a real bash sleep, so it is
                // mid-run when the kill lands. general-purpose is the agent
                // whose toolset actually carries bash.
                "text\":\"grind until stopped\"",
                0,
                sse_tool_use("c1", "bash", &serde_json::json!({"command": "sleep 1"})),
            )],
            vec![
                sse_tool_use(
                    "t1",
                    "dispatch_agent",
                    &serde_json::json!({
                        "name": "general-purpose",
                        "task": "grind until stopped",
                        "title": "Grinder",
                        "background": true
                    }),
                ),
                sse_text("Dispatched it in the background."),
            ],
        );

        fixture.driver.prompt("delegate and then stop it".to_owned());
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let child_id = loop {
            if let Some(child_id) = acked_dispatch_id(&fixture.mock.captured()) {
                break child_id;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the ack never reached the model ({} requests so far)",
                fixture.mock.captured().len()
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        let key = BackgroundWorkKey {
            kind: BackgroundWorkKind::Subagent,
            provider_id: child_id.clone(),
        };

        // The control id IS the job id: stop through the trait path.
        fixture.driver.stop_background_work(key.clone(), child_id.clone());

        // StopRequested arrives, then the job settles Stopped — which only
        // happens once the aborted child loop has actually finished.
        let events = collect_until(&fixture.events, Duration::from_secs(15), |events| {
            upsert_statuses(events, &child_id).last() == Some(&BackgroundWorkStatus::Stopped)
                && work_events(events).iter().any(|work| {
                    matches!(work, BackgroundWorkEvent::StopRequested(requested) if *requested == key)
                })
        });
        let statuses = upsert_statuses(&events, &child_id);
        assert!(
            statuses.contains(&BackgroundWorkStatus::Stopping),
            "stop flips through Stopping: {statuses:?}"
        );
        assert_eq!(statuses.last(), Some(&BackgroundWorkStatus::Stopped));

        // The child loop really aborted: its roster status settled, and no
        // further child requests arrive after the settle.
        std::thread::sleep(Duration::from_millis(700));
        let settled_requests = fixture.mock.captured().len();
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(
            fixture.mock.captured().len(),
            settled_requests,
            "the child loop kept running after the kill"
        );
        let state = fixture
            .driver
            .inner
            .children
            .lock()
            .unwrap()
            .get(&child_id)
            .expect("child stays resumable")
            .clone();
        assert_eq!(*state.status.lock().unwrap(), BackgroundWorkStatus::Stopped);

        // Reported by the kill: the settlement never wakes a turn.
        std::thread::sleep(Duration::from_millis(500));
        let events = {
            let mut all = events;
            all.extend(drain_all(&fixture.events));
            all
        };
        assert_eq!(turn_starts(&events), 1, "events: {events:?}");
        teardown(fixture);
    }

    /// A foreground dispatch (report awaited inline) and a background
    /// dispatch in the SAME session coexist: each keeps its own durable id,
    /// only the background one is a registry job, and neither collides.
    #[test]
    fn foreground_and_background_dispatches_coexist_without_collisions() {
        let _guard = TIDE_DIR_TEST_LOCK.lock().unwrap();
        let fixture = FixtureDriver::start_routed(
            vec![
                (
                    "text\":\"foreground exploration\"",
                    0,
                    sse_text("the foreground child report"),
                ),
                (
                    "text\":\"background exploration\"",
                    800,
                    sse_text("the background child report"),
                ),
            ],
            vec![
                // Step 1: a FOREGROUND dispatch — the parent awaits the report.
                sse_tool_use(
                    "t1",
                    "dispatch_agent",
                    &serde_json::json!({
                        "name": "explore",
                        "task": "foreground exploration",
                        "title": "Fg explore"
                    }),
                ),
                // Step 2: a BACKGROUND dispatch in the same session, then the
                // turn ends on the ack.
                sse_tool_use(
                    "t2",
                    "dispatch_agent",
                    &serde_json::json!({
                        "name": "explore",
                        "task": "background exploration",
                        "title": "Bg explore",
                        "background": true
                    }),
                ),
                sse_text("Dispatched it in the background."),
            ],
        );

        fixture.driver.prompt("delegate twice, once foreground once background".to_owned());
        // Four requests: the two dispatch steps, the foreground child's step,
        // and the ack step; the wake turn ends on the repeated tail.
        wait_for_requests(&fixture, 5, Duration::from_secs(30));
        wait_for_idle(&fixture);
        std::thread::sleep(Duration::from_millis(500));

        let requests = fixture.mock.captured();
        let foreground_id = request_containing(&requests, "the foreground child report")
            .and_then(|request| dispatch_id_after(request, "the foreground child report"))
            .expect("foreground report carries its id");
        let background_id = acked_dispatch_id(&requests).expect("background ack carries its id");
        assert_ne!(foreground_id, background_id, "durable ids never collide");

        let events = drain_all(&fixture.events);
        // The foreground item streamed to the CLIENT registry (not the job
        // registry) as a non-background item...
        let foreground = subagent_upserts(&events, &foreground_id);
        assert!(!foreground.is_empty(), "foreground item streamed");
        assert!(!foreground.iter().any(|item| item.background));
        // ...and the background one is the only Subagent job in the
        // registry's session list, keyed by its durable child id.
        let listed = global_job_registry()
            .list_session(&fixture.driver.inner.session_id)
            .into_iter()
            .filter(|item| item.key.kind == BackgroundWorkKind::Subagent)
            .collect::<Vec<_>>();
        assert_eq!(
            listed.iter().map(|item| item.key.provider_id.clone()).collect::<Vec<_>>(),
            vec![background_id.clone()],
            "exactly the background job is registered: {listed:?}"
        );
        let background = listed.first().unwrap();
        assert!(background.background);
        assert_eq!(background.control_id.as_deref(), Some(background_id.as_str()));
        assert_eq!(background.title, "background exploration");
        // The background child settles on its own — its report lands in the
        // job's output (the notice path itself is covered by the dedicated
        // test above).
        let settled = collect_until(&fixture.events, Duration::from_secs(15), |events| {
            subagent_upserts(events, &background_id)
                .last()
                .is_some_and(|item| !item.status.is_live())
        });
        let terminal = subagent_upserts(&settled, &background_id)
            .into_iter()
            .last()
            .unwrap()
            .clone();
        assert_eq!(terminal.status, BackgroundWorkStatus::Completed);
        assert_eq!(terminal.output.as_deref(), Some("the background child report"));
        teardown(fixture);
    }

    /// A resumed background child re-registers under its durable id: the
    /// previous run's terminal registry record is replaced, not refused.
    #[test]
    fn a_resumed_background_child_reregisters_under_its_durable_id() {
        // Registry-level shape of the resume: the driver's start path hits
        // this exact rule (the child id is the job id, decision 10). The
        // session id is unique, so no fixture lock is needed.
        let session = format!("resume-shape-{}", Uuid::new_v4());
        let key = global_job_registry()
            .start(JobStart {
                kind: BackgroundWorkKind::Subagent,
                prefix: "sub",
                id: Some("child-resume-1".into()),
                label: "first run".into(),
                owner_session: session.clone(),
                output_limit: None,
                streams: false,
                run: Box::new(|handle| {
                    Ok(JobHooks {
                        cancel: Box::new(|_| {}),
                        done: handle.done.clone(),
                    })
                }),
            })
            .unwrap();
        global_job_registry().settle(
            &session,
            &key,
            JobOutcome {
                status: SettledStatus::Completed,
                detail: None,
                output: Some("first report".into()),
            },
        );

        global_job_registry()
            .start(JobStart {
                kind: BackgroundWorkKind::Subagent,
                prefix: "sub",
                id: Some("child-resume-1".into()),
                label: "resumed run".into(),
                owner_session: session.clone(),
                output_limit: None,
                streams: false,
                run: Box::new(|handle| {
                    Ok(JobHooks {
                        cancel: Box::new(|_| {}),
                        done: handle.done.clone(),
                    })
                }),
            })
            .expect("a terminal record under the durable id is replaced");

        let listed = global_job_registry().list_session(&session);
        assert_eq!(listed.len(), 1, "no duplicate records: {listed:?}");
        assert_eq!(listed[0].key.provider_id, "child-resume-1");
        assert_eq!(listed[0].title, "resumed run");
        // A LIVE record still collides.
        let error = global_job_registry()
            .start(JobStart {
                kind: BackgroundWorkKind::Subagent,
                prefix: "sub",
                id: Some("child-resume-1".into()),
                label: "ghost".into(),
                owner_session: session.clone(),
                output_limit: None,
                streams: false,
                run: Box::new(|handle| {
                    Ok(JobHooks {
                        cancel: Box::new(|_| {}),
                        done: handle.done.clone(),
                    })
                }),
            })
            .unwrap_err();
        assert!(error.to_string().contains("already exists"), "{error}");
        global_job_registry().close_session(&session, Duration::from_millis(50));
    }
}
