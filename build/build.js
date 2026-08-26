#!/usr/bin/env node
// Release build driver for the Electrobun shell (CI + local release builds).
//
//   node build/build.js [--version X.Y.Z] [--channel stable|canary|dev] [--base-url https://…]
//
// Steps:
//   1. Renderer build — prompt markdown bundle → tsc -b → vite build, invoking
//      the local bins directly so the driver works under plain node in CI.
//   2. `hutch electrobun build --env=<channel>` — app bundle, tar.zst envelope,
//      update metadata, dmg (mac).
//   3. Artifact validation — errors loudly when an expected artifact is
//      missing instead of letting CI upload a partial release.
//
// Version source stays electrobun.config.ts: --version rewrites the config's
// `app.version` in place (CI passes the tag's version). --base-url injects
// `release.baseUrl` for the build only and strips it afterwards, so the
// pending update-host decision never blocks a build.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'electrobun.config.ts');
const ARTIFACTS_DIR = path.join(ROOT, 'artifacts');

function die(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { channel: 'stable' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') out.version = argv[++i];
    else if (argv[i] === '--base-url') out.baseUrl = argv[++i];
    else if (argv[i] === '--channel') out.channel = argv[++i];
    else die(`unknown argument: ${argv[i]}`);
  }
  if (out.version !== undefined && !/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(out.version)) {
    die(`--version expects a semver like 0.3.0 or 0.3.0-beta.1, got "${out.version}"`);
  }
  if (!['stable', 'canary', 'dev'].includes(out.channel)) {
    die(`--channel expects stable, canary, or dev, got "${out.channel}"`);
  }
  return out;
}

function run(label, file, args) {
  console.log(`\n== ${label}: ${file} ${args.join(' ')}\n`);
  const result = spawnSync(file, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) die(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) die(`${label} exited with ${result.status}`);
}

// -- config patching -----------------------------------------------------

function readConfig() {
  return fs.readFileSync(CONFIG_PATH, 'utf8');
}

function writeConfig(source) {
  fs.writeFileSync(CONFIG_PATH, source);
}

function readVersion() {
  const m = fs.readFileSync(CONFIG_PATH, 'utf8').match(/\bversion:\s*"([^"]+)"/);
  if (!m) die('could not read app.version from electrobun.config.ts');
  return m[1];
}

function patchVersion(version) {
  const source = readConfig();
  const patched = source.replace(/(\bversion:\s*)"[^"]*"/, `$1"${version}"`);
  if (patched === source && !source.includes(`version: "${version}"`)) {
    die('could not patch app.version in electrobun.config.ts');
  }
  // Keep package.json in sync so the README badge and npm tooling see the
  // same version the bundle was built with.
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (pkg.version !== version) {
    pkg.version = version;
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    console.log(`build: package.json version -> ${version}`);
  }
  writeConfig(patched);
  console.log(`build: electrobun.config.ts app.version -> ${version}`);
}

function injectBaseUrl(baseUrl) {
  const source = readConfig();
  if (/^\s*release:\s*\{/m.test(source)) {
    if (/^\s*baseUrl:/m.test(source)) {
      writeConfig(source.replace(/(\bbaseUrl:\s*)"[^"]*"/, `$1"${baseUrl}"`));
    } else {
      writeConfig(source.replace(/^(\s*release:\s*\{)/m, `$1\n    baseUrl: "${baseUrl}",`));
    }
  } else {
    // Insert before the export-default object's closing brace (the LAST
    // line-initial `}` in the file) — index-based, so no `$`/`m` anchoring
    // surprises on nested blocks.
    const idx = source.lastIndexOf('\n}');
    if (idx === -1) die('could not find the export-default closing brace in electrobun.config.ts');
    writeConfig(
      source.slice(0, idx) + `\n  release: {\n    baseUrl: "${baseUrl}",\n  },` + source.slice(idx),
    );
  }
  console.log(`build: release.baseUrl -> ${baseUrl} (for this build only)`);
}

// -- build ----------------------------------------------------------------

function buildRenderer() {
  run('prompt bundle', process.execPath, ['build/promptMarkdownUtils.mjs']);
  run('typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
  run('vite build', process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
}

function hutchBin() {
  const candidates = [
    process.env.HUTCH_BIN,
    'hutch',
    path.join(os.homedir(), '.hutch', 'bin', process.platform === 'win32' ? 'hutch.exe' : 'hutch'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (!probe.error) return candidate;
  }
  die('hutch not found — install it (https://hutch.blackboard.sh) or set HUTCH_BIN');
}

function buildApp(channel) {
  const hutch = hutchBin();
  run('electrobun build', hutch, ['electrobun', 'build', `--env=${channel}`]);
}

// Rename human-facing installers to the electron-builder-era convention the
// winget/homebrew packaging manifests hash (Tide-<version>-<arch>.dmg etc).
// Updater-protocol artifacts (-update.json, .tar.zst, .patch) keep their
// fixed names — the updater requests them by exact name from the host.
function renameInstallers(version) {
  const renames = [
    // mac: macos-arm64-Tide[-canary].dmg -> Tide-<version>-arm64.dmg
    [new RegExp(`^macos-arm64-\\w+(?:-canary)?\\.dmg$`), `Tide-${version}-arm64.dmg`],
    // win: windows-x64-Tide[-canary]-setup.exe -> Tide-<version>-x64-Setup.exe
    [new RegExp(`^windows-x64-\\w+(?:-canary)?-setup\\.exe$`, 'i'), `Tide-${version}-x64-Setup.exe`],
    // linux: linux-x64-Tide[-canary].deb -> Tide-<version>-amd64.deb
    [new RegExp(`^linux-x64-\\w+(?:-canary)?\\.deb$`), `Tide-${version}-amd64.deb`],
    [new RegExp(`^linux-x64-\\w+(?:-canary)?\\.AppImage$`), `Tide-${version}-amd64.AppImage`],
    // linux arm64: linux-arm64-Tide[-canary].deb -> Tide-<version>-arm64.deb
    [new RegExp(`^linux-arm64-\\w+(?:-canary)?\\.deb$`), `Tide-${version}-arm64.deb`],
    [new RegExp(`^linux-arm64-\\w+(?:-canary)?\\.AppImage$`), `Tide-${version}-arm64.AppImage`],
  ];
  const files = fs.readdirSync(ARTIFACTS_DIR);
  for (const file of files) {
    for (const [pattern, replacement] of renames) {
      if (pattern.test(file) && file !== replacement) {
        fs.renameSync(path.join(ARTIFACTS_DIR, file), path.join(ARTIFACTS_DIR, replacement));
        console.log(`build: renamed ${file} -> ${replacement}`);
      }
    }
  }
}

function validateArtifacts() {
  if (!fs.existsSync(ARTIFACTS_DIR)) die('artifacts/ does not exist — hutch produced no output');
  const files = fs.readdirSync(ARTIFACTS_DIR).filter((f) => !f.startsWith('.'));
  const expected = [
    { test: (f) => f.endsWith('.tar.zst'), label: '*.tar.zst (app envelope)' },
    { test: (f) => f.endsWith('-update.json'), label: '*-update.json (update metadata)' },
  ];
  if (process.platform === 'darwin') {
    expected.push({ test: (f) => f.endsWith('.dmg'), label: '*.dmg (mac installer)' });
  }
  console.log('\n== artifacts ==');
  for (const file of files) {
    const size = fs.statSync(path.join(ARTIFACTS_DIR, file)).size;
    console.log(`  ${file} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
  const missing = expected.filter(({ test }) => !files.some(test)).map(({ label }) => label);
  if (missing.length > 0) die(`missing expected artifacts: ${missing.join(', ')}`);
  console.log('build: all expected artifacts present');
}

// -- main ------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.version) patchVersion(args.version);
// Snapshot AFTER the version patch so the finally-restore keeps it: only the
// baseUrl injection is transient.
let configSnapshot = null;
if (args.baseUrl) {
  configSnapshot = readConfig();
  injectBaseUrl(args.baseUrl);
}
try {
  buildRenderer();
  buildApp(args.channel);
  renameInstallers(args.version ?? readVersion());
  validateArtifacts();
} finally {
  if (configSnapshot !== null) {
    writeConfig(configSnapshot);
    console.log('build: release.baseUrl removed (update host still undecided)');
  }
}
