import { createRequire } from 'node:module';
import { getLoadablePath as getSqliteVecPath } from 'sqlite-vec';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, configureBunSqlite } from '../platform/sqlite.js';

// Proves the sqlite driver story against Tide's REAL databases, opened
// { readonly: true } only: raw-driver probes (better-sqlite3 under Node,
// bun:sqlite under Bun — the two backends app/platform/sqlite.ts selects,
// loaded here directly because the spike intentionally exercises raw
// drivers), plus an end-to-end exercise of the seam itself on a TEMP db.
// RAG indexes live apart from sessions-v2.db (rag/<workspaceId>/index.db via
// openRagStore, plus the global knowledge/index.db via openRagStoreAt), so
// all of them are probed. vec probes stay metadata-level — no fabricated
// embeddings.
interface SessionsEntry {
  file: string;
  kind: 'sessions';
  bytes: number;
  journalMode: string;
  userVersion: number;
  sessions: number;
  messages: number;
  parts: number;
  events: number;
}

interface RagEntry {
  file: string;
  kind: 'rag';
  bytes: number;
  journalMode: string;
  schemaVersion: string | null;
  vecTables: string[];
  vecTable: string | null;
  chunks: number | null;
  vecRows: number | null;
  vecProbeRowid: number | null;
  vecVersion: string | null;
}

// Both raw drivers structurally satisfy this; only .pragma differs between
// them, handled by pragmaSimple() below.
interface RawDb {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  exec(sql: string): unknown;
  loadExtension(p: string): unknown;
  close(): void;
  pragma?(name: string, opts?: { simple?: boolean }): unknown;
}
type RawDatabase = new (filename: string, opts?: { readonly?: boolean }) => RawDb;

const require = createRequire(import.meta.url);
const isBunRuntime = Boolean((process.versions as Record<string, string | undefined>)['bun']);

function loadRawDriver(): { Database: RawDatabase; name: 'bun:sqlite' | 'better-sqlite3' } {
  if (isBunRuntime) {
    // Must run before the FIRST bun:sqlite Database construction anywhere in
    // the process (homebrew/libsqlite3 candidate) or loadExtension fails.
    configureBunSqlite();
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    return { Database: Database as unknown as RawDatabase, name: 'bun:sqlite' };
  }
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  return { Database: Database as unknown as RawDatabase, name: 'better-sqlite3' };
}

// pragma getter across raw drivers: better-sqlite3 has .pragma(simple), bun
// goes through a prepared statement.
function pragmaSimple(db: RawDb, name: string): unknown {
  if (db.pragma) return db.pragma(name, { simple: true });
  const row = db.prepare(`pragma ${name}`).get() as Record<string, unknown> | undefined;
  return row === undefined ? undefined : Object.values(row)[0];
}

function loadVec(db: RawDb): string {
  // Same load path as app/core/rag/store.ts: getLoadablePath() + the
  // app.asar -> app.asar.unpacked rewrite (a no-op outside a packaged app).
  const vecPath = getSqliteVecPath();
  const realPath = vecPath.replace('app.asar', 'app.asar.unpacked');
  db.loadExtension(realPath);
  return (db.prepare('select vec_version() as v').get() as { v: string }).v;
}

function count(db: RawDb, table: string): number | null {
  try {
    const row = db.prepare(`select count(*) as c from ${table}`).get() as
      | { c: number }
      | undefined;
    return row ? row.c : null;
  } catch {
    return null;
  }
}

function probeSessions(Database: RawDatabase, file: string): SessionsEntry {
  const db = new Database(file, { readonly: true });
  try {
    return {
      file,
      kind: 'sessions',
      bytes: fs.statSync(file).size,
      journalMode: pragmaSimple(db, 'journal_mode') as string,
      userVersion: pragmaSimple(db, 'user_version') as number,
      sessions: count(db, 'session') ?? -1,
      messages: count(db, 'message') ?? -1,
      parts: count(db, 'part') ?? -1,
      events: count(db, 'event') ?? -1,
    };
  } finally {
    db.close();
  }
}

function probeRag(Database: RawDatabase, file: string): RagEntry {
  const db = new Database(file, { readonly: true });
  try {
    const vecVersion = loadVec(db);
    const journalMode = pragmaSimple(db, 'journal_mode') as string;
    const schemaVersion =
      (db.prepare("select value from meta where key = 'schemaVersion'").get() as
        | { value: string }
        | undefined)?.value ?? null;
    const vecTables = (
      db.prepare("select name from sqlite_master where type = 'table' and name like '%vec%' order by name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    // The vec0 virtual table itself (vs its shadow tables) is the one whose
    // DDL says CREATE VIRTUAL TABLE.
    const vecTable =
      (
        db.prepare("select name from sqlite_master where type = 'table' and sql like 'CREATE VIRTUAL%' and name like '%vec%'").get() as
          | { name: string }
          | undefined
      )?.name ?? null;
    let vecProbeRowid: number | null = null;
    if (vecTable) {
      try {
        const row = db.prepare(`select rowid from ${vecTable} limit 1`).get() as
          | { rowid: number }
          | undefined;
        vecProbeRowid = row ? row.rowid : null;
      } catch {
        // vec0 may reject bare scans; the shadow-table count already proves rows exist
      }
    }
    return {
      file,
      kind: 'rag',
      bytes: fs.statSync(file).size,
      journalMode,
      schemaVersion,
      vecTables,
      vecTable,
      chunks: count(db, 'chunks'),
      vecRows: vecTable ? count(db, `${vecTable}_rowids`) : null,
      vecProbeRowid,
      vecVersion,
    };
  } finally {
    db.close();
  }
}

// End-to-end seam exercise on a throwaway db: WAL pragma, a $-sigil upsert
// with RETURNING rowid (mirrors RagStore.upsertChunks, the statement shape
// bun:sqlite must honor), transaction, pragma roundtrip.
function exerciseSeam(): {
  journalMode: string;
  upsertRowid: number;
  sigilSelect: number;
  userVersion: number;
  txCount: number;
  rollbackHeld: boolean;
  readonlyNoCreate: boolean;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-sqlite-seam-spike-'));
  try {
    const db = openDatabase(path.join(tmp, 'seam.db'));
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE seam (id TEXT PRIMARY KEY, n INTEGER NOT NULL)');
    const upsert = db.prepare(
      `INSERT INTO seam (id, n) VALUES ($id, $n)
       ON CONFLICT(id) DO UPDATE SET n = excluded.n
       RETURNING rowid`,
    );
    const { rowid } = upsert.get({ $id: 'a', $n: 1 }) as { rowid: number };
    upsert.get({ $id: 'a', $n: 41 });
    const sigilSelect = (
      db.prepare('SELECT n FROM seam WHERE id = $id').get({ $id: 'a' }) as { n: number }
    ).n;
    db.pragma('user_version = 3');
    const userVersion = db.pragma('user_version', { simple: true }) as number;
    const tx = db.transaction((ns: number[]) => {
      const ins = db.prepare('INSERT INTO seam (id, n) VALUES ($id, $n)');
      for (const n of ns) ins.run({ $id: `t${n}`, $n: n });
    });
    tx([2, 3]);
    const rollback = db.transaction(() => {
      db.prepare('INSERT INTO seam (id, n) VALUES ($id, $n)').run({ $id: 'gone', $n: 9 });
      throw new Error('rollback');
    });
    try {
      rollback();
    } catch {
      // expected
    }
    const txCount = (db.prepare('SELECT COUNT(*) AS c FROM seam').get() as { c: number }).c;
    const rollbackHeld = txCount === 3;
    const journalMode = db.pragma('journal_mode', { simple: true }) as string;
    db.close();
    // bun 1.4.0 regression: { readonly: true } on a missing file must throw
    // (better-sqlite3 never creates on readonly; bun's create:true would
    // override readonly and create the file).
    const missing = path.join(tmp, 'readonly-missing.db');
    let readonlyThrew = false;
    try {
      openDatabase(missing, { readonly: true }).close();
    } catch {
      readonlyThrew = true;
    }
    const readonlyNoCreate = readonlyThrew && !fs.existsSync(missing);
    return {
      journalMode,
      upsertRowid: rowid,
      sigilSelect,
      userVersion,
      txCount,
      rollbackHeld,
      readonlyNoCreate,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main(): void {
  const { Database, name: driver } = loadRawDriver();
  const home = os.homedir();
  const sessionsCandidates = [
    path.join(home, '.tide-dev', 'sessions-v2.db'),
    path.join(home, '.tide', 'sessions-v2.db'),
  ];
  const sessionsFile = sessionsCandidates.find((f) => fs.existsSync(f));
  if (!sessionsFile) throw new Error(`no sessions-v2.db under ${home}/.tide-dev or ${home}/.tide`);
  const root = path.dirname(sessionsFile);

  const ragDir = path.join(root, 'rag');
  let ragFile: string | null = null;
  let ragBytes = -1;
  if (fs.existsSync(ragDir)) {
    for (const name of fs.readdirSync(ragDir)) {
      const f = path.join(ragDir, name, 'index.db');
      try {
        const size = fs.statSync(f).size;
        if (size > ragBytes) {
          ragBytes = size;
          ragFile = f;
        }
      } catch {
        // not a workspace index dir
      }
    }
  }

  const dbs: (SessionsEntry | RagEntry)[] = [probeSessions(Database, sessionsFile)];
  let vecVersion: string | null = null;
  if (ragFile) {
    const entry = probeRag(Database, ragFile);
    vecVersion = entry.vecVersion;
    dbs.push(entry);
  }
  const knowledgeFile = path.join(root, 'knowledge', 'index.db');
  if (fs.existsSync(knowledgeFile)) {
    const entry = probeRag(Database, knowledgeFile);
    vecVersion ??= entry.vecVersion;
    dbs.push(entry);
  }
  if (!vecVersion) {
    // No real RAG db on this machine — still prove the dylib loads via :memory:.
    const mem = new Database(':memory:');
    try {
      vecVersion = loadVec(mem);
    } finally {
      mem.close();
    }
  }

  const seam = exerciseSeam();
  const seamOk =
    seam.journalMode === 'wal' &&
    seam.upsertRowid > 0 &&
    seam.sigilSelect === 41 &&
    seam.userVersion === 3 &&
    seam.txCount === 3 &&
    seam.rollbackHeld &&
    seam.readonlyNoCreate;

  console.log(
    JSON.stringify({
      spike: 'sqlite',
      runtime: isBunRuntime ? `bun ${process.versions['bun']}` : `node ${process.version}`,
      driver,
      dbs,
      vecVersion,
      seam,
      ok: Boolean(vecVersion) && seamOk,
    }),
  );
  process.exit(0);
}

main();
