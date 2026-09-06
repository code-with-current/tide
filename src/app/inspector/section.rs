//! The collapsible section primitive, matching upstream tide's PanelSection:
//! a VSCode-style header (chevron + uppercase semibold title + optional
//! badge, with an optional right-aligned action outside the toggle) over a
//! two-tone body, sections separated by hairline borders. Headers are
//! keyboard-operable — focusable, Enter/Space toggles, visible focus ring —
//! and the hit area is the full row, not just the glyph.

use super::*;

pub(super) fn render_section<Body: IntoElement>(
    section: SectionId,
    title: &str,
    badge: Option<SharedString>,
    action: Option<Stateful<Div>>,
    collapsed: bool,
    body: Body,
    theme: &Theme,
    cx: &mut Context<Tide>,
) -> Div {
    let chevron = if collapsed {
        icon("icons/chevron-right.svg", 11.0, theme.text_tertiary)
    } else {
        icon("icons/chevron-down.svg", 11.0, theme.text_tertiary)
    };
    let title_label = div()
        .text_size(sp(10.5))
        .line_height(sp(14.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme.text_tertiary)
        .child(title.to_uppercase());
    let badge_el = badge.map(|badge| {
        div()
            .px(px(4.0))
            .py(px(1.0))
            .rounded(px(4.0))
            .border_1()
            .border_color(theme.border)
            .bg(theme.overlay)
            .flex()
            .items_center()
            .flex_none()
            .child(
                div()
                    .text_size(sp(9.0))
                    .line_height(sp(11.0))
                    .text_color(theme.text_tertiary)
                    .child(badge),
            )
    });
    let toggle = div()
        .id(section.header_id())
        .flex()
        .items_center()
        .gap(px(4.0))
        .min_w_0()
        .flex_1()
        .h(px(24.0))
        .px(px(3.0))
        .rounded(px(5.0))
        .cursor_default()
        .tab_index(0)
        // .hover(|style| style.bg(theme.overlay).text_color(theme.text_secondary))
        .focus_visible(|style| style.border_1().border_color(theme.accent))
        .child(chevron)
        .child(title_label)
        .when_some(badge_el, |row, badge| row.child(badge))
        .on_click(cx.listener(move |this, _, _, cx| {
            this.inspector.toggle(section);
            cx.notify();
        }))
        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                this.inspector.toggle(section);
                cx.notify();
                cx.stop_propagation();
            }
        }));
    div()
        .flex()
        .flex_col()
        .border_b_1()
        .border_color(theme.border)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(4.0))
                .px(px(9.0))
                .py(px(4.0))
                .child(toggle)
                .children(action),
        )
        .when(!collapsed, |element| {
            element.child(
                div()
                    .px(px(12.0))
                    .py(px(10.0))
                    .bg(theme.surface.opacity(0.55))
                    .flex()
                    .flex_col()
                    .child(body),
            )
        })
}
