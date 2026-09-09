//! Shared subprocess plumbing for tools: bounded readers, deadline-wrapped
//! runs, and process-group kills. Ported from the TS `tool-env.ts` +
//! `bash.ts` subprocess handling ().

use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) struct StreamReader {
    pub text: Arc<Mutex<String>>,
    pub truncated: Arc<AtomicBool>,
    pub last_output_ms: Arc<AtomicU64>,
}

/// Spawn a bounded reader thread for one output pipe. Caps at `cap` bytes
/// (like the TS 50 KB per-stream caps) and records a monotonic
/// last-output timestamp for the early-kill heuristic.
pub(crate) fn spawn_reader<R: Read + Send + 'static>(
    pipe: R,
    cap: usize,
    start: Instant,
) -> StreamReader {
    let text = Arc::new(Mutex::new(String::new()));
    let truncated = Arc::new(AtomicBool::new(false));
    let last_output_ms = Arc::new(AtomicU64::new(0));
    let sink = Arc::clone(&text);
    let trunc_flag = Arc::clone(&truncated);
    let last = Arc::clone(&last_output_ms);
    std::thread::spawn(move || {
        let mut pipe = pipe;
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut buf = sink.lock().unwrap();
                    if buf.len() >= cap {
                        trunc_flag.store(true, Ordering::SeqCst);
                        continue;
                    }
                    let room = cap - buf.len();
                    let take = room.min(n);
                    buf.push_str(&String::from_utf8_lossy(&chunk[..take]));
                    if take < n {
                        trunc_flag.store(true, Ordering::SeqCst);
                    }
                    drop(buf);
                    last.store(start.elapsed().as_millis() as u64, Ordering::SeqCst);
                }
            }
        }
    });
    StreamReader {
        text,
        truncated,
        last_output_ms,
    }
}

/// Signal the whole process group (Unix — the child was spawned with
/// `process_group(0)`), falling back to the child alone.
pub fn kill_process_group(child: &mut Child, sig_kill: bool) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        let sig = if sig_kill {
            libc::SIGKILL
        } else {
            libc::SIGTERM
        };
        unsafe {
            libc::kill(-pid, sig);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = sig_kill;
        let _ = child.kill();
    }
}

/// Graceful teardown: SIGTERM the group, wait out the grace period
/// (TS used 500 ms before SIGKILL), then force-kill and reap.
pub(crate) fn kill_and_reap(child: &mut Child) {
    kill_process_group(child, false);
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => return,
        }
    }
    kill_process_group(child, true);
    let _ = child.wait();
}

pub(crate) struct RunResult {
    pub exit: Option<i32>,
    pub stdout: String,
    // Kept for callers that surface rg/diagnostics (the TS read
    // result.stderr for spawn failures).
    #[allow(dead_code)]
    pub stderr: String,
}

#[derive(Debug)]
pub(crate) enum RunError {
    /// The binary could not be spawned at all (e.g. not installed).
    Spawn(#[allow(dead_code)] std::io::Error),
    Io(std::io::Error),
}

/// Run a command to completion under a wall-clock deadline, capturing
/// piped stdout/stderr (capped). Kills the process group on timeout.
pub(crate) fn run_with_deadline(
    cmd: &mut Command,
    timeout: Duration,
    cap: usize,
) -> Result<RunResult, RunError> {
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    unix_process_group(cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(RunError::Spawn(e)),
        Err(e) => return Err(RunError::Io(e)),
    };
    let start = Instant::now();
    let out_reader = child.stdout.take().map(|p| spawn_reader(p, cap, start));
    let err_reader = child.stderr.take().map(|p| spawn_reader(p, cap, start));

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(finish_run(status.code(), out_reader, err_reader)),
            Ok(None) => {}
            Err(e) => {
                kill_and_reap(&mut child);
                return Err(RunError::Io(e));
            }
        }
        if Instant::now() >= deadline {
            kill_and_reap(&mut child);
            return Ok(finish_run(None, out_reader, err_reader));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn finish_run(
    exit: Option<i32>,
    out: Option<StreamReader>,
    err: Option<StreamReader>,
) -> RunResult {
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(r) = out {
        if let Ok(t) = r.text.lock() {
            stdout = t.clone();
        }
    }
    if let Some(r) = err {
        if let Ok(t) = r.text.lock() {
            stderr = t.clone();
        }
    }
    RunResult {
        exit,
        stdout,
        stderr,
    }
}

/// Unix: put the child in its own process group so group kills reach the
/// whole tree. Windows: hide the console window the GUI-subsystem app would
/// otherwise allocate for every console-subsystem child it spawns.
#[cfg(unix)]
pub fn unix_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(windows)]
pub fn unix_process_group(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
pub fn unix_process_group(_cmd: &mut Command) {}

/// Process-creation flag giving console children a hidden console instead
/// of a visible window (Node's `windowsHide` equivalent).
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Paths commonly used by version managers and package managers
/// (TS `EXTRA_PATHS_UNIX`).
const EXTRA_PATHS_UNIX: &[&str] = &[
    "/usr/local/bin",
    "/usr/local/sbin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/opt/homebrew/lib/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

/// Capture the full environment from the user's login shell (runs once per
/// process) so GUI-launched sessions still see nvm/fnm/conda PATHs. Falls
/// back to the inherited environment when the shell hangs or fails.
fn captured_shell_env() -> &'static HashMap<String, String> {
    static CACHE: OnceLock<HashMap<String, String>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = Command::new(shell);
        cmd.args(["-l", "-c", "env"]);
        let captured = run_with_deadline(&mut cmd, Duration::from_secs(10), 1 << 20).ok();
        let mut env: HashMap<String, String> = captured
            .and_then(|r| {
                let mut map = HashMap::new();
                for line in r.stdout.lines() {
                    if let Some((k, v)) = line.split_once('=') {
                        if !k.is_empty() {
                            map.insert(k.to_string(), v.to_string());
                        }
                    }
                }
                if map.is_empty() {
                    None
                } else {
                    Some(map)
                }
            })
            .unwrap_or_default();
        if env.is_empty() {
            env.extend(std::env::vars());
        }
        env
    })
}

/// The tool subprocess environment: captured login-shell env + PATH
/// safety-net entries + CI=1 (package managers skip prompts).
/// Port of the TS `toolEnv()`.
pub fn tool_env() -> HashMap<String, String> {
    let mut env = captured_shell_env().clone();
    if !cfg!(unix) {
        env.entry("CI".to_string()).or_insert_with(|| "1".into());
        return env;
    }

    let mut paths: Vec<String> = env
        .get("PATH")
        .map(|p| p.split(':').map(|s| s.to_string()).collect())
        .unwrap_or_default();
    let home_local = std::env::var("HOME")
        .ok()
        .map(|h| format!("{h}/.local/bin"))
        .into_iter()
        .chain(["/opt/local/bin".to_string(), "/opt/local/sbin".to_string()])
        .collect::<Vec<_>>();
    paths.extend(EXTRA_PATHS_UNIX.iter().map(|s| s.to_string()));
    paths.extend(home_local);
    paths.retain(|p| !p.is_empty());
    paths.dedup();
    env.insert("PATH".to_string(), paths.join(":"));
    env.entry("CI".to_string()).or_insert_with(|| "1".into());
    env
}
