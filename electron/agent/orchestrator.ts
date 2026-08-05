/** The agent loop: orchestrates multi-step model calls with tool execution until end_turn or the iteration cap. */

import type { WebContents } from 'electron';
import * as store from '../store.js';
import * as sessions from '../ipc/sessions.js';
import { createLogger } from '../logger.js';
import { getAnthropicTools, getRegistration, executeTool, formatArgPreview } from './tools/registry';
import { streamAnthropicOnce } from './stream-anthropic';
import { checkPermission } from './permission';
import type { AnthropicContent, AnthropicMessage } from './stream-anthropic';

const log = createLogger('agent');
import type {
  AgentEvent,
  RunTurnPayload,
  TurnMessage,
} from '../../src/lib/agent/events';
import type { AutonomyMode, Provider, ToolCall, Usage } from '../../src/types/index';
import { AGENT_EVENT_CHANNEL, AGENT_COMMANDS } from '../../src/lib/agent/events';
import type { Block, FollowupBlock, TextBlock, ReasoningBlock, ToolBlock } from '../../src/types/block';
import { categorizeTool, deriveFollowupMode } from '../../src/lib/stream/blockState';

const MAX_ITERATIONS = 100;
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

/** Tide thinking level → Anthropic `thinking.budget_tokens`; `off` disables thinking. max_tokens must exceed budget_tokens (enforced in stream-anthropic.ts). */
const THINKING_BUDGET: Record<string, number> = {
  low: 1_024,
  medium: 8_000,
  high: 24_000,
  extra: 48_000,
  max: 64_000,
};

/** Resolve a Tide thinking level into the Anthropic-native `thinking` payload; null → disabled. */
function thinkingPayload(level: string): { type: 'enabled'; budget_tokens: number } | null {
  if (level === 'off') return null;
  const budget = THINKING_BUDGET[level] ?? THINKING_BUDGET.medium;
  return { type: 'enabled', budget_tokens: budget };
}

interface ActiveTurn {
  sessionId: string;
  abort: AbortController;
  /** Mutable — updated mid-turn when the user approves a mode switch
   *  (e.g. plan → edit) so subsequent tools in the same turn see the
   *  new mode without restarting the turn. */
  autonomyMode: AutonomyMode;
  /** Resolves a pending permission request with the user's decision. */
  permissionResolver: ((decision: { approved: boolean; reason?: string }) => void) | null;
  /** Pending tool calls awaiting approval. */
  pendingToolCallIds: string[];
  /** Resolves a pending ask_followup_question with the user's pick.
   *  Null means no followup is currently awaiting input. The pick is a
   *  string (the chosen option label, or the user's free-form answer for
   *  Mode 2). Null pick = user dismissed/aborted. */
  followupResolver: ((pick: { answer: string | null }) => void) | null;
  /** The tool call id that's currently awaiting a followup answer.
   *  Renderer reads this to know which tool block to update on submit. */
  pendingFollowupId: string | null;
  /** Canonical block list — same data as `timeline + toolCalls`, but in
   *  block form. Built incrementally as events fire. Mirrors the
   *  streamReducer exactly. Shipped on turn_end as the persisted truth. */
  blocks: Block[];
  /** Block id of the currently-open text block, or null if none.
   *  Set by onDelta when opening a new text block; cleared by
   *  onToolCallStart so the next delta opens a fresh one. */
  currentTextBlockId: string | null;
  /** Block id of the reasoning block, or null until first reasoning delta. */
  reasoningBlockId: string | null;
  /** Index by toolCallId → position in `blocks`. */
  toolBlockIndex: Record<string, number>;
}

/** Ordered timeline entry — text segment or tool-call reference.
 *  Lives at module scope because Rolldown's parser doesn't handle inline
 *  interface declarations inside function bodies. */
type TimelineEntry =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolIndex: number };

/** Finalize the block list at turn_end: mark trailing text as the answer, abort running tools if aborted, spawn followup blocks. Mirrors streamReducer.applyTurnEnd + applyToolArgs. */
function finalizeBlocks(active: ActiveTurn, stopReason: string): Block[] {
  const stopped = stopReason === 'aborted';
  const blocks: Block[] = active.blocks.map(b => {
    if (stopped && b.kind === 'tool' && (b.status === 'running' || b.status === 'pending')) {
      return { ...b, status: 'aborted' as const };
    }
    if (b.kind === 'text') return { ...b };
    return b;
  });

  // Spawn followup blocks for ask_followup_question calls — mirrors applyToolArgs so the popup fires on session reload.
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

  // Answer phase = text after the last tool call (treat every kind==='tool' as the bound so trailing followups pass through). Mirrors streamReducer.applyTurnEnd.
  let lastToolIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'tool') { lastToolIdx = i; break; }
  }
  for (let i = lastToolIdx + 1; i < blocks.length; i++) {
    if (blocks[i].kind === 'text') (blocks[i] as TextBlock).isAnswer = true;
  }
  return blocks;
}

/** Patch a tool block in `active.blocks` in place to mirror tool_executing/result events (mirrors streamReducer.applyToolStatus/applyToolResult). */
function updateToolBlock(
  active: ActiveTurn,
  toolCallId: string,
  patch: Partial<ToolBlock>,
): void {
  const idx = active.toolBlockIndex[toolCallId];
  if (idx == null) return;
  const cur = active.blocks[idx];
  if (!cur || cur.kind !== 'tool') return;
  Object.assign(cur, patch);
}

const activeTurns = new Map<string, ActiveTurn>();

/** Main-process singleton — registers the IPC commands. */
export function registerAgentHandlers(ipcMain: Electron.IpcMain) {
  ipcMain.handle(AGENT_COMMANDS.runTurn, async (e, payload: RunTurnPayload) => {
    const wc = e.sender;
    try {
      await runTurn(wc, payload);
    } catch (err: any) {
      // Unexpected error — emit as an agent event.
      emit(wc, payload.sessionId, {
        type: 'error',
        sessionId: payload.sessionId,
        seq: nextSeq(payload.sessionId),
        message: err?.message || 'Turn failed',
      });
    }
  });

  ipcMain.handle(AGENT_COMMANDS.abort, (_e, sessionId: string) => {
    const active = activeTurns.get(sessionId);
    if (active) {
      active.abort.abort();
      // Resolve any pending permission request as rejected so the loop unblocks.
      if (active.permissionResolver) {
        active.permissionResolver({ approved: false, reason: 'aborted' });
      }
      // Resolve any pending followup as null so the tool unblocks and
      // the loop tears down cleanly.
      if (active.followupResolver) {
        active.followupResolver({ answer: null });
      }
    }
  });

  ipcMain.handle(
    AGENT_COMMANDS.approve,
    (_e, sessionId: string, toolCallIds: string[]) => {
      const active = activeTurns.get(sessionId);
      if (active && active.permissionResolver) {
        active.permissionResolver({ approved: true });
      }
    },
  );

  ipcMain.handle(
    AGENT_COMMANDS.reject,
    (_e, sessionId: string, _toolCallIds: string[], reason?: string) => {
      const active = activeTurns.get(sessionId);
      if (active && active.permissionResolver) {
        active.permissionResolver({ approved: false, reason: reason || 'rejected by user' });
      }
    },
  );

  // User picked an option (or typed a free-form answer) for a pending
  // ask_followup_question. Resolves the tool's await; the orchestrator
  // loop then continues with the pick as the tool_result.
  ipcMain.handle(
    AGENT_COMMANDS.submitFollowup,
    (_e, sessionId: string, _toolCallId: string, answer: string) => {
      const active = activeTurns.get(sessionId);
      if (active && active.followupResolver) {
        active.followupResolver({ answer });
      }
    },
  );
}

// ─── Per-session sequence counter ──────────────────────────────
const seqCounters = new Map<string, number>();
function nextSeq(sessionId: string): number {
  const n = (seqCounters.get(sessionId) ?? 0) + 1;
  seqCounters.set(sessionId, n);
  return n;
}

function emit(wc: WebContents, sessionId: string, event: AgentEvent) {
  wc.send(AGENT_EVENT_CHANNEL, event);
}

// ─── The loop ──────────────────────────────────────────────────

async function runTurn(wc: WebContents, payload: RunTurnPayload) {
  const { sessionId, messages, modelId, providerId, autonomyMode, thinkingLevel } = payload;

  // Resolve provider + workspace root.
  const providers = store.listProviders();
  let provider = providers.find((p) => p.id === providerId);
  // Graceful recovery for orphaned sessions: if the session's provider was
  // deleted, fall back to any enabled provider serving this modelId (mirrors
  // the renderer's useModelOption resolution). Lets the turn run instead of
  // hard-crashing; user can re-bind in the model picker.
  if (!provider && modelId) {
    provider = providers.find((p) => p.enabled && p.models.some((m) => m.modelId === modelId));
  }
  if (!provider) throw new Error(`Provider ${providerId} not found`);
  if (!provider.apiKey) throw new Error(`No API key for ${provider.name}`);

  const workspaces = store.listWorkspaces();
  // Resolve workspace root from the session (worktree path if isolated, else workspaceId lookup) — NOT workspaces[0], which silently ran tools against the wrong project.
  let workspaceRoot: string | undefined;
  let worktreeMeta: { branch: string; baseBranch: string } | undefined;
  try {
    const session = sessions.getSession(sessionId);
    if (session?.worktree) {
      workspaceRoot = session.worktree.path;
      worktreeMeta = { branch: session.worktree.branch, baseBranch: session.worktree.baseBranch };
    } else if (session?.workspaceId) {
      workspaceRoot = workspaces.find((w) => w.id === session.workspaceId)?.path;
    }
  } catch {
    // Sessions module may not be loaded in some contexts — fall through.
  }
  // Last-resort fallbacks: an explicit workspace marked default, then the
  // first workspace, then cwd. Each is worse than the one above.
  workspaceRoot ??= workspaces.find((w) => w.isDefault)?.path ?? workspaces[0]?.path ?? process.cwd();
  log.info('runTurn', {
    session: sessionId,
    provider: provider.name,
    model: modelId,
    mode: autonomyMode,
    thinking: thinkingLevel,
    tools: autonomyMode === 'plan' ? 'read-only' : 'all',
    root: workspaceRoot,
    worktree: worktreeMeta ? { branch: worktreeMeta.branch, baseBranch: worktreeMeta.baseBranch } : undefined,
  });

  // Setup abort + active-turn tracking.
  const controller = new AbortController();
  const active: ActiveTurn = {
    sessionId,
    abort: controller,
    autonomyMode,
    permissionResolver: null,
    pendingToolCallIds: [],
    followupResolver: null,
    pendingFollowupId: null,
    blocks: [],
    currentTextBlockId: null,
    reasoningBlockId: null,
    toolBlockIndex: {},
  };
  activeTurns.set(sessionId, active);

  // Build the Anthropic-shape conversation from the renderer-supplied messages.
  // The first system message becomes the top-level `system` field; the rest
  // become user/assistant turns.
  let systemPrompt = '';
  const convo: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemPrompt = m.content;
      continue;
    }
    if (m.role === 'user') {
      convo.push({ role: 'user', content: userContent(m) });
    } else {
      convo.push({ role: 'assistant', content: m.content });
    }
  }

  // Send ALL tools regardless of mode; plan-mode writes are blocked at the permission gate, which pauses and asks for a mode switch rather than hard-rejecting.
  const tools = getAnthropicTools();
  // Resolve the Anthropic-native thinking payload. `null` = disabled
  // (streamer sends thinking.type:'disabled'); an object = enabled with a
  // token budget. Unknown / missing level falls back to 'medium'.
  const thinking = thinkingPayload(thinkingLevel) ?? thinkingPayload('medium');
  // When thinking is enabled, max_tokens must exceed budget_tokens. Pick a
  // generous output cap so the model always has room to answer after thinking.
  const maxTokens = thinking ? thinking.budget_tokens + 8192 : 8192;

  // Accumulators for the final persisted message.
  let finalContent = '';
  let finalReasoning = '';
  /** Whether the current iteration has emitted any text yet. Reset per
   * iteration; used to insert a paragraph break when a new iteration's
   * first text delta follows a prior iteration's text — otherwise the two
   * iterations' narrations glue together ("patch.Let me locate..."). */
  let iterationEmittedText = false;
  /** Whether ANY prior iteration emitted text. When true and a new iteration
   *  emits its first delta, prepend \n\n so iterations don't run together. */
  let anyPriorIterationText = false;
  const allToolCalls: ToolCall[] = [];

  /** Ordered timeline — the single source of truth for rendering order; entries interleave text and tool refs in emission order. */
  const timeline: TimelineEntry[] = [];
  /** Points at the current text entry being accumulated, or null if no
   *  text entry has been started in the current "segment." */
  let currentTextEntry: { type: 'text'; text: string } | null = null;

  let totalReasoningTokens = 0;
  // Usage accumulators — summed across all LLM calls in this turn so the
  // renderer can persist session-level totals for the context-window meter.
  let aggInput = 0;
  let aggOutput = 0;
  let aggCacheRead = 0;
  let aggCacheWrite = 0;
  let aggCalls = 0;
  let iteration = 0;

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++;
      const messageId = `m_${Date.now().toString(36)}_${iteration}`;

      // Per-call accumulators.
      let callText = '';
      let callReasoning = '';
      iterationEmittedText = false; // reset for this iteration
      const callTools: StreamedToolSummary[] = [];
      let callUsage: Usage | null = null;

      await streamAnthropicOnce(
        { apiKey: provider.apiKey, baseUrl: provider.baseUrl },
        {
          modelId,
          system: systemPrompt,
          messages: convo,
          tools,
          thinking,
          maxTokens,
        },
        controller.signal,
        {
          onDelta: (text) => {
            // When this iteration emits its first text delta AND a prior
            // iteration already produced text, prepend a paragraph break so
            // the two narrations don't glue together ("patch.Let me").
            // Only do this once per iteration (gated by iterationEmittedText).
            if (!iterationEmittedText && anyPriorIterationText) {
              const sep = '\n\n';
              callText += sep;
              finalContent += sep;
              emit(wc, sessionId, { type: 'delta', sessionId, seq: nextSeq(sessionId), messageId, text: sep });
            }
            // Start a new timeline text entry when this is the first delta
            // after tools landed (or the very first delta of the turn).
            // This preserves interleaving: text₁ → tools → text₂.
            if (!currentTextEntry) {
              currentTextEntry = { type: 'text', text: '' };
              timeline.push(currentTextEntry);
            }
            iterationEmittedText = true;
            anyPriorIterationText = true;
            callText += text;
            finalContent += text;
            currentTextEntry.text += text;
            // Block maintenance — mirrors streamReducer.applyDelta.
            const lastBlock = active.blocks[active.blocks.length - 1];
            if (lastBlock && lastBlock.kind === 'text' && lastBlock.id === active.currentTextBlockId) {
              (lastBlock as TextBlock).text += text;
            } else {
              const newId = crypto.randomUUID();
              active.currentTextBlockId = newId;
              active.blocks.push({
                id: newId, kind: 'text', text,
                createdAtSeq: 0, modifiedAtSeq: 0, isAnswer: false,
              });
            }
            emit(wc, sessionId, {
              type: 'delta', sessionId, seq: nextSeq(sessionId), messageId,
              text,
              blockId: active.currentTextBlockId!,   // just set above
            });
          },
          onReasoning: (delta) => {
            callReasoning += delta;
            finalReasoning += delta;
            // Block maintenance — mirrors streamReducer.applyReasoning.
            if (!active.reasoningBlockId) {
              active.reasoningBlockId = crypto.randomUUID();
              active.blocks.push({
                id: active.reasoningBlockId, kind: 'reasoning', text: '',
                createdAtSeq: 0, modifiedAtSeq: 0,
              });
            }
            const rb = active.blocks.find(b => b.id === active.reasoningBlockId) as ReasoningBlock | undefined;
            if (rb) rb.text += delta;
            emit(wc, sessionId, {
              type: 'reasoning', sessionId, seq: nextSeq(sessionId), messageId,
              delta,
              blockId: active.reasoningBlockId,
            });
          },
          onToolCallStart: (id, toolName) => {
            // Block maintenance — mirrors streamReducer.applyToolStart.
            // Tool landing finalizes the open text block.
            active.currentTextBlockId = null;
            active.toolBlockIndex[id] = active.blocks.length;
            const toolBlock: ToolBlock = {
              id, kind: 'tool',
              toolCallId: id, toolName,
              category: categorizeTool(toolName),
              status: 'pending', arguments: {}, argPreview: '', riskTier: 'read_only',
              createdAtSeq: 0, modifiedAtSeq: 0,
            };
            active.blocks.push(toolBlock);
            callTools.push({ id, toolName, args: {} });
            emit(wc, sessionId, {
              type: 'tool_call_start', sessionId, seq: nextSeq(sessionId), messageId,
              toolCallId: id, toolName: toolName as any,
              blockId: id,
            });
          },
          onToolCallDelta: (id, delta) => {
            emit(wc, sessionId, { type: 'tool_call_delta', sessionId, seq: nextSeq(sessionId), toolCallId: id, delta });
          },
          onToolCallEnd: (id, toolName, args) => {
            const existing = callTools.find((t) => t.id === id);
            if (existing) existing.args = args;
            // Block maintenance — mirror applyToolArgs (without followup;
            // we'll spawn followups in finalizeBlocks at turn_end).
            const tidx = active.toolBlockIndex[id];
            if (tidx != null) {
              const tb = active.blocks[tidx];
              if (tb && tb.kind === 'tool') {
                tb.arguments = args;
                tb.argPreview = formatArgPreview(toolName as any, args);
                tb.riskTier = riskOf(toolName);
              }
            }
            emit(wc, sessionId, {
              type: 'tool_call', sessionId, seq: nextSeq(sessionId), messageId, toolCallId: id, toolName: toolName as any,
              arguments: args, argPreview: formatArgPreview(toolName as any, args), riskTier: riskOf(toolName),
            });
          },
          onUsage: (u) => {
            callUsage = u;
            // Aggregate into turn totals. Each Anthropic call reports its own
            // input/output/cache numbers, so we sum them across iterations.
            aggInput += u.inputTokens;
            aggOutput += u.outputTokens;
            aggCacheRead += u.cacheRead;
            aggCacheWrite += u.cacheWrite;
            aggCalls += u.calls;
            if (u.reasoningTokens) totalReasoningTokens += u.reasoningTokens;
            emit(wc, sessionId, {
              type: 'usage', sessionId, seq: nextSeq(sessionId), messageId,
              tokens: u, costUsd: 0, runningTotalUsd: 0, iteration,
            });
          },
        },
      );

      // Append the assistant turn to the conversation so the next call sees it.
      const assistantBlocks: AnthropicContent[] = [];
      if (callText) assistantBlocks.push({ type: 'text', text: callText });
      for (const t of callTools) {
        assistantBlocks.push({ type: 'tool_use', id: t.id, name: t.toolName, input: t.args });
      }
      if (assistantBlocks.length > 0) {
        convo.push({ role: 'assistant', content: assistantBlocks });
      }

      // No tool calls → end of turn.
      if (callTools.length === 0) {
        emit(wc, sessionId, {
          type: 'turn_end', sessionId, seq: nextSeq(sessionId), messageId,
          stopReason: 'end_turn',
          content: finalContent,
          timeline: timeline.filter(e => e.type === 'tool' || e.text.trim()),
          blocks: finalizeBlocks(active, 'end_turn'),
          reasoning: finalReasoning || undefined,
          reasoningTokens: totalReasoningTokens || undefined,
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
          usage: {
            inputTokens: aggInput, outputTokens: aggOutput,
            cacheRead: aggCacheRead, cacheWrite: aggCacheWrite,
            reasoningTokens: totalReasoningTokens, calls: aggCalls, costUsd: 0,
          },
        });
        return;
      }

      // Tool calls — dispatch each, append tool_result blocks.
      // Before dispatching, null out the current text entry so the next
      // text delta (in a later iteration) starts a fresh timeline entry —
      // this is what preserves the interleaving (text₁ → tools → text₂).
      currentTextEntry = null;
      const toolResults: AnthropicContent = [];
      // ─── Parallel dispatch for read-only, always-auto-approved tools ────
      // Read-only auto-approved tools run concurrently (collapse N round-trips); permission-gated tools stay sequential to avoid concurrent asks.
      const ALL_MODES: AutonomyMode[] = ['plan', 'ask', 'edit', 'full'];
      const isParallelSafe = (t: StreamedToolSummary): boolean => {
        const reg = getRegistration(t.toolName);
        return !!reg && reg.riskTier === 'read_only' && reg.autoApproveIn.length === 4 &&
          ALL_MODES.every((m) => reg.autoApproveIn.includes(m));
      };

      // Shared usage accumulator across both parallel and sequential batches.
      const usageCb = (u: Usage) => {
        aggInput += u.inputTokens;
        aggOutput += u.outputTokens;
        aggCacheRead += u.cacheRead;
        aggCacheWrite += u.cacheWrite;
        aggCalls += u.calls;
        if (u.reasoningTokens) totalReasoningTokens += u.reasoningTokens;
      };

      const parallelBatch = callTools.filter(isParallelSafe);
      const sequentialBatch = callTools.filter((t) => !isParallelSafe(t));

      // Parallel batch — Promise.all, but preserve callTools order in the
      // result arrays (timeline + toolResults must match the model's emission
      // order so Anthropic gets tool_results in the same order as tool_use).
      const parallelResults =
        parallelBatch.length > 0
          ? await Promise.all(
              parallelBatch.map((t) =>
                dispatchTool(
                  wc, sessionId, messageId, t, autonomyMode, workspaceRoot, controller.signal, active,
                  provider, modelId, usageCb,
                ),
              ),
            )
          : [];
      // Sequential batch — permission-gated tools, must run in order.
      const sequentialResults: Awaited<ReturnType<typeof dispatchTool>>[] = [];
      for (const t of sequentialBatch) {
        sequentialResults.push(
          await dispatchTool(
            wc, sessionId, messageId, t, autonomyMode, workspaceRoot, controller.signal, active,
            provider, modelId, usageCb,
          ),
        );
      }

      // Re-interleave results in the model's original emission order so the
      // timeline and toolResults arrays match callTools 1:1. Build a lookup
      // map since parallelResults may be in completion order, not emission.
      const byId = new Map<string, Awaited<ReturnType<typeof dispatchTool>>>();
      for (const r of [...parallelResults, ...sequentialResults]) {
        byId.set(r.toolCall.id, r);
      }
      for (const t of callTools) {
        const result = byId.get(t.id);
        if (!result) continue;
        allToolCalls.push(result.toolCall);
        // Push a timeline entry pointing at this tool call's index. This
        // records WHERE in the narrative the tool landed.
        timeline.push({ type: 'tool', toolIndex: allToolCalls.length - 1 });
        // After a tool, the next text delta must start a new entry.
        currentTextEntry = null;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: t.id,
          content: result.toolCall.output ?? '(no output)',
          is_error: result.toolCall.status === 'failed' || result.toolCall.status === 'rejected',
        });
      }
      convo.push({ role: 'user', content: toolResults });
      // Loop continues — next model call.
    }

    // Iteration cap hit — force a wrap-up turn with no tools.
    log.warn('iteration cap hit; forcing final text-only call', { cap: MAX_ITERATIONS });
    systemPrompt += '\n\nYou have reached the step limit. Wrap up and report status.';
    const messageId = `m_${Date.now().toString(36)}_final`;
    let finalCallText = '';
    await streamAnthropicOnce(
      { apiKey: provider.apiKey, baseUrl: provider.baseUrl },
      { modelId, system: systemPrompt, messages: convo, thinking: null, maxTokens },
      controller.signal,
      {
        onDelta: (t) => {
          if (!iterationEmittedText && anyPriorIterationText) {
            const sep = '\n\n';
            finalCallText += sep;
            finalContent += sep;
            const sepLast = active.blocks[active.blocks.length - 1];
            if (sepLast && sepLast.kind === 'text' && sepLast.id === active.currentTextBlockId) {
              (sepLast as TextBlock).text += sep;
            } else {
              const sepId = crypto.randomUUID();
              active.currentTextBlockId = sepId;
              active.blocks.push({
                id: sepId, kind: 'text', text: sep,
                createdAtSeq: 0, modifiedAtSeq: 0, isAnswer: false,
              });
            }
            emit(wc, sessionId, {
              type: 'delta', sessionId, seq: nextSeq(sessionId), messageId,
              text: sep, blockId: active.currentTextBlockId!,
            });
          }
          iterationEmittedText = true;
          anyPriorIterationText = true;
          finalCallText += t;
          finalContent += t;
          const lastBlock = active.blocks[active.blocks.length - 1];
          if (lastBlock && lastBlock.kind === 'text' && lastBlock.id === active.currentTextBlockId) {
            (lastBlock as TextBlock).text += t;
          } else {
            const newId = crypto.randomUUID();
            active.currentTextBlockId = newId;
            active.blocks.push({
              id: newId, kind: 'text', text: t,
              createdAtSeq: 0, modifiedAtSeq: 0, isAnswer: false,
            });
          }
          emit(wc, sessionId, {
            type: 'delta', sessionId, seq: nextSeq(sessionId), messageId,
            text: t, blockId: active.currentTextBlockId!,
          });
        },
        onReasoning: (d) => {
          finalReasoning += d;
          if (!active.reasoningBlockId) {
            active.reasoningBlockId = crypto.randomUUID();
            active.blocks.push({
              id: active.reasoningBlockId, kind: 'reasoning', text: '',
              createdAtSeq: 0, modifiedAtSeq: 0,
            });
          }
          const rb = active.blocks.find(b => b.id === active.reasoningBlockId) as ReasoningBlock | undefined;
          if (rb) rb.text += d;
          emit(wc, sessionId, {
            type: 'reasoning', sessionId, seq: nextSeq(sessionId), messageId,
            delta: d, blockId: active.reasoningBlockId,
          });
        },
        onToolCallStart: () => {}, onToolCallDelta: () => {}, onToolCallEnd: () => {},
        onUsage: (u) => {
          aggInput += u.inputTokens; aggOutput += u.outputTokens;
          aggCacheRead += u.cacheRead; aggCacheWrite += u.cacheWrite;
          aggCalls += u.calls;
          if (u.reasoningTokens) totalReasoningTokens += u.reasoningTokens;
          emit(wc, sessionId, { type: 'usage', sessionId, seq: nextSeq(sessionId), messageId, tokens: u, costUsd: 0, runningTotalUsd: 0, iteration });
        },
      },
    );
    emit(wc, sessionId, {
      type: 'turn_end', sessionId, seq: nextSeq(sessionId), messageId,
      stopReason: 'iteration_limit',
      content: finalContent,
      timeline: timeline.filter(e => e.type === 'tool' || e.text.trim()),
      blocks: finalizeBlocks(active, 'iteration_limit'),
      reasoning: finalReasoning || undefined,
      reasoningTokens: totalReasoningTokens || undefined,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      usage: {
        inputTokens: aggInput, outputTokens: aggOutput,
        cacheRead: aggCacheRead, cacheWrite: aggCacheWrite,
        reasoningTokens: totalReasoningTokens, calls: aggCalls, costUsd: 0,
      },
    });
  } catch (err: any) {
    // Abort throws AbortError out of streamAnthropicOnce; without this catch, the partial work would be discarded. Emit a partial turn_end so the renderer can freeze/persist; other errors surface as error events.
    const isAbort = err?.name === 'AbortError' || controller.signal.aborted;
    if (isAbort) {
      const abortMessageId = `m_${Date.now().toString(36)}_abort`;
      emit(wc, sessionId, {
        type: 'turn_end', sessionId, seq: nextSeq(sessionId), messageId: abortMessageId,
        stopReason: 'aborted',
        // Whatever the model produced before the abort — may be partial text,
        // may be empty if the abort fired before the first delta.
        content: finalContent,
        timeline: timeline.filter(e => e.type === 'tool' || e.text.trim()),
        blocks: finalizeBlocks(active, 'aborted'),
        reasoning: finalReasoning || undefined,
        reasoningTokens: totalReasoningTokens || undefined,
        // Include tool calls that already executed — the user should see
        // what work was done before they hit stop.
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        usage: {
          inputTokens: aggInput, outputTokens: aggOutput,
          cacheRead: aggCacheRead, cacheWrite: aggCacheWrite,
          reasoningTokens: totalReasoningTokens, calls: aggCalls, costUsd: 0,
        },
      });
    } else {
      // Genuine error — surface to the renderer so it can display the message.
      emit(wc, sessionId, {
        type: 'error', sessionId, seq: nextSeq(sessionId),
        message: err?.message || String(err),
      });
    }
  } finally {
    activeTurns.delete(sessionId);
  }
}

interface StreamedToolSummary {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** Pause the turn on ask_followup_question until the user picks an option.
 *  Mirrors the permission-pause pattern: emit an event, await a resolver
 *  that's fulfilled by the submitFollowup IPC handler (or by abort). */
async function dispatchFollowup(
  wc: WebContents,
  sessionId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  baseToolCall: ToolCall,
  active: ActiveTurn,
): Promise<{ toolCall: ToolCall }> {
  // Normalize args (same logic as deriveFollowupMode in blockState).
  // The model may have sent plain strings or {label, description} objects.
  const rawQuestion = typeof args.question === 'string' ? args.question : '';
  const rawOptions = Array.isArray(args.options) ? args.options : [];
  const options: string[] = rawOptions.map((o: unknown) => {
    if (typeof o === 'string') return o;
    if (o && typeof o === 'object') {
      const obj = o as Record<string, unknown>;
      if (typeof obj.label === 'string') return obj.label;
      if (typeof obj.value === 'string') return obj.value;
    }
    return String(o);
  });
  const multiple = Boolean(args.multiple);

  // Emit the followup_required event — renderer fires the OptionsPopup.
  emit(wc, sessionId, {
    type: 'followup_required', sessionId, seq: nextSeq(sessionId),
    toolCallId, question: rawQuestion, options, multiple,
  });
  updateToolBlock(active, toolCallId, { status: 'awaiting_input', arguments: args });

  // Await the user's pick. Resolved by submitFollowup IPC handler, or by
  // abort (with null answer). 10-minute timeout matches permission gates.
  const FOLLOWUP_TIMEOUT_MS = 10 * 60 * 1000;
  const pick = await new Promise<{ answer: string | null }>((resolve) => {
    active.followupResolver = resolve;
    active.pendingFollowupId = toolCallId;
    setTimeout(() => {
      if (active.followupResolver === resolve) {
        resolve({ answer: null });
      }
    }, FOLLOWUP_TIMEOUT_MS);
  });
  active.followupResolver = null;
  active.pendingFollowupId = null;

  // Build the tool result. Null answer = user dismissed/aborted/timed out.
  if (pick.answer == null) {
    const tc: ToolCall = {
      ...baseToolCall,
      status: 'rejected',
      output: 'User did not answer the question.',
    };
    emit(wc, sessionId, {
      type: 'tool_result', sessionId, seq: nextSeq(sessionId),
      toolCallId, status: 'rejected', output: tc.output,
    });
    updateToolBlock(active, toolCallId, { status: 'rejected', output: tc.output });
    return { toolCall: tc };
  }

  // User picked — the answer becomes the tool_result the model sees next.
  const summary = options.length > 0
    ? `User picked: ${pick.answer}`
    : `User answered: ${pick.answer}`;
  const tc: ToolCall = {
    ...baseToolCall,
    status: 'executed',
    output: summary,
  };
  emit(wc, sessionId, {
    type: 'tool_result', sessionId, seq: nextSeq(sessionId),
    toolCallId, status: 'executed', output: summary,
  });
  updateToolBlock(active, toolCallId, { status: 'executed', output: summary });
  return { toolCall: tc };
}

async function dispatchTool(
  wc: WebContents,
  sessionId: string,
  messageId: string,
  streamed: StreamedToolSummary,
  autonomyMode: RunTurnPayload['autonomyMode'],
  workspaceRoot: string,
  signal: AbortSignal,
  active: ActiveTurn,
  // Parent turn state — passed through so `dispatch_agent` can spawn a
  // sub-agent against the same provider/model and fold its usage into the
  // parent turn's aggregate. See runTurn() for the source of these values.
  provider: Provider,
  modelId: string,
  onUsage: (u: Usage) => void,
): Promise<{ toolCall: ToolCall }> {
  const { id, toolName, args } = streamed;
  const riskTier = riskOf(toolName);
  const argPreview = formatArgPreview(toolName as any, args);
  const baseToolCall: ToolCall = {
    id, messageId, toolName: toolName as any,
    arguments: args, argPreview, status: 'pending', riskTier,
  };

  // ask_followup_question — pause the turn and wait for the user's pick.
  // The tool result becomes the user's answer; the orchestrator loop then
  // continues with the pick visible to the model in the next iteration.
  // This is the only tool that can pause a turn (besides permission gates).
  if (toolName === 'ask_followup_question') {
    return await dispatchFollowup(wc, sessionId, id, args, baseToolCall, active);
  }

  // Permission gate — read from active.autonomyMode (mutable so the mode
  // can switch mid-turn when the user approves a plan→edit escalation).
  let decision = checkPermission(riskTier, active.autonomyMode);

  // Mode-switch escalation: in plan mode, a write/destructive tool is
  // blocked. Instead of hard-rejecting, pause the turn and ask the user
  // to switch to Edit mode. On approve, update the mode so subsequent
  // writes in the same turn auto-approve — no repeated prompts.
  if (decision === 'blocked' && active.autonomyMode === 'plan') {
    emit(wc, sessionId, {
      type: 'permission_required', sessionId, seq: nextSeq(sessionId),
      toolCalls: [{ ...baseToolCall }], timeoutAt: Date.now() + PERMISSION_TIMEOUT_MS,
    });
    const modeSwitchDecision = await new Promise<{ approved: boolean; reason?: string }>((resolve) => {
      active.permissionResolver = resolve;
      active.pendingToolCallIds = [id];
      setTimeout(() => {
        if (active.permissionResolver === resolve) {
          resolve({ approved: false, reason: 'timeout' });
        }
      }, PERMISSION_TIMEOUT_MS);
    });
    active.permissionResolver = null;
    active.pendingToolCallIds = [];

    if (!modeSwitchDecision.approved) {
      const tc = { ...baseToolCall, status: 'rejected' as const, output: `Rejected: ${modeSwitchDecision.reason ?? 'user rejected mode switch'}` };
      emit(wc, sessionId, { type: 'tool_result', sessionId, seq: nextSeq(sessionId), toolCallId: id, status: 'rejected', output: tc.output });
      updateToolBlock(active, id, { status: 'rejected', output: tc.output });
      return { toolCall: tc };
    }

    // User approved — switch to edit mode. active.autonomyMode is mutable
    // so every subsequent dispatchTool call in this turn sees the new mode.
    active.autonomyMode = 'edit';
    try { sessions.updateSessionSettings(sessionId, { autonomyMode: 'edit' }); } catch { /* best-effort persist */ }

    // Re-evaluate the gate with the new mode. For edit + write tier,
    // this returns 'auto' → falls through to execution without a second
    // prompt. For edit + destructive, returns 'ask' → normal prompt.
    decision = checkPermission(riskTier, active.autonomyMode);
  }

  if (decision === 'blocked') {
    const tc = { ...baseToolCall, status: 'rejected' as const, output: `Blocked by autonomy mode: ${active.autonomyMode}` };
    emit(wc, sessionId, { type: 'tool_result', sessionId, seq: nextSeq(sessionId), toolCallId: id, status: 'rejected', output: tc.output });
    updateToolBlock(active, id, { status: 'rejected', output: tc.output });
    return { toolCall: tc };
  }
  if (decision === 'ask') {
    emit(wc, sessionId, {
      type: 'permission_required', sessionId, seq: nextSeq(sessionId),
      toolCalls: [{ ...baseToolCall }], timeoutAt: Date.now() + PERMISSION_TIMEOUT_MS,
    });
    const userDecision = await new Promise<{ approved: boolean; reason?: string }>((resolve) => {
      active.permissionResolver = resolve;
      active.pendingToolCallIds = [id];
      // Timeout.
      setTimeout(() => {
        if (active.permissionResolver === resolve) {
          resolve({ approved: false, reason: 'timeout' });
        }
      }, PERMISSION_TIMEOUT_MS);
    });
    active.permissionResolver = null;
    active.pendingToolCallIds = [];
    if (!userDecision.approved) {
      const tc = { ...baseToolCall, status: 'rejected' as const, output: `Rejected: ${userDecision.reason ?? 'user rejected'}` };
      emit(wc, sessionId, { type: 'tool_result', sessionId, seq: nextSeq(sessionId), toolCallId: id, status: 'rejected', output: tc.output });
      updateToolBlock(active, id, { status: 'rejected', output: tc.output });
      return { toolCall: tc };
    }
  }

  // Execute.
  emit(wc, sessionId, { type: 'tool_executing', sessionId, seq: nextSeq(sessionId), toolCallId: id });
  updateToolBlock(active, id, { status: 'running' });
  const start = Date.now();
  // Inject provider/modelId/usage so dispatch_agent can spawn a sub-agent and fold its usage into the turn aggregate; onDelta streams live sub-agent tokens via tool_call_delta events.
  const result = await executeTool(toolName, args, {
    workspaceRoot,
    signal,
    timeoutMs: 30_000,
    provider,
    modelId,
    onUsage,
    onDelta: (delta) => {
      emit(wc, sessionId, {
        type: 'tool_call_delta', sessionId, seq: nextSeq(sessionId),
        toolCallId: id, delta,
      });
    },
    sessionId,
  });
  const durationMs = result.durationMs ?? Date.now() - start;

  const tc: ToolCall = {
    ...baseToolCall,
    status: result.status === 'executed' ? 'executed' : result.status === 'failed' ? 'failed' : result.status,
    output: result.output,
    display: result.display,
    durationMs,
    meta: result.meta,
  };
  emit(wc, sessionId, {
    type: 'tool_result', sessionId, seq: nextSeq(sessionId), toolCallId: id,
    status: tc.status, output: tc.output, display: tc.display, durationMs, meta: tc.meta,
  });
  updateToolBlock(active, id, {
    status: tc.status, output: tc.output, display: tc.display, durationMs, meta: tc.meta,
  });
  return { toolCall: tc };
}

/** Build the user-side content blocks: text + per-attachment text blocks. */
function userContent(m: TurnMessage): AnthropicContent {
  if (!m.attachments || m.attachments.length === 0) return m.content;
  const blocks: AnthropicContent = [{ type: 'text', text: m.content }];
  for (const a of m.attachments) {
    if (a.kind === 'image') {
      // Placeholder for now — real image blocks need base64 + media_type.
      blocks.push({ type: 'text', text: `[Attached image: ${a.path}]` });
      continue;
    }
    const header = `--- ${a.path}${a.truncated ? ' (truncated)' : ''} ---`;
    blocks.push({ type: 'text', text: `${header}\n${a.content ?? '(empty)'}` });
  }
  return blocks;
}

/** Look up a tool's risk tier without going through the registry (avoids circular). */
function riskOf(toolName: string): 'read_only' | 'write' | 'destructive' {
  // Source of truth is the tool registry; the switch is a conservative fallback for not-yet-registered (e.g. future MCP) tools.
  const reg = getRegistration(toolName);
  if (reg) return reg.riskTier;
  switch (toolName) {
    case 'read_file':
    case 'list_dir':
    case 'grep':
      return 'read_only';
    case 'edit_file':
    case 'write_file':
      return 'write';
    case 'bash':
    case 'git':
      return 'destructive';
    default:
      return 'destructive'; // conservative default for unknown tools
  }
}
