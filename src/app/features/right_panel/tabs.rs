//! Right-panel tabs: the surface enum, labels and icons, and the reuse and
//! reveal guards behind the tab bar.

use crate::app::CloseWindow;
use crate::app::RightPanelSurface;
use crate::app::Tide;
use crate::app::features::right_panel::files::file_icon_for_path;
use crate::app::features::sessions::background_work::work_kind_icon;
use crate::app::single_line_label;
use crate::app::widened_panel_width_for_review;
use crate::model::BackgroundWorkKind;
use crate::theme::Theme;
use crate::ui::icon;
use crate::ui::tooltip::Tooltip;
use gpui::Context;
use gpui::Div;
use gpui::IntoElement;
use gpui::MouseButton;
use gpui::ScrollHandle;
use gpui::Stateful;
use gpui::WeakEntity;
use gpui::Window;
use gpui::canvas;
use gpui::div;
use gpui::point;
use gpui::prelude::*;
use gpui::px;
use std::path::Path;
use std::path::PathBuf;
use uuid::Uuid;
pub(in crate::app) const TAB_SCROLL_FADE_WIDTH: f32 = 24.0;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::app) struct WorkingTreeEntry {
    pub(in crate::app) relative_path: String,
    pub(in crate::app) absolute_path: PathBuf,
    pub(in crate::app) name: String,
    pub(in crate::app) is_dir: bool,
    pub(in crate::app) file_icon: Option<&'static str>,
    pub(in crate::app) expanded: bool,
    pub(in crate::app) depth: usize,
}

impl RightPanelSurface {
    pub(in crate::app) fn new_browser() -> Self {
        Self::Browser(Uuid::new_v4())
    }

    pub(in crate::app) fn new_terminal() -> Self {
        Self::Terminal(Uuid::new_v4())
    }

    pub(in crate::app) fn terminal_id(&self) -> Option<Uuid> {
        match self {
            Self::Terminal(id) => Some(*id),
            _ => None,
        }
    }

    pub(in crate::app) fn browser_id(&self) -> Option<Uuid> {
        match self {
            Self::Browser(id) => Some(*id),
            _ => None,
        }
    }

    pub(in crate::app) fn label(&self) -> String {
        match self {
            Self::Browser(_) => tr!("right_panel.browser"),
            Self::Terminal(_) => tr!("right_panel.terminal"),
            Self::BackgroundWork { key, title } => {
                if title.is_empty() {
                    match key.kind {
                        BackgroundWorkKind::Process => tr!("background.process"),
                        BackgroundWorkKind::Subagent => tr!("background.subagent"),
                    }
                } else {
                    title.clone()
                }
            }
            Self::Files => tr!("right_panel.files"),
            Self::Agents => tr!("right_panel.agents"),
            Self::Git => tr!("right_panel.git"),
            Self::File(path) => path.rsplit('/').next().unwrap_or(path).to_owned(),
        }
    }

    pub(in crate::app) fn icon_path(&self) -> &'static str {
        match self {
            Self::Browser(_) => "icons/globe.svg",
            Self::Terminal(_) => "icons/terminal.svg",
            Self::BackgroundWork { key, .. } => work_kind_icon(key.kind),
            Self::Files => "icons/folder.svg",
            Self::Agents => "icons/bot.svg",
            Self::Git => "icons/git-branch.svg",
            Self::File(path) => file_icon_for_path(path),
        }
    }
}

pub(in crate::app) fn right_panel_tab_label(
    surface: &RightPanelSurface,
    files_selected_path: Option<&str>,
) -> String {
    let label = match surface {
        RightPanelSurface::Files => files_selected_path
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| tr!("right_panel.files")),
        _ => surface.label(),
    };
    single_line_label(&label)
}

pub(in crate::app) fn right_panel_tab_icon(
    surface: &RightPanelSurface,
    files_selected_path: Option<&str>,
) -> &'static str {
    match surface {
        RightPanelSurface::Files => files_selected_path
            .map(file_icon_for_path)
            .unwrap_or_else(|| surface.icon_path()),
        _ => surface.icon_path(),
    }
}

pub(in crate::app) fn reusable_surface_index(
    surfaces: &[RightPanelSurface],
    requested: &RightPanelSurface,
) -> Option<usize> {
    match requested {
        RightPanelSurface::Browser(_) | RightPanelSurface::Terminal(_) => None,
        RightPanelSurface::BackgroundWork { key, .. } => surfaces.iter().position(|surface| {
            matches!(surface, RightPanelSurface::BackgroundWork { key: candidate, .. } if candidate == key)
        }),
        RightPanelSurface::Agents
        | RightPanelSurface::Files
        | RightPanelSurface::Git
        | RightPanelSurface::File(_) => surfaces.iter().position(|surface| surface == requested),
    }
}

pub(in crate::app) fn tab_scroll_reveal_guard(
    scroll_handle: ScrollHandle,
    tab_index: usize,
    tide: WeakEntity<Tide>,
) -> impl IntoElement {
    canvas(
        move |_, window, _| {
            if let Some(item) = scroll_handle.bounds_for_item(tab_index) {
                let viewport = scroll_handle.bounds();
                let offset = scroll_handle.offset();
                let safe_offset = crate::ui::scroll_fade::fade_safe_offset(
                    offset.x,
                    scroll_handle.max_offset().x,
                    item.left(),
                    item.right(),
                    viewport.left(),
                    viewport.right(),
                    TAB_SCROLL_FADE_WIDTH,
                );
                if safe_offset != offset.x {
                    scroll_handle.set_offset(point(safe_offset, offset.y));
                }
            }

            window.on_next_frame(move |_, cx| {
                let _ = tide.update(cx, |this, cx| {
                    if this.right_panel_pending_tab_reveal == Some(tab_index) {
                        this.right_panel_pending_tab_reveal = None;
                        cx.notify();
                    }
                });
            });
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_full()
}

#[allow(clippy::items_after_test_module)]

impl Tide {
    pub(in crate::app) fn open_right_panel_surface(
        &mut self,
        surface: RightPanelSurface,
        cx: &mut Context<Self>,
    ) {
        let reusable_index = reusable_surface_index(&self.right_panel_surfaces, &surface);
        if matches!(&surface, RightPanelSurface::File(_)) {
            self.ensure_initial_right_panel_file_editor_width();
        }
        if surface == RightPanelSurface::Git {
            if reusable_index.is_none() {
                self.right_panel_width = widened_panel_width_for_review(self.right_panel_width);
            }
            // The identity bar's picker reads profiles from the settings
            // snapshot; fetch it once when the surface first opens.
            if self.git_settings.snapshot.is_none() {
                self.git_load_snapshot();
            }
            self.refresh_git_panel(cx);
            self.start_git_panel_timer(cx);
        }
        if matches!(
            surface,
            RightPanelSurface::Files | RightPanelSurface::File(_)
        ) {
            self.refresh_right_panel_working_tree(cx);
        }
        if let Some(terminal_id) = surface.terminal_id() {
            self.ensure_right_panel_terminal(terminal_id, cx);
        }
        // Browser views are created on the surface's first render, which has
        // the `Window` their webview must attach to.
        let index = match reusable_index {
            Some(index) => index,
            None => {
                self.right_panel_surfaces.push(surface);
                self.right_panel_surfaces.len() - 1
            }
        };
        self.right_panel_active_surface = Some(index);
        self.reveal_right_panel_tab(index);
        self.request_active_terminal_focus();
        self.request_active_browser_focus();
        self.set_right_panel_visible(true, cx);
        cx.notify();
    }

    /// Render a mermaid diagram in a fresh Browser tab. The source is
    /// embedded — escaped — into a dark-mode page that loads mermaid.js and
    /// renders on load; the whole document travels as a `data:` URL, so
    /// nothing but the CDN script ever touches the network. The browser view
    /// itself only exists once the tab renders, so the URL waits in
    /// [`Self::right_panel_pending_browser_urls`] until then.
    /// workspace path and type the command in. The run is registered so its
    /// row can flip Play/Stop and scan for an advertised port; the shared
    /// session terminal is never involved and output never reaches the
    /// transcript.
    /// Run a project action as a daemon-side background job (kind
    /// `process`): it shows in the jobs pill, the jobs popup, and the
    /// background-work surface. No terminal is involved; output streams
    /// into the background job's log.

    /// Run a project action: dispatch to the daemon, which starts it in
    /// the session's job registry (kind `process`). The row flips to Stop
    /// optimistically; the poller reconciles state from the registry.
    pub(in crate::app) fn close_right_panel_surface(
        &mut self,
        index: usize,
        cx: &mut Context<Self>,
    ) {
        if index >= self.right_panel_surfaces.len() {
            return;
        }
        if let Some(terminal_id) = self.right_panel_surfaces[index].terminal_id() {
            self.right_panel_terminals.remove(&terminal_id);
        }
        if let Some(browser_id) = self.right_panel_surfaces[index].browser_id() {
            self.right_panel_browsers.remove(&browser_id);
        }
        self.right_panel_surfaces.remove(index);
        self.right_panel_active_surface = if self.right_panel_surfaces.is_empty() {
            None
        } else {
            Some(match self.right_panel_active_surface {
                Some(active) if active > index => active - 1,
                Some(active) if active == index => index.saturating_sub(1),
                Some(active) => active.min(self.right_panel_surfaces.len() - 1),
                None => 0,
            })
        };
        if let Some(active) = self.right_panel_active_surface {
            self.reveal_right_panel_tab(active);
            self.request_active_terminal_focus();
            self.request_active_browser_focus();
        } else {
            self.right_panel_pending_tab_reveal = None;
            self.right_panel_pending_terminal_focus = None;
            self.right_panel_pending_browser_focus = None;
            self.set_right_panel_visible(false, cx);
        }
        cx.notify();
    }

    pub(in crate::app) fn close_window_or_right_panel_tab_action(
        &mut self,
        _: &CloseWindow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(active) = self.right_panel_active_surface {
            self.close_right_panel_surface(active, cx);
            if self.right_panel_surfaces.is_empty() {
                let focus_handle = self.composer_focus(cx);
                window.focus(&focus_handle, cx);
            }
        } else {
            crate::platform::hide_window(window);
        }
    }

    pub(in crate::app) fn render_right_panel_toggle(
        &self,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        div()
            .id("toggle-right-panel")
            .w(px(26.0))
            .h(px(26.0))
            .flex_none()
            .rounded(px(6.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .hover(|element| element.bg(theme.overlay))
            .active(|element| element.bg(theme.overlay_strong))
            .child(icon("icons/panel-right.svg", 14.0, theme.text_tertiary))
            .tooltip(|window, cx| Tooltip::new(tr!("right_panel.toggle")).build(window, cx))
            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                cx.stop_propagation();
            })
            .on_click(cx.listener(|this, _, _, cx| {
                cx.stop_propagation();
                this.set_right_panel_visible(!this.right_panel_visible, cx);
            }))
    }
}
