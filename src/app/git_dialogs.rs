//! The Git settings overlays — port of tide's profile dialog
//! (git.tsx:211-534), import popover (538-593), and the GitHub device-flow
//! dialog (55-209). Each mounts as the goal dialog does: a deferred scrim
//! layer over the settings page, with key contexts carrying Enter/Escape.

use gpui::{AnyElement, KeyBinding, actions};
use protocol::git_settings::{GitDiscoveredCredentialWire, GitProfileWire, GithubAccountWire};

use super::git_settings::{DeviceFlowPhase, GitProfileRequest, ProfileDraft};
use super::settings::{git_dot_color, git_identity_icon, git_segment_chip};
use super::*;

actions!(
    tide_git_dialogs,
    [
        ConfirmGitProfile,
        DismissGitProfile,
        DismissGitImport,
        RetryGitDeviceFlow,
        DismissGitDeviceFlow
    ]
);

const PROFILE_CONTEXT: &str = "GitProfileDialog";
const PROFILE_INPUT_CONTEXT: &str = "GitProfileDialog > TextInput";
const IMPORT_CONTEXT: &str = "GitImportDialog";
const DEVICE_CONTEXT: &str = "GitDeviceFlowDialog";

/// The theme-token dot shortlist, tide's `COLOR_TOKENS` keys.
const GIT_COLORS: [&str; 10] = [
    "keyword",
    "accent",
    "success",
    "warning",
    "destructive",
    "chart1",
    "chart2",
    "chart3",
    "chart4",
    "chart5",
];

/// tide's `IDENTITY_ICON_NAMES`.
const GIT_ICONS: [&str; 6] = ["branch", "commit", "code", "server", "user", "briefcase"];

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("enter", ConfirmGitProfile, Some(PROFILE_CONTEXT)),
        KeyBinding::new(
            "secondary-enter",
            ConfirmGitProfile,
            Some(PROFILE_INPUT_CONTEXT),
        ),
        KeyBinding::new("escape", DismissGitProfile, Some(PROFILE_CONTEXT)),
        KeyBinding::new("escape", DismissGitImport, Some(IMPORT_CONTEXT)),
        KeyBinding::new("escape", DismissGitDeviceFlow, Some(DEVICE_CONTEXT)),
    ]);
}

impl Tide {
    /// The one overlay currently open over the Git settings page, on the
    /// goal dialog's deferred-scrim pattern.
    pub(super) fn render_git_dialogs(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if let Some(request) = self.git_settings.profile_request.take() {
            self.materialize_git_profile(request, window, cx);
        }
        if self.git_settings.profile_dialog.is_some() {
            return self.render_git_profile_dialog(window, cx);
        }
        if self.git_settings.import_open {
            return self.render_git_import_dialog(cx);
        }
        if self.git_settings.device_flow.is_some() {
            return self.render_git_device_flow_dialog(cx);
        }
        None
    }

    /// Build the draft's entities from a staged request — the goal-dialog
    /// materialize step, since `TextInput::new` needs a window.
    fn materialize_git_profile(
        &mut self,
        request: GitProfileRequest,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let editing = request.editing;
        let draft = match (&editing, &request.prefill) {
            (Some(profile), _) => profile_from_edit(profile),
            (None, Some(cred)) => profile_from_prefill(cred),
            (None, None) => empty_profile(),
        };
        // tide's `setSignOpen(editing?.signCommits ?? false)`.
        let sign_open = editing.as_ref().is_some_and(|profile| profile.sign_commits);
        let field = |content: String,
                     placeholder: &'static str,
                     window: &mut Window,
                     cx: &mut Context<Self>|
         -> Entity<crate::input::TextInput> {
            let input = cx.new(|cx| {
                TextInput::new(window, cx)
                    .clear_on_escape()
                    .placeholder(placeholder)
            });
            if !content.is_empty() {
                input.update(cx, |input, cx| input.set_content(content, cx));
            }
            input
        };
        let name = field(draft.name.clone().unwrap_or_default(), "", window, cx);
        let user_name = field(draft.user_name.clone(), "", window, cx);
        let user_email = field(draft.user_email.clone(), "", window, cx);
        let ssh_key = field(
            draft.ssh_key.clone().unwrap_or_default(),
            "git.profile.ssh_key_placeholder",
            window,
            cx,
        );
        let host = field(
            draft.host.clone().unwrap_or_default(),
            "git.profile.host_placeholder",
            window,
            cx,
        );
        let token = field(
            String::new(),
            if editing.is_some() {
                "git.profile.token_placeholder_unchanged"
            } else {
                "git.profile.token_placeholder"
            },
            window,
            cx,
        );
        let signing_key = field(
            draft.signing_key.clone().unwrap_or_default(),
            "git.profile.signing_key_placeholder",
            window,
            cx,
        );
        self.git_settings.profile_dialog = Some(ProfileDraft {
            profile: draft,
            name,
            user_name,
            user_email,
            ssh_key,
            host,
            token,
            signing_key,
            editing: editing.is_some(),
            sign_open,
            github_login: None,
            error: None,
        });
        cx.notify();
    }

    fn close_git_profile(&mut self, cx: &mut Context<Self>) {
        self.git_settings.profile_dialog = None;
        cx.notify();
    }

    /// Port of tide's `save` (git.tsx:326-356): sync the entities into the
    /// profile, validate, dispatch. Upstream awaits the reply before closing;
    /// here the dispatch thread owns the round-trip and the drain's fresh
    /// snapshot refreshes the list, so the dialog closes immediately — a
    /// failed save surfaces through the drain's error row instead of the
    /// dialog. Trimmed token only crosses the wire when non-blank.
    pub(super) fn git_save_profile(&mut self, cx: &mut Context<Self>) {
        let Some(draft) = self.git_settings.profile_dialog.as_mut() else {
            return;
        };
        let name = draft.name.read(cx).content().trim().to_owned();
        let user_name = draft.user_name.read(cx).content().trim().to_owned();
        let user_email = draft.user_email.read(cx).content().trim().to_owned();
        let ssh_key = draft.ssh_key.read(cx).content().trim().to_owned();
        let host = draft.host.read(cx).content().trim().to_owned();
        let token = draft.token.read(cx).content().trim().to_owned();
        let signing_key = draft.signing_key.read(cx).content().trim().to_owned();
        let github_login = draft.github_login.clone();
        let mut profile = draft.profile.clone();
        profile.name = (!name.is_empty()).then_some(name);
        profile.user_name = user_name;
        profile.user_email = user_email;
        if profile.source == "github" {
            profile.auth_type = "token".into();
            profile.ssh_key = None;
            profile.host = Some("github.com".into());
            profile.github_login = github_login;
        } else {
            profile.github_login = None;
            profile.ssh_key = if profile.auth_type == "ssh" && !ssh_key.is_empty() {
                Some(ssh_key)
            } else {
                None
            };
            profile.host = if profile.auth_type == "token" {
                (!host.is_empty()).then_some(host)
            } else {
                None
            };
        }
        profile.signing_key = if profile.sign_commits && !signing_key.is_empty() {
            Some(signing_key)
        } else {
            None
        };
        draft.profile = profile.clone();
        if let Some(error) = draft.validate() {
            draft.error = Some(tr!(error).to_string());
            cx.notify();
            return;
        }
        self.git_settings.profile_dialog = None;
        self.git_dispatch(client::Command::GitIdentitySave {
            profile,
            token: (!token.is_empty()).then_some(token),
        });
        cx.notify();
    }

    /// Port of tide's `pickGitHubAccount` (git.tsx:311-322): prefills the
    /// draft's auth from the account, keeping any field the user already
    /// typed.
    fn git_pick_github_account(&mut self, account: GithubAccountWire, cx: &mut Context<Self>) {
        let Some(draft) = self.git_settings.profile_dialog.as_mut() else {
            return;
        };
        let profile = &mut draft.profile;
        profile.source = "github".into();
        profile.auth_type = "token".into();
        profile.host = Some("github.com".into());
        draft.github_login = Some(account.login.clone());
        if profile.user_name.is_empty() {
            profile.user_name = account.login.clone();
            set_input(&draft.user_name, &account.login, cx);
        }
        if profile.user_email.is_empty() {
            let noreply = match &account.account_id {
                Some(id) => format!("{id}+{}@users.noreply.github.com", account.login),
                None => format!("{}@users.noreply.github.com", account.login),
            };
            profile.user_email = noreply.clone();
            set_input(&draft.user_email, &noreply, cx);
        }
        if profile.name.as_deref().unwrap_or("").is_empty() {
            let label = format!("GitHub · {}", account.login);
            profile.name = Some(label.clone());
            set_input(&draft.name, &label, cx);
        }
        cx.notify();
    }

    /// Import popover → create draft, port of tide's prefill effect
    /// (git.tsx:289-303).
    fn git_import_draft(&mut self, cred: GitDiscoveredCredentialWire, cx: &mut Context<Self>) {
        self.git_settings.import_open = false;
        self.git_settings.profile_request = Some(GitProfileRequest {
            editing: None,
            prefill: Some(cred),
        });
        cx.notify();
    }

    /// Start (or restart) the device flow: bumping the generation kills any
    /// in-flight poll chain before the start request goes out.
    pub(super) fn git_start_device_flow(&mut self, cx: &mut Context<Self>) {
        self.git_settings.device_flow_generation += 1;
        self.git_settings.device_flow = Some(DeviceFlowPhase::Starting);
        self.git_dispatch(client::Command::GithubConnectStart);
        cx.notify();
    }

    fn git_close_device_flow(&mut self, cx: &mut Context<Self>) {
        self.git_settings.device_flow_generation += 1;
        self.git_settings.device_flow = None;
        cx.notify();
    }

    /// One link of the device-flow poll chain (tide's recursive `poll`): sleep
    /// the interval off the UI thread, then dispatch the next poll only if
    /// this dialog generation still owns the flow and the same code is still
    /// waiting. The drain re-schedules on each "pending" reply.
    pub(super) fn git_schedule_device_poll(
        &self,
        device_code: String,
        interval: u64,
        generation: u64,
        cx: &mut Context<Self>,
    ) {
        cx.spawn(async move |tide, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(interval.max(1)))
                .await;
            let _ = tide.update(cx, |tide: &mut Tide, cx| {
                let still_waiting = matches!(
                    &tide.git_settings.device_flow,
                    Some(DeviceFlowPhase::Waiting { device_code: current, .. })
                    if *current == device_code
                ) && tide.git_settings.device_flow_generation == generation;
                if still_waiting {
                    tide.git_dispatch(client::Command::GithubConnectPoll { device_code });
                }
                cx.notify();
            });
        })
        .detach();
    }

    // ── Profile dialog ────────────────────────────────────────────────

    fn render_git_profile_dialog(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = Theme::current(cx);
        let accounts = self
            .git_settings
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.accounts.clone())
            .unwrap_or_default();
        let draft = self.git_settings.profile_dialog.as_ref()?;
        let editing = draft.editing;
        let source_github = draft.profile.source == "github";
        let token_auth = draft.profile.auth_type == "token";
        let live_error = self.git_profile_live_error(cx);
        let error = draft.error.clone();

        let mut body = div()
            .id("git-profile-body")
            .p(px(20.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .overflow_y_scroll();

        // Source segment — only when there are accounts to source from.
        if !accounts.is_empty() {
            let manual_chip = git_segment_chip(
                "git-profile-source-manual",
                tr!("git.profile.manual"),
                !source_github,
                cx,
                |this, _, cx| {
                    if let Some(draft) = this.git_settings.profile_dialog.as_mut() {
                        draft.profile.source = "manual".into();
                        draft.github_login = None;
                    }
                    cx.notify();
                },
            );
            let github_chip = git_segment_chip(
                "git-profile-source-github",
                tr!("git.profile.github"),
                source_github,
                cx,
                |this, _, cx| {
                    if let Some(draft) = this.git_settings.profile_dialog.as_mut() {
                        draft.profile.source = "github".into();
                        draft.profile.auth_type = "token".into();
                        draft.profile.host = Some("github.com".into());
                    }
                    cx.notify();
                },
            );
            body = body.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(manual_chip)
                    .child(github_chip),
            );
        }

        if source_github {
            let mut list = div().flex().flex_col().gap(px(6.0));
            for account in &accounts {
                let selected = draft.github_login.as_deref() == Some(account.login.as_str());
                let account = account.clone();
                list = list.child(
                    div()
                        .id(SharedString::from(format!(
                            "git-profile-account-{}",
                            account.id
                        )))
                        .tab_index(0)
                        .focus_visible(|style| style.border_color(theme.accent))
                        .px(px(12.0))
                        .py(px(8.0))
                        .rounded(px(9.0))
                        .border_1()
                        .border_color(if selected {
                            theme.accent.opacity(0.6)
                        } else {
                            theme.border
                        })
                        .when(selected, |element| element.bg(theme.accent.opacity(0.1)))
                        .when(!selected, |element| {
                            element.hover(|hover| hover.bg(theme.overlay.opacity(0.5)))
                        })
                        .flex()
                        .items_center()
                        .gap(px(9.0))
                        .cursor_default()
                        .child(icon("icons/github.svg", 14.0, theme.text_secondary))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(sp(12.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text)
                                .child(SharedString::from(format!("@{}", account.login))),
                        )
                        .when(selected, |element| {
                            element.child(icon("icons/check.svg", 13.0, theme.accent))
                        })
                        .on_activation(cx, move |this, _, cx| {
                            this.git_pick_github_account(account.clone(), cx);
                        }),
                );
            }
            list = list.child(
                div()
                    .text_size(sp(10.5))
                    .text_color(theme.text_ghost)
                    .child(tr!("git.profile.github_hint")),
            );
            body = body.child(list);
        } else {
            let ssh_chip = git_segment_chip(
                "git-profile-auth-ssh",
                tr!("git.profile.auth_ssh"),
                !token_auth,
                cx,
                |this, _, cx| {
                    if let Some(draft) = this.git_settings.profile_dialog.as_mut() {
                        draft.profile.auth_type = "ssh".into();
                    }
                    cx.notify();
                },
            );
            let token_chip = git_segment_chip(
                "git-profile-auth-token",
                tr!("git.profile.auth_token"),
                token_auth,
                cx,
                |this, _, cx| {
                    if let Some(draft) = this.git_settings.profile_dialog.as_mut() {
                        draft.profile.auth_type = "token".into();
                    }
                    cx.notify();
                },
            );
            body = body.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(ssh_chip)
                    .child(token_chip),
            );
        }

        let field = |id: &'static str,
                     label: String,
                     input: Entity<crate::input::TextInput>,
                     mono: bool,
                     width: f32| {
            div()
                .w(px(width))
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
                .child(TextField::new(id, input).when(mono, |element| {
                    element.font_family(".SystemUIFontMonospaced")
                }))
        };
        body = body
            .child(field(
                "git-profile-name",
                tr!("git.profile.display_name"),
                draft.name.clone(),
                false,
                430.0,
            ))
            .child(
                div()
                    .flex()
                    .gap(px(10.0))
                    .child(field(
                        "git-profile-user-name",
                        tr!("git.profile.user_name"),
                        draft.user_name.clone(),
                        false,
                        210.0,
                    ))
                    .child(field(
                        "git-profile-email",
                        tr!("git.profile.email"),
                        draft.user_email.clone(),
                        false,
                        210.0,
                    )),
            );
        if !source_github && !token_auth {
            body = body.child(field(
                "git-profile-ssh-key",
                tr!("git.profile.ssh_key_path"),
                draft.ssh_key.clone(),
                true,
                430.0,
            ));
        }
        if !source_github && token_auth {
            body = body.child(
                div()
                    .flex()
                    .gap(px(10.0))
                    .child(field(
                        "git-profile-host",
                        tr!("git.profile.host"),
                        draft.host.clone(),
                        true,
                        210.0,
                    ))
                    .child(field(
                        "git-profile-token",
                        tr!("git.profile.token"),
                        draft.token.clone(),
                        true,
                        210.0,
                    )),
            );
        }

        // Commit-signing disclosure.
        let sign_open = draft.sign_open;
        let sign_commits = draft.profile.sign_commits;
        let sign_toggle = div()
            .id("git-profile-sign-toggle")
            .tab_index(0)
            .focus_visible(|style| style.border_color(theme.accent))
            .w(px(120.0))
            .h(px(22.0))
            .px(px(4.0))
            .rounded(px(6.0))
            .flex()
            .items_center()
            .gap(px(4.0))
            .cursor_default()
            .text_size(sp(11.5))
            .text_color(theme.text_tertiary)
            .hover(|element| element.text_color(theme.text))
            .child(icon(
                if sign_open {
                    "icons/chevron-down.svg"
                } else {
                    "icons/chevron-right.svg"
                },
                12.0,
                theme.text_tertiary,
            ))
            .child(tr!("git.profile.signing"))
            .on_activation(cx, |this, _, cx| {
                if let Some(draft) = this.git_settings.profile_dialog.as_mut() {
                    draft.sign_open = !draft.sign_open;
                }
                cx.notify();
            });
        if sign_open {
            let switch = toggle_switch(
                "git-profile-sign-commits",
                sign_commits,
                false,
                theme,
                cx,
                move |this, _, cx| {
                    if let Some(draft) = this.git_settings.profile_dialog.as_mut() {
                        draft.profile.sign_commits = !draft.profile.sign_commits;
                    }
                    cx.notify();
                },
            );
            let mut panel = div()
                .p(px(10.0))
                .rounded(px(9.0))
                .border_1()
                .border_color(theme.border)
                .flex()
                .flex_col()
                .gap(px(10.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(sp(12.0))
                                .text_color(theme.text)
                                .child(tr!("git.profile.sign_commits")),
                        )
                        .child(switch),
                );
            if sign_commits {
                panel = panel.child(field(
                    "git-profile-signing-key",
                    tr!("git.profile.signing_key"),
                    draft.signing_key.clone(),
                    true,
                    410.0,
                ));
            }
            body = body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(sign_toggle)
                    .child(panel),
            );
        } else {
            body = body.child(sign_toggle);
        }

        // Color dots + icon tiles.
        let mut styles_row = div().flex().items_end().justify_between().gap(px(16.0));
        let mut dots = div().flex().items_center().gap(px(5.0));
        for token in GIT_COLORS {
            let color = git_dot_color(token, &theme);
            let selected = draft.profile.color == token;
            dots = dots.child(
                div()
                    .id(SharedString::from(format!("git-profile-color-{token}")))
                    .tab_index(0)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .size(px(15.0))
                    .rounded_full()
                    .flex_none()
                    .bg(color)
                    .when(selected, |element| {
                        element
                            .border_1()
                            .border_color(theme.text.opacity(0.6))
                            .size(px(17.0))
                    })
                    .cursor_default()
                    .on_activation(cx, move |this, _, cx| {
                        if let Some(draft) = this.git_settings.profile_dialog.as_mut() {
                            draft.profile.color = token.into();
                        }
                        cx.notify();
                    }),
            );
        }
        let mut tiles = div().flex().items_center().gap(px(4.0));
        for name in GIT_ICONS {
            let selected = draft.profile.icon == name;
            tiles = tiles.child(
                div()
                    .id(SharedString::from(format!("git-profile-icon-{name}")))
                    .tab_index(0)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .size(px(24.0))
                    .rounded(px(6.0))
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .when(selected, |element| element.bg(theme.accent.opacity(0.15)))
                    .child(icon(
                        git_identity_icon(name),
                        13.0,
                        if selected {
                            theme.accent
                        } else {
                            theme.text_tertiary
                        },
                    ))
                    .on_activation(cx, move |this, _, cx| {
                        if let Some(draft) = this.git_settings.profile_dialog.as_mut() {
                            draft.profile.icon = name.into();
                        }
                        cx.notify();
                    }),
            );
        }
        styles_row = styles_row.child(dots).child(tiles);

        body = body.child(styles_row);
        let save_disabled = live_error.is_some();
        if let Some(error) = error.or(live_error) {
            body = body.child(
                div()
                    .text_size(sp(12.0))
                    .text_color(theme.danger)
                    .child(error),
            );
        }

        let footer = div()
            .px(px(20.0))
            .py(px(12.0))
            .border_t_1()
            .border_color(theme.border)
            .bg(theme.overlay)
            .flex()
            .items_center()
            .justify_end()
            .gap(px(8.0))
            .flex_none()
            .child(
                div()
                    .id("git-profile-cancel")
                    .tab_index(0)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .h(px(26.0))
                    .px(px(12.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .flex()
                    .items_center()
                    .cursor_default()
                    .text_size(sp(12.5))
                    .text_color(theme.text_secondary)
                    .hover(|element| element.bg(theme.overlay))
                    .child(tr!("common.cancel"))
                    .on_activation(cx, |this, _, cx| this.close_git_profile(cx)),
            )
            .child(
                div()
                    .id("git-profile-save")
                    .tab_index(0)
                    .focus_visible(|style| style.border_color(theme.accent))
                    .h(px(26.0))
                    .px(px(12.0))
                    .min_w(px(100.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .when(save_disabled, |element| element.opacity(0.45))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_default()
                    .text_size(sp(12.5))
                    .text_color(theme.text_secondary)
                    .hover(|element| element.bg(theme.overlay))
                    .child(tr!(if editing {
                        "git.profile.save"
                    } else {
                        "git.profile.create"
                    }))
                    .on_activation(cx, |this, _, cx| this.git_save_profile(cx)),
            );

        let card = div()
            .id("git-profile-card")
            .key_context(PROFILE_CONTEXT)
            .on_action(cx.listener(|this, _: &ConfirmGitProfile, _, cx| {
                this.git_save_profile(cx);
            }))
            .on_action(cx.listener(|this, _: &DismissGitProfile, _, cx| {
                this.close_git_profile(cx);
            }))
            .tab_group()
            .tab_stop(false)
            .w_full()
            .max_w(px(520.0))
            .max_h(px(560.0))
            .overflow_hidden()
            .rounded(px(18.0))
            .bg(theme.composer)
            .shadow_xl()
            .flex()
            .flex_col()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .px(px(20.0))
                    .py(px(14.0))
                    .flex()
                    .flex_col()
                    .gap(px(3.0))
                    .child(
                        div()
                            .text_size(sp(15.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .child(tr!(if editing {
                                "git.profile.edit_title"
                            } else {
                                "git.profile.new_title"
                            })),
                    )
                    .child(
                        div()
                            .text_size(sp(11.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("git.profile.subtitle")),
                    ),
            )
            .child(div().mx(px(20.0)).h(px(1.0)).bg(theme.border))
            .child(div().flex().flex_1().min_h_0().child(body))
            .child(footer);

        Some(deferred_scrim("git-profile-layer", card, &theme))
    }

    /// Validation against the live entity contents — the Save button's gate.
    /// The draft's canonical fields lag the entities between syncs, so read
    /// through a copy. Like the goal dialog's live `can_save`, this reads at
    /// Tide notify cadence, not per keystroke.
    fn git_profile_live_error(&self, cx: &Context<Self>) -> Option<String> {
        let draft = self.git_settings.profile_dialog.as_ref()?;
        let mut probe = ProfileDraft {
            profile: draft.profile.clone(),
            name: draft.name.clone(),
            user_name: draft.user_name.clone(),
            user_email: draft.user_email.clone(),
            ssh_key: draft.ssh_key.clone(),
            host: draft.host.clone(),
            token: draft.token.clone(),
            signing_key: draft.signing_key.clone(),
            editing: draft.editing,
            sign_open: draft.sign_open,
            github_login: draft.github_login.clone(),
            error: None,
        };
        probe.profile.user_name = draft.user_name.read(cx).content().to_owned();
        probe.profile.user_email = draft.user_email.read(cx).content().to_owned();
        probe.validate().map(|key| tr!(key).to_string())
    }

    // ── Import popover ────────────────────────────────────────────────

    fn render_git_import_dialog(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = Theme::current(cx);
        let items = self.git_settings.import_list.clone();
        let mut body = div()
            .id("git-import-body")
            .p(px(20.0))
            .flex()
            .flex_col()
            .gap(px(6.0))
            .max_h(px(300.0))
            .overflow_y_scroll();
        match &items {
            None => {
                body = body.child(
                    div()
                        .py(px(22.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap(px(8.0))
                        .text_size(sp(12.5))
                        .text_color(theme.text_tertiary)
                        .child(motion::spin(icon(
                            "icons/loader-circle.svg",
                            14.0,
                            theme.text_tertiary,
                        )))
                        .child(tr!("git.import.loading")),
                );
            }
            Some(list) if list.is_empty() => {
                body = body.child(
                    div()
                        .py(px(22.0))
                        .flex()
                        .justify_center()
                        .text_size(sp(12.5))
                        .text_color(theme.text_tertiary)
                        .child(tr!("git.import.empty")),
                );
            }
            Some(list) => {
                for cred in list {
                    let cred = cred.clone();
                    body = body.child(
                        div()
                            .px(px(12.0))
                            .py(px(8.0))
                            .rounded(px(9.0))
                            .border_1()
                            .border_color(theme.border)
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .child(icon("icons/server.svg", 14.0, theme.text_tertiary))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(sp(12.5))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.text)
                                            .child(cred.username.clone()),
                                    )
                                    .child(
                                        div()
                                            .truncate()
                                            .font_family(".SystemUITMonospaced")
                                            .text_size(sp(10.5))
                                            .text_color(theme.text_tertiary)
                                            .child(cred.host.clone()),
                                    ),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!(
                                        "git-import-row-{}-{}",
                                        cred.username, cred.host
                                    )))
                                    .tab_index(0)
                                    .focus_visible(|style| style.border_color(theme.accent))
                                    .h(px(24.0))
                                    .px(px(9.0))
                                    .rounded(px(6.0))
                                    .border_1()
                                    .border_color(theme.border_strong)
                                    .flex()
                                    .flex_none()
                                    .items_center()
                                    .cursor_default()
                                    .text_size(sp(11.5))
                                    .text_color(theme.text_secondary)
                                    .hover(|element| element.bg(theme.overlay))
                                    .child(tr!("git.import.action"))
                                    .on_activation(cx, move |this, _, cx| {
                                        this.git_import_draft(cred.clone(), cx);
                                    }),
                            ),
                    );
                }
            }
        }
        let card = div()
            .id("git-import-card")
            .key_context(IMPORT_CONTEXT)
            .on_action(cx.listener(|this, _: &DismissGitImport, _, cx| {
                this.git_settings.import_open = false;
                cx.notify();
            }))
            .tab_group()
            .tab_stop(false)
            .w_full()
            .max_w(px(420.0))
            .overflow_hidden()
            .rounded(px(18.0))
            .bg(theme.composer)
            .shadow_xl()
            .flex()
            .flex_col()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .px(px(20.0))
                    .py(px(14.0))
                    .flex()
                    .flex_col()
                    .gap(px(3.0))
                    .child(
                        div()
                            .text_size(sp(15.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .child(tr!("git.import.title")),
                    )
                    .child(
                        div()
                            .text_size(sp(11.5))
                            .text_color(theme.text_tertiary)
                            .child(tr!("git.import.subtitle")),
                    ),
            )
            .child(div().mx(px(20.0)).h(px(1.0)).bg(theme.border))
            .child(body)
            .child(
                div()
                    .px(px(20.0))
                    .py(px(12.0))
                    .border_t_1()
                    .border_color(theme.border)
                    .bg(theme.overlay)
                    .flex()
                    .items_center()
                    .justify_end()
                    .flex_none()
                    .child(
                        div()
                            .id("git-import-close")
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.accent))
                            .h(px(26.0))
                            .px(px(12.0))
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .flex()
                            .items_center()
                            .cursor_default()
                            .text_size(sp(12.5))
                            .text_color(theme.text_secondary)
                            .hover(|element| element.bg(theme.overlay))
                            .child(tr!("common.close"))
                            .on_activation(cx, |this, _, cx| {
                                this.git_settings.import_open = false;
                                cx.notify();
                            }),
                    ),
            );
        Some(deferred_scrim("git-import-layer", card, &theme))
    }

    // ── Device-flow dialog ─────────────────────────────────────────────

    fn render_git_device_flow_dialog(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = Theme::current(cx);
        let phase = self.git_settings.device_flow.clone()?;
        let mut body = div().p(px(20.0)).flex().flex_col().gap(px(14.0));
        match &phase {
            DeviceFlowPhase::Starting => {
                body = body.child(
                    div()
                        .py(px(14.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .text_size(sp(12.5))
                        .text_color(theme.text_tertiary)
                        .child(motion::spin(icon(
                            "icons/loader-circle.svg",
                            14.0,
                            theme.text_tertiary,
                        )))
                        .child(tr!("git.device.starting")),
                );
            }
            DeviceFlowPhase::Waiting {
                user_code,
                verification_uri,
                expires_at,
                ..
            } => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|since| since.as_secs_f64())
                    .unwrap_or(0.0);
                let minutes = ((expires_at - now) / 60.0).round().max(0.0) as u64;
                let display_uri = verification_uri
                    .trim_start_matches("https://")
                    .trim_start_matches("http://")
                    .to_owned();
                let open_uri = verification_uri.clone();
                let copy_code = user_code.clone();
                let step_badge = |n: u32| {
                    div()
                        .size(px(18.0))
                        .rounded_full()
                        .bg(theme.overlay)
                        .border_1()
                        .border_color(theme.border)
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .text_size(sp(10.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_secondary)
                        .child(SharedString::from(n.to_string()))
                };
                body = body
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap(px(9.0))
                            .child(step_badge(1))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .items_center()
                                    .flex_wrap()
                                    .gap(px(4.0))
                                    .child(div().text_size(sp(12.5)).text_color(theme.text).child(
                                        SharedString::from(format!(
                                            "{} {}",
                                            tr!("git.device.step_open"),
                                            display_uri
                                        )),
                                    ))
                                    .child(
                                        div()
                                            .id("git-device-open")
                                            .tab_index(0)
                                            .focus_visible(|style| style.border_color(theme.accent))
                                            .h(px(22.0))
                                            .px(px(8.0))
                                            .rounded(px(6.0))
                                            .border_1()
                                            .border_color(theme.border_strong)
                                            .flex()
                                            .flex_none()
                                            .items_center()
                                            .gap(px(4.0))
                                            .cursor_default()
                                            .text_size(sp(11.5))
                                            .text_color(theme.text_secondary)
                                            .hover(|element| element.bg(theme.overlay))
                                            .child(icon(
                                                "icons/external-link.svg",
                                                11.0,
                                                theme.text_tertiary,
                                            ))
                                            .child(tr!("git.device.open"))
                                            .on_activation(cx, move |_, _, cx| {
                                                cx.open_url(&open_uri);
                                            }),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap(px(9.0))
                            .child(step_badge(2))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.0))
                                    .child(div().text_size(sp(12.5)).text_color(theme.text).child(
                                        tr!("git.device.expires", minutes = minutes.to_string()),
                                    ))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(6.0))
                                            .child(
                                                div()
                                                    .px(px(12.0))
                                                    .py(px(6.0))
                                                    .rounded(px(8.0))
                                                    .border_1()
                                                    .border_color(theme.border)
                                                    .bg(theme.overlay.opacity(0.4))
                                                    .font_family(".SystemUIFontMonospaced")
                                                    .text_size(sp(16.0))
                                                    .text_color(theme.text)
                                                    .child(user_code.clone()),
                                            )
                                            .child(
                                                div()
                                                    .id("git-device-copy")
                                                    .tab_index(0)
                                                    .focus_visible(|style| {
                                                        style.border_color(theme.accent)
                                                    })
                                                    .size(px(26.0))
                                                    .rounded(px(6.0))
                                                    .border_1()
                                                    .border_color(theme.border_strong)
                                                    .flex()
                                                    .flex_none()
                                                    .items_center()
                                                    .justify_center()
                                                    .cursor_default()
                                                    .hover(|element| element.bg(theme.overlay))
                                                    .child(icon(
                                                        "icons/copy.svg",
                                                        12.0,
                                                        theme.text_secondary,
                                                    ))
                                                    .on_activation(cx, move |_, _, cx| {
                                                        cx.write_to_clipboard(
                                                            gpui::ClipboardItem::new_string(
                                                                copy_code.clone(),
                                                            ),
                                                        );
                                                    }),
                                            ),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap(px(9.0))
                            .child(step_badge(3))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .text_size(sp(12.5))
                                    .text_color(theme.text_tertiary)
                                    .child(motion::spin(icon(
                                        "icons/loader-circle.svg",
                                        12.0,
                                        theme.text_tertiary,
                                    )))
                                    .child(tr!("git.device.waiting")),
                            ),
                    );
            }
            DeviceFlowPhase::Denied | DeviceFlowPhase::Expired | DeviceFlowPhase::Error(_) => {
                let message = match &phase {
                    DeviceFlowPhase::Denied => tr!("git.device.denied").to_string(),
                    DeviceFlowPhase::Expired => tr!("git.device.expired").to_string(),
                    DeviceFlowPhase::Error(message) => {
                        tr!("git.device.failed", message = message.clone())
                    }
                    _ => unreachable!(),
                };
                body = body
                    .child(
                        div()
                            .text_size(sp(12.5))
                            .line_height(sp(17.0))
                            .text_color(theme.danger)
                            .child(message),
                    )
                    .child(
                        div()
                            .id("git-device-retry")
                            .tab_index(0)
                            .focus_visible(|style| style.border_color(theme.accent))
                            .h(px(26.0))
                            .px(px(12.0))
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
                            .child(icon("icons/refresh.svg", 11.0, theme.text_tertiary))
                            .child(tr!("git.device.retry"))
                            .on_activation(cx, |this, _, cx| {
                                this.git_start_device_flow(cx);
                            }),
                    );
            }
        }
        let card = div()
            .id("git-device-card")
            .key_context(DEVICE_CONTEXT)
            .on_action(cx.listener(|this, _: &RetryGitDeviceFlow, _, cx| {
                this.git_start_device_flow(cx);
            }))
            .on_action(cx.listener(|this, _: &DismissGitDeviceFlow, _, cx| {
                this.git_close_device_flow(cx);
            }))
            .tab_group()
            .tab_stop(false)
            .w_full()
            .max_w(px(420.0))
            .overflow_hidden()
            .rounded(px(18.0))
            .bg(theme.composer)
            .shadow_xl()
            .flex()
            .flex_col()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .px(px(20.0))
                    .py(px(14.0))
                    .flex()
                    .flex_col()
                    .gap(px(3.0))
                    .child(
                        div()
                            .text_size(sp(15.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text)
                            .child(tr!("git.device.title")),
                    )
                    .child(
                        div()
                            .text_size(sp(11.5))
                            .line_height(sp(15.0))
                            .text_color(theme.text_tertiary)
                            .child(tr!("git.device.description")),
                    ),
            )
            .child(div().mx(px(20.0)).h(px(1.0)).bg(theme.border))
            .child(body)
            .child(
                div().px(px(20.0)).pb(px(16.0)).flex().justify_end().child(
                    div()
                        .id("git-device-cancel")
                        .tab_index(0)
                        .focus_visible(|style| style.border_color(theme.accent))
                        .h(px(26.0))
                        .px(px(12.0))
                        .rounded(px(6.0))
                        .border_1()
                        .border_color(theme.border_strong)
                        .flex()
                        .items_center()
                        .cursor_default()
                        .text_size(sp(12.5))
                        .text_color(theme.text_secondary)
                        .hover(|element| element.bg(theme.overlay))
                        .child(tr!("common.cancel"))
                        .on_activation(cx, |this, _, cx| {
                            this.git_close_device_flow(cx);
                        }),
                ),
            );
        Some(deferred_scrim("git-device-layer", card, &theme))
    }
}

fn set_input(input: &Entity<crate::input::TextInput>, content: &str, cx: &mut Context<Tide>) {
    input.update(cx, |input, cx| input.set_content(content, cx));
}

use crate::ui::modal::deferred_scrim;

// ── Draft constructors, tide's emptyDraft / draftFromProfile / prefill ─

fn empty_profile() -> GitProfileWire {
    GitProfileWire {
        id: uuid::Uuid::new_v4().to_string(),
        name: None,
        user_name: String::new(),
        user_email: String::new(),
        auth_type: "ssh".into(),
        ssh_key: Some(String::new()),
        host: Some("github.com".into()),
        github_login: None,
        sign_commits: false,
        signing_key: Some(String::new()),
        color: "keyword".into(),
        icon: "branch".into(),
        source: "manual".into(),
    }
}

fn profile_from_edit(profile: &GitProfileWire) -> GitProfileWire {
    let mut draft = profile.clone();
    draft.auth_type = if profile.auth_type == "token" {
        "token".into()
    } else {
        "ssh".into()
    };
    draft.source = if profile.source == "github" {
        "github".into()
    } else {
        "manual".into()
    };
    draft
}

fn profile_from_prefill(cred: &GitDiscoveredCredentialWire) -> GitProfileWire {
    let mut draft = empty_profile();
    draft.user_name = cred.username.clone();
    draft.host = Some(cred.host.clone());
    draft.auth_type = "token".into();
    draft.name = Some(format!("{} · {}", cred.username, cred.host));
    draft.color = "accent".into();
    draft.icon = "server".into();
    draft
}

// The signing disclosure opens on edit when the profile signs (tide's
// `setSignOpen(editing?.signCommits ?? false)`); it starts closed on
// creates and prefills.
