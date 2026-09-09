//! The turn's file-changes card — tide's FileChanges block, ported to the
//! pane's disclosure vocabulary. A bordered card summarizing everything the
//! turn's edit/write work did to the working tree: a header reading the file
//! count, a created/edited chip, and the folded "+A / −D" totals in the
//! status tokens; under it the file list, budgeted to five rows with a
//! "+N more files" expander owning the fifth slot. Paths relativize against
//! the workspace the way every other row's descriptions do, and each row's
//! hover-revealed Review button hands the path to `view_diff`.
//!
//! The fold is pure — [`summarize_changes`] collects the turn's prepared
//! `ActivityFileChange`s, dedupes by path summing stats, and sorts created
//! files ahead of edited ones (alphabetical inside each bucket) — so the card
//! reads from one small summary struct instead of rewalking the blocks every
//! frame. Expansion rides the pane's disclosure set under a synthetic
//! turn-anchored id; because the id names no activity, `list.rs` wires the
//! toggle with a direct remeasure (the synthetic-id pattern the activity
//! group's cluster header uses).

use super::super::{
    TranscriptActions, relative_display, tools_description, tools_dim, tools_title,
};
use super::activity_group::GroupToggle;
use crate::model::{ActivityFileChange, ActivityFileChangeStatus};
use crate::theme::{Theme, sp};
use crate::ui::{icon, icon_button};
use gpui::prelude::*;
use gpui::{Div, FontWeight, MouseButton, SharedString, Stateful, div, px};
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

/// The counts chip: "2 created · 1 edited", zero segments omitted. `None`
/// when both are zero — nothing to distinguish, no chip.
pub(crate) fn counts_chip(created: usize, edited: usize) -> Option<String> {
    let segments: Vec<String> = [(created, "created"), (edited, "edited")]
        .iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, noun)| format!("{count} {noun}"))
        .collect();
    (!segments.is_empty()).then(|| segments.join(" · "))
}

/// Rows the collapsed list shows before the expander takes the fifth slot —
/// tide's MAX_VISIBLE budget, minus one for the expander itself.
pub(crate) const MAX_VISIBLE_FILES: usize = 5;

/// How many file rows render, and how many the expander names. Expanded
/// shows everything; at or under the budget everything fits with no expander;
/// over the budget the collapsed card shows `MAX_VISIBLE_FILES - 1` rows and
/// the expander counts the rest.
pub(crate) fn visible_files(total: usize, expanded: bool) -> (usize, Option<usize>) {
    if expanded || total <= MAX_VISIBLE_FILES {
        (total, None)
    } else {
        let shown = MAX_VISIBLE_FILES - 1;
        (shown, Some(total - shown))
    }
}

/// The card's disclosure id. The turn's uuid anchors it — the same stability
/// rule as [`super::activity_group::group_id`]: ids must survive re-anchoring
/// folds, and a turn id never moves once the turn settles.
pub(crate) fn files_card_id(turn_id: Uuid) -> String {
    format!("files-{turn_id}")
}

// ── Renderer ────────────────────────────────────────────────────────────────

/// The file-changes card: bordered, raised, the header over the budgeted file
/// list. `id` is the card's disclosure id ([`files_card_id`]); the expander
/// row's click arrives as the [`GroupToggle`] only `list.rs` can build, and
/// `expanded` is the disclosure set's answer for that id — the card itself
/// keeps no state of its own.
pub(crate) fn render_changed_files(
    summary: &ChangesSummary,
    workspace: &Path,
    actions: &TranscriptActions,
    theme: &Theme,
    expanded: bool,
    id: &str,
    toggle: GroupToggle,
) -> Div {
    let (shown, hidden) = visible_files(summary.files.len(), expanded);

    let mut card = div()
        .w_full()
        .mt(px(4.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .border_1()
        .border_color(theme.border)
        .rounded(px(8.0))
        .bg(theme.raised)
        .px(px(12.0))
        .py(px(8.0))
        .child(render_header(summary, theme));

    if !summary.files.is_empty() {
        card = card
            .child(div().h(px(0.5)).w_full().bg(theme.border.opacity(0.6)))
            .children(
                summary.files[..shown]
                    .iter()
                    .enumerate()
                    .map(|(ix, file)| render_file_row(file, workspace, actions, theme, id, ix)),
            );
        // The expander exists exactly when the budget bit: collapsed it takes
        // the fifth slot ("+N more files"); expanded it stays as the collapse
        // affordance so a reader is never stranded at full depth.
        if summary.files.len() > MAX_VISIBLE_FILES {
            let label = match hidden {
                Some(hidden) => format!("+{hidden} more files"),
                None => "Show less".to_owned(),
            };
            card = card.child(render_expander(label, expanded, id, theme, toggle));
        }
    }
    card
}

/// The header strip: file-diff glyph, the count reading, the created/edited
/// chip, and — pushed right — the "+A / −D" totals in the success/error
/// tokens, hidden when the turn's work carried no line stats at all.
fn render_header(summary: &ChangesSummary, theme: &Theme) -> Div {
    let mut header = div()
        .h(px(24.0))
        .flex()
        .items_center()
        .gap(px(6.0))
        .child(icon("icons/file-diff.svg", 14.0, tools_dim(theme)))
        .child(
            div()
                .flex_none()
                .text_size(sp(12.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(tools_title(theme))
                .child(SharedString::from(header_title(summary.files.len()))),
        );
    if let Some(chip) = counts_chip(summary.created, summary.edited) {
        header = header.child(
            div()
                .flex_none()
                .rounded_full()
                .bg(theme.overlay)
                .px(px(8.0))
                .py(px(1.0))
                .text_size(sp(11.0))
                .text_color(tools_dim(theme))
                .child(SharedString::from(chip)),
        );
    }
    if summary.additions + summary.deletions > 0 {
        header = header.child(div().flex_1()).child(render_totals(
            summary.additions,
            summary.deletions,
            theme,
        ));
    }
    header
}

/// The folded "+A / −D" reading: each half in its status token, the separator
/// dim. tide's minus form (U+2212) keeps the glyph visually matched to the
/// plus at these sizes.
fn render_totals(additions: u64, deletions: u64, theme: &Theme) -> Div {
    div()
        .flex_none()
        .flex()
        .items_center()
        .gap(px(4.0))
        .text_size(sp(11.0))
        .child(
            div()
                .text_color(super::super::diff_added())
                .child(SharedString::from(format!("+{additions}"))),
        )
        .child(div().text_color(tools_dim(theme)).child("/"))
        .child(
            div()
                .text_color(super::super::diff_removed(theme))
                .child(SharedString::from(format!("\u{2212}{deletions}"))),
        )
}

/// One file row: the workspace-relative path truncating in the description
/// token, the per-file "+n/−m" halves (zero halves omitted, absent when the
/// change carried no stats), and the hover-revealed Review button handing the
/// path to `view_diff`. Clicks stop at the button so the row beneath never
/// feels them.
fn render_file_row(
    file: &ChangedFileSummary,
    workspace: &Path,
    actions: &TranscriptActions,
    theme: &Theme,
    id: &str,
    ix: usize,
) -> Stateful<Div> {
    let hover_group = SharedString::from(format!("files-row-hover-{id}-{ix}"));
    let mut row = div()
        .id(SharedString::from(format!("files-row-{id}-{ix}")))
        .group(hover_group.clone())
        .h(px(24.0))
        .flex()
        .items_center()
        .gap(px(6.0))
        .rounded(px(6.0))
        .cursor_default()
        .hover(|style| style.bg(theme.overlay))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(sp(11.5))
                .text_color(tools_description(theme))
                .child(SharedString::from(relative_display(workspace, &file.path))),
        );
    if file.additions > 0 {
        row = row.child(
            div()
                .flex_none()
                .text_size(sp(10.5))
                .text_color(super::super::diff_added())
                .child(SharedString::from(format!("+{}", file.additions))),
        );
    }
    if file.deletions > 0 {
        row = row.child(
            div()
                .flex_none()
                .text_size(sp(10.5))
                .text_color(super::super::diff_removed(theme))
                .child(SharedString::from(format!("\u{2212}{}", file.deletions))),
        );
    }
    let view_diff = Arc::clone(&actions.view_diff);
    let path = file.path.clone();
    let review = icon_button(
        SharedString::from(format!("files-review-{id}-{ix}")),
        // The tool-part view-diff glyph — the pane's Review affordance.
        "icons/git-commit-horizontal.svg",
        *theme,
    )
    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
    .on_click(move |_, window, cx| {
        cx.stop_propagation();
        view_diff(&path, window, cx);
    });
    row.child(
        div()
            .flex_none()
            .flex()
            .items_center()
            .invisible()
            .group_hover(hover_group, |style| style.visible())
            .child(review),
    )
}

/// The expander row: chevron plus a dim label brightening on hover, clicking
/// through the toggle `list.rs` wired (flip the disclosure, remeasure this
/// row — the synthetic-id pattern, no scroll anchor to park).
fn render_expander(
    label: String,
    expanded: bool,
    id: &str,
    theme: &Theme,
    toggle: GroupToggle,
) -> gpui::Stateful<Div> {
    let chevron = if expanded {
        "icons/chevron-up.svg"
    } else {
        "icons/chevron-down.svg"
    };
    let disclosure = id.to_owned();
    div()
        .id(SharedString::from(format!("files-expander-{id}")))
        .h(px(22.0))
        .flex()
        .items_center()
        .gap(px(6.0))
        .pl(px(2.0))
        .rounded(px(6.0))
        .cursor_pointer()
        .hover(|style| style.bg(theme.overlay))
        .child(icon(chevron, 11.0, tools_dim(theme)))
        .child(
            div()
                .text_size(sp(11.5))
                .text_color(tools_dim(theme))
                .hover(|style| style.text_color(tools_title(theme)))
                .child(SharedString::from(label)),
        )
        .on_click(move |event, window, cx| toggle(&disclosure, event, window, cx))
}
