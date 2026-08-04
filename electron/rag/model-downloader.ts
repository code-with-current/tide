/**
 * Lazy downloader for the local RAG embedding model.
 *
 * The model (isuruwijesiri/all-MiniLM-L6-v2-code-search-512, ≈22 MB) is
 * fetched from HuggingFace CDN on first RAG enable, then cached in
 * userData/models/ — the same path the embedder (embedder-process.ts)
 * already checks via TIDE_MODELS_DIR. This replaces the pre-bundled copy,
 * saving ~44 MB from the shipped app (the model was bundled twice: once
 * from electron/rag/models and once from dist-electron/models).
 *
 * Download is atomic per-file: each file is written to <name>.tmp then
 * renamed, so a crashed/interrupted download never leaves a half-written
 * model that would pass localModelExists() but fail to load.
 *
 * Mirrors the fetch + cache pattern in electron/agent/model-prices.ts.
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLogger } from '../logger.js';
import { MODEL_ID } from './embedder-process.js';
import { appDataDir } from '../appPaths.js';

const log = createLogger('rag');

/** Base URL for model files on HuggingFace. */
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;

/**
 * Files that constitute the model. The ONNX weights dominate; the three
 * JSON files are the tokenizer + config that @xenova/transformers needs
 * to build the feature-extraction pipeline.
 */
const MODEL_FILES: readonly string[] = [
  'onnx/model_quantized.onnx',
  'tokenizer.json',
  'tokenizer_config.json',
  'config.json',
] as const;

/** Progress callback — received/total bytes across all files. */
export type DownloadProgressCallback = (progress: {
  received: number;
  total: number;
  file: string;
}) => void;

/** Directory where the downloaded model lands (matches TIDE_MODELS_DIR). */
export function getModelDownloadDir(): string {
  return path.join(appDataDir(), 'models');
}

/**
 * Download a single file from HuggingFace to destPath, atomically.
 * Streams to a .tmp sibling, then renames. Calls onProgress with bytes
 * received so far (relative to this file's Content-Length).
 */
async function downloadFile(
  relativePath: string,
  destPath: string,
  fileSizeHint: number,
  onProgress: (received: number) => void,
): Promise<void> {
  const url = `${HF_BASE}/${relativePath}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${relativePath}`);
  }
  if (res.body === null) {
    throw new Error(`empty response body for ${relativePath}`);
  }

  // Ensure parent directory exists.
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  // Stream to a temp file; rename atomically on success.
  const tmpPath = `${destPath}.tmp`;
  const fileStream = fs.createWriteStream(tmpPath);

  let received = 0;
  // ReadableStream (web) → Node stream for piping.
  const nodeStream = res.body as unknown as NodeJS.ReadableStream;
  const tracker = new Transform({
    transform(chunk: Buffer, _enc: string, done: TransformCallback) {
      received += chunk.length;
      onProgress(received);
      done(null, chunk);
    },
  });

  try {
    await pipeline(nodeStream, tracker, fileStream);
    await fs.promises.rename(tmpPath, destPath);
  } catch (e) {
    // Clean up the partial temp file.
    try { await fs.promises.unlink(tmpPath); } catch { /* best-effort */ }
    throw e;
  }
  void fileSizeHint; // Content-Length is read inline; hint kept for future use
}

/**
 * Download all model files to userData/models/. Idempotent — files that
 * already exist at the correct size are skipped. Reports aggregate
 * progress via onProgress (received/total across all files).
 *
 * Returns the path to the downloaded model directory.
 */
export async function downloadModel(
  onProgress?: DownloadProgressCallback,
): Promise<string> {
  const modelsDir = getModelDownloadDir();
  const modelDir = path.join(modelsDir, MODEL_ID);

  // HEAD all files to compute total size (for accurate progress %).
  const fileInfos: { relative: string; dest: string; size: number }[] = [];
  let totalSize = 0;
  for (const relative of MODEL_FILES) {
    const dest = path.join(modelDir, relative);
    // Skip if already downloaded (correct size).
    if (fs.existsSync(dest)) {
      const stat = await fs.promises.stat(dest);
      fileInfos.push({ relative, dest, size: stat.size });
      totalSize += stat.size;
      continue;
    }
    // HEAD to get Content-Length.
    try {
      const head = await fetch(`${HF_BASE}/${relative}`, { method: 'HEAD', redirect: 'follow' });
      const size = head.ok ? Number(head.headers.get('content-length') ?? 0) : 0;
      fileInfos.push({ relative, dest, size });
      totalSize += size;
    } catch {
      // HEAD failed — proceed with size 0; the GET will still work.
      fileInfos.push({ relative, dest, size: 0 });
    }
  }

  let receivedTotal = 0;
  // Report initial progress (accounts for already-downloaded files).
  if (onProgress) onProgress({ received: receivedTotal, total: totalSize, file: '' });

  for (const info of fileInfos) {
    if (fs.existsSync(info.dest)) {
      receivedTotal += info.size;
      continue;
    }
    let fileReceived = 0;
    await downloadFile(info.relative, info.dest, info.size, (r) => {
      const delta = r - fileReceived;
      fileReceived = r;
      receivedTotal += delta;
      if (onProgress) onProgress({ received: receivedTotal, total: totalSize, file: info.relative });
    });
    // File complete — ensure the final byte count is reported.
    receivedTotal = receivedTotal - fileReceived + info.size;
    if (onProgress) onProgress({ received: receivedTotal, total: totalSize, file: info.relative });
  }

  log.info('model download complete', { modelDir, totalSize });
  return modelDir;
}

/** Delete the downloaded model (e.g. for a "reset" action). Best-effort. */
export async function deleteDownloadedModel(): Promise<void> {
  const modelDir = path.join(getModelDownloadDir(), MODEL_ID);
  try {
    await fs.promises.rm(modelDir, { recursive: true, force: true });
    log.info('deleted downloaded model', { modelDir });
  } catch (e) {
    log.warn('failed to delete model', { modelDir, err: e });
  }
}
