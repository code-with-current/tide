//! The conversation navigation rail: the 44px left-edge strip of turn ticks
//! with hover previews, shared by the legacy transcript pane and the v2
//! timeline pane. Relocated here (from `transcript_view.rs` / `transcript.rs`
//! / the app-shell constants) so both panes mount the same entity without
//! importing each other — the pane files stay deletable independently.

use super::*;

const NAVIGATION_RAIL_WIDTH: f32 = 44.0;
const NAVIGATION_RAIL_LEFT: f32 = 16.0;
const NAVIGATION_RAIL_CONTENT_GAP: f32 = 16.0;
const NAVIGATION_RAIL_VIEWPORT_HEIGHT_RATIO: f32 = 0.80;
const NAVIGATION_RAIL_TICK_WIDTH: f32 = 32.0;
pub(super) const NAVIGATION_RAIL_TICK_HEIGHT: f32 = 2.0;
const NAVIGATION_RAIL_TICK_GAP: f32 = 10.0;
const NAVIGATION_RAIL_INACTIVE_OPACITY: f32 = 0.45;
pub(super) const NAVIGATION_RAIL_TURN_HEIGHT: f32 =
    NAVIGATION_RAIL_TICK_HEIGHT + NAVIGATION_RAIL_TICK_GAP;
const NAVIGATION_RAIL_FADE_HEIGHT: f32 = 20.0;
const NAVIGATION_RAIL_ANIMATION_DURATION: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct NavigationRailVisualState {
    emphasized_turn: Option<Uuid>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TranscriptNavigationTurn {
    pub message_id: Uuid,
    pub message_index: usize,
    pub row_index: usize,
    pub prompt: String,
    pub response: String,
}

/// One turn opening resolved by the owning pane: the user message that starts
/// the turn, the row that renders it in that pane's list, and the message
/// index the turn's response scan ends at (the next user message, or the end
/// of the transcript). Panes resolve rows their own way — the legacy pane
/// walks its row kinds, v2 its derived rows — and hand the openings over in
/// ascending message order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct NavigationTurnOpening {
    pub message_index: usize,
    pub row_index: usize,
    pub next_user_index: usize,
}

/// The pane-agnostic half of the rail's turn-list build: prompt and response
/// snippets per resolved opening. [`navigation_preview_snippet`] extraction
/// for every turn of a long session is too much to redo per frame, so the
/// owning pane caches the result against its row fingerprint — see the legacy
/// `Tide::navigation_turns` and the v2 render sync.
pub(super) fn navigation_turns(
    session: &AgentSession,
    openings: &[NavigationTurnOpening],
) -> Vec<TranscriptNavigationTurn> {
    let mut turns = Vec::with_capacity(openings.len());
    for opening in openings {
        let Some(message) = session.messages.get(opening.message_index) else {
            continue;
        };
        let turn_running = message.turn_id.is_some_and(|turn_id| {
            session
                .turns
                .iter()
                .any(|turn| turn.id == turn_id && turn.status == TurnStatus::Running)
        });
        let response = (!turn_running)
            .then(|| {
                session.messages[opening.message_index + 1..opening.next_user_index]
                    .iter()
                    .rev()
                    .find(|candidate| {
                        candidate.role == MessageRole::Assistant
                            && !candidate.content.trim().is_empty()
                    })
                    .map(|candidate| navigation_preview_snippet(&candidate.content, 240))
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        turns.push(TranscriptNavigationTurn {
            message_id: message.id,
            message_index: opening.message_index,
            row_index: opening.row_index,
            prompt: if message.visible_content().trim().is_empty() {
                message
                    .attachments
                    .iter()
                    .map(|attachment| attachment.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                navigation_preview_snippet(message.visible_content(), 100)
            },
            response,
        });
    }
    turns
}

pub(super) fn navigation_preview_snippet(content: &str, max_graphemes: usize) -> String {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut graphemes = normalized.graphemes(true);
    let snippet = graphemes.by_ref().take(max_graphemes).collect::<String>();
    if graphemes.next().is_some() {
        format!("{snippet}…")
    } else {
        snippet
    }
}

pub(super) fn active_navigation_turn_index(
    turn_rows: &[usize],
    scroll_top_row: usize,
    at_transcript_end: bool,
) -> Option<usize> {
    if turn_rows.is_empty() {
        return None;
    }
    if at_transcript_end {
        return Some(turn_rows.len() - 1);
    }
    Some(
        turn_rows
            .partition_point(|row| *row <= scroll_top_row)
            .saturating_sub(1),
    )
}

pub(super) fn navigation_rail_scale(
    turn_index: usize,
    emphasized_turn_index: Option<usize>,
) -> f32 {
    emphasized_turn_index.map_or(0.25, |emphasized| match turn_index.abs_diff(emphasized) {
        0 => 1.0,
        1 => 0.68,
        2 => 0.44,
        _ => 0.25,
    })
}

pub(super) fn navigation_rail_height(turn_count: usize, viewport_height: f32) -> f32 {
    (turn_count as f32 * NAVIGATION_RAIL_TURN_HEIGHT)
        .min(viewport_height * NAVIGATION_RAIL_VIEWPORT_HEIGHT_RATIO)
}

/// Kept as a `pub(super)` alias over the shared primitive so the app-level
/// tests and both pane call sites keep one import path.
pub(super) fn navigation_rail_fade_visibility(
    offset_y: Pixels,
    max_offset: Pixels,
) -> (bool, bool) {
    crate::ui::scroll_fade::visibility(offset_y, max_offset)
}

pub(super) fn should_show_navigation_rail(
    transcript_scrollable: bool,
    turn_count: usize,
    chat_viewport_width: f32,
) -> bool {
    let content_left = ((chat_viewport_width - CONTENT_MAX_WIDTH) / 2.0).max(20.0);
    let rail_right = NAVIGATION_RAIL_LEFT + NAVIGATION_RAIL_WIDTH;
    transcript_scrollable
        && turn_count >= 2
        && content_left >= rail_right + NAVIGATION_RAIL_CONTENT_GAP
}

#[derive(Clone, Debug)]
pub(super) struct ConversationNavigationRailSnapshot {
    pub visible: bool,
    /// Shared with the `Tide` cache: the turns only change when the row-kinds
    /// fingerprint moves, so the per-frame equality check here is a pointer
    /// comparison rather than a walk over every turn's snippets.
    pub turns: Rc<Vec<TranscriptNavigationTurn>>,
    pub viewport_height: f32,
    pub active_turn: Option<Uuid>,
    pub reset_generation: u64,
    pub theme_is_dark: bool,
}

impl PartialEq for ConversationNavigationRailSnapshot {
    fn eq(&self, other: &Self) -> bool {
        self.visible == other.visible
            && Rc::ptr_eq(&self.turns, &other.turns)
            && self.viewport_height == other.viewport_height
            && self.active_turn == other.active_turn
            && self.reset_generation == other.reset_generation
            && self.theme_is_dark == other.theme_is_dark
    }
}

impl Default for ConversationNavigationRailSnapshot {
    fn default() -> Self {
        Self {
            visible: false,
            turns: Rc::new(Vec::new()),
            viewport_height: 0.0,
            active_turn: None,
            reset_generation: 0,
            theme_is_dark: true,
        }
    }
}

pub(super) struct ConversationNavigationRail {
    tide: Option<WeakEntity<Tide>>,
    pub(super) snapshot: ConversationNavigationRailSnapshot,
    turn_list_state: ListState,
    turn_indexes: HashMap<Uuid, usize>,
    hovered_turn: Option<Uuid>,
    focused_turn: Option<Uuid>,
    focus_handles: HashMap<Uuid, FocusHandle>,
    visual_state: NavigationRailVisualState,
    transition_from: NavigationRailVisualState,
    animation_generation: u64,
}

impl ConversationNavigationRail {
    pub(super) fn new() -> Self {
        let turn_list_state = ListState::new(0, ListAlignment::Top, px(48.0))
            .with_uniform_item_height(px(NAVIGATION_RAIL_TURN_HEIGHT));
        turn_list_state.set_scroll_handler(|_, window, _| window.refresh());
        Self {
            tide: None,
            snapshot: ConversationNavigationRailSnapshot::default(),
            turn_list_state,
            turn_indexes: HashMap::new(),
            hovered_turn: None,
            focused_turn: None,
            focus_handles: HashMap::new(),
            visual_state: NavigationRailVisualState::default(),
            transition_from: NavigationRailVisualState::default(),
            animation_generation: 0,
        }
    }

    pub(super) fn set_tide(&mut self, tide: WeakEntity<Tide>) {
        self.tide = Some(tide);
    }

    pub(super) fn set_snapshot(
        &mut self,
        snapshot: ConversationNavigationRailSnapshot,
        cx: &mut Context<Self>,
    ) {
        if self.snapshot == snapshot {
            return;
        }
        let reset = self.snapshot.reset_generation != snapshot.reset_generation;
        let turn_identity_changed = self.snapshot.turns.len() != snapshot.turns.len()
            || self
                .snapshot
                .turns
                .iter()
                .zip(snapshot.turns.iter())
                .any(|(previous, next)| previous.message_id != next.message_id);
        let active_turn_changed = self.snapshot.active_turn != snapshot.active_turn;
        if reset {
            self.hovered_turn = None;
            self.focused_turn = None;
            self.focus_handles.clear();
            self.visual_state = NavigationRailVisualState::default();
            self.transition_from = NavigationRailVisualState::default();
            self.animation_generation = self.animation_generation.wrapping_add(1);
        } else if turn_identity_changed {
            self.focus_handles.retain(|message_id, _| {
                snapshot
                    .turns
                    .iter()
                    .any(|turn| turn.message_id == *message_id)
            });
            if self
                .focused_turn
                .is_some_and(|message_id| !self.focus_handles.contains_key(&message_id))
            {
                self.focused_turn = None;
            }
        }
        if reset || turn_identity_changed {
            self.turn_list_state
                .reset_with_uniform_height(snapshot.turns.len(), px(NAVIGATION_RAIL_TURN_HEIGHT));
            self.turn_indexes.clear();
            self.turn_indexes.extend(
                snapshot
                    .turns
                    .iter()
                    .enumerate()
                    .map(|(index, turn)| (turn.message_id, index)),
            );
        }
        self.snapshot = snapshot;
        if (reset || turn_identity_changed || active_turn_changed)
            && let Some(active_index) = self
                .snapshot
                .active_turn
                .and_then(|message_id| self.turn_indexes.get(&message_id).copied())
        {
            self.turn_list_state.scroll_to_reveal_item(active_index);
        }
        cx.notify();
    }
}

impl Render for ConversationNavigationRail {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.snapshot.visible {
            return div().into_any_element();
        }
        let theme = Theme::current(cx);
        let turns = self.snapshot.turns.clone();
        let turn_count = turns.len();
        let viewport_height = self.snapshot.viewport_height;
        if turn_count == 0 {
            return div().into_any_element();
        }
        let rail_height = navigation_rail_height(turn_count, viewport_height);
        if rail_height <= 0.0 {
            return div().into_any_element();
        }
        let rail_top = (viewport_height - rail_height).max(0.0) / 2.0;
        // The rail keeps a true one-to-one scroll position for every turn. Its
        // `ListState` only asks the builder for visible ticks plus overdraw, so
        // hover and scroll work remain bounded by the viewport even for a very
        // long conversation.
        let emphasized_turn = self.hovered_turn.or_else(|| {
            window
                .last_input_was_keyboard()
                .then_some(self.focused_turn)
                .flatten()
        });
        let emphasized_turn_index =
            emphasized_turn.and_then(|message_id| self.turn_indexes.get(&message_id).copied());
        let active_turn_index = self
            .snapshot
            .active_turn
            .and_then(|message_id| self.turn_indexes.get(&message_id).copied());
        let visual_state = NavigationRailVisualState { emphasized_turn };
        let previous_visual_state = self.visual_state;
        if previous_visual_state != visual_state {
            self.transition_from = previous_visual_state;
            self.visual_state = visual_state;
            self.animation_generation = self.animation_generation.wrapping_add(1);
        }
        let transition_from = self.transition_from;
        let from_emphasized_turn_index = transition_from
            .emphasized_turn
            .and_then(|message_id| self.turn_indexes.get(&message_id).copied());
        let animation_generation = self.animation_generation;
        let entity = cx.entity().downgrade();
        let turn_list_state = self.turn_list_state.clone();
        let tick_list = list(turn_list_state.clone(), move |turn_index, window, cx| {
            entity
                .upgrade()
                .map(|entity| {
                    entity.update(cx, |this, cx| {
                        this.render_navigation_rail_tick(
                            turn_index,
                            from_emphasized_turn_index,
                            emphasized_turn_index,
                            active_turn_index,
                            animation_generation,
                            window,
                            cx,
                        )
                    })
                })
                .unwrap_or_else(|| div().into_any_element())
        })
        .size_full();

        let (show_top_fade, show_bottom_fade) = navigation_rail_fade_visibility(
            self.turn_list_state.scroll_px_offset_for_scrollbar().y,
            self.turn_list_state.max_offset_for_scrollbar().y,
        );
        let transparent_surface = theme.surface.opacity(0.0);

        let rail = div()
            .id("conversation-navigation-rail")
            .absolute()
            .left(px(NAVIGATION_RAIL_LEFT))
            .top(px(rail_top))
            .w(px(NAVIGATION_RAIL_WIDTH))
            .h(px(rail_height))
            .relative()
            .overflow_hidden()
            .tab_index(0)
            .tab_group()
            .tab_stop(false)
            .child(tick_list)
            .when(show_top_fade, |rail| {
                rail.child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .w_full()
                        .h(px(NAVIGATION_RAIL_FADE_HEIGHT))
                        .bg(linear_gradient(
                            180.0,
                            linear_color_stop(theme.surface, 0.0),
                            linear_color_stop(transparent_surface, 1.0),
                        )),
                )
            })
            .when(show_bottom_fade, |rail| {
                rail.child(
                    div()
                        .absolute()
                        .bottom_0()
                        .left_0()
                        .w_full()
                        .h(px(NAVIGATION_RAIL_FADE_HEIGHT))
                        .bg(linear_gradient(
                            180.0,
                            linear_color_stop(transparent_surface, 0.0),
                            linear_color_stop(theme.surface, 1.0),
                        )),
                )
            });

        let preview = emphasized_turn_index.map(|turn_index| {
            let turn = &turns[turn_index];
            let scroll_top = -self.turn_list_state.scroll_px_offset_for_scrollbar().y;
            let preview_height = 126.0;
            let max_preview_top = (viewport_height - preview_height - 12.0).max(12.0);
            let preview_top = (rail_top + turn_index as f32 * NAVIGATION_RAIL_TURN_HEIGHT
                - f32::from(scroll_top)
                + NAVIGATION_RAIL_TURN_HEIGHT / 2.0
                - preview_height / 2.0)
                .clamp(12.0, max_preview_top);
            div()
                .absolute()
                .left(px(NAVIGATION_RAIL_LEFT
                    + NAVIGATION_RAIL_WIDTH
                    + NAVIGATION_RAIL_CONTENT_GAP))
                .top(px(preview_top))
                .w(px(320.0))
                .max_h(px(preview_height))
                .overflow_hidden()
                .rounded(px(14.0))
                .border_1()
                .border_color(theme.border_strong)
                .bg(theme.raised)
                .shadow_lg()
                .px(px(15.0))
                .py(px(12.0))
                .flex()
                .flex_col()
                .gap(px(7.0))
                .child(
                    div()
                        .w_full()
                        .truncate()
                        .text_size(sp(14.0))
                        .line_height(sp(20.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text)
                        .child(SharedString::from(turn.prompt.clone())),
                )
                .when(!turn.response.is_empty(), |preview| {
                    preview.child(
                        div()
                            .w_full()
                            .max_h(px(60.0))
                            .overflow_hidden()
                            .whitespace_normal()
                            .text_size(sp(13.0))
                            .line_height(sp(20.0))
                            .text_color(theme.text_tertiary)
                            .child(SharedString::from(turn.response.clone())),
                    )
                })
        });

        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(rail)
            .children(preview)
            .into_any_element()
    }
}

impl ConversationNavigationRail {
    #[allow(clippy::too_many_arguments)]
    fn render_navigation_rail_tick(
        &mut self,
        turn_index: usize,
        from_emphasized_turn_index: Option<usize>,
        emphasized_turn_index: Option<usize>,
        active_turn_index: Option<usize>,
        animation_generation: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(turn) = self.snapshot.turns.get(turn_index) else {
            return div().into_any_element();
        };
        let message_id = turn.message_id;
        let theme = Theme::current(cx);
        let focus_handle = self.navigation_rail_focus_handle(message_id, window, cx);
        let from_width = NAVIGATION_RAIL_TICK_WIDTH
            * navigation_rail_scale(turn_index, from_emphasized_turn_index);
        let to_width =
            NAVIGATION_RAIL_TICK_WIDTH * navigation_rail_scale(turn_index, emphasized_turn_index);
        let prominent =
            active_turn_index == Some(turn_index) || emphasized_turn_index == Some(turn_index);
        let tick_color = if prominent {
            if theme.is_dark {
                rgb(0xFFFFFF).into()
            } else {
                theme.text
            }
        } else {
            theme.text_ghost.opacity(NAVIGATION_RAIL_INACTIVE_OPACITY)
        };
        let click_focus = focus_handle.clone();
        let animation_id = SharedString::from(format!(
            "conversation-navigation-tick-animation-{message_id}-{animation_generation}"
        ));
        let tick = div()
            .h(px(NAVIGATION_RAIL_TICK_HEIGHT))
            .rounded_full()
            .bg(tick_color)
            .with_animation(
                animation_id,
                Animation::new(NAVIGATION_RAIL_ANIMATION_DURATION).with_easing(ease_out_quint()),
                move |element, delta| element.w(px(from_width + (to_width - from_width) * delta)),
            );

        div()
            .id(SharedString::from(format!(
                "conversation-navigation-turn-hit-{message_id}"
            )))
            .w(px(NAVIGATION_RAIL_WIDTH))
            .h(px(NAVIGATION_RAIL_TURN_HEIGHT))
            .flex_none()
            .flex()
            .items_center()
            .cursor_default()
            .on_hover(cx.listener(move |this, hovering: &bool, _, cx| {
                if *hovering {
                    this.hovered_turn = Some(message_id);
                } else if this.hovered_turn == Some(message_id) {
                    this.hovered_turn = None;
                }
                cx.notify();
            }))
            .on_click(cx.listener(move |this, _, window, cx| {
                click_focus.focus(window, cx);
                this.activate_turn(message_id, cx);
            }))
            .child(
                div()
                    .id(SharedString::from(format!(
                        "conversation-navigation-turn-focus-{message_id}"
                    )))
                    .w(px(NAVIGATION_RAIL_TICK_WIDTH + 4.0))
                    .h(px(8.0))
                    .ml(px(-2.0))
                    .pl(px(2.0))
                    .flex()
                    .items_center()
                    .rounded(px(4.0))
                    .track_focus(&focus_handle)
                    .tab_index(turn_index as isize)
                    .focus_visible(|style| style.border_1().border_color(theme.accent))
                    .on_key_down(cx.listener(move |this, event, window, cx| {
                        this.navigation_rail_key_down(message_id, event, window, cx);
                    }))
                    .child(tick),
            )
            .into_any_element()
    }

    fn navigation_rail_focus_handle(
        &mut self,
        message_id: Uuid,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> FocusHandle {
        if let Some(focus_handle) = self.focus_handles.get(&message_id).cloned() {
            return focus_handle;
        }

        let focus_handle = cx.focus_handle();
        cx.on_focus(&focus_handle, window, move |this: &mut Self, _, cx| {
            this.focused_turn = Some(message_id);
            cx.notify();
        })
        .detach();
        cx.on_blur(&focus_handle, window, move |this: &mut Self, _, cx| {
            if this.focused_turn == Some(message_id) {
                this.focused_turn = None;
            }
            cx.notify();
        })
        .detach();
        self.focus_handles.insert(message_id, focus_handle.clone());
        focus_handle
    }

    fn navigation_rail_key_down(
        &mut self,
        message_id: Uuid,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let turns = &self.snapshot.turns;
        let turn_count = turns.len();
        if turn_count == 0 {
            return;
        }
        let Some(turn_index) = self.turn_indexes.get(&message_id).copied() else {
            return;
        };

        let target_turn = match event.keystroke.key.as_str() {
            "up" => Some(turn_index.saturating_sub(1)),
            "down" => Some((turn_index + 1).min(turn_count - 1)),
            "home" => Some(0),
            "end" => Some(turn_count - 1),
            "enter" | "space" => {
                self.activate_turn(message_id, cx);
                cx.stop_propagation();
                return;
            }
            _ => None,
        };
        let Some(target_turn) = target_turn else {
            return;
        };
        self.turn_list_state.scroll_to_reveal_item(target_turn);
        let target_message_id = turns[target_turn].message_id;
        let focus_handle = self.navigation_rail_focus_handle(target_message_id, window, cx);
        focus_handle.focus(window, cx);
        cx.notify();
        cx.stop_propagation();
    }

    fn activate_turn(&self, message_id: Uuid, cx: &mut Context<Self>) {
        if let Some(tide) = &self.tide {
            let _ = tide.update(cx, |tide, cx| {
                tide.scroll_to_navigation_turn(message_id, cx)
            });
        }
    }
}

impl Tide {
    /// A tick activation: scroll the OWNING pane to the turn's opening row.
    /// The rail entity is shared, so the seam branches on the pane flag the
    /// same way `render_transcript` does — one pane renders at a time.
    fn scroll_to_navigation_turn(&mut self, message_id: Uuid, cx: &mut Context<Self>) {
        if self.timeline_v2 {
            self.timeline_v2_scroll_to_navigation_turn(message_id, cx);
            return;
        }
        let row_index = self
            .navigation_turns()
            .iter()
            .find(|turn| turn.message_id == message_id)
            .map(|turn| turn.row_index);
        let Some(row_index) = row_index else {
            return;
        };

        self.transcript_anchor_following.set(false);
        self.active_transcript_rows().scroll_to(ListOffset {
            item_ix: row_index,
            offset_in_item: Pixels::ZERO,
        });
        self.transcript_is_scrolled.set(true);
        cx.notify();
    }
}
