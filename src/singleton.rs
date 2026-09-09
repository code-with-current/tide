//! One Tide per desktop, enforced by an exclusive lock instead of a pid file
//! race.
//!
//! The previous scheme read the holder pid, decided it was dead, and overwrote
//! the file — a read-check-write with no atomicity, so two instances starting
//! at once (the dev watcher's `open`, a double-click, two watchers) both
//! concluded they were first and both opened a window. A stale file from a
//! crashed process could also refuse a legitimate start forever.
//!
//! Holding an exclusive `flock` (Unix) or `LockFileEx` range (Windows) on the
//! lock file for the process lifetime fixes both classes: the kernel
//! arbitrates acquisition, so exactly one contender wins no matter how tightly
//! they race, and the lock evaporates when the holder dies — crash, kill, or
//! graceful exit alike. The pid written into the file is advisory only, used
//! to activate the winning instance for the user before the loser exits.

use std::{
    fs::{File, OpenOptions},
    io::{self, Seek as _, SeekFrom, Write as _},
    path::Path,
    time::{Duration, Instant},
};

/// How long [`acquire`] waits between attempts while a rival holds the lock.
const RETRY_TICK: Duration = Duration::from_millis(50);

/// The outcome of contending for the single-instance lock.
pub(crate) enum Acquisition {
    /// We hold the lock. Dropping the guard (or exiting) releases it.
    Acquired(Guard),
    /// Another live process holds it; `pid` is advisory and may be unknown.
    HeldByOther { pid: Option<i32> },
}

/// Owns the lock. Dropping releases it; the desktop app instead calls
/// [`Guard::hold_for_process_lifetime`] so the lock outlives every other
/// value in the process.
pub(crate) struct Guard {
    #[allow(unused)]
    file: File,
}

impl Guard {
    /// Leak the underlying handle so the lock is held until process exit —
    /// the kernel closes (and thereby releases) it even on abnormal death.
    pub(crate) fn hold_for_process_lifetime(self) {
        std::mem::forget(self);
    }
}

/// Contend for the lock at `lock_path`.
///
/// Tries immediately, then retries every [`RETRY_TICK`] until `retry_wait`
/// elapses — the window during which a predecessor killed by the dev watcher
/// is still tearing down and holding the lock. A `retry_wait` of zero is a
/// single attempt. I/O errors opening or locking the file are returned; a
/// rival holding the lock is not an error.
pub(crate) fn acquire(lock_path: &Path, retry_wait: Duration) -> io::Result<Acquisition> {
    let deadline = Instant::now() + retry_wait;
    loop {
        match try_lock(lock_path)? {
            Some(guard) => return Ok(Acquisition::Acquired(guard)),
            None => {
                if Instant::now() >= deadline {
                    return Ok(Acquisition::HeldByOther {
                        pid: read_holder_pid(lock_path),
                    });
                }
                std::thread::sleep(RETRY_TICK.min(deadline - Instant::now()));
            }
        }
    }
}

/// Read the holder pid recorded in the lock file. Best-effort: an empty or
/// unreadable file means the holder has not written its pid yet (or already
/// died), which callers must treat as "a rival exists, pid unknown".
pub(crate) fn read_holder_pid(lock_path: &Path) -> Option<i32> {
    let text = std::fs::read_to_string(lock_path).ok()?;
    text.trim().parse::<i32>().ok()
}

fn open_lock_file(lock_path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
}

/// Record this pid for the rival-activation path. Failure is cosmetic: the
/// lock is already held, so the next contender still blocks on the kernel.
fn record_holder_pid(file: &mut File) {
    let _ = file.set_len(0);
    let _ = file.seek(SeekFrom::Start(0));
    let _ = file.write_all(std::process::id().to_string().as_bytes());
}

/// One non-blocking attempt. `Ok(None)` means the lock is held by someone
/// else; the file itself is created on the first attempt so the winner has
/// somewhere to record its pid.
#[cfg(unix)]
fn try_lock(lock_path: &Path) -> io::Result<Option<Guard>> {
    use std::os::fd::AsRawFd;

    let mut file = open_lock_file(lock_path)?;
    // flock binds to the open file description, so every contender — even in
    // the same process — gets an independent attempt and exactly one wins.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    match result {
        0 => {
            record_holder_pid(&mut file);
            Ok(Some(Guard { file }))
        }
        _ if io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK) => Ok(None),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(windows)]
fn try_lock(lock_path: &Path) -> io::Result<Option<Guard>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{ERROR_LOCK_VIOLATION, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::{
        LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let mut file = open_lock_file(lock_path)?;
    // A zeroed OVERLAPPED is valid for a synchronous whole-file lock; the
    // range covers the entire file so no offset bookkeeping is needed.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let locked = unsafe {
        LockFileEx(
            file.as_raw_handle() as HANDLE,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if locked != 0 {
        record_holder_pid(&mut file);
        Ok(Some(Guard { file }))
    } else if io::Error::last_os_error().raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
        Ok(None)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_lock(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "tide-singleton-test-{}-{name}.lock",
            std::process::id()
        ))
    }

    #[test]
    fn a_second_contender_sees_a_rival_while_the_lock_is_held() {
        let path = temp_lock("rival");
        let _ = std::fs::remove_file(&path);

        let guard = match acquire(&path, Duration::ZERO).expect("first acquire") {
            Acquisition::Acquired(guard) => guard,
            _ => panic!("uncontended lock must be acquired"),
        };
        match acquire(&path, Duration::ZERO).expect("second acquire") {
            Acquisition::HeldByOther { pid } => {
                assert_eq!(pid, Some(std::process::id() as i32));
            }
            Acquisition::Acquired(_) => panic!("a held lock must block a rival"),
        }

        drop(guard);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn dropping_the_guard_releases_the_lock() {
        let path = temp_lock("release");
        let _ = std::fs::remove_file(&path);

        match acquire(&path, Duration::ZERO).expect("first acquire") {
            Acquisition::Acquired(guard) => drop(guard),
            _ => panic!("uncontended lock must be acquired"),
        }
        assert!(matches!(
            acquire(&path, Duration::ZERO).expect("second acquire"),
            Acquisition::Acquired(_)
        ));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_holder_pid_is_readable_from_the_lock_file() {
        let path = temp_lock("pid");
        let _ = std::fs::remove_file(&path);

        let guard = match acquire(&path, Duration::ZERO).expect("acquire") {
            Acquisition::Acquired(guard) => guard,
            _ => panic!("uncontended lock must be acquired"),
        };
        assert_eq!(read_holder_pid(&path), Some(std::process::id() as i32));

        drop(guard);
        let _ = std::fs::remove_file(&path);
    }
}
