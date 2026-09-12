//! Product features: state, behavior, and rendering for one user-facing
//! capability each. Features may depend on app components and UI primitives,
//! never on screens.

pub(in crate::app) mod browser;
pub(in crate::app) mod composer;
pub(in crate::app) mod git;
pub(in crate::app) mod sessions;
pub(in crate::app) mod transcript;
