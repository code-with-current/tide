/** Sub-agent runtime: single-shot (no allowedTools → one generateText call) or multi-step (has allowedTools → streamText tool loop with repairToolCall, recursive + depth-guarded). Both inherit parent provider/model/protocol, fold usage into the parent, and return a ToolResult. */
import { generateText, streamText, isStepCount } from 'ai';
import type { LanguageModelUsage, ModelMessage } from 'ai';
import { resolveModel } from '../provider-factory.js';
import { resolveProtocolOptions, resolveReasoning } from '../protocols/index.js';
import type { ReasoningInstruction } from '../protocols/index.js';
import { resolveMaxOutputTokens, contextWindowSize, resolveReasoningContracts } from '../model-capabilities.js';
import { buildToolsetSubset, formatArgPreview, resolveToolName } from '../tools/registry.js';
import { getToolMeta } from '../tools/tool-meta.js';
import { currentToolCallId } from '../tools/tool-call-context.js';
import { categorizeTool } from '../../../src/lib/stream/block-state.js';
import { createLogger } from '../../logger.js';
import type { Provider, Usage, AutonomyMode, ToolName } from '../../../src/types/index.js';
import type { CompactionSettings } from '../../../src/types/compaction.js';
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
  /** Parent tool context — needed for multi-step agents to build their toolset.
   *  Carries workspaceRoot, permissionRules, autonomyMode, etc. */
  ctx?: ToolContext;
  /** Recursion depth (0 = dispatched from main orchestrator). */
  depth?: number;
  /** The parent turn's thinking level — inherited as the sub-agent default
   *  when AgentDef.thinkingLevel is not set. Lets the user's slider choice
   *  propagate to dispatched specialists. */
  thinkingLevel?: import('../../../src/types/index.js').ThinkingLevel;
  /** The parent dispatch_agent's toolCallId — used as parentToolCallId on
   *  child tool events so the renderer nests them under the dispatch block.
   *  Captured automatically from AsyncLocalStorage if omitted. */
  parentToolCallId?: string;
  /** Short human-readable label for this dispatch — distinguishes parallel
   *  dispatches of the same agent type in the UI. Surfaces in the ToolDisplay
   *  agent payload and the row's target slot. */
  title?: string;
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

  // Multi-step agent: has tools + ctx.
  if (agent.allowedTools?.length && ctx) {
    return runMultiStepAgent(opts, thinkingLevel, start);
  }

  // Single-shot agent: no tools (legacy path).
  return runSingleShotAgent(opts, thinkingLevel, start);
}

// ─── Single-shot path (unchanged from before) ──────────────────────────

async function runSingleShotAgent(
  opts: RunAgentOptions,
  thinkingLevel: import('../../../src/types/index.js').ThinkingLevel,
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
    { hasTools: false, modelId, maxOutputTokens: knownMaxOutput },
  );

  try {
    const model = resolveModel(provider, { modelId, contextWindow: 0 } as any);
    const result = await generateText({
      model,
      system: agent.systemPrompt,
      prompt: task,
      providerOptions: proto.providerOptions,
      maxOutputTokens: proto.maxOutputTokens,
      abortSignal: signal,
    });

    if (result.usage && onUsage) {
      onUsage(mapUsage(result.usage as LanguageModelUsage));
    }

    return buildResult(agent, task, result.text, result.finishReason, result.reasoning, start, proto.label, opts.title);
  } catch (e: any) {
    return handleError(agent.name, e, signal, start);
  }
}

// ─── Multi-step path (streamText + tool loop) ──────────────────────────

async function runMultiStepAgent(
  opts: RunAgentOptions,
  thinkingLevel: import('../../../src/types/index.js').ThinkingLevel,
  start: number,
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

  // Build a child ToolContext for the sub-agent's toolset.
  const childCtx: ToolContext = {
    ...ctx,
    _depth: (depth ?? 0) + 1,
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

  const tools = buildToolsetSubset(childCtx, agent.allowedTools!);

  const modelEntry = provider.models.find((m) => m.modelId === modelId);
  const knownMaxOutput = resolveMaxOutputTokens(modelId, modelEntry);
  const contracts = resolveReasoningContracts(modelId, modelEntry);
  const reasoning: ReasoningInstruction | null = resolveReasoning(
    thinkingLevel, contracts, provider.apiStyle, knownMaxOutput,
  );
  const proto = resolveProtocolOptions(
    provider.apiStyle,
    reasoning,
    { hasTools: true, modelId, maxOutputTokens: knownMaxOutput },
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

  log.info('multi-step agent', { name: agent.name, depth: depth ?? 0, tools: agent.allowedTools, maxSteps });

  try {
    const model = resolveModel(provider, { modelId, contextWindow: 0 } as any);
    const result = streamText({
      model,
      system: agent.systemPrompt,
      messages: [{ role: 'user' as const, content: task }],
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
      // Strip XML artifacts that GLM/Gemini leak into JSON tool args.
      repairToolCall: async ({ toolCall }) => {
        const input = toolCall.input;
        if (typeof input !== 'string') return toolCall;
        const cleaned = input
          .replace(/<\/?tool_call>/g, '')
          .replace(/<\/?tool_use>/g, '')
          .replace(/<\/?function_call>/g, '')
          .trim();
        try {
          JSON.parse(cleaned);
          return { ...toolCall, input: cleaned };
        } catch {
          const match = cleaned.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              JSON.parse(match[0]);
              return { ...toolCall, input: match[0] };
            } catch { /* give up */ }
          }
        }
        return null;
      },

      onError: ({ error }) => {
        log.warn('sub-agent stream error', { agent: agent.name, error: error?.message ?? String(error) });
      },
    });

    // Iterate the stream to surface the sub-agent's tool calls as nested
    // AgentEvents (mirrors orchestrator-sdk.ts:1104). Each tool lifecycle
    // part is forwarded via ctx.emitToolEvent with parentToolCallId so the
    // renderer streams them live under the dispatch_agent block. Falls back
    // to bare await when emitToolEvent is unavailable (legacy ctx) so the
    // sub-agent still completes — just without visible child tool calls.
    let finalResult: Awaited<typeof result>;
    if (ctx.emitToolEvent && parentToolCallId) {
      try {
        for await (const part of result.stream) {
          translateSubagentPart(part, ctx.emitToolEvent, parentToolCallId);
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
      // The steps array carries the full conversation (task + tool results);
      // we reuse it as context and instruct the model to write its report.
      const synthesized = await synthesizeReport({
        agent, steps, provider, modelId, signal, proto, onUsage,
      });
      if (synthesized) {
        log.info('multi-step agent synthesized report', { name: agent.name, steps: stepCount, durationMs: Date.now() - start });
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
          },
        };
      }
      return {
        status: 'failed',
        output: `Agent ${agent.name} returned no content (finishReason=${finishReason}, steps=${stepCount}).`,
        durationMs: Date.now() - start,
        meta: `${agent.name} · ${proto.label} · ${stepCount} steps`,
      };
    }

    log.info('multi-step agent done', { name: agent.name, steps: stepCount, durationMs: Date.now() - start });

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
      },
    };
  } catch (e: any) {
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
  steps: ReadonlyArray<{ messages?: ModelMessage[] }>;
  provider: Provider;
  modelId: string;
  signal: AbortSignal;
  proto: { providerOptions: unknown; maxOutputTokens: number | undefined; label: string };
  onUsage?: (u: Usage) => void;
}): Promise<string | null> {
  try {
    const allMessages: ModelMessage[] = [];
    for (const step of opts.steps) {
      if (step?.messages && Array.isArray(step.messages)) {
        allMessages.push(...step.messages);
      }
    }
    if (allMessages.length === 0) return null;

    allMessages.push({
      role: 'user',
      content: 'Based on your investigation above, write your final report now. Do not call any more tools. Summarize what you found and provide your conclusion.',
    } as ModelMessage);

    const model = resolveModel(opts.provider, { modelId: opts.modelId, contextWindow: 0 } as any);
    const result = await generateText({
      model,
      system: opts.agent.systemPrompt,
      messages: allMessages,
      providerOptions: opts.proto.providerOptions as any,
      maxOutputTokens: opts.proto.maxOutputTokens,
      abortSignal: opts.signal,
    });

    if (result.usage && opts.onUsage) {
      opts.onUsage(mapUsage(result.usage as LanguageModelUsage));
    }

    return ((result.text as string | null | undefined) ?? '').trim() || null;
  } catch (e: any) {
    log.warn('synthesizeReport failed', { agent: opts.agent.name, err: e?.message ?? String(e) });
    return null;
  }
}

// ─── Sub-agent stream → nested tool events ──────────────────────────────

/** Translate an AI SDK stream part from a sub-agent's tool loop into a nested
 *  AgentEvent forwarded via ctx.emitToolEvent. Mirrors the orchestrator's
 *  translatePart (orchestrator-sdk.ts:1124) but tags every event with
 *  parentToolCallId so the renderer nests the tool block under the
 *  dispatch_agent row. Only tool lifecycle parts are forwarded — text and
 *  reasoning stay in the sub-agent's own context (the report carries them). */
function translateSubagentPart(
  part: Readonly<{ type: string }>,
  emit: EmitToolEvent,
  parentToolCallId: string,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = part as any;
  switch (part.type) {
    case 'tool-input-start': {
      const toolCallId: string = p.id;
      const toolName = resolveToolName(p.toolName ?? 'unknown') as ToolName;
      emit({
        type: 'tool_call_start',
        parentToolCallId,
        toolCallId,
        toolName,
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
      // text-delta, reasoning-delta, finish-step, etc. stay in the sub-agent's
      // own context — only tool lifecycle is surfaced to the parent UI.
      return;
  }
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
