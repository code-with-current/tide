//! The pending permission card — tide's PermissionCard anatomy. While the
//! selected session's runtime waits on a driver permission ask
//! (`SessionRuntime::pending_permission`), the pane renders this card as a
//! transient bottom section under the row list — v2's inline placement of the
//! state the legacy pane renders above the composer (`composer.rs`'s
//! `render_permission`).
//!
//! The card answers only what [`PendingPermission`] carries: title, detail,
//! and the driver's own option set. Option ids vary per driver (tide sends
//! allow/always/deny, claude allow/deny, codex accept/acceptForSession/
//! decline, opencode once/always/reject, ACP arbitrary), so the button row is
//! derived from the options' `allow` flags — the first allow option primes the
//! primary Allow button, later allow options fold into the attached chevron
//! menu (tide's split-button "Always allow"), and deny options render as the
//! danger Reject button. Every click routes through the one `pub(super)`
//! response path the legacy card drives (`Tide::respond_permission`), which
//! forwards the option id to the driver untouched. Tide's "Switch to Full
//! Mode" escalation has no tide-side analog — `driver.respond` takes no mode
//! parameter and no driver sends an escalation option — so the menu honestly
//! lists only the extra allow options the driver sent.
//!
//! The countdown is wired but dormant: `PendingPermission` carries no
//! deadline today, so [`permission_deadline`] answers `None` and the
//! "expires in Ns" line never renders. When a driver starts sending one, map
//! it there and the line lights up on the stream pump's existing cadence —
//! no further wiring. Risk tiers are likewise absent from the model, so the
//! badge is a plain "approval needed" chip rather than an invented tier.

use crate::model::{PendingPermission, PermissionOption};
use crate::theme::{Theme, sp};
use crate::ui::icon;
use crate::ui::menu::{ContextMenuHandle, MenuAlign, MenuItem, dropdown_menu};
use gpui::prelude::*;
use gpui::{AnyElement, Div, FontWeight, SharedString, div, px};
use std::sync::Arc;

// ── The folds, pure ──────────────────────────────────────────────────────────

/// The countdown's whole-second answer for a deadline: `None` when the ask
/// carries no deadline, otherwise the seconds left clamped at zero — an
/// expired ask reads "0s", never a growing negative.
pub(crate) fn seconds_left(timeout_at: Option<u64>, now: u64) -> Option<String> {
    timeout_at.map(|deadline| format!("{}s", deadline.saturating_sub(now)))
}

/// The deadline the card counts down against; see the module doc for why this
/// is an honest `None` today.
pub(crate) fn permission_deadline(_permission: &PendingPermission) -> Option<u64> {
    None
}

/// Where each option renders; see [`permission_layout`].
pub(crate) struct PermissionLayout<'a> {
    /// The first allow option — the split button's primary Allow click.
    pub allow: Option<&'a PermissionOption>,
    /// Later allow options — the attached chevron menu's entries.
    pub allow_more: Vec<&'a PermissionOption>,
    /// Deny options, in send order — the first styles as the Reject button,
    /// any further ones render as plain bordered buttons so nothing the
    /// driver sent is unreachable.
    pub denies: Vec<&'a PermissionOption>,
}

/// Split the option set into the card's three render slots, by each option's
/// own `allow` flag and in send order — never by hard-coded ids, which vary
/// per driver. Pure so the split stays unit-testable without a window.
pub(crate) fn permission_layout(options: &[PermissionOption]) -> PermissionLayout<'_> {
    let mut allow = None;
    let mut allow_more = Vec::new();
    let mut denies = Vec::new();
    for option in options {
        if option.allow {
            if allow.is_none() {
                allow = Some(option);
            } else {
                allow_more.push(option);
            }
        } else {
            denies.push(option);
        }
    }
    PermissionLayout {
        allow,
        allow_more,
        denies,
    }
}

// ── Renderer ────────────────────────────────────────────────────────────────

/// One response: hand the clicked option's id to the app's one permission
/// path (`Tide::respond_permission`). Built where the view context lives
/// (`list.rs`); the card only threads it through.
pub(crate) type PermissionRespond = Arc<dyn Fn(&str, &mut gpui::Window, &mut gpui::App) + 'static>;

/// The split button's chevron segment: an 18px attached trigger opening the
/// extra-allow-options menu — the wizard's ⋯ dropdown pattern, grown upward
/// because the card sits at the pane's bottom edge (the placement machinery
/// flips it back if the window runs out of room above).
fn render_allow_more_segment(
    entries: &[(String, String)],
    id: &str,
    menu_handle: &ContextMenuHandle,
    theme: &Theme,
    respond: &PermissionRespond,
) -> AnyElement {
    let respond = Arc::clone(respond);
    let entries = entries.to_vec();
    dropdown_menu(
        div()
            .id(SharedString::from(format!("{id}-more")))
            .w(px(18.0))
            .h(px(28.0))
            .rounded_r(px(7.0))
            .border_1()
            .border_l_0()
            .border_color(theme.warning.opacity(0.34))
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .hover(|element| element.bg(theme.overlay))
            .active(|element| element.opacity(0.8))
            .child(icon("icons/chevron-down.svg", 10.0, theme.text_secondary)),
        SharedString::from(format!("{id}-more-list")),
        menu_handle,
        MenuAlign::AboveRight,
        move |_| {
            entries
                .iter()
                .map(|(option_id, label)| {
                    let respond = Arc::clone(&respond);
                    let option_id = option_id.clone();
                    MenuItem::new(label.clone(), move |window, cx| {
                        respond(&option_id, window, cx)
                    })
                })
                .collect()
        },
    )
}

/// The primary Allow click: bordered, check icon, warning-tinted like the
/// card it belongs to. `attached` shapes the right corners for the chevron
/// segment that follows.
fn render_allow_button(
    option: &PermissionOption,
    id: &str,
    attached: bool,
    theme: &Theme,
    respond: &PermissionRespond,
) -> gpui::Stateful<Div> {
    let option_id = option.id.clone();
    let respond = Arc::clone(respond);
    div()
        .id(SharedString::from(format!("{id}-allow")))
        .h(px(28.0))
        .px(px(13.0))
        .rounded_l(px(7.0))
        .when(!attached, |button| button.rounded_r(px(7.0)))
        .border_1()
        .border_color(theme.warning.opacity(0.34))
        .bg(theme.warning.opacity(0.06))
        .flex()
        .items_center()
        .gap(px(5.0))
        .cursor_default()
        .text_size(sp(12.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme.text)
        .hover(|element| element.bg(theme.warning.opacity(0.12)))
        .active(|element| element.opacity(0.8))
        .child(icon("icons/check.svg", 12.0, theme.warning))
        .child(SharedString::from(option.label.clone()))
        .on_click(move |_, window, cx| respond(&option_id, window, cx))
}

/// One deny click: the first styles as the danger Reject button, further ones
/// as plain bordered buttons (no driver sends more than one today, but the
/// row degrades honestly if one does).
fn render_deny_button(
    option: &PermissionOption,
    id: &str,
    primary: bool,
    theme: &Theme,
    respond: &PermissionRespond,
) -> gpui::Stateful<Div> {
    let option_id = option.id.clone();
    let respond = Arc::clone(respond);
    div()
        .id(SharedString::from(id))
        .h(px(28.0))
        .px(px(13.0))
        .rounded(px(7.0))
        .border_1()
        .border_color(theme.border)
        .flex()
        .items_center()
        .cursor_default()
        .text_size(sp(12.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(if primary {
            theme.danger
        } else {
            theme.text_secondary
        })
        .hover(|element| element.bg(theme.overlay))
        .active(|element| element.opacity(0.8))
        .child(SharedString::from(option.label.clone()))
        .on_click(move |_, window, cx| respond(&option_id, window, cx))
}

/// The whole card: warning rail, header (alert icon + title + "approval
/// needed" chip + countdown when a deadline exists), the mono detail
/// viewport, and the action row — tide's placement with rejects left, the
/// allow split button right. `countdown` is the precomposed line (from
/// [`seconds_left`] + the `permission.expires_in` string); `menu_handle` is
/// the shared pane-scoped dropdown handle the chevron segment toggles.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_permission_card(
    title: &str,
    detail: &str,
    options: &[PermissionOption],
    countdown: Option<&str>,
    id: &str,
    menu_handle: &ContextMenuHandle,
    theme: &Theme,
    respond: &PermissionRespond,
) -> Div {
    let layout = permission_layout(options);

    // The header line: identity first, chip beside it, countdown at the far
    // right — tide's single-line shape.
    let mut header = div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .child(icon("icons/alert.svg", 13.0, theme.warning))
        .child(
            div()
                .text_size(sp(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text)
                .child(SharedString::from(title)),
        )
        .child(
            div()
                .px(px(5.0))
                .rounded(px(4.0))
                .bg(theme.warning.opacity(0.12))
                .text_size(sp(9.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.warning)
                .child(tr!("permission.approval_needed")),
        );
    if let Some(line) = countdown {
        header = header.child(
            div()
                .ml_auto()
                .flex_none()
                .text_size(sp(11.0))
                .text_color(theme.text_secondary)
                .child(SharedString::from(line)),
        );
    }

    // Rejects left, spacer, allow split button right — tide's between layout.
    let mut actions = div().mt(px(10.0)).flex().items_center().gap(px(8.0));
    for (ix, option) in layout.denies.iter().enumerate() {
        actions = actions.child(render_deny_button(
            option,
            &format!("{id}-deny-{ix}"),
            ix == 0,
            theme,
            respond,
        ));
    }
    if let Some(allow) = layout.allow {
        let menu_entries: Vec<(String, String)> = layout
            .allow_more
            .iter()
            .map(|option| (option.id.clone(), option.label.clone()))
            .collect();
        let attached = !menu_entries.is_empty();
        let mut allow_group = div().flex().items_center();
        allow_group = allow_group.child(render_allow_button(allow, id, attached, theme, respond));
        if attached {
            allow_group = allow_group.child(render_allow_more_segment(
                &menu_entries,
                id,
                menu_handle,
                theme,
                respond,
            ));
        }
        actions = actions.child(div().flex_1()).child(allow_group);
    }

    div()
        .w_full()
        .flex()
        .overflow_hidden()
        .rounded(px(12.0))
        .border_1()
        .border_color(theme.warning.opacity(0.5))
        .bg(theme.composer)
        .shadow_md()
        // The left warning rail: a stretch child beside the padded body, so
        // it always matches the card's painted height.
        .child(div().w(px(3.0)).flex_none().bg(theme.warning))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .px(px(16.0))
                .py(px(12.0))
                .flex()
                .flex_col()
                .child(header)
                .child(
                    div()
                        .id(SharedString::from(format!("{id}-detail")))
                        .mt(px(8.0))
                        .max_h(px(200.0))
                        .overflow_y_scroll()
                        .p(px(8.0))
                        .rounded(px(7.0))
                        .bg(theme.raised)
                        .font_family(crate::md::render::MONO_FAMILY)
                        .text_size(sp(11.0))
                        .line_height(sp(15.0))
                        .text_color(theme.text_secondary)
                        .whitespace_normal()
                        .child(SharedString::from(detail)),
                )
                .child(actions),
        )
}
