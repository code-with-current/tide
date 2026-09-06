//! The bash background-job process guard: spawn the command in its own
//! process group, stream stdout+stderr into the job's output sink,
//! terminate the group on `job_kill`, and watch for exit so the job's done
//! handle resolves with the `exit code: N` detail.
//!
//! This is all that remains of the retired per-shell `ShellRegistry` (the
//! `sh_*` ids and its read/kill envelopes): `bash background:true` now
//! starts a job in the session-scoped background-job registry — see
//! [`crate::jobs`] — and this module is its process half.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::jobs::{JobHandle, JobHooks, JobOutcome, JobOutputSink, SettledStatus};
use crate::tools::proc::{tool_env, unix_process_group};

/// Spawn `command` under `cwd` as the process half of one background bash
/// job and wire the job's hooks: `cancel` terminates the process group,
/// and the exit watcher resolves `done` with the terminal outcome
/// (`Stopped` when cancelled, `Completed` on exit 0, `Failed` otherwise —
/// always with the `exit code: N` detail). The starter stays quick and
/// non-blocking: it spawns the process and two reader threads and returns.
pub(crate) fn spawn_bash_job(
    command: &str,
    cwd: &std::path::Path,
    handle: &JobHandle,
) -> Result<JobHooks, String> {
    let guard = ProcessGuard::spawn(command, cwd, &handle.output)
        .map_err(|e| format!("spawn error: {e}"))?;

    // Exit watch: reap the child and settle the job from a detached
    // thread. `terminate` only signals — this thread is the sole reaper.
    let watch_guard = Arc::clone(&guard);
    let watch_done = handle.done.clone();
    let watcher = std::thread::Builder::new()
        .name("bash-job-exit-watch".into())
        .spawn(move || {
            let code = watch_guard.wait_exit();
            let status = if watch_guard.was_terminated() {
                SettledStatus::Stopped
            } else if code == Some(0) {
                SettledStatus::Completed
            } else {
                SettledStatus::Failed
            };
            watch_done.resolve(JobOutcome {
                status,
                detail: Some(format!("exit code: {}", code.unwrap_or(-1))),
                output: None,
            });
        });
    if watcher.is_err() {
        // No watcher means nothing would ever settle the job — tear the
        // process down and fail the start (the registry still consumed
        // the admission slot, per its contract).
        guard.terminate();
        return Err("spawn error: could not start the exit watcher".into());
    }

    let cancel_guard = Arc::clone(&guard);
    Ok(JobHooks {
        cancel: Box::new(move |_| cancel_guard.terminate()),
        done: handle.done.clone(),
    })
}

struct ProcessGuard {
    child: Mutex<Child>,
    /// Set by `terminate` before signalling — the exit watcher maps it to
    /// `Stopped` so a naturally-dying process is never mis-settled.
    terminated: AtomicBool,
}

impl ProcessGuard {
    fn spawn(
        command: &str,
        cwd: &std::path::Path,
        output: &JobOutputSink,
    ) -> std::io::Result<Arc<ProcessGuard>> {
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

        // Both streams interleave into the job's ring buffer; the buffer
        // caps itself (256 KB) and keeps both read cursors valid.
        if let Some(pipe) = child.stdout.take() {
            spawn_pipe_thread(pipe, output.clone());
        }
        if let Some(pipe) = child.stderr.take() {
            spawn_pipe_thread(pipe, output.clone());
        }

        Ok(Arc::new(ProcessGuard {
            child: Mutex::new(child),
            terminated: AtomicBool::new(false),
        }))
    }

    /// Blocking wait for the child's exit code (the exit watcher's loop).
    /// Locks are held only across `try_wait` so `terminate` can interleave.
    fn wait_exit(&self) -> Option<i32> {
        loop {
            {
                let mut child = self.child.lock().unwrap();
                match child.try_wait() {
                    Ok(Some(status)) => return status.code(),
                    Ok(None) => {}
                    Err(_) => return None,
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Terminate the process group: SIGTERM, a 500 ms grace window, then
    /// SIGKILL. Synchronous, idempotent, and never reaps — the exit
    /// watcher observes the death and resolves the job's done handle.
    fn terminate(&self) {
        self.terminated.store(true, Ordering::SeqCst);
        let live_pid = {
            let mut child = self.child.lock().unwrap();
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => None,
                Ok(None) => Some(child.id()),
            }
        };
        if let Some(pid) = live_pid {
            signal_pid(pid, Signal::Term);
            let deadline = Instant::now() + Duration::from_millis(500);
            while Instant::now() < deadline {
                let exited = {
                    self.child
                        .lock()
                        .unwrap()
                        .try_wait()
                        .ok()
                        .flatten()
                        .is_some()
                };
                if exited {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            signal_pid(pid, Signal::Kill);
        }
    }

    fn was_terminated(&self) -> bool {
        self.terminated.load(Ordering::SeqCst)
    }
}

/// Append one pipe into the job's output sink until EOF.
fn spawn_pipe_thread<R: Read + Send + 'static>(pipe: R, output: JobOutputSink) {
    std::thread::spawn(move || {
        let mut pipe = pipe;
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => output.append(&String::from_utf8_lossy(&chunk[..n])),
            }
        }
    });
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
    let mut command = Command::new("taskkill");
    command.args(["/pid", &pid.to_string(), "/T", "/F"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(crate::tools::proc::CREATE_NO_WINDOW);
    }
    let _ = command.status();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{global_job_registry, JobStart, Reader};
    use protocol::model::BackgroundWorkKind;

    fn session(tag: &str) -> String {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        format!(
            "bash-guard-{}-{}",
            tag,
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        )
    }

    fn start_bash(session_id: &str, command: &str) -> protocol::model::BackgroundWorkKey {
        let command = command.to_string();
        // A stable scratch cwd (the registry gives the guard no drop hook,
        // so a tempdir could vanish under a still-running process).
        let root = std::env::temp_dir();
        global_job_registry()
            .start(JobStart {
                kind: BackgroundWorkKind::Process,
                prefix: "bash",
                id: None,
                label: command.clone(),
                owner_session: session_id.to_string(),
                output_limit: None,
                streams: true,
                run: Box::new(move |handle| spawn_bash_job(&command, &root, handle)),
            })
            .unwrap()
    }

    fn wait_for_status(
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

    #[test]
    fn natural_exit_settles_completed_with_exit_code() {
        let session = session("completed");
        let key = start_bash(&session, "echo guard-echo; exit 0");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let read = global_job_registry()
                .read(&session, &key, Reader::Model)
                .unwrap();
            if read.text.contains("guard-echo") {
                break;
            }
            assert!(Instant::now() < deadline, "output never arrived");
            std::thread::sleep(Duration::from_millis(10));
        }
        let item = wait_for_status(&session, &key);
        assert_eq!(
            item.status,
            protocol::model::BackgroundWorkStatus::Completed
        );
        assert_eq!(item.detail.as_deref(), Some("exit code: 0"));
    }

    #[test]
    fn terminate_settles_stopped_and_kills_the_process() {
        let session = session("terminated");
        let key = start_bash(&session, "sleep 30");
        assert_eq!(
            global_job_registry().kill(&session, &key, None).unwrap(),
            crate::jobs::KillOutcome::Requested
        );
        let item = wait_for_status(&session, &key);
        assert_eq!(item.status, protocol::model::BackgroundWorkStatus::Stopped);
        assert!(
            item.detail
                .as_deref()
                .unwrap_or("")
                .starts_with("exit code:"),
            "{item:?}"
        );
    }

    #[test]
    fn nonzero_exit_settles_failed_with_exit_code() {
        let session = session("failed");
        let key = start_bash(&session, "exit 5");
        let item = wait_for_status(&session, &key);
        assert_eq!(item.status, protocol::model::BackgroundWorkStatus::Failed);
        assert_eq!(item.detail.as_deref(), Some("exit code: 5"));
    }
}
