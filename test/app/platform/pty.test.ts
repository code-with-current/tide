/** Pty seam unit tests: pure helpers (shell choice, size clamping, env
 *  sanitization) plus the session manager's bookkeeping and per-session
 *  coalescer wiring against a mock backend — live spawns are E2E (spike). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampPtySize,
  createPtySessionManager,
  getShell,
  sanitizePtyEnv,
  type PtyBackend,
  type PtySpawnRequest,
} from '../../../app/platform/pty';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

interface FakeProc {
  pid: number;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
}

function createFakeBackend() {
  const spawned: PtySpawnRequest[] = [];
  const procs: FakeProc[] = [];
  let pidSeq = 100;
  const backend: PtyBackend = {
    name: 'fake',
    spawn: (req) => {
      const proc: FakeProc = { pid: ++pidSeq, writes: [], resizes: [], killed: false };
      spawned.push(req);
      procs.push(proc);
      return {
        pid: proc.pid,
        write: (data) => { proc.writes.push(data); },
        resize: (cols, rows) => { proc.resizes.push({ cols, rows }); },
        kill: () => { proc.killed = true; },
      };
    },
  };
  return {
    backend,
    spawned,
    procs,
    emitData: (i: number, chunk: string) => spawned[i]!.onData(chunk),
    emitExit: (i: number, code: number | null) => spawned[i]!.onExit(code),
  };
}

function setup(opts?: { intervalMs?: number; maxItems?: number }) {
  const fake = createFakeBackend();
  const manager = createPtySessionManager({ backend: fake.backend, intervalMs: opts?.intervalMs ?? 16, maxItems: opts?.maxItems });
  return { fake, manager };
}

function spawnOpts(over: Partial<Parameters<ReturnType<typeof createPtySessionManager>['spawnSession']>[0]> = {}) {
  return {
    id: 't1',
    cmd: '/bin/zsh',
    args: ['-i'],
    cwd: '/tmp',
    env: { PATH: '/usr/bin' },
    cols: 80,
    rows: 24,
    onOutput: () => {},
    onExit: () => {},
    ...over,
  };
}

describe('getShell', () => {
  it('prefers $SHELL with -i on POSIX', () => {
    expect(getShell('darwin', '/bin/fish')).toEqual({ cmd: '/bin/fish', args: ['-i'] });
    expect(getShell('linux', undefined)).toEqual({ cmd: '/bin/bash', args: ['-i'] });
    expect(getShell('darwin', undefined)).toEqual({ cmd: '/bin/zsh', args: ['-i'] });
  });
  it('uses COMSPEC/powershell on Windows', () => {
    expect(getShell('win32', '/ignored', 'C:\\Windows\\system32\\cmd.exe')).toEqual({ cmd: 'C:\\Windows\\system32\\cmd.exe', args: [] });
    expect(getShell('win32', undefined, undefined).cmd).toBe('powershell.exe');
  });
});

describe('clampPtySize', () => {
  it('defaults to 80x24', () => {
    expect(clampPtySize(undefined, undefined)).toEqual({ cols: 80, rows: 24 });
  });
  it('bounds cols to 2-1000 and rows to 1-500', () => {
    expect(clampPtySize(2000, 0)).toEqual({ cols: 1000, rows: 1 });
    expect(clampPtySize(1, 1000)).toEqual({ cols: 2, rows: 500 });
    expect(clampPtySize(120.9, 40.9)).toEqual({ cols: 120, rows: 40 });
  });
});

describe('sanitizePtyEnv', () => {
  it('strips host-private variables and undefined values', () => {
    expect(sanitizePtyEnv({
      PATH: '/usr/bin',
      ARGV0: 'tide',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_CHANNEL_FD: '3',
      BASH_ENV: '/etc/oops',
      UNDEFINED_VAL: undefined,
      ELECTROBUN_LAUNCHER_PID: '42',
      HUTCH_ACTIVE_CHANNEL: 'production',
    })).toEqual({ PATH: '/usr/bin' });
  });
});

describe('createPtySessionManager', () => {
  it('registers a session and exposes its pid', () => {
    const { fake, manager } = setup();
    expect(manager.spawnSession(spawnOpts())).toBe(true);
    expect(manager.has('t1')).toBe(true);
    expect(manager.pidOf('t1')).toBe(fake.procs[0]!.pid);
    expect(manager.pidOf('nope')).toBeNull();
    expect(manager.backendName).toBe('fake');
  });

  it('routes write/resize to the session process and no-ops unknown ids', () => {
    const { fake, manager } = setup();
    manager.spawnSession(spawnOpts());
    manager.write('t1', 'ls\r');
    manager.resize('t1', 120, 40);
    expect(fake.procs[0]!.writes).toEqual(['ls\r']);
    expect(fake.procs[0]!.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(() => manager.write('nope', 'x')).not.toThrow();
    expect(() => manager.resize('nope', 1, 1)).not.toThrow();
  });

  it('re-spawning an id kills the old process and suppresses its exit event', () => {
    const { fake, manager } = setup();
    const exits: Array<number | null> = [];
    manager.spawnSession(spawnOpts({ onExit: (c) => exits.push(c) }));
    manager.spawnSession(spawnOpts());
    expect(fake.procs[0]!.killed).toBe(true);
    expect(manager.pidOf('t1')).toBe(fake.procs[1]!.pid);
    // Stale exit from the replaced backend process must not reach the consumer.
    fake.emitExit(0, 0);
    expect(exits).toEqual([]);
  });

  it('coalesces output chunks into one delivery per interval', () => {
    const out: string[] = [];
    const { fake, manager } = setup();
    manager.spawnSession(spawnOpts({ onOutput: (d) => out.push(d) }));
    fake.emitData(0, 'a');
    fake.emitData(0, 'b');
    fake.emitData(0, 'c');
    expect(out).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(out).toEqual(['abc']);
    vi.advanceTimersByTime(64);
    expect(out).toEqual(['abc']);
  });

  it('flush(id) delivers pending output immediately and cancels the timer', () => {
    const out: string[] = [];
    const { fake, manager } = setup();
    manager.spawnSession(spawnOpts({ onOutput: (d) => out.push(d) }));
    fake.emitData(0, 'x');
    fake.emitData(0, 'y');
    manager.flush('t1');
    expect(out).toEqual(['xy']);
    vi.advanceTimersByTime(32);
    expect(out).toEqual(['xy']);
  });

  it('flushes pending output BEFORE delivering exit', () => {
    const order: string[] = [];
    const { fake, manager } = setup();
    manager.spawnSession(spawnOpts({
      onOutput: (d) => order.push(`out:${d}`),
      onExit: (c) => order.push(`exit:${c}`),
    }));
    fake.emitData(0, 'last');
    fake.emitExit(0, 3);
    expect(order).toEqual(['out:last', 'exit:3']);
    expect(manager.has('t1')).toBe(false);
  });

  it('kill drops pending output, kills the process, and removes the session', () => {
    const out: string[] = [];
    const { fake, manager } = setup();
    manager.spawnSession(spawnOpts({ onOutput: (d) => out.push(d) }));
    fake.emitData(0, 'pending');
    manager.kill('t1');
    vi.advanceTimersByTime(64);
    expect(out).toEqual([]);
    expect(fake.procs[0]!.killed).toBe(true);
    expect(manager.has('t1')).toBe(false);
    expect(() => manager.write('t1', 'x')).not.toThrow();
  });

  it('killAll removes every session', () => {
    const { fake, manager } = setup();
    manager.spawnSession(spawnOpts({ id: 'a' }));
    manager.spawnSession(spawnOpts({ id: 'b' }));
    manager.killAll();
    expect(manager.has('a')).toBe(false);
    expect(manager.has('b')).toBe(false);
    expect(fake.procs.map((p) => p.killed)).toEqual([true, true]);
  });

  it('returns false when the backend cannot spawn', () => {
    const backend: PtyBackend = {
      name: 'broken',
      spawn: () => { throw new Error('no pty'); },
    };
    const manager = createPtySessionManager({ backend, intervalMs: 16 });
    expect(manager.spawnSession(spawnOpts())).toBe(false);
    expect(manager.has('t1')).toBe(false);
  });
});
