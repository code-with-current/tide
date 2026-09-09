//! Provider fallback choices used before daemon-side discovery completes.

use crate::model::{ProviderAgentPreset, ProviderKind, ProviderModel};

pub fn fallback_models(provider: ProviderKind) -> Vec<ProviderModel> {
    match provider {
        ProviderKind::Tide => Vec::new(),
    }
}

pub fn fallback_agent_presets(provider: ProviderKind) -> Vec<ProviderAgentPreset> {
    match provider {
        ProviderKind::Tide => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tide_fallback_catalog_is_empty() {
        // Discovery is authoritative and the pre-discovery picker is empty.
        assert!(fallback_models(ProviderKind::Tide).is_empty());
        assert!(fallback_agent_presets(ProviderKind::Tide).is_empty());
    }
}
