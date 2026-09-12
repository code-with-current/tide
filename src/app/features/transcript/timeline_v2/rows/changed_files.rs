//! The turn's file changes: a count reading over a card holding a
//! horizontally wrapping list of content-sized file pills — path plus the
//! file's "+n/−m", the path capped at 20 trailing characters behind a
//! leading ellipsis — budgeted with an expander when the turn touched more
//! files than the collapsed list shows. A pill's click opens the diff
//! viewer; its right click opens a context menu (Open, Open Diff) on a
//! handle `list.rs` builds through the app's menu registry.
//!
//! The fold is pure — [`summarize_changes`] collects the turn's prepared
//! `ActivityFileChange`s, dedupes by path summing stats, and sorts created
//! files ahead of edited ones (alphabetical inside each bucket) — so the
//! row reads from one small summary struct instead of rewalking the blocks
//! every frame. Expansion rides the pane's disclosure set under a synthetic
//! turn-anchored id; because the id names no activity, `list.rs` wires the
//! toggle with a direct remeasure (the synthetic-id pattern).

use super::super::{
    TranscriptActions, relative_display, tools_description, tools_dim, tools_title,
};
use super::activity_group::GroupToggle;
use crate::model::{ActivityFileChange, ActivityFileChangeStatus};
use crate::theme::{Theme, sp};
use crate::ui::menu::{ContextMenuHandle, MenuItem, context_menu};
use crate::ui::tooltip::Tooltip;
use gpui::prelude::*;
use gpui::{AnyElement, Div, FontWeight, SharedString, div, px};
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

// ── The fold ────────────────────────────────────────────────────────────────

/// One file's folded stats — the card's unit of display. Paths clone in
/// (a summary owns its strings) so the struct borrows nothing and the
/// renderer never ties a frame to a block's lifetime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChangedFileSummary {
    /// The path exactly as the provider's change carried it; relativization
    /// against the workspace happens at render, not in the fold.
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
    /// A file the turn created — [`ActivityFileChangeStatus::Added`] on any
    /// of its changes. Everything else (modified, deleted, unstated) reads as
    /// edited: the card's binary is created-or-edited, and a deletion is
    /// still work on an existing file.
    pub created: bool,
}

/// The whole turn's file work, folded once per render: the per-file rows and
/// the totals the header reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ChangesSummary {
    /// Deduped by path, created first then alphabetical.
    pub files: Vec<ChangedFileSummary>,
    /// How many of `files` are created.
    pub created: usize,
    /// How many are not — `files.len() - created`, folded so the header
    /// reads totals without recounting.
    pub edited: usize,
    /// Summed additions across every file.
    pub additions: u64,
    /// Summed deletions across every file.
    pub deletions: u64,
}

/// Fold the turn's prepared file changes into one summary: dedupe by path
/// (summing stats, keeping created sticky once any change claimed it), sort
/// created-first then alphabetical, and total everything the header shows.
/// Accepts any iterator of references — `list.rs` feeds the references it
/// gathered from the turn's blocks; tests feed slices.
pub(crate) fn summarize_changes<'a>(
    changes: impl IntoIterator<Item = &'a ActivityFileChange>,
) -> ChangesSummary {
    let mut files: Vec<ChangedFileSummary> = Vec::new();
    for change in changes {
        // A file the turn touched twice (edit then re-edit) folds into one
        // row whose stats are the sum; insertion order holds until the sort.
        if let Some(file) = files.iter_mut().find(|file| file.path == change.path) {
            file.additions += change.additions.unwrap_or(0);
            file.deletions += change.deletions.unwrap_or(0);
            file.created |= is_created(change);
        } else {
            files.push(ChangedFileSummary {
                path: change.path.clone(),
                additions: change.additions.unwrap_or(0),
                deletions: change.deletions.unwrap_or(0),
                created: is_created(change),
            });
        }
    }
    files.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.path.cmp(&b.path)));
    let created = files.iter().filter(|file| file.created).count();
    let additions = files.iter().map(|file| file.additions).sum();
    let deletions = files.iter().map(|file| file.deletions).sum();
    ChangesSummary {
        edited: files.len() - created,
        files,
        created,
        additions,
        deletions,
    }
}

/// Whether one change claims its file was created. `Deleted` and `Modified`
/// both read as edited — the chip's binary — and a provider that said
/// nothing (`None`) does not overclaim.
fn is_created(change: &ActivityFileChange) -> bool {
    matches!(change.status, Some(ActivityFileChangeStatus::Added))
}

// ── Header/list text, pure ──────────────────────────────────────────────────

/// The header's count reading: "1 file changed" / "N files changed".
pub(crate) fn header_title(files: usize) -> String {
    if files == 1 {
        "1 file changed".to_owned()
    } else {
        format!("{files} files changed")
    }
}

/// The collapsed list's budget — the most pills the row shows before the
/// inline "See More" affordance names the rest.
pub(crate) const MAX_VISIBLE_FILES: usize = 5;

/// How many pills render, and how many the trailing "See More" affordance
/// names. Expanded shows everything; at or under the budget everything fits
/// with no affordance; over the budget the collapsed list shows the budget
/// and the affordance counts the rest.
pub(crate) fn visible_files(total: usize, expanded: bool) -> (usize, Option<usize>) {
    if expanded || total <= MAX_VISIBLE_FILES {
        (total, None)
    } else {
        (MAX_VISIBLE_FILES, Some(total - MAX_VISIBLE_FILES))
    }
}

/// The most path text a pill shows, in characters — a string-level budget,
/// so a pill's width is bounded no matter how long the filename is and no
/// layout machinery is trusted to truncate in time.
pub(crate) const PILL_PATH_MAX_CHARS: usize = 20;

/// The pill's path reading: the display path as-is when it fits the
/// [`PILL_PATH_MAX_CHARS`] budget, otherwise only its trailing 20 characters
/// behind a leading "…" (char-boundary safe, so the extension survives).
pub(crate) fn pill_path_text(display: &str) -> String {
    let count = display.chars().count();
    if count <= PILL_PATH_MAX_CHARS {
        return display.to_owned();
    }
    let tail: String = display.chars().skip(count - PILL_PATH_MAX_CHARS).collect();
    format!("…{tail}")
}

/// The card's disclosure id. The turn's uuid anchors it — the same stability
/// rule as [`super::activity_group::group_id`]: ids must survive re-anchoring
/// folds, and a turn id never moves once the turn settles.
pub(crate) fn files_card_id(turn_id: Uuid) -> String {
    format!("files-{turn_id}")
}

// ── Renderer ────────────────────────────────────────────────────────────────

/// The pill's width cap: pills size to their content, and the path text's
/// 20-character budget ([`pill_path_text`]) already bounds them — this only
/// guards a pathological stat run.
const PILL_MAX_WIDTH: f32 = 300.0;
const PILL_HEIGHT: f32 = 26.0;

/// The turn's file changes, container-free: the count reading over a
/// horizontally wrapping list of fixed-width file pills, with the budget
/// expander closing the list when the turn touched more files than the
/// collapsed budget shows. `id` is the row's disclosure id
/// ([`files_card_id`]); the expander's click arrives as the
/// [`GroupToggle`] only `list.rs` can build, and `menus` carries one
/// context-menu handle per file, in the same order as `summary.files`.
pub(crate) fn render_changed_files(
    summary: &ChangesSummary,
    workspace: &Path,
    actions: &TranscriptActions,
    theme: &Theme,
    expanded: bool,
    id: &str,
    toggle: GroupToggle,
    menus: &[ContextMenuHandle],
) -> Div {
    let (shown, hidden) = visible_files(summary.files.len(), expanded);

    let mut section = div()
        .w_full()
        .mt(px(4.0))
        .flex()
        .flex_col()
        .gap(px(6.0))
        .border_1()
        .border_color(theme.border)
        .rounded(px(8.0))
        .bg(theme.raised)
        .px(px(12.0))
        .py(px(8.0))
        .child(
            div()
                .h(px(PILL_HEIGHT))
                .flex()
                .items_center()
                .text_size(sp(13.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(tools_title(theme))
                .child(SharedString::from(format!(
                    "{}:",
                    header_title(summary.files.len())
                ))),
        );

    if !summary.files.is_empty() {
        let mut pills = div().w_full().flex().flex_wrap().gap(px(4.0)).children(
            summary.files[..shown].iter().enumerate().map(|(ix, file)| {
                render_file_pill(file, workspace, actions, theme, id, ix, menus.get(ix))
            }),
        );
        // The affordance rides inline at the end of the list — the last
        // pill in the wrapping row, never a line of its own: collapsed it
        // is "See More" naming what the budget cut; expanded it stays as
        // "Show less" so a reader is never stranded at full depth.
        if summary.files.len() > MAX_VISIBLE_FILES {
            let label = match hidden {
                Some(hidden) => format!("See More ({hidden})"),
                None => "Show less".to_owned(),
            };
            pills = pills.child(render_expander(label, id, theme, toggle));
        }
        section = section.child(pills);
    }
    section
}

/// One file pill: width from its content — the path text is capped at 20
/// trailing characters behind a leading "…" ([`pill_path_text`]), with the
/// full display path on the hover tooltip, so the text can never overflow
/// the pill or the "+n/−m" halves beside it (zero halves omitted, absent
/// when the change carried no stats). Left click opens the diff viewer;
/// right click opens the context menu — Open, Open Diff — on the handle
/// `menu` carries.
fn render_file_pill(
    file: &ChangedFileSummary,
    workspace: &Path,
    actions: &TranscriptActions,
    theme: &Theme,
    id: &str,
    ix: usize,
    menu: Option<&ContextMenuHandle>,
) -> AnyElement {
    let display = relative_display(workspace, &file.path);
    let path = pill_path_text(&display);
    let mut pill = div()
        .id(SharedString::from(format!("files-pill-{id}-{ix}")))
        .max_w(px(PILL_MAX_WIDTH))
        .h(px(PILL_HEIGHT))
        .flex()
        .items_center()
        .gap(px(6.0))
        .px(px(8.0))
        .rounded(px(10.0))
        .bg(theme.overlay)
        .cursor_pointer()
        .hover(|style| style.bg(theme.border.opacity(0.6)))
        .tooltip(Tooltip::text(display.clone()))
        .child(
            div()
                .flex_none()
                .whitespace_nowrap()
                .text_size(sp(12.5))
                .text_color(tools_description(theme))
                .child(SharedString::from(path)),
        );
    if file.additions > 0 {
        pill = pill.child(
            div()
                .flex_none()
                .text_size(sp(11.5))
                .text_color(super::super::diff_added())
                .child(SharedString::from(format!("+{}", file.additions))),
        );
    }
    if file.deletions > 0 {
        pill = pill.child(
            div()
                .flex_none()
                .text_size(sp(11.5))
                .text_color(super::super::diff_removed(theme))
                .child(SharedString::from(format!("\u{2212}{}", file.deletions))),
        );
    }
    let view_diff = Arc::clone(&actions.view_diff);
    let path = file.path.clone();
    let pill = pill.on_click(move |_, window, cx| {
        cx.stop_propagation();
        view_diff(&path, window, cx);
    });
    let Some(handle) = menu else {
        return pill.into_any_element();
    };
    let view_file = Arc::clone(&actions.view_file);
    let view_diff = Arc::clone(&actions.view_diff);
    let path = file.path.clone();
    context_menu(
        pill,
        SharedString::from(format!("files-pill-menu-{id}-{ix}")),
        handle,
        move |_| {
            let open = path.clone();
            let diff = path.clone();
            let view_file = Arc::clone(&view_file);
            let view_diff = Arc::clone(&view_diff);
            vec![
                MenuItem::new("Open", move |window, cx| view_file(&open, window, cx))
                    .icon("icons/file.svg"),
                MenuItem::new("Open Diff", move |window, cx| view_diff(&diff, window, cx))
                    .icon("icons/file-diff.svg"),
            ]
        },
    )
}

/// The list's inline affordance, pill-shaped so it reads as the last item
/// of the file row: a dim label brightening on hover, clicking through the
/// toggle `list.rs` wired (flip the disclosure, remeasure this row — the
/// synthetic-id pattern, no scroll anchor to park).
fn render_expander(
    label: String,
    id: &str,
    theme: &Theme,
    toggle: GroupToggle,
) -> gpui::Stateful<Div> {
    let disclosure = id.to_owned();
    div()
        .id(SharedString::from(format!("files-expander-{id}")))
        .h(px(PILL_HEIGHT))
        .flex()
        .items_center()
        .gap(px(4.0))
        .px(px(8.0))
        .rounded(px(10.0))
        .cursor_pointer()
        .hover(|style| style.bg(theme.overlay))
        .child(
            div()
                .text_size(sp(12.5))
                .text_color(tools_dim(theme))
                .hover(|style| style.text_color(tools_title(theme)))
                .child(SharedString::from(label)),
        )
        .on_click(move |event, window, cx| toggle(&disclosure, event, window, cx))
}
