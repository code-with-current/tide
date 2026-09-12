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
pub(in crate::app) mod mermaid_images;

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{AsyncApp, Context, Entity, WeakEntity};
use serde_json::{Value, json};
use smol::channel::Sender;
use uuid::Uuid;

use tools::{BrowserBackend, set_shared_browser_backend};

use crate::app::{RightPanelSurface, Tide};
use crate::browser::BrowserView;

/// How long the engine thread waits for a navigation to settle before
/// giving up — page loads are the slowest op by far, so navigations get
/// the long leash.
const NAVIGATE_TIMEOUT: Duration = Duration::from_secs(20);
/// Every other op — evals and captures against an already-settled page.
const OP_TIMEOUT: Duration = Duration::from_secs(10);

/// The auto-settle every action runs under (the design's "click/type/scroll
/// settle ~400 ms for DOM quietness"): the page must stay mutation-free
/// for this long before the action's result goes back to the engine.
const SETTLE_QUIET_MS: u64 = 400;
/// Never hold a reply longer than this, however chatty the page —
/// animation-loop SPAs mutate forever.
const SETTLE_CAP_MS: u64 = 2000;
/// How often the settle loop re-checks the page's quiet predicate.
const SETTLE_POLL_MS: u64 = 100;

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

/// Build the one eval that runs a `__tideAct` call. Every segment is
/// JSON-encoded — serde's string output is a valid JavaScript string
/// literal — so any text (quotes, newlines, `</script>`, unicode) crosses
/// syntactically intact, and the action rides a single round trip.
fn act_script(op: &str, args: &Value) -> Result<String, String> {
    let object = args
        .as_object()
        .ok_or_else(|| format!("the {op} args must be an object"))?;
    let target = object.get("ref").and_then(Value::as_str).unwrap_or("");
    let encode = |value: &Value| serde_json::to_string(value).map_err(|e| e.to_string());
    let (target, payload) = match op {
        "click" => {
            if target.is_empty() {
                return Err(
                    "click needs the ref of the element — take one from a browser_get_state snapshot"
                        .to_owned(),
                );
            }
            (encode(&json!(target))?, Value::Null)
        }
        "type" => {
            if target.is_empty() {
                return Err(
                    "type needs the ref of the element — take one from a browser_get_state snapshot"
                        .to_owned(),
                );
            }
            let text = object.get("text").and_then(Value::as_str).unwrap_or("");
            let submit = object
                .get("submit")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            (
                encode(&json!(target))?,
                json!({ "text": text, "submit": submit }),
            )
        }
        "press_key" => {
            let key = object.get("key").and_then(Value::as_str).unwrap_or("");
            if key.is_empty() {
                return Err(
                    "press_key needs a key — e.g. \"Enter\", \"Tab\" or \"ctrl+a\"".to_owned(),
                );
            }
            (encode(&Value::Null)?, json!({ "key": key }))
        }
        "scroll" => {
            let direction = object
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !["up", "down", "left", "right"].contains(&direction) {
                return Err("scroll direction must be up, down, left or right".to_owned());
            }
            let amount = match object.get("amount") {
                None => 1.0,
                // Present-but-garbage fails loudly; only a missing amount
                // takes the one-page default.
                Some(value) => match value.as_f64() {
                    Some(amount) if amount.is_finite() && amount > 0.0 => amount.min(100.0),
                    _ => {
                        return Err("scroll amount must be a positive number of pages".to_owned());
                    }
                },
            };
            let target = if target.is_empty() {
                encode(&Value::Null)?
            } else {
                encode(&json!(target))?
            };
            (target, json!({ "direction": direction, "amount": amount }))
        }
        other => return Err(format!("unknown browser action: {other}")),
    };
    let payload = encode(&payload)?;
    Ok(format!("window.__tideAct({target},\"{op}\",{payload})"))
}

/// Parse `browser_set_viewport`'s args: `Ok(None)` releases the pin
/// (`enabled: false`), `Ok(Some((w, h)))` pins. Pinning needs positive
/// integer dimensions; `enabled` defaults to true.
fn set_viewport_args(args: &Value) -> Result<Option<(u32, u32)>, String> {
    if !args.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
        return Ok(None);
    }
    let dimension = |key: &str| {
        args.get(key)
            .and_then(Value::as_u64)
            .filter(|value| *value > 0 && *value <= u32::MAX as u64)
    };
    match (dimension("width"), dimension("height")) {
        (Some(width), Some(height)) => Ok(Some((width as u32, height as u32))),
        _ => Err("set_viewport needs width and height as positive integers".to_owned()),
    }
}

/// Did the page-side action answer success? Anything else — the stale
/// shape, `{ok:false, error}`, unparseable text — skips the settle: there
/// is no page reaction worth waiting for.
fn action_ok(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|result| result.get("ok").cloned())
        .and_then(|ok| ok.as_bool())
        .unwrap_or(false)
}

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
        let result = match answers.recv_timeout(timeout) {
            Ok(Ok(text)) => finish(op, text),
            Ok(Err(error)) => Err(error),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(format!(
                "the browser {op} call timed out after {} s",
                timeout.as_secs()
            )),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("the browser surface went away before the page settled".to_owned())
            }
        };
        // However the wait ended, tell the surface the call is over — the
        // release pairs the mark route_browser_op made on dispatch, so the
        // activity indicator spans exactly the engine-visible call. The
        // channel is FIFO, so a second op's mark can never be released by
        // this one's sentinel.
        let _ = self.ops.try_send(BrowserBridgeOp {
            request: json!({ "op": "release_busy" }),
            reply: std::sync::mpsc::channel().0,
        });
        result
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
        // Mark the surface busy for the call's whole span — dispatch to
        // answer, error, or timeout. An op that has to open its surface
        // first marks nothing; its release saturates back to zero.
        if name != "release_busy" {
            if let Some(browser) = self.active_right_panel_browser() {
                browser.update(cx, |view, cx| view.agent_tool_started(cx));
            }
        }
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
            // The action quartet: resolve refs against the live page, then
            // hold the reply until the DOM settles.
            "click" | "type" | "press_key" | "scroll" => {
                self.browser_act_op(name, &args, reply, cx);
            }
            "set_viewport" => self.browser_set_viewport_op(&args, reply, cx),
            // The invoke side's end-of-call signal: clear the mark the
            // dispatch made. A surface that vanished meanwhile is fine —
            // its counter went with it.
            "release_busy" => {
                if let Some(browser) = self.active_right_panel_browser() {
                    browser.update(cx, |view, cx| view.agent_tool_ended(cx));
                }
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

    /// The agent's half of the design's one shared viewport state: pin
    /// (or release) device mode through the very paths the toolbar's
    /// toggle and fields drive, so every control reflects it immediately.
    /// Deliberately not persisted — settings record the user's choices,
    /// not the agent's.
    fn browser_set_viewport_op(
        &mut self,
        args: &Value,
        reply: std::sync::mpsc::Sender<Result<String, String>>,
        cx: &mut Context<Self>,
    ) {
        let target = match set_viewport_args(args) {
            Ok(target) => target,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        let Some(browser) = self.active_right_panel_browser() else {
            let _ = reply.send(Err(NO_SURFACE.to_owned()));
            return;
        };
        let answer = match target {
            Some((width, height)) => {
                browser.update(cx, |view, cx| {
                    view.set_device_viewport(width, height, cx);
                });
                json!({ "ok": true, "viewport": { "w": width, "h": height } })
            }
            None => {
                browser.update(cx, |view, cx| view.clear_device_mode(cx));
                json!({ "ok": true, "viewport": null })
            }
        };
        let _ = reply.send(Ok(answer.to_string()));
    }

    /// Run one `__tideAct` call on the active surface and settle before
    /// the engine hears back. The action itself is one eval answering
    /// synchronously; the quiet wait polls the page's mutation tracker
    /// (`__tideSettledFor`) instead of awaiting a Promise because
    /// WKWebView's `evaluateJavaScript` does not await Promises (WebKit
    /// awaits them only for `callAsyncJavaScript`) — the plan's
    /// "chained in the one eval" becomes "one action eval + a native poll
    /// of the same tracker", single round trip from the engine's view.
    /// The interposed channel is what makes the reply holdable: the view
    /// answers the probe, the spawned task owns the engine's reply.
    fn browser_act_op(
        &mut self,
        op: &str,
        args: &Value,
        reply: std::sync::mpsc::Sender<Result<String, String>>,
        cx: &mut Context<Self>,
    ) {
        let script = match act_script(op, args) {
            Ok(script) => script,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        let Some(browser) = self.active_right_panel_browser() else {
            let _ = reply.send(Err(NO_SURFACE.to_owned()));
            return;
        };
        let (acted, acted_rx) = std::sync::mpsc::channel::<Result<String, String>>();
        browser.update(cx, |view, cx| view.agent_eval(script, acted, cx));
        cx.spawn(
            async move |tide, cx| match smol::unblock(move || acted_rx.recv()).await {
                Ok(Ok(text)) => {
                    if action_ok(&text) {
                        wait_for_quiet(&tide, cx, SETTLE_QUIET_MS, SETTLE_CAP_MS).await;
                    }
                    let _ = reply.send(Ok(text));
                }
                Ok(Err(error)) => {
                    let _ = reply.send(Err(error));
                }
                Err(_) => {
                    let _ = reply.send(Err(
                        "the browser surface went away before the action answered".to_owned(),
                    ));
                }
            },
        )
        .detach();
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

/// Poll the page's quiet predicate until the DOM has been mutation-free
/// for `quiet_ms`, capped at `cap_ms`. Each probe is one `agent_eval` —
/// mid-load probes park behind the navigation and run against the page
/// they were waiting for, which is exactly the auto-wait a navigating
/// click needs. Any probe failure ends the settle early (best-effort):
/// the action already succeeded, its result must still go out.
async fn wait_for_quiet(tide: &WeakEntity<Tide>, cx: &mut AsyncApp, quiet_ms: u64, cap_ms: u64) {
    let script = format!("window.__tideSettledFor({quiet_ms})");
    let started = Instant::now();
    loop {
        let (probe, probes) = std::sync::mpsc::channel::<Result<String, String>>();
        if tide
            .update(cx, |tide, cx| {
                tide.browser_eval_op(script.clone(), probe, cx)
            })
            .is_err()
        {
            return;
        }
        match smol::unblock(move || probes.recv()).await {
            // The eval answers the JSON string "true"/"false" — quiet or
            // not yet. Everything else (routing error, dropped view)
            // means there is nothing left to wait on.
            Ok(Ok(quiet)) if quiet == "true" => return,
            Ok(Ok(_)) => {}
            _ => return,
        }
        if started.elapsed().as_millis() as u64 >= cap_ms {
            return;
        }
        smol::Timer::after(Duration::from_millis(SETTLE_POLL_MS)).await;
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

    #[test]
    fn act_scripts_carry_json_encoded_segments() {
        assert_eq!(
            act_script("click", &json!({ "ref": "s3e12" })).unwrap(),
            "window.__tideAct(\"s3e12\",\"click\",null)"
        );
        // hostile text crosses as one syntactically valid JS string
        assert_eq!(
            act_script(
                "type",
                &json!({ "ref": "s1e5", "text": "line1\nline2 \"q\" </script> ☃", "submit": true })
            )
            .unwrap(),
            "window.__tideAct(\"s1e5\",\"type\",{\"text\":\"line1\\nline2 \\\"q\\\" </script> ☃\",\"submit\":true})"
        );
        assert_eq!(
            act_script("press_key", &json!({ "key": "ctrl+a" })).unwrap(),
            "window.__tideAct(null,\"press_key\",{\"key\":\"ctrl+a\"})"
        );
        // viewport scroll addresses no ref; ref'd scroll addresses the element
        assert_eq!(
            act_script("scroll", &json!({ "direction": "up", "amount": 0.5 })).unwrap(),
            "window.__tideAct(null,\"scroll\",{\"direction\":\"up\",\"amount\":0.5})"
        );
        assert_eq!(
            act_script("scroll", &json!({ "direction": "down", "ref": "s2e1" })).unwrap(),
            "window.__tideAct(\"s2e1\",\"scroll\",{\"direction\":\"down\",\"amount\":1.0})"
        );
    }

    #[test]
    fn act_scripts_validate_before_touching_the_surface() {
        // missing ref / key / direction, unknown op, non-object args
        for (op, args) in [
            ("click", json!({})),
            ("type", json!({ "text": "hi" })),
            ("press_key", json!({})),
            ("scroll", json!({ "direction": "sideways" })),
            ("scroll", json!({ "direction": "down", "amount": -1 })),
            ("reload", json!({})),
            ("click", json!("s1e1")),
        ] {
            assert!(act_script(op, &args).is_err(), "{op} {args}");
        }
        // amount falls back to one page when missing
        assert!(
            act_script("scroll", &json!({ "direction": "down" }))
                .unwrap()
                .ends_with("\"amount\":1.0})")
        );
    }

    #[test]
    fn action_ok_gates_the_settle_on_page_success() {
        assert!(action_ok("{\"ok\":true,\"action\":\"click\"}"));
        assert!(!action_ok(
            "{\"ok\":false,\"stale\":true,\"reason\":\"ref left the document\"}"
        ));
        assert!(!action_ok("{\"ok\":false,\"error\":\"unknown key\"}"));
        assert!(!action_ok("not json"));
        assert!(!action_ok("null"));
    }

    #[test]
    fn set_viewport_args_pin_or_release() {
        // Pinning: positive integers within u32.
        assert_eq!(
            set_viewport_args(&json!({ "width": 390, "height": 844 })),
            Ok(Some((390, 844)))
        );
        assert_eq!(
            set_viewport_args(&json!({ "width": 1, "height": 1 })),
            Ok(Some((1, 1)))
        );
        // `enabled` defaults to true.
        assert_eq!(
            set_viewport_args(&json!({ "width": 390, "height": 844, "enabled": true })),
            Ok(Some((390, 844)))
        );
        // enabled:false releases the pin — no dimensions needed, and any
        // garbage among them is irrelevant.
        assert_eq!(set_viewport_args(&json!({ "enabled": false })), Ok(None));
        assert_eq!(
            set_viewport_args(&json!({ "enabled": false, "width": 0, "height": -3 })),
            Ok(None)
        );
        // Missing, non-positive, non-integer or out-of-u32 dimensions error.
        for args in [
            json!({}),
            json!({ "width": 390 }),
            json!({ "height": 844 }),
            json!({ "width": 0, "height": 844 }),
            json!({ "width": 390, "height": -5 }),
            json!({ "width": "390", "height": 844 }),
            json!({ "width": 390.5, "height": 844 }),
            json!({ "width": 4_294_967_296_u64, "height": 844 }),
        ] {
            assert!(set_viewport_args(&args).is_err(), "{args}");
        }
    }
}
