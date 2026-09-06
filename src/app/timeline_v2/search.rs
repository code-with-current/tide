//! Find-in-page for the v2 pane — the minimal port of the legacy
//! `transcript_search`: one text field in a bar at the pane top, a pure
//! matcher over the selected session's user+assistant contents, and
//! row-level reveal for the current match.
//!
//! Matching reuses the md engine's own matcher (`markdown_search_matches`)
//! rather than a fresh substring scan, for the same reason the legacy search
//! does: a hit is only honest if it names a range the renderer will actually
//! paint, and painted markdown is the flattened run text — marker syntax
//! never reaches the screen — so byte spans live in that flattened space,
//! which for plain user content is exactly `visible_content`. The match's
//! element ordinal rides along so the body's paint pass can highlight the
//! exact glyphs through `md::render::SearchHighlights`.
//!
//! Open trigger: the app's one `OpenFind` action (Cmd/Ctrl-F), guarded at
//! its handler seam in `file_search.rs` — when the v2 pane owns the
//! transcript, the action opens this bar instead of the legacy one. The bar
//! carries the same `FindBar` key context as the legacy bar, so Escape and
//! shift-enter keep their bindings through the same root action handlers.

use super::list::{FollowState, active_rows, message_index_row};
use crate::app::Tide;
use crate::input::{InputEvent, TextInput};
use crate::md;
use crate::model::{Message, MessageRole};
use crate::theme::{Theme, sp};
use crate::ui::icon_button;
use crate::ui::tooltip::Tooltip;
use gpui::prelude::*;
use gpui::{AnyElement, Context, MouseButton, SharedString, Window, div, px};
use regex::{Regex, RegexBuilder};
use std::rc::Rc;

/// Match cap, the legacy search's bound: a query that would flood the
/// transcript stops early rather than stalling a frame.
const MAX_SEARCH_MATCHES: usize = 20_000;

/// One find-in-page hit. `span` is the byte range in the message's shaped
/// text (flattened markdown — plain user content's flattened text equals its
/// `visible_content`); `ordinal` is the md renderer's stable element ordinal
/// for that range, so the body's paint pass can highlight the exact glyphs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SearchMatch {
    pub message_index: usize,
    pub span: (usize, usize),
    pub ordinal: usize,
}

/// The pane's open find bar: the field entity plus the last refresh's
/// results. Created on open, dropped on close — a session switch drops it
/// too (matches from another session would misreveal).
pub(crate) struct SearchState {
    pub input: gpui::Entity<TextInput>,
    pub query: String,
    pub matches: Vec<SearchMatch>,
    pub current: usize,
}

/// Literal substring matching across every user and assistant message, in
/// message order; an empty query matches nothing. Other roles never match —
/// system content is not part of the conversation the reader can see. Pure:
/// given the messages, the query, and the case fold, the hits are
/// deterministic (TDD'd in `tests.rs`).
pub(crate) fn find_matches(
    messages: &[Message],
    query: &str,
    case_sensitive: bool,
) -> Vec<SearchMatch> {
    if query.is_empty() {
        return Vec::new();
    }
    let regex = literal_regex(query, case_sensitive);
    let mut out = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        if !matches!(message.role, MessageRole::User | MessageRole::Assistant) {
            continue;
        }
        let remaining = MAX_SEARCH_MATCHES.saturating_sub(out.len());
        let (found, limited) =
            md::render::markdown_search_matches(message.visible_content(), &regex, remaining);
        out.extend(found.into_iter().map(|text| SearchMatch {
            message_index,
            span: (text.range.start, text.range.end),
            ordinal: text.ordinal,
        }));
        if limited {
            break;
        }
    }
    out
}

fn literal_regex(query: &str, case_sensitive: bool) -> Regex {
    RegexBuilder::new(&regex::escape(query))
        .case_insensitive(!case_sensitive)
        .build()
        .expect("an escaped literal is always a valid regex")
}

impl Tide {
    pub(in crate::app) fn timeline_v2_search_open(&self) -> bool {
        self.timeline_v2_state.search.is_some()
    }

    /// Open the find bar — the `OpenFind` seam's v2 branch. A session with
    /// nothing to search propagates so the keystroke can fall through.
    /// Already open means refocus and re-select, not a fresh field.
    pub(in crate::app) fn timeline_v2_open_search(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .selected_session()
            .is_none_or(|session| session.messages.is_empty())
        {
            cx.propagate();
            return;
        }
        if let Some(search) = self.timeline_v2_state.search.as_ref() {
            let input = search.input.clone();
            input.update(cx, |input, cx| input.select_all_text(cx));
            window.focus(&input.read(cx).focus(), cx);
            cx.notify();
            return;
        }
        let input = cx.new(|cx| TextInput::new(window, cx).placeholder(tr!("input.find")));
        cx.subscribe(
            &input,
            |this: &mut Self, _, event: &InputEvent, cx| match event {
                InputEvent::Edited => this.timeline_v2_refresh_search(cx),
                InputEvent::Submit(_) => this.timeline_v2_navigate_search(false, cx),
                InputEvent::Focus | InputEvent::BackspaceOnEmpty => {}
            },
        )
        .detach();
        self.timeline_v2_state.search = Some(SearchState {
            input: input.clone(),
            query: String::new(),
            matches: Vec::new(),
            current: 0,
        });
        window.focus(&input.read(cx).focus(), cx);
        cx.notify();
    }

    /// Close the bar, dropping its state (and with it the field entity).
    /// Restoring focus hands the window back to the composer — the v2
    /// equivalent of the legacy bar's previous-focus restore.
    pub(in crate::app) fn timeline_v2_close_search(
        &mut self,
        restore_focus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.timeline_v2_state.search.take().is_none() {
            return;
        }
        if restore_focus {
            let focus = self.composer_focus(cx);
            window.focus(&focus, cx);
        }
        cx.notify();
    }

    /// Recompute matches for the field's current content and point the
    /// current match at the first hit at or below the viewport's top row —
    /// the legacy search's "start where the reader is" rule. v1 limit,
    /// documented honestly: matches snapshot the text at refresh time, so a
    /// streaming tail grows no new hits until the query moves; the legacy
    /// search holds the same contract.
    pub(super) fn timeline_v2_refresh_search(&mut self, cx: &mut Context<Self>) {
        let Some(search) = self.timeline_v2_state.search.as_ref() else {
            return;
        };
        let query = search.input.read(cx).content().to_owned();
        // "Start where the reader is" reads the list they are browsing —
        // the anchored twin while a turn streams.
        let origin_row = active_rows(&self.timeline_v2_state)
            .logical_scroll_top()
            .item_ix;
        let matches = self
            .selected_session()
            .map(|session| find_matches(&session.messages, &query, false))
            .unwrap_or_default();
        let current = matches
            .iter()
            .position(|found| {
                message_index_row(&self.timeline_v2_state, found.message_index)
                    .is_some_and(|row| row >= origin_row)
            })
            .unwrap_or(0);
        let search = self
            .timeline_v2_state
            .search
            .as_mut()
            .expect("the borrow above proved the state present");
        search.query = query;
        search.matches = matches;
        search.current = current;
        self.timeline_v2_reveal_current_search(cx);
        cx.notify();
    }

    /// Step to the next (or previous) match, wrapping.
    pub(in crate::app) fn timeline_v2_navigate_search(
        &mut self,
        backwards: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(search) = self
            .timeline_v2_state
            .search
            .as_mut()
            .filter(|search| !search.matches.is_empty())
        else {
            return;
        };
        let count = search.matches.len();
        search.current = if backwards {
            (search.current + count - 1) % count
        } else {
            (search.current + 1) % count
        };
        self.timeline_v2_reveal_current_search(cx);
        cx.notify();
    }

    /// Row-level reveal of the current match: `scroll_to_reveal_item` on the
    /// match's message row. v1 limit, documented honestly: the reveal lands
    /// on the message row, not the exact glyph line — the legacy search's
    /// two-phase geometry reveal is not ported; the paint-time highlight
    /// below still marks the exact ranges once the row mounts. Revealing
    /// releases the follow pin so the next stream tick cannot yank the
    /// reader off the match.
    fn timeline_v2_reveal_current_search(&mut self, cx: &mut Context<Self>) {
        let Some(search) = self.timeline_v2_state.search.as_ref() else {
            return;
        };
        let Some(found) = search.matches.get(search.current) else {
            return;
        };
        let Some(row) = message_index_row(&self.timeline_v2_state, found.message_index) else {
            return;
        };
        let state = &mut self.timeline_v2_state;
        state.follow = FollowState::Released;
        active_rows(state).scroll_to_reveal_item(row);
        cx.notify();
    }

    /// The paint-time highlight set for one message body — every hit in that
    /// message, with the pane's current hit marked active. `None` when the
    /// bar is closed or the message has no hits. Two v1 gaps, documented:
    /// the user bubble renders plain text outside the md engine, so its hits
    /// navigate but never paint quads; a settled JSON-card body renders the
    /// card, not shaped markdown, so it too is navigation-only.
    pub(super) fn timeline_v2_search_highlights(
        &self,
        message_index: usize,
    ) -> Option<md::render::SearchHighlights> {
        let search = self.timeline_v2_state.search.as_ref()?;
        let to_text = |found: &SearchMatch| md::render::TextSearchMatch {
            ordinal: found.ordinal,
            range: found.span.0..found.span.1,
        };
        let matches: Vec<_> = search
            .matches
            .iter()
            .filter(|found| found.message_index == message_index)
            .map(to_text)
            .collect();
        if matches.is_empty() {
            return None;
        }
        let active = search
            .matches
            .get(search.current)
            .filter(|found| found.message_index == message_index)
            .map(to_text);
        Some(md::render::SearchHighlights {
            matches: Rc::new(matches),
            active,
        })
    }

    /// The find bar: field, n/m counter, prev/next chevrons, close X — the
    /// legacy bar's anatomy, floating at the pane top. `None` when closed.
    pub(super) fn render_timeline_v2_search_bar(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let search = self.timeline_v2_state.search.as_ref()?;
        let theme = Theme::current(cx);
        let has_matches = !search.matches.is_empty();
        let count_label: Option<SharedString> = if search.query.is_empty() {
            None
        } else if !has_matches {
            Some(tr!("find.no_results").into())
        } else {
            Some(SharedString::from(tr!(
                "find.result_count",
                current = search.current + 1,
                total = search.matches.len()
            )))
        };
        let input = search.input.clone();

        let previous = icon_button("timeline-v2-find-previous", "icons/arrow-up.svg", theme)
            .opacity(if has_matches { 1.0 } else { 0.45 })
            .tooltip(Tooltip::text(tr!("find.previous_match")))
            .when(has_matches, |button| {
                button.on_click(
                    cx.listener(|this, _, _, cx| this.timeline_v2_navigate_search(true, cx)),
                )
            });
        let next = icon_button("timeline-v2-find-next", "icons/arrow-down.svg", theme)
            .opacity(if has_matches { 1.0 } else { 0.45 })
            .tooltip(Tooltip::text(tr!("find.next_match")))
            .when(has_matches, |button| {
                button.on_click(
                    cx.listener(|this, _, _, cx| this.timeline_v2_navigate_search(false, cx)),
                )
            });
        let close = icon_button("timeline-v2-find-close", "icons/x.svg", theme)
            .tooltip(Tooltip::text(tr!("find.close")))
            .on_click(
                cx.listener(|this, _, window, cx| this.timeline_v2_close_search(true, window, cx)),
            );

        Some(
            div()
                .id("timeline-v2-search-bar")
                .key_context("FindBar")
                .absolute()
                .top(px(8.0))
                .right(px(12.0))
                .w(px(380.0))
                .max_w_full()
                .rounded(px(8.0))
                .border_1()
                .border_color(theme.border_strong)
                .bg(theme.raised)
                .shadow_xs()
                .px(px(6.0))
                .py(px(6.0))
                .flex()
                .items_center()
                .gap(px(5.0))
                // The pane's selection layer listens on the parent; keep its
                // mouse handling from stealing focus off the bar — the
                // legacy bar's own guard.
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    crate::ui::text_field::TextField::new("timeline-v2-find-query", input)
                        .flex_1()
                        .min_w(px(104.0)),
                )
                .child(
                    div()
                        .min_w(px(62.0))
                        .flex_none()
                        .text_size(sp(12.5))
                        .whitespace_nowrap()
                        .text_color(if !search.query.is_empty() && !has_matches {
                            theme.danger
                        } else {
                            theme.text_tertiary
                        })
                        .children(count_label),
                )
                .child(previous)
                .child(next)
                .child(close)
                .into_any_element(),
        )
    }
}
