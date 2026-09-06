use super::git_panel::GitPanelTab;
use super::*;
use gpui::{Anchor, anchored, deferred};

/// Width of the background-jobs popup card.
const COMPOSER_JOBS_POPUP_WIDTH: f32 = 344.0;

const MAX_BACKGROUND_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_SETTLED_BACKGROUND_ITEMS: usize = 24;
const OUTPUT_CACHE_REFRESH_INTERVAL: Duration = Duration::from_millis(100);
const BACKGROUND_SUMMARY_MENU_ID: &str = "background-work-summary";
const HEADER_JOBS_MENU_ID: &str = "header-jobs-menu";
const OPEN_IN_MENU_ID: &str = "open-in-app";
const TASK_ID_COPY_CONTROL_ID: &str = "background-summary-copy-task-id";
const AGENT_THREAD_ID_COPY_CONTROL_ID: &str = "background-summary-copy-agent-thread-id";
/// Width of the composer jobs popup, per the mockup.

#[derive(Default)]
pub(super) struct BackgroundWorkRegistry {
    items: HashMap<BackgroundWorkKey, BackgroundWorkItem>,
    order: Vec<BackgroundWorkKey>,
    /// GPUI's shared text makes repainting a long log O(1). It is rebuilt only
    /// when provider output changes, never from the panel's render path.
    rendered_output: HashMap<BackgroundWorkKey, SharedString>,
    dirty_output: HashSet<BackgroundWorkKey>,
    last_output_cache_refresh: Option<Instant>,
    output_viewports: HashMap<BackgroundWorkKey, BackgroundOutputViewport>,
    selection: TranscriptSelection,
}

#[derive(Clone)]
struct BackgroundOutputViewport {
    scroll_handle: ScrollHandle,
    scrollbar: Rc<ScrollbarState>,
}

impl Default for BackgroundOutputViewport {
    fn default() -> Self {
        Self {
            scroll_handle: ScrollHandle::new(),
            scrollbar: ScrollbarState::new(),
        }
    }
}

#[derive(Clone)]
struct BackgroundSummaryEntry {
    item: BackgroundWorkItem,
    row_focus: FocusHandle,
    stop_focus: FocusHandle,
}

#[derive(Clone)]
struct EnvironmentSummary {
    commit_status: Option<String>,
    commit_focus: FocusHandle,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TaskIdentifiers {
    task_id: Uuid,
    agent_cli_thread_id: Option<String>,
}

#[derive(Clone)]
struct TaskIdentifierSection {
    values: TaskIdentifiers,
    task_id_copy_focus: FocusHandle,
    agent_cli_thread_id_copy_focus: FocusHandle,
    task_id_copied: bool,
    agent_cli_thread_id_copied: bool,
}

impl From<&AgentSession> for TaskIdentifiers {
    fn from(session: &AgentSession) -> Self {
        Self {
            task_id: session.id,
            agent_cli_thread_id: session.provider_native_id().map(str::to_owned),
        }
    }
}

/// Whether one event carries sub-agent state the session should persist
/// (the durability write-through's filter).
fn event_touches_subagent(event: &BackgroundWorkEvent) -> bool {
    match event {
        BackgroundWorkEvent::Upsert(item) => item.key.kind == BackgroundWorkKind::Subagent,
        BackgroundWorkEvent::SubagentBlocks { key, .. } => key.kind == BackgroundWorkKind::Subagent,
        _ => false,
    }
}

/// Project one background-work event onto the persisted run shape. Upserts
/// carry identity/status/report; block snapshots carry the timeline.
fn subagent_run_from_event(event: &BackgroundWorkEvent) -> SubagentRun {
    match event {
        BackgroundWorkEvent::Upsert(item) => SubagentRun {
            child_id: item.key.provider_id.clone(),
            agent_name: item.detail.clone().unwrap_or_default(),
            title: item.title.clone(),
            task: item.task.clone(),
            blocks: item.subagent_blocks.clone(),
            report: item.output.clone(),
            status: item.status,
            duration_ms: item.duration_ms,
            origin_activity_id: item.origin_activity_id.clone(),
        },
        BackgroundWorkEvent::SubagentBlocks { key, blocks } => SubagentRun {
            child_id: key.provider_id.clone(),
            agent_name: String::new(),
            title: String::new(),
            task: None,
            blocks: blocks.clone(),
            report: None,
            status: BackgroundWorkStatus::Running,
            duration_ms: None,
            origin_activity_id: None,
        },
        _ => SubagentRun {
            child_id: String::new(),
            agent_name: String::new(),
            title: String::new(),
            task: None,
            blocks: Vec::new(),
            report: None,
            status: BackgroundWorkStatus::Completed,
            duration_ms: None,
            origin_activity_id: None,
        },
    }
}

/// Merge one projected run into the session's persisted list by child id:
/// present fields overwrite, absent ones keep the stored value, and an
/// unknown id appends. Block snapshots arrive without identity fields, so
/// they only refresh a run the upserts already created — an upsert carries
/// the authoritative status.
fn upsert_subagent_run(runs: &mut Vec<SubagentRun>, run: SubagentRun) {
    if run.child_id.is_empty() {
        return;
    }
    let authoritative = !run.title.is_empty() || !run.agent_name.is_empty();
    if let Some(existing) = runs.iter_mut().find(|r| r.child_id == run.child_id) {
        if !run.agent_name.is_empty() {
            existing.agent_name = run.agent_name;
        }
        if !run.title.is_empty() {
            existing.title = run.title;
        }
        if run.task.is_some() {
            existing.task = run.task;
        }
        if !run.blocks.is_empty() {
            existing.blocks = run.blocks;
        }
        if run.report.is_some() {
            existing.report = run.report;
        }
        if run.duration_ms.is_some() {
            existing.duration_ms = run.duration_ms;
        }
        if run.origin_activity_id.is_some() {
            existing.origin_activity_id = run.origin_activity_id;
        }
        if authoritative {
            existing.status = run.status;
        }
    } else if authoritative {
        runs.push(run);
    }
}

impl BackgroundWorkRegistry {
    fn apply(&mut self, event: BackgroundWorkEvent) {
        match event {
            BackgroundWorkEvent::Upsert(item) => self.upsert(item),
            BackgroundWorkEvent::OutputDelta { key, delta } => self.append_output(&key, &delta),
            BackgroundWorkEvent::SubagentBlocks { key, blocks } => {
                self.update_subagent_blocks(&key, blocks)
            }
            BackgroundWorkEvent::ReconcileLive { items } => self.reconcile_live(items),
            BackgroundWorkEvent::StopRequested(key) => {
                if let Some(item) = self.items.get_mut(&key) {
                    item.status = BackgroundWorkStatus::Stopping;
                    item.updated_at_ms = unix_time_millis();
                }
            }
            BackgroundWorkEvent::StopFailed { key, message } => {
                if let Some(item) = self
                    .items
                    .get_mut(&key)
                    .filter(|item| item.status.is_live())
                {
                    item.status = BackgroundWorkStatus::Running;
                    item.detail = Some(message);
                    item.updated_at_ms = unix_time_millis();
                }
            }
        }
        self.trim_settled();
    }

    fn upsert(&mut self, mut incoming: BackgroundWorkItem) {
        let key = incoming.key.clone();
        // Short foreground commands belong in the transcript. Show them while
        // running, then remove them instead of turning this surface into a
        // duplicate command history.
        let already_background = self
            .items
            .get(&incoming.key)
            .is_some_and(|item| item.background);
        if !incoming.background
            && !already_background
            && !incoming.status.is_live()
            && matches!(incoming.key.kind, BackgroundWorkKind::Process)
        {
            self.remove(&incoming.key);
            return;
        }

        bound_output(&mut incoming);
        self.output_viewports.entry(key.clone()).or_default();
        let output_changed;
        let blocks_changed;
        if let Some(current) = self.items.get_mut(&incoming.key) {
            let preserve_stopping =
                current.status == BackgroundWorkStatus::Stopping && incoming.status.is_stoppable();
            if incoming.title.is_empty() {
                incoming.title.clone_from(&current.title);
            }
            current.title = incoming.title;
            merge_option(&mut current.detail, incoming.detail);
            merge_option(&mut current.command, incoming.command);
            merge_option(&mut current.cwd, incoming.cwd);
            merge_option(&mut current.task, incoming.task);
            if let Some(output) = incoming.output {
                output_changed = current.output.as_ref() != Some(&output)
                    || current.output_truncated != incoming.output_truncated;
                current.output = Some(output);
                current.output_truncated = incoming.output_truncated;
            } else {
                output_changed = false;
            }
            blocks_changed = !incoming.subagent_blocks.is_empty()
                && current.subagent_blocks != incoming.subagent_blocks;
            if blocks_changed {
                current.subagent_blocks = incoming.subagent_blocks;
            }
            merge_option(&mut current.duration_ms, incoming.duration_ms);
            merge_option(&mut current.exit_code, incoming.exit_code);
            merge_option(&mut current.control_id, incoming.control_id);
            merge_option(&mut current.origin_activity_id, incoming.origin_activity_id);
            merge_option(&mut current.role, incoming.role);
            merge_option(&mut current.model, incoming.model);
            merge_option(&mut current.parent_id, incoming.parent_id);
            current.started_at_ms = current.started_at_ms.min(incoming.started_at_ms);
            current.updated_at_ms = current.updated_at_ms.max(incoming.updated_at_ms);
            current.background |= incoming.background;
            current.can_stop = if incoming.status.is_live() {
                current.can_stop || incoming.can_stop
            } else {
                false
            };
            if !preserve_stopping {
                current.status = incoming.status;
            }
        } else {
            output_changed = incoming.output.is_some();
            blocks_changed = !incoming.subagent_blocks.is_empty();
            self.order.push(incoming.key.clone());
            self.items.insert(incoming.key.clone(), incoming);
        }
        if output_changed || blocks_changed {
            self.dirty_output.insert(key);
        }
    }

    /// Replace a sub-agent item's block timeline wholesale. A duplicate
    /// snapshot (the driver re-emitting the final state) leaves the item
    /// untouched so an unchanged timeline never wakes the output cache.
    fn update_subagent_blocks(&mut self, key: &BackgroundWorkKey, blocks: Vec<SubagentBlock>) {
        let Some(item) = self.items.get_mut(key) else {
            return;
        };
        if item.subagent_blocks == blocks {
            return;
        }
        item.subagent_blocks = blocks;
        item.updated_at_ms = unix_time_millis();
        // The timeline renders from the item itself, but its repaint rides
        // the same coalesced output-cache wake the log text uses (10Hz), so
        // a chatty child costs the UI thread one refresh cadence, not one
        // per event.
        self.dirty_output.insert(key.clone());
    }

    fn append_output(&mut self, key: &BackgroundWorkKey, delta: &str) {
        if delta.is_empty() {
            return;
        }
        let Some(item) = self.items.get_mut(key) else {
            return;
        };
        self.output_viewports.entry(key.clone()).or_default();
        item.output.get_or_insert_with(String::new).push_str(delta);
        item.updated_at_ms = unix_time_millis();
        bound_output(item);
        self.dirty_output.insert(key.clone());
    }


    fn reconcile_live(&mut self, items: Vec<BackgroundWorkItem>) {
        let present = items
            .iter()
            .map(|item| item.key.clone())
            .collect::<HashSet<_>>();
        let now = unix_time_millis();
        for item in self.items.values_mut() {
            if item.background && item.status.is_live() && !present.contains(&item.key) {
                item.status = BackgroundWorkStatus::Lost;
                item.can_stop = false;
                item.updated_at_ms = now;
            }
        }
        for item in items {
            self.upsert(item);
        }
    }

    fn remove(&mut self, key: &BackgroundWorkKey) {
        self.items.remove(key);
        self.rendered_output.remove(key);
        self.dirty_output.remove(key);
        self.output_viewports.remove(key);
        self.order.retain(|entry| entry != key);
    }

    fn trim_settled(&mut self) {
        let mut settled = self
            .order
            .iter()
            .filter_map(|key| self.items.get(key).map(|item| (key, item)))
            .filter(|(_, item)| !item.status.is_live())
            .count();
        if settled <= MAX_SETTLED_BACKGROUND_ITEMS {
            return;
        }
        let stale = self.order.clone();
        for key in stale {
            if settled <= MAX_SETTLED_BACKGROUND_ITEMS {
                break;
            }
            if self
                .items
                .get(&key)
                .is_some_and(|item| !item.status.is_live())
            {
                self.remove(&key);
                settled -= 1;
            }
        }
    }

    fn mark_live_lost(&mut self) {
        let now = unix_time_millis();
        for item in self.items.values_mut().filter(|item| item.status.is_live()) {
            item.status = BackgroundWorkStatus::Lost;
            item.can_stop = false;
            item.updated_at_ms = now;
        }
    }

    /// Rebuild settled sub-agent items from a session's persisted runs, so
    /// the agents panel works after a restart. Live events re-upsert over
    /// these when a runtime reattaches; until then the stored timeline and
    /// report are what the panel shows.
    pub(super) fn rehydrate_subagent_runs(&mut self, runs: &[SubagentRun]) {
        for run in runs {
            let mut item = BackgroundWorkItem::new(
                BackgroundWorkKind::Subagent,
                run.child_id.clone(),
                run.title.clone(),
                run.status,
            );
            if !run.agent_name.is_empty() {
                item.detail = Some(run.agent_name.clone());
            }
            item.task = run.task.clone();
            item.output = run.report.clone();
            item.duration_ms = run.duration_ms;
            item.origin_activity_id = run.origin_activity_id.clone();
            item.subagent_blocks = run.blocks.clone();
            item.background = false;
            item.updated_at_ms = unix_time_millis();
            self.upsert(item);
        }
    }

    fn settle_foreground(&mut self, status: BackgroundWorkStatus) {
        let keys = self
            .items
            .values()
            .filter(|item| !item.background && item.status.is_live())
            .map(|item| item.key.clone())
            .collect::<Vec<_>>();
        let now = unix_time_millis();
        for key in keys {
            if key.kind == BackgroundWorkKind::Subagent {
                if let Some(item) = self.items.get_mut(&key) {
                    item.status = status;
                    item.can_stop = false;
                    item.updated_at_ms = now;
                }
            } else {
                self.remove(&key);
            }
        }
    }

    fn has_live(&self) -> bool {
        self.items.values().any(|item| item.status.is_live())
    }

    fn has_live_detached(&self) -> bool {
        self.items
            .values()
            .any(|item| item.background && item.status.is_live())
    }

    fn counts(&self) -> (usize, usize) {
        self.items
            .values()
            .filter(|item| item.status.is_live())
            .fold((0, 0), |(processes, agents), item| match item.key.kind {
                BackgroundWorkKind::Subagent => (processes, agents + 1),
                BackgroundWorkKind::Process => (processes + 1, agents),
            })
    }

    /// The composer popup's rows: live jobs first in the registry's display
    /// order (newest first, like the Agents tab), then the settled tail
    /// that dims under a separator. Empty tails collapse the separator.
    fn jobs_popup_rows(&self) -> (Vec<BackgroundWorkItem>, Vec<BackgroundWorkItem>) {
        let mut live = Vec::new();
        let mut settled = Vec::new();
        for item in self.ordered_items() {
            if item.status.is_live() {
                live.push(item.clone());
            } else {
                settled.push(item.clone());
            }
        }
        (live, settled)
    }

    fn ordered_items(&self) -> Vec<&BackgroundWorkItem> {
        self.order
            .iter()
            .rev()
            .filter_map(|key| self.items.get(key))
            .collect()
    }

    /// The registry's sub-agent items, newest first — the Agents tab's rows.
    /// Settled runs stay until the registry's trim window ages them out, so
    /// the tab reads as a history, not just a live meter.
    fn subagent_items(&self) -> Vec<&BackgroundWorkItem> {
        self.ordered_items()
            .into_iter()
            .filter(|item| item.key.kind == BackgroundWorkKind::Subagent)
            .collect()
    }

    /// [`BackgroundWorkRegistry::subagent_items`] as a count, for the
    /// chooser card's badge.
    fn subagent_count(&self) -> usize {
        self.items
            .values()
            .filter(|item| item.key.kind == BackgroundWorkKind::Subagent)
            .count()
    }

    pub(super) fn selected_text(&self) -> Option<String> {
        self.selection.selection.borrow().selected_text()
    }

    fn refresh_output_cache(&mut self) -> bool {
        if self.dirty_output.is_empty()
            || self
                .last_output_cache_refresh
                .is_some_and(|last| last.elapsed() < OUTPUT_CACHE_REFRESH_INTERVAL)
        {
            return false;
        }
        let dirty = std::mem::take(&mut self.dirty_output);
        for key in dirty {
            if let Some(output) = self.items.get(&key).and_then(|item| item.output.as_deref()) {
                self.rendered_output
                    .insert(key.clone(), SharedString::from(strip_ansi(output)));
                if let Some(viewport) = self.output_viewports.get(&key) {
                    viewport.scroll_handle.scroll_to_bottom();
                }
            }
        }
        self.last_output_cache_refresh = Some(Instant::now());
        true
    }

    fn output_refresh_delay(&self) -> Option<Duration> {
        (!self.dirty_output.is_empty()).then(|| {
            self.last_output_cache_refresh
                .map(|last| OUTPUT_CACHE_REFRESH_INTERVAL.saturating_sub(last.elapsed()))
                .unwrap_or_default()
        })
    }
}

fn merge_option<T>(target: &mut Option<T>, incoming: Option<T>) {
    if incoming.is_some() {
        *target = incoming;
    }
}

fn bound_output(item: &mut BackgroundWorkItem) {
    // Sub-agent threads are conversation logs — prompt, tool lines, thinking
    // markers, result — not terminal noise, so they stay whole instead of
    // being tail-cut at the process cap.
    if matches!(item.key.kind, BackgroundWorkKind::Subagent) {
        return;
    }
    let Some(output) = item.output.as_mut() else {
        return;
    };
    if output.len() <= MAX_BACKGROUND_OUTPUT_BYTES {
        return;
    }
    let mut cut = output.len() - MAX_BACKGROUND_OUTPUT_BYTES;
    while !output.is_char_boundary(cut) {
        cut += 1;
    }
    output.drain(..cut);
    item.output_truncated = true;
}

fn strip_ansi(text: &str) -> String {
    let mut clean = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            clean.push(character);
        }
    }
    clean
}

pub(super) fn work_status_label(status: BackgroundWorkStatus) -> String {
    match status {
        BackgroundWorkStatus::Starting => tr!("background.status.starting"),
        BackgroundWorkStatus::Running => tr!("background.status.running"),
        BackgroundWorkStatus::Stopping => tr!("background.status.stopping"),
        BackgroundWorkStatus::Completed => tr!("background.status.completed"),
        BackgroundWorkStatus::Failed => tr!("background.status.failed"),
        BackgroundWorkStatus::Stopped => tr!("background.status.stopped"),
        BackgroundWorkStatus::Lost => tr!("background.status.lost"),
    }
}

fn work_status_icon(status: BackgroundWorkStatus) -> &'static str {
    match status {
        BackgroundWorkStatus::Starting | BackgroundWorkStatus::Running => "icons/loader-circle.svg",
        BackgroundWorkStatus::Stopping | BackgroundWorkStatus::Stopped => "icons/stop.svg",
        BackgroundWorkStatus::Completed => "icons/check.svg",
        BackgroundWorkStatus::Failed => "icons/x.svg",
        BackgroundWorkStatus::Lost => "icons/alert.svg",
    }
}

fn background_summary_process_status_icon(
    kind: BackgroundWorkKind,
    status: BackgroundWorkStatus,
) -> Option<&'static str> {
    if !matches!(kind, BackgroundWorkKind::Process) {
        return None;
    }

    match status {
        BackgroundWorkStatus::Starting
        | BackgroundWorkStatus::Running
        | BackgroundWorkStatus::Completed
        | BackgroundWorkStatus::Failed => Some(work_status_icon(status)),
        _ => None,
    }
}

fn rendered_work_status_icon(status: BackgroundWorkStatus, size: f32, color: Hsla) -> AnyElement {
    let icon = icon(work_status_icon(status), size, color);
    if matches!(
        status,
        BackgroundWorkStatus::Starting | BackgroundWorkStatus::Running
    ) {
        // Background work runs for minutes; don't price its pane at full rate.
        motion::spin_slow(icon)
    } else {
        icon.into_any_element()
    }
}

pub(super) fn work_status_color(status: BackgroundWorkStatus, theme: Theme) -> Hsla {
    match status {
        BackgroundWorkStatus::Starting | BackgroundWorkStatus::Running => theme.accent,
        BackgroundWorkStatus::Completed => theme.success,
        BackgroundWorkStatus::Failed | BackgroundWorkStatus::Lost => theme.danger,
        BackgroundWorkStatus::Stopping | BackgroundWorkStatus::Stopped => theme.text_tertiary,
    }
}

pub(super) fn work_kind_icon(kind: BackgroundWorkKind) -> &'static str {
    match kind {
        BackgroundWorkKind::Subagent => "icons/bot.svg",
        BackgroundWorkKind::Process => "icons/terminal-square.svg",
    }
}

fn work_elapsed(item: &BackgroundWorkItem) -> String {
    let duration_ms = item.duration_ms.unwrap_or_else(|| {
        let end = if item.status.is_live() {
            unix_time_millis()
        } else {
            item.updated_at_ms
        };
        end.saturating_sub(item.started_at_ms)
    });
    let seconds = duration_ms / 1_000;
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 60 * 60 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h {:02}m", seconds / 3_600, (seconds % 3_600) / 60)
    }
}

impl Tide {
    pub(super) fn background_output_refresh_delay(&self) -> Option<Duration> {
        self.background_work
            .values()
            .filter_map(BackgroundWorkRegistry::output_refresh_delay)
            .min()
    }

    pub(super) fn observe_foreground_command_activity(
        &mut self,
        session_id: Uuid,
        activity: &ActivityItem,
    ) {
        if activity.kind != crate::model::ActivityKind::Command {
            return;
        }
        let provider_id = activity
            .source_id
            .clone()
            .unwrap_or_else(|| activity.id.to_string());
        let status = if !activity.complete {
            BackgroundWorkStatus::Running
        } else if activity.failed {
            BackgroundWorkStatus::Failed
        } else {
            BackgroundWorkStatus::Completed
        };
        let mut item = BackgroundWorkItem::new(
            BackgroundWorkKind::Process,
            provider_id.clone(),
            activity.title.clone(),
            status,
        );
        item.command = activity.display_target.clone();
        item.detail = activity.detail.clone();
        item.output = activity.output.clone();
        item.origin_activity_id = Some(provider_id);
        self.handle_background_work_event(session_id, BackgroundWorkEvent::Upsert(item));
    }

    pub(super) fn handle_background_work_event(
        &mut self,
        session_id: Uuid,
        event: BackgroundWorkEvent,
    ) {
        // Durability write-through: sub-agent runs persist with the session
        // (settled or in flight) so the agents panel survives a restart —
        // the in-memory registry below is the only other copy.
        if event_touches_subagent(&event) {
            let run = subagent_run_from_event(&event);
            if let Some(session) = self.state.session_mut(session_id) {
                upsert_subagent_run(&mut session.subagent_runs, run);
                self.state.mark_session_dirty(session_id);
            }
        }
        self.background_work
            .entry(session_id)
            .or_default()
            .apply(event);
    }

    pub(super) fn mark_background_work_lost(&mut self, session_id: Uuid) {
        if let Some(registry) = self.background_work.get_mut(&session_id) {
            registry.mark_live_lost();
        }
    }

    pub(super) fn settle_foreground_work(
        &mut self,
        session_id: Uuid,
        status: BackgroundWorkStatus,
    ) {
        if let Some(registry) = self.background_work.get_mut(&session_id) {
            registry.settle_foreground(status);
        }
    }

    pub(super) fn session_has_live_background_work(&self, session_id: Uuid) -> bool {
        self.background_work
            .get(&session_id)
            .is_some_and(BackgroundWorkRegistry::has_live)
    }

    pub(super) fn session_has_live_detached_work(&self, session_id: Uuid) -> bool {
        self.background_work
            .get(&session_id)
            .is_some_and(BackgroundWorkRegistry::has_live_detached)
    }

    pub(super) fn background_work_counts(&self, session_id: Uuid) -> (usize, usize) {
        self.background_work
            .get(&session_id)
            .map(BackgroundWorkRegistry::counts)
            .unwrap_or_default()
    }

    pub(super) fn background_work_for_activity(
        &self,
        session_id: Uuid,
        activity_id: &str,
    ) -> Option<&BackgroundWorkItem> {
        self.background_work
            .get(&session_id)?
            .items
            .values()
            .find(|item| item.origin_activity_id.as_deref() == Some(activity_id))
    }

    pub(super) fn maybe_refresh_background_work(&mut self, cx: &mut Context<Self>) {
        // The popup pin must not outlive its indicator: when the selected
        // session's last live job settles, the badge (and any open popup)
        // vanishes, so a stuck `hovered` would otherwise reopen the popup
        // on the next job's first tick with the pointer nowhere near it.
        if (self.composer_jobs_popup_hovered || self.composer_jobs_popup_pinned)
            && self
                .state
                .selected_session
                .is_none_or(|session_id| !self.session_has_live_background_work(session_id))
        {
            self.composer_jobs_popup_hovered = false;
            self.composer_jobs_popup_pinned = false;
            cx.notify();
        }
        let mut output_changed = false;
        for registry in self.background_work.values_mut() {
            output_changed |= registry.refresh_output_cache();
        }
        if output_changed {
            cx.notify();
        }
        let selected = self.state.selected_session;
        for (session_id, runtime) in &mut self.runtimes {
            let should_refresh = selected == Some(*session_id)
                || self
                    .background_work
                    .get(session_id)
                    .is_some_and(BackgroundWorkRegistry::has_live);
            if should_refresh
                && runtime.last_background_refresh_at.elapsed() >= BACKGROUND_WORK_REFRESH_INTERVAL
            {
                runtime.last_background_refresh_at = Instant::now();
                runtime.driver.refresh_background_work();
            }
        }

        if self.last_background_work_tick.elapsed() >= BACKGROUND_WORK_TICK_INTERVAL
            && selected.is_some_and(|session_id| self.session_has_live_background_work(session_id))
        {
            self.last_background_work_tick = Instant::now();
            cx.notify();
        }
    }

    pub(super) fn stop_background_work(
        &mut self,
        session_id: Uuid,
        key: BackgroundWorkKey,
        cx: &mut Context<Self>,
    ) {
        let control_id = self
            .background_work
            .get(&session_id)
            .and_then(|registry| registry.items.get(&key))
            .filter(|item| item.status.is_stoppable() && item.can_stop)
            .and_then(|item| item.control_id.clone());
        let Some(control_id) = control_id else {
            return;
        };
        let Some(driver) = self
            .runtimes
            .get(&session_id)
            .map(|runtime| runtime.driver.clone())
        else {
            self.mark_background_work_lost(session_id);
            cx.notify();
            return;
        };
        self.handle_background_work_event(
            session_id,
            BackgroundWorkEvent::StopRequested(key.clone()),
        );
        driver.stop_background_work(key, control_id);
        cx.notify();
    }

    pub(super) fn open_background_work_surface(
        &mut self,
        session_id: Uuid,
        key: BackgroundWorkKey,
        cx: &mut Context<Self>,
    ) {
        let Some(title) = self
            .background_work
            .get(&session_id)
            .and_then(|registry| registry.items.get(&key))
            .map(|item| item.title.clone())
        else {
            return;
        };
        if self.state.selected_session != Some(session_id) {
            self.select_session(session_id, cx);
        }
        self.open_right_panel_surface(RightPanelSurface::BackgroundWork { key, title }, cx);
    }

    /// The selected session's dispatched sub-agents, newest first — the
    /// Agents tab's list. Sub-agent items live in the session's
    /// background-work registry (`background_work[session_id].items`, keyed
    /// `BackgroundWorkKey { kind: Subagent, provider_id }`), fed by the
    /// provider's background-work events.
    pub(super) fn selected_session_agents(&self) -> Vec<BackgroundWorkItem> {
        self.state
            .selected_session
            .and_then(|session_id| self.background_work.get(&session_id))
            .map(|registry| registry.subagent_items().into_iter().cloned().collect())
            .unwrap_or_default()
    }

    /// The count the Agents chooser card's badge shows: every sub-agent item
    /// the tab would list, live and recently settled alike.
    pub(super) fn selected_session_agents_count(&self) -> usize {
        self.state
            .selected_session
            .and_then(|session_id| self.background_work.get(&session_id))
            .map_or(0, BackgroundWorkRegistry::subagent_count)
    }

    /// Open the right-panel detail for the sub-agent a dispatch tool card
    /// names — the v2 Bot hover action's handler. The card passes its
    /// disclosure id, which is the activity's provider-native source id;
    /// registry items carry the same id in `origin_activity_id` when the
    /// provider exposes it. Found, the item's own detail surface opens
    /// directly (the direct-detail route — lighter than plumbing
    /// focus-and-scroll through the Agents list). Not found — the provider
    /// was opaque about the origin, or the settled item already aged out of
    /// the trim window — the Agents list opens, so the click still lands
    /// somewhere useful.
    pub(super) fn open_dispatch_activity(&mut self, dispatch_id: &str, cx: &mut Context<Self>) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        if let Some(key) = self
            .background_work_for_activity(session_id, dispatch_id)
            .filter(|item| item.key.kind == BackgroundWorkKind::Subagent)
            .map(|item| item.key.clone())
        {
            self.open_background_work_surface(session_id, key, cx);
        } else {
            self.open_right_panel_surface(RightPanelSurface::Agents, cx);
        }
    }

    pub(super) fn render_background_work_summary(&self, cx: &mut Context<Self>) -> AnyElement {
        let session = self.selected_session();
        let session_id = session.map(|session| session.id);
        let identifiers = session.map(|session| TaskIdentifierSection {
            values: TaskIdentifiers::from(session),
            task_id_copy_focus: self.transcript_control_focus(TASK_ID_COPY_CONTROL_ID, cx),
            agent_cli_thread_id_copy_focus: self
                .transcript_control_focus(AGENT_THREAD_ID_COPY_CONTROL_ID, cx),
            task_id_copied: self.control_was_copied(TASK_ID_COPY_CONTROL_ID),
            agent_cli_thread_id_copied: self.control_was_copied(AGENT_THREAD_ID_COPY_CONTROL_ID),
        });
        let entries = session_id
            .and_then(|session_id| self.background_work.get(&session_id))
            .map(|registry| {
                registry
                    .ordered_items()
                    .into_iter()
                    .cloned()
                    .map(|item| {
                        let kind = item.key.kind as u8;
                        let provider_id = &item.key.provider_id;
                        BackgroundSummaryEntry {
                            row_focus: self.transcript_control_focus(
                                format!("background-summary-row-{provider_id}-{kind}"),
                                cx,
                            ),
                            stop_focus: self.transcript_control_focus(
                                format!("background-summary-stop-{provider_id}-{kind}"),
                                cx,
                            ),
                            item,
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let workspace_path = session
            .and_then(|session| self.workspace_path_for_session(session))
            .or_else(|| {
                self.selected_project()
                    .map(|project| project.path.as_path())
            });
        let snapshot = workspace_path.and_then(|path| {
            self.visible_branch_snapshot
                .as_ref()
                .filter(|(snapshot_path, _)| snapshot_path == path)
                .map(|(_, snapshot)| snapshot)
        });
        let change_counts = snapshot
            .map(|snapshot| (snapshot.additions, snapshot.deletions))
            .filter(|(additions, deletions)| *additions > 0 || *deletions > 0);
        let environment = Some(EnvironmentSummary {
            commit_status: self.commit_operation_status_label(),
            commit_focus: self.transcript_control_focus("environment-summary-commit", cx),
        });
        let (processes, agents) = session_id
            .map(|session_id| self.background_work_counts(session_id))
            .unwrap_or_default();
        let summary = background_work_count_summary(processes, agents);
        let theme = Theme::current(cx);
        let refresh_weak = cx.entity().downgrade();
        let handle = self.menu_handle_with(BACKGROUND_SUMMARY_MENU_ID, cx, move |open, _, cx| {
            if open {
                let _ = refresh_weak.update(cx, |this, cx| {
                    this.refresh_selected_branch_snapshot(cx);
                });
            }
        });
        let trigger = div()
            .id("environment-summary-trigger")
            .size(px(28.0))
            .rounded(px(7.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .focus_visible(|style| {
                style
                    .bg(theme.overlay)
                    .border_1()
                    .border_color(theme.accent)
            })
            .hover(|style| style.bg(theme.overlay))
            .when(handle.is_open(), |style| style.bg(theme.overlay_strong))
            .tooltip(Tooltip::text(if summary.is_empty() {
                tr!("environment.summary")
            } else {
                summary
            }))
            .child(icon("icons/info.svg", 15.0, theme.text_tertiary));
        let git_status = change_counts.map(|(additions, deletions)| {
            let focus = self.transcript_control_focus("header-git-status", cx);
            div()
                .id("header-git-status")
                .track_focus(&focus)
                .tab_index(0)
                .h(px(28.0))
                .px(px(7.0))
                .rounded(px(7.0))
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.0))
                .cursor_default()
                .text_size(sp(12.5))
                .font_weight(FontWeight::MEDIUM)
                .focus_visible(|style| {
                    style
                        .bg(theme.overlay)
                        .border_1()
                        .border_color(theme.accent)
                })
                .hover(|style| style.bg(theme.overlay))
                .active(|style| style.bg(theme.overlay_strong))
                .when(additions > 0, |button| {
                    button.child(
                        div()
                            .text_color(theme.success)
                            .child(format!("+{additions}")),
                    )
                })
                .when(deletions > 0, |button| {
                    button.child(
                        div()
                            .text_color(theme.danger)
                            .child(format!("-{deletions}")),
                    )
                })
                .tooltip(Tooltip::text(tr!("environment.changes")))
                .on_mouse_down(MouseButton::Left, |_, _, cx| {
                    cx.stop_propagation();
                })
                .on_click(cx.listener(|this, _, _, cx| {
                    cx.stop_propagation();
                    this.git_panel.tab = GitPanelTab::Changes;
                    this.open_right_panel_surface(RightPanelSurface::Git, cx);
                }))
                .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        this.git_panel.tab = GitPanelTab::Changes;
                        this.open_right_panel_surface(RightPanelSurface::Git, cx);
                        cx.stop_propagation();
                    }
                }))
                .into_any_element()
        });
        let open_in = self.render_open_in_control(workspace_path, cx);
        let entries = Rc::new(entries);
        let weak = cx.entity().downgrade();
        let info = popover(
            trigger,
            &handle,
            MenuAlign::BelowRight,
            move |handle, _, cx| {
                render_background_summary_card(
                    handle,
                    session_id.unwrap_or_else(Uuid::nil),
                    identifiers.clone(),
                    environment.clone(),
                    entries.clone(),
                    weak.clone(),
                    cx,
                )
            },
        );
        div()
            .id("header-environment-controls")
            .tab_group()
            .tab_stop(false)
            .flex_none()
            .flex()
            .items_center()
            .gap(px(8.0))
            .children(git_status)
            .children(open_in)
            .child(info)
            .into_any_element()
    }

    /// Resolve the "open project in app" targets once, off-thread; the header
    /// control and its menu render purely from the stored list.
    pub(super) fn detect_open_in_apps(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let apps = cx
                .background_executor()
                .spawn(async move { crate::platform::detect_open_in_apps() })
                .await;
            if apps.is_empty() {
                return;
            }
            let _ = this.update(cx, |this, cx| {
                this.open_in_apps = Rc::new(apps);
                cx.notify();
            });
        })
        .detach();
    }

    /// The app the primary "open in" button targets: the persisted choice
    /// while it is still installed, otherwise the file manager.
    fn preferred_open_in_app(&self) -> Option<&crate::platform::ExternalApp> {
        self.state
            .open_in_app
            .as_deref()
            .and_then(|id| self.open_in_apps.iter().find(|app| app.id == id))
            .or_else(|| self.open_in_apps.iter().find(|app| app.id == "finder"))
            .or_else(|| self.open_in_apps.first())
    }

    /// Open the workspace folder in the catalog app `app_id` and remember it
    /// as the preferred target. Launch Services delivers the open
    /// asynchronously, so this one-shot action never blocks a frame.
    fn open_workspace_in_app(&mut self, path: &Path, app_id: &str, cx: &mut Context<Self>) {
        let Some(bundle_id) = self
            .open_in_apps
            .iter()
            .find(|app| app.id == app_id)
            .map(|app| app.bundle_id)
        else {
            return;
        };
        crate::platform::open_path_in_app(path, bundle_id);
        if self.state.open_in_app.as_deref() != Some(app_id) {
            self.state.open_in_app = Some(app_id.to_owned());
            self.save();
            cx.notify();
        }
    }

    /// The split "open project in app" control: an icon button launching the
    /// preferred app, and a chevron opening the menu of every installed
    /// target. Hidden while there is no local folder to open or app detection
    /// has not landed yet.
    fn render_open_in_control(
        &self,
        workspace_path: Option<&Path>,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.daemon.is_remote() {
            return None;
        }
        let path: Rc<Path> = Rc::from(workspace_path?);
        let preferred = self.preferred_open_in_app()?;
        let preferred_id = preferred.id;
        let preferred_label = preferred.label;
        let preferred_icon = preferred.icon.clone();
        let apps = self.open_in_apps.clone();
        let theme = Theme::current(cx);
        let handle = self.menu_handle(OPEN_IN_MENU_ID, cx);
        let focus = self.transcript_control_focus("header-open-in", cx);

        let primary_path = path.clone();
        let key_path = path.clone();
        let primary = div()
            .id("header-open-in")
            .track_focus(&focus)
            .tab_index(0)
            .h_full()
            .px(px(6.0))
            .rounded_tl(px(6.0))
            .rounded_bl(px(6.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .focus_visible(|style| {
                style
                    .bg(theme.overlay)
                    .border_1()
                    .border_color(theme.accent)
            })
            .hover(|style| style.bg(theme.overlay))
            .active(|style| style.bg(theme.overlay_strong))
            .tooltip(Tooltip::text(tr!("open_in.open", app = preferred_label)))
            .child(img(preferred_icon).size(px(16.0)).flex_none())
            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                cx.stop_propagation();
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                this.open_workspace_in_app(&primary_path, preferred_id, cx);
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    this.open_workspace_in_app(&key_path, preferred_id, cx);
                    cx.stop_propagation();
                }
            }));

        let caret = div()
            .id("header-open-in-caret")
            .h_full()
            .w(px(18.0))
            .rounded_tr(px(6.0))
            .rounded_br(px(6.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .focus_visible(|style| {
                style
                    .bg(theme.overlay)
                    .border_1()
                    .border_color(theme.accent)
            })
            .hover(|style| style.bg(theme.overlay))
            .when(handle.is_open(), |style| style.bg(theme.overlay_strong))
            .tooltip(Tooltip::text(tr!("open_in.choose")))
            .child(icon("icons/chevron-down.svg", 11.0, theme.text_tertiary));

        let weak = cx.entity().downgrade();
        let menu = dropdown_menu(
            caret,
            "header-open-in-menu",
            &handle,
            MenuAlign::BelowRight,
            move |_| {
                apps.iter()
                    .map(|app| {
                        let weak = weak.clone();
                        let path = path.clone();
                        let app_id = app.id;
                        MenuItem::new(app.label, move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.open_workspace_in_app(&path, app_id, cx);
                            });
                        })
                        .image(app.icon.clone())
                        .selected(app.id == preferred_id)
                    })
                    .collect()
            },
        );

        // One outlined group, so the two segments read as a single split
        // button even though only the hovered half fills.
        Some(
            div()
                .h(px(28.0))
                .rounded(px(7.0))
                .border_1()
                .border_color(theme.border_strong)
                .flex_none()
                .flex()
                .items_center()
                .child(primary)
                .child(div().w(px(1.0)).h_full().flex_none().bg(theme.border))
                .child(menu)
                .into_any_element(),
        )
    }

    pub(super) fn render_background_work_surface(
        &self,
        key: &BackgroundWorkKey,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let session_id = self.state.selected_session;
        let registry = session_id.and_then(|session_id| self.background_work.get(&session_id));
        let item = registry.and_then(|registry| registry.items.get(key));
        let Some(item) = item else {
            return div()
                .id("background-work-surface")
                .tab_group()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(7.0))
                        .child(icon(work_kind_icon(key.kind), 22.0, theme.text_ghost))
                        .child(
                            div()
                                .text_size(sp(12.5))
                                .text_color(theme.text_secondary)
                                .child(tr!("background.no_work")),
                        ),
                );
        };
        let output = registry
            .and_then(|registry| registry.rendered_output.get(key))
            .cloned();
        let output_viewport = registry
            .and_then(|registry| registry.output_viewports.get(key))
            .cloned()
            .unwrap_or_default();
        let selection = registry
            .map(|registry| registry.selection.clone())
            .unwrap_or_default();
        let status_color = work_status_color(item.status, theme);
        let tool_count_label = subagent_tool_count_label(&item.subagent_blocks);
        let stop = session_id.and_then(|session_id| {
            (item.status.is_stoppable() && item.can_stop).then(|| {
                let focus = self.transcript_control_focus(
                    format!(
                        "background-surface-stop-{}-{}",
                        item.key.provider_id, item.key.kind as u8
                    ),
                    cx,
                );
                let click_key = item.key.clone();
                let click_weak = cx.entity().downgrade();
                let key_key = item.key.clone();
                let key_weak = cx.entity().downgrade();
                div()
                    .id(SharedString::from(format!(
                        "background-surface-stop-{}-{}",
                        item.key.provider_id, item.key.kind as u8
                    )))
                    .track_focus(&focus)
                    .tab_index(0)
                    .h(px(26.0))
                    .px(px(9.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .cursor_default()
                    .text_size(sp(12.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text_secondary)
                    .hover(|style| style.bg(theme.danger.opacity(0.10)))
                    .active(|style| style.bg(theme.danger.opacity(0.16)))
                    .focus_visible(|style| style.border_color(theme.accent))
                    .tooltip(Tooltip::text(tr!("background.stop")))
                    .child(icon("icons/stop-filled.svg", 11.0, theme.danger))
                    .child(tr!("background.stop"))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        let _ = click_weak.update(cx, |this, cx| {
                            this.stop_background_work(session_id, click_key.clone(), cx);
                        });
                    })
                    .on_key_down(move |event: &KeyDownEvent, _, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            let _ = key_weak.update(cx, |this, cx| {
                                this.stop_background_work(session_id, key_key.clone(), cx);
                            });
                            cx.stop_propagation();
                        }
                    })
            })
        });
        let card = div()
            .w_full()
            .flex()
            .flex_col()
            .rounded(px(9.0))
            .border_1()
            .border_color(theme.border)
            .overflow_hidden()
            .bg(theme.surface)
            .child(
                div()
                    .min_h(px(54.0))
                    .px(px(11.0))
                    .py(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(9.0))
                    .child(icon(
                        work_kind_icon(item.key.kind),
                        15.0,
                        theme.text_secondary,
                    ))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(
                                div()
                                    .truncate()
                                    .text_size(sp(12.5))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text)
                                    .child(single_line_label(&item.title)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(5.0))
                                    .text_size(sp(12.5))
                                    .text_color(theme.text_tertiary)
                                    .child(rendered_work_status_icon(
                                        item.status,
                                        9.0,
                                        status_color,
                                    ))
                                    .child(work_status_label(item.status))
                                    .child("·")
                                    .child(work_elapsed(item))
                                    .when_some(tool_count_label, |row, label| {
                                        row.child("·").child(label)
                                    }),
                            ),
                    )
                    .when_some(stop, |header, stop| header.child(stop)),
            )
            .child(self.render_background_work_detail(
                item,
                output,
                output_viewport,
                selection,
                cx,
            ));
        div()
            .id("background-work-surface")
            .tab_group()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p(px(12.0))
            .child(card)
    }

    fn render_background_work_detail(
        &self,
        item: &BackgroundWorkItem,
        output: Option<SharedString>,
        output_viewport: BackgroundOutputViewport,
        selection: TranscriptSelection,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        // A sub-agent with a block timeline renders the real stream — task,
        // reasoning, tool runs, narration, result — instead of the metadata
        // rows and plain output log.
        if renders_subagent_timeline(item) {
            return self.render_subagent_timeline(item, selection, cx);
        }
        let mut detail = div().w_full().flex().flex_col().bg(theme.surface);
        let mut metadata = Vec::new();
        // A subagent's "command" is the prompt it was launched with.
        let command_label = match item.key.kind {
            BackgroundWorkKind::Subagent => tr!("background.prompt"),
            BackgroundWorkKind::Process => tr!("background.command"),
        };
        for (label, value) in [
            (command_label, item.command.as_ref()),
            (tr!("background.cwd"), item.cwd.as_ref()),
            (tr!("background.role"), item.role.as_ref()),
            (tr!("background.model"), item.model.as_ref()),
            (tr!("background.latest_update"), item.detail.as_ref()),
        ] {
            if let Some(value) = value.filter(|value| !value.is_empty()) {
                metadata.push((label, value.clone()));
            }
        }
        if let Some(exit_code) = item.exit_code {
            metadata.push((tr!("background.exit_code"), exit_code.to_string()));
        }
        for (label, value) in metadata {
            detail = detail.child(
                div()
                    .border_t_1()
                    .border_color(theme.border)
                    .px(px(10.0))
                    .py(px(7.0))
                    .flex()
                    .flex_col()
                    .gap(px(3.0))
                    .child(
                        div()
                            .text_size(sp(12.5))
                            .text_color(theme.text_tertiary)
                            .child(label),
                    )
                    .child(
                        div()
                            .text_size(sp(12.5))
                            .font_family(md::render::MONO_FAMILY)
                            .text_color(theme.text_secondary)
                            .child(value),
                    ),
            );
        }
        let output = output.unwrap_or_else(|| SharedString::from(tr!("background.no_output")));
        let output_flat = md::render::flatten_plain(
            output,
            md::render::MONO_FAMILY,
            FontWeight::NORMAL,
            theme.text_secondary,
        );
        let output_text = md::render::selectable_flat_text(
            &output_flat,
            crate::md::selection::TextKey::new(
                format!(
                    "background-output-{}-{}",
                    item.key.provider_id, item.key.kind as u8
                ),
                0,
            ),
            selection.clone(),
            theme.code_wash,
            theme.selection,
            false,
        );
        detail.child(
            div()
                .border_t_1()
                .border_color(theme.border)
                .p(px(10.0))
                .flex()
                .flex_col()
                .gap(px(5.0))
                .child(
                    div()
                        .w_full()
                        .flex()
                        .items_center()
                        .justify_between()
                        .text_size(sp(12.5))
                        .text_color(theme.text_tertiary)
                        .child(tr!("background.output"))
                        .when(item.output_truncated, |header| {
                            header.child(tr!("background.output_truncated"))
                        }),
                )
                .child(
                    div()
                        .relative()
                        .max_h(px(320.0))
                        .rounded(px(6.0))
                        .overflow_hidden()
                        .bg(theme.terminal)
                        .child(md::render::frame_reset(selection.clone()))
                        .child(
                            div()
                                .id(SharedString::from(format!(
                                    "background-output-scroll-{}-{}",
                                    item.key.provider_id, item.key.kind as u8
                                )))
                                .max_h(px(320.0))
                                .overflow_y_scroll()
                                .track_scroll(&output_viewport.scroll_handle)
                                .on_scroll_wheel({
                                    let scroll = output_viewport.scroll_handle.clone();
                                    move |_, _, cx| contain_scroll(&scroll, cx)
                                })
                                .p(px(8.0))
                                .text_size(sp(12.5))
                                .line_height(sp(15.0))
                                .font_family(md::render::MONO_FAMILY)
                                .text_color(theme.text_secondary)
                                .child(output_text),
                        )
                        .child(scrollbar::vertical(
                            &output_viewport.scroll_handle,
                            &output_viewport.scrollbar,
                        ))
                        .child(background_work_selection_input(selection)),
                ),
        )
    }
}

fn background_work_selection_input(selection: TranscriptSelection) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |_, _, window, _| md::render::install_selection_input(window, &selection),
    )
    .absolute()
    .w(px(0.0))
    .h(px(0.0))
}

// ── Sub-agent block timeline ─────────────────────────────────────────────────
//
// The agents-panel detail for a sub-agent with a block stream: the dispatch
// task as a right-aligned prompt bubble (the user-bubble grammar), then the
// child's real blocks in the main timeline's visual grammar — reasoning
// disclosures, static tool-card header rows, markdown narration — and the
// final report in a bordered Result card. tide's agents-tab anatomy, on this
// app's own parts.

use crate::app::timeline_v2::parts::reasoning_part::reasoning_summary;
use crate::app::timeline_v2::parts::tool_part::{
    HEADER_GAP, HEADER_H, HEADER_ICON, HEADER_ICON_COL, HEADER_LINE_HEIGHT, HEADER_PAD, HEADER_TEXT,
};
use crate::app::timeline_v2::parts::user_bubble::{CLAMP_MAX_HEIGHT, clamp_needed};
use crate::app::timeline_v2::{
    Status, label_for, status_color, tools_description, tools_dim, tools_title,
};
use crate::ui::icon_button;

/// Height cap of a settled reasoning block's scroll viewport — the same
/// budget the main timeline's reasoning part keeps.
const SUBAGENT_REASONING_MAX_HEIGHT: f32 = 400.0;
/// The clamp fade's height — how far the mask gradient reaches up the task
/// bubble (user_bubble keeps its own private copy at the same number).
const SUBAGENT_TASK_FADE_HEIGHT: f32 = 28.0;

/// Duration label a settled tool block trails with: sub-second in
/// milliseconds, else tenths of a second — the d62bae5 log line's format,
/// now fed from the block's own `duration_ms`.
fn subagent_tool_duration(duration_ms: u64) -> String {
    if duration_ms < 1_000 {
        format!("{duration_ms}ms")
    } else {
        format!("{:.1}s", duration_ms as f32 / 1_000.0)
    }
}

/// The disclosure key for one timeline element. `task` names the prompt
/// bubble's clamp, `r{index}` a reasoning block, `t{index}` a narration
/// block's markdown view, `report` the Result card's view.
fn subagent_timeline_key(provider_id: &str, block: &str) -> String {
    format!("{provider_id}:{block}")
}

/// The tool-count segment the detail header's meta row appends: "3 tools".
fn subagent_tool_count_label(blocks: &[SubagentBlock]) -> Option<String> {
    let count = blocks
        .iter()
        .filter(|block| matches!(block, SubagentBlock::Tool { .. }))
        .count();
    (count > 0).then(|| {
        if count == 1 {
            tr!("background.tool_count_one")
        } else {
            tr!("background.tool_count", count = count)
        }
    })
}

/// Whether a work item renders as the sub-agent block timeline: any blocks,
/// or a task to headline one. The driver pops a child's single final message
/// into `output` — a report-only run then has no blocks left, and the task
/// bubble + Result card still render. Old persisted items carry neither and
/// keep the metadata rows and plain output log.
fn renders_subagent_timeline(item: &BackgroundWorkItem) -> bool {
    item.key.kind == BackgroundWorkKind::Subagent
        && (!item.subagent_blocks.is_empty() || item.task.is_some())
}

impl Tide {
    /// The sub-agent detail body when the item carries a block timeline:
    /// task bubble, blocks, Result card — three elements on the column's one
    /// gap rhythm, with the blocks themselves one continuous stream (narration
    /// flush, reasoning and tool rows at their own `HEADER_PAD`, only the
    /// column's 2px between siblings). Old persisted items (no blocks) never
    /// reach here — they keep the metadata rows and plain output log.
    fn render_subagent_timeline(
        &self,
        item: &BackgroundWorkItem,
        selection: TranscriptSelection,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        let mut timeline = div()
            .w_full()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .px(px(12.0))
            .py(px(11.0))
            .child(md::render::frame_reset(selection.clone()));
        // The durable dispatch id — the resumeFrom / send_message target —
        // with its copy affordance, so the value the model addresses this
        // child by is reachable by hand.
        if !item.key.provider_id.is_empty() {
            let short: String = item.key.provider_id.chars().take(8).collect();
            let full = item.key.provider_id.clone();
            timeline = timeline.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(sp(10.5))
                            .text_color(tools_dim(&theme))
                            .child(SharedString::from(format!("dispatch {short}"))),
                    )
                    .child(
                        icon_button(
                            SharedString::from(format!(
                                "subagent-dispatch-id-{}",
                                item.key.provider_id
                            )),
                            "icons/copy.svg",
                            theme,
                        )
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(full.clone()));
                        }),
                    ),
            );
        }
        if let Some(task) = item
            .task
            .as_deref()
            .map(str::trim)
            .filter(|task| !task.is_empty())
        {
            timeline = timeline.child(self.render_subagent_task(item, task, cx));
        }
        let mut blocks = div().w_full().flex().flex_col().gap(px(2.0));
        for (index, block) in item.subagent_blocks.iter().enumerate() {
            blocks = blocks.child(match block {
                SubagentBlock::Reasoning { text, streaming } => self
                    .render_subagent_reasoning(item, index, text, *streaming, selection.clone(), cx)
                    .into_any_element(),
                SubagentBlock::Tool { .. } => {
                    render_subagent_tool_row(block, &theme).into_any_element()
                }
                SubagentBlock::Text { content, streaming } => self
                    .render_subagent_text(item, index, content, *streaming, selection.clone(), cx)
                    .into_any_element(),
                SubagentBlock::Message { from, text } => {
                    render_subagent_message_row(from, text, &theme).into_any_element()
                }
            });
        }
        timeline = timeline.child(blocks);
        // The report rides `output` and lands there only at completion, so
        // its presence is the settled signal — the answer element of the
        // timeline, the way tide's agents tab renders the dispatch report.
        if let Some(report) = item
            .output
            .as_deref()
            .map(str::trim)
            .filter(|report| !report.is_empty())
        {
            timeline = timeline.child(self.render_subagent_result(item, report, selection, cx));
        }
        timeline
    }

    /// The dispatch task as the timeline's prompt header: the user-bubble
    /// anatomy (raised surface, 12px radius, 14sp/20sp, max-w 540) in a
    /// right-aligned column under a dim "Task" caption, clamped at the same
    /// 160px budget with the bottom mask fade and a chevron disclosure.
    fn render_subagent_task(
        &self,
        item: &BackgroundWorkItem,
        task: &str,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        let provider_id = item.key.provider_id.clone();
        let key = subagent_timeline_key(&provider_id, "task");
        let expanded = self.subagent_disclosures.contains(&key);
        let clamped = clamp_needed(task) && !expanded;
        let surface = theme.raised;
        let bubble = div()
            .relative()
            .max_w(px(540.0))
            .min_w_0()
            .rounded(px(12.0))
            .bg(surface)
            .px(px(14.0))
            .py(px(10.0))
            .text_size(sp(14.0))
            .line_height(sp(20.0))
            .text_color(theme.text)
            .when(clamped, |bubble| {
                bubble.max_h(px(CLAMP_MAX_HEIGHT)).overflow_hidden().child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom_0()
                        .h(px(SUBAGENT_TASK_FADE_HEIGHT))
                        .bg(linear_gradient(
                            180.0,
                            linear_color_stop(surface.opacity(0.0), 0.0),
                            linear_color_stop(surface, 1.0),
                        )),
                )
            })
            .child(SharedString::from(task));
        let mut column = div()
            .w_full()
            .flex()
            .flex_col()
            .items_end()
            .gap(px(3.0))
            .child(
                div()
                    .text_size(sp(11.0))
                    .text_color(theme.text_ghost)
                    .child(tr!("background.task")),
            )
            .child(bubble);
        if clamp_needed(task) {
            let toggle_key = key;
            column = column.child(
                div()
                    .id(SharedString::from(format!(
                        "subagent-task-clamp-{provider_id}"
                    )))
                    .h(px(20.0))
                    .px(px(4.0))
                    .flex()
                    .items_center()
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .hover(|style| style.bg(theme.overlay))
                    .child(icon(
                        if expanded {
                            "icons/chevron-up.svg"
                        } else {
                            "icons/chevron-down.svg"
                        },
                        11.0,
                        theme.text_ghost,
                    ))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.subagent_disclosures.remove(&toggle_key) {
                            this.subagent_disclosures.insert(toggle_key.clone());
                        }
                        cx.notify();
                    })),
            );
        }
        column
    }

    /// One reasoning block: the main timeline's dim disclosure anatomy —
    /// brain glyph, "Thinking"/"Thinking…", the 80-char collapsed summary,
    /// the reveal chevron — and, expanded, the full trace as markdown in
    /// the dimmed palette, unbounded while streaming and in the 400px
    /// scroll viewport once settled.
    #[allow(clippy::too_many_arguments)]
    fn render_subagent_reasoning(
        &self,
        item: &BackgroundWorkItem,
        index: usize,
        text: &str,
        streaming: bool,
        selection: TranscriptSelection,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        let provider_id = item.key.provider_id.clone();
        let key = subagent_timeline_key(&provider_id, &format!("r{index}"));
        let expanded = self.subagent_disclosures.contains(&key);
        let content = text.trim();
        let togglable = !content.is_empty();
        let mut header = div()
            .id(SharedString::from(format!(
                "subagent-reasoning-{provider_id}-{index}"
            )))
            .h(px(HEADER_H))
            .w_full()
            .min_w_0()
            .overflow_hidden()
            .line_height(sp(HEADER_LINE_HEIGHT))
            .flex()
            .items_center()
            .gap(px(HEADER_GAP))
            .pl(px(HEADER_PAD))
            .pr(px(HEADER_PAD))
            .rounded(px(6.0))
            .when(togglable, |row| row.cursor_pointer())
            .hover(|style| style.bg(theme.overlay))
            .child(
                div()
                    .w(px(HEADER_ICON_COL))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon("icons/brain.svg", HEADER_ICON, tools_dim(&theme))),
            )
            .child(
                div()
                    .flex_none()
                    .min_w_0()
                    .truncate()
                    .text_size(sp(HEADER_TEXT))
                    .text_color(tools_dim(&theme))
                    .child(if streaming {
                        SharedString::from("Thinking…")
                    } else {
                        SharedString::from("Thinking")
                    }),
            );
        // The collapsed summary rides the remaining width; expanded, the
        // body already shows the whole trace.
        let summary = (!expanded && !content.is_empty())
            .then(|| SharedString::from(reasoning_summary(content)));
        header = header.child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(sp(12.0))
                .text_color(tools_description(&theme))
                .when_some(summary, |column, text| column.child(text)),
        );
        if togglable {
            header = header.child(icon(
                if expanded {
                    "icons/chevron-down.svg"
                } else {
                    "icons/chevron-right.svg"
                },
                11.0,
                tools_dim(&theme),
            ));
            let toggle_key = key.clone();
            header = header.on_click(cx.listener(move |this, _, _, cx| {
                if !this.subagent_disclosures.remove(&toggle_key) {
                    this.subagent_disclosures.insert(toggle_key.clone());
                }
                cx.notify();
            }));
        }
        let mut column = div().w_full().flex().flex_col().child(header);
        if expanded && togglable {
            let animate = streaming && !cx.reduce_motion();
            let trace = {
                let mut palette = MarkdownPalette::from_theme(&theme);
                palette.text = theme.text_secondary;
                palette.secondary = theme.text_tertiary;
                let metrics = self.scaled_markdown_metrics(MarkdownMetrics::COMPACT);
                let mut views = self.subagent_markdown.borrow_mut();
                let view = views.entry(key.clone()).or_default();
                view.set_text(content, streaming);
                let ctx = MarkdownCtx::new(
                    format!("subagent-reasoning-{key}"),
                    &palette,
                    metrics,
                    selection,
                )
                .with_streaming_animation(animate)
                .with_link_handler(self.markdown_link_handler.clone())
                .with_mermaid_handler(self.markdown_mermaid_handler.clone())
                .with_mermaid_host(self.markdown_mermaid_host.clone());
                md::render::markdown(view, &ctx).unwrap_or_else(|| {
                    md::render::plain_text(
                        content.to_owned(),
                        md::render::SANS_FAMILY,
                        FontWeight::NORMAL,
                        theme.text_secondary,
                        &ctx,
                    )
                })
            };
            column = column.child(
                div()
                    .flex()
                    .flex_col()
                    .min_w_0()
                    .overflow_hidden()
                    .pl(px(HEADER_PAD + HEADER_ICON_COL + HEADER_GAP))
                    .pr(px(4.0))
                    .pb(px(4.0))
                    .child(
                        div()
                            .id(SharedString::from(format!(
                                "subagent-reasoning-scroll-{provider_id}-{index}"
                            )))
                            .w_full()
                            .min_w_0()
                            .rounded(px(6.0))
                            .bg(theme.raised)
                            .px(px(8.0))
                            .py(px(6.0))
                            .when(!streaming, |viewport| {
                                viewport
                                    .max_h(px(SUBAGENT_REASONING_MAX_HEIGHT))
                                    .overflow_y_scroll()
                            })
                            .child(trace),
                    ),
            );
        }
        column
    }

    /// One narration block: the child's streamed text as markdown at the
    /// assistant body metrics — the same call shape the v2 pane's assistant
    /// body uses, on the detail surface's own per-block view cache. Rendered
    /// flush and full-width like the main timeline's bare assistant rows: no
    /// wrapper padding, border, or background, so narration, reasoning
    /// headers, and tool rows read as one continuous stream separated only by
    /// the blocks column's uniform gap.
    #[allow(clippy::too_many_arguments)]
    fn render_subagent_text(
        &self,
        item: &BackgroundWorkItem,
        index: usize,
        content: &str,
        streaming: bool,
        selection: TranscriptSelection,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return div();
        }
        let key = subagent_timeline_key(&item.key.provider_id, &format!("t{index}"));
        let body = {
            let palette = MarkdownPalette::from_theme(&theme);
            let metrics = self.scaled_markdown_metrics(MarkdownMetrics::BODY);
            let mut views = self.subagent_markdown.borrow_mut();
            let view = views.entry(key.clone()).or_default();
            view.set_text(trimmed, streaming);
            let ctx =
                MarkdownCtx::new(format!("subagent-text-{key}"), &palette, metrics, selection)
                    .with_streaming_animation(streaming && !cx.reduce_motion())
                    .with_link_handler(self.markdown_link_handler.clone())
                    .with_mermaid_handler(self.markdown_mermaid_handler.clone())
                    .with_mermaid_host(self.markdown_mermaid_host.clone());
            md::render::markdown(view, &ctx).unwrap_or_else(|| {
                md::render::plain_text(
                    trimmed.to_owned(),
                    md::render::SANS_FAMILY,
                    FontWeight::NORMAL,
                    theme.text,
                    &ctx,
                )
            })
        };
        div().w_full().min_w_0().flex().flex_col().child(body)
    }

    /// The final report in a bordered "Result" card — the changed-files
    /// card's chrome over the report as markdown (the answer part of the
    /// timeline, tide's dispatch-report placement). Spaced by the timeline
    /// column's own gap, nothing extra — the card is the stream's last
    /// element, not a boxed-off section.
    fn render_subagent_result(
        &self,
        item: &BackgroundWorkItem,
        report: &str,
        selection: TranscriptSelection,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        let provider_id = item.key.provider_id.clone();
        let key = subagent_timeline_key(&provider_id, "report");
        let body = {
            let palette = MarkdownPalette::from_theme(&theme);
            let metrics = self.scaled_markdown_metrics(MarkdownMetrics::BODY);
            let mut views = self.subagent_markdown.borrow_mut();
            let view = views.entry(key.clone()).or_default();
            view.set_text(report, false);
            let ctx = MarkdownCtx::new(
                format!("subagent-report-{key}"),
                &palette,
                metrics,
                selection,
            )
            .with_link_handler(self.markdown_link_handler.clone())
            .with_mermaid_handler(self.markdown_mermaid_handler.clone())
            .with_mermaid_host(self.markdown_mermaid_host.clone());
            md::render::markdown(view, &ctx).unwrap_or_else(|| {
                md::render::plain_text(
                    report.to_owned(),
                    md::render::SANS_FAMILY,
                    FontWeight::NORMAL,
                    theme.text,
                    &ctx,
                )
            })
        };
        div()
            .w_full()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .border_1()
            .border_color(theme.border)
            .rounded(px(8.0))
            .bg(theme.raised)
            .px(px(12.0))
            .py(px(8.0))
            .child(
                div()
                    .h(px(24.0))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(icon("icons/bot.svg", 14.0, tools_dim(&theme)))
                    .child(
                        div()
                            .flex_none()
                            .text_size(sp(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(tools_title(&theme))
                            .child(tr!("background.result")),
                    ),
            )
            .child(
                div()
                    .w_full()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .text_size(sp(12.5))
                    .line_height(sp(17.0))
                    .text_color(theme.text)
                    .child(body),
            )
    }
}

/// One delivered agent message as a compact annotation row — distinct from
/// the child's own narration: the return arrow, the sender's label, and
/// the one-line text. Delivery annotations, not output.
fn render_subagent_message_row(from: &str, text: &str, theme: &Theme) -> Div {
    div()
        .w_full()
        .min_w_0()
        .overflow_hidden()
        .line_height(sp(HEADER_LINE_HEIGHT))
        .flex()
        .items_center()
        .gap(px(HEADER_GAP))
        .pl(px(HEADER_PAD))
        .pr(px(HEADER_PAD))
        .child(icon(
            "icons/corner-down-right.svg",
            HEADER_ICON,
            tools_dim(theme),
        ))
        .child(
            div()
                .flex_none()
                .text_size(sp(11.0))
                .text_color(tools_dim(theme))
                .child(SharedString::from(format!("from {from}"))),
        )
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(sp(11.0))
                .text_color(tools_description(theme))
                .child(SharedString::from(text)),
        )
}

/// One tool block as a static header row — the tool-card header anatomy
/// exactly (label glyph and display name, the one-line target, trailing
/// status), with no body or disclosure: the block stream's v1 grammar.
fn render_subagent_tool_row(block: &SubagentBlock, theme: &Theme) -> Div {
    let SubagentBlock::Tool {
        name,
        target,
        status,
        duration_ms,
        ..
    } = block
    else {
        return div();
    };
    let label = label_for(name);
    let failed = *status == SubagentToolStatus::Failed;
    let running = *status == SubagentToolStatus::Running;
    let trailing = match status {
        SubagentToolStatus::Running => {
            motion::spin(icon("icons/loader-circle.svg", 12.0, tools_dim(theme)))
        }
        SubagentToolStatus::Done => icon(
            "icons/check.svg",
            12.0,
            status_color(theme, Status::Success),
        )
        .into_any_element(),
        SubagentToolStatus::Failed => {
            icon("icons/x.svg", 12.0, status_color(theme, Status::Error)).into_any_element()
        }
    };
    let mut row = div()
        .h(px(HEADER_H))
        .w_full()
        .min_w_0()
        .overflow_hidden()
        .line_height(sp(HEADER_LINE_HEIGHT))
        .flex()
        .items_center()
        .gap(px(HEADER_GAP))
        .pl(px(HEADER_PAD))
        .pr(px(HEADER_PAD))
        .rounded(px(6.0))
        .child(
            div()
                .w(px(HEADER_ICON_COL))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .child(icon(label.icon, HEADER_ICON, tools_dim(theme))),
        )
        .child(
            div()
                .flex_none()
                .max_w(px(160.0))
                .min_w_0()
                .truncate()
                .text_size(sp(HEADER_TEXT))
                .font_weight(FontWeight::MEDIUM)
                .text_color(if failed {
                    status_color(theme, Status::Error)
                } else {
                    tools_title(theme)
                })
                .child(label.display_name),
        );
    match target
        .as_deref()
        .map(str::trim)
        .filter(|target| !target.is_empty())
    {
        Some(target) => {
            row = row.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(sp(HEADER_TEXT))
                    .text_color(tools_description(theme))
                    .child(SharedString::from(target)),
            );
        }
        None => row = row.child(div().flex_1()),
    }
    if !running
        && let Some(duration) = duration_ms
    {
        row = row.child(
            div()
                .flex_none()
                .text_size(sp(10.5))
                .text_color(tools_dim(theme))
                .child(SharedString::from(subagent_tool_duration(*duration))),
        );
    }
    row.child(div().flex_none().flex().items_center().child(trailing))
}

// ── Agents tab ──────────────────────────────────────────────────────────────
//
// Tide's agents-tab anatomy as a right-panel surface: one row per dispatched
// sub-agent of the selected session — status dot (accent pulse while live,
// success when completed, danger when failed or lost), the agent's title, the
// live elapsed time or settled duration, and the first line of its output as
// a preview. A click reuses the existing per-item BackgroundWork detail
// surface.

/// The row's status dot: solid in the status color, riding the shared pulse
/// clock (half cadence — the tab can stay mounted for a whole agent run)
/// while the work is live.
fn agent_status_dot(item: &BackgroundWorkItem, theme: &Theme) -> AnyElement {
    let color = work_status_color(item.status, *theme);
    if item.status.is_live() {
        motion::pulse(Duration::from_millis(1400), move |phase| {
            let wave = ((phase * std::f32::consts::TAU).sin() + 1.0) / 2.0;
            div()
                .size(px(7.0))
                .flex_none()
                .rounded_full()
                .bg(color)
                .opacity(0.45 + 0.55 * wave)
                .into_any_element()
        })
        .every(2)
        .into_any_element()
    } else {
        div()
            .size(px(7.0))
            .flex_none()
            .rounded_full()
            .bg(color)
            .into_any_element()
    }
}

/// The preview line under an agent's title: the first non-empty line of its
/// task (the dispatch prompt), else the first line of its first narration
/// block, else the first non-empty line of the rendered output — the same
/// ANSI-stripped cache the detail surface reads, so the row never re-strips
/// raw output in a frame. `None` when the agent has said nothing yet.
fn agent_output_preview(
    registry: Option<&BackgroundWorkRegistry>,
    item: &BackgroundWorkItem,
) -> Option<String> {
    if let Some(task) = item
        .task
        .as_deref()
        .map(str::trim)
        .filter(|task| !task.is_empty())
    {
        return task
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_owned);
    }
    if let Some(narration) = item.subagent_blocks.iter().find_map(|block| {
        match block {
            SubagentBlock::Text { content, .. } => Some(content.as_str()),
            _ => None,
        }
        .map(str::trim)
        .filter(|content| !content.is_empty())
    }) {
        return narration
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_owned);
    }
    registry?
        .rendered_output
        .get(&item.key)?
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

impl Tide {
    /// The Agents tab's body: the selected session's sub-agents as click-to-
    /// detail rows, or the empty state when none were dispatched.
    pub(super) fn render_right_panel_agents(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::current(cx);
        let session_id = self.state.selected_session;
        let registry = session_id.and_then(|session_id| self.background_work.get(&session_id));
        let agents = self.selected_session_agents();
        if agents.is_empty() {
            return self
                .render_right_panel_empty_message(
                    tr!("right_panel.agents_empty"),
                    tr!("right_panel.agents_empty_description"),
                    cx,
                )
                .into_any_element();
        }
        let agent_count = agents.len();

        let mut list = div().flex().flex_col().py(px(6.0));
        for item in agents {
            let key = item.key.clone();
            let row = div()
                .id(SharedString::from(format!(
                    "right-panel-agent-{}",
                    item.key.provider_id
                )))
                .mx(px(8.0))
                .my(px(1.0))
                .px(px(8.0))
                .min_h(px(44.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .gap(px(9.0))
                .cursor_default()
                .hover(|element| element.bg(theme.overlay))
                .child(agent_status_dot(&item, &theme))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(sp(12.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_secondary)
                                .child(single_line_label(&item.title)),
                        )
                        .when_some(agent_output_preview(registry, &item), |column, preview| {
                            column.child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(sp(11.0))
                                    .text_color(theme.text_tertiary)
                                    .child(SharedString::from(preview)),
                            )
                        }),
                )
                .child(
                    div()
                        .flex_none()
                        .text_size(sp(10.5))
                        .text_color(theme.text_tertiary)
                        .child(work_elapsed(&item)),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(session_id) = session_id {
                        this.open_background_work_surface(session_id, key.clone(), cx);
                    }
                }));
            list = list.child(row);
        }

        div()
            .id("right-panel-agents")
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(42.0))
                    .flex_none()
                    .px(px(16.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .border_b_1()
                    .border_color(theme.border)
                    .child(icon("icons/bot.svg", 13.0, theme.text_tertiary))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_size(sp(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text_secondary)
                            .child(tr!("right_panel.agents")),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(sp(11.0))
                            .text_color(theme.text_tertiary)
                            .child(SharedString::from(agent_count.to_string())),
                    ),
            )
            .child(
                div()
                    .id("right-panel-agents-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(list),
            )
            .into_any_element()
    }
}

fn background_work_count_summary(processes: usize, agents: usize) -> String {
    let mut parts = Vec::new();
    if processes > 0 {
        parts.push(if processes == 1 {
            tr!("background.process_count_one")
        } else {
            tr!("background.process_count", count = processes)
        });
    }
    if agents > 0 {
        parts.push(if agents == 1 {
            tr!("background.agent_count_one")
        } else {
            tr!("background.agent_count", count = agents)
        });
    }
    parts.join(" · ")
}

fn render_background_summary_card(
    handle: &ContextMenuHandle,
    session_id: Uuid,
    identifiers: Option<TaskIdentifierSection>,
    environment: Option<EnvironmentSummary>,
    entries: Rc<Vec<BackgroundSummaryEntry>>,
    weak: WeakEntity<Tide>,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::current(cx);
    let processes = entries
        .iter()
        .filter(|entry| entry.item.key.kind != BackgroundWorkKind::Subagent)
        .cloned()
        .collect::<Vec<_>>();
    let agents = entries
        .iter()
        .filter(|entry| entry.item.key.kind == BackgroundWorkKind::Subagent)
        .cloned()
        .collect::<Vec<_>>();
    let mut content = div()
        .id("background-summary-scroll")
        .max_h(px(420.0))
        .overflow_y_scroll()
        .p(px(8.0))
        .flex()
        .flex_col()
        .gap(px(8.0));
    let has_environment = environment.is_some();
    let has_background = !processes.is_empty() || !agents.is_empty();
    let has_identifiers = identifiers.is_some();
    if let Some(environment) = environment {
        content = content.child(render_environment_summary_section(
            environment,
            handle.clone(),
            weak.clone(),
            &theme,
        ));
    }
    if has_environment && has_background {
        content = content.child(div().mx(px(8.0)).h(px(1.0)).bg(theme.border));
    }
    if !processes.is_empty() {
        content = content.child(render_background_summary_section(
            tr!("background.processes"),
            processes,
            session_id,
            handle.clone(),
            weak.clone(),
            &theme,
        ));
    }
    if !agents.is_empty() {
        content = content.child(render_background_summary_section(
            tr!("background.agents"),
            agents,
            session_id,
            handle.clone(),
            weak.clone(),
            &theme,
        ));
    }
    if has_identifiers && (has_environment || has_background) {
        content = content.child(div().mx(px(8.0)).h(px(1.0)).bg(theme.border));
    }
    if let Some(identifiers) = identifiers {
        content = content.child(render_task_identifiers_section(identifiers, weak, &theme));
    }
    div()
        .id("background-summary-card")
        .track_focus(handle.focus_handle())
        .w(px(300.0))
        .rounded(px(12.0))
        .border_1()
        .border_color(theme.border_strong)
        .overflow_hidden()
        .bg(theme.raised)
        .shadow_lg()
        .child(content)
        .into_any_element()
}

fn render_task_identifiers_section(
    section: TaskIdentifierSection,
    weak: WeakEntity<Tide>,
    theme: &Theme,
) -> Div {
    let mut rows = vec![render_task_identifier_row(
        tr!("environment.task_id"),
        section.values.task_id.to_string(),
        TASK_ID_COPY_CONTROL_ID,
        &section.task_id_copy_focus,
        section.task_id_copied,
        weak.clone(),
        theme,
    )];
    if let Some(thread_id) = section.values.agent_cli_thread_id {
        rows.push(render_task_identifier_row(
            tr!("environment.agent_cli_thread_id"),
            thread_id,
            AGENT_THREAD_ID_COPY_CONTROL_ID,
            &section.agent_cli_thread_id_copy_focus,
            section.agent_cli_thread_id_copied,
            weak,
            theme,
        ));
    }

    div()
        .w_full()
        .tab_group()
        .tab_stop(false)
        .flex()
        .flex_col()
        .gap(px(7.0))
        .children(rows)
}

#[allow(clippy::too_many_arguments)]
fn render_task_identifier_row(
    label: String,
    value: String,
    control_id: &'static str,
    focus: &FocusHandle,
    copied: bool,
    weak: WeakEntity<Tide>,
    theme: &Theme,
) -> Div {
    let tooltip = Tooltip::text(if copied {
        tr!("common.copied")
    } else {
        tr!("common.copy_named", name = label.clone())
    });
    let copy_value = value.clone();
    let copy_action = Rc::new(move |cx: &mut App| {
        cx.write_to_clipboard(ClipboardItem::new_string(copy_value.clone()));
        let _ = weak.update(cx, |this, cx| {
            this.show_control_copied(control_id, cx);
        });
    });
    let key_copy_action = copy_action.clone();
    let copy_button = div()
        .id(control_id)
        .track_focus(focus)
        .tab_index(0)
        .size(px(24.0))
        .rounded(px(6.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .cursor_default()
        .focus_visible(|style| {
            style
                .bg(theme.overlay)
                .border_1()
                .border_color(theme.accent)
        })
        .hover(|style| style.bg(theme.overlay_strong))
        .active(|style| style.bg(theme.overlay))
        .tooltip(tooltip)
        .child(icon(
            if copied {
                "icons/check.svg"
            } else {
                "icons/copy.svg"
            },
            12.0,
            theme.text_tertiary,
        ))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, _, cx| {
            copy_action(cx);
            cx.stop_propagation();
        })
        .on_key_down(move |event: &KeyDownEvent, _, cx| {
            if !event.keystroke.modifiers.modified()
                && matches!(event.keystroke.key.as_str(), "enter" | "space")
            {
                key_copy_action(cx);
                cx.stop_propagation();
            }
        });

    div()
        .w_full()
        .px(px(8.0))
        .flex()
        .flex_col()
        .child(
            div()
                .h(px(24.0))
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(sp(12.0))
                        .text_color(theme.text_tertiary)
                        .child(label),
                )
                .child(copy_button),
        )
        .child(
            div()
                .min_w_0()
                .whitespace_normal()
                .text_size(sp(11.5))
                .font_family(md::render::MONO_FAMILY)
                .text_color(theme.text_secondary)
                .child(value),
        )
}

fn render_environment_summary_section(
    environment: EnvironmentSummary,
    handle: ContextMenuHandle,
    weak: WeakEntity<Tide>,
    theme: &Theme,
) -> Div {
    let commit_handle = handle.clone();
    let commit_weak = weak.clone();
    let commit_pending = environment.commit_status.is_some();
    let commit = render_environment_action_row(
        "environment-summary-commit",
        &environment.commit_focus,
        "icons/git-commit-horizontal.svg",
        environment
            .commit_status
            .unwrap_or_else(|| tr!("environment.commit_or_push")),
        !commit_pending,
        commit_pending,
        None,
        theme,
        move |window, cx| {
            commit_handle.close(window, cx);
            window.refresh();
            let _ = commit_weak.update(cx, |this, cx| {
                this.open_commit_dialog(window, cx);
            });
        },
    );

    div()
        .w_full()
        .flex()
        .flex_col()
        .gap_0()
        .child(
            div()
                .h(px(30.0))
                .px(px(8.0))
                .flex()
                .items_center()
                .text_size(sp(13.5))
                .text_color(theme.text_tertiary)
                .child(tr!("environment.title")),
        )
        .child(commit)
}

fn render_environment_action_row(
    id: &'static str,
    focus: &FocusHandle,
    icon_path: &'static str,
    label: String,
    enabled: bool,
    active: bool,
    trailing: Option<AnyElement>,
    theme: &Theme,
    action: impl Fn(&mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let foreground = if enabled {
        theme.text
    } else if active {
        theme.text_secondary
    } else {
        theme.text_ghost
    };
    let icon_foreground = if enabled || active {
        theme.text_secondary
    } else {
        theme.text_ghost
    };
    let indicator = if active {
        motion::spin_slow(icon("icons/loader-circle.svg", 14.0, theme.text_secondary))
    } else {
        icon(icon_path, 14.0, icon_foreground).into_any_element()
    };
    let action: Rc<dyn Fn(&mut Window, &mut App)> = Rc::new(action);
    let key_action = action.clone();
    div()
        .id(id)
        .track_focus(focus)
        .when(enabled, |row| row.tab_index(0))
        .min_h(px(32.0))
        .w_full()
        .px(px(8.0))
        .rounded(px(8.0))
        .flex()
        .items_center()
        .gap(px(10.0))
        .cursor_default()
        .focus_visible(|style| style.border_1().border_color(theme.accent))
        .when(enabled, |row| {
            row.hover(|style| style.bg(theme.overlay_strong))
        })
        .child(indicator)
        .child(
            div()
                .min_w_0()
                .flex_1()
                .truncate()
                .text_size(sp(13.5))
                .text_color(foreground)
                .child(label),
        )
        .children(trailing)
        .when(enabled, |row| {
            row.on_click(move |_, window, cx| action(window, cx))
                .on_key_down(move |event: &KeyDownEvent, window, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        key_action(window, cx);
                        cx.stop_propagation();
                    }
                })
        })
}

fn render_background_summary_section(
    label: String,
    entries: Vec<BackgroundSummaryEntry>,
    session_id: Uuid,
    handle: ContextMenuHandle,
    weak: WeakEntity<Tide>,
    theme: &Theme,
) -> Div {
    let mut rows = div().w_full().flex().flex_col().gap(px(2.0));
    for entry in entries {
        rows = rows.child(render_background_summary_row(
            entry,
            session_id,
            handle.clone(),
            weak.clone(),
            theme,
        ));
    }
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(5.0))
        .child(
            div()
                .px(px(8.0))
                .text_size(sp(13.0))
                .text_color(theme.text_tertiary)
                .child(label),
        )
        .child(rows)
}

fn render_background_summary_row(
    entry: BackgroundSummaryEntry,
    session_id: Uuid,
    handle: ContextMenuHandle,
    weak: WeakEntity<Tide>,
    theme: &Theme,
) -> Stateful<Div> {
    let item = entry.item;
    let group_name = SharedString::from(format!(
        "background-summary-group-{}-{}",
        item.key.provider_id, item.key.kind as u8
    ));
    let status = background_summary_process_status_icon(item.key.kind, item.status).map(|_| {
        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .when(item.status.is_stoppable() && item.can_stop, |status| {
                status.group_hover(group_name.clone(), |style| style.invisible())
            })
            .child(rendered_work_status_icon(
                item.status,
                12.0,
                work_status_color(item.status, *theme),
            ))
    });
    let stop = (item.status.is_stoppable() && item.can_stop).then(|| {
        let click_key = item.key.clone();
        let click_weak = weak.clone();
        let key_key = item.key.clone();
        let key_weak = weak.clone();
        div()
            .id(SharedString::from(format!(
                "background-summary-stop-{}-{}",
                item.key.provider_id, item.key.kind as u8
            )))
            .track_focus(&entry.stop_focus)
            .tab_index(0)
            .size(px(24.0))
            .rounded(px(6.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .opacity(0.0)
            .group_hover(group_name.clone(), |style| style.opacity(1.0))
            .hover(|style| style.bg(theme.overlay_strong))
            .focus_visible(|style| {
                style
                    .opacity(1.0)
                    .bg(theme.raised)
                    .border_1()
                    .border_color(theme.accent)
            })
            .tooltip(Tooltip::text(tr!("background.stop")))
            .child(icon("icons/stop-filled.svg", 12.0, theme.text_tertiary))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(move |_, _, cx| {
                cx.stop_propagation();
                let _ = click_weak.update(cx, |this, cx| {
                    this.stop_background_work(session_id, click_key.clone(), cx);
                });
            })
            .on_key_down(move |event: &KeyDownEvent, _, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    let _ = key_weak.update(cx, |this, cx| {
                        this.stop_background_work(session_id, key_key.clone(), cx);
                    });
                    cx.stop_propagation();
                }
            })
    });
    let trailing = (status.is_some() || stop.is_some()).then(|| {
        div()
            .relative()
            .size(px(24.0))
            .flex_none()
            .children(status)
            .children(stop)
    });
    let is_process = item.key.kind != BackgroundWorkKind::Subagent;
    let open_key = item.key.clone();
    let key_key = open_key.clone();
    let click_handle = handle.clone();
    let click_weak = weak.clone();
    let key_handle = handle;
    let key_weak = weak;
    div()
        .id(SharedString::from(format!(
            "background-summary-row-{}-{}",
            item.key.provider_id, item.key.kind as u8
        )))
        .group(group_name)
        .track_focus(&entry.row_focus)
        .tab_index(0)
        .h(px(32.0))
        .w_full()
        .px(px(8.0))
        .rounded(px(8.0))
        .flex()
        .items_center()
        .gap(px(9.0))
        .cursor_default()
        .focus_visible(|style| style.border_1().border_color(theme.accent))
        .hover(|style| style.bg(theme.overlay_strong))
        .child(icon(
            work_kind_icon(item.key.kind),
            14.0,
            theme.text_secondary,
        ))
        .child(
            div()
                .min_w_0()
                .flex_1()
                .truncate()
                .text_size(px(if is_process { 12.5 } else { 13.5 }))
                .text_color(if is_process {
                    theme.text_secondary
                } else {
                    theme.text
                })
                .child(single_line_label(&item.title)),
        )
        .children(trailing)
        .on_click(move |_, window, cx| {
            click_handle.close(window, cx);
            window.refresh();
            let _ = click_weak.update(cx, |this, cx| {
                this.open_background_work_surface(session_id, open_key.clone(), cx);
            });
        })
        .on_key_down(move |event: &KeyDownEvent, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                key_handle.close(window, cx);
                window.refresh();
                let _ = key_weak.update(cx, |this, cx| {
                    this.open_background_work_surface(session_id, key_key.clone(), cx);
                });
                cx.stop_propagation();
            }
        })
}

/// The composer badge's running-job count. `None` hides the indicator
/// entirely — at zero live jobs there is no control, not an empty one.
fn composer_jobs_badge_count((processes, agents): (usize, usize)) -> Option<usize> {
    let total = processes + agents;
    (total > 0).then_some(total)
}

/// The kind half of a popup row's second line ("process · running").
fn composer_jobs_kind_label(kind: BackgroundWorkKind) -> String {
    match kind {
        BackgroundWorkKind::Process => tr!("background.process"),
        BackgroundWorkKind::Subagent => tr!("background.subagent"),
    }
}

/// A settled row's dimmed glyph: check for a clean finish, x for a broken
/// or lost job, the stop glyph for a stopped one. Live rows show the
/// static accent dot instead (see [`Tide::render_composer_jobs_indicator`]).
fn composer_jobs_settled_glyph(status: BackgroundWorkStatus, theme: &Theme) -> AnyElement {
    let icon = icon(work_status_icon(status), 12.0, theme.text_tertiary);
    if matches!(status, BackgroundWorkStatus::Completed) {
        // The mockup's dimmed check: the one settled glyph that reads as
        // "done" at a glance.
        icon.text_color(theme.success.opacity(0.55))
            .into_any_element()
    } else {
        icon.into_any_element()
    }
}

impl Tide {
    /// Whether the composer's jobs popup is showing: the pointer is inside
    /// the indicator or the popup itself, or the keyboard pinned it open.
    /// The header pill beside the session title: `[spinner] Background Jobs
    /// [live] [chevron]`. The spinner shows only while jobs are in progress;
    /// the chevron mirrors the popover; click toggles it, hover shows the
    /// progress tooltip. Hidden entirely when the session has no background
    /// work.
    pub(super) fn composer_jobs_popup_open(&self) -> bool {
        self.composer_jobs_popup_hovered || self.composer_jobs_popup_pinned
    }

    pub(super) fn set_composer_jobs_popup_hovered(
        &mut self,
        hovered: bool,
        cx: &mut Context<Self>,
    ) {
        if self.composer_jobs_popup_hovered != hovered {
            self.composer_jobs_popup_hovered = hovered;
            cx.notify();
        }
    }

    pub(super) fn toggle_composer_jobs_popup_pinned(&mut self, cx: &mut Context<Self>) {
        self.composer_jobs_popup_pinned = !self.composer_jobs_popup_pinned;
        cx.notify();
    }

    fn close_composer_jobs_popup(&mut self, cx: &mut Context<Self>) {
        if self.composer_jobs_popup_pinned || self.composer_jobs_popup_hovered {
            self.composer_jobs_popup_pinned = false;
            self.composer_jobs_popup_hovered = false;
            cx.notify();
        }
    }

    pub(super) fn render_header_jobs_pill(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let empty = div();
        let Some(session_id) = self.state.selected_session else {
            return empty.into_any_element();
        };
        // The pill mirrors the session's own registry — the same rows the
        // composer jobs popup lists, live first, then the settled tail. The
        // daemon-side job registry is another process; these items are the
        // app's event-fed mirror of it.
        let (live, settled) = self
            .background_work
            .get(&session_id)
            .map(BackgroundWorkRegistry::jobs_popup_rows)
            .unwrap_or_default();
        if live.is_empty() && settled.is_empty() {
            return empty.into_any_element();
        }
        let running =
            composer_jobs_badge_count(self.background_work_counts(session_id)).unwrap_or_default();
        let theme = Theme::current(cx);
        let open = self
            .menu_handle_with(HEADER_JOBS_MENU_ID, cx, |_, _, _| {})
            .is_open();

        let handle = self.menu_handle_with(HEADER_JOBS_MENU_ID, cx, |_, _, _| {});
        let weak = cx.entity().downgrade();
        let trigger = div()
            .id("header-jobs-pill")
            .flex_none()
            .h(px(26.0))
            .px(px(9.0))
            .rounded_full()
            .border_1()
            .border_color(theme.border)
            .bg(theme.surface)
            .flex()
            .items_center()
            .gap(px(6.0))
            .cursor_default()
            .text_size(sp(11.5))
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.text_secondary)
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .when(!live.is_empty(), |pill| {
                pill.child(motion::spin(icon(
                    "icons/loader-circle.svg",
                    12.0,
                    theme.text_secondary,
                )))
            })
            .child(tr!("background.jobs.label"))
            .child(
                div()
                    .text_color(theme.text)
                    .child(SharedString::from(running.to_string())),
            )
            .child(icon(
                if open {
                    "icons/chevron-up.svg"
                } else {
                    "icons/chevron-down.svg"
                },
                12.0,
                theme.text_tertiary,
            ))
            .tooltip(Tooltip::text(tr!(
                "background.jobs.tooltip",
                in_progress = live.len(),
                finished = settled.len()
            )))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    toggle_popover(
                        &this.menu_handle_with(HEADER_JOBS_MENU_ID, cx, |_, _, _| {}),
                        MenuAlign::BelowRight,
                        window,
                        cx,
                    );
                }
            }));

        let content_session = session_id;
        popover(trigger, &handle, MenuAlign::BelowRight, move |_, _, cx| {
            render_header_jobs_popup_card(
                content_session,
                live.clone(),
                settled.clone(),
                weak.clone(),
                cx,
            )
        })
        .into_any_element()
    }

    /// The composer toolbar's background-jobs indicator (stage 6): a 26×26
    /// hover target holding a 17px accent pill with the selected session's
    /// running-job count — badge only, no icon, no spinner; the number is
    /// the state. Hover previews the jobs popup, click (or Enter/Space)
    /// pins it; nothing renders at zero live jobs. Re-renders ride the
    /// existing `background_changed` notifies and the background tick, so
    /// the indicator adds no timer of its own.
    pub(super) fn render_composer_jobs_indicator(
        &self,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let empty = div();
        let Some(session_id) = self.state.selected_session else {
            return empty.into_any_element();
        };
        let Some(registry) = self.background_work.get(&session_id) else {
            return empty.into_any_element();
        };
        let (live, settled) = registry.jobs_popup_rows();
        if live.is_empty() {
            return empty.into_any_element();
        }
        let running =
            composer_jobs_badge_count(self.background_work_counts(session_id)).unwrap_or_default();
        let theme = Theme::current(cx);
        let weak = cx.entity().downgrade();
        // The badge paints the anchor's bounds into the cell each frame, so
        // the popup can dock under it one frame later — the autocomplete
        // card's probe pattern.
        let badge_bounds: Rc<Cell<Option<Bounds<Pixels>>>> = Rc::new(Cell::new(None));
        let probe_bounds = badge_bounds.clone();

        let count = SharedString::from(running.to_string());
        let trigger = div()
            .id("composer-jobs-indicator")
            .size(px(26.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .cursor_default()
            .when(self.composer_jobs_popup_open(), |element| {
                element.bg(theme.overlay_strong)
            })
            .hover(|style| style.bg(theme.overlay))
            // Hover previews, click pins: the popup model the background
            // refresh tick already understands.
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.set_composer_jobs_popup_hovered(*hovered, cx);
            }))
            .on_click(cx.listener(|this, _, _, cx| {
                cx.stop_propagation();
                this.toggle_composer_jobs_popup_pinned(cx);
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    this.toggle_composer_jobs_popup_pinned(cx);
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .min_w(px(17.0))
                    .h(px(17.0))
                    .px(px(5.0))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(theme.accent)
                    .text_size(px(10.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.canvas)
                    .child(count),
            )
            .child(
                canvas(
                    move |bounds: Bounds<Pixels>, _, _| probe_bounds.set(Some(bounds)),
                    |_, _, _, _| (),
                )
                .absolute()
                .size_full(),
            );

        if !self.composer_jobs_popup_open() {
            return trigger.into_any_element();
        }

        let popup_session = session_id;
        div()
            .relative()
            .flex_none()
            .child(trigger)
            .child(
                deferred(
                    anchored()
                        .position(point(
                            badge_bounds
                                .get()
                                .map(|bounds| bounds.origin.x)
                                .unwrap_or_default(),
                            badge_bounds
                                .get()
                                .map(|bounds| bounds.origin.y)
                                .unwrap_or_default(),
                        ))
                        .anchor(Anchor::TopLeft)
                        .snap_to_window_with_margin(px(8.0))
                        .child(
                            div()
                                .id("composer-jobs-popup-bridge")
                                .occlude()
                                .w(px(COMPOSER_JOBS_POPUP_WIDTH))
                                .pt(px(6.0))
                                // Bridging hover: entering the popup keeps it
                                // open before the badge's own hover-out lands.
                                .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                    this.set_composer_jobs_popup_hovered(*hovered, cx);
                                }))
                                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                                    this.close_composer_jobs_popup(cx);
                                }))
                                .child(render_header_jobs_popup_card(
                                    popup_session,
                                    live,
                                    settled,
                                    weak,
                                    cx,
                                )),
                        ),
                )
                .with_priority(1),
            )
            .into_any_element()
    }
    /// One popup row: status glyph left, title block center, elapsed
    /// right, and a hover-revealed stop button for live stoppable jobs.
    fn render_header_jobs_popup_row(
        item: &BackgroundWorkItem,
        session_id: Uuid,
        dimmed: bool,
        weak: &WeakEntity<Tide>,
        cx: &mut App,
    ) -> Stateful<Div> {
        let theme = Theme::current(cx);
        let group_name = SharedString::from(format!(
            "composer-jobs-row-{}-{}",
            item.key.kind as u8, item.key.provider_id
        ));
        let live = item.status.is_live();
        let stoppable = live && item.status.is_stoppable() && item.can_stop;
        // The live dot is a plain rounded div — static, no spinner.
        let live_dot = div().size(px(8.0)).rounded_full().bg(theme.accent);
        let glyph = if live {
            live_dot.flex_none().into_any_element()
        } else {
            composer_jobs_settled_glyph(item.status, &theme)
        };
        let click_key = item.key.clone();
        let key_key = item.key.clone();
        div()
            .id(SharedString::from(format!(
                "composer-jobs-row-{}-{}",
                item.key.kind as u8, item.key.provider_id
            )))
            .group(group_name.clone())
            .w_full()
            .h(px(44.0))
            .px(px(9.0))
            .rounded(px(7.0))
            .flex()
            .items_center()
            .gap(px(9.0))
            .cursor_default()
            .when(dimmed, |row| row.opacity(0.55))
            .hover(|style| style.bg(theme.overlay))
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .child(
                div()
                    .w(px(14.0))
                    .h(px(14.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(glyph),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(1.0))
                    .child(
                        div()
                            .flex()
                            .items_baseline()
                            .gap(px(6.0))
                            .min_w_0()
                            .child(
                                div()
                                    .font_family(md::render::MONO_FAMILY)
                                    .text_size(px(11.0))
                                    .text_color(theme.text_secondary)
                                    .flex_none()
                                    .child(item.key.provider_id.clone()),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(12.5))
                                    .text_color(theme.text)
                                    .child(single_line_label(&item.title)),
                            ),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(11.0))
                            .text_color(theme.text_tertiary)
                            .child(format!(
                                "{} · {}",
                                composer_jobs_kind_label(item.key.kind),
                                work_status_label(item.status)
                            )),
                    ),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(px(11.0))
                    .text_color(theme.text_tertiary)
                    .child(work_elapsed(item)),
            )
            .when(stoppable, |row| {
                row.child(
                    div()
                        .id(SharedString::from(format!(
                            "composer-jobs-stop-{}-{}",
                            item.key.kind as u8, item.key.provider_id
                        )))
                        .size(px(22.0))
                        .rounded(px(6.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_default()
                        .opacity(0.0)
                        .group_hover(group_name, |style| style.opacity(1.0))
                        .hover(|style| style.bg(theme.danger.opacity(0.10)))
                        .focus_visible(|style| {
                            style.opacity(1.0).border_1().border_color(theme.accent)
                        })
                        .tab_index(0)
                        .tooltip(Tooltip::text(tr!("background.stop")))
                        .child(icon("icons/stop-filled.svg", 10.0, theme.text_secondary))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click({
                            let click_weak = weak.clone();
                            move |_, _, cx| {
                                cx.stop_propagation();
                                let _ = click_weak.update(cx, |this, cx| {
                                    this.stop_background_work(session_id, click_key.clone(), cx);
                                });
                            }
                        })
                        .on_key_down({
                            let key_weak = weak.clone();
                            move |event: &KeyDownEvent, _, cx| {
                                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                    let _ = key_weak.update(cx, |this, cx| {
                                        this.stop_background_work(session_id, key_key.clone(), cx);
                                    });
                                    cx.stop_propagation();
                                }
                            }
                        }),
                )
            })
            // Clicking a row opens that job's detail in the right panel —
            // the information-popover pattern. The stop control stops
            // propagation, so it never triggers this.
            .on_click({
                let weak = weak.clone();
                let open_key = item.key.clone();
                move |_, _, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.open_background_work_surface(
                            session_id,
                            open_key.clone(),
                            cx,
                        );
                    });
                }
            })
    }
}

/// The popover card: header with the Agents-panel link, live rows, a
/// separator, then the dimmed settled tail. Rendered from the popover
/// content closure (App context), so interactions route through a
/// `Weak<Tide>` instead of listeners.
fn render_header_jobs_popup_card(
    session_id: Uuid,
    live: Vec<BackgroundWorkItem>,
    settled: Vec<BackgroundWorkItem>,
    weak: WeakEntity<Tide>,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::current(cx);
    let mut rows = div().w_full().flex().flex_col();
    for item in &live {
        rows = rows.child(Tide::render_header_jobs_popup_row(
            item, session_id, false, &weak, cx,
        ));
    }
    if !live.is_empty() && !settled.is_empty() {
        rows = rows.child(
            div()
                .h(px(1.0))
                .mx(px(7.0))
                .my(px(4.0))
                .flex_none()
                .bg(theme.border),
        );
    }
    for item in &settled {
        rows = rows.child(Tide::render_header_jobs_popup_row(
            item, session_id, true, &weak, cx,
        ));
    }
    let agents_label = SharedString::from(format!("{} →", tr!("right_panel.agents")));
    let agents_weak = weak.clone();
    div()
        .id("header-jobs-popup")
        .w(px(COMPOSER_JOBS_POPUP_WIDTH))
        .child(
            div()
                .id("header-jobs-popup-surface")
                .w_full()
                .rounded(px(10.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.raised)
                .shadow_lg()
                .p(px(5.0))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(|_, _, cx| cx.stop_propagation())
                .child(
                    div()
                        .id("header-jobs-agents-link")
                        .flex()
                        .items_center()
                        .justify_between()
                        .px(px(9.0))
                        .pt(px(6.0))
                        .pb(px(7.0))
                        .text_size(px(11.0))
                        .text_color(theme.text_tertiary)
                        .child(
                            div()
                                .text_size(px(11.0))
                                .child(tr!("background.jobs.title").to_uppercase()),
                        )
                        .child(
                            div()
                                .text_size(px(11.5))
                                .text_color(theme.accent)
                                .hover(|style| style.opacity(0.85))
                                .child(agents_label),
                        )
                        .tab_index(0)
                        .focus_visible(|style| style.border_1().border_color(theme.accent))
                        .on_click(move |_, _, cx| {
                            let _ = agents_weak.update(cx, |this, cx| {
                                this.open_right_panel_surface(RightPanelSurface::Agents, cx);
                            });
                        }),
                )
                .child(rows)
                .when(live.is_empty() && settled.is_empty(), |popup| {
                    popup.child(
                        div()
                            .px(px(9.0))
                            .pb(px(6.0))
                            .text_size(px(11.5))
                            .text_color(theme.text_tertiary),
                    )
                }),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subagent_upsert(child_id: &str, title: &str, status: BackgroundWorkStatus) -> SubagentRun {
        SubagentRun {
            child_id: child_id.to_owned(),
            agent_name: "code-reviewer".to_owned(),
            title: title.to_owned(),
            task: Some("review the diff".to_owned()),
            blocks: Vec::new(),
            report: None,
            status,
            duration_ms: Some(1200),
            origin_activity_id: Some("call-1".to_owned()),
        }
    }

    #[test]
    fn subagent_run_upsert_merges_snapshots_into_the_upserted_run() {
        let mut runs = vec![subagent_upsert(
            "child-1",
            "Review auth",
            BackgroundWorkStatus::Running,
        )];
        // A block snapshot arrives without identity fields: blocks refresh,
        // the stored status/report survive.
        upsert_subagent_run(
            &mut runs,
            SubagentRun {
                child_id: "child-1".to_owned(),
                agent_name: String::new(),
                title: String::new(),
                task: None,
                blocks: vec![SubagentBlock::Text {
                    content: "scanning".to_owned(),
                    streaming: false,
                }],
                report: None,
                status: BackgroundWorkStatus::Running,
                duration_ms: None,
                origin_activity_id: None,
            },
        );
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].blocks.len(), 1);
        assert_eq!(runs[0].title, "Review auth");
        // The settled upsert is authoritative: status and report land.
        let mut settled =
            subagent_upsert("child-1", "Review auth", BackgroundWorkStatus::Completed);
        settled.report = Some("looks fine".to_owned());
        upsert_subagent_run(&mut runs, settled);
        assert_eq!(runs[0].status, BackgroundWorkStatus::Completed);
        assert_eq!(runs[0].report.as_deref(), Some("looks fine"));
        // An identity-less snapshot for an unknown id appends nothing.
        upsert_subagent_run(
            &mut runs,
            SubagentRun {
                child_id: "ghost".to_owned(),
                agent_name: String::new(),
                title: String::new(),
                task: None,
                blocks: Vec::new(),
                report: None,
                status: BackgroundWorkStatus::Completed,
                duration_ms: None,
                origin_activity_id: None,
            },
        );
        assert_eq!(runs.len(), 1);
    }

    #[test]
    fn registry_rehydrates_settled_subagent_items() {
        let mut registry = BackgroundWorkRegistry::default();
        let mut run = subagent_upsert("child-1", "Review auth", BackgroundWorkStatus::Completed);
        run.blocks = vec![SubagentBlock::Text {
            content: "scanned 3 files".to_owned(),
            streaming: false,
        }];
        run.report = Some("looks fine".to_owned());
        registry.rehydrate_subagent_runs(&[run]);
        let listed = registry
            .subagent_items()
            .into_iter()
            .map(|item| (item.key.provider_id.clone(), item.status))
            .collect::<Vec<_>>();
        assert_eq!(
            listed,
            vec![("child-1".to_owned(), BackgroundWorkStatus::Completed)]
        );
    }

    fn item(id: &str, status: BackgroundWorkStatus, background: bool) -> BackgroundWorkItem {
        let mut item = BackgroundWorkItem::new(
            BackgroundWorkKind::Process,
            id,
            format!("process {id}"),
            status,
        );
        item.background = background;
        item
    }

    #[test]
    fn composer_badge_hides_at_zero_live_and_matches_the_running_count() {
        // Zero live jobs: no badge at all — not an empty control.
        assert_eq!(composer_jobs_badge_count((0, 0)), None);
        // The count is the running-job total across both kinds, exactly
        // what `background_work_counts` reports for the session.
        assert_eq!(composer_jobs_badge_count((2, 0)), Some(2));
        assert_eq!(composer_jobs_badge_count((0, 1)), Some(1));
        assert_eq!(composer_jobs_badge_count((3, 2)), Some(5));
    }

    #[test]
    fn jobs_popup_rows_list_the_live_jobs_then_the_dimmed_settled_tail() {
        let mut registry = BackgroundWorkRegistry::default();
        registry.upsert(item("live-1", BackgroundWorkStatus::Running, true));
        registry.upsert(item("done-1", BackgroundWorkStatus::Completed, true));
        registry.upsert(item("live-2", BackgroundWorkStatus::Running, true));
        registry.upsert(item("done-2", BackgroundWorkStatus::Failed, true));

        let (live, settled) = registry.jobs_popup_rows();
        let live_ids: Vec<&str> = live
            .iter()
            .map(|entry| entry.key.provider_id.as_str())
            .collect();
        let settled_ids: Vec<&str> = settled
            .iter()
            .map(|entry| entry.key.provider_id.as_str())
            .collect();
        // Newest first within each block (the registry's display order),
        // and the settled rows always trail behind the separator.
        assert_eq!(live_ids, vec!["live-2", "live-1"]);
        assert_eq!(settled_ids, vec!["done-2", "done-1"]);

        // Once everything settles the live block is empty and the whole
        // popup is the dimmed tail — until the trim window ages rows out.
        registry.upsert(item("live-1", BackgroundWorkStatus::Completed, true));
        registry.upsert(item("live-2", BackgroundWorkStatus::Stopped, true));
        let (live, settled) = registry.jobs_popup_rows();
        assert!(live.is_empty());
        assert_eq!(settled.len(), 4);
    }

    #[test]
    fn jobs_popup_row_stops_route_through_the_covered_stop_path() {
        let source = include_str!("background_work.rs");
        let start = source
            .split_once("\n/// The composer badge's running-job count.")
            .expect("composer jobs indicator code")
            .1;
        let code = start
            .split_once("\n#[cfg(test)]")
            .expect("tests module end marker")
            .0;

        // The row's stop click and its keyboard twin both land on the same
        // covered `stop_background_work` path the summary card uses.
        assert!(code.contains("this.stop_background_work(session_id, click_key.clone(), cx)"));
        assert!(code.contains("this.stop_background_work(session_id, key_key.clone(), cx)"));
        // The popup header links to the Agents panel surface.
        assert!(code.contains("open_right_panel_surface(RightPanelSurface::Agents, cx)"));
        // Rows are interactive, so the popup is a pinned hover surface, not
        // a text tooltip.
        assert!(!code.contains("Tooltip::text(tr!(\"background.jobs"));
        assert!(code.contains(".on_hover(cx.listener(|this, hovered: &bool, _, cx|"));
    }

    #[test]
    fn jobs_popup_row_glyphs_split_live_from_settled() {
        // Live jobs show the static accent dot; settled ones a dimmed glyph.
        let source = include_str!("background_work.rs");
        let start = source
            .split_once("\nfn composer_jobs_settled_glyph(")
            .expect("settled glyph helper")
            .1;
        let helper = start.split_once("\nimpl Tide {").expect("impl boundary").0;
        assert!(helper.contains("theme.success.opacity(0.55)"));
        assert!(helper.contains("work_status_icon(status)"));

        let code = source
            .split_once("\n/// The composer badge's running-job count.")
            .expect("composer jobs indicator code")
            .1
            .split_once("\n#[cfg(test)]")
            .expect("tests module end marker")
            .0;
        let row = code
            .split_once("\n    /// One popup row: status glyph")
            .expect("popup row renderer")
            .1;
        // The live dot is a plain rounded div — static, no spinner.
        assert!(row.contains("div().size(px(8.0)).rounded_full().bg(theme.accent)"));
        assert!(!row.contains("motion::spin"));
    }

    #[test]
    fn info_popover_uses_distinct_process_status_icons() {
        assert_eq!(
            background_summary_process_status_icon(
                BackgroundWorkKind::Process,
                BackgroundWorkStatus::Completed,
            ),
            Some("icons/check.svg")
        );
        assert_eq!(
            background_summary_process_status_icon(
                BackgroundWorkKind::Process,
                BackgroundWorkStatus::Running,
            ),
            Some("icons/loader-circle.svg")
        );
        assert_eq!(
            background_summary_process_status_icon(
                BackgroundWorkKind::Subagent,
                BackgroundWorkStatus::Completed,
            ),
            None
        );
    }

    #[test]
    fn info_popover_background_titles_stay_on_one_line() {
        let source = include_str!("background_work.rs");
        let row = source
            .split_once("\nfn render_background_summary_row(")
            .expect("background summary row renderer")
            .1
            .split_once("\n#[cfg(test)]")
            .expect("background summary row renderer end")
            .0;

        assert!(row.contains(".truncate()"));
        assert!(row.contains(".child(single_line_label(&item.title))"));
        assert!(!row.contains(".line_clamp(1)"));
        assert_eq!(
            single_line_label("/bin/zsh -lc 'set -euo pipefail\n  for n in one two'"),
            "/bin/zsh -lc 'set -euo pipefail for n in one two'"
        );
    }

    #[test]
    fn info_popover_uses_tide_task_and_native_agent_ids() {
        let task_id = Uuid::parse_str("ed28ee51-43cf-4a83-a52f-04c509ca2c09").unwrap();
        let mut session = AgentSession::new(Uuid::nil(), ProviderKind::Tide);
        session.id = task_id;
        session.provider_cursor = Some(ProviderResumeCursor::Tide {
            session_id: "019cfd7a-6942-78b1-9d47-30576c562321".into(),
        });

        assert_eq!(
            TaskIdentifiers::from(&session),
            TaskIdentifiers {
                task_id,
                agent_cli_thread_id: Some("019cfd7a-6942-78b1-9d47-30576c562321".into()),
            }
        );
    }

    #[test]
    fn settled_foreground_commands_leave_the_registry() {
        let mut registry = BackgroundWorkRegistry::default();
        registry.upsert(item("one", BackgroundWorkStatus::Running, false));
        assert!(registry.has_live());
        registry.upsert(item("one", BackgroundWorkStatus::Completed, false));
        assert!(registry.items.is_empty());
    }

    #[test]
    fn reconciliation_marks_disappeared_background_process_lost() {
        let mut registry = BackgroundWorkRegistry::default();
        registry.upsert(item("one", BackgroundWorkStatus::Running, true));
        registry.reconcile_live(Vec::new());
        assert_eq!(
            registry.items[&BackgroundWorkKey::new(BackgroundWorkKind::Process, "one")].status,
            BackgroundWorkStatus::Lost
        );
    }

    #[test]
    fn polling_does_not_reopen_a_pending_stop() {
        let mut registry = BackgroundWorkRegistry::default();
        let key = BackgroundWorkKey::new(BackgroundWorkKind::Process, "one");
        registry.upsert(item("one", BackgroundWorkStatus::Running, true));
        registry.apply(BackgroundWorkEvent::StopRequested(key.clone()));
        registry.upsert(item("one", BackgroundWorkStatus::Running, true));
        assert_eq!(registry.items[&key].status, BackgroundWorkStatus::Stopping);
        assert!(!registry.items[&key].status.is_stoppable());
    }

    #[test]
    fn output_is_bounded_on_utf8_boundaries() {
        let mut registry = BackgroundWorkRegistry::default();
        registry.upsert(item("one", BackgroundWorkStatus::Running, true));
        registry.append_output(
            &BackgroundWorkKey::new(BackgroundWorkKind::Process, "one"),
            &"界".repeat(MAX_BACKGROUND_OUTPUT_BYTES),
        );
        let output = registry.items.values().next().unwrap();
        assert!(output.output.as_ref().unwrap().len() <= MAX_BACKGROUND_OUTPUT_BYTES);
        assert!(output.output_truncated);
    }

    #[test]
    fn subagent_threads_are_not_byte_bounded() {
        let mut registry = BackgroundWorkRegistry::default();
        registry.upsert(subagent(
            "agent-1",
            "research the seam",
            BackgroundWorkStatus::Running,
        ));
        registry.append_output(
            &BackgroundWorkKey::new(BackgroundWorkKind::Subagent, "agent-1"),
            &"界".repeat(MAX_BACKGROUND_OUTPUT_BYTES + 8),
        );
        let item = registry.items.values().next().unwrap();
        assert!(
            item.output.as_ref().unwrap().len() > MAX_BACKGROUND_OUTPUT_BYTES,
            "a sub-agent's whole thread — prompt, tools, thinking, result — stays in the log"
        );
        assert!(!item.output_truncated);
    }

    #[test]
    fn output_cache_strips_split_ansi_sequences() {
        let mut registry = BackgroundWorkRegistry::default();
        let key = BackgroundWorkKey::new(BackgroundWorkKind::Process, "one");
        registry.upsert(item("one", BackgroundWorkStatus::Running, true));
        registry.append_output(&key, "\u{1b}");
        registry.append_output(&key, "[31mred\u{1b}[0m");
        assert!(registry.refresh_output_cache());
        assert_eq!(registry.rendered_output[&key].as_ref(), "red");
    }

    #[test]
    fn output_cache_requests_a_retry_only_while_dirty() {
        let mut registry = BackgroundWorkRegistry::default();
        let key = BackgroundWorkKey::new(BackgroundWorkKind::Process, "one");
        registry.upsert(item("one", BackgroundWorkStatus::Running, true));
        registry.append_output(&key, "first");
        assert_eq!(registry.output_refresh_delay(), Some(Duration::ZERO));
        assert!(registry.refresh_output_cache());
        assert_eq!(registry.output_refresh_delay(), None);

        registry.append_output(&key, " second");
        let delay = registry
            .output_refresh_delay()
            .expect("new output should request one cache refresh");
        assert!(delay <= OUTPUT_CACHE_REFRESH_INTERVAL);
        assert!(!registry.refresh_output_cache());
    }

    #[test]
    fn unchanged_process_snapshots_do_not_rebuild_output() {
        let mut registry = BackgroundWorkRegistry::default();
        let mut process = item("one", BackgroundWorkStatus::Running, true);
        process.output = Some("same output".to_owned());
        registry.upsert(process.clone());
        assert!(registry.refresh_output_cache());

        registry.upsert(process);
        assert_eq!(registry.output_refresh_delay(), None);
    }

    #[test]
    fn turn_settlement_keeps_detached_work_live() {
        let mut registry = BackgroundWorkRegistry::default();
        registry.upsert(item("foreground", BackgroundWorkStatus::Running, false));
        registry.upsert(item("background", BackgroundWorkStatus::Running, true));
        registry.settle_foreground(BackgroundWorkStatus::Completed);
        assert!(!registry.items.contains_key(&BackgroundWorkKey::new(
            BackgroundWorkKind::Process,
            "foreground"
        )));
        assert_eq!(
            registry.items[&BackgroundWorkKey::new(BackgroundWorkKind::Process, "background")]
                .status,
            BackgroundWorkStatus::Running
        );
    }

    fn subagent(id: &str, title: &str, status: BackgroundWorkStatus) -> BackgroundWorkItem {
        let mut item = BackgroundWorkItem::new(BackgroundWorkKind::Subagent, id, title, status);
        item.background = true;
        item
    }

    #[test]
    fn subagent_blocks_replace_wholesale_and_wake_the_cache() {
        let mut registry = BackgroundWorkRegistry::default();
        registry.upsert(subagent(
            "agent-1",
            "research the seam",
            BackgroundWorkStatus::Running,
        ));
        let key = BackgroundWorkKey::new(BackgroundWorkKind::Subagent, "agent-1");
        let blocks = vec![SubagentBlock::Reasoning {
            text: "where does the stream land?".into(),
            streaming: true,
        }];
        registry.apply(BackgroundWorkEvent::SubagentBlocks {
            key: key.clone(),
            blocks: blocks.clone(),
        });
        assert_eq!(registry.items[&key].subagent_blocks, blocks);
        assert!(
            registry.output_refresh_delay().is_some(),
            "a changed timeline rides the coalesced output-cache wake"
        );

        // A duplicate snapshot is a no-op: it must not re-wake the cache.
        assert!(registry.refresh_output_cache());
        assert_eq!(registry.output_refresh_delay(), None);
        registry.apply(BackgroundWorkEvent::SubagentBlocks {
            key: key.clone(),
            blocks,
        });
        assert_eq!(registry.output_refresh_delay(), None);
    }

    #[test]
    fn subagent_upserts_merge_task_blocks_and_report() {
        let mut registry = BackgroundWorkRegistry::default();
        let mut starting = subagent("agent-2", "review the diff", BackgroundWorkStatus::Running);
        starting.task = Some("review the diff for the seam".into());
        let blocks = vec![SubagentBlock::Text {
            content: "the diff is clean".into(),
            streaming: true,
        }];
        starting.subagent_blocks = blocks.clone();
        registry.upsert(starting);

        // The completion upsert: status settles, the report replaces
        // `output`, and the block snapshot rides along intact.
        let mut done = subagent(
            "agent-2",
            "review the diff",
            BackgroundWorkStatus::Completed,
        );
        done.task = Some("review the diff for the seam".into());
        done.subagent_blocks = vec![SubagentBlock::Text {
            content: "the diff is clean".into(),
            streaming: false,
        }];
        done.output = Some("clean — ship it".into());
        registry.upsert(done);
        let item =
            &registry.items[&BackgroundWorkKey::new(BackgroundWorkKind::Subagent, "agent-2")];
        assert_eq!(item.status, BackgroundWorkStatus::Completed);
        assert_eq!(item.task.as_deref(), Some("review the diff for the seam"));
        assert_eq!(
            item.subagent_blocks,
            vec![SubagentBlock::Text {
                content: "the diff is clean".into(),
                streaming: false,
            }]
        );
        assert_eq!(item.output.as_deref(), Some("clean — ship it"));
    }

    #[test]
    fn agents_row_preview_prefers_the_task_then_narration() {
        let mut registry = BackgroundWorkRegistry::default();
        let mut item = subagent("agent-1", "research", BackgroundWorkStatus::Running);
        item.task = Some("Find the streaming seam.\nSecond line.".into());
        item.subagent_blocks = vec![SubagentBlock::Text {
            content: "found it".into(),
            streaming: false,
        }];
        // The task's first line is the preview.
        assert_eq!(
            agent_output_preview(None, &item).as_deref(),
            Some("Find the streaming seam.")
        );
        // Without a task, the first narration block's opening line is.
        item.task = None;
        assert_eq!(
            agent_output_preview(None, &item).as_deref(),
            Some("found it")
        );
        // With neither, the rendered output log stands in — pre-block items.
        item.subagent_blocks = Vec::new();
        let key = item.key.clone();
        registry.upsert(item);
        registry.append_output(&key, "legacy log line\nmore");
        assert!(registry.refresh_output_cache());
        let item = &registry.items[&key];
        assert_eq!(
            agent_output_preview(Some(&registry), item).as_deref(),
            Some("legacy log line")
        );
    }

    #[test]
    fn subagent_tool_count_label_counts_tool_blocks() {
        assert_eq!(subagent_tool_count_label(&[]), None);
        let blocks = vec![
            SubagentBlock::Reasoning {
                text: "hmm".into(),
                streaming: false,
            },
            SubagentBlock::Tool {
                id: "t".into(),
                name: "bash".into(),
                target: None,
                status: SubagentToolStatus::Running,
                duration_ms: None,
            },
        ];
        assert_eq!(
            subagent_tool_count_label(&blocks).as_deref(),
            Some("1 tool")
        );
    }

    #[test]
    fn subagent_timeline_survives_a_report_only_run() {
        // The driver pops a single final message into `output`, leaving no
        // blocks — the task bubble and Result card still render.
        let mut single = subagent("agent-1", "research", BackgroundWorkStatus::Completed);
        single.task = Some("find the seam".into());
        single.output = Some("found it".into());
        assert!(renders_subagent_timeline(&single));

        // Any block at all — intermediate narration — renders the timeline.
        single.subagent_blocks = vec![SubagentBlock::Text {
            content: "looking…".into(),
            streaming: false,
        }];
        assert!(renders_subagent_timeline(&single));

        // Old persisted items carry neither task nor blocks: they keep the
        // metadata rows and plain output log.
        let legacy = subagent("agent-0", "research", BackgroundWorkStatus::Completed);
        assert!(!renders_subagent_timeline(&legacy));

        // Never for processes.
        assert!(!renders_subagent_timeline(&item(
            "proc",
            BackgroundWorkStatus::Running,
            true
        )));
    }

    #[test]
    fn agents_tab_lists_subagents_newest_first() {
        let mut registry = BackgroundWorkRegistry::default();
        registry.upsert(subagent(
            "agent-1",
            "research the seam",
            BackgroundWorkStatus::Running,
        ));
        registry.upsert(item("proc", BackgroundWorkStatus::Running, true));
        registry.upsert(subagent(
            "agent-2",
            "review the diff",
            BackgroundWorkStatus::Completed,
        ));

        let listed: Vec<&str> = registry
            .subagent_items()
            .iter()
            .map(|item| item.key.provider_id.as_str())
            .collect();
        assert_eq!(
            listed,
            vec!["agent-2", "agent-1"],
            "the Agents tab lists sub-agents only, newest first — processes stay out"
        );
        assert_eq!(registry.subagent_count(), 2);
    }
}
