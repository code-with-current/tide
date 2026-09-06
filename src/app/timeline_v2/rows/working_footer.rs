//! The live turn's closing row — tide's TurnWorkingFooter. A left-aligned
//! 24px strip: the three-dot wave (the still-working signal) and the
//! elapsed ticker reading the turn's full wall clock from its start, not
//! from the row's mount. The ticker recomputes at render: the stream pump's
//! commit cadence and the dots' own pulse lease both keep the pane waking,
//! so no new timer is scheduled here.

use super::turn_item::format_duration;
use crate::theme::{Theme, sp};
use crate::ui::pixel_loader::{PixelLoader, PixelLoaderSize, PixelLoaderVariant};
use gpui::prelude::*;
use gpui::{AnyElement, Div, Hsla, SharedString, div, px};
use std::time::Duration;

/// Seconds a running turn has been alive: `now - started`, floored at zero
/// so a clock that sits behind the turn's start reads nothing rather than
/// a negative count.
pub(crate) fn elapsed_since(started_unix: u64, now_unix: u64) -> u64 {
    now_unix.saturating_sub(started_unix)
}

/// Three dots chasing a brightness wave, the pane's "still working"
/// signal — shared with the streaming reasoning part, so a live thought and
/// the footer that closes its turn read as one continuous activity. Copied
/// fresh from the legacy pane's `working_wave_dots` (not imported — the v2
/// pane owns its row anatomy): each dot rides the shared pulse clock with a
/// phase offset so the bright spot travels left to right, and the whole
/// loader takes the half cadence because it stays mounted for the turn's
/// full length. Under reduce-motion the clock holds the cycle's first
/// frame, which reads as a static ellipsis.
pub(crate) fn wave_dots(color: Hsla) -> AnyElement {
    const DOT_PHASE_STEP: f32 = 0.18;
    crate::ui::motion::pulse(Duration::from_millis(1400), move |phase| {
        div()
            .flex()
            .items_center()
            .gap(px(3.5))
            .children((0..3).map(|index| {
                let dot_phase = (phase + 1.0 - index as f32 * DOT_PHASE_STEP) % 1.0;
                let wave = ((dot_phase * std::f32::consts::TAU).sin() + 1.0) / 2.0;
                div()
                    .size(px(4.5))
                    .flex_none()
                    .rounded_full()
                    .bg(color)
                    .opacity(0.25 + 0.75 * wave)
            }))
            .into_any_element()
    })
    .every(2)
    .into_any_element()
}

/// The working footer: wave dots, then the elapsed ticker in the footer's
/// ghost meta tone. `started_at` absent (no running turn to read) leaves
/// the dots alone — the row still says "working", it just cannot say for
/// how long.
pub(crate) fn render_working_footer(started_at: Option<u64>, now_unix: u64, theme: &Theme) -> Div {
    div()
        .h(px(24.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .child(
            PixelLoader::new()
                .variant(PixelLoaderVariant::Orbit)
                .size(PixelLoaderSize::Custom(18.0)),
        )
        .child(
            div()
                .text_size(sp(11.0))
                .text_color(theme.text_ghost)
                .child(SharedString::from("working")),
        )
        .when_some(started_at, |row, started_at| {
            row.child(
                div()
                    .text_size(sp(11.0))
                    .text_color(theme.text_ghost)
                    .child(SharedString::from(format_duration(elapsed_since(
                        started_at, now_unix,
                    )))),
            )
        })
}
