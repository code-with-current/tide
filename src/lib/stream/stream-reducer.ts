/** The block-stream reducer — pure `(state, event) → state`. Orchestrator assigns block ids; tool-block ids always equal their toolCallId. Unchanged blocks keep their reference for memoized leaves. */

import type { SessionStream, ToolCallStatus } from '@/types';
import type { Block, FollowupBlock, ReasoningBlock, TextBlock, ToolBlock } from '@/types';
import type { AgentEvent } from '@/lib/agent/events';
import { categorizeTool, deriveFollowupMode, answerBlockIds } from './block-state';
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
    case 'dispatch_result':    return applyDispatchResult(state, event);
    case 'usage':              return { ...state, usage: event.tokens, iteration: event.iteration };
    // permission_required is owned by applyLegacyEvent (useChatStream) — it's a
    // legacy field, not part of the block model. Handling it here too meant
    // permissionRequest was double-managed (harmless via dedupe, but a binding
    // smell). No-op here keeps the block reducer out of permission state.
    case 'permission_required': return state;
    case 'retry':              return state; // retry state is managed by applyLegacyEvent
    case 'turn_end':           return applyTurnEnd(state, event);
    case 'error':
      // Record the error but do NOT end the stream here — the orchestrator may
      // still retry. Only `turn_end` ends the turn, so the error UI (gated on
      // !isStreaming) stays hidden during the retry cycle and surfaces once
      // retries are exhausted. Prevents the error block from flashing on and
      // off between attempts.
      return { ...state, error: event.message };
    default:                   return state;
  }
}

// ─── Delta: append text to the active text block, or push a new one ──────

function applyDelta(state: SessionStream, e: Extract<AgentEvent, { type: 'delta' }>): SessionStream {
  const blocks = state.blocks ?? [];
  // Merge into the LAST block with the same id AND parentage — not the
  // array's last block. Concurrent sub-agents interleave parented deltas
  // (plus tool events) between one agent's deltas, so a segment's block is
  // almost never globally-last; last-block-only merging fragments every
  // delta into a duplicate-id block and the panel renders them all.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== 'text' || b.id !== e.blockId) continue;
    if ((b.parentToolCallId ?? undefined) !== e.parentToolCallId) continue;
    const updated: TextBlock = {
      ...b, text: b.text + e.text, modifiedAtSeq: e.seq,
    };
    const next = blocks.slice();
    next[i] = updated;
    return { ...state, blocks: next };
  }
  const block: TextBlock = {
    id: e.blockId, kind: 'text', text: e.text,
    createdAtSeq: e.seq, modifiedAtSeq: e.seq, isAnswer: false,
    ...(e.parentToolCallId ? { parentToolCallId: e.parentToolCallId } : {}),
  };
  return { ...state, blocks: [...blocks, block] };
}

// ─── Reasoning: single growing block per turn (shares id) ───────────────

function applyReasoning(state: SessionStream, e: Extract<AgentEvent, { type: 'reasoning' }>): SessionStream {
  const blocks = state.blocks ?? [];
  const existing = blocks.find(b => b.id === e.blockId && b.kind === 'reasoning'
    && (b.parentToolCallId ?? undefined) === e.parentToolCallId);
  if (existing && existing.kind === 'reasoning') {
    const updated: ReasoningBlock = {
      ...existing, text: existing.text + e.delta, modifiedAtSeq: e.seq,
    };
    return { ...state, blocks: blocks.map(b => b.id === e.blockId ? updated : b) };
  }
  const block: ReasoningBlock = {
    id: e.blockId, kind: 'reasoning', text: e.delta,
    createdAtSeq: e.seq, modifiedAtSeq: e.seq,
    ...(e.parentToolCallId ? { parentToolCallId: e.parentToolCallId } : {}),
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
    // Carry the sub-agent origin marker so the renderer can nest this block
    // under its dispatch_agent parent. Undefined for top-level tool calls.
    ...(e.parentToolCallId ? { parentToolCallId: e.parentToolCallId } : {}),
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

// ─── Background dispatch finished: fold the terminal state onto its row ──

function applyDispatchResult(state: SessionStream, e: Extract<AgentEvent, { type: 'dispatch_result' }>): SessionStream {
  const blocks = state.blocks ?? [];
  let touched = false;
  const next = blocks.map((b) => {
    if (b.kind !== 'tool') return b;
    const d = b.display;
    if (d?.kind !== 'agent' || d.dispatchId !== e.dispatchId || d.backgroundState === e.state) return b;
    touched = true;
    return { ...b, display: { ...d, backgroundState: e.state }, modifiedAtSeq: e.seq };
  });
  if (touched) return { ...state, blocks: next };
  // A background row returns before its child session exists, so its display
  // never carries the dispatchId the event matches on — fall back to the
  // session's single id-less still-running background row. More than one
  // candidate is ambiguous; leave them untouched rather than guess.
  const candidateIdxs = next
    .map((b, i) => {
      if (b.kind !== 'tool' || b.display?.kind !== 'agent') return -1;
      const d = b.display;
      return d.background === true && !d.dispatchId && !d.backgroundState ? i : -1;
    })
    .filter((i) => i >= 0);
  if (candidateIdxs.length !== 1) return state;
  const i = candidateIdxs[0];
  const b = next[i];
  if (b.kind !== 'tool' || b.display?.kind !== 'agent') return state;
  next[i] = { ...b, display: { ...b.display, backgroundState: e.state }, modifiedAtSeq: e.seq };
  return { ...state, blocks: next };
}

// ─── Turn end: finalize. Mark answer, abort running tools if aborted. ───

function applyTurnEnd(state: SessionStream, e: Extract<AgentEvent, { type: 'turn_end' }>): SessionStream {
  const stopped = e.stopReason === 'aborted';
  const prevBlocks = state.blocks ?? [];

  // Shallow-clone blocks so we can mark isAnswer per parent scope without
  // mutating the original (state.blocks is shared with prior states).
  const blocks: Block[] = prevBlocks.map(b => {
    if (stopped && b.kind === 'tool' && (b.status === 'running' || b.status === 'pending')) {
      return { ...b, status: 'aborted' as ToolCallStatus, modifiedAtSeq: e.seq };
    }
    if (b.kind === 'text') return { ...b };
    return b;
  });

  // The answer phase is SCOPE-LOCAL: per scope (root / each dispatch), text
  // after that scope's last work tool is that scope's deliverable. Mirrors
  // orchestrator.finalizeBlocks and blockMigration.redetermineAnswerFlag —
  // a sub-agent's report must flag as its own answer even though the parent
  // keeps calling tools afterwards.
  const answers = answerBlockIds(blocks);
  for (const b of blocks) {
    if (b.kind === 'text') (b as TextBlock).isAnswer = answers.has(b.id);
  }

  return {
    ...state,
    blocks,
    isStreaming: false,
    stopReason: e.stopReason,
  };
}
