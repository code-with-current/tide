import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStore } from '../../electron/ipc/sessionStore.js';

describe('sessionStore dispatch sessions', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a subagent child session with parent linkage', () => {
    const store = createSessionStore(dir);
    const parent = store.createSession('ws', 'Parent', 'm');
    const child = store.createSession('ws', 'Map auth (@explore)', 'm', {
      parentId: parent.id,
      kind: 'subagent',
      dispatch: { agentName: 'explore', task: 'map auth' },
    });
    expect(child.parentId).toBe(parent.id);
    expect(child.kind).toBe('subagent');
  });

  it('listSessions excludes subagent sessions', () => {
    const store = createSessionStore(dir);
    const parent = store.createSession('ws', 'Parent', 'm');
    store.createSession('ws', 'child', 'm', { parentId: parent.id, kind: 'subagent' });
    expect(store.listSessions('ws').map((h) => h.id)).toEqual([parent.id]);
  });

  it('listDispatches returns children of a parent', () => {
    const store = createSessionStore(dir);
    const parent = store.createSession('ws', 'Parent', 'm');
    store.createSession('ws', 'a', 'm', { parentId: parent.id, kind: 'subagent' });
    store.createSession('ws', 'b', 'm', { parentId: parent.id, kind: 'subagent' });
    expect(store.listDispatches(parent.id).length).toBe(2);
  });

  it('prunes dispatch transcripts beyond the cap', () => {
    const store = createSessionStore(dir);
    const parent = store.createSession('ws', 'Parent', 'm');
    for (let i = 0; i < 25; i++) {
      store.createSession('ws', `d${i}`, 'm', { parentId: parent.id, kind: 'subagent' });
    }
    expect(store.listDispatches(parent.id).length).toBeLessThanOrEqual(20);
  });

  it('saveDispatchTranscript round-trips messages and modelMessages', () => {
    const store = createSessionStore(dir);
    const parent = store.createSession('ws', 'Parent', 'm');
    const child = store.createSession('ws', 'c', 'm', { parentId: parent.id, kind: 'subagent' });
    store.saveDispatchTranscript(child.id,
      [{ id: 'm1', role: 'user', content: 'task', createdAt: new Date().toISOString() }],
      [{ role: 'user', content: 'task' }],
    );
    const reloaded = store.getSession(child.id);
    expect(reloaded?.modelMessages).toEqual([{ role: 'user', content: 'task' }]);
    expect(reloaded?.messages[0]?.content).toBe('task');
  });

  it('setDispatchStatus round-trips and survives reload', () => {
    const store = createSessionStore(dir);
    const parent = store.createSession('ws', 'Parent', 'm');
    const child = store.createSession('ws', 'c', 'm', {
      parentId: parent.id,
      kind: 'subagent',
      dispatch: { agentName: 'explore', task: 'map auth' },
    });
    store.setDispatchStatus(child.id, 'running');
    expect(store.getSession(child.id)?.dispatch?.status).toBe('running');
    store.setDispatchStatus(child.id, 'completed');
    const reloaded = createSessionStore(dir);
    expect(reloaded.getSession(child.id)?.dispatch?.status).toBe('completed');
  });

  it('listAllDispatches returns only subagent sessions', () => {
    const store = createSessionStore(dir);
    const parent = store.createSession('ws', 'Parent', 'm');
    const child = store.createSession('ws', 'c', 'm', {
      parentId: parent.id,
      kind: 'subagent',
      dispatch: { agentName: 'explore', task: 'map auth' },
    });
    const all = store.listAllDispatches();
    expect(all.map((s) => s.id)).toEqual([child.id]);
    expect(all[0]?.dispatch?.agentName).toBe('explore');
  });
});
