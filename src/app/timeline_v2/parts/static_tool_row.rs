//! How an activity renders inside the block. Every tool — bash/edit/task and
//! the read-only families (reads, searches, fetches, listings) alike —
//! renders as an expandable card; only reasoning differs, keeping its own
//! dim disclosure treatment ([`super::reasoning_part`]). Pure helper; the
//! renderers fold the classification into rows whose clicks the list
//! attaches — it owns the `Tide` context the disclosure toggle needs.

use crate::model::{ActivityItem, ActivityKind};

/// How an activity renders inside the block: a full card (every tool family
/// — the read-only ones included, since their bodies render the captured
/// content) or the reasoning part — its own dim disclosure treatment,
/// rendered by [`super::reasoning_part`] rather than the card path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ActivityPresentation {
    Card,
    Reasoning,
}

/// Classify one activity's presentation. Everything but reasoning is a
/// card: the read-only families (Read/Search/Web) included, because their
/// expanded bodies render the captured content — file text, search hits,
/// fetched pages, media captures — in the shared content viewport
/// (`tool_part::content_section`).
pub(crate) fn presentation_for(activity: &ActivityItem) -> ActivityPresentation {
    if activity.kind == ActivityKind::Reasoning {
        return ActivityPresentation::Reasoning;
    }
    ActivityPresentation::Card
}
