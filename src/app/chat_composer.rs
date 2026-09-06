//! The chat composer, rewritten from scratch.
//!
//! The old stack had three layers where one would do: a `TextInput` field, a
//! `ComposerInput` relay entity that re-emitted the field's events under new
//! names, and composer state smeared across `Tide` — every keystroke crossed
//! two event hops before it reached the app. This module replaces all of
//! that with one entity and one card:
//!
//! * [`ChatComposer`] owns the field outright. It turns the field's low-level
//!   events into composer vocabulary ([`ChatComposerEvent`]) and answers the
//!   steering chord itself. A keystroke now crosses exactly one boundary.
//! * [`Tide::render_composer`] assembles the card from plainly named pieces —
//!   autocomplete popup, attachment chips, the field, the toolbar — with the
//!   submit/stop control as the only stateful branch.
//!
//! What deliberately did not move: attachment staging (daemon uploads) and
//! submission assembly stay on `Tide`, and the autocomplete's prefetched
//! indexes stay `Tide`-owned caches — the composer reads them per frame and
//! never touches the filesystem or the network from render.

use gpui::{ClipboardEntry, EventEmitter, Subscription};

use super::*;
use crate::input::{InputEvent, MediaPaste, SubmitSteer, TextInput};
use crate::ui::menu::{ConfirmEntry, DismissMenu, SelectNextEntry, SelectPreviousEntry};

// ── Events ──────────────────────────────────────────────────────────────────

/// The composer's whole vocabulary. Tide subscribes once; there is no second
/// relay entity re-emitting these under yet another name.
#[derive(Clone)]
pub enum ChatComposerEvent {
    /// Enter on a non-empty field. The field clears itself first; the payload
    /// is the trimmed prompt.
    Submit(String),
    /// The primary-modifier chord on a non-empty field: steer the running
    /// turn. Cleared like [`ChatComposerEvent::Submit`].
    SubmitSteer(String),
    /// The steering chord on an empty field: re-steer from the queue.
    SteerQueued,
    /// The text content changed. Draft persistence and autocomplete react to
    /// this, never to raw notifies.
    Edited,
    /// The field took focus.
    Focus,
    /// Backspace with nothing left to delete; Tide pops an attachment chip.
    BackspaceOnEmpty,
    /// A clipboard image/file paste. Text pastes never surface here.
    MediaPasted(Vec<ClipboardEntry>),
}

// ── The entity ──────────────────────────────────────────────────────────────

/// The prompt input at the heart of the composer card. Owns its field; the
/// card renders it as a child.
pub struct ChatComposer {
    field: Entity<TextInput>,
    /// Clone of the field's handle, so `focus()` needs no `cx`.
    focus_handle: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl ChatComposer {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let field = cx.new(|cx| {
            TextInput::new(window, cx)
                .multi_line()
                .submit_on_enter()
                .auto_height()
                .media_paste()
                .placeholder(tr!("input.do_anything"))
        });
        let focus_handle = field.read(cx).focus();
        let _subscriptions = vec![
            cx.subscribe(&field, |composer, _, event: &InputEvent, cx| match event {
                InputEvent::Submit(raw) => {
                    // The prompt is consumed by sending it, and whitespace
                    // alone is nothing to send.
                    let value = raw.trim().to_owned();
                    if !value.is_empty() {
                        composer.field.update(cx, |field, cx| field.clear(cx));
                        cx.emit(ChatComposerEvent::Submit(value));
                    }
                }
                InputEvent::Focus => cx.emit(ChatComposerEvent::Focus),
                InputEvent::Edited => cx.emit(ChatComposerEvent::Edited),
                InputEvent::BackspaceOnEmpty => cx.emit(ChatComposerEvent::BackspaceOnEmpty),
            }),
            cx.subscribe(&field, |_, _, event: &MediaPaste, cx| {
                cx.emit(ChatComposerEvent::MediaPasted(event.0.clone()));
            }),
        ];
        Self {
            field,
            focus_handle,
            _subscriptions,
        }
    }

    /// Forwarded [`TextInput::set_padding_x`], for the embedded field.
    pub fn padding_x(self, padding: Pixels, cx: &mut Context<Self>) -> Self {
        self.field
            .update(cx, |field, _| field.set_padding_x(padding));
        self
    }

    pub fn focus(&self) -> FocusHandle {
        self.focus_handle.clone()
    }

    pub fn content<'a>(&self, cx: &'a App) -> &'a str {
        self.field.read(cx).content()
    }

    /// Caret byte offset, for the autocomplete's trigger detection.
    pub fn cursor(&self, cx: &App) -> usize {
        self.field.read(cx).cursor()
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.field.update(cx, |field, cx| field.clear(cx));
    }

    pub fn set_content(&mut self, content: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.field
            .update(cx, |field, cx| field.set_content(content, cx));
    }

    /// Splice `text` over `range`, as the `@`/`/` autocomplete accepts a row.
    pub fn replace_range(&mut self, range: Range<usize>, text: &str, cx: &mut Context<Self>) {
        self.field
            .update(cx, |field, cx| field.replace_range(range, text, cx));
    }

    /// Replace the placeholder after construction, as the language switch does.
    pub fn set_placeholder(
        &mut self,
        placeholder: impl Into<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.field
            .update(cx, |field, cx| field.set_placeholder(placeholder, cx));
    }

    /// Whether this field's right-click menu is open. The browser surface
    /// treats that as an overlay above its native webview.
    pub fn context_menu_open(&self, cx: &App) -> bool {
        self.field.read(cx).context_menu_open()
    }

    /// Forwarded focus preservation: the field keeps its caret lit while an
    /// outside context menu covers it.
    pub fn preserve_visual_focus_for_context_menu(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.field.update(cx, |field, cx| {
            field.preserve_visual_focus_for_context_menu(window, cx)
        })
    }

    pub fn release_visual_focus_for_context_menu(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        self.field.update(cx, |field, cx| {
            field.release_visual_focus_for_context_menu(window, cx)
        });
    }
}

impl Render for ChatComposer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .w_full()
            // The embedded field propagates SubmitSteer; this ancestor
            // handler is where steering becomes a composer event.
            .on_action(cx.listener(|composer, _: &SubmitSteer, _, cx| {
                let value = composer.content(cx).trim().to_owned();
                if value.is_empty() {
                    cx.emit(ChatComposerEvent::SteerQueued);
                    return;
                }
                composer.field.update(cx, |field, cx| field.clear(cx));
                cx.emit(ChatComposerEvent::SubmitSteer(value));
            }))
            .child(self.field.clone())
    }
}

impl Focusable for ChatComposer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl EventEmitter<ChatComposerEvent> for ChatComposer {}

// ── The card ────────────────────────────────────────────────────────────────

/// What the card's primary control does right now.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ComposerSubmitAction {
    Send,
    Preparing,
    Stop,
}

pub(super) fn composer_submit_action(
    status: Option<SessionStatus>,
    preparing: bool,
) -> ComposerSubmitAction {
    if preparing {
        ComposerSubmitAction::Preparing
    } else if status.is_some_and(SessionStatus::is_busy) {
        ComposerSubmitAction::Stop
    } else {
        ComposerSubmitAction::Send
    }
}

impl Tide {
    /// The composer card: autocomplete popup, staged attachments, the field,
    /// and the toolbar with its send/stop control.
    pub(super) fn render_composer(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let session = self.selected_session();
        let preparing = session.is_some_and(|session| {
            self.submission_preparations.contains(&session.id)
                || self.response_fork_preparations.contains_key(&session.id)
        });
        let submit_action =
            composer_submit_action(session.map(|session| session.status), preparing);
        let escape_stop_armed = session.is_some_and(|session| {
            self.escape_stop_confirmation
                .is_armed_for(EscapeStopTarget::for_session(session), Instant::now())
        });
        let has_draft = !self.composer.read(cx).content(cx).trim().is_empty()
            || !self.composer_attachments.is_empty();
        // With no provider to run it, a draft has nowhere to go. The button
        // reads as unavailable and the submission path refuses too, so
        // `enter` cannot slip past a disabled control.
        let no_providers = self.model_picker_has_no_providers();
        let can_send = has_draft && !no_providers;
        let (autocomplete, autocomplete_actionable) =
            match self.render_composer_autocomplete(window, cx) {
                Some((element, actionable)) => (Some(element), actionable),
                None => (None, false),
            };
        let autocomplete_loading = autocomplete.is_some() && !autocomplete_actionable;
        // Files dragged in from the OS light the card up as a drop target and
        // stage as attachment chips. The wash arrives pre-blended because a
        // drag-over refinement replaces the card's fill rather than
        // compositing over it.
        let drop_wash = theme.composer.blend(theme.overlay_strong);
        let drop_ring = theme.accent.opacity(0.7);
        div().flex_none().px(px(20.0)).child(
            div()
                .w_full()
                .max_w(px(CONTENT_MAX_WIDTH))
                .mx_auto()
                .rounded(px(13.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.composer)
                // Horizontal insets live on each row (and inside the field's
                // scroll viewport, via `padding_x`) rather than on the card,
                // so the field's overlay scrollbar can hug the card's edge.
                .py(px(10.0))
                .drag_over::<ExternalPaths>(move |style, _, _, _| {
                    style.bg(drop_wash).border_color(drop_ring)
                })
                .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                    this.stage_dropped_files(paths, window, cx);
                }))
                // Anchor for the bounds probe the autocomplete popup aligns to.
                .relative()
                .child(super::autocomplete::composer_card_bounds_probe(
                    self.composer_autocomplete.card_bounds_cell(),
                ))
                // Only while the popup has selectable rows: the key context
                // routes arrows, `enter`, `tab` and `escape` here as actions,
                // out from under the focused field. The loading state takes
                // only Escape, so it can dismiss without swallowing input.
                .when(autocomplete_actionable, |card| {
                    card.key_context("ComposerAutocomplete")
                        .on_action(cx.listener(|this, _: &SelectNextEntry, window, cx| {
                            this.move_autocomplete_highlight("down", window, cx);
                        }))
                        .on_action(cx.listener(|this, _: &SelectPreviousEntry, window, cx| {
                            this.move_autocomplete_highlight("up", window, cx);
                        }))
                        .on_action(cx.listener(|this, _: &ConfirmEntry, window, cx| {
                            this.accept_autocomplete(None, window, cx);
                        }))
                        .on_action(cx.listener(|this, _: &DismissMenu, _, cx| {
                            this.dismiss_autocomplete(cx);
                        }))
                })
                .when(autocomplete_loading, |card| {
                    card.key_context("ComposerAutocompleteLoading")
                        .on_action(cx.listener(|this, _: &DismissMenu, _, cx| {
                            this.dismiss_autocomplete(cx);
                        }))
                })
                .children(autocomplete)
                .when(!self.composer_attachments.is_empty(), |card| {
                    card.child(self.render_composer_attachments(cx))
                })
                .child(div().pt(px(2.0)).child(self.composer.clone()))
                .child(self.render_composer_toolbar(
                    submit_action,
                    escape_stop_armed,
                    can_send,
                    no_providers,
                    cx,
                )),
        )
    }

    /// The card's bottom row: provider/model and session controls left, the
    /// background-jobs indicator then the send/stop control right. The
    /// indicator takes first position in the right cluster (stage 6) and
    /// adds no control of its own outside its popup.
    fn render_composer_toolbar(
        &self,
        submit_action: ComposerSubmitAction,
        escape_stop_armed: bool,
        can_send: bool,
        no_providers: bool,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        div()
            .mt(px(8.0))
            .px(px(10.0))
            .flex()
            .items_center()
            .gap(px(4.0))
            .text_size(sp(12.5))
            .line_height(sp(14.0))
            .child(self.render_provider_model_control(cx))
            .children(self.render_model_traits_control(cx))
            .child(self.render_interaction_mode_control(cx))
            .children(self.render_goal_control(cx))
            .child(div().flex_1())
            .child(match submit_action {
                ComposerSubmitAction::Preparing => div()
                    .id("send-or-stop")
                    .w(px(26.0))
                    .h(px(26.0))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .bg(theme.overlay_strong)
                    .child(motion::spin(icon(
                        "icons/loader-circle.svg",
                        15.0,
                        theme.text_secondary,
                    )))
                    .tooltip(Tooltip::text(tr!("composer.preparing_task"))),
                ComposerSubmitAction::Stop => div()
                    .id("working-actions")
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .id("send-or-stop")
                            .w(px(26.0))
                            .h(px(26.0))
                            .rounded_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .cursor_default()
                            .bg(theme.overlay_strong)
                            .hover(|element| element.bg(theme.danger_soft))
                            .active(|element| element.opacity(0.8))
                            .when(escape_stop_armed, |element| {
                                element.child(
                                    div()
                                        .text_size(sp(12.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.text)
                                        .child("Esc"),
                                )
                            })
                            .when(!escape_stop_armed, |element| {
                                element.child(icon("icons/stop.svg", 18.0, theme.text))
                            })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.cancel_turn(cx);
                            })),
                    )
                    .when(can_send, |element| {
                        element.child(self.render_queue_follow_up_button(cx))
                    }),
                ComposerSubmitAction::Send => div()
                    .id("send-or-stop")
                    .w(px(26.0))
                    .h(px(26.0))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(if can_send {
                        theme.inverse
                    } else {
                        theme.overlay_strong
                    })
                    .when(can_send, |element| {
                        element
                            .cursor_default()
                            .hover(|element| element.opacity(0.9))
                            .active(|element| element.opacity(0.8))
                    })
                    .child(icon(
                        "icons/arrow-up.svg",
                        16.0,
                        if can_send {
                            theme.on_inverse
                        } else {
                            theme.text_ghost
                        },
                    ))
                    // Says why the button is dead, for the case
                    // the draft is ready and the machine is not.
                    .when(no_providers, |element| {
                        element.tooltip(Tooltip::text(tr!("composer.no_providers")))
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.send_composer_draft(cx);
                    })),
            })
    }

    /// The queued-follow-up round button shown beside Stop while a turn runs
    /// with a draft staged.
    fn render_queue_follow_up_button(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = Theme::current(cx);
        div()
            .id("queue-follow-up")
            .w(px(26.0))
            .h(px(26.0))
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .bg(theme.inverse)
            .hover(|element| element.opacity(0.9))
            .active(|element| element.opacity(0.8))
            .child(icon("icons/arrow-up.svg", 16.0, theme.on_inverse))
            .tooltip(Tooltip::text(tr!("composer.queue_followup")))
            .on_click(cx.listener(|this, _, _, cx| {
                this.send_composer_draft(cx);
            }))
    }

    /// Assemble the staged draft and hand it to the pipeline, clearing the
    /// field exactly when the submission was accepted. Every click route —
    /// send and queue-follow-up alike — lands here.
    fn send_composer_draft(&mut self, cx: &mut Context<Self>) {
        let prompt = self.composer.read(cx).content(cx).to_owned();
        if let Some(submission) = self.submission_with_attachments(&prompt, cx) {
            self.composer.update(cx, |composer, cx| composer.clear(cx));
            self.submit_composer_submission(submission, cx);
        }
    }

    /// The staged-attachment chips above the input: a thumbnail tile per
    /// image, a file-type icon and basename for everything else, each with a
    /// floating remove button — T3 Code's attachment row in graphite.
    fn render_composer_attachments(&self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let mut row = div()
            .px(px(14.0))
            .pt(px(2.0))
            .pb(px(8.0))
            .flex()
            .flex_wrap()
            .gap(px(8.0));
        for (index, attachment) in self.composer_attachments.iter().enumerate() {
            let menu = self.menu_handle(format!("composer-attachment-{index}-menu"), cx);
            let icon_path = if attachment.is_dir {
                "icons/folder.svg"
            } else {
                super::right_panel::file_icon_for_path(&attachment.mention)
            };
            let mut tile = div()
                .id(SharedString::from(format!("composer-attachment-{index}")))
                .relative()
                .w(px(64.0))
                .h(px(64.0))
                .rounded(px(8.0))
                .overflow_hidden()
                .border_1()
                .border_color(theme.border)
                .bg(theme.inset)
                .track_focus(menu.trigger_focus_handle())
                .tab_index(0)
                .focus_visible(|style| style.border_color(theme.accent))
                .tooltip(Tooltip::text(format!("@{}", attachment.mention)));
            let attachment_image = attachment.client_preview_image.clone().or_else(|| {
                attachment
                    .is_image
                    .then(|| {
                        attachment.blob_reference.as_deref().and_then(|reference| {
                            self.image_for_reference(
                                reference,
                                Some(&attachment.path),
                                Some(attachment.name.as_ref()),
                                cx,
                            )
                        })
                    })
                    .flatten()
            });
            let can_reveal = !self.daemon.is_remote();
            if attachment.is_image {
                if let Some(attachment_image) = attachment_image.as_ref() {
                    let preview_image = attachment_image.clone();
                    let preview_name = attachment.name.clone();
                    tile = tile.child(
                        div()
                            .id(SharedString::from(format!(
                                "composer-attachment-{index}-preview"
                            )))
                            .size_full()
                            .cursor_default()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_image_preview(
                                    preview_image.clone(),
                                    preview_name.clone(),
                                    window,
                                    cx,
                                );
                                cx.stop_propagation();
                            }))
                            .child(
                                img(attachment_image.clone())
                                    .size_full()
                                    .object_fit(ObjectFit::Cover),
                            ),
                    );
                } else {
                    tile = tile.child(
                        div()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("icons/file-types/image.svg", 16.0, theme.text_ghost)),
                    );
                }
            } else {
                tile = tile.child(
                    div()
                        .size_full()
                        .px(px(5.0))
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap(px(5.0))
                        .child(icon(icon_path, 16.0, theme.text_tertiary))
                        .child(
                            div().w_full().flex().justify_center().child(
                                div()
                                    .max_w_full()
                                    .truncate()
                                    .text_size(sp(12.5))
                                    .text_color(theme.text_tertiary)
                                    .child(attachment.name.clone()),
                            ),
                        ),
                );
            }
            let key_menu = menu.clone();
            let key_image = attachment_image.clone();
            let key_name = attachment.name.clone();
            let is_image = attachment.is_image;
            tile = tile.on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                let key = event.keystroke.key.as_str();
                if is_image
                    && matches!(key, "enter" | "space")
                    && let Some(key_image) = key_image.as_ref()
                {
                    this.open_image_preview(key_image.clone(), key_name.clone(), window, cx);
                    cx.stop_propagation();
                } else if key == "f10" && event.keystroke.modifiers.shift {
                    key_menu.open_context_menu(window, cx);
                    cx.stop_propagation();
                }
            }));
            let tile = tile.child(
                div()
                    .id(SharedString::from(format!(
                        "composer-attachment-remove-{index}"
                    )))
                    .absolute()
                    .top(px(3.0))
                    .right(px(3.0))
                    .w(px(16.0))
                    .h(px(16.0))
                    .tab_index(0)
                    .rounded(px(5.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .bg(theme.canvas.opacity(0.8))
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|element| element.bg(theme.canvas.opacity(0.95)))
                    .active(|element| element.opacity(0.8))
                    .child(icon("icons/x.svg", 9.0, theme.text_secondary))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        if index < this.composer_attachments.len() {
                            this.composer_attachments.remove(index);
                            this.schedule_composer_draft_save(cx);
                            cx.notify();
                        }
                    }))
                    .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            if index < this.composer_attachments.len() {
                                this.composer_attachments.remove(index);
                                this.schedule_composer_draft_save(cx);
                                cx.notify();
                            }
                            cx.stop_propagation();
                        }
                    })),
            );
            let reveal_path = attachment.path.clone();
            row = row.child(context_menu(
                tile,
                SharedString::from(format!("composer-attachment-{index}-context-menu")),
                &menu,
                move |_| image_preview::attachment_menu_items(reveal_path.clone(), can_reveal),
            ));
        }
        row
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{Context, Entity, TestAppContext, Window, div, prelude::*, px};

    use super::{ChatComposer, ChatComposerEvent};
    use crate::input::init as init_input;

    struct Harness {
        composer: Entity<ChatComposer>,
    }

    impl Render for Harness {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().w(px(300.)).child(self.composer.clone())
        }
    }

    #[gpui::test]
    fn secondary_enter_steers_text_or_activates_the_queue(cx: &mut TestAppContext) {
        cx.update(init_input);
        let (harness, cx) = cx.add_window_view(|window, cx| {
            let composer = cx.new(|cx| ChatComposer::new(window, cx));
            Harness { composer }
        });
        let composer = cx.read_entity(&harness, |harness, _| harness.composer.clone());
        let events: Rc<RefCell<Vec<ChatComposerEvent>>> = Rc::default();
        let sink = events.clone();
        cx.update(|_, cx| {
            cx.subscribe(&composer, move |_, event: &ChatComposerEvent, _| {
                sink.borrow_mut().push(event.clone());
            })
            .detach();
        });
        cx.update(|window, cx| window.focus(&composer.read(cx).focus(), cx));
        cx.run_until_parked();

        cx.simulate_keystrokes("secondary-enter");
        assert!(matches!(
            events.borrow().last(),
            Some(ChatComposerEvent::SteerQueued)
        ));

        composer.update(cx, |composer, cx| composer.set_content("hold on", cx));
        events.borrow_mut().clear();
        cx.simulate_keystrokes("secondary-enter");
        assert!(events.borrow().iter().any(
            |event| matches!(event, ChatComposerEvent::SubmitSteer(text) if text == "hold on")
        ));
        cx.read_entity(&composer, |composer, cx| {
            assert_eq!(composer.content(cx), "")
        });
    }

    /// Stage 6: the toolbar's right cluster puts the background-jobs
    /// indicator FIRST — before the submit control — and nothing else in
    /// the composer renders a jobs control outside its popup.
    #[test]
    fn jobs_indicator_lives_in_the_header_not_the_toolbar() {
        let composer_source = include_str!("chat_composer.rs");
        let toolbar = composer_source
            .split_once("fn render_composer_toolbar(")
            .expect("composer toolbar renderer")
            .1
            .split_once("\n    /// The queued-follow-up round button")
            .expect("toolbar renderer end")
            .0;
        assert!(
            !toolbar.contains("render_header_jobs_pill"),
            "the jobs pill lives in the session header, not the composer toolbar"
        );

        let sidebar_source = include_str!("sidebar.rs");
        let header = sidebar_source
            .split_once("pub(super) fn render_header(")
            .expect("header renderer")
            .1;
        let pill = header
            .find("self.render_header_jobs_pill(cx)")
            .expect("the header renders the background-jobs pill");
        let center = header
            .find("header-center-drag-region")
            .expect("header center drag region");
        assert!(
            pill < center,
            "the pill sits beside the session title, before the center drag region"
        );
    }
}
