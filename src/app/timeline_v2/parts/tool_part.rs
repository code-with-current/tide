//! The tool-part card header — tide's 26px anatomy (the shared header
//! geometry the static rows and the reasoning header also use):
//! `[status icon 20px] [display name] [description flex-1] [diff stat]
//! [failure X] [hover actions]`. Pure helpers answer which asset shows, how
//! the stat reads, and what the description column says; the renderer folds
//! them into an id'd row whose click the list attaches (it owns the `Tide`
//! context the toggle needs).

use super::super::{
    Status, ToolFamily, ToolLabel, TranscriptActions, bash_first_line, label_for, relative_display,
    status_color, tools_description, tools_dim, tools_rail, tools_title,
};
use super::diff_rows::{self, MAX_DIFF_ROWS};
use crate::app::components::activity_file_change_stats;
use crate::md;
use crate::model::{ActivityItem, ActivityKind};
use crate::theme::{Theme, sp};
use crate::ui::{icon, icon_button, motion};
use gpui::prelude::*;
use gpui::{
    AnyElement, ClipboardItem, Div, FontWeight, Hsla, MouseButton, SharedString, Stateful, div, px,
};
use std::path::Path;
use std::sync::Arc;

/// The part's disclosure id — tide's tool-block-id rule: the activity's
/// `source_id`, with the uuid standing in for source-less rows so every
/// header stays togglable.
pub(crate) fn disclosure_id(activity: &ActivityItem) -> String {
    activity
        .source_id
        .clone()
        .unwrap_or_else(|| activity.id.to_string())
}

// ── Shared header geometry ─────────────────────────────────────────────────
//
// The three header kinds (tool-card headers, static rows/group rows, the
// reasoning header) share one anatomy after the group-container removal, so
// the numbers live here once and every renderer reads them: same height,
// same horizontal padding, same gap, left edges aligned through the same
// 20px icon column.

/// Header row height, shared by tool cards, static rows, and reasoning.
pub(crate) const HEADER_H: f32 = 26.0;
/// Header horizontal padding — `pl` and `pr` alike.
pub(crate) const HEADER_PAD: f32 = 6.0;
/// Header inter-column gap.
pub(crate) const HEADER_GAP: f32 = 6.0;
/// The leading icon column every header kind shares; the body column's
/// indent (`HEADER_PAD + ICON_COL + HEADER_GAP`) lands under the label.
pub(crate) const HEADER_ICON_COL: f32 = 20.0;
/// The label column's text size, shared by the three header kinds.
pub(crate) const HEADER_TEXT: f32 = 12.5;
/// Header icon size (the tool glyph, the reasoning brain, the chevron).
pub(crate) const HEADER_ICON: f32 = 13.0;
/// The pinned line height every header kind's text carries: a single
/// 16px line box inside the 26px row, so no header text can ever wrap into
/// a second line no matter what its source string contained.
pub(crate) const HEADER_LINE_HEIGHT: f32 = 16.0;

/// The first line of any text, trimmed: every one-line header (tool cards,
/// static rows, reasoning) collapses whatever description source it reads —
/// directory listings, todo checklists, multi-line arguments — to its opening
/// line, so a multi-line source can never wrap or overflow the fixed-height
/// row. Empty input stays empty.
pub(crate) fn one_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_owned()
}

/// The activity's label, with the table's miss answered by its semantic kind:
/// providers that persist localized generic titles ("Edit file") or wrap
/// their tool names still get the right family instead of the wrench.
pub(crate) fn label_for_activity(activity: &ActivityItem) -> ToolLabel {
    let label = label_for(&activity.title);
    if label.family != ToolFamily::Other {
        return label;
    }
    const SHELL: ToolLabel = ToolLabel {
        display_name: "Shell",
        icon: "icons/terminal.svg",
        family: ToolFamily::Bash,
        default_expanded: true,
        language_hint: None,
    };
    const EDIT: ToolLabel = ToolLabel {
        display_name: "Edit File",
        icon: "icons/pencil.svg",
        family: ToolFamily::Edit,
        default_expanded: false,
        language_hint: Some("diff"),
    };
    match activity.kind {
        ActivityKind::Compact => ToolLabel {
            display_name: "Compact Context",
            icon: "icons/rewind.svg",
            family: ToolFamily::Task,
            default_expanded: false,
            language_hint: None,
        },
        ActivityKind::Command => SHELL,
        ActivityKind::FileChange => EDIT,
        ActivityKind::FileRead => ToolLabel {
            display_name: "Read File",
            icon: "icons/file.svg",
            family: ToolFamily::Read,
            default_expanded: false,
            language_hint: None,
        },
        ActivityKind::FileSearch | ActivityKind::Search => ToolLabel {
            display_name: "Search",
            icon: "icons/regex.svg",
            family: ToolFamily::Search,
            default_expanded: false,
            language_hint: None,
        },
        ActivityKind::FileList => ToolLabel {
            display_name: "List Directory",
            icon: "icons/folder-open.svg",
            family: ToolFamily::Read,
            default_expanded: false,
            language_hint: None,
        },
        ActivityKind::Plan => ToolLabel {
            display_name: "Update Plan",
            icon: "icons/list.svg",
            family: ToolFamily::Task,
            default_expanded: false,
            language_hint: None,
        },
        // Reasoning rides the same stream but is not a tool; `Tool` keeps the
        // table's caution default. Both stay `Other` on purpose.
        ActivityKind::Reasoning | ActivityKind::Tool => label,
    }
}

/// Which asset fills the header's cross-fade slot — the glyph that trades
/// places with the tool icon on hover/expansion: the reveal chevron for
/// settled rows (down once expanded, right while collapsed is what hover
/// would reveal), or — while the activity runs — the tool icon itself (the
/// renderer overlays the shared spinner there). Failure never claims this
/// slot: a failed row keeps its tool glyph (or spinner), and the ✗ rides
/// the header's trailing edge instead ([`trailing_failure_icon`]).
pub(crate) fn header_status_icon(activity: &ActivityItem, expanded: bool) -> &'static str {
    if !activity.complete {
        label_for_activity(activity).icon
    } else if expanded {
        "icons/chevron-down.svg"
    } else {
        "icons/chevron-right.svg"
    }
}

/// The ✗ a failed header trails with — `None` unless the activity failed.
/// Rendered at the trailing edge of the header (after the diff-stat badge,
/// before the hover actions) in the error token, so the icon column can
/// keep identifying the tool whatever its outcome.
pub(crate) fn trailing_failure_icon(activity: &ActivityItem) -> Option<&'static str> {
    activity.failed.then_some("icons/x.svg")
}

/// Whether a bare token reads as a file path: it carries a separator, or a
/// short extension after a dot that is not the whole name (".gitignore" is a
/// name; "mod.rs" is a file).
fn is_path_token(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if token.contains('/') || token.contains('\\') {
        return true;
    }
    match token.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty()
                && (1..=8).contains(&ext.len())
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// Punctuation a path token may be glued to inside a detail string (quotes,
/// JSON punctuation, clause commas) — stripped before the path test.
const TOKEN_TRIM: &[char] = &['"', '\'', '`', '(', ')', ',', ';', ':', '[', ']', '{', '}'];

/// The first path-looking token of a detail string. v1 heuristic: a quoted or
/// bare path token wins; quoted paths spanning spaces are not untangled.
pub(crate) fn first_path_token(detail: &str) -> Option<&str> {
    detail
        .lines()
        .next()?
        .split_whitespace()
        .map(|token| token.trim_matches(|c: char| TOKEN_TRIM.contains(&c)))
        .find(|token| is_path_token(token))
}

/// The file path an Edit-family header acts on: the prepared change's path
/// first, then the prepared display target when it is path-shaped, then the
/// first path-looking token of the detail string.
pub(crate) fn edit_path(activity: &ActivityItem) -> Option<String> {
    if let Some(change) = activity.file_changes.first() {
        return Some(change.path.clone());
    }
    if let Some(target) = activity
        .display_target
        .as_deref()
        .map(str::trim)
        .filter(|target| is_path_token(target.trim_matches(|c| TOKEN_TRIM.contains(&c))))
    {
        return Some(target.to_owned());
    }
    first_path_token(activity.detail.as_deref().unwrap_or("")).map(str::to_owned)
}

/// What the header's description column says, per tool family: the touched
/// path (workspace-relative) for edits, the command's first line for shells,
/// the directory path only for listing tools, the detail for everything else
/// — collapsed to one line whatever its source's shape, because the header
/// row is one line, period.
pub(crate) fn description_for(activity: &ActivityItem, workspace: &Path) -> String {
    let detail = activity.detail.as_deref().map(str::trim).unwrap_or("");
    let description = match label_for_activity(activity).family {
        ToolFamily::Edit => match edit_path(activity) {
            Some(path) => relative_display(workspace, &path),
            None => detail.to_owned(),
        },
        ToolFamily::Bash => bash_first_line(command_source(activity).unwrap_or(detail)),
        // Directory listings: the directory path ONLY — workspace-relative
        // like an edit's path, trailing separator kept — because the listing
        // itself (which the detail and output carry) is the expanded body's
        // content, never the header's.
        _ if is_listing_tool(activity) => match listing_path(activity) {
            Some(path) => directory_display(workspace, &path),
            None => String::new(),
        },
        _ => detail.to_owned(),
    };
    one_line(&description)
}

/// The command text a Bash-family header shows: the prepared human
/// description, then the prepared target (the command), then the detail.
pub(crate) fn command_source(activity: &ActivityItem) -> Option<&str> {
    activity
        .display_description
        .as_deref()
        .or(activity.display_target.as_deref())
        .map(str::trim)
        .filter(|command| !command.is_empty())
}

// ── Read-only content bodies ───────────────────────────────────────────────
//
// The read-only families (Read/Search/Web — file reads, media reads, grep,
// glob, fetches) render as expandable cards: their output carries the
// CONTENT the tool captured (file text, search hits, a fetched page), which
// the expanded body scrolls in the shared mono viewport treatment. The two
// directory-listing tools ride the same path.

/// Whether the activity is a directory-listing tool — tide's `list_dir` and
/// `directory_tree` — resolved by wire-name match on the title, normalized
/// the way `ActivityKind::from_tool_name` normalizes, so localized "List
/// Directory"/"Directory Tree" titles classify the same as the wire names.
pub(crate) fn is_listing_tool(activity: &ActivityItem) -> bool {
    let normalized = activity
        .title
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_");
    normalized.contains("list_dir") || normalized.contains("directory_tree")
}

/// Whether the activity renders its expanded body as the content viewport
/// (mono lines of whatever the driver captured): the read-only families —
/// Read (file and media reads, listings), Search (grep/glob), Web (fetches)
/// — plus the two listing tools whatever family the provider's
/// classification filed them under.
pub(crate) fn is_content_tool(activity: &ActivityItem) -> bool {
    is_listing_tool(activity)
        || matches!(
            label_for_activity(activity).family,
            ToolFamily::Read | ToolFamily::Search | ToolFamily::Web
        )
}

/// The directory a listing tool listed: the JSON `path` key of the activity's
/// arguments first (the arguments field holds the tool's args), then the
/// prepared display target's first line. Never the detail or output — those
/// carry the listing, not the path.
pub(crate) fn listing_path(activity: &ActivityItem) -> Option<String> {
    if let Some(arguments) = activity
        .arguments
        .as_deref()
        .map(str::trim)
        .filter(|arguments| !arguments.is_empty())
        && arguments.starts_with('{')
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(arguments)
        && let Some(path) = value
            .get("path")
            .and_then(|field| field.as_str())
            .map(str::trim)
            .filter(|path| !path.is_empty())
    {
        return Some(path.to_owned());
    }
    activity
        .display_target
        .as_deref()
        .map(str::trim)
        .filter(|target| !target.is_empty())
        .map(one_line)
}

/// The captured output text, trimmed — `None` when the field is absent or
/// blank.
pub(crate) fn captured_output(activity: &ActivityItem) -> Option<&str> {
    activity
        .output
        .as_deref()
        .map(str::trim)
        .filter(|output| !output.is_empty())
}

/// The content a read-only body may disclose against: the captured output,
/// or the prepared display text standing in when the provider left the
/// content only there — trimmed, `None` when neither carries anything.
pub(crate) fn content_body_source(activity: &ActivityItem) -> Option<&str> {
    captured_output(activity).or_else(|| {
        activity
            .display_target
            .as_deref()
            .map(str::trim)
            .filter(|content| !content.is_empty())
    })
}

/// A listing header's directory: workspace-relative like an edit's path, but
/// keeping the trailing separator the relativized form loses — "src/", not
/// "src" — because the column names a directory, not a file.
fn directory_display(workspace: &Path, path: &str) -> String {
    let directory = relative_display(workspace, path);
    if path.ends_with('/') && !directory.ends_with('/') {
        format!("{directory}/")
    } else {
        directory
    }
}

/// The diff-stat badge: "+3/-1" with the halves' token colors — success for
/// additions, error for deletions. The joined string is the canonical form;
/// the renderer splits it on the '/' to color each half.
pub(crate) fn diff_stat(theme: &Theme, additions: u64, deletions: u64) -> (String, Hsla, Hsla) {
    (
        format!("+{additions}/-{deletions}"),
        super::super::diff_added(),
        super::super::diff_removed(theme),
    )
}

/// The header row: id'd by the part's disclosure id, no click of its own —
/// `list.rs` wraps it with the toggle because only it holds the view
/// context. Hover is a group named after the part, so the icon column's
/// cross-fade and the action buttons reveal together.
///
/// A body-less activity ([`has_body`] false) renders as a single static
/// line: no chevron cross-fade in the icon slot, no hover wash, no click —
/// the tool glyph stays put and the row's only affordances are the hover
/// actions (view file / view diff / the agent jump), which stand on their
/// own.
pub(crate) fn render_activity_header(
    activity: &ActivityItem,
    workspace: &Path,
    actions: &TranscriptActions,
    theme: &Theme,
    expanded: bool,
) -> Stateful<Div> {
    let label = label_for_activity(activity);
    let id = disclosure_id(activity);
    let element_id = SharedString::from(format!("tool-header-{id}"));
    let hover_group = SharedString::from(format!("tool-header-hover-{id}"));
    let expandable = has_body(activity);
    let description = description_for(activity, workspace);

    // Status icon column (20px): the tool glyph, with the cross-fade slot
    // stacked over it. The glyph only trades places with something once the
    // row has settled AND the card can disclose — while running the spinner
    // owns the slot, and a body-less row keeps its glyph for good. Failure
    // never claims the slot either: the glyph (or spinner) keeps naming the
    // tool, and the ✗ trails the header instead.
    let mut tool_glyph = icon(label.icon, HEADER_ICON, tools_dim(theme));
    if !activity.complete {
        // Running: the spinner owns the slot outright — the glyph fades to
        // zero instead of stacking under the overlay.
        tool_glyph = tool_glyph.opacity(0.0);
    } else if expandable {
        tool_glyph = tool_glyph
            .when(expanded, |glyph| glyph.opacity(0.0))
            .group_hover(hover_group.clone(), |glyph| glyph.opacity(0.0));
    }
    let overlay = if !activity.complete {
        // The composer/status-bar spinner idiom: shared pulse clock, so N
        // running rows cost one lease-keeping redraw cadence.
        Some(motion::spin(icon(
            "icons/loader-circle.svg",
            HEADER_ICON,
            tools_dim(theme),
        )))
    } else if expandable {
        Some(
            icon(
                header_status_icon(activity, expanded),
                12.0,
                tools_dim(theme),
            )
            .when(!expanded, |glyph| glyph.opacity(0.0))
            .group_hover(hover_group.clone(), |glyph| glyph.opacity(1.0))
            .into_any_element(),
        )
    } else {
        None
    };
    let icon_column = div()
        .w(px(HEADER_ICON_COL))
        .flex_none()
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .child(tool_glyph)
        .when_some(overlay, |column, overlay| {
            column.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(overlay),
            )
        });

    // Display name: medium weight in the title token; failure recolors it.
    let name_column = div()
        .flex_none()
        .max_w(px(160.0))
        .min_w_0()
        .truncate()
        .text_size(sp(HEADER_TEXT))
        .font_weight(FontWeight::MEDIUM)
        .text_color(if activity.failed {
            status_color(theme, Status::Error)
        } else {
            tools_title(theme)
        })
        .child(label.display_name);

    let mut header = div()
        .id(element_id)
        .h(px(HEADER_H))
        .w_full()
        .min_w_0()
        // The one-liner guarantee, structurally: the row never grows past
        // its fixed height, its text carries a pinned single-line line box,
        // and anything a column could not clip dies at the row's own edge.
        .overflow_hidden()
        .line_height(sp(HEADER_LINE_HEIGHT))
        .flex()
        .items_center()
        .gap(px(HEADER_GAP))
        .pl(px(HEADER_PAD))
        .pr(px(HEADER_PAD))
        .rounded(px(6.0))
        .group(hover_group.clone())
        .cursor_default()
        // The hover wash is a disclosure affordance; a static line stays
        // visually still.
        .when(expandable, |row| row.hover(|style| style.bg(theme.overlay)))
        .child(icon_column)
        .child(name_column);

    if !description.is_empty() {
        header = header.child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(sp(HEADER_TEXT))
                .text_color(tools_description(theme))
                .child(SharedString::from(description)),
        );
    }

    // Diff-stat badge: "+N" in the success token, "-M" in the error token.
    if let Some((additions, deletions)) = activity_file_change_stats(activity) {
        let (stat, additions_color, deletions_color) = diff_stat(theme, additions, deletions);
        let (additions_half, deletions_half) = stat.split_once('/').unwrap_or((stat.as_str(), ""));
        header = header.child(
            div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(3.0))
                .text_size(sp(10.5))
                .child(
                    div()
                        .text_color(additions_color)
                        .child(SharedString::from(additions_half)),
                )
                .child(
                    div()
                        .text_color(deletions_color)
                        .child(SharedString::from(deletions_half)),
                ),
        );
    }

    // Failure trails the header: the ✗ in the error token after the diff
    // stat (aligned with it), before the hover actions — one line, same as
    // every other trailing affordance.
    if let Some(failure_icon) = trailing_failure_icon(activity) {
        header = header.child(div().flex_none().flex().items_center().child(icon(
            failure_icon,
            12.0,
            status_color(theme, Status::Error),
        )));
    }

    // Hover actions: file-edit rows with a resolvable path offer view-file and
    // view-diff, and dispatch runs offer the Bot jump into the agent's right-
    // panel detail. Clicks stop at the buttons so the header never toggles.
    let mut hover_actions: Vec<AnyElement> = Vec::new();
    if label.family == ToolFamily::Edit
        && let Some(path) = edit_path(activity)
    {
        let view_file = Arc::clone(&actions.view_file);
        let view_diff = Arc::clone(&actions.view_diff);
        let diff_path = path.clone();
        let view_file_button = icon_button(
            SharedString::from(format!("tool-view-file-{id}")),
            "icons/file.svg",
            *theme,
        )
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            view_file(&path, window, cx);
        });
        let view_diff_button = icon_button(
            SharedString::from(format!("tool-view-diff-{id}")),
            "icons/git-commit-horizontal.svg",
            *theme,
        )
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            view_diff(&diff_path, window, cx);
        });
        hover_actions.push(view_file_button.into_any_element());
        hover_actions.push(view_diff_button.into_any_element());
    }
    // Dispatch runs: the Bot jumps to the agent in the right panel — its
    // detail surface when the registry can name the item, the Agents tab
    // otherwise.
    if is_dispatch(activity) {
        let open_dispatch = Arc::clone(&actions.open_dispatch);
        let dispatch_id = id.clone();
        hover_actions.push(
            icon_button(
                SharedString::from(format!("tool-open-dispatch-{id}")),
                "icons/bot.svg",
                *theme,
            )
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(move |_, window, cx| {
                cx.stop_propagation();
                open_dispatch(&dispatch_id, window, cx);
            })
            .into_any_element(),
        );
    }
    if !hover_actions.is_empty() {
        header = header.child(
            div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(2.0))
                .when(!expanded, |row| row.invisible())
                .group_hover(hover_group, |row| row.visible())
                .children(hover_actions),
        );
    }

    header
}

// ── Expanded bodies ────────────────────────────────────────────────────────

/// Height cap for the body's scroll viewports (bash output, JSON card).
/// The diff viewport keeps its own budget in `diff_rows` (row count, not
/// pixels, because diff rows are the unit the legacy pane capped).
const OUTPUT_MAX_HEIGHT: f32 = 400.0;

/// A `pre`-style mono block on the dark wash: commands and raw arguments.
/// Multi-line text renders as-is; wrapping long lines keeps the card honest.
fn mono_block(text: &str, theme: &Theme) -> Div {
    div()
        .w_full()
        .min_w_0()
        .overflow_hidden()
        .bg(theme.raised)
        .rounded(px(6.0))
        .px(px(8.0))
        .py(px(6.0))
        .text_size(sp(11.5))
        .line_height(sp(16.0))
        .font_family(md::render::MONO_FAMILY)
        .text_color(theme.text_secondary)
        .child(SharedString::from(text))
}

/// The error-token failure card: 1px danger border over a danger-tinted
/// wash, the failure text at 11.5sp.
fn failure_card(text: &str, theme: &Theme) -> Div {
    div()
        .w_full()
        .min_w_0()
        .overflow_hidden()
        .border_1()
        .border_color(theme.danger.opacity(0.35))
        .bg(theme.danger.opacity(0.08))
        .rounded(px(6.0))
        .px(px(8.0))
        .py(px(6.0))
        .text_size(sp(11.5))
        .line_height(sp(16.0))
        .text_color(theme.danger)
        .child(SharedString::from(text))
}

/// The text a failure card shows: the detail first, the output standing in
/// when the provider put the error only there.
pub(crate) fn failure_text(activity: &ActivityItem) -> Option<&str> {
    activity
        .detail
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .or(activity
            .output
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty()))
}

/// Parse trimmed output as JSON, answering `Some` only when it parses AND
/// opens with an object or array brace — a bare string/number parses fine
/// but is not "JSON output" worth a card.
pub(crate) fn looks_like_json(output: &str) -> Option<serde_json::Value> {
    let trimmed = output.trim();
    if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

/// The agent name derivable from a dispatch activity's arguments JSON: an
/// `agent`/`subagent_type` string field, when the provider sent one.
pub(crate) fn agent_name(activity: &ActivityItem) -> Option<String> {
    let arguments = activity.arguments.as_deref()?.trim();
    if !(arguments.starts_with('{') || arguments.starts_with('[')) {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(arguments).ok()?;
    ["agent", "subagent_type", "subagent"]
        .iter()
        .find_map(|key| value.get(key).and_then(|field| field.as_str()))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// Whether the activity is a dispatched sub-agent run (vs. the Task family's
/// other members: todo lists, questions, plan-mode gates). The title is
/// normalized the way `ActivityKind::from_tool_name` does, so localized
/// "Dispatch Agent" titles match the wire name too.
pub(crate) fn is_dispatch(activity: &ActivityItem) -> bool {
    let normalized = activity
        .title
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_");
    normalized.contains("dispatch")
}

/// The question and options a follow-up activity's arguments carry:
/// `{"question": "...", "options": [{"label", "description"?}]}` — tide's
/// `ask_followup_question` shape. `None` when the arguments are missing or
/// carry no question text.
pub(crate) fn followup_parts(
    activity: &ActivityItem,
) -> Option<(String, Vec<(String, Option<String>)>)> {
    let arguments = activity.arguments.as_deref()?.trim();
    if !(arguments.starts_with('{') || arguments.starts_with('[')) {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(arguments).ok()?;
    let question = value
        .get("question")?
        .as_str()
        .map(str::trim)
        .filter(|question| !question.is_empty())?;
    let options = value
        .get("options")
        .and_then(|options| options.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let label = item
                        .get("label")
                        .or_else(|| item.get("value"))
                        .or_else(|| item.get("text"))
                        .and_then(|label| label.as_str())
                        .map(str::trim)
                        .filter(|label| !label.is_empty())?;
                    let description = item
                        .get("description")
                        .and_then(|description| description.as_str())
                        .map(str::trim)
                        .filter(|description| !description.is_empty())
                        .map(str::to_owned);
                    Some((label.to_owned(), description))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some((question.to_owned(), options))
}

/// Whether the activity is a todo-list write: the semantic `Plan` kind, or
/// the `todo_write` wire name the table knows.
pub(crate) fn is_todo_write(activity: &ActivityItem) -> bool {
    activity.kind == ActivityKind::Plan || activity.title.trim().eq_ignore_ascii_case("todo_write")
}

/// Whether the activity is a structured follow-up question: the
/// `ask_followup_question` wire name, normalized the way
/// `ActivityKind::from_tool_name` normalizes before it compares.
pub(crate) fn is_followup_question(activity: &ActivityItem) -> bool {
    activity
        .title
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_")
        .contains("ask_followup")
}

/// Whether the activity's raw arguments carry anything a body would want to
/// show: non-empty and not the bare `{}` object providers send for
/// no-argument calls. Read-only families with captured output never reach
/// this — their arguments are path/query noise the header already shows.
fn meaningful_arguments(activity: &ActivityItem) -> bool {
    activity
        .arguments
        .as_deref()
        .map(str::trim)
        .is_some_and(|arguments| !arguments.is_empty() && arguments != "{}")
}

/// Whether the activity has an expanded body worth disclosing. True when any
/// of: non-empty output, a file change with a diff, a failure the failure
/// card would render, a dispatch run (its report section), a follow-up
/// question (the question + options section), captured content a read-only
/// tool exists to show (the content viewport — the output, or the display
/// text some providers leave the content only in), or — per family — the
/// input section the body would actually draw (the bash command, the
/// generic blockquote/arguments). Reasoning parts are NOT covered here: they
/// carry their own disclosure rule (`reasoning_content`) and never render a
/// card.
pub(crate) fn has_body(activity: &ActivityItem) -> bool {
    if captured_output(activity).is_some() {
        return true;
    }
    if activity.file_changes.iter().any(|change| {
        change
            .diff
            .as_deref()
            .map(str::trim)
            .is_some_and(|diff| !diff.is_empty())
    }) {
        return true;
    }
    if activity.failed && failure_text(activity).is_some() {
        return true;
    }
    if is_dispatch(activity) || is_followup_question(activity) {
        return true;
    }
    // Read-only tools (reads, searches, fetches, listings) disclose when the
    // captured content exists — the output, or the display text standing in.
    if is_content_tool(activity) {
        return content_body_source(activity).is_some();
    }
    match label_for_activity(activity).family {
        // Bash: the command's mono block.
        ToolFamily::Bash => command_source(activity).is_some(),
        // Edit bodies draw diffs only (answered above).
        ToolFamily::Edit => false,
        // Everything else: the blockquote/arguments input section.
        _ => {
            activity
                .display_description
                .as_deref()
                .map(str::trim)
                .is_some_and(|description| !description.is_empty())
                || meaningful_arguments(activity)
        }
    }
}

/// One todo line with its list marker stripped, ready to re-prefix.
pub(crate) fn todo_item(line: &str) -> &str {
    line.trim().trim_start_matches(['-', '*', '•']).trim_start()
}

/// The state of one todo row — tide's four checkbox states. The marks are
/// the wire vocabulary tide's `todo_write` emits (`[x]`, `[~]`, `[-]`,
/// `[ ]`), so the checklist renders exactly what the tool wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TodoState {
    Pending,
    InProgress,
    Done,
    Cancelled,
}

/// Parse one todo line into its state and label. Accepts both shapes the
/// wild emits: tide's `todo_write` result lines (`[x] 1. Done work`, `[~]
/// 2. Active work`, `[-] 3. Dropped`, `[ ] 4. Future`) and plain task-list
/// markdown (`- [x] done`, `- [ ] pending`). An optional leading list
/// marker (`-`/`*`/`•`) and an optional `N.` numbering prefix after the
/// mark both strip. `None` for any line without a checkbox mark.
pub(crate) fn parse_todo_line(line: &str) -> Option<(TodoState, String)> {
    let stripped = line.trim().trim_start_matches(['-', '*', '•']).trim_start();
    let after_open = stripped.strip_prefix('[')?;
    let (mark, rest) = after_open.split_once(']')?;
    let state = match mark.trim() {
        "x" | "X" => TodoState::Done,
        "~" => TodoState::InProgress,
        "-" => TodoState::Cancelled,
        "" => TodoState::Pending,
        _ => return None,
    };
    // Tide numbers its lines ("[x] 1. content"); the number is not part of
    // the label.
    let label = rest.trim();
    let label = label
        .split_once(". ")
        .filter(|(index, _)| !index.is_empty() && index.chars().all(|c| c.is_ascii_digit()))
        .map(|(_, content)| content)
        .unwrap_or(label)
        .trim();
    Some((state, label.to_owned()))
}

/// Parse a whole todo output into checklist rows: the JSON-array form first
/// (tide's app renderer reads `[{content, status, priority?}]`), then the
/// marked-line form from [`parse_todo_line`]. `None` when nothing parses —
/// the caller falls back to plain text rows.
pub(crate) fn parse_todo_output(output: &str) -> Option<Vec<(TodoState, String)>> {
    if let Some(value) = looks_like_json(output)
        && let Some(items) = value.as_array()
    {
        let parsed: Vec<(TodoState, String)> = items
            .iter()
            .filter_map(|item| {
                let state = match item.get("status")?.as_str()? {
                    "completed" => TodoState::Done,
                    "in_progress" => TodoState::InProgress,
                    "cancelled" => TodoState::Cancelled,
                    "pending" => TodoState::Pending,
                    _ => return None,
                };
                let label = item.get("content")?.as_str()?.trim();
                (!label.is_empty()).then_some((state, label.to_owned()))
            })
            .collect();
        if !parsed.is_empty() {
            return Some(parsed);
        }
    }
    let parsed: Vec<(TodoState, String)> = output.lines().filter_map(parse_todo_line).collect();
    (!parsed.is_empty()).then_some(parsed)
}

/// The 11px checkbox for one todo state: a filled accent square with the
/// check glyph when done; a dim-bordered empty square when pending; a
/// dim-outlined square with an accent dot while in progress (the "half"
/// state); cancelled keeps the pending box but the label carries the
/// strike.
fn todo_checkbox(state: TodoState, theme: &Theme) -> Div {
    let box_style = div()
        .size(px(11.0))
        .flex_none()
        .rounded(px(2.5))
        .flex()
        .items_center()
        .justify_center();
    match state {
        TodoState::Done => {
            box_style
                .bg(theme.accent)
                .child(icon("icons/check.svg", 10.0, theme.on_inverse))
        }
        TodoState::InProgress => box_style
            .border_1()
            .border_color(tools_dim(theme))
            .child(div().size(px(5.0)).rounded_full().bg(theme.accent)),
        TodoState::Pending | TodoState::Cancelled => {
            box_style.border_1().border_color(tools_dim(theme))
        }
    }
}

/// A todo-write result rendered as tide's checklist: one 22px row per item,
/// the state checkbox leading and the label trailing. Done and cancelled
/// labels strike through in the tertiary token; the in-progress row keeps
/// the normal text plus a dim "in progress" hint; pending stays quiet.
/// Output nothing parsed falls back to the plain "- item" rows.
fn todo_section(output: &str, theme: &Theme) -> Div {
    let rows = parse_todo_output(output);
    let plain_rows = || {
        output
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                div()
                    .flex()
                    .items_start()
                    .gap(px(6.0))
                    .text_size(sp(11.5))
                    .line_height(sp(16.0))
                    .text_color(tools_description(theme))
                    .child(div().flex_none().text_color(tools_dim(theme)).child("-"))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .child(SharedString::from(todo_item(line))),
                    )
            })
    };
    let checklist_rows = |items: Vec<(TodoState, String)>| {
        items.into_iter().map(|(state, label)| {
            let struck = matches!(state, TodoState::Done | TodoState::Cancelled);
            let label_column = div()
                .min_w_0()
                .flex_1()
                .truncate()
                .text_size(sp(12.0))
                .line_height(sp(16.0))
                .text_color(if struck {
                    theme.text_tertiary
                } else {
                    tools_description(theme)
                })
                .when(struck, |label| label.line_through())
                .child(SharedString::from(label));
            let mut row = div()
                .h(px(22.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(todo_checkbox(state, theme))
                .child(label_column);
            if state == TodoState::InProgress {
                row = row.child(
                    div()
                        .flex_none()
                        .text_size(sp(10.5))
                        .text_color(tools_dim(theme))
                        .child("· in progress"),
                );
            }
            row
        })
    };
    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .py(px(2.0))
        .children(match rows {
            Some(items) => checklist_rows(items).collect::<Vec<_>>(),
            None => plain_rows().collect::<Vec<_>>(),
        })
}

/// The small copy affordance for an output section. The click handler
/// receives `&mut App` at click time, so the renderer itself needs no app
/// context — it only captures the text to copy.
fn copy_button(id: String, text: String, theme: &Theme) -> gpui::Stateful<Div> {
    icon_button(SharedString::from(id), "icons/copy.svg", *theme).on_click(move |_, _, cx| {
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
    })
}

/// Streaming/plain output in the shared scroll viewport, copy button parked
/// top-right of the section. Bash output renders mono; other families' plain
/// text keeps the sans face.
fn output_section(output: &str, id: &str, mono: bool, theme: &Theme) -> Div {
    let viewport = div()
        .id(SharedString::from(format!("tool-output-{id}")))
        .max_h(px(OUTPUT_MAX_HEIGHT))
        .overflow_y_scroll()
        .w_full()
        .min_w_0()
        .rounded(px(6.0))
        .bg(theme.raised)
        .px(px(8.0))
        .py(px(6.0))
        .text_size(sp(11.5))
        .line_height(sp(16.0))
        .text_color(theme.text_secondary)
        .when(mono, |block| block.font_family(md::render::MONO_FAMILY))
        .child(SharedString::from(output));

    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(div().flex().items_center().justify_end().child(copy_button(
            format!("tool-output-copy-{id}"),
            output.to_owned(),
            theme,
        )))
        .child(viewport)
}

/// Captured content in the same scroll-viewport treatment the bash output
/// keeps: the 400px cap behind an id'd scroll container, mono 11.5sp, one
/// truncated line per line — so a deep file, a wide search, or a deep tree
/// scrolls instead of stretching the card, and no content line ever wraps.
/// `title_hint` names the content (a listing's directory path) in a dim
/// one-line label above it, when the caller has one.
fn content_section(title_hint: Option<&str>, text: &str, id: &str, theme: &Theme) -> Stateful<Div> {
    let lines = text.lines().map(|line| {
        div()
            .w_full()
            .min_w_0()
            .truncate()
            .child(SharedString::from(line.trim()))
    });
    div()
        .id(SharedString::from(format!("tool-content-{id}")))
        .max_h(px(OUTPUT_MAX_HEIGHT))
        .overflow_y_scroll()
        .w_full()
        .min_w_0()
        .rounded(px(6.0))
        .bg(theme.raised)
        .px(px(8.0))
        .pt(px(6.0))
        .pb(px(6.0))
        .text_size(sp(11.5))
        .line_height(sp(16.0))
        .font_family(md::render::MONO_FAMILY)
        .text_color(theme.text_secondary)
        .when_some(title_hint, |section, hint| {
            section.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(sp(10.0))
                    .line_height(sp(13.0))
                    .text_color(tools_dim(theme))
                    .child(SharedString::from(hint)),
            )
        })
        .child(div().flex().flex_col().children(lines))
}

/// A JSON-valued output: pretty-printed mono block behind a tag row ("json",
/// "raw" — tree/summary views come later), copy button top-right.
fn json_section(value: &serde_json::Value, id: &str, theme: &Theme) -> Div {
    let pretty = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    let viewport = div()
        .id(SharedString::from(format!("tool-json-{id}")))
        .max_h(px(OUTPUT_MAX_HEIGHT))
        .overflow_y_scroll()
        .w_full()
        .min_w_0()
        .rounded(px(6.0))
        .bg(theme.raised)
        .px(px(8.0))
        .py(px(6.0))
        .text_size(sp(11.5))
        .line_height(sp(16.0))
        .font_family(md::render::MONO_FAMILY)
        .text_color(theme.text_secondary)
        .child(pretty);

    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .text_size(sp(10.0))
                        .text_color(tools_dim(theme))
                        .child("json")
                        .child("·")
                        .child("raw"),
                )
                .child(copy_button(
                    format!("tool-json-copy-{id}"),
                    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
                    theme,
                )),
        )
        .child(viewport)
}

/// A dispatched agent's report: the agent badge (bot glyph + name when the
/// arguments carried one) over the report as plain text — markdown arrives
/// with the text-part task; plain here keeps v1 honest.
fn dispatch_section(activity: &ActivityItem, report: &str, theme: &Theme) -> Div {
    // Structured card when the driver attached the Agent payload: agent
    // chip + title, the task as a dim prompt line, the report, and the
    // durable dispatch id with its copy affordance (the resumeFrom target).
    if let Some(agent) = activity.agent.as_ref() {
        let id = disclosure_id(activity);
        let mut badge = div().flex().items_center().gap(px(4.0));
        badge = badge.child(icon("icons/bot.svg", 12.0, tools_dim(theme)));
        badge = badge.child(
            div()
                .text_size(sp(11.0))
                .text_color(tools_dim(theme))
                .child(SharedString::from(agent.agent_name.clone())),
        );
        if let Some(title) = agent
            .title
            .as_deref()
            .filter(|title| !title.trim().is_empty())
        {
            badge = badge.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(sp(11.0))
                    .text_color(tools_description(theme))
                    .child(SharedString::from(format!("· {title}"))),
            );
        }
        let mut section = div()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(badge);
        if !agent.task.trim().is_empty() {
            section = section.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(sp(11.0))
                    .line_height(sp(15.0))
                    .text_color(tools_description(theme))
                    .child(SharedString::from(agent.task.trim().to_owned())),
            );
        }
        if !agent.report.trim().is_empty() {
            section = section.child(
                div()
                    .min_w_0()
                    .text_size(sp(11.5))
                    .line_height(sp(16.0))
                    .text_color(tools_description(theme))
                    .child(SharedString::from(agent.report.trim().to_owned())),
            );
        }
        if let Some(dispatch_id) = agent
            .dispatch_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
        {
            let short: String = dispatch_id.chars().take(8).collect();
            section = section.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(sp(10.5))
                            .text_color(tools_dim(theme))
                            .child(SharedString::from(format!("dispatch {short}"))),
                    )
                    .child(copy_button(
                        format!("tool-dispatch-id-{id}"),
                        dispatch_id.to_owned(),
                        theme,
                    )),
            );
        }
        return section;
    }
    // Pre-structure fallback: the badge the arguments can name plus the
    // report text.
    let mut badge = div().flex().items_center().gap(px(4.0));
    badge = badge.child(icon("icons/bot.svg", 12.0, tools_dim(theme)));
    if let Some(name) = agent_name(activity) {
        badge = badge.child(
            div()
                .text_size(sp(11.0))
                .text_color(tools_dim(theme))
                .child(SharedString::from(name)),
        );
    }
    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(badge)
        .child(
            div()
                .min_w_0()
                .text_size(sp(11.5))
                .line_height(sp(16.0))
                .text_color(tools_description(theme))
                .child(SharedString::from(report)),
        )
}

/// A follow-up question's body: the question in the title token over the
/// numbered options (label + dim one-line description) parsed from the
/// activity's arguments — the same pairs the pending-question card offers,
/// shown as the settled record of what was asked.
fn question_section(question: &str, options: &[(String, Option<String>)], theme: &Theme) -> Div {
    let option_rows = options
        .iter()
        .enumerate()
        .map(|(index, (label, description))| {
            div()
                .flex()
                .items_start()
                .gap(px(6.0))
                .child(
                    div()
                        .flex_none()
                        .text_size(sp(11.5))
                        .text_color(tools_dim(theme))
                        .child(SharedString::from(format!("{}.", index + 1))),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px(1.0))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(sp(12.0))
                                .line_height(sp(16.0))
                                .text_color(tools_description(theme))
                                .child(SharedString::from(label.clone())),
                        )
                        .children(description.clone().map(|description| {
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(sp(11.0))
                                .line_height(sp(14.0))
                                .text_color(tools_dim(theme))
                                .child(SharedString::from(description))
                        })),
                )
        });
    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .min_w_0()
                .text_size(sp(12.5))
                .line_height(sp(17.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(tools_title(theme))
                .child(SharedString::from(question)),
        )
        .children(option_rows)
}

/// The result section for a completed, unfailed activity with output:
/// family specials first (the todo checklist, the dispatch report), then
/// JSON detection (any family), then the shared output viewport. The todo
/// check leads the JSON check on purpose — a marked checklist opens with
/// `[`, which `looks_like_json` would otherwise claim and lose to a parse
/// error.
fn result_section(activity: &ActivityItem, output: &str, id: &str, theme: &Theme) -> Div {
    if is_todo_write(activity) {
        return todo_section(output, theme);
    }
    if is_dispatch(activity) {
        return dispatch_section(activity, output, theme);
    }
    if let Some(value) = looks_like_json(output) {
        return json_section(&value, id, theme);
    }
    output_section(
        output,
        id,
        label_for_activity(activity).family == ToolFamily::Bash,
        theme,
    )
}

/// The card body, rendered under an expanded header inside the railed
/// container: an input section (per family) plus a result section (once the
/// activity settles). Takes no app context — the copy buttons' click
/// handlers receive one at click time, so `list.rs` can call this anywhere
/// it can render.
pub(crate) fn render_activity_body(
    activity: &ActivityItem,
    workspace: &Path,
    theme: &Theme,
) -> Div {
    let id = disclosure_id(activity);
    let family = label_for_activity(activity).family;

    // The body column aligns under the header's label: the header's leading
    // padding plus its 20px icon slot plus the header's 6px gap. Overflow is
    // contained here once so every section below can trust the width.
    let mut body = div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .min_w_0()
        .overflow_hidden()
        .pl(px(HEADER_PAD + HEADER_ICON_COL + HEADER_GAP))
        .pr(px(4.0))
        .pb(px(4.0));

    // ── Input section ──
    match family {
        // Bash: the command in a mono pre-style block on the raised wash.
        ToolFamily::Bash => {
            if let Some(command) = command_source(activity).filter(|command| !command.is_empty()) {
                body = body.child(mono_block(command, theme));
            }
        }
        // Edit/Write: each prepared file change with a diff body renders its
        // own labeled diff viewport.
        ToolFamily::Edit => {
            for (index, change) in activity.file_changes.iter().enumerate() {
                let Some(diff) = change
                    .diff
                    .as_deref()
                    .map(str::trim)
                    .filter(|diff| !diff.is_empty())
                else {
                    continue;
                };
                body = body.child(
                    div()
                        .w_full()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(3.0))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(sp(10.5))
                                .text_color(tools_dim(theme))
                                .child(SharedString::from(relative_display(
                                    workspace,
                                    &change.path,
                                ))),
                        )
                        .child(diff_rows::render_diff_lines(
                            diff,
                            &format!("tool-diff-{id}-{index}"),
                            theme,
                            Some(MAX_DIFF_ROWS),
                        )),
                );
            }
        }
        // A follow-up question renders the parsed question + options list —
        // the settled record of what the pending-question card asked.
        _ if is_followup_question(activity) => {
            if let Some((question, options)) = followup_parts(activity) {
                body = body.child(question_section(&question, &options, theme));
            } else {
                let description = activity
                    .display_description
                    .as_deref()
                    .or(activity.detail.as_deref())
                    .map(str::trim)
                    .filter(|text| !text.is_empty());
                if let Some(description) = description {
                    body = body.child(blockquote(description, theme));
                }
            }
        }
        // Todo writes and dispatch runs carry their own result sections (the
        // checklist, the agent report) — the generic blockquote/arguments
        // input would only duplicate what those sections already show.
        _ if is_todo_write(activity) || is_dispatch(activity) => {}
        // Directory listings render their listing in the result section; the
        // arguments are path noise the header already shows as the path.
        _ if is_listing_tool(activity) => {}
        // Reads/searches/fetches: with captured output (or a failure — the
        // error card below is the whole body) the input section stays empty,
        // because the input would be path/query noise the header already
        // shows. Without output the display-text fallback keeps the
        // blockquote/input treatment, the display text standing in as the
        // blockquote's source when description and detail are absent.
        _ if matches!(
            family,
            ToolFamily::Read | ToolFamily::Search | ToolFamily::Web
        ) =>
        {
            if !activity.failed && captured_output(activity).is_none() {
                let description = activity
                    .display_description
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .or(activity
                        .detail
                        .as_deref()
                        .map(str::trim)
                        .filter(|text| !text.is_empty()))
                    .or(activity
                        .display_target
                        .as_deref()
                        .map(str::trim)
                        .filter(|text| !text.is_empty()));
                if let Some(description) = description {
                    body = body.child(blockquote(description, theme));
                }
                if let Some(arguments) = activity
                    .arguments
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    body = body.child(mono_block(arguments, theme));
                }
            }
        }
        // Everything else: the description as an italic blockquote on the
        // rail, plus raw arguments in a mono block when the provider sent
        // them (MCP tools carry their whole input there).
        _ => {
            let description = activity
                .display_description
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .or(activity
                    .detail
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty()));
            if let Some(description) = description {
                body = body.child(blockquote(description, theme));
            }
            if let Some(arguments) = activity
                .arguments
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                body = body.child(mono_block(arguments, theme));
            }
        }
    }

    // ── Result section ──
    if activity.failed {
        if let Some(text) = failure_text(activity) {
            body = body.child(failure_card(text, theme));
        }
    } else if activity.complete {
        // Read-only tools render the content viewport: the captured output
        // as mono truncated lines (listings under their directory path,
        // reads/searches/fetches — media reads included — under whatever the
        // driver captured, never a decoded image). A listing whose output
        // never landed keeps the display text standing in, like the listing
        // body always did; everything else keeps the family-aware result
        // section.
        if is_listing_tool(activity)
            && let Some(listing) = content_body_source(activity)
        {
            let hint = listing_path(activity).map(|path| directory_display(workspace, &path));
            body = body.child(content_section(hint.as_deref(), listing, &id, theme));
        } else if let Some(output) = captured_output(activity) {
            if is_content_tool(activity) {
                body = body.child(content_section(None, output, &id, theme));
            } else {
                body = body.child(result_section(activity, output, &id, theme));
            }
        }
    }

    body
}

/// The italic description blockquote on the rail — the generic families'
/// input line.
fn blockquote(description: &str, theme: &Theme) -> Div {
    div()
        .min_w_0()
        .border_l_2()
        .border_color(tools_rail(theme))
        .pl(px(8.0))
        .text_size(sp(11.5))
        .line_height(sp(16.0))
        .italic()
        .text_color(tools_description(theme))
        .child(SharedString::from(description))
}
