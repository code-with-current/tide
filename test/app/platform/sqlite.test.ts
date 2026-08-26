import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLoadablePath } from 'sqlite-vec';
import { openDatabase, type TideDatabase } from '../../../app/platform/sqlite.js';

let dir: string;
let db: TideDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-sqlite-seam-'));
  db = openDatabase(path.join(dir, 'seam.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sqlite seam (node backend)', () => {
  it('enables WAL and round-trips pragma user_version', () => {
    db.pragma('journal_mode = WAL');
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.pragma('user_version = 7');
    expect(db.pragma('user_version', { simple: true })).toBe(7);
    const rows = db.pragma('user_version') as { user_version: number }[];
    expect(rows[0]?.user_version).toBe(7);
  });

  it('inserts and selects with $-sigil named params', () => {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
    const res = db
      .prepare('INSERT INTO t (id, n) VALUES ($id, $n)')
      .run({ $id: 'a', $n: 1 });
    expect(res.changes).toBe(1);
    expect(Number(res.lastInsertRowid)).toBeGreaterThan(0);
    db.prepare('INSERT INTO t (id, n) VALUES ($id, $n)').run({ $id: 'b', $n: 2 });
    const row = db.prepare('SELECT n FROM t WHERE id = $id').get({ $id: 'b' }) as
      | { n: number }
      | undefined;
    expect(row?.n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 2 });
  });

  it('commits transactions and rolls back on throw', () => {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO t (id) VALUES (?)').run('keep');
    const boom = db.transaction(() => {
      db.prepare('INSERT INTO t (id) VALUES (?)').run('transient');
      throw new Error('rollback me');
    });
    expect(() => boom()).toThrow('rollback me');
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 1 });

    let sawInsideTx = false;
    const ok = db.transaction((ids: string[]) => {
      sawInsideTx = db.inTransaction;
      for (const id of ids) db.prepare('INSERT INTO t (id) VALUES (?)').run(id);
      return ids.length;
    });
    expect(ok(['x', 'y'])).toBe(2);
    expect(sawInsideTx).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 3 });
  });

  it('fileMustExist fails on a missing file instead of creating it', () => {
    const missing = path.join(dir, 'missing.db');
    expect(() => openDatabase(missing, { fileMustExist: true })).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('readonly connections reject writes but allow reads', () => {
    db.exec('CREATE TABLE t (id TEXT)');
    db.prepare('INSERT INTO t (id) VALUES (?)').run('a');
    db.close();
    db = openDatabase(path.join(dir, 'seam.db'), { readonly: true });
    expect(db.prepare('SELECT id FROM t').all()).toEqual([{ id: 'a' }]);
    expect(() => db.prepare("INSERT INTO t (id) VALUES ('b')").run()).toThrow();
  });
});

// vec0.dylib is a platform binary (sqlite-vec-darwin-arm64 on this machine) —
// skip silently on toolchains without the matching package.
const vecPath = (() => {
  try {
    return getLoadablePath();
  } catch {
    return null;
  }
})();

describe.skipIf(!vecPath || !fs.existsSync(vecPath as string))('sqlite seam extension loading', () => {
  it('loads sqlite-vec and answers vec_version()', () => {
    db.loadExtension(vecPath as string);
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string };
    expect(row.v).toMatch(/^v0\./);
  });
});
