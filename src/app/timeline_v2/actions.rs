//! Everything a row may ask the app to do — tide's panel-actions-context.
//! Built once per frame in `render_timeline_v2`; rows never touch `Tide`.

use std::sync::Arc;

/// Callback handles a target: file path (view_file/view_diff) or dispatch id
/// (open_dispatch).
pub(crate) struct TranscriptActions {
    pub view_file: Arc<dyn Fn(&str, &mut gpui::Window, &mut gpui::App) + Send + Sync>,
    pub view_diff: Arc<dyn Fn(&str, &mut gpui::Window, &mut gpui::App) + Send + Sync>,
    pub open_dispatch: Arc<dyn Fn(&str, &mut gpui::Window, &mut gpui::App) + Send + Sync>,
}

impl TranscriptActions {
    /// Placeholder constructor: every action is a no-op. The pane mounts
    /// real handlers now, so only the row renderers' unit tests build one.
    #[cfg(test)]
    pub fn no_op() -> Self {
        fn no_op(_: &str, _: &mut gpui::Window, _: &mut gpui::App) {}
        Self {
            view_file: Arc::new(no_op),
            view_diff: Arc::new(no_op),
            open_dispatch: Arc::new(no_op),
        }
    }
}
