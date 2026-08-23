import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, BrowserWindow } from 'electron';
import { openKnowledgeStore } from '../../../electron/knowledge/store.js';
import { registerSourcesHandlers } from '../../../electron/ipc/sources.js';
import type { Embedder } from '../../../electron/rag/embedder.js';
import type { SourceDocument, SourceProgressEvent } from '../../../electron/knowledge/types.js';

function hashEmbedder(): Embedder {
  return {
    id: 'local-code-512',
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

type Handler = (...args: unknown[]) => unknown;

/** Handlers accumulate across registrations/tests — always take the LAST one.
 *  Wraps the raw handler to prepend the ipcMain event argument. */
function handlerFor(channel: string): Handler {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.filter(
    (c: unknown[]) => c[0] === channel,
  );
  if (calls.length === 0) throw new Error(`no handler registered for ${channel}`);
  const raw = calls[calls.length - 1][1] as Handler;
  return (...args: unknown[]) => raw({}, ...args);
}

let tmp: string;
let sent: Array<{ channel: string; payload: SourceProgressEvent }>;
let sendMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-sources-ipc-'));
  sendMock = vi.fn((_channel: string, payload: SourceProgressEvent) => {
    sent.push({ channel: _channel, payload });
  });
  sent = [];
  (BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>).mockReturnValue([
    { webContents: { send: sendMock } },
  ]);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Registration {
  dbPath: string;
  fetchers?: Record<string, (...args: unknown[]) => Promise<SourceDocument[]>>;
}

function registerWith(opts: Registration = {}): void {
  registerSourcesHandlers({
    dbPath: opts.dbPath ?? path.join(tmp, 'knowledge', 'index.db'),
    embedder: hashEmbedder,
    fetchers: {
      url: async (location: string): Promise<SourceDocument[]> => [
        { title: location, origin: 'stub.example.com/page', content: 'Paragraph one.\n\nParagraph two with more words for chunking.' },
      ],
      docs: async (): Promise<SourceDocument[]> => [],
      ...opts.fetchers,
    },
    listWorkspaces: () => ['ws-1', 'ws-2'],
  });
}

describe('tide:sources ipc handlers', () => {
  it('add enqueues the job, lands idle with chunks, and pushes progress', async () => {
    registerWith();

    const result = (await handlerFor('tide:sources:add')('React Docs', 'url', 'https://react.dev')) as { ok: boolean; id?: string; error?: string };
    expect(result.ok).toBe(true);
    expect(result.id).toBeTruthy();

    const ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    const src = ks.getSource(result.id!);
    expect(src?.status).toBe('idle');
    expect(src?.chunkCount).toBeGreaterThan(0);
    expect(src?.lastIndexedAt).toBeGreaterThan(0);
    const chunks = ks.rag.chunksBySource(result.id!);
    expect(chunks.length).toBeGreaterThan(0);
    ks.close();

    const phases = sent.map((s) => s.payload.phase);
    expect(sent.every((s) => s.channel === 'tide:sources:progress')).toBe(true);
    expect(phases).toContain('fetching');
    expect(phases).toContain('done');
  });

  it('observes queued → indexing while the job is gated, then idle', async () => {
    let releaseFetch!: () => void;
    const gated = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    registerWith({
      dbPath,
      fetchers: {
        url: async () => {
          await gated;
          return [{ title: 'G', origin: 'gated.example.com', content: 'Some content here.' }];
        },
      },
    });

    const pending = handlerFor('tide:sources:add')('Gated', 'url', 'https://gated.example.com') as Promise<unknown>;
    const ks = openKnowledgeStore(dbPath);
    const srcId = ks.listSources()[0]?.id;
    expect(srcId).toBeTruthy();
    // Poll until the queue starts the job (fetch is blocked inside it).
    await vi.waitFor(() => {
      expect(ks.getSource(srcId!)?.status).toBe('indexing');
    });

    releaseFetch();
    await pending;
    expect(ks.getSource(srcId!)?.status).toBe('idle');
    ks.close();
  });

  it('list returns sources plus per-workspace enabled ids', async () => {
    registerWith();
    await (handlerFor('tide:sources:add')('A', 'url', 'https://a') as Promise<unknown>);
    const noWs = (await handlerFor('tide:sources:list')(undefined)) as { sources: unknown[]; enabledSourceIds: string[] };
    expect(noWs.sources).toHaveLength(1);
    expect(noWs.enabledSourceIds).toEqual([]); // no workspace → nothing resolved

    const scoped = (await handlerFor('tide:sources:list')('ws-7')) as { sources: unknown[]; enabledSourceIds: string[] };
    expect(scoped.enabledSourceIds).toHaveLength(1); // '*' resolves for any workspace
  });

  it('reindex enqueues via manager and refreshes lastIndexedAt', async () => {
    registerWith();
    const added = (await handlerFor('tide:sources:add')('R', 'url', 'https://r')) as { ok: boolean; id: string };
    const firstAt = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db')).getSource(added.id)?.lastIndexedAt ?? 0;

    await new Promise((r) => setTimeout(r, 5));
    const res = (await handlerFor('tide:sources:reindex')(added.id)) as { ok: boolean };
    expect(res.ok).toBe(true);
    const secondAt = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db')).getSource(added.id)?.lastIndexedAt ?? 0;
    expect(secondAt).toBeGreaterThanOrEqual(firstAt);
  });

  it('update persists name/location patches and rejects unknown ids', async () => {
    registerWith();
    const added = (await handlerFor('tide:sources:add')('Old', 'url', 'https://old')) as { ok: boolean; id: string };

    const res = (await handlerFor('tide:sources:update')(added.id, { name: 'New Name', location: 'https://new' })) as { ok: boolean };
    expect(res.ok).toBe(true);
    const ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    expect(ks.getSource(added.id)).toMatchObject({ name: 'New Name', location: 'https://new' });
    ks.close();

    const missing = (await handlerFor('tide:sources:update')('nope', { name: 'X' })) as { ok: boolean; error?: string };
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('unknown knowledge source');
  });

  it('setEnabled persists per-workspace enablement (expands * when disabling)', async () => {
    registerWith();
    const added = (await handlerFor('tide:sources:add')('T', 'url', 'https://t')) as { ok: boolean; id: string };
    const dbPath = path.join(tmp, 'knowledge', 'index.db');

    const off = (await handlerFor('tide:sources:setEnabled')(added.id, 'ws-2', false)) as { ok: boolean };
    expect(off.ok).toBe(true);
    let ks = openKnowledgeStore(dbPath);
    expect(ks.getSource(added.id)?.enabledWorkspaceIds).toEqual(['ws-1']);
    ks.close();

    const on = (await handlerFor('tide:sources:setEnabled')(added.id, 'ws-2', true)) as { ok: boolean };
    expect(on.ok).toBe(true);
    ks = openKnowledgeStore(dbPath);
    expect(ks.getSource(added.id)?.enabledWorkspaceIds).toEqual(['ws-1', 'ws-2']);
    ks.close();

    const bad = (await handlerFor('tide:sources:setEnabled')('ghost', 'ws-2', true)) as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
  });

  it('remove purges the registry row and cascades chunk deletion', async () => {
    registerWith();
    const added = (await handlerFor('tide:sources:add')('Doomed', 'url', 'https://doomed')) as { ok: boolean; id: string };
    let ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    expect(ks.rag.chunksBySource(added.id!).length).toBeGreaterThan(0);
    ks.close();

    const res = (await handlerFor('tide:sources:remove')(added.id)) as { ok: boolean };
    expect(res.ok).toBe(true);

    ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    expect(ks.listSources()).toHaveLength(0);
    expect(ks.rag.chunkCount()).toBe(0);
    ks.close();
  });

  it('add rejects duplicate kind+location and points at the existing id', async () => {
    registerWith();
    const first = (await handlerFor('tide:sources:add')('A', 'url', 'https://dup')) as { ok: boolean; id: string };
    expect(first.ok).toBe(true);

    const second = (await handlerFor('tide:sources:add')('B', 'url', 'https://dup')) as { ok: boolean; error?: string; id?: string };
    expect(second.ok).toBe(false);
    expect(second.error).toContain('already exists');
    expect(second.id).toBe(first.id);

    const ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    expect(ks.listSources()).toHaveLength(1);
    ks.close();
  });

  it('setEnabled rejects invalid arguments before touching the store', async () => {
    registerWith();
    const added = (await handlerFor('tide:sources:add')('V', 'url', 'https://v')) as { ok: boolean; id: string };

    const badEnabled = (await handlerFor('tide:sources:setEnabled')(added.id, 'ws-2', 'yes')) as { ok: boolean };
    const emptyWs = (await handlerFor('tide:sources:setEnabled')(added.id, '   ', true)) as { ok: boolean };
    const emptyId = (await handlerFor('tide:sources:setEnabled')('', 'ws-2', true)) as { ok: boolean };
    expect(badEnabled.ok).toBe(false);
    expect(emptyWs.ok).toBe(false);
    expect(emptyId.ok).toBe(false);

    const ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    expect(ks.getSource(added.id)?.enabledWorkspaceIds).toEqual(['*']);
    ks.close();
  });

  it('update with a location edit triggers an automatic reindex; name-only does not', async () => {
    let fetchCalls = 0;
    registerWith({
      fetchers: {
        url: async (): Promise<SourceDocument[]> => {
          fetchCalls += 1;
          return [{ title: 'F', origin: 'fetched.example.com', content: 'Fresh content.' }];
        },
      },
    });
    const added = (await handlerFor('tide:sources:add')('E', 'url', 'https://e1')) as { ok: boolean; id: string };
    expect(fetchCalls).toBe(1);

    const renameOnly = (await handlerFor('tide:sources:update')(added.id, { name: 'Renamed' })) as { ok: boolean };
    expect(renameOnly.ok).toBe(true);
    expect(fetchCalls).toBe(1);

    const relayout = (await handlerFor('tide:sources:update')(added.id, { location: 'https://e2' })) as { ok: boolean };
    expect(relayout.ok).toBe(true);
    expect(fetchCalls).toBe(2);

    const ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    expect(ks.getSource(added.id)).toMatchObject({ name: 'Renamed', location: 'https://e2', status: 'idle' });
    ks.close();
  });

  it('a throwing fetcher surfaces status=error and a failed progress push', async () => {
    registerWith({
      fetchers: {
        url: async () => {
          throw new Error('network down');
        },
      },
    });
    const added = (await handlerFor('tide:sources:add')('Bad', 'url', 'https://bad')) as { ok: boolean; id?: string };
    expect(added.ok).toBe(true);

    const ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    const src = ks.getSource(added.id!);
    expect(src?.status).toBe('error');
    expect(src?.error).toBe('network down');
    ks.close();
    expect(sent.some((s) => s.payload.phase === 'failed' && s.payload.sourceId === added.id)).toBe(true);
  });

  it('recoverStale at registration resolves crash-leftover statuses to idle', async () => {
    const dbPath = path.join(tmp, 'knowledge', 'index.db');
    const seed = openKnowledgeStore(dbPath);
    const stuck = seed.addSource({ name: 'Stuck', kind: 'url', location: 'https://stuck' });
    seed.markStatus(stuck.id, 'queued');
    seed.close();

    registerWith({ dbPath });

    const ks = openKnowledgeStore(dbPath);
    expect(ks.getSource(stuck.id)?.status).toBe('idle');
    ks.close();
  });

  it('add rejects empty input and unsupported kinds without touching the db', async () => {
    registerWith();
    const noName = (await handlerFor('tide:sources:add')('', 'url', 'https://x')) as { ok: boolean };
    const noLoc = (await handlerFor('tide:sources:add')('N', 'url', '   ')) as { ok: boolean };
    const badKind = (await handlerFor('tide:sources:add')('N', 'ftp', 'ftp://x')) as { ok: boolean; error?: string };
    expect(noName.ok).toBe(false);
    expect(noLoc.ok).toBe(false);
    expect(badKind.ok).toBe(false);

    const ks = openKnowledgeStore(path.join(tmp, 'knowledge', 'index.db'));
    expect(ks.listSources()).toHaveLength(0);
    ks.close();
  });
});
