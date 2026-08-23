/** Knowledge source registry CRUD on top of the shared global index db.
 *  Reuses RagStore for chunks/vectors and owns a sibling `sources` table
 *  created idempotently here (not in migrate(), which stays workspace-only). */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import { appDataDir } from '../appPaths.js';
import { openRagStoreAt, type RagStore } from '../rag/store.js';
import type { KnowledgeSource, SourceKind } from './types.js';

export function knowledgeDbPath(): string {
  return path.join(appDataDir(), 'knowledge', 'index.db');
}

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  location: string;
  createdAt: number;
  lastIndexedAt: number | null;
  status: string;
  error: string | null;
  chunkCount: number;
  embedderId: string | null;
  enabledWorkspaceIds: string;
}

function rowToSource(r: SourceRow): KnowledgeSource {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as SourceKind,
    location: r.location,
    createdAt: r.createdAt,
    lastIndexedAt: r.lastIndexedAt,
    status: r.status as KnowledgeSource['status'],
    error: r.error,
    chunkCount: r.chunkCount,
    embedderId: r.embedderId,
    enabledWorkspaceIds: JSON.parse(r.enabledWorkspaceIds) as string[],
  };
}

export class KnowledgeStore {
  constructor(private readonly db: DB, private readonly rag: RagStore) {}

  addSource(input: { name: string; kind: SourceKind; location: string }): KnowledgeSource {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sources(id, name, kind, location, createdAt, status, enabledWorkspaceIds)
         VALUES (?, ?, ?, ?, ?, 'idle', '["*"]')`,
      )
      .run(id, input.name, input.kind, input.location, Date.now());
    return this.getSource(id)!;
  }

  listSources(): KnowledgeSource[] {
    const rows = this.db.prepare('SELECT * FROM sources ORDER BY createdAt, id').all() as SourceRow[];
    return rows.map(rowToSource);
  }

  getSource(id: string): KnowledgeSource | null {
    const r = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as
      | SourceRow
      | undefined;
    return r ? rowToSource(r) : null;
  }

  setEnabled(id: string, ids: string[]): void {
    this.db
      .prepare('UPDATE sources SET enabledWorkspaceIds = ? WHERE id = ?')
      .run(JSON.stringify(ids), id);
  }

  markStatus(id: string, status: KnowledgeSource['status'], error?: string): void {
    // A successful index pass stamps lastIndexedAt on the transition back to idle.
    if (status === 'idle') {
      this.db
        .prepare("UPDATE sources SET status = 'idle', error = NULL, lastIndexedAt = ? WHERE id = ?")
        .run(Date.now(), id);
      return;
    }
    this.db
      .prepare('UPDATE sources SET status = ?, error = ? WHERE id = ?')
      .run(status, error ?? null, id);
  }

  setChunkCount(id: string, n: number): void {
    this.db.prepare('UPDATE sources SET chunkCount = ? WHERE id = ?').run(n, id);
  }

  deleteSource(id: string): void {
    this.rag.deleteChunks(this.rag.chunksBySource(id));
    this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  }

  enabledSourceIdsFor(workspaceId: string): string[] {
    const rows = this.db.prepare('SELECT id, enabledWorkspaceIds FROM sources').all() as {
      id: string;
      enabledWorkspaceIds: string;
    }[];
    return rows
      .filter((r) => {
        const ids = JSON.parse(r.enabledWorkspaceIds) as string[];
        return ids.includes('*') || ids.includes(workspaceId);
      })
      .map((r) => r.id);
  }

  close(): void {
    this.rag.close();
  }
}

export function openKnowledgeStore(dbPath: string = knowledgeDbPath()): KnowledgeStore {
  const rag = openRagStoreAt(dbPath);
  rag.runRaw(`CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    location TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    lastIndexedAt INTEGER,
    status TEXT NOT NULL DEFAULT 'idle',
    error TEXT,
    chunkCount INTEGER NOT NULL DEFAULT 0,
    embedderId TEXT,
    enabledWorkspaceIds TEXT NOT NULL DEFAULT '["*"]'
  )`);
  return new KnowledgeStore(rag.rawDb, rag);
}
