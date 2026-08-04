/**
 * Orchestrator — SDK-driven agent loop (Phase 3 Task 3.4).
 *
 * Replaces the hand-rolled `while (iteration < MAX_ITERATIONS)` loop in
 * orchestrator.ts with a single Vercel AI SDK `streamText` call. The SDK
 * owns the model↔tool round-tripping (stopWhen step cap, tool dispatch,
 * retries); Tide owns the rendering projection and the consent layer.
 *
 * Data flow:
 *
 *   streamText stream  ──▶  part translator  ──▶  AgentEvent  (agent:event)
 *                          └▶  block bookkeeping  ──▶  Block[] on turn_end
 *
 * Per the design (§"Parts → Renderer Data Flow"), the IPC channel keeps its
 * name (`agent:event`) and Phase 4 swaps its PAYLOAD shape from the legacy
 * `AgentEvent` union to the canonical `PartEvent` union — at which point this
 * translator's legacy emissions are removed and `useParts` consumes parts
 * directly. During Phase 3 this module emits only the legacy AgentEvent
 * stream (the "temporary parts→blocks adapter"); the existing renderer works
 * unchanged. (An earlier draft emitted parts on a sibling `agent:part`
 * channel; that was a divergence from the design and has been removed.)
 *
 * Coexistence: `registerAgentSdkHandlers` registers the SAME AGENT_COMMANDS
 * as the legacy `registerAgentHandlers`. ipcMain rejects duplicate handles,
 * so only one path is active per process — main.ts swaps via the
 * `USE_SDK_ORCHESTRATOR` flag. The legacy orchestrator.ts stays as fallback.
 *
 * Transitional limitations while Phase 2/3 finish (no changes needed here
 * when they land — the architecture is already the target shape):
 *
 *   • Only 5 tools are SDK-converted (bash, read_file, list_dir, write_file,
 *     edit_file). buildToolset advertises just these. ask_followup_question,
 *     dispatch_agent, etc. are unavailable on this path until Tasks 2.3+.
 *
 *   • Permission gating (withPermission) rides through ctx.emit, but the 5
 *     converted tools don't call it in their execute bodies yet (Task 3.2).
 *     Until 3.2 lands, write/bash tools run ungated HERE — smoke-test in
 *     'full' mode or with read-only tools. The bridge below is already
 *     wired so the moment 3.2 adds `withPermission(ctx, 'bash', …)` inside
 *     each execute, every mode is safe with zero orchestrator changes.
 *
 * Plan slices (docs/plans/2026-07-22-vercel-ai-sdk-migration.md §3.4):
 *   A. streamText skeleton + part subscription
 *   B. tool dispatch via buildToolset
 *   C. usage accounting via finish-step / totalUsage
 *   D. abort handling
 *   E. step cap → forced wrap-up call
 */

import { streamText, isStepCount } from 'ai';
// v7 renamed CoreMessage → ModelMessage. (ResponseMessage — assistant + tool
// turns the SDK hands back from a completed call — is NOT re-exported by the
// public surface, so runStream returns the broader ModelMessage[] instead.)
import type { LanguageModelUsage, ModelMessage } from 'ai';
import type { WebContents } from 'electron';
import { app, BrowserWindow, Notification } from 'electron';
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
import {
  createTurnController,
  parseSkillMetadata,
  markChecklistProgress,
  looksLikePrematureStop,
  buildCorrectionMessage,
  allChecklistDone,
  checkBudgetNudge,
  type TurnController,
} from './turn-controller.js';
import {
  shouldCompact,
  compactConversation,
  estimateTokens,
  DEFAULT_AUTO_COMPACT_CONFIG,
  type AutoCompactConfig,
} from './context/auto-compact.js';
import { loadHookConfig, type HookConfig } from './hooks/hook-config.js';
import { handleStopHooks } from './hooks/stop-hooks.js';
import { supportsThinking, contextWindowSize, resolveMaxOutputTokens } from './model-capabilities.js';
import type { ToolResult } from './tools/types.js';
import {
  resolvePermission,
  abortPermission,
  clearSession,
  getPendingAsk,
} from './permission-resolver.js';
import {
  loadPermissionRules,
  addPermissionRule,
} from './permissions/rules.js';
import {
  resolveFollowup,
  abortFollowup,
  clearFollowupSession,
} from './followup-resolver.js';
import { resolveProtocolOptions } from './protocols/index.js';
import { DEFAULT_COMPACTION_SETTINGS } from '../../src/types/compaction.js';
import { AGENT_EVENT_CHANNEL, AGENT_COMMANDS } from '../../src/lib/agent/events.js';
import type {
  AgentEvent,
  RunTurnPayload,
  TurnMessage,
} from '../../src/lib/agent/events.js';
import type {
  AutonomyMode,
  Provider,
  ToolCall,
  ToolName,
  Usage,
} from '../../src/types/index.js';
import type {
  Block,
  ReasoningBlock,
  TextBlock,
  ToolBlock,
} from '../../src/types/block.js';
import { categorizeTool } from '../../src/lib/stream/blockState.js';
import type { ToolContext } from './tools/tool-context.js';
import { appDataDir } from '../appPaths.js';

// ─── Turn constants ──────────────────────────────────────────────────

const log = createLogger('agent-sdk');

/** Caps model↔tool round-trips per turn. Maps to the legacy MAX_ITERATIONS. */
const MAX_STEPS = 100; // default; overridden by agentSettings.maxSteps at turn start

/** Auto-reject window for a permission prompt. Matches the legacy gate. */
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000; // default; overridden by agentSettings.permissionTimeoutMin

/**
 * Tide thinking level → Anthropic `providerOptions.anthropic.thinking.budgetTokens`.
 * Same levels/values as the legacy orchestrator; the SDK spells the field
 * `budgetTokens` (camelCase) instead of Anthropic's native `budget_tokens`.
 *   off    → thinking disabled (no reasoning budget)
 *   low    → 1_024    (bare minimum — quick tasks)
 *   medium → 8_000    (default — most work)
 *   high   → 24_000   (deep analysis, multi-file investigations)
 *   extra  → 48_000   (hard problems, design tradeoffs)
 *   max    → 64_000   (max reasoning — leave room for the answer)
 */
const THINKING_BUDGET: Record<string, number> = {
  low: 1_024,
  medium: 8_000,
  high: 24_000,
  extra: 48_000,
  max: 64_000,
};

/**
 * Output-token escalation + resume — borrowed from Claude Code's query loop.
 *
 * The default `maxOutputTokens` (8192 answer budget, set per-protocol) is
 * enough for ~95% of turns. When a step ends with `finishReason='length'`,
 * the model was cut off mid-thought — usually because it was reasoning
 * through something complex or writing a long file. Two recovery tiers:
 *
 *   1. ESCALATE: retry the SAME request once at ESCALATED_MAX_TOKENS. This
 *      often succeeds with no follow-up turn — the model just needed more
 *      room to finish. Way cheaper than a correction turn (no extra user
 *      message, prompt cache stays warm).
 *
 *   2. RESUME: if escalation is exhausted (or already at/above the cap), inject
 *      a terse "resume" user message and re-stream. The wording is load-
 *      bearing — see RESUME_MESSAGE below. Capped at MAX_RESUME_ATTEMPTS.
 *
 * Only the length signal triggers this path. Other finish reasons (stop,
 * content-filter, tool-calls) are handled by the skill-correction loop or
 * the natural turn-end path.
 */
const ESCALATED_MAX_TOKENS = 65_535; // 2^16-1 — Gemini's hard cap; safe everywhere.
const MAX_RESUME_ATTEMPTS = 3;

/** Turn-level retry for transient provider errors (network, 5xx, empty stream).
 *  These are NOT retried by the SDK (maxRetries:0) — we handle them here so the
 *  UI can show "Retrying 1/3…" and surface a human-friendly error only after
 *  all attempts fail. Aborts and permission errors skip the retry loop. */
const TURN_MAX_RETRIES = 2; // 1 initial call + 2 retries = 3 total attempts

/**
 * The exact wording Claude Code uses to resume after a max-output-tokens hit.
 * Every clause is load-bearing:
 *   - "Resume directly" — don't restart, don't reconsider.
 *   - "no apology, no recap" — suppresses the model's reflexive "Sorry, I was
 *     just explaining…" preamble, which wastes ~50-200 tokens per occurrence.
 *   - "Pick up mid-thought" — for the common case where the cut happened
 *     inside a reasoning chain or a file write.
 *   - "Break remaining work into smaller pieces" — prevents the next step
 *     from hitting the cap again for the same reason.
 */
const RESUME_MESSAGE =
  'Output token limit hit. Resume directly — no apology, no recap of what you ' +
  'were doing. Pick up mid-thought if that is where the cut happened. Break ' +
  'remaining work into smaller pieces.';

// ─── Per-turn live state ─────────────────────────────────────────────
// The block bookkeeping mirrors the legacy ActiveTurn so the EXISTING
// renderer (which renders Block[]) keeps working. This is the "temporary
// parts→blocks adapter" from plan Slice A — removed in Phase 4 Task 4.4
// once components consume DerivedView directly.

/** Ordered timeline entry — text segment or tool-call reference. Module-scope
 *  because Rolldown dislikes inline types inside function bodies. */
type TimelineEntry =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolIndex: number };

interface SdkTurn {
  sessionId: string;
  messageId: string;
  controller: AbortController;
  /** Mutable — withPermission escalates plan→edit mid-turn and mutates this. */
  autonomyMode: AutonomyMode;
  /** Block mirror for the legacy renderer. */
  blocks: Block[];
  /** Open text block id, or null when the next delta should open a fresh one
   *  (e.g. right after a tool landed). */
  currentTextBlockId: string | null;
  /** Single stable reasoning block id for the whole turn (legacy behavior). */
  reasoningBlockId: string | null;
  toolBlockIndex: Record<string, number>;
  /** Final assembled state, for turn_end. */
  finalText: string;
  finalReasoning: string;
  toolCalls: ToolCall[];
  timeline: TimelineEntry[];
  usage: Usage;
  /** The LAST MAIN-STEP's usage only (not accumulated, not sub-agent).
   *  The context-window meter reads this to show "how full is the context
   *  right now" — the model's most recent request is what fills the window. */
  lastStepUsage: Usage | null;
  /** finish-step parts observed — detects the step-cap (Slice E). */
  stepsCompleted: number;
  /** Effective per-turn step cap (agentSettings.maxSteps || MAX_STEPS).
   *  Snapshot at turn start so module-level helpers (runStream,
   *  stopReasonFor) can read it without closing over runSdkTurn's locals. */
  maxSteps: number;
  /** Effective per-turn permission prompt timeout in ms. Same snapshot
   *  rationale as maxSteps — bridgeToolEmit reads it at emit time. */
  permissionTimeoutMs: number;
  /** True if the stream reported a terminal error part. */
  errored: string | null;
  /** Last seen finishReason (from finish-step / finish). */
  finishReason: string | null;
  /** Pending text timeline entry — null after a tool lands so the next delta
   *  opens a new segment (preserves text₁ → tool → text₂ interleaving). */
  currentTextEntry: { type: 'text'; text: string } | null;
}

const activeTurns = new Map<string, SdkTurn>();

// ─── Per-session sequence counter (mirrors legacy orchestrator) ──────
// Monotonic per session so the renderer can reorder parallel-tool events
// and detect gaps after a reload.
const seqCounters = new Map<string, number>();
function nextSeq(sessionId: string): number {
  const n = (seqCounters.get(sessionId) ?? 0) + 1;
  seqCounters.set(sessionId, n);
  return n;
}

// ─── IPC registration (drop-in swap for registerAgentHandlers) ───────

/**
 * Registers the SDK-driven agent commands on the SAME AGENT_COMMANDS the
 * legacy orchestrator uses. ipcMain rejects duplicate `handle` registrations,
 * so main.ts must call exactly one of {registerAgentHandlers,
 * registerAgentSdkHandlers}. Approval/rejection route through the
 * module-scoped permission-resolver (per-session, single-slot, serialized).
 */

// Active tool contexts by session — lets the renderer push live autonomy-mode
// changes to a running turn (e.g. the user changes the PermissionModeSelector
// dropdown while the stream is active). Registered when a turn starts,
// cleaned up when it ends.
const activeCtxs = new Map<string, ToolContext>();

export function registerAgentSdkHandlers(ipcMain: Electron.IpcMain) {
  ipcMain.handle(AGENT_COMMANDS.runTurn, async (e, payload: RunTurnPayload) => {
    const wc = e.sender;
    try {
      await runSdkTurn(wc, payload);
    } catch (err: any) {
      send(wc, payload.sessionId, {
        type: 'error',
        sessionId: payload.sessionId,
        seq: nextSeq(payload.sessionId),
        message: err?.message || 'Turn failed',
      });
    }
  });

  ipcMain.handle(AGENT_COMMANDS.abort, (_e, sessionId: string) => {
    const turn = activeTurns.get(sessionId);
    if (turn) {
      // Aborting the stream makes it emit an `abort` part and end;
      // the main loop's abort path then flushes partial state + turn_end.
      turn.controller.abort();
    }
    // Unblock any in-flight permission ask + followup pick so the turn
    // tears down cleanly instead of hanging on a resolver that will never
    // be answered.
    abortPermission(sessionId, 'aborted');
    abortFollowup(sessionId);
  });

  ipcMain.handle(
    AGENT_COMMANDS.approve,
    (
      _e,
      sessionId: string,
      toolCallIds: string[],
      newMode?: AutonomyMode,
      remember?: boolean,
    ) => {
      // "Always Allow" — derive a rule from the approved call and persist it
      // to .agent/settings.json. Takes effect immediately (in-memory) AND
      // survives across sessions (file-backed). No separate session/project
      // scope — all rules are project-level.
      if (remember && toolCallIds[0]) {
        const ask = getPendingAsk(sessionId, toolCallIds[0]);
        if (ask) {
          const spec = addPermissionRule(sessionId, ask.workspaceRoot, ask.toolName, ask.args);
          if (spec) log.info('permission rule added', { tool: ask.toolName, spec });
        }
      }
      // newMode (plan→edit escalation) sticks for the rest of the turn —
      // withPermission mutates ctx.autonomyMode from verdict.newMode. Also
      // persist it to the session record so the NEXT turn starts in the new
      // mode even if the renderer's own persist call lost the race or got
      // overwritten by session rehydration. Mirrors the legacy orchestrator
      // (orchestrator.ts); best-effort.
      if (newMode) {
        try { sessions.updateSessionSettings(sessionId, { autonomyMode: newMode }); } catch { /* best-effort persist */ }
      }
      resolvePermission(sessionId, toolCallIds, newMode ? { approved: true, newMode } : { approved: true });
    },
  );

  ipcMain.handle(
    AGENT_COMMANDS.reject,
    (_e, sessionId: string, toolCallIds: string[], reason?: string) => {
      resolvePermission(sessionId, toolCallIds, { approved: false, reason: reason || 'rejected by user' });
    },
  );

  // User picked an option (or typed a free-form answer) for a pending
  // ask_followup_question. Resolves the awaiting execute; the model then
  // continues with the pick as the tool_result.
  ipcMain.handle(
    AGENT_COMMANDS.submitFollowup,
    (_e, sessionId: string, toolCallId: string, answer: string) => {
      resolveFollowup(sessionId, toolCallId, answer);
    },
  );

  // Live autonomy-mode update — the user changed the PermissionModeSelector
  // dropdown while a turn is streaming. Mutates the active ctx so subsequent
  // tool calls in the SAME turn use the new mode (without waiting for the
  // next turn). No-op if no turn is active for this session.
  ipcMain.handle('agent:updateMode', (_e, sessionId: string, mode: AutonomyMode) => {
    const ctx = activeCtxs.get(sessionId);
    if (ctx) {
      const old = ctx.autonomyMode;
      (ctx.autonomyMode as AutonomyMode) = mode;
      log.info('autonomy mode updated mid-turn', { session: sessionId, from: old, to: mode });
    }
  });
}

function send(wc: WebContents, _sessionId: string, event: AgentEvent) {
  // _sessionId is unused: every AgentEvent already carries its own sessionId
  // field. Kept in the signature to match the legacy emit() call shape.
  if (!wc.isDestroyed()) wc.send(AGENT_EVENT_CHANNEL, event);
}

// ─── The loop ────────────────────────────────────────────────────────

/** SDK-driven turn entry point. Exported so the IPC handler (above) and the
 *  regression test can invoke it directly without going through ipcMain. */
export async function runSdkTurn(wc: WebContents, payload: RunTurnPayload) {
  const { sessionId, messages, modelId, providerId, autonomyMode, thinkingLevel } = payload;

  // ── Resolve provider + workspace root ──────────────────────────────
  // Same resolution rules as the legacy orchestrator, ported verbatim:
  // session.worktree.path wins, then the session's workspace, then default
  // workspace, then cwd. Falling back to workspaces[0] here was the
  // multi-workspace footgun the legacy loop explicitly guards against.
  const providers = store.listProviders();
  let provider = providers.find((p) => p.id === providerId);
  let providerFallback = false;
  // Graceful recovery for orphaned sessions: if the session's provider was
  // deleted (stale providerId), fall back to any enabled provider that serves
  // this modelId — matching the renderer's useModelOption resolution. This
  // unblocks the turn instead of hard-crashing; the user can re-bind the
  // session in the picker. Only fails if NO provider serves the model.
  if (!provider && modelId) {
    provider = providers.find((p) => p.enabled && p.models.some((m) => m.modelId === modelId));
    providerFallback = !!provider;
  }
  if (!provider) throw new Error(`Provider ${providerId} not found`);
  if (!provider.apiKey) throw new Error(`No API key for ${provider.name}`);
  log.info('turn', {
    session: sessionId,
    model: modelId,
    provider: provider.name,
    providerId: provider.id,
    providerFallback: providerFallback
      ? `fallback: session provider ${providerId} was stale`
      : undefined,
    apiStyle: provider.apiStyle,
  });

  const workspaces = store.listWorkspaces();
  let workspaceRoot: string | undefined;
  let workspaceId = '';
  let worktreeMeta: { branch: string; baseBranch: string } | undefined;
  /** Sticky skill carried over from a prior turn (see notes at the marker loop). */
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
    // Surface the sticky skill ref so the marker loop below can decide whether
    // to re-inject the body on this continuation turn. Without this, a multi-
    // turn skill session loses its skill context after turn 1 (the marker was
    // stripped from the persisted message; the orchestrator rebuilt the system
    // prompt from scratch with no skill body).
    priorSkillRef = session?.activeSkillRef;
  } catch {
    // Sessions module may not be loaded in some contexts — fall through.
  }
  workspaceRoot ??= workspaces.find((w) => w.isDefault)?.path ?? workspaces[0]?.path ?? process.cwd();
  // The `??=` chain's final fallback is process.cwd(), so workspaceRoot is
  // always a string here. Bind a definitively-typed const so the ToolContext
  // (which requires `string`, not `string | undefined`) typechecks cleanly —
  // `let`-declared variables keep their original union type even after `??=`.
  const root: string = workspaceRoot ?? process.cwd();

  // Liveness check: refuse to start a turn against a missing workspace root.
  // Without this, the turn proceeds and individual tools fail inconsistently
  // (write_file is guarded, but the model flails on read/bash/list failures
  // before the user understands why). Surface the problem up front with a
  // clear, actionable message. The throw propagates to the IPC handler which
  // emits it as a turn error event.
  if (!fs.existsSync(root)) {
    const where = worktreeMeta
      ? `worktree (${worktreeMeta.branch})`
      : 'workspace';
    throw new Error(
      `The ${where} folder no longer exists:\n${root}\n\nIt may have been moved or deleted. ` +
        (worktreeMeta
          ? 'Start a new session without worktree isolation, or restore the worktree.'
          : 'Re-add the workspace or restore the folder.'),
    );
  }

  // ── Build the SDK conversation (ModelMessage[]) + system prompt ─────
  // The first system message becomes the top-level `system` option; the SDK
  // (like Anthropic) takes system out-of-band rather than inline. User
  // messages with attachments expand into multi-part text content so the
  // model sees each attachment as its own block.
  let systemPrompt = '';
  const convo: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemPrompt = m.content;
      continue;
    }
    const core = toCoreMessage(m);
    if (core) convo.push(core);
  }

  // ── Per-turn state ─────────────────────────────────────────────────
  const controller = new AbortController();
  const messageId = `m_${Date.now().toString(36)}`;
  // Load agent settings early so the turn literal can snapshot them —
  // module-level helpers (runStream, stopReasonFor, bridgeToolEmit) read
  // them off `turn` instead of closing over runSdkTurn's locals.
  const agentSettings = store.getAgentSettings();
  const effectiveMaxSteps = agentSettings.maxSteps || MAX_STEPS;
  const effectivePermissionTimeout = (agentSettings.permissionTimeoutMin || 10) * 60 * 1000;
  const turn: SdkTurn = {
    sessionId,
    messageId,
    controller,
    autonomyMode,
    blocks: [],
    currentTextBlockId: null,
    reasoningBlockId: null,
    toolBlockIndex: {},
    finalText: '',
    finalReasoning: '',
    toolCalls: [],
    timeline: [],
    usage: emptyUsage(),
    lastStepUsage: null,
    stepsCompleted: 0,
    maxSteps: effectiveMaxSteps,
    permissionTimeoutMs: effectivePermissionTimeout,
    errored: null,
    finishReason: null,
    currentTextEntry: null,
  };
  activeTurns.set(sessionId, turn);

  // Execute skill invocations for any `[[LOAD_SKILL:…]]` markers BEFORE the
  // model thinks. For each marker, the orchestrator reads the SKILL.md, emits
  // a visible load_skill tool card, strips the marker from the user message,
  // and appends the skill body to the SYSTEM PROMPT (not the user message).
  //
  // System-prompt placement is the key fix: the original code put the body in
  // the user message with a CRITICAL directive, which GLM-5.2 ignored — it
  // dove into exploration without following the skill. System-prompt
  // instructions carry higher priority and are harder for the model to
  // bypass. The model retains full tool access (it can explore the project,
  // write files, etc.) which is required for process skills like brainstorming
  // that need to read project state and write design docs.
  // Create the turn controller — shared between prepareStep + onStepEnd hooks
  // for skill gating, tool restriction, and budget nudges. Set the compaction
  // config's context window from the model's known capability so autocompact
  // fires at the right threshold (not the generic 128K default).
  // effectiveMaxSteps was snapshot above onto turn.maxSteps; reused here.
  const turnController = createTurnController(effectiveMaxSteps);
  const knownCtxWindow = contextWindowSize(modelId);
  // Read compaction settings from agentSettings (Settings → Permissions & Caps).
  // Falls back to defaults if missing or disabled.
  const compactionEnabled = agentSettings.compactionEnabled ?? true;
  const compactionThreshold = Math.min(0.95, Math.max(0.5, agentSettings.compactionThreshold ?? 0.75));
  const compactionKeepTurns = Math.max(1, Math.floor(agentSettings.compactionKeepTurns ?? 3));
  if (knownCtxWindow && compactionEnabled) {
    turnController.compactionConfig = {
      ...DEFAULT_AUTO_COMPACT_CONFIG,
      contextWindow: knownCtxWindow,
      threshold: compactionThreshold,
      keepRecentTurns: compactionKeepTurns,
    };
    turnController.budget.warningThreshold = Math.floor(knownCtxWindow * compactionThreshold);
  } else if (knownCtxWindow) {
    // Compaction disabled — set a very high threshold so shouldCompact never fires.
    turnController.compactionConfig = {
      ...DEFAULT_AUTO_COMPACT_CONFIG,
      contextWindow: knownCtxWindow,
      threshold: 0.99,
    };
  }

  // ── Skill pipeline: markers → sticky ref → discovery index ──────────
  // processSkillMarkers pre-reads any `[[LOAD_SKILL:...]]` markers and emits
  // the visible tool cards. applyStickySkillRef then handles the cross-turn
  // lifecycle: persist on new marker, re-inject on continuation, clear on
  // new slash command. injectSkillBodies places the accumulated bodies at the
  // top of the system prompt, and injectSkillDiscoveryIndex adds the compact
  // available-skills list so the model can autonomously call load_skill.
  const { skillBodies: markerSkillBodies, loaded: loadedThisTurn } = await processSkillMarkers(
    wc, turn, convo, root, turnController,
  );
  // Boxed so applyStickySkillRef can append the continuation-turn body.
  const skillBodiesBox = { value: markerSkillBodies };
  const activeSkillRef = await applyStickySkillRef(
    sessionId, convo, root, loadedThisTurn, priorSkillRef, turnController, skillBodiesBox,
  );
  systemPrompt = injectSkillBodies(systemPrompt, skillBodiesBox.value);
  // Read the disabled-extensions config once — used by both the discovery
  // index and the chaining reminder to filter out disabled skills.
  let disabledSkills: string[] = [];
  let disabledAgents: string[] = [];
  try {
    const extStore = createExtensionsStore(appDataDir());
    const disabled = extStore.getDisabled();
    disabledSkills = disabled.skills;
    disabledAgents = disabled.agents;
  } catch { /* extensions config unreadable — show all */ }
  systemPrompt = injectSkillDiscoveryIndex(systemPrompt, root, activeSkillRef?.path, disabledSkills);
  systemPrompt = injectSkillChainingReminder(systemPrompt, root, turnController, disabledSkills);

  // (Mermaid diagram rules moved to 13-data-visualization.md — bundled in the
  // base system prompt via promptMarkdownUtils.mjs.)

  const ragEnabled = store.listRagEnabledWorkspaces().includes(workspaceId);
  if (ragEnabled) {
    systemPrompt +=
      `\n\n# Codebase recall\n` +
      `The \`memory\` tool is available and this workspace has a semantic index ` +
      `(RAG). For questions about HOW the codebase works — architecture, patterns, ` +
      `"where is X handled", "how does Y work" — call \`memory\` FIRST with a natural-language ` +
      `query. It returns ranked code chunks in one call (~0.5s) and is much faster than ` +
      `exploring with list_dir + read_file. Fall back to read_file/grep only when you need ` +
      `the full file or an exact-string search the index might miss.`;
  }

  // Resolve the model + thinking budget. `null` budget → thinking disabled.
  // Thinking is also disabled when the model doesn't support reasoning —
  // sending reasoning_effort or budget_tokens to an unsupported model wastes
  // tokens or triggers a provider error.
  // EXCEPTION: when the model's reasoning is mandatory (always on, sourced
  // from a live provider response), force a thinking budget even if the
  // session's level is 'off' — the model reasons regardless, so omitting the
  // config is wrong.
  const model = resolveModel(provider, { modelId, contextWindow: 0 } as any);
  const modelSupportsThinking = supportsThinking(modelId);
  const modelEntry = provider.models.find((m) => m.modelId === modelId);
  const reasoningMandatory = modelEntry?.reasoningMandatory === true;
  let thinking = modelSupportsThinking ? thinkingPayload(thinkingLevel) : null;
  if (reasoningMandatory && !thinking) {
    // Mandatory model + (off or unsupported-but-flagged) → force a medium budget.
    thinking = thinkingPayload('medium');
    log.info('thinking forced (reasoning mandatory)', { model: modelId });
  }
  if (thinkingLevel !== 'off' && !modelSupportsThinking && !reasoningMandatory) {
    log.info('thinking disabled — model does not support reasoning', { model: modelId });
  }

  // Permission rules: project (.agent/settings.json) + user (~/.agent).
  // Loaded fresh per turn — cheap read, and picks up edits made mid-session.
  // Session-scoped rules live in the rules module (in-memory).
  const permissionRules = loadPermissionRules(root);

  // The ToolContext closure. Tools read ctx.{workspaceRoot, autonomyMode,
  // abortSignal, ...} at execution time. ctx.emit is the BRIDGE that turns
  // a tool's PartEvent-shaped emission (e.g. withPermission's
  // `{ type: 'permission', ... }`) into the legacy AgentEvent the renderer
  // needs. Until Task 3.2 wires withPermission into each execute, this is
  // dormant; the bridge is ready for the moment it does.
  const ctx: ToolContext = {
    sessionId,
    workspaceRoot: root,
    workspaceId,
    autonomyMode,
    permissionRules,
    modelId,
    provider,
    compactionSettings: DEFAULT_COMPACTION_SETTINGS,
    onUsage: (u) => accumulateUsage(turn, u),
    abortSignal: controller.signal,
    emit: (raw) => bridgeToolEmit(wc, turn, raw),
  };
  // Register the ctx so live mode updates (agent:updateMode IPC) can mutate it.
  activeCtxs.set(sessionId, ctx);

  // Load user/project hooks (.agent/hooks.json). Null-safe — if no config
  // exists, buildToolset skips the hook wrapper (zero overhead).
  const hookConfig = loadHookConfig(root);

  // Merge built-in tools with dynamically discovered MCP tools. MCP tools
  // are keyed `mcp__<server>__<tool>` so they can never collide with the
  // built-in namespace (which uses flat names like `bash`, `read_file`).
  const builtinTools = buildToolset(ctx, hookConfig);
  const mcpTools = mcpToolsetForWorkspace(workspaceId);
  const tools = { ...builtinTools, ...mcpTools };

  log.info('runTurn', {
    session: sessionId,
    provider: provider.name,
    model: modelId,
    mode: autonomyMode,
    thinking: thinkingLevel,
    tools: Object.keys(tools).length,
    root,
    worktree: worktreeMeta ? { branch: worktreeMeta.branch, baseBranch: worktreeMeta.baseBranch } : undefined,
  });

  // ── Turn-level retry loop ───────────────────────────────────────────
  // Wraps the entire try/catch. On transient provider errors (network, 5xx,
  // empty stream, timeout), we retry up to TURN_MAX_RETRIES times, emitting a
  // `retry` event each time so the UI can show "Retrying 1/2…". After all
  // retries are exhausted, the final error is sent as a terminal `error` event.
  // Aborts (user Stop) skip retrying and flush partial work immediately.
  let retryCount = 0;

  turnRetryLoop: for (;;) {
  try {
    let responseMessages = await runStream(wc, turn, {
      model,
      system: systemPrompt,
      messages: convo,
      tools,
      thinking,
      provider,
      modelId,
      signal: controller.signal,
      turnController,
      hookConfig,
      workspaceRoot: root,
    });

    // ── Length-cap recovery: escalate, then resume ───────────────────
    // A finishReason='length' means the model was cut off mid-thought by
    // max_output_tokens — NOT done thinking. Two cheap recovery tiers before
    // we fall through to the skill-correction / wrap-up paths:
    //
    //   TIER 1 — Escalate: retry once at ESCALATED_MAX_TOKENS with the SAME
    //   messages (no user message appended). Often succeeds with zero extra
    //   tokens beyond the longer generation. Cache stays warm.
    //
    //   TIER 2 — Resume: inject RESUME_MESSAGE as a user turn and re-stream.
    //   The wording suppresses apology/recap waste. Capped at MAX_RESUME_ATTEMPTS.
    //
    // Only triggered when the FINAL finishReason was 'length' AND no error AND
    // no abort. A subsequent 'length' after escalation → tier 2. A 'stop' after
    // escalation → skill-correction loop below handles it.
    let escalated = false; // tier 1 fires at most once per turn
    let resumes = 0;       // tier 2 cap
    while (
      !controller.signal.aborted &&
      !turn.errored &&
      turn.finishReason === 'length' &&
      (resumes < MAX_RESUME_ATTEMPTS || !escalated)
    ) {
      // Tier 1 — escalate (only once, and only if we haven't already exceeded
      // the cap via thinking-budget math).
      if (!escalated) {
        escalated = true;
        log.warn(
          'length hit — escalating maxOutputTokens and retrying',
          { maxOutputTokens: ESCALATED_MAX_TOKENS },
        );
        // Reset finishReason so we re-evaluate against the NEW step's result.
        turn.finishReason = null;
        responseMessages = await runStream(wc, turn, {
          model,
          system: systemPrompt,
          messages: [...convo, ...responseMessages],
          tools,
          thinking,
          provider,
          modelId,
          signal: controller.signal,
          turnController,
          hookConfig,
          workspaceRoot: root,
          maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
        });
        continue;
      }
      // Tier 2 — resume message
      resumes++;
      log.warn(
        'length hit again after escalation — injecting resume message',
        { attempt: resumes, max: MAX_RESUME_ATTEMPTS },
      );
      turn.finishReason = null;
      responseMessages = await runStream(wc, turn, {
        model,
        system: systemPrompt,
        messages: [...convo, ...responseMessages, { role: 'user', content: RESUME_MESSAGE }],
        tools,
        thinking,
        provider,
        modelId,
        signal: controller.signal,
        turnController,
        hookConfig,
        workspaceRoot: root,
        // Keep the escalated cap so the resumed turn has the same breathing
        // room — otherwise we'd just hit the default 8K again immediately.
        maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
      });
    }

    // ── Skill premature-stop correction loop ─────────────────────────
    // onStepEnd detects when the model stopped before finishing an active
    // skill (text-only step + checklist incomplete) and stashes a correction
    // message in ctrl.needsCorrection. BUT: the SDK only continues the
    // multi-step loop when a step ends with tool calls. A finishReason='stop'
    // step is a HARD stop — no further prepareStep is called, so the
    // stashed correction evaporates. Same problem for stop-hook soft blocks.
    //
    // Fix: after each stream returns, if the controller still wants a
    // correction AND the last step was a natural stop, re-invoke runStream
    // with the prior messages + the correction as a fresh user turn. This is
    // the ONLY way to resume after a stop. Capped to avoid runaway loops;
    // shared between skill-gate corrections and stop-hook soft blocks.
    const MAX_CORRECTIONS = 3;
    let corrections = 0;
    while (
      corrections < MAX_CORRECTIONS &&
      !controller.signal.aborted &&
      !turn.errored &&
      turn.finishReason === 'stop' &&
      ctrlHasPendingCorrection(turnController)
    ) {
      corrections++;
      const correction = turnController.needsCorrection;
      turnController.needsCorrection = null;
      // Re-entering the stream clears the prior stop reason; reset so the
      // loop condition re-evaluates cleanly against the NEW step's finish.
      turn.finishReason = null;
      log.warn(
        'resuming after stop — injecting correction',
        {
          attempt: corrections,
          max: MAX_CORRECTIONS,
          skill: turnController.skill?.name,
          stopHook: turnController.stopHookActive || undefined,
        },
      );
      responseMessages = await runStream(wc, turn, {
        model,
        system: systemPrompt,
        messages: [...convo, ...responseMessages, { role: 'user', content: correction }],
        tools,
        thinking,
        provider,
        modelId,
        signal: controller.signal,
        turnController,
        hookConfig,
        workspaceRoot: root,
      });
    }

    // ── Slice E: step cap → forced wrap-up ──────────────────────────
    // The SDK stops at isStepCount(MAX_STEPS) only if the model kept calling
    // tools (a natural end stops earlier). On a cap hit with no trailing
    // text answer, force one final no-tools call with a wrap-up instruction —
    // matches the legacy MAX_ITERATIONS tail. If we already have an answer
    // or errored, skip. The primary call's responseMessages are appended so
    // the wrap-up model can see — and report on — its own in-progress work.
    const capHit = turn.stepsCompleted >= effectiveMaxSteps;
    const hasAnswer = turn.finalText.trim().length > 0;
    if (capHit && !hasAnswer && !turn.errored && !controller.signal.aborted) {
      log.warn('step cap hit; forcing wrap-up call', { cap: effectiveMaxSteps });
      await runStream(wc, turn, {
        model,
        // The wrap-up directive is intentionally terse — no preamble, no recap
        // of what was done. Lead with the imperative, then the constraint.
        // Same philosophy as RESUME_MESSAGE: suppress the model's reflexive
        // "Sorry, I'll wrap up…" preamble, which wastes tokens at the cap.
        system:
          systemPrompt +
          '\n\nYou have reached the step limit. Wrap up now — no preamble, no recap. ' +
          'State what was completed and what remains in two sentences or less.',
        messages: [...convo, ...responseMessages],
        tools: {}, // no tools → the model must answer in prose
        thinking,
        provider,
        modelId,
        signal: controller.signal,
        turnController,
        hookConfig,
        workspaceRoot: root,
        wrapUp: true,
      });
    }

    emitTurnEnd(wc, turn, stopReasonFor(turn));
    break; // success — exit the retry loop
  } catch (err: any) {
    const userAborted = err?.name === 'AbortError' && controller.signal.aborted;
    if (userAborted) {
      // User pressed Stop — flush partial work, no retry.
      emitTurnEnd(wc, turn, 'aborted');
      break;
    }
    // Transient error (provider 5xx, network, timeout, empty stream).
    // Retry up to TURN_MAX_RETRIES times before surfacing the terminal error.
    if (retryCount < TURN_MAX_RETRIES && !controller.signal.aborted) {
      retryCount++;
      const reason = isTimeoutError(err)
        ? `Request timed out after ${TURN_RETRY_TIMEOUT_MS / 1000}s`
        : (err?.message || String(err));
      log.warn('turn failed — retrying', {
        session: sessionId,
        attempt: retryCount,
        maxRetries: TURN_MAX_RETRIES,
        reason,
      });
      // Notify the UI so it can show "Retrying 1/2…".
      send(wc, sessionId, {
        type: 'retry',
        sessionId,
        seq: nextSeq(sessionId),
        attempt: retryCount,
        maxAttempts: TURN_MAX_RETRIES,
        reason,
      });
      // Reset turn state for the retry — clear partial text/error so the
      // retried stream starts clean. Keep timeline/blocks from prior steps
      // (tools that already executed are still valid).
      turn.errored = null;
      turn.finishReason = null;
      turn.finalText = '';
      turn.finalReasoning = '';
      continue turnRetryLoop;
    }
    // All retries exhausted — surface the terminal error.
    turn.errored = isTimeoutError(err)
      ? `Request timed out after ${TURN_RETRY_TIMEOUT_MS / 1000}s (${retryCount + 1} attempts)`
      : (err?.message || String(err));
    const errMsg: string = turn.errored ?? 'Turn failed';
    send(wc, sessionId, {
      type: 'error',
      sessionId,
      seq: nextSeq(sessionId),
      message: errMsg,
    });
    break;
  } // end try
  } // end turnRetryLoop for(;;)

  // Runs once after the retry loop exits (success, abort, or terminal error).
  clearSession(sessionId);
  // NOTE: clearSessionRules intentionally NOT called here. Session-scoped
  // "always allow" rules must survive across turns within the same session
  // (the UI promises "until session ends"). They are cleared on real
  // session end in ipc/sessions.ts → deleteSession.
  clearFollowupSession(sessionId);
  activeTurns.delete(sessionId);
  activeCtxs.delete(sessionId);
}

// ─── Slice A–D: the stream runner ────────────────────────────────────

/**
 * Whether the turn controller has a pending correction that should re-enter
 * the stream. Two producers set `needsCorrection`:
 *   1. `onStepEnd` skill gate — premature stop with checklist incomplete
 *   2. `onStepEnd` stop hook — soft block (blocking errors returned)
 *   3. `checkBudgetNudge` — step/token pressure (informational nudge)
 *
 * Budget nudges are informational and should NOT re-enter the loop on their
 * own (they're meant for the NEXT prepareStep inside an active multi-step
 * stream, not a fresh one). Only skill-gate and stop-hook corrections should
 * force a re-stream. We detect them by the `stopHookActive` flag (set
 * alongside stop-hook corrections) or by an active skill whose checklist is
 * incomplete (skill-gate corrections are only set when `!allChecklistDone`).
 */
function ctrlHasPendingCorrection(ctrl: TurnController): boolean {
  if (!ctrl.needsCorrection) return false;
  if (ctrl.stopHookActive) return true;
  if (ctrl.skill && ctrl.skill.checklist.length > 0 && !allChecklistDone(ctrl.skill)) return true;
  return false;
}

interface StreamArgs {
  model: ReturnType<typeof resolveModel>;
  system: string;
  messages: ModelMessage[];
  tools: Record<string, unknown>;
  thinking: { type: 'enabled'; budgetTokens: number } | null;
  /** Provider + modelId drive the thinking gate (see supportsAnthropicThinking). */
  provider: Provider;
  modelId: string;
  signal: AbortSignal;
  /** Per-turn controller for skill gating + budget nudges. */
  turnController: TurnController;
  /** Hook config for stop hooks (null = no hooks). */
  hookConfig: HookConfig | null;
  /** Workspace root — for hook cwd and skill file resolution. */
  workspaceRoot: string;
  /** True when this is the forced step-cap wrap-up call (no tools). */
  wrapUp?: boolean;
  /**
   * Override the per-protocol maxOutputTokens resolution. Used by the length-
   * cap escalation path (runSdkTurn) to retry at ESCALATED_MAX_TOKENS without
   * waiting for a follow-up turn. Undefined → resolve normally (default 8192).
   */
  maxOutputTokensOverride?: number;
}

/**
 * Runs one `streamText` call and translates its stream parts into the legacy
 * AgentEvent stream while maintaining the block mirror. Used for both the
 * primary multi-step call and the forced wrap-up.
 */
async function runStream(wc: WebContents, turn: SdkTurn, args: StreamArgs): Promise<ModelMessage[]> {
  // Pricing rates for real cost calculation — resolved from the provider's
  // model entry (persisted at fetch time from the provider's /models response).
  const modelEntry = args.provider.models.find((m) => m.modelId === args.modelId);
  if (modelEntry) {
    log.debug('pricing resolved', {
      model: args.modelId,
      inputCost: modelEntry.inputCostPerToken,
      outputCost: modelEntry.outputCostPerToken,
      hasPricing: !!(modelEntry.inputCostPerToken || modelEntry.outputCostPerToken),
    });
  } else {
    log.warn('no model entry for pricing', { model: args.modelId, providerModels: args.provider.models.map(m => m.modelId) });
  }
  // Per-protocol thinking/options resolution lives in ./protocols — the
  // orchestrator itself is protocol-agnostic and just consumes the result.
  // Anthropic → thinking.budget_tokens; OpenAI → reasoning_effort (unless
  // tools are present — some Gemini endpoints reject that combo with 400).
  const hasTools = !args.wrapUp && Object.keys(args.tools).length > 0;
  const resolved = resolveProtocolOptions(
    args.provider.apiStyle,
    args.thinking,
    { hasTools, modelId: args.modelId, maxOutputTokens: resolveMaxOutputTokens(args.modelId), providerBaseUrl: args.provider.baseUrl },
  );
  // An explicit override (length-cap escalation) wins over the protocol's
  // default — the model already proved it needs more room than the default
  // provides. Provider options (thinking config, etc.) are still applied.
  const providerOptions = resolved.providerOptions;
  const maxOutputTokens = args.maxOutputTokensOverride ?? resolved.maxOutputTokens;
  const label = args.maxOutputTokensOverride
    ? `${resolved.label} → escalated maxOutputTokens=${args.maxOutputTokensOverride}`
    : resolved.label;
  if (args.thinking) {
    log.debug('thinking enabled', { model: args.modelId, via: label });
  }

  const ctrl = args.turnController;

  const result = streamText({
    model: args.model,
    system: args.system || undefined,
    messages: args.messages,
    tools: args.tools as any,
    // Non-native Anthropic endpoints (z.ai, etc.) wrap errors as 200+JSON.
    // The SDK retries these (default maxRetries=2 = 3 attempts), wasting
    // ~8s on a permanent error. Fail fast instead — the diagnostic fetch
    // wrapper in provider-factory.ts surfaces the real provider error.
    maxRetries: 0,
    // v7 renamed `maxSteps` → `stopWhen`. isStepCount(N) returns true once N
    // steps complete, capping the model↔tool loop at MAX_STEPS. The custom
    // predicate lets the controller stop the loop early (e.g. skill complete).
    toolChoice: args.wrapUp ? 'none' : undefined,
    stopWhen: args.wrapUp
      ? undefined
      : [
          isStepCount(turn.maxSteps),
          () => ctrl.shouldStop,
        ],
    maxOutputTokens,
    abortSignal: args.signal,
    providerOptions,
    // ── TOOL CALL REPAIR ──
    // Some models (GLM, Gemini) leak XML artifacts into JSON tool arguments:
    //   {"path":"file.ts"}</tool_call>
    // The SDK's JSON parser fails on the trailing `</tool_call>`. This repair
    // function strips XML artifacts and returns the CLEANED STRING (not a
    // parsed object) — the SDK re-parses it via doParseToolCall.
    repairToolCall: async ({ toolCall }) => {
      const input = toolCall.input;
      // Only repair if input is a string (the raw, unparseable JSON).
      if (typeof input !== 'string') return toolCall;

      // Strip XML artifacts that models leak into JSON tool args.
      const cleaned = input
        .replace(/<\/?tool_call>/g, '')
        .replace(/<\/?tool_use>/g, '')
        .replace(/<\/?function_call>/g, '')
        .trim();

      // If cleaning produced valid JSON, return the tool call with the
      // cleaned string — the SDK re-parses it.
      try {
        JSON.parse(cleaned);
        return { ...toolCall, input: cleaned };
      } catch {
        // Try extracting the first {...} block.
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            JSON.parse(match[0]);
            return { ...toolCall, input: match[0] };
          } catch { /* give up */ }
        }
      }

      // Can't repair — return null so the SDK throws the original error.
      return null;
    },
    onError: ({ error }) => {
      // Non-fatal stream errors land here; fatal ones throw out of the stream.
      // Record the last and let the loop continue — turn_end surfaces it.
      turn.errored = errMessage(error);
    },

    // ── BETWEEN-STEP HOOK: mutate before each step ──
    // prepareStep is called before EVERY step (including the first). It can
    // override tools, messages, system, model, etc. We use it to:
    //   1. Compact context if approaching the window (async — forked summarizer)
    //   2. Inject correction messages (from onStepEnd deviation/budget flags)
    //   3. Restrict tools when a skill declares activeToolSet
    //
    // All three concerns are COMBINED into a single returned object. The prior
    // implementation early-returned on the first match, which silently dropped
    // the others — e.g. a compaction on a skill turn meant the skill's
    // activeToolSet was never applied (the model briefly saw the full toolset).
    async prepareStep({ messages }) {
      // Wrap-up call: no hooks — just force a plain prose answer.
      if (args.wrapUp) return undefined;

      // Accumulator — mutations land here so every concern gets a chance.
      let nextMessages: ModelMessage[] | undefined;
      let activeTools: string[] | undefined;

      // 1. Autocompact — check if context is too large (or user forced via /compact).
      // The [[FORCE_COMPACT]] marker is injected by the /compact slash command.
      const forceCompact = messages.some((m) =>
        typeof m.content === 'string' && m.content.includes('[[FORCE_COMPACT]]')
      );
      // Use the LAST step's actual input tokens (what the model saw) rather
      // than the cumulative sum across all steps. The context window is filled
      // by the messages sent — each step re-sends the full conversation, so
      // the last step's inputTokens IS the current context size.
      const lastStepInputTokens = ctrl.budget.lastInputTokens || undefined;
      if (
        forceCompact ||
        shouldCompact(
          messages,
          ctrl.compactionConfig ?? DEFAULT_AUTO_COMPACT_CONFIG,
          ctrl.consecutiveCompactionFailures,
          lastStepInputTokens,
        )
      ) {
        try {
          if (forceCompact) log.info('forced compaction (/compact)', { messagesBefore: messages.length });
          // Emit a compacting event so the UI can show an indicator.
          const tokensBefore = lastStepInputTokens ?? estimateTokens(messages);
          send(wc, sessionId, {
            type: 'compacting',
            sessionId,
            seq: nextSeq(sessionId),
            messageId: turn.messageId,
            tokensBefore,
            forced: forceCompact,
          });
          const config = ctrl.compactionConfig ?? DEFAULT_AUTO_COMPACT_CONFIG;
          const result = await compactConversation(messages, config, {
            provider: args.provider,
            modelId: args.modelId,
            signal: args.signal,
          });
          ctrl.consecutiveCompactionFailures = 0; // reset on success
          nextMessages = result.postCompactMessages;
        } catch (e: any) {
          ctrl.consecutiveCompactionFailures++;
          log.warn(
            'autocompact failed',
            { failures: ctrl.consecutiveCompactionFailures, max: 3, err: e?.message ?? e },
          );
          // Fall through — if onFailure is 'truncate', compactConversation
          // already handled it; if 'error', we proceed without compaction.
        }
      }

      // 2. Inject correction if onStepEnd flagged a deviation or budget nudge.
      // Budget nudges are informational (no re-stream) — they ride along here
      // only because prepareStep is also the natural injection point INSIDE a
      // running multi-step loop. The post-stream re-entry loop in runSdkTurn
      // decides whether to start a fresh stream; this just delivers the nudge
      // when the loop is still active.
      if (ctrl.needsCorrection) {
        const base = nextMessages ?? messages;
        nextMessages = [...base, { role: 'user' as const, content: ctrl.needsCorrection }];
        ctrl.needsCorrection = null;
      }

      // 3. Restrict tools if the active skill declares a tool set.
      if (ctrl.skill?.activeToolSet && ctrl.skill.activeToolSet.length > 0) {
        activeTools = ctrl.skill.activeToolSet;
      }

      if (nextMessages || activeTools) {
        return {
          ...(nextMessages ? { messages: nextMessages } : {}),
          ...(activeTools ? { activeTools } : {}),
        };
      }
      return undefined;
    },

    // ── BETWEEN-STEP HOOK: inspect after each step ──
    // onStepEnd fires after each LLM call + tool execution completes. It's
    // awaited before the next step starts. We use it to:
    //   1. Track skill checklist progress
    //   2. Detect premature stops (model stopped before skill is done)
    //   3. Nudge on budget (approaching step cap or context limit)
    async onStepEnd(step) {
      ctrl.stepCount = step.stepNumber + 1;
      ctrl.budget.inputTokens += step.usage?.inputTokens ?? 0;
      ctrl.budget.outputTokens += step.usage?.outputTokens ?? 0;
      // Track the LAST step's actual input tokens — this is what the model
      // saw in its context window (the full conversation + system prompt).
      // Used by autocompact's threshold check: the cumulative sum is wrong
      // because each step re-sends the entire conversation.
      ctrl.budget.lastInputTokens = step.usage?.inputTokens ?? ctrl.budget.lastInputTokens;
      // Capture the MAIN orchestrator's per-step usage as lastStepUsage.
      // This fires for every main-loop step (not sub-agent steps, which have
      // their own streamText in runtime.ts). The context meter reads this.
      if (step.usage) {
        turn.lastStepUsage = sdkUsageToTide(
          step.usage as LanguageModelUsage,
          modelEntry,
          1,
        );
      }

      // Skill process gate
      if (ctrl.skill && ctrl.skill.checklist.length > 0) {
        for (const call of step.toolCalls ?? []) {
          markChecklistProgress(ctrl, call);
        }
        // If the model produced text + stopped (no tool calls) but the skill
        // isn't complete, flag a correction for the next prepareStep.
        if (
          looksLikePrematureStop({
            finishReason: step.finishReason,
            text: step.text,
            toolCalls: step.toolCalls as unknown[] | undefined,
          }) &&
          !allChecklistDone(ctrl.skill)
        ) {
          ctrl.needsCorrection = buildCorrectionMessage(ctrl.skill);
          log.debug('skill gate: premature stop detected', {
            skill: ctrl.skill.name,
            completed: ctrl.skill.completedSteps.size,
            total: ctrl.skill.checklist.length,
          });
        }
      }

      // ── Todo gate ──────────────────────────────────────────────────
      // Open todos must be finished before the model moves on to unrelated
      // work. After each step, if todos exist with pending items AND the
      // model did NOT just call todo_write, inject a reminder naming the
      // next open item. The model can either work on it or explicitly close
      // it via todo_write — but it can't silently drift away.
      //
      // Skip when:
      //   - turn.errored / abort (no point nagging during teardown)
      //   - step is a natural stop (finish='stop') — the post-stream
      //     correction loop in runSdkTurn handles resumption, and we don't
      //     want to duplicate the nudge
      //   - model already has a pending correction (skill gate fired) — the
      //     skill correction takes priority since it covers the same ground
      if (!turn.errored && !ctrl.needsCorrection && step.finishReason !== 'stop') {
        const todos = getSessionTodos(turn.sessionId);
        const open = todos.filter((t) => t.status !== 'completed');
        const justUpdatedTodos = (step.toolCalls ?? []).some(
          (c: any) => resolveToolName(c.toolName ?? '') === 'todo_write',
        );
        if (open.length > 0 && !justUpdatedTodos) {
          const next = todos.find((t) => t.status === 'in_progress') ?? open[0];
          ctrl.needsCorrection =
            `You have ${open.length} open todo${open.length === 1 ? '' : 's'} in your todo list. ` +
            `Next: "${next.content}". Do this next, or update the todo list via todo_write ` +
            `to reflect what's actually being worked on. Do not move on to unrelated work ` +
            `while todos are open.`;
          log.debug('todo gate: nudging toward open todo', {
            open: open.length,
            total: todos.length,
            next: next.content,
          });
        }
      }

      // Budget nudges (step-cap proximity + context-window pressure)
      checkBudgetNudge(ctrl);

      // ── Stop hooks ──
      // Run when the model naturally terminates (no tool calls, finish='stop').
      // Skip on wrap-up calls and when stopHookActive is already set (prevents
      // infinite loops — a blocking hook that triggers another stop sees the
      // flag and can choose not to re-block).
      const naturalStop = step.finishReason === 'stop' &&
        (!step.toolCalls || step.toolCalls.length === 0);
      if (naturalStop && !args.wrapUp && args.hookConfig && args.hookConfig.stop.length > 0) {
        try {
          const result = await handleStopHooks(args.hookConfig, {
            event: 'Stop',
            stopHookActive: ctrl.stopHookActive,
            responseText: step.text ?? '',
            workspaceRoot: args.workspaceRoot,
          });
          if (result.preventContinuation) {
            ctrl.shouldStop = true;
            log.info('stop hook: hard stop (preventContinuation)');
          } else if (result.blockingErrors.length > 0) {
            ctrl.needsCorrection = result.blockingErrors.join('\n\n');
            ctrl.stopHookActive = true;
            log.info('stop hook: soft block', { errors: result.blockingErrors.length });
          }
        } catch (e: any) {
          log.warn('stop hook error', { err: e?.message ?? e });
        }
      }
    },
  });

  // v7 renamed fullStream → stream (identical TextStreamPart stream; the old
  // name is just deprecated). Yields text deltas, tool calls/results, and
  // errors — everything the translator needs.
  // Wrap in try/catch — the SDK's stream finalization can throw when MCP
  // tool calls have schema mismatches (the `hasFinished` crash). Catching
  // here lets the turn end gracefully with whatever blocks were streamed
  // before the crash, instead of killing the whole turn.
  try {
    for await (const part of result.stream) {
      translatePart(wc, turn, part, modelEntry);
    }
  } catch (streamErr: any) {
    // Log but don't rethrow — partial results are still useful.
    console.warn(`[agent-sdk] stream interrupted: ${streamErr?.message ?? streamErr}`);
    turn.errored = turn.errored ?? streamErr?.message;
  }

  // responseMessages = the assistant + tool turns the model produced this call.
  // Handed back so the forced wrap-up can seed its conversation with the
  // model's own in-progress work — without it the wrap-up can't see what was
  // done during the capped primary call. ResponseMessage is a subset of
  // ModelMessage, so the cast-free widening is safe.
  try {
    return await result.responseMessages;
  } catch {
    // responseMessages can throw if the stream was interrupted mid-tool-call.
    // Return an empty array so the caller doesn't crash.
    return [];
  }
}

/**
 * The heart of the parts→events adapter. Each SDK stream part becomes one or
 * more legacy AgentEvents on `agent:event` (the current renderer's format),
 * plus a mutation to the block mirror shipped on turn_end.
 *
 * Phase 4 will swap this translator for `useParts` + `deriveView` consuming
 * parts directly; until then, this is the "temporary parts→blocks adapter"
 * the design specifies for Phase 3.
 *
 * Adding a new part type = adding a case here. The switch is exhaustive over
 * the part types this orchestrator cares about; unhandled ones (source, file,
 * raw, …) are ignored since no current tool emits them.
 */
function translatePart(
  wc: WebContents,
  turn: SdkTurn,
  part: Readonly<{ type: string }>,
  modelEntry: { inputCostPerToken?: number; outputCostPerToken?: number; cacheReadCostPerToken?: number; cacheWriteCostPerToken?: number } | undefined,
): void {
  const { sessionId } = turn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = part as any;

  switch (part.type) {
    // ── Text ────────────────────────────────────────────────────────
    case 'text-delta': {
      const text: string = p.text;
      if (!text) break;

      // Open/append the text block mirror. A fresh block is opened whenever
      // currentTextBlockId is null — set to null on tool landing so the next
      // delta after a tool starts a new segment (preserves interleaving).
      const last = turn.blocks[turn.blocks.length - 1];
      if (last && last.kind === 'text' && last.id === turn.currentTextBlockId) {
        (last as TextBlock).text += text;
      } else {
        const id = crypto.randomUUID();
        turn.currentTextBlockId = id;
        turn.blocks.push({
          id,
          kind: 'text',
          text,
          createdAtSeq: 0,
          modifiedAtSeq: 0,
          isAnswer: false,
        });
      }

      // Timeline entry — same open/append rule as the legacy loop.
      if (!turn.currentTextEntry) {
        turn.currentTextEntry = { type: 'text', text: '' };
        turn.timeline.push(turn.currentTextEntry);
      }
      turn.currentTextEntry.text += text;

      turn.finalText += text;
      const blockId = turn.currentTextBlockId!;

      send(wc, sessionId, {
        type: 'delta',
        sessionId,
        seq: nextSeq(sessionId),
        messageId: turn.messageId,
        text,
        blockId,
      });
      break;
    }

    // ── Reasoning (Anthropic extended thinking) ───────────────────────
    case 'reasoning-delta': {
      const text: string = p.text;
      if (!text) break;
      turn.finalReasoning += text;
      if (!turn.reasoningBlockId) {
        turn.reasoningBlockId = crypto.randomUUID();
        turn.blocks.push({
          id: turn.reasoningBlockId,
          kind: 'reasoning',
          text: '',
          createdAtSeq: 0,
          modifiedAtSeq: 0,
        });
      }
      const rb = turn.blocks.find((b) => b.id === turn.reasoningBlockId) as
        | ReasoningBlock
        | undefined;
      if (rb) rb.text += text;

      send(wc, sessionId, {
        type: 'reasoning',
        sessionId,
        seq: nextSeq(sessionId),
        messageId: turn.messageId,
        delta: text,
        blockId: turn.reasoningBlockId,
      });
      break;
    }

    // ── Tool call forming (args streaming in) ───────────────────────
    case 'tool-input-start': {
      const toolCallId: string = p.id;
      const toolName: ToolName = resolveToolName(p.toolName) as ToolName;
      // Tool landing finalizes the open text segment — next delta opens a
      // fresh one. This is what preserves text₁ → tool → text₂.
      turn.currentTextBlockId = null;
      turn.currentTextEntry = null;
      turn.toolBlockIndex[toolCallId] = turn.blocks.length;
      const meta = safeMeta(toolName);
      const toolBlock: ToolBlock = {
        id: toolCallId,
        kind: 'tool',
        toolCallId,
        toolName,
        category: categorizeTool(toolName),
        status: 'pending',
        arguments: {},
        argPreview: '',
        riskTier: meta?.riskTier ?? 'read_only',
        createdAtSeq: 0,
        modifiedAtSeq: 0,
      };
      turn.blocks.push(toolBlock);

      send(wc, sessionId, {
        type: 'tool_call_start',
        sessionId,
        seq: nextSeq(sessionId),
        messageId: turn.messageId,
        toolCallId,
        toolName,
        blockId: toolCallId,
      });
      break;
    }

    case 'tool-input-delta': {
      const toolCallId: string = p.id;
      const delta: string = p.delta;
      send(wc, sessionId, {
        type: 'tool_call_delta',
        sessionId,
        seq: nextSeq(sessionId),
        toolCallId,
        delta,
      });
      break;
    }

    // ── Tool call fully assembled → execution begins ────────────────
    case 'tool-call': {
      const toolCallId: string = p.toolCallId;
      const toolName: ToolName = resolveToolName(p.toolName) as ToolName;
      const input = (p.input ?? {}) as Record<string, unknown>;
      const meta = safeMeta(toolName);
      const argPreview = formatArgPreview(toolName, input);

      patchToolBlock(turn, toolCallId, {
        arguments: input,
        argPreview,
        riskTier: meta?.riskTier ?? 'read_only',
        status: 'running',
      });

      send(wc, sessionId, {
        type: 'tool_call',
        sessionId,
        seq: nextSeq(sessionId),
        messageId: turn.messageId,
        toolCallId,
        toolName,
        arguments: input,
        argPreview,
        riskTier: meta?.riskTier ?? 'read_only',
      });
      // Execution-start signal. The SDK runs execute between tool-call and
      // tool-result with no explicit "started" part, so we surface it here
      // (execution is imminent) — matches the legacy tool_executing event.
      send(wc, sessionId, {
        type: 'tool_executing',
        sessionId,
        seq: nextSeq(sessionId),
        toolCallId,
      });
      break;
    }

    // ── Tool finished ────────────────────────────────────────────────
    case 'tool-result':
    case 'tool-error': {
      const toolCallId: string = p.toolCallId;
      const toolName: ToolName = resolveToolName(p.toolName) as ToolName;
      const input = (p.input ?? {}) as Record<string, unknown>;
      const meta = safeMeta(toolName);
      const argPreview = formatArgPreview(toolName, input);

      // Tool execute returns Tide's ToolResult shape ({status,output,...}).
      // tool-error synthesizes a failed result from the error payload.
      const tr: ToolResult =
        part.type === 'tool-result' && p.output && typeof p.output === 'object'
          ? ({ ...(p.output as object) } as ToolResult)
          : {
              status: 'failed',
              output: part.type === 'tool-error' ? errMessage(p.error) || 'Tool error' : '(no output)',
            };

      const status = normalizeStatus(tr.status);
      const startIdx = turn.toolCalls.length;

      const tc: ToolCall = {
        id: toolCallId,
        messageId: turn.messageId,
        toolName,
        arguments: input,
        argPreview,
        status,
        riskTier: meta?.riskTier ?? 'read_only',
        output: tr.output,
        display: tr.display,
        durationMs: tr.durationMs,
        meta: tr.meta,
      };
      turn.toolCalls.push(tc);
      // Record WHERE in the narrative this tool landed, then force the next
      // text delta to open a new segment.
      turn.timeline.push({ type: 'tool', toolIndex: startIdx });
      turn.currentTextEntry = null;

      patchToolBlock(turn, toolCallId, {
        status,
        output: tr.output,
        display: tr.display,
        durationMs: tr.durationMs,
        meta: tr.meta,
      });

      send(wc, sessionId, {
        type: 'tool_result',
        sessionId,
        seq: nextSeq(sessionId),
        toolCallId,
        status,
        output: tr.output,
        display: tr.display,
        durationMs: tr.durationMs,
        meta: tr.meta,
      });
      break;
    }

    // ── Per-step usage (Slice C) ────────────────────────────────────
    case 'finish-step': {
      turn.stepsCompleted += 1;
      if (p.usage) {
        const stepUsage = sdkUsageToTide(p.usage as LanguageModelUsage, modelEntry, 1);
        accumulateUsage(turn, stepUsage);
        // Save the LAST step's usage for the context meter (turn_end carries
        // it as lastStepUsage). The accumulated turn.usage sums all steps —
        // wrong for the meter because each step re-sends the full conversation.
        turn.lastStepUsage = stepUsage;
        send(wc, sessionId, {
          type: 'usage',
          sessionId,
          seq: nextSeq(sessionId),
          messageId: turn.messageId,
          tokens: stepUsage,
          costUsd: stepUsage.costUsd,
          runningTotalUsd: turn.usage.costUsd,
          iteration: turn.stepsCompleted,
        });
      }
      if (p.finishReason) turn.finishReason = p.finishReason;
      break;
    }

    // ── Terminal ────────────────────────────────────────────────────
    case 'finish': {
      if (p.finishReason) turn.finishReason = p.finishReason;
      // totalUsage is the MAIN stream's accumulated usage (not sub-agents).
      // Use it as the authoritative turn.usage, overriding the sub-agent-
      // inflated accumulateUsage total. Also use it as a lastStepUsage
      // fallback when finish-step didn't fire on the final step (some
      // providers skip the last finish-step and go straight to finish).
      if (p.totalUsage) {
        const finishUsage = sdkUsageToTide(p.totalUsage as LanguageModelUsage, modelEntry, turn.usage.calls || 1);
        turn.usage = finishUsage;
        if (!turn.lastStepUsage) {
          turn.lastStepUsage = finishUsage;
        }
      }
      break;
    }

    case 'abort': {
      // controller.abort() surfaced through the stream. The runSdkTurn catch
      // flushes turn_end with stopReason 'aborted'; just flag it.
      turn.controller.abort();
      break;
    }

    case 'error': {
      // A non-fatal stream error part: the stream keeps going (fatal errors
      // throw out of the loop and hit runSdkTurn's catch). Record it AND
      // surface it immediately — without this emit, the renderer would never
      // see mid-stream errors and they'd vanish into a silent turn_end.
      let msg = errMessage(p.error) || 'Stream error';
      // The SDK's generic "No output generated" fires when the provider
      // returned an empty stream — most often a rejected option (thinking,
      // max_tokens) or an unsupported model id. Make it actionable instead
      // of opaque. (The diagnostic fetch logs the exact request/response.)
      if (/no output generated/i.test(msg)) {
        msg +=
          ' (provider returned an empty stream — usually a rejected option like `thinking` or an oversized `max_tokens`, or an unknown model id. ' +
          'Check the `[agent-sdk] →` request summary and `<-` response line; if thinking is on, try thinking=off or a lower level.)';
      }
      turn.errored = msg;
      send(wc, sessionId, {
        type: 'error',
        sessionId,
        seq: nextSeq(sessionId),
        message: msg,
      });
      break;
    }

    // start, start-step, text-start/end, reasoning-start/end, tool-input-end,
    // source, file, raw, message-metadata, custom: no renderer action yet.
    default:
      break;
  }
}

// ─── turn_end assembly ───────────────────────────────────────────────

/** Map the observed stream state to Tide's stopReason vocabulary. */
function stopReasonFor(turn: SdkTurn): TurnEndStopReason {
  if (turn.controller.signal.aborted) return 'aborted';
  if (turn.stepsCompleted >= turn.maxSteps) return 'iteration_limit';
  switch (turn.finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content-filter':
      return 'content_filter';
    case 'tool-calls':
      // The model's last step ended on tool calls but the SDK didn't loop
      // again (unusual without a cap). Treat as end_turn for rendering.
      return 'end_turn';
    case 'error':
      return turn.errored ? 'refusal' : 'end_turn';
    default:
      return 'end_turn';
  }
}
type TurnEndStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'content_filter'
  | 'iteration_limit'
  | 'aborted'
  | 'refusal';

/** Build the Block[] for turn_end and ship it. Marks trailing text as the
 *  answer (text after the last tool call) — same rule as the legacy loop. */
function emitTurnEnd(wc: WebContents, turn: SdkTurn, stopReason: TurnEndStopReason) {
  const blocks = finalizeBlocks(turn, stopReason);

  send(wc, turn.sessionId, {
    type: 'turn_end',
    sessionId: turn.sessionId,
    seq: nextSeq(turn.sessionId),
    messageId: turn.messageId,
    stopReason,
    content: turn.finalText,
    timeline: turn.timeline.filter((e) => e.type === 'tool' || e.text.trim()),
    blocks,
    reasoning: turn.finalReasoning || undefined,
    reasoningTokens: turn.usage.reasoningTokens || undefined,
    toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
    usage: turn.usage,
    // The last step's actual usage — what the model's most recent request
    // consumed. The context meter reads this instead of the accumulated
    // turn.usage to avoid showing 200%+ on multi-step turns.
    lastStepUsage: turn.lastStepUsage ?? undefined,
  });

  // ── OS Notification ──
  // Fire when the window is NOT focused (user is away) and notifications are
  // enabled. Skips aborted turns (user-initiated stop — no point notifying).
  fireTurnEndNotification(wc, turn.sessionId, stopReason);
}

/** Fire an OS notification on turn completion if the user has enabled it
 *  and the Tide window isn't focused (no point notifying an active user).
 *  On click, shows the window and tells the renderer to switch to the
 *  session that completed. */
function fireTurnEndNotification(wc: WebContents, sessionId: string, stopReason: TurnEndStopReason) {
  const win = BrowserWindow.fromWebContents(wc);
  log.info('fireTurnEndNotification', {
    stopReason,
    sessionId,
    hasWin: !!win,
    focused: win?.isFocused(),
    visible: win?.isVisible(),
    minimized: win?.isMinimized(),
    supported: Notification.isSupported(),
  });
  if (stopReason === 'aborted') return;
  if (win?.isFocused()) return;
  if (!Notification.isSupported()) return;

  try {
    const cfgStore = createConfigStore(appDataDir());
    const gs = cfgStore.getGeneralSettings();
    if (!gs.notifications) {
      log.debug('notification skipped: disabled in settings');
      return;
    }

    const title =
      stopReason === 'refusal' ? 'Tide — turn failed'
      : stopReason === 'max_tokens' ? 'Tide — context limit reached'
      : stopReason === 'iteration_limit' ? 'Tide — step limit reached'
      : 'Tide — done';
    const body =
      stopReason === 'refusal' ? 'The turn ended with an error.'
      : stopReason === 'max_tokens' ? 'The model hit the token limit.'
      : stopReason === 'iteration_limit' ? 'The agent reached the step cap.'
      : 'Your request has completed.';

    // Try native Notification first. On macOS dev builds, this can fail
    // because the "Electron" bundle isn't code-signed/registered for
    // notifications. Fall back to `osascript display notification` which
    // works on every macOS without signing.
    const notif = new Notification({ title, body, silent: false });
    let nativeFailed = false;
    notif.on('click', () => {
      win?.show();
      win?.focus();
      if (!wc.isDestroyed()) {
        wc.send('tide:navigateToSession', sessionId);
      }
    });
    notif.on('failed', () => {
      nativeFailed = true;
      // Fallback: osascript works without code signing on macOS.
      if (process.platform === 'darwin') {
        execFile('osascript', ['-e', `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`], (err) => {
          if (err) {
            log.warn('notification fallback (osascript) also failed', { error: String(err) });
          } else {
            log.info('notification shown via osascript fallback', { title });
          }
        });
      } else {
        log.warn('notification failed (no fallback on this platform)', { title });
      }
    });
    notif.show();
    // Give native a brief moment — if it doesn't fail, skip the log below.
    setTimeout(() => {
      if (!nativeFailed) {
        log.info('notification shown (native)', { title, sessionId });
      }
    }, 100);
  } catch (e) {
    log.warn('notification error', { error: String(e) });
  }
}

/**
 * Finalize the block list at turn_end: abort still-running tools if the turn
 * was aborted, and mark trailing text blocks as the answer. Mirrors the
 * legacy orchestrator's finalizeBlocks (the rule the deriveView pure
 * function in Phase 4 will eventually own).
 *
 * The answer phase begins after the LAST tool call. Text before is narration
 * ("let me check…"); text after is the deliverable. Treating every tool
 * block as the bound — with no skip-set taxonomy — handles bookkeeping
 * (todo_write), yields (ask_followup_question), and real actions uniformly.
 */
function finalizeBlocks(turn: SdkTurn, stopReason: TurnEndStopReason): Block[] {
  const stopped = stopReason === 'aborted';
  const blocks: Block[] = turn.blocks.map((b) => {
    if (stopped && b.kind === 'tool' && (b.status === 'running' || b.status === 'pending')) {
      return { ...b, status: 'aborted' as const };
    }
    return b;
  });

  let lastToolIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'tool') {
      lastToolIdx = i;
      break;
    }
  }
  for (let i = lastToolIdx + 1; i < blocks.length; i++) {
    if (blocks[i].kind === 'text') (blocks[i] as TextBlock).isAnswer = true;
  }
  return blocks;
}

/** Patch a tool block in the mirror (no-op if it isn't tracked). */
function patchToolBlock(turn: SdkTurn, toolCallId: string, patch: Partial<ToolBlock>): void {
  const idx = turn.toolBlockIndex[toolCallId];
  if (idx == null) return;
  const cur = turn.blocks[idx];
  if (!cur || cur.kind !== 'tool') return;
  Object.assign(cur, patch);
}

// ─── Tool → legacy event bridge (the ctx.emit translator) ───────────

/**
 * Tools emit PartEvent-shaped objects via ctx.emit (see withPermission's
 * `ctx.emit({ type: 'permission', ... })`). This bridge translates those
 * into the legacy AgentEvents the current renderer consumes. Dormant until
 * Task 3.2 puts withPermission inside each execute — but ready for it.
 */
function bridgeToolEmit(wc: WebContents, turn: SdkTurn, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const e = raw as { type?: string; [k: string]: unknown };
  const { sessionId } = turn;

  if (e.type === 'permission') {
    const toolName = resolveToolName((e.toolName as string) ?? 'unknown') as ToolName;
    const args = (e.args ?? {}) as Record<string, unknown>;
    // withPermission sends the gate decision so the UI can render 'ask'
    // (approvable) vs 'blocked' (plan-mode: only escalation proceeds).
    const decision: 'ask' | 'blocked' = e.decision === 'blocked' ? 'blocked' : 'ask';
    const meta = safeMeta(toolName);
    // Real toolCallId (threaded via AsyncLocalStorage in buildToolset) — matches
    // the inline tool block so the card can render on it. Fallback only if the
    // context wasn't set (legacy/defensive).
    const toolCallId =
      (typeof e.toolCallId === 'string' && e.toolCallId) || `perm_${toolName}_${nextSeq(sessionId)}`;
    const tc: ToolCall = {
      id: toolCallId,
      messageId: turn.messageId,
      toolName,
      arguments: args,
      argPreview: formatArgPreview(toolName, args),
      status: 'pending',
      riskTier: meta?.riskTier ?? 'read_only',
      gateDecision: decision,
    };
    send(wc, sessionId, {
      type: 'permission_required',
      sessionId,
      seq: nextSeq(sessionId),
      toolCalls: [tc],
      timeoutAt: Date.now() + turn.permissionTimeoutMs,
    });
    return;
  }

  if (e.type === 'followup') {
    // ask_followup_question's awaiting execute emits this; the renderer
    // shows the popup and resolves via submitFollowup → resolveFollowup.
    send(wc, sessionId, {
      type: 'followup_required',
      sessionId,
      seq: nextSeq(sessionId),
      toolCallId: (e.toolCallId as string) ?? '',
      question: (e.question as string) ?? '',
      options: (e.options as string[]) ?? [],
      multiple: (e.multiple as boolean) ?? false,
    });
    return;
  }

  // Unknown part-event shapes have no legacy equivalent yet — drop silently.
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Convert a TurnMessage to an SDK ModelMessage (system extracted separately). */
function toCoreMessage(m: TurnMessage): ModelMessage | null {
  if (m.role === 'system') return null;
  if (m.role === 'user') {
    if (!m.attachments || m.attachments.length === 0) {
      return { role: 'user', content: m.content };
    }
    // Expand attachments into their own text blocks so the model sees each
    // as a discrete chunk (same UX as the legacy userContent helper).
    const parts: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: m.content }];
    for (const a of m.attachments) {
      if (a.kind === 'image') {
        parts.push({ type: 'text', text: `[Attached image: ${a.path}]` });
        continue;
      }
      const header = `--- ${a.path}${a.truncated ? ' (truncated)' : ''} ---`;
      parts.push({ type: 'text', text: `${header}\n${a.content ?? '(empty)'}` });
    }
    return { role: 'user', content: parts };
  }
  return { role: 'assistant', content: m.content };
}

/**
 * Execute skill invocations for any `[[LOAD_SKILL:<path>|<name>]]` markers —
 * BEFORE the model generates. For each marker:
 *
 *   1. Reads the SKILL.md via `runLoadSkill` (read_file's logic + skill-root
 *      allowlist).
 *   2. Emits the FULL tool lifecycle (start → call → executing → result) so
 *      the renderer shows a visible `load_skill` tool card.
 *   3. Adds the call to `turn.toolCalls` + `turn.blocks` so it persists on
 *      turn_end.
 *   4. Strips the marker from the user message and returns the skill body
 *      wrapped in a process-enforcement directive (for system-prompt injection
 *      by the caller).
 *
 * The caller appends the returned `skillBody` to the system prompt — NOT the
 * user message. System-prompt placement gives the skill's process higher
 * instruction priority than a user-message directive, which GLM-5.2 was
 * ignoring. The model retains full tool access so process skills that need
 * to explore the project or write files (brainstorming, TDD, etc.) work.
 *
 * Returns `{ text, skillBody }`: the cleaned user text (marker removed) and
 * the accumulated skill bodies for system-prompt injection.
 */
// ─── Skill pipeline: marker processing + sticky ref + discovery index ──
//
// Three helpers below (`processSkillMarkers`, `applyStickySkillRef`,
// `injectSkillDiscoveryIndex`) keep the runSdkTurn container readable. Each
// owns ONE concern; runSdkTurn just calls them in order with the shared
// `turnController` + `systemPrompt` state.
//
// Data flow:
//
//   processSkillMarkers → { skillBodies, loaded, turnController.skill }
//                              ↓
//   applyStickySkillRef  → mutates skillBodies + turnController.skill
//                          (re-inject on continuation OR clear on new /cmd)
//                              ↓
//   injectSkillDiscoveryIndex → mutates systemPrompt with the available list

/** Sticky skill reference persisted across turns on the session. */
type SkillRef = { name: string; path: string; loadedAt: string };

/**
 * Process `[[LOAD_SKILL:path|name]]` markers across all user messages.
 * - Pre-reads each skill body via runLoadSkill.
 * - Emits the synthetic tool lifecycle (visible load_skill card in the UI).
 * - Populates `turnController.skill` (checklist + allowedTools).
 * - Strips the marker from the persisted message.
 *
 * Returns the accumulated bodies + the list of freshly-loaded refs (which the
 * caller persists as a sticky ref so continuation turns re-inject the body).
 */
async function processSkillMarkers(
  wc: WebContents,
  turn: SdkTurn,
  convo: ModelMessage[],
  root: string,
  turnController: TurnController,
): Promise<{ skillBodies: string; loaded: Array<{ name: string; path: string }> }> {
  let skillBodies = '';
  const loaded: Array<{ name: string; path: string }> = [];
  for (const msg of convo) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      const r = await executeSkillLoads(wc, turn, msg.content, root, turnController);
      msg.content = r.text;
      skillBodies += r.skillBody;
      loaded.push(...r.loaded);
    } else if (Array.isArray(msg.content) && msg.content[0]?.type === 'text') {
      // Attachment-bearing user messages are arrays (toCoreMessage expands
      // attachments into text parts). The marker lives in parts[0].text.
      const first = msg.content[0] as { type: 'text'; text: string };
      const r = await executeSkillLoads(wc, turn, first.text, root, turnController);
      first.text = r.text;
      skillBodies += r.skillBody;
      loaded.push(...r.loaded);
    }
  }
  return { skillBodies, loaded };
}

/**
 * Resolve the sticky skill ref for this turn. Three cases:
 *
 *   1. NEW marker processed → persist/replace (last-loaded wins).
 *   2. NO marker + priorRef exists + latest user msg isn't a slash command →
 *      re-read body from disk + populate turnController (continuation turn).
 *   3. NO marker + priorRef exists + user typed `/something-else` → clear.
 *
 * Case 2 is the bug fix for sessions like s_nn5dweps where skill context
 * vanished after turn 1. Mutates `skillBodies` in place when re-injecting.
 *
 * Returns the effective activeSkillRef for this turn (used by the discovery
 * index to filter the entry whose body is already in context).
 */
async function applyStickySkillRef(
  sessionId: string,
  convo: ModelMessage[],
  root: string,
  loadedThisTurn: Array<{ name: string; path: string }>,
  priorSkillRef: SkillRef | undefined,
  turnController: TurnController,
  skillBodies: { value: string }, // boxed so the helper can append
): Promise<SkillRef | undefined> {
  // Case 1: persist/replace.
  if (loadedThisTurn.length > 0) {
    const last = loadedThisTurn[loadedThisTurn.length - 1];
    const ref: SkillRef = { name: last.name, path: last.path, loadedAt: new Date().toISOString() };
    try { sessions.setActiveSkillRef(sessionId, ref); } catch { /* session module unavailable */ }
    return ref;
  }

  if (!priorSkillRef) return undefined;

  // Latest user message drives the keep-vs-clear decision.
  const lastUserMsg = [...convo].reverse().find((m) => m.role === 'user');
  const lastUserText =
    typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content) && lastUserMsg?.content[0]?.type === 'text'
        ? (lastUserMsg.content[0] as { type: 'text'; text: string }).text
        : '';

  // Case 3: user issued a different slash command → clear.
  if (/^\s*\/[a-zA-Z0-9_-]+/.test(lastUserText)) {
    try { sessions.setActiveSkillRef(sessionId, undefined); } catch { /* ignore */ }
    log.info('skill: cleared sticky ref — user issued a different slash command', {
      skill: priorSkillRef.name,
    });
    return undefined;
  }

  // Case 2: continuation turn → re-inject from disk.
  try {
    const res = await runLoadSkill(priorSkillRef.path, root);
    if (res.status !== 'executed' || !res.display || res.display.kind !== 'file_loaded') {
      return undefined;
    }
    skillBodies.value +=
      `\n--- ACTIVE SKILL: ${priorSkillRef.name} (continued) ---\n` +
      `You are continuing the "${priorSkillRef.name}" skill from a prior turn. ` +
      `It is still your active process — keep following it. Do not restart ` +
      `from the beginning; pick up where the last turn ended and continue ` +
      `the next remaining step.\n\n` +
      res.display.body +
      `\n--- END SKILL: ${priorSkillRef.name} ---\n`;
    // Re-populate the turn controller so the premature-stop correction
    // loop + activeToolSet still apply on continuation turns.
    if (!turnController.skill) {
      const { checklist, allowedTools } = parseSkillMetadata(res.display.body);
      turnController.skill = {
        name: priorSkillRef.name,
        body: res.display.body,
        checklist,
        completedSteps: new Set<number>(),
        activeToolSet: allowedTools,
      };
    }
    log.info('skill: re-injected sticky skill from disk (continuation turn)', {
      skill: priorSkillRef.name,
    });
    return priorSkillRef;
  } catch (e: any) {
    // File deleted/renamed since turn 1. Clear so we don't keep retrying.
    log.warn('skill: sticky ref failed to re-load — clearing', {
      skill: priorSkillRef.name,
      err: e?.message ?? e,
    });
    try { sessions.setActiveSkillRef(sessionId, undefined); } catch { /* ignore */ }
    return undefined;
  }
}

/**
 * Inject the accumulated skill bodies into the TOP of the system prompt
 * (right after the identity line). Models weight the beginning of the
 * system prompt highest; a skill buried after 4000+ words of tool docs gets
 * deprioritized. The bodies are already wrapped with ACTIVE SKILL directives.
 */
function injectSkillBodies(systemPrompt: string, skillBodies: string): string {
  if (!skillBodies) return systemPrompt;
  const identityEnd = systemPrompt.indexOf('\n#');
  if (identityEnd > 0) {
    return systemPrompt.slice(0, identityEnd) + `\n${skillBodies}\n` + systemPrompt.slice(identityEnd);
  }
  return `${skillBodies}\n${systemPrompt}`;
}

/**
 * Inject a compact `# Available Skills` index into the system prompt so the
 * model can autonomously call `load_skill({path})` when the user's request
 * matches a skill they didn't explicitly invoke. Always present (even when a
 * skill is active) so the model can chain to follow-up skills mid-turn.
 *
 * The active skill's entry is filtered out — its body is already in context.
 * Best-effort: if the scan fails, the system prompt is unchanged.
 */
function injectSkillDiscoveryIndex(
  systemPrompt: string,
  root: string,
  activeSkillPath?: string,
  disabledSkills: string[] = [],
): string {
  let entries;
  try {
    entries = scanProjectEntries(root);
  } catch (e: any) {
    log.warn('skill index: scan failed', { err: e?.message ?? e });
    return systemPrompt;
  }
  const indexEntries = entries.skills.filter(
    (s) => s.absPath !== activeSkillPath && !disabledSkills.includes(s.name),
  );
  if (indexEntries.length === 0) return systemPrompt;

  const lines = indexEntries.map((s) => `- ${s.name} — ${s.description} (path: ${s.absPath})`);
  const skillIndex =
    `\n\n# Available Skills\n` +
    `These skills are installed in this workspace or user directory. When the ` +
    `user's request matches a skill's purpose, invoke it by calling the ` +
    `\`load_skill\` tool with the skill's \`path\`. The skill body becomes ` +
    `your authoritative process — follow it step by step.\n` +
    lines.join('\n');

  const identityEnd = systemPrompt.indexOf('\n#');
  if (identityEnd > 0) {
    return systemPrompt.slice(0, identityEnd) + `${skillIndex}\n` + systemPrompt.slice(identityEnd);
  }
  return `${skillIndex}\n${systemPrompt}`;
}

/**
 * Inject a generic skill-chaining directive.
 *
 * When an active skill is in context, ALWAYS surface every OTHER installed
 * skill as a chainable follow-up — no regex parsing of the active skill body,
 * no keyword matching against the user message. The model decides when to
 * chain; our job is to make sure it (a) knows what's available and (b) knows
 * it MUST actually invoke load_skill rather than improvising from memory.
 *
 * Why not detect "Use <name>" patterns in the active skill body? Because
 * skills reference follow-ups in too many forms to match reliably — prose,
 * headings, code comments, frontmatter, etc. A general directive is both
 * simpler and more robust: every installed skill shows up, and the model
 * picks based on its read of the active skill's intent + the user's request.
 *
 * Why this matters: without it, models claim "I'm using the X skill" while
 * never actually calling load_skill — they write from training data, the
 * activeSkillRef never transitions, and the active skill's checklist step
 * stays open forever. (Root cause of session s_uo6j1v8p.)
 *
 * No-op when there's no active skill OR no other installed skills to chain to.
 * Best-effort: if the scan fails, the system prompt is unchanged.
 */
function injectSkillChainingReminder(
  systemPrompt: string,
  root: string,
  turnController: TurnController,
  disabledSkills: string[] = [],
): string {
  const activeSkill = turnController.skill;
  if (!activeSkill) return systemPrompt;

  // Surface every installed skill EXCEPT the active one AND any the user has
  // disabled via Settings → Extensions. The active one's body is already in
  // context; disabled ones shouldn't be suggested as chain targets.
  let entries;
  try {
    entries = scanProjectEntries(root).skills;
  } catch (e: any) {
    log.warn('skill chain: scan failed', { err: e?.message ?? e });
    return systemPrompt;
  }
  const chainable = entries.filter(
    (s) => s.name !== activeSkill.name && !disabledSkills.includes(s.name),
  );
  if (chainable.length === 0) return systemPrompt;

  const lines = chainable.map((s) => `- ${s.name} — ${s.description} (path: ${s.absPath})`);
  const reminder =
    `\n\n# Skill chaining (CRITICAL)\n` +
    `You are executing "${activeSkill.name}". When its process directs you to a ` +
    `follow-up skill — OR the user's request shifts to work that another ` +
    `installed skill covers — you MUST actually invoke \`load_skill\` with the ` +
    `skill's \`path\`. Do NOT claim to follow a skill from memory: the loaded ` +
    `body becomes your authoritative process for that phase, and claiming ` +
    `without loading leaves the active skill's checklist open.\n\n` +
    `Other installed skills you may chain to:\n` +
    lines.join('\n');

  const identityEnd = systemPrompt.indexOf('\n#');
  if (identityEnd > 0) {
    return systemPrompt.slice(0, identityEnd) + `${reminder}\n` + systemPrompt.slice(identityEnd);
  }
  return `${reminder}\n${systemPrompt}`;
}

async function executeSkillLoads(
  wc: WebContents,
  turn: SdkTurn,
  text: string,
  workspaceRoot: string,
  ctrl: TurnController,
): Promise<{ text: string; skillBody: string; loaded: Array<{ name: string; path: string }> }> {
  const re = /\[\[LOAD_SKILL:([^|\]]+)\|([^\]]+)\]\]/g;
  let cleaned = text;
  let skillBody = '';
  const loaded: Array<{ name: string; path: string }> = [];
  let m: RegExpExecArray | null;
  const { sessionId } = turn;

  while ((m = re.exec(text)) !== null) {
    const filePath = m[1];
    const skillName = m[2];
    const toolCallId = `skill_${skillName}_${Date.now().toString(36)}`;
    const meta = safeMeta('load_skill');
    const argPreview = skillName;
    const start = Date.now();

    // ── Block bookkeeping (mirrors translatePart's tool-call handling) ──
    turn.toolBlockIndex[toolCallId] = turn.blocks.length;
    const block: ToolBlock = {
      id: toolCallId,
      kind: 'tool',
      toolCallId,
      toolName: 'load_skill',
      category: categorizeTool('load_skill'),
      status: 'pending',
      arguments: { path: filePath },
      argPreview,
      riskTier: meta?.riskTier ?? 'read_only',
      createdAtSeq: 0,
      modifiedAtSeq: 0,
    };
    turn.blocks.push(block);

    // ── Emit the synthetic tool lifecycle ──
    send(wc, sessionId, {
      type: 'tool_call_start', sessionId, seq: nextSeq(sessionId),
      messageId: turn.messageId, toolCallId, toolName: 'load_skill', blockId: toolCallId,
    });
    send(wc, sessionId, {
      type: 'tool_call', sessionId, seq: nextSeq(sessionId),
      messageId: turn.messageId, toolCallId, toolName: 'load_skill',
      arguments: { path: filePath }, argPreview, riskTier: meta?.riskTier ?? 'read_only',
    });
    send(wc, sessionId, {
      type: 'tool_executing', sessionId, seq: nextSeq(sessionId), toolCallId,
    });
    Object.assign(block, { status: 'running' });

    // ── Read the skill file ──
    const res = await runLoadSkill(filePath, workspaceRoot);
    const durationMs = Date.now() - start;
    const status = res.status === 'executed' ? 'executed' : 'failed';
    log.info('skill loaded', { skill: skillName, path: filePath, status: res.status, durationMs });

    // ── Emit the result ──
    send(wc, sessionId, {
      type: 'tool_result', sessionId, seq: nextSeq(sessionId),
      toolCallId, status, output: res.output, display: res.display,
      durationMs, meta: res.meta,
    });
    Object.assign(block, {
      status, output: res.output, display: res.display, durationMs, meta: res.meta,
    });

    // ── Add to turn.toolCalls for persistence ──
    turn.toolCalls.push({
      id: toolCallId, messageId: turn.messageId, toolName: 'load_skill',
      arguments: { path: filePath }, argPreview, status, riskTier: 'read_only',
      output: res.output, display: res.display, durationMs, meta: res.meta,
    });

    // ── Strip the marker from the user message ──
    cleaned = cleaned.replace(m[0], '').trim();
    // If the marker was the entire message (e.g. bare `/skill-name` with no
    // task text), the user message is now empty — GLM rejects empty user
    // turns with "The prompt parameter was not received normally". Leave a
    // minimal directive so the model knows to begin the skill's process.
    if (!cleaned) {
      cleaned = `(The user invoked the "${skillName}" skill with no additional task. ` +
        `Begin following the skill's process now.)`;
    }

    // ── Collect the body for system-prompt injection ──
    if (res.status === 'executed' && res.display && res.display.kind === 'file_loaded') {
      skillBody +=
        `\n--- ACTIVE SKILL: ${skillName} ---\n` +
        `The user invoked the "${skillName}" skill. You are now EXECUTING this ` +
        `skill — it is not a reference, it is your process. Follow it to ` +
        `completion: every step, gate, and checklist item in order, including ` +
        `post-output steps like committing, self-review, user gates, and ` +
        `transitioning to follow-up skills. Do not stop early or hand off ` +
        `before the skill's full process is done.\n\n` +
        res.display.body +
        `\n--- END SKILL: ${skillName} ---\n`;

      // Track successfully loaded skills so the caller can persist them as a
      // sticky ref on the session. The ref lets continuation turns re-inject
      // the body without requiring the user to re-invoke the slash command.
      loaded.push({ name: skillName, path: filePath });

      // ── Populate the turn controller for between-step gating ──
      // Parse the skill body for checklist items + allowed-tools, then set
      // ctrl.skill so prepareStep/onStepEnd can gate the model's progress.
      if (!ctrl.skill) {
        const { checklist, allowedTools } = parseSkillMetadata(res.display.body);
        ctrl.skill = {
          name: skillName,
          body: res.display.body,
          checklist,
          completedSteps: new Set<number>(),
          activeToolSet: allowedTools,
        };
        log.info('skill controller configured', {
          skill: skillName,
          checklist: checklist.length,
          restrictedTools: allowedTools ? allowedTools.length : null,
        });
      }
    } else {
      skillBody += `\n(Skill "${skillName}" failed to load: ${res.output})\n`;
    }
  }

  return { text: cleaned, skillBody, loaded };
}

/** Resolve a thinking level into an Anthropic thinking payload, or null when off. */
function thinkingPayload(
  level: string,
): { type: 'enabled'; budgetTokens: number } | null {
  if (level === 'off') return null;
  const budgetTokens = THINKING_BUDGET[level] ?? THINKING_BUDGET.medium;
  return { type: 'enabled', budgetTokens };
}

/** ToolResult status → Tide ToolCallStatus. Coalesces SDK-foreign values. */
function normalizeStatus(s: string | undefined): ToolCall['status'] {
  switch (s) {
    case 'executed':
    case 'failed':
    case 'rejected':
    case 'timeout':
      return s;
    case 'aborted':
      return 'aborted';
    default:
      return s ? 'executed' : 'pending';
  }
}

/** getToolMeta that returns undefined for unknown names (dynamic/MCP tools)
 *  instead of throwing — the orchestrator degrades to read-only defaults. */
function safeMeta(name: string) {
  try {
    return getToolMeta(name as ToolName);
  } catch {
    return undefined;
  }
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningTokens: 0,
    calls: 0,
    costUsd: 0,
  };
}

/** Sum the SDK's per-step usage into the turn aggregate (Slice C). */
function accumulateUsage(turn: SdkTurn, delta: Usage): void {
  turn.usage.inputTokens += delta.inputTokens || 0;
  turn.usage.outputTokens += delta.outputTokens || 0;
  turn.usage.cacheRead += delta.cacheRead || 0;
  turn.usage.cacheWrite += delta.cacheWrite || 0;
  turn.usage.reasoningTokens += delta.reasoningTokens || 0;
  turn.usage.calls += delta.calls || 1;
  turn.usage.costUsd += delta.costUsd || 0;
}

/** Per-token pricing rates for cost calculation. */
interface PricingRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Compute USD cost from token counts × per-token rates.
 *  Cost = (non-cached input × input rate) + (output × output rate)
 *       + (cache read × cache-read rate) + (cache write × cache-write rate).
 *  Cache-read tokens are billed at their own (lower) rate; non-cached input
 *  tokens are billed at the full input rate. */
function computeCost(u: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheRead' | 'cacheWrite'>, r: PricingRates): number {
  const nonCachedInput = Math.max(0, (u.inputTokens || 0) - (u.cacheRead || 0));
  return (
    nonCachedInput * r.input +
    (u.outputTokens || 0) * r.output +
    (u.cacheRead || 0) * r.cacheRead +
    (u.cacheWrite || 0) * r.cacheWrite
  );
}

/** Map the SDK's LanguageModelUsage (nested token-detail shape) onto Tide's
 *  flat Usage. The SDK splits cache + reasoning into detail sub-objects;
 *  Tide's Usage keeps them flat for the context-window meter. Computes cost
 *  from the model's persisted per-token rates. */
function sdkUsageToTide(
  u: LanguageModelUsage,
  modelEntry: { inputCostPerToken?: number; outputCostPerToken?: number; cacheReadCostPerToken?: number; cacheWriteCostPerToken?: number } | undefined,
  calls = 1,
): Usage {
  const usage = {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheRead: u.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0,
    calls,
  };
  const rates: PricingRates = {
    input: modelEntry?.inputCostPerToken ?? 0,
    output: modelEntry?.outputCostPerToken ?? 0,
    cacheRead: modelEntry?.cacheReadCostPerToken ?? 0,
    cacheWrite: modelEntry?.cacheWriteCostPerToken ?? 0,
  };
  return { ...usage, costUsd: computeCost(usage, rates) };
}

function errMessage(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** True if an error is a timeout (from an external timeout/abort). */
function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError';
}
