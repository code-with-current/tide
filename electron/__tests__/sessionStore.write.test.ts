import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStore } from '../ipc/sessionStore.js';

describe('sessionStore.writeSession', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a single session file under sessions/', () => {
    const store = createSessionStore(dir);
    store.createSession('ws_test', 'test', 'm_test');
    const files = fs.readdirSync(path.join(dir, 'sessions'));
    expect(files.some(f => f.startsWith('s_'))).toBe(true);
  });

  it('does not leave a .tmp file after write', () => {
    const store = createSessionStore(dir);
    store.createSession('ws_test', 'test', 'm_test');
    const files = fs.readdirSync(path.join(dir, 'sessions'));
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
  });
});
