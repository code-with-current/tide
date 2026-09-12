//! The no-project empty state: tide's first-run onboarding composition.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, KeyDownEvent, div, px};

use crate::app::Tide;
use crate::theme::{Theme, sp};
use crate::ui::icon;

impl Tide {
    pub(in crate::app) fn render_empty_state(&self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        div()
            .flex_1()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px_8()
            .pb(px(46.0))
            .child(icon("icons/sparkle.svg", 24.0, theme.accent))
            .child(
                div()
                    .mt(px(16.0))
                    .text_size(sp(20.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(tr_cow!("onboarding.open_project_to_begin")),
            )
            .child(
                div()
                    .mt(px(8.0))
                    .max_w(px(380.0))
                    .text_center()
                    .text_size(sp(12.5))
                    .line_height(sp(19.0))
                    .text_color(theme.text_tertiary)
                    .child(tr_cow!("onboarding.description")),
            )
            .child(
                div()
                    .mt(px(20.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(8.0))
                    .tab_index(0)
                    .tab_group()
                    .tab_stop(false)
                    .child(
                        div()
                            .id("onboarding-add-project")
                            .track_focus(&self.onboarding_add_project_focus)
                            .tab_index(0)
                            .focus_visible(|style| style.border_1().border_color(theme.accent))
                            .h(px(32.0))
                            .px(px(14.0))
                            .rounded_full()
                            .flex()
                            .items_center()
                            .cursor_default()
                            .bg(theme.inverse)
                            .text_color(theme.on_inverse)
                            .text_size(sp(12.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .hover(|element| element.opacity(0.9))
                            .active(|element| element.opacity(0.8))
                            .child(tr_cow!("onboarding.open_project_folder"))
                            .on_click(cx.listener(|this, _, _, cx| this.add_project(cx)))
                            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                    this.add_project(cx);
                                    cx.stop_propagation();
                                }
                            })),
                    )
                    .child(
                        div()
                            .id("onboarding-projectless")
                            .track_focus(&self.onboarding_projectless_focus)
                            .tab_index(1)
                            .focus_visible(|style| style.border_1().border_color(theme.accent))
                            .h(px(30.0))
                            .px(px(12.0))
                            .rounded_full()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .cursor_default()
                            .text_color(theme.text_secondary)
                            .text_size(sp(12.5))
                            .hover(|element| element.bg(theme.overlay))
                            .active(|element| element.bg(theme.overlay_strong))
                            .child(icon("icons/x.svg", 11.0, theme.text_tertiary))
                            .child(tr_cow!("project.no_project"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.create_projectless_session(cx);
                            }))
                            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                    this.create_projectless_session(cx);
                                    cx.stop_propagation();
                                }
                            })),
                    ),
            )
    }
}
