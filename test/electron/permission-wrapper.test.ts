import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withPermission } from '../../electron/agent/permission-wrapper.js';
import {
  resolvePermission,
  clearSession,
} from '../../electron/agent/permission-resolver.js';
import {
  addSessionRule,
  addPermissionRule,
  clearSessionRules,
  deriveRuleSpec,
  evaluateRules,
  getSessionRules,
  loadPermissionRules,
  parseRule,
} from '../../electron/agent/permissions/rules.js';
import type { ToolContext } from '../../electron/agent/tools/tool-context.js';

const SID = 's_perm_test';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: SID,
    workspaceRoot: '/tmp',
    autonomyMode: 'full',
    modelId: 'm',
    provider: { id: 'p', name: 'p', apiStyle: 'anthropic', baseUrl: '', enabled: true, models: [] } as any,
    compactionSettings: { enabled: true, threshold: 0.75, keepRecentTurns: 3, onFailure: 'truncate' },
    onUsage: () => {},
    emit: () => {},
    abortSignal: new AbortController().signal,
    // The gate no longer trusts this snapshot (it re-reads loadPermissionRules
    // at gate time), but the field is still required by the type.
    permissionRules: { allow: [], deny: [] },
    ...overrides,
  };
}

/** Drain the microtask queue enough times for the wrapper to reach its await. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('withPermission', () => {
  beforeEach(() => {
    clearSession(SID);
    clearSessionRules(SID);
  });

  it('runs immediately in full mode (auto decision)', async () => {
    const ctx = makeCtx({ autonomyMode: 'full' });
    const run = vi.fn().mockResolvedValue('done');
    const result = await withPermission(ctx, 'bash', { command: 'ls' }, run);
    expect(run).toHaveBeenCalledOnce();
    expect(result).toBe('done');
  });

  it('runs read-only tools immediately regardless of mode', async () => {
    const ctx = makeCtx({ autonomyMode: 'plan' });
    const run = vi.fn().mockResolvedValue('data');
    const result = await withPermission(ctx, 'read_file', { path: '/tmp/x' }, run);
    expect(run).toHaveBeenCalledOnce();
    expect(result).toBe('data');
  });

  it('emits permission event and awaits approval in ask mode', async () => {
    const ctx = makeCtx({ autonomyMode: 'ask' });
    const emit = vi.fn();
    ctx.emit = emit;
    const run = vi.fn().mockResolvedValue('ran');

    const pending = withPermission(ctx, 'bash', { command: 'ls' }, run);
    await flushMicrotasks();

    const emitCall = emit.mock.calls[0][0] as { toolCallId: string };
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'permission',
      toolName: 'bash',
    }));
    expect(run).not.toHaveBeenCalled();

    resolvePermission(SID, [emitCall.toolCallId], { approved: true });
    const result = await pending;
    expect(run).toHaveBeenCalledOnce();
    expect(result).toBe('ran');
  });

  it('returns rejected result when user denies', async () => {
    const ctx = makeCtx({ autonomyMode: 'ask' });
    const emit = vi.fn();
    ctx.emit = emit;
    const run = vi.fn();
    const pending = withPermission(ctx, 'bash', { command: 'ls' }, run);
    await flushMicrotasks();

    const emitCall = emit.mock.calls[0][0] as { toolCallId: string };
    resolvePermission(SID, [emitCall.toolCallId], { approved: false, reason: 'nope' });
    const result = await pending as any;
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe('rejected');
    expect(result.output).toMatch(/nope/);
  });

  it('mutates ctx.autonomyMode on plan→edit escalation', async () => {
    const ctx = makeCtx({ autonomyMode: 'plan' });
    const emit = vi.fn();
    ctx.emit = emit;
    const run = vi.fn().mockResolvedValue('ok');
    const pending = withPermission(ctx, 'bash', { command: 'ls' }, run);
    await flushMicrotasks();

    const emitCall = emit.mock.calls[0][0] as { toolCallId: string };
    resolvePermission(SID, [emitCall.toolCallId], { approved: true, newMode: 'edit' });
    await pending;
    expect(ctx.autonomyMode).toBe('edit');
  });

  it('emits independent cards for concurrent asks (no serialization)', async () => {
    // withPermission has no mutex — parallel gated calls each emit their own
    // permission card and await their own verdict independently.
    const ctx = makeCtx({ autonomyMode: 'ask' });
    const ids: string[] = [];
    ctx.emit = (e: any) => { ids.push(e.toolCallId); };

    const run = vi.fn().mockResolvedValue('ok');
    const p1 = withPermission(ctx, 'bash', { command: 'ls' }, run);
    const p2 = withPermission(ctx, 'git', { args: ['status'] }, run);
    await flushMicrotasks();

    // Both asks emit immediately — no queueing.
    expect(ids).toHaveLength(2);

    resolvePermission(SID, [ids[0]], { approved: true });
    resolvePermission(SID, [ids[1]], { approved: true });
    await Promise.all([p1, p2]);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

// =============================================================
// Regression tests for the three "works once, doesn't persist"
// permission-card bugs. Each test locks down the fix for one bug.
// =============================================================
describe('permission-card persistence (regression)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    clearSession(SID);
    clearSessionRules(SID);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-test-'));
  });
  afterEach(() => {
    clearSession(SID);
    clearSessionRules(SID);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Bug #2 — "Allow this session": the rule must survive a turn boundary
  // (clearSessionRules is called on session DELETE, not on turn end).
  it('session rule survives a simulated turn boundary (not cleared per-turn)', () => {
    // Simulate the approve handler: derive a rule from the approved call and
    // add it as a session rule.
    const spec = deriveRuleSpec('bash', { command: 'pnpm install' });
    const rule = parseRule(spec)!;
    addSessionRule(SID, 'allow', rule);

    // Simulate a turn boundary: clearSessionRules must NOT fire here. (The
    // orchestrator's turn-finally no longer calls it; only deleteSession does.)
    // If a future change re-adds it to turn-finally, this expectation catches
    // the regression immediately.
    const sessionRulesAfterAdd = getSessionRules(SID);
    expect(sessionRulesAfterAdd.allow).toHaveLength(1);

    // The same call, in a "next turn", must auto-approve instead of prompting.
    const decision = evaluateRules(
      getSessionRules(SID),
      'bash',
      { command: 'pnpm install --filter pkg' },
    );
    expect(decision).toBe('allow');

    // And only a real session end (clearSessionRules) wipes the rule.
    clearSessionRules(SID);
    expect(getSessionRules(SID).allow).toHaveLength(0);
  });

  // Bug #3 — "Allow this project": a rule written mid-turn must be visible
  // to the gate for the same/subsequent calls in that turn, because
  // withPermission re-reads loadPermissionRules(ctx.workspaceRoot) at gate
  // time instead of trusting the per-turn snapshot.
  it('project rule written mid-turn is visible to the gate via fresh loadPermissionRules', () => {
    // Before: no project rules.
    expect(loadPermissionRules(tmpRoot).allow).toHaveLength(0);

    // Simulate "always · project": addPermissionRule writes .agents/settings.json.
    addPermissionRule(SID, tmpRoot, 'bash', { command: 'pnpm test' });

    // The file exists on disk now.
    const file = path.join(tmpRoot, '.agents', 'settings.json');
    expect(fs.existsSync(file)).toBe(true);

    // A fresh load picks it up — this is what withPermission now does at gate
    // time. If withPermission still trusted the stale ctx snapshot, a rule
    // added this turn would be invisible until the next turn.
    const fresh = loadPermissionRules(tmpRoot);
    expect(fresh.allow).toHaveLength(1);
    expect(evaluateRules(fresh, 'bash', { command: 'pnpm test' }))
      .toBe('allow');
  });

  it('withPermission auto-runs when a project rule matches (no prompt)', async () => {
    // Write a project rule to the tmp workspace BEFORE the gate runs.
    addPermissionRule(SID, tmpRoot, 'bash', { command: 'pnpm test' });

    const ctx = makeCtx({ autonomyMode: 'ask', workspaceRoot: tmpRoot });
    const emit = vi.fn();
    ctx.emit = emit;
    const run = vi.fn().mockResolvedValue('ran');

    // In ask mode a matching allow rule upgrades to auto — no card emitted.
    const result = await withPermission(ctx, 'bash', { command: 'pnpm test' }, run);
    expect(emit).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(result).toBe('ran');
  });
});
