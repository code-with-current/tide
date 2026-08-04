/**
 * Stub for `onnxruntime-web` — aliased in via vite.electron.config.ts.
 *
 * `@xenova/transformers` statically imports BOTH onnxruntime-node and
 * onnxruntime-web in src/backends/onnx.js, then selects one at runtime
 * based on `process.release.name`. In the Electron utility process the
 * Node branch is always taken, so onnxruntime-web (≈66 MB of WASM + JS)
 * is imported but never read. This stub satisfies the import without
 * shipping that dead weight.
 *
 * The shape mirrors what Xenova's backend selector accesses:
 * `ONNX_WEB.default ?? ONNX_WEB` — both resolve to this empty object.
 */
const stub: Record<string, unknown> = {};

export default stub;
export const env = { wasm: {} };
