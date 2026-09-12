//! The reasoning part — tide's thinking block. A dim disclosure row (brain
//! glyph, "Thinking", with the three-dot wave while the thought streams)
//! whose collapsed form carries an 80-char stripped summary line; expanded,
//! the full trace renders as markdown through the app's `md::render` engine
//! at the compact reasoning metrics in a dimmed palette — the same pair the
//! legacy transcript row gives a thought — inside a bounded 400px scroll
//! viewport once settled. While the thought streams the cap lifts entirely
//! (tide's own geometry: unbounded while streaming, a bounded scroll box
//! once done), so the growing trace pushes the pane's own bottom-follow
//! instead of scrolling inside a box of its own.

use super::super::rows::working_footer::wave_dots;
use super::super::tools_description;
use super::super::tools_dim;
use super::tool_part::{
    HEADER_GAP, HEADER_H, HEADER_ICON, HEADER_ICON_COL, HEADER_LINE_HEIGHT, HEADER_PAD,
    HEADER_TEXT, disclosure_id,
};
use crate::md;
use crate::model::ActivityItem;
use crate::theme::{Theme, sp};
use crate::ui::icon;
use gpui::prelude::*;
use gpui::{Div, SharedString, Stateful, div, px};
use std::collections::HashMap;
use uuid::Uuid;

/// Characters the collapsed summary shows before its ellipsis.
pub(crate) const SUMMARY_CHARS: usize = 80;

/// Height cap of the settled trace's scroll viewport, matching the tool
/// card's output budget (`OUTPUT_MAX_HEIGHT` in `tool_part`).
const REASONING_MAX_HEIGHT: f32 = 400.0;

/// The collapsed summary line: the reasoning text with leading/trailing
/// whitespace stripped and internal runs collapsed to single spaces, cut at
/// [`SUMMARY_CHARS`] characters with a trailing ellipsis. Pure, so the shape
/// stays unit-testable without a window.
pub(crate) fn reasoning_summary(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > SUMMARY_CHARS {
        format!(
            "{}…",
            collapsed.chars().take(SUMMARY_CHARS).collect::<String>()
        )
    } else {
        collapsed
    }
}

/// The reasoning text an activity carries, trimmed: `None` when the activity
/// holds no (non-empty) reasoning block — a row with nothing to disclose
/// renders the header alone, with no chevron and no body.
pub(crate) fn reasoning_content(activity: &ActivityItem) -> Option<&str> {
    activity
        .reasoning
        .as_ref()
        .map(|reasoning| reasoning.content.as_str())
        .map(str::trim)
        .filter(|content| !content.is_empty())
}

/// Whether the thought is still streaming: the activity has not settled.
/// Reasoning never fails on its own, so completion is the only signal.
pub(crate) fn reasoning_streaming(activity: &ActivityItem) -> bool {
    !activity.complete
}

/// The markdown state one reasoning body renders through — everything only
/// `list.rs` can reach, bundled so the group renderer threads one argument
/// instead of five. `views` is the legacy pane's own per-activity cache
/// (`Tide::activity_markdown`), borrowed for the group's render: parse state
/// survives a pane switch, and the per-row context key matches the legacy
/// rows exactly, so the flatten caches line up across surfaces.
pub(crate) struct ReasoningMarkdown<'a> {
    /// The shared per-activity markdown views, borrowed for this render.
    pub views: &'a mut HashMap<Uuid, md::render::MarkdownView>,
    /// [`md::render::Metrics::COMPACT`], rescaled to the user's font
    /// settings by the caller.
    pub metrics: md::render::Metrics,
    pub selection: md::render::TranscriptSelection,
    pub link_handler: Option<md::render::LinkHandler>,
    /// The app's mermaid Preview handler, threaded like the link handler so a
    /// diagram inside a thought renders through the same browser surface.
    pub mermaid_handler: Option<md::render::MermaidHandler>,
    /// The app's inline mermaid host, threaded alongside so a diagram inside
    /// a thought renders in place exactly like the assistant body's.
    pub mermaid_host: Option<md::render::MermaidHost>,
    /// Reduce-motion, resolved by the caller so the part decides per-body
    /// whether the streaming dissolve animates.
    pub reduce_motion: bool,
}

/// The dimmed palette a thought paints in: the theme palette with prose and
/// secondary text each knocked one step down — the same pair the legacy
/// reasoning row sets before rendering.
fn dimmed_palette(theme: &Theme) -> md::render::Palette {
    let mut palette = md::render::Palette::from_theme(theme);
    palette.text = theme.text_secondary;
    palette.secondary = theme.text_tertiary;
    palette
}

/// The disclosure row — the shared header geometry at the reasoning
/// treatment's dim weight: brain glyph (13px, dim) in the same 20px column
/// card headers use, "Thinking" — "Thinking…" with the three-dot wave while
/// the trace streams — the collapsed summary across the remaining width,
/// and the reveal chevron at the trailing edge. Id'd by the part's
/// disclosure id; the click arrives from the list's wiring, which owns the
/// toggle.
pub(crate) fn render_reasoning_header(
    activity: &ActivityItem,
    expanded: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let streaming = reasoning_streaming(activity);
    let togglable = reasoning_content(activity).is_some();
    let chevron = if expanded {
        "icons/chevron-down.svg"
    } else {
        "icons/chevron-right.svg"
    };
    let mut header = div()
        .id(SharedString::from(format!(
            "reasoning-header-{}",
            disclosure_id(activity)
        )))
        .h(px(HEADER_H))
        .w_full()
        .min_w_0()
        // The one-liner guarantee every header kind shares: fixed height,
        // overflow hidden, a pinned single-line line box, and each text
        // column min-w-0 + truncate.
        .overflow_hidden()
        .line_height(sp(HEADER_LINE_HEIGHT))
        .flex()
        .items_center()
        .gap(px(HEADER_GAP))
        .pl(px(HEADER_PAD))
        .pr(px(HEADER_PAD))
        .rounded(px(6.0))
        // The pointer promises a toggle; a row with nothing to disclose is
        // a plain label and keeps the default cursor.
        .when(togglable, |row| row.cursor_pointer())
        .hover(|style| style.bg(theme.overlay))
        .child(
            div()
                .w(px(HEADER_ICON_COL))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .child(icon("icons/brain.svg", HEADER_ICON, tools_dim(theme))),
        )
        .child(
            div()
                .flex_none()
                .min_w_0()
                .truncate()
                .text_size(sp(HEADER_TEXT))
                .text_color(tools_dim(theme))
                .child(if streaming {
                    SharedString::from("Thinking…")
                } else {
                    SharedString::from("Thinking")
                }),
        );
    // The still-thinking signal rides only a live row; under reduce-motion
    // the wave holds its first frame, reading as a static ellipsis.
    if streaming {
        header = header.child(wave_dots(tools_dim(theme)));
    }
    // The summary column spans the remaining width — collapsed only, since
    // the expanded body already shows the whole trace — and keeps the
    // chevron pinned at the trailing edge either way.
    let summary = if expanded {
        None
    } else {
        reasoning_content(activity).map(reasoning_summary)
    };
    header = header.child(
        div()
            .flex_1()
            .min_w_0()
            .truncate()
            .text_size(sp(12.0))
            .text_color(tools_description(theme))
            .when_some(summary, |column, text| {
                column.child(SharedString::from(text))
            }),
    );
    if togglable {
        header = header.child(icon(chevron, 11.0, tools_dim(theme)));
    }
    header
}

/// The expanded trace: the full reasoning text as markdown at the compact
/// reasoning metrics in the dimmed palette. The viewport is unbounded while
/// the thought streams — tide's geometry, and the simplest bottom-follow:
/// the growing trace has no box to scroll inside, so the pane's own
/// bottom-follow keeps the newest text in view — and settles into the
/// 400px scroll viewport once the thought completes.
pub(crate) fn render_reasoning_body(
    activity: &ActivityItem,
    markdown: &mut ReasoningMarkdown<'_>,
    theme: &Theme,
) -> Div {
    let Some(content) = reasoning_content(activity).map(str::to_owned) else {
        return div();
    };
    let id = disclosure_id(activity);
    let streaming = reasoning_streaming(activity);

    // The view is the legacy pane's own cache entry, keyed by the stable
    // activity id and fed the trace with the streaming flag as the mend
    // switch — exactly the way the legacy reasoning row drives it.
    let view = markdown.views.entry(activity.id).or_default();
    view.set_text(&content, streaming);
    let palette = dimmed_palette(theme);
    let mut ctx = md::render::Ctx::new(
        format!("reasoning-{}", activity.id),
        &palette,
        markdown.metrics,
        markdown.selection.clone(),
    )
    .with_streaming_animation(streaming && !markdown.reduce_motion);
    if let Some(link_handler) = markdown.link_handler.clone() {
        ctx = ctx.with_link_handler(link_handler);
    }
    if let Some(mermaid_handler) = markdown.mermaid_handler.clone() {
        ctx = ctx.with_mermaid_handler(mermaid_handler);
    }
    if let Some(mermaid_host) = markdown.mermaid_host.clone() {
        ctx = ctx.with_mermaid_host(mermaid_host);
    }
    // While the thought streams only the trailing blocks build — the same
    // cap the legacy live peek uses, so a long think costs O(window) per
    // pulse tick; the settled trace renders in full.
    let trace = if streaming {
        md::render::markdown_tail(view, &ctx, crate::app::LIVE_REASONING_TAIL_BLOCKS)
    } else {
        md::render::markdown(view, &ctx)
    }
    .unwrap_or_else(|| div().into_any_element());

    div()
        .flex()
        .flex_col()
        .min_w_0()
        .overflow_hidden()
        // The body column aligns under the header's label: the header's
        // leading padding plus its 20px icon column plus the header's gap.
        .pl(px(HEADER_PAD + HEADER_ICON_COL + HEADER_GAP))
        .pr(px(4.0))
        .pb(px(4.0))
        .child(
            div()
                .id(SharedString::from(format!("reasoning-scroll-{id}")))
                .w_full()
                .min_w_0()
                .rounded(px(6.0))
                .bg(theme.raised)
                .px(px(8.0))
                .py(px(6.0))
                .when(!streaming, |viewport| {
                    viewport.max_h(px(REASONING_MAX_HEIGHT)).overflow_y_scroll()
                })
                .child(trace),
        )
}
