//! Workspace panel geometry: slide animation, resize handles, and the
//! per-frame width publication the pane islands agree with.

use gpui::prelude::*;
use gpui::{Context, Div, MouseButton, Stateful, Window, div, px};

use crate::app::{PanelResizeTarget, Tide};
use crate::theme::Theme;
use crate::ui::motion;

impl Tide {
    pub(in crate::app) fn render_panel_resize_handle(
        &self,
        id: &'static str,
        target: PanelResizeTarget,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let active = self
            .panel_resize_drag
            .is_some_and(|drag| drag.target == target);
        // The right panel's left edge abuts the browser webview, a native view
        // that composites above every base-scene pixel at or beyond the edge.
        // Its bar and hover strip therefore sit entirely left of the edge,
        // where GPUI still owns rendering and input; the other edges keep the
        // conventional straddle.
        let (strip_left, strip_width) = match target {
            PanelResizeTarget::RightPanel => (-7.0, 8.0),
            PanelResizeTarget::Sidebar | PanelResizeTarget::FileTree => (-5.0, 10.0),
        };
        div()
            .id(id)
            .absolute()
            .top_0()
            .left(px(strip_left))
            .w(px(strip_width))
            .h_full()
            .group("panel-resize-handle")
            .cursor_col_resize()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left(px(5.0))
                    .w(px(2.0))
                    .h_full()
                    .bg(if active {
                        theme.resize_handle
                    } else {
                        gpui::transparent_black()
                    })
                    .group_hover("panel-resize-handle", |element| {
                        element.bg(theme.resize_handle)
                    }),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event, window, cx| {
                    this.begin_panel_resize(target, event, window, cx);
                }),
            )
    }
}

/// Panel geometry for the frame being built.
#[derive(Clone, Copy)]
pub(in crate::app) struct PanelFrame {
    /// Width each panel lays its content out at, sliding or not.
    pub(in crate::app) sidebar_content: f32,
    pub(in crate::app) right_panel_content: f32,
    /// Width each panel occupies on screen: the eased slide while one runs.
    pub(in crate::app) sidebar: f32,
    pub(in crate::app) right_panel: f32,
    /// Which edge is mid-slide. The clip that keeps a sliding panel inside its
    /// narrowing container also cuts whatever that panel draws outside its own
    /// bounds — the right panel's resize handle sits entirely left of its edge
    /// — so each clip only goes on while its own panel is actually moving.
    pub(in crate::app) sidebar_sliding: bool,
    pub(in crate::app) right_panel_sliding: bool,
    /// An edge is still moving, so the frame loop has to keep going.
    pub(in crate::app) sliding: bool,
}

/// Advance one panel's slide: the eased width while it runs, the settled
/// target once it is over. Retiring the tween here is what lets a closed
/// panel leave the element tree instead of lingering at zero width, still
/// rebuilding itself on every notify.
fn slide_width(slide: &mut Option<motion::WidthTween>, target: f32) -> f32 {
    match slide.and_then(|slide| slide.width_toward(target)) {
        Some(width) => width,
        None => {
            *slide = None;
            target
        }
    }
}

impl Tide {
    /// An edge is currently animating. While this holds, the pane islands'
    /// root observer stops fanning root notifies out to every island (see
    /// [`TidePane::bind`]) and lets the cached-view geometry checks decide
    /// which islands a slide tick actually rebuilds.
    pub(in crate::app) fn panels_sliding(&self) -> bool {
        self.sidebar_slide.is_some() || self.right_panel_slide.is_some()
    }

    /// Settle both panel slides for this frame and publish the widths the
    /// pane islands — which render later, during layout — have to agree with.
    pub(in crate::app) fn settle_panel_slides(&mut self, window: &Window) -> PanelFrame {
        let was_sliding = self.panels_sliding();
        if self.settings_page.is_some() {
            // Settings covers the workspace, so there is no edge on screen to
            // move. Retire the slide rather than animate a layout nobody can
            // see; reopening the workspace finds the panels where they belong.
            self.sidebar_slide = None;
            self.right_panel_slide = None;
        }
        let (sidebar_content, right_panel_content) = self.effective_panel_widths(window);
        let sidebar = slide_width(
            &mut self.sidebar_slide,
            if self.sidebar_visible {
                sidebar_content
            } else {
                0.0
            },
        );
        let right_panel = slide_width(
            &mut self.right_panel_slide,
            if self.right_panel_visible {
                right_panel_content
            } else {
                0.0
            },
        );
        self.sidebar_rendered_width = sidebar;
        self.right_panel_rendered_width = right_panel;
        let sliding = self.panels_sliding();
        if was_sliding && !sliding {
            // The observer gate held root-state fan-out away from any island
            // the slide left geometry-stable. One ungated notify now that
            // the slide is over rebuilds every island once, so whatever
            // root state changed during those 200ms lands the next frame.
            let root = window.current_view();
            window.on_next_frame(move |_, cx| cx.notify(root));
        }
        PanelFrame {
            sidebar_content,
            right_panel_content,
            sidebar,
            right_panel,
            sidebar_sliding: self.sidebar_slide.is_some(),
            right_panel_sliding: self.right_panel_slide.is_some(),
            sliding,
        }
    }

    /// Width left for the chat column's transcript once the panels and the
    /// inspector column take theirs — the widths they are painted at this
    /// frame, so a transcript measured mid-slide matches the column it is
    /// laid out in.
    pub(in crate::app) fn chat_viewport_width(&self, window: &Window) -> f32 {
        f32::from(window.viewport_size().width)
            - self.sidebar_rendered_width
            - self.right_panel_rendered_width
            - self.inspector_rendered_width
    }
}
