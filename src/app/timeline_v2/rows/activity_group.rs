//! The activity block as a bare list of rows: every tool card and reasoning
//! part rendered directly — no railed wrapper, the group's fold aside.
//! Reasoning parts keep their own dim disclosure; clicks arrive as
//! a [`GroupToggle`], because only `list.rs` holds the view context the
//! toggles need.

use super::super::TranscriptActions;
use super::super::parts;
use super::super::parts::reasoning_part::{
    ReasoningMarkdown, reasoning_content, reasoning_streaming,
};
use super::super::parts::tool_part::{
    HEADER_GAP, HEADER_H, HEADER_ICON, HEADER_LINE_HEIGHT, HEADER_TEXT,
};
use super::super::tools_dim;
use crate::md::render::TranscriptSelection;
use crate::model::ActivityItem;
use crate::theme::Theme;
use crate::ui::icon;
use gpui::prelude::*;
use gpui::{AnyElement, App, ClickEvent, Div, SharedString, Stateful, Window, div, px};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

// ── Renderers ──────────────────────────────────────────────────────────────

/// One disclosure toggle, threaded from `list.rs` (which owns the view
/// context) into the rows whose clicks it cannot attach itself. The id is
/// data: the renderer knows which row was clicked, the closure knows what a
/// toggle means there. Tool-card ids lean on the anchor
/// `toggle_disclosure` parks, whose render sync owns the re-measure.
pub(crate) type GroupToggle = Arc<dyn Fn(&str, &ClickEvent, &mut Window, &mut App) + 'static>;

/// The group's disclosure id. The turn's uuid anchors it — the same
/// stability rule as [`super::changed_files::files_card_id`]: ids must
/// survive re-anchoring folds, and a turn id never moves once the turn
/// settles. Blocks without a turn never fold; they have no id to key on.
pub(crate) fn group_id(turn_id: Uuid) -> String {
    format!("group-{turn_id}")
}

/// One side of a fold divider's horizontal line.
fn rule(theme: &Theme) -> Div {
    div().h(px(1.0)).flex_1().min_w(px(12.0)).bg(theme.border)
}

/// The strip both fold affordances share: fixed height, hover wash, the
/// click routed through the [`GroupToggle`] only `list.rs` can build.
fn fold_strip(element_id: SharedString, theme: &Theme) -> Stateful<Div> {
    div()
        .id(element_id)
        .h(px(HEADER_H))
        .w_full()
        .min_w_0()
        .overflow_hidden()
        .line_height(px(HEADER_LINE_HEIGHT))
        .flex()
        .items_center()
        .gap(px(HEADER_GAP))
        .rounded(px(6.0))
        .hover(|style| style.bg(theme.overlay))
}

/// The group's fold header: a horizontal divider carrying the turn's
/// working duration at its center — "Doing for 23m 5s" — with a chevron
/// flanking the text on each side. The whole strip toggles the fold; it is
/// always present when the group folds, so an expanded group carries its
/// affordance right above the first card.
pub(crate) fn render_group_header(
    duration_secs: u64,
    theme: &Theme,
    id: &str,
    toggle: GroupToggle,
) -> Stateful<Div> {
    let dim = tools_dim(theme);
    let label = SharedString::from(format!(
        "Doing for {}",
        super::turn_item::format_duration(duration_secs)
    ));
    let id = id.to_owned();
    fold_strip(SharedString::from(format!("group-header-{id}")), theme)
        .child(rule(theme))
        .child(icon("icons/chevron-down.svg", HEADER_ICON, dim))
        .child(
            div()
                .flex_none()
                .truncate()
                .text_size(px(HEADER_TEXT))
                .text_color(dim)
                .child(label),
        )
        .child(icon("icons/chevron-down.svg", HEADER_ICON, dim))
        .child(rule(theme))
        .on_click(move |event, window, cx| toggle(&id, event, window, cx))
}

/// The group's fold footer: the same divider with "Collapse" at its center,
/// closing an expanded section. It renders on the fold's last row, below
/// the content, so a reader who has finished the work folds it back up from
/// where they stand.
pub(crate) fn render_group_footer(theme: &Theme, id: &str, toggle: GroupToggle) -> Stateful<Div> {
    let dim = tools_dim(theme);
    let id = id.to_owned();
    fold_strip(SharedString::from(format!("group-footer-{id}")), theme)
        .child(rule(theme))
        .child(
            div()
                .flex_none()
                .truncate()
                .text_size(px(HEADER_TEXT))
                .text_color(dim)
                .child(SharedString::from("Collapse")),
        )
        .child(rule(theme))
        .on_click(move |event, window, cx| toggle(&id, event, window, cx))
}

/// The block's activity list, bare: reasoning renders its own dim disclosure
/// part, and every tool — the read-only families included — renders a 26px
/// card header per activity with the expanded body under the disclosure
/// set's id — all as flat rows in a 2px-gap column, no indent and no rail.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_activities(
    activities: &[&ActivityItem],
    disclosures: &HashSet<String>,
    workspace: &Path,
    selection: &TranscriptSelection,
    actions: &TranscriptActions,
    theme: &Theme,
    markdown: &mut ReasoningMarkdown<'_>,
    toggle: GroupToggle,
) -> Div {
    let mut block_rows: Vec<AnyElement> = Vec::new();
    for activity in activities {
        match parts::presentation_for(activity) {
            // Reasoning renders its own part: a dim 24px disclosure row whose
            // collapsed form carries the trace's summary. A live thought
            // defaults open — tide pins the growing trace in view — while a
            // settled one defaults collapsed until the reader expands it, so
            // the disclosure set alone decides once the stream is done.
            parts::ActivityPresentation::Reasoning => {
                let id = parts::disclosure_id(activity);
                let expanded = reasoning_streaming(activity) || disclosures.contains(&id);
                let togglable = reasoning_content(activity).is_some();
                let mut header = parts::render_reasoning_header(activity, expanded, theme);
                if togglable {
                    let toggle = Arc::clone(&toggle);
                    header =
                        header.on_click(move |event, window, cx| toggle(&id, event, window, cx));
                }
                block_rows.push(
                    div()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(header)
                        .when(expanded, |part| {
                            part.child(parts::render_reasoning_body(activity, markdown, theme))
                        })
                        .into_any_element(),
                );
            }
            // Cards: a header per activity, its expanded body under the
            // disclosure set's id — as a bare row in the flat list. A card
            // with nothing to disclose (`has_body` false) keeps its header
            // static: no click, no expansion, the single line is the whole
            // card.
            parts::ActivityPresentation::Card => {
                let id = parts::disclosure_id(activity);
                let expandable = parts::has_body(activity);
                let expanded = expandable && disclosures.contains(&id);
                let mut header =
                    parts::render_activity_header(activity, workspace, actions, theme, expanded);
                if expandable {
                    let toggle = Arc::clone(&toggle);
                    header =
                        header.on_click(move |event, window, cx| toggle(&id, event, window, cx));
                }
                block_rows.push(
                    div()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(header)
                        .when(expanded, |card| {
                            card.child(parts::render_activity_body(
                                activity,
                                workspace,
                                selection,
                                theme,
                                markdown.link_handler.clone(),
                            ))
                        })
                        .into_any_element(),
                );
            }
        }
    }
    // The bare column: one row per activity — shared-geometry 26px headers
    // (cards and reasoning alike) — at a 2px gap, flush with the turn's
    // content column (no indent, no rail).
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .children(block_rows)
}
