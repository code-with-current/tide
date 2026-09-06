//! The usage meter under the composer: a circular context-window gauge whose
//! panel carries the session's whole context story — occupancy meter,
//! Iteration / Tools / Cost strip, and the per-class cumulative breakdown
//! that used to live in the inspector's Context Window section. Context
//! numbers stream in from the tide transport; frames read only snapshots
//! stored on the entity.

use gpui::{PathBuilder, relative};

use super::*;
use crate::app::inspector::ITERATION_MAX_STEPS;
use crate::app::timeline_v2::tools_dim;
// The protocol's per-step usage shape; the panel's meter segments and
// totals read it directly.
use crate::md::render::MONO_FAMILY;
use crate::model::{CompactionRecord, UsageBreakdown};
use crate::usage::format_tokens;

const USAGE_METER_MENU_ID: &str = "usage-meter";

impl Tide {
    /// Whether the footer shows the gauge. Always true with a session
    /// selected — an empty ring is the honest "nothing measured yet" state,
    /// and hiding it would make the control feel intermittent.
    pub(super) fn usage_meter_available(&self) -> bool {
        self.selected_session().is_some()
    }

    /// Primary modifier + U: toggle the usage panel as if its footer trigger were clicked.
    pub(super) fn toggle_usage_panel_action(
        &mut self,
        _: &ToggleUsagePanel,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings_page.is_some() || !self.usage_meter_available() {
            return;
        }
        let menus = self.menus.borrow();
        let Some(handle) = menus.get(USAGE_METER_MENU_ID).cloned() else {
            return;
        };
        // A keyboard toggle produces no mouse-down for another open menu's
        // dismiss-on-down-out to see, so close the rest here.
        let other_open: Vec<_> = menus
            .iter()
            .filter(|(id, other)| id.as_ref() != USAGE_METER_MENU_ID && other.is_open())
            .map(|(_, other)| other.clone())
            .collect();
        drop(menus);
        window.defer(cx, move |window, cx| {
            for menu in other_open {
                menu.close(window, cx);
            }
            crate::ui::menu::toggle_popover(&handle, MenuAlign::AboveRight, window, cx);
        });
    }

    /// The footer's circular context gauge plus its anchored panel. `None`
    /// while there is nothing to show for the selected session.
    pub(super) fn render_usage_meter(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.usage_meter_available() {
            return None;
        }
        let session = self.selected_session()?;
        let context = session.context_usage;
        // The persisted totals keep the strip and breakdown grid alive across
        // session switches and relaunches; only the per-turn iteration count
        // is ephemeral.
        let totals = session.usage_totals.as_ref().map(|totals| {
            UsageTotals::from_session(
                totals,
                self.inspector_turn_calls
                    .get(&session.id)
                    .copied()
                    .unwrap_or(0),
            )
        });
        let data = context_data(context.as_ref(), totals.as_ref(), session.last_compaction);
        let theme = Theme::current(cx);

        let weak = cx.entity().downgrade();
        let handle = self.menu_handle_with(USAGE_METER_MENU_ID, cx, move |open, window, cx| {
            if open {
                let mut card_focus = None;
                let _ = weak.update(cx, |this, cx| {
                    card_focus = this
                        .menus
                        .borrow()
                        .get(USAGE_METER_MENU_ID)
                        .map(|handle| handle.focus_handle().clone());
                    cx.notify();
                });
                // The card is deferred, so its focus handle joins the
                // dispatch tree only after the deferred draw — the same
                // two-frame wait the menus use. Focused, the card's menu
                // context is what lets `escape` dismiss it.
                if let Some(focus) = card_focus {
                    window.on_next_frame(move |window, _| {
                        window.on_next_frame(move |window, cx| window.focus(&focus, cx));
                    });
                }
            } else {
                let mut composer_focus = None;
                let _ = weak.update(cx, |this, cx| {
                    composer_focus = Some(this.composer.read(cx).focus());
                    cx.notify();
                });
                if let Some(focus) = composer_focus {
                    window.focus(&focus, cx);
                }
            }
        });

        let percent = context.and_then(context_percent);
        let fill = match percent {
            Some(percent) if percent >= 95.0 => theme.danger,
            Some(percent) if percent >= 80.0 => theme.warning,
            _ => theme.gauge,
        };
        let tooltip = match percent {
            Some(percent) => SharedString::from(tr!(
                "usage.context_used",
                percent = format!("{percent:.0}"),
                shortcut = crate::platform::primary_shortcut("⌘U", "Ctrl+U")
            )),
            None => SharedString::from(tr!(
                "usage.shortcut",
                shortcut = crate::platform::primary_shortcut("⌘U", "Ctrl+U")
            )),
        };

        let trigger = div()
            .id("usage-meter")
            .h(px(20.0))
            .px(px(5.0))
            .rounded(px(5.0))
            .flex()
            .items_center()
            .flex_none()
            .cursor_default()
            .hover(|element| element.bg(theme.overlay))
            .when(handle.is_open(), |element| element.bg(theme.overlay_strong))
            .tooltip(Tooltip::text(tooltip))
            .child(context_gauge(percent, theme.border_strong, fill));

        Some(popover(
            trigger,
            &handle,
            MenuAlign::AboveRight,
            move |handle, _, cx| usage_panel(handle, data, cx),
        ))
    }
}

fn context_percent(usage: ContextUsage) -> Option<f64> {
    usage
        .window
        .filter(|window| *window > 0)
        .map(|window| usage.tokens as f64 * 100.0 / window as f64)
}

/// The trigger glyph: a ring whose arc fills clockwise from 12 o'clock as the
/// context window does, over a faint full ring. An unknown fraction draws the
/// track alone. This is Zed's `CircularProgress` drawing sized for the footer
/// — `PathBuilder::stroke` arcs, which lyon tessellates correctly where a
/// hand-built annulus fill does not survive GPUI's fill rule.
fn context_gauge(percent: Option<f64>, track: Hsla, fill: Hsla) -> impl IntoElement {
    const SIZE: f32 = 13.0;
    const STROKE: f32 = 2.5;
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let center = bounds.center();
            let radius = px((SIZE - STROKE) / 2.0);

            // A full circle is two 180° arcs; lyon rejects a single
            // zero-length one.
            let full_circle = |builder: &mut PathBuilder| {
                builder.move_to(point(center.x + radius, center.y));
                builder.arc_to(
                    point(radius, radius),
                    px(0.0),
                    false,
                    true,
                    point(center.x - radius, center.y),
                );
                builder.arc_to(
                    point(radius, radius),
                    px(0.0),
                    false,
                    true,
                    point(center.x + radius, center.y),
                );
                builder.close();
            };

            let mut track_builder = PathBuilder::stroke(px(STROKE));
            full_circle(&mut track_builder);
            if let Ok(path) = track_builder.build() {
                window.paint_path(path, track);
            }

            let Some(percent) = percent else {
                return;
            };
            // Keep a visible sliver for a nearly-empty context.
            let fraction = ((percent / 100.0) as f32).clamp(0.0, 1.0).max(0.05);
            let mut arc_builder = PathBuilder::stroke(px(STROKE));
            if fraction >= 0.999 {
                full_circle(&mut arc_builder);
            } else {
                let start = -std::f32::consts::FRAC_PI_2;
                let angle = start + fraction * std::f32::consts::TAU;
                arc_builder.move_to(point(center.x, center.y - radius));
                arc_builder.arc_to(
                    point(radius, radius),
                    px(0.0),
                    fraction > 0.5,
                    true,
                    point(
                        center.x + radius * angle.cos(),
                        center.y + radius * angle.sin(),
                    ),
                );
            }
            if let Ok(path) = arc_builder.build() {
                window.paint_path(path, fill);
            }
        },
    )
    .w(px(SIZE))
    .h(px(SIZE))
    .flex_none()
}

fn usage_panel(handle: &ContextMenuHandle, data: ContextData, cx: &App) -> AnyElement {
    let theme = Theme::current(cx);
    div()
        // Focused on open so the surrounding menu context sees `escape`.
        .track_focus(handle.focus_handle())
        .w(px(320.0))
        .p(px(14.0))
        .rounded(px(10.0))
        .border_1()
        .border_color(theme.border_strong)
        .bg(theme.raised)
        .shadow_lg()
        .flex()
        .flex_col()
        .text_size(sp(12.5))
        .child(context_body(&data, &theme))
        .into_any_element()
}

/// The render-facing view of one session's usage: the persisted
/// [`SessionUsageTotals`] plus the ephemeral per-turn iteration count.
/// `last_step` carries the newest step's composition — the meter segments.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct UsageTotals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    reasoning: u64,
    calls: u64,
    cost_usd: f64,
    last_step: UsageBreakdown,
    turn_calls: u64,
}

impl UsageTotals {
    /// Project the persisted totals into the render view, grafting on the
    /// per-turn count the strip shows as Iteration.
    fn from_session(totals: &SessionUsageTotals, turn_calls: u64) -> Self {
        Self {
            input: totals.input_tokens,
            output: totals.output_tokens,
            cache_read: totals.cache_read,
            cache_write: totals.cache_write,
            reasoning: totals.reasoning_tokens,
            calls: totals.calls,
            cost_usd: totals.cost_usd,
            last_step: totals.last_step.unwrap_or_default(),
            turn_calls,
        }
    }
}

/// Everything the panel shows. `fill` is 0.0..1.0 occupancy — 0.0 when the
/// window is unknown, because an unknown fraction must not masquerade as an
/// empty one behind colored state.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct ContextData {
    fill: f32,
    tokens: Option<u64>,
    window: Option<u64>,
    /// The last compaction, when one ran — rendered as a line under the
    /// meter so a sudden occupancy drop explains itself.
    last_compaction: Option<CompactionRecord>,
    totals: Option<UsageTotals>,
}

fn context_fill(tokens: u64, window: Option<u64>) -> f32 {
    match window {
        Some(window) if window > 0 => (tokens as f32 / window as f32).clamp(0.0, 1.0),
        _ => 0.0,
    }
}

fn context_data(
    usage: Option<&ContextUsage>,
    totals: Option<&UsageTotals>,
    last_compaction: Option<CompactionRecord>,
) -> ContextData {
    let (tokens, window) = match usage {
        Some(usage) => (Some(usage.tokens), usage.window),
        None => (None, None),
    };
    ContextData {
        fill: tokens
            .map(|tokens| context_fill(tokens, window))
            .unwrap_or(0.0),
        tokens,
        window,
        last_compaction,
        totals: totals.copied(),
    }
}

/// Upstream's single takeover threshold: the meter's caption and ring go
/// amber once the window is 80% full.
const CONTEXT_WARN_FILL: f32 = 0.80;

fn fill_bar_color(fill: f32, theme: &Theme) -> Hsla {
    if fill >= CONTEXT_WARN_FILL {
        theme.warning
    } else {
        theme.gauge
    }
}

/// One meter segment's share of the context window, clamped to the bar.
fn segment_fill(tokens: u64, window: u64) -> f32 {
    if window == 0 {
        0.0
    } else {
        (tokens as f32 / window as f32).min(1.0)
    }
}

/// A monospaced text leaf sized for stat values — the panel's numbers are
/// mono, matching the inspector they came from (`font-mono` upstream).
fn mono_text(size: f32, color: Hsla) -> Div {
    div()
        .font_family(MONO_FAMILY)
        .text_size(sp(size))
        .line_height(sp(size + 3.0))
        .text_color(color)
}

/// One cell of the Iteration / Tools / Cost strip: tiny uppercase label
/// with icon over a big mono value.
fn context_strip_cell(
    icon_path: &'static str,
    label: SharedString,
    value: String,
    suffix: Option<SharedString>,
    theme: &Theme,
) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(3.0))
        .min_w_0()
        .flex_1()
        .px(px(8.0))
        .py(px(7.0))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(3.0))
                .child(icon(icon_path, 9.0, theme.text_tertiary))
                .child(
                    div()
                        .text_size(sp(8.5))
                        .line_height(sp(11.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_tertiary)
                        .child(label),
                ),
        )
        .child(
            div()
                .flex()
                .items_baseline()
                .gap(px(3.0))
                .min_w_0()
                .child(
                    mono_text(12.0, theme.text)
                        .font_weight(FontWeight::SEMIBOLD)
                        .truncate()
                        .child(value),
                )
                .children(suffix.map(|suffix| {
                    div()
                        .text_size(sp(9.0))
                        .line_height(sp(12.0))
                        .text_color(theme.text_tertiary)
                        .truncate()
                        .child(suffix)
                })),
        )
}

/// One dotted cell of the per-class breakdown grid. Cells flex equally so
/// the two value columns line up across rows, like upstream's grid-cols-2.
fn breakdown_cell(label: SharedString, dot: Hsla, value: String, theme: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(5.0))
        .min_w_0()
        .flex_1()
        .child(div().size(px(6.0)).rounded_full().bg(dot).flex_none())
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(sp(10.0))
                .line_height(sp(13.0))
                .text_color(theme.text_tertiary)
                .child(label),
        )
        .child(
            mono_text(10.0, theme.text_secondary)
                .flex_none()
                .child(value),
        )
}

fn context_body(data: &ContextData, theme: &Theme) -> Div {
    let compact_line = data.last_compaction.map(|record| {
        div()
            .text_size(sp(11.0))
            .line_height(sp(15.0))
            .text_color(tools_dim(theme))
            .child(SharedString::from(format!(
                "last compact · turn {} · ~{}K → ~{}K tokens{}",
                record.turn,
                record.tokens_before / 1000,
                record.tokens_after / 1000,
                if record.summarized { "" } else { " (pruned)" },
            )))
    });
    let Some(totals) = data.totals else {
        // Occupancy only (other drivers, first moments after relaunch):
        // the caption and a plain fill bar still tell the story.
        return div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(context_meter(
                data.fill,
                data.tokens,
                data.window,
                None,
                theme,
            ))
            .children(compact_line);
    };

    // Equal thirds with hairline dividers — the border sits on the cells
    // themselves so every cell stretches the same share of the strip.
    let strip = div()
        .flex()
        .rounded(px(6.0))
        .border_1()
        .border_color(theme.border)
        .overflow_hidden()
        .child(context_strip_cell(
            "icons/cpu.svg",
            SharedString::from(tr!("usage.iteration")),
            totals.turn_calls.to_string(),
            Some(SharedString::from(format!(" / {ITERATION_MAX_STEPS}"))),
            theme,
        ))
        .child(
            context_strip_cell(
                "icons/wrench.svg",
                SharedString::from(tr!("usage.tools")),
                format_tokens(totals.calls),
                Some(SharedString::from(tr!("usage.calls_suffix"))),
                theme,
            )
            .border_l_1()
            .border_color(theme.border),
        )
        .child(
            context_strip_cell(
                "icons/circle-dollar-sign.svg",
                SharedString::from(tr!("usage.cost")),
                format!("{:.3}", totals.cost_usd),
                Some(SharedString::from("USD")),
                theme,
            )
            .border_l_1()
            .border_color(theme.border),
        );

    // The per-class cumulative grid, each row's dot matching its meter
    // segment. Upstream's meter order: cache read, input, output,
    // reasoning — cache write rides between the cache classes.
    let breakdown_rows: Vec<Vec<Div>> = vec![
        vec![
            breakdown_cell(
                SharedString::from(tr!("usage.stat_cache_read")),
                theme.text_tertiary,
                format_tokens(totals.cache_read),
                theme,
            ),
            breakdown_cell(
                SharedString::from(tr!("usage.stat_cache_write")),
                theme.text_ghost,
                format_tokens(totals.cache_write),
                theme,
            ),
        ],
        vec![
            breakdown_cell(
                SharedString::from(tr!("usage.stat_input_total")),
                theme.gauge,
                format_tokens(totals.input),
                theme,
            ),
            breakdown_cell(
                SharedString::from(tr!("usage.stat_reasoning_total")),
                theme.favorite,
                format_tokens(totals.reasoning),
                theme,
            ),
        ],
        vec![breakdown_cell(
            SharedString::from(tr!("usage.stat_output_total")),
            theme.accent,
            format_tokens(totals.output),
            theme,
        )],
    ];

    div()
        .flex()
        .flex_col()
        .gap(px(10.0))
        .child(strip)
        .child(context_meter(
            data.fill,
            data.tokens,
            data.window,
            Some(&totals.last_step),
            theme,
        ))
        .children(compact_line)
        .child(
            div().flex().flex_col().gap(px(4.0)).children(
                breakdown_rows
                    .into_iter()
                    .map(|row| div().flex().gap(px(8.0)).children(row)),
            ),
        )
}

/// The context meter: uppercase label + occupancy caption over the bar.
/// With a measured step composition the bar is segmented (cache read,
/// cache write, input, output, reasoning — each against the window);
/// without one it degrades to a single fill.
#[allow(clippy::too_many_arguments)]
fn context_meter(
    fill: f32,
    tokens: Option<u64>,
    window: Option<u64>,
    last_step: Option<&UsageBreakdown>,
    theme: &Theme,
) -> Div {
    let fill_color = fill_bar_color(fill, theme);
    let warn = fill >= CONTEXT_WARN_FILL;

    let caption_right = div()
        .flex()
        .items_baseline()
        .gap(px(3.0))
        .min_w_0()
        .children(tokens.map(|tokens| {
            mono_text(10.5, theme.text)
                .font_weight(FontWeight::SEMIBOLD)
                .child(format_tokens(tokens))
        }))
        .children(window.map(|window| {
            mono_text(10.0, theme.text_tertiary).child(format!("/ {}", format_tokens(window)))
        }))
        .when(window.is_some_and(|window| window > 0), |row| {
            row.child(
                mono_text(
                    10.5,
                    if warn {
                        theme.warning
                    } else {
                        theme.text_tertiary
                    },
                )
                .font_weight(FontWeight::SEMIBOLD)
                .child(format!("· {:.1}%", fill * 100.0)),
            )
        });

    // A measured step composition segments the bar (cache read, cache
    // write, input net of cache read, output, reasoning — each against the
    // window); an all-zero or missing one degrades to the plain fill.
    let segments: Option<(Vec<(u64, Hsla)>, u64)> = match (last_step, window) {
        (Some(step), Some(window)) if window > 0 => {
            let input = step.input_tokens.saturating_sub(step.cache_read);
            let segments = vec![
                (step.cache_read, theme.text_tertiary),
                (step.cache_write, theme.text_ghost),
                (input, theme.gauge),
                (step.output_tokens, theme.accent),
                (step.reasoning_tokens, theme.favorite),
            ];
            segments
                .iter()
                .any(|(tokens, _)| *tokens > 0)
                .then_some((segments, window))
        }
        _ => None,
    };

    let bar = div()
        .h(px(6.0))
        .w_full()
        .rounded(px(3.0))
        .bg(theme.inset)
        .overflow_hidden()
        .flex()
        .when(warn, |bar| {
            bar.border_1().border_color(theme.warning.opacity(0.40))
        });
    let bar = match segments {
        Some((segments, window)) => bar.children(segments.into_iter().map(|(tokens, color)| {
            div()
                .h_full()
                .bg(color)
                .w(relative(segment_fill(tokens, window)))
        })),
        None => bar.when(fill > 0.0, |bar| {
            bar.child(div().h_full().w(relative(fill)).bg(fill_color))
        }),
    };

    div()
        .flex()
        .flex_col()
        .gap(px(5.0))
        .child(
            div()
                .flex()
                .items_baseline()
                .gap(px(6.0))
                .min_w_0()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(sp(9.0))
                        .line_height(sp(12.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_tertiary)
                        .child(tr!("usage.context_fill").to_uppercase()),
                )
                .child(caption_right),
        )
        .child(bar)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SessionUsageTotals;

    #[test]
    fn usage_totals_accumulate_and_track_the_turn() {
        let mut persisted = SessionUsageTotals::default();
        persisted.apply_step(&UsageBreakdown {
            input_tokens: 1_000,
            output_tokens: 250,
            cache_read: 11_000,
            cache_write: 250,
            reasoning_tokens: 80,
            calls: 1,
            cost_usd: Some(0.5),
            ..Default::default()
        });
        persisted.apply_step(&UsageBreakdown {
            input_tokens: 500,
            output_tokens: 100,
            cache_read: 0,
            cache_write: 0,
            reasoning_tokens: 20,
            calls: 1,
            cost_usd: None,
            ..Default::default()
        });

        // The persisted totals carry the history and the newest composition —
        // the per-turn count is grafted on by the view, not stored.
        assert_eq!(persisted.input_tokens, 1_500);
        assert_eq!(persisted.output_tokens, 350);
        assert_eq!(persisted.cache_read, 11_000);
        assert_eq!(persisted.cache_write, 250);
        assert_eq!(persisted.reasoning_tokens, 100);
        assert_eq!(persisted.calls, 2);
        assert_eq!(persisted.cost_usd, 0.5);
        assert_eq!(persisted.last_step.as_ref().unwrap().input_tokens, 500);

        let totals = UsageTotals::from_session(&persisted, 2);
        assert_eq!(totals.turn_calls, 2);
        assert_eq!(totals.last_step.input_tokens, 500);
        // A view over a fresh session starts at zero, never at a sibling's.
        assert_eq!(
            UsageTotals::from_session(&SessionUsageTotals::default(), 0).calls,
            0
        );
    }

    #[test]
    fn context_fill_fraction_handles_unknown_and_overflowing_windows() {
        assert_eq!(context_fill(100_000, Some(200_000)), 0.5);
        assert_eq!(context_fill(50, None), 0.0); // unknown window is not "empty"
        assert_eq!(context_fill(50, Some(0)), 0.0); // a zero window carries no fraction
        assert_eq!(context_fill(300_000, Some(200_000)), 1.0); // clamped, never >1
    }

    #[test]
    fn context_data_degrades_when_measurements_are_absent() {
        // No occupancy at all: everything reads unknown.
        let none = context_data(None, None, None);
        assert_eq!(none.fill, 0.0);
        assert_eq!(none.tokens, None);
        assert_eq!(none.totals, None);

        // Occupancy without breakdowns (other drivers, first moments after
        // relaunch): the fill story survives, the grid hides.
        let usage = ContextUsage {
            tokens: 120_000,
            window: Some(200_000),
        };
        let occupancy_only = context_data(Some(&usage), None, None);
        assert_eq!(occupancy_only.fill, 0.6);
        assert!(occupancy_only.totals.is_none());
    }

    #[test]
    fn fill_bar_warns_at_upstreams_threshold() {
        let theme = crate::theme::Theme::dark();
        assert_eq!(fill_bar_color(0.0, &theme), theme.gauge);
        assert_eq!(fill_bar_color(0.79, &theme), theme.gauge);
        assert_eq!(fill_bar_color(CONTEXT_WARN_FILL, &theme), theme.warning);
        assert_eq!(fill_bar_color(1.0, &theme), theme.warning);
    }

    #[test]
    fn meter_segments_clamp_to_the_window() {
        assert_eq!(segment_fill(50_000, 200_000), 0.25);
        assert_eq!(segment_fill(300_000, 200_000), 1.0); // clamped, never overflowing
        assert_eq!(segment_fill(50_000, 0), 0.0); // no window, no share
    }
}
