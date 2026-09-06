use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::branches::{BranchPickerContext, BranchPickerSurface};
use super::git_history::{self, GRAPH_WIDTH, HISTORY_ROW_H};
use super::git_panel::{GitChangesRow, GitFileSection, GitPanelTab, HistoryActionStage};
use super::*;
use crate::query::Query;
use crate::review_diff::{Snapshot as ReviewDiffSnapshot, Source as ReviewDiffSource};
use protocol::git_panel::{PanelCommit, PanelConflict, PanelFileChange};

/// One bulk-action menu row: label, icon, and the wire op it dispatches.
fn bulk_item(
    weak: &WeakEntity<Tide>,
    icon_path: &'static str,
    label: String,
    op: &'static str,
    busy: bool,
) -> MenuItem {
    let weak = weak.clone();
    MenuItem::new(label, move |_, cx| {
        let _ = weak.update(cx, |this, cx| this.run_git_panel_bulk_op(op, cx));
    })
    .icon(icon_path)
    .disabled(busy)
}

/// The branch chip as drawn before the picker was shared — the fallback
/// while the shared branch snapshot has not landed (and for workspaces
/// without one).
fn static_chip(branch: &str, theme: &Theme) -> Stateful<Div> {
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
fn commit_hue(seed: &str) -> f32 {
    let mut hue: u32 = 7;
    for byte in seed.bytes() {
        hue = (hue.wrapping_mul(31).wrapping_add(u32::from(byte))) % 360;
    }
    hue as f32 / 360.0
}

/// Up to two uppercase initials of an author name.
fn commit_initials(author: &str) -> String {
    let initials: String = author
        .split_whitespace()
        .filter_map(|word| word.chars().next())
        .take(2)
        .collect();
    initials.to_uppercase()
}

/// tide's formatRelative: "just now" through days, then the date.
fn relative_commit_date(iso: &str) -> String {
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
fn absolute_commit_date(iso: &str) -> String {
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
fn strip_subject(message: &str, subject: &str) -> String {
    let trimmed = message.trim();
    if !subject.is_empty() {
        if let Some(rest) = trimmed.strip_prefix(subject) {
            return rest.trim_start_matches('\n').trim_end().to_owned();
        }
    }
    trimmed.to_owned()
}

/// Status-word color for a changed file in the commit details.
fn file_status_color(theme: &Theme, status: &str) -> Hsla {
    match status {
        "added" => theme.success,
        "deleted" => theme.danger,
        "renamed" => theme.gauge,
        "modified" => theme.warning,
        _ => theme.text_tertiary,
    }
}

/// One keyboard-reachable action row in the History "…" card.
fn render_history_action_item(
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
fn render_history_action_button(
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
fn git_change_at(
    status: &Query<(), Vec<PanelFileChange>>,
    index: usize,
) -> Option<PanelFileChange> {
    match status {
        Query::Ready(changes) => changes.get(index).cloned(),
        Query::Pending | Query::Missing(_) => None,
    }
}

fn git_conflict_at(
    conflicts: &Query<(), Vec<PanelConflict>>,
    index: usize,
) -> Option<PanelConflict> {
    match conflicts {
        Query::Ready(conflicts) => conflicts.get(index).cloned(),
        Query::Pending | Query::Missing(_) => None,
    }
}

const TAB_SCROLL_FADE_WIDTH: f32 = 24.0;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct WorkingTreeEntry {
    relative_path: String,
    absolute_path: PathBuf,
    name: String,
    is_dir: bool,
    file_icon: Option<&'static str>,
    expanded: bool,
    depth: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TranscriptLinkRoute {
    ProjectFile(String),
    Finder(PathBuf),
    External,
}

fn positive_number(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<usize>().is_ok_and(|value| value > 0)
}

fn line_fragment(fragment: &str) -> bool {
    let Some(location) = fragment.strip_prefix('L') else {
        return false;
    };
    match location.split_once('C') {
        Some((line, column)) => positive_number(line) && positive_number(column),
        None => positive_number(location),
    }
}

/// Removes the `:line`, `:line:column`, or `#LlineCcolumn` suffixes Codex uses
/// in clickable local-file references. The location is not yet consumed by
/// Tide's compact editor, but it must not become part of the filesystem path.
fn strip_file_location(target: &str) -> &str {
    if let Some((path, fragment)) = target.rsplit_once('#')
        && line_fragment(fragment)
    {
        return path;
    }

    let Some((before_last, last)) = target.rsplit_once(':') else {
        return target;
    };
    if !positive_number(last) {
        return target;
    }
    if let Some((path, line)) = before_last.rsplit_once(':')
        && positive_number(line)
    {
        path
    } else {
        before_last
    }
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode_file_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let (Some(high), Some(low)) = (
                bytes.get(index + 1).copied().and_then(hex_value),
                bytes.get(index + 2).copied().and_then(hex_value),
            )
        {
            decoded.push(high << 4 | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).unwrap_or_else(|_| path.to_owned())
}

fn markdown_file_link_path(target: &str) -> Option<PathBuf> {
    let target = strip_file_location(target.trim());
    if target
        .get(..5)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
    {
        return url::Url::parse(target).ok()?.to_file_path().ok();
    }

    let path = PathBuf::from(percent_decode_file_path(target));
    path.is_absolute().then_some(path)
}

fn normalized_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn workspace_relative_file_path(workspace: &Path, target: &Path) -> Option<String> {
    fn relative(workspace: &Path, target: &Path) -> Option<String> {
        let relative = target.strip_prefix(workspace).ok()?;
        if relative.as_os_str().is_empty() {
            return None;
        }
        Some(relative.to_string_lossy().into_owned())
    }

    let workspace = normalized_path(workspace);
    let target = normalized_path(target);
    // These are daemon-host paths. Routing is intentionally lexical: probing
    // the desktop filesystem would reinterpret a remote workspace locally.
    relative(&workspace, &target)
}

fn transcript_link_route(target: &str, workspace: Option<&Path>) -> TranscriptLinkRoute {
    let Some(path) = markdown_file_link_path(target) else {
        return TranscriptLinkRoute::External;
    };
    let path = normalized_path(&path);
    if let Some(relative_path) =
        workspace.and_then(|workspace| workspace_relative_file_path(workspace, &path))
    {
        TranscriptLinkRoute::ProjectFile(relative_path)
    } else {
        TranscriptLinkRoute::Finder(path)
    }
}

pub(super) fn file_icon_for_path(path: &str) -> &'static str {
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path);
    file_icon_for_name(name)
}

fn review_diff_gap_icon_path(direction: crate::review_diff::ExpansionDirection) -> &'static str {
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

fn review_diff_gap_tooltip(direction: crate::review_diff::ExpansionDirection) -> String {
    match direction {
        crate::review_diff::ExpansionDirection::Start => tr!("diff.expand_context_below"),
        crate::review_diff::ExpansionDirection::End => tr!("diff.expand_context_above"),
        crate::review_diff::ExpansionDirection::Both => tr!("diff.expand_context"),
        crate::review_diff::ExpansionDirection::All => tr!("diff.expand_all_context"),
    }
}

fn review_diff_gap_directions(
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
pub(super) struct DiffRowStyle {
    gutter_width: f32,
    row_height: f32,
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
    pub(super) fn review(text_size: f32) -> Self {
        Self {
            gutter_width: (text_size * 3.0 + 14.0).round(),
            row_height: (text_size * 1.5).round(),
            text_size,
            marker_fallback: false,
        }
    }

    /// The same rows the Review tab draws, so an edit reads the same wherever
    /// it is opened.
    pub(super) fn activity(text_size: f32) -> Self {
        Self {
            marker_fallback: true,
            ..Self::review(text_size)
        }
    }

    pub(super) fn gutter_width(&self) -> f32 {
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
fn diff_row_selection_key(
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
pub(super) fn render_diff_code_row(
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
            Some(theme.success),
            theme.success,
        ),
        crate::review_diff::LineKind::Deletion => (
            "-",
            Some(theme.danger.opacity(semantic_body_opacity)),
            Some(theme.danger.opacity(semantic_gutter_opacity)),
            Some(theme.danger),
            theme.danger,
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

fn file_icon_for_name(name: &str) -> &'static str {
    let name = name.to_ascii_lowercase();
    let named_icon = if name.starts_with("readme") {
        Some("icons/file-types/readme.svg")
    } else if name.starts_with("license")
        || name.starts_with("licence")
        || name.starts_with("copying")
    {
        Some("icons/file-types/certificate.svg")
    } else if name.starts_with("dockerfile") || name.starts_with("compose.") {
        Some("icons/file-types/docker.svg")
    } else if name == "cmakelists.txt" || name.starts_with("cmake.") {
        Some("icons/file-types/cmake.svg")
    } else if name == "makefile" || name.starts_with("makefile.") || name == "justfile" {
        Some("icons/file-types/makefile.svg")
    } else if matches!(
        name.as_str(),
        "cargo.toml" | "cargo.lock" | "rust-toolchain.toml"
    ) {
        Some("icons/file-types/rust.svg")
    } else if matches!(name.as_str(), "go.mod" | "go.sum" | "go.work") {
        Some("icons/file-types/go.svg")
    } else if name == "pyproject.toml" || name == "pipfile" || name.starts_with("requirements") {
        Some("icons/file-types/python.svg")
    } else if matches!(name.as_str(), "bun.lock" | "bun.lockb" | "bunfig.toml") {
        Some("icons/file-types/bun.svg")
    } else if name.starts_with("pnpm-") || name == ".pnpmfile.cjs" {
        Some("icons/file-types/pnpm.svg")
    } else if name == "yarn.lock" || name.starts_with(".yarnrc") {
        Some("icons/file-types/yarn.svg")
    } else if name == "package.json" {
        Some("icons/file-types/nodejs.svg")
    } else if name == "package-lock.json" {
        Some("icons/file-types/npm.svg")
    } else if name.starts_with("tsconfig.") || name == "tsconfig.json" {
        Some("icons/file-types/typescript.svg")
    } else if name.starts_with("jsconfig.") || name == "jsconfig.json" {
        Some("icons/file-types/javascript.svg")
    } else if name == ".gitignore"
        || name == ".gitattributes"
        || name == ".gitmodules"
        || name == ".gitconfig"
    {
        Some("icons/file-types/git.svg")
    } else if name == ".editorconfig" {
        Some("icons/file-types/editorconfig.svg")
    } else if name.starts_with(".env") {
        Some("icons/file-types/settings.svg")
    } else if name.starts_with(".prettier") || name.starts_with("prettier.config.") {
        Some("icons/file-types/prettier.svg")
    } else if name.starts_with(".eslint") || name.starts_with("eslint.config.") {
        Some("icons/file-types/eslint.svg")
    } else if name.starts_with("biome.json") {
        Some("icons/file-types/biome.svg")
    } else if name.starts_with(".babel") || name.starts_with("babel.config.") {
        Some("icons/file-types/babel.svg")
    } else if name.starts_with(".stylelint") || name.starts_with("stylelint.config.") {
        Some("icons/file-types/stylelint.svg")
    } else if name.starts_with("vite.config.") {
        Some("icons/file-types/vite.svg")
    } else if name.starts_with("vitest.config.") || name.starts_with("vitest.workspace.") {
        Some("icons/file-types/vitest.svg")
    } else if name.starts_with("webpack.") {
        Some("icons/file-types/webpack.svg")
    } else if name.starts_with("rollup.config.") {
        Some("icons/file-types/rollup.svg")
    } else if name.starts_with("next.config.") {
        Some("icons/file-types/next.svg")
    } else if name == "next-env.d.ts" {
        Some("icons/file-types/next.svg")
    } else if name.starts_with("nuxt.config.") || name == ".nuxtrc" {
        Some("icons/file-types/nuxt.svg")
    } else if name.starts_with("astro.config.") {
        Some("icons/file-types/astro.svg")
    } else if name == "angular.json" || name.ends_with(".component.ts") {
        Some("icons/file-types/angular.svg")
    } else if name == "nest-cli.json" {
        Some("icons/file-types/nest.svg")
    } else if name.starts_with("tailwind.config.") {
        Some("icons/file-types/tailwindcss.svg")
    } else if name.starts_with("svelte.config.") {
        Some("icons/file-types/svelte.svg")
    } else if name.starts_with("vue.config.") {
        Some("icons/file-types/vue.svg")
    } else if name == "firebase.json" || name == ".firebaserc" {
        Some("icons/file-types/firebase.svg")
    } else if name == "supabase.toml" {
        Some("icons/file-types/supabase.svg")
    } else if name.starts_with("prisma.config.") {
        Some("icons/file-types/prisma.svg")
    } else if name == "turbo.json" {
        Some("icons/file-types/turborepo.svg")
    } else if name.starts_with("deno.json") || name == "deno.lock" {
        Some("icons/file-types/deno.svg")
    } else if name == ".gitlab-ci.yml" || name == ".gitlab-ci.yaml" {
        Some("icons/file-types/gitlab.svg")
    } else if name == "kustomization.yaml" || name == "kustomization.yml" {
        Some("icons/file-types/kubernetes.svg")
    } else if name == "chart.yaml" || name == "values.yaml" {
        Some("icons/file-types/helm.svg")
    } else if name == "nginx.conf" {
        Some("icons/file-types/nginx.svg")
    } else if name == ".nvmrc" || name == ".node-version" {
        Some("icons/file-types/nodejs.svg")
    } else if name == "build.gradle"
        || name == "settings.gradle"
        || name == "gradlew"
        || name == "gradlew.bat"
    {
        Some("icons/file-types/gradle.svg")
    } else if name.contains(".stories.") || name.contains(".story.") {
        Some("icons/file-types/storybook.svg")
    } else if name == "gemfile" || name == "gemfile.lock" {
        Some("icons/file-types/ruby.svg")
    } else if name == "pom.xml" {
        Some("icons/file-types/java.svg")
    } else {
        None
    };
    if let Some(icon) = named_icon {
        return icon;
    }

    let extension = Path::new(&name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    match extension {
        "rs" => "icons/file-types/rust.svg",
        "js" | "mjs" | "cjs" => "icons/file-types/javascript.svg",
        "ts" | "mts" | "cts" => "icons/file-types/typescript.svg",
        "jsx" | "tsx" => "icons/file-types/react.svg",
        "py" | "pyi" | "pyw" => "icons/file-types/python.svg",
        "go" => "icons/file-types/go.svg",
        "c" | "h" | "m" => "icons/file-types/c.svg",
        "cc" | "cpp" | "cxx" | "hh" | "hpp" | "hxx" | "mm" => "icons/file-types/cpp.svg",
        "cs" => "icons/file-types/csharp.svg",
        "swift" => "icons/file-types/swift.svg",
        "kt" | "kts" => "icons/file-types/kotlin.svg",
        "java" | "class" => "icons/file-types/java.svg",
        "rb" => "icons/file-types/ruby.svg",
        "php" => "icons/file-types/php.svg",
        "html" | "htm" => "icons/file-types/html.svg",
        "css" | "less" => "icons/file-types/css.svg",
        "scss" | "sass" => "icons/file-types/sass.svg",
        "json" | "jsonc" | "jsonl" => "icons/file-types/json.svg",
        "yaml" | "yml" => "icons/file-types/yaml.svg",
        "toml" | "ini" | "cfg" | "conf" | "config" => "icons/file-types/settings.svg",
        "xml" | "xsl" | "plist" => "icons/file-types/xml.svg",
        "md" | "mdx" | "markdown" => "icons/file-types/markdown.svg",
        "sh" | "bash" | "zsh" | "fish" => "icons/file-types/console.svg",
        "ps1" | "psm1" => "icons/file-types/powershell.svg",
        "sql" | "db" | "sqlite" | "sqlite3" | "csv" | "xls" | "xlsx" => {
            "icons/file-types/database.svg"
        }
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "ico" | "tiff" => {
            "icons/file-types/image.svg"
        }
        "svg" => "icons/file-types/svg.svg",
        "pdf" => "icons/file-types/pdf.svg",
        "mp3" | "wav" | "flac" | "ogg" | "m4a" => "icons/file-types/audio.svg",
        "mp4" | "mov" | "avi" | "webm" | "mkv" => "icons/file-types/video.svg",
        "zip" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" | "tar" | "jar" => {
            "icons/file-types/zip.svg"
        }
        "wasm" | "wat" => "icons/file-types/webassembly.svg",
        "svelte" => "icons/file-types/svelte.svg",
        "vue" => "icons/file-types/vue.svg",
        "tf" | "tfvars" => "icons/file-types/terraform.svg",
        "graphql" | "gql" => "icons/file-types/graphql.svg",
        "lua" => "icons/file-types/lua.svg",
        "dart" => "icons/file-types/dart.svg",
        "astro" => "icons/file-types/astro.svg",
        "coffee" | "cson" => "icons/file-types/coffee.svg",
        "cr" => "icons/file-types/crystal.svg",
        "ex" | "exs" => "icons/file-types/elixir.svg",
        "elm" => "icons/file-types/elm.svg",
        "erl" | "hrl" => "icons/file-types/erlang.svg",
        "clj" | "cljs" | "cljc" | "edn" => "icons/file-types/clojure.svg",
        "hs" | "lhs" => "icons/file-types/haskell.svg",
        "hx" | "hxml" => "icons/file-types/haxe.svg",
        "jinja" | "jinja2" | "j2" => "icons/file-types/jinja.svg",
        "jl" => "icons/file-types/julia.svg",
        "ml" | "mli" => "icons/file-types/ocaml.svg",
        "pl" | "pm" => "icons/file-types/perl.svg",
        "prisma" => "icons/file-types/prisma.svg",
        "pug" | "jade" => "icons/file-types/pug.svg",
        "scala" | "sbt" | "sc" => "icons/file-types/scala.svg",
        "sol" => "icons/file-types/solidity.svg",
        "tex" | "sty" | "cls" => "icons/file-types/tex.svg",
        "xaml" => "icons/file-types/xaml.svg",
        "zig" => "icons/file-types/zig.svg",
        "nix" => "icons/file-types/nix.svg",
        "proto" => "icons/file-types/proto.svg",
        "diff" | "patch" => "icons/file-types/diff.svg",
        "exe" | "dll" | "so" | "dylib" => "icons/file-types/exe.svg",
        "lock" => "icons/file-types/lock.svg",
        _ => "icons/file-types/file.svg",
    }
}

#[cfg(test)]
fn visible_working_tree_entries(
    root: &Path,
    expanded_paths: &HashSet<PathBuf>,
) -> Vec<WorkingTreeEntry> {
    fn visit(
        directory: &Path,
        relative_directory: &Path,
        depth: usize,
        expanded_paths: &HashSet<PathBuf>,
        entries: &mut Vec<WorkingTreeEntry>,
    ) {
        let Ok(read_dir) = std::fs::read_dir(directory) else {
            return;
        };
        let mut children = read_dir
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == ".git" {
                    return None;
                }
                let is_dir = entry.file_type().ok()?.is_dir();
                Some((entry.path(), name, is_dir))
            })
            .collect::<Vec<_>>();
        children.sort_by_key(|(_, name, is_dir)| (!*is_dir, name.to_lowercase()));

        for (absolute_path, name, is_dir) in children {
            let relative_path = relative_directory.join(&name);
            let expanded = is_dir && expanded_paths.contains(&absolute_path);
            let file_icon = (!is_dir).then(|| file_icon_for_name(&name));
            entries.push(WorkingTreeEntry {
                relative_path: relative_path.to_string_lossy().into_owned(),
                absolute_path: absolute_path.clone(),
                name,
                is_dir,
                file_icon,
                expanded,
                depth,
            });
            if expanded {
                visit(
                    &absolute_path,
                    &relative_path,
                    depth + 1,
                    expanded_paths,
                    entries,
                );
            }
        }
    }

    let mut entries = Vec::new();
    visit(root, Path::new(""), 0, expanded_paths, &mut entries);
    entries
}

/// The language name for a file, as understood by [`crate::md::highlight`].
/// Names the lexer does not know simply render unhighlighted.
fn file_highlighter_language(relative_path: &str) -> &'static str {
    let path = Path::new(relative_path);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let normalized_file_name = file_name.to_ascii_lowercase();

    // Lockfiles often have a generic `.lock` suffix (or no useful extension),
    // so resolve their actual serialization format before extension fallback.
    let lockfile_language = match normalized_file_name.as_str() {
        "bun.lock"
        | "composer.lock"
        | "conan.lock"
        | "deno.lock"
        | "flake.lock"
        | "npm-shrinkwrap.json"
        | "package-lock.json"
        | "package.resolved"
        | "packages.lock.json"
        | "pipfile.lock" => Some("json"),
        "cargo.lock" | "pdm.lock" | "poetry.lock" | "uv.lock" => Some("toml"),
        "chart.lock" | "gemfile.lock" | "pnpm-lock.yaml" | "podfile.lock" | "pubspec.lock"
        | "yarn.lock" => Some("yaml"),
        "mix.lock" => Some("elixir"),
        _ => None,
    };
    if let Some(language) = lockfile_language {
        return language;
    }

    if file_name == "Makefile" || file_name.starts_with("Makefile.") {
        return "make";
    }
    if normalized_file_name == "dockerfile" || normalized_file_name.starts_with("dockerfile.") {
        return "dockerfile";
    }

    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("rs") => "rust",
        Some("ts" | "mts" | "cts") => "typescript",
        Some("tsx") => "tsx",
        Some("js" | "jsx" | "mjs" | "cjs") => "javascript",
        Some("py" | "pyi") => "python",
        Some("go") => "go",
        Some("c") => "c",
        Some("h" | "hpp" | "hh" | "hxx" | "cc" | "cpp" | "cxx") => "cpp",
        Some("m" | "mm") => "objc",
        Some("java" | "kt" | "kts") => "java",
        Some("cs") => "csharp",
        Some("scala" | "sc") => "scala",
        Some("rb" | "rake" | "gemspec") => "ruby",
        Some("swift") => "swift",
        Some("json" | "jsonc" | "json5") => "json",
        Some("yaml" | "yml") => "yaml",
        Some("toml") => "toml",
        Some("ini" | "cfg" | "conf") => "ini",
        Some("sh" | "bash" | "zsh" | "fish") => "bash",
        Some("css" | "scss" | "sass" | "less") => "css",
        Some("html" | "htm" | "xml" | "svg" | "vue" | "svelte") => "html",
        Some("sql") => "sql",
        Some("diff" | "patch") => "diff",
        Some("md" | "markdown" | "mdx") => "markdown",
        _ => "text",
    }
}

/// Reads a file for the editor, returning its text and whether it can be saved.
///
/// One unbounded `read_to_string`, so callers keep it off the UI thread; the
/// only caller is [`Tide::read_right_panel_file_into_editor`].
fn read_right_panel_file(
    workspace: &client::WorkspaceClient,
    project_path: &Path,
    relative_path: &str,
) -> (String, bool) {
    match workspace.request(client::WorkspaceOperation::ReadTextFile {
        root: project_path.to_path_buf(),
        relative_path: PathBuf::from(relative_path),
    }) {
        Ok(client::WorkspaceResult::TextFile { content }) => (content, true),
        Ok(_) => (
            tr!(
                "files.unable_to_edit",
                error = "the daemon returned an invalid file response"
            ),
            false,
        ),
        Err(error) => (
            tr!("files.unable_to_edit", error = error.to_string()),
            false,
        ),
    }
}

impl RightPanelSurface {
    fn new_browser() -> Self {
        Self::Browser(Uuid::new_v4())
    }

    pub(super) fn new_terminal() -> Self {
        Self::Terminal(Uuid::new_v4())
    }

    fn terminal_id(&self) -> Option<Uuid> {
        match self {
            Self::Terminal(id) => Some(*id),
            _ => None,
        }
    }

    fn browser_id(&self) -> Option<Uuid> {
        match self {
            Self::Browser(id) => Some(*id),
            _ => None,
        }
    }

    fn label(&self) -> String {
        match self {
            Self::Browser(_) => tr!("right_panel.browser"),
            Self::Terminal(_) => tr!("right_panel.terminal"),
            Self::BackgroundWork { key, title } => {
                if title.is_empty() {
                    match key.kind {
                        BackgroundWorkKind::Process => tr!("background.process"),
                        BackgroundWorkKind::Subagent => tr!("background.subagent"),
                    }
                } else {
                    title.clone()
                }
            }
            Self::Files => tr!("right_panel.files"),
            Self::Agents => tr!("right_panel.agents"),
            Self::Git => tr!("right_panel.git"),
            Self::File(path) => path.rsplit('/').next().unwrap_or(path).to_owned(),
        }
    }

    fn icon_path(&self) -> &'static str {
        match self {
            Self::Browser(_) => "icons/globe.svg",
            Self::Terminal(_) => "icons/terminal.svg",
            Self::BackgroundWork { key, .. } => work_kind_icon(key.kind),
            Self::Files => "icons/folder.svg",
            Self::Agents => "icons/bot.svg",
            Self::Git => "icons/git-branch.svg",
            Self::File(path) => file_icon_for_path(path),
        }
    }
}

fn right_panel_tab_label(surface: &RightPanelSurface, files_selected_path: Option<&str>) -> String {
    let label = match surface {
        RightPanelSurface::Files => files_selected_path
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| tr!("right_panel.files")),
        _ => surface.label(),
    };
    single_line_label(&label)
}

fn right_panel_tab_icon(
    surface: &RightPanelSurface,
    files_selected_path: Option<&str>,
) -> &'static str {
    match surface {
        RightPanelSurface::Files => files_selected_path
            .map(file_icon_for_path)
            .unwrap_or_else(|| surface.icon_path()),
        _ => surface.icon_path(),
    }
}

fn reusable_surface_index(
    surfaces: &[RightPanelSurface],
    requested: &RightPanelSurface,
) -> Option<usize> {
    match requested {
        RightPanelSurface::Browser(_) | RightPanelSurface::Terminal(_) => None,
        RightPanelSurface::BackgroundWork { key, .. } => surfaces.iter().position(|surface| {
            matches!(surface, RightPanelSurface::BackgroundWork { key: candidate, .. } if candidate == key)
        }),
        RightPanelSurface::Agents
        | RightPanelSurface::Files
        | RightPanelSurface::Git
        | RightPanelSurface::File(_) => surfaces.iter().position(|surface| surface == requested),
    }
}

fn tab_scroll_reveal_guard(
    scroll_handle: ScrollHandle,
    tab_index: usize,
    tide: WeakEntity<Tide>,
) -> impl IntoElement {
    canvas(
        move |_, window, _| {
            if let Some(item) = scroll_handle.bounds_for_item(tab_index) {
                let viewport = scroll_handle.bounds();
                let offset = scroll_handle.offset();
                let safe_offset = crate::ui::scroll_fade::fade_safe_offset(
                    offset.x,
                    scroll_handle.max_offset().x,
                    item.left(),
                    item.right(),
                    viewport.left(),
                    viewport.right(),
                    TAB_SCROLL_FADE_WIDTH,
                );
                if safe_offset != offset.x {
                    scroll_handle.set_offset(point(safe_offset, offset.y));
                }
            }

            window.on_next_frame(move |_, cx| {
                let _ = tide.update(cx, |this, cx| {
                    if this.right_panel_pending_tab_reveal == Some(tab_index) {
                        this.right_panel_pending_tab_reveal = None;
                        cx.notify();
                    }
                });
            });
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_full()
}

#[allow(clippy::items_after_test_module)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_file_links_route_by_the_active_workspace() {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"));
        let project_file = workspace.join("src/app/right_panel.rs");
        let project_file_with_line = format!("{}:1596", project_file.display());
        let project_file_with_column = format!("{}:1596:8", project_file.display());
        let relative_project_file = Path::new("src")
            .join("app")
            .join("right_panel.rs")
            .to_string_lossy()
            .into_owned();

        assert_eq!(
            transcript_link_route(&project_file_with_line, Some(workspace)),
            TranscriptLinkRoute::ProjectFile(relative_project_file.clone())
        );
        assert_eq!(
            transcript_link_route(&project_file_with_column, Some(workspace)),
            TranscriptLinkRoute::ProjectFile(relative_project_file)
        );

        let encoded_file_url =
            url::Url::from_file_path(workspace.join("My File.rs")).expect("absolute file path");
        assert_eq!(
            transcript_link_route(&format!("{encoded_file_url}#L12C4"), Some(workspace)),
            TranscriptLinkRoute::ProjectFile("My File.rs".into())
        );

        let outside_file = workspace.join("../kero/src/app.rs");
        let outside_file_with_line = format!("{}:20", outside_file.display());
        assert_eq!(
            transcript_link_route(&outside_file_with_line, Some(workspace)),
            TranscriptLinkRoute::Finder(normalized_path(&outside_file))
        );
        assert_eq!(
            transcript_link_route("https://example.com/file.rs:12", Some(workspace)),
            TranscriptLinkRoute::External
        );
    }

    /// Selection resolves rows by key, so a repeated key makes a drag jump
    /// between the duplicates. Numbered rows keep their number-derived keys
    /// (stable across Review's gap expansion); rows a provider never
    /// positioned fall back to the row index.
    #[test]
    fn diff_row_selection_keys_are_unique_even_without_line_numbers() {
        let positionless =
            crate::review_diff::from_file_changes(&[crate::model::ActivityFileChange {
                path: "a.md".into(),
                additions: Some(2),
                deletions: Some(0),
                status: None,
                diff: Some("@@\n+one\n+two\n \n+three\n".into()),
            }]);
        let keys = positionless
            .lines
            .iter()
            .enumerate()
            .filter(|(_, line)| {
                matches!(
                    line.kind,
                    crate::review_diff::LineKind::Context
                        | crate::review_diff::LineKind::Addition
                        | crate::review_diff::LineKind::Deletion
                )
            })
            .map(|(index, line)| diff_row_selection_key("activity", line, index))
            .collect::<Vec<_>>();
        let unique = keys.iter().collect::<HashSet<_>>();
        assert_eq!(unique.len(), keys.len(), "{keys:?}");

        let numbered = crate::review_diff::Line {
            file_index: 0,
            old_line: Some(4),
            new_line: Some(6),
            kind: crate::review_diff::LineKind::Context,
            content: "kept".into(),
            tokens: Vec::new(),
        };
        assert_eq!(
            diff_row_selection_key("review-diff", &numbered, 9),
            "review-diff-line-0-context-4-6",
        );
    }

    #[test]
    fn review_gap_expansion_icons_match_pierre_visual_directions() {
        use crate::review_diff::{ExpansionDirection, GapPosition};

        assert_eq!(
            review_diff_gap_directions(GapPosition::Leading, true),
            &[ExpansionDirection::End]
        );
        assert_eq!(
            review_diff_gap_directions(GapPosition::Trailing, true),
            &[ExpansionDirection::Start]
        );
        assert_eq!(
            review_diff_gap_directions(GapPosition::Between, false),
            &[ExpansionDirection::Both]
        );
        assert_eq!(
            review_diff_gap_directions(GapPosition::Between, true),
            &[ExpansionDirection::Start, ExpansionDirection::End]
        );

        assert_eq!(
            review_diff_gap_icon_path(ExpansionDirection::Start),
            "icons/chevron-down.svg"
        );
        assert_eq!(
            review_diff_gap_icon_path(ExpansionDirection::End),
            "icons/chevron-up.svg"
        );
        assert_eq!(
            review_diff_gap_icon_path(ExpansionDirection::Both),
            "icons/chevrons-up-down.svg"
        );
    }

    #[test]
    fn review_render_path_only_reads_the_in_memory_snapshot() {
        let source = include_str!("right_panel.rs");
        let start = source
            .find("\n    fn render_git_file_diff_sub_view(")
            .expect("git diff render fn");
        let body = &source[start + 1..];
        let end = body
            .find("\n    pub(super) fn render_right_panel_empty_message(")
            .expect("git diff render end");
        let body = &body[..end];

        for forbidden in [
            "Command::new",
            "std::fs::",
            "review_diff::collect",
            "capture_worktree_commit",
        ] {
            assert!(
                !body.contains(forbidden),
                "Git diff rendering must not call `{forbidden}`; prepare it in the request tasks"
            );
        }
    }

    /// A wrapped diff line must grow its row rather than be clipped by it.
    /// Both the panel's own rows and the shared code row have to hold this,
    /// and the shared one is also what the transcript's diff paints with.
    #[test]
    fn diff_text_rows_soft_wrap() {
        let source = include_str!("right_panel.rs");
        let panel = source
            .split_once("\n    fn render_right_panel_diff_line(")
            .expect("review diff line renderer")
            .1
            .split_once("\n    #[allow(clippy::too_many_arguments)]")
            .expect("review diff line renderer end")
            .0;
        let shared = source
            .split_once("\npub(super) fn render_diff_code_row(")
            .expect("shared diff code row")
            .1
            .split_once("\nfn review_diff_flat_text(")
            .expect("shared diff code row end")
            .0;

        for body in [panel, shared] {
            assert!(!body.contains(".whitespace_nowrap()"));
        }
        assert!(panel.matches(".whitespace_normal()").count() >= 2);
        assert!(shared.contains(".whitespace_normal()"));
        assert!(shared.contains(".min_h(px(style.row_height))"));
        assert!(!shared.contains(".h(px(style.row_height))"));
    }

    /// The render path must never reach the filesystem. This reads the source
    /// rather than the behaviour, because the cost of a regression here is a
    /// syscall per directory entry on every frame — invisible until a project
    /// is large or its volume is slow.
    #[test]
    fn the_working_tree_render_path_does_no_filesystem_work() {
        let source = include_str!("right_panel.rs");
        // Anchored on the definition's indentation so this test does not match
        // its own string literals.
        let start = source
            .find("\n    fn render_right_panel_working_tree(")
            .expect("render fn");
        let body = &source[start + 1..];
        let end = body.find("\n    fn ").unwrap_or(body.len());
        let body = &body[..end];

        for forbidden in [
            "visible_working_tree_entries",
            "read_dir",
            "std::fs::",
            "metadata(",
        ] {
            assert!(
                !body.contains(forbidden),
                "render_right_panel_working_tree must not call `{forbidden}`; \
                 walk the tree in refresh_right_panel_working_tree instead"
            );
        }
    }

    /// Same guard for the file editor, which `render_right_panel_file` reaches
    /// on every frame that draws a file tab. Opening a large file used to read
    /// it inline, so the frame that revealed the tab paid for the whole file.
    #[test]
    fn the_file_editor_render_path_does_no_filesystem_work() {
        let source = include_str!("right_panel.rs");
        let start = source
            .find("\n    fn ensure_right_panel_file_editor(")
            .expect("ensure fn");
        let body = &source[start + 1..];
        let end = body
            .find("\n    /// Reads a file into its editor")
            .unwrap_or(body.len());
        let body = &body[..end];

        for forbidden in ["read_right_panel_file(", "std::fs::", "metadata("] {
            assert!(
                !body.contains(forbidden),
                "ensure_right_panel_file_editor must not call `{forbidden}`; \
                 read the file in read_right_panel_file_into_editor instead"
            );
        }
    }

    #[test]
    fn working_tree_only_descends_into_expanded_directories() {
        let root = std::env::temp_dir().join(format!("tide-working-tree-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src/nested")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(root.join("README.md"), "# Tide\n").unwrap();

        let collapsed = visible_working_tree_entries(&root, &HashSet::new());
        assert_eq!(
            collapsed
                .iter()
                .map(|entry| entry.relative_path.clone())
                .collect::<Vec<_>>(),
            vec!["src".to_owned(), "README.md".to_owned()]
        );

        let expanded = HashSet::from([root.join("src")]);
        let visible = visible_working_tree_entries(&root, &expanded);
        let nested = Path::new("src")
            .join("nested")
            .to_string_lossy()
            .into_owned();
        let main_rs = Path::new("src")
            .join("main.rs")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            visible
                .iter()
                .map(|entry| (entry.relative_path.clone(), entry.depth))
                .collect::<Vec<_>>(),
            vec![
                ("src".to_owned(), 0),
                (nested, 1),
                (main_rs, 1),
                ("README.md".to_owned(), 0)
            ]
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_highlighter_language_follows_file_name_and_extension() {
        assert_eq!(file_highlighter_language("src/app.rs"), "rust");
        assert_eq!(file_highlighter_language("ui/panel.tsx"), "tsx");
        assert_eq!(file_highlighter_language("Sources/App.swift"), "swift");
        assert_eq!(file_highlighter_language("Makefile"), "make");
        assert_eq!(file_highlighter_language("src/native.hpp"), "cpp");
        assert_eq!(file_highlighter_language("LICENSE"), "text");

        for (path, expected_language) in [
            ("bun.lock", "json"),
            ("package-lock.json", "json"),
            ("deno.lock", "json"),
            ("composer.lock", "json"),
            ("Pipfile.lock", "json"),
            ("Package.resolved", "json"),
            ("Cargo.lock", "toml"),
            ("uv.lock", "toml"),
            ("poetry.lock", "toml"),
            ("pnpm-lock.yaml", "yaml"),
            ("yarn.lock", "yaml"),
            ("Podfile.lock", "yaml"),
            ("Gemfile.lock", "yaml"),
            ("mix.lock", "elixir"),
        ] {
            assert_eq!(file_highlighter_language(path), expected_language, "{path}");
        }
    }

    /// The editor colours code with the in-house lexer, so what matters is that
    /// the names `file_highlighter_language` produces are ones the lexer knows.
    /// The few it does not are listed here deliberately: they render as plain
    /// monospace rather than silently looking broken.
    #[test]
    fn mapped_languages_resolve_in_the_in_house_lexer() {
        use crate::md::highlight::{Lang, lang_for_tag};

        for (language, expected) in [
            ("rust", Some(Lang::Rust)),
            ("tsx", Some(Lang::Script)),
            ("swift", Some(Lang::Swift)),
            ("json", Some(Lang::Json)),
            ("toml", Some(Lang::Toml)),
            ("yaml", Some(Lang::Yaml)),
            ("make", Some(Lang::Shell)),
            ("cpp", Some(Lang::C)),
            ("markdown", Some(Lang::Markdown)),
            // Not yet lexed; these fall back to unhighlighted monospace.
            ("elixir", None),
            ("text", None),
        ] {
            assert_eq!(lang_for_tag(language), expected, "{language}");
        }
    }

    #[test]
    fn the_editor_lexer_colours_code_it_recognises() {
        use crate::md::highlight::{Carry, Lang, TokenClass, tokenize_line};

        let line = r#"export function Card({ title }: { title: string }) {"#;
        let spans = tokenize_line(Lang::Script, line, Carry::None)
            .0
            .into_iter()
            .map(|token| (&line[token.range], token.class))
            .collect::<Vec<_>>();

        assert!(spans.contains(&("export", TokenClass::Keyword)));
        assert!(spans.contains(&("function", TokenClass::Keyword)));
        assert!(spans.contains(&("Card", TokenClass::Function)));
    }

    #[test]
    fn working_tree_file_icons_follow_names_and_extensions() {
        assert_eq!(file_icon_for_name("main.rs"), "icons/file-types/rust.svg");
        assert_eq!(
            file_icon_for_name("Panel.tsx"),
            "icons/file-types/react.svg"
        );
        assert_eq!(
            file_icon_for_name("README.md"),
            "icons/file-types/readme.svg"
        );
        assert_eq!(
            file_icon_for_name("Dockerfile.dev"),
            "icons/file-types/docker.svg"
        );
        assert_eq!(file_icon_for_name("bun.lock"), "icons/file-types/bun.svg");
        assert_eq!(
            file_icon_for_name("pnpm-lock.yaml"),
            "icons/file-types/pnpm.svg"
        );
        assert_eq!(
            file_icon_for_name("vite.config.ts"),
            "icons/file-types/vite.svg"
        );
        assert_eq!(
            file_icon_for_name("unknown.data"),
            "icons/file-types/file.svg"
        );
    }

    #[test]
    fn files_tab_uses_the_selected_file_name_and_icon() {
        let files = RightPanelSurface::Files;
        assert_eq!(right_panel_tab_label(&files, None), "Files");
        assert_eq!(
            right_panel_tab_label(&files, Some("packages/desktop/bun.lock")),
            "bun.lock"
        );
        assert_eq!(
            right_panel_tab_icon(&files, Some("packages/desktop/bun.lock")),
            "icons/file-types/bun.svg"
        );

        let file = RightPanelSurface::File("src/main.rs".into());
        assert_eq!(right_panel_tab_label(&file, None), "main.rs");
        assert_eq!(
            right_panel_tab_icon(&file, None),
            "icons/file-types/rust.svg"
        );
    }

    #[test]
    fn right_panel_tab_titles_stay_on_one_line() {
        let source = include_str!("right_panel.rs");
        let header = source
            .split_once("\n    fn render_right_panel_header(")
            .expect("right panel header renderer")
            .1
            .split_once("\n    fn render_right_panel_chooser(")
            .expect("right panel header renderer end")
            .0;

        assert!(header.contains(".truncate()"));
        assert!(!header.contains(".line_clamp(1)"));

        let background = RightPanelSurface::BackgroundWork {
            key: BackgroundWorkKey::new(BackgroundWorkKind::Process, "process-1"),
            title: "node -e '\n  const value = 1'".into(),
        };
        assert_eq!(
            right_panel_tab_label(&background, None),
            "node -e ' const value = 1'"
        );
    }

    #[test]
    fn only_reuses_single_instance_surface_tabs() {
        let browser = RightPanelSurface::new_browser();
        let terminal = RightPanelSurface::new_terminal();
        let background = RightPanelSurface::BackgroundWork {
            key: BackgroundWorkKey::new(BackgroundWorkKind::Process, "process-1"),
            title: "Process one".into(),
        };
        let surfaces = vec![
            browser,
            terminal,
            background,
            RightPanelSurface::Files,
            RightPanelSurface::Agents,
            RightPanelSurface::Git,
        ];

        assert_eq!(
            reusable_surface_index(&surfaces, &RightPanelSurface::new_browser()),
            None
        );
        assert_eq!(
            reusable_surface_index(&surfaces, &RightPanelSurface::new_terminal()),
            None
        );
        assert_eq!(
            reusable_surface_index(
                &surfaces,
                &RightPanelSurface::BackgroundWork {
                    key: BackgroundWorkKey::new(BackgroundWorkKind::Process, "process-1"),
                    title: "Renamed process".into(),
                },
            ),
            Some(2)
        );
        assert_eq!(
            reusable_surface_index(&surfaces, &RightPanelSurface::Files),
            Some(3)
        );
        assert_eq!(
            reusable_surface_index(&surfaces, &RightPanelSurface::Agents),
            Some(4),
            "the Agents tab is single-instance: reopening reuses it"
        );
        assert_eq!(
            reusable_surface_index(&surfaces, &RightPanelSurface::Git),
            Some(5),
            "the Git tab is single-instance: reopening reuses it"
        );
    }

    #[test]
    fn right_panel_state_isolated_by_session() {
        let session_with_terminal = Uuid::new_v4();
        let other_session = Uuid::new_v4();
        let terminal_id = Uuid::new_v4();
        let mut states = HashMap::new();
        let mut terminal_state = RightPanelSessionState::empty(true);
        terminal_state.surfaces = vec![RightPanelSurface::Terminal(terminal_id)];
        terminal_state.active_surface = Some(0);
        terminal_state.file_tree_width = 248.0;
        states.insert(session_with_terminal, terminal_state);

        let other_state = RightPanelSessionState::take_or_closed(&mut states, other_session);
        assert!(!other_state.visible);
        assert!(other_state.surfaces.is_empty());
        assert_eq!(other_state.active_surface, None);
        assert_eq!(other_state.file_tree_width, DEFAULT_FILE_TREE_WIDTH);

        let restored = RightPanelSessionState::take_or_closed(&mut states, session_with_terminal);
        assert!(restored.visible);
        assert_eq!(
            restored.surfaces,
            vec![RightPanelSurface::Terminal(terminal_id)]
        );
        assert_eq!(restored.active_surface, Some(0));
        assert_eq!(restored.file_tree_width, 248.0);
    }

    // The fade visibility and inset-clamp math live in `ui::scroll_fade`
    // and are covered by its own tests; this module only consumes them.
}

impl Tide {
    pub(super) fn open_transcript_link(&mut self, target: &str, cx: &mut Context<Self>) -> bool {
        match transcript_link_route(target, self.selected_workspace_path()) {
            TranscriptLinkRoute::ProjectFile(relative_path) => {
                self.open_right_panel_surface(RightPanelSurface::Files, cx);
                self.open_right_panel_file(relative_path, cx);
            }
            TranscriptLinkRoute::Finder(path) => {
                if self.daemon.is_remote() {
                    self.show_toast(tr!("errors.remote_host_path"));
                    cx.notify();
                } else {
                    crate::platform::reveal_in_file_manager(&path, cx);
                }
            }
            TranscriptLinkRoute::External => return false,
        }
        true
    }

    /// Open a path a tool reported, from an activity in the transcript.
    ///
    /// Providers name a changed file however they like — absolute, or relative
    /// to the session's workspace — so resolve it before routing. Inside the
    /// workspace it opens in the file viewer; anywhere else it goes to the file
    /// manager, the same split a file link in the transcript takes.
    pub(super) fn open_activity_file(&mut self, path: &str, cx: &mut Context<Self>) {
        let path = Path::new(path.trim());
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else if let Some(workspace) = self.selected_workspace_path() {
            workspace.join(path)
        } else {
            return;
        };
        self.open_transcript_link(&resolved.to_string_lossy(), cx);
    }

    /// Open the working-tree Review diff focused on a path a tool reported —
    /// the v2 tool card's view-diff hover action.
    ///
    /// There is no per-file diff source (sources are turn- or git-scoped), so
    /// the route is the working-tree surface plus a focus seam: a snapshot
    /// already on screen that carries the file jumps straight to it; anything
    /// else parks the workspace-relative path in
    /// `right_panel_diff_pending_focus`, opens the Uncommitted diff (which
    /// always refreshes), and lets the refresh completion select — and scroll
    /// to — the file once its patch lands.
    pub(super) fn open_activity_diff(&mut self, path: &str, cx: &mut Context<Self>) {
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

    pub(super) fn store_selected_right_panel_state(&mut self) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let state = self.take_active_right_panel_state();
        self.right_panel_session_states.insert(session_id, state);
    }

    pub(super) fn restore_right_panel_state(&mut self, session_id: Uuid, cx: &mut Context<Self>) {
        let state = RightPanelSessionState::take_or_closed(
            &mut self.right_panel_session_states,
            session_id,
        );
        self.replace_active_right_panel_state(state);
        // A read in flight when this session was switched away from had its
        // result dropped, and the flag it left behind would stop the editor
        // ever asking again. Clear it and read afresh, which also picks up
        // edits made while another session was on screen.
        for editor in self.right_panel_file_editors.values_mut() {
            editor.reading = false;
        }
        // The find bar pointed into the editors that were just swapped out;
        // its match list means nothing here, and restored editors may carry
        // washes stored mid-search.
        self.reset_file_search_for_session(cx);
        self.reload_clean_right_panel_file_editors(cx);
        self.state.right_panel_visible = self.right_panel_visible;
        if self.active_right_panel_surface() == Some(&RightPanelSurface::Git) {
            if self.git_settings.snapshot.is_none() {
                self.git_load_snapshot();
            }
            self.refresh_git_panel(cx);
            self.start_git_panel_timer(cx);
        }
        if matches!(
            self.active_right_panel_surface(),
            Some(RightPanelSurface::Files | RightPanelSurface::File(_))
        ) {
            self.refresh_right_panel_working_tree(cx);
        }
        self.ensure_right_panel_terminals(cx);
        self.retain_right_panel_browsers();
        if self.right_panel_visible {
            self.request_active_terminal_focus();
            self.request_active_browser_focus();
        }
    }

    pub(super) fn remove_right_panel_session_state(&mut self, session_id: Uuid) {
        let state = if self.state.selected_session == Some(session_id) {
            let state = self.take_active_right_panel_state();
            self.replace_active_right_panel_state(RightPanelSessionState::empty(false));
            Some(state)
        } else {
            self.right_panel_session_states.remove(&session_id)
        };
        if let Some(state) = state {
            for surface in &state.surfaces {
                if let Some(terminal_id) = surface.terminal_id() {
                    self.right_panel_terminals.remove(&terminal_id);
                }
                if let Some(browser_id) = surface.browser_id() {
                    self.right_panel_browsers.remove(&browser_id);
                }
            }
        }
    }

    fn take_active_right_panel_state(&mut self) -> RightPanelSessionState {
        RightPanelSessionState {
            visible: self.right_panel_visible,
            surfaces: std::mem::take(&mut self.right_panel_surfaces),
            active_surface: self.right_panel_active_surface.take(),
            tabs_scroll_handle: std::mem::replace(
                &mut self.right_panel_tabs_scroll_handle,
                ScrollHandle::new(),
            ),
            pending_tab_reveal: self.right_panel_pending_tab_reveal.take(),
            expanded_paths: std::mem::take(&mut self.right_panel_expanded_paths),
            files_selected_path: self.right_panel_files_selected_path.take(),
            file_tree_width: self.right_panel_file_tree_width,
            file_editors: std::mem::take(&mut self.right_panel_file_editors),
        }
    }

    fn replace_active_right_panel_state(&mut self, state: RightPanelSessionState) {
        self.right_panel_visible = state.visible;
        self.right_panel_surfaces = state.surfaces;
        self.right_panel_active_surface = state.active_surface;
        self.right_panel_tabs_scroll_handle = state.tabs_scroll_handle;
        self.right_panel_pending_tab_reveal = state.pending_tab_reveal;
        self.right_panel_expanded_paths = state.expanded_paths;
        self.right_panel_files_selected_path = state.files_selected_path;
        self.right_panel_file_tree_width = state.file_tree_width;
        self.right_panel_file_editors = state.file_editors;
        // The review/diff sub-views are push-refreshed, not session-restored;
        // drop any list state so the next open measures afresh.
        self.git_panel_diff_selection.clear();
        self.git_panel_diff_list_state.reset(0);
    }

    fn reveal_right_panel_tab(&mut self, index: usize) {
        self.right_panel_pending_tab_reveal = Some(index);
        self.right_panel_tabs_scroll_handle.scroll_to_item(index);
    }

    pub(super) fn active_right_panel_surface(&self) -> Option<&RightPanelSurface> {
        self.right_panel_active_surface
            .and_then(|index| self.right_panel_surfaces.get(index))
    }

    pub(super) fn request_active_terminal_focus(&mut self) {
        self.right_panel_pending_terminal_focus = self
            .active_right_panel_surface()
            .and_then(RightPanelSurface::terminal_id);
    }

    pub(super) fn request_active_browser_focus(&mut self) {
        self.right_panel_pending_browser_focus = self
            .active_right_panel_surface()
            .and_then(RightPanelSurface::browser_id);
    }

    /// The file the active editor surface is showing, whether via a File tab
    /// or the Files browser's selection — regardless of whether the panel is
    /// currently visible, which is a per-caller decision: save works on a
    /// hidden panel, find does not.
    pub(super) fn visible_right_panel_file_path(&self) -> Option<String> {
        match self.active_right_panel_surface() {
            Some(RightPanelSurface::Files) => self.right_panel_files_selected_path.clone(),
            Some(RightPanelSurface::File(path)) => Some(path.clone()),
            _ => None,
        }
    }

    fn right_panel_file_is_dirty(&self, relative_path: &str) -> bool {
        self.right_panel_file_editors
            .get(relative_path)
            .is_some_and(|editor| editor.dirty)
    }

    fn right_panel_surface_is_dirty(&self, surface: &RightPanelSurface) -> bool {
        match surface {
            RightPanelSurface::Files => self
                .right_panel_files_selected_path
                .as_deref()
                .is_some_and(|path| self.right_panel_file_is_dirty(path)),
            RightPanelSurface::File(path) => self.right_panel_file_is_dirty(path),
            _ => false,
        }
    }

    fn ensure_initial_right_panel_file_editor_width(&mut self) {
        if self.right_panel_file_editors.is_empty() {
            self.right_panel_width = widened_panel_width_for_file_editor(
                self.right_panel_width,
                self.right_panel_file_tree_width,
            );
        }
    }

    pub(super) fn open_right_panel_surface(
        &mut self,
        surface: RightPanelSurface,
        cx: &mut Context<Self>,
    ) {
        let reusable_index = reusable_surface_index(&self.right_panel_surfaces, &surface);
        if matches!(&surface, RightPanelSurface::File(_)) {
            self.ensure_initial_right_panel_file_editor_width();
        }
        if surface == RightPanelSurface::Git {
            if reusable_index.is_none() {
                self.right_panel_width = widened_panel_width_for_review(self.right_panel_width);
            }
            // The identity bar's picker reads profiles from the settings
            // snapshot; fetch it once when the surface first opens.
            if self.git_settings.snapshot.is_none() {
                self.git_load_snapshot();
            }
            self.refresh_git_panel(cx);
            self.start_git_panel_timer(cx);
        }
        if matches!(
            surface,
            RightPanelSurface::Files | RightPanelSurface::File(_)
        ) {
            self.refresh_right_panel_working_tree(cx);
        }
        if let Some(terminal_id) = surface.terminal_id() {
            self.ensure_right_panel_terminal(terminal_id, cx);
        }
        // Browser views are created on the surface's first render, which has
        // the `Window` their webview must attach to.
        let index = match reusable_index {
            Some(index) => index,
            None => {
                self.right_panel_surfaces.push(surface);
                self.right_panel_surfaces.len() - 1
            }
        };
        self.right_panel_active_surface = Some(index);
        self.reveal_right_panel_tab(index);
        self.request_active_terminal_focus();
        self.request_active_browser_focus();
        self.set_right_panel_visible(true, cx);
        cx.notify();
    }

    /// Render a mermaid diagram in a fresh Browser tab. The source is
    /// embedded — escaped — into a dark-mode page that loads mermaid.js and
    /// renders on load; the whole document travels as a `data:` URL, so
    /// nothing but the CDN script ever touches the network. The browser view
    /// itself only exists once the tab renders, so the URL waits in
    /// [`Self::right_panel_pending_browser_urls`] until then.
    pub(super) fn open_mermaid_diagram(&mut self, source: &str, cx: &mut Context<Self>) {
        let browser_id = Uuid::new_v4();
        self.right_panel_pending_browser_urls.insert(
            browser_id,
            crate::browser::mermaid_data_url(source, Theme::current(cx).is_dark),
        );
        self.open_right_panel_surface(RightPanelSurface::Browser(browser_id), cx);
    }

    pub(super) fn open_turn_diff(&mut self, turn_id: Uuid, cx: &mut Context<Self>) {
        let Some(source) = self.selected_session().and_then(|session| {
            session
                .turns
                .iter()
                .find(|turn| turn.id == turn_id)
                .map(|turn| ReviewDiffSource::LastTurn {
                    session_id: session.id,
                    turn_id: turn.id,
                    turn_count: turn.turn_count,
                })
        }) else {
            return;
        };
        self.open_last_turn_review(source, cx);
    }

    fn open_right_panel_file(&mut self, relative_path: String, cx: &mut Context<Self>) {
        self.ensure_initial_right_panel_file_editor_width();
        let Some(active) = self.right_panel_active_surface else {
            self.open_right_panel_surface(RightPanelSurface::File(relative_path), cx);
            return;
        };
        match self.right_panel_surfaces.get(active).cloned() {
            Some(RightPanelSurface::Files) => {
                let dirty_file_would_be_replaced = self
                    .right_panel_files_selected_path
                    .as_deref()
                    .is_some_and(|current_path| {
                        current_path != relative_path
                            && self.right_panel_file_is_dirty(current_path)
                    });
                if dirty_file_would_be_replaced {
                    self.open_right_panel_surface(RightPanelSurface::File(relative_path), cx);
                    return;
                }

                self.right_panel_files_selected_path = Some(relative_path);
                self.set_right_panel_visible(true, cx);
                cx.notify();
            }
            Some(RightPanelSurface::File(current_path)) => {
                if current_path == relative_path {
                    return;
                }
                if self.right_panel_file_is_dirty(&current_path) {
                    self.open_right_panel_surface(RightPanelSurface::File(relative_path), cx);
                    return;
                }

                let requested = RightPanelSurface::File(relative_path);
                if let Some(existing) =
                    reusable_surface_index(&self.right_panel_surfaces, &requested)
                {
                    self.right_panel_surfaces.remove(active);
                    let existing = if existing > active {
                        existing - 1
                    } else {
                        existing
                    };
                    self.right_panel_active_surface = Some(existing);
                    self.reveal_right_panel_tab(existing);
                } else {
                    self.right_panel_surfaces[active] = requested;
                    self.reveal_right_panel_tab(active);
                }
                self.set_right_panel_visible(true, cx);
                cx.notify();
            }
            _ => self.open_right_panel_surface(RightPanelSurface::File(relative_path), cx),
        }
    }

    fn close_right_panel_surface(&mut self, index: usize, cx: &mut Context<Self>) {
        if index >= self.right_panel_surfaces.len() {
            return;
        }
        if let Some(terminal_id) = self.right_panel_surfaces[index].terminal_id() {
            self.right_panel_terminals.remove(&terminal_id);
        }
        if let Some(browser_id) = self.right_panel_surfaces[index].browser_id() {
            self.right_panel_browsers.remove(&browser_id);
        }
        self.right_panel_surfaces.remove(index);
        self.right_panel_active_surface = if self.right_panel_surfaces.is_empty() {
            None
        } else {
            Some(match self.right_panel_active_surface {
                Some(active) if active > index => active - 1,
                Some(active) if active == index => index.saturating_sub(1),
                Some(active) => active.min(self.right_panel_surfaces.len() - 1),
                None => 0,
            })
        };
        if let Some(active) = self.right_panel_active_surface {
            self.reveal_right_panel_tab(active);
            self.request_active_terminal_focus();
            self.request_active_browser_focus();
        } else {
            self.right_panel_pending_tab_reveal = None;
            self.right_panel_pending_terminal_focus = None;
            self.right_panel_pending_browser_focus = None;
            self.set_right_panel_visible(false, cx);
        }
        cx.notify();
    }

    pub(super) fn close_window_or_right_panel_tab_action(
        &mut self,
        _: &CloseWindow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(active) = self.right_panel_active_surface {
            self.close_right_panel_surface(active, cx);
            if self.right_panel_surfaces.is_empty() {
                let focus_handle = self.composer_focus(cx);
                window.focus(&focus_handle, cx);
            }
        } else {
            crate::platform::hide_window(window);
        }
    }

    pub(super) fn render_right_panel_toggle(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = Theme::current(cx);
        div()
            .id("toggle-right-panel")
            .w(px(26.0))
            .h(px(26.0))
            .flex_none()
            .rounded(px(6.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .hover(|element| element.bg(theme.overlay))
            .active(|element| element.bg(theme.overlay_strong))
            .child(icon("icons/panel-right.svg", 14.0, theme.text_tertiary))
            .tooltip(|window, cx| Tooltip::new(tr!("right_panel.toggle")).build(window, cx))
            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                cx.stop_propagation();
            })
            .on_click(cx.listener(|this, _, _, cx| {
                cx.stop_propagation();
                this.set_right_panel_visible(!this.right_panel_visible, cx);
            }))
    }

    pub(super) fn render_right_panel(
        &mut self,
        width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let active_terminal_id = self
            .active_right_panel_surface()
            .and_then(RightPanelSurface::terminal_id);
        if self.right_panel_pending_terminal_focus == active_terminal_id
            && let Some(terminal_id) = active_terminal_id
            && let Some(terminal) = self.right_panel_terminals.get(&terminal_id)
        {
            let focus_handle = terminal.read(cx).focus_handle(cx);
            window.focus(&focus_handle, cx);
            self.right_panel_pending_terminal_focus = None;
        }
        let body = match self.active_right_panel_surface().cloned() {
            None => self.render_right_panel_chooser(cx).into_any_element(),
            Some(RightPanelSurface::BackgroundWork { key, .. }) => self
                .render_background_work_surface(&key, cx)
                .into_any_element(),
            Some(RightPanelSurface::Agents) => self.render_right_panel_agents(cx),
            Some(RightPanelSurface::Files) => self
                .render_right_panel_files(width, window, cx)
                .into_any_element(),
            Some(RightPanelSurface::Git) => self
                .render_right_panel_git(width, window, cx)
                .into_any_element(),
            Some(RightPanelSurface::Terminal(terminal_id)) => self
                .right_panel_terminals
                .get(&terminal_id)
                .cloned()
                .inspect(|terminal| {
                    terminal.update(cx, |terminal, _| terminal.set_panel_width(width));
                })
                .map(IntoElement::into_any_element)
                .unwrap_or_else(|| {
                    self.render_right_panel_empty_message(
                        tr!("right_panel.terminal_unavailable"),
                        tr!("right_panel.terminal_unavailable_description"),
                        cx,
                    )
                    .into_any_element()
                }),
            Some(RightPanelSurface::File(path)) => self
                .render_right_panel_file(path, width, window, cx)
                .into_any_element(),
            Some(RightPanelSurface::Browser(browser_id)) => {
                let browser = self.ensure_right_panel_browser(browser_id, window, cx);
                if self
                    .right_panel_pending_browser_focus
                    .take_if(|pending| *pending == browser_id)
                    .is_some()
                {
                    browser.update(cx, |view, cx| view.focus_default(window, cx));
                }
                browser.into_any_element()
            }
        };

        div()
            .id("right-panel")
            .w(px(width))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .min_w_0()
            .border_l_1()
            .border_color(theme.border_strong)
            .bg(theme.surface)
            .relative()
            .child(self.render_right_panel_header(window, cx))
            .child(body)
            .child(self.render_panel_resize_handle(
                "right-panel-resize-handle",
                PanelResizeTarget::RightPanel,
                cx,
            ))
    }

    fn ensure_right_panel_browser(
        &mut self,
        browser_id: Uuid,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<crate::browser::BrowserView> {
        let browser = if let Some(browser) = self.right_panel_browsers.get(&browser_id) {
            browser.clone()
        } else {
            let browser = cx.new(|cx| crate::browser::BrowserView::new(window, cx));
            // Tab titles and toolbar state live on the browser entity; the
            // panel chrome re-renders when they move.
            cx.observe(&browser, |_, _, cx| cx.notify()).detach();
            self.right_panel_browsers
                .insert(browser_id, browser.clone());
            browser
        };
        self.navigate_pending_browser_url(browser_id, &browser, cx);
        browser
    }

    /// Flush a URL parked for this tab — a mermaid diagram's Preview — now
    /// that the view it navigates exists. Called from the surface's renderer
    /// because that is the only place the browser entity is created.
    fn navigate_pending_browser_url(
        &mut self,
        browser_id: Uuid,
        browser: &Entity<crate::browser::BrowserView>,
        cx: &mut Context<Self>,
    ) {
        if let Some(url) = self.right_panel_pending_browser_urls.remove(&browser_id) {
            browser.update(cx, |view, cx| view.navigate_to_url(url, cx));
        }
    }

    /// Drop browser views whose tab no longer exists in any session.
    pub(super) fn retain_right_panel_browsers(&mut self) {
        let retained_browser_ids = self
            .right_panel_surfaces
            .iter()
            .filter_map(RightPanelSurface::browser_id)
            .chain(self.right_panel_session_states.values().flat_map(|state| {
                state
                    .surfaces
                    .iter()
                    .filter_map(RightPanelSurface::browser_id)
            }))
            .collect::<HashSet<_>>();
        self.right_panel_browsers
            .retain(|browser_id, _| retained_browser_ids.contains(browser_id));
        // Pending navigations for tabs that no longer exist have nothing left
        // to wait for.
        self.right_panel_pending_browser_urls
            .retain(|browser_id, _| retained_browser_ids.contains(browser_id));
    }

    /// Whether any GPUI overlay that could float above the right panel is
    /// open. The native webview always draws over GPUI, so while this holds
    /// the live page swaps for a frozen snapshot.
    fn any_overlay_open(&self, cx: &App) -> bool {
        self.menus.borrow().values().any(ContextMenuHandle::is_open)
            || self.command_palette.is_open()
            || self.task_switcher.is_open()
            || self.commit_dialog.is_some()
            || self.image_preview.is_some()
            || self.composer.read(cx).context_menu_open(cx)
            || self
                .right_panel_browsers
                .values()
                .any(|browser| browser.read(cx).overlay_open(cx))
    }

    /// Once per frame, from the very top of the app's render: push down to
    /// every browser whether its native view belongs on screen. This is the
    /// single authority — tab switches, panel toggles, session switches, the
    /// settings page and overlay menus all funnel through here, so a webview
    /// can never linger over unrelated UI. The inline mermaid surfaces ride
    /// the same authority.
    pub(super) fn sync_browser_webviews(&mut self, cx: &mut Context<Self>) {
        if !self.right_panel_browsers.is_empty() {
            // With the scene overlay compositing GPUI's deferred draws above
            // native views, open menus never occlude the webview — the snapshot
            // swap is purely the fallback for a window where enabling it failed.
            let overlay_open = !self.scene_overlay_enabled && self.any_overlay_open(cx);
            // A webview composites above the GPUI scene, so the panel's clip does
            // not apply to it: shown mid-slide it would hang over the transcript
            // at full width. Keep it down until the panel has finished moving.
            let active_browser = if self.settings_page.is_none()
                && self.right_panel_visible
                && self.right_panel_slide.is_none()
            {
                self.active_right_panel_surface()
                    .and_then(RightPanelSurface::browser_id)
            } else {
                None
            };
            for (browser_id, browser) in &self.right_panel_browsers {
                let surface_visible = active_browser == Some(*browser_id);
                browser.update(cx, |view, cx| {
                    view.sync_native_state(surface_visible, overlay_open, cx);
                });
            }
        }
    }

    fn ensure_right_panel_terminal(&mut self, terminal_id: Uuid, cx: &mut Context<Self>) {
        if self.daemon.is_remote() {
            // A desktop PTY would interpret the daemon's cwd on the wrong
            // machine. Keep the surface unavailable until the protocol grows
            // a daemon-owned streaming terminal.
            self.right_panel_terminals.remove(&terminal_id);
            return;
        }
        let Some(working_directory) = self
            .selected_workspace_path()
            .map(std::path::Path::to_path_buf)
        else {
            self.right_panel_terminals.remove(&terminal_id);
            return;
        };
        let matches_project = self
            .right_panel_terminals
            .get(&terminal_id)
            .is_some_and(|terminal| terminal.read(cx).working_directory() == working_directory);
        if !matches_project {
            self.right_panel_terminals.insert(
                terminal_id,
                cx.new(|cx| TerminalView::new(working_directory.clone(), cx)),
            );
        }
    }

    pub(super) fn ensure_right_panel_terminals(&mut self, cx: &mut Context<Self>) {
        let active_terminal_ids = self
            .right_panel_surfaces
            .iter()
            .filter_map(RightPanelSurface::terminal_id)
            .collect::<Vec<_>>();
        let retained_terminal_ids = active_terminal_ids
            .iter()
            .copied()
            .chain(self.right_panel_session_states.values().flat_map(|state| {
                state
                    .surfaces
                    .iter()
                    .filter_map(RightPanelSurface::terminal_id)
            }))
            .collect::<HashSet<_>>();
        self.right_panel_terminals
            .retain(|terminal_id, _| retained_terminal_ids.contains(terminal_id));
        for terminal_id in active_terminal_ids {
            self.ensure_right_panel_terminal(terminal_id, cx);
        }
    }

    fn render_right_panel_header(&self, window: &Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let active_surface = self.right_panel_active_surface;
        let mut tabs = div()
            .id("right-panel-tabs")
            .h_full()
            .min_w_0()
            .flex_1()
            .flex()
            .items_center()
            .gap(px(4.0))
            .overflow_x_scroll()
            .track_scroll(&self.right_panel_tabs_scroll_handle);
        for (index, surface) in self.right_panel_surfaces.iter().cloned().enumerate() {
            let active = active_surface == Some(index);
            let dirty = self.right_panel_surface_is_dirty(&surface);
            let label = SharedString::from(match &surface {
                // Browser tabs read like browser tabs: the page title once
                // known, the address until then.
                RightPanelSurface::Browser(browser_id) => self
                    .right_panel_browsers
                    .get(browser_id)
                    .and_then(|browser| browser.read(cx).tab_label())
                    .unwrap_or_else(|| surface.label()),
                _ => {
                    right_panel_tab_label(&surface, self.right_panel_files_selected_path.as_deref())
                }
            });
            let icon_path =
                right_panel_tab_icon(&surface, self.right_panel_files_selected_path.as_deref());
            let uses_file_icon = matches!(&surface, RightPanelSurface::File(_))
                || matches!(&surface, RightPanelSurface::Files)
                    && self.right_panel_files_selected_path.is_some();
            let activate_weak = cx.entity().downgrade();
            let close_weak = cx.entity().downgrade();
            tabs = tabs.child(
                div()
                    .id(SharedString::from(format!("right-panel-tab-{index}")))
                    .h(px(28.0))
                    .min_w(px(100.0))
                    .max_w(px(176.0))
                    .px(px(8.0))
                    .rounded(px(6.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .cursor_default()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .when(active, |element| element.bg(theme.overlay_strong))
                    .when(!active, |element| {
                        element.hover(|element| element.bg(theme.overlay))
                    })
                    .child(if uses_file_icon {
                        file_icon(icon_path, 13.0).into_any_element()
                    } else {
                        icon(icon_path, 13.0, theme.text_secondary).into_any_element()
                    })
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_size(sp(12.5))
                            .text_color(if active {
                                theme.text
                            } else {
                                theme.text_secondary
                            })
                            .child(label),
                    )
                    .when(dirty, |element| {
                        element.child(
                            div()
                                .id(SharedString::from(format!("right-panel-tab-dirty-{index}")))
                                .size(px(7.0))
                                .flex_none()
                                .rounded_full()
                                .bg(theme.warning)
                                .tooltip(|window, cx| {
                                    Tooltip::new(tr!(
                                        "files.unsaved_changes",
                                        shortcut =
                                            crate::platform::primary_shortcut("⌘S", "Ctrl+S")
                                    ))
                                    .build(window, cx)
                                }),
                        )
                    })
                    .child(
                        div()
                            .id(SharedString::from(format!("close-right-panel-tab-{index}")))
                            .w(px(16.0))
                            .h(px(16.0))
                            .rounded(px(4.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .hover(|element| element.bg(theme.overlay_strong))
                            .child(icon("icons/x.svg", 10.0, theme.text_tertiary))
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                let _ = close_weak.update(cx, |this, cx| {
                                    this.close_right_panel_surface(index, cx);
                                });
                            }),
                    )
                    .on_click(move |_, _, cx| {
                        let _ = activate_weak.update(cx, |this, cx| {
                            this.right_panel_active_surface = Some(index);
                            this.reveal_right_panel_tab(index);
                            this.request_active_terminal_focus();
                            cx.notify();
                        });
                    }),
            );
        }
        tabs = tabs.child(div().w(px(TAB_SCROLL_FADE_WIDTH)).h(px(1.0)).flex_none());

        let mut header = div()
            .id("right-panel-header")
            .h(px(48.0))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(6.0))
            .pl(px(10.0))
            .pr(px(14.0))
            .child(
                div()
                    .relative()
                    .h_full()
                    .min_w_0()
                    .flex_1()
                    .overflow_hidden()
                    .child(tabs)
                    .when_some(self.right_panel_pending_tab_reveal, |element, tab_index| {
                        element.child(tab_scroll_reveal_guard(
                            self.right_panel_tabs_scroll_handle.clone(),
                            tab_index,
                            cx.entity().downgrade(),
                        ))
                    })
                    .child(crate::ui::scroll_fade::overlay(
                        self.right_panel_tabs_scroll_handle.clone(),
                        gpui::Axis::Horizontal,
                        crate::ui::scroll_fade::ScrollFadeSide::Start,
                        TAB_SCROLL_FADE_WIDTH,
                        theme.surface,
                    ))
                    .child(crate::ui::scroll_fade::overlay(
                        self.right_panel_tabs_scroll_handle.clone(),
                        gpui::Axis::Horizontal,
                        crate::ui::scroll_fade::ScrollFadeSide::End,
                        TAB_SCROLL_FADE_WIDTH,
                        theme.surface,
                    )),
            );

        if !self.right_panel_surfaces.is_empty() {
            let weak = cx.entity().downgrade();
            let existing_surfaces = self.right_panel_surfaces.clone();
            let options = [
                RightPanelSurface::new_browser(),
                RightPanelSurface::new_terminal(),
                RightPanelSurface::Files,
                RightPanelSurface::Agents,
                RightPanelSurface::Git,
            ];
            let handle = self.menu_handle("add-right-panel-surface", cx);
            header = header.child(
                div()
                    .flex_none()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .child(dropdown_menu(
                        icon_button("add-right-panel-surface", "icons/plus.svg", theme),
                        "add-right-panel-surface-menu",
                        &handle,
                        MenuAlign::BelowRight,
                        move |_| {
                            options
                                .clone()
                                .into_iter()
                                .map(|surface| {
                                    let weak = weak.clone();
                                    let open_surface = surface.clone();
                                    let already_open =
                                        reusable_surface_index(&existing_surfaces, &surface)
                                            .is_some();
                                    MenuItem::new(surface.label(), move |_, cx| {
                                        let _ = weak.update(cx, |this, cx| {
                                            this.open_right_panel_surface(open_surface.clone(), cx);
                                        });
                                    })
                                    .icon(surface.icon_path())
                                    .selected(already_open)
                                })
                                .collect()
                        },
                    )),
            );
        }

        self.window_drag_region(
            header.child(self.render_right_panel_toggle(cx)).children(
                self.render_client_window_controls(
                    super::window_chrome::WindowControlSide::Right,
                    window,
                    cx,
                ),
            ),
            cx,
        )
    }

    fn render_right_panel_chooser(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = Theme::current(cx);
        div()
            .id("right-panel-chooser")
            .flex_1()
            .min_h_0()
            .flex()
            .items_center()
            .justify_center()
            .px(px(20.0))
            .pb(px(32.0))
            .child(
                div()
                    .w_full()
                    .max_w(px(420.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .child(
                        div()
                            .text_size(sp(13.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(tr!("right_panel.open_surface")),
                    )
                    .child(
                        div()
                            .mt(px(5.0))
                            .text_size(sp(12.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("right_panel.choose_surface")),
                    )
                    .child(
                        div()
                            .mt(px(18.0))
                            .w_full()
                            .flex()
                            .gap(px(8.0))
                            .child(self.render_right_panel_card(
                                RightPanelSurface::new_browser(),
                                tr!("right_panel.browser_description"),
                                None,
                                cx,
                            ))
                            .child(self.render_right_panel_card(
                                RightPanelSurface::new_terminal(),
                                tr!("right_panel.terminal_description"),
                                None,
                                cx,
                            )),
                    )
                    .child(
                        div()
                            .mt(px(8.0))
                            .w_full()
                            .flex()
                            .gap(px(8.0))
                            .child(self.render_right_panel_card(
                                RightPanelSurface::Files,
                                tr!("right_panel.files_description"),
                                None,
                                cx,
                            ))
                            .child(self.render_right_panel_card(
                                RightPanelSurface::Agents,
                                tr!("right_panel.agents_description"),
                                Some(self.selected_session_agents_count()),
                                cx,
                            ))
                            .child(self.render_right_panel_card(
                                RightPanelSurface::Git,
                                tr!("right_panel.git_description"),
                                None,
                                cx,
                            )),
                    ),
            )
    }

    fn render_right_panel_card(
        &self,
        surface: RightPanelSurface,
        description: String,
        badge: Option<usize>,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let icon_path = surface.icon_path();
        let label = surface.label();
        div()
            .id(SharedString::from(format!(
                "right-panel-card-{}",
                label.to_lowercase()
            )))
            .h(px(112.0))
            .flex_1()
            .min_w_0()
            .p(px(14.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(theme.border_strong)
            .bg(theme.composer)
            .flex()
            .flex_col()
            .items_start()
            .cursor_default()
            .hover(|element| element.bg(theme.raised).border_color(theme.text_ghost))
            .active(|element| element.bg(theme.overlay_strong))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(icon(icon_path, 18.0, theme.text_secondary))
                    .when_some(badge.filter(|count| *count > 0), |row, count| {
                        row.child(
                            div()
                                .id(SharedString::from(format!(
                                    "right-panel-card-badge-{}",
                                    label.to_lowercase()
                                )))
                                .h(px(16.0))
                                .px(px(6.0))
                                .rounded_full()
                                .bg(theme.overlay_strong)
                                .flex()
                                .items_center()
                                .text_size(sp(10.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_secondary)
                                .child(SharedString::from(count.to_string())),
                        )
                    }),
            )
            .child(
                div()
                    .mt(px(12.0))
                    .text_size(sp(12.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(label),
            )
            .child(
                div()
                    .mt(px(4.0))
                    .text_size(sp(12.5))
                    .line_height(sp(15.0))
                    .text_color(theme.text_tertiary)
                    .whitespace_normal()
                    .line_clamp(2)
                    .text_overflow(gpui::TextOverflow::Truncate("...".into()))
                    .child(description),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.open_right_panel_surface(surface.clone(), cx);
            }))
    }

    fn render_right_panel_files(
        &mut self,
        panel_width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        if let Some(relative_path) = self.right_panel_files_selected_path.clone() {
            self.render_right_panel_file(relative_path, panel_width, window, cx)
        } else {
            self.render_right_panel_working_tree(None, cx)
        }
    }

    fn render_right_panel_working_tree(
        &self,
        selected_path: Option<&str>,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        let Some(project) = self.selected_project() else {
            return self.render_right_panel_empty_message(
                tr!("files.no_project_open"),
                tr!("files.no_project_open_description"),
                cx,
            );
        };
        let project_name = project.display_name();
        // Read only. The walk is filesystem I/O, so it happens in
        // `refresh_right_panel_working_tree`, never in a frame.
        let entries = self.right_panel_working_tree.clone();

        let mut list = div().flex().flex_col().py(px(6.0));
        for entry in entries {
            let relative_path = entry.relative_path.clone();
            let absolute_path = entry.absolute_path.clone();
            let is_dir = entry.is_dir;
            let selected = selected_path == Some(relative_path.as_str());
            let row = div()
                .id(SharedString::from(format!(
                    "right-panel-file-{relative_path}"
                )))
                .h(px(30.0))
                .mx(px(8.0))
                .pl(px(8.0 + entry.depth as f32 * 16.0))
                .pr(px(8.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .cursor_default()
                .when(selected, |element| element.bg(theme.overlay_strong))
                .hover(|element| element.bg(theme.overlay))
                .child(if is_dir {
                    icon(
                        if entry.expanded {
                            "icons/chevron-down.svg"
                        } else {
                            "icons/chevron-right.svg"
                        },
                        10.0,
                        theme.text_ghost,
                    )
                    .into_any_element()
                } else {
                    div().w(px(10.0)).h(px(10.0)).flex_none().into_any_element()
                })
                .when_some(entry.file_icon, |element, file_icon_path| {
                    element.child(file_icon(file_icon_path, 14.0))
                })
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .text_size(sp(12.5))
                        .text_color(theme.text_secondary)
                        .child(entry.name),
                );
            list = if is_dir {
                list.child(row.on_click(cx.listener(move |this, _, _, cx| {
                    if !this.right_panel_expanded_paths.remove(&absolute_path) {
                        this.right_panel_expanded_paths
                            .insert(absolute_path.clone());
                    }
                    this.refresh_right_panel_working_tree(cx);
                    cx.notify();
                })))
            } else {
                list.child(row.on_click(cx.listener(move |this, _, _, cx| {
                    this.open_right_panel_file(relative_path.clone(), cx);
                })))
            };
        }

        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(42.0))
                    .flex_none()
                    .px(px(16.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .border_b_1()
                    .border_color(theme.border)
                    .child(icon("icons/folder.svg", 13.0, theme.text_tertiary))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_size(sp(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text_secondary)
                            .child(project_name),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(
                        div()
                            .id("right-panel-files-scroll")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.right_panel_files_scroll_handle)
                            .child(list),
                    )
                    .child(scrollbar::vertical(
                        &self.right_panel_files_scroll_handle,
                        &self.right_panel_files_scrollbar,
                    )),
            )
    }

    fn render_right_panel_file(
        &mut self,
        relative_path: String,
        panel_width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        let file_tree_width = fitted_file_tree_width(panel_width, self.right_panel_file_tree_width);
        let (editor_state, writable, _) =
            self.ensure_right_panel_file_editor(&relative_path, window, cx);

        // Markdown files carry the global source/preview toggle; every other
        // language always shows source.
        let is_markdown = file_highlighter_language(&relative_path) == "markdown";
        let preview = is_markdown && self.state.markdown_preview;
        let body = if preview {
            self.render_file_markdown_preview(&relative_path, &editor_state, cx)
        } else {
            self.render_file_editor_body(
                &relative_path,
                &editor_state,
                panel_width - file_tree_width,
                writable,
                window,
                cx,
            )
        };
        let preview_toggle = is_markdown.then(|| {
            let focus = self.transcript_control_focus("file-markdown-preview-toggle", cx);
            let (icon_path, label) = if preview {
                ("icons/pencil.svg", tr!("files.edit_markdown_source"))
            } else {
                ("icons/eye.svg", tr!("files.preview_markdown"))
            };
            div()
                .id("file-markdown-preview-toggle")
                .track_focus(&focus)
                .tab_index(0)
                .size(px(26.0))
                .rounded(px(7.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .cursor_default()
                .focus_visible(|style| style.border_1().border_color(theme.accent))
                .hover(|style| style.bg(theme.overlay))
                .child(icon(icon_path, 12.0, theme.text_tertiary))
                .tooltip(move |window, cx| Tooltip::new(label.clone()).build(window, cx))
                .on_click(cx.listener(|this, _, _, cx| this.toggle_markdown_preview(cx)))
                .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        this.toggle_markdown_preview(cx);
                        cx.stop_propagation();
                    }
                }))
        });

        let editor = div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(42.0))
                    .flex_none()
                    .px(px(16.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .border_b_1()
                    .border_color(theme.border)
                    .child(file_icon(file_icon_for_path(&relative_path), 13.0))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_size(sp(12.5))
                            .text_color(theme.text_secondary)
                            .child(relative_path.clone()),
                    )
                    .children(preview_toggle),
            )
            .child(body);

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .child(editor)
            .child(
                div()
                    .w(px(file_tree_width))
                    .min_w(px(FILE_TREE_MIN_WIDTH))
                    .h_full()
                    .flex_none()
                    .flex()
                    .flex_col()
                    .relative()
                    .border_l_1()
                    .border_color(theme.border_strong)
                    .child(self.render_right_panel_working_tree(Some(&relative_path), cx))
                    .child(self.render_panel_resize_handle(
                        "right-panel-file-tree-resize-handle",
                        PanelResizeTarget::FileTree,
                        cx,
                    )),
            )
    }

    fn ensure_right_panel_file_editor(
        &mut self,
        relative_path: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Entity<TextInput>, bool, bool) {
        if let Some(editor) = self.right_panel_file_editors.get(relative_path) {
            return (editor.state.clone(), editor.writable, editor.dirty);
        }

        // Reached from `render`, so the file cannot be read here. The editor
        // starts empty and locked, and `read_right_panel_file_into_editor`
        // fills it in from the background executor a frame or two later.
        let language = file_highlighter_language(relative_path);
        let state = cx.new(|cx| {
            TextInput::new(window, cx)
                .multi_line()
                .syntax(Some(language))
                .read_only(true)
        });

        self.right_panel_file_editors.insert(
            relative_path.to_owned(),
            RightPanelFileEditor {
                state: state.clone(),
                disk_content: String::new(),
                writable: false,
                dirty: false,
                reading: false,
                read_epoch: 0,
            },
        );

        // Dirty tracking follows content edits. Observing raw notifies would
        // also fire for caret blinks and selection drags, cloning the whole
        // file's text for each one.
        let subscribed_path = relative_path.to_owned();
        cx.subscribe(
            &state,
            move |this: &mut Self, state, event: &InputEvent, cx| {
                if !matches!(event, InputEvent::Edited) {
                    return;
                }
                let value = state.read(cx).content().to_owned();
                if let Some(editor) = this
                    .right_panel_file_editors
                    .get_mut(subscribed_path.as_str())
                {
                    let dirty = editor.writable && value != editor.disk_content;
                    if editor.dirty != dirty {
                        editor.dirty = dirty;
                        cx.notify();
                    }
                }
                // Any content change — typing, a replace, a reload from disk —
                // moves the text out from under an open find's match list.
                this.refresh_file_search_for_edit(subscribed_path.as_str(), cx);
            },
        )
        .detach();

        let focused_path = relative_path.to_owned();
        cx.subscribe(&state, move |this: &mut Self, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Focus) {
                this.reload_right_panel_file_if_clean(focused_path.as_str(), cx);
            }
        })
        .detach();

        self.read_right_panel_file_into_editor(relative_path.to_owned(), cx);
        (state, false, false)
    }

    /// Reads a file into its editor off the UI thread.
    ///
    /// One `read_to_string` of an arbitrarily large file — hundreds of frames
    /// for a big one — so it never runs in a frame. The editor keeps whatever
    /// it is already showing until the read lands.
    ///
    /// The result is applied only if the same session is still selected and the
    /// editor is still the one that asked, so a read started before a project
    /// or session switch cannot write another workspace's text into the view.
    fn read_right_panel_file_into_editor(&mut self, relative_path: String, cx: &mut Context<Self>) {
        let project_path = self
            .selected_workspace_path()
            .map(std::path::Path::to_path_buf);
        let (Some(project_path), Some(session_id)) = (project_path, self.state.selected_session)
        else {
            // Nothing to read from. Say so in the editor rather than leaving it
            // looking like an empty file.
            if let Some(editor) = self.right_panel_file_editors.get_mut(&relative_path) {
                editor.reading = false;
                editor.disk_content = tr!("files.no_project_is_open");
                editor.writable = false;
                let state = editor.state.clone();
                let content = editor.disk_content.clone();
                state.update(cx, |state, cx| state.set_content(content, cx));
            }
            return;
        };
        let Some(editor) = self.right_panel_file_editors.get_mut(&relative_path) else {
            return;
        };
        // A second asker would only duplicate the read and race to apply it.
        if editor.reading {
            return;
        }
        editor.reading = true;
        editor.read_epoch += 1;
        let epoch = editor.read_epoch;
        let workspace = client::WorkspaceClient::new(self.daemon.client());

        cx.spawn(async move |tide, cx| {
            let read = cx
                .background_executor()
                .spawn({
                    let project_path = project_path.clone();
                    let relative_path = relative_path.clone();
                    async move { read_right_panel_file(&workspace, &project_path, &relative_path) }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_none_or(|path| path != project_path)
                {
                    // The editor moved into another session's stored state, or
                    // the project changed. Clear the flag so a later reload can
                    // ask again, and drop the text.
                    if let Some(editor) = tide.right_panel_file_editors.get_mut(&relative_path) {
                        editor.reading = false;
                    }
                    return;
                }
                let (content, writable) = read;
                let Some(editor) = tide.right_panel_file_editors.get_mut(&relative_path) else {
                    return;
                };
                // A save landed while the read was in flight, so this text
                // describes the file as it was before that save.
                if editor.read_epoch != epoch {
                    return;
                }
                editor.reading = false;
                // An edit landed while the read was in flight; the user's text
                // wins over the copy on disk.
                if editor.dirty {
                    return;
                }
                if editor.disk_content == content && editor.writable == writable {
                    return;
                }
                editor.disk_content = content.clone();
                editor.writable = writable;
                editor.dirty = false;
                let state = editor.state.clone();
                state.update(cx, |state, cx| {
                    state.set_read_only(!writable);
                    state.set_content(content, cx);
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The editor body: a line-number gutter beside soft-wrapped text.
    ///
    /// The gutter is *painted*, not laid out — one canvas that shapes only the
    /// numbers currently on screen, the way Zed's editor element does. A div per
    /// line would put one layout node per line of the file in every frame, which
    /// is what made large files crawl.
    ///
    /// Row heights come from the text's measured layout rather than a nominal
    /// line height, so a soft-wrapped line still gets exactly one number and the
    /// two columns cannot drift apart down a long file.
    fn render_file_editor_body(
        &mut self,
        relative_path: &str,
        editor_state: &Entity<TextInput>,
        pane_width: f32,
        writable: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        const GUTTER_PAD_RIGHT: f32 = 8.0;
        const CONTENT_PAD_TOP: f32 = 6.0;

        let text_size = self.state.code_font_size;
        let line_height = (text_size * 1.5).round();

        // An open find bar follows whichever file this body is showing; a
        // cheap comparison every frame, one recompute on the frame after the
        // visible file actually changes.
        self.sync_file_search_target(relative_path, cx);
        let find_bar = self.render_file_search_bar(pane_width, writable, window, cx);

        let theme = Theme::current(cx);
        let field = editor_state.read(cx);
        let line_count = field.content().split('\n').count().max(1);
        let heights = field.wrapped_line_heights();
        // A mono digit advances ~0.6em, so the gutter tracks the font size.
        let digit_width = (text_size * 0.6).ceil();
        let gutter_width = 20.0 + digit_width * (line_count.to_string().len() as f32);
        let content_height = if heights.is_empty() {
            px(line_height) * line_count as f32
        } else {
            heights.iter().fold(Pixels::ZERO, |total, h| total + *h)
        };

        let viewport = self.right_panel_editor_scroll_handle.clone();
        let number_color = theme.text_ghost;
        let gutter = canvas(
            |_, _, _| (),
            move |bounds: gpui::Bounds<Pixels>, _, window: &mut Window, cx: &mut App| {
                let visible = viewport.bounds();
                let mut y = bounds.origin.y;
                for number in 1..=line_count {
                    let height = heights
                        .get(number - 1)
                        .copied()
                        .unwrap_or_else(|| px(line_height));
                    // Everything below the viewport is unreachable from here on.
                    if y > visible.bottom() {
                        break;
                    }
                    if y + height >= visible.top() {
                        let text = SharedString::from(number.to_string());
                        let run = gpui::TextRun {
                            len: text.len(),
                            font: gpui::font(md::render::MONO_FAMILY),
                            color: number_color,
                            ..Default::default()
                        };
                        let line =
                            window
                                .text_system()
                                .shape_line(text, px(text_size), &[run], None);
                        let origin = point(bounds.right() - line.width, y);
                        let _ = line.paint(
                            origin,
                            px(line_height),
                            gpui::TextAlign::Left,
                            None,
                            window,
                            cx,
                        );
                    }
                    y += height;
                }
            },
        )
        .flex_none()
        .w(px(gutter_width - GUTTER_PAD_RIGHT))
        .h(content_height);

        // The find bar sits in normal flow above the scroll region — Zed's
        // buffer-search arrangement — so an open bar pushes the content and
        // its line-number gutter down instead of covering the first lines.
        div()
            .key_context("FileEditorPane")
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .bg(theme.surface)
            .font_family(md::render::MONO_FAMILY)
            .text_size(px(text_size))
            .line_height(px(line_height))
            .children(find_bar)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(
                        div()
                            .id(SharedString::from(format!("file-editor-{relative_path}")))
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.right_panel_editor_scroll_handle)
                            .child(
                                div()
                                    .w_full()
                                    .pt(px(CONTENT_PAD_TOP))
                                    .pb(px(CONTENT_PAD_TOP))
                                    .flex()
                                    .items_start()
                                    .child(gutter)
                                    .child(div().w(px(GUTTER_PAD_RIGHT)).flex_none())
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .pr(px(10.0))
                                            .child(editor_state.clone()),
                                    ),
                            ),
                    )
                    .child(scrollbar::vertical(
                        &self.right_panel_editor_scroll_handle,
                        &self.right_panel_editor_scrollbar,
                    )),
            )
    }

    /// Flips the global markdown source/preview mode and persists it, so the
    /// choice follows the user across files and sessions.
    fn toggle_markdown_preview(&mut self, cx: &mut Context<Self>) {
        self.state.markdown_preview = !self.state.markdown_preview;
        self.save();
        cx.notify();
    }

    /// The rendered-markdown alternative to the editor body, shown while the
    /// global preview toggle is on. It renders the editor's current text —
    /// unsaved edits included — with the transcript's markdown engine; the
    /// parse is cached per path, so re-rendering an unchanged document costs
    /// `Rc` clones, not a re-parse. Reads only in-memory editor state: the
    /// render path may not touch the filesystem.
    fn render_file_markdown_preview(
        &mut self,
        relative_path: &str,
        editor_state: &Entity<TextInput>,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        let palette = MarkdownPalette::from_theme(&theme);
        let mut cache = self.file_preview_markdown.borrow_mut();
        if !matches!(cache.as_ref(), Some((cached, _)) if cached == relative_path) {
            *cache = Some((relative_path.to_owned(), MarkdownView::new()));
        }
        let (_, view) = cache.as_mut().expect("entry ensured above");
        view.set_text(editor_state.read(cx).content(), false);
        let ctx = MarkdownCtx::new(
            format!("file-preview-{relative_path}"),
            &palette,
            MarkdownMetrics::document(self.state.ui_font_size, self.state.code_font_size),
            self.file_preview_selection.clone(),
        )
        .with_link_handler(self.markdown_link_handler.clone());
        let document = md::render::markdown(view, &ctx);

        let selection_input = {
            let selection = self.file_preview_selection.clone();
            canvas(
                |_, _, _| (),
                move |_, _, window, _| md::render::install_selection_input(window, &selection),
            )
            .absolute()
            .w(px(0.0))
            .h(px(0.0))
        };

        div()
            .flex_1()
            .min_h_0()
            .relative()
            .bg(theme.surface)
            .child(
                div()
                    .id(SharedString::from(format!("file-preview-{relative_path}")))
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.file_preview_scroll_handle)
                    // Painted before the document, so the frame's selection
                    // registry holds exactly this frame's text elements.
                    .child(md::render::frame_reset(self.file_preview_selection.clone()))
                    .child(
                        div()
                            .px(px(16.0))
                            .pt(px(14.0))
                            .pb(px(24.0))
                            .text_color(theme.text)
                            .children(document),
                    ),
            )
            .child(selection_input)
            .child(scrollbar::vertical(
                &self.file_preview_scroll_handle,
                &self.file_preview_scrollbar,
            ))
    }

    /// Picks up an external edit to a file the user has not modified here.
    ///
    /// Reaches the filesystem, so it queues a background read rather than
    /// blocking; the editor keeps showing its current text until that lands.
    fn reload_right_panel_file_if_clean(&mut self, relative_path: &str, cx: &mut Context<Self>) {
        if self
            .right_panel_file_editors
            .get(relative_path)
            .is_none_or(|editor| editor.dirty)
        {
            return;
        }
        self.read_right_panel_file_into_editor(relative_path.to_owned(), cx);
    }

    pub(super) fn reload_clean_right_panel_file_editors(&mut self, cx: &mut Context<Self>) {
        let paths = self
            .right_panel_file_editors
            .iter()
            .filter(|(_, editor)| !editor.dirty)
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        for path in paths {
            self.reload_right_panel_file_if_clean(&path, cx);
        }
    }

    pub(super) fn save_right_panel_file_action(
        &mut self,
        _: &SaveFile,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(relative_path) = self.visible_right_panel_file_path() else {
            return;
        };
        let Some(project_path) = self
            .selected_workspace_path()
            .map(std::path::Path::to_path_buf)
        else {
            return;
        };
        let Some(editor) = self.right_panel_file_editors.get(&relative_path) else {
            return;
        };
        if !editor.writable {
            self.show_toast(if editor.reading {
                tr!("files.could_not_save_opening", path = relative_path)
            } else {
                tr!("files.could_not_save_read_only", path = relative_path)
            });
            cx.notify();
            return;
        }

        let content = editor.state.read(cx).content().to_owned();
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let epoch = if let Some(editor) = self.right_panel_file_editors.get_mut(&relative_path) {
            editor.reading = false;
            editor.read_epoch += 1;
            editor.read_epoch
        } else {
            return;
        };
        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let project_path = project_path.clone();
                    let relative_path = relative_path.clone();
                    let content = content.clone();
                    async move {
                        match workspace.request(client::WorkspaceOperation::WriteTextFile {
                            root: project_path,
                            relative_path: PathBuf::from(relative_path),
                            content,
                        })? {
                            client::WorkspaceResult::Ack => Ok(()),
                            _ => anyhow::bail!("the daemon returned an invalid file response"),
                        }
                    }
                })
                .await;
            let _ = tide.update(cx, |tide, cx| {
                if tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_none_or(|path| path != project_path)
                {
                    return;
                }
                match result {
                    Ok(()) => {
                        if let Some(editor) = tide.right_panel_file_editors.get_mut(&relative_path)
                            && editor.read_epoch == epoch
                        {
                            let current = editor.state.read(cx).content();
                            editor.disk_content = content.clone();
                            editor.dirty = current != content;
                        }
                    }
                    Err(error) => tide.show_toast(tr!(
                        "files.could_not_save",
                        path = relative_path,
                        error = error.to_string()
                    )),
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// The shared unified-diff list: the virtualized rows, their scrollbar,
    /// and the hidden selection input, over one render-ready snapshot. Both
    /// the last-turn review and the selected-file sub-view paint through it.
    ///
    /// `escalate` selects the gap behavior: a review snapshot reveals
    /// retained context in place; a selected-file diff has no hidden rows,
    /// so a gap click widens context by refetching from the daemon.
    fn render_right_panel_unified_diff(
        &self,
        snapshot: Arc<ReviewDiffSnapshot>,
        escalate: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity().downgrade();
        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .relative()
            .flex()
            .flex_col()
            .child(md::render::frame_reset(
                self.git_panel_diff_selection.clone(),
            ))
            .child(
                list(
                    self.git_panel_diff_list_state.clone(),
                    move |index, _window, cx| {
                        entity
                            .upgrade()
                            .map(|entity| {
                                entity.update(cx, |this, cx| {
                                    this.render_right_panel_diff_line(
                                        &snapshot, index, escalate, cx,
                                    )
                                })
                            })
                            .unwrap_or_else(|| div().into_any_element())
                    },
                )
                .flex_1()
                .min_h_0(),
            )
            .child(scrollbar::vertical(
                &self.git_panel_diff_list_state,
                &self.git_panel_diff_scrollbar,
            ))
            .child(self.git_panel_diff_selection_input())
            .into_any_element()
    }

    fn render_right_panel_diff_line(
        &self,
        snapshot: &ReviewDiffSnapshot,
        index: usize,
        escalate: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(line) = snapshot.lines.get(index) else {
            return div().into_any_element();
        };
        let Some(file) = snapshot.files.get(line.file_index) else {
            return div().into_any_element();
        };
        let theme = Theme::current(cx);
        let style = DiffRowStyle::review(self.state.code_font_size);
        // Chrome rows keep their gutters flush with the code rows'.
        let gutter_width = style.gutter_width();

        match &line.kind {
            crate::review_diff::LineKind::FileHeader => div()
                .id(SharedString::from(format!("review-diff-file-{index}")))
                .w_full()
                .min_w_0()
                .h(px(36.0))
                .px(px(12.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .border_b_1()
                .border_color(theme.border)
                .bg(theme.surface)
                .child(file_icon(file_icon_for_path(&file.path), 14.0))
                .child(
                    div()
                        .id(SharedString::from(format!("review-diff-file-path-{index}")))
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_secondary)
                        .tooltip(Tooltip::text(file.path.clone()))
                        .child(file.path.clone()),
                )
                .child(
                    div()
                        .text_size(px(12.5))
                        .text_color(theme.success)
                        .child(format!("+{}", file.additions)),
                )
                .child(
                    div()
                        .text_size(px(12.5))
                        .text_color(theme.danger)
                        .child(format!("-{}", file.deletions)),
                )
                .into_any_element(),
            crate::review_diff::LineKind::Gap(gap) => {
                // A selected-file diff's gaps hold no hidden rows: the label
                // escalates context by refetching instead of revealing here.
                let expandable = !escalate && gap.is_expandable();
                let chunked = gap.count() > crate::review_diff::DEFAULT_EXPANSION_LINE_COUNT as u32;
                let directions = review_diff_gap_directions(gap.position, chunked);
                let two_directions = directions.len() > 1;
                let gutter = div()
                    .w(px(gutter_width))
                    .h_full()
                    .flex_none()
                    .flex()
                    .when(two_directions, |gutter| gutter.flex_col())
                    .border_r_1()
                    .border_color(theme.border)
                    .bg(theme.overlay)
                    .when(expandable, |mut gutter| {
                        for (button_index, direction) in directions.iter().copied().enumerate() {
                            gutter = gutter.child(self.render_right_panel_diff_gap_action(
                                index,
                                gap.id,
                                direction,
                                review_diff_gap_icon_path(direction),
                                review_diff_gap_tooltip(direction),
                                two_directions,
                                two_directions && button_index == 0,
                                cx,
                            ));
                        }
                        gutter
                    });
                let label_focus = self
                    .transcript_control_focus(format!("right-panel-diff-gap-{}-label", gap.id), cx);
                let label = div()
                    .id(SharedString::from(format!(
                        "right-panel-diff-gap-{}-label",
                        gap.id
                    )))
                    .track_focus(&label_focus)
                    .h_full()
                    .min_w_0()
                    .flex_1()
                    .px(px(12.0))
                    .flex()
                    .items_center()
                    .bg(theme.overlay)
                    .child(tr!("diff.unmodified_lines", count = gap.count()))
                    .when(expandable || escalate, |label| {
                        label
                            .tab_index(0)
                            .cursor_default()
                            .focus_visible(|style| style.border_1().border_color(theme.accent))
                            .hover(|style| {
                                style
                                    .bg(theme.overlay_strong)
                                    .text_color(theme.text_secondary)
                            })
                            .active(|style| style.bg(theme.overlay))
                            .tooltip(Tooltip::text(tr!("diff.expand_context")))
                            .on_click(cx.listener(move |this, event: &gpui::ClickEvent, _, cx| {
                                let direction = if event.modifiers().shift {
                                    crate::review_diff::ExpansionDirection::All
                                } else {
                                    crate::review_diff::ExpansionDirection::Both
                                };
                                this.expand_git_panel_diff_gap(index, direction, escalate, cx);
                                cx.stop_propagation();
                            }))
                            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                    let direction = if event.keystroke.modifiers.shift {
                                        crate::review_diff::ExpansionDirection::All
                                    } else {
                                        crate::review_diff::ExpansionDirection::Both
                                    };
                                    this.expand_git_panel_diff_gap(index, direction, escalate, cx);
                                    cx.stop_propagation();
                                }
                            }))
                    });
                div()
                    .h(px(32.0))
                    .w_full()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .text_size(px(12.5))
                    .text_color(theme.text_tertiary)
                    .child(gutter)
                    .child(label)
                    .into_any_element()
            }
            crate::review_diff::LineKind::HunkHeader => div()
                .min_h(px(24.0))
                .w_full()
                .min_w_0()
                .flex()
                .items_stretch()
                .font_family(md::render::MONO_FAMILY)
                .text_size(px(12.5))
                .line_height(px(16.0))
                .text_color(theme.text_tertiary)
                .child(
                    div()
                        .w(px(gutter_width))
                        .min_h(px(24.0))
                        .self_stretch()
                        .flex_none()
                        .border_r_1()
                        .border_color(theme.border)
                        .bg(theme.overlay),
                )
                .child(
                    div()
                        .min_h(px(24.0))
                        .min_w_0()
                        .flex_1()
                        .px(px(12.0))
                        .py(px(4.0))
                        .flex()
                        .items_start()
                        .overflow_hidden()
                        .whitespace_normal()
                        .bg(theme.overlay)
                        .child(line.content.clone()),
                )
                .into_any_element(),
            crate::review_diff::LineKind::Meta => div()
                .min_h(px(24.0))
                .w_full()
                .min_w_0()
                .flex()
                .items_stretch()
                .font_family(md::render::MONO_FAMILY)
                .text_size(px(12.5))
                .line_height(px(16.0))
                .text_color(theme.text_tertiary)
                .child(
                    div()
                        .w(px(gutter_width))
                        .min_h(px(24.0))
                        .self_stretch()
                        .flex_none(),
                )
                .child(
                    div()
                        .min_h(px(24.0))
                        .min_w_0()
                        .flex_1()
                        .py(px(4.0))
                        .overflow_hidden()
                        .whitespace_normal()
                        .pr(px(10.0))
                        .child(line.content.clone()),
                )
                .into_any_element(),
            crate::review_diff::LineKind::Context
            | crate::review_diff::LineKind::Addition
            | crate::review_diff::LineKind::Deletion => render_diff_code_row(
                line,
                index,
                "review-diff",
                &self.git_panel_diff_selection,
                style,
                &theme,
            ),
        }
    }

    /// Route a gap expand to whichever model owns the visible list.
    fn expand_git_panel_diff_gap(
        &mut self,
        line_index: usize,
        direction: crate::review_diff::ExpansionDirection,
        escalate: bool,
        cx: &mut Context<Self>,
    ) {
        if escalate {
            self.expand_selected_file_diff_context(line_index, cx);
        } else {
            self.expand_last_turn_review_gap(line_index, direction, cx);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render_right_panel_diff_gap_action(
        &self,
        line_index: usize,
        gap_id: u64,
        direction: crate::review_diff::ExpansionDirection,
        icon_path: &'static str,
        tooltip: String,
        compact_half: bool,
        border_bottom: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let direction_name = match direction {
            crate::review_diff::ExpansionDirection::Start => "start",
            crate::review_diff::ExpansionDirection::End => "end",
            crate::review_diff::ExpansionDirection::Both => "both",
            crate::review_diff::ExpansionDirection::All => "all",
        };
        let focus = self.transcript_control_focus(
            format!("right-panel-diff-gap-{gap_id}-button-{direction_name}"),
            cx,
        );
        div()
            .id(SharedString::from(format!(
                "right-panel-diff-gap-{gap_id}-button-{direction_name}"
            )))
            .track_focus(&focus)
            .tab_index(0)
            .w_full()
            .h_full()
            .min_w_0()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .when(compact_half, |button| button.h(px(16.0)).flex_none())
            .when(border_bottom, |button| {
                button.border_b_1().border_color(theme.border)
            })
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .hover(|style| style.bg(theme.overlay_strong))
            .active(|style| style.bg(theme.overlay))
            .tooltip(Tooltip::text(tooltip))
            .child(icon(icon_path, 11.0, theme.text_tertiary))
            .on_click(cx.listener(move |this, event: &gpui::ClickEvent, _, cx| {
                let direction = if event.modifiers().shift {
                    crate::review_diff::ExpansionDirection::All
                } else {
                    direction
                };
                this.expand_last_turn_review_gap(line_index, direction, cx);
                cx.stop_propagation();
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    let direction = if event.keystroke.modifiers.shift {
                        crate::review_diff::ExpansionDirection::All
                    } else {
                        direction
                    };
                    this.expand_last_turn_review_gap(line_index, direction, cx);
                    cx.stop_propagation();
                }
            }))
    }

    /// One listener set covers every selectable code line registered while
    /// the virtualized diff list paints this frame.
    fn git_panel_diff_selection_input(&self) -> impl IntoElement {
        let selection = self.git_panel_diff_selection.clone();
        canvas(
            |_, _, _| (),
            move |_, _, window, _| md::render::install_selection_input(window, &selection),
        )
        .absolute()
        .w(px(0.0))
        .h(px(0.0))
    }

    /// The Git surface skeleton: the Changes/History tab switcher plus
    /// per-query placeholder bodies. The change list, history list, commit
    /// draft, and dialogs arrive with the rendering tasks of the port.
    fn render_right_panel_git(
        &mut self,
        _width: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);

        // Snapshot everything the body reads before the header borrows `cx`
        // for its click listeners.
        let tab = self.git_panel.tab;
        let error = self.git_panel.error.clone();
        let not_a_repository = matches!(
            &self.git_panel.branch_info,
            Query::Ready(info) if info.branch.is_none() && info.head_commit.is_none()
        );
        let branch = match &self.git_panel.branch_info {
            Query::Ready(info) => info.branch.clone(),
            _ => None,
        };

        let mut header = div()
            .id("git-panel-tabs")
            .h(px(42.0))
            .flex_none()
            .px(px(12.0))
            .flex()
            .items_center()
            .gap(px(4.0))
            .border_b_1()
            .border_color(theme.border);
        for (candidate, key) in [
            (GitPanelTab::Changes, "git_panel.changes"),
            (GitPanelTab::History, "git_panel.history"),
        ] {
            let active = tab == candidate;
            header = header.child(
                div()
                    .id(key)
                    .px(px(10.0))
                    .h(px(26.0))
                    .rounded(px(6.0))
                    .flex()
                    .items_center()
                    .text_size(sp(12.0))
                    .font_weight(if active {
                        FontWeight::MEDIUM
                    } else {
                        FontWeight::NORMAL
                    })
                    .text_color(if active {
                        theme.text
                    } else {
                        theme.text_tertiary
                    })
                    .when(active, |element| element.bg(theme.overlay))
                    .hover(|element| element.bg(theme.overlay))
                    .cursor_pointer()
                    .child(tr!(key))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select_git_panel_tab(candidate, cx);
                    })),
            );
        }
        if let Some(branch) = branch
            && !branch.is_empty()
        {
            header = header.child(
                div().flex_1().min_w_0().flex().justify_end().child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(sp(11.5))
                        .text_color(theme.text_tertiary)
                        .child(single_line_label(&branch)),
                ),
            );
        }

        let body = if let Some(error) = error {
            self.render_right_panel_empty_message(tr!("git_panel.error"), error, cx)
        } else if not_a_repository {
            self.render_right_panel_empty_message(
                tr!("git_panel.not_a_repository"),
                tr!("git_panel.not_a_repository_description"),
                cx,
            )
        } else {
            match tab {
                GitPanelTab::Changes => self.render_git_panel_changes(window, cx),
                GitPanelTab::History => self.render_git_panel_history(cx),
            }
        };

        div()
            .id("right-panel-git")
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
            .when(self.git_panel.stash_dialog_open, |panel| {
                panel.child(self.render_git_stash_dialog(cx))
            })
            .into_any_element()
    }

    /// The stash viewer dialog — port of tide's "View Stash" dialog: the
    /// stash list with per-row Pop actions over a scrim, mounted on the
    /// git-dialogs deferred-scrim pattern. Pop closes the dialog and pops
    /// the top stash; the service's git2 behavior means a conflicting pop
    /// still reports `ok` (with markers in the worktree), so only real
    /// failures toast.
    fn render_git_stash_dialog(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let stashes = match &self.git_panel.stashes {
            Query::Ready(stashes) => Some(stashes.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let busy = self.git_panel.busy.is_some();
        let count = stashes.as_ref().map_or(0, |stashes| stashes.len());

        let body: AnyElement = match stashes {
            None => div()
                .py(px(24.0))
                .flex()
                .items_center()
                .justify_center()
                .gap(px(8.0))
                .text_size(sp(12.5))
                .text_color(theme.text_tertiary)
                .child(motion::spin(icon(
                    "icons/loader-circle.svg",
                    14.0,
                    theme.text_tertiary,
                )))
                .child(tr!("git_panel.loading"))
                .into_any_element(),
            Some(stashes) if stashes.is_empty() => div()
                .py(px(24.0))
                .flex()
                .items_center()
                .justify_center()
                .text_size(sp(12.5))
                .text_color(theme.text_tertiary)
                .child(tr!("git_panel.stash_empty"))
                .into_any_element(),
            Some(stashes) => {
                let mut list_div = div()
                    .id("git-stash-list")
                    .max_h(px(300.0))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col();
                for stash in stashes.iter() {
                    let message = if stash.message.is_empty() {
                        tr!("git_panel.stash_no_message")
                    } else {
                        stash.message.clone()
                    };
                    list_div = list_div.child(
                        div()
                            .px(px(20.0))
                            .py(px(8.0))
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .border_b_1()
                            .border_color(theme.border)
                            .child(
                                div()
                                    .flex_none()
                                    .font_family(".SystemUITMonospaced")
                                    .text_size(sp(10.5))
                                    .text_color(theme.accent.opacity(0.8))
                                    .child(single_line_label(&stash.stash_ref)),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .truncate()
                                    .text_size(sp(12.0))
                                    .text_color(theme.text_secondary)
                                    .child(single_line_label(&message)),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!(
                                        "git-stash-pop-{}",
                                        stash.stash_ref
                                    )))
                                    .tab_index(0)
                                    .focus_visible(|style| {
                                        style.border_1().border_color(theme.accent)
                                    })
                                    .h(px(22.0))
                                    .px(px(8.0))
                                    .rounded(px(6.0))
                                    .border_1()
                                    .border_color(theme.border_strong)
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .cursor_default()
                                    .text_size(sp(11.0))
                                    .text_color(if busy {
                                        theme.text_ghost
                                    } else {
                                        theme.text_secondary
                                    })
                                    .when(!busy, |button| {
                                        button.hover(|button| button.bg(theme.overlay))
                                    })
                                    .child(tr!("git_panel.pop"))
                                    .on_activation(cx, move |this, _, cx| {
                                        this.pop_git_panel_stash(cx);
                                    }),
                            ),
                    );
                }
                list_div.into_any_element()
            }
        };

        let card = div()
            .id("git-stash-card")
            .key_context("GitStashDialog")
            .on_action(
                cx.listener(|this, _: &super::git_panel::DismissGitStash, _, cx| {
                    this.git_panel.stash_dialog_open = false;
                    cx.notify();
                }),
            )
            .tab_group()
            .tab_stop(false)
            .w_full()
            .max_w(px(420.0))
            .overflow_hidden()
            .rounded(px(18.0))
            .bg(theme.composer)
            .shadow_xl()
            .flex()
            .flex_col()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .px(px(20.0))
                    .py(px(14.0))
                    .flex()
                    .flex_col()
                    .gap(px(3.0))
                    .child(
                        div()
                            .text_size(sp(15.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .child(tr!("git_panel.stash_title")),
                    )
                    .child(
                        div()
                            .text_size(sp(11.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("git_panel.stash_count", count = count)),
                    ),
            )
            .child(div().mx(px(20.0)).h(px(1.0)).bg(theme.border))
            .child(body)
            .child(
                div()
                    .px(px(20.0))
                    .py(px(12.0))
                    .border_t_1()
                    .border_color(theme.border)
                    .bg(theme.overlay)
                    .flex()
                    .items_center()
                    .justify_end()
                    .flex_none()
                    .child(
                        div()
                            .id("git-stash-close")
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.accent))
                            .h(px(26.0))
                            .px(px(12.0))
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .flex()
                            .items_center()
                            .cursor_default()
                            .text_size(sp(12.5))
                            .text_color(theme.text_secondary)
                            .hover(|button| button.bg(theme.overlay))
                            .child(tr!("common.close"))
                            .on_activation(cx, |this, _, cx| {
                                this.git_panel.stash_dialog_open = false;
                                cx.notify();
                            }),
                    ),
            );
        crate::ui::modal::deferred_scrim("git-stash-layer", card, &theme)
    }

    // ── History tab ─────────────────────────────────────────────────────────

    /// The History tab: count + refresh header, column header, then the
    /// virtualized 24px commit rows with the lane graph painted behind
    /// their transparent 64px gutter.
    fn render_git_panel_history(&mut self, cx: &mut Context<Self>) -> Div {
        if self.git_panel.commit_detail.is_some() {
            return self.render_git_commit_detail(cx);
        }
        let theme = Theme::current(cx);
        let log = match &self.git_panel.log {
            Query::Ready(log) => Some(log.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let graph = self.git_panel.history_graph.clone();
        let refreshing = self.git_panel.refresh_in_flight;

        let refresh_focus = self.transcript_control_focus("git-history-refresh", cx);
        let header = div()
            .h(px(26.0))
            .flex_none()
            .px(px(12.0))
            .flex()
            .items_center()
            .gap(px(4.0))
            .child(
                div()
                    .text_size(sp(11.5))
                    .text_color(theme.text_tertiary)
                    .child(tr!(
                        "git_panel.history_count",
                        count = log.as_ref().map_or(0, |log| log.len())
                    )),
            )
            .child(div().flex_1())
            .child(
                div()
                    .id("git-history-refresh")
                    .track_focus(&refresh_focus)
                    .tab_index(0)
                    .size(px(22.0))
                    .rounded(px(5.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon(
                        "icons/refresh.svg",
                        12.0,
                        if refreshing {
                            theme.accent
                        } else {
                            theme.text_tertiary
                        },
                    ))
                    .tooltip(|window, cx| {
                        Tooltip::new(tr!("git_panel.refresh_history")).build(window, cx)
                    })
                    .on_activation(cx, |this, _, cx| {
                        this.refresh_git_panel(cx);
                    }),
            );

        let column_header = div()
            .h(px(20.0))
            .flex_none()
            .px(px(12.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_size(sp(10.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.text_ghost)
            .child(div().w(px(GRAPH_WIDTH)).flex_none())
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(single_line_label(&tr!("git_panel.column_subject"))),
            )
            .child(
                div()
                    .flex_none()
                    .child(single_line_label(&tr!("git_panel.column_date"))),
            )
            .child(
                div()
                    .w(px(112.0))
                    .flex_none()
                    .flex()
                    .justify_end()
                    .child(single_line_label(&tr!("git_panel.column_author"))),
            );

        let body = if log.is_none() {
            self.render_git_panel_loading_rows(&theme)
                .into_any_element()
        } else if log.as_ref().is_some_and(|log| log.is_empty()) {
            self.render_right_panel_empty_message(
                tr!("git_panel.no_commits"),
                tr!("git_panel.no_commits_description"),
                cx,
            )
            .into_any_element()
        } else {
            let entity = cx.entity().downgrade();
            let list_state = self.git_panel_history_list_state.clone();
            let graph_layer = div()
                .id("git-history-graph")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .overflow_hidden()
                .when_some(graph, |layer, graph| {
                    layer.child(git_history::graph_column(graph, list_state.clone(), &theme))
                })
                .into_any_element();
            div()
                .id("git-history-rows")
                .flex_1()
                .min_h_0()
                .min_w_0()
                .relative()
                .child(graph_layer)
                .child(
                    list(
                        self.git_panel_history_list_state.clone(),
                        move |index, _w, cx| {
                            entity
                                .upgrade()
                                .map(|entity| {
                                    entity.update(cx, |this, cx| {
                                        this.render_git_history_row(index, cx)
                                    })
                                })
                                .unwrap_or_else(|| div().into_any_element())
                        },
                    )
                    .size_full(),
                )
                .child(scrollbar::vertical(
                    &self.git_panel_history_list_state,
                    &self.git_panel_history_scrollbar,
                ))
                .into_any_element()
        };

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(header)
            .child(column_header)
            .child(body)
    }

    /// One 24px History row: transparent 64px graph gutter, then branch/tag
    /// chips + subject, relative date, and the initials avatar + author.
    /// Click/enter opens the commit details; the "…" button opens actions.
    fn render_git_history_row(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let Some(commit) = matches!(&self.git_panel.log, Query::Ready(log) if log.len() > index)
            .then(|| match &self.git_panel.log {
                Query::Ready(log) => log[index].clone(),
                _ => unreachable!(),
            })
        else {
            return div().h(px(HISTORY_ROW_H)).into_any_element();
        };
        let lane = self
            .git_panel
            .history_graph
            .as_ref()
            .map(|graph| graph.lane_at(index))
            .unwrap_or(0);
        let lane_color = git_history::lane_color(&theme, lane);
        let active = self
            .git_panel
            .commit_detail
            .as_ref()
            .is_some_and(|detail| detail.sha == commit.sha);
        let sha = commit.sha.clone();

        let row_focus = self.transcript_control_focus(format!("git-history-row-{sha}"), cx);
        let mut subject_row = div().flex().min_w_0().flex_1().items_center().gap(px(3.0));
        let has_chips = !commit.branch_heads.is_empty() || !commit.tags.is_empty();
        if has_chips {
            for (position, name) in commit.branch_heads.iter().enumerate() {
                let head_branch = commit.is_head && position == 0;
                subject_row = subject_row.child(
                    div()
                        .max_w(px(112.0))
                        .flex_none()
                        .h(px(16.0))
                        .px(px(1.0))
                        .rounded(px(3.0))
                        .border_1()
                        .border_color(lane_color.opacity(0.7))
                        .bg(if head_branch {
                            theme.accent.opacity(0.15)
                        } else {
                            theme.overlay
                        })
                        .flex()
                        .items_center()
                        .gap(px(3.0))
                        .pr(px(4.0))
                        .id(SharedString::from(format!(
                            "git-history-branch-chip-{name}"
                        )))
                        .tooltip(Tooltip::text(name.clone()))
                        .child(
                            div()
                                .flex_none()
                                .size(px(14.0))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(icon(
                                    "icons/git-branch.svg",
                                    10.0,
                                    if theme.is_dark {
                                        gpui::black()
                                    } else {
                                        gpui::white()
                                    },
                                ))
                                .when(true, |chip| chip.bg(lane_color)),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_family(".SystemUIFontMonospaced")
                                .text_size(sp(10.0))
                                .text_color(if head_branch {
                                    theme.accent
                                } else {
                                    theme.text_secondary
                                })
                                .child(name.clone()),
                        ),
                );
            }
            for tag in &commit.tags {
                subject_row = subject_row.child(
                    div()
                        .max_w(px(96.0))
                        .flex_none()
                        .h(px(16.0))
                        .px(px(4.0))
                        .rounded(px(3.0))
                        .bg(theme.warning.opacity(0.15))
                        .flex()
                        .items_center()
                        .gap(px(3.0))
                        .id(SharedString::from(format!("git-history-tag-chip-{tag}")))
                        .tooltip(Tooltip::text(format!("tag {tag}")))
                        .child(icon("icons/star.svg", 9.0, theme.warning))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .font_family(".SystemUIFontMonospaced")
                                .text_size(sp(10.0))
                                .text_color(theme.warning)
                                .child(tag.clone()),
                        ),
                );
            }
        }
        subject_row = subject_row.child(
            div()
                .min_w_0()
                .flex_1()
                .truncate()
                .text_size(sp(11.5))
                .text_color(theme.text.opacity(0.9))
                .child(single_line_label(&commit.subject)),
        );

        let hue = commit_hue(&commit.sha);
        let initials = commit_initials(&commit.author);
        let author_cell = div()
            .w(px(112.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_end()
            .gap(px(4.0))
            .overflow_hidden()
            .child(
                div()
                    .size(px(14.0))
                    .flex_none()
                    .rounded_full()
                    .bg(gpui::hsla(hue, 0.4, 0.42, 1.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(sp(8.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(gpui::white())
                    .id(SharedString::from(format!("git-history-avatar-{sha}")))
                    .tooltip(Tooltip::text(commit.author.clone()))
                    .child(initials),
            )
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(sp(10.0))
                    .text_color(theme.text_tertiary)
                    .child(single_line_label(&commit.author)),
            );

        let date_cell = div()
            .flex_none()
            .text_size(sp(10.0))
            .text_color(theme.text_ghost)
            .id(SharedString::from(format!("git-history-date-{sha}")))
            .tooltip(Tooltip::text(absolute_commit_date(&commit.date)))
            .child(relative_commit_date(&commit.date));

        // The actions popover: one handle per commit, created lazily like
        // the row focus. Opening records the sha so the card knows whose
        // actions it carries.
        let handle = {
            let sha = sha.clone();
            let weak = cx.entity().downgrade();
            self.menu_handle_with(
                SharedString::from(format!("git-history-action-{sha}")),
                cx,
                move |open, _window, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        if open {
                            this.git_panel.history_action =
                                Some(super::git_panel::HistoryRowAction {
                                    sha: sha.clone(),
                                    stage: HistoryActionStage::Menu,
                                    branch_input: None,
                                });
                        } else {
                            this.git_panel.history_action = None;
                        }
                        cx.notify();
                    });
                },
            )
        };
        let weak = cx.entity().downgrade();
        let actions_card = Rc::new(
            move |handle: &ContextMenuHandle, window: &mut Window, cx: &mut App| {
                weak.upgrade()
                    .map(|entity| {
                        entity.update(cx, |this, cx| {
                            this.render_git_history_action_card(handle, window, cx)
                        })
                    })
                    .unwrap_or_else(|| div().into_any_element())
            },
        );
        let actions = popover(
            div()
                .id(SharedString::from(format!("git-history-action-{sha}")))
                .size(px(18.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.0))
                .child(icon("icons/ellipsis.svg", 13.0, theme.text_ghost)),
            &handle,
            MenuAlign::BelowRight,
            move |handle, window, cx| actions_card(handle, window, cx),
        );

        let open_sha = sha.clone();
        div()
            .id(SharedString::from(format!("git-history-{sha}")))
            .track_focus(&row_focus)
            .tab_index(0)
            .w_full()
            .h(px(HISTORY_ROW_H))
            .flex()
            .items_center()
            .min_w_0()
            .cursor_default()
            .when(active, |row| row.bg(theme.accent.opacity(0.08)))
            .focus_visible(|row| row.bg(theme.accent.opacity(0.10)))
            .on_activation(cx, move |this, _, cx| {
                this.open_git_commit_detail(open_sha.clone(), cx);
            })
            .child(div().w(px(GRAPH_WIDTH)).flex_none().h_full())
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .pr(px(8.0))
                    .hover(|row| {
                        if active {
                            row
                        } else {
                            row.bg(theme.overlay.opacity(0.6))
                        }
                    })
                    .child(subject_row)
                    .child(date_cell)
                    .child(author_cell)
                    .child(actions),
            )
            .into_any_element()
    }

    /// The "…" card: the actions menu, the armed revert confirmation, or
    /// the branch-from-here input, per the open stage.
    fn render_git_history_action_card(
        &mut self,
        handle: &ContextMenuHandle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let Some(action) = self.git_panel.history_action.clone() else {
            return div().into_any_element();
        };
        // The branch-name input materializes here (the profile-dialog
        // pattern): `TextInput::new` needs a window, which the card has.
        let branch_input = match (&action.stage, &action.branch_input) {
            (HistoryActionStage::Branch, Some(input)) => Some(input.clone()),
            (HistoryActionStage::Branch, None) => {
                let input = cx.new(|cx| {
                    TextInput::new(window, cx).placeholder(tr!("git_panel.branch_name_placeholder"))
                });
                if let Some(action) = self.git_panel.history_action.as_mut() {
                    action.branch_input = Some(input.clone());
                }
                Some(input)
            }
            _ => None,
        };
        let sha = action.sha.clone();
        let subject = match &self.git_panel.log {
            Query::Ready(log) => log
                .iter()
                .find(|commit| commit.sha == sha)
                .map(|commit| commit.subject.clone())
                .unwrap_or_default(),
            Query::Pending | Query::Missing(_) => String::new(),
        };

        let mut card = div()
            .id("git-history-action-card")
            .w(px(236.0))
            .p(px(8.0))
            .rounded(px(10.0))
            .border_1()
            .border_color(theme.border_strong)
            .bg(theme.raised)
            .shadow_lg()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(10.5))
                    .text_color(theme.text_ghost)
                    .child(format!("{sha} · {subject}")),
            );

        match action.stage {
            HistoryActionStage::Menu => {
                let checkout_handle = handle.clone();
                let checkout_sha = sha.clone();
                let copy_handle = handle.clone();
                let copy_sha = sha.clone();
                card = card
                    .child(render_history_action_item(
                        "git-history-action-branch",
                        "icons/git-branch.svg",
                        tr!("git_panel.branch_from_here"),
                        false,
                        self.transcript_control_focus("git-history-action-branch", cx),
                        &theme,
                        cx,
                        move |this, window, cx| {
                            this.set_history_action_stage(HistoryActionStage::Branch, window, cx);
                        },
                    ))
                    .child(render_history_action_item(
                        "git-history-action-checkout",
                        "icons/corner-down-right.svg",
                        tr!("git_panel.checkout_detached"),
                        false,
                        self.transcript_control_focus("git-history-action-checkout", cx),
                        &theme,
                        cx,
                        move |this, window, cx| {
                            this.close_history_row_action(cx);
                            checkout_handle.close(window, cx);
                            this.run_git_history_checkout(
                                false,
                                checkout_sha.clone(),
                                Some(checkout_sha.clone()),
                                cx,
                            );
                        },
                    ))
                    .child(render_history_action_item(
                        "git-history-action-copy",
                        "icons/copy.svg",
                        tr!("git_panel.copy_sha"),
                        false,
                        self.transcript_control_focus("git-history-action-copy", cx),
                        &theme,
                        cx,
                        move |this, window, cx| {
                            this.close_history_row_action(cx);
                            copy_handle.close(window, cx);
                            cx.write_to_clipboard(ClipboardItem::new_string(copy_sha.clone()));
                            this.show_toast(tr!("git_panel.sha_copied"));
                        },
                    ))
                    .child(render_history_action_item(
                        "git-history-action-revert",
                        "icons/rotate-cw.svg",
                        tr!("git_panel.revert_commit"),
                        true,
                        self.transcript_control_focus("git-history-action-revert", cx),
                        &theme,
                        cx,
                        move |this, window, cx| {
                            this.set_history_action_stage(HistoryActionStage::Revert, window, cx);
                        },
                    ));
            }
            HistoryActionStage::Revert => {
                let cancel_handle = handle.clone();
                let confirm_handle = handle.clone();
                let confirm_sha = sha.clone();
                card = card
                    .child(
                        div()
                            .px(px(6.0))
                            .pt(px(6.0))
                            .pb(px(2.0))
                            .text_size(sp(12.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .child(tr!("git_panel.revert_title")),
                    )
                    .child(
                        div()
                            .px(px(6.0))
                            .pb(px(6.0))
                            .text_size(sp(11.0))
                            .text_color(theme.text_tertiary)
                            .child(tr!("git_panel.revert_description", sha = sha.clone())),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(6.0))
                            .pt(px(2.0))
                            .child(render_history_action_button(
                                "git-history-revert-cancel",
                                tr!("common.cancel"),
                                false,
                                self.transcript_control_focus("git-history-revert-cancel", cx),
                                &theme,
                                cx,
                                move |this, window, cx| {
                                    this.close_history_row_action(cx);
                                    cancel_handle.close(window, cx);
                                },
                            ))
                            .child(render_history_action_button(
                                "git-history-revert-confirm",
                                tr!("git_panel.revert_confirm"),
                                true,
                                self.transcript_control_focus("git-history-revert-confirm", cx),
                                &theme,
                                cx,
                                move |this, window, cx| {
                                    this.close_history_row_action(cx);
                                    confirm_handle.close(window, cx);
                                    this.run_git_panel_revert(confirm_sha.clone(), cx);
                                },
                            )),
                    );
            }
            HistoryActionStage::Branch => {
                let cancel_handle = handle.clone();
                let confirm_handle = handle.clone();
                card = card
                    .child(
                        div()
                            .px(px(6.0))
                            .pt(px(6.0))
                            .pb(px(4.0))
                            .text_size(sp(12.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .child(tr!("git_panel.branch_from_title", sha = sha.clone())),
                    )
                    .child(
                        div()
                            .px(px(6.0))
                            .pb(px(6.0))
                            .when_some(branch_input, |field, input| field.child(input)),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(6.0))
                            .pt(px(2.0))
                            .child(render_history_action_button(
                                "git-history-branch-cancel",
                                tr!("common.cancel"),
                                false,
                                self.transcript_control_focus("git-history-branch-cancel", cx),
                                &theme,
                                cx,
                                move |this, window, cx| {
                                    this.close_history_row_action(cx);
                                    cancel_handle.close(window, cx);
                                },
                            ))
                            .child(render_history_action_button(
                                "git-history-branch-confirm",
                                tr!("git_panel.branch_create_and_switch"),
                                true,
                                self.transcript_control_focus("git-history-branch-confirm", cx),
                                &theme,
                                cx,
                                move |this, window, cx| {
                                    confirm_handle.close(window, cx);
                                    this.submit_history_branch(cx);
                                },
                            )),
                    );
            }
        }
        card.into_any_element()
    }

    /// The commit-details sub-view: back header with sha + tags, then the
    /// subject/body, author row, clickable parents, and the changed-file
    /// list with inline per-file diffs — port of tide's
    /// `CommitDetailsPanel`.
    fn render_git_commit_detail(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let Some(detail) = self.git_panel.commit_detail.as_ref() else {
            return div();
        };
        let commit: Option<PanelCommit> = match &self.git_panel.log {
            Query::Ready(log) => log.iter().find(|c| c.sha == detail.sha).cloned(),
            Query::Pending | Query::Missing(_) => None,
        };
        let detail_sha = detail.sha.clone();
        let message = match &detail.message {
            Query::Ready(message) => Some(message.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let files = match &detail.files {
            Query::Ready(files) => Some(files.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let file_diff_path = detail.file_diff.as_ref().map(|diff| diff.path.clone());
        let file_diff_snapshot = detail
            .file_diff
            .as_ref()
            .and_then(|diff| diff.snapshot.clone());
        let file_diff_loading = detail.file_diff.as_ref().is_some_and(|diff| {
            matches!(diff.hunks, Query::Pending | Query::Missing(_)) && diff.snapshot.is_none()
        });

        let back_focus = self.transcript_control_focus("git-commit-detail-back", cx);
        let header = div()
            .h(px(42.0))
            .flex_none()
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .id("git-commit-detail-back")
                    .track_focus(&back_focus)
                    .tab_index(0)
                    .size(px(26.0))
                    .rounded(px(6.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon("icons/arrow-left.svg", 15.0, theme.text_secondary))
                    .tooltip(|window, cx| Tooltip::new(tr!("git_panel.back")).build(window, cx))
                    .on_activation(cx, |this, _, cx| {
                        this.close_git_commit_detail(cx);
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(12.0))
                    .text_color(theme.text_secondary)
                    .child(detail_sha.clone()),
            )
            .when_some(commit.clone(), |header: Div, commit: PanelCommit| {
                header.child(div().flex().flex_none().items_center().gap(px(3.0)).when(
                    !commit.tags.is_empty(),
                    |tags| {
                        tags.children(commit.tags.iter().take(3).map(|tag| {
                            div()
                                .h(px(16.0))
                                .px(px(4.0))
                                .rounded(px(3.0))
                                .bg(theme.warning.opacity(0.15))
                                .flex()
                                .items_center()
                                .gap(px(3.0))
                                .id(SharedString::from(format!("git-commit-detail-tag-{tag}")))
                                .tooltip(Tooltip::text(format!("tag {tag}")))
                                .child(icon("icons/star.svg", 9.0, theme.warning))
                                .child(
                                    div()
                                        .font_family(".SystemUIFontMonospaced")
                                        .text_size(sp(10.0))
                                        .text_color(theme.warning)
                                        .child(tag.clone()),
                                )
                        }))
                    },
                ))
            });

        // Body: metadata first, then the changed files with inline diffs.
        let mut body = div()
            .id("git-commit-detail-body")
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .when_some(commit.clone(), |body: Stateful<Div>, commit: PanelCommit| {
                let hue = commit_hue(&commit.sha);
                body.child(
                    div()
                        .px(px(12.0))
                        .pt(px(10.0))
                        .pb(px(6.0))
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .border_b_1()
                        .border_color(theme.border)
                        .child(
                            div()
                                .text_size(sp(12.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text)
                                .child(commit.subject.clone()),
                        )
                        .when_some(message.clone(), |block, message| {
                            let body_text = strip_subject(&message, &commit.subject);
                            block.when(!body_text.is_empty(), |block| {
                                block.child(
                                    div()
                                        .text_size(sp(11.5))
                                        .text_color(theme.text_secondary)
                                        .child(body_text),
                                )
                            })
                        })
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(5.0))
                                .min_w_0()
                                .child(
                                    div()
                                        .size(px(16.0))
                                        .flex_none()
                                        .rounded_full()
                                        .bg(gpui::hsla(hue, 0.4, 0.42, 1.0))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_size(sp(8.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(gpui::white())
                                        .id("git-commit-detail-avatar")
                                        .child(commit_initials(&commit.author)),
                                )
                                .child(
                                    div()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(sp(11.0))
                                        .text_color(theme.text_secondary)
                                        .child(commit.author.clone()),
                                )
                                .child(
                                    div().text_color(theme.text_ghost).child("·"),
                                )
                                .child(
                                    div()
                                        .flex_none()
                                        .text_size(sp(11.0))
                                        .text_color(theme.text_tertiary)
                                        .id("git-commit-detail-date")
                                        .tooltip(Tooltip::text(absolute_commit_date(
                                            &commit.date,
                                        )))
                                        .child(relative_commit_date(&commit.date)),
                                ),
                        )
                        .when(!commit.parents.is_empty(), |block| {
                            block.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(4.0))
                                    .font_family(".SystemUIFontMonospaced")
                                    .text_size(sp(10.5))
                                    .text_color(theme.text_ghost)
                                    .child(icon(
                                        if commit.parents.len() > 1 {
                                            "icons/git-fork.svg"
                                        } else {
                                            "icons/git-commit-horizontal.svg"
                                        },
                                        12.0,
                                        theme.text_ghost,
                                    ))
                                    .children(commit.parents.iter().enumerate().map(
                                        |(position, parent)| {
                                            let known = matches!(&self.git_panel.log, Query::Ready(log) if log.iter().any(|c| c.sha == *parent));
                                            let parent = parent.clone();
                                            let focus = self.transcript_control_focus(
                                                format!("git-commit-parent-{parent}"),
                                                cx,
                                            );
                                            div()
                                                .id(SharedString::from(format!(
                                                    "git-commit-parent-{parent}"
                                                )))
                                                .track_focus(&focus)
                                                .tab_index(if known { 0 } else { -1 })
                                                .px(px(3.0))
                                                .rounded(px(4.0))
                                                .cursor_default()
                                                .text_color(if known {
                                                    theme.accent.opacity(0.8)
                                                } else {
                                                    theme.text_ghost
                                                })
                                                .focus_visible(|style| {
                                                    style.bg(theme.accent.opacity(0.1))
                                                })
                                                .hover(|style| {
                                                    if known {
                                                        style.bg(theme.accent.opacity(0.1))
                                                    } else {
                                                        style
                                                    }
                                                })
                                                .tooltip(Tooltip::text(if known {
                                                    tr!("git_panel.go_to_commit", sha = parent.clone())
                                                } else {
                                                    tr!(
                                                        "git_panel.parent_outside_history",
                                                        sha = parent.clone()
                                                    )
                                                }))
                                                .when(position > 0, |chip| chip.child("+"))
                                                .child(parent.clone())
                                                .on_activation(
                                                    cx,
                                                    move |this, _, cx| {
                                                        this.select_git_commit(
                                                            parent.clone(),
                                                            cx,
                                                        );
                                                    },
                                                )
                                        },
                                    )),
                            )
                        }),
                )
            });

        match files {
            None => {
                body = body.child(
                    div()
                        .px(px(12.0))
                        .py(px(10.0))
                        .text_size(sp(11.0))
                        .text_color(theme.text_tertiary)
                        .child(tr!("git_panel.loading")),
                );
            }
            Some(files) if files.is_empty() => {}
            Some(files) => {
                let mut section = div().flex().flex_col();
                for file in files.iter() {
                    let path = file.path.clone();
                    let expanded = file_diff_path.as_deref() == Some(file.path.as_str());
                    let focus =
                        self.transcript_control_focus(format!("git-commit-file-{}", file.path), cx);
                    let basename = file
                        .path
                        .rsplit('/')
                        .next()
                        .unwrap_or(&file.path)
                        .to_owned();
                    let directory = file
                        .path
                        .strip_suffix(&basename)
                        .unwrap_or_default()
                        .to_owned();
                    section = section.child(
                        div()
                            .id(SharedString::from(format!("git-commit-file-{}", file.path)))
                            .track_focus(&focus)
                            .tab_index(0)
                            .w_full()
                            .min_h(px(26.0))
                            .px(px(12.0))
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .cursor_default()
                            .focus_visible(|style| style.bg(theme.overlay))
                            .hover(|style| style.bg(theme.overlay))
                            .on_activation(cx, move |this, _, cx| {
                                this.toggle_git_commit_file_diff(path.clone(), cx);
                            })
                            .child(div().flex_none().w(px(8.0)).flex().justify_center().child(
                                icon(
                                    if expanded {
                                        "icons/chevron-down.svg"
                                    } else {
                                        "icons/chevron-right.svg"
                                    },
                                    11.0,
                                    theme.text_ghost,
                                ),
                            ))
                            .child(
                                div()
                                    .flex_none()
                                    .w(px(52.0))
                                    .text_size(sp(10.0))
                                    .font_family(".SystemUIFontMonospaced")
                                    .text_color(file_status_color(&theme, &file.status))
                                    .child(file.status.clone()),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .flex()
                                    .flex_1()
                                    .flex_col()
                                    .child(
                                        div()
                                            .min_w_0()
                                            .truncate()
                                            .text_size(sp(11.0))
                                            .text_color(theme.text_secondary)
                                            .child(basename.clone()),
                                    )
                                    .when(!directory.is_empty(), |column| {
                                        column.child(
                                            div()
                                                .min_w_0()
                                                .truncate()
                                                .text_size(sp(9.5))
                                                .text_color(theme.text_ghost)
                                                .child(directory.clone()),
                                        )
                                    }),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .font_family(".SystemUIFontMonospaced")
                                    .text_size(sp(10.0))
                                    .text_color(theme.success)
                                    .child(format!("+{}", file.additions)),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .font_family(".SystemUIFontMonospaced")
                                    .text_size(sp(10.0))
                                    .text_color(theme.danger)
                                    .child(format!("\u{2212}{}", file.deletions)),
                            ),
                    );
                    if expanded {
                        if let Some(snapshot) = file_diff_snapshot.clone() {
                            let entity = cx.entity().downgrade();
                            // The inline diff must own a definite height: a
                            // `list` sizes itself from its container, so
                            // `max_h`-only styling collapses it to zero rows
                            // inside the flex-column body. Give it the FULL
                            // content height — the details body's
                            // overflow_y_scroll owns the scrolling, so the
                            // whole diff rides the body's scrollbar instead
                            // of fighting it in a nested capped viewport.
                            let row_height =
                                DiffRowStyle::review(self.state.code_font_size).row_height;
                            let diff_height = snapshot.lines.len() as f32 * row_height;
                            section = section.child(
                                div()
                                    .border_t_1()
                                    .border_b_1()
                                    .border_color(theme.border)
                                    .child(
                                        list(
                                            self.git_panel_diff_list_state.clone(),
                                            move |index, _window, cx| {
                                                entity
                                                    .upgrade()
                                                    .map(|entity| {
                                                        entity.update(cx, |this, cx| {
                                                            this.render_right_panel_diff_line(
                                                                &snapshot, index, false, cx,
                                                            )
                                                        })
                                                    })
                                                    .unwrap_or_else(|| div().into_any_element())
                                            },
                                        )
                                        .h(px(diff_height))
                                        .flex_none(),
                                    ),
                            );
                        } else if file_diff_loading {
                            section = section.child(
                                div()
                                    .px(px(12.0))
                                    .py(px(8.0))
                                    .text_size(sp(10.5))
                                    .text_color(theme.text_tertiary)
                                    .child(tr!("git_panel.loading")),
                            );
                        }
                    }
                }
                body = body.child(section);
            }
        }

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
    }

    /// The Changes tab: identity bar, branch toolbar, summary + bulk row,
    /// conflict band, the staged/unstaged sections over one virtualized row
    /// list, and the commit bar footer.
    fn render_git_panel_changes(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        // The two sub-views own the whole Changes body: an open file diff or
        // a last-turn review replaces the branch bar and the list, each with
        // its own back affordance.
        if self.git_panel.last_turn_review.is_some() {
            return self.render_git_last_turn_review(cx);
        }
        if self.git_panel.selected_file_diff.is_some() {
            return self.render_git_file_diff_sub_view(cx);
        }
        let theme = Theme::current(cx);
        let status_pending = matches!(self.git_panel.status, Query::Pending | Query::Missing(_));
        let changes = match &self.git_panel.status {
            Query::Ready(changes) => Some(changes.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let conflicts_empty = match &self.git_panel.conflicts {
            Query::Ready(conflicts) => conflicts.is_empty(),
            Query::Pending | Query::Missing(_) => true,
        };
        let (total_additions, total_deletions) = changes.as_ref().map_or((0, 0), |changes| {
            changes.iter().fold((0, 0), |(add, del), change| {
                (add + change.additions, del + change.deletions)
            })
        });
        let changes_count = changes.as_ref().map_or(0, |changes| changes.len());

        let body = if status_pending {
            self.render_git_panel_loading_rows(&theme)
                .into_any_element()
        } else if changes_count == 0 && conflicts_empty {
            self.render_right_panel_empty_message(
                tr!("git_panel.clean_tree"),
                tr!("git_panel.clean_tree_description"),
                cx,
            )
            .into_any_element()
        } else {
            let entity = cx.entity().downgrade();
            div()
                .flex_1()
                .min_h_0()
                .min_w_0()
                .relative()
                .child(
                    list(
                        self.git_panel_changes_list_state.clone(),
                        move |index, _window, cx| {
                            entity
                                .upgrade()
                                .map(|entity| {
                                    entity.update(cx, |this, cx| {
                                        this.render_git_changes_row(index, cx)
                                    })
                                })
                                .unwrap_or_else(|| div().into_any_element())
                        },
                    )
                    .size_full(),
                )
                .child(scrollbar::vertical(
                    &self.git_panel_changes_list_state,
                    &self.git_panel_changes_scrollbar,
                ))
                .into_any_element()
        };

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(self.render_git_panel_identity_bar(cx))
            .child(self.render_git_panel_branch_bar(window, cx))
            // Always rendered, even on a clean tree: the bulk menu it carries
            // is also where the stash actions live, and a stash is most often
            // managed right after "Stash All" leaves the tree clean.
            .child(self.render_git_panel_summary_row(total_additions, total_deletions, cx))
            .child(body)
            .child(self.render_git_panel_commit_bar(window, cx))
    }

    /// The "Committing as" strip above the Changes list — port of tide's
    /// CommitIdentityBar. The resolved identity renders with the matched
    /// profile's dot color (settings snapshot when loaded, neutral
    /// otherwise); amber when nothing resolves anywhere. The dropdown
    /// applies identities through the same GitSetIdentity dispatch the
    /// settings page uses.
    fn render_git_panel_identity_bar(&mut self, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let identity = match &self.git_panel.current_identity {
            Query::Ready(identity) => Some(identity.clone()),
            Query::Pending | Query::Missing(_) => None,
        };
        let profiles: Vec<protocol::git_settings::GitProfileWire> = self
            .git_settings
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.profiles.clone())
            .unwrap_or_default();
        let applied_dot = identity
            .as_ref()
            .and_then(|identity| identity.profile_id.as_ref())
            .and_then(|profile_id| profiles.iter().find(|p| &p.id == profile_id))
            .map(|profile| super::settings::git_dot_color(&profile.color, &theme));
        let no_identity = identity
            .as_ref()
            .is_some_and(|identity| identity.name.is_none() && identity.email.is_none());
        let label = if no_identity {
            tr!("git_panel.no_identity")
        } else {
            identity
                .as_ref()
                .and_then(|identity| {
                    Some(format!(
                        "{} <{}>",
                        identity.name.as_deref()?,
                        identity.email.as_deref()?
                    ))
                })
                .unwrap_or_else(|| tr!("git_panel.committing_as"))
        };

        let handle = self.menu_handle("git-panel-identity", cx);
        let weak = cx.entity().downgrade();
        let active_profile_id = identity.as_ref().and_then(|i| i.profile_id.clone());
        let has_profiles = !profiles.is_empty();
        let menu_profiles = std::rc::Rc::new(profiles);
        let trigger = div()
            .id("git-panel-identity-trigger")
            .h(px(24.0))
            .px(px(6.0))
            .rounded(px(6.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .cursor_default()
            .text_size(sp(11.5))
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .hover(|style| style.bg(theme.overlay))
            .child(if no_identity {
                icon("icons/triangle-alert.svg", 12.0, theme.warning).into_any_element()
            } else {
                div()
                    .size(px(7.0))
                    .flex_none()
                    .rounded_full()
                    .bg(applied_dot.unwrap_or(theme.text_tertiary))
                    .into_any_element()
            })
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_family(".SystemUIFontMonospaced")
                    .text_color(if no_identity {
                        theme.warning
                    } else {
                        theme.text_secondary
                    })
                    .child(single_line_label(&label)),
            )
            .child(icon("icons/chevron-down.svg", 10.0, theme.text_tertiary));
        let menu = dropdown_menu(
            trigger,
            "git-panel-identity-menu",
            &handle,
            MenuAlign::BelowLeft,
            move |_| {
                let mut items = vec![
                    MenuItem::new(tr!("git.projects.global"), {
                        let weak = weak.clone();
                        move |_, cx| {
                            let _ = weak.update(cx, |this, _| {
                                this.set_git_panel_identity("global".to_owned());
                            });
                        }
                    })
                    .icon("icons/globe.svg")
                    .selected(active_profile_id.is_none()),
                ];
                if has_profiles {
                    items.push(MenuItem::Separator);
                }
                for menu_profile in menu_profiles.iter() {
                    let weak = weak.clone();
                    let profile_id = menu_profile.id.clone();
                    let display = menu_profile
                        .name
                        .clone()
                        .unwrap_or_else(|| menu_profile.user_name.clone());
                    let email = menu_profile.user_email.clone();
                    let dot = super::settings::git_dot_color(&menu_profile.color, &theme);
                    let selected = active_profile_id.as_deref() == Some(menu_profile.id.as_str());
                    items.push(
                        MenuItem::custom(move |_, _| {
                            div()
                                .w(px(252.0))
                                .py(px(4.0))
                                .flex()
                                .items_center()
                                .gap(px(9.0))
                                .child(div().size(px(7.0)).flex_none().rounded_full().bg(dot))
                                .child(
                                    div().flex_1().min_w_0().child(
                                        div()
                                            .w_full()
                                            .truncate()
                                            .text_size(sp(12.5))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text)
                                            .child(display.clone()),
                                    ),
                                )
                                .child(
                                    div()
                                        .w_full()
                                        .truncate()
                                        .font_family(".SystemUIFontMonospaced")
                                        .text_size(sp(10.5))
                                        .text_color(theme.text_tertiary)
                                        .child(email.clone()),
                                )
                                .when(selected, |element| {
                                    element.child(icon(
                                        "icons/check.svg",
                                        11.0,
                                        theme.text_tertiary,
                                    ))
                                })
                                .into_any_element()
                        })
                        .on_click(move |_, cx| {
                            let _ = weak.update(cx, |this, _| {
                                this.set_git_panel_identity(profile_id.clone());
                            });
                        }),
                    );
                }
                items.push(MenuItem::Separator);
                items.push(
                    MenuItem::new(tr!("git_panel.manage_identities"), {
                        let weak = weak.clone();
                        move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.open_settings_page(SettingsPage::Git, cx);
                            });
                        }
                    })
                    .icon("icons/settings.svg"),
                );
                items
            },
        );

        div()
            .id("git-panel-identity-bar")
            .h(px(30.0))
            .flex_none()
            .px(px(10.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .border_b_1()
            .border_color(theme.border)
            .child(menu)
            .when(applied_dot.is_some(), |bar| {
                bar.child(
                    div()
                        .text_size(sp(9.5))
                        .text_color(theme.text_ghost)
                        .child(tr!("git_panel.identity_override")),
                )
            })
    }

    /// The commit bar footer — port of tide's CommitBar: summary + ✨,
    /// description, amend toggle / staged counter / primary action, and the
    /// attribution trailer preview.
    fn render_git_panel_commit_bar(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.ensure_git_panel_commit_draft(window, cx);
        let theme = Theme::current(cx);
        let Some(draft) = self.git_panel_commit_draft() else {
            return div().id("git-panel-commit-bar");
        };
        let summary = draft.summary.clone();
        let description = draft.description.clone();
        let amend = draft.amend;
        let summary_text = draft.summary.read(cx).content().trim().to_owned();
        let busy = self.git_panel.busy.is_some();
        let generating = self.git_panel.generating_message;
        let flash_sha = self.git_panel.flash_sha.clone();
        let has_conflicts =
            matches!(&self.git_panel.conflicts, Query::Ready(conflicts) if !conflicts.is_empty());
        let (staged_count, staged_add, staged_del, has_changes) = match &self.git_panel.status {
            Query::Ready(changes) => changes.iter().fold(
                (0usize, 0u64, 0u64, false),
                |(count, add, del, _), change| {
                    (
                        count + usize::from(change.staged),
                        add + change.additions * u64::from(change.staged),
                        del + change.deletions * u64::from(change.staged),
                        true,
                    )
                },
            ),
            Query::Pending | Query::Missing(_) => (0, 0, 0, false),
        };
        let trailer = self.git_panel.trailer.clone();
        let can_submit =
            !summary_text.is_empty() && !has_conflicts && !busy && (amend || has_changes);

        let generate_focus = self.transcript_control_focus("git-commit-generate", cx);
        let generate = div()
            .id("git-commit-generate")
            .track_focus(&generate_focus)
            .tab_index(0)
            .size(px(22.0))
            .flex_none()
            .rounded(px(6.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .when(!generating, |button| {
                button.hover(|style| style.bg(theme.overlay))
            })
            .child(if generating {
                motion::spin(icon("icons/loader-circle.svg", 13.0, theme.accent)).into_any_element()
            } else {
                icon("icons/sparkle.svg", 13.0, theme.text_tertiary).into_any_element()
            })
            .when(!generating, |button| {
                button.on_activation(cx, move |this, _, cx| {
                    this.generate_git_panel_commit_message(cx);
                })
            });

        let summary_row = div()
            .key_context("GitPanelCommitSummary")
            .on_action(
                cx.listener(|this, _: &super::git_panel::ConfirmGitPanelCommit, _, cx| {
                    this.confirm_git_panel_commit(cx);
                }),
            )
            .flex()
            .items_center()
            .gap(px(4.0))
            .min_w_0()
            .child(div().flex_1().min_w_0().child(summary))
            .child(generate);

        let amend_focus = self.transcript_control_focus("git-commit-amend", cx);
        let amend_button = div()
            .id("git-commit-amend")
            .track_focus(&amend_focus)
            .tab_index(0)
            .h(px(22.0))
            .px(px(7.0))
            .rounded(px(6.0))
            .flex_none()
            .flex()
            .items_center()
            .cursor_default()
            .text_size(sp(11.0))
            .font_weight(if amend {
                FontWeight::MEDIUM
            } else {
                FontWeight::NORMAL
            })
            .text_color(if amend {
                theme.danger
            } else {
                theme.text_tertiary
            })
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .when(!amend, |button| {
                button.hover(|style| style.bg(theme.overlay).text_color(theme.text))
            })
            .when(amend, |button| button.bg(theme.danger.opacity(0.12)))
            .child(tr!("git_panel.amend"))
            .on_activation(cx, move |this, _, cx| {
                this.toggle_git_panel_amend(cx);
            });

        let primary_focus = self.transcript_control_focus("git-commit-primary", cx);
        let primary_label = if flash_sha.is_some() {
            String::new()
        } else if busy {
            String::new()
        } else if amend {
            tr!("git_panel.amend_last_commit")
        } else if staged_count > 0 {
            tr!("git_panel.commit")
        } else {
            tr!("git_panel.stage_all_and_commit")
        };
        let primary_enabled = can_submit && flash_sha.is_none();
        let primary = div()
            .id("git-commit-primary")
            .track_focus(&primary_focus)
            .when(primary_enabled, |button| button.tab_index(0))
            .h(px(24.0))
            .px(px(9.0))
            .rounded(px(7.0))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(5.0))
            .cursor_default()
            .text_size(sp(11.5))
            .font_weight(FontWeight::MEDIUM)
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .when(primary_enabled, |button| {
                if amend {
                    button.bg(theme.danger).text_color(theme.text)
                } else {
                    button.bg(theme.accent).text_color(theme.text)
                }
            })
            .when(!primary_enabled, |button| {
                button.bg(theme.overlay_strong).text_color(theme.text_ghost)
            })
            .child(if let Some(sha) = &flash_sha {
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(icon("icons/check.svg", 12.0, theme.success))
                    .child(
                        div()
                            .font_family(".SystemUIFontMonospaced")
                            .child(single_line_label(sha)),
                    )
                    .into_any_element()
            } else if busy {
                motion::spin(icon("icons/loader-circle.svg", 12.0, theme.text_secondary))
                    .into_any_element()
            } else {
                icon(
                    "icons/git-commit-horizontal.svg",
                    12.0,
                    if primary_enabled {
                        theme.text
                    } else {
                        theme.text_ghost
                    },
                )
                .into_any_element()
            })
            .when(!primary_label.is_empty(), |button| {
                button.child(div().child(primary_label))
            })
            .when(primary_enabled, |button| {
                button.on_activation(cx, move |this, _, cx| {
                    this.confirm_git_panel_commit(cx);
                })
            });

        div()
            .id("git-panel-commit-bar")
            .flex_none()
            .px(px(10.0))
            .py(px(8.0))
            .flex()
            .flex_col()
            .gap(px(5.0))
            .min_w_0()
            .border_t_1()
            .border_color(theme.border)
            .child(summary_row)
            .child(description)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .min_w_0()
                    .child(amend_button)
                    .child(
                        div()
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .font_family(".SystemUIFontMonospaced")
                            .text_size(sp(10.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("git_panel.staged_count", count = staged_count))
                            .child(
                                div()
                                    .text_color(theme.success)
                                    .child(format!("+{staged_add}")),
                            )
                            .child(
                                div()
                                    .text_color(theme.danger)
                                    .child(format!("−{staged_del}")),
                            ),
                    )
                    .child(div().flex_1())
                    .child(primary),
            )
            .when_some(
                if has_conflicts {
                    Some(tr!("git_panel.conflicts_hint"))
                } else {
                    trailer.filter(|_| true)
                },
                |bar, line| {
                    bar.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .min_w_0()
                            .text_size(sp(10.5))
                            .text_color(if has_conflicts {
                                theme.danger
                            } else {
                                theme.text_ghost
                            })
                            .child(icon(
                                if has_conflicts {
                                    "icons/triangle-alert.svg"
                                } else {
                                    "icons/corner-down-right.svg"
                                },
                                10.0,
                                if has_conflicts {
                                    theme.danger
                                } else {
                                    theme.text_ghost
                                },
                            ))
                            .child(div().min_w_0().truncate().child(single_line_label(&line))),
                    )
                },
            )
    }

    /// Branch toolbar: the shared branch picker popover over the branch chip
    /// (the same browse + create + keyboard flow the composer uses), the
    /// ahead/behind pill when an upstream exists, fetch/pull/push icon
    /// buttons, and refresh.
    fn render_git_panel_branch_bar(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let branch = match &self.git_panel.branch_info {
            Query::Ready(info) => info.branch.clone(),
            _ => None,
        };
        let ahead_behind = self.git_panel.ahead_behind.clone();
        let refreshing = self.git_panel.refresh_in_flight;
        let busy = self.git_panel.busy;

        let mut bar = div()
            .id("git-panel-branch-bar")
            .h(px(32.0))
            .flex_none()
            .px(px(10.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .border_b_1()
            .border_color(theme.border);
        if let Some(branch_label) = branch
            && !branch_label.is_empty()
        {
            let cwd = self.selected_workspace_path().map(Path::to_path_buf);
            let chip: AnyElement = match cwd {
                None => static_chip(&branch_label, &theme).into_any_element(),
                Some(cwd) => {
                    // The picker reads the sidebar's shared `InspectBranches`
                    // snapshot; a miss starts the fetch and falls back to the
                    // static chip until it lands.
                    let fallback_label = branch_label.clone();
                    let static_label = branch_label.clone();
                    self.render_branch_picker(
                        BranchPickerContext {
                            menu_id: SharedString::from("git-panel-branch"),
                            workspace_path: cwd,
                            planned_worktree: false,
                            surface: BranchPickerSurface::GitPanel,
                        },
                        busy.is_none() && !self.branch_operation_pending,
                        move |snapshot| {
                            snapshot
                                .current
                                .clone()
                                .unwrap_or_else(|| fallback_label.clone())
                        },
                        move |open, _| {
                            MenuChip::new("git-panel-branch")
                                .icon("icons/git-branch.svg", theme.text_tertiary)
                                .label(branch_label.clone())
                                .caret(true)
                                .height(px(22.0))
                                .background(theme.surface)
                                .max_w(px(180.0))
                                .disabled(busy.is_some())
                                .selected(open)
                        },
                        MenuAlign::BelowLeft,
                        cx,
                    )
                    .unwrap_or_else(|| static_chip(&static_label, &theme).into_any_element())
                }
            };
            bar = bar.child(chip);
        }
        if let Some(ahead_behind) = ahead_behind
            && ahead_behind.ahead + ahead_behind.behind > 0
        {
            bar = bar.child(
                div()
                    .id("git-panel-ahead-behind")
                    .flex_none()
                    .h(px(18.0))
                    .px(px(5.0))
                    .rounded(px(9.0))
                    .bg(theme.overlay)
                    .flex()
                    .items_center()
                    .gap(px(3.0))
                    .text_size(sp(10.5))
                    .font_family(".SystemUIFontMonospaced")
                    .child(
                        div()
                            .text_color(theme.text_tertiary)
                            .child(format!("↓{}", ahead_behind.behind)),
                    )
                    .child(
                        div()
                            .text_color(theme.text_tertiary)
                            .child(format!("↑{}", ahead_behind.ahead)),
                    ),
            );
        }
        bar = bar.child(div().flex_1());
        // One menu for every toolbar action: refresh, the three remote ops,
        // and — when a checkpoint-ready turn exists — the last-turn review.
        // Keeping the bar to the branch chip, ahead/behind, and this menu
        // leaves room for the branch label on narrow panels.
        let review_source = self.latest_review_turn_source();
        let actions_handle = self.menu_handle("git-panel-actions", cx);
        let weak = cx.entity().downgrade();
        let remote_busy = busy.is_some();
        let refreshing_now = refreshing;
        bar.child(dropdown_menu(
            div()
                .id("git-panel-actions")
                .h(px(24.0))
                .w(px(28.0))
                .flex_none()
                .rounded(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .when(actions_handle.is_open(), |button| button.bg(theme.overlay))
                .hover(|button| button.bg(theme.overlay))
                .child(if refreshing_now {
                    motion::spin(icon("icons/rotate-cw.svg", 12.0, theme.accent)).into_any_element()
                } else {
                    icon("icons/ellipsis.svg", 12.0, theme.text_tertiary).into_any_element()
                })
                .tooltip(|window, cx| {
                    Tooltip::new(tr!("git_panel.more_actions")).build(window, cx)
                }),
            "git-panel-actions-menu",
            &actions_handle,
            MenuAlign::BelowRight,
            move |_| {
                let refresh = MenuItem::new(tr!("git_panel.refresh"), {
                    let weak = weak.clone();
                    move |_, cx| {
                        let _ = weak.update(cx, |this, cx| this.refresh_git_panel(cx));
                    }
                })
                .icon("icons/rotate-cw.svg")
                .disabled(refreshing_now);
                let fetch = MenuItem::new(tr!("git_panel.fetch"), {
                    let weak = weak.clone();
                    move |_, cx| {
                        let _ = weak
                            .update(cx, |this, cx| this.run_git_panel_remote("fetch", true, cx));
                    }
                })
                .icon("icons/download.svg")
                .disabled(remote_busy);
                let pull = MenuItem::new(tr!("git_panel.pull"), {
                    let weak = weak.clone();
                    move |_, cx| {
                        let _ = weak
                            .update(cx, |this, cx| this.run_git_panel_remote("pull", false, cx));
                    }
                })
                .icon("icons/arrow-down.svg")
                .disabled(remote_busy);
                let push = MenuItem::new(tr!("git_panel.push"), {
                    let weak = weak.clone();
                    move |_, cx| {
                        let _ = weak.update(cx, |this, cx| this.run_git_panel_push(cx));
                    }
                })
                .icon("icons/cloud-upload.svg")
                .disabled(remote_busy);
                let mut items = vec![refresh, MenuItem::Separator, fetch, pull, push];
                if let Some(source) = review_source {
                    items.push(MenuItem::Separator);
                    items.push(
                        MenuItem::new(tr!("diff.source_last_turn"), {
                            let weak = weak.clone();
                            move |_, cx| {
                                let _ = weak.update(cx, |this, cx| {
                                    this.open_last_turn_review(source.clone(), cx)
                                });
                            }
                        })
                        .icon("icons/file-diff.svg"),
                    );
                }
                items
            },
        ))
    }

    /// The summary + bulk row: total numstat, the tree/list toggle, and the
    /// bulk action menu (stage/unstage/discard/stash) with its armed
    /// two-step discard confirmation.
    fn render_git_panel_summary_row(
        &mut self,
        total_additions: u64,
        total_deletions: u64,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let busy = self.git_panel.busy.is_some();
        let tree_mode = self.git_panel.tree_mode;
        let armed = self.git_panel.confirm_discard_all;
        let stash_count = match &self.git_panel.stashes {
            Query::Ready(stashes) => stashes.len(),
            Query::Pending | Query::Missing(_) => 0,
        };

        let toggle_focus = self.transcript_control_focus("git-panel-view-toggle", cx);
        let view_toggle = div()
            .id("git-panel-view-toggle")
            .track_focus(&toggle_focus)
            .tab_index(0)
            .size(px(24.0))
            .rounded(px(6.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .hover(|style| style.bg(theme.overlay))
            .child(icon(
                if tree_mode {
                    "icons/list.svg"
                } else {
                    "icons/folder-tree.svg"
                },
                13.0,
                theme.text_tertiary,
            ))
            .tooltip({
                let tooltip = if tree_mode {
                    tr!("git_panel.list_view")
                } else {
                    tr!("git_panel.tree_view")
                };
                move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx)
            })
            .on_activation(cx, move |this, _, cx| {
                this.set_git_panel_tree_mode(!tree_mode, cx);
            });

        let right_side: AnyElement = if armed {
            let confirm_focus = self.transcript_control_focus("git-panel-discard-all-confirm", cx);
            div()
                .id("git-panel-discard-all-confirm")
                .track_focus(&confirm_focus)
                .tab_index(0)
                .h(px(22.0))
                .px(px(7.0))
                .rounded(px(6.0))
                .border_1()
                .border_color(theme.danger)
                .bg(theme.danger.opacity(0.12))
                .flex()
                .items_center()
                .gap(px(4.0))
                .cursor_default()
                .text_size(sp(11.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.danger)
                .focus_visible(|style| style.border_2().border_color(theme.danger))
                .child(tr!("common.confirm"))
                .on_activation(cx, |this, _, cx| {
                    this.git_panel.confirm_discard_all = false;
                    this.run_git_panel_bulk_op("restore-all", cx);
                })
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    if this.git_panel.confirm_discard_all {
                        this.git_panel.confirm_discard_all = false;
                        cx.notify();
                    }
                }))
                .into_any_element()
        } else {
            let handle = self.menu_handle("git-panel-bulk", cx);
            let weak = cx.entity().downgrade();
            let stash_count = stash_count;
            dropdown_menu(
                MenuChip::new("git-panel-bulk")
                    .label(tr!("git_panel.stage_all"))
                    .height(px(24.0))
                    .background(theme.surface)
                    .selected(handle.is_open())
                    .disabled(busy),
                "git-panel-bulk-menu",
                &handle,
                MenuAlign::BelowRight,
                move |_| {
                    let stage = bulk_item(
                        &weak,
                        "icons/plus.svg",
                        tr!("git_panel.stage_all"),
                        "stage-all",
                        busy,
                    );
                    let unstage = bulk_item(
                        &weak,
                        "icons/x.svg",
                        tr!("git_panel.unstage_all"),
                        "unstage-all",
                        busy,
                    );
                    let discard = MenuItem::new(tr!("git_panel.discard_all"), {
                        let weak = weak.clone();
                        move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.git_panel.confirm_discard_all = true;
                                cx.notify();
                            });
                        }
                    })
                    .icon("icons/rewind.svg");
                    let stash = bulk_item(
                        &weak,
                        "icons/package.svg",
                        tr!("git_panel.stash_all"),
                        "stash",
                        busy,
                    );
                    let stash_pop = MenuItem::new(tr!("git_panel.stash_pop"), {
                        let weak = weak.clone();
                        move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.run_git_panel_bulk_op("stash-pop", cx);
                            });
                        }
                    })
                    .icon("icons/package.svg")
                    .disabled(busy || stash_count == 0);
                    let view_stash = MenuItem::new(tr!("git_panel.view_stash"), {
                        let weak = weak.clone();
                        move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.git_panel.stash_dialog_open = true;
                                cx.notify();
                            });
                        }
                    })
                    .icon("icons/eye.svg");
                    vec![
                        stage,
                        unstage,
                        discard,
                        MenuItem::Separator,
                        stash,
                        stash_pop,
                        view_stash,
                    ]
                },
            )
            .into_any_element()
        };

        div()
            .id("git-panel-summary-row")
            .h(px(34.0))
            .flex_none()
            .px(px(10.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .id("git-panel-summary-counts")
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(11.5))
                    .when(total_additions + total_deletions > 0, |counts| {
                        counts
                            .child(
                                div()
                                    .text_color(theme.success)
                                    .child(format!("+{total_additions}")),
                            )
                            .child(
                                div()
                                    .text_color(theme.danger)
                                    .child(format!("−{total_deletions}")),
                            )
                    }),
            )
            .child(div().flex_1())
            .child(view_toggle)
            .child(right_side)
    }

    /// Dispatches one of the panel's bulk operations by its wire name.
    pub(super) fn run_git_panel_bulk_op(&mut self, op: &'static str, cx: &mut Context<Self>) {
        let Some(cwd) = self
            .selected_workspace_path()
            .map(std::path::Path::to_path_buf)
        else {
            return;
        };
        self.run_git_panel_op(
            op,
            client::WorkspaceOperation::GitBulk {
                cwd,
                op: op.to_owned(),
                message: None,
            },
            cx,
        );
    }

    /// The selected-file diff sub-view: back header (basename bold, its
    /// directory, a staged/unstaged badge, numstat) over the shared
    /// unified-diff list with gap-driven context escalation.
    fn render_git_file_diff_sub_view(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let Some(selected) = self.git_panel.selected_file_diff.as_ref() else {
            return div();
        };
        let path = selected.path.clone();
        let staged = selected.staged;
        let loading = matches!(selected.hunks, Query::Pending | Query::Missing(_))
            && selected.snapshot.is_none();
        let snapshot = selected.snapshot.clone();
        let (additions, deletions) = snapshot
            .as_ref()
            .map_or((0, 0), |snapshot| (snapshot.additions, snapshot.deletions));

        let basename = path.rsplit('/').next().unwrap_or(&path).to_owned();
        let directory = path.strip_suffix(&basename).unwrap_or_default().to_owned();
        let badge = if staged {
            tr!("git_panel.staged")
        } else {
            tr!("git_panel.unstaged")
        };

        let back_focus = self.transcript_control_focus("git-file-diff-back", cx);
        let header = div()
            .h(px(42.0))
            .flex_none()
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .id("git-file-diff-back")
                    .track_focus(&back_focus)
                    .tab_index(0)
                    .size(px(26.0))
                    .rounded(px(6.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon("icons/arrow-left.svg", 15.0, theme.text_secondary))
                    .tooltip(|window, cx| Tooltip::new(tr!("git_panel.back")).build(window, cx))
                    .on_activation(cx, |this, _, cx| {
                        this.close_git_panel_file_diff(cx);
                    }),
            )
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id("git-file-diff-path")
                            .min_w_0()
                            .truncate()
                            .text_size(sp(12.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .tooltip(Tooltip::text(path.clone()))
                            .child(basename),
                    )
                    .when(!directory.is_empty(), |column| {
                        column.child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(sp(10.5))
                                .text_color(theme.text_tertiary)
                                .child(directory),
                        )
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .h(px(18.0))
                    .px(px(6.0))
                    .rounded(px(5.0))
                    .bg(theme.overlay)
                    .flex()
                    .items_center()
                    .text_size(sp(10.5))
                    .text_color(theme.text_secondary)
                    .child(badge),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(sp(12.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_color(theme.success)
                    .child(format!("+{additions}")),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(sp(12.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_color(theme.danger)
                    .child(format!("\u{2212}{deletions}")),
            );

        let body = if loading {
            self.render_git_panel_loading_rows(&theme)
                .into_any_element()
        } else if let Some(snapshot) = snapshot {
            self.render_right_panel_unified_diff(snapshot, true, cx)
        } else {
            self.render_right_panel_empty_message(
                tr!("diff.no_changes"),
                tr!("diff.no_changes_description"),
                cx,
            )
            .into_any_element()
        };

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
    }

    /// The last-turn agent-review sub-view: back header with the turn label
    /// and numstat over the shared unified-diff list with local gap
    /// expansion.
    fn render_git_last_turn_review(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let Some(review) = self.git_panel.last_turn_review.as_ref() else {
            return div();
        };
        let label = self.last_turn_review_label(review.source);
        let snapshot = review.snapshot.clone();
        let loading = review.loading;
        let error = review.error.clone();
        let (additions, deletions) = snapshot
            .as_ref()
            .map_or((0, 0), |snapshot| (snapshot.additions, snapshot.deletions));

        let back_focus = self.transcript_control_focus("git-review-back", cx);
        let mut header = div()
            .h(px(42.0))
            .flex_none()
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .id("git-review-back")
                    .track_focus(&back_focus)
                    .tab_index(0)
                    .size(px(26.0))
                    .rounded(px(6.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon("icons/arrow-left.svg", 15.0, theme.text_secondary))
                    .tooltip(|window, cx| Tooltip::new(tr!("git_panel.back")).build(window, cx))
                    .on_activation(cx, |this, _, cx| {
                        this.close_last_turn_review(cx);
                    }),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .text_size(sp(12.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text_secondary)
                    .child(label),
            );
        if let Some(error) = error.as_ref() {
            header = header.child(
                div()
                    .id("git-review-error")
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .text_size(sp(11.0))
                    .text_color(theme.danger)
                    .tooltip(Tooltip::text(error.clone()))
                    .child(single_line_label(error)),
            );
        }
        let header = header
            .child(
                div()
                    .flex_none()
                    .text_size(sp(12.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_color(theme.success)
                    .child(format!("+{additions}")),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(sp(12.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_color(theme.danger)
                    .child(format!("\u{2212}{deletions}")),
            )
            .when(loading, |row| {
                row.child(motion::spin(icon(
                    "icons/loader-circle.svg",
                    12.0,
                    theme.text_tertiary,
                )))
            });

        let body = if let Some(snapshot) = snapshot {
            self.render_right_panel_unified_diff(snapshot, false, cx)
        } else if let Some(error) = error {
            self.render_right_panel_empty_message(tr!("diff.unavailable"), error, cx)
                .into_any_element()
        } else {
            self.render_git_panel_loading_rows(&theme)
                .into_any_element()
        };

        div()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .child(header)
            .child(body)
    }

    /// Loading placeholders while the first status query is in flight.
    fn render_git_panel_loading_rows(&self, theme: &Theme) -> Div {
        let mut list = div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .px(px(12.0))
            .py(px(8.0));
        for index in 0..4 {
            list = list.child(
                div()
                    .h(px(16.0))
                    .my(px(5.0))
                    .rounded(px(4.0))
                    .bg(theme.overlay)
                    .w(gpui::relative((0.55 + index as f32 * 0.1).clamp(0.0, 0.98))),
            );
        }
        list
    }

    /// One row of the Changes tab's virtualized list, dispatched by kind.
    fn render_git_changes_row(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let Some(row) = self.git_panel_changes_rows.borrow().get(index).cloned() else {
            return div().h(px(28.0)).into_any_element();
        };
        match row {
            GitChangesRow::ConflictHeader { count } => self.render_git_conflict_header(count, cx),
            GitChangesRow::ConflictFile { index } => self.render_git_conflict_row(index, cx),
            GitChangesRow::SectionHeader { section, count } => {
                self.render_git_section_header(section, count, cx)
            }
            GitChangesRow::Directory {
                key,
                name,
                depth,
                file_count,
            } => self.render_git_directory_row(key, name, depth, file_count, cx),
            GitChangesRow::File {
                section,
                index,
                depth,
                show_path,
            } => self.render_git_changed_file_row(section, index, depth, show_path, cx),
        }
    }

    /// The danger-tinted header of the conflict band.
    fn render_git_conflict_header(&self, count: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        div()
            .w_full()
            .h(px(28.0))
            .px(px(10.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .bg(theme.danger.opacity(0.06))
            .border_b_1()
            .border_color(theme.danger.opacity(0.3))
            .child(icon("icons/alert.svg", 13.0, theme.danger))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(sp(11.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.danger)
                    .child(tr!("git_panel.conflicts", count = count)),
            )
            .into_any_element()
    }

    /// One conflicted path with its resolve actions.
    fn render_git_conflict_row(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let Some(conflict) = git_conflict_at(&self.git_panel.conflicts, index) else {
            return div().h(px(28.0)).into_any_element();
        };
        let state = conflict.state.replace('-', " ");
        let mut row = div()
            .w_full()
            .h(px(28.0))
            .px(px(10.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .bg(theme.danger.opacity(0.04))
            .hover(|style| style.bg(theme.danger.opacity(0.09)))
            .child(
                div()
                    .id(SharedString::from(format!("git-conflict-path-{index}")))
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(11.0))
                    .text_color(theme.text_secondary)
                    .tooltip(Tooltip::text(conflict.path.clone()))
                    .child(conflict.path.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(sp(10.0))
                    .text_color(theme.text_tertiary)
                    .child(single_line_label(&state)),
            );
        for (side_key, label) in [
            ("ours", tr!("git_panel.use_ours")),
            ("theirs", tr!("git_panel.use_theirs")),
        ] {
            let focus =
                self.transcript_control_focus(format!("git-conflict-{index}-{side_key}"), cx);
            let path = conflict.path.clone();
            let side = side_key.to_owned();
            row = row.child(
                div()
                    .id(SharedString::from(format!(
                        "git-conflict-{index}-{side_key}"
                    )))
                    .track_focus(&focus)
                    .tab_index(0)
                    .h(px(20.0))
                    .px(px(6.0))
                    .rounded(px(5.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .flex_none()
                    .flex()
                    .items_center()
                    .cursor_default()
                    .text_size(sp(10.5))
                    .text_color(theme.text_secondary)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay).text_color(theme.text))
                    .child(label)
                    .on_activation(cx, move |this, _, cx| {
                        let Some(cwd) = this
                            .selected_workspace_path()
                            .map(std::path::Path::to_path_buf)
                        else {
                            return;
                        };
                        this.run_git_panel_op(
                            "resolve",
                            client::WorkspaceOperation::GitResolveFile {
                                cwd,
                                path: path.clone(),
                                side: side.clone(),
                            },
                            cx,
                        );
                    }),
            );
        }
        row.into_any_element()
    }

    /// A "Staged" / "Changes" collapsible header with its bulk icon actions.
    fn render_git_section_header(
        &self,
        section: GitFileSection,
        count: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let open = match section {
            GitFileSection::Staged => self.git_panel.staged_open,
            GitFileSection::Unstaged => self.git_panel.unstaged_open,
        };
        let label = match section {
            GitFileSection::Staged => tr!("git_panel.staged"),
            GitFileSection::Unstaged => tr!("git_panel.unstaged"),
        };
        let section_id = section.key();
        let header_focus =
            self.transcript_control_focus(format!("git-section-header-{section_id}"), cx);

        let mut actions = div().flex().flex_none().items_center().gap(px(2.0));
        match section {
            GitFileSection::Staged => {
                let focus = self.transcript_control_focus("git-section-unstage-all", cx);
                actions = actions.child(
                    div()
                        .id("git-section-unstage-all")
                        .track_focus(&focus)
                        .tab_index(0)
                        .size(px(22.0))
                        .rounded(px(5.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_default()
                        .focus_visible(|style| style.border_1().border_color(theme.accent))
                        .hover(|style| style.bg(theme.overlay))
                        .child(icon("icons/x.svg", 12.0, theme.text_tertiary))
                        .tooltip(|window, cx| {
                            Tooltip::new(tr!("git_panel.unstage_all")).build(window, cx)
                        })
                        .on_activation(cx, |this, _, cx| {
                            this.run_git_panel_bulk_op("unstage-all", cx);
                        }),
                );
            }
            GitFileSection::Unstaged => {
                let discard_focus = self.transcript_control_focus("git-section-discard-all", cx);
                actions = actions.child(
                    div()
                        .id("git-section-discard-all")
                        .track_focus(&discard_focus)
                        .tab_index(0)
                        .size(px(22.0))
                        .rounded(px(5.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_default()
                        .focus_visible(|style| style.border_1().border_color(theme.accent))
                        .hover(|style| style.bg(theme.overlay))
                        .child(icon("icons/rewind.svg", 12.0, theme.text_tertiary))
                        .tooltip(|window, cx| {
                            Tooltip::new(tr!("git_panel.discard_all")).build(window, cx)
                        })
                        .on_activation(cx, |this, _, cx| {
                            this.git_panel.confirm_discard_all = true;
                            cx.notify();
                        }),
                );
                let stage_focus = self.transcript_control_focus("git-section-stage-all", cx);
                actions = actions.child(
                    div()
                        .id("git-section-stage-all")
                        .track_focus(&stage_focus)
                        .tab_index(0)
                        .size(px(22.0))
                        .rounded(px(5.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_default()
                        .focus_visible(|style| style.border_1().border_color(theme.accent))
                        .hover(|style| style.bg(theme.overlay))
                        .child(icon("icons/plus.svg", 12.0, theme.text_tertiary))
                        .tooltip(|window, cx| {
                            Tooltip::new(tr!("git_panel.stage_all")).build(window, cx)
                        })
                        .on_activation(cx, |this, _, cx| {
                            this.run_git_panel_bulk_op("stage-all", cx);
                        }),
                );
            }
        }

        div()
            .w_full()
            .h(px(28.0))
            .pr(px(8.0))
            .flex()
            .items_center()
            .min_w_0()
            .child(
                div()
                    .id(SharedString::from(format!(
                        "git-section-header-{section_id}"
                    )))
                    .track_focus(&header_focus)
                    .tab_index(0)
                    .min_w_0()
                    .flex_1()
                    .h(px(28.0))
                    .pl(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon(
                        if open {
                            "icons/chevron-down.svg"
                        } else {
                            "icons/chevron-right.svg"
                        },
                        10.0,
                        theme.text_ghost,
                    ))
                    .child(
                        div()
                            .truncate()
                            .text_size(sp(13.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_secondary)
                            .child(label),
                    )
                    .child(
                        div()
                            .flex_none()
                            .min_w(px(16.0))
                            .h(px(15.0))
                            .px(px(4.0))
                            .rounded(px(7.0))
                            .bg(theme.accent.opacity(0.1))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(sp(10.0))
                            .text_color(theme.accent)
                            .child(count.to_string()),
                    )
                    .on_activation(cx, move |this, _, cx| {
                        this.toggle_git_panel_section(section, cx);
                    }),
            )
            .child(actions)
            .into_any_element()
    }

    /// A tree-mode directory row: chevron, folder, name, and file count.
    fn render_git_directory_row(
        &self,
        key: String,
        name: String,
        depth: u32,
        file_count: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let open = !self.git_panel.closed_dirs.contains(&key);
        let focus =
            self.transcript_control_focus(format!("git-dir-{}", key.replace('/', "\\")), cx);
        div()
            .w_full()
            .h(px(28.0))
            .pr(px(8.0))
            .relative()
            .flex()
            .items_center()
            // Tree rows share the section header's 10px leading inset so the
            // depth-0 chevron lines up with the header chevron and the flat
            // list's status-letter column; deeper rows indent by 14px a level.
            // One vertical guide per ancestor level, the session-tree idiom:
            // 1px lines at each indent step spanning the row, connecting
            // across rows into continuous rails.
            .children((1..=depth).map(|k| {
                div()
                    .absolute()
                    .left(px(10.0 + k as f32 * 14.0 - 6.0))
                    .top_0()
                    .bottom_0()
                    .w(px(1.0))
                    .bg(theme.border.opacity(0.6))
            }))
            .child(
                div()
                    .id(SharedString::from(format!(
                        "git-dir-{}",
                        key.replace('/', "\\")
                    )))
                    .track_focus(&focus)
                    .tab_index(0)
                    .min_w_0()
                    .flex_1()
                    .h(px(24.0))
                    .pl(px(10.0 + depth as f32 * 14.0))
                    .pr(px(6.0))
                    .my(px(2.0))
                    .rounded(px(5.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon(
                        if open {
                            "icons/chevron-down.svg"
                        } else {
                            "icons/chevron-right.svg"
                        },
                        10.0,
                        theme.text_ghost,
                    ))
                    .child(icon(
                        if open {
                            "icons/folder-open.svg"
                        } else {
                            "icons/folder.svg"
                        },
                        13.0,
                        theme.text_tertiary,
                    ))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_size(sp(13.0))
                            .text_color(theme.text_secondary)
                            .child(name),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(sp(10.0))
                            .text_color(theme.text_ghost)
                            .child(file_count.to_string()),
                    )
                    .on_activation(cx, move |this, _, cx| {
                        this.toggle_git_panel_directory(key.clone(), cx);
                    }),
            )
            .into_any_element()
    }

    /// The ChangedFileRow port: status letter, basename + truncated
    /// directory, numstat chips, and the stage/discard actions.
    fn render_git_changed_file_row(
        &self,
        section: GitFileSection,
        index: usize,
        depth: u32,
        show_path: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        let Some(change) = git_change_at(&self.git_panel.status, index) else {
            return div().h(px(28.0)).into_any_element();
        };
        let (letter, letter_color) = match change.status.as_str() {
            "added" => ("A", theme.success),
            "deleted" => ("D", theme.danger),
            "untracked" => ("U", theme.text_secondary),
            "renamed" => ("R", theme.warning),
            _ => ("M", theme.accent),
        };
        let basename = change
            .path
            .rsplit('/')
            .next()
            .unwrap_or(&change.path)
            .to_owned();
        let directory = change
            .path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_owned())
            .unwrap_or_default();
        let staged = change.staged;
        let row_id = format!("git-file-{}-{}", section.key(), change.path);

        let mut row = div()
            .id(SharedString::from(row_id.clone()))
            .w_full()
            .h(px(28.0))
            .pl(px(10.0 + depth as f32 * 14.0))
            .pr(px(6.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .hover(|style| style.bg(theme.overlay));
        if self
            .git_panel
            .selected_file_diff
            .as_ref()
            .is_some_and(|selected| selected.path == change.path && selected.staged == staged)
        {
            row = row.bg(theme.accent.opacity(0.08));
        }
        row = row
            .child(
                div()
                    .flex_none()
                    .w(px(14.0))
                    .text_center()
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(11.0))
                    .font_weight(FontWeight::BOLD)
                    .text_color(letter_color)
                    .child(letter),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .items_baseline()
                    .gap(px(4.0))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_size(sp(13.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(basename.clone()),
                    )
                    .when(show_path && !directory.is_empty(), |row| {
                        row.child(
                            div()
                                .id(SharedString::from(format!("{row_id}-dir")))
                                .min_w_0()
                                .truncate()
                                .text_size(sp(10.5))
                                .text_color(theme.text_tertiary)
                                .tooltip(Tooltip::text(directory.clone()))
                                .child(crate::ui::text::middle_ellipsis(&directory, 32)),
                        )
                    }),
            );
        if change.additions > 0 || change.deletions > 0 {
            row = row.child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(3.0))
                    .font_family(".SystemUIFontMonospaced")
                    .text_size(sp(10.5))
                    .when(change.additions > 0, |chips| {
                        chips.child(
                            div()
                                .px(px(3.0))
                                .rounded(px(3.0))
                                .bg(theme.success.opacity(0.1))
                                .text_color(theme.success)
                                .child(format!("+{}", change.additions)),
                        )
                    })
                    .when(change.deletions > 0, |chips| {
                        chips.child(
                            div()
                                .px(px(3.0))
                                .rounded(px(3.0))
                                .bg(theme.danger.opacity(0.1))
                                .text_color(theme.danger)
                                .child(format!("−{}", change.deletions)),
                        )
                    }),
            );
        }

        // Discard (unstaged only) — armed per path, one click to confirm.
        if !staged {
            let armed = self.git_panel.confirm_discard_file.as_deref() == Some(&change.path);
            let focus = self.transcript_control_focus(format!("{row_id}-discard"), cx);
            let path = change.path.clone();
            row = row.child(
                div()
                    .id(SharedString::from(format!("{row_id}-discard")))
                    .track_focus(&focus)
                    .tab_index(0)
                    .h(px(20.0))
                    .flex_none()
                    .px(px(if armed { 6.0 } else { 0.0 }))
                    .rounded(px(5.0))
                    .when(armed, |button| {
                        button
                            .border_1()
                            .border_color(theme.danger)
                            .bg(theme.danger.opacity(0.12))
                    })
                    .flex()
                    .items_center()
                    .gap(px(3.0))
                    .cursor_default()
                    .text_size(sp(10.5))
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.danger.opacity(0.1)))
                    .child(icon(
                        "icons/rewind.svg",
                        12.0,
                        if armed {
                            theme.danger
                        } else {
                            theme.text_tertiary
                        },
                    ))
                    .when(armed, |button| {
                        button
                            .text_color(theme.danger)
                            .font_weight(FontWeight::MEDIUM)
                            .child(tr!("common.confirm"))
                    })
                    .tooltip(|window, cx| Tooltip::new(tr!("git_panel.discard")).build(window, cx))
                    .on_activation(cx, move |this, _, cx| {
                        if this.git_panel.confirm_discard_file.as_deref() == Some(&path) {
                            this.git_panel.confirm_discard_file = None;
                            let Some(cwd) = this
                                .selected_workspace_path()
                                .map(std::path::Path::to_path_buf)
                            else {
                                return;
                            };
                            this.run_git_panel_op(
                                "discard",
                                client::WorkspaceOperation::GitDiscardFile {
                                    cwd,
                                    path: path.clone(),
                                },
                                cx,
                            );
                        } else {
                            this.git_panel.confirm_discard_file = Some(path.clone());
                            cx.notify();
                        }
                    })
                    .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                        if this.git_panel.confirm_discard_file.take().is_some() {
                            cx.notify();
                        }
                    })),
            );
        }

        // Stage/unstage toggle.
        let toggle_focus = self.transcript_control_focus(format!("{row_id}-stage"), cx);
        let path = change.path.clone();
        let click_path = change.path.clone();
        let row_focus = self.transcript_control_focus(row_id.clone(), cx);
        let row = row
            .track_focus(&row_focus)
            .tab_index(0)
            .focus_visible(|style| style.bg(theme.accent.opacity(0.08)))
            .child(
                div()
                    .id(SharedString::from(format!("{row_id}-stage")))
                    .track_focus(&toggle_focus)
                    .tab_index(0)
                    .size(px(22.0))
                    .flex_none()
                    .rounded(px(5.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon(
                        if staged {
                            "icons/x.svg"
                        } else {
                            "icons/plus.svg"
                        },
                        12.0,
                        theme.text_tertiary,
                    ))
                    .tooltip({
                        let tooltip = if staged {
                            tr!("git_panel.unstage")
                        } else {
                            tr!("git_panel.stage")
                        };
                        move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx)
                    })
                    .on_activation(cx, move |this, _, cx| {
                        let Some(cwd) = this
                            .selected_workspace_path()
                            .map(std::path::Path::to_path_buf)
                        else {
                            return;
                        };
                        this.run_git_panel_op(
                            "stage",
                            client::WorkspaceOperation::GitStageFile {
                                cwd,
                                path: path.clone(),
                                stage: !staged,
                            },
                            cx,
                        );
                    }),
            )
            // Clicking the row away from its actions opens the file's diff;
            // the actions stop propagation, so they never reach here.
            .on_activation(cx, move |this, _, cx| {
                this.open_git_panel_file_diff(click_path.clone(), staged, cx);
            });
        // Tree leaves get the same per-ancestor vertical guides as directory
        // rows, on a relative wrapper so the absolute lines span the row.
        if show_path {
            row.into_any_element()
        } else {
            div()
                .relative()
                .w_full()
                .children((1..=depth).map(|k| {
                    div()
                        .absolute()
                        .left(px(10.0 + k as f32 * 14.0 - 6.0))
                        .top_0()
                        .bottom_0()
                        .w(px(1.0))
                        .bg(theme.border.opacity(0.6))
                }))
                .child(row)
                .into_any_element()
        }
    }

    pub(super) fn render_right_panel_empty_message(
        &self,
        title: String,
        description: String,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .pb(px(32.0))
            .child(
                div()
                    .text_size(sp(13.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(title),
            )
            .child(
                div()
                    .mt(px(6.0))
                    .max_w(px(300.0))
                    .text_center()
                    .text_size(sp(12.5))
                    .line_height(sp(17.0))
                    .text_color(theme.text_tertiary)
                    .child(description),
            )
    }

    /// Re-reads whichever workspace surface is on screen.
    pub(super) fn refresh_workspace_surfaces(&mut self, cx: &mut Context<Self>) {
        match self.active_right_panel_surface() {
            Some(RightPanelSurface::Git) => self.refresh_git_panel(cx),
            Some(RightPanelSurface::Files | RightPanelSurface::File(_)) => {
                self.refresh_right_panel_working_tree(cx)
            }
            _ => {}
        }
    }

    /// Re-walks the project's working tree.
    ///
    /// `read_dir` plus a `stat` per entry, recursively over expanded
    /// directories — filesystem I/O, so it runs on the background executor and
    /// the panel keeps drawing the previous listing until the result lands.
    /// Called when the tree's inputs change, never from a frame.
    fn refresh_right_panel_working_tree(&mut self, cx: &mut Context<Self>) {
        let Some(project_path) = self
            .selected_workspace_path()
            .map(std::path::Path::to_path_buf)
        else {
            self.right_panel_working_tree.clear();
            return;
        };
        // The tree on disk moves under us, and the expanded set may just have
        // changed, so a cached listing is only good until something asks again.
        self.working_trees.invalidate(&project_path);
        match self.working_trees.read(&project_path) {
            Query::Ready(entries) => self.right_panel_working_tree = (*entries).clone(),
            Query::Pending => {}
            Query::Missing(token) => {
                let expanded = self.right_panel_expanded_paths.clone();
                let workspace = client::WorkspaceClient::new(self.daemon.client());
                cx.spawn(async move |tide, cx| {
                    let entries = cx
                        .background_executor()
                        .spawn({
                            let path = project_path.clone();
                            async move {
                                match workspace.request(client::WorkspaceOperation::ListTree {
                                    root: path,
                                    expanded_paths: expanded.into_iter().collect(),
                                }) {
                                    Ok(client::WorkspaceResult::WorkingTree { entries }) => entries
                                        .into_iter()
                                        .map(|entry| WorkingTreeEntry {
                                            file_icon: (!entry.is_dir)
                                                .then(|| file_icon_for_name(&entry.name)),
                                            relative_path: entry.relative_path,
                                            absolute_path: entry.absolute_path,
                                            name: entry.name,
                                            is_dir: entry.is_dir,
                                            expanded: entry.expanded,
                                            depth: entry.depth,
                                        })
                                        .collect(),
                                    Ok(_) | Err(_) => Vec::new(),
                                }
                            }
                        })
                        .await;
                    tide.update(cx, |tide, cx| {
                        if tide.working_trees.fulfill(token, entries.clone())
                            && tide
                                .selected_workspace_path()
                                .is_some_and(|path| path == project_path)
                        {
                            tide.right_panel_working_tree = entries;
                            cx.notify();
                        }
                    })
                    .ok();
                })
                .detach();
            }
        }
    }

    fn latest_review_turn_source(&self) -> Option<ReviewDiffSource> {
        let session = self.selected_session()?;
        session
            .turns
            .iter()
            .rev()
            .find(|turn| {
                turn.turn_count > 0
                    && turn
                        .checkpoint
                        .as_ref()
                        .is_some_and(|checkpoint| checkpoint.status == CheckpointStatus::Ready)
            })
            .map(|turn| ReviewDiffSource::LastTurn {
                session_id: session.id,
                turn_id: turn.id,
                turn_count: turn.turn_count,
            })
    }

    fn last_turn_review_label(&self, source: ReviewDiffSource) -> String {
        match source {
            ReviewDiffSource::LastTurn { .. }
                if self.latest_review_turn_source() == Some(source) =>
            {
                tr!("diff.source_last_turn")
            }
            ReviewDiffSource::LastTurn { turn_count, .. } => {
                tr!("diff.source_turn", turn = turn_count)
            }
            _ => tr!("diff.source_last_turn"),
        }
    }
}
