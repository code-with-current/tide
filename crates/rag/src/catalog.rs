//! Curated local embedding models. The ids are the stable keys indexes
//! record in their embedding plan; `repo` is the original HuggingFace
//! name and the user-facing display string. File lists and sizes were
//! HEAD-verified against the repos on 2026-09-08.

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
    /// True when the model ships inside the binary (the packaged-app
    /// fallback); non-vendored entries must download before first use.
    pub vendored: bool,
    /// Instruction prefixes some model families were trained with (e5);
    /// applied at tokenize time — queries and passages differ.
    pub query_prefix: Option<&'static str>,
    pub passage_prefix: Option<&'static str>,
}

/// The default entry — vendored, English, code-search fine-tune.
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
    download_size: 0, // vendored — nothing to download
    vendored: true,
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

/// The full catalog, display order.
pub const CATALOG: &[LocalModelEntry] = &[DEFAULT_ENTRY, MLE5_SMALL_ENTRY, BGE_M3_ENTRY];

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
    fn exactly_one_vendored_entry_and_it_is_the_default() {
        let vendored: Vec<&LocalModelEntry> = CATALOG.iter().filter(|e| e.vendored).collect();
        assert_eq!(vendored.len(), 1);
        assert_eq!(vendored[0].id, default_entry().id);
        // Non-vendored entries need a real download size for progress bars.
        for e in CATALOG {
            assert!(e.vendored || e.download_size > 0, "{}", e.id);
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
        assert_eq!(default_entry().dims, entry("local-mle5-small").unwrap().dims);
        assert_ne!(default_entry().id, MLE5_SMALL_ENTRY.id);
    }
}
