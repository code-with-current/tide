use gpui::{Div, Hsla, ParentElement, Styled, div, hsla, px, rgb};

use crate::theme::Theme;
use crate::ui::{file_icon, icon};

/// "#rrggbb" → gpui color.
fn hex_hsla(hex: &str) -> Hsla {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 {
        return hsla(0.0, 0.0, 0.5, 1.0);
    }
    let channel = |range: std::ops::Range<usize>| u32::from_str_radix(&hex[range], 16).unwrap_or(0);
    rgb((channel(0..2) << 16) | (channel(2..4) << 8) | channel(4..6)).into()
}

const MULTICOLOR_LOGOS: [&str; 6] = [
    "logo-google",
    "logo-openrouter",
    "logo-together",
    "logo-fireworks",
    "logo-zai",
    "logo-opencode",
];

/// tide's ProviderLogo mapping from provider logo key to embedded asset.
pub fn logo_path(logo: &str) -> &'static str {
    match logo {
        "logo-google" => "icons/logo-google.svg",
        "logo-openrouter" => "icons/logo-openrouter.svg",
        "logo-together" => "icons/logo-together.svg",
        "logo-fireworks" => "icons/logo-fireworks.svg",
        "logo-zai" => "icons/logo-zai.svg",
        "logo-opencode" => "icons/logo-opencode.svg",
        "logo-anthropic" => "icons/logo-anthropic.svg",
        "logo-openai" => "icons/logo-openai.svg",
        "logo-xai" => "icons/logo-xai.svg",
        "logo-groq" => "icons/logo-groq.svg",
        "logo-lmstudio" => "icons/logo-lmstudio.svg",
        "logo-ollama" => "icons/logo-ollama.svg",
        "logo-deepseek" => "icons/logo-deepseek.svg",
        "logo-mistral" => "icons/logo-mistral.svg",
        _ => "icons/plug.svg",
    }
}

/// The brand mark on its tinted tile: monochrome marks tint white over the
/// accent; multicolor marks render as authored images on a neutral tile —
/// tide's exact ProviderLogo rules.
pub fn brand_tile(logo: &str, accent: &str, tile: f32, mark: f32, theme: &Theme) -> Div {
    let white_accent =
        accent.eq_ignore_ascii_case("#ffffff") || accent.eq_ignore_ascii_case("#f3f3f3");
    let mut element = div()
        .w(px(tile))
        .h(px(tile))
        .rounded(px(tile * 0.28))
        .flex()
        .items_center()
        .justify_center()
        .flex_none();
    if MULTICOLOR_LOGOS.contains(&logo) {
        element = element
            .bg(theme.overlay)
            .child(file_icon(logo_path(logo), mark));
    } else if white_accent {
        element = element
            .bg(theme.overlay)
            .child(icon(logo_path(logo), mark, theme.text));
    } else {
        element = element.bg(hex_hsla(accent)).child(icon(
            logo_path(logo),
            mark,
            hsla(0.0, 0.0, 1.0, 1.0),
        ));
    }
    element
}
