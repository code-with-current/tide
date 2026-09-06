//! The shared scroll-fade: a gradient overlay dissolving content into its
//! surface at the edges of a scrollable region, painted on a canvas so a
//! hidden side costs nothing. Callers previously kept four near-identical
//! copies (right-panel tab strip x-axis, transcript activity y-axis,
//! navigation-rail visibility, and inline variants); this module is those
//! copies lifted verbatim, parameterized by axis and side.
//!
//! Perf note: the overlay paints on every frame while its scroll region
//! moves. Keep the canvas idiom exactly — read the handle, build at most one
//! gradient, paint at most one quad. No allocation beyond the `Some(quad)`
//! that the visible side already produces today.

use gpui::{
    Axis, Hsla, IntoElement, Pixels, ScrollHandle, Styled, canvas, fill, linear_color_stop,
    linear_gradient, prelude::FluentBuilder, px,
};

/// Which edge of the scroll region a fade belongs to. `Start` is the leading
/// edge (left for a horizontal region, top for a vertical one); `End` is the
/// trailing edge.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScrollFadeSide {
    Start,
    End,
}

/// Whether the start/end fades should show: only toward content that is
/// currently hidden. `(start, end)` — both false when nothing is scrolled
/// out of view. `offset` is the scroll handle's offset along the fade axis
/// (negative while scrolled), `max_offset` the handle's max along that axis.
pub fn visibility(offset: Pixels, max_offset: Pixels) -> (bool, bool) {
    let scrolled = -offset;
    let threshold = px(0.5);
    (scrolled > threshold, max_offset - scrolled > threshold)
}

/// A canvas overlay painting the gradient fade toward `surface` on one edge
/// of a scroll region. Position it inside the scroll region's clipped
/// container; the element is absolutely placed along `axis` and stretches
/// across the perpendicular axis. `width` is the fade's extent along `axis`
/// in pixels (24.0 for the tab strip, 18.0 for transcript activity panes).
pub fn overlay(
    scroll: ScrollHandle,
    axis: Axis,
    side: ScrollFadeSide,
    width: f32,
    surface: Hsla,
) -> impl IntoElement {
    canvas(
        move |bounds, _, _| {
            let (offset, max_offset) = match axis {
                Axis::Horizontal => (scroll.offset().x, scroll.max_offset().x),
                Axis::Vertical => (scroll.offset().y, scroll.max_offset().y),
            };
            let (show_start, show_end) = visibility(offset, max_offset);
            let visible = match side {
                ScrollFadeSide::Start => show_start,
                ScrollFadeSide::End => show_end,
            };
            visible.then(|| {
                let angle = match axis {
                    Axis::Horizontal => 90.0,
                    Axis::Vertical => 180.0,
                };
                let transparent = surface.opacity(0.0);
                let background = match side {
                    ScrollFadeSide::Start => linear_gradient(
                        angle,
                        linear_color_stop(surface, 0.0),
                        linear_color_stop(transparent, 1.0),
                    ),
                    ScrollFadeSide::End => linear_gradient(
                        angle,
                        linear_color_stop(transparent, 0.0),
                        linear_color_stop(surface, 1.0),
                    ),
                };
                fill(bounds, background)
            })
        },
        |_, fade, window, _| {
            if let Some(fade) = fade {
                window.paint_quad(fade);
            }
        },
    )
    .absolute()
    .when(axis == Axis::Horizontal, |element| {
        element
            .top_0()
            .bottom_0()
            .w(px(width))
            .when(side == ScrollFadeSide::Start, |element| element.left_0())
            .when(side == ScrollFadeSide::End, |element| element.right_0())
    })
    .when(axis == Axis::Vertical, |element| {
        element
            .left_0()
            .w_full()
            .h(px(width))
            .when(side == ScrollFadeSide::Start, |element| element.top_0())
            .when(side == ScrollFadeSide::End, |element| element.bottom_0())
    })
}

/// Nudge a scroll offset so the item at `[item_start, item_end]` clears the
/// fade insets on both edges of `[viewport_start, viewport_end]`, clamped to
/// the scrollable range. Used by reveal guards that scroll a hidden item far
/// enough in from the edge to clear the fade. All coordinates along one axis;
/// `inset` is the fade width.
pub fn fade_safe_offset(
    current_offset: Pixels,
    max_offset: Pixels,
    item_start: Pixels,
    item_end: Pixels,
    viewport_start: Pixels,
    viewport_end: Pixels,
    inset: f32,
) -> Pixels {
    let inset = px(inset);
    let mut offset = current_offset;
    let visible_start = item_start + offset;
    let visible_end = item_end + offset;
    if visible_start < viewport_start + inset {
        offset += viewport_start + inset - visible_start;
    } else if visible_end > viewport_end - inset {
        offset -= visible_end - (viewport_end - inset);
    }
    offset.clamp(-max_offset, px(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fades_only_show_toward_hidden_content() {
        assert_eq!(visibility(px(0.0), px(120.0)), (false, true));
        assert_eq!(visibility(px(-40.0), px(120.0)), (true, true));
        assert_eq!(visibility(px(-120.0), px(120.0)), (true, false));
        assert_eq!(visibility(px(0.0), px(0.0)), (false, false));
    }

    #[test]
    fn fade_safe_offset_clears_the_inset_on_both_sides() {
        // Item under the left fade gets pushed right until it clears.
        assert_eq!(
            fade_safe_offset(
                px(-100.0),
                px(300.0),
                px(90.0),
                px(190.0),
                px(0.0),
                px(300.0),
                24.0,
            ),
            px(-66.0)
        );
        // Item under the right fade gets pushed left until it clears.
        assert_eq!(
            fade_safe_offset(
                px(-100.0),
                px(324.0),
                px(300.0),
                px(400.0),
                px(0.0),
                px(300.0),
                24.0,
            ),
            px(-124.0)
        );
        // An already-safe offset is returned unchanged.
        assert_eq!(
            fade_safe_offset(
                px(0.0),
                px(0.0),
                px(0.0),
                px(100.0),
                px(0.0),
                px(300.0),
                24.0,
            ),
            px(0.0)
        );
    }
}
