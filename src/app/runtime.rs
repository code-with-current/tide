use super::*;

fn workspace_ack(
    workspace: &client::WorkspaceClient,
    operation: client::WorkspaceOperation,
) -> anyhow::Result<()> {
    match workspace.request(operation)? {
        client::WorkspaceResult::Ack => Ok(()),
        _ => anyhow::bail!("the daemon returned an invalid workspace response"),
    }
}

fn workspace_has_ref(
    workspace: &client::WorkspaceClient,
    cwd: &Path,
    git_ref: &str,
) -> anyhow::Result<bool> {
    match workspace.request(client::WorkspaceOperation::HasRef {
        cwd: cwd.to_path_buf(),
        git_ref: git_ref.to_owned(),
    })? {
        client::WorkspaceResult::Bool { value } => Ok(value),
        _ => anyhow::bail!("the daemon returned an invalid checkpoint response"),
    }
}

fn start_driver(mut request: DriverStartRequest, cwd: PathBuf) -> anyhow::Result<PreparedDriver> {
    request.options.cwd = cwd;
    let (event_tx, events) = driver::event_channel(request.event_wake);
    let handle = driver::start_remote(
        request.daemon,
        request.session_id,
        request.provider,
        request.options,
        event_tx,
    )?;
    Ok(PreparedDriver { handle, events })
}

fn attach_driver(
    daemon: client::DaemonSupervisor,
    session_id: Uuid,
    event_wake: smol::channel::Sender<()>,
) -> anyhow::Result<Option<(AgentSession, PreparedDriver)>> {
    let Some(session) = client::persistence::hydrate_session(&daemon, session_id)? else {
        return Ok(None);
    };
    let client = daemon.client();
    let response = client.request(session_id, Uuid::nil(), client::Command::AttachSession)?;
    let client::ResponsePayload::SessionRuntime {
        runtime_id,
        supports_steer,
    } = response
    else {
        anyhow::bail!("Tide daemon returned an invalid runtime attachment response");
    };
    let Some(runtime_id) = runtime_id else {
        return Ok(None);
    };
    let (event_tx, events) = driver::event_channel(event_wake);
    let handle = driver::attach_remote(
        daemon,
        client,
        session_id,
        runtime_id,
        supports_steer,
        session.runtime_event_cursor,
        event_tx,
    )?;
    Ok(Some((session, PreparedDriver { handle, events })))
}

fn load_remote_task_state(
    client: &client::DaemonClient,
) -> anyhow::Result<RemoteTaskStateSnapshot> {
    let response = client.request(Uuid::nil(), Uuid::nil(), client::Command::LoadTaskState)?;
    let client::ResponsePayload::TaskState {
        projects,
        mut sessions,
        ..
    } = response
    else {
        anyhow::bail!("Tide daemon returned an invalid task-state response");
    };
    for session in &mut sessions {
        session.detail_loaded = false;
    }
    // Old stores can still carry sessions from the removed CLI providers.
    // Hide those rows rather than offering tasks nothing can run.
    sessions.retain(|session| session.provider == ProviderKind::Tide);
    Ok(RemoteTaskStateSnapshot { projects, sessions })
}

pub(super) fn session_has_active_provider_turn(session: &AgentSession) -> bool {
    session.is_busy()
        && session
            .turns
            .last()
            .is_some_and(|turn| turn.status == TurnStatus::Running && turn.provider_turn_started)
}

/// Merge the daemon's list-only session projection into the desktop catalog.
///
/// Existing rows may already contain a hydrated transcript, so only list
/// metadata is copied from the projection. A locally attached runtime remains
/// authoritative for transient status and timestamps until its own events are
/// drained.
pub(super) fn merge_remote_session_catalog(
    local: &mut Vec<AgentSession>,
    remote: Vec<AgentSession>,
    has_local_runtime: impl Fn(Uuid) -> bool,
) -> Vec<Uuid> {
    // Persisted rows from the removed CLI providers never surface: they are
    // dropped from the projection, and any local copy of one disappears with
    // it (started rows are "removed"; untouched drafts simply stay hidden).
    let remote = remote
        .into_iter()
        .filter(|session| session.provider == ProviderKind::Tide)
        .collect::<Vec<_>>();
    let remote_ids = remote
        .iter()
        .map(|session| session.id)
        .collect::<HashSet<_>>();
    let removed = local
        .iter()
        .filter(|session| session.has_started() && !remote_ids.contains(&session.id))
        .map(|session| session.id)
        .collect::<Vec<_>>();
    local.retain(|session| !session.has_started() || remote_ids.contains(&session.id));

    for remote in remote {
        if let Some(local) = local.iter_mut().find(|session| session.id == remote.id) {
            local.title = remote.title;
            local.auto_title = remote.auto_title;
            local.project_id = remote.project_id;
            local.provider = remote.provider;
            local.model = remote.model;
            local.created_at = remote.created_at;
            local.last_reply_at = remote.last_reply_at;
            if !has_local_runtime(local.id) {
                local.status = remote.status;
                local.updated_at = remote.updated_at;
            }
        } else {
            local.push(remote);
        }
    }

    removed
}

/// Perform every blocking operation between accepting a submission and
/// starting its provider. This function is called only from the background
/// executor; the UI thread owns applying the returned workspace afterward.
fn prepare_submission(
    workspace_client: client::WorkspaceClient,
    project: Project,
    workspace: SessionWorkspace,
    driver_start: Option<anyhow::Result<DriverStartRequest>>,
    session_id: Uuid,
    prompt: &str,
    turn_count: usize,
) -> anyhow::Result<PreparedSubmission> {
    let workspace = match workspace {
        SessionWorkspace::NewWorktree { base_branch } => {
            if project.is_projectless() {
                anyhow::bail!("a projectless task cannot create a Git worktree");
            }
            let created =
                match workspace_client.request(client::WorkspaceOperation::CreateWorktree {
                    project_path: project.path.clone(),
                    project_id: project.id,
                    session_id,
                    prompt: prompt.to_owned(),
                    base_branch,
                })? {
                    client::WorkspaceResult::WorktreeCreated { worktree } => worktree,
                    _ => anyhow::bail!("the daemon returned an invalid worktree response"),
                };
            SessionWorkspace::Worktree {
                path: created.path,
                branch: created.branch,
            }
        }
        workspace => workspace,
    };
    let project_path = workspace.path().unwrap_or(&project.path);

    // Every turn gets its own immutable starting snapshot. Reusing the prior
    // response's ending ref would attribute branch switches or terminal edits
    // made between turns to the next response.
    let checkpoint_warning = workspace_ack(
        &workspace_client,
        client::WorkspaceOperation::CaptureTurnStart {
            cwd: project_path.to_path_buf(),
            session_id,
            turn_count,
        },
    )
    .err()
    .map(|error| tr!("errors.capture_pre_turn_checkpoint", error = error));

    // Process startup can synchronously resolve executables, bind sockets,
    // and spawn children. It belongs behind the same animated preparation
    // boundary as Git work, otherwise the last spinner frame visibly freezes
    // just before Stop appears.
    let driver = driver_start.map(|request| {
        request.and_then(|request| start_driver(request, project_path.to_path_buf()))
    });

    Ok(PreparedSubmission {
        workspace,
        checkpoint_warning,
        driver,
    })
}

/// Everything a past-message resend needs after the UI accepts it.
///
/// The request owns only thread-safe snapshots. Git, driver RPCs, and process
/// startup all happen in [`perform_message_rewind`] on the background
/// executor.
struct MessageRewindRequest {
    workspace_client: client::WorkspaceClient,
    session_id: Uuid,
    project_path: PathBuf,
    retained_turn_count: usize,
    previous_turn_count: usize,
    rollback_turns: usize,
    driver: Option<DriverHandle>,
    driver_start: Option<DriverStartRequest>,
}

struct PreparedMessageRewind {
    provider_rewind_cursor: Option<ProviderResumeCursor>,
    prepared_driver: Option<PreparedDriver>,
    cleanup_error: Option<String>,
}

fn perform_message_rewind(
    mut request: MessageRewindRequest,
) -> Result<PreparedMessageRewind, String> {
    let session_id = request.session_id;
    let turn_start_ref =
        checkpoint::turn_start_ref(session_id, request.retained_turn_count.saturating_add(1));
    let retained_ref = checkpoint::checkpoint_ref(session_id, request.retained_turn_count);
    let restore_ref = if workspace_has_ref(
        &request.workspace_client,
        &request.project_path,
        &turn_start_ref,
    )
    .map_err(|error| error.to_string())?
    {
        turn_start_ref
    } else {
        retained_ref
    };
    if !workspace_has_ref(
        &request.workspace_client,
        &request.project_path,
        &restore_ref,
    )
    .map_err(|error| error.to_string())?
    {
        return Err(tr!("session.pre_turn_checkpoint_missing"));
    }

    let safety_ref = format!("refs/tide/revert-backup-{session_id}-{}", Uuid::new_v4());
    workspace_ack(
        &request.workspace_client,
        client::WorkspaceOperation::CaptureRef {
            cwd: request.project_path.clone(),
            git_ref: safety_ref.clone(),
        },
    )
    .map_err(|error| tr!("errors.create_rewind_snapshot", error = error))?;
    if let Err(error) = workspace_ack(
        &request.workspace_client,
        client::WorkspaceOperation::RestoreRef {
            cwd: request.project_path.clone(),
            git_ref: restore_ref.clone(),
        },
    ) {
        return Err(
            match workspace_ack(
                &request.workspace_client,
                client::WorkspaceOperation::RestoreRef {
                    cwd: request.project_path.clone(),
                    git_ref: safety_ref.clone(),
                },
            ) {
                Ok(()) => {
                    let _ = workspace_ack(
                        &request.workspace_client,
                        client::WorkspaceOperation::DeleteRef {
                            cwd: request.project_path.clone(),
                            git_ref: safety_ref.clone(),
                        },
                    );
                    tr!("errors.restore_checkpoint", error = error)
                }
                Err(restore_error) => tr!(
                    "errors.restore_checkpoint_and_safety",
                    error = error,
                    restore_error = restore_error,
                    safety_ref = safety_ref
                ),
            },
        );
    }

    let provider_rewind = perform_provider_rewind(&mut request);
    let (provider_rewind_cursor, prepared_driver) = match provider_rewind {
        Ok(rewind) => rewind,
        Err(error) => {
            return Err(
                match workspace_ack(
                    &request.workspace_client,
                    client::WorkspaceOperation::RestoreRef {
                        cwd: request.project_path.clone(),
                        git_ref: safety_ref.clone(),
                    },
                ) {
                    Ok(()) => {
                        let _ = workspace_ack(
                            &request.workspace_client,
                            client::WorkspaceOperation::DeleteRef {
                                cwd: request.project_path.clone(),
                                git_ref: safety_ref.clone(),
                            },
                        );
                        tr!("errors.rollback_rejected_workspace_restored", error = error)
                    }
                    Err(restore_error) => tr!(
                        "errors.rollback_and_safety_failed",
                        error = error,
                        restore_error = restore_error,
                        safety_ref = safety_ref
                    ),
                },
            );
        }
    };

    let _ = workspace_ack(
        &request.workspace_client,
        client::WorkspaceOperation::DeleteRef {
            cwd: request.project_path.clone(),
            git_ref: safety_ref,
        },
    );
    let cleanup_error = workspace_ack(
        &request.workspace_client,
        client::WorkspaceOperation::DeleteTurnRefsAfter {
            cwd: request.project_path.clone(),
            session_id,
            retained_turn_count: request.retained_turn_count,
            previous_turn_count: request.previous_turn_count,
        },
    )
    .err()
    .map(|error| error.to_string());

    Ok(PreparedMessageRewind {
        provider_rewind_cursor,
        prepared_driver,
        cleanup_error,
    })
}

type ProviderRewindResult = (Option<ProviderResumeCursor>, Option<PreparedDriver>);

/// Roll the tide session back through its daemon runtime: a live driver rolls
/// in place, and a cold one is started just for the rollback. The returned
/// cursor replaces the session's resume point.
fn perform_provider_rewind(
    request: &mut MessageRewindRequest,
) -> anyhow::Result<ProviderRewindResult> {
    if request.rollback_turns == 0 {
        return Ok((None, None));
    }
    let mut prepared_driver = None;
    let driver = if let Some(driver) = request.driver.as_ref() {
        driver.clone()
    } else {
        let start = request.driver_start.take().ok_or_else(|| {
            anyhow::anyhow!(tr!(
                "errors.provider_not_found",
                provider = ProviderKind::Tide.display_name()
            ))
        })?;
        let prepared = start_driver(start, request.project_path.clone())?;
        let driver = prepared.handle.clone();
        prepared_driver = Some(prepared);
        driver
    };
    let cursor = driver.rollback(request.rollback_turns)?;
    Ok((cursor, prepared_driver))
}

/// Everything a response fork needs after the click has been accepted.
///
/// The session is a point-in-time snapshot: provider branching may take long
/// enough for the user to navigate elsewhere, but the resulting task must
/// still end at the response they chose. Provider RPCs, process startup,
/// native transcript I/O, and Git ref copying are all performed by
/// [`perform_response_fork`] on the background executor.
struct ResponseForkRequest {
    workspace_client: client::WorkspaceClient,
    source: AgentSession,
    source_workspace_path: PathBuf,
    fork_title: String,
    turn_count: usize,
    turns_to_remove: usize,
    driver: Option<DriverHandle>,
    driver_start: Option<DriverStartRequest>,
}

fn numbered_title_suffix(title: &str) -> Option<(&str, usize)> {
    let (base, suffix) = title.rsplit_once(" (")?;
    let number = suffix.strip_suffix(')')?.parse().ok()?;
    (!base.is_empty() && number >= 2).then_some((base, number))
}

fn next_response_fork_title<'a>(
    source_title: &str,
    existing_titles: impl IntoIterator<Item = &'a str>,
) -> String {
    let existing_titles = existing_titles.into_iter().collect::<Vec<_>>();
    let base = numbered_title_suffix(source_title)
        .filter(|(base, _)| existing_titles.iter().any(|title| title == base))
        .map_or(source_title, |(base, _)| base);
    let highest_number = existing_titles
        .iter()
        .filter_map(|title| {
            if *title == base {
                Some(1)
            } else {
                numbered_title_suffix(title)
                    .filter(|(candidate_base, _)| *candidate_base == base)
                    .map(|(_, number)| number)
            }
        })
        .max()
        .unwrap_or(1);
    format!("{base} ({})", highest_number.saturating_add(1).max(2))
}

struct PreparedResponseFork {
    forked: AgentSession,
    prepared_driver: Option<PreparedDriver>,
    checkpoint_warning: Option<String>,
}

/// Fork the tide session's transcript at a response through its daemon
/// runtime: a live driver forks in place, and a cold one is started just for
/// the fork. The returned cursor becomes the fork's resume point.
fn fork_response_with_driver(
    request: &mut ResponseForkRequest,
) -> anyhow::Result<(ProviderResumeCursor, Option<PreparedDriver>)> {
    let mut prepared_driver = None;
    let driver = if let Some(driver) = request.driver.as_ref() {
        driver.clone()
    } else {
        let start = request.driver_start.take().ok_or_else(|| {
            anyhow::anyhow!(tr!(
                "errors.provider_not_found",
                provider = ProviderKind::Tide.display_name()
            ))
        })?;
        let prepared = start_driver(start, request.source_workspace_path.clone())?;
        let driver = prepared.handle.clone();
        prepared_driver = Some(prepared);
        driver
    };
    Ok((driver.fork(request.turns_to_remove)?, prepared_driver))
}

fn perform_response_fork(mut request: ResponseForkRequest) -> Result<PreparedResponseFork, String> {
    let fork = fork_response_with_driver(&mut request)
        .map_err(|error| tr!("errors.fork_task", error = error));
    let (provider_cursor, prepared_driver) = fork?;
    let Some(mut forked) =
        request
            .source
            .fork_through_turn(request.turn_count, provider_cursor, &request.fork_title)
    else {
        return Err(tr!("session.response_cannot_copy"));
    };

    let fork_id = forked.id;
    for turn in &mut forked.turns {
        if let Some(checkpoint) = turn.checkpoint.as_mut() {
            checkpoint.git_ref = checkpoint::checkpoint_ref(fork_id, checkpoint.turn_count);
        }
    }
    let checkpoint_warning = workspace_ack(
        &request.workspace_client,
        client::WorkspaceOperation::CopySessionRefs {
            cwd: request.source_workspace_path.clone(),
            source_session_id: request.source.id,
            target_session_id: fork_id,
            through_turn_count: request.turn_count,
        },
    )
    .err()
    .map(|error| error.to_string());

    Ok(PreparedResponseFork {
        forked,
        prepared_driver,
        checkpoint_warning,
    })
}

impl Tide {
    pub(super) fn restart_task_state_sync(&self) {
        let clients = self.daemon.subscribe_clients();
        let results = self.task_state_sync_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        std::thread::Builder::new()
            .name("tide-task-state-sync".into())
            .spawn(move || {
                let Ok(mut client) = clients.recv() else {
                    return;
                };
                loop {
                    while let Ok(newer) = clients.try_recv() {
                        client = newer;
                    }
                    let revisions = client.subscribe_task_state();
                    let result = load_remote_task_state(&client).map_err(|error| error.to_string());
                    if results.send(result).is_err() {
                        return;
                    }
                    signal_event_pump(&event_wake);
                    client = loop {
                        crossbeam_channel::select! {
                            recv(clients) -> replacement => {
                                let Ok(mut replacement) = replacement else {
                                    return;
                                };
                                while let Ok(newer) = clients.try_recv() {
                                    replacement = newer;
                                }
                                break replacement;
                            }
                            recv(revisions) -> revision => {
                                if revision.is_err() {
                                    // Managed replacement publishes the new
                                    // client after the old socket closes. Wait
                                    // for that publication instead of exiting
                                    // the task-state sync worker permanently.
                                    let Ok(replacement) = clients.recv() else {
                                        return;
                                    };
                                    break replacement;
                                }
                                while revisions.try_recv().is_ok() {}
                                let result = load_remote_task_state(&client)
                                    .map_err(|error| error.to_string());
                                if results.send(result).is_err() {
                                    return;
                                }
                                signal_event_pump(&event_wake);
                            }
                        }
                    };
                }
            })
            .ok();
    }

    fn drain_task_state_sync_events(&mut self, cx: &mut Context<Self>) -> bool {
        let mut latest = None;
        while let Ok(result) = self.task_state_sync_events.try_recv() {
            latest = Some(result);
        }
        let Some(result) = latest else {
            return false;
        };
        match result {
            Ok(snapshot) => {
                self.apply_remote_task_state(snapshot, cx);
                true
            }
            Err(error) => {
                eprintln!("could not refresh daemon task state: {error}");
                false
            }
        }
    }

    fn apply_remote_task_state(
        &mut self,
        snapshot: RemoteTaskStateSnapshot,
        cx: &mut Context<Self>,
    ) {
        let runtime_ids = self.runtimes.keys().copied().collect::<HashSet<_>>();
        let removed = merge_remote_session_catalog(
            &mut self.state.sessions,
            snapshot.sessions,
            |session_id| runtime_ids.contains(&session_id),
        );
        for session_id in &removed {
            self.runtime_attach_pending.remove(session_id);
            self.runtime_attach_misses.remove(session_id);
            self.runtimes.remove(session_id);
            self.background_work.remove(session_id);
            self.remove_right_panel_session_state(*session_id);
            self.task_switcher.remove(*session_id);
        }
        self.state.projects = snapshot.projects;

        let attach = self
            .state
            .sessions
            .iter()
            .filter(|session| {
                session.status.is_busy()
                    || (self.state.selected_session == Some(session.id) && session.has_started())
            })
            .map(|session| session.id)
            .collect::<Vec<_>>();
        for session_id in attach {
            self.start_runtime_attachment(session_id, cx);
        }

        if self.state.selected_session.is_some_and(|selected| {
            !self
                .state
                .sessions
                .iter()
                .any(|session| session.id == selected)
        }) {
            let previous_project = self.state.selected_project;
            self.state.selected_session = None;
            let next = self
                .state
                .sessions
                .iter()
                .filter(|session| {
                    previous_project.is_none_or(|project| session.project_id == project)
                })
                .max_by_key(|session| session.updated_at)
                .map(|session| session.id)
                .or_else(|| {
                    self.state
                        .sessions
                        .iter()
                        .max_by_key(|session| session.updated_at)
                        .map(|session| session.id)
                });
            if let Some(next) = next {
                self.select_session(next, cx);
            } else if let Some(project_id) = self
                .state
                .selected_project
                .filter(|project_id| {
                    self.state
                        .projects
                        .iter()
                        .any(|project| project.id == *project_id)
                })
                .or_else(|| self.state.projects.first().map(|project| project.id))
            {
                self.state.selected_project = Some(project_id);
                self.create_session_for(project_id, self.state.last_provider, cx);
            }
        }
    }

    pub(super) fn start_runtime_attachment(&mut self, session_id: Uuid, cx: &mut Context<Self>) {
        if self.runtimes.contains_key(&session_id)
            || !self.runtime_attach_pending.insert(session_id)
        {
            return;
        }
        let daemon = self.daemon.clone();
        let event_wake = self.event_wake_tx.clone();
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { attach_driver(daemon, session_id, event_wake) })
                .await;
            let _ = tide.update(cx, move |tide, cx| {
                tide.finish_runtime_attachment(session_id, result, cx);
            });
        })
        .detach();
    }

    fn finish_runtime_attachment(
        &mut self,
        session_id: Uuid,
        result: anyhow::Result<Option<(AgentSession, PreparedDriver)>>,
        cx: &mut Context<Self>,
    ) {
        if !self.runtime_attach_pending.remove(&session_id) {
            return;
        }
        match result {
            Ok(Some((session, prepared))) => {
                self.runtime_attach_misses.remove(&session_id);
                let Some(index) = self
                    .state
                    .sessions
                    .iter()
                    .position(|candidate| candidate.id == session_id)
                else {
                    return;
                };
                if !self.runtimes.contains_key(&session_id) {
                    let subagent_runs = session.subagent_runs.clone();
                    self.state.sessions[index] = session;
                    self.install_prepared_driver(session_id, prepared);
                    // Settled sub-agent runs ride the hydrated session —
                    // rebuild their panel items so the agents tab works
                    // before any live event arrives.
                    if !subagent_runs.is_empty() {
                        self.background_work
                            .entry(session_id)
                            .or_default()
                            .rehydrate_subagent_runs(&subagent_runs);
                    }
                    if self.state.selected_session == Some(session_id) {
                        self.reset_visible_state();
                        self.reset_transcript_rows(self.transcript_row_count());
                    }
                    cx.notify();
                }
            }
            Ok(None) => {
                let busy = self
                    .state
                    .sessions
                    .iter()
                    .find(|session| session.id == session_id)
                    .is_some_and(|session| session.status.is_busy());
                if !busy {
                    self.runtime_attach_misses.remove(&session_id);
                    return;
                }
                let misses = self.runtime_attach_misses.entry(session_id).or_default();
                *misses = misses.saturating_add(1);
                if *misses < 4 {
                    cx.spawn(async move |tide, cx| {
                        cx.background_executor()
                            .timer(Duration::from_millis(250))
                            .await;
                        let _ = tide.update(cx, |tide, cx| {
                            tide.start_runtime_attachment(session_id, cx);
                        });
                    })
                    .detach();
                } else {
                    self.runtime_attach_misses.remove(&session_id);
                    self.interrupt_orphaned_runtime(session_id, cx);
                }
            }
            Err(error) => {
                eprintln!("could not attach desktop to daemon session {session_id}: {error:#}");
            }
        }
    }

    fn interrupt_orphaned_runtime(&mut self, session_id: Uuid, cx: &mut Context<Self>) {
        let project_paths = self
            .state
            .projects
            .iter()
            .map(|project| (project.id, project.path.clone()))
            .collect::<HashMap<_, _>>();
        let mut checkpoint = None;
        if let Some(session) = self.state.session_mut(session_id) {
            if !session.status.is_busy() {
                return;
            }
            session.status = SessionStatus::Idle;
            let interrupted_turn_count = session
                .turns
                .last_mut()
                .filter(|turn| turn.status == TurnStatus::Running)
                .map(|turn| {
                    turn.status = TurnStatus::Interrupted;
                    turn.completed_at = Some(unix_time());
                    turn.turn_count
                });
            if let Some(turn_count) = interrupted_turn_count {
                let project_path = session
                    .workspace
                    .path()
                    .map(Path::to_path_buf)
                    .or_else(|| project_paths.get(&session.project_id).cloned());
                checkpoint = project_path.map(|project_path| PendingCheckpointCapture {
                    session_id,
                    turn_count,
                    project_path,
                });
            }
            for message in &mut session.messages {
                message.streaming = false;
            }
            for block in &mut session.transcript_blocks {
                block.activities.retain(|activity| {
                    activity
                        .reasoning
                        .as_ref()
                        .is_none_or(|reasoning| !reasoning.content.trim().is_empty())
                });
                for activity in &mut block.activities {
                    activity.complete = true;
                }
            }
            session
                .transcript_blocks
                .retain(|block| !block.activities.is_empty());
        }
        if let Some(checkpoint) = checkpoint {
            self.pending_checkpoint_captures.push(checkpoint);
            self.start_pending_checkpoint_captures(cx);
        }
        if self.state.selected_session == Some(session_id) {
            self.reset_visible_state();
            self.reset_transcript_rows(self.transcript_row_count());
        }
        self.save();
        cx.notify();
    }

    pub fn composer_focus(&self, cx: &App) -> FocusHandle {
        self.composer.read(cx).focus()
    }

    pub(super) fn selected_project(&self) -> Option<&Project> {
        let id = self.state.selected_project?;
        self.state.projects.iter().find(|project| project.id == id)
    }

    pub(super) fn selected_session(&self) -> Option<&AgentSession> {
        let id = self.state.selected_session?;
        self.state.sessions.iter().find(|session| session.id == id)
    }

    fn active_turn_finished_event(
        &self,
        session_id: Uuid,
        outcome: crate::analytics::TurnOutcome,
    ) -> Option<crate::analytics::Event> {
        let session = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)?;
        let turn = session
            .turns
            .last()
            .filter(|turn| turn.status == TurnStatus::Running)?;
        Some(crate::analytics::Event::TurnFinished {
            provider: session.provider.id(),
            turn_number: turn.turn_count,
            outcome,
            duration_seconds: unix_time().saturating_sub(turn.started_at),
        })
    }

    /// Completes a persisted turn and emits its anonymous outcome exactly
    /// once. All production turn-settlement paths go through this seam.
    pub(super) fn finish_active_turn_with_analytics(
        &mut self,
        session_id: Uuid,
        status: TurnStatus,
        outcome: crate::analytics::TurnOutcome,
    ) -> Option<(Uuid, usize)> {
        let event = self.active_turn_finished_event(session_id, outcome);
        let result = self
            .state
            .session_mut(session_id)?
            .finish_active_turn(status);
        if result.is_some()
            && let Some(event) = event
        {
            self.analytics.track(event);
        }
        result
    }

    /// Records a failed submission that is about to be unwound and therefore
    /// will not remain as a persisted turn.
    fn track_active_turn_outcome(&self, session_id: Uuid, outcome: crate::analytics::TurnOutcome) {
        if let Some(event) = self.active_turn_finished_event(session_id, outcome) {
            self.analytics.track(event);
        }
    }

    /// The directory every filesystem and provider operation for `session`
    /// must use. A not-yet-materialized worktree draft deliberately reads the
    /// local checkout until its first submission creates the isolated copy.
    pub(super) fn workspace_path_for_session<'a>(
        &'a self,
        session: &'a AgentSession,
    ) -> Option<&'a std::path::Path> {
        let project = self
            .state
            .projects
            .iter()
            .find(|project| project.id == session.project_id)?;
        Some(session.workspace.path().unwrap_or(&project.path))
    }

    pub(super) fn selected_workspace_path(&self) -> Option<&std::path::Path> {
        let session = self.selected_session()?;
        self.workspace_path_for_session(session)
    }

    /// Marks the session for the next save; see `PersistedState::session_mut`.
    pub(super) fn selected_session_mut(&mut self) -> Option<&mut AgentSession> {
        let id = self.state.selected_session?;
        self.state.session_mut(id)
    }

    pub(super) fn selected_runtime(&self) -> Option<&SessionRuntime> {
        self.runtimes.get(&self.state.selected_session?)
    }

    /// Rebuild the flattened tide model catalog from a provider list. Stored
    /// on the state whenever the provider list lands, so frames and metadata
    /// lookups read it instead of walking the wire rows.
    pub(super) fn tide_models_from_providers(
        providers: &[client::tide::TideProviderWire],
    ) -> Vec<ProviderModel> {
        providers
            .iter()
            .flat_map(|tide_provider| {
                tide_provider.models.iter().map(move |model| ProviderModel {
                    // Picker row identity: `provider/model`, exactly the id
                    // the daemon resolves back to a configured provider.
                    id: format!("{}/{}", tide_provider.id, model.model_id),
                    name: model.alias.clone(),
                    sub_provider: Some(tide_provider.name.clone()),
                    is_default: false,
                    reasoning_efforts: if model.reasoning {
                        model
                            .supported_efforts
                            .iter()
                            .map(|effort| {
                                ProviderModelOption::new(effort.clone(), effort.to_uppercase())
                            })
                            .collect()
                    } else {
                        Vec::new()
                    },
                    default_reasoning_effort: None,
                    service_tiers: Vec::new(),
                    default_service_tier: None,
                    context_windows: Vec::new(),
                    default_context_window: Some(model.context_window.to_string()),
                    price_label: model.price_label.clone(),
                    vision: model.vision,
                })
            })
            .collect()
    }

    /// Whether the model picker has nothing left to offer — no tide provider
    /// is configured — so the composer's trigger, the picker panel, and the
    /// send button all swap to their unavailable state. A provider list that
    /// has not loaded yet means "not known here", never "nothing".
    pub(super) fn model_picker_has_no_providers(&self) -> bool {
        self.tide.loaded && self.tide_models.is_empty()
    }

    pub(super) fn model_for_session<'a>(&'a self, session: &'a AgentSession) -> Option<&'a str> {
        session
            .model
            .as_deref()
            .or_else(|| self.tide_models.first().map(|model| model.id.as_str()))
    }

    pub(super) fn model_display_name(&self, provider: ProviderKind, model: Option<&str>) -> String {
        let Some(model) = model else {
            return provider.short_name().to_owned();
        };
        self.tide_models
            .iter()
            .find(|candidate| candidate.id == model)
            .map(|candidate| candidate.name.clone())
            .unwrap_or_else(|| model.to_owned())
    }

    pub(super) fn model_metadata_for_session(
        &self,
        session: &AgentSession,
    ) -> Option<&ProviderModel> {
        let model = self.model_for_session(session)?;
        self.tide_models
            .iter()
            .find(|candidate| candidate.id == model)
    }

    pub(super) fn selected_transcript_blocks(&self) -> &[TranscriptBlock] {
        self.selected_session()
            .map(|session| session.transcript_blocks.as_slice())
            .unwrap_or(&[])
    }

    /// Generate a session title with the background model, right after the
    /// first prompt is sent: latency is the point (docs/titles.md) — the
    /// generation runs parallel to the turn and replaces the placeholder the
    /// moment it lands. A provider title that lands first always wins: the
    /// write-back only fires while the placeholder is still untouched, and a
    /// provider `AutoTitleUpdated` arriving after still overwrites the
    /// generated text through the same `auto_title` field.
    fn schedule_session_title_generation(
        &mut self,
        session_id: Uuid,
        first_prompt: String,
        placeholder: String,
        cx: &mut Context<Self>,
    ) {
        if !self.title_generation_in_flight.insert(session_id) {
            return;
        }
        let Some(cwd) = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .and_then(|session| self.workspace_path_for_session(session))
            .map(std::path::Path::to_path_buf)
        else {
            self.title_generation_in_flight.remove(&session_id);
            return;
        };
        let Some(invocation) = self.background_invocation(
            self.git_settings
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.background_title_model.as_ref()),
        ) else {
            self.title_generation_in_flight.remove(&session_id);
            return;
        };
        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    async move {
                        match workspace.request(client::WorkspaceOperation::GenerateSessionTitle {
                            cwd,
                            first_message: first_prompt,
                            invocation,
                        }) {
                            Ok(client::WorkspaceResult::GitText { text }) => Ok(text),
                            Ok(_) => Err(anyhow::anyhow!(
                                "the daemon returned an invalid session title response"
                            )),
                            Err(err) => Err(err),
                        }
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                tide.title_generation_in_flight.remove(&session_id);
                let title = match result {
                    Ok(title) => title,
                    // A missing title is a cosmetic gap (docs/titles.md):
                    // log silently, keep the placeholder, never toast.
                    Err(error) => {
                        eprintln!("could not generate a session title: {error:#}");
                        return;
                    }
                };
                // Provider-title precedence: only replace the exact
                // placeholder state the generation was scheduled against. A
                // provider title that landed meanwhile — or a user rename —
                // keeps the field as its owner set it.
                let still_placeholder = tide
                    .state
                    .sessions
                    .iter()
                    .find(|session| session.id == session_id)
                    .is_some_and(|session| {
                        session.title == AgentSession::DEFAULT_TITLE
                            && session.auto_title.as_deref() == Some(placeholder.as_str())
                    });
                if !still_placeholder {
                    return;
                }
                if let Some(session) = tide.state.session_mut(session_id) {
                    session.set_auto_title(Some(title));
                }
                tide.state.mark_session_dirty(session_id);
                tide.save();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn save(&mut self) {
        self.last_stream_save = Instant::now();
        let daemon_error = self
            .daemon
            .update_settings(self.state.daemon_settings())
            .err()
            .map(|error| error.to_string());
        let app_error = self
            .store
            .save(&mut self.state)
            .err()
            .map(|error| error.to_string());
        if let Some(error) = daemon_error.or(app_error) {
            self.show_toast(tr!("errors.save_local_state", error = error));
        } else {
            self.stream_state_dirty = false;
        }
    }

    fn checkpoint_capture_pending(&self, session_id: Uuid, turn_count: usize) -> bool {
        self.checkpoint_captures_in_flight
            .contains(&(session_id, turn_count))
            || self
                .pending_checkpoint_captures
                .iter()
                .any(|capture| capture.session_id == session_id && capture.turn_count == turn_count)
    }

    fn ending_checkpoint_pending(&self, session_id: Uuid) -> bool {
        self.state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .and_then(|session| session.turns.last())
            .filter(|turn| turn.status != TurnStatus::Running)
            .is_some_and(|turn| self.checkpoint_capture_pending(session_id, turn.turn_count))
    }

    fn defer_queue_drain(&mut self, session_id: Uuid) {
        if !self.pending_queue_drains.contains(&session_id) {
            self.pending_queue_drains.push(session_id);
        }
    }

    /// Queues the newest finished turn's checkpoint for capture.
    ///
    /// Bookkeeping only. The capture itself is upwards of ten `git`
    /// invocations, one of them a `git add -A` over the whole worktree, and the
    /// hottest caller is the driver-event drain that shares the UI thread with
    /// rendering — so the work belongs to
    /// [`Self::start_pending_checkpoint_captures`], which every caller that
    /// holds a `Context` runs straight after queueing.
    pub(super) fn capture_latest_turn_checkpoint_for(&mut self, session_id: Uuid) {
        let Some((session, turn_count)) = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .and_then(|session| {
                session
                    .turns
                    .last()
                    .filter(|turn| turn.status != TurnStatus::Running)
                    .map(|turn| (session, turn.turn_count))
            })
        else {
            return;
        };
        if self.checkpoint_capture_pending(session_id, turn_count) {
            return;
        }
        let Some(project_path) = self
            .workspace_path_for_session(session)
            .map(std::path::Path::to_path_buf)
        else {
            return;
        };
        self.pending_checkpoint_captures
            .push(PendingCheckpointCapture {
                session_id,
                turn_count,
                project_path,
            });
    }

    /// Runs queued turn checkpoints on the background executor.
    ///
    /// A capture lands a frame or many later, and the turn it belongs to may be
    /// gone by then, so the result is matched back by turn count rather than
    /// position. Nothing on screen waits for it: the transcript's rewind
    /// affordance appears when `invalidate_checkpoint_refs` prompts the next
    /// prefetch to notice the new ref.
    pub(super) fn start_pending_checkpoint_captures(&mut self, cx: &mut Context<Self>) {
        for request in std::mem::take(&mut self.pending_checkpoint_captures) {
            let PendingCheckpointCapture {
                session_id,
                turn_count,
                project_path,
            } = request;
            if !self
                .checkpoint_captures_in_flight
                .insert((session_id, turn_count))
            {
                continue;
            }
            let workspace = client::WorkspaceClient::new(self.daemon.client());
            cx.spawn(async move |tide, cx| {
                let captured = cx
                    .background_executor()
                    .spawn({
                        let project_path = project_path.clone();
                        async move {
                            match workspace.request(client::WorkspaceOperation::CaptureTurn {
                                cwd: project_path,
                                session_id,
                                turn_count,
                            })? {
                                client::WorkspaceResult::Checkpoint { checkpoint } => {
                                    Ok(checkpoint)
                                }
                                _ => anyhow::bail!(
                                    "the daemon returned an invalid checkpoint response"
                                ),
                            }
                        }
                    })
                    .await;
                tide.update(cx, |tide, cx| {
                    tide.checkpoint_captures_in_flight
                        .remove(&(session_id, turn_count));
                    let selected = tide.state.selected_session == Some(session_id);
                    if selected {
                        tide.sync_transcript_rows();
                    }
                    let previous_kinds = if selected {
                        tide.transcript_row_kinds.borrow().clone()
                    } else {
                        Vec::new()
                    };
                    let checkpoint = match captured {
                        Ok(checkpoint) => checkpoint,
                        Err(error) => {
                            tide.show_toast(tr!("errors.capture_turn_checkpoint", error = error));
                            Checkpoint {
                                turn_count,
                                git_ref: checkpoint::checkpoint_ref(session_id, turn_count),
                                status: CheckpointStatus::Error,
                                files: Vec::new(),
                                additions: 0,
                                deletions: 0,
                                created_at: unix_time(),
                            }
                        }
                    };
                    tide.invalidate_checkpoint_refs();
                    let mut attached_turn_id = None;
                    if let Some(session) = tide.state.session_mut(session_id)
                        && let Some(turn) = session
                            .turns
                            .iter_mut()
                            .find(|turn| turn.turn_count == turn_count)
                    {
                        turn.checkpoint = Some(checkpoint);
                        attached_turn_id = Some(turn.id);
                    }
                    if let Some(turn_id) = attached_turn_id
                        && selected
                    {
                        // Reconcile a standalone card by row identity, then
                        // remeasure the terminal response when the card is
                        // hosted inline before its footer.
                        tide.splice_transcript_rows_after_visibility_change(&previous_kinds);
                        tide.remeasure_changed_files(turn_id);
                    }
                    let resume_queue = tide.pending_queue_drains.contains(&session_id);
                    if resume_queue {
                        tide.pending_queue_drains.retain(|id| *id != session_id);
                        tide.drain_queued_message(session_id, cx);
                    }
                    cx.notify();
                    if attached_turn_id.is_some() {
                        // Let the new transcript row paint before SQLite work.
                        // Without this save, a checkpoint that lands after the
                        // turn's final stream save can disappear on relaunch.
                        cx.spawn(async move |tide, cx| {
                            cx.background_executor().timer(STREAM_FRAME_INTERVAL).await;
                            let _ = tide.update(cx, |tide, _| tide.save());
                        })
                        .detach();
                    }
                })
                .ok();
            })
            .detach();
        }
    }

    pub(super) fn fork_session_from_response(
        &mut self,
        session_id: Uuid,
        turn_count: usize,
        cx: &mut Context<Self>,
    ) {
        if self.response_fork_preparations.contains_key(&session_id)
            || self.submission_preparations.contains(&session_id)
        {
            self.show_toast(tr!("session.response_cannot_fork"));
            cx.notify();
            return;
        }
        let Some(source) = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
        else {
            self.show_toast(tr!("session.response_unavailable"));
            cx.notify();
            return;
        };
        if self.state.selected_session != Some(session_id)
            || !matches!(source.status, SessionStatus::Idle | SessionStatus::Failed)
            || !source.provider.supports_conversation_fork()
            || source
                .turns
                .get(turn_count.saturating_sub(1))
                .is_none_or(|turn| turn.turn_count != turn_count || !turn.provider_turn_started)
        {
            self.show_toast(tr!("session.response_cannot_fork"));
            cx.notify();
            return;
        }
        let Some(source_workspace_path) = self
            .workspace_path_for_session(&source)
            .map(std::path::Path::to_path_buf)
        else {
            self.show_toast(tr!("errors.task_project_not_found"));
            cx.notify();
            return;
        };

        let provider = source.provider;
        let project_id = source.project_id;
        let fork_title = next_response_fork_title(
            source.display_title(),
            self.state
                .sessions
                .iter()
                .filter(|session| session.project_id == project_id)
                .map(AgentSession::display_title),
        );
        let turns_to_remove = source.provider_turns_after(turn_count);
        let driver = self
            .runtimes
            .get(&session_id)
            .map(|runtime| runtime.driver.clone());
        let driver_start = if driver.is_none() {
            match self.driver_start_request_for_session(&source, source_workspace_path.clone()) {
                Ok(request) => Some(request),
                Err(error) => {
                    self.show_toast(tr!("errors.fork_task", error = error));
                    cx.notify();
                    return;
                }
            }
        } else {
            None
        };
        let request = ResponseForkRequest {
            workspace_client: client::WorkspaceClient::new(self.daemon.client()),
            source,
            source_workspace_path,
            fork_title,
            turn_count,
            turns_to_remove,
            driver,
            driver_start,
        };

        self.response_fork_preparations
            .insert(session_id, turn_count);
        self.hide_toast();
        cx.notify();

        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { perform_response_fork(request) })
                .await;
            let _ = tide.update(cx, move |tide, cx| {
                tide.finish_response_fork(session_id, turn_count, provider, result, cx);
            });
        })
        .detach();
    }

    fn finish_response_fork(
        &mut self,
        session_id: Uuid,
        turn_count: usize,
        provider: ProviderKind,
        result: Result<PreparedResponseFork, String>,
        cx: &mut Context<Self>,
    ) {
        if self.response_fork_preparations.get(&session_id) != Some(&turn_count) {
            return;
        }
        self.response_fork_preparations.remove(&session_id);

        let PreparedResponseFork {
            forked,
            prepared_driver,
            checkpoint_warning,
        } = match result {
            Ok(prepared) => prepared,
            Err(error) => {
                self.drain_queued_message(session_id, cx);
                self.show_toast(error);
                cx.notify();
                return;
            }
        };

        if let Some(prepared) = prepared_driver
            && !self.runtimes.contains_key(&session_id)
        {
            self.install_prepared_driver(session_id, prepared);
        }
        self.invalidate_checkpoint_refs();

        let fork_id = forked.id;
        self.state.push_session(forked);
        self.analytics
            .track(crate::analytics::Event::ResponseForked {
                provider: provider.id(),
                turn_number: turn_count,
            });
        self.select_session(fork_id, cx);
        self.drain_queued_message(session_id, cx);
        match checkpoint_warning {
            Some(error) => {
                self.show_toast(tr!("session.forked_with_checkpoint_warning", error = error))
            }
            None => self.show_success_toast(tr!("session.forked_from_response")),
        }
        cx.notify();
    }

    /// Composer Enter clears the field after emitting its event. A response
    /// fork temporarily owns the source provider, so restore a keyboard
    /// submission on the next task turn instead of racing it against the fork.
    pub(super) fn defer_restore_composer_after_fork(
        &self,
        session_id: Uuid,
        prompt: String,
        cx: &mut Context<Self>,
    ) {
        let composer = self.composer.clone();
        cx.spawn(async move |tide, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(1))
                .await;
            let _ = tide.update(cx, |tide, cx| {
                if tide.state.selected_session == Some(session_id) {
                    composer.update(cx, |input, cx| {
                        if input.content(cx).is_empty() {
                            input.set_content(prompt, cx);
                        }
                    });
                }
            });
        })
        .detach();
    }

    pub(super) fn begin_message_edit(
        &mut self,
        action: UserMessageAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let UserMessageAction {
            session_id,
            message_id,
            turn_count,
        } = action;
        let Some((message_index, initial_message, attachments)) = self
            .state
            .sessions
            .iter()
            .find(|session| {
                session.id == session_id
                    && session.provider.supports_conversation_rollback()
                    && matches!(session.status, SessionStatus::Idle | SessionStatus::Failed)
            })
            .and_then(|session| {
                let turn = session
                    .turns
                    .iter()
                    .find(|turn| turn.turn_count == turn_count)?;
                session
                    .messages
                    .iter()
                    .enumerate()
                    .find_map(|(index, message)| {
                        (message.id == message_id
                            && message.turn_id == Some(turn.id)
                            && message.role == MessageRole::User)
                            .then(|| {
                                (
                                    index,
                                    message.visible_content().to_owned(),
                                    message.attachments.clone(),
                                )
                            })
                    })
            })
        else {
            self.show_toast(tr!("session.message_not_editable"));
            cx.notify();
            return;
        };

        let input = cx.new(|cx| ChatComposer::new(window, cx).padding_x(px(12.0), cx));
        input.update(cx, |input, cx| input.set_content(initial_message, cx));
        cx.subscribe(
            &input,
            |this: &mut Self, _, event: &ChatComposerEvent, cx| match event {
                ChatComposerEvent::Submit(prompt) => {
                    this.submit_message_edit_prompt(prompt.clone(), cx)
                }
                // An edited past message resubmits from that point; there is
                // no running turn for it to steer.
                ChatComposerEvent::SubmitSteer(prompt) => {
                    this.submit_message_edit_prompt(prompt.clone(), cx)
                }
                ChatComposerEvent::SteerQueued => {}
                ChatComposerEvent::Edited => cx.notify(),
                ChatComposerEvent::Focus => {}
                ChatComposerEvent::BackspaceOnEmpty => {}
                ChatComposerEvent::MediaPasted(_) => {}
            },
        )
        .detach();
        self.message_edit = Some(MessageEdit {
            session_id,
            message_id,
            turn_count,
            input: input.clone(),
            attachments,
        });
        self.hide_toast();
        self.remeasure_transcript_message(message_index);
        let focus_handle = input.read(cx).focus();
        window.focus(&focus_handle, cx);
        cx.notify();
    }

    pub(super) fn cancel_message_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .message_edit
            .as_ref()
            .is_some_and(|edit| self.submission_preparations.contains(&edit.session_id))
        {
            return;
        }
        let Some(edit) = self.message_edit.take() else {
            return;
        };
        let message_index = self.selected_session().and_then(|session| {
            session
                .messages
                .iter()
                .position(|message| message.id == edit.message_id)
        });
        if let Some(message_index) = message_index {
            self.remeasure_transcript_message(message_index);
        }
        let focus_handle = self.composer_focus(cx);
        window.focus(&focus_handle, cx);
        cx.notify();
    }

    pub(super) fn submit_message_edit(&mut self, cx: &mut Context<Self>) {
        let prompt = self
            .message_edit
            .as_ref()
            .map(|edit| edit.input.read(cx).content(cx).to_owned())
            .unwrap_or_default();
        self.submit_message_edit_prompt(prompt, cx);
    }

    fn submit_message_edit_prompt(&mut self, prompt: String, cx: &mut Context<Self>) {
        let Some(edit) = self.message_edit.clone() else {
            return;
        };
        if self.submission_preparations.contains(&edit.session_id) {
            return;
        }
        // Keyboard submission clears ChatComposer after emitting its event.
        // Use the event's captured value rather than rereading the field; the
        // button path enters here with its own pre-clear content as well.
        let prompt = prompt.trim().to_owned();
        if prompt.is_empty() && edit.attachments.is_empty() {
            self.show_toast(tr!("session.edited_message_empty"));
            cx.notify();
            return;
        }
        let mentions = edit
            .attachments
            .iter()
            .map(|attachment| attachment.mention.clone())
            .collect::<Vec<_>>();
        let provider_prompt = composer::merged_submission(&prompt, &mentions)
            .expect("edited text or retained attachments always form a submission");
        let display_content = (!edit.attachments.is_empty()).then_some(prompt);
        self.start_message_rewind(
            edit.clone(),
            ComposerSubmission {
                prompt: provider_prompt,
                display_content,
                attachments: edit.attachments,
            },
            cx,
        );
    }

    fn start_message_rewind(
        &mut self,
        edit: MessageEdit,
        submission: ComposerSubmission,
        cx: &mut Context<Self>,
    ) {
        let session_id = edit.session_id;
        let turn_count = edit.turn_count;
        let retained_turn_count = turn_count.saturating_sub(1);
        let Some(source) = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .filter(|session| {
                session
                    .turns
                    .iter()
                    .any(|turn| turn.turn_count == turn_count)
            })
        else {
            self.show_toast(tr!("session.message_unavailable"));
            cx.notify();
            return;
        };
        if self.state.selected_session != Some(session_id) {
            self.show_toast(tr!("session.select_before_rewind"));
            cx.notify();
            return;
        }
        if !matches!(source.status, SessionStatus::Idle | SessionStatus::Failed) {
            self.show_toast(tr!("session.stop_before_rewind"));
            cx.notify();
            return;
        }
        let rollback_turns = source.provider_turns_after(retained_turn_count);
        if !source.provider.supports_conversation_rollback()
            || (rollback_turns > 0 && source.provider_cursor.is_none())
        {
            self.show_toast(tr!(
                "session.provider_cannot_rewind",
                provider = source.provider.display_name()
            ));
            cx.notify();
            return;
        }
        let Some(project_path) = self
            .workspace_path_for_session(&source)
            .map(std::path::Path::to_path_buf)
        else {
            self.show_toast(tr!("errors.task_project_not_found"));
            cx.notify();
            return;
        };
        let driver = self
            .runtimes
            .get(&session_id)
            .map(|runtime| runtime.driver.clone());
        let driver_start = if rollback_turns > 0 && driver.is_none() {
            match self.driver_start_request_for_session(&source, project_path.clone()) {
                Ok(request) => Some(request),
                Err(error) => {
                    self.show_toast(error.to_string());
                    cx.notify();
                    return;
                }
            }
        } else {
            None
        };
        let previous_status = source.status;
        let previous_turn_count = source.turns.len();
        let edited_message_id = edit.message_id;
        let Some(edited_message_index) = source
            .turns
            .iter()
            .find(|turn| turn.turn_count == turn_count)
            .and_then(|turn| {
                source.messages.iter().position(|message| {
                    message.id == edited_message_id
                        && message.turn_id == Some(turn.id)
                        && message.role == MessageRole::User
                })
            })
        else {
            self.show_toast(tr!("session.message_unavailable"));
            cx.notify();
            return;
        };
        let request = MessageRewindRequest {
            workspace_client: client::WorkspaceClient::new(self.daemon.client()),
            session_id,
            previous_turn_count,
            project_path,
            retained_turn_count,
            rollback_turns,
            driver,
            driver_start,
        };

        // Optimistically leave edit mode and show the replacement bubble at
        // accept time. The main composer switches to its non-cancellable
        // spinner while every Git, process, and driver operation runs off the
        // UI thread. Failure restores both the original bubble and this edit
        // input.
        let original_message = self.state.session_mut(session_id).and_then(|session| {
            let message = session
                .messages
                .iter_mut()
                .find(|message| message.id == edited_message_id)?;
            let original = message.clone();
            message.content = submission.prompt.clone();
            message.display_content = submission.display_content.clone();
            message.attachments = submission.attachments.clone();
            session.status = SessionStatus::Connecting;
            session.updated_at = unix_time();
            Some(original)
        });
        let Some(original_message) = original_message else {
            self.show_toast(tr!("session.message_unavailable"));
            cx.notify();
            return;
        };
        self.message_edit = None;
        self.submission_preparations.insert(session_id);
        self.hide_toast();
        self.remeasure_transcript_message(edited_message_index);
        cx.notify();

        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { perform_message_rewind(request) })
                .await;
            let _ = tide.update(cx, move |tide, cx| {
                tide.finish_message_rewind(
                    edit,
                    submission,
                    edited_message_id,
                    original_message,
                    previous_status,
                    result,
                    cx,
                );
            });
        })
        .detach();
    }

    fn finish_message_rewind(
        &mut self,
        edit: MessageEdit,
        submission: ComposerSubmission,
        edited_message_id: Uuid,
        original_message: Message,
        previous_status: SessionStatus,
        result: Result<PreparedMessageRewind, String>,
        cx: &mut Context<Self>,
    ) {
        let session_id = edit.session_id;
        let turn_count = edit.turn_count;
        if !self.submission_preparations.remove(&session_id) {
            return;
        }
        let selected = self.state.selected_session == Some(session_id);
        let prepared = match result {
            Ok(prepared) => prepared,
            Err(error) => {
                if let Some(session) = self.state.session_mut(session_id) {
                    if let Some(message) = session
                        .messages
                        .iter_mut()
                        .find(|message| message.id == edited_message_id)
                    {
                        *message = original_message;
                    }
                    if session.status == SessionStatus::Connecting {
                        session.status = previous_status;
                    }
                }
                if selected && self.message_edit.is_none() {
                    self.message_edit = Some(edit.clone());
                }
                if selected
                    && let Some(message_index) = self.selected_session().and_then(|session| {
                        session
                            .messages
                            .iter()
                            .position(|message| message.id == edited_message_id)
                    })
                {
                    self.remeasure_transcript_message(message_index);
                }
                self.show_toast(error);
                cx.notify();
                return;
            }
        };
        let PreparedMessageRewind {
            provider_rewind_cursor,
            mut prepared_driver,
            cleanup_error,
        } = prepared;
        let retained_turn_count = turn_count.saturating_sub(1);
        let removed_turns = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| session.turns.len().saturating_sub(retained_turn_count));
        let Some(removed_turns) = removed_turns else {
            return;
        };
        if selected {
            self.sync_transcript_rows();
        }
        let previous_kinds = if selected {
            self.transcript_row_kinds.borrow().clone()
        } else {
            Vec::new()
        };
        if let Some(session) = self.state.session_mut(session_id) {
            if let Some(cursor) = provider_rewind_cursor.clone() {
                session.provider_cursor = Some(cursor);
            }
            session.truncate_after_turn(retained_turn_count);
            session.status = SessionStatus::Idle;
        }

        if let Some(prepared) = prepared_driver.as_mut() {
            // Startup announces the source cursor before a cold driver-backed
            // rollback finishes. It is stale now; do not let it overwrite the
            // rewound cursor after this driver is installed.
            while prepared.events.try_recv().is_ok() {}
        }
        if let Some(prepared) = prepared_driver {
            self.install_prepared_driver(session_id, prepared);
        }
        if let Some(runtime) = self.runtimes.get_mut(&session_id) {
            runtime
                .pending_events
                .retain(|event| matches!(event, DriverEvent::BackgroundWork(_)));
            runtime.stream_remeasure_pending = false;
            runtime.stream_phase = None;
            runtime.pending_permission = None;
            runtime.pending_user_input = None;
            runtime.pending_computer_approval = None;
        }
        self.invalidate_checkpoint_refs();
        if self
            .message_edit
            .as_ref()
            .is_some_and(|current| current.session_id == session_id)
        {
            self.message_edit = None;
        }
        if selected {
            self.activities_expanded.clear();
            self.expanded_activity_items.clear();
            self.expanded_turns.clear();
            self.expanded_changed_files.clear();
            self.transcript_control_focuses.borrow_mut().clear();
            self.splice_transcript_rows_after_visibility_change(&previous_kinds);
            self.show_toast(match cleanup_error {
                None => tr!("session.rewound", turn = turn_count),
                Some(error) => tr!(
                    "session.rewound_with_stale_refs",
                    turn = turn_count,
                    error = error
                ),
            });
        }
        self.analytics
            .track(crate::analytics::Event::ConversationRolledBack {
                provider: ProviderKind::Tide.id(),
                turns: removed_turns,
            });
        cx.notify();
        self.submit_submission_for_session(session_id, submission, cx);
    }

    /// Resolves the turn options a driver should run with, dropping a reasoning
    /// effort or service tier the resolved model does not offer. Driver start
    /// and in-session option changes both go through this so they cannot
    /// disagree about what the session is currently set to.
    pub(super) fn session_options(&self, session: &AgentSession) -> SessionOptions {
        let model = session
            .model
            .clone()
            .or_else(|| self.tide_models.first().map(|model| model.id.clone()));
        let model_metadata = self.model_metadata_for_session(session);
        let reasoning_effort = session.reasoning_effort.clone().filter(|effort| {
            model_metadata.is_some_and(|model| {
                model
                    .reasoning_efforts
                    .iter()
                    .any(|option| option.id == *effort)
            })
        });
        let service_tier = session.service_tier.clone().filter(|tier| {
            tier == "default"
                || model_metadata.is_some_and(|model| {
                    model.service_tiers.iter().any(|option| option.id == *tier)
                })
        });
        let context_window = session.context_window.clone().filter(|window| {
            model_metadata.is_some_and(|model| {
                model
                    .context_windows
                    .iter()
                    .any(|option| option.id == *window)
            })
        });
        SessionOptions {
            mode: session.runtime_mode,
            interaction_mode: session.interaction_mode,
            model,
            reasoning_effort,
            service_tier,
            context_window,
        }
    }

    /// Releases idle daemon runtimes for sessions nobody has touched in a
    /// while.
    ///
    /// The tide runtime stays resident between turns, so an abandoned task
    /// otherwise holds it — and, with Computer Use on, a whole browser surface
    /// — for as long as the app runs. Recreating a runtime is exactly the work
    /// the next prompt already does after Stop, and the resume cursor is
    /// persisted, so the conversation survives.
    pub(super) fn reap_idle_sessions(&mut self) {
        if self.last_idle_session_sweep.elapsed() < IDLE_SESSION_SWEEP_INTERVAL {
            return;
        }
        self.last_idle_session_sweep = Instant::now();
        let idle = self
            .runtimes
            .iter()
            .filter(|(session_id, runtime)| {
                let session = self
                    .state
                    .sessions
                    .iter()
                    .find(|session| session.id == **session_id);
                session_is_reapable(
                    session,
                    runtime.last_active_at.elapsed(),
                    self.session_has_live_background_work(**session_id),
                )
            })
            .map(|(session_id, _)| *session_id)
            .collect::<Vec<_>>();
        for session_id in idle {
            // Idle reaping is an explicit daemon-runtime release. Merely
            // dropping a client attachment must not stop work observed by a
            // second desktop or browser client.
            if let Some(runtime) = self.runtimes.remove(&session_id) {
                runtime.driver.close();
            }
        }
    }

    /// Applies a changed model, effort, tier, or mode to a session. Transports
    /// that carry these per turn absorb the change and keep running; the rest
    /// are torn down so the next prompt starts with the new options.
    pub(super) fn apply_session_options(&mut self, session_id: Uuid, cx: &mut Context<Self>) {
        let Some(options) = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .map(|session| self.session_options(session))
        else {
            return;
        };
        let Some(runtime) = self.runtimes.get_mut(&session_id) else {
            return;
        };
        runtime.options_generation = runtime.options_generation.wrapping_add(1);
        let generation = runtime.options_generation;
        let driver = runtime.driver.clone();
        cx.spawn(async move |tide, cx| {
            let applied = cx
                .background_executor()
                .spawn(async move { driver.apply_options(options) })
                .await;
            let _ = tide.update(cx, |tide, cx| {
                let is_current = tide
                    .runtimes
                    .get(&session_id)
                    .is_some_and(|runtime| runtime.options_generation == generation);
                if is_current && !applied {
                    tide.reset_session_runtime(session_id);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn driver_start_request_for_session(
        &self,
        session: &AgentSession,
        cwd: PathBuf,
    ) -> anyhow::Result<DriverStartRequest> {
        // Tide runs inside the daemon, so there is no client-side binary to
        // resolve: the start request carries session options only.
        let SessionOptions {
            mode,
            interaction_mode,
            model,
            reasoning_effort,
            service_tier,
            context_window,
        } = self.session_options(&session);
        Ok(DriverStartRequest {
            session_id: session.id,
            provider: session.provider,
            options: DriverStartOptions {
                binary: PathBuf::new(),
                cwd,
                mode,
                interaction_mode,
                model,
                reasoning_effort,
                service_tier,
                context_window,
                agent_preset: None,
                computer_use_enabled: cfg!(target_os = "macos") && self.state.computer_use_enabled,
                provider_cursor: session.provider_cursor.clone(),
            },
            event_wake: self.event_wake_tx.clone(),
            daemon: self.daemon.clone(),
        })
    }

    /// Start the session's tide runtime for a goal operation, without a prompt
    /// or a turn. Goals live on the daemon-side thread itself: prepare the
    /// workspace, start the runtime, and let the queued goal operations drain
    /// once it installs. The session stays `Idle` throughout — no turn begins
    /// and nothing lands in the transcript.
    pub(super) fn start_goal_runtime(&mut self, session_id: Uuid, cx: &mut Context<Self>) {
        if self.runtimes.contains_key(&session_id)
            || self.goal_runtime_starts.contains(&session_id)
            || self.submission_preparations.contains(&session_id)
        {
            // An installed or installing runtime picks the queue up when the
            // install path drains pending goal operations.
            return;
        }
        let Some(session) = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
        else {
            self.pending_goal_operations.remove(&session_id);
            return;
        };
        let project_id = session.project_id;
        let workspace = session.workspace.clone();
        let next_turn_count = session.turns.len() + 1;
        let provisional_cwd = self
            .workspace_path_for_session(session)
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let driver_start = self.driver_start_request_for_session(session, provisional_cwd);
        let Some(project) = self
            .state
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
        else {
            self.pending_goal_operations.remove(&session_id);
            self.show_toast(tr!("errors.prepare_task_project_not_found"));
            cx.notify();
            return;
        };
        // A fresh worktree task names its branch after the first prompt; when
        // the goal arrives first, the objective is that intent.
        let naming_prompt = self
            .pending_goal_operations
            .get(&session_id)
            .into_iter()
            .flatten()
            .rev()
            .find_map(|operation| match operation {
                crate::model::GoalOperation::Set {
                    objective: Some(objective),
                    ..
                } => Some(objective.clone()),
                _ => None,
            })
            .unwrap_or_else(|| tr!("goal.title"));
        self.goal_runtime_starts.insert(session_id);
        cx.notify();
        let workspace_client = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let prepared = cx
                .background_executor()
                .spawn(async move {
                    prepare_submission(
                        workspace_client,
                        project,
                        workspace,
                        Some(driver_start),
                        session_id,
                        &naming_prompt,
                        next_turn_count,
                    )
                })
                .await;
            let _ = tide.update(cx, move |tide, cx| {
                tide.finish_goal_runtime_start(session_id, prepared, cx);
            });
        })
        .detach();
    }

    fn finish_goal_runtime_start(
        &mut self,
        session_id: Uuid,
        prepared: anyhow::Result<PreparedSubmission>,
        cx: &mut Context<Self>,
    ) {
        if !self.goal_runtime_starts.remove(&session_id) {
            return;
        }
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                // The goal is lost but nothing else is: messages queued
                // behind this start resubmit through the ordinary path,
                // which starts its own runtime.
                self.pending_goal_operations.remove(&session_id);
                self.unwind_unconfirmed_pursuit_turn(session_id);
                self.show_toast(error.to_string());
                self.drain_queued_message(session_id, cx);
                cx.notify();
                return;
            }
        };
        let PreparedSubmission {
            workspace,
            checkpoint_warning: _,
            driver,
        } = prepared;
        if !self
            .state
            .sessions
            .iter()
            .any(|session| session.id == session_id)
        {
            // The task was removed while its provider was starting.
            self.pending_goal_operations.remove(&session_id);
            if let Some(Ok(prepared)) = driver {
                prepared.handle.close();
            }
            return;
        }
        let workspace_changed = self.state.session_mut(session_id).is_some_and(|session| {
            let changed = session.workspace != workspace;
            session.workspace = workspace;
            changed
        });
        if workspace_changed && self.state.selected_session == Some(session_id) {
            self.invalidate_workspace_queries(cx);
            self.reload_clean_right_panel_file_editors(cx);
            self.ensure_right_panel_terminals(cx);
        }
        match driver {
            Some(Ok(prepared)) => {
                if self.runtimes.contains_key(&session_id) {
                    // Another path installed a runtime meanwhile; that thread
                    // is the session's, so the goal routes there instead.
                    prepared.handle.close();
                    self.drain_pending_goal_operations(session_id);
                } else {
                    // Install drains the pending operations itself.
                    self.install_prepared_driver(session_id, prepared);
                }
            }
            None => self.drain_pending_goal_operations(session_id),
            Some(Err(error)) => {
                self.pending_goal_operations.remove(&session_id);
                self.unwind_unconfirmed_pursuit_turn(session_id);
                self.show_toast(error.to_string());
                self.drain_queued_message(session_id, cx);
                cx.notify();
                return;
            }
        }
        self.save();
        self.drain_queued_message(session_id, cx);
        cx.notify();
    }

    fn install_prepared_driver(
        &mut self,
        session_id: Uuid,
        prepared: PreparedDriver,
    ) -> DriverHandle {
        let handle = prepared.handle.clone();
        self.runtimes.insert(
            session_id,
            SessionRuntime {
                driver: prepared.handle,
                options_generation: 0,
                events: prepared.events,
                pending_events: VecDeque::new(),
                pending_steers: VecDeque::new(),
                stream_phase: None,
                stream_remeasure_pending: false,
                pending_permission: None,
                pending_user_input: None,
                pending_computer_approval: None,
                computer_use_previews: Vec::new(),
                computer_session_grants: HashSet::new(),
                last_driver_error: None,
                last_active_at: Instant::now(),
                last_background_refresh_at: Instant::now()
                    .checked_sub(BACKGROUND_WORK_REFRESH_INTERVAL)
                    .unwrap_or_else(Instant::now),
            },
        );
        // Startup can emit before the background task hands this receiver to
        // the runtime map. Wake once after installation so those buffered
        // events cannot be stranded behind an already-consumed edge.
        signal_event_pump(&self.event_wake_tx);
        // Goal operations accepted while no runtime existed ride the first
        // install, whichever path performed it. The driver applies them once
        // its thread opens, before any queued prompt.
        self.drain_pending_goal_operations(session_id);
        handle
    }

    pub(super) fn submit_composer_submission(
        &mut self,
        submission: ComposerSubmission,
        cx: &mut Context<Self>,
    ) {
        let Some(session) = self.selected_session() else {
            return;
        };
        if self.response_fork_preparations.contains_key(&session.id) {
            return;
        }
        if session.is_busy() {
            // While the agent is working, Enter queues a follow-up instead of
            // refusing the message. The queue drains once the turn settles.
            self.enqueue_follow_up_submission(session.id, submission, cx);
            return;
        }
        self.submit_submission_for_session(session.id, submission, cx);
    }

    /// Deliver a steering message into the running turn. Sessions without a
    /// live-turn transport (or a session that is not actively working) fall
    /// back to queueing a follow-up.
    pub(super) fn steer_composer_submission(
        &mut self,
        submission: ComposerSubmission,
        cx: &mut Context<Self>,
    ) {
        let Some(session) = self.selected_session().cloned() else {
            return;
        };
        if !session.is_busy() {
            self.submit_composer_submission(submission, cx);
            return;
        }
        // A turn that has not reached the engine yet cannot be steered; the
        // driver reports the outcome asynchronously via SteerAccepted or
        // SteerRejected once it is handed off.
        if !self.session_can_steer(&session) {
            self.enqueue_follow_up_submission(session.id, submission, cx);
            return;
        }
        let provider_prompt = submission.prompt.clone();
        if let Some(runtime) = self.runtimes.get_mut(&session.id) {
            runtime.driver.steer(provider_prompt);
            runtime.pending_steers.push_back(submission);
        } else {
            self.enqueue_follow_up_submission(session.id, submission, cx);
        }
        cx.notify();
    }

    pub(super) fn session_can_steer(&self, session: &AgentSession) -> bool {
        session_has_active_provider_turn(session)
            && self
                .runtimes
                .get(&session.id)
                .is_some_and(|runtime| runtime.driver.supports_steer())
    }

    /// Resolve presentation-preserving composer syntax immediately before a
    /// prompt crosses into the tide engine: template commands expand to their
    /// body; everything else passes through untouched.
    fn resolve_provider_submission(&self, prompt: &str) -> String {
        crate::composer_complete::resolved_submission(prompt, &self.slash_command_index)
            .unwrap_or_else(|| prompt.to_owned())
    }

    pub(super) fn enqueue_follow_up_submission(
        &mut self,
        session_id: Uuid,
        mut submission: ComposerSubmission,
        cx: &mut Context<Self>,
    ) {
        submission.prompt = submission.prompt.trim().to_owned();
        if submission.prompt.is_empty() {
            return;
        }
        if let Some(session) = self.state.session_mut(session_id) {
            session
                .queued_messages
                .push(submission.into_queued_message());
            session.updated_at = unix_time();
        }
        self.save();
        cx.notify();
    }

    pub(super) fn remove_queued_message(
        &mut self,
        session_id: Uuid,
        message_id: Uuid,
        cx: &mut Context<Self>,
    ) {
        if let Some(session) = self.state.session_mut(session_id) {
            session
                .queued_messages
                .retain(|message| message.id != message_id);
        }
        self.save();
        cx.notify();
    }

    /// Pop a queued message back into the composer so the user can edit and
    /// resubmit it.
    pub(super) fn edit_queued_message(
        &mut self,
        session_id: Uuid,
        message_id: Uuid,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(message) = self.state.session_mut(session_id).and_then(|session| {
            let index = session
                .queued_messages
                .iter()
                .position(|message| message.id == message_id)?;
            Some(session.queued_messages.remove(index))
        }) else {
            return;
        };
        self.restore_composer_submission(ComposerSubmission::from_queued_message(message), cx);
        let focus_handle = self.composer_focus(cx);
        window.focus(&focus_handle, cx);
        self.save();
        cx.notify();
    }

    /// Deliver a queued follow-up into the running turn right away instead of
    /// waiting for the turn to settle. Falls through the same paths as a
    /// composer steer: an idle session starts a fresh turn, an unsteerable
    /// one re-queues the message.
    pub(super) fn steer_queued_message(
        &mut self,
        session_id: Uuid,
        message_id: Uuid,
        cx: &mut Context<Self>,
    ) {
        let Some(message) = self.state.session_mut(session_id).and_then(|session| {
            let index = session
                .queued_messages
                .iter()
                .position(|message| message.id == message_id)?;
            Some(session.queued_messages.remove(index))
        }) else {
            return;
        };
        self.save();
        self.steer_composer_submission(ComposerSubmission::from_queued_message(message), cx);
    }

    /// Activate the same action as the oldest queued row's Steer control.
    /// When that control is unavailable, leave the queue untouched rather
    /// than removing and re-queueing its first message at the back.
    pub(super) fn steer_oldest_queued_message(&mut self, cx: &mut Context<Self>) {
        let Some((session_id, message_id)) = self.selected_session().and_then(|session| {
            if !self.session_can_steer(session) {
                return None;
            }
            Some((session.id, session.queued_messages.first()?.id))
        }) else {
            return;
        };
        self.steer_queued_message(session_id, message_id, cx);
    }

    /// Start the next queued follow-up as a fresh turn. Only called once a
    /// settled turn has been fully closed, so the session is Idle.
    fn drain_queued_message(&mut self, session_id: Uuid, cx: &mut Context<Self>) {
        if self.response_fork_preparations.contains_key(&session_id) {
            return;
        }
        let Some(session) = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
        else {
            return;
        };
        if session.is_busy()
            || session.queued_messages.is_empty()
            || self.ending_checkpoint_pending(session_id)
            // Messages parked behind a goal-initiated provider start stay
            // queued until that runtime installs.
            || self.goal_runtime_starts.contains(&session_id)
        {
            return;
        }
        let Some(message) = self
            .state
            .session_mut(session_id)
            .map(|session| session.queued_messages.remove(0))
        else {
            return;
        };
        self.submit_submission_for_session(
            session_id,
            ComposerSubmission::from_queued_message(message),
            cx,
        );
    }

    fn submit_submission_for_session(
        &mut self,
        session_id: Uuid,
        submission: ComposerSubmission,
        cx: &mut Context<Self>,
    ) {
        if self.response_fork_preparations.contains_key(&session_id) {
            return;
        }
        let selected = self.state.selected_session == Some(session_id);
        let Some(session) = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
        else {
            return;
        };
        if self.ending_checkpoint_pending(session_id) {
            self.enqueue_follow_up_submission(session_id, submission, cx);
            self.defer_queue_drain(session_id);
            return;
        }
        // A goal operation is already starting this session's provider.
        // Queue the message so it lands on that thread — after the goal —
        // instead of racing a second provider process into existence.
        if self.goal_runtime_starts.contains(&session_id) {
            self.enqueue_follow_up_submission(session_id, submission, cx);
            self.defer_queue_drain(session_id);
            return;
        }
        if session.status.is_busy() {
            self.enqueue_follow_up_submission(session_id, submission, cx);
            return;
        }
        let prompt = submission.prompt.clone();
        let human_prompt = submission.human_prompt();
        let has_input = !submission
            .display_content
            .as_deref()
            .unwrap_or(&submission.prompt)
            .trim()
            .is_empty();
        let next_turn_count = session.turns.len() + 1;
        let provider = session.provider.id();
        let model = self
            .session_options(session)
            .model
            .unwrap_or_else(|| "default".into());
        let workspace_kind = if session.workspace.is_worktree() {
            "worktree"
        } else {
            "local"
        };
        let attachment_count = submission.attachments.len();
        let project_id = session.project_id;
        let workspace = session.workspace.clone();
        let driver_start = (!self.runtimes.contains_key(&session_id)).then(|| {
            let provisional_cwd = self
                .workspace_path_for_session(session)
                .map(std::path::Path::to_path_buf)
                .unwrap_or_default();
            self.driver_start_request_for_session(session, provisional_cwd)
        });
        let Some(project) = self
            .state
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
        else {
            if selected {
                self.restore_composer_submission(submission, cx);
                self.show_toast(tr!("errors.prepare_task_project_not_found"));
            }
            cx.notify();
            return;
        };
        let projectless = project.is_projectless();
        // Busy is visible before any Git work begins. The separate transient
        // set keeps this non-cancellable phase visually distinct from a
        // connecting provider, whose runtime already has a working Stop path.
        //
        // The turn also begins now, not once preparation settles: the sent
        // message and its working indicator belong in the transcript the
        // moment the submission is accepted — a first prompt otherwise leaves
        // the empty state on screen for as long as a `git add -A` takes.
        // Preparation failure unwinds the turn and restores the prompt.
        if selected {
            self.sync_transcript_rows();
        }
        let previous_kinds = if selected {
            self.transcript_row_kinds.borrow().clone()
        } else {
            Vec::new()
        };
        let mut title_placeholder = None;
        let transcript_anchor = if let Some(session) = self.state.session_mut(session_id) {
            // The first prompt of an untitled session is the one chance to
            // replace the placeholder with a generated title; mirror
            // set_title_from_prompt's own guard so later submissions and
            // resumed sessions never trigger a second run.
            let eligible_for_generated_title = session.messages.is_empty()
                && session.title == AgentSession::DEFAULT_TITLE
                && session.auto_title.is_none();
            session.set_title_from_prompt(&human_prompt);
            title_placeholder = eligible_for_generated_title
                .then(|| session.auto_title.clone())
                .flatten();
            let turn_id = session.begin_turn_with_presentation(
                &prompt,
                submission.display_content.clone(),
                submission.attachments.clone(),
            );
            session.status = SessionStatus::Connecting;
            session.updated_at = unix_time();
            selected.then_some(TranscriptAnchor {
                session_id,
                turn_id,
            })
        } else {
            None
        };
        if let Some(placeholder) = title_placeholder {
            self.schedule_session_title_generation(
                session_id,
                human_prompt.clone(),
                placeholder,
                cx,
            );
        }
        self.analytics
            .track(crate::analytics::Event::TurnSubmitted {
                provider,
                model,
                turn_number: next_turn_count,
                workspace: workspace_kind,
                projectless,
                attachment_count,
                has_input,
            });
        self.submission_preparations.insert(session_id);
        if selected {
            self.activities_expanded.clear();
            self.expanded_activity_items.clear();
            self.expanded_turns.clear();
            self.expanded_changed_files.clear();
            self.transcript_control_focuses.borrow_mut().clear();
            self.message_edit = None;
            self.hide_toast();
            self.transcript_anchor.set(transcript_anchor);
            // Provisional reservation: the anchored list has no measured
            // bounds until its first paint, and a zero end space cannot hold
            // the sent row at the viewport top — without scroll room past the
            // tail, the list clamps to its end and the prompt paints a frame
            // at the bottom before the first measured frame lifts it. Seed a
            // full viewport of end space instead; the overshoot is invisible
            // under the top anchor and the first measured frame trues it up.
            let mut provisional = self.transcript_rows.viewport_bounds().size.height;
            if provisional <= Pixels::ZERO {
                provisional = self.anchored_transcript_rows.viewport_bounds().size.height;
            }
            self.transcript_anchor_end_space.set(provisional);
            self.transcript_anchor_following.set(true);
            self.splice_transcript_rows_after_visibility_change(&previous_kinds);
            self.scroll_transcript_to_anchor();
        }
        cx.notify();

        let preparation_prompt = human_prompt;
        let workspace_client = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let prepared = cx
                .background_executor()
                .spawn(async move {
                    prepare_submission(
                        workspace_client,
                        project,
                        workspace,
                        driver_start,
                        session_id,
                        &preparation_prompt,
                        next_turn_count,
                    )
                })
                .await;
            let _ = tide.update(cx, move |tide, cx| {
                tide.finish_submission_preparation(session_id, submission, prepared, cx);
            });
        })
        .detach();
    }

    fn finish_submission_preparation(
        &mut self,
        session_id: Uuid,
        submission: ComposerSubmission,
        prepared: anyhow::Result<PreparedSubmission>,
        cx: &mut Context<Self>,
    ) {
        if !self.submission_preparations.contains(&session_id) {
            return;
        }
        let selected = self.state.selected_session == Some(session_id);
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                self.submission_preparations.remove(&session_id);
                self.track_active_turn_outcome(
                    session_id,
                    crate::analytics::TurnOutcome::PreparationFailed,
                );
                if selected {
                    self.sync_transcript_rows();
                }
                let previous_kinds = if selected {
                    self.transcript_row_kinds.borrow().clone()
                } else {
                    Vec::new()
                };
                if let Some(session) = self.state.session_mut(session_id)
                    && session.status == SessionStatus::Connecting
                {
                    // The submission never reached a provider and its prompt
                    // returns to the composer, so the eagerly-begun turn and
                    // its message leave the transcript with it.
                    if let Some(turn_id) = session.active_turn_id() {
                        session.unwind_unstarted_turn(turn_id);
                    }
                    session.status = SessionStatus::Idle;
                }
                if selected {
                    if self
                        .transcript_anchor
                        .get()
                        .is_some_and(|anchor| anchor.session_id == session_id)
                    {
                        self.transcript_anchor.set(None);
                        self.transcript_anchor_following.set(false);
                    }
                    self.splice_transcript_rows_after_visibility_change(&previous_kinds);
                    self.restore_composer_submission(submission, cx);
                    self.show_toast(tr!("errors.create_worktree", error = error));
                }
                cx.notify();
                return;
            }
        };
        let PreparedSubmission {
            workspace,
            checkpoint_warning,
            driver: prepared_driver,
        } = prepared;
        // The turn began at accept time; it must still be the untouched one
        // this preparation belongs to. Cancellation is blocked while the
        // preparation set holds the session, so a mismatch means the session
        // was replaced under the preparation rather than a user action.
        let can_start = self
            .state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .is_some_and(|session| {
                session.status == SessionStatus::Connecting
                    && session.turns.last().is_some_and(|turn| {
                        turn.status == TurnStatus::Running && !turn.provider_turn_started
                    })
            });
        if !can_start {
            self.submission_preparations.remove(&session_id);
            cx.notify();
            return;
        }

        let workspace_changed = self.state.session_mut(session_id).is_some_and(|session| {
            let changed = session.workspace != workspace;
            session.workspace = workspace;
            changed
        });
        if selected && workspace_changed {
            self.invalidate_workspace_queries(cx);
            self.reload_clean_right_panel_file_editors(cx);
            self.ensure_right_panel_terminals(cx);
        }
        let driver = match prepared_driver {
            None => self
                .runtimes
                .get(&session_id)
                .map(|runtime| runtime.driver.clone())
                .ok_or_else(|| anyhow::anyhow!(tr!("errors.prepared_runtime_unavailable"))),
            Some(Ok(prepared)) => Ok(self.install_prepared_driver(session_id, prepared)),
            Some(Err(error)) => Err(error),
        };
        self.invalidate_checkpoint_refs();
        if let Some(runtime) = self.runtimes.get_mut(&session_id) {
            runtime
                .pending_events
                .retain(|event| matches!(event, DriverEvent::BackgroundWork(_)));
            runtime.pending_steers.clear();
            runtime.stream_remeasure_pending = false;
            runtime.stream_phase = None;
            runtime.pending_permission = None;
            runtime.pending_user_input = None;
            runtime.pending_computer_approval = None;
            runtime.last_active_at = Instant::now();
        }
        // The transcript already shows the turn — the prompt message, its
        // anchor, and the working indicator all landed at accept time. Only
        // preparation's own output surfaces here.
        if selected && let Some(warning) = checkpoint_warning {
            self.show_toast(warning);
        }
        // Composer syntax resolves here, at the seam between the transcript
        // and the transport. The user message keeps the typed slash form,
        // while template commands expand to their body; everything else
        // passes through untouched.
        let prompt = submission.prompt;
        let driver_prompt = self.resolve_provider_submission(&prompt);
        let mut failed_to_start = false;
        match driver {
            Ok(driver) => driver.prompt(driver_prompt),
            Err(error) => {
                failed_to_start = true;
                let message = tr!("errors.start_agent", error = error);
                if let Some(session) = self.state.session_mut(session_id) {
                    session.status = SessionStatus::Failed;
                    session.push_message(MessageRole::Assistant, message);
                }
                self.finish_active_turn_with_analytics(
                    session_id,
                    TurnStatus::Failed,
                    crate::analytics::TurnOutcome::StartFailed,
                );
            }
        }
        // From this point onward `cancel_turn` has either a live driver to
        // cancel or a settled startup failure. The next frame must therefore
        // show Stop (or Send after failure), never the preparation spinner.
        self.submission_preparations.remove(&session_id);
        if failed_to_start {
            self.capture_latest_turn_checkpoint_for(session_id);
            self.start_pending_checkpoint_captures(cx);
        }
        cx.notify();
        // Persist on the next frame boundary. Saving is intentionally after
        // the spinner-to-Stop paint: SQLite or blob externalization must not
        // hold the final preparation frame motionless.
        cx.spawn(async move |tide, cx| {
            cx.background_executor().timer(STREAM_FRAME_INTERVAL).await;
            let _ = tide.update(cx, |tide, _| tide.save());
        })
        .detach();
    }

    pub(super) fn collect_runtime_events(runtime: &mut SessionRuntime) {
        while let Ok(event) = runtime.events.try_recv() {
            runtime.pending_events.push_back(event);
        }
    }

    pub(super) fn drain_event_pump(&mut self, cx: &mut Context<Self>) -> EventPumpSchedule {
        // `|` on purpose: a busy provider must not starve the other result
        // queues just because its own drain reported a change first.
        if self.drain_driver_events(cx)
            | self.drain_computer_permission_events()
            | self.drain_task_state_sync_events(cx)
            | self.drain_tide_ops_events(cx)
            | self.drain_git_ops_events(cx)
            | self.drain_rag_ops_events(cx)
        {
            cx.notify();
        }
        if std::mem::take(&mut self.workspace_queries_stale) {
            self.invalidate_workspace_queries(cx);
        }
        if std::mem::take(&mut self.composer_sources_stale) {
            self.refresh_composer_sources(cx);
        }
        self.maybe_refresh_background_work(cx);
        // A finished turn asks for a checkpoint from a handler with no
        // `Context`; this is where that `git` work leaves the UI thread.
        self.start_pending_checkpoint_captures(cx);

        if self
            .runtimes
            .values()
            .any(|runtime| !runtime.pending_events.is_empty() || runtime.stream_remeasure_pending)
        {
            EventPumpSchedule::StreamFrame
        } else if let Some(delay) = self.background_output_refresh_delay() {
            EventPumpSchedule::BackgroundOutput(delay)
        } else {
            EventPumpSchedule::Idle
        }
    }

    pub(super) fn drain_computer_permission_events(&mut self) -> bool {
        let mut changed = false;
        while let Ok(result) = self.computer_permission_events.try_recv() {
            self.computer_permission_request_pending = false;
            match result {
                Ok(permissions) => self.computer_permissions = permissions,
                Err(error) => self.show_toast(error),
            }
            changed = true;
        }
        changed
    }

    pub(super) fn drain_driver_events(&mut self, cx: &mut Context<Self>) -> bool {
        let session_ids = self.runtimes.keys().copied().collect::<Vec<_>>();
        let mut changed = false;
        let mut persisted_state_changed = false;
        let mut force_save = false;
        let mut selected_changed = false;
        for session_id in session_ids {
            let Some(mut runtime) = self.runtimes.remove(&session_id) else {
                continue;
            };
            let follow_up_remeasure = std::mem::take(&mut runtime.stream_remeasure_pending);
            Self::collect_runtime_events(&mut runtime);
            let mut runtime_changed = false;
            let mut background_changed = false;
            let mut markdown_changed = false;
            let mut keep_runtime = true;
            while let Some(event) = runtime.pending_events.front() {
                let kind = stream_delta_kind(event);
                let event = if let Some(kind) = kind {
                    pop_stream_batch(&mut runtime.pending_events, kind)
                } else {
                    runtime.pending_events.pop_front()
                };
                let Some(event) = event else {
                    break;
                };
                let background_event = matches!(event, DriverEvent::BackgroundWork(_));
                // Output deltas and sub-agent block timelines batch behind the
                // registry's 10Hz output-cache wake; repainting and saving for
                // every provider chunk would turn a noisy command (or a chatty
                // child agent) into UI-thread work.
                let background_output_delta = matches!(
                    event,
                    DriverEvent::BackgroundWork(
                        BackgroundWorkEvent::OutputDelta { .. }
                            | BackgroundWorkEvent::SubagentBlocks { .. }
                    )
                );
                force_save |= matches!(
                    event,
                    DriverEvent::Connected { .. }
                        | DriverEvent::AgentPresetSelected(_)
                        | DriverEvent::AutoTitleUpdated(_)
                        | DriverEvent::Permission { .. }
                        | DriverEvent::SteerAccepted { .. }
                        | DriverEvent::SteerRejected { .. }
                        | DriverEvent::TurnFinished { .. }
                        | DriverEvent::Error(_)
                        | DriverEvent::ProcessExited
                );
                // Reasoning is markdown too (the live peek renders it), and
                // this flag is also what routes the pump onto the coalesced
                // `StreamFrame` cadence: without it a reasoning-only drain
                // reported Idle, so every fast thinking chunk woke the pump
                // for an immediate drain-and-notify — 40+ full re-renders a
                // second, sailing straight past the 120 ms commit floor.
                markdown_changed |= matches!(
                    event,
                    DriverEvent::TextDelta(_) | DriverEvent::ReasoningDelta(_)
                );
                if background_output_delta {
                    // Batched behind the registry's 10Hz output-cache wake
                    // (see the classification above).
                } else if background_event {
                    background_changed = true;
                } else {
                    runtime_changed = true;
                }
                // Per-step usage deltas fold into the session's persisted
                // totals here, before any reducer sees the event — the
                // reducer below persists context occupancy; this keeps the
                // Context Window detail alive across session switches and
                // relaunches.
                if let DriverEvent::UsageUpdated {
                    breakdown: Some(step),
                    ..
                } = &event
                {
                    if let Some(session) = self.state.session_mut(session_id) {
                        session
                            .usage_totals
                            .get_or_insert_with(SessionUsageTotals::default)
                            .apply_step(step);
                        self.state.mark_session_dirty(session_id);
                    }
                }
                // The Stream log tail rides the same pre-dispatch point:
                // one classified line per event, capped per session.
                if let Some(entry) = inspector::stream_log_entry(&event, unix_time_millis()) {
                    let log = self.inspector_stream_log.entry(session_id).or_default();
                    log.push_back(entry);
                    while log.len() > inspector::STREAM_LOG_CAP {
                        log.pop_front();
                    }
                }
                keep_runtime &= self.handle_driver_event(session_id, &mut runtime, event, true, cx);
                if !keep_runtime {
                    break;
                }
            }
            runtime.stream_remeasure_pending = markdown_changed;
            if keep_runtime {
                self.runtimes.insert(session_id, runtime);
            }
            changed |= runtime_changed || background_changed;
            persisted_state_changed |= runtime_changed;
            if self.state.selected_session == Some(session_id)
                && (runtime_changed || follow_up_remeasure)
            {
                selected_changed = true;
            }
        }

        if !self.pending_queue_drains.is_empty() {
            let drains = std::mem::take(&mut self.pending_queue_drains);
            for session_id in drains {
                if self.ending_checkpoint_pending(session_id) {
                    self.defer_queue_drain(session_id);
                } else {
                    self.drain_queued_message(session_id, cx);
                }
            }
            changed = true;
        }

        if persisted_state_changed {
            self.stream_state_dirty = true;
        }
        if selected_changed {
            self.remeasure_transcript_tail();
            if self.timeline_v2 {
                self.timeline_v2_remeasure_tail(cx);
            }
        }
        if self.stream_state_dirty
            && (force_save || self.last_stream_save.elapsed() >= STREAM_SAVE_INTERVAL)
        {
            self.save();
        }
        changed || selected_changed
    }
}

#[cfg(test)]
mod response_fork_title_tests {
    use super::next_response_fork_title;

    #[test]
    fn response_fork_titles_advance_one_numbered_sequence() {
        assert_eq!(
            next_response_fork_title("Fix the bug", ["Fix the bug"]),
            "Fix the bug (2)"
        );
        assert_eq!(
            next_response_fork_title(
                "Fix the bug",
                ["Fix the bug", "Fix the bug (2)", "Fix the bug (4)"]
            ),
            "Fix the bug (5)"
        );
        assert_eq!(
            next_response_fork_title("Fix the bug (2)", ["Fix the bug", "Fix the bug (2)"]),
            "Fix the bug (3)"
        );
        assert_eq!(
            next_response_fork_title("Plan (2026)", ["Plan (2026)"]),
            "Plan (2026) (2)"
        );
    }
}

// ── Tide provider management ─────────────────────────────────────────
//
// The embedded Tide provider's credentials live in tide's own config and
// keychain. Every mutation goes over the backend commands and comes back as
// a fresh provider list; the shared event pump drains the results so the
// Providers page and the model picker stay in sync with one source of truth.

impl Tide {
    /// Fire a tide command at the backend; the reply lands in
    /// [`Self::drain_tide_ops_events`] via the shared event pump.
    pub(super) fn tide_dispatch(&self, command: client::Command) {
        let ops_tx = self.tide.ops_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let daemon = self.daemon.client();
        let _ = std::thread::Builder::new()
            .name("tide-tide-providers".into())
            .spawn(move || {
                let event = match daemon.request(Uuid::nil(), Uuid::nil(), command) {
                    Ok(client::ResponsePayload::TideProviders { providers }) => {
                        super::tide_providers::TideOpsEvent::Providers(Ok(providers))
                    }
                    Ok(client::ResponsePayload::TideModels { models }) => {
                        super::tide_providers::TideOpsEvent::Models(Ok(models))
                    }
                    Ok(client::ResponsePayload::TideProtocol { api_style, error }) => {
                        match (api_style, error) {
                            (Some(style), None) => {
                                super::tide_providers::TideOpsEvent::Protocol(Ok(style))
                            }
                            (_, Some(error)) => {
                                super::tide_providers::TideOpsEvent::Protocol(Err(error))
                            }
                            (None, None) => super::tide_providers::TideOpsEvent::Protocol(Err(
                                "the endpoint answered but named no protocol".into(),
                            )),
                        }
                    }
                    Ok(client::ResponsePayload::TideConnection { ok, error }) => {
                        if ok {
                            super::tide_providers::TideOpsEvent::Connection(Ok(()))
                        } else {
                            super::tide_providers::TideOpsEvent::Connection(Err(
                                error.unwrap_or_else(|| "the connection test failed".into())
                            ))
                        }
                    }
                    Ok(_) => super::tide_providers::TideOpsEvent::Providers(Err(
                        "the backend returned an unexpected response".into(),
                    )),
                    Err(error) => {
                        super::tide_providers::TideOpsEvent::Providers(Err(error.to_string()))
                    }
                };
                if ops_tx.send(event).is_ok() {
                    signal_event_pump(&event_wake);
                }
            });
    }

    pub(super) fn tide_load_providers(&mut self) {
        self.tide_dispatch(client::Command::TideProviders);
    }

    pub(super) fn tide_open_add_wizard(
        &mut self,
        preset: Option<&'static super::tide_providers::TidePreset>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.tide.wizard = Some(super::tide_providers::TideWizard::new(preset, window, cx));
        self.tide.error = None;
        cx.notify();
    }

    /// The wizard's dashed custom tiles: no preset, but a fixed protocol.
    pub(super) fn tide_open_custom_wizard(
        &mut self,
        api_style: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut wizard = super::tide_providers::TideWizard::new(None, window, cx);
        wizard.api_style = api_style.to_owned();
        self.tide.wizard = Some(wizard);
        self.tide.error = None;
        cx.notify();
    }

    /// Edit reuses the wizard with everything prefilled; a blank key keeps
    /// the stored one (the backend only rewrites when a key is sent).
    pub(super) fn tide_open_edit_wizard(
        &mut self,
        provider_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(provider) = self
            .tide
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .cloned()
        else {
            return;
        };
        let preset = super::tide_providers::TIDE_PRESETS
            .iter()
            .find(|preset| preset.base_url == provider.base_url);
        let mut wizard = super::tide_providers::TideWizard::new(preset, window, cx);
        wizard.step = super::tide_providers::TideWizardStep::Connect;
        wizard.edit_provider_id = Some(provider_id);
        wizard.api_style = provider.api_style.clone();
        wizard
            .name
            .update(cx, |input, cx| input.set_content(provider.name.clone(), cx));
        wizard.base_url.update(cx, |input, cx| {
            input.set_content(provider.base_url.clone(), cx)
        });
        wizard.models = provider
            .models
            .iter()
            .map(|model| (model.clone(), true))
            .collect();
        self.tide.wizard = Some(wizard);
        self.tide.error = None;
        cx.notify();
    }

    pub(super) fn tide_close_wizard(&mut self, cx: &mut Context<Self>) {
        self.tide.wizard = None;
        cx.notify();
    }

    /// Choose-step tile click: prefill from the preset and move to Connect.
    pub(super) fn tide_choose_preset(
        &mut self,
        preset: &'static super::tide_providers::TidePreset,
        cx: &mut Context<Self>,
    ) {
        let Some(wizard) = self.tide.wizard.as_mut() else {
            return;
        };
        wizard.preset = Some(preset);
        wizard.api_style = preset.api_style.to_owned();
        wizard.step = super::tide_providers::TideWizardStep::Connect;
        wizard.error = None;
        // tide's `uniqueName`: "Name", then "Name 2", "Name 3", …
        let taken: Vec<String> = self
            .tide
            .providers
            .iter()
            .map(|provider| provider.name.to_lowercase())
            .collect();
        let base = preset.name.to_owned();
        let mut name = base.clone();
        let mut suffix = 2;
        while taken.contains(&name.to_lowercase()) {
            name = format!("{base} {suffix}");
            suffix += 1;
        }
        wizard
            .name
            .update(cx, |input, cx| input.set_content(name, cx));
        wizard.base_url.update(cx, |input, cx| {
            input.set_content(preset.base_url.to_owned(), cx)
        });
        cx.notify();
    }

    /// Connect-step Continue: the detect race is the gate, exactly like
    /// tide's wizard — a failing probe keeps the step.
    pub(super) fn tide_wizard_continue_connect(&mut self, cx: &mut Context<Self>) {
        let Some(wizard) = self.tide.wizard.as_ref() else {
            return;
        };
        let base_url = wizard.base_url.read(cx).content().trim().to_owned();
        let api_key = wizard.api_key.read(cx).content().trim().to_owned();
        let editing = wizard.edit_provider_id.is_some();
        if base_url.is_empty() {
            self.tide_wizard_error(cx, tr!("tide.error_base_url"));
            return;
        }
        if api_key.is_empty() && wizard.preset.is_some_and(|preset| preset.requires_key) && !editing
        {
            self.tide_wizard_error(cx, tr!("tide.error_api_key"));
            return;
        }
        if let Some(wizard) = self.tide.wizard.as_mut() {
            wizard.testing = true;
            wizard.error = None;
        }
        self.tide_dispatch(client::Command::TideDetectProtocol { base_url, api_key });
        cx.notify();
    }

    /// The custom path's Auto-Detect Protocol button: same probe, no step
    /// change — the detected protocol lands in the chips.
    pub(super) fn tide_auto_detect(&mut self, cx: &mut Context<Self>) {
        let Some(wizard) = self.tide.wizard.as_ref() else {
            return;
        };
        let base_url = wizard.base_url.read(cx).content().trim().to_owned();
        let api_key = wizard.api_key.read(cx).content().trim().to_owned();
        if base_url.is_empty() || api_key.is_empty() {
            self.tide_wizard_error(cx, tr!("tide.error_detect_fields"));
            return;
        }
        if let Some(wizard) = self.tide.wizard.as_mut() {
            wizard.testing = true;
            wizard.error = None;
        }
        self.tide_dispatch(client::Command::TideDetectProtocol { base_url, api_key });
        cx.notify();
    }

    pub(super) fn tide_set_style(&mut self, style: &'static str, cx: &mut Context<Self>) {
        let Some(wizard) = self.tide.wizard.as_mut() else {
            return;
        };
        wizard.api_style = style.to_owned();
        if let Some(base) = wizard.preset_base() {
            wizard
                .base_url
                .update(cx, |input, cx| input.set_content(base, cx));
        }
        cx.notify();
    }

    pub(super) fn tide_wizard_step(
        &mut self,
        step: super::tide_providers::TideWizardStep,
        cx: &mut Context<Self>,
    ) {
        let Some(wizard) = self.tide.wizard.as_mut() else {
            return;
        };
        if step == super::tide_providers::TideWizardStep::Models
            && wizard.models.is_empty()
            && !wizard.fetching
        {
            wizard.fetching = true;
            wizard.error = None;
            let (api_style, base_url, api_key) = (
                wizard.api_style.clone(),
                wizard.base_url.read(cx).content().trim().to_owned(),
                wizard.api_key.read(cx).content().trim().to_owned(),
            );
            wizard.step = step;
            self.tide_dispatch(client::Command::TideProbeModels {
                api_style,
                base_url,
                api_key,
            });
        } else {
            wizard.step = step;
        }
        cx.notify();
    }

    /// Re-run the models fetch with the wizard's current credentials.
    pub(super) fn tide_refresh_models(&mut self, cx: &mut Context<Self>) {
        let Some(wizard) = self.tide.wizard.as_ref() else {
            return;
        };
        let (api_style, base_url, api_key) = (
            wizard.api_style.clone(),
            wizard.base_url.read(cx).content().trim().to_owned(),
            wizard.api_key.read(cx).content().trim().to_owned(),
        );
        if let Some(wizard) = self.tide.wizard.as_mut() {
            wizard.fetching = true;
            wizard.error = None;
        }
        self.tide_dispatch(client::Command::TideProbeModels {
            api_style,
            base_url,
            api_key,
        });
        cx.notify();
    }

    /// Check or clear every selectable row; routing-excluded models stay
    /// untouched so their dimmed state never turns into a selection.
    pub(super) fn tide_set_all_models(&mut self, checked: bool, cx: &mut Context<Self>) {
        let Some(wizard) = self.tide.wizard.as_mut() else {
            return;
        };
        let routing = wizard.routing_filter().map(|needles| {
            needles
                .iter()
                .map(|needle| needle.to_string())
                .collect::<Vec<String>>()
        });
        for (model, state) in wizard.models.iter_mut() {
            let excluded = routing.as_deref().is_some_and(|needles| {
                let lowered = model.model_id.to_ascii_lowercase();
                !needles.iter().any(|needle| lowered.contains(needle))
            });
            if !excluded {
                *state = checked;
            }
        }
        cx.notify();
    }

    pub(super) fn tide_toggle_model(&mut self, model_id: &str, cx: &mut Context<Self>) {
        let Some(wizard) = self.tide.wizard.as_mut() else {
            return;
        };
        for (model, checked) in wizard.models.iter_mut() {
            if model.model_id == model_id {
                *checked = !*checked;
                break;
            }
        }
        cx.notify();
    }

    /// Review's Add Provider (or Save when editing); the fresh provider list
    /// comes back through the pump and closes the wizard on success.
    pub(super) fn tide_save_wizard(&mut self, cx: &mut Context<Self>) {
        let Some(wizard) = self.tide.wizard.as_ref() else {
            return;
        };
        let name = wizard.name.read(cx).content().trim().to_owned();
        let base_url = wizard.base_url.read(cx).content().trim().to_owned();
        let api_key = wizard.api_key.read(cx).content().trim().to_owned();
        let api_style = wizard.api_style.clone();
        let selected: Vec<client::tide::TideModelWire> = wizard
            .models
            .iter()
            .filter(|(_, checked)| *checked)
            .map(|(model, _)| model.clone())
            .collect();
        let editing = wizard.edit_provider_id.clone();
        let requires_key = wizard.preset.is_some_and(|preset| preset.requires_key);
        if name.is_empty() {
            self.tide_wizard_error(cx, tr!("tide.error_name"));
            return;
        }
        if base_url.is_empty() {
            self.tide_wizard_error(cx, tr!("tide.error_base_url"));
            return;
        }
        if api_key.is_empty() && requires_key && editing.is_none() {
            self.tide_wizard_error(cx, tr!("tide.error_api_key"));
            return;
        }
        if selected.is_empty() {
            self.tide_wizard_error(cx, tr!("tide.error_models"));
            return;
        }
        if let Some(wizard) = self.tide.wizard.as_mut() {
            wizard.saving = true;
            wizard.error = None;
        }
        match editing {
            Some(provider_id) => {
                self.tide_dispatch(client::Command::TideUpdateProvider {
                    provider_id,
                    name: Some(name),
                    api_style: Some(api_style),
                    base_url: Some(base_url),
                    enabled: None,
                    api_key: if api_key.is_empty() {
                        None
                    } else {
                        Some(api_key)
                    },
                    models: Some(selected),
                });
            }
            None => {
                self.tide_dispatch(client::Command::TideAddProvider {
                    name,
                    api_style,
                    base_url,
                    api_key: if api_key.is_empty() {
                        None
                    } else {
                        Some(api_key)
                    },
                    models: selected,
                });
            }
        }
        cx.notify();
    }

    pub(super) fn tide_delete_provider(&mut self, provider_id: String) {
        self.tide_dispatch(client::Command::TideDeleteProvider { provider_id });
    }

    pub(super) fn tide_toggle_enabled(&mut self, provider_id: String, enabled: bool) {
        self.tide_dispatch(client::Command::TideUpdateProvider {
            provider_id,
            name: None,
            api_style: None,
            base_url: None,
            enabled: Some(enabled),
            api_key: None,
            models: None,
        });
    }

    fn tide_wizard_error(&mut self, cx: &mut Context<Self>, message: String) {
        if let Some(wizard) = self.tide.wizard.as_mut() {
            wizard.error = Some(message);
        }
        cx.notify();
    }

    pub(super) fn drain_tide_ops_events(&mut self, cx: &mut Context<Self>) -> bool {
        let mut changed = false;
        while let Ok(event) = self.tide.ops_rx.try_recv() {
            changed = true;
            match event {
                super::tide_providers::TideOpsEvent::Providers(result) => match result {
                    Ok(providers) => {
                        self.tide.providers = providers;
                        self.tide.error = None;
                        self.tide.loaded = true;
                        // The picker's rows and the model metadata lookups
                        // read this flattened catalog, so it must never lag
                        // the provider list it came from.
                        self.tide_models = Self::tide_models_from_providers(&self.tide.providers);
                        let closing = self
                            .tide
                            .wizard
                            .as_ref()
                            .is_some_and(|wizard| wizard.saving);
                        if closing {
                            self.tide.wizard = None;
                        }
                        self.refresh_composer_sources(cx);
                    }
                    Err(error) => {
                        let saving = self
                            .tide
                            .wizard
                            .as_ref()
                            .is_some_and(|wizard| wizard.saving);
                        if saving {
                            let wizard = self.tide.wizard.as_mut().unwrap();
                            wizard.saving = false;
                            wizard.error = Some(error);
                        } else {
                            self.tide.error = Some(error);
                        }
                    }
                },
                super::tide_providers::TideOpsEvent::Models(result) => {
                    if let Some(wizard) = self.tide.wizard.as_mut() {
                        wizard.fetching = false;
                        match result {
                            Ok(models) => {
                                let routing = wizard.routing_filter();
                                let recommended = wizard
                                    .preset
                                    .map(|preset| preset.recommended)
                                    .unwrap_or(&[]);
                                wizard.models = models
                                    .into_iter()
                                    .map(|model| {
                                        let lowered = model.model_id.to_ascii_lowercase();
                                        let routed_out = routing.is_some_and(|needles| {
                                            !needles.iter().any(|needle| lowered.contains(needle))
                                        });
                                        let checked = !routed_out
                                            && (!recommended.is_empty()
                                                && recommended
                                                    .iter()
                                                    .any(|needle| lowered.contains(needle))
                                                || wizard.edit_provider_id.is_some());
                                        (model, checked)
                                    })
                                    .collect();
                                wizard.error = None;
                            }
                            Err(error) => wizard.error = Some(error),
                        }
                    }
                }
                super::tide_providers::TideOpsEvent::Protocol(result) => {
                    if let Some(wizard) = self.tide.wizard.as_mut() {
                        wizard.testing = false;
                        match result {
                            Ok(style) => {
                                if wizard.preset.is_none() {
                                    wizard.api_style = style;
                                }
                                wizard.tested = true;
                                wizard.error = None;
                                wizard.step = super::tide_providers::TideWizardStep::Models;
                                // Entering Models auto-fetches the list.
                                wizard.fetching = true;
                                let (api_style, base_url, api_key) = (
                                    wizard.api_style.clone(),
                                    wizard.base_url.read(cx).content().trim().to_owned(),
                                    wizard.api_key.read(cx).content().trim().to_owned(),
                                );
                                self.tide_dispatch(client::Command::TideProbeModels {
                                    api_style,
                                    base_url,
                                    api_key,
                                });
                            }
                            Err(error) => wizard.error = Some(error),
                        }
                    }
                }
                super::tide_providers::TideOpsEvent::Connection(result) => {
                    if let Some(wizard) = self.tide.wizard.as_mut() {
                        wizard.testing = false;
                        if let Err(error) = result {
                            wizard.error = Some(error);
                        }
                    }
                }
            }
        }
        changed
    }

    // ── Git settings ──────────────────────────────────────────────────
    //
    // The whole Git settings screen rides one snapshot payload: every
    // mutation returns a fresh snapshot, the device flow replies through its
    // own events, and the shared pump drains the results here.

    /// Fire a git command at the backend; the reply lands in
    /// [`Self::drain_git_ops_events`] via the shared event pump.
    pub(super) fn git_dispatch(&self, command: client::Command) {
        let ops_tx = self.git_settings.ops_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let daemon = self.daemon.client();
        // The gh-CLI connect reuses the device-poll wire payload; route its
        // reply to the dedicated event so it cannot disturb an open device
        // flow.
        let gh_connect = matches!(command, client::Command::GithubConnectFromGhCli { .. });
        let _ = std::thread::Builder::new()
            .name("tide-git-settings".into())
            .spawn(move || {
                let event = match daemon.request(Uuid::nil(), Uuid::nil(), command) {
                    Ok(client::ResponsePayload::GitSnapshot { snapshot }) => {
                        super::git_settings::GitOpsEvent::Snapshot(Ok(snapshot))
                    }
                    Ok(client::ResponsePayload::GithubDeviceStart { start }) => {
                        super::git_settings::GitOpsEvent::DeviceStart(Ok(start))
                    }
                    Ok(client::ResponsePayload::GithubConnectPoll { poll }) => {
                        if gh_connect {
                            super::git_settings::GitOpsEvent::GhConnect(Ok(poll))
                        } else {
                            super::git_settings::GitOpsEvent::DevicePoll(Ok(poll))
                        }
                    }
                    Ok(client::ResponsePayload::GitCredentials { items }) => {
                        super::git_settings::GitOpsEvent::Credentials(Ok(items))
                    }
                    Ok(client::ResponsePayload::GitOp { result }) => {
                        if !result.ok {
                            super::git_settings::GitOpsEvent::OpFailed(
                                result
                                    .error
                                    .unwrap_or_else(|| "the git operation failed".into()),
                            )
                        } else {
                            // A successful op answers with its own snapshot
                            // payload instead of a bare GitOp; reaching this
                            // arm means the backend replied out of contract.
                            super::git_settings::GitOpsEvent::Snapshot(Err(
                                "the backend returned an unexpected response".into(),
                            ))
                        }
                    }
                    Ok(_) => super::git_settings::GitOpsEvent::Snapshot(Err(
                        "the backend returned an unexpected response".into(),
                    )),
                    Err(error) => {
                        super::git_settings::GitOpsEvent::Snapshot(Err(error.to_string()))
                    }
                };
                if ops_tx.send(event).is_ok() {
                    signal_event_pump(&event_wake);
                }
            });
    }

    pub(super) fn git_load_snapshot(&mut self) {
        self.git_dispatch(client::Command::GitSnapshot);
    }

    /// The attribution rows' one save path: either key may move, the other
    /// stays put, and the fresh snapshot that lands in the drain clears the
    /// save indicator.
    pub(super) fn git_set_attribution(
        &mut self,
        co_authored: Option<bool>,
        mode: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if co_authored.is_some() {
            self.git_settings.saving_attribution = true;
        }
        self.git_dispatch(client::Command::GitUpdateAttribution {
            git_co_authored: co_authored,
            git_attribution_mode: mode,
        });
        cx.notify();
    }

    /// Set (or clear, with both ids `None`) a background-task model override
    /// ("title" | "commit-message"). The command answers with a bare Ack, so
    /// the thread reloads the snapshot itself and the fresh state lands in
    /// the drain like every other git write.
    pub(super) fn git_set_background_model(
        &mut self,
        task: &str,
        provider_id: Option<String>,
        model_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let task = task.to_owned();
        let ops_tx = self.git_settings.ops_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let daemon = self.daemon.client();
        let _ = std::thread::Builder::new()
            .name("tide-git-settings".into())
            .spawn(move || {
                let event = match daemon.request(
                    Uuid::nil(),
                    Uuid::nil(),
                    client::Command::UpdateBackgroundModel {
                        task: task.clone(),
                        provider_id,
                        model_id,
                    },
                ) {
                    Ok(client::ResponsePayload::Ack) => {
                        match daemon.request(Uuid::nil(), Uuid::nil(), client::Command::GitSnapshot)
                        {
                            Ok(client::ResponsePayload::GitSnapshot { snapshot }) => {
                                super::git_settings::GitOpsEvent::Snapshot(Ok(snapshot))
                            }
                            _ => super::git_settings::GitOpsEvent::Snapshot(Err(
                                "failed to reload git settings after the update".into(),
                            )),
                        }
                    }
                    Ok(_) => super::git_settings::GitOpsEvent::Snapshot(Err(
                        "the backend returned an unexpected response".into(),
                    )),
                    Err(error) => {
                        super::git_settings::GitOpsEvent::Snapshot(Err(error.to_string()))
                    }
                };
                if ops_tx.send(event).is_ok() {
                    signal_event_pump(&event_wake);
                }
            });
        cx.notify();
    }

    /// Open the profile dialog on a blank draft. The dialog materializes on
    /// the next frame — its `TextInput` entities need a window.
    pub(super) fn git_new_profile(&mut self, cx: &mut Context<Self>) {
        self.git_settings.profile_request = Some(super::git_settings::GitProfileRequest {
            editing: None,
            prefill: None,
        });
        cx.notify();
    }

    /// Open the profile dialog on a draft copied field-for-field from the
    /// snapshot; the token never round-trips, so the draft starts empty.
    pub(super) fn git_edit_profile(&mut self, profile_id: &str, cx: &mut Context<Self>) {
        let Some(profile) = self.git_settings.snapshot.as_ref().and_then(|snapshot| {
            snapshot
                .profiles
                .iter()
                .find(|profile| profile.id == profile_id)
                .cloned()
        }) else {
            return;
        };
        self.git_settings.profile_request = Some(super::git_settings::GitProfileRequest {
            editing: Some(profile),
            prefill: None,
        });
        cx.notify();
    }

    /// Delete after the armed confirm; the fresh snapshot closes the loop.
    pub(super) fn git_delete_profile(&mut self, profile_id: String) {
        self.git_settings.confirm_delete = None;
        self.git_dispatch(client::Command::GitIdentityDelete { profile_id });
    }

    /// Open the import popover and refetch the discovered-credentials list;
    /// `None` list + open popover renders the fetching state.
    pub(super) fn git_import_open(&mut self, cx: &mut Context<Self>) {
        self.git_settings.import_open = true;
        self.git_settings.import_list = None;
        self.git_dispatch(client::Command::GitDiscoverCredentials);
        cx.notify();
    }

    /// Apply a profile to one project as repo-local git config. `"global"`
    /// clears the override; the fresh snapshot that lands in the drain
    /// closes the loop.
    pub(super) fn git_set_project_identity(&mut self, project_path: String, profile_id: String) {
        self.git_dispatch(client::Command::GitSetIdentity {
            project_path: project_path.into(),
            profile_id,
        });
    }

    /// Clear a project's repo-local identity override.
    pub(super) fn git_clear_project_identity(&mut self, project_path: String) {
        self.git_dispatch(client::Command::GitClearIdentity {
            project_path: project_path.into(),
        });
    }

    /// Disconnect after the armed confirm; the fresh snapshot closes the loop.
    pub(super) fn git_disconnect_account(&mut self, login: String) {
        self.git_settings.confirm_disconnect = None;
        self.git_dispatch(client::Command::GithubDisconnect { login });
    }

    /// One-click gh-CLI connect; the GhConnect reply clears the spinner and
    /// refreshes.
    pub(super) fn git_connect_gh(&mut self, login: String, cx: &mut Context<Self>) {
        self.git_settings.gh_connecting = Some(login.clone());
        self.git_dispatch(client::Command::GithubConnectFromGhCli { login });
        cx.notify();
    }

    pub(super) fn drain_git_ops_events(&mut self, cx: &mut Context<Self>) -> bool {
        let mut changed = false;
        while let Ok(event) = self.git_settings.ops_rx.try_recv() {
            changed = true;
            match event {
                super::git_settings::GitOpsEvent::Snapshot(result) => match result {
                    Ok(snapshot) => {
                        // Grow the Workspaces picker handles to match the
                        // fresh status rows; shrink is not needed — trailing
                        // handles just go unused.
                        while self.git_settings.project_menus.len() < snapshot.statuses.len() {
                            self.git_settings
                                .project_menus
                                .push(crate::ui::menu::ContextMenuHandle::new(cx));
                        }
                        self.git_settings.snapshot = Some(snapshot);
                        self.git_settings.loaded = true;
                        self.git_settings.saving_attribution = false;
                        self.git_settings.error = None;
                        // An identity applied from the Git panel's picker
                        // lands here — refresh the panel's queries (the
                        // current identity among them) when it is on screen.
                        if self.git_panel_visible() {
                            self.refresh_git_panel(cx);
                        }
                    }
                    Err(error) => {
                        self.git_settings.loaded = true;
                        self.git_settings.error = Some(error);
                    }
                },
                super::git_settings::GitOpsEvent::DeviceStart(result) => match result {
                    Ok(start) => {
                        if matches!(
                            self.git_settings.device_flow,
                            Some(super::git_settings::DeviceFlowPhase::Starting)
                        ) {
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|since| since.as_secs_f64())
                                .unwrap_or(0.0);
                            let (device_code, interval) =
                                (start.device_code.clone(), start.interval);
                            self.git_settings.device_flow =
                                Some(super::git_settings::DeviceFlowPhase::Waiting {
                                    device_code,
                                    user_code: start.user_code,
                                    verification_uri: start.verification_uri,
                                    expires_at: now + start.expires_in as f64,
                                    interval,
                                });
                            // First link of the poll chain; each pending
                            // reply below re-schedules itself.
                            let generation = self.git_settings.device_flow_generation;
                            self.git_schedule_device_poll(
                                start.device_code,
                                interval,
                                generation,
                                cx,
                            );
                        }
                    }
                    Err(error) => {
                        self.git_settings.device_flow =
                            Some(super::git_settings::DeviceFlowPhase::Error(error));
                    }
                },
                super::git_settings::GitOpsEvent::DevicePoll(result) => match result {
                    Ok(poll) => {
                        // Any device-flow reply also settles a stray gh-cli
                        // spinner (its replies ride the dedicated GhConnect
                        // event, this is belt-and-braces).
                        self.git_settings.gh_connecting = None;
                        match poll.status.as_str() {
                            "pending" => {
                                if let Some(super::git_settings::DeviceFlowPhase::Waiting {
                                    device_code,
                                    interval,
                                    ..
                                }) = &self.git_settings.device_flow
                                {
                                    let (device_code, interval) = (device_code.clone(), *interval);
                                    let generation = self.git_settings.device_flow_generation;
                                    self.git_schedule_device_poll(
                                        device_code,
                                        interval,
                                        generation,
                                        cx,
                                    );
                                }
                            }
                            "success" => {
                                self.git_settings.device_flow = None;
                                self.git_load_snapshot();
                            }
                            "denied" => {
                                self.git_settings.device_flow =
                                    Some(super::git_settings::DeviceFlowPhase::Denied);
                            }
                            "expired" => {
                                self.git_settings.device_flow =
                                    Some(super::git_settings::DeviceFlowPhase::Expired);
                            }
                            _ => {
                                self.git_settings.device_flow =
                                    Some(super::git_settings::DeviceFlowPhase::Error(
                                        poll.error.unwrap_or_else(|| {
                                            "the GitHub connection failed".into()
                                        }),
                                    ));
                            }
                        }
                    }
                    Err(error) => {
                        self.git_settings.device_flow =
                            Some(super::git_settings::DeviceFlowPhase::Error(error));
                    }
                },
                super::git_settings::GitOpsEvent::GhConnect(result) => match result {
                    Ok(poll) => {
                        self.git_settings.gh_connecting = None;
                        if poll.status == "success" {
                            self.git_load_snapshot();
                        } else {
                            self.git_settings.error = Some(
                                poll.error
                                    .unwrap_or_else(|| "the gh CLI connect failed".into()),
                            );
                        }
                    }
                    Err(error) => {
                        self.git_settings.gh_connecting = None;
                        self.git_settings.error = Some(error);
                    }
                },
                super::git_settings::GitOpsEvent::Credentials(result) => match result {
                    Ok(items) => {
                        // Upstream drops pairs without a username.
                        self.git_settings.import_list = Some(
                            items
                                .into_iter()
                                .filter(|item| !item.username.is_empty())
                                .collect(),
                        );
                    }
                    Err(error) => self.git_settings.error = Some(error),
                },
                super::git_settings::GitOpsEvent::OpFailed(error) => {
                    self.git_settings.error = Some(error);
                }
            }
        }
        if changed {
            cx.notify();
        }
        changed
    }
}
