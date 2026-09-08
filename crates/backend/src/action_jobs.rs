//! UI-initiated project action runs: session-owned background jobs that
//! survive daemon restarts.
//!
//! Runs register in the global job registry under the owning session's
//! id, so the orchestrator's job_list/job_output reach them and the jobs
//! UI scopes them like any other background work. Output is redirected to
//! per-run log files (a pipe would die with the daemon; a file lets a
//! restarted daemon re-adopt a still-running process and keep streaming
//! its log), and run records (`pgid`, command, log path, session) persist
//! to `~/.tide/action-runs.json` so adoption restores the same owner.
//! Stop is SIGINT with SIGKILL escalation.

use std::io::Read;
use std::os::unix::process::CommandExt as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use tools::jobs::{JobHandle, JobHooks, JobOutcome, JobStart, SettledStatus, global_job_registry};

/// How long a stopped run gets to exit on SIGINT before SIGKILL.
const STOP_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRunRecord {
    pub job_id: String,
    pub session_id: String,
    pub project_id: String,
    pub project_path: String,
    pub action_name: String,
    pub command: String,
    pub pgid: i32,
    pub log_path: String,
    pub started_at: i64,
    /// The port the OS probe saw the group listening on, when discovered.
    pub port: Option<u16>,
}

fn records_path() -> PathBuf {
    store::paths::data_dir().join("action-runs.json")
}

fn logs_dir() -> PathBuf {
    store::paths::data_dir().join("action-logs")
}

fn load_records() -> Vec<ActionRunRecord> {
    std::fs::read_to_string(records_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_records(records: &[ActionRunRecord]) {
    let path = records_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(records) {
        let _ = std::fs::write(path, text);
    }
}

fn drop_record(job_id: &str) {
    let mut records = load_records();
    let before = records.len();
    records.retain(|record| record.job_id != job_id);
    if records.len() != before {
        save_records(&records);
    }
}

fn drop_records_for_group(pgid: i32) {
    let mut records = load_records();
    let before = records.len();
    records.retain(|record| record.pgid != pgid);
    if records.len() != before {
        save_records(&records);
    }
}

fn unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn group_alive(pgid: i32) -> bool {
    // Signal 0 probes existence without delivering anything.
    unsafe { libc::kill(-pgid, 0) == 0 }
}

fn signal_group(pgid: i32, signal: i32) {
    unsafe {
        libc::kill(-pgid, signal);
    }
}

/// Ask the OS which TCP port the run's process group is listening on:
/// `pgrep -g` enumerates the group's pids (sh → pnpm → node …), `lsof`
/// reports their LISTENing sockets. Works for servers that never print
/// their URL; returns the first listening port found.
fn probe_group_port(pgid: i32) -> Option<u16> {
    let pids = std::process::Command::new("pgrep")
        .arg("-g")
        .arg(pgid.to_string())
        .output()
        .ok()?;
    let pid_list = String::from_utf8_lossy(&pids.stdout)
        .split_whitespace()
        .take(64)
        .collect::<Vec<_>>()
        .join(",");
    if pid_list.is_empty() {
        return None;
    }
    let listening = std::process::Command::new("lsof")
        .args(["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-F", "P"])
        .arg("-p")
        .arg(pid_list)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&listening.stdout);
    text.lines()
        .find_map(|line| line.strip_prefix('P'))
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port != 0)
}

/// Remember a discovered port on the run's record.
fn record_port(job_id: &str, port: u16) {
    let mut records = load_records();
    if let Some(record) = records.iter_mut().find(|record| record.job_id == job_id) {
        if record.port != Some(port) {
            record.port = Some(port);
            save_records(&records);
        }
    }
}

/// Probe the group every couple of seconds until it exposes a port. Runs
/// alongside the exit watcher; ends when the group dies.
fn spawn_port_probe(pgid: i32, job_id: String) {
    std::thread::spawn(move || {
        loop {
            if !group_alive(pgid) {
                return;
            }
            if let Some(port) = probe_group_port(pgid) {
                record_port(&job_id, port);
                return;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

/// SIGINT now, SIGKILL the group after a grace window if it still lives.
fn request_stop(pgid: i32) {
    signal_group(pgid, libc::SIGINT);
    std::thread::spawn(move || {
        std::thread::sleep(STOP_GRACE);
        if group_alive(pgid) {
            signal_group(pgid, libc::SIGKILL);
        }
    });
}

/// Feed the log file into the job's output ring, from `offset` onward.
fn spawn_log_tailer(log_path: PathBuf, offset: u64, sink: tools::jobs::JobOutputSink) {
    std::thread::spawn(move || {
        let mut file = match std::fs::File::open(&log_path) {
            Ok(file) => file,
            Err(_) => return,
        };
        use std::io::Seek as _;
        if file.seek(std::io::SeekFrom::Start(offset)).is_err() {
            return;
        }
        let mut buffer = [0u8; 4096];
        loop {
            match file.read(&mut buffer) {
                Ok(0) => std::thread::sleep(Duration::from_millis(250)),
                Ok(read) => sink.append(&String::from_utf8_lossy(&buffer[..read])),
                Err(_) => break,
            }
        }
    });
}

/// Watch a live child: resolve `done` when it exits, drop its record.
fn watch_child(
    mut child: std::process::Child,
    pgid: i32,
    stop_requested: std::sync::Arc<std::sync::atomic::AtomicBool>,
    done: tools::jobs::JobDone,
) {
    let status = if stop_requested.load(std::sync::atomic::Ordering::SeqCst) {
        SettledStatus::Stopped
    } else if child
        .wait()
        .ok()
        .and_then(|status| status.code())
        .is_some_and(|code| code == 0)
    {
        SettledStatus::Completed
    } else {
        SettledStatus::Failed
    };
    drop_records_for_group(pgid);
    done.resolve(JobOutcome {
        status,
        detail: None,
        output: None,
        usage: None,
    });
}

/// Start one action run: process group, log file, registry job, record.
pub fn start(
    session_id: &str,
    project_id: &str,
    project_path: &str,
    action_name: &str,
    command: &str,
) -> Result<String, String> {
    let job_id = format!("action-{}", uuid::Uuid::new_v4().simple());
    let log_path = logs_dir().join(format!("{job_id}.log"));
    std::fs::create_dir_all(logs_dir()).map_err(|error| error.to_string())?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    let child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(project_path)
        .stdin(Stdio::null())
        // Files, not pipes: the writers survive a daemon restart.
        .stdout(log.try_clone().map_err(|error| error.to_string())?)
        .stderr(log)
        .process_group(0)
        .spawn()
        .map_err(|error| error.to_string())?;
    let pgid = child.id() as i32;

    let mut records = load_records();
    records.push(ActionRunRecord {
        job_id: job_id.clone(),
        session_id: session_id.to_owned(),
        project_id: project_id.to_owned(),
        project_path: project_path.to_owned(),
        action_name: action_name.to_owned(),
        command: command.to_owned(),
        pgid,
        log_path: log_path.to_string_lossy().into_owned(),
        started_at: unix_ms(),
        port: None,
    });
    save_records(&records);

    let stop_requested = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let tail_log = log_path.clone();
    let probe_job_id = job_id.clone();
    global_job_registry()
        .start(JobStart {
            kind: protocol::model::BackgroundWorkKind::Process,
            prefix: "bash",
            id: Some(job_id.clone()),
            label: format!("{action_name}: {command}"),
            owner_session: session_id.to_owned(),
            output_limit: None,
            streams: true,
            run: Box::new(move |handle: &JobHandle| {
                spawn_log_tailer(tail_log.clone(), 0, handle.output.clone());
                let done = handle.done.clone();
                let stop_flag = stop_requested.clone();
                spawn_port_probe(pgid, probe_job_id);
                std::thread::spawn(move || {
                    watch_child(child, pgid, stop_requested, done);
                });
                Ok(JobHooks {
                    cancel: Box::new(move |_| {
                        stop_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                        request_stop(pgid);
                    }),
                    done: handle.done.clone(),
                })
            }),
        })
        .map_err(|error| error.to_string())?;
    Ok(job_id)
}

/// Stop a run: SIGINT the group, escalate to SIGKILL, settle the job.
pub fn stop(session_id: &str, job_id: &str) -> Result<(), String> {
    let key = protocol::model::BackgroundWorkKey::new(
        protocol::model::BackgroundWorkKind::Process,
        job_id,
    );
    global_job_registry()
        .kill(
            session_id,
            &key,
            Some("stopped from the actions row".into()),
        )
        .map_err(|error| error.to_string())?;
    // A run whose watcher already died still gets its record pruned when
    // the group is gone.
    let records = load_records();
    if let Some(record) = records.iter().find(|record| record.job_id == job_id) {
        if !group_alive(record.pgid) {
            drop_record(job_id);
        }
    }
    Ok(())
}

/// The session's action jobs for the UI poll.
pub fn list(
    session_id: &str,
) -> (
    Vec<protocol::model::BackgroundWorkItem>,
    Vec<protocol::model::ActionRunWire>,
) {
    // The item list alone carries no output (bytes flow through the read
    // cursors, which need a runtime); the poll ships a snapshot tail so
    // the UI and the port scan see the log before any message is sent.
    // Records fill the display fields: the action name titles the row —
    // never the job id.
    let registry = global_job_registry();
    let records: std::collections::HashMap<String, ActionRunRecord> = load_records()
        .into_iter()
        .map(|record| (record.job_id.clone(), record))
        .collect();
    let items = registry
        .list_session(session_id)
        .into_iter()
        .filter(|item| {
            item.key.kind == protocol::model::BackgroundWorkKind::Process
                && item.key.provider_id.starts_with("action-")
        })
        .map(|mut item| {
            item.output = registry
                .output_snapshot(session_id, &item.key, 32 * 1024)
                .filter(|tail| !tail.is_empty());
            if let Some(record) = records.get(&item.key.provider_id) {
                item.title = record.action_name.clone();
                item.command = Some(record.command.clone());
                item.cwd = Some(record.project_path.clone());
            }
            item.background = true;
            item.can_stop = item.status.is_stoppable();
            item
        })
        .collect::<Vec<_>>();
    // The seed wires for UI row state: one per live job with a record.
    let runs = items
        .iter()
        .filter(|item| item.status.is_live())
        .filter_map(|item| {
            let record = records.get(&item.key.provider_id)?;
            Some(protocol::model::ActionRunWire {
                job_id: record.job_id.clone(),
                session_id: record.session_id.clone(),
                project_id: record.project_id.clone(),
                action_name: record.action_name.clone(),
                port: record.port,
            })
        })
        .collect::<Vec<_>>();
    (items, runs)
}

/// On daemon start: re-adopt runs whose process survived the restart, and
/// prune records for ones that did not. The record's session id restores
/// the original owner, so job_list and the jobs UI scope the run again.
pub fn adopt_orphans() {
    let records = load_records();
    let mut live = Vec::new();
    for record in records {
        if !group_alive(record.pgid) {
            continue;
        }
        let log_path = PathBuf::from(&record.log_path);
        let offset = std::fs::metadata(&log_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        let pgid = record.pgid;
        let job_id = record.job_id.clone();
        let started = global_job_registry().start(JobStart {
            kind: protocol::model::BackgroundWorkKind::Process,
            prefix: "bash",
            id: Some(job_id.clone()),
            label: format!("{}: {}", record.action_name, record.command),
            owner_session: record.session_id.clone(),
            output_limit: None,
            streams: true,
            run: Box::new(move |handle: &JobHandle| {
                spawn_log_tailer(log_path.clone(), offset, handle.output.clone());
                let done = handle.done.clone();
                let probe_job_id = job_id.clone();
                spawn_port_probe(pgid, probe_job_id);
                std::thread::spawn(move || {
                    // Adopted runs have no child handle: watch the group.
                    while group_alive(pgid) {
                        std::thread::sleep(Duration::from_secs(2));
                    }
                    drop_records_for_group(pgid);
                    done.resolve(JobOutcome {
                        status: SettledStatus::Completed,
                        detail: Some("daemon restarted; run continued".into()),
                        output: None,
                        usage: None,
                    });
                });
                Ok(JobHooks {
                    cancel: Box::new(move |_| {
                        request_stop(pgid);
                    }),
                    done: handle.done.clone(),
                })
            }),
        });
        if started.is_ok() {
            live.push(record);
        }
    }
    save_records(&live);
}
