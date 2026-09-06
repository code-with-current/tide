//! The inspector column: a floating session-at-a-glance card beside the
//! transcript, ported from upstream tide's Inspector with content parity —
//! Session hero, Configuration, Git, and Stream log sections in
//! upstream's order and styling. Derived visibility — a session with
//! content, the right panel closed, a wide-enough window — with no stored
//! preference, and collapse state that lives per app run. The Context
//! Window detail moved to the footer usage meter's panel (usage_meter.rs).

use std::collections::HashSet;

use super::*;

mod section;
mod sections;

pub(crate) use sections::{
    ITERATION_MAX_STEPS, STREAM_LOG_CAP, StreamLogEntry, stream_log_entry,
};

#[cfg(test)]
mod tests;

/// Column geometry. The card consumes real layout width beside the
/// transcript — card plus its floating insets on both sides — so the chat
/// column's main content narrows rather than being overlaid.
pub(crate) const INSPECTOR_WIDTH: f32 = 320.0;
/// Air around the card on every side; this is what makes it float instead
/// of reading as an attached panel edge.
pub(crate) const INSPECTOR_GAP: f32 = 20.0;
/// The full footprint the column takes from the chat layout.
pub(crate) const INSPECTOR_TOTAL_WIDTH: f32 = INSPECTOR_WIDTH + 2.0 * INSPECTOR_GAP;
/// Below this viewport the card would crowd the transcript — hidden.
pub(crate) const INSPECTOR_MIN_VIEWPORT: f32 = 1400.0;

/// Layout width the column consumes for a given visibility, mirrored into
/// `inspector_rendered_width` each frame so the transcript's content
/// measurement stays in sync with its actual bounds.
pub(crate) fn inspector_consumed_width(shown: bool) -> f32 {
    if shown { INSPECTOR_TOTAL_WIDTH } else { 0.0 }
}

/// The floating column's three conditions: a session is selected, the right
/// panel is not occupying width, and the window is wide enough.
pub(crate) fn inspector_visible(
    has_session: bool,
    right_panel_closed: bool,
    viewport_width: f32,
) -> bool {
    has_session && right_panel_closed && viewport_width >= INSPECTOR_MIN_VIEWPORT
}

/// One collapsible section of the column, in upstream's display order.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub(crate) enum SectionId {
    Session,
    Config,
    Git,
    MemoryRag,
    StreamLog,
}

impl SectionId {
    /// Stable element id for the section's header row.
    pub(crate) fn header_id(self) -> &'static str {
        match self {
            Self::Session => "inspector-session-header",
            Self::Config => "inspector-config-header",
            Self::Git => "inspector-git-header",
            Self::MemoryRag => "inspector-memory-rag-header",
            Self::StreamLog => "inspector-stream-log-header",
        }
    }
}

/// Collapse state for the column, per app run. Every section starts
/// expanded, matching upstream's `defaultOpen` across the inspector.
#[derive(Default)]
pub(crate) struct InspectorState {
    pub(crate) collapsed: HashSet<SectionId>,
}

impl InspectorState {
    pub(crate) fn new() -> Self {
        Self {
            collapsed: HashSet::new(),
        }
    }

    pub(crate) fn is_collapsed(&self, id: SectionId) -> bool {
        self.collapsed.contains(&id)
    }

    pub(crate) fn toggle(&mut self, id: SectionId) {
        if !self.collapsed.remove(&id) {
            self.collapsed.insert(id);
        }
    }
}

impl Tide {
    /// [`TidePane`] delegate for the inspector island. The column lives in
    /// its own cached pane so pulse ticks and stream commits targeted at
    /// other views replay it instead of rebuilding ~150 elements — the
    /// playbook's redraw-rate × element-count rule; see
    /// docs/performance.md.
    pub(super) fn inspector_pane_content(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.render_inspector(cx).into_any_element()
    }

    /// The inspector column: an in-flow sibling of the transcript that
    /// consumes layout width, holding a fully-rounded floating card inset
    /// from the pane's top, right, and bottom. The card scrolls when
    /// sections outgrow it. Sized by its embedding site (the pane lays
    /// content out as a root, so the column must claim full size itself).
    pub(super) fn render_inspector(&mut self, cx: &mut Context<Self>) -> Div {
        let theme = Theme::current(cx);
        div()
            .size_full()
            .flex()
            .flex_col()
            .p(px(INSPECTOR_GAP))
            .child(self.render_inspector_card(cx, &theme))
    }

    /// The floating card itself: detached from every edge, all four corners
    /// rounded, translucent over the chat surface. Upstream separates
    /// sections with hairlines rather than gaps, so the card's own padding
    /// is only horizontal — the first and last sections' borders frame the
    /// stack.
    fn render_inspector_card(&mut self, cx: &mut Context<Self>, theme: &Theme) -> Stateful<Div> {
        div()
            .id("inspector-card")
            .occlude()
            // Content-height card: grows with its sections and caps at the
            // column, so a short session reads as a compact floating card
            // instead of a full-height pane.
            .max_h_full()
            .w_full()
            .flex()
            .flex_col()
            .rounded(px(12.0))
            .border_1()
            .border_color(theme.border_strong)
            .bg(theme.raised.opacity(0.97))
            .shadow_lg()
            .overflow_y_scroll()
            .overflow_x_hidden()
            .child(self.render_inspector_session_section(cx))
            .child(self.render_inspector_config_section(cx))
            .children(self.render_inspector_memory_rag_section(cx))
            // hide for now
            // .children(self.render_inspector_git_section(cx))
            .children(self.render_inspector_stream_log_section(cx))
    }
}
