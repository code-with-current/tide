//! The Git settings page: GitHub connection, identities, and per-project
//! attribution state.

use gpui::prelude::*;
use gpui::{FontWeight, Hsla, KeyDownEvent, SharedString, div, px};

use crate::ui::card::{
    CardButton, CardRow, card_body, card_body_flush, card_pill, card_rows, settings_group_head,
    settings_page_header,
};
use crate::ui::{
    ActivationExt,
    chip::{Chip, ChipTone, chip},
    icon, icon_button, motion, toggle_switch,
};
use gpui::{Context, Div, Window};

use crate::app::Tide;
use crate::theme::{Theme, sp};
impl Tide {
    pub(in crate::app) fn render_git_settings(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
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
                        div().flex_1().min_w_0().child(
                            div()
                                .truncate()
                                .text_size(sp(13.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text)
                                .child(SharedString::from(format!("@{}", account.login))),
                        ),
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

        // Footer: connected count + browser connect, only beside existing
        // accounts — the empty state already carries its own Add button, so
        // a second one here would duplicate the same device flow.
        if !connected.is_empty() || !detected.is_empty() {
            body = body.child(
                div()
                    .px(px(20.0))
                    .py(px(8.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_t_1()
                    .border_color(theme.border)
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
        }
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
}

/// A profile tile's icon, from tide's `IDENTITY_ICONS` shortlist. Tide has no
/// user or briefcase mark, so those fall back to the branch glyph.
pub(in crate::app) fn git_identity_icon(name: &str) -> &'static str {
    match name {
        "commit" | "code" => "icons/git-commit-horizontal.svg",
        "server" => "icons/server.svg",
        // branch, user, briefcase, and anything unrecognized.
        _ => "icons/git-branch.svg",
    }
}

pub(in crate::app) fn git_segment_chip(
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

/// Theme-token dot color, port of tide's `identity-style.ts` map. Tide's
/// palette has no chart series, so those tokens borrow the semantic colors.
pub(in crate::app) fn git_dot_color(token: &str, theme: &Theme) -> Hsla {
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
