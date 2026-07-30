import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Mocks ────────────────────────────────────────────────────────────
// The pipeline reaches into four runtime surfaces we don't want exercised
// in a unit test: the embedder (slow, model-load), the workspace store
// (electron-bound), the system-model (env-dependent), and Electron's
// app.getPath for the index.db location. Each is mocked per-test using
// a fresh temp dir.

const userDataDir = vi.hoisted(() => ({ current: '' as string }));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir.current) },
}));

const { embedMock, LocalOnnxMock, localModelExistsMock } = vi.hoisted(() => {
  const embedMock = vi.fn(async (texts: string[]) =>
    texts.map((_, i) => {
      // Deterministic 384-dim vector per batch index — tests rely on the
      // store accepting it but not on the values themselves.
      const v = new Array(384).fill(0);
      v[0] = (i + 1) / 10;
      return v;
    }),
  );
  const LocalOnnxMock = vi.fn(function () {
    return { embed: embedMock };
  });
  const localModelExistsMock = vi.fn((): boolean => true);
  return { embedMock, LocalOnnxMock, localModelExistsMock };
});

vi.mock('../../rag/local-onnx-embedder.js', () => ({
  LocalOnnxEmbedder: LocalOnnxMock,
  localModelExists: localModelExistsMock,
  __esModule: true,
}));

const { listWorkspacesMock, isRagCloudConfiguredMock } = vi.hoisted(() => ({
  listWorkspacesMock: vi.fn(() => [] as Array<{ id: string; path: string; ragConfig?: unknown }>),
  isRagCloudConfiguredMock: vi.fn(() => false),
}));

vi.mock('../../store.js', () => ({ listWorkspaces: listWorkspacesMock }));
vi.mock('../../agent/system-model.js', () => ({
  isRagCloudConfigured: isRagCloudConfiguredMock,
}));

// ── Fixture: a tiny workspace on disk ───────────────────────────────
let workspacePath: string;
let workspaceId: string;

beforeAll(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-ingest-ws-'));
  workspaceId = path.basename(workspacePath);
  // Two TS files with different symbols — exercises multi-file batching
  // and per-chunk contentHash dedupe.
  fs.writeFileSync(
    path.join(workspacePath, 'a.ts'),
    [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function sub(a: number, b: number): number {',
      '  return a - b;',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(workspacePath, 'b.ts'),
    [
      'export const VERSION = "1.0.0";',
      '',
      'export class Calculator {',
      '  base: number;',
      '  constructor(b: number) { this.base = b; }',
      '  add(x: number): number { return this.base + x; }',
      '}',
    ].join('\n'),
  );
  // A non-source file (skipped during walk) and a node_modules dir
  // (skipped per SKIP_DIRS).
  fs.writeFileSync(path.join(workspacePath, 'README.md'), '# hello');
  fs.mkdirSync(path.join(workspacePath, 'node_modules'));
  fs.writeFileSync(
    path.join(workspacePath, 'node_modules', 'hidden.ts'),
    'export const sneaky = 1;',
  );
});

afterAll(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('ingestWorkspace', () => {
  beforeEach(() => {
    userDataDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rag-userdata-'));
    listWorkspacesMock.mockReturnValue([
      { id: workspaceId, path: workspacePath, ragConfig: undefined },
    ]);
    embedMock.mockClear();
    localModelExistsMock.mockReturnValue(true);
    isRagCloudConfiguredMock.mockReturnValue(false);
  });

  it('chunks both files, embeds all chunks, and writes them to the store', async () => {
    const { ingestWorkspace } = await import('../../rag/ingest.js');
    const { openRagStore } = await import('../../rag/store.js');

    const result = await ingestWorkspace(workspaceId);
    expect(result.filesSeen).toBe(2); // a.ts + b.ts (README + node_modules skipped)
    expect(result.chunksTotal).toBeGreaterThan(2); // add, sub, VERSION, Calculator
    expect(result.chunksEmbedded).toBe(result.chunksTotal);
    expect(result.chunksSkipped).toBe(0);

    // Embedder was called at least once, with actual chunk text.
    expect(embedMock).toHaveBeenCalled();
    const firstCall = embedMock.mock.calls[0][0] as string[];
    expect(firstCall.length).toBeGreaterThan(0);
    expect(firstCall.some((t) => t.includes('add'))).toBe(true);

    // Store has all the chunks + a lastIngestedAt marker.
    const store = openRagStore(workspaceId);
    expect(store.chunkCount()).toBe(result.chunksTotal);
    expect(store.getMeta('lastIngestedAt')).toBeDefined();
    expect(store.getMeta('embedderId')).toBe('local-code-512');
    // FTS works.
    const hits = store.queryByFts('Calculator', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.symbol === 'Calculator')).toBe(true);
    store.close();
  }, 30_000);

  it('re-ingest skips chunks whose contentHash is unchanged (no re-embed)', async () => {
    const { ingestWorkspace } = await import('../../rag/ingest.js');

    const first = await ingestWorkspace(workspaceId);
    const firstEmbedCount = embedMock.mock.calls.length;

    const second = await ingestWorkspace(workspaceId);
    expect(second.chunksSkipped).toBe(first.chunksTotal);
    expect(second.chunksEmbedded).toBe(0);

    // No new embed calls on the second run.
    expect(embedMock.mock.calls.length).toBe(firstEmbedCount);
  }, 30_000);

  it('emits progress events for each phase + per batch', async () => {
    const { ingestWorkspace } = await import('../../rag/ingest.js');
    const events: { phase: string; chunksEmbedded: number }[] = [];
    await ingestWorkspace(workspaceId, {
      onProgress: (e) => events.push({ phase: e.phase, chunksEmbedded: e.chunksEmbedded }),
    });
    const phases = events.map((e) => e.phase);
    expect(phases).toContain('walking');
    expect(phases).toContain('chunking');
    expect(phases).toContain('embedding');
    expect(phases.at(-1)).toBe('done');
  }, 30_000);

  it('throws when the workspace is unknown', async () => {
    const { ingestWorkspace } = await import('../../rag/ingest.js');
    await expect(ingestWorkspace('nonexistent-ws')).rejects.toThrow(/not found/);
  });
});
