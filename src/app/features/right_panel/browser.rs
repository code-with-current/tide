//! The Browser surface: lazy webview construction and pending-URL routing.

use gpui::prelude::*;

use crate::app::Tide;

use crate::app::RightPanelSurface;
use gpui::Entity;
use gpui::Window;
use std::collections::HashSet;
use uuid::Uuid;
impl Tide {
    pub(in crate::app) fn ensure_right_panel_browser(
        &mut self,
        browser_id: Uuid,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<crate::browser::BrowserView> {
        let browser = if let Some(browser) = self.right_panel_browsers.get(&browser_id) {
            browser.clone()
        } else {
            let browser = cx.new(|cx| crate::browser::BrowserView::new(window, cx));
            // Tab titles and toolbar state live on the browser entity; the
            // panel chrome re-renders when they move.
            cx.observe(&browser, |_, _, cx| cx.notify()).detach();
            self.right_panel_browsers
                .insert(browser_id, browser.clone());
            browser
        };
        self.navigate_pending_browser_url(browser_id, &browser, cx);
        browser
    }

    /// Flush a URL parked for this tab — a mermaid diagram's Preview — now
    /// that the view it navigates exists. Called from the surface's renderer
    /// because that is the only place the browser entity is created.
    pub(in crate::app) fn navigate_pending_browser_url(
        &mut self,
        browser_id: Uuid,
        browser: &Entity<crate::browser::BrowserView>,
        cx: &mut Context<Self>,
    ) {
        if let Some(url) = self.right_panel_pending_browser_urls.remove(&browser_id) {
            browser.update(cx, |view, cx| view.navigate_to_url(url, cx));
        }
        // Agent ops parked while the view did not exist ride the same
        // flush: the navigation that just started parks them in the view's
        // load-waiter queue, so each answers once the page it targeted
        // settles (never against the pre-navigation document).
        for op in self
            .right_panel_pending_agent_ops
            .remove(&browser_id)
            .unwrap_or_default()
        {
            browser.update(cx, |view, cx| view.agent_eval(op.script, op.reply, cx));
        }
    }

    /// Drop browser views whose tab no longer exists in any session.
    pub(in crate::app) fn retain_right_panel_browsers(&mut self) {
        let retained_browser_ids = self
            .right_panel_surfaces
            .iter()
            .filter_map(RightPanelSurface::browser_id)
            .chain(self.right_panel_session_states.values().flat_map(|state| {
                state
                    .surfaces
                    .iter()
                    .filter_map(RightPanelSurface::browser_id)
            }))
            .collect::<HashSet<_>>();
        self.right_panel_browsers
            .retain(|browser_id, _| retained_browser_ids.contains(browser_id));
        // Pending navigations for tabs that no longer exist have nothing left
        // to wait for.
        self.right_panel_pending_browser_urls
            .retain(|browser_id, _| retained_browser_ids.contains(browser_id));
        // Parked agent ops for tabs that no longer exist have nothing left
        // to wait for either: dropping them drops each reply sender, which
        // the engine side reads as "surface went away" instead of a hang.
        self.right_panel_pending_agent_ops
            .retain(|browser_id, _| retained_browser_ids.contains(browser_id));
    }
}
