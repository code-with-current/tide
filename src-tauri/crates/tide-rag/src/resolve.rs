//! Embedder resolution — port of `app/core/rag/resolve.ts` @ 91ec558.
//! Build time prefers local and falls back to cloud only when (local
//! unavailable + cloudAllowed + cloud configured); query time returns the
//! embedder matching the index's recorded embedderId — never cross (a
//! local-built index whose local runtime died is a "rebuild required"
//! error; crossing vector spaces would yield garbage scores).

use std::path::Path;
use std::sync::Arc;

use crate::embedder::{
    cloud_configured, local_model_exists, shared_local, CloudEmbedder, Embedder, LocalEmbedder,
};

/// The hydrated per-workspace RAG config (src/types RagConfig defaults).
#[derive(Debug, Clone)]
pub struct RagConfigInput {
    pub embedder_id: String,
    pub cloud_allowed: bool,
}

impl Default for RagConfigInput {
    fn default() -> Self {
        Self {
            embedder_id: "local-code-512".into(),
            cloud_allowed: false,
        }
    }
}

/// Which embedder resolved — the shared instances come from
/// [`embedder_of`] (one per process, mirroring the TS module singletons).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedderKind {
    Local,
    Cloud,
}

impl EmbedderKind {
    pub fn id(&self) -> &'static str {
        match self {
            EmbedderKind::Local => "local-code-512",
            EmbedderKind::Cloud => "cloud-base",
        }
    }
}

/// Build-time resolution. `Err` carries the TS ResolveError messages so
/// "RAG unavailable" surfaces honestly.
pub fn resolve_for_build(
    config: &RagConfigInput,
    local_available: bool,
    cloud_is_configured: bool,
) -> Result<EmbedderKind, String> {
    if local_available {
        return Ok(EmbedderKind::Local);
    }
    if config.cloud_allowed && cloud_is_configured {
        return Ok(EmbedderKind::Cloud);
    }
    if !config.cloud_allowed {
        return Err(
            "Local embedder unavailable and cloud fallback is disabled. \
             Enable \"Allow cloud as build-time fallback\" or restore local ONNX."
                .to_string(),
        );
    }
    Err(
        "Local embedder unavailable and cloud is not configured (TIDE_SYSTEM_API_KEY missing)."
            .to_string(),
    )
}

/// Query-time resolution against the index's recorded embedderId.
pub fn resolve_for_query(
    config: &RagConfigInput,
    local_available: bool,
    cloud_is_configured: bool,
) -> Result<EmbedderKind, String> {
    if config.embedder_id == "local-code-512" {
        if !local_available {
            return Err(
                "Index was built with the local embedder, which is no longer available. \
                 Rebuild required (cloud fallback cannot query a local-built index)."
                    .to_string(),
            );
        }
        return Ok(EmbedderKind::Local);
    }
    // cloud-base index
    if !cloud_is_configured {
        return Err(
            "Index was built with the cloud embedder, but TIDE_SYSTEM_API_KEY is no longer set."
                .to_string(),
        );
    }
    Ok(EmbedderKind::Cloud)
}

/// The shared embedder instance for a resolved kind. The local instance is
/// lazily built against the app data dir (first caller wins — one app, one
/// data dir).
pub fn embedder_of(kind: EmbedderKind, data_dir: &Path) -> Arc<dyn Embedder> {
    match kind {
        EmbedderKind::Local => Arc::new(LocalHandle(shared_local(data_dir))),
        EmbedderKind::Cloud => Arc::new(CloudEmbedder),
    }
}

/// Newtype so the OnceLock-memoized `&'static LocalEmbedder` can ride
/// behind an Arc<dyn Embedder> without a lifetime.
struct LocalHandle(&'static LocalEmbedder);

impl Embedder for LocalHandle {
    fn id(&self) -> &str {
        self.0.id()
    }
    fn dim(&self) -> usize {
        self.0.dim()
    }
    fn max_tokens(&self) -> usize {
        self.0.max_tokens()
    }
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        self.0.embed(texts)
    }
}

/// Convenience: build-time resolve + instance in one call (the ingest path).
pub fn resolve_embedder_for_build(
    config: &RagConfigInput,
    data_dir: &Path,
) -> Result<(EmbedderKind, Arc<dyn Embedder>), String> {
    let kind = resolve_for_build(config, local_model_exists(data_dir), cloud_configured())?;
    let embedder = embedder_of(kind, data_dir);
    Ok((kind, embedder))
}

/// Convenience: query-time resolve + instance (the memory tool path).
pub fn resolve_embedder_for_query(
    config: &RagConfigInput,
    data_dir: &Path,
) -> Result<(EmbedderKind, Arc<dyn Embedder>), String> {
    let kind = resolve_for_query(config, local_model_exists(data_dir), cloud_configured())?;
    let embedder = embedder_of(kind, data_dir);
    Ok((kind, embedder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_prefers_local_when_available() {
        let cfg = RagConfigInput::default();
        assert_eq!(
            resolve_for_build(&cfg, true, false).unwrap(),
            EmbedderKind::Local
        );
    }

    #[test]
    fn build_falls_back_to_cloud_only_when_allowed_and_configured() {
        let mut cfg = RagConfigInput::default();
        assert!(resolve_for_build(&cfg, false, true)
            .unwrap_err()
            .contains("cloud fallback is disabled"));
        cfg.cloud_allowed = true;
        assert_eq!(
            resolve_for_build(&cfg, false, true).unwrap(),
            EmbedderKind::Cloud
        );
        assert!(resolve_for_build(&cfg, false, false)
            .unwrap_err()
            .contains("TIDE_SYSTEM_API_KEY"));
    }

    #[test]
    fn query_never_crosses_vector_spaces() {
        let mut cfg = RagConfigInput::default();
        assert!(resolve_for_query(&cfg, false, true)
            .unwrap_err()
            .contains("Rebuild required"));
        assert_eq!(
            resolve_for_query(&cfg, true, false).unwrap(),
            EmbedderKind::Local
        );

        cfg.embedder_id = "cloud-base".into();
        assert!(resolve_for_query(&cfg, true, false)
            .unwrap_err()
            .contains("no longer set"));
        assert_eq!(
            resolve_for_query(&cfg, false, true).unwrap(),
            EmbedderKind::Cloud
        );
    }
}
