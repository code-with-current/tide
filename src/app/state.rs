//! Root-owned state groups (design 8): plain structs held by the `Tide`
//! entity, one per shell concern, moved one group at a time.

use std::collections::{HashMap, HashSet};
use std::time::Instant;
use uuid::Uuid;

use crate::computer_use::ComputerPermissions;

/// Transient shell feedback and instrumentation: copy-button acknowledgement
/// generations and the FPS counter.
pub(in crate::app) struct ShellState {
    pub(in crate::app) copied_control_feedback: HashMap<String, u64>,
    pub(in crate::app) copied_control_generation: u64,
    pub(in crate::app) copied_message_feedback: HashMap<Uuid, u64>,
    pub(in crate::app) copied_message_generation: u64,
    pub(in crate::app) fps_counter_visible: bool,
    pub(in crate::app) fps_last_frame: Instant,
    pub(in crate::app) fps_frame_count: u64,
    pub(in crate::app) fps_value: u32,
}

impl ShellState {
    pub(in crate::app) fn new() -> Self {
        Self {
            copied_control_feedback: HashMap::new(),
            copied_control_generation: 0,
            copied_message_feedback: HashMap::new(),
            copied_message_generation: 0,
            fps_counter_visible: false,
            fps_last_frame: Instant::now(),
            fps_frame_count: 0,
            fps_value: 0,
        }
    }
}

/// The settings Usage page: folded snapshots, view/metric selection, and the
/// virtualized project list's caches. Built with the two `cx`-allocated
/// pieces (`Entity<TextInput>` filter, `ListState` rows).
pub(in crate::app) struct UsageState {
    pub(in crate::app) report: Option<crate::usage_report::UsageReport>,
    pub(in crate::app) report_pending_for: Option<crate::usage_report::UsageWindow>,
    pub(in crate::app) report_generation: u64,
    pub(in crate::app) report_scanned_at: Option<Instant>,
    pub(in crate::app) view: super::UsageViewMode,
    pub(in crate::app) window: crate::usage_report::UsageWindow,
    pub(in crate::app) metric: super::UsageMetric,
    pub(in crate::app) breakdown: super::UsageBreakdown,
    pub(in crate::app) months_scroll: gpui::ScrollHandle,
    pub(in crate::app) months_scrollbar: std::rc::Rc<crate::ui::scrollbar::ScrollbarState>,
    pub(in crate::app) project_filter: gpui::Entity<crate::input::TextInput>,
    pub(in crate::app) projects_list: gpui::ListState,
    pub(in crate::app) projects_scrollbar: std::rc::Rc<crate::ui::scrollbar::ScrollbarState>,
    pub(in crate::app) projects_rows: std::cell::RefCell<Vec<usize>>,
    pub(in crate::app) projects_scale: std::cell::Cell<(f64, bool)>,
    pub(in crate::app) chart_hover: Option<usize>,
    pub(in crate::app) chart_bounds:
        std::rc::Rc<std::cell::Cell<Option<gpui::Bounds<gpui::Pixels>>>>,
}

impl UsageState {
    pub(in crate::app) fn new(
        project_filter: gpui::Entity<crate::input::TextInput>,
        projects_list: gpui::ListState,
    ) -> Self {
        Self {
            report: None,
            report_pending_for: None,
            report_generation: 0,
            report_scanned_at: None,
            view: super::UsageViewMode::Daily,
            window: crate::usage_report::UsageWindow::TrailingDays(30),
            metric: super::UsageMetric::Cost,
            breakdown: super::UsageBreakdown::Model,
            months_scroll: gpui::ScrollHandle::new(),
            months_scrollbar: crate::ui::scrollbar::ScrollbarState::new(),
            project_filter,
            projects_list,
            projects_scrollbar: crate::ui::scrollbar::ScrollbarState::new(),
            projects_rows: std::cell::RefCell::new(Vec::new()),
            projects_scale: std::cell::Cell::new((0.0, true)),
            chart_hover: None,
            chart_bounds: std::rc::Rc::default(),
        }
    }
}

/// Update-check status plus the header updater button's hover/focus/animation
/// chrome. `status` mirrors the updater's last known state; the animation
/// fields drive the collapsed→expanded label reveal.
pub(in crate::app) struct UpdaterButtonState {
    pub(in crate::app) automatic_updates_enabled: bool,
    pub(in crate::app) status: crate::updater::UpdateStatus,
    pub(in crate::app) button_focus: gpui::FocusHandle,
    pub(in crate::app) button_hovered: bool,
    pub(in crate::app) button_focused: bool,
    pub(in crate::app) button_width: std::rc::Rc<std::cell::Cell<f32>>,
    pub(in crate::app) button_label_reveal: std::rc::Rc<std::cell::Cell<f32>>,
    pub(in crate::app) button_animation_from_width: f32,
    pub(in crate::app) button_animation_from_reveal: f32,
    pub(in crate::app) button_animation_generation: u64,
}

impl UpdaterButtonState {
    pub(in crate::app) fn new(
        cx: &gpui::App,
        status: crate::updater::UpdateStatus,
        button_focus: gpui::FocusHandle,
    ) -> Self {
        Self {
            automatic_updates_enabled: cx
                .try_global::<crate::updater::UpdaterState>()
                .and_then(|updater| updater.0.as_ref())
                .is_some_and(|updater| updater.automatically_checks_for_updates()),
            status,
            button_focus,
            button_hovered: false,
            button_focused: false,
            button_width: std::rc::Rc::new(std::cell::Cell::new(
                crate::app::UPDATER_BUTTON_COLLAPSED_WIDTH,
            )),
            button_label_reveal: std::rc::Rc::new(std::cell::Cell::new(0.0)),
            button_animation_from_width: crate::app::UPDATER_BUTTON_COLLAPSED_WIDTH,
            button_animation_from_reveal: 0.0,
            button_animation_generation: 0,
        }
    }
}

/// Computer Use permissions and caches: the grant-status channel, the
/// app-icon load dedup set, and the installed "open project in" apps.
pub(in crate::app) struct ComputerUseState {
    pub(in crate::app) permissions: ComputerPermissions,
    pub(in crate::app) permission_tx:
        crossbeam_channel::Sender<Result<ComputerPermissions, String>>,
    pub(in crate::app) permission_events:
        crossbeam_channel::Receiver<Result<ComputerPermissions, String>>,
    pub(in crate::app) permission_request_pending: bool,
    pub(in crate::app) last_permission_probe: Option<Instant>,
    pub(in crate::app) use_app_icons:
        std::cell::RefCell<HashMap<String, Option<std::sync::Arc<gpui::Image>>>>,
    pub(in crate::app) use_app_icon_loads: std::cell::RefCell<HashSet<String>>,
    pub(in crate::app) open_in_apps: std::rc::Rc<Vec<crate::platform::ExternalApp>>,
}

impl ComputerUseState {
    pub(in crate::app) fn new(
        permission_tx: crossbeam_channel::Sender<Result<ComputerPermissions, String>>,
        permission_events: crossbeam_channel::Receiver<Result<ComputerPermissions, String>>,
    ) -> Self {
        Self {
            permissions: ComputerPermissions::default(),
            permission_tx,
            permission_events,
            permission_request_pending: false,
            last_permission_probe: None,
            use_app_icons: std::cell::RefCell::new(HashMap::new()),
            use_app_icon_loads: std::cell::RefCell::new(HashSet::new()),
            open_in_apps: std::rc::Rc::new(Vec::new()),
        }
    }
}

/// The shared model picker: the filter input, open tab, per-site picker
/// inputs, the active surface's selection, and the row list's scroll state.
pub(in crate::app) struct ModelPickerState {
    pub(in crate::app) search: gpui::Entity<crate::input::TextInput>,
    pub(in crate::app) tab: super::ModelPickerTab,
    pub(in crate::app) configs: std::cell::RefCell<
        HashMap<
            gpui::SharedString,
            crate::app::features::composer::model_picker::ModelPickerConfig,
        >,
    >,
    pub(in crate::app) active: Option<(crate::model::ProviderKind, String)>,
    pub(in crate::app) highlight: Option<usize>,
    pub(in crate::app) scroll: gpui::ScrollHandle,
    pub(in crate::app) scrollbar: std::rc::Rc<crate::ui::scrollbar::ScrollbarState>,
    pub(in crate::app) empty_focus: gpui::FocusHandle,
}

impl ModelPickerState {
    pub(in crate::app) fn new(
        search: gpui::Entity<crate::input::TextInput>,
        tab: super::ModelPickerTab,
        empty_focus: gpui::FocusHandle,
    ) -> Self {
        Self {
            search,
            tab,
            configs: std::cell::RefCell::new(HashMap::new()),
            active: None,
            highlight: None,
            scroll: gpui::ScrollHandle::new(),
            scrollbar: crate::ui::scrollbar::ScrollbarState::new(),
            empty_focus,
        }
    }
}
