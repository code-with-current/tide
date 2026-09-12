//! The Memory & RAG settings panel — the per-project enable/status/build
//! card and the knowledge-sources card on the Knowledge settings page.
//! State flows exactly like the git-settings panel: actions dispatch on a
//! spawned thread, replies land in [`RagOpsEvent`] through the shared
//! event pump, and transient states (model download, ingestion, indexing)
//! keep a 2 s self-sustaining poll alive.

use gpui::prelude::*;
use gpui::{
    AnyElement, App, Context, Div, Entity, FontWeight, MouseButton, PathPromptOptions,
    SharedString, Stateful, Window, div, px,
};
use std::path::PathBuf;
use uuid::Uuid;

use crate::app::{Tide, signal_event_pump};
use crate::model::Project;
use crate::theme::{Theme, sp};
use crate::ui::card::{
    CardButton, CardRow, card_body, card_body_flush, card_pill, card_rows, settings_group_head,
};
use crate::ui::{
    MenuChip, icon,
    menu::{MenuAlign, MenuItem, dropdown_menu},
    motion, toggle_switch,
};
use crossbeam_channel::{Receiver, Sender, unbounded};

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
    /// The Knowledge Library card's ensure reply (source id, doc count,
    /// daemon-side root).
    Library(Result<LibraryState, String>),
    /// The `/kb-*` copy-to-folder action finished (count or error).
    KbInstall(Result<u32, String>),
    /// One serial rebuild step finished — pop the next from the queue.
    RebuildStep,
    /// The 2 s rebuild heartbeat: stall watchdog plus a status refresh
    /// for the in-flight step's project (keeps the phase label live).
    RebuildTick,
}

/// The RagConfigGet payload.
pub(crate) struct RagConfigBundle {
    pub config: client::RagConfigWire,
    pub endpoints: Vec<client::RagEndpointWire>,
    pub cloud_configured: bool,
}

/// The LibraryEnsure payload: which source row is the library, how many
/// docs its registry holds, and where the root lives on the daemon's
/// disk (rendered verbatim — a remote daemon's path is not ours).
#[derive(Clone)]
pub(crate) struct LibraryState {
    pub source_id: String,
    pub doc_count: u32,
    pub root: PathBuf,
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
    /// The model a Download/Delete/Retry command is flying for — its
    /// buttons spin until the Models reply lands.
    pub pending_model: std::cell::RefCell<Option<String>>,
    /// The endpoint a Remove command is flying for.
    pub pending_endpoint: std::cell::RefCell<Option<String>>,
    /// A settings patch is in flight (picker choice, stepper, inline
    /// commit) — the global card head shows a saving pill.
    pub config_pending: std::cell::Cell<bool>,
    /// True once the first Sources reply lands — separates "loading"
    /// from a genuinely empty registry.
    pub sources_loaded: std::cell::Cell<bool>,
    /// The enable-toggle flip in flight: (project id, target state) —
    /// the toggle paints the target optimistically until Status replies.
    pub pending_toggle: Option<(String, bool)>,
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
    /// The embedding-model dialog's staged selection — the dialog is
    /// open while set.
    pub model_dialog: Option<String>,
    /// The retrieval card's chunking disclosure (progressive disclosure —
    /// rarely-touched settings stay collapsed).
    pub advanced_open: std::cell::Cell<bool>,
    /// The next config update chains straight into a rebuild (Select &
    /// Rebuild) — the offer dialog is gone.
    pub rebuild_after_update: std::cell::Cell<bool>,
    /// The add-endpoint dialog, when open.
    pub endpoint_dialog: Option<EndpointDialogDraft>,
    /// The rebuild-offer dialog after a settings change or delete.
    pub rebuild: Option<RebuildState>,
    /// Knowledge Library card state (the LibraryEnsure reply); `None`
    /// until the first ensure lands or errors.
    pub library: Option<LibraryState>,
    pub library_error: Option<String>,
    /// Guards the on-open ensure call until the first reply (render
    /// paths take `&self`, same discipline as `config_requested`).
    pub library_requested: std::cell::Cell<bool>,
    /// The `/kb` install button is in flight.
    pub kb_pending: std::cell::Cell<bool>,
    /// Armed by a reindex of the library row; the next Sources reply
    /// that observes the row settled refreshes the card's doc count
    /// once, then disarms.
    pub library_reindexing: std::cell::Cell<bool>,
    /// Last install outcome for the row's hint line ("4 installed",
    /// "Already installed", or the error verbatim).
    pub kb_note: Option<String>,
    /// Inline numeric/text fields for the retrieval + advanced cards,
    /// created on first render (they need a window) once config loads.
    pub inline: std::cell::RefCell<Option<RagInlineInputs>>,
}

/// The three inline-edited settings fields, as TextInput entities.
pub(crate) struct RagInlineInputs {
    pub min_similarity: Entity<crate::input::TextInput>,
    pub chunk_size: Entity<crate::input::TextInput>,
    pub chunk_overlap: Entity<crate::input::TextInput>,
    pub inline_knowledge: Entity<crate::input::TextInput>,
}

/// The rebuild dialog: what a change left behind, and the serial queue
/// once Rebuild starts. Knowledge sources reindex only after the project
/// queue drains — concurrently they contend for the daemon's serial RAG
/// machinery and stall both (the "stuck at walking" bug).
pub(crate) struct RebuildState {
    pub affected: Vec<client::RagAffectedWorkspaceWire>,
    /// Remaining project ids to re-init, front first.
    pub queue: Vec<String>,
    /// Queue length at start — the progress bar's denominator.
    pub total: usize,
    pub running: bool,
    /// The project whose init is in flight — the heartbeat polls it.
    pub current: Option<String>,
    /// Knowledge sources still awaiting their reindex (fired at finish).
    pub knowledge_pending: bool,
    /// When the in-flight step was dispatched — the stall watchdog.
    pub step_started: Option<std::time::Instant>,
    /// A step stopped replying — Retry continues the remaining queue.
    pub stalled: bool,
}

/// How long one rebuild step may run without replying before the strip
/// flags a stall. Generous on purpose: big repos embed for minutes, a
/// deadlock never replies at all.
const RAG_REBUILD_STEP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

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

/// The add dialog's editable state. Text entities are created when the
/// dialog opens (they need a window, only click handlers have one).
pub(crate) struct SourceDialogDraft {
    pub name: Entity<crate::input::TextInput>,
    pub kind: &'static str,
    pub location: Entity<crate::input::TextInput>,
    /// Where the source lands: `None` = global knowledge, else a project
    /// id — chosen in the dialog, independent of the card's scope chips.
    pub project: Option<String>,
    pub error: Option<String>,
    pub busy: bool,
}

impl RagSettingsPanel {
    pub(crate) fn new(_cx: &mut App) -> Self {
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
            pending_model: std::cell::RefCell::new(None),
            pending_endpoint: std::cell::RefCell::new(None),
            config_pending: std::cell::Cell::new(false),
            sources_loaded: std::cell::Cell::new(false),
            pending_toggle: None,
            config: None,
            endpoints: Vec::new(),
            cloud_configured: false,
            config_error: None,
            config_requested: std::cell::Cell::new(false),
            models: Vec::new(),
            model_dialog: None,
            advanced_open: std::cell::Cell::new(false),
            rebuild_after_update: std::cell::Cell::new(false),
            endpoint_dialog: None,
            rebuild: None,
            library: None,
            library_error: None,
            library_requested: std::cell::Cell::new(false),
            kb_pending: std::cell::Cell::new(false),
            library_reindexing: std::cell::Cell::new(false),
            kb_note: None,
            inline: std::cell::RefCell::new(None),
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
        let project = None; // the dialog's own selector decides the target
        self.dialog = Some(SourceDialogDraft {
            name,
            kind: "url",
            location,
            project,
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
}

impl RagSettingsPanel {
    /// The inline settings fields, creating + subscribing them on first
    /// use (render has a window; the drain does not). `None` while the
    /// config bundle hasn't landed — the fields seed from it, so creating
    /// them earlier would cache empty seeds.
    fn inline_inputs(
        &self,
        window: &mut Window,
        cx: &mut Context<Tide>,
    ) -> Option<RagInlineInputs> {
        if let Some(inline) = self.inline.borrow().as_ref() {
            return Some(RagInlineInputs {
                min_similarity: inline.min_similarity.clone(),
                chunk_size: inline.chunk_size.clone(),
                chunk_overlap: inline.chunk_overlap.clone(),
                inline_knowledge: inline.inline_knowledge.clone(),
            });
        }
        let config = self.config.as_ref()?;
        let seed = |v: Option<String>| v.unwrap_or_default();
        let mut make = |placeholder: &str, value: String, cx: &mut Context<Tide>| {
            let input = cx.new(|cx| {
                let mut input = crate::input::TextInput::new(window, cx)
                    .clear_on_escape()
                    .submit_on_enter()
                    .placeholder(placeholder);
                let len = input.content().len();
                input.replace_range(0..len, &value, cx);
                input
            });
            input
        };
        let min_similarity = make(
            "0.2",
            seed(config.min_similarity.map(|v| format!("{v}"))),
            cx,
        );
        let chunk_size = make("1024", seed(config.chunk_size.map(|v| format!("{v}"))), cx);
        let chunk_overlap = make(
            "128",
            seed(config.chunk_overlap.map(|v| format!("{v}"))),
            cx,
        );
        let inline_knowledge = make(
            "12000",
            seed(Some(config.inline_knowledge_chars.to_string())),
            cx,
        );
        let inline = RagInlineInputs {
            min_similarity,
            chunk_size,
            chunk_overlap,
            inline_knowledge,
        };
        // Commit on Enter/submit: parse, patch, and reseed on failure.
        {
            let field = inline.min_similarity.clone();
            cx.subscribe(&field, |this, _entity, event, cx| {
                if let crate::input::InputEvent::Submit(content) = event {
                    this.rag_inline_submit(InlineField::MinSimilarity, content.clone(), cx);
                }
            })
            .detach();
        }
        {
            let field = inline.chunk_size.clone();
            cx.subscribe(&field, |this, _entity, event, cx| {
                if let crate::input::InputEvent::Submit(content) = event {
                    this.rag_inline_submit(InlineField::ChunkSize, content.clone(), cx);
                }
            })
            .detach();
        }
        {
            let field = inline.chunk_overlap.clone();
            cx.subscribe(&field, |this, _entity, event, cx| {
                if let crate::input::InputEvent::Submit(content) = event {
                    this.rag_inline_submit(InlineField::ChunkOverlap, content.clone(), cx);
                }
            })
            .detach();
        }
        {
            let field = inline.inline_knowledge.clone();
            cx.subscribe(&field, |this, _entity, event, cx| {
                if let crate::input::InputEvent::Submit(content) = event {
                    this.rag_inline_submit(InlineField::InlineKnowledge, content.clone(), cx);
                }
            })
            .detach();
        }
        *self.inline.borrow_mut() = Some(RagInlineInputs {
            min_similarity: inline.min_similarity.clone(),
            chunk_size: inline.chunk_size.clone(),
            chunk_overlap: inline.chunk_overlap.clone(),
            inline_knowledge: inline.inline_knowledge.clone(),
        });
        Some(inline)
    }
}

/// The one-row placeholder while the config bundle is still loading —
/// shared by the retrieval and advanced cards.
fn rag_loading_row(theme: &Theme) -> Vec<CardRow> {
    vec![
        CardRow::new(tr!("settings.rag.loading")).control(motion::spin(icon(
            "icons/loader-circle.svg",
            11.0,
            theme.text_tertiary,
        ))),
    ]
}

/// Which inline settings field submitted.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum InlineField {
    MinSimilarity,
    ChunkSize,
    ChunkOverlap,
    InlineKnowledge,
}

// ── dispatch + actions ─────────────────────────────────────────────────────

impl Tide {
    /// Browse for a local docs file or folder and drop the chosen path into
    /// the add dialog's location field.
    pub(in crate::app) fn rag_browse_local_source(&mut self, cx: &mut Context<Self>) {
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
    pub(in crate::app) fn rag_dispatch(
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
    pub(in crate::app) fn rag_dispatch_result(
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
    pub(in crate::app) fn rag_config_load(&self) {
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
                Ok(client::ResponsePayload::RagModels { models }) => {
                    RagOpsEvent::Models(Ok(models))
                }
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
    pub(in crate::app) fn rag_config_update(&self, patch: client::RagConfigPatchWire) {
        self.rag_settings.config_pending.set(true);
        self.rag_dispatch_result(
            |result| match result {
                Ok(client::ResponsePayload::RagAffected { workspaces }) => {
                    RagOpsEvent::Affected(workspaces)
                }
                Ok(client::ResponsePayload::Ack) => RagOpsEvent::Affected(Vec::new()),
                Err(error) => RagOpsEvent::Config(Err(error)),
                Ok(_) => RagOpsEvent::Config(Err("unexpected response".into())),
            },
            client::Command::RagConfigUpdate { patch },
        );
        self.rag_config_load();
    }

    /// Download / delete a catalog model (delete reports affected indexes
    /// through the rebuild dialog).
    pub(in crate::app) fn rag_model_command(&self, command: client::Command) {
        if let client::Command::RagModelDownload { model_id }
        | client::Command::RagModelDelete { model_id } = &command
        {
            *self.rag_settings.pending_model.borrow_mut() = Some(model_id.clone());
        }
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
                Ok(client::ResponsePayload::RagModels { models }) => {
                    RagOpsEvent::Models(Ok(models))
                }
                Err(error) => RagOpsEvent::Models(Err(error)),
                Ok(_) => RagOpsEvent::Models(Err("unexpected response".into())),
            },
            client::Command::RagModelsList,
        );
    }

    /// Custom-endpoint commands. Add keeps the dialog open with the error
    /// inline when the probe fails.
    pub(in crate::app) fn rag_endpoint_command(&self, command: client::Command) {
        if let client::Command::RagEndpointRemove { endpoint_id } = &command {
            *self.rag_settings.pending_endpoint.borrow_mut() = Some(endpoint_id.clone());
        }
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

    /// Rebuild: re-init each affected project serially. Knowledge sources
    /// reindex at [`Self::rag_rebuild_finish`], not here.
    pub(in crate::app) fn rag_rebuild_start(&mut self, cx: &mut Context<Self>) {
        let Some(rebuild) = self.rag_settings.rebuild.as_mut() else {
            return;
        };
        rebuild.running = true;
        rebuild.stalled = false;
        rebuild.queue = rebuild
            .affected
            .iter()
            .filter(|a| a.project_id != "*")
            .map(|a| a.project_id.clone())
            .collect();
        rebuild.total = rebuild.queue.len();
        rebuild.knowledge_pending = !self.rag_settings.sources.is_empty();
        self.rag_poll_rebuild();
        self.rag_rebuild_next(cx);
        cx.notify();
    }

    /// Continue a stalled rebuild from the front of its remaining queue.
    pub(in crate::app) fn rag_rebuild_retry(&mut self, cx: &mut Context<Self>) {
        let Some(rebuild) = self.rag_settings.rebuild.as_mut() else {
            return;
        };
        if !rebuild.stalled {
            return;
        }
        rebuild.stalled = false;
        rebuild.running = true;
        self.rag_poll_rebuild();
        self.rag_rebuild_next(cx);
    }

    /// The queue drained: fire the knowledge reindexes (only now — the
    /// serial manager would contend with project inits), then clear.
    fn rag_rebuild_finish(&mut self, cx: &mut Context<Self>) {
        let knowledge = self
            .rag_settings
            .rebuild
            .as_ref()
            .is_some_and(|rebuild| rebuild.knowledge_pending);
        if knowledge {
            if let Some(rebuild) = self.rag_settings.rebuild.as_mut() {
                rebuild.knowledge_pending = false;
            }
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
            self.rag_poll_sources();
        }
        self.rag_settings.rebuild = None;
        cx.notify();
    }

    /// Pop the next serial rebuild step (finish when the queue empties).
    fn rag_rebuild_next(&mut self, cx: &mut Context<Self>) {
        let next = self
            .rag_settings
            .rebuild
            .as_mut()
            .filter(|rebuild| rebuild.running && !rebuild.stalled)
            .and_then(|rebuild| rebuild.queue.first().cloned());
        if let Some(project_id) = next {
            let rebuild = self.rag_settings.rebuild.as_mut().expect("checked");
            rebuild.queue.remove(0);
            rebuild.current = Some(project_id.clone());
            rebuild.step_started = Some(std::time::Instant::now());
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
        } else if self
            .rag_settings
            .rebuild
            .as_ref()
            .is_some_and(|rebuild| rebuild.running && !rebuild.stalled && rebuild.queue.is_empty())
        {
            self.rag_rebuild_finish(cx);
        }
        cx.notify();
    }

    /// Load status + sources for a project.
    pub(in crate::app) fn rag_refresh(&self, project_id: &str) {
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
    pub(in crate::app) fn rag_set_enabled(
        &mut self,
        project_id: &str,
        enabled: bool,
        cx: &mut Context<Self>,
    ) {
        self.rag_settings.pending_toggle = Some((project_id.to_owned(), enabled));
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
    pub(in crate::app) fn rag_init(&self, project_id: &str, cx: &mut Context<Self>) {
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
    pub(in crate::app) fn rag_source_add(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.rag_settings.dialog.as_ref() else {
            return;
        };
        let name = dialog.name.read(cx).content().trim().to_owned();
        let location = dialog.location.read(cx).content().trim().to_owned();
        let kind = dialog.kind;
        let project_id = dialog.project.clone();
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
    pub(in crate::app) fn rag_endpoint_add(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.rag_settings.endpoint_dialog.as_ref() else {
            return;
        };
        let name = dialog.name.read(cx).content().trim().to_owned();
        let base_url = dialog.base_url.read(cx).content().trim().to_owned();
        let model_id = dialog.model_id.read(cx).content().trim().to_owned();
        let api_key = dialog.api_key.read(cx).content().trim().to_owned();
        let error = rag_endpoint_validate(&name, &base_url, &model_id, &api_key);
        if let Some(error) = error {
            self.rag_settings
                .endpoint_dialog
                .as_mut()
                .expect("checked")
                .error = Some(error);
            cx.notify();
            return;
        }
        self.rag_settings
            .endpoint_dialog
            .as_mut()
            .expect("checked")
            .busy = true;
        self.rag_endpoint_command(client::Command::RagEndpointAdd {
            name,
            base_url,
            model_id,
            api_key,
            max_tokens: None,
        });
        cx.notify();
    }

    /// One inline field submitted (Enter): parse, patch, and surface a
    /// toast on a bad value. Empty chunk fields clear the override.
    pub(in crate::app) fn rag_inline_submit(
        &mut self,
        field: InlineField,
        raw: String,
        cx: &mut Context<Self>,
    ) {
        let raw = raw.trim().to_owned();
        let patch = match field {
            InlineField::MinSimilarity => {
                if raw.is_empty() {
                    // No clear semantics for the floor yet — ignore.
                    return;
                }
                match raw.parse::<f64>() {
                    Ok(value) if (-1.0..=1.0).contains(&value) => client::RagConfigPatchWire {
                        min_similarity: Some(value),
                        ..Default::default()
                    },
                    _ => {
                        self.show_toast(tr!("settings.rag.error_number_required"));
                        return;
                    }
                }
            }
            InlineField::InlineKnowledge => {
                let raw = if raw.is_empty() { "0".to_owned() } else { raw };
                match raw.parse::<u64>() {
                    Ok(value) if value <= 65_536 => client::RagConfigPatchWire {
                        inline_knowledge_chars: Some(value),
                        ..Default::default()
                    },
                    _ => {
                        self.show_toast(tr!("settings.rag.error_number_required"));
                        return;
                    }
                }
            }
            InlineField::ChunkSize | InlineField::ChunkOverlap => {
                let raw = if raw.is_empty() { "0".to_owned() } else { raw };
                match raw.parse::<u64>() {
                    Ok(value) if field == InlineField::ChunkSize => client::RagConfigPatchWire {
                        chunk_size: Some(value),
                        ..Default::default()
                    },
                    Ok(value) => client::RagConfigPatchWire {
                        chunk_overlap: Some(value),
                        ..Default::default()
                    },
                    Err(_) => {
                        self.show_toast(tr!("settings.rag.error_number_required"));
                        return;
                    }
                }
            }
        };
        self.rag_config_update(patch);
        cx.notify();
    }

    /// Adjust top-K from the stepper (clamped by the daemon too).
    pub(in crate::app) fn rag_topk_bump(&self, delta: i64) {
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
    pub(in crate::app) fn rag_source_command(&mut self, command: client::Command) {
        if let client::Command::SourcesReindex { source_id }
        | client::Command::SourcesRemove { source_id } = &command
        {
            self.rag_settings.pending_source = Some(source_id.clone());
        }
        // The doc-count refresh latch: armed only by a reindex of the
        // library row itself. Remove must never arm it — its Sources
        // reply would otherwise trigger the ensure that resurrects the
        // row (and removal is refused server-side regardless).
        if let client::Command::SourcesReindex { source_id } = &command
            && self
                .rag_settings
                .library
                .as_ref()
                .is_some_and(|state| state.source_id == *source_id)
        {
            self.rag_settings.library_reindexing.set(true);
        }
        self.rag_dispatch(
            move |payload| match payload {
                client::ResponsePayload::Sources { sources } => RagOpsEvent::Sources(Ok(sources)),
                _ => RagOpsEvent::Sources(Err("unexpected response".into())),
            },
            command,
        );
    }

    /// Ensure the Knowledge Library source row + directory exist and
    /// fetch the card state (idempotent backend; the card calls it on
    /// first render so the row exists before anything is clicked).
    pub(in crate::app) fn rag_library_ensure(&self) {
        self.rag_dispatch_result(
            |result| match result {
                Ok(client::ResponsePayload::Library {
                    source_id,
                    doc_count,
                    root,
                }) => RagOpsEvent::Library(Ok(LibraryState {
                    source_id,
                    doc_count,
                    root,
                })),
                Err(error) => RagOpsEvent::Library(Err(error)),
                Ok(_) => RagOpsEvent::Library(Err("unexpected response".into())),
            },
            client::Command::LibraryEnsure,
        );
    }

    /// Copy the built-in `/kb-*` bodies into the commands folder as
    /// editable overrides (idempotent; 0 means copies already exist —
    /// the commands work either way, built-ins need no files).
    pub(in crate::app) fn rag_kb_install(&self) {
        self.rag_settings.kb_pending.set(true);
        self.rag_dispatch_result(
            |result| match result {
                Ok(client::ResponsePayload::KbCommands { installed }) => {
                    RagOpsEvent::KbInstall(Ok(installed))
                }
                Err(error) => RagOpsEvent::KbInstall(Err(error)),
                Ok(_) => RagOpsEvent::KbInstall(Err("unexpected response".into())),
            },
            client::Command::KnowledgeInstallCommands,
        );
    }

    /// Drain ops events; keeps a 2 s poll alive while anything transient is
    /// in flight (download, ingestion, indexing, queued).
    pub(in crate::app) fn drain_rag_ops_events(&mut self, cx: &mut Context<Self>) -> bool {
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
                        if self
                            .rag_settings
                            .pending_toggle
                            .as_ref()
                            .is_some_and(|(pending, _)| pending == &id)
                        {
                            self.rag_settings.pending_toggle = None;
                        }
                        self.rag_settings.status = Some(status);
                        self.rag_settings.status_error = None;
                        if transient && self.state.selected_project.is_some() {
                            self.rag_poll_again(&id);
                        }
                    }
                    Err(error) => {
                        self.rag_settings.pending_toggle = None;
                        self.rag_settings.status_error = Some(error);
                    }
                },
                RagOpsEvent::Sources(result) => match result {
                    Ok(sources) => {
                        let transient = sources
                            .iter()
                            .any(|source| source.status == "queued" || source.status == "indexing");
                        // The library card's doc count refreshes when its
                        // reindex settles: the latch was armed by the
                        // reindex click and this reply observes the row
                        // non-transient. A row that vanished (removed
                        // out-of-band) disarms the latch without a
                        // refresh — the ensure must not resurrect it.
                        let library_row = self.rag_settings.library.as_ref().and_then(|state| {
                            sources
                                .iter()
                                .find(|source| source.id == state.source_id)
                                .map(|source| source.status.as_str())
                        });
                        let refresh_library = library_refresh_after_sources(
                            self.rag_settings.library_reindexing.get(),
                            library_row,
                        );
                        if refresh_library
                            || (self.rag_settings.library_reindexing.get() && library_row.is_none())
                        {
                            self.rag_settings.library_reindexing.set(false);
                        }
                        if refresh_library {
                            self.rag_library_ensure();
                        }
                        self.rag_settings.sources = sources;
                        self.rag_settings.sources_error = None;
                        self.rag_settings.pending_source = None;
                        self.rag_settings.sources_loaded.set(true);
                        if let Some(dialog) = self.rag_settings.dialog.as_mut()
                            && dialog.busy
                        {
                            self.rag_settings.dialog = None;
                        }
                        if refresh_library {
                            self.rag_library_ensure();
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
                        self.rag_settings.config_pending.set(false);
                        self.rag_settings.config_requested.set(false);
                        *self.rag_settings.pending_endpoint.borrow_mut() = None;
                    }
                    Err(error) => {
                        self.rag_settings.config_error = Some(error);
                        self.rag_settings.config_requested.set(false);
                        self.rag_settings.config_pending.set(false);
                        *self.rag_settings.pending_endpoint.borrow_mut() = None;
                    }
                },
                RagOpsEvent::Models(result) => match result {
                    Ok(models) => {
                        let transient = models
                            .iter()
                            .any(|model| model.download_state == "downloading");
                        self.rag_settings.models = models;
                        *self.rag_settings.pending_model.borrow_mut() = None;
                        if transient {
                            self.rag_poll_models();
                        }
                    }
                    Err(error) => {
                        self.rag_settings.config_error = Some(error);
                        *self.rag_settings.pending_model.borrow_mut() = None;
                    }
                },
                RagOpsEvent::Affected(workspaces) => {
                    // No offer dialog anymore: Select & Rebuild chains the
                    // update straight into the serial rebuild (progress
                    // below the cards); a plain Select just leaves the
                    // stale badges on the project cards.
                    if self.rag_settings.rebuild_after_update.replace(false)
                        && !workspaces.is_empty()
                    {
                        self.rag_settings.rebuild = Some(RebuildState {
                            affected: workspaces,
                            queue: Vec::new(),
                            total: 0,
                            running: false,
                            current: None,
                            knowledge_pending: false,
                            step_started: None,
                            stalled: false,
                        });
                        self.rag_rebuild_start(cx);
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
                RagOpsEvent::Library(result) => match result {
                    Ok(state) => {
                        self.rag_settings.library = Some(state);
                        self.rag_settings.library_error = None;
                    }
                    // Clearing the guard lets the next render retry the
                    // ensure instead of stranding the card unloaded.
                    Err(error) => {
                        self.rag_settings.library_error = Some(error);
                        self.rag_settings.library_requested.set(false);
                    }
                },
                RagOpsEvent::KbInstall(result) => {
                    self.rag_settings.kb_pending.set(false);
                    self.rag_settings.kb_note = Some(match result {
                        Ok(installed) => kb_install_note(installed),
                        Err(error) => error,
                    });
                }
                RagOpsEvent::RebuildStep => {
                    let done = self
                        .rag_settings
                        .rebuild
                        .as_ref()
                        .is_some_and(|rebuild| rebuild.running && rebuild.queue.is_empty());
                    if done {
                        self.rag_rebuild_finish(cx);
                    } else {
                        self.rag_rebuild_next(cx);
                    }
                }
                RagOpsEvent::RebuildTick => {
                    let Some(rebuild) = self.rag_settings.rebuild.as_ref() else {
                        continue;
                    };
                    if !rebuild.running || rebuild.stalled {
                        continue;
                    }
                    // Watchdog: a step that never replies would stall the
                    // queue (and the phase label) forever.
                    let timed_out = rebuild
                        .step_started
                        .is_some_and(|started| started.elapsed() > RAG_REBUILD_STEP_TIMEOUT);
                    if timed_out {
                        let rebuild = self.rag_settings.rebuild.as_mut().expect("checked");
                        rebuild.stalled = true;
                        rebuild.running = false;
                    } else {
                        if let Some(project) = rebuild.current.as_deref() {
                            self.rag_poll_again(project);
                        }
                        self.rag_poll_rebuild();
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
                let outcome = match daemon.request(
                    Uuid::nil(),
                    Uuid::nil(),
                    client::Command::RagModelsList,
                ) {
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

    /// The rebuild's 2 s heartbeat — re-armed by the drain while a step
    /// is in flight; it drives the watchdog and the in-flight project's
    /// status refresh.
    fn rag_poll_rebuild(&self) {
        let ops_tx = self.rag_settings.ops_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let _ = std::thread::Builder::new()
            .name("tide-rag-rebuild-tick".into())
            .spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2000));
                if ops_tx.send(RagOpsEvent::RebuildTick).is_ok() {
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

/// Display label for an existing row's source kind. `SOURCE_KINDS` (the
/// add dialog's tile grid) deliberately stays at four kinds — the library
/// is ensured by the app and `add_source` refuses its kind, so a grid
/// tile could only ever mint a duplicate row. This map covers the four
/// addable kinds plus "library"; unknown kinds fall back to the raw wire
/// string rather than guessing.
fn source_kind_label(kind: &str) -> String {
    match kind {
        "url" => tr!("settings.rag.kind_url").to_string(),
        "docs" => tr!("settings.rag.kind_docs").to_string(),
        "crawl" => tr!("settings.rag.kind_crawl").to_string(),
        "repo" => tr!("settings.rag.kind_repo").to_string(),
        "library" => tr!("settings.rag.kind_library").to_string(),
        other => other.to_string(),
    }
}

/// Whether a Sources reply should refresh the library card's doc count:
/// the reindex latch is armed (the user reindexed the library row) and
/// that row has settled — status neither queued nor indexing. The first
/// reply after a reindex request observes the row still transient (the
/// daemon marks "queued" synchronously), so the refresh fires on the
/// settle reply, exactly once — never per 2 s poll tick.
fn library_refresh_after_sources(latch: bool, library_row: Option<&str>) -> bool {
    latch && matches!(library_row, Some(status) if status != "queued" && status != "indexing")
}

/// The copy hint line from the reply count: "N copied", or the
/// quieter "already in the commands folder" when nothing needed writing.
fn kb_install_note(installed: u32) -> String {
    if installed == 0 {
        tr!("settings.rag.library_kb_present").to_string()
    } else {
        tr!("settings.rag.library_kb_copied", count = installed)
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
    let mut line = format!(
        "{} · {} dims · {} {}",
        rag_language_label(&model.languages),
        model.dims,
        model.max_tokens,
        tr!("settings.rag.tokens_suffix"),
    );
    if !model.vendored && model.download_size > 0 {
        line.push_str(&format!(
            " · {:.1} MB",
            model.download_size as f64 / 1_048_576.0
        ));
    }
    line.push_str(&format!(" · {}", state));
    line
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

// ── the add-provider wizard's dialog vocabulary, shared by the Memory
// screen's dialogs ─────────────────────────────────────────────────────────

/// The wizard's labeled-field pattern: a MEDIUM secondary label over a
/// bordered TextField shell (focus accent, inset background).
fn rag_field(
    theme: &Theme,
    id: &'static str,
    label: SharedString,
    input: Entity<crate::input::TextInput>,
) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(
            div()
                .text_size(sp(11.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_secondary)
                .child(label),
        )
        .child(crate::ui::text_field::TextField::new(id, input).w_full())
}

/// The wizard's footer action pill (26px, bordered, hover overlay).
fn rag_dialog_pill(
    theme: &Theme,
    id: &'static str,
    label: SharedString,
    busy: bool,
    dim: bool,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .tab_index(0)
        .focus_visible(|style| style.border_color(theme.accent))
        .h(px(26.0))
        .px(px(10.0))
        .min_w(px(96.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(theme.border_strong)
        .when(dim || busy, |element| element.opacity(0.45))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(px(5.0))
        .cursor_default()
        .text_size(sp(12.5))
        .text_color(theme.text_secondary)
        .hover(|element| element.bg(theme.overlay))
        .child(label)
        .on_click(move |_this, window, cx| on_click(window, cx))
}

/// A dialog list's section header ("Local models", "Cloud", …).
fn rag_dialog_section(theme: &Theme, label: SharedString) -> Div {
    div()
        .px(px(14.0))
        .pt(px(10.0))
        .pb(px(3.0))
        .text_size(sp(10.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme.text_tertiary)
        .child(label)
}

/// A compact inline button for dialog rows (Download / Retry) — stops
/// propagation so clicking it never stages the row it sits in.
fn rag_model_row_button(
    theme: &Theme,
    id: SharedString,
    label: SharedString,
    busy: bool,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(22.0))
        .px(px(9.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(theme.border_strong)
        .when(busy, |el| el.opacity(0.45))
        .flex()
        .flex_none()
        .items_center()
        .cursor_pointer()
        .text_size(sp(11.0))
        .text_color(theme.text_secondary)
        .hover(|el| el.bg(theme.overlay))
        .child(label)
        .on_click(move |_event, window, cx| {
            cx.stop_propagation();
            on_click(window, cx);
        })
}

/// One selectable row shell: check bubble, title + info line, a right
/// control, click-to-stage. `enabled` false dims and deactivates.
fn rag_model_row_shell(
    theme: &Theme,
    id: impl Into<gpui::ElementId>,
    selected: bool,
    title: SharedString,
    sub: SharedString,
    control: AnyElement,
    enabled: bool,
    on_stage: impl Fn(&mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .mx(px(8.0))
        .my(px(2.0))
        .rounded(px(8.0))
        .px(px(10.0))
        .py(px(8.0))
        .flex()
        .items_center()
        .gap(px(10.0))
        .when(selected, |el| el.bg(theme.overlay))
        .when(!enabled, |el| el.opacity(0.5))
        .when(enabled, |el| {
            el.hover(|el| el.bg(theme.overlay))
                .cursor_pointer()
                .on_click(move |_event, window, cx| on_stage(window, cx))
        })
        .child(
            div()
                .size(px(16.0))
                .flex_none()
                .rounded_full()
                .border_1()
                .border_color(if selected {
                    theme.accent
                } else {
                    theme.border_strong
                })
                .when(selected, |el| el.bg(theme.accent))
                .flex()
                .items_center()
                .justify_center()
                .when(selected, |el| {
                    el.child(icon("icons/check.svg", 10.0, theme.text))
                }),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(
                    div()
                        .text_size(sp(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text)
                        .truncate()
                        .child(title),
                )
                .child(
                    div()
                        .text_size(sp(10.5))
                        .text_color(theme.text_tertiary)
                        .truncate()
                        .child(sub),
                ),
        )
        .child(control)
}

/// One catalog-model row: the shell plus the state control — Download
/// when missing, spinner + live percent while downloading, Retry on
/// failure, a Downloaded/Built-in pill when ready.
fn rag_model_dialog_row(
    theme: &Theme,
    staged: &str,
    model: &client::RagModelWire,
    busy: bool,
    weak: gpui::WeakEntity<Tide>,
) -> Stateful<Div> {
    let control: AnyElement = match model.download_state.as_str() {
        "downloading" => div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .child(motion::spin(icon(
                "icons/loader-circle.svg",
                11.0,
                theme.warning,
            )))
            .child(
                div()
                    .text_size(sp(11.0))
                    .text_color(theme.text_tertiary)
                    .child(SharedString::from(match model.download_percent {
                        Some(pct) => format!("{pct}%"),
                        None => tr!("settings.rag.model_downloading").to_string(),
                    })),
            )
            .into_any_element(),
        "failed" => rag_model_row_button(
            theme,
            SharedString::from(format!("rag-mdl-retry-{}", model.id)),
            tr!("common.retry").to_string().into(),
            busy,
            {
                let weak = weak.clone();
                let id = model.id.clone();
                move |_window, cx| {
                    let _ = weak.update(cx, |this: &mut Tide, cx| {
                        this.rag_model_command(client::Command::RagModelDownload {
                            model_id: id.clone(),
                        });
                        cx.notify();
                    });
                }
            },
        )
        .into_any_element(),
        _ if model.downloaded => {
            card_pill(theme, tr!("settings.rag.state_downloaded"), theme.success).into_any_element()
        }
        _ if model.vendored => {
            card_pill(theme, tr!("settings.rag.state_builtin"), theme.success).into_any_element()
        }
        _ => rag_model_row_button(
            theme,
            SharedString::from(format!("rag-mdl-dl-{}", model.id)),
            tr!("settings.rag.download").to_string().into(),
            busy,
            {
                let weak = weak.clone();
                let id = model.id.clone();
                move |_window, cx| {
                    let _ = weak.update(cx, |this: &mut Tide, cx| {
                        this.rag_model_command(client::Command::RagModelDownload {
                            model_id: id.clone(),
                        });
                        cx.notify();
                    });
                }
            },
        )
        .into_any_element(),
    };

    let title: SharedString = model.name.clone().into();
    let sub: SharedString = rag_model_sub_label(model).into();
    let id_for_stage = model.id.clone();
    rag_model_row_shell(
        theme,
        SharedString::from(format!("rag-model-row-{}", model.id)),
        staged == model.id,
        title,
        sub,
        control,
        true,
        {
            let weak = weak.clone();
            move |_window, cx| {
                let _ = weak.update(cx, |this: &mut Tide, cx| {
                    this.rag_settings.model_dialog = Some(id_for_stage.clone());
                    cx.notify();
                });
            }
        },
    )
}

/// The wizard's modal shell: composer card, 18px radius, xl shadow, a
/// click-stopped scrollable body between header and footer strips, over a
/// scrim — deferred at priority 0 so anchored menus float above it.
fn rag_dialog_layer(
    id: &'static str,
    theme: &Theme,
    width: f32,
    header: Div,
    body: Div,
    footer: Div,
) -> AnyElement {
    let card = div()
        .id(SharedString::from(format!("{id}-card")))
        .key_context(id)
        .w(px(width))
        .max_h(px(640.0))
        .overflow_hidden()
        .rounded(px(18.0))
        .bg(theme.composer)
        .shadow_xl()
        .flex()
        .flex_col()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(header)
        .child(
            div()
                .id(SharedString::from(format!("{id}-body")))
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(body),
        )
        .child(footer);
    let scrim = if theme.is_dark {
        gpui::hsla(0.0, 0.0, 0.0, 0.34)
    } else {
        gpui::hsla(0.0, 0.0, 0.0, 0.16)
    };
    let layer = div()
        .id(id)
        .absolute()
        .inset_0()
        .occlude()
        .bg(scrim)
        .p(px(24.0))
        .flex()
        .items_center()
        .justify_center()
        .child(card);
    gpui::deferred(layer).with_priority(0).into_any_element()
}

/// The wizard's header strip: title + description over a hairline.
fn rag_dialog_header(theme: &Theme, title: SharedString, description: SharedString) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .px(px(20.0))
        .py(px(14.0))
        .border_b_1()
        .border_color(theme.border)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(
                    div()
                        .text_size(sp(15.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text)
                        .child(title),
                )
                .when(!description.is_empty(), |col| {
                    col.child(
                        div()
                            .text_size(sp(11.5))
                            .text_color(theme.text_tertiary)
                            .child(description),
                    )
                }),
        )
}

/// The wizard's footer strip: inline error left, action pills right.
fn rag_dialog_footer(theme: &Theme, error: Option<&str>, pills: Vec<Stateful<Div>>) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .px(px(20.0))
        .py(px(12.0))
        .border_t_1()
        .border_color(theme.border)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(sp(11.5))
                .text_color(theme.danger)
                .children(error.map(SharedString::from)),
        )
        .child(div().flex().items_center().gap(px(8.0)).children(pills))
}

// ── global settings cards (model picker / models / retrieval / endpoints) ──

impl Tide {
    /// The embedding-model card: the picker in the body, the current
    /// selection in the head, cloud fallback + cloud model id beneath.
    pub(in crate::app) fn render_rag_model_card(
        &self,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        if self.rag_settings.config.is_none() && !self.rag_settings.config_requested.get() {
            self.rag_settings.config_requested.set(true);
            self.rag_config_load();
        }
        let config = self.rag_settings.config.clone();
        let selected_model = config.as_ref().and_then(|c| {
            self.rag_settings
                .models
                .iter()
                .find(|m| m.id == c.embedder_id)
                .cloned()
        });
        let selection = rag_selection_label(
            config.as_ref(),
            &self.rag_settings.models,
            &self.rag_settings.endpoints,
        );

        // The model picker is a dialog now — the chip opens it staged on
        // the current selection.
        let change_button = CardButton::new(
            "rag-model-change",
            SharedString::from(format!("{} — {}", tr!("settings.rag.change"), selection)),
        )
        .render(*theme, cx, |this: &mut Tide, _window, cx| {
            let staged = this
                .rag_settings
                .config
                .as_ref()
                .map(|c| c.embedder_id.clone())
                .unwrap_or_else(|| "local-code-512".to_owned());
            this.rag_settings.model_dialog = Some(staged);
            cx.notify();
        });

        let mut head = vec![card_pill(theme, selection, theme.accent).into_any_element()];
        if self.rag_settings.config_pending.get() {
            head.insert(
                0,
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(motion::spin(icon(
                        "icons/loader-circle.svg",
                        10.0,
                        theme.text_tertiary,
                    )))
                    .child(
                        div()
                            .text_size(sp(10.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("settings.rag.saving")),
                    )
                    .into_any_element(),
            );
        }

        let rows = vec![
            CardRow::new(tr!("settings.rag.model"))
                .description(tr!("settings.rag.model_hint"))
                .control(change_button),
        ];
        // The selected model's status block — only states that need
        // attention render: live download progress and failures. Quiet
        // ready states live in the selector dialog.
        let model_pending = self.rag_settings.pending_model.borrow().clone();
        let model_pending = model_pending.as_deref();
        let mut status_area: Option<Div> = None;
        if let Some(model) = selected_model.as_ref() {
            let busy = model_pending == Some(model.id.as_str());
            let state = model.download_state.as_str();
            if state == "downloading" {
                let label = match model.download_percent {
                    Some(pct) => {
                        format!("{} · {pct}%", tr!("settings.rag.model_downloading"))
                    }
                    None => tr!("settings.rag.model_downloading").to_string(),
                };
                let size = format!("{:.1} MB", model.download_size as f64 / 1_048_576.0);
                status_area = Some(
                    div()
                        .py(px(12.0))
                        .flex()
                        .flex_col()
                        .gap(px(7.0))
                        .border_t_1()
                        .border_color(theme.border)
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
                                        .child(SharedString::from(label)),
                                )
                                .child(
                                    div()
                                        .text_size(sp(10.5))
                                        .text_color(theme.text_tertiary)
                                        .child(SharedString::from(size)),
                                ),
                        )
                        .child(rag_progress_bar(theme, model.download_percent)),
                );
            } else if state == "failed" {
                let retry = CardButton::new(
                    SharedString::from(format!("rag-model-retry-{}", model.id)),
                    tr!("common.retry"),
                )
                .busy(busy)
                .ghost()
                .render(*theme, cx, {
                    let id = model.id.clone();
                    move |this, _window, cx| {
                        this.rag_model_command(client::Command::RagModelDownload {
                            model_id: id.clone(),
                        });
                        cx.notify();
                    }
                });
                let error = format!(
                    "{} — {}",
                    tr!("settings.rag.model_failed"),
                    model.download_error.as_deref().unwrap_or_default()
                );
                status_area = Some(
                    div()
                        .py(px(10.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .border_t_1()
                        .border_color(theme.border)
                        .child(icon(
                            "icons/alert.svg",
                            12.0,
                            crate::app::timeline_v2::status_color(
                                theme,
                                crate::app::timeline_v2::Status::Error,
                            ),
                        ))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(sp(11.0))
                                .text_color(theme.danger)
                                .child(SharedString::from(error)),
                        )
                        .child(retry),
                );
            }
        }

        let mut body = card_body(theme).child(card_rows(theme, rows));
        if let Some(area) = status_area {
            body = body.child(area);
        }

        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.global_title"),
            head,
        ));
        card.child(body)
    }

    /// Retrieval tuning: top-K stepper and minimum similarity (inline
    /// field — commits on Enter).
    pub(in crate::app) fn render_rag_retrieval_card(
        &self,
        window: &mut Window,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let top_k = self
            .rag_settings
            .config
            .as_ref()
            .map(|config| config.top_k)
            .unwrap_or(5);
        let minus =
            CardButton::new("rag-topk-minus", "−").render(*theme, cx, |this, _window, cx| {
                this.rag_topk_bump(-1);
                cx.notify();
            });
        let plus = CardButton::new("rag-topk-plus", "+").render(*theme, cx, |this, _window, cx| {
            this.rag_topk_bump(1);
            cx.notify();
        });
        let Some(inline) = self.rag_settings.inline_inputs(window, cx) else {
            return div()
                .w_full()
                .child(settings_group_head(
                    theme,
                    tr!("settings.rag.retrieval_title"),
                    Vec::new(),
                ))
                .child(card_body(theme).child(card_rows(theme, rag_loading_row(theme))));
        };
        let min_sim = inline.min_similarity;

        let open = self.rag_settings.advanced_open.get();
        let chunk_summary = {
            let config = self.rag_settings.config.as_ref();
            match (
                config.and_then(|c| c.chunk_size),
                config.and_then(|c| c.chunk_overlap),
            ) {
                (Some(size), Some(overlap)) => format!("{size} / {overlap}"),
                _ => tr!("settings.rag.chunk_default").to_string(),
            }
        };
        let disclosure = div()
            .id("rag-advanced-disclosure")
            .flex()
            .items_center()
            .gap(px(10.0))
            .py(px(12.0))
            .border_t_1()
            .border_color(theme.border)
            .cursor_pointer()
            .hover(|el| el.bg(theme.overlay))
            .on_click(cx.listener(|this: &mut Tide, _event, _window, cx| {
                this.rag_settings
                    .advanced_open
                    .set(!this.rag_settings.advanced_open.get());
                cx.notify();
            }))
            .child(icon(
                if open {
                    "icons/chevron-down.svg"
                } else {
                    "icons/chevron-right.svg"
                },
                12.0,
                theme.text_tertiary,
            ))
            .child(
                div()
                    .text_size(sp(13.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(tr!("settings.rag.advanced_title")),
            )
            .child(div().flex_1().min_w_0())
            .child(
                div()
                    .text_size(sp(10.5))
                    .text_color(theme.text_tertiary)
                    .child(SharedString::from(chunk_summary)),
            );

        let mut chunk_rows = Vec::new();
        if open {
            chunk_rows.push(
                CardRow::new(tr!("settings.rag.chunk_size")).control(div().w(px(110.0)).child(
                    crate::ui::text_field::TextField::new("rag-chunksize-input", inline.chunk_size),
                )),
            );
            chunk_rows.push(
                CardRow::new(tr!("settings.rag.chunk_overlap")).control(div().w(px(110.0)).child(
                    crate::ui::text_field::TextField::new(
                        "rag-chunkoverlap-input",
                        inline.chunk_overlap,
                    ),
                )),
            );
        }

        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.retrieval_title"),
            Vec::new(),
        ));
        let mut body = card_body(theme).child(card_rows(
            theme,
            vec![
                CardRow::new(tr!("settings.rag.top_k")).control(
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
                CardRow::new(tr!("settings.rag.min_similarity")).control(div().w(px(110.0)).child(
                    crate::ui::text_field::TextField::new("rag-minsim-input", min_sim),
                )),
                CardRow::new(tr!("settings.rag.rerank"))
                    .control(self.render_rerank_control(theme, cx)),
                CardRow::new(tr!("settings.rag.block_flagged"))
                    .control(self.render_block_flagged_control(theme, cx)),
                CardRow::new(tr!("settings.rag.inline_knowledge")).control(
                    div()
                        .w(px(110.0))
                        .child(crate::ui::text_field::TextField::new(
                            "rag-inlineknowledge-input",
                            inline.inline_knowledge,
                        )),
                ),
            ],
        ));
        body = body.child(disclosure);
        if !chunk_rows.is_empty() {
            body = body.child(card_rows(theme, chunk_rows));
        }
        card.child(body)
    }

    /// The rerank toggle: switching on auto-downloads the cross-encoder
    /// (23 MB) so the feature never silently no-ops; the row shows live
    /// download progress and a Retry when the fetch failed.
    fn render_rerank_control(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let config = self.rag_settings.config.as_ref();
        let enabled = config.is_some_and(|c| c.rerank_enabled);
        let state = config
            .and_then(|c| c.reranker_download.clone())
            .unwrap_or_else(|| "not-downloaded".to_owned());
        let downloaded = state == "ready";
        let downloading = state == "downloading";
        let mut control = div().flex().items_center().gap(px(8.0));
        let toggle = toggle_switch(
            "rag-rerank-toggle",
            enabled,
            false,
            *theme,
            cx,
            |this, _window, cx| {
                let next = !this
                    .rag_settings
                    .config
                    .as_ref()
                    .is_some_and(|c| c.rerank_enabled);
                this.rag_config_update(client::RagConfigPatchWire {
                    rerank_enabled: Some(next),
                    ..Default::default()
                });
                if next {
                    let ready = this
                        .rag_settings
                        .config
                        .as_ref()
                        .and_then(|c| c.reranker_download.clone())
                        .is_some_and(|s| s == "ready");
                    if !ready {
                        this.rag_model_command(client::Command::RagModelDownload {
                            model_id: "rerank-msmarco-miniilm".to_owned(),
                        });
                    }
                }
                cx.notify();
            },
        );
        control = control.child(toggle);
        if !downloaded {
            let error = config
                .and_then(|c| c.reranker_download_error.clone())
                .filter(|_| state == "failed");
            if let Some(error) = error {
                let busy = self
                    .rag_settings
                    .pending_model
                    .borrow()
                    .as_deref()
                    .is_some_and(|id| id == "rerank-msmarco-miniilm");
                let retry = CardButton::new("rag-reranker-retry", tr!("common.retry"))
                    .busy(busy)
                    .ghost()
                    .render(*theme, cx, |this, _window, _cx| {
                        this.rag_model_command(client::Command::RagModelDownload {
                            model_id: "rerank-msmarco-miniilm".to_owned(),
                        });
                    });
                control = control
                    .child(
                        div()
                            .max_w(px(180.0))
                            .text_size(sp(10.5))
                            .text_color(crate::app::timeline_v2::status_color(
                                theme,
                                crate::app::timeline_v2::Status::Error,
                            ))
                            .truncate()
                            .child(SharedString::from(error)),
                    )
                    .child(retry.into_any_element());
            } else if downloading {
                let percent = config.and_then(|c| c.reranker_download_percent);
                let label: SharedString = match percent {
                    Some(percent) => format!("{percent}%").into(),
                    None => tr!("settings.rag.rerank_downloading").to_owned().into(),
                };
                control = control.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(motion::spin(icon(
                            "icons/loader-circle.svg",
                            11.0,
                            theme.text_tertiary,
                        )))
                        .child(
                            div()
                                .text_size(sp(10.5))
                                .text_color(theme.text_tertiary)
                                .child(label),
                        ),
                );
            }
        }
        control
    }

    fn render_block_flagged_control(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let blocked = self
            .rag_settings
            .config
            .as_ref()
            .is_some_and(|c| c.knowledge_block_flagged);
        let toggle = toggle_switch(
            "rag-blockflagged-toggle",
            blocked,
            false,
            *theme,
            cx,
            |this, _window, cx| {
                let next = !this
                    .rag_settings
                    .config
                    .as_ref()
                    .is_some_and(|c| c.knowledge_block_flagged);
                this.rag_config_update(client::RagConfigPatchWire {
                    knowledge_block_flagged: Some(next),
                    ..Default::default()
                });
                cx.notify();
            },
        );
        div().child(toggle)
    }

    /// Advanced: chunking overrides as inline fields (commit on Enter;
    /// empty clears back to the chunker defaults). Changes route through

    /// Custom endpoints: BYOK rows with remove; add opens the sheet.
    pub(in crate::app) fn render_rag_endpoints_card(
        &self,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
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
                    crate::ui::empty_state::EmptyState::new(
                        "icons/plug.svg",
                        tr!("settings.rag.endpoints_empty_title"),
                    )
                    .caption(tr!("settings.rag.endpoints_empty"))
                    .w_full()
                    .py(px(22.0)),
                ),
            );
        }
        let mut rows = Vec::new();
        let endpoint_pending = self.rag_settings.pending_endpoint.borrow().clone();
        let endpoint_pending = endpoint_pending.as_deref();
        for endpoint in self.rag_settings.endpoints.iter() {
            let remove = CardButton::new(
                SharedString::from(format!("rag-endpoint-remove-{}", endpoint.id)),
                tr!("settings.rag.remove"),
            )
            .busy(endpoint_pending == Some(endpoint.id.as_str()))
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

    /// The add-endpoint dialog — the wizard vocabulary: labeled
    /// TextField rows, probe hint, footer pills (the daemon verifies with
    /// one test embedding before anything persists; failures stay inline).
    pub(in crate::app) fn render_rag_endpoint_dialog(
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

        let body = div()
            .p(px(20.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(rag_field(
                &theme,
                "rag-endpoint-name",
                tr!("settings.rag.dialog_name").to_string().into(),
                name,
            ))
            .child(rag_field(
                &theme,
                "rag-endpoint-base-url",
                tr!("settings.rag.endpoint_base_url").to_string().into(),
                base_url,
            ))
            .child(rag_field(
                &theme,
                "rag-endpoint-model",
                tr!("settings.rag.endpoint_model_id").to_string().into(),
                model_id,
            ))
            .child(rag_field(
                &theme,
                "rag-endpoint-key",
                tr!("settings.rag.endpoint_api_key").to_string().into(),
                api_key,
            ))
            .child(
                div()
                    .text_size(sp(11.0))
                    .text_color(theme.text_ghost)
                    .child(tr!("settings.rag.endpoint_dialog_hint")),
            );

        let submit_label = if busy {
            tr!("settings.rag.endpoint_probing")
        } else {
            tr!("settings.rag.add")
        };
        let footer = rag_dialog_footer(
            &theme,
            (!busy).then(|| error.as_deref()).flatten(),
            vec![
                rag_dialog_pill(
                    &theme,
                    "rag-endpoint-cancel",
                    tr!("settings.rag.cancel").to_string().into(),
                    false,
                    false,
                    {
                        let weak = cx.entity().downgrade();
                        move |_window, cx| {
                            let _ = weak.update(cx, |this: &mut Tide, cx| {
                                this.rag_settings.endpoint_dialog = None;
                                cx.notify();
                            });
                        }
                    },
                ),
                rag_dialog_pill(
                    &theme,
                    "rag-endpoint-submit",
                    submit_label.to_string().into(),
                    busy,
                    false,
                    {
                        let weak = cx.entity().downgrade();
                        move |_window, cx| {
                            let _ = weak.update(cx, |this: &mut Tide, cx| {
                                this.rag_endpoint_add(cx);
                            });
                        }
                    },
                ),
            ],
        );
        Some(rag_dialog_layer(
            "RagEndpointDialog",
            &theme,
            480.0,
            rag_dialog_header(
                &theme,
                tr!("settings.rag.add_endpoint").to_string().into(),
                tr!("settings.rag.endpoint_dialog_hint").to_string().into(),
            ),
            body,
            footer,
        ))
    }

    /// The embedding-model selector dialog: staged selection with a
    /// check bubble, full per-model info, in-row download with live
    /// progress, and Cancel / Select / Select & Rebuild at the bottom.
    /// Select applies the model and leaves stale indexes flagged on
    /// their cards; Select & Rebuild chains the update straight into the
    /// serial rebuild, whose progress strip renders below the cards.
    pub(in crate::app) fn render_rag_model_dialog(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = Theme::current(cx);
        let staged = self.rag_settings.model_dialog.clone()?;
        let current = self
            .rag_settings
            .config
            .as_ref()
            .map(|c| c.embedder_id.clone());
        let models = self.rag_settings.models.clone();
        let endpoints = self.rag_settings.endpoints.clone();
        let pending_model = self.rag_settings.pending_model.borrow().clone();

        // Confirm needs a changed selection that is ready on disk —
        // cloud and custom endpoints are always ready.
        let staged_ready = models
            .iter()
            .find(|m| m.id == staged)
            .map(|m| m.downloaded || m.vendored)
            .unwrap_or(true);
        let unchanged = current.as_deref() == Some(staged.as_str());
        let confirm_dim = unchanged || !staged_ready;

        let mut body = div().flex().flex_col().pb(px(6.0));
        body = body.child(rag_dialog_section(
            &theme,
            tr!("settings.rag.group_local").to_string().into(),
        ));
        for model in models.iter() {
            body = body.child(rag_model_dialog_row(
                &theme,
                &staged,
                model,
                pending_model.as_deref() == Some(model.id.as_str()),
                cx.entity().downgrade(),
            ));
        }
        if !endpoints.is_empty() {
            body = body.child(rag_dialog_section(
                &theme,
                tr!("settings.rag.group_endpoints").to_string().into(),
            ));
            for endpoint in endpoints.iter() {
                body = body.child(rag_model_row_shell(
                    &theme,
                    SharedString::from(format!("rag-model-row-{}", endpoint.id)),
                    staged == endpoint.id,
                    format!("{} \u{00b7} {}", endpoint.name, endpoint.model_id).into(),
                    format!(
                        "{} \u{00b7} {} dims",
                        tr!("settings.rag.endpoint_sub"),
                        endpoint.dims
                    )
                    .into(),
                    card_pill(&theme, tr!("settings.rag.state_ready"), theme.success)
                        .into_any_element(),
                    true,
                    {
                        let weak = cx.entity().downgrade();
                        let id = endpoint.id.clone();
                        move |window, cx| {
                            let _ = weak.update(cx, |this: &mut Tide, cx| {
                                this.rag_settings.model_dialog = Some(id.clone());
                                cx.notify();
                            });
                            let _ = window;
                        }
                    },
                ));
            }
        }

        let mut pills = vec![rag_dialog_pill(
            &theme,
            "rag-model-cancel",
            tr!("settings.rag.cancel").to_string().into(),
            false,
            false,
            {
                let weak = cx.entity().downgrade();
                move |_window, cx| {
                    let _ = weak.update(cx, |this: &mut Tide, cx| {
                        this.rag_settings.model_dialog = None;
                        cx.notify();
                    });
                }
            },
        )];
        for (pill_id, label, rebuild) in [
            ("rag-model-select", tr!("settings.rag.select"), false),
            (
                "rag-model-select-rebuild",
                tr!("settings.rag.select_rebuild"),
                true,
            ),
        ] {
            let weak = cx.entity().downgrade();
            let staged = staged.clone();
            pills.push(rag_dialog_pill(
                &theme,
                pill_id,
                label.to_string().into(),
                false,
                confirm_dim,
                {
                    let weak = weak.clone();
                    let staged = staged.clone();
                    move |_window, cx| {
                        let _ = weak.update(cx, |this: &mut Tide, cx| {
                            let changed = this
                                .rag_settings
                                .config
                                .as_ref()
                                .map(|c| c.embedder_id.clone())
                                != Some(staged.clone());
                            if changed {
                                this.rag_settings.rebuild_after_update.set(rebuild);
                                this.rag_config_update(client::RagConfigPatchWire {
                                    embedder_id: Some(staged.clone()),
                                    ..Default::default()
                                });
                            }
                            this.rag_settings.model_dialog = None;
                            cx.notify();
                        });
                    }
                },
            ));
        }
        let needs_download =
            (!staged_ready && !unchanged).then(|| tr!("settings.rag.needs_download").to_string());
        let footer = rag_dialog_footer(&theme, needs_download.as_deref(), pills);

        Some(rag_dialog_layer(
            "RagModelDialog",
            &theme,
            560.0,
            rag_dialog_header(
                &theme,
                tr!("settings.rag.model_dialog_title").to_string().into(),
                SharedString::from(""),
            ),
            body,
            footer,
        ))
    }

    /// The serial rebuild's live progress, below the Memory cards — the
    /// offer dialog is gone by now (it never renders while running). A
    /// step that outlives the watchdog shows a stall error + Retry.
    pub(in crate::app) fn render_rag_rebuild_progress(
        &self,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let rebuild = self
            .rag_settings
            .rebuild
            .as_ref()
            .filter(|rebuild| rebuild.running || rebuild.stalled)?;
        let stalled = rebuild.stalled;
        let remaining = rebuild.queue.len();
        let pct = (!stalled && rebuild.total > 0).then(|| {
            ((rebuild.total - remaining.min(rebuild.total)) as f64 / rebuild.total as f64 * 100.0)
                .round() as u32
        });
        let status = if stalled {
            tr!("settings.rag.rebuild_stalled")
        } else {
            tr!("settings.rag.rebuild_progress", count = remaining)
        };
        let mut card = div()
            .flex()
            .items_center()
            .gap(px(12.0))
            .rounded(px(13.0))
            .border_1()
            .border_color(theme.border_strong)
            .bg(theme.raised)
            .px(px(14.0))
            .py(px(12.0))
            .child(if stalled {
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
                    .flex()
                    .flex_col()
                    .gap(px(7.0))
                    .child(
                        div()
                            .text_size(sp(11.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(status),
                    )
                    .when(!stalled, |body| body.child(rag_progress_bar(theme, pct))),
            );
        if stalled {
            card = card.child(
                CardButton::new("rag-rebuild-retry", tr!("common.retry")).render(
                    *theme,
                    cx,
                    |this: &mut Tide, _window, cx: &mut Context<Tide>| this.rag_rebuild_retry(cx),
                ),
            );
        }
        Some(card)
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

/// The 4px track + accent fill shared by every determinate progress
/// surface (indexing card, model download, rebuild dialog). `None` is
/// the indeterminate half-fill (denominator still unknown).
fn rag_progress_bar(theme: &Theme, percent: Option<u32>) -> Div {
    match percent {
        Some(pct) => div()
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
        None => div()
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
    }
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
        card = card.child(rag_progress_bar(theme, determinate.then_some(pct)));
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
    pub(in crate::app) fn render_memory_rag_card_for(
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
        let model_ready = relevant.is_some_and(|status| status.model_download == "ready");
        let pending_toggle = self
            .rag_settings
            .pending_toggle
            .as_ref()
            .filter(|(pending, _)| pending == &project_id);
        // Optimistic flip: while the enable command is in flight the
        // toggle paints the target state, inert until Status replies.
        let shown_enabled = pending_toggle.map(|(_, next)| *next).unwrap_or(enabled);
        let toggle_disabled = pending_toggle.is_some() || (!enabled && !model_ready);
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
        .disabled(!model_ready)
        .render(*theme, cx, move |this, _window, cx| {
            this.rag_init(&build_id, cx);
        });

        let toggle_id = project_id.clone();
        let toggle = toggle_switch(
            SharedString::from(format!("rag-enable-{project_id}")),
            shown_enabled,
            toggle_disabled,
            *theme,
            cx,
            move |this, _window, cx| {
                let next = !this
                    .rag_settings
                    .pending_toggle
                    .as_ref()
                    .map(|(_, next)| *next)
                    .unwrap_or(
                        this.rag_settings
                            .status
                            .as_ref()
                            .is_some_and(|status| status.enabled),
                    );
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
                        .when(relevant.is_some_and(|status| status.plan_stale), |row| {
                            row.child(card_pill(
                                theme,
                                tr!("settings.rag.stale_badge"),
                                theme.warning,
                            ))
                        })
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

    /// The knowledge-sources card: the list in a full-bleed body; the
    /// add action lives in the page header.
    pub(in crate::app) fn render_sources_card(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let add = CardButton::new("rag-source-new", tr!("settings.rag.add"))
            .icon("icons/plus.svg")
            .render(*theme, cx, |this, window, cx| {
                this.rag_settings.open_source_dialog(window, cx);
            });
        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.sources_title"),
            vec![add.into_any_element()],
        ));

        let mut body = card_body_flush(theme);
        let in_scope: Vec<_> = self.rag_settings.sources.clone();
        let loading = !self.rag_settings.sources_loaded.get()
            && in_scope.is_empty()
            && self.rag_settings.sources_error.is_none();
        if loading {
            body = body.child(
                div()
                    .px(px(20.0))
                    .py(px(12.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(motion::spin(icon(
                        "icons/loader-circle.svg",
                        11.0,
                        theme.text_tertiary,
                    )))
                    .child(
                        div()
                            .text_size(sp(11.0))
                            .text_color(theme.text_tertiary)
                            .child(tr!("settings.rag.loading")),
                    ),
            );
        } else if in_scope.is_empty() {
            body = body.child(
                crate::ui::empty_state::EmptyState::new(
                    "icons/database.svg",
                    tr!("settings.rag.sources_empty_title"),
                )
                .caption(tr!("settings.rag.sources_empty"))
                .w_full()
                .py(px(22.0)),
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
                None => {
                    let base = format!(
                        "{} · {} · {} {}",
                        source_kind_label(&source.kind),
                        source.status,
                        source.chunk_count,
                        tr!("settings.rag.chunks_suffix")
                    );
                    // The injection screen verdict rides the settled line:
                    // flagged sources show why, so the badge is actionable.
                    match source
                        .injection
                        .as_deref()
                        .filter(|verdict| *verdict == "flagged")
                    {
                        Some(_) => {
                            let note = source
                                .injection_detail
                                .clone()
                                .unwrap_or_else(|| tr!("settings.rag.flagged").to_string());
                            format!("{base} · ⚠ {note}")
                        }
                        None => base,
                    }
                }
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
                                .text_color(
                                    if source.status == "error"
                                        || source.injection.as_deref() == Some("flagged")
                                    {
                                        crate::app::timeline_v2::status_color(
                                            theme,
                                            crate::app::timeline_v2::Status::Error,
                                        )
                                    } else {
                                        theme.text_tertiary
                                    },
                                )
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

    /// Knowledge Library card: where the writable library lives, its
    /// registry size, reindex/reveal, and the `/kb` built-ins' copy-to-folder
    /// affordance.
    /// The idempotent `LibraryEnsure` rides the first render so the source
    /// row + directory exist before anything is clicked; the root path
    /// comes from the daemon's reply (a remote daemon's data dir is not
    /// ours to guess).
    pub(in crate::app) fn render_library_card(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        // Same retry idiom as the config card (`is_none() && !requested`):
        // a failed ensure clears `library_requested` in the error arm, so
        // the next render retries instead of stranding the card — the
        // error strip keeps rendering while the retry is in flight.
        if self.rag_settings.library.is_none() && !self.rag_settings.library_requested.get() {
            self.rag_settings.library_requested.set(true);
            self.rag_library_ensure();
        }
        let library = self.rag_settings.library.clone();
        let can_reveal = !self.daemon.is_remote();
        let row_pending = library.as_ref().is_some_and(|state| {
            self.rag_settings.pending_source.as_deref() == Some(state.source_id.as_str())
        });

        // Head actions: reveal the folder (local daemon only — the path
        // belongs to the daemon's disk) and reindex through the same
        // generic source flow the sources list rows use.
        let reveal_path = library.as_ref().map(|state| state.root.clone());
        let reveal = CardButton::new("rag-library-reveal", tr!("settings.rag.library_reveal"))
            .icon("icons/folder-open.svg")
            .disabled(reveal_path.is_none() || !can_reveal)
            .render(*theme, cx, move |_this, _window, cx| {
                if let Some(path) = reveal_path.as_ref() {
                    crate::platform::reveal_in_file_manager(path, cx);
                }
            });

        let reindex_id = library.as_ref().map(|state| state.source_id.clone());
        let reindex = CardButton::new("rag-library-reindex", tr!("settings.rag.reindex"))
            .busy(row_pending)
            .disabled(reindex_id.is_none())
            .render(*theme, cx, move |this, _window, _cx| {
                if let Some(source_id) = reindex_id.as_ref() {
                    this.rag_source_command(client::Command::SourcesReindex {
                        source_id: source_id.clone(),
                    });
                }
            });

        let card = div().w_full().child(settings_group_head(
            theme,
            tr!("settings.rag.library_title"),
            vec![reveal.into_any_element(), reindex.into_any_element()],
        ));

        // The `/kb` pack install (idempotent — re-running reports what
        // was already present through the row's hint line).
        let install = CardButton::new("rag-library-kb-install", tr!("settings.rag.library_copy"))
            .icon("icons/command.svg")
            .busy(self.rag_settings.kb_pending.get())
            .render(*theme, cx, |this, _window, _cx| {
                this.rag_kb_install();
            });

        let location = library
            .as_ref()
            .map(|state| SharedString::from(state.root.to_string_lossy().into_owned()))
            .unwrap_or_else(|| SharedString::from(tr!("settings.rag.loading").to_string()));
        let mut location_row =
            CardRow::new(tr!("settings.rag.library_location")).description(location);
        if !can_reveal {
            location_row = location_row.hint(tr!("settings.rag.library_remote_hint"));
        }

        let docs = library
            .as_ref()
            .map(|state| {
                SharedString::from(tr!(
                    "settings.rag.library_docs_value",
                    count = state.doc_count
                ))
            })
            .unwrap_or_else(|| SharedString::from("—"));

        let mut commands_row = CardRow::new(tr!("settings.rag.library_commands"))
            .description(tr!("settings.rag.library_commands_hint"));
        if let Some(note) = self.rag_settings.kb_note.clone() {
            commands_row = commands_row.hint(SharedString::from(note));
        }

        let rows = vec![
            location_row,
            CardRow::new(tr!("settings.rag.library_docs"))
                .description(tr!("settings.rag.library_docs_hint"))
                .control(
                    div()
                        .text_size(sp(12.5))
                        .text_color(theme.text_secondary)
                        .child(docs),
                ),
            commands_row.control(install),
        ];

        let mut body = card_body(theme).child(card_rows(theme, rows));
        if let Some(error) = self.rag_settings.library_error.clone() {
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
const SOURCE_KINDS: [(&str, &str, &str, &str, &str); 4] = [
    (
        "url",
        "settings.rag.kind_url",
        "https://example.com/page",
        "settings.rag.kind_url_hint",
        "icons/globe.svg",
    ),
    (
        "docs",
        "settings.rag.kind_docs",
        "/path/to/docs",
        "settings.rag.kind_docs_hint",
        "icons/folder.svg",
    ),
    (
        "crawl",
        "settings.rag.kind_crawl",
        "https://docs.example.com/",
        "settings.rag.kind_crawl_hint",
        "icons/cloud-upload.svg",
    ),
    (
        "repo",
        "settings.rag.kind_repo",
        "https://github.com/owner/repo",
        "settings.rag.kind_repo_hint",
        "icons/git-branch.svg",
    ),
];

impl Tide {
    /// The add-knowledge dialog — the add-provider wizard's component
    /// vocabulary (composer card, TextField fields, tile grid, footer
    /// pills): target project selector, name, a 2×2 kind tile grid, and
    /// the location field with the docs browser.
    pub(in crate::app) fn render_rag_source_dialog(
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
            .find(|(value, ..)| *value == kind)
            .unwrap_or(&SOURCE_KINDS[0]);

        let mut body = div().p(px(20.0)).flex().flex_col().gap(px(12.0));

        // Target scope — chosen here, not on the card.
        let selected_project = draft.project.clone();
        let weak = cx.entity().downgrade();
        let scope_handle = self.menu_handle("rag-dialog-scope", cx);
        let scope_label = match &selected_project {
            None => tr!("settings.rag.scope_global"),
            Some(project_id) => self
                .state
                .projects
                .iter()
                .find(|project| project.id.to_string() == *project_id)
                .map(|project| project.name.clone())
                .unwrap_or_else(|| tr!("settings.rag.scope_global").to_string()),
        };
        let projects = self.state.projects.clone();
        let scope_selector = dropdown_menu(
            MenuChip::new("rag-dialog-scope-chip")
                .label(scope_label)
                .outlined()
                .max_w(px(220.0))
                .justify_between(),
            "rag-dialog-scope-menu",
            &scope_handle,
            MenuAlign::BelowLeft,
            move |_| {
                let mut items = vec![
                    MenuItem::new(tr!("settings.rag.scope_global"), {
                        let weak = weak.clone();
                        move |_window, cx| {
                            let _ = weak.update(cx, |tide: &mut Tide, cx| {
                                if let Some(draft) = tide.rag_settings.dialog.as_mut() {
                                    draft.project = None;
                                }
                                cx.notify();
                            });
                        }
                    })
                    .selected(selected_project.is_none()),
                ];
                for project in projects.iter().filter(|p| !p.is_projectless()) {
                    let weak = weak.clone();
                    let id = project.id.to_string();
                    let is_selected = selected_project.as_deref() == Some(id.as_str());
                    let label = project.name.clone();
                    items.push(
                        MenuItem::new(label, move |_window, cx| {
                            let _ = weak.update(cx, |tide: &mut Tide, cx| {
                                if let Some(draft) = tide.rag_settings.dialog.as_mut() {
                                    draft.project = Some(id.clone());
                                }
                                cx.notify();
                            });
                        })
                        .selected(is_selected),
                    );
                }
                items
            },
        );
        body = body.child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(
                    div()
                        .text_size(sp(11.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_secondary)
                        .child(tr!("settings.rag.dialog_project")),
                )
                .child(scope_selector),
        );

        // Name
        body = body.child(rag_field(
            &theme,
            "rag-source-name",
            tr!("settings.rag.dialog_name").to_string().into(),
            name,
        ));

        // Kind — the wizard's tile grid: icon over label over hint, two
        // equal columns, selected = accent border (kind is fixed after
        // creation; this dialog is add-only).
        let mut kinds = div().flex().flex_col().gap(px(6.0)).child(
            div()
                .text_size(sp(11.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_secondary)
                .child(tr!("settings.rag.dialog_kind")),
        );
        let grid = div().flex().flex_col().gap(px(8.0));
        let grid = SOURCE_KINDS.chunks(2).fold(grid, |grid, row_kinds| {
            let mut row = div().flex().gap(px(8.0));
            for (value, label_key, _placeholder, hint_key, icon_path) in row_kinds {
                let selected = *value == kind;
                let weak = cx.entity().downgrade();
                let value = *value;
                let tile = div()
                    .id(SharedString::from(format!("rag-kind-{value}")))
                    .tab_index(0)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .flex_1()
                    .min_w_0()
                    .p(px(10.0))
                    .rounded(px(12.0))
                    .border_1()
                    .border_color(if selected {
                        theme.accent.opacity(0.5)
                    } else {
                        theme.border
                    })
                    .when(selected, |el| el.bg(theme.inset))
                    .cursor_pointer()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(4.0))
                    .child(icon(
                        icon_path,
                        16.0,
                        if selected {
                            theme.accent
                        } else {
                            theme.text_tertiary
                        },
                    ))
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
                            .text_size(sp(10.0))
                            .text_color(theme.text_tertiary)
                            .child(tr!(hint_key)),
                    )
                    .on_click(move |_, _window, cx| {
                        let _ = weak.update(cx, |tide: &mut Tide, cx| {
                            if let Some(draft) = tide.rag_settings.dialog.as_mut() {
                                draft.kind = value;
                            }
                            cx.notify();
                        });
                    });
                row = row.child(tile);
            }
            grid.child(row)
        });
        kinds = kinds.child(grid);
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
                                .text_color(theme.text_secondary)
                                .child(tr!("settings.rag.dialog_location")),
                        )
                        .children(browse),
                )
                .child(crate::ui::text_field::TextField::new(
                    "rag-source-location",
                    location,
                ))
                .child(
                    div()
                        .text_size(sp(10.5))
                        .text_color(theme.text_tertiary)
                        .child(tr!(kind_meta.3)),
                ),
        );

        let footer = rag_dialog_footer(
            &theme,
            (!busy).then(|| error.as_deref()).flatten(),
            vec![
                rag_dialog_pill(
                    &theme,
                    "rag-source-cancel",
                    tr!("settings.rag.cancel").to_string().into(),
                    false,
                    false,
                    {
                        let weak = cx.entity().downgrade();
                        move |window, cx| {
                            let _ = weak.update(cx, |this: &mut Tide, cx| {
                                this.rag_settings.dialog = None;
                                window.refresh();
                                cx.notify();
                            });
                        }
                    },
                ),
                rag_dialog_pill(
                    &theme,
                    "rag-source-submit",
                    tr!("settings.rag.add").to_string().into(),
                    busy,
                    false,
                    {
                        let weak = cx.entity().downgrade();
                        move |_window, cx| {
                            let _ = weak.update(cx, |this: &mut Tide, cx| {
                                this.rag_source_add(cx);
                            });
                        }
                    },
                ),
            ],
        );
        Some(rag_dialog_layer(
            "RagSourceDialog",
            &theme,
            520.0,
            rag_dialog_header(
                &theme,
                tr!("settings.rag.add_source").to_string().into(),
                tr!("settings.rag.dialog_description").to_string().into(),
            ),
            body,
            footer,
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
            model_download_percent: None,
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

    fn model(
        id: &str,
        name: &str,
        dims: usize,
        langs: &str,
        state: &str,
        vendored: bool,
    ) -> client::RagModelWire {
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
            download_percent: None,
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
        assert!(
            label.contains(&tr!("settings.rag.lang_english")),
            "was {label}"
        );
        assert!(
            label.contains(&tr!("settings.rag.state_downloaded")),
            "was {label}"
        );

        let m = model(
            "local-mle5-small",
            "Xenova/multilingual-e5-small",
            384,
            "multilingual",
            "not-downloaded",
            false,
        );
        let label = rag_model_sub_label(&m);
        assert!(
            label.contains(&tr!("settings.rag.lang_multilingual")),
            "was {label}"
        );
        assert!(
            label.contains(&tr!("settings.rag.state_not_downloaded")),
            "was {label}"
        );
    }

    #[test]
    fn selection_label_prefers_original_repo_names() {
        let models = vec![
            model(
                "local-code-512",
                "isuruwijesiri/all-MiniLM-L6-v2-code-search-512",
                384,
                "en",
                "ready",
                true,
            ),
            model(
                "local-bge-m3",
                "Xenova/bge-m3",
                1024,
                "multilingual",
                "ready",
                false,
            ),
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
        assert_eq!(
            rag_selection_label(None, &models, &[]),
            tr!("settings.rag.loading")
        );
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
    fn source_kind_label_covers_library_and_falls_back_to_raw() {
        // The four addable kinds reuse the add-dialog labels; library has
        // its own entry; anything else renders verbatim rather than
        // borrowing another kind's label.
        assert_eq!(
            source_kind_label("url"),
            tr!("settings.rag.kind_url").to_string()
        );
        assert_eq!(
            source_kind_label("docs"),
            tr!("settings.rag.kind_docs").to_string()
        );
        assert_eq!(
            source_kind_label("crawl"),
            tr!("settings.rag.kind_crawl").to_string()
        );
        assert_eq!(
            source_kind_label("repo"),
            tr!("settings.rag.kind_repo").to_string()
        );
        assert_eq!(
            source_kind_label("library"),
            tr!("settings.rag.kind_library").to_string()
        );
        assert_eq!(source_kind_label("mystery"), "mystery");
    }

    #[test]
    fn library_refresh_fires_once_when_the_reindexed_row_settles() {
        // Reply 1 — right after the reindex click: the daemon has already
        // marked the row queued/indexing, so the latch stays armed and
        // nothing refreshes (this covers every 2 s poll tick too).
        assert!(!library_refresh_after_sources(true, Some("queued")));
        assert!(!library_refresh_after_sources(true, Some("indexing")));
        // Reply 2 — the row settled (idle, or failed): refresh once.
        assert!(library_refresh_after_sources(true, Some("idle")));
        assert!(library_refresh_after_sources(true, Some("error")));
        // An unarmed latch (no reindex clicked — Remove never arms it)
        // and an absent row never refresh.
        assert!(!library_refresh_after_sources(false, Some("idle")));
        assert!(!library_refresh_after_sources(true, None));
    }

    #[test]
    fn kb_install_note_distinguishes_fresh_installs() {
        assert_eq!(
            kb_install_note(0),
            tr!("settings.rag.library_kb_present").to_string()
        );
        assert_eq!(kb_install_note(4), "4 copied to commands folder");
    }
}

pub(in crate::app) mod page;
