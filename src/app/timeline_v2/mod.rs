//! The tide-anatomy transcript pane. Built in parallel with the legacy
//! transcript; the pane is chosen at one seam in `render_transcript`.

use gpui::prelude::*;
use gpui::{AnyElement, ListAlignment, ListState, StyleRefinement, canvas, div, px};

mod actions;
mod labels;
mod list;
pub(crate) mod parts;
mod permission;
mod rows;
mod search;
mod tokens;

pub(crate) use actions::TranscriptActions;
pub(crate) use labels::{ToolFamily, ToolLabel, bash_first_line, label_for, relative_display};
// `split_path_display` is the pane's tests' reach today; keeping it in the
// re-export lets them import it one `super::` away like the rest of the
// vocabulary.
#[allow(unused_imports)]
pub(crate) use labels::split_path_display;
pub(crate) use rows::{TimelineV2Row, derive_rows, rows_fingerprint};
pub(crate) use tokens::{
    Status, diff_added, diff_removed, status_color, tools_description, tools_dim, tools_rail,
    tools_title,
};

#[cfg(test)]
pub(crate) mod tests;

/// Resolve the pane flag: explicit env beats the default, which is ON in
/// every build (signed off after the parity pass). `TIDE_TIMELINE_V2=0`
/// remains the rollback to the legacy pane until it is deleted.
pub(crate) fn timeline_v2_enabled(env: Option<&str>, _debug: bool) -> bool {
    match env {
        Some(value) if value == "1" => true,
        Some(value) if value == "0" => false,
        _ => true,
    }
}

/// An open edit-and-resend editor for one user message. The input entity is
/// created on demand by the edit click (the handler owns a window), parked
/// here, and dropped when the edit resolves. `confirm_removals` is `Some`
/// exactly while the editor shows its inline resend confirmation — the
/// `(replies, tool_runs)` the resend removes, from
/// [`parts::user_bubble::edit_removals`].
pub(crate) struct EditingMessage {
    pub message_id: uuid::Uuid,
    pub input: gpui::Entity<crate::input::TextInput>,
    pub confirm_removals: Option<(usize, usize)>,
}

/// All view state the v2 pane owns. Never shared with the legacy pane.
pub(crate) struct TranscriptV2 {
    /// Expanded part ids (tool cards, reasoning blocks).
    pub disclosures: std::collections::HashSet<String>,
    /// The open edit-and-resend editor, if any. One at a time: opening a
    /// second edit replaces none — the pencil hides for other rows only via
    /// the pane's single-slot discipline (a new begin overwrites this).
    pub editing: Option<EditingMessage>,
    /// The stick-to-bottom machine's state; see [`list::FollowState`].
    pub follow: list::FollowState,
    /// The scroll-to-bottom button's last visibility answer — the legacy
    /// cell's hold: an unmeasured tail keeps the previous frame's value.
    pub jump_visible: std::cell::Cell<Option<bool>>,
    /// The virtualized list's state. `ListState` is an `Rc<RefCell<..>>`
    /// handle with no `Default`, but [`gpui::ListState::new`] needs neither
    /// window nor app — so the pane state is still constructed eagerly in
    /// `Tide::new` (mirroring `transcript_rows` there) and no lazy
    /// `Option<ListState>` is required.
    pub rows: ListState,
    /// The top-aligned twin of `rows`, rendered while `anchor` is set — the
    /// legacy pane's `anchored_transcript_rows` shape (two `ListState`s, one
    /// per alignment, kept in sync so the pane can switch between them at a
    /// send). Top alignment means row remeasurement can never invoke the
    /// bottom-aligned list's implicit tail pin and displace the sent-message
    /// anchor. Structural syncs write BOTH lists so the switch never lands
    /// on a stale item count.
    pub anchored_rows: ListState,
    /// The send-time anchor machine; `None` while the pane follows the tail
    /// through `rows`. Entering anchor mode on a send pins the turn's opening
    /// prompt at the viewport top and reserves [`list::AnchorState::end_space`]
    /// below the content; see `list::maintain_anchor`.
    pub anchor: Option<list::AnchorState>,
    /// The rows last derived from the selected session, kept so row renderers
    /// can resolve a list index without refolding the session.
    pub row_cache: Vec<TimelineV2Row>,
    /// The fingerprint `row_cache` was folded under; `None` until first fold.
    pub last_fingerprint: Option<u64>,
    /// The text epoch last seen (see [`list::text_epoch`]); `None` until
    /// first fold.
    pub last_text_epoch: Option<u64>,
    /// The stream pump's cadence mark (set by
    /// [`Tide::timeline_v2_remeasure_tail`]). The pane's render sync
    /// consumes it by running the epoch/fingerprint pass even when nothing
    /// else moved, then clears it — all list-state mutation stays in the
    /// render path, unlike the legacy pane's direct tail remeasure.
    pub remeasure_due: bool,
    /// A disclosure toggle awaiting its scroll correction; see
    /// [`list::PendingScrollAnchor`]. Set by [`Tide::toggle_disclosure`],
    /// consumed two render-sync passes later.
    pub pending_scroll_anchor: Option<list::PendingScrollAnchor>,
    /// The session whose rows the pane last folded. A mismatch at render
    /// arms the switch skeleton — the 150ms gray flash
    /// [`list::SESSION_SWITCH_SKELETON`] paints while the new session's rows
    /// land.
    pub last_session_id: Option<uuid::Uuid>,
    /// When the armed switch skeleton yields back to rows; `None` when no
    /// switch is armed. Pure-gated by [`list::skeleton_active`] against the
    /// render clock.
    pub skeleton_until: Option<std::time::Instant>,
    /// The open find bar, if any. Created by the `OpenFind` action's v2
    /// seam, dropped on close and on session switch. See
    /// [`search::SearchState`].
    pub search: Option<search::SearchState>,
    /// The nav rail's turn list, shared by `Rc` the way the legacy cache is:
    /// a frame hands the rail a pointer instead of re-extracting every
    /// turn's snippets. Rebuilt by the render sync when the v2 row
    /// fingerprint moves.
    pub navigation_turns:
        std::cell::RefCell<std::rc::Rc<Vec<crate::app::navigation_rail::TranscriptNavigationTurn>>>,
    /// The row fingerprint `navigation_turns` was built from; `None` until
    /// the first fold.
    pub navigation_turns_fingerprint: Option<u64>,
}

impl TranscriptV2 {
    /// Constructed once in `Tide::new`. Bottom-aligned like the legacy
    /// `transcript_rows` so a chat settles on its latest turn; the 2048px
    /// overdraw matches the legacy list's.
    pub(crate) fn new() -> Self {
        Self {
            disclosures: std::collections::HashSet::new(),
            editing: None,
            // The list starts bottom-aligned, so the pane starts pinned.
            follow: list::FollowState::Following,
            jump_visible: std::cell::Cell::new(None),
            rows: ListState::new(0, ListAlignment::Bottom, px(2048.0)),
            // The anchored twin, top-aligned the way the legacy pane builds
            // its own `anchored_transcript_rows` (app.rs), with the same
            // 2048px overdraw.
            anchored_rows: ListState::new(0, ListAlignment::Top, px(2048.0)),
            anchor: None,
            row_cache: Vec::new(),
            last_fingerprint: None,
            last_text_epoch: None,
            remeasure_due: false,
            pending_scroll_anchor: None,
            last_session_id: None,
            skeleton_until: None,
            search: None,
            navigation_turns: std::cell::RefCell::new(std::rc::Rc::new(Vec::new())),
            navigation_turns_fingerprint: None,
        }
    }
}

impl crate::app::Tide {
    /// The stream pump's v2-side equivalent of the legacy pane's
    /// `remeasure_transcript_tail`. Bumps nothing itself: it just marks
    /// `remeasure_due`, which the pane's render sync consumes (running the
    /// epoch/fingerprint check even when unchanged, then clearing it). The
    /// enclosing pump already notifies — the hook sits on the same
    /// `selected_changed` arm that drives the legacy remeasure — so the
    /// marked flag is guaranteed a frame.
    pub(super) fn timeline_v2_remeasure_tail(&mut self, _cx: &mut gpui::Context<Self>) {
        self.timeline_v2_state.remeasure_due = true;
    }

    /// A nav-rail tick activation: reveal the turn's opening row on the list
    /// the reader is actually browsing (the anchored twin while a turn
    /// streams). A jump above the tail releases the follow pin — the reader
    /// is navigating, not following, and the next stream tick must not yank
    /// them back down. The v2 leg of the shared rail's
    /// `scroll_to_navigation_turn` seam.
    pub(super) fn timeline_v2_scroll_to_navigation_turn(
        &mut self,
        message_id: uuid::Uuid,
        cx: &mut gpui::Context<Self>,
    ) {
        let state = &mut self.timeline_v2_state;
        let row = state
            .navigation_turns
            .borrow()
            .iter()
            .find(|turn| turn.message_id == message_id)
            .map(|turn| turn.row_index);
        let Some(row) = row else {
            return;
        };
        if row >= list::active_rows(state).item_count() {
            return;
        }
        state.follow = list::FollowState::Released;
        list::active_rows(state).scroll_to_reveal_item(row);
        cx.notify();
    }

    pub(super) fn render_timeline_v2(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> gpui::AnyElement {
        // Real handlers, all through one weak entity (the wizard's ⋯
        // pattern): view-file and view-diff resolve the tool's path in the
        // right panel (the file surface, the working-tree Review diff
        // focused on the file), and the Bot action opens the dispatched
        // agent's detail surface — or the Agents tab when the registry
        // can't name the item.
        let weak = cx.entity().downgrade();
        let view_file = std::sync::Arc::new({
            let weak = weak.clone();
            move |path: &str, _: &mut gpui::Window, cx: &mut gpui::App| {
                let Some(entity) = weak.upgrade() else {
                    return;
                };
                let path = path.to_owned();
                entity.update(cx, |this, cx| this.open_activity_file(&path, cx));
            }
        });
        let view_diff = std::sync::Arc::new({
            let weak = weak.clone();
            move |path: &str, _: &mut gpui::Window, cx: &mut gpui::App| {
                let Some(entity) = weak.upgrade() else {
                    return;
                };
                let path = path.to_owned();
                entity.update(cx, |this, cx| this.open_activity_diff(&path, cx));
            }
        });
        let open_dispatch = std::sync::Arc::new({
            let weak = weak.clone();
            move |dispatch_id: &str, _: &mut gpui::Window, cx: &mut gpui::App| {
                let Some(entity) = weak.upgrade() else {
                    return;
                };
                let dispatch_id = dispatch_id.to_owned();
                entity.update(cx, |this, cx| this.open_dispatch_activity(&dispatch_id, cx));
            }
        });
        let actions = TranscriptActions {
            view_file,
            view_diff,
            open_dispatch,
        };
        // The markdown bodies the rows render register their geometry with a
        // shared selection state every frame, so the pane root resets the
        // registry before any row paints (holding exactly this frame's
        // elements, in order) and installs the mouse listeners that drive it
        // — the legacy transcript root's own pair. The state is the legacy
        // pane's: only one pane renders at a time, and sharing it keeps a
        // selection made in either pane meaningful to the other.
        let selection = self.transcript_selection.clone();
        // The jump button floats over the list, so the pane's own column is
        // the positioning context. The permission card and the question card
        // ride below the list as the pane's transient bottom sections —
        // sections, not rows, so the list's measurements never see them come
        // and go (tide anchors the permission card above the composer; the
        // pane's bottom is the closest analog). A driver asks for permission
        // or user input, never both, so the two cards never stack in
        // practice — permission sits above the question card regardless.
        div()
            .size_full()
            .flex()
            .flex_col()
            .relative()
            .child(crate::md::render::frame_reset(selection.clone()))
            .child(selection_input(selection))
            .child(list::render_list(self, actions, window, cx))
            .children(list::render_pending_permission(self, cx))
            .children(list::render_pending_question(self, cx))
            .children(list::render_jump_button(self, cx))
            // The find bar floats over the list (after it, so it paints and
            // hit-tests above the rows). The nav rail is the shared
            // `ConversationNavigationRail` entity — the legacy pane's rail,
            // relocated to `app::navigation_rail` and fed from the v2 render
            // sync in [`list::render_list`] — mounted exactly the way the
            // legacy pane mounts it: an absolutely-positioned overlay of the
            // pane root, landing at the pane's left edge.
            .children(self.render_timeline_v2_search_bar(cx))
            .child(
                self.navigation_rail.clone().cached(
                    StyleRefinement::default()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                ),
            )
            .into_any_element()
    }
}

/// A zero-size canvas that installs the frame's selection mouse listeners,
/// the legacy transcript's pattern: one set for the whole pane, because the
/// registry already knows every painted element's geometry.
fn selection_input(selection: crate::md::render::TranscriptSelection) -> AnyElement {
    canvas(
        |_, _, _| (),
        move |_, _, window, _| crate::md::render::install_selection_input(window, &selection),
    )
    .absolute()
    .w(px(0.0))
    .h(px(0.0))
    .into_any_element()
}
