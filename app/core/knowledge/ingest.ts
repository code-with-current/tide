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

  // Chunk ids are derived from origin, so two docs sharing one origin would
  // collide and silently overwrite. Keep the LAST occurrence — a re-fetch
  // list carries the freshest version of each page.
  const byOrigin = new Map(docs.map((d) => [d.origin, d]));

  const pinned = rag.getMeta('embedderId');
  if (pinned && pinned !== embedder.id) {
    throw new Error(
      `knowledge index built with different embedder ${pinned}; remove sources or switch back (requested ${embedder.id})`,
    );
  }

  const prepared: PreparedChunk[] = [];
  for (const doc of byOrigin.values()) {
    await onProgress?.({ sourceId, phase: 'chunking', current: doc.origin });
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

  const { embedded } = await embedAndStore(rag, embedder, prepared, {
    onProgress: async (e) => {
      await onProgress?.({
        sourceId,
        phase: 'embedding',
        chunksTotal: e.chunksTotal,
        chunksEmbedded: e.chunksEmbedded,
      });
    },
  });

  // First-embedder-wins: pin only after a pass actually wrote vectors, so a
  // failed/empty first pass doesn't lock the shared index to this model.
  if (embedded > 0) {
    rag.setMeta('embedderId', embedder.id);
  }

  await onProgress?.({ sourceId, phase: 'done', chunksTotal: prepared.length, chunksEmbedded: embedded });
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
      let lastEnd = 0;
      while (start < p.length) {
        const end = Math.min(start + MAX_CHUNK_CHARS, p.length);
        out.push(p.slice(start, end));
        lastEnd = end;
        if (end === p.length) break;
        start += MAX_CHUNK_CHARS - OVERLAP_CHARS;
      }
      buf = p.slice(Math.max(0, lastEnd - OVERLAP_CHARS), lastEnd);
      continue;
    }
    if (!buf) {
      buf = p;
    } else if (buf.length + p.length + 2 <= MAX_CHUNK_CHARS) {
      buf += `\n\n${p}`;
    } else {
      flush();
      // Trim the carried overlap so buf stays within budget.
      const room = MAX_CHUNK_CHARS - p.length - 2;
      const overlap = room > 0 ? buf.slice(-Math.min(OVERLAP_CHARS, room)) : '';
      buf = overlap ? `${overlap}\n\n${p}` : p;
    }
  }
  flush();
  return out;
}
