//! Transcript activity presentation: icons, nouns, live-group titles,
//! disclosure sections, and diff-stat summaries. The legacy transcript view
//! and timeline_v2 both consume these.

use std::path::Path;
use uuid::Uuid;

use crate::app::transcript::format_worked_duration;
use crate::model::{ActivityItem, ActivityKind, ReasoningBlock};

pub(in crate::app) fn activity_icon(kind: ActivityKind) -> &'static str {
    match kind {
        ActivityKind::Reasoning => "icons/sparkle.svg",
        ActivityKind::Command => "icons/terminal.svg",
        ActivityKind::FileChange => "icons/pencil.svg",
        ActivityKind::FileRead => "icons/file.svg",
        ActivityKind::FileSearch => "icons/search.svg",
        ActivityKind::FileList => "icons/folder.svg",
        ActivityKind::Search => "icons/search.svg",
        ActivityKind::Plan => "icons/list.svg",
        ActivityKind::Compact => "icons/rewind.svg",
        ActivityKind::Tool => "icons/wrench.svg",
    }
}

pub(in crate::app) fn activity_noun(kind: ActivityKind) -> (String, String) {
    match kind {
        ActivityKind::Reasoning => (tr!("activity.thought"), tr!("activity.thoughts")),
        ActivityKind::Command => (tr!("activity.command"), tr!("activity.commands")),
        ActivityKind::FileChange => (tr!("activity.file_edit"), tr!("activity.file_edits")),
        ActivityKind::FileRead => (tr!("activity.file_read"), tr!("activity.file_reads")),
        ActivityKind::FileSearch => (tr!("activity.file_search"), tr!("activity.file_searches")),
        ActivityKind::FileList => (tr!("activity.file_list"), tr!("activity.file_lists")),
        ActivityKind::Search => (tr!("activity.search"), tr!("activity.searches")),
        ActivityKind::Plan => (tr!("activity.plan_step"), tr!("activity.plan_steps")),
        ActivityKind::Compact => (tr!("activity.compaction"), tr!("activity.compactions")),
        ActivityKind::Tool => (tr!("activity.tool_call"), tr!("activity.tool_calls")),
    }
}

pub(in crate::app) fn activity_summary(activities: &[ActivityItem]) -> String {
    let mut counts: Vec<(crate::model::ActivityKind, usize)> = Vec::new();
    for activity in activities {
        if let Some(entry) = counts.iter_mut().find(|(kind, _)| *kind == activity.kind) {
            entry.1 += 1;
        } else {
            counts.push((activity.kind, 1));
        }
    }
    let parts = counts
        .into_iter()
        .map(|(kind, count)| {
            let (singular, plural) = activity_noun(kind);
            tr!(
                "activity.count",
                count = count,
                activity = if count == 1 { singular } else { plural }
            )
        })
        .collect::<Vec<_>>();
    let running = activities.iter().any(|activity| !activity.complete);
    if running {
        tr!("activity.running", activities = parts.join(" · "))
    } else {
        tr!("activity.ran", activities = parts.join(" · "))
    }
}

pub(in crate::app) fn activity_group_is_live(
    live_turn: bool,
    latest_block: bool,
    after_message: usize,
    message_count: usize,
) -> bool {
    live_turn && latest_block && after_message == message_count
}

pub(in crate::app) fn activity_header_title(
    activities: &[ActivityItem],
    live_group: bool,
    live_reasoning_id: Option<Uuid>,
) -> String {
    if live_group && let Some(activity) = activities.last() {
        return activity.reasoning.as_ref().map_or_else(
            || activity_display_title(activity),
            |reasoning| reasoning_activity_title(reasoning, live_reasoning_id == Some(activity.id)),
        );
    }

    activity_summary(activities)
}

fn tool_name_leaf(name: &str) -> &str {
    let name = name.trim();
    let leaf = name.rsplit("__").next().unwrap_or(name);
    leaf.rsplit([':', '.', '/']).next().unwrap_or(leaf)
}

fn is_ask_user_question(activity: &ActivityItem) -> bool {
    activity.kind == crate::model::ActivityKind::Tool
        && tool_name_leaf(&activity.title)
            .chars()
            .filter(|character| !matches!(*character, '_' | '-' | ' '))
            .flat_map(char::to_lowercase)
            .collect::<String>()
            == "askuserquestion"
}

fn humanize_tool_name(name: &str) -> String {
    let name = name.trim();
    if name.chars().any(char::is_whitespace) {
        return name.to_owned();
    }

    let leaf = tool_name_leaf(name);
    let characters = leaf.chars().collect::<Vec<_>>();
    let mut display = String::with_capacity(leaf.len() + 4);
    for (index, character) in characters.iter().copied().enumerate() {
        if matches!(character, '_' | '-') {
            if !display.ends_with(' ') {
                display.push(' ');
            }
            continue;
        }
        let previous = index.checked_sub(1).and_then(|index| characters.get(index));
        let next = characters.get(index + 1);
        let starts_word = character.is_ascii_uppercase()
            && previous.is_some_and(|previous| {
                previous.is_ascii_lowercase()
                    || previous.is_ascii_digit()
                    || (previous.is_ascii_uppercase()
                        && next.is_some_and(|next| next.is_ascii_lowercase()))
            });
        if starts_word && !display.ends_with(' ') {
            display.push(' ');
        }
        display.push(character);
    }

    let display = display.trim();
    let mut characters = display.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
        .unwrap_or_else(|| tr!("activity.tool"))
}

fn activity_tool_display_name(activity: &ActivityItem) -> String {
    if is_ask_user_question(activity) {
        return tr!("activity.ask_questions");
    }
    if let Some(target) = activity
        .display_target
        .as_deref()
        .map(str::trim)
        .filter(|target| !target.is_empty())
    {
        return target.to_owned();
    }
    if !crate::model::is_generic_activity_title(activity.kind, &activity.title) {
        return humanize_tool_name(&activity.title);
    }
    tr!("activity.tool")
}

pub(in crate::app) fn activity_display_title(activity: &ActivityItem) -> String {
    use crate::model::ActivityKind;

    match activity.kind {
        ActivityKind::FileChange => {
            let subject = match activity.file_changes.as_slice() {
                [change] => Some(change.display_name().to_owned()),
                changes if !changes.is_empty() => {
                    Some(tr!("activity.file_count", count = changes.len()))
                }
                _ => None,
            };
            if subject.is_none()
                && !crate::model::is_generic_activity_title(activity.kind, &activity.title)
            {
                return activity.title.clone();
            }
            match (activity.complete, activity.failed, subject) {
                (false, _, Some(file)) => tr!("activity.editing_named_file", file = file),
                (true, false, Some(file)) => tr!("activity.edited_named_file", file = file),
                (true, true, Some(file)) => tr!("activity.edit_failed_named_file", file = file),
                (false, _, None) => tr!("activity.editing_files"),
                (true, false, None) => tr!("activity.edited_files"),
                (true, true, None) => tr!("activity.edit_failed"),
            }
        }
        ActivityKind::FileRead => {
            let file = activity.display_target.as_deref().map(activity_path_name);
            if file.is_none()
                && !crate::model::is_generic_activity_title(activity.kind, &activity.title)
            {
                return activity.title.clone();
            }
            match (activity.complete, activity.failed, file) {
                (false, _, Some(file)) => tr!("activity.reading_named_file", file = file),
                (true, false, Some(file)) => tr!("activity.read_named_file", file = file),
                (true, true, Some(file)) => tr!("activity.read_named_file_failed", file = file),
                (false, _, None) => tr!("activity.reading_file"),
                (true, false, None) => tr!("activity.read_file_completed"),
                (true, true, None) => tr!("activity.read_file_failed"),
            }
        }
        ActivityKind::FileSearch => {
            let query = activity.display_target.as_deref();
            if query.is_none()
                && !crate::model::is_generic_activity_title(activity.kind, &activity.title)
            {
                return activity.title.clone();
            }
            match (activity.complete, activity.failed, query) {
                (false, _, Some(query)) => tr!("activity.searching_files_for", query = query),
                (true, false, Some(query)) => tr!("activity.searched_files_for", query = query),
                (true, true, Some(query)) => tr!("activity.file_search_failed_for", query = query),
                (false, _, None) => tr!("activity.searching_files"),
                (true, false, None) => tr!("activity.searched_files"),
                (true, true, None) => tr!("activity.file_search_failed"),
            }
        }
        ActivityKind::FileList => {
            let directory = activity.display_target.as_deref().map(activity_path_name);
            if directory.is_none()
                && !crate::model::is_generic_activity_title(activity.kind, &activity.title)
            {
                return activity.title.clone();
            }
            match (activity.complete, activity.failed, directory) {
                (false, _, Some(directory)) => {
                    tr!("activity.listing_files_in", directory = directory)
                }
                (true, false, Some(directory)) => {
                    tr!("activity.listed_files_in", directory = directory)
                }
                (true, true, Some(directory)) => {
                    tr!("activity.file_list_failed_in", directory = directory)
                }
                (false, _, None) => tr!("activity.listing_files"),
                (true, false, None) => tr!("activity.listed_files"),
                (true, true, None) => tr!("activity.file_list_failed"),
            }
        }
        ActivityKind::Command => {
            if let Some(description) = activity.display_description.as_deref() {
                return match (activity.complete, activity.failed) {
                    (false, _) => {
                        tr!(
                            "activity.running_described_command",
                            description = description
                        )
                    }
                    (true, false) => {
                        tr!("activity.ran_described_command", description = description)
                    }
                    (true, true) => {
                        tr!(
                            "activity.described_command_failed",
                            description = description
                        )
                    }
                };
            }
            if let Some(command) = activity.display_target.as_deref() {
                return match (activity.complete, activity.failed) {
                    (false, _) => tr!("activity.running_named_command", command = command),
                    (true, false) => tr!("activity.ran_named_command", command = command),
                    (true, true) => tr!("activity.named_command_failed", command = command),
                };
            }
            if !crate::model::is_generic_activity_title(activity.kind, &activity.title) {
                return activity.title.clone();
            }
            match (activity.complete, activity.failed) {
                (false, _) => tr!("activity.running_command"),
                (true, false) => tr!("activity.ran_command"),
                (true, true) => tr!("activity.command_failed"),
            }
        }
        ActivityKind::Search => {
            if let Some(query) = activity.display_target.as_deref() {
                return match (activity.complete, activity.failed) {
                    (false, _) => tr!("activity.searching_web_for", query = query),
                    (true, false) => tr!("activity.searched_web_for", query = query),
                    (true, true) => tr!("activity.web_search_failed_for", query = query),
                };
            }
            if ActivityKind::from_tool_name(&activity.title) == ActivityKind::Search {
                return match (activity.complete, activity.failed) {
                    (false, _) => tr!("activity.searching_web"),
                    (true, false) => tr!("activity.searched_the_web"),
                    (true, true) => tr!("activity.web_search_failed"),
                };
            }
            activity.title.clone()
        }
        ActivityKind::Plan => {
            if !crate::model::is_generic_activity_title(activity.kind, &activity.title) {
                return activity.title.clone();
            }
            match (activity.complete, activity.failed) {
                (false, _) => tr!("activity.updating_plan"),
                (true, false) => tr!("activity.updated_plan"),
                (true, true) => tr!("activity.plan_update_failed"),
            }
        }
        ActivityKind::Compact => {
            if !crate::model::is_generic_activity_title(activity.kind, &activity.title) {
                return activity.title.clone();
            }
            match (activity.complete, activity.failed) {
                (false, _) => tr!("activity.compacting"),
                (true, false) => tr!("activity.compacted"),
                (true, true) => tr!("activity.compaction_failed"),
            }
        }
        ActivityKind::Tool => activity_tool_display_name(activity),
        ActivityKind::Reasoning => activity.title.clone(),
    }
}

pub(in crate::app) fn activity_action_label(activity: &ActivityItem) -> String {
    use crate::model::ActivityKind;

    match activity.kind {
        ActivityKind::Reasoning => tr!("activity.action_think"),
        ActivityKind::Command => tr!("activity.action_run"),
        ActivityKind::FileChange => tr!("activity.action_edit"),
        ActivityKind::FileRead => tr!("activity.action_read"),
        ActivityKind::FileSearch | ActivityKind::Search => tr!("activity.action_search"),
        ActivityKind::FileList => tr!("activity.action_list"),
        ActivityKind::Plan => tr!("activity.action_plan"),
        ActivityKind::Tool if is_ask_user_question(activity) => tr!("activity.ask_questions"),
        ActivityKind::Compact => tr!("activity.action_compact"),
        ActivityKind::Tool => tr!("activity.tool"),
    }
}

pub(in crate::app) fn activity_row_detail(activity: &ActivityItem, reasoning_live: bool) -> String {
    use crate::model::ActivityKind;

    let custom_title = || {
        (!crate::model::is_generic_activity_title(activity.kind, &activity.title))
            .then(|| activity.title.clone())
    };
    match activity.kind {
        ActivityKind::Reasoning => activity.reasoning.as_ref().map_or_else(
            || activity.title.clone(),
            |reasoning| reasoning_activity_title(reasoning, reasoning_live),
        ),
        ActivityKind::Command => activity
            .display_description
            .clone()
            .or_else(|| activity.display_target.clone())
            .or_else(custom_title)
            .unwrap_or_default(),
        ActivityKind::FileChange => match activity.file_changes.as_slice() {
            [change] => change.display_name().to_owned(),
            changes if !changes.is_empty() => {
                tr!("activity.file_count", count = changes.len())
            }
            _ => custom_title().unwrap_or_default(),
        },
        ActivityKind::FileRead | ActivityKind::FileList => activity
            .display_target
            .as_deref()
            .map(activity_path_name)
            .or_else(custom_title)
            .unwrap_or_default(),
        ActivityKind::FileSearch => activity_display_title(activity),
        ActivityKind::Search => activity.display_target.as_deref().map_or_else(
            || custom_title().unwrap_or_default(),
            |query| tr!("activity.search_for", query = query),
        ),
        ActivityKind::Compact | ActivityKind::Plan => custom_title().unwrap_or_default(),
        ActivityKind::Tool if is_ask_user_question(activity) => String::new(),
        ActivityKind::Tool => {
            let has_name = activity
                .display_target
                .as_deref()
                .is_some_and(|target| !target.trim().is_empty())
                || !crate::model::is_generic_activity_title(activity.kind, &activity.title);
            has_name
                .then(|| activity_tool_display_name(activity))
                .unwrap_or_default()
        }
    }
}

pub(in crate::app) fn reasoning_activity_title(reasoning: &ReasoningBlock, live: bool) -> String {
    if live {
        tr!("transcript.thinking")
    } else {
        tr!(
            "transcript.thought_for",
            duration = format_worked_duration(
                reasoning
                    .finished_at_ms
                    .saturating_sub(reasoning.started_at_ms)
                    .div_ceil(1000)
                    .max(1)
            )
        )
    }
}

fn activity_path_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_owned()
}

/// Whether this activity's expanded view shows a diff instead of the tool
/// arguments that produced it.
pub(in crate::app) fn activity_shows_diff(activity: &ActivityItem) -> bool {
    activity.kind == ActivityKind::FileChange
        && activity
            .file_changes
            .iter()
            .any(|change| change.diff.is_some())
}

pub(in crate::app) fn activity_file_change_stats(activity: &ActivityItem) -> Option<(u64, u64)> {
    if activity.kind != crate::model::ActivityKind::FileChange
        || !activity.complete
        || activity.failed
        || activity.file_changes.is_empty()
    {
        return None;
    }
    let additions = activity
        .file_changes
        .iter()
        .map(|change| change.additions)
        .sum::<Option<u64>>()?;
    let deletions = activity
        .file_changes
        .iter()
        .map(|change| change.deletions)
        .sum::<Option<u64>>()?;
    Some((additions, deletions))
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(in crate::app) enum ActivityDisclosureSectionKind {
    Command,
    Arguments,
    Output,
    Detail,
}

impl ActivityDisclosureSectionKind {
    pub(in crate::app) fn id(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Arguments => "arguments",
            Self::Output => "output",
            Self::Detail => "detail",
        }
    }

    pub(in crate::app) fn label(self) -> Option<String> {
        match self {
            Self::Command => Some(tr!("activity.command_detail")),
            Self::Arguments => Some(tr!("activity.arguments")),
            Self::Output => Some(tr!("activity.output")),
            Self::Detail => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::app) struct ActivityDisclosureSection {
    pub(in crate::app) kind: ActivityDisclosureSectionKind,
    pub(in crate::app) content: String,
}

pub(in crate::app) fn activity_disclosure_sections(
    activity: &ActivityItem,
) -> Vec<ActivityDisclosureSection> {
    let mut sections = Vec::new();
    if activity.kind == ActivityKind::Command {
        if let Some(command) = activity
            .arguments
            .as_deref()
            .or(activity.display_target.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            sections.push(ActivityDisclosureSection {
                kind: ActivityDisclosureSectionKind::Command,
                content: command.to_owned(),
            });
        }
        if let Some(output) = activity
            .output
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            sections.push(ActivityDisclosureSection {
                kind: ActivityDisclosureSectionKind::Output,
                content: output.to_owned(),
            });
        } else if !activity.image_urls.is_empty() {
            sections.push(ActivityDisclosureSection {
                kind: ActivityDisclosureSectionKind::Output,
                content: String::new(),
            });
        }
        return sections;
    }
    // An edit renders as a diff, which says everything the raw arguments would
    // and reads. What the tool replied is only worth the room when it failed.
    let shows_diff = activity_shows_diff(activity);
    if let Some(arguments) = activity
        .arguments
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|_| !shows_diff)
    {
        sections.push(ActivityDisclosureSection {
            kind: ActivityDisclosureSectionKind::Arguments,
            content: arguments.to_owned(),
        });
    }
    if let Some(output) = activity
        .output
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|_| !shows_diff || activity.failed)
    {
        sections.push(ActivityDisclosureSection {
            kind: ActivityDisclosureSectionKind::Output,
            content: output.to_owned(),
        });
    } else if !activity.image_urls.is_empty() {
        sections.push(ActivityDisclosureSection {
            kind: ActivityDisclosureSectionKind::Output,
            content: String::new(),
        });
    }
    if sections.is_empty()
        && let Some(detail) = activity
            .detail
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        sections.push(ActivityDisclosureSection {
            kind: ActivityDisclosureSectionKind::Detail,
            content: detail.to_owned(),
        });
    }
    sections
}

pub(in crate::app) fn activity_preview(activity: &ActivityItem) -> String {
    let detail = activity.detail.as_deref().unwrap_or_default().trim();
    if detail.eq_ignore_ascii_case("failed")
        && let Some(output) = activity.output.as_deref()
        && let Some(first_line) = output.lines().find(|line| !line.trim().is_empty())
    {
        return first_line.trim().to_owned();
    }
    if (detail.is_empty() || detail.eq_ignore_ascii_case("failed"))
        && !activity.image_urls.is_empty()
    {
        return tr!("activity.image_output");
    }
    detail.to_owned()
}

#[cfg(test)]
mod icon_tests {
    use crate::assets::Assets;
    use crate::model::ActivityKind;
    use gpui::AssetSource;

    #[test]
    fn every_activity_icon_is_embedded() {
        for kind in [
            ActivityKind::Reasoning,
            ActivityKind::Command,
            ActivityKind::FileChange,
            ActivityKind::FileRead,
            ActivityKind::FileSearch,
            ActivityKind::FileList,
            ActivityKind::Search,
            ActivityKind::Plan,
            ActivityKind::Compact,
            ActivityKind::Tool,
        ] {
            let path = super::activity_icon(kind);
            assert!(
                Assets.load(path).unwrap().is_some(),
                "missing embedded icon: {path}"
            );
        }
    }
}

#[cfg(test)]
mod activity_tests {
    use super::*;

    /// Test-only rendering of disclosure sections into plain text; production
    /// renders them interactively via [`activity_disclosure_sections`].
    fn activity_disclosure_text(activity: &ActivityItem) -> Option<String> {
        let sections = activity_disclosure_sections(activity);
        (!sections.is_empty()).then(|| {
            sections
                .into_iter()
                .map(
                    |section| match (section.kind.label(), section.content.is_empty()) {
                        (Some(label), false) => format!("{label}\n{}", section.content),
                        (Some(label), true) => label.to_owned(),
                        (None, _) => section.content,
                    },
                )
                .collect::<Vec<_>>()
                .join("\n\n")
        })
    }

    #[test]
    fn activity_disclosure_keeps_arguments_and_output() {
        let activity = ActivityItem::new(
            Some("tool-1".into()),
            crate::model::ActivityKind::Tool,
            "Use Helium",
            Some("failed".into()),
            true,
        )
        .with_arguments(Some("{\n  \"actions\": []\n}".into()))
        .with_output(Some("Computer Use helper closed its session".into()))
        .with_failed(true);

        assert_eq!(
            activity_disclosure_sections(&activity),
            vec![
                ActivityDisclosureSection {
                    kind: ActivityDisclosureSectionKind::Arguments,
                    content: "{\n  \"actions\": []\n}".into(),
                },
                ActivityDisclosureSection {
                    kind: ActivityDisclosureSectionKind::Output,
                    content: "Computer Use helper closed its session".into(),
                },
            ]
        );
        assert_eq!(
            activity_disclosure_text(&activity).as_deref(),
            Some(
                "Arguments\n{\n  \"actions\": []\n}\n\nOutput\nComputer Use helper closed its session"
            )
        );
        assert_eq!(
            activity_preview(&activity),
            "Computer Use helper closed its session"
        );

        let image_only = ActivityItem::new(
            Some("tool-2".into()),
            crate::model::ActivityKind::Tool,
            "Screenshot",
            None,
            true,
        )
        .with_image_urls(vec!["data:image/png;base64,aGVsbG8=".into()]);
        assert_eq!(
            activity_disclosure_text(&image_only).as_deref(),
            Some("Output")
        );
        assert_eq!(activity_preview(&image_only), "Image output");
    }

    #[test]
    fn command_disclosure_shows_only_the_command_and_output() {
        let activity = ActivityItem::new(
            Some("command-1".into()),
            crate::model::ActivityKind::Command,
            "bash",
            Some("Completed".into()),
            true,
        )
        .with_arguments(Some(
            r#"{"command":"git status --short","description":"Check status"}"#.into(),
        ))
        .with_output(Some("clean".into()));

        assert_eq!(
            activity_disclosure_sections(&activity),
            vec![
                ActivityDisclosureSection {
                    kind: ActivityDisclosureSectionKind::Command,
                    content: "git status --short".into(),
                },
                ActivityDisclosureSection {
                    kind: ActivityDisclosureSectionKind::Output,
                    content: "clean".into(),
                },
            ]
        );
        assert_eq!(
            activity_disclosure_text(&activity).as_deref(),
            Some("Command\ngit status --short\n\nOutput\nclean")
        );
    }

    #[test]
    fn activity_display_title_prefers_the_human_facing_tool_argument() {
        let titled = ActivityItem::new(
            Some("tool-1".into()),
            crate::model::ActivityKind::Tool,
            "Js",
            None,
            true,
        )
        .with_arguments(Some(
            r#"{"title":"Inspect Helium browser","code":"sky.get_app_state()"}"#.into(),
        ));
        let untitled = ActivityItem::new(
            Some("tool-2".into()),
            crate::model::ActivityKind::Tool,
            "Js",
            None,
            true,
        )
        .with_arguments(Some(r#"{"code":"sky.list_apps()"}"#.into()));

        assert_eq!(activity_display_title(&titled), "Inspect Helium browser");
        assert_eq!(activity_display_title(&untitled), "Js");
    }

    #[test]
    fn generic_tool_rows_keep_a_humanized_provider_name() {
        let named = ActivityItem::new(
            Some("tool-1".into()),
            crate::model::ActivityKind::Tool,
            "mcp__threads__create_thread",
            None,
            true,
        );
        let unnamed = ActivityItem::new(
            Some("tool-2".into()),
            crate::model::ActivityKind::Tool,
            "Tool",
            None,
            true,
        );

        assert_eq!(activity_action_label(&named), "Tool");
        assert_eq!(activity_row_detail(&named, false), "Create thread");
        assert_eq!(activity_display_title(&named), "Create thread");
        assert_eq!(activity_action_label(&unnamed), "Tool");
        assert_eq!(activity_row_detail(&unnamed, false), "");
    }

    #[test]
    fn ask_user_question_has_a_purpose_specific_label() {
        let activity = ActivityItem::new(
            Some("tool-1".into()),
            crate::model::ActivityKind::Tool,
            "AskUserQuestion",
            None,
            true,
        )
        .with_arguments(Some(r#"{"questions":[]}"#.into()));

        assert_eq!(activity_action_label(&activity), "Ask questions");
        assert_eq!(activity_row_detail(&activity, false), "");
        assert_eq!(activity_display_title(&activity), "Ask questions");
    }

    #[test]
    fn activity_header_summarizes_only_after_the_group_leaves_the_live_tail() {
        let reasoning = ActivityItem::from_reasoning(
            ReasoningBlock {
                content: "Inspecting history".into(),
                started_at_ms: 1_000,
                finished_at_ms: 2_000,
            },
            true,
        );
        let command = ActivityItem::new(
            Some("command-1".into()),
            crate::model::ActivityKind::Command,
            "bash",
            None,
            false,
        )
        .with_arguments(Some(
            serde_json::json!({"command": "git log --oneline -15"}).to_string(),
        ));
        let mut activities = vec![reasoning, command];

        assert_eq!(
            activity_header_title(&activities, true, None),
            "Running git log --oneline -15"
        );
        assert!(activity_group_is_live(true, true, 1, 1));
        activities[1].complete = true;
        assert_eq!(
            activity_header_title(&activities, true, None),
            "Ran git log --oneline -15"
        );
        assert!(!activity_group_is_live(true, true, 1, 2));
        assert_eq!(
            activity_header_title(&activities, false, None),
            "Ran 1 thought · 1 command"
        );
        assert!(!activity_group_is_live(true, false, 1, 1));
        assert!(!activity_group_is_live(false, true, 1, 1));
        assert_eq!(activity_action_label(&activities[1]), "Run");
        assert_eq!(
            activity_row_detail(&activities[1], false),
            "git log --oneline -15"
        );
    }

    #[test]
    fn file_edit_title_and_stats_follow_the_activity_state() {
        let mut activity = ActivityItem::new(
            Some("edit-1".into()),
            crate::model::ActivityKind::FileChange,
            "apply_patch",
            None,
            false,
        )
        .with_arguments(Some(
            serde_json::json!({
                "patch": "*** Begin Patch\n*** Update File: /tmp/tide/src/app.rs\n@@\n-old\n+new\n+more\n*** End Patch"
            })
            .to_string(),
        ));

        assert_eq!(activity_display_title(&activity), "Editing app.rs");
        assert_eq!(activity_file_change_stats(&activity), None);

        activity.complete = true;
        assert_eq!(activity_display_title(&activity), "Edited app.rs");
        assert_eq!(activity_file_change_stats(&activity), Some((2, 1)));

        activity.failed = true;
        assert_eq!(activity_display_title(&activity), "Failed to edit app.rs");
        assert_eq!(activity_file_change_stats(&activity), None);
    }

    #[test]
    fn multi_file_edits_use_a_compact_count() {
        let activity = ActivityItem::new(
            Some("edit-2".into()),
            crate::model::ActivityKind::FileChange,
            "apply_patch",
            None,
            true,
        )
        .with_arguments(Some(
            serde_json::json!({
                "patch": "*** Begin Patch\n*** Update File: src/a.rs\n@@\n-a\n+b\n*** Update File: src/b.rs\n@@\n-c\n+d\n*** End Patch"
            })
            .to_string(),
        ));

        assert_eq!(activity_display_title(&activity), "Edited 2 files");
        assert_eq!(activity_file_change_stats(&activity), Some((2, 2)));
    }

    #[test]
    fn file_tool_titles_include_the_target_and_state() {
        let mut read = ActivityItem::new(
            Some("read-1".into()),
            crate::model::ActivityKind::FileRead,
            "read",
            None,
            false,
        )
        .with_arguments(Some(
            serde_json::json!({"filePath": "/tmp/tide/src/model.rs"}).to_string(),
        ));
        assert_eq!(activity_display_title(&read), "Reading model.rs");
        read.complete = true;
        assert_eq!(activity_display_title(&read), "Read model.rs");
        read.failed = true;
        assert_eq!(activity_display_title(&read), "Failed to read model.rs");

        let search = ActivityItem::new(
            Some("grep-1".into()),
            crate::model::ActivityKind::FileSearch,
            "grep",
            None,
            true,
        )
        .with_arguments(Some(
            serde_json::json!({"pattern": "ActivityKind"}).to_string(),
        ));
        assert_eq!(
            activity_display_title(&search),
            "Searched files for ActivityKind"
        );

        let list = ActivityItem::new(
            Some("list-1".into()),
            crate::model::ActivityKind::FileList,
            "ls",
            None,
            false,
        )
        .with_arguments(Some(
            serde_json::json!({"path": "/tmp/tide/src"}).to_string(),
        ));
        assert_eq!(activity_display_title(&list), "Listing files in src");

        let custom = ActivityItem::new(
            Some("read-2".into()),
            crate::model::ActivityKind::FileRead,
            "Inspect generated manifest",
            None,
            true,
        );
        assert_eq!(
            activity_display_title(&custom),
            "Inspect generated manifest"
        );
    }

    #[test]
    fn command_web_search_and_plan_titles_include_their_state() {
        let mut command = ActivityItem::new(
            Some("command-1".into()),
            crate::model::ActivityKind::Command,
            "bash",
            None,
            true,
        )
        .with_arguments(Some(
            serde_json::json!({
                "description": "Run focused tests",
                "command": "cargo test activity"
            })
            .to_string(),
        ));
        assert_eq!(
            activity_display_title(&command),
            "Ran command: Run focused tests"
        );
        command.complete = false;
        assert_eq!(
            activity_display_title(&command),
            "Running command: Run focused tests"
        );

        let web_search = ActivityItem::new(
            Some("search-1".into()),
            crate::model::ActivityKind::Search,
            "web_search",
            None,
            true,
        )
        .with_arguments(Some(serde_json::json!({"query": "Tide GPUI"}).to_string()));
        assert_eq!(
            activity_display_title(&web_search),
            "Searched the web for Tide GPUI"
        );

        let plan = ActivityItem::new(
            Some("plan-1".into()),
            crate::model::ActivityKind::Plan,
            "update_plan",
            None,
            false,
        );
        assert_eq!(activity_display_title(&plan), "Updating plan");
    }
}
