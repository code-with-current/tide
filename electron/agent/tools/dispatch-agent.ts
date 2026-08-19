/** dispatch_agent tool: spawn a specialized sub-agent for a focused subtask — the agent makes its own LLM call (system prompt + caller's task) and returns the report as the tool result. Auto-deployed when the model judges a specialist is needed (or via @mentions). */

import { tool } from 'ai';
import { z } from 'zod';
import { app } from 'electron';
import type { ModelMessage } from 'ai';
import { agentNames, getAgent, agentRiskTier, canDispatchTo } from '../agents/registry';
import { runAgent } from '../agents/runtime';
import { createExtensionsStore } from '../../extensionsStore';
import { evaluateRules, getSessionRules, loadPermissionRules, type RuleSet } from '../permissions/rules';
import { createLogger } from '../../logger.js';
import { getSessionStore } from '../../ipc/sessions.js';
import type { Provider, Usage, AutonomyMode } from '../../../src/types/index';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';
import { storePendingAsk, waitForPermissionResolve } from '../permission-resolver';
import { currentToolCallId } from './tool-call-context';
import { sessionSignal } from '../session-abort.js';
import { getAgentSettings } from '../../store.js';
import { appDataDir } from '../../appPaths.js';

const log = createLogger('agent/dispatch');

const BACKGROUND_STARTED = [
  'The task is working in the background. You will be notified automatically when it finishes.',
  'DO NOT sleep, poll for progress, ask the task for status, or duplicate this task\'s work — avoid working with the same files or topics it is using.',
  'Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.',
].join('\n');

function mayDispatch(ctx: ToolContext, target: string): boolean {
  return ctx._agentDef ? canDispatchTo(ctx._agentDef, target) : true;
}

/** Shared body — runs the sub-agent against the parent turn's LLM and folds its cost in. provider/onUsage are optional (legacy ./types ToolContext); the body guards `!ctx.provider` before use so runAgent always sees them defined. The SDK ToolContext (./tool-context) always provides them. */
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
    /** The parent turn's thinking level — inherited by the sub-agent. */
    thinkingLevel?: import('../../../src/types/index.js').ThinkingLevel;
    /** The dispatch_agent's toolCallId — used as parentToolCallId so the
     *  sub-agent's tool calls nest under this block in the renderer. */
    parentToolCallId?: string;
    /** Short human-readable label shown on the dispatch row so parallel
     *  dispatches of the same agent type are distinguishable. */
    title?: string;
    /** Dispatch id to resume — must be a subagent child of this session. */
    resumeFrom?: string;
    /** Fired when the child session id is known, before the run completes —
     *  lets background callers correlate failed runs with their row. */
    onDispatchId?: (id: string) => void;
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

  const resumeFrom = ctx.resumeFrom;
  let resume: { sessionId: string; messages: ModelMessage[] } | undefined;
  if (resumeFrom) {
    if (!ctx.toolCtx) {
      return { status: 'failed' as const, output: 'resumeFrom requires a full tool context.' };
    }
    let child: ReturnType<ReturnType<typeof getSessionStore>['getSession']> | undefined;
    try {
      child = getSessionStore().getSession(resumeFrom);
    } catch { /* store unavailable */ }
    if (!child || child.kind !== 'subagent' || child.parentId !== ctx.toolCtx.sessionId) {
      return {
        status: 'failed' as const,
        output: `resumeFrom "${resumeFrom}" is not a dispatch of this session. Dispatch ids come from prior dispatch_agent results in this same session.`,
      };
    }
    resume = { sessionId: resumeFrom, messages: (child.modelMessages ?? []) as ModelMessage[] };
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
    thinkingLevel: ctx.thinkingLevel,
    parentToolCallId: ctx.parentToolCallId,
    title: ctx.title,
    resume,
    onDispatchId: ctx.onDispatchId,
  });
}

export const dispatchAgentTool: ToolRegistration = {
  name: 'dispatch_agent',
  definition: {
    name: 'dispatch_agent',
    description:
      'Spawn a specialized sub-agent for a focused subtask — the agent runs its own multi-step tool loop and returns a report. Dispatch PROACTIVELY when a specialty fits: code-reviewer to review a diff, simplifier for a cleanup pass, explore to locate code, general-purpose for broad research. Dispatch multiple agents in one response to run them in parallel. For simple lookups (one file, one grep) use the direct tools instead. ' +
      'The result includes a dispatchId; pass it as resumeFrom to continue that sub-agent with a follow-up task (it keeps its prior context — keep follow-up instructions brief; brief is intentional, not ambiguous). Every dispatch without resumeFrom starts completely fresh.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: agentNames(),
          description: 'The agent to dispatch.',
        },
        title: {
          type: 'string',
          description:
            'Short human-readable label for this dispatch (3-6 words). Shown in the UI so parallel dispatches are distinguishable.',
        },
        task: {
          type: 'string',
          description:
            'Self-contained task description. The agent sees only this string — include any context it needs (file paths, snippets, constraints). Do not assume the agent can see the prior conversation.',
        },
        resumeFrom: {
          type: 'string',
          description:
            'Dispatch id from a previous dispatch_agent result (the dispatchId field in its output metadata). Continues that same sub-agent with its prior context instead of starting fresh. Only use it to follow up on an earlier dispatch in this same session.',
        },
        background: {
          type: 'boolean',
          description:
            'Run the sub-agent in the background and continue your turn. You will be notified when it completes. DO NOT sleep, poll, or check its progress — work on non-overlapping tasks or end your response.',
        },
      },
      required: ['name', 'title', 'task'],
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
// Wires the SDK ToolContext into runAgent. SDK ctx uses `abortSignal` (not `signal`) and has no `onDelta`; live sub-agent streaming into the dispatch card is deferred until a PartEvent shape exists (the sub-agent still completes and returns its full report).

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
      'Spawn a specialized sub-agent for a focused subtask — the agent runs its own multi-step tool loop and returns a report. Dispatch PROACTIVELY when a specialty fits: code-reviewer to review a diff, simplifier for a cleanup pass, explore to locate code, general-purpose for broad research. Dispatch multiple agents in one response to run them in parallel. For simple lookups (one file, one grep) use the direct tools instead. ' +
      'You may dispatch MULTIPLE agents in a single response — they run in parallel. Give each a short `title` so the user can tell them apart. ' +
      'The result includes a dispatchId; pass it as resumeFrom to continue that sub-agent with a follow-up task (it keeps its prior context — keep follow-up instructions brief; brief is intentional, not ambiguous). Every dispatch without resumeFrom starts completely fresh.',
    inputSchema: z.object({
      name: z.enum(availableNames).describe('The agent to dispatch.'),
      title: z.string().describe(
        'Short human-readable label for this dispatch (3-6 words). Shown in the UI row so parallel dispatches are distinguishable. Example: "Map auth flow", "Find all SQL sinks".',
      ),
      task: z.string().describe(
        'Self-contained task description. The agent sees only this string — include any context it needs (file paths, snippets, constraints). Do not assume the agent can see the prior conversation.',
      ),
      resumeFrom: z.string().optional().describe(
        'Dispatch id from a previous dispatch_agent result (the dispatchId field in its output metadata). Continues that same sub-agent with its prior context instead of starting fresh. Only use it to follow up on an earlier dispatch in this same session.',
      ),
      background: z.boolean().optional().describe(
        'Run the sub-agent in the background and continue your turn. You will be notified when it completes. DO NOT sleep, poll, or check its progress — work on non-overlapping tasks or end your response.',
      ),
    }),
    execute: async ({ name, title, task, resumeFrom, background }) => {
      const agent = getAgent(name);

      // Rule gate runs before the plan-mode card so a deny rule rejects
      // outright — the user must never escalate autonomy only to then be
      // told a rule forbids the dispatch (mirrors withPermission's ordering).
      const fileRules = loadPermissionRules(ctx.workspaceRoot);
      const sessionRls = getSessionRules(ctx.sessionId);
      const mergedRules: RuleSet = {
        allow: [...sessionRls.allow, ...fileRules.allow],
        deny: [...sessionRls.deny, ...fileRules.deny],
      };
      if (evaluateRules(mergedRules, 'dispatch_agent', { name, title, task }) === 'deny') {
        log.warn('dispatch denied by rule', { target: name, mode: ctx.autonomyMode });
        return { status: 'rejected' as const, output: 'Denied by permission rule (.agent/settings.json or session).' };
      }

      if (agent && (ctx._depth ?? 0) > 0 && !mayDispatch(ctx, name)) {
        return { status: 'rejected' as const, output: `This agent cannot dispatch "${name}".` };
      }

      // dispatch_agent itself is read_only-tiered, but the target's toolset
      // may not be — the plan-mode gate keys off the target's effective risk.
      if (agent && ctx.autonomyMode === 'plan' && agentRiskTier(agent) !== 'read_only') {
        const toolCallId = currentToolCallId() ?? `perm_dispatch_${Date.now().toString(36)}`;
        storePendingAsk(ctx.sessionId, toolCallId, 'dispatch_agent', { name, title, task }, ctx.workspaceRoot);
        log.info('asking user', { tool: 'dispatch_agent', target: name, mode: ctx.autonomyMode, tier: agentRiskTier(agent), toolCallId });
        ctx.emit({
          type: 'permission',
          toolCallId,
          toolName: 'dispatch_agent',
          args: { name, title, task },
          decision: 'blocked',
        });
        const verdict = await waitForPermissionResolve(ctx.sessionId, toolCallId);
        if (verdict.newMode) {
          const from = ctx.autonomyMode;
          (ctx.autonomyMode as AutonomyMode) = verdict.newMode;
          log.warn('escalated', { tool: 'dispatch_agent', from, to: verdict.newMode });
        }
        if (!verdict.approved) {
          log.info('dispatch denied by user', { target: name, reason: verdict.reason });
          return {
            status: 'rejected' as const,
            output: verdict.reason
              ? `User denied dispatching ${name}: ${verdict.reason}`
              : `User denied dispatching ${name} (plan mode).`,
          };
        }
        log.info('dispatch approved by user', { target: name });
      }

      // Background path (experimental flag): detach the sub-agent from the
      // turn's lifecycle — it rides the SESSION's abort signal (survives turn
      // end, dies on session delete/quit) and its report is injected back as
      // a synthetic queued message when it completes. Flag off + background
      // requested simply falls through to the normal foreground dispatch.
      let backgroundOn = false;
      try {
        backgroundOn = getAgentSettings().experimentalBackgroundDispatch === true;
      } catch { /* config unreadable — background disabled */ }
      if (backgroundOn && background === true) {
        const signal = sessionSignal(ctx.sessionId);
        // Rebind the tool context onto the session signal too — a shallow
        // copy, so the sub-agent's TOOLS (not just its LLM calls) outlive the
        // dispatching turn's controller. Mirrors the childCtx copy the
        // runtime makes for nested dispatches.
        const bgCtx: ToolContext = { ...ctx, abortSignal: signal };
        let bgDispatchId: string | undefined;
        void runDispatchAgent(name, task.trim(), {
          provider: ctx.provider,
          modelId: ctx.modelId,
          abortSignal: signal,
          onUsage: ctx.onUsage,
          toolCtx: bgCtx,
          depth: ctx._depth ?? 0,
          thinkingLevel: ctx.thinkingLevel,
          parentToolCallId: currentToolCallId(),
          title: typeof title === 'string' ? title.trim() : undefined,
          resumeFrom,
          onDispatchId: (id) => { bgDispatchId = id; },
        }).then((result) => {
          const display = result.display;
          // Failed runs carry no display payload — the id captured by
          // onDispatchId is the only way to correlate them with the row.
          const dispatchId = (display && display.kind === 'agent' ? display.dispatchId : undefined) ?? bgDispatchId;
          // Aborts/interrupts inject nothing (opencode parity) — only
          // completions and genuine errors report back to the parent.
          if (!dispatchId || (result.status !== 'executed' && result.status !== 'failed')) return;
          ctx.emit({
            type: 'dispatch_result',
            sessionId: ctx.sessionId,
            dispatchId,
            title: typeof title === 'string' ? title.trim() : undefined,
            state: result.status === 'executed' ? 'completed' : 'error',
            report: result.output,
          });
        }).catch(() => { /* aborts/errors already surfaced via the turn */ });
        return {
          status: 'executed' as const,
          output: BACKGROUND_STARTED,
          display: { kind: 'agent', agentName: name, title, task, report: '', background: true },
        };
      }

      return withPermission(ctx, 'dispatch_agent', { name, title, task }, () =>
        runDispatchAgent(name, task.trim(), {
          provider: ctx.provider,
          modelId: ctx.modelId,
          abortSignal: ctx.abortSignal,
          onUsage: ctx.onUsage,
          // Pass the full context for multi-step agents + recursion depth.
          toolCtx: ctx,
          depth: ctx._depth ?? 0,
          thinkingLevel: ctx.thinkingLevel,
          // Capture this dispatch_agent's toolCallId so the sub-agent's
          // internal tool calls can be nested under this block. Read from
          // AsyncLocalStorage (set by buildToolset's execute wrapper).
          parentToolCallId: currentToolCallId(),
          // Carry the title through to the display payload so the renderer
          // can show it on the row (distinguishes parallel dispatches).
          title: typeof title === 'string' ? title.trim() : undefined,
          resumeFrom,
        }),
      );
    },
  });
}
