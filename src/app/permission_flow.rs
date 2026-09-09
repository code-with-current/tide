//! The floating drag-to-authorize panel for the macOS grants Computer Use
//! needs — Tide's native port of the UX popularized by
//! [PermissionFlow](https://github.com/jaywcjlove/PermissionFlow).
//!
//! When the user asks for Screen Recording or Accessibility from Settings →
//! Computer Use, Tide deep-links into the matching System Settings pane and
//! docks a small always-on-top panel under the Settings window. The panel
//! shows the Computer Use helper `.app` as a drag card: the user drags it
//! into the permission list instead of hunting for the bundle on disk. The
//! panel follows the Settings window while it moves and closes itself when
//! Settings closes or the grant lands.
//!
//! Anatomy:
//! - [`PermissionFlowHost`] — the per-Tide state, the shared event channel,
//!   and the drain that reacts to tracker and drag events.
//! - [`PermissionFlowPanel`] — the GPUI entity rendered inside the panel
//!   window (`WindowKind::Floating`, which the pinned GPUI fork opens as an
//!   `NSPanel` at `NSFloatingWindowLevel`; re-styled here into the
//!   non-activating, all-Spaces utility panel PermissionFlow uses).
//! - the settings tracker — a background thread polling the window server
//!   (`CGWindowListCopyWindowInfo`) for the System Settings frame. It needs
//!   no TCC permission of its own, which matters because Tide's own process
//!   is not Accessibility-trusted — the helper is. That also means the
//!   AX-observer path PermissionFlow adds when trusted is never available to
//!   us, so window-server polling is the only geometry source; it is the
//!   same fallback PermissionFlow bootstraps with, at the same cadence.
//! - the drag session — the GPUI card forwards a crossed drag threshold to
//!   AppKit's `beginDraggingSession` with a synthesized mouse event, so the
//!   drop the System Settings list receives is a real native file-URL drag.

use gpui::{ClickEvent, Context, Window};

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::Arc;

#[cfg(target_os = "macos")]
use crossbeam_channel::{Receiver, Sender, unbounded};
#[cfg(target_os = "macos")]
use gpui::{
    Bounds, FontWeight, IntoElement, MouseButton, Pixels, Point, Render, SharedString,
    WindowBackgroundAppearance, WindowBounds, WindowHandle, WindowKind, WindowOptions, div, img,
    prelude::*, px, size,
};

use super::Tide;

/// The privacy panes Tide guides the user through. Both are drag-to-authorize
/// pages whose list must contain the Computer Use helper bundle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PermissionPane {
    /// Privacy & Security → Screen Recording.
    ScreenRecording,
    /// Privacy & Security → Accessibility (labeled "Device Control and Data
    /// Access" on macOS 27 and later — the anchor is unchanged).
    Accessibility,
}

impl PermissionPane {
    #[cfg(target_os = "macos")]
    fn anchor(self) -> &'static str {
        match self {
            Self::ScreenRecording => "Privacy_ScreenCapture",
            Self::Accessibility => "Privacy_Accessibility",
        }
    }

    /// Whether the pane's grant is currently held, per the last probe.
    #[cfg(target_os = "macos")]
    fn granted(self, permissions: &ComputerPermissions) -> bool {
        match self {
            Self::ScreenRecording => permissions.screen_recording,
            Self::Accessibility => permissions.accessibility,
        }
    }
}

#[cfg(target_os = "macos")]
use crate::computer_use::ComputerPermissions;
#[cfg(target_os = "macos")]
use crate::theme::{Theme, sp};

/// Host state. Non-macOS builds carry nothing: the launch call falls back to
/// the helper's permission prompt and the drain is a no-op.
pub(crate) struct PermissionFlowHost {
    #[cfg(target_os = "macos")]
    session: Option<Session>,
    /// Latest tracker/drag events, drained on the UI thread's event pump.
    #[cfg(target_os = "macos")]
    events: Receiver<PermissionFlowEvent>,
    /// The tracker thread and drag delegate hold clones of this half; the
    /// channel outlives any single panel window.
    #[cfg(target_os = "macos")]
    sender: Sender<PermissionFlowEvent>,
}

impl Default for PermissionFlowHost {
    fn default() -> Self {
        #[cfg(target_os = "macos")]
        {
            let (sender, events) = unbounded();
            Self {
                session: None,
                events,
                sender,
            }
        }
        #[cfg(not(target_os = "macos"))]
        Self {}
    }
}

impl Tide {
    /// Launch the guidance flow for `pane`: open the System Settings pane and
    /// dock the floating drag panel next to it. Falls back to the helper's
    /// permission prompt off macOS.
    pub(super) fn launch_permission_flow(
        &mut self,
        pane: PermissionPane,
        event: &ClickEvent,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        #[cfg(target_os = "macos")]
        {
            // The panel launches from the clicked row, so capture the click
            // point in both coordinate systems before any window can move.
            let source = click_source_frame(event, window);
            self.start_permission_flow_session(pane, source, cx);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (pane, event, window);
            self.request_computer_permissions(true, cx);
        }
    }

    /// Drain tracker and drag events: dock the panel to the latest Settings
    /// frame, run the launch animation, flip mouse passthrough while the user
    /// drags, and close the panel when Settings goes away or the grant lands.
    pub(super) fn drain_permission_flow(&mut self, cx: &mut Context<Self>) -> bool {
        #[cfg(target_os = "macos")]
        {
            let mut changed = false;
            while let Ok(event) = self.permission_flow.events.try_recv() {
                changed = true;
                match event {
                    PermissionFlowEvent::Frame(frame) => self.apply_tracked_frame(frame, cx),
                    PermissionFlowEvent::SettingsGone => {
                        self.close_permission_flow(cx);
                        return true;
                    }
                    PermissionFlowEvent::DragStarted => self.set_panel_dragging(true, cx),
                    PermissionFlowEvent::DragEnded => self.set_panel_dragging(false, cx),
                    PermissionFlowEvent::CloseRequested => {
                        // The panel window already removed itself; only the
                        // host state and the tracker remain.
                        self.close_permission_flow(cx);
                        return true;
                    }
                }
            }

            // A landed grant ends the flow. The recheck loop feeds probe
            // results through `drain_computer_permission_events`, so the
            // status here is already fresh.
            if let Some(session) = &self.permission_flow.session
                && session.pane.granted(&self.computer_permissions)
            {
                self.close_permission_flow(cx);
                return true;
            }
            changed
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = cx;
            false
        }
    }

    /// Close the floating panel, stop the tracker, and clear the session.
    pub(super) fn close_permission_flow(&mut self, cx: &mut Context<Self>) {
        #[cfg(target_os = "macos")]
        if let Some(session) = self.permission_flow.session.take() {
            use std::sync::atomic::Ordering;
            session.shutdown.store(true, Ordering::Release);
            let _ = session
                .window
                .update(cx, |_, window, _| window.remove_window());
            clear_active_drag_source();
            cx.notify();
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = cx;
        }
    }
}

#[cfg(target_os = "macos")]
impl Tide {
    fn start_permission_flow_session(
        &mut self,
        pane: PermissionPane,
        source: Option<SourceFrame>,
        cx: &mut Context<Self>,
    ) {
        // One active panel at a time (PermissionFlow's rule too): relaunching
        // for another pane closes the previous panel and its tracker.
        self.close_permission_flow(cx);

        // Resolve the helper bundle off the UI thread — the first call may
        // install the Application Support copy, which is a disk-copy pass.
        // Everything after this continuation is main-thread AppKit and GPUI.
        cx.spawn(async move |tide, cx| {
            let resolved = cx
                .background_executor()
                .spawn(async move { resolve_helper_bundle() })
                .await;
            tide.update(cx, |tide, cx| {
                tide.open_permission_flow_panel(pane, source, resolved, cx);
            })
            .ok();
        })
        .detach();
    }

    fn open_permission_flow_panel(
        &mut self,
        pane: PermissionPane,
        source: Option<SourceFrame>,
        resolved: Option<HelperBundle>,
        cx: &mut Context<Self>,
    ) {
        // System Settings first, so the panel has a window to dock to.
        open_settings_pane(pane);

        let helper = match resolved {
            Some(helper) => helper,
            None => {
                // No helper in this build: Computer Use cannot run at all, so
                // the flow has nothing to offer — surface the old failure.
                self.show_toast(tr!("computer_use.flow_missing_helper"));
                return;
            }
        };

        let icon = load_helper_icon(&helper.path);
        let panel = cx
            .open_window(
                WindowOptions {
                    titlebar: None,
                    focus: false,
                    show: true,
                    kind: WindowKind::Floating,
                    is_movable: false,
                    is_resizable: false,
                    is_minimizable: false,
                    // Frosted: GPUI's blurred window background is the native
                    // behind-window material the mockup's glass reads as.
                    window_background: WindowBackgroundAppearance::Blurred,
                    window_bounds: Some(WindowBounds::Windowed(panel_initial_bounds(
                        source.as_ref(),
                    ))),
                    ..Default::default()
                },
                |window, cx| {
                    configure_native_panel(window);
                    cx.new(|_| {
                        PermissionFlowPanel::new(
                            helper,
                            icon,
                            self.permission_flow.sender.clone(),
                            self.event_wake_tx.clone(),
                        )
                    })
                },
            )
            .expect("failed to open permission panel window");

        let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
        start_settings_tracker(
            shutdown.clone(),
            self.permission_flow.sender.clone(),
            self.event_wake_tx.clone(),
        );

        // Launch animation: fly the panel from the clicked row to the docked
        // position. Honors the system reduce-motion setting.
        let anim = source
            .filter(|_| !cx.reduce_motion())
            .map(|source| LaunchAnim {
                from: launch_source_frame(&source),
                to: source.frame,
                start: std::time::Instant::now(),
                started: false,
            });

        self.permission_flow.session = Some(Session {
            pane,
            window: panel,
            shutdown,
            last_frame: None,
            last_docked: None,
            anim,
            dragging: false,
        });

        // While the panel is open, poll the grants so the panel closes itself
        // once the user flips the switch in System Settings.
        cx.spawn(async move |tide, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(2))
                    .await;
                let alive = tide
                    .update(cx, |tide, cx| {
                        if tide.permission_flow.session.is_some() {
                            tide.request_computer_permissions(false, cx);
                            true
                        } else {
                            false
                        }
                    })
                    .unwrap_or(false);
                if !alive {
                    return;
                }
            }
        })
        .detach();

        cx.notify();
    }

    /// Dock the panel to the freshly tracked Settings frame. During the
    /// launch animation the tracked frame only updates the destination, so
    /// the motion stays continuous; afterwards it snaps directly.
    fn apply_tracked_frame(&mut self, frame: Frame, cx: &mut Context<Self>) {
        let Some(session) = self.permission_flow.session.as_mut() else {
            return;
        };
        session.last_frame = Some(frame);
        if session.dragging {
            return;
        }
        let docked = docked_frame(frame);
        debug_log(&format!("dock: settings {frame:?} -> panel {docked:?}"));
        match &mut session.anim {
            Some(anim) => {
                anim.to = docked;
                if !anim.started {
                    anim.started = true;
                    anim.start = std::time::Instant::now();
                    self.run_launch_anim(cx);
                }
            }
            None => {
                if session.last_docked != Some(docked) {
                    session.last_docked = Some(docked);
                    let _ = session
                        .window
                        .update(cx, |_, window, _| apply_native_frame(window, docked));
                }
            }
        }
    }

    /// Fly the panel from the clicked row to the docked position: a short
    /// spring on a lifted quadratic path, stepped off the background executor
    /// at ~60 fps for the animation's duration only.
    fn run_launch_anim(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |tide, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(16))
                    .await;
                let done = tide
                    .update(cx, |tide, cx| {
                        let Some(session) = tide.permission_flow.session.as_mut() else {
                            return true;
                        };
                        let Some(anim) = session.anim.as_ref() else {
                            return true;
                        };
                        let elapsed = anim.start.elapsed().as_secs_f64();
                        if elapsed >= LAUNCH_DURATION {
                            let frame = anim.to;
                            session.anim = None;
                            let _ = session.window.update(cx, |_, window, _| {
                                apply_native_frame(window, frame);
                                set_panel_alpha(window, 1.0);
                            });
                            return true;
                        }
                        let progress = spring_progress(elapsed);
                        let frame = bezier_frame(anim.from, anim.to, progress);
                        let alpha = LAUNCH_INITIAL_ALPHA + (1.0 - LAUNCH_INITIAL_ALPHA) * progress;
                        let _ = session.window.update(cx, |_, window, _| {
                            apply_native_frame(window, frame);
                            set_panel_alpha(window, alpha);
                        });
                        false
                    })
                    .unwrap_or(true);
                if done {
                    return;
                }
            }
        })
        .detach();
    }

    /// While the user drags the app card, the panel becomes mouse-transparent
    /// and steps behind System Settings so the drop reaches the list.
    fn set_panel_dragging(&mut self, dragging: bool, cx: &mut Context<Self>) {
        let Some(session) = self.permission_flow.session.as_mut() else {
            return;
        };
        if session.dragging == dragging {
            return;
        }
        session.dragging = dragging;
        if !dragging {
            clear_active_drag_source();
        }
        let _ = session.window.update(cx, |panel, window, cx| {
            set_panel_passthrough(window, dragging);
            panel.drag_active = dragging;
            cx.notify();
        });
        cx.notify();
    }
}

// ─── Session state ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
struct Session {
    pane: PermissionPane,
    window: WindowHandle<PermissionFlowPanel>,
    /// Flipped when the panel closes so the tracker thread exits instead of
    /// polling forever; a superseded session's flag is also set on relaunch.
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    /// Latest window-server frame of System Settings, in AppKit coordinates.
    last_frame: Option<Frame>,
    /// The docked panel position derived from `last_frame`, kept so redundant
    /// tracker ticks skip the `setFrame` call.
    last_docked: Option<Frame>,
    /// Launch animation state; `None` once finished, or when reduced motion
    /// skips the animation entirely.
    anim: Option<LaunchAnim>,
    dragging: bool,
}

#[cfg(target_os = "macos")]
struct LaunchAnim {
    from: Frame,
    to: Frame,
    start: std::time::Instant,
    started: bool,
}

/// A rectangle in AppKit screen coordinates (origin at the bottom-left of the
/// primary display) — the coordinate system `NSWindow.setFrame` speaks.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct Frame {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// The clicked row, in both coordinate systems: the panel's initial GPUI
/// bounds derive from the GPUI-global center, the launch animation starts
/// from the AppKit-space rect.
#[cfg(target_os = "macos")]
struct SourceFrame {
    gpui_center: (f64, f64),
    frame: Frame,
}

#[cfg(target_os = "macos")]
struct HelperBundle {
    path: PathBuf,
    name: String,
}

#[cfg(target_os = "macos")]
enum PermissionFlowEvent {
    /// The System Settings window moved or resized.
    Frame(Frame),
    /// System Settings has been gone for several consecutive polls.
    SettingsGone,
    /// The native dragging session began (panel becomes passthrough).
    DragStarted,
    /// The native dragging session ended.
    DragEnded,
    /// The user pressed the panel's close button.
    CloseRequested,
}

// ─── Panel window ───────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
const SETTINGS_BUNDLE_ID: &str = "com.apple.systempreferences";
/// The deep link scheme System Settings registers; each URL names a pane
/// identifier plus an anchor for the subsection.
#[cfg(target_os = "macos")]
const PRIVACY_SECURITY_PANE: &str = "com.apple.settings.PrivacySecurity.extension";

/// The panel is a fixed-size card; a fixed frame keeps the native panel
/// geometry, the tracker's docking math, and the drag card in step.
#[cfg(target_os = "macos")]
const PANEL_WIDTH: f32 = 480.0;
#[cfg(target_os = "macos")]
const PANEL_HEIGHT: f32 = 108.0;

/// PermissionFlow anchors the panel to the trailing content area of System
/// Settings — the leading sidebar is not the pane the user works in. The
/// width matches PermissionFlow's constant.
#[cfg(target_os = "macos")]
const SETTINGS_SIDEBAR_WIDTH: f64 = 230.0;
/// Screen-edge inset applied when clamping the panel onto its display.
#[cfg(target_os = "macos")]
const SCREEN_INSET: f64 = 12.0;
/// Breathing room between the Settings window edge and the docked panel.
#[cfg(target_os = "macos")]
const DOCK_GAP: f64 = 6.0;
/// Launch animation tuning — PermissionFlow's exact values: a critically
/// damped spring over 0.72 s (response 0.72), fading from 90% alpha.
#[cfg(target_os = "macos")]
const LAUNCH_DURATION: f64 = 0.72;
#[cfg(target_os = "macos")]
const LAUNCH_INITIAL_ALPHA: f64 = 0.9;
/// The panel dims while the app card is being dragged.
#[cfg(target_os = "macos")]
const DRAG_ALPHA: f64 = 0.72;

#[cfg(target_os = "macos")]
struct PermissionFlowPanel {
    helper: HelperBundle,
    helper_icon: Option<Arc<gpui::Image>>,
    /// Press point while the user holds the card, before the drag threshold.
    drag_armed: Option<Point<Pixels>>,
    /// True while the native dragging session runs (card dims, hand closes).
    drag_active: bool,
    events: Sender<PermissionFlowEvent>,
    wake: smol::channel::Sender<()>,
}

#[cfg(target_os = "macos")]
impl PermissionFlowPanel {
    fn new(
        helper: HelperBundle,
        helper_icon: Option<Arc<gpui::Image>>,
        events: Sender<PermissionFlowEvent>,
        wake: smol::channel::Sender<()>,
    ) -> Self {
        Self {
            helper,
            helper_icon,
            drag_armed: None,
            drag_active: false,
            events,
            wake,
        }
    }

    fn send(&self, event: PermissionFlowEvent) {
        if self.events.send(event).is_ok() {
            signal_event_pump(&self.wake);
        }
    }

    /// Start the native drag: hand the helper `.app` bundle to AppKit as a
    /// file-URL dragging session so System Settings receives a drop that
    /// looks like a Finder drag. The event carries the current mouse
    /// location — AppKit owns the event stream from here.
    fn begin_app_drag(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use objc2::AnyThread as _;
        use objc2::runtime::ProtocolObject;
        use objc2_app_kit::{
            NSDraggingFormation, NSDraggingItem, NSEvent, NSEventModifierFlags, NSEventType,
            NSWorkspace,
        };
        use objc2_foundation::{NSArray, NSPoint, NSRect, NSSize, NSString};

        let Some(native) = native_window(window) else {
            return;
        };
        let Some(content_view) = native.contentView() else {
            return;
        };

        let path = NSString::from_str(&self.helper.path.to_string_lossy());

        let writer = AppPasteboardWriter::new(path.clone());
        let item = NSDraggingItem::initWithPasteboardWriter(
            NSDraggingItem::alloc(),
            ProtocolObject::<dyn objc2_app_kit::NSPasteboardWriting>::from_retained(writer)
                .as_ref(),
        );

        let icon = NSWorkspace::sharedWorkspace().iconForFile(&path);
        icon.setSize(NSSize::new(56.0, 56.0));

        // The drag image starts centered under the cursor.
        let mouse = NSEvent::mouseLocation();
        let frame = native.frame();
        let location = NSPoint::new(mouse.x - frame.origin.x, mouse.y - frame.origin.y);
        unsafe {
            item.setDraggingFrame_contents(
                NSRect::new(
                    NSPoint::new(location.x - 28.0, location.y - 28.0),
                    NSSize::new(56.0, 56.0),
                ),
                Some(&*icon.into_super().into_super()),
            );
        }

        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDragged,
            location,
            NSEventModifierFlags(0),
            0.0,
            native.windowNumber(),
            None,
            0,
            0,
            0.0,
        );
        let Some(event) = event else {
            return;
        };

        let delegate = DragSourceDelegate::new(self.events.clone(), self.wake.clone());
        let source: objc2::rc::Retained<ProtocolObject<dyn objc2_app_kit::NSDraggingSource>> =
            ProtocolObject::from_retained(delegate);
        let session = content_view.beginDraggingSessionWithItems_event_source(
            &NSArray::from_retained_slice(&[item]),
            &event,
            &source,
        );
        session.setAnimatesToStartingPositionsOnCancelOrFail(true);
        session.setDraggingFormation(NSDraggingFormation::None);

        // `beginDraggingSession` does not retain its source; keep the
        // delegate alive until the drag ends (cleared by the drain).
        remember_active_drag_source(source);

        cx.notify();
    }
}

#[cfg(target_os = "macos")]
impl Render for PermissionFlowPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::current(cx);

        // The native frosted material (the panel window's blurred background)
        // is the backdrop; GPUI draws only the header and the drag card.
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .p(px(10.0))
            // Header: the one-line instruction, close at the end.
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(sp(13.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text)
                            .child(tr!("computer_use.flow_title")),
                    )
                    .child(
                        crate::ui::icon_button("permission-flow-close", "icons/x.svg", theme)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.send(PermissionFlowEvent::CloseRequested);
                                window.remove_window();
                                cx.notify();
                            })),
                    ),
            )
            // Body: the app to drag, on black translucent. Press and drag it
            // into the System Settings list.
            .child(
                if self.drag_active {
                    div().cursor_grabbing()
                } else {
                    div().cursor_grab()
                }
                .id("permission-flow-drag-card")
                .h(px(58.0))
                .rounded(px(11.0))
                .bg(gpui::black().alpha(if theme.is_dark { 0.42 } else { 0.34 }))
                .px(px(12.0))
                .flex()
                .items_center()
                .gap(px(11.0))
                .when_some(self.helper_icon.clone(), |element, icon| {
                    element.child(img(icon).w(px(38.0)).h(px(38.0)).rounded(px(9.0)))
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(sp(13.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(gpui::white().alpha(0.96))
                        .child(SharedString::from(self.helper.name.clone())),
                )
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, event: &gpui::MouseDownEvent, _, cx| {
                        this.drag_armed = Some(event.position);
                        cx.notify();
                    }),
                )
                .on_mouse_move(
                    cx.listener(|this, event: &gpui::MouseMoveEvent, window, cx| {
                        let Some(press) = this.drag_armed else {
                            return;
                        };
                        let dx = (event.position.x - press.x).abs();
                        let dy = (event.position.y - press.y).abs();
                        // The same 4 px threshold AppKit-native drag
                        // sources use to disambiguate clicks.
                        if dx > px(4.0) || dy > px(4.0) {
                            this.drag_armed = None;
                            this.begin_app_drag(window, cx);
                        }
                    }),
                )
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _: &gpui::MouseUpEvent, _, cx| {
                        if this.drag_armed.take().is_some() {
                            cx.notify();
                        }
                    }),
                ),
            )
    }
}

// ─── Launch animation math ──────────────────────────────────────────────────

/// Critically damped spring — accelerates, settles, never overshoots
/// (PermissionFlow's progress curve).
#[cfg(target_os = "macos")]
fn spring_progress(elapsed: f64) -> f64 {
    let omega = 2.0 * std::f64::consts::PI / LAUNCH_DURATION;
    let progress = 1.0 - (-omega * elapsed).exp() * (1.0 + omega * elapsed);
    progress.clamp(0.0, 1.0)
}

/// Interpolate along a lifted quadratic path so the panel arcs toward the
/// Settings window instead of sliding in a straight line.
#[cfg(target_os = "macos")]
fn bezier_frame(from: Frame, to: Frame, progress: f64) -> Frame {
    let width = from.w + (to.w - from.w) * progress;
    let height = from.h + (to.h - from.h) * progress;
    let start_center = (from.x + from.w / 2.0, from.y + from.h / 2.0);
    let end_center = (to.x + to.w / 2.0, to.y + to.h / 2.0);
    let midpoint = (
        (start_center.0 + end_center.0) / 2.0,
        start_center.1.max(end_center.1),
    );
    let distance =
        ((end_center.0 - start_center.0).powi(2) + (end_center.1 - start_center.1).powi(2)).sqrt();
    let lift = (140.0f64).min((44.0f64).max(distance * 0.18));
    let control = (midpoint.0, midpoint.1 + lift);
    let inverse = 1.0 - progress;
    let center = (
        inverse * inverse * start_center.0
            + 2.0 * inverse * progress * control.0
            + progress * progress * end_center.0,
        inverse * inverse * start_center.1
            + 2.0 * inverse * progress * control.1
            + progress * progress * end_center.1,
    );
    Frame {
        x: center.0 - width / 2.0,
        y: center.1 - height / 2.0,
        w: width,
        h: height,
    }
}

/// The animation's starting rect: a small card-sized frame centered on the
/// clicked row (PermissionFlow's `launchSourceFrame`).
#[cfg(target_os = "macos")]
fn launch_source_frame(source: &SourceFrame) -> Frame {
    let width = (32.0f64).max(PANEL_WIDTH as f64 * 0.58);
    let height = (32.0f64).max(PANEL_HEIGHT as f64 * 0.58);
    Frame {
        x: source.frame.x + source.frame.w / 2.0 - width / 2.0,
        y: source.frame.y + source.frame.h / 2.0 - height / 2.0,
        w: width,
        h: height,
    }
}

/// The clicked row in both coordinate systems, from the click's window-space
/// press point plus the window's GPUI-global origin.
#[cfg(target_os = "macos")]
fn click_source_frame(event: &ClickEvent, window: &Window) -> Option<SourceFrame> {
    let press = match event {
        ClickEvent::Mouse(event) => event.down.position,
        _ => return None,
    };
    let bounds = window.bounds();
    let center_x = f64::from(f32::from(bounds.origin.x)) + f64::from(f32::from(press.x));
    let center_y = f64::from(f32::from(bounds.origin.y)) + f64::from(f32::from(press.y));
    // GPUI's global space is top-left origin; AppKit's is bottom-left.
    let appkit_center_y = primary_display_height() - center_y;
    Some(SourceFrame {
        gpui_center: (center_x, center_y),
        frame: Frame {
            x: center_x - 16.0,
            y: appkit_center_y - 16.0,
            w: 32.0,
            h: 32.0,
        },
    })
}

/// Height of the primary display in points — the pivot between the two
/// global coordinate systems.
#[cfg(target_os = "macos")]
fn primary_display_height() -> f64 {
    unsafe { cf::CGDisplayBounds(cf::CGMainDisplayID()).size.height }
}

/// Initial GPUI window bounds: centered on the click (or a screen-center
/// stand-in when no source point exists).
#[cfg(target_os = "macos")]
fn panel_initial_bounds(source: Option<&SourceFrame>) -> Bounds<gpui::Pixels> {
    let (center_x, center_y) = source
        .map(|source| source.gpui_center)
        .unwrap_or_else(|| (800.0, 400.0));
    Bounds {
        origin: gpui::point(
            px((center_x - PANEL_WIDTH as f64 / 2.0) as f32),
            px((center_y - PANEL_HEIGHT as f64 / 2.0) as f32),
        ),
        size: size(px(PANEL_WIDTH), px(PANEL_HEIGHT)),
    }
}

/// Panel position relative to the Settings window: anchored to the bottom
/// end — flush with the trailing (right) edge, just below the window's
/// bottom edge. When there is no room below (the window sits near the Dock),
/// it flips to just above the window's top edge instead of overlapping it.
/// Everything is clamped to the visible frame of the display that holds the
/// Settings window.
#[cfg(target_os = "macos")]
fn docked_frame(settings: Frame) -> Frame {
    let width = (settings.w - SETTINGS_SIDEBAR_WIDTH)
        .max(240.0)
        .min(PANEL_WIDTH as f64);
    let height = PANEL_HEIGHT as f64;
    let x = settings.x + settings.w - width - DOCK_GAP;
    let visible = visible_frame_containing(settings);

    // AppKit y grows upward: below the window is a *smaller* y.
    let below = settings.y - DOCK_GAP - height;
    let fits_below = visible.is_none_or(|visible| below >= visible.y + SCREEN_INSET);
    let y = if fits_below {
        below
    } else {
        // No room below: dock above the window's top edge instead.
        let above = settings.y + settings.h + DOCK_GAP;
        match visible {
            Some(visible) => {
                let max_y = visible.y + visible.h - height - SCREEN_INSET;
                above.min(max_y)
            }
            None => above,
        }
    };

    let (x, y) = match visible {
        Some(visible) => {
            let min_x = visible.x + SCREEN_INSET;
            let max_x = (visible.x + visible.w - width - SCREEN_INSET).max(min_x);
            let min_y = visible.y + SCREEN_INSET;
            let max_y = (visible.y + visible.h - height - SCREEN_INSET).max(min_y);
            (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
        }
        None => (x, y),
    };

    Frame {
        x,
        y,
        w: width,
        h: height,
    }
}

/// The visible frame (menu bar and Dock excluded) of the display holding the
/// largest share of `settings`. Main-thread only — reads `NSScreen`.
#[cfg(target_os = "macos")]
fn visible_frame_containing(settings: Frame) -> Option<Frame> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;

    let screens = NSScreen::screens(MainThreadMarker::new()?);
    let mut best: Option<(f64, Frame)> = None;
    for screen in screens.iter() {
        let rect = frame_from_ns(screen.visibleFrame());
        let overlap = intersection_area(rect, settings);
        if overlap > 0.0 && best.as_ref().is_none_or(|(best, _)| overlap > *best) {
            best = Some((overlap, rect));
        }
    }
    best.map(|(_, rect)| rect)
}

#[cfg(target_os = "macos")]
fn frame_from_ns(rect: objc2_foundation::NSRect) -> Frame {
    Frame {
        x: rect.origin.x,
        y: rect.origin.y,
        w: rect.size.width,
        h: rect.size.height,
    }
}

#[cfg(target_os = "macos")]
fn intersection_area(a: Frame, b: Frame) -> f64 {
    let width = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
    let height = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
    if width <= 0.0 || height <= 0.0 {
        0.0
    } else {
        width * height
    }
}

// ─── Native panel styling and geometry ──────────────────────────────────────

/// The `NSWindow` behind a GPUI window, on the main thread.
#[cfg(target_os = "macos")]
fn native_window(window: &Window) -> Option<objc2::rc::Retained<objc2_app_kit::NSWindow>> {
    use objc2_app_kit::NSView;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return None;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return None;
    };
    // GPUI owns this view; AppKit access stays on the main thread.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    view.window()
}

/// Re-style GPUI's `Floating` panel into PermissionFlow's utility panel: it
/// never activates (System Settings keeps focus), joins all Spaces, and
/// survives app deactivation.
#[cfg(target_os = "macos")]
fn configure_native_panel(window: &Window) {
    use objc2_app_kit::{NSColor, NSWindowCollectionBehavior, NSWindowStyleMask};

    let Some(native) = native_window(window) else {
        return;
    };
    native.setStyleMask(native.styleMask() | NSWindowStyleMask::NonactivatingPanel);
    native.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    native.setHidesOnDeactivate(false);
    native.setMovable(false);
    native.setMovableByWindowBackground(false);
    native.setOpaque(false);
    native.setBackgroundColor(Some(&NSColor::clearColor()));
    native.setHasShadow(true);
}

#[cfg(target_os = "macos")]
fn apply_native_frame(window: &Window, frame: Frame) {
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let Some(native) = native_window(window) else {
        return;
    };
    native.setFrame_display(
        NSRect::new(
            NSPoint::new(frame.x, frame.y),
            NSSize::new(frame.w, frame.h),
        ),
        false,
    );
}

#[cfg(target_os = "macos")]
fn set_panel_alpha(window: &Window, alpha: f64) {
    let Some(native) = native_window(window) else {
        return;
    };
    native.setAlphaValue(alpha);
}

#[cfg(target_os = "macos")]
fn set_panel_passthrough(window: &Window, dragging: bool) {
    let Some(native) = native_window(window) else {
        return;
    };
    native.setIgnoresMouseEvents(dragging);
    native.setAlphaValue(if dragging { DRAG_ALPHA } else { 1.0 });
    if dragging {
        native.orderBack(None::<&objc2::runtime::AnyObject>);
    } else {
        native.orderFrontRegardless();
    }
}

// ─── Deep links ─────────────────────────────────────────────────────────────

/// Open System Settings on the pane's `Privacy & Security` subsection — the
/// same two-step open PermissionFlow's SettingsNavigator performs: launch the
/// app, then deliver the deep link URL.
#[cfg(target_os = "macos")]
fn open_settings_pane(pane: PermissionPane) {
    use objc2_app_kit::{NSWorkspace, NSWorkspaceOpenConfiguration};
    use objc2_foundation::{NSArray, NSString, NSURL};

    let workspace = NSWorkspace::sharedWorkspace();
    let settings_app = NSURL::fileURLWithPath(&NSString::from_str(
        "/System/Applications/System Settings.app",
    ));
    workspace.openURLs_withApplicationAtURL_configuration_completionHandler(
        &NSArray::from_retained_slice(&[]),
        &settings_app,
        &NSWorkspaceOpenConfiguration::configuration(),
        None,
    );

    let url = format!(
        "x-apple.systempreferences:{PRIVACY_SECURITY_PANE}?{}",
        pane.anchor()
    );
    if let Some(url) = NSURL::URLWithString(&NSString::from_str(&url)) {
        workspace.openURL(&url);
    }
}

// ─── Helper bundle ──────────────────────────────────────────────────────────

/// The installed helper `.app` bundle the user should drag into the list.
#[cfg(target_os = "macos")]
fn resolve_helper_bundle() -> Option<HelperBundle> {
    let path = backend::computer_use::helper_app_bundle().ok()?;
    let name = path.file_stem()?.to_string_lossy().into_owned();
    Some(HelperBundle { path, name })
}

/// The helper's Finder icon as a GPUI image, decoded once at panel open.
#[cfg(target_os = "macos")]
fn load_helper_icon(path: &Path) -> Option<Arc<gpui::Image>> {
    use objc2_foundation::NSString;
    crate::platform::app_icon_for_application_path(&NSString::from_str(&path.to_string_lossy()))
}

// ─── Settings window tracker ────────────────────────────────────────────────

/// One-shot bring-up diagnostics: run the app with
/// `TIDE_PERMISSION_FLOW_DEBUG=1` to see what the tracker sights and where
/// the panel docks.
#[cfg(target_os = "macos")]
fn debug_log(message: &str) {
    if std::env::var_os("TIDE_PERMISSION_FLOW_DEBUG").is_some() {
        eprintln!("[permission-flow] {message}");
    }
}

/// Poll the window server for the System Settings frame until the tracker is
/// shut down or Settings has been missing for twelve consecutive polls —
/// temporary misses are common while System Settings opens or swaps privacy
/// panes, so a single miss must not close the panel.
#[cfg(target_os = "macos")]
fn start_settings_tracker(
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    events: Sender<PermissionFlowEvent>,
    wake: smol::channel::Sender<()>,
) {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    std::thread::Builder::new()
        .name("permission-flow-tracker".into())
        .spawn(move || {
            let mut seen = false;
            let mut missing = 0u32;
            let mut last: Option<Frame> = None;
            while !shutdown.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(33));
                if shutdown.load(Ordering::Acquire) {
                    return;
                }
                match settings_pid().and_then(|pid| settings_window_frame(pid)) {
                    Some(frame) => {
                        if !seen {
                            debug_log(&format!("settings sighted: appkit frame = {frame:?}"));
                        }
                        seen = true;
                        missing = 0;
                        if last != Some(frame) {
                            last = Some(frame);
                            if events.send(PermissionFlowEvent::Frame(frame)).is_err() {
                                return;
                            }
                            signal_event_pump(&wake);
                        }
                    }
                    None => {
                        // System Settings can take seconds to show its first
                        // window on a cold launch. Like PermissionFlow, the
                        // gone-counter only runs once the app has been
                        // sighted at least once — misses before that are the
                        // launch itself, not a closed window.
                        if !seen {
                            continue;
                        }
                        missing += 1;
                        if missing >= 12 {
                            debug_log("settings gone; closing panel");
                            let _ = events.send(PermissionFlowEvent::SettingsGone);
                            signal_event_pump(&wake);
                            return;
                        }
                    }
                }
            }
        })
        .ok();
}

/// The event-pump wake shared with the app's drain loop (defined in `app.rs`).
#[cfg(target_os = "macos")]
use super::signal_event_pump;

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGPointVal {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGSizeVal {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGRectVal {
    origin: CGPointVal,
    size: CGSizeVal,
}

/// Hand-declared CoreFoundation/CoreGraphics symbols for the window-server
/// read. The pinned platform deps expose only a sliver of CoreGraphics, and
/// declaring these keeps the tracker free of a new crate — the same pattern
/// `platform.rs` uses for CoreText. None of these calls are main-thread
/// bound and none need a TCC grant, so the tracker thread owns the path.
#[cfg(target_os = "macos")]
mod cf {
    use super::CGRectVal;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        pub fn CGWindowListCopyWindowInfo(
            option: u32,
            relative_to_window: u32,
        ) -> *const std::ffi::c_void;
        pub fn CGMainDisplayID() -> u32;
        pub fn CGDisplayBounds(display: u32) -> CGRectVal;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        pub fn CFRelease(cf: *const std::ffi::c_void);
        pub fn CFArrayGetCount(array: *const std::ffi::c_void) -> isize;
        pub fn CFArrayGetValueAtIndex(
            array: *const std::ffi::c_void,
            index: isize,
        ) -> *const std::ffi::c_void;
        pub fn CFDictionaryGetValue(
            dict: *const std::ffi::c_void,
            key: *const std::ffi::c_void,
        ) -> *const std::ffi::c_void;
        pub fn CFNumberGetValue(
            number: *const std::ffi::c_void,
            kind: isize,
            value: *mut std::ffi::c_void,
        ) -> bool;
        pub fn CFStringCreateWithCString(
            alloc: *const std::ffi::c_void,
            c_str: *const u8,
            encoding: u32,
        ) -> *const std::ffi::c_void;
    }

    pub const WINDOW_LIST_ON_SCREEN_ONLY: u32 = 1 << 0;
    pub const WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    pub const NULL_WINDOW_ID: u32 = 0;
    pub const NUMBER_SINT32: isize = 3;
    // NOT 4 — that is `kCFNumberSInt64Type`; reading a double as 4 yields
    // bit-reinterpreted garbage.
    pub const NUMBER_FLOAT64: isize = 6;
    pub const STRING_UTF8: u32 = 0x0800_0100;
}

/// Keys for the window-server dictionary, all built by hand as plain
/// CFStrings (dictionary lookup matches by content, and hand-built keys skip
/// the SDK's export table entirely — `kCGWindowBundleID` is not even
/// linkable). The owner-metadata keys are only used for the PID: names and
/// bundle ids of *other* apps' windows are privacy-gated on modern macOS,
/// but the owner PID is not.
#[cfg(target_os = "macos")]
struct WindowKeys {
    owner_pid: *const std::ffi::c_void,
    layer: *const std::ffi::c_void,
    alpha: *const std::ffi::c_void,
    bounds: *const std::ffi::c_void,
    x: *const std::ffi::c_void,
    y: *const std::ffi::c_void,
    width: *const std::ffi::c_void,
    height: *const std::ffi::c_void,
}

// SAFETY: the keys are CFString constants created once and only read after.
#[cfg(target_os = "macos")]
unsafe impl Send for WindowKeys {}
#[cfg(target_os = "macos")]
unsafe impl Sync for WindowKeys {}

#[cfg(target_os = "macos")]
fn window_keys() -> &'static WindowKeys {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    static KEYS: OnceLock<WindowKeys> = OnceLock::new();
    KEYS.get_or_init(|| {
        fn key(name: &str) -> *const c_void {
            // Created once and intentionally leaked for the process lifetime.
            let bytes = std::ffi::CString::new(name).expect("literal key");
            // SAFETY: `c_str` is a valid NUL-terminated C string.
            unsafe {
                cf::CFStringCreateWithCString(
                    std::ptr::null(),
                    bytes.as_ptr().cast::<u8>(),
                    cf::STRING_UTF8,
                )
            }
        }
        WindowKeys {
            owner_pid: key("kCGWindowOwnerPID"),
            layer: key("kCGWindowLayer"),
            alpha: key("kCGWindowAlpha"),
            bounds: key("kCGWindowBounds"),
            x: key("X"),
            y: key("Y"),
            width: key("Width"),
            height: key("Height"),
        }
    })
}

#[cfg(target_os = "macos")]
fn dict_f64(dict: *const std::ffi::c_void, key: *const std::ffi::c_void) -> Option<f64> {
    unsafe {
        let value = cf::CFDictionaryGetValue(dict, key);
        if value.is_null() {
            return None;
        }
        let mut out = 0.0f64;
        cf::CFNumberGetValue(value, cf::NUMBER_FLOAT64, &mut out as *mut f64 as *mut _)
            .then_some(out)
    }
}

#[cfg(target_os = "macos")]
fn dict_i32(dict: *const std::ffi::c_void, key: *const std::ffi::c_void) -> Option<i32> {
    unsafe {
        let value = cf::CFDictionaryGetValue(dict, key);
        if value.is_null() {
            return None;
        }
        let mut out = 0i32;
        cf::CFNumberGetValue(value, cf::NUMBER_SINT32, &mut out as *mut i32 as *mut _)
            .then_some(out)
    }
}

/// The running System Settings process, resolved through Launch Services —
/// the class method is documented thread-safe, so the tracker thread can call
/// it. Settings may not be running yet when the panel opens; `None` then
/// simply means "keep waiting".
#[cfg(target_os = "macos")]
fn settings_pid() -> Option<i32> {
    use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication};
    use objc2_foundation::NSString;

    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(
        SETTINGS_BUNDLE_ID,
    ));
    for app in apps.iter() {
        // Prefer a UI-capable instance over prohibited-background helpers
        // (PermissionFlow's pick).
        if app.activationPolicy() != NSApplicationActivationPolicy::Prohibited {
            return Some(app.processIdentifier());
        }
    }
    None
}

/// Scan the on-screen window list for the windows owned by `pid` (the System
/// Settings process) and return the largest visible layer-0 window as the
/// tracked frame — the same heuristic PermissionFlow uses to find the main
/// document window. The owner PID is deliberately not privacy-gated (unlike
/// window names and bundle ids, which modern macOS omits for other apps'
/// windows). Needs no permission; runs on the tracker thread.
#[cfg(target_os = "macos")]
fn settings_window_frame(pid: i32) -> Option<Frame> {
    unsafe {
        let list = cf::CGWindowListCopyWindowInfo(
            cf::WINDOW_LIST_ON_SCREEN_ONLY | cf::WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
            cf::NULL_WINDOW_ID,
        );
        if list.is_null() {
            return None;
        }

        let keys = window_keys();
        let mut best: Option<(f64, Frame)> = None;
        let count = cf::CFArrayGetCount(list);
        for index in 0..count {
            let window = cf::CFArrayGetValueAtIndex(list, index);
            if window.is_null() {
                continue;
            }
            if dict_i32(window, keys.owner_pid) != Some(pid) {
                continue;
            }
            // Layer 0 only — the main document-sized window, not overlays.
            if dict_i32(window, keys.layer) != Some(0) {
                continue;
            }
            // A missing alpha entry means fully opaque.
            let alpha = dict_f64(window, keys.alpha).unwrap_or(1.0);
            if alpha <= 0.0 {
                continue;
            }
            let bounds = cf::CFDictionaryGetValue(window, keys.bounds);
            if bounds.is_null() {
                continue;
            }
            let (Some(x), Some(y), Some(w), Some(h)) = (
                dict_f64(bounds, keys.x),
                dict_f64(bounds, keys.y),
                dict_f64(bounds, keys.width),
                dict_f64(bounds, keys.height),
            ) else {
                continue;
            };
            // Reject small helper surfaces (menus, panels) so the tracked
            // frame stays the main window.
            if w <= 320.0 || h <= 240.0 {
                continue;
            }
            let area = w * h;
            if best
                .as_ref()
                .is_some_and(|(best_area, _)| area <= *best_area)
            {
                continue;
            }
            // CG and AppKit share the global space but disagree on the
            // vertical origin: flip over the primary display's height.
            let primary_height = primary_display_height();
            best = Some((
                area,
                Frame {
                    x,
                    y: primary_height - y - h,
                    w,
                    h,
                },
            ));
        }

        cf::CFRelease(list);
        best.map(|(_, frame)| frame)
    }
}

// ─── Native drag session ────────────────────────────────────────────────────

/// The pasteboard payload for the drag: the helper `.app` as a file URL plus
/// the legacy filename flavors, so System Settings accepts the drop like a
/// Finder-originated drag (PermissionFlow's `AppBundlePasteboardWriter`).
#[cfg(target_os = "macos")]
mod drag_classes {
    // `define_class!`'s protocol impls take bare idents only, so the
    // protocols are imported here rather than spelled as paths. The protocol
    // method names keep their camelCase selectors, hence the style allow.
    #![allow(non_snake_case)]
    use super::{PermissionFlowEvent, signal_event_pump};
    use crossbeam_channel::Sender;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{DefinedClass as _, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::{
        NSDragOperation, NSDraggingContext, NSDraggingSession, NSDraggingSource, NSPasteboard,
        NSPasteboardType, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSPoint, NSString, NSURL};

    define_class!(
        // SAFETY: `NSObject` has no subclassing requirements and the writer
        // owns only retained Objective-C values.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = AppPasteboardWriterIvars]
        pub(super) struct AppPasteboardWriter;

        unsafe impl NSObjectProtocol for AppPasteboardWriter {}

        unsafe impl NSPasteboardWriting for AppPasteboardWriter {
            // Retained-returning methods use `method_id` so the macro emits
            // the +1 retain return encoding.
            #[unsafe(method_id(writableTypesForPasteboard:))]
            fn writableTypesForPasteboard(
                &self,
                _pasteboard: &NSPasteboard,
            ) -> Retained<NSArray<NSPasteboardType>> {
                NSArray::from_retained_slice(&[
                    NSString::from_str("public.file-url"),
                    NSString::from_str("public.url"),
                    NSString::from_str("NSFilenamesPboardType"),
                    NSString::from_str("com.apple.pasteboard.promised-file-url"),
                    NSString::from_str("public.utf8-plain-text"),
                ])
            }

            #[unsafe(method_id(pasteboardPropertyListForType:))]
            fn pasteboardPropertyListForType(
                &self,
                r#type: &NSPasteboardType,
            ) -> Option<Retained<AnyObject>> {
                // The macro only transforms a trailing expression, so this
                // cannot use early `return`s.
                let path = &self.ivars().path;
                if r#type.isEqualToString(&NSString::from_str("public.file-url"))
                    || r#type.isEqualToString(&NSString::from_str("public.url"))
                    || r#type.isEqualToString(&NSString::from_str(
                        "com.apple.pasteboard.promised-file-url",
                    ))
                {
                    // File URLs always carry an absolute string form.
                    Some(
                        NSURL::fileURLWithPath(path)
                            .absoluteString()
                            .expect("file URL absolute string")
                            .into_super()
                            .into_super(),
                    )
                } else if r#type.isEqualToString(&NSString::from_str("NSFilenamesPboardType")) {
                    Some(
                        NSArray::from_retained_slice(std::slice::from_ref(path))
                            .into_super()
                            .into_super(),
                    )
                } else if r#type.isEqualToString(&NSString::from_str("public.utf8-plain-text")) {
                    Some(path.clone().into_super().into_super())
                } else {
                    None
                }
            }
        }
    );

    impl AppPasteboardWriter {
        pub(super) fn new(path: Retained<NSString>) -> Retained<Self> {
            use objc2::MainThreadMarker;
            let main = MainThreadMarker::new().expect("main thread");
            let this = Self::alloc(main).set_ivars(AppPasteboardWriterIvars { path });
            // SAFETY: `NSObject`'s `init` is its designated initializer.
            unsafe { msg_send![super(this), init] }
        }
    }

    pub(super) struct AppPasteboardWriterIvars {
        path: Retained<NSString>,
    }

    define_class!(
        // SAFETY: `NSObject` has no subclassing requirements and the delegate
        // owns only sendable channel handles.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = DragSourceDelegateIvars]
        pub(super) struct DragSourceDelegate;

        unsafe impl NSObjectProtocol for DragSourceDelegate {}

        unsafe impl NSDraggingSource for DragSourceDelegate {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn draggingSession_sourceOperationMaskForDraggingContext(
                &self,
                _session: &NSDraggingSession,
                _context: NSDraggingContext,
            ) -> NSDragOperation {
                NSDragOperation::Copy
            }

            #[unsafe(method(ignoreModifierKeysForDraggingSession:))]
            fn ignoreModifierKeysForDraggingSession(&self, _session: &NSDraggingSession) -> bool {
                true
            }

            #[unsafe(method(draggingSession:willBeginAtPoint:))]
            fn draggingSession_willBeginAtPoint(
                &self,
                _session: &NSDraggingSession,
                _screen_point: NSPoint,
            ) {
                self.ivars().notify(PermissionFlowEvent::DragStarted);
            }

            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn draggingSession_endedAtPoint_operation(
                &self,
                _session: &NSDraggingSession,
                _screen_point: NSPoint,
                _operation: NSDragOperation,
            ) {
                self.ivars().notify(PermissionFlowEvent::DragEnded);
            }
        }
    );

    impl DragSourceDelegate {
        pub(super) fn new(
            events: Sender<PermissionFlowEvent>,
            wake: smol::channel::Sender<()>,
        ) -> Retained<Self> {
            use objc2::MainThreadMarker;
            let main = MainThreadMarker::new().expect("main thread");
            let this = Self::alloc(main).set_ivars(DragSourceDelegateIvars { events, wake });
            // SAFETY: `NSObject`'s `init` is its designated initializer.
            unsafe { msg_send![super(this), init] }
        }
    }

    pub(super) struct DragSourceDelegateIvars {
        events: Sender<PermissionFlowEvent>,
        wake: smol::channel::Sender<()>,
    }

    impl DragSourceDelegateIvars {
        fn notify(&self, event: PermissionFlowEvent) {
            if self.events.send(event).is_ok() {
                signal_event_pump(&self.wake);
            }
        }
    }

    // `beginDraggingSession` does not retain its source; hold the delegate
    // until the drag ends. Main-thread only, like every participant of the
    // drag.
    thread_local! {
        pub(super) static ACTIVE_DRAG_SOURCE: std::cell::RefCell<
            Option<Retained<ProtocolObject<dyn NSDraggingSource>>>,
        > = const { std::cell::RefCell::new(None) };
    }
}

#[cfg(target_os = "macos")]
use drag_classes::{AppPasteboardWriter, DragSourceDelegate};

#[cfg(target_os = "macos")]
fn remember_active_drag_source(
    source: objc2::rc::Retained<
        objc2::runtime::ProtocolObject<dyn objc2_app_kit::NSDraggingSource>,
    >,
) {
    drag_classes::ACTIVE_DRAG_SOURCE.with(|slot| *slot.borrow_mut() = Some(source));
}

#[cfg(target_os = "macos")]
fn clear_active_drag_source() {
    drag_classes::ACTIVE_DRAG_SOURCE.with(|slot| *slot.borrow_mut() = None);
}
