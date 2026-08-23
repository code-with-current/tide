/** Document-level ingestion entrypoint: chunk fetched prose documents with a
 *  plain paragraph splitter (tree-sitter chunkFile needs real files + code
 *  grammars), embed via the shared embedAndStore helper, and tag every chunk
 *  with the owning sourceId. Re-ingestion deletes this source's prior chunks
 *  per document origin first, so origins never go stale. Registry status /
 *  chunk-count updates stay with the caller (the manager). */
import { createHash } from 'node:crypto';
import type { Embedder } from '../rag/embedder.js';
import { embedAndStore, type PreparedChunk } from '../rag/ingest.js';
import type { RagStore } from '../rag/store.js';
import type { KnowledgeStore } from './store.js';
import type { SourceDocument, SourceProgressEvent } from './types.js';

const MAX_CHUNK_CHARS = 1200;
const OVERLAP_CHARS = 100;

export async function ingestDocuments(
  store: KnowledgeStore,
  rag: RagStore,
  embedder: Embedder,
  sourceId: string,
  docs: SourceDocument[],
  opts: { onProgress?: (e: SourceProgressEvent) => Promise<void> | void } = {},
): Promise<{ chunks: number }> {
  if (!store.getSource(sourceId)) {
    throw new Error(`ingestDocuments: unknown source ${sourceId}`);
  }
  const onProgress = opts.onProgress;

  const prepared: PreparedChunk[] = [];
  for (const doc of docs) {
    onProgress?.({ sourceId, phase: 'chunking', current: doc.origin });
    rag.deleteChunks(
      rag.byPath(doc.origin).filter((c) => c.sourceId === sourceId).map((c) => c.id),
    );
    splitProse(doc.content).forEach((content, i) => {
      prepared.push({
        id: `${sourceId}:${doc.origin}:${i}`,
        path: doc.origin,
        symbol: '',
        content,
        contentHash: createHash('sha256').update(content).digest('hex'),
        startLine: 0,
        endLine: 0,
        sourceId,
      });
    });
  }

  // Record before embedding so a crash mid-pass still leaves the id query-time resolution needs to refuse cross-embedder searches.
  rag.setMeta('embedderId', embedder.id);

  await embedAndStore(rag, embedder, prepared, {
    onProgress: (e) =>
      onProgress?.({
        sourceId,
        phase: 'embedding',
        chunksTotal: e.chunksTotal,
        chunksEmbedded: e.chunksEmbedded,
      }),
  });

  onProgress?.({ sourceId, phase: 'done', chunksTotal: prepared.length, chunksEmbedded: prepared.length });
  return { chunks: prepared.length };
}

/** Split prose into ~1200-char chunks on blank-line paragraph boundaries,
 *  carrying a ~100-char tail overlap between consecutive chunks so sentences
 *  cut at an accumulation boundary stay retrievable from both sides. */
function splitProse(content: string): string[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };

  for (const p of paragraphs) {
    if (p.length > MAX_CHUNK_CHARS) {
      flush();
      let start = 0;
      while (start < p.length) {
        out.push(p.slice(start, start + MAX_CHUNK_CHARS));
        start += MAX_CHUNK_CHARS - OVERLAP_CHARS;
      }
      continue;
    }
    if (!buf) {
      buf = p;
    } else if (buf.length + p.length + 2 <= MAX_CHUNK_CHARS) {
      buf += `\n\n${p}`;
    } else {
      const overlap = buf.length > OVERLAP_CHARS ? buf.slice(-OVERLAP_CHARS) : '';
      flush();
      buf = overlap ? `${overlap}\n\n${p}` : p;
    }
  }
  flush();
  return out;
}
