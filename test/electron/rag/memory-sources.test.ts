import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mirrors memory.test.ts isolation idioms: mocked electron/appPaths,
// workspace + config stores, embedder; real SQLite + sqlite-vec stores.
const userDataDir = vi.hoisted(() => ({ current: '' as string }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir.current) },
}));

vi.mock('../../../electron/appPaths.js', () => ({
  appDataDir: () => userDataDir.current,
}));

const { listWorkspacesMock, listRagEnabledWorkspacesMock } = vi.hoisted(() => ({
  listWorkspacesMock: vi.fn(() => [] as Array<{ id: string; ragConfig?: unknown }>),
  listRagEnabledWorkspacesMock: vi.fn((): string[] => []),
}));
vi.mock('../../../electron/store.js', () => ({
  listWorkspaces: listWorkspacesMock,
  listRagEnabledWorkspaces: listRagEnabledWorkspacesMock,
}));

const { isRagCloudConfiguredMock } = vi.hoisted(() => ({
  isRagCloudConfiguredMock: vi.fn(() => false),
}));
vi.mock('../../../electron/agent/system-model.js', () => ({
  isRagCloudConfigured: isRagCloudConfiguredMock,
}));

const { embedMock } = vi.hoisted(() => ({
  embedMock: vi.fn(async (texts: string[]) =>
    texts.map(() => new Array(384).fill(0)),
  ),
}));
vi.mock('../../../electron/rag/local-onnx-embedder.js', () => ({
  LocalOnnxEmbedder: vi.fn(function () {
    return { id: 'local-code-512', dim: 384, maxTokens: 512, embed: embedMock, isAvailable: () => true };
  }),
  localModelExists: vi.fn(() => true),
}));

import { runMemory } from '../../../electron/agent/tools/memory.js';
import { openRagStore, type ChunkRow } from '../../../electron/rag/store.js';
import { openKnowledgeStore } from '../../../electron/knowledge/store.js';

const WS = 'ws-memory-sources';
const RAG_CONFIG = {
  embedderId: 'local-code-512',
  dim: 384,
  cloudAllowed: false,
  chunkTokens: 384,
};

function oneHot(i: number): number[] {
  const v = new Array(384).fill(0);
  v[i] = 1;
  return v;
}

function seedWorkspace(chunks: ChunkRow[], vectors: number[][]): void {
  const store = openRagStore(WS);
  store.setMeta('embedderId', 'local-code-512');
  store.setMeta('lastIngestedAt', String(Date.now()));
  const rowids = store.upsertChunks(chunks);
  store.upsertVectors(
    rowids.map((r, i) => ({ rowid: r.rowid, chunkId: r.id, embedding: vectors[i] })),
  );
  store.close();
}

function seedKnowledge(input: {
  name: string;
  enabledWorkspaceIds?: string[];
  embedderId?: string;
  chunks: Array<{ id: string; content: string; origin: string; vector: number[] }>;
}): void {
  const ks = openKnowledgeStore();
  const src = ks.addSource({
    name: input.name,
    kind: 'url',
    location: `https://example.com/${input.name}`,
  });
  if (input.enabledWorkspaceIds) ks.setEnabled(src.id, input.enabledWorkspaceIds);
  const rowids = ks.rag.upsertChunks(
    input.chunks.map((c) => ({
      id: c.id,
      path: c.origin,
      symbol: '',
      content: c.content,
      contentHash: `hash-${c.id}`,
      startLine: 0,
      endLine: 0,
      embedderId: input.embedderId ?? 'local-code-512',
      createdAt: 1234567890,
      sourceId: src.id,
    })),
  );
  ks.rag.upsertVectors(
    rowids.map((r, i) => ({ rowid: r.rowid, chunkId: r.id, embedding: input.chunks[i].vector })),
  );
  ks.rag.setMeta('embedderId', input.embedderId ?? 'local-code-512');
  ks.close();
}

describe('runMemory — knowledge sources fusion', () => {
  beforeEach(() => {
    userDataDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-memory-sources-'));
    listWorkspacesMock.mockReturnValue([{ id: WS, ragConfig: RAG_CONFIG }]);
    listRagEnabledWorkspacesMock.mockReturnValue([WS]);
    isRagCloudConfiguredMock.mockReturnValue(false);
    embedMock.mockClear();
    embedMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => new Array(384).fill(0)),
    );
  });

  it('fuses workspace and knowledge hits with the exact-match hit first regardless of store', async () => {
    seedKnowledge({
      name: 'React Docs',
      enabledWorkspaceIds: ['*'],
      chunks: [{
        id: 'k-rsc',
        content: 'server components stream html rendering on the server',
        origin: 'react.dev/reference/rsc',
        vector: oneHot(10),
      }],
    });
    seedWorkspace(
      [mkChunk({ id: 'w-ci', content: 'configure deployment notes for ci' })],
      [new Array(384).fill(0)],
    );

    embedMock.mockResolvedValueOnce([oneHot(10)]);
    const result = await runMemory('server components rendering', 5, WS);

    expect(result.status).toBe('executed');
    expect(result.output).toContain('[React Docs] react.dev/reference/rsc');
    expect(result.output).toContain('configure deployment notes');
    expect(result.output).toContain('out of 2');
  });

  it('ranks the exact vector+FTS match first via RRF even when it comes from the knowledge index', async () => {
    seedKnowledge({
      name: 'React Docs',
      enabledWorkspaceIds: ['*'],
      chunks: [
        {
          id: 'k-exact',
          content: 'server components rendering streams html on the server',
          origin: 'react.dev/reference/rsc',
          vector: oneHot(10),
        },
        {
          id: 'k-weak',
          content: 'server components conceptual overview page',
          origin: 'react.dev/learn/components',
          vector: new Array(384).fill(0),
        },
      ],
    });

    embedMock.mockResolvedValueOnce([oneHot(10)]);
    const result = await runMemory('server components rendering', 5, WS);

    expect(result.status).toBe('executed');
    // k-exact matches both signals (RRF score 2/(60+i)); k-weak only one.
    const exactPos = result.output.indexOf('react.dev/reference/rsc');
    const weakPos = result.output.indexOf('react.dev/learn/components');
    expect(exactPos).toBeGreaterThan(-1);
    expect(weakPos).toBeGreaterThan(-1);
    expect(exactPos).toBeLessThan(weakPos);
    expect(result.output).toMatch(/^\[1\] \[React Docs\]/m);
  });

  it('filters knowledge hits to sources enabled for the current workspace', async () => {
    seedKnowledge({
      name: 'Shared Docs',
      enabledWorkspaceIds: ['*'],
      chunks: [{
        id: 'k-on',
        content: 'alpha quantum flux capacitor manual',
        origin: 'docs.example/quantum',
        vector: new Array(384).fill(0),
      }],
    });
    seedKnowledge({
      name: 'Private Docs',
      enabledWorkspaceIds: ['other-ws'],
      chunks: [{
        id: 'k-off',
        content: 'beta graviton coil assembly guide',
        origin: 'docs.example/graviton',
        vector: new Array(384).fill(0),
      }],
    });
    seedWorkspace(
      [mkChunk({ id: 'w-note', content: 'team scratchpad about sprint planning' })],
      [new Array(384).fill(0)],
    );

    const result = await runMemory('quantum flux graviton coil', 5, WS);

    expect(result.status).toBe('executed');
    // Assert on origin paths, not content words — the header echoes the query verbatim.
    expect(result.output).toContain('[Shared Docs] docs.example/quantum');
    expect(result.output).not.toContain('docs.example/graviton');
    expect(result.output).not.toContain('[Private Docs]');
  });

  it('returns workspace-only results without error when the knowledge db does not exist', async () => {
    seedWorkspace(
      [mkChunk({ id: 'w-auth', content: 'auth token refresh logic lives here' })],
      [oneHot(3)],
    );
    const knowledgeDb = path.join(userDataDir.current, 'knowledge', 'index.db');

    embedMock.mockResolvedValueOnce([oneHot(3)]);
    const result = await runMemory('auth token refresh', 5, WS);

    expect(result.status).toBe('executed');
    expect(result.output).toContain('auth token refresh logic');
    // No knowledge side effect: the query must not create the global db.
    expect(fs.existsSync(knowledgeDb)).toBe(false);
  });

  it('silently skips knowledge hits when the knowledge index was built by a different embedder', async () => {
    seedKnowledge({
      name: 'Old Embedder Docs',
      enabledWorkspaceIds: ['*'],
      embedderId: 'cloud-base',
      chunks: [{
        id: 'k-old',
        content: 'zeta hyperdrive motivator schematics',
        origin: 'docs.example/hyperdrive',
        vector: oneHot(7),
      }],
    });
    seedWorkspace(
      [mkChunk({ id: 'w-auth', content: 'auth token refresh logic lives here' })],
      [oneHot(3)],
    );

    embedMock.mockResolvedValueOnce([oneHot(3)]);
    const result = await runMemory('hyperdrive zeta auth token refresh', 5, WS);

    expect(result.status).toBe('executed');
    expect(result.output).toContain('auth token refresh logic');
    expect(result.output).not.toContain('docs.example/hyperdrive');
    expect(result.output).not.toContain('[Old Embedder Docs]');
  });

  it('still searches knowledge sources when the workspace index is empty', async () => {
    seedKnowledge({
      name: 'Getting Started',
      enabledWorkspaceIds: ['*'],
      chunks: [{
        id: 'k-intro',
        content: 'onboarding checklist covers provisioning and access requests',
        origin: 'wiki.example/onboarding',
        vector: oneHot(5),
      }],
    });

    embedMock.mockResolvedValueOnce([oneHot(5)]);
    const result = await runMemory('onboarding provisioning access', 5, WS);

    expect(result.status).toBe('executed');
    expect(result.output).toContain('[Getting Started] wiki.example/onboarding');
  });

  it('searches knowledge sources even when RAG is disabled for the workspace', async () => {
    listRagEnabledWorkspacesMock.mockReturnValue([]);
    seedKnowledge({
      name: 'Handbook',
      enabledWorkspaceIds: ['*'],
      chunks: [{
        id: 'k-hb',
        content: 'expense reports are submitted through the finance portal',
        origin: 'wiki.example/expenses',
        vector: oneHot(9),
      }],
    });

    embedMock.mockResolvedValueOnce([oneHot(9)]);
    const result = await runMemory('expense report submission finance portal', 5, WS);

    expect(result.status).toBe('executed');
    expect(result.output).toContain('[Handbook] wiki.example/expenses');
  });
});

function mkChunk(overrides: Partial<ChunkRow>): ChunkRow {
  return {
    id: overrides.id ?? 'c1',
    path: overrides.path ?? '/repo/foo.ts',
    symbol: overrides.symbol ?? '',
    content: overrides.content ?? 'function add(a, b) { return a + b; }',
    contentHash: overrides.contentHash ?? 'hash-1',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 1,
    embedderId: 'local-code-512',
    createdAt: 1234567890,
    ...overrides,
  };
}
