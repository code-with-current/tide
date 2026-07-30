/**
 * One-shot adapter for messages persisted before the block-stream era.
 * Pure function: same input → same output, every time. Called from the
 * session loader on every message. Idempotent — messages already in
 * block form pass through unchanged.
 *
 * Block id scheme for migrated data (deterministic, no UUIDs):
 *   text block:     `msg_${message.id}_text_${index}`
 *   reasoning:      `msg_${message.id}_reasoning`
 *   tool block:     the toolCallId itself (matches the live wire format)
 *   followup:       `${toolCallId}#followup` (matches the live wire format)
 */

import type {
  Block,
  FollowupBlock,
  Message,
  ReasoningBlock,
  TextBlock,
  ToolBlock,
  ToolCall,
} from '@/types';
import { categorizeTool, deriveFollowupMode } from './blockState';

/** Convert a legacy ToolCall into a ToolBlock. Mirrors the live wire
 *  format (block id = toolCallId). */
export function toolCallToBlock(call: ToolCall): ToolBlock {
  return {
    id: call.id,
    kind: 'tool',
    toolCallId: call.id,
    toolName: call.toolName,
    category: categorizeTool(call.toolName),
    status: call.status,
    arguments: call.arguments,
    argPreview: call.argPreview,
    partialInput: call._partialInput,
    riskTier: call.riskTier,
    output: call.output,
    display: call.display,
    durationMs: call.durationMs,
    meta: call.meta,
    createdAtSeq: 0,
    modifiedAtSeq: 0,
  };
}

/** Redetermine the `isAnswer` flag on every text block using the same
 *  rule as streamReducer.applyTurnEnd and orchestrator.finalizeBlocks:
 *  the answer phase begins after the last tool call, so every text block
 *  after the final `kind === 'tool'` is the answer; everything before is
 *  narration. Bookkeeping (todo_write), yields (ask_followup_question),
 *  and real actions (bash/edit_file) all bound the answer phase
 *  identically — no skip-set taxonomy needed. Synthesized trailing
 *  followup blocks don't count as tools, so prose after a clarifying-
 *  question turn is captured (the prior walk-back rule broke on those
 *  trailing followups and left the answer unmarked, surfacing as
 *  "No summary — this turn was tool-only.").
 *
 *  Idempotent. Cheap. Used by the migration to repair messages saved
 *  by earlier builds.
 *
 *  Returns a new message with a new blocks array; original is untouched. */
function redetermineAnswerFlag(message: Message): Message {
  if (!message.blocks || message.blocks.length === 0) return message;
  const blocks = message.blocks.map(b =>
    b.kind === 'text' ? { ...b, isAnswer: false } : b,
  );
  let lastToolIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'tool') { lastToolIdx = i; break; }
  }
  for (let i = lastToolIdx + 1; i < blocks.length; i++) {
    if (blocks[i].kind === 'text') (blocks[i] as TextBlock).isAnswer = true;
  }
  return { ...message, blocks };
}

/** Heal a block list using the legacy `toolCalls` array as the source of
 *  truth for tool status/display/output/duration. Preserves the block
 *  ordering and identity (so React keys don't shift) and leaves non-tool
 *  blocks (text/reasoning/followup) untouched.
 *
 *  Also ensures a followup block exists for every ask_followup_question
 *  call — without this, persisted messages saved by the earlier broken
 *  orchestrator (which didn't spawn followup blocks in finalizeBlocks)
 *  would never fire the options popup on reload.
 *
 *  Idempotent: if blocks are already in sync with toolCalls, the patch
 *  is a no-op (same field values reapplied). Safe to run on every load. */
function reconcileBlocksWithToolCalls(message: Message): Message {
  const callsById = new Map<string, ToolCall>();
  for (const c of message.toolCalls ?? []) callsById.set(c.id, c);
  const blocks = (message.blocks ?? []).map(b => {
    if (b.kind !== 'tool') return b;
    const call = callsById.get(b.toolCallId);
    if (!call) return b;
    // Patch with the legacy fields. Status is the critical one; the
    // others (display/output/durationMs/meta) may also have been missing.
    return {
      ...b,
      status: call.status,
      output: call.output,
      display: call.display,
      durationMs: call.durationMs,
      meta: call.meta,
      arguments: call.arguments,
      argPreview: call.argPreview,
      riskTier: call.riskTier,
    } as ToolBlock;
  });

  // Spawn followup blocks for ask_followup_question calls that don't have
  // one yet. Mirrors streamReducer.applyToolArgs + orchestrator.finalizeBlocks.
  for (const b of blocks) {
    if (b.kind !== 'tool') continue;
    if (b.toolName !== 'ask_followup_question') continue;
    const mode = deriveFollowupMode(b.arguments);
    if (!mode) continue;
    const fbId = `${b.toolCallId}#followup`;
    const existing = blocks.find(x => x.id === fbId);
    if (existing) continue;
    blocks.push({
      id: fbId,
      kind: 'followup',
      mode,
      toolCallId: b.toolCallId,
      createdAtSeq: 0,
      modifiedAtSeq: 0,
    } as FollowupBlock);
  }

  return { ...message, blocks };
}

export function migrateMessageToBlocks(message: Message): Message {
  // Reconciliation pass — happens whenever blocks exist alongside legacy
  // toolCalls. We use toolCalls as the source of truth for tool block
  // status/display/output/durationMs because they were maintained by a
  // separate, earlier code path that survived multiple orchestrator bugs.
  // Healing is idempotent: if blocks are already in sync with toolCalls,
  // the patch is a no-op (same field values). This runs on every load.
  if (message.blocks && message.blocks.length > 0 && message.toolCalls && message.toolCalls.length > 0) {
    return redetermineAnswerFlag(reconcileBlocksWithToolCalls(message));
  }

  // Pass-through if already migrated (and no toolCalls to reconcile from).
  // Still redetermine isAnswer in case the message was saved by an earlier
  // build with the stricter "only the last text block" rule.
  if (message.blocks && message.blocks.length > 0) {
    return redetermineAnswerFlag(message);
  }


  const blocks: Block[] = [];

  // 1. Reasoning block first (matches live emission order).
  if (message.reasoning) {
    blocks.push({
      id: `msg_${message.id}_reasoning`,
      kind: 'reasoning',
      text: message.reasoning,
      tokens: message.reasoningTokens,
      ms: message.reasoningMs,
      createdAtSeq: 0,
      modifiedAtSeq: 0,
    } satisfies ReasoningBlock);
  }

  const timeline = message.timeline ?? [];
  const calls = message.toolCalls ?? [];

  // No timeline → fall back to a single text block from `content`.
  if (timeline.length === 0) {
    if (message.content) {
      blocks.push({
        id: `msg_${message.id}_text_0`,
        kind: 'text',
        text: message.content,
        createdAtSeq: 0,
        modifiedAtSeq: 0,
        isAnswer: true,
      } satisfies TextBlock);
    }
    // Even without a timeline, we still need to add tool blocks + followup
    // blocks for ask_followup_question calls — otherwise the popup wouldn't
    // fire on reload for messages saved before the block-stream era.
    for (const call of calls) {
      blocks.push(toolCallToBlock(call));
    }
    for (const call of calls) {
      if (call.toolName !== 'ask_followup_question') continue;
      const mode = deriveFollowupMode(call.arguments);
      if (mode) {
        blocks.push({
          id: `${call.id}#followup`,
          kind: 'followup',
          mode,
          toolCallId: call.id,
          createdAtSeq: 0,
          modifiedAtSeq: 0,
        } satisfies FollowupBlock);
      }
    }
    return { ...message, blocks };
  }

  // 2. Walk the timeline — text entries → text blocks; tool entries →
  //    tool blocks (look up by index).
  let textIdx = 0;
  for (const entry of timeline) {
    if (entry.type === 'text') {
      blocks.push({
        id: `msg_${message.id}_text_${textIdx++}`,
        kind: 'text',
        text: entry.text,
        createdAtSeq: 0,
        modifiedAtSeq: 0,
        isAnswer: false,    // set in the next pass
      } satisfies TextBlock);
      continue;
    }
    const call = calls[entry.toolIndex];
    if (!call) continue;
    blocks.push(toolCallToBlock(call));
  }

  // 3. Mark the answer: every text block after the last tool call. Matches
  //    the live reducer's applyTurnEnd and redetermineAnswerFlag above.
  //    Text before the last tool is narration; text after is the deliverable.
  let lastToolIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'tool') { lastToolIdx = i; break; }
  }
  for (let i = lastToolIdx + 1; i < blocks.length; i++) {
    if (blocks[i].kind === 'text') (blocks[i] as TextBlock).isAnswer = true;
  }

  // 4. Derive followup blocks for every ask_followup_question call.
  //    (Earlier code only added one for the last call — but a turn can have
  //    multiple followup questions, each needs its own block.)
  for (const call of calls) {
    if (call.toolName !== 'ask_followup_question') continue;
    const mode = deriveFollowupMode(call.arguments);
    if (mode) {
      blocks.push({
        id: `${call.id}#followup`,
        kind: 'followup',
        mode,
        toolCallId: call.id,
        createdAtSeq: 0,
        modifiedAtSeq: 0,
      } satisfies FollowupBlock);
    }
  }

  return { ...message, blocks };
}

/** Migrate a whole message list. Convenience for the session loader. */
export function migrateMessagesToBlocks(messages: Message[]): Message[] {
  return messages.map(migrateMessageToBlocks);
}
