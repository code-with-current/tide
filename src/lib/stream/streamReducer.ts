/**
 * The block-stream reducer. Pure: (state, event) → state. One transition
 * per AgentEvent. This is the only place block mutations happen during
 * streaming.
 *
 * Invariants:
 *  - The reducer NEVER generates UUIDs. The orchestrator assigns ids at
 *    event emission time (spec §2). The reducer just uses them.
 *  - Each case returns a new `BlockStreamState`. The blocks array is
 *    always a new reference when anything changed; unchanged blocks keep
 *    their original reference so memoized leaves can skip re-rendering.
 *  - Tool block ids ALWAYS equal their toolCallId (asserted on creation).
 */

import type { SessionStream, ToolCallStatus } from '@/types';
import type { Block, FollowupBlock, ReasoningBlock, TextBlock, ToolBlock } from '@/types';
import type { AgentEvent } from '@/lib/agent/events';
import { categorizeTool, deriveFollowupMode } from './blockState';
import { createLogger } from '@/lib/logger';

const log = createLogger('streamReducer');

export function reduceStream(state: SessionStream, event: AgentEvent): SessionStream {
  switch (event.type) {
    case 'delta':              return applyDelta(state, event);
    case 'reasoning':          return applyReasoning(state, event);
    case 'tool_call_start':    return applyToolStart(state, event);
    case 'tool_call_delta':    return applyToolDelta(state, event);
    case 'tool_call':          return applyToolArgs(state, event);
    case 'tool_executing':     return applyToolStatus(state, event, 'running');
    case 'tool_result':        return applyToolResult(state, event);
    case 'usage':              return { ...state, usage: event.tokens, iteration: event.iteration };
    // permission_required is owned by applyLegacyEvent (useChatStream) — it's a
    // legacy field, not part of the block model. Handling it here too meant
    // permissionRequest was double-managed (harmless via dedupe, but a binding
    // smell). No-op here keeps the block reducer out of permission state.
    case 'permission_required': return state;
    case 'retry':              return state; // retry state is managed by applyLegacyEvent
    case 'turn_end':           return applyTurnEnd(state, event);
    case 'error':
      return { ...state, error: event.message, isStreaming: false };
    default:                   return state;
  }
}

// ─── Delta: append text to the active text block, or push a new one ──────

function applyDelta(state: SessionStream, e: Extract<AgentEvent, { type: 'delta' }>): SessionStream {
  const blocks = state.blocks ?? [];
  const last = blocks[blocks.length - 1];
  if (last && last.kind === 'text' && last.id === e.blockId) {
    // Append to the active text block — same id means same segment.
    const updated: TextBlock = {
      ...last, text: last.text + e.text, modifiedAtSeq: e.seq,
    };
    return { ...state, blocks: [...blocks.slice(0, -1), updated] };
  }
  // Different id (or last wasn't text) — push a new block.
  const block: TextBlock = {
    id: e.blockId, kind: 'text', text: e.text,
    createdAtSeq: e.seq, modifiedAtSeq: e.seq, isAnswer: false,
  };
  return { ...state, blocks: [...blocks, block] };
}

// ─── Reasoning: single growing block per turn (shares id) ───────────────

function applyReasoning(state: SessionStream, e: Extract<AgentEvent, { type: 'reasoning' }>): SessionStream {
  const blocks = state.blocks ?? [];
  const existing = blocks.find(b => b.id === e.blockId);
  if (existing && existing.kind === 'reasoning') {
    const updated: ReasoningBlock = {
      ...existing, text: existing.text + e.delta, modifiedAtSeq: e.seq,
    };
    return { ...state, blocks: blocks.map(b => b.id === e.blockId ? updated : b) };
  }
  const block: ReasoningBlock = {
    id: e.blockId, kind: 'reasoning', text: e.delta,
    createdAtSeq: e.seq, modifiedAtSeq: e.seq,
  };
  return { ...state, blocks: [...blocks, block] };
}

// ─── Tool start: append a tool block. blockId === toolCallId. ───────────

function applyToolStart(state: SessionStream, e: Extract<AgentEvent, { type: 'tool_call_start' }>): SessionStream {
  if (e.blockId !== e.toolCallId) {
    log.warn('tool blockId should equal toolCallId', e);
  }
  const blocks = state.blocks ?? [];
  const block: ToolBlock = {
    id: e.toolCallId, kind: 'tool',
    toolCallId: e.toolCallId, toolName: e.toolName,
    category: categorizeTool(e.toolName),
    status: 'pending', arguments: {}, argPreview: '', riskTier: 'read_only',
    createdAtSeq: e.seq, modifiedAtSeq: e.seq,
  };
  return {
    ...state,
    blocks: [...blocks, block],
    toolBlockIndex: { ...(state.toolBlockIndex ?? {}), [e.toolCallId]: blocks.length },
  };
}

// ─── Tool delta: mutation in place via toolBlockIndex lookup ────────────

function applyToolDelta(state: SessionStream, e: Extract<AgentEvent, { type: 'tool_call_delta' }>): SessionStream {
  const idx = state.toolBlockIndex?.[e.toolCallId];
  if (idx == null) return state;
  const blocks = state.blocks ?? [];
  const cur = blocks[idx];
  if (!cur || cur.kind !== 'tool') return state;
  let updated: ToolBlock;
  // Sub-agent report streams into `report` for dispatch_agent in running state.
  if (cur.status === 'running' && cur.toolName === 'dispatch_agent') {
    updated = { ...cur, report: (cur.report ?? '') + e.delta, modifiedAtSeq: e.seq };
  } else {
    updated = { ...cur, partialInput: (cur.partialInput ?? '') + e.delta, modifiedAtSeq: e.seq };
  }
  const next = blocks.slice();
  next[idx] = updated;
  return { ...state, blocks: next };
}

// ─── Tool args: update in place; also spawn followup block if applicable ─

function applyToolArgs(state: SessionStream, e: Extract<AgentEvent, { type: 'tool_call' }>): SessionStream {
  const idx = state.toolBlockIndex?.[e.toolCallId];
  if (idx == null) return state;
  const blocks = (state.blocks ?? []).slice();
  const cur = blocks[idx];
  if (!cur || cur.kind !== 'tool') return state;
  blocks[idx] = {
    ...cur,
    arguments: e.arguments,
    argPreview: e.argPreview,
    riskTier: e.riskTier,
    modifiedAtSeq: e.seq,
  };
  // Spawn or update a followup block if this is ask_followup_question.
  if (e.toolName === 'ask_followup_question') {
    const mode = deriveFollowupMode(e.arguments);
    if (mode) {
      const fb: FollowupBlock = {
        id: `${e.toolCallId}#followup`,
        kind: 'followup', mode, toolCallId: e.toolCallId,
        createdAtSeq: e.seq, modifiedAtSeq: e.seq,
      };
      const fidx = blocks.findIndex(b => b.id === fb.id);
      if (fidx >= 0) blocks[fidx] = fb; else blocks.push(fb);
    }
  }
  return { ...state, blocks };
}

// ─── Tool status: update in place (running, executed, etc.) ─────────────

function applyToolStatus(state: SessionStream, e: Extract<AgentEvent, { type: 'tool_executing' }>, status: ToolCallStatus): SessionStream {
  const idx = state.toolBlockIndex?.[e.toolCallId];
  if (idx == null) return state;
  const blocks = state.blocks ?? [];
  const cur = blocks[idx];
  if (!cur || cur.kind !== 'tool') return state;
  const next = blocks.slice();
  next[idx] = { ...cur, status, modifiedAtSeq: e.seq };
  return { ...state, blocks: next };
}

// ─── Tool result: update in place with the result payload ───────────────

function applyToolResult(state: SessionStream, e: Extract<AgentEvent, { type: 'tool_result' }>): SessionStream {
  const idx = state.toolBlockIndex?.[e.toolCallId];
  if (idx == null) return state;
  const blocks = state.blocks ?? [];
  const cur = blocks[idx];
  if (!cur || cur.kind !== 'tool') return state;
  const next = blocks.slice();
  next[idx] = {
    ...cur,
    status: e.status,
    output: e.output,
    display: e.display,
    durationMs: e.durationMs,
    meta: e.meta,
    modifiedAtSeq: e.seq,
  };
  return { ...state, blocks: next };
}

// ─── Turn end: finalize. Mark answer, abort running tools if aborted. ───

function applyTurnEnd(state: SessionStream, e: Extract<AgentEvent, { type: 'turn_end' }>): SessionStream {
  const stopped = e.stopReason === 'aborted';
  const prevBlocks = state.blocks ?? [];

  // Shallow-clone blocks so we can mark isAnswer on the answer-phase text
  // blocks without mutating the original (state.blocks is shared with prior states).
  const blocks: Block[] = prevBlocks.map(b => {
    if (stopped && b.kind === 'tool' && (b.status === 'running' || b.status === 'pending')) {
      return { ...b, status: 'aborted' as ToolCallStatus, modifiedAtSeq: e.seq };
    }
    if (b.kind === 'text') return { ...b };
    return b;
  });

  // The answer phase begins after the last tool call. Text before it is
  // narration (the model talking while working — "let me check…"); text
  // after is the deliverable. Treating every kind === 'tool' as the bound
  // — with no skip-set taxonomy — handles bookkeeping (todo_write), yields
  // (ask_followup_question), and real actions (bash/edit_file) uniformly,
  // and lets synthesized trailing followup blocks pass through without
  // breaking the scan. Mirrors orchestrator.finalizeBlocks and
  // blockMigration.redetermineAnswerFlag.
  let lastToolIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'tool') { lastToolIdx = i; break; }
  }
  for (let i = lastToolIdx + 1; i < blocks.length; i++) {
    if (blocks[i].kind === 'text') (blocks[i] as TextBlock).isAnswer = true;
  }

  return {
    ...state,
    blocks,
    isStreaming: false,
    stopReason: e.stopReason,
  };
}
