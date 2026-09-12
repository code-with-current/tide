//! Tide-domain components shared by at least two features or screens. These
//! units receive explicit data and callbacks; they never depend on the `Tide`
//! root entity or perform I/O.

pub(in crate::app) mod project_identity;
pub(in crate::app) mod provider;
pub(in crate::app) mod status;
