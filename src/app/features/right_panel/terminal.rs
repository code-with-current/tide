//! The Terminal surface: lazy terminal construction and action-output
//! capture helpers.

use std::sync::{Arc, Mutex};

use gpui::Context;
use gpui::prelude::*;

use crate::app::Tide;

use crate::app::RightPanelSurface;
use crate::terminal::TerminalView;
use std::collections::HashSet;
use uuid::Uuid;
impl Tide {
    pub(in crate::app) fn ensure_right_panel_terminal(
        &mut self,
        terminal_id: Uuid,
        cx: &mut Context<Self>,
    ) {
        if self.daemon.is_remote() {
            // A desktop PTY would interpret the daemon's cwd on the wrong
            // machine. Keep the surface unavailable until the protocol grows
            // a daemon-owned streaming terminal.
            self.right_panel_terminals.remove(&terminal_id);
            return;
        }
        let Some(working_directory) = self
            .selected_workspace_path()
            .map(std::path::Path::to_path_buf)
        else {
            self.right_panel_terminals.remove(&terminal_id);
            return;
        };
        let matches_project = self
            .right_panel_terminals
            .get(&terminal_id)
            .is_some_and(|terminal| terminal.read(cx).working_directory() == working_directory);
        if !matches_project {
            let view = cx.new(|cx| TerminalView::new(working_directory.clone(), cx));
            // File links open in Tide's file viewer, not the file manager.
            let weak = cx.entity().downgrade();
            view.update(cx, |terminal, _| {
                terminal.set_open_file_handler(std::rc::Rc::new(move |path, _window, cx| {
                    let _ = weak.update(cx, |tide, cx| {
                        tide.open_transcript_link(&path.to_string_lossy(), cx);
                    });
                }));
            });
            self.right_panel_terminals.insert(terminal_id, view);
        }
    }

    pub(in crate::app) fn ensure_right_panel_terminals(&mut self, cx: &mut Context<Self>) {
        let active_terminal_ids = self
            .right_panel_surfaces
            .iter()
            .filter_map(RightPanelSurface::terminal_id)
            .collect::<Vec<_>>();
        let retained_terminal_ids = active_terminal_ids
            .iter()
            .copied()
            .chain(self.right_panel_session_states.values().flat_map(|state| {
                state
                    .surfaces
                    .iter()
                    .filter_map(RightPanelSurface::terminal_id)
            }))
            .collect::<HashSet<_>>();
        self.right_panel_terminals
            .retain(|terminal_id, _| retained_terminal_ids.contains(terminal_id));
        for terminal_id in active_terminal_ids {
            self.ensure_right_panel_terminal(terminal_id, cx);
        }
    }
}

pub(in crate::app) fn scan_exposed_port(text: &str) -> Option<u16> {
    // Strip ANSI SGR sequences first — servers colorize their URL lines.
    let stripped = strip_ansi(text);
    for line in stripped.lines() {
        for needle in ["localhost:", "127.0.0.1:", "0.0.0.0:"] {
            let Some(index) = line.find(needle) else {
                continue;
            };
            let digits: String = line[index + needle.len()..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(port) = digits.parse::<u16>() {
                if port != 0 {
                    return Some(port);
                }
            }
        }
    }
    None
}

/// Remove ANSI escape sequences (`ESC [ ... m` and friends).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

const MAX_ACTION_OUTPUT_BYTES: usize = 512 * 1024;

/// Append one read of an action run's output stream to the shared buffer,
/// keeping only the tail of a huge log.
fn pump_action_output<R: std::io::Read>(mut stream: R, output: Arc<Mutex<String>>) {
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let mut out = output
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                out.push_str(&String::from_utf8_lossy(&buffer[..read]));
                let excess = out.len().saturating_sub(MAX_ACTION_OUTPUT_BYTES / 2);
                if excess > 0 {
                    out.drain(..excess);
                }
            }
        }
    }
}

/// Temporary diagnostics for the action-run path; appends to a file because
/// the launched app's stderr is not captured by the dev watcher.
pub(in crate::app) fn action_debug(msg: impl std::fmt::Display) {
    use std::io::Write as _;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/tide-action-debug.log")
    {
        let _ = writeln!(file, "{msg}");
    }
}
