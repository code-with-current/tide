import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStore } from '../ipc/sessionStore.js';

describe('sessionStore mutations', () => {
  let dir: string;
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
    store = createSessionStore(dir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('updateSessionSettings writes through to disk', () => {
    const s = store.createSession('ws', 't', 'm');
    store.updateSessionSettings(s.id, { autonomyMode: 'full', thinkingLevel: 'max' });
    const fresh = createSessionStore(dir);
    expect(fresh.getSession(s.id)?.autonomyMode).toBe('full');
    expect(fresh.getSession(s.id)?.thinkingLevel).toBe('max');
  });

  it('addMessage appends and persists', () => {
    const s = store.createSession('ws', 't', 'm');
    store.addMessage(s.id, 'user', 'hello');
    const fresh = createSessionStore(dir);
    const got = fresh.getSession(s.id);
    expect(got?.messages).toHaveLength(1);
    expect(got?.messages[0].content).toBe('hello');
    expect(got?.messages[0].role).toBe('user');
  });

  it('addMessage auto-titles when title was "New session"', () => {
    const s = store.createSession('ws', '', 'm'); // empty title → defaults to 'New session'
    store.addMessage(s.id, 'user', 'Refactor the parser');
    const fresh = createSessionStore(dir);
    expect(fresh.getSession(s.id)?.title).toBe('Refactor the parser');
  });

  it('addAssistantMessage persists blocks + reasoning', () => {
    const s = store.createSession('ws', 't', 'm');
    store.addAssistantMessage(s.id, {
      content: 'done',
      reasoning: 'thinking...',
      blocks: [{ id: 'b1', kind: 'text', text: 'done' }],
    });
    const fresh = createSessionStore(dir);
    const got = fresh.getSession(s.id);
    expect(got?.messages).toHaveLength(1);
    expect(got?.messages[0].blocks).toHaveLength(1);
    expect(got?.messages[0].reasoning).toBe('thinking...');
  });

  it('addUsage accumulates into session.usage', () => {
    const s = store.createSession('ws', 't', 'm');
    store.addUsage(s.id, { inputTokens: 100, outputTokens: 50 });
    store.addUsage(s.id, { inputTokens: 200, calls: 2 });
    const fresh = createSessionStore(dir);
    const u = fresh.getSession(s.id)?.usage;
    expect(u?.inputTokens).toBe(300);
    expect(u?.outputTokens).toBe(50);
    expect(u?.calls).toBe(2);
  });

  it('addUsage on a session without prior usage starts at zeros + delta', () => {
    const s = store.createSession('ws', 't', 'm');
    store.addUsage(s.id, { inputTokens: 10 });
    const u = createSessionStore(dir).getSession(s.id)?.usage;
    expect(u?.inputTokens).toBe(10);
    expect(u?.outputTokens).toBe(0);
  });
});
