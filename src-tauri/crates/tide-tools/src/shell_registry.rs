//! Background shell registry — port of `app/core/agent/tools/background-shell.ts`
//! (91ec558). Long-running commands (dev servers, watchers) spawned by the
//! bash tool with `background:true` live here, keyed by shell id. Output is a
//! capped ring buffer (256 KB) with a per-shell read cursor so `bash_output`
//! returns incremental stdout+stderr; `kill_shell` SIGTERMs the process group
//! and drops the entry.
//!
//! One addition over the TS: shells are tied to the spawning turn's
//! [`AbortFlag`] — when the user aborts that turn, its background shells are
//! killed and removed (normal turn END does not fire the flag, so a dev
//! server backgrounded in one turn keeps running while later turns poll it,
//! exactly like the TS lifecycle).

use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::tools::proc::{tool_env, unix_process_group};
use crate::AbortFlag;

/// Buffered stdout+stderr cap per shell — the TS `MAX_BUFFER` (256KB).
pub const MAX_BUFFER: usize = 256 * 1024;

/// Snapshot of one shell's liveness for `bash_output`'s meta line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellStatus {
    pub exited: bool,
    /// `None` maps to the TS `code null` (killed by signal, or spawn error).
    pub exit_code: Option<i32>,
}

struct BufferState {
    /// stdout+stderr interleaved, byte-capped at [`MAX_BUFFER`].
    text: String,
    /// Byte offset already consumed by the last `bash_output` read.
    cursor: usize,
}

struct ShellState {
    buffer: Mutex<BufferState>,
    exited: AtomicBool,
    exit_code: Mutex<Option<i32>>,
}

#[derive(Clone)]
struct ShellHandle {
    command: String,
    pid: u32,
    state: Arc<ShellState>,
}

#[derive(Default)]
struct Inner {
    shells: Mutex<HashMap<String, ShellHandle>>,
}

impl Inner {
    fn remove(&self, id: &str) {
        self.shells.lock().unwrap().remove(id);
    }
}

/// The in-process registry the bash / bash_output / kill_shell tools share.
/// The app uses [`ShellRegistry::kill_all`] on quit so background processes
/// don't outlive the app.
#[derive(Default, Clone)]
pub struct ShellRegistry {
    inner: Arc<Inner>,
}

/// The process-wide registry the tools address by shell id (the TS module
/// -level `Map`). A fresh [`ShellRegistry`] is fine for tests.
pub fn global_shell_registry() -> &'static ShellRegistry {
    static REGISTRY: std::sync::OnceLock<ShellRegistry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(ShellRegistry::default)
}

impl ShellRegistry {
    /// Spawn `command` through the platform shell under `cwd`, registering it
    /// as `id`. A live shell already using `id` is killed first (TS
    /// `spawnBackground`). `abort` ties the shell to its spawning turn: firing
    /// it kills the process and drops the entry.
    pub fn spawn(
        &self,
        id: &str,
        command: &str,
        cwd: &std::path::Path,
        abort: &AbortFlag,
    ) -> std::io::Result<()> {
        if self.kill(id) {
            // The old monitor thread reaps its own child; give it a beat.
            std::thread::sleep(Duration::from_millis(50));
        }

        let mut cmd = Command::new(if cfg!(windows) { "cmd.exe" } else { "/bin/sh" });
        cmd.arg(if cfg!(windows) { "/c" } else { "-c" })
            .arg(command)
            .current_dir(cwd)
            .env_clear()
            .envs(tool_env())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        unix_process_group(&mut cmd);
        let mut child = cmd.spawn()?;
        let pid = child.id();

        let state = Arc::new(ShellState {
            buffer: Mutex::new(BufferState {
                text: String::new(),
                cursor: 0,
            }),
            exited: AtomicBool::new(false),
            exit_code: Mutex::new(None),
        });

        if let Some(pipe) = child.stdout.take() {
            spawn_append_thread(pipe, Arc::clone(&state));
        }
        if let Some(pipe) = child.stderr.take() {
            spawn_append_thread(pipe, Arc::clone(&state));
        }
        spawn_monitor_thread(Arc::clone(&self.inner), id.to_string(), child, Arc::clone(&state), abort.clone());

        self.inner.shells.lock().unwrap().insert(
            id.to_string(),
            ShellHandle {
                command: command.to_string(),
                pid,
                state,
            },
        );
        Ok(())
    }

    /// Incremental output since the last read (TS `runBashOutput` body):
    /// advances the cursor and reports liveness. `None` = unknown shell id.
    pub fn read_new(&self, id: &str) -> Option<(String, ShellStatus)> {
        let handle = self.inner.shells.lock().unwrap().get(id).cloned()?;
        let mut buffer = handle.state.buffer.lock().unwrap();
        let new_output = buffer.text[buffer.cursor.min(buffer.text.len())..].to_string();
        buffer.cursor = buffer.text.len();
        drop(buffer);
        let exit_code = *handle.state.exit_code.lock().unwrap();
        Some((
            new_output,
            ShellStatus {
                exited: handle.state.exited.load(Ordering::SeqCst),
                exit_code,
            },
        ))
    }

    /// SIGTERM the shell's process group and drop the registry entry.
    /// `false` when no shell with `id` exists (TS `killBackground`).
    pub fn kill(&self, id: &str) -> bool {
        let Some(handle) = self.inner.shells.lock().unwrap().get(id).cloned() else {
            return false;
        };
        if !handle.state.exited.load(Ordering::SeqCst) {
            signal_pid(handle.pid, Signal::Term);
        }
        self.inner.remove(id);
        true
    }

    /// Kill every registered shell — app-quit path (TS
    /// `killAllBackgroundShells`).
    pub fn kill_all(&self) {
        let ids: Vec<String> = self.inner.shells.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }

    /// Registered shell ids with their commands — tests and diagnostics.
    pub fn entries(&self) -> Vec<(String, String)> {
        self.inner
            .shells
            .lock()
            .unwrap()
            .iter()
            .map(|(id, h)| (id.clone(), h.command.clone()))
            .collect()
    }
}

/// Append pipe bytes into the shared ring buffer, dropping the oldest bytes
/// past the cap and shifting the read cursor the same amount (TS `append`).
fn spawn_append_thread<R: Read + Send + 'static>(pipe: R, state: Arc<ShellState>) {
    std::thread::spawn(move || {
        let mut pipe = pipe;
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut buffer = state.buffer.lock().unwrap();
                    buffer.text.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    if buffer.text.len() > MAX_BUFFER {
                        let excess = buffer.text.len() - MAX_BUFFER;
                        let cut = char_boundary(&buffer.text, excess);
                        buffer.text.drain(..cut);
                        buffer.cursor = buffer.cursor.saturating_sub(cut);
                    }
                }
            }
        }
    });
}

/// Watch a background child: record its exit, and honor the spawning turn's
/// abort flag by killing the group and removing the entry (the registry
/// cleanup the TS didn't need — its turns never had a kill switch).
fn spawn_monitor_thread(
    inner: Arc<Inner>,
    id: String,
    mut child: Child,
    state: Arc<ShellState>,
    abort: AbortFlag,
) {
    std::thread::spawn(move || {
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    *state.exit_code.lock().unwrap() = status.code();
                    state.exited.store(true, Ordering::SeqCst);
                    return;
                }
                Ok(None) => {}
                Err(_) => {
                    *state.exit_code.lock().unwrap() = Some(-1);
                    state.exited.store(true, Ordering::SeqCst);
                    return;
                }
            }
            if abort.is_aborted() {
                signal_pid(child.id(), Signal::Term);
                let deadline = std::time::Instant::now() + Duration::from_millis(500);
                while std::time::Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                signal_pid(child.id(), Signal::Kill);
                let _ = child.wait();
                inner.remove(&id);
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
}

/// Largest char boundary <= `index` so ring-buffer drains never split a
/// multi-byte UTF-8 sequence.
fn char_boundary(s: &str, index: usize) -> usize {
    let mut i = index.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Signal the whole process group on Unix; `taskkill /T /F` on Windows (the
/// TS `killProcessTree` split).
#[derive(Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
fn signal_pid(pid: u32, sig: Signal) {
    let sig = match sig {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    unsafe {
        libc::kill(-(pid as i32), sig);
    }
}

#[cfg(not(unix))]
fn signal_pid(pid: u32, _sig: Signal) {
    let _ = Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .status();
}

/// Generate a TS-shaped shell id: `sh_` + 6 base-36-ish chars. A process-wide
/// counter guarantees uniqueness where the TS relied on `Math.random`.
static SHELL_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn next_shell_id() -> String {
    let n = SHELL_SEQ.fetch_add(1, Ordering::SeqCst);
    format!("sh_{n:06x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_until(mut cond: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !cond() {
            if std::time::Instant::now() > deadline {
                panic!("condition not met within 10s");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn lifecycle_spawn_output_growth_kill() {
        let reg = ShellRegistry::default();
        let tmp = tempfile::tempdir().unwrap();
        let no_abort = AbortFlag::new();

        reg.spawn("sh_a", "echo one; sleep 1; echo two; sleep 5", tmp.path(), &no_abort)
            .unwrap();

        wait_until(|| {
            reg.read_new("sh_a")
                .map(|(out, _)| out.contains("one"))
                .unwrap_or(false)
        });
        // Incremental: second read only sees later output.
        wait_until(|| {
            reg.read_new("sh_a")
                .map(|(out, _)| out.contains("two"))
                .unwrap_or(false)
        });
        let (out, status) = reg.read_new("sh_a").unwrap();
        assert_eq!(out, "");
        assert!(!status.exited);

        assert!(reg.kill("sh_a"));
        assert!(reg.entries().is_empty());
        assert!(!reg.kill("sh_a"), "second kill: unknown id");
    }

    #[test]
    fn exit_status_recorded_after_natural_exit() {
        let reg = ShellRegistry::default();
        let tmp = tempfile::tempdir().unwrap();
        reg.spawn("sh_b", "echo bye; exit 3", tmp.path(), &AbortFlag::new())
            .unwrap();
        // Drain output until the process is gone (reads are incremental).
        let mut seen = String::new();
        wait_until(|| {
            if let Some((out, status)) = reg.read_new("sh_b") {
                seen.push_str(&out);
                status.exited
            } else {
                false
            }
        });
        assert!(seen.contains("bye"));
        let (out, status) = reg.read_new("sh_b").unwrap();
        assert_eq!(out, "");
        assert_eq!(status.exit_code, Some(3));
        // Dead shells stay readable (buffered output) until killed.
        assert_eq!(reg.entries().len(), 1);
    }

    #[test]
    fn abort_kills_and_removes_shell() {
        let reg = ShellRegistry::default();
        let tmp = tempfile::tempdir().unwrap();
        let abort = AbortFlag::new();
        reg.spawn("sh_c", "sleep 30", tmp.path(), &abort).unwrap();
        assert_eq!(reg.entries().len(), 1);

        abort.abort();
        wait_until(|| reg.entries().is_empty());
    }

    #[test]
    fn respawn_same_id_kills_previous() {
        let reg = ShellRegistry::default();
        let tmp = tempfile::tempdir().unwrap();
        reg.spawn("sh_d", "sleep 30", tmp.path(), &AbortFlag::new())
            .unwrap();
        reg.spawn("sh_d", "echo fresh", tmp.path(), &AbortFlag::new())
            .unwrap();
        wait_until(|| {
            reg.read_new("sh_d")
                .map(|(out, _)| out.contains("fresh"))
                .unwrap_or(false)
        });
        assert_eq!(reg.entries().len(), 1);
        reg.kill_all();
        assert!(reg.entries().is_empty());
    }

    #[test]
    fn ring_buffer_trims_to_cap_and_cursor_follows() {
        let reg = ShellRegistry::default();
        let tmp = tempfile::tempdir().unwrap();
        // ~300KB of output — the buffer keeps the last 256KB. Wait for the
        // cap AND the final line: the cap alone is hit mid-stream, before
        // the tail line has been written.
        reg.spawn(
            "sh_e",
            "seq 1 60000; sleep 5",
            tmp.path(),
            &AbortFlag::new(),
        )
        .unwrap();
        wait_until(|| {
            reg.inner
                .shells
                .lock()
                .unwrap()
                .get("sh_e")
                .map(|h| {
                    let buffer = h.state.buffer.lock().unwrap();
                    buffer.text.len() >= MAX_BUFFER && buffer.text.contains("60000")
                })
                .unwrap_or(false)
        });
        let (out, _) = reg.read_new("sh_e").unwrap();
        assert!(out.len() <= MAX_BUFFER, "read respects the cap");
        assert!(out.contains("60000"), "kept the tail, not the head");
        assert!(!out.contains("\n1\n"), "head was dropped");
        reg.kill("sh_e");
    }

    #[test]
    fn next_shell_ids_are_unique_and_shaped() {
        let a = next_shell_id();
        let b = next_shell_id();
        assert_ne!(a, b);
        assert!(a.starts_with("sh_") && a.len() == 9, "{a}");
    }
}
