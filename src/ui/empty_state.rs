use gpui::{
    AnyElement, App, Div, FontWeight, InteractiveElement, Interactivity, IntoElement,
    ParentElement, RenderOnce, SharedString, StyleRefinement, Styled, Window, div, prelude::*, px,
};

use crate::theme::{Theme, sp};

use super::icon;

/// The shared empty-state block: a centered column of a rounded icon tile, a
/// medium-weight title, and an optional tertiary caption, with any children
/// appended by the caller forming the CTA slot below the caption.
///
/// Two sizes cover the current call sites. The default matches a full pane
/// (Skills); [`EmptyState::compact`] matches a small popover panel (the model
/// picker). Sizing of the surrounding surface — `flex_1`, padding, panel
/// chrome — stays at the call site via the `Styled` passthrough.
#[derive(IntoElement)]
pub struct EmptyState {
    base: Div,
    icon_path: &'static str,
    title: SharedString,
    caption: Option<SharedString>,
    tile: f32,
    tile_radius: f32,
    icon_size: f32,
    title_size: f32,
    gap: f32,
}

impl EmptyState {
    pub fn new(icon_path: &'static str, title: impl Into<SharedString>) -> Self {
        Self {
            base: div(),
            icon_path,
            title: title.into(),
            caption: None,
            tile: 44.0,
            tile_radius: 11.0,
            icon_size: 21.0,
            title_size: 13.0,
            gap: 10.0,
        }
    }

    pub fn caption(mut self, caption: impl Into<SharedString>) -> Self {
        self.caption = Some(caption.into());
        self
    }

    /// The small-panel variant: a slightly tighter column for popovers.
    pub fn compact(mut self) -> Self {
        self.tile = 40.0;
        self.tile_radius = 10.0;
        self.icon_size = 19.0;
        self.title_size = 12.5;
        self.gap = 9.0;
        self
    }
}

impl Styled for EmptyState {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl InteractiveElement for EmptyState {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.base.interactivity()
    }
}

impl ParentElement for EmptyState {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.base.extend(elements);
    }
}

impl RenderOnce for EmptyState {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::current(cx);
        let caption = self.caption;
        self.base
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(self.gap))
            .child(
                div()
                    .w(px(self.tile))
                    .h(px(self.tile))
                    .rounded(px(self.tile_radius))
                    .bg(theme.overlay)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon(self.icon_path, self.icon_size, theme.text_tertiary)),
            )
            .child(
                div()
                    .text_size(sp(self.title_size))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(self.title),
            )
            .when_some(caption, |element, caption| {
                element.child(
                    div()
                        .max_w(px(420.0))
                        .text_center()
                        .text_size(sp(12.5))
                        .line_height(sp(17.0))
                        .text_color(theme.text_secondary)
                        .child(caption),
                )
            })
    }
}
