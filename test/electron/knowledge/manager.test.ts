import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openKnowledgeStore } from '../../../electron/knowledge/store.js';
import { createKnowledgeManager } from '../../../electron/knowledge/manager.js';
import type {
  KnowledgeManager,
  SourceFetcher,
} from '../../../electron/knowledge/manager.js';
import type {
  SourceDocument,
  SourceProgressEvent,
} from '../../../electron/knowledge/types.js';
import type { Embedder } from '../../../electron/rag/embedder.js';

function hashEmbedder(id: Embedder['id'] = 'local-code-512'): Embedder {
  return {
    id,
    dim: 384,
    maxTokens: 512,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(384).fill(0);
        for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 384] += 1;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}

function doc(origin: string, content = 'Paragraph one.\n\nParagraph two with more words.'): SourceDocument {
  return { title: origin, origin, content };
}

type FetcherMap = Partial<Record<'url' | 'docs' | 'crawl' | 'repo', SourceFetcher>>;

function fakeFetchers(overrides: FetcherMap = {}): FetcherMap & Record<SourceKindOf, SourceFetcher> {
  const passthrough: SourceFetcher = async () => [doc('stub.example.com/page')];
  return {
    url: passthrough,
    docs: passthrough,
    crawl: passthrough,
    repo: passthrough,
    ...overrides,
  };
}


let tmp: string;
let ks: ReturnType<typeof openKnowledgeStore>;
let events: SourceProgressEvent[];
let mgr: KnowledgeManager;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-know-manager-'));
  ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
  events = [];
});

afterEach(() => {
  ks.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeManager(fetchers: FetcherMap, embedder: EmbedderInputLike = hashEmbedder()) {
  return createKnowledgeManager({
    knowledge: () => ks,
    embedder,
    fetchers: fakeFetchers(fetchers),
    broadcast: (e) => events.push(e),
  });
}
type EmbedderInputLike = Embedder | (() => Embedder);

describe('knowledge manager', () => {
  it('marks queued synchronously, then indexing → idle with lastIndexedAt + chunk count on success', async () => {
    mgr = makeManager();
    const src = ks.addSource({ name: 'Guide', kind: 'url', location: 'https://example.com/guide' });

    const p = mgr.enqueue(src.id);
    expect(ks.getSource(src.id)?.status).toBe('queued');
    await p;

    const after = ks.getSource(src.id)!;
    expect(after.status).toBe('idle');
    expect(after.lastIndexedAt).toBeGreaterThan(0);
    expect(after.chunkCount).toBeGreaterThan(0);
    expect(events.map((e) => e.phase)).toEqual(
      expect.arrayContaining(['fetching', 'chunking', 'embedding', 'done']),
    );
    expect(events.every((e) => e.sourceId === src.id)).toBe(true);
    expect(ks.rag.chunkCount()).toBe(after.chunkCount);
  });

  it('runs jobs serially across sources', async () => {
    let openGate: () => void = () => {};
    const gated = new Promise<void>((r) => (openGate = r));
    const log: string[] = [];
    mgr = makeManager({
      url: async () => {
        log.push('url:start');
        await gated;
        log.push('url:end');
        return [doc('a.example.com')];
      },
      docs: async () => {
        log.push('docs:start');
        return [doc('/tmp/docs/a.md')];
      },
    });
    const a = ks.addSource({ name: 'A', kind: 'url', location: 'https://a.example.com' });
    const b = ks.addSource({ name: 'B', kind: 'docs', location: '/tmp/docs' });

    const pa = mgr.enqueue(a.id);
    const pb = mgr.enqueue(b.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['url:start']);
    expect(ks.getSource(b.id)?.status).toBe('queued');

    openGate();
    await Promise.all([pa, pb]);
    expect(log).toEqual(['url:start', 'url:end', 'docs:start']);
    expect(ks.getSource(a.id)?.status).toBe('idle');
    expect(ks.getSource(b.id)?.status).toBe('idle');
  });

  it('coalesces duplicate enqueues of the same source into one job', async () => {
    const fetcher = vi.fn(async () => [doc('dup.example.com')]);
    mgr = makeManager({ url: fetcher });
    const src = ks.addSource({ name: 'Dup', kind: 'url', location: 'https://dup.example.com' });

    await Promise.all([mgr.enqueue(src.id), mgr.enqueue(src.id)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('records error status + failed event when the fetcher throws', async () => {
    mgr = makeManager({
      url: async () => {
        throw new Error('fetch failed: 500 https://bad.example.com');
      },
    });
    const src = ks.addSource({ name: 'Bad', kind: 'url', location: 'https://bad.example.com' });

    await mgr.enqueue(src.id);
    const after = ks.getSource(src.id)!;
    expect(after.status).toBe('error');
    expect(after.error).toContain('fetch failed: 500');
    expect(after.lastIndexedAt).toBeNull();
    expect(events.some((e) => e.phase === 'failed' && e.error?.includes('500'))).toBe(true);
    expect(events.some((e) => e.phase === 'done')).toBe(false);
  });

  it('fails the job when no fetcher is registered for the kind', async () => {
    mgr = makeManager({ crawl: undefined });
    const src = ks.addSource({ name: 'C', kind: 'crawl', location: 'https://c.example.com' });

    await mgr.enqueue(src.id);
    expect(ks.getSource(src.id)?.status).toBe('error');
    expect(ks.getSource(src.id)?.error).toContain("no fetcher registered for kind 'crawl'");
  });

  it('rejects enqueueing an unknown source without touching the queue', () => {
    mgr = makeManager();
    expect(() => mgr.enqueue('nope')).toThrow(/unknown knowledge source/);
  });

  it('resolves crash-leftover queued/indexing statuses to idle without stamping lastIndexedAt', () => {
    mgr = makeManager();
    const a = ks.addSource({ name: 'StuckQ', kind: 'url', location: 'https://q.example.com' });
    const b = ks.addSource({ name: 'StuckI', kind: 'url', location: 'https://i.example.com' });
    ks.markStatus(a.id, 'queued');
    ks.markStatus(b.id, 'indexing');

    mgr.recoverStale();

    expect(ks.getSource(a.id)?.status).toBe('idle');
    expect(ks.getSource(b.id)?.status).toBe('idle');
    expect(ks.getSource(a.id)?.lastIndexedAt).toBeNull();
    expect(ks.getSource(b.id)?.lastIndexedAt).toBeNull();
  });

  it('remove deletes row + chunks even while a job is queued or running', async () => {
    let release: () => void = () => {};
    mgr = makeManager({
      url: async () => {
        await new Promise<void>((r) => (release = r));
        return [doc('slow.example.com')];
      },
    });
    const src = ks.addSource({ name: 'Slow', kind: 'url', location: 'https://slow.example.com' });

    const p = mgr.enqueue(src.id);
    await vi.waitFor(() => expect(ks.getSource(src.id)?.status).toBe('indexing'));

    const rm = mgr.remove(src.id);
    release();
    await Promise.all([p, rm]);

    expect(ks.getSource(src.id)).toBeNull();
    expect(ks.rag.chunkCount()).toBe(0);
    expect(ks.listSources()).toHaveLength(0);
  });

  it('accepts a lazy embedder resolver invoked inside the job', async () => {
    const resolver = vi.fn(() => hashEmbedder());
    mgr = makeManager({}, resolver);
    const src = ks.addSource({ name: 'Lazy', kind: 'url', location: 'https://lazy.example.com' });

    await mgr.enqueue(src.id);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(ks.rag.getMeta('embedderId')).toBe('local-code-512');
  });

  it('still marks the source errored when the failed-event broadcast throws', async () => {
    mgr = createKnowledgeManager({
      knowledge: () => ks,
      embedder: hashEmbedder(),
      fetchers: fakeFetchers({ url: async () => {
        throw new Error('boom');
      } }),
      broadcast: (e) => {
        if (e.phase === 'failed') throw new Error('listener gone');
        events.push(e);
      },
    });
    const src = ks.addSource({ name: 'Loud', kind: 'url', location: 'https://loud.example.com' });

    await expect(mgr.enqueue(src.id)).resolves.toBeUndefined();
    const row = ks.getSource(src.id);
    expect(row?.status).toBe('error');
    expect(row?.error).toBe('boom');
  });

  it('recoverStale skips sources with a live pending job', async () => {
    let release: () => void = () => {};
    mgr = makeManager({
      url: async () => {
        await new Promise<void>((r) => (release = r));
        return [doc('live.example.com')];
      },
    });
    const src = ks.addSource({ name: 'Live', kind: 'url', location: 'https://live.example.com' });

    const p = mgr.enqueue(src.id);
    await vi.waitFor(() => expect(ks.getSource(src.id)?.status).toBe('indexing'));

    mgr.recoverStale();
    expect(ks.getSource(src.id)?.status).toBe('indexing');

    release();
    await p;
    expect(ks.getSource(src.id)?.status).toBe('idle');
    expect(ks.getSource(src.id)?.lastIndexedAt).not.toBeNull();
  });
});
