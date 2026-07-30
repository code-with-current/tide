/**
 * Smart dev startup — skips redundant work on subsequent launches.
 *
 * Checks if the electron build output (dist-electron/) is newer than
 * all source files in electron/. If yes, skips the vite build + grammar
 * staging entirely. Only rebuilds when something actually changed.
 *
 * Usage: node build/smart-dev.mjs
 * Exits 0 if dist-electron is up-to-date (skip build), exits 1 if
 * rebuild needed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DIST_MAIN = path.join(ROOT, 'dist-electron', 'main.mjs');
const DIST_GRAMMARS = path.join(ROOT, 'dist-electron', 'grammars');
const DIST_MODEL = path.join(ROOT, 'dist-electron', 'models', 'isuruwijesiri', 'all-MiniLM-L6-v2-code-search-512', 'onnx', 'model_quantized.onnx');

// Directories to watch for staleness.
const SOURCE_DIRS = [
  path.join(ROOT, 'electron'),
  path.join(ROOT, 'vite.electron.config.ts'),
  path.join(ROOT, 'tsconfig.json'),
];

/** Recursively find the newest mtime in a dir (or file). */
function newestMtime(p) {
  if (!fs.existsSync(p)) return 0;
  const stat = fs.statSync(p);
  if (stat.isFile()) return stat.mtimeMs;
  let newest = 0;
  try {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const childPath = path.join(p, entry.name);
      const m = entry.isDirectory() ? newestMtime(childPath) : fs.statSync(childPath).mtimeMs;
      if (m > newest) newest = m;
    }
  } catch { /* */ }
  return newest;
}

// --- Check 1: dist-electron/main.mjs exists and is newer than all source ---
const distTime = fs.existsSync(DIST_MAIN) ? fs.statSync(DIST_MAIN).mtimeMs : 0;
const sourceTime = Math.max(...SOURCE_DIRS.map((p) => newestMtime(p)));

if (distTime < sourceTime) {
  console.log('[dev] electron source changed — rebuild needed');
  process.exit(1);
}

// --- Check 2: grammars staged ---
if (!fs.existsSync(DIST_GRAMMARS) || fs.readdirSync(DIST_GRAMMARS).length < 10) {
  console.log('[dev] grammars missing — staging needed');
  process.exit(1);
}

// --- Check 3: model staged ---
if (!fs.existsSync(DIST_MODEL)) {
  console.log('[dev] model missing — staging needed');
  process.exit(1);
}

console.log('[dev] dist-electron up-to-date — skipping build');
process.exit(0);
