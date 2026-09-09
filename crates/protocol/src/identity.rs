//! Shared application identity used by the daemon and desktop client.

#[cfg(debug_assertions)]
pub const APP_NAME: &str = "Tide Debug";
#[cfg(not(debug_assertions))]
pub const APP_NAME: &str = "Tide";

#[cfg(debug_assertions)]
pub const APP_ID: &str = "codes.tide.dev";
#[cfg(not(debug_assertions))]
pub const APP_ID: &str = "codes.tide";

#[cfg(debug_assertions)]
pub const DATA_DIRECTORY_NAME: &str = "Tide Debug";
#[cfg(not(debug_assertions))]
pub const DATA_DIRECTORY_NAME: &str = "Tide";
