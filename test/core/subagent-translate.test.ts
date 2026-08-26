import { describe, expect, it } from 'vitest';
import {
  translateSubagentPart,
  type SubagentBlockIds,
} from '../../app/core/agent/agents/runtime.js';
import type { EmitToolEvent } from '../../app/core/agent/tools/tool-context.js';

type Emitted = Parameters<EmitToolEvent>[0];

function harness() {
  const events: Emitted[] = [];
  const emit: EmitToolEvent = (e) => events.push(e);
  return { events, emit };
}

function reasoningDelta(id: string, text = 'thinking') {
  return { type: 'reasoning-delta', id, text };
}

function textDelta(id: string, text = 'narration') {
  return { type: 'text-delta', id, text };
}

const TOOL_INPUT_START = { type: 'tool-input-start', id: 'call_1', toolName: 'grep' };
const TOOL_CALL = { type: 'tool-call', toolCallId: 'call_2', toolName: 'grep', input: {} };

describe('translateSubagentPart segment ids across tool boundaries', () => {
  it('reasoning deltas sharing a provider part id across a tool boundary get distinct block ids', () => {
    const { events, emit } = harness();
    const ids: SubagentBlockIds = {};
    translateSubagentPart(reasoningDelta('rs_1'), emit, 'parent', ids);
    translateSubagentPart(TOOL_INPUT_START, emit, 'parent', ids);
    translateSubagentPart(reasoningDelta('rs_1'), emit, 'parent', ids);
    const reasoning = events.filter((e) => e.type === 'reasoning');
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0].blockId).not.toBe(reasoning[1].blockId);
  });

  it('text deltas sharing a provider part id across a tool boundary get distinct block ids', () => {
    const { events, emit } = harness();
    const ids: SubagentBlockIds = {};
    translateSubagentPart(textDelta('t_1'), emit, 'parent', ids);
    translateSubagentPart(TOOL_INPUT_START, emit, 'parent', ids);
    translateSubagentPart(textDelta('t_1'), emit, 'parent', ids);
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].blockId).not.toBe(deltas[1].blockId);
  });

  it('consecutive reasoning deltas without a tool between share one block id', () => {
    const { events, emit } = harness();
    const ids: SubagentBlockIds = {};
    translateSubagentPart(reasoningDelta('rs_1'), emit, 'parent', ids);
    translateSubagentPart(reasoningDelta('rs_1'), emit, 'parent', ids);
    const reasoning = events.filter((e) => e.type === 'reasoning');
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0].blockId).toBe(reasoning[1].blockId);
  });

  it('consecutive text deltas without a tool between share one block id', () => {
    const { events, emit } = harness();
    const ids: SubagentBlockIds = {};
    translateSubagentPart(textDelta('t_1'), emit, 'parent', ids);
    translateSubagentPart(textDelta('t_1'), emit, 'parent', ids);
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].blockId).toBe(deltas[1].blockId);
  });

  it('tool-call (not just tool-input-start) resets both segment ids', () => {
    const { events, emit } = harness();
    const ids: SubagentBlockIds = {};
    translateSubagentPart(reasoningDelta('rs_1'), emit, 'parent', ids);
    translateSubagentPart(textDelta('t_1'), emit, 'parent', ids);
    translateSubagentPart(TOOL_CALL, emit, 'parent', ids);
    translateSubagentPart(reasoningDelta('rs_1'), emit, 'parent', ids);
    translateSubagentPart(textDelta('t_1'), emit, 'parent', ids);
    const reasoning = events.filter((e) => e.type === 'reasoning');
    const deltas = events.filter((e) => e.type === 'delta');
    expect(reasoning).toHaveLength(2);
    expect(deltas).toHaveLength(2);
    expect(reasoning[0].blockId).not.toBe(reasoning[1].blockId);
    expect(deltas[0].blockId).not.toBe(deltas[1].blockId);
  });
});
