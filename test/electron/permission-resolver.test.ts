import { describe, expect, it } from 'vitest';
import {
  clearSession,
  pendingAskIds,
  resolvePermission,
  waitForPermissionResolve,
} from '../../electron/agent/permission-resolver';

function flushMicrotasks() {
  return new Promise((r) => setTimeout(r, 0));
}

describe('pendingAskIds + mode-escalation sibling approval', () => {
  it('lists awaiting ids and resolving siblings unblocks their awaits', async () => {
    const p1 = waitForPermissionResolve('s1', 'call_a');
    const p2 = waitForPermissionResolve('s1', 'call_b');
    const p3 = waitForPermissionResolve('s1', 'call_c');
    expect(pendingAskIds('s1').sort()).toEqual(['call_a', 'call_b', 'call_c']);

    // Approve call_a with a mode escalation; siblings resolve approved too
    // (mirrors the AGENT_COMMANDS.approve handler).
    resolvePermission('s1', ['call_a'], { approved: true, newMode: 'full' });
    const siblings = pendingAskIds('s1').filter((id) => id !== 'call_a');
    expect(siblings.sort()).toEqual(['call_b', 'call_c']);
    resolvePermission('s1', siblings, { approved: true, newMode: 'full' });

    const verdicts = await Promise.all([p1, p2, p3]);
    expect(verdicts.every((v) => v.approved && v.newMode === 'full')).toBe(true);
    expect(pendingAskIds('s1')).toEqual([]);
    clearSession('s1');
  });

  it('pendingAskIds is per-session and empty after clearSession', async () => {
    const p = waitForPermissionResolve('s2', 'call_x');
    expect(pendingAskIds('s2')).toEqual(['call_x']);
    expect(pendingAskIds('s-other')).toEqual([]);
    // clearSession drops resolvers without settling them — resolve first.
    resolvePermission('s2', ['call_x'], { approved: false, reason: 'cleared' });
    await expect(p).resolves.toEqual({ approved: false, reason: 'cleared' });
    clearSession('s2');
    expect(pendingAskIds('s2')).toEqual([]);
  });
});
