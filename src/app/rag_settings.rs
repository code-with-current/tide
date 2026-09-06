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

impl Default for RagSettingsPanel {
    fn default() -> Self {
        Self::new()
    }
}

impl RagSettingsPanel {
    pub(crate) fn new() -> Self {
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
        }
    }

    /// Open the add dialog (upstream's SourceDialog, fresh every time).
    fn open_source_dialog(&mut self, window: &mut Window, cx: &mut Context<Tide>) {
        let name = cx.new(|cx| {
            crate::input::TextInput::new(window, cx)
                .clear_on_escape()
                .placeholder("settings.rag.dialog_name_placeholder")
        });
        let location = cx.new(|cx| {
            crate::input::TextInput::new(window, cx)
                .clear_on_escape()
                .placeholder("settings.rag.add_location_placeholder")
        });
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
}

// ── dispatch + actions ─────────────────────────────────────────────────────

impl Tide {
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
        self.rag_dispatch(
            move |payload| match payload {
                client::ResponsePayload::Sources { sources } => RagOpsEvent::Sources(Ok(sources)),
                _ => RagOpsEvent::Sources(Err("unexpected response".into())),
            },
            client::Command::SourcesAdd {
                name,
                kind,
                location,
            },
        );
        cx.notify();
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
    pub(super) fn render_memory_rag_card(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let Some(project) = self.selected_project() else {
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
                        .text_size(sp(12.5))
                        .text_color(theme.text_secondary)
                        .child(rag_index_line(relevant, &project_id)),
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

        let mut body = card_body_flush(theme);
        if self.rag_settings.sources.is_empty() {
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
        for (index, source) in self.rag_settings.sources.clone().into_iter().enumerate() {
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
        // Location (per-kind placeholder rides the input; hint below)
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
                        .child(tr!("settings.rag.dialog_location")),
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
                    ),
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
}
