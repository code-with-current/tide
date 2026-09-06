//! Tide's native Computer Use tools — the vendored Open Computer Use kit's
//! nine Codex-style tools (`list_apps`, `get_app_state`, `click`, `drag`,
//! `press_key`, `type_text`, `perform_secondary_action`, `set_value`,
//! `scroll`) registered directly in Tide's tool registry. There is no MCP
//! transport: every call rides one helper request (`operation: "call"`)
//! through the [`ComputerBackend`] seam in [`super::computer`], and the
//! helper executes it with the kit's sky-click input pipeline.
//!
//! Split mirrors upstream annotations: `list_apps` and `get_app_state`
//! observe (`readOnlyHint`), everything else acts on the user's session —
//! reads pass Plan mode, actions need Build, like the old `computer` split.

use serde_json::{json, Value};

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

/// Run one kit tool through the helper and shape the model-facing outcome.
/// The helper response is `{ success, error?, result: { tool, content,
/// isError }, target?, imageUrl? }`; `content` items are text chunks or
/// base64 PNG captures.
fn computer_call(tool: &str, args: &Value) -> Result<ToolOutcome, ToolError> {
    let Some(backend) = super::computer::shared_computer_backend() else {
        return Ok(ToolOutcome::failed(
            "Computer Use is not available in this build (macOS helper app required).",
        ));
    };
    if !backend.enabled() {
        return Ok(ToolOutcome::failed(
            "Computer Use is turned off in Settings → Computer Use.",
        ));
    }
    let operation = json!({ "operation": "call", "tool": tool, "arguments": args });
    let response = backend
        .invoke(&operation)
        .map_err(|error| ToolError::Internal(error))?;
    render_kit_response(tool, &response).map_err(ToolError::Internal)
}

fn render_kit_response(tool: &str, response: &Value) -> Result<ToolOutcome, String> {
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        let error = response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the Computer Use helper reported an unspecified failure");
        return Err(error.to_owned());
    }
    let Some(result) = response.get("result") else {
        return Err("the Computer Use helper returned no tool result".to_owned());
    };
    let content = result
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut text = String::new();
    let mut media = None;
    for item in &content {
        match item.get("type").and_then(Value::as_str) {
            Some("image") => {
                let data = item.get("data").and_then(Value::as_str).unwrap_or_default();
                let mime = item
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png");
                if !data.is_empty() && media.is_none() {
                    media = Some(ToolDisplay::Media {
                        data_url: format!("data:{mime};base64,{data}"),
                        mime_type: mime.to_owned(),
                    });
                }
            }
            _ => {
                if let Some(chunk) = item.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(chunk);
                }
            }
        }
    }
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        let detail = if text.is_empty() {
            format!("the {tool} call failed inside the Computer Use helper")
        } else {
            text
        };
        return Ok(ToolOutcome::failed(detail));
    }
    if text.is_empty() && media.is_none() {
        return Err(format!("the {tool} call returned no output"));
    }
    // The captured window rides `meta.computerTarget` so the driver can push
    // the live Picture-in-Picture preview without re-parsing screenshots.
    let meta = response
        .get("target")
        .filter(|target| target.is_object())
        .map(|target| json!({ "computerTarget": target }).to_string());
    Ok(ToolOutcome {
        status: crate::OutcomeStatus::Executed,
        output: text,
        display: media,
        meta,
        duration_ms: None,
    })
}

const APP_ARG: &str = "App name or bundle identifier";
const ELEMENT_ARG: &str = "Element identifier";

fn string_property(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn string_enum_property(description: &str, values: &[&str]) -> Value {
    json!({ "type": "string", "description": description, "enum": values })
}

fn number_property(description: &str) -> Value {
    json!({ "type": "number", "description": description })
}

fn integer_property(description: &str) -> Value {
    json!({ "type": "integer", "description": description })
}

/// Every Computer Use tool addresses the user's real session one call at a
/// time — never run two concurrently.
fn computer_tool(tool: &'static str, args: &Value) -> Result<ToolOutcome, ToolError> {
    computer_call(tool, args)
}

macro_rules! computer_tools {
    ($($name:ident => $tool:literal, $tier:ident, $description:literal, $parameters:expr);* $(;)?) => {
        $(
            pub struct $name;

            impl Tool for $name {
                fn spec(&self) -> ToolSpec {
                    ToolSpec {
                        name: $tool.to_owned(),
                        description: $description.to_owned(),
                        parameters: $parameters,
                    }
                }

                fn risk_tier(&self) -> RiskTier {
                    RiskTier::$tier
                }

                fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<ToolOutcome, ToolError> {
                    computer_tool($tool, &args)
                }
            }
        )*
    };
}

computer_tools! {
    ListAppsTool => "list_apps", ReadOnly,
        "List the apps on this computer. Returns the set of apps that are currently running, as well as any that have been used in the last 14 days, including details on usage frequency.",
        json!({
            "type": "object",
            "properties": {},
        });
    GetAppStateTool => "get_app_state", ReadOnly,
        "Start an app use session if needed, then get the state of the app's key window and return a screenshot and accessibility tree. This must be called once per assistant turn before interacting with the app.",
        json!({
            "type": "object",
            "properties": {
                "app": string_property(APP_ARG),
                "text_limit": {
                    "anyOf": [
                        { "type": "integer", "minimum": 1 },
                        { "type": "string", "enum": ["max"] },
                    ],
                    "description": "Maximum text characters to return. Use \"max\" for full text. Defaults to 500.",
                },
                "max_tree_nodes": integer_property("Maximum accessibility tree nodes to render. Defaults to 1200."),
                "max_tree_depth": integer_property("Maximum accessibility tree depth to render. Defaults to 64."),
            },
            "required": ["app"],
        });
    ClickTool => "click", Write,
        "Click an element by index or pixel coordinates from the latest get_app_state screenshot.",
        json!({
            "type": "object",
            "properties": {
                "app": string_property(APP_ARG),
                "element_index": string_property("Element index to click"),
                "x": number_property("X coordinate in screenshot pixel coordinates"),
                "y": number_property("Y coordinate in screenshot pixel coordinates"),
                "click_count": integer_property("Number of clicks. Defaults to 1"),
                "mouse_button": string_enum_property(
                    "Mouse button to click. Defaults to left.",
                    &["left", "right", "middle"],
                ),
                "click_method": string_enum_property(
                    "Click implementation: auto (default), accessibility, app_post, sky_click, or global. Accessibility requires element_index. app_post sends a public event directly to the target app. sky_click uses the macOS SkyLight background window path. Global may move the system pointer and requires OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1.",
                    &["auto", "accessibility", "app_post", "sky_click", "global"],
                ),
            },
            "required": ["app"],
        });
    DragTool => "drag", Write,
        "Drag from one point to another using pixel coordinates.",
        json!({
            "type": "object",
            "properties": {
                "app": string_property(APP_ARG),
                "from_x": number_property("Start X coordinate"),
                "from_y": number_property("Start Y coordinate"),
                "to_x": number_property("End X coordinate"),
                "to_y": number_property("End Y coordinate"),
            },
            "required": ["app", "from_x", "from_y", "to_x", "to_y"],
        });
    PressKeyTool => "press_key", Write,
        "Press a key or key-combination on the keyboard, including modifier and navigation keys. Supports xdotool's `key` syntax. Examples: \"a\", \"Return\", \"Tab\", \"super+c\", \"Up\", \"KP_0\" (for the numpad 0 key).",
        json!({
            "type": "object",
            "properties": {
                "app": string_property(APP_ARG),
                "key": string_property("Key or key combination to press"),
            },
            "required": ["app", "key"],
        });
    TypeTextTool => "type_text", Write,
        "Type literal text using keyboard input.",
        json!({
            "type": "object",
            "properties": {
                "app": string_property(APP_ARG),
                "text": string_property("Literal text to type"),
            },
            "required": ["app", "text"],
        });
    PerformSecondaryActionTool => "perform_secondary_action", Write,
        "Invoke a secondary accessibility action exposed by an element.",
        json!({
            "type": "object",
            "properties": {
                "app": string_property(APP_ARG),
                "element_index": string_property(ELEMENT_ARG),
                "action": string_property("Secondary accessibility action name"),
            },
            "required": ["app", "element_index", "action"],
        });
    SetValueTool => "set_value", Write,
        "Set the value of a settable accessibility element.",
        json!({
            "type": "object",
            "properties": {
                "app": string_property(APP_ARG),
                "element_index": string_property(ELEMENT_ARG),
                "value": string_property("Value to assign"),
            },
            "required": ["app", "element_index", "value"],
        });
    ScrollTool => "scroll", Write,
        "Scroll an element in a direction by a number of pages.",
        json!({
            "type": "object",
            "properties": {
                "app": string_property(APP_ARG),
                "direction": string_enum_property(
                    "Scroll direction: up, down, left, or right",
                    &["up", "down", "left", "right"],
                ),
                "element_index": string_property(ELEMENT_ARG),
                "pages": number_property("Number of pages to scroll. Fractional values are supported. Defaults to 1"),
            },
            "required": ["app", "element_index", "direction"],
        });
}

/// The native Computer Use tool names — the registry order mirrors
/// [`super::computer_tools`] registration and the vendored kit surface.
pub const COMPUTER_TOOLS: &[&str] = &[
    "list_apps",
    "get_app_state",
    "click",
    "drag",
    "press_key",
    "type_text",
    "perform_secondary_action",
    "set_value",
    "scroll",
];

pub fn is_computer_tool(name: &str) -> bool {
    COMPUTER_TOOLS.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn outcome(response: &Value) -> ToolOutcome {
        render_kit_response("get_app_state", response).unwrap()
    }

    #[test]
    fn kit_results_carry_text_and_media() {
        let outcome = outcome(&json!({
            "success": true,
            "result": {
                "tool": "get_app_state",
                "content": [
                    { "type": "text", "text": "App=TextEdit" },
                    { "type": "image", "data": "aGVsbG8=", "mimeType": "image/png" },
                ],
                "isError": false,
            },
            "target": { "windowId": 42, "appName": "TextEdit" },
        }));
        assert_eq!(outcome.status, crate::OutcomeStatus::Executed);
        assert_eq!(outcome.output, "App=TextEdit");
        let Some(ToolDisplay::Media { data_url, mime_type }) = outcome.display else {
            panic!("expected media display");
        };
        assert_eq!(data_url, "data:image/png;base64,aGVsbG8=");
        assert_eq!(mime_type, "image/png");
        assert_eq!(
            serde_json::from_str::<Value>(outcome.meta.as_deref().unwrap()).unwrap()
                ["computerTarget"]["windowId"],
            json!(42)
        );
    }

    #[test]
    fn upstream_is_error_becomes_failed_outcome() {
        let outcome = render_kit_response(
            "click",
            &json!({
                "success": true,
                "result": {
                    "tool": "click",
                    "content": [{ "type": "text", "text": "Element (index) is stale." }],
                    "isError": true,
                },
            }),
        )
        .unwrap();
        assert_eq!(outcome.status, crate::OutcomeStatus::Failed);
        assert!(outcome.output.contains("stale"));
    }

    #[test]
    fn helper_failures_surface_the_error() {
        let error = render_kit_response(
            "click",
            &json!({ "success": false, "error": "Screen Recording permission is missing" }),
        )
        .unwrap_err();
        assert!(error.contains("Screen Recording"), "{error}");
    }

    #[test]
    fn registry_names_and_tiers_line_up() {
        let tiers: Vec<(&str, RiskTier)> = COMPUTER_TOOLS
            .iter()
            .map(|name| (*name, crate::permission::risk_tier_for(name)))
            .collect();
        assert_eq!(tiers[0], ("list_apps", RiskTier::ReadOnly));
        assert_eq!(tiers[1], ("get_app_state", RiskTier::ReadOnly));
        for (name, tier) in &tiers[2..] {
            assert_eq!(tier, &RiskTier::Write, "{name}");
        }
        assert!(is_computer_tool("click") && !is_computer_tool("computer"));
    }
}
