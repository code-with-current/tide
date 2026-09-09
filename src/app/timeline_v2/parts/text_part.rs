//! The assistant text body — the pane's markdown surface, streaming-aware,
//! plus the settled-turn JSON finalize: a reply whose whole body parses as a
//! JSON document renders as a mono card instead of markdown prose.
//!
//! The markdown engine is the app's own `md::render` crate module, invoked
//! exactly the way the legacy transcript row invokes it: one cached
//! [`MarkdownView`] per message id (the shared `message_markdown` map on
//! `Tide`, which the caller owns), fed the message's `visible_content()`
//! with the message's own `streaming` flag as the mend switch, then shaped
//! through a per-row [`md::render::Ctx`] at the assistant body metrics
//! ([`Metrics::BODY`], rescaled to the user's font settings by the caller).
//! The view is a plain cache struct — no entity, no focus handle — so no
//! per-row handle bookkeeping exists here at all.

use super::super::tools_dim;
use super::tool_part::looks_like_json;
use crate::md;
use crate::model::Message;
use crate::theme::{Theme, sp};
use crate::ui::icon_button;
use gpui::prelude::*;
use gpui::{AnyElement, ClipboardItem, Div, FontWeight, SharedString, div, px};

/// How a settled assistant body finalizes on screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FinalizeKind {
    /// Markdown prose — also the answer for every streaming turn, whatever
    /// the body's shape: the card is a finalize, never a live view.
    Markdown,
    /// The generated-JSON card: the settled body parses as a JSON object or
    /// array (the same bar [`looks_like_json`] holds tool output to).
    JsonCard,
}

/// Decide how a body renders given its content and stream state. Pure so the
/// streaming-before-finalize rule stays unit-testable without a window.
pub(crate) fn finalize_kind(content: &str, streaming: bool) -> FinalizeKind {
    if !streaming && looks_like_json(content).is_some() {
        FinalizeKind::JsonCard
    } else {
        FinalizeKind::Markdown
    }
}

/// Height cap for the generated-JSON viewport, matching the tool card's
/// output budget (`OUTPUT_MAX_HEIGHT` in `tool_part`).
const GENERATED_JSON_MAX_HEIGHT: f32 = 400.0;

/// The small copy affordance, the tool card's pattern: the click handler
/// receives `&mut App` at click time, so the renderer needs no app context.
fn copy_button(id: String, text: String, theme: &Theme) -> gpui::Stateful<Div> {
    icon_button(SharedString::from(id), "icons/copy.svg", *theme).on_click(move |_, _, cx| {
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
    })
}

/// A generated-JSON body: the "result · json" tag row over a pretty-printed
/// mono viewport (400px scroll cap) with the copy affordance parked top-right
/// — the tool card's JSON section geometry with the assistant card's tag.
///
/// Like the tool card's JSON path, the body re-parses and re-pretty-prints per
/// render; prose bodies never reach this path (a `starts_with` brace check is
/// the first thing [`looks_like_json`] tries), and a JSON reply is settled by
/// construction, so the cost is bounded to genuinely JSON-shaped replies.
pub(crate) fn render_generated_json(value: &serde_json::Value, id: &str, theme: &Theme) -> Div {
    let pretty = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    let viewport = div()
        .id(SharedString::from(format!("generated-json-{id}")))
        .max_h(px(GENERATED_JSON_MAX_HEIGHT))
        .overflow_y_scroll()
        .w_full()
        .min_w_0()
        .rounded(px(6.0))
        .bg(theme.raised)
        .px(px(8.0))
        .py(px(6.0))
        .text_size(sp(11.5))
        .line_height(sp(16.0))
        .font_family(md::render::MONO_FAMILY)
        .text_color(theme.text_secondary)
        .child(pretty);

    div()
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .text_size(sp(10.0))
                        .text_color(tools_dim(theme))
                        .child("result")
                        .child("·")
                        .child("json"),
                )
                .child(copy_button(
                    format!("generated-json-copy-{id}"),
                    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
                    theme,
                )),
        )
        .child(viewport)
}

/// One assistant text body, streaming-aware. The engine handles streaming
/// itself — the caller hands over the message's cached view, this call feeds
/// it the current `visible_content()` (the stream pump has already mutated
/// the session message; the 120ms cadence and tail remeasure keep the row
/// fresh), and the mend switch is the message's own `streaming` flag.
///
/// `search`, when present, is the pane find bar's highlight set for this
/// message: the md engine paints each hit as a quad and the active hit in
/// the accent wash — the same paint path the legacy transcript rows use.
///
/// Empty or not-yet-parsed bodies fall back to the selectable plain-text
/// element, the legacy row's own fallback.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_assistant_text(
    message: &Message,
    view: &mut md::render::MarkdownView,
    palette: &md::render::Palette,
    metrics: md::render::Metrics,
    selection: md::render::TranscriptSelection,
    link_handler: Option<md::render::LinkHandler>,
    mermaid_handler: Option<md::render::MermaidHandler>,
    mermaid_host: Option<md::render::MermaidHost>,
    animate_streaming: bool,
    search: Option<md::render::SearchHighlights>,
    theme: &Theme,
) -> AnyElement {
    let content = message.visible_content();

    match finalize_kind(content, message.streaming) {
        // A settled JSON body never reaches the markdown parser — the card is
        // the body, so the view's parse cache stays reserved for prose.
        FinalizeKind::JsonCard => {
            let value = looks_like_json(content).expect("finalize_kind verified the shape");
            render_generated_json(&value, &message.id.to_string(), theme).into_any_element()
        }
        FinalizeKind::Markdown => {
            view.set_text(content, message.streaming);
            // The same per-row element-key scope the legacy rows use, so a
            // pane switch or virtualized remount recreates identical keys and
            // the view's flatten caches line up across surfaces.
            let mut ctx = md::render::Ctx::new(
                format!("message-{}", message.id),
                palette,
                metrics,
                selection,
            )
            .with_streaming_animation(animate_streaming);
            if let Some(link_handler) = link_handler {
                ctx = ctx.with_link_handler(link_handler);
            }
            if let Some(mermaid_handler) = mermaid_handler {
                ctx = ctx.with_mermaid_handler(mermaid_handler);
            }
            if let Some(mermaid_host) = mermaid_host {
                ctx = ctx.with_mermaid_host(mermaid_host);
            }
            if let Some(highlights) = search {
                ctx = ctx.with_search_highlights(highlights);
            }
            md::render::markdown(view, &ctx).unwrap_or_else(|| {
                md::render::plain_text(
                    content.to_owned(),
                    md::render::SANS_FAMILY,
                    FontWeight::NORMAL,
                    theme.text,
                    &ctx,
                )
            })
        }
    }
}
