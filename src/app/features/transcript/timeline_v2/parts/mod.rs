//! The tool-card parts: one file per tide part anatomy, each pairing pure
//! helpers (tested) with its renderer (visual). The row model stays in
//! `rows.rs`; parts only render what the rows hand them.

pub(crate) mod diff_rows;
pub(crate) mod question_card;
pub(crate) mod reasoning_part;
pub(crate) mod static_tool_row;
pub(crate) mod text_part;
pub(crate) mod tool_part;
pub(crate) mod user_bubble;

pub(crate) use reasoning_part::{render_reasoning_body, render_reasoning_header};
pub(crate) use static_tool_row::{ActivityPresentation, presentation_for};
pub(crate) use tool_part::{disclosure_id, has_body, render_activity_body, render_activity_header};
