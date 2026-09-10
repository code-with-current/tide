//! Cross-encoder reranking — the optional precision stage that runs after
//! RRF fusion. A cross-encoder attends over the (query, text) pair
//! jointly, so it rescoring the fused top-20 lifts the truly-relevant
//! chunks above the merely-similar ones (the bi-encoders used for recall
//! score the two sides independently).
//!
//! The model is the optional catalog reranker ([`crate::catalog::
//! RERANKER_ENTRY`], a quantized MiniLM cross-encoder) — never vendored,
//! never downloaded implicitly: `shared` returns `None` until the files
//! exist, and every caller must degrade to the un-reranked order. Session
//! lifecycle mirrors the embedder: lazily built, memoized, memo reset on
//! failure so a transient error retries.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::catalog::{reranker_entry, LocalModelEntry};

struct RerankerSession {
    tokenizer: tokenizers::Tokenizer,
    session: ort::session::Session,
    input_names: Vec<String>,
}

/// A loaded cross-encoder. One lazily-built session per process; cheap to
/// hold (weights live in the session only after first use).
pub struct CrossEncoder {
    models_dir: PathBuf,
    entry: &'static LocalModelEntry,
    init: Mutex<Option<RerankerSession>>,
}

impl CrossEncoder {
    /// Open when the model files are present, `None` otherwise (the
    /// not-downloaded state is normal, not an error).
    pub fn open_if_present(data_dir: &Path) -> Option<Arc<Self>> {
        if !crate::local_model_exists_for(reranker_entry(), data_dir) {
            return None;
        }
        Some(Arc::new(Self {
            models_dir: crate::models_dir_for(data_dir),
            entry: reranker_entry(),
            init: Mutex::new(None),
        }))
    }

    fn session(&self) -> Result<(), String> {
        let mut guard = self.init.lock().map_err(|_| "reranker state poisoned")?;
        if guard.is_some() {
            return Ok(());
        }
        *guard = Some(self.build_session()?);
        Ok(())
    }

    fn build_session(&self) -> Result<RerankerSession, String> {
        let entry = self.entry;
        let model_dir = self.models_dir.join(entry.repo);
        let model_bytes = std::fs::read(model_dir.join("onnx").join("model_quantized.onnx"))
            .map_err(|_| {
                "reranker model is not downloaded — get it from the Memory & RAG settings"
                    .to_owned()
            })?;
        let tokenizer_bytes = std::fs::read(model_dir.join("tokenizer.json"))
            .map_err(|_| "reranker tokenizer is not downloaded".to_owned())?;

        let mut tokenizer = tokenizers::Tokenizer::from_bytes(&tokenizer_bytes)
            .map_err(|e| format!("reranker tokenizer load failed: {e}"))?;
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
            .map_err(|e| format!("reranker onnx session load failed: {e}"))?;
        let input_names: Vec<String> = session
            .inputs()
            .iter()
            .map(|o| o.name().to_string())
            .collect();
        Ok(RerankerSession {
            tokenizer,
            session,
            input_names,
        })
    }

    /// Relevance score per text, in input order — sigmoid of the model's
    /// logit, so 0.5 is the model's neutral point and higher is better.
    /// Any failure is an `Err`: callers fall back to the input order.
    pub fn score_pairs(&self, query: &str, texts: &[String]) -> Result<Vec<f32>, String> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        self.session()?;
        let mut guard = self.init.lock().map_err(|_| "reranker state poisoned")?;
        let local = guard
            .as_mut()
            .ok_or_else(|| "reranker unavailable".to_string())?;

        let mut scores = Vec::with_capacity(texts.len());
        for text in texts {
            // Proper BERT pair encoding: [CLS] query [SEP] text [SEP],
            // truncated longest-first to the pair window.
            let encoding = local
                .tokenizer
                .encode((query, text.as_str()), true)
                .map_err(|e| format!("reranker tokenize failed: {e}"))?;
            let ids: Vec<i64> = encoding
                .get_ids()
                .iter()
                .take(self.entry.max_tokens)
                .map(|&id| id as i64)
                .collect();
            let seq = ids.len();
            if seq == 0 {
                return Err("reranker tokenizer returned empty input_ids".to_string());
            }

            use ort::value::Tensor;
            let mut inputs: Vec<(String, ort::session::SessionInputValue<'_>)> = Vec::new();
            for name in &local.input_names {
                let data: Vec<i64> = if name == "input_ids" {
                    ids.clone()
                } else if name == "attention_mask" {
                    vec![1; seq]
                } else {
                    // token_type_ids and friends: segment 0 for the whole
                    // pair is what the MiniLM export was traced with.
                    vec![0; seq]
                };
                let tensor =
                    Tensor::from_array((vec![1usize, seq], data)).map_err(|e| e.to_string())?;
                inputs.push((name.clone(), tensor.into()));
            }
            let outputs = local
                .session
                .run(inputs)
                .map_err(|e| format!("reranker inference failed: {e}"))?;
            let first_name = outputs
                .keys()
                .next()
                .ok_or_else(|| "reranker produced no outputs".to_string())?
                .to_string();
            let first = &outputs[first_name.as_str()];
            let (shape, logits) = first
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("reranker output extract failed: {e}"))?;
            // Shape [1,1] (or [1,2] for two-class heads — take the active
            // logit either way: single logit for 1-class, index 1 for 2).
            let logit = match shape.last() {
                Some(&2) => logits.last().copied().unwrap_or(0.0),
                _ => logits.first().copied().unwrap_or(0.0),
            };
            scores.push(sigmoid(logit));
        }
        Ok(scores)
    }
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

// ── process-wide shared instance ──────────────────────────────────────────

static SHARED: OnceLock<Option<Arc<CrossEncoder>>> = OnceLock::new();

/// The process-wide reranker, or `None` while the model is not on disk.
/// A `None` from the files-missing check is NOT cached — a later call
/// after a download initializes normally.
pub fn shared(data_dir: &Path) -> Option<Arc<CrossEncoder>> {
    if !crate::local_model_exists_for(reranker_entry(), data_dir) {
        return None;
    }
    SHARED
        .get_or_init(|| CrossEncoder::open_if_present(data_dir))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sigmoid_maps_to_unit_interval() {
        assert!((sigmoid(0.0) - 0.5).abs() < 1e-6);
        assert!(sigmoid(10.0) > 0.99);
        assert!(sigmoid(-10.0) < 0.01);
    }

    #[test]
    fn shared_is_none_without_a_downloaded_model() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(shared(tmp.path()).is_none());
        assert!(CrossEncoder::open_if_present(tmp.path()).is_none());
    }
}
