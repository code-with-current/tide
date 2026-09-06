//! The user-message bubble — tide's right-aligned chat anatomy. The bubble
//! itself is plain text (markdown arrives with the text-part task) on the
//! raised surface, clamped at ~160px with a bottom mask fade plus a chevron
//! disclosure underneath; a hover-revealed footer under it carries the clock,
//! the edit pencil, and Copy. The pencil swaps the bubble for an inline
//! editor (a `TextInput` entity the pane owns) with Cancel/Send actions; when
//! the edited message is not the last one, Send first arms an inline
//! confirmation naming what the resend removes, computed by [`edit_removals`].
//!
//! The resend itself is wired in `list.rs`: it chains the same Tide methods
//! the legacy user-message footer's rewind button uses (see the send handler
//! there), so the DB rewind, provider rollback, and resubmission all run the
//! app's one battle-tested path.

use super::super::EditingMessage;
use super::super::rows::activity_group::GroupToggle;
use super::super::rows::turn_item::clock_time;
use crate::app::image_preview;
use crate::app::right_panel;
use crate::model::{AgentSession, MessageRole};
use crate::theme::{Theme, sp};
use crate::ui::menu::{ContextMenuHandle, context_menu};
use crate::ui::tooltip::Tooltip;
use crate::ui::{icon, icon_button};
use gpui::prelude::*;
use gpui::{
    ClickEvent, Div, KeyDownEvent, ObjectFit, SharedString, Window, div, img, linear_color_stop,
    linear_gradient, px,
};
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

// ── The folds, pure ──────────────────────────────────────────────────────────

/// What a resend from `editing_index` removes: the assistant replies after
/// the edited message, and the tool runs in transcript blocks anchored after
/// it. `(0, 0)` — including for an out-of-range index — is the immediate-send
/// case that needs no confirmation. A block anchored at `n` renders after the
/// first `n` messages, so "after the edit" is `after_message > editing_index`;
/// blocks the rewind keeps (anchored at or before the message) stay untallied.
/// Later user messages are removed by the rewind too but are not *replies* —
/// only assistant messages count.
pub(crate) fn edit_removals(session: &AgentSession, editing_index: usize) -> (usize, usize) {
    let replies = session
        .messages
        .iter()
        .skip(editing_index + 1)
        .filter(|message| message.role == MessageRole::Assistant)
        .count();
    let tool_runs = session
        .transcript_blocks
        .iter()
        .filter(|block| block.after_message > editing_index)
        .map(|block| block.activities.len())
        .sum();
    (replies, tool_runs)
}

/// The clamp disclosure id — `clamp-{message_id}`, the same synthetic-id rule
/// as the files card and error block: the id names no activity, so the list
/// wires its toggle with a direct row remeasure.
pub(crate) fn clamp_id(message_id: Uuid) -> String {
    format!("clamp-{message_id}")
}

/// The clamp's height budget (padding included): tide's ~160px bubble cap.
pub(crate) const CLAMP_MAX_HEIGHT: f32 = 160.0;
/// The bubble's line height — the estimator's unit.
const USER_LINE_HEIGHT: f32 = 20.0;
/// Characters per wrapped line the estimator assumes at 14sp inside a 540px
/// bubble. A heuristic, not a measurement: it only decides whether the clamp
/// affordance renders, and the clamp itself is `max_h` — content the estimate
/// undershoots simply renders a chevron over short content that expands to
/// nothing more.
const ESTIMATED_LINE_CHARS: usize = 72;

/// Whether the bubble's content plausibly overflows the clamp budget.
pub(crate) fn clamp_needed(content: &str) -> bool {
    if content.trim().is_empty() {
        return false;
    }
    let lines: usize = content
        .lines()
        .map(|line| line.chars().count().div_ceil(ESTIMATED_LINE_CHARS).max(1))
        .sum();
    (lines as f32 * USER_LINE_HEIGHT) > CLAMP_MAX_HEIGHT
}

/// The clamp fade's height — how far the mask gradient reaches up the bubble.
const FADE_HEIGHT: f32 = 28.0;

// ── Renderer ────────────────────────────────────────────────────────────────

/// One click the bubble may ask the app to perform. Built by `list.rs` where
/// the view context lives; the same shape as the activity group's toggles.
pub(crate) type UserBubbleAction = Arc<dyn Fn(&ClickEvent, &mut Window, &mut gpui::App) + 'static>;

/// Every behavior the bubble needs from the app. `edit` opens the editor,
/// `cancel` leaves it, `send` submits (arming the confirmation when the
/// resend removes work), `confirm` submits an armed resend, and `disarm`
/// steps an armed confirmation back to the editor.
#[derive(Clone)]
pub(crate) struct UserBubbleActions {
    pub edit: UserBubbleAction,
    pub cancel: UserBubbleAction,
    pub send: UserBubbleAction,
    pub confirm: UserBubbleAction,
    pub disarm: UserBubbleAction,
}

/// One attachment tile's render data, resolved in `list.rs` (the only depth
/// with the view context): the cached message metadata, the in-memory image
/// once the daemon bytes have landed, and the click/menu wiring. Nothing
/// here probes the filesystem or performs RPC in the frame path.
pub(crate) struct UserBubbleAttachment {
    /// Stable per-message key (`{message_id}-{index}`) naming the tile and
    /// its context menu.
    pub(crate) key: String,
    pub(crate) name: SharedString,
    pub(crate) is_dir: bool,
    pub(crate) is_image: bool,
    /// The resolved image when this tile is an image whose daemon bytes are
    /// already in memory; `None` renders the file-type icon fallback.
    pub(crate) image: Option<Arc<gpui::Image>>,
    /// Click/Enter opens the window-modal preview — images only, and only
    /// once the bytes are in memory.
    pub(crate) open_preview: Option<UserBubbleAction>,
    /// The context menu (Reveal in Finder), cached by the app-level menu
    /// registry the same way the legacy attachment tiles cache theirs.
    pub(crate) menu: ContextMenuHandle,
    pub(crate) reveal_path: PathBuf,
    pub(crate) can_reveal: bool,
}

/// The user message: right-aligned column (the legacy pane's grouping —
/// hover reveals the footer) holding either the bubble plus its hover footer
/// or, while editing, the editor card that replaces both.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_user_bubble(
    message_id: Uuid,
    content: &str,
    created_at: u64,
    clamp_expanded: bool,
    editable: bool,
    editing: Option<&EditingMessage>,
    attachments: &[UserBubbleAttachment],
    theme: &Theme,
    actions: UserBubbleActions,
    toggle_clamp: GroupToggle,
) -> Div {
    let group = SharedString::from(format!("user-message-{message_id}"));
    let mut column = div()
        .w_full()
        .flex()
        .flex_col()
        .items_end()
        .gap(px(3.0))
        .group(group.clone());

    // The attachments row stands above both the bubble and the editor —
    // the legacy pane's placement, so an edit still shows what a resend
    // carries.
    if let Some(attachments) = render_bubble_attachments(attachments, theme) {
        column = column.child(attachments);
    }
    match editing {
        // Edit mode: the editor card stands in for the bubble and its footer
        // (the legacy pane hides the footer while editing too).
        Some(editing) => {
            column = column.child(editor_card(message_id, editing, theme, &actions));
        }
        None => {
            if !content.trim().is_empty() {
                column = column.child(user_bubble(content, clamp_expanded, theme));
                if clamp_needed(content) {
                    column = column.child(clamp_chevron(
                        message_id,
                        clamp_expanded,
                        theme,
                        toggle_clamp,
                    ));
                }
            }
            column = column.child(user_hover_footer(
                message_id,
                created_at,
                editable,
                content,
                group,
                theme,
                actions.edit,
            ));
        }
    }
    column
}

/// The bubble: raised surface, 12px radius (the legacy user branch's number),
/// plain text at the legacy's 14sp/20sp with newlines rendered as-is.
fn user_bubble(content: &str, expanded: bool, theme: &Theme) -> Div {
    let clamped = clamp_needed(content) && !expanded;
    let surface = theme.raised;
    div()
        .relative()
        .max_w(px(540.0))
        .min_w_0()
        .rounded(px(12.0))
        .bg(theme.raised)
        .px(px(14.0))
        .py(px(10.0))
        .text_size(sp(14.0))
        .line_height(sp(20.0))
        .text_color(theme.text)
        .when(clamped, |bubble| {
            bubble
                .max_h(px(CLAMP_MAX_HEIGHT))
                .overflow_hidden()
                // The mask fade: a bottom gradient back into the bubble's own
                // surface, so the clamped text dissolves instead of cutting.
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom_0()
                        .h(px(FADE_HEIGHT))
                        .bg(linear_gradient(
                            180.0,
                            linear_color_stop(surface.opacity(0.0), 0.0),
                            linear_color_stop(surface, 1.0),
                        )),
                )
        })
        .child(SharedString::from(content))
}

/// The attachment tiles under a user message: 96×80 tiles right-aligned by
/// the column's `items_end` — the legacy pane's tile anatomy. A resolved
/// image fills its tile and click/Enter opens the window-modal preview;
/// everything else shows its file-type icon and name. Every tile is
/// keyboard operable: focusable, Enter opens the preview, Shift+F10 its
/// Reveal-in-Finder menu.
fn render_bubble_attachments(attachments: &[UserBubbleAttachment], theme: &Theme) -> Option<Div> {
    if attachments.is_empty() {
        return None;
    }
    let mut row = div()
        .max_w(px(540.0))
        .flex()
        .flex_wrap()
        .justify_end()
        .gap(px(8.0));
    for attachment in attachments {
        let icon_path = if attachment.is_dir {
            "icons/folder.svg"
        } else {
            right_panel::file_icon_for_path(&attachment.name)
        };
        let key = attachment.key.as_str();
        let mut tile = div()
            .id(SharedString::from(format!("bubble-attachment-{key}")))
            .w(px(96.0))
            .h(px(80.0))
            .rounded(px(9.0))
            .overflow_hidden()
            .border_1()
            .border_color(theme.border)
            .bg(theme.inset)
            .track_focus(attachment.menu.trigger_focus_handle())
            .tab_index(0)
            .focus_visible(|style| style.border_color(theme.accent))
            .tooltip(Tooltip::text(attachment.name.clone()));
        if attachment.is_image {
            let menu = attachment.menu.clone();
            if let (Some(image), Some(open_preview)) =
                (attachment.image.as_ref(), attachment.open_preview.clone())
            {
                tile = tile
                    .child(img(image.clone()).size_full().object_fit(ObjectFit::Cover))
                    .cursor_default()
                    .on_click({
                        let open_preview = open_preview.clone();
                        move |event, window, cx| open_preview(event, window, cx)
                    })
                    .on_key_down(move |event: &KeyDownEvent, window, cx| {
                        let key = event.keystroke.key.as_str();
                        if matches!(key, "enter" | "space") {
                            // The keyboard activation path carries a
                            // keyboard click event, the same synthetic
                            // value a real Enter click delivers.
                            open_preview(&ClickEvent::default(), window, cx);
                            cx.stop_propagation();
                        } else if key == "f10" && event.keystroke.modifiers.shift {
                            menu.open_context_menu(window, cx);
                            cx.stop_propagation();
                        }
                    });
            } else {
                tile = tile
                    .child(
                        div()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("icons/file-types/image.svg", 18.0, theme.text_ghost)),
                    )
                    .on_key_down(move |event: &KeyDownEvent, window, cx| {
                        if event.keystroke.key == "f10" && event.keystroke.modifiers.shift {
                            menu.open_context_menu(window, cx);
                            cx.stop_propagation();
                        }
                    });
            }
        } else {
            let menu = attachment.menu.clone();
            tile = tile
                .child(
                    div()
                        .size_full()
                        .px(px(7.0))
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap(px(7.0))
                        .child(icon(icon_path, 18.0, theme.text_tertiary))
                        .child(
                            div()
                                .w_full()
                                .truncate()
                                .text_center()
                                .text_size(sp(12.5))
                                .text_color(theme.text_secondary)
                                .child(attachment.name.clone()),
                        ),
                )
                .on_key_down(move |event: &KeyDownEvent, window, cx| {
                    if event.keystroke.key == "f10" && event.keystroke.modifiers.shift {
                        menu.open_context_menu(window, cx);
                        cx.stop_propagation();
                    }
                });
        }
        let reveal_path = attachment.reveal_path.clone();
        let can_reveal = attachment.can_reveal;
        row = row.child(context_menu(
            tile,
            SharedString::from(format!("bubble-attachment-menu-{key}")),
            &attachment.menu,
            move |_| image_preview::attachment_menu_items(reveal_path.clone(), can_reveal),
        ));
    }
    Some(row)
}

/// The clamp's expand/collapse chevron, under the bubble and right-aligned
/// with it by the column's `items_end`. The whole row toggles; expanded reads
/// chevron-up (collapse), collapsed chevron-down (expand).
fn clamp_chevron(
    message_id: Uuid,
    expanded: bool,
    theme: &Theme,
    toggle: GroupToggle,
) -> gpui::Stateful<Div> {
    let id = clamp_id(message_id);
    div()
        .id(SharedString::from(format!("clamp-toggle-{message_id}")))
        .h(px(20.0))
        .px(px(4.0))
        .flex()
        .items_center()
        .rounded(px(6.0))
        .cursor_pointer()
        .hover(|style| style.bg(theme.overlay))
        .child(icon(
            if expanded {
                "icons/chevron-up.svg"
            } else {
                "icons/chevron-down.svg"
            },
            11.0,
            theme.text_ghost,
        ))
        .on_click(move |event, window, cx| toggle(&id, event, window, cx))
}

/// The hover footer: clock first, then the pencil (hidden while the session
/// cannot rewind — the pencil's `editable` flag is the list's gate), then
/// Copy. Revealed by the column's hover group; the clipboard write lives here
/// because click handlers receive the app context.
#[allow(clippy::too_many_arguments)]
fn user_hover_footer(
    message_id: Uuid,
    created_at: u64,
    editable: bool,
    content: &str,
    group: SharedString,
    theme: &Theme,
    on_edit: UserBubbleAction,
) -> Div {
    let clock = clock_time(created_at);
    let mut row = div()
        .h(px(24.0))
        .flex()
        .items_center()
        .gap(px(4.0))
        .invisible()
        .group_hover(group, |style| style.visible());

    if !clock.is_empty() {
        row = row.child(
            div()
                .text_size(sp(11.0))
                .text_color(theme.text_ghost)
                .child(SharedString::from(clock)),
        );
    }
    if editable {
        row = row.child(
            icon_button(
                SharedString::from(format!("user-edit-{message_id}")),
                "icons/pencil.svg",
                *theme,
            )
            .tooltip(Tooltip::text(tr!("session.edit_message")))
            .on_click(move |event, window, cx| on_edit(event, window, cx)),
        );
    }
    let copy_text = content.to_owned();
    row.child(
        icon_button(
            SharedString::from(format!("user-copy-{message_id}")),
            "icons/copy.svg",
            *theme,
        )
        .tooltip(Tooltip::text(tr!("common.copy_message")))
        .on_click(move |_, _, cx| {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy_text.clone()));
        }),
    )
}

/// The editor card that replaces the bubble: the pane's `TextInput` entity
/// over the actions row (Cancel/Send, or the armed confirmation's counts plus
/// Confirm/Cancel). The entity travels inside [`EditingMessage`]; this
/// renderer only places it.
fn editor_card(
    message_id: Uuid,
    editing: &EditingMessage,
    theme: &Theme,
    actions: &UserBubbleActions,
) -> Div {
    div()
        .w_full()
        .max_w(px(540.0))
        .rounded(px(12.0))
        .bg(theme.raised)
        .pt(px(9.0))
        .pb(px(8.0))
        .child(div().px(px(12.0)).child(editing.input.clone()))
        .child(editor_actions_row(
            message_id,
            editing.confirm_removals,
            theme,
            actions,
        ))
}

/// The editor's action row, headlessly testable apart from the input entity.
/// Disarmed: a quiet Cancel and an accent-bordered Send with the check glyph
/// — the skills-screen bordered idiom, tinted primary. Armed by a removal
/// count: the warning line "Resend will remove N replies · M tool runs" with
/// Confirm in the primary style and Cancel stepping back to the editor.
pub(crate) fn editor_actions_row(
    message_id: Uuid,
    confirm: Option<(usize, usize)>,
    theme: &Theme,
    actions: &UserBubbleActions,
) -> Div {
    match confirm {
        None => div()
            .mt(px(7.0))
            .px(px(12.0))
            .flex()
            .justify_end()
            .gap(px(6.0))
            .child(editor_action(
                format!("user-edit-cancel-{message_id}"),
                "icons/x.svg",
                tr!("common.cancel"),
                theme.border,
                theme.text_secondary,
                theme,
                actions.cancel.clone(),
            ))
            .child(editor_action(
                format!("user-edit-send-{message_id}"),
                "icons/check.svg",
                tr!("common.send"),
                theme.accent,
                theme.accent,
                theme,
                actions.send.clone(),
            )),
        Some((replies, tool_runs)) => div()
            .mt(px(7.0))
            .px(px(12.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(sp(11.5))
                    .line_height(sp(16.0))
                    .text_color(theme.warning)
                    .child(SharedString::from(tr!(
                        "session.resend_removes",
                        replies = replies,
                        tool_runs = tool_runs
                    ))),
            )
            .child(editor_action(
                format!("user-edit-disarm-{message_id}"),
                "icons/x.svg",
                tr!("common.cancel"),
                theme.border,
                theme.text_secondary,
                theme,
                actions.disarm.clone(),
            ))
            .child(editor_action(
                format!("user-edit-confirm-{message_id}"),
                "icons/check.svg",
                tr!("common.confirm"),
                theme.accent,
                theme.accent,
                theme,
                actions.confirm.clone(),
            )),
    }
}

/// One 26px bordered action button: h26 px10 rounded 7, a leading glyph, and
/// the label — quiet (`border`/secondary) or primary (accent border and text).
fn editor_action(
    id: String,
    icon_path: &'static str,
    label: String,
    border: gpui::Hsla,
    tint: gpui::Hsla,
    theme: &Theme,
    on_click: UserBubbleAction,
) -> gpui::Stateful<Div> {
    div()
        .id(SharedString::from(id))
        .h(px(26.0))
        .px(px(10.0))
        .rounded(px(7.0))
        .border_1()
        .border_color(border)
        .flex_none()
        .flex()
        .items_center()
        .gap(px(5.0))
        .cursor_default()
        .text_size(sp(12.5))
        .text_color(tint)
        .hover(|style| style.bg(theme.overlay))
        .child(icon(icon_path, 11.0, tint.opacity(0.8)))
        .child(SharedString::from(label))
        .on_click(move |event, window, cx| on_click(event, window, cx))
}
