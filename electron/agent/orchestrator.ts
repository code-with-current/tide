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
import { getSessionTodos, renderTodoPlanLines } from './tools/todo-write.js';
import { scanProjectEntries } from './project-context.js';
import { createExtensionsStore } from '../extensionsStore.js';
import { createConfigStore } from '../configStore.js';
import { createTurnController, type TurnController } from './turn-controller.js';
import { loadHookConfig, type HookConfig } from './hooks/hook-config.js';
import { shouldCompact, compactConversation, isContextOverflow } from './context/auto-compact.js';
import { supportsThinking, supportsVision, contextWindowSize, resolveMaxOutputTokens, resolveMaxInputTokens, resolveReasoningContracts, clampOutputForContext } from './model-capabilities.js';
import { mediaMimeFor } from './tools/read-media-file.js';
import type { ToolResult } from './tools/types.js';
import { resolvePermission, abortPermission, clearSession, getPendingAsk } from './permission-resolver.js';
import { loadPermissionRules, addPermissionRule } from './permissions/rules.js';
import { resolveFollowup, abortFollowup, clearFollowupSession } from './followup-resolver.js';
import { resolveProtocolOptions, resolveReasoning } from './protocols/index.js';
import type { ReasoningInstruction } from './protocols/index.js';
import type { CompactionSettings } from '../../src/types/compaction.js';
import { AGENT_EVENT_CHANNEL, AGENT_COMMANDS } from '../../src/lib/agent/events.js';
import type { AgentEvent, RunTurnPayload, TurnMessage } from '../../src/lib/agent/events.js';
import type { AutonomyMode, Provider, ToolCall, ToolDisplay, ToolName, Usage } from '../../src/types/index.js';
import type { Block, ReasoningBlock, TextBlock, ToolBlock } from '../../src/types/block.js';
import { categorizeTool, isBookkeepingTool } from '../../src/lib/stream/block-state.js';
import { recordEditTurn } from '../rag/edit-journal.js';
import type { ToolContext } from './tools/tool-context.js';
import { appDataDir } from '../appPaths.js';
import type { EventSink, SinkEvent } from './event-sink.js';
import type { SessionStoreV2 } from '../ipc/session-store-v2.js';
import { newV2MessageId } from './orchestrator-events.js';
import { createV2TurnTracker, type V2TurnTracker } from './v2-turn-tracker.js';

const log = createLogger('agent-sdk');

const MAX_STEPS = 100;
const TURN_MAX_RETRIES = 10;
const TURN_RETRY_TIMEOUT_MS = 120_000;

/** MIME types safe to inline as image parts — the set Anthropic/OpenAI vision
 *  endpoints both accept. SVG/AVIF/BMP/etc. fall through to the hint tiers. */
const INLINE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Inline image size cap — base64 of anything larger blows up the request. */
const INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Heuristic for image-capable MCP tools (tier 2 of the attachment chain):
 *  name or description mentions images/vision/OCR. */
const IMAGE_CAPABLE_RE = /image|vision|ocr|screenshot|photo|picture/i;

/** Attachment-delivery decision for a turn: whether the model sees images
 *  natively, and which MCP tools can analyze them when it can't. */
interface AttachmentDelivery {
  vision: boolean;
  mcpImageTools: string[];
}
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
/** Loop-guard thresholds: the same tool+arguments repeated this many times in
 *  one turn, or this many total tool calls, triggers a corrective reminder. */
const LOOP_DUPLICATE_THRESHOLD = 3;
const LOOP_BUDGET_WARNING = 40;

type TimelineEntry = { type: 'text'; text: string } | { type: 'tool'; toolIndex: number };
type StopReason = 'end_turn' | 'max_tokens' | 'content_filter' | 'iteration_limit' | 'aborted' | 'refusal';

interface Turn {
  sessionId: string;
  /** Workspace the session is bound to — used by the turn-end edit journal. */
  workspaceId: string;
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
  /** Last provider error this turn — unlike `errored`, survives retry resets
   * so an aborted-during-retries turn can still surface why it was failing. */
  lastError: string | null;
  finishReason: string | null;
  currentTextEntry: { type: 'text'; text: string } | null;
  responseMessages: ModelMessage[];
  stepHadToolCalls: boolean;
  /** Signatures that already fired a loop-guard reminder — each fires once. */
  loopGuardFired: Set<string>;
  /** Wall-clock timestamp (Date.now()) when the turn started — diffed against
   *  the turn_end time to compute the persisted `totalMs` (send → result). */
  startedAt: number;
  /** v2 event sequencing for this turn — null until the turn's try opens
   *  (initV2Turn) or when v2 is unavailable; additive, never required. */
  v2: V2TurnTracker | null;
}

const activeTurns = new Map<string, Turn>();
const activeCtxs = new Map<string, ToolContext>();
const seqCounters = new Map<string, number>();

let sink: EventSink | undefined;
let storeV2: SessionStoreV2 | undefined;

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
      emitSink(turn.v2?.abort(turn.usage) ?? []);
    } catch (e) {
      log.warn('abortAllTurns: failed to persist', { sessionId, err: e instanceof Error ? e.message : String(e) });
    }
  }
  activeTurns.clear();
}

export function registerAgentSdkHandlers(ipcMain: Electron.IpcMain, opts?: { sink?: EventSink; storeV2?: SessionStoreV2 }) {
  sink = opts?.sink;
  storeV2 = opts?.storeV2;
  ipcMain.handle(AGENT_COMMANDS.runTurn, async (e, payload: RunTurnPayload) => {
    try { await runTurn(e.sender, payload); }
    catch (err: any) {
      send(e.sender, payload.sessionId, {
        type: 'error', sessionId: payload.sessionId, seq: nextSeq(payload.sessionId),
        message: err?.message || 'Turn failed',
      });
      // Follow with turn_end so the renderer flips isStreaming — an error
      // event alone leaves the composer locked (error UI is gated on
      // !isStreaming, which only turn_end clears).
      send(e.sender, payload.sessionId, {
        type: 'turn_end', sessionId: payload.sessionId, seq: nextSeq(payload.sessionId),
        messageId: `m_${Date.now().toString(36)}`, stopReason: 'refusal',
        content: '', timeline: [], blocks: [], totalMs: 0,
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
    (_e, sessionId: string, toolCallId: string, answer: string) =>
      // Boolean reaches the renderer: true = live resolver resolved; false = no
      // pending ask (turn already ended) — the renderer falls back to sending
      // the answer as a user message instead of dropping it silently.
      resolveFollowup(sessionId, toolCallId, answer),
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

  const modelEntry = provider.models.find((m) => m.modelId === modelId);
  // Built once here: drives both the attachment fallback chain (image-capable
  // MCP tools) and the streamText toolset below — avoid building it twice.
  const mcpTools = mcpToolsetForWorkspace(workspaceId);
  const mcpImageTools = Object.entries(mcpTools)
    .filter(([n, t]) =>
      IMAGE_CAPABLE_RE.test(n) || IMAGE_CAPABLE_RE.test(String((t as { description?: string }).description ?? '')))
    .map(([n]) => n);
  const attachmentDelivery = { vision: supportsVision(modelId, modelEntry), mcpImageTools };

  // Build conversation from payload messages.
  let systemPrompt = '';
  const convo: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') { systemPrompt = m.content; continue; }
    const core = await toCoreMessage(m, attachmentDelivery);
    if (core) convo.push(core);
  }

  const controller = new AbortController();
  const messageId = `m_${Date.now().toString(36)}`;
  const agentSettings = store.getAgentSettings();
  const effectiveMaxSteps = agentSettings.maxSteps || MAX_STEPS;
  const effectivePermissionTimeout = (agentSettings.permissionTimeoutMin || 10) * 60 * 1000;

  const turn: Turn = {
    sessionId, workspaceId, messageId, controller, autonomyMode,
    blocks: [], currentTextBlockId: null, reasoningBlockId: null,
    toolBlockIndex: {}, finalText: '', finalReasoning: '',
    toolCalls: [], timeline: [],
    usage: emptyUsage(), lastStepUsage: null,
    stepsCompleted: 0, maxSteps: effectiveMaxSteps,
    permissionTimeoutMs: effectivePermissionTimeout,
    errored: null, lastError: null, finishReason: null, currentTextEntry: null,
    responseMessages: [], stepHadToolCalls: false,
    loopGuardFired: new Set(),
    startedAt: Date.now(),
    v2: null,
  };
  activeTurns.set(sessionId, turn);

  const turnController = createTurnController(effectiveMaxSteps);
  const knownCtxWindow = contextWindowSize(modelId, modelEntry);
  const knownMaxInput = resolveMaxInputTokens(modelId, modelEntry) ?? knownCtxWindow;
  const knownMaxOutput = clampOutputForContext(
    resolveMaxOutputTokens(modelId, modelEntry),
    knownCtxWindow,
  );
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
  systemPrompt = injectTodoPlan(systemPrompt, sessionId);
  systemPrompt = injectRagDirective(systemPrompt, workspaceId);

  // Skill discovery catalog — rendered into the load_skill tool description
  // (OpenCode pattern), not the system prompt. Disabled skills are excluded.
  let skillIndex: import('./tools/tool-context.js').SkillSummary[] = [];
  try {
    skillIndex = scanProjectEntries(root).skills
      .filter((s) => !skillResult.disabledSkills.includes(s.name))
      .map((s) => ({ name: s.name, description: s.description, absPath: s.absPath }));
  } catch {}

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
    skills: skillIndex,
    compactionSettings: { enabled: compactionEnabled, threshold: compactionThreshold, keepRecentTurns: compactionKeepTurns, onFailure: 'truncate' } satisfies CompactionSettings,
    onUsage: (u) => accumulateUsage(turn, u),
    abortSignal: controller.signal,
    thinkingLevel,
    emit: (raw) => bridgeToolEmit(wc, turn, raw),
    emitToolEvent: (e) => {
      // Sub-agent tool events ride this channel (not ctx.emit) — mirror them
      // into turn.blocks so the nested calls persist with the message.
      mirrorSubagentToolEvent(turn, e as { type?: string; [k: string]: unknown });
      send(wc, sessionId, { ...e, sessionId, seq: nextSeq(sessionId), messageId: turn.messageId } as any);
    },
  };
  activeCtxs.set(sessionId, ctx);

  const tools = { ...buildToolset(ctx, loadHookConfig(root)), ...mcpTools };

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
    // Inside the try: a throw in resolveModel/toolset/hook setup above must
    // not orphan a v2 message row with no parts and no message.end.
    turn.v2 = initV2Turn(sessionId, modelId);
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

          onError: ({ error }) => {
            turn.errored = providerErrorMessage(error);
            turn.lastError = turn.errored;
          },
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
            turn.errored = turn.errored ?? providerErrorMessage(streamErr);
            turn.lastError = turn.lastError ?? turn.errored;
          }
        }

        let responseMsgs: ModelMessage[] = [];
        try { responseMsgs = await result.responseMessages; } catch {}
        if (responseMsgs.length > 0) {
          currentConvo = [...currentConvo, ...responseMsgs];
          turn.responseMessages.push(...responseMsgs);
        }

        // Loop guards: after a step that used tools, steer the model out of
        // repeat/budget spirals with a one-shot reminder (same mechanism as
        // RESUME_MESSAGE — a user-role nudge appended to the conversation).
        if (turn.stepHadToolCalls) {
          const guard = loopGuardReminder(turn);
          if (guard) currentConvo = [...currentConvo, { role: 'user' as const, content: guard }];
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

        // Step completed cleanly — a retry budget consumed by earlier steps
        // shouldn't doom later ones, so re-earn the full budget each step. The
        // step recovered, so a stale retry error must not resurface if the
        // user aborts later in the turn.
        retryCount = 0;
        turn.lastError = null;

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
        turn.lastError = turn.errored;
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
      emitSink(turn.v2?.textDelta(turn.currentTextBlockId!, text) ?? []);
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
      emitSink(turn.v2?.toolStart(toolCallId) ?? []);
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
      emitSink(turn.v2?.toolEnd(toolCallId, { toolName, input, output: tr.output, status, durationMs: tr.durationMs }) ?? []);
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
      let msg = providerErrorMessage(p.error) || 'Stream error';
      if (/no output generated/i.test(msg)) msg += ' (provider returned an empty stream — usually a rejected option like `thinking` or an unknown model id.)';
      turn.errored = msg;
      turn.lastError = msg;
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
  emitSink(turn.v2?.finish(turn.usage) ?? []);
  const blocks = finalizeBlocks(turn, stopReason);
  // Surface the error to the UI on failure (retries exhausted or non-retryable).
  // Sent BEFORE turn_end so the reducer records the error, then turn_end flips
  // isStreaming — the error UI (gated on !isStreaming) appears exactly once, at
  // the end. Covers stream-throw errors that never emitted an `error` part.
  // Aborted turns surface the failure too: a user stopping out of a retry
  // spiral still deserves to know why the turn was failing.
  const failureMsg = stopReason === 'aborted' ? (turn.errored ?? turn.lastError) : turn.errored;
  if ((stopReason === 'refusal' || stopReason === 'aborted') && failureMsg) {
    send(wc, turn.sessionId, { type: 'error', sessionId: turn.sessionId, seq: nextSeq(turn.sessionId), message: failureMsg });
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
  journalEditTurn(turn);
  fireTurnEndNotification(wc, turn.sessionId, stopReason);
}

/** Message row for the v2 stream lands at turn start (the sink only writes
 *  parts/events); parts reference it, message.end completes it. Called inside
 *  the turn's try so a setup throw can't orphan the row. A missing v2 session
 *  row (legacy-only session, e.g. sub-agent dispatch children) fails the FK
 *  insert — v2 emission for the turn is simply off. */
function initV2Turn(sessionId: string, modelId: string): V2TurnTracker | null {
  if (!sink || !storeV2) return null;
  const messageId = newV2MessageId();
  try {
    storeV2.insertMessage({ id: messageId, sessionId, role: 'assistant', model: modelId });
  } catch {
    log.warn('v2 turn init failed — continuing legacy-only', { sessionId });
    return null;
  }
  return createV2TurnTracker({ sessionId, messageId });
}

/** Emit tracker-produced v2 events — always non-fatal: a sink bug must never
 *  break the turn (the sink itself already degrades on DB failure). */
function emitSink(events: SinkEvent[]): void {
  if (!sink) return;
  for (const e of events) {
    try { sink.emit(e); } catch {}
  }
}

/** Edit-tool calls whose file argument names a workspace file. */
const EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file']);

/** After a turn that edited files, write an episodic record into the
 *  workspace RAG index (see rag/edit-journal.ts). Fire-and-forget —
 * recordEditTurn swallows its own errors. */
function journalEditTurn(turn: Turn): void {
  const editCalls = turn.toolCalls.filter(
    (tc) => EDIT_TOOLS.has(tc.toolName) && tc.status === 'executed' && typeof tc.arguments?.path === 'string',
  );
  if (editCalls.length === 0) return;
  void recordEditTurn(turn.workspaceId, {
    sessionId: turn.sessionId,
    messageId: turn.messageId,
    files: [...new Set(editCalls.map((tc) => tc.arguments.path as string))],
    operations: editCalls.map((tc) => `${tc.toolName} ${tc.argPreview}`),
    summary: turn.finalText,
    createdAt: Date.now(),
  });
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

/** Detect tool-loop spirals across the turn's accumulated calls — the same
 *  tool+arguments repeated, or an excessive total call count — and return a
 *  reminder to steer the model out. Each trigger fires once per turn. */
function loopGuardReminder(turn: Turn): string | null {
  const counts = new Map<string, number>();
  for (const tc of turn.toolCalls) {
    let sig: string;
    try { sig = `${tc.toolName}:${JSON.stringify(tc.arguments ?? {})}`; } catch { sig = tc.toolName; }
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  for (const [sig, n] of counts) {
    if (n >= LOOP_DUPLICATE_THRESHOLD && !turn.loopGuardFired.has(sig)) {
      turn.loopGuardFired.add(sig);
      const name = sig.slice(0, sig.indexOf(':'));
      return `<system-reminder>Loop guard: you have called ${name} with the same arguments ${n} times this turn. Retrying the identical call will return the identical result — reread the earlier outputs, change your approach, or ask the user how to proceed.</system-reminder>`;
    }
  }
  if (turn.toolCalls.length >= LOOP_BUDGET_WARNING && !turn.loopGuardFired.has('__budget__')) {
    turn.loopGuardFired.add('__budget__');
    return `<system-reminder>Loop guard: this turn has made ${turn.toolCalls.length} tool calls. If progress has stalled, stop calling tools reflexively — reassess the approach, finish with what you have, or stop and explain what is blocking you.</system-reminder>`;
  }
  return null;
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

/** Mirror a sub-agent tool lifecycle event (parentToolCallId set) into the
 *  turn's block state so finalizeBlocks persists the nested calls. The
 *  renderer nests them live from the streamed events, but the stored message
 *  drops them without this — the dispatch row's children vanish as soon as
 *  the turn freezes to the persisted message. */
function mirrorSubagentToolEvent(turn: Turn, e: { type?: string; [k: string]: unknown }): void {
  if (typeof e.parentToolCallId !== 'string' || !e.parentToolCallId) return;
  const toolCallId = e.toolCallId as string;
  if (!toolCallId) return;
  const toolName = resolveToolName((e.toolName as string) ?? 'unknown') as ToolName;
  const meta = safeMeta(toolName);
  if (e.type === 'tool_call_start') {
    turn.toolBlockIndex[toolCallId] = turn.blocks.length;
    turn.blocks.push({ id: toolCallId, kind: 'tool', toolCallId, toolName, category: categorizeTool(toolName), status: 'pending', arguments: {}, argPreview: '', riskTier: meta?.riskTier ?? 'read_only', createdAtSeq: 0, modifiedAtSeq: 0, parentToolCallId: e.parentToolCallId });
  } else if (e.type === 'tool_call') {
    patchToolBlock(turn, toolCallId, { arguments: (e.arguments ?? {}) as Record<string, unknown>, argPreview: (e.argPreview as string) ?? '', riskTier: meta?.riskTier ?? 'read_only', status: 'running' });
  } else if (e.type === 'tool_result') {
    patchToolBlock(turn, toolCallId, { status: normalizeStatus(e.status as ToolResult['status']), output: (e.output as string) ?? '', display: e.display as ToolDisplay | undefined, durationMs: e.durationMs as number | undefined, meta: e.meta as string | undefined });
  }
}

function bridgeToolEmit(wc: WebContents, turn: Turn, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const e = raw as { type?: string; [k: string]: unknown };
  const { sessionId } = turn;

  if (e.parentToolCallId) {
    mirrorSubagentToolEvent(turn, e);
    return;
  }

  if (e.type === 'permission') {
    const toolName = resolveToolName((e.toolName as string) ?? 'unknown') as ToolName;
    const args = (e.args ?? {}) as Record<string, unknown>;
    const meta = safeMeta(toolName);
    const toolCallId = (typeof e.toolCallId === 'string' && e.toolCallId) || `perm_${toolName}_${nextSeq(sessionId)}`;
    const tc: ToolCall = { id: toolCallId, messageId: turn.messageId, toolName, arguments: args, argPreview: formatArgPreview(toolName, args), status: 'pending', riskTier: meta?.riskTier ?? 'read_only', gateDecision: e.decision === 'blocked' ? 'blocked' : 'ask' };
    send(wc, sessionId, { type: 'permission_required', sessionId, seq: nextSeq(sessionId), toolCalls: [tc], timeoutAt: Date.now() + turn.permissionTimeoutMs });
    return;
  }

  if (e.type === 'dispatch_result') {
    send(wc, sessionId, {
      type: 'dispatch_result', sessionId, seq: nextSeq(sessionId),
      dispatchId: (e.dispatchId as string) ?? '',
      title: typeof e.title === 'string' ? e.title : undefined,
      state: e.state === 'error' ? 'error' : 'completed',
      report: (e.report as string) ?? '',
    });
    return;
  }

  if (e.type === 'followup') {
    send(wc, sessionId, { type: 'followup_required', sessionId, seq: nextSeq(sessionId), toolCallId: (e.toolCallId as string) ?? '', question: (e.question as string) ?? '', options: (e.options as string[]) ?? [], optionDescriptions: (e.optionDescriptions as (string | undefined)[] | undefined) ?? undefined, multiple: (e.multiple as boolean) ?? false });
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
    // Load first, then consume the markers with an outcome-accurate note — a
    // blanket "(skill loaded)" on a failed load tells the model instructions
    // exist when they don't. The body is injected under "# Active Skills" and
    // the synthesized load_skill card records the load in the timeline; the
    // raw marker must go or the model re-invokes load_skill itself,
    // duplicating the card.
    const consumed = new Map<string, string>();
    for (const [idx, match] of markers.entries()) {
      const path = match[1].trim();
      const name = match[2]?.trim();
      const label = name ?? path;
      let body = '';
      try {
        // runLoadSkill returns a ToolResult; the SKILL.md text lives in
        // display.body (output is just the summary line).
        const res = await runLoadSkill(path, root);
        body = res.display?.kind === 'file_loaded' ? res.display.body : '';
      } catch {}
      consumed.set(match[0], body
        ? `(skill "${label}" loaded)`
        : `(skill "${label}" failed to load — not found at ${path})`);
      if (!body) continue;
      skillBodies += body + '\n\n';
      if (name) { activeSkillRef = { path }; sessions.setActiveSkillRef(turn.sessionId, { name, path, loadedAt: new Date().toISOString() }); }
      const skillId = `skill_${Date.now()}_${idx}`;
      send(wc, turn.sessionId, { type: 'tool_call_start', sessionId: turn.sessionId, seq: nextSeq(turn.sessionId), messageId: turn.messageId, toolCallId: skillId, toolName: 'load_skill', blockId: skillId });
      send(wc, turn.sessionId, { type: 'tool_result', sessionId: turn.sessionId, seq: nextSeq(turn.sessionId), toolCallId: skillId, status: 'executed', output: `Skill "${label}" loaded.`, meta: label });
    }
    for (const m of convo) {
      if (typeof m.content === 'string' && m.content.includes('[[LOAD_SKILL:')) {
        m.content = m.content.replace(
          /\[\[LOAD_SKILL:[^\]|]+(?:\|[^\]]+)?\]\]/g,
          (all) => consumed.get(all) ?? '(skill failed to load)',
        );
      }
    }
  } catch {}

  if (priorSkillRef && !activeSkillRef) {
    try {
      const res = await runLoadSkill(priorSkillRef.path, root);
      const body = res.display?.kind === 'file_loaded' ? res.display.body : '';
      if (body) { skillBodies += body + '\n\n'; activeSkillRef = { path: priorSkillRef.path }; }
    } catch {}
  }

  try { disabledSkills = createExtensionsStore(appDataDir()).getDisabled().skills; } catch {}

  return { skillBodies, activeSkillRef, disabledSkills };
}

function injectSkillBodies(sp: string, bodies: string): string {
  // The header doubles as the dedup guard: skills listed here are already
  // loaded, so re-invoking load_skill/slash_command for them is wasted work.
  return bodies.trim()
    ? sp + '\n\n# Active Skills\nAlready loaded this session — do NOT call `load_skill` or `slash_command` for these again.\n\n' + bodies.trim()
    : sp;
}

function injectTodoPlan(sp: string, sessionId: string): string {
  try {
    const todos = getSessionTodos(sessionId);
    if (!todos?.length) return sp;
    // Collapsing cancelled/in_progress to an open checkbox invites redoing
    // cancelled work — renderTodoPlanLines keeps the 4 distinct states.
    return sp + '\n\n# Current Plan\nKeep this list accurate — call todo_write to mark items completed or cancelled the moment their work finishes, never leave an item open after moving to other work.\n' + renderTodoPlanLines(todos).join('\n');
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

async function toCoreMessage(m: TurnMessage, delivery: AttachmentDelivery): Promise<ModelMessage | null> {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  let content = m.content;
  const imageParts: Array<{ type: 'image'; image: string; mimeType: string }> = [];
  if (m.attachments?.length) {
    const blocks = m.attachments.filter(a => a.content).map(a => `<file path="${a.path}">\n${a.content}\n</file>`);
    // Path-only attachments (images/media) resolve through a fallback chain:
    // 1) vision model → inline as image parts (the model sees them directly),
    // 2) image-capable MCP tool → point the model at it with the path,
    // 3) read_media_file with the exact absolute path.
    const media = m.attachments.filter(a => !a.content && (a.absPath ?? a.path));
    for (const a of media) {
      const abs = a.absPath ?? a.path;
      const mime = mediaMimeFor(abs);
      if (delivery.vision && mime && INLINE_IMAGE_MIMES.has(mime)) {
        const base64 = await readInlineImage(abs);
        if (base64 !== null) {
          imageParts.push({ type: 'image', image: base64, mimeType: mime });
          blocks.push(`<file path="${abs}" kind="image" note="user-attached image — inlined with this message, you can see it directly"/>`);
          continue;
        }
      }
      if (delivery.mcpImageTools.length) {
        blocks.push(`<file path="${abs}" kind="image" note="user-attached media — you cannot view images directly; an image-capable MCP tool (${delivery.mcpImageTools.join(', ')}) may be able to analyze it with this path"/>`);
      } else {
        blocks.push(`<file path="${abs}" kind="image" note="user-attached image — use read_media_file with this exact absolute path to view it"/>`);
      }
    }
    if (blocks.length) content += '\n\n' + blocks.join('\n\n');
  }
  if (imageParts.length) {
    return { role: m.role, content: [{ type: 'text', text: content }, ...imageParts] } as ModelMessage;
  }
  return { role: m.role, content } as ModelMessage;
}

/** Read an image file as base64 for inlining; null when missing/oversized —
 *  callers fall through to the next tier of the attachment chain. */
async function readInlineImage(abs: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(abs);
    if (stat.size > INLINE_IMAGE_MAX_BYTES) return null;
    return (await fs.promises.readFile(abs)).toString('base64');
  } catch {
    return null;
  }
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

/** Provider-facing errors keep the HTTP status in the message text. The SDK's
 * APICallError carries the status only as a field, so a 403 whose body says
 * "This is a premium model..." otherwise classifies as transient (the message
 * contains no status keyword) and the turn burns its retry budget on a
 * permanently denied request. */
function providerErrorMessage(err: unknown): string {
  const base = errMessage(err);
  const status = (err as { statusCode?: number } | null)?.statusCode;
  return status ? `${base} (HTTP ${status})` : base;
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
