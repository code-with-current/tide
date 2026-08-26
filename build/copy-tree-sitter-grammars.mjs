// Postinstall: vendor the TS/TSX/JS tree-sitter grammars from the
// tree-sitter-wasms package into app/core/rag/chunker/grammars/ so
// they ship with the source tree. The chunker loads them by relative
// path; without this, packaged builds have no grammars to load.
//
// Idempotent: skips files that already match the source size.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC_DIR = path.join(ROOT, 'node_modules', 'tree-sitter-wasms', 'out');
const DEST_DIR = path.join(ROOT, 'app', 'core', 'rag', 'chunker', 'grammars');
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

// Source-tree vendor (postinstall hook).
fs.mkdirSync(DEST_DIR, { recursive: true });
stage(DEST_DIR, 'src');

