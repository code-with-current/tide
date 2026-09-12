//! The Daemon settings page: background jobs, remote control exposure, and
//! the daemon lifecycle controls.

use gpui::prelude::*;
use gpui::{AnyElement, Context, FontWeight, SharedString, div, px};

use crate::app::Tide;
use crate::theme::{Theme, sp};
use crate::ui::card::settings_page_header;

impl Tide {
    pub(in crate::app) fn render_daemon_settings(&self, cx: &mut Context<Self>) -> AnyElement {
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

    pub(in crate::app) fn set_daemon_exposure_enabled(
        &mut self,
        enabled: bool,
        cx: &mut Context<Self>,
    ) {
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
        // Exposure changes only start/stop the externally bound listener; the
        // desktop's own connection is untouched, so active sessions are
        // never a reason to refuse. Disabled→disabled touches no listener at
        // all and is a pure settings save.
        if !settings.enabled && !self.state.daemon_exposure.enabled {
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
}
