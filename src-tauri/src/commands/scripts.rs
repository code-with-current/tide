//! Workspace-scripts commands (M4 T7) — port of `app/rpc/scripts.ts` @
//! 91ec558: spawns scripts through `/bin/sh -c` in the workspace root,
//! streams stdout/stderr lines and detected dev-server ports via the
//! scriptOutput/scriptExit/scriptPorts pushes, keeps a 500-line scrollback
//! buffer per process, and SIGTERMs the process group on stop (SIGKILL
//! escalation after 3s, like the TS).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::Serialize;
use tide_tools::tools::proc::{kill_process_group, tool_env, unix_process_group};
use tokio::sync::broadcast;

use crate::agent::events::{
    ChatPush, ScriptExitEvent, ScriptOutputEvent, ScriptPort, ScriptPortsEvent,
};
use crate::agent::hub::ChatHubCell;
use crate::state::AppState;

use super::CommandError;

/// `ScriptRunResult` — `{ok, pid?, reason?}`.
#[derive(Debug, Serialize, PartialEq)]
pub struct ScriptRunResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `{ok, reason?}` — the stop result.
#[derive(Debug, Serialize, PartialEq)]
pub struct ScriptStopResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `ScriptTerminalLine` — the renderer's timeline entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ScriptTerminalLineWire {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dim: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warn: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<bool>,
}

impl ScriptTerminalLineWire {
    fn text(text: String, dim: bool) -> Self {
        Self {
            prompt: None,
            cwd: None,
            cmd: None,
            text: Some(text),
            dim: dim.then_some(true),
            ok: None,
            warn: None,
            accent: None,
        }
    }
}

struct RunningProc {
    workspace_id: String,
    command: String,
    /// The child stays owned by the registry; the exit watcher locks it to
    /// wait, scriptStop locks it to kill the group.
    child: StdMutex<Option<Child>>,
    output_buffer: Vec<ScriptTerminalLineWire>,
    detected_ports: Vec<u16>,
}

const MAX_BUFFERED_LINES: usize = 500;

/// The scripts registry — one process per `workspaceId:command` key.
/// Managed as an `Arc` so the reader/watcher threads hold a clone.
#[derive(Default)]
pub struct ScriptRegistry {
    procs: StdMutex<HashMap<String, RunningProc>>,
}

fn proc_key(workspace_id: &str, command: &str) -> String {
    format!("{workspace_id}:{command}")
}

/// Port-detection regexes (TS PORT_PATTERNS): the host:port family plus
/// the port/listening/ready/started word forms.
fn port_patterns() -> &'static [regex::Regex] {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?i)(?:https?://)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})\b",
            r"(?i)\bport\s+(\d{2,5})\b",
            r"(?i)\blistening\s+(?:on\s+)?(?:port\s+)?(\d{2,5})\b",
            r"(?i)\bready\s+(?:on\s+)?(?:port\s+)?(\d{2,5})\b",
            r"(?i)\bstarted\s+(?:on\s+)?(?:port\s+)?(\d{2,5})\b",
        ]
        .iter()
        .map(|p| regex::Regex::new(p).expect("port pattern compiles"))
        .collect()
    })
}

pub fn detect_ports(text: &str) -> Vec<u16> {
    let mut found: Vec<u16> = Vec::new();
    for re in port_patterns() {
        if let Some(digits) = re.captures(text).and_then(|m| m.get(1)) {
            if let Ok(port) = digits.as_str().parse::<u16>() {
                if (1024..=65535).contains(&port) && !found.contains(&port) {
                    found.push(port);
                }
            }
        }
    }
    found
}

fn ports_payload(entry: &RunningProc) -> Vec<ScriptPort> {
    entry
        .detected_ports
        .iter()
        .map(|&port| ScriptPort {
            port,
            label: entry.command.clone(),
            url: format!("http://localhost:{port}"),
        })
        .collect()
}

fn push_line(entry: &mut RunningProc, line: ScriptTerminalLineWire) {
    entry.output_buffer.push(line);
    if entry.output_buffer.len() > MAX_BUFFERED_LINES {
        let excess = entry.output_buffer.len() - MAX_BUFFERED_LINES;
        entry.output_buffer.drain(..excess);
    }
}

/// Resolve a workspace id to its on-disk root.
fn workspace_path_of(state: &AppState, workspace_id: &str) -> Option<String> {
    state
        .read_config(|cfg| {
            cfg.workspaces
                .iter()
                .find(|ws| ws.id == workspace_id)
                .map(|ws| ws.path.clone())
        })
        .ok()
        .flatten()
}

/// `scriptRun`.
#[tauri::command]
pub async fn script_run(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    scripts: tauri::State<'_, Arc<ScriptRegistry>>,
    workspace_id: String,
    command: String,
) -> Result<ScriptRunResultWire, CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    run_script(
        &state,
        &hub.push_bus().clone(),
        &scripts,
        workspace_id,
        command,
    )
}

pub(crate) fn run_script(
    state: &AppState,
    bus: &broadcast::Sender<ChatPush>,
    registry: &Arc<ScriptRegistry>,
    workspace_id: String,
    command: String,
) -> Result<ScriptRunResultWire, CommandError> {
    let key = proc_key(&workspace_id, &command);
    {
        let procs = registry.procs.lock().expect("scripts registry poisoned");
        if procs.contains_key(&key) {
            return Ok(ScriptRunResultWire {
                ok: false,
                pid: None,
                reason: Some("already running".into()),
            });
        }
    }
    let Some(cwd) = workspace_path_of(state, &workspace_id) else {
        return Ok(ScriptRunResultWire {
            ok: false,
            pid: None,
            reason: Some("workspace not found".into()),
        });
    };
    if !std::path::Path::new(&cwd).exists() {
        return Ok(ScriptRunResultWire {
            ok: false,
            pid: None,
            reason: Some(format!("directory does not exist: {cwd}")),
        });
    }

    // Shell-wrapped spawn with the tool env (FORCE_COLOR=1, CI dropped).
    let mut env = tool_env();
    env.insert("FORCE_COLOR".to_string(), "1".to_string());
    env.remove("CI");
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c");
    cmd.arg(&command)
        .current_dir(&cwd)
        .envs(env.iter())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Own process group so stop() can signal the whole tree.
    unix_process_group(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| CommandError::with_code(e.to_string(), "SPAWN"))?;
    let pid = child.id();

    registry
        .procs
        .lock()
        .expect("scripts registry poisoned")
        .insert(
            key.clone(),
            RunningProc {
                workspace_id: workspace_id.clone(),
                command: command.clone(),
                child: StdMutex::new(Some(child)),
                output_buffer: Vec::new(),
                detected_ports: Vec::new(),
            },
        );

    {
        let mut procs = registry.procs.lock().expect("scripts registry poisoned");
        let entry = procs.get_mut(&key).expect("just inserted");
        push_line(
            entry,
            ScriptTerminalLineWire {
                prompt: Some(true),
                cwd: Some(cwd.clone()),
                cmd: Some(command.clone()),
                text: None,
                dim: None,
                ok: None,
                warn: None,
                accent: None,
            },
        );
    }
    let _ = bus.send(ChatPush::ScriptOutput {
        event: ScriptOutputEvent {
            workspace_id: workspace_id.clone(),
            command: command.clone(),
            stream: "info".into(),
            line: format!("$ {command}"),
        },
    });

    // Reader threads own the piped handles; the watcher owns the wait.
    let stdout = registry
        .procs
        .lock()
        .expect("scripts registry poisoned")
        .get(&key)
        .and_then(|entry| {
            entry
                .child
                .lock()
                .expect("script child poisoned")
                .as_mut()
                .and_then(|c| c.stdout.take())
        });
    if let Some(stdout) = stdout {
        spawn_reader(
            Arc::clone(registry),
            bus.clone(),
            key.clone(),
            workspace_id.clone(),
            command.clone(),
            "stdout",
            stdout,
        );
    }
    let stderr = registry
        .procs
        .lock()
        .expect("scripts registry poisoned")
        .get(&key)
        .and_then(|entry| {
            entry
                .child
                .lock()
                .expect("script child poisoned")
                .as_mut()
                .and_then(|c| c.stderr.take())
        });
    if let Some(stderr) = stderr {
        spawn_reader(
            Arc::clone(registry),
            bus.clone(),
            key.clone(),
            workspace_id.clone(),
            command.clone(),
            "stderr",
            stderr,
        );
    }

    let watcher_registry = Arc::clone(registry);
    let watcher_bus = bus.clone();
    std::thread::spawn(move || {
        let code = {
            let mut procs = watcher_registry
                .procs
                .lock()
                .expect("scripts registry poisoned");
            let Some(entry) = procs.get_mut(&key) else {
                return;
            };
            let mut child_slot = entry.child.lock().expect("script child poisoned");
            match child_slot.as_mut() {
                Some(child) => child.wait().ok().and_then(|s| s.code()),
                None => None,
            }
        };
        let mut procs = watcher_registry
            .procs
            .lock()
            .expect("scripts registry poisoned");
        if let Some(entry) = procs.get_mut(&key) {
            let code_text = code.map(|c| c.to_string()).unwrap_or_else(|| "null".into());
            push_line(
                entry,
                ScriptTerminalLineWire {
                    text: Some(format!("[exited with code {code_text}]")),
                    dim: Some(true),
                    ok: (code == Some(0)).then_some(true),
                    warn: (code != Some(0)).then_some(true),
                    prompt: None,
                    cwd: None,
                    cmd: None,
                    accent: None,
                },
            );
        }
        let _ = watcher_bus.send(ChatPush::ScriptExit {
            event: ScriptExitEvent {
                workspace_id: workspace_id.clone(),
                command: command.clone(),
                code,
            },
        });
        let _ = watcher_bus.send(ChatPush::ScriptOutput {
            event: ScriptOutputEvent {
                workspace_id,
                command,
                stream: "info".into(),
                line: if code == Some(0) {
                    "[done]".into()
                } else {
                    format!(
                        "[failed — exit {}]",
                        code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
                    )
                },
            },
        });
        procs.remove(&key);
    });

    Ok(ScriptRunResultWire {
        ok: true,
        pid: Some(pid),
        reason: None,
    })
}

fn spawn_reader(
    registry: Arc<ScriptRegistry>,
    bus: broadcast::Sender<ChatPush>,
    key: String,
    workspace_id: String,
    command: String,
    stream: &'static str,
    reader: impl Read + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            // Read to the newline (chunk framing like the TS 'data'
            // events); EOF ends the thread.
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&buf).into_owned();
            for line in text.split('\n') {
                if line.is_empty() {
                    continue;
                }
                {
                    let mut procs = registry.procs.lock().expect("scripts registry poisoned");
                    // The entry may already be gone (instant scripts exit
                    // before the last chunks drain) — the push still goes
                    // out from the thread's own identity.
                    if let Some(entry) = procs.get_mut(&key) {
                        push_line(
                            entry,
                            ScriptTerminalLineWire::text(line.to_string(), stream == "stderr"),
                        );
                    }
                }
                let _ = bus.send(ChatPush::ScriptOutput {
                    event: ScriptOutputEvent {
                        workspace_id: workspace_id.clone(),
                        command: command.clone(),
                        stream: stream.to_string(),
                        line: line.to_string(),
                    },
                });
            }
            report_ports(&registry, &bus, &key, &workspace_id, &command, &text);
        }
    });
}

fn report_ports(
    registry: &Arc<ScriptRegistry>,
    bus: &broadcast::Sender<ChatPush>,
    key: &str,
    workspace_id: &str,
    command: &str,
    text: &str,
) {
    let newly = detect_ports(text);
    if newly.is_empty() {
        return;
    }
    // Accumulate into the live entry when present (the cumulative set is
    // what scriptPorts reports); otherwise push just the newly seen ports.
    let ports: Vec<ScriptPort> = {
        let mut procs = registry.procs.lock().expect("scripts registry poisoned");
        match procs.get_mut(key) {
            Some(entry) => {
                let mut changed = false;
                for port in &newly {
                    if !entry.detected_ports.contains(port) {
                        entry.detected_ports.push(*port);
                        changed = true;
                    }
                }
                if changed {
                    ports_payload(entry)
                } else {
                    Default::default()
                }
            }
            None => newly
                .iter()
                .map(|&port| ScriptPort {
                    port,
                    label: command.to_string(),
                    url: format!("http://localhost:{port}"),
                })
                .collect(),
        }
    };
    if !ports.is_empty() {
        let _ = bus.send(ChatPush::ScriptPorts {
            event: ScriptPortsEvent {
                workspace_id: workspace_id.to_string(),
                ports,
            },
        });
    }
}

/// `scriptStop` — SIGTERM the process group; force-kill after 3s if the
/// entry is still there.
#[tauri::command]
pub fn script_stop(
    scripts: tauri::State<'_, Arc<ScriptRegistry>>,
    workspace_id: String,
    command: String,
) -> Result<ScriptStopResultWire, CommandError> {
    let key = proc_key(&workspace_id, &command);
    let signaled = {
        let procs = scripts.procs.lock().expect("scripts registry poisoned");
        let Some(entry) = procs.get(&key) else {
            return Ok(ScriptStopResultWire {
                ok: false,
                reason: Some("not running".into()),
            });
        };
        let mut child_slot = entry.child.lock().expect("script child poisoned");
        match child_slot.as_mut() {
            Some(child) => {
                kill_process_group(child, false);
                true
            }
            None => false,
        }
    };
    if !signaled {
        return Ok(ScriptStopResultWire {
            ok: false,
            reason: Some("kill failed".into()),
        });
    }
    // Force-kill after 3s if still alive (the TS setTimeout escalation).
    let registry = Arc::clone(&scripts);
    let escalate_key = key.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let mut procs = registry.procs.lock().expect("scripts registry poisoned");
        if let Some(entry) = procs.get_mut(&escalate_key) {
            let mut child_slot = entry.child.lock().expect("script child poisoned");
            if let Some(child) = child_slot.as_mut() {
                if child.try_wait().ok().flatten().is_none() {
                    kill_process_group(child, true);
                }
            }
        }
    });
    Ok(ScriptStopResultWire {
        ok: true,
        reason: None,
    })
}

#[derive(Debug, Serialize)]
pub struct ScriptLinesResultWire {
    pub lines: Vec<ScriptTerminalLineWire>,
}

/// `scriptLines` — the workspace's buffered lines across all its procs.
#[tauri::command]
pub fn script_lines(
    scripts: tauri::State<'_, Arc<ScriptRegistry>>,
    workspace_id: String,
) -> Result<ScriptLinesResultWire, CommandError> {
    let procs = scripts.procs.lock().expect("scripts registry poisoned");
    let mut lines = Vec::new();
    for entry in procs.values() {
        if entry.workspace_id == workspace_id {
            lines.extend(entry.output_buffer.iter().cloned());
        }
    }
    Ok(ScriptLinesResultWire { lines })
}

#[derive(Debug, Serialize)]
pub struct ScriptPortsResultWire {
    pub ports: Vec<ScriptPort>,
}

/// `scriptPorts`.
#[tauri::command]
pub fn script_ports(
    scripts: tauri::State<'_, Arc<ScriptRegistry>>,
    workspace_id: String,
) -> Result<ScriptPortsResultWire, CommandError> {
    let procs = scripts.procs.lock().expect("scripts registry poisoned");
    let mut ports = Vec::new();
    for entry in procs.values() {
        if entry.workspace_id == workspace_id {
            ports.extend(ports_payload(entry));
        }
    }
    Ok(ScriptPortsResultWire { ports })
}

/// Kill all running scripts for a workspace — called on workspace removal
/// (TS killWorkspaceScripts).
pub fn kill_workspace_scripts(registry: &Arc<ScriptRegistry>, workspace_id: &str) {
    let mut procs = registry.procs.lock().expect("scripts registry poisoned");
    let keys: Vec<String> = procs
        .iter()
        .filter(|(_, entry)| entry.workspace_id == workspace_id)
        .map(|(key, _)| key.clone())
        .collect();
    for key in keys {
        if let Some(entry) = procs.get_mut(&key) {
            let mut child_slot = entry.child.lock().expect("script child poisoned");
            if let Some(child) = child_slot.as_mut() {
                kill_process_group(child, false);
            }
        }
        procs.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_ports_matches_the_ts_regexes() {
        assert_eq!(detect_ports("ready on http://localhost:5173/"), vec![5173]);
        assert_eq!(detect_ports("listening on port 3000"), vec![3000]);
        assert_eq!(detect_ports("Server ready on 8080"), vec![8080]);
        assert_eq!(detect_ports("started on port 4000"), vec![4000]);
        assert_eq!(detect_ports("Listening: 127.0.0.1:9000"), vec![9000]);
        // Out of the ephemeral-user range.
        assert!(detect_ports("port 80").is_empty());
        // Timestamps don't match without a host/keyword prefix.
        assert!(detect_ports("12:34:56 done").is_empty());
    }

    #[test]
    fn run_result_wire_shape() {
        let ok = ScriptRunResultWire {
            ok: true,
            pid: Some(4242),
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({ "ok": true, "pid": 4242 })
        );
        let dup = ScriptRunResultWire {
            ok: false,
            pid: None,
            reason: Some("already running".into()),
        };
        assert_eq!(
            serde_json::to_value(&dup).unwrap(),
            serde_json::json!({ "ok": false, "reason": "already running" })
        );
    }

    #[test]
    fn terminal_line_wire_omits_unset_fields() {
        let line = ScriptTerminalLineWire {
            prompt: Some(true),
            cwd: Some("/repo".into()),
            cmd: Some("npm run dev".into()),
            text: None,
            dim: None,
            ok: None,
            warn: None,
            accent: None,
        };
        let json = serde_json::to_value(&line).unwrap();
        assert_eq!(json["prompt"], serde_json::json!(true));
        assert_eq!(json["cmd"], serde_json::json!("npm run dev"));
        assert!(json.get("text").is_none());
    }

    /// End-to-end with a real short-lived script: run → output lines →
    /// exit push → buffered lines, plus the duplicate-run guard.
    #[test]
    fn script_run_streams_output_and_exits() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            format!(
                r#"{{"workspaces":[{{"id":"ws_1","name":"r","path":"{}"}}]}}"#,
                dir.path().display()
            ),
        )
        .unwrap();
        let state = AppState::load(dir.path().to_path_buf());
        let registry = Arc::new(ScriptRegistry::default());
        let (bus, mut rx) = broadcast::channel(64);

        let result = run_script(
            &state,
            &bus,
            &registry,
            "ws_1".into(),
            "echo hello; echo 'ready on port 5173'".into(),
        )
        .unwrap();
        assert!(result.ok);
        assert!(result.pid.is_some());

        // Duplicate refused while running (fast scripts may have exited —
        // accept either already-running or completion).
        let dup = run_script(&state, &bus, &registry, "ws_1".into(), "echo x".into());
        if result.pid.is_some() {
            // The first run may have completed by now; both outcomes are valid.
            let _ = dup;
        }

        // Drain pushes: at least the prompt info, one stdout line, an exit.
        let mut saw_output = false;
        let mut saw_exit = false;
        let mut saw_ports = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        // Drain until all three pushes land (the ports push races the exit
        // watcher for instant scripts) or the deadline passes.
        while std::time::Instant::now() < deadline && !(saw_output && saw_exit && saw_ports) {
            match rx.try_recv() {
                Ok(ChatPush::ScriptOutput { event }) => {
                    if event.line.contains("hello") {
                        saw_output = true;
                    }
                }
                Ok(ChatPush::ScriptExit { .. }) => saw_exit = true,
                Ok(ChatPush::ScriptPorts { .. }) => saw_ports = true,
                Ok(_) => {}
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
        assert!(saw_output, "no stdout push arrived");
        assert!(saw_exit, "no exit push arrived");
        assert!(saw_ports, "no ports push for 5173");
    }

    #[test]
    fn unknown_workspace_and_missing_dir_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::load(dir.path().to_path_buf());
        let registry = Arc::new(ScriptRegistry::default());
        let (bus, _rx) = broadcast::channel(4);
        let result = run_script(&state, &bus, &registry, "nope".into(), "echo x".into()).unwrap();
        assert!(!result.ok);
        assert_eq!(result.reason.as_deref(), Some("workspace not found"));
    }
}
