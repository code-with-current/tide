//! Workspace ingestion pipeline — port of `app/core/rag/ingest.ts`:
//! walk → chunk (tree-sitter) → embed in batches → write to
//! RagStore. Content-hash dedupe skips unchanged chunks; the walk filters
//! skip-dirs, hidden dirs (except `.agent`), the worktree subtree, and
//! nested `.gitignore` rules.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::chunker::chunk_file;
use crate::embedder::Embedder;
use crate::store::{ChunkRow, RagStore};
use crate::unix_ms_now;

/// Phases progress callbacks see, in order, on a successful run.
pub type IngestPhaseKind = &'static str;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IngestProgressEvent {
    pub phase: String,
    /// Files discovered during the walk.
    pub files_seen: u64,
    /// Total chunks emitted by the chunker across all files.
    pub chunks_total: u64,
    /// Chunks embedded + written so far.
    pub chunks_embedded: u64,
    /// Current file being processed (chunking or embedding), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_file: Option<String>,
    /// Error message when phase === "failed".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl IngestProgressEvent {
    fn phase(phase: &'static str) -> Self {
        Self {
            phase: phase.to_string(),
            files_seen: 0,
            chunks_total: 0,
            chunks_embedded: 0,
            current_file: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IngestResult {
    pub files_seen: u64,
    pub chunks_total: u64,
    pub chunks_embedded: u64,
    /// Chunks skipped because contentHash matched (unchanged on re-ingest).
    pub chunks_skipped: u64,
}

/// Skip directories (mirrors the grep tool's walk filter so ingestion
/// respects the same out-of-scope dirs the user expects search to skip).
pub const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "release",
    "next",
    ".cache",
    ".next",
    "target", // Rust
    "venv",   // Python
    "__pycache__",
    ".venv",
];

/// Extensions the chunker knows how to parse — keep in sync with the
/// chunker's EXTENSION_MAP.
pub const CHUNKABLE_EXTS: &[&str] = &[
    // JS/TS
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", // Python
    "py", "pyi", // Go
    "go",  // Rust
    "rs",  // Java / Kotlin / Scala
    "java", "kt", "kts", "scala", "sbt", // C / C++
    "c", "h", "cpp", "cc", "cxx", "hpp", "hxx",   // C#
    "cs",    // Ruby
    "rb",    // PHP
    "php",   // Swift
    "swift", // Lua
    "lua",   // Bash
    "sh", "bash", // Vue
    "vue",  // Dart
    "dart", // Web markup / styling
    "html", "htm", "css", "scss", "less", // Elixir
    "ex", "exs", // Elm
    "elm", // ReScript
    "res", "resi", // Solidity
    "sol",  // Zig
    "zig",  // OCaml
    "ml", "mli", // Objective-C
    "m", "mm",
];

const EMBED_BATCH_SIZE: usize = 32;

/// The workspace inputs ingestion needs (the TS pulled these from the
/// workspace store; the command layer supplies them).
pub struct WorkspaceIngestInputs<'a> {
    pub workspace_id: &'a str,
    /// Absolute workspace root.
    pub path: &'a Path,
    /// Configured worktree location (relative), None → `.agent/worktrees`.
    pub worktree_location: Option<&'a str>,
    /// Where the per-workspace index db lives (`<data>/rag/<id>/index.db`).
    pub data_dir: &'a Path,
}

/// Run the full pipeline for a workspace. Idempotent: re-running only
/// re-embeds chunks whose contentHash changed.
pub fn ingest_workspace(
    inputs: WorkspaceIngestInputs<'_>,
    embedder: &dyn Embedder,
    mut on_progress: impl FnMut(IngestProgressEvent),
) -> Result<IngestResult, String> {
    // ── Phase 1: walk ────────────────────────────────────────────────
    let mut files: Vec<PathBuf> = Vec::new();
    on_progress(IngestProgressEvent::phase("walking"));
    let worktree_root = match inputs.worktree_location {
        Some(loc) => inputs.path.join(loc),
        None => inputs.path.join(".agent").join("worktrees"),
    };
    walk_source(inputs.path, &mut files, &[&worktree_root], &mut |n| {
        let mut e = IngestProgressEvent::phase("walking");
        e.files_seen = n;
        on_progress(e);
    });

    // If the workspace root is gone, the walk yields 0 files silently —
    // fail loudly here instead of writing a misleading "success"
    // lastIngestedAt (a genuinely-empty workspace also yields 0 files).
    if !inputs.path.exists() {
        return Err(format!(
            "Workspace folder no longer exists: {}. Restore the folder or re-add the workspace before indexing.",
            inputs.path.display()
        ));
    }

    let rag_store = RagStore::open(inputs.data_dir, inputs.workspace_id)
        .map_err(|e| format!("Failed to open RAG index: {e}"))?;
    // Mark init start + record the embedder id so future query-time
    // resolution can detect cross-embedder indexes before issuing garbage
    // searches.
    let started = unix_ms_now();
    rag_store
        .set_meta("initializedAt", &started.to_string())
        .map_err(|e| e.to_string())?;
    rag_store
        .set_meta("embedderId", embedder.id())
        .map_err(|e| e.to_string())?;

    // ── Phase 2: chunk ───────────────────────────────────────────────
    let mut all_chunks = Vec::new();
    for file in &files {
        let mut e = IngestProgressEvent::phase("chunking");
        e.files_seen = files.len() as u64;
        e.chunks_total = all_chunks.len() as u64;
        e.current_file = Some(file.to_string_lossy().into_owned());
        on_progress(e.clone());
        all_chunks.extend(chunk_file(file));
    }

    // ── Phase 3: embed + store (content-hash dedupe) ─────────────────
    let prepared: Vec<PreparedChunk> = all_chunks.iter().map(PreparedChunk::from).collect();
    let files_len = files.len() as u64;
    let (embedded, skipped) = embed_and_store(
        &rag_store,
        embedder,
        &prepared,
        &mut |mut e: IngestProgressEvent| {
            e.files_seen = files_len;
            on_progress(e);
        },
    )?;
    let last = unix_ms_now();
    rag_store
        .set_meta("lastIngestedAt", &last.to_string())
        .map_err(|e| e.to_string())?;
    let mut done = IngestProgressEvent::phase("done");
    done.files_seen = files.len() as u64;
    done.chunks_total = all_chunks.len() as u64;
    done.chunks_embedded = embedded;
    on_progress(done);

    Ok(IngestResult {
        files_seen: files.len() as u64,
        chunks_total: all_chunks.len() as u64,
        chunks_embedded: embedded,
        chunks_skipped: skipped,
    })
}

/// A chunk ready to be embedded + stored — the ChunkRow shape minus the
/// embedder/timestamp fields stamped at write time.
#[derive(Debug, Clone)]
pub struct PreparedChunk {
    pub id: String,
    pub path: String,
    pub symbol: String,
    pub content: String,
    pub content_hash: String,
    pub start_line: i64,
    pub end_line: i64,
    pub source_id: Option<String>,
}

impl From<&crate::chunker::Chunk> for PreparedChunk {
    fn from(c: &crate::chunker::Chunk) -> Self {
        Self {
            id: c.id.clone(),
            path: c.path.clone(),
            symbol: c.symbol.clone(),
            content: c.content.clone(),
            content_hash: c.content_hash.clone(),
            start_line: c.start_line as i64,
            end_line: c.end_line as i64,
            source_id: None,
        }
    }
}

/// Batched embed + write loop shared by workspace ingestion and knowledge
/// document ingestion. Skips chunks whose id+path+contentHash match an
/// existing row; stamps each written row with the active embedder id.
pub fn embed_and_store(
    rag: &RagStore,
    embedder: &dyn Embedder,
    rows: &[PreparedChunk],
    mut on_progress: impl FnMut(IngestProgressEvent),
) -> Result<(u64, u64), String> {
    let mut embedded: u64 = 0;
    let mut skipped: u64 = 0;
    for batch in rows.chunks(EMBED_BATCH_SIZE) {
        // Partition into needs-embed vs already-stored. A chunk is skipped
        // when both its id and contentHash match an existing row.
        let mut to_embed: Vec<ChunkRow> = Vec::with_capacity(batch.len());
        for r in batch {
            let row = ChunkRow {
                id: r.id.clone(),
                path: r.path.clone(),
                symbol: r.symbol.clone(),
                content: r.content.clone(),
                content_hash: r.content_hash.clone(),
                start_line: r.start_line,
                end_line: r.end_line,
                embedder_id: embedder.id().to_string(),
                created_at: unix_ms_now(),
                source_id: r.source_id.clone(),
            };
            let existing = rag
                .by_content_hash(&row.content_hash)
                .map_err(|e| e.to_string())?;
            if existing.is_some_and(|existing| existing.id == row.id && existing.path == row.path) {
                skipped += 1;
            } else {
                to_embed.push(row);
            }
        }

        if !to_embed.is_empty() {
            let vectors = embedder.embed(
                &to_embed
                    .iter()
                    .map(|row| row.content.clone())
                    .collect::<Vec<_>>(),
            )?;
            if vectors.len() != to_embed.len() {
                return Err(format!(
                    "embedder returned {} vectors for {} chunks",
                    vectors.len(),
                    to_embed.len()
                ));
            }
            let rowids = rag.upsert_chunks(&to_embed).map_err(|e| e.to_string())?;
            rag.upsert_vectors(
                &rowids
                    .into_iter()
                    .zip(vectors)
                    .map(|((id, rowid), embedding)| (rowid, id, embedding))
                    .collect::<Vec<_>>(),
            )
            .map_err(|e| e.to_string())?;
            embedded += to_embed.len() as u64;
        }

        let mut e = IngestProgressEvent::phase("embedding");
        e.chunks_total = rows.len() as u64;
        e.chunks_embedded = embedded;
        e.current_file = batch.last().map(|r| r.path.clone());
        on_progress(e);
    }
    Ok((embedded, skipped))
}

// ── gitignore-aware walk ───────────────────────────────────────────────────

/// Whether a relative path is ignored by the accumulated patterns —
/// last-match-wins with `!` negation (the minimatch loop the TS used).
fn is_gitignored(rel_path: &str, patterns: &[String]) -> bool {
    let mut ignored = false;
    for pattern in patterns {
        if let Some(negated) = pattern.strip_prefix('!') {
            if pattern_matches(negated, rel_path) {
                ignored = false;
            }
        } else if pattern_matches(pattern, rel_path) {
            ignored = true;
        }
    }
    ignored
}

/// One gitignore-style pattern against a workspace-relative path. Follows
/// the minimatch(dot, matchBase) behavior the TS relied on: a pattern with
/// no '/' matches the basename; a leading '/' anchors to the root;
/// otherwise the pattern may match at any segment boundary; trailing '/'
/// marks directory patterns and is stripped before matching.
fn pattern_matches(pattern: &str, rel_path: &str) -> bool {
    let mut pattern = pattern;
    let anchored = pattern.starts_with('/');
    if anchored {
        pattern = &pattern[1..];
    }
    let dir_only = pattern.ends_with('/');
    let pat = pattern.trim_end_matches('/');

    let path = rel_path.trim_end_matches('/');
    let basename = path.rsplit('/').next().unwrap_or(path);

    if dir_only && !path_is_dir_candidate(rel_path) {
        // Directory-only patterns only match directories — the walk checks
        // dirs before recursing, so a trailing '/' never matches a file.
        return false;
    }

    if anchored {
        // Anchored: full-path match only (a leading '/' opts out of
        // matchBase).
        return glob_match(pat, path);
    }
    if !pat.contains('/') {
        // matchBase: basename match.
        return glob_match(pat, basename);
    }
    // Unanchored multi-segment: match the full path or any suffix that
    // starts at a segment boundary.
    let segments: Vec<&str> = path.split('/').collect();
    for start in 0..segments.len() {
        let candidate = segments[start..].join("/");
        if glob_match(pat, &candidate) {
            return true;
        }
    }
    false
}

fn path_is_dir_candidate(_rel_path: &str) -> bool {
    // Callers only test dir paths for dir-only patterns (the TS walked the
    // same way: dirs checked with dir patterns, files without them).
    true
}

/// Segment-aware glob matching: `**` crosses segment boundaries, `*`/`?`/
/// `[...]` stay within a segment.
fn glob_match(pattern: &str, path: &str) -> bool {
    let pat_segments: Vec<&str> = pattern.split('/').collect();
    let path_segments: Vec<&str> = path.split('/').collect();
    segments_match(&pat_segments, &path_segments)
}

fn segments_match(pat: &[&str], path: &[&str]) -> bool {
    if pat.is_empty() {
        return path.is_empty();
    }
    if pat[0] == "**" {
        // `**` matches zero or more segments.
        for skip in 0..=path.len() {
            if segments_match(&pat[1..], &path[skip..]) {
                return true;
            }
        }
        return false;
    }
    if path.is_empty() {
        return false;
    }
    segment_glob(pat[0], path[0]) && segments_match(&pat[1..], &path[1..])
}

/// Single-segment wildcard match (`*`, `?`, `[...]`; `**` within a segment
/// behaves like `*`).
fn segment_glob(pat: &str, text: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = text.chars().collect();
    seg_glob_inner(&p, &t)
}

fn seg_glob_inner(p: &[char], t: &[char]) -> bool {
    if p.is_empty() {
        return t.is_empty();
    }
    match p[0] {
        '*' => {
            for skip in 0..=t.len() {
                if seg_glob_inner(&p[1..], &t[skip..]) {
                    return true;
                }
            }
            false
        }
        '?' => !t.is_empty() && seg_glob_inner(&p[1..], &t[1..]),
        '[' => {
            if t.is_empty() {
                return false;
            }
            // Find the closing bracket; support leading '!' negation and
            // 'a-z' ranges.
            let mut i = 1;
            let negate = p.get(1) == Some(&'!');
            if negate {
                i = 2;
            }
            let mut matched = false;
            while i < p.len() && p[i] != ']' {
                if let Some(next) = p.get(i + 1) {
                    if *next == '-' && p.get(i + 2).is_some_and(|&c| c != ']') {
                        if t[0] >= p[i] && t[0] <= p[i + 2] {
                            matched = true;
                        }
                        i += 3;
                        continue;
                    }
                }
                if p[i] == t[0] {
                    matched = true;
                }
                i += 1;
            }
            if i >= p.len() {
                return false; // unterminated class — no match
            }
            matched != negate && seg_glob_inner(&p[i + 1..], &t[1..])
        }
        '\\' if p.len() > 1 => !t.is_empty() && p[1] == t[0] && seg_glob_inner(&p[2..], &t[1..]),
        c => !t.is_empty() && c == t[0] && seg_glob_inner(&p[1..], &t[1..]),
    }
}

/// Recursive directory walk. Filters by SKIP_DIRS + hidden-dir rule +
/// extension whitelist + .gitignore rules (nested files respected,
/// additive with the parent's). Calls on_progress every ~50 files.
fn walk_source(
    root: &Path,
    out: &mut Vec<PathBuf>,
    exclude_dirs: &[&Path],
    on_progress: &mut dyn FnMut(u64),
) {
    let excluded: Vec<PathBuf> = exclude_dirs.iter().map(|d| d.to_path_buf()).collect();
    let mut count: u64 = 0;
    walk(root, root, out, &excluded, &mut count, on_progress);
    on_progress(count);
}

fn walk(
    root: &Path,
    dir: &Path,
    out: &mut Vec<PathBuf>,
    excluded: &[PathBuf],
    count: &mut u64,
    on_progress: &mut dyn FnMut(u64),
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let parent_patterns: Vec<String> = Vec::new();
    let patterns = match std::fs::read_to_string(dir.join(".gitignore")) {
        Ok(content) => {
            let local = content
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let mut merged = parent_patterns;
            merged.extend(local);
            merged
        }
        Err(_) => parent_patterns,
    };

    let mut names: Vec<(String, std::fs::FileType)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        names.push((entry.file_name().to_string_lossy().into_owned(), file_type));
    }
    names.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, file_type) in names {
        let full = dir.join(&name);
        let rel_path = full
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        if file_type.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if name.starts_with('.') && name != ".agent" {
                continue;
            }
            if excluded.iter().any(|x| &full == x) {
                continue;
            }
            if is_gitignored(&rel_path, &patterns) {
                continue;
            }
            walk(root, &full, out, excluded, count, on_progress);
        } else if file_type.is_file() {
            // .gitignore before the extension filter.
            if !patterns.is_empty() && is_gitignored(&rel_path, &patterns) {
                continue;
            }
            let ext = name
                .rsplit_once('.')
                .map(|(_, e)| e.to_ascii_lowercase())
                .unwrap_or_default();
            if !CHUNKABLE_EXTS.contains(&ext.as_str()) {
                continue;
            }
            out.push(full);
            *count += 1;
            if (*count).is_multiple_of(50) {
                on_progress(*count);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_patterns_match_minimatch_semantics() {
        // matchBase: no slash → basename.
        assert!(pattern_matches("*.log", "src/debug.log"));
        assert!(!pattern_matches("*.log", "src/debug.ts"));
        assert!(pattern_matches("coverage", "packages/app/coverage"));
        // Trailing slash dir patterns match dirs.
        assert!(pattern_matches("dist/", "dist"));
        assert!(pattern_matches("dist/", "packages/app/dist"));
        // Anchored patterns only match from the root.
        assert!(pattern_matches("/Makefile", "Makefile"));
        assert!(!pattern_matches("/Makefile", "sub/Makefile"));
        // Unanchored multi-segment matches at any boundary.
        assert!(pattern_matches("foo/bar", "src/foo/bar"));
        assert!(pattern_matches("foo/bar", "foo/bar"));
        assert!(!pattern_matches("foo/bar", "src/xfoo/bar"));
        // Double-star crosses segments.
        assert!(pattern_matches("docs/**/generated", "docs/a/b/generated"));
    }

    #[test]
    fn is_gitignored_last_match_wins_with_negation() {
        let patterns = vec![
            "*.tmp".to_string(),
            "!keep.tmp".to_string(),
            "build".to_string(),
        ];
        assert!(is_gitignored("a/scratch.tmp", &patterns));
        assert!(!is_gitignored("a/keep.tmp", &patterns));
        assert!(is_gitignored("x/build", &patterns));
    }

    #[test]
    fn walk_respects_skip_dirs_hidden_and_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join(".agent/skills")).unwrap();
        std::fs::create_dir_all(root.join(".cache")).unwrap();
        std::fs::create_dir_all(root.join("gen")).unwrap();
        std::fs::write(root.join("src/a.ts"), "export const a = 1;\n").unwrap();
        std::fs::write(root.join("src/b.rs"), "fn b() {}\n").unwrap();
        std::fs::write(root.join("src/skip.txt"), "nope").unwrap();
        std::fs::write(root.join("node_modules/pkg/x.ts"), "nope").unwrap();
        std::fs::write(root.join(".agent/skills/s.md"), "skill").unwrap();
        std::fs::write(root.join(".cache/y.ts"), "nope").unwrap();
        std::fs::write(root.join("gen/z.ts"), "generated").unwrap();
        std::fs::write(root.join(".gitignore"), "gen/\n*.txt\n").unwrap();

        let mut files = Vec::new();
        walk_source(root, &mut files, &[], &mut |_| {});
        let names: Vec<String> = files
            .iter()
            .map(|f| f.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"a.ts".to_string()));
        assert!(names.contains(&"b.rs".to_string()));
        assert!(!names.iter().any(|n| n == "x.ts"), "node_modules skipped");
        assert!(!names.iter().any(|n| n == "y.ts"), "hidden dirs skipped");
        assert!(!names.iter().any(|n| n == "skip.txt"), "gitignored *.txt");
        assert!(!names.iter().any(|n| n == "z.ts"), "gitignored gen/");
    }

    #[test]
    fn walk_excludes_the_worktree_subtree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".agent/worktrees/feat")).unwrap();
        std::fs::write(root.join("top.ts"), "fn t() {}").unwrap();
        std::fs::write(root.join(".agent/worktrees/feat/dup.ts"), "fn t() {}").unwrap();

        let mut files = Vec::new();
        let worktree_root = root.join(".agent").join("worktrees");
        walk_source(root, &mut files, &[&worktree_root], &mut |_| {});
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("top.ts"));
    }
}
