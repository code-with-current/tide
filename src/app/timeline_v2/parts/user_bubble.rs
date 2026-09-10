//! The user-message bubble — tide's right-aligned chat anatomy. The bubble
//! itself is plain text (markdown arrives with the text-part task) on the
//! raised surface, clamped at ~160px with a bottom mask fade and an ellipsis
//! pinned to the cut; the clamp chevron shares one row under the bubble with
//! the hover-revealed footer (the clock, the edit pencil, and Copy). The
//! pencil swaps the bubble for an inline
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
use crate::md::render::{self, FlatText, TranscriptSelection};
use crate::md::selection::TextKey;
use crate::model::{AgentSession, MessageRole};
use crate::theme::{Theme, sp};
use crate::ui::menu::{ContextMenuHandle, context_menu};
use crate::ui::tooltip::Tooltip;
use crate::ui::{icon, icon_button};
use gpui::prelude::*;
use gpui::{
    ClickEvent, Div, FontWeight, Hsla, KeyDownEvent, ObjectFit, SharedString, TextRun,
    UnderlineStyle, Window, div, font, img, linear_color_stop, linear_gradient, px,
};
use std::collections::HashMap;
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use uuid::Uuid;

// ── Mentions, pure ───────────────────────────────────────────────────────────

/// What a mention token refers to: an `@path` file reference or a line-leading
/// `/skill` invocation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MentionKind {
    File,
    Skill,
}

/// One mention token found in a user message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Mention {
    pub kind: MentionKind,
    /// Byte range of the token exactly as typed, sigil included — the pill
    /// paints behind these bytes and nothing around them.
    pub range: Range<usize>,
}

/// One mention's resolved presentation: the hover label plus, when the
/// mention should act as a link, the link's target (an absolute path the
/// transcript's link router resolves). Built in `list.rs` where the
/// workspace root and the skills catalog live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MentionResolution {
    pub label: String,
    /// Absolute path the pill opens on click; `None` renders a label-only
    /// pill.
    pub target: Option<String>,
}

/// Resolve a mention token (sigil included) to its hover label and click
/// target — the file's absolute path, or the skill's SKILL.md location.
pub(crate) type MentionResolver = Arc<dyn Fn(&str) -> Option<MentionResolution> + 'static>;

/// The `@path` and `/skill` tokens a user message carries, in document order.
///
/// The same tokens the composer and the driver recognize: an `@` mention is a
/// token-boundary `@` followed by a path (quoted when it holds whitespace),
/// and only counts when the path looks pathy (`/` or `.` inside — prose
/// `@handle` shoutouts stay plain text); a skill mention is a `/name` at the
/// START of a line, alphanumeric-led, and may span spaces when a catalog
/// skill carries that multi-word name (matched longest-first,
/// case-insensitively). Trailing sentence punctuation stays outside the pill.
pub(crate) fn parse_mentions(content: &str) -> Vec<Mention> {
    parse_mentions_with_skills(content, &[])
}

/// [`parse_mentions`], with the skills catalog's names available: a
/// line-leading `/` first tries the longest catalog name the text carries
/// verbatim (so "AgentDB Advanced Features" pills whole), then falls back to
/// the single-segment heuristic.
pub(crate) fn parse_mentions_with_skills(content: &str, skill_names: &[String]) -> Vec<Mention> {
    let bytes = content.as_bytes();
    let mut mentions = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        let boundary = index == 0 || bytes[index - 1].is_ascii_whitespace();
        if !boundary {
            index += 1;
            continue;
        }
        let ended = match bytes[index] {
            b'@' => file_mention_end(content, index).map(|end| (MentionKind::File, end)),
            b'/' if index == 0 || bytes[index - 1] == b'\n' => {
                skill_mention_end(content, index, skill_names)
                    .map(|end| (MentionKind::Skill, end))
            }
            _ => None,
        };
        match ended {
            Some((kind, end)) => {
                mentions.push(Mention {
                    kind,
                    range: index..end,
                });
                index = end;
            }
            None => index += 1,
        }
    }
    mentions
}

/// End of an `@path` token starting at `at` (the `@`'s index), or `None` when
/// the token is not path-shaped enough to pill. Handles the composer's
/// `@"quoted path"` form for whitespace-bearing paths.
fn file_mention_end(content: &str, at: usize) -> Option<usize> {
    let rest = &content[at + 1..];
    let first = rest.chars().next()?;
    if first.is_whitespace() {
        return None;
    }
    let end = if first == '"' {
        rest[1..].find('"')? + 2
    } else {
        rest.find(char::is_whitespace).unwrap_or(rest.len())
    };
    let token = rest[..end].trim_end_matches(['.', ',', ';', ':', '!', '?', ')']);
    let path = token.trim_matches('"');
    if path.is_empty() || !(path.contains('/') || path.contains('.')) {
        return None;
    }
    Some(at + 1 + token.len())
}

/// End of a line-leading `/skill` token starting at `at`, or `None` when the
/// token is not a skill invocation (paths like `/usr/bin` have segments,
/// `/etc`-style tokens do not start alphanumeric).
fn skill_mention_end(content: &str, at: usize, skill_names: &[String]) -> Option<usize> {
    let rest = &content[at + 1..];
    // Catalog names win longest-first, so a multi-word skill name ("AgentDB
    // Advanced Features") pills whole instead of splitting at its first
    // space.
    let mut longest: Option<usize> = None;
    for name in skill_names {
        let Some(candidate) = rest.get(..name.len()) else {
            continue;
        };
        let followed_by_edge = rest[name.len()..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace);
        if followed_by_edge && candidate.eq_ignore_ascii_case(name) {
            let end = at + 1 + name.len();
            longest = Some(longest.map_or(end, |current: usize| current.max(end)));
        }
    }
    if let Some(end) = longest {
        return Some(end);
    }
    let raw_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let name = rest[..raw_end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
    let led = name.chars().next().is_some_and(|c| c.is_alphanumeric());
    if !led || name.contains('/') {
        return None;
    }
    Some(at + 1 + name.len())
}

/// Styled runs tiling the whole message: mention tokens as markdown links —
/// accent text over an accent underline, the same run decoration
/// [`render::flatten`] gives `[](..)` links, and one that changes no glyph or
/// row height — while everything else stays in the plain bubble color. The
/// runs must tile the string exactly — the shape engine reads `len` as raw
/// bytes.
pub(crate) fn mention_runs(
    content: &str,
    mentions: &[Mention],
    base: Hsla,
    accent: Hsla,
) -> Vec<TextRun> {
    let run = |len: usize, color: Hsla, underline: Option<UnderlineStyle>| TextRun {
        len,
        font: font(render::SANS_FAMILY),
        color,
        background_color: None,
        underline,
        strikethrough: None,
    };
    let mut runs = Vec::with_capacity(mentions.len() * 2 + 1);
    let mut cursor = 0usize;
    for mention in mentions {
        if mention.range.start > cursor {
            runs.push(run(mention.range.start - cursor, base, None));
        }
        // The link affordance on the label: an underline in the same accent
        // as the text, so `@index.ts` reads as `[@index.ts](./index.ts)`
        // without moving a single glyph.
        runs.push(run(
            mention.range.len(),
            accent,
            Some(UnderlineStyle {
                color: Some(accent),
                thickness: px(1.0),
                wavy: false,
            }),
        ));
        cursor = mention.range.end;
    }
    if cursor < content.len() {
        runs.push(run(content.len() - cursor, base, None));
    }
    runs
}

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
    selection: TranscriptSelection,
    theme: &Theme,
    actions: UserBubbleActions,
    toggle_clamp: GroupToggle,
    mention_resolver: Option<MentionResolver>,
    skill_names: Vec<String>,
    link_handler: Option<render::LinkHandler>,
) -> Div {
    let group = SharedString::from(format!("user-message-{message_id}"));
    let mut column = div()
        .w_full()
        .flex()
        .flex_col()
        .items_end()
        .gap(px(3.0))
        .mt(px(12.0))
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
            let has_content = !content.trim().is_empty();
            if has_content {
                column = column.child(user_bubble(
                    message_id,
                    content,
                    clamp_expanded,
                    theme,
                    selection,
                    mention_resolver,
                    &skill_names,
                    link_handler,
                ));
            }
            // The clamp chevron lives in the footer's one row — visible
            // without hover whenever the clamp is on, so the disclosure
            // never depends on pointing at the bubble.
            let clamp =
                (has_content && clamp_needed(content)).then(|| (clamp_expanded, toggle_clamp));
            column = column.child(user_hover_footer(
                message_id,
                created_at,
                editable,
                content,
                group,
                theme,
                actions.edit,
                clamp,
            ));
        }
    }
    column
}

/// The bubble: raised surface, 12px radius (the legacy user branch's number),
/// plain text at the legacy's 14sp/20sp with newlines rendered as-is. The
/// text registers with the transcript selection, so drag-select and Copy
/// work across it the same as assistant markdown.
///
/// `@path` and `/skill` tokens render as markdown links: the token keeps its
/// glyphs but reads as `[@index.ts](./index.ts)` — a rounded accent wash
/// behind it (the inline-code paint path), the token itself in accent color
/// over an accent underline, and a hover tooltip resolved through
/// `mention_resolver` (the file's absolute path, or the skill's SKILL.md
/// location) standing in for the link target. Underline included, it is all
/// paint — wrapping, selection, and the clamp estimator see plain text.
fn user_bubble(
    message_id: Uuid,
    content: &str,
    clamp_expanded: bool,
    theme: &Theme,
    selection: TranscriptSelection,
    mention_resolver: Option<MentionResolver>,
    skill_names: &[String],
    link_handler: Option<render::LinkHandler>,
) -> Div {
    let clamped = clamp_needed(content) && !clamp_expanded;
    let key = TextKey::new(format!("user-bubble-{message_id}"), 0);
    let mentions = parse_mentions_with_skills(content, skill_names);
    let mut labels: HashMap<usize, SharedString> = HashMap::new();
    let mut links: Vec<(Range<usize>, String)> = Vec::new();
    if let Some(resolver) = mention_resolver.as_deref() {
        for mention in &mentions {
            let token = &content[mention.range.clone()];
            if let Some(resolution) = resolver(token) {
                labels.insert(mention.range.start, SharedString::from(resolution.label));
                if let Some(target) = resolution.target {
                    links.push((mention.range.clone(), target));
                }
            }
        }
    }
    let flat = if mentions.is_empty() {
        render::flatten_plain(content, render::SANS_FAMILY, FontWeight::NORMAL, theme.text)
    } else {
        FlatText {
            text: SharedString::from(content.to_owned()),
            runs: mention_runs(content, &mentions, theme.text, theme.accent),
            links,
            code_ranges: mentions.iter().map(|m| m.range.clone()).collect(),
        }
    };
    let text = if mentions.is_empty() {
        render::selectable_flat_text(
            &flat,
            key,
            selection,
            theme.code_wash,
            theme.selection,
            false,
        )
    } else {
        render::selectable_mention_text(
            &flat,
            mentions.iter().map(|m| m.range.clone()).collect(),
            Rc::new(labels),
            key,
            selection,
            theme.accent.opacity(0.12),
            theme.selection,
            link_handler,
        )
    };
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
                // The ellipsis: pinned to the cut on the surface-colored
                // padding slot, so the clamp reads as "there is more" rather
                // than text merely ending. The wash masks the faded glyphs
                // behind it.
                .child(
                    div()
                        .absolute()
                        .right_0()
                        .bottom_0()
                        .pb(px(10.0))
                        .pr(px(14.0))
                        .pl(px(6.0))
                        .bg(surface)
                        .text_size(sp(14.0))
                        .line_height(sp(20.0))
                        .text_color(theme.text)
                        .child("…"),
                )
        })
        .child(text)
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

/// The clamp's expand/collapse chevron, rightmost in the footer row so it
/// sits under the bubble's ellipsis corner. The whole button toggles;
/// expanded reads chevron-up (collapse), collapsed chevron-down (expand).
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

/// The one row under the bubble: the clamp chevron (always visible when the
/// clamp is on, rightmost so it sits under the bubble's ellipsis corner)
/// sharing the line with the hover-revealed clock, pencil, and Copy. The
/// clipboard write lives here because click handlers receive the app context.
#[allow(clippy::too_many_arguments)]
fn user_hover_footer(
    message_id: Uuid,
    created_at: u64,
    editable: bool,
    content: &str,
    group: SharedString,
    theme: &Theme,
    on_edit: UserBubbleAction,
    clamp: Option<(bool, GroupToggle)>,
) -> Div {
    let clock = clock_time(created_at);
    let mut items = div()
        .flex()
        .items_center()
        .gap(px(4.0))
        .invisible()
        .group_hover(group, |style| style.visible());

    if !clock.is_empty() {
        items = items.child(
            div()
                .text_size(sp(11.0))
                .text_color(theme.text_ghost)
                .child(SharedString::from(clock)),
        );
    }
    if editable {
        items = items.child(
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
    let items = items.child(
        icon_button(
            SharedString::from(format!("user-copy-{message_id}")),
            "icons/copy.svg",
            *theme,
        )
        .tooltip(Tooltip::text(tr!("common.copy_message")))
        .on_click(move |_, _, cx| {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy_text.clone()));
        }),
    );
    let mut row = div()
        .h(px(24.0))
        .flex()
        .items_center()
        .gap(px(4.0))
        .child(items);
    if let Some((expanded, toggle)) = clamp {
        row = row.child(clamp_chevron(message_id, expanded, theme, toggle));
    }
    row
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
