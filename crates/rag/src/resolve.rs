//! Embedder resolution — generalized from `app/core/rag/resolve.ts`.
//! Build time resolves the CONFIGURED embedder (catalog id, `cloud-base`,
//! or `custom-*`), falling back to cloud only when the primary is
//! unavailable + cloudAllowed + cloud configured. Query time resolves the
//! embedder matching the INDEX's recorded id — never cross (a local-built
//! index whose model was deleted is a "rebuild required" error; crossing
//! vector spaces would yield garbage scores).

use std::path::Path;
use std::sync::Arc;

use crate::catalog;
use crate::embedder::{
    cloud_configured, local_embedder_shared, local_model_exists_for, Embedder, RemoteEmbedder,
};

/// A custom endpoint as the backend resolved it — credentials decrypted,
/// dims measured at add time. The rag crate never sees the secrets store.
#[derive(Debug, Clone)]
pub struct CustomEndpointSpec {
    pub id: String,
    pub base_url: String,
    pub model_id: String,
    pub api_key: String,
    pub dims: usize,
    pub max_tokens: usize,
}

/// The hydrated global RAG config (RagSettings.effective() in the store
/// crate; defaults match the pre-config behavior).
#[derive(Debug, Clone)]
pub struct RagConfigInput {
    pub embedder_id: String,
    pub cloud_allowed: bool,
    pub cloud_model_id: Option<String>,
    pub custom_endpoints: Vec<CustomEndpointSpec>,
}

impl Default for RagConfigInput {
    fn default() -> Self {
        Self {
            embedder_id: "local-code-512".into(),
            cloud_allowed: false,
            cloud_model_id: None,
            custom_endpoints: Vec::new(),
        }
    }
}

fn custom_spec<'a>(config: &'a RagConfigInput, id: &str) -> Option<&'a CustomEndpointSpec> {
    config.custom_endpoints.iter().find(|e| e.id == id)
}

/// Build-time resolution of the configured embedder. `Err` strings surface
/// in "RAG unavailable" states.
pub fn resolve_for_build(
    config: &RagConfigInput,
    data_dir: &Path,
) -> Result<Arc<dyn Embedder>, String> {
    // A configured custom endpoint always wins over the fallback chain —
    // its dims were verified at add time.
    if let Some(spec) = custom_spec(config, &config.embedder_id) {
        return Ok(Arc::new(RemoteEmbedder::custom(
            &spec.id,
            &spec.base_url,
            &spec.model_id,
            &spec.api_key,
            spec.dims,
            spec.max_tokens,
        )));
    }
    if let Some(entry) = catalog::entry(&config.embedder_id) {
        if local_model_exists_for(entry, data_dir) {
            return Ok(local_embedder_shared(entry, data_dir));
        }
        // Same fallback as the TS resolve: local unavailable → cloud only
        // when allowed + configured.
        if config.cloud_allowed && cloud_configured() {
            return Ok(Arc::new(RemoteEmbedder::system(config.cloud_model_id.clone())));
        }
        if !config.cloud_allowed {
            return Err(format!(
                "Model {} is not downloaded and cloud fallback is disabled. \
                 Download it from the Memory & RAG settings or enable \
                 \"Allow cloud as build-time fallback\".",
                entry.repo
            ));
        }
        return Err(
            "Local embedder unavailable and cloud is not configured (TIDE_SYSTEM_API_KEY missing)."
                .to_string(),
        );
    }
    if config.embedder_id == "cloud-base" {
        if !cloud_configured() {
            return Err(
                "Cloud embedder selected but TIDE_SYSTEM_API_KEY is not set.".to_string()
            );
        }
        return Ok(Arc::new(RemoteEmbedder::system(config.cloud_model_id.clone())));
    }
    Err(format!(
        "Unknown embedder \"{}\" — it was removed from the configuration. \
         Pick another model from the Memory & RAG settings.",
        config.embedder_id
    ))
}

/// Query-time resolution against an index's recorded embedder id. Never
/// crosses vector spaces and never consults the fallback chain — the index
/// must be queried by exactly what built it.
pub fn resolve_for_query(
    index_embedder_id: &str,
    config: &RagConfigInput,
    data_dir: &Path,
) -> Result<Arc<dyn Embedder>, String> {
    if let Some(entry) = catalog::entry(index_embedder_id) {
        if local_model_exists_for(entry, data_dir) {
            return Ok(local_embedder_shared(entry, data_dir));
        }
        return Err(format!(
            "Index was built with {}, which is no longer downloaded. \
             Rebuild required (re-download it or rebuild with another model).",
            entry.repo
        ));
    }
    if index_embedder_id == "cloud-base" {
        if !cloud_configured() {
            return Err(
                "Index was built with the cloud embedder, but TIDE_SYSTEM_API_KEY is no longer set."
                    .to_string(),
            );
        }
        return Ok(Arc::new(RemoteEmbedder::system(config.cloud_model_id.clone())));
    }
    if let Some(spec) = custom_spec(config, index_embedder_id) {
        return Ok(Arc::new(RemoteEmbedder::custom(
            &spec.id,
            &spec.base_url,
            &spec.model_id,
            &spec.api_key,
            spec.dims,
            spec.max_tokens,
        )));
    }
    Err(format!(
        "Index was built with \"{}\", which is no longer configured. \
         Rebuild required (restore the endpoint or rebuild with another model).",
        index_embedder_id
    ))
}

/// Convenience: build-time resolve + its id in one call (the ingest paths
/// record the id in the embedding plan).
pub fn resolve_embedder_for_build(
    config: &RagConfigInput,
    data_dir: &Path,
) -> Result<(String, Arc<dyn Embedder>), String> {
    let embedder = resolve_for_build(config, data_dir)?;
    Ok((embedder.id().to_owned(), embedder))
}

/// Convenience: query-time resolve + its id (the memory tool path).
pub fn resolve_embedder_for_query(
    index_embedder_id: &str,
    config: &RagConfigInput,
    data_dir: &Path,
) -> Result<(String, Arc<dyn Embedder>), String> {
    let embedder = resolve_for_query(index_embedder_id, config, data_dir)?;
    Ok((embedder.id().to_owned(), embedder))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        tempfile::tempdir().unwrap().keep()
    }

    #[test]
    fn build_resolves_the_vendored_default_without_any_setup() {
        let cfg = RagConfigInput::default();
        let (id, embedder) = resolve_embedder_for_build(&cfg, &dir()).unwrap();
        assert_eq!(id, "local-code-512");
        assert_eq!(embedder.dim(), 384);
    }

    #[test]
    fn build_falls_back_to_cloud_only_when_allowed_and_configured() {
        // No system key in the test env → cloud stays unconfigured; the
        // vendored default makes local always-available, so force an
        // undownloaded entry to exercise the chain.
        let mut cfg = RagConfigInput {
            embedder_id: "local-bge-m3".into(),
            ..Default::default()
        };
        let cloud = cloud_configured();
        if cloud {
            // When a system key IS present the fallback resolves.
            let (id, _) = resolve_embedder_for_build(&cfg, &dir()).unwrap();
            assert_eq!(id, "cloud-base");
        } else {
            let err = resolve_for_build(&cfg, &dir()).err().unwrap();
            assert!(
                err.contains("cloud fallback is disabled"),
                "was {err}"
            );
            cfg.cloud_allowed = true;
            let err = resolve_for_build(&cfg, &dir()).err().unwrap();
            assert!(err.contains("TIDE_SYSTEM_API_KEY"), "was {err}");
        }
    }

    #[test]
    fn build_resolves_custom_endpoints_with_declared_dims() {
        let cfg = RagConfigInput {
            embedder_id: "custom-openai".into(),
            cloud_allowed: false,
            cloud_model_id: None,
            custom_endpoints: vec![CustomEndpointSpec {
                id: "custom-openai".into(),
                base_url: "https://api.openai.com/v1/".into(),
                model_id: "text-embedding-3-small".into(),
                api_key: "sk-test".into(),
                dims: 1536,
                max_tokens: 8191,
            }],
        };
        let (id, embedder) = resolve_embedder_for_build(&cfg, &dir()).unwrap();
        assert_eq!(id, "custom-openai");
        assert_eq!(embedder.dim(), 1536);
        assert_eq!(embedder.max_tokens(), 8191);
    }

    #[test]
    fn build_rejects_unknown_embedder_ids() {
        let cfg = RagConfigInput {
            embedder_id: "custom-gone".into(),
            ..Default::default()
        };
        assert!(resolve_for_build(&cfg, &dir())
            .err().unwrap()
            .contains("Unknown embedder"));
    }

    #[test]
    fn query_never_crosses_vector_spaces() {
        let cfg = RagConfigInput::default();
        let (_, embedder) =
            resolve_embedder_for_query("local-code-512", &cfg, &dir()).unwrap();
        assert_eq!(embedder.dim(), 384);

        // Same dims, DIFFERENT model: the id lock must still block it —
        // dims alone cannot catch this switch.
        let mut e5_cfg = RagConfigInput {
            embedder_id: "local-mle5-small".into(),
            ..Default::default()
        };
        let err = resolve_for_query("local-mle5-small", &e5_cfg, &dir()).err().unwrap();
        assert!(err.contains("no longer downloaded"), "was {err}");
        e5_cfg.embedder_id = "local-code-512".into();
        // And a stale e5 index under the default config errors too.
        let err = resolve_for_query("local-mle5-small", &e5_cfg, &dir()).err().unwrap();
        assert!(err.contains("Rebuild required"), "was {err}");
    }

    #[test]
    fn query_resolves_undownloaded_catalog_model_for_rebuild_errors_only() {
        let cfg = RagConfigInput::default();
        // A bge-m3 index whose model was deleted surfaces "rebuild".
        let err = resolve_for_query("local-bge-m3", &cfg, &dir()).err().unwrap();
        assert!(err.contains("no longer downloaded"), "was {err}");
        // A cloud-built index without the key surfaces the same tone.
        let err = resolve_for_query("cloud-base", &cfg, &dir()).err().unwrap();
        assert!(err.contains("no longer set"), "was {err}");
        // A deleted custom endpoint ditto.
        let err = resolve_for_query("custom-gone", &cfg, &dir()).err().unwrap();
        assert!(err.contains("no longer configured"), "was {err}");
    }
}
