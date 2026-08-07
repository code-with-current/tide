/** Orchestrator — SDK-driven agent loop (Phase 3 Task 3.4). Replaces the hand-rolled loop with a single Vercel AI SDK `streamText` call: the SDK owns model↔tool round-tripping; Tide owns rendering + consent. Emits the legacy `AgentEvent` stream during Phase 3; Phase 4 swaps the payload to `PartEvent`. Active when `USE_SDK_ORCHESTRATOR` is set (legacy orchestrator.ts stays as fallback). Plan slices A–E in docs/plans/2026-07-22-vercel-ai-sdk-migration.md §3.4. */

import { streamText, isStepCount } from 'ai';
// v7 renamed CoreMessage → ModelMessage. ResponseMessage isn't re-exported, so runStream returns ModelMessage[].
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

/** Tide thinking level → Anthropic `providerOptions.anthropic.thinking.budgetTokens`. Same levels as the legacy orchestrator; the SDK spells the field `budgetTokens`. */
const THINKING_BUDGET: Record<string, number> = {
  low: 1_024,
  medium: 8_000,
  high: 24_000,
  extra: 48_000,
  max: 64_000,
};

/** Output-token escalation + resume on `finishReason='length'`. Tier 1: retry at ESCALATED_MAX_TOKENS (cheaper than a correction turn). Tier 2: inject a "resume" user message (see RESUME_MESSAGE), capped at MAX_RESUME_ATTEMPTS. Other finish reasons take their natural paths. */
const ESCALATED_MAX_TOKENS = 65_535; // 2^16-1 — Gemini's hard cap; safe everywhere.
const MAX_RESUME_ATTEMPTS = 3;

/** Turn-level retry for transient provider errors (network, 5xx, empty stream) — not retried by the SDK (`maxRetries:0`); surfaced to the UI as "Retrying 1/3…". Aborts and permission errors skip this loop. */
const TURN_MAX_RETRIES = 2; // 1 initial call + 2 retries = 3 total attempts

/** The exact wording Claude Code uses to resume after a max-output-tokens hit. Every clause is load-bearing ("no apology, no recap" suppresses the model's preamble). */
const RESUME_MESSAGE =
  'Output token limit hit. Resume directly — no apology, no recap of what you ' +
  'were doing. Pick up mid-thought if that is where the cut happened. Break ' +
  'remaining work into smaller pieces.';

// ─── Per-turn live state ─────────────────────────────────────────────
// Block bookkeeping mirrors the legacy ActiveTurn so the existing renderer (Block[]) keeps working — the "temporary parts→blocks adapter" (Slice A), removed in Phase 4 Task 4.4.

/** Ordered timeline entry — text segment or tool-call reference. Module-scope because Rolldown dislikes inline types inside function bodies. */
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
  /** Open text block id, or null when the next delta should open a fresh one. */
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
  /** The LAST MAIN-STEP's usage only (not accumulated). The context-window meter reads this. */
  lastStepUsage: Usage | null;
  /** finish-step parts observed — detects the step-cap (Slice E). */
  stepsCompleted: number;
  /** Effective per-turn step cap. Snapshotted at turn start so module-level helpers can read it. */
  maxSteps: number;
  /** Effective per-turn permission prompt timeout in ms. Same snapshot rationale as maxSteps. */
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

/** Abort all active turns and persist their partial state. Called on app quit so in-progress responses aren't lost. */
export function abortAllTurns(): void {
  for (const [sessionId, turn] of activeTurns) {
    try {
      turn.controller.abort();
      // Persist the partial assistant message directly to the session store
      // (the renderer's freeze effect won't run — the app is quitting).
      const blocks = finalizeBlocks(turn, 'aborted');
      const { addAssistantMessage, addUsage } = require('../ipc/sessions.js') as typeof import('../ipc/sessions.js');
      addAssistantMessage(sessionId, {
        content: turn.finalText || '',
        blocks,
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
      log.warn('abortAllTurns: failed to persist partial turn', { sessionId, err: e instanceof Error ? e.message : String(e) });
    }
  }
  activeTurns.clear();
}

// ─── Per-session sequence counter (mirrors legacy orchestrator) ──────
const seqCounters = new Map<string, number>();
function nextSeq(sessionId: string): number {
  const n = (seqCounters.get(sessionId) ?? 0) + 1;
  seqCounters.set(sessionId, n);
  return n;
}

// ─── IPC registration (drop-in swap for registerAgentHandlers) ───────

/** Registers the SDK-driven agent commands on the SAME AGENT_COMMANDS the legacy orchestrator uses. ipcMain rejects duplicate handles, so main.ts must call exactly one of {registerAgentHandlers, registerAgentSdkHandlers}. Approval/rejection route through the module-scoped permission-resolver. */

// Active tool contexts by session — lets the renderer push live autonomy-mode changes to a running turn. Registered when a turn starts, cleaned up when it ends.
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
      // "Always Allow" — derive a rule from the approved call, persist to .agent/settings.json (in-memory + file-backed, project-level scope).
      if (remember && toolCallIds[0]) {
        const ask = getPendingAsk(sessionId, toolCallIds[0]);
        if (ask) {
          const spec = addPermissionRule(sessionId, ask.workspaceRoot, ask.toolName, ask.args);
          if (spec) log.info('permission rule added', { tool: ask.toolName, spec });
        }
      }
      // newMode (plan→edit escalation) sticks for the rest of the turn. Also persist to the session record so the next turn starts in the new mode (best-effort, mirrors the legacy orchestrator).
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
  // _sessionId is unused: every AgentEvent carries its own sessionId. Kept in the signature to match the legacy emit() call shape.
  if (!wc.isDestroyed()) wc.send(AGENT_EVENT_CHANNEL, event);
}

// ─── The loop ────────────────────────────────────────────────────────

/** SDK-driven turn entry point. Exported so the IPC handler and regression test can invoke it directly without going through ipcMain. */
export async function runSdkTurn(wc: WebContents, payload: RunTurnPayload) {
  const { sessionId, messages, modelId, providerId, autonomyMode, thinkingLevel } = payload;

  // ── Resolve provider + workspace root ──────────────────────────────
  // Same resolution as the legacy orchestrator: worktree.path → session workspace → default workspace → cwd.
  const providers = store.listProviders();
  let provider = providers.find((p) => p.id === providerId);
  let providerFallback = false;
  // Graceful recovery for orphaned sessions: if the session's provider was deleted, fall back to any enabled provider serving this modelId (unblocks the turn; user can re-bind in the picker).
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
    // Surface the sticky skill ref so the marker loop can decide whether to re-inject the body on this continuation turn.
    priorSkillRef = session?.activeSkillRef;
  } catch {
    // Sessions module may not be loaded in some contexts — fall through.
  }
  workspaceRoot ??= workspaces.find((w) => w.isDefault)?.path ?? workspaces[0]?.path ?? process.cwd();
  // The `??=` chain's final fallback is process.cwd(), so workspaceRoot is always a string here. Bind a typed const so ToolContext (requires `string`) typechecks.
  const root: string = workspaceRoot ?? process.cwd();

  // Liveness check: refuse to start a turn against a missing workspace root (otherwise tools fail inconsistently).
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
  // The first system message becomes the top-level `system` option (Anthropic takes system out-of-band). User messages with attachments expand into multi-part text content.
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

  // Execute skill invocations for any `[[LOAD_SKILL:…]]` markers BEFORE the model thinks: read SKILL.md, emit a visible load_skill card, strip the marker, append the body to the SYSTEM PROMPT (not the user message — GLM-5.2 ignored user-message directives).
  // Create the turn controller — shared between prepareStep + onStepEnd hooks. Set the compaction config's context window from the model's known capability.
  const turnController = createTurnController(effectiveMaxSteps);
  const modelEntry = provider.models.find((m) => m.modelId === modelId);
  const knownCtxWindow = contextWindowSize(modelId, modelEntry);
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
  // processSkillMarkers pre-reads markers + emits tool cards; applyStickySkillRef handles cross-turn lifecycle; injectSkillBodies/injectSkillDiscoveryIndex place bodies + the available-skills list in the system prompt.
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
      `\n\n# ⚡ Codebase recall — ALWAYS START HERE\n` +
      `The \`memory\` tool searches the workspace's semantic index (RAG) and returns ranked code chunks in ~0.5s.\n\n` +
      `MANDATORY: Before using directory_tree, list_dir, read_file, or grep to explore the codebase, ` +
      `you MUST call \`memory\` first with a natural-language query describing what you're looking for. ` +
      `Only fall back to directory_tree/read_file/grep if memory returns no relevant results, or you need ` +
      `the complete file contents (memory returns ~20-line chunks).\n\n` +
      `Examples:\n` +
      `- "How is user authentication handled?" → memory({ query: "user authentication flow" })\n` +
      `- "Where are API routes defined?" → memory({ query: "API route definitions" })\n` +
      `- "How does the database connection work?" → memory({ query: "database connection setup" })`;
  }

  // Context management: prevent premature "start fresh" suggestions.
  // The model (especially GLM-5.2) tends to suggest starting a new session
  // even at 5% context usage. Only suggest forking when context is genuinely
  // full (the auto-compact system handles this — the model should never
  // second-guess context size on its own).
  systemPrompt +=
    `\n\n# Context awareness\n` +
    `Do NOT suggest starting a new session, forking, or "starting fresh" unless the ` +
    `system explicitly tells you the context window is full. The app manages context ` +
    `automatically (auto-compaction + fork). Continue working normally regardless of ` +
    `how many turns have passed. Never mention context limits, token counts, or session ` +
    `length in your responses.`;

  // Resolve the model + thinking budget. `null` budget → thinking disabled. Thinking is also disabled when the model doesn't support reasoning. EXCEPTION: mandatory-reasoning models force a budget even at level 'off'.
  const model = resolveModel(provider, { modelId, contextWindow: 0 } as any);
  const modelSupportsThinking = supportsThinking(modelId, modelEntry);
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

  // The ToolContext closure. ctx.emit is the BRIDGE that turns a tool's PartEvent-shaped emission into the legacy AgentEvent the renderer needs. Dormant until Task 3.2 wires withPermission into each execute.
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
  // Retry transient provider errors up to TURN_MAX_RETRIES times (emits `retry` events for UI). Aborts flush immediately.

  // Periodic flush: save partial state to the session store every 5s during streaming
  // so a crash / force-quit doesn't lose in-progress work. Cleared on turn end.
  const flushTimer = setInterval(() => {
    try {
      const blocks = finalizeBlocks(turn, 'aborted');
      if (turn.finalText || turn.toolCalls.length > 0 || turn.blocks.length > 0) {
        const { updatePartialAssistantMessage } = require('../ipc/sessions.js') as typeof import('../ipc/sessions.js');
        updatePartialAssistantMessage(sessionId, messageId, {
          content: turn.finalText || '',
          blocks,
          reasoning: turn.finalReasoning || undefined,
          toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
          timeline: turn.timeline.filter((e) => e.type === 'tool' || e.text.trim()),
        });
      }
    } catch { /* best-effort — don't crash the stream over a flush */ }
  }, 5_000);

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
    // finishReason='length' = cut off mid-thought. Tier 1: retry at ESCALATED_MAX_TOKENS (same messages, cache warm). Tier 2: inject RESUME_MESSAGE as a user turn (capped at MAX_RESUME_ATTEMPTS). Only on final finishReason='length' with no error/abort.
    let escalated = false; // tier 1 fires at most once per turn
    let resumes = 0;       // tier 2 cap
    while (
      !controller.signal.aborted &&
      !turn.errored &&
      turn.finishReason === 'length' &&
      (resumes < MAX_RESUME_ATTEMPTS || !escalated)
    ) {
      // Tier 1 — escalate (only once).
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
        // Keep the escalated cap so the resumed turn has the same breathing room.
        maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
      });
    }

    // ── Skill premature-stop correction loop ─────────────────────────
    // ── Skill premature-stop correction loop ─────────────────────────
    // onStepEnd stashes a correction when the model stopped mid-skill, but finishReason='stop' is a HARD stop — the SDK won't call prepareStep again. Fix: re-invoke runStream with the correction as a fresh user turn (capped; shared between skill-gate and stop-hook soft blocks).
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
      // Re-entering the stream clears the prior stop reason; reset so the loop re-evaluates cleanly.
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
    // On a step-cap hit (model kept calling tools) with no trailing answer, force one final no-tools wrap-up call. responseMessages are appended so the model can report on its in-progress work.
    const capHit = turn.stepsCompleted >= effectiveMaxSteps;
    const hasAnswer = turn.finalText.trim().length > 0;
    if (capHit && !hasAnswer && !turn.errored && !controller.signal.aborted) {
      log.warn('step cap hit; forcing wrap-up call', { cap: effectiveMaxSteps });
      await runStream(wc, turn, {
        model,
        // Terse wrap-up directive — suppresses the reflexive "Sorry, I'll wrap up…" preamble (same philosophy as RESUME_MESSAGE).
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

  clearInterval(flushTimer);
  activeTurns.delete(sessionId);
  activeCtxs.delete(sessionId);

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

/** Whether the turn controller has a pending correction that should re-enter the stream. Producers: skill gate (premature stop), stop hook (soft block), budget nudge (informational — does NOT re-enter on its own). Only skill-gate and stop-hook corrections force a re-stream. */
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
  /** Override the per-protocol maxOutputTokens resolution. Used by the length-cap escalation path; undefined → default 8192. */
  maxOutputTokensOverride?: number;
}

/** Runs one `streamText` call and translates its stream parts into the legacy AgentEvent stream while maintaining the block mirror. Used for both the primary multi-step call and the forced wrap-up. */
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
    { hasTools, modelId: args.modelId, maxOutputTokens: resolveMaxOutputTokens(args.modelId, args.provider.models.find((m) => m.modelId === args.modelId)), providerBaseUrl: args.provider.baseUrl },
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
    // Some models (GLM, Gemini) leak XML artifacts into JSON tool arguments (e.g. trailing `</tool_call>`). This strips them and returns the cleaned STRING (not a parsed object) — the SDK re-parses via doParseToolCall.
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
    // prepareStep runs before every step: (1) compact context if near the window, (2) inject correction messages from onStepEnd flags, (3) restrict tools per the active skill. All three are combined into one returned object (prior impl early-returned, silently dropping the others).
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
      // Use the LAST step's actual input tokens — each step re-sends the full conversation, so lastStepInputTokens IS the current context size.
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

      // 2. Inject correction if onStepEnd flagged a deviation or budget nudge. Budget nudges ride along here only because prepareStep is the natural injection point inside a running multi-step loop; the post-stream re-entry loop decides whether to start a fresh stream.
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
    // onStepEnd fires after each LLM call + tool execution: (1) track skill checklist progress, (2) detect premature stops, (3) nudge on budget.
    async onStepEnd(step) {
      ctrl.stepCount = step.stepNumber + 1;
      ctrl.budget.inputTokens += step.usage?.inputTokens ?? 0;
      ctrl.budget.outputTokens += step.usage?.outputTokens ?? 0;
      // Track the LAST step's actual input tokens — what the model saw (the full conversation + system prompt). Used by autocompact's threshold check.
      ctrl.budget.lastInputTokens = step.usage?.inputTokens ?? ctrl.budget.lastInputTokens;
      // Capture the MAIN orchestrator's per-step usage as lastStepUsage (the context meter reads this).
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
      // If open todos exist and the model did NOT just call todo_write, inject a reminder naming the next open item. Skip when: errored/abort, finish='stop' (post-stream correction loop handles it), or a skill correction is already pending.
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
      // Run on natural termination (finish='stop'). Skip on wrap-up calls and when stopHookActive is set (prevents infinite re-blocking loops).
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

  // v7 renamed fullStream → stream (the old name is deprecated). Yields text/tool/error parts. Wrap in try/catch — SDK stream finalization can throw on MCP schema mismatches; catching lets the turn end gracefully with partial blocks.
  try {
    for await (const part of result.stream) {
      translatePart(wc, turn, part, modelEntry);
    }
  } catch (streamErr: any) {
    // Log but don't rethrow — partial results are still useful.
    console.warn(`[agent-sdk] stream interrupted: ${streamErr?.message ?? streamErr}`);
    turn.errored = turn.errored ?? streamErr?.message;
  }

  // responseMessages = the assistant + tool turns the model produced this call. Returned so the wrap-up call can seed its conversation with in-progress work.
  try {
    return await result.responseMessages;
  } catch {
    // responseMessages can throw if the stream was interrupted mid-tool-call.
    // Return an empty array so the caller doesn't crash.
    return [];
  }
}

/** The parts→events adapter. Each SDK stream part becomes one or more legacy AgentEvents on `agent:event`, plus a block-mirror mutation shipped on turn_end. Phase 4 swaps this for `useParts` + `deriveView` consuming parts directly. */
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
      // totalUsage is the MAIN stream's accumulated usage (not sub-agents). Use as the authoritative turn.usage, overriding the sub-agent-inflated total. Also a lastStepUsage fallback when the final finish-step was skipped.
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

/** Finalize the block list at turn_end: abort still-running tools if aborted, mark trailing text blocks as the answer (text after the LAST tool call is the deliverable; text before is narration). Mirrors the legacy orchestrator's finalizeBlocks. */
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

/** Tools emit PartEvent-shaped objects via ctx.emit (e.g. withPermission's `{ type: 'permission', ... }`). This bridge translates them into the legacy AgentEvents the renderer consumes. Dormant until Task 3.2. */
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

/** Execute `[[LOAD_SKILL:<path>|<name>]]` markers BEFORE generation: read each SKILL.md, emit the full tool lifecycle (visible load_skill card), add to turn.toolCalls/blocks, strip the marker, return the skill body wrapped in a process-enforcement directive for system-prompt injection. System-prompt placement (not user message) gives the skill higher priority; model keeps full tool access. */
// ─── Skill pipeline: marker processing + sticky ref + discovery index ──
// Three helpers (`processSkillMarkers`, `applyStickySkillRef`, `injectSkillDiscoveryIndex`) keep runSdkTurn readable — each owns one concern, called in order with shared `turnController` + `systemPrompt` state.

/** Sticky skill reference persisted across turns on the session. */
type SkillRef = { name: string; path: string; loadedAt: string };

/** Process `[[LOAD_SKILL:path|name]]` markers across all user messages: pre-read each body via runLoadSkill, emit the synthetic tool lifecycle, populate `turnController.skill`, strip the marker. Returns the accumulated bodies + freshly-loaded refs (persisted as a sticky ref for continuation turns). */
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

/** Resolve the sticky skill ref for this turn. (1) NEW marker → persist/replace. (2) NO marker + priorRef + not a slash command → re-read body + populate turnController (continuation turn; the bug fix for skill context vanishing after turn 1). (3) NO marker + priorRef + user typed `/something-else` → clear. Returns the effective activeSkillRef. */
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

/** Inject the accumulated skill bodies at the TOP of the system prompt (models weight the beginning highest; a skill buried after 4000+ words of tool docs gets deprioritized). Bodies are already wrapped with ACTIVE SKILL directives. */
function injectSkillBodies(systemPrompt: string, skillBodies: string): string {
  if (!skillBodies) return systemPrompt;
  const identityEnd = systemPrompt.indexOf('\n#');
  if (identityEnd > 0) {
    return systemPrompt.slice(0, identityEnd) + `\n${skillBodies}\n` + systemPrompt.slice(identityEnd);
  }
  return `${skillBodies}\n${systemPrompt}`;
}

/** Inject a compact `# Available Skills` index so the model can autonomously call `load_skill({path})` when a request matches a skill the user didn't explicitly invoke. The active skill's entry is filtered out (body already in context). Best-effort. */
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

/** Inject a generic skill-chaining directive: when a skill is active, surface every OTHER installed skill as a chainable follow-up. No regex/keyword matching (skills reference follow-ups in too many forms) — the model picks based on intent. Without this, models claim "I'm using X" while never calling load_skill. No-op with no active skill or no other installed skills. */
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

/** Compute USD cost = (non-cached input × input rate) + (output × output rate) + (cache read × cache-read rate) + (cache write × cache-write rate). */
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
