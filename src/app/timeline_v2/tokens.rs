//! tide's tools-* token layer mapped onto the app theme.

use crate::theme::Theme;

pub(crate) enum Status {
    Success,
    // The two below are mapped in `status_color` for parity with tide's
    // token set; nothing constructs them yet.
    #[allow(dead_code)]
    Warning,
    Error,
    #[allow(dead_code)]
    Info,
}

pub(crate) fn status_color(theme: &Theme, status: Status) -> gpui::Hsla {
    match status {
        Status::Success => theme.accent,
        Status::Warning => theme.warning,
        Status::Error => theme.danger,
        Status::Info => theme.text_tertiary,
    }
}

/// tide's tools-* token layer mapped onto the app theme.
/// The diff-added green — GitHub-convention, distinct from the orange
/// accent: +N counters, per-file additions, and addition-row tints.
pub(crate) fn diff_added() -> gpui::Hsla {
    gpui::rgb(0x3FB950).into()
}

/// The diff-removed red — the danger token's hue, named for symmetry.
pub(crate) fn diff_removed(theme: &Theme) -> gpui::Hsla {
    theme.danger
}

pub(crate) fn tools_dim(theme: &Theme) -> gpui::Hsla {
    theme.text_tertiary
}

pub(crate) fn tools_rail(theme: &Theme) -> gpui::Hsla {
    theme.border
}

pub(crate) fn tools_title(theme: &Theme) -> gpui::Hsla {
    theme.text
}

pub(crate) fn tools_description(theme: &Theme) -> gpui::Hsla {
    theme.text_secondary
}
