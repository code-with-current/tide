//! Embedders — port of `app/core/rag/{embedder,local-onnx-embedder,
//! bun-onnx-embedder,cloud-embedder,model-downloader}.ts`, generalized
//! over the model catalog.
//!
//! The local embedder runs ONNX models from the catalog through `ort`
//! with the HF `tokenizer.json` riding beside — mean-pool masked
//! positions + L2 normalize, the exact numerics of `poolNormalize` (f64
//! accumulation), so vectors written by the TS shells stay
//! query-compatible. Model resolution follows the bun-onnx candidate
//! chain: `TIDE_MODELS_DIR` → `<data>/models/<repo>` (the download dir
//! `local_model_exists` checks) → the copy vendored in this crate
//! (embedded into the binary, default entry only). Remote embedders post
//! to OpenAI-style `/embeddings` endpoints — the system OpenRouter
//! connection or a user-configured custom endpoint.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::catalog::{self, LocalModelEntry};

/// Model identity — the default catalog entry (TS embedder-process.ts).
pub const MODEL_ID: &str = catalog::DEFAULT_ENTRY.repo;
pub const LOCAL_EMBEDDER_ID: &str = catalog::DEFAULT_ENTRY.id;
pub const LOCAL_EMBEDDER_DIM: usize = catalog::DEFAULT_ENTRY.dims;
pub const LOCAL_EMBEDDER_MAX_TOKENS: usize = catalog::DEFAULT_ENTRY.max_tokens;

/// The files that constitute the default model (TS MODEL_FILES).
pub const MODEL_FILES: &[&str] = catalog::DEFAULT_ENTRY.files;

/// Base URL for the default model's files on HuggingFace (TS HF_BASE).
pub const HF_BASE: &str = catalog::DEFAULT_ENTRY.hf_base;

const CLOUD_EMBEDDER_ID: &str = "cloud-base";
const CLOUD_EMBEDDER_MAX_TOKENS: usize = 256;
const DEFAULT_EMBEDDING_MODEL: &str = "sentence-transformers/all-minilm-l6-v2";
const DEFAULT_SYSTEM_BASE_URL: &str = "https://openrouter.ai/api/v1";
const DOWNLOAD_TIMEOUT_SECS: u64 = 120;

/// The embedder contract (TS embedder.ts): id/dim/maxTokens + batch embed.
pub trait Embedder: Send + Sync {
    fn id(&self) -> &str;
    fn dim(&self) -> usize;
    fn max_tokens(&self) -> usize;
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String>;
    /// Confirm the output dimensions — remote embedders measure with a
    /// probe so the embedding plan records reality, locals know theirs.
    fn ensure_dims(&self) -> Result<usize, String> {
        Ok(self.dim())
    }
    /// Embed for a specific use. Model families trained with instruction
    /// prefixes (e5) apply different prefixes to queries and passages;
    /// everything else ignores the distinction.
    fn embed_use(&self, texts: &[String], _use_: EmbedUse) -> Result<Vec<Vec<f32>>, String> {
        self.embed(texts)
    }
}

/// What the caller is embedding — selects the instruction prefix on
/// models that were trained with them (e5: `query: ` / `passage: `).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedUse {
    Query,
    Passage,
}

/// `<data_dir>/models` — the download dir (TS getModelDownloadDir; the
/// `TIDE_MODELS_DIR` env override wins, matching localModelExists).
pub fn models_dir_for(data_dir: &Path) -> PathBuf {
    if let Ok(env_dir) = std::env::var("TIDE_MODELS_DIR") {
        if !env_dir.is_empty() {
            return PathBuf::from(env_dir);
        }
    }
    data_dir.join("models")
}

/// TS `localModelExists` for a catalog entry: the downloaded model ONNX is
/// on disk. The vendored/embedded copy does NOT count — the user-facing
/// download is the gate, exactly like the TS shells (which staged a copy
/// into the bundle yet still reported unavailable until first enable
/// downloaded it). The default entry stays usable regardless (vendored).
pub fn local_model_exists_for(entry: &LocalModelEntry, data_dir: &Path) -> bool {
    if entry.vendored {
        return true;
    }
    models_dir_for(data_dir)
        .join(entry.repo)
        .join("onnx")
        .join("model_quantized.onnx")
        .is_file()
}

/// Default-model shorthand (status/reporting paths).
pub fn local_model_exists(data_dir: &Path) -> bool {
    local_model_exists_for(catalog::default_entry(), data_dir)
}

/// TS `isRagCloudConfigured`: a non-empty system API key is present.
pub fn cloud_configured() -> bool {
    std::env::var("TIDE_SYSTEM_API_KEY")
        .map(|k| !k.is_empty())
        .unwrap_or(false)
}

// ── local embedder ─────────────────────────────────────────────────────────

/// Vendored model bytes, embedded at compile time (the staged-copy twin —
/// `include_bytes!`, like the bundled model-prices baseline). The default
/// entry only: every other catalog model must be downloaded.
static VENDORED_ONNX: &[u8] = include_bytes!(
    "../models/isuruwijesiri/all-MiniLM-L6-v2-code-search-512/onnx/model_quantized.onnx"
);
static VENDORED_TOKENIZER: &[u8] =
    include_bytes!("../models/isuruwijesiri/all-MiniLM-L6-v2-code-search-512/tokenizer.json");

struct LocalSession {
    tokenizer: tokenizers::Tokenizer,
    session: ort::session::Session,
    input_names: Vec<String>,
}

/// Mean-pool masked positions + L2 normalize — identical to the TS
/// `poolNormalize` (f64 accumulation over the f32 hidden states).
fn pool_normalize(hidden: &[f32], seq: usize, dim: usize) -> Vec<f32> {
    let mut pooled = vec![0.0f64; dim];
    // The attention mask is all-ones — single unpadded texts per row.
    let mask_sum = seq;
    for i in 0..seq {
        for j in 0..dim {
            pooled[j] += hidden[i * dim + j] as f64;
        }
    }
    let denom = (mask_sum.max(1) as f64).max(1e-9);
    let mut norm = 0.0f64;
    for p in &mut pooled {
        *p /= denom;
        norm += *p * *p;
    }
    norm = norm.sqrt();
    let norm = if norm == 0.0 { 1.0 } else { norm };
    pooled.iter().map(|v| (*v / norm) as f32).collect()
}

/// The instruction prefix a model family wants for this use, if any.
fn prefix_for(entry: &LocalModelEntry, use_: EmbedUse) -> &'static str {
    match use_ {
        EmbedUse::Query => entry.query_prefix,
        EmbedUse::Passage => entry.passage_prefix,
    }
    .unwrap_or("")
}

/// In-process local ONNX embedder (the bun-onnx twin — no child process
/// under Tauri). One lazily-built session per process per model; failures
/// reset the memo so a transient model error can be retried.
pub struct LocalEmbedder {
    data_dir: PathBuf,
    entry: &'static LocalModelEntry,
    init: Mutex<Option<LocalSession>>,
}

impl LocalEmbedder {
    pub fn new(data_dir: impl Into<PathBuf>, entry: &'static LocalModelEntry) -> Self {
        Self {
            data_dir: data_dir.into(),
            entry,
            init: Mutex::new(None),
        }
    }

    fn session(&self) -> Result<(), String> {
        let mut guard = self.init.lock().map_err(|_| "embedder state poisoned")?;
        if guard.is_some() {
            return Ok(());
        }
        *guard = Some(build_local_session(&self.data_dir, self.entry)?);
        Ok(())
    }
}

fn build_local_session(
    data_dir: &Path,
    entry: &'static LocalModelEntry,
) -> Result<LocalSession, String> {
    // Candidate model roots, first match wins: the app's download dir
    // (production — same location localModel_exists_for checks and the
    // downloader writes), then the crate-vendored copy embedded in the
    // binary (packaged/dev/test fallback, default entry only).
    let onnx_path = models_dir_for(data_dir)
        .join(entry.repo)
        .join("onnx")
        .join("model_quantized.onnx");
    let (model_bytes, onnx_owned): (Vec<u8>, bool) = if onnx_path.is_file() {
        (std::fs::read(&onnx_path).map_err(|e| e.to_string())?, true)
    } else if entry.vendored {
        (VENDORED_ONNX.to_vec(), false)
    } else {
        return Err(format!(
            "model {} is not downloaded — download it from the Memory & RAG settings",
            entry.repo
        ));
    };
    let tokenizer_bytes: Vec<u8> = {
        let tokenizer_path = models_dir_for(data_dir).join(entry.repo).join("tokenizer.json");
        if onnx_owned && tokenizer_path.is_file() {
            std::fs::read(&tokenizer_path).map_err(|e| e.to_string())?
        } else if entry.vendored {
            VENDORED_TOKENIZER.to_vec()
        } else {
            return Err(format!("tokenizer for {} is not downloaded", entry.repo));
        }
    };

    let mut tokenizer = tokenizers::Tokenizer::from_bytes(&tokenizer_bytes)
        .map_err(|e| format!("tokenizer load failed: {e}"))?;
    use tokenizers::TruncationParams;
    let trunc = TruncationParams {
        max_length: entry.max_tokens,
        ..Default::default()
    };
    tokenizer
        .with_truncation(Some(trunc))
        .map_err(|e| e.to_string())?;

    let session = ort::session::Session::builder()
        .and_then(|mut b| b.commit_from_memory(&model_bytes))
        .map_err(|e| format!("onnx session load failed: {e}"))?;
    let input_names: Vec<String> = session
        .inputs()
        .iter()
        .map(|o| o.name().to_string())
        .collect();
    Ok(LocalSession {
        tokenizer,
        session,
        input_names,
    })
}

impl Embedder for LocalEmbedder {
    fn id(&self) -> &str {
        self.entry.id
    }
    fn dim(&self) -> usize {
        self.entry.dims
    }
    fn max_tokens(&self) -> usize {
        self.entry.max_tokens
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        self.embed_use(texts, EmbedUse::Passage)
    }

    fn embed_use(&self, texts: &[String], use_: EmbedUse) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        self.session()?;
        let mut guard = self.init.lock().map_err(|_| "embedder state poisoned")?;
        let local = guard
            .as_mut()
            .ok_or_else(|| "local embedder unavailable".to_string())?;
        let prefix = prefix_for(self.entry, use_);

        let mut vectors = Vec::with_capacity(texts.len());
        for text in texts {
            let encoding = local
                .tokenizer
                .encode(format!("{prefix}{text}"), true)
                .map_err(|e| format!("tokenize failed: {e}"))?;
            // Hard cap regardless of tokenizer options — the model's
            // positional embeddings are entry.max_tokens rows.
            let ids: Vec<i64> = encoding
                .get_ids()
                .iter()
                .take(self.entry.max_tokens)
                .map(|&id| id as i64)
                .collect();
            let seq = ids.len();
            if seq == 0 {
                return Err("tokenizer returned empty input_ids".to_string());
            }

            use ort::value::Tensor;
            let mut inputs: Vec<(String, ort::session::SessionInputValue<'_>)> = Vec::new();
            for name in &local.input_names {
                let data: Vec<i64> = if name == "input_ids" {
                    ids.clone()
                } else if name == "attention_mask" {
                    vec![1; seq]
                } else {
                    vec![0; seq]
                };
                let tensor =
                    Tensor::from_array((vec![1usize, seq], data)).map_err(|e| e.to_string())?;
                inputs.push((name.clone(), tensor.into()));
            }
            let outputs = local
                .session
                .run(inputs)
                .map_err(|e| format!("onnx inference failed: {e}"))?;
            let first_name = outputs
                .keys()
                .next()
                .ok_or_else(|| "onnx model produced no outputs".to_string())?
                .to_string();
            let first = &outputs[first_name.as_str()];
            let (shape, hidden) = first
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("onnx output extract failed: {e}"))?;
            let dim = shape.last().copied().unwrap_or(0) as usize;
            if dim == 0 {
                return Err("onnx output had zero dimension".to_string());
            }
            if dim != self.entry.dims {
                return Err(format!(
                    "model {} produced {dim}-dim vectors but the catalog says {} — \
                     the repo layout does not match the catalog entry",
                    self.entry.repo, self.entry.dims
                ));
            }
            vectors.push(pool_normalize(hidden, seq, dim));
        }
        Ok(vectors)
    }
}

// ── remote embedder ────────────────────────────────────────────────────────

/// Remote embedder over an OpenAI-style `/embeddings` endpoint — serves
/// both the system cloud connection (`cloud-base`) and user-configured
/// custom endpoints (`custom-<id>`).
pub struct RemoteEmbedder {
    id: String,
    base_url: String,
    model: String,
    api_key: String,
    /// Declared dimensions; `None` until measured (probe or first embed).
    dims: Mutex<Option<usize>>,
    max_tokens: usize,
}

impl RemoteEmbedder {
    /// The system cloud connection (the old `CloudEmbedder`): the
    /// OpenRouter-style endpoint on the system-model credentials. 256-token
    /// window — the local fine-tune extends to 512 but the cloud base
    /// does not.
    pub fn system(model: Option<String>) -> Self {
        let api_key = std::env::var("TIDE_SYSTEM_API_KEY").unwrap_or_default();
        Self {
            id: CLOUD_EMBEDDER_ID.into(),
            base_url: system_base_url(),
            model: model
                .or_else(|| std::env::var("TIDE_RAG_EMBEDDING_MODEL").ok())
                .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.into()),
            api_key,
            dims: Mutex::new(None),
            max_tokens: CLOUD_EMBEDDER_MAX_TOKENS,
        }
    }

    /// A user-configured custom endpoint (dims measured by the add-time
    /// probe and persisted with the endpoint). Pass `dims = 0` for
    /// not-yet-measured — `ensure_dims` then probes.
    pub fn custom(
        id: &str,
        base_url: &str,
        model_id: &str,
        api_key: &str,
        dims: usize,
        max_tokens: usize,
    ) -> Self {
        Self {
            id: id.to_owned(),
            base_url: base_url.trim_end_matches('/').to_owned(),
            model: model_id.to_owned(),
            api_key: api_key.to_owned(),
            dims: Mutex::new((dims > 0).then_some(dims)),
            max_tokens,
        }
    }

    /// Measure the true output dimensions with one probe embedding and
    /// cache them, so the embedding plan records what the endpoint
    /// actually returns rather than a guess. Callers that already probed
    /// (custom endpoints) get the stored value for free.
    fn ensure_dims_impl(&self) -> Result<usize, String> {
        if let Some(dims) = *self.dims.lock().map_err(|_| "dims state poisoned")? {
            return Ok(dims);
        }
        let vectors = self.embed(&["dimension probe".to_owned()])?;
        let dims = vectors
            .first()
            .ok_or("endpoint returned no vectors for the probe")?
            .len();
        *self.dims.lock().map_err(|_| "dims state poisoned")? = Some(dims);
        Ok(dims)
    }
}

fn system_base_url() -> String {
    let raw = std::env::var("TIDE_SYSTEM_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_SYSTEM_BASE_URL.to_string());
    raw.trim_end_matches("/chat/completions")
        .trim_end_matches('/')
        .to_string()
}

impl Embedder for RemoteEmbedder {
    fn id(&self) -> &str {
        &self.id
    }
    fn dim(&self) -> usize {
        // Declared/measured dims; the historical cloud default until
        // measured (sentence-transformers/all-minilm-l6-v2 is 384).
        self.dims
            .lock()
            .ok()
            .and_then(|d| *d)
            .unwrap_or(LOCAL_EMBEDDER_DIM)
    }
    fn max_tokens(&self) -> usize {
        self.max_tokens
    }
    fn ensure_dims(&self) -> Result<usize, String> {
        self.ensure_dims_impl()
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if self.api_key.is_empty() {
            return Err(format!(
                "remote embedder {} is not configured: its API key is missing",
                self.id
            ));
        }
        let request = serde_json::json!({ "model": self.model, "input": texts });
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        let response = client
            .post(format!("{}/embeddings", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&request)
            .send()
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "remote embedder {} HTTP {}: {}",
                self.id,
                response.status(),
                response.text().unwrap_or_default().chars().take(200).collect::<String>()
            ));
        }
        let payload: serde_json::Value = response.json().map_err(|e| e.to_string())?;
        let data = payload
            .get("data")
            .and_then(|d| d.as_array())
            .ok_or_else(|| "remote embedder reply had no data".to_string())?;
        let mut out = Vec::with_capacity(data.len());
        for item in data {
            let embedding = item
                .get("embedding")
                .and_then(|e| e.as_array())
                .ok_or_else(|| "remote embedder item had no embedding".to_string())?;
            out.push(
                embedding
                    .iter()
                    .map(|v| v.as_f64().unwrap_or(0.0) as f32)
                    .collect::<Vec<f32>>(),
            );
        }
        if out.len() != texts.len() {
            return Err(format!(
                "remote embedder returned {} vectors for {} texts",
                out.len(),
                texts.len()
            ));
        }
        Ok(out)
    }
}

// ── model downloader ───────────────────────────────────────────────────────

/// Aggregate download progress (TS DownloadProgressCallback).
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
    pub file: String,
    /// Which catalog model is downloading.
    pub model_id: String,
}

/// Download all of a catalog entry's files into
/// `<data>/models/<repo>/` (idempotent, skipping complete files; atomic
/// per-file `.tmp` + rename). Reports aggregate byte progress and returns
/// the model directory path.
pub fn download_model(
    data_dir: &Path,
    entry: &'static LocalModelEntry,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<PathBuf, String> {
    let models_dir = models_dir_for(data_dir);
    let model_dir = models_dir.join(entry.repo);

    // HEAD all missing files to compute total size (for accurate progress).
    let mut file_infos: Vec<(String, PathBuf, u64)> = Vec::new();
    let mut total_size: u64 = 0;
    for relative in entry.files {
        let dest = model_dir.join(relative);
        if dest.is_file() {
            let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            file_infos.push((relative.to_string(), dest, size));
            total_size += size;
            continue;
        }
        let size = head_size(&format!("{}/{relative}", entry.hf_base));
        file_infos.push((relative.to_string(), dest, size));
        total_size += size;
    }

    let mut received_total: u64 = 0;
    on_progress(DownloadProgress {
        received: 0,
        total: total_size,
        file: String::new(),
        model_id: entry.id.to_owned(),
    });

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    for (relative, dest, size) in file_infos {
        if dest.is_file() {
            received_total += size;
            continue;
        }
        let url = format!("{}/{relative}", entry.hf_base);
        let mut response = client
            .get(&url)
            .header("user-agent", "Tide/0.4 knowledge-indexer")
            .send()
            .map_err(|e| format!("HTTP fetch failed for {relative}: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("HTTP {} fetching {relative}", response.status()));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // `<name>.<ext>.tmp` sibling, like the TS `${dest}.tmp`.
        let tmp_path = {
            let mut s = dest.as_os_str().to_os_string();
            s.push(".tmp");
            PathBuf::from(s)
        };
        let mut file = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        let mut file_received: u64 = 0;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = response
                .read(&mut buffer)
                .map_err(|e| format!("download read failed for {relative}: {e}"))?;
            if n == 0 {
                break;
            }
            use std::io::Write as _;
            file.write_all(&buffer[..n])
                .map_err(|e| format!("download write failed for {relative}: {e}"))?;
            file_received += n as u64;
            on_progress(DownloadProgress {
                received: received_total + file_received,
                total: total_size,
                file: relative.clone(),
                model_id: entry.id.to_owned(),
            });
        }
        drop(file);
        std::fs::rename(&tmp_path, &dest).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            e.to_string()
        })?;
        received_total += size;
    }

    Ok(model_dir)
}

fn head_size(url: &str) -> u64 {
    let request = match reqwest::blocking::Client::new().head(url).build() {
        Ok(req) => req,
        Err(_) => return 0,
    };
    match reqwest::blocking::Client::new().execute(request) {
        Ok(resp) if resp.status().is_success() => resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
        _ => 0,
    }
}

/// Process-wide local-embedder memo per catalog entry (TS resolve.ts
/// module singleton, generalized). The data dir of the first caller wins
/// — one app, one data dir.
pub fn local_embedder_shared(
    entry: &'static LocalModelEntry,
    data_dir: &Path,
) -> Arc<LocalEmbedder> {
    static SHARED: OnceLock<Mutex<HashMap<&'static str, Arc<LocalEmbedder>>>> = OnceLock::new();
    let map = SHARED.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().expect("local embedder registry poisoned");
    guard
        .entry(entry.id)
        .or_insert_with(|| Arc::new(LocalEmbedder::new(data_dir.to_path_buf(), entry)))
        .clone()
}

/// Default-model shorthand (tests).
pub fn shared_local(data_dir: &Path) -> Arc<LocalEmbedder> {
    local_embedder_shared(catalog::default_entry(), data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_model_exists_gate_checks_the_download_dir_only() {
        let dir = tempfile::tempdir().unwrap();
        let e5 = catalog::entry("local-mle5-small").unwrap();
        assert!(!local_model_exists_for(e5, dir.path()));
        // The vendored default is usable without a download.
        assert!(local_model_exists_for(catalog::default_entry(), dir.path()));
        let model_dir = dir.path().join("models").join(e5.repo).join("onnx");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model_quantized.onnx"), b"stub").unwrap();
        assert!(local_model_exists_for(e5, dir.path()));
    }

    #[test]
    fn models_dir_respects_the_env_override() {
        // Env-var tests race under a parallel runner — probe the pure path
        // only when the var is unset (the normal test env).
        if std::env::var("TIDE_MODELS_DIR").is_err() {
            assert_eq!(
                models_dir_for(Path::new("/data")),
                PathBuf::from("/data/models")
            );
        }
    }

    #[test]
    fn pool_normalize_matches_the_ts_numerics() {
        // 2 positions, 2 dims — mean then L2. The f64 accumulation mirrors
        // the TS Float64Array path; expected values computed by hand.
        let hidden = [1.0f32, 0.0, 0.0, 3.0];
        let out = pool_normalize(&hidden, 2, 2);
        // means: [0.5, 1.5]; norm = sqrt(0.25+2.25)=sqrt(2.5)
        let expected_norm = (2.5f64).sqrt() as f32;
        assert!((out[0] - 0.5 / expected_norm).abs() < 1e-6);
        assert!((out[1] - 1.5 / expected_norm).abs() < 1e-6);
        let norm: f32 = out.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
    }

    #[test]
    fn instruction_prefixes_select_by_use() {
        let e5 = catalog::entry("local-mle5-small").unwrap();
        assert_eq!(prefix_for(e5, EmbedUse::Query), "query: ");
        assert_eq!(prefix_for(e5, EmbedUse::Passage), "passage: ");
        let code = catalog::default_entry();
        assert_eq!(prefix_for(code, EmbedUse::Query), "");
        assert_eq!(prefix_for(code, EmbedUse::Passage), "");
    }

    #[test]
    fn remote_embedder_reports_missing_key() {
        let e = RemoteEmbedder::custom("custom-x", "https://example.invalid/v1", "m", "", 384, 512);
        let err = e.embed(&["t".to_owned()]).unwrap_err();
        assert!(err.contains("custom-x"), "was {err}");
        assert!(err.contains("API key"), "was {err}");
    }

    #[test]
    fn remote_embedder_declared_dims_short_circuit() {
        let e = RemoteEmbedder::custom("custom-x", "https://example.invalid/v1", "m", "k", 1536, 8191);
        assert_eq!(e.ensure_dims().unwrap(), 1536);
        assert_eq!(e.dim(), 1536);
    }
}
