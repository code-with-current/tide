import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openKnowledgeStore } from '../../../electron/knowledge/store.js';
import { openRagStoreAt } from '../../../electron/rag/store.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-know-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('knowledge source registry', () => {
  it('adds, lists, updates enablement, and deletes sources', () => {
    const ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    const src = ks.addSource({ name: 'React Docs', kind: 'url', location: 'https://react.dev' });
    expect(src.enabledWorkspaceIds).toEqual(['*']);
    expect(src.status).toBe('idle');
    expect(src.chunkCount).toBe(0);
    expect(ks.listSources()).toHaveLength(1);

    ks.setEnabled(src.id, ['ws-1', 'ws-2']);
    expect(ks.getSource(src.id)?.enabledWorkspaceIds).toEqual(['ws-1', 'ws-2']);

    const fresh = ks.addSource({ name: 'Fresh', kind: 'url', location: 'https://f' });
    ks.setEnabled(fresh.id, ['*']);
    expect(ks.getSource(fresh.id)?.enabledWorkspaceIds).toEqual(['*']);
    ks.setEnabled(fresh.id, ['ws-1', '*']);
    expect(ks.getSource(fresh.id)?.enabledWorkspaceIds).toEqual(['ws-1']);
    expect(ks.enabledSourceIdsFor('ws-1')).toContain(fresh.id);
    expect(ks.enabledSourceIdsFor('ws-other')).not.toContain(fresh.id);

    expect(ks.getSource(src.id)?.lastIndexedAt).toBeNull();
    ks.markStatus(src.id, 'idle');
    expect(ks.getSource(src.id)?.lastIndexedAt).toBeNull();

    ks.markStatus(src.id, 'indexing');
    expect(ks.getSource(src.id)?.status).toBe('indexing');

    const before = Date.now() - 1;
    ks.markStatus(src.id, 'idle');
    const idle = ks.getSource(src.id)!;
    expect(idle.status).toBe('idle');
    expect(idle.error).toBeNull();
    expect(idle.lastIndexedAt).not.toBeNull();
    expect(idle.lastIndexedAt!).toBeGreaterThanOrEqual(before);

    ks.markStatus(src.id, 'error', 'boom');
    expect(ks.getSource(src.id)?.status).toBe('error');
    expect(ks.getSource(src.id)?.error).toBe('boom');

    ks.markStatus(src.id, 'idle');
    const recovered = ks.getSource(src.id)!;
    expect(recovered.status).toBe('idle');
    expect(recovered.error).toBeNull();
    expect(recovered.lastIndexedAt).toBe(idle.lastIndexedAt);

    ks.setChunkCount(src.id, 7);
    expect(ks.getSource(src.id)?.chunkCount).toBe(7);

    ks.deleteSource(src.id);
    expect(ks.getSource(src.id)).toBeNull();
    expect(ks.listSources().map((s) => s.name)).toEqual(['Fresh']);
    ks.deleteSource(fresh.id);
    expect(ks.listSources()).toHaveLength(0);
    ks.close();
  });

  it('enabledSourceIdsFor resolves * against concrete workspace ids', () => {
    const ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    const a = ks.addSource({ name: 'A', kind: 'url', location: 'https://a' });
    const b = ks.addSource({ name: 'B', kind: 'docs', location: '/tmp/docs' });
    ks.setEnabled(b.id, ['ws-9']);
    expect(new Set(ks.enabledSourceIdsFor('ws-1'))).toEqual(new Set([a.id]));
    expect(new Set(ks.enabledSourceIdsFor('ws-9'))).toEqual(new Set([a.id, b.id]));
    ks.close();
  });

  it('deleteSource purges chunks tagged with the source id', () => {
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    const ks = openKnowledgeStore(dbPath);
    const doomed = ks.addSource({ name: 'Doomed', kind: 'docs', location: '/tmp/d1' });
    const kept = ks.addSource({ name: 'Kept', kind: 'docs', location: '/tmp/d2' });

    const rag = openRagStoreAt(dbPath);
    const now = Date.now();
    rag.upsertChunks([
      {
        id: 'd1', sourceId: doomed.id, path: '/tmp/d1/a.md', symbol: '',
        content: 'doomed chunk one', contentHash: 'h1',
        startLine: 0, endLine: 0, embedderId: 'local', createdAt: now,
      },
      {
        id: 'd2', sourceId: kept.id, path: '/tmp/d2/b.md', symbol: '',
        content: 'kept chunk', contentHash: 'h2',
        startLine: 0, endLine: 0, embedderId: 'local', createdAt: now,
      },
    ]);
    expect(rag.chunkCount()).toBe(2);

    ks.deleteSource(doomed.id);
    expect(rag.chunkCount()).toBe(1);
    expect(rag.byContentHash('h2')?.id).toBe('d2');
    expect(ks.listSources().map((s) => s.id)).toEqual([kept.id]);
    rag.close();
    ks.close();
  });

  it('reopening is idempotent — table survives without duplicate errors', () => {
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    const a = openKnowledgeStore(dbPath);
    a.addSource({ name: 'Persisted', kind: 'url', location: 'https://p' });
    a.close();
    const b = openKnowledgeStore(dbPath);
    expect(b.listSources().map((s) => s.name)).toEqual(['Persisted']);
    b.close();
  });
});
