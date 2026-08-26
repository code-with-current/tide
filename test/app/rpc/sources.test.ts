import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const state = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../app/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/platform/paths')>();
  return { ...actual, appDataDir: () => state.dir };
});

import { registerSourcesRpc } from '../../../app/rpc/sources';
import { openKnowledgeStore } from '../../../app/core/knowledge/store.js';
import type { Embedder } from '../../../app/core/rag/embedder.js';
import type { SourceDocument, SourceProgressEvent } from '../../../app/core/knowledge/types.js';

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

let tmp: string;
let events: SourceProgressEvent[];
let dbPath: string;

interface RegisterOpts {
  fetchers?: Record<string, (location: string) => Promise<SourceDocument[]>>;
  listWorkspaces?: () => string[];
}

function registerWith(opts: RegisterOpts = {}): ReturnType<typeof registerSourcesRpc> {
  events = [];
  return registerSourcesRpc(
    { progress: (e) => events.push(e) },
    {
      dbPath,
      embedder: hashEmbedder,
      fetchers: {
        url: async (location: string): Promise<SourceDocument[]> => [
          { title: location, origin: 'stub.example.com/page', content: 'Paragraph one.\n\nParagraph two with more words for chunking.' },
        ],
        ...opts.fetchers,
      },
      listWorkspaces: opts.listWorkspaces ?? (() => ['ws-1', 'ws-2']),
    },
  );
}

/** Add resolves once the row is persisted; the first index pass runs in the
 *  background — poll until the source reaches the expected terminal status. */
function waitForStatus(id: string, status: string): Promise<void> {
  const ks = openKnowledgeStore(dbPath);
  return vi
    .waitFor(() => {
      expect(ks.getSource(id)?.status).toBe(status);
    })
    .finally(() => ks.close());
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rpc-sources-'));
  state.dir = path.join(tmp, 'appdata');
  fs.mkdirSync(state.dir, { recursive: true });
  dbPath = path.join(tmp, 'knowledge', 'index.db');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('registerSourcesRpc add + progress', () => {
  it('persists the row, indexes in the background, and pushes progress through the message slot', async () => {
    const rpc = registerWith();

    const res = await rpc.sourcesAdd({ name: 'React Docs', kind: 'url', location: 'https://react.dev' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.id).toBeTruthy();

    await waitForStatus(res.id!, 'idle');
    const ks = openKnowledgeStore(dbPath);
    const src = ks.getSource(res.id!);
    expect(src?.status).toBe('idle');
    expect(src?.chunkCount).toBeGreaterThan(0);
    expect(src?.lastIndexedAt).toBeGreaterThan(0);
    expect(ks.rag.chunksBySource(res.id!).length).toBeGreaterThan(0);
    ks.close();

    const phases = events.map((e) => e.phase);
    expect(phases).toContain('fetching');
    expect(phases).toContain('done');
    // Payload fidelity: the manager's SourceProgressEvent rides verbatim.
    const first = events[0]!;
    expect(first).toMatchObject({ sourceId: res.id, phase: 'fetching' });
    expect(typeof first.current).toBe('string');
  });

  it('validates input before touching the store', async () => {
    const rpc = registerWith();
    expect((await rpc.sourcesAdd({ name: '  ', kind: 'url', location: 'https://x.dev' })).error).toBe('name is required');
    expect((await rpc.sourcesAdd({ name: 'x', kind: 'pdf', location: 'https://x.dev' })).error).toMatch(/unsupported source kind/);
    expect((await rpc.sourcesAdd({ name: 'x', kind: 'url', location: '' })).error).toBe('location is required');
    expect((await rpc.sourcesAdd({ name: 'x', kind: 'url', location: 'https://x.dev', enabledWorkspaceIds: ['', 'ws-1'] })).error).toMatch(
      /enabledWorkspaceIds must be an array/,
    );
  });

  it('rejects a duplicate location for the same kind, echoing the existing id', async () => {
    const rpc = registerWith();
    const first = await rpc.sourcesAdd({ name: 'a', kind: 'url', location: 'https://dup.dev' });
    const dup = await rpc.sourcesAdd({ name: 'b', kind: 'url', location: 'https://dup.dev' });
    expect(dup.ok).toBe(false);
    expect(dup.id).toBe(first.id);
  });

  it('marks the row error + emits a failed event when the fetcher throws', async () => {
    const rpc = registerWith({
      fetchers: {
        url: async () => {
          throw new Error('dns gone');
        },
      },
    });
    const res = await rpc.sourcesAdd({ name: 'broken', kind: 'url', location: 'https://broken.dev' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await waitForStatus(res.id!, 'error');
    const ks = openKnowledgeStore(dbPath);
    expect(ks.getSource(res.id!)?.error).toMatch(/dns gone/);
    ks.close();
    expect(events).toContainEqual({ sourceId: res.id!, phase: 'failed', error: 'dns gone' });
  });
});

describe('registerSourcesRpc list + enablement', () => {
  it('lists sources and resolves "*" enablement per workspace', async () => {
    const rpc = registerWith();
    const added = await rpc.sourcesAdd({ name: 'shared', kind: 'url', location: 'https://shared.dev' });
    expect(added.ok).toBe(true);
    await waitForStatus(added.id!, 'idle');

    const all = rpc.sourcesList({ workspaceId: 'ws-1' });
    expect(all.error).toBeUndefined();
    expect(all.sources.some((s) => s.id === added.id)).toBe(true);
    expect(all.enabledSourceIds).toContain(added.id!);

    const noWs = rpc.sourcesList({});
    expect(noWs.enabledSourceIds).toEqual([]);
  });

  it('expands "*" on disable so the exclusion sticks for that workspace', async () => {
    const rpc = registerWith({ listWorkspaces: () => ['ws-1', 'ws-2'] });
    const added = await rpc.sourcesAdd({ name: 'expand', kind: 'url', location: 'https://expand.dev' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const off = rpc.sourcesSetEnabled({ id: added.id!, workspaceId: 'ws-1', enabled: false });
    expect(off.ok).toBe(true);
    const ks = openKnowledgeStore(dbPath);
    expect(ks.getSource(added.id!)?.enabledWorkspaceIds).toEqual(['ws-2']);
    ks.close();

    // Re-enable adds the id back without duplicating.
    expect(rpc.sourcesSetEnabled({ id: added.id!, workspaceId: 'ws-1', enabled: true }).ok).toBe(true);
    const ks2 = openKnowledgeStore(dbPath);
    expect(ks2.getSource(added.id!)?.enabledWorkspaceIds.sort()).toEqual(['ws-1', 'ws-2']);
    ks2.close();
  });

  it('refuses to disable the last workspace of a "*" source', async () => {
    const rpc = registerWith({ listWorkspaces: () => ['only-ws'] });
    const added = await rpc.sourcesAdd({ name: 'solo', kind: 'url', location: 'https://solo.dev' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const res = rpc.sourcesSetEnabled({ id: added.id!, workspaceId: 'only-ws', enabled: false });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no workspaces registered');
  });

  it('validates setEnabled arguments', async () => {
    const rpc = registerWith();
    expect(rpc.sourcesSetEnabled({ id: '', workspaceId: 'ws-1', enabled: true }).error).toBe('invalid source id');
    expect(rpc.sourcesSetEnabled({ id: 'x', workspaceId: ' ', enabled: true }).error).toBe('invalid workspace id');
    expect(rpc.sourcesSetEnabled({ id: 'x', workspaceId: 'ws-1', enabled: 1 as unknown as boolean }).error).toBe('enabled must be a boolean');
    expect(rpc.sourcesSetEnabled({ id: 'missing', workspaceId: 'ws-1', enabled: true }).error).toMatch(/unknown knowledge source/);
  });
});

describe('registerSourcesRpc update + reindex + remove', () => {
  it('reindexes when the location changes', async () => {
    const rpc = registerWith();
    const added = await rpc.sourcesAdd({ name: 'mover', kind: 'url', location: 'https://mover.dev/a' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await waitForStatus(added.id!, 'idle');
    events = [];

    expect((await rpc.sourcesUpdate({ id: added.id!, patch: { location: 'https://mover.dev/b' } })).ok).toBe(true);
    // enqueue resolves when the reindex job finishes — status back to idle.
    await waitForStatus(added.id!, 'idle');
    const ks = openKnowledgeStore(dbPath);
    expect(ks.getSource(added.id!)?.location).toBe('https://mover.dev/b');
    ks.close();
    expect(events.some((e) => e.phase === 'fetching')).toBe(true);
  });

  it('renames without triggering a reindex', async () => {
    const rpc = registerWith();
    const added = await rpc.sourcesAdd({ name: 'renamed', kind: 'url', location: 'https://rename.dev' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await waitForStatus(added.id!, 'idle');
    events = [];

    expect((await rpc.sourcesUpdate({ id: added.id!, patch: { name: 'new name' } })).ok).toBe(true);
    const ks = openKnowledgeStore(dbPath);
    expect(ks.getSource(added.id!)?.name).toBe('new name');
    ks.close();
    expect(events).toEqual([]);
  });

  it('update rejects unknown ids and bad enabledWorkspaceIds', async () => {
    const rpc = registerWith();
    expect((await rpc.sourcesUpdate({ id: 'nope', patch: { name: 'x' } })).error).toMatch(/unknown knowledge source/);
    expect(
      (await rpc.sourcesUpdate({ id: 'x', patch: { enabledWorkspaceIds: [42 as unknown as string] } })).error,
    ).toMatch(/enabledWorkspaceIds must be an array/);
  });

  it('reindex enqueues a fresh pass', async () => {
    const rpc = registerWith();
    const added = await rpc.sourcesAdd({ name: 're', kind: 'url', location: 'https://reindex.dev' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await waitForStatus(added.id!, 'idle');
    events = [];

    expect((await rpc.sourcesReindex({ id: added.id! })).ok).toBe(true);
    expect(events.some((e) => e.phase === 'fetching')).toBe(true);
    await waitForStatus(added.id!, 'idle');
  });

  it('removes the row and its chunks', async () => {
    const rpc = registerWith();
    const added = await rpc.sourcesAdd({ name: 'gone', kind: 'url', location: 'https://gone.dev' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await waitForStatus(added.id!, 'idle');

    expect((await rpc.sourcesRemove({ id: added.id! })).ok).toBe(true);
    const ks = openKnowledgeStore(dbPath);
    expect(ks.getSource(added.id!)).toBeNull();
    expect(ks.rag.chunksBySource(added.id!).length).toBe(0);
    ks.close();
    expect((await rpc.sourcesRemove({ id: added.id! })).ok).toBe(true);
  });
});
