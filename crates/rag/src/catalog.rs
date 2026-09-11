//! Curated local embedding models. The ids are the stable keys indexes
//! record in their embedding plan; `repo` is the original HuggingFace
//! name and the user-facing display string. File lists and sizes were
//! HEAD-verified against the repos (2026-09-08; the four 2026-09-09
//! additions verified via the HF API the same day).

/// One catalog entry. Static data — the whole catalog compiles in.
pub struct LocalModelEntry {
    /// Stable embedder id (`local-code-512`, …) — what gets recorded.
    pub id: &'static str,
    /// Original HuggingFace repo (display name in the picker).
    pub repo: &'static str,
    /// Output vector dimensions; must match the ONNX output layer.
    pub dims: usize,
    /// Positional-embedding window; chunk text truncates here.
    pub max_tokens: usize,
    /// `"en"` or `"multilingual"` — the dense-recall language class.
    pub languages: &'static str,
    /// `https://huggingface.co/<repo>/resolve/main` download base.
    pub hf_base: &'static str,
    /// Files that constitute the model, relative to the repo root.
    pub files: &'static [&'static str],
    /// Aggregate download size in bytes (progress denominators).
    pub download_size: u64,
    /// True when the model ships inside the binary. All current entries
    /// are download-only; the field remains part of the wire contract.
    pub vendored: bool,
    /// Instruction prefixes some model families were trained with (e5);
    /// applied at tokenize time — queries and passages differ.
    pub query_prefix: Option<&'static str>,
    pub passage_prefix: Option<&'static str>,
}

/// The default entry — English, code-search fine-tune.
pub const DEFAULT_ENTRY: LocalModelEntry = LocalModelEntry {
    id: "local-code-512",
    repo: "isuruwijesiri/all-MiniLM-L6-v2-code-search-512",
    dims: 384,
    max_tokens: 512,
    languages: "en",
    hf_base: "https://huggingface.co/isuruwijesiri/all-MiniLM-L6-v2-code-search-512/resolve/main",
    files: &[
        "onnx/model_quantized.onnx",
        "tokenizer.json",
        "tokenizer_config.json",
        "config.json",
    ],
    // 22,862,151 + 711,649 + 1,464 + 611
    download_size: 23_575_875,
    vendored: false,
    query_prefix: None,
    passage_prefix: None,
};

/// Multilingual small (XLM-R based, still a plain BertModel ONNX export).
pub const MLE5_SMALL_ENTRY: LocalModelEntry = LocalModelEntry {
    id: "local-mle5-small",
    repo: "Xenova/multilingual-e5-small",
    dims: 384,
    max_tokens: 512,
    languages: "multilingual",
    hf_base: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main",
    files: &[
        "onnx/model_quantized.onnx",
        "tokenizer.json",
        "tokenizer_config.json",
        "config.json",
    ],
    // 118,308,185 + 17,082,730 + 443 + 658
    download_size: 135_392_016,
    vendored: false,
    query_prefix: Some("query: "),
    passage_prefix: Some("passage: "),
};

/// Multilingual long-context (XLM-R, 8192-token window, 1 GB-class
/// download — the heavy option).
pub const BGE_M3_ENTRY: LocalModelEntry = LocalModelEntry {
    id: "local-bge-m3",
    repo: "Xenova/bge-m3",
    dims: 1024,
    max_tokens: 8192,
    languages: "multilingual",
    hf_base: "https://huggingface.co/Xenova/bge-m3/resolve/main",
    files: &[
        "onnx/model_quantized.onnx",
        "tokenizer.json",
        "tokenizer_config.json",
        "config.json",
    ],
    // 569,694,530 + 17,082,821 + 1,173 + 770
    download_size: 586_779_294,
    vendored: false,
    query_prefix: None,
    passage_prefix: None,
};

/// The sentence-transformers classic (Xenova's transformers.js export;
/// smallest download, 256-token effective window).
pub const MINILM_L6_ENTRY: LocalModelEntry = LocalModelEntry {
    id: "local-minilm-l6",
    repo: "Xenova/all-MiniLM-L6-v2",
    dims: 384,
    // The position table holds 512, but the model was trained at 256 —
    // the sentence-transformers window is the honest cap.
    max_tokens: 256,
    languages: "en",
    hf_base: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main",
    files: &[
        "onnx/model_quantized.onnx",
        "tokenizer.json",
        "tokenizer_config.json",
        "config.json",
    ],
    // 22,972,370 + 711,661 + 366 + 650
    download_size: 23_685_047,
    vendored: false,
    query_prefix: None,
    passage_prefix: None,
};

/// BAAI bge-small-en-v1.5 (MIT). Queries carry bge's retrieval
/// instruction; documents embed raw.
pub const BGE_SMALL_ENTRY: LocalModelEntry = LocalModelEntry {
    id: "local-bge-small",
    repo: "Xenova/bge-small-en-v1.5",
    dims: 384,
    max_tokens: 512,
    languages: "en",
    hf_base: "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main",
    files: &[
        "onnx/model_quantized.onnx",
        "tokenizer.json",
        "tokenizer_config.json",
        "config.json",
    ],
    // 34,014,426 + 711,396 + 366 + 683
    download_size: 34_726_871,
    vendored: false,
    query_prefix: Some("Represent this sentence for searching relevant passages: "),
    passage_prefix: None,
};

/// Snowflake arctic-embed-s (Apache-2.0, trained without instruction
/// prefixes — the Snowflake repo ships the ONNX itself).
pub const ARCTIC_S_ENTRY: LocalModelEntry = LocalModelEntry {
    id: "local-arctic-s",
    repo: "Snowflake/snowflake-arctic-embed-s",
    dims: 384,
    max_tokens: 512,
    languages: "en",
    hf_base: "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main",
    files: &[
        "onnx/model_quantized.onnx",
        "tokenizer.json",
        "tokenizer_config.json",
        "config.json",
    ],
    // 34,015,111 + 711,649 + 1,433 + 703
    download_size: 34_728_896,
    vendored: false,
    query_prefix: None,
    passage_prefix: None,
};

/// nomic-embed-text-v1.5 (768 dims, mandatory task prefixes). The plain
/// ONNX graph is trained at 2048 positions — the advertised 8192 needs
/// the YARN sentence-transformers path, which the local runner does not
/// use, so the catalog caps at the trained window. The official repo is
/// ungated and ships the ONNX itself (Xenova's mirror is gated).
pub const NOMIC_V15_ENTRY: LocalModelEntry = LocalModelEntry {
    id: "local-nomic-v15",
    repo: "nomic-ai/nomic-embed-text-v1.5",
    dims: 768,
    max_tokens: 2048,
    languages: "en",
    hf_base: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main",
    files: &[
        "onnx/model_quantized.onnx",
        "tokenizer.json",
        "tokenizer_config.json",
        "config.json",
    ],
    // 137,296,292 + 711,396 + 1,191 + 2,538
    download_size: 138_011_417,
    vendored: false,
    query_prefix: Some("search_query: "),
    passage_prefix: Some("search_document: "),
};

/// The full catalog, display order.
pub const CATALOG: &[LocalModelEntry] = &[
    DEFAULT_ENTRY,
    MINILM_L6_ENTRY,
    BGE_SMALL_ENTRY,
    ARCTIC_S_ENTRY,
    NOMIC_V15_ENTRY,
    MLE5_SMALL_ENTRY,
    BGE_M3_ENTRY,
];

/// Look up an entry by embedder id.
pub fn entry(id: &str) -> Option<&'static LocalModelEntry> {
    CATALOG.iter().find(|e| e.id == id)
}

/// The default entry (`local-code-512`).
pub fn default_entry() -> &'static LocalModelEntry {
    &DEFAULT_ENTRY
}

/// Is this id a catalog (local) embedder?
pub fn is_local_id(id: &str) -> bool {
    entry(id).is_some()
}

// ── reranker ──────────────────────────────────────────────────────────────

/// The optional cross-encoder reranker. Deliberately NOT in `CATALOG` —
/// it is not an embedder choice, so it must not appear in the embedder
/// picker — but it reuses the same `LocalModelEntry` shape so the
/// downloader/exists-check/progress plumbing works unchanged. `dims` is
/// meaningless for a cross-encoder (it scores pairs, it does not embed);
/// `max_tokens` is the pair window (query + passage truncate here).
/// File sizes HEAD-verified against the repo on 2026-09-09.
pub const RERANKER_ENTRY: LocalModelEntry = LocalModelEntry {
    id: "rerank-msmarco-miniilm",
    repo: "Xenova/ms-marco-MiniLM-L-6-v2",
    dims: 1,
    max_tokens: 512,
    languages: "en",
    hf_base: "https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main",
    files: &["onnx/model_quantized.onnx", "tokenizer.json"],
    // 23,143,499 + 711,396
    download_size: 23_854_895,
    vendored: false,
    query_prefix: None,
    passage_prefix: None,
};

/// The reranker entry (download/exists checks key on it).
pub fn reranker_entry() -> &'static LocalModelEntry {
    &RERANKER_ENTRY
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ids_are_unique_and_nonempty() {
        let ids: HashSet<&str> = CATALOG.iter().map(|e| e.id).collect();
        assert_eq!(ids.len(), CATALOG.len());
        assert!(ids.iter().all(|id| !id.is_empty()));
    }

    #[test]
    fn catalog_entries_are_download_only_and_have_sizes() {
        for e in CATALOG {
            assert!(!e.vendored, "{} must not ship in the app", e.id);
            assert!(e.download_size > 0, "{} needs a progress size", e.id);
        }
    }

    #[test]
    fn entries_carry_sane_dimensions_files_and_languages() {
        for e in CATALOG {
            assert!(e.dims > 0, "{}", e.id);
            assert!(e.max_tokens > 0, "{}", e.id);
            assert!(matches!(e.languages, "en" | "multilingual"), "{}", e.id);
            assert!(!e.files.is_empty(), "{}", e.id);
            assert!(
                e.files.iter().any(|f| f.ends_with(".onnx")),
                "{} needs an ONNX file",
                e.id
            );
            assert!(e.files.contains(&"tokenizer.json"), "{}", e.id);
        }
    }

    #[test]
    fn lookup_and_default() {
        assert_eq!(entry("local-code-512").unwrap().repo, DEFAULT_ENTRY.repo);
        assert_eq!(entry("local-mle5-small").unwrap().dims, 384);
        assert_eq!(entry("local-bge-m3").unwrap().dims, 1024);
        assert!(entry("cloud-base").is_none());
        assert!(entry("custom-x").is_none());
        assert!(is_local_id("local-bge-m3"));
        assert!(!is_local_id("cloud-base"));
    }

    #[test]
    fn same_dims_different_space_exists_in_the_catalog() {
        // The e5 entry deliberately shares 384 dims with the default while
        // being a different vector space — the id-based plan lock (not the
        // dims check) is what must catch a switch between them.
        assert_eq!(
            default_entry().dims,
            entry("local-mle5-small").unwrap().dims
        );
        assert_ne!(default_entry().id, MLE5_SMALL_ENTRY.id);
    }
}
