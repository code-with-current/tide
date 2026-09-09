//! The settings group pattern: a page header (title + description + optional
//! page action), then small uppercase group eyebrows above bordered card
//! bodies of rows — old Tide's SettingsHeader / SettingsGroup / Card.
//! Visual spec (measurements, both themes): `docs/mockups/settings-cards.html`.
//!
//! Everything here is a pure constructor over plain data — no state, no I/O,
//! nothing a render frame reaches beyond element building. Activation goes
//! through [`ActivationExt`], so every button lands with the same
//! click + bare-Enter/Space behavior and focus treatment for free.

use gpui::{
    AnyElement, Context, Div, ElementId, FontWeight, Hsla, InteractiveElement, ParentElement,
    SharedString, Stateful, Styled, Window, div, prelude::*, px,
};

use crate::theme::{Theme, sp};

use super::{ActivationExt, icon, motion};

/// Page header: 18sp semibold title with an optional muted description
/// beneath it, optional page-level action right. Old Tide's SettingsHeader.
pub fn settings_page_header(
    theme: &Theme,
    title: impl Into<SharedString>,
    description: Option<SharedString>,
    action: Option<AnyElement>,
) -> Div {
    div()
        .flex()
        .items_start()
        .justify_between()
        .gap(px(16.0))
        .pb(px(6.0))
        .child(
            div()
                .min_w_0()
                .child(
                    div()
                        .text_size(sp(18.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text)
                        .child(title.into()),
                )
                .children(description.map(|description| {
                    div()
                        .mt(px(4.0))
                        .text_size(sp(12.0))
                        .line_height(sp(17.0))
                        .whitespace_normal()
                        .text_color(theme.text_tertiary)
                        .child(description)
                })),
        )
        .children(action)
}

/// Group eyebrow: a small uppercase muted label left, actions/hint
/// right-aligned — the one quiet title above a bordered card.
pub fn settings_group_head(
    theme: &Theme,
    title: impl Into<SharedString>,
    actions: Vec<AnyElement>,
) -> Div {
    let title = title.into();
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .min_h(px(22.0))
        .pb(px(8.0))
        .child(
            div()
                .text_size(sp(10.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_tertiary)
                .child(SharedString::from(title.to_uppercase())),
        )
        .when(!actions.is_empty(), |head| {
            head.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .flex_none()
                    .children(actions),
            )
        })
}

/// Small status pill for card heads: quiet overlay surface, a colored dot
/// paired with the label so state never rides on color alone.
pub fn card_pill(theme: &Theme, label: impl Into<SharedString>, color: Hsla) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(5.0))
        .h(px(20.0))
        .px(px(9.0))
        .flex_none()
        .rounded_full()
        .bg(theme.overlay)
        .text_size(sp(11.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(color)
        .child(div().size(px(5.0)).rounded_full().bg(color))
        .child(label.into())
}

/// One row of a card body: label (plus an optional description or hint line)
/// on the left, the row's control on the right. Rows built through
/// [`card_rows`] get a hairline separator above every row but the first.
pub struct CardRow {
    label: SharedString,
    description: Option<SharedString>,
    hint: Option<SharedString>,
    control: Option<AnyElement>,
}

impl CardRow {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            description: None,
            hint: None,
            control: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// A tertiary one-liner (field guidance), visually smaller than
    /// `description` — the two never appear on the same row.
    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn control(mut self, control: impl IntoElement) -> Self {
        self.control = Some(control.into_any_element());
        self
    }

    /// How many text lines sit under the label — the pure bit of the row's
    /// layout, kept testable.
    #[cfg(test)]
    fn secondary_lines(&self) -> usize {
        usize::from(self.description.is_some()) + usize::from(self.hint.is_some())
    }
}

fn row_divider(index: usize) -> bool {
    index > 0
}

/// A card body's rows: label-left / control-right with hairline separators
/// between them.
pub fn card_rows(theme: &Theme, rows: Vec<CardRow>) -> Div {
    let mut container = div().flex().flex_col().w_full();

    for (index, row) in rows.into_iter().enumerate() {
        let CardRow {
            label,
            description,
            hint,
            control,
        } = row;

        let label_block = div()
            .flex_1()
            .min_w_0()
            .child(
                div()
                    .text_size(sp(13.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(label),
            )
            .children(description.map(|description| {
                div()
                    .mt(px(3.0))
                    .text_size(sp(12.5))
                    .line_height(sp(18.0))
                    .text_color(theme.text_secondary)
                    .child(description)
            }))
            .children(hint.map(|hint| {
                div()
                    .mt(px(3.0))
                    .text_size(sp(11.0))
                    .text_color(theme.text_tertiary)
                    .child(hint)
            }));

        let mut row_element = div()
            .when(row_divider(index), |element| {
                element.border_t_1().border_color(theme.border)
            })
            .flex()
            .items_center()
            .gap(px(24.0))
            .py(px(12.0))
            .child(label_block);

        if let Some(control) = control {
            row_element = row_element.child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(control),
            );
        }

        container = container.child(row_element);
    }

    container
}

/// The bordered group surface rows sit on (old Tide's Card: bg + border +
/// clip). Rows carry their own vertical padding, so the body only pads the
/// sides and trims the first/last row's padding optically.
pub fn card_body(theme: &Theme) -> Div {
    div()
        .w_full()
        .bg(theme.raised)
        .border_1()
        .border_color(theme.border)
        .rounded(px(13.0))
        .px(px(20.0))
        .pt(px(4.0))
        .pb(px(6.0))
}

/// Full-bleed variant for list bodies (knowledge sources, allowed apps):
/// no side padding and clips its children so per-row separators and the
/// last row's rounding stay clean.
pub fn card_body_flush(theme: &Theme) -> Div {
    div()
        .w_full()
        .bg(theme.raised)
        .border_1()
        .border_color(theme.border)
        .rounded(px(13.0))
        .overflow_hidden()
}

/// The unified settings action button — bordered, 27px, one focus/hover/
/// keyboard treatment. Replaces the six hand-built copies that had drifted
/// to 26–29px heights and 6–7px radii. `busy` swaps the content for a
/// spinner and makes the button inert; `disabled` dims it inert; disabled
/// wins when both are set.
pub struct CardButton {
    id: ElementId,
    label: SharedString,
    icon_path: Option<&'static str>,
    busy: bool,
    disabled: bool,
    ghost: bool,
}

impl CardButton {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon_path: None,
            busy: false,
            disabled: false,
            ghost: false,
        }
    }

    pub fn icon(mut self, path: &'static str) -> Self {
        self.icon_path = Some(path);
        self
    }

    pub fn busy(mut self, busy: bool) -> Self {
        self.busy = busy;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Tertiary text action (Remove, Reset, Regenerate): no border, quieter
    /// color, tighter hit box that still clears the minimum target.
    pub fn ghost(mut self) -> Self {
        self.ghost = true;
        self
    }

    pub fn render<E: 'static>(
        self,
        theme: Theme,
        cx: &mut Context<E>,
        activate: impl Fn(&mut E, &mut Window, &mut Context<E>) + 'static,
    ) -> Stateful<Div> {
        let inert = self.busy || self.disabled;
        let base = if self.ghost {
            div()
                .h(px(24.0))
                .px(px(7.0))
                .text_size(sp(12.0))
                .text_color(theme.text_tertiary)
                .hover(|element| element.bg(theme.overlay).text_color(theme.text_secondary))
        } else {
            div()
                .h(px(27.0))
                .px(px(11.0))
                .rounded(px(7.0))
                .border_1()
                .border_color(theme.border_strong)
                .text_size(sp(12.0))
                .text_color(theme.text_secondary)
                .hover(|element| element.bg(theme.overlay))
        };

        let base = base
            .id(self.id)
            .tab_index(0)
            .focus_visible(|style| style.border_color(theme.accent))
            .flex()
            .items_center()
            .gap(px(6.0))
            .flex_none()
            .cursor_default()
            .opacity(button_opacity(self.busy, self.disabled));

        let base = if self.busy {
            base.child(motion::spin(icon(
                "icons/loader-circle.svg",
                11.0,
                theme.text_tertiary,
            )))
            .child(self.label)
        } else {
            base.children(
                self.icon_path
                    .map(|path| icon(path, 11.0, theme.text_tertiary)),
            )
            .child(self.label)
        };

        if inert {
            base
        } else {
            base.on_activation(cx, activate)
        }
    }
}

/// Inert dimming: busy reads as working (0.6), disabled as unavailable
/// (0.55); when both apply the button is unavailable, so disabled wins.
fn button_opacity(busy: bool, disabled: bool) -> f32 {
    if disabled {
        0.55
    } else if busy {
        0.6
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_divider_follows_index() {
        assert!(!row_divider(0));
        assert!(row_divider(1));
        assert!(row_divider(7));
    }

    #[test]
    fn button_opacity_is_busy_and_disabled_aware() {
        assert_eq!(button_opacity(false, false), 1.0);
        assert_eq!(button_opacity(true, false), 0.6);
        assert_eq!(button_opacity(false, true), 0.55);
        assert_eq!(button_opacity(true, true), 0.55);
    }

    #[test]
    fn row_secondary_lines_count_description_and_hint() {
        assert_eq!(CardRow::new("label").secondary_lines(), 0);
        assert_eq!(CardRow::new("label").description("d").secondary_lines(), 1);
        assert_eq!(CardRow::new("label").hint("h").secondary_lines(), 1);
        // The two never coexist by contract; if both are set they both count
        // so a render asserting on the count notices the misuse.
        assert_eq!(
            CardRow::new("label")
                .description("d")
                .hint("h")
                .secondary_lines(),
            2
        );
    }
}
