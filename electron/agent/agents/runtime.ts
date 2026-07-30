/**
 * Single-shot sub-agent runtime.
 *
 * Runs exactly one LLM call with the agent's system prompt + the caller's
 * task, folds usage into the parent turn, and returns the agent's final text
 * as the tool result. No tools, no iteration loop, no recursion.
 *
 * Sub-agents are advisory analysts/planners/researchers — the main
 * orchestrator keeps doing the actual file operations.
 *
 * Routed through the SDK's `generateText` + `resolveModel`, so the sub-agent
 * hits the correct endpoint per the parent provider's protocol (Anthropic
 * /v1/messages OR OpenAI /chat/completions). An earlier version called the
 * legacy `streamAnthropicOnce`, which hard-coded `/v1/messages` and 404'd on
 * OpenAI-protocol providers (z.ai coding endpoint). Thinking is expressed via
 * the same per-protocol resolver as the main loop.
 */
import { generateText } from 'ai';
import type { LanguageModelUsage } from 'ai';
import { resolveModel } from '../provider-factory.js';
import { resolveProtocolOptions } from '../protocols/index.js';
import { resolveMaxOutputTokens } from '../model-capabilities.js';
import type { Provider, Usage } from '../../../src/types/index.js';
import type { ToolResult } from '../tools/types.js';
import type { AgentDef } from './types.js';

export interface RunAgentOptions {
  /** The agent definition (name + system prompt). */
  agent: AgentDef;
  /** The self-contained task from the dispatch_agent tool call. */
  task: string;
  /** Parent turn's provider — sub-agents inherit it (and thus the protocol). */
  provider: Provider;
  /** Parent turn's model id — sub-agents inherit it. */
  modelId: string;
  /** Parent turn's abort signal — sub-agents die with the parent. */
  signal: AbortSignal;
  /** Optional accumulator — folds this call's usage into the parent turn
   *  so the context-window meter reflects sub-agent token cost. */
  onUsage?: (u: Usage) => void;
  /** Kept for signature compatibility with the legacy streaming runtime.
   *  generateText is one-shot, so live deltas are no longer surfaced into
   *  the dispatch card — the full report arrives when the call completes. */
  onDelta?: (text: string) => void;
}

/** Sub-agents get a modest fixed thinking budget (design §Sub-agents). Enough
 *  to reason about the task without the latency of the parent's max tier. */
const SUB_AGENT_THINKING_BUDGET = 4096;

function mapUsage(u: LanguageModelUsage): Usage {
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheRead: u.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0,
    calls: 1,
    costUsd: 0,
  };
}

/**
 * Run a sub-agent. Returns a ToolResult suitable for direct return from
 * the dispatch_agent tool executor.
 */
export async function runAgent(opts: RunAgentOptions): Promise<ToolResult> {
  const { agent, task, provider, modelId, signal, onUsage, onDelta } = opts;
  void onDelta; // one-shot generateText — no streaming deltas
  const start = Date.now();

  if (!provider.apiKey) {
    return {
      status: 'failed',
      output: `Agent ${agent.name} cannot run: parent provider has no API key.`,
      durationMs: 0,
    };
  }

  // Protocol-aware thinking/options (Anthropic thinking block vs OpenAI
  // reasoning_effort) — same resolver the main loop uses. Sub-agents inherit
  // the parent's modelId so the catalog-resolved output cap applies.
  const proto = resolveProtocolOptions(
    provider.apiStyle,
    { budgetTokens: SUB_AGENT_THINKING_BUDGET },
    { hasTools: false, modelId, maxOutputTokens: resolveMaxOutputTokens(modelId) },
  );

  try {
    const model = resolveModel(provider, { modelId, contextWindow: 0 } as any);
    const result = await generateText({
      model,
      system: agent.systemPrompt,
      // Single user turn — the task is the entire conversation.
      prompt: task,
      // No tools for sub-agents. They analyze and report; the main loop acts.
      providerOptions: proto.providerOptions,
      maxOutputTokens: proto.maxOutputTokens,
      abortSignal: signal,
    });

    if (result.usage && onUsage) {
      onUsage(mapUsage(result.usage as LanguageModelUsage));
    }

    const trimmed = (result.text ?? '').trim();
    if (!trimmed) {
      return {
        status: 'failed',
        output: `Agent ${agent.name} returned no content (finishReason=${result.finishReason}).`,
        durationMs: Date.now() - start,
        meta: `via ${proto.label}`,
      };
    }

    const reasoningText =
      typeof (result as { reasoning?: unknown }).reasoning === 'string'
        ? ((result as { reasoning?: string }).reasoning as string).trim() || undefined
        : undefined;

    return {
      status: 'executed',
      output: trimmed,
      durationMs: Date.now() - start,
      meta: `${agent.name} · ${proto.label}`,
      // Rich UI payload: the task, the full report, the reasoning chain, and
      // usage. ToolCallCard renders this as an expandable agent card.
      display: {
        kind: 'agent',
        agentName: agent.name,
        task,
        report: trimmed,
        reasoning: reasoningText,
      },
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || signal.aborted;
    return {
      status: aborted ? 'aborted' : 'failed',
      output: aborted
        ? `Agent ${agent.name} aborted.`
        : `Agent ${agent.name} failed: ${e?.message || String(e)}`,
      durationMs: Date.now() - start,
    };
  }
}
