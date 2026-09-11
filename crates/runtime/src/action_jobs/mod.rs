//! Session-owned project action jobs.

#[cfg(unix)]
mod unix;

#[cfg(unix)]
pub use unix::*;

#[cfg(not(unix))]
mod unsupported {
    /// Project action process groups currently rely on Unix job control.
    pub fn start(
        _session_id: &str,
        _project_id: &str,
        _project_path: &str,
        _action_name: &str,
        _command: &str,
    ) -> Result<String, String> {
        Err("project actions are not supported on this platform".into())
    }

    pub fn stop(_session_id: &str, _job_id: &str) -> Result<(), String> {
        Err("project actions are not supported on this platform".into())
    }

    pub fn list(
        _session_id: &str,
    ) -> (
        Vec<protocol::model::BackgroundWorkItem>,
        Vec<protocol::model::ActionRunWire>,
    ) {
        (Vec::new(), Vec::new())
    }

    pub fn adopt_orphans() {}
}

#[cfg(not(unix))]
pub use unsupported::*;
