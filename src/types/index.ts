/**
 * Domain types for Tide.
 *
 * Faithful to the design doc revision v2 (`../agentic-desktop-app-design-doc.revision-v2.md`):
 * - `format_version` / `turn_start` / `turn_end` / `usage` envelope events are reflected
 *   in the Session shape.
 * - Per-token-class Usage (input, output, cache_read, cache_write, reasoning) drives
 *   the cost ticker.
 * - Tool results split model-facing `output` from UI-facing `display`.
 */

// Block types are defined in './block' (which itself imports back from this
// file for FollowupMode/RiskTier/etc.). We pull `Block` in as a local type
// alias up front so the Message/SessionStream shapes below can reference it
// without waiting on the re-export at the bottom of the file.
import type { Block } from './block';

// ============================================================
// Providers & models
// ============================================================

export type ApiStyle = 'openai' | 'anthropic';

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
  /** LiteLLM catalog canonical id (e.g. 'anthropic/claude-sonnet-4-5'). Set
   *  during the Fetch Models dialog match flow; enables O(1) metadata lookup
   *  at runtime. Absent = no catalog match (manual/fallback metadata). */
  catalogId?: string;
  /** Whether the model supports reasoning (sourced from a live provider /models
   *  response). Drives the brain icon — replaces the heuristic prefix table. */
  reasoning?: boolean;
  /** True when the model always reasons and cannot be told not to (e.g.
   *  grok-4.5, some r1 variants). Sourced from a rich provider /models
   *  response. When true, the thinking-level selector disables "off". */
  reasoningMandatory?: boolean;
  /** Valid reasoning effort levels the model accepts (e.g. ['high','medium','low']).
   *  Sourced from a rich provider /models response. When present, the
   *  thinking-level selector only offers these levels. */
  supportedEfforts?: string[];
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
}

/**
 * Rich metadata for a model as returned by a provider's /models endpoint.
 * OpenRouter populates all fields; OpenAI/Anthropic direct + LM Studio return
 * only `id` (bare). The probe handler returns an array of these; the
 * FetchModelsButton uses the rich fields directly when present and falls back
 * to the LiteLLM catalog for bare-id entries.
 */
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
  /** 'setup' = runs on first open / fresh clone; 'run' = ad-hoc; 'delete' = runs before removal. */
  kind: 'setup' | 'run' | 'delete';
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
}

export type AutonomyMode = 'plan' | 'ask' | 'edit' | 'full';

/** Reasoning budget level. `'off'` disables thinking entirely. */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max';

export type SessionStatus = 'active' | 'idle' | 'awaiting_permission' | 'error' | 'spend_capped';

/**
 * The Inspector hero's derived status — a single label that collapses the
 * three runtime signals (Session.status, the stream's isStreaming flag, and
 * a pending permissionRequest) into the four states the UI actually shows.
 * Computed by `deriveHeroStatus` in SessionHero.tsx.
 *
 *   running     → a turn is in flight (stream.isStreaming)
 *   blocked     → a permission card is pending (permissionRequest != null)
 *   error       → session.status === 'error', or stream.error set
 *   spend_capped→ session.status === 'spend_capped'
 *   idle        → none of the above
 *
 * Note this is broader than SessionStatus: 'running' and 'blocked' are
 * runtime-only (driven by the live stream, not persisted).
 */
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

/**
 * A file the user explicitly attached to a message. Code/text files carry
 * their contents inline so the model can reason about them without a tool
 * call. Paste attachments carry user-pasted content under a generated name.
 * Image attachments carry only the path for now — real multimodal blocks
 * (Anthropic image content) are a follow-up.
 */
export interface MessageAttachment {
  path: string;
  kind: 'code' | 'image' | 'text' | 'paste';
  /** Inline contents for code/text/paste kinds. Undefined for image. */
  content?: string;
  /** Byte count of the original file, if known. */
  bytes?: number;
  /** True if `content` was truncated to fit the attachment budget. */
  truncated?: boolean;
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
  createdAt: string;
  /** Tool calls made during this message (assistant only). */
  toolCalls?: ToolCall[];
  /** Files the user attached to this message (user only). */
  attachments?: MessageAttachment[];
}

/**
 * The three behaviors of the `ask_followup_question` tool, derived from its
 * parsed args. See `docs/plans/2026-07-20-turn-block-streaming-design.md`
 * Section 10 for the routing rules.
 */
export type FollowupMode =
  | { kind: 'options'; question: string; options: string[]; multiple: boolean }
  | { kind: 'question'; question: string }
  | { kind: 'blank' };

/**
 * Structured turn-block — the new shape assistant messages render as.
 * Built incrementally during streaming (alongside the existing timeline)
 * and frozen on turn_end. Same data drives both streaming-expanded and
 * completed-collapsed views.
 */
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
  | 'glob'
  | 'bash'
  | 'bash_output'
  | 'kill_shell'
  | 'grep'
  | 'git'
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
  | 'memory';

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

/**
 * A tool definition sent to the model plus internal metadata that drives
 * the permission gate (design doc §8). The `definition` is what the model
 * sees; the rest never leaves the app.
 */
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
  /** Richer UI-facing payload, e.g. a diff. */
  display?: ToolDisplay;
  durationMs?: number;
  /** Bytes/lines affected, for read tools. */
  meta?: string;
  /** Partial tool-input JSON as the model streams args. Surfaces a live
   *  preview while the tool call is forming (before the complete tool_call
   *  event arrives with parsed arguments). Renderer-only; not persisted. */
  _partialInput?: string;
}

export type ToolDisplay =
  | { kind: 'diff'; path: string; hunks: DiffHunk[]; additions: number; deletions: number }
  | { kind: 'command'; command: string }
  | { kind: 'file_list'; paths: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'agent'; agentName: string; task: string; report: string; usage?: Usage; reasoning?: string }
  | { kind: 'file_loaded'; path: string; lines: number; bytes: number; description?: string; body: string };

/**
 * Per-session streaming state. Keyed by sessionId in the UI store so each
 * session's stream is fully independent — two sessions can stream in parallel
 * without overwriting each other's text/toolCalls/usage.
 */
export interface SessionStream {
  /** Accumulated assistant text this turn. */
  text: string;
  /** Accumulated reasoning text this turn. */
  reasoning: string;
  /** Tool calls emitted this turn (start → executing → result). */
  toolCalls: ToolCall[];
  /**
   * Live timeline built incrementally during streaming so the renderer can
   * show text and tool rows interleaved in true emission order — not the
   * "text first, all tools after" legacy layout. Each delta appends to the
   * current text entry (creating one if the last entry was a tool); each
   * tool_call_start pushes a new tool entry pointing at the new call.
   */
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
  /** Iteration counter within the turn. */
  iteration: number;
  /** Pending permission prompt for this session, if any. */
  permissionRequest: { toolCalls: ToolCall[]; timeoutAt: number } | null;
  /** True while this session has a turn in flight. */
  isStreaming: boolean;
  /** Error message if the turn failed. */
  error: string | null;
  /** Stop reason from the last turn_end. */
  stopReason: string | null;
  /** Frozen assistant message shape once the turn ends (for persistence).
   *  Consumed + cleared by MainScreen's freeze effect. */
  finalMessage: {
    content: string;
    timeline?: Array<{ type: 'text'; text: string } | { type: 'tool'; toolIndex: number }>;
    blocks?: Block[];
    turn?: Turn;
    reasoning?: string;
    reasoningTokens?: number;
    toolCalls?: ToolCall[];
    usage?: Usage;
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

/** Which embedder variant built a given index. The two are NOT
 *  cross-compatible despite matching dimensions — fine-tuning moves
 *  the embedding space — so query dispatch must always read this field
 *  and never mix. */
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

// ─── Open-in-app (top-bar "Open Project In…" menu) ─────────────────────
/** Apps the top-bar menu can open the active session's project folder in.
 *  `finder` and `terminal` are always available; `vscode` and `zed` are
 *  surfaced only when detected as installed (auto-detect on first menu open). */
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
