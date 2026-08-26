import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const pathsState = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../app/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/platform/paths')>();
  return { ...actual, appDataDir: () => pathsState.dir };
});

import { registerChatRpc } from '../../../app/rpc/chat';
import type { AgentIpc, EventSender } from '../../../app/core/agent/orchestrator.js';
import type { Provider } from '../../../src/types';
import type { RunTurnPayload } from '../../../src/lib/agent/events';

function provider(over: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    name: 'Prov',
    apiStyle: 'openai',
    baseUrl: 'https://example.invalid',
    apiKey: 'key',
    enabled: true,
    models: [{ alias: 'm', modelId: 'model-a', contextWindow: 8192 }],
    ...over,
  } as unknown as Provider;
}

const PAYLOAD: RunTurnPayload = {
  sessionId: 's1',
  messages: [{ role: 'user', content: 'hi' }],
  modelId: 'model-a',
  providerId: 'p1',
  autonomyMode: 'ask',
  thinkingLevel: 'off',
};

/** Fake core registration: records every dispatched command and parks runTurn
 *  on a deferred so the job pattern (return before the turn finishes) is
 *  observable. Mirrors the channel names registerAgentSdkHandlers uses. */
function fakeCore() {
  const calls: { channel: string; args: unknown[] }[] = [];
  const turnRelease: (() => void)[] = [];
  let sender: EventSender | null = null;
  const register = (ipc: AgentIpc) => {
    ipc.handle('agent:runTurn', async (e, payload: RunTurnPayload) => {
      sender = e.sender;
      calls.push({ channel: 'runTurn', args: [payload] });
      await new Promise<void>((resolve) => turnRelease.push(resolve));
    });
    ipc.handle('agent:abort', (_e, sessionId: string) => {
      calls.push({ channel: 'abort', args: [sessionId] });
    });
    ipc.handle('agent:tool:approve', (_e, sessionId: string, ids: string[], newMode?: string, remember?: boolean) => {
      calls.push({ channel: 'approve', args: [sessionId, ids, newMode, remember] });
    });
    ipc.handle('agent:tool:reject', (_e, sessionId: string, ids: string[], reason?: string) => {
      calls.push({ channel: 'reject', args: [sessionId, ids, reason] });
    });
    ipc.handle('agent:followup:submit', (_e, sessionId: string, toolCallId: string, answer: string) => {
      calls.push({ channel: 'followup', args: [sessionId, toolCallId, answer] });
      return sessionId === 'pending';
    });
    ipc.handle('agent:updateMode', (_e, sessionId: string, mode: string) => {
      calls.push({ channel: 'updateMode', args: [sessionId, mode] });
    });
  };
  return {
    register,
    calls,
    releaseTurn: () => turnRelease.splice(0).forEach((r) => r()),
    get sender() {
      return sender;
    },
  };
}

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rpc-chat-'));
  pathsState.dir = dir;
});

describe('registerChatRpc — chatSend job pattern', () => {
  it('accepts immediately without waiting for the turn to finish', async () => {
    const core = fakeCore();
    const forwarded: unknown[] = [];
    const handlers = registerChatRpc(
      { send: (event) => forwarded.push(event) },
      { listProviders: () => [provider()], registerCore: core.register },
    );

    const res = await handlers.chatSend(PAYLOAD);
    expect(res).toEqual({ accepted: true });
    // The turn is still parked on its deferred — the request returned first.
    expect(core.calls.filter((c) => c.channel === 'runTurn')).toHaveLength(1);
    expect(core.calls[0].args[0]).toEqual(PAYLOAD);
    core.releaseTurn();
  });

  it('rejects with an error when the provider is missing', async () => {
    const core = fakeCore();
    const handlers = registerChatRpc(
      { send: () => {} },
      { listProviders: () => [], registerCore: core.register },
    );

    const res = await handlers.chatSend({ ...PAYLOAD, providerId: 'nope' });
    expect(res).toEqual({ accepted: false, error: 'Provider nope not found' });
    expect(core.calls).toHaveLength(0);
  });

  it('rejects with an error when the provider has no API key', async () => {
    const core = fakeCore();
    const handlers = registerChatRpc(
      { send: () => {} },
      { listProviders: () => [provider({ apiKey: undefined })], registerCore: core.register },
    );

    const res = await handlers.chatSend(PAYLOAD);
    expect(res).toEqual({ accepted: false, error: 'No API key for Prov' });
    expect(core.calls).toHaveLength(0);
  });

  it('falls back to an enabled provider serving the modelId when providerId is stale', async () => {
    const core = fakeCore();
    const handlers = registerChatRpc(
      { send: () => {} },
      {
        listProviders: () => [provider({ id: 'other', enabled: false }), provider({ id: 'fresh' })],
        registerCore: core.register,
      },
    );

    const res = await handlers.chatSend({ ...PAYLOAD, providerId: 'deleted' });
    expect(res).toEqual({ accepted: true });
    core.releaseTurn();
  });

  it('forwards agent events from the turn sender to the webview send callback', async () => {
    const core = fakeCore();
    const forwarded: unknown[] = [];
    const handlers = registerChatRpc(
      { send: (event) => forwarded.push(event) },
      { listProviders: () => [provider()], registerCore: core.register },
    );

    await handlers.chatSend(PAYLOAD);
    const sender = core.sender;
    expect(sender).not.toBeNull();
    expect(sender!.isDestroyed()).toBe(false);
    sender!.send('agent:event', { type: 'delta', text: 'x' });
    sender!.send('some:other:channel', { noise: true });
    expect(forwarded).toEqual([{ type: 'delta', text: 'x' }]);
    core.releaseTurn();
  });
});

describe('registerChatRpc — command passthroughs', () => {
  it('chatAbort dispatches the core abort for the session', () => {
    const core = fakeCore();
    const handlers = registerChatRpc(
      { send: () => {} },
      { listProviders: () => [provider()], registerCore: core.register },
    );

    expect(handlers.chatAbort({ sessionId: 's9' })).toEqual({});
    expect(core.calls).toEqual([{ channel: 'abort', args: ['s9'] }]);
  });

  it('chatApproveTools passes ids, escalation mode and remember flag through', () => {
    const core = fakeCore();
    const handlers = registerChatRpc(
      { send: () => {} },
      { listProviders: () => [provider()], registerCore: core.register },
    );

    handlers.chatApproveTools({ sessionId: 's1', toolCallIds: ['t1', 't2'], newMode: 'edit', remember: true });
    expect(core.calls).toEqual([{ channel: 'approve', args: ['s1', ['t1', 't2'], 'edit', true] }]);
  });

  it('chatRejectTools passes the rejection reason through', () => {
    const core = fakeCore();
    const handlers = registerChatRpc(
      { send: () => {} },
      { listProviders: () => [provider()], registerCore: core.register },
    );

    handlers.chatRejectTools({ sessionId: 's1', toolCallIds: ['t1'], reason: 'nope' });
    expect(core.calls).toEqual([{ channel: 'reject', args: ['s1', ['t1'], 'nope'] }]);
  });

  it('chatSubmitFollowup returns the resolver outcome as {resolved}', async () => {
    const core = fakeCore();
    const handlers = registerChatRpc(
      { send: () => {} },
      { listProviders: () => [provider()], registerCore: core.register },
    );

    await expect(handlers.chatSubmitFollowup({ sessionId: 'pending', toolCallId: 't1', answer: 'a' }))
      .resolves.toEqual({ resolved: true });
    await expect(handlers.chatSubmitFollowup({ sessionId: 'ended', toolCallId: 't1', answer: 'a' }))
      .resolves.toEqual({ resolved: false });
  });

  it('chatUpdateMode dispatches the mid-turn mode change', () => {
    const core = fakeCore();
    const handlers = registerChatRpc(
      { send: () => {} },
      { listProviders: () => [provider()], registerCore: core.register },
    );

    handlers.chatUpdateMode({ sessionId: 's1', mode: 'full' });
    expect(core.calls).toEqual([{ channel: 'updateMode', args: ['s1', 'full'] }]);
  });
});

describe('registerChatRpc — detached-turn rejection fallback', () => {
  it('emits error + turn_end so isStreaming clears when the core guard itself throws', async () => {
    // A core whose runTurn emits one live event, then blows up past its own
    // guard — the case the old .catch(() => {}) swallowed.
    const forwarded: any[] = [];
    const register = (ipc: AgentIpc) => {
      ipc.handle('agent:runTurn', async (e, payload: RunTurnPayload) => {
        e.sender.send('agent:event', {
          type: 'delta', sessionId: payload.sessionId, seq: 7,
          messageId: 'm1', text: 'partial', blockId: 'b1',
        });
        throw new Error('guard blew up');
      });
    };
    const handlers = registerChatRpc(
      { send: (event) => forwarded.push(event) },
      { listProviders: () => [provider()], registerCore: register },
    );

    const res = await handlers.chatSend(PAYLOAD);
    expect(res).toEqual({ accepted: true });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(forwarded).toHaveLength(3);
    expect(forwarded[1]).toMatchObject({ type: 'error', sessionId: 's1', message: 'guard blew up' });
    expect(forwarded[2]).toMatchObject({ type: 'turn_end', sessionId: 's1', stopReason: 'refusal' });
    // Fallback seqs continue above the observed live seq (7).
    expect(forwarded[1].seq).toBe(8);
    expect(forwarded[2].seq).toBe(9);
  });
});
