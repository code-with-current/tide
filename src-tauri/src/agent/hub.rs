//! ChatHub — the orchestrator's process-wide state: the EventSink, the
//! agent-event push broadcast, per-session AgentEvent seq counters, the
//! one-turn-per-session registry (with abort watch + tool AbortFlag + the
//! escalatable autonomy mode), and the pending-permission registry
//! (`permission_respond` resolves a oneshot the gated tool call awaits).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tide_store::sessions_v2_write::SessionsV2Writer;
use tide_tools::{AbortFlag, AutonomyMode, TodoState, TodosUpdated};
use tokio::sync::{broadcast, oneshot, watch};

use super::events::{AgentEvent, ChatPush};
use super::sink::{EventSink, SeqCounters};

/// What a pending permission ask resolves with — one user action
/// (`permission_respond`), possibly carrying an "always allow" rule and/or a
/// mode escalation that un-gates the rest of the turn.
pub struct PermissionAnswer {
    pub approve: bool,
    pub remember: bool,
    pub reason: Option<String>,
}

/// One parked permission ask. `mode` is the autonomy cell an escalation
/// answer mutates: the asking turn's own cell (root turns share the
/// `ChatHub::active` entry's cell; dispatch children own a private cell) —
/// a sub-agent's approved escalation can never reach the parent turn's mode.
struct PendingAsk {
    tx: oneshot::Sender<PermissionAnswer>,
    mode: Option<Arc<StdMutex<AutonomyMode>>>,
}

struct ActiveTurn {
    abort: watch::Sender<bool>,
    tool_abort: AbortFlag,
    mode: Arc<StdMutex<AutonomyMode>>,
}

/// The abort surface a running turn sees. Cloned out of [`ChatHub::begin_turn`];
/// dispatch children clone the parent's abort surfaces but carry a PRIVATE
/// mode cell (contained escalation).
#[derive(Debug, Clone)]
pub struct TurnHandle {
    pub abort_rx: watch::Receiver<bool>,
    pub tool_abort: AbortFlag,
    pub mode: Arc<StdMutex<AutonomyMode>>,
}

impl TurnHandle {
    pub fn is_aborted(&self) -> bool {
        *self.abort_rx.borrow()
    }

    pub fn mode(&self) -> AutonomyMode {
        *self.mode.lock().expect("turn mode poisoned")
    }
}

pub struct ChatHub {
    db_path: PathBuf,
    sink: EventSink,
    push_tx: broadcast::Sender<ChatPush>,
    seq: SeqCounters,
    active: StdMutex<HashMap<String, ActiveTurn>>,
    /// Keyed `session_id + '\u{0}' + tool_call_id`.
    asks: StdMutex<HashMap<String, PendingAsk>>,
    channel_generation: AtomicU64,
    /// App-wide todo store shared with every turn's ToolContext. The
    /// subscription wired in [`ChatHub::open`] forwards each store change
    /// to the renderer as a `todosUpdated` push (the todo_write tool's
    /// side-channel; T7 adds the renderer bridge routing + persistence).
    todo_state: Arc<TodoState>,
}

impl ChatHub {
    /// Opens (creating if needed) sessions-v2.db and spawns the sink's flush
    /// task. Must run inside a tokio runtime (async commands / tests).
    pub fn open(data_dir: &Path) -> Result<Arc<Self>, String> {
        let db_path = data_dir.join("sessions-v2.db");
        let writer = SessionsV2Writer::open(&db_path).map_err(|e| e.to_string())?;
        let writer = Arc::new(StdMutex::new(writer));
        let (push_tx, _) = broadcast::channel(1024);
        let sink = EventSink::spawn(Arc::clone(&writer), push_tx.clone());
        let todo_state = TodoState::shared();
        todo_state.subscribe({
            let push_tx = push_tx.clone();
            move |event: &TodosUpdated| {
                let _ = push_tx.send(ChatPush::TodosUpdated {
                    event: event.clone(),
                });
            }
        });
        Ok(Arc::new(Self {
            db_path,
            sink,
            push_tx,
            seq: SeqCounters::default(),
            active: StdMutex::new(HashMap::new()),
            asks: StdMutex::new(HashMap::new()),
            channel_generation: AtomicU64::new(0),
            todo_state,
        }))
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn sink(&self) -> &EventSink {
        &self.sink
    }

    pub fn writer(&self) -> &Arc<StdMutex<SessionsV2Writer>> {
        self.sink.writer()
    }

    /// Push one AgentEvent to every attached webview Channel.
    pub fn emit_agent(&self, event: AgentEvent) {
        let _ = self.push_tx.send(ChatPush::Agent { event });
    }

    pub fn subscribe_push(&self) -> broadcast::Receiver<ChatPush> {
        self.push_tx.subscribe()
    }

    /// The app-wide todo store the todo_write tool mutates through the
    /// per-turn ToolContext.
    pub fn todo_state(&self) -> &Arc<TodoState> {
        &self.todo_state
    }

    pub fn next_seq(&self, session_id: &str) -> u64 {
        self.seq.next(session_id)
    }

    /// One turn per session: a second `chat_run_turn` on an active session
    /// is refused (the TS activeTurns overwrite is surfaced as an explicit
    /// pre-flight error here). The initial autonomy mode rides the handle —
    /// `permission_respond` escalations mutate it for the rest of the turn.
    pub fn begin_turn(&self, session_id: &str, initial_mode: AutonomyMode) -> Result<TurnHandle, String> {
        let mut active = self.active.lock().expect("active turns poisoned");
        if active.contains_key(session_id) {
            return Err(format!("A turn is already active for session {session_id}"));
        }
        let (abort_tx, abort_rx) = watch::channel(false);
        let tool_abort = AbortFlag::new();
        let mode = Arc::new(StdMutex::new(initial_mode));
        active.insert(
            session_id.to_owned(),
            ActiveTurn {
                abort: abort_tx,
                tool_abort: tool_abort.clone(),
                mode: Arc::clone(&mode),
            },
        );
        Ok(TurnHandle {
            abort_rx,
            tool_abort,
            mode,
        })
    }

    pub fn set_turn_mode(&self, session_id: &str, mode: AutonomyMode) -> bool {
        let active = self.active.lock().expect("active turns poisoned");
        match active.get(session_id) {
            Some(turn) => {
                *turn.mode.lock().expect("turn mode poisoned") = mode;
                true
            }
            None => false,
        }
    }

    /// Whether a turn currently holds the session (no registration side
    /// effect — a begin_turn refusal probe would leak one). Test/observability
    /// probe; production flows use begin_turn's refusal.
    #[cfg(test)]
    pub fn turn_active(&self, session_id: &str) -> bool {
        self.active
            .lock()
            .expect("active turns poisoned")
            .contains_key(session_id)
    }

    /// Deregister the turn and resolve any still-pending asks as denied —
    /// a card left behind by an ended turn must never hang the renderer.
    pub fn end_turn(&self, session_id: &str) {
        self.active
            .lock()
            .expect("active turns poisoned")
            .remove(session_id);
        self.resolve_session_asks(session_id, |tool_call_id| PermissionAnswer {
            approve: false,
            remember: false,
            reason: Some(format!("Turn ended before {tool_call_id} was answered")),
        });
    }

    /// `chat_abort`: cancel the stream + tools, and reject pending asks with
    /// 'aborted' (the TS `abortPermission(sessionId, 'aborted')`).
    pub fn abort_turn(&self, session_id: &str) {
        let active = self.active.lock().expect("active turns poisoned");
        if let Some(turn) = active.get(session_id) {
            let _ = turn.abort.send(true);
            turn.tool_abort.abort();
        }
        drop(active);
        self.resolve_session_asks(session_id, |_| PermissionAnswer {
            approve: false,
            remember: false,
            reason: Some("aborted".to_owned()),
        });
    }

    fn resolve_session_asks(
        &self,
        session_id: &str,
        answer: impl Fn(&str) -> PermissionAnswer,
    ) {
        let mut asks = self.asks.lock().expect("permission asks poisoned");
        let keys: Vec<String> = asks
            .keys()
            .filter(|k| k.starts_with(&format!("{session_id}\u{0}")))
            .cloned()
            .collect();
        for key in keys {
            if let Some(pending) = asks.remove(&key) {
                let tool_call_id = key.split('\u{0}').nth(1).unwrap_or("");
                let _ = pending.tx.send(answer(tool_call_id));
            }
        }
    }

    /// Park a gated tool call: the orchestrator awaits the matching oneshot.
    /// Escalation answers target the session's active (root) turn.
    pub fn register_ask(
        &self,
        session_id: &str,
        tool_call_id: &str,
    ) -> oneshot::Receiver<PermissionAnswer> {
        self.register_ask_with_mode(session_id, tool_call_id, None)
    }

    /// Sub-agent variant: the ask rides the root session's id space (the
    /// renderer card and `permission_respond` address the root session) but
    /// an escalation answer mutates only `mode` — the child turn's private
    /// cell, never the parent's.
    pub fn register_ask_with_mode(
        &self,
        session_id: &str,
        tool_call_id: &str,
        mode: Option<Arc<StdMutex<AutonomyMode>>>,
    ) -> oneshot::Receiver<PermissionAnswer> {
        let (tx, rx) = oneshot::channel();
        self.asks
            .lock()
            .expect("permission asks poisoned")
            .insert(
                format!("{session_id}\u{0}{tool_call_id}"),
                PendingAsk { tx, mode },
            );
        rx
    }

    /// `permission_respond`: resolve the listed asks. Unknown ids no-op (the
    /// turn may have ended). `new_mode` escalates the ask's owning mode cell
    /// — the child's for sub-agent asks (contained), the session's active
    /// turn for root asks. Returns whether an ask was actually resolved.
    pub fn resolve_ask(
        &self,
        session_id: &str,
        tool_call_id: &str,
        answer: PermissionAnswer,
        new_mode: Option<AutonomyMode>,
    ) -> bool {
        let key = format!("{session_id}\u{0}{tool_call_id}");
        // Release the asks lock before touching `active` (end_turn takes
        // active → asks; the reverse order here would deadlock).
        let pending = self.asks.lock().expect("permission asks poisoned").remove(&key);
        match pending {
            Some(pending) => {
                if let Some(mode) = new_mode {
                    match pending.mode {
                        Some(cell) => *cell.lock().expect("turn mode poisoned") = mode,
                        None => {
                            self.set_turn_mode(session_id, mode);
                        }
                    }
                }
                pending.tx.send(answer).is_ok()
            }
            None => false,
        }
    }

    /// Bump the Channel-forwarder generation — an old forwarder exits on its
    /// next message so a re-attached webview Channel takes over.
    pub fn next_channel_generation(&self) -> u64 {
        self.channel_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn channel_generation(&self) -> u64 {
        self.channel_generation.load(Ordering::SeqCst)
    }
}

/// Lazily-initialized hub holder for the Tauri command layer — commands are
/// async, so first use opens the db and spawns the sink inside the runtime.
pub struct ChatHubCell {
    inner: tokio::sync::OnceCell<Arc<ChatHub>>,
}

impl ChatHubCell {
    pub const fn new() -> Self {
        Self {
            inner: tokio::sync::OnceCell::const_new(),
        }
    }

    pub async fn get(&self, data_dir: &Path) -> Result<Arc<ChatHub>, String> {
        let hub = self
            .inner
            .get_or_try_init(|| async { ChatHub::open(data_dir) })
            .await?;
        Ok(Arc::clone(hub))
    }
}

impl Default for ChatHubCell {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub(name: &str) -> Arc<ChatHub> {
        let dir = tempfile::tempdir().unwrap();
        let hub = ChatHub::open(dir.path()).unwrap();
        // Keep the tempdir alive for the hub's lifetime via the db path's parent.
        let _ = name;
        hub
    }

    #[tokio::test]
    async fn one_turn_per_session() {
        let hub = hub("lock");
        let first = hub.begin_turn("s_1", AutonomyMode::Ask);
        assert!(first.is_ok());
        let err = hub.begin_turn("s_1", AutonomyMode::Ask).unwrap_err();
        assert!(err.contains("already active"));
        // A different session is unaffected.
        assert!(hub.begin_turn("s_2", AutonomyMode::Ask).is_ok());
        hub.end_turn("s_1");
        assert!(hub.begin_turn("s_1", AutonomyMode::Ask).is_ok());
    }

    #[tokio::test]
    async fn begin_turn_handle_sees_abort() {
        let hub = hub("abort");
        let handle = hub.begin_turn("s_1", AutonomyMode::Ask).unwrap();
        assert!(!handle.is_aborted());
        hub.abort_turn("s_1");
        assert!(handle.is_aborted());
        assert!(handle.tool_abort.is_aborted());
    }

    #[tokio::test]
    async fn mode_escalation_reaches_the_turn() {
        let hub = hub("mode");
        let handle = hub.begin_turn("s_1", AutonomyMode::Ask).unwrap();
        assert_eq!(handle.mode(), AutonomyMode::Ask);
        assert!(hub.set_turn_mode("s_1", AutonomyMode::Edit));
        assert_eq!(handle.mode(), AutonomyMode::Edit);
        assert!(!hub.set_turn_mode("s_ghost", AutonomyMode::FullAccess));
        hub.end_turn("s_1");
    }

    #[tokio::test]
    async fn ask_registry_resolves_once_and_end_turn_denies_pending() {
        let hub = hub("asks");
        hub.begin_turn("s_1", AutonomyMode::Ask).unwrap();

        let mut rx = hub.register_ask("s_1", "t_1");
        assert!(hub.resolve_ask(
            "s_1",
            "t_1",
            PermissionAnswer {
                approve: true,
                remember: false,
                    reason: None,
            },
            None,
        ));
        assert!(rx.try_recv().is_ok());
        // Second respond for the same id no-ops.
        assert!(!hub.resolve_ask(
            "s_1",
            "t_1",
            PermissionAnswer {
                approve: false,
                remember: false,
                reason: None,
            },
            None,
        ));

        let mut pending = hub.register_ask("s_1", "t_2");
        hub.end_turn("s_1");
        let answer = pending.try_recv().expect("end_turn denies pending asks");
        assert!(!answer.approve);
        assert!(answer.reason.unwrap().contains("Turn ended"));
    }

    /// Sub-agent asks ride the root session's id space but escalate only the
    /// child's private mode cell — the parent turn's mode is unreachable
    /// from a child card (children may never escalate the parent).
    #[tokio::test]
    async fn child_ask_escalation_never_reaches_the_parent_mode() {
        let hub = hub("child-ask");
        let parent = hub.begin_turn("s_root", AutonomyMode::Plan).unwrap();
        let child_mode = Arc::new(StdMutex::new(AutonomyMode::Plan));

        let mut rx = hub.register_ask_with_mode(
            "s_root",
            "t_child",
            Some(Arc::clone(&child_mode)),
        );
        assert!(hub.resolve_ask(
            "s_root",
            "t_child",
            PermissionAnswer {
                approve: true,
                remember: false,
                reason: None,
            },
            Some(AutonomyMode::Edit),
        ));
        assert!(rx.try_recv().unwrap().approve);
        assert_eq!(*child_mode.lock().unwrap(), AutonomyMode::Edit, "child escalated");
        assert_eq!(parent.mode(), AutonomyMode::Plan, "parent unchanged");

        // Root asks escalate the session's active turn as before.
        let mut rx = hub.register_ask("s_root", "t_root");
        assert!(hub.resolve_ask(
            "s_root",
            "t_root",
            PermissionAnswer {
                approve: true,
                remember: false,
                reason: None,
            },
            Some(AutonomyMode::FullAccess),
        ));
        assert!(rx.try_recv().unwrap().approve);
        assert_eq!(parent.mode(), AutonomyMode::FullAccess);
    }
}
