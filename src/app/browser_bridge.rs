//! The app-side half of the agentic browser: the [`BrowserBackend`]
//! installed at Tide boot that routes the engine's `browser_*` tool calls
//! onto the live right-panel webview.
//!
//! Threading contract (the design's): [`BrowserBackend::invoke`] runs on
//! the engine thread and blocks on a plain mpsc receiver with a timeout;
//! the main thread only ever spawns, never blocks back on the engine.
//! The GPUI handles the hop needs — `WeakEntity<Tide>`, `AsyncApp`, the
//! foreground executor, together the trio `crate::browser::Deferred`
//! wraps for webview callbacks — are `!Send` by construction (GPUI is
//! thread-affine), so they cannot sit inside the `Send + Sync` backend.
//! Instead the drain task spawned at boot captures them and the backend
//! holds only a `smol` channel sender, whose `send` from the engine
//! thread wakes that task on the main-thread executor — the same hop,
//! reached from the other side.

use std::sync::Arc;
use std::time::Duration;

use gpui::{Context, Entity};
use serde_json::{Value, json};
use smol::channel::Sender;
use uuid::Uuid;

use tools::{BrowserBackend, set_shared_browser_backend};

use super::{RightPanelSurface, Tide};
use crate::browser::BrowserView;

/// How long the engine thread waits for a navigation to settle before
/// giving up — page loads are the slowest op by far, so navigations get
/// the long leash.
const NAVIGATE_TIMEOUT: Duration = Duration::from_secs(20);
/// Every other op — evals and captures against an already-settled page.
const OP_TIMEOUT: Duration = Duration::from_secs(10);

/// Design v1: the agent drives real web pages only. The omnibox resolves
/// scheme-less text into searches for humans; the tool contract stays
/// strict so nothing but http/https ever loads from an agent call.
pub(crate) fn is_agent_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Read `{ viewport: { w, h } }` out of a `__tideSnapshot` payload.
/// Task 5's page-fraction scrolling starts from here; the read tools
/// pass the snapshot through verbatim without consulting it.
#[allow(dead_code)]
pub(crate) fn viewport_of(snapshot: &Value) -> Option<(u32, u32)> {
    let viewport = snapshot.get("viewport")?;
    Some((
        viewport.get("w")?.as_u64()? as u32,
        viewport.get("h")?.as_u64()? as u32,
    ))
}

/// What `browser_navigate` answers with once the page it opened settles:
/// the fresh snapshot, the same payload `browser_get_state` returns.
const SNAPSHOT_SCRIPT: &str = "window.__tideSnapshot()";

/// The reply when no browser surface exists for a read op — the agent's
/// cue to navigate first.
const NO_SURFACE: &str =
    "no browser surface is open - call browser_navigate to open the page first";

/// One parked agent eval: the script to run once the view exists, and
/// the channel its answer must reach. The auto-open path stores these
/// beside [`Tide::right_panel_pending_browser_urls`] until the surface's
/// first render materializes the view.
pub(crate) struct PendingAgentOp {
    pub(crate) script: String,
    pub(crate) reply: std::sync::mpsc::Sender<Result<String, String>>,
}

/// One engine-thread request plus its reply channel, crossing to the
/// main thread through the `smol` channel.
struct BrowserBridgeOp {
    request: Value,
    reply: std::sync::mpsc::Sender<Result<String, String>>,
}

/// The process-wide browser backend: a wake-up handle for the
/// main-thread drain task. `Send + Sync` because it holds nothing but
/// the channel — every GPUI handle stays on the far side.
#[derive(Debug)]
pub struct AppBrowserBackend {
    ops: Sender<BrowserBridgeOp>,
}

impl BrowserBackend for AppBrowserBackend {
    fn enabled(&self) -> bool {
        // No gating source exists yet (design v1): the settings toggle is
        // out of scope, so an installed bridge always answers.
        true
    }

    fn invoke(&self, request: &Value) -> Result<Value, String> {
        let op = request
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let timeout = if op == "navigate" {
            NAVIGATE_TIMEOUT
        } else {
            OP_TIMEOUT
        };
        let (reply, answers) = std::sync::mpsc::channel();
        // `try_send` on an unbounded channel never blocks — it only fails
        // when the receiver is gone, which is exactly the shutdown case.
        self.ops
            .try_send(BrowserBridgeOp {
                request: request.clone(),
                reply,
            })
            .map_err(|_| "the browser surface is shutting down".to_owned())?;
        match answers.recv_timeout(timeout) {
            Ok(Ok(text)) => finish(op, text),
            Ok(Err(error)) => Err(error),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(format!(
                "the browser {op} call timed out after {} s",
                timeout.as_secs()
            )),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("the browser surface went away before the page settled".to_owned())
            }
        }
    }
}

/// The reply is the serializer's JSON string — except a screenshot's,
/// which is the base64 PNG alone. Wrap that so the tool side always
/// receives parseable JSON.
fn finish(op: &str, text: String) -> Result<Value, String> {
    if op == "screenshot" {
        return Ok(json!({ "image": text, "mime_type": "image/png" }));
    }
    serde_json::from_str(&text)
        .map_err(|_| format!("the browser {op} call returned a malformed result"))
}

/// Install the process-wide browser backend and start the main-thread
/// drain task. Called once from Tide construction — from the app crate,
/// because the hop needs GPUI handles only this crate can name. Linux
/// never calls it, so browser tool calls there fail cleanly per the
/// seam's no-backend test.
pub fn install_browser_backend(cx: &mut Context<Tide>) {
    let (ops, pending) = smol::channel::unbounded::<BrowserBridgeOp>();
    set_shared_browser_backend(Some(Arc::new(AppBrowserBackend { ops })));
    cx.spawn(async move |tide, cx| {
        while let Ok(op) = pending.recv().await {
            // A failed update means the Tide entity is gone: the op's
            // reply sender dropped with it, so the engine's recv turns
            // Disconnected into an error — never a hang.
            let _ = tide.update(cx, |tide, cx| tide.route_browser_op(cx, op));
        }
    })
    .detach();
}

impl Tide {
    /// Route one browser op onto the live right-panel surface. Runs on
    /// the main thread inside a Tide update; every arm hands `reply` to
    /// exactly one view call that answers it exactly once — the same
    /// contract [`BrowserView::agent_eval`] keeps for its parked ops.
    fn route_browser_op(&mut self, cx: &mut Context<Self>, op: BrowserBridgeOp) {
        let BrowserBridgeOp { request, reply } = op;
        let name = request
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let args = request.get("args").cloned().unwrap_or(Value::Null);
        match name {
            "navigate" => self.browser_navigate_op(&args, reply, cx),
            "get_state" => self.browser_eval_op(SNAPSHOT_SCRIPT.to_owned(), reply, cx),
            "screenshot" => {
                let Some(browser) = self.active_right_panel_browser() else {
                    let _ = reply.send(Err(NO_SURFACE.to_owned()));
                    return;
                };
                browser.update(cx, |view, cx| view.agent_screenshot(reply, cx));
            }
            other => {
                let _ = reply.send(Err(format!("unknown browser op: {other}")));
            }
        }
    }

    /// Navigate the active surface (opening one when none exists) and
    /// answer with the settled page's snapshot — the design's auto-wait:
    /// the follow-up eval parks behind the load and runs against the
    /// document it targeted.
    fn browser_navigate_op(
        &mut self,
        args: &Value,
        reply: std::sync::mpsc::Sender<Result<String, String>>,
        cx: &mut Context<Self>,
    ) {
        let Some(url) = args
            .get("url")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
        else {
            let _ = reply.send(Err("navigate needs a url".to_owned()));
            return;
        };
        if !is_agent_url(url) {
            let _ = reply.send(Err(
                "only http:// and https:// URLs can be opened in the browser panel".to_owned(),
            ));
            return;
        }
        let url = url.to_owned();
        if let Some(browser) = self.active_right_panel_browser() {
            browser.update(cx, |view, cx| view.navigate_to_url(url, cx));
            browser.update(cx, |view, cx| {
                view.agent_eval(SNAPSHOT_SCRIPT.to_owned(), reply, cx)
            });
            return;
        }
        // No surface yet: park both halves — the URL like a mermaid
        // diagram's Preview, the snapshot op on the pending map — and
        // open the surface. `navigate_pending_browser_url` flushes both
        // once the surface's renderer creates the view.
        let browser_id = Uuid::new_v4();
        self.right_panel_pending_browser_urls
            .insert(browser_id, url);
        self.right_panel_pending_agent_ops
            .entry(browser_id)
            .or_default()
            .push(PendingAgentOp {
                script: SNAPSHOT_SCRIPT.to_owned(),
                reply,
            });
        self.open_right_panel_surface(RightPanelSurface::Browser(browser_id), cx);
    }

    /// Evaluate a script on the active surface and hand the reply over.
    fn browser_eval_op(
        &mut self,
        script: String,
        reply: std::sync::mpsc::Sender<Result<String, String>>,
        cx: &mut Context<Self>,
    ) {
        let Some(browser) = self.active_right_panel_browser() else {
            let _ = reply.send(Err(NO_SURFACE.to_owned()));
            return;
        };
        browser.update(cx, |view, cx| view.agent_eval(script, reply, cx));
    }

    /// The surface an agent op targets: the newest Browser tab carrying a
    /// live view — the tab bar orders `right_panel_surfaces`, the surface
    /// renderer materializes views into `right_panel_browsers`.
    fn active_right_panel_browser(&self) -> Option<Entity<BrowserView>> {
        self.right_panel_surfaces
            .iter()
            .rev()
            .find_map(|surface| match surface {
                RightPanelSurface::Browser(id) => self.right_panel_browsers.get(id).cloned(),
                _ => None,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_urls_are_http_only() {
        assert!(is_agent_url("http://localhost:3000"));
        assert!(is_agent_url("https://example.com/login?a=1"));
        assert!(!is_agent_url("file:///etc/passwd"));
        assert!(!is_agent_url("data:text/html,<h1>hi</h1>"));
        assert!(!is_agent_url("about:blank"));
        assert!(!is_agent_url("javascript:alert(1)"));
        assert!(!is_agent_url("example.com"));
        assert!(!is_agent_url(""));
    }

    #[test]
    fn viewport_extraction_reads_the_snapshot_shape() {
        assert_eq!(
            viewport_of(&json!({ "viewport": { "w": 1280, "h": 800 } })),
            Some((1280, 800))
        );
        assert_eq!(
            viewport_of(&json!({ "viewport": { "w": 0, "h": 0 } })),
            Some((0, 0))
        );
        assert_eq!(viewport_of(&json!({ "url": "https://example.com" })), None);
        assert_eq!(
            viewport_of(&json!({ "viewport": { "w": "1280", "h": 800 } })),
            None
        );
        assert_eq!(viewport_of(&json!({})), None);
    }
}
