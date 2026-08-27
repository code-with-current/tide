//! Terminal domain runtime — port of `91ec558:app/platform/pty.ts` (the
//! session-manager half; the backend seam is portable-pty instead of
//! Bun's terminal API / node-pty) plus the coalescer batching that fed it.
//! One registry owns every live PTY keyed by terminal id:
//!
//! - output flows reader-thread → per-terminal coalescer task (16ms / 512
//!   item batches — one joined push per flush) → scrollback append (monotonic
//!   seq) → `terminalOutput` push → dev-server port scan;
//! - exit drains the reader first, then flushes pending output and pushes
//!   `terminalExit` (plus a ports clear) — kill drops pending output and
//!   suppresses the exit push entirely (replacement safety: flushing would
//!   bleed the old generation into a same-id respawn);
//! - terminals stay ALIVE across agent turns — nothing here is tied to the
//!   turn loop; only terminalKill/terminalStop/terminalDispose (app quit)
//!   tear them down. The background-shell registry is a separate domain.
//!
//! Pushes ride the ChatHub's broadcast bus tagged `terminalOutput` /
//! `terminalExit` / `terminalPorts` (the old webview message names), so the
//! single `chat_attach_channel` Channel forwarder delivers them to the
//! renderer's setTerminal*Callback seams.

pub mod ports;
pub mod scrollback;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::agent::events::ChatPush;
use crate::commands::misc::is_process_alive;

use ports::{TrackedPort, TrackedPorts, ports_snapshot, resolve_port_pid, scan_ports};
use scrollback::ScrollbackBuffer;

/// Main-side scrollback cap per terminal (chars) — the TS default.
pub const SCROLLBACK_CHARS: usize = 512 * 1024;

// ── pure helpers (pty.ts) ───────────────────────────────────────────────────

/// User shell resolution: `$SHELL` (win32: `%COMSPEC%`/powershell), platform
/// fallback, POSIX shells spawn interactive (`-i`).
pub fn get_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        let comspec = std::env::var("COMSPEC")
            .ok()
            .filter(|s| !s.is_empty());
        (
            comspec.unwrap_or_else(|| "powershell.exe".into()),
            Vec::new(),
        )
    } else {
        let fallback = if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/bash"
        };
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty());
        (shell.unwrap_or_else(|| fallback.into()), vec!["-i".to_owned()])
    }
}

/// Provisional size from the renderer's font metrics (avoids the 80x24 spawn
/// flash); bounded to keep a hostile/misread metric from poisoning the pty.
pub fn clamp_pty_size(cols: Option<u16>, rows: Option<u16>) -> (u16, u16) {
    (cols.unwrap_or(80).clamp(2, 1000), rows.unwrap_or(24).clamp(1, 500))
}

/// Host-private environment variables that must never leak into PTY shells
/// (the Electron-era list, kept verbatim — see pty.ts for the rationale).
const STRIP_ENV: [&str; 7] = [
    "ARGV0",
    "NODE_CHANNEL_FD",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ATTACH_CONSOLE",
    "BASH_ENV",
    "ENV",
    "BASH_XTRACEFD",
];

pub fn sanitize_pty_env(
    env: impl IntoIterator<Item = (String, String)>,
) -> HashMap<String, String> {
    env.into_iter()
        .filter(|(key, _)| {
            !STRIP_ENV.contains(&key.as_str())
                && !key.starts_with("ELECTROBUN_")
                && !key.starts_with("HUTCH_")
        })
        .collect()
}

// ── registry ────────────────────────────────────────────────────────────────

/// What the reader/exit threads and the command surface feed into the
/// per-terminal coalescer task. `Flush` is the scrollback snapshot's
/// drain-now request (the ack returns once the buffer has been delivered).
enum Feed {
    Data(String),
    Exit(Option<i32>),
    Flush(oneshot::Sender<()>),
}

/// State shared by the coalescer task, the port reaper, and the entry.
struct TerminalShared {
    scrollback: StdMutex<ScrollbackBuffer>,
    ports: StdMutex<TrackedPorts>,
    alive: AtomicBool,
}

struct TerminalEntry {
    shared: Arc<TerminalShared>,
    writer: StdMutex<Box<dyn Write + Send>>,
    master: StdMutex<Box<dyn MasterPty>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    tx: mpsc::UnboundedSender<Feed>,
}

/// The cloneable heart of the registry — the coalescer and reaper tasks hold
/// one so they can outlive any single command invocation.
#[derive(Clone)]
struct RegistryCore {
    push: broadcast::Sender<ChatPush>,
    inner: Arc<StdMutex<HashMap<String, TerminalEntry>>>,
    reaper_running: Arc<AtomicBool>,
    scrollback_chars: usize,
}

pub struct TerminalRegistry {
    core: RegistryCore,
}

pub struct SpawnRequest {
    pub id: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

impl TerminalRegistry {
    /// Build the shared registry over the process-wide push bus.
    pub fn shared(push: broadcast::Sender<ChatPush>) -> Arc<Self> {
        Arc::new(Self::with_scrollback(push, SCROLLBACK_CHARS))
    }

    pub fn with_scrollback(push: broadcast::Sender<ChatPush>, scrollback_chars: usize) -> Self {
        Self {
            core: RegistryCore {
                push,
                inner: Arc::new(StdMutex::new(HashMap::new())),
                reaper_running: Arc::new(AtomicBool::new(false)),
                scrollback_chars,
            },
        }
    }

    /// Spawn the user's shell (terminalCreate's production path).
    pub fn spawn_shell(&self, id: &str, cwd: &Path, cols: Option<u16>, rows: Option<u16>) -> bool {
        let (cmd, args) = get_shell();
        let (cols, rows) = clamp_pty_size(cols, rows);
        self.spawn(SpawnRequest {
            id: id.to_owned(),
            cmd,
            args,
            cwd: cwd.to_owned(),
            env: sanitize_pty_env(std::env::vars()),
            cols,
            rows,
        })
    }

    /// Spawn a session under `id`, replacing (and killing) any existing one.
    /// False when the pty cannot spawn.
    pub fn spawn(&self, req: SpawnRequest) -> bool {
        self.kill(&req.id);
        let pty_system = native_pty_system();
        let pair = match pty_system.openpty(PtySize {
            rows: req.rows,
            cols: req.cols,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(pair) => pair,
            Err(err) => {
                eprintln!("[tide] pty open failed for {}: {err}", req.id);
                return false;
            }
        };
        let mut cmd = CommandBuilder::new(&req.cmd);
        cmd.args(&req.args);
        cmd.cwd(&req.cwd);
        cmd.env_clear();
        let mut saw_term = false;
        for (key, value) in &req.env {
            saw_term |= key == "TERM";
            cmd.env(key, value);
        }
        if !saw_term {
            cmd.env("TERM", "xterm-256color");
        }
        let mut child = match pair.slave.spawn_command(cmd) {
            Ok(child) => child,
            Err(err) => {
                eprintln!("[tide] pty spawn failed for {}: {err}", req.id);
                return false;
            }
        };
        // Hand the slave off to the child — the master is ours alone.
        drop(pair.slave);
        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(err) => {
                eprintln!("[tide] pty reader clone failed for {}: {err}", req.id);
                return false;
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(err) => {
                eprintln!("[tide] pty writer take failed for {}: {err}", req.id);
                return false;
            }
        };

        let shared = Arc::new(TerminalShared {
            scrollback: StdMutex::new(ScrollbackBuffer::new(self.core.scrollback_chars)),
            ports: StdMutex::new(TrackedPorts::new()),
            alive: AtomicBool::new(true),
        });
        let (tx, rx) = mpsc::unbounded_channel();

        // Reader thread: blocking master reads, one lossy-UTF-8 String per
        // chunk (Bun's TextDecoder had the same per-chunk decode semantics).
        let reader_tx = tx.clone();
        let (drained_tx, drained_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                        if reader_tx.send(Feed::Data(chunk)).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = drained_tx.send(());
        });

        // Exit watcher: wait() for the child, then give the reader a brief
        // window to drain the pty's remaining output before queueing Exit on
        // the same channel — data always precedes exit downstream.
        let wait_tx = tx.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|status| {
                // A signalled death has no honest exit number — null it.
                if status.signal().is_some() {
                    None
                } else {
                    Some(status.exit_code() as i32)
                }
            });
            let _ = drained_rx.recv_timeout(Duration::from_millis(300));
            let _ = wait_tx.send(Feed::Exit(code));
        });

        let core = self.core.clone();
        let task_id = req.id.clone();
        let task_shared = Arc::clone(&shared);
        tokio::spawn(feed_task(core, task_id, task_shared, rx));

        eprintln!(
            "[tide] started PTY {} pid={pid:?} cwd={}",
            req.id,
            req.cwd.display()
        );
        self.core.inner.lock().expect("terminals poisoned").insert(
            req.id.clone(),
            TerminalEntry {
                shared,
                writer: StdMutex::new(writer),
                master: StdMutex::new(pair.master),
                killer,
                pid,
                tx,
            },
        );
        true
    }

    pub fn write(&self, id: &str, data: &str) {
        core_write(&self.core, id, data);
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        let Ok(inner) = self.core.inner.lock() else { return };
        let Some(entry) = inner.get(id) else { return };
        let Ok(master) = entry.master.lock() else { return };
        let _ = master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    pub fn pid_of(&self, id: &str) -> Option<u32> {
        self.core.inner.lock().ok()?.get(id)?.pid
    }

    /// Kill the session and DROP pending output (the alive flag suppresses
    /// the coalescer's flush and the exit push — a killed terminal just
    /// disappears from the renderer, exactly like the TS backend).
    pub fn kill(&self, id: &str) {
        let entry = match self.core.inner.lock() {
            Ok(mut inner) => inner.remove(id),
            Err(_) => return,
        };
        let Some(mut entry) = entry else { return };
        // Flip alive BEFORE kill so the exit watcher's Exit item is ignored.
        entry.shared.alive.store(false, Ordering::SeqCst);
        let _ = entry.killer.kill();
        drop(entry);
    }

    pub fn dispose(&self) {
        let ids: Vec<String> = self
            .core
            .inner
            .lock()
            .map(|inner| inner.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.kill(&id);
        }
    }

    /// Stop the terminal's foreground process: Ctrl+C (\x03) twice (SIGINT
    /// reaches the foreground group, not the shell's), then escalate to a
    /// tree-kill after ~1.2s if it survives. The shell stays alive, so ports
    /// are cleared explicitly here.
    pub fn stop(&self, id: &str) {
        self.clear_ports(id);
        let pid = self.pid_of(id);
        self.write(id, "\x03");
        let core = self.core.clone();
        let stop_id = id.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            core_write(&core, &stop_id, "\x03");
            tokio::time::sleep(Duration::from_millis(1000)).await;
            let Some(pid) = pid else { return };
            if pid == 0 || !is_process_alive(pid as i64) {
                return; // already gone — Ctrl+C worked
            }
            if cfg!(windows) {
                let _ = std::process::Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
            } else {
                // pkill -P finds direct children of the shell; SIGKILL each.
                // The shell itself is left alive (only its descendants die).
                let _ = std::process::Command::new("pkill")
                    .args(["-KILL", "-P", &pid.to_string()])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
            }
        });
    }

    fn clear_ports(&self, id: &str) {
        let Ok(inner) = self.core.inner.lock() else { return };
        let Some(entry) = inner.get(id) else { return };
        let mut ports = entry.shared.ports.lock().expect("ports poisoned");
        if ports.is_empty() {
            return;
        }
        ports.clear();
        drop(ports);
        let _ = self.core.push.send(ChatPush::TerminalPorts {
            terminal_id: id.to_owned(),
            ports: Vec::new(),
        });
    }

    /// Snapshot re-attach: flush the coalescer first (so a reconnecting
    /// renderer neither misses nor double-receives output — seq-per-batch
    /// covers everything appended before the flush), then return the buffered
    /// scrollback. `None` means no PTY — the caller spawns a fresh one.
    pub async fn scrollback(&self, id: &str) -> Option<scrollback::ScrollbackSnapshot> {
        let (ack_tx, ack_rx) = oneshot::channel();
        {
            let inner = self.core.inner.lock().expect("terminals poisoned");
            let entry = inner.get(id)?;
            entry.tx.send(Feed::Flush(ack_tx)).ok()?;
        }
        let _ = ack_rx.await;
        let inner = self.core.inner.lock().expect("terminals poisoned");
        let entry = inner.get(id)?;
        let snap = entry
            .shared
            .scrollback
            .lock()
            .expect("scrollback poisoned")
            .snapshot();
        Some(snap)
    }
}

fn core_write(core: &RegistryCore, id: &str, data: &str) {
    let Ok(inner) = core.inner.lock() else { return };
    let Some(entry) = inner.get(id) else { return };
    let Ok(mut writer) = entry.writer.lock() else { return };
    let _ = writer.write_all(data.as_bytes());
    let _ = writer.flush();
}

// ── coalescer task ──────────────────────────────────────────────────────────

/// Coalesce reader chunks: one delivery per flush with the batch joined,
/// flushed every 16ms (or immediately at 512 buffered items) — the batching
/// contract the old `createCoalescer` gave the RPC layer. Kill semantics:
/// channel close or a post-kill Exit drops the buffer undelivered.
async fn feed_task(
    core: RegistryCore,
    id: String,
    shared: Arc<TerminalShared>,
    mut rx: mpsc::UnboundedReceiver<Feed>,
) {
    const MAX_ITEMS: usize = 512;
    const INTERVAL: Duration = Duration::from_millis(16);
    let mut buf: Vec<String> = Vec::new();
    let mut deadline: Option<tokio::time::Instant> = None;

    fn deliver(core: &RegistryCore, id: &str, shared: &Arc<TerminalShared>, buf: &mut Vec<String>) {
        if !buf.is_empty() && shared.alive.load(Ordering::SeqCst) {
            handle_output(core, id, shared, &buf.concat());
        }
        buf.clear();
    }

    loop {
        let item = match deadline {
            Some(at) => tokio::select! {
                biased;
                item = rx.recv() => item,
                _ = tokio::time::sleep_until(at) => {
                    deliver(&core, &id, &shared, &mut buf);
                    deadline = None;
                    continue;
                }
            },
            None => rx.recv().await,
        };
        match item {
            // All senders dropped (post-kill drain) — exit silently.
            None => break,
            Some(Feed::Data(chunk)) => {
                buf.push(chunk);
                if buf.len() >= MAX_ITEMS {
                    deliver(&core, &id, &shared, &mut buf);
                    deadline = None;
                } else if deadline.is_none() {
                    deadline = Some(tokio::time::Instant::now() + INTERVAL);
                }
            }
            Some(Feed::Flush(ack)) => {
                deliver(&core, &id, &shared, &mut buf);
                deadline = None;
                let _ = ack.send(());
            }
            Some(Feed::Exit(code)) => {
                // Deliver pending output first (while still alive — the
                // deliver guard suppresses post-kill output) so exit
                // ordering holds downstream.
                deliver(&core, &id, &shared, &mut buf);
                if shared.alive.load(Ordering::SeqCst) {
                    handle_exit(&core, &id, &shared, code);
                }
                break;
            }
        }
    }
}

/// Append to scrollback, push `terminalOutput`, and scan for fresh
/// dev-server ports (emitting `terminalPorts` when the set grew).
fn handle_output(core: &RegistryCore, id: &str, shared: &Arc<TerminalShared>, data: &str) {
    let seq = shared
        .scrollback
        .lock()
        .expect("scrollback poisoned")
        .append(data);
    let _ = core.push.send(ChatPush::TerminalOutput {
        terminal_id: id.to_owned(),
        data: data.to_owned(),
        seq,
    });
    let fresh: Vec<u16> = scan_ports(data)
        .into_iter()
        .filter(|p| !shared.ports.lock().expect("ports poisoned").contains_key(p))
        .collect();
    if fresh.is_empty() {
        return;
    }
    for port in &fresh {
        shared
            .ports
            .lock()
            .expect("ports poisoned")
            .insert(*port, TrackedPort { pid: None, misses: 0 });
    }
    for port in fresh {
        // Resolve the owning pid async — the chip renders immediately, the
        // association lands when lsof answers.
        let task_shared = Arc::clone(shared);
        tokio::spawn(async move {
            if let Some(pid) = resolve_port_pid(port).await {
                if let Some(tracked) = task_shared
                    .ports
                    .lock()
                    .expect("ports poisoned")
                    .get_mut(&port)
                {
                    if tracked.pid.is_none() {
                        tracked.pid = Some(pid);
                    }
                }
            }
        });
    }
    start_reaper_if_needed(core);
    let snapshot = ports_snapshot(&shared.ports.lock().expect("ports poisoned"));
    let _ = core.push.send(ChatPush::TerminalPorts {
        terminal_id: id.to_owned(),
        ports: snapshot,
    });
}

/// Natural exit: drop the entry, clear the port chips (the dev server is
/// gone — links should disappear rather than point at a dead process), and
/// push `terminalExit`.
fn handle_exit(core: &RegistryCore, id: &str, shared: &TerminalShared, code: Option<i32>) {
    core.inner.lock().expect("terminals poisoned").remove(id);
    shared.ports.lock().expect("ports poisoned").clear();
    let _ = core.push.send(ChatPush::TerminalPorts {
        terminal_id: id.to_owned(),
        ports: Vec::new(),
    });
    let _ = core.push.send(ChatPush::TerminalExit {
        terminal_id: id.to_owned(),
        code,
    });
}

// ── port liveness reaper ────────────────────────────────────────────────────

/// The shell outlives the foreground dev server, so output scanning alone
/// never learns that the server died. This periodic check ties each port
/// chip to its owning process: when the pid is gone or nothing accepts
/// connections, the port is dropped and the renderer's indicator disappears.
/// Self-terminates once no terminal tracks any port (restarts on demand).
fn start_reaper_if_needed(core: &RegistryCore) {
    if core.reaper_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let core = core.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            reap_dead_ports(&core).await;
            let idle = core
                .inner
                .lock()
                .expect("terminals poisoned")
                .values()
                .all(|entry| entry.shared.ports.lock().expect("ports poisoned").is_empty());
            if idle {
                core.reaper_running.store(false, Ordering::SeqCst);
                break;
            }
        }
    });
}

async fn reap_dead_ports(core: &RegistryCore) {
    const PORT_REAP_AFTER_MISSES: u32 = 2;
    let live: Vec<(String, Arc<TerminalShared>)> = core
        .inner
        .lock()
        .expect("terminals poisoned")
        .iter()
        .filter(|(_, entry)| !entry.shared.ports.lock().expect("ports poisoned").is_empty())
        .map(|(id, entry)| (id.clone(), Arc::clone(&entry.shared)))
        .collect();
    for (id, shared) in live {
        let mut changed = false;
        let ports: Vec<u16> = shared
            .ports
            .lock()
            .expect("ports poisoned")
            .keys()
            .copied()
            .collect();
        for port in ports {
            let tracked = *shared
                .ports
                .lock()
                .expect("ports poisoned")
                .get(&port)
                .expect("port vanished mid-reap");
            let alive = ports::port_is_alive(&tracked, port).await;
            let mut ports = shared.ports.lock().expect("ports poisoned");
            if alive {
                if let Some(tracked) = ports.get_mut(&port) {
                    tracked.misses = 0;
                }
                continue;
            }
            let misses = tracked.misses + 1;
            if misses >= PORT_REAP_AFTER_MISSES {
                eprintln!("[tide] port owner gone — clearing indicator: terminal={id} port={port}");
                ports.remove(&port);
                changed = true;
            } else if let Some(tracked) = ports.get_mut(&port) {
                tracked.misses = misses;
            }
        }
        if changed && core.inner.lock().expect("terminals poisoned").contains_key(&id) {
            let snapshot = ports_snapshot(&shared.ports.lock().expect("ports poisoned"));
            let _ = core.push.send(ChatPush::TerminalPorts {
                terminal_id: id,
                ports: snapshot,
            });
        }
    }
}

// ── lazy cell for the command layer ─────────────────────────────────────────

/// Lazily-initialized registry holder — commands are async, so first use
/// builds it over the ChatHub's push bus inside the runtime.
pub struct TerminalCell {
    inner: tokio::sync::OnceCell<Arc<TerminalRegistry>>,
}

impl TerminalCell {
    pub const fn new() -> Self {
        Self {
            inner: tokio::sync::OnceCell::const_new(),
        }
    }

    pub async fn get(
        &self,
        push: broadcast::Sender<ChatPush>,
    ) -> Arc<TerminalRegistry> {
        let registry = self
            .inner
            .get_or_init(|| async move { TerminalRegistry::shared(push) })
            .await;
        Arc::clone(registry)
    }
}

impl Default for TerminalCell {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::ChatPush;
    use std::time::Instant;

    fn test_registry() -> (Arc<TerminalRegistry>, broadcast::Receiver<ChatPush>) {
        let (push, rx) = broadcast::channel(256);
        (TerminalRegistry::shared(push), rx)
    }

    fn sh_req(id: &str, script: &str, cwd: &Path) -> SpawnRequest {
        SpawnRequest {
            id: id.to_owned(),
            cmd: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: cwd.to_owned(),
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        }
    }

    async fn next_push(
        rx: &mut broadcast::Receiver<ChatPush>,
        matches: impl Fn(&ChatPush) -> bool,
        timeout_ms: u64,
        what: &str,
    ) -> ChatPush {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for {what}");
            let push = tokio::time::timeout(remaining, rx.recv())
                .await
                .expect("recv timed out")
                .expect("push channel open");
            if matches(&push) {
                return push;
            }
        }
    }

    #[test]
    fn clamp_bounds_match_the_ts_limits() {
        assert_eq!(clamp_pty_size(None, None), (80, 24));
        assert_eq!(clamp_pty_size(Some(1), Some(0)), (2, 1));
        assert_eq!(clamp_pty_size(Some(5000), Some(1000)), (1000, 500));
    }

    #[test]
    fn sanitize_strips_private_and_prefixed_env() {
        let env = sanitize_pty_env([
            ("PATH".to_owned(), "/bin".to_owned()),
            ("ARGV0".to_owned(), "evil".to_owned()),
            ("ENV".to_owned(), "/etc/oops".to_owned()),
            ("BASH_ENV".to_owned(), "/etc/oops".to_owned()),
            ("ELECTROBUN_SECRET".to_owned(), "1".to_owned()),
            ("HUTCH_ID".to_owned(), "1".to_owned()),
            ("TERM".to_owned(), "xterm".to_owned()),
        ]);
        assert_eq!(env.len(), 2);
        assert!(env.contains_key("PATH"));
        assert!(env.contains_key("TERM"));
    }

    #[test]
    fn shell_resolution_prefers_shell_env() {
        // get_shell reads the ambient env — assert the shape, not the host's
        // exact SHELL value.
        let (cmd, args) = get_shell();
        if cfg!(windows) {
            assert!(args.is_empty());
        } else {
            assert_eq!(args, vec!["-i".to_owned()]);
            assert!(cmd.starts_with('/'), "posix shell is an absolute path: {cmd}");
        }
    }

    #[tokio::test]
    async fn echo_pushes_output_scrollback_then_exit() {
        let (registry, mut rx) = test_registry();
        let cwd = tempfile::tempdir().unwrap();
        assert!(registry.spawn(sh_req("t1", "echo hello; sleep 1", cwd.path())));

        let output = next_push(
            &mut rx,
            |p| matches!(p, ChatPush::TerminalOutput { data, .. } if data.contains("hello")),
            5000,
            "echo output",
        )
        .await;
        let seen_seq = match &output {
            ChatPush::TerminalOutput { terminal_id, data, seq } => {
                assert_eq!(terminal_id, "t1");
                assert!(data.contains("hello"));
                *seq
            }
            _ => unreachable!(),
        };

        // Snapshot mid-flight: alive with the buffered output and a seq that
        // covers everything pushed so far.
        let snap = registry.scrollback("t1").await.expect("alive");
        assert!(snap.data.contains("hello"));
        assert!(snap.seq >= seen_seq);

        let exit = next_push(
            &mut rx,
            |p| matches!(p, ChatPush::TerminalExit { .. }),
            5000,
            "echo exit",
        )
        .await;
        match exit {
            ChatPush::TerminalExit { terminal_id, code } => {
                assert_eq!(terminal_id, "t1");
                assert_eq!(code, Some(0));
            }
            _ => unreachable!(),
        }

        // Exit pushed a ports clear first, and the entry is gone.
        assert_eq!(registry.pid_of("t1"), None);
        assert!(registry.scrollback("t1").await.is_none());
    }

    #[tokio::test]
    async fn write_round_trips_through_the_pty() {
        let (registry, mut rx) = test_registry();
        let cwd = tempfile::tempdir().unwrap();
        assert!(registry.spawn(sh_req("t2", "cat", cwd.path())));

        tokio::time::sleep(Duration::from_millis(100)).await;
        registry.write("t2", "ping\n");
        next_push(
            &mut rx,
            |p| matches!(p, ChatPush::TerminalOutput { data, .. } if data.contains("ping")),
            5000,
            "cat echo",
        )
        .await;
        registry.kill("t2");
    }

    #[tokio::test]
    async fn kill_suppresses_the_exit_push_and_drops_pending_output() {
        let (registry, mut rx) = test_registry();
        let cwd = tempfile::tempdir().unwrap();
        assert!(registry.spawn(sh_req("t3", "sleep 30", cwd.path())));
        let pid = registry.pid_of("t3").expect("pid while alive");

        tokio::time::sleep(Duration::from_millis(100)).await;
        registry.kill("t3");
        assert_eq!(registry.pid_of("t3"), None);

        let drained = tokio::time::timeout(Duration::from_millis(250), rx.recv()).await;
        if let Ok(Ok(push)) = drained {
            assert!(
                !matches!(push, ChatPush::TerminalExit { .. }),
                "kill must not push exit"
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!is_process_alive(pid as i64));
    }

    #[tokio::test]
    async fn resize_reaches_the_child() {
        let (registry, mut rx) = test_registry();
        let cwd = tempfile::tempdir().unwrap();
        assert!(registry.spawn(sh_req("t4", "sleep 0.4; stty size", cwd.path())));
        registry.resize("t4", 100, 40);

        let output = next_push(
            &mut rx,
            |p| matches!(p, ChatPush::TerminalOutput { data, .. } if data.contains("40 100")),
            5000,
            "stty size after resize",
        )
        .await;
        match output {
            ChatPush::TerminalOutput { data, .. } => assert!(data.contains("40 100")),
            _ => unreachable!(),
        }
        next_push(&mut rx, |p| matches!(p, ChatPush::TerminalExit { .. }), 5000, "stty exit").await;
    }

    #[tokio::test]
    async fn crafted_output_pushes_detected_ports() {
        let (registry, mut rx) = test_registry();
        let cwd = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let script = format!("echo 'ready on http://localhost:{port}'; sleep 1");
        assert!(registry.spawn(sh_req("t5", &script, cwd.path())));

        let ports_push = next_push(
            &mut rx,
            |p| matches!(p, ChatPush::TerminalPorts { .. }),
            5000,
            "ports push",
        )
        .await;
        match ports_push {
            ChatPush::TerminalPorts { terminal_id, ports } => {
                assert_eq!(terminal_id, "t5");
                assert_eq!(ports.len(), 1);
                assert_eq!(ports[0].port, port);
                assert_eq!(ports[0].label, "Dev server");
            }
            _ => unreachable!(),
        }
        next_push(&mut rx, |p| matches!(p, ChatPush::TerminalExit { .. }), 5000, "ports exit").await;
    }

    #[tokio::test]
    async fn stop_interrupts_the_foreground_process() {
        let (registry, mut rx) = test_registry();
        let cwd = tempfile::tempdir().unwrap();
        assert!(registry.spawn(sh_req("t6", "sleep 30", cwd.path())));

        tokio::time::sleep(Duration::from_millis(100)).await;
        registry.stop("t6");
        next_push(
            &mut rx,
            |p| matches!(p, ChatPush::TerminalExit { .. }),
            4000,
            "stop-driven exit (ctrl+c then escalation)",
        )
        .await;
        registry.kill("t6");
    }

    #[tokio::test]
    async fn spawning_the_same_id_replaces_the_old_pty() {
        let (registry, _rx) = test_registry();
        let cwd = tempfile::tempdir().unwrap();
        assert!(registry.spawn(sh_req("t7", "sleep 30", cwd.path())));
        let first_pid = registry.pid_of("t7").expect("first pid");

        assert!(registry.spawn(sh_req("t7", "sleep 30", cwd.path())));
        let second_pid = registry.pid_of("t7").expect("second pid");
        assert_ne!(first_pid, second_pid);
        registry.kill("t7");
    }
}
