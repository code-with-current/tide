/** Serial ingestion job queue over the knowledge registry: one job at a time,
 *  status transitions queued → indexing → idle/error, progress events fanned
 *  out to a broadcast callback (IPC layer in Task 8). Fetchers are injected by
 *  kind so new source kinds (crawl/repo, Tasks 9–10) just add map entries. */
import type { Embedder } from '../rag/embedder.js';
import { ingestDocuments } from './ingest.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeSource, SourceDocument, SourceKind, SourceProgressEvent } from './types.js';

export interface FetcherCallOptions {
  /** Crawl-style page progress, mapped onto SourceProgressEvent by the manager. */
  onPage?: (pagesSeen: number, current: string) => void;
}

export type SourceFetcher = (
  location: string,
  opts?: FetcherCallOptions,
) => Promise<SourceDocument[]>;

/** Either a ready embedder or a lazy resolver invoked inside the job — the
 *  global embedder config may not be readable at manager construction. */
export type EmbedderInput = Embedder | (() => Embedder | Promise<Embedder>);

export interface KnowledgeManager {
  /** Resolves when THIS source's job finishes (not when the whole queue
   *  drains). Duplicate enqueues of the same pending source share one job. */
  enqueue(sourceId: string): Promise<void>;
  remove(sourceId: string): Promise<void>;
  /** Boot-time cleanup: crash leftovers stuck in 'queued'/'indexing' resolve
   *  to 'idle' without stamping lastIndexedAt. */
  recoverStale(): void;
}

export function createKnowledgeManager(deps: {
  knowledge: () => KnowledgeStore;
  embedder: EmbedderInput;
  fetchers: Partial<Record<SourceKind, SourceFetcher>>;
  broadcast: (e: SourceProgressEvent) => void;
}): KnowledgeManager {
  const resolveEmbedder = typeof deps.embedder === 'function' ? deps.embedder : () => deps.embedder;

  let chain: Promise<void> = Promise.resolve();
  const pending = new Map<string, Promise<void>>();

  function runJob(sourceId: string): Promise<void> {
    const ks = deps.knowledge();
    const src = ks.getSource(sourceId);
    if (!src) return Promise.resolve();

    ks.markStatus(sourceId, 'indexing');
    return (async () => {
      try {
        const cur = ks.getSource(sourceId);
        if (!cur) return;
        const fetcher = deps.fetchers[cur.kind];
        if (!fetcher) throw new Error(`no fetcher registered for kind '${cur.kind}'`);
        deps.broadcast({ sourceId, phase: 'fetching', current: cur.location });
        const docs = await fetcher(cur.location, {
          onPage: (pagesSeen, current) =>
            deps.broadcast({ sourceId, phase: 'fetching', pagesSeen, current }),
        });

        if (!ks.getSource(sourceId)) {
          purgeOrphans(ks, sourceId);
          return;
        }
        const embedder = await resolveEmbedder();
        const { chunks } = await ingestDocuments(ks, ks.rag, embedder, sourceId, docs, {
          onProgress: (e) => deps.broadcast(e),
        });
        if (!ks.getSource(sourceId)) {
          purgeOrphans(ks, sourceId);
          return;
        }
        ks.setChunkCount(sourceId, chunks);
        ks.markStatus(sourceId, 'idle');
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // A removed source has no row left to carry the error.
        if (!ks.getSource(sourceId)) return;
        ks.markStatus(sourceId, 'error', message);
        try {
          deps.broadcast({ sourceId, phase: 'failed', error: message });
        } catch {
          // Listener death (destroyed webContents at quit) must not fail the job.
        }
      }
    })();
  }

  function purgeOrphans(ks: KnowledgeStore, sourceId: string): void {
    // The source was deleted mid-job; ingestDocuments' delete-before-embed
    // window may have re-written chunks after deleteSource purged them.
    ks.rag.deleteChunkRows(ks.rag.chunksBySource(sourceId));
  }

  return {
    enqueue(sourceId: string): Promise<void> {
      const existing = pending.get(sourceId);
      if (existing) return existing;
      const ks = deps.knowledge();
      const src: KnowledgeSource | null = ks.getSource(sourceId);
      if (!src) throw new Error(`enqueue: unknown knowledge source ${sourceId}`);
      ks.markStatus(sourceId, 'queued');
      const run = chain.then(() => runJob(sourceId));
      chain = run.then(() => {}, () => {});
      pending.set(sourceId, run);
      run.finally(() => pending.delete(sourceId)).catch(() => {});
      return run;
    },

    async remove(sourceId: string): Promise<void> {
      const ks = deps.knowledge();
      if (!ks.getSource(sourceId)) return;
      ks.deleteSource(sourceId);
      const inflight = pending.get(sourceId);
      try {
        if (inflight) await inflight;
      } finally {
        purgeOrphans(ks, sourceId);
      }
    },

    recoverStale(): void {
      deps.knowledge().resolveStaleStatuses([...pending.keys()]);
    },
  };
}
