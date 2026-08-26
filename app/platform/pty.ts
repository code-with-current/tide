/** PTY backend seam (spike 1.1): node-pty is unusable under Bun on POSIX
 *  (tty.ReadStream closes the nonblocking master fd on the first EAGAIN —
 *  bun#29112), so POSIX spawns ride Bun's native Terminal API while Windows
 *  keeps node-pty with a tty.ReadStream monkey-patch. Everything the terminal
 *  domain needs goes through PtyBackend; the session manager on top keys
 *  processes by terminal id and routes backend chunks through a per-session
 *  coalescer so the RPC layer sees one joined string per flush.
 *
 *  Bun terminal lifecycle caveats (verified live against Bun 1.4.0):
 *  - `proc.exited` resolves on its own after a NATURAL exit, but stays
 *    pending after `proc.kill()` until `terminal.close()` — so kill() must
 *    close, and the exit watcher closes defensively (idempotent).
 *  - The data callback receives Uint8Array chunks; strings written to
 *    terminal.write() are accepted directly. */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCoalescer } from './coalescer';

const require = createRequire(import.meta.url);

// ── Backend interface ────────────────────────────────────────────

export interface PtySpawnRequest {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  onData(data: string): void;
  onExit(code: number | null): void;
}

export interface PtyBackendProcess {
  readonly pid: number | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtyBackend {
  readonly name: string;
  spawn(req: PtySpawnRequest): PtyBackendProcess;
}

// ── Pure helpers ─────────────────────────────────────────────────

export function getShell(
  platform: NodeJS.Platform,
  shellEnv: string | undefined,
  comspecEnv?: string,
): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    return { cmd: comspecEnv || 'powershell.exe', args: [] };
  }
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  return { cmd: shellEnv || fallback, args: ['-i'] };
}

/** Provisional size from the renderer's font metrics (avoids the 80x24 spawn
 *  flash); bounded to keep a hostile/misread metric from poisoning the pty. */
export function clampPtySize(cols?: number, rows?: number): { cols: number; rows: number } {
  return {
    cols: Math.min(1000, Math.max(2, Math.floor(cols ?? 80))),
    rows: Math.min(500, Math.max(1, Math.floor(rows ?? 24))),
  };
}

/** Host-private environment variables that must never leak into PTY shells.
 *  ARGV0 (AppImage/Electron) makes zsh rewrite argv[0] for every external
 *  command; NODE_CHANNEL_FD / ELECTRON_RUN_AS_NODE are IPC artifacts invalid
 *  in a child shell; BASH_ENV / ENV / BASH_XTRACEFD would auto-source or
 *  trace arbitrary files. Electrobun/Hutch launcher vars are host bookkeeping
 *  (spike notes §2) — stripped by prefix. */
const STRIP_ENV = new Set([
  'ARGV0',
  'NODE_CHANNEL_FD',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'BASH_ENV',
  'ENV',
  'BASH_XTRACEFD',
]);

export function sanitizePtyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (STRIP_ENV.has(key)) continue;
    if (key.startsWith('ELECTROBUN_') || key.startsWith('HUTCH_')) continue;
    out[key] = value;
  }
  return out;
}

// ── POSIX backend: Bun.spawn terminal API ────────────────────────

const utf8Decoder = new TextDecoder();

export function createBunTerminalBackend(): PtyBackend {
  return {
    name: 'bun-terminal',
    spawn(req) {
      const proc = Bun.spawn([req.cmd, ...req.args], {
        cwd: req.cwd,
        env: { ...req.env, TERM: req.env['TERM'] ?? 'xterm-256color' },
        terminal: {
          cols: req.cols,
          rows: req.rows,
          name: 'xterm-256color',
          data: (_term, data) => req.onData(utf8Decoder.decode(data)),
        },
      });
      const term = proc.terminal;
      if (!term) throw new Error('Bun.spawn returned no terminal handle');
      void proc.exited
        .then((code) => {
          try { term.close(); } catch { /* already closed */ }
          req.onExit(code);
        })
        .catch(() => req.onExit(null));
      return {
        pid: proc.pid,
        write: (data) => { try { term.write(data); } catch { /* closed */ } },
        resize: (cols, rows) => { try { term.resize(cols, rows); } catch { /* closed */ } },
        kill: () => {
          try { proc.kill(); } catch { /* already dead */ }
          // exited stays pending after kill until close() — see file header.
          try { term.close(); } catch { /* already closed */ }
        },
      };
    },
  };
}

// ── Windows backend: node-pty with a Bun tty.ReadStream patch ────

let ttyReadStreamPatched = false;

/** Bun's tty.ReadStream surfaces the first EAGAIN on node-pty's O_NONBLOCK
 *  master fd as an 'error' and closes it (SIGHUP to the child, zero data
 *  forever — spike 1.1). Replace it with an fs.readSync-based Readable that
 *  retries on EAGAIN, mirroring node-pty's own CustomWriteStream approach.
 *  Applied once, BEFORE node-pty is first required (it captures the
 *  constructor at load). Win32 only — POSIX uses the Bun terminal backend. */
function patchTtyReadStreamForBun(): void {
  if (ttyReadStreamPatched || process.platform !== 'win32') return;
  ttyReadStreamPatched = true;
  const tty = require('node:tty') as { ReadStream: unknown };
  const { Readable } = require('node:stream') as typeof import('node:stream');
  const { readSync } = require('node:fs') as typeof import('node:fs');
  class PtyReadStream extends Readable {
    private poll = true;
    constructor(private fd: number) {
      super({ highWaterMark: 1 << 16 });
      this.tick();
    }
    override _read(): void {}
    private tick(): void {
      if (!this.poll || this.destroyed) return;
      const buf = Buffer.alloc(65536);
      let n: number;
      try {
        n = readSync(this.fd, buf, 0, buf.length, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EAGAIN') {
          setTimeout(() => this.tick(), 5);
          return;
        }
        this.destroy();
        return;
      }
      if (n > 0) this.push(buf.subarray(0, n));
      setTimeout(() => this.tick(), n > 0 ? 0 : 5);
    }
    override _destroy(err: Error | null, cb: (e: Error | null) => void): void {
      this.poll = false;
      cb(err);
    }
  }
  tty.ReadStream = PtyReadStream;
}

/** node-pty's prebuilt spawn-helper can lose its execute bit (pnpm/git/archive
 *  side-effects); without it posix_spawn fails with a misleading
 *  "posix_spawnp failed". Restore +x on every launch so it self-heals. */
function ensureSpawnHelperExecutable(): void {
  try {
    const base = path.dirname(require.resolve('node-pty'));
    for (const prebuilds of [path.join(base, 'prebuilds'), path.join(base, '..', 'prebuilds')]) {
      let arches: string[];
      try { arches = fs.readdirSync(prebuilds); } catch { continue; }
      for (const arch of arches) {
        const helper = path.join(prebuilds, arch, 'spawn-helper');
        try {
          const st = fs.statSync(helper);
          if (!(st.mode & 0o111)) fs.chmodSync(helper, st.mode | 0o111);
        } catch { /* helper not here — try next dir */ }
      }
    }
  } catch { /* best-effort — never block terminal init */ }
}

let nodePtyModule: any = null;
let nodePtyLoaded = false;

function loadNodePty(): any {
  if (!nodePtyLoaded) {
    nodePtyLoaded = true;
    try { nodePtyModule = require('node-pty'); } catch { nodePtyModule = null; }
  }
  return nodePtyModule;
}

export function createNodePtyBackend(): PtyBackend {
  return {
    name: 'node-pty',
    spawn(req) {
      patchTtyReadStreamForBun();
      ensureSpawnHelperExecutable();
      const pty = loadNodePty();
      if (!pty) throw new Error('node-pty unavailable');
      const proc = pty.spawn(req.cmd, req.args, {
        name: 'xterm-256color',
        cols: req.cols,
        rows: req.rows,
        cwd: req.cwd,
        env: req.env,
      });
      proc.onData((data: string) => req.onData(data));
      proc.onExit(({ exitCode }: { exitCode: number }) => req.onExit(exitCode));
      return {
        pid: proc.pid as number,
        write: (data) => { try { proc.write(data); } catch { /* already dead */ } },
        resize: (cols, rows) => { try { proc.resize(cols, rows); } catch { /* ignore */ } },
        kill: () => { try { proc.kill(); } catch { /* already dead */ } },
      };
    },
  };
}

export function defaultPtyBackend(): PtyBackend {
  return process.platform === 'win32' ? createNodePtyBackend() : createBunTerminalBackend();
}

// ── Session manager ──────────────────────────────────────────────

export interface PtySessionSpawn {
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Coalesced output: one call per flush with the batch joined. */
  onOutput(data: string): void;
  onExit(code: number | null): void;
}

export interface PtySessionManager {
  readonly backendName: string;
  /** Spawn a session under `id`, replacing (and killing) any existing one.
   *  False when the backend cannot spawn. */
  spawnSession(req: PtySessionSpawn): boolean;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Kill the session and DROP pending output (replacement safety: flushing
   *  would bleed the old generation into a same-id respawn). */
  kill(id: string): void;
  killAll(): void;
  /** Drain pending coalesced output through onOutput now. */
  flush(id: string): void;
  pidOf(id: string): number | null;
  has(id: string): boolean;
}

interface SessionEntry {
  proc: PtyBackendProcess;
  coalescer: { push(item: string): void; flush(): void };
  alive: boolean;
}

export function createPtySessionManager(
  opts: { backend?: PtyBackend; intervalMs?: number; maxItems?: number } = {},
): PtySessionManager {
  const backend = opts.backend ?? defaultPtyBackend();
  const sessions = new Map<string, SessionEntry>();

  const kill = (id: string): void => {
    const entry = sessions.get(id);
    if (!entry) return;
    // Flip alive BEFORE kill so the backend's async exit event is suppressed
    // and any still-pending coalescer timer no-ops (kill drops output).
    entry.alive = false;
    entry.proc.kill();
    sessions.delete(id);
  };

  return {
    backendName: backend.name,
    spawnSession(req) {
      kill(req.id);
      const entry: SessionEntry = {
        proc: null as unknown as PtyBackendProcess,
        alive: true,
        coalescer: null as unknown as SessionEntry['coalescer'],
      };
      entry.coalescer = createCoalescer<string>(
        (items) => {
          if (entry.alive) req.onOutput(items.join(''));
        },
        { intervalMs: opts.intervalMs, maxItems: opts.maxItems },
      );
      try {
        entry.proc = backend.spawn({
          cmd: req.cmd,
          args: req.args,
          cwd: req.cwd,
          env: req.env,
          cols: req.cols,
          rows: req.rows,
          onData: (chunk) => entry.coalescer.push(chunk),
          onExit: (code) => {
            if (!entry.alive) return;
            // Deliver pending output first (while still alive — the flush
            // callback's guard suppresses post-kill delivery) so exit
            // ordering holds downstream.
            entry.coalescer.flush();
            entry.alive = false;
            sessions.delete(req.id);
            req.onExit(code);
          },
        });
      } catch {
        entry.alive = false;
        return false;
      }
      sessions.set(req.id, entry);
      return true;
    },
    write: (id, data) => sessions.get(id)?.proc.write(data),
    resize: (id, cols, rows) => sessions.get(id)?.proc.resize(cols, rows),
    kill,
    killAll: () => {
      for (const id of [...sessions.keys()]) kill(id);
    },
    flush: (id) => sessions.get(id)?.coalescer.flush(),
    pidOf: (id) => sessions.get(id)?.proc.pid ?? null,
    has: (id) => sessions.has(id),
  };
}
