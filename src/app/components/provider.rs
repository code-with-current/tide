//! Provider brand presentation: the mark and hue used wherever a provider is
//! named — pickers, palette, composer, and settings.

use gpui::{Hsla, rgb};

use crate::model::ProviderKind;
use crate::theme::Theme;

/// Brand hue for the tide mark: theme-adaptive ink, like tide's own glyph.
pub(in crate::app) fn provider_color(theme: &Theme, _provider: ProviderKind) -> Hsla {
    if theme.is_dark {
        rgb(0xF3F3F3).into()
    } else {
        rgb(0x34363B).into()
    }
}

/// The tide mark, matching the model picker vocabulary.
pub(in crate::app) fn provider_icon(_provider: ProviderKind) -> &'static str {
    "icons/provider-tide.svg"
}

#[cfg(test)]
mod tests {
    use crate::assets::Assets;
    use crate::model::ProviderKind;
    use gpui::AssetSource;

    #[test]
    fn every_provider_icon_is_embedded() {
        for provider in ProviderKind::ALL {
            let path = super::provider_icon(provider);
            assert!(
                Assets.load(path).unwrap().is_some(),
                "missing embedded icon: {path}"
            );
        }
    }
}
