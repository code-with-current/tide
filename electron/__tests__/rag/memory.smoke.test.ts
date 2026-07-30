import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

// Point at the REAL app userData — the index the user ingested lives there.
const REAL_USERDATA = path.join(os.homedir(), 'Library', 'Application Support', 'sumo');
const REAL_WS = 'ws_2wiklbx3';
process.env.TIDE_MODELS_DIR = path.join(REAL_USERDATA, 'models');

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => REAL_USERDATA) },
}));

// Mock workspace/config — point at the real workspace.
vi.mock('../../store.js', () => ({
  listWorkspaces: () => [{ id: REAL_WS, ragConfig: { embedderId: 'local-code-512', dim: 384, cloudAllowed: false, chunkTokens: 384 } }],
  listRagEnabledWorkspaces: () => [REAL_WS],
}));
vi.mock('../../agent/system-model.js', () => ({ isRagCloudConfigured: () => false }));

// Real embedder (handleMessage → real ONNX).
vi.mock('../../rag/local-onnx-embedder.js', async (importOriginal) => {
  const actual = await importOriginal();
  const mod = await import('../../rag/embedder-process.js');
  return {
    ...actual,
    LocalOnnxEmbedder: vi.fn(function () {
      return {
        id: 'local-code-512', dim: 384, maxTokens: 512,
        embed: async (texts) => {
          const r = await mod.handleMessage({ type: 'embed', id: 'smoke', texts });
          if (r.type !== 'result') throw new Error(r.message);
          return r.vectors;
        },
        isAvailable: () => true,
      };
    }),
    localModelExists: () => true,
  };
});

import { runMemory } from '../../agent/tools/memory.js';

describe.skipIf(!process.env.TIDE_LIVE)('memory tool (live smoke)', () => {
  it('retrieves chunks about admin auth from the real index', async () => {
    const result = await runMemory('admin authentication role verification', 5, REAL_WS);
    console.log('=== MEMORY TOOL OUTPUT ===');
    console.log(result.output);
    console.log('=== END ===');
    expect(result.status).toBe('executed');
    expect(result.output).toContain('chunk');
  }, 30_000);
});
