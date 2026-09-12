//! The General settings page: analytics, updates, and the background
//! task/model defaults.

use gpui::prelude::*;
use gpui::{FontWeight, div};
use std::rc::Rc;

use crate::app::model_picker::{ModelPickerClear, ModelPickerConfig, ModelPickerSelect};
use crate::model::ProviderKind;
use crate::theme::{Theme, sp};
use crate::ui::{MenuChip, menu::MenuAlign, toggle_switch};
use gpui::{AnyElement, Context, Div, SharedString, px};

use crate::app::Tide;
use crate::ui::card::{CardRow, card_body, card_rows, settings_group_head, settings_page_header};

impl Tide {
    pub(in crate::app) fn render_general_settings(&self, cx: &mut Context<Self>) -> AnyElement {
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

    /// The Memory page: two columns — memory & RAG configuration on the
    /// left (embedding model, custom endpoints, retrieval, advanced), the
    /// knowledge sources registry on the right.
    /// The "Background Tasks" group on the General page: the two model
    /// overrides background work (session titles, commit messages) uses when
    /// the user has pinned one, defaulting to the session.s model.
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
}
