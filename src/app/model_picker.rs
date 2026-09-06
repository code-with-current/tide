use super::composer::{
    model_picker_empty_state, model_picker_subtitle, next_picker_highlight, visible_picker_models,
    visible_picker_tabs,
};
use super::*;

/// What picking a model does at one call site of the shared model picker.
///
/// The composer sets the selected session's model; the background-task rows
/// store a `ModelRef` override via `UpdateBackgroundModel`. The actions
/// differ entirely, so the shared renderer takes the action as a parameter
/// and only the rendering — rail, filter, rows, keyboard cursor — is shared.
pub(super) type ModelPickerSelect = Rc<dyn Fn(&mut Tide, ProviderKind, String, &mut Context<Tide>)>;

/// What the optional reset entry ("use the session's model") does: clear the
/// stored override at this call site.
pub(super) type ModelPickerClear = Rc<dyn Fn(&mut Tide, &mut Context<Tide>)>;

/// The per-site inputs of the shared model picker, refreshed every render so
/// the toggle observer — registered once per menu id — always reads the
/// caller's current state. `active` is the row identity the caller considers
/// selected (provider kind plus the full model id, tide ids carrying their
/// `provider/model` prefix).
#[derive(Clone)]
pub(super) struct ModelPickerConfig {
    pub active: Option<(ProviderKind, String)>,
    pub refocus_composer_on_close: bool,
}

/// One addressable step of the picker's keyboard cursor: the optional reset
/// entry comes first, then every visible model row by its list index.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum ModelPickerAction {
    Clear,
    Model(usize),
}

impl Tide {
    /// The shared model picker popover: the provider rail, the filter field,
    /// the model rows with favorite stars, and the keyboard cursor over them.
    /// Every surface that picks a model renders this — the composer sets the
    /// session's model, the background-task rows store a `ModelRef` override —
    /// with the action and the selected row supplied by the caller. The
    /// trigger is the caller's too: `build_trigger` receives whether the menu
    /// is open so it can highlight itself.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn render_model_picker<E>(
        &self,
        menu_id: SharedString,
        config: ModelPickerConfig,
        clear_entry: Option<(SharedString, ModelPickerClear)>,
        on_select: ModelPickerSelect,
        align: MenuAlign,
        build_trigger: impl FnOnce(bool) -> E,
        cx: &mut Context<Self>,
    ) -> AnyElement
    where
        E: ParentElement + Styled + InteractiveElement + IntoElement + 'static,
    {
        let theme = Theme::current(cx);
        // The observer registered below only runs the first time a menu id is
        // seen, so it re-reads this config from the map instead of capturing
        // it; render refreshes the entry every frame.
        self.model_picker_configs
            .borrow_mut()
            .insert(menu_id.clone(), config.clone());

        let search_query = self.model_search.read(cx).content().to_owned();
        let normalized_query = search_query.trim().to_ascii_lowercase();
        let searching = !normalized_query.is_empty();
        let selected_tab = self.model_picker_tab.clone();
        let open_selected_tab = selected_tab.clone();
        let tide_models = self.tide_models.clone();
        let favorites = self.state.favorite_models.clone();
        let weak = cx.entity().downgrade();
        let search = self.model_search.clone();
        let search_focus = search.read(cx).focus_handle(cx);
        let empty_focus = self.model_picker_empty_focus.clone();
        let no_providers = self.model_picker_has_no_providers();
        let tide_loaded = self.tide.loaded;

        let tide_provider_rows = self.tide_provider_rail_rows();
        // The tide rows' ⋯ handle, registered where `self` is available so
        // the popover body only renders it.
        let rail_menu_handle = self.menu_handle("model-rail-tide", cx);

        let handle = {
            let reset_weak = weak.clone();
            let reset_search = search.clone();
            let picker_focus = search_focus.clone();
            let empty_picker_focus = empty_focus.clone();
            let toggle_menu_id = menu_id.clone();
            self.menu_handle_with(menu_id.clone(), cx, move |open, window, cx| {
                // The empty state draws no filter field, so the handle the
                // deferred focus below targets depends on which body opened.
                let mut empty = false;
                let _ = reset_weak.update(cx, |this, cx| {
                    // The config is re-read rather than captured: this
                    // observer is only consulted the first time the menu id
                    // is seen, while the caller refreshes the entry every
                    // render.
                    let config = this
                        .model_picker_configs
                        .borrow()
                        .get(&toggle_menu_id)
                        .cloned();
                    let Some(config) = config else {
                        return;
                    };
                    if open {
                        // The picker's shared follow-up state (reveal target,
                        // tab cycling lock) is whatever this surface picked.
                        this.model_picker_active = config.active.clone();
                        empty = this.model_picker_has_no_providers();
                        // Open onto the configured provider owning the active
                        // model (its id prefix), falling back to the first
                        // rail row; favorites win when the picker was last on
                        // them.
                        this.model_picker_tab = if open_selected_tab == ModelPickerTab::Favorites {
                            ModelPickerTab::Favorites
                        } else {
                            let selected_prefix =
                                this.model_picker_active.as_ref().and_then(|(_, model)| {
                                    model.split_once('/').map(|(prefix, _)| prefix.to_owned())
                                });
                            let rows = this.tide_provider_rail_rows();
                            rows.iter()
                                .find(|(provider_id, _, _, _, _)| {
                                    Some(provider_id.as_str()) == selected_prefix.as_deref()
                                })
                                .or_else(|| rows.first())
                                .map(|(provider_id, _, _, _, _)| {
                                    ModelPickerTab::TideProvider(SharedString::from(
                                        provider_id.as_str(),
                                    ))
                                })
                                .unwrap_or(ModelPickerTab::Favorites)
                        };
                        // Opening re-fetches the provider list, so models
                        // authored since launch appear without a restart.
                        if !this.tide.loaded {
                            this.tide_load_providers();
                        }
                        this.model_picker_highlight = None;
                        reset_search.update(cx, |search, cx| search.clear(cx));
                        this.reveal_selected_picker_model();
                    } else if config.refocus_composer_on_close {
                        let focus_handle = this.composer.read(cx).focus();
                        window.focus(&focus_handle, cx);
                    }
                    cx.notify();
                });
                if open {
                    // The panel is deferred, so its input joins the dispatch
                    // tree only after the deferred draw — same two-frame wait
                    // the menus need before they can take focus. The reveal is
                    // re-issued here too: a parked scroll request resolves
                    // against the viewport bounds of the *previous* paint, so
                    // on the container's first-ever paint it reads a zeroed
                    // viewport, lands wrong, and is consumed. By this frame
                    // the panel has painted real bounds to resolve against.
                    let picker_focus = if empty {
                        empty_picker_focus.clone()
                    } else {
                        picker_focus.clone()
                    };
                    let reveal_weak = reset_weak.clone();
                    window.on_next_frame(move |window, _| {
                        window.on_next_frame(move |window, cx| {
                            window.focus(&picker_focus, cx);
                            let _ = reveal_weak.update(cx, |this, _| {
                                this.reveal_selected_picker_model();
                            });
                        });
                    });
                }
            })
        };

        // Only while the panel is open: this clones the whole tide model
        // catalog, and the closed picker is on the composer's every frame.
        // Built out here rather than in the body so the key handler and the
        // rendered rows index one ordering and cannot disagree about what
        // `enter` selects.
        let available_models = Rc::new(if handle.is_open() {
            visible_picker_models(
                &tide_models,
                &favorites,
                selected_tab.clone(),
                &normalized_query,
            )
        } else {
            Vec::new()
        });
        let scroll = self.model_picker_scroll.clone();
        let scrollbar_state = self.model_picker_scrollbar.clone();

        // The keyboard cursor addresses the optional reset entry first, then
        // every visible model row — one ordering the rendered rows, the
        // scroll, and `enter` all index.
        let has_clear = clear_entry.is_some();
        let actions: Rc<Vec<ModelPickerAction>> = Rc::new(
            has_clear
                .then_some(ModelPickerAction::Clear)
                .into_iter()
                .chain((0..available_models.len()).map(ModelPickerAction::Model))
                .collect(),
        );
        let highlight = self
            .model_picker_highlight
            .filter(|index| *index < actions.len());

        let trigger = build_trigger(handle.is_open());

        popover(trigger, &handle, align, move |popover, _window, _cx| {
            let popover = popover.clone();
            let available_models = available_models.clone();
            let tide_provider_rows = tide_provider_rows.clone();
            let rail_menu_handle = rail_menu_handle.clone();

            if no_providers {
                return model_picker_empty_state(&theme, &empty_focus, popover, weak.clone());
            }

            let mut sidebar = div()
                .w(px(150.0))
                .h_full()
                .flex_none()
                .flex()
                .flex_col()
                .items_stretch()
                .gap(px(2.0))
                .p(px(6.0))
                .rounded_tl(px(12.0))
                .rounded_bl(px(12.0))
                .bg(theme.canvas)
                .border_r_1()
                .border_color(theme.border);

            let favorites_selected = selected_tab == ModelPickerTab::Favorites && !searching;
            let favorite_weak = weak.clone();
            sidebar = sidebar
                .child(
                    div()
                        .id("model-tab-favorites")
                        .h(px(30.0))
                        .px(px(7.0))
                        .rounded(px(7.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .cursor_default()
                        .when(favorites_selected, |element| {
                            element.bg(theme.overlay_strong)
                        })
                        .hover(|element| element.bg(theme.overlay))
                        .child(icon(
                            "icons/star.svg",
                            15.0,
                            if favorites_selected {
                                theme.text
                            } else {
                                theme.text_tertiary
                            },
                        ))
                        .child(
                            div()
                                .text_size(sp(12.0))
                                .text_color(if favorites_selected {
                                    theme.text
                                } else {
                                    theme.text_secondary
                                })
                                .child(tr!("models.favorites")),
                        )
                        .on_click(move |_, _, cx| {
                            let _ = favorite_weak.update(cx, |this, cx| {
                                this.select_model_picker_tab(ModelPickerTab::Favorites, cx);
                            });
                        }),
                )
                .child(div().h(px(1.0)).my(px(3.0)).bg(theme.border));

            // One predicate with the `tab` cycle, so clicking and cycling
            // agree on which tabs are usable.
            let rail_tabs = visible_picker_tabs(&tide_provider_rows);

            // Each configured tide provider is its own rail entry, with
            // its brand mark and its own menu — tide's selector rail.
            for (provider_id, provider_name, logo, accent, _count) in tide_provider_rows.iter() {
                let tab = ModelPickerTab::TideProvider(SharedString::from(provider_id.as_str()));
                let usable = rail_tabs.contains(&tab);
                let selected = selected_tab == tab && !searching;
                let select_weak = weak.clone();
                let row = div()
                    .id(SharedString::from(format!(
                        "model-tab-tide-{}",
                        provider_id
                    )))
                    .h(px(30.0))
                    .pl(px(7.0))
                    .pr(px(6.0))
                    .rounded(px(7.0))
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(7.0))
                    .cursor_default()
                    .when(selected, |element| element.bg(theme.overlay_strong))
                    .when(!usable, |element| element.opacity(0.35))
                    .child(crate::ui::brand::brand_tile(
                        logo, accent, 20.0, 12.0, &theme,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(sp(12.0))
                            .text_color(if selected {
                                theme.text
                            } else {
                                theme.text_secondary
                            })
                            .child(provider_name.clone()),
                    )
                    .when(usable, |element| {
                        let select_weak = select_weak.clone();
                        let tab = tab.clone();
                        element.on_click(move |_, _, cx| {
                            let _ = select_weak.update(cx, |this, cx| {
                                this.select_model_picker_tab(tab.clone(), cx);
                            });
                        })
                    });
                let edit_provider_id = provider_id.clone();
                let manage_weak = weak.clone();
                let popover_close = popover.clone();
                let menu = dropdown_menu(
                    div()
                        .id(SharedString::from(format!(
                            "model-rail-menu-tide-{}",
                            provider_id
                        )))
                        .w(px(20.0))
                        .h(px(20.0))
                        .rounded(px(5.0))
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .cursor_default()
                        .hover(|element| element.bg(theme.overlay))
                        .child(icon("icons/ellipsis.svg", 13.0, theme.text_tertiary)),
                    SharedString::from(format!("model-rail-menu-list-tide-{}", provider_id)),
                    &rail_menu_handle,
                    MenuAlign::BelowRight,
                    move |_| {
                        let weak = manage_weak.clone();
                        let popover_close = popover_close.clone();
                        let edit_provider_id = edit_provider_id.clone();
                        vec![
                            MenuItem::new(tr!("tide.edit"), {
                                let weak = weak.clone();
                                let edit_provider_id = edit_provider_id.clone();
                                let popover_close = popover_close.clone();
                                move |window, cx| {
                                    let _ = weak.update(cx, |this, cx| {
                                        popover_close.close(window, cx);
                                        this.tide_edit_request = Some(edit_provider_id.clone());
                                        cx.notify();
                                    });
                                }
                            }),
                            MenuItem::new(tr!("models.manage_providers"), {
                                let weak = weak.clone();
                                let popover_close = popover_close.clone();
                                move |window, cx| {
                                    let _ = weak.update(cx, |this, cx| {
                                        popover_close.close(window, cx);
                                        this.open_settings_page(SettingsPage::Tide, cx);
                                    });
                                }
                            }),
                            MenuItem::new(tr!("models.refresh_models"), {
                                let weak = weak.clone();
                                move |_window, cx| {
                                    let _ = weak.update(cx, |this, cx| {
                                        this.tide_load_providers();
                                        cx.notify();
                                    });
                                }
                            }),
                        ]
                    },
                );
                sidebar = sidebar.child(
                    div()
                        .id(SharedString::from(format!(
                            "model-rail-tide-row-{}",
                            provider_id
                        )))
                        .flex()
                        .items_center()
                        .gap(px(2.0))
                        .child(row)
                        .child(menu),
                );
            }

            let search_input = div()
                .h(px(52.0))
                .px(px(12.0))
                .pt(px(10.0))
                .pb(px(8.0))
                .flex_none()
                .flex()
                .items_center()
                .child(
                    div()
                        .w_full()
                        .h(px(34.0))
                        .px(px(10.0))
                        .rounded(px(9.0))
                        .bg(theme.raised)
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(icon("icons/search.svg", 15.0, theme.text_secondary))
                        .child(div().flex_1().min_w_0().child(search.clone())),
                );

            // The optional reset entry — the background rows' "use the
            // session's model" — pinned above the list, checked when the
            // caller has nothing selected, and first in the keyboard
            // cursor's ordering.
            let clear_row = clear_entry.as_ref().map(|(label, clear_fn)| {
                let clear_fn = clear_fn.clone();
                let clear_weak = weak.clone();
                let clear_popover = popover.clone();
                div()
                    .id("model-picker-clear")
                    .h(px(44.0))
                    .mx(px(9.0))
                    .mt(px(9.0))
                    .px(px(12.0))
                    .rounded(px(9.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .cursor_default()
                    // Reserved like the model rows, so the keyboard
                    // cursor's ring cannot resize the entry.
                    .border_1()
                    .border_color(gpui::transparent_black())
                    .when(config.active.is_none(), |element| {
                        element.bg(theme.overlay_strong)
                    })
                    .when(highlight == Some(0), |element| {
                        element.bg(theme.overlay).border_color(theme.accent)
                    })
                    .hover(|element| element.bg(theme.overlay))
                    .active(|element| element.opacity(0.85))
                    .child(icon(
                        "icons/corner-down-right.svg",
                        13.0,
                        theme.text_secondary,
                    ))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_size(sp(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text_secondary)
                            .child(label.clone()),
                    )
                    .when(config.active.is_none(), |element| {
                        element.child(icon("icons/check.svg", 12.0, theme.text_secondary))
                    })
                    .on_click(move |_, window, cx| {
                        let _ = clear_weak.update(cx, |this, cx| clear_fn(this, cx));
                        clear_popover.close(window, cx);
                    })
            });

            let mut rows = div()
                .id("model-picker-list")
                .size_full()
                .overflow_y_scroll()
                .track_scroll(&scroll)
                .p(px(9.0));
            if available_models.is_empty() {
                let label = if searching {
                    tr!("models.none_found")
                } else if selected_tab == ModelPickerTab::Favorites {
                    tr!("models.favorite_hint")
                } else if !tide_loaded {
                    tr!("models.loading")
                } else {
                    tr!("models.none_reported")
                };
                rows = rows.child(
                    div()
                        .h_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(sp(12.5))
                        .text_color(theme.text_ghost)
                        .child(label),
                );
            }

            for (row_index, (kind, model)) in available_models.iter().enumerate() {
                let kind = *kind;
                let is_selected = config.active.as_ref() == Some(&(kind, model.id.clone()));
                let is_highlighted = highlight == Some(row_index + usize::from(has_clear));
                let is_favorite = favorites
                    .iter()
                    .any(|favorite| favorite.provider == kind && favorite.model == model.id);
                let model_id = model.id.clone();
                let select_weak = weak.clone();
                let select_fn = on_select.clone();
                let select_popover = popover.clone();
                let favorite_model_id = model.id.clone();
                let favorite_weak = weak.clone();
                let subtitle =
                    model_picker_subtitle(kind, model.sub_provider.as_deref(), Some(model));
                rows = rows.child(
                    div()
                        .id(SharedString::from(format!(
                            "model-row-{}-{}",
                            kind.id(),
                            model.id
                        )))
                        .h(px(58.0))
                        .px(px(12.0))
                        .rounded(px(9.0))
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .cursor_default()
                        // Reserved on every row so highlighting one cannot
                        // resize it and shift the list by a pixel.
                        .border_1()
                        .border_color(gpui::transparent_black())
                        .when(is_selected, |element| element.bg(theme.overlay_strong))
                        // The keyboard cursor reads as a ring rather than a
                        // fill, so it stays legible on the current model's
                        // already-filled row.
                        .when(is_highlighted, |element| {
                            element.bg(theme.overlay).border_color(theme.accent)
                        })
                        .hover(|element| element.bg(theme.overlay))
                        .active(|element| element.opacity(0.85))
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(5.0))
                                        .child(
                                            div()
                                                .truncate()
                                                .text_size(sp(13.0))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .text_color(theme.text)
                                                .child(SharedString::from(model.name.clone())),
                                        )
                                        .when(
                                            kind == ProviderKind::Tide
                                                && model.reasoning_efforts.first().is_some(),
                                            |element| {
                                                element.child(icon(
                                                    "icons/brain.svg",
                                                    12.0,
                                                    theme.accent,
                                                ))
                                            },
                                        )
                                        .when(
                                            kind == ProviderKind::Tide && model.vision,
                                            |element| {
                                                element.child(icon(
                                                    "icons/eye.svg",
                                                    12.0,
                                                    theme.text_tertiary,
                                                ))
                                            },
                                        ),
                                )
                                .child(
                                    div()
                                        .mt(px(4.0))
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .child(icon(
                                            provider_icon(kind),
                                            10.5,
                                            provider_color(&theme, kind).opacity(0.85),
                                        ))
                                        .child(
                                            div()
                                                .truncate()
                                                .text_size(sp(12.5))
                                                .text_color(theme.text_tertiary)
                                                .child(SharedString::from(subtitle)),
                                        ),
                                ),
                        )
                        .child(
                            div()
                                .id(SharedString::from(format!(
                                    "favorite-model-{}-{}",
                                    kind.id(),
                                    model.id
                                )))
                                .w(px(28.0))
                                .h(px(28.0))
                                .rounded(px(6.0))
                                .flex()
                                .items_center()
                                .justify_center()
                                .hover(|element| element.bg(theme.overlay_strong))
                                .child(icon(
                                    if is_favorite {
                                        "icons/star-filled.svg"
                                    } else {
                                        "icons/star.svg"
                                    },
                                    14.0,
                                    if is_favorite {
                                        theme.favorite
                                    } else {
                                        theme.text_ghost
                                    },
                                ))
                                .on_click(move |_, _, cx| {
                                    cx.stop_propagation();
                                    let _ = favorite_weak.update(cx, |this, cx| {
                                        this.toggle_favorite_model(
                                            kind,
                                            favorite_model_id.clone(),
                                            cx,
                                        );
                                    });
                                }),
                        )
                        .on_click(move |_, window, cx| {
                            let _ = select_weak.update(cx, |this, cx| {
                                select_fn(this, kind, model_id.clone(), cx);
                            });
                            select_popover.close(window, cx);
                        }),
                );
            }

            let next_actions = actions.clone();
            let previous_actions = actions.clone();
            let confirm_actions = actions.clone();
            let confirm_models = available_models.clone();
            let confirm_on_select = on_select.clone();
            let confirm_clear = clear_entry.clone();
            let next_weak = weak.clone();
            let previous_weak = weak.clone();
            let next_tab_weak = weak.clone();
            let previous_tab_weak = weak.clone();
            let confirm_weak = weak.clone();
            let confirm_popover = popover.clone();
            div()
                .w(px(460.0))
                .h(px(390.0))
                .rounded(px(13.0))
                .overflow_hidden()
                .border_1()
                .border_color(theme.border_strong)
                .bg(theme.raised)
                .shadow_lg()
                .flex()
                // The filter field keeps focus and the selected row is only
                // drawn, never focused — the same split Zed's picker uses.
                // These arrive as actions bound to `TideMenu > TextInput`,
                // which is the only way to claim a key out from under a
                // focused text field.
                .on_action(move |_: &SelectNextEntry, _, cx| {
                    let _ = next_weak.update(cx, |this, cx| {
                        this.move_model_picker_highlight("down", &next_actions, cx);
                    });
                })
                .on_action(move |_: &SelectPreviousEntry, _, cx| {
                    let _ = previous_weak.update(cx, |this, cx| {
                        this.move_model_picker_highlight("up", &previous_actions, cx);
                    });
                })
                .on_action(move |_: &SelectNextTab, _, cx| {
                    let _ = next_tab_weak.update(cx, |this, cx| {
                        this.cycle_model_picker_tab("down", cx);
                    });
                })
                .on_action(move |_: &SelectPreviousTab, _, cx| {
                    let _ = previous_tab_weak.update(cx, |this, cx| {
                        this.cycle_model_picker_tab("up", cx);
                    });
                })
                .on_action(move |_: &ConfirmEntry, window, cx| {
                    let _ = confirm_weak.update(cx, |this, cx| {
                        this.choose_highlighted_model(
                            &confirm_actions,
                            &confirm_models,
                            &confirm_on_select,
                            confirm_clear.as_ref(),
                            cx,
                        );
                    });
                    confirm_popover.close(window, cx);
                    window.refresh();
                })
                .child(sidebar)
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .rounded_tr(px(12.0))
                        .rounded_br(px(12.0))
                        .bg(theme.surface)
                        .child(search_input)
                        // The reset entry is pinned above the scroll list
                        // and shares its keyboard cursor with the rows, so
                        // `up` from the first model lands on it and
                        // `enter` clears the override.
                        .when_some(clear_row, |element, clear_row| element.child(clear_row))
                        .child(
                            div()
                                .flex_1()
                                .min_h_0()
                                .relative()
                                .child(rows)
                                .child(scrollbar::vertical(&scroll, &scrollbar_state)),
                        ),
                )
                .into_any_element()
        })
    }

    /// Move the picker's drawn selection. Nothing is focused: the filter field
    /// keeps focus so typing continues to narrow the list.
    fn move_model_picker_highlight(
        &mut self,
        key: &str,
        actions: &[ModelPickerAction],
        cx: &mut Context<Self>,
    ) {
        let current = self
            .model_picker_highlight
            .filter(|index| *index < actions.len());
        let Some(next) = next_picker_highlight(current, actions.len(), key) else {
            return;
        };
        self.model_picker_highlight = Some(next);
        // Only a model row has a place in the scroll list to reveal; the
        // pinned reset entry is always on screen.
        if let ModelPickerAction::Model(row) = actions[next] {
            self.model_picker_scroll.scroll_to_item(row);
        }
        cx.notify();
    }

    /// Step the sidebar rail to the adjacent usable tab, wrapping at both
    /// ends. `tab`/`shift-tab` land here from under the focused filter field,
    /// the same route the arrows take. A live query hides which tab is
    /// selected and searches across all of them, so cycling waits until the
    /// field is cleared.
    fn cycle_model_picker_tab(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self.model_search.read(cx).content().trim().is_empty() {
            return;
        }
        let tabs = visible_picker_tabs(&self.tide_provider_rail_rows());
        let current = tabs.iter().position(|tab| *tab == self.model_picker_tab);
        let Some(next) = next_picker_highlight(current, tabs.len(), key) else {
            return;
        };
        self.select_model_picker_tab(tabs[next].clone(), cx);
    }

    /// Bring the current model's row into view whenever the picker shows the
    /// unfiltered list — on open, on a cleared query, and on tab switches.
    ///
    /// The request parks in the scroll handle until the row list next paints,
    /// so it may be issued from the open toggle before the deferred panel
    /// exists, and a tab whose models are still loading reveals the row once
    /// they arrive. Without a row to reveal it falls back to the top, so a
    /// scroll offset from an earlier open never leaks into a fresh list.
    ///
    /// The target is the surface that opened the picker, recorded when its
    /// menu toggled open: the session's model for the composer, the stored
    /// override for a background row.
    pub(super) fn reveal_selected_picker_model(&self) {
        let (provider, selected_model) = match self.model_picker_active.clone() {
            Some((kind, model)) => (kind, Some(model)),
            None => (ProviderKind::default(), None),
        };
        let index = visible_picker_models(
            &self.tide_models,
            &self.state.favorite_models,
            self.model_picker_tab.clone(),
            "",
        )
        .iter()
        .position(|(kind, model)| {
            *kind == provider && selected_model.as_deref() == Some(model.id.as_str())
        })
        .unwrap_or(0);
        self.model_picker_scroll.scroll_to_item(index);
    }

    /// Take the action the selection is on, defaulting to the first so `enter`
    /// works the moment the panel opens.
    fn choose_highlighted_model(
        &mut self,
        actions: &[ModelPickerAction],
        models: &[(ProviderKind, ProviderModel)],
        on_select: &ModelPickerSelect,
        clear: Option<&(SharedString, ModelPickerClear)>,
        cx: &mut Context<Self>,
    ) {
        match actions.get(self.model_picker_highlight.unwrap_or(0)) {
            Some(ModelPickerAction::Clear) => {
                let Some((_, clear)) = clear else {
                    return;
                };
                clear(self, cx);
            }
            Some(ModelPickerAction::Model(index)) => {
                let Some((kind, model)) = models.get(*index) else {
                    return;
                };
                let (kind, model_id) = (*kind, model.id.clone());
                on_select(self, kind, model_id, cx);
            }
            None => {}
        }
    }
}
