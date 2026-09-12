//! Right-panel diff rendering: row styling and selection keys, review gap
//! actions, and the git-history row helpers.

use crate::app::RightPanelSurface;
use crate::app::Tide;
use crate::app::features::git::GitPanelTab;
use crate::app::features::right_panel::files::workspace_relative_file_path;
use crate::app::single_line_label;
use crate::md;
use crate::md::render::Palette as MarkdownPalette;
use crate::md::render::TranscriptSelection;
use crate::query::Query;
use crate::theme::Theme;
use crate::theme::sp;
use crate::ui::ActivationExt;
use crate::ui::chip::Chip;
use crate::ui::chip::ChipTone;
use crate::ui::chip::chip;
use crate::ui::icon;
use gpui::AnyElement;
use gpui::Context;
use gpui::Div;
use gpui::FocusHandle;
use gpui::FontWeight;
use gpui::Hsla;
use gpui::SharedString;
use gpui::Stateful;
use gpui::TextRun;
use gpui::Window;
use gpui::div;
use gpui::font;
use gpui::prelude::*;
use gpui::px;
use protocol::git_panel::PanelConflict;
use protocol::git_panel::PanelFileChange;
use std::path::Path;
use std::path::PathBuf;
pub(in crate::app) const GIT_BAR_H: f32 = 32.0;
pub(in crate::app) const GIT_BAR_PAD_X: f32 = 10.0;

/// The branch chip as drawn before the picker was shared — the fallback
/// while the shared branch snapshot has not landed (and for workspaces
/// without one).
pub(in crate::app) fn static_chip(branch: &str, theme: &Theme) -> Stateful<Div> {
    div()
        .id("git-panel-branch-chip")
        .min_w_0()
        .max_w(px(180.0))
        .h(px(22.0))
        .px(px(6.0))
        .rounded(px(6.0))
        .flex()
        .items_center()
        .gap(px(4.0))
        .font_family(".SystemUIFontMonospaced")
        .text_size(sp(11.5))
        .text_color(theme.text_secondary)
        .child(icon("icons/git-branch.svg", 12.0, theme.text_tertiary))
        .child(div().min_w_0().truncate().child(single_line_label(branch)))
}

/// The avatar hue of a seed string (sha or author) — tide's
/// `h*31 + charCode` fold reduced mod 360, as gpui's 0..1 hue fraction.
pub(in crate::app) fn commit_hue(seed: &str) -> f32 {
    let mut hue: u32 = 7;
    for byte in seed.bytes() {
        hue = (hue.wrapping_mul(31).wrapping_add(u32::from(byte))) % 360;
    }
    hue as f32 / 360.0
}

/// Up to two uppercase initials of an author name.
pub(in crate::app) fn commit_initials(author: &str) -> String {
    let initials: String = author
        .split_whitespace()
        .filter_map(|word| word.chars().next())
        .take(2)
        .collect();
    initials.to_uppercase()
}

/// tide's formatRelative: "just now" through days, then the date.
pub(in crate::app) fn relative_commit_date(iso: &str) -> String {
    let Ok(time) = chrono::DateTime::parse_from_rfc3339(iso) else {
        return iso.to_owned();
    };
    let local = time.with_timezone(&chrono::Local);
    let seconds = chrono::Local::now()
        .signed_duration_since(local)
        .num_seconds()
        .max(0);
    match seconds {
        0..=59 => tr!("git_panel.time_just_now"),
        60..=3_599 => tr!("git_panel.time_minutes_ago", count = seconds / 60),
        3_600..=86_399 => tr!("git_panel.time_hours_ago", count = seconds / 3_600),
        86_400..=2_591_999 => tr!("git_panel.time_days_ago", count = seconds / 86_400),
        _ => local.format("%b %e, %Y").to_string(),
    }
}

/// The tooltip counterpart: the full local date + time.
pub(in crate::app) fn absolute_commit_date(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%b %e, %Y %H:%M")
                .to_string()
        })
        .unwrap_or_else(|_| iso.to_owned())
}

/// The full commit message minus its subject line — tide strips the subject
/// it already renders above the body.
pub(in crate::app) fn strip_subject(message: &str, subject: &str) -> String {
    let trimmed = message.trim();
    if !subject.is_empty() {
        if let Some(rest) = trimmed.strip_prefix(subject) {
            return rest.trim_start_matches('\n').trim_end().to_owned();
        }
    }
    trimmed.to_owned()
}

/// Status-word color for a changed file in the commit details.
pub(in crate::app) fn file_status_color(theme: &Theme, status: &str) -> Hsla {
    match status {
        "added" => theme.success,
        "deleted" => theme.danger,
        "renamed" => theme.gauge,
        "modified" => theme.warning,
        _ => theme.text_tertiary,
    }
}

/// One keyboard-reachable action row in the History "…" card.
pub(in crate::app) fn render_history_action_item(
    id: &'static str,
    icon_path: &'static str,
    label: impl Into<SharedString>,
    danger: bool,
    focus: FocusHandle,
    theme: &Theme,
    cx: &mut Context<Tide>,
    on_click: impl Fn(&mut Tide, &mut Window, &mut Context<Tide>) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .track_focus(&focus)
        .tab_index(0)
        .min_h(px(24.0))
        .px(px(6.0))
        .rounded(px(6.0))
        .flex()
        .items_center()
        .gap(px(7.0))
        .cursor_default()
        .text_size(sp(11.5))
        .text_color(if danger {
            theme.danger
        } else {
            theme.text_secondary
        })
        .focus_visible(|style| style.border_1().border_color(theme.accent))
        .hover(|style| style.bg(theme.overlay))
        .child(icon(
            icon_path,
            13.0,
            if danger {
                theme.danger
            } else {
                theme.text_tertiary
            },
        ))
        .child(label.into())
        .on_activation(cx, on_click)
}

/// A small pill button for the History "…" card's confirm/cancel rows.
pub(in crate::app) fn render_history_action_button(
    id: &'static str,
    label: impl Into<SharedString>,
    danger: bool,
    focus: FocusHandle,
    _theme: &Theme,
    cx: &mut Context<Tide>,
    on_click: impl Fn(&mut Tide, &mut Window, &mut Context<Tide>) + 'static,
) -> Chip {
    chip(id, cx, on_click)
        .label(label)
        .tone(if danger {
            ChipTone::Danger
        } else {
            ChipTone::Default
        })
        .height(px(24.0))
        .padding_x(px(10.0))
        .text_size(11.0)
        .font_weight(FontWeight::MEDIUM)
        .thick_focus_ring()
        .track_focus(&focus)
}

/// Ready value accessor for the git panel's `Query<(), V>` states; the
/// panel never constructs `Missing`, so a miss is always "loading".
pub(in crate::app) fn git_change_at(
    status: &Query<(), Vec<PanelFileChange>>,
    index: usize,
) -> Option<PanelFileChange> {
    match status {
        Query::Ready(changes) => changes.get(index).cloned(),
        Query::Pending | Query::Missing(_) => None,
    }
}

pub(in crate::app) fn git_conflict_at(
    conflicts: &Query<(), Vec<PanelConflict>>,
    index: usize,
) -> Option<PanelConflict> {
    match conflicts {
        Query::Ready(conflicts) => conflicts.get(index).cloned(),
        Query::Pending | Query::Missing(_) => None,
    }
}

pub(in crate::app) fn review_diff_gap_icon_path(
    direction: crate::review_diff::ExpansionDirection,
) -> &'static str {
    match direction {
        // Pierre's direction attributes and rendered chevrons are inverted by
        // CSS. Tide names the data operation directly, so encode the resulting
        // visual here: reveal-from-start points down; reveal-from-end points up.
        crate::review_diff::ExpansionDirection::Start => "icons/chevron-down.svg",
        crate::review_diff::ExpansionDirection::End => "icons/chevron-up.svg",
        crate::review_diff::ExpansionDirection::Both
        | crate::review_diff::ExpansionDirection::All => "icons/chevrons-up-down.svg",
    }
}

pub(in crate::app) fn review_diff_gap_tooltip(
    direction: crate::review_diff::ExpansionDirection,
) -> String {
    match direction {
        crate::review_diff::ExpansionDirection::Start => tr!("diff.expand_context_below"),
        crate::review_diff::ExpansionDirection::End => tr!("diff.expand_context_above"),
        crate::review_diff::ExpansionDirection::Both => tr!("diff.expand_context"),
        crate::review_diff::ExpansionDirection::All => tr!("diff.expand_all_context"),
    }
}

pub(in crate::app) fn review_diff_gap_directions(
    position: crate::review_diff::GapPosition,
    chunked: bool,
) -> &'static [crate::review_diff::ExpansionDirection] {
    use crate::review_diff::{ExpansionDirection, GapPosition};

    match (position, chunked) {
        (GapPosition::Leading, _) => &[ExpansionDirection::End],
        (GapPosition::Trailing, _) => &[ExpansionDirection::Start],
        (GapPosition::Between, false) => &[ExpansionDirection::Both],
        (GapPosition::Between, true) => &[ExpansionDirection::Start, ExpansionDirection::End],
    }
}

/// How wide and tall a diff row is drawn. The Review panel is a reading
/// surface; the copy embedded in a transcript activity is a summary and gives
/// its space back to the code.
#[derive(Clone, Copy)]
pub(in crate::app) struct DiffRowStyle {
    gutter_width: f32,
    pub(in crate::app) row_height: f32,
    text_size: f32,
    /// What to put in the gutter of a row that has no line number. Git always
    /// reports positions, so this only comes up on a diff synthesized from a
    /// provider's before/after text: there the `+`/`-` marker stands in, which
    /// keeps the gutter from going blank and the meaning off color alone.
    marker_fallback: bool,
}

impl DiffRowStyle {
    /// Review-tab rows at the user's code font size. The gutter holds a
    /// right-aligned line number: ~0.6em per mono digit, five digits, plus
    /// its padding and border.
    pub(in crate::app) fn review(text_size: f32) -> Self {
        Self {
            gutter_width: (text_size * 3.0 + 14.0).round(),
            row_height: (text_size * 1.5).round(),
            text_size,
            marker_fallback: false,
        }
    }

    /// The same rows the Review tab draws, so an edit reads the same wherever
    /// it is opened.
    pub(in crate::app) fn activity(text_size: f32) -> Self {
        Self {
            marker_fallback: true,
            ..Self::review(text_size)
        }
    }

    pub(in crate::app) fn gutter_width(&self) -> f32 {
        self.gutter_width
    }
}

/// Selection identity for one diff code row. Selection resolves a drag by
/// looking rows up by key, so every row must have its own.
///
/// Rows with line numbers key on them: they survive Review's gap expansion,
/// where a revealed gap shifts every later row's index. Rows without them — a
/// diff synthesized from a provider's before/after text — key on the row index
/// instead, which is stable there because an activity diff is only ever
/// rebuilt whole. Keying those on their (absent) numbers gave every added row
/// the same key, and a drag resolved against whichever duplicate registered
/// first: selections jumped rows, skipped wrapped lines, and collapsed when
/// the head crossed into context.
pub(in crate::app) fn diff_row_selection_key(
    key_prefix: &str,
    line: &crate::review_diff::Line,
    index: usize,
) -> String {
    let kind = match &line.kind {
        crate::review_diff::LineKind::Context => "context",
        crate::review_diff::LineKind::Addition => "addition",
        crate::review_diff::LineKind::Deletion => "deletion",
        _ => "other",
    };
    match (line.old_line, line.new_line) {
        (None, None) => format!("{key_prefix}-line-{}-{kind}-i{index}", line.file_index),
        (old, new) => format!(
            "{key_prefix}-line-{}-{kind}-{}-{}",
            line.file_index,
            old.unwrap_or(0),
            new.unwrap_or(0),
        ),
    }
}

/// One context, addition, or deletion row, shared by the Review panel and the
/// diff inside an expanded file-change activity so the two never drift.
pub(in crate::app) fn render_diff_code_row(
    line: &crate::review_diff::Line,
    index: usize,
    key_prefix: &str,
    selection: &TranscriptSelection,
    style: DiffRowStyle,
    theme: &Theme,
) -> AnyElement {
    let semantic_body_opacity = if theme.is_dark { 0.20 } else { 0.12 };
    let semantic_gutter_opacity = if theme.is_dark { 0.15 } else { 0.09 };
    let (marker, body_background, gutter_background, edge, number_color) = match &line.kind {
        crate::review_diff::LineKind::Addition => (
            "+",
            Some(theme.success.opacity(semantic_body_opacity)),
            Some(theme.success.opacity(semantic_gutter_opacity)),
            Some(theme.success.opacity(0.7)),
            theme.success.opacity(0.7),
        ),
        crate::review_diff::LineKind::Deletion => (
            "-",
            Some(theme.danger.opacity(semantic_body_opacity)),
            Some(theme.danger.opacity(semantic_gutter_opacity)),
            Some(theme.danger.opacity(0.7)),
            theme.danger.opacity(0.7),
        ),
        _ => (" ", None, None, None, theme.text_tertiary),
    };
    let shown_line = line.new_line.or(line.old_line);
    let flat = review_diff_flat_text(line, theme);
    let selectable = md::render::selectable_flat_text(
        &flat,
        crate::md::selection::TextKey::new(diff_row_selection_key(key_prefix, line, index), 0),
        selection.clone(),
        theme.code_wash,
        theme.selection,
        false,
    );
    let gutter = div()
        .w(px(style.gutter_width))
        .min_h(px(style.row_height))
        .self_stretch()
        .flex_none()
        .pr(px(9.0))
        .flex()
        .items_start()
        .justify_end()
        .border_r_1()
        .border_color(theme.border)
        .text_color(number_color)
        .when_some(gutter_background, |gutter, background| {
            gutter.bg(background)
        })
        .child(
            shown_line
                .map(|line| line.to_string())
                .or_else(|| style.marker_fallback.then(|| marker.to_owned()))
                .unwrap_or_default(),
        );
    let body = div()
        .min_h(px(style.row_height))
        .self_stretch()
        .min_w_0()
        .flex_1()
        .pl(px(12.0))
        .flex()
        .items_start()
        .when_some(body_background, |body, background| body.bg(background))
        .child(
            div()
                .id(SharedString::from(format!(
                    "{key_prefix}-line-content-{index}"
                )))
                .min_h(px(style.row_height))
                .min_w_0()
                .flex_1()
                .pr(px(10.0))
                .flex()
                .items_start()
                .overflow_hidden()
                .whitespace_normal()
                .child(selectable),
        );
    div()
        .id(SharedString::from(format!("{key_prefix}-row-{index}")))
        .w_full()
        .min_w_0()
        .min_h(px(style.row_height))
        // A wrapped line makes the row taller than one line. Stacked in a
        // scrolling column, a shrinkable row would be squeezed back to one
        // and paint its overflow over the row beneath it.
        .flex_none()
        .flex()
        .items_stretch()
        .font_family(md::render::MONO_FAMILY)
        .text_size(px(style.text_size))
        .line_height(px(style.row_height))
        .when_some(edge, |row, edge| row.border_l_2().border_color(edge))
        .child(gutter)
        .child(body)
        .into_any_element()
}

fn review_diff_flat_text(line: &crate::review_diff::Line, theme: &Theme) -> md::render::FlatText {
    let text = line.content.clone();
    let palette = MarkdownPalette::from_theme(theme);
    let code_font = font(md::render::MONO_FAMILY);
    let mut runs = Vec::with_capacity(line.tokens.len() * 2 + 1);
    let mut offset = 0;
    let mut push = |len: usize, color: Hsla| {
        if len > 0 {
            runs.push(TextRun {
                len,
                font: code_font.clone(),
                color,
                background_color: None,
                underline: None,
                strikethrough: None,
            });
        }
    };
    for token in &line.tokens {
        if token.range.start > offset {
            push(token.range.start - offset, theme.text_secondary);
        }
        push(token.range.len(), palette.token(token.class));
        offset = token.range.end;
    }
    if offset < text.len() {
        push(text.len() - offset, theme.text_secondary);
    }
    md::render::FlatText {
        text: text.into(),
        runs,
        links: Vec::new(),
        code_ranges: Vec::new(),
    }
}

impl Tide {
    pub(in crate::app) fn open_activity_diff(&mut self, path: &str, cx: &mut Context<Self>) {
        let Some(workspace) = self.selected_workspace_path() else {
            return;
        };
        let trimmed = path.trim();
        let resolved = if Path::new(trimmed).is_absolute() {
            PathBuf::from(trimmed)
        } else {
            workspace.join(trimmed)
        };
        let Some(relative) = workspace_relative_file_path(&workspace, &resolved) else {
            return;
        };
        if self.active_right_panel_surface() == Some(&RightPanelSurface::Git)
            && let Some(selected) = self.git_panel.selected_file_diff.as_ref()
            && selected.path == relative
        {
            self.set_right_panel_visible(true, cx);
            cx.notify();
            return;
        }
        // The review surface has been replaced by the Git panel: the file
        // lands on its Changes tab as the selected-file diff sub-view.
        self.git_panel.tab = GitPanelTab::Changes;
        self.open_git_panel_file_diff(relative, false, cx);
        self.open_right_panel_surface(RightPanelSurface::Git, cx);
    }
}
