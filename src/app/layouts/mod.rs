//! Structural layouts: window frame, panel geometry, and screen split
//! geometry. Layouts receive already-available values and children; they
//! never load data or mutate session state.

pub(in crate::app) mod panels;
pub(in crate::app) mod settings;
pub(in crate::app) mod window;
