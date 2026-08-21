#!/usr/bin/env node
// Perf gate for the v2 session store (electron/ipc/session-store-v2.ts).
// Builds a throwaway SQLite db with the same schema, seeds a 500-message
// session (2 parts per message) plus 199 sibling sessions in the same
// workspace (200 total), and gates the two hot read paths from the design
// doc: session list (< 10 ms) and 50-message window fetch (< 25 ms).
// Not wired into CI — run manually via `node scripts/perf-gate-v2.mjs`.
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_TS = resolve(__dirname, '..', 'electron', 'ipc', 'session-store-v2.ts');

// Must stay byte-identical to the SCHEMA literal in session-store-v2.ts —
// verified by the drift check below. Never edit one without the other.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  model_id TEXT, provider_id TEXT,
  tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
  tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
  archived_at INTEGER,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_list ON session(workspace_path, archived_at, time_updated DESC);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role TEXT NOT NULL, model TEXT,
  time_created INTEGER NOT NULL, time_completed INTEGER
);

CREATE INDEX IF NOT EXISTS message_session ON message(session_id, id);

CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS part_window ON part(session_id, id);
CREATE INDEX IF NOT EXISTS part_message ON part(message_id, seq);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, message_id TEXT, part_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL, time_created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS event_replay ON event(session_id, seq);
`;

const SESSION_COLUMNS = `
  id, workspace_path AS "workspacePath", parent_id AS "parentId", title,
  model_id AS "modelId", provider_id AS "providerId",
  tokens_input AS "tokensInput", tokens_output AS "tokensOutput",
  tokens_reasoning AS "tokensReasoning", tokens_cache_read AS "tokensCacheRead",
  cost, summary_additions AS "summaryAdditions", summary_deletions AS "summaryDeletions",
  summary_files AS "summaryFiles", archived_at AS "archivedAt",
  time_created AS "timeCreated", time_updated AS "timeUpdated"`;

const WORKSPACE = '/home/dev/projects/demo-app';
const MAIN_SESSION = 's_perf_main';
const MESSAGE_COUNT = 500;
const EXTRA_SESSIONS = 199;
const WINDOW_SIZE = 50;
const LIST_BUDGET_MS = 10;
const WINDOW_BUDGET_MS = 25;

function assertSchemaInSync() {
  const ts = readFileSync(STORE_TS, 'utf8');
  const m = ts.match(/const SCHEMA = `([\s\S]*?)`;/);
  if (!m) {
    console.error(`DRIFT: cannot extract the SCHEMA literal from ${STORE_TS} — update this script's extraction.`);
    process.exit(1);
  }
  if (m[1].trim() !== SCHEMA.trim()) {
    console.error(
      'DRIFT: SCHEMA in scripts/perf-gate-v2.mjs no longer matches electron/ipc/session-store-v2.ts.\n' +
        'Copy the updated SCHEMA literal into this script so the gate keeps testing the real schema.',
    );
    process.exit(1);
  }
  console.log('schema sync check: OK');
}

function seed(db) {
  const t0 = 1_700_000_000_000;
  const textData = JSON.stringify({ text: 'lorem ipsum dolor sit amet '.repeat(9) });
  const toolData = JSON.stringify({ tool: 'bash', output: 'exit 0\n'.repeat(15) });

  const insertSession = db.prepare(
    'INSERT INTO session (id, workspace_path, parent_id, title, model_id, provider_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertMessage = db.prepare(
    'INSERT INTO message (id, session_id, role, model, time_created) VALUES (?, ?, ?, ?, ?)',
  );
  const insertPart = db.prepare(
    'INSERT INTO part (id, message_id, session_id, seq, kind, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );

  db.transaction(() => {
    insertSession.run(MAIN_SESSION, WORKSPACE, null, 'Perf gate main session', 'test-model', 'test-provider', t0, t0);
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      // Zero-padded base36 keeps ids chronologically sortable as plain text,
      // matching the ordering contract the window queries rely on.
      const messageId = `m_${i.toString(36).padStart(8, '0')}_x`;
      insertMessage.run(messageId, MAIN_SESSION, i % 2 === 0 ? 'user' : 'assistant', 'test-model', t0 + i);
      insertPart.run(`p_${i}_0`, messageId, MAIN_SESSION, 0, 'text', textData, t0 + i, t0 + i);
      insertPart.run(`p_${i}_1`, messageId, MAIN_SESSION, 1, 'tool', toolData, t0 + i, t0 + i);
    }
    for (let i = 0; i < EXTRA_SESSIONS; i++) {
      const t = t0 + i;
      insertSession.run(`s_extra_${i}`, WORKSPACE, null, `Extra session ${i}`, 'test-model', 'test-provider', t, t);
    }
  })();

  const sessions = db.prepare('SELECT COUNT(*) AS n FROM session').get().n;
  const messages = db.prepare('SELECT COUNT(*) AS n FROM message').get().n;
  const parts = db.prepare('SELECT COUNT(*) AS n FROM part').get().n;
  console.log(`seeded: ${sessions} sessions, ${messages} messages, ${parts} parts (workspace: ${WORKSPACE})`);
}

function measure(label, budgetMs, fn) {
  fn(); // warm-up — discards cold-start noise (statement compile, page cache)
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    fn();
    runs.push(performance.now() - start);
  }
  console.log(`${label} — budget ${budgetMs} ms:`);
  runs.forEach((ms, i) => console.log(`  run ${i + 1}: ${ms.toFixed(3)} ms`));
  const best = Math.min(...runs);
  const pass = best < budgetMs;
  console.log(`  best of 5: ${best.toFixed(3)} ms — ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

assertSchemaInSync();

const tempDir = await mkdtemp(join(tmpdir(), 'tide-perf-gate-'));
let db;
let ok = true;
try {
  db = new Database(join(tempDir, 'sessions-v2.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  seed(db);

  // Exact SQL from listSessions' no-cursor branch; limit 50 + 1 lookahead row.
  const listStmt = db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM session
     WHERE workspace_path = ? AND archived_at IS NULL
     ORDER BY time_updated DESC, id DESC LIMIT ?`,
  );
  ok = measure('gate 1: list sessions (no cursor)', LIST_BUDGET_MS, () => listStmt.all(WORKSPACE, 51)) && ok;

  // Window fetch from sessionMessages: newest 50 message ids, then parts per
  // message — timed as one operation, that is what the renderer waits on.
  const idsStmt = db.prepare('SELECT id FROM message WHERE session_id = ? ORDER BY id DESC LIMIT ?');
  const partsStmt = db.prepare('SELECT id, seq, kind, data FROM part WHERE message_id = ? ORDER BY seq');
  ok = measure('gate 2: message window fetch (50 messages)', WINDOW_BUDGET_MS, () => {
    const ids = idsStmt.all(MAIN_SESSION, WINDOW_SIZE);
    for (const { id } of ids) partsStmt.all(id);
  }) && ok;
} finally {
  db?.close();
  await rm(tempDir, { recursive: true, force: true });
}

console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}`);
process.exitCode = ok ? 0 : 1;
