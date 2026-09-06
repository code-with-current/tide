//! The activity block as a bare list of rows: every tool card and reasoning
//! part rendered directly — no cluster header, no collapse, no railed
//! wrapper. Reasoning parts keep their own dim disclosure; clicks arrive as
//! a [`GroupToggle`], because only `list.rs` holds the view context the
//! toggles need.

use super::super::TranscriptActions;
use super::super::parts;
use super::super::parts::reasoning_part::{
    ReasoningMarkdown, reasoning_content, reasoning_streaming,
};
use crate::model::ActivityItem;
use crate::theme::Theme;
use gpui::prelude::*;
use gpui::{AnyElement, App, ClickEvent, Div, Window, div, px};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

// ── Renderers ──────────────────────────────────────────────────────────────

/// One disclosure toggle, threaded from `list.rs` (which owns the view
/// context) into the rows whose clicks it cannot attach itself. The id is
/// data: the renderer knows which row was clicked, the closure knows what a
/// toggle means there. Tool-card ids lean on the anchor
/// `toggle_disclosure` parks, whose render sync owns the re-measure.
pub(crate) type GroupToggle = Arc<dyn Fn(&str, &ClickEvent, &mut Window, &mut App) + 'static>;

/// The block's activity list, bare: reasoning renders its own dim disclosure
/// part, and every tool — the read-only families included — renders a 26px
/// card header per activity with the expanded body under the disclosure
/// set's id — all as flat rows in a 2px-gap column, no indent and no rail.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_activities(
    activities: &[&ActivityItem],
    disclosures: &HashSet<String>,
    workspace: &Path,
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
                            card.child(parts::render_activity_body(activity, workspace, theme))
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
