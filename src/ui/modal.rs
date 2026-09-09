//! The modal overlay treatment shared by every dialog: a theme-aware scrim
//! whose click closes, with the card riding centered above it on a deferred
//! layer that escapes clipping from any nesting depth.

use gpui::{AnyElement, InteractiveElement, IntoElement, ParentElement, Styled, div, px};

use crate::theme::Theme;

/// `card` renders centered over a full-cover scrim. The scrim darkens with
/// the theme and occludes hit-testing behind it; the deferred layer (priority
/// 4) paints above whatever view hosts it. The `id` keys the scrim for click
/// dismissal.
pub fn deferred_scrim(id: &'static str, card: impl IntoElement, theme: &Theme) -> AnyElement {
    let scrim = if theme.is_dark {
        gpui::hsla(0.0, 0.0, 0.0, 0.34)
    } else {
        gpui::hsla(0.0, 0.0, 0.0, 0.16)
    };
    let layer = div()
        .id(id)
        .absolute()
        .inset_0()
        .occlude()
        .bg(scrim)
        .p(px(24.0))
        .flex()
        .items_center()
        .justify_center()
        .child(card);
    gpui::deferred(layer).with_priority(4).into_any_element()
}
