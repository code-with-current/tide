import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let cwd: string;

beforeAll(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-scripts-rpc-'));
});
import { registerScriptsRpc, detectPorts, type ScriptsRpcEvents } from '../../../app/rpc/scripts';
import type { ChildProcess } from 'node:child_process';

function fakeProc(): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
  (emitter as { stdout: unknown }).stdout = new EventEmitter();
  (emitter as { stderr: unknown }).stderr = new EventEmitter();
  emitter.pid = 4242;
  emitter.kill = () => true;
  return emitter as unknown as ChildProcess;
}

function harness(dir: string | null = cwd) {
  const events: ScriptsRpcEvents = {
    output: vi.fn(),
    exit: vi.fn(),
    ports: vi.fn(),
  };
  const spawnCommand = vi.fn(() => fakeProc());
  const handlers = registerScriptsRpc({
    events,
    spawnCommand,
    workspacePathOf: (_workspaceId: string) => dir,
  });
  return { handlers, events, spawnCommand };
}

describe('scripts rpc', () => {
  it('detectPorts matches dev-server patterns in valid ranges only', () => {
    expect(detectPorts('ready on http://localhost:5173/')).toEqual([5173]);
    expect(detectPorts('listening on port 3000')).toEqual([3000]);
    expect(detectPorts('server started on 8080')).toEqual([8080]);
    expect(detectPorts('https://127.0.0.1:8443 ok')).toEqual([8443]);
    // Out of the dev range / garbage — nothing.
    expect(detectPorts('port 22 ssh')).toEqual([]);
    expect(detectPorts('nothing here')).toEqual([]);
  });

  it('scriptRun guards unknown workspaces and duplicates', () => {
    const missing = registerScriptsRpc({ events: { output: vi.fn(), exit: vi.fn(), ports: vi.fn() }, workspacePathOf: () => null });
    expect(missing.scriptRun({ workspaceId: 'w', command: 'npm run dev' })).toMatchObject({ ok: false, reason: 'workspace not found' });

    const { handlers } = harness();
    expect(handlers.scriptRun({ workspaceId: 'w', command: 'npm run dev' })).toMatchObject({ ok: true, pid: 4242 });
    expect(handlers.scriptRun({ workspaceId: 'w', command: 'npm run dev' })).toMatchObject({ ok: false, reason: 'already running' });
  });

  it('streams stdout lines, detects ports, and clears state on exit', () => {
    const { handlers, events, spawnCommand } = harness();
    const res = handlers.scriptRun({ workspaceId: 'w', command: 'vite' });
    expect(res.ok).toBe(true);

    const proc = spawnCommand.mock.results[0].value as unknown as { stdout: EventEmitter };
    proc.stdout.emit('data', Buffer.from('VITE ready on port 5173\n'));

    expect(events.output).toHaveBeenCalledWith({ workspaceId: 'w', command: 'vite', stream: 'stdout', line: 'VITE ready on port 5173' });
    expect(events.ports).toHaveBeenCalledWith({
      workspaceId: 'w',
      ports: [{ port: 5173, label: 'vite', url: 'http://localhost:5173' }],
    });
    expect(handlers.scriptPorts({ workspaceId: 'w' }).ports).toEqual([
      { port: 5173, label: 'vite', url: 'http://localhost:5173' },
    ]);
    expect(handlers.scriptLines({ workspaceId: 'w' }).lines.length).toBeGreaterThan(0);

    proc.stdout.emit('data', Buffer.from('second line\n'));
    proc.emit('close', 0);

    expect(events.exit).toHaveBeenCalledWith({ workspaceId: 'w', command: 'vite', code: 0 });
    // Process bookkeeping cleared — the same command can run again.
    expect(handlers.scriptRun({ workspaceId: 'w', command: 'vite' })).toMatchObject({ ok: true });
  });

  it('scriptStop reports not-running for unknown commands', () => {
    const { handlers } = harness();
    expect(handlers.scriptStop({ workspaceId: 'w', command: 'nope' })).toEqual({ ok: false, reason: 'not running' });
  });
});
