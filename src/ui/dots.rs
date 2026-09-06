use std::time::Duration;

use gpui::{AnyElement, Hsla, IntoElement, ParentElement, Styled, div, pulsating_between, px};

use crate::ui::motion;

/// A dot breathing on the shared pulse clock — the compact "live" signal used
/// beside running work.
pub fn pulse_dot(size: f32, color: Hsla) -> AnyElement {
    motion::pulse(Duration::from_millis(1600), move |phase| {
        div()
            .w(px(size))
            .h(px(size))
            .flex_none()
            .rounded_full()
            .bg(color)
            .opacity(pulsating_between(0.3, 1.0)(phase))
            .into_any_element()
    })
    // Mounted for whole activities; its pane must not tick at full rate.
    .every(2)
    .into_any_element()
}

/// Three dots chasing a brightness wave, the transcript's "still working"
/// signal. Each dot rides the shared pulse clock with a phase offset, so the
/// bright spot travels left to right. Under reduce-motion the clock holds the
/// cycle's first frame — the lead dot bright, the tail dim — which reads as a
/// static ellipsis.
pub fn working_wave_dots(color: Hsla) -> AnyElement {
    const DOT_PHASE_STEP: f32 = 0.18;
    motion::pulse(Duration::from_millis(1400), move |phase| {
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
    // Mounted for the whole turn: this is what sets the transcript pane's
    // tick floor, and every tick rebuilds each visible row. The 1400 ms wave
    // reads identically at half cadence.
    .every(2)
    .into_any_element()
}
