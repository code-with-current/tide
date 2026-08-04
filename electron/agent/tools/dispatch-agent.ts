/**
 * dispatch_agent tool — spawn a specialized sub-agent.
 *
 * The main model calls this to delegate a focused subtask to one of the 8
 * embedded specialists. The agent makes a single LLM call with its own system
 * prompt + the caller's task and returns its answer as the tool result. The
 * main loop keeps doing actual file operations.
 *
 * Auto-deploy: the system prompt advertises the catalog and the model emits
 * this call when it judges a specialist is needed. No manual invocation
 * required (though `@mentions` also work for explicit dispatch).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { app } from 'electron';
import { agentNames, getAgent } from '../agents/registry';
import { runAgent } from '../agents/runtime';
import { createExtensionsStore } from '../../extensionsStore';
import type { Provider, Usage } from '../../../src/types/index';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';
import { appDataDir } from '../../appPaths.js';

/** Shared body — needs the parent turn's provider/model + signal + usage hook
 *  so the sub-agent runs against the same LLM and folds its cost in.
 *
 *  provider/onUsage are optional because the LEGACY ToolContext (./types)
 *  carries them as optional; the body guards `!ctx.provider` before use, so
 *  by the time runAgent sees them they're defined. The SDK ToolContext
 *  (./tool-context) always provides them. */
export async function runDispatchAgent(
  name: string,
  task: string,
  ctx: {
    provider?: Provider;
    modelId: string;
    abortSignal: AbortSignal;
    onUsage?: (u: Usage) => void;
    onDelta?: (text: string) => void;
    /** Full tool context for multi-step agents (optional — single-shot agents don't need it). */
    toolCtx?: ToolContext;
    depth?: number;
  },
): Promise<ToolResult> {
  const agent = getAgent(name);

  if (!agent) {
    return {
      status: 'failed' as const,
      output: `Unknown agent: "${name}". Available: ${agentNames().join(', ')}.`,
    };
  }
  if (!task) {
    return {
      status: 'failed' as const,
      output: `Missing "task" for agent ${name}. Provide a self-contained task description.`,
    };
  }
  if (!ctx.provider || !ctx.modelId) {
    return {
      status: 'failed' as const,
      output: `Agent dispatch unavailable: parent provider/model not on context. (This is an orchestrator bug — provider and modelId should be injected.)`,
    };
  }

  return runAgent({
    agent,
    task,
    provider: ctx.provider,
    modelId: ctx.modelId,
    signal: ctx.abortSignal,
    onUsage: ctx.onUsage,
    onDelta: ctx.onDelta,
    ctx: ctx.toolCtx,
    depth: ctx.depth,
  });
}

export const dispatchAgentTool: ToolRegistration = {
  name: 'dispatch_agent',
  definition: {
    name: 'dispatch_agent',
    description:
      'Spawn a specialized sub-agent for a focused subtask. The agent runs with its own system prompt and returns a report; it does not modify files directly. Use for research, analysis, planning, codebase mapping, or any focused specialty. For simple lookups (one file, one grep), use the direct tools — do not dispatch for trivial work. Pick the agent whose specialty best matches the job.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: agentNames(),
          description: 'The agent to dispatch.',
        },
        task: {
          type: 'string',
          description:
            'Self-contained task description. The agent sees only this string — include any context it needs (file paths, snippets, constraints). Do not assume the agent can see the prior conversation.',
        },
      },
      required: ['name', 'task'],
    },
  },
  // Single-shot LLM call — no file mutations. The agent only reads + writes
  // text in its own turn. Risk is bounded to token cost.
  riskTier: 'read_only',
  requiresWorktree: false,
  // Agents do real reasoning work; allow up to 2 minutes.
  timeoutMs: 120_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) =>
    runDispatchAgent(String(args.name ?? ''), String(args.task ?? '').trim(), {
      provider: ctx.provider,
      modelId: ctx.modelId ?? '',
      abortSignal: ctx.signal,
      onUsage: ctx.onUsage,
      // Legacy ctx carries onDelta directly — forward it.
      onDelta: ctx.onDelta,
    }),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────
// Wires the SDK ToolContext into runAgent. The SDK ctx uses `abortSignal`
// (not `signal`) and has no `onDelta`; live sub-agent streaming into the
// dispatch card is deferred until a PartEvent shape exists for it (the
// sub-agent still completes and returns its full report without it).

export function createDispatchAgentTool(ctx: ToolContext) {
  // Read disabled agents from the extensions store (best-effort). Agents
  // disabled via Settings → Extensions → Agents are removed from the enum
  // so the model can't dispatch them.
  let disabledAgents: string[] = [];
  try {
    const extStore = createExtensionsStore(appDataDir());
    disabledAgents = extStore.getDisabled().agents;
  } catch { /* config unreadable — all agents available */ }

  const availableNames = (disabledAgents.length > 0
    ? agentNames().filter((n) => !disabledAgents.includes(n))
    : agentNames()) as [string, ...string[]];

  return tool({
    description:
      'Spawn a specialized sub-agent for a focused subtask. The agent runs with its own system prompt and returns a report; it does not modify files directly. Use for research, analysis, planning, codebase mapping, or any focused specialty. For simple lookups (one file, one grep), use the direct tools — do not dispatch for trivial work. Pick the agent whose specialty best matches the job.',
    inputSchema: z.object({
      name: z.enum(availableNames).describe('The agent to dispatch.'),
      task: z.string().describe(
        'Self-contained task description. The agent sees only this string — include any context it needs (file paths, snippets, constraints). Do not assume the agent can see the prior conversation.',
      ),
    }),
    execute: async ({ name, task }) =>
      withPermission(ctx, 'dispatch_agent', { name, task }, () =>
        runDispatchAgent(name, task.trim(), {
          provider: ctx.provider,
          modelId: ctx.modelId,
          abortSignal: ctx.abortSignal,
          onUsage: ctx.onUsage,
          // Pass the full context for multi-step agents + recursion depth.
          toolCtx: ctx,
          depth: ctx._depth ?? 0,
        }),
      ),
  });
}
