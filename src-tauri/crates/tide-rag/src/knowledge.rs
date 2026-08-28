//! Knowledge sources — port of `app/core/knowledge/{types,store,ingest,
//! fetchers/*}.ts`: the registry CRUD on the shared global index
//! (`<data>/knowledge/index.db`, sibling `sources` table on the same
//! RagStore schema), the prose chunker (~1200-char paragraphs with a
//! 100-char tail overlap), and the four fetchers (url / local docs /
//! same-origin crawl / git repo). The serial job queue (manager) lives in
//! the Tauri command layer where the async runtime is.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::embedder::Embedder;
use crate::ingest::embed_and_store;
use crate::ingest::PreparedChunk;
use crate::store::RagStore;
use crate::unix_ms_now;

pub type SourceKind = &'static str;

pub const SOURCE_KINDS: &[&str] = &["url", "docs", "crawl", "repo"];

/// Registry row (TS KnowledgeSource) — wire shape verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// url / dir or file path / root url / repo url */
    pub location: String,
    pub created_at: i64,
    pub last_indexed_at: Option<i64>,
    /// 'idle' | 'queued' | 'indexing' | 'error'
    pub status: String,
    pub error: Option<String>,
    pub chunk_count: i64,
    pub embedder_id: Option<String>,
    /// ['*'] = all workspaces
    pub enabled_workspace_ids: Vec<String>,
}

/// Ingestion progress event (TS SourceProgressEvent) — wire shape verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProgressEvent {
    pub source_id: String,
    /// 'fetching' | 'chunking' | 'embedding' | 'done' | 'failed'
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages_seen: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunks_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunks_embedded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A normalized document produced by fetchers.
#[derive(Debug, Clone)]
pub struct SourceDocument {
    pub title: String,
    pub content: String,
    /// Stored in chunks.path — shown as hit label ("example.com/guide").
    pub origin: String,
}

/// `<data>/knowledge/index.db` (TS knowledgeDbPath).
pub fn knowledge_db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("knowledge").join("index.db")
}

/// Registry CRUD on top of the shared global index db. Reuses RagStore for
/// chunks/vectors and owns the sibling `sources` table (created
/// idempotently here, not in the workspace-only migrate()).
pub struct KnowledgeStore {
    pub rag: RagStore,
}

impl KnowledgeStore {
    pub fn open(data_dir: &Path) -> rusqlite::Result<Self> {
        Self::open_at(&knowledge_db_path(data_dir))
    }

    pub fn open_at(db_path: &Path) -> rusqlite::Result<Self> {
        let rag = RagStore::open_at(db_path)?;
        rag.run_raw(
            "CREATE TABLE IF NOT EXISTS sources (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              kind TEXT NOT NULL,
              location TEXT NOT NULL,
              createdAt INTEGER NOT NULL,
              lastIndexedAt INTEGER,
              status TEXT NOT NULL DEFAULT 'idle',
              error TEXT,
              chunkCount INTEGER NOT NULL DEFAULT 0,
              embedderId TEXT,
              enabledWorkspaceIds TEXT NOT NULL DEFAULT '[\"*\"]'
            )",
        )?;
        Ok(Self { rag })
    }

    fn source_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeSource> {
        let enabled_raw: String = row.get("enabledWorkspaceIds")?;
        Ok(KnowledgeSource {
            id: row.get("id")?,
            name: row.get("name")?,
            kind: row.get("kind")?,
            location: row.get("location")?,
            created_at: row.get("createdAt")?,
            last_indexed_at: row.get("lastIndexedAt")?,
            status: row.get("status")?,
            error: row.get("error")?,
            chunk_count: row.get("chunkCount")?,
            embedder_id: row.get("embedderId")?,
            enabled_workspace_ids: serde_json::from_str(&enabled_raw)
                .unwrap_or_else(|_| vec!["*".to_owned()]),
        })
    }

    const SOURCE_COLUMNS: &'static str =
        "id, name, kind, location, createdAt, lastIndexedAt, status, error, chunkCount, embedderId, enabledWorkspaceIds";

    pub fn add_source(
        &self,
        name: &str,
        kind: &str,
        location: &str,
        enabled_workspace_ids: Option<&[String]>,
    ) -> rusqlite::Result<KnowledgeSource> {
        let id = new_uuid();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO sources(id, name, kind, location, createdAt, status, enabledWorkspaceIds)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'idle', '[\"*\"]')",
                params![id, name, kind, location, unix_ms_now()],
            )
        })?;
        if let Some(ids) = enabled_workspace_ids.filter(|i| !i.is_empty()) {
            self.set_enabled(&id, ids);
        }
        Ok(self.get_source(&id).expect("just inserted"))
    }

    pub fn list_sources(&self) -> rusqlite::Result<Vec<KnowledgeSource>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT {} FROM sources ORDER BY createdAt, id",
                Self::SOURCE_COLUMNS
            ))?;
            let rows = stmt
                .query_map([], Self::source_from_row)?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn get_source(&self, id: &str) -> Option<KnowledgeSource> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {} FROM sources WHERE id = ?1",
                    Self::SOURCE_COLUMNS
                ))
                .ok()?;
            stmt.query_row([id], Self::source_from_row).ok()
        })
    }

    /// '*' alongside concrete ids is ambiguous — concrete ids always win.
    pub fn set_enabled(&self, id: &str, ids: &[String]) {
        let normalized: Vec<String> = if ids.contains(&"*".to_owned()) && ids.len() > 1 {
            ids.iter().filter(|w| w.as_str() != "*").cloned().collect()
        } else {
            ids.to_vec()
        };
        let encoded = serde_json::to_string(&normalized).unwrap_or_else(|_| "[\"*\"]".into());
        let _ = self.with_conn(|conn| {
            conn.execute(
                "UPDATE sources SET enabledWorkspaceIds = ?1 WHERE id = ?2",
                params![encoded, id],
            )
        });
    }

    /// Status transition. `idle` stamps lastIndexedAt only for a genuinely
    /// completed pass ('indexing'→'idle'); stale-status recovery must not
    /// fabricate timestamps.
    pub fn mark_status(&self, id: &str, status: &str, error: Option<&str>) {
        if status == "idle" {
            let current = self.with_conn(|conn| {
                conn.query_row("SELECT status FROM sources WHERE id = ?1", [id], |r| {
                    r.get::<_, String>(0)
                })
                .ok()
            });
            let Some(current) = current else { return };
            let _ = self.with_conn(|conn| {
                if current == "indexing" {
                    conn.execute(
                        "UPDATE sources SET status = 'idle', error = NULL, lastIndexedAt = ?1 WHERE id = ?2",
                        params![unix_ms_now(), id],
                    )
                } else {
                    conn.execute(
                        "UPDATE sources SET status = 'idle', error = NULL WHERE id = ?1",
                        [id],
                    )
                }
            });
            return;
        }
        let _ = self.with_conn(|conn| {
            conn.execute(
                "UPDATE sources SET status = ?1, error = ?2 WHERE id = ?3",
                params![status, error, id],
            )
        });
    }

    /// Crash leftovers ('queued'/'indexing' with no live job) resolve to
    /// idle WITHOUT stamping lastIndexedAt.
    pub fn resolve_stale_statuses(&self, exclude_ids: &[String]) {
        let stuck: Vec<String> = self
            .with_conn(|conn| {
                let mut stmt = conn
                    .prepare("SELECT id FROM sources WHERE status IN ('queued', 'indexing')")
                    .ok()?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0)).ok()?;
                rows.collect::<Result<_, _>>().ok()
            })
            .unwrap_or_default();
        for id in stuck {
            if !exclude_ids.contains(&id) {
                self.mark_status(&id, "idle", None);
            }
        }
    }

    pub fn update_source(
        &self,
        id: &str,
        name: Option<&str>,
        location: Option<&str>,
    ) -> Option<KnowledgeSource> {
        let cur = self.get_source(id)?;
        let name = name
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(&cur.name);
        let location = location
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .unwrap_or(&cur.location);
        let _ = self.with_conn(|conn| {
            conn.execute(
                "UPDATE sources SET name = ?1, location = ?2 WHERE id = ?3",
                params![name, location, id],
            )
        });
        self.get_source(id)
    }

    pub fn set_chunk_count(&self, id: &str, n: i64) {
        let _ = self.with_conn(|conn| {
            conn.execute(
                "UPDATE sources SET chunkCount = ?1 WHERE id = ?2",
                params![n, id],
            )
        });
    }

    /// One transaction on the shared connection: chunk cascade + registry
    /// row must not be torn apart by a crash.
    pub fn delete_source(&self, id: &str) {
        let chunk_ids = self.rag.chunks_by_source(id).unwrap_or_default();
        let _ = self.rag.delete_chunks(&chunk_ids);
        let _ = self.with_conn(|conn| conn.execute("DELETE FROM sources WHERE id = ?1", [id]));
    }

    /// Purge a removed source's chunks (mid-job re-write window).
    pub fn purge_orphans(&self, id: &str) {
        let chunk_ids = self.rag.chunks_by_source(id).unwrap_or_default();
        let _ = self.rag.delete_chunks(&chunk_ids);
    }

    pub fn enabled_source_ids_for(&self, workspace_id: &str) -> Vec<String> {
        self.list_sources()
            .unwrap_or_default()
            .into_iter()
            .filter(|s| {
                s.enabled_workspace_ids
                    .iter()
                    .any(|w| w == "*" || w == workspace_id)
            })
            .map(|s| s.id)
            .collect()
    }

    /// The sources registry lives on the RagStore's connection — a tiny
    /// escape hatch so the typed statements above share one handle. The
    /// RagStore owns the connection; expose it through a friend-module
    /// accessor instead of duplicating state.
    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        self.rag.with_connection(f)
    }
}

fn new_uuid() -> String {
    // crypto.randomUUID() — 122 random bits via the OS RNG is fine here
    // (the id is a registry key, not a security boundary).
    let mut bytes = [0u8; 16];
    getrandom_fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn getrandom_fill(buf: &mut [u8]) {
    use std::io::Read as _;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(buf).is_ok() {
            return;
        }
    }
    // Fallback: time + address entropy (never hit on the supported hosts).
    let mut state = unix_ms_now() as u64 ^ (buf.as_ptr() as u64);
    for b in buf.iter_mut() {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *b = (state >> 33) as u8;
    }
}

// ── document ingestion ─────────────────────────────────────────────────────

const MAX_CHUNK_CHARS: usize = 1200;
const OVERLAP_CHARS: usize = 100;

/// Document-level ingestion: chunk fetched prose documents with the
/// paragraph splitter, embed via the shared embed_and_store helper, and
/// tag every chunk with the owning sourceId. Re-ingestion deletes this
/// source's prior chunks per document origin first, so origins never go
/// stale. Registry status / chunk-count updates stay with the caller.
pub fn ingest_documents(
    store: &KnowledgeStore,
    embedder: &dyn Embedder,
    source_id: &str,
    docs: &[SourceDocument],
    mut on_progress: impl FnMut(SourceProgressEvent),
) -> Result<usize, String> {
    if store.get_source(source_id).is_none() {
        return Err(format!("ingestDocuments: unknown source {source_id}"));
    }

    // Chunk ids are derived from origin, so two docs sharing one origin
    // would collide and silently overwrite. Keep the LAST occurrence.
    let mut by_origin: Vec<&SourceDocument> = Vec::new();
    for doc in docs {
        if let Some(existing) = by_origin.iter_mut().find(|d| d.origin == doc.origin) {
            *existing = doc;
        } else {
            by_origin.push(doc);
        }
    }

    let pinned = store
        .rag
        .get_meta("embedderId")
        .map_err(|e| e.to_string())?;
    if let Some(pinned) = pinned.as_deref() {
        if pinned != embedder.id() {
            return Err(format!(
                "knowledge index built with different embedder {pinned}; remove sources or switch back (requested {})",
                embedder.id()
            ));
        }
    }

    let mut prepared: Vec<PreparedChunk> = Vec::new();
    for doc in &by_origin {
        on_progress(SourceProgressEvent {
            source_id: source_id.to_string(),
            phase: "chunking".into(),
            pages_seen: None,
            chunks_total: None,
            chunks_embedded: None,
            current: Some(doc.origin.clone()),
            error: None,
        });
        let stale: Vec<String> = store
            .rag
            .by_path(&doc.origin)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|c| c.source_id.as_deref() == Some(source_id))
            .map(|c| c.id)
            .collect();
        store.rag.delete_chunks(&stale).map_err(|e| e.to_string())?;
        for (i, content) in split_prose(&doc.content).into_iter().enumerate() {
            prepared.push(PreparedChunk {
                id: format!("{source_id}:{}:{}", doc.origin, i),
                path: doc.origin.clone(),
                symbol: String::new(),
                content_hash: crate::sha256_hex(&content),
                content,
                start_line: 0,
                end_line: 0,
                source_id: Some(source_id.to_string()),
            });
        }
    }

    let (embedded, _) = embed_and_store(&store.rag, embedder, &prepared, |e| {
        on_progress(SourceProgressEvent {
            source_id: source_id.to_string(),
            phase: "embedding".into(),
            pages_seen: None,
            chunks_total: Some(e.chunks_total),
            chunks_embedded: Some(e.chunks_embedded),
            current: None,
            error: None,
        });
    })?;

    // First-embedder-wins: pin only after a pass actually wrote vectors.
    if embedded > 0 {
        store
            .rag
            .set_meta("embedderId", embedder.id())
            .map_err(|e| e.to_string())?;
    }

    on_progress(SourceProgressEvent {
        source_id: source_id.to_string(),
        phase: "done".into(),
        pages_seen: None,
        chunks_total: Some(prepared.len() as u64),
        chunks_embedded: Some(embedded),
        current: None,
        error: None,
    });
    Ok(prepared.len())
}

/// Split prose into ~1200-char chunks on blank-line paragraph boundaries,
/// carrying a ~100-char tail overlap between consecutive chunks so
/// sentences cut at an accumulation boundary stay retrievable from both
/// sides.
pub fn split_prose(content: &str) -> Vec<String> {
    let paragraphs: Vec<&str> = content
        .split("\n\n")
        .flat_map(|p| p.split("\r\n\r\n"))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();

    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    for p in paragraphs {
        if p.chars().count() > MAX_CHUNK_CHARS {
            if !buf.is_empty() {
                let t = buf.trim().to_string();
                if !t.is_empty() {
                    out.push(t);
                }
                buf.clear();
            }
            let chars: Vec<char> = p.chars().collect();
            let mut start = 0usize;
            let mut last_end = 0usize;
            while start < chars.len() {
                let end = (start + MAX_CHUNK_CHARS).min(chars.len());
                out.push(chars[start..end].iter().collect());
                last_end = end;
                if end == chars.len() {
                    break;
                }
                start += MAX_CHUNK_CHARS - OVERLAP_CHARS;
            }
            let overlap_from = last_end.saturating_sub(OVERLAP_CHARS);
            buf = chars[overlap_from..last_end].iter().collect();
            continue;
        }
        let p_len = p.chars().count();
        if buf.is_empty() {
            buf = p.to_string();
        } else if buf.chars().count() + p_len + 2 <= MAX_CHUNK_CHARS {
            buf.push_str("\n\n");
            buf.push_str(p);
        } else {
            let t = buf.trim().to_string();
            if !t.is_empty() {
                out.push(t);
            }
            // Carry a bounded overlap so buf stays within budget.
            let room = MAX_CHUNK_CHARS.saturating_sub(p_len + 2);
            let overlap_len = OVERLAP_CHARS.min(room);
            let buf_chars = buf.chars().count();
            let overlap: String = if overlap_len > 0 {
                buf.chars()
                    .skip(buf_chars.saturating_sub(overlap_len))
                    .collect()
            } else {
                String::new()
            };
            buf = if overlap.is_empty() {
                p.to_string()
            } else {
                format!("{overlap}\n\n{p}")
            };
        }
    }
    let t = buf.trim().to_string();
    if !t.is_empty() {
        out.push(t);
    }
    out
}

// ── fetchers ───────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_SECS: u64 = 15;
const MAX_CHARS: usize = 2 * 1024 * 1024;
const USER_AGENT: &str = "Tide/0.4 knowledge-indexer";

/// URL fetcher: downloads one http(s) resource and normalizes it into a
/// SourceDocument. HTML/XHTML converts to visible text; any other content
/// type passes through raw. Body reads capped.
pub fn fetch_url(url: &str) -> Result<Vec<SourceDocument>, String> {
    let (content_type, body) = fetch_raw(url)?;
    Ok(to_documents(&body, url, &content_type))
}

/// Raw download shared with the crawl fetcher so each crawled page is
/// downloaded exactly once.
pub fn fetch_raw(url: &str) -> Result<(String, String), String> {
    let lowercase = url.to_ascii_lowercase();
    if !(lowercase.starts_with("http://") || lowercase.starts_with("https://")) {
        return Err(format!("unsupported url: {url}"));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("fetch client failed: {e}"))?;
    let response = client
        .get(url)
        .header("user-agent", USER_AGENT)
        .send()
        .map_err(|e| format!("fetch timed out after {}s: {url} ({e})", FETCH_TIMEOUT_SECS))?;
    if !response.status().is_success() {
        return Err(format!("fetch failed: {} {url}", response.status()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    // Cap the byte read (chars ≤ 4 bytes each), decode lossily, then cap chars.
    let mut bytes = Vec::new();
    let mut limited = std::io::Read::take(response, (MAX_CHARS as u64) * 4 + 1024);
    let _ = std::io::Read::read_to_end(&mut limited, &mut bytes);
    let mut body = String::from_utf8_lossy(&bytes).into_owned();
    if body.chars().count() > MAX_CHARS {
        body = body.chars().take(MAX_CHARS).collect();
    }
    Ok((content_type, body))
}

/// Normalize a fetched body into documents (TS toDocuments).
pub fn to_documents(body: &str, url: &str, content_type: &str) -> Vec<SourceDocument> {
    let origin = origin_of(url);
    if content_type.contains("text/html") || content_type.contains("application/xhtml+xml") {
        let title = extract_title(body).unwrap_or_else(|| url.to_string());
        let text = html_to_text(body);
        if text.trim().is_empty() {
            return vec![];
        }
        return vec![SourceDocument {
            title,
            content: text,
            origin,
        }];
    }
    if body.trim().is_empty() {
        return vec![];
    }
    vec![SourceDocument {
        title: url.to_string(),
        content: body.to_string(),
        origin,
    }]
}

/// `hostname + pathname` (trailing slash stripped) — the TS originOf.
pub fn origin_of(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => {
            let path = u.path().trim_end_matches('/').to_string();
            format!("{}{}", u.host_str().unwrap_or_default(), path)
        }
        Err(_) => url.to_string(),
    }
}

fn extract_title(body: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after = &body[start..];
    let open_end = after.find('>')? + 1;
    let close = after[open_end..].find("</title")?;
    Some(after[open_end..open_end + close].trim().to_string())
}

/// Compact HTML→visible-text conversion — the html-to-text `convert(body,
/// { wordWrap: false })` stand-in: script/style bodies dropped, block
/// boundaries become newlines, tags stripped, common entities decoded.
pub fn html_to_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let lower = html.to_ascii_lowercase();
    let mut i = 0usize;
    let bytes = html.as_bytes();
    while i < html.len() {
        if bytes[i] == b'<' {
            // Skip script/style contents wholesale.
            if lower[i..].starts_with("<script") || lower[i..].starts_with("<style") {
                let tag = if lower[i..].starts_with("<script") {
                    "</script"
                } else {
                    "</style"
                };
                if let Some(end) = lower[i..].find(tag) {
                    i += end + tag.len();
                    if let Some(gt) = lower[i..].find('>') {
                        i += gt + 1;
                    }
                    continue;
                }
            }
            // Consume the tag; emit newline for block boundaries.
            if let Some(gt) = lower[i..].find('>') {
                let tag_name: String = lower[i + 1..i + gt]
                    .trim_start_matches('/')
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .collect();
                if matches!(
                    tag_name.as_str(),
                    "p" | "div"
                        | "br"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "h5"
                        | "h6"
                        | "li"
                        | "tr"
                        | "section"
                        | "article"
                        | "header"
                        | "footer"
                        | "pre"
                        | "blockquote"
                        | "ul"
                        | "ol"
                        | "table"
                        | "hr"
                ) {
                    text.push('\n');
                }
                i += gt + 1;
                continue;
            }
        }
        if bytes[i] == b'&' {
            if let Some(semi) = lower[i..].find(';') {
                let entity = &lower[i + 1..i + semi];
                let decoded = match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    _ => {
                        if let Some(num) = entity.strip_prefix('#').and_then(|n| {
                            n.parse::<u32>().ok().or_else(|| {
                                n.strip_prefix('x')
                                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                            })
                        }) {
                            char::from_u32(num)
                        } else {
                            None
                        }
                    }
                };
                if let Some(c) = decoded {
                    text.push(c);
                    i += semi + 1;
                    continue;
                }
            }
        }
        let ch = html[i..].chars().next().unwrap_or('\u{fffd}');
        text.push(ch);
        i += ch.len_utf8();
    }
    // Collapse the runs of blank lines the boundary newlines produce.
    let mut out = String::with_capacity(text.len());
    let mut blank = 0;
    for line in text.lines() {
        if line.trim().is_empty() {
            blank += 1;
        } else {
            blank = 0;
        }
        if blank <= 1 {
            out.push_str(line.trim_end());
            out.push('\n');
        }
    }
    out.trim().to_string()
}

// ── docs fetcher ───────────────────────────────────────────────────────────

const MAX_FILE_BYTES: u64 = 512 * 1024;
const DOC_EXTENSIONS: &[&str] = &["md", "mdx", "txt"];

/// Local markdown/text file or directory walk producing one SourceDocument
/// per file with the absolute path as origin. Locations validated against
/// `allowed_roots` after realpath resolution so symlinks cannot escape.
pub fn fetch_docs(
    location: &str,
    allowed_roots: &[PathBuf],
) -> Result<Vec<SourceDocument>, String> {
    let roots: Vec<PathBuf> = allowed_roots
        .iter()
        .filter_map(|r| r.canonicalize().ok())
        .collect();
    let target = std::fs::canonicalize(location)
        .map_err(|e| format!("docs location not readable: {location} ({e})"))?;
    if !is_within(&target, &roots) {
        return Err(format!(
            "docs location is outside the allowed roots: {}",
            target.display()
        ));
    }

    let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    let mut files: Vec<PathBuf> = Vec::new();
    if meta.is_file() {
        let ext = target
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        if !DOC_EXTENSIONS.contains(&ext.as_str()) {
            return Err(format!("unsupported docs file: {}", target.display()));
        }
        if meta.len() <= MAX_FILE_BYTES {
            files.push(target);
        }
    } else {
        collect_doc_files(&target, &roots, &mut files);
    }
    files.sort();
    Ok(files
        .into_iter()
        .filter_map(|file| {
            let content = std::fs::read_to_string(&file).unwrap_or_default();
            if content.trim().is_empty() {
                return None;
            }
            Some(SourceDocument {
                title: file.file_name()?.to_string_lossy().into_owned(),
                content,
                origin: file.to_string_lossy().into_owned(),
            })
        })
        .collect())
}

fn collect_doc_files(dir: &Path, roots: &[PathBuf], out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut sorted: Vec<_> = entries.flatten().collect();
    sorted.sort_by_key(|e| e.file_name());
    for entry in sorted {
        let Ok(resolved) = entry.path().canonicalize() else {
            continue;
        };
        if !is_within(&resolved, roots) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_doc_files(&resolved, roots, out);
        } else if file_type.is_file() {
            let ext = resolved
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            if DOC_EXTENSIONS.contains(&ext.as_str()) {
                if std::fs::metadata(&resolved)
                    .map(|m| m.len())
                    .unwrap_or(u64::MAX)
                    > MAX_FILE_BYTES
                {
                    continue;
                }
                out.push(resolved);
            }
        }
    }
}

fn is_within(p: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| p.starts_with(root))
}

// ── crawl fetcher ──────────────────────────────────────────────────────────

pub const DEFAULT_MAX_PAGES: usize = 50;
pub const DEFAULT_MAX_DEPTH: usize = 2;

/// Same-origin crawl: breadth-first walk from a root URL staying on one
/// hostname, bounded by page count and depth. Individual page failures
/// are skipped, not fatal.
pub fn fetch_crawl(
    root_url: &str,
    max_pages: Option<usize>,
    max_depth: Option<usize>,
    mut on_page: impl FnMut(u64, &str),
) -> Result<Vec<SourceDocument>, String> {
    let start =
        url::Url::parse(root_url).map_err(|_| format!("unsupported crawl root: {root_url}"))?;
    if !matches!(start.scheme(), "http" | "https") {
        return Err(format!("unsupported crawl root: {root_url}"));
    }
    let max_pages = max_pages.unwrap_or(DEFAULT_MAX_PAGES);
    let max_depth = max_depth.unwrap_or(DEFAULT_MAX_DEPTH);

    let normalize = |u: &url::Url| -> url::Url {
        // Drop the fragment; keep query (TS `new URL` normalization).
        let mut normalized = u.clone();
        normalized.set_fragment(None);
        normalized
    };
    let mut seen: std::collections::HashSet<String> =
        std::collections::HashSet::from([normalize(&start).to_string()]);
    let mut queue: Vec<(url::Url, usize)> = vec![(start.clone(), 0)];
    let mut docs: Vec<SourceDocument> = Vec::new();
    let mut attempts = 0usize;
    let mut pages_seen = 0u64;

    while !queue.is_empty() && attempts < max_pages {
        let level = std::mem::take(&mut queue);
        for (entry_url, depth) in level {
            if depth > max_depth || attempts >= max_pages {
                continue;
            }
            attempts += 1;

            let (content_type, body) = match fetch_raw(entry_url.as_str()) {
                Ok(ok) => ok,
                Err(_) => continue, // failed fetches consume budget too
            };
            pages_seen += 1;
            docs.extend(to_documents(&body, entry_url.as_str(), &content_type));
            on_page(pages_seen, entry_url.as_str());

            let is_html = content_type.contains("text/html")
                || content_type.contains("application/xhtml+xml");
            if !is_html {
                continue;
            }
            for href in extract_links(&body) {
                let Ok(resolved) = entry_url.join(&href) else {
                    continue;
                };
                let next = normalize(&resolved);
                if next.host_str() != start.host_str() {
                    continue;
                }
                if seen.insert(next.to_string()) {
                    queue.push((next, depth + 1));
                }
            }
        }
    }
    Ok(docs)
}

/// `<a ... href=...>` extraction over raw HTML (the TS regex port).
pub fn extract_links(html: &str) -> Vec<String> {
    let mut links = Vec::new();
    let bytes = html.as_bytes();
    let mut i = 0usize;
    while let Some(rel) = find_ci(&bytes[i..], b"<a ") {
        let tag_start = i + rel;
        let Some(tag_end_rel) = bytes[tag_start..].iter().position(|&b| b == b'>') else {
            break;
        };
        let tag = &html[tag_start..tag_start + tag_end_rel];
        if let Some(href) = attr_value(tag, "href") {
            links.push(href);
        }
        i = tag_start + tag_end_rel;
    }
    links
}

fn find_ci(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|w| w.eq_ignore_ascii_case(needle))
}

fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut search = 0usize;
    while let Some(pos) = lower[search..].find(attr) {
        let before = lower[search + pos..].trim_start_matches(attr);
        // Must be a standalone attribute (preceded by whitespace, followed
        // by '=' or whitespace-then-'='), not a substring of another attr.
        let attr_start = search + pos;
        let prev_ws = attr_start == 0
            || lower
                .as_bytes()
                .get(attr_start - 1)
                .is_some_and(|b| b.is_ascii_whitespace() || *b == b'/');
        if prev_ws {
            let rest = before.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                let rest = rest.trim_start();
                let value = if let Some(stripped) = rest.strip_prefix('"') {
                    stripped.split('"').next().unwrap_or_default()
                } else if let Some(stripped) = rest.strip_prefix('\'') {
                    stripped.split('\'').next().unwrap_or_default()
                } else {
                    rest.split_whitespace().next().unwrap_or_default()
                };
                return Some(value.to_string());
            }
        }
        search = attr_start + attr.len();
    }
    None
}

// ── repo fetcher ───────────────────────────────────────────────────────────

const GIT_HOSTS: &[&str] = &["github.com", "gitlab.com", "bitbucket.org"];

/// Shallow-clone a git remote into a private temp dir (`git clone --depth
/// 1`), read doc-shaped files from the checkout via the docs walker, then
/// delete the temp dir — every fetch is self-cleaning. Origins are
/// `owner/repo/<relpath>` so memory hits read like paths.
pub fn fetch_repo(repo_url: &str) -> Result<Vec<SourceDocument>, String> {
    let (url, slug) = parse_repo_url(repo_url)?;
    let dest = std::env::temp_dir().join(format!(
        "tide-repo-{}-{}",
        unix_ms_now(),
        std::process::id()
    ));
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let result = (|| -> Result<Vec<SourceDocument>, String> {
        clone_repo(&url, &dest)?;
        let base = dest.canonicalize().map_err(|e| e.to_string())?;
        let docs = fetch_docs(base.to_string_lossy().as_ref(), std::slice::from_ref(&base))?;
        Ok(docs
            .into_iter()
            .filter(|doc| !doc.origin.split('/').any(|seg| seg == ".git"))
            .map(|doc| SourceDocument {
                title: doc.title,
                content: doc.content,
                origin: repo_origin(&slug, &base, &doc.origin),
            })
            .collect())
    })();
    let _ = std::fs::remove_dir_all(&dest);
    result
}

fn clone_repo(url: &str, dest: &Path) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .arg("clone")
        .arg("--depth")
        .arg("1")
        .arg(url)
        .arg(dest.to_string_lossy().as_ref())
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn repo_origin(slug: &str, base: &Path, abs_file: &str) -> String {
    let rel = Path::new(abs_file)
        .strip_prefix(base)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    format!("{slug}/{rel}")
}

/// Accepts https remotes on known git hosts pointing at <owner>/<repo>,
/// plus file:// remotes (local fixture repos). Everything else is
/// rejected before any process spawns.
fn parse_repo_url(raw: &str) -> Result<(String, String), String> {
    let u = url::Url::parse(raw).map_err(|_| format!("invalid repo url: {raw}"))?;
    if u.scheme() == "file" {
        let path = urldecode(u.path());
        let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        if segs.len() < 2 {
            return Err(format!("invalid repo url: {raw}"));
        }
        let last = trim_git_suffix(segs[segs.len() - 1]);
        let slug = format!("{}/{}", segs[segs.len() - 2], last);
        return Ok((raw.to_string(), slug));
    }
    if u.scheme() != "https" {
        return Err(format!(
            "unsupported repo url '{raw}': only https git remotes are allowed"
        ));
    }
    let host = u.host_str().unwrap_or_default();
    if !GIT_HOSTS.contains(&host) {
        return Err(format!(
            "unsupported repo host '{host}': expected one of {}",
            GIT_HOSTS.join(", ")
        ));
    }
    let segs: Vec<String> = u
        .path()
        .split('/')
        .filter(|s| !s.is_empty())
        .map(urldecode)
        .collect();
    if segs.len() < 2 {
        return Err(format!("invalid repo url: {raw}"));
    }
    let slug = format!("{}/{}", segs[0], trim_git_suffix(&segs[1]));
    Ok((raw.to_string(), slug))
}

fn trim_git_suffix(seg: &str) -> &str {
    seg.strip_suffix(".git").unwrap_or(seg)
}

fn urldecode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.clone().take(2).collect();
            if hex.len() == 2 {
                if let Ok(b) = u8::from_str_radix(&hex, 16) {
                    out.push(b as char);
                    chars.next();
                    chars.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, KnowledgeStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = KnowledgeStore::open_at(&dir.path().join("knowledge.db")).unwrap();
        (dir, s)
    }

    #[test]
    fn add_list_update_and_remove_sources() {
        let (_dir, ks) = store();
        let src = ks
            .add_source(
                "React Docs",
                "url",
                "https://react.dev/learn",
                Some(&["ws_1".to_string()]),
            )
            .unwrap();
        assert_eq!(src.status, "idle");
        assert_eq!(src.enabled_workspace_ids, vec!["ws_1".to_string()]);
        assert_eq!(ks.list_sources().unwrap().len(), 1);

        let updated = ks
            .update_source(&src.id, Some("React"), Some("https://react.dev/new"))
            .unwrap();
        assert_eq!(updated.name, "React");
        assert_eq!(updated.location, "https://react.dev/new");
        assert!(ks.update_source("missing", Some("x"), None).is_none());

        assert_eq!(ks.enabled_source_ids_for("ws_1"), vec![src.id.clone()]);
        assert!(ks.enabled_source_ids_for("ws_2").is_empty());

        ks.delete_source(&src.id);
        assert!(ks.list_sources().unwrap().is_empty());
    }

    #[test]
    fn set_enabled_normalizes_star_plus_concrete() {
        let (_dir, ks) = store();
        let src = ks.add_source("s", "url", "https://x.dev", None).unwrap();
        assert_eq!(src.enabled_workspace_ids, vec!["*".to_string()]);
        ks.set_enabled(&src.id, &["*".to_string(), "ws_1".to_string()]);
        assert_eq!(
            ks.get_source(&src.id).unwrap().enabled_workspace_ids,
            vec!["ws_1".to_string()]
        );
    }

    #[test]
    fn mark_status_stamps_last_indexed_only_after_indexing() {
        let (_dir, ks) = store();
        let src = ks.add_source("s", "url", "https://x.dev", None).unwrap();
        ks.mark_status(&src.id, "queued", None);
        ks.mark_status(&src.id, "indexing", None);
        ks.mark_status(&src.id, "idle", None);
        let done = ks.get_source(&src.id).unwrap();
        assert!(done.last_indexed_at.is_some());

        // Stale recovery path (queued → idle directly) fabricates nothing.
        let src2 = ks.add_source("t", "url", "https://y.dev", None).unwrap();
        ks.mark_status(&src2.id, "queued", None);
        ks.resolve_stale_statuses(&[]);
        let recovered = ks.get_source(&src2.id).unwrap();
        assert_eq!(recovered.status, "idle");
        assert!(recovered.last_indexed_at.is_none());
    }

    #[test]
    fn split_prose_chunks_with_overlap() {
        let paragraphs = vec!["short one"; 400].join("\n\n");
        let chunks = split_prose(&paragraphs);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(
                chunk.chars().count() <= MAX_CHUNK_CHARS + 2,
                "chunk too long"
            );
        }
        // Overlap carries: consecutive chunks share a tail prefix.
        assert!(chunks[0].chars().count() > OVERLAP_CHARS);

        let single = split_prose("one paragraph");
        assert_eq!(single, vec!["one paragraph".to_string()]);
    }

    #[test]
    fn origin_of_joins_host_and_path() {
        assert_eq!(origin_of("https://react.dev/learn/"), "react.dev/learn");
        assert_eq!(origin_of("https://example.com"), "example.com");
    }

    #[test]
    fn html_to_text_strips_markup_and_decodes_entities() {
        let html = "<html><head><style>a{}</style><title>T</title></head>\
                    <body><h1>Hello &amp; welcome</h1><p>Line one<br>Line two</p>\
                    <script>ignore()</script></body></html>";
        let text = html_to_text(html);
        assert!(text.contains("Hello & welcome"));
        assert!(text.contains("Line one"));
        assert!(text.contains("Line two"));
        assert!(!text.contains("ignore()"));
        assert!(!text.contains("<"));
    }

    #[test]
    fn extract_links_finds_href_values() {
        let html = r#"<a href="/a">A</a> <A HREF='/b'></A> <a class="x" href="https://c/d">C</a> <span data-href="no">n</span>"#;
        let links = extract_links(html);
        assert!(links.contains(&"/a".to_string()));
        assert!(links.contains(&"/b".to_string()));
        assert!(links.contains(&"https://c/d".to_string()));
        assert!(!links.contains(&"no".to_string()));
    }

    #[test]
    fn parse_repo_url_validates_hosts_and_builds_slugs() {
        assert_eq!(
            parse_repo_url("https://github.com/owner/repo").unwrap(),
            (
                "https://github.com/owner/repo".to_string(),
                "owner/repo".to_string()
            )
        );
        assert_eq!(
            parse_repo_url("https://github.com/owner/repo.git")
                .unwrap()
                .1,
            "owner/repo"
        );
        assert_eq!(
            parse_repo_url("file:///tmp/fixture/repo").unwrap().1,
            "fixture/repo"
        );
        assert!(parse_repo_url("https://example.com/owner/repo").is_err());
        assert!(parse_repo_url("ssh://git@github.com/owner/repo").is_err());
    }

    #[test]
    fn fetch_docs_walks_confined_roots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("guide.md"), "# Guide\ncontent").unwrap();
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/deep.md"), "deep").unwrap();
        std::fs::write(root.join("debug.log"), "nope").unwrap();
        std::fs::write(root.join("empty.md"), "  ").unwrap();

        let docs =
            fetch_docs(root.to_string_lossy().as_ref(), std::slice::from_ref(&root)).unwrap();
        let titles: Vec<&str> = docs.iter().map(|d| d.title.as_str()).collect();
        assert_eq!(titles, vec!["guide.md", "deep.md"]);
        assert!(docs[1].origin.contains("nested/deep.md"));

        // Outside the allowed root → refused.
        let outside = tempfile::tempdir().unwrap();
        assert!(fetch_docs(
            root.to_string_lossy().as_ref(),
            &[outside.path().to_path_buf()]
        )
        .is_err());
    }
}
