/**
 * Regression test for orchestrator-sdk.ts — the parts→events translator.
 *
 * Mocks `streamText` to emit a canned sequence of TextStreamParts and
 * asserts the orchestrator produces the expected AgentEvent stream (for the
 * current renderer) in order, plus a well-formed turn_end.
 * well-formed turn_end.
 *
 * This is the regression-prone surface: every SDK part type must map to the
 * right legacy event(s) with the right fields. Adding a case to
 * translatePart without extending this test is how bugs sneak in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist the canned parts the fake streamText yields, plus a capture log.
// vi.mock factories are hoisted above imports, so they can only close over
// other hoisted bindings — hence vi.hoisted.
const harness = vi.hoisted(() => ({
  parts: [] as Array<Record<string, unknown>>,
  streamTextCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('ai', () => ({
  streamText: (opts: Record<string, unknown>) => {
    harness.streamTextCalls.push(opts);
    return {
      // Minimal AsyncIterable: yield each canned part in order, then stop.
      stream: {
        [Symbol.asyncIterator]: async function* () {
          for (const p of harness.parts) yield p;
        },
      },
      responseMessages: Promise.resolve([]),
    };
  },
  // Unused by the translator but imported at module load — stub trivially.
  isStepCount: () => () => false,
}));

vi.mock('../store.js', () => ({
  listProviders: () => [
    { id: 'p1', name: 'P', apiKey: 'k', apiStyle: 'anthropic', baseUrl: '', enabled: true, models: [] },
  ],
  listWorkspaces: () => [{ id: 'ws1', path: '/tmp/ws', isDefault: true }],
  listRagEnabledWorkspaces: () => [],
  // runSdkTurn reads agentSettings (maxSteps, permissionTimeoutMin) at turn
  // start to snapshot per-turn caps onto the SdkTurn. Return the defaults
  // from DEFAULT_AGENT_SETTINGS so the snapshot has sane values.
  getAgentSettings: () => ({
    defaultAutonomy: 'ask',
    maxSteps: 100,
    permissionTimeoutMin: 10,
    planModeDryRun: true,
    auditShellCommands: true,
  }),
}));
vi.mock('../ipc/sessions.js', () => ({
  getSession: () => undefined,
  // setActiveSkillRef is called when a [[LOAD_SKILL:...]] marker is processed.
  // No-op in tests — we don't assert persistence side-effects here.
  setActiveSkillRef: () => undefined,
}));
vi.mock('../agent/project-context.js', () => ({
  // Empty skills list — the discovery index is skipped when no skills exist.
  scanProjectEntries: () => ({ contextFiles: [], skills: [], agents: [] }),
}));
vi.mock('../agent/provider-factory.js', () => ({ resolveModel: () => ({}) }));
vi.mock('../agent/tools/registry.js', () => ({
  buildToolset: () => ({}),
  formatArgPreview: () => '',
  // resolveToolName applies the cross-model alias map (e.g. local_shell_call →
  // bash). In tests the canned parts already use canonical names, so the
  // identity passthrough is the correct mock behavior.
  resolveToolName: (n: string) => n,
}));
// Empty todo list — the todo gate is skipped when no todos exist.
vi.mock('../agent/tools/todo-write.js', () => ({ getSessionTodos: () => [] }));

import { runSdkTurn } from '../agent/orchestrator-sdk.js';
import { AGENT_EVENT_CHANNEL } from '../../src/lib/agent/events.js';
import type { RunTurnPayload } from '../../src/lib/agent/events.js';

/** Minimal WebContents double — captures every send() keyed by channel. */
function makeWc() {
  const byChannel: Record<string, unknown[]> = { [AGENT_EVENT_CHANNEL]: [] };
  return {
    byChannel,
    isDestroyed: () => false,
    send(channel: string, evt: unknown) {
      (byChannel[channel] ??= []).push(evt);
    },
  } as any;
}

function basePayload(overrides: Partial<RunTurnPayload> = {}): RunTurnPayload {
  return {
    sessionId: 's_sdk_test',
    modelId: 'm',
    providerId: 'p1',
    autonomyMode: 'full',
    thinkingLevel: 'off',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

/** A finish-step/finish LanguageModelUsage stub with the nested detail shape. */
function usage(input: number, output: number) {
  return {
    inputTokens: input,
    outputTokens: output,
    inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: input },
    outputTokenDetails: { reasoningTokens: 0, textTokens: output },
    totalTokens: input + output,
  };
}

describe('orchestrator-sdk runSdkTurn', () => {
  beforeEach(() => {
    harness.parts.length = 0;
    harness.streamTextCalls.length = 0;
  });

  it('translates the full part sequence into ordered AgentEvents', async () => {
    harness.parts.push(
      { type: 'text-delta', id: 't1', text: 'Hello ' },
      { type: 'text-delta', id: 't1', text: 'world' },
      { type: 'tool-input-start', id: 'tc1', toolName: 'read_file' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'read_file', input: { path: '/a' } },
      {
        type: 'tool-result',
        toolCallId: 'tc1',
        toolName: 'read_file',
        input: { path: '/a' },
        output: { status: 'executed', output: 'file contents' },
      },
      { type: 'text-delta', id: 't2', text: 'Done.' },
      { type: 'finish-step', usage: usage(10, 5), finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop', totalUsage: usage(10, 5) },
    );

    const wc = makeWc();
    await runSdkTurn(wc, basePayload());

    const events = wc.byChannel[AGENT_EVENT_CHANNEL] as any[];
    const types = events.map((e) => e.type);

    // Order matters: deltas, tool lifecycle, trailing delta, usage, turn_end.
    expect(types).toEqual([
      'delta',
      'delta',
      'tool_call_start',
      'tool_call',
      'tool_executing',
      'tool_result',
      'delta',
      'usage',
      'turn_end',
    ]);

    // Trailing text (after the tool) is the answer.
    const turnEnd = events.find((e) => e.type === 'turn_end');
    expect(turnEnd.stopReason).toBe('end_turn');
    expect(turnEnd.content).toContain('Hello world');
    expect(turnEnd.content).toContain('Done.');
    expect(turnEnd.toolCalls).toHaveLength(1);
    expect(turnEnd.toolCalls[0].toolName).toBe('read_file');
    expect(turnEnd.toolCalls[0].status).toBe('executed');
    // Aggregate usage carried into turn_end.
    expect(turnEnd.usage.inputTokens).toBe(10);
    expect(turnEnd.usage.outputTokens).toBe(5);
  });

  it('marks trailing text as the answer and leaves pre-tool text as narration', async () => {
    // text → tool → text: only the second text block is the answer.
    harness.parts.push(
      { type: 'text-delta', id: 't1', text: 'Let me check.' },
      { type: 'tool-input-start', id: 'tc1', toolName: 'read_file' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'read_file', input: {} },
      { type: 'tool-result', toolCallId: 'tc1', toolName: 'read_file', input: {}, output: { status: 'executed', output: 'ok' } },
      { type: 'text-delta', id: 't2', text: 'Here is the answer.' },
      { type: 'finish-step', usage: usage(1, 1), finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop', totalUsage: usage(1, 1) },
    );

    const wc = makeWc();
    await runSdkTurn(wc, basePayload());

    const turnEnd = (wc.byChannel[AGENT_EVENT_CHANNEL] as any[]).find((e) => e.type === 'turn_end');
    const textBlocks = turnEnd.blocks.filter((b: any) => b.kind === 'text');
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0].isAnswer).toBe(false); // narration
    expect(textBlocks[1].isAnswer).toBe(true); // trailing = answer
    expect(turnEnd.answer ?? turnEnd.content).toContain('Here is the answer.');
  });

  it('emits turn_end with stopReason "aborted" when the stream aborts', async () => {
    harness.parts.push(
      { type: 'text-delta', id: 't1', text: 'Partial' },
      { type: 'abort', reason: 'user' },
    );

    const wc = makeWc();
    await runSdkTurn(wc, basePayload());

    const turnEnd = (wc.byChannel[AGENT_EVENT_CHANNEL] as any[]).find((e) => e.type === 'turn_end');
    expect(turnEnd.stopReason).toBe('aborted');
    // Partial text is preserved, not dropped.
    expect(turnEnd.content).toContain('Partial');
  });

  it('classifies a stream error as an error event (not a crash)', async () => {
    harness.parts.push({ type: 'error', error: new Error('boom') });

    const wc = makeWc();
    await runSdkTurn(wc, basePayload());

    const events = wc.byChannel[AGENT_EVENT_CHANNEL] as any[];
    // The error is recorded; the loop still emits turn_end (no throw escapes).
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
