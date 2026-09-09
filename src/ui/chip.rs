use gpui::{
    AnyElement, App, Context, Div, ElementId, FocusHandle, FontWeight, InteractiveElement,
    Interactivity, IntoElement, ParentElement, Pixels, RenderOnce, SharedString, Stateful,
    StyleRefinement, Styled, Window, div, prelude::FluentBuilder as _, px,
};

use crate::theme::{Theme, sp};

use super::{ActivationExt, icon};

/// The visual role a [`Chip`] plays. Tones own the border, text, and fill
/// colors; geometry comes from the builder.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum ChipTone {
    /// Neutral outline — `border_strong` edge, secondary text.
    #[default]
    Default,
    /// Destructive — `danger` edge and text over a soft danger fill.
    Danger,
    /// The active half of a segmented pair — accent border, tint, and text.
    Selected,
}

/// A focusable pill-shaped action button: icon plus short label, always
/// activated through [`ActivationExt`] so mouse clicks and bare Enter/Space
/// behave identically. This is the shared shape behind the settings copy
/// controls, the skills actions, and the git segmented pairs.
///
/// Construct through [`chip`], which wires activation; the builder then only
/// adjusts appearance.
#[derive(IntoElement)]
pub struct Chip {
    base: Stateful<Div>,
    icon: Option<(&'static str, f32)>,
    label: SharedString,
    tone: ChipTone,
    height: Pixels,
    padding_x: Pixels,
    rounded: Pixels,
    text_size: f32,
    weight: Option<FontWeight>,
    hover: bool,
    thick_focus_ring: bool,
    focus: Option<FocusHandle>,
}

/// Build a [`Chip`] whose `activate` runs on click and on bare Enter/Space.
pub fn chip<E>(
    id: impl Into<ElementId>,
    cx: &mut Context<E>,
    activate: impl Fn(&mut E, &mut Window, &mut Context<E>) + 'static,
) -> Chip
where
    E: 'static,
{
    Chip {
        base: div().id(id).on_activation(cx, activate),
        icon: None,
        label: SharedString::default(),
        tone: ChipTone::Default,
        height: px(26.0),
        padding_x: px(10.0),
        rounded: px(6.0),
        text_size: 12.5,
        weight: None,
        hover: true,
        thick_focus_ring: false,
        focus: None,
    }
}

impl Chip {
    /// A monochrome glyph ahead of the label, sized in `sp` alongside the
    /// chip's text.
    pub fn icon(mut self, path: &'static str, size: f32) -> Self {
        self.icon = Some((path, size));
        self
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = label.into();
        self
    }

    pub fn tone(mut self, tone: ChipTone) -> Self {
        self.tone = tone;
        self
    }

    pub fn height(mut self, height: Pixels) -> Self {
        self.height = height;
        self
    }

    /// Horizontal padding; chips are fixed-height so this is the only axis.
    pub fn padding_x(mut self, padding_x: Pixels) -> Self {
        self.padding_x = padding_x;
        self
    }

    pub fn rounded(mut self, rounded: Pixels) -> Self {
        self.rounded = rounded;
        self
    }

    /// Text size in `sp`.
    pub fn text_size(mut self, text_size: f32) -> Self {
        self.text_size = text_size;
        self
    }

    pub fn font_weight(mut self, weight: FontWeight) -> Self {
        self.weight = Some(weight);
        self
    }

    /// Drop the hover fill, for segmented pairs whose selection tint is the
    /// only state change they communicate.
    pub fn no_hover(mut self) -> Self {
        self.hover = false;
        self
    }

    /// Grow the focus ring from a recolored border to a 2px ring, matching
    /// the confirm/cancel pills that need the stronger affordance.
    pub fn thick_focus_ring(mut self) -> Self {
        self.thick_focus_ring = true;
        self
    }

    /// Track the given focus handle instead of an implicit one.
    pub fn track_focus(mut self, focus: &FocusHandle) -> Self {
        self.focus = Some(focus.clone());
        self
    }
}

impl Styled for Chip {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl InteractiveElement for Chip {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.base.interactivity()
    }
}

impl ParentElement for Chip {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.base.extend(elements);
    }
}

impl RenderOnce for Chip {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::current(cx);
        let (border_color, text_color, fill) = match self.tone {
            ChipTone::Default => (theme.border_strong, theme.text_secondary, None),
            ChipTone::Danger => (
                theme.danger.opacity(0.6),
                theme.danger,
                Some(theme.danger.opacity(0.12)),
            ),
            ChipTone::Selected => (theme.accent, theme.accent, Some(theme.accent.opacity(0.12))),
        };
        let focus_ring_color = if self.tone == ChipTone::Danger {
            theme.danger
        } else {
            theme.accent
        };
        let glyph = self.icon;

        self.base
            .tab_index(0)
            .when_some(self.focus, |element, focus| element.track_focus(&focus))
            .h(self.height)
            .px(self.padding_x)
            .rounded(self.rounded)
            .border_1()
            .border_color(border_color)
            .when_some(fill, |element, fill| element.bg(fill))
            .flex()
            .items_center()
            .gap(px(5.0))
            .cursor_default()
            .text_size(sp(self.text_size))
            .when_some(self.weight, |element, weight| element.font_weight(weight))
            .text_color(text_color)
            .focus_visible(|style| {
                if self.thick_focus_ring {
                    style.border_2().border_color(focus_ring_color)
                } else {
                    style.border_color(theme.accent)
                }
            })
            .when(self.hover, |element| {
                element.hover(|element| {
                    if self.tone == ChipTone::Danger {
                        element.bg(theme.danger.opacity(0.2))
                    } else {
                        element.bg(theme.overlay)
                    }
                })
            })
            .when_some(glyph, |element, (path, size)| {
                element.child(icon(path, size, theme.text_tertiary))
            })
            .child(self.label)
    }
}
