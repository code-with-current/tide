import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStore } from '../ipc/sessionStore.js';

describe('dispatch resume prerequisites', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a subagent child of this session is resumable; foreign ids are not', () => {
    const store = createSessionStore(dir);
    const parent = store.createSession('ws', 'P', 'm');
    const other = store.createSession('ws', 'O', 'm');
    const child = store.createSession('ws', 'c', 'm', { parentId: parent.id, kind: 'subagent' });
    store.saveDispatchTranscript(child.id,
      [{ id: 'm1', role: 'user', content: 't', createdAt: new Date().toISOString() }],
      [{ role: 'user', content: 't' }, { role: 'assistant', content: 'r' }],
    );

    const resumable = (id: string, sessionId: string) => {
      const s = store.getSession(id);
      return !!s && s.kind === 'subagent' && s.parentId === sessionId;
    };
    expect(resumable(child.id, parent.id)).toBe(true);
    expect(resumable(child.id, other.id)).toBe(false);
    expect(resumable(parent.id, parent.id)).toBe(false);
    expect(store.getSession(child.id)!.modelMessages?.length).toBe(2);
  });
});
