import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStore } from '../../electron/ipc/sessionStore.js';

function seedLegacy(rootDir: string, sessions: any[]): void {
  fs.writeFileSync(
    path.join(rootDir, 'sessions.json'),
    JSON.stringify({ sessions }, null, 2),
  );
}

describe('sessionStore migration', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('splits legacy sessions.json into per-session files', () => {
    seedLegacy(dir, [
      { id: 's_one', workspaceId: 'ws_a', title: 'one', modelId: 'm', messages: [], createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z' },
      { id: 's_two', workspaceId: 'ws_a', title: 'two', modelId: 'm', messages: [], createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z' },
    ]);

    const store = createSessionStore(dir);
    store.loadAll();

    expect(store.getSession('s_one')?.title).toBe('one');
    expect(store.getSession('s_two')?.title).toBe('two');
    expect(fs.existsSync(path.join(dir, 'sessions', 's_one.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sessions', 's_two.json'))).toBe(true);
  });

  it('renames sessions.json to sessions.json.bak after successful migration', () => {
    seedLegacy(dir, [
      { id: 's_x', workspaceId: 'ws_a', title: 'x', modelId: 'm', messages: [], createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z' },
    ]);

    createSessionStore(dir).loadAll();

    expect(fs.existsSync(path.join(dir, 'sessions.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'sessions.json.bak'))).toBe(true);
  });

  it('does not re-migrate when sessions.json.bak exists', () => {
    seedLegacy(dir, [
      { id: 's_x', workspaceId: 'ws_a', title: 'old', modelId: 'm', messages: [], createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z' },
    ]);
    // First migration
    createSessionStore(dir).loadAll();
    // Tamper with the per-session file to prove a second loadAll doesn't re-migrate over it
    const sessionFile = path.join(dir, 'sessions', 's_x.json');
    const tweaked = { ...JSON.parse(fs.readFileSync(sessionFile, 'utf-8')), title: 'tweaked' };
    fs.writeFileSync(sessionFile, JSON.stringify(tweaked));

    const fresh = createSessionStore(dir);
    fresh.loadAll();

    expect(fresh.getSession('s_x')?.title).toBe('tweaked');
    // Direct idempotency check: .bak must still exist after the second loadAll.
    expect(fs.existsSync(path.join(dir, 'sessions.json.bak'))).toBe(true);
  });

  it('moves corrupted sessions.json to sessions.json.broken-<ts>', () => {
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{not valid json');
    createSessionStore(dir).loadAll();
    const broken = fs.readdirSync(dir).find(f => f.startsWith('sessions.json.broken-'));
    expect(broken).toBeDefined();
    // Original corrupt content must be preserved in the moved-aside file.
    expect(fs.readFileSync(path.join(dir, broken!), 'utf-8')).toBe('{not valid json');
    expect(fs.existsSync(path.join(dir, 'sessions.json'))).toBe(false);
  });
});
