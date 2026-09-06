use protocol::{Command, ResponsePayload, WorkspaceOperation, WorkspaceResult};
use uuid::Uuid;

use crate::DaemonClient;

/// Typed convenience wrapper around daemon-owned filesystem and Git RPCs.
#[derive(Clone)]
pub struct WorkspaceClient {
    client: DaemonClient,
}

impl WorkspaceClient {
    pub fn new(client: DaemonClient) -> Self {
        Self { client }
    }

    pub fn request(&self, operation: WorkspaceOperation) -> anyhow::Result<WorkspaceResult> {
        match self
            .client
            .request(Uuid::nil(), Uuid::nil(), Command::Workspace { operation })?
        {
            ResponsePayload::Workspace { result } => Ok(result),
            _ => anyhow::bail!("Tide daemon returned an invalid workspace response"),
        }
    }
}
