//! Golden-set retrieval eval — the harness every RAG quality change
//! (reranker, fusion weights, chunking) is measured against. Builds a
//! deterministic synthetic workspace, ingests it with the vendored
//! embedder, and asserts the standard baselines: Recall@5 ≥ 0.80,
//! MRR ≥ 0.60. The fusion here mirrors `tools::rrf_fuse` (rag does not
//! depend on tools); the real-seam path — RagMemoryIndex, config gates,
//! knowledge fusion — is pinned separately in the backend crate's tests.

use std::path::{Path, PathBuf};

use rag::embedder::LocalEmbedder;
use rag::{
    default_entry, ingest_workspace, unix_ms_now, EmbedUse, Embedder, EmbeddingPlan,
    WorkspaceIngestInputs,
};

// ── synthetic corpus ──────────────────────────────────────────────────────

/// (file stem, functions as (name, body signal)). Bodies are realistic
/// enough for the embedder and FTS to discriminate; every file lives in
/// `src/` and is Rust so the tree-sitter chunker parses it.
fn corpus() -> Vec<(&'static str, Vec<(&'static str, &'static str)>)> {
    vec![
        (
            "auth_login",
            vec![
                (
                    "login_with_password",
                    "Verify the password hash against the stored credential and issue a session token for the user account.",
                ),
                (
                    "verify_session",
                    "Check that the session cookie is present, not expired, and belongs to an authenticated user.",
                ),
            ],
        ),
        (
            "auth_oauth",
            vec![
                (
                    "refresh_oauth_token",
                    "Exchange the stored refresh token with the OAuth provider for a new access token when it expires.",
                ),
                (
                    "exchange_authorization_code",
                    "Complete the OAuth authorization code flow by trading the code for tokens at the provider token endpoint.",
                ),
            ],
        ),
        (
            "payments_charge",
            vec![
                (
                    "create_charge",
                    "Charge the customer credit card for the order total through the payment processor.",
                ),
                (
                    "capture_charge",
                    "Capture a previously authorized payment so funds settle into the merchant balance.",
                ),
            ],
        ),
        (
            "payments_refund",
            vec![
                (
                    "issue_refund",
                    "Return the money to the customer by refunding the original payment back to their card.",
                ),
            ],
        ),
        (
            "db_migrate",
            vec![
                (
                    "run_migrations",
                    "Apply pending database schema migrations in order, recording each applied migration version.",
                ),
                (
                    "create_schema",
                    "Create the initial database tables and indexes for a fresh installation.",
                ),
            ],
        ),
        (
            "db_pool",
            vec![(
                "open_connection_pool",
                "Open a postgres connection pool with the configured maximum connections and idle timeout.",
            )],
        ),
        (
            "http_routes",
            vec![
                (
                    "mount_routes",
                    "Register the HTTP API endpoints on the router, wiring each path to its handler.",
                ),
                (
                    "route_health_check",
                    "Handle the health check endpoint returning service status for the load balancer.",
                ),
            ],
        ),
        (
            "webhook_verify",
            vec![(
                "verify_webhook_signature",
                "Compute the hmac signature over the raw webhook payload body and compare it with the delivered signature header.",
            )],
        ),
        (
            "cache_store",
            vec![
                (
                    "cache_get",
                    "Look up a key in the cache and return the stored value when present and not expired.",
                ),
                (
                    "cache_set_with_ttl",
                    "Store a value in the cache with a time to live so the entry expires after ttl seconds.",
                ),
            ],
        ),
        (
            "queue_worker",
            vec![
                (
                    "process_job_queue",
                    "Poll the background job queue, claim the next pending job and execute it.",
                ),
                (
                    "retry_failed_jobs",
                    "Requeue failed background jobs with exponential backoff up to the retry limit.",
                ),
            ],
        ),
        (
            "config_loader",
            vec![
                (
                    "parse_config_file",
                    "Read the yaml settings file from disk and deserialize it into the application configuration.",
                ),
                (
                    "load_env_overrides",
                    "Overlay environment variables on top of the parsed settings so deployment config wins.",
                ),
            ],
        ),
        (
            "log_format",
            vec![(
                "init_tracing",
                "Initialize structured json logging for the service with the configured verbosity level.",
            )],
        ),
        (
            "email_send",
            vec![(
                "send_welcome_email",
                "Send an email to newly registered users welcoming them to the service.",
            )],
        ),
        (
            "file_upload",
            vec![
                (
                    "store_uploaded_file",
                    "Persist an uploaded image file to object storage under a content addressed key.",
                ),
                (
                    "validate_image_dimensions",
                    "Check the uploaded image width and height against the allowed upload limits.",
                ),
            ],
        ),
    ]
}

fn write_corpus(root: &Path) {
    for (stem, fns) in corpus() {
        let mut body = String::from("use std::collections::HashMap;\n\n");
        for (name, doc) in fns {
            body.push_str(&format!(
                "/// {doc}\npub fn {name}(input: &str) -> Result<HashMap<String, String>, String> {{\n    let _ = input;\n    Ok(HashMap::new())\n}}\n\n"
            ));
        }
        std::fs::write(root.join("src").join(format!("{stem}.rs")), body).unwrap();
    }
}

// ── eval pipeline ─────────────────────────────────────────────────────────

/// The memory tool's query shape at the store level: vector + FTS lanes
/// fused with reciprocal rank fusion (rank-only, k=60), the same merge
/// `tools::rrf_fuse` performs on the two `MemoryIndex` lanes.
fn rrf_fuse_paths(vector: Vec<String>, fts: Vec<String>, k: usize) -> Vec<String> {
    const RRF_K: f64 = 60.0;
    let mut scores: Vec<(f64, String)> = Vec::new();
    for (rank, p) in vector.into_iter().enumerate() {
        scores.push((1.0 / (RRF_K + rank as f64 + 1.0), p));
    }
    for (rank, p) in fts.into_iter().enumerate() {
        let s = 1.0 / (RRF_K + rank as f64 + 1.0);
        match scores.iter_mut().find(|(_, q)| *q == p) {
            Some(entry) => entry.0 += s,
            None => scores.push((s, p)),
        }
    }
    scores.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scores.truncate(k);
    scores.into_iter().map(|(_, p)| p).collect()
}

fn golden_cases() -> Vec<rag::eval::EvalCase> {
    vec![
        rag::eval::EvalCase::new(
            "how do users sign in with a password",
            &["src/auth_login.rs"],
        ),
        rag::eval::EvalCase::new(
            "refresh an expired oauth access token",
            &["src/auth_oauth.rs"],
        ),
        rag::eval::EvalCase::new(
            "charge the customer credit card",
            &["src/payments_charge.rs"],
        ),
        rag::eval::EvalCase::new(
            "give the customer their money back",
            &["src/payments_refund.rs"],
        ),
        rag::eval::EvalCase::new(
            "apply pending database schema migrations",
            &["src/db_migrate.rs"],
        ),
        rag::eval::EvalCase::new("postgres connection pool setup", &["src/db_pool.rs"]),
        rag::eval::EvalCase::new(
            "register http api endpoints on the router",
            &["src/http_routes.rs"],
        ),
        rag::eval::EvalCase::new(
            "verify webhook payload signature with hmac",
            &["src/webhook_verify.rs"],
        ),
        rag::eval::EvalCase::new(
            "store a cache entry that expires after ttl seconds",
            &["src/cache_store.rs"],
        ),
        rag::eval::EvalCase::new(
            "background job queue with retries and backoff",
            &["src/queue_worker.rs"],
        ),
        rag::eval::EvalCase::new(
            "read yaml settings and environment variable overrides",
            &["src/config_loader.rs"],
        ),
        rag::eval::EvalCase::new(
            "structured json logging initialization",
            &["src/log_format.rs"],
        ),
        rag::eval::EvalCase::new(
            "send an email to newly registered users",
            &["src/email_send.rs"],
        ),
        rag::eval::EvalCase::new(
            "validate uploaded image file dimensions",
            &["src/file_upload.rs"],
        ),
        // Paraphrase-only cases (no keyword overlap with the corpus) —
        // the sensitivity half of the harness.
        rag::eval::EvalCase::new(
            "who checks that a login cookie is still valid",
            &["src/auth_login.rs"],
        ),
        rag::eval::EvalCase::new(
            "prioritize and re-run unsuccessful background tasks",
            &["src/queue_worker.rs"],
        ),
        rag::eval::EvalCase::new(
            "make sure uploaded pictures are not too large",
            &["src/file_upload.rs"],
        ),
    ]
}

/// Build the workspace + index once per test and share it across cases.
struct EvalIndex {
    ws_root: PathBuf,
    _dir: tempfile::TempDir,
    store: rag::RagStore,
    embedder: LocalEmbedder,
}

fn build_index() -> EvalIndex {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("ws");
    std::fs::create_dir_all(ws.join("src")).unwrap();
    write_corpus(&ws);

    let data = dir.path().join("data");
    let embedder = LocalEmbedder::new(&data, default_entry());
    let entry = default_entry();
    let plan = EmbeddingPlan {
        embedder_id: entry.id.to_owned(),
        dims: entry.dims,
        chunk_size: None,
        chunk_overlap: None,
        created_at: unix_ms_now(),
    };
    let result = ingest_workspace(
        WorkspaceIngestInputs {
            workspace_id: "eval",
            path: &ws,
            worktree_location: None,
            data_dir: &data,
        },
        &embedder,
        &plan,
        |_| {},
    )
    .expect("ingest succeeds");
    assert!(result.chunks_total >= 20, "corpus should chunk richly");

    let store = rag::RagStore::open(&data, "eval").unwrap();
    EvalIndex {
        ws_root: ws,
        _dir: dir,
        store,
        embedder,
    }
}

impl EvalIndex {
    /// Chunk rows grouped under one absolute path (paths in chunk rows
    /// are absolute; expectations are workspace-relative).
    fn text_for_path(&self, rel: &str) -> String {
        let abs = self.ws_root.join(rel).to_string_lossy().into_owned();
        self.store
            .by_path(&abs)
            .unwrap_or_default()
            .into_iter()
            .take(2)
            .map(|c| c.content.clone())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Ranked workspace-relative paths for one query through the fused path.
fn ranked_paths(index: &EvalIndex, query: &str, k: usize) -> Vec<String> {
    let vec = index
        .embedder
        .embed_use(&[query.to_owned()], EmbedUse::Query)
        .expect("query embeds")
        .into_iter()
        .next()
        .unwrap();
    let rel = |abs: String| {
        abs.strip_prefix(&index.ws_root.to_string_lossy().into_owned())
            .unwrap_or(&abs)
            .trim_start_matches('/')
            .to_string()
    };
    let vector = index
        .store
        .query_by_vector(&vec, k)
        .unwrap()
        .into_iter()
        .map(|h| rel(h.row.path))
        .collect();
    let fts = index
        .store
        .query_by_fts(query, k)
        .unwrap()
        .into_iter()
        .map(|h| rel(h.row.path))
        .collect();
    let fused = rrf_fuse_paths(vector, fts, k * 3);
    // Several chunks of one file can occupy several fused ranks (fusion
    // is chunk-id based upstream); the file-level metric wants first
    // occurrence per path only.
    let mut seen = std::collections::HashSet::new();
    let deduped: Vec<String> = fused
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect();
    deduped.into_iter().take(k).collect()
}

const BASELINE_RECALL_AT_5: f64 = 0.80;
const BASELINE_MRR: f64 = 0.60;

#[test]
fn fused_retrieval_meets_the_golden_set_baselines() {
    let index = build_index();
    let cases = golden_cases();

    let mut recalls = Vec::new();
    let mut rrs = Vec::new();
    for case in &cases {
        let ranked = ranked_paths(&index, &case.query, 5);
        recalls.push(rag::eval::recall_at_k(&ranked, &case.expected, 5));
        rrs.push(rag::eval::reciprocal_rank(&ranked, &case.expected));
    }
    let recall = recalls.iter().sum::<f64>() / recalls.len() as f64;
    let score = rrs.iter().sum::<f64>() / rrs.len() as f64;

    // Name the misses so a regression is diagnosable from the log.
    for case in &cases {
        let ranked = ranked_paths(&index, &case.query, 5);
        if !ranked.iter().any(|p| case.expected.contains(p)) {
            eprintln!("MISS: {:?} → {:?}", case.query, ranked);
        }
    }
    eprintln!("recall@5 = {recall:.3}, mrr = {score:.3}");

    assert!(
        recall >= BASELINE_RECALL_AT_5,
        "recall@5 {recall:.3} below baseline {BASELINE_RECALL_AT_5}"
    );
    assert!(
        score >= BASELINE_MRR,
        "mrr {score:.3} below baseline {BASELINE_MRR}"
    );
}

/// The reranker comparison runs only when the optional cross-encoder
/// model is already on disk (tests never download): reranked ordering
/// must not meaningfully lose recall against the fused baseline.
#[test]
#[ignore = "needs the downloaded reranker model (set TIDE_RAG_EVAL_RERANK=1)"]
fn rerank_does_not_lose_recall_when_model_present() {
    if std::env::var("TIDE_RAG_EVAL_RERANK").as_deref() != Ok("1") {
        return;
    }
    // The models dir honors TIDE_MODELS_DIR, so an explicit run can point
    // the check at any models root.
    let Some(reranker) = rag::rerank::CrossEncoder::open_if_present(Path::new(".")) else {
        eprintln!("reranker model not downloaded — skipping");
        return;
    };
    let index = build_index();
    let cases = golden_cases();

    let mut base_recall = 0.0;
    let mut rerank_recall = 0.0;
    for case in &cases {
        let ranked = ranked_paths(&index, &case.query, 20);
        let mut scored: Vec<(f32, String)> = ranked
            .iter()
            .map(|rel| {
                let text = index.text_for_path(rel);
                let score = reranker
                    .score_pairs(&case.query, &[text])
                    .ok()
                    .and_then(|s| s.first().copied())
                    .unwrap_or(f32::NEG_INFINITY);
                (score, rel.clone())
            })
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let reranked: Vec<String> = scored.into_iter().map(|(_, p)| p).take(5).collect();
        base_recall += rag::eval::recall_at_k(&ranked, &case.expected, 5);
        rerank_recall += rag::eval::recall_at_k(&reranked, &case.expected, 5);
    }
    let n = cases.len() as f64;
    eprintln!(
        "recall@5 fused = {:.3}, reranked = {:.3}",
        base_recall / n,
        rerank_recall / n
    );
    assert!(
        rerank_recall + 0.5 >= base_recall,
        "rerank lost recall: {rerank_recall:.3} vs fused {base_recall:.3}"
    );
}
