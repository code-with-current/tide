/**
 * Smart dev startup — skips redundant work on subsequent launches.
 *
 * Checks if the electron build output (dist-electron/) is newer than
 * all source files in electron/. If yes, skips the vite build + grammar
 * staging entirely. Only rebuilds when something actually changed.
 *
 * When a rebuild IS needed, this script performs it directly (vite build
 * for the electron config + grammar staging) so the npm script stays a
 * plain `node build/smart-dev.mjs` — no shell `||`/`()`/`;` chains that
 * cmd.exe misparses on Windows ("vite was unexpected at this time.").
 *
 * Usage: node build/smart-dev.mjs
 * Exits 0 always (unless the rebuild itself fails). `vite` (the dev server)
 * is started separately by concurrently.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DIST_MAIN = path.join(ROOT, 'dist-electron', 'main.mjs');
const DIST_GRAMMARS = path.join(ROOT, 'dist-electron', 'grammars');

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

/**
 * Run a command, inheriting stdio so its output streams live. Throws on
 * non-zero exit so the caller can surface a clear failure.
 */
function run(cmd, args, label) {
  console.log(`[dev] ${label}: ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: ROOT });
  if (res.status !== 0) {
    throw new Error(`${label} failed with exit code ${res.status}`);
  }
}

// --- Check 1: dist-electron/main.mjs exists and is newer than all source ---
const distTime = fs.existsSync(DIST_MAIN) ? fs.statSync(DIST_MAIN).mtimeMs : 0;
const sourceTime = Math.max(...SOURCE_DIRS.map((p) => newestMtime(p)));

let needBuild = false;
let needGrammars = false;

if (distTime < sourceTime) {
  console.log('[dev] electron source changed — rebuild needed');
  needBuild = true;
}

// --- Check 2: grammars staged ---
if (!fs.existsSync(DIST_GRAMMARS) || fs.readdirSync(DIST_GRAMMARS).length < 10) {
  console.log('[dev] grammars missing — staging needed');
  needGrammars = true;
}

try {
  // Bundle system prompt .md files into _system-prompt-bundle.ts before any build.
  run('node', ['build/promptMarkdownUtils.mjs'], 'bundle prompts');

  if (needBuild) {
    // Build the electron main + preload + embedder-process entries.
    run('vite', ['build', '--config', 'vite.electron.config.ts'], 'electron build');
    // Grammar staging always follows a source rebuild (grammars live under
    // dist-electron/, which a rebuild could otherwise leave stale).
    run('node', ['build/copy-tree-sitter-grammars.mjs', '--dist'], 'stage grammars');
  } else if (needGrammars) {
    run('node', ['build/copy-tree-sitter-grammars.mjs', '--dist'], 'stage grammars');
  }
  if (!needBuild && !needGrammars) {
    console.log('[dev] dist-electron up-to-date — skipping build');
  }
} catch (err) {
  console.error(`[dev] ${err.message}`);
  process.exit(1);
}

process.exit(0);
