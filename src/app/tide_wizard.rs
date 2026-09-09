//! The Add Provider wizard overlay — a faithful GPUI port of tide's
//! four-step wizard (choose → connect → models → review), including the
//! connection-test gate, Auto-Detect Protocol, preset routing, and the
//! From-provider / Available-models / Other-endpoint model sectioning.

use super::*;
use client::tide::TideModelWire;

use crate::app::tide_providers::{TIDE_PRESETS, TideWizardStep, preset_added};
use crate::ui::text_field::TextField;
use crate::ui::{icon, icon_button};

const WIZARD_CONTEXT: &str = "TideWizard";

impl Tide {
    pub(super) fn render_tide_wizard(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if let Some(provider_id) = self.tide_edit_request.take() {
            self.tide_open_edit_wizard(provider_id, window, cx);
        }
        let wizard = self.tide.wizard.as_ref()?;
        let theme = Theme::current(cx);
        let step = wizard.step;
        let editing = wizard.edit_provider_id.is_some();

        let title = tr!(match step {
            TideWizardStep::Choose => "tide.wizard_choose",
            TideWizardStep::Connect => "tide.wizard_connect",
            TideWizardStep::Models => "tide.wizard_models",
            TideWizardStep::Review => "tide.wizard_review",
        });

        let mut card = div()
            .id("tide-wizard-card")
            .key_context(WIZARD_CONTEXT)
            .w_full()
            .min_w(window.bounds().size.width * 0.6)
            .max_w(px(768.0))
            .h(px(600.0))
            .overflow_hidden()
            .rounded(px(18.0))
            .bg(theme.composer)
            .shadow_xl()
            .flex()
            .flex_col()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

        card = card
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(20.0))
                    .py(px(14.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .child(
                                div()
                                    .text_size(sp(15.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text)
                                    .child(title),
                            )
                            .child(
                                div()
                                    .text_size(sp(11.5))
                                    .text_color(theme.text_tertiary)
                                    .child(tr!(
                                        if editing {
                                            "tide.wizard_editing"
                                        } else {
                                            "tide.wizard_step"
                                        },
                                        step = step_index(step),
                                        total = 4
                                    )),
                            ),
                    )
                    .child(
                        icon_button("tide-wizard-close", "icons/x.svg", theme)
                            .tab_index(0)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.tide_close_wizard(cx);
                            })),
                    ),
            )
            .child(div().mx(px(20.0)).h(px(1.0)).bg(theme.border));

        let steps = [
            (TideWizardStep::Choose, "tide.step_choose"),
            (TideWizardStep::Connect, "tide.step_connect"),
            (TideWizardStep::Models, "tide.step_models"),
            (TideWizardStep::Review, "tide.step_review"),
        ];
        let current_index = steps
            .iter()
            .position(|(this, _)| *this == step)
            .unwrap_or(0);
        let mut sidebar = div()
            .w(px(168.0))
            .flex_none()
            .border_r_1()
            .border_color(theme.border)
            .p(px(10.0))
            .flex()
            .flex_col()
            .gap(px(6.0));
        for (index, (this, label_key)) in steps.iter().enumerate() {
            let _ = this;
            let current = index == current_index;
            let completed = index < current_index;
            let label_key: &'static str = label_key;
            let badge = div()
                .id(SharedString::from(format!("tide-step-badge-{index}")))
                .w(px(22.0))
                .h(px(22.0))
                .rounded(px(7.0))
                .flex()
                .items_center()
                .justify_center()
                .flex_none()
                .when(current, |element| element.bg(theme.accent))
                .when(completed && !current, |element| {
                    element.bg(theme.accent.opacity(0.18))
                })
                .when(!current && !completed, |element| {
                    element
                        .bg(theme.overlay)
                        .border_1()
                        .border_color(theme.border)
                })
                .map(|element| {
                    if completed && !current {
                        element.child(icon("icons/check.svg", 11.0, theme.accent))
                    } else {
                        element.child(
                            div()
                                .text_size(sp(11.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .when(current, |element| element.text_color(theme.raised))
                                .when(!current, |element| element.text_color(theme.text_tertiary))
                                .child(SharedString::from((index + 1).to_string())),
                        )
                    }
                });
            sidebar = sidebar.child(
                div()
                    .id(SharedString::from(format!("tide-step-row-{index}")))
                    .p(px(8.0))
                    .rounded(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(9.0))
                    .when(current, |element| {
                        element
                            .border_1()
                            .border_color(theme.accent.opacity(0.4))
                            .bg(theme.overlay)
                    })
                    .when(completed && !current, |element| {
                        element.border_1().border_color(theme.border)
                    })
                    .child(badge)
                    .child(
                        div()
                            .text_size(sp(12.5))
                            .when(current, |element| {
                                element
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text)
                            })
                            .when(!current, |element| {
                                element.text_color(if completed {
                                    theme.text
                                } else {
                                    theme.text_ghost
                                })
                            })
                            .child(tr!(label_key)),
                    ),
            );
        }

        let content = match step {
            TideWizardStep::Choose => self
                .render_tide_wizard_choose(&theme, cx)
                .into_any_element(),
            TideWizardStep::Connect => self
                .render_tide_wizard_connect(&theme, cx)
                .into_any_element(),
            TideWizardStep::Models => self
                .render_tide_wizard_models(&theme, cx)
                .into_any_element(),
            TideWizardStep::Review => self
                .render_tide_wizard_review(&theme, cx)
                .into_any_element(),
        };

        // Footer — tide's single Back / status / Continue bar.
        let selected_count = wizard.models.iter().filter(|(_, checked)| *checked).count();
        let can_continue = match step {
            TideWizardStep::Choose => false,
            TideWizardStep::Connect => true,
            TideWizardStep::Models => selected_count > 0,
            TideWizardStep::Review => true,
        };
        let busy = wizard.testing || wizard.saving || wizard.fetching;
        let on_connect = step == TideWizardStep::Connect;
        let action_label = tr!(if step == TideWizardStep::Review {
            "tide.save_provider"
        } else {
            "tide.continue"
        });
        let next_step = match step {
            TideWizardStep::Choose => TideWizardStep::Connect,
            TideWizardStep::Connect => TideWizardStep::Models,
            TideWizardStep::Models => TideWizardStep::Review,
            TideWizardStep::Review => TideWizardStep::Review,
        };
        let footer = div()
            .px(px(20.0))
            .py(px(10.0))
            .border_t_1()
            .border_color(theme.border)
            .bg(theme.overlay)
            .flex()
            .items_center()
            .justify_between()
            .flex_none()
            .child(
                div()
                    .id("tide-wizard-back")
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
                    .when(step == TideWizardStep::Choose, |element| {
                        element.opacity(0.4)
                    })
                    .cursor_default()
                    .text_size(sp(12.5))
                    .text_color(theme.text_secondary)
                    .hover(|element| element.bg(theme.overlay))
                    .child(icon("icons/arrow-left.svg", 11.0, theme.text_tertiary))
                    .child(tr!("tide.back"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(wizard) = this.tide.wizard.as_mut() {
                            wizard.step = match wizard.step {
                                TideWizardStep::Connect => TideWizardStep::Choose,
                                TideWizardStep::Models => TideWizardStep::Connect,
                                TideWizardStep::Review => TideWizardStep::Models,
                                TideWizardStep::Choose => TideWizardStep::Choose,
                            };
                            wizard.error = None;
                        }
                        cx.notify();
                    })),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .min_w_0()
                    .when(on_connect && wizard.tested, |element| {
                        element.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(4.0))
                                .text_size(sp(11.5))
                                .text_color(theme.accent)
                                .child(icon("icons/check.svg", 11.0, theme.accent))
                                .child(tr!("tide.connection_verified")),
                        )
                    })
                    .when_some(
                        wizard.error.clone().filter(|_| on_connect),
                        |element, error| {
                            element.child(
                                div()
                                    .text_size(sp(11.5))
                                    .text_color(theme.danger)
                                    .truncate()
                                    .max_w(px(280.0))
                                    .child(error),
                            )
                        },
                    )
                    .child(
                        div()
                            .id("tide-wizard-next")
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.accent))
                            .h(px(26.0))
                            .px(px(10.0))
                            .min_w(px(110.0))
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .when(!can_continue || busy, |element| element.opacity(0.45))
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .gap(px(5.0))
                            .cursor_default()
                            .text_size(sp(12.5))
                            .text_color(theme.text_secondary)
                            .hover(|element| element.bg(theme.overlay))
                            .when(busy, |element| {
                                element.child(tr!(if on_connect {
                                    "tide.testing_connection"
                                } else {
                                    "tide.saving"
                                }))
                            })
                            .when(!busy, |element| element.child(action_label.clone()))
                            .when(step != TideWizardStep::Review && !busy, |element| {
                                element.child(icon(
                                    "icons/arrow-right.svg",
                                    11.0,
                                    theme.text_tertiary,
                                ))
                            })
                            .when(step == TideWizardStep::Review && !busy, |element| {
                                element.child(icon("icons/check.svg", 11.0, theme.text_tertiary))
                            })
                            .on_click(cx.listener(move |this, _, _, cx| match next_step {
                                TideWizardStep::Review => this.tide_save_wizard(cx),
                                TideWizardStep::Models => this.tide_wizard_continue_connect(cx),
                                other => this.tide_wizard_step(other, cx),
                            })),
                    ),
            );

        card = card
            .child(
                div().flex().flex_1().min_h_0().child(sidebar).child(
                    div()
                        .id("tide-wizard-content")
                        .flex_1()
                        .min_w_0()
                        .overflow_y_scroll()
                        .child(content),
                ),
            )
            .child(footer);

        let scrim = if theme.is_dark {
            gpui::hsla(0.0, 0.0, 0.0, 0.34)
        } else {
            gpui::hsla(0.0, 0.0, 0.0, 0.16)
        };
        let layer = div()
            .id("tide-wizard-layer")
            .absolute()
            .inset_0()
            .occlude()
            .bg(scrim)
            .p(px(24.0))
            .flex()
            .items_center()
            .justify_center()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.tide_close_wizard(cx);
                }),
            )
            .child(card);
        // Priority 0 keeps the wizard above same-priority app content (it mounts
        // later in the tree) while letting anchored menus — priority 1 — float
        // above the scrim instead of behind it.
        Some(gpui::deferred(layer).with_priority(0).into_any_element())
    }

    fn render_tide_wizard_choose(&self, theme: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let wizard = self.tide.wizard.as_ref().expect("wizard open");
        let query = wizard.search.read(cx).content().trim().to_lowercase();
        let providers = self.tide.providers.clone();
        let existing_any = !providers.is_empty();
        let mut body = div()
            .id("tide-wizard-choose-body")
            .p(px(18.0))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .flex_1()
            .child(
                TextField::new("tide-search", wizard.search.clone()).icon("icons/search.svg", 13.0),
            );
        let mut any_visible = false;
        for (group_key, group_label) in [
            ("first_party", tr!("tide.group_first_party")),
            ("aggregator", tr!("tide.group_aggregator")),
            ("local", tr!("tide.group_local")),
        ] {
            let presets: Vec<&'static crate::app::tide_providers::TidePreset> = TIDE_PRESETS
                .iter()
                .filter(|preset| {
                    preset.group == group_key
                        && (query.is_empty()
                            || preset.name.to_lowercase().contains(&query)
                            || preset.id.contains(&query))
                })
                .collect();
            let customs_visible = group_key == "local"
                && (query.is_empty()
                    || tr!("tide.custom_openai").to_lowercase().contains(&query)
                    || tr!("tide.custom_anthropic").to_lowercase().contains(&query));
            if presets.is_empty() && !customs_visible {
                continue;
            }
            any_visible = true;
            let mut group = div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(
                    div()
                        .text_size(sp(11.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_tertiary)
                        .child(group_label),
                )
                .child(div().flex().flex_col().gap(px(8.0)));
            // Two equal columns at any dialog width — GPUI has no CSS grid,
            // so tiles chunk into rows of flex-halves.
            for row in presets.chunks(2) {
                let mut row_element = div().flex().gap(px(8.0));
                for preset in row.iter().copied() {
                    let added = preset_added(&providers, preset);
                    let selected = self
                        .tide
                        .wizard
                        .as_ref()
                        .and_then(|wizard| wizard.preset)
                        .is_some_and(|current| current.id == preset.id);
                    let host = base_host(preset.base_url);
                    row_element = row_element.child(
                        div()
                            .id(SharedString::from(format!("tide-preset-{}", preset.id)))
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.accent))
                            .flex_1()
                            .min_w_0()
                            .p(px(10.0))
                            .rounded(px(12.0))
                            .border_1()
                            .border_color(if selected {
                                theme.accent.opacity(0.5)
                            } else {
                                theme.border
                            })
                            .when(!added, |element| {
                                element.hover(|hover| hover.bg(theme.overlay))
                            })
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .cursor_default()
                            .child(crate::ui::brand::brand_tile(
                                preset.logo,
                                preset.accent,
                                32.0,
                                16.0,
                                theme,
                            ))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .child(
                                        div()
                                            .text_size(sp(12.5))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text.opacity(0.85))
                                            .child(preset.name),
                                    )
                                    .child(
                                        div()
                                            .text_size(sp(10.5))
                                            .text_color(theme.text_ghost)
                                            .truncate()
                                            .child(host),
                                    ),
                            )
                            .when(added, |element| {
                                element.child(
                                    div()
                                        .px(px(6.0))
                                        .h(px(16.0))
                                        .rounded(px(4.0))
                                        .bg(theme.overlay)
                                        .flex()
                                        .items_center()
                                        .flex_none()
                                        .text_size(sp(9.0))
                                        .text_color(theme.text_tertiary)
                                        .child(tr!("tide.preset_added")),
                                )
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.tide_choose_preset(preset, cx);
                            })),
                    );
                }
                if row.len() == 1 {
                    row_element = row_element.child(div().flex_1());
                }
                group = group.child(row_element);
            }
            if customs_visible {
                let customs: [(&'static str, String); 2] = [
                    ("openai", tr!("tide.custom_openai")),
                    ("anthropic", tr!("tide.custom_anthropic")),
                ];
                let mut row_element = div().flex().gap(px(8.0));
                for (style, label) in customs {
                    row_element = row_element.child(
                        div()
                            .id(SharedString::from(format!("tide-custom-{style}")))
                            .tab_index(0)
                            .focus_visible(|element| element.border_color(theme.accent))
                            .flex_1()
                            .min_w_0()
                            .p(px(10.0))
                            .rounded(px(12.0))
                            .border_1()
                            .border_dashed()
                            .border_color(theme.border)
                            .hover(|element| element.bg(theme.overlay))
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .cursor_default()
                            .child(
                                div()
                                    .w(px(32.0))
                                    .h(px(32.0))
                                    .rounded(px(9.0))
                                    .bg(theme.overlay)
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .flex_none()
                                    .child(icon("icons/plug.svg", 15.0, theme.text_tertiary)),
                            )
                            .child(
                                div()
                                    .text_size(sp(12.5))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text.opacity(0.85))
                                    .child(label),
                            )
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.tide_open_custom_wizard(style, window, cx);
                            })),
                    );
                }
                group = group.child(row_element);
            }
            body = body.child(group);
        }
        if !any_visible {
            body = body.child(
                div()
                    .py(px(28.0))
                    .flex()
                    .justify_center()
                    .text_size(sp(12.0))
                    .text_color(theme.text_tertiary)
                    .child(tr!("tide.no_preset_match", query = query.clone())),
            );
        }
        body = body.child(
            div()
                .text_size(sp(10.5))
                .text_color(theme.text_ghost)
                .child(tr!(if existing_any {
                    "tide.choose_hint_multi"
                } else {
                    "tide.choose_hint_first"
                })),
        );
        body
    }

    fn render_tide_wizard_connect(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let wizard = self.tide.wizard.as_ref().expect("wizard open");
        let custom = wizard.preset.is_none();
        let field = |label: String, input: Entity<crate::input::TextInput>| {
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(
                    div()
                        .text_size(sp(11.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_secondary)
                        .child(label),
                )
                .child(TextField::new("tide-wizard-field", input).w(px(430.0)))
        };
        let mut body = div()
            .p(px(20.0))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .flex_1()
            .child(field(tr!("tide.field_name"), wizard.name.clone()))
            .child(field(tr!("tide.field_api_key"), wizard.api_key.clone()))
            .child(
                div()
                    .text_size(sp(11.0))
                    .text_color(theme.text_ghost)
                    .child(tr!("tide.keychain_hint")),
            );
        // Custom endpoints edit the base URL inline; preset paths keep it in
        // Advanced-equivalent fields (protocol chips + URL) since there is no
        // disclosure widget to hide behind yet.
        body = body
            .child(field(tr!("tide.field_base_url"), wizard.base_url.clone()))
            .child(
                div().flex().items_center().gap(px(8.0)).child(
                    div()
                        .text_size(sp(11.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_secondary)
                        .child(tr!("tide.field_api_style")),
                ),
            );
        let mut style_row = div().flex().items_center().gap(px(6.0));
        for style in ["openai", "anthropic"] {
            let selected = wizard.api_style == style;
            let label = tr!(if style == "openai" {
                "tide.style_openai"
            } else {
                "tide.style_anthropic"
            });
            style_row = style_row.child(
                div()
                    .id(SharedString::from(format!("tide-style-{style}")))
                    .tab_index(0)
                    .focus_visible(|element| element.border_color(theme.accent))
                    .px(px(9.0))
                    .h(px(24.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(if selected {
                        theme.accent
                    } else {
                        theme.border_strong
                    })
                    .flex()
                    .items_center()
                    .cursor_default()
                    .text_size(sp(11.5))
                    .text_color(if selected {
                        theme.text
                    } else {
                        theme.text_secondary
                    })
                    .hover(|element| element.bg(theme.raised))
                    .child(label)
                    .on_click({
                        cx.listener(move |this, _, _, cx| {
                            this.tide_set_style(style, cx);
                        })
                    }),
            );
        }
        body = body.child(style_row);
        if custom {
            body = body.child(
                div()
                    .id("tide-auto-detect")
                    .tab_index(0)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .mt(px(2.0))
                    .h(px(26.0))
                    .px(px(10.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .text_size(sp(12.0))
                    .text_color(theme.text_secondary)
                    .hover(|element| element.bg(theme.raised))
                    .child(tr!(if wizard.testing {
                        "tide.detecting"
                    } else {
                        "tide.auto_detect"
                    }))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.tide_auto_detect(cx);
                    })),
            );
        }
        if wizard.testing {
            body = body.child(
                div()
                    .text_size(sp(11.5))
                    .text_color(theme.text_ghost)
                    .child(tr!("tide.testing_connection")),
            );
        }
        if let Some(error) = &wizard.error {
            body = body.child(
                div()
                    .text_size(sp(12.0))
                    .text_color(theme.danger)
                    .child(error.clone()),
            );
        }
        body
    }

    fn render_tide_wizard_models(&self, theme: &Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let wizard = self.tide.wizard.as_ref().expect("wizard open");
        let query = wizard.model_search.read(cx).content().trim().to_lowercase();
        let mut body = div()
            .id("tide-wizard-models-body")
            .p(px(18.0))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .flex_1()
            .min_h_0();

        // Toolbar: filter field + the ⋯ actions menu.
        let menu_handle = self.menu_handle("tide-models-menu", cx);
        let weak = cx.entity().downgrade();
        let toolbar = div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .flex_none()
            .child(
                TextField::new("tide-model-search", wizard.model_search.clone())
                    .icon("icons/search.svg", 13.0)
                    .flex_1(),
            )
            .child(dropdown_menu(
                div()
                    .id("tide-models-menu-trigger")
                    .w(px(28.0))
                    .h(px(28.0))
                    .rounded(px(7.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .hover(|element| element.bg(theme.overlay))
                    .child(icon("icons/ellipsis.svg", 15.0, theme.text_secondary)),
                "tide-models-menu-list",
                &menu_handle,
                MenuAlign::BelowRight,
                move |_| {
                    vec![
                        MenuItem::new(tr!("tide.refresh"), {
                            let weak = weak.clone();
                            move |_, cx| {
                                let _ = weak.update(cx, |this, cx| this.tide_refresh_models(cx));
                            }
                        }),
                        MenuItem::new(tr!("tide.select_all"), {
                            let weak = weak.clone();
                            move |_, cx| {
                                let _ =
                                    weak.update(cx, |this, cx| this.tide_set_all_models(true, cx));
                            }
                        }),
                        MenuItem::new(tr!("tide.deselect_all"), {
                            let weak = weak.clone();
                            move |_, cx| {
                                let _ =
                                    weak.update(cx, |this, cx| this.tide_set_all_models(false, cx));
                            }
                        }),
                    ]
                },
            ));
        body = body.child(toolbar);

        if wizard.fetching {
            body = body.child(
                div()
                    .py(px(24.0))
                    .flex()
                    .justify_center()
                    .text_size(sp(12.5))
                    .text_color(theme.text_tertiary)
                    .child(tr!("tide.fetching_models")),
            );
            return body;
        }

        // Routing-excluded ids dim under "Other endpoint"; everything else
        // sections into From provider (live) and Available models.
        let routing = wizard.routing_filter();
        let mut other: Vec<&(TideModelWire, bool)> = Vec::new();
        let mut live: Vec<&(TideModelWire, bool)> = Vec::new();
        let mut available: Vec<&(TideModelWire, bool)> = Vec::new();
        for entry in &wizard.models {
            let lowered = entry.0.model_id.to_ascii_lowercase();
            let alias = entry.0.alias.to_ascii_lowercase();
            if !query.is_empty() && !lowered.contains(&query) && !alias.contains(&query) {
                continue;
            }
            if routing.is_some_and(|needles| !needles.iter().any(|needle| lowered.contains(needle)))
            {
                other.push(entry);
            } else if entry.0.match_state == "live" {
                live.push(entry);
            } else {
                available.push(entry);
            }
        }
        let section = |title: String, rows: Vec<&(TideModelWire, bool)>, dim: bool| -> Div {
            let mut list = div().flex().flex_col().gap(px(3.0)).child(
                div()
                    .text_size(sp(11.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if dim {
                        theme.text_ghost
                    } else {
                        theme.text_tertiary
                    })
                    .child(title),
            );
            for (model, checked) in rows {
                let model_id = model.model_id.clone();
                let title_text = if model.alias == model.model_id {
                    model.model_id.clone()
                } else {
                    format!("{} · {}", model.alias, model.model_id)
                };
                let badges = model_badges(model, theme);
                list = list.child(
                    div()
                        .id(SharedString::from(format!("tide-model-{}", model.model_id)))
                        .tab_index(0)
                        .focus_visible(|style| style.border_color(theme.accent))
                        .pl(px(6.0))
                        .pr(px(8.0))
                        .py(px(5.0))
                        .rounded(px(6.0))
                        .flex()
                        .items_center()
                        .gap(px(9.0))
                        .when(dim, |element| element.opacity(0.45))
                        .when(!dim, |element| {
                            element
                                .cursor(gpui::CursorStyle::PointingHand)
                                .hover(|hover| hover.bg(theme.raised))
                        })
                        .child(checkbox(*checked, dim, theme))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(sp(12.0))
                                .text_color(theme.text)
                                .child(title_text),
                        )
                        .child(badges)
                        .when(!dim, |element| {
                            element.on_click(cx.listener(move |this, _, _, cx| {
                                this.tide_toggle_model(&model_id, cx);
                            }))
                        }),
                );
            }
            list
        };
        let (live_count, available_count, other_count) = (live.len(), available.len(), other.len());
        if live_count > 0 {
            body = body.child(section(tr!("tide.section_from_provider"), live, false));
        }
        if available_count > 0 {
            body = body.child(section(tr!("tide.section_available"), available, false));
        }
        if other_count > 0 {
            body = body.child(section(tr!("tide.section_other_endpoint"), other, true));
        }
        if live_count == 0 && available_count == 0 && other_count == 0 {
            body = body.child(
                div()
                    .py(px(20.0))
                    .text_size(sp(12.0))
                    .text_color(theme.text_tertiary)
                    .child(tr!(
                        if query.is_empty() {
                            "tide.no_models"
                        } else {
                            "tide.no_preset_match"
                        },
                        query = query.clone()
                    )),
            );
        }
        if let Some(error) = &wizard.error {
            body = body.child(
                div()
                    .text_size(sp(12.0))
                    .text_color(theme.danger)
                    .child(error.clone()),
            );
        }
        body
    }

    fn render_tide_wizard_review(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let wizard = self.tide.wizard.as_ref().expect("wizard open");
        let name = wizard.name.read(cx).content().trim().to_owned();
        let base_url = wizard.base_url.read(cx).content().trim().to_owned();
        let selected = wizard
            .models
            .iter()
            .filter(|(_, checked)| *checked)
            .map(|(model, _)| model.alias.clone())
            .collect::<Vec<_>>();
        let mut body = div()
            .p(px(20.0))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .flex_1()
            .child(
                div()
                    .p(px(12.0))
                    .rounded(px(9.0))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.overlay)
                    .flex()
                    .flex_col()
                    .gap(px(3.0))
                    .child(
                        div()
                            .text_size(sp(13.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(name),
                    )
                    .child(
                        div()
                            .text_size(sp(11.5))
                            .text_color(theme.text_tertiary)
                            .child(base_url),
                    )
                    .child(
                        div()
                            .text_size(sp(11.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!(
                                "tide.style_anthropic_or_openai",
                                style = wizard.api_style.clone()
                            )),
                    ),
            )
            .child(
                div()
                    .text_size(sp(11.0))
                    .text_color(theme.text_ghost)
                    .child(tr!("tide.keychain_hint")),
            )
            .child(
                div().flex().flex_wrap().gap(px(6.0)).child(
                    div()
                        .text_size(sp(11.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_tertiary)
                        .child(tr!("tide.selected_models")),
                ),
            );
        for alias in selected {
            body = body.child(
                div()
                    .px(px(8.0))
                    .h(px(22.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .flex()
                    .items_center()
                    .text_size(sp(11.0))
                    .text_color(theme.text_secondary)
                    .child(alias),
            );
        }
        if let Some(error) = &wizard.error {
            body = body.child(
                div()
                    .text_size(sp(12.0))
                    .text_color(theme.danger)
                    .child(error.clone()),
            );
        }
        body
    }
}

fn step_index(step: TideWizardStep) -> u32 {
    match step {
        TideWizardStep::Choose => 1,
        TideWizardStep::Connect => 2,
        TideWizardStep::Models => 3,
        TideWizardStep::Review => 4,
    }
}

/// A model row's right-hand metadata: context, price, reasoning/vision marks.
fn model_badges(model: &TideModelWire, theme: &Theme) -> Div {
    let mut badges = div().flex().items_center().gap(px(6.0));
    if model.reasoning {
        badges = badges.child(thinking_mark());
    }
    if model.vision {
        badges = badges.child(vision_mark());
    }
    badges = badges.child(
        div()
            .text_size(sp(10.5))
            .text_color(theme.text_tertiary)
            .child(format_context(model.context_window)),
    );
    if let Some(price) = &model.price_label {
        badges = badges.child(
            div()
                .text_size(sp(10.5))
                .text_color(theme.text_tertiary)
                .child(price.clone()),
        );
    }
    badges
}

/// tide's formatContext: 950K+ reads as M, 1K+ as K with stepped rounding.
pub(crate) fn format_context(window: u64) -> String {
    if window >= 950_000 {
        let m = (window as f64 / 100_000.0).round() / 10.0;
        if (m - m.trunc()).abs() < f64::EPSILON {
            format!("{}M", m as u64)
        } else {
            format!("{m:.1}M")
        }
    } else if window >= 1_000 {
        let step = if window >= 100_000 { 10_000 } else { 1_000 };
        let k = (window as f64 / step as f64).round() as u64 * (step as u64 / 1000);
        format!("{k}K")
    } else {
        window.to_string()
    }
}

/// Host of a base URL — tide's tile sub-line.
fn base_host(base_url: &str) -> String {
    base_url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or(base_url)
        .to_owned()
}

/// A 15px checkbox: quiet border when clear, accent fill with a white check
/// when selected; dimmed rows keep the quiet box.
fn checkbox(checked: bool, dim: bool, theme: &Theme) -> Div {
    let mut element = div()
        .w(px(15.0))
        .h(px(15.0))
        .rounded(px(4.0))
        .flex()
        .items_center()
        .justify_center()
        .flex_none();
    if checked && !dim {
        element = element.bg(theme.accent).child(icon(
            "icons/check.svg",
            10.0,
            gpui::hsla(0.0, 0.0, 1.0, 1.0),
        ));
    } else {
        element = element.border_1().border_color(if dim {
            theme.border
        } else {
            theme.border_strong
        });
    }
    element
}

/// tide's capability marks: thinking in purple, vision in yellow.
fn thinking_mark() -> gpui::Svg {
    icon("icons/brain.svg", 11.0, gpui::rgb(0x8B5CF6).into())
}

fn vision_mark() -> gpui::Svg {
    icon("icons/eye.svg", 11.0, gpui::rgb(0xEAB308).into())
}
