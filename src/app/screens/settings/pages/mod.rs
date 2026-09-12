//! Settings page families. Each directory owns one navigable page and its
//! state; pages may use features and app components but not sibling page
//! internals.

pub(in crate::app) mod appearance;
pub(in crate::app) mod computer_use;
pub(in crate::app) mod daemon;
pub(in crate::app) mod general;
pub(in crate::app) mod git;
pub(in crate::app) mod memory;
pub(in crate::app) mod projects;
pub(in crate::app) mod providers;
pub(in crate::app) mod skills;
pub(in crate::app) mod usage;
