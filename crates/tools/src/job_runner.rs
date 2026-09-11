//! job_runner — the out-of-process background-job host.
//!
//! Process jobs normally run as direct children of the app process: their
//! pipes terminate in it, their exit watchers are its threads, and (since
//! the backend moved in-process) their parentage shows up under the GUI
//! binary in every process monitor. A heavy job therefore taxes the app
//! twice — scheduling contention from unthrottled CPU burn, and pipe and
//! reader bookkeeping in the same heap the UI allocates from.
//!
//! This module moves that process half into a dedicated runner process:
//! the same `tide` binary re-invoked with `--job-runner`. The runner owns
//! the children (each in its own process group, spawned at nice 10 so the
//! app's threads win scheduling under load), appends their output to a
//! temp file, and streams deltas to the app over a unix socket. Because
//! the file — not an in-memory pipe — is the buffer, a stalled or dead
//! app cannot grow runner memory, and a job survives an app crash: on
//! reconnect the runner replays each live job's tail and the app
//! re-registers it under its old id.
//!
//! Failure story: when runner mode is off (tests, embedders) or the
//! runner cannot be spawned, [`spawn_bash_job`] falls back to the
//! in-process guard in [`crate::shell_registry`] — the pre-runner
//! behavior, verbatim.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Opt the embedding app into runner mode. When unset, background jobs
/// always take the in-process fallback — tests and un-adapted embedders
/// keep today's behavior, and a spawned helper can never re-enter an
/// arbitrary `current_exe()` that does not dispatch `--job-runner`.
pub fn enable_runner_mode() {
    RUNNER_MODE.store(true, Ordering::SeqCst);
}

fn runner_mode_enabled() -> bool {
    RUNNER_MODE.load(Ordering::SeqCst)
}

static RUNNER_MODE: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
    use std::os::fd::AsRawFd as _;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::ExitStatusExt as _;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use serde::{Deserialize, Serialize};

    use crate::jobs::{
        global_job_registry, JobDone, JobHandle, JobHooks, JobOutcome, JobOutputSink, JobStart,
        SettledStatus,
    };

    // ---------------------------------------------------------------- --
    // Protocol (newline-delimited JSON over the unix socket)
    // ---------------------------------------------------------------- --

    #[derive(Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum ClientMessage {
        /// First message on every connection. `known` lists job ids the
        /// client already holds (a reconnecting app) — the runner skips
        /// the file-tail replay for those, so a resumed ring is never
        /// duplicated.
        Hello { known: Vec<String> },
        Start {
            id: String,
            command: String,
            cwd: String,
        },
        Kill { id: String },
    }

    #[derive(Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum RunnerMessage {
        Welcome { jobs: Vec<LiveJob> },
        Started { id: String },
        StartFailed { id: String, reason: String },
        Output { id: String, delta: String },
        Exit {
            id: String,
            code: Option<i32>,
            terminated: bool,
        },
    }

    #[derive(Serialize, Deserialize, Clone)]
    struct LiveJob {
        id: String,
        label: String,
    }

    fn send_line<W: Write, M: Serialize>(writer: &mut W, message: &M) -> std::io::Result<()> {
        let mut line = serde_json::to_string(message).map_err(std::io::Error::other)?;
        line.push('\n');
        writer.write_all(line.as_bytes())
    }

    /// Parse one newline-delimited JSON message. Generic over the message
    /// type: the server side parses `ClientMessage`s, the client side
    /// `RunnerMessage`s.
    fn read_line<M: serde::de::DeserializeOwned, R: BufRead>(
        reader: &mut R,
    ) -> std::io::Result<Option<M>> {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        serde_json::from_str(&line)
            .map(Some)
            .map_err(std::io::Error::other)
    }

    // ---------------------------------------------------------------- --
    // Paths
    // ------------------------------------------------------------------

    fn sanitize(component: &str) -> String {
        component
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect()
    }

    fn socket_path(session: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tide-job-runner-{}.sock", sanitize(session)))
    }

    fn jobs_dir(session: &str) -> PathBuf {
        std::env::temp_dir()
            .join("tide-job-files")
            .join(sanitize(session))
    }

    /// Run the child at nice 10 so a saturated build still yields the CPU
    /// to the app's threads (the whole point of the runner). Inherited by
    /// every descendant — cargo, rustc, test binaries.
    fn nice_child(cmd: &mut std::process::Command) {
        use std::os::unix::process::CommandExt as _;
        unsafe {
            cmd.pre_exec(|| {
                // Best effort: failing to renice must not fail the spawn.
                let _ = libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                Ok(())
            });
        }
    }

    // ---------------------------------------------------------------- --
    // Server (the `--job-runner` mode)
    // ------------------------------------------------------------------

    /// Disk guard only — the model-facing ring still keeps a rolling
    /// tail, so deltas keep flowing past this; the file just stops
    /// growing.
    const FILE_CAP_BYTES: u64 = 8 * 1024 * 1024;
    /// What a reconnecting client gets for a live job: the ring holds the
    /// newest 256 KB, so replaying the file's last 256 KB reconstructs it.
    const REPLAY_TAIL_BYTES: u64 = 256 * 1024;
    /// Idle shutdown: no client, no live jobs, this long since the last
    /// client left. A runner orphaned by an app crash stays alive while
    /// any job runs, then tidies itself up.
    const IDLE_EXIT: Duration = Duration::from_secs(60);

    struct ServerJob {
        pid: u32,
        label: String,
        file: Mutex<std::fs::File>,
        written: Arc<AtomicU64>,
        terminated: AtomicBool,
    }

    /// One connected app, addressed by generation: a replacement
    /// connection shuts the predecessor's socket down (unblocking its
    /// reader) instead of racing it for the slot.
    struct ClientSlot {
        generation: u64,
        lines: std::sync::mpsc::SyncSender<String>,
        fd: std::os::fd::RawFd,
    }

    struct ServerState {
        data_dir: PathBuf,
        jobs: Mutex<HashMap<String, Arc<ServerJob>>>,
        client: Mutex<Option<ClientSlot>>,
        next_generation: AtomicU64,
        /// When the runner last had neither client nor jobs — the idle
        /// watchdog's clock.
        empty_since: Mutex<Option<Instant>>,
    }

    impl ServerState {
        fn install_client(&self, lines: std::sync::mpsc::SyncSender<String>, fd: i32) -> u64 {
            let generation = self.next_generation.fetch_add(1, Ordering::SeqCst);
            let mut slot = self.client.lock().unwrap();
            // Evict: dropping the old sender ends its writer loop, and
            // shutting the fd down unblocks its reader.
            if let Some(previous) = slot.take() {
                unsafe {
                    libc::shutdown(previous.fd, libc::SHUT_RDWR);
                }
            }
            *slot = Some(ClientSlot {
                generation,
                lines,
                fd,
            });
            *self.empty_since.lock().unwrap() = None;
            generation
        }

        /// Clear the slot only if it is still ours (a newer connection
        /// may have replaced us mid-flight).
        fn evict_client(&self, generation: u64) {
            let mut slot = self.client.lock().unwrap();
            if slot.as_ref().is_some_and(|s| s.generation == generation) {
                *slot = None;
                *self.empty_since.lock().unwrap() = Some(Instant::now());
            }
        }

        fn client_send(&self, message: &RunnerMessage) {
            let Ok(line) = serde_json::to_string(message) else {
                return;
            };
            let sender = self.client.lock().unwrap().as_ref().map(|s| s.lines.clone());
            if let Some(sender) = sender {
                // Backpressure lands here: a slow app blocks the pump,
                // the pump's pipe fills, the child blocks — the file, not
                // the runner's heap, absorbs the difference.
                let _ = sender.send(line);
            }
        }

        fn note_job_gone(&self) {
            if self.jobs.lock().unwrap().is_empty() {
                *self.empty_since.lock().unwrap() = Some(Instant::now());
            }
        }
    }

    /// Entry point for the binary: consume `--job-runner <socket> <dir>`
    /// from argv. Returns false when the arguments are not the runner's,
    /// leaving the caller (the GUI main) untouched.
    pub fn main_if_requested() -> bool {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.first().map(String::as_str) != Some("--job-runner") {
            return false;
        }
        let (Some(socket), Some(data_dir), None) = (args.get(1).cloned(), args.get(2).cloned(), args.get(3)) else {
            eprintln!("usage: --job-runner <socket-path> <data-dir>");
            std::process::exit(2);
        };
        if let Err(error) = serve(Path::new(&socket), Path::new(&data_dir)) {
            eprintln!("job runner: {error}");
            std::process::exit(1);
        }
        true
    }

    fn serve(socket: &Path, data_dir: &Path) -> std::io::Result<()> {
        serve_inner(socket, data_dir, true)
    }

    /// `watchdog=false` keeps an in-process test server from
    /// `std::process::exit`ing the whole test binary during an idle
    /// stretch between tests.
    fn serve_inner(socket: &Path, data_dir: &Path, watchdog: bool) -> std::io::Result<()> {
        std::fs::create_dir_all(data_dir)?;
        let _ = std::fs::remove_file(socket);
        let listener = std::os::unix::net::UnixListener::bind(socket)?;
        let state = Arc::new(ServerState {
            data_dir: data_dir.to_path_buf(),
            jobs: Mutex::new(HashMap::new()),
            client: Mutex::new(None),
            next_generation: AtomicU64::new(0),
            empty_since: Mutex::new(Some(Instant::now())),
        });

        // Idle watchdog: exit once no client has been around for a while
        // and nothing is running. Removing the socket first means a late
        // reconnect fails fast instead of dialing a dying process.
        if watchdog {
            let state = Arc::clone(&state);
            let socket = socket.to_path_buf();
            std::thread::Builder::new()
                .name("job-runner-watchdog".into())
                .spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(5));
                    let idle = state.client.lock().unwrap().is_none()
                        && state.jobs.lock().unwrap().is_empty()
                        && state
                            .empty_since
                            .lock()
                            .unwrap()
                            .is_some_and(|since| since.elapsed() >= IDLE_EXIT);
                    if idle {
                        let _ = std::fs::remove_file(&socket);
                        std::process::exit(0);
                    }
                })
                .ok();
        }

        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let state = Arc::clone(&state);
            // Accept-loop resilience: a poisoned connection must not take
            // the runner (and its live jobs) down.
            std::thread::Builder::new()
                .name("job-runner-client".into())
                .spawn(move || handle_connection(stream, &state))
                .ok();
        }
        Ok(())
    }

    fn handle_connection(stream: UnixStream, state: &Arc<ServerState>) {
        let mut writer = match stream.try_clone() {
            Ok(writer) => std::io::BufWriter::new(writer),
            Err(_) => return,
        };
        let (line_tx, line_rx) = std::sync::mpsc::sync_channel::<String>(128);
        let generation = state.install_client(line_tx, stream.as_raw_fd());

        // Writer thread: drains the pump/replicant queue into the socket.
        // The queue closes when our slot is evicted (sender dropped) or we
        // break on a write error (slot cleared there).
        let write_state = Arc::clone(state);
        std::thread::Builder::new()
            .name("job-runner-writer".into())
            .spawn(move || {
                for line in line_rx {
                    let ok =
                        writer.write_all(line.as_bytes()).is_ok() && writer.write_all(b"\n").is_ok();
                    if !ok {
                        write_state.evict_client(generation);
                        break;
                    }
                    let _ = writer.flush();
                }
            })
            .ok();

        let mut reader = BufReader::new(stream);
        loop {
            match read_line(&mut reader) {
                Ok(Some(ClientMessage::Hello { known })) => {
                    // Welcome first, then each live job's tail replay — a
                    // reconnecting app rebuilds its ring from these.
                    let live = state
                        .jobs
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|(id, job)| LiveJob {
                            id: id.clone(),
                            label: job.label.clone(),
                        })
                        .collect::<Vec<_>>();
                    state.client_send(&RunnerMessage::Welcome { jobs: live });
                    for (id, job) in state.jobs.lock().unwrap().iter() {
                        if known.contains(id) {
                            continue;
                        }
                        if let Some(tail) = replay_tail(&job.file, Arc::clone(&job.written)) {
                            if !tail.is_empty() {
                                state.client_send(&RunnerMessage::Output {
                                    id: id.clone(),
                                    delta: tail,
                                });
                            }
                        }
                    }
                }
                Ok(Some(ClientMessage::Start { id, command, cwd })) => {
                    let ack =
                        match start_job(state, &id, &command, Path::new(&cwd)) {
                            Ok(()) => RunnerMessage::Started { id },
                            Err(reason) => RunnerMessage::StartFailed { id, reason },
                        };
                    state.client_send(&ack);
                }
                Ok(Some(ClientMessage::Kill { id })) => kill_job(&state.jobs, &id),
                Ok(None) | Err(_) => break,
            }
        }
        state.evict_client(generation);
    }

    /// Last `REPLAY_TAIL_BYTES` of a job's file, char-boundary aligned.
    fn replay_tail(file: &Mutex<std::fs::File>, written: Arc<AtomicU64>) -> Option<String> {
        let total = written.load(Ordering::SeqCst);
        let start = total.saturating_sub(REPLAY_TAIL_BYTES);
        let mut file = file.lock().unwrap();
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        // `Read::take` consumes self — borrow the guard's file instead of
        // moving it out.
        (&mut *file)
            .take(total - start)
            .read_to_end(&mut bytes)
            .ok()?;
        let mut cut = 0usize;
        // A byte cut on a non-boundary would split a UTF-8 sequence; walk
        // forward past any continuation bytes (10xxxxxx).
        while cut < bytes.len() && bytes[cut] & 0xC0 == 0x80 {
            cut += 1;
        }
        Some(String::from_utf8_lossy(&bytes[cut..]).into_owned())
    }

    fn start_job(state: &Arc<ServerState>, id: &str, command: &str, cwd: &Path) -> Result<(), String> {
        if state.jobs.lock().unwrap().contains_key(id) {
            return Err(format!("job {id} already exists"));
        }
        let file_path = state.data_dir.join(format!("{}.log", sanitize(id)));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&file_path)
            .map_err(|e| format!("could not open output file: {e}"))?;

        let mut cmd = std::process::Command::new(if cfg!(windows) { "cmd.exe" } else { "/bin/sh" });
        cmd.arg(if cfg!(windows) { "/c" } else { "-c" })
            .arg(command)
            .current_dir(cwd)
            .env_clear()
            .envs(crate::tools::proc::tool_env())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        crate::tools::proc::unix_process_group(&mut cmd);
        nice_child(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("spawn error: {e}"))?;

        let written = Arc::new(AtomicU64::new(0));
        let job = Arc::new(ServerJob {
            pid: child.id(),
            label: command.to_string(),
            file: Mutex::new(file),
            written: Arc::clone(&written),
            terminated: AtomicBool::new(false),
        });
        state.jobs.lock().unwrap().insert(id.to_string(), job.clone());

        // Two pumps (stdout, stderr) append into one file and stream the
        // same bytes as deltas. Reading never stops past the cap — the
        // child must never block on a full pipe — the file just stops
        // growing.
        if let Some(pipe) = child.stdout.take() {
            spawn_pump(pipe, Arc::clone(state), id.to_string(), Arc::clone(&job));
        }
        if let Some(pipe) = child.stderr.take() {
            spawn_pump(pipe, Arc::clone(state), id.to_string(), Arc::clone(&job));
        }

        // Exit watcher: the sole reaper, mirroring the in-process guard's
        // discipline — terminate only signals.
        let watch_state = Arc::clone(state);
        let watch_job = Arc::clone(&job);
        let watch_id = id.to_string();
        std::thread::Builder::new()
            .name("job-runner-exit".into())
            .spawn(move || {
                let code = wait_pid(watch_job.pid);
                // Let the pumps flush their last chunks before settlement.
                std::thread::sleep(Duration::from_millis(150));
                watch_state.client_send(&RunnerMessage::Exit {
                    id: watch_id.clone(),
                    code,
                    terminated: watch_job.terminated.load(Ordering::SeqCst),
                });
                watch_state.jobs.lock().unwrap().remove(&watch_id);
                watch_state.note_job_gone();
            })
            .ok();
        Ok(())
    }

    fn spawn_pump<R: Read + Send + 'static>(
        mut pipe: R,
        state: Arc<ServerState>,
        id: String,
        job: Arc<ServerJob>,
    ) {
        std::thread::Builder::new()
            .name("job-runner-pump".into())
            .spawn(move || pump(&mut pipe, &state, &id, &job))
            .ok();
    }

    /// Pipe → file (capped) → delta stream, until EOF.
    fn pump<R: Read>(mut pipe: R, state: &Arc<ServerState>, id: &str, job: &ServerJob) {
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    {
                        let mut file = job.file.lock().unwrap();
                        let current = job.written.load(Ordering::SeqCst);
                        let take = n.min(FILE_CAP_BYTES.saturating_sub(current) as usize);
                        if take > 0 {
                            // A failed disk write must not kill the
                            // stream; the deltas continue regardless.
                            let _ = file.write_all(&chunk[..take]);
                            job.written.fetch_add(take as u64, Ordering::SeqCst);
                        }
                    }
                    state.client_send(&RunnerMessage::Output {
                        id: id.to_string(),
                        delta: String::from_utf8_lossy(&chunk[..n]).into_owned(),
                    });
                }
            }
        }
    }

    fn kill_job(jobs: &Mutex<HashMap<String, Arc<ServerJob>>>, id: &str) {
        let job = jobs.lock().unwrap().get(id).cloned();
        let Some(job) = job else { return };
        job.terminated.store(true, Ordering::SeqCst);
        signal_group(job.pid, libc::SIGTERM);
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            if pid_gone(job.pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        signal_group(job.pid, libc::SIGKILL);
    }

    fn signal_group(pid: u32, sig: i32) {
        unsafe {
            libc::kill(-(pid as i32), sig);
        }
    }

    /// True when the child has been reaped or is unknown to us anymore.
    fn pid_gone(pid: u32) -> bool {
        let waited = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) };
        waited == pid as libc::pid_t || (waited < 0 && errno() != libc::EINTR)
    }

    fn errno() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    fn wait_pid(pid: u32) -> Option<i32> {
        let mut status: libc::c_int = 0;
        let waited = unsafe { libc::waitpid(pid as i32, &mut status, 0) };
        if waited == pid as i32 {
            std::process::ExitStatus::from_raw(status).code()
        } else {
            None
        }
    }

    // ---------------------------------------------------------------- --
    // Client (the app side, one RunnerSession per owning session)
    // ------------------------------------------------------------------

    struct JobEntry {
        sink: JobOutputSink,
        done: JobDone,
    }

    struct SessionInner {
        socket_path: PathBuf,
        jobs_dir: PathBuf,
        /// Live jobs, keyed by provider id — the routing table for deltas.
        jobs: Mutex<HashMap<String, JobEntry>>,
        /// Deltas that raced a registration (reattach): buffered until
        /// the registry's run closure binds the sink.
        pending_output: Mutex<HashMap<String, Vec<String>>>,
        pending_exits: Mutex<HashMap<String, JobOutcome>>,
        pending_starts: Mutex<HashMap<String, std::sync::mpsc::SyncSender<Result<(), String>>>>,
        /// Live job ids learned from a Welcome that the registry does not
        /// know yet — the reattach queue.
        orphans: Mutex<Vec<LiveJob>>,
        conn: Mutex<Option<UnixStream>>,
        disconnected_since: Mutex<Option<Instant>>,
        closed: AtomicBool,
    }

    #[derive(Clone)]
    pub struct RunnerSession {
        inner: Arc<SessionInner>,
    }

    static POOL: OnceLock<Mutex<HashMap<String, RunnerSession>>> = OnceLock::new();

    fn pool() -> &'static Mutex<HashMap<String, RunnerSession>> {
        POOL.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Spawn the background job `command` through the session's runner,
    /// wiring the registry's hooks to socket messages. Err (any reason —
    /// mode off, spawn failed, handshake timed out) means the caller
    /// falls back to the in-process guard; nothing is half-started
    /// registry-side.
    pub fn spawn_bash_job(
        session: &str,
        command: &str,
        cwd: &Path,
        handle: &JobHandle,
    ) -> Result<JobHooks, String> {
        if !runner_mode_enabled() {
            return Err("runner mode is not enabled".into());
        }
        let runner = session_runner(session)?;
        runner.start_job(handle, command, cwd)
    }

    /// Re-register jobs left running by a previous app process. Returns
    /// the number of jobs adopted. Never spawns a runner — reattach only
    /// ever talks to one that is already out there.
    pub fn reattach_session(session: &str) -> Result<usize, String> {
        let Some(runner) = existing_session_runner(session) else {
            return Ok(0);
        };
        let orphans = runner.take_orphans();
        let mut max_index: u64 = 0;
        let mut adopted = 0usize;
        // Ascending id order so the panel's registration order matches
        // the original starts.
        for job in orphans {
            if let Some(index) = job.id.rsplit('-').next().and_then(|n| n.parse::<u64>().ok()) {
                max_index = max_index.max(index);
            }
            let runner = runner.clone();
            let started = global_job_registry().start(JobStart {
                kind: protocol::model::BackgroundWorkKind::Process,
                prefix: "bash",
                id: Some(job.id.clone()),
                label: job.label.clone(),
                owner_session: session.to_string(),
                output_limit: None,
                streams: true,
                run: Box::new(move |handle| runner.bind_job(handle)),
            });
            if started.is_ok() {
                adopted += 1;
            }
        }
        // Reattached ids reuse the old numbering; keep the minted-id
        // counter past them so a fresh start can never collide.
        global_job_registry().advance_counter(session, "bash", max_index);
        Ok(adopted)
    }

    /// Drop the session's runner connection after its jobs have been
    /// cancelled (the registry's close reaper sends the Kills). The
    /// runner notices the disconnect and idle-exits.
    pub fn close_session(session: &str) {
        let runner = pool().lock().unwrap().remove(session);
        if let Some(runner) = runner {
            runner.inner.closed.store(true, Ordering::SeqCst);
            *runner.inner.conn.lock().unwrap() = None;
        }
    }

    /// Test seam: drop the connection WITHOUT cancelling jobs — the
    /// stand-in for an app crash, so reattach can be exercised.
    pub fn detach_session(session: &str) {
        let runners = pool().lock().unwrap();
        if let Some(runner) = runners.get(session) {
            *runner.inner.conn.lock().unwrap() = None;
            *runner.inner.disconnected_since.lock().unwrap() = Some(Instant::now());
        }
    }

    fn session_runner(session: &str) -> Result<RunnerSession, String> {
        let mut runners = pool().lock().unwrap();
        if let Some(runner) = runners.get(session) {
            return Ok(runner.clone());
        }
        let runner = RunnerSession::new(session, true)?;
        runners.insert(session.to_string(), runner.clone());
        Ok(runner)
    }

    fn existing_session_runner(session: &str) -> Option<RunnerSession> {
        let mut runners = pool().lock().unwrap();
        if let Some(runner) = runners.get(session) {
            return Some(runner.clone());
        }
        let runner = RunnerSession::new(session, false).ok()?;
        runners.insert(session.to_string(), runner.clone());
        Some(runner)
    }

    impl RunnerSession {
        fn new(session: &str, may_spawn: bool) -> Result<RunnerSession, String> {
            let inner = Arc::new(SessionInner {
                socket_path: socket_path(session),
                jobs_dir: jobs_dir(session),
                jobs: Mutex::new(HashMap::new()),
                pending_output: Mutex::new(HashMap::new()),
                pending_exits: Mutex::new(HashMap::new()),
                pending_starts: Mutex::new(HashMap::new()),
                orphans: Mutex::new(Vec::new()),
                conn: Mutex::new(None),
                disconnected_since: Mutex::new(None),
                closed: AtomicBool::new(false),
            });
            let runner = RunnerSession { inner };
            connect_inner(&runner.inner, may_spawn, Vec::new())?;
            runner.spawn_supervisor();
            Ok(runner)
        }

        fn spawn_supervisor(&self) {
            let inner = Arc::clone(&self.inner);
            std::thread::Builder::new()
                .name("job-runner-supervisor".into())
                .spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(1));
                    if inner.closed.load(Ordering::SeqCst) {
                        return;
                    }
                    if inner.conn.lock().unwrap().is_some() {
                        continue;
                    }
                    // Reconnect (never spawn — the supervisor's job is
                    // recovery, not bootstrapping). Give up after 30 s of
                    // nothing: the runner process is gone.
                    let _ = connect_inner(&inner, false, inner.live_ids());
                    let give_up = inner
                        .disconnected_since
                        .lock()
                        .unwrap()
                        .is_some_and(|since| since.elapsed() > Duration::from_secs(30));
                    if give_up {
                        inner.fail_all("job runner connection lost");
                        return;
                    }
                })
                .ok();
        }

        fn take_orphans(&self) -> Vec<LiveJob> {
            // A fresh connect may surface jobs the stored orphans missed
            // (supervisor reconnect races); refresh once, then drain.
            if self.inner.conn.lock().unwrap().is_none() {
                let _ = connect_inner(&self.inner, false, self.inner.live_ids());
            }
            std::mem::take(&mut self.inner.orphans.lock().unwrap())
        }

        fn start_job(&self, handle: &JobHandle, command: &str, cwd: &Path) -> Result<JobHooks, String> {
            let id = handle.key.provider_id.clone();
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            self.inner
                .pending_starts
                .lock()
                .unwrap()
                .insert(id.clone(), tx);
            let sent = self
                .inner
                .send(&ClientMessage::Start {
                    id: id.clone(),
                    command: command.to_string(),
                    cwd: cwd.display().to_string(),
                });
            if let Err(error) = sent {
                self.inner.pending_starts.lock().unwrap().remove(&id);
                return Err(error);
            }
            let ack = match rx.recv_timeout(Duration::from_secs(10)) {
                Ok(result) => result,
                Err(_) => {
                    self.inner.pending_starts.lock().unwrap().remove(&id);
                    Err("runner did not acknowledge the job start".into())
                }
            };
            ack?;
            self.bind_job(handle)
        }

        /// Bind one registry handle to this session's runner: route the
        /// job's deltas here and resolve its done on Exit. Used by both a
        /// fresh start and a reattach registration.
        fn bind_job(&self, handle: &JobHandle) -> Result<JobHooks, String> {
            let id = handle.key.provider_id.clone();
            let buffered = self
                .inner
                .pending_output
                .lock()
                .unwrap()
                .remove(&id)
                .unwrap_or_default();
            self.inner.jobs.lock().unwrap().insert(
                id.clone(),
                JobEntry {
                    sink: handle.output.clone(),
                    done: handle.done.clone(),
                },
            );
            // Drain whatever raced the registration.
            {
                let jobs = self.inner.jobs.lock().unwrap();
                if let Some(entry) = jobs.get(&id) {
                    for delta in buffered {
                        entry.sink.append(&delta);
                    }
                }
            }
            if let Some(outcome) = self.inner.pending_exits.lock().unwrap().remove(&id) {
                handle.done.resolve(outcome);
            }
            let inner = Arc::clone(&self.inner);
            let kill_id = id;
            Ok(JobHooks {
                cancel: Box::new(move |_reason| {
                    let _ = inner.send(&ClientMessage::Kill { id: kill_id.clone() });
                }),
                done: handle.done.clone(),
            })
        }
    }

    /// Dial the session's runner (connecting only, or also spawning it)
    /// and run the Hello → Welcome handshake. Free-standing over
    /// `Arc<SessionInner>` so the reader thread can hold the Arc.
    fn connect_inner(
        inner: &Arc<SessionInner>,
        may_spawn: bool,
        known: Vec<String>,
    ) -> Result<(), String> {
        {
            let conn = inner.conn.lock().unwrap();
            if conn.is_some() {
                return Ok(());
            }
        }
        let stream = connect_socket(&inner.socket_path).or_else(|_| {
            if !may_spawn {
                Err("no runner is listening".into())
            } else {
                spawn_runner_process(&inner.socket_path, &inner.jobs_dir)
            }
        })?;

        // Handshake synchronously (Hello → Welcome) BEFORE installing the
        // reader thread, so replay ordering is deterministic.
        let mut writer = stream
            .try_clone()
            .map_err(|e| format!("runner stream: {e}"))?;
        send_line(
            &mut writer,
            &ClientMessage::Hello {
                known: known.clone(),
            },
        )
        .map_err(|e| format!("runner handshake failed: {e}"))?;
        let mut reader =
            BufReader::new(stream.try_clone().map_err(|e| format!("runner stream: {e}"))?);
        match read_line(&mut reader) {
            Ok(Some(RunnerMessage::Welcome { jobs })) => {
                inner.absorb_welcome(jobs, &known);
            }
            _ => return Err("runner handshake got no welcome".into()),
        }

        // Reader thread for everything after the welcome.
        let msg_inner = Arc::clone(inner);
        std::thread::Builder::new()
            .name("job-runner-reader".into())
            .spawn(move || loop {
                match read_line(&mut reader) {
                    Ok(Some(message)) => msg_inner.handle_message(message),
                    Ok(None) | Err(_) => break,
                }
                if msg_inner.closed.load(Ordering::SeqCst) {
                    break;
                }
            })
            .ok();

        *inner.conn.lock().unwrap() = Some(stream);
        *inner.disconnected_since.lock().unwrap() = None;
        Ok(())
    }

    impl SessionInner {
        fn live_ids(&self) -> Vec<String> {
            self.jobs.lock().unwrap().keys().cloned().collect()
        }

        fn fail_all(&self, reason: &str) {
            let jobs: Vec<JobDone> = self
                .jobs
                .lock()
                .unwrap()
                .drain()
                .map(|(_, entry)| entry.done)
                .collect();
            for done in jobs {
                done.resolve(JobOutcome {
                    status: SettledStatus::Failed,
                    detail: Some(reason.to_string()),
                    output: None,
                    usage: None,
                });
            }
        }

        fn send(&self, message: &ClientMessage) -> Result<(), String> {
            let mut conn = self.conn.lock().unwrap();
            let result = match conn.as_mut() {
                Some(stream) => send_line(stream, message)
                    .map_err(|e| format!("runner write failed: {e}")),
                None => Err("runner not connected".into()),
            };
            if result.is_err() {
                *conn = None;
                *self.disconnected_since.lock().unwrap() = Some(Instant::now());
            }
            result
        }

        fn handle_message(&self, message: RunnerMessage) {
            match message {
                RunnerMessage::Welcome { jobs } => {
                    let known = self.live_ids();
                    self.absorb_welcome(jobs, &known);
                }
                RunnerMessage::Started { id } => {
                    if let Some(tx) = self.pending_starts.lock().unwrap().remove(&id) {
                        let _ = tx.send(Ok(()));
                    }
                }
                RunnerMessage::StartFailed { id, reason } => {
                    if let Some(tx) = self.pending_starts.lock().unwrap().remove(&id) {
                        let _ = tx.send(Err(reason));
                    }
                }
                RunnerMessage::Output { id, delta } => {
                    let jobs = self.jobs.lock().unwrap();
                    if let Some(entry) = jobs.get(&id) {
                        entry.sink.append(&delta);
                    } else {
                        drop(jobs);
                        self.pending_output
                            .lock()
                            .unwrap()
                            .entry(id)
                            .or_default()
                            .push(delta);
                    }
                }
                RunnerMessage::Exit {
                    id,
                    code,
                    terminated,
                } => {
                    let outcome = JobOutcome {
                        status: if terminated {
                            SettledStatus::Stopped
                        } else if code == Some(0) {
                            SettledStatus::Completed
                        } else {
                            SettledStatus::Failed
                        },
                        detail: Some(format!("exit code: {}", code.unwrap_or(-1))),
                        output: None,
                        usage: None,
                    };
                    let done = self.jobs.lock().unwrap().remove(&id).map(|e| e.done);
                    match done {
                        Some(done) => done.resolve(outcome),
                        None => {
                            self.pending_exits.lock().unwrap().insert(id, outcome);
                        }
                    }
                }
            }
        }

        fn absorb_welcome(&self, jobs: Vec<LiveJob>, known: &[String]) {
            let mut orphans = self.orphans.lock().unwrap();
            for job in jobs {
                if known.contains(&job.id) || orphans.iter().any(|o| o.id == job.id) {
                    continue;
                }
                // A job the registry already holds (fresh start) is not an
                // orphan; the known check covers it via live ids.
                orphans.push(job);
            }
        }
    }

    fn connect_socket(socket_path: &Path) -> Result<UnixStream, String> {
        UnixStream::connect(socket_path).map_err(|e| format!("runner connect: {e}"))
    }

    fn spawn_runner_process(
        socket_path: &Path,
        jobs_dir: &Path,
    ) -> Result<UnixStream, String> {
        let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
        std::fs::create_dir_all(jobs_dir).map_err(|e| format!("jobs dir: {e}"))?;
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("--job-runner")
            .arg(socket_path)
            .arg(jobs_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        nice_child(&mut cmd);
        cmd.spawn()
            .map_err(|e| format!("could not spawn job runner: {e}"))?;
        // Wait for the socket to appear and accept.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if Instant::now() >= deadline {
                return Err("job runner did not come up".into());
            }
            match UnixStream::connect(socket_path) {
                Ok(stream) => return Ok(stream),
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        use protocol::model::BackgroundWorkStatus;

        fn unique_session(tag: &str) -> String {
            static N: AtomicU64 = AtomicU64::new(0);
            format!(
                "runner-test-{tag}-{}",
                N.fetch_add(1, Ordering::SeqCst)
            )
        }

        /// Run the runner server in-process: cargo test's current_exe is
        /// the test binary, which cannot re-exec itself as
        /// `--job-runner`. The client path is unchanged — it dials the
        /// socket exactly like production does.
        fn serve_in_process(session: &str) {
            let socket = socket_path(session);
            let dir = jobs_dir(session);
            std::thread::Builder::new()
                .name("test-job-runner".into())
                .spawn(move || serve_inner(&socket, &dir, false).expect("runner serve failed"))
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !socket_path(session).exists() {
                assert!(
                    Instant::now() < deadline,
                    "runner socket never appeared for {session}"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn start_job(
            session_id: &str,
            command: &str,
        ) -> protocol::model::BackgroundWorkKey {
            let command = command.to_string();
            let session = session_id.to_string();
            let cwd = std::env::temp_dir();
            global_job_registry()
                .start(JobStart {
                    kind: protocol::model::BackgroundWorkKind::Process,
                    prefix: "bash",
                    id: None,
                    label: command.clone(),
                    owner_session: session_id.to_string(),
                    output_limit: None,
                    streams: true,
                    run: Box::new(move |handle| {
                        spawn_bash_job(&session, &command, &cwd, handle)
                    }),
                })
                .unwrap()
        }

        fn wait_settled(
            session_id: &str,
            key: &protocol::model::BackgroundWorkKey,
        ) -> protocol::model::BackgroundWorkItem {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let item = global_job_registry()
                    .list_session(session_id)
                    .into_iter()
                    .find(|item| &item.key == key)
                    .unwrap();
                if !item.status.is_live() {
                    return item;
                }
                assert!(Instant::now() < deadline, "job never settled: {item:?}");
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        fn wait_output(
            session_id: &str,
            key: &protocol::model::BackgroundWorkKey,
            needle: &str,
        ) {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let read = global_job_registry()
                    .read(session_id, key, crate::jobs::Reader::Model)
                    .unwrap();
                if read.text.contains(needle) {
                    return;
                }
                assert!(Instant::now() < deadline, "output never arrived: {needle}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        #[test]
        fn runner_job_streams_output_and_settles_completed() {
            let session = unique_session("complete");
            serve_in_process(&session);
            enable_runner_mode();
            let key = start_job(&session, "echo runner-echo-marker; exit 0");
            wait_output(&session, &key, "runner-echo-marker");
            let item = wait_settled(&session, &key);
            assert_eq!(item.status, BackgroundWorkStatus::Completed);
            assert_eq!(item.detail.as_deref(), Some("exit code: 0"));
            // Only the runner writes the log file — proves the job really
            // ran out-of-process instead of silently taking the in-process
            // fallback.
            assert!(
                jobs_dir(&session)
                    .join(format!("{}.log", key.provider_id))
                    .exists()
            );
            super::close_session(&session);
        }

        #[test]
        fn runner_kill_settles_stopped() {
            let session = unique_session("kill");
            serve_in_process(&session);
            enable_runner_mode();
            let key = start_job(&session, "sleep 30");
            assert_eq!(
                global_job_registry()
                    .kill(&session, &key, None)
                    .unwrap(),
                crate::jobs::KillOutcome::Requested
            );
            let item = wait_settled(&session, &key);
            assert_eq!(item.status, BackgroundWorkStatus::Stopped);
            assert!(
                item.detail
                    .as_deref()
                    .unwrap_or("")
                    .starts_with("exit code:")
            );
            super::close_session(&session);
        }

        #[test]
        fn reattach_without_a_runner_adopts_nothing_and_spawns_none() {
            let session = unique_session("reattach-none");
            assert_eq!(reattach_session(&session).unwrap(), 0);
            assert!(!socket_path(&session).exists());
        }

        #[test]
        fn supervisor_reconnects_after_a_detach() {
            let session = unique_session("reconnect");
            serve_in_process(&session);
            enable_runner_mode();
            let runner = session_runner(&session).unwrap();
            detach_session(&session);
            assert!(runner.inner.conn.lock().unwrap().is_none());
            let deadline = Instant::now() + Duration::from_secs(5);
            while runner.inner.conn.lock().unwrap().is_none() {
                assert!(Instant::now() < deadline, "supervisor never reconnected");
                std::thread::sleep(Duration::from_millis(20));
            }
            super::close_session(&session);
        }

        fn bare_inner(session: &str) -> Arc<SessionInner> {
            Arc::new(SessionInner {
                socket_path: socket_path(session),
                jobs_dir: jobs_dir(session),
                jobs: Mutex::new(HashMap::new()),
                pending_output: Mutex::new(HashMap::new()),
                pending_exits: Mutex::new(HashMap::new()),
                pending_starts: Mutex::new(HashMap::new()),
                orphans: Mutex::new(Vec::new()),
                conn: Mutex::new(None),
                disconnected_since: Mutex::new(None),
                closed: AtomicBool::new(false),
            })
        }

        #[test]
        fn welcome_jobs_become_orphans_except_known_ones() {
            let inner = bare_inner("orphans");
            inner.absorb_welcome(
                vec![
                    LiveJob {
                        id: "bash-1".into(),
                        label: "l1".into(),
                    },
                    LiveJob {
                        id: "bash-2".into(),
                        label: "l2".into(),
                    },
                ],
                &["bash-1".to_string()],
            );
            assert_eq!(inner.orphans.lock().unwrap().len(), 1);
            assert_eq!(inner.orphans.lock().unwrap()[0].id, "bash-2");
            // A repeat welcome (supervisor reconnect race) must not
            // duplicate the orphan.
            inner.absorb_welcome(
                vec![LiveJob {
                    id: "bash-2".into(),
                    label: "l2".into(),
                }],
                &[],
            );
            assert_eq!(inner.orphans.lock().unwrap().len(), 1);
        }
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;
    use crate::jobs::{JobHandle, JobHooks};
    use std::path::Path;

    pub fn main_if_requested() -> bool {
        false
    }

    pub fn spawn_bash_job(
        _session: &str,
        _command: &str,
        _cwd: &Path,
        _handle: &JobHandle,
    ) -> Result<JobHooks, String> {
        Err("job runner is unix-only".into())
    }

    pub fn reattach_session(_session: &str) -> Result<usize, String> {
        Ok(0)
    }

    pub fn close_session(_session: &str) {}
}

pub use imp::{close_session, main_if_requested, reattach_session, spawn_bash_job};

#[cfg(unix)]
pub use imp::detach_session;
