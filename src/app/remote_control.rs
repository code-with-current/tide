//! Remote Control — Settings → Remote. Enabling exposes the daemon through
//! the relay with a fresh link every time it is turned on, and the QR code,
//! the clickable link, and the token render directly on the page — there is
//! no separate dialog. Remote Control is session-scoped: it is always off
//! when Tide starts, and each enable invalidates every previous link by
//! design. The native menu action simply opens this page (and enables
//! Remote Control first when it is off).

use std::cell::RefCell;
use std::sync::Arc;

use qrcode::{Color, QrCode};

use super::*;
use crate::ui::card::{CardButton, CardRow, card_body, card_pill, card_rows, settings_group_head};

/// Phone cameras expect dark modules on light ground; theme colors would
/// render an inverted code in dark mode, which many scanners reject.
const QR_SURFACE: u32 = 0xFFFFFF;
const QR_MODULE: u32 = 0x1A1A1A;

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

impl RemoteControlState {
    /// The module matrix for `link`, computing and caching it on a cache
    /// miss so repeated frames never re-encode.
    fn matrix(&self, link: &str) -> Option<(Arc<Vec<bool>>, usize)> {
        let mut cache = self.qr.borrow_mut();
        if cache.as_ref().is_none_or(|qr| qr.link != link) {
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
        cache.as_ref().map(|qr| (Arc::clone(&qr.dark), qr.width))
    }
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

    /// The Remote page body: one card whose rows follow the session state —
    /// the enable toggle always, and once live the scan-safe QR code and
    /// the link with copy/open actions.
    pub(super) fn render_remote_section(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let enabled = self.state.daemon_exposure.enabled;
        let pending = self.remote_control.pending;

        let (status_label, status_color) = if pending {
            (tr!("daemon.status_restarting"), theme.warning)
        } else if enabled {
            (tr!("daemon.status_exposed"), theme.success)
        } else {
            (tr!("daemon.status_local"), theme.text_tertiary)
        };

        let status_description = if pending {
            tr!("remote_control.enable_hint_restarting")
        } else if enabled {
            tr!("remote_control.enable_hint_live")
        } else {
            tr!("remote_control.enable_hint_off")
        };

        let toggle = toggle_switch(
            "remote-enable-toggle",
            enabled,
            pending,
            *theme,
            cx,
            move |this, _, cx| this.set_daemon_exposure_enabled(!enabled, cx),
        );

        let mut body = card_body(&theme).child(card_rows(
            theme,
            vec![
                CardRow::new(tr!("remote_control.enable_toggle"))
                    .description(status_description)
                    .control(toggle),
            ],
        ));

        if enabled && !pending {
            if let Some(link) = self.remote_link() {
                if let Some((dark, width)) = self.remote_control.matrix(&link) {
                    body = body.child(self.render_qr_row(theme, dark, width));
                }
                body = body.child(self.render_link_row(theme, &link, cx));
            }
        }

        let mut actions = vec![card_pill(theme, status_label, status_color).into_any_element()];
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
                theme,
                tr!("remote_control.title"),
                actions,
            ))
            .child(body)
    }

    /// The scan row: the QR on its fixed light surface beside scanning
    /// instructions and the security notes. Carries its own divider — custom
    /// rows never land first, the toggle row always sits above them.
    fn render_qr_row(&self, theme: &Theme, dark: Arc<Vec<bool>>, width: usize) -> AnyElement {
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
                module_div = module_div.bg(rgb(QR_MODULE));
            }
            qr_grid = qr_grid.child(module_div);
        }

        div()
            .border_t_1()
            .border_color(theme.border)
            .flex()
            .items_center()
            .gap(px(24.0))
            .py(px(14.0))
            .child(
                div()
                    .flex_none()
                    .p(px(10.0))
                    .rounded(px(10.0))
                    .bg(rgb(QR_SURFACE))
                    .child(qr_grid),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(5.0))
                    .child(
                        div()
                            .text_size(sp(13.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(tr!("remote_control.scan")),
                    )
                    .child(
                        div()
                            .text_size(sp(12.5))
                            .line_height(sp(18.0))
                            .whitespace_normal()
                            .text_color(theme.text_secondary)
                            .child(tr!("remote_control.scan_description")),
                    )
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap(px(5.0))
                            .mt(px(3.0))
                            .text_size(sp(11.0))
                            .line_height(sp(16.0))
                            .text_color(theme.text_tertiary)
                            .child(icon("icons/shield.svg", 11.0, theme.text_tertiary))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .whitespace_normal()
                                    .child(tr!("remote_control.security_hint")),
                            ),
                    ),
            )
            .into_any_element()
    }

    /// The link row: the full URL as a one-line hint on the left, copy and
    /// open actions on the right.
    fn render_link_row(
        &self,
        theme: &Theme,
        link: &SharedString,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let copy_link = link.to_string();
        let copy = CardButton::new("remote-copy-link", tr!("remote_control.copy"))
            .icon("icons/copy.svg")
            .ghost()
            .render(*theme, cx, move |this, _window, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(copy_link.clone()));
                this.show_success_toast(tr!("remote_control.copied"));
            });
        let open_link = link.to_string();
        let open = CardButton::new("remote-open-link", tr!("remote_control.open"))
            .icon("icons/arrow-up-right.svg")
            .render(*theme, cx, move |_this, _window, cx| {
                cx.open_url(&open_link);
            });

        div()
            .border_t_1()
            .border_color(theme.border)
            .flex()
            .items_center()
            .gap(px(24.0))
            .py(px(12.0))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_size(sp(13.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(tr!("remote_control.web_link")),
                    )
                    .child(
                        div()
                            .mt(px(3.0))
                            .min_w_0()
                            .truncate()
                            .text_size(sp(11.0))
                            .text_color(theme.text_tertiary)
                            .child(link.clone()),
                    ),
            )
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(copy)
                    .child(open),
            )
            .into_any_element()
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
