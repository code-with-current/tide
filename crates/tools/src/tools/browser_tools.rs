//! Tide's native browser tools — the agent's access to the right-panel
//! webview. Every call rides one `{ op, args }` request
//! through the [`BrowserBackend`] seam in [`super::browser`]; the app
//! installs the webview bridge at boot, and without it (Linux builds,
//! tool-only binaries) calls fail with a clean "unavailable" outcome
//! instead of a panic.
//!
//! Task 4 shipped the read half — navigate, get_state, screenshot. Task 5
//! adds the action half — click, type, press_key, scroll — which resolve
//! snapshot refs against the live page through `__tideAct` and answer the
//! one stale shape ([`STALE_REF_MESSAGE`]) whenever the page moved under
//! the model.

use serde_json::{json, Value};

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

/// Run one browser op through the installed webview bridge and shape the
/// model-facing outcome. The bridge answers with the op's result JSON —
/// a `__tideSnapshot()` payload for navigate/get_state, a
/// `{ image, mime_type }` wrapper for screenshots.
fn browser_call(op: &str, args: &Value) -> Result<ToolOutcome, ToolError> {
    let Some(backend) = super::browser::shared_browser_backend() else {
        return Ok(ToolOutcome::failed(
            "Browser tools are not available in this build (no browser panel was installed).",
        ));
    };
    if !backend.enabled() {
        return Ok(ToolOutcome::failed(
            "Browser tools are turned off for this session.",
        ));
    }
    let request = json!({ "op": op, "args": args });
    let response = backend.invoke(&request).map_err(ToolError::Internal)?;
    render_browser_response(op, &response).map_err(ToolError::Internal)
}

/// Shape the bridge's answer. Snapshot JSON passes through as the
/// model-facing text verbatim; a screenshot's base64 rides the media
/// display the way the Computer Use captures do
/// (`render_kit_response` in [`super::computer_tools`]).
fn render_browser_response(op: &str, response: &Value) -> Result<ToolOutcome, String> {
    if let Some(image) = response.get("image").and_then(Value::as_str) {
        if image.is_empty() {
            return Err(format!("the {op} call returned an empty capture"));
        }
        let mime_type = response
            .get("mime_type")
            .and_then(Value::as_str)
            .unwrap_or("image/png")
            .to_owned();
        return Ok(ToolOutcome {
            status: crate::OutcomeStatus::Executed,
            output: "Captured a PNG screenshot of the browser panel.".to_owned(),
            display: Some(ToolDisplay::Media {
                data_url: format!("data:{mime_type};base64,{image}"),
                mime_type,
            }),
            meta: None,
            duration_ms: None,
        });
    }
    // The design's single stale shape: `__tideAct` could not resolve the
    // ref against the live page. One message, one remedy — re-snapshot.
    if response.get("stale").and_then(Value::as_bool) == Some(true) {
        return Ok(ToolOutcome::failed(STALE_REF_MESSAGE));
    }
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        let detail = response
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| response.get("reason").and_then(Value::as_str))
            .unwrap_or("the browser action reported an unspecified failure");
        return Ok(ToolOutcome::failed(detail.to_owned()));
    }
    let text = serde_json::to_string(response)
        .map_err(|error| format!("the {op} call returned an unserializable result: {error}"))?;
    if text == "null" {
        return Err(format!("the {op} call returned no output"));
    }
    Ok(ToolOutcome::executed(text))
}

/// The one model-facing error a stale ref produces — verbatim, so the
/// remedy (re-snapshot) is always the same instruction. `__tideAct`
/// answers `{ok:false, stale:true}` for a ref that is missing from the
/// live map, disconnected, or whose role/name no longer match; this is
/// its rendering on the tool side.
pub const STALE_REF_MESSAGE: &str = "The page changed under you — that ref is no longer valid. Call browser_get_state again and retry with the fresh refs.";

/// The agent's URL contract: real web pages only. Validated before the
/// call so a bad argument fails without waking the browser surface.
fn is_http_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

pub struct BrowserNavigateTool;

impl Tool for BrowserNavigateTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "browser_navigate".to_owned(),
            description: "Open a URL in the browser panel and wait for the page to load. Only http:// and https:// URLs are allowed. Returns the fresh page state (URL, title, viewport and the element tree) once the load settles.".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The http:// or https:// URL to open"
                    }
                },
                "required": ["url"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<ToolOutcome, ToolError> {
        let url = super::arg_str(&args, "url");
        if !is_http_url(&url) {
            return Ok(ToolOutcome::failed(
                "browser_navigate needs an http:// or https:// URL.",
            ));
        }
        browser_call("navigate", &args)
    }
}

pub struct BrowserGetStateTool;

impl Tool for BrowserGetStateTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "browser_get_state".to_owned(),
            description: "Read the browser panel's current page: URL, title, viewport size, ready state and a role/name/ref tree of the visible elements. Refs are scoped to the snapshot that produced them, so call this again whenever the page may have changed.".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {}
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<ToolOutcome, ToolError> {
        browser_call("get_state", &args)
    }
}

pub struct BrowserScreenshotTool;

impl Tool for BrowserScreenshotTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "browser_screenshot".to_owned(),
            description: "Capture the browser panel's current viewport as a PNG image.".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {}
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<ToolOutcome, ToolError> {
        browser_call("screenshot", &args)
    }
}

pub struct BrowserClickTool;

impl Tool for BrowserClickTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "browser_click".to_owned(),
            description: "Click an element in the browser panel by its ref from the latest browser_get_state snapshot. Scrolls the element into view, fires the full pointer/mouse event sequence, then follows the click's activation (form submit, link navigation, checkbox toggle) and waits for the page to settle. Stale or unknown refs fail with a reminder to call browser_get_state again.".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "string",
                        "description": "Element ref from the latest snapshot, e.g. \"s3e12\""
                    }
                },
                "required": ["ref"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<ToolOutcome, ToolError> {
        if super::arg_str(&args, "ref").is_empty() {
            return Ok(ToolOutcome::failed(
                "browser_click needs the ref of the element to click — take one from a browser_get_state snapshot.",
            ));
        }
        browser_call("click", &args)
    }
}

pub struct BrowserTypeTool;

impl Tool for BrowserTypeTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "browser_type".to_owned(),
            description: "Type text into an element in the browser panel by its ref from the latest browser_get_state snapshot. Focuses the field, selects all existing content, then types the text character by character (falling back to a React-safe whole-value replacement on pages without insertText). Set submit to true to press Enter afterwards and submit the surrounding form. Waits for the page to settle.".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "string",
                        "description": "Element ref from the latest snapshot, e.g. \"s3e12\""
                    },
                    "text": {
                        "type": "string",
                        "description": "Text to type; empty text clears the field"
                    },
                    "submit": {
                        "type": "boolean",
                        "description": "Press Enter after typing to submit the form. Defaults to false"
                    }
                },
                "required": ["ref", "text"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<ToolOutcome, ToolError> {
        if super::arg_str(&args, "ref").is_empty() {
            return Ok(ToolOutcome::failed(
                "browser_type needs the ref of the element to type into — take one from a browser_get_state snapshot.",
            ));
        }
        if args.get("text").and_then(Value::as_str).is_none() {
            return Ok(ToolOutcome::failed(
                "browser_type needs the text to type (an empty string clears the field).",
            ));
        }
        browser_call("type", &args)
    }
}

pub struct BrowserPressKeyTool;

impl Tool for BrowserPressKeyTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "browser_press_key".to_owned(),
            description: "Press a key or key combination in the browser panel: synthesizes keydown + keyup on the focused element. Accepts xdotool-style names — \"Enter\", \"Tab\", \"Escape\", \"Backspace\", \"Up\", \"PageDown\", \"Home\", single characters, and modifier combos like \"ctrl+a\", \"alt+Tab\", \"super+k\". Waits for the page to settle.".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "Key or key combination to press, e.g. \"Enter\" or \"ctrl+a\""
                    }
                },
                "required": ["key"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<ToolOutcome, ToolError> {
        if super::arg_str(&args, "key").is_empty() {
            return Ok(ToolOutcome::failed(
                "browser_press_key needs a key — e.g. \"Enter\", \"Tab\" or \"ctrl+a\".",
            ));
        }
        browser_call("press_key", &args)
    }
}

const SCROLL_DIRECTIONS: [&str; 4] = ["up", "down", "left", "right"];

pub struct BrowserScrollTool;

impl Tool for BrowserScrollTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "browser_scroll".to_owned(),
            description: "Scroll the browser panel's page (or a ref'd scrollable element) by a fraction of a viewport. direction is up, down, left or right; amount is in pages and defaults to 1 — 0.5 scrolls half a page. Waits for the page to settle.".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "direction": {
                        "type": "string",
                        "enum": ["up", "down", "left", "right"],
                        "description": "Direction to scroll"
                    },
                    "amount": {
                        "type": "number",
                        "description": "Pages to scroll; defaults to 1"
                    },
                    "ref": {
                        "type": "string",
                        "description": "Element ref of the scrollable container; omit to scroll the whole page"
                    }
                },
                "required": ["direction"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<ToolOutcome, ToolError> {
        if !SCROLL_DIRECTIONS.contains(&super::arg_str(&args, "direction").as_str()) {
            return Ok(ToolOutcome::failed(
                "browser_scroll needs a direction of up, down, left or right.",
            ));
        }
        if let Some(amount) = args.get("amount") {
            let amount = amount
                .as_f64()
                .filter(|amount| amount.is_finite() && *amount > 0.0);
            if amount.is_none() {
                return Ok(ToolOutcome::failed(
                    "browser_scroll's amount must be a positive number of pages.",
                ));
            }
        }
        browser_call("scroll", &args)
    }
}

pub struct BrowserSetViewportTool;

impl Tool for BrowserSetViewportTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "browser_set_viewport".to_owned(),
            description: "Pin the browser panel's viewport to exact CSS-pixel dimensions, enabling device mode — the same state the user's device toolbar toggle drives, so the pinned frame and its controls reflect it immediately. Set enabled to false to release the pin and let the page fill the panel again.".to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "width": {
                        "type": "integer",
                        "description": "Viewport width in CSS pixels (100-7680)"
                    },
                    "height": {
                        "type": "integer",
                        "description": "Viewport height in CSS pixels (100-7680)"
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "false releases the pin; defaults to true"
                    }
                },
                "required": ["width", "height"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<ToolOutcome, ToolError> {
        // Releasing the pin (enabled: false) needs no dimensions; pinning
        // validates them here so a bad call fails before waking the surface.
        if args.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
            for key in ["width", "height"] {
                let dimension = args
                    .get(key)
                    .and_then(Value::as_u64)
                    .filter(|value| *value > 0 && *value <= u32::MAX as u64);
                if dimension.is_none() {
                    return Ok(ToolOutcome::failed(
                        "browser_set_viewport needs width and height as positive integers (CSS pixels).",
                    ));
                }
            }
        }
        browser_call("set_viewport", &args)
    }
}

/// The native browser tool names — the registry order mirrors
/// [`super::browser_tools`] registration.
pub const BROWSER_TOOLS: &[&str] = &[
    "browser_navigate",
    "browser_get_state",
    "browser_screenshot",
    "browser_click",
    "browser_type",
    "browser_press_key",
    "browser_scroll",
    "browser_set_viewport",
];

pub fn is_browser_tool(name: &str) -> bool {
    BROWSER_TOOLS.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::risk_tier_for;
    use serde_json::json;
    use std::sync::Arc;

    #[derive(Debug)]
    struct StubBackend;

    impl super::super::browser::BrowserBackend for StubBackend {
        fn enabled(&self) -> bool {
            true
        }

        fn invoke(&self, request: &Value) -> Result<Value, String> {
            Ok(json!({ "echo": request }))
        }
    }

    #[test]
    fn no_backend_fails_cleanly() {
        let _guard = super::super::browser::TEST_SLOT_LOCK.lock().unwrap();
        super::super::browser::set_shared_browser_backend(None);
        let outcome = browser_call("navigate", &json!({ "url": "https://example.com" })).unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        assert!(
            outcome.output.contains("not available"),
            "{output}",
            output = outcome.output
        );
    }

    #[test]
    fn request_carries_op_and_args_and_text_passes_through() {
        let _guard = super::super::browser::TEST_SLOT_LOCK.lock().unwrap();
        super::super::browser::set_shared_browser_backend(Some(Arc::new(StubBackend)));
        let ctx = ToolContext::new(".");
        let outcome = BrowserNavigateTool
            .execute(&ctx, json!({ "url": "https://example.com/login" }))
            .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Executed);
        // The stub echoes the request back, so the passthrough text is the
        // proof the seam carried `{ op, args }` exactly.
        let parsed: Value = serde_json::from_str(&outcome.output).unwrap();
        assert_eq!(parsed["echo"]["op"], "navigate");
        assert_eq!(parsed["echo"]["args"]["url"], "https://example.com/login");
        super::super::browser::set_shared_browser_backend(None);
    }

    #[test]
    fn navigate_rejects_non_http_urls_before_the_hop() {
        let ctx = ToolContext::new(".");
        for url in ["file:///etc/passwd", "data:text/html,x", "example.com"] {
            let outcome = BrowserNavigateTool
                .execute(&ctx, json!({ "url": url }))
                .unwrap();
            assert_eq!(outcome.status, crate::OutcomeStatus::Failed, "{url}");
            assert!(
                outcome.output.contains("http"),
                "{url}: {output}",
                url = url,
                output = outcome.output
            );
        }
    }

    #[test]
    fn screenshots_ride_the_media_display() {
        let outcome = render_browser_response(
            "browser_screenshot",
            &json!({ "image": "aGVsbG8=", "mime_type": "image/png" }),
        )
        .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Executed);
        assert_eq!(
            outcome.output,
            "Captured a PNG screenshot of the browser panel."
        );
        let Some(ToolDisplay::Media {
            data_url,
            mime_type,
        }) = outcome.display
        else {
            panic!("expected media display");
        };
        assert_eq!(data_url, "data:image/png;base64,aGVsbG8=");
        assert_eq!(mime_type, "image/png");

        assert!(render_browser_response("browser_screenshot", &json!({ "image": "" })).is_err());
    }

    #[test]
    fn snapshot_text_passes_through_verbatim() {
        let snapshot = json!({
            "url": "https://example.com/login",
            "title": "Sign in",
            "viewport": { "w": 1280, "h": 800 },
            "ready": "complete",
            "tree": [
                { "ref": "s1e2", "role": "heading", "name": "Sign in", "level": 1 }
            ],
            "truncated": false
        });
        let outcome = render_browser_response("get_state", &snapshot).unwrap();
        assert_eq!(outcome.display, None);
        assert_eq!(
            serde_json::from_str::<Value>(&outcome.output).unwrap(),
            snapshot
        );

        assert!(render_browser_response("get_state", &Value::Null).is_err());
    }

    #[test]
    fn stale_refs_fail_with_the_verbatim_stale_message() {
        let outcome = render_browser_response(
            "click",
            &json!({ "ok": false, "stale": true, "reason": "ref s1e8 left the document; call browser_get_state for a fresh snapshot" }),
        )
        .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        assert_eq!(outcome.output, STALE_REF_MESSAGE);
        assert!(outcome.output.contains("browser_get_state"));
    }

    #[test]
    fn failed_actions_surface_their_detail() {
        let outcome = render_browser_response(
            "press_key",
            &json!({ "ok": false, "error": "press_key does not know the key name hyper" }),
        )
        .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        assert!(outcome.output.contains("hyper"), "{}", outcome.output);

        let bare = render_browser_response("press_key", &json!({ "ok": false })).unwrap();
        assert_eq!(bare.status, crate::OutcomeStatus::Failed);
        assert!(bare.output.contains("unspecified failure"));
    }

    #[test]
    fn successful_actions_pass_their_result_through() {
        let result = json!({ "ok": true, "action": "click", "activation": "submitted" });
        let outcome = render_browser_response("click", &result).unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Executed);
        assert_eq!(
            serde_json::from_str::<Value>(&outcome.output).unwrap(),
            result
        );
    }

    #[test]
    fn action_tools_validate_args_before_touching_the_surface() {
        let ctx = ToolContext::new(".");
        // click without a ref
        let outcome = BrowserClickTool.execute(&ctx, json!({})).unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        assert!(outcome.output.contains("ref"), "{}", outcome.output);
        // type without a ref / without text
        let outcome = BrowserTypeTool
            .execute(&ctx, json!({ "text": "hi" }))
            .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        let outcome = BrowserTypeTool
            .execute(&ctx, json!({ "ref": "s1e5" }))
            .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        assert!(outcome.output.contains("text"), "{}", outcome.output);
        // press_key without a key
        let outcome = BrowserPressKeyTool.execute(&ctx, json!({})).unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        assert!(outcome.output.contains("key"), "{}", outcome.output);
        // scroll: bad direction, non-positive and non-numeric amounts
        let outcome = BrowserScrollTool
            .execute(&ctx, json!({ "direction": "sideways" }))
            .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        assert!(outcome.output.contains("direction"), "{}", outcome.output);
        for amount in [0, -1] {
            let outcome = BrowserScrollTool
                .execute(&ctx, json!({ "direction": "down", "amount": amount }))
                .unwrap();
            assert_eq!(outcome.status, crate::OutcomeStatus::Failed, "{amount}");
        }
        let outcome = BrowserScrollTool
            .execute(&ctx, json!({ "direction": "down", "amount": "page" }))
            .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        // set_viewport: pinning needs positive integers, in range of u32
        for args in [
            json!({}),
            json!({ "width": 390 }),
            json!({ "height": 844 }),
            json!({ "width": 0, "height": 844 }),
            json!({ "width": 390, "height": -5 }),
            json!({ "width": "390", "height": 844 }),
            json!({ "width": 390.5, "height": 844 }),
        ] {
            let outcome = BrowserSetViewportTool.execute(&ctx, args.clone()).unwrap();
            assert_eq!(outcome.status, crate::OutcomeStatus::Failed, "{args}");
            assert!(
                outcome.output.contains("width"),
                "{args}: {}",
                outcome.output
            );
        }
    }

    #[test]
    fn action_calls_carry_op_and_args_through_the_seam() {
        let _guard = super::super::browser::TEST_SLOT_LOCK.lock().unwrap();
        super::super::browser::set_shared_browser_backend(Some(Arc::new(StubBackend)));
        let ctx = ToolContext::new(".");
        let outcome = BrowserClickTool
            .execute(&ctx, json!({ "ref": "s3e12" }))
            .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Executed);
        let parsed: Value = serde_json::from_str(&outcome.output).unwrap();
        assert_eq!(parsed["echo"]["op"], "click");
        assert_eq!(parsed["echo"]["args"]["ref"], "s3e12");

        let outcome = BrowserTypeTool
            .execute(
                &ctx,
                json!({ "ref": "s1e5", "text": "ada@example.com", "submit": true }),
            )
            .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Executed);
        let parsed: Value = serde_json::from_str(&outcome.output).unwrap();
        assert_eq!(parsed["echo"]["op"], "type");
        assert_eq!(parsed["echo"]["args"]["text"], "ada@example.com");

        let outcome = BrowserPressKeyTool
            .execute(&ctx, json!({ "key": "ctrl+a" }))
            .unwrap();
        let parsed: Value = serde_json::from_str(&outcome.output).unwrap();
        assert_eq!(parsed["echo"]["op"], "press_key");
        assert_eq!(parsed["echo"]["args"]["key"], "ctrl+a");

        let outcome = BrowserScrollTool
            .execute(&ctx, json!({ "direction": "up", "amount": 0.5 }))
            .unwrap();
        let parsed: Value = serde_json::from_str(&outcome.output).unwrap();
        assert_eq!(parsed["echo"]["op"], "scroll");
        assert_eq!(parsed["echo"]["args"]["direction"], "up");

        // set_viewport: pinning carries both dimensions; enabled:false
        // releases and needs none.
        let outcome = BrowserSetViewportTool
            .execute(&ctx, json!({ "width": 390, "height": 844 }))
            .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Executed);
        let parsed: Value = serde_json::from_str(&outcome.output).unwrap();
        assert_eq!(parsed["echo"]["op"], "set_viewport");
        assert_eq!(parsed["echo"]["args"]["width"], 390);
        assert_eq!(parsed["echo"]["args"]["height"], 844);
        let outcome = BrowserSetViewportTool
            .execute(&ctx, json!({ "enabled": false }))
            .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Executed);
        let parsed: Value = serde_json::from_str(&outcome.output).unwrap();
        assert_eq!(parsed["echo"]["op"], "set_viewport");
        assert_eq!(parsed["echo"]["args"]["enabled"], false);
        super::super::browser::set_shared_browser_backend(None);
    }

    #[test]
    fn registry_names_and_tiers_line_up() {
        assert_eq!(
            BROWSER_TOOLS,
            [
                "browser_navigate",
                "browser_get_state",
                "browser_screenshot",
                "browser_click",
                "browser_type",
                "browser_press_key",
                "browser_scroll",
                "browser_set_viewport"
            ]
        );
        assert_eq!(risk_tier_for("browser_navigate"), RiskTier::Write);
        assert_eq!(risk_tier_for("browser_get_state"), RiskTier::ReadOnly);
        assert_eq!(risk_tier_for("browser_screenshot"), RiskTier::ReadOnly);
        // The action tools drive the live page like the Computer Use
        // action tools, and set_viewport drives the same device mode the
        // user's toolbar toggle does: Write on both the tool metadata and
        // the gate's name-keyed table.
        for name in [
            "browser_click",
            "browser_type",
            "browser_press_key",
            "browser_scroll",
            "browser_set_viewport",
        ] {
            assert_eq!(risk_tier_for(name), RiskTier::Write, "{name}");
        }
        assert_eq!(BrowserSetViewportTool.risk_tier(), RiskTier::Write);
        assert!(is_browser_tool("browser_click") && !is_browser_tool("click"));
    }
}
