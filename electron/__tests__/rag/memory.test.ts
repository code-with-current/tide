import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock electron (app.getPath) and the workspace/config stores so the
// test can run fully in isolation — no real userData, no real workspace.
const userDataDir = vi.hoisted(() => ({ current: '' as string }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir.current) },
}));

const { listWorkspacesMock, listRagEnabledWorkspacesMock } = vi.hoisted(() => ({
  listWorkspacesMock: vi.fn(() => [] as Array<{ id: string; ragConfig?: unknown }>),
  listRagEnabledWorkspacesMock: vi.fn((): string[] => []),
}));
vi.mock('../../store.js', () => ({
  listWorkspaces: listWorkspacesMock,
  listRagEnabledWorkspaces: listRagEnabledWorkspacesMock,
}));

const { isRagCloudConfiguredMock } = vi.hoisted(() => ({
  isRagCloudConfiguredMock: vi.fn(() => false),
}));
vi.mock('../../agent/system-model.js', () => ({
  isRagCloudConfigured: isRagCloudConfiguredMock,
}));

// Mock the embedder — the resolver returns a fake embedder with
// deterministic vectors. Each chunk's vector is one-hot per the test
// setup; the query vector is set to match a known chunk.
const { embedMock } = vi.hoisted(() => ({
  embedMock: vi.fn(async (texts: string[]) =>
    texts.map(() => new Array(384).fill(0)),
  ),
}));
vi.mock('../../rag/local-onnx-embedder.js', () => ({
  LocalOnnxEmbedder: vi.fn(function () {
    return { id: 'local-code-512', dim: 384, maxTokens: 512, embed: embedMock, isAvailable: () => true };
  }),
  localModelExists: vi.fn(() => true),
}));

// DON'T mock the store — we want a real SQLite + sqlite-vec index.
// The test writes real chunks + vectors, then queries them.

import { runMemory } from '../../agent/tools/memory.js';
import { openRagStore, type ChunkRow } from '../../rag/store.js';

const WORKSPACE_ID = 'ws-memory-test';

function mkChunk(overrides: Partial<ChunkRow>): ChunkRow {
  return {
    id: overrides.id ?? 'c1',
    path: overrides.path ?? '/repo/foo.ts',
    symbol: overrides.symbol ?? 'add',
    content: overrides.content ?? 'function add(a, b) { return a + b; }',
    contentHash: overrides.contentHash ?? 'hash-1',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 1,
    embedderId: 'local-code-512',
    createdAt: 1234567890,
    ...overrides,
  };
}

describe('runMemory (memory tool)', () => {
  let store: ReturnType<typeof openRagStore>;

  beforeEach(() => {
    userDataDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-memory-test-'));
    listWorkspacesMock.mockReturnValue([
      { id: WORKSPACE_ID, ragConfig: { embedderId: 'local-code-512', dim: 384, cloudAllowed: false, chunkTokens: 384 } },
    ]);
    listRagEnabledWorkspacesMock.mockReturnValue([WORKSPACE_ID]);
    isRagCloudConfiguredMock.mockReturnValue(false);
    embedMock.mockClear();
    // Default: return a zero vector for any query (matches nothing strongly).
    embedMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => new Array(384).fill(0)),
    );

    store = openRagStore(WORKSPACE_ID);
    store.setMeta('embedderId', 'local-code-512');
    store.setMeta('lastIngestedAt', String(Date.now()));
  });

  it('returns an actionable hint when the workspace is not RAG-enabled', async () => {
    listRagEnabledWorkspacesMock.mockReturnValue([]);
    const result = await runMemory('anything', 5, WORKSPACE_ID);
    expect(result.status).toBe('executed');
    expect(result.output).toMatch(/RAG is not enabled/i);
  });

  it('returns a hint when the index is empty', async () => {
    // Store just opened — no chunks written.
    const result = await runMemory('anything', 5, WORKSPACE_ID);
    expect(result.status).toBe('executed');
    expect(result.output).toMatch(/empty/i);
  });

  it('returns matching chunks for a query when the index is populated', async () => {
    // Write 3 chunks with different content + one-hot vectors so the
    // query vector can be set to "match chunk 2".
    const rowids = store.upsertChunks([
      mkChunk({ id: 'auth', symbol: 'authenticate', content: 'export async function authenticate(token) { ... }' }),
      mkChunk({ id: 'user', symbol: 'User', content: 'export interface User { id: number; name: string; }' }),
      mkChunk({ id: 'math', symbol: 'add', content: 'export function add(a, b) { return a + b; }' }),
    ]);
    const v1 = new Array(384).fill(0); v1[0] = 1;
    const v2 = new Array(384).fill(0); v2[1] = 1;
    const v3 = new Array(384).fill(0); v3[2] = 1;
    store.upsertVectors([
      { rowid: rowids[0].rowid, chunkId: 'auth', embedding: v1 },
      { rowid: rowids[1].rowid, chunkId: 'user', embedding: v2 },
      { rowid: rowids[2].rowid, chunkId: 'math', embedding: v3 },
    ]);

    // Query vector closest to v2 → 'user' should rank first.
    const queryVec = new Array(384).fill(0); queryVec[1] = 1;
    embedMock.mockResolvedValueOnce([queryVec]);

    const result = await runMemory('user interface type', 5, WORKSPACE_ID);
    expect(result.status).toBe('executed');
    expect(result.output).toContain('user');
    // The top hit should mention the User interface.
    expect(result.output).toContain('User');
  });

  it('fails gracefully on empty query', async () => {
    const result = await runMemory('', 5, WORKSPACE_ID);
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/missing required arg/i);
  });

  it('fails gracefully on missing workspaceId', async () => {
    const result = await runMemory('query', 5, '');
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/no active workspace/i);
  });
});
