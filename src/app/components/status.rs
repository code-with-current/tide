//! Session status presentation: the color vocabulary shared by the
//! transcript, sidebar, inspector, and overlays.

use gpui::Hsla;

use crate::model::SessionStatus;
use crate::theme::Theme;

pub(in crate::app) fn status_color(theme: &Theme, status: SessionStatus) -> Hsla {
    match status {
        SessionStatus::Idle => theme.text_ghost,
        SessionStatus::Connecting | SessionStatus::Working => theme.accent,
        SessionStatus::Waiting => theme.warning,
        SessionStatus::Failed => theme.danger,
    }
}
