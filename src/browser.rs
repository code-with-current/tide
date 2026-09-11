//! Native browser surface for the right panel: a WKWebView on macOS, a
//! composition-hosted WebView2 on Windows.
//!
//! Both are real native content the GPUI renderer does not own, so three
//! invariants keep them honest:
//!
//! - Geometry: the surface's content area syncs the native frame from element
//!   layout every frame, deduplicated so an unchanged frame costs nothing.
//! - Visibility: [`Tide`] recomputes "should the webview be on screen" once
//!   per frame — panel visible, Browser tab active, no settings page — and
//!   pushes it down here. On a window without GPUI's overlay plane the live
//!   view also swaps for a frozen snapshot while a menu or popover is open,
//!   because GPUI could not otherwise paint above it.
//! - Threading: native callbacks arrive on the main run loop, possibly while
//!   GPUI is mid-update, so they never touch entities directly. Each handler
//!   records intent and schedules the entity update on the foreground
//!   executor.
//!
//! The two platforms differ in how much of the window they take over. AppKit
//! puts the WKWebView in the view hierarchy and routes input to it; Windows
//! renders WebView2 into one of GPUI's own composition visuals and receives
//! nothing, so this module forwards mouse input, cursor and focus by hand.
//! [`host`] carries the detail.
//!
//! [`Tide`]: crate::app::Tide

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    App, Context, Div, DragMoveEvent, Entity, FocusHandle, Focusable, HitboxBehavior, Hsla,
    IntoElement, MouseButton, MouseDownEvent, ObjectFit, Render, SharedString, Stateful,
    Subscription, Window, canvas, div, hsla, img, prelude::*, px,
};
use gpui::{AsyncApp, ForegroundExecutor, WeakEntity};

use crate::input::{InputEvent, TextInput};
use crate::theme::{Theme, sp};
use crate::ui::icon;
use crate::ui::menu::{ContextMenuHandle, MenuAlign, MenuItem, dropdown_menu};
use crate::ui::text_field::TextField;
use crate::ui::tooltip::Tooltip;
use crate::{
    BrowserBack, BrowserDevtools, BrowserForward, BrowserHardReload, BrowserReload, BrowserStop,
    FocusBrowserAddress, WebviewCopy, WebviewCut, WebviewPaste, WebviewSelectAll,
};

const TOOLBAR_HEIGHT: f32 = 42.0;
/// The device toolbar: a slimmer second row under the main one while
/// device mode is on, like Chrome's device-mode strip.
const DEVICE_TOOLBAR_HEIGHT: f32 = 32.0;
/// Mirror Safari's UA so sites serve the webview their real desktop build.
#[cfg(target_os = "macos")]
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

/// The agent's page-side half, injected verbatim from `browser_agent.js`
/// before any of the page's own scripts run — wry installs it as a
/// document-creation user script on macOS, `AddScriptToExecuteOnDocumentCreated`
/// does it on Windows. Agent evals answer with the JSON strings
/// `window.__tideSnapshot()` produces. Chromeless twins load it too —
/// harmless, they never call it.
#[cfg(any(target_os = "macos", target_os = "windows"))]
const BROWSER_AGENT_JS: &str = include_str!("browser_agent.js");

/// What the address input resolves to when the user submits it.
#[derive(Debug, PartialEq, Eq)]
enum AddressTarget {
    Url(String),
    Search(String),
}

/// Safari-style omnibox resolution: explicit schemes pass through, host-like
/// text gets a scheme guessed for it, anything else becomes a web search.
fn resolve_address(raw: &str) -> Option<AddressTarget> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let has_scheme = trimmed.split_once(':').is_some_and(|(scheme, rest)| {
        !scheme.is_empty()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
            && scheme
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
            && (rest.starts_with("//") || matches!(scheme, "about" | "data" | "mailto" | "file"))
    });
    if has_scheme {
        return Some(AddressTarget::Url(trimmed.to_owned()));
    }

    if trimmed.contains(char::is_whitespace) {
        return Some(AddressTarget::Search(trimmed.to_owned()));
    }

    let authority = trimmed.split(['/', '?', '#']).next().unwrap_or(trimmed);
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host, true)
        }
        Some(_) => return Some(AddressTarget::Search(trimmed.to_owned())),
        None => (authority, false),
    };
    let is_ip = !host.is_empty()
        && host.chars().all(|c| c.is_ascii_digit() || c == '.')
        && host.split('.').count() == 4;
    let is_local = host.eq_ignore_ascii_case("localhost") || is_ip;
    let host_like = is_local
        || (host.contains('.')
            && !host.starts_with('.')
            && !host.ends_with('.')
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-')));

    if !host_like {
        return Some(AddressTarget::Search(trimmed.to_owned()));
    }
    // Dev servers rarely speak TLS; the public web rarely speaks anything else.
    let scheme = if is_local || (port && host.eq_ignore_ascii_case("localhost")) {
        "http"
    } else {
        "https"
    };
    Some(AddressTarget::Url(format!("{scheme}://{trimmed}")))
}

fn search_url(query: &str) -> String {
    let mut encoded = String::with_capacity(query.len() * 3);
    for byte in query.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    format!("https://www.google.com/search?q={encoded}")
}

fn is_secure_url(url: &str) -> bool {
    url.starts_with("https://")
}

/// The address bar hides `https://` the way Safari does; everything else —
/// including `http://` — stays visible because it is information.
fn display_url(url: &str) -> &str {
    url.strip_prefix("https://").unwrap_or(url)
}

// ── Mermaid diagrams ───────────────────────────────────────────────────────

/// The page a mermaid diagram renders in: mermaid.js from the CDN, styling
/// that follows the app's color scheme, the diagram stretched to the full
/// width of the browser surface on the mode's ground. The diagram source is
/// embedded — HTML-escaped — in the `<pre class="mermaid">` that
/// `startOnLoad` renders as soon as the script is ready.
fn mermaid_document(source: &str, dark: bool) -> String {
    let (ground, theme) = if dark {
        ("#1e1e1e", "dark")
    } else {
        ("#ffffff", "default")
    };
    format!(
        "<!doctype html>\
<html>\
<head>\
<meta charset=\"utf-8\">\
<title>Mermaid diagram</title>\
<style>\
html, body {{ margin: 0; background: {ground}; }}\
body {{ box-sizing: border-box; min-height: 100vh; padding: 24px 0; }}\
pre.mermaid {{ margin: 0; background: transparent; }}\
pre.mermaid svg {{ display: block; width: 100% !important; max-width: none !important; height: auto !important; }}\
</style>\
<script src=\"https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js\"></script>\
<script>mermaid.initialize({{ startOnLoad: true, theme: '{theme}' }});</script>\
</head>\
<body>\
<pre class=\"mermaid\">{}</pre>\
</body>\
</html>",
        escape_html(source)
    )
}

/// Escape text for embedding in HTML element content.
fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn is_url_unreserved(byte: u8) -> bool {
    matches!(
        byte,
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~'
    )
}

/// Percent-encode everything but the URL-unreserved bytes. `load_url` hands
/// the string to `NSURL::URLWithString` (via wry), which returns nil — and
/// wry unwraps — for any raw space, quote or non-ASCII byte, so the encoded
/// form must be exhaustive rather than minimal.
fn percent_encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if is_url_unreserved(byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// A mermaid diagram as a self-contained `data:text/html` URL the browser
/// surface can navigate to directly — no temp file, no server; the only
/// network the page touches is the mermaid.js CDN script tag.
pub fn mermaid_data_url(source: &str, dark: bool) -> String {
    format!(
        "data:text/html;charset=utf-8,{}",
        percent_encode(&mermaid_document(source, dark))
    )
}

#[cfg(target_os = "macos")]
mod host {
    use std::cell::Cell;
    use std::ffi::c_void;
    use std::ptr::null_mut;

    use gpui::{Bounds, Pixels};
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
    use objc2_app_kit::{NSApplication, NSEventType, NSView, NSWindow};
    use objc2_foundation::{
        MainThreadMarker, NSDictionary, NSKeyValueChangeKey, NSKeyValueObservingOptions,
        NSObjectNSKeyValueObserverRegistration, NSObjectProtocol, NSProcessInfo, NSString,
        ns_string,
    };
    use objc2_web_kit::WKWebView;
    use wry::WebViewExtMacOS;
    use wry::dpi::{LogicalPosition, LogicalSize};

    /// Whether AppKit is currently dispatching (or just dispatched) a mouse
    /// press — the discriminator between a user's click handing the page the
    /// keyboard and a page script pulling it over on its own: a click-driven
    /// responder change happens inside that click's dispatch, so the current
    /// event is a fresh press; a script's `focus()` fires from a WebKit
    /// callout with only a stale event behind it.
    fn recent_user_gesture() -> bool {
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        let Some(event) = NSApplication::sharedApplication(mtm).currentEvent() else {
            return false;
        };
        let pressed = matches!(
            event.r#type(),
            NSEventType::LeftMouseDown
                | NSEventType::LeftMouseUp
                | NSEventType::RightMouseDown
                | NSEventType::OtherMouseDown
        );
        pressed && NSProcessInfo::processInfo().systemUptime() - event.timestamp() < 0.5
    }

    pub(super) struct ResponderObserverIvars {
        window: Retained<NSWindow>,
        handler: Box<dyn Fn(bool)>,
    }

    define_class!(
        #[unsafe(super(objc2::runtime::NSObject))]
        #[ivars = ResponderObserverIvars]
        pub(super) struct ResponderObserver;

        /// NSKeyValueObserving: the window's `firstResponder` is documented
        /// KVO-compliant, and observing it is the only push signal for native
        /// focus moves — the webview taking or losing the keyboard produces
        /// no GPUI event at all.
        impl ResponderObserver {
            #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
            fn observe_value_for_key_path(
                &self,
                key_path: Option<&NSString>,
                _of_object: Option<&AnyObject>,
                _change: Option<&NSDictionary<NSKeyValueChangeKey, AnyObject>>,
                _context: *mut c_void,
            ) {
                if key_path.is_some_and(|path| path.isEqualToString(ns_string!("firstResponder"))) {
                    (self.ivars().handler)(recent_user_gesture());
                }
            }
        }

        unsafe impl NSObjectProtocol for ResponderObserver {}
    );

    impl ResponderObserver {
        fn new(window: Retained<NSWindow>, handler: Box<dyn Fn(bool)>) -> Retained<Self> {
            let observer = Self::alloc().set_ivars(ResponderObserverIvars { window, handler });
            let observer: Retained<Self> = unsafe { msg_send![super(observer), init] };
            unsafe {
                observer
                    .ivars()
                    .window
                    .addObserver_forKeyPath_options_context(
                        &observer,
                        ns_string!("firstResponder"),
                        NSKeyValueObservingOptions::New,
                        null_mut(),
                    );
            }
            observer
        }
    }

    impl Drop for ResponderObserver {
        fn drop(&mut self) {
            unsafe {
                self.ivars()
                    .window
                    .removeObserver_forKeyPath(self, ns_string!("firstResponder"));
            }
        }
    }

    /// The wry webview plus deduplication state, so per-frame syncs only call
    /// into AppKit when geometry or visibility actually changed.
    pub(super) struct WebviewHost {
        pub webview: wry::WebView,
        wk: Retained<WKWebView>,
        last_bounds: Cell<Option<(i32, i32, i32, i32)>>,
        visible: Cell<bool>,
        /// Watches the window's first responder; dropped (and unregistered)
        /// with the host.
        _responder_observer: Option<Retained<ResponderObserver>>,
    }

    impl WebviewHost {
        pub fn new(webview: wry::WebView, on_responder_change: Box<dyn Fn(bool)>) -> Self {
            let wk: Retained<WKWebView> = Retained::into_super(webview.webview());
            lower_below_scene_overlay(&wk);
            let responder_observer = wk
                .window()
                .map(|window| ResponderObserver::new(window, on_responder_change));
            Self {
                webview,
                wk,
                last_bounds: Cell::new(None),
                visible: Cell::new(false),
                _responder_observer: responder_observer,
            }
        }

        pub fn wk(&self) -> &WKWebView {
            &self.wk
        }

        pub fn ns_view(&self) -> &NSView {
            &self.wk
        }

        /// Override the user agent for subsequent navigations, or restore
        /// the Safari mirror the builder installed — clearing to `nil`
        /// would fall back to WebKit's own default, which no longer matches
        /// what the rest of the app reports.
        pub fn set_custom_user_agent(&self, user_agent: Option<&str>) {
            let agent = user_agent.unwrap_or(super::USER_AGENT);
            unsafe { self.wk.setCustomUserAgent(Some(&NSString::from_str(agent))) };
        }

        /// Page zoom for device mode: wry's cross-platform `zoom` —
        /// `setPageZoom` here. The webview's frame carries the scale, so the
        /// page keeps laying out at the device's CSS size while rendering
        /// at the zoomed size; callers deduplicate, so this only runs when
        /// the factor actually changes.
        pub fn set_zoom(&self, factor: f64) {
            let _ = self.webview.zoom(factor);
        }

        /// Evaluate `script` and hand the outcome to `done`: `Ok` carrying
        /// the script's result as a string — the agent serializer always
        /// answers with JSON — or `Err` with the WebKit error. The
        /// completion runs on the main thread inside a WebKit callout, so
        /// `done` must hop through `Deferred` before it touches anything
        /// GPUI owns (the surface passes one in). `Send` is deliberately
        /// absent: both platforms invoke on the UI thread, and the hop
        /// handle is main-thread-only by nature.
        pub fn evaluate_json(&self, script: &str, done: Box<dyn FnOnce(Result<String, String>)>) {
            use objc2_foundation::NSError;

            // Blocks are typed as callable more than once; a completion
            // that fired twice would answer twice, so the callback rides in
            // a `Cell` taken on its one call.
            let done = Cell::new(Some(done));
            let completion =
                block2::RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                    let done = done.take().expect("WebKit called the completion twice");
                    done(
                        match (unsafe { result.as_ref() }, unsafe { error.as_ref() }) {
                            (Some(result), None) => result
                                .downcast_ref::<NSString>()
                                .map(|text| Ok(text.to_string()))
                                .unwrap_or_else(|| {
                                    // Anything else — a page clobbered
                                    // `window.__tideSnapshot` and made the
                                    // eval resolve to a non-string — is a
                                    // contract breach the engine can only
                                    // report, not parse.
                                    Err("the script did not return a string".to_owned())
                                }),
                            (_, Some(error)) => Err(error.localizedDescription().to_string()),
                            (None, None) => Err("the script returned no value".to_owned()),
                        },
                    );
                });
            unsafe {
                self.wk().evaluateJavaScript_completionHandler(
                    &NSString::from_str(script),
                    Some(&completion),
                );
            }
        }

        /// GPUI window coordinates are top-left-origin logical points, which is
        /// exactly wry's child-bounds convention. Wry quantizes the native
        /// frame to whole points, and panel drags produce fractional layouts —
        /// left un-rounded, the frame can land a point off and expose a sliver
        /// of background along an edge. Round each edge (not origin + size) so
        /// every side stays within half a point of the layout rect, and
        /// deduplicate on the rounded rect so per-frame syncs are free.
        /// AppKit lays the view out in the same logical points GPUI uses, so
        /// the scale factor is only of interest to the Windows host.
        pub fn sync_bounds(&self, bounds: Bounds<Pixels>, _scale: f32) {
            let left = f32::from(bounds.origin.x).round() as i32;
            let top = f32::from(bounds.origin.y).round() as i32;
            let right = f32::from(bounds.origin.x + bounds.size.width).round() as i32;
            let bottom = f32::from(bounds.origin.y + bounds.size.height).round() as i32;
            if self.last_bounds.get() == Some((left, top, right, bottom)) {
                return;
            }
            self.last_bounds.set(Some((left, top, right, bottom)));
            let _ = self.webview.set_bounds(wry::Rect {
                position: LogicalPosition::new(f64::from(left), f64::from(top)).into(),
                size: LogicalSize::new(f64::from(right - left), f64::from(bottom - top)).into(),
            });
        }

        pub fn set_visible(&self, visible: bool) {
            if self.visible.get() == visible {
                return;
            }
            self.visible.set(visible);
            let _ = self.webview.set_visible(visible);
        }

        /// Whether the native first responder is the webview (or one of its
        /// internal views) — i.e. plain keystrokes currently go to the page,
        /// not to GPUI.
        pub fn native_focus_within(&self) -> bool {
            let view = self.ns_view();
            let Some(window) = view.window() else {
                return false;
            };
            window.firstResponder().is_some_and(|responder| {
                responder
                    .downcast_ref::<NSView>()
                    .is_some_and(|responder| responder.isDescendantOf(view))
            })
        }
    }

    /// GPUI's scene-overlay view — the transparent plane its menus and
    /// tooltips composite on — is added to the window before this webview
    /// existed, and AppKit stacks later siblings on top. Left alone, a fresh
    /// webview would cover the overlay and every menu with it; re-anchor the
    /// webview just beneath the overlay plane.
    fn lower_below_scene_overlay(view: &NSView) {
        use objc2_app_kit::NSWindowOrderingMode;

        let Some(superview) = (unsafe { view.superview() }) else {
            return;
        };
        for sibling in superview.subviews().iter() {
            if sibling.class().name() == c"GPUIOverlayView" {
                superview.addSubview_positioned_relativeTo(
                    view,
                    NSWindowOrderingMode::Below,
                    Some(&sibling),
                );
                return;
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod host {
    //! WebView2 composited inside GPUI's own visual tree.
    //!
    //! The obvious way to embed WebView2 — and what wry does — is windowed
    //! hosting: the controller owns a child HWND of the app's window. Windows
    //! composites child windows above the swap chain unconditionally, so a
    //! GPUI menu or tooltip drawn over the page is simply not visible. The
    //! only escapes are hiding the page while an overlay is open or freezing
    //! it to a bitmap, and neither survives contact with a video call or a
    //! page that is still scrolling.
    //!
    //! Visual hosting is the supported answer. A composition controller
    //! renders into a DirectComposition visual instead of an HWND, and the
    //! pinned gpui fork already prepares the slot:
    //! `DirectCompositionRenderer::create_portal` inserts an empty
    //! `IDCompositionVisual` into `portal_container`, which sits between the
    //! base and overlay swap chains —
    //!
    //! ```text
    //! root_visual.AddVisual(&portal_container, true, &base_visual)
    //! root_visual.AddVisual(&overlay_visual,  true, &portal_container)
    //! ```
    //!
    //! — so the page composites above GPUI's ordinary content and below its
    //! menus, tooltips and dialogs, with the portal's rectangle clip handling
    //! the panel edge. The visual comes from GPUI's own `IDCompositionDevice`,
    //! which is what `SetRootVisualTarget` requires, and gpui and
    //! webview2-com are both built against `windows` 0.61, so the handle
    //! crosses untouched.
    //!
    //! An ordinary `ICoreWebView2Controller` cannot be upgraded to a
    //! composition controller after the fact — only the environment creates
    //! one — so none of this is reachable through wry's `WebViewExtWindows`,
    //! and Tide drives `webview2-com` directly rather than carrying a wry
    //! fork. It uses a narrow slice of it (bounds, visibility, focus,
    //! navigation, six events), so there is little of wry's custom-protocol,
    //! IPC and window-lifecycle machinery to give up.
    //!
    //! The cost is input: a visual has no window, so WebView2 receives
    //! nothing on its own. Everything from `mouse_down` down exists to put
    //! that back — buttons, movement, wheel and leave are forwarded from
    //! GPUI's window events through `SendMouseInput`, the cursor comes back
    //! through `CursorChanged`, and focus is driven explicitly with
    //! `MoveFocus`. Keyboard and IME still flow through the controller's own
    //! internal input window once it holds focus. Pen and touch
    //! (`SendPointerInput`), external drag and drop
    //! (`ICoreWebView2CompositionController3`), the accessibility provider
    //! (`ICoreWebView2CompositionController2::AutomationProvider`) and
    //! rebinding the visual after GPU device loss are not implemented.
    //!
    //! longbridge/gpui-component#2626 carries a longer write-up of the same
    //! contract under `crates/webview/WEBVIEW_OVERLAY_RESEARCH.md`.

    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    use gpui::{
        Bounds, CursorStyle, Modifiers, MouseButton, Pixels, PlatformNativeSurface, Point,
        ScrollDelta,
    };
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        CapturePreviewCompletedHandler, CreateCoreWebView2CompositionControllerCompletedHandler,
        CreateCoreWebView2EnvironmentCompletedHandler, CursorChangedEventHandler,
        DocumentTitleChangedEventHandler, ExecuteScriptCompletedHandler, FocusChangedEventHandler,
        MoveFocusRequestedEventHandler, NavigationCompletedEventHandler,
        NavigationStartingEventHandler, NewWindowRequestedEventHandler, SourceChangedEventHandler,
        take_pwstr,
    };
    use windows::Win32::Foundation::{E_FAIL, E_NOINTERFACE, HGLOBAL, HWND, POINT, RECT};
    // `CreateStreamOnHGlobal` lives in a `windows`-crate feature Tide itself
    // never names — the feature set is unified across the dependency graph
    // and GPUI's Windows backend asks for it, so the binding resolves without
    // Cargo.toml churn here.
    use windows::Win32::System::Com::IStream;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::core::{BOOL, HSTRING, IUnknown, Interface, PCWSTR, PWSTR};

    use super::PageLoad;

    /// Entity updates the page pushes back into [`super::BrowserView`]. Each
    /// is called on the UI thread from a WebView2 event and hops through
    /// `Deferred`, so none may assume the app is un-borrowed.
    pub(super) struct Callbacks {
        pub page_load: Box<dyn Fn(PageLoad, String)>,
        pub url_changed: Box<dyn Fn(String)>,
        pub title: Box<dyn Fn(String)>,
        pub open_url: Box<dyn Fn(String)>,
        pub cursor_changed: Box<dyn Fn()>,
        pub focus_changed: Box<dyn Fn()>,
    }

    /// Delivers the finished host — or the reason there isn't one — exactly
    /// once, from whichever of the two creation callbacks gets there first.
    type Ready = Rc<RefCell<Option<Box<dyn FnOnce(Result<Rc<WebviewHost>, String>)>>>>;

    fn deliver(ready: &Ready, outcome: Result<Rc<WebviewHost>, String>) {
        if let Some(ready) = ready.borrow_mut().take() {
            ready(outcome);
        }
    }

    /// Where WebView2 keeps its profile: per-user, beside the rest of Tide's
    /// data, so a per-user install never needs to write into its own
    /// program directory.
    fn user_data_folder() -> Option<HSTRING> {
        let path = dirs::data_local_dir()?
            .join(protocol::identity::DATA_DIRECTORY_NAME)
            .join("WebView2");
        std::fs::create_dir_all(&path).ok()?;
        Some(HSTRING::from(path.as_path()))
    }

    /// The committed URL, or an empty string when WebView2 has none yet.
    fn source_of(webview: &ICoreWebView2) -> String {
        let mut uri = PWSTR::null();
        match unsafe { webview.Source(&mut uri) } {
            Ok(()) => take_pwstr(uri),
            Err(_) => String::new(),
        }
    }

    /// Drain a stream WebView2 just wrote into raw bytes: size it by
    /// seeking to the end, rewind, then read back until the stream runs
    /// dry. `IStream::Read` may return short without erroring, so the loop
    /// is what makes the buffer whole.
    fn stream_bytes(stream: &IStream) -> windows::core::Result<Vec<u8>> {
        use windows::Win32::System::Com::{STREAM_SEEK_END, STREAM_SEEK_SET};

        unsafe {
            let mut end = 0u64;
            stream.Seek(0, STREAM_SEEK_END, Some(&mut end))?;
            stream.Seek(0, STREAM_SEEK_SET, None)?;
            // A viewport PNG is megabytes at worst; the cap only keeps a
            // corrupt stream's huge size from aborting the allocation.
            let mut bytes = vec![0u8; end.min(u32::MAX as u64) as usize];
            let mut filled = 0usize;
            while filled < bytes.len() {
                let mut read = 0u32;
                stream
                    .Read(
                        bytes[filled..].as_mut_ptr().cast(),
                        (bytes.len() - filled) as u32,
                        Some(&mut read),
                    )
                    .ok()?;
                if read == 0 {
                    break;
                }
                filled += read as usize;
            }
            bytes.truncate(filled);
            Ok(bytes)
        }
    }

    /// The system's lines- and characters-per-notch wheel preferences, which
    /// GPUI has already multiplied into the deltas it reports. Read once:
    /// they are a user setting, and this is on the wheel path.
    fn wheel_scroll_preferences() -> (f32, f32) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SPI_GETWHEELSCROLLCHARS, SPI_GETWHEELSCROLLLINES, SystemParametersInfoW,
        };

        let read = |action| {
            let mut value: u32 = 0;
            let read = unsafe {
                SystemParametersInfoW(action, 0, std::ptr::from_mut(&mut value).cast(), 0)
            };
            (read != 0 && value != 0).then_some(value as f32)
        };
        (
            read(SPI_GETWHEELSCROLLLINES).unwrap_or(3.0),
            read(SPI_GETWHEELSCROLLCHARS).unwrap_or(3.0),
        )
    }

    /// System cursor ids from `ICoreWebView2CompositionController::\
    /// SystemCursorId`, mapped onto the GPUI styles the page area asks for.
    ///
    /// The interface hands back a raw `HCURSOR` too, but setting that
    /// directly fights GPUI, which reasserts its own cursor on every
    /// `WM_SETCURSOR`. Going through `Styled::cursor` instead makes the
    /// page's cursor one more thing GPUI composites.
    fn cursor_style_for(id: u32) -> CursorStyle {
        // `IDC_*` from WinUser.h — resource ordinals, not handles, so they
        // are stable and comparable.
        match id {
            32513 => CursorStyle::IBeam,
            32515 => CursorStyle::Crosshair,
            32642 => CursorStyle::ResizeUpLeftDownRight,
            32643 => CursorStyle::ResizeUpRightDownLeft,
            32644 => CursorStyle::ResizeLeftRight,
            32645 => CursorStyle::ResizeUpDown,
            32646 => CursorStyle::ClosedHand,
            32648 => CursorStyle::OperationNotAllowed,
            32649 => CursorStyle::PointingHand,
            // 32512 IDC_ARROW, plus 32514 IDC_WAIT and 32650
            // IDC_APPSTARTING: GPUI has no busy cursor, and a page that is
            // merely slow should not change the pointer under the user.
            _ => CursorStyle::Arrow,
        }
    }

    /// Which `COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS` bit a button holds down.
    fn button_bit(button: MouseButton) -> Option<i32> {
        Some(
            match button {
                MouseButton::Left => COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON,
                MouseButton::Right => COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_RIGHT_BUTTON,
                MouseButton::Middle => COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_MIDDLE_BUTTON,
                // Back and forward are the surface's own toolbar actions;
                // forwarding them as well would navigate twice.
                MouseButton::Navigate(_) => return None,
            }
            .0,
        )
    }

    /// Hand the keyboard back to GPUI's window.
    fn focus_window(parent: isize) {
        use windows_sys::Win32::Foundation::HWND as SysHwnd;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;

        unsafe { SetFocus(parent as SysHwnd) };
    }

    /// The `ICoreWebView2` behind the surface, exposing the same handful of
    /// operations the macOS host does so the shared call sites in
    /// [`super::BrowserView`] stay platform-free.
    pub(super) struct Webview(ICoreWebView2);

    impl Webview {
        pub fn can_go_back(&self) -> windows::core::Result<bool> {
            let mut value = BOOL(0);
            unsafe { self.0.CanGoBack(&mut value) }?;
            Ok(value.as_bool())
        }

        pub fn can_go_forward(&self) -> windows::core::Result<bool> {
            let mut value = BOOL(0);
            unsafe { self.0.CanGoForward(&mut value) }?;
            Ok(value.as_bool())
        }

        pub fn go_back(&self) -> windows::core::Result<()> {
            unsafe { self.0.GoBack() }
        }

        pub fn go_forward(&self) -> windows::core::Result<()> {
            unsafe { self.0.GoForward() }
        }

        pub fn reload(&self) -> windows::core::Result<()> {
            unsafe { self.0.Reload() }
        }

        pub fn stop(&self) -> windows::core::Result<()> {
            unsafe { self.0.Stop() }
        }

        pub fn load_url(&self, url: &str) -> windows::core::Result<()> {
            unsafe { self.0.Navigate(&HSTRING::from(url)) }
        }

        /// Fire and forget: nothing in the surface reads a script's result,
        /// and passing no completion handler keeps the call synchronous from
        /// the caller's point of view.
        pub fn evaluate_script(&self, script: &str) -> windows::core::Result<()> {
            unsafe { self.0.ExecuteScript(&HSTRING::from(script), None) }
        }

        /// Agent eval-with-result: the mirror of [`Self::evaluate_script`]
        /// that keeps the answer. WebView2 hands the script's result back
        /// JSON-encoded, so the serializer's string returns arrive as a JSON
        /// string *of* a JSON string — decoded exactly once here (see
        /// [`super::unwrap_execute_script_result`]). The reply fires
        /// whether the completion runs or the call itself fails: a channel
        /// left silent is a bridge left waiting, so the callback rides in a
        /// `Cell` taken on its one call, the same single-fire shape the
        /// macOS host gives its WebKit completion.
        pub fn evaluate_script_with_callback(
            &self,
            script: &str,
            done: Box<dyn FnOnce(Result<String, String>)>,
        ) {
            let done = Rc::new(Cell::new(Some(done)));
            let completion = done.clone();
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, value| {
                let done = completion
                    .take()
                    .expect("WebView2 called the completion twice");
                done(match result {
                    Ok(()) => Ok(super::unwrap_execute_script_result(&value)),
                    Err(error) => Err(error.to_string()),
                });
                Ok(())
            }));
            let invoked = unsafe { self.0.ExecuteScript(&HSTRING::from(script), Some(&handler)) };
            if let Err(error) = invoked
                && let Some(done) = done.take()
            {
                done(Err(error.to_string()));
            }
        }

        /// Agent screenshot: `CapturePreview` is WebView2's own PNG encode,
        /// so unlike the macOS capture there is no pixel repacking — only
        /// the stream it wrote, drained in the completion. The reply's
        /// single-fire shape matches [`Self::evaluate_script_with_callback`].
        pub fn capture_preview(&self, done: Box<dyn FnOnce(Result<Vec<u8>, String>)>) {
            let done = Rc::new(Cell::new(Some(done)));
            // A null HGLOBAL gives the stream its own growing memory;
            // release-on-drop returns it.
            let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) };
            let Ok(stream) = stream else {
                if let Some(done) = done.take() {
                    done(Err("the preview stream could not be created".to_owned()));
                }
                return;
            };
            let written = stream.clone();
            let completion = done.clone();
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                let done = completion
                    .take()
                    .expect("WebView2 called the completion twice");
                done(
                    result
                        .and_then(|()| stream_bytes(&written))
                        .map_err(|error| error.to_string()),
                );
                Ok(())
            }));
            let invoked = unsafe {
                self.0.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &handler,
                )
            };
            if let Err(error) = invoked
                && let Some(done) = done.take()
            {
                done(Err(error.to_string()));
            }
        }

        /// WebView2 has no "close" or "is open" counterpart — the devtools
        /// window is the user's from here on.
        pub fn open_devtools(&self) -> windows::core::Result<()> {
            unsafe { self.0.OpenDevToolsWindow() }
        }
    }

    pub(super) struct WebviewHost {
        pub(super) webview: Webview,
        controller: ICoreWebView2Controller,
        composition: ICoreWebView2CompositionController,
        /// GPUI's slot in the composition tree, which owns the page's
        /// position and clip. WebView2's own bounds only set the raster size.
        surface: Rc<dyn PlatformNativeSurface>,
        /// GPUI's window, for handing the keyboard back.
        parent: isize,
        last_bounds: Cell<Option<Bounds<Pixels>>>,
        /// Window-space origin of the page area and the window's scale, kept
        /// so a forwarded mouse position can be put into the page's own
        /// device-pixel space without a round trip through GPUI.
        origin: Cell<Point<Pixels>>,
        scale: Cell<f32>,
        visible: Cell<bool>,
        focused: Rc<Cell<bool>>,
        cursor: Rc<Cell<CursorStyle>>,
        /// Buttons currently held, so a move or wheel during a drag reports
        /// them the way Win32 would.
        buttons: Cell<i32>,
        hovered: Cell<bool>,
        wheel_scroll: (f32, f32),
        /// The runtime's user agent as created, read once at attach so a
        /// released preset override can replay it (`Settings.UserAgent`
        /// has no unset).
        default_user_agent: Option<String>,
    }

    impl WebviewHost {
        /// Override the user agent for subsequent navigations, or replay the
        /// runtime default captured at attach. Silently no-ops on runtimes
        /// too old for `ICoreWebView2Settings2`.
        pub fn set_custom_user_agent(&self, user_agent: Option<&str>) {
            let Some(value) = user_agent
                .map(HSTRING::from)
                .or_else(|| self.default_user_agent.clone().map(HSTRING::from))
            else {
                return;
            };
            if let Ok(settings) = unsafe { self.webview.0.Settings() }
                && let Ok(settings) = settings.cast::<ICoreWebView2Settings2>()
            {
                let _ = unsafe { settings.SetUserAgent(&value) };
            }
        }

        /// Page zoom for device mode: the controller's zoom factor. The
        /// composition slot's bounds carry the scale, so the page keeps
        /// laying out at the device's CSS size while rendering at the
        /// zoomed size; callers deduplicate, so this only runs when the
        /// factor actually changes.
        pub fn set_zoom(&self, factor: f64) {
            let _ = unsafe { self.controller.SetZoomFactor(factor) };
        }

        /// Build a composition-hosted WebView2 and hand it back once it
        /// exists.
        ///
        /// Creation is genuinely asynchronous — the environment and the
        /// controller each complete on a posted message — and it stays that
        /// way here. webview2-com offers `wait_for_async_operation`, which
        /// pumps a nested message loop, but running one from inside an entity
        /// update invites a re-entrant `WM_PAINT` and a panicking borrow. The
        /// surface simply has no host for the first few frames, which it
        /// already handles.
        pub fn create(
            parent: isize,
            surface: Rc<dyn PlatformNativeSurface>,
            transparent: bool,
            callbacks: Callbacks,
            ready: Box<dyn FnOnce(Result<Rc<WebviewHost>, String>)>,
        ) {
            let ready: Ready = Rc::new(RefCell::new(Some(ready)));
            let Some(user_data) = user_data_folder() else {
                deliver(&ready, Err("no local application data folder".to_owned()));
                return;
            };

            let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new({
                let ready = ready.clone();
                move |result, environment| {
                    match result.and_then(|()| environment.ok_or_else(|| E_FAIL.into())) {
                        Ok(environment) => create_controller(
                            parent,
                            surface,
                            transparent,
                            environment,
                            callbacks,
                            ready,
                        ),
                        Err(error) => deliver(&ready, Err(error.to_string())),
                    }
                    Ok(())
                }
            }));

            let created = unsafe {
                CreateCoreWebView2EnvironmentWithOptions(
                    PCWSTR::null(),
                    &user_data,
                    None::<&ICoreWebView2EnvironmentOptions>,
                    &handler,
                )
            };
            if let Err(error) = created {
                deliver(&ready, Err(error.to_string()));
            }
        }

        /// Agent eval-with-result, routed through WebView2's `ExecuteScript`
        /// completion; see [`Webview::evaluate_script_with_callback`] for
        /// how the answer is shaped and guaranteed to fire once.
        pub fn evaluate_json(&self, script: &str, done: Box<dyn FnOnce(Result<String, String>)>) {
            self.webview.evaluate_script_with_callback(script, done);
        }

        /// Agent screenshot, routed through WebView2's `CapturePreview`; the
        /// bytes come back PNG-encoded, ready for base64 up in the caller.
        pub fn capture_preview(&self, done: Box<dyn FnOnce(Result<Vec<u8>, String>)>) {
            self.webview.capture_preview(done);
        }

        /// Called from the element's paint callback every frame, so an
        /// unchanged rect must cost nothing.
        ///
        /// The portal carries the position and the clip; WebView2's own
        /// bounds start at the origin and only give the page its raster size.
        /// Both are device pixels, which is
        /// `COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS`, the default.
        pub fn sync_bounds(&self, bounds: Bounds<Pixels>, scale: f32) {
            self.origin.set(bounds.origin);
            if self.last_bounds.get() == Some(bounds) && self.scale.get() == scale {
                return;
            }
            self.last_bounds.set(Some(bounds));

            if self.scale.replace(scale) != scale
                && let Ok(controller) = self.controller.cast::<ICoreWebView2Controller3>()
            {
                let _ = unsafe { controller.SetRasterizationScale(scale as f64) };
            }

            let device = bounds.to_device_pixels(scale);
            let _ = self.surface.set_bounds(device);
            let _ = unsafe {
                self.controller.SetBounds(RECT {
                    left: 0,
                    top: 0,
                    right: device.size.width.0.max(0),
                    bottom: device.size.height.0.max(0),
                })
            };
        }

        pub fn set_visible(&self, visible: bool) {
            if self.visible.get() == visible {
                return;
            }
            self.visible.set(visible);
            // Hand the keyboard back before hiding, not after: a hidden page
            // that still owns focus swallows every key GPUI expects.
            if !visible {
                if self.focused.get() {
                    focus_window(self.parent);
                }
                self.mouse_leave();
            }
            let _ = unsafe { self.controller.SetIsVisible(visible) };
            let _ = self.surface.set_visible(visible);
        }

        /// Whether the keyboard currently belongs to the page.
        ///
        /// Driven by the controller's own `GotFocus`/`LostFocus` rather than
        /// by probing `GetFocus`: visual hosting gives WebView2 no window of
        /// ours to descend from, and the events are the documented signal.
        pub fn native_focus_within(&self) -> bool {
            self.focused.get()
        }

        pub fn focus_page(&self) {
            let _ = unsafe {
                self.controller
                    .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
            };
        }

        pub fn focus_parent(&self) {
            focus_window(self.parent);
        }

        /// The cursor the page last asked for, which the page area applies
        /// through `Styled::cursor`.
        pub fn cursor_style(&self) -> CursorStyle {
            self.cursor.get()
        }

        pub fn mouse_down(
            &self,
            button: MouseButton,
            position: Point<Pixels>,
            modifiers: Modifiers,
            click_count: usize,
        ) {
            let Some(bit) = button_bit(button) else {
                return;
            };
            self.buttons.set(self.buttons.get() | bit);
            // WebView2 wants the second click of a pair reported as a
            // double-click; triples and beyond it works out itself from the
            // repeated downs.
            let double = click_count == 2;
            let kind = match (button, double) {
                (MouseButton::Left, false) => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
                (MouseButton::Left, true) => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK,
                (MouseButton::Right, false) => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN,
                (MouseButton::Right, true) => {
                    COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOUBLE_CLICK
                }
                (_, false) => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN,
                (_, true) => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOUBLE_CLICK,
            };
            self.send_mouse(kind, modifiers, 0, position);
        }

        pub fn mouse_up(&self, button: MouseButton, position: Point<Pixels>, modifiers: Modifiers) {
            let Some(bit) = button_bit(button) else {
                return;
            };
            self.buttons.set(self.buttons.get() & !bit);
            let kind = match button {
                MouseButton::Left => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
                MouseButton::Right => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP,
                _ => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP,
            };
            self.send_mouse(kind, modifiers, 0, position);
        }

        pub fn mouse_move(&self, position: Point<Pixels>, modifiers: Modifiers) {
            self.hovered.set(true);
            self.send_mouse(COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE, modifiers, 0, position);
        }

        /// The pointer left the page area, or the page went away underneath
        /// it. Without this the last hovered element keeps its hover state
        /// and the cursor never comes back.
        pub fn mouse_leave(&self) {
            if !self.hovered.replace(false) {
                return;
            }
            self.buttons.set(0);
            self.cursor.set(CursorStyle::Arrow);
            let _ = unsafe {
                self.composition.SendMouseInput(
                    COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
                    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
                    0,
                    POINT { x: 0, y: 0 },
                )
            };
        }

        /// GPUI reports wheel movement already multiplied by the system's
        /// lines- and characters-per-notch preferences, and in its own sign
        /// convention — positive means the content moves that way, which is
        /// the opposite of `WM_MOUSEHWHEEL` horizontally. Undo both to get
        /// back to the `WHEEL_DELTA` multiples WebView2 expects.
        pub fn scroll(&self, position: Point<Pixels>, delta: ScrollDelta, modifiers: Modifiers) {
            const WHEEL_DELTA: f32 = 120.0;
            const PIXELS_PER_LINE: f32 = 20.0;

            let (lines_per_notch, chars_per_notch) = self.wheel_scroll;
            let (vertical, horizontal) = match delta {
                ScrollDelta::Lines(delta) => (delta.y, -delta.x),
                // GPUI's Windows backend only produces `Lines`; this is the
                // precise-trackpad shape other platforms send.
                ScrollDelta::Pixels(delta) => {
                    let (x, y) = (f32::from(delta.x), f32::from(delta.y));
                    (y / PIXELS_PER_LINE, -x / PIXELS_PER_LINE)
                }
            };
            for (kind, notches) in [
                (
                    COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL,
                    vertical / lines_per_notch,
                ),
                (
                    COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL,
                    horizontal / chars_per_notch,
                ),
            ] {
                let amount = (notches * WHEEL_DELTA).round() as i32;
                if amount != 0 {
                    self.send_mouse(kind, modifiers, amount as u32, position);
                }
            }
        }

        fn send_mouse(
            &self,
            kind: COREWEBVIEW2_MOUSE_EVENT_KIND,
            modifiers: Modifiers,
            data: u32,
            position: Point<Pixels>,
        ) {
            let origin = self.origin.get();
            let scale = self.scale.get();
            let point = POINT {
                x: (f32::from(position.x - origin.x) * scale).round() as i32,
                y: (f32::from(position.y - origin.y) * scale).round() as i32,
            };
            let mut keys = COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(self.buttons.get());
            if modifiers.control {
                keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_CONTROL;
            }
            if modifiers.shift {
                keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_SHIFT;
            }
            let _ = unsafe { self.composition.SendMouseInput(kind, keys, data, point) };
        }
    }

    impl Drop for WebviewHost {
        fn drop(&mut self) {
            // Without this the browser process outlives the tab.
            let _ = unsafe { self.controller.Close() };
        }
    }

    /// Second half of [`WebviewHost::create`]: the environment exists, so ask
    /// it for a composition controller.
    fn create_controller(
        parent: isize,
        surface: Rc<dyn PlatformNativeSurface>,
        transparent: bool,
        environment: ICoreWebView2Environment,
        callbacks: Callbacks,
        ready: Ready,
    ) {
        let Ok(environment) = environment.cast::<ICoreWebView2Environment3>() else {
            deliver(
                &ready,
                Err("this WebView2 runtime is too old to render into a visual".to_owned()),
            );
            return;
        };

        let handler = CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new({
            let ready = ready.clone();
            move |result, composition| {
                let outcome = result
                    .and_then(|()| composition.ok_or_else(|| E_FAIL.into()))
                    .and_then(|composition| {
                        attach(parent, surface, transparent, composition, callbacks)
                    });
                deliver(&ready, outcome.map_err(|error| error.to_string()));
                Ok(())
            }
        }));

        let created = unsafe {
            environment.CreateCoreWebView2CompositionController(HWND(parent as *mut _), &handler)
        };
        if let Err(error) = created {
            deliver(&ready, Err(error.to_string()));
        }
    }

    /// Bind a freshly created composition controller into GPUI's portal
    /// visual and subscribe to everything the surface renders from.
    fn attach(
        parent: isize,
        surface: Rc<dyn PlatformNativeSurface>,
        transparent: bool,
        composition: ICoreWebView2CompositionController,
        callbacks: Callbacks,
    ) -> windows::core::Result<Rc<WebviewHost>> {
        let visual = surface
            .platform_handle()
            .downcast::<IUnknown>()
            .map_err(|_| windows::core::Error::from(E_NOINTERFACE))?;
        unsafe { composition.SetRootVisualTarget(&*visual) }?;

        let controller: ICoreWebView2Controller = composition.cast()?;
        // The page starts hidden and empty; the surface shows it once its tab
        // is visible and something has been navigated to.
        unsafe { controller.SetIsVisible(false) }?;
        if let Ok(controller) = controller.cast::<ICoreWebView2Controller3>() {
            // GPUI owns DPI: it already re-lays-out and re-renders on a scale
            // change, and `sync_bounds` pushes the new factor down.
            let _ = unsafe { controller.SetShouldDetectMonitorScaleChanges(false) };
        }
        if transparent && let Ok(controller) = controller.cast::<ICoreWebView2Controller2>() {
            // The inline twin's page grounds itself in the host card, so the
            // controller must not paint its own (opaque white) background
            // under a transparent CSS page.
            let _ = unsafe {
                controller.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                    A: 0,
                    R: 0,
                    G: 0,
                    B: 0,
                })
            };
        }

        let webview = unsafe { controller.CoreWebView2() }?;
        // The toolbar has a devtools button, so make sure the runtime agrees
        // they are available. Everything else stays at WebView2's defaults,
        // including the status bar: it draws inside the page raster, so the
        // portal clips it along with everything else, and a link preview on
        // hover is worth having.
        if let Ok(settings) = unsafe { webview.Settings() } {
            let _ = unsafe { settings.SetAreDevToolsEnabled(true) };
        }
        // A mobile preset's user-agent override rides `Settings.UserAgent`,
        // which is live for later navigations. The runtime's own default is
        // captured now: releasing an override replays it, because the
        // property has no "unset".
        let mut default_user_agent = None;
        if let Ok(settings) = unsafe { webview.Settings() }
            && let Ok(settings) = settings.cast::<ICoreWebView2Settings2>()
        {
            let mut value = PWSTR::null();
            if unsafe { settings.UserAgent(&mut value) }.is_ok() {
                default_user_agent = Some(take_pwstr(value));
            }
        }
        // The agent's page-side half has to exist before any of the page's
        // own scripts run; a document-created script is WebView2's injection
        // point, applied to every future document. The completion only
        // reports the id `Remove…` would need, which nothing here ever calls.
        let _ = unsafe {
            webview
                .AddScriptToExecuteOnDocumentCreated(&HSTRING::from(super::BROWSER_AGENT_JS), None)
        };

        let Callbacks {
            page_load,
            url_changed,
            title,
            open_url,
            cursor_changed,
            focus_changed,
        } = callbacks;
        // The surface reconciles the two focus systems from `render`, so a
        // focus move that renders nothing on its own still has to ask for a
        // frame or it is only noticed the next time something else does.
        let focus_changed = Rc::new(focus_changed);
        let page_load = Rc::new(page_load);
        let focused = Rc::new(Cell::new(false));
        let cursor = Rc::new(Cell::new(CursorStyle::Arrow));
        let mut token = 0i64;

        let started = NavigationStartingEventHandler::create(Box::new({
            let page_load = page_load.clone();
            move |_, args| {
                let mut uri = PWSTR::null();
                let uri = match args {
                    Some(args) if unsafe { args.Uri(&mut uri) }.is_ok() => take_pwstr(uri),
                    _ => String::new(),
                };
                page_load(PageLoad::Started, uri);
                Ok(())
            }
        }));
        unsafe { webview.add_NavigationStarting(&started, &mut token) }?;

        let completed = NavigationCompletedEventHandler::create(Box::new({
            let page_load = page_load.clone();
            move |webview, _| {
                let url = webview.as_ref().map(source_of).unwrap_or_default();
                page_load(PageLoad::Finished, url);
                Ok(())
            }
        }));
        unsafe { webview.add_NavigationCompleted(&completed, &mut token) }?;

        // Same-document navigation — a router pushing state — never reaches
        // `NavigationCompleted`, so the address bar and the back button would
        // go stale without this.
        let source = SourceChangedEventHandler::create(Box::new(move |webview, _| {
            if let Some(webview) = webview.as_ref() {
                url_changed(source_of(webview));
            }
            Ok(())
        }));
        unsafe { webview.add_SourceChanged(&source, &mut token) }?;

        let document_title =
            DocumentTitleChangedEventHandler::create(Box::new(move |webview, _| {
                let mut value = PWSTR::null();
                if let Some(webview) = webview.as_ref()
                    && unsafe { webview.DocumentTitle(&mut value) }.is_ok()
                {
                    title(take_pwstr(value));
                }
                Ok(())
            }));
        unsafe { webview.add_DocumentTitleChanged(&document_title, &mut token) }?;

        // One surface, one page: pop-ups and `target="_blank"` links navigate
        // in place instead of spawning windows.
        let new_window = NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args.as_ref() {
                let mut uri = PWSTR::null();
                if unsafe { args.Uri(&mut uri) }.is_ok() {
                    open_url(take_pwstr(uri));
                }
                let _ = unsafe { args.SetHandled(true) };
            }
            Ok(())
        }));
        unsafe { webview.add_NewWindowRequested(&new_window, &mut token) }?;

        let got_focus = FocusChangedEventHandler::create(Box::new({
            let focused = focused.clone();
            let focus_changed = focus_changed.clone();
            move |_, _| {
                focused.set(true);
                focus_changed();
                Ok(())
            }
        }));
        unsafe { controller.add_GotFocus(&got_focus, &mut token) }?;

        let lost_focus = FocusChangedEventHandler::create(Box::new({
            let focused = focused.clone();
            let focus_changed = focus_changed.clone();
            move |_, _| {
                focused.set(false);
                focus_changed();
                Ok(())
            }
        }));
        unsafe { controller.add_LostFocus(&lost_focus, &mut token) }?;

        // Tab off the last control in the page: hand the keyboard back to
        // GPUI rather than let WebView2 cycle inside itself forever.
        let move_focus = MoveFocusRequestedEventHandler::create(Box::new({
            let focused = focused.clone();
            move |_, args| {
                focused.set(false);
                focus_changed();
                focus_window(parent);
                if let Some(args) = args.as_ref() {
                    let _ = unsafe { args.SetHandled(true) };
                }
                Ok(())
            }
        }));
        unsafe { controller.add_MoveFocusRequested(&move_focus, &mut token) }?;

        let cursor_event = CursorChangedEventHandler::create(Box::new({
            let cursor = cursor.clone();
            move |composition, _| {
                let mut id = 0u32;
                if let Some(composition) = composition.as_ref()
                    && unsafe { composition.SystemCursorId(&mut id) }.is_ok()
                {
                    let style = cursor_style_for(id);
                    if cursor.replace(style) != style {
                        cursor_changed();
                    }
                }
                Ok(())
            }
        }));
        unsafe { composition.add_CursorChanged(&cursor_event, &mut token) }?;

        Ok(Rc::new(WebviewHost {
            webview: Webview(webview),
            controller,
            composition,
            surface,
            parent,
            last_bounds: Cell::new(None),
            origin: Cell::new(Point::default()),
            scale: Cell::new(1.0),
            visible: Cell::new(false),
            focused,
            cursor,
            buttons: Cell::new(0),
            hovered: Cell::new(false),
            wheel_scroll: wheel_scroll_preferences(),
            default_user_agent,
        }))
    }
}

/// GPUI's `HWND`, or zero when the window has no native handle yet.
#[cfg(target_os = "windows")]
fn window_hwnd(window: &Window) -> isize {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    // GPUI has its own inherent `window_handle`, so the trait method needs
    // naming explicitly.
    match HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()) {
        Ok(RawWindowHandle::Win32(handle)) => handle.hwnd.get(),
        _ => 0,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod host {
    use gpui::{Bounds, Pixels};

    /// Linux has no embedding path: wry's WebKitGTK backend accepts an Xlib
    /// parent only and needs a GTK main loop, and GPUI's Linux backend is
    /// neither GTK nor guaranteed to be X11.
    pub(super) struct WebviewHost;

    impl WebviewHost {
        pub fn sync_bounds(&self, _bounds: Bounds<Pixels>, _scale: f32) {}
        pub fn set_visible(&self, _visible: bool) {}
        pub fn native_focus_within(&self) -> bool {
            false
        }
        pub fn set_custom_user_agent(&self, _user_agent: Option<&str>) {}
        pub fn set_zoom(&self, _factor: f64) {}
    }
}

use host::WebviewHost;

/// Schedules entity updates from webview delegate callbacks — and from the
/// device-frame drag ghost's drop. The callbacks run on the main thread but
/// can fire while GPUI holds the app borrow, so the update always takes the
/// next executor turn instead of re-entering.
#[derive(Clone)]
struct Deferred {
    executor: ForegroundExecutor,
    cx: AsyncApp,
    view: WeakEntity<BrowserView>,
}

impl Deferred {
    fn update(&self, f: impl FnOnce(&mut BrowserView, &mut Context<BrowserView>) + 'static) {
        let mut cx = self.cx.clone();
        let view = self.view.clone();
        self.executor
            .spawn(async move {
                let _ = view.update(&mut cx, f);
            })
            .detach();
    }
}

/// Where an agent operation's outcome lands: the script's JSON-serialized
/// result, or an error message. Plain mpsc because the receiving end lives
/// outside GPUI (Task 4's engine-side bridge blocks on it), so the sender
/// must be `Send` and own nothing from the entity.
type AgentReply = std::sync::mpsc::Sender<Result<String, String>>;

/// One agent operation: the script to evaluate in the live page, and the
/// channel its answer must reach — exactly once, whatever happens.
struct AgentOp {
    script: String,
    reply: AgentReply,
}

/// The load-waiter's admit rule, kept off [`BrowserView`] as a plain
/// function of the raw fields so it can be tested without a window (the
/// struct needs a GPUI app to exist): while a load is pending the document
/// is being torn down, so the op parks in `queued` and returns `None`; on a
/// settled page it comes straight back for the caller to run now.
fn agent_dispatch(loading: bool, op: AgentOp, queued: &mut Vec<AgentOp>) -> Option<AgentOp> {
    if loading {
        queued.push(op);
        None
    } else {
        Some(op)
    }
}

/// The load-waiter's settle rule: a finished load advances the generation
/// exactly once and hands back everything parked since the last settle.
/// `Started` contributes nothing — a redirect mid-load re-fires `Started`
/// without a second page ever having settled, so neither double-bumps the
/// generation nor drains anything.
fn agent_load_finished(generation: &mut u64, queued: &mut Vec<AgentOp>) -> Vec<AgentOp> {
    *generation += 1;
    std::mem::take(queued)
}

/// WebView2's `ExecuteScript` hands the script's result back JSON-encoded —
/// and the agent serializer's functions already return what `JSON.stringify`
/// produces, so a healthy eval arrives as a JSON string *of* a JSON string.
/// Decode exactly one layer and hand the page's own JSON up. Anything that is
/// not a string at that outer layer — `null` from a page that clobbered the
/// serializer, a bare number, an object a hostile page returned directly —
/// passes through unchanged for the caller to judge, the same corner the
/// macOS arm reports as "the script did not return a string".
#[cfg(any(target_os = "windows", test))]
fn unwrap_execute_script_result(raw: &str) -> String {
    serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_owned())
}

// ── Device mode ────────────────────────────────────────────────────────────

/// Dimension bounds for a pinned viewport: never collapse the frame to
/// nothing mid-drag, never pin something larger than an 8K screen.
const MIN_DEVICE_DIMENSION: u32 = 100;
const MAX_DEVICE_DIMENSION: u32 = 7680;

/// Where the toolbar's device toggle starts — the design's Laptop preset, a
/// shape that reads as a page in any panel.
const DEFAULT_DEVICE_VIEWPORT: DeviceViewport = DeviceViewport {
    width: 1280,
    height: 800,
};

/// The user agents the mobile presets swap in. Real browser strings, so
/// responsive sites serve the mobile layout the frame is sized for instead
/// of sniffing an unknown client.
const IPHONE_UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
/// Chrome's frozen Android UA (the "K" device token is what real devices
/// now send); the major tracks current Chrome.
const PIXEL_UA: &str = "Mozilla/5.0 (Linux; Android 10; K) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";
/// The mobile-class iPad UA — real iPads default to a desktop-class
/// string since iPadOS 13, but sites key their tablet layout off the
/// `iPad` token, so emulation wants this one (DevTools ships it too).
const IPAD_UA: &str = "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

/// One of the design's five device presets. `user_agent` is `Some` only for
/// the mobile shapes — that override, not the numbers alone, is what makes
/// responsive sites serve their mobile layout.
pub(crate) struct DevicePreset {
    /// Stable key, also what persistence stores.
    pub(crate) key: &'static str,
    /// Brand names render as-is; the generic shapes localize through
    /// [`preset_menu_label`].
    label: &'static str,
    width: u32,
    height: u32,
    user_agent: Option<&'static str>,
}

/// The design's preset list, in menu order.
pub(crate) const DEVICE_PRESETS: [DevicePreset; 14] = [
    DevicePreset {
        key: "galaxy-s25",
        label: "Galaxy S25",
        width: 360,
        height: 780,
        user_agent: Some(PIXEL_UA),
    },
    DevicePreset {
        key: "iphone",
        label: "iPhone 16e",
        width: 390,
        height: 844,
        user_agent: Some(IPHONE_UA),
    },
    DevicePreset {
        key: "iphone-17",
        label: "iPhone 17",
        width: 402,
        height: 874,
        user_agent: Some(IPHONE_UA),
    },
    DevicePreset {
        key: "pixel",
        label: "Pixel 10",
        width: 412,
        height: 915,
        user_agent: Some(PIXEL_UA),
    },
    DevicePreset {
        key: "iphone-17-air",
        label: "iPhone 17 Air",
        width: 420,
        height: 912,
        user_agent: Some(IPHONE_UA),
    },
    DevicePreset {
        key: "pixel-10-pro-xl",
        label: "Pixel 10 Pro XL",
        width: 432,
        height: 960,
        user_agent: Some(PIXEL_UA),
    },
    DevicePreset {
        key: "iphone-17-pro-max",
        label: "iPhone 17 Pro Max",
        width: 440,
        height: 956,
        user_agent: Some(IPHONE_UA),
    },
    DevicePreset {
        key: "ipad-mini",
        label: "iPad Mini",
        width: 744,
        height: 1133,
        user_agent: Some(IPAD_UA),
    },
    DevicePreset {
        key: "ipad",
        label: "iPad Air",
        width: 820,
        height: 1180,
        user_agent: Some(IPAD_UA),
    },
    DevicePreset {
        key: "ipad-pro-13",
        label: "iPad Pro 13",
        width: 1024,
        height: 1366,
        user_agent: Some(IPAD_UA),
    },
    DevicePreset {
        key: "laptop",
        label: "Laptop",
        width: 1280,
        height: 800,
        user_agent: None,
    },
    DevicePreset {
        key: "laptop-l",
        label: "Laptop L",
        width: 1440,
        height: 900,
        user_agent: None,
    },
    DevicePreset {
        key: "desktop",
        label: "Desktop",
        width: 1920,
        height: 1080,
        user_agent: None,
    },
    DevicePreset {
        key: "4k",
        label: "4K",
        width: 3840,
        height: 2160,
        user_agent: None,
    },
];

fn preset_entry(key: &str) -> Option<&'static DevicePreset> {
    DEVICE_PRESETS.iter().find(|preset| preset.key == key)
}

/// The plan's preset lookup: `(width, height, user_agent)`. A test-facing
/// shape — live code reads the whole entry through [`preset_entry`].
#[allow(dead_code)]
fn preset(key: &str) -> Option<(u32, u32, Option<&'static str>)> {
    preset_entry(key).map(|p| (p.width, p.height, p.user_agent))
}

/// A preset's menu label: brand names are universal, the generic shapes
/// localize.
fn preset_menu_label(preset: &DevicePreset) -> SharedString {
    match preset.key {
        "laptop" => tr!("browser.preset.laptop").into(),
        "desktop" => tr!("browser.preset.desktop").into(),
        _ => preset.label.into(),
    }
}

/// The zoom chip's label: the localized fit label, or the percentage —
/// numbers need no keys.
fn zoom_label(zoom: ZoomMode) -> SharedString {
    match zoom {
        ZoomMode::Fit => tr!("browser.zoom_fit").into(),
        ZoomMode::Fixed(percent) => format!("{percent}%").into(),
    }
}

/// The device-mode state a fresh surface starts from, as a pure mapping
/// from persisted prefs: the mode, the last size (remembered even while
/// off), the active preset key with its user agent, and the zoom.
fn restored_device_state(
    prefs: Option<store::config::BrowserDevicePrefs>,
) -> (
    Option<DeviceViewport>,
    DeviceViewport,
    Option<&'static str>,
    Option<&'static str>,
    ZoomMode,
) {
    let Some(prefs) = prefs else {
        return (None, DEFAULT_DEVICE_VIEWPORT, None, None, ZoomMode::Fit);
    };
    let size = DeviceViewport::new(prefs.width, prefs.height);
    // Only a preset the table still knows restores a user agent — a stale
    // key (renamed preset, hand-edited config) falls back to the default
    // rather than guessing at a mobile shape.
    let entry = prefs.preset.as_deref().and_then(preset_entry);
    // No zoom key is the legacy shape: Fit, which is also Chrome's default.
    let zoom = prefs
        .zoom_percent
        .map(ZoomMode::Fixed)
        .unwrap_or(ZoomMode::Fit);
    (
        prefs.enabled.then_some(size),
        size,
        entry.and_then(|preset| preset.user_agent),
        entry.map(|preset| preset.key),
        zoom,
    )
}

/// A device-mode viewport: the exact CSS-pixel frame the webview pins to,
/// centered in the panel over a dimmed backdrop. Sized in points/DIPs on
/// both platforms, so CSS pixels are what the numbers say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DeviceViewport {
    width: u32,
    height: u32,
}

impl DeviceViewport {
    fn new(width: u32, height: u32) -> Self {
        Self {
            width: width.clamp(MIN_DEVICE_DIMENSION, MAX_DEVICE_DIMENSION),
            height: height.clamp(MIN_DEVICE_DIMENSION, MAX_DEVICE_DIMENSION),
        }
    }

    /// The same shape turned sideways. Dimensions pass through `new` again
    /// so the path stays uniform with every other size change — a swap of
    /// already-clamped values is in bounds, but re-clamping costs nothing.
    fn rotated(self) -> Self {
        Self::new(self.height, self.width)
    }
}

/// The device toolbar's zoom selection: fit the frame to the panel, or a
/// fixed percentage. Zoom scales the *rendering* only — the webview's
/// native frame carries the factor while page zoom keeps the page laying
/// out at the device's CSS size — so the emulated viewport never changes
/// with the zoom.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ZoomMode {
    /// `min(panel_w / device_w, panel_h / device_h)`, clamped to
    /// [0.25, 2.0] so no shape scales absurdly either way.
    Fit,
    /// One of the menu's percentage steps.
    Fixed(u32),
}

impl ZoomMode {
    /// The effective scale factor for a device in a panel of this size.
    fn factor(self, panel: gpui::Size<gpui::Pixels>, device: DeviceViewport) -> f64 {
        match self {
            Self::Fixed(percent) => f64::from(percent) / 100.0,
            Self::Fit => {
                let panel_width = f64::from(f32::from(panel.width).max(0.0));
                let panel_height = f64::from(f32::from(panel.height).max(0.0));
                // Fit only shrinks — Chrome's device mode shows a small
                // viewport at 100%, centered, scaling down only when the
                // panel cannot hold it.
                (panel_width / f64::from(device.width))
                    .min(panel_height / f64::from(device.height))
                    .min(1.0)
                    .clamp(0.25, 1.0)
            }
        }
    }
}

/// Where a device frame lands inside the panel at a zoom: centered, and
/// never larger than the panel — an oversized device (or zoom past what
/// fits) clamps to the panel rather than pushing the native view outside
/// it. The result is panel-local, so callers offset it by the panel's own
/// origin. The applied factor rides along for the paint path, which pushes
/// it to the webview without recomputing: the frame rect is the device
/// size scaled by the factor, while the page inside keeps the device's
/// CSS size.
fn pinned_bounds(
    panel: gpui::Size<gpui::Pixels>,
    device: DeviceViewport,
    zoom: ZoomMode,
) -> (gpui::Bounds<gpui::Pixels>, f64) {
    let panel_width = f32::from(panel.width).max(0.0);
    let panel_height = f32::from(panel.height).max(0.0);
    let factor = zoom.factor(panel, device);
    let width = ((device.width as f64 * factor) as f32).min(panel_width);
    let height = ((device.height as f64 * factor) as f32).min(panel_height);
    (
        gpui::Bounds {
            origin: gpui::point(
                px((panel_width - width) / 2.0),
                px((panel_height - height) / 2.0),
            ),
            size: gpui::size(px(width), px(height)),
        },
        factor,
    )
}

/// Toggle semantics for the toolbar button: off comes back on at the last
/// size (the default before anything else), on turns off.
fn device_mode_toggled(
    mode: Option<DeviceViewport>,
    last: DeviceViewport,
) -> Option<DeviceViewport> {
    mode.is_none().then_some(last)
}

/// Drag resizing: whole-CSS-pixel snapping from the pointer's total delta
/// since the grab, clamped to the dimension bounds — the `as u32` cast
/// saturates negatives to zero, which the clamp then lifts to the minimum.
fn drag_resized(from: DeviceViewport, dx: gpui::Pixels, dy: gpui::Pixels) -> DeviceViewport {
    DeviceViewport::new(
        (from.width as f32 + f32::from(dx)).round() as u32,
        (from.height as f32 + f32::from(dy)).round() as u32,
    )
}

/// Free-entry dimension fields parse as bare integers; anything else keeps
/// the current size.
fn parse_dimension(text: &str) -> Option<u32> {
    text.trim().parse().ok()
}

/// The dimmed area around a pinned frame — the modal scrim treatment.
fn device_backdrop(is_dark: bool) -> Hsla {
    if is_dark {
        hsla(0.0, 0.0, 0.0, 0.34)
    } else {
        hsla(0.0, 0.0, 0.0, 0.16)
    }
}

/// The drag value riding a device-frame resize: the size at grab time, from
/// which every move recomputes the whole size (no accumulating drift).
#[derive(Clone)]
struct DeviceFrameDrag(DeviceViewport);

impl Render for DeviceFrameDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        gpui::Empty
    }
}

/// The drag ghost GPUI drops when a device-frame resize ends — the only
/// drag-end hook there is, and the moment the settled size persists (a
/// save per move would rewrite the config on every frame of the drag).
/// The hop mirrors the webview callbacks' [`Deferred`]: the drop can land
/// mid-update, so the save takes the next executor turn.
struct DeviceResizeEnd(Option<Deferred>);

impl Render for DeviceResizeEnd {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        gpui::Empty
    }
}

impl Drop for DeviceResizeEnd {
    fn drop(&mut self) {
        if let Some(hop) = self.0.take() {
            hop.update(|this, _| this.save_device_prefs());
        }
    }
}

pub struct BrowserView {
    focus_handle: FocusHandle,
    address: Entity<TextInput>,
    /// Chromeless twin (inline mermaid cards): the page area alone, on a
    /// transparent native surface, claiming no toolbar, start page, focus or
    /// per-surface element id — many can be embedded at once.
    chromeless: bool,
    host: Option<Rc<WebviewHost>>,
    /// Why the webview could not be created, shown in place of the page.
    host_error: Option<String>,
    /// Somewhere to navigate to as soon as the host lands. WebView2's
    /// controller is created asynchronously, so the surface can be asked to
    /// open a URL before it has anything to open it in.
    #[cfg(target_os = "windows")]
    pending_url: Option<String>,
    /// A navigation has been requested at least once: the surface shows the
    /// page area instead of the start hint, and the native view may be shown.
    navigation_requested: bool,
    current_url: Option<String>,
    page_title: Option<String>,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    /// The user has edited the address since it last echoed the page, so page
    /// navigations must not clobber the field until they commit or cancel.
    address_dirty: bool,
    /// Native-focus edge detection: whether the webview held the native first
    /// responder as of the last frame.
    was_natively_focused: bool,
    /// GPUI-focus edge detection: the window's focused handle last frame.
    last_window_focus: Option<FocusHandle>,
    occluded: bool,
    /// Frozen page pixels drawn while a GPUI overlay is open above the panel.
    /// A `RenderImage` rather than an encoded `Image`: encoded images decode
    /// through the async asset pipeline, whose first paint is empty — the
    /// swap must paint the very frame the live view hides or it blinks.
    snapshot: Option<std::sync::Arc<gpui::RenderImage>>,
    snapshot_pending: bool,
    /// Discards snapshot completions that land after their occlusion ended.
    snapshot_epoch: u64,
    /// Agent load-waiter state: which settled load the page is on, and the
    /// operations parked until the one in flight finishes. Pure data — the
    /// rules live in [`agent_dispatch`] and [`agent_load_finished`] so they
    /// test without a window.
    load_generation: u64,
    agent_queue: Vec<AgentOp>,
    /// Agent tool calls routed onto this view whose engine-side wait has
    /// not resolved yet. The toolbar's activity indicator lights while
    /// this is non-zero.
    agent_tool_calls: usize,
    /// Device mode: the exact CSS-pixel frame the page pins to, centered
    /// over a dimmed backdrop; `None` (the default) fills the panel.
    device_mode: Option<DeviceViewport>,
    /// The last size device mode had, kept while the mode is off so the
    /// toggle — and a fresh launch — comes back at it rather than the
    /// default.
    device_last: DeviceViewport,
    /// The preset `device_mode` came from, when it did; drags, typed sizes
    /// and the agent's set_viewport all end it.
    device_preset: Option<&'static str>,
    /// The mobile user agent the active preset swapped in; `None` is the
    /// platform default (the Safari mirror on macOS, Edge on Windows).
    device_user_agent: Option<&'static str>,
    /// The toolbar's preset dropdown.
    device_preset_menu: ContextMenuHandle,
    /// Where the in-flight device-frame drag grabbed, to turn each move into
    /// a size delta.
    device_drag_origin: Option<gpui::Point<gpui::Pixels>>,
    /// Free-entry width/height for the pinned frame, mirroring `device_mode`
    /// into editable text.
    device_width: Entity<TextInput>,
    device_height: Entity<TextInput>,
    /// The device toolbar's zoom selection; the paint path applies its
    /// factor to the webview.
    device_zoom: ZoomMode,
    /// The device toolbar's zoom dropdown.
    device_zoom_menu: ContextMenuHandle,
    /// The last zoom factor pushed to the webview — `None` until one is —
    /// so the per-frame paint path only calls the platform setter when the
    /// factor actually changes.
    device_applied_zoom: Rc<Cell<Option<f64>>>,
    /// The page area's last painted size, where the Fit factor and the
    /// frame outline's clamping come from. The outline is laid out before
    /// the canvas paints, so a frame behind a resize reads the previous
    /// size until its own paint lands.
    device_panel: Rc<Cell<Option<gpui::Size<gpui::Pixels>>>>,
    _subscriptions: Vec<Subscription>,
}

impl BrowserView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::for_surface(window, cx, false)
    }

    fn for_surface(window: &mut Window, cx: &mut Context<Self>, chromeless: bool) -> Self {
        let address = cx.new(|cx| {
            TextInput::new(window, cx)
                .select_all_on_focus_click()
                .placeholder(tr!("input.search_or_enter_address"))
        });

        let submit_subscription = cx.subscribe(
            &address,
            |this: &mut Self, address, event: &InputEvent, cx| match event {
                InputEvent::Submit(text) => this.navigate_to_input(text.clone(), cx),
                // Search-mode fields never emit a steer; nothing to do here.
                InputEvent::Edited => {
                    // Edits from the page echo itself also land here (events
                    // flush after the update that set the content), so dirty
                    // is derived, not latched: the field is dirty exactly
                    // while it shows something other than the page's URL.
                    let shown = this.current_url.as_deref().map(display_url).unwrap_or("");
                    this.address_dirty = address.read(cx).content() != shown;
                }
                InputEvent::Focus => {}
                InputEvent::BackspaceOnEmpty => {}
            },
        );

        let device_width = cx.new(|cx| TextInput::new(window, cx).select_all_on_focus_click());
        let device_height = cx.new(|cx| TextInput::new(window, cx).select_all_on_focus_click());
        let device_preset_menu = ContextMenuHandle::new(cx);
        let device_zoom_menu = ContextMenuHandle::new(cx);
        let device_width_submit = cx.subscribe(
            &device_width,
            |this: &mut Self, _, event: &InputEvent, cx| {
                if let InputEvent::Submit(text) = event {
                    this.submit_device_width(text, cx);
                }
            },
        );
        let device_height_submit = cx.subscribe(
            &device_height,
            |this: &mut Self, _, event: &InputEvent, cx| {
                if let InputEvent::Submit(text) = event {
                    this.submit_device_height(text, cx);
                }
            },
        );

        let focus_handle = cx.focus_handle();
        let address_focus = address.read(cx).focus();
        let weak_for_focus_in = cx.entity().downgrade();
        let weak_for_focus_out = cx.entity().downgrade();

        // GPUI focus moves are invisible to render-time reconciliation when
        // they don't re-render this view (focusing the address bar only
        // re-renders the input entity; focusing the chat composer renders
        // nothing of ours), so the reclaim rides the window's focus
        // listeners, which fire on every focus change.
        let focus_in_address = window.on_focus_in(&address_focus, cx, {
            let view = weak_for_focus_in.clone();
            move |_, cx| {
                let _ = view.update(cx, |this: &mut Self, cx| {
                    this.reclaim_keyboard_from_page(cx);
                });
            }
        });
        // The device-mode size fields deserve the same guarantee: a page
        // that still holds the native keyboard must not eat the dimensions
        // being typed into them.
        let device_width_focus = device_width.read(cx).focus();
        let device_height_focus = device_height.read(cx).focus();
        let focus_in_device_width = window.on_focus_in(&device_width_focus, cx, {
            let view = weak_for_focus_in.clone();
            move |_, cx| {
                let _ = view.update(cx, |this: &mut Self, cx| {
                    this.reclaim_keyboard_from_page(cx);
                });
            }
        });
        let focus_in_device_height = window.on_focus_in(&device_height_focus, cx, {
            let view = weak_for_focus_in;
            move |_, cx| {
                let _ = view.update(cx, |this: &mut Self, cx| {
                    this.reclaim_keyboard_from_page(cx);
                });
            }
        });
        let focus_out_surface = window.on_focus_out(&focus_handle, cx, {
            let view = weak_for_focus_out;
            move |_, window, cx| {
                // GPUI focus left this surface for another control (the chat
                // composer, a find bar): that control owns the keyboard now,
                // so the page hands the native side back. Deactivating the
                // window also reports an empty focus path; keep the page's
                // focus through that.
                let focused_elsewhere = window.is_window_active() && window.focused(cx).is_some();
                let _ = view.update(cx, |this: &mut Self, cx| {
                    if focused_elsewhere
                        && this
                            .host
                            .as_ref()
                            .is_some_and(|host| host.native_focus_within())
                    {
                        this.reclaim_native_keyboard(cx);
                    }
                });
            }
        });

        // Device-mode persistence: a full surface starts from the last state
        // the user persisted — mode, last size, preset with its user agent
        // (which the macOS builder applies below, before the webview loads
        // anything) and zoom. The chromeless twins never enter device mode.
        let (device_mode, device_last, device_user_agent, device_preset, device_zoom) =
            if chromeless {
                (None, DEFAULT_DEVICE_VIEWPORT, None, None, ZoomMode::Fit)
            } else {
                let prefs = store::config::load(&store::paths::config_path())
                    .ok()
                    .and_then(|config| config.general_settings)
                    .and_then(|general| general.browser_device);
                restored_device_state(prefs)
            };

        let mut this = Self {
            focus_handle,
            address,
            chromeless,
            host: None,
            host_error: None,
            #[cfg(target_os = "windows")]
            pending_url: None,
            navigation_requested: false,
            current_url: None,
            page_title: None,
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            address_dirty: false,
            was_natively_focused: false,
            last_window_focus: None,
            occluded: false,
            snapshot: None,
            snapshot_pending: false,
            snapshot_epoch: 0,
            load_generation: 0,
            agent_queue: Vec::new(),
            agent_tool_calls: 0,
            device_mode,
            device_last,
            device_preset,
            device_user_agent,
            device_preset_menu,
            device_drag_origin: None,
            device_width,
            device_height,
            device_zoom,
            device_zoom_menu,
            device_applied_zoom: Rc::new(Cell::new(None)),
            device_panel: Rc::new(Cell::new(None)),
            _subscriptions: vec![
                submit_subscription,
                focus_in_address,
                focus_out_surface,
                device_width_submit,
                device_height_submit,
                focus_in_device_width,
                focus_in_device_height,
            ],
        };
        if this.device_mode.is_some() {
            this.refresh_device_fields(cx);
        }
        this.build_webview(window, cx);
        this
    }

    pub fn refresh_localized_text(&mut self, cx: &mut Context<Self>) {
        self.address.update(cx, |address, cx| {
            address.set_placeholder(tr!("input.search_or_enter_address"), cx)
        });
        cx.notify();
    }

    /// The one entry point for device-viewport changes — the toolbar fields,
    /// the drag handle, the presets and the agent's set-viewport tool all
    /// funnel here, so the toggle, the fields and the frame can never
    /// disagree. Values clamp to the dimension bounds before landing.
    /// A size no preset has ends the preset — and with it its user agent,
    /// which belongs to the preset, not the numbers.
    pub fn set_device_viewport(&mut self, width: u32, height: u32, cx: &mut Context<Self>) {
        let device = DeviceViewport::new(width, height);
        self.device_last = device;
        if self.device_preset.is_some_and(|key| {
            preset_entry(key)
                .is_some_and(|preset| DeviceViewport::new(preset.width, preset.height) != device)
        }) {
            self.device_preset = None;
            self.device_user_agent = None;
            self.apply_device_user_agent();
        }
        if self.device_mode != Some(device) {
            self.device_mode = Some(device);
            self.refresh_device_fields(cx);
            cx.notify();
        }
    }

    /// Leave device mode: unpin the frame, restore the default user agent
    /// and reset the zoom — the factor belongs to the pinned frame, and
    /// normal browsing must not stay stuck at the device's scale. The
    /// user's toggle and the agent's `enabled: false` both land here; only
    /// the user's path persists.
    pub fn clear_device_mode(&mut self, cx: &mut Context<Self>) {
        if self.device_mode.take().is_some() {
            self.device_preset = None;
            self.device_user_agent = None;
            self.apply_device_user_agent();
            self.apply_device_zoom(1.0);
            cx.notify();
        }
    }

    fn toggle_device_mode(&mut self, cx: &mut Context<Self>) {
        match device_mode_toggled(self.device_mode, self.device_last) {
            Some(size) => self.set_device_viewport(size.width, size.height, cx),
            None => self.clear_device_mode(cx),
        }
        self.save_device_prefs();
    }

    /// Apply one of the design's presets: pin its size and — for the mobile
    /// shapes — swap the user agent, which is what makes responsive sites
    /// serve their mobile layout. Desktop presets and any custom size carry
    /// the platform default agent. The new agent applies to *subsequent*
    /// navigations; the loaded page keeps the agent it loaded with, so a
    /// preset switch pairs naturally with a reload.
    fn apply_device_preset(&mut self, key: &'static str, cx: &mut Context<Self>) {
        let Some(entry) = preset_entry(key) else {
            return;
        };
        self.set_device_viewport(entry.width, entry.height, cx);
        self.device_preset = Some(entry.key);
        self.device_user_agent = entry.user_agent;
        self.apply_device_user_agent();
        self.save_device_prefs();
    }

    /// Push the current user-agent choice into the live webview. Both
    /// platforms' setters are live for subsequent navigations.
    fn apply_device_user_agent(&self) {
        if let Some(host) = self.host.as_ref() {
            host.set_custom_user_agent(self.device_user_agent);
        }
    }

    /// Rotate the pinned frame: the dimensions swap while the preset and
    /// its user agent stay — Chrome keeps the preset across rotation, so a
    /// turned iPhone is still an iPhone. Deliberately not
    /// [`Self::set_device_viewport`], whose preset-drift rule would end
    /// the preset on the swapped numbers. The swap mirrors into the w/h
    /// fields and persists like any user size.
    fn rotate_device(&mut self, cx: &mut Context<Self>) {
        let device = self.device_mode.unwrap_or(self.device_last).rotated();
        self.device_last = device;
        if self.device_mode.is_some() {
            self.device_mode = Some(device);
            self.refresh_device_fields(cx);
            cx.notify();
        }
        self.save_device_prefs();
    }

    /// The zoom dropdown's commit: remember the mode, redraw (the paint
    /// path applies the new factor the frame it lands in) and persist —
    /// zoom is a user preference like the size it scales.
    fn set_device_zoom(&mut self, zoom: ZoomMode, cx: &mut Context<Self>) {
        if self.device_zoom == zoom {
            return;
        }
        self.device_zoom = zoom;
        cx.notify();
        self.save_device_prefs();
    }

    /// Push a zoom factor to the host only when it changed — the paint
    /// path recomputes the factor every frame, so the cache keeps the
    /// platform setter a per-change call rather than a per-frame one.
    /// `None` means "nothing applied yet", which also covers the window
    /// before the host exists: the first paint with a host then applies.
    fn push_device_zoom(host: &WebviewHost, applied: &Rc<Cell<Option<f64>>>, factor: f64) {
        if applied.get() == Some(factor) {
            return;
        }
        applied.set(Some(factor));
        host.set_zoom(factor);
    }

    /// Apply a zoom factor outside the paint path (device mode turning
    /// off), through the same deduplication the paint callback uses.
    fn apply_device_zoom(&self, factor: f64) {
        if let Some(host) = self.host.as_ref() {
            Self::push_device_zoom(host, &self.device_applied_zoom, factor);
        }
    }

    /// Persist the device-mode state for the next launch. User actions only
    /// — the agent's set_viewport deliberately leaves the saved prefs alone
    /// (settings record the user's choice, not the agent's).
    fn save_device_prefs(&self) {
        let path = store::paths::config_path();
        // Never write over a config that cannot be read: a lost preference
        // beats a wiped provider list.
        let Ok(mut config) = store::config::load(&path) else {
            return;
        };
        let general = config
            .general_settings
            .get_or_insert_with(store::config::GeneralSettings::default);
        general.browser_device = Some(store::config::BrowserDevicePrefs {
            enabled: self.device_mode.is_some(),
            width: self.device_last.width,
            height: self.device_last.height,
            preset: self.device_preset.map(str::to_owned),
            zoom_percent: match self.device_zoom {
                ZoomMode::Fit => None,
                ZoomMode::Fixed(percent) => Some(percent),
            },
        });
        let _ = store::config::save(&path, &config);
    }

    /// Mirror the pinned size into the free-entry fields, so a drag or an
    /// applied change reads back exactly what the frame now is.
    fn refresh_device_fields(&mut self, cx: &mut Context<Self>) {
        let device = self.device_mode.unwrap_or(self.device_last);
        self.device_width.update(cx, |input, cx| {
            input.set_content(device.width.to_string(), cx)
        });
        self.device_height.update(cx, |input, cx| {
            input.set_content(device.height.to_string(), cx)
        });
    }

    fn submit_device_width(&mut self, text: &str, cx: &mut Context<Self>) {
        let current = self.device_mode.unwrap_or(self.device_last);
        match parse_dimension(text) {
            Some(width) => {
                self.set_device_viewport(width, current.height, cx);
                self.save_device_prefs();
            }
            None => self.device_width.update(cx, |input, cx| {
                input.set_content(current.width.to_string(), cx)
            }),
        }
    }

    fn submit_device_height(&mut self, text: &str, cx: &mut Context<Self>) {
        let current = self.device_mode.unwrap_or(self.device_last);
        match parse_dimension(text) {
            Some(height) => {
                self.set_device_viewport(current.width, height, cx);
                self.save_device_prefs();
            }
            None => self.device_height.update(cx, |input, cx| {
                input.set_content(current.height.to_string(), cx)
            }),
        }
    }

    pub fn tab_label(&self) -> Option<String> {
        if let Some(title) = self.page_title.as_deref().filter(|t| !t.trim().is_empty()) {
            return Some(title.to_owned());
        }
        self.current_url
            .as_deref()
            .map(|url| display_url(url).to_owned())
    }

    #[cfg(target_os = "macos")]
    fn build_webview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use wry::dpi::{LogicalPosition, LogicalSize};

        let deferred = Deferred {
            executor: cx.foreground_executor().clone(),
            cx: cx.to_async(),
            view: cx.entity().downgrade(),
        };

        let on_page_load = deferred.clone();
        let on_title = deferred.clone();
        let on_new_window = deferred.clone();

        // The responder observer's decision needs the window (GPUI focus
        // moves), which `Deferred` cannot reach; go through the window handle.
        let on_responder_change: Box<dyn Fn(bool)> = {
            let executor = cx.foreground_executor().clone();
            let async_cx = cx.to_async();
            let view = cx.entity().downgrade();
            let window_handle = window.window_handle();
            Box::new(move |user_gesture| {
                let mut cx = async_cx.clone();
                let view = view.clone();
                executor
                    .spawn(async move {
                        let _ = window_handle.update(&mut cx, |_, window, cx| {
                            let _ = view.update(cx, |this, cx| {
                                this.native_responder_changed(user_gesture, window, cx);
                            });
                        });
                    })
                    .detach();
            })
        };

        let built = wry::WebViewBuilder::new()
            .with_bounds(wry::Rect {
                position: LogicalPosition::new(0.0, 0.0).into(),
                size: LogicalSize::new(0.0, 0.0).into(),
            })
            .with_visible(false)
            .with_focused(false)
            // The inline twin draws the page over whatever the host card
            // paints behind it, so the native view itself must not ground it.
            .with_transparent(self.chromeless)
            .with_accept_first_mouse(true)
            .with_devtools(true)
            // A preset restored from settings at creation swaps its mobile
            // agent in here, before anything loads; otherwise the Safari
            // mirror.
            .with_user_agent(self.device_user_agent.unwrap_or(USER_AGENT))
            // The agent's page-side half has to exist before any of the
            // page's own scripts run.
            .with_initialization_script(BROWSER_AGENT_JS)
            .with_navigation_handler(|_| true)
            .with_on_page_load_handler(move |event, url| {
                let event = match event {
                    wry::PageLoadEvent::Started => PageLoad::Started,
                    wry::PageLoadEvent::Finished => PageLoad::Finished,
                };
                on_page_load.update(move |this, cx| this.page_load_changed(event, url, cx));
            })
            .with_document_title_changed_handler(move |title| {
                on_title.update(move |this, cx| this.title_changed(title, cx));
            })
            .with_new_window_req_handler(move |url, _features| {
                // One surface, one page: pop-ups and `target="_blank"` links
                // navigate in place instead of spawning windows.
                on_new_window.update(move |this, cx| this.navigate_to_url(url, cx));
                wry::NewWindowResponse::Deny
            })
            .with_download_started_handler(|url, destination| {
                let Some(target) = download_destination(&url, destination.clone()) else {
                    return false;
                };
                *destination = target;
                true
            })
            .with_download_completed_handler(|_url, path, success| {
                if success && let Some(path) = path {
                    reveal_in_finder(&path);
                }
            })
            .build_as_child(window);

        match built {
            Ok(webview) => {
                self.host = Some(Rc::new(WebviewHost::new(webview, on_responder_change)))
            }
            Err(error) => {
                eprintln!("[browser] webview build failed: {error}");
                self.host_error = Some(error.to_string());
            }
        }
    }

    /// The native first responder moved (KVO on the window): resolve the two
    /// focus systems immediately instead of waiting for a render. While the
    /// address bar is being typed into, a script-initiated grab (a page
    /// autofocusing its own input) loses the keyboard right back; a grab
    /// carried by a user click means the user entered the page, so GPUI
    /// focus follows onto this surface and the address bar drops its caret.
    #[cfg(target_os = "macos")]
    fn native_responder_changed(
        &mut self,
        user_gesture: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let natively_focused = self
            .host
            .as_ref()
            .is_some_and(|host| host.native_focus_within());
        if natively_focused {
            let address_focused = self.address.read(cx).focus().is_focused(window);
            if address_focused && !user_gesture {
                self.reclaim_native_keyboard(cx);
            } else {
                window.focus(&self.focus_handle, cx);
            }
        }
        self.was_natively_focused = natively_focused;
        self.last_window_focus = window.focused(cx);
        cx.notify();
    }

    /// WebView2 rendered into GPUI's composition tree.
    ///
    /// Nothing exists synchronously here: `create` returns before the
    /// environment and the controller do, and the host lands a few frames
    /// later through `webview_ready`. See [`host`] for why visual hosting is
    /// worth that. No user agent is set at creation — WebView2's default
    /// already identifies as desktop Edge — but a preset restored from
    /// settings (or picked before the controller landed) applies its mobile
    /// agent as soon as the host exists.
    #[cfg(target_os = "windows")]
    fn build_webview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let parent = window_hwnd(window);
        if parent == 0 {
            self.host_error = Some("the window has no native handle".to_owned());
            return;
        }
        // The portal is a visual GPUI keeps between its own base and overlay
        // planes, so the page composites under menus rather than over them.
        let surface = match window.create_native_surface() {
            Ok(surface) => surface,
            Err(error) => {
                self.host_error = Some(error.to_string());
                return;
            }
        };

        let deferred = Deferred {
            executor: cx.foreground_executor().clone(),
            cx: cx.to_async(),
            view: cx.entity().downgrade(),
        };
        let on_page_load = deferred.clone();
        let on_url = deferred.clone();
        let on_title = deferred.clone();
        let on_new_window = deferred.clone();
        let on_cursor = deferred.clone();
        let on_focus = deferred.clone();
        let on_ready = deferred.clone();

        host::WebviewHost::create(
            parent,
            surface,
            self.chromeless,
            host::Callbacks {
                page_load: Box::new(move |event, url| {
                    on_page_load.update(move |this, cx| this.page_load_changed(event, url, cx));
                }),
                url_changed: Box::new(move |url| {
                    on_url.update(move |this, cx| this.source_changed(url, cx));
                }),
                title: Box::new(move |title| {
                    on_title.update(move |this, cx| this.title_changed(title, cx));
                }),
                open_url: Box::new(move |url| {
                    on_new_window.update(move |this, cx| this.navigate_to_url(url, cx));
                }),
                cursor_changed: Box::new(move || {
                    on_cursor.update(|_, cx| cx.notify());
                }),
                focus_changed: Box::new(move || {
                    on_focus.update(|_, cx| cx.notify());
                }),
            },
            Box::new(move |outcome| {
                on_ready.update(move |this, cx| this.webview_ready(outcome, cx));
            }),
        );
    }

    /// The composition controller finished being created — or failed to be.
    #[cfg(target_os = "windows")]
    fn webview_ready(&mut self, outcome: Result<Rc<WebviewHost>, String>, cx: &mut Context<Self>) {
        match outcome {
            Ok(host) => {
                self.host = Some(host);
                // A preset's user agent chosen before the controller landed
                // applies the moment there is a webview to carry it.
                self.apply_device_user_agent();
                // A URL typed before the page existed waits here rather than
                // being dropped on the floor.
                if let Some(url) = self.pending_url.take() {
                    self.navigate_to_url(url, cx);
                }
            }
            Err(error) => self.host_error = Some(error),
        }
        cx.notify();
    }

    /// The page navigated within the same document, so only the URL moved.
    /// Unlike a page load this must not touch `loading` or the title.
    #[cfg(target_os = "windows")]
    fn source_changed(&mut self, url: String, cx: &mut Context<Self>) {
        if url.is_empty() || self.current_url.as_deref() == Some(url.as_str()) {
            return;
        }
        self.current_url = Some(url);
        self.refresh_navigation_state();
        self.echo_page_url(cx);
        cx.notify();
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn build_webview(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        self.host_error = Some(tr!("browser.unavailable_on_platform"));
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn page_load_changed(&mut self, event: PageLoad, url: String, cx: &mut Context<Self>) {
        match event {
            PageLoad::Started => {
                self.loading = true;
                // A fresh document invalidates the previous page's title; the
                // new one arrives via the title observer once known.
                self.page_title = None;
                // Committed navigation supersedes whatever was frozen.
                self.snapshot = None;
            }
            PageLoad::Finished => {
                self.loading = false;
                // The document settled: whatever was parked while it loaded
                // can run against the finished page, each op exactly once.
                let parked = agent_load_finished(&mut self.load_generation, &mut self.agent_queue);
                for op in parked {
                    self.run_agent_script(op.script, op.reply, cx);
                }
            }
        }
        if !url.is_empty() {
            self.current_url = Some(url);
        }
        self.refresh_navigation_state();
        self.echo_page_url(cx);
        cx.notify();
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn title_changed(&mut self, title: String, cx: &mut Context<Self>) {
        let title = (!title.trim().is_empty()).then_some(title);
        if self.page_title != title {
            self.page_title = title;
            cx.notify();
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn refresh_navigation_state(&mut self) {
        if let Some(host) = &self.host {
            self.can_go_back = host.webview.can_go_back().unwrap_or(false);
            self.can_go_forward = host.webview.can_go_forward().unwrap_or(false);
        }
    }

    /// Push the committed page URL into the address field unless the user is
    /// mid-edit there.
    fn echo_page_url(&mut self, cx: &mut Context<Self>) {
        if self.address_dirty {
            return;
        }
        let Some(url) = self.current_url.clone() else {
            return;
        };
        let shown = display_url(&url).to_owned();
        self.address.update(cx, |address, cx| {
            if address.content() != shown {
                address.set_content(shown, cx);
            }
        });
        self.address_dirty = false;
    }

    fn navigate_to_input(&mut self, raw: String, cx: &mut Context<Self>) {
        let Some(target) = resolve_address(&raw) else {
            return;
        };
        let url = match target {
            AddressTarget::Url(url) => url,
            AddressTarget::Search(query) => search_url(&query),
        };
        self.navigate_to_url(url, cx);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn navigate_to_url(&mut self, url: String, cx: &mut Context<Self>) {
        let Some(host) = &self.host else {
            #[cfg(target_os = "windows")]
            {
                self.pending_url = Some(url);
            }
            return;
        };
        if host.webview.load_url(&url).is_err() {
            return;
        }
        // Navigating supersedes any load still in flight, which strands the
        // ops parked behind it on macOS — a load that never finishes never
        // fires `Finished` — so they fail here rather than leak into the
        // page now loading.
        self.fail_parked_agent_ops("the page navigation was superseded");
        self.navigation_requested = true;
        self.loading = true;
        self.current_url = Some(url);
        self.address_dirty = false;
        // The chromeless twin renders no address bar and must never claim the
        // keyboard for showing up — an inline diagram that steals focus from
        // the composer the moment it renders would be a bug, not a feature.
        if !self.chromeless {
            self.echo_page_url(cx);
            self.focus_page(cx);
        }
        cx.notify();
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn navigate_to_url(&mut self, _url: String, _cx: &mut Context<Self>) {}

    /// Hand the keyboard to the page. `makeFirstResponder` runs responder
    /// callbacks synchronously and this is reached from inside an entity
    /// update, so the native call takes the next executor turn.
    fn focus_page(&mut self, _cx: &mut Context<Self>) {
        #[cfg(target_os = "macos")]
        if let Some(host) = self.host.clone() {
            _cx.foreground_executor()
                .spawn(async move {
                    let _ = host.webview.focus();
                })
                .detach();
        }
        // `MoveFocus` is the only way in: a visual-hosted page has no window
        // of ours for a click to land on, so focus is always explicit.
        #[cfg(target_os = "windows")]
        if let Some(host) = self.host.clone() {
            _cx.foreground_executor()
                .spawn(async move {
                    host.focus_page();
                })
                .detach();
        }
    }

    /// Where focus should land when this surface becomes active: the page if
    /// there is one, otherwise the address bar ready for typing.
    pub fn focus_default(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.navigation_requested {
            self.focus_page(cx);
            window.focus(&self.focus_handle, cx);
        } else {
            self.focus_address(window, cx);
        }
    }

    pub fn focus_address(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.address.update(cx, |address, cx| {
            address.select_all_text(cx);
        });
        window.focus(&self.address.read(cx).focus(), cx);
        // GPUI focus alone is not enough: while the webview is first
        // responder, plain keystrokes never reach GPUI.
        self.reclaim_native_keyboard(cx);
        cx.notify();
    }

    fn restore_address(&mut self, cx: &mut Context<Self>) {
        self.address_dirty = false;
        self.echo_page_url(cx);
        cx.notify();
    }

    /// Per-frame push from the app: whether this surface is the visible right
    /// panel tab, and whether a GPUI overlay is open above it. Deduplicated
    /// down to real AppKit calls by the host.
    pub fn sync_native_state(
        &mut self,
        surface_visible: bool,
        occluded: bool,
        cx: &mut Context<Self>,
    ) {
        let occlusion_started = occluded && !self.occluded;
        self.occluded = occluded;

        let Some(host) = self.host.clone() else {
            return;
        };
        let has_page = self.navigation_requested;

        if surface_visible && has_page && occlusion_started && !self.snapshot_pending {
            self.request_snapshot(cx);
        }
        if !occluded && (self.snapshot.is_some() || self.snapshot_pending) {
            // The frame the overlay closes, the frozen pixels and any capture
            // still in flight are both stale; bumping the epoch makes a late
            // completion drop itself instead of resurfacing under the next
            // occlusion.
            self.snapshot = None;
            self.snapshot_pending = false;
            self.snapshot_epoch += 1;
        }

        // The live view stays up until its replacement pixels exist: hiding
        // is deferred to the frame the snapshot lands (identical pixels, so
        // the swap is invisible), rather than blanking for the frames the
        // capture takes. Until then the overlay's page-overlapping portion
        // simply appears a frame or two late. If the capture fails, the
        // completion clears the pending flag and this hides the view anyway —
        // a blank page area beats a menu nobody can see.
        let covered_by_snapshot = occluded && !self.snapshot_pending;
        let show = surface_visible && has_page && !covered_by_snapshot;
        // AppKit leaves a hidden view as first responder, so a page focused at
        // the moment its tab is switched away would keep eating the keyboard.
        if !show && host.native_focus_within() {
            self.reclaim_native_keyboard(cx);
        }
        host.set_visible(show);
    }

    #[cfg(target_os = "macos")]
    fn request_snapshot(&mut self, cx: &mut Context<Self>) {
        use objc2_app_kit::NSImage;
        use objc2_foundation::NSError;

        let Some(host) = &self.host else {
            return;
        };
        self.snapshot_pending = true;
        let epoch = self.snapshot_epoch;
        let deferred = Deferred {
            executor: cx.foreground_executor().clone(),
            cx: cx.to_async(),
            view: cx.entity().downgrade(),
        };
        let completion = block2::RcBlock::new(move |image: *mut NSImage, _: *mut NSError| {
            // Main thread, inside a WebKit completion: one raw-pixel copy —
            // never an image encode, which costs tens of milliseconds and
            // whose decode would push the first paint frames out.
            let render_image = unsafe { image.as_ref() }.and_then(snapshot_render_image);
            deferred.update(move |this, cx| {
                if this.snapshot_epoch == epoch {
                    this.snapshot_pending = false;
                    if this.occluded {
                        this.snapshot = render_image;
                    }
                    // Always redraw: the next frame's sync is what actually
                    // hides the live view now that the capture settled.
                    cx.notify();
                }
            });
        });
        unsafe {
            host.wk()
                .takeSnapshotWithConfiguration_completionHandler(None, &completion)
        };
    }

    #[cfg(not(target_os = "macos"))]
    fn request_snapshot(&mut self, _cx: &mut Context<Self>) {}

    /// Agent tool call in flight: the bridge marks one from
    /// `route_browser_op` before dispatching, and clears it once the
    /// engine's blocking wait resolved — by answer, error, or timeout.
    pub fn agent_tool_started(&mut self, cx: &mut Context<Self>) {
        self.agent_tool_calls += 1;
        cx.notify();
    }

    /// The bridge's counterpart to [`BrowserView::agent_tool_started`].
    /// Saturating: an op that opened this surface had nothing to mark.
    pub fn agent_tool_ended(&mut self, cx: &mut Context<Self>) {
        self.agent_tool_calls = self.agent_tool_calls.saturating_sub(1);
        cx.notify();
    }

    /// Agent entry point for "evaluate and give me the result": runs
    /// `script` against the page once it is safe to — mid-load the document
    /// is being replaced, so the op parks until the load finishes — and
    /// answers `reply` with the script's JSON-serialized result, or an
    /// error message. Called on the main thread; the engine-side bridge
    /// (Task 4) hops over and blocks on the channel's other end.
    pub fn agent_eval(&mut self, script: String, reply: AgentReply, cx: &mut Context<Self>) {
        let op = AgentOp { script, reply };
        if let Some(op) = agent_dispatch(self.loading, op, &mut self.agent_queue) {
            self.run_agent_script(op.script, op.reply, cx);
        }
    }

    /// A load that will never finish — the user stopped it, or a newer
    /// navigation superseded it — still has to answer everything parked
    /// behind it, exactly once: the replies fail now instead of the ops
    /// lingering until whichever page settles next and running against a
    /// document they never targeted. (On macOS a failed load fires no
    /// `Finished` at all — wry maps no failure callback — so supersede and
    /// stop are the only exits those ops get.)
    fn fail_parked_agent_ops(&mut self, reason: &str) {
        for op in std::mem::take(&mut self.agent_queue) {
            let _ = op.reply.send(Err(reason.to_owned()));
        }
    }

    /// Agent entry point for "what does the page look like": captures the
    /// live page and answers `reply` with a base64-encoded PNG of it.
    /// Fails cleanly — an `Err` reply — when there is no webview to capture
    /// or the platform has no capture path yet.
    pub fn agent_screenshot(&mut self, reply: AgentReply, cx: &mut Context<Self>) {
        #[cfg(target_os = "macos")]
        {
            use objc2_app_kit::NSImage;
            use objc2_foundation::NSError;

            let Some(host) = self.host.clone() else {
                let _ = reply.send(Err("the webview is not available".to_owned()));
                return;
            };
            let deferred = Deferred {
                executor: cx.foreground_executor().clone(),
                cx: cx.to_async(),
                view: cx.entity().downgrade(),
            };
            // Blocks are typed as callable more than once, but the snapshot
            // completion fires exactly once — the reply rides in a `Cell`
            // taken on its one call, the same single-fire shape
            // `evaluate_json` gives its boxed callback.
            let reply = std::cell::Cell::new(Some(reply));
            let completion = block2::RcBlock::new(move |image: *mut NSImage, _: *mut NSError| {
                // One raw-pixel copy inside the WebKit callout, like
                // `request_snapshot`; the PNG encode and base64 happen
                // in the deferred hop below, where milliseconds of work
                // delay no paint.
                let pixels = unsafe { image.as_ref() }.and_then(snapshot_pixels);
                let reply = reply.take().expect("WebKit called the completion twice");
                deferred.update(move |_, _| {
                    let _ = reply.send(
                        pixels
                            .and_then(snapshot_png)
                            .ok_or_else(|| "the page could not be captured".to_owned()),
                    );
                });
            });
            unsafe {
                host.wk()
                    .takeSnapshotWithConfiguration_completionHandler(None, &completion)
            };
        }
        #[cfg(target_os = "windows")]
        {
            use base64::Engine as _;

            let Some(host) = self.host.clone() else {
                let _ = reply.send(Err("the webview is not available".to_owned()));
                return;
            };
            let deferred = Deferred {
                executor: cx.foreground_executor().clone(),
                cx: cx.to_async(),
                view: cx.entity().downgrade(),
            };
            host.capture_preview(Box::new(move |png| {
                // The stream copy happened in the WebView2 callout; the
                // base64 encode happens in the deferred hop, where
                // milliseconds of work delay no paint — the same split the
                // macOS capture gives its PNG encode.
                deferred.update(move |_, _| {
                    let _ = reply.send(
                        png.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
                    );
                });
            }));
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            // Linux has no capture path; the channel still hears an answer
            // so nothing blocks on silence.
            let _ = cx;
            let _ = reply.send(Err(
                "agent screenshots are not implemented on this platform yet".to_owned(),
            ));
        }
    }

    /// Evaluate `script` in the page and send the answer to `reply`. The
    /// completion lands on the main thread inside a native callout —
    /// possibly while GPUI is mid-update — so the reply goes out from the
    /// [`Deferred`] hop, the same shape [`Self::request_snapshot`] gives
    /// snapshot completions. A view that dies before the completion still
    /// answers: the dropped sender is the receiver's error, not a hang.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn run_agent_script(&mut self, script: String, reply: AgentReply, cx: &mut Context<Self>) {
        let Some(host) = self.host.clone() else {
            let _ = reply.send(Err("the webview is not available".to_owned()));
            return;
        };
        let deferred = Deferred {
            executor: cx.foreground_executor().clone(),
            cx: cx.to_async(),
            view: cx.entity().downgrade(),
        };
        host.evaluate_json(
            &script,
            Box::new(move |result| {
                // Nothing in the entity changes on the way by; the hop exists
                // so the send happens off the native callout stack, ordered
                // with the entity updates around it.
                deferred.update(move |_, _| {
                    let _ = reply.send(result);
                });
            }),
        );
    }

    /// No native host means no page to evaluate in; the reply still goes
    /// out so nothing waits on a channel that will never speak.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn run_agent_script(&mut self, _script: String, reply: AgentReply, _cx: &mut Context<Self>) {
        let _ = reply.send(Err(
            "the browser surface is unavailable on this platform".to_owned()
        ));
    }

    /// Keep GPUI focus and the native first responder coherent. They are
    /// separate systems: clicks inside the webview move only the native side,
    /// clicks on GPUI controls move only GPUI's — and Zed's view never hands
    /// the native keyboard back on its own, because without native children it
    /// never loses it. Both directions are edge-triggered so neither rule
    /// fights the other's steady state:
    ///
    /// - GPUI focus just moved to a real control while the page held the
    ///   native keyboard → the control wins; reclaim the native first
    ///   responder or every keystroke would keep going to the page.
    /// - The webview just became natively focused with GPUI focus unchanged →
    ///   mirror GPUI onto this surface so Browser-scoped key bindings resolve.
    fn reconcile_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let natively_focused = self
            .host
            .as_ref()
            .is_some_and(|host| host.native_focus_within());
        let window_focus = window.focused(cx);
        let native_became_focused = natively_focused && !self.was_natively_focused;
        let window_focus_changed = window_focus != self.last_window_focus;
        let focus_on_gpui_control = window_focus
            .as_ref()
            .is_some_and(|focus| *focus != self.focus_handle);

        if natively_focused && window_focus_changed && focus_on_gpui_control {
            self.reclaim_native_keyboard(cx);
        } else if native_became_focused && !window_focus_changed {
            if self.address.read(cx).focus().is_focused(window) {
                // A stale native edge must never rip GPUI focus out of the
                // address bar mid-typing — the keyboard comes back instead.
                self.reclaim_native_keyboard(cx);
            } else {
                window.focus(&self.focus_handle, cx);
            }
        }

        self.was_natively_focused = natively_focused;
        self.last_window_focus = window_focus;
    }

    /// One of the surface's text fields (address bar, device-size fields)
    /// taking focus means the page must hand the native keyboard back, or
    /// every keystroke keeps going to the webview.
    fn reclaim_keyboard_from_page(&mut self, cx: &mut Context<Self>) {
        if self
            .host
            .as_ref()
            .is_some_and(|host| host.native_focus_within())
        {
            self.reclaim_native_keyboard(cx);
        }
    }

    /// Return the native first responder to GPUI's view — deferred, since
    /// `makeFirstResponder` runs responder callbacks that may re-enter GPUI.
    fn reclaim_native_keyboard(&mut self, _cx: &mut Context<Self>) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(host) = self.host.clone() {
            _cx.foreground_executor()
                .spawn(async move {
                    #[cfg(target_os = "macos")]
                    let _ = host.webview.focus_parent();
                    #[cfg(target_os = "windows")]
                    host.focus_parent();
                })
                .detach();
        }
    }

    #[cfg(target_os = "macos")]
    fn estimated_progress(&self) -> f64 {
        self.host
            .as_ref()
            .map(|host| unsafe { host.wk().estimatedProgress() })
            .unwrap_or(0.0)
    }

    #[cfg(not(target_os = "macos"))]
    fn estimated_progress(&self) -> f64 {
        0.0
    }

    fn go_back(&mut self, _cx: &mut Context<Self>) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(host) = &self.host {
            let _ = host.webview.go_back();
            self.refresh_navigation_state();
            _cx.notify();
        }
    }

    fn go_forward(&mut self, _cx: &mut Context<Self>) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(host) = &self.host {
            let _ = host.webview.go_forward();
            self.refresh_navigation_state();
            _cx.notify();
        }
    }

    fn reload(&mut self, _cx: &mut Context<Self>) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(host) = &self.host
            && self.navigation_requested
        {
            let _ = host.webview.reload();
            self.loading = true;
            _cx.notify();
        }
    }

    fn hard_reload(&mut self, _cx: &mut Context<Self>) {
        #[cfg(target_os = "macos")]
        if let Some(host) = &self.host
            && self.navigation_requested
        {
            unsafe { host.wk().reloadFromOrigin() };
            self.loading = true;
            _cx.notify();
        }
        // WebView2 exposes no cache-bypassing reload; the scripted form is the
        // closest equivalent the page itself can perform.
        #[cfg(target_os = "windows")]
        if let Some(host) = &self.host
            && self.navigation_requested
        {
            let _ = host.webview.evaluate_script("location.reload(true)");
            self.loading = true;
            _cx.notify();
        }
    }

    fn stop_loading(&mut self, _cx: &mut Context<Self>) {
        // Stopping abandons the in-flight load; the ops parked behind it
        // fail now instead of waiting on a finish that will not come.
        self.fail_parked_agent_ops("the page load was stopped");
        #[cfg(target_os = "macos")]
        if let Some(host) = &self.host {
            unsafe { host.wk().stopLoading() };
            self.loading = false;
            self.refresh_navigation_state();
            _cx.notify();
        }
        #[cfg(target_os = "windows")]
        if let Some(host) = &self.host {
            let _ = host.webview.stop();
            self.loading = false;
            self.refresh_navigation_state();
            _cx.notify();
        }
    }

    fn toggle_devtools(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(host) = &self.host {
            if host.webview.is_devtools_open() {
                host.webview.close_devtools();
            } else {
                host.webview.open_devtools();
            }
        }
        // WebView2's devtools are a separate top-level window that the user
        // closes; there is no API to ask whether it is open, let alone shut
        // it, so this opens and re-focuses instead of toggling.
        #[cfg(target_os = "windows")]
        if let Some(host) = &self.host {
            let _ = host.webview.open_devtools();
        }
    }

    fn open_external(&self, cx: &mut Context<Self>) {
        if let Some(url) = &self.current_url {
            cx.open_url(url);
        }
    }

    /// Forward a standard editing selector to the webview. GPUI's window view
    /// claims key equivalents before AppKit's responder chain reaches the
    /// webview, so Browser-scoped bindings route the classics back natively.
    #[cfg(target_os = "macos")]
    fn perform_editing_selector(&self, selector: objc2::runtime::Sel) {
        use objc2::runtime::{AnyObject, NSObjectProtocol};

        if let Some(host) = &self.host {
            let view = host.ns_view();
            if !view.respondsToSelector(selector) {
                return;
            }
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: *mut AnyObject =
                unsafe { objc2::msg_send![view, performSelector: selector, withObject: nil] };
        }
    }

    /// Run a document editing command in the page.
    ///
    /// WebView2 handles the standard chords itself when the page holds the
    /// keyboard; this covers the case where Tide's own Browser-scoped
    /// bindings claimed the keystroke first.
    #[cfg(target_os = "windows")]
    fn perform_editing_command(&self, command: &str) {
        if let Some(host) = &self.host {
            let _ = host
                .webview
                .evaluate_script(&format!("document.execCommand('{command}')"));
        }
    }

    fn webview_copy(&self) {
        #[cfg(target_os = "macos")]
        self.perform_editing_selector(objc2::sel!(copy:));
        #[cfg(target_os = "windows")]
        self.perform_editing_command("copy");
    }

    fn webview_cut(&self) {
        #[cfg(target_os = "macos")]
        self.perform_editing_selector(objc2::sel!(cut:));
        #[cfg(target_os = "windows")]
        self.perform_editing_command("cut");
    }

    fn webview_paste(&self) {
        #[cfg(target_os = "macos")]
        self.perform_editing_selector(objc2::sel!(paste:));
        #[cfg(target_os = "windows")]
        self.perform_editing_command("paste");
    }

    fn webview_select_all(&self) {
        #[cfg(target_os = "macos")]
        self.perform_editing_selector(objc2::sel!(selectAll:));
        #[cfg(target_os = "windows")]
        self.perform_editing_command("selectAll");
    }

    fn toolbar_button(
        &self,
        id: &'static str,
        icon_path: &'static str,
        enabled: bool,
        tooltip: String,
        theme: Theme,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let base = div()
            .id(id)
            .size(px(26.0))
            .rounded(px(6.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default();
        if !enabled {
            return base.child(icon(icon_path, 14.0, theme.text_ghost));
        }
        base.hover(|element| element.bg(theme.overlay))
            .active(|element| element.bg(theme.overlay_strong))
            .child(icon(icon_path, 14.0, theme.text_secondary))
            .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
            .on_click(cx.listener(move |this, _, window, cx| {
                on_click(this, window, cx);
            }))
    }

    fn render_toolbar(&self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        let has_page = self.navigation_requested;
        let secure = self.current_url.as_deref().is_some_and(is_secure_url);
        let progress = self
            .loading
            .then(|| (self.estimated_progress().clamp(0.04, 1.0) * 1000.0).round() / 1000.0);

        div()
            .h(px(TOOLBAR_HEIGHT))
            .flex_none()
            .px(px(10.0))
            .flex()
            .items_center()
            .gap(px(2.0))
            .border_b_1()
            .border_color(theme.border)
            .child(self.toolbar_button(
                "browser-back",
                "icons/arrow-left.svg",
                self.can_go_back,
                tr!(
                    "browser.back",
                    shortcut = crate::platform::primary_shortcut("⌘[", "Ctrl+[")
                ),
                theme,
                |this, _, cx| this.go_back(cx),
                cx,
            ))
            .child(self.toolbar_button(
                "browser-forward",
                "icons/arrow-right.svg",
                self.can_go_forward,
                tr!(
                    "browser.forward",
                    shortcut = crate::platform::primary_shortcut("⌘]", "Ctrl+]")
                ),
                theme,
                |this, _, cx| this.go_forward(cx),
                cx,
            ))
            .child(if self.loading {
                self.toolbar_button(
                    "browser-stop",
                    "icons/x.svg",
                    true,
                    tr!("browser.stop_loading"),
                    theme,
                    |this, _, cx| this.stop_loading(cx),
                    cx,
                )
            } else {
                self.toolbar_button(
                    "browser-reload",
                    "icons/rotate-cw.svg",
                    has_page,
                    tr!(
                        "browser.reload",
                        shortcut = crate::platform::primary_shortcut("⌘R", "Ctrl+R")
                    ),
                    theme,
                    |this, _, cx| this.reload(cx),
                    cx,
                )
            })
            .child(
                TextField::new("browser-address", self.address.clone())
                    .icon(
                        if secure {
                            "icons/lock.svg"
                        } else {
                            "icons/globe.svg"
                        },
                        11.0,
                    )
                    .key_context("BrowserAddress")
                    .on_action(cx.listener(|this, _: &crate::BrowserAddressCancel, _, cx| {
                        this.restore_address(cx);
                    }))
                    .min_w_0()
                    .flex_1()
                    .mx(px(4.0))
                    .relative()
                    .when_some(progress, |element, progress| {
                        element.child(
                            div()
                                .absolute()
                                .bottom_0()
                                .left_0()
                                .h(px(2.0))
                                .w(gpui::relative(progress as f32))
                                .rounded_full()
                                .bg(theme.accent),
                        )
                    }),
            )
            // Chrome's device-mode toggle sits right of the omnibox, not
            // among the navigation buttons; the row it opens lives under
            // this toolbar.
            .child(self.device_toggle_button(theme, cx))
            .children(self.agent_activity_indicator(theme))
            .child(self.toolbar_button(
                "browser-open-external",
                "icons/external-link.svg",
                has_page,
                tr!("browser.open_external"),
                theme,
                |this, _, cx| this.open_external(cx),
                cx,
            ))
    }

    /// Lights beside the device toggle while agent tool calls are driving
    /// this view — the browser is momentarily not only the user's. Not a
    /// control: nothing to click, it only reports.
    fn agent_activity_indicator(&self, theme: Theme) -> Option<Stateful<Div>> {
        (self.agent_tool_calls > 0).then(|| {
            div()
                .id("browser-agent-activity")
                .size(px(26.0))
                .rounded(px(6.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .child(icon("icons/square-mouse-pointer.svg", 14.0, theme.accent))
                .tooltip(move |window, cx| {
                    Tooltip::new(tr!("browser.agent_activity")).build(window, cx)
                })
        })
    }

    /// The device-mode toggle: a toolbar button like the others, but with an
    /// on state — the icon lights up while the viewport is pinned. Like
    /// reload, it needs a page: there is nothing to pin a viewport around on
    /// the start page.
    fn device_toggle_button(&self, theme: Theme, cx: &mut Context<Self>) -> Stateful<Div> {
        let enabled = self.navigation_requested;
        let tint = if self.device_mode.is_some() {
            theme.accent
        } else {
            theme.text_secondary
        };
        let tooltip = tr!("browser.device_mode");
        let base = div()
            .id("browser-device-toggle")
            .size(px(26.0))
            .rounded(px(6.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default();
        if !enabled {
            return base.child(icon("icons/laptop.svg", 14.0, theme.text_ghost));
        }
        base.hover(|element| element.bg(theme.overlay))
            .active(|element| element.bg(theme.overlay_strong))
            .child(icon("icons/laptop.svg", 14.0, tint))
            .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
            .on_click(cx.listener(|this, _, _, cx| this.toggle_device_mode(cx)))
    }

    /// Chrome-style device toolbar: the slim second row under the main
    /// toolbar while device mode is on. The preset dropdown and the
    /// free-entry dimensions (Enter applies; anything that is not a bare
    /// integer restores the current dimension) live here, joined by the
    /// rotation toggle and the zoom dropdown — the dimensions are in the
    /// row, so the frame itself carries no readout chip. The main toolbar
    /// keeps only the toggle.
    fn render_device_toolbar(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let view = cx.entity().downgrade();
        div()
            .h(px(DEVICE_TOOLBAR_HEIGHT))
            .flex_none()
            .px(px(10.0))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(4.0))
            .border_b_1()
            .border_color(theme.border)
            .child(self.render_device_preset_menu(theme, view.clone()))
            .child(TextField::new("browser-device-width", self.device_width.clone()).w(px(54.0)))
            .child(
                div()
                    .flex_none()
                    .text_size(sp(11.0))
                    .text_color(theme.text_tertiary)
                    .child("×"),
            )
            .child(TextField::new("browser-device-height", self.device_height.clone()).w(px(54.0)))
            .child(self.toolbar_button(
                "browser-device-rotate",
                "icons/screen-rotation.svg",
                true,
                tr!("browser.rotate"),
                theme,
                |this, _, cx| this.rotate_device(cx),
                cx,
            ))
            .child(self.render_zoom_menu(theme, view))
    }

    /// What the preset chip shows: the active preset's name, or "Custom"
    /// once a drag, a typed size or the agent has left the table.
    fn device_preset_label(&self) -> SharedString {
        match self.device_preset.and_then(preset_entry) {
            Some(preset) => preset_menu_label(preset),
            None => tr!("browser.preset.custom").into(),
        }
    }

    /// The preset dropdown: the design's five shapes with the active one
    /// checked. Picking one pins its size and swaps its user agent (mobile
    /// presets) through the same one-source path as every other viewport
    /// change.
    fn render_device_preset_menu(
        &self,
        theme: Theme,
        view: WeakEntity<BrowserView>,
    ) -> gpui::AnyElement {
        let selected = self.device_preset;
        dropdown_menu(
            div()
                .id("browser-device-preset")
                .flex_none()
                .h(px(24.0))
                .px(px(5.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .gap(px(3.0))
                .border_1()
                .border_color(theme.border)
                .cursor_default()
                .hover(|element| element.bg(theme.overlay))
                .child(
                    div()
                        .text_size(sp(11.0))
                        .text_color(theme.text_secondary)
                        .child(self.device_preset_label()),
                )
                .child(icon("icons/chevron-down.svg", 9.0, theme.text_tertiary)),
            "browser-device-preset-menu",
            &self.device_preset_menu,
            MenuAlign::BelowLeft,
            move |_| {
                DEVICE_PRESETS
                    .iter()
                    .map(|entry| {
                        let view = view.clone();
                        MenuItem::new(preset_menu_label(entry), move |_, cx| {
                            let _ =
                                view.update(cx, |view, cx| view.apply_device_preset(entry.key, cx));
                        })
                        .selected(selected == Some(entry.key))
                    })
                    .collect()
            },
        )
    }

    /// The zoom dropdown: fit to the window or a fixed percentage, the
    /// active one checked. Picking one redraws the frame at the new scale;
    /// the paint path pushes the factor to the webview the frame it lands
    /// in — the emulated CSS viewport never changes with it.
    fn render_zoom_menu(&self, theme: Theme, view: WeakEntity<BrowserView>) -> gpui::AnyElement {
        let selected = self.device_zoom;
        dropdown_menu(
            div()
                .id("browser-device-zoom")
                .flex_none()
                .h(px(24.0))
                .px(px(5.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .gap(px(3.0))
                .border_1()
                .border_color(theme.border)
                .cursor_default()
                .hover(|element| element.bg(theme.overlay))
                .child(
                    div()
                        .text_size(sp(11.0))
                        .text_color(theme.text_secondary)
                        .child(zoom_label(selected)),
                )
                .child(icon("icons/chevron-down.svg", 9.0, theme.text_tertiary)),
            "browser-device-zoom-menu",
            &self.device_zoom_menu,
            MenuAlign::BelowLeft,
            move |_| {
                let mut items = Vec::with_capacity(6);
                let fit_view = view.clone();
                items.push(
                    MenuItem::new(tr!("browser.zoom_fit"), move |_, cx| {
                        let _ =
                            fit_view.update(cx, |view, cx| view.set_device_zoom(ZoomMode::Fit, cx));
                    })
                    .selected(selected == ZoomMode::Fit),
                );
                for percent in [50, 75, 100, 125, 150] {
                    let view = view.clone();
                    items.push(
                        MenuItem::new(format!("{percent}%"), move |_, cx| {
                            let _ = view.update(cx, |view, cx| {
                                view.set_device_zoom(ZoomMode::Fixed(percent), cx)
                            });
                        })
                        .selected(selected == ZoomMode::Fixed(percent)),
                    );
                }
                items
            },
        )
    }

    /// The pinned frame's chrome: an outline the webview fills exactly, and
    /// the corner resize handle — all in backdrop space, because on macOS
    /// the native webview paints over GPUI's base layer and would cover
    /// anything inside the frame. The frame centers and clamps like
    /// [`pinned_bounds`] and sizes at the zoom — device CSS pixels times
    /// the factor — so outline and webview always coincide. The dimensions
    /// themselves live in the device toolbar row, not in a chip here.
    fn render_device_frame(
        &self,
        device: DeviceViewport,
        snapshot: Option<std::sync::Arc<gpui::RenderImage>>,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        // The outline matches the painted frame. Fit needs the panel's
        // size, which the canvas paints in — one frame behind this layout —
        // so until one lands, Fit falls back to the unzoomed size.
        let (width, height) = match self.device_panel.get() {
            Some(panel) => {
                let (bounds, _) = pinned_bounds(panel, device, self.device_zoom);
                (f32::from(bounds.size.width), f32::from(bounds.size.height))
            }
            None => (device.width as f32, device.height as f32),
        };
        div()
            .relative()
            .flex_none()
            .w(px(width))
            .h(px(height))
            .max_w(gpui::relative(1.0))
            .max_h(gpui::relative(1.0))
            .border_1()
            .border_color(theme.border_strong)
            .when_some(snapshot, |element, snapshot| {
                element.child(
                    img(snapshot)
                        .absolute()
                        .size_full()
                        .object_fit(ObjectFit::Fill),
                )
            })
            .child(
                div()
                    .id("browser-device-handle")
                    .occlude()
                    .absolute()
                    .bottom(px(-7.0))
                    .right(px(-7.0))
                    .size(px(16.0))
                    .cursor_nwse_resize()
                    .on_drag(DeviceFrameDrag(device), {
                        // The ghost's drop is the drag-end hook — the settled
                        // size persists there, not per move.
                        let hop = Deferred {
                            executor: cx.foreground_executor().clone(),
                            cx: cx.to_async(),
                            view: cx.entity().downgrade(),
                        };
                        move |_, _, _, cx| {
                            cx.stop_propagation();
                            cx.new(|_| DeviceResizeEnd(Some(hop.clone())))
                        }
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseDownEvent, _, _| {
                            this.device_drag_origin = Some(event.position);
                        }),
                    )
                    .on_drag_move::<DeviceFrameDrag>(cx.listener(
                        |this, event: &DragMoveEvent<DeviceFrameDrag>, _, cx| {
                            let Some(origin) = this.device_drag_origin else {
                                return;
                            };
                            let size = event.drag(cx).0;
                            let delta = event.event.position - origin;
                            let resized = drag_resized(size, delta.x, delta.y);
                            this.set_device_viewport(resized.width, resized.height, cx);
                        },
                    )),
            )
    }

    fn render_start_page(&self, theme: Theme) -> Div {
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px(px(48.0))
            .pb(px(40.0))
            .child(icon("icons/globe.svg", 24.0, theme.text_ghost))
            .child(
                div()
                    .mt(px(14.0))
                    .text_size(sp(13.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(tr!("browser.browse_web")),
            )
            .child(
                div()
                    .mt(px(6.0))
                    .max_w(px(310.0))
                    .text_center()
                    .text_size(sp(12.5))
                    .line_height(sp(17.0))
                    .text_color(theme.text_tertiary)
                    .whitespace_normal()
                    .child(tr!(
                        "browser.start_hint",
                        shortcut = crate::platform::primary_shortcut("⌘L", "Ctrl+L")
                    )),
            )
    }

    fn render_host_error(&self, message: SharedString, theme: Theme) -> Div {
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px(px(48.0))
            .pb(px(40.0))
            .child(icon("icons/alert.svg", 22.0, theme.text_tertiary))
            .child(
                div()
                    .mt(px(14.0))
                    .text_size(sp(13.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .child(tr!("browser.unavailable")),
            )
            .child(
                div()
                    .mt(px(6.0))
                    .max_w(px(340.0))
                    .text_center()
                    .text_size(sp(12.5))
                    .line_height(sp(17.0))
                    .text_color(theme.text_tertiary)
                    .whitespace_normal()
                    .child(message),
            )
    }

    /// Push GPUI's mouse events into the visual-hosted page.
    ///
    /// Visual hosting delivers no input at all — with no window of its own,
    /// WebView2 never sees a click — so every event has to be translated and
    /// handed over explicitly. These are registered from paint rather than as
    /// element handlers so they can consult the page's hitbox, which is what
    /// stops a click on an open menu from also reaching the page underneath
    /// now that the page no longer hides itself for one, and so they can use
    /// GPUI's pointer capture, which keeps a text selection alive after the
    /// pointer leaves the panel.
    #[cfg(target_os = "windows")]
    fn forward_page_input(
        host: Rc<WebviewHost>,
        focus: FocusHandle,
        hitbox: gpui::Hitbox,
        window: &mut Window,
    ) {
        use gpui::{DispatchPhase, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ScrollWheelEvent};

        // The page's own cursor, applied the way every other GPUI element
        // applies one, so it survives GPUI reasserting its cursor per frame.
        window.set_cursor_style(host.cursor_style(), &hitbox);

        window.on_mouse_event({
            let host = host.clone();
            let hitbox = hitbox.clone();
            move |event: &MouseDownEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || !hitbox.is_hovered(window) {
                    return;
                }
                // Both focus systems move together: clicking the page is
                // how the user says the keyboard belongs to it now, and
                // whatever held GPUI focus — the address bar, the composer —
                // has to drop its caret to match. GPUI focus moves every
                // time, so `reconcile_focus` never reads the click as the
                // page stealing the keyboard from a control the user is
                // still using.
                window.focus(&focus, cx);
                if !host.native_focus_within() {
                    host.focus_page();
                }
                // Released automatically on the matching mouse up.
                window.capture_pointer(hitbox.id);
                host.mouse_down(
                    event.button,
                    event.position,
                    event.modifiers,
                    event.click_count,
                );
            }
        });

        window.on_mouse_event({
            let host = host.clone();
            let hitbox = hitbox.clone();
            move |event: &MouseUpEvent, phase, window, _| {
                if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                    host.mouse_up(event.button, event.position, event.modifiers);
                }
            }
        });

        window.on_mouse_event({
            let host = host.clone();
            let hitbox = hitbox.clone();
            move |event: &MouseMoveEvent, phase, window, _| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                if hitbox.is_hovered(window) {
                    host.mouse_move(event.position, event.modifiers);
                } else {
                    // Otherwise whatever the pointer left keeps its hover
                    // state, and the page's cursor never gives way.
                    host.mouse_leave();
                }
            }
        });

        window.on_mouse_event(move |event: &ScrollWheelEvent, phase, window, _| {
            if phase == DispatchPhase::Bubble && hitbox.should_handle_scroll(window) {
                host.scroll(event.position, event.delta, event.modifiers);
            }
        });
    }

    /// The page area: a canvas that mirrors its layout into the native view's
    /// frame, plus the frozen snapshot while a GPUI overlay is above us on a
    /// window without the scene-overlay plane. The native webview paints
    /// itself; GPUI paints what is underneath it — the surface colour shows
    /// only while a fallback snapshot is still being captured. The panel's
    /// resize handle keeps itself entirely left of this area, so the page owns
    /// the full width.
    fn render_page_area(&self, cx: &mut Context<Self>, theme: Theme) -> Div {
        let host = self.host.clone();
        #[cfg(target_os = "windows")]
        let input = self.host.clone();
        #[cfg(target_os = "windows")]
        let focus = self.focus_handle.clone();
        let device = self.device_mode;
        let zoom = self.device_zoom;
        let applied_zoom = self.device_applied_zoom.clone();
        let panel_size = self.device_panel.clone();
        let snapshot = self.occluded.then(|| self.snapshot.clone()).flatten();
        let mut page = div().flex_1().min_h_0().relative().bg(theme.surface).child(
            canvas(
                move |bounds, window, _| {
                    // The panel's size lands here first — the frame outline
                    // laid out moments earlier reads it next frame.
                    panel_size.set(Some(bounds.size));
                    // In device mode the webview lands at the pinned frame
                    // — centered, clamped to the panel, scaled by the zoom
                    // — and the hitbox follows the same rect so input and
                    // occlusion track the page, never the backdrop around
                    // it. The zoom rides page zoom, so the page keeps the
                    // device's CSS viewport while rendering at the scaled
                    // size; it applies only when the factor changed, never
                    // per frame.
                    let content = device.map_or(bounds, |device| {
                        let (pinned, factor) = pinned_bounds(bounds.size, device, zoom);
                        if let Some(host) = &host {
                            Self::push_device_zoom(host, &applied_zoom, factor);
                        }
                        gpui::Bounds {
                            origin: bounds.origin + pinned.origin,
                            size: pinned.size,
                        }
                    });
                    if let Some(host) = &host {
                        host.sync_bounds(content, window.scale_factor());
                    }
                    // A hitbox rather than a bare rectangle: it is what
                    // makes "is the pointer over the page" answer *no*
                    // while a GPUI menu is open above it, now that the
                    // page no longer hides itself for one.
                    window.insert_hitbox(content, HitboxBehavior::Normal)
                },
                move |_, _hitbox, _window, _| {
                    #[cfg(target_os = "windows")]
                    if let Some(host) = input {
                        Self::forward_page_input(host, focus, _hitbox, _window);
                    }
                },
            )
            .absolute()
            .size_full(),
        );
        if let Some(device) = device {
            page = page
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .bg(device_backdrop(theme.is_dark)),
                )
                .child(self.render_device_frame(device, snapshot, theme, cx));
        } else if let Some(snapshot) = snapshot {
            page = page.child(
                img(snapshot)
                    .absolute()
                    .size_full()
                    .object_fit(ObjectFit::Fill),
            );
        }
        page
    }
}

/// Distilled page-load event, so handler closures stay free of wry types.
#[derive(Clone, Copy)]
#[cfg(any(target_os = "macos", target_os = "windows"))]
enum PageLoad {
    Started,
    Finished,
}

/// Extract a WebKit snapshot's pixels as a tight BGRA `RgbaImage` — the
/// byte order [`gpui::RenderImage`] uploads as-is.
#[cfg(target_os = "macos")]
fn snapshot_pixels(image: &objc2_app_kit::NSImage) -> Option<image::RgbaImage> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapFormat, NSBitmapImageRep};

    let cg_image =
        unsafe { image.CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None) }?;
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg_image);
    if rep.isPlanar() || rep.bitsPerSample() != 8 {
        return None;
    }
    let width = usize::try_from(rep.pixelsWide()).ok()?;
    let height = usize::try_from(rep.pixelsHigh()).ok()?;
    let bytes_per_row = usize::try_from(rep.bytesPerRow()).ok()?;
    let samples = usize::try_from(rep.samplesPerPixel()).ok()?;
    let format = rep.bitmapFormat();
    let data = rep.bitmapData();
    if data.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, bytes_per_row.checked_mul(height)?) };
    let bgra = bgra_from_bitmap(
        bytes,
        width,
        height,
        bytes_per_row,
        samples,
        format.contains(NSBitmapFormat::AlphaFirst),
        format.contains(NSBitmapFormat::ThirtyTwoBitLittleEndian),
    )?;
    image::RgbaImage::from_raw(width as u32, height as u32, bgra)
}

/// Convert a WebKit snapshot into pixels GPUI paints synchronously.
///
/// The rep wraps the snapshot's `CGImage` without re-encoding; the only cost
/// is one pass over the pixel buffer into the tightly packed BGRA order
/// [`gpui::RenderImage`] uploads as-is.
#[cfg(target_os = "macos")]
fn snapshot_render_image(
    image: &objc2_app_kit::NSImage,
) -> Option<std::sync::Arc<gpui::RenderImage>> {
    Some(std::sync::Arc::new(gpui::RenderImage::new(vec![
        image::Frame::new(snapshot_pixels(image)?),
    ])))
}

/// The agent screenshot payload: the snapshot's BGRA pixels repacked to RGBA
/// and encoded as a base64 PNG. Runs in the deferred hop, off the WebKit
/// callout — an encode costs real milliseconds and the callout must stay
/// light. `None` means the encode failed; the caller answers `Err`.
#[cfg(target_os = "macos")]
fn snapshot_png(pixels: image::RgbaImage) -> Option<String> {
    use base64::Engine as _;
    use std::io::Cursor;

    let (width, height) = (pixels.width(), pixels.height());
    let mut rgba = pixels.into_raw();
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let mut png = Vec::new();
    image::RgbaImage::from_raw(width, height, rgba)?
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(png))
}

/// Repack an `NSBitmapImageRep` pixel buffer as tight BGRA rows.
///
/// The rep's channel order follows two format flags: `alpha_first` gives the
/// declared sample order, and 32-bit little-endian packing stores that order
/// reversed in memory. Snapshots are opaque, so premultiplication needs no
/// undoing. Returns `None` for layouts snapshots never use (fewer than three
/// samples, undersized buffers) — the caller falls back to no snapshot.
#[cfg(any(target_os = "macos", test))]
fn bgra_from_bitmap(
    bytes: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
    samples: usize,
    alpha_first: bool,
    little_endian_words: bool,
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || !(3..=4).contains(&samples) {
        return None;
    }
    let row_bytes = width.checked_mul(samples)?;
    if bytes_per_row < row_bytes || bytes.len() < bytes_per_row.checked_mul(height)? {
        return None;
    }

    // Where each output channel (B, G, R) lives within one pixel's bytes.
    let [b, g, r] = match (samples, alpha_first, little_endian_words) {
        (4, true, true) => [0, 1, 2], // memory B,G,R,A — the CGImage native case
        (4, false, false) => [2, 1, 0], // memory R,G,B,A
        (4, true, false) => [3, 2, 1], // memory A,R,G,B
        (4, false, true) => [1, 2, 3], // memory A,B,G,R
        _ => [2, 1, 0],               // 3-sample R,G,B
    };
    let alpha = match (samples, alpha_first, little_endian_words) {
        (4, true, true) => Some(3),
        (4, false, false) => Some(3),
        (4, true, false) => Some(0),
        (4, false, true) => Some(0),
        _ => None,
    };

    if (b, g, r, alpha) == (0, 1, 2, Some(3)) && bytes_per_row == row_bytes {
        return Some(bytes[..row_bytes * height].to_vec());
    }

    let mut out = Vec::with_capacity(width * height * 4);
    for row in bytes.chunks_exact(bytes_per_row).take(height) {
        for pixel in row[..row_bytes].chunks_exact(samples) {
            out.extend_from_slice(&[
                pixel[b],
                pixel[g],
                pixel[r],
                alpha.map_or(u8::MAX, |a| pixel[a]),
            ]);
        }
    }
    Some(out)
}

#[cfg(target_os = "macos")]
fn download_destination(url: &str, suggested: std::path::PathBuf) -> Option<std::path::PathBuf> {
    let downloads = dirs::download_dir()?;
    let name = suggested
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .or_else(|| {
            url.split(['?', '#'])
                .next()?
                .rsplit('/')
                .next()
                .map(str::to_owned)
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "download".to_owned());

    let path = downloads.join(&name);
    if !path.exists() {
        return Some(path);
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_owned(), format!(".{extension}")),
        _ => (name, String::new()),
    };
    (2..1000)
        .map(|counter| downloads.join(format!("{stem} ({counter}){extension}")))
        .find(|candidate| !candidate.exists())
}

#[cfg(target_os = "macos")]
fn reveal_in_finder(path: &std::path::Path) {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSArray, NSString, NSURL};

    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let urls = NSArray::from_retained_slice(&[url]);
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
}

impl Focusable for BrowserView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for BrowserView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::current(cx);
        self.reconcile_focus(window, cx);
        if self.loading {
            // `estimatedProgress` moves without any observable notification;
            // while a load is in flight the toolbar redraws with the frames.
            window.request_animation_frame();
        }

        // The chromeless twin: the page alone, filling whatever box the host
        // card measured. No per-surface id, focus context or bindings — many
        // of these can be embedded at once — but the focus reconciliation
        // above still runs, so a diagram that took the native keyboard hands
        // it back the moment GPUI focus moves to a real control.
        if self.chromeless {
            return div()
                .size_full()
                .min_h_0()
                .flex()
                .flex_col()
                .child(self.render_page_area(cx, theme))
                .into_any_element();
        }

        let body = if let Some(error) = self.host_error.clone() {
            self.render_host_error(error.into(), theme)
                .into_any_element()
        } else if self.navigation_requested {
            self.render_page_area(cx, theme).into_any_element()
        } else {
            self.render_start_page(theme).into_any_element()
        };

        div()
            .id("browser-surface")
            .track_focus(&self.focus_handle)
            .key_context("Browser")
            .on_action(cx.listener(|this, _: &BrowserBack, _, cx| this.go_back(cx)))
            .on_action(cx.listener(|this, _: &BrowserForward, _, cx| this.go_forward(cx)))
            .on_action(cx.listener(|this, _: &BrowserReload, _, cx| this.reload(cx)))
            .on_action(cx.listener(|this, _: &BrowserHardReload, _, cx| this.hard_reload(cx)))
            .on_action(cx.listener(|this, _: &BrowserStop, _, cx| this.stop_loading(cx)))
            .on_action(cx.listener(|this, _: &BrowserDevtools, _, _| this.toggle_devtools()))
            .on_action(cx.listener(|this, _: &FocusBrowserAddress, window, cx| {
                this.focus_address(window, cx);
            }))
            .on_action(cx.listener(|this, _: &WebviewCopy, _, _| this.webview_copy()))
            .on_action(cx.listener(|this, _: &WebviewCut, _, _| this.webview_cut()))
            .on_action(cx.listener(|this, _: &WebviewPaste, _, _| this.webview_paste()))
            .on_action(cx.listener(|this, _: &WebviewSelectAll, _, _| this.webview_select_all()))
            .size_full()
            .min_h_0()
            .flex()
            .flex_col()
            .child(self.render_toolbar(cx))
            // Chrome's device mode: the main toolbar keeps the toggle,
            // and while the mode is on a slim second row carries the
            // presets, dimensions, rotation and zoom.
            .when(self.device_mode.is_some(), |element| {
                element.child(self.render_device_toolbar(theme, cx))
            })
            .child(body)
            .into_any_element()
    }
}

/// The address input's context menu floats above the native webview's area,
/// so the app's occlusion sync needs to know when it is open.
impl BrowserView {
    pub fn overlay_open(&self, cx: &App) -> bool {
        self.address.read(cx).context_menu_open()
            || self.device_width.read(cx).context_menu_open()
            || self.device_height.read(cx).context_menu_open()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_resolve_like_an_omnibox() {
        assert_eq!(
            resolve_address("https://example.com"),
            Some(AddressTarget::Url("https://example.com".into()))
        );
        assert_eq!(
            resolve_address("localhost:3000"),
            Some(AddressTarget::Url("http://localhost:3000".into()))
        );
        assert_eq!(
            resolve_address("127.0.0.1:8080/api"),
            Some(AddressTarget::Url("http://127.0.0.1:8080/api".into()))
        );
        assert_eq!(
            resolve_address("example.com/docs?q=1"),
            Some(AddressTarget::Url("https://example.com/docs?q=1".into()))
        );
        assert_eq!(
            resolve_address("about:blank"),
            Some(AddressTarget::Url("about:blank".into()))
        );
        assert_eq!(
            resolve_address("rust borrow checker"),
            Some(AddressTarget::Search("rust borrow checker".into()))
        );
        assert_eq!(
            resolve_address("what is wry"),
            Some(AddressTarget::Search("what is wry".into()))
        );
        assert_eq!(
            resolve_address("readme"),
            Some(AddressTarget::Search("readme".into()))
        );
        assert_eq!(resolve_address("   "), None);
    }

    #[test]
    fn search_urls_encode_queries() {
        assert_eq!(
            search_url("rust borrow checker"),
            "https://www.google.com/search?q=rust+borrow+checker"
        );
        assert_eq!(
            search_url("a&b=c"),
            "https://www.google.com/search?q=a%26b%3Dc"
        );
    }

    #[test]
    fn the_address_bar_hides_only_the_https_scheme() {
        assert_eq!(display_url("https://example.com/x"), "example.com/x");
        assert_eq!(
            display_url("http://localhost:3000"),
            "http://localhost:3000"
        );
        assert!(is_secure_url("https://example.com"));
        assert!(!is_secure_url("http://localhost:3000"));
    }

    #[test]
    fn mermaid_documents_escape_the_source_and_follow_the_theme_mode() {
        let document = mermaid_document("graph TD\nA-->B", true);
        assert!(
            document.contains("<pre class=\"mermaid\">graph TD\nA--&gt;B</pre>"),
            "the source rides in the pre, HTML-escaped"
        );
        assert!(document.contains("theme: 'dark'"));
        assert!(document.contains("background: #1e1e1e;"));
        assert!(document.contains("startOnLoad: true"));
        assert!(
            document.contains("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"),
            "mermaid.js comes from the pinned CDN URL"
        );

        // Light mode gets the light ground and mermaid theme.
        let light = mermaid_document("graph TD", false);
        assert!(light.contains("theme: 'default'"));
        assert!(light.contains("background: #ffffff;"));

        // The escaping has to hold for source that quotes and tags itself:
        // inside the pre, angle brackets and ampersands are entities.
        let hostile = mermaid_document("a \"<script>&</script>\"", true);
        assert!(hostile.contains("&quot;&lt;script&gt;&amp;&lt;/script&gt;"));
        assert!(!hostile.contains("a \"<script>"));
    }

    #[test]
    fn mermaid_data_urls_percent_encode_everything_reserved() {
        let url = mermaid_data_url("graph TD\nA-->B", true);
        assert!(url.starts_with("data:text/html;charset=utf-8,"));

        // NSURL::URLWithString rejects raw spaces, newlines and quotes — the
        // payload must be fully encoded, leaving only unreserved bytes.
        let payload = &url["data:text/html;charset=utf-8,".len()..];
        assert!(
            payload
                .bytes()
                .all(|byte| is_url_unreserved(byte) || byte == b'%')
        );
        assert!(!payload.contains(' '));

        let decoded = percent_encode("<!doctype html>");
        assert_eq!(decoded, "%3C%21doctype%20html%3E");
        assert_eq!(percent_encode("azAZ09-._~"), "azAZ09-._~");
    }

    #[test]
    fn bitmap_repacking_reaches_bgra_from_every_snapshot_layout() {
        // One red pixel then one green pixel, expressed in each channel
        // layout `NSBitmapImageRep` can hand back for an 8-bit snapshot.
        let bgra = [0u8, 0, 255, 255, 0, 255, 0, 255];
        let rgba = [255u8, 0, 0, 255, 0, 255, 0, 255];
        let argb = [255u8, 255, 0, 0, 255, 0, 255, 0];
        let abgr = [255u8, 0, 0, 255, 255, 0, 255, 0];
        let rgb = [255u8, 0, 0, 0, 255, 0];
        let expected = vec![0u8, 0, 255, 255, 0, 255, 0, 255];

        assert_eq!(
            bgra_from_bitmap(&bgra, 2, 1, 8, 4, true, true),
            Some(expected.clone())
        );
        assert_eq!(
            bgra_from_bitmap(&rgba, 2, 1, 8, 4, false, false),
            Some(expected.clone())
        );
        assert_eq!(
            bgra_from_bitmap(&argb, 2, 1, 8, 4, true, false),
            Some(expected.clone())
        );
        assert_eq!(
            bgra_from_bitmap(&abgr, 2, 1, 8, 4, false, true),
            Some(expected.clone())
        );
        assert_eq!(
            bgra_from_bitmap(&rgb, 2, 1, 6, 3, false, false),
            Some(expected)
        );
    }

    #[test]
    fn bitmap_repacking_honors_row_padding_and_rejects_bad_layouts() {
        // Two rows of one RGBA pixel with 4 bytes of row padding.
        let padded = [
            255u8, 0, 0, 255, 9, 9, 9, 9, //
            0, 255, 0, 255, 9, 9, 9, 9,
        ];
        assert_eq!(
            bgra_from_bitmap(&padded, 1, 2, 8, 4, false, false),
            Some(vec![0, 0, 255, 255, 0, 255, 0, 255])
        );
        assert_eq!(bgra_from_bitmap(&[0; 8], 2, 1, 8, 2, false, false), None);
        assert_eq!(bgra_from_bitmap(&[0; 7], 2, 1, 8, 4, false, false), None);
        assert_eq!(bgra_from_bitmap(&[], 0, 0, 0, 4, false, false), None);
    }

    #[test]
    fn load_generation_advances_on_finish() {
        let (reply, _) = std::sync::mpsc::channel();
        let mut generation = 0;
        let mut queued = Vec::new();

        // A load begins — twice, as a redirect mid-load re-fires Started —
        // and an op arrives while it is in flight: it parks, and neither
        // Started touches the generation.
        assert!(
            agent_dispatch(
                true,
                AgentOp {
                    script: "1".to_owned(),
                    reply: reply.clone(),
                },
                &mut queued
            )
            .is_none()
        );
        assert!(
            agent_dispatch(
                true,
                AgentOp {
                    script: "2".to_owned(),
                    reply,
                },
                &mut queued
            )
            .is_none()
        );
        assert_eq!(queued.len(), 2);
        assert_eq!(generation, 0);

        // The load settles: the generation advances once and everything
        // parked during it drains, exactly once.
        let drained = agent_load_finished(&mut generation, &mut queued);
        assert_eq!(generation, 1);
        assert_eq!(drained.len(), 2);
        assert!(queued.is_empty());
        assert!(agent_load_finished(&mut generation, &mut queued).is_empty());
    }

    #[test]
    fn queued_agent_ops_wait_for_load() {
        let (reply, received) = std::sync::mpsc::channel();
        let mut generation = 0;
        let mut queued = Vec::new();

        // Mid-load the op parks: nothing runs, so nothing answers yet.
        assert!(
            agent_dispatch(
                true,
                AgentOp {
                    script: "window.__tideSnapshot()".to_owned(),
                    reply,
                },
                &mut queued
            )
            .is_none()
        );
        assert_eq!(queued.len(), 1);
        assert!(received.try_recv().is_err());

        // The load finishing hands the parked op over once — draining is
        // the running, and no later settle can hand the same op over again.
        assert_eq!(agent_load_finished(&mut generation, &mut queued).len(), 1);
        assert!(queued.is_empty());
        assert!(agent_load_finished(&mut generation, &mut queued).is_empty());
        assert!(received.try_recv().is_err());

        // With no load in flight, the same submission runs immediately
        // instead of parking: dispatch returns it, the queue stays empty.
        let (idle, _) = std::sync::mpsc::channel();
        assert!(
            agent_dispatch(
                false,
                AgentOp {
                    script: String::new(),
                    reply: idle,
                },
                &mut queued
            )
            .is_some()
        );
        assert!(queued.is_empty());
    }

    #[test]
    fn execute_script_results_unwrap_exactly_one_json_layer() {
        // The serializer returns what JSON.stringify produces; WebView2 hands
        // that back JSON-encoded once more. One decode leaves the page's own
        // JSON string, escapes and all — building the double-encoded input
        // with `to_string` mirrors exactly what the completion delivers.
        let snapshot = r#"{"url":"https://example.com/login","truncated":false,"tree":[{"ref":"s1e2","name":"a \"quoted\" button"}]}"#;
        let raw = serde_json::to_string(snapshot).unwrap();
        assert_eq!(unwrap_execute_script_result(&raw), snapshot);

        // Bare results — a page that clobbered the serializer (`null`), a
        // plain non-string return, an object handed back directly — are not
        // strings at the outer layer: they pass through untouched for the
        // caller to judge.
        assert_eq!(unwrap_execute_script_result("null"), "null");
        assert_eq!(unwrap_execute_script_result("123"), "123");
        assert_eq!(unwrap_execute_script_result("true"), "true");
        assert_eq!(
            unwrap_execute_script_result(r#"{"ok":false}"#),
            r#"{"ok":false}"#
        );
        // An empty-string return decodes to the empty string, not `""`.
        assert_eq!(unwrap_execute_script_result(r#""""#), "");
    }

    #[test]
    fn download_names_do_not_overwrite() {
        // Pure-logic check of the uniquing shape; the filesystem probe path is
        // exercised by using a directory that cannot collide.
        let unique = std::env::temp_dir().join(format!("tide-download-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&unique).unwrap();
        std::fs::write(unique.join("file.txt"), "x").unwrap();
        let (stem, extension) = match "file.txt".rsplit_once('.') {
            Some((stem, extension)) if !stem.is_empty() => {
                (stem.to_owned(), format!(".{extension}"))
            }
            _ => ("file.txt".to_owned(), String::new()),
        };
        let next = (2..1000)
            .map(|counter| unique.join(format!("{stem} ({counter}){extension}")))
            .find(|candidate| !candidate.exists())
            .unwrap();
        assert_eq!(next.file_name().unwrap().to_str().unwrap(), "file (2).txt");
        std::fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn pinned_bounds_center_in_panel() {
        // 1280×800 at 100% in a 1500×900 panel: exact device size, 110px
        // side margins, 50px vertical.
        let (bounds, factor) = pinned_bounds(
            gpui::size(px(1500.0), px(900.0)),
            DeviceViewport {
                width: 1280,
                height: 800,
            },
            ZoomMode::Fixed(100),
        );
        assert_eq!(factor, 1.0);
        assert_eq!(bounds.origin, gpui::point(px(110.0), px(50.0)));
        assert_eq!(bounds.size, gpui::size(px(1280.0), px(800.0)));

        // A device larger than the panel clamps to the panel — the origin
        // can never go negative.
        let (clamped, _) = pinned_bounds(
            gpui::size(px(1500.0), px(900.0)),
            DeviceViewport {
                width: 2000,
                height: 1000,
            },
            ZoomMode::Fixed(100),
        );
        assert_eq!(
            clamped,
            gpui::Bounds {
                origin: gpui::point(px(0.0), px(0.0)),
                size: gpui::size(px(1500.0), px(900.0)),
            }
        );

        // Odd leftover pixels split as evenly as centering allows.
        let (odd, _) = pinned_bounds(
            gpui::size(px(999.0), px(501.0)),
            DeviceViewport {
                width: 500,
                height: 500,
            },
            ZoomMode::Fixed(100),
        );
        assert_eq!(odd.origin, gpui::point(px(249.5), px(0.5)));
        assert_eq!(odd.size, gpui::size(px(500.0), px(500.0)));
    }

    #[test]
    fn device_zoom_fixed_scales_the_frame() {
        // A fixed percentage scales the frame literally: 50% of 1280×800
        // centered in a 1500×900 panel.
        let (bounds, factor) = pinned_bounds(
            gpui::size(px(1500.0), px(900.0)),
            DeviceViewport {
                width: 1280,
                height: 800,
            },
            ZoomMode::Fixed(50),
        );
        assert_eq!(factor, 0.5);
        assert_eq!(bounds.origin, gpui::point(px(430.0), px(250.0)));
        assert_eq!(bounds.size, gpui::size(px(640.0), px(400.0)));

        // A zoom past what fits clamps to the panel exactly like an
        // oversized device at 100%: 150% of 1280×800 is 1920×1200.
        let (clamped, factor) = pinned_bounds(
            gpui::size(px(1500.0), px(900.0)),
            DeviceViewport {
                width: 1280,
                height: 800,
            },
            ZoomMode::Fixed(150),
        );
        assert_eq!(factor, 1.5);
        assert_eq!(
            clamped,
            gpui::Bounds {
                origin: gpui::point(px(0.0), px(0.0)),
                size: gpui::size(px(1500.0), px(900.0)),
            }
        );
    }

    #[test]
    fn device_zoom_fit_takes_the_smaller_ratio() {
        // 390×844 fits a 1500×900 panel at 100% — fit never upscales, so
        // the frame sits centered at its configured size.
        let (bounds, factor) = pinned_bounds(
            gpui::size(px(1500.0), px(900.0)),
            DeviceViewport {
                width: 390,
                height: 844,
            },
            ZoomMode::Fit,
        );
        assert_eq!(factor, 1.0);
        assert_eq!(bounds.size, gpui::size(px(390.0), px(844.0)));
        assert_eq!(
            bounds.origin,
            gpui::point(px((1500.0 - 390.0) / 2.0), px((900.0 - 844.0) / 2.0))
        );

        // A wide device in a narrower panel binds on width instead:
        // 2000×500 fits at 75%, filling the width exactly.
        let (bounds, factor) = pinned_bounds(
            gpui::size(px(1500.0), px(900.0)),
            DeviceViewport {
                width: 2000,
                height: 500,
            },
            ZoomMode::Fit,
        );
        assert!((factor - 1500.0 / 2000.0).abs() < 1e-9);
        assert!((f32::from(bounds.size.width) - 1500.0).abs() < 1e-4);
        assert!((f32::from(bounds.size.height) - 375.0).abs() < 1e-4);
    }

    #[test]
    fn device_zoom_fit_clamps_both_ways() {
        // A tiny device stays at 100% — fit never upscales, so 100×100
        // renders at 100×100, centered.
        let (bounds, factor) = pinned_bounds(
            gpui::size(px(1500.0), px(900.0)),
            DeviceViewport {
                width: 100,
                height: 100,
            },
            ZoomMode::Fit,
        );
        assert_eq!(factor, 1.0);
        assert_eq!(bounds.size, gpui::size(px(100.0), px(100.0)));
        assert_eq!(bounds.origin, gpui::point(px(700.0), px(400.0)));

        // An oversized device bottoms out at 25% — 7680×4320 would want
        // ~19.5% — and the panel clamp still keeps the frame inside.
        let (bounds, factor) = pinned_bounds(
            gpui::size(px(1500.0), px(900.0)),
            DeviceViewport {
                width: 7680,
                height: 4320,
            },
            ZoomMode::Fit,
        );
        assert_eq!(factor, 0.25);
        assert_eq!(
            bounds,
            gpui::Bounds {
                origin: gpui::point(px(0.0), px(0.0)),
                size: gpui::size(px(1500.0), px(900.0)),
            }
        );
    }

    #[test]
    fn device_rotation_swaps_dimensions() {
        // Rotation trades the dimensions and stays in bounds; a double
        // rotation is the identity.
        let portrait = DeviceViewport {
            width: 390,
            height: 844,
        };
        assert_eq!(
            portrait.rotated(),
            DeviceViewport {
                width: 844,
                height: 390,
            }
        );
        assert_eq!(portrait.rotated().rotated(), portrait);

        // Extremes swap cleanly — both dimensions were already clamped.
        let extremes = DeviceViewport {
            width: MIN_DEVICE_DIMENSION,
            height: MAX_DEVICE_DIMENSION,
        };
        assert_eq!(
            extremes.rotated(),
            DeviceViewport {
                width: MAX_DEVICE_DIMENSION,
                height: MIN_DEVICE_DIMENSION,
            }
        );
    }

    #[test]
    fn device_mode_defaults_and_toggle() {
        // Off by default: no device mode, the page fills the panel.
        let mut mode: Option<DeviceViewport> = None;
        assert_eq!(mode, None);

        // Setting pins exactly what was asked, after dimension clamping.
        mode = Some(DeviceViewport::new(390, 844));
        assert_eq!(
            mode,
            Some(DeviceViewport {
                width: 390,
                height: 844
            })
        );
        assert_eq!(
            DeviceViewport::new(10, 20),
            DeviceViewport {
                width: MIN_DEVICE_DIMENSION,
                height: MIN_DEVICE_DIMENSION
            }
        );
        assert_eq!(
            DeviceViewport::new(99_999, 100_000),
            DeviceViewport {
                width: MAX_DEVICE_DIMENSION,
                height: MAX_DEVICE_DIMENSION
            }
        );

        // Clearing returns to fill.
        mode = None;
        assert_eq!(mode, None);

        // Toggling on from off starts at the last size — the default before
        // anything else — and toggling again turns it off.
        assert_eq!(
            device_mode_toggled(None, DEFAULT_DEVICE_VIEWPORT),
            Some(DEFAULT_DEVICE_VIEWPORT)
        );
        assert_eq!(
            device_mode_toggled(None, DeviceViewport::new(390, 844)),
            Some(DeviceViewport {
                width: 390,
                height: 844
            })
        );
        assert_eq!(
            device_mode_toggled(Some(DEFAULT_DEVICE_VIEWPORT), DEFAULT_DEVICE_VIEWPORT),
            None
        );

        // Free-entry fields parse bare integers and nothing else.
        assert_eq!(parse_dimension(" 1280 "), Some(1280));
        assert_eq!(parse_dimension("laptop"), None);
        assert_eq!(parse_dimension(""), None);
    }

    #[test]
    fn preset_table_matches_the_design() {
        // The curated, research-verified set (Sept 2026); the mobile
        // shapes carry a user agent, the desktop ones do not.
        assert_eq!(preset("galaxy-s25"), Some((360, 780, Some(PIXEL_UA))));
        assert_eq!(preset("iphone"), Some((390, 844, Some(IPHONE_UA))));
        assert_eq!(preset("iphone-17"), Some((402, 874, Some(IPHONE_UA))));
        assert_eq!(preset("pixel"), Some((412, 915, Some(PIXEL_UA))));
        assert_eq!(preset("iphone-17-air"), Some((420, 912, Some(IPHONE_UA))));
        assert_eq!(preset("pixel-10-pro-xl"), Some((432, 960, Some(PIXEL_UA))));
        assert_eq!(
            preset("iphone-17-pro-max"),
            Some((440, 956, Some(IPHONE_UA)))
        );
        assert_eq!(preset("ipad-mini"), Some((744, 1133, Some(IPAD_UA))));
        assert_eq!(preset("ipad"), Some((820, 1180, Some(IPAD_UA))));
        assert_eq!(preset("ipad-pro-13"), Some((1024, 1366, Some(IPAD_UA))));
        assert_eq!(preset("laptop"), Some((1280, 800, None)));
        assert_eq!(preset("laptop-l"), Some((1440, 900, None)));
        assert_eq!(preset("desktop"), Some((1920, 1080, None)));
        assert_eq!(preset("4k"), Some((3840, 2160, None)));
        assert_eq!(preset("nope"), None);
        // Sizes respect the dimension bounds — every preset is in range.
        for entry in DEVICE_PRESETS {
            assert_eq!(
                DeviceViewport::new(entry.width, entry.height).width,
                entry.width
            );
        }
    }

    #[test]
    fn restored_device_state_maps_prefs() {
        // Nothing persisted: off, at the default size, no preset, no agent,
        // fit to window — also what a legacy config without a zoom key
        // restores.
        let (mode, last, agent, key, zoom) = restored_device_state(None);
        assert_eq!(mode, None);
        assert_eq!(last, DEFAULT_DEVICE_VIEWPORT);
        assert_eq!(agent, None);
        assert_eq!(key, None);
        assert_eq!(zoom, ZoomMode::Fit);

        // A mobile preset comes back with its agent, even while disabled —
        // the size is remembered for the next toggle-on.
        let prefs = store::config::BrowserDevicePrefs {
            enabled: false,
            width: 390,
            height: 844,
            preset: Some("iphone".to_owned()),
            zoom_percent: None,
        };
        let (mode, last, agent, key, zoom) = restored_device_state(Some(prefs));
        assert_eq!(mode, None);
        assert_eq!(last, DeviceViewport::new(390, 844));
        assert_eq!(agent, Some(IPHONE_UA));
        assert_eq!(key, Some("iphone"));
        assert_eq!(zoom, ZoomMode::Fit);

        // Enabled pins; sizes clamp on the way in like every other path;
        // a persisted percentage comes back as the fixed mode.
        let prefs = store::config::BrowserDevicePrefs {
            enabled: true,
            width: 5,
            height: 99_999,
            preset: None,
            zoom_percent: Some(125),
        };
        let (mode, last, agent, key, zoom) = restored_device_state(Some(prefs));
        assert_eq!(
            mode,
            Some(DeviceViewport::new(
                MIN_DEVICE_DIMENSION,
                MAX_DEVICE_DIMENSION
            ))
        );
        assert_eq!(
            last,
            DeviceViewport::new(MIN_DEVICE_DIMENSION, MAX_DEVICE_DIMENSION)
        );
        assert_eq!(agent, None);
        assert_eq!(key, None);
        assert_eq!(zoom, ZoomMode::Fixed(125));

        // A preset the table no longer knows restores no agent — the
        // desktop default beats guessing at a mobile shape — while the
        // zoom restores regardless.
        let prefs = store::config::BrowserDevicePrefs {
            enabled: true,
            width: 412,
            height: 915,
            preset: Some("nexus".to_owned()),
            zoom_percent: Some(50),
        };
        let (_, _, agent, key, zoom) = restored_device_state(Some(prefs));
        assert_eq!(agent, None);
        assert_eq!(key, None);
        assert_eq!(zoom, ZoomMode::Fixed(50));
    }

    #[test]
    fn device_drag_snaps_to_whole_pixels() {
        let from = DeviceViewport {
            width: 1024,
            height: 768,
        };
        // Sub-pixel deltas land on the nearest whole CSS pixel.
        assert_eq!(
            drag_resized(from, px(0.6), px(-0.4)),
            DeviceViewport {
                width: 1025,
                height: 768
            }
        );
        assert_eq!(
            drag_resized(from, px(-0.6), px(0.4)),
            DeviceViewport {
                width: 1023,
                height: 768
            }
        );
        // Dragging past the bounds clamps instead of collapsing the frame.
        assert_eq!(
            drag_resized(from, px(-5000.0), px(-5000.0)),
            DeviceViewport {
                width: MIN_DEVICE_DIMENSION,
                height: MIN_DEVICE_DIMENSION
            }
        );
    }
}
