/** Sub-agent runtime: single-shot (no allowedTools → one generateText call) or multi-step (has allowedTools → streamText tool loop with repairToolCall, recursive + depth-guarded). Both inherit parent provider/model/protocol, fold usage into the parent, and return a ToolResult. */
import { generateText, streamText, isStepCount } from 'ai';
import type { LanguageModelUsage, ModelMessage } from 'ai';
import { resolveModel } from '../provider-factory.js';
import { resolveProtocolOptions, resolveReasoning } from '../protocols/index.js';
import type { ReasoningInstruction } from '../protocols/index.js';
import { resolveMaxOutputTokens, contextWindowSize, resolveReasoningContracts } from '../model-capabilities.js';
import { buildToolsetSubset, formatArgPreview, resolveToolName } from '../tools/registry.js';
import { effectiveChildTools } from './registry.js';
import { getToolMeta } from '../tools/tool-meta.js';
import { currentToolCallId } from '../tools/tool-call-context.js';
import { categorizeTool } from '../../../../src/lib/stream/block-state.js';
import { repairJsonToolInput } from '../tool-input-repair.js';
import { createLogger } from '../../logger.js';
import { getSessionStore } from '../../ipc-adjacent/sessions.js';
import type { Provider, Usage, AutonomyMode, ToolName } from '../../../../src/types/index.js';
import type { CompactionSettings } from '../../../../src/types/compaction.js';
import type { RuleSet } from '../permissions/rules.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolContext, EmitToolEvent } from '../tools/tool-context.js';
import type { AgentDef } from './types.js';
import {
  shouldCompact,
  compactConversation,
  DEFAULT_AUTO_COMPACT_CONFIG,
  type AutoCompactConfig,
} from '../context/auto-compact.js';

const log = createLogger('agent/runtime');

export interface RunAgentOptions {
  /** The agent definition (name + system prompt + optional allowedTools). */
  agent: AgentDef;
  /** The self-contained task from the dispatch_agent tool call. */
  task: string;
  /** Parent turn's provider — sub-agents inherit it (and thus the protocol). */
  provider: Provider;
  /** Parent turn's model id — sub-agents inherit it. */
  modelId: string;
  /** Parent turn's abort signal — sub-agents die with the parent. */
  signal: AbortSignal;
  /** Optional accumulator — folds this call's usage into the parent turn. */
  onUsage?: (u: Usage) => void;
  /** Streaming text listener (dispatch-agent forwards the parent turn's delta surface). Not yet consumed inside runAgent. */
  onDelta?: (delta: string) => void;
  /** Parent tool context — needed for multi-step agents to build their toolset.
   *  Carries workspaceRoot, permissionRules, autonomyMode, etc. */
  ctx?: ToolContext;
  /** Recursion depth (0 = dispatched from main orchestrator). */
  depth?: number;
  /** The parent turn's thinking level — inherited as the sub-agent default
   *  when AgentDef.thinkingLevel is not set. Lets the user's slider choice
   *  propagate to dispatched specialists. */
  thinkingLevel?: import('../../../../src/types/index.js').ThinkingLevel;
  /** The parent dispatch_agent's toolCallId — used as parentToolCallId on
   *  child tool events so the renderer nests them under the dispatch block.
   *  Captured automatically from AsyncLocalStorage if omitted. */
  parentToolCallId?: string;
  /** Short human-readable label for this dispatch — distinguishes parallel
   *  dispatches of the same agent type in the UI. Surfaces in the ToolDisplay
   *  agent payload and the row's target slot. */
  title?: string;
  /** Prior transcript when resuming a dispatch — seeds the loop instead of
   *  a bare task message, and continues the existing child session. */
  resume?: { sessionId: string; messages: ModelMessage[] };
  /** Fired as soon as the dispatch's child session id is known — BEFORE the
   *  run completes, so background callers can correlate failures (whose
   *  ToolResults carry no display payload) with their dispatch row. */
  onDispatchId?: (id: string) => void;
}

/** Default thinking level for sub-agents when neither the agent definition
 *  nor the parent turn specifies one. 'medium' gives enough reasoning room
 *  for multi-step investigation without excessive latency. */
const DEFAULT_THINKING_LEVEL = 'medium' as const;

/** Max nesting depth for recursive dispatch. */
export const MAX_AGENT_DEPTH = 3;

function mapUsage(u: LanguageModelUsage, calls = 1): Usage {
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheRead: u.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0,
    calls,
    costUsd: 0,
  };
}

/** Run a sub-agent and return a ToolResult for dispatch_agent; multi-step (streamText loop) when allowedTools+ctx are present, otherwise single-shot generateText. */
export async function runAgent(opts: RunAgentOptions): Promise<ToolResult> {
  const { agent, task, provider, modelId, signal, onUsage, ctx, depth = 0 } = opts;
  const start = Date.now();
  const thinkingLevel = agent.thinkingLevel ?? opts.thinkingLevel ?? DEFAULT_THINKING_LEVEL;

  if (!provider.apiKey) {
    return {
      status: 'failed',
      output: `Agent ${agent.name} cannot run: parent provider has no API key.`,
      durationMs: 0,
    };
  }

  // Multi-step agent: has tools + ctx. Gates on effectiveTools, not raw
  // allowedTools — an agent declaring only canDispatch lists no tools but
  // still gets the dispatch tool, and must not fall through to single-shot.
  const effectiveTools = effectiveChildTools(agent);
  if (effectiveTools.length && ctx) {
    return runMultiStepAgent(opts, thinkingLevel, start, effectiveTools);
  }

  // Single-shot agents keep no persisted transcript worth continuing, and
  // their bare generateText path has no tool loop to resume into.
  if (opts.resume) {
    return {
      status: 'failed',
      output: `Agent ${agent.name} is single-shot (no tools) and cannot be resumed via resumeFrom — dispatch it fresh with the needed context in the task.`,
      durationMs: 0,
    };
  }

  // Single-shot agent: no tools (legacy path).
  return runSingleShotAgent(opts, thinkingLevel, start);
}

// ─── Single-shot path (unchanged from before) ──────────────────────────

async function runSingleShotAgent(
  opts: RunAgentOptions,
  thinkingLevel: import('../../../../src/types/index.js').ThinkingLevel,
  start: number,
): Promise<ToolResult> {
  const { agent, task, provider, modelId, signal, onUsage } = opts;
  const modelEntry = provider.models.find((m) => m.modelId === modelId);
  const knownMaxOutput = resolveMaxOutputTokens(modelId, modelEntry);
  const contracts = resolveReasoningContracts(modelId, modelEntry);
  const reasoning: ReasoningInstruction | null = resolveReasoning(
    thinkingLevel, contracts, provider.apiStyle, knownMaxOutput,
  );

  const proto = resolveProtocolOptions(
    provider.apiStyle,
    reasoning,
    { hasTools: false, modelId, maxOutputTokens: knownMaxOutput, providerBaseUrl: provider.baseUrl },
  );

  const childSessionId = opts.ctx
    ? opts.resume?.sessionId ?? createDispatchSession(opts.ctx, agent, task, opts.title, modelId)
    : undefined;
  if (childSessionId) {
    opts.onDispatchId?.(childSessionId);
    if (opts.resume) setDispatchStatusSafe(childSessionId, 'running');
  }

  try {
    const model = resolveModel(provider, { modelId, contextWindow: 0 } as any);
    // runAgent guards resume to the multi-step path; kept here defensively
    // so a direct runSingleShotAgent call still resumes rather than restarting.
    const shared = {
      model,
      system: agent.systemPrompt,
      providerOptions: proto.providerOptions,
      maxOutputTokens: proto.maxOutputTokens,
      abortSignal: signal,
    };
    const result = await generateText(
      opts.resume
        ? {
            ...shared,
            messages: [...opts.resume.messages, { role: 'user' as const, content: task }],
          }
        : { ...shared, prompt: task },
    );

    if (result.usage && onUsage) {
      onUsage(mapUsage(result.usage as LanguageModelUsage));
    }

    const tr = buildResult(agent, task, result.text, result.finishReason, result.reasoning, start, proto.label, opts.title, childSessionId);
    if (childSessionId) {
      if (tr.status === 'executed') {
        persistDispatchResult(childSessionId, task, tr.output, [], [
          { role: 'user', content: task },
          { role: 'assistant', content: tr.output },
        ]);
      } else {
        setDispatchStatusSafe(childSessionId, 'error');
      }
    }
    return tr;
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || signal.aborted;
    setDispatchStatusSafe(childSessionId, aborted ? 'interrupted' : 'error');
    return handleError(agent.name, e, signal, start);
  }
}

// ─── Multi-step path (streamText + tool loop) ──────────────────────────

async function runMultiStepAgent(
  opts: RunAgentOptions,
  thinkingLevel: import('../../../../src/types/index.js').ThinkingLevel,
  start: number,
  effectiveTools: string[],
): Promise<ToolResult> {
  const { agent, task, provider, modelId, signal, onUsage, ctx, depth, title } = opts;

  if (!ctx) {
    return { status: 'failed', output: `Agent ${agent.name}: no context for multi-step.`, durationMs: 0 };
  }
  if ((depth ?? 0) >= MAX_AGENT_DEPTH) {
    return {
      status: 'failed',
      output: `Agent ${agent.name}: max nesting depth (${MAX_AGENT_DEPTH}) reached. The main orchestrator should handle this directly.`,
      durationMs: 0,
    };
  }

  const maxSteps = agent.maxSteps ?? 10;

  // The parent dispatch_agent's toolCallId — used as the parentToolCallId
  // linkage on child tool events so the renderer nests them under the
  // dispatch block. Prefer the explicit arg; fall back to AsyncLocalStorage
  // (set by buildToolset's execute wrapper at registry.ts:251).
  const parentToolCallId = opts.parentToolCallId ?? currentToolCallId();

  // Resume continues the prior child session instead of creating a new one;
  // persistDispatchResult then overwrites its transcript with the full
  // (seeded) run, so the round-trip stays lossless for further resumes.
  const seedMessages: ModelMessage[] = [
    ...(opts.resume?.messages ?? []),
    { role: 'user' as const, content: task },
  ];
  const childSessionId = opts.resume?.sessionId ?? createDispatchSession(ctx, agent, task, title, modelId);
  if (childSessionId) {
    opts.onDispatchId?.(childSessionId);
    // A resumed child already reads completed/error from its prior run —
    // flip it back while this run is in flight.
    if (opts.resume) setDispatchStatusSafe(childSessionId, 'running');
  }

  // Build a child ToolContext for the sub-agent's toolset.
  // Note: an escalation granted on a nested dispatch mutates only this
  // copy (autonomyMode is per-context) — sub-agent autonomy stays contained
  // to the branch, stricter than the main turn. Intentional.
  const childCtx: ToolContext = {
    ...ctx,
    _depth: (depth ?? 0) + 1,
    _agentDef: agent,
    // Sub-agent usage folds into the parent's onUsage.
    onUsage: (u: Usage) => {
      onUsage?.(u);
    },
    // Forward permission/followup emits to the parent's bridge so a sub-agent
    // tool that needs approval surfaces its card instead of deadlocking. The
    // bridge keys everything off sessionId/messageId from the parent turn
    // closure, so the card reaches the right surface. (Previously this was a
    // no-op, which caused a silent hang on ask-level permission in ask/edit
    // mode — the emit was swallowed and waitForPermissionResolve awaited
    // forever.)
    emit: (raw) => ctx.emit(raw),
  };

  const tools = buildToolsetSubset(childCtx, effectiveTools);

  const modelEntry = provider.models.find((m) => m.modelId === modelId);
  const knownMaxOutput = resolveMaxOutputTokens(modelId, modelEntry);
  const contracts = resolveReasoningContracts(modelId, modelEntry);
  const reasoning: ReasoningInstruction | null = resolveReasoning(
    thinkingLevel, contracts, provider.apiStyle, knownMaxOutput,
  );
  const proto = resolveProtocolOptions(
    provider.apiStyle,
    reasoning,
    { hasTools: true, modelId, maxOutputTokens: knownMaxOutput, providerBaseUrl: provider.baseUrl },
  );

  // ── CONTEXT MANAGEMENT (mirrors main loop, orchestrator-sdk.ts:408-432) ──
  // Multi-step sub-agents accumulate large tool outputs (file reads, grep
  // results) and will stall against the context window — the model then stops
  // mid-task and suggests a new session. Wire the same autocompact loop the
  // main turn uses, driven by the user's CompactionSettings (on ctx) so the
  // sub-agent respects the same threshold / keep-turns / enable toggle.
  const knownCtxWindow = contextWindowSize(modelId, modelEntry);
  const cs = ctx.compactionSettings;
  const compactionConfig: AutoCompactConfig = knownCtxWindow && cs.enabled
    ? {
        ...DEFAULT_AUTO_COMPACT_CONFIG,
        contextWindow: knownCtxWindow,
        threshold: cs.threshold,
        // Sub-agents run shorter loops than the main turn — keep one fewer
        // turn pair so there is more room to compact into.
        keepRecentTurns: Math.max(1, cs.keepRecentTurns - 1),
      }
    : {
        // Compaction disabled or context window unknown — set a very high
        // threshold so shouldCompact never fires (main-loop parity, :425-432).
        ...DEFAULT_AUTO_COMPACT_CONFIG,
        contextWindow: knownCtxWindow ?? DEFAULT_AUTO_COMPACT_CONFIG.contextWindow,
        threshold: 0.99,
      };
  let lastInputTokens = 0;
  let consecutiveCompactionFailures = 0;

  log.info('multi-step agent', { name: agent.name, title, depth: depth ?? 0, tools: effectiveTools, maxSteps });

  try {
    const model = resolveModel(provider, { modelId, contextWindow: 0 } as any);
    const result = streamText({
      model,
      system: agent.systemPrompt,
      messages: seedMessages,
      tools: tools as any,
      maxRetries: 0,
      stopWhen: [isStepCount(maxSteps)],
      maxOutputTokens: proto.maxOutputTokens,
      abortSignal: signal,
      providerOptions: proto.providerOptions,

      // ── BETWEEN-STEP AUTOCOMPACT (mirrors orchestrator-sdk.ts:907-961) ──
      // When the running message list crosses the threshold (driven by the
      // user's CompactionSettings via compactionConfig), fork a summarizer
      // over old messages and keep recent turns verbatim. Prevents the model
      // from hitting the wall and abandoning the task.
      async prepareStep({ messages }) {
        if (
          shouldCompact(
            messages,
            compactionConfig,
            consecutiveCompactionFailures,
            lastInputTokens || undefined,
          )
        ) {
          try {
            const result = await compactConversation(messages, compactionConfig, {
              provider,
              modelId,
              signal,
            });
            consecutiveCompactionFailures = 0;
            log.info('sub-agent autocompact', {
              agent: agent.name,
              before: messages.length,
              after: result.postCompactMessages.length,
            });
            return { messages: result.postCompactMessages };
          } catch (e: any) {
            consecutiveCompactionFailures++;
            log.warn('sub-agent autocompact failed', {
              agent: agent.name,
              failures: consecutiveCompactionFailures,
              err: e?.message ?? e,
            });
          }
        }
        return undefined;
      },

      // Track the last step's real input-token count — shouldCompact prefers
      // this over the char heuristic (orchestrator-sdk.ts:920-921 parity).
      onStepFinish({ usage }) {
        if (usage?.inputTokens && usage.inputTokens > 0) {
          lastInputTokens = usage.inputTokens;
        }
      },

      // ── TOOL CALL REPAIR ──
      repairToolCall: async ({ toolCall }) => {
        const input = toolCall.input;
        if (typeof input !== 'string') return toolCall;
        const repaired = repairJsonToolInput(input);
        return repaired ? { ...toolCall, input: repaired } : null;
      },

      onError: ({ error }) => {
        log.warn('sub-agent stream error', { agent: agent.name, error: (error as { message?: string })?.message ?? String(error) });
      },
    });

    // Iterate the stream to surface the sub-agent's activity as nested
    // AgentEvents (mirrors orchestrator.ts:437). Tool lifecycle AND
    // text/reasoning deltas are forwarded via ctx.emitToolEvent with
    // parentToolCallId so parent-aware consumers (the Agents panel) can
    // stream the sub-agent's narration and thinking live under the
    // dispatch_agent block. Falls back to bare await when emitToolEvent is
    // unavailable (legacy ctx) so the sub-agent still completes — just
    // without visible child activity.
    let finalResult: Awaited<typeof result>;
    if (ctx.emitToolEvent && parentToolCallId) {
      try {
        const ids: SubagentBlockIds = {};
        for await (const part of result.stream) {
          translateSubagentPart(part, ctx.emitToolEvent, parentToolCallId, ids);
        }
      } catch (streamErr: any) {
        log.warn('sub-agent stream interrupted', { agent: agent.name, err: streamErr?.message ?? streamErr });
      }
      finalResult = await result;
    } else {
      finalResult = await result;
    }

    // streamText's result fields are ALL PromiseLike in AI SDK 7.x — awaiting
    // the stream result does NOT resolve them. Each must be awaited individually.
    const [reportText, finishReason, steps, totalUsage, reasoningText] = await Promise.all([
      finalResult.text,
      finalResult.finishReason,
      finalResult.steps,
      finalResult.totalUsage,
      finalResult.reasoningText,
    ]);

    const stepCount = steps?.length ?? 1;
    if (totalUsage && onUsage) {
      onUsage(mapUsage(totalUsage as LanguageModelUsage, stepCount));
    }

    const report = ((reportText as string | null | undefined) ?? '').trim();
    const reasoning =
      typeof reasoningText === 'string'
        ? reasoningText.trim() || undefined
        : undefined;

    if (!report) {
      // The agent exhausted its step budget calling tools without producing a
      // text report (finishReason=tool-calls). Rather than failing, make one
      // final tool-free call so the model synthesizes its findings into text.
      // The conversation lives in seedMessages (task, or the resumed
      // transcript) plus each step's generated messages; we reuse it as
      // context and instruct the model to write its report.
      const synthesized = await synthesizeReport({
        agent, steps, provider, modelId, signal, onUsage, seedMessages,
      });
      if (synthesized) {
        log.info('multi-step agent synthesized report', { name: agent.name, title, steps: stepCount, durationMs: Date.now() - start });
        persistDispatchResult(childSessionId, task, synthesized, steps, seedMessages);
        return {
          status: 'executed',
          output: synthesized,
          durationMs: Date.now() - start,
          meta: `${agent.name} · ${proto.label} · ${stepCount}+1 steps`,
          display: {
            kind: 'agent',
            agentName: agent.name,
            ...(title ? { title } : {}),
            task,
            report: synthesized,
            ...(childSessionId ? { dispatchId: childSessionId } : {}),
          },
        };
      }
      setDispatchStatusSafe(childSessionId, 'error');
      return {
        status: 'failed',
        output: `Agent ${agent.name}${title ? ` (${title})` : ''} returned no content (finishReason=${finishReason}, steps=${stepCount}).`,
        durationMs: Date.now() - start,
        meta: `${agent.name} · ${proto.label} · ${stepCount} steps`,
      };
    }

    log.info('multi-step agent done', { name: agent.name, title, steps: stepCount, durationMs: Date.now() - start });

    persistDispatchResult(childSessionId, task, report, steps, seedMessages);

    return {
      status: 'executed',
      output: report,
      durationMs: Date.now() - start,
      meta: `${agent.name} · ${proto.label} · ${stepCount} steps`,
      display: {
        kind: 'agent',
        agentName: agent.name,
        ...(title ? { title } : {}),
        task,
        report,
        reasoning,
        ...(childSessionId ? { dispatchId: childSessionId } : {}),
      },
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || signal.aborted;
    setDispatchStatusSafe(childSessionId, aborted ? 'interrupted' : 'error');
    return handleError(agent.name, e, signal, start);
  }
}

// ─── Forced synthesis (step-budget exhaustion recovery) ────────────────

/** When a multi-step agent exhausts its step budget calling tools (finishReason=tool-calls)
 *  without emitting a text report, make one final tool-free generateText call
 *  so the model synthesizes its findings. The steps array carries the full
 *  conversation (user task + tool calls + tool results); we reuse it as
 *  context and instruct the model to write its report. Returns null on failure
 *  so the caller falls back to the 'no content' error. */
async function synthesizeReport(opts: {
  agent: AgentDef;
  steps: ReadonlyArray<{ messages?: ModelMessage[]; response?: { messages?: ModelMessage[] } }>;
  provider: Provider;
  modelId: string;
  signal: AbortSignal;
  onUsage?: (u: Usage) => void;
  seedMessages: ModelMessage[];
}): Promise<string | null> {
  try {
    // ai 7 StepResult carries per-step messages under response.messages —
    // step.messages doesn't exist, so without the fallback nothing
    // accumulates and this recovery path always bails.
    const allMessages: ModelMessage[] = [
      ...opts.seedMessages,
      ...opts.steps.flatMap((st) => st.messages ?? st.response?.messages ?? []),
    ];

    allMessages.push({
      role: 'user',
      content: 'Based on your investigation above, write your final report now. Do not call any more tools. Summarize what you found and provide your conclusion.',
    } as ModelMessage);

    // Re-resolve the protocol with reasoning disabled: reusing the parent's
    // providerOptions lets a reasoning model spend the whole synthesis call's
    // output budget on thinking tokens and return empty text — the exact
    // failure this recovery path exists to fix.
    const modelEntry = opts.provider.models.find((m) => m.modelId === opts.modelId);
    const knownMaxOutput = resolveMaxOutputTokens(opts.modelId, modelEntry);
    const synthProto = resolveProtocolOptions(
      opts.provider.apiStyle,
      null,
      { hasTools: false, modelId: opts.modelId, maxOutputTokens: knownMaxOutput, providerBaseUrl: opts.provider.baseUrl },
    );

    const model = resolveModel(opts.provider, { modelId: opts.modelId, contextWindow: 0 } as any);
    const result = await generateText({
      model,
      system: opts.agent.systemPrompt,
      messages: allMessages,
      providerOptions: synthProto.providerOptions,
      maxOutputTokens: synthProto.maxOutputTokens,
      abortSignal: opts.signal,
    });

    if (result.usage && opts.onUsage) {
      opts.onUsage(mapUsage(result.usage as LanguageModelUsage));
    }

    const text = ((result.text as string | null | undefined) ?? '').trim();
    if (!text) {
      log.warn('synthesizeReport returned empty text', {
        agent: opts.agent.name,
        finishReason: result.finishReason,
        outputTokens: result.usage?.outputTokens ?? 0,
        reasoningTokens: result.usage?.outputTokenDetails?.reasoningTokens ?? 0,
      });
      return null;
    }
    return text;
  } catch (e: any) {
    log.warn('synthesizeReport failed', { agent: opts.agent.name, err: e?.message ?? String(e) });
    return null;
  }
}

// ─── Sub-agent stream → nested tool events ──────────────────────────────

/** Block-id carry for translateSubagentPart — mirrors the orchestrator's
 *  turn.currentTextBlockId / turn.reasoningBlockId. Ids are always minted
 *  locally (crypto.randomUUID), never taken from the SDK part: providers
 *  may reuse one part id across every step of a run. Tool parts reset both
 *  so the next text/reasoning segment opens a fresh block (one thinking
 *  block per model step). */
export interface SubagentBlockIds {
  textBlockId?: string;
  reasoningBlockId?: string;
}

/** Translate an AI SDK stream part from a sub-agent's tool loop into a nested
 *  AgentEvent forwarded via ctx.emitToolEvent. Mirrors the orchestrator's
 *  translatePart (orchestrator.ts:556) but tags every event with
 *  parentToolCallId so the renderer nests the block under the dispatch_agent
 *  row. Tool lifecycle AND text/reasoning deltas are forwarded — parent-aware
 *  consumers (the Agents panel) render the narration/thinking; the main chat
 *  skips parented blocks. */
export function translateSubagentPart(
  part: Readonly<{ type: string }>,
  emit: EmitToolEvent,
  parentToolCallId: string,
  ids: SubagentBlockIds = {},
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = part as any;
  switch (part.type) {
    case 'text-delta': {
      const text: string = p.text ?? '';
      if (!text) return;
      // Never trust the SDK part's id here: some providers (z.ai) reuse the
      // same id across ALL steps of a run, which would merge post-tool
      // segments back into the pre-tool block (duplicated narration). The
      // tool cases below null the carry so each segment mints a fresh id.
      if (!ids.textBlockId) ids.textBlockId = crypto.randomUUID();
      emit({
        type: 'delta',
        parentToolCallId,
        text,
        blockId: ids.textBlockId,
      });
      return;
    }
    case 'reasoning-delta': {
      // The raw stream part carries its text on `text` (not `delta`) —
      // same shape the orchestrator's translatePart reads.
      const text: string = p.text ?? '';
      if (!text) return;
      // Same rationale as text-delta: provider part ids are per-run, not
      // per-step — always mint/reuse our own carry instead.
      if (!ids.reasoningBlockId) ids.reasoningBlockId = crypto.randomUUID();
      emit({
        type: 'reasoning',
        parentToolCallId,
        delta: text,
        blockId: ids.reasoningBlockId,
      });
      return;
    }
    case 'tool-input-start': {
      const toolCallId: string = p.id;
      const toolName = resolveToolName(p.toolName ?? 'unknown') as ToolName;
      // Mirror the orchestrator's tool-input-start reset: the segment before
      // the tool call is closed, the next text/reasoning delta opens a new
      // block.
      ids.textBlockId = undefined;
      ids.reasoningBlockId = undefined;
      emit({
        type: 'tool_call_start',
        parentToolCallId,
        toolCallId,
        toolName,
        blockId: toolCallId,
      });
      return;
    }
    case 'tool-input-delta': {
      const toolCallId: string = p.id;
      const delta: string = p.delta ?? '';
      if (!delta) return;
      emit({
        type: 'tool_call_delta',
        parentToolCallId,
        toolCallId,
        delta,
      });
      return;
    }
    case 'tool-call': {
      const toolCallId: string = p.toolCallId;
      const toolName = resolveToolName(p.toolName ?? 'unknown') as ToolName;
      const input = (p.input ?? {}) as Record<string, unknown>;
      const meta = getToolMeta(toolName);
      // Same segment reset as tool-input-start — some providers skip
      // input-start, and a synthesized id must not survive a tool boundary.
      ids.textBlockId = undefined;
      ids.reasoningBlockId = undefined;
      emit({
        type: 'tool_call',
        parentToolCallId,
        toolCallId,
        toolName,
        arguments: input,
        argPreview: formatArgPreview(toolName, input),
        riskTier: meta?.riskTier ?? 'read_only',
      });
      emit({
        type: 'tool_executing',
        parentToolCallId,
        toolCallId,
      });
      return;
    }
    case 'tool-result':
    case 'tool-error': {
      const toolCallId: string = p.toolCallId;
      const toolName = resolveToolName(p.toolName ?? 'unknown') as ToolName;
      const input = (p.input ?? {}) as Record<string, unknown>;
      // The SDK's tool-result carries the Tide ToolResult shape on p.output;
      // tool-error synthesizes a failed result.
      const tr: ToolResult =
        part.type === 'tool-result' && p.output && typeof p.output === 'object'
          ? ({ ...(p.output as object) } as ToolResult)
          : {
              status: 'failed',
              output: part.type === 'tool-error' ? (p.error?.message ?? 'Tool error') : '(no output)',
            };
      emit({
        type: 'tool_result',
        parentToolCallId,
        toolCallId,
        toolName,
        status: tr.status === 'executed' ? 'executed' : tr.status,
        output: tr.output,
        display: tr.display,
        durationMs: tr.durationMs,
        meta: tr.meta,
      });
      return;
    }
    default:
      // finish-step, start, raw, etc. have no parent-facing rendering.
      return;
  }
}



function createDispatchSession(
  ctx: ToolContext,
  agent: AgentDef,
  task: string,
  title: string | undefined,
  modelId: string,
): string | undefined {
  try {
    const child = getSessionStore().createSession(ctx.workspaceId, `${title ?? agent.name} (@${agent.name})`, modelId, {
      parentId: ctx.sessionId,
      kind: 'subagent',
      dispatch: { agentName: agent.name, ...(title ? { title } : {}), task, status: 'running' },
    });
    return child.id;
  } catch {
    // Store unavailable — dispatch still works inline, just unpersisted.
  }
}

function setDispatchStatusSafe(
  childSessionId: string | undefined,
  status: 'running' | 'completed' | 'error' | 'interrupted',
): void {
  if (!childSessionId) return;
  try {
    getSessionStore().setDispatchStatus(childSessionId, status);
  } catch { /* best-effort */ }
}

function persistDispatchResult(
  childSessionId: string | undefined,
  task: string,
  report: string,
  steps: ReadonlyArray<{ messages?: ModelMessage[]; response?: { messages?: ModelMessage[] } }>,
  seedMessages: ModelMessage[],
): void {
  if (!childSessionId) return;
  try {
    const now = new Date().toISOString();
    // StepResults in ai 7.x carry their generated messages under
    // response.messages (a top-level step.messages no longer exists), so the
    // lossless transcript is the seed plus each step's response messages.
    getSessionStore().saveDispatchTranscript(
      childSessionId,
      [
        { id: `${childSessionId}_u1`, role: 'user', content: task, createdAt: now },
        { id: `${childSessionId}_a1`, role: 'assistant', content: report, createdAt: now },
      ],
      [...seedMessages, ...steps.flatMap((st) => st.messages ?? st.response?.messages ?? [])],
    );
    setDispatchStatusSafe(childSessionId, 'completed');
  } catch { /* best-effort */ }
}

function buildResult(
  agent: AgentDef,
  task: string,
  text: string | null | undefined,
  finishReason: string | undefined,
  reasoning: unknown,
  start: number,
  label: string,
  title?: string,
  dispatchId?: string,
): ToolResult {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    return {
      status: 'failed',
      output: `Agent ${agent.name} returned no content (finishReason=${finishReason}).`,
      durationMs: Date.now() - start,
      meta: `via ${label}`,
    };
  }

  const reasoningText =
    typeof reasoning === 'string'
      ? (reasoning as string).trim() || undefined
      : undefined;

  return {
    status: 'executed',
    output: trimmed,
    durationMs: Date.now() - start,
    meta: `${agent.name} · ${label}`,
    display: {
      kind: 'agent',
      agentName: agent.name,
      ...(title ? { title } : {}),
      task,
      report: trimmed,
      reasoning: reasoningText,
      ...(dispatchId ? { dispatchId } : {}),
    },
  };
}

function handleError(name: string, e: any, signal: AbortSignal, start: number): ToolResult {
  const aborted = e?.name === 'AbortError' || signal.aborted;
  return {
    status: aborted ? 'aborted' : 'failed',
    output: aborted
      ? `Agent ${name} aborted.`
      : `Agent ${name} failed: ${e?.message || String(e)}`,
    durationMs: Date.now() - start,
  };
}
