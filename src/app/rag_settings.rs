//! The Memory & RAG settings panel — the per-project enable/status/build
//! card and the knowledge-sources card on the Knowledge settings page.
//! State flows exactly like the git-settings panel: actions dispatch on a
//! spawned thread, replies land in [`RagOpsEvent`] through the shared
//! event pump, and transient states (model download, ingestion, indexing)
//! keep a 2 s self-sustaining poll alive.

use super::*;
use crate::ui::card::{
    CardButton, CardRow, card_body, card_body_flush, card_pill, card_rows, settings_group_head,
};

pub(crate) enum RagOpsEvent {
    Status(Result<client::RagStatusWire, String>),
    /// Ack replies carry no state — the refresh dispatched alongside them
    /// brings the real data.
    Noop,
    Sources(Result<Vec<client::KnowledgeSourceWire>, String>),
    /// The global config bundle (settings + endpoints + cloud state).
    Config(Result<RagConfigBundle, String>),
    Models(Result<Vec<client::RagModelWire>, String>),
    /// Indexes left behind by a settings change / delete — opens the
    /// rebuild dialog when non-empty.
    Affected(Vec<client::RagAffectedWorkspaceWire>),
    /// A custom endpoint was added (or the add failed — errors stay
    /// inline in the dialog).
    Endpoint(Result<client::RagEndpointWire, String>),
    /// One serial rebuild step finished — pop the next from the queue.
    RebuildStep,
}

/// The RagConfigGet payload.
pub(crate) struct RagConfigBundle {
    pub config: client::RagConfigWire,
    pub endpoints: Vec<client::RagEndpointWire>,
    pub cloud_configured: bool,
}

/// Panel state for the Memory & RAG cards.
pub(crate) struct RagSettingsPanel {
    pub ops_tx: Sender<RagOpsEvent>,
    pub ops_rx: Receiver<RagOpsEvent>,
    /// The project the loaded status describes.
    pub status: Option<client::RagStatusWire>,
    pub status_error: Option<String>,
    pub sources: Vec<client::KnowledgeSourceWire>,
    pub sources_error: Option<String>,
    /// The add-source dialog's draft, when open (upstream's SourceDialog:
    /// name + kind + location, validated client-side like the TS did).
    pub dialog: Option<SourceDialogDraft>,
    /// The in-flight list mutation ("add" or a source id) — buttons show
    /// their pending state until the Sources reply clears it.
    pub pending_source: Option<String>,
    /// Which scope the sources card lists and the add dialog targets.
    pub scope: KnowledgeScope,
    /// The global Memory & RAG settings (model picker / retrieval /
    /// advanced cards). `None` until first load.
    pub config: Option<client::RagConfigWire>,
    pub endpoints: Vec<client::RagEndpointWire>,
    pub cloud_configured: bool,
    pub config_error: Option<String>,
    /// Guards against refetching the bundle on every render until the
    /// first reply lands (render paths take &self).
    pub config_requested: std::cell::Cell<bool>,
    /// The local model catalog + on-disk state.
    pub models: Vec<client::RagModelWire>,
    /// The embedding-model picker's dropdown.
    pub picker: ContextMenuHandle,
    /// The add-endpoint dialog, when open.
    pub endpoint_dialog: Option<EndpointDialogDraft>,
    /// The single-field edit dialog (cloud model id / min similarity).
    pub value_dialog: Option<ValueDialogDraft>,
    /// The rebuild-offer dialog after a settings change or delete.
    pub rebuild: Option<RebuildState>,
}

/// The rebuild dialog: what a change left behind, and the serial queue
/// once "Rebuild all now" starts. `project_id == "*"` (the knowledge
/// index) fans out to a per-source reindex instead of RagInitWorkspace.
pub(crate) struct RebuildState {
    pub affected: Vec<client::RagAffectedWorkspaceWire>,
    /// Remaining project ids to re-init, front first.
    pub queue: Vec<String>,
    pub running: bool,
}

/// The add-endpoint dialog's editable state (text entities are created
/// when the dialog opens — they need a window).
pub(crate) struct EndpointDialogDraft {
    pub name: Entity<crate::input::TextInput>,
    pub base_url: Entity<crate::input::TextInput>,
    pub model_id: Entity<crate::input::TextInput>,
    pub api_key: Entity<crate::input::TextInput>,
    pub error: Option<String>,
    pub busy: bool,
}

/// What the single-field edit dialog is editing.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ValueDialogKind {
    CloudModelId,
    MinSimilarity,
    ChunkSize,
    ChunkOverlap,
}

pub(crate) struct ValueDialogDraft {
    pub kind: ValueDialogKind,
    pub value: Entity<crate::input::TextInput>,
    pub error: Option<String>,
}

/// The Knowledge page's scope: global knowledge, or one project's.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum KnowledgeScope {
    Global,
    Project(Uuid),
}

/// The add dialog's editable state. Text entities are created when the
/// dialog opens (they need a window, only click handlers have one).
pub(crate) struct SourceDialogDraft {
    pub name: Entity<crate::input::TextInput>,
    pub kind: &'static str,
    pub location: Entity<crate::input::TextInput>,
    pub error: Option<String>,
    pub busy: bool,
}

impl RagSettingsPanel {
    pub(crate) fn new(cx: &mut App) -> Self {
        let (ops_tx, ops_rx) = unbounded();
        Self {
            ops_tx,
            ops_rx,
            status: None,
            status_error: None,
            sources: Vec::new(),
            sources_error: None,
            dialog: None,
            pending_source: None,
            scope: KnowledgeScope::Global,
            config: None,
            endpoints: Vec::new(),
            cloud_configured: false,
            config_error: None,
            config_requested: std::cell::Cell::new(false),
            models: Vec::new(),
            picker: ContextMenuHandle::new(cx),
            endpoint_dialog: None,
            value_dialog: None,
            rebuild: None,
        }
    }

    /// Whether `source` belongs to the current scope. Global sources carry
    /// the `*` workspace; project sources carry the project's id.
    pub(crate) fn source_in_scope(
        &self,
        source: &client::KnowledgeSourceWire,
        scope: KnowledgeScope,
    ) -> bool {
        match scope {
            KnowledgeScope::Global => source.enabled_workspace_ids.iter().any(|id| id == "*"),
            KnowledgeScope::Project(project_id) => source
                .enabled_workspace_ids
                .iter()
                .any(|id| id == &project_id.to_string()),
        }
    }

    /// Open the add dialog (upstream's SourceDialog, fresh every time).
    fn open_source_dialog(&mut self, window: &mut Window, cx: &mut Context<Tide>) {
        let name = cx.new(|cx| {
            crate::input::TextInput::new(window, cx)
                .clear_on_escape()
                .placeholder(tr!("settings.rag.dialog_name_placeholder"))
        });
        let location =
            cx.new(|cx| crate::input::TextInput::new(window, cx).placeholder(SOURCE_KINDS[0].2));
        self.dialog = Some(SourceDialogDraft {
            name,
            kind: "url",
            location,
            error: None,
            busy: false,
        });
        cx.notify();
    }

    fn close_source_dialog(&mut self, cx: &mut Context<Tide>) {
        self.dialog = None;
        cx.notify();
    }

    /// Open the add-endpoint sheet (fresh every time).
    fn open_endpoint_dialog(&mut self, window: &mut Window, cx: &mut Context<Tide>) {
        let name = cx.new(|cx| {
            crate::input::TextInput::new(window, cx)
                .clear_on_escape()
                .placeholder(tr!("settings.rag.endpoint_name_placeholder"))
        });
        let base_url = cx.new(|cx| {
            crate::input::TextInput::new(window, cx)
                .clear_on_escape()
                .placeholder("https://api.openai.com/v1")
        });
        let model_id = cx.new(|cx| {
            crate::input::TextInput::new(window, cx)
                .clear_on_escape()
                .placeholder("text-embedding-3-small")
        });
        let api_key = cx.new(|cx| {
            crate::input::TextInput::new(window, cx)
                .clear_on_escape()
                .placeholder(tr!("settings.rag.endpoint_key_placeholder"))
        });
        self.endpoint_dialog = Some(EndpointDialogDraft {
            name,
            base_url,
            model_id,
            api_key,
            error: None,
            busy: false,
        });
        cx.notify();
    }

    /// Open the single-field edit dialog (cloud model id / min similarity)
    /// seeded with the current value.
    fn open_value_dialog(&mut self, kind: ValueDialogKind, window: &mut Window, cx: &mut Context<Tide>) {
        let current = match (kind, self.config.as_ref()) {
            (ValueDialogKind::CloudModelId, Some(config)) => {
                config.cloud_model_id.clone().unwrap_or_default()
            }
            (ValueDialogKind::MinSimilarity, Some(config)) => config
                .min_similarity
                .map(|v| format!("{v}"))
                .unwrap_or_default(),
            (ValueDialogKind::ChunkSize, Some(config)) => config
                .chunk_size
                .map(|v| format!("{v}"))
                .unwrap_or_default(),
            (ValueDialogKind::ChunkOverlap, Some(config)) => config
                .chunk_overlap
                .map(|v| format!("{v}"))
                .unwrap_or_default(),
            _ => String::new(),
        };
        let placeholder = match kind {
            ValueDialogKind::CloudModelId => "text-embedding-3-small".to_string(),
            ValueDialogKind::MinSimilarity => "0.2".to_string(),
            ValueDialogKind::ChunkSize => "1024".to_string(),
            ValueDialogKind::ChunkOverlap => "128".to_string(),
        };
        let value = cx.new(|cx| {
            let mut input = crate::input::TextInput::new(window, cx)
                .clear_on_escape()
                .placeholder(placeholder);
            let len = input.content().len();
            input.replace_range(0..len, &current, cx);
            input
        });
        self.value_dialog = Some(ValueDialogDraft {
            kind,
            value,
            error: None,
        });
        cx.notify();
    }
}

// ── dispatch + actions ─────────────────────────────────────────────────────

impl Tide {
    /// Browse for a local docs file or folder and drop the chosen path into
    /// the add dialog's location field.
    pub(super) fn rag_browse_local_source(&mut self, cx: &mut Context<Self>) {
        if self.daemon.is_remote() {
            self.show_toast(tr!("errors.remote_project_picker"));
            return;
        }
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: false,
            prompt: Some(tr!("settings.rag.dialog_browse").into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await
                && let Some(path) = paths.into_iter().next()
            {
                let _ = this.update(cx, |this, cx| {
                    if let Some(dialog) = this.rag_settings.dialog.as_mut() {
                        dialog.location.update(cx, |input, cx| {
                            let len = input.content().len();
                            input.replace_range(0..len, &path.to_string_lossy(), cx);
                        });
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    /// Generic RAG command dispatch: request on a thread, reply through the
    /// ops channel, wake the pump.
    pub(super) fn rag_dispatch(
        &self,
        event: impl FnOnce(client::ResponsePayload) -> RagOpsEvent + Send + 'static,
        command: client::Command,
    ) {
        let ops_tx = self.rag_settings.ops_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let daemon = self.daemon.client();
        let _ = std::thread::Builder::new()
            .name("tide-rag-settings".into())
            .spawn(move || {
                let payload = daemon.request(Uuid::nil(), Uuid::nil(), command);
                let outcome = match payload {
                    Ok(payload) => event(payload),
                    Err(error) => RagOpsEvent::Status(Err(error.to_string())),
                };
                let _ = &outcome;
                if ops_tx.send(outcome).is_ok() {
                    signal_event_pump(&event_wake);
                }
            });
    }

    /// Result-taking dispatch for the global-config ops (transport errors
    /// route through the event's own Err, not the project status card).
    pub(super) fn rag_dispatch_result(
        &self,
        event: impl FnOnce(Result<client::ResponsePayload, String>) -> RagOpsEvent + Send + 'static,
        command: client::Command,
    ) {
        let ops_tx = self.rag_settings.ops_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let daemon = self.daemon.client();
        let _ = std::thread::Builder::new()
            .name("tide-rag-settings".into())
            .spawn(move || {
                let outcome = match daemon.request(Uuid::nil(), Uuid::nil(), command) {
                    Ok(payload) => event(Ok(payload)),
                    Err(error) => event(Err(error.to_string())),
                };
                if ops_tx.send(outcome).is_ok() {
                    signal_event_pump(&event_wake);
                }
            });
    }

    /// Load the global config bundle + model catalog (idempotent; the
    /// Knowledge page requests it on first render).
    pub(super) fn rag_config_load(&self) {
        self.rag_dispatch_result(
            |result| match result {
                Ok(client::ResponsePayload::RagConfig {
                    config,
                    endpoints,
                    cloud_configured,
                }) => RagOpsEvent::Config(Ok(RagConfigBundle {
                    config,
                    endpoints,
                    cloud_configured,
                })),
                Err(error) => RagOpsEvent::Config(Err(error)),
                Ok(_) => RagOpsEvent::Config(Err("unexpected response".into())),
            },
            client::Command::RagConfigGet,
        );
        self.rag_dispatch_result(
            |result| match result {
                Ok(client::ResponsePayload::RagModels { models }) => RagOpsEvent::Models(Ok(models)),
                Err(error) => RagOpsEvent::Models(Err(error)),
                Ok(_) => RagOpsEvent::Models(Err("unexpected response".into())),
            },
            client::Command::RagModelsList,
        );
        // The sources list rides along — the rebuild fan-out needs it for
        // the knowledge index ("*") and the card below renders it anyway.
        self.rag_dispatch(
            move |payload| match payload {
                client::ResponsePayload::Sources { sources } => RagOpsEvent::Sources(Ok(sources)),
                _ => RagOpsEvent::Sources(Err("unexpected response".into())),
            },
            client::Command::SourcesList,
        );
    }

    /// Merge a partial settings update; a non-empty affected reply opens
    /// the rebuild dialog.
    pub(super) fn rag_config_update(&self, patch: client::RagConfigPatchWire) {
        self.rag_dispatch_result(
            |result| match result {
                Ok(client::ResponsePayload::RagAffected { workspaces }) => {
                    RagOpsEvent::Affected(workspaces)
                }
                Ok(client::ResponsePayload::Ack) => {
                    RagOpsEvent::Affected(Vec::new())
                }
                Err(error) => RagOpsEvent::Config(Err(error)),
                Ok(_) => RagOpsEvent::Config(Err("unexpected response".into())),
            },
            client::Command::RagConfigUpdate { patch },
        );
        self.rag_config_load();
    }

    /// Download / delete a catalog model (delete reports affected indexes
    /// through the rebuild dialog).
    pub(super) fn rag_model_command(&self, command: client::Command) {
        self.rag_dispatch_result(
            |result| match result {
                Ok(client::ResponsePayload::Ack) => RagOpsEvent::Affected(Vec::new()),
                Ok(client::ResponsePayload::RagAffected { workspaces }) => {
                    RagOpsEvent::Affected(workspaces)
                }
                Err(error) => RagOpsEvent::Models(Err(error)),
                Ok(_) => RagOpsEvent::Models(Err("unexpected response".into())),
            },
            command,
        );
        self.rag_dispatch_result(
            |result| match result {
                Ok(client::ResponsePayload::RagModels { models }) => RagOpsEvent::Models(Ok(models)),
                Err(error) => RagOpsEvent::Models(Err(error)),
                Ok(_) => RagOpsEvent::Models(Err("unexpected response".into())),
            },
            client::Command::RagModelsList,
        );
    }

    /// Custom-endpoint commands. Add keeps the dialog open with the error
    /// inline when the probe fails.
    pub(super) fn rag_endpoint_command(&self, command: client::Command) {
        self.rag_dispatch_result(
            |result| match result {
                Ok(client::ResponsePayload::RagEndpoint { endpoint }) => {
                    RagOpsEvent::Endpoint(Ok(endpoint))
                }
                Ok(client::ResponsePayload::Ack) => RagOpsEvent::Noop,
                Ok(client::ResponsePayload::RagAffected { workspaces }) => {
                    RagOpsEvent::Affected(workspaces)
                }
                Err(error) => RagOpsEvent::Endpoint(Err(error)),
                Ok(_) => RagOpsEvent::Endpoint(Err("unexpected response".into())),
            },
            command,
        );
        self.rag_config_load();
    }

    /// "Rebuild all now": fan the knowledge index (*) out to per-source
    /// reindexes, then re-init each affected project serially.
    pub(super) fn rag_rebuild_start(&mut self, cx: &mut Context<Self>) {
        let Some(rebuild) = self.rag_settings.rebuild.as_mut() else {
            return;
        };
        rebuild.running = true;
        rebuild.queue = rebuild
            .affected
            .iter()
            .filter(|a| a.project_id != "*")
            .map(|a| a.project_id.clone())
            .collect();
        // The knowledge index reindexes through its serial manager.
        for source in self.rag_settings.sources.clone() {
            self.rag_dispatch(
                move |payload| match payload {
                    client::ResponsePayload::Sources { .. } => RagOpsEvent::Noop,
                    _ => RagOpsEvent::Status(Err("unexpected response".into())),
                },
                client::Command::SourcesReindex {
                    source_id: source.id.clone(),
                },
            );
        }
        self.rag_rebuild_next(cx);
        cx.notify();
    }

    /// Pop the next serial rebuild step (no-op when the queue empties).
    fn rag_rebuild_next(&mut self, cx: &mut Context<Self>) {
        let next = self
            .rag_settings
            .rebuild
            .as_mut()
            .filter(|rebuild| rebuild.running)
            .and_then(|rebuild| rebuild.queue.first().cloned());
        if let Some(project_id) = next {
            self.rag_settings.rebuild.as_mut().expect("checked").queue.remove(0);
            self.rag_dispatch_result(
                |result| match result {
                    Ok(client::ResponsePayload::RagInit { .. }) => RagOpsEvent::RebuildStep,
                    Err(error) => {
                        eprintln!("[tide-rag] rebuild step failed: {error}");
                        RagOpsEvent::RebuildStep
                    }
                    Ok(_) => RagOpsEvent::RebuildStep,
                },
                client::Command::RagInitWorkspace { project_id },
            );
        } else if let Some(rebuild) = self.rag_settings.rebuild.as_mut() {
            rebuild.running = false;
        }
        cx.notify();
    }

    /// Load status + sources for a project.
    pub(super) fn rag_refresh(&self, project_id: &str) {
        let status_id = project_id.to_owned();
        self.rag_dispatch(
            move |payload| match payload {
                client::ResponsePayload::RagStatus { status } => RagOpsEvent::Status(Ok(status)),
                _ => RagOpsEvent::Status(Err("unexpected response".into())),
            },
            client::Command::RagStatus {
                project_id: status_id,
            },
        );
        self.rag_dispatch(
            move |payload| match payload {
                client::ResponsePayload::Sources { sources } => RagOpsEvent::Sources(Ok(sources)),
                _ => RagOpsEvent::Sources(Err("unexpected response".into())),
            },
            client::Command::SourcesList,
        );
    }

    /// Enable/disable RAG for a project, then refresh.
    pub(super) fn rag_set_enabled(&self, project_id: &str, enabled: bool, cx: &mut Context<Self>) {
        let command = if enabled {
            client::Command::RagEnableWorkspace {
                project_id: project_id.to_owned(),
            }
        } else {
            client::Command::RagDisableWorkspace {
                project_id: project_id.to_owned(),
            }
        };
        self.rag_dispatch(
            move |payload| match payload {
                client::ResponsePayload::Ack => RagOpsEvent::Noop,
                _ => RagOpsEvent::Status(Err("unexpected response".into())),
            },
            command,
        );
        self.rag_refresh(project_id);
        cx.notify();
    }

    /// Kick index building, then refresh.
    pub(super) fn rag_init(&self, project_id: &str, cx: &mut Context<Self>) {
        self.rag_dispatch(
            move |payload| match payload {
                client::ResponsePayload::RagInit { .. } => RagOpsEvent::Noop,
                _ => RagOpsEvent::Status(Err("unexpected response".into())),
            },
            client::Command::RagInitWorkspace {
                project_id: project_id.to_owned(),
            },
        );
        self.rag_refresh(project_id);
        cx.notify();
    }

    /// Submit the add dialog (upstream's handleSubmit: name required,
    /// location required, http(s) for url/crawl). Errors stay inline.
    pub(super) fn rag_source_add(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.rag_settings.dialog.as_ref() else {
            return;
        };
        let name = dialog.name.read(cx).content().trim().to_owned();
        let location = dialog.location.read(cx).content().trim().to_owned();
        let kind = dialog.kind;
        let mut error = None;
        if name.is_empty() {
            error = Some(tr!("settings.rag.error_name_required").to_string());
        } else if location.is_empty() {
            error = Some(tr!("settings.rag.error_location_required").to_string());
        } else if matches!(kind, "url" | "crawl")
            && !location.to_ascii_lowercase().starts_with("http://")
            && !location.to_ascii_lowercase().starts_with("https://")
        {
            error = Some(tr!("settings.rag.error_http_required").to_string());
        }
        if let Some(error) = error {
            self.rag_settings.dialog.as_mut().expect("checked").error = Some(error);
            cx.notify();
            return;
        }
        self.rag_settings.dialog.as_mut().expect("checked").busy = true;
        self.rag_settings.pending_source = Some("add".to_owned());
        let kind = kind.to_owned();
        let project_id = match self.rag_settings.scope {
            KnowledgeScope::Global => None,
            KnowledgeScope::Project(id) => Some(id.to_string()),
        };
        self.rag_dispatch(
            move |payload| match payload {
                client::ResponsePayload::Sources { sources } => RagOpsEvent::Sources(Ok(sources)),
                _ => RagOpsEvent::Sources(Err("unexpected response".into())),
            },
            client::Command::SourcesAdd {
                name,
                kind,
                location,
                project_id,
            },
        );
        cx.notify();
    }

    /// Submit the add-endpoint sheet: client-side presence checks, then
    /// the daemon probes before persisting; failures stay inline.
    pub(super) fn rag_endpoint_add(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.rag_settings.endpoint_dialog.as_ref() else {
            return;
        };
        let name = dialog.name.read(cx).content().trim().to_owned();
        let base_url = dialog.base_url.read(cx).content().trim().to_owned();
        let model_id = dialog.model_id.read(cx).content().trim().to_owned();
        let api_key = dialog.api_key.read(cx).content().trim().to_owned();
        let error = rag_endpoint_validate(&name, &base_url, &model_id, &api_key);
        if let Some(error) = error {
            self.rag_settings.endpoint_dialog.as_mut().expect("checked").error = Some(error);
            cx.notify();
            return;
        }
        self.rag_settings.endpoint_dialog.as_mut().expect("checked").busy = true;
        self.rag_endpoint_command(client::Command::RagEndpointAdd {
            name,
            base_url,
            model_id,
            api_key,
            max_tokens: None,
        });
        cx.notify();
    }

    /// Submit the single-field edit dialog (empty clears cloud model id).
    pub(super) fn rag_value_submit(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.rag_settings.value_dialog.as_ref() else {
            return;
        };
        let raw = dialog.value.read(cx).content().trim().to_owned();
        let patch = match dialog.kind {
            ValueDialogKind::CloudModelId => client::RagConfigPatchWire {
                cloud_model_id: Some(raw),
                ..Default::default()
            },
            ValueDialogKind::MinSimilarity => {
                let parsed = raw.parse::<f64>().ok().filter(|v| v.is_finite());
                match parsed {
                    Some(value) => client::RagConfigPatchWire {
                        min_similarity: Some(value),
                        ..Default::default()
                    },
                    None => {
                        let error = tr!("settings.rag.error_number_required").to_string();
                        self.rag_settings.value_dialog.as_mut().expect("checked").error = Some(error);
                        cx.notify();
                        return;
                    }
                }
            }
            ValueDialogKind::ChunkSize | ValueDialogKind::ChunkOverlap => {
                // Empty clears the override (back to chunker defaults) —
                // expressed as 0, which the daemon maps to "unset".
                let raw = if raw.is_empty() { "0".to_owned() } else { raw };
                {
                    match raw.parse::<u64>() {
                        Ok(value) => match dialog.kind {
                            ValueDialogKind::ChunkSize => client::RagConfigPatchWire {
                                chunk_size: Some(value),
                                ..Default::default()
                            },
                            _ => client::RagConfigPatchWire {
                                chunk_overlap: Some(value),
                                ..Default::default()
                            },
                        },
                        Err(_) => {
                            let error = tr!("settings.rag.error_number_required").to_string();
                            self.rag_settings.value_dialog.as_mut().expect("checked").error = Some(error);
                            cx.notify();
                            return;
                        }
                    }
                }
            }
        };
        self.rag_settings.value_dialog = None;
        self.rag_config_update(patch);
        cx.notify();
    }

    /// Adjust top-K from the stepper (clamped by the daemon too).
    pub(super) fn rag_topk_bump(&self, delta: i64) {
        let current = self
            .rag_settings
            .config
            .as_ref()
            .map(|config| config.top_k as i64)
            .unwrap_or(5);
        let next = (current + delta).clamp(1, 50);
        if next != current {
            self.rag_config_update(client::RagConfigPatchWire {
                top_k: Some(next as u64),
                ..Default::default()
            });
        }
    }

    /// Reindex or remove one source.
    pub(super) fn rag_source_command(&mut self, command: client::Command) {
        if let client::Command::SourcesReindex { source_id }
        | client::Command::SourcesRemove { source_id } = &command
        {
            self.rag_settings.pending_source = Some(source_id.clone());
        }
        self.rag_dispatch(
            move |payload| match payload {
                client::ResponsePayload::Sources { sources } => RagOpsEvent::Sources(Ok(sources)),
                _ => RagOpsEvent::Sources(Err("unexpected response".into())),
            },
            command,
        );
    }

    /// Drain ops events; keeps a 2 s poll alive while anything transient is
    /// in flight (download, ingestion, indexing, queued).
    pub(super) fn drain_rag_ops_events(&mut self, cx: &mut Context<Self>) -> bool {
        let mut changed = false;
        while let Ok(event) = self.rag_settings.ops_rx.try_recv() {
            changed = true;
            match event {
                RagOpsEvent::Noop => {}
                RagOpsEvent::Status(result) => match result {
                    Ok(status) => {
                        let live_phase = status.init_progress.as_ref().is_some_and(|progress| {
                            matches!(
                                progress.phase.as_str(),
                                "walking" | "chunking" | "embedding"
                            )
                        });
                        let transient = status.model_download == "downloading"
                            || status.init_state == "running"
                            || live_phase;
                        let id = status.project_id.clone();
                        self.rag_settings.status = Some(status);
                        self.rag_settings.status_error = None;
                        if transient && self.state.selected_project.is_some() {
                            self.rag_poll_again(&id);
                        }
                    }
                    Err(error) => self.rag_settings.status_error = Some(error),
                },
                RagOpsEvent::Sources(result) => match result {
                    Ok(sources) => {
                        let transient = sources
                            .iter()
                            .any(|source| source.status == "queued" || source.status == "indexing");
                        self.rag_settings.sources = sources;
                        self.rag_settings.sources_error = None;
                        self.rag_settings.pending_source = None;
                        if let Some(dialog) = self.rag_settings.dialog.as_mut()
                            && dialog.busy
                        {
                            self.rag_settings.dialog = None;
                        }
                        if transient && self.state.selected_project.is_some() {
                            self.rag_poll_sources();
                        }
                    }
                    Err(error) => {
                        self.rag_settings.sources_error = Some(error.clone());
                        self.rag_settings.pending_source = None;
                        if let Some(dialog) = self.rag_settings.dialog.as_mut() {
                            dialog.busy = false;
                            dialog.error = Some(error);
                        }
                    }
                },
                RagOpsEvent::Config(result) => match result {
                    Ok(bundle) => {
                        self.rag_settings.config = Some(bundle.config);
                        self.rag_settings.endpoints = bundle.endpoints;
                        self.rag_settings.cloud_configured = bundle.cloud_configured;
                        self.rag_settings.config_error = None;
                        self.rag_settings.config_requested.set(false);
                    }
                    Err(error) => {
                        self.rag_settings.config_error = Some(error);
                        self.rag_settings.config_requested.set(false);
                    }
                },
                RagOpsEvent::Models(result) => match result {
                    Ok(models) => {
                        let transient = models
                            .iter()
                            .any(|model| model.download_state == "downloading");
                        self.rag_settings.models = models;
                        if transient {
                            self.rag_poll_models();
                        }
                    }
                    Err(error) => self.rag_settings.config_error = Some(error),
                },
                RagOpsEvent::Affected(workspaces) => {
                    if !workspaces.is_empty() {
                        self.rag_settings.rebuild = Some(RebuildState {
                            affected: workspaces,
                            queue: Vec::new(),
                            running: false,
                        });
                    }
                }
                RagOpsEvent::Endpoint(result) => match result {
                    Ok(_) => {
                        self.rag_settings.endpoint_dialog = None;
                    }
                    Err(error) => {
                        if let Some(dialog) = self.rag_settings.endpoint_dialog.as_mut() {
                            dialog.busy = false;
                            dialog.error = Some(error);
                        } else {
                            self.rag_settings.config_error = Some(error);
                        }
                    }
                },
                RagOpsEvent::RebuildStep => {
                    let done = self
                        .rag_settings
                        .rebuild
                        .as_ref()
                        .is_some_and(|rebuild| rebuild.running && rebuild.queue.is_empty());
                    if done {
                        self.rag_settings.rebuild = None;
                    } else {
                        self.rag_rebuild_next(cx);
                    }
                }
            }
        }
        if changed {
            cx.notify();
        }
        changed
    }

    /// One delayed status refresh (each landing status re-arms while
    /// transient — a self-sustaining poll with no timer state).
    fn rag_poll_again(&self, project_id: &str) {
        let ops_tx = self.rag_settings.ops_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let daemon = self.daemon.client();
        let id = project_id.to_owned();
        let _ = std::thread::Builder::new()
            .name("tide-rag-poll".into())
            .spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let outcome = match daemon.request(
                    Uuid::nil(),
                    Uuid::nil(),
                    client::Command::RagStatus { project_id: id },
                ) {
                    Ok(client::ResponsePayload::RagStatus { status }) => {
                        RagOpsEvent::Status(Ok(status))
                    }
                    Ok(_) => RagOpsEvent::Status(Err("unexpected response".into())),
                    Err(error) => RagOpsEvent::Status(Err(error.to_string())),
                };
                if ops_tx.send(outcome).is_ok() {
                    signal_event_pump(&event_wake);
                }
            });
    }

    fn rag_poll_models(&self) {
        let ops_tx = self.rag_settings.ops_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let daemon = self.daemon.client();
        let _ = std::thread::Builder::new()
            .name("tide-rag-poll".into())
            .spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let outcome =
                    match daemon.request(Uuid::nil(), Uuid::nil(), client::Command::RagModelsList) {
                        Ok(client::ResponsePayload::RagModels { models }) => {
                            RagOpsEvent::Models(Ok(models))
                        }
                        Ok(_) => RagOpsEvent::Models(Err("unexpected response".into())),
                        Err(error) => RagOpsEvent::Models(Err(error.to_string())),
                    };
                if ops_tx.send(outcome).is_ok() {
                    signal_event_pump(&event_wake);
                }
            });
    }

    fn rag_poll_sources(&self) {
        let ops_tx = self.rag_settings.ops_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let daemon = self.daemon.client();
        let _ = std::thread::Builder::new()
            .name("tide-rag-poll".into())
            .spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let outcome =
                    match daemon.request(Uuid::nil(), Uuid::nil(), client::Command::SourcesList) {
                        Ok(client::ResponsePayload::Sources { sources }) => {
                            RagOpsEvent::Sources(Ok(sources))
                        }
                        Ok(_) => RagOpsEvent::Sources(Err("unexpected response".into())),
                        Err(error) => RagOpsEvent::Sources(Err(error.to_string())),
                    };
                if ops_tx.send(outcome).is_ok() {
                    signal_event_pump(&event_wake);
                }
            });
    }
}

// ── pure status decisions (the card's every word, testable) ────────────────

/// Client-side presence checks mirroring the daemon's, so a bad sheet
/// fails inline without a round trip.
fn rag_endpoint_validate(
    name: &str,
    base_url: &str,
    model_id: &str,
    api_key: &str,
) -> Option<String> {
    if name.is_empty() {
        return Some(tr!("settings.rag.error_name_required").to_string());
    }
    if base_url.is_empty() {
        return Some(tr!("settings.rag.error_location_required").to_string());
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Some(tr!("settings.rag.error_http_required").to_string());
    }
    if model_id.is_empty() {
        return Some(tr!("settings.rag.error_model_required").to_string());
    }
    if api_key.is_empty() {
        return Some(tr!("settings.rag.error_key_required").to_string());
    }
    None
}

/// The languages badge for a catalog entry.
fn rag_language_label(languages: &str) -> String {
    match languages {
        "multilingual" => tr!("settings.rag.lang_multilingual").to_string(),
        _ => tr!("settings.rag.lang_english").to_string(),
    }
}

/// A catalog row's sub-label: `local · 384 dim · 512 tokens · English ·
/// downloaded` — dims + window + language class + on-disk state.
fn rag_model_sub_label(model: &client::RagModelWire) -> String {
    let state = match model.download_state.as_str() {
        "ready" => tr!("settings.rag.state_downloaded"),
        "downloading" => tr!("settings.rag.model_downloading"),
        "failed" => tr!("settings.rag.model_failed"),
        _ if model.vendored => tr!("settings.rag.state_builtin"),
        _ => tr!("settings.rag.state_not_downloaded"),
    };
    format!(
        "{} · {} dim · {} {} · {}",
        rag_language_label(&model.languages),
        model.dims,
        model.max_tokens,
        tr!("settings.rag.tokens_suffix"),
        state
    )
}

/// The selected embedder's display line for the card head: the original
/// repo name for catalog ids, the cloud label, or the endpoint's name.
fn rag_selection_label(
    config: Option<&client::RagConfigWire>,
    models: &[client::RagModelWire],
    endpoints: &[client::RagEndpointWire],
) -> String {
    let Some(config) = config else {
        return tr!("settings.rag.loading").to_string();
    };
    if let Some(model) = models.iter().find(|m| m.id == config.embedder_id) {
        return model.name.clone();
    }
    if config.embedder_id == "cloud-base" {
        return tr!("settings.rag.cloud_embedder").to_string();
    }
    if let Some(endpoint) = endpoints.iter().find(|e| e.id == config.embedder_id) {
        return format!("{} · {}", endpoint.name, endpoint.model_id);
    }
    config.embedder_id.clone()
}

/// The affected-workspace display name: the project's name, or the global
/// knowledge label for `"*"`.
fn rag_affected_label(project_id: &str, projects: &[Project]) -> String {
    if project_id == "*" {
        return tr!("settings.rag.global_knowledge").to_string();
    }
    projects
        .iter()
        .find(|project| project.id.to_string() == project_id)
        .map(|project| project.name.clone())
        .unwrap_or_else(|| project_id.to_owned())
}

/// The embedding-model state, as the head pill renders it: ready /
/// downloading / failed (with the error) / not downloaded. A status for
/// another project reads as not downloaded.
fn rag_model_line(status: Option<&client::RagStatusWire>, project_id: &str) -> String {
    match status.filter(|status| status.project_id == project_id) {
        Some(status) => match status.model_download.as_str() {
            "ready" => tr!("settings.rag.model_ready").to_string(),
            "downloading" => tr!("settings.rag.model_downloading").to_string(),
            "failed" => format!(
                "{} — {}",
                tr!("settings.rag.model_failed"),
                status.model_download_error.as_deref().unwrap_or_default()
            ),
            _ => tr!("settings.rag.model_missing").to_string(),
        },
        None => tr!("settings.rag.model_missing").to_string(),
    }
}

/// The pill color pairs with [`rag_model_line`]; the dot keeps state off
/// color alone.
fn rag_model_pill_color(
    theme: &Theme,
    status: Option<&client::RagStatusWire>,
    project_id: &str,
) -> gpui::Hsla {
    match status.filter(|status| status.project_id == project_id) {
        Some(status) => match status.model_download.as_str() {
            "ready" => theme.success,
            "downloading" => theme.warning,
            "failed" => theme.danger,
            _ => theme.text_tertiary,
        },
        None => theme.text_tertiary,
    }
}

/// The code-index row's status line: indexing / done (with the chunk count)
/// / not indexed. Another project's status reads as not indexed.
fn rag_index_line(status: Option<&client::RagStatusWire>, project_id: &str) -> String {
    match status.filter(|status| status.project_id == project_id) {
        Some(status) => match status.init_state.as_str() {
            "running" => tr!("settings.rag.indexing").to_string(),
            "done" => format!(
                "{} · {} {}",
                tr!("settings.rag.indexed"),
                status.chunk_count,
                tr!("settings.rag.chunks_suffix")
            ),
            _ => tr!("settings.rag.not_indexed").to_string(),
        },
        None => tr!("settings.rag.not_indexed").to_string(),
    }
}

/// A download or an index build is in flight.
fn rag_is_busy(status: Option<&client::RagStatusWire>) -> bool {
    status.is_some_and(|status| {
        status.model_download == "downloading" || status.init_state == "running"
    })
}

/// The head build button's label: indexing while busy, rebuild once indexed,
/// build otherwise. Another project's status counts as not indexed.
fn rag_build_label(status: Option<&client::RagStatusWire>, project_id: &str) -> String {
    let relevant = status.filter(|status| status.project_id == project_id);
    if rag_is_busy(relevant) {
        tr!("settings.rag.indexing").to_string()
    } else if relevant.is_some_and(|status| status.init_state == "done") {
        tr!("settings.rag.rebuild").to_string()
    } else {
        tr!("settings.rag.build").to_string()
    }
}


// ── global settings cards (model picker / models / retrieval / endpoints) ──

impl Tide {
    /// The global "Memory & RAG" card stack at the top of the Knowledge
    /// page: embedding model picker, local model manager, retrieval
    /// tuning, and custom endpoints. Loads the config bundle on first
    /// render (render paths take &self, so the request guard lives in a
    /// Cell).
    pub(super) fn render_global_rag_cards(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        if self.rag_settings.config.is_none() && !self.rag_settings.config_requested.get() {
            self.rag_settings.config_requested.set(true);
            self.rag_config_load();
        }

        div()
            .flex()
            .flex_col()
            .gap(px(26.0))
            .child(self.render_rag_model_card(theme, cx))
            .child(self.render_rag_models_manager(theme, cx))
            .child(self.render_rag_retrieval_card(theme, cx))
            .child(self.render_rag_advanced_card(theme, cx))
            .child(self.render_rag_endpoints_card(theme, cx))
    }

    /// The embedding-model card: the picker in the body, the current
    /// selection in the head, cloud fallback + cloud model id beneath.
    fn render_rag_model_card(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let config = self.rag_settings.config.clone();
        let selection = rag_selection_label(
            config.as_ref(),
            &self.rag_settings.models,
            &self.rag_settings.endpoints,
        );

        let weak = cx.entity().downgrade();
        let selected_id = config.as_ref().map(|c| c.embedder_id.clone());
        let cloud_available = self.rag_settings.cloud_configured;
        let models = self.rag_settings.models.clone();
        let endpoints = self.rag_settings.endpoints.clone();
        let picker = self.rag_settings.picker.clone();
        let picker_menu = dropdown_menu(
            MenuChip::new("rag-model-picker")
                .label(selection.clone())
                .outlined()
                .selected(picker.is_open())
                .max_w(px(280.0))
                .justify_between(),
            "rag-model-picker-menu",
            &picker,
            MenuAlign::BelowRight,
            move |_| {
                let mut items: Vec<MenuItem> =
                    vec![MenuItem::Header(
                        tr!("settings.rag.group_local").into(),
                    )];
                for model in models.iter() {
                    let weak = weak.clone();
                    let id = model.id.clone();
                    let label = model.name.clone();
                    let sub = rag_model_sub_label(model);
                    let selected = selected_id.as_deref() == Some(id.as_str());
                    items.push(
                        MenuItem::custom(move |_, cx| {
                            let theme = Theme::current(cx);
                            div()
                                .flex()
                                .flex_col()
                                .py(px(3.0))
                                .child(
                                    div()
                                        .text_size(sp(12.0))
                                        .text_color(theme.text)
                                        .truncate()
                                        .child(SharedString::from(label.clone())),
                                )
                                .child(
                                    div()
                                        .text_size(sp(10.0))
                                        .text_color(theme.text_tertiary)
                                        .truncate()
                                        .child(SharedString::from(sub.clone())),
                                )
                                .into_any_element()
                        })
                        .on_click(move |_window, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.rag_config_update(client::RagConfigPatchWire {
                                    embedder_id: Some(id.clone()),
                                    ..Default::default()
                                });
                                cx.notify();
                            });
                        })
                        .selected(selected),
                    );
                }
                items.push(MenuItem::Header(
                    tr!("settings.rag.group_cloud").into(),
                ));
                {
                    let weak = weak.clone();
                    let selected = selected_id.as_deref() == Some("cloud-base");
                    let label = if cloud_available {
                        tr!("settings.rag.cloud_embedder").to_string()
                    } else {
                        tr!("settings.rag.cloud_embedder_unconfigured").to_string()
                    };
                    items.push(
                        MenuItem::new(label, move |_window, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.rag_config_update(client::RagConfigPatchWire {
                                    embedder_id: Some("cloud-base".into()),
                                    ..Default::default()
                                });
                                cx.notify();
                            });
                        })
                        .selected(selected)
                        .disabled(!cloud_available),
                    );
                }
                if !endpoints.is_empty() {
                    items.push(MenuItem::Header(
                        tr!("settings.rag.group_endpoints").into(),
                    ));
                    for endpoint in endpoints.iter() {
                        let weak = weak.clone();
                        let id = endpoint.id.clone();
                        let label = format!("{} · {}", endpoint.name, endpoint.model_id);
                        let selected = selected_id.as_deref() == Some(id.as_str());
                        items.push(
                            MenuItem::new(label, move |_window, cx| {
                                let _ = weak.update(cx, |this, cx| {
                                    this.rag_config_update(client::RagConfigPatchWire {
                                        embedder_id: Some(id.clone()),
                                        ..Default::default()
                                    });
                                    cx.notify();
                                });
                            })
                            .selected(selected),
                        );
                    }
                }
                items
            },
        );

        let cloud_allowed = config
            .as_ref()
            .is_some_and(|config| config.cloud_allowed);
        let cloud_toggle = toggle_switch(
            SharedString::from("rag-cloud-allowed"),
            cloud_allowed,
            false,
            *theme,
            cx,
            move |this, _window, cx| {
                let next = !this
                    .rag_settings
                    .config
                    .as_ref()
                    .is_some_and(|config| config.cloud_allowed);
                this.rag_config_update(client::RagConfigPatchWire {
                    cloud_allowed: Some(next),
                    ..Default::default()
                });
                cx.notify();
            },
        );

        let cloud_model_value = config
            .as_ref()
            .and_then(|config| config.cloud_model_id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| tr!("settings.rag.cloud_model_default").to_string());
        let edit = CardButton::new("rag-cloud-model-edit", tr!("settings.rag.edit"))
            .render(*theme, cx, |this, window, cx| {
                this.rag_settings
                    .open_value_dialog(ValueDialogKind::CloudModelId, window, cx);
            });

        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.global_title"),
            vec![card_pill(theme, selection, theme.accent).into_any_element()],
        ));

        card.child(card_body(theme).child(card_rows(
            theme,
            vec![
                CardRow::new(tr!("settings.rag.model"))
                    .description(tr!("settings.rag.model_hint"))
                    .control(picker_menu),
                CardRow::new(tr!("settings.rag.cloud_fallback"))
                    .description(tr!("settings.rag.cloud_fallback_hint"))
                    .control(cloud_toggle),
                CardRow::new(tr!("settings.rag.cloud_model"))
                    .description(tr!("settings.rag.cloud_model_hint"))
                    .control(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .text_size(sp(12.5))
                                    .text_color(theme.text_secondary)
                                    .truncate()
                                    .max_w(px(220.0))
                                    .child(SharedString::from(cloud_model_value)),
                            )
                            .child(edit),
                    ),
            ],
        )))
    }

    /// The local models manager: one row per catalog entry (original repo
    /// name + dims/window/language/state sub-label) with download/delete.
    fn render_rag_models_manager(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let mut rows: Vec<CardRow> = Vec::new();
        for model in self.rag_settings.models.iter() {
            let downloading = model.download_state == "downloading";
            let downloaded = model.downloaded || model.vendored;
            let action: gpui::AnyElement = if downloading {
                card_pill(theme, tr!("settings.rag.model_downloading"), theme.warning)
                    .into_any_element()
            } else if model.download_state == "failed" {
                let label = format!(
                    "{} — {}",
                    tr!("settings.rag.model_failed"),
                    model.download_error.as_deref().unwrap_or_default()
                );
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(card_pill(theme, label, theme.danger))
                    .child(
                        CardButton::new(
                            SharedString::from(format!("rag-model-retry-{}", model.id)),
                            tr!("settings.rag.download"),
                        )
                        .render(*theme, cx, {
                            let id = model.id.clone();
                            move |this, _window, cx| {
                                this.rag_model_command(client::Command::RagModelDownload {
                                    model_id: id.clone(),
                                });
                                cx.notify();
                            }
                        }),
                    )
                    .into_any_element()
            } else if downloaded {
                let delete = if model.vendored {
                    div().into_any_element()
                } else {
                    CardButton::new(
                        SharedString::from(format!("rag-model-delete-{}", model.id)),
                        tr!("settings.rag.delete_model"),
                    )
                    .render(*theme, cx, {
                        let id = model.id.clone();
                        move |this, _window, cx| {
                            this.rag_model_command(client::Command::RagModelDelete {
                                model_id: id.clone(),
                            });
                            cx.notify();
                        }
                    })
                    .into_any_element()
                };
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(card_pill(theme, tr!("settings.rag.state_downloaded"), theme.success))
                    .child(delete)
                    .into_any_element()
            } else {
                CardButton::new(
                    SharedString::from(format!("rag-model-download-{}", model.id)),
                    tr!("settings.rag.download"),
                )
                .render(*theme, cx, {
                    let id = model.id.clone();
                    move |this, _window, cx| {
                        this.rag_model_command(client::Command::RagModelDownload {
                            model_id: id.clone(),
                        });
                        cx.notify();
                    }
                })
                .into_any_element()
            };
            rows.push(
                CardRow::new(SharedString::from(model.name.clone()))
                    .description(SharedString::from(rag_model_sub_label(model)))
                    .control(action),
            );
        }

        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.models_title"),
            Vec::new(),
        ));
        if rows.is_empty() {
            return card.child(
                card_body(theme).child(
                    div()
                        .text_size(sp(11.0))
                        .text_color(theme.text_tertiary)
                        .child(tr!("settings.rag.loading")),
                ),
            );
        }
        card.child(card_body(theme).child(card_rows(theme, rows)))
    }

    /// Retrieval tuning: top-K stepper and minimum similarity.
    fn render_rag_retrieval_card(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let top_k = self
            .rag_settings
            .config
            .as_ref()
            .map(|config| config.top_k)
            .unwrap_or(5);
        let minus = CardButton::new("rag-topk-minus", "−")
            .render(*theme, cx, |this, _window, cx| {
                this.rag_topk_bump(-1);
                cx.notify();
            });
        let plus = CardButton::new("rag-topk-plus", "+")
            .render(*theme, cx, |this, _window, cx| {
                this.rag_topk_bump(1);
                cx.notify();
            });
        let min_sim = self
            .rag_settings
            .config
            .as_ref()
            .and_then(|config| config.min_similarity)
            .map(|v| format!("{v}"))
            .unwrap_or_else(|| tr!("settings.rag.min_sim_off").to_string());
        let edit = CardButton::new("rag-minsim-edit", tr!("settings.rag.edit"))
            .render(*theme, cx, |this, window, cx| {
                this.rag_settings
                    .open_value_dialog(ValueDialogKind::MinSimilarity, window, cx);
            });

        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.retrieval_title"),
            Vec::new(),
        ));
        card.child(card_body(theme).child(card_rows(
            theme,
            vec![
                CardRow::new(tr!("settings.rag.top_k"))
                    .description(tr!("settings.rag.top_k_hint"))
                    .control(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(minus)
                            .child(
                                div()
                                    .min_w(px(24.0))
                                    .text_size(sp(12.5))
                                    .text_color(theme.text_secondary)
                                    .flex()
                                    .justify_center()
                                    .child(SharedString::from(top_k.to_string())),
                            )
                            .child(plus),
                    ),
                CardRow::new(tr!("settings.rag.min_similarity"))
                    .description(tr!("settings.rag.min_similarity_hint"))
                    .control(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .text_size(sp(12.5))
                                    .text_color(theme.text_secondary)
                                    .child(SharedString::from(min_sim)),
                            )
                            .child(edit),
                    ),
            ],
        )))
    }

    /// Advanced: chunking overrides (changes route through the affected
    /// dialog like a model switch — they invalidate existing indexes).
    fn render_rag_advanced_card(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let config = self.rag_settings.config.as_ref();
        let value_of = |v: Option<u64>| {
            v.map(|n| n.to_string())
                .unwrap_or_else(|| tr!("settings.rag.chunk_default").to_string())
        };
        let chunk_size_edit = CardButton::new("rag-chunksize-edit", tr!("settings.rag.edit"))
            .render(*theme, cx, |this, window, cx| {
                this.rag_settings
                    .open_value_dialog(ValueDialogKind::ChunkSize, window, cx);
            });
        let chunk_overlap_edit = CardButton::new("rag-chunkoverlap-edit", tr!("settings.rag.edit"))
            .render(*theme, cx, |this, window, cx| {
                this.rag_settings
                    .open_value_dialog(ValueDialogKind::ChunkOverlap, window, cx);
            });

        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.advanced_title"),
            Vec::new(),
        ));
        card.child(card_body(theme).child(card_rows(
            theme,
            vec![
                CardRow::new(tr!("settings.rag.chunk_size"))
                    .description(tr!("settings.rag.chunk_hint"))
                    .control(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .text_size(sp(12.5))
                                    .text_color(theme.text_secondary)
                                    .child(SharedString::from(value_of(
                                        config.and_then(|c| c.chunk_size),
                                    ))),
                            )
                            .child(chunk_size_edit),
                    ),
                CardRow::new(tr!("settings.rag.chunk_overlap"))
                    .description(tr!("settings.rag.chunk_hint"))
                    .control(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .text_size(sp(12.5))
                                    .text_color(theme.text_secondary)
                                    .child(SharedString::from(value_of(
                                        config.and_then(|c| c.chunk_overlap),
                                    ))),
                            )
                            .child(chunk_overlap_edit),
                    ),
            ],
        )))
    }

    /// Custom endpoints: BYOK rows with remove; add opens the sheet.
    fn render_rag_endpoints_card(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let add = CardButton::new("rag-endpoint-add", tr!("settings.rag.add_endpoint"))
            .icon("icons/plus.svg")
            .render(*theme, cx, |this, window, cx| {
                this.rag_settings.open_endpoint_dialog(window, cx);
            });
        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.endpoints_title"),
            vec![add.into_any_element()],
        ));
        if self.rag_settings.endpoints.is_empty() {
            return card.child(
                card_body(theme).child(
                    div()
                        .text_size(sp(11.0))
                        .text_color(theme.text_tertiary)
                        .child(tr!("settings.rag.endpoints_empty")),
                ),
            );
        }
        let mut rows = Vec::new();
        for endpoint in self.rag_settings.endpoints.iter() {
            let remove = CardButton::new(
                SharedString::from(format!("rag-endpoint-remove-{}", endpoint.id)),
                tr!("settings.rag.remove"),
            )
            .render(*theme, cx, {
                let id = endpoint.id.clone();
                move |this, _window, cx| {
                    this.rag_endpoint_command(client::Command::RagEndpointRemove {
                        endpoint_id: id.clone(),
                    });
                    cx.notify();
                }
            });
            rows.push(
                CardRow::new(SharedString::from(endpoint.name.clone()))
                    .description(SharedString::from(format!(
                        "{} · {} · {} dim",
                        endpoint.model_id, endpoint.base_url, endpoint.dims
                    )))
                    .control(remove),
            );
        }
        card.child(card_body(theme).child(card_rows(theme, rows)))
    }

    /// The add-endpoint sheet (probe errors stay inline; nothing persists
    /// until the daemon's probe passes).
    pub(super) fn render_rag_endpoint_dialog(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = Theme::current(cx);
        let draft = self.rag_settings.endpoint_dialog.as_ref()?;
        let (name, base_url, model_id, api_key, error, busy) = (
            draft.name.clone(),
            draft.base_url.clone(),
            draft.model_id.clone(),
            draft.api_key.clone(),
            draft.error.clone(),
            draft.busy,
        );

        let field = |label: SharedString, input: Entity<crate::input::TextInput>| {
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(
                    div()
                        .text_size(sp(11.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text)
                        .child(label),
                )
                .child(input)
        };
        let body = div()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(field(
                tr!("settings.rag.dialog_name").to_string().into(),
                name,
            ))
            .child(field(
                tr!("settings.rag.endpoint_base_url").to_string().into(),
                base_url,
            ))
            .child(field(
                tr!("settings.rag.endpoint_model_id").to_string().into(),
                model_id,
            ))
            .child(field(
                tr!("settings.rag.endpoint_api_key").to_string().into(),
                api_key,
            ))
            .when(!busy && error.is_some(), |el| {
                el.child(
                    div()
                        .text_size(sp(11.0))
                        .text_color(theme.danger)
                        .child(SharedString::from(error.clone().unwrap_or_default())),
                )
            });

        let mut footer = div().flex().justify_end().gap(px(8.0));
        footer = footer.child(
            CardButton::new("rag-endpoint-cancel", tr!("settings.rag.cancel")).render(
                theme,
                cx,
                |this: &mut Tide, _window, cx: &mut Context<Tide>| {
                    this.rag_settings.endpoint_dialog = None;
                    cx.notify();
                },
            ),
        );
        let submit_label = if busy {
            tr!("settings.rag.endpoint_probing").to_string()
        } else {
            tr!("settings.rag.add").to_string()
        };
        footer = footer.child(
            CardButton::new("rag-endpoint-submit", submit_label)
                .busy(busy)
                .render(theme, cx, |this: &mut Tide, _window, cx: &mut Context<Tide>| this.rag_endpoint_add(cx)),
        );

        let card = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .p(px(18.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .text_size(sp(14.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(tr!("settings.rag.add_endpoint")),
                    )
                    .child(
                        div()
                            .text_size(sp(11.0))
                            .text_color(theme.text_tertiary)
                            .child(tr!("settings.rag.endpoint_dialog_hint")),
                    ),
            )
            .child(body)
            .child(footer);
        Some(crate::ui::modal::deferred_scrim(
            "rag-endpoint-layer",
            card,
            &theme,
        ))
    }

    /// The single-field edit dialog (cloud model id / min similarity).
    pub(super) fn render_rag_value_dialog(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = Theme::current(cx);
        let draft = self.rag_settings.value_dialog.as_ref()?;
        let (label, hint) = match draft.kind {
            ValueDialogKind::CloudModelId => (
                tr!("settings.rag.cloud_model"),
                tr!("settings.rag.cloud_model_hint"),
            ),
            ValueDialogKind::MinSimilarity => (
                tr!("settings.rag.min_similarity"),
                tr!("settings.rag.min_similarity_hint"),
            ),
            ValueDialogKind::ChunkSize => (
                tr!("settings.rag.chunk_size"),
                tr!("settings.rag.chunk_hint"),
            ),
            ValueDialogKind::ChunkOverlap => (
                tr!("settings.rag.chunk_overlap"),
                tr!("settings.rag.chunk_hint"),
            ),
        };
        let value = draft.value.clone();
        let error = draft.error.clone();

        let body = div()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(sp(11.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(label),
                    )
                    .child(value),
            )
            .when(error.is_some(), |el| {
                el.child(
                    div()
                        .text_size(sp(11.0))
                        .text_color(theme.danger)
                        .child(SharedString::from(error.clone().unwrap_or_default())),
                )
            });

        let mut footer = div().flex().justify_end().gap(px(8.0));
        footer = footer.child(
            CardButton::new("rag-value-cancel", tr!("settings.rag.cancel")).render(
                theme,
                cx,
                |this: &mut Tide, _window, cx: &mut Context<Tide>| {
                    this.rag_settings.value_dialog = None;
                    cx.notify();
                },
            ),
        );
        footer = footer.child(
            CardButton::new("rag-value-submit", tr!("settings.rag.save"))
                .render(theme, cx, |this: &mut Tide, _window, cx: &mut Context<Tide>| this.rag_value_submit(cx)),
        );

        let card = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .p(px(18.0))
            .child(
                div()
                    .text_size(sp(11.0))
                    .text_color(theme.text_tertiary)
                    .child(hint),
            )
            .child(body)
            .child(footer);
        Some(crate::ui::modal::deferred_scrim(
            "rag-value-layer",
            card,
            &theme,
        ))
    }

    /// The rebuild offer after a settings change or delete: affected
    /// indexes listed, "Rebuild all now" (serial) or "Later".
    pub(super) fn render_rag_rebuild_dialog(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = Theme::current(cx);
        let rebuild = self.rag_settings.rebuild.as_ref()?;
        let running = rebuild.running;
        let remaining = rebuild.queue.len();
        let affected: Vec<(String, String)> = rebuild
            .affected
            .iter()
            .map(|a| {
                (
                    rag_affected_label(&a.project_id, &self.state.projects),
                    a.built_with.clone(),
                )
            })
            .collect();

        let rows = div().flex().flex_col().gap(px(6.0));
        let rows = affected.iter().fold(rows, |rows, (name, built_with)| {
            rows.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(sp(12.0))
                            .text_color(theme.text)
                            .child(SharedString::from(name.clone())),
                    )
                    .child(
                        div()
                            .text_size(sp(10.5))
                            .text_color(theme.text_tertiary)
                            .child(SharedString::from(format!(
                                "· {}",
                                built_with
                            ))),
                    ),
            )
        });

        let status_line = if running {
            tr!("settings.rag.rebuild_progress", count = remaining)
        } else {
            tr!("settings.rag.rebuild_description")
        };

        let mut footer = div().flex().justify_end().gap(px(8.0));
        if !running {
            footer = footer.child(
                CardButton::new("rag-rebuild-later", tr!("settings.rag.later")).render(
                    theme,
                    cx,
                    |this: &mut Tide, _window, cx: &mut Context<Tide>| {
                        this.rag_settings.rebuild = None;
                        cx.notify();
                    },
                ),
            );
            footer = footer.child(
                CardButton::new("rag-rebuild-now", tr!("settings.rag.rebuild_now"))
                    .render(theme, cx, |this: &mut Tide, _window, cx: &mut Context<Tide>| this.rag_rebuild_start(cx)),
            );
        }
        let footer = if running {
            footer.child(
                CardButton::new("rag-rebuild-close", tr!("settings.rag.close"))
                    .render(
                    theme,
                    cx,
                    |this: &mut Tide, _window, cx: &mut Context<Tide>| {
                        this.rag_settings.rebuild = None;
                        cx.notify();
                    },
                ),
            )
        } else {
            footer
        };

        let card = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .p(px(18.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .text_size(sp(14.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(tr!("settings.rag.rebuild_title")),
                    )
                    .child(
                        div()
                            .text_size(sp(11.0))
                            .text_color(theme.text_tertiary)
                            .child(status_line),
                    ),
            )
            .child(rows)
            .child(footer);
        Some(crate::ui::modal::deferred_scrim(
            "rag-rebuild-layer",
            card,
            &theme,
        ))
    }
}

// ── rendering ──────────────────────────────────────────────────────────────

/// Human phase label — one mapping shared by every call site, upstream's
/// `phaseLabel`.
pub(crate) fn init_phase_label(phase: &str) -> String {
    match phase {
        "walking" => tr!("settings.rag.phase_walking"),
        "chunking" => tr!("settings.rag.phase_chunking"),
        "embedding" => tr!("settings.rag.phase_embedding"),
        "failed" => tr!("settings.rag.phase_failed"),
        "done" => tr!("settings.rag.phase_done"),
        _ => tr!("settings.rag.indexing"),
    }
    .to_string()
}

/// The live indexing-progress card (upstream's RagIndexProgress): spinner +
/// phase headline, determinate bar while embedding (chunks embedded/total),
/// indeterminate shimmer otherwise, counts + current file, and the failed
/// error body.
fn render_init_progress(progress: &client::InitProgressWire, theme: &Theme) -> Div {
    let failed = progress.phase == "failed";
    let determinate = progress.phase == "embedding" && progress.chunks_total > 0;
    let pct = if determinate {
        ((progress.chunks_embedded as f64 / progress.chunks_total as f64) * 100.0).round() as u32
    } else {
        0
    };
    let counts = match progress.phase.as_str() {
        "walking" => format!(
            "{} {}",
            progress.files_seen,
            tr!("settings.rag.files_suffix")
        ),
        "chunking" => format!(
            "{} {} · {} {}",
            progress.chunks_total,
            tr!("settings.rag.chunks_suffix"),
            progress.files_seen,
            tr!("settings.rag.files_suffix")
        ),
        "embedding" => format!(
            "{} / {} {}",
            progress.chunks_embedded,
            progress.chunks_total,
            tr!("settings.rag.chunks_suffix")
        ),
        _ => String::new(),
    };
    let mut card = div()
        .rounded(px(8.0))
        .border_1()
        .border_color(if failed {
            theme.border_strong
        } else {
            theme.border
        })
        .px(px(10.0))
        .py(px(8.0))
        .mt(px(4.0))
        .mb(px(8.0))
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(if failed {
                    icon(
                        "icons/alert.svg",
                        13.0,
                        crate::app::timeline_v2::status_color(
                            theme,
                            crate::app::timeline_v2::Status::Error,
                        ),
                    )
                    .into_any_element()
                } else {
                    motion::spin(icon("icons/loader-circle.svg", 13.0, theme.text_tertiary))
                        .into_any_element()
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(sp(11.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text)
                        .child(SharedString::from(init_phase_label(&progress.phase))),
                )
                .when(determinate, |row| {
                    row.child(
                        div()
                            .text_size(sp(10.5))
                            .text_color(theme.text_tertiary)
                            .child(SharedString::from(format!("{pct}%"))),
                    )
                }),
        );
    if !failed {
        // Bar: determinate fill vs indeterminate shimmer (a slow pulse —
        // reduce-motion is honored by motion::spin itself).
        if determinate {
            card = card.child(
                div()
                    .h(px(4.0))
                    .w_full()
                    .rounded_full()
                    .bg(theme.inset)
                    .child(
                        div()
                            .h_full()
                            .rounded_full()
                            .bg(theme.accent)
                            .w(fract(pct.min(100) as f64 / 100.0)),
                    ),
            );
        } else {
            // Indeterminate: a half-fill accent bar (the walking/chunking
            // phases have no denominator worth a percentage).
            card = card.child(
                div()
                    .h(px(4.0))
                    .w_full()
                    .rounded_full()
                    .bg(theme.inset)
                    .child(
                        div()
                            .h_full()
                            .rounded_full()
                            .bg(theme.accent.opacity(0.6))
                            .w(gpui::relative(0.5)),
                    ),
            );
        }
    }
    if failed && let Some(error) = progress.error.as_deref() {
        card = card.child(
            div()
                .text_size(sp(10.5))
                .text_color(theme.text_tertiary)
                .child(SharedString::from(error.to_owned())),
        );
    }
    if !failed
        && let Some(file) = progress.current_file.as_deref()
        && !file.is_empty()
    {
        card = card.child(
            div()
                .text_size(sp(10.0))
                .text_color(theme.text_tertiary)
                .truncate()
                .child(SharedString::from(file.to_owned())),
        );
    }
    if !failed && !counts.is_empty() {
        card = card.child(
            div()
                .text_size(sp(10.5))
                .text_color(theme.text_tertiary)
                .child(SharedString::from(counts)),
        );
    }
    card
}

/// A fractional track fill (gpui's `relative`).
fn fract(ratio: f64) -> gpui::DefiniteLength {
    gpui::relative(ratio as f32)
}

impl Tide {
    /// The Memory & RAG card on the Knowledge page: the per-project enable
    /// toggle and index status in the body; the model-state pill and the
    /// build action live in the card head. Degrades to a hint without a
    /// selected project.
    /// The Memory & RAG card for an explicit project — the Projects settings
    /// page renders it for the rail selection.
    pub(super) fn render_memory_rag_card_for(
        &self,
        project: Option<Project>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let Some(project) = project else {
            return div()
                .child(settings_group_head(
                    theme,
                    tr!("settings.rag.title"),
                    Vec::new(),
                ))
                .child(
                    div()
                        .bg(theme.raised)
                        .border_1()
                        .border_color(theme.border)
                        .rounded(px(13.0))
                        .px(px(20.0))
                        .py(px(14.0))
                        .child(
                            div()
                                .text_size(sp(11.0))
                                .text_color(theme.text_tertiary)
                                .child(tr!("settings.rag.no_project")),
                        ),
                );
        };
        let project_id = project.id.to_string();
        let project_name = project.name.clone();
        let status = self.rag_settings.status.clone();
        let relevant = status
            .as_ref()
            .filter(|status| status.project_id == project_id);
        let enabled = relevant.is_some_and(|status| status.enabled);
        let busy = rag_is_busy(relevant);
        let progress = relevant
            .and_then(|status| status.init_progress.clone())
            .filter(|progress| progress.phase != "done");

        let build_id = project_id.clone();
        let build = CardButton::new(
            SharedString::from(format!("rag-build-{project_id}")),
            rag_build_label(relevant, &project_id),
        )
        .busy(busy)
        .render(*theme, cx, move |this, _window, cx| {
            this.rag_init(&build_id, cx);
        });

        let toggle_id = project_id.clone();
        let toggle = toggle_switch(
            SharedString::from(format!("rag-enable-{project_id}")),
            enabled,
            false,
            *theme,
            cx,
            move |this, _window, cx| {
                let next = !this
                    .rag_settings
                    .status
                    .as_ref()
                    .is_some_and(|status| status.enabled);
                this.rag_set_enabled(&toggle_id, next, cx);
            },
        );

        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.title"),
            vec![
                div()
                    .truncate()
                    .text_size(sp(11.0))
                    .text_color(theme.text_tertiary)
                    .child(SharedString::from(project_name))
                    .into_any_element(),
                card_pill(
                    theme,
                    rag_model_line(relevant, &project_id),
                    rag_model_pill_color(theme, relevant, &project_id),
                )
                .into_any_element(),
                build.into_any_element(),
            ],
        ));

        let mut body = card_body(theme).child(card_rows(
            theme,
            vec![
                CardRow::new(tr!("settings.rag.enable"))
                    .description(tr!("settings.rag.enable_hint"))
                    .control(toggle),
                CardRow::new(tr!("settings.rag.index")).control(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .when(
                            relevant.is_some_and(|status| status.plan_stale),
                            |row| {
                                row.child(card_pill(
                                    theme,
                                    tr!("settings.rag.stale_badge"),
                                    theme.warning,
                                ))
                            },
                        )
                        .child(
                            div()
                                .text_size(sp(12.5))
                                .text_color(theme.text_secondary)
                                .child(rag_index_line(relevant, &project_id)),
                        ),
                ),
            ],
        ));
        if let Some(progress) = progress {
            body = body.child(render_init_progress(&progress, theme));
        }
        if let Some(error) = self.rag_settings.status_error.clone() {
            body = body.child(
                div()
                    .pb(px(8.0))
                    .text_size(sp(11.0))
                    .text_color(theme.danger)
                    .child(SharedString::from(error)),
            );
        }
        card.child(body)
    }

    /// The page-level "Add Source" action (old Tide keeps it in the
    /// Knowledge page header).
    pub(super) fn rag_sources_add_button(
        &self,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        CardButton::new("rag-source-new", tr!("settings.rag.add_source"))
            .icon("icons/plus.svg")
            .render(theme, cx, |this, window, cx| {
                this.rag_settings.open_source_dialog(window, cx);
            })
            .into_any_element()
    }

    /// The knowledge-sources card: the list in a full-bleed body; the
    /// add action lives in the page header.
    pub(super) fn render_sources_card(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.sources_title"),
            Vec::new(),
        ));

        // Scope chips: global knowledge, or one project's. The list and the
        // add dialog both target the selected scope.
        let scope = self.rag_settings.scope;
        let mut scopes = div().flex().flex_wrap().gap(px(6.0)).child(
            div()
                .id("knowledge-scope-global")
                .tab_index(0)
                .focus_visible(|style| style.border_1().border_color(theme.accent))
                .h(px(26.0))
                .px(px(8.0))
                .rounded(px(8.0))
                .cursor_default()
                .flex()
                .items_center()
                .text_size(sp(12.5))
                .when(scope == KnowledgeScope::Global, |element| {
                    element
                        .bg(theme.sidebar_item_background)
                        .border_1()
                        .border_color(theme.accent)
                })
                .when(scope != KnowledgeScope::Global, |element| {
                    element.hover(|element| element.bg(theme.overlay))
                })
                .text_color(theme.text_secondary)
                .child(tr!("settings.rag.scope_global"))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.rag_settings.scope = KnowledgeScope::Global;
                    cx.notify();
                })),
        );
        for project in self
            .state
            .projects
            .iter()
            .filter(|project| !project.is_projectless())
        {
            let project_id = project.id;
            let selected = scope == KnowledgeScope::Project(project_id);
            scopes = scopes.child(
                div()
                    .id(SharedString::from(format!(
                        "knowledge-scope-{}",
                        project_id
                    )))
                    .tab_index(0)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .h(px(26.0))
                    .px(px(8.0))
                    .rounded(px(8.0))
                    .cursor_default()
                    .flex()
                    .items_center()
                    .text_size(sp(12.5))
                    .when(selected, |element| {
                        element
                            .bg(theme.sidebar_item_background)
                            .border_1()
                            .border_color(theme.accent)
                    })
                    .when(!selected, |element| {
                        element.hover(|element| element.bg(theme.overlay))
                    })
                    .text_color(theme.text_secondary)
                    .child(SharedString::from(project.name.clone()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.rag_settings.scope = KnowledgeScope::Project(project_id);
                        cx.notify();
                    })),
            );
        }

        let mut body =
            card_body_flush(theme).child(div().px(px(20.0)).pt(px(10.0)).pb(px(4.0)).child(scopes));
        let in_scope: Vec<_> = self
            .rag_settings
            .sources
            .iter()
            .filter(|source| self.rag_settings.source_in_scope(source, scope))
            .cloned()
            .collect();
        if in_scope.is_empty() {
            body = body.child(
                div()
                    .px(px(20.0))
                    .py(px(12.0))
                    .text_size(sp(11.0))
                    .text_color(theme.text_tertiary)
                    .child(tr!("settings.rag.sources_empty")),
            );
        }
        let pending = self.rag_settings.pending_source.clone();
        for (index, source) in in_scope.into_iter().enumerate() {
            // The live line under the name: phase detail while indexing
            // (upstream's LIVE_PHASES treatment), settled stats otherwise.
            let live = source.progress.as_ref().filter(|progress| {
                matches!(
                    progress.phase.as_str(),
                    "fetching" | "chunking" | "embedding"
                )
            });
            let detail = match live {
                Some(progress) => {
                    let phase = match progress.phase.as_str() {
                        "fetching" => tr!("settings.rag.phase_fetching"),
                        "chunking" => tr!("settings.rag.phase_chunking"),
                        _ => tr!("settings.rag.phase_embedding"),
                    };
                    match (progress.chunks_embedded, progress.chunks_total) {
                        (Some(embedded), Some(total)) if total > 0 => {
                            format!(
                                "{phase} · {embedded}/{total} {}",
                                tr!("settings.rag.chunks_suffix")
                            )
                        }
                        _ => progress
                            .current
                            .clone()
                            .unwrap_or_else(|| phase.to_string()),
                    }
                }
                None => format!(
                    "{} · {} · {} {}",
                    source.kind,
                    source.status,
                    source.chunk_count,
                    tr!("settings.rag.chunks_suffix")
                ),
            };
            let row_pending = pending.as_deref() == Some(source.id.as_str());
            let indexing = source.status == "queued" || source.status == "indexing";

            let reindex_id = source.id.clone();
            let reindex = CardButton::new(
                SharedString::from(format!("rag-reindex-{}", source.id)),
                tr!("settings.rag.reindex"),
            )
            .ghost()
            .busy(row_pending)
            .render(*theme, cx, move |this, _window, _cx| {
                this.rag_source_command(client::Command::SourcesReindex {
                    source_id: reindex_id.clone(),
                });
            });

            let remove_id = source.id.clone();
            let remove = CardButton::new(
                SharedString::from(format!("rag-remove-{}", source.id)),
                tr!("settings.rag.remove"),
            )
            .ghost()
            .disabled(row_pending)
            .render(*theme, cx, move |this, _window, _cx| {
                this.rag_source_command(client::Command::SourcesRemove {
                    source_id: remove_id.clone(),
                });
            });

            let row = div()
                .when(index > 0, |element| {
                    element.border_t_1().border_color(theme.border)
                })
                .px(px(20.0))
                .py(px(10.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(5.0))
                                .child(
                                    div()
                                        .text_size(sp(12.0))
                                        .text_color(theme.text)
                                        .truncate()
                                        .child(SharedString::from(source.name.clone())),
                                )
                                .children(indexing.then(|| {
                                    motion::spin(icon(
                                        "icons/loader-circle.svg",
                                        10.0,
                                        theme.text_tertiary,
                                    ))
                                })),
                        )
                        .child(
                            div()
                                .text_size(sp(10.5))
                                .text_color(if source.status == "error" {
                                    crate::app::timeline_v2::status_color(
                                        theme,
                                        crate::app::timeline_v2::Status::Error,
                                    )
                                } else {
                                    theme.text_tertiary
                                })
                                .truncate()
                                .child(SharedString::from(detail)),
                        ),
                )
                .child(reindex.into_any_element())
                .child(remove.into_any_element());
            body = body.child(row);
        }
        if let Some(error) = self.rag_settings.sources_error.clone() {
            body = body.child(
                div()
                    .px(px(20.0))
                    .py(px(10.0))
                    .text_size(sp(11.0))
                    .text_color(theme.danger)
                    .child(SharedString::from(error)),
            );
        }
        card.child(body)
    }
}

// ── the add-source dialog (upstream's SourceDialog) ────────────────────────

/// Per-kind metadata (upstream's KINDS): label, placeholder, hint.
const SOURCE_KINDS: [(&str, &str, &str, &str); 4] = [
    (
        "url",
        "settings.rag.kind_url",
        "https://example.com/page",
        "settings.rag.kind_url_hint",
    ),
    (
        "docs",
        "settings.rag.kind_docs",
        "/path/to/docs",
        "settings.rag.kind_docs_hint",
    ),
    (
        "crawl",
        "settings.rag.kind_crawl",
        "https://docs.example.com/",
        "settings.rag.kind_crawl_hint",
    ),
    (
        "repo",
        "settings.rag.kind_repo",
        "https://github.com/owner/repo",
        "settings.rag.kind_repo_hint",
    ),
];

impl Tide {
    /// The add-source dialog: Name + Kind (radio rows with hints) +
    /// Location with per-kind placeholder, inline validation, busy submit.
    /// Mounted from the settings overlay stack.
    pub(super) fn render_rag_source_dialog(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = Theme::current(cx);
        let draft = self.rag_settings.dialog.as_ref()?;
        let (name, kind, location, error, busy) = (
            draft.name.clone(),
            draft.kind,
            draft.location.clone(),
            draft.error.clone(),
            draft.busy,
        );
        let kind_meta = SOURCE_KINDS
            .iter()
            .find(|(value, _, _, _)| *value == kind)
            .unwrap_or(&SOURCE_KINDS[0]);

        let mut body = div().flex().flex_col().gap(px(10.0));
        // Name
        body = body.child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(
                    div()
                        .text_size(sp(11.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text)
                        .child(tr!("settings.rag.dialog_name")),
                )
                .child(name),
        );
        // Kind — radio rows with per-kind hints (kind is fixed upstream
        // after creation; this dialog is add-only).
        let mut kinds = div().flex().flex_col().gap(px(4.0)).child(
            div()
                .text_size(sp(11.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text)
                .child(tr!("settings.rag.dialog_kind")),
        );
        for (value, label_key, _placeholder, hint_key) in SOURCE_KINDS {
            let selected = value == kind;
            let mut row = div()
                .id(SharedString::from(format!("rag-kind-{value}")))
                .tab_index(0)
                .focus_visible(|style| style.border_color(theme.accent))
                .px(px(10.0))
                .py(px(6.0))
                .rounded(px(7.0))
                .border_1()
                .cursor_pointer()
                .flex()
                .items_center()
                .gap(px(8.0))
                .when(selected, |el| el.border_color(theme.accent).bg(theme.inset))
                .when(!selected, |el| el.border_color(theme.border));
            row = row.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_size(sp(12.0))
                            .text_color(if selected {
                                theme.text
                            } else {
                                theme.text_tertiary
                            })
                            .child(tr!(label_key)),
                    )
                    .child(
                        div()
                            .text_size(sp(10.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!(hint_key)),
                    ),
            );
            row = row.child(if selected {
                icon("icons/check.svg", 12.0, theme.accent).into_any_element()
            } else {
                div().into_any_element()
            });
            row = row.on_click({
                let weak = cx.entity().downgrade();
                let value = value;
                move |_, _window, cx| {
                    let _ = weak.update(cx, |tide: &mut Tide, cx| {
                        if let Some(draft) = tide.rag_settings.dialog.as_mut() {
                            draft.kind = value;
                        }
                        cx.notify();
                    });
                }
            });
            kinds = kinds.child(row);
        }
        body = body.child(kinds);
        // Location (per-kind hint below; docs adds a local file browser)
        let browse = (kind == "docs").then(|| {
            let weak = cx.entity().downgrade();
            div()
                .id("rag-location-browse")
                .rounded(px(5.0))
                .border_1()
                .border_color(theme.border)
                .px(px(8.0))
                .py(px(3.0))
                .text_size(sp(11.0))
                .cursor_pointer()
                .hover(|element| element.bg(theme.overlay))
                .text_color(theme.text_secondary)
                .child(tr!("settings.rag.dialog_browse"))
                .on_click({
                    move |_, _window, cx| {
                        let _ = weak.update(cx, |tide, cx| {
                            tide.rag_browse_local_source(cx);
                        });
                    }
                })
        });
        body = body.child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(sp(11.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text)
                                .child(tr!("settings.rag.dialog_location")),
                        )
                        .children(browse),
                )
                .child(location.clone())
                .child(
                    div()
                        .text_size(sp(10.5))
                        .text_color(theme.text_tertiary)
                        .child(tr!(kind_meta.3)),
                ),
        );
        if let Some(error) = error {
            body = body.child(
                div()
                    .text_size(sp(11.0))
                    .text_color(crate::app::timeline_v2::status_color(
                        &theme,
                        crate::app::timeline_v2::Status::Error,
                    ))
                    .child(SharedString::from(error)),
            );
        }
        // Footer: Cancel + Add (busy spinner while the first index runs —
        // upstream disables submit for exactly this window).
        let footer = div()
            .flex()
            .justify_end()
            .gap(px(8.0))
            .child(
                div()
                    .id("rag-dialog-cancel")
                    .tab_index(0)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .px(px(12.0))
                    .py(px(5.0))
                    .rounded(px(7.0))
                    .border_1()
                    .border_color(theme.border)
                    .text_size(sp(11.5))
                    .cursor_pointer()
                    .child(tr!("settings.rag.cancel"))
                    .on_click({
                        let weak = cx.entity().downgrade();
                        move |_, _window, cx| {
                            let _ = weak.update(cx, |tide, cx| {
                                tide.rag_settings.close_source_dialog(cx);
                            });
                        }
                    }),
            )
            .child(
                div()
                    .id("rag-dialog-submit")
                    .tab_index(0)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .px(px(12.0))
                    .py(px(5.0))
                    .rounded(px(7.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .text_size(sp(11.5))
                    .cursor_pointer()
                    .when(busy, |el| el.opacity(0.6))
                    .child(if busy {
                        motion::spin(icon("icons/loader-circle.svg", 11.0, theme.text_tertiary))
                            .into_any_element()
                    } else {
                        SharedString::from(tr!("settings.rag.add")).into_any_element()
                    })
                    .on_click({
                        let weak = cx.entity().downgrade();
                        move |_, _window, cx| {
                            let _ = weak.update(cx, |tide, cx| {
                                tide.rag_source_add(cx);
                            });
                        }
                    }),
            );
        let card = div()
            .id("rag-source-dialog")
            .occlude()
            .w(px(420.0))
            .rounded(px(13.0))
            .border_1()
            .border_color(theme.border_strong)
            .bg(theme.raised)
            .shadow_lg()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .p(px(18.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .text_size(sp(14.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(tr!("settings.rag.add_source")),
                    )
                    .child(
                        div()
                            .text_size(sp(11.0))
                            .text_color(theme.text_tertiary)
                            .child(tr!("settings.rag.dialog_description")),
                    )
                    .child({
                        let target = match self.rag_settings.scope {
                            KnowledgeScope::Global => {
                                tr!("settings.rag.scope_global")
                            }
                            KnowledgeScope::Project(project_id) => self
                                .state
                                .projects
                                .iter()
                                .find(|project| project.id == project_id)
                                .map(|project| project.name.clone())
                                .unwrap_or_default(),
                        };
                        div()
                            .text_size(sp(11.0))
                            .text_color(theme.text_secondary)
                            .child(tr!("settings.rag.scope_target", target = target))
                    }),
            )
            .child(body)
            .child(footer);
        Some(crate::ui::modal::deferred_scrim(
            "rag-source-layer",
            card,
            &theme,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(project_id: &str, model_download: &str, init_state: &str) -> client::RagStatusWire {
        client::RagStatusWire {
            project_id: project_id.into(),
            enabled: true,
            local_model_available: model_download == "ready",
            cloud_configured: false,
            model_download: model_download.into(),
            model_download_error: None,
            chunk_count: 12,
            last_ingested_at: None,
            init_state: init_state.into(),
            embedder_id: "local".into(),
            plan_stale: false,
            init_progress: None,
        }
    }

    const PROJECT: &str = "p-1";

    #[test]
    fn model_line_covers_every_download_state() {
        let ready = wire(PROJECT, "ready", "never");
        assert_eq!(
            rag_model_line(Some(&ready), PROJECT),
            tr!("settings.rag.model_ready").to_string()
        );
        let downloading = wire(PROJECT, "downloading", "never");
        assert_eq!(
            rag_model_line(Some(&downloading), PROJECT),
            tr!("settings.rag.model_downloading").to_string()
        );
        let missing = wire(PROJECT, "not-downloaded", "never");
        assert_eq!(
            rag_model_line(Some(&missing), PROJECT),
            tr!("settings.rag.model_missing").to_string()
        );
    }

    #[test]
    fn failed_model_line_carries_the_error_exactly_once() {
        let mut failed = wire(PROJECT, "failed", "never");
        failed.model_download_error = Some("disk full".into());
        let line = rag_model_line(Some(&failed), PROJECT);
        assert!(line.contains("disk full"));
        assert_eq!(line.matches("disk full").count(), 1);
    }

    #[test]
    fn status_for_another_project_reads_as_defaults() {
        let ready = wire("other", "ready", "done");
        assert_eq!(
            rag_model_line(Some(&ready), PROJECT),
            tr!("settings.rag.model_missing").to_string()
        );
        assert_eq!(
            rag_index_line(Some(&ready), PROJECT),
            tr!("settings.rag.not_indexed").to_string()
        );
        assert_eq!(
            rag_build_label(Some(&ready), PROJECT),
            tr!("settings.rag.build")
        );
        assert_eq!(
            rag_model_line(None, PROJECT),
            tr!("settings.rag.model_missing")
        );
    }

    #[test]
    fn index_line_counts_chunks_when_done() {
        let done = wire(PROJECT, "ready", "done");
        let line = rag_index_line(Some(&done), PROJECT);
        assert!(line.contains("12"), "{line}");
        assert!(!line.contains("never"), "{line}");

        let running = wire(PROJECT, "ready", "running");
        assert_eq!(
            rag_index_line(Some(&running), PROJECT),
            tr!("settings.rag.indexing").to_string()
        );
    }

    #[test]
    fn build_label_picks_indexing_rebuild_build() {
        let running = wire(PROJECT, "downloading", "never");
        assert_eq!(
            rag_build_label(Some(&running), PROJECT),
            tr!("settings.rag.indexing")
        );
        let indexing = wire(PROJECT, "ready", "running");
        assert_eq!(
            rag_build_label(Some(&indexing), PROJECT),
            tr!("settings.rag.indexing")
        );
        let done = wire(PROJECT, "ready", "done");
        assert_eq!(
            rag_build_label(Some(&done), PROJECT),
            tr!("settings.rag.rebuild")
        );
        assert_eq!(
            rag_build_label(Some(&wire(PROJECT, "ready", "never")), PROJECT),
            tr!("settings.rag.build")
        );
    }

    fn model(id: &str, name: &str, dims: usize, langs: &str, state: &str, vendored: bool) -> client::RagModelWire {
        client::RagModelWire {
            id: id.into(),
            name: name.into(),
            dims,
            max_tokens: 512,
            languages: langs.into(),
            vendored,
            downloaded: state == "ready",
            download_size: 1000,
            download_state: state.into(),
            download_error: None,
        }
    }

    #[test]
    fn model_sub_label_carries_dims_language_and_state() {
        let m = model(
            "local-code-512",
            "isuruwijesiri/all-MiniLM-L6-v2-code-search-512",
            384,
            "en",
            "ready",
            true,
        );
        let label = rag_model_sub_label(&m);
        assert!(label.contains("384 dim"), "was {label}");
        assert!(label.contains("512"), "was {label}");
        assert!(label.contains(&tr!("settings.rag.lang_english")), "was {label}");
        assert!(label.contains(&tr!("settings.rag.state_downloaded")), "was {label}");

        let m = model("local-mle5-small", "Xenova/multilingual-e5-small", 384, "multilingual", "not-downloaded", false);
        let label = rag_model_sub_label(&m);
        assert!(label.contains(&tr!("settings.rag.lang_multilingual")), "was {label}");
        assert!(label.contains(&tr!("settings.rag.state_not_downloaded")), "was {label}");
    }

    #[test]
    fn selection_label_prefers_original_repo_names() {
        let models = vec![
            model("local-code-512", "isuruwijesiri/all-MiniLM-L6-v2-code-search-512", 384, "en", "ready", true),
            model("local-bge-m3", "Xenova/bge-m3", 1024, "multilingual", "ready", false),
        ];
        let config = client::RagConfigWire {
            embedder_id: "local-bge-m3".into(),
            ..Default::default()
        };
        assert_eq!(
            rag_selection_label(Some(&config), &models, &[]),
            "Xenova/bge-m3"
        );
        let config = client::RagConfigWire {
            embedder_id: "cloud-base".into(),
            ..Default::default()
        };
        assert_eq!(
            rag_selection_label(Some(&config), &models, &[]),
            tr!("settings.rag.cloud_embedder")
        );
        assert_eq!(rag_selection_label(None, &models, &[]), tr!("settings.rag.loading"));
    }

    #[test]
    fn endpoint_validation_requires_every_field() {
        assert!(rag_endpoint_validate("", "https://x", "m", "k").is_some());
        assert!(rag_endpoint_validate("n", "", "m", "k").is_some());
        assert!(rag_endpoint_validate("n", "ftp://x", "m", "k").is_some());
        assert!(rag_endpoint_validate("n", "https://x", "", "k").is_some());
        assert!(rag_endpoint_validate("n", "https://x", "m", "").is_some());
        assert!(rag_endpoint_validate("n", "http://localhost:11434/v1", "m", "ollama").is_none());
    }

    #[test]
    fn affected_label_marks_the_knowledge_index() {
        let label = rag_affected_label("*", &[]);
        assert_eq!(label, tr!("settings.rag.global_knowledge"));
        assert_eq!(rag_affected_label("raw-id", &[]), "raw-id");
    }
}
