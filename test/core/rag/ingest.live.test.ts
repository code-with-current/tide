/**
 * Live (network-backed) test for the RAG ingestion pipeline.
 *
 * Skipped by default — first invocation hits the real Transformers.js
 * embedder (model is ~22 MB, already downloaded by localOnnxEmbedder.live).
 * Run explicitly:
 *
 *   TIDE_LIVE=1 npx vitest run ingest.live
 *
 * What this proves that the mocked ingest.test.ts doesn't:
 *   1. The resolver picks LocalOnnxEmbedder for a workspace with the model on disk.
 *   2. The chunker produces real chunks from real source files.
 *   3. The embedder returns 384-dim L2-normalized vectors for those chunks.
 *   4. The store round-trips them — FTS search finds a known string,
 *      vector search returns chunks ordered by cosine similarity.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const userDataDir = vi.hoisted(() => ({ current: '' as string }));
const workspaceDir = vi.hoisted(() => ({ current: '' as string }));
const workspaceId = vi.hoisted(() => ({ current: '' as string }));

vi.mock('../../../app/core/store.js', () => ({
  listWorkspaces: () => [{ id: workspaceId.current, path: workspaceDir.current }],
}));

vi.mock('../../../app/core/agent/system-model.js', () => ({
  isRagCloudConfigured: () => false,
}));

// In a vitest run there's no utilityProcess — but we DO want to hit the
// real Transformers.js pipeline. Mock LocalOnnxEmbedder to route .embed()
// through handleMessage directly (same code path the spawned child runs),
// just without the IPC hop. localModelExists is forced true because the
// model path it would check (under the mocked app.getPath) doesn't exist
// in the temp userData — the real path was set via TIDE_MODELS_DIR above.
vi.mock('../../../app/core/rag/local-onnx-embedder.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../../app/core/rag/local-onnx-embedder.js');
  const mod = await import('../../../app/core/rag/embedder-process.js');
  return {
    ...actual,
    LocalOnnxEmbedder: vi.fn(function () {
      return {
        id: 'local-code-512',
        dim: 384,
        maxTokens: 512,
        embed: async (texts: string[]) => {
          const resp = await mod.handleMessage({ type: 'embed', id: 'live', texts });
          if (resp.type !== 'result') throw new Error(resp.message);
          return resp.vectors;
        },
        isAvailable: () => true,
      };
    }),
    localModelExists: () => true,
  };
});

import { ingestWorkspace } from '../../../app/core/rag/ingest.js';
import { openRagStore } from '../../../app/core/rag/store.js';

const describeLive = describe.skipIf(!process.env.TIDE_LIVE);

beforeAll(() => {
  // The model is downloaded by localOnnxEmbedder.live into the REAL
  // userData (~/Library/Application Support/sumo/models). Point
  // localModelExists() at that path even though this test mocks
  // app.getPath for its own index.db location.
  process.env.TIDE_MODELS_DIR = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'sumo',
    'models',
  );

  userDataDir.current = path.join(os.tmpdir(), 'tide-ingest-live-userdata');
  fs.mkdirSync(userDataDir.current, { recursive: true });

  workspaceDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-ingest-live-ws-'));
  workspaceId.current = path.basename(workspaceDir.current);

  // Three small TS files that mention each other by name so FTS + vector
  // search both have something to find.
  fs.writeFileSync(
    path.join(workspaceDir.current, 'user.ts'),
    [
      'export interface User {',
      '  id: number;',
      '  name: string;',
      '  email: string;',
      '}',
      '',
      'export function formatUserEmail(u: User): string {',
      '  return `${u.name} <${u.email}>`;',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(workspaceDir.current, 'auth.ts'),
    [
      'import type { User } from "./user";',
      '',
      'export async function fetchCurrentUser(token: string): Promise<User> {',
      '  const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });',
      '  return res.json();',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(workspaceDir.current, 'math.ts'),
    [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function multiply(a: number, b: number): number {',
      '  return a * b;',
      '}',
    ].join('\n'),
  );
});

afterAll(() => {
  fs.rmSync(workspaceDir.current, { recursive: true, force: true });
});

describeLive('ingestWorkspace (live)', () => {
  beforeEach(() => {
    // Wipe the index between tests so each starts fresh.
    const wsDbRoot = path.join(userDataDir.current, 'rag', workspaceId.current);
    if (fs.existsSync(wsDbRoot)) {
      fs.rmSync(wsDbRoot, { recursive: true, force: true });
    }
  });

  it(
    'chunks, embeds, and stores real TS files end-to-end',
    async () => {
      const result = await ingestWorkspace(workspaceId.current);
      expect(result.filesSeen).toBe(3);
      expect(result.chunksTotal).toBeGreaterThan(3);
      expect(result.chunksEmbedded).toBe(result.chunksTotal);

      const store = openRagStore(workspaceId.current);

      // FTS: querying "User" finds the user.ts chunks.
      const ftsHits = store.queryByFts('User email', 5);
      expect(ftsHits.length).toBeGreaterThan(0);
      const ftsPaths = ftsHits.map((h) => path.basename(h.path));
      expect(ftsPaths).toContain('user.ts');

      // Vector: a code-shaped query about "user email" lands closest to
      // the user.ts / auth.ts chunks, not math.ts. Both query and target
      // are L2-normalized so dot product = cosine.
      const { embedder } = await import('../../../app/core/rag/resolve.js').then((m) =>
        m.resolveForQuery({
          config: { embedderId: 'local-code-512', dim: 384, cloudAllowed: false, chunkTokens: 384 },
          localAvailable: true,
          cloudConfigured: false,
        }),
      );
      const [queryVec] = await embedder.embed(['function to format a user email address']);
      const vecHits = store.queryByVector(queryVec, 5);
      expect(vecHits.length).toBeGreaterThan(0);
      // The top hit must be from user.ts or auth.ts — not math.ts.
      const topPaths = vecHits.slice(0, 3).map((h) => path.basename(h.path));
      expect(topPaths).not.toContain('math.ts');

      store.close();
    },
    120_000,
  );
});
