/** Workspace ingestion pipeline: walk → chunk (tree-sitter) → embed in batches → write to RagStore. Content-hash dedup skips unchanged chunks; runs in the background via the IPC layer. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import { createLogger } from '../logger.js';
import { chunkFile, type Chunk } from './chunker/index.js';

const log = createLogger('rag');
import { openRagStore, type ChunkRow, type RagStore } from './store.js';
import type { Embedder } from './embedder.js';
import { resolveForBuild } from './resolve.js';
import { localModelExists } from './local-onnx-embedder.js';
import { isRagCloudConfigured } from '../agent/system-model.js';
import * as store from '../store.js';
import { hydrateRagConfig } from '../configStore.js';

/** Phases progress callbacks see, in order, on a successful run. */
export type IngestPhase = 'walking' | 'chunking' | 'embedding' | 'done';

export interface IngestProgressEvent {
  phase: IngestPhase;
  /** Files discovered during the walk (stops counting once walking ends). */
  filesSeen: number;
  /** Total chunks emitted by the chunker across all files. */
  chunksTotal: number;
  /** Chunks embedded + written so far. */
  chunksEmbedded: number;
  /** Current file being processed (chunking or embedding), if any. */
  currentFile?: string;
  /** Error message when phase === 'failed'. */
  error?: string;
}

export type IngestProgressCb = (e: IngestProgressEvent) => void;

/** A chunk ready to be embedded + stored: the ChunkRow shape minus the
 *  embedder/timestamp fields that embedAndStore stamps at write time.
 *  sourceId stays undefined for workspace code chunks; knowledge ingestion
 *  sets it so hits can be filtered back to their source. */
export interface PreparedChunk {
  id: string;
  path: string;
  symbol: string;
  content: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  sourceId?: string | null;
}

export interface IngestResult {
  filesSeen: number;
  chunksTotal: number;
  chunksEmbedded: number;
  /** Chunks skipped because contentHash matched (unchanged on re-ingest). */
  chunksSkipped: number;
}

/** Skip directories whose name is in this set. Mirrors the grep tool's
 *  walk filter (electron/agent/tools/grep.ts:163) so ingestion respects
 *  the same out-of-scope dirs the user expects search to skip. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'release',
  'next',
  '.cache',
  '.next',
  'target', // Rust
  'venv', // Python
  '__pycache__',
  '.venv',
]);

/** Extensions the chunker knows how to parse. Anything else is skipped
 *  cheaply without even reading the file. Mirrors EXTENSION_MAP in the
 *  chunker — keep in sync when adding languages. */
const CHUNKABLE_EXTS = new Set([
  // JS/TS
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  // Python
  '.py', '.pyi',
  // Go
  '.go',
  // Rust
  '.rs',
  // Java / Kotlin / Scala
  '.java', '.kt', '.kts', '.scala', '.sbt',
  // C / C++
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
  // C#
  '.cs',
  // Ruby
  '.rb',
  // PHP
  '.php',
  // Swift
  '.swift',
  // Lua
  '.lua',
  // Bash
  '.sh', '.bash',
  // Vue
  '.vue',
  // Dart
  '.dart',
  // Web markup / styling
  '.html', '.htm', '.css', '.scss', '.less',
  // Elixir
  '.ex', '.exs',
  // Elm
  '.elm',
  // ReScript
  '.res', '.resi',
  // Solidity
  '.sol',
  // Zig
  '.zig',
  // OCaml
  '.ml', '.mli',
  // Objective-C
  '.m', '.mm',
]);

const EMBED_BATCH_SIZE = 32;

/** Run the full pipeline for a workspace. Idempotent: re-running on an
 *  already-ingested workspace only re-embeds chunks whose contentHash
 *  changed (and removes chunks whose files disappeared — TODO in a
 *  follow-up; today we only add). */
export async function ingestWorkspace(
  workspaceId: string,
  opts: { onProgress?: IngestProgressCb } = {},
): Promise<IngestResult> {
  const { onProgress } = opts;
  const emit = (e: IngestProgressEvent) => onProgress?.(e);

  const ws = store.listWorkspaces().find((w) => w.id === workspaceId);
  if (!ws) {
    throw new Error(`ingest: workspace ${workspaceId} not found`);
  }
  const t0 = Date.now();

  const ragConfig = hydrateRagConfig(ws.ragConfig);
  const { embedder, embedderId } = resolveForBuild({
    config: ragConfig,
    localAvailable: localModelExists(),
    cloudConfigured: isRagCloudConfigured(),
  });
  log.info('ingest starting', { workspace: ws.name, embedder: embedderId });

  const ragStore = openRagStore(workspaceId);
  // Mark init start so the panel can show "running" if the app dies
  // mid-ingest and restarts. Record the embedder id so future query-time
  // resolution can detect "this index was built with a different embedder"
  // before issuing garbage cross-embedder searches.
  ragStore.setMeta('initializedAt', String(Date.now()));
  ragStore.setMeta('embedderId', embedderId);

  try {
    // ── Phase 1: walk ────────────────────────────────────────────────
    const files: string[] = [];
    emit({ phase: 'walking', filesSeen: 0, chunksTotal: 0, chunksEmbedded: 0 });
    // Exclude the worktree subtree from indexing. Each worktree is a full
    // per-branch checkout of the repo; indexing them multiplies the index
    // with duplicates and wastes embedding budget. Resolved from the
    // workspace's configured worktreeLocation (default .agent/worktrees/).
    const worktreeRoot = ws.worktreeLocation
      ? path.resolve(ws.path, ws.worktreeLocation)
      : path.resolve(ws.path, '.agent', 'worktrees');
    walkSource(ws.path, files, [worktreeRoot], (n) =>
      emit({ phase: 'walking', filesSeen: n, chunksTotal: 0, chunksEmbedded: 0 }),
    );

    // If the workspace root is gone, the walk yields 0 files silently — fail loudly here instead of writing a misleading "success" lastIngestedAt (caller rag.ts turns the throw into a 'failed' progress event so the RagIndexProgress card shows the real reason).
    // NOTE: check root existence directly rather than files.length===0, since a genuinely-empty workspace (new project, no source yet) also yields 0.
    if (!fs.existsSync(ws.path)) {
      throw new Error(
        `Workspace folder no longer exists: ${ws.path}. Restore the folder or re-add the workspace before indexing.`,
      );
    }

    // ── Phase 2: chunk ───────────────────────────────────────────────
    const allChunks: Chunk[] = [];
    for (const file of files) {
      emit({
        phase: 'chunking',
        filesSeen: files.length,
        chunksTotal: allChunks.length,
        chunksEmbedded: 0,
        currentFile: file,
      });
      const chunks = await chunkFile(file);
      allChunks.push(...chunks);
    }

    // ── Phase 3: embed + store (content-hash dedupe) ─────────────────
    const { embedded, skipped } = await embedAndStore(ragStore, embedder, allChunks, {
      onProgress: (e) => emit({ ...e, filesSeen: files.length }),
    });
    ragStore.setMeta('lastIngestedAt', String(Date.now()));
    emit({
      phase: 'done',
      filesSeen: files.length,
      chunksTotal: allChunks.length,
      chunksEmbedded: embedded,
    });

    log.info('ingest complete', {
      workspace: ws.name,
      files: files.length,
      chunks: allChunks.length,
      embedded,
      skipped,
      durationMs: Date.now() - t0,
    });

    return {
      filesSeen: files.length,
      chunksTotal: allChunks.length,
      chunksEmbedded: embedded,
      chunksSkipped: skipped,
    };
  } finally {
    ragStore.close();
  }
}

/** Batched embed + write loop shared by workspace ingestion and knowledge
 *  document ingestion. Skips chunks whose id+path+contentHash match an
 *  existing row; stamps each written row with the active embedder id.
 *  Emits 'embedding'-phase progress per batch (filesSeen is left 0 — callers
 *  override it when they have walk context). */
export async function embedAndStore(
  rag: RagStore,
  embedder: Embedder,
  rows: PreparedChunk[],
  opts: { onProgress?: IngestProgressCb } = {},
): Promise<{ embedded: number; skipped: number }> {
  let embedded = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    const batch = rows.slice(i, i + EMBED_BATCH_SIZE);

    // Partition batch into needs-embed vs already-stored. A chunk is
    // skipped when both its id and contentHash match an existing row.
    const toEmbed: ChunkRow[] = [];
    for (const r of batch) {
      const row: ChunkRow = { ...r, sourceId: r.sourceId ?? null, embedderId: embedder.id, createdAt: Date.now() };
      const existing = rag.byContentHash(row.contentHash);
      if (existing && existing.id === row.id && existing.path === row.path) {
        skipped++;
      } else {
        toEmbed.push(row);
      }
    }

    if (toEmbed.length > 0) {
      const vectors = await embedder.embed(toEmbed.map((row) => row.content));
      if (vectors.length !== toEmbed.length) {
        throw new Error(
          `embedder returned ${vectors.length} vectors for ${toEmbed.length} chunks`,
        );
      }
      // Single transaction: chunk rows + FTS rows, then vectors.
      // Returns rowids to pair with vectors.
      const rowids = rag.upsertChunks(toEmbed);
      rag.upsertVectors(
        toEmbed.map((row, idx) => ({
          rowid: rowids[idx].rowid,
          chunkId: row.id,
          embedding: vectors[idx],
        })),
      );
      embedded += toEmbed.length;
    }

    opts.onProgress?.({
      phase: 'embedding',
      filesSeen: 0,
      chunksTotal: rows.length,
      chunksEmbedded: embedded,
      currentFile: batch[batch.length - 1]?.path,
    });
  }
  return { embedded, skipped };
}

/** Parse a .gitignore file into glob patterns (handles negation, comments, blank lines). */
function parseGitignore(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/** Check if a relative path is ignored by accumulated .gitignore patterns via minimatch (standard gitignore semantics, with negation). */
function isGitignored(relPath: string, patterns: string[]): boolean {
  let ignored = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      // Negation — un-ignore if the pattern matches.
      if (minimatch(relPath, pattern.slice(1), { dot: true, matchBase: true })) {
        ignored = false;
      }
    } else {
      if (minimatch(relPath, pattern, { dot: true, matchBase: true })) {
        ignored = true;
      }
    }
  }
  return ignored;
}

/** Recursive directory walk. Filters by SKIP_DIRS + hidden-dir rule +
 *  extension whitelist + .gitignore rules. Reads .gitignore files at each
 *  directory level (nested .gitignore files are respected, matching git's
 *  behavior). Calls onProgress every ~50 files. */
function walkSource(
  root: string,
  out: string[],
  excludeDirs: string[],
  onProgress: (n: number) => void,
): void {
  // Normalize excludes once for O(1) prefix checks (resolve to absolute,
  // trailing-separator-stripped). A dir is excluded if it IS one of these or
  // lives beneath one — used to drop the worktree subtree wholesale.
  const excluded = excludeDirs.map((d) => path.resolve(d));
  const isExcluded = (p: string) => {
    const rp = path.resolve(p);
    return excluded.some((x) => rp === x || rp.startsWith(x + path.sep));
  };
  let count = 0;
  const walk = (dir: string, parentPatterns: string[]) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      log.warn('directory read skipped during walk', { dir, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    // Read this directory's .gitignore (if present) and merge with parent patterns.
    // Nested .gitignore files are additive — a child can override a parent.
    let patterns = parentPatterns;
    const gitignorePath = path.join(dir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const local = parseGitignore(gitignorePath);
      if (local.length > 0) {
        patterns = [...parentPatterns, ...local];
      }
    }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relPath = path.relative(root, full);
      if (e.isDirectory()) {
        // Skip listed dirs and hidden dirs (except .agent, which is
        // first-class — matches the grep tool's rule). Also skip the
        // configured worktree subtree so per-branch checkouts aren't indexed.
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.agent') continue;
        if (isExcluded(full)) continue;
        // Check .gitignore for directories too (e.g. "coverage/", "*.egg-info").
        if (isGitignored(relPath, patterns)) continue;
        walk(full, patterns);
      } else if (e.isFile()) {
        // Check .gitignore before the extension filter — saves the ext lookup
        // for ignored files (e.g. .env, build artifacts in non-skipped dirs).
        if (isGitignored(relPath, patterns)) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!CHUNKABLE_EXTS.has(ext)) continue;
        out.push(full);
        count++;
        if (count % 50 === 0) onProgress(count);
      }
    }
  };
  walk(root, []);
  onProgress(count);
}

