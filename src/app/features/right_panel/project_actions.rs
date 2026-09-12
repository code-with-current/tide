//! Project action runs: run/stop/inspect lifecycle for the actions a project
//! declares, plus the output-port scan that powers Open-in-browser.

use gpui::Context;
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::app::features::right_panel::terminal::action_debug;
use crate::theme::Theme;

use crate::app::Tide;

use crate::app::RightPanelSurface;
use crate::model::BackgroundWorkEvent;
use crate::review_diff::Source as ReviewDiffSource;
impl Tide {
    pub(in crate::app) fn run_project_action(
        &mut self,
        project_id: Uuid,
        action_name: String,
        command: String,
        cx: &mut Context<Self>,
    ) {
        let Some(session_id) = self.state.selected_session else {
            self.show_toast(tr!("projects.action_unavailable"));
            return;
        };
        let Some(project_path) = self
            .selected_session()
            .and_then(|session| self.workspace_path_for_session(session))
            .map(|path| path.to_string_lossy().into_owned())
        else {
            return;
        };
        let run_key = (session_id, project_id, action_name.clone());
        // Optimistic: the row flips to Stop immediately; the real job id
        // replaces the pending marker when the daemon answers.
        self.action_job_ids
            .borrow_mut()
            .insert(run_key.clone(), format!("pending-{}", Uuid::new_v4()));
        let action_name_for_job = action_name.clone();
        let action_name_for_key = action_name;
        let daemon = self.daemon.client();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    daemon.request(
                        Uuid::nil(),
                        Uuid::nil(),
                        client::Command::RunAction {
                            session_id: session_id.to_string(),
                            project_id: project_id.to_string(),
                            project_path,
                            action_name: action_name_for_job,
                            command,
                        },
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(client::ResponsePayload::Cursor {
                    cursor: Some(cursor),
                }) => {
                    if let Some(job_id) = cursor.get("jobId").and_then(|value| value.as_str()) {
                        this.action_job_ids.borrow_mut().insert(
                            (session_id, project_id, action_name_for_key),
                            job_id.to_owned(),
                        );
                    }
                    cx.notify();
                }
                Err(error) => {
                    this.action_job_ids.borrow_mut().remove(&(
                        session_id,
                        project_id,
                        action_name_for_key,
                    ));
                    this.show_toast(tr!("projects.action_failed", error = error));
                }
                _ => {}
            });
        })
        .detach();
    }

    /// SIGINT a running action job's process group.
    pub(in crate::app) fn stop_project_action(
        &mut self,
        project_id: Uuid,
        action_name: &str,
        cx: &mut Context<Self>,
    ) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let map_key = (session_id, project_id, action_name.to_owned());
        let Some(job_id) = self.action_job_ids.borrow().get(&map_key).cloned() else {
            return;
        };
        self.action_job_ids.borrow_mut().remove(&map_key);
        let daemon = self.daemon.client();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    daemon.request(
                        Uuid::nil(),
                        Uuid::nil(),
                        client::Command::StopAction {
                            session_id: session_id.to_string(),
                            job_id,
                        },
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Err(error) = result {
                    this.show_toast(tr!("projects.action_failed", error = error));
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// (running, advertised port) for one action row, read from the polled
    /// registry snapshot. Unknown job ids (dispatch in flight, or a poll
    /// that has not seen the job yet) read as running so the row never
    /// flickers back to Play mid-start.
    pub(in crate::app) fn action_run_state(
        &self,
        project_id: Uuid,
        action_name: &str,
    ) -> (bool, Option<u16>) {
        let Some(session_id) = self.state.selected_session else {
            return (false, None);
        };
        let Some(job_id) = self
            .action_job_ids
            .borrow()
            .get(&(session_id, project_id, action_name.to_owned()))
            .cloned()
        else {
            return (false, None);
        };
        if job_id.starts_with("pending-") {
            return (true, None);
        }
        let (running, scanned) = self
            .background_work
            .get(&session_id)
            .and_then(|registry| registry.action_job_state(&job_id))
            // Not landed in a poll yet — still starting.
            .unwrap_or((true, None));
        // The OS probe is authoritative; the log scan is the fast path.
        let port = self
            .action_job_ports
            .borrow()
            .get(&job_id)
            .copied()
            .or(scanned);
        action_debug(format!(
            "state: job={job_id} running={running} scanned={scanned:?} probed={:?} map_size={}",
            self.action_job_ports.borrow().get(&job_id).copied(),
            self.action_job_ports.borrow().len()
        ));
        (running, running.then_some(port).flatten())
    }

    pub(in crate::app) fn poll_action_jobs(&mut self, cx: &mut Context<Self>) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        if self
            .action_jobs_poll_at
            .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
        {
            return;
        }
        self.action_jobs_poll_at = Some(Instant::now());
        let daemon = self.daemon.client();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    daemon.request(
                        Uuid::nil(),
                        Uuid::nil(),
                        client::Command::ListActionJobs {
                            session_id: session_id.to_string(),
                        },
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(client::ResponsePayload::ActionJobs { jobs, runs }) => {
                    action_debug(format!(
                        "poll: {} jobs, {} runs; ports={:?}",
                        jobs.len(),
                        runs.len(),
                        runs.iter()
                            .map(|run| (run.job_id.clone(), run.port))
                            .collect::<Vec<_>>()
                    ));
                    // Seed the row-state map first: a freshly started UI
                    // (or a session visited after a restart) learns its
                    // live runs from the wires.
                    for run in runs {
                        if let Some(port) = run.port {
                            this.action_job_ports
                                .borrow_mut()
                                .insert(run.job_id.clone(), port);
                        }
                        this.action_job_ids
                            .borrow_mut()
                            .entry((
                                session_id,
                                run.project_id.parse().unwrap_or_default(),
                                run.action_name.clone(),
                            ))
                            .or_insert(run.job_id.clone());
                    }
                    // Land the items exactly as the event stream would, so
                    // the jobs pill, popup, and surface all list runs that
                    // started before any runtime attached.
                    for item in jobs {
                        this.handle_background_work_event(
                            session_id,
                            BackgroundWorkEvent::Upsert(item),
                        );
                    }
                    cx.notify();
                }
                Err(_) => {}
                _ => {}
            });
        })
        .detach();
    }

    pub(in crate::app) fn open_action_url(&mut self, port: u16, cx: &mut Context<Self>) {
        let browser_id = Uuid::new_v4();
        self.right_panel_pending_browser_urls
            .insert(browser_id, format!("http://localhost:{port}"));
        self.open_right_panel_surface(RightPanelSurface::Browser(browser_id), cx);
    }

    pub(in crate::app) fn open_mermaid_diagram(&mut self, source: &str, cx: &mut Context<Self>) {
        let browser_id = Uuid::new_v4();
        self.right_panel_pending_browser_urls.insert(
            browser_id,
            crate::browser::mermaid_data_url(source, Theme::current(cx).is_dark),
        );
        self.open_right_panel_surface(RightPanelSurface::Browser(browser_id), cx);
    }

    pub(in crate::app) fn open_turn_diff(&mut self, turn_id: Uuid, cx: &mut Context<Self>) {
        let Some(source) = self.selected_session().and_then(|session| {
            session
                .turns
                .iter()
                .find(|turn| turn.id == turn_id)
                .map(|turn| ReviewDiffSource::LastTurn {
                    session_id: session.id,
                    turn_id: turn.id,
                    turn_count: turn.turn_count,
                })
        }) else {
            return;
        };
        self.open_last_turn_review(source, cx);
    }
}
