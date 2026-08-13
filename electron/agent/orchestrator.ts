/** Orchestrator — the agent loop. Own while-loop, one streamText call per turn. */

import { streamText } from 'ai';
import type { LanguageModelUsage, ModelMessage } from 'ai';
import type { WebContents } from 'electron';
import { BrowserWindow, Notification } from 'electron';
import { execFile } from 'node:child_process';
import * as fs from 'fs';
import * as store from '../store.js';
import * as sessions from '../ipc/sessions.js';
import { createLogger } from '../logger.js';
import { resolveModel } from './provider-factory.js';
import { buildToolset, formatArgPreview, resolveToolName } from './tools/registry.js';
import { mcpToolsetForWorkspace } from './mcp/toolset.js';
import { getToolMeta } from './tools/tool-meta.js';
import { runLoadSkill } from './tools/load-skill.js';
import { getSessionTodos } from './tools/todo-write.js';
import { scanProjectEntries } from './project-context.js';
import { createExtensionsStore } from '../extensionsStore.js';
import { createConfigStore } from '../configStore.js';
import { createTurnController, type TurnController } from './turn-controller.js';
import { loadHookConfig, type HookConfig } from './hooks/hook-config.js';
import { shouldCompact, compactConversation, isContextOverflow } from './context/auto-compact.js';
import { supportsThinking, contextWindowSize, resolveMaxOutputTokens, resolveMaxInputTokens, resolveReasoningContracts } from './model-capabilities.js';
import type { ToolResult } from './tools/types.js';
import { resolvePermission, abortPermission, clearSession, getPendingAsk } from './permission-resolver.js';
import { loadPermissionRules, addPermissionRule } from './permissions/rules.js';
import { resolveFollowup, abortFollowup, clearFollowupSession } from './followup-resolver.js';
import { resolveProtocolOptions, resolveReasoning } from './protocols/index.js';
import type { ReasoningInstruction } from './protocols/index.js';
import type { CompactionSettings } from '../../src/types/compaction.js';
import { AGENT_EVENT_CHANNEL, AGENT_COMMANDS } from '../../src/lib/agent/events.js';
import type { AgentEvent, RunTurnPayload, TurnMessage } from '../../src/lib/agent/events.js';
import type { AutonomyMode, Provider, ToolCall, ToolName, Usage } from '../../src/types/index.js';
import type { Block, ReasoningBlock, TextBlock, ToolBlock } from '../../src/types/block.js';
import { categorizeTool, isBookkeepingTool } from '../../src/lib/stream/block-state.js';
import type { ToolContext } from './tools/tool-context.js';
import { appDataDir } from '../appPaths.js';

const log = createLogger('agent-sdk');

const MAX_STEPS = 100;
const TURN_MAX_RETRIES = 10;
const TURN_RETRY_TIMEOUT_MS = 120_000;
const ESCALATED_MAX_TOKENS = 65_535;
const MAX_RESUME_ATTEMPTS = 3;
/** Max forced compactions triggered by a context-overflow 400 in a single
 *  turn. Each shrinks the conversation; if the prompt is still too long
 *  after 3 attempts, the turn ends with an error rather than looping. */
const MAX_OVERFLOW_COMPACTIONS = 3;
/** Delay between auto-retries so a transient failure (rate limit, blip) can
 *  recover and the UI doesn't hammer the provider. Aborted turns cancel it. */
const RETRY_DELAY_MS = 10_000;
const RESUME_MESSAGE =
  'Output token limit hit. Resume directly — no apology, no recap of what you ' +
  'were doing. Pick up mid-thought if that is where the cut happened. Break ' +
  'remaining work into smaller pieces.';

type TimelineEntry = { type: 'text'; text: string } | { type: 'tool'; toolIndex: number };
type StopReason = 'end_turn' | 'max_tokens' | 'content_filter' | 'iteration_limit' | 'aborted' | 'refusal';

interface Turn {
  sessionId: string;
  messageId: string;
  controller: AbortController;
  autonomyMode: AutonomyMode;
  blocks: Block[];
  currentTextBlockId: string | null;
  reasoningBlockId: string | null;
  toolBlockIndex: Record<string, number>;
  finalText: string;
  finalReasoning: string;
  toolCalls: ToolCall[];
  timeline: TimelineEntry[];
  usage: Usage;
  lastStepUsage: Usage | null;
  stepsCompleted: number;
  maxSteps: number;
  permissionTimeoutMs: number;
  errored: string | null;
  finishReason: string | null;
  currentTextEntry: { type: 'text'; text: string } | null;
  responseMessages: ModelMessage[];
  stepHadToolCalls: boolean;
  /** Wall-clock timestamp (Date.now()) when the turn started — diffed against
   *  the turn_end time to compute the persisted `totalMs` (send → result). */
  startedAt: number;
}

const activeTurns = new Map<string, Turn>();
const activeCtxs = new Map<string, ToolContext>();
const seqCounters = new Map<string, number>();

export function abortAllTurns(): void {
  for (const [sessionId, turn] of activeTurns) {
    try {
      turn.controller.abort();
      const blocks = finalizeBlocks(turn, 'aborted');
      const { finalizeAssistantMessage, addUsage } =
        require('../ipc/sessions.js') as typeof import('../ipc/sessions.js');
      finalizeAssistantMessage(sessionId, turn.messageId, {
        content: turn.finalText || '', blocks,
        reasoning: turn.finalReasoning || undefined,
        reasoningTokens: turn.usage.reasoningTokens || undefined,
        toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
        timeline: turn.timeline.filter((e) => e.type === 'tool' || e.text.trim()),
        turn: { stopReason: 'aborted' },
      });
      if (turn.usage.inputTokens > 0 || turn.usage.outputTokens > 0) {
        addUsage(sessionId, turn.usage, turn.lastStepUsage ?? turn.usage);
      }
    } catch (e) {
      log.warn('abortAllTurns: failed to persist', { sessionId, err: e instanceof Error ? e.message : String(e) });
    }
  }
  activeTurns.clear();
}

export function registerAgentSdkHandlers(ipcMain: Electron.IpcMain) {
  ipcMain.handle(AGENT_COMMANDS.runTurn, async (e, payload: RunTurnPayload) => {
    try { await runTurn(e.sender, payload); }
    catch (err: any) {
      send(e.sender, payload.sessionId, {
        type: 'error', sessionId: payload.sessionId, seq: nextSeq(payload.sessionId),
        message: err?.message || 'Turn failed',
      });
    }
  });

  ipcMain.handle(AGENT_COMMANDS.abort, (_e, sessionId: string) => {
    activeTurns.get(sessionId)?.controller.abort();
    abortPermission(sessionId, 'aborted');
    abortFollowup(sessionId);
  });

  ipcMain.handle(AGENT_COMMANDS.approve,
    (_e, sessionId: string, toolCallIds: string[], newMode?: AutonomyMode, remember?: boolean) => {
      if (remember && toolCallIds[0]) {
        const ask = getPendingAsk(sessionId, toolCallIds[0]);
        if (ask) addPermissionRule(sessionId, ask.workspaceRoot, ask.toolName, ask.args);
      }
      if (newMode) { try { sessions.updateSessionSettings(sessionId, { autonomyMode: newMode }); } catch {} }
      resolvePermission(sessionId, toolCallIds, newMode ? { approved: true, newMode } : { approved: true });
    },
  );

  ipcMain.handle(AGENT_COMMANDS.reject,
    (_e, sessionId: string, toolCallIds: string[], reason?: string) => {
      resolvePermission(sessionId, toolCallIds, { approved: false, reason: reason || 'rejected by user' });
    },
  );

  ipcMain.handle(AGENT_COMMANDS.submitFollowup,
    (_e, sessionId: string, toolCallId: string, answer: string) => {
      resolveFollowup(sessionId, toolCallId, answer);
    },
  );

  ipcMain.handle('agent:updateMode', (_e, sessionId: string, mode: AutonomyMode) => {
    const ctx = activeCtxs.get(sessionId);
    if (ctx) (ctx.autonomyMode as AutonomyMode) = mode;
  });
}

export async function runTurn(wc: WebContents, payload: RunTurnPayload) {
  const { sessionId, messages, modelId, providerId, autonomyMode, thinkingLevel } = payload;

  const providers = store.listProviders();
  let provider = providers.find((p) => p.id === providerId);
  if (!provider && modelId) {
    provider = providers.find((p) => p.enabled && p.models.some((m) => m.modelId === modelId));
  }
  if (!provider) throw new Error(`Provider ${providerId} not found`);
  if (!provider.apiKey) throw new Error(`No API key for ${provider.name}`);
  log.info('turn', { session: sessionId, model: modelId, provider: provider.name, apiStyle: provider.apiStyle });

  const workspaces = store.listWorkspaces();
  let workspaceRoot: string | undefined;
  let workspaceId = '';
  let worktreeMeta: { branch: string; baseBranch: string } | undefined;
  let priorSkillRef: { name: string; path: string; loadedAt: string } | undefined;
  try {
    const session = sessions.getSession(sessionId);
    workspaceId = session?.workspaceId ?? '';
    if (session?.worktree) {
      workspaceRoot = session.worktree.path;
      worktreeMeta = { branch: session.worktree.branch, baseBranch: session.worktree.baseBranch };
    } else if (session?.workspaceId) {
      workspaceRoot = workspaces.find((w) => w.id === session.workspaceId)?.path;
    }
    priorSkillRef = session?.activeSkillRef;
  } catch {}
  workspaceRoot ??= workspaces.find((w) => w.isDefault)?.path ?? workspaces[0]?.path ?? process.cwd();
  const root: string = workspaceRoot ?? process.cwd();

  if (!fs.existsSync(root)) {
    const where = worktreeMeta ? `worktree (${worktreeMeta.branch})` : 'workspace';
    throw new Error(`The ${where} folder no longer exists:\n${root}`);
  }

  // Build conversation from payload messages.
  let systemPrompt = '';
  const convo: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') { systemPrompt = m.content; continue; }
    const core = toCoreMessage(m);
    if (core) convo.push(core);
  }

  const controller = new AbortController();
  const messageId = `m_${Date.now().toString(36)}`;
  const agentSettings = store.getAgentSettings();
  const effectiveMaxSteps = agentSettings.maxSteps || MAX_STEPS;
  const effectivePermissionTimeout = (agentSettings.permissionTimeoutMin || 10) * 60 * 1000;

  const turn: Turn = {
    sessionId, messageId, controller, autonomyMode,
    blocks: [], currentTextBlockId: null, reasoningBlockId: null,
    toolBlockIndex: {}, finalText: '', finalReasoning: '',
    toolCalls: [], timeline: [],
    usage: emptyUsage(), lastStepUsage: null,
    stepsCompleted: 0, maxSteps: effectiveMaxSteps,
    permissionTimeoutMs: effectivePermissionTimeout,
    errored: null, finishReason: null, currentTextEntry: null,
    responseMessages: [], stepHadToolCalls: false,
    startedAt: Date.now(),
  };
  activeTurns.set(sessionId, turn);

  const turnController = createTurnController(effectiveMaxSteps);
  const modelEntry = provider.models.find((m) => m.modelId === modelId);
  const knownCtxWindow = contextWindowSize(modelId, modelEntry);
  const knownMaxInput = resolveMaxInputTokens(modelId, modelEntry) ?? knownCtxWindow;
  const knownMaxOutput = resolveMaxOutputTokens(modelId, modelEntry);
  const compactionEnabled = agentSettings.compactionEnabled ?? true;
  const compactionThreshold = Math.min(0.95, Math.max(0.5, agentSettings.compactionThreshold ?? 0.75));
  const compactionKeepTurns = Math.max(1, Math.floor(agentSettings.compactionKeepTurns ?? 3));
  if (knownCtxWindow && compactionEnabled) {
    turnController.compactionConfig = {
      contextWindow: knownCtxWindow,
      maxInputTokens: knownMaxInput,
      maxOutputTokens: knownMaxOutput,
      threshold: compactionThreshold,
      keepRecentTurns: compactionKeepTurns,
    };
  } else if (knownCtxWindow) {
    turnController.compactionConfig = {
      contextWindow: knownCtxWindow,
      maxOutputTokens: knownMaxOutput,
      threshold: 0.99,
      keepRecentTurns: 3,
    };
  }

  const skillResult = await processSkillPipeline(wc, turn, convo, root, priorSkillRef, turnController);
  systemPrompt = injectSkillBodies(systemPrompt, skillResult.skillBodies);
  systemPrompt = injectSkillDiscoveryIndex(systemPrompt, root, skillResult.activeSkillRef?.path, skillResult.disabledSkills);
  systemPrompt = injectTodoPlan(systemPrompt, sessionId);
  systemPrompt = injectRagDirective(systemPrompt, workspaceId);

  const model = resolveModel(provider, { modelId, contextWindow: 0 } as any);
  const modelSupportsThinking = supportsThinking(modelId, modelEntry);
  const reasoningMandatory = modelEntry?.reasoningMandatory === true;
  const reasoningContracts = resolveReasoningContracts(modelId, modelEntry);
  let reasoning: ReasoningInstruction | null = modelSupportsThinking
    ? resolveReasoning(thinkingLevel, reasoningContracts, provider.apiStyle, knownMaxOutput)
    : null;
  if (reasoningMandatory && !reasoning) {
    reasoning = resolveReasoning('medium', reasoningContracts, provider.apiStyle, knownMaxOutput);
  }

  const ctx: ToolContext = {
    sessionId, workspaceRoot: root, workspaceId, autonomyMode,
    permissionRules: loadPermissionRules(root), modelId, provider,
    compactionSettings: { enabled: compactionEnabled, threshold: compactionThreshold, keepRecentTurns: compactionKeepTurns, onFailure: 'truncate' } satisfies CompactionSettings,
    onUsage: (u) => accumulateUsage(turn, u),
    abortSignal: controller.signal,
    thinkingLevel,
    emit: (raw) => bridgeToolEmit(wc, turn, raw),
    emitToolEvent: (e) => send(wc, sessionId, { ...e, sessionId, seq: nextSeq(sessionId), messageId: turn.messageId } as any),
  };
  activeCtxs.set(sessionId, ctx);

  const tools = { ...buildToolset(ctx, loadHookConfig(root)), ...mcpToolsetForWorkspace(workspaceId) };

  const baseProtocol = resolveProtocolOptions(
    provider.apiStyle, reasoning,
    { hasTools: true, modelId, maxOutputTokens: knownMaxOutput, providerBaseUrl: provider.baseUrl },
  );

  log.info('runTurn', { session: sessionId, model: modelId, mode: autonomyMode, thinking: thinkingLevel, tools: Object.keys(tools).length });

  const flushTimer = setInterval(() => {
    if (turn.finalText || turn.blocks.length > 0) flushPartial(wc, turn);
  }, 5_000);

  let retryCount = 0;
  let resumeCount = 0;
  let escalated = false;
  let overflowCompactions = 0;
  let currentConvo = convo;

  try {
    while (true) {
      if (controller.signal.aborted) break;

      // Compact between steps if near the context window.
      const lastStepTokens = turn.lastStepUsage?.inputTokens;
      if (turnController.compactionConfig && shouldCompact(currentConvo, turnController.compactionConfig, 0, lastStepTokens)) {
        try {
          send(wc, sessionId, { type: 'compacting', sessionId, seq: nextSeq(sessionId), messageId, tokensBefore: lastStepTokens ?? 0, forced: false });
          const compacted = await compactConversation(currentConvo, turnController.compactionConfig, { provider, modelId, signal: controller.signal });
          currentConvo = compacted.postCompactMessages as ModelMessage[];
          if (compacted.prunedToolOutputs > 0) {
            log.info('autocompact pruned tool outputs', { count: compacted.prunedToolOutputs, pruningSufficient: compacted.pruningSufficient });
          }
          send(wc, sessionId, { type: 'compacting', sessionId, seq: nextSeq(sessionId), messageId, tokensBefore: compacted.preCompactTokens, tokensAfter: compacted.postCompactTokens, forced: false });
        } catch (e: any) { log.warn('autocompact failed', { err: e?.message ?? e }); }
      }

      const isLastStep = turn.stepsCompleted >= turn.maxSteps - 1;
      const maxOutputTokens = escalated ? ESCALATED_MAX_TOKENS : baseProtocol.maxOutputTokens;
      const resolved = resolveProtocolOptions(provider.apiStyle, reasoning,
        { hasTools: !isLastStep, modelId, maxOutputTokens, providerBaseUrl: provider.baseUrl });

      try {
        const result = streamText({
          model,
          system: systemPrompt || undefined,
          messages: currentConvo,
          tools: isLastStep ? undefined : (tools as any),
          toolChoice: isLastStep ? 'none' : undefined,
          maxRetries: 0,
          maxOutputTokens,
          abortSignal: controller.signal,
          providerOptions: resolved.providerOptions,

          repairToolCall: async ({ toolCall }) => {
            const input = toolCall.input;
            if (typeof input !== 'string') return toolCall;
            const cleaned = input.replace(/<\/?tool_call>/g, '').replace(/<\/?tool_use>/g, '').replace(/<\/?function_call>/g, '').trim();
            try { JSON.parse(cleaned); return { ...toolCall, input: cleaned }; } catch {
              const match = cleaned.match(/\{[\s\S]*\}/);
              if (match) { try { JSON.parse(match[0]); return { ...toolCall, input: match[0] }; } catch {} }
            }
            return null;
          },

          onError: ({ error }) => { turn.errored = errMessage(error); },
        });

        turn.stepHadToolCalls = false;
        try {
          for await (const part of result.stream) {
            translatePart(wc, turn, part, modelEntry);
            if (part.type === 'tool-call' || part.type === 'tool-input-start') turn.stepHadToolCalls = true;
          }
        } catch (streamErr: any) {
          if (!(streamErr?.name === 'AbortError' && controller.signal.aborted)) {
            log.warn('stream interrupted', { err: streamErr?.message ?? streamErr });
            turn.errored = turn.errored ?? errMessage(streamErr);
          }
        }

        let responseMsgs: ModelMessage[] = [];
        try { responseMsgs = await result.responseMessages; } catch {}
        if (responseMsgs.length > 0) {
          currentConvo = [...currentConvo, ...responseMsgs];
          turn.responseMessages.push(...responseMsgs);
        }

        const finishReason = turn.finishReason || '';

        if (controller.signal.aborted) { emitTurnEnd(wc, turn, 'aborted'); break; }

        if (finishReason === 'length') {
          if (!escalated) { escalated = true; continue; }
          if (resumeCount < MAX_RESUME_ATTEMPTS) {
            resumeCount++;
            currentConvo = [...currentConvo, { role: 'user' as const, content: RESUME_MESSAGE }];
            continue;
          }
          emitTurnEnd(wc, turn, 'max_tokens'); break;
        }

        if (turn.errored) {
          // Context overflow → force compaction then retry (max 3 forced
          // compactions per turn). This is NOT a transient error: retrying
          // with the same payload will fail identically, so we shrink the
          // conversation instead of blind-retrying 10×.
          if (isContextOverflow(turn.errored) && turnController.compactionConfig && overflowCompactions < MAX_OVERFLOW_COMPACTIONS && !controller.signal.aborted) {
            overflowCompactions++;
            log.info('context overflow — forcing compaction', { attempt: overflowCompactions, error: turn.errored });
            turn.errored = null; turn.finishReason = null;
            try {
              send(wc, sessionId, { type: 'compacting', sessionId, seq: nextSeq(sessionId), messageId, tokensBefore: turn.lastStepUsage?.inputTokens ?? 0, forced: true });
              const compacted = await compactConversation(currentConvo, turnController.compactionConfig, { provider, modelId, signal: controller.signal });
              currentConvo = compacted.postCompactMessages as ModelMessage[];
              // Layer 5: replay the last user message after overflow compaction
              // so the model doesn't lose the user's original request.
              if (compacted.replayMessage) {
                const lastMsg = currentConvo[currentConvo.length - 1];
                const lastIsUser = lastMsg && lastMsg.role === 'user';
                const lastText = typeof lastMsg?.content === 'string' ? lastMsg.content : '';
                if (!lastIsUser || lastText.startsWith('[Compacted context') || lastText.startsWith('[Context truncated') || lastText.startsWith('[Context pruned')) {
                  currentConvo = [...currentConvo, compacted.replayMessage];
                  log.info('overflow replay — appended last user message after forced compaction');
                }
              }
              send(wc, sessionId, { type: 'compacting', sessionId, seq: nextSeq(sessionId), messageId, tokensBefore: compacted.preCompactTokens, tokensAfter: compacted.postCompactTokens, forced: true });
            } catch (e: any) {
              log.warn('forced compaction failed', { err: e?.message ?? e });
            }
            if (controller.signal.aborted) { emitTurnEnd(wc, turn, 'aborted'); break; }
            continue;
          }
          if (retryCount < TURN_MAX_RETRIES && !controller.signal.aborted && isTransientError(turn.errored)) {
            retryCount++;
            send(wc, sessionId, { type: 'retry', sessionId, seq: nextSeq(sessionId), attempt: retryCount, maxAttempts: TURN_MAX_RETRIES, reason: turn.errored });
            turn.errored = null; turn.finishReason = null;
            await retryDelay(RETRY_DELAY_MS, controller.signal);
            if (controller.signal.aborted) { emitTurnEnd(wc, turn, 'aborted'); break; }
            continue;
          }
          emitTurnEnd(wc, turn, 'refusal'); break;
        }

        if (turn.stepsCompleted >= turn.maxSteps) { emitTurnEnd(wc, turn, 'iteration_limit'); break; }
        if (turn.stepHadToolCalls) continue;
        emitTurnEnd(wc, turn, 'end_turn'); break;

      } catch (err: any) {
        if (err?.name === 'AbortError' && controller.signal.aborted) { emitTurnEnd(wc, turn, 'aborted'); break; }
        if (retryCount < TURN_MAX_RETRIES && !controller.signal.aborted) {
          retryCount++;
          const reason = isTimeoutError(err) ? `Request timed out after ${TURN_RETRY_TIMEOUT_MS / 1000}s` : (err?.message || String(err));
          send(wc, sessionId, { type: 'retry', sessionId, seq: nextSeq(sessionId), attempt: retryCount, maxAttempts: TURN_MAX_RETRIES, reason });
          turn.errored = null;
          await retryDelay(RETRY_DELAY_MS, controller.signal);
          if (controller.signal.aborted) { emitTurnEnd(wc, turn, 'aborted'); break; }
          continue;
        }
        turn.errored = err?.message || String(err);
        emitTurnEnd(wc, turn, 'refusal'); break;
      }
    }
  } finally {
    clearInterval(flushTimer);
    activeTurns.delete(sessionId);
    activeCtxs.delete(sessionId);
    clearSession(sessionId);
    clearFollowupSession(sessionId);
  }
}

function translatePart(
  wc: WebContents, turn: Turn, part: Readonly<{ type: string }>,
  modelEntry: { inputCostPerToken?: number; outputCostPerToken?: number; cacheReadCostPerToken?: number; cacheWriteCostPerToken?: number } | undefined,
): void {
  const { sessionId } = turn;
  const p = part as any;

  switch (part.type) {
    case 'text-delta': {
      const text: string = p.text;
      if (!text) break;
      const last = turn.blocks[turn.blocks.length - 1];
      if (last && last.kind === 'text' && last.id === turn.currentTextBlockId) {
        (last as TextBlock).text += text;
      } else {
        const id = crypto.randomUUID();
        turn.currentTextBlockId = id;
        turn.blocks.push({ id, kind: 'text', text, createdAtSeq: 0, modifiedAtSeq: 0, isAnswer: false });
      }
      if (!turn.currentTextEntry) {
        turn.currentTextEntry = { type: 'text', text: '' };
        turn.timeline.push(turn.currentTextEntry);
      }
      turn.currentTextEntry.text += text;
      turn.finalText += text;
      send(wc, sessionId, { type: 'delta', sessionId, seq: nextSeq(sessionId), messageId: turn.messageId, text, blockId: turn.currentTextBlockId! });
      break;
    }

    case 'reasoning-delta': {
      const text: string = p.text;
      if (!text) break;
      turn.finalReasoning += text;
      if (!turn.reasoningBlockId) {
        turn.reasoningBlockId = crypto.randomUUID();
        turn.blocks.push({ id: turn.reasoningBlockId, kind: 'reasoning', text: '', createdAtSeq: 0, modifiedAtSeq: 0 });
      }
      const rb = turn.blocks.find((b) => b.id === turn.reasoningBlockId) as ReasoningBlock | undefined;
      if (rb) rb.text += text;
      send(wc, sessionId, { type: 'reasoning', sessionId, seq: nextSeq(sessionId), messageId: turn.messageId, delta: text, blockId: turn.reasoningBlockId });
      break;
    }

    case 'tool-input-start': {
      const toolCallId: string = p.id;
      const toolName = resolveToolName(p.toolName) as ToolName;
      turn.currentTextBlockId = null;
      // Close the current thinking segment so the next reasoning delta (next
      // model step) opens a NEW reasoning block. This lets the block stream
      // interleave one thinking block per step between tool calls, instead of
      // every step appending to a single top block for the whole turn.
      // (Compact view folds the multiple blocks back into one card via
      // deriveLayout; stream view renders each inline.)
      turn.reasoningBlockId = null;
      turn.currentTextEntry = null;
      turn.toolBlockIndex[toolCallId] = turn.blocks.length;
      const meta = safeMeta(toolName);
      turn.blocks.push({ id: toolCallId, kind: 'tool', toolCallId, toolName, category: categorizeTool(toolName), status: 'pending', arguments: {}, argPreview: '', riskTier: meta?.riskTier ?? 'read_only', createdAtSeq: 0, modifiedAtSeq: 0 });
      send(wc, sessionId, { type: 'tool_call_start', sessionId, seq: nextSeq(sessionId), messageId: turn.messageId, toolCallId, toolName, blockId: toolCallId });
      break;
    }

    case 'tool-input-delta': {
      send(wc, sessionId, { type: 'tool_call_delta', sessionId, seq: nextSeq(sessionId), toolCallId: p.id, delta: p.delta ?? '' });
      break;
    }

    case 'tool-call': {
      const toolCallId: string = p.toolCallId;
      const toolName = resolveToolName(p.toolName) as ToolName;
      const input = (p.input ?? {}) as Record<string, unknown>;
      const meta = safeMeta(toolName);
      const argPreview = formatArgPreview(toolName, input);
      patchToolBlock(turn, toolCallId, { arguments: input, argPreview, riskTier: meta?.riskTier ?? 'read_only', status: 'running' });
      send(wc, sessionId, { type: 'tool_call', sessionId, seq: nextSeq(sessionId), messageId: turn.messageId, toolCallId, toolName, arguments: input, argPreview, riskTier: meta?.riskTier ?? 'read_only' });
      send(wc, sessionId, { type: 'tool_executing', sessionId, seq: nextSeq(sessionId), toolCallId });
      break;
    }

    case 'tool-result':
    case 'tool-error': {
      const toolCallId: string = p.toolCallId;
      const toolName = resolveToolName(p.toolName) as ToolName;
      const input = (p.input ?? {}) as Record<string, unknown>;
      const meta = safeMeta(toolName);
      const argPreview = formatArgPreview(toolName, input);
      const tr: ToolResult = part.type === 'tool-result' && p.output && typeof p.output === 'object'
        ? ({ ...(p.output as object) } as ToolResult)
        : { status: 'failed', output: part.type === 'tool-error' ? errMessage(p.error) || 'Tool error' : '(no output)' };
      const status = normalizeStatus(tr.status);
      const tc: ToolCall = { id: toolCallId, messageId: turn.messageId, toolName, arguments: input, argPreview, status, riskTier: meta?.riskTier ?? 'read_only', output: tr.output, display: tr.display, durationMs: tr.durationMs, meta: tr.meta };
      turn.toolCalls.push(tc);
      turn.timeline.push({ type: 'tool', toolIndex: turn.toolCalls.length - 1 });
      turn.currentTextEntry = null;
      patchToolBlock(turn, toolCallId, { status, output: tr.output, display: tr.display, durationMs: tr.durationMs, meta: tr.meta });
      send(wc, sessionId, { type: 'tool_result', sessionId, seq: nextSeq(sessionId), toolCallId, status, output: tr.output, display: tr.display, durationMs: tr.durationMs, meta: tr.meta });
      break;
    }

    case 'finish-step': {
      turn.stepsCompleted += 1;
      if (p.usage) {
        const stepUsage = sdkUsageToTide(p.usage as LanguageModelUsage, modelEntry, 1);
        accumulateUsage(turn, stepUsage);
        turn.lastStepUsage = stepUsage;
        send(wc, sessionId, { type: 'usage', sessionId, seq: nextSeq(sessionId), messageId: turn.messageId, tokens: stepUsage, costUsd: stepUsage.costUsd, runningTotalUsd: turn.usage.costUsd, iteration: turn.stepsCompleted });
      }
      if (p.finishReason) turn.finishReason = p.finishReason;
      break;
    }

    case 'finish': {
      if (p.finishReason) turn.finishReason = p.finishReason;
      if (p.totalUsage) {
        const finishUsage = sdkUsageToTide(p.totalUsage as LanguageModelUsage, modelEntry, turn.usage.calls || 1);
        turn.usage = finishUsage;
        if (!turn.lastStepUsage) turn.lastStepUsage = finishUsage;
      }
      break;
    }

    case 'abort': turn.controller.abort(); break;

    case 'error': {
      let msg = errMessage(p.error) || 'Stream error';
      if (/no output generated/i.test(msg)) msg += ' (provider returned an empty stream — usually a rejected option like `thinking` or an unknown model id.)';
      turn.errored = msg;
      send(wc, sessionId, { type: 'error', sessionId, seq: nextSeq(sessionId), message: msg });
      break;
    }

    default: break;
  }
}

function stopReasonFor(turn: Turn): StopReason {
  if (turn.controller.signal.aborted) return 'aborted';
  if (turn.stepsCompleted >= turn.maxSteps) return 'iteration_limit';
  switch (turn.finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'content-filter': return 'content_filter';
    case 'tool-calls': return 'end_turn';
    case 'error': return turn.errored ? 'refusal' : 'end_turn';
    default: return 'end_turn';
  }
}

function emitTurnEnd(wc: WebContents, turn: Turn, stopReason: StopReason) {
  const blocks = finalizeBlocks(turn, stopReason);
  // Surface the error to the UI on failure (retries exhausted or non-retryable).
  // Sent BEFORE turn_end so the reducer records the error, then turn_end flips
  // isStreaming — the error UI (gated on !isStreaming) appears exactly once, at
  // the end. Covers stream-throw errors that never emitted an `error` part.
  if (stopReason === 'refusal' && turn.errored) {
    send(wc, turn.sessionId, { type: 'error', sessionId: turn.sessionId, seq: nextSeq(turn.sessionId), message: turn.errored });
  }
  send(wc, turn.sessionId, {
    type: 'turn_end', sessionId: turn.sessionId, seq: nextSeq(turn.sessionId),
    messageId: turn.messageId, stopReason, content: turn.finalText,
    timeline: turn.timeline.filter((e) => e.type === 'tool' || e.text.trim()),
    blocks, reasoning: turn.finalReasoning || undefined,
    reasoningTokens: turn.usage.reasoningTokens || undefined,
    totalMs: Date.now() - turn.startedAt,
    toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
    usage: turn.usage, lastStepUsage: turn.lastStepUsage ?? undefined,
  });
  fireTurnEndNotification(wc, turn.sessionId, stopReason);
}

function finalizeBlocks(turn: Turn, stopReason: StopReason): Block[] {
  const stopped = stopReason === 'aborted';
  const blocks: Block[] = turn.blocks.map((b) =>
    stopped && b.kind === 'tool' && (b.status === 'running' || b.status === 'pending')
      ? { ...b, status: 'aborted' as const } : b
  );
  let lastToolIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'tool' && !isBookkeepingTool((blocks[i] as ToolBlock).toolName)) { lastToolIdx = i; break; }
  }
  for (let i = lastToolIdx + 1; i < blocks.length; i++) {
    if (blocks[i].kind === 'text') (blocks[i] as TextBlock).isAnswer = true;
  }
  return blocks;
}

function patchToolBlock(turn: Turn, toolCallId: string, patch: Partial<ToolBlock>): void {
  const cur = turn.blocks[turn.toolBlockIndex[toolCallId] ?? -1];
  if (cur?.kind === 'tool') Object.assign(cur, patch);
}

function flushPartial(wc: WebContents, turn: Turn) {
  try {
    sessions.updatePartialAssistantMessage(turn.sessionId, turn.messageId, {
      content: turn.finalText, blocks: turn.blocks,
      reasoning: turn.finalReasoning || undefined,
      toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
      timeline: turn.timeline,
    });
  } catch {}
}

function bridgeToolEmit(wc: WebContents, turn: Turn, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const e = raw as { type?: string; [k: string]: unknown };
  const { sessionId } = turn;

  if (e.type === 'permission') {
    const toolName = resolveToolName((e.toolName as string) ?? 'unknown') as ToolName;
    const args = (e.args ?? {}) as Record<string, unknown>;
    const meta = safeMeta(toolName);
    const toolCallId = (typeof e.toolCallId === 'string' && e.toolCallId) || `perm_${toolName}_${nextSeq(sessionId)}`;
    const tc: ToolCall = { id: toolCallId, messageId: turn.messageId, toolName, arguments: args, argPreview: formatArgPreview(toolName, args), status: 'pending', riskTier: meta?.riskTier ?? 'read_only', gateDecision: e.decision === 'blocked' ? 'blocked' : 'ask' };
    send(wc, sessionId, { type: 'permission_required', sessionId, seq: nextSeq(sessionId), toolCalls: [tc], timeoutAt: Date.now() + turn.permissionTimeoutMs });
    return;
  }

  if (e.type === 'followup') {
    send(wc, sessionId, { type: 'followup_required', sessionId, seq: nextSeq(sessionId), toolCallId: (e.toolCallId as string) ?? '', question: (e.question as string) ?? '', options: (e.options as string[]) ?? [], multiple: (e.multiple as boolean) ?? false });
  }
}

function fireTurnEndNotification(wc: WebContents, sessionId: string, stopReason: StopReason) {
  const win = BrowserWindow.fromWebContents(wc);
  if (stopReason === 'aborted' || win?.isFocused() || !Notification.isSupported()) return;
  try {
    if (!createConfigStore(appDataDir()).getGeneralSettings().notifications) return;
    const title = stopReason === 'refusal' ? 'Tide — turn failed' : stopReason === 'max_tokens' ? 'Tide — context limit reached' : stopReason === 'iteration_limit' ? 'Tide — step limit reached' : 'Tide — done';
    const body = stopReason === 'refusal' ? 'The turn ended with an error.' : stopReason === 'max_tokens' ? 'The model hit the token limit.' : stopReason === 'iteration_limit' ? 'The agent reached the step cap.' : 'Your request has completed.';
    const notif = new Notification({ title, body, silent: false });
    notif.on('click', () => { win?.show(); win?.focus(); if (!wc.isDestroyed()) wc.send('tide:navigateToSession', sessionId); });
    notif.on('failed', () => {
      if (process.platform === 'darwin') execFile('osascript', ['-e', `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`], () => {});
    });
    notif.show();
  } catch {}
}

async function processSkillPipeline(
  wc: WebContents, turn: Turn, convo: ModelMessage[], root: string,
  priorSkillRef: { name: string; path: string; loadedAt: string } | undefined,
  _ctrl: TurnController,
): Promise<{ skillBodies: string; activeSkillRef: { path: string } | undefined; disabledSkills: string[] }> {
  let skillBodies = '';
  let activeSkillRef: { path: string } | undefined;
  let disabledSkills: string[] = [];

  try {
    const markers = convo.flatMap(m => {
      const content = typeof m.content === 'string' ? m.content : '';
      return [...content.matchAll(/\[\[LOAD_SKILL:([^\]|]+)(?:\|([^\]]+))?\]\]/g)];
    });
    for (const match of markers) {
      const path = match[1].trim();
      const name = match[2]?.trim();
      try {
        const body = await runLoadSkill(path, root);
        if (body) {
          skillBodies += body + '\n\n';
          if (name) { activeSkillRef = { path }; sessions.setActiveSkillRef(turn.sessionId, { name, path, loadedAt: new Date().toISOString() }); }
          const skillId = `skill_${Date.now()}`;
          send(wc, turn.sessionId, { type: 'tool_call_start', sessionId: turn.sessionId, seq: nextSeq(turn.sessionId), messageId: turn.messageId, toolCallId: skillId, toolName: 'load_skill', blockId: skillId });
          send(wc, turn.sessionId, { type: 'tool_result', sessionId: turn.sessionId, seq: nextSeq(turn.sessionId), toolCallId: skillId, status: 'executed', output: `Skill "${name ?? path}" loaded.`, meta: name ?? path });
        }
      } catch {}
    }
  } catch {}

  if (priorSkillRef && !activeSkillRef) {
    try {
      const body = await runLoadSkill(priorSkillRef.path, root);
      if (body) { skillBodies += body + '\n\n'; activeSkillRef = { path: priorSkillRef.path }; }
    } catch {}
  }

  try { disabledSkills = createExtensionsStore(appDataDir()).getDisabled().skills; } catch {}

  return { skillBodies, activeSkillRef, disabledSkills };
}

function injectSkillBodies(sp: string, bodies: string): string {
  return bodies.trim() ? sp + '\n\n# Active Skills\n\n' + bodies.trim() : sp;
}

function injectSkillDiscoveryIndex(sp: string, root: string, activePath: string | undefined, disabled: string[]): string {
  try {
    const entries = scanProjectEntries(root).filter(e => !disabled.includes(e.name) && e.path !== activePath);
    if (!entries.length) return sp;
    return sp + '\n\n# Available Skills\n' + entries.slice(0, 20).map(e => `- **${e.name}**: ${e.description}`).join('\n');
  } catch { return sp; }
}

function injectTodoPlan(sp: string, sessionId: string): string {
  try {
    const todos = getSessionTodos(sessionId);
    if (!todos?.length) return sp;
    return sp + '\n\n# Current Plan\n' + todos.map((t, i) => `${i + 1}. [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`).join('\n');
  } catch { return sp; }
}

function injectRagDirective(sp: string, workspaceId: string): string {
  if (!store.listRagEnabledWorkspaces().includes(workspaceId)) return sp;
  return sp + '\n\n# Codebase recall — ALWAYS START HERE\nThe `memory` tool searches the workspace semantic index (RAG). Before exploring with directory_tree/list_dir/read_file/grep, call `memory` first.';
}

function send(wc: WebContents, _sid: string, event: AgentEvent) {
  if (!wc.isDestroyed()) wc.send(AGENT_EVENT_CHANNEL, event);
}

function nextSeq(sessionId: string): number {
  const n = (seqCounters.get(sessionId) ?? 0) + 1;
  seqCounters.set(sessionId, n);
  return n;
}

function toCoreMessage(m: TurnMessage): ModelMessage | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  let content = m.content;
  if (m.attachments?.length) {
    const blocks = m.attachments.filter(a => a.content).map(a => `<file path="${a.path}">\n${a.content}\n</file>`);
    if (blocks.length) content += '\n\n' + blocks.join('\n\n');
  }
  return { role: m.role, content } as ModelMessage;
}

function normalizeStatus(s: string | undefined): ToolCall['status'] {
  switch (s) { case 'executed': case 'failed': case 'rejected': case 'timeout': return s; case 'aborted': return 'aborted'; default: return s ? 'executed' : 'pending'; }
}

function safeMeta(name: string) { try { return getToolMeta(name as ToolName); } catch { return undefined; } }

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, calls: 0, costUsd: 0 };
}

function accumulateUsage(turn: Turn, d: Usage): void {
  turn.usage.inputTokens += d.inputTokens || 0;
  turn.usage.outputTokens += d.outputTokens || 0;
  turn.usage.cacheRead += d.cacheRead || 0;
  turn.usage.cacheWrite += d.cacheWrite || 0;
  turn.usage.reasoningTokens += d.reasoningTokens || 0;
  turn.usage.calls += d.calls || 1;
  turn.usage.costUsd += d.costUsd || 0;
}

function computeCost(u: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheRead' | 'cacheWrite'>, r: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return Math.max(0, (u.inputTokens || 0) - (u.cacheRead || 0)) * r.input + (u.outputTokens || 0) * r.output + (u.cacheRead || 0) * r.cacheRead + (u.cacheWrite || 0) * r.cacheWrite;
}

function sdkUsageToTide(u: LanguageModelUsage, me: { inputCostPerToken?: number; outputCostPerToken?: number; cacheReadCostPerToken?: number; cacheWriteCostPerToken?: number } | undefined, calls = 1): Usage {
  const usage = { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, cacheRead: u.inputTokenDetails?.cacheReadTokens ?? 0, cacheWrite: u.inputTokenDetails?.cacheWriteTokens ?? 0, reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0, calls };
  return { ...usage, costUsd: computeCost(usage, { input: me?.inputCostPerToken ?? 0, output: me?.outputCostPerToken ?? 0, cacheRead: me?.cacheReadCostPerToken ?? 0, cacheWrite: me?.cacheWriteCostPerToken ?? 0 }) };
}

function errMessage(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Abortable delay used between auto-retries. Resolves immediately if the
 *  signal is already aborted, and no-ops if it fires during the wait — so a
 *  user stop cancels the retry delay without a dangling timer. */
function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => resolve();
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
  });
}

function isTransientError(msg: string): boolean {
  if (/no output generated/i.test(msg)) return false;
  if (/api key|unauthorized|forbidden|401|403/i.test(msg)) return false;
  // Context overflow is NOT transient — retrying the same payload fails
  // identically. The overflow handler above routes these to forced
  // compaction; if we get here, the circuit breaker already tripped.
  if (isContextOverflow(msg)) return false;
  return true;
}

export { runTurn as runSdkTurn };
