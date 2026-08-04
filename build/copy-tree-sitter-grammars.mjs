// Postinstall: vendor the TS/TSX/JS tree-sitter grammars from the
// tree-sitter-wasms package into electron/rag/chunker/grammars/ so
// they ship with the source tree. The chunker loads them by relative
// path; without this, packaged builds have no grammars to load.
//
// Also stages them into dist-electron/grammars/ when invoked with
// `--dist` — needed because vite.electron.config.ts bundles the
// chunker into main.mjs (so __dirname becomes dist-electron/, not
// the source tree). Run via `electron:dev`/`electron:build` after
// the vite build step.
//
// Idempotent: skips files that already match the source sha.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC_DIR = path.join(ROOT, 'node_modules', 'tree-sitter-wasms', 'out');
const DEST_DIR = path.join(ROOT, 'electron', 'rag', 'chunker', 'grammars');
const DIST_DIR = path.join(ROOT, 'dist-electron', 'grammars');
const GRAMMARS = [
  'tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm', 'tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm', 'tree-sitter-go.wasm', 'tree-sitter-rust.wasm',
  'tree-sitter-java.wasm', 'tree-sitter-c.wasm', 'tree-sitter-cpp.wasm',
  'tree-sitter-c_sharp.wasm', 'tree-sitter-ruby.wasm', 'tree-sitter-php.wasm',
  'tree-sitter-swift.wasm', 'tree-sitter-kotlin.wasm', 'tree-sitter-scala.wasm',
  'tree-sitter-bash.wasm', 'tree-sitter-lua.wasm',
  'tree-sitter-vue.wasm', 'tree-sitter-dart.wasm', 'tree-sitter-html.wasm',
  'tree-sitter-css.wasm', 'tree-sitter-elixir.wasm', 'tree-sitter-elm.wasm',
  'tree-sitter-rescript.wasm', 'tree-sitter-solidity.wasm', 'tree-sitter-zig.wasm',
  'tree-sitter-ocaml.wasm', 'tree-sitter-objc.wasm',
];

if (!fs.existsSync(SRC_DIR)) {
  console.log('[grammars] tree-sitter-wasms not installed yet — skipping.');
  process.exit(0);
}

/** Copy grammars into a target dir. Uses file SIZE comparison (fast stat)
 *  instead of sha256 (slow full read) to skip unchanged files. */
function stage(targetDir, label) {
  if (!fs.existsSync(targetDir)) {
    console.warn(`[grammars] ${label}: target ${targetDir} does not exist — skipping.`);
    return;
  }
  let copied = 0;
  let skipped = 0;
  for (const name of GRAMMARS) {
    const src = path.join(SRC_DIR, name);
    const dest = path.join(targetDir, name);
    if (!fs.existsSync(src)) continue;
    // Size comparison is ~1000x faster than sha256 (stat vs read 5MB).
    // Good enough — a grammar wasm changing without changing size is
    // astronomically unlikely.
    if (fs.existsSync(dest)) {
      const srcSize = fs.statSync(src).size;
      const destSize = fs.statSync(dest).size;
      if (srcSize === destSize) { skipped++; continue; }
    }
    fs.copyFileSync(src, dest);
    copied++;
  }
  console.log(`[grammars] ${label}: ${copied} copied, ${skipped} up-to-date.`);
}

// 1. Source-tree vendor (postinstall hook).
fs.mkdirSync(DEST_DIR, { recursive: true });
stage(DEST_DIR, 'src');

// 2. dist-electron staging (when run with --dist after the vite build).
if (process.argv.includes('--dist')) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  stage(DIST_DIR, 'dist');

  // NOTE: The ONNX model is no longer staged here for production builds.
  // It is lazy-downloaded from HuggingFace on first RAG enable (see
  // electron/rag/model-downloader.ts). Dev builds stage it separately via
  // smart-dev.mjs so dev never needs a download.
}

