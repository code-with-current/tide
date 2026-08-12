import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';
import { createBashTool, runBash } from '../../agent/tools/bash.js';
import { toolMeta } from '../../agent/tools/tool-meta.js';
import { resolvePermission, clearSession } from '../../agent/permission-resolver.js';
import type { ToolContext } from '../../agent/tools/tool-context.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's_test',
    workspaceRoot: '/tmp/test-ws',
    autonomyMode: 'full',
    modelId: 'm_test',
    provider: { id: 'p', name: 'p', apiStyle: 'anthropic', baseUrl: '', enabled: true, models: [] } as any,
    compactionSettings: { enabled: true, threshold: 0.75, keepRecentTurns: 3, onFailure: 'truncate' },
    onUsage: () => {},
    emit: () => {},
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe('createBashTool (SDK factory)', () => {
  it('returns an SDK-shaped tool with description and inputSchema', () => {
    const t = createBashTool(makeCtx());
    expect(t.description).toBeTruthy();
    expect(t.inputSchema).toBeDefined();
    expect(typeof t.execute).toBe('function');
  });

  it('inputSchema validates { command: string }', () => {
    const t = createBashTool(makeCtx());
    const schema = t.inputSchema as unknown as z.ZodObject<{ command: z.ZodString }>;
    expect(schema.safeParse({ command: 'ls' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ command: 123 }).success).toBe(false);
  });

  it('does not duplicate metadata that lives in toolMeta', () => {
    const t = createBashTool(makeCtx()) as any;
    expect(t.riskTier).toBeUndefined();
    expect(t.autoApproveIn).toBeUndefined();
    expect(toolMeta.bash.riskTier).toBe('destructive');
  });
});

describe('runBash (shared body)', () => {
  it('rejects empty command', async () => {
    const result = await runBash('', '/tmp', 1000);
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/Missing required arg/);
  });

  it('refuses blocked patterns', async () => {
    const result = await runBash('sudo rm -rf /', '/tmp', 1000);
    expect(result.status).toBe('rejected');
    expect(result.output).toMatch(/blocked pattern/);
  });

  it('executes a safe command and reports success', async () => {
    const result = await runBash('echo hello-sumo', '/tmp', 5000);
    expect(result.status).toBe('executed');
    expect(result.output).toContain('hello-sumo');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports failure with non-zero exit', async () => {
    const result = await runBash('exit 7', '/tmp', 5000);
    expect(result.status).toBe('failed');
    expect(result.meta).toMatch(/exit 7/);
  });
});

// ─── Permission gating (Task 3.2) ─────────────────────────────────────
// bash is the highest-risk converted tool (destructive tier). This confirms
// createBashTool's execute routes through withPermission: it auto-runs in
// 'full' mode, and in 'ask' mode it emits a permission request and waits for
// the user's verdict before running (or returns a rejection on denial).
// Guards against a refactor silently unwrapping the gate.

describe('createBashTool permission gate', () => {
  beforeEach(() => {
    clearSession('s_gate');
  });

  /** SDK execute's second arg shape — only toolCallId/abortSignal matter here. */
  const sdkCtx = (id: string): any => ({
    toolCallId: id,
    messages: [],
    abortSignal: new AbortController().signal,
  });

  it('auto-runs in full mode (no prompt)', async () => {
    const ctx = makeCtx({ sessionId: 's_gate', workspaceRoot: '/tmp', autonomyMode: 'full' });
    const tool = createBashTool(ctx);
    const result: any = await tool.execute!({ command: 'echo gate-full' }, sdkCtx('tc_full'));
    expect(result.status).toBe('executed');
    expect(result.output).toContain('gate-full');
  });

  it('prompts in ask mode and runs only after approval', async () => {
    const emit = vi.fn();
    const ctx = makeCtx({ sessionId: 's_gate', workspaceRoot: '/tmp', autonomyMode: 'ask', emit });
    const tool = createBashTool(ctx);

    const pending = tool.execute!({ command: 'echo gate-ask' }, sdkCtx('tc_ask'));
    // Let the wrapper reach the await (permission slot + emit fire on microtasks).
    await flushMicrotasks();

    // Gate fired BEFORE the shell ran.
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'permission',
      toolName: 'bash',
    }));

    // Resolve with the actual toolCallId the gate emitted.
    const permEvent = emit.mock.calls[0][0] as { toolCallId: string };
    resolvePermission('s_gate', [permEvent.toolCallId], { approved: true });
    const result: any = await pending;
    expect(result.status).toBe('executed');
    expect(result.output).toContain('gate-ask');
  });

  it('returns rejected when the user denies', async () => {
    const emit = vi.fn();
    const ctx = makeCtx({ sessionId: 's_gate', workspaceRoot: '/tmp', autonomyMode: 'ask', emit });
    const tool = createBashTool(ctx);

    const pending = tool.execute!({ command: 'echo gate-deny' }, sdkCtx('tc_deny'));
    await flushMicrotasks();
    const permEvent = emit.mock.calls[0][0] as { toolCallId: string };
    resolvePermission('s_gate', [permEvent.toolCallId], { approved: false, reason: 'nope' });

    const result: any = await pending;
    expect(result.status).toBe('rejected');
    expect(result.output).toMatch(/nope/);
  });
});

/** Drain the microtask queue enough times for the per-session serialization
 *  chain (each ask wraps in a noop `.then` for ordering) to propagate. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
