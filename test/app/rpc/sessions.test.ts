/** Sessions RPC contract port (session channels from electron/ipc/handlers.ts
 *  + the v2 list/messages pair): create hydrates defaults and twins into the
 *  v2 store, user messages twin a text part through the shared sink, rename /
 *  archive / delete enforce the two-step flow, fork copies the last assistant
 *  result with lineage, and title generation is best-effort (null without a
 *  user message or a resolvable model). Runs against temp stores: the legacy
 *  JSON singleton is steered at a temp dir via the paths mock, the v2 store
 *  via the sqlite seam. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const pathsState = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../app/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/platform/paths')>();
  return { ...actual, appDataDir: () => pathsState.dir };
});

import { registerSessionsRpc } from '../../../app/rpc/sessions';
import * as legacy from '../../../app/core/ipc-adjacent/sessions.js';
import { createSessionStoreV2 } from '../../../app/core/ipc-adjacent/session-store-v2.js';
import { createEventSink } from '../../../app/core/agent/event-sink.js';
import type { Provider } from '../../../src/types';

const WS_A = 'ws-rpc-a';
const WS_B = 'ws-rpc-b';
const PATH_A = '/repos/ws-a';

const STUB_PROVIDER = {
  id: 'p_title',
  name: 'Title provider',
  apiStyle: 'openai',
  baseUrl: 'https://example.invalid',
  apiKey: 'k',
  enabled: true,
  models: [],
} as unknown as Provider;

let dir: string;
let storeV2: ReturnType<typeof createSessionStoreV2>;
let handlers: ReturnType<typeof registerSessionsRpc>;

// One shared registration for the suite: the legacy store singleton latches
// the temp dir on first use, so tests flow through it sequentially like a
// real app session (create → message → rename → archive → delete).
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rpc-sessions-'));
  pathsState.dir = dir;
  storeV2 = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
  // flushMs 0 makes emit() flush synchronously — twinned parts are readable
  // immediately after the handler returns.
  const sink = createEventSink(storeV2.db, { flushMs: 0 });
  handlers = registerSessionsRpc(legacy, storeV2, {
    sink,
    workspacePathOf: (workspaceId) => (workspaceId === WS_A ? PATH_A : '/repos/other'),
    titleModelOf: (s) => (s.modelId === 'title-model' ? { provider: STUB_PROVIDER, modelId: 'title-model' } : null),
    generateTitle: async (text) => `t-${text.split(' ')[0]}`,
  });
});

afterAll(() => {
  storeV2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('registerSessionsRpc — legacy CRUD', () => {
  it('sessionCreate hydrates defaults and lists per workspace', () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'New session', modelId: 'm1', opts: { providerId: 'p1' } });
    expect(s.id).toMatch(/^s_/);
    expect(s.autonomyMode).toBe('ask');
    expect(s.thinkingLevel).toBe('medium');
    expect(s.status).toBe('idle');
    expect(s.messages).toEqual([]);

    const other = handlers.sessionCreate({ workspaceId: WS_B, title: 'Elsewhere', modelId: 'm1' });
    const ids = handlers.sessionList({ workspaceId: WS_A }).map((h) => h.id);
    expect(ids).toContain(s.id);
    expect(ids).not.toContain(other.id);
    expect(handlers.sessionList({ workspaceId: WS_A }).find((h) => h.id === s.id)?.messageCount).toBe(0);
  });

  it('sessionGet returns null for unknown ids', () => {
    expect(handlers.sessionGet({ sessionId: 's_nope' })).toBeNull();
  });

  it('sessionUpdateSettings patches autonomy and thinking', () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'Settings', modelId: 'm1' });
    handlers.sessionUpdateSettings({ sessionId: s.id, patch: { autonomyMode: 'full', thinkingLevel: 'high' } });
    const after = handlers.sessionGet({ sessionId: s.id });
    expect(after?.autonomyMode).toBe('full');
    expect(after?.thinkingLevel).toBe('high');
  });

  it('sessionAddMessage persists the user message and auto-titles "New session"', () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'New session', modelId: 'm1' });
    handlers.sessionAddMessage({ sessionId: s.id, role: 'user', content: 'hello rpc world' });
    const after = handlers.sessionGet({ sessionId: s.id });
    expect(after?.messages).toHaveLength(1);
    expect(after?.messages[0]).toMatchObject({ role: 'user', content: 'hello rpc world' });
    expect(after?.title).toBe('hello rpc world');
    expect(handlers.sessionList({ workspaceId: WS_A }).find((h) => h.id === s.id)?.messageCount).toBe(1);
  });

  it('assistant add + finalize upsert by messageId without duplicates', () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'Stream', modelId: 'm1' });
    handlers.sessionAddAssistantMessage({ sessionId: s.id, message: { content: 'partial' } });
    handlers.sessionFinalizeAssistantMessage({ sessionId: s.id, messageId: 'm_fin', message: { content: 'done', stopReason: 'end_turn' } });

    let messages = handlers.sessionGet({ sessionId: s.id })?.messages ?? [];
    expect(messages.at(-1)).toMatchObject({ id: 'm_fin', content: 'done', stopReason: 'end_turn' });

    handlers.sessionFinalizeAssistantMessage({ sessionId: s.id, messageId: 'm_fin', message: { content: 'done v2' } });
    messages = handlers.sessionGet({ sessionId: s.id })?.messages ?? [];
    expect(messages.filter((m) => m.id === 'm_fin')).toHaveLength(1);
    expect(messages.find((m) => m.id === 'm_fin')?.content).toBe('done v2');
  });

  it('sessionAddUsage accumulates cumulative totals and last-step usage', () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'Usage', modelId: 'm1' });
    handlers.sessionAddUsage({ sessionId: s.id, delta: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 }, lastStepUsage: { inputTokens: 4 } });
    const after = handlers.sessionGet({ sessionId: s.id });
    expect(after?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.5 });
    expect(after?.lastTurnUsage?.inputTokens).toBe(4);
    expect(after?.costUsd).toBeCloseTo(0.5);
  });

  it('subagent dispatches list under their parent and stay out of the main list', () => {
    const parent = handlers.sessionCreate({ workspaceId: WS_A, title: 'Parent', modelId: 'm1' });
    legacy.getSessionStore().createSession(WS_A, 'Child', 'm1', { kind: 'subagent', parentId: parent.id });

    const dispatches = handlers.sessionListDispatches({ parentId: parent.id });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ kind: 'subagent', parentId: parent.id });
    expect(handlers.sessionList({ workspaceId: WS_A }).map((h) => h.id)).not.toContain(dispatches[0].id);
  });

  it('archive → listArchived → unarchive round-trip; delete requires archive first', () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'Doomed', modelId: 'm9' });

    expect(() => handlers.sessionDelete({ sessionId: s.id })).toThrow(/archived before deletion/);

    handlers.sessionArchive({ sessionId: s.id });
    expect(handlers.sessionList({ workspaceId: WS_A }).map((h) => h.id)).not.toContain(s.id);
    const archived = handlers.sessionListArchived({ workspaceId: WS_A }).find((h) => h.id === s.id);
    expect(archived).toBeDefined();
    expect(archived?.archivedAt).toBeTruthy();

    handlers.sessionUnarchive({ sessionId: s.id });
    expect(handlers.sessionList({ workspaceId: WS_A }).map((h) => h.id)).toContain(s.id);

    handlers.sessionArchive({ sessionId: s.id });
    handlers.sessionDelete({ sessionId: s.id });
    expect(handlers.sessionGet({ sessionId: s.id })).toBeNull();
    expect(handlers.sessionListArchived({ workspaceId: WS_A }).map((h) => h.id)).not.toContain(s.id);
  });

  it('sessionRename updates the list header', () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'Before', modelId: 'm1' });
    handlers.sessionRename({ sessionId: s.id, title: 'After' });
    expect(handlers.sessionGet({ sessionId: s.id })?.title).toBe('After');
    expect(handlers.sessionList({ workspaceId: WS_A }).find((h) => h.id === s.id)?.title).toBe('After');
  });

  it('sessionFork copies the last assistant result with lineage; source untouched', async () => {
    const src = handlers.sessionCreate({ workspaceId: WS_A, title: 'Source', modelId: 'm1' });
    handlers.sessionAddMessage({ sessionId: src.id, role: 'user', content: 'question' });
    handlers.sessionAddAssistantMessage({ sessionId: src.id, message: { content: 'the answer', toolCalls: [{ id: 'tc1' }] } });

    const fork = await handlers.sessionFork({ sourceId: src.id, newModelId: 'm2' });
    expect(fork.modelId).toBe('m2');
    expect(fork.title).toBe('Fork of Source');
    expect(fork.forkedFrom).toMatchObject({ sessionId: src.id, title: 'Source' });
    expect(fork.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'the answer' });
    expect(fork.messages.at(-1)?.turn).toMatchObject({ forkedFromResult: true });

    expect(handlers.sessionGet({ sessionId: src.id })?.messages).toHaveLength(2);
  });

  it('sessionClearAll wipes active and archived lists', () => {
    handlers.sessionCreate({ workspaceId: WS_A, title: 'One', modelId: 'm1' });
    const gone = handlers.sessionCreate({ workspaceId: WS_A, title: 'Two', modelId: 'm1' });
    handlers.sessionArchive({ sessionId: gone.id });

    expect(handlers.sessionClearAll({})).toEqual({ ok: true });
    expect(handlers.sessionList({ workspaceId: WS_A })).toEqual([]);
    expect(handlers.sessionListArchived({ workspaceId: WS_A })).toEqual([]);
    expect(handlers.sessionList({ workspaceId: WS_B })).toEqual([]);
  });
});

describe('registerSessionsRpc — v2 twinning + windows', () => {
  it('sessionCreate twins the session row into the v2 store keyed by workspace path', () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'Twinned', modelId: 'm1', opts: { providerId: 'p1' } });
    const page = handlers.sessionListV2({ workspacePath: PATH_A });
    const meta = page.sessions.find((m) => m.id === s.id);
    expect(meta).toMatchObject({ title: 'Twinned', modelId: 'm1', providerId: 'p1', parentId: null });
    expect(page.nextCursor).toBeNull();
    // v2 keys by path — a create under another workspace never shows here.
    handlers.sessionCreate({ workspaceId: WS_B, title: 'Not here', modelId: 'm1' });
    expect(handlers.sessionListV2({ workspacePath: PATH_A }).sessions.some((m) => m.title === 'Not here')).toBe(false);
  });

  it('sessionAddMessage twins user text as a v2 message with a text part', () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'Twin msg', modelId: 'm1' });
    handlers.sessionAddMessage({ sessionId: s.id, role: 'user', content: 'twin me' });

    const win = handlers.sessionMessagesV2({ sessionId: s.id });
    expect(win.messages).toHaveLength(1);
    expect(win.messages[0]).toMatchObject({ role: 'user' });
    expect(win.messages[0].parts).toHaveLength(1);
    expect(win.messages[0].parts[0]).toMatchObject({ kind: 'text' });
    expect(win.messages[0].parts[0].data).toEqual({ text: 'twin me' });
    expect(win.nextBefore).toBeNull();
  });

  it('sessionListV2 pages by cursor through opts passthrough', async () => {
    const first = handlers.sessionCreate({ workspaceId: WS_A, title: 'Page one', modelId: 'm1' });
    await new Promise((r) => setTimeout(r, 5));
    const second = handlers.sessionCreate({ workspaceId: WS_A, title: 'Page two', modelId: 'm1' });

    const page1 = handlers.sessionListV2({ workspacePath: PATH_A, opts: { limit: 1 } });
    expect(page1.sessions).toHaveLength(1);
    expect(page1.sessions[0].id).toBe(second.id);
    expect(page1.nextCursor).toBe(first.id);

    const page2 = handlers.sessionListV2({ workspacePath: PATH_A, opts: { limit: 1, cursor: page1.nextCursor } });
    expect(page2.sessions[0].id).toBe(first.id);
  });
});

describe('registerSessionsRpc — title generation', () => {
  it('generates a title from the first user message and persists the rename', async () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'New session', modelId: 'title-model' });
    handlers.sessionAddMessage({ sessionId: s.id, role: 'user', content: 'Fix login bug please' });

    const res = await handlers.sessionGenerateTitle({ sessionId: s.id });
    expect(res.title).toBe('t-Fix');
    expect(handlers.sessionGet({ sessionId: s.id })?.title).toBe('t-Fix');
  });

  it('returns null when there is no user message yet', async () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'Silent', modelId: 'title-model' });
    expect(await handlers.sessionGenerateTitle({ sessionId: s.id })).toEqual({ title: null });
  });

  it('returns null when no model resolves for the session', async () => {
    const s = handlers.sessionCreate({ workspaceId: WS_A, title: 'No model', modelId: 'unresolvable' });
    handlers.sessionAddMessage({ sessionId: s.id, role: 'user', content: 'hello' });
    expect(await handlers.sessionGenerateTitle({ sessionId: s.id })).toEqual({ title: null });
    expect(handlers.sessionGet({ sessionId: s.id })?.title).toBe('No model');
  });
});
