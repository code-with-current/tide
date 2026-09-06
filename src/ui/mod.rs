use gpui::{
    AnyElement, App, Context, Div, ElementId, Hsla, Img, InteractiveElement, Interactivity,
    KeyDownEvent, ParentElement, PathBuilder, Pixels, RenderOnce, ScrollHandle, SharedString,
    Stateful, StyleRefinement, Styled, Svg, Window, canvas, div, img, point, prelude::*, px, rgb,
    svg,
};

pub mod badge;
pub mod brand;
pub mod card;
pub mod chip;
pub mod dots;
pub mod empty_state;
pub mod menu;
pub mod modal;
pub mod motion;
pub mod pixel_loader;
pub mod scroll_fade;
pub mod scrollbar;
pub mod text;
pub mod text_field;
pub mod tooltip;

use crate::model::{ActivityKind, ProviderKind, SessionStatus};
use crate::theme::{Theme, sp};

/// A monochrome icon from the embedded set, tinted via text color. Sized in
/// `sp` so icons keep pace with the chrome text they sit beside when the UI
/// font size setting moves.
pub fn icon(path: &'static str, size: f32, color: Hsla) -> Svg {
    svg()
        .path(path)
        .w(sp(size))
        .h(sp(size))
        .flex_none()
        .text_color(color)
}

/// A polychrome file icon rendered as an image so the SVG's authored colors
/// are preserved. GPUI's `svg()` element intentionally renders an alpha mask
/// tinted with one text color.
pub fn file_icon(path: &'static str, size: f32) -> Img {
    img(path).w(sp(size)).h(sp(size)).flex_none()
}

/// A compact ghost icon button: the only button shape outside the composer's
/// bespoke send control.
pub fn icon_button(id: impl Into<ElementId>, path: &'static str, theme: Theme) -> Stateful<Div> {
    div()
        .id(id)
        .size(px(22.0))
        .rounded(px(6.0))
        .flex()
        .items_center()
        .justify_center()
        .cursor_default()
        .hover(|element| element.bg(theme.overlay))
        .active(|element| element.bg(theme.overlay_strong))
        .child(icon(path, 13.0, theme.text_tertiary))
}

/// Keeps a wheel gesture in a nested scrollable while it can consume the
/// delta, then lets it chain to the ancestor at either boundary. Call from an
/// `on_scroll_wheel` listener. GPUI's own scroll handler runs first during the
/// bubble phase, so an offset outside the clamped range means this event tried
/// to move past the top or bottom and must keep bubbling. A viewport whose
/// content fits also keeps chaining so short blocks do not dead-zone the page.
/// Stopping propagation skips wheel listeners pushed earlier on the same
/// element, so fold any sibling wheel logic into the listener that calls this.
pub fn contain_scroll(handle: &ScrollHandle, cx: &mut App) {
    if nested_scroll_consumed_delta(handle.offset().y, handle.max_offset().y) {
        cx.stop_propagation();
    }
}

fn nested_scroll_consumed_delta(offset: Pixels, max_offset: Pixels) -> bool {
    max_offset > px(0.5) && offset >= -max_offset && offset <= px(0.0)
}

/// Move a list selection by `delta` with arrow semantics: single steps wrap
/// around at both ends, while page jumps and `isize::MIN`/`MAX` (home/end)
/// clamp to the edges. Returns `None` for an empty list.
pub fn next_selection_index(selected: usize, len: usize, delta: isize) -> Option<usize> {
    if len == 0 {
        return None;
    }
    let selected = selected.min(len - 1);
    Some(if delta == isize::MIN {
        0
    } else if delta == isize::MAX {
        len - 1
    } else if delta.unsigned_abs() > 1 {
        (selected as isize + delta).clamp(0, len.saturating_sub(1) as isize) as usize
    } else {
        (selected as isize + delta).rem_euclid(len as isize) as usize
    })
}

/// Add conventional mouse and keyboard activation to a focusable element.
pub trait ActivationExt: Sized {
    fn on_activation<E>(
        self,
        cx: &mut Context<E>,
        activate: impl Fn(&mut E, &mut Window, &mut Context<E>) + 'static,
    ) -> Self
    where
        E: 'static;
}

impl ActivationExt for Stateful<Div> {
    fn on_activation<E>(
        self,
        cx: &mut Context<E>,
        activate: impl Fn(&mut E, &mut Window, &mut Context<E>) + 'static,
    ) -> Self
    where
        E: 'static,
    {
        let activate = std::rc::Rc::new(activate);
        let click_activate = activate.clone();
        let key_activate = activate;
        self.on_click(cx.listener(move |this, _, window, cx| {
            click_activate(this, window, cx);
            cx.stop_propagation();
        }))
        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
            // Bare Enter/Space only. A modified chord belongs to whatever
            // command owns it, so a focused control must not swallow it —
            // this is the guard the hand-rolled settings toggles carried
            // before they moved onto this helper.
            if !event.keystroke.modifiers.modified()
                && matches!(event.keystroke.key.as_str(), "enter" | "space")
            {
                key_activate(this, window, cx);
                cx.stop_propagation();
            }
        }))
    }
}

/// The shared pill switch used by settings and automation forms.
///
/// `activate` is ignored while `disabled` is true, but the control remains in
/// the tab order so a pending operation does not move focus unexpectedly.
pub fn toggle_switch<E>(
    id: impl Into<ElementId>,
    on: bool,
    disabled: bool,
    theme: Theme,
    cx: &mut Context<E>,
    activate: impl Fn(&mut E, &mut Window, &mut Context<E>) + 'static,
) -> Stateful<Div>
where
    E: 'static,
{
    let base = div()
        .id(id)
        .tab_index(0)
        .focus_visible(|style| style.border_color(theme.accent))
        .w(px(36.0))
        .h(px(20.0))
        .p(px(2.0))
        .flex_none()
        .rounded_full()
        .cursor_default()
        .when(disabled, |element| element.opacity(0.55))
        .bg(if on { theme.inverse } else { theme.inset })
        .border_1()
        .border_color(if on {
            theme.inverse
        } else {
            theme.border_strong
        })
        .flex()
        .items_center()
        .when(on, |element| element.justify_end())
        .child(div().w(px(14.0)).h(px(14.0)).rounded_full().bg(if on {
            theme.on_inverse
        } else {
            theme.text_tertiary
        }));

    if disabled {
        base
    } else {
        base.on_activation(cx, activate)
    }
}

/// Brand hue for the tide mark: theme-adaptive ink, like tide's own glyph.
pub fn provider_color(theme: &Theme, _provider: ProviderKind) -> Hsla {
    if theme.is_dark {
        rgb(0xF3F3F3).into()
    } else {
        rgb(0x34363B).into()
    }
}

/// The tide mark, matching the model picker vocabulary.
pub fn provider_icon(_provider: ProviderKind) -> &'static str {
    "icons/provider-tide.svg"
}

pub fn status_color(theme: &Theme, status: SessionStatus) -> Hsla {
    match status {
        SessionStatus::Idle => theme.text_ghost,
        SessionStatus::Connecting | SessionStatus::Working => theme.accent,
        SessionStatus::Waiting => theme.warning,
        SessionStatus::Failed => theme.danger,
    }
}

pub fn activity_icon(kind: ActivityKind) -> &'static str {
    match kind {
        ActivityKind::Reasoning => "icons/sparkle.svg",
        ActivityKind::Command => "icons/terminal.svg",
        ActivityKind::FileChange => "icons/pencil.svg",
        ActivityKind::FileRead => "icons/file.svg",
        ActivityKind::FileSearch => "icons/search.svg",
        ActivityKind::FileList => "icons/folder.svg",
        ActivityKind::Search => "icons/search.svg",
        ActivityKind::Plan => "icons/list.svg",
        ActivityKind::Compact => "icons/rewind.svg",
        ActivityKind::Tool => "icons/wrench.svg",
    }
}

pub fn activity_noun(kind: ActivityKind) -> (String, String) {
    match kind {
        ActivityKind::Reasoning => (tr!("activity.thought"), tr!("activity.thoughts")),
        ActivityKind::Command => (tr!("activity.command"), tr!("activity.commands")),
        ActivityKind::FileChange => (tr!("activity.file_edit"), tr!("activity.file_edits")),
        ActivityKind::FileRead => (tr!("activity.file_read"), tr!("activity.file_reads")),
        ActivityKind::FileSearch => (tr!("activity.file_search"), tr!("activity.file_searches")),
        ActivityKind::FileList => (tr!("activity.file_list"), tr!("activity.file_lists")),
        ActivityKind::Search => (tr!("activity.search"), tr!("activity.searches")),
        ActivityKind::Plan => (tr!("activity.plan_step"), tr!("activity.plan_steps")),
        ActivityKind::Compact => (tr!("activity.compaction"), tr!("activity.compactions")),
        ActivityKind::Tool => (tr!("activity.tool_call"), tr!("activity.tool_calls")),
    }
}

/// A compact chip used as a dropdown-menu trigger. `selected` is driven by the
/// menu's open state and renders as a soft fill.
#[derive(IntoElement)]
pub struct MenuChip {
    base: Stateful<Div>,
    icon: Option<(&'static str, Hsla)>,
    /// A custom leading element taking the icon slot's place — for triggers
    /// whose mark is richer than a tinted glyph (brand tiles).
    leading: Option<AnyElement>,
    label: SharedString,
    caret: bool,
    outlined: bool,
    selected: bool,
    disabled: bool,
    height: Option<Pixels>,
    background: Option<Hsla>,
}

impl MenuChip {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            base: div().id(id),
            icon: None,
            leading: None,
            label: SharedString::default(),
            caret: true,
            outlined: false,
            selected: false,
            disabled: false,
            height: None,
            background: None,
        }
    }

    /// Override the chip's fixed height, for rows whose controls share a
    /// different one.
    pub fn height(mut self, height: Pixels) -> Self {
        self.height = Some(height);
        self
    }

    /// Fill behind an outlined chip. The default matches raised cards; a
    /// chip sitting directly on another surface passes that surface here so
    /// it doesn't read as a filled pill.
    pub fn background(mut self, background: Hsla) -> Self {
        self.background = Some(background);
        self
    }

    pub fn icon(mut self, path: &'static str, color: Hsla) -> Self {
        self.icon = Some((path, color));
        self
    }

    /// Replace the icon slot with an arbitrary element; takes precedence
    /// over [`MenuChip::icon`].
    pub fn leading_element(mut self, element: impl IntoElement) -> Self {
        self.leading = Some(element.into_any_element());
        self
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = label.into();
        self
    }

    pub fn outlined(mut self) -> Self {
        self.outlined = true;
        self
    }

    pub fn caret(mut self, caret: bool) -> Self {
        self.caret = caret;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Soft fill marking the chip as the open menu's trigger.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
}

impl Styled for MenuChip {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl InteractiveElement for MenuChip {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.base.interactivity()
    }
}

impl ParentElement for MenuChip {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.base.extend(elements);
    }
}

impl RenderOnce for MenuChip {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::current(cx);
        let leading = self.leading;
        let glyph = self.icon;
        let has_leading = leading.is_some();
        self.base
            .h(self
                .height
                .unwrap_or(if self.outlined { px(30.0) } else { px(26.0) }))
            .px(if self.outlined { px(10.0) } else { px(7.0) })
            .rounded(if self.outlined { px(7.0) } else { px(6.0) })
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_size(sp(13.0))
            .line_height(sp(16.0))
            .cursor_default()
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .when(self.outlined, |element| {
                element
                    .border_1()
                    .border_color(theme.border_strong)
                    .bg(self.background.unwrap_or(theme.raised))
            })
            .when(self.selected, |element| element.bg(theme.overlay))
            .when(!self.disabled, |element| {
                element.hover(|element| element.bg(theme.overlay))
            })
            .when(self.disabled, |element| element.opacity(0.7))
            .when_some(leading, |element, leading| element.child(leading))
            .when(!has_leading, |element| {
                element.when_some(glyph, |element, (path, color)| {
                    element.child(icon(path, 12.0, color))
                })
            })
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_color(theme.text_secondary)
                    .child(self.label),
            )
            .when(self.caret, |element| {
                element.child(icon("icons/chevron-down.svg", 10.5, theme.text_ghost))
            })
    }
}

/// An inline, link-like dropdown trigger used for the project name in the
/// empty-state headline.
#[derive(IntoElement)]
pub struct ProjectNameSelector {
    base: Stateful<Div>,
    label: SharedString,
    selected: bool,
}

impl ProjectNameSelector {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            base: div().id(id),
            label: label.into(),
            selected: false,
        }
    }

    /// Emphasised underline while its menu is open.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
}

impl Styled for ProjectNameSelector {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl InteractiveElement for ProjectNameSelector {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.base.interactivity()
    }
}

impl ParentElement for ProjectNameSelector {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.base.extend(elements);
    }
}

impl RenderOnce for ProjectNameSelector {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::current(cx);
        let underline_color = if self.selected {
            theme.text_secondary
        } else {
            theme.text_tertiary
        };

        self.base
            .relative()
            .flex_none()
            .cursor_default()
            .focus_visible(|style| style.border_1().border_color(theme.accent))
            .child(self.label)
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, _| {
                        let y = bounds.origin.y + bounds.size.height - px(0.5);
                        let mut builder =
                            PathBuilder::stroke(px(1.0)).dash_array(&[px(1.0), px(2.0)]);
                        builder.move_to(point(bounds.origin.x, y));
                        builder.line_to(point(bounds.origin.x + bounds.size.width, y));
                        if let Ok(line) = builder.build() {
                            window.paint_path(line, underline_color);
                        }
                    },
                )
                .absolute()
                .inset_0(),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_scroll_chains_only_after_reaching_a_boundary() {
        let max_offset = px(100.0);

        assert!(nested_scroll_consumed_delta(px(0.0), max_offset));
        assert!(nested_scroll_consumed_delta(px(-50.0), max_offset));
        assert!(nested_scroll_consumed_delta(px(-100.0), max_offset));
        assert!(!nested_scroll_consumed_delta(px(1.0), max_offset));
        assert!(!nested_scroll_consumed_delta(px(-101.0), max_offset));
        assert!(!nested_scroll_consumed_delta(px(0.0), px(0.0)));
    }

    #[test]
    fn arrows_wrap_while_page_and_boundary_keys_clamp() {
        assert_eq!(next_selection_index(0, 5, -1), Some(4));
        assert_eq!(next_selection_index(4, 5, 1), Some(0));
        assert_eq!(next_selection_index(3, 5, 7), Some(4));
        assert_eq!(next_selection_index(1, 5, -7), Some(0));
        assert_eq!(next_selection_index(2, 5, isize::MIN), Some(0));
        assert_eq!(next_selection_index(2, 5, isize::MAX), Some(4));
        assert_eq!(next_selection_index(0, 0, 1), None);
    }

    #[test]
    fn every_referenced_icon_is_embedded() {
        use crate::assets::Assets;
        use crate::model::{ActivityKind, ProviderKind};
        use gpui::AssetSource;

        let mut paths = vec![
            "icons/panel-left.svg",
            "icons/plus.svg",
            "icons/arrow-left.svg",
            "icons/arrow-right.svg",
            "icons/arrow-up.svg",
            "icons/stop.svg",
            "icons/check.svg",
            "icons/copy.svg",
            "icons/rewind.svg",
            "icons/fork.svg",
            "icons/git-branch.svg",
            "icons/chart-column.svg",
            "icons/chevron-down.svg",
            "icons/chevron-right.svg",
            "icons/chevron-up.svg",
            "icons/chevrons-up-down.svg",
            "icons/folder.svg",
            "icons/folder-new.svg",
            "icons/laptop.svg",
            "icons/file-diff.svg",
            "icons/globe.svg",
            "icons/alert.svg",
            "icons/lock.svg",
            "icons/lock-open.svg",
            "icons/star.svg",
            "icons/star-filled.svg",
            "icons/sparkle.svg",
            "icons/zap.svg",
            "icons/panel-right.svg",
            "icons/x.svg",
            "icons/bot.svg",
            "icons/rotate-cw.svg",
            "icons/package.svg",
            "icons/trash.svg",
        ];
        for provider in ProviderKind::ALL {
            paths.push(provider_icon(provider));
        }
        for kind in [
            ActivityKind::Reasoning,
            ActivityKind::Command,
            ActivityKind::FileChange,
            ActivityKind::FileRead,
            ActivityKind::FileSearch,
            ActivityKind::FileList,
            ActivityKind::Search,
            ActivityKind::Plan,
            ActivityKind::Tool,
        ] {
            paths.push(activity_icon(kind));
        }
        for path in paths {
            assert!(
                Assets.load(path).unwrap().is_some(),
                "missing embedded icon: {path}"
            );
        }
    }
}
