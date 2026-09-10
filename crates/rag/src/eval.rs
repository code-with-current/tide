//! Retrieval-quality metrics for the eval harness — pure functions over
//! ranked path lists so both the golden-set test and future tuning passes
//! score identically. Targets come from the standard RAG system-design
//! baselines: Recall@5 ≥ 0.80, MRR ≥ 0.60.
//!
//! Hits are represented as ranked `Vec<String>` of paths (not chunk ids)
//! because the golden set reasons about files: a chunk-level id breaks
//! whenever chunking shifts, while "did the right file surface in the
//! top-k" is the stable, user-visible question.

/// One golden case: a query and the workspace paths that would answer it.
#[derive(Debug, Clone, PartialEq)]
pub struct EvalCase {
    pub query: String,
    /// Paths (workspace-relative, as chunk rows record them) that count
    /// as relevant for this query.
    pub expected: Vec<String>,
}

impl EvalCase {
    pub fn new(query: impl Into<String>, expected: &[&str]) -> Self {
        Self {
            query: query.into(),
            expected: expected.iter().map(|p| p.to_string()).collect(),
        }
    }
}

/// Fraction of expected paths present in the top-k. With one expected
/// path this degenerates to the standard "was it found" Recall@k.
pub fn recall_at_k(ranked: &[String], expected: &[impl AsRef<str>], k: usize) -> f64 {
    if expected.is_empty() {
        return 0.0;
    }
    let found = ranked
        .iter()
        .take(k)
        .filter(|p| expected.iter().any(|e| e.as_ref() == *p))
        .count();
    found as f64 / expected.len() as f64
}

/// Mean over cases of 1/rank of the first relevant path (0 when absent).
/// `cases` pairs each case with its ranked result list.
pub fn mrr(ranked_per_case: &[(&[String], &[String])]) -> f64 {
    if ranked_per_case.is_empty() {
        return 0.0;
    }
    let sum: f64 = ranked_per_case
        .iter()
        .map(|(ranked, expected)| reciprocal_rank(ranked, expected))
        .sum();
    sum / ranked_per_case.len() as f64
}

/// 1/rank of the first relevant path in `ranked` (0 when absent).
pub fn reciprocal_rank(ranked: &[String], expected: &[impl AsRef<str>]) -> f64 {
    ranked
        .iter()
        .position(|p| expected.iter().any(|e| e.as_ref() == *p))
        .map(|i| 1.0 / (i + 1) as f64)
        .unwrap_or(0.0)
}

/// Fraction of the top-k that are relevant.
pub fn precision_at_k(ranked: &[String], expected: &[impl AsRef<str>], k: usize) -> f64 {
    if k == 0 {
        return 0.0;
    }
    let hits = ranked
        .iter()
        .take(k)
        .filter(|p| expected.iter().any(|e| e.as_ref() == *p))
        .count();
    hits as f64 / k as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranked(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn recall_counts_expected_in_top_k() {
        let r = ranked(&["a.rs", "b.rs", "c.rs", "d.rs", "e.rs"]);
        assert_eq!(recall_at_k(&r, &["b.rs"], 5), 1.0);
        assert_eq!(recall_at_k(&r, &["b.rs"], 1), 0.0);
        assert_eq!(recall_at_k(&r, &["b.rs", "d.rs"], 3), 0.5);
        assert_eq!(recall_at_k(&r, &[] as &[&str], 5), 0.0);
    }

    #[test]
    fn mrr_scores_first_relevant_position() {
        let r = ranked(&["a.rs", "b.rs", "c.rs"]);
        let e = ["b.rs".to_string()];
        assert_eq!(mrr(&[(r.as_slice(), e.as_slice())]), 0.5);
        let missing = ranked(&["x.rs"]);
        assert_eq!(mrr(&[(missing.as_slice(), e.as_slice())]), 0.0);
        assert_eq!(mrr(&[]), 0.0);
    }

    #[test]
    fn precision_is_hits_over_k() {
        let r = ranked(&["a.rs", "b.rs", "c.rs", "d.rs"]);
        let e = ["b.rs".to_string(), "d.rs".to_string()];
        assert_eq!(precision_at_k(&r, &e, 4), 0.5);
        assert_eq!(precision_at_k(&r, &e, 0), 0.0);
    }
}
