//! Root-owned state groups (design 8): plain structs held by the `Tide`
//! entity, one per shell concern, moved one group at a time.

use std::collections::HashMap;
use std::time::Instant;
use uuid::Uuid;

/// Transient shell feedback and instrumentation: copy-button acknowledgement
/// generations and the FPS counter.
pub(in crate::app) struct ShellState {
    pub(in crate::app) copied_control_feedback: HashMap<String, u64>,
    pub(in crate::app) copied_control_generation: u64,
    pub(in crate::app) copied_message_feedback: HashMap<Uuid, u64>,
    pub(in crate::app) copied_message_generation: u64,
    pub(in crate::app) fps_counter_visible: bool,
    pub(in crate::app) fps_last_frame: Instant,
    pub(in crate::app) fps_frame_count: u64,
    pub(in crate::app) fps_value: u32,
}

impl ShellState {
    pub(in crate::app) fn new() -> Self {
        Self {
            copied_control_feedback: HashMap::new(),
            copied_control_generation: 0,
            copied_message_feedback: HashMap::new(),
            copied_message_generation: 0,
            fps_counter_visible: false,
            fps_last_frame: Instant::now(),
            fps_frame_count: 0,
            fps_value: 0,
        }
    }
}
