import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openRagStoreAt } from '../../../electron/rag/store.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rag-v2-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('schema v2', () => {
  it('opens a store at an explicit path and round-trips sourceId chunks', () => {
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    const store = openRagStoreAt(dbPath);
    const [{ rowid }] = store.upsertChunks([
      {
        id: 'c1',
        sourceId: 's1',
        path: 'example.com/guide',
        symbol: '',
        content: 'hello world',
        contentHash: 'h1',
        startLine: 0,
        endLine: 1,
        embedderId: 'local',
        createdAt: Date.now(),
      },
    ]);
    expect(rowid).toBeGreaterThan(0);
    const hits = store.queryByFts('hello', 5);
    expect(hits[0]?.sourceId).toBe('s1');
    store.close();
  });

  it('migrates an existing v1 workspace store without data loss', () => {
    const dbPath = path.join(tmp, 'index.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE chunks (
        id           TEXT PRIMARY KEY,
        path         TEXT NOT NULL,
        symbol       TEXT NOT NULL,
        content      TEXT NOT NULL,
        contentHash  TEXT NOT NULL,
        startLine    INTEGER NOT NULL,
        endLine      INTEGER NOT NULL,
        embedderId   TEXT NOT NULL,
        createdAt    INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(
        'INSERT INTO chunks(id, path, symbol, content, contentHash, startLine, endLine, embedderId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('old', 'src/x.ts', '', 'legacy chunk', 'h2', 0, 1, 'local', 1234567890);
    legacy.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schemaVersion', '1');
    legacy.close();

    const b = openRagStoreAt(dbPath);
    expect(b.getMeta('schemaVersion')).toBe('2');
    expect(b.chunkCount()).toBe(1);
    expect(b.byPath('src/x.ts')[0].sourceId).toBeNull();
    b.close();

    const c = openRagStoreAt(dbPath);
    expect(c.chunkCount()).toBe(1);
    c.close();
  });

  it('recovers from a crash-interrupted migration (v1 db with sourceId already added)', () => {
    // Simulates a pre-transactional crash: version still '1' but ALTER TABLE
    // already applied. migrate() must not re-run ADD COLUMN and must not throw.
    const dbPath = path.join(tmp, 'index.db');
    const crashed = new Database(dbPath);
    crashed.exec(`
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE chunks (
        id           TEXT PRIMARY KEY,
        path         TEXT NOT NULL,
        symbol       TEXT NOT NULL,
        content      TEXT NOT NULL,
        contentHash  TEXT NOT NULL,
        startLine    INTEGER NOT NULL,
        endLine      INTEGER NOT NULL,
        embedderId   TEXT NOT NULL,
        createdAt    INTEGER NOT NULL,
        sourceId     TEXT
      );
    `);
    crashed.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schemaVersion', '1');
    crashed.close();

    const b = openRagStoreAt(dbPath);
    expect(b.getMeta('schemaVersion')).toBe('2');
    expect(() => openRagStoreAt(dbPath)).not.toThrow();
    b.close();
  });
});
