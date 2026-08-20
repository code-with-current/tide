/** Domain types for Tide. */

// Block types are defined in './block' (which itself imports back from this
// file for FollowupMode/RiskTier/etc.). We pull `Block` in as a local type
// alias up front so the Message/SessionStream shapes below can reference it
// without waiting on the re-export at the bottom of the file.
import type { Block } from './block';

// ============================================================
// Providers & models
// ============================================================

export type ApiStyle = 'openai' | 'anthropic';

/** How a model exposes reasoning control — derived from models.dev's
 *  `reasoning_options` field. A model may support multiple contracts
 *  (e.g. both `effort` and `budget_tokens`); the resolver picks the best
 *  one for the active protocol. */
export type ReasoningContractType = 'effort' | 'budget_tokens' | 'toggle';

/** One reasoning option entry from models.dev's `reasoning_options` array. */
export interface ReasoningOption {
  type: ReasoningContractType;
  /** For `effort`: the discrete levels the model accepts, e.g.
   *  ['low','medium','high','xhigh','max']. */
  values?: string[];
  /** For `budget_tokens`: minimum token budget the model requires. */
  min?: number;
}

/** A user-configured LLM endpoint (any OpenAI- or Anthropic-compatible URL). */
export interface Provider {
  id: string;
  name: string;
  apiStyle: ApiStyle;
  baseUrl: string;
  /** Masked. Real value lives in OS keychain in production. */
  apiKey?: string;
  enabled: boolean;
  models: Model[];
}

/** User-defined model entry: alias + provider model ID + context window. */
export interface Model {
  id: string;
  alias: string;
  /** The actual model identifier the provider expects, e.g. `claude-sonnet-4-5`. */
  modelId: string;
  contextWindow: number;
  providerId: string;
  /** Optional routing role: which operation this model is the default for. */
  role?: 'main' | 'summarization' | 'embedding';
  /** models.dev catalog canonical id (e.g. 'anthropic/claude-opus-4-7'). Set
   *  during the Fetch Models dialog match flow; enables O(1) metadata lookup
   *  at runtime. Absent = no catalog match (manual/fallback metadata). */
  catalogId?: string;
  /** Whether the model supports reasoning (sourced from a live provider /models
   *  response). Drives the brain icon — replaces the heuristic prefix table. */
  reasoning?: boolean;
  /** Whether the model accepts image input (vision). Sourced from a live
   *  provider /models response or the models.dev catalog. When true, attached
   *  images are inlined as image parts instead of hinted via read_media_file. */
  vision?: boolean;
  /** True when the model always reasons and cannot be told not to (e.g.
   *  grok-4.5, some r1 variants). Sourced from a rich provider /models
   *  response. When true, the thinking-level selector disables "off". */
  reasoningMandatory?: boolean;
  /** Valid reasoning effort levels the model accepts (e.g. ['high','medium','low']).
   *  Sourced from a rich provider /models response. When present, the
   *  thinking-level selector only offers these levels. */
  supportedEfforts?: string[];
  /** Reasoning contracts this model supports (effort / budget_tokens / toggle),
   *  sourced from models.dev's `reasoning_options` during catalog enrichment.
   *  When present, the protocol resolver uses these to pick the correct wire
   *  format per provider instead of the fixed budget map. Absent = no catalog
   *  enrichment (falls back to the legacy fixed budget map). */
  reasoningContracts?: ReasoningOption[];
  /** "$in / $out per Mtok" price label, sourced from the provider's /models
   *  response. Display-only (shown in the model picker + table). */
  priceLabel?: string;
  /** Raw per-token input cost (USD). Sourced from the provider's /models
   *  response at fetch time. Used by the orchestrator to compute real cost. */
  inputCostPerToken?: number;
  /** Raw per-token output cost (USD). */
  outputCostPerToken?: number;
  /** Raw per-token cache-read cost (USD), when the provider reports it. */
  cacheReadCostPerToken?: number;
  /** Raw per-token cache-write cost (USD), when the provider reports it. */
  cacheWriteCostPerToken?: number;
  /** Max output tokens the model can generate per response. Overrides the
   *  catalog value when set (sourced from provider /models or manual config).
   *  Used for compaction budget calculation: usable input = context − this. */
  max_completion_tokens?: number;
  /** Max input tokens the provider accepts, when it differs from the context
   *  window (some providers cap input below context − output). When absent,
   *  falls back to contextWindow. Used for compaction budget calculation. */
  maxInputTokens?: number;
}

/** Rich metadata for a model from a provider's /models endpoint. OpenRouter populates all fields; OpenAI/Anthropic direct + LM Studio return only `id` (bare). The probe handler returns an array; FetchModelsButton uses the rich fields directly when present and falls back to the models.dev catalog for bare-id entries. */
export interface ProviderModelMeta {
  id: string;
  /** Display name (OpenRouter "name"). */
  name?: string;
  /** Max context window in tokens (OpenRouter top-level "context_length"). */
  context_length?: number;
  /** Max output tokens (OpenRouter "top_provider.max_completion_tokens"). */
  max_completion_tokens?: number;
  /** Per-token pricing as decimal strings, e.g. { prompt: "0.000003" }. */
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  /** Reasoning configuration (OpenRouter "reasoning" object). */
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[];
  };
  /** API parameters the model accepts, e.g. ["tools","tool_choice","reasoning_effort"]. */
  supported_parameters?: string[];
  /** Input modalities, e.g. ["text","image"] → vision support. */
  input_modalities?: string[];
}

// ============================================================
// Workspaces & sessions
// ============================================================

/** A user-defined shell command bound to a workspace lifecycle. */
export interface WorkspaceScript {
  /** 'setup' = install script (runs on first open); 'run' = dev server script. */
  kind: 'setup' | 'run';
  /** Shell command to execute. */
  command: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** Absolute filesystem path to the repo. */
  path: string;
  /** Git remote URL (if cloned from remote). */
  repository?: string;
  branch: string;
  headCommit: string;
  isDefault: boolean;
  fileCount: number;
  /** Where session worktrees live. Defaults to `.agent/worktrees/`. */
  worktreeLocation: string;
  /** ISO timestamp; presence === archived. */
  archivedAt?: string;
  /** Custom shell scripts bound to this workspace's lifecycle. One per kind. */
  scripts: WorkspaceScript[];
  /** Per-workspace RAG config. Hydrated at read time so workspaces persisted
   *  before this feature existed get sensible defaults. See hydrateRagConfig
   *  in electron/configStore.ts. */
  ragConfig?: RagConfig;
  /** Per-workspace MCP OAuth credentials (tokens/clients/verifiers) for
   *  project-scoped OAuth servers. Stored in config.json, not .mcp.json, so
   *  credentials don't leak to the filesystem or git. */
  mcpOAuth?: {
    tokens?: Record<string, string>;
    clients?: Record<string, string>;
    verifiers?: Record<string, string>;
  };
}

export type AutonomyMode = 'plan' | 'ask' | 'edit' | 'full';

/** Reasoning budget level. `'off'` disables thinking entirely. `'extra'`
 *  maps to the provider effort `xhigh`; `'minimal'` to `minimal` (gpt-5.0+
 *  vocabulary). Provider-native tiers round-trip through these levels. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';

export type SessionStatus = 'active' | 'idle' | 'awaiting_permission' | 'error' | 'spend_capped';

/** Inspector hero status: collapses Session.status + stream.isStreaming + permissionRequest into the states the UI shows. Computed by `deriveHeroStatus`. Broader than SessionStatus — 'running'/'blocked' are runtime-only. */
export type HeroStatus = 'running' | 'idle' | 'blocked' | 'error' | 'spend_capped';

/** A port exposed by a running script (dev server, etc.). */
export interface ExposedPort {
  port: number;
  /** Label inferred from the script that opened it. */
  label: string;
  /** URL to open in browser. */
  url: string;
}

export interface ArchivedHeader {
  id: string;
  workspaceId: string;
  title: string;
  modelId: string;
  archivedAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  workspaceId: string;
  title: string;
  modelId: string;
  /** Provider half of the selection — disambiguates when the same model id exists under multiple providers. Absent on pre-migration sessions. */
  providerId?: string;
  autonomyMode: AutonomyMode;
  /** Per-session thinking level — controls the reasoning budget sent to the model. */
  thinkingLevel: ThinkingLevel;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** Present once the first mutating tool call has created a worktree. */
  worktree?: {
    branch: string;
    path: string;
    baseCommit: string;
    baseBranch: string;
    ahead: number;
    behind: number;
  };
  messages: Message[];
  usage: Usage;
  /** Usage from the LAST completed turn only (not cumulative). The context-
   *  window meter uses this to show "how full is the context right now" —
   *  the model's last request is what fills the context window, not the sum
   *  of every turn's tokens. `usage` stays cumulative for cost accounting. */
  lastTurnUsage?: Usage;
  /** Cumulative cost across all turns in this session. */
  costUsd: number;
  /** File paths the user has explicitly added to context. */
  contextFiles: ContextFile[];
  /** Recent tool-call-derived activity events, newest first. */
  activity: ActivityEvent[];
  /** Pending MCP servers for the workspace (mocked). */
  mcpServers: McpServer[];
  /** Ports exposed by running scripts (dev servers, etc.). */
  exposedPorts: ExposedPort[];
  /** ISO timestamp; presence === archived. */
  archivedAt?: string;
}

export interface ContextFile {
  path: string;
  /** 'M' modified, 'A' added, 'ref' just referenced. */
  status: 'M' | 'A' | 'ref';
}

export interface ActivityEvent {
  id: string;
  type: 'permission_requested' | 'tool_executed' | 'tool_read' | 'worktree_created' | 'message' | 'file_loaded';
  label: string;
  detail?: string;
  at: string;
  tone: 'ok' | 'warn' | 'bad' | 'accent' | 'muted';
}

// ============================================================
// Messages & tool calls
// ============================================================

export type MessageRole = 'user' | 'assistant';

/** A user-attached message file: code/text/paste carry inline contents; images carry only the path. */
export interface MessageAttachment {
  path: string;
  kind: 'code' | 'image' | 'text' | 'paste';
  /** Inline contents for code/text/paste kinds. Undefined for image. */
  content?: string;
  /** Byte count of the original file, if known. */
  bytes?: number;
  /** True if `content` was truncated to fit the attachment budget. */
  truncated?: boolean;
  /** Absolute on-disk path for external (browsed/pasted) files. Lets the
   *  viewer re-read the file after a reload once inline content is gone. */
  absPath?: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  /** Mention metadata for rendering hover tooltips on /name and @path chips
   *  in the user message bubble. Populated from the composer's mention list. */
  mentions?: Array<{
    name: string;
    kind: 'skill' | 'agent' | 'context' | 'mcp';
    source?: 'project' | 'user' | 'builtin';
    filePath?: string;
    description?: string;
  }>;
  /** Ordered timeline preserving the exact interleaving of text and tool
   *  calls as the model emitted them: text₁ → tool₁ → text₂ → tool₂.
   *  The renderer iterates this directly for emission-order display.
   *  Optional — older messages fall back to flat content + toolCalls. */
  timeline?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool'; toolIndex: number }
  >;
  /** When present, this message renders as a structured TurnBlock instead
   *  of a flat timeline. Built by useChatStream during streaming and frozen
   *  on turn_end. Older messages without this field fall back to flat
   *  rendering via the timeline path. */
  turn?: Turn;
  /** Canonical block list — the single source of truth for rendering.
   *  Set by the orchestrator on turn_end (live turns) or by
   *  migrateMessageToBlocks on load (old turns). When present, the
   *  renderer uses this and ignores `timeline`/`turn`/`content`. */
  blocks?: Block[];
  /** Present on assistant messages from reasoning models. */
  reasoning?: string;
  /** Reasoning token count, if known. */
  reasoningTokens?: number;
  /** Thinking duration in ms, if known. */
  reasoningMs?: number;
  /** Wall-clock duration of the turn (ms), from send to result. Persisted so
   *  the answer-block timer survives reload. */
  totalMs?: number;
  createdAt: string;
  /** Tool calls made during this message (assistant only). */
  toolCalls?: ToolCall[];
  /** Files the user attached to this message (user only). */
  attachments?: MessageAttachment[];
  /** Turn-level stop reason (assistant only). 'refusal' = failed, 'aborted'
   *  = user-stopped. Persisted so the TurnHeader renders the correct status
   *  ("Failed" / "Stopped" / "Done") on reload, not just during the live turn. */
  stopReason?: string | null;
  /** Present when context compaction occurred during this turn. Renders a
   *  horizontal "Compacted" divider before this message in the timeline so
   *  the user can see where context was summarized. */
  compactionInfo?: { tokensBefore: number; tokensAfter: number };
}

/** The three behaviors of the `ask_followup_question` tool, derived from its parsed args (see `docs/plans/2026-07-20-turn-block-streaming-design.md` Section 10 for routing rules). */
export type FollowupMode =
  | { kind: 'options'; question: string; options: string[]; multiple: boolean }
  | { kind: 'question'; question: string }
  | { kind: 'blank' };

/** Structured turn-block assistant messages render as: built during streaming, frozen on turn_end; drives both expanded and collapsed views. */
export interface Turn {
  thinking?: { text: string; tokens?: number; ms?: number };
  /** bash, bash_output, kill_shell, git */
  commands: ToolCall[];
  /** edit_file, multi_edit, write_file, notebook_edit */
  edits: ToolCall[];
  /** read_file, grep, glob, list_dir, web_fetch, web_search */
  exploration: ToolCall[];
  /** dispatch_agent, todo_write, ask_followup_question, exit_plan_mode, compact, slash_command, mcp */
  other: ToolCall[];
  /** Ordered timeline preserving emission order — used by ToolsSection
   *  expanded view during streaming. */
  timeline: Array<
    | { type: 'text'; text: string }
    | { type: 'tool'; toolIndex: number }
  >;
  /** Process narration — text segments the model emitted BEFORE or BETWEEN
   *  tool calls ("I'll proceed with a broad analysis...", "Plan is solid...").
   *  These belong to the process, not the conclusion, so they render inside
   *  the ToolsSection expanded view rather than in the AnswerBlock. */
  narration?: string[];
  /** The final assistant answer (markdown). Stays rendered + always open.
   *  During streaming this is the accumulated live text; on turn_end it
   *  becomes the final content. */
  answer?: string;
  /** Derived from the last ask_followup_question call in the turn. */
  followup?: FollowupMode | null;
  /** Wall-clock duration of the turn (sum of tool durations + LLM time). */
  totalMs?: number;
  /** True if any tool call in the turn failed. */
  anyFailed?: boolean;
}

export type ToolName =
  | 'read_file'
  | 'edit_file'
  | 'multi_edit'
  | 'write_file'
  | 'list_dir'
  | 'directory_tree'
  | 'glob'
  | 'bash'
  | 'bash_output'
  | 'kill_shell'
  | 'grep'
  | 'git'
  | 'git_repo'
  | 'dispatch_agent'
  | 'todo_write'
  | 'web_fetch'
  | 'web_search'
  | 'notebook_edit'
  | 'ask_followup_question'
  | 'exit_plan_mode'
  | 'compact'
  | 'slash_command'
  | 'load_skill'
  | 'mcp'
  | 'memory'
  | 'read_media_file'
  | 'init';

export type ToolCallStatus =
  | 'pending'
  | 'running'
  | 'awaiting_input'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'timeout'
  | 'aborted'
  | 'partial';

export type RiskTier = 'read_only' | 'write' | 'destructive';

/** Tool definition sent to the model plus internal permission-gate metadata; the `definition` is model-facing, the rest never leaves the app. */
export interface ToolDefinition {
  definition: {
    name: ToolName;
    description: string;
    input_schema: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
  riskTier: RiskTier;
  requiresWorktree: boolean;
  timeoutMs: number;
  autoApproveIn: AutonomyMode[];
}

export interface ToolCall {
  id: string;
  messageId: string;
  toolName: ToolName;
  /** The args the model emitted, as a formatted preview string. */
  arguments: Record<string, unknown>;
  argPreview: string;
  status: ToolCallStatus;
  riskTier: RiskTier;
  /** Permission gate decision that surfaced this call. 'blocked' = plan mode
   *  forbids it (only mode-escalation proceeds); 'ask' = needs explicit
   *  approval. Absent on non-gated / legacy tool calls (renders as the plain
   *  ask card). */
  gateDecision?: 'ask' | 'blocked';
  /** Short, model-facing summary. */
  output?: string;
  /** Live sub-agent report for dispatch_agent — streams into the block
   *  while the dispatch runs (see stream-reducer applyToolDelta). */
  report?: string;
  /** Richer UI-facing payload, e.g. a diff. */
  display?: ToolDisplay;
  durationMs?: number;
  /** Bytes/lines affected, for read tools. */
  meta?: string;
  /** Partial tool-input JSON as the model streams args. Surfaces a live
   *  preview while the tool call is forming (before the complete tool_call
   *  event arrives with parsed arguments). Renderer-only; not persisted. */
  _partialInput?: string;
  /** When set, this tool call ran inside a sub-agent dispatched by the
   *  named parent dispatch_agent tool call. The renderer nests these
   *  under the parent block. Undefined for top-level tool calls. */
  parentToolCallId?: string;
}

export type ToolDisplay =
  | { kind: 'diff'; path: string; hunks: DiffHunk[]; additions: number; deletions: number }
  | { kind: 'command'; command: string }
  | { kind: 'file_list'; paths: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'media'; dataUrl: string; mimeType: string }
  | { kind: 'agent'; agentName: string; title?: string; task: string; report: string; usage?: Usage; reasoning?: string; dispatchId?: string; background?: boolean; backgroundState?: 'completed' | 'error' | 'interrupted' }
  | { kind: 'file_loaded'; path: string; lines: number; bytes: number; description?: string; body: string };

/** Per-session streaming state, keyed by sessionId so sessions stream independently without overwriting each other. */
export interface SessionStream {
  /** Accumulated assistant text this turn. */
  text: string;
  /** Accumulated reasoning text this turn. */
  reasoning: string;
  /** Tool calls emitted this turn (start → executing → result). */
  toolCalls: ToolCall[];
  /** Live timeline built during streaming so text and tool rows interleave in true emission order rather than the legacy "text first, all tools after" layout. */
  timeline: Array<
    | { type: 'text'; text: string }
    | { type: 'tool'; toolIndex: number }
  >;
  /** Canonical block list for the live streaming turn. Built by the
   *  streamReducer on every event. Replaces `timeline`/`toolCalls`/
   *  `turn` for rendering purposes. */
  blocks?: Block[];
  /** Index by toolCallId → position in `blocks`. Maintained by the
   *  reducer alongside `blocks` so tool_call_delta / tool_result don't
   *  scan the array. */
  toolBlockIndex?: Record<string, number>;
  /** Structured turn-block view of the same data. Rebuilt by useChatStream
   *  on every patchStream so the renderer reads a single object. */
  turn?: Turn;
  /** Last reported per-call usage. */
  usage: Usage | null;
  /** Cumulative session cost in USD (sum across all turns + steps). */
  sessionCostUsd: number;
  /** Iteration counter within the turn. */
  iteration: number;
  /** Pending permission prompt for this session, if any. */
  permissionRequest: { toolCalls: ToolCall[]; timeoutAt: number } | null;
  /** True while this session has a turn in flight. */
  isStreaming: boolean;
  /** Error message if the turn failed. */
  error: string | null;
  /** Retry info when the orchestrator is auto-retrying a failed call.
   *  Null when no retry is in flight. Drives the "Retrying 1/2…" UI. */
  retry: { attempt: number; maxAttempts: number; reason: string } | null;
  /** True while autocompact is summarizing the conversation. Shows a
   *  "Compacting…" indicator so the user understands the pause. */
  compacting: boolean;
  /** Token counts from the last compaction, for the context meter's
   *  "compacted N→M" annotation. Null until a compaction completes. */
  compactedTokens: { before: number; after: number } | null;
  /** Stop reason from the last turn_end. */
  stopReason: string | null;
  /** Frozen assistant message shape once the turn ends (for persistence).
   *  Consumed + cleared by MainScreen's freeze effect. */
  finalMessage: {
    content: string;
    /** The orchestrator's message id — the streaming partial flush already
     *  persisted a message with this id; the freeze effect finalizes it
     *  in place by this id rather than appending a duplicate. */
    messageId?: string;
    timeline?: Array<{ type: 'text'; text: string } | { type: 'tool'; toolIndex: number }>;
    blocks?: Block[];
    turn?: Turn;
    reasoning?: string;
    reasoningTokens?: number;
    totalMs?: number;
    toolCalls?: ToolCall[];
    usage?: Usage;
    /** The last step's usage only — for the context meter. */
    lastStepUsage?: Usage;
  } | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'hunk';
  oldNo?: number;
  newNo?: number;
  text: string;
}

// ============================================================
// Usage & cost
// ============================================================

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens: number;
  calls: number;
  /** Computed cost in USD for this turn / session. */
  costUsd: number;
}

// ============================================================
// Right-panel tabs
// ============================================================

export type RightTabKind = 'inspector' | 'files' | 'review' | 'changes' | 'terminal';

export interface RightTab {
  kind: RightTabKind;
  /** Inspector is always present and cannot be closed. */
  locked?: boolean;
}

// ============================================================
// File tree (mocked)
// ============================================================

export type FileNodeKind = 'dir' | 'file';

export interface FileNode {
  name: string;
  path: string;
  kind: FileNodeKind;
  /** For modified files in the worktree. */
  gitStatus?: 'M' | 'A' | 'D';
  children?: FileNode[];
  expanded?: boolean;
}

// ============================================================
// MCP servers
// ============================================================

export interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  status: 'connected' | 'restarting' | 'error';
}

// ============================================================
// RAG embedder (Memory & RAG panel)
// ============================================================

/** Which embedder variant built an index; the two are NOT cross-compatible despite matching dimensions, so query dispatch must never mix them. */
export type EmbedderId = 'local-code-512' | 'cloud-base';

/** Per-workspace RAG config. Persisted on the Workspace, hydrated at
 *  read time so older workspaces without it get defaults. */
export interface RagConfig {
  embedderId: EmbedderId;
  dim: 384;
  /** Cloud is opt-in AND only acts as a build-time fallback when local
   *  ONNX is unavailable. Default false = local-only-or-disabled. */
  cloudAllowed: boolean;
  /** Embedder-aware: local supports 256/384/512; cloud locks to 256. */
  chunkTokens: number;
}

/** Read-only snapshot for the panel. */
export interface RagStatus {
  embedderId: EmbedderId | null;
  dim: 384;
  enabledWorkspaces: string[];
  cloudAllowed: boolean;
  chunkTokens: number;
  localAvailable: boolean | null;
  cloudConfigured: boolean;
  chunkCount: number;
  initState: 'never' | 'running' | 'done' | 'failed';
  lastIngestedAt: number | null;
  state: 'ok' | 'cloud-fallback' | 'unavailable' | 'no-index';
}

export type RagWorkspaceOpResult = { ok: true } | { ok: false; error: string };
export type RagInitResult = { ok: true; startedAt: number } | { ok: false; error: string };
export interface RagInitProgressEvent {
  workspaceId: string;
  phase: 'walking' | 'chunking' | 'embedding' | 'done' | 'failed';
  filesSeen: number;
  chunksTotal: number;
  chunksEmbedded: number;
  currentFile?: string;
  error?: string;
}

/** Emitted during model download (tide:rag:downloadProgress). */
export interface RagDownloadProgressEvent {
  received: number;
  total: number;
  phase: 'downloading' | 'done' | 'failed';
  error?: string;
}

/** Per-step milestone emitted during workspace creation (tide:workspace:progress).
 *  Correlated by requestId (generated client-side, passed in the addWorkspace
 *  input and echoed back) — the workspace id isn't known until creation
 *  finishes, so it can't key the events. The dialog subscribes by requestId. */
export type WorkspaceProgressStep = 'clone' | 'folder' | 'scaffold' | 'install' | 'git' | 'detect';
export interface WorkspaceProgressEvent {
  requestId: string;
  step: WorkspaceProgressStep;
  status: 'active' | 'done' | 'failed';
  /** Human label, e.g. "Cloning repository…". */
  label: string;
  /** Optional detail, e.g. the template label or repo URL. */
  detail?: string;
  error?: string;
}

// ─── Open-in-app (top-bar "Open Project In…" menu) ─────────────────────
/** Apps the top-bar menu can open the project in: `finder`/`terminal` always available, `vscode`/`zed` only when detected as installed. */
export type ExternalAppTarget = 'finder' | 'terminal' | 'vscode' | 'zed';

/** One entry in the open-in-app menu. `available` is false for editors that
 *  aren't installed (the renderer filters those out before rendering). */
export interface ExternalApp {
  id: ExternalAppTarget;
  /** Display label, e.g. "Finder", "VSCode". */
  label: string;
  /** True if the app/CLI was detected on this machine. */
  available: boolean;
  /** The app's OS icon as a base64 data URL, fetched via Electron's
   *  app.getFileIcon(). Null when icon fetch failed or on a platform without
   *  a bundle to read (e.g. a Linux CLI-only install) — the renderer falls
   *  back to a generic lucide icon. */
  iconDataUrl?: string | null;
}

// ─── Block-stream model (new canonical shape) ───────────────────────────
// Re-exported here so consumers can import everything from '@/types'.
// Full type definitions live in './block'.
export type {
  Block,
  BaseBlock,
  TextBlock,
  ReasoningBlock,
  ToolBlock,
  FollowupBlock,
} from './block';
export {
  isTextBlock,
  isReasoningBlock,
  isToolBlock,
  isFollowupBlock,
} from './block';
