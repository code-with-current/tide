//! Embedders — port of `app/core/rag/{embedder,local-onnx-embedder,
//! bun-onnx-embedder,cloud-embedder,model-downloader}.ts`.
//!
//! The local embedder runs the SAME vendored ONNX model through `ort`
//! (BertModel, 384-dim, 512-token window) with the HF `tokenizer.json`
//! riding beside it — mean-pool masked positions + L2 normalize, the exact
//! numerics of `poolNormalize` (f64 accumulation), so vectors written by
//! the TS shells stay query-compatible. Model resolution follows the
//! bun-onnx candidate chain: `TIDE_MODELS_DIR` → `<data>/models` (the
//! download dir `localModelExists` checks) → the copy vendored in this
//! crate (embedded into the binary, the packaged-app staging twin). The
//! cloud fallback posts to the OpenRouter-style `/embeddings` endpoint on
//! the system-model credentials.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Model identity — one source of truth (TS embedder-process.ts).
pub const MODEL_ID: &str = "isuruwijesiri/all-MiniLM-L6-v2-code-search-512";
pub const LOCAL_EMBEDDER_ID: &str = "local-code-512";
pub const LOCAL_EMBEDDER_DIM: usize = 384;
pub const LOCAL_EMBEDDER_MAX_TOKENS: usize = 512;

/// The files that constitute the model (TS MODEL_FILES).
pub const MODEL_FILES: &[&str] = &[
    "onnx/model_quantized.onnx",
    "tokenizer.json",
    "tokenizer_config.json",
    "config.json",
];

/// Base URL for model files on HuggingFace (TS HF_BASE).
const HF_BASE: &str =
    "https://huggingface.co/isuruwijesiri/all-MiniLM-L6-v2-code-search-512/resolve/main";

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

/// TS `localModelExists`: the downloaded model ONNX is on disk. The
/// vendored/embedded copy does NOT count — the user-facing download is the
/// gate, exactly like the TS shells (which staged a copy into the bundle
/// yet still reported unavailable until first enable downloaded it).
pub fn local_model_exists(data_dir: &Path) -> bool {
    models_dir_for(data_dir)
        .join(MODEL_ID)
        .join("onnx")
        .join("model_quantized.onnx")
        .is_file()
}

/// TS `isRagCloudConfigured`: a non-empty system API key is present.
pub fn cloud_configured() -> bool {
    std::env::var("TIDE_SYSTEM_API_KEY")
        .map(|k| !k.is_empty())
        .unwrap_or(false)
}

// ── local embedder ─────────────────────────────────────────────────────────

/// Vendored model bytes, embedded at compile time (the staged-copy twin —
/// `include_bytes!`, like the bundled model-prices baseline).
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

/// In-process local ONNX embedder (the bun-onnx twin — no child process
/// under Tauri). One lazily-built session per process; failures reset the
/// memo so a transient model error can be retried.
pub struct LocalEmbedder {
    data_dir: PathBuf,
    init: Mutex<Option<LocalSession>>,
}

impl LocalEmbedder {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            init: Mutex::new(None),
        }
    }

    fn session(&self) -> Result<(), String> {
        let mut guard = self.init.lock().map_err(|_| "embedder state poisoned")?;
        if guard.is_some() {
            return Ok(());
        }
        *guard = Some(build_local_session(&self.data_dir)?);
        Ok(())
    }
}

fn build_local_session(data_dir: &Path) -> Result<LocalSession, String> {
    // Candidate model roots, first match wins: the app's download dir
    // (production — same location localModelExists checks and the
    // downloader writes), then the crate-vendored copy embedded in the
    // binary (packaged/dev/test fallback).
    let onnx_path = models_dir_for(data_dir)
        .join(MODEL_ID)
        .join("onnx")
        .join("model_quantized.onnx");
    let (model_bytes, onnx_owned): (Vec<u8>, bool) = if onnx_path.is_file() {
        (std::fs::read(&onnx_path).map_err(|e| e.to_string())?, true)
    } else {
        (VENDORED_ONNX.to_vec(), false)
    };
    let tokenizer_bytes: Vec<u8> = {
        let tokenizer_path = models_dir_for(data_dir)
            .join(MODEL_ID)
            .join("tokenizer.json");
        if onnx_owned && tokenizer_path.is_file() {
            std::fs::read(&tokenizer_path).map_err(|e| e.to_string())?
        } else {
            VENDORED_TOKENIZER.to_vec()
        }
    };

    let mut tokenizer = tokenizers::Tokenizer::from_bytes(&tokenizer_bytes)
        .map_err(|e| format!("tokenizer load failed: {e}"))?;
    use tokenizers::TruncationParams;
    let trunc = TruncationParams {
        max_length: LOCAL_EMBEDDER_MAX_TOKENS,
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
        LOCAL_EMBEDDER_ID
    }
    fn dim(&self) -> usize {
        LOCAL_EMBEDDER_DIM
    }
    fn max_tokens(&self) -> usize {
        LOCAL_EMBEDDER_MAX_TOKENS
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        self.session()?;
        let mut guard = self.init.lock().map_err(|_| "embedder state poisoned")?;
        let local = guard
            .as_mut()
            .ok_or_else(|| "local embedder unavailable".to_string())?;

        let mut vectors = Vec::with_capacity(texts.len());
        for text in texts {
            let encoding = local
                .tokenizer
                .encode(text.as_str(), true)
                .map_err(|e| format!("tokenize failed: {e}"))?;
            // Hard cap regardless of tokenizer options — the model's
            // positional embeddings are 512 rows.
            let ids: Vec<i64> = encoding
                .get_ids()
                .iter()
                .take(LOCAL_EMBEDDER_MAX_TOKENS)
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
            vectors.push(pool_normalize(hidden, seq, dim));
        }
        Ok(vectors)
    }
}

// ── cloud embedder ─────────────────────────────────────────────────────────

/// Cloud embedder: base sentence-transformers/all-minilm-l6-v2 via the
/// system-model OpenRouter connection (256-token window — the local
/// fine-tune extends to 512 but the cloud base does not).
pub struct CloudEmbedder;

fn system_base_url() -> String {
    let raw = std::env::var("TIDE_SYSTEM_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_SYSTEM_BASE_URL.to_string());
    raw.trim_end_matches("/chat/completions")
        .trim_end_matches('/')
        .to_string()
}

impl Embedder for CloudEmbedder {
    fn id(&self) -> &str {
        CLOUD_EMBEDDER_ID
    }
    fn dim(&self) -> usize {
        LOCAL_EMBEDDER_DIM
    }
    fn max_tokens(&self) -> usize {
        CLOUD_EMBEDDER_MAX_TOKENS
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let api_key = std::env::var("TIDE_SYSTEM_API_KEY").map_err(|_| {
            "RAG cloud embedder not configured: set TIDE_SYSTEM_API_KEY.".to_string()
        })?;
        let model = std::env::var("TIDE_RAG_EMBEDDING_MODEL")
            .unwrap_or_else(|_| DEFAULT_EMBEDDING_MODEL.into());
        let request = serde_json::json!({ "model": model, "input": texts });
        let response = reqwest::blocking::Client::new()
            .post(format!("{}/embeddings", system_base_url()))
            .bearer_auth(api_key)
            .json(&request)
            .send()
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("cloud embedder HTTP {}", response.status()));
        }
        let payload: serde_json::Value = response.json().map_err(|e| e.to_string())?;
        let data = payload
            .get("data")
            .and_then(|d| d.as_array())
            .ok_or_else(|| "cloud embedder reply had no data".to_string())?;
        let mut out = Vec::with_capacity(data.len());
        for item in data {
            let embedding = item
                .get("embedding")
                .and_then(|e| e.as_array())
                .ok_or_else(|| "cloud embedder item had no embedding".to_string())?;
            out.push(
                embedding
                    .iter()
                    .map(|v| v.as_f64().unwrap_or(0.0) as f32)
                    .collect::<Vec<f32>>(),
            );
        }
        if out.len() != texts.len() {
            return Err(format!(
                "cloud embedder returned {} vectors for {} texts",
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
}

/// Download all model files into `<data>/models/<MODEL_ID>/` (idempotent,
/// skipping complete files; atomic per-file `.tmp` + rename). Reports
/// aggregate byte progress and returns the model directory path.
pub fn download_model(
    data_dir: &Path,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<PathBuf, String> {
    let models_dir = models_dir_for(data_dir);
    let model_dir = models_dir.join(MODEL_ID);

    // HEAD all missing files to compute total size (for accurate progress).
    let mut file_infos: Vec<(String, PathBuf, u64)> = Vec::new();
    let mut total_size: u64 = 0;
    for relative in MODEL_FILES {
        let dest = model_dir.join(relative);
        if dest.is_file() {
            let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            file_infos.push((relative.to_string(), dest, size));
            total_size += size;
            continue;
        }
        let size = head_size(relative);
        file_infos.push((relative.to_string(), dest, size));
        total_size += size;
    }

    let mut received_total: u64 = 0;
    on_progress(DownloadProgress {
        received: 0,
        total: total_size,
        file: String::new(),
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
        let url = format!("{HF_BASE}/{relative}");
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

fn head_size(relative: &str) -> u64 {
    let url = format!("{HF_BASE}/{relative}");
    let request = match reqwest::blocking::Client::new().head(&url).build() {
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

/// Process-wide local-embedder memo (TS resolve.ts module singleton). The
/// data dir of the first caller wins — one app, one data dir.
pub fn shared_local(data_dir: &Path) -> &'static LocalEmbedder {
    static SHARED: OnceLock<LocalEmbedder> = OnceLock::new();
    SHARED.get_or_init(|| LocalEmbedder::new(data_dir.to_path_buf()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_model_exists_gate_checks_the_download_dir_only() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!local_model_exists(dir.path()));
        let model_dir = dir.path().join("models").join(MODEL_ID).join("onnx");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model_quantized.onnx"), b"stub").unwrap();
        assert!(local_model_exists(dir.path()));
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
        let norm = (2.5f64).sqrt();
        assert!((out[0] as f64 - 0.5 / norm).abs() < 1e-6);
        assert!((out[1] as f64 - 1.5 / norm).abs() < 1e-6);
    }

    /// Embedding smoke with the REAL vendored model — the index-compat
    /// invariant (same model + same pooling = same vector space). Slow
    /// (~seconds of first-load ONNX init), so it is `#[ignore]` for the
    /// normal gate but runs on demand:
    /// `cargo test -p tide-rag --lib embed -- --ignored`.
    #[test]
    #[ignore]
    fn embeds_a_known_string_with_the_real_model() {
        let dir = tempfile::tempdir().unwrap();
        let embedder = LocalEmbedder::new(dir.path());
        let vectors = embedder
            .embed(&["how is authentication handled in this codebase".to_owned()])
            .unwrap();
        assert_eq!(vectors.len(), 1);
        assert_eq!(vectors[0].len(), LOCAL_EMBEDDER_DIM);
        // L2-normalized: |v| ≈ 1.
        let norm: f64 = vectors[0]
            .iter()
            .map(|v| (*v as f64) * (*v as f64))
            .sum::<f64>()
            .sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "norm was {norm}");

        // Same string → identical vector; different string → different.
        let again = embedder
            .embed(&["how is authentication handled in this codebase".to_owned()])
            .unwrap();
        assert_eq!(vectors[0], again[0]);
        let other = embedder
            .embed(&["database connection setup".to_owned()])
            .unwrap();
        assert_ne!(vectors[0], other[0]);
    }

    /// Cross-implementation parity — the design invariant "existing indexes
    /// stay valid" hinges on the Rust ort+tokenizers pipeline producing the
    /// SAME vector space as the TS @xenova/transformers + onnxruntime-node
    /// child. Reference values captured from the TS pipeline over the same
    /// vendored model: cosine >= 0.999999 and the first dims within 1e-4.
    #[test]
    #[ignore]
    fn vectors_match_the_ts_pipeline_reference() {
        let dir = tempfile::tempdir().unwrap();
        let embedder = LocalEmbedder::new(dir.path());
        let vec = embedder
            .embed(&["how is authentication handled in this codebase".to_owned()])
            .unwrap()
            .remove(0);
        let reference = [
            -0.022683f32,
            0.067075,
            -0.050530,
            -0.086744,
            -0.029815,
            -0.023656,
            0.099194,
            -0.031297,
        ];
        for (i, r) in reference.iter().enumerate() {
            assert!(
                (vec[i] - r).abs() < 1e-4,
                "dim {i}: rust {} vs ts {r}",
                vec[i]
            );
        }
        // Full-vector cosine when the TS reference capture is present
        // (dev runs write /tmp/ts-vec.json via the TS pipeline); the
        // hard-coded first-8 check above stays the committed gate.
        if let Ok(raw) = std::fs::read_to_string("/tmp/ts-vec.json") {
            let full: Vec<f32> = serde_json::from_str(&raw).unwrap_or_default();
            if full.len() == vec.len() {
                let dot: f64 = vec
                    .iter()
                    .zip(full.iter())
                    .map(|(a, b)| (*a as f64) * (*b as f64))
                    .sum();
                let ref_norm: f64 = full
                    .iter()
                    .map(|r| (*r as f64) * (*r as f64))
                    .sum::<f64>()
                    .sqrt();
                let cosine = dot / ref_norm;
                let max_diff = vec
                    .iter()
                    .zip(full.iter())
                    .map(|(a, b)| (*a - *b).abs() as f64)
                    .fold(0.0f64, f64::max);
                println!("ts-parity: cosine {cosine:.9} max|Δ| {max_diff:.2e}");
                assert!(cosine > 0.999999, "full-vector cosine was {cosine}");
            }
        }
    }
}
