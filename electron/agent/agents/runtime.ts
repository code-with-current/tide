/**
 * Sub-agent runtime — supports both single-shot and multi-step agents.
 *
 *   - **Single-shot** (no `allowedTools`): one `generateText` call, no tools.
 *     Used for analysis, planning, research, design.
 *
 *   - **Multi-step** (has `allowedTools`): `streamText` with a tool loop
 *     (`stopWhen`), `repairToolCall`, and a subset of tools. Can read files,
 *     search code, and dispatch its own sub-agents (recursive, depth-guarded).
 *
 * Both paths inherit the parent turn's provider/model/protocol, fold usage
 * into the parent, and return a `ToolResult` for the dispatch_agent tool.
 *
 * Routed through the SDK's `generateText`/`streamText` + `resolveModel`, so
 * the sub-agent hits the correct endpoint per the parent provider's protocol.
 */
import { generateText, streamText, isStepCount } from 'ai';
import type { LanguageModelUsage } from 'ai';
import { resolveModel } from '../provider-factory.js';
import { resolveProtocolOptions } from '../protocols/index.js';
import { resolveMaxOutputTokens } from '../model-capabilities.js';
import { buildToolsetSubset } from '../tools/registry.js';
import { createLogger } from '../../logger.js';
import type { Provider, Usage, AutonomyMode } from '../../../src/types/index.js';
import type { CompactionSettings } from '../../../src/types/compaction.js';
import type { RuleSet } from '../permissions/rules.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolContext } from '../tools/tool-context.js';
import type { AgentDef } from './types.js';

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
}

/** Default thinking budget for sub-agents. Sub-agents are focused
 *  specialists — they don't need deep reasoning, they need speed.
 *  Individual agents can override via AgentDef.thinkingBudget. */
const DEFAULT_THINKING_BUDGET = 1024;

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

/**
 * Run a sub-agent. Returns a ToolResult suitable for direct return from
 * the dispatch_agent tool executor.
 *
 * If the agent has `allowedTools`, runs a multi-step streamText loop with
 * the subset of tools. Otherwise, runs a single-shot generateText call.
 */
export async function runAgent(opts: RunAgentOptions): Promise<ToolResult> {
  const { agent, task, provider, modelId, signal, onUsage, ctx, depth = 0 } = opts;
  const start = Date.now();
  const thinkingBudget = agent.thinkingBudget ?? DEFAULT_THINKING_BUDGET;

  if (!provider.apiKey) {
    return {
      status: 'failed',
      output: `Agent ${agent.name} cannot run: parent provider has no API key.`,
      durationMs: 0,
    };
  }

  // Multi-step agent: has tools + ctx.
  if (agent.allowedTools?.length && ctx) {
    return runMultiStepAgent(opts, thinkingBudget, start);
  }

  // Single-shot agent: no tools (legacy path).
  return runSingleShotAgent(opts, thinkingBudget, start);
}

// ─── Single-shot path (unchanged from before) ──────────────────────────

async function runSingleShotAgent(
  opts: RunAgentOptions,
  thinkingBudget: number,
  start: number,
): Promise<ToolResult> {
  const { agent, task, provider, modelId, signal, onUsage } = opts;

  const proto = resolveProtocolOptions(
    provider.apiStyle,
    { budgetTokens: thinkingBudget },
    { hasTools: false, modelId, maxOutputTokens: resolveMaxOutputTokens(modelId) },
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

    return buildResult(agent, task, result.text, result.finishReason, result.reasoning, start, proto.label);
  } catch (e: any) {
    return handleError(agent.name, e, signal, start);
  }
}

// ─── Multi-step path (streamText + tool loop) ──────────────────────────

async function runMultiStepAgent(
  opts: RunAgentOptions,
  thinkingBudget: number,
  start: number,
): Promise<ToolResult> {
  const { agent, task, provider, modelId, signal, onUsage, ctx, depth } = opts;

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

  // Build a child ToolContext for the sub-agent's toolset.
  const childCtx: ToolContext = {
    ...ctx,
    _depth: (depth ?? 0) + 1,
    // Sub-agent usage folds into the parent's onUsage.
    onUsage: (u: Usage) => {
      onUsage?.(u);
    },
    // Sub-agent emit is a no-op — tool call cards don't surface in the main UI.
    // The report is returned as the dispatch_agent tool result instead.
    emit: () => {},
  };

  const tools = buildToolsetSubset(childCtx, agent.allowedTools!);

  const proto = resolveProtocolOptions(
    provider.apiStyle,
    { budgetTokens: thinkingBudget },
    { hasTools: true, modelId, maxOutputTokens: resolveMaxOutputTokens(modelId) },
  );

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

    // Consume the stream to completion.
    const finalResult = await result;

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
        task,
        report,
        reasoning,
      },
    };
  } catch (e: any) {
    return handleError(agent.name, e, signal, start);
  }
}

// ─── Shared helpers ────────────────────────────────────────────────────

function buildResult(
  agent: AgentDef,
  task: string,
  text: string | null | undefined,
  finishReason: string | undefined,
  reasoning: unknown,
  start: number,
  label: string,
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
