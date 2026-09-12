//! The turn container: the settled turn's footer and the spacing that
//! separates one turn from the next. The footer is tide's assistant-turn
//! meta strip — a 24px row reading the usage and turn-time triggers beside
//! the start clock, with Copy and Branch actions and the turn's
//! wall-clock duration.
//!
//! Rewind is deliberately absent: it needs the rewind command path, which
//! this pane cannot reach without the closure seam Task 17 builds. A dead
//! button would lie, so nothing renders in its place.
//!
//! This is also the structural home for the turn's outer spacing (12px
//! between turns, flush at the session's first) and — later — T17's sticky
//! user header.

use super::super::{TimelineV2Row, tools_dim, tools_rail};
use crate::md::render::MONO_FAMILY;
use crate::model::{AgentSession, AgentTurn, MessageRole, UsageBreakdown};
use crate::theme::{Theme, sp};
use crate::ui::icon;
use crate::ui::menu::{ContextMenuHandle, MenuAlign, popover};
use crate::ui::motion;
use crate::ui::tooltip::Tooltip;
use crate::usage::format_tokens;
use gpui::prelude::*;
use gpui::{
    AnyElement, ClickEvent, Div, FontWeight, Pixels, SharedString, Stateful, Window, div, px,
};
use uuid::Uuid;

/// Whole-second durations as tide reads them: "5s" under the minute, then
/// "1m 0s"-style minute/second pairs. No hours — a turn that long still
/// reads honestly as minutes.
pub(crate) fn format_duration(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m {}s", secs / 60, secs % 60)
    }
}

/// The model name a footer shows: the segment after the last `/` when the
/// id is namespaced (`anthropic/claude-opus-4.6` → `claude-opus-4.6`), the
/// whole id otherwise. `None` hides the segment — the runtime's
/// probe-based display name lives on `Tide` and is not importable here, so
/// this small slice of it is copied fresh.
pub(crate) fn model_segment(model: Option<&str>) -> Option<&str> {
    model.map(|model| model.rsplit('/').next().unwrap_or(model))
}

/// A settled turn's wall-clock duration: `completed_at - started_at`,
/// floored at zero. `None` while the turn runs — the working footer owns
/// the live ticker.
pub(crate) fn turn_duration(turn: &AgentTurn) -> Option<u64> {
    turn.completed_at
        .map(|completed| completed.saturating_sub(turn.started_at))
}

/// Space above a turn's first row: the session's first turn sits flush,
/// every later one gets the 12px between-turns gap. Pure — the list applies
/// it in its row wrapper.
pub(crate) fn turn_top_spacing(is_first_turn: bool) -> Pixels {
    if is_first_turn { px(0.0) } else { px(12.0) }
}

/// The session turn a row belongs to, as an index into `session.turns`.
/// Messages resolve through their `turn_id`, activity groups through their
/// block's; the footer rows carry their turn directly. `None` when the row
/// names no turn (or one the session no longer holds). The nav rail walks
/// the same rule to find turn boundaries.
pub(crate) fn row_turn_ix(session: &AgentSession, row: TimelineV2Row) -> Option<usize> {
    let turn_id = match row {
        TimelineV2Row::Message { index } => session.messages.get(index)?.turn_id?,
        TimelineV2Row::ActivityGroup { block } => session.transcript_blocks.get(block)?.turn_id?,
        TimelineV2Row::TurnFooter { turn } => return session.turns.get(turn).map(|_| turn),
        TimelineV2Row::ChangedFiles { turn } => return session.turns.get(turn).map(|_| turn),
        TimelineV2Row::Working => return session.turns.len().checked_sub(1),
    };
    session.turns.iter().position(|turn| turn.id == turn_id)
}

/// Top spacing for row `ix` of the derived row list: 12px when the row
/// opens a turn that is not the session's first, zero otherwise. A row
/// opens its turn when the row above it belongs to a different one (or
/// nothing does); the first row to belong to any turn is the session's
/// first turn. Footers and the working row can never open a turn by
/// construction — they trail their own turn's rows — but the rule needs no
/// special case for them: their predecessor is always same-turn.
pub(crate) fn spacing_before(session: &AgentSession, rows: &[TimelineV2Row], ix: usize) -> Pixels {
    let Some(turn) = rows
        .get(ix)
        .copied()
        .and_then(|row| row_turn_ix(session, row))
    else {
        return px(0.0);
    };
    let continues_turn = ix
        .checked_sub(1)
        .and_then(|prev| rows.get(prev).copied())
        .and_then(|row| row_turn_ix(session, row))
        .is_some_and(|prev_turn| prev_turn == turn);
    if continues_turn {
        return px(0.0);
    }
    let is_first_turn = (0..ix).all(|prev| {
        rows.get(prev)
            .copied()
            .and_then(|row| row_turn_ix(session, row))
            .is_none()
    });
    turn_top_spacing(is_first_turn)
}

/// The text Copy puts on the clipboard: the turn's latest assistant reply,
/// visible form (display content when the provider-facing text was
/// decorated). `None` when the turn produced no answer to copy.
pub(crate) fn last_assistant_text(session: &AgentSession, turn_id: Uuid) -> Option<String> {
    session
        .messages
        .iter()
        .rev()
        .find(|message| message.turn_id == Some(turn_id) && message.role == MessageRole::Assistant)
        .map(|message| message.visible_content().to_owned())
}

/// The turn's start time as a local HH:MM clock reading. Tide has no
/// shared `format_time` helper the pane can reach (the legacy pane's is
/// day-relative and lives behind legacy coupling), so the footer reads the
/// clock directly — chrono is already a dependency. The user bubble's hover
/// footer reuses it, so it is `pub(crate)`.
pub(crate) fn clock_time(unix_secs: u64) -> String {
    i64::try_from(unix_secs)
        .ok()
        .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
        .map(|timestamp| {
            timestamp
                .with_timezone(&chrono::Local)
                .format("%H:%M")
                .to_string()
        })
        .unwrap_or_default()
}

/// The usage facts a footer's usage and turn-time triggers present. Main
/// turns build them from the in-memory per-turn fold; a sub-agent turn
/// carries its run's settled totals, so its speed and TTFT stay `None`.
#[derive(Clone, Debug)]
pub(crate) struct TurnFooterUsage {
    pub(crate) usage: UsageBreakdown,
    /// The model route the usage panel names, DSH's "Provider / model" row.
    pub(crate) routes: Option<SharedString>,
    /// Output tokens over model-stream seconds; `None` when the run did not
    /// measure stream time.
    pub(crate) tps: Option<f64>,
    pub(crate) ttft_ms: Option<u64>,
}

/// The branch gate for "fork into a new session": `None` hides the button
/// (a sub-agent run has no session to fork into); `enabled` mirrors the
/// legacy pane's preconditions, `preparing` marks this exact turn's fork.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TurnFooterBranch {
    pub(crate) enabled: bool,
    pub(crate) preparing: bool,
}

/// Whole tokens with thousands separators — the usage panel's exact counts,
/// DSH's `formatExactCount` ("123,456 tok" once the locale suffix joins).
fn exact_tokens(value: u64) -> String {
    let digits = value.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// One label-over-value row of the two trigger panels: dim label left, mono
/// value right, hairline separated by the panel's own spacing. `label` is
/// the locale key.
fn trigger_panel_row(label: &'static str, value: SharedString, theme: &Theme) -> Div {
    div()
        .flex()
        .items_baseline()
        .justify_between()
        .gap(px(12.0))
        .child(
            div()
                .text_size(sp(11.0))
                .text_color(theme.text_tertiary)
                .child(tr!(label)),
        )
        .child(
            div()
                .font_family(MONO_FAMILY)
                .text_size(sp(11.0))
                .text_color(theme.text_secondary)
                .child(value),
        )
}

/// A footer trigger: icon plus dim label in a hover-tinted 22px pill, the
/// shape every footer action shares.
fn footer_trigger(
    id: SharedString,
    icon_path: &'static str,
    label: SharedString,
    theme: &Theme,
) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(22.0))
        .px(px(5.0))
        .rounded(px(5.0))
        .flex()
        .items_center()
        .gap(px(4.0))
        .cursor_default()
        .hover(|style| style.bg(theme.overlay))
        .child(icon(icon_path, 12.0, tools_dim(theme)))
        .child(
            div()
                .text_size(sp(11.0))
                .text_color(tools_dim(theme))
                .child(label),
        )
}

/// The settled turn's footer: a borderless 24px meta row —
/// hover-revealed Copy and Branch actions, then the usage and turn-time
/// triggers, then the start clock. Missing segments hide; `on_copy` and
/// `on_branch` are threaded from the callers because only they hold the app
/// context (the fork path runs `fork_session_from_response`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_turn_footer(
    turn_id: Uuid,
    duration: Option<u64>,
    started_at: u64,
    usage_menu: &ContextMenuHandle,
    time_menu: &ContextMenuHandle,
    usage: Option<TurnFooterUsage>,
    branch: Option<TurnFooterBranch>,
    on_branch: impl Fn(&ClickEvent, &mut Window, &mut gpui::App) + 'static,
    copy_text: Option<&str>,
    theme: &Theme,
    on_copy: impl Fn(&ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> Div {
    let mut meta: Vec<AnyElement> = Vec::new();

    // Copy and Branch render unconditionally — the same always-visible
    // treatment as the triggers beside them, one shared icon color.
    if copy_text.is_some_and(|text| !text.is_empty()) {
        meta.push(
            div()
                .id(SharedString::from(format!("turn-copy-{turn_id}")))
                .size(px(22.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_default()
                .hover(|style| style.bg(theme.overlay))
                .child(icon("icons/copy.svg", 12.0, tools_dim(theme)))
                .tooltip(Tooltip::text(tr!("common.copy_message")))
                .on_click(move |event, window, cx| on_copy(event, window, cx))
                .into_any_element(),
        );
    }
    if let Some(branch) = branch {
        let branch_icon: AnyElement = if branch.preparing {
            motion::spin(icon("icons/loader-circle.svg", 12.0, tools_dim(theme)))
        } else {
            icon("icons/fork.svg", 12.0, tools_dim(theme)).into_any_element()
        };
        let button = div()
            .id(SharedString::from(format!("turn-branch-{turn_id}")))
            .size(px(22.0))
            .rounded(px(6.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .hover(|style| style.bg(theme.overlay))
            .when(!branch.enabled && !branch.preparing, |element| {
                element.opacity(0.45)
            })
            .child(branch_icon)
            .tooltip(Tooltip::text(if branch.preparing {
                tr!("session.forking_task")
            } else if branch.enabled {
                tr!("session.fork_task")
            } else {
                tr!("session.response_cannot_fork")
            }))
            .when(branch.enabled, |element| {
                element.on_click(move |event, window, cx| on_branch(event, window, cx))
            });
        meta.push(button.into_any_element());
    }

    // The usage trigger: compact total in the row, DSH's exact breakdown in
    // the click-open panel above it. The facts destructure up front so the
    // time trigger's closure can take the Copy fields without fighting the
    // usage closure's move. The speed facts lift out first — the turn-time
    // trigger reads them in its own block below.
    let speed = usage
        .as_ref()
        .map(|TurnFooterUsage { tps, ttft_ms, .. }| (*tps, *ttft_ms));
    let (tps, ttft_ms) = speed.unwrap_or((None, None));
    if let Some(facts) = usage {
        let TurnFooterUsage { usage, routes, .. } = facts;
        let total = usage.input_tokens + usage.output_tokens + usage.cache_read + usage.cache_write;
        meta.push(
            popover(
                footer_trigger(
                    SharedString::from(format!("turn-usage-trigger-{turn_id}")),
                    "icons/database.svg",
                    SharedString::from(format!("{} {}", tr!("turn.usage"), format_tokens(total))),
                    theme,
                ),
                usage_menu,
                MenuAlign::AboveLeft,
                move |handle, _, cx| {
                    let theme = Theme::current(cx);
                    let prompt_side = total.saturating_sub(usage.output_tokens);
                    let cache_hit = (usage.cache_read > 0 && prompt_side > 0).then(|| {
                        let percent = usage.cache_read as f64 * 100.0 / prompt_side as f64;
                        if percent >= 99.95 {
                            format!("{percent:.2}%")
                        } else {
                            format!("{percent:.1}%")
                        }
                    });
                    let output = SharedString::from(if usage.reasoning_tokens > 0 {
                        tr!(
                            "turn.output_reasoning",
                            tokens = exact_tokens(usage.output_tokens),
                            reasoning = exact_tokens(usage.reasoning_tokens)
                        )
                    } else {
                        tr!(
                            "turn.tok",
                            count = exact_tokens(usage.output_tokens).as_str()
                        )
                    });
                    let panel = div()
                        .track_focus(handle.focus_handle())
                        .w(px(300.0))
                        .p(px(12.0))
                        .rounded(px(10.0))
                        .border_1()
                        .border_color(theme.border_strong)
                        .bg(theme.raised)
                        .shadow_lg()
                        .flex()
                        .flex_col()
                        .gap(px(7.0))
                        .child(
                            div()
                                .flex()
                                .items_baseline()
                                .justify_between()
                                .gap(px(12.0))
                                .child(
                                    div()
                                        .text_size(sp(11.0))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.text_tertiary)
                                        .child(tr!("turn.usage_title")),
                                )
                                .child(
                                    div()
                                        .font_family(MONO_FAMILY)
                                        .text_size(sp(11.0))
                                        .text_color(theme.text_secondary)
                                        .child(SharedString::from(format!(
                                            "{} {}",
                                            exact_tokens(total),
                                            tr!("turn.tok_suffix")
                                        ))),
                                ),
                        )
                        .child(div().h(px(0.5)).w_full().bg(tools_rail(&theme)))
                        .children(
                            routes.clone().map(|routes| {
                                trigger_panel_row("turn.provider_model", routes, &theme)
                            }),
                        )
                        .children(cache_hit.map(|percent| {
                            trigger_panel_row("turn.cache_hit", SharedString::from(percent), &theme)
                        }))
                        .child(trigger_panel_row(
                            "turn.uncached_input",
                            SharedString::from(format!(
                                "{} {}",
                                exact_tokens(usage.input_tokens),
                                tr!("turn.tok_suffix")
                            )),
                            &theme,
                        ))
                        .child(trigger_panel_row(
                            "turn.cached_input",
                            SharedString::from(format!(
                                "{} {}",
                                exact_tokens(usage.cache_read),
                                tr!("turn.tok_suffix")
                            )),
                            &theme,
                        ))
                        .child(trigger_panel_row(
                            "turn.cache_write",
                            SharedString::from(format!(
                                "{} {}",
                                exact_tokens(usage.cache_write),
                                tr!("turn.tok_suffix")
                            )),
                            &theme,
                        ))
                        .child(trigger_panel_row("turn.output", output, &theme));
                    panel.into_any_element()
                },
            )
            .into_any_element(),
        );
    }

    // The turn-time trigger: "Ran for" in the row, run time plus the
    // measured speed facts in the panel.
    if let Some(secs) = duration {
        let trigger = footer_trigger(
            SharedString::from(format!("turn-time-trigger-{turn_id}")),
            "icons/clock.svg",
            SharedString::from(tr!("turn.ran_for", duration = format_duration(secs))),
            theme,
        );
        meta.push(
            popover(
                trigger,
                time_menu,
                MenuAlign::AboveLeft,
                move |handle, _, cx| {
                    let theme = Theme::current(cx);
                    let mut panel = div()
                        .track_focus(handle.focus_handle())
                        .w(px(280.0))
                        .p(px(12.0))
                        .rounded(px(10.0))
                        .border_1()
                        .border_color(theme.border_strong)
                        .bg(theme.raised)
                        .shadow_lg()
                        .flex()
                        .flex_col()
                        .gap(px(7.0))
                        .child(
                            div()
                                .text_size(sp(11.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_tertiary)
                                .child(tr!("turn.time_title")),
                        )
                        .child(div().h(px(0.5)).w_full().bg(tools_rail(&theme)))
                        .child(trigger_panel_row(
                            "turn.total_run_time",
                            SharedString::from(format_duration(secs)),
                            &theme,
                        ));
                    if let Some(tps) = tps {
                        panel = panel.child(trigger_panel_row(
                            "turn.tps",
                            SharedString::from(tr!(
                                "turn.tok_per_second",
                                tps = format!("{tps:.1}")
                            )),
                            &theme,
                        ));
                    }
                    if let Some(ttft_ms) = ttft_ms {
                        panel = panel.child(trigger_panel_row(
                            "turn.ttft",
                            SharedString::from(format!("{:.1}s", ttft_ms as f64 / 1000.0)),
                            &theme,
                        ));
                    }
                    panel.into_any_element()
                },
            )
            .into_any_element(),
        );
    }

    let clock = clock_time(started_at);
    if !clock.is_empty() {
        meta.push(
            div()
                .text_size(sp(11.0))
                .text_color(theme.text_ghost)
                .child(SharedString::from(clock))
                .into_any_element(),
        );
    }

    let row = div()
        .mt(px(6.0))
        .mb(px(8.0))
        .h(px(24.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .children(meta);

    row
}
