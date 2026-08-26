/** SQLite driver seam: `bun:sqlite` under the Bun runtime (Electrobun main
 *  process), `better-sqlite3` under Node (tests, frozen Electron shell).
 *  better-sqlite3 is unusable under Bun by runtime policy (old versions are
 *  blocklisted, v13 crashes Bun's Node-API — spike 1.3), and bun:sqlite does
 *  not exist under Node, so every storage module must go through
 *  `openDatabase()` here instead of importing a driver directly. The Node
 *  driver is loaded via `createRequire` so Vite/webpack-style bundlers never
 *  statically resolve it.
 *
 *  NAMED-PARAM CONVENTION — always bind objects with `$`-sigil keys and write
 *  statements with `$name` placeholders. bun:sqlite SILENTLY BINDS NULL for
 *  bare object keys — a corruption hazard, not an error — while better-sqlite3
 *  (v13) rejects `$`-prefixed keys ("Missing named parameter"), so the seam
 *  accepts `$`-keys at call sites and strips the sigil for the Node driver.
 *  Positional `?` binds are unaffected.
 *
 *  macOS extension loading: Bun links Apple's system SQLite, which omits
 *  dynamic extension loading (sqlite-vec needs it). Before the first
 *  bun:sqlite Database is constructed we call `Database.setCustomSQLite()`
 *  with the first usable candidate; if none exists we give up silently and
 *  `loadExtension` fails with its own clear error later. On Linux/Windows Bun
 *  static-links its own extension-capable SQLite and `setCustomSQLite` is a
 *  documented no-op, so it is skipped. */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import { stagedLibSqlitePath } from './native-assets.js';

const require = createRequire(import.meta.url);

// Structural probe (matches env.ts) so this compiles under both Bun and Node typings.
const isBunRuntime = Boolean((process.versions as Record<string, string | undefined>)['bun']);

/** Result of an INSERT/UPDATE/DELETE via `run()`. `lastInsertRowid` may be a
 *  BigInt under either driver — wrap with `Number()` when used as a seq. */
export interface TideRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

/** Prepared statement as Tide uses it: sync get/all/run with positional or
 *  single `$`-keyed object binds. */
export interface TideStatement<BindParams extends unknown[] = unknown[], Result = unknown> {
  get(...params: BindParams): Result | undefined;
  all(...params: BindParams): Result[];
  run(...params: BindParams): TideRunResult;
}

/** The minimal SQLite surface Tide's storage layer uses. */
export interface TideDatabase {
  prepare<BindParams extends unknown[] = unknown[], Result = unknown>(sql: string): TideStatement<BindParams, Result>;
  /** bun:sqlite: cached prepare. Node: alias of prepare (uncached). */
  query<BindParams extends unknown[] = unknown[], Result = unknown>(sql: string): TideStatement<BindParams, Result>;
  exec(sql: string): void;
  /** Getter (`'user_version'` → scalar with `{ simple: true }`, row objects
   *  without) or setter (`'user_version = 2'` — return value unspecified). */
  pragma(name: string, opts?: { simple?: boolean }): unknown;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  loadExtension(extensionPath: string): void;
  readonly inTransaction: boolean;
  close(): void;
}

export interface OpenDatabaseOpts {
  /** Open read-only. Implies no-create: a missing file throws (matching
   *  better-sqlite3, which never creates on readonly). */
  readonly?: boolean;
  /** Fail when the file does not exist instead of creating it. */
  fileMustExist?: boolean;
}

/** Open a SQLite database through the runtime-appropriate driver. */
export function openDatabase(dbPath: string, opts: OpenDatabaseOpts = {}): TideDatabase {
  return isBunRuntime ? openBunDatabase(dbPath, opts) : openNodeDatabase(dbPath, opts);
}

// -- Node backend (better-sqlite3, loaded lazily via createRequire) ----------

interface RawNodeStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): TideRunResult;
}

/** better-sqlite3 wants bare bind keys against `$name` placeholders; the seam
 *  convention is `$`-keys, so strip them on the way into the Node driver. A
 *  lone plain object is always a named-bind bag (no sqlite value type is a
 *  plain object); positional binds pass through untouched. */
function stripSigilKeys(params: unknown[]): unknown[] {
  const first = params[0];
  if (
    params.length !== 1 ||
    typeof first !== 'object' ||
    first === null ||
    (Object.getPrototypeOf(first) !== Object.prototype && Object.getPrototypeOf(first) !== null)
  ) {
    return params;
  }
  const entries = Object.entries(first as Record<string, unknown>);
  if (!entries.some(([k]) => k.startsWith('$'))) return params;
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k.startsWith('$') ? k.slice(1) : k] = v;
  return [out];
}

function wrapNodeStatement<BindParams extends unknown[], Result>(
  stmt: RawNodeStatement,
): TideStatement<BindParams, Result> {
  return {
    get: (...params: unknown[]) => stmt.get(...stripSigilKeys(params)) as Result | undefined,
    all: (...params: unknown[]) => stmt.all(...stripSigilKeys(params)) as Result[],
    run: (...params: unknown[]) => stmt.run(...stripSigilKeys(params)),
  };
}

function openNodeDatabase(dbPath: string, opts: OpenDatabaseOpts): TideDatabase {
  // The module is `export =`-shaped, so the required value IS the constructor.
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const options: { readonly?: boolean; fileMustExist?: boolean } = {};
  if (opts.readonly !== undefined) options.readonly = opts.readonly;
  if (opts.fileMustExist !== undefined) options.fileMustExist = opts.fileMustExist;
  const db = new Database(dbPath, options);
  return {
    prepare: <BindParams extends unknown[], Result>(sql: string) =>
      wrapNodeStatement<BindParams, Result>(db.prepare(sql) as unknown as RawNodeStatement),
    // better-sqlite3 has no cached-prepare variant; uncached is semantically
    // identical (callers re-prepare per use anyway).
    query: <BindParams extends unknown[], Result>(sql: string) =>
      wrapNodeStatement<BindParams, Result>(db.prepare(sql) as unknown as RawNodeStatement),
    exec: (sql: string) => void db.exec(sql),
    pragma: (name: string, pragmaOpts?: { simple?: boolean }) => db.pragma(name, pragmaOpts),
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) =>
      db.transaction(fn) as unknown as (...args: A) => R,
    loadExtension: (extensionPath: string) => void db.loadExtension(extensionPath),
    get inTransaction() {
      return db.inTransaction;
    },
    close: () => void db.close(),
  };
}

// -- Bun backend (bun:sqlite) -------------------------------------------------

function openBunDatabase(dbPath: string, opts: OpenDatabaseOpts): TideDatabase {
  const { Database } = loadBunSqlite();
  configureBunSqlite();
  const raw = new Database(dbPath, {
    readonly: opts.readonly ?? false,
    // bun 1.4.0: an explicit create:true would override readonly (the missing
    // file gets CREATED and writes succeed); better-sqlite3 never creates on
    // readonly — so readonly must force create:false too.
    create: !(opts.fileMustExist || opts.readonly),
  });
  return {
    prepare: <BindParams extends unknown[], Result>(sql: string) =>
      raw.prepare(sql) as unknown as TideStatement<BindParams, Result>,
    query: <BindParams extends unknown[], Result>(sql: string) =>
      raw.query(sql) as unknown as TideStatement<BindParams, Result>,
    exec: (sql: string) => void raw.exec(sql),
    pragma: (name: string, pragmaOpts?: { simple?: boolean }) => bunPragma(raw, name, pragmaOpts),
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) => raw.transaction(fn) as unknown as (...args: A) => R,
    loadExtension: (extensionPath: string) => void raw.loadExtension(extensionPath),
    get inTransaction() {
      return raw.inTransaction;
    },
    close: () => void raw.close(),
  };
}

/** bun:sqlite has no `.pragma()`: read/write via a prepared `pragma <name>`
 *  statement. Getter semantics mirror better-sqlite3: an array of row
 *  objects, or with `{ simple: true }` the first column of the first row. */
function bunPragma(
  raw: import('bun:sqlite').Database,
  name: string,
  opts?: { simple?: boolean },
): unknown {
  const stmt = raw.prepare(`pragma ${name}`);
  let rows: Record<string, unknown>[];
  try {
    rows = stmt.all() as Record<string, unknown>[];
  } catch {
    // Setters that refuse row iteration — execute directly. A genuinely
    // broken pragma rethrows here via run().
    stmt.run();
    rows = [];
  }
  if (!opts?.simple) return rows;
  const first = rows[0];
  if (first === undefined) return undefined;
  return Object.values(first)[0];
}

function loadBunSqlite(): typeof import('bun:sqlite') {
  return require('bun:sqlite') as typeof import('bun:sqlite');
}

// -- bun:sqlite custom-SQLite bootstrap (macOS only) ---------------------------

let bunSqliteConfigured = false;

/** Point bun:sqlite at an extension-capable libsqlite3 before the FIRST
 *  Database construction. Idempotent; a no-op under Node and on non-darwin
 *  platforms. Exported for callers (spikes, main-process boot) that construct
 *  raw bun:sqlite Databases beside the seam. */
export function configureBunSqlite(): void {
  if (bunSqliteConfigured) return;
  bunSqliteConfigured = true;
  if (!isBunRuntime || process.platform !== 'darwin') return;
  const { Database } = loadBunSqlite();
  for (const candidate of customSqliteCandidates()) {
    try {
      if (fs.existsSync(candidate) && Database.setCustomSQLite(candidate)) return;
    } catch {
      // try the next candidate
    }
  }
  // No candidate usable — stay on Bun's default SQLite; loadExtension fails
  // with its own (clear) error when an extension is actually needed.
}

/** Best-effort locations of a vanilla, extension-capable libsqlite3, in order:
 *  the dylib staged into the bundle (native/lib/, darwin builds only), then
 *  Homebrew on dev machines. */
function customSqliteCandidates(): string[] {
  const staged = stagedLibSqlitePath();
  return [
    ...(staged !== undefined ? [staged] : []),
    '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
  ];
}
