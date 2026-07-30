/**
 * Live (network-backed) test for the local ONNX embedder.
 *
 * Skipped by default — first invocation downloads the ~22MB quantized
 * model from Hugging Face, which is correct for a one-shot smoke check
 * but wrong for `npm test` on every run.
 *
 * Run explicitly:
 *   TIDE_LIVE=1 npm test -- localOnnxEmbedder.live
 *
 * What this proves that the mocked unit tests don't:
 *   1. @xenova/transformers + onnxruntime-node actually load in this env
 *   2. The model downloads to the path the app expects (TIDE_MODELS_DIR)
 *   3. A real text → 384-dim L2-normalized vector round-trips through
 *      handleMessage (the same function the utilityProcess child runs)
 *   4. Two semantically related code snippets score higher than two
 *      unrelated ones — the embedding isn't returning noise.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleMessage, _resetPipelineForTests } from '../../rag/embedder-process.js';

// Mirror what local-onnx-embedder.ts sets when spawning the child.
// Use the real userData path so the model lands where the app will look
// for it on the next real run — not a throwaway temp dir.
const MODELS_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'sumo',
  'models',
);

beforeAll(() => {
  process.env.TIDE_MODELS_DIR = MODELS_DIR;
  // Bust any memoized pipeline from a prior run in this process.
  _resetPipelineForTests();
});

const describeLive = describe.skipIf(!process.env.TIDE_LIVE);

describeLive('local ONNX embedder (live)', () => {
  it('downloads the model and returns a 384-dim L2-normalized vector', async () => {
    const resp = await handleMessage({
      type: 'embed',
      id: 't1',
      texts: ['function add(a, b) { return a + b; }'],
    });

    expect(resp.type).toBe('result');
    if (resp.type !== 'result') return; // narrow for TS

    expect(resp.vectors).toHaveLength(1);
    const v = resp.vectors[0];
    expect(v).toHaveLength(384);

    // L2-normalized → magnitude ≈ 1 (the model card's JS quick-start
    // uses { pooling:'mean', normalize:true }, same as embedder-process.ts).
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(mag).toBeCloseTo(1, 3);
  }, 180_000); // first run downloads ~22MB; be generous.

  it('ranks a related code snippet above an unrelated one (cosine)', async () => {
    const resp = await handleMessage({
      type: 'embed',
      id: 't2',
      texts: [
        'function add(a, b) { return a + b; }',
        'export const sum = (x: number, y: number): number => x + y;',
        'The quick brown fox jumps over the lazy dog.',
      ],
    });

    expect(resp.type).toBe('result');
    if (resp.type !== 'result') return;

    const [query, related, unrelated] = resp.vectors;
    const cos = (a: number[], b: number[]) =>
      a.reduce((s, x, i) => s + x * b[i], 0); // already normalized → dot = cosine

    expect(cos(query, related)).toBeGreaterThan(cos(query, unrelated));
  }, 60_000);
});
