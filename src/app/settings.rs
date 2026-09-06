use super::composer::next_picker_highlight;
use super::model_picker::{ModelPickerClear, ModelPickerConfig, ModelPickerSelect};
use super::*;
use crate::ui::card::{
    CardButton, CardRow, card_body, card_body_flush, card_pill, card_rows, settings_group_head,
    settings_page_header,
};

const SETTINGS_CONTENT_MAX_WIDTH: f32 = 760.0;

/// The Usage page is a dashboard, not a form; it mirrors T3 Code's wide
/// two-column layout and needs the extra room for the chart.
const SETTINGS_USAGE_MAX_WIDTH: f32 = 1024.0;

/// Key context the settings sidebar declares around its search field.
const SETTINGS_SIDEBAR_CONTEXT: &str = "SettingsSidebar";

/// The search field while focused inside the sidebar. The field holds real
/// focus the whole time — the sidebar's selection is only drawn — so `up` and
/// `down` have to be claimed from under it, and only a binding can do that:
/// they arrive as actions, which consume the keystroke before the field sees
/// it.
const SETTINGS_SEARCH_CONTEXT: &str = "SettingsSidebar > TextInput";

/// The sidebar's rows in display order, each with the keyword haystack the
/// search field filters against.
const SETTINGS_PAGES: [(SettingsPage, &str, &str, &str); 9] = [
    (
        SettingsPage::General,
        "settings.general",
        "icons/settings.svg",
        "settings.general_keywords",
    ),
    (
        SettingsPage::Appearance,
        "settings.appearance",
        "icons/appearance.svg",
        "settings.appearance_keywords",
    ),
    (
        SettingsPage::Git,
        "settings.git",
        "icons/git-branch.svg",
        "settings.git_keywords",
    ),
    (
        SettingsPage::Tide,
        "settings.tide",
        "icons/boxes.svg",
        "settings.tide_keywords",
    ),
    (
        SettingsPage::Knowledge,
        "settings.knowledge",
        "icons/library-big.svg",
        "settings.knowledge_keywords",
    ),
    (
        SettingsPage::Skills,
        "settings.skills",
        "icons/package.svg",
        "settings.skills_keywords",
    ),
    (
        SettingsPage::Usage,
        "settings.usage",
        "icons/chart-column.svg",
        "settings.usage_keywords",
    ),
    (
        SettingsPage::Daemon,
        "settings.remote",
        "icons/server.svg",
        "settings.remote_keywords",
    ),
    (
        SettingsPage::ComputerUse,
        "settings.computer_use",
        "icons/cursor-spark.svg",
        "settings.computer_use_keywords",
    ),
];

/// Bind the search field's list-navigation keys. Called once at startup.
pub fn init(cx: &mut App) {
    use gpui::KeyBinding;
    cx.bind_keys([
        KeyBinding::new("down", SelectNextEntry, Some(SETTINGS_SEARCH_CONTEXT)),
        KeyBinding::new("up", SelectPreviousEntry, Some(SETTINGS_SEARCH_CONTEXT)),
    ]);
}

/// The sidebar rows the query leaves visible, in display order. `query` must
/// already be trimmed and lowercased; when it is empty every page matches.
pub(super) fn visible_settings_pages(
    query: &str,
) -> impl Iterator<Item = (SettingsPage, String, &'static str)> + '_ {
    SETTINGS_PAGES
        .into_iter()
        .filter(|(page, ..)| page.is_visible_in_navigation())
        .filter_map(move |(page, label_key, icon, keywords_key)| {
            let label = crate::i18n::translate(label_key);
            let keywords = crate::i18n::translate(keywords_key).to_lowercase();
            (query.is_empty() || keywords.contains(query)).then_some((page, label, icon))
        })
}

impl Tide {
    pub(super) fn render_settings(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
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

    fn render_settings_sidebar(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let current_page = self.settings_page.unwrap_or(SettingsPage::General);
        let query = self.settings_search_query(cx);
        let mut navigation = div().flex().flex_col().gap(px(3.0));

        for (page, label, icon_path) in visible_settings_pages(&query) {
            let selected = current_page == page;
            navigation = navigation.child(
                div()
                    .id(SharedString::from(format!(
                        "settings-tab-{}",
                        label.to_lowercase()
                    )))
                    .h(px(36.0))
                    .px(px(11.0))
                    .rounded(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .cursor_default()
                    .text_size(sp(13.0))
                    .text_color(if selected {
                        theme.text
                    } else {
                        theme.text_secondary
                    })
                    .when(selected, |element| {
                        element.bg(theme.sidebar_item_background)
                    })
                    .hover(|element| element.bg(theme.sidebar_item_background))
                    .active(|element| element.bg(theme.sidebar_item_background))
                    .child(icon(
                        icon_path,
                        15.0,
                        if selected {
                            theme.text_secondary
                        } else {
                            theme.text_tertiary
                        },
                    ))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_settings_page(page, cx);
                    })),
            );
        }

        div()
            .key_context(SETTINGS_SIDEBAR_CONTEXT)
            .on_action(cx.listener(|this, _: &SelectNextEntry, _, cx| {
                this.cycle_settings_page("down", cx);
            }))
            .on_action(cx.listener(|this, _: &SelectPreviousEntry, _, cx| {
                this.cycle_settings_page("up", cx);
            }))
            .w(px(DEFAULT_SIDEBAR_WIDTH))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .bg(theme.sidebar)
            .child(self.render_settings_sidebar_titlebar(window, cx))
            .child(
                div().px(px(12.0)).child(
                    div()
                        .id("settings-back")
                        .h(px(34.0))
                        .px(px(9.0))
                        .rounded(px(8.0))
                        .flex()
                        .items_center()
                        .gap(px(9.0))
                        .cursor_default()
                        .text_size(sp(13.0))
                        .text_color(theme.text_secondary)
                        .hover(|element| element.bg(theme.overlay))
                        .active(|element| element.bg(theme.overlay_strong))
                        .child(icon("icons/arrow-left.svg", 15.0, theme.text_tertiary))
                        .child(tr!("settings.back"))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.settings_page = None;
                            let focus_handle = this.composer_focus(cx);
                            window.focus(&focus_handle, cx);
                            cx.notify();
                        })),
                ),
            )
            .child(
                div().px(px(12.0)).pt(px(8.0)).child(
                    TextField::new("settings-search-field", self.settings_search.clone())
                        .icon("icons/search.svg", 13.0),
                ),
            )
            .child(div().h(px(18.0)))
            .child(div().px(px(12.0)).child(navigation))
    }

    /// The search field's content, normalized the way the page filter expects.
    fn settings_search_query(&self, cx: &App) -> String {
        self.settings_search
            .read(cx)
            .content()
            .trim()
            .to_lowercase()
    }

    /// Step the selected page through the rows the search leaves visible,
    /// wrapping at both ends. The field keeps focus so typing keeps narrowing
    /// the list; the landing page renders immediately, so there is no separate
    /// confirm step. A selection filtered out by the query re-enters the list
    /// from whichever end matches the key.
    fn cycle_settings_page(&mut self, key: &str, cx: &mut Context<Self>) {
        let query = self.settings_search_query(cx);
        let pages = visible_settings_pages(&query)
            .map(|(page, ..)| page)
            .collect::<Vec<_>>();
        let current_page = self.settings_page.unwrap_or(SettingsPage::General);
        let current = pages.iter().position(|page| *page == current_page);
        let Some(next) = next_picker_highlight(current, pages.len(), key) else {
            return;
        };
        self.open_settings_page(pages[next], cx);
    }

    fn render_settings_sidebar_titlebar(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let left_window_controls = self.render_client_window_controls(
            super::window_chrome::WindowControlSide::Left,
            window,
            cx,
        );
        // Only as tall as whatever actually sits in it: macOS's native
        // traffic lights, or the client-side buttons a Linux desktop puts on
        // this side. Windows keeps all three on the far side, and a desktop
        // like GNOME keeps none here, so there is nothing to clear and the
        // strip is only somewhere to drag the window by — the content
        // column's own titlebar carries the rest of that job.
        let height = if cfg!(target_os = "macos") || left_window_controls.is_some() {
            48.0
        } else {
            12.0
        };

        div()
            .id("settings-sidebar-titlebar")
            .h(px(height))
            .flex_none()
            .flex()
            .items_center()
            .children(left_window_controls)
            .child(
                self.window_drag_region(
                    div()
                        .id("settings-sidebar-traffic-light-drag-region")
                        .w(px(TRAFFIC_LIGHT_CLEARANCE))
                        .h_full()
                        .flex_none(),
                    cx,
                ),
            )
            .child(
                self.render_settings_drag_region("settings-sidebar-titlebar-drag-region", cx)
                    .h(px(height))
                    .flex_1(),
            )
    }

    fn render_settings_content(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let page = self.settings_page.unwrap_or(SettingsPage::General);
        let right_window_controls = self.render_client_window_controls(
            super::window_chrome::WindowControlSide::Right,
            window,
            cx,
        );
        // The Skills page is a mail-style split that owns the whole content
        // column — no titlebar strip, no width cap, no card.
        // Window dragging stays with the sidebar's own titlebar region.
        if page == SettingsPage::Skills {
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
                    self.render_settings_drag_region("settings-skills-titlebar", cx)
                        .flex()
                        .items_center()
                        .justify_end()
                        .child(controls)
                }))
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .child(self.render_skills_settings(cx)),
                );
        }
        // The Monthly and Projects list views own their own scrolling, so
        // their pages fill the viewport instead of riding the shared scroll
        // container.
        let fills_viewport = page == SettingsPage::Usage
            && matches!(
                self.usage_view,
                UsageViewMode::Monthly | UsageViewMode::Projects
            );
        // The titlebar strip is transparent; once content slides under it, a
        // hairline marks the boundary so the clip edge reads as a header
        // rather than a glitch.
        let content_scrolled = !fills_viewport && self.settings_scroll.offset().y < px(-1.0);

        let inner = div()
            .w_full()
            .max_w(px(match page {
                SettingsPage::Usage => SETTINGS_USAGE_MAX_WIDTH,
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
                SettingsPage::Knowledge => self.render_knowledge_settings(cx),
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

    fn render_general_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let updater_available = cx
            .try_global::<crate::updater::UpdaterState>()
            .is_some_and(|updater| updater.0.is_some());
        let analytics_enabled = self.state.analytics_enabled;
        let analytics_toggle = toggle_switch(
            "anonymous-analytics-toggle",
            analytics_enabled,
            false,
            theme,
            cx,
            move |this, _, cx| this.set_analytics_enabled(!analytics_enabled, cx),
        );
        let mut privacy_rows = vec![
            CardRow::new(tr!("settings.share_anonymous_usage_data"))
                .description(tr!("settings.share_anonymous_usage_data_description"))
                .control(analytics_toggle),
        ];
        if updater_available {
            let enabled = self.automatic_updates_enabled;
            let toggle = toggle_switch(
                "automatic-updates-toggle",
                enabled,
                false,
                theme,
                cx,
                move |this, _, cx| this.set_automatic_updates_enabled(!enabled, cx),
            );
            privacy_rows.push(
                CardRow::new(tr!("settings.automatic_updates"))
                    .description(tr!("settings.automatic_updates_description"))
                    .control(toggle),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap(px(26.0))
            .child(settings_page_header(
                &theme,
                tr!("settings.general"),
                Some(SharedString::from(tr!("settings.general_description"))),
                None,
            ))
            // The "local by default" note is a banner, not a control group —
            // the one headerless surface in settings.
            .child(
                div()
                    .bg(theme.raised)
                    .rounded(px(13.0))
                    .px(px(20.0))
                    .py(px(14.0))
                    .child(
                        div()
                            .text_size(sp(13.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(tr!("settings.local_by_default")),
                    )
                    .child(
                        div()
                            .mt(px(5.0))
                            .text_size(sp(12.5))
                            .line_height(sp(18.0))
                            .text_color(theme.text_secondary)
                            .child(tr!("settings.local_by_default_description")),
                    ),
            )
            .child(
                div()
                    .child(settings_group_head(
                        &theme,
                        tr!("settings.usage_privacy"),
                        Vec::new(),
                    ))
                    .child(card_body(&theme).child(card_rows(&theme, privacy_rows))),
            )
            .child(self.render_background_tasks_card(&theme, cx))
            .into_any_element()
    }

    /// The Knowledge page: per-project Memory & RAG plus the knowledge
    /// sources registry (upstream's Settings → Knowledge).
    fn render_knowledge_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        div()
            .flex()
            .flex_col()
            .gap(px(26.0))
            .child(settings_page_header(
                &theme,
                tr!("settings.knowledge"),
                Some(SharedString::from(tr!("settings.knowledge_description"))),
                Some(self.rag_sources_add_button(theme, cx)),
            ))
            .child(self.render_memory_rag_card(&theme, cx))
            .child(self.render_sources_card(&theme, cx))
            .into_any_element()
    }

    /// The "Background Tasks" group on the General page: the two model
    /// overrides background work (session titles, commit messages) uses when
    /// the user has pinned one, defaulting to the session's model.
    fn render_background_tasks_card(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let title_model = self
            .git_settings
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.background_title_model.clone());
        let commit_model = self
            .git_settings
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.background_commit_model.clone());
        let title_selector = self.render_background_model_selector(
            "background-title-model",
            "title",
            title_model.as_ref(),
            cx,
        );
        let commit_selector = self.render_background_model_selector(
            "background-commit-model",
            "commit-message",
            commit_model.as_ref(),
            cx,
        );
        div()
            .child(settings_group_head(
                &theme,
                tr!("settings.background.title"),
                Vec::new(),
            ))
            .child(card_body(theme).child(card_rows(
                theme,
                vec![
                    CardRow::new(tr!("settings.background.title_model"))
                        .description(tr!("settings.background.title_model_description"))
                        .control(title_selector),
                    CardRow::new(tr!("settings.background.commit_model"))
                        .description(tr!("settings.background.commit_model_description"))
                        .control(commit_selector),
                ],
            )))
    }

    /// One background-task model picker: the shared model picker popover
    /// bound to the stored override. The override resolves to tide providers
    /// only; the trigger shows the override as "Provider · Model" — or the
    /// default when unset — and the panel's reset entry clears it back to the
    /// session's model.
    fn render_background_model_selector(
        &self,
        id: &'static str,
        task: &'static str,
        current: Option<&protocol::git_settings::ModelRefWire>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // The picker identifies a row by provider kind plus the full model id
        // (tide ids carry their "provider/model" prefix); the stored override
        // splits the two apart, so map it back.
        let active = current.and_then(|r| {
            self.tide
                .providers
                .iter()
                .any(|provider| provider.id == r.provider_id)
                .then(|| {
                    (
                        ProviderKind::Tide,
                        format!("{}/{}", r.provider_id, r.model_id),
                    )
                })
        });
        // The trigger names the override with display names where they are
        // known; a stored ref whose provider vanished still shows raw ids
        // rather than lying with "default".
        let trigger_label = match current {
            Some(reference) => self.background_model_label(reference),
            None => tr!("settings.background.session_model"),
        };
        let config = ModelPickerConfig {
            active: active.clone(),
            refocus_composer_on_close: false,
        };
        let on_select: ModelPickerSelect = Rc::new(move |this, _kind, model, cx| {
            // Tide rows carry "provider/model"; the stored ref wants the two
            // halves separately.
            let Some((provider_id, model_id)) = model.split_once('/') else {
                return;
            };
            this.git_set_background_model(
                task,
                Some(provider_id.to_owned()),
                Some(model_id.to_owned()),
                cx,
            );
        });
        let clear: ModelPickerClear = Rc::new(move |this, cx| {
            this.git_set_background_model(task, None, None, cx);
        });
        self.render_model_picker(
            SharedString::from(format!("{id}-picker")),
            config,
            Some((
                SharedString::from(tr!("settings.background.use_session_model")),
                clear,
            )),
            on_select,
            MenuAlign::BelowRight,
            move |open| {
                MenuChip::new(format!("{id}-selector"))
                    .label(trigger_label.clone())
                    .outlined()
                    .selected(open)
                    .w(px(210.0))
                    .justify_between()
            },
            cx,
        )
    }

    /// "Provider · Model" for a stored background-model override, using the
    /// tide catalog's display names where they resolve and the raw ids
    /// otherwise.
    fn background_model_label(&self, reference: &protocol::git_settings::ModelRefWire) -> String {
        let tide_full = format!("{}/{}", reference.provider_id, reference.model_id);
        if let Some(model) = self.tide_models.iter().find(|model| model.id == tide_full) {
            let provider_label = model
                .sub_provider
                .clone()
                .unwrap_or_else(|| reference.provider_id.clone());
            return format!("{provider_label} · {}", model.name);
        }
        format!("{} · {}", reference.provider_id, reference.model_id)
    }

    fn set_analytics_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.state.analytics_enabled = enabled;
        self.analytics.set_enabled(enabled);
        self.save();
        cx.notify();
    }

    fn set_automatic_updates_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.automatic_updates_enabled = enabled;
        if let Some(updater) = cx
            .try_global::<crate::updater::UpdaterState>()
            .and_then(|updater| updater.0.as_ref())
        {
            updater.set_automatically_checks_for_updates(enabled);
        }
        cx.notify();
    }

    fn render_daemon_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        if self.daemon.is_remote() {
            return div()
                .mt(px(15.0))
                .w_full()
                .px(px(20.0))
                .py(px(16.0))
                .rounded(px(13.0))
                .bg(theme.raised)
                .child(
                    div()
                        .text_size(sp(13.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text)
                        .child(tr!("daemon.external_title")),
                )
                .child(
                    div()
                        .mt(px(5.0))
                        .text_size(sp(12.5))
                        .line_height(sp(18.0))
                        .text_color(theme.text_secondary)
                        .child(tr!("daemon.external_description")),
                )
                .into_any_element();
        }

        div()
            .flex()
            .flex_col()
            .gap(px(26.0))
            .child(settings_page_header(
                &theme,
                tr!("settings.remote"),
                Some(SharedString::from(tr!("settings.remote_description"))),
                None,
            ))
            .child(self.render_remote_section(&theme, cx))
            .into_any_element()
    }

    pub(super) fn set_daemon_exposure_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        let mut settings = self.state.daemon_exposure.clone();
        settings.enabled = enabled;
        if enabled {
            // A fresh link on every enable: a new relay path AND a new
            // bearer token invalidate every previous link by design.
            settings.relay_path = Some(crate::remote_relay::generate_path());
            settings.token = client::DaemonExposureSettings::new_token();
            // The scanned phone reaches the daemon by the machine's LAN name
            // in direct mode, so that origin stays allowed.
            if let Some(host) = crate::daemon::local_hostname() {
                let lan_origin = format!("http://{host}:3001");
                if !settings
                    .allowed_origins
                    .iter()
                    .any(|origin| origin.eq_ignore_ascii_case(&lan_origin))
                {
                    settings.allowed_origins.push(lan_origin);
                }
            }
        }
        self.apply_daemon_exposure(settings, cx);
    }

    fn apply_daemon_exposure(
        &mut self,
        settings: client::DaemonExposureSettings,
        cx: &mut Context<Self>,
    ) {
        if self.daemon_reconfigure_pending || settings == self.state.daemon_exposure {
            return;
        }
        if self.daemon.is_remote() {
            self.show_toast(tr!("daemon.external_description"));
            return;
        }
        if self
            .state
            .sessions
            .iter()
            .any(|session| !matches!(session.status, SessionStatus::Idle | SessionStatus::Failed))
        {
            self.show_toast(tr!("daemon.stop_active_tasks"));
            return;
        }

        let needs_restart = self.state.daemon_exposure.enabled || settings.enabled;
        if !needs_restart {
            self.state.daemon_exposure = settings;
            self.save();
            cx.notify();
            return;
        }

        self.daemon_reconfigure_pending = true;
        let daemon = self.daemon.clone();
        let applied = settings.clone();
        let restart = cx
            .background_executor()
            .spawn(async move { daemon.reconfigure(settings) });
        cx.spawn(async move |this, cx| {
            let result = restart.await;
            let _ = this.update(cx, |this, cx| {
                this.daemon_reconfigure_pending = false;
                match result {
                    Ok(()) => {
                        this.state.daemon_exposure = applied.clone();
                        // Keep the Remote Control relay in step with the
                        // exposure policy wherever it was changed.
                        if applied.enabled {
                            let relay_path = applied
                                .relay_path
                                .clone()
                                .unwrap_or_else(crate::remote_relay::generate_path);
                            if applied.relay_path.is_none() {
                                this.state.daemon_exposure.relay_path = Some(relay_path.clone());
                            }
                            crate::remote_relay::start(
                                crate::remote_relay::RelayConfig {
                                    path: relay_path,
                                    secret: applied.token.clone(),
                                    local_port: applied.port,
                                },
                                None,
                            );
                        } else {
                            crate::remote_relay::stop();
                        }
                        this.runtimes.clear();
                        this.save();
                        this.show_success_toast(tr!("daemon.settings_applied"));
                    }
                    Err(error) => {
                        this.show_toast(tr!("daemon.restart_failed", error = error.to_string()))
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn render_appearance_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let selected_theme = self.state.theme;
        let selected_language = self.state.language;
        let weak = cx.entity().downgrade();
        let theme_handle = self.menu_handle("theme-selector", cx);
        let theme_selector = dropdown_menu(
            MenuChip::new("theme-selector")
                .label(selected_theme.label())
                .outlined()
                .selected(theme_handle.is_open())
                .w(px(116.0))
                .justify_between(),
            "theme-selector-menu",
            &theme_handle,
            MenuAlign::BelowRight,
            move |_| {
                ThemePreference::ALL
                    .into_iter()
                    .map(|preference| {
                        let weak = weak.clone();
                        MenuItem::new(preference.label(), move |window, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.set_theme_preference(preference, window, cx);
                            });
                        })
                        .selected(preference == selected_theme)
                    })
                    .collect()
            },
        );

        let selected_ui_font_size = self.state.ui_font_size;
        let weak = cx.entity().downgrade();
        let ui_font_size_handle = self.menu_handle("ui-font-size-selector", cx);
        let ui_font_size_selector = dropdown_menu(
            MenuChip::new("ui-font-size-selector")
                .label(font_size_label(selected_ui_font_size))
                .outlined()
                .selected(ui_font_size_handle.is_open())
                .w(px(116.0))
                .justify_between(),
            "ui-font-size-selector-menu",
            &ui_font_size_handle,
            MenuAlign::BelowRight,
            move |_| {
                FONT_SIZES
                    .into_iter()
                    .map(|size| {
                        let weak = weak.clone();
                        MenuItem::new(font_size_label(size), move |window, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.set_ui_font_size(size, window, cx);
                            });
                        })
                        .selected(size == selected_ui_font_size)
                    })
                    .collect()
            },
        );

        let selected_code_font_size = self.state.code_font_size;
        let weak = cx.entity().downgrade();
        let code_font_size_handle = self.menu_handle("code-font-size-selector", cx);
        let code_font_size_selector = dropdown_menu(
            MenuChip::new("code-font-size-selector")
                .label(font_size_label(selected_code_font_size))
                .outlined()
                .selected(code_font_size_handle.is_open())
                .w(px(116.0))
                .justify_between(),
            "code-font-size-selector-menu",
            &code_font_size_handle,
            MenuAlign::BelowRight,
            move |_| {
                FONT_SIZES
                    .into_iter()
                    .map(|size| {
                        let weak = weak.clone();
                        MenuItem::new(font_size_label(size), move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.set_code_font_size(size, cx);
                            });
                        })
                        .selected(size == selected_code_font_size)
                    })
                    .collect()
            },
        );

        let weak = cx.entity().downgrade();
        let language_handle = self.menu_handle("language-selector", cx);
        let language_selector = dropdown_menu(
            MenuChip::new("language-selector")
                .label(selected_language.label())
                .outlined()
                .selected(language_handle.is_open())
                .w(px(116.0))
                .justify_between(),
            "language-selector-menu",
            &language_handle,
            MenuAlign::BelowRight,
            move |_| {
                crate::i18n::AppLanguage::ALL
                    .into_iter()
                    .map(|language| {
                        let weak = weak.clone();
                        MenuItem::new(language.label(), move |window, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.set_language(language, window, cx);
                            });
                        })
                        .selected(language == selected_language)
                    })
                    .collect()
            },
        );

        div()
            .child(settings_page_header(
                &theme,
                tr!("settings.appearance"),
                None,
                None,
            ))
            .child(card_body(&theme).child(card_rows(
                &theme,
                vec![
                    CardRow::new(tr!("settings.theme"))
                        .description(tr!("settings.theme_description"))
                        .control(theme_selector),
                    CardRow::new(tr!("language.title"))
                        .description(tr!("language.description"))
                        .control(language_selector),
                    CardRow::new(tr!("settings.ui_font_size"))
                        .description(tr!("settings.ui_font_size_description"))
                        .control(ui_font_size_selector),
                    CardRow::new(tr!("settings.code_font_size"))
                        .description(tr!("settings.code_font_size_description"))
                        .control(code_font_size_selector),
                ],
            )))
            .into_any_element()
    }
    fn set_ui_font_size(&mut self, size: f32, window: &mut Window, cx: &mut Context<Self>) {
        let size = client::persistence::sanitized_ui_font_size(size);
        if self.state.ui_font_size == size {
            return;
        }
        self.state.ui_font_size = size;
        // Chrome is authored in `sp` rems; the rem size is the setting.
        window.set_rem_size(px(size));
        self.remeasure_font_sized_surfaces();
        self.save();
        window.refresh();
        cx.notify();
    }

    fn set_code_font_size(&mut self, size: f32, cx: &mut Context<Self>) {
        let size = client::persistence::sanitized_code_font_size(size);
        if self.state.code_font_size == size {
            return;
        }
        self.state.code_font_size = size;
        self.remeasure_font_sized_surfaces();
        self.save();
        cx.notify();
    }

    /// Drop every cached row height that a font size participates in. The
    /// virtualized lists remember measured heights, so a stale entry would
    /// misplace scroll anchors until the row happened to remeasure. The
    /// sidebar list keeps its uniform row height and needs no reset.
    fn remeasure_font_sized_surfaces(&self) {
        self.reset_transcript_rows(self.transcript_row_count());
        let diff_line_count = self
            .git_panel
            .selected_file_diff
            .as_ref()
            .and_then(|selected| selected.snapshot.as_ref())
            .or(self
                .git_panel
                .last_turn_review
                .as_ref()
                .and_then(|review| review.snapshot.as_ref()))
            .map_or(0, |snapshot| snapshot.lines.len());
        self.git_panel_diff_list_state.reset(diff_line_count);
        self.skills_list_state
            .reset(self.skills_rows.borrow().len());
    }

    fn render_computer_use_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let enabled = self.state.computer_use_enabled;
        let permissions = self.computer_permissions.clone();
        let pending = self.computer_permission_request_pending;
        let helper_name = crate::computer_use::helper_display_name();
        let mut allowed_apps = div().flex().flex_col();
        if self.state.computer_use_allowed_apps.is_empty() {
            allowed_apps = allowed_apps.child(
                div()
                    .py(px(12.0))
                    .px(px(20.0))
                    .text_size(sp(12.5))
                    .text_color(theme.text_tertiary)
                    .child(tr!("computer_use.no_always_allowed_apps")),
            );
        } else {
            for (index, grant) in self.state.computer_use_allowed_apps.iter().enumerate() {
                let key = grant.key();
                let is_last = index + 1 == self.state.computer_use_allowed_apps.len();
                let app_icon = self.computer_use_app_icon(&grant.bundle_id, cx);
                allowed_apps = allowed_apps.child(
                    div()
                        .px(px(20.0))
                        .py(px(9.0))
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .when(!is_last, |element| {
                            element.border_b_1().border_color(theme.border)
                        })
                        .child(
                            div()
                                .w(px(32.0))
                                .h(px(32.0))
                                .flex_none()
                                .rounded(px(7.0))
                                .when_some(app_icon, |element, app_icon| {
                                    element.child(img(app_icon).size_full().rounded(px(7.0)))
                                }),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(
                                    div()
                                        .text_size(sp(12.5))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.text)
                                        .child(SharedString::from(grant.app_name.clone())),
                                )
                                .child(
                                    div()
                                        .mt(px(2.0))
                                        .text_size(sp(12.5))
                                        .text_color(theme.text_tertiary)
                                        .truncate()
                                        .child(SharedString::from(grant.bundle_id.clone())),
                                ),
                        )
                        .child(
                            div()
                                .id(SharedString::from(format!("revoke-computer-app-{key}")))
                                .h(px(25.0))
                                .px(px(9.0))
                                .rounded(px(6.0))
                                .border_1()
                                .border_color(theme.border_strong)
                                .flex()
                                .items_center()
                                .cursor_default()
                                .text_size(sp(12.5))
                                .text_color(theme.text_secondary)
                                .hover(|element| element.bg(theme.overlay).text_color(theme.danger))
                                .child(tr!("common.revoke"))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.revoke_computer_app(&key, cx);
                                })),
                        ),
                );
            }
        }

        let recheck = CardButton::new(
            "recheck-computer-permissions",
            if pending {
                tr!("common.checking")
            } else {
                tr!("common.recheck")
            },
        )
        .busy(pending)
        .render(theme, cx, |this, _window, cx| {
            this.request_computer_permissions(false, cx);
        });

        let allow_toggle = toggle_switch(
            "computer-use-enabled",
            enabled,
            false,
            theme,
            cx,
            move |this, _, cx| this.set_computer_use_enabled(!enabled, cx),
        );

        let mut access_actions: Vec<gpui::AnyElement> = Vec::new();
        access_actions.push(recheck.into_any_element());

        div()
            .flex()
            .flex_col()
            .gap(px(26.0))
            .child(settings_page_header(
                &theme,
                tr!("settings.computer_use"),
                Some(SharedString::from(tr!("computer_use.availability"))),
                None,
            ))
            .child(
                div()
                    .child(settings_group_head(
                        &theme,
                        tr!("computer_use.allow_apps"),
                        Vec::new(),
                    ))
                    .child(card_body(&theme).child(card_rows(
                        &theme,
                        vec![
                            CardRow::new(tr!("computer_use.enabled_toggle")).control(allow_toggle),
                        ],
                    ))),
            )
            .child(
                div()
                    .child(settings_group_head(
                        &theme,
                        tr!("computer_use.macos_access"),
                        access_actions,
                    ))
                    .child(
                        card_body(&theme)
                            .child(
                                div()
                                    .pb(px(8.0))
                                    .text_size(sp(12.0))
                                    .text_color(theme.text_tertiary)
                                    .child(SharedString::from(tr!(
                                        "computer_use.helper_access",
                                        helper = helper_name
                                    ))),
                            )
                            .child(permission_status_row(
                                tr!("computer_use.screen_recording"),
                                tr!("computer_use.screen_recording_description"),
                                permissions.screen_recording,
                                "screen-recording-settings",
                                theme,
                                cx,
                            ))
                            .child(permission_status_row(
                                tr!("computer_use.accessibility"),
                                tr!("computer_use.accessibility_description"),
                                permissions.accessibility,
                                "accessibility-settings",
                                theme,
                                cx,
                            )),
                    ),
            )
            .child(
                div()
                    .child(settings_group_head(
                        &theme,
                        tr!("computer_use.always_allowed_apps"),
                        Vec::new(),
                    ))
                    .child(
                        card_body_flush(&theme)
                            .child(
                                div()
                                    .px(px(20.0))
                                    .py(px(10.0))
                                    .text_size(sp(12.0))
                                    .text_color(theme.text_tertiary)
                                    .child(tr!("computer_use.always_allowed_apps_description")),
                            )
                            .child(allowed_apps),
                    ),
            )
            .into_any_element()
    }
    fn set_computer_use_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.state.computer_use_enabled = enabled;
        self.save();
        if enabled {
            self.request_computer_permissions(true, cx);
        }
        cx.notify();
    }

    pub(super) fn request_computer_permissions(&mut self, prompt: bool, cx: &mut Context<Self>) {
        if self.computer_permission_request_pending {
            return;
        }
        self.computer_permission_request_pending = true;
        let tx = self.computer_permission_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let daemon = self.daemon.client();
        std::thread::Builder::new()
            .name("tide-computer-permission-request".into())
            .spawn(move || {
                let result = match daemon.request(
                    Uuid::nil(),
                    Uuid::nil(),
                    client::Command::ProbeComputerPermissions { prompt },
                ) {
                    Ok(client::ResponsePayload::ComputerPermissions { permissions }) => {
                        Ok(permissions)
                    }
                    Ok(_) => Err("the daemon returned an invalid permission response".into()),
                    Err(error) => Err(error.to_string()),
                };
                if tx.send(result).is_ok() {
                    signal_event_pump(&event_wake);
                }
            })
            .ok();
        cx.notify();
    }

    fn revoke_computer_app(&mut self, key: &str, cx: &mut Context<Self>) {
        self.state
            .computer_use_allowed_apps
            .retain(|grant| grant.key() != key);
        self.save();
        cx.notify();
    }

    fn computer_use_app_icon(
        &self,
        bundle_id: &str,
        cx: &mut Context<Self>,
    ) -> Option<std::sync::Arc<gpui::Image>> {
        if let Some(icon) = self.computer_use_app_icons.borrow().get(bundle_id) {
            return icon.clone();
        }

        let bundle_id = bundle_id.to_owned();
        if self
            .computer_use_app_icon_loads
            .borrow_mut()
            .insert(bundle_id.clone())
        {
            cx.spawn(async move |this, cx| {
                let load_bundle_id = bundle_id.clone();
                let icon =
                    cx.background_executor()
                        .spawn(async move {
                            crate::platform::load_app_icon_for_bundle_id(&load_bundle_id)
                        })
                        .await;
                let _ = this.update(cx, |this, cx| {
                    this.computer_use_app_icon_loads
                        .borrow_mut()
                        .remove(&bundle_id);
                    this.computer_use_app_icons
                        .borrow_mut()
                        .insert(bundle_id, icon);
                    cx.notify();
                });
            })
            .detach();
        }
        None
    }

    fn render_settings_drag_region(
        &self,
        id: &'static str,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let region = div().id(id);
        // Windows drags from the hit test rather than a mouse-move handler.
        #[cfg(target_os = "windows")]
        let region = region.window_control_area(gpui::WindowControlArea::Drag);

        region
            .h(px(48.0))
            .flex_none()
            .on_click(|event, window, _| {
                if event.click_count() == 2 {
                    crate::platform::titlebar_double_click(window);
                }
            })
            .on_mouse_down_out(cx.listener(|this, _, _, _| {
                this.header_drag_armed = false;
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, _| {
                    this.header_drag_armed = true;
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| {
                    this.header_drag_armed = false;
                }),
            )
            .on_mouse_move(cx.listener(|this, _, window, _| {
                if this.header_drag_armed {
                    this.header_drag_armed = false;
                    crate::platform::start_window_move(window);
                }
            }))
    }

    fn set_theme_preference(
        &mut self,
        preference: ThemePreference,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.state.theme == preference {
            return;
        }
        self.state.theme = preference;
        crate::theme::apply_theme_preference(preference, window, cx);
        self.save();
        cx.notify();
    }

    fn set_language(
        &mut self,
        language: crate::i18n::AppLanguage,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.state.language == language {
            return;
        }

        self.state.language = language;
        crate::i18n::set_language(language);

        self.composer.update(cx, |input, cx| {
            input.set_placeholder(tr!("input.do_anything"), cx)
        });
        self.model_search.update(cx, |input, cx| {
            input.set_placeholder(tr!("input.search_models"), cx)
        });
        self.branch_search.update(cx, |input, cx| {
            input.set_placeholder(tr!("input.search_branches"), cx)
        });
        self.branch_create_input.update(cx, |input, cx| {
            input.set_placeholder(tr!("input.new_branch_name"), cx)
        });
        self.settings_search.update(cx, |input, cx| {
            input.set_placeholder(tr!("settings.search"), cx)
        });
        self.skills_search.update(cx, |input, cx| {
            input.set_placeholder(tr!("skills.search"), cx)
        });
        self.usage_project_filter.update(cx, |input, cx| {
            input.set_placeholder(tr!("input.filter_projects"), cx)
        });
        self.refresh_command_palette_localized_text(cx);
        self.refresh_file_search_localized_text(cx);
        self.refresh_transcript_search_localized_text(cx);
        for browser in self.right_panel_browsers.values() {
            browser.update(cx, |browser, cx| browser.refresh_localized_text(cx));
        }
        for terminal in self.right_panel_terminals.values() {
            terminal.update(cx, |terminal, cx| terminal.refresh_localized_text(cx));
        }
        self.invalidate_composer_sources(cx);

        let updater_available = cx
            .try_global::<crate::updater::UpdaterState>()
            .and_then(|updater| updater.0.as_ref())
            .is_some();
        crate::set_app_menus(cx, updater_available);
        self.save();
        window.refresh();
        cx.notify();
    }
}

/// Sizes offered by the font-size dropdowns. A hand-edited `app.json` may
/// hold values outside this list; they render as-is and simply select
/// nothing here.
const FONT_SIZES: [f32; 8] = [11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 18.0, 20.0];

fn font_size_label(size: f32) -> String {
    if size.fract() == 0.0 {
        format!("{size:.0} px")
    } else {
        format!("{size} px")
    }
}

fn permission_status_row(
    name: String,
    description: String,
    granted: bool,
    id: &'static str,
    theme: Theme,
    cx: &mut Context<Tide>,
) -> Div {
    let status = if granted {
        div()
            .id(id)
            .h(px(25.0))
            .px(px(4.0))
            .rounded(px(6.0))
            .flex()
            .items_center()
            .gap(px(5.0))
            .cursor_default()
            .text_size(sp(12.5))
            .text_color(theme.success)
            .child(icon("icons/check.svg", 12.0, theme.success))
            .child(tr!("computer_use.access_granted"))
    } else {
        div()
            .id(id)
            .h(px(25.0))
            .px(px(9.0))
            .rounded(px(6.0))
            .border_1()
            .border_color(theme.border_strong)
            .flex()
            .items_center()
            .cursor_default()
            .text_size(sp(12.5))
            .text_color(theme.text_secondary)
            .hover(|element| element.bg(theme.overlay).text_color(theme.text))
            .child(tr!("computer_use.grant_access"))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.request_computer_permissions(true, cx);
            }))
    };

    div()
        .mt(px(10.0))
        .pt(px(10.0))
        .border_t_1()
        .border_color(theme.border)
        .flex()
        .items_center()
        .gap(px(10.0))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .text_size(sp(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text)
                        .child(name),
                )
                .child(
                    div()
                        .mt(px(2.0))
                        .text_size(sp(12.5))
                        .text_color(theme.text_tertiary)
                        .child(description),
                ),
        )
        .child(status)
}

// ── Git settings page ────────────────────────────────────────────────
//
// Port of tide's Git settings screen (accounts, identities, attribution,
// per-project identity state). State lives in `git_settings.rs`; the page
// renderers land in tasks 14-16 and extend this shell.

impl Tide {
    fn render_git_settings(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        // Loading state; &self rendering must stay pure — the snapshot load
        // is requested from the page-switch action.
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .p(px(6.0))
            .child(settings_page_header(
                &theme,
                tr!("settings.git"),
                Some(SharedString::from(tr!("git.caption"))),
                None,
            ))
            .when(!self.git_settings.loaded, |element| {
                element.child(
                    div()
                        .p(px(24.0))
                        .text_size(sp(13.0))
                        .text_color(theme.text_tertiary)
                        .child(tr!("git.loading")),
                )
            });
        if let Some(snapshot) = self.git_settings.snapshot.clone() {
            body = body
                .child(self.render_git_github_card(&snapshot, theme, cx))
                .child(self.render_git_identities_card(&snapshot, theme, cx))
                .child(self.render_git_attribution_card(&snapshot, theme, cx))
                .child(self.render_git_projects_card(&snapshot, theme, cx));
        }
        if let Some(error) = self.git_settings.error.clone() {
            body = body.child(
                div()
                    .text_size(sp(12.0))
                    .text_color(theme.danger)
                    .child(error),
            );
        }
        body
    }

    /// The GitHub group (git.tsx:708-806): connected accounts, gh-CLI-
    /// detected accounts, the empty state, and the browser-connect footer.
    fn render_git_github_card(
        &self,
        snapshot: &protocol::git_settings::GitSnapshotWire,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let connected = &snapshot.accounts;
        let detected: Vec<_> = snapshot
            .gh_cli
            .accounts
            .iter()
            .filter(|account| {
                !connected
                    .iter()
                    .any(|connected| connected.login == account.login)
            })
            .collect();

        let head = settings_group_head(
            &theme,
            tr!("git.github.title"),
            vec![
                div()
                    .truncate()
                    .text_size(sp(11.0))
                    .text_color(theme.text_tertiary)
                    .child(tr!("git.github.caption"))
                    .into_any_element(),
            ],
        );
        let mut body = card_body_flush(&theme);

        for (account_index, account) in connected.iter().enumerate() {
            let login = account.login.clone();
            let armed = self.git_settings.confirm_disconnect.as_deref() == Some(&account.login);
            let disconnect_label = if armed {
                tr!("common.confirm")
            } else {
                tr!("git.github.disconnect")
            };
            body = body.child(
                div()
                    .px(px(20.0))
                    .py(px(9.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .when(account_index > 0, |row| {
                        row.border_t_1().border_color(theme.border)
                    })
                    .child(
                        div()
                            .size(px(28.0))
                            .flex_none()
                            .rounded(px(7.0))
                            .bg(theme.overlay)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("icons/github.svg", 14.0, theme.text_secondary)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_size(sp(13.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text)
                                    .child(SharedString::from(format!("@{}", account.login))),
                            )
                            .when_some(account.account_id.clone(), |row, account_id| {
                                row.child(
                                    div()
                                        .mt(px(2.0))
                                        .truncate()
                                        .font_family(".SystemUIFontMonospaced")
                                        .text_size(sp(10.5))
                                        .text_color(theme.text_ghost)
                                        .child(account_id),
                                )
                            }),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!(
                                "git-github-disconnect-{}",
                                account.login
                            )))
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.danger))
                            .h(px(24.0))
                            .px(px(8.0))
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(if armed {
                                theme.danger
                            } else {
                                theme.border_strong
                            })
                            .when(armed, |element| element.bg(theme.danger.opacity(0.12)))
                            .flex()
                            .flex_none()
                            .items_center()
                            .cursor_default()
                            .text_size(sp(11.5))
                            .text_color(if armed {
                                theme.danger
                            } else {
                                theme.text_secondary
                            })
                            .hover(|element| element.text_color(theme.danger))
                            .child(disconnect_label)
                            .on_click(cx.listener({
                                let login = login.clone();
                                move |this, _, _, cx| {
                                    if this.git_settings.confirm_disconnect.as_deref()
                                        == Some(&login)
                                    {
                                        this.git_disconnect_account(login.clone());
                                    } else {
                                        this.git_settings.confirm_disconnect = Some(login.clone());
                                    }
                                    cx.notify();
                                }
                            }))
                            .on_key_down(cx.listener({
                                let login = login.clone();
                                move |this, event: &KeyDownEvent, _, cx| {
                                    if !event.keystroke.modifiers.modified()
                                        && matches!(event.keystroke.key.as_str(), "enter" | "space")
                                    {
                                        if this.git_settings.confirm_disconnect.as_deref()
                                            == Some(&login)
                                        {
                                            this.git_disconnect_account(login.clone());
                                        } else {
                                            this.git_settings.confirm_disconnect =
                                                Some(login.clone());
                                        }
                                        cx.stop_propagation();
                                        cx.notify();
                                    }
                                }
                            }))
                            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                                if this.git_settings.confirm_disconnect.take().is_some() {
                                    cx.notify();
                                }
                            })),
                    ),
            );
        }

        for (detected_index, account) in detected.iter().enumerate() {
            let login = account.login.clone();
            let connecting =
                self.git_settings.gh_connecting.as_deref() == Some(account.login.as_str());
            let any_connecting = self.git_settings.gh_connecting.is_some();
            body = body.child(
                div()
                    .px(px(20.0))
                    .py(px(9.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .when(detected_index > 0 || !connected.is_empty(), |row| {
                        row.border_t_1().border_color(theme.border)
                    })
                    .child(
                        div()
                            .size(px(28.0))
                            .flex_none()
                            .rounded(px(7.0))
                            .bg(theme.overlay)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("icons/terminal-square.svg", 14.0, theme.text_tertiary)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(sp(13.0))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text)
                                            .child(SharedString::from(format!(
                                                "@{}",
                                                account.login
                                            ))),
                                    )
                                    .when(account.active, |row| {
                                        row.child(crate::ui::badge::badge("active", theme))
                                    }),
                            )
                            .child(
                                div()
                                    .mt(px(2.0))
                                    .text_size(sp(11.0))
                                    .text_color(theme.text_ghost)
                                    .child(tr!("git.github.gh_detected")),
                            ),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!(
                                "git-github-connect-{}",
                                account.login
                            )))
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.accent))
                            .h(px(24.0))
                            .px(px(9.0))
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .when(any_connecting, |element| element.opacity(0.55))
                            .flex()
                            .flex_none()
                            .items_center()
                            .gap(px(5.0))
                            .cursor_default()
                            .text_size(sp(11.5))
                            .text_color(theme.text_secondary)
                            .hover(|element| element.bg(theme.overlay))
                            .when(connecting, |element| {
                                element.child(motion::spin(icon(
                                    "icons/loader-circle.svg",
                                    11.0,
                                    theme.text_tertiary,
                                )))
                            })
                            .when(!connecting, |element| {
                                element.child(icon("icons/check.svg", 11.0, theme.text_tertiary))
                            })
                            .child(tr!("git.github.connect"))
                            .on_activation(cx, move |this, _, cx| {
                                this.git_connect_gh(login.clone(), cx);
                            }),
                    ),
            );
        }

        if connected.is_empty() && detected.is_empty() {
            body = body.child(
                div()
                    .px(px(20.0))
                    .py(px(13.0))
                    .flex()
                    .items_center()
                    .gap(px(24.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(sp(13.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text)
                                    .child(tr!("git.github.empty_title")),
                            )
                            .child(
                                div()
                                    .mt(px(4.0))
                                    .text_size(sp(12.0))
                                    .text_color(theme.text_secondary)
                                    .child(tr!(if snapshot.gh_cli.installed {
                                        "git.github.empty_description_gh"
                                    } else {
                                        "git.github.empty_description"
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .id("git-github-add")
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.accent))
                            .h(px(26.0))
                            .px(px(10.0))
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .flex()
                            .flex_none()
                            .items_center()
                            .gap(px(5.0))
                            .cursor_default()
                            .text_size(sp(12.5))
                            .text_color(theme.text_secondary)
                            .hover(|element| element.bg(theme.overlay))
                            .child(icon("icons/plus.svg", 11.0, theme.text_tertiary))
                            .child(tr!("git.github.add"))
                            .on_activation(cx, |this, _, cx| {
                                this.git_start_device_flow(cx);
                            }),
                    ),
            );
        }

        // Footer: connected count + browser connect (upstream always shows
        // the Add button here, empty state or not).
        body = body.child(
            div()
                .px(px(20.0))
                .py(px(8.0))
                .flex()
                .items_center()
                .justify_between()
                .when(!connected.is_empty() || !detected.is_empty(), |row| {
                    row.border_t_1().border_color(theme.border)
                })
                .when(!connected.is_empty(), |row| {
                    row.child(
                        div()
                            .text_size(sp(10.5))
                            .text_color(theme.text_ghost)
                            .child(tr!(
                                "git.github.n_connected",
                                count = connected.len().to_string()
                            )),
                    )
                })
                .child(
                    div()
                        .id("git-github-add-browser")
                        .tab_index(0)
                        .focus_visible(|style| style.border_color(theme.accent))
                        .h(px(24.0))
                        .px(px(8.0))
                        .rounded(px(6.0))
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap(px(5.0))
                        .cursor_default()
                        .text_size(sp(11.5))
                        .text_color(theme.text_secondary)
                        .hover(|element| element.bg(theme.overlay))
                        .child(icon("icons/plus.svg", 11.0, theme.text_tertiary))
                        .child(tr!("git.github.add_browser"))
                        .on_activation(cx, |this, _, cx| {
                            this.git_start_device_flow(cx);
                        }),
                ),
        );
        div().child(head).child(body)
    }

    /// The Identities group (git.tsx:808-906): the pinned global row,
    /// profile rows, and the invite empty state.
    fn render_git_identities_card(
        &self,
        snapshot: &protocol::git_settings::GitSnapshotWire,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let new_button = CardButton::new("git-identity-new", tr!("git.identities.new"))
            .icon("icons/plus.svg")
            .render(theme, cx, |this, _window, cx| this.git_new_profile(cx));

        // Opens the import popover; the runtime action resets the list so the
        // popover shows its fetching state until the reply lands.
        let import_button = CardButton::new("git-identity-import", tr!("git.identities.import"))
            .render(theme, cx, |this, _window, cx| this.git_import_open(cx));

        let global = &snapshot.global;
        let global_line = if global.name.is_some() || global.email.is_some() {
            format!(
                "{} <{}>",
                global.name.as_deref().unwrap_or("—"),
                global.email.as_deref().unwrap_or("—"),
            )
        } else {
            tr!("git.identities.no_global").to_string()
        };

        let head = settings_group_head(
            &theme,
            tr!("git.identities.title"),
            vec![
                new_button.into_any_element(),
                import_button.into_any_element(),
            ],
        );
        let mut body = card_body_flush(&theme).child(
            div()
                .px(px(20.0))
                .py(px(10.0))
                .flex()
                .items_center()
                .gap(px(10.0))
                .child(
                    div()
                        .size(px(28.0))
                        .flex_none()
                        .rounded(px(7.0))
                        .bg(theme.overlay)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon("icons/globe.svg", 14.0, theme.text_tertiary)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(
                                    div()
                                        .text_size(sp(13.0))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.text)
                                        .child(tr!("git.identities.global")),
                                )
                                .child(crate::ui::badge::badge("system", theme)),
                        )
                        .child(
                            div()
                                .mt(px(2.0))
                                .truncate()
                                .font_family(".SystemUIFontMonospaced")
                                .text_size(sp(11.5))
                                .text_color(theme.text_tertiary)
                                .child(global_line),
                        ),
                ),
        );

        for (profile_index, profile) in snapshot.profiles.iter().enumerate() {
            let profile_id = profile.id.clone();
            let armed = self.git_settings.confirm_delete.as_deref() == Some(&profile.id);
            let dot = git_dot_color(&profile.color, &theme);
            let auth_badge = if profile.source == "github" && profile.github_login.is_some() {
                crate::ui::badge::badge("github", theme)
            } else if profile.auth_type == "token" {
                crate::ui::badge::badge(
                    &format!("token · {}", profile.host.as_deref().unwrap_or("host")),
                    theme,
                )
            } else {
                crate::ui::badge::badge("ssh", theme)
            };

            let edit_button = icon_button(
                SharedString::from(format!("git-identity-edit-{}", profile.id)),
                "icons/pencil.svg",
                theme,
            )
            .tab_index(0)
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .on_activation(cx, move |this, _, cx| {
                this.git_edit_profile(&profile_id, cx);
            });

            let delete_label = if armed {
                tr!("common.confirm")
            } else {
                tr!("common.delete")
            };
            let delete_button = div()
                .id(SharedString::from(format!(
                    "git-identity-delete-{}",
                    profile.id
                )))
                .tab_index(0)
                .focus_visible(|style| style.border_color(theme.danger))
                .h(px(24.0))
                .px(px(8.0))
                .rounded(px(6.0))
                .border_1()
                .border_color(if armed {
                    theme.danger
                } else {
                    theme.border_strong
                })
                .when(armed, |element| element.bg(theme.danger.opacity(0.12)))
                .flex()
                .flex_none()
                .items_center()
                .gap(px(5.0))
                .cursor_default()
                .text_size(sp(11.5))
                .text_color(if armed {
                    theme.danger
                } else {
                    theme.text_secondary
                })
                .hover(|element| element.text_color(theme.danger))
                .child(icon(
                    "icons/trash.svg",
                    11.0,
                    if armed {
                        theme.danger
                    } else {
                        theme.text_tertiary
                    },
                ))
                .child(delete_label)
                .on_click(cx.listener({
                    let profile_id = profile.id.clone();
                    move |this, _, _, cx| {
                        if this.git_settings.confirm_delete.as_deref() == Some(&profile_id) {
                            this.git_delete_profile(profile_id.clone());
                        } else {
                            this.git_settings.confirm_delete = Some(profile_id.clone());
                        }
                        cx.notify();
                    }
                }))
                .on_key_down(cx.listener({
                    let profile_id = profile.id.clone();
                    move |this, event: &KeyDownEvent, _, cx| {
                        if !event.keystroke.modifiers.modified()
                            && matches!(event.keystroke.key.as_str(), "enter" | "space")
                        {
                            if this.git_settings.confirm_delete.as_deref() == Some(&profile_id) {
                                this.git_delete_profile(profile_id.clone());
                            } else {
                                this.git_settings.confirm_delete = Some(profile_id.clone());
                            }
                            cx.stop_propagation();
                            cx.notify();
                        }
                    }
                }))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    if this.git_settings.confirm_delete.take().is_some() {
                        cx.notify();
                    }
                }));

            body = body.child(
                div()
                    .px(px(20.0))
                    .py(px(9.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .when(profile_index > 0, |row| {
                        row.border_t_1().border_color(theme.border)
                    })
                    .child(
                        div()
                            .size(px(28.0))
                            .flex_none()
                            .rounded(px(7.0))
                            .bg(dot.opacity(0.14))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(git_identity_icon(&profile.icon), 14.0, dot)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(sp(13.0))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text)
                                            .child(
                                                profile
                                                    .name
                                                    .clone()
                                                    .unwrap_or_else(|| profile.user_name.clone()),
                                            ),
                                    )
                                    .when(profile.sign_commits, |element| {
                                        element.child(crate::ui::badge::badge("signed", theme))
                                    })
                                    .child(auth_badge),
                            )
                            .child(
                                div()
                                    .mt(px(2.0))
                                    .truncate()
                                    .font_family(".SystemUIFontMonospaced")
                                    .text_size(sp(11.5))
                                    .text_color(theme.text_tertiary)
                                    .child(SharedString::from(format!(
                                        "{} <{}>",
                                        profile.user_name, profile.user_email
                                    ))),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(edit_button)
                            .child(delete_button),
                    ),
            );
        }

        if snapshot.profiles.is_empty() {
            body = body.child(
                div()
                    .id("git-identity-empty")
                    .tab_index(0)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .py(px(26.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(7.0))
                    .border_t_1()
                    .border_color(theme.border)
                    .cursor_default()
                    .hover(|element| element.bg(theme.overlay))
                    .child(
                        div()
                            .size(px(32.0))
                            .rounded_full()
                            .border_1()
                            .border_dashed()
                            .border_color(theme.border_strong)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("icons/plus.svg", 14.0, theme.text_tertiary)),
                    )
                    .child(
                        div()
                            .px(px(20.0))
                            .text_center()
                            .text_size(sp(12.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("git.identities.empty")),
                    )
                    .on_activation(cx, |this, _, cx| this.git_new_profile(cx)),
            );
        }
        div().child(head).child(body)
    }

    /// The Attribution group (git.tsx:908-946): the co-authoring switch and
    /// the author/co-author role segmented pair beneath it.
    fn render_git_attribution_card(
        &self,
        snapshot: &protocol::git_settings::GitSnapshotWire,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let attribution = &snapshot.attribution;
        let co_authored = attribution.co_authored;
        let toggle = toggle_switch(
            "git-attribution-toggle",
            co_authored,
            false,
            theme,
            cx,
            move |this, _, cx| {
                this.git_set_attribution(Some(!co_authored), None, cx);
            },
        );

        let mut actions = Vec::new();
        if self.git_settings.saving_attribution {
            actions.push(card_pill(&theme, tr!("git.saved"), theme.success).into_any_element());
        }
        let head = settings_group_head(&theme, tr!("git.attribution.commit"), actions);
        let mut rows = vec![
            CardRow::new(tr!("git.attribution.co_authored"))
                .description(tr!("git.attribution.commit_description"))
                .control(toggle),
        ];

        if co_authored {
            let is_author = attribution.mode == "author";
            let description = if is_author {
                tr!("git.attribution.role_author")
            } else {
                tr!("git.attribution.role_coauthor")
            };
            let author_chip = git_segment_chip(
                "git-attribution-author",
                tr!("git.attribution.mode_author"),
                is_author,
                cx,
                move |this, _, cx| {
                    this.git_set_attribution(None, Some("author".into()), cx);
                },
            );
            let coauthor_chip = git_segment_chip(
                "git-attribution-coauthor",
                tr!("git.attribution.mode_coauthor"),
                !is_author,
                cx,
                move |this, _, cx| {
                    this.git_set_attribution(None, Some("co-author".into()), cx);
                },
            );
            rows.push(
                CardRow::new(tr!("git.attribution.role"))
                    .description(description)
                    .control(
                        div()
                            .flex()
                            .flex_none()
                            .items_center()
                            .gap(px(6.0))
                            .child(author_chip)
                            .child(coauthor_chip),
                    ),
            );
        }
        div()
            .child(head)
            .child(card_body(&theme).child(card_rows(&theme, rows)))
    }

    /// The Workspaces group (git.tsx:948-994): one row per project with its
    /// resolved identity, plus the per-project apply surface — the picker
    /// that writes repo-local git config — folded into each row.
    fn render_git_projects_card(
        &self,
        snapshot: &protocol::git_settings::GitSnapshotWire,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let head = settings_group_head(
            &theme,
            tr!("git.projects.title"),
            vec![
                div()
                    .truncate()
                    .text_size(sp(11.0))
                    .text_color(theme.text_tertiary)
                    .child(tr!("git.projects.caption"))
                    .into_any_element(),
            ],
        );
        let mut body = card_body_flush(&theme);

        if snapshot.statuses.is_empty() {
            body = body.child(
                div()
                    .px(px(20.0))
                    .py(px(13.0))
                    .flex()
                    .items_center()
                    .gap(px(24.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(sp(13.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text)
                                    .child(tr!("git.projects.empty_title")),
                            )
                            .child(
                                div()
                                    .mt(px(4.0))
                                    .text_size(sp(12.0))
                                    .text_color(theme.text_secondary)
                                    .child(tr!("git.projects.empty_description")),
                            ),
                    ),
            );
            return div().child(head).child(body);
        }

        for (index, status) in snapshot.statuses.iter().enumerate() {
            let Some(handle) = self.git_settings.project_menus.get(index) else {
                continue;
            };

            // The matched profile drives the rail color and the picker's
            // current label; `None` means the global identity applies.
            let profile = status
                .profile_id
                .as_ref()
                .and_then(|id| snapshot.profiles.iter().find(|profile| &profile.id == id));
            let rail_color = if status.is_repo {
                git_dot_color(
                    profile.map(|p| p.color.as_str()).unwrap_or("keyword"),
                    &theme,
                )
            } else {
                theme.danger
            };

            let badge_label = if !status.is_repo {
                tr!("git.projects.not_repo")
            } else if status.has_override {
                "override".to_string()
            } else {
                "global".to_string()
            };
            let badge = div()
                .px(px(5.0))
                .py(px(1.0))
                .rounded(px(4.0))
                .border_1()
                .flex_none()
                .text_size(sp(9.5))
                .border_color(if status.is_repo {
                    theme.border_strong
                } else {
                    theme.danger.opacity(0.5)
                })
                .text_color(if status.is_repo {
                    theme.text_tertiary
                } else {
                    theme.danger
                })
                .child(SharedString::from(badge_label.to_uppercase()));

            let second_line = match (status.identity_name.clone(), status.identity_email.clone()) {
                (Some(name), Some(email)) => format!("{} · {} <{}>", status.path, name, email),
                _ => format!("{} · {}", status.path, tr!("git.projects.no_identity")),
            };

            let mut controls = div().flex().flex_none().items_center().gap(px(6.0));

            if status.is_repo {
                // The picker trigger: the active identity or Global. The
                // dropdown primitive owns open state, dismissal, and menu
                // keyboard navigation (arrows/enter/escape); the trigger
                // itself is tabbable like every other control here.
                let current_label = profile
                    .map(|profile| {
                        SharedString::from(
                            profile
                                .name
                                .clone()
                                .unwrap_or_else(|| profile.user_name.clone()),
                        )
                    })
                    .unwrap_or_else(|| SharedString::from(tr!("git.projects.global")));
                let picker_open = handle.is_open();
                let trigger = div()
                    .id(SharedString::from(format!(
                        "git-project-picker-{}",
                        status.project_id
                    )))
                    .tab_index(0)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .h(px(24.0))
                    .px(px(9.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(if picker_open {
                        theme.accent
                    } else {
                        theme.border_strong
                    })
                    .when(picker_open, |element| element.bg(theme.overlay))
                    .max_w(px(180.0))
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .cursor_default()
                    .text_size(sp(11.5))
                    .text_color(theme.text_secondary)
                    .hover(|element| element.bg(theme.overlay))
                    .child(div().truncate().child(current_label))
                    .child(icon("icons/chevron-down.svg", 11.0, theme.text_tertiary));

                let weak = cx.entity().downgrade();
                let project_path = status.path.clone();
                let active_profile_id = status.profile_id.clone();
                let menu_profiles =
                    std::rc::Rc::new(snapshot.profiles.iter().cloned().collect::<Vec<_>>());
                controls = controls.child(dropdown_menu(
                    trigger,
                    SharedString::from(format!("git-project-picker-menu-{}", status.project_id)),
                    handle,
                    MenuAlign::BelowRight,
                    move |_| {
                        let global_weak = weak.clone();
                        let global_path = project_path.clone();
                        let mut items = vec![
                            MenuItem::new(tr!("git.projects.global"), move |_, cx| {
                                let _ = global_weak.update(cx, |this, _| {
                                    this.git_set_project_identity(
                                        global_path.clone(),
                                        "global".into(),
                                    );
                                });
                            })
                            .icon("icons/globe.svg")
                            .selected(active_profile_id.is_none()),
                        ];
                        for menu_profile in menu_profiles.iter() {
                            let weak = weak.clone();
                            let project_path = project_path.clone();
                            let profile_id = menu_profile.id.clone();
                            let display = menu_profile
                                .name
                                .clone()
                                .unwrap_or_else(|| menu_profile.user_name.clone());
                            let email = menu_profile.user_email.clone();
                            let dot = git_dot_color(&menu_profile.color, &theme);
                            let selected =
                                active_profile_id.as_deref() == Some(menu_profile.id.as_str());
                            items.push(
                                MenuItem::custom(move |_, _| {
                                    div()
                                        .w(px(252.0))
                                        .py(px(4.0))
                                        .flex()
                                        .items_center()
                                        .gap(px(9.0))
                                        .child(
                                            div().size(px(7.0)).flex_none().rounded_full().bg(dot),
                                        )
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .child(
                                                    div()
                                                        .w_full()
                                                        .truncate()
                                                        .text_size(sp(12.5))
                                                        .font_weight(FontWeight::MEDIUM)
                                                        .text_color(theme.text)
                                                        .child(display.clone()),
                                                )
                                                .child(
                                                    div()
                                                        .w_full()
                                                        .mt(px(1.0))
                                                        .truncate()
                                                        .font_family(".SystemUIFontMonospaced")
                                                        .text_size(sp(10.5))
                                                        .text_color(theme.text_tertiary)
                                                        .child(email.clone()),
                                                ),
                                        )
                                        .when(selected, |element| {
                                            element.child(icon(
                                                "icons/check.svg",
                                                11.0,
                                                theme.text_tertiary,
                                            ))
                                        })
                                        .into_any_element()
                                })
                                .on_click(move |_, cx| {
                                    let _ = weak.update(cx, |this, _| {
                                        this.git_set_project_identity(
                                            project_path.clone(),
                                            profile_id.clone(),
                                        );
                                    });
                                }),
                            );
                        }
                        items
                    },
                ));
            }

            if status.has_override {
                let project_path = status.path.clone();
                controls = controls.child(
                    div()
                        .id(SharedString::from(format!(
                            "git-project-clear-{}",
                            status.project_id
                        )))
                        .tab_index(0)
                        .focus_visible(|style| style.border_color(theme.danger))
                        .h(px(24.0))
                        .px(px(8.0))
                        .rounded(px(6.0))
                        .border_1()
                        .border_color(theme.border_strong)
                        .flex()
                        .flex_none()
                        .items_center()
                        .cursor_default()
                        .text_size(sp(11.5))
                        .text_color(theme.text_secondary)
                        .hover(|element| element.text_color(theme.danger))
                        .child(tr!("git.projects.clear_override"))
                        .on_activation(cx, move |this, _, cx| {
                            this.git_clear_project_identity(project_path.clone());
                            cx.notify();
                        }),
                );
            }

            body = body.child(
                div()
                    .px(px(20.0))
                    .py(px(9.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .when(index > 0, |row| row.border_t_1().border_color(theme.border))
                    .child(
                        div()
                            .size(px(28.0))
                            .flex_none()
                            .rounded(px(7.0))
                            .bg(rail_color.opacity(0.14))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(div().size(px(8.0)).rounded_full().bg(rail_color)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(sp(13.0))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text)
                                            .child(status.name.clone()),
                                    )
                                    .child(badge),
                            )
                            .child(
                                div()
                                    .mt(px(2.0))
                                    .truncate()
                                    .font_family(".SystemUIFontMonospaced")
                                    .text_size(sp(10.5))
                                    .text_color(theme.text_ghost)
                                    .child(SharedString::from(second_line)),
                            ),
                    )
                    .child(controls),
            );
        }
        div().child(head).child(body)
    }
}

/// One chip of the attribution role pair: a focusable pill that reads as
/// selected through the accent border and tint rather than motion.
pub(super) fn git_segment_chip(
    id: &'static str,
    label: String,
    selected: bool,
    cx: &mut Context<Tide>,
    activate: impl Fn(&mut Tide, &mut Window, &mut Context<Tide>) + 'static,
) -> Chip {
    chip(id, cx, activate)
        .label(label)
        .tone(if selected {
            ChipTone::Selected
        } else {
            ChipTone::Default
        })
        .height(px(26.0))
        .padding_x(px(11.0))
        .rounded(px(7.0))
        .text_size(12.0)
        .no_hover()
        .flex_none()
}

/// A profile tile's icon, from tide's `IDENTITY_ICONS` shortlist. Tide has no
/// user or briefcase mark, so those fall back to the branch glyph.
pub(super) fn git_identity_icon(name: &str) -> &'static str {
    match name {
        "commit" | "code" => "icons/git-commit-horizontal.svg",
        "server" => "icons/server.svg",
        // branch, user, briefcase, and anything unrecognized.
        _ => "icons/git-branch.svg",
    }
}

/// Theme-token dot color, port of tide's `identity-style.ts` map. Tide's
/// palette has no chart series, so those tokens borrow the semantic colors.
pub(super) fn git_dot_color(token: &str, theme: &Theme) -> Hsla {
    match token {
        "success" => theme.success,
        "warning" => theme.warning,
        "destructive" => theme.danger,
        "chart1" => theme.success,
        "chart2" => theme.warning,
        "chart3" => theme.danger,
        "chart4" => theme.favorite,
        "chart5" => theme.text_secondary,
        // keyword and accent both ride the app's accent.
        _ => theme.accent,
    }
}

// ── Tide providers page ──────────────────────────────────────────────
//
// The exact-match twin of tide's Providers screen: provider cards with key
// status and enable/delete, an empty state, and the Add Provider wizard.

impl Tide {
    fn render_tide_settings(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        // Loading is requested from the page-switch action; &self rendering
        // must stay pure.
        let add = CardButton::new("tide-add-provider", tr!("tide.add_provider"))
            .icon("icons/plus.svg")
            .render(theme, cx, |this, window, cx| {
                this.tide_open_add_wizard(None, window, cx);
            });
        let head = settings_page_header(
            &theme,
            tr!("settings.tide"),
            Some(SharedString::from(tr!("tide.caption"))),
            Some(add.into_any_element()),
        );
        let mut body = div().flex().flex_col().gap(px(10.0));
        if self.tide.providers.is_empty() && self.tide.loaded {
            body = body.child(
                div()
                    .p(px(24.0))
                    .rounded(px(12.0))
                    .border_1()
                    .border_color(theme.border)
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .text_size(sp(13.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(tr!("tide.empty_title")),
                    )
                    .child(
                        div()
                            .text_size(sp(12.0))
                            .text_color(theme.text_tertiary)
                            .child(tr!("tide.empty_description")),
                    ),
            );
        }
        for provider in &self.tide.providers {
            let provider_id = provider.id.clone();
            let provider_id_toggle = provider.id.clone();
            let enabled = provider.enabled;
            let has_key = provider.has_key;
            let summary = format!(
                "{} · {} · {}",
                provider.base_url,
                provider.api_style,
                tr!("tide.model_count", count = provider.models.len()),
            );
            body = body.child(
                div()
                    .id(SharedString::from(format!("tide-provider-{}", provider.id)))
                    .pl(px(12.0))
                    .pr(px(10.0))
                    .py(px(8.0))
                    .rounded(px(9.0))
                    .border_1()
                    .border_color(theme.border)
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .when(!enabled, |element| element.opacity(0.55))
                    .child(crate::ui::brand::brand_tile(
                        crate::app::tide_providers::brand_for(
                            &provider.base_url,
                            &provider.api_style,
                        )
                        .0,
                        crate::app::tide_providers::brand_for(
                            &provider.base_url,
                            &provider.api_style,
                        )
                        .1,
                        28.0,
                        14.0,
                        &theme,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .child(
                                div()
                                    .flex()
                                    .items_baseline()
                                    .gap(px(8.0))
                                    .child(
                                        div()
                                            .text_size(sp(13.0))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text)
                                            .child(provider.name.clone()),
                                    )
                                    .child(
                                        div()
                                            .text_size(sp(11.0))
                                            .text_color(if has_key {
                                                theme.text_tertiary
                                            } else {
                                                theme.danger
                                            })
                                            .child(tr!(if has_key {
                                                "tide.key_stored"
                                            } else {
                                                "tide.no_key"
                                            })),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(sp(11.5))
                                    .text_color(theme.text_tertiary)
                                    .truncate()
                                    .child(summary),
                            ),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!(
                                "tide-provider-edit-{}",
                                provider.id
                            )))
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.accent))
                            .px(px(10.0))
                            .h(px(26.0))
                            .rounded(px(7.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .flex()
                            .items_center()
                            .cursor_default()
                            .text_size(sp(11.5))
                            .text_color(theme.text_secondary)
                            .hover(|element| element.bg(theme.overlay))
                            .child(tr!("tide.edit"))
                            .on_click(cx.listener({
                                let provider_id = provider_id.clone();
                                move |this, _, window, cx| {
                                    this.tide_open_edit_wizard(provider_id.clone(), window, cx);
                                }
                            })),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!(
                                "tide-provider-toggle-{}",
                                provider.id
                            )))
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.accent))
                            .px(px(10.0))
                            .h(px(26.0))
                            .rounded(px(7.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .flex()
                            .items_center()
                            .cursor_default()
                            .text_size(sp(11.5))
                            .text_color(theme.text_secondary)
                            .hover(|element| element.bg(theme.overlay))
                            .child(tr!(if enabled {
                                "tide.disable"
                            } else {
                                "tide.enable"
                            }))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.tide_toggle_enabled(provider_id_toggle.clone(), !enabled);
                                cx.notify();
                            })),
                    )
                    .child(
                        icon_button(
                            SharedString::from(format!("tide-provider-delete-{}", provider.id)),
                            "icons/trash.svg",
                            theme,
                        )
                        .tab_index(0)
                        .focus_visible(|style| style.border_color(theme.accent))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.tide_delete_provider(provider_id.clone());
                            cx.notify();
                        })),
                    ),
            );
        }
        if let Some(error) = &self.tide.error {
            body = body.child(
                div()
                    .text_size(sp(12.0))
                    .text_color(theme.danger)
                    .child(error.clone()),
            );
        }
        div().child(head).child(body)
    }
}
