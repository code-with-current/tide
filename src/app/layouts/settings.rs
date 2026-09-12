//! Settings screen geometry: the content width caps pages render within.

/// Width cap for most settings pages' content column.
pub(in crate::app) const SETTINGS_CONTENT_MAX_WIDTH: f32 = 760.0;
/// Width cap for the Memory page, whose cards use a wider canvas.
pub(in crate::app) const SETTINGS_MEMORY_MAX_WIDTH: f32 = 1160.0;
/// Width cap for the Usage page's statement layout.
pub(in crate::app) const SETTINGS_USAGE_MAX_WIDTH: f32 = 1024.0;
