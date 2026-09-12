//! Transcript message rendering: the user, assistant, and system bubbles,
//! their footers, attachment tiles, inline edit cards, context menus, and
//! the `@mention` link rewrite. Consumed by the transcript row builders.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Datelike, Days, Local, Utc};
use uuid::Uuid;

use gpui::prelude::*;
use gpui::{
    AnyElement, App, ClipboardItem, Context, Entity, FontWeight, KeyDownEvent, ObjectFit,
    SharedString, div, img, px,
};

use crate::app::features::composer::chat_composer::ChatComposer;
use crate::app::features::right_panel::files;
use crate::app::image_preview;
use crate::app::{AssistantMessageAction, Tide, UserMessageAction};
use crate::md;
use crate::md::render::{Ctx as MarkdownCtx, MarkdownView, TranscriptSelection};
use crate::model::{Message, MessageAttachment, MessageRole};
use crate::theme::{Theme, sp};
use crate::ui::icon;
use crate::ui::menu::{ContextMenuHandle, MenuItem, context_menu};
use crate::ui::motion;
use crate::ui::tooltip::Tooltip;

pub(in crate::app) fn format_message_time(created_at: u64) -> String {
    format_message_time_at(created_at, Local::now())
}

fn format_message_time_at(created_at: u64, now: DateTime<Local>) -> String {
    let Ok(seconds) = i64::try_from(created_at) else {
        return String::new();
    };
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .map(|timestamp| {
            let timestamp = timestamp.with_timezone(&Local);
            let message_date = timestamp.date_naive();
            let today = now.date_naive();
            if crate::i18n::uses_east_asian_date_format() {
                let time = timestamp.format("%H:%M").to_string();
                if message_date >= today {
                    return time;
                }
                if today.pred_opt() == Some(message_date) {
                    return tr!("time.yesterday_at", time = time);
                }
                let week_start = today
                    .checked_sub_days(Days::new(today.weekday().num_days_from_monday().into()))
                    .unwrap_or(today);
                if message_date >= week_start {
                    let weekday = match timestamp.weekday() {
                        chrono::Weekday::Mon => tr!("time.monday"),
                        chrono::Weekday::Tue => tr!("time.tuesday"),
                        chrono::Weekday::Wed => tr!("time.wednesday"),
                        chrono::Weekday::Thu => tr!("time.thursday"),
                        chrono::Weekday::Fri => tr!("time.friday"),
                        chrono::Weekday::Sat => tr!("time.saturday"),
                        chrono::Weekday::Sun => tr!("time.sunday"),
                    };
                    return tr!("time.weekday_at", weekday = weekday, time = time);
                }
                if message_date.year() == today.year() {
                    return tr!(
                        "time.date_at",
                        month = timestamp.month(),
                        day = timestamp.day(),
                        time = time
                    );
                }
                return tr!(
                    "time.full_date_at",
                    year = timestamp.year(),
                    month = timestamp.month(),
                    day = timestamp.day(),
                    time = time
                );
            }
            let time = timestamp
                .format("%I:%M %p")
                .to_string()
                .trim_start_matches('0')
                .to_owned();

            if message_date >= today {
                return time;
            }

            if today.pred_opt() == Some(message_date) {
                return tr!("time.yesterday_at", time = time);
            }

            let week_start = today
                .checked_sub_days(Days::new(today.weekday().num_days_from_monday().into()))
                .unwrap_or(today);
            if message_date >= week_start {
                return format!("{} {time}", timestamp.format("%A"));
            }

            let day = timestamp.day();
            let ordinal_suffix = match day % 100 {
                11..=13 => "th",
                _ => match day % 10 {
                    1 => "st",
                    2 => "nd",
                    3 => "rd",
                    _ => "th",
                },
            };
            let date = if message_date.year() == today.year() {
                format!("{} {day}{ordinal_suffix}", timestamp.format("%b"))
            } else {
                format!(
                    "{} {day}{ordinal_suffix} {}",
                    timestamp.format("%b"),
                    timestamp.year()
                )
            };
            format!("{date}, {time}")
        })
        .unwrap_or_default()
}

impl Tide {
    fn show_message_copied(&mut self, message_id: Uuid, cx: &mut Context<Self>) {
        self.shell.copied_message_generation = self.shell.copied_message_generation.wrapping_add(1);
        let generation = self.shell.copied_message_generation;
        self.shell
            .copied_message_feedback
            .insert(message_id, generation);
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            let _ = this.update(cx, |this, cx| {
                if this.shell.copied_message_feedback.get(&message_id) == Some(&generation) {
                    this.shell.copied_message_feedback.remove(&message_id);
                    cx.notify();
                }
            });
        })
        .detach();
    }
}

#[allow(clippy::too_many_arguments)]
pub(in crate::app) fn render_message_footer(
    theme: &Theme,
    message: &Message,
    footer_time: u64,
    copy_content: SharedString,
    copied: bool,
    group_name: SharedString,
    force_visible: bool,
    align_right: bool,
    assistant_message_action: Option<AssistantMessageAction>,
    user_message_action: Option<UserMessageAction>,
    tide: gpui::WeakEntity<Tide>,
) -> AnyElement {
    let theme = *theme;
    let message_id = message.id;
    let copy_tide = tide.clone();
    let footer_color = if theme.is_dark {
        gpui::hsla(126.93 / 360.0, 0.000_000_1, 0.543_95, 1.0)
    } else {
        theme.text_ghost
    };
    let timestamp = div()
        .h(px(27.0))
        .px(px(4.0))
        .flex()
        .items_center()
        .text_size(sp(12.5))
        .line_height(sp(14.0))
        .text_color(footer_color)
        .child(format_message_time(footer_time));
    let copy_button = div()
        .id(SharedString::from(format!("copy-message-{message_id}")))
        .w(px(27.0))
        .h(px(27.0))
        .rounded(px(8.0))
        .flex()
        .items_center()
        .justify_center()
        .cursor_default()
        .hover(|element| element.bg(theme.overlay_strong))
        .child(icon(
            if copied {
                "icons/check.svg"
            } else {
                "icons/copy.svg"
            },
            14.0,
            footer_color,
        ))
        .tooltip(Tooltip::text(if copied {
            tr!("common.copied")
        } else {
            tr!("common.copy_message")
        }))
        .on_click(move |_, _, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(copy_content.to_string()));
            let _ = copy_tide.update(cx, |this, cx| {
                this.show_message_copied(message_id, cx);
            });
        });
    let mut footer = div()
        .w_full()
        .h(px(27.0))
        .flex()
        .items_center()
        .gap(px(1.0))
        .when(!force_visible, |element| {
            element
                .invisible()
                .group_hover(group_name, |element| element.visible())
        })
        .when(!align_right, |element| element.ml(-px(7.0)))
        .when(align_right, |element| element.justify_end());

    if align_right {
        footer = footer.child(timestamp).child(copy_button);
    } else {
        footer = footer.child(copy_button);
        if let Some(action) = assistant_message_action {
            let fork_tide = tide.clone();
            let fork_icon = if action.preparing {
                motion::spin(icon("icons/loader-circle.svg", 14.0, footer_color))
            } else {
                icon("icons/fork.svg", 14.0, footer_color).into_any_element()
            };
            let fork_button = div()
                .id(SharedString::from(format!("fork-response-{message_id}")))
                .w(px(27.0))
                .h(px(27.0))
                .rounded(px(8.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_default()
                .when(!action.enabled && !action.preparing, |element| {
                    element.opacity(0.45)
                })
                .child(fork_icon)
                .tooltip(Tooltip::text(if action.enabled {
                    tr_cow!("session.fork_task")
                } else {
                    tr_cow!("session.forking_task")
                }));
            footer = footer.child(if action.enabled {
                fork_button
                    .hover(|element| element.bg(theme.overlay_strong))
                    .on_click(move |_, _, cx| {
                        let _ = fork_tide.update(cx, |this, cx| {
                            this.fork_session_from_response(
                                action.session_id,
                                action.turn_count,
                                cx,
                            );
                        });
                    })
            } else {
                fork_button
            });
        }
        footer = footer.child(timestamp);
    }

    if let Some(action) = user_message_action {
        let edit_tide = tide;
        footer = footer.child(
            div()
                .id(SharedString::from(format!(
                    "user-message-action-{message_id}"
                )))
                .w(px(27.0))
                .h(px(27.0))
                .rounded(px(8.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_default()
                .hover(|element| element.bg(theme.overlay_strong))
                .child(icon("icons/rewind.svg", 14.0, footer_color))
                .tooltip(Tooltip::text(tr_cow!("session.revert_to_here")))
                .on_click(move |_, window, cx| {
                    let _ = edit_tide.update(cx, |this, cx| {
                        this.begin_message_edit(action, window, cx);
                    });
                }),
        );
    }

    footer.into_any_element()
}

/// Everything one transcript message row needs to render itself. Bundled
/// because these travel together from `transcript_row` and nowhere else.
pub(in crate::app) struct MessageRender<'a> {
    pub(in crate::app) theme: &'a Theme,
    pub(in crate::app) message: &'a Message,
    pub(in crate::app) assistant_footer_copy_content: Option<SharedString>,
    pub(in crate::app) assistant_footer_time: Option<u64>,
    pub(in crate::app) copied: bool,
    pub(in crate::app) assistant_message_action: Option<AssistantMessageAction>,
    pub(in crate::app) user_message_action: Option<UserMessageAction>,
    pub(in crate::app) message_edit_input: Option<Entity<ChatComposer>>,
    pub(in crate::app) attachment_menus: Vec<ContextMenuHandle>,
    pub(in crate::app) attachment_images: Vec<Option<Arc<gpui::Image>>>,
    /// Captured from the selected daemon before the virtualized row is built.
    /// A row is laid out while the root `Tide` entity is already updating, so
    /// it must not read that entity again just to decide whether Finder reveal
    /// is available.
    pub(in crate::app) attachments_can_reveal: bool,
    /// The parsed human or assistant body. System messages remain verbatim.
    pub(in crate::app) markdown: Option<&'a MarkdownView>,
    pub(in crate::app) ctx: &'a MarkdownCtx<'a>,
    pub(in crate::app) menu: ContextMenuHandle,
    pub(in crate::app) tide: gpui::WeakEntity<Tide>,
    pub(in crate::app) composer: Entity<ChatComposer>,
}

fn render_sent_message_attachments(
    message_id: Uuid,
    attachments: &[MessageAttachment],
    attachment_menus: &[ContextMenuHandle],
    attachment_images: &[Option<Arc<gpui::Image>>],
    can_reveal: bool,
    tide: &gpui::WeakEntity<Tide>,
    theme: &Theme,
) -> Option<AnyElement> {
    if attachments.is_empty() {
        return None;
    }
    let mut row = div()
        .max_w(px(540.0))
        .flex()
        .flex_wrap()
        .justify_end()
        .gap(px(8.0));
    for (index, attachment) in attachments.iter().enumerate() {
        let Some(menu) = attachment_menus.get(index) else {
            continue;
        };
        let icon_path = if attachment.is_dir {
            "icons/folder.svg"
        } else {
            files::file_icon_for_path(&attachment.mention)
        };
        let attachment_image = attachment_images.get(index).and_then(|image| image.clone());
        let mut tile = div()
            .id(SharedString::from(format!(
                "message-{message_id}-attachment-{index}"
            )))
            .w(px(96.0))
            .h(px(80.0))
            .rounded(px(9.0))
            .overflow_hidden()
            .border_1()
            .border_color(theme.border)
            .bg(theme.inset)
            .track_focus(menu.trigger_focus_handle())
            .tab_index(0)
            .focus_visible(|style| style.border_color(theme.accent))
            .tooltip(Tooltip::text(attachment.name.clone()));
        if attachment.is_image {
            let key_menu = menu.clone();
            if let Some(attachment_image) = attachment_image.as_ref() {
                let preview_tide = tide.clone();
                let key_tide = tide.clone();
                let preview_image = attachment_image.clone();
                let key_image = attachment_image.clone();
                let preview_name = SharedString::from(attachment.name.clone());
                let key_name = preview_name.clone();
                tile = tile.child(
                    div()
                        .id(SharedString::from(format!(
                            "message-{message_id}-attachment-{index}-preview"
                        )))
                        .size_full()
                        .cursor_default()
                        .on_click(move |_, window, cx| {
                            let _ = preview_tide.update(cx, |this, cx| {
                                this.open_image_preview(
                                    preview_image.clone(),
                                    preview_name.clone(),
                                    window,
                                    cx,
                                );
                            });
                            cx.stop_propagation();
                        })
                        .child(
                            img(attachment_image.clone())
                                .size_full()
                                .object_fit(ObjectFit::Cover),
                        ),
                );
                tile = tile.on_key_down(move |event: &KeyDownEvent, window, cx| {
                    let key = event.keystroke.key.as_str();
                    if matches!(key, "enter" | "space") {
                        let _ = key_tide.update(cx, |this, cx| {
                            this.open_image_preview(
                                key_image.clone(),
                                key_name.clone(),
                                window,
                                cx,
                            );
                        });
                        cx.stop_propagation();
                    } else if key == "f10" && event.keystroke.modifiers.shift {
                        key_menu.open_context_menu(window, cx);
                        cx.stop_propagation();
                    }
                });
            } else {
                tile = tile
                    .child(
                        div()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("icons/file-types/image.svg", 18.0, theme.text_ghost)),
                    )
                    .on_key_down(move |event: &KeyDownEvent, window, cx| {
                        if event.keystroke.key == "f10" && event.keystroke.modifiers.shift {
                            key_menu.open_context_menu(window, cx);
                            cx.stop_propagation();
                        }
                    });
            }
        } else {
            let key_menu = menu.clone();
            tile = tile.child(
                div()
                    .size_full()
                    .px(px(7.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(7.0))
                    .child(icon(icon_path, 18.0, theme.text_tertiary))
                    .child(
                        div()
                            .w_full()
                            .truncate()
                            .text_center()
                            .text_size(sp(12.5))
                            .text_color(theme.text_secondary)
                            .child(attachment.name.clone()),
                    ),
            );
            tile = tile.on_key_down(move |event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "f10" && event.keystroke.modifiers.shift {
                    key_menu.open_context_menu(window, cx);
                    cx.stop_propagation();
                }
            });
        }
        let reveal_path = attachment.path.clone();
        row = row.child(context_menu(
            tile,
            SharedString::from(format!("message-{message_id}-attachment-{index}-menu")),
            menu,
            move |_| image_preview::attachment_menu_items(reveal_path.clone(), can_reveal),
        ));
    }
    Some(row.into_any_element())
}

fn render_markdown_message_body<'a>(
    content: &str,
    markdown: Option<&'a MarkdownView>,
    theme: &Theme,
    ctx: &MarkdownCtx<'a>,
) -> AnyElement {
    markdown
        .and_then(|markdown| md::render::markdown(markdown, ctx))
        // Empty or not-yet-parsed content still needs a selectable fallback.
        .unwrap_or_else(|| {
            md::render::plain_text(
                content.to_owned(),
                md::render::SANS_FAMILY,
                FontWeight::NORMAL,
                theme.text,
                ctx,
            )
        })
}

/// Word-boundary `@mention` tokens — the composer's file mentions — as a
/// rewrite source. Mention tokens rewrite into a code-span-in-link so the
/// bubble paints them as quoted pills (code wash + mono) whose click routes
/// through the transcript's link handler to the right panel's Files surface.
static USER_MENTION_TOKEN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?m)(^|[\s(])@([^\s`@()<>]+)").expect("user mention token regex")
});

/// Rewrite a user message's `@path` mentions into `` [`@path`](<abs path>) ``
/// links whose label is a code span — the bubble paints them as quoted
/// pills (code wash + mono) and a click routes through the transcript's
/// link handler to the right panel's Files surface. Emails (`user@host`),
/// URLs, and mentions inside code spans never match: the token must start
/// at a boundary (text start or whitespace/`(`) and carry no
/// markdown-hostile characters. The boundary character re-emits verbatim
/// and the rendered label keeps the exact `@path` bytes, so find-in-page
/// spans over the flattened text stay aligned.
pub(in crate::app) fn user_mention_links<'a>(
    content: &'a str,
    workspace: Option<&Path>,
) -> std::borrow::Cow<'a, str> {
    USER_MENTION_TOKEN.replace_all(content, |captures: &regex::Captures| {
        let boundary = &captures[1];
        let path = &captures[2];
        // The router only resolves absolute or `file:` targets, so anchor
        // the mention to the workspace when there is one.
        let target = match workspace {
            Some(workspace) => workspace.join(path).to_string_lossy().into_owned(),
            None => path.to_owned(),
        };
        format!("{boundary}[@{path}](<{target}>)")
    })
}

#[cfg(test)]
mod user_mention_tests {
    use super::user_mention_links;
    use std::path::Path;

    #[test]
    fn mentions_rewrite_to_workspace_anchored_code_links() {
        let workspace = Path::new("/ws");
        assert_eq!(
            user_mention_links("check @src/a.rs and @db/ now", Some(workspace)),
            "check [@src/a.rs](</ws/src/a.rs>) and [@db/](</ws/db/>) now"
        );
        assert_eq!(
            user_mention_links("@top alone", Some(workspace)),
            "[@top](</ws/top>) alone"
        );
        // No workspace: the bare path stays the target.
        assert_eq!(user_mention_links("@a.rs", None), "[@a.rs](<a.rs>)");
        // Line-boundary mentions keep their newline.
        assert_eq!(
            user_mention_links("fix\n@src/a.rs", Some(workspace)),
            "fix\n[@src/a.rs](</ws/src/a.rs>)"
        );
        // A boundary-only left edge: emails, URLs, and code spans stay text.
        assert_eq!(
            user_mention_links("mail user@host.com", Some(Path::new("/ws"))),
            "mail user@host.com"
        );
        assert_eq!(
            user_mention_links("see https://x/@y", Some(Path::new("/ws"))),
            "see https://x/@y"
        );
        assert_eq!(
            user_mention_links("code `@a.rs` span", Some(Path::new("/ws"))),
            "code `@a.rs` span"
        );
    }
}

pub(in crate::app) fn render_message(params: MessageRender, cx: &mut App) -> AnyElement {
    let MessageRender {
        theme,
        message,
        assistant_footer_copy_content,
        assistant_footer_time,
        copied,
        assistant_message_action,
        user_message_action,
        message_edit_input,
        attachment_menus,
        attachment_images,
        attachments_can_reveal,
        markdown,
        ctx,
        menu,
        tide,
        composer,
    } = params;

    let content = message.visible_content().to_owned();
    // "Copy Message" must match what the row presents. The terminal part of a
    // settled response stands in for the whole visible answer, so its menu
    // shares the footer's copy content — parts hidden behind "Worked for X"
    // stay out — rather than copying the final part alone.
    let menu_copy_content = assistant_footer_copy_content
        .clone()
        .unwrap_or_else(|| SharedString::from(content.clone()));
    let message_id = message.id;
    let role = message.role;
    let element = match role {
        MessageRole::User => {
            let group_name = SharedString::from(format!("user-message-{message_id}"));
            let mut column = div()
                .w_full()
                .flex()
                .flex_col()
                .items_end()
                .gap(px(3.0))
                .group(group_name.clone());
            if let Some(attachments) = render_sent_message_attachments(
                message_id,
                &message.attachments,
                &attachment_menus,
                &attachment_images,
                attachments_can_reveal,
                &tide,
                theme,
            ) {
                column = column.child(attachments);
            }
            if let Some(edit_input) = message_edit_input {
                let can_submit = !edit_input.read(cx).content(cx).trim().is_empty()
                    || !message.attachments.is_empty();
                let cancel_tide = tide.clone();
                let submit_tide = tide.clone();
                column = column.child(
                    div()
                        .w_full()
                        .max_w(px(540.0))
                        .rounded(px(12.0))
                        .bg(theme.raised)
                        .pt(px(9.0))
                        .pb(px(8.0))
                        .child(edit_input)
                        .child(
                            div()
                                .mt(px(7.0))
                                .px(px(12.0))
                                .flex()
                                .justify_end()
                                .gap(px(6.0))
                                .child(
                                    div()
                                        .id(SharedString::from(format!(
                                            "cancel-message-edit-{message_id}"
                                        )))
                                        .h(px(26.0))
                                        .px(px(10.0))
                                        .rounded(px(7.0))
                                        .border_1()
                                        .border_color(theme.border)
                                        .bg(theme.overlay)
                                        .flex()
                                        .items_center()
                                        .text_size(sp(12.5))
                                        .text_color(theme.text_secondary)
                                        .cursor_default()
                                        .hover(|element| element.bg(theme.overlay_strong))
                                        .child(tr_cow!("common.cancel"))
                                        .on_click(move |_, window, cx| {
                                            let _ = cancel_tide.update(cx, |this, cx| {
                                                this.cancel_message_edit(window, cx);
                                            });
                                        }),
                                )
                                .child(
                                    div()
                                        .id(SharedString::from(format!(
                                            "submit-message-edit-{message_id}"
                                        )))
                                        .h(px(26.0))
                                        .px(px(11.0))
                                        .rounded(px(7.0))
                                        .bg(if can_submit {
                                            theme.inverse
                                        } else {
                                            theme.overlay_strong
                                        })
                                        .flex()
                                        .items_center()
                                        .text_size(sp(12.5))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(if can_submit {
                                            theme.on_inverse
                                        } else {
                                            theme.text_ghost
                                        })
                                        .when(can_submit, |element| {
                                            element
                                                .cursor_default()
                                                .hover(|element| element.opacity(0.9))
                                        })
                                        .child(tr_cow!("common.send"))
                                        .on_click(move |_, _, cx| {
                                            if can_submit {
                                                let _ = submit_tide.update(cx, |this, cx| {
                                                    this.submit_message_edit(cx);
                                                });
                                            }
                                        }),
                                ),
                        ),
                );
            } else {
                if !content.trim().is_empty() {
                    let body = render_markdown_message_body(&content, markdown, theme, ctx);
                    column = column.child(
                        div()
                            .max_w(px(540.0))
                            .min_w_0()
                            .rounded(px(12.0))
                            .bg(theme.raised)
                            .px(px(12.0))
                            .py(px(8.0))
                            .text_size(sp(14.0))
                            .line_height(sp(20.0))
                            .child(body),
                    );
                }
                column = column.child(render_message_footer(
                    theme,
                    message,
                    message.created_at,
                    SharedString::from(content.clone()),
                    copied,
                    group_name,
                    false,
                    true,
                    None,
                    user_message_action,
                    tide.clone(),
                ));
            }
            column
        }
        MessageRole::Assistant => {
            let group_name = SharedString::from(format!("assistant-message-{message_id}"));
            let body = render_markdown_message_body(&content, markdown, theme, ctx);
            let mut column = div()
                .w_full()
                .min_w_0()
                .flex()
                .flex_col()
                .py(px(4.0))
                .gap(px(3.0))
                .group(group_name.clone())
                .child(body);
            // Turn-backed responses render one footer after every ordered row
            // in the turn. Only legacy/unkeyed assistant messages retain an
            // inline footer because they have no turn boundary to target.
            if message.turn_id.is_none()
                && let Some(copy_content) = assistant_footer_copy_content
            {
                column = column.child(render_message_footer(
                    theme,
                    message,
                    assistant_footer_time.unwrap_or(message.created_at),
                    copy_content,
                    copied,
                    group_name,
                    false,
                    false,
                    assistant_message_action,
                    None,
                    tide.clone(),
                ));
            }
            column
        }
        MessageRole::System => div().w_full().flex().justify_center().child(
            div()
                .px(px(10.0))
                .py(px(4.0))
                .rounded_full()
                .bg(theme.overlay)
                .text_size(sp(12.5))
                .line_height(sp(16.0))
                .child(md::render::plain_text(
                    content.clone(),
                    md::render::SANS_FAMILY,
                    FontWeight::NORMAL,
                    theme.text_tertiary,
                    ctx,
                )),
        ),
    };

    let selection = ctx.selection().clone();
    context_menu(
        element.id(message_id),
        SharedString::from(format!("message-menu-{message_id}")),
        &menu,
        move |cx| {
            message_menu_items(
                &menu_copy_content,
                role,
                user_message_action,
                assistant_message_action,
                &selection,
                &composer,
                &tide,
                cx,
            )
        },
    )
}

/// The message row's context menu. Rebuilt on each open, so availability checks
/// here always reflect the current session state.
#[allow(clippy::too_many_arguments)]
fn message_menu_items(
    content: &str,
    role: MessageRole,
    user_message_action: Option<UserMessageAction>,
    assistant_message_action: Option<AssistantMessageAction>,
    selection: &TranscriptSelection,
    composer: &Entity<ChatComposer>,
    tide: &gpui::WeakEntity<Tide>,
    _cx: &mut App,
) -> Vec<MenuItem> {
    let mut items = Vec::new();

    if let Some(selected) = selection.selection.borrow().selected_text() {
        items.push(MenuItem::new(tr!("common.copy_selection"), move |_, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(selected.clone()));
        }));
    }

    let copy_content = content.to_owned();
    items.push(MenuItem::new(
        tr!("common.copy_message_title"),
        move |_, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(copy_content.clone()));
        },
    ));

    if role == MessageRole::User && user_message_action.is_none() {
        let composer = composer.clone();
        let edit_content = content.to_owned();
        items.push(MenuItem::new(
            tr!("common.copy_to_composer"),
            move |window, cx| {
                composer.update(cx, |composer, cx| {
                    composer.set_content(edit_content.clone(), cx);
                });
                let focus_handle = composer.read(cx).focus();
                window.focus(&focus_handle, cx);
            },
        ));
    }

    if let Some(code) = fenced_code(content) {
        items.push(MenuItem::new(tr!("common.copy_code"), move |_, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(code.clone()));
        }));
    }

    if let Some(action) = user_message_action {
        let tide = tide.clone();
        items.push(MenuItem::Separator);
        items.push(
            MenuItem::new(tr!("session.revert_to_here_title"), move |window, cx| {
                let _ = tide.update(cx, |this, cx| {
                    this.begin_message_edit(action, window, cx);
                });
            })
            .icon("icons/rewind.svg"),
        );
    }

    if let Some(action) = assistant_message_action {
        let tide = tide.clone();
        items.push(MenuItem::Separator);
        items.push(
            MenuItem::new(
                if action.enabled {
                    tr!("session.fork_task_title")
                } else {
                    tr!("session.forking_task_title")
                },
                move |_, cx| {
                    let _ = tide.update(cx, |this, cx| {
                        this.fork_session_from_response(action.session_id, action.turn_count, cx);
                    });
                },
            )
            .icon("icons/fork.svg")
            .disabled(!action.enabled),
        );
    }

    items
}

pub(in crate::app) fn fenced_code(content: &str) -> Option<String> {
    let mut code_blocks = Vec::new();
    let mut segments = content.split("```");
    let _ = segments.next();
    while let Some(fenced) = segments.next() {
        let (language, code) = fenced
            .split_once('\n')
            .map(|(language, code)| (language.trim(), code))
            .unwrap_or(("", fenced));
        let code = if language.is_empty() && !fenced.contains('\n') {
            fenced
        } else {
            code
        };
        if !code.trim().is_empty() {
            code_blocks.push(code.trim_end().to_owned());
        }
        let _ = segments.next();
    }
    (!code_blocks.is_empty()).then(|| code_blocks.join("\n\n"))
}

#[cfg(test)]
mod message_time_tests {
    use super::*;

    use chrono::TimeZone;

    fn local_datetime(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("test date should be valid in the local timezone")
    }

    fn unix_seconds(timestamp: DateTime<Local>) -> u64 {
        timestamp
            .timestamp()
            .try_into()
            .expect("test date should have a positive Unix timestamp")
    }

    #[test]
    fn message_time_includes_calendar_context_for_older_messages() {
        let now = local_datetime(2026, 8, 9, 16, 0); // Sunday

        assert_eq!(
            format_message_time_at(unix_seconds(local_datetime(2026, 8, 9, 9, 5)), now),
            "9:05 AM"
        );
        assert_eq!(
            format_message_time_at(unix_seconds(local_datetime(2026, 8, 8, 17, 0)), now),
            "Yesterday 5:00 PM"
        );
        assert_eq!(
            format_message_time_at(unix_seconds(local_datetime(2026, 8, 7, 13, 12)), now),
            "Friday 1:12 PM"
        );
        assert_eq!(
            format_message_time_at(unix_seconds(local_datetime(2026, 5, 12, 23, 0)), now),
            "May 12th, 11:00 PM"
        );
        assert_eq!(
            format_message_time_at(unix_seconds(local_datetime(2024, 8, 4, 11, 0)), now),
            "Aug 4th 2024, 11:00 AM"
        );
    }

    #[test]
    fn message_time_uses_correct_ordinal_suffixes() {
        let now = local_datetime(2026, 8, 9, 16, 0);

        for (day, suffix) in [
            (1, "st"),
            (2, "nd"),
            (3, "rd"),
            (11, "th"),
            (12, "th"),
            (13, "th"),
            (21, "st"),
        ] {
            let formatted =
                format_message_time_at(unix_seconds(local_datetime(2026, 5, day, 9, 0)), now);
            assert!(formatted.starts_with(&format!("May {day}{suffix},")));
        }
    }
}
