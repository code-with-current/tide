import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStoreV2 } from '../ipc/session-store-v2.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-v2-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('session-store-v2 schema', () => {
  it('creates the four tables with user_version 2', () => {
    const store = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
    expect(store.pragma('user_version')).toBe(2);
    const tables = store.tables();
    expect(tables).toEqual(expect.arrayContaining(['session', 'message', 'part', 'event']));
  });

  it('is idempotent — second open does not throw', () => {
    const p = path.join(dir, 'sessions-v2.db');
    createSessionStoreV2(p);
    expect(() => createSessionStoreV2(p)).not.toThrow();
  });
});
