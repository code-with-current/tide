//! The Projects settings page: Tide's own projects presented as a mail-style
//! master–detail split — the project list on the left, the selected project's
//! configuration (identity, icon, default model, actions, git identity,
//! memory & RAG, removal) on the right.
//!
//! All project data is already in memory (`state.projects`); only icon
//! discovery touches the filesystem, on the background executor.

use gpui::Context;

use super::*;

pub fn init(_cx: &mut App) {}

impl Tide {
    pub(super) fn render_projects_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let _ = cx;
        div().into_any_element()
    }
}
