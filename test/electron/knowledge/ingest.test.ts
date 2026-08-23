import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openKnowledgeStore } from '../../../electron/knowledge/store.js';
import { openRagStoreAt } from '../../../electron/rag/store.js';
import { ingestDocuments } from '../../../electron/knowledge/ingest.js';
import type { SourceDocument, SourceProgressEvent } from '../../../electron/knowledge/types.js';
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

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-know-ingest-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ingestDocuments', () => {
  it('chunks, embeds, and stores documents tagged with the source id', async () => {
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    const ks = openKnowledgeStore(dbPath);
    const rag = openRagStoreAt(dbPath);
    const src = ks.addSource({ name: 'Guide', kind: 'url', location: 'https://example.com/guide' });

    const events: SourceProgressEvent[] = [];
    const docs: SourceDocument[] = [
      {
        title: 'Guide',
        origin: 'example.com/guide',
        content: Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with some words.`).join('\n\n'),
      },
    ];
    const res = await ingestDocuments(ks, rag, hashEmbedder(), src.id, docs, {
      onProgress: (e) => {
        events.push(e);
      },
    });

    expect(res.chunks).toBeGreaterThan(1);
    expect(rag.chunkCount()).toBe(res.chunks);

    const rows = rag.rawDb
      .prepare('SELECT id, path, sourceId, symbol, startLine, endLine, content FROM chunks ORDER BY id')
      .all() as { id: string; path: string; sourceId: string; symbol: string; startLine: number; endLine: number; content: string }[];
    for (const r of rows) {
      expect(r.sourceId).toBe(src.id);
      expect(r.path).toBe('example.com/guide');
      expect(r.symbol).toBe('');
      expect(r.startLine).toBe(0);
      expect(r.endLine).toBe(0);
      expect(r.id.startsWith(`${src.id}:example.com/guide:`)).toBe(true);
      expect(r.content.length).toBeLessThanOrEqual(1400);
    }

    expect(rag.getMeta('embedderId')).toBe('local-code-512');

    expect(events[0]?.sourceId).toBe(src.id);
    expect(events[0]?.phase).toBe('chunking');
    expect(events.map((e) => e.phase)).toContain('embedding');
    expect(events.at(-1)?.phase).toBe('done');
    const emb = events.find((e) => e.phase === 'embedding')!;
    expect(emb.chunksEmbedded).toBeGreaterThan(0);
    expect(emb.chunksTotal).toBe(res.chunks);

    rag.close();
    ks.close();
  });

  it('re-ingestion replaces prior chunks — no stale origins or content remain', async () => {
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    const ks = openKnowledgeStore(dbPath);
    const rag = openRagStoreAt(dbPath);
    const src = ks.addSource({ name: 'Docs', kind: 'docs', location: '/tmp/docs' });
    const embedder = hashEmbedder();

    await ingestDocuments(ks, rag, embedder, src.id, [
      { title: 'A', origin: 'example.com/a', content: 'The legacy zebra token lives here. '.repeat(40) },
      { title: 'B', origin: 'example.com/b', content: 'Second page about otters. '.repeat(40) },
    ]);
    expect(rag.chunkCount()).toBeGreaterThan(1);

    await ingestDocuments(ks, rag, embedder, src.id, [
      { title: 'A2', origin: 'example.com/a', content: 'A fresh quokka token appears. '.repeat(40) },
    ]);

    // Deletion is per document origin, so untouched origin example.com/b survives the re-ingest.
    const paths = new Set(
      (rag.rawDb.prepare('SELECT DISTINCT path FROM chunks').all() as { path: string }[]).map((p) => p.path),
    );
    expect(paths).toEqual(new Set(['example.com/a', 'example.com/b']));

    expect(rag.queryByFts('zebra', 5)).toHaveLength(0);
    expect(rag.queryByFts('otters', 5).length).toBeGreaterThan(0);
    expect(rag.queryByFts('quokka', 5).length).toBeGreaterThan(0);
    for (const row of rag.byPath('example.com/a')) {
      expect(row.sourceId).toBe(src.id);
      expect(row.content).not.toContain('zebra');
    }
    expect(ks.getSource(src.id)?.chunkCount).toBe(0);

    rag.close();
    ks.close();
  });

  it('dedupes duplicate origins keeping the last version with accurate counts', async () => {
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    const ks = openKnowledgeStore(dbPath);
    const rag = openRagStoreAt(dbPath);
    const src = ks.addSource({ name: 'Dup', kind: 'url', location: 'https://example.com' });
    const embedder = hashEmbedder();

    const res = await ingestDocuments(ks, rag, embedder, src.id, [
      { title: 'A', origin: 'example.com/dup', content: 'stale donkey token here. '.repeat(40) },
      { title: 'A', origin: 'example.com/dup', content: 'fresh falcon token here. '.repeat(40) },
      { title: 'B', origin: 'example.com/other', content: 'unrelated heron text. '.repeat(40) },
    ]);

    expect(rag.chunkCount()).toBe(res.chunks);
    expect(rag.queryByFts('donkey', 5)).toHaveLength(0);
    expect(rag.queryByFts('falcon', 5).length).toBeGreaterThan(0);
    for (const row of rag.byPath('example.com/dup')) {
      expect(row.content).toContain('falcon');
      expect(row.content).not.toContain('donkey');
    }

    rag.close();
    ks.close();
  });

  it('refuses a different embedder and leaves existing data untouched', async () => {
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    const ks = openKnowledgeStore(dbPath);
    const rag = openRagStoreAt(dbPath);
    const src = ks.addSource({ name: 'Pinned', kind: 'url', location: 'https://example.com/pin' });

    await ingestDocuments(ks, rag, hashEmbedder(), src.id, [
      { title: 'P', origin: 'example.com/pin', content: 'anchored manatee content. '.repeat(40) },
    ]);
    const before = rag.chunkCount();
    expect(before).toBeGreaterThan(0);

    await expect(
      ingestDocuments(ks, rag, hashEmbedder('cloud-base'), src.id, [
        { title: 'Q', origin: 'example.com/q', content: 'would-be gopher text. '.repeat(40) },
      ]),
    ).rejects.toThrow(/different embedder/);

    expect(rag.chunkCount()).toBe(before);
    expect(rag.queryByFts('gopher', 5)).toHaveLength(0);
    expect(rag.getMeta('embedderId')).toBe('local-code-512');

    rag.close();
    ks.close();
  });

  it('does not pin the embedder on a zero-chunk pass', async () => {
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    const ks = openKnowledgeStore(dbPath);
    const rag = openRagStoreAt(dbPath);
    const src = ks.addSource({ name: 'Empty', kind: 'docs', location: '/tmp/empty' });

    const res = await ingestDocuments(ks, rag, hashEmbedder(), src.id, [
      { title: 'Blank', origin: 'example.com/blank', content: '   \n\n  ' },
    ]);

    expect(res.chunks).toBe(0);
    expect(rag.chunkCount()).toBe(0);
    expect(rag.getMeta('embedderId')).toBeUndefined();

    rag.close();
    ks.close();
  });

  it('rejects an unknown source id', async () => {
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    const ks = openKnowledgeStore(dbPath);
    const rag = openRagStoreAt(dbPath);
    await expect(
      ingestDocuments(ks, rag, hashEmbedder(), 'nope', [{ title: 'X', origin: 'x', content: 'y' }]),
    ).rejects.toThrow(/unknown source/);
    rag.close();
    ks.close();
  });
});
