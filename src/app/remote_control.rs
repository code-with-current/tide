//! Remote Control — Settings → Remote. Enabling exposes the daemon through
//! the relay with a fresh link every time it is turned on, and the QR code,
//! the clickable link, and the token render directly on the page — there is
//! no separate dialog. The native menu action simply opens this page (and
//! enables Remote Control first when it is off).

use std::cell::RefCell;
use std::sync::Arc;

use qrcode::{Color, QrCode};

use super::*;
use crate::ui::card::{CardButton, CardRow, card_body, card_pill, card_rows, settings_group_head};

#[derive(Default)]
pub(crate) struct RemoteControlState {
    pub(crate) pending: bool,
    /// QR cache keyed by the link it encodes — a fresh enable changes the
    /// link, which recomputes the matrix exactly once.
    qr: RefCell<Option<QrData>>,
}

struct QrData {
    link: String,
    /// Row-major modules (quiet zone included), `true` = dark.
    dark: Arc<Vec<bool>>,
    width: usize,
}

impl Tide {
    /// The menu action: always lands on Settings → Remote, where the QR,
    /// link, and toggle live. When Remote Control is off, enabling happens
    /// first — with a fresh link.
    pub(super) fn toggle_remote_control_action(
        &mut self,
        _: &ToggleRemoteControl,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.state.daemon_exposure.enabled && !self.remote_control.pending {
            self.set_daemon_exposure_enabled(true, cx);
        }
        self.settings_page = Some(SettingsPage::Daemon);
        self.settings_scroll.set_offset(gpui::Point::default());
        window.focus(&self.settings_focus, cx);
        cx.notify();
    }

    pub(super) fn disable_remote_control(&mut self, cx: &mut Context<Self>) {
        if self.remote_control.pending {
            return;
        }
        let mut settings = self.state.daemon_exposure.clone();
        settings.enabled = false;
        self.state.daemon_exposure = settings.clone();
        self.save();
        self.remote_control.pending = true;
        crate::remote_relay::stop();
        let daemon = self.daemon.clone();
        cx.spawn(async move |this, cx| {
            let result = daemon.reconfigure(settings);
            let _ = this.update(cx, |this, cx| {
                this.remote_control.pending = false;
                if let Err(error) = result {
                    this.show_toast(tr!("daemon.restart_failed", error = error.to_string()));
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// The shareable link for the live relay session, if one is running:
    /// `https://remote.tide.codes/<path>#t=<token>&r=<relay-ws>`. The token
    /// rides the URL fragment — never sent to any server.
    pub(crate) fn remote_link(&self) -> Option<SharedString> {
        let path = crate::remote_relay::active_path()?;
        let web_base = std::env::var("TIDE_REMOTE_WEB_URL")
            .unwrap_or_else(|_| "https://remote.tide.codes".into());
        let relay_ws = std::env::var("TIDE_RELAY_URL")
            .unwrap_or_else(|_| crate::remote_relay::DEFAULT_RELAY_URL.into());
        let token = &self.state.daemon_exposure.token;
        let browser_ws = format!("{}/b{}", relay_ws.trim_end_matches('/'), path);
        Some(SharedString::from(format!(
            "{web_base}{path}#t={}&r={}",
            percent_encode(token),
            percent_encode(&browser_ws),
        )))
    }

    /// The Remote page body: one group whose card carries the enable toggle
    /// and — once live — the QR code, the clickable link, and the token.
    pub(super) fn render_remote_section(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let enabled = self.state.daemon_exposure.enabled;
        let pending = self.remote_control.pending;

        let status_label = if pending {
            tr!("daemon.status_restarting")
        } else if enabled {
            tr!("daemon.status_exposed")
        } else {
            tr!("daemon.status_local")
        };
        let status_color = if pending {
            theme.warning
        } else if enabled {
            theme.success
        } else {
            theme.text_tertiary
        };

        let toggle = toggle_switch(
            "remote-enable-toggle",
            enabled,
            pending,
            *theme,
            cx,
            move |this, _, cx| this.set_daemon_exposure_enabled(!enabled, cx),
        );

        let mut rows = vec![
            CardRow::new(tr!("remote_control.enable_toggle"))
                .description(tr!("remote_control.hint"))
                .control(toggle),
        ];

        if enabled && !pending {
            if let Some(link) = self.remote_link() {
                // QR matrix: cached by link so a fresh enable recomputes it
                // once instead of every frame.
                let (dark, width) = {
                    let mut cache = self.remote_control.qr.borrow_mut();
                    if cache.as_ref().is_none_or(|qr| qr.link != link.as_ref()) {
                        if let Ok(code) = QrCode::new(link.as_bytes()) {
                            *cache = Some(QrData {
                                link: link.to_string(),
                                dark: Arc::new(
                                    code.to_colors()
                                        .into_iter()
                                        .map(|color| color == Color::Dark)
                                        .collect(),
                                ),
                                width: code.width(),
                            });
                        }
                    }
                    cache
                        .as_ref()
                        .map(|qr| (Arc::clone(&qr.dark), qr.width))
                        .unwrap_or_default()
                };
                if width > 0 {
                    let cell = px(4.0);
                    let mut qr_grid = div()
                        .id("remote-qr")
                        .w(cell * width as f32)
                        .flex()
                        .flex_wrap()
                        .overflow_hidden();
                    for module in dark.iter() {
                        let mut module_div = div().size(cell);
                        if *module {
                            module_div = module_div.bg(theme.text);
                        }
                        qr_grid = qr_grid.child(module_div);
                    }
                    rows.push(
                        CardRow::new(tr!("remote_control.scan"))
                            .description(tr!("remote_control.hint"))
                            .control(
                                div()
                                    .p(px(8.0))
                                    .rounded(px(10.0))
                                    .bg(theme.canvas)
                                    .child(qr_grid),
                            ),
                    );
                }

                // The clickable link: opens Tide Web in the default browser.
                let open_link = link.to_string();
                let link_control = div()
                    .id("remote-link-open")
                    .tab_index(0)
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .rounded(px(6.0))
                    .px(px(7.0))
                    .py(px(4.0))
                    .text_size(sp(12.5))
                    .text_color(theme.accent)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .hover(|style| style.bg(theme.overlay).underline())
                    .child(icon("icons/arrow-up-right.svg", 11.0, theme.accent))
                    .child(tr!("remote_control.open"))
                    .on_click(move |_, _, cx| cx.open_url(&open_link));
                rows.push(
                    CardRow::new(tr!("remote_control.web_link"))
                        .hint(link.to_string())
                        .control(link_control),
                );
            }
        }

        let mut actions = vec![card_pill(&theme, status_label, status_color).into_any_element()];
        if enabled && !pending {
            actions.push(
                CardButton::new("remote-disable", tr!("remote_control.disable"))
                    .ghost()
                    .render(*theme, cx, |this, _window, cx| {
                        this.disable_remote_control(cx);
                    })
                    .into_any_element(),
            );
        }

        div()
            .child(settings_group_head(
                &theme,
                tr!("remote_control.title"),
                actions,
            ))
            .child(card_body(&theme).child(card_rows(&theme, rows)))
    }
}

/// Percent-encode a query-parameter value.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}
