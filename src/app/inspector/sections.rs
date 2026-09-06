//! Section bodies for the inspector column, with content parity to upstream
//! tide's Electron InspectorTab: Session hero, Configuration, Git, and the
//! Stream log. Data fns are pure — extracted session state in,
//! render-ready structs out — and each renderer reads only what its data fn
//! prepared, never app state directly. The Context Window detail moved to
//! the footer usage meter's panel (usage_meter.rs).

use super::section::render_section;
use super::*;
use crate::app::sidebar::format_time_ago;
use crate::md::render::MONO_FAMILY;
use crate::usage::format_tokens;
use client::tide::TideProviderWire;
use gpui::relative;
use protocol::git_panel::{PanelAheadBehind, PanelFileChange};

/// The iteration ceiling shown next to the live count — the tide driver's
/// main turn-loop bound (MAX_STEPS in crates/backend/src/driver/tide.rs).
pub(crate) const ITERATION_MAX_STEPS: u64 = 100;

/// A monospaced text leaf sized for stat values — the inspector's numbers
/// are mono everywhere upstream (`font-mono`).
fn mono_text(size: f32, color: Hsla) -> Div {
    div()
        .font_family(MONO_FAMILY)
        .text_size(sp(size))
        .line_height(sp(size + 3.0))
        .text_color(color)
}

// ── Session hero ──────────────────────────────────────────────────────────

/// The hero's status reading of a session. The reducer already folds
/// permission asks and Tide user-input asks into `Waiting`, which is
/// upstream's "Blocked" — an answer is what unblocks the turn.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HeroStatus {
    Running,
    Blocked,
    Error,
    Idle,
}

pub(crate) fn hero_status(status: SessionStatus) -> HeroStatus {
    match status {
        SessionStatus::Connecting | SessionStatus::Working => HeroStatus::Running,
        SessionStatus::Waiting => HeroStatus::Blocked,
        SessionStatus::Failed => HeroStatus::Error,
        SessionStatus::Idle => HeroStatus::Idle,
    }
}

/// Compact working time, upstream's formatDuration: "0s", "45s",
/// "4m 12s", "1h 23m".
pub(crate) fn format_elapsed(seconds: u64) -> String {
    if seconds >= 3600 {
        format!("{}h {:02}m", seconds / 3600, (seconds % 3600) / 60)
    } else if seconds >= 60 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{seconds}s")
    }
}

pub(crate) fn working_time_secs(turns: &[(u64, Option<u64>)], now: u64) -> u64 {
    turns
        .iter()
        .map(|(started, completed)| completed.unwrap_or(now).saturating_sub(*started))
        .sum()
}

/// Compact duration from milliseconds, in the DSH stats-line idiom:
/// "840ms", "2.1s" (under ten seconds, one decimal), "47s", "3m44s",
/// "1h02m" — no spaces, unlike upstream's `formatDuration` cells.
pub(crate) fn format_duration_ms(ms: u64) -> String {
    if ms < 1000 {
        return format!("{ms}ms");
    }
    let secs = ms / 1000;
    if secs >= 3600 {
        format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60)
    } else if secs >= 60 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else if secs < 10 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        format!("{secs}s")
    }
}

/// Whole tokens/second over the steps' model time — rounded, like the
/// stats readouts it mirrors. `None` below one second of llm time, where
/// the rate is noise.
pub(crate) fn tokens_per_sec(output_tokens: u64, llm_ms: u64) -> Option<u64> {
    if llm_ms < 1000 {
        return None;
    }
    Some(output_tokens * 1000 / llm_ms)
}

/// The hero's DSH-style performance line values, derived from one
/// session's cumulative usage. Every field degrades independently: a
/// session that has not completed a measured step shows none of them.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct PerfStats {
    /// Model steps taken — the usage `calls` total across the session,
    /// not the per-turn iteration counter (a new turn resets that one).
    pub(crate) steps: u64,
    pub(crate) llm_ms: u64,
    pub(crate) tool_ms: u64,
    /// Mean time to first token over the steps that streamed one.
    pub(crate) ttft_ms: Option<u64>,
    pub(crate) tokens_per_sec: Option<u64>,
}

fn perf_stats(usage: Option<&SessionUsageTotals>) -> PerfStats {
    let Some(usage) = usage else {
        return PerfStats::default();
    };
    PerfStats {
        steps: usage.calls,
        llm_ms: usage.llm_ms,
        tool_ms: usage.tool_ms,
        ttft_ms: (usage.ttft_steps > 0).then(|| usage.ttft_ms_total / usage.ttft_steps),
        tokens_per_sec: tokens_per_sec(usage.output_tokens, usage.llm_ms),
    }
}

/// Everything the Session hero shows, prepared from one session.
fn hero_stat_cell(label: SharedString, value: String, theme: &Theme) -> Div {
    div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .px(px(8.0))
        .py(px(6.0))
        .rounded(px(7.0))
        .bg(theme.inset)
        .child(
            div()
                .text_size(sp(9.5))
                .line_height(sp(12.0))
                .text_color(theme.text_tertiary)
                .child(label),
        )
        .child(
            div()
                .text_size(sp(11.0))
                .line_height(sp(14.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_secondary)
                .truncate()
                .child(value),
        )
}

#[allow(dead_code)] // fields stay covered by the section tests
pub(crate) struct HeroData {
    pub(crate) status: HeroStatus,
    pub(crate) title: String,
    /// The raw model id ("provider/model") — the meta line is mono and
    /// unprettified, like upstream's.
    pub(crate) model_id: String,
    pub(crate) turns: usize,
    pub(crate) started_secs_ago: u64,
    pub(crate) last_active_secs_ago: Option<u64>,
    pub(crate) working_secs: u64,
    pub(crate) perf: PerfStats,
}

pub(crate) fn hero_data(
    status: SessionStatus,
    title: String,
    model_id: String,
    turns: usize,
    working_secs: u64,
    created_at: u64,
    last_reply_at: Option<u64>,
    now: u64,
    usage: Option<&SessionUsageTotals>,
) -> HeroData {
    HeroData {
        status: hero_status(status),
        title,
        model_id,
        turns,
        working_secs,
        started_secs_ago: now.saturating_sub(created_at),
        last_active_secs_ago: last_reply_at.map(|at| now.saturating_sub(at)),
        perf: perf_stats(usage),
    }
}

/// One boxed stat cell of the hero grid: tiny uppercase label over a
/// semibold value, like upstream's `Stat`.

impl Tide {
    /// The Session section: title, meta line (model id · turns · started),
    /// status chip, and the Total time / Last active stat grid.
    pub(super) fn render_inspector_session_section(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let Some(session) = self.selected_session() else {
            return div();
        };
        let now = unix_time();
        let turn_times: Vec<(u64, Option<u64>)> = session
            .turns
            .iter()
            .map(|turn| (turn.started_at, turn.completed_at))
            .collect();
        let model_id = self
            .model_for_session(session)
            .unwrap_or_default()
            .to_owned();
        let data = hero_data(
            session.status,
            session.display_title().to_owned(),
            model_id,
            session.turns.len(),
            working_time_secs(&turn_times, now),
            session.created_at,
            session.last_reply_at,
            now,
            session.usage_totals.as_ref(),
        );

        // The chip pairs its tint with an icon and a label, so color never
        // carries the meaning alone in either theme.
        let (status_label, status_icon, status_color, neutral) = match data.status {
            HeroStatus::Running => (
                tr!("inspector.status_running"),
                "icons/loader-circle.svg",
                theme.success,
                false,
            ),
            HeroStatus::Blocked => (
                tr!("inspector.status_blocked"),
                "icons/shield-alert.svg",
                theme.warning,
                false,
            ),
            HeroStatus::Error => (
                tr!("inspector.status_error"),
                "icons/alert.svg",
                theme.danger,
                false,
            ),
            HeroStatus::Idle => (
                tr!("inspector.status_idle"),
                "icons/pause.svg",
                theme.text_secondary,
                true,
            ),
        };
        let status_chip = div()
            .px(px(8.0))
            .py(px(2.0))
            .rounded_full()
            .border_1()
            .border_color(if neutral {
                theme.border
            } else {
                status_color.opacity(0.30)
            })
            .bg(if neutral {
                theme.overlay
            } else {
                status_color.opacity(0.10)
            })
            .flex()
            .items_center()
            .gap(px(5.0))
            .flex_none()
            // The Running chip's loader rides the shared spin clock — a
            // static loader-circle reads as frozen next to the transcript's
            // spinning tools. Non-running states keep their still glyphs.
            .child(if matches!(data.status, HeroStatus::Running) {
                motion::spin(icon(status_icon, 11.0, status_color))
            } else {
                icon(status_icon, 11.0, status_color).into_any_element()
            })
            .child(
                div()
                    .text_size(sp(10.5))
                    .line_height(sp(13.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(if neutral {
                        theme.text_secondary
                    } else {
                        status_color
                    })
                    .child(status_label),
            );

        // Meta line: the provider's name with the model id in mono — the
        // two facts a user scanning the hero reaches for first.
        let provider_name = session.provider.display_name().to_owned();
        let meta_line = div()
            .flex()
            .items_center()
            .gap(px(5.0))
            .min_w_0()
            .mt(px(3.0))
            .child(
                div()
                    .text_size(sp(9.5))
                    .line_height(sp(12.0))
                    .text_color(theme.text_tertiary)
                    .flex_none()
                    .child(provider_name),
            )
            .child(div().text_color(theme.text_ghost).child("·"))
            .child(
                mono_text(9.5, theme.text_tertiary)
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .child(data.model_id),
            );

        let body = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(10.0))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .min_w_0()
                            .flex_1()
                            .child(
                                div()
                                    .text_size(sp(12.5))
                                    .line_height(sp(16.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text)
                                    .truncate()
                                    .child(data.title),
                            )
                            .child(meta_line),
                    )
                    .child(status_chip),
            )
            .child(
                div()
                    .flex()
                    .gap(px(6.0))
                    .child(hero_stat_cell(
                        SharedString::from(tr!("inspector.turns_count", count = data.turns)),
                        format_elapsed(data.working_secs),
                        &theme,
                    ))
                    .children(data.perf.ttft_ms.map(|ttft| {
                        let value = match data.perf.tokens_per_sec {
                            Some(tps) => tr!(
                                "inspector.perf_ttft",
                                ttft = format_duration_ms(ttft),
                                speed = tps
                            ),
                            None => format_duration_ms(ttft),
                        };
                        hero_stat_cell(
                            SharedString::from(tr!("inspector.perf_ttft_label")),
                            value,
                            &theme,
                        )
                    })),
            )
            .children({
                // Performance cells in the hero's stat-cell idiom — the
                // same boxed label-over-value children as Total time /
                // Last active. Each cell earns its place: a session with
                // no measured step shows none. Last active closes the
                // row: it is session bookkeeping, not step performance.
                let perf = &data.perf;
                let mut cells: Vec<Div> = Vec::new();
                if perf.steps > 0 {
                    cells.push(hero_stat_cell(
                        SharedString::from(tr!("inspector.perf_steps")),
                        perf.steps.to_string(),
                        &theme,
                    ));
                }
                if perf.llm_ms > 0 {
                    cells.push(hero_stat_cell(
                        SharedString::from(tr!("inspector.perf_llm_label")),
                        format_duration_ms(perf.llm_ms),
                        &theme,
                    ));
                }
                if perf.tool_ms > 0 {
                    cells.push(hero_stat_cell(
                        SharedString::from(tr!("inspector.perf_tool_label")),
                        format_duration_ms(perf.tool_ms),
                        &theme,
                    ));
                }
                cells.extend(data.last_active_secs_ago.map(|secs| {
                    hero_stat_cell(
                        SharedString::from(tr!("inspector.stat_last_active")),
                        format_time_ago(secs),
                        &theme,
                    )
                }));
                (!cells.is_empty()).then(|| div().flex().flex_wrap().gap(px(6.0)).children(cells))
            });
        render_section(
            SectionId::Session,
            &tr!("inspector.section_session"),
            None,
            None,
            self.inspector.is_collapsed(SectionId::Session),
            body,
            &theme,
            cx,
        )
    }

    /// The Configuration section: icon-led Provider / Model / Permissions /
    /// Iteration rows, matching upstream's layout and icons.
    pub(super) fn render_inspector_config_section(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let Some(session) = self.selected_session() else {
            return div();
        };
        let provider = session.provider;
        let model = self.model_for_session(session);
        let data = config_data(
            provider,
            model,
            self.model_display_name(provider, model),
            session.runtime_mode,
            session.interaction_mode,
            &self.tide.providers,
        );
        let calls = session
            .usage_totals
            .as_ref()
            .map(|totals| totals.calls)
            .unwrap_or(0);
        render_section(
            SectionId::Config,
            &tr!("inspector.section_config"),
            None,
            None,
            self.inspector.is_collapsed(SectionId::Config),
            config_body(&data, calls, &theme),
            &theme,
            cx,
        )
    }

    /// The Git section: a pure read of whatever the branch snapshot cache
    /// and the git panel already hold — the panel's 5s refresh only runs
    /// while it is open, so values can be stale, and a workspace with no
    /// branch to name hides the section. Nothing here ever spawns git from
    /// a frame. The header carries the Changes action (upstream's
    /// head-action pill) and the worktree badge.
    pub(super) fn render_inspector_git_section(&mut self, cx: &mut Context<Self>) -> Option<Div> {
        let theme = Theme::current(cx);
        let (cwd, is_worktree) = {
            let session = self.selected_session()?;
            (
                self.workspace_path_for_session(session)?.to_path_buf(),
                session.workspace.is_worktree(),
            )
        };
        // Extract only the scalars; cloning whole snapshots per frame would
        // churn the branch list for nothing.
        let snapshot_summary = match self.branch_snapshots.read(&cwd) {
            Query::Ready(result) => match result.as_ref() {
                Ok(Some(snapshot)) => Some((
                    snapshot.display_branch().map(str::to_owned),
                    snapshot.additions,
                    snapshot.deletions,
                )),
                _ => None,
            },
            // Pending or a cold miss: the panel's own branch info may still
            // name the branch, so fall through rather than bail.
            Query::Pending | Query::Missing(_) => None,
        };
        let status_summary: Option<&[PanelFileChange]> = match &self.git_panel.status {
            Query::Ready(changes) => Some(changes.as_slice()),
            Query::Pending | Query::Missing(_) => None,
        };
        let (panel_branch, panel_head) = match &self.git_panel.branch_info {
            Query::Ready(info) => (info.branch.clone(), info.head_commit.clone()),
            Query::Pending | Query::Missing(_) => (None, None),
        };
        let ahead_behind = self.git_panel.ahead_behind.clone();
        let data = git_section_data(
            snapshot_summary,
            panel_branch,
            panel_head,
            status_summary,
            ahead_behind,
            cwd.display().to_string(),
        )?;

        // The header action: a compact bordered pill that opens the right
        // panel's Git surface — upstream's OpenChangesButton.
        let changed_for_action = data.changed.unwrap_or(0);
        let open_changes = div()
            .id("inspector-git-open")
            .h(px(20.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .border_1()
            .border_color(theme.border)
            .flex()
            .items_center()
            .gap(px(4.0))
            .flex_none()
            .cursor_default()
            .tab_index(0)
            .hover(|style| {
                style
                    .border_color(theme.accent)
                    .bg(theme.overlay)
                    .text_color(theme.text)
            })
            .focus_visible(|style| style.border_color(theme.accent))
            .child(icon(
                "icons/git-pull-request.svg",
                10.0,
                theme.text_tertiary,
            ))
            .child(
                div()
                    .text_size(sp(10.5))
                    .line_height(sp(13.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.text_secondary)
                    .child(tr!("git_panel.changes")),
            )
            .when(changed_for_action > 0, |button| {
                button.child(
                    div()
                        .text_size(sp(10.5))
                        .line_height(sp(13.0))
                        .text_color(theme.text_tertiary)
                        .child(format!(" · {changed_for_action}")),
                )
            })
            .on_click(cx.listener(|this, _, _, cx| {
                this.open_right_panel_surface(RightPanelSurface::Git, cx);
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    this.open_right_panel_surface(RightPanelSurface::Git, cx);
                    cx.stop_propagation();
                }
            }));

        let badge = is_worktree.then(|| SharedString::from(tr!("inspector.worktree")));
        Some(render_section(
            SectionId::Git,
            &tr!("inspector.section_git"),
            badge,
            Some(open_changes),
            self.inspector.is_collapsed(SectionId::Git),
            git_body(&data, is_worktree, &theme),
            &theme,
            cx,
        ))
    }

// ── Configuration ─────────────────────────────────────────────────────────

/// The gate the session runs under, ready to badge. Tide sessions gate on
/// the Plan/Build interaction mode; other drivers keep their RuntimeMode
/// access level. `highlighted` mirrors the composer chip's accent treatment
/// for Plan.
pub(crate) struct ModeBadge {
    pub(crate) label: String,
    // Ported vocabulary; the section badges the label only today.
    #[allow(dead_code)]
    pub(crate) icon: &'static str,
    pub(crate) highlighted: bool,
}

pub(crate) fn mode_badge(
    provider: ProviderKind,
    runtime_mode: RuntimeMode,
    interaction_mode: InteractionMode,
) -> ModeBadge {
    if provider == ProviderKind::Tide {
        ModeBadge {
            label: interaction_mode.label(),
            icon: if interaction_mode == InteractionMode::Plan {
                "icons/list.svg"
            } else {
                "icons/wrench.svg"
            },
            highlighted: interaction_mode == InteractionMode::Plan,
        }
    } else {
        ModeBadge {
            label: runtime_mode.label(),
            icon: runtime_mode.icon(),
            highlighted: false,
        }
    }
}

/// Everything the Configuration section shows, prepared from one session.
pub(crate) struct ConfigData {
    pub(crate) provider_name: String,
    /// Tide sub-provider brand `(logo key, accent hex)`; the generic tide
    /// mark when unresolved; `None` for non-Tide drivers.
    pub(crate) brand: Option<(&'static str, &'static str)>,
    pub(crate) model_display: String,
    pub(crate) mode: ModeBadge,
}

pub(crate) fn config_data(
    provider: ProviderKind,
    model: Option<&str>,
    model_display: String,
    runtime_mode: RuntimeMode,
    interaction_mode: InteractionMode,
    providers: &[TideProviderWire],
) -> ConfigData {
    // Same resolution as the composer chip: the model id's provider prefix
    // names the Tide sub-provider whose brand and display name we show.
    let (provider_name, brand) = if provider == ProviderKind::Tide {
        match model
            .and_then(|model| model.split_once('/'))
            .and_then(|(prefix, _)| providers.iter().find(|candidate| candidate.id == prefix))
        {
            Some(resolved) => (
                resolved.name.clone(),
                Some(crate::app::tide_providers::brand_for(
                    &resolved.base_url,
                    &resolved.api_style,
                )),
            ),
            None => (
                provider.short_name().to_owned(),
                Some(("provider-tide", "#ffffff")),
            ),
        }
    } else {
        (provider.short_name().to_owned(), None)
    };
    ConfigData {
        provider_name,
        brand,
        model_display,
        mode: mode_badge(provider, runtime_mode, interaction_mode),
    }
}

/// One icon-led label/value row, upstream's Configuration shape: muted icon
/// and label on the left, the value right-aligned and truncating.
fn config_row(icon_path: &'static str, label: SharedString, value: Div, theme: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .min_w_0()
        .child(icon(icon_path, 12.0, theme.text_tertiary))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(sp(11.5))
                .line_height(sp(15.0))
                .text_color(theme.text_tertiary)
                .child(label),
        )
        .child(value.min_w_0().max_w(px(150.0)))
}

fn config_body(data: &ConfigData, calls: u64, theme: &Theme) -> Div {
    // The provider row's value: brand tile at upstream's chip scale
    // (size-3.5 tile, size-2 mark) beside the provider name.
    let provider_value = div()
        .flex()
        .items_center()
        .justify_end()
        .gap(px(5.0))
        .when_some(data.brand, |row, (logo, accent)| {
            row.child(
                crate::ui::brand::brand_tile(logo, accent, 14.0, 8.0, theme).into_any_element(),
            )
        })
        .child(
            div()
                .text_size(sp(11.0))
                .line_height(sp(14.0))
                .text_color(theme.text)
                .truncate()
                .child(data.provider_name.clone()),
        );
    let model_value = div().flex().justify_end().child(
        div()
            .text_size(sp(11.0))
            .line_height(sp(14.0))
            .text_color(theme.text)
            .truncate()
            .child(data.model_display.clone()),
    );
    // The permissions badge: a bordered pill carrying the gate's label —
    // read-only here, the composer chip stays the control.
    let mode_value = div().flex().justify_end().child(
        div()
            .px(px(5.0))
            .py(px(1.0))
            .rounded(px(4.0))
            .border_1()
            .border_color(theme.border)
            .bg(theme.overlay)
            .child(
                div()
                    .text_size(sp(10.0))
                    .line_height(sp(13.0))
                    .text_color(if data.mode.highlighted {
                        theme.accent
                    } else {
                        theme.text_secondary
                    })
                    .child(data.mode.label.clone()),
            ),
    );
    let iteration_value = div()
        .flex()
        .justify_end()
        .child(mono_text(11.0, theme.text).child(format!("{calls} / {ITERATION_MAX_STEPS}")));

    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(config_row(
            "icons/server.svg",
            SharedString::from(tr!("inspector.provider")),
            provider_value,
            theme,
        ))
        .child(config_row(
            "icons/cpu.svg",
            SharedString::from(tr!("inspector.model")),
            model_value,
            theme,
        ))
        .child(config_row(
            "icons/shield.svg",
            SharedString::from(tr!("inspector.permissions")),
            mode_value,
            theme,
        ))
        .child(config_row(
            "icons/repeat.svg",
            SharedString::from(tr!("inspector.iteration")),
            iteration_value,
            theme,
        ))
}

// ── Git ───────────────────────────────────────────────────────────────────

/// Everything the Git section shows. `changed`/`staged`/`files` and the
/// diffstat come from the git panel's working-tree query; when that is cold
/// (the panel has not been open this run) the diffstat falls back to the
/// branch snapshot's aggregates and the counts read as unknown.
pub(crate) struct GitSectionData {
    pub(crate) branch: String,
    pub(crate) head: Option<String>,
    pub(crate) ahead: Option<u64>,
    pub(crate) behind: Option<u64>,
    pub(crate) changed: Option<u64>,
    pub(crate) staged: Option<u64>,
    // Part of the ported data model; the section reads changed/staged only
    // today.
    #[allow(dead_code)]
    pub(crate) files: Option<u64>,
    pub(crate) additions: u64,
    pub(crate) deletions: u64,
    pub(crate) repo_path: String,
}

/// Aggregate the section from cached state. `None` hides the section — a
/// workspace with no branch to name (no snapshot, no panel info) is not a
/// git context worth a section.
pub(crate) fn git_section_data(
    snapshot: Option<(Option<String>, u64, u64)>,
    panel_branch: Option<String>,
    panel_head: Option<String>,
    status: Option<&[PanelFileChange]>,
    ahead_behind: Option<PanelAheadBehind>,
    repo_path: String,
) -> Option<GitSectionData> {
    let (snapshot_branch, snapshot_additions, snapshot_deletions) = match snapshot {
        Some((branch, additions, deletions)) => (branch, additions, deletions),
        None => (None, 0, 0),
    };
    let branch = snapshot_branch.or(panel_branch)?;
    let (changed, staged, files, additions, deletions) = match status {
        Some(changes) => {
            let mut changed = 0u64;
            let mut staged = 0u64;
            let mut additions = 0u64;
            let mut deletions = 0u64;
            for change in changes {
                if change.staged {
                    staged += 1;
                } else {
                    changed += 1;
                }
                additions += change.additions;
                deletions += change.deletions;
            }
            (
                Some(changed),
                Some(staged),
                Some(changed + staged),
                additions,
                deletions,
            )
        }
        None => (None, None, None, snapshot_additions, snapshot_deletions),
    };
    Some(GitSectionData {
        branch,
        head: panel_head,
        ahead: ahead_behind.as_ref().map(|counts| counts.ahead),
        behind: ahead_behind.as_ref().map(|counts| counts.behind),
        changed,
        staged,
        files,
        additions,
        deletions,
        repo_path,
    })
}

/// The additions share of a two-segment diffstat bar; both zero reads as an
/// even split so an empty bar is not all-red.
pub(crate) fn diffstat_add_fraction(additions: u64, deletions: u64) -> f32 {
    match additions + deletions {
        0 => 0.5,
        total => additions as f32 / total as f32,
    }
}

/// One label/value row of the Git body, matching upstream's
/// `text-muted-foreground` / mono-value pairs.
fn git_row(label: SharedString, value: Div, theme: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .min_w_0()
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(sp(11.5))
                .line_height(sp(15.0))
                .text_color(theme.text_tertiary)
                .child(label),
        )
        .child(value.min_w_0().max_w(px(160.0)).flex_none())
}

fn git_body(data: &GitSectionData, is_worktree: bool, theme: &Theme) -> Div {
    let ahead_behind = match (data.ahead, data.behind) {
        (Some(ahead), Some(behind)) => Some(format!("↑{ahead} ↓{behind}")),
        (Some(ahead), None) => Some(format!("↑{ahead}")),
        (None, Some(behind)) => Some(format!("↓{behind}")),
        (None, None) => None,
    };
    let branch_row = div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .min_w_0()
        .child(icon("icons/git-branch.svg", 12.0, theme.text_tertiary))
        .child(
            mono_text(11.0, theme.text)
                .min_w_0()
                .flex_1()
                .truncate()
                .child(data.branch.clone()),
        )
        .when_some(ahead_behind, |row, counts| {
            row.child(
                mono_text(10.0, theme.text_secondary)
                    .flex_none()
                    .child(counts),
            )
        });

    let head_row = (!is_worktree).then(|| {
        git_row(
            SharedString::from("Head"),
            div().flex().justify_end().child(
                mono_text(10.0, theme.text_secondary)
                    .truncate()
                    .child(data.head.clone().unwrap_or_else(|| "—".to_owned())),
            ),
            theme,
        )
    });

    let changed_value = |theme: &Theme| {
        let mut value = mono_text(10.5, theme.text).child(
            data.changed
                .map(|changed| changed.to_string())
                .unwrap_or_else(|| "—".to_owned()),
        );
        if let (Some(_), Some(staged)) = (data.changed, data.staged) {
            if staged > 0 {
                value = value.child(
                    div()
                        .text_size(sp(10.0))
                        .line_height(sp(13.0))
                        .text_color(theme.text_tertiary)
                        .child(tr!("inspector.git_staged", count = staged)),
                );
            }
        }
        div()
            .flex()
            .items_center()
            .justify_end()
            .gap(px(4.0))
            .child(value)
    };

    // Upstream's DiffStat: "Changes  +N ▓▓▓░░ −M" — a small fixed-width
    // two-segment bar between the signed counts.
    let diffstat_row = (data.additions > 0 || data.deletions > 0).then(|| {
        let add_fraction = diffstat_add_fraction(data.additions, data.deletions);
        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .py(px(2.0))
            .min_w_0()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(sp(11.5))
                    .line_height(sp(15.0))
                    .text_color(theme.text_tertiary)
                    .child(tr!("git_panel.changes")),
            )
            .child(
                mono_text(10.5, theme.success)
                    .flex_none()
                    .child(format!("+{}", data.additions)),
            )
            .child(
                div()
                    .w(px(80.0))
                    .h(px(4.0))
                    .rounded(px(2.0))
                    .bg(theme.inset)
                    .overflow_hidden()
                    .flex_none()
                    .flex()
                    .child(div().h_full().w(relative(add_fraction)).bg(theme.success))
                    .child(div().h_full().flex_1().bg(theme.danger)),
            )
            .child(
                mono_text(10.5, theme.danger)
                    .flex_none()
                    .child(format!("−{}", data.deletions)),
            )
    });

    let repo_row = git_row(
        SharedString::from(if is_worktree {
            tr!("inspector.git_worktree_label")
        } else {
            tr!("inspector.git_repo")
        }),
        div().flex().justify_end().child(
            mono_text(10.0, theme.text_secondary)
                .truncate()
                .child(data.repo_path.clone()),
        ),
        theme,
    );

    div()
        .flex()
        .flex_col()
        .gap(px(5.0))
        .child(branch_row)
        .children(head_row)
        .child(git_row(
            SharedString::from(tr!("git_panel.changes")),
            changed_value(theme),
            theme,
        ))
        .children(diffstat_row)
        .child(repo_row)
}

// ── Stream log ────────────────────────────────────────────────────────────

/// One line of the session's live event tail. Deliberately in-memory: it is
/// a tail, not history — persistence would bloat saves for a view that is
/// only meaningful while watching. The timestamp is formatted once, at
/// capture: per-frame chrono formatting of sixty lines is exactly the
/// redraw-rate × element-count product docs/performance.md budgets.
pub(crate) struct StreamLogEntry {
    /// Wall-clock "HH:MM:SS", precomputed at capture.
    pub(crate) time: SharedString,
    /// SharedString so per-frame line clones are refcount bumps.
    pub(crate) label: SharedString,
    /// Errors and failed turns tint danger — always paired with the label's
    /// own wording, never color alone.
    pub(crate) error: bool,
}

/// How many lines the per-session tail keeps.
pub(crate) const STREAM_LOG_CAP: usize = 60;

/// Compact source label cap; titles and errors can run long.
const STREAM_LABEL_MAX_CHARS: usize = 64;

fn truncate_label(text: &str) -> String {
    if text.chars().count() <= STREAM_LABEL_MAX_CHARS {
        text.to_owned()
    } else {
        let truncated: String = text.chars().take(STREAM_LABEL_MAX_CHARS).collect();
        truncated.trim_end().to_owned() + "…"
    }
}

/// Classify one driver event into a log line. `None` skips events that read
/// as noise in a tail: account-level meters, client-only acknowledgements,
/// and the subagent output firehose (whose batches land many times a
/// second). Labels are deliberately technical and unlocalized — this is a
/// log, not prose.
pub(crate) fn stream_log_entry(event: &DriverEvent, at_ms: u64) -> Option<StreamLogEntry> {
    let (label, error) = match event {
        DriverEvent::TurnStarted => ("turn started".to_owned(), false),
        DriverEvent::TurnFinished { success, .. } => {
            if *success {
                ("turn finished".to_owned(), false)
            } else {
                ("turn failed".to_owned(), true)
            }
        }
        DriverEvent::TextDelta(text) => (format!("text +{}c", text.chars().count()), false),
        DriverEvent::ReasoningDelta(text) => {
            (format!("reasoning +{}c", text.chars().count()), false)
        }
        DriverEvent::Activity {
            title, complete, ..
        } => (
            format!(
                "{}{}",
                truncate_label(title),
                if *complete { " ✓" } else { "" }
            ),
            false,
        ),
        DriverEvent::RichActivity(item) => (truncate_label(&item.title), false),
        DriverEvent::BackgroundWork(BackgroundWorkEvent::Upsert(item)) => {
            (format!("bg · {}", truncate_label(&item.title)), false)
        }
        DriverEvent::Permission { title, .. } => {
            (format!("permission · {}", truncate_label(title)), true)
        }
        DriverEvent::UserInputRequested { .. } => ("input request".to_owned(), true),
        DriverEvent::UsageUpdated {
            context_tokens: Some(tokens),
            ..
        } => (format!("usage · {} tok", format_tokens(*tokens)), false),
        DriverEvent::Error(message) => (truncate_label(message), true),
        DriverEvent::SteerAccepted { .. } => ("steer accepted".to_owned(), false),
        DriverEvent::SteerRejected { .. } => ("steer rejected".to_owned(), false),
        DriverEvent::Connected { .. } => ("connected".to_owned(), false),
        DriverEvent::ProcessExited => ("process exited".to_owned(), false),
        DriverEvent::AutoTitleUpdated(_) => ("auto title".to_owned(), false),
        DriverEvent::GoalUpdated(_) => ("goal updated".to_owned(), false),
        DriverEvent::ComputerUseUpdated(_) => ("computer use".to_owned(), false),
        DriverEvent::AgentPresetSelected(_) => ("preset selected".to_owned(), false),
        DriverEvent::AvailableCommands(_) => ("commands".to_owned(), false),
        DriverEvent::PlanUsageUpdated(_)
        | DriverEvent::RuntimeEventCursorAdvanced(_)
        | DriverEvent::UsageUpdated {
            context_tokens: None,
            ..
        }
        | DriverEvent::BackgroundWork(_) => return None,
    };
    Some(StreamLogEntry {
        time: SharedString::from(
            DateTime::from_timestamp_millis(at_ms as i64)
                .map(|at| at.with_timezone(&Local).format("%H:%M:%S").to_string())
                .unwrap_or_default(),
        ),
        label: SharedString::from(label),
        error,
    })
}

/// The event tail as a scrollable mono list, newest first — the reverse
/// order keeps the live end visible without scroll management.
fn stream_log_body<'a>(
    entries: impl DoubleEndedIterator<Item = &'a StreamLogEntry>,
    theme: &Theme,
) -> Stateful<Div> {
    div()
        .id("inspector-stream-log")
        .max_h(px(180.0))
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .py(px(2.0))
        .children(entries.rev().map(|entry| {
            div()
                .flex()
                .items_baseline()
                .gap(px(6.0))
                .min_w_0()
                .child(
                    mono_text(9.0, theme.text_ghost)
                        .flex_none()
                        .child(entry.time.clone()),
                )
                .child(
                    mono_text(
                        9.5,
                        if entry.error {
                            theme.danger
                        } else {
                            theme.text_secondary
                        },
                    )
                    .min_w_0()
                    .truncate()
                    .child(entry.label.clone()),
                )
        }))
}

impl Tide {
    /// The Stream log section: the session's live event tail, newest
    /// first. Hidden until something has streamed — an idle new session
    /// has no log to show.
    pub(super) fn render_inspector_stream_log_section(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let theme = Theme::current(cx);
        let session = self.selected_session()?;
        let entries = self.inspector_stream_log.get(&session.id)?;
        if entries.is_empty() {
            return None;
        }
        let badge = SharedString::from(entries.len().to_string());
        Some(render_section(
            SectionId::StreamLog,
            &tr!("inspector.section_stream_log"),
            Some(badge),
            None,
            self.inspector.is_collapsed(SectionId::StreamLog),
            stream_log_body(entries.iter(), &theme),
            &theme,
            cx,
        ))
    }

    /// The Memory & RAG section (upstream's inspector MemoryRagSection): a
    /// per-project enable toggle, the index stats, and the Re-Index header
    /// action. Hidden without a selected session; rows degrade to dashes
    /// until the project's status has loaded.
    pub(super) fn render_inspector_memory_rag_section(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let theme = Theme::current(cx);
        let session = self.selected_session()?;
        let project_id = session.project_id.to_string();
        // Memory indexes are per project: projectless sessions (and sessions
        // whose project vanished) have nothing to show here.
        let project = self
            .state
            .projects
            .iter()
            .find(|project| project.id == session.project_id);
        if project.is_none_or(|project| project.is_projectless()) {
            return None;
        }
        let status = self
            .rag_settings
            .status
            .clone()
            .filter(|status| status.project_id == project_id);
        let enabled = status.as_ref().is_some_and(|status| status.enabled);
        let indexing = status.as_ref().is_some_and(|status| {
            status.init_state == "running" || status.model_download == "downloading"
        });
        let model_ready = status
            .as_ref()
            .is_some_and(|status| status.local_model_available);
        let chunks = status.as_ref().map_or(0, |status| status.chunk_count);
        let active = enabled && model_ready && chunks > 0;
        let badge = SharedString::from(if indexing {
            tr!("inspector.rag_indexing")
        } else if active {
            tr!("inspector.rag_active")
        } else {
            tr!("inspector.rag_inactive")
        });

        // The header action: Re-Index, exactly upstream's placement.
        let action = enabled.then(|| {
            let id = project_id.clone();
            div()
                .id("inspector-rag-reindex")
                .tab_index(0)
                .focus_visible(|style| style.border_color(theme.accent))
                .px(px(6.0))
                .py(px(2.0))
                .rounded(px(5.0))
                .border_1()
                .border_color(theme.border)
                .text_size(sp(10.0))
                .cursor_pointer()
                .child(tr!("inspector.rag_reindex"))
                .on_click({
                    let weak = cx.entity().downgrade();
                    move |_, _window, cx| {
                        let _ = weak.update(cx, |tide, cx| {
                            tide.rag_init(&id, cx);
                        });
                    }
                })
        });

        // Body: the enable toggle row + stat rows.
        let toggle_id = project_id.clone();
        let toggle = crate::ui::toggle_switch(
            SharedString::from(format!("inspector-rag-enable-{toggle_id}")),
            enabled,
            indexing,
            theme,
            cx,
            move |this, _window, cx| {
                let next = !this
                    .rag_settings
                    .status
                    .as_ref()
                    .is_some_and(|status| status.enabled);
                this.rag_set_enabled(&toggle_id, next, cx);
            },
        );
        let memory_state = if !enabled {
            tr!("inspector.rag_workspace_off")
        } else if model_ready {
            tr!("inspector.rag_available")
        } else {
            tr!("inspector.rag_no_model")
        };
        let last_indexed = status
            .as_ref()
            .and_then(|status| status.last_ingested_at)
            .map(rag_time_ago);
        let embedder = status
            .as_ref()
            .map(|status| status.embedder_id.clone())
            .unwrap_or_else(|| "—".to_owned());
        let chunk_text = if chunks > 0 {
            format!("{chunks}")
        } else {
            "—".to_owned()
        };
        // Live indexing progress (upstream's prominent progress card,
        // row-shaped for the inspector): phase + counts + current file.
        let live_progress = status.as_ref().and_then(|status| {
            status.init_progress.as_ref().filter(|progress| {
                matches!(
                    progress.phase.as_str(),
                    "walking" | "chunking" | "embedding"
                )
            })
        });
        let progress_row = live_progress.map(|progress| {
            let counts = match progress.phase.as_str() {
                "walking" => format!(
                    "{} {}",
                    progress.files_seen,
                    tr!("settings.rag.files_suffix")
                ),
                "chunking" => format!(
                    "{} {}",
                    progress.chunks_total,
                    tr!("settings.rag.chunks_suffix")
                ),
                _ => format!(
                    "{} / {} {}",
                    progress.chunks_embedded,
                    progress.chunks_total,
                    tr!("settings.rag.chunks_suffix")
                ),
            };
            div()
                .flex()
                .items_center()
                .gap(px(5.0))
                .child(motion::spin(icon(
                    "icons/loader-circle.svg",
                    10.0,
                    theme.text_tertiary,
                )))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(sp(10.5))
                        .text_color(theme.text_tertiary)
                        .child(SharedString::from(format!(
                            "{} · {}",
                            super::super::rag_settings::init_phase_label(&progress.phase),
                            counts
                        ))),
                )
        });
        let body =
            div()
                .flex()
                .flex_col()
                .gap(px(3.0))
                .children(progress_row)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            div()
                                .flex_1()
                                .text_size(sp(11.5))
                                .text_color(theme.text_tertiary)
                                .child(tr!("inspector.rag_memory")),
                        )
                        .child(
                            div()
                                .text_size(sp(11.0))
                                .text_color(if enabled {
                                    theme.text
                                } else {
                                    theme.text_tertiary
                                })
                                .child(memory_state),
                        )
                        .child(toggle),
                )
                .child(memory_stat_row(
                    &theme,
                    &tr!("inspector.rag_indexed"),
                    &chunk_text,
                ))
                .children(last_indexed.map(|value| {
                    memory_stat_row(&theme, &tr!("inspector.rag_last_indexed"), &value)
                }))
                .child(memory_stat_row(
                    &theme,
                    &tr!("inspector.rag_embedder"),
                    &embedder,
                ));
        Some(render_section(
            SectionId::MemoryRag,
            &tr!("inspector.section_memory_rag"),
            Some(badge),
            action,
            self.inspector.is_collapsed(SectionId::MemoryRag),
            body,
            &theme,
            cx,
        ))
    }
}

/// One label-left / value-right stat row (mono value, like upstream's rows).
fn memory_stat_row(theme: &Theme, label: &str, value: &str) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(sp(11.5))
                .text_color(theme.text_tertiary)
                .child(SharedString::from(label.to_owned())),
        )
        .child(
            div()
                .text_size(sp(11.0))
                .text_color(theme.text_tertiary)
                .truncate()
                .child(SharedString::from(value.to_owned())),
        )
}

/// Relative time for the last-indexed row, from epoch milliseconds.
fn rag_time_ago(epoch_ms: i64) -> String {
    let seconds = (unix_time_millis() as i64 - epoch_ms).max(0) / 1000;
    match seconds {
        0..=59 => tr!("git_panel.time_just_now"),
        60..=3_599 => tr!("git_panel.time_minutes_ago", count = seconds / 60),
        3_600..=86_399 => tr!("git_panel.time_hours_ago", count = seconds / 3_600),
        86_400..=2_591_999 => tr!("git_panel.time_days_ago", count = seconds / 86_400),
        _ => chrono::DateTime::from_timestamp_millis(epoch_ms)
            .map(|time| {
                time.with_timezone(&chrono::Local)
                    .format("%b %e, %Y")
                    .to_string()
            })
            .unwrap_or_default(),
    }
}
