#!/usr/bin/env node
// Updater scenario — end-to-end, local-only test of the Electrobun update
// flow: build FROM -> build TO (patch generated against the hosted FROM
// release) -> install the FROM envelope -> boot the installed app -> watch it
// update itself against a 127.0.0.1 host.
//
//   bun run test:updater
//   node build/updater-scenario.mjs [options]
//
//   --mode auto|serve-only       auto: fully automated; serve-only: build + host
//                                the update and print manual instructions (default auto)
//   --path-strategy patch|full   patch serves the generated bsdiff; full deliberately
//                                omits the .patch so the updater takes the full-tar
//                                fallback (default patch)
//   --from <version>             FROM version (default 9.9.9-alpha.1)
//   --to <version>               TO version (default 9.9.9-alpha.2)
//   --channel <name>             stable|canary (default canary; dev never updates)
//   --port <n>                   HTTP port (default: pick a free one)
//   --keep                       skip install-root/serve-dir cleanup at the end
//
// Constraints honored: packaged envelopes run from /tmp only (the Electrobun
// installer renames the extracted app within the boot volume — EXDEV from
// external volumes); the HTTP host binds 127.0.0.1 only; every process is
// killed and /tmp scratch removed on exit (unless --keep); the app never sees
// real ~/.tide — every launch sets TIDE_DATA_DIR (app/platform/paths.ts
// override) to the scenario scratch dir.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'electrobun.config.ts');
const ARTIFACTS_DIR = path.join(ROOT, 'artifacts');
const APP_IDENTIFIER = 'com.tide.code';

class ScenarioError extends Error {}

const T0 = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function say(msg) { console.log(`[t+${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`); }

// -- args ---------------------------------------------------------------------

function usage(message) {
  if (message) console.error(`updater-scenario: ${message}`);
  console.error('usage: node build/updater-scenario.mjs [--mode auto|serve-only] [--path-strategy patch|full]');
  console.error('                                         [--from <ver>] [--to <ver>] [--channel canary] [--port <n>] [--keep]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    mode: 'auto', pathStrategy: 'patch', from: '9.9.9-alpha.1', to: '9.9.9-alpha.2',
    channel: 'canary', port: null, keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--keep') { out.keep = true; continue; }
    const value = argv[++i];
    if (value === undefined) usage(`missing value for ${key}`);
    if (key === '--mode') out.mode = value;
    else if (key === '--path-strategy') out.pathStrategy = value;
    else if (key === '--from') out.from = value;
    else if (key === '--to') out.to = value;
    else if (key === '--channel') out.channel = value;
    else if (key === '--port') out.port = Number.parseInt(value, 10);
    else usage(`unknown argument: ${key}`);
  }
  if (!['auto', 'serve-only'].includes(out.mode)) usage(`--mode expects auto or serve-only, got "${out.mode}"`);
  if (!['patch', 'full'].includes(out.pathStrategy)) usage(`--path-strategy expects patch or full, got "${out.pathStrategy}"`);
  if (!['stable', 'canary'].includes(out.channel)) usage(`--channel expects stable or canary, got "${out.channel}" (dev never reports updates)`);
  if (out.port !== null && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) {
    usage(`--port expects 1-65535, got "${out.port}"`);
  }
  return out;
}

// -- helpers -------------------------------------------------------------------

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function platformPrefix(channel) {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux';
  return `${channel}-${platform}-${process.arch}`;
}

function findBundle(dir, suffix) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new ScenarioError(`expected exactly one *${suffix} in ${dir}, found: ${files.join(', ') || 'none'}`);
  }
  return path.join(dir, files[0]);
}

function appBundleDir(root) {
  try {
    const apps = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith('.app')).map((d) => d.name).sort();
    return apps.length === 0 ? undefined : path.join(root, apps[0]);
  } catch { return undefined; }
}

function runningVersion(installRoot) {
  const app = appBundleDir(installRoot);
  if (!app) return undefined;
  return readJson(path.join(app, 'Contents', 'Resources', 'version.json'))?.version;
}

async function waitFor(label, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return Date.now();
    await sleep(intervalMs);
  }
  throw new ScenarioError(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);
}

/** Static file host on 127.0.0.1 with a request log — the stand-in for the
 *  release update host (update.json + tar.zst + hash-named .patch). */
function startHttpHost({ dir, port, log }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const rel = path.posix.normalize(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(dir, rel);
      const entry = { t: Date.now(), method: req.method, path: `${url.pathname}${url.search}`, status: 0, bytes: 0 };
      log.push(entry);
      const rootDir = path.resolve(dir);
      if (!file.startsWith(rootDir + path.sep) && file !== rootDir) {
        entry.status = 403;
        res.writeHead(403).end();
        return;
      }
      fs.stat(file, (err, stat) => {
        entry.status = err || !stat.isFile() ? 404 : 200;
        entry.bytes = entry.status === 200 ? stat.size : 0;
        say(`http: ${req.method} ${entry.path} -> ${entry.status}` +
          (entry.status === 200 ? ` (${(stat.size / 1024 / 1024).toFixed(2)} MB)` : ''));
        if (entry.status !== 200) { res.writeHead(entry.status).end(); return; }
        res.writeHead(200, {
          'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          'content-length': stat.size,
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).pipe(res);
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
    state.servers.push(server);
  });
}

function runBuild({ version, channel, port }) {
  say(`building ${channel} v${version} (renderer + hutch envelope; update host http://127.0.0.1:${port})`);
  // hutch wipes artifacts/ per build; clear it ourselves too so snapshots of
  // consecutive builds can never mix (leftovers from older channels included).
  fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
  const started = Date.now();
  // Async spawn (NOT spawnSync): the event loop must stay live — hutch fetches
  // the previous release from release.baseUrl mid-build to generate the bsdiff,
  // and a sync child would deadlock the host that serves it.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'build/build.js', '--version', version, '--channel', channel, '--base-url', `http://127.0.0.1:${port}`,
    ], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', (err) => reject(new ScenarioError(`build of v${version} failed to start: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(Date.now() - started);
      else reject(new ScenarioError(`build of v${version} exited with ${code}`));
    });
  });
}

function snapshotArtifacts(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(ARTIFACTS_DIR, dest, { recursive: true });
  const files = fs.readdirSync(dest).filter((f) => !f.startsWith('.'));
  say(`snapshotted artifacts: ${files.join(', ')}`);
}

function spawnApp(binary, env, label) {
  say(`launching ${label}: ${binary}`);
  const child = spawn(binary, [], {
    cwd: path.dirname(binary),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  state.procs.push(child);
  const forward = (stream, tag) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        console.log(`  [${label}] ${tag} ${buffer.slice(0, idx)}`);
        buffer = buffer.slice(idx + 1);
      }
    });
  };
  forward(child.stdout, 'out');
  forward(child.stderr, 'err');
  child.on('error', (err) => say(`${label} failed to start: ${err.message}`));
  child.on('exit', (code, signal) => say(`${label} exited (code=${code} signal=${signal})`));
  return child;
}

/** Kill every process whose command line contains the pattern (TERM, then
 *  KILL). Patterns are scenario-unique paths, so matches are ours. */
async function killByPattern(pattern, label) {
  const pgrep = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  const pids = (pgrep.stdout ?? '').split('\n')
    .map((l) => Number.parseInt(l, 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  if (pids.length === 0) return;
  say(`stopping ${label} (pids ${pids.join(', ')})`);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (pids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } })) return;
  }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(300);
}

async function stopServers() {
  for (const server of state.servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// -- lifecycle -----------------------------------------------------------------

const state = { servers: [], procs: [], patterns: new Set(), finished: false, keep: false };
let configSnapshot = null;

async function finish({ code }) {
  if (state.finished) return;
  state.finished = true;
  for (const child of state.procs) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  for (const pattern of [...state.patterns]) {
    await killByPattern(pattern, `app (${pattern})`);
  }
  await stopServers();
  if (configSnapshot !== null) {
    // build/build.js keeps the --version patch (only baseUrl is transient);
    // restore the pre-scenario electrobun.config.ts so the tree is as found.
    fs.writeFileSync(CONFIG_PATH, configSnapshot);
  }
  if (!state.keep && state.scratch && state.scratch.startsWith('/tmp/tide-updater-scenario/')) {
    try { fs.rmSync(state.scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (state.keep && state.scratch) {
    console.log(`\n--keep: install root and scratch kept for manual poking`);
    console.log(`  install root: ${state.installRoot}`);
    console.log(`  served dir:   ${path.join(state.scratch, 'serve')}`);
    console.log(`  scratch:      ${state.scratch}`);
  }
  if (code !== undefined) process.exit(code);
}

// -- main -----------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  state.keep = args.keep;
  if (process.platform !== 'darwin') {
    throw new ScenarioError('the install/launch phases are macOS-only (install root + envelope layout)');
  }

  const port = args.port ?? await pickFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const prefix = platformPrefix(args.channel);
  const scratch = `/tmp/tide-updater-scenario/${Date.now()}-${process.pid}`;
  const dataDir = path.join(scratch, 'data');
  const installRoot = path.join(os.homedir(), 'Library', 'Application Support', APP_IDENTIFIER, args.channel);
  state.scratch = scratch;
  state.installRoot = installRoot;
  state.patterns.add(scratch);

  console.log(`updater scenario — mode=${args.mode} strategy=${args.pathStrategy} channel=${args.channel}`);
  console.log(`  ${args.from} -> ${args.to} via ${baseUrl} (${prefix}-update.json)`);
  console.log(`  scratch: ${scratch}`);
  console.log(`  install root: ${installRoot} (recreated for FROM)`);

  fs.mkdirSync(dataDir, { recursive: true });
  configSnapshot = fs.readFileSync(CONFIG_PATH, 'utf8');
  const buildLog = [];
  const updateLog = [];

  // 1. FROM build; its artifacts feed the TO build's patch generator.
  const fromBuildMs = await runBuild({ version: args.from, channel: args.channel, port });
  const fromDir = path.join(scratch, 'from-artifacts');
  snapshotArtifacts(fromDir);
  // Snapshot the install STUB too (build/electrobun/<prefix>/): the dmg-style
  // app whose MacOS/ embeds the <hash>.tar.zst envelope — running the artifacts
  // tar's full app cannot bootstrap an install (core: "install integration:
  // FileNotFound" — no embedded envelope), and the next build overwrites it.
  const stubRoot = path.join(ROOT, 'build', 'electrobun', prefix);
  if (!fs.existsSync(stubRoot)) throw new ScenarioError(`install stub missing: ${stubRoot}`);
  const fromStub = path.join(scratch, 'from-stub');
  fs.cpSync(stubRoot, fromStub, { recursive: true });
  const fromStubApp = appBundleDir(fromStub);
  if (!fromStubApp) throw new ScenarioError(`no *.app in ${stubRoot}`);
  say(`snapshotted install stub: ${fromStubApp}`);

  // 2. Host FROM artifacts while building TO — hutch fetches the previous
  //    release from release.baseUrl to generate the bsdiff.
  await startHttpHost({ dir: fromDir, port, log: buildLog });
  const toBuildMs = await runBuild({ version: args.to, channel: args.channel, port });
  await stopServers();
  say('build-phase host stopped');

  // 3. Update host: TO metadata + envelope (+ patch iff patch strategy).
  const toDir = path.join(scratch, 'to-artifacts');
  snapshotArtifacts(toDir);
  const serveDir = path.join(scratch, 'serve');
  fs.mkdirSync(serveDir, { recursive: true });
  fs.copyFileSync(findBundle(toDir, '-update.json'), path.join(serveDir, `${prefix}-update.json`));
  const toTar = findBundle(toDir, '.tar.zst');
  fs.copyFileSync(toTar, path.join(serveDir, path.basename(toTar)));
  const patchFile = fs.readdirSync(toDir).find((f) => f.endsWith('.patch'));
  if (args.pathStrategy === 'patch') {
    if (!patchFile) throw new ScenarioError('TO build generated no .patch — cannot run patch strategy');
    fs.copyFileSync(path.join(toDir, patchFile), path.join(serveDir, patchFile));
    say(`patch mode: serving ${patchFile}`);
  } else {
    say(`full mode: .patch deliberately NOT served (${patchFile ?? 'none generated'}) — updater must take the full-tar fallback`);
  }
  const manifest = readJson(path.join(serveDir, `${prefix}-update.json`));
  if (manifest?.version !== args.to) {
    throw new ScenarioError(`served update.json version is ${manifest?.version}, expected ${args.to}`);
  }

  // 4. Host the update. serve-only stops here with instructions.
  await startHttpHost({ dir: serveDir, port, log: updateLog });

  if (args.mode === 'serve-only') {
    fs.cpSync(fromStub, path.join(scratch, 'envelope'), { recursive: true });
    const envelopeAppDir = appBundleDir(path.join(scratch, 'envelope'));
    console.log(`
serve-only — update host LIVE at ${baseUrl}
  serving: ${fs.readdirSync(serveDir).join(', ')}

Manual steps:
  1. Install FROM (${args.from}): the envelope (dmg-style stub app) is staged on
     the boot volume at
       ${envelopeAppDir}
     Launch it (double-click, or): open "${envelopeAppDir}"
     It self-extracts into ${installRoot} and boots.
  2. The app auto-checks ${baseUrl}/${prefix}-update.json ~8s after boot (then
     every 4h); Settings -> Updates -> Check now fires the updaterCheckNow RPC
     immediately.
  3. Expect the update to ${args.to} within seconds of a check
     (${args.pathStrategy === 'patch' ? 'bsdiff patch' : 'full-tar fallback — the .patch is intentionally absent'}),
     then the app quits and relaunches itself on ${args.to}.
  4. Every GET appears in this terminal. Ctrl+C stops the host${args.keep ? '' : ' and removes the scratch dir'} (the installed app is yours).

Install root: ${installRoot}`);
    await new Promise(() => {});
  }

  // 5. Recreate the install root, then install FROM by running the envelope
  //    stub once headless (TIDE_DATA_DIR isolates app data from real ~/.tide).
  if (fs.existsSync(installRoot)) {
    say(`removing previous install root ${installRoot}`);
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
  state.patterns.add(installRoot);
  const envelopeDir = path.join(scratch, 'envelope');
  fs.cpSync(fromStub, envelopeDir, { recursive: true });
  const envelopeApp = appBundleDir(envelopeDir);
  const envelopeBin = path.join(envelopeApp, 'Contents', 'MacOS', 'launcher');
  if (!fs.existsSync(envelopeBin)) throw new ScenarioError(`envelope launcher missing: ${envelopeBin}`);

  say('launching FROM envelope headless (first-launch console may detach — known; logs are not required here)');
  const installStart = Date.now();
  spawnApp(envelopeBin, { ELECTROBUN_CONSOLE: '1', TIDE_DATA_DIR: dataDir }, 'from-install');
  const installDoneAt = await waitFor(
    `installed version.json == ${args.from}`,
    () => runningVersion(installRoot) === args.from,
    180_000,
  );
  say(`install root now at v${args.from}; letting first boot settle, then quitting`);
  await sleep(4000);
  await killByPattern(installRoot, 'first-launch app');
  await killByPattern(scratch, 'first-launch envelope');

  // 6. Relaunch the installed app: console streams live; auto-check ~8s in.
  const installedApp = appBundleDir(installRoot);
  const installedBin = path.join(installedApp, 'Contents', 'MacOS', 'launcher');
  const relaunchAt = Date.now();
  spawnApp(installedBin, { ELECTROBUN_CONSOLE: '1', TIDE_DATA_DIR: dataDir }, 'installed-app');
  const updateDoneAt = await waitFor(
    `running version == ${args.to}`,
    () => runningVersion(installRoot) === args.to,
    120_000,
    250,
  );
  await sleep(2000);
  const finalVersion = runningVersion(installRoot);

  // 7. Evidence + verdict.
  const patchGets = updateLog.filter((e) => e.path.includes('.patch'));
  const tarGets = updateLog.filter((e) => e.path.includes('.tar.zst'));
  const usedPatch = patchGets.some((e) => e.status === 200);
  const usedFull = tarGets.some((e) => e.status === 200);
  const versionFlipped = finalVersion === args.to;
  const strategyOk = args.pathStrategy === 'patch' ? (usedPatch && !usedFull) : (usedFull && !usedPatch);
  const passed = versionFlipped && strategyOk;

  const lines = (entries) => entries.map((e) => `  [t+${((e.t - T0) / 1000).toFixed(1)}s] ${e.method} ${e.path} -> ${e.status}` +
    (e.status === 200 && e.bytes > 1024 ? ` (${(e.bytes / 1024 / 1024).toFixed(2)} MB)` : ''));

  console.log('\n================ updater scenario summary ================');
  console.log(`strategy=${args.pathStrategy}  channel=${args.channel}  ${args.from} -> ${args.to}  => ${passed ? 'PASS' : 'FAIL'}`);
  console.log(`version flip: ${args.from} -> ${finalVersion ?? '<none>'} ${versionFlipped ? '(observed)' : '(FAILED)'}`);
  console.log(`update path: ${usedPatch ? 'bsdiff patch' : usedFull ? 'full-tar fallback' : 'NONE OBSERVED'} ` +
    `(expected ${args.pathStrategy === 'patch' ? 'patch' : 'full-tar fallback'})${strategyOk ? '' : ' (MISMATCH)'}`);
  console.log('\nHTTP — build phase (hutch fetching the FROM release for patch generation):');
  console.log(lines(buildLog).join('\n') || '  (no requests)');
  console.log('\nHTTP — update phase (installed app updating itself):');
  console.log(lines(updateLog).join('\n') || '  (no requests)');
  console.log('\ntiming:');
  console.log(`  FROM build:         ${(fromBuildMs / 1000).toFixed(1)}s`);
  console.log(`  TO build:           ${(toBuildMs / 1000).toFixed(1)}s (incl. patch generation)`);
  console.log(`  envelope install:   ${((installDoneAt - installStart) / 1000).toFixed(1)}s (launch -> version.json)`);
  console.log(`  relaunch -> updated: ${((updateDoneAt - relaunchAt) / 1000).toFixed(1)}s`);

  if (passed && args.keep) {
    console.log(`\n--keep: leaving install root + served dir in place (host stays up until Ctrl+C)`);
    console.log(`  installed app: ${installedApp} (running ${finalVersion})`);
    console.log(`  served dir:    ${serveDir}   update host: ${baseUrl}`);
    await new Promise(() => {});
  }
  process.exitCode = passed ? 0 : 1;
}

process.on('SIGINT', () => {
  console.log('\ninterrupted — cleaning up');
  void finish({ code: 130 });
});

main().catch(async (err) => {
  console.error(`\nupdater-scenario: ${err instanceof ScenarioError ? err.message : (err?.stack ?? err)}`);
  process.exitCode = 1;
}).finally(() => finish({}));
