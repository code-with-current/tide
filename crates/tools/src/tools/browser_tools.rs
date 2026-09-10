//! Tide's native browser tools — the agent's read access to the
//! right-panel webview. Every call rides one `{ op, args }` request
//! through the [`BrowserBackend`] seam in [`super::browser`]; the app
//! installs the webview bridge at boot, and without it (Linux builds,
//! tool-only binaries) calls fail with a clean "unavailable" outcome
//! instead of a panic.
//!
//! Task 4 ships the read half — navigate, get_state, screenshot. The
//! action tools (click, type, press_key, scroll) land with the page-side
//! `__tideAct` serializer in Task 5 and join this module beside these.

use serde_json::{Value, json};

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
    let text = serde_json::to_string(response)
        .map_err(|error| format!("the {op} call returned an unserializable result: {error}"))?;
    if text == "null" {
        return Err(format!("the {op} call returned no output"));
    }
    Ok(ToolOutcome::executed(text))
}

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

/// The native browser tool names — the registry order mirrors
/// [`super::browser_tools`] registration. Task 5's action tools append.
pub const BROWSER_TOOLS: &[&str] = &[
    "browser_navigate",
    "browser_get_state",
    "browser_screenshot",
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
    fn registry_names_and_tiers_line_up() {
        assert_eq!(
            BROWSER_TOOLS,
            [
                "browser_navigate",
                "browser_get_state",
                "browser_screenshot"
            ]
        );
        assert_eq!(risk_tier_for("browser_navigate"), RiskTier::Write);
        assert_eq!(risk_tier_for("browser_get_state"), RiskTier::ReadOnly);
        assert_eq!(risk_tier_for("browser_screenshot"), RiskTier::ReadOnly);
        assert!(is_browser_tool("browser_navigate") && !is_browser_tool("browser"));
    }
}
