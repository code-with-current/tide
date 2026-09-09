use gpui::prelude::FluentBuilder as _;
use gpui::{
    Animation, AnimationExt, App, FontWeight, Hsla, IntoElement, ParentElement, RenderOnce,
    SharedString, Styled, Window, div, px,
};
use std::time::Duration;

// ---------------------------------------------------------------------
// Variant + size
// ---------------------------------------------------------------------

/// Which staggered animation pattern the loader plays. The full ported
/// pattern set ships even where the app plays only some of it.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PixelLoaderVariant {
    /// Square cells, chevron wavefront driving right.
    Drive,
    /// Same wavefront as `Drive`, circular cells.
    Dots,
    /// Column-by-column wipe, left to right.
    Wave,
    /// Dots pulse outward from the center.
    Ripple,
    /// All cells flash in sync — a simple heartbeat.
    Pulse,
    /// Cells twinkle in a scattered, non-linear order.
    Sparkle,
    /// A comet lapping the grid perimeter.
    Orbit,
    /// Two crossed pixel rings spinning opposite ways (armillary sphere).
    Globe,
}

/// A size preset, or an exact pixel value via `Custom`. The full preset
/// ladder ships for parity even where only some sizes are used.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum PixelLoaderSize {
    Xs,
    Sm,
    Md,
    Lg,
    Xl,
    Custom(f32),
}

impl PixelLoaderSize {
    fn px(self) -> f32 {
        match self {
            Self::Xs => 12.0,
            Self::Sm => 16.0,
            Self::Md => 20.0,
            Self::Lg => 28.0,
            Self::Xl => 36.0,
            Self::Custom(v) => v,
        }
    }
}

impl Default for PixelLoaderSize {
    fn default() -> Self {
        Self::Sm
    }
}

// ---------------------------------------------------------------------
// Pulse curve (see note 2 above)
// ---------------------------------------------------------------------

const PULSE_BASE: f32 = 0.15;
const PULSE_RISE: f32 = 0.18; // fraction of the cycle spent brightening
const PULSE_FALL: f32 = 0.55; // fraction of the cycle spent dimming back down

fn ease_out(t: f32) -> f32 {
    1.0 - (1.0 - t) * (1.0 - t)
}

fn ease_in(t: f32) -> f32 {
    t * t
}

/// Maps a 0..1 phase within the loop to an opacity, dim baseline with a
/// brief bright peak — this is the stand-in for the original `pixel-on`
/// keyframes.
fn pixel_pulse(phase: f32) -> f32 {
    let phase = phase.rem_euclid(1.0);
    let bright = if phase < PULSE_RISE {
        ease_out(phase / PULSE_RISE)
    } else if phase < PULSE_RISE + PULSE_FALL {
        1.0 - ease_in((phase - PULSE_RISE) / PULSE_FALL)
    } else {
        0.0
    };
    PULSE_BASE + (1.0 - PULSE_BASE) * bright.clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------
// Grid patterns (direct port of the `PATTERNS` table)
// ---------------------------------------------------------------------

struct Pattern {
    /// Per-cell delay in ms, or `None` for a static dim cell with no
    /// animation (used by `Orbit`'s empty center).
    delays: [Option<f32>; 9],
    dur_ms: f32,
    round: bool,
}

fn chevron_delays() -> [f32; 9] {
    std::array::from_fn(|i| {
        let (r, c) = (i / 3, i % 3);
        (c as f32 + (r as f32 - 1.0).abs()) * 90.0
    })
}

fn wave_delays() -> [f32; 9] {
    std::array::from_fn(|i| (i % 3) as f32 * 120.0)
}

fn ripple_delays() -> [f32; 9] {
    std::array::from_fn(|i| {
        let (r, c) = (i / 3, i % 3);
        let (dr, dc) = (r as f32 - 1.0, c as f32 - 1.0);
        (dr.hypot(dc) * 100.0).round()
    })
}

const SPARKLE_ORDER: [usize; 9] = [4, 0, 6, 2, 8, 1, 7, 3, 5];

fn sparkle_delays() -> [f32; 9] {
    std::array::from_fn(|i| {
        let k = SPARKLE_ORDER.iter().position(|&x| x == i).unwrap();
        k as f32 * 80.0
    })
}

const ORBIT_ORDER: [usize; 8] = [0, 1, 2, 5, 8, 7, 6, 3];

fn orbit_delays() -> [Option<f32>; 9] {
    std::array::from_fn(|i| {
        ORBIT_ORDER
            .iter()
            .position(|&x| x == i)
            .map(|k| k as f32 * 110.0)
    })
}

fn pattern_for(variant: PixelLoaderVariant) -> Pattern {
    match variant {
        PixelLoaderVariant::Drive => Pattern {
            delays: chevron_delays().map(Some),
            dur_ms: 800.0,
            round: false,
        },
        PixelLoaderVariant::Dots => Pattern {
            delays: chevron_delays().map(Some),
            dur_ms: 900.0,
            round: true,
        },
        PixelLoaderVariant::Wave => Pattern {
            delays: wave_delays().map(Some),
            dur_ms: 900.0,
            round: true,
        },
        PixelLoaderVariant::Ripple => Pattern {
            delays: ripple_delays().map(Some),
            dur_ms: 900.0,
            round: true,
        },
        PixelLoaderVariant::Pulse => Pattern {
            delays: [Some(0.0); 9],
            dur_ms: 900.0,
            round: true,
        },
        PixelLoaderVariant::Sparkle => Pattern {
            delays: sparkle_delays().map(Some),
            dur_ms: 550.0,
            round: true,
        },
        PixelLoaderVariant::Orbit => Pattern {
            delays: orbit_delays(),
            dur_ms: 950.0,
            round: false,
        },
        PixelLoaderVariant::Globe => unreachable!("Globe has its own render path"),
    }
}

/// One grid cell: a static dim square if `delay_ms` is `None`, otherwise
/// an infinitely-repeating opacity pulse phase-shifted by its delay.
fn grid_cell(
    id: impl Into<SharedString>,
    size_px: f32,
    round: bool,
    color: Hsla,
    delay_ms: Option<f32>,
    dur_ms: f32,
) -> gpui::AnyElement {
    let base = div()
        .size(px(size_px))
        .bg(color)
        .when(round, |d| d.rounded_full())
        .when(!round, |d| d.rounded(px(1.0)));

    let Some(delay_ms) = delay_ms else {
        return base.opacity(0.07).into_any_element();
    };

    let phase_offset = (delay_ms / dur_ms).rem_euclid(1.0);

    base.opacity(PULSE_BASE)
        .with_animation(
            id.into(),
            Animation::new(Duration::from_millis(dur_ms.round() as u64)).repeat(),
            move |cell, delta| cell.opacity(pixel_pulse(delta + phase_offset)),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------
// Globe variant (see note 1 above — dots move, nothing rotates)
// ---------------------------------------------------------------------

fn ring_dot(
    id: SharedString,
    base_deg: f32,
    center: f32,
    radius_x: f32,
    radius_y: f32,
    dot_px: f32,
    period_ms: u64,
    reverse: bool,
    color: Hsla,
) -> gpui::AnyElement {
    // Fixed per-slot opacity, matching the original: the shading pattern
    // rotates together with the ring rather than reacting to absolute
    // screen angle.
    let opacity = (0.2 + 0.5 * ((base_deg + 90.0).to_radians().cos())).clamp(0.05, 1.0);

    div()
        .absolute()
        .size(px(dot_px))
        .rounded(px(1.0))
        .bg(color)
        .opacity(opacity)
        .with_animation(
            id,
            Animation::new(Duration::from_millis(period_ms)).repeat(),
            move |this, delta| {
                let delta = if reverse { 1.0 - delta } else { delta };
                let angle = (base_deg + delta * 360.0).to_radians();
                let x = center + radius_x * angle.cos() - dot_px / 2.0;
                let y = center + radius_y * angle.sin() - dot_px / 2.0;
                this.left(px(x)).top(px(y))
            },
        )
        .into_any_element()
}

fn render_globe(size_px: f32, color: Hsla) -> impl IntoElement {
    let dot_px = (size_px * 0.19).max(2.0);
    let radius = size_px / 2.0 - dot_px / 2.0;
    let center = size_px / 2.0;

    div()
        .relative()
        .size(px(size_px))
        .children((0..8).map(|i| {
            ring_dot(
                SharedString::from(format!("pixel-loader-globe-a-{i}")),
                i as f32 * 45.0,
                center,
                radius,
                radius, // circular ring
                dot_px,
                1100,
                false,
                color,
            )
        }))
        .children((0..8).map(|i| {
            ring_dot(
                SharedString::from(format!("pixel-loader-globe-b-{i}")),
                i as f32 * 45.0,
                center,
                radius,
                radius * 0.45, // squashed into an ellipse, crosses ring A
                dot_px,
                1600,
                true,
                color,
            )
        }))
}

// ---------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------

/// ```ignore
/// PixelLoader::new()
///     .variant(PixelLoaderVariant::Ripple)
///     .size(PixelLoaderSize::Md)
///     .label("Thinking")
///     .elapsed("0:42")
/// ```
#[derive(IntoElement)]
pub struct PixelLoader {
    variant: PixelLoaderVariant,
    size: PixelLoaderSize,
    label: Option<SharedString>,
    elapsed: Option<SharedString>,
    color: Hsla,
}

impl PixelLoader {
    pub fn new() -> Self {
        Self {
            variant: PixelLoaderVariant::Drive,
            size: PixelLoaderSize::default(),
            label: None,
            elapsed: None,
            // Placeholder "muted foreground" gray — wire to your theme.
            color: gpui::hsla(0.0, 0.0, 0.6, 1.0),
        }
    }

    pub fn variant(mut self, variant: PixelLoaderVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: PixelLoaderSize) -> Self {
        self.size = size;
        self
    }

    #[allow(dead_code)] // ported builder knob; the turn footer doesn't call it yet
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    #[allow(dead_code)] // ported builder knob; the turn footer doesn't call it yet
    pub fn elapsed(mut self, elapsed: impl Into<SharedString>) -> Self {
        self.elapsed = Some(elapsed.into());
        self
    }

    #[allow(dead_code)] // ported builder knob; the turn footer doesn't call it yet
    pub fn color(mut self, color: impl Into<Hsla>) -> Self {
        self.color = color.into();
        self
    }
}

impl Default for PixelLoader {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderOnce for PixelLoader {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let size_px = self.size.px();
        let color = self.color;
        let gap_outer = (size_px * 0.625).max(6.0);

        let indicator = if self.variant == PixelLoaderVariant::Globe {
            render_globe(size_px, color).into_any_element()
        } else {
            let pattern = pattern_for(self.variant);
            let cell_px = (size_px / 4.2).max(2.0);
            let gap = (cell_px * 0.375).max(1.0);

            div()
                .flex()
                .flex_col()
                .gap(px(gap))
                .children((0..3).map(|row| {
                    div().flex().gap(px(gap)).children((0..3).map(|col| {
                        let i = row * 3 + col;
                        grid_cell(
                            format!("pixel-loader-{:?}-{i}", self.variant),
                            cell_px,
                            pattern.round,
                            color,
                            pattern.delays[i],
                            pattern.dur_ms,
                        )
                    }))
                }))
                .into_any_element()
        };

        div()
            .flex()
            .items_center()
            .gap(px(gap_outer))
            .text_color(color)
            .child(indicator)
            .when_some(self.label, |el, label| {
                el.child(
                    div()
                        .font_weight(FontWeight::MEDIUM)
                        .text_size(px((size_px * 0.8125).max(10.0)))
                        .child(label),
                )
            })
            .when_some(self.elapsed, |el, elapsed| {
                el.child(
                    div()
                        // TODO: point this at your monospace text style —
                        // GPUI's font-family hookup depends on how your
                        // app registers fonts (e.g. via `Label` in the
                        // `ui` crate, or a custom `TextStyle`).
                        .text_size(px((size_px * 0.75).max(9.0)))
                        .opacity(0.5)
                        .child(elapsed),
                )
            })
    }
}
