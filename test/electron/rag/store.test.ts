import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// store.ts imports `app` from electron for getPath('userData'). Mock it
// per-test so each test gets a fresh temp dir — store tests must not
// share state, and they must not touch the real userData.
const userDataDir = vi.hoisted(() => ({
  current: '' as string,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDir.current),
    isPackaged: false,
  },
}));

vi.mock('../../../electron/appPaths.js', () => ({
  appDataDir: () => userDataDir.current,
}));

import { openRagStore, type ChunkRow } from '../../../electron/rag/store.js';

function mkChunk(overrides: Partial<ChunkRow> = {}): ChunkRow {
  return {
    id: overrides.id ?? 'chunk-1',
    path: overrides.path ?? '/repo/foo.ts',
    symbol: overrides.symbol ?? 'add',
    content: overrides.content ?? 'function add(a, b) { return a + b; }',
    contentHash: overrides.contentHash ?? 'hash-1',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 1,
    embedderId: overrides.embedderId ?? 'local-code-512',
    createdAt: overrides.createdAt ?? 1234567890,
  };
}

describe('RagStore', () => {
  beforeEach(() => {
    userDataDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rag-store-'));
  });

  it('opens, migrates idempotently, and starts empty', () => {
    const store = openRagStore('ws-a');
    expect(store.chunkCount()).toBe(0);
    // Reopening the same workspace is a no-op on schema (no error).
    store.close();
    const reopened = openRagStore('ws-a');
    expect(reopened.chunkCount()).toBe(0);
    expect(reopened.getMeta('schemaVersion')).toBe('1');
    reopened.close();
  });

  it('persists across closures (WAL + same dbPath)', () => {
    const s1 = openRagStore('ws-b');
    s1.upsertChunks([mkChunk({ id: 'c1', content: 'first' })]);
    expect(s1.chunkCount()).toBe(1);
    s1.close();

    const s2 = openRagStore('ws-b');
    expect(s2.chunkCount()).toBe(1);
    expect(s2.byPath('/repo/foo.ts')).toHaveLength(1);
    s2.close();
  });

  it('upserts chunks and returns rowids for vector pairing', () => {
    const store = openRagStore('ws-c');
    const rowids = store.upsertChunks([
      mkChunk({ id: 'c1', content: 'first' }),
      mkChunk({ id: 'c2', content: 'second' }),
    ]);
    expect(rowids).toHaveLength(2);
    expect(typeof rowids[0].rowid).toBe('number');
    expect(rowids[0].id).toBe('c1');
    expect(store.chunkCount()).toBe(2);
    store.close();
  });

  it('upsert is idempotent on id (update, not insert)', () => {
    const store = openRagStore('ws-d');
    store.upsertChunks([mkChunk({ id: 'c1', content: 'first' })]);
    store.upsertChunks([mkChunk({ id: 'c1', content: 'second' })]);
    expect(store.chunkCount()).toBe(1);
    const row = store.byPath('/repo/foo.ts')[0];
    expect(row.content).toBe('second');
    store.close();
  });

  it('looks up by content hash (ingestion skip-unchanged fast path)', () => {
    const store = openRagStore('ws-e');
    store.upsertChunks([mkChunk({ id: 'c1', contentHash: 'h1' })]);
    expect(store.byContentHash('h1')?.id).toBe('c1');
    expect(store.byContentHash('missing')).toBeUndefined();
    store.close();
  });

  it('FTS5 search returns ranked hits over content', () => {
    // Note: unicode61 doesn't split camelCase — `userToString` is one
    // token. Test with whitespace-separated words that the tokenizer
    // actually splits on.
    const store = openRagStore('ws-f');
    store.upsertChunks([
      mkChunk({ id: 'c1', content: 'function fetch user (id) { return db.user(id) }', symbol: 'fetch_user' }),
      mkChunk({ id: 'c2', content: 'function compute hash (s) { return sha(s) }', symbol: 'compute_hash' }),
      mkChunk({ id: 'c3', content: 'function user to string (u) { return u.name }', symbol: 'user_to_string' }),
    ]);
    const hits = store.queryByFts('user', 5);
    expect(hits.length).toBeGreaterThan(0);
    const symbols = hits.map((h) => h.symbol);
    // user appears in c1 and c3 content; should not match c2.
    expect(symbols).toEqual(expect.arrayContaining(['fetch_user', 'user_to_string']));
    expect(symbols).not.toContain('compute_hash');
    store.close();
  });

  it('vector search returns chunks sorted by similarity (desc) and joins back to chunks', () => {
    const store = openRagStore('ws-g');
    const rowids = store.upsertChunks([
      mkChunk({ id: 'c1', symbol: 'add', content: 'function add(a,b){return a+b}' }),
      mkChunk({ id: 'c2', symbol: 'sub', content: 'function sub(a,b){return a-b}' }),
      mkChunk({ id: 'c3', symbol: 'mul', content: 'function mul(a,b){return a*b}' }),
    ]);
    // Synthetic 384-dim embeddings. The query vector is closest to c1.
    const zero = new Array(384).fill(0);
    const v1 = [...zero]; v1[0] = 1;
    const v2 = [...zero]; v2[1] = 1;
    const v3 = [...zero]; v3[2] = 1;
    store.upsertVectors([
      { rowid: rowids[0].rowid, chunkId: 'c1', embedding: v1 },
      { rowid: rowids[1].rowid, chunkId: 'c2', embedding: v2 },
      { rowid: rowids[2].rowid, chunkId: 'c3', embedding: v3 },
    ]);
    // Query closest to v1 → expect c1 first.
    const query = [...zero]; query[0] = 1;
    const hits = store.queryByVector(query, 3);
    expect(hits).toHaveLength(3);
    expect(hits[0].id).toBe('c1');
    expect(hits[0].symbol).toBe('add');
    expect(hits[0].similarity).toBeGreaterThan(0.99);
    store.close();
  });

  it('deletes chunk + FTS + vec rows by chunk id', () => {
    const store = openRagStore('ws-h');
    const rowids = store.upsertChunks([
      mkChunk({ id: 'c1', contentHash: 'h1' }),
      mkChunk({ id: 'c2', contentHash: 'h2' }),
    ]);
    store.upsertVectors([
      { rowid: rowids[0].rowid, chunkId: 'c1', embedding: new Array(384).fill(0) },
      { rowid: rowids[1].rowid, chunkId: 'c2', embedding: new Array(384).fill(0) },
    ]);
    expect(store.chunkCount()).toBe(2);
    expect(store.queryByVector(new Array(384).fill(0), 5)).toHaveLength(2);

    store.deleteChunks(['c1']);
    expect(store.chunkCount()).toBe(1);
    expect(store.byContentHash('h1')).toBeUndefined();
    // Vector table also cleared.
    expect(store.queryByVector(new Array(384).fill(0), 5)).toHaveLength(1);
    // FTS table also cleared.
    expect(store.queryByFts('foo', 5)).toHaveLength(1);
    store.close();
  });

  it('dropAll empties every table', () => {
    const store = openRagStore('ws-i');
    const rowids = store.upsertChunks([
      mkChunk({ id: 'c1' }),
      mkChunk({ id: 'c2', contentHash: 'h2' }),
    ]);
    store.upsertVectors([
      { rowid: rowids[0].rowid, chunkId: 'c1', embedding: new Array(384).fill(0) },
      { rowid: rowids[1].rowid, chunkId: 'c2', embedding: new Array(384).fill(0) },
    ]);
    expect(store.chunkCount()).toBe(2);

    store.dropAll();
    expect(store.chunkCount()).toBe(0);
    expect(store.queryByVector(new Array(384).fill(0), 5)).toHaveLength(0);
    expect(store.queryByFts('foo', 5)).toHaveLength(0);
    store.close();
  });

  it('meta get/set round-trips', () => {
    const store = openRagStore('ws-j');
    expect(store.getMeta('lastIngestedAt')).toBeUndefined();
    store.setMeta('lastIngestedAt', '1700000000000');
    expect(store.getMeta('lastIngestedAt')).toBe('1700000000000');
    // Upsert, not insert.
    store.setMeta('lastIngestedAt', '1700000000001');
    expect(store.getMeta('lastIngestedAt')).toBe('1700000000001');
    store.close();
  });

  it('creates a separate db per workspace', () => {
    const sa = openRagStore('ws-k-a');
    const sb = openRagStore('ws-k-b');
    sa.upsertChunks([mkChunk({ id: 'c1' })]);
    expect(sa.chunkCount()).toBe(1);
    expect(sb.chunkCount()).toBe(0);
    sa.close();
    sb.close();
  });
});
