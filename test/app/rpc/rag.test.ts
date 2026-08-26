import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// One temp app-data dir for the whole file: the workspace store and the
// per-workspace RAG indexes are module singletons that latch the first
// appDataDir they see, so a per-test dir would leave them pointing at
// deleted directories. Never the real ~/.tide / ~/.tide-dev.
const state = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../app/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/platform/paths')>();
  return { ...actual, appDataDir: () => state.dir };
});

// The downloader hits the network — mock it like the Electron ipc tests do.
const downloadModelMock = vi.hoisted(() => vi.fn(async () => '/fake/model/dir'));
vi.mock('../../../app/core/rag/model-downloader.js', () => ({ downloadModel: downloadModelMock }));

import { registerRagRpc } from '../../../app/rpc/rag';
import { setLocalEmbedderFactory } from '../../../app/core/rag/resolve.js';
import { MODEL_ID } from '../../../app/core/rag/embedder-process.js';
import * as store from '../../../app/core/store.js';
import type { Embedder } from '../../../app/core/rag/embedder.js';
import type { RagProgressMessage } from '../../../shared/rpc';

/** Deterministic fake local embedder — same id/dim/maxTokens as LOCAL_META so
 *  the resolver seam accepts it as the local embedder. */
function fakeLocalEmbedder(): Embedder & { calls: number } {
  const impl = {
    id: 'local-code-512' as const,
    dim: 384 as const,
    maxTokens: 512,
    calls: 0,
    async embed(texts: string[]) {
      impl.calls += texts.length;
      return texts.map(() => new Array<number>(384).fill(0.1));
    },
  };
  return impl;
}

let tmp: string;
let workspacePath: string;
const WORKSPACE_ID = 'ws-rag-rpc';
let messages: RagProgressMessage[];

function register(): ReturnType<typeof registerRagRpc> {
  messages = [];
  return registerRagRpc({ progress: (m) => messages.push(m) });
}

/** localModelExists() checks appDataDir/models/<MODEL_ID>/onnx/… — a marker
 *  file flips it without any real ONNX download/init. */
function createModelMarker(): void {
  fs.mkdirSync(path.join(state.dir, 'models', MODEL_ID, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(state.dir, 'models', MODEL_ID, 'onnx', 'model_quantized.onnx'), 'marker');
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rpc-rag-'));
  state.dir = path.join(tmp, 'appdata');
  fs.mkdirSync(state.dir, { recursive: true });

  workspacePath = path.join(tmp, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'util.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  );
  store.addWorkspace({
    id: WORKSPACE_ID,
    name: 'rag-rpc-fixture',
    path: workspacePath,
    branch: 'main',
    headCommit: '0'.repeat(40),
    isDefault: false,
    fileCount: 1,
    worktreeLocation: '.agent/worktrees',
    scripts: [],
  });
});

afterAll(() => {
  setLocalEmbedderFactory(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('registerRagRpc status', () => {
  it('returns state=no-index with enabled list for an unknown workspace', () => {
    createModelMarker();
    const rpc = register();
    const s = rpc.ragStatus({ workspaceId: 'missing' });
    expect(s).toMatchObject({ embedderId: null, state: 'no-index', chunkCount: 0, initState: 'never' });
    expect(s.enabledWorkspaces).toEqual([]);
  });

  it('reports ok + local embedder for a workspace once the model exists', () => {
    const rpc = register();
    const s = rpc.ragStatus({ workspaceId: WORKSPACE_ID });
    expect(s).toMatchObject({
      embedderId: 'local-code-512',
      localAvailable: true,
      state: 'ok',
      chunkCount: 0,
      initState: 'never',
    });
  });

  it('ragModelExists reflects the marker file', () => {
    const rpc = register();
    expect(rpc.ragModelExists({})).toBe(true);
  });
});

describe('registerRagRpc model download + enablement', () => {
  it('ragEnableWorkspace downloads when the model is missing, then enables', async () => {
    // Remove the marker so the download path runs (downloader is mocked).
    fs.rmSync(path.join(state.dir, 'models'), { recursive: true, force: true });
    downloadModelMock.mockClear();
    const rpc = register();
    expect(await rpc.ragEnableWorkspace({ workspaceId: WORKSPACE_ID })).toEqual({ ok: true });
    expect(downloadModelMock).toHaveBeenCalledTimes(1);
    expect(store.listRagEnabledWorkspaces()).toContain(WORKSPACE_ID);
  });

  it('ragEnableWorkspace surfaces the error and does NOT enable on download failure', async () => {
    store.removeRagEnabledWorkspace(WORKSPACE_ID);
    downloadModelMock.mockRejectedValueOnce(new Error('network down'));
    const rpc = register();
    const res = await rpc.ragEnableWorkspace({ workspaceId: WORKSPACE_ID });
    expect(res).toEqual({ ok: false, error: 'network down' });
    expect(store.listRagEnabledWorkspaces()).not.toContain(WORKSPACE_ID);
    // Exact failed-download progress payload the Electron shell pushed.
    expect(messages).toContainEqual({
      kind: 'download',
      event: { received: 0, total: 0, phase: 'failed', error: 'network down' },
    });
  });

  it('ragDisableWorkspace removes the workspace from the enabled list', () => {
    store.addRagEnabledWorkspace(WORKSPACE_ID);
    const rpc = register();
    expect(rpc.ragDisableWorkspace({ workspaceId: WORKSPACE_ID })).toEqual({ ok: true });
    expect(store.listRagEnabledWorkspaces()).not.toContain(WORKSPACE_ID);
  });
});

describe('registerRagRpc init (real ingest pipeline, fake embedder)', () => {
  it('runs ingest detached through the resolve seam and pushes init progress', async () => {
    createModelMarker();
    const fake = fakeLocalEmbedder();
    setLocalEmbedderFactory(() => fake);

    const rpc = register();
    const res = rpc.ragInitWorkspace({ workspaceId: WORKSPACE_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.startedAt).toBeGreaterThan(0);

    await vi.waitFor(() => {
      const done = messages.find(
        (m) => m.kind === 'init' && m.event.phase === 'done',
      );
      expect(done).toBeDefined();
    }, 10_000);

    // The fake local embedder rode the REAL resolveForBuild seam.
    expect(fake.calls).toBeGreaterThan(0);

    const initEvents = messages
      .filter((m): m is Extract<RagProgressMessage, { kind: 'init' }> => m.kind === 'init')
      .map((m) => m.event);
    const phases = initEvents.map((e) => e.phase);
    expect(phases).toContain('walking');
    expect(phases).toContain('chunking');
    expect(phases).toContain('embedding');
    // Payload fidelity: every event carries the workspace id and counters.
    for (const e of initEvents) {
      expect(e.workspaceId).toBe(WORKSPACE_ID);
      expect(typeof e.filesSeen).toBe('number');
      expect(typeof e.chunksTotal).toBe('number');
      expect(typeof e.chunksEmbedded).toBe('number');
    }

    // Status now reflects the completed ingest through the real index db.
    const s = rpc.ragStatus({ workspaceId: WORKSPACE_ID });
    expect(s).toMatchObject({ initState: 'done' });
    if ('chunkCount' in s) {
      expect(s.chunkCount).toBeGreaterThan(0);
      expect(s.lastIngestedAt).not.toBeNull();
    }
  }, 20_000);

  it('rejects a second init while the first is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: Embedder = {
      id: 'local-code-512',
      dim: 384,
      maxTokens: 512,
      async embed(texts) {
        await gate;
        return texts.map(() => new Array<number>(384).fill(0.1));
      },
    };
    setLocalEmbedderFactory(() => slow);

    const rpc = register();
    expect(rpc.ragInitWorkspace({ workspaceId: WORKSPACE_ID }).ok).toBe(true);
    const second = rpc.ragInitWorkspace({ workspaceId: WORKSPACE_ID });
    expect(second).toMatchObject({ ok: false });
    if (!second.ok) expect(second.error).toMatch(/already running/);

    release();
    await vi.waitFor(() => {
      expect(messages.some((m) => m.kind === 'init' && m.event.phase === 'done')).toBe(true);
    }, 10_000);
    // Once drained, a fresh init is accepted again (chunks dedup, embed may be skipped).
    expect(rpc.ragInitWorkspace({ workspaceId: WORKSPACE_ID }).ok).toBe(true);
    await vi.waitFor(() => {
      const inits = messages.filter((m) => m.kind === 'init' && m.event.phase === 'done');
      expect(inits.length).toBeGreaterThanOrEqual(2);
    }, 10_000);
  }, 20_000);

  it('pushes a failed init event when the embedder rejects', async () => {
    const broken: Embedder = {
      id: 'local-code-512',
      dim: 384,
      maxTokens: 512,
      async embed() {
        throw new Error('onnx exploded');
      },
    };
    setLocalEmbedderFactory(() => broken);

    // Touch a file so the workspace has a chunk to embed.
    fs.writeFileSync(path.join(workspacePath, 'second.ts'), 'export const x = 1;\n');

    const rpc = register();
    expect(rpc.ragInitWorkspace({ workspaceId: WORKSPACE_ID }).ok).toBe(true);
    await vi.waitFor(() => {
      expect(
        messages.some((m) => m.kind === 'init' && m.event.phase === 'failed'),
      ).toBe(true);
    }, 10_000);
    const failed = messages.find(
      (m): m is Extract<RagProgressMessage, { kind: 'init' }> =>
        m.kind === 'init' && m.event.phase === 'failed',
    )!;
    expect(failed.event.workspaceId).toBe(WORKSPACE_ID);
    expect(failed.event.error).toMatch(/onnx exploded/);
  }, 20_000);
});
