//! Fresh, simple diff-row rendering for the v2 tool cards. The legacy
//! `render_diff_code_row` (right_panel) is entangled with review-diff line
//! models and transcript selection state; the v2 pane renders the prepared
//! `ActivityFileChange::diff` string directly — classify each line, tint by
//! kind, cap the row count inside a scroll viewport.

use crate::app::timeline_v2::tools_dim;
use crate::md;
use crate::theme::{Theme, sp};
use gpui::prelude::*;
use gpui::{Div, SharedString, div, px};

/// How one unified-diff line reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LineKind {
    Addition,
    Deletion,
    Context,
    /// `@@ -1,3 +1,4 @@` — including the bare `@@` variant the model
    /// documents for synthesized string-replacement diffs.
    HunkHeader,
}

/// Classify one unified-diff line by its marker. File headers (`--- a/x`,
/// `+++ b/x`) carry no change semantics and read as context; everything
/// undecorated is context.
pub(crate) fn classify_diff_line(line: &str) -> LineKind {
    if line.starts_with("---") || line.starts_with("+++") {
        LineKind::Context
    } else if line.starts_with('+') {
        LineKind::Addition
    } else if line.starts_with('-') {
        LineKind::Deletion
    } else if line.starts_with("@@") {
        LineKind::HunkHeader
    } else {
        LineKind::Context
    }
}

/// Row budget inside one diff viewport, ported as a local const so a giant
/// patch can never build an unbounded element tree per frame.
pub(crate) const MAX_DIFF_ROWS: usize = 400;

/// How many lines sit past the budget: `Some(hidden)` exactly when the diff
/// needs truncation. `max_rows: None` is the uncapped budget (the output
/// dialog's) and never truncates.
pub(crate) fn diff_truncation(total_lines: usize, max_rows: Option<usize>) -> Option<usize> {
    max_rows
        .filter(|cap| total_lines > *cap)
        .map(|cap| total_lines - cap)
}

/// Render a prepared unified-diff body line by line inside a scroll
/// viewport: additions carry the success bg-tint, deletions the error tint,
/// context stays quiet in the tertiary token, hunk headers dim. With
/// `max_rows: Some(MAX_DIFF_ROWS)` (the card bodies' budget) the viewport
/// caps at 400px and past-the-cap lines hide behind a count row; with
/// `None` (the output dialog) every line renders and the viewport fills the
/// height it is handed instead of capping.
pub(crate) fn render_diff_lines(
    diff: &str,
    element_id: &str,
    theme: &Theme,
    max_rows: Option<usize>,
) -> Div {
    let lines: Vec<&str> = diff.lines().collect();
    let shown = max_rows.map_or(lines.len(), |cap| lines.len().min(cap));
    let success = super::super::diff_added();
    let error = super::super::diff_removed(theme);

    let rows = lines[..shown].iter().map(|line| {
        let mut row = div()
            .w_full()
            .min_w_0()
            .truncate()
            .min_h(sp(16.0))
            .px(px(8.0))
            .text_size(sp(11.5))
            .line_height(sp(16.0))
            .font_family(md::render::MONO_FAMILY)
            .child(SharedString::from(*line));
        match classify_diff_line(line) {
            LineKind::Addition => {
                row = row
                    .bg(success.opacity(0.10))
                    .text_color(theme.text_secondary)
            }
            LineKind::Deletion => {
                row = row.bg(error.opacity(0.10)).text_color(theme.text_secondary)
            }
            // Context keeps its leading space (mono alignment); hunk headers
            // and file headers read as metadata.
            LineKind::Context | LineKind::HunkHeader => {
                row = row.text_color(tools_dim(theme));
            }
        }
        row
    });

    // Capped viewports budget pixels (the card body's 400px ceiling);
    // uncapped ones fill the container that owns their height (the dialog's
    // flex-1 body).
    let mut viewport = div()
        .id(SharedString::from(element_id))
        .overflow_y_scroll()
        .w_full()
        .min_w_0()
        .rounded(px(6.0))
        .bg(theme.raised)
        .py(px(4.0))
        .flex()
        .flex_col()
        .children(rows)
        .children(diff_truncation(lines.len(), max_rows).map(|hidden| {
            div()
                .w_full()
                .px(px(8.0))
                .py(px(2.0))
                .text_size(sp(10.5))
                .text_color(tools_dim(theme))
                .child(SharedString::from(format!("{hidden} more lines hidden")))
        }));
    let mut outer = div().w_full().min_w_0();
    if max_rows.is_some() {
        viewport = viewport.max_h(px(400.0));
    } else {
        viewport = viewport.flex_1().min_h_0();
        outer = outer.flex().flex_col().flex_1().min_h_0();
    }
    outer.child(viewport)
}
