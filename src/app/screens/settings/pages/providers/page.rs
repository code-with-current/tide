//! The Tide providers page: provider connections, model availability, and
//! the Add Provider wizard entry.

use crate::theme::sp;
use gpui::prelude::*;
use gpui::{FontWeight, SharedString, div, px};

use crate::ui::card::{CardButton, card_pill, settings_page_header};
use crate::ui::icon_button;
use crate::ui::menu::{MenuItem, context_menu};
use gpui::{Context, Div};

use crate::app::Tide;
use crate::theme::Theme;

impl Tide {
    pub(in crate::app) fn render_tide_settings(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
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
            let brand = super::brand_for(&provider.base_url, &provider.api_style);
            let menu = self.menu_handle(
                SharedString::from(format!("tide-provider-menu-{}", provider.id)),
                cx,
            );
            body = body.child(
                div()
                    .id(SharedString::from(format!("tide-provider-{}", provider.id)))
                    .pl(px(12.0))
                    .pr(px(8.0))
                    .py(px(8.0))
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(theme.border)
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .when(!enabled, |element| element.opacity(0.55))
                    .child(crate::ui::brand::brand_tile(
                        brand.0, brand.1, 28.0, 14.0, &theme,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(5.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .child(
                                        div()
                                            .text_size(sp(13.0))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text)
                                            .truncate()
                                            .child(provider.name.clone()),
                                    )
                                    .child(card_pill(
                                        &theme,
                                        tr!(if has_key {
                                            "tide.key_stored"
                                        } else {
                                            "tide.no_key"
                                        }),
                                        if has_key { theme.success } else { theme.danger },
                                    )),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(card_pill(
                                        &theme,
                                        super::api_style_label(&provider.api_style),
                                        theme.text_secondary,
                                    ))
                                    .child(card_pill(
                                        &theme,
                                        tr!("tide.model_count", count = provider.models.len()),
                                        theme.text_tertiary,
                                    ))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .text_size(sp(11.0))
                                            .text_color(theme.text_tertiary)
                                            .truncate()
                                            .child(provider.base_url.clone()),
                                    ),
                            ),
                    )
                    .child({
                        let trigger = icon_button(
                            SharedString::from(format!("tide-provider-menu-{}", provider.id)),
                            "icons/ellipsis.svg",
                            theme,
                        )
                        .tab_index(0)
                        .focus_visible(|style| style.border_color(theme.accent))
                        .on_click({
                            let menu = menu.clone();
                            move |_, window, cx| menu.open_context_menu(window, cx)
                        });
                        let tide = cx.entity();
                        let id_edit = provider_id.clone();
                        let id_toggle = provider_id_toggle.clone();
                        let id_delete = provider.id.clone();
                        context_menu(
                            trigger,
                            SharedString::from(format!("tide-provider-menu-card-{}", provider.id)),
                            &menu,
                            move |_| {
                                vec![
                                    MenuItem::new(tr!("tide.edit"), {
                                        let tide = tide.clone();
                                        let id = id_edit.clone();
                                        move |window, cx| {
                                            tide.update(cx, |this, cx| {
                                                this.tide_open_edit_wizard(id.clone(), window, cx);
                                            });
                                        }
                                    }),
                                    MenuItem::new(
                                        tr!(if enabled {
                                            "tide.disable"
                                        } else {
                                            "tide.enable"
                                        }),
                                        {
                                            let tide = tide.clone();
                                            let id = id_toggle.clone();
                                            move |_, cx| {
                                                tide.update(cx, |this, cx| {
                                                    this.tide_toggle_enabled(id.clone(), !enabled);
                                                    cx.notify();
                                                });
                                            }
                                        },
                                    ),
                                    MenuItem::Separator,
                                    MenuItem::new(tr!("tide.delete"), {
                                        let tide = tide.clone();
                                        let id = id_delete.clone();
                                        move |_, cx| {
                                            tide.update(cx, |this, cx| {
                                                this.tide_delete_provider(id.clone());
                                                cx.notify();
                                            });
                                        }
                                    }),
                                ]
                            },
                        )
                    }),
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
