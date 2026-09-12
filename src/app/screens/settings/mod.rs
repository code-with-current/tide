//! The Settings screen: the shell that wires actions and mounts the
//! sidebar navigation and the routed page content.

pub(in crate::app) mod navigation;

pub(in crate::app) mod pages;

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, Window, div, px};

use crate::app::UsageViewMode;
use crate::app::layouts::settings::{
    SETTINGS_CONTENT_MAX_WIDTH, SETTINGS_MEMORY_MAX_WIDTH, SETTINGS_USAGE_MAX_WIDTH,
};
use crate::app::layouts::window;
use crate::app::{CloseWindow, SettingsPage, Tide};
use crate::theme::Theme;
use crate::ui::scrollbar;

impl Tide {
    pub(in crate::app) fn render_settings(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);

        div()
            .key_context("Tide")
            .track_focus(&self.settings_focus)
            .on_action(|_: &CloseWindow, window, _| crate::platform::hide_window(window))
            .on_action(cx.listener(Self::new_session_action))
            .on_action(cx.listener(Self::new_project_action))
            .on_action(cx.listener(Self::open_settings_action))
            .on_action(cx.listener(Self::toggle_sidebar_action))
            .on_action(cx.listener(Self::toggle_right_panel_action))
            .on_action(cx.listener(Self::toggle_command_palette_action))
            .on_action(cx.listener(Self::toggle_fps_counter_action))
            .on_action(cx.listener(Self::navigate_back_action))
            .on_action(cx.listener(Self::navigate_forward_action))
            .on_action(cx.listener(Self::focus_composer_action))
            .on_action(cx.listener(Self::cancel_turn_action))
            .capture_any_mouse_down(cx.listener(Self::navigation_mouse_down))
            .size_full()
            .flex()
            .bg(theme.canvas)
            .text_color(theme.text)
            .font_family(".SystemUIFont")
            .child(self.render_settings_sidebar(window, cx))
            .child(self.render_settings_content(window, cx))
            .into_any_element()
    }

    fn render_settings_content(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let page = self.settings_page.unwrap_or(SettingsPage::General);
        let right_window_controls =
            self.render_client_window_controls(window::WindowControlSide::Right, window, cx);
        // The Skills and Projects pages are mail-style splits that own the
        // whole content column — no titlebar strip, no width cap, no card.
        // Window dragging stays with the sidebar's own titlebar region.
        if page == SettingsPage::Skills || page == SettingsPage::Projects {
            return div()
                .flex_1()
                .h_full()
                .min_w_0()
                .flex()
                .flex_col()
                .border_l_1()
                .border_color(theme.sidebar_border)
                .bg(theme.surface)
                .children(right_window_controls.map(|controls| {
                    let label = if page == SettingsPage::Skills {
                        "settings-skills-titlebar"
                    } else {
                        "settings-projects-titlebar"
                    };
                    self.render_settings_drag_region(label, cx)
                        .flex()
                        .items_center()
                        .justify_end()
                        .child(controls)
                }))
                .child(div().flex_1().min_h_0().child(match page {
                    SettingsPage::Projects => self.render_projects_settings(cx),
                    _ => self.render_skills_settings(cx),
                }));
        }
        // Only the Projects ranking owns its own scrolling now; the Monthly
        // dashboard scrolls with the page like Daily, its statement card
        // capped internally.
        let fills_viewport =
            page == SettingsPage::Usage && self.usage.view == UsageViewMode::Projects;
        // The titlebar strip is transparent; once content slides under it, a
        // hairline marks the boundary so the clip edge reads as a header
        // rather than a glitch.
        let content_scrolled = !fills_viewport && self.settings_scroll.offset().y < px(-1.0);

        let inner = div()
            .w_full()
            .max_w(px(match page {
                SettingsPage::Usage => SETTINGS_USAGE_MAX_WIDTH,
                SettingsPage::Memory => SETTINGS_MEMORY_MAX_WIDTH,
                _ => SETTINGS_CONTENT_MAX_WIDTH,
            }))
            .mx_auto()
            .when(fills_viewport, |element| {
                element.h_full().min_h_0().flex().flex_col()
            })
            // No page heading: the sidebar already names the selected page
            // and every card carries its own title in its head.
            .child(match page {
                SettingsPage::General => self.render_general_settings(cx),
                SettingsPage::Tide => self
                    .render_tide_settings(Theme::current(cx), cx)
                    .into_any_element(),
                SettingsPage::Git => self
                    .render_git_settings(Theme::current(cx), cx)
                    .into_any_element(),
                SettingsPage::Memory => self.render_memory_settings(window, cx),
                SettingsPage::Projects => self.render_projects_settings(cx),
                SettingsPage::Skills => self.render_skills_settings(cx),
                SettingsPage::Usage => self.render_usage_settings(cx),
                SettingsPage::Daemon => self.render_daemon_settings(cx),
                SettingsPage::ComputerUse => self.render_computer_use_settings(cx),
                SettingsPage::Appearance => self.render_appearance_settings(cx),
            });

        div()
            .flex_1()
            .h_full()
            .min_w_0()
            .flex()
            .flex_col()
            .border_l_1()
            .border_color(theme.sidebar_border)
            .bg(theme.surface)
            .child(
                self.render_settings_drag_region("settings-content-titlebar", cx)
                    .flex()
                    .items_center()
                    .justify_end()
                    .children(right_window_controls)
                    .when(content_scrolled, |element| {
                        element.border_b_1().border_color(theme.border)
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(
                        div()
                            .id("settings-content-scroll")
                            .size_full()
                            .when(!fills_viewport, |element| {
                                element
                                    .overflow_y_scroll()
                                    .track_scroll(&self.settings_scroll)
                                    .pb(px(48.0))
                            })
                            .when(fills_viewport, |element| {
                                element.min_h_0().flex().flex_col()
                            })
                            .pt(px(12.0))
                            .px(px(32.0))
                            .child(inner),
                    )
                    .when(!fills_viewport, |element| {
                        element.child(scrollbar::vertical(
                            &self.settings_scroll,
                            &self.settings_scrollbar,
                        ))
                    }),
            )
    }
}
