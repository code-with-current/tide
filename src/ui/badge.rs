use gpui::{Div, ParentElement, SharedString, Styled, div, px};

use crate::theme::{Theme, sp};

/// An outline badge chip, port of tide's `<Badge variant="outline">` with the
/// upstream uppercase treatment. The label arrives already final; host names
/// and protocol names keep their own casing rules upstream too.
pub fn badge(label: &str, theme: Theme) -> Div {
    div()
        .px(px(5.0))
        .py(px(1.0))
        .rounded(px(4.0))
        .border_1()
        .border_color(theme.border_strong)
        .flex_none()
        .text_size(sp(9.5))
        .text_color(theme.text_tertiary)
        .child(SharedString::from(label.to_uppercase()))
}
