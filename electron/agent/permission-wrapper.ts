/**
 * withPermission — wraps a tool's execute body with the autonomy gate.
 *
 * Called from INSIDE each tool's SDK execute (see bash.ts pattern):
 *
 *   execute: async (args) =>
 *     withPermission(ctx, 'bash', args, () => runBash(...)),
 *
 * The decision matrix is `checkPermission(riskTier, autonomyMode)` from
 * permission.ts. On 'auto', the body runs immediately. On 'ask' or
 * 'blocked', the wrapper emits a permission request to the renderer,
 * awaits the user's verdict via the per-session resolver, and either
 * runs the body or returns a rejection.
 *
 * Plan-mode escalation: if the user picks "switch to edit mode" when
 * approving, the wrapper mutates ctx.autonomyMode. Subsequent tools in
 * the same turn then auto-approve — matches the existing orchestrator's
 * behavior. ctx is shared across all tools in a turn (closure-captured
 * by buildToolset), so this mutation propagates.
 */

import { checkPermission } from './permission.js';
import { getToolMeta } from './tools/tool-meta.js';
import { waitForPermissionResolve, storePendingAsk } from './permission-resolver.js';
import { evaluateRules, getSessionRules, loadPermissionRules } from './permissions/rules.js';
import { currentToolCallId } from './tools/tool-call-context.js';
import { createLogger } from '../logger.js';
import type { ToolContext } from './tools/tool-context.js';
import type { AutonomyMode, ToolName } from '../../src/types';

const log = createLogger('permission');

export type PermissionResult<T> =
  | T
  | { status: 'rejected'; output: string };

export async function withPermission<T>(
  ctx: ToolContext,
  toolName: ToolName,
  args: unknown,
  run: () => Promise<T>,
): Promise<PermissionResult<T>> {
  const meta = getToolMeta(toolName);
  const argsObj = (args ?? {}) as Record<string, unknown>;

  // Rule-based gate (`.agent/settings.json` + session rules). Deny always wins;
  // allow only upgrades an 'ask' to auto (does NOT bypass plan-mode 'blocked').
  // Re-read project/user rules fresh here — ctx.permissionRules is a snapshot
  // frozen at turn start, so a rule written mid-turn (e.g. "always allow ·
  // project" on THIS card) would be invisible until the next turn. The gated
  // path is the one that prompts, so the re-read cost is not on the hot path.
  const freshProjectRules = loadPermissionRules(ctx.workspaceRoot);
  const ruleDecision = evaluateRules(getSessionRules(ctx.sessionId), freshProjectRules, toolName, argsObj);
  if (ruleDecision === 'deny') {
    log.warn('denied by rule', { tool: toolName, mode: ctx.autonomyMode });
    return { status: 'rejected', output: 'Denied by permission rule (.agent/settings.json or session).' };
  }

  const decision = checkPermission(meta.riskTier, ctx.autonomyMode);

  if (decision === 'auto') {
    log.debug('auto-approved', { tool: toolName, mode: ctx.autonomyMode });
    return run();
  }
  // An allow rule turns an 'ask' into an auto-run. It does NOT touch 'blocked'
  // (plan mode) — that still surfaces the blocked card for explicit escalation.
  if (decision === 'ask' && ruleDecision === 'allow') {
    log.debug('auto-approved by rule', { tool: toolName, mode: ctx.autonomyMode });
    return run();
  }

  // Real toolCallId (threaded via AsyncLocalStorage in buildToolset) so the
  // card is keyed per-call and can render inline on its tool block. Falls back
  // to a synthesized id only if the context isn't set (defensive — shouldn't
  // happen for SDK-dispatched tools). No serialization: parallel asks in the
  // same step each await their own verdict independently.
  const toolCallId = currentToolCallId() ?? `perm_${toolName}_${Date.now().toString(36)}`;
  // Remember the ask so the approve handler can derive an "always allow" rule
  // when the user picks "Always allow — session/project" on the card.
  storePendingAsk(ctx.sessionId, toolCallId, toolName, argsObj, ctx.workspaceRoot);
  log.info('asking user', { tool: toolName, mode: ctx.autonomyMode, tier: meta.riskTier, toolCallId });
  ctx.emit({ type: 'permission', toolCallId, toolName, args, decision });
  const verdict = await waitForPermissionResolve(ctx.sessionId, toolCallId);

  // Escalation sticks for the rest of the turn.
  if (verdict.newMode) {
    (ctx.autonomyMode as AutonomyMode) = verdict.newMode;
    log.warn('escalated', { tool: toolName, from: ctx.autonomyMode, to: verdict.newMode });
  }

  if (!verdict.approved) {
    log.info('denied by user', { tool: toolName, reason: verdict.reason });
    return {
      status: 'rejected' as const,
      output: verdict.reason ? `User denied: ${verdict.reason}` : 'User denied.',
    };
  }

  log.info('approved by user', { tool: toolName });
  return run();
}
