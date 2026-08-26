import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tensor } from 'onnxruntime-node';

// The exact model local-onnx-embedder.ts / embedder-process.ts loads
// (MODEL_ID), vendored in the repo — same tokenizer.json the production
// pipeline uses, so input ids are the real int64 signature, not synthetic.
const spikeDir = nodePath.dirname(fileURLToPath(import.meta.url));
const modelsDir = nodePath.resolve(spikeDir, '..', 'core', 'rag', 'models');
const modelId = 'isuruwijesiri/all-MiniLM-L6-v2-code-search-512';
const modelPath = nodePath.join(modelsDir, modelId, 'onnx', 'model_quantized.onnx');
const text = 'def greet(): print("hello world")';

async function tokenize(input: string): Promise<BigInt64Array> {
  const { AutoTokenizer, env } = await import('@xenova/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelsDir;
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const { input_ids } = await tokenizer(input);
  if (!input_ids || Array.isArray(input_ids)) throw new Error('unexpected tokenizer output');
  return input_ids.data as unknown as BigInt64Array;
}

// Mean pooling + L2 normalize, mirroring the pipeline's
// { pooling: 'mean', normalize: true } options from embedder-process.ts.
function poolNormalize(hidden: Float32Array, mask: BigInt64Array, dim: number): number[] {
  const seq = mask.length;
  const pooled = new Float64Array(dim);
  let maskSum = 0;
  for (let i = 0; i < seq; i++) {
    if (mask[i] !== 0n) {
      maskSum++;
      for (let j = 0; j < dim; j++) pooled[j] += hidden[i * dim + j];
    }
  }
  const denom = Math.max(maskSum, 1e-9);
  let norm = 0;
  for (let j = 0; j < dim; j++) {
    pooled[j] /= denom;
    norm += pooled[j] * pooled[j];
  }
  norm = Math.sqrt(norm) || 1;
  return Array.from(pooled, (v) => v / norm);
}

async function main(): Promise<void> {
  const ids = await tokenize(text);
  const seq = ids.length;

  // Node's ESM-CJS interop can't statically see the __exportStar re-exports in
  // onnxruntime-node's index.js, so prefer the CJS module object (`.default`)
  // when present — Bun exposes both shapes.
  const ortMod = await import('onnxruntime-node');
  const ort = (ortMod as unknown as { default?: typeof ortMod }).default ?? ortMod;
  const started = performance.now();
  const session = await ort.InferenceSession.create(modelPath);
  const sessionCreateMs = performance.now() - started;

  // Feed exactly the names the exported graph declares, as int64 [1, seq] —
  // the same tensor types @xenova/transformers feeds in production.
  const feeds: Record<string, Tensor> = {};
  for (const name of session.inputNames) {
    let data: BigInt64Array;
    if (name === 'input_ids') data = ids;
    else if (name === 'attention_mask') data = new BigInt64Array(seq).fill(1n);
    else data = new BigInt64Array(seq);
    feeds[name] = new ort.Tensor('int64', data, [1, seq]);
  }

  const t0 = performance.now();
  const outputs = await session.run(feeds);
  const runMs = performance.now() - t0;
  const elapsedMs = performance.now() - started;

  const outputKeys = Object.keys(outputs);
  const hidden = outputs[outputKeys[0]]!.data as unknown as Float32Array;
  const dims = outputs[outputKeys[0]]!.dims;
  const dim = dims[dims.length - 1] ?? 0;
  const pooled = poolNormalize(hidden, feeds['attention_mask']!.data as unknown as BigInt64Array, dim);

  console.log(
    JSON.stringify({
      spike: 'onnx',
      model: nodePath.basename(modelPath),
      outputs: outputKeys,
      ok: true,
      elapsedMs: Math.round(elapsedMs * 10) / 10,
      sessionCreateMs: Math.round(sessionCreateMs * 10) / 10,
      runMs: Math.round(runMs * 10) / 10,
      inputNames: session.inputNames,
      seq,
      outputDims: dims,
      embeddingDim: dim,
      pooledPreview: pooled.slice(0, 3).map((v) => Math.round(v * 1000) / 1000),
      runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`,
    }),
  );
  process.exit(0);
}

main().catch((e: unknown) => {
  const name = e instanceof Error ? e.name : 'Error';
  const firstLine = (e instanceof Error ? e.message : String(e)).split('\n')[0];
  console.log(JSON.stringify({ spike: 'onnx', ok: false, error: `${name}: ${firstLine}` }));
  process.exit(1);
});
