import type { AgentEvent } from '../src/lib/agent/events';

// ── Inlined schema plumbing (was electrobun/view) ──────────────────
// RPCSchema<S> resolves to the plain { requests, messages } pair the
// Electrobun SDK produced when both keys are present (they always are in
// TideRPC below), so the wire schema is unchanged without the SDK.

type RPCSchema<S extends { requests?: unknown; messages?: unknown }> = {
  requests: S extends { requests: infer R } ? R : Record<string, never>;
  messages: S extends { messages: infer M } ? M : Record<string, never>;
};

/** User-customized keyboard shortcuts: action id → key chord (was
 *  app/core/settingsStore — verbatim). */
type ShortcutOverrides = Record<string, string[]>;

/** One flushed partition of events, delivered per session (was
 *  app/core/agent/event-types — verbatim). Event `seq` is present iff the
 * transaction committed (persisted rowid, ascending within the batch);
 * absent ⇒ degraded push-only delivery with firstSeq/lastSeq 0. */
interface SinkEvent {
  type: 'part.delta' | 'part.commit' | 'message.end' | 'turn.end';
  sessionId: string;
  messageId?: string;
  partId?: string;
  data?: Record<string, unknown>;
  seq?: number;
}

export interface FlushBatch {
  events: SinkEvent[];
  firstSeq: number;
  lastSeq: number;
}

// ── Sessions wire types ─────────────────────────────────────────────
// Leaf-safe mirrors of the core session shapes (core/ipc-adjacent/
// sessionStore.ts + session-store-v2.ts). The schema must not import those
// modules — even type-only — because their import graph drags runtime code
// (git, sqlite, the provider stack) into the renderer typecheck. The mirrors
// are structurally WIDER (unknown[] instead of Block[] etc.), so the rich
// core types the handlers return are assignable; the main.ts RPC wiring
// enforces that compatibility, which is the drift guard.

export type SessionAutonomyMode = 'ask' | 'plan' | 'edit' | 'full';
export type SessionThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';

export interface SessionCreateOpts {
  autonomyMode?: SessionAutonomyMode;
  thinkingLevel?: SessionThinkingLevel;
  providerId?: string;
  kind?: 'main' | 'subagent';
}

export interface SessionSettingsPatch {
  autonomyMode?: SessionAutonomyMode;
  thinkingLevel?: SessionThinkingLevel;
}

export interface SessionMessageExtra {
  attachments?: unknown[];
  mentions?: unknown[];
}

export interface AssistantMessageInput {
  content: string;
  reasoning?: string;
  reasoningTokens?: number;
  reasoningMs?: number;
  totalMs?: number;
  toolCalls?: unknown[];
  timeline?: unknown[];
  turn?: unknown;
}

export interface FinalizeAssistantMessageInput extends AssistantMessageInput {
  blocks?: unknown[];
  compactionInfo?: { tokensBefore: number; tokensAfter: number };
  stopReason?: string | null;
}

export interface SessionUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  calls?: number;
  costUsd?: number;
}

export interface SessionWorktree {
  branch: string;
  path: string;
  baseCommit: string;
  baseBranch: string;
  ahead: number;
  behind: number;
}

export interface SessionHeader {
  id: string;
  workspaceId: string;
  title: string;
  modelId: string;
  providerId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  kind?: 'main' | 'subagent';
  parentId?: string;
  worktree?: SessionWorktree;
}

export interface ArchivedSessionHeader {
  id: string;
  workspaceId: string;
  title: string;
  modelId: string;
  archivedAt: string;
  updatedAt: string;
}

export interface StoredSessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  blocks?: unknown[];
  reasoning?: string;
  reasoningTokens?: number;
  reasoningMs?: number;
  totalMs?: number;
  toolCalls?: unknown[];
  timeline?: unknown[];
  turn?: unknown;
  attachments?: unknown[];
  compactionInfo?: { tokensBefore: number; tokensAfter: number };
  stopReason?: string | null;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens: number;
  calls: number;
  costUsd: number;
}

/** What getSession/create/fork return after hydrate: the persisted session
 *  plus UI defaults (status, usage zero-init, empty activity surfaces). */
export interface HydratedSession {
  id: string;
  workspaceId: string;
  title: string;
  modelId: string;
  providerId?: string;
  messages: StoredSessionMessage[];
  createdAt: string;
  updatedAt: string;
  autonomyMode: SessionAutonomyMode;
  thinkingLevel: SessionThinkingLevel;
  status: 'idle' | 'active' | 'awaiting_permission' | 'error' | 'spend_capped';
  usage: SessionUsage;
  lastTurnUsage?: SessionUsage;
  costUsd: number;
  worktree?: SessionWorktree;
  archivedAt?: string;
  parentId?: string;
  kind?: 'main' | 'subagent';
  forkedFrom?: { sessionId: string; title: string };
}

export interface SessionMetaV2 {
  id: string;
  workspacePath: string;
  parentId: string | null;
  title: string;
  modelId: string | null;
  providerId: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  cost: number;
  summaryAdditions: number | null;
  summaryDeletions: number | null;
  summaryFiles: number | null;
  archivedAt: number | null;
  timeCreated: number;
  timeUpdated: number;
}

export interface SessionPartV2 {
  id: string;
  seq: number;
  kind: string;
  data: unknown;
}

export interface SessionMessageV2 {
  id: string;
  role: string;
  model: string | null;
  timeCreated: number;
  timeCompleted: number | null;
  parts: SessionPartV2[];
}

export interface SessionListOptsV2 {
  archived?: boolean;
  cursor?: string | null;
  limit?: number;
}

export interface SessionWindowOptsV2 {
  limit?: number;
  before?: string | null;
}

// ── Chat wire types ────────────────────────────────────────────────
// The turn-loop payload (RunTurnPayload) with attachments widened to
// unknown[] for leaf safety — the rich renderer MessageAttachment shape is
// assignable and rides the wire verbatim.

export interface ChatTurnMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: unknown[];
}

export interface ChatSendParams {
  sessionId: string;
  messages: ChatTurnMessage[];
  modelId: string;
  providerId: string;
  autonomyMode: SessionAutonomyMode;
  thinkingLevel: SessionThinkingLevel;
}

/** Job pattern: accepted returns immediately — the turn runs detached and
 *  streams via orchestratorEvents (durable parts) + agentEvents (control
 *  events). A rejection carries the pre-flight error (provider/key). */
export type ChatSendResult = { accepted: true } | { accepted: false; error: string };

export interface ChatSubmitFollowupParams {
  sessionId: string;
  toolCallId: string;
  answer: string;
}

// ── Terminal wire types ────────────────────────────────────────────
// Payloads match the frozen Electron shell's terminal:* IPC shapes exactly
// so the renderer swap is mechanical: output carries the scrollback seq the
// renderer's snapshot-dedupe/parking logic depends on.

export interface TerminalPort {
  port: number;
  url: string;
  label: string;
}

export type TerminalScrollbackResult =
  | { alive: true; data: string; seq: number }
  | { alive: false };

// ── MCP wire types ─────────────────────────────────────────────────
// Verbatim copies of the shapes that lived in app/core/agent/mcp/{types,
// scanner}.ts — the config shape matches what users paste from MCP server
// docs: a flat map of server name → config object (the file IS the map, no
// mcpServers wrapper).

/** Transport type discriminator. Always present in config. */
export type McpTransportType = 'stdio' | 'sse' | 'http';

/** A single server's configuration (one entry in the config map). */
export interface McpServerConfig {
  type: McpTransportType;

  // ── stdio fields (type === 'stdio') ──
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // ── remote fields (type === 'sse' | 'http') ──
  url?: string;
  /** Custom HTTP headers sent on every request to the MCP server.
   *  Used for bearer tokens, API keys, etc. e.g. { "Authorization": "Bearer xxx" } */
  headers?: Record<string, string>;

  // ── auth ──
  /** Set to 'oauth' for OAuth-protected remote servers. */
  auth?: 'oauth';
}

/** Where a server config lives — determines connection lifecycle. */
export type McpScope = 'user' | 'project' | 'builtin';

/** Connection state for a single server. */
export type McpConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected'
  | 'needs_approval'
  | 'needs_credentials'
  | 'needs_oauth';

/** Status row for the management UI. */
export interface McpServerStatus {
  name: string;
  scope: McpScope;
  config: McpServerConfig;
  status: McpConnectionStatus;
  toolCount: number;
  /** Names of the tools the server exposes — drives the clickable tool list
   *  in the settings UI. Only populated when connected (empty otherwise). */
  toolNames: string[];
  error?: string;
  transport: McpTransportType;
  /** Whether the user has enabled this server (toggled on). */
  enabled: boolean;
}

/** A server detected in another tool's config file (mcp import scanner). */
export interface DetectedServer {
  name: string;
  config: McpServerConfig;
  source: string; // display label: "Claude Code", "Codex", etc.
  sourceFile: string; // the file path it came from
}

export interface McpScanResult {
  servers: DetectedServer[];
  /** Names already present in Tide's config (so the UI can pre-uncheck them). */
  alreadyImported: string[];
}

// ── RAG + knowledge-sources wire types ─────────────────────────────
// src/types is the renderer's own type leaf; knowledge/types.ts is a pure
// leaf (zero imports). RagStatus and friends are defined in src/types and
// re-exported by the core ipc files — importing them here keeps one source
// of truth. All type-only, erased at emit.

import type {
  DiffHunk,
  ExternalApp,
  ExternalAppTarget,
  FileNode,
  KnowledgeSource,
  Provider,
  ProviderModelMeta,
  RagStatus,
  RagWorkspaceOpResult,
  RagInitResult,
  RagInitProgressEvent,
  RagDownloadProgressEvent,
  SourceKind,
  SourceProgressEvent,
  Workspace,
  WorkspaceProgressEvent,
  WorkspaceScript,
} from '../src/types';

export type { KnowledgeSource, SourceKind, SourceProgressEvent };

/** sourcesList reply. `error` is set when the store read fails (the Electron
 *  shell returned empty lists + error rather than rejecting). */
export interface SourcesListResult {
  sources: KnowledgeSource[];
  enabledSourceIds: string[];
  error?: string;
}

export interface SourcesAddResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface SourcesOpResult {
  ok: boolean;
  error?: string;
}

export interface SourcesUpdateParams {
  id: string;
  patch: { name?: string; location?: string; enabledWorkspaceIds?: string[] };
}

/**
 * The Electron shell pushed two distinct rag progress channels
 * (tide:rag:initProgress, tide:rag:downloadProgress). One message carries
 * both with the payloads verbatim — discriminated by `kind` so consumers
 * filter without shape changes.
 */
export type RagProgressMessage =
  | { kind: 'init'; event: RagInitProgressEvent }
  | { kind: 'download'; event: RagDownloadProgressEvent };

// ── Catch-all wire types (3.7) ─────────────────────────────────────
// Workspaces, providers, git, scripts, todos/agents catalog, extensions,
// dialogs/shell/diagnostics. Leaf-safe: renderer type leaves by import,
// core-derived shapes mirrored by hand where the core module isn't a leaf.

export type { Workspace, FileNode, Provider, ProviderModelMeta, ExternalApp, ExternalAppTarget, WorkspaceProgressEvent, WorkspaceScript };

export type WorkspaceAddInput = {
  path: string;
  name?: string;
  repository?: string;
  template?: string;
  scripts?: WorkspaceScript[];
  initGit?: boolean;
  requestId?: string;
};

export type WorkspaceFileReadResult =
  | { ok: true; content: string; truncated: boolean; bytes: number }
  | { ok: false; reason: string };

export interface ExternalFileContent {
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface ImageFileContent {
  dataUrl: string;
  bytes: number;
}

export interface GitRepoInfo {
  branch: string;
  headCommit: string;
  fileCount: number;
  isRepo: boolean;
}

export interface EnvInfo {
  platform: string;
  arch: string;
  release: string;
  shell: string;
  /** True while provider keys still hold unmigrated Electron v10 blobs
   *  (Electrobun shell only; absent under the Electron shell). */
  keysNeedMigration?: boolean;
}

export interface DiagnosticsInfo {
  appVersion: string;
  /** Runtime identifier — 'bun' under Electrobun, 'electron' in the frozen shell. */
  runtime: string;
  /** Runtime version — Bun version / Electron version. */
  runtimeVersion: string;
  /** Chromium-equivalent engine version when known ('unknown' under Bun). */
  chrome: string;
  platform: string;
  userDataPath: string;
}

export type MacPermissionStatus = {
  platform: 'mac' | 'other';
  accessibility: 'authorized' | 'denied' | 'restricted' | 'not determined' | null;
  fullDiskAccess: 'authorized' | 'denied' | 'restricted' | 'not determined' | null;
  folders: 'unknown' | null;
};
export type MacPermissionType = 'accessibility' | 'fullDiskAccess' | 'folders';

export type MermaidRepairResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

export interface ShellOpResult {
  ok: boolean;
  error?: string;
}

/** Agent settings (Settings → Permissions & Caps) — wire mirror of the core
 *  AgentSettings interface (configStore isn't imported here because its graph
 *  isn't a guaranteed leaf for the renderer typecheck). */
export interface AgentSettingsWire {
  defaultAutonomy: 'plan' | 'ask' | 'edit' | 'full';
  maxSteps: number;
  permissionTimeoutMin: number;
  planModeDryRun: boolean;
  auditShellCommands: boolean;
  compactionEnabled: boolean;
  compactionThreshold: number;
  compactionKeepTurns: number;
  experimentalBackgroundDispatch: boolean;
}

export interface GeneralSettingsWire {
  startAtLogin: boolean;
  notifications: boolean;
  notificationSound: boolean;
  gitCoAuthored: boolean;
  gitCoAuthorName: string;
  gitCoAuthorEmail: string;
  titleModel?: { providerId: string; modelId: string } | null;
  commitMessageModel?: { providerId: string; modelId: string } | null;
  autoUpdateCheck: boolean;
}

// ── Updater wire types ─────────────────────────────────────────────
// Leaf-safe mirror of the devkit Updater's status stream, reduced by the
// shell (app/updater.ts) into the UI-facing phase model. Same rule as the
// session mirrors above: no devkit imports here, structurally compatible.

/** Coarse UI phases the Electrobun status stream reduces to. */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'applying'
  | 'not-available'
  | 'error';

/** Reduced updater snapshot — one per status entry, plus the initial fetch. */
export interface UpdateStatusWire {
  phase: UpdatePhase;
  /** Human-readable status line from the devkit entry. */
  message: string;
  currentVersion: string;
  /** Target version when one is known (available/downloading/downloaded). */
  version: string | null;
  /** Download progress 0-100 while phase is 'downloading'. */
  percent: number | null;
  error: string | null;
  lastCheckedAt: number | null;
}

// ── Provider probe/detect wire types ──────────────────────────────

export type ApiStyle = 'openai' | 'anthropic';

export interface ProviderProbeInput {
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey: string;
}

export type ProviderProbeResult =
  | { ok: true; models: ProviderModelMeta[] }
  | { ok: false; error: string };

export type ProviderDetectResult =
  | { apiStyle: ApiStyle; models: ProviderModelMeta[] }
  | { error: string };

export interface ProviderTestInput extends ProviderProbeInput {
  modelId: string;
}

export type ProviderTestResult = { ok: true } | { ok: false; error: string };

export interface ModelCatalogResolveInput {
  catalogId?: string;
  modelId: string;
  contextWindow: number;
}

export interface ModelCatalogResolveResult {
  meta: {
    contextWindow: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    supportsReasoning: boolean;
    supportsFunctionCalling: boolean;
    supportsPromptCaching: boolean;
    supportsVision: boolean;
    mode: string;
    isValidForMainRole: boolean;
    pricing: { inputPerToken: number; outputPerToken: number } | null;
    resolvedCatalogId: string | null;
    reasoningOptions?: Array<{ type: string; values?: string[]; min?: number }>;
  };
  match: { state: 'matched' | 'ambiguous' | 'none'; matches: unknown[] };
}

export interface WindowUsageWire {
  tokens: number;
  oldestAt: number;
  newestAt: number;
}

export interface ProviderUsageWindowsResult {
  fiveHour: WindowUsageWire;
  weekly: WindowUsageWire;
}

export interface ProviderUsageReportWire {
  source: 'zai' | 'openrouter' | 'deepseek' | 'fireworks';
  planName?: string;
  windows: Array<{
    label: string;
    percent?: number;
    used?: number;
    limit?: number;
    unit: 'tokens' | 'USD' | 'credits';
    resetsAt?: number;
  }>;
}

// ── Git wire types ─────────────────────────────────────────────────
// Payload shapes match the frozen Electron shell's tide:git* channels
// verbatim so the renderer swap is mechanical.

export interface GitFileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
  staged: boolean;
  additions: number;
  deletions: number;
}

export interface GitCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  parents: string[];
  isHead?: boolean;
  branchHeads?: string[];
  tags?: string[];
}

export interface GitBranchDetailed {
  name: string;
  isRemote: boolean;
  upstream?: string;
  shortSha: string;
  subject: string;
  lastCommitUnix: number;
  ahead?: number;
  behind?: number;
}

export type GitConflictState =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them';

export interface GitConflictEntry {
  path: string;
  state: GitConflictState;
}

export type GitBulkOp = 'stage-all' | 'unstage-all' | 'restore-all' | 'stash' | 'stash-pop';

export interface GitOpResult {
  ok: boolean;
  error?: string;
}

export interface GitCommitResult extends GitOpResult {
  sha?: string;
}

export interface GitRevertResult extends GitOpResult {
  newSha?: string;
}

export interface GitMergeResult extends GitOpResult {
  conflicts?: GitConflictEntry[];
}

export interface GitStash {
  ref: string;
  message: string;
}

export interface GitBranchInfoResult {
  branch: string | null;
  headCommit: string | null;
}

export interface GitAheadBehindResult {
  ahead: number;
  behind: number;
}

export interface GitSessionScope {
  workspaceId: string;
  sessionId?: string;
}

// ── Scripts wire types ─────────────────────────────────────────────

export interface ScriptRunResult {
  ok: boolean;
  pid?: number;
  reason?: string;
}

export interface ScriptPort {
  port: number;
  label: string;
  url: string;
}

export interface ScriptOutputEvent {
  workspaceId: string;
  command: string;
  stream: 'stdout' | 'stderr' | 'info';
  line: string;
}

export interface ScriptExitEvent {
  workspaceId: string;
  command: string;
  code: number | null;
}

export interface ScriptPortsEvent {
  workspaceId: string;
  ports: ScriptPort[];
}

export interface ScriptTerminalLine {
  prompt?: boolean;
  cwd?: string;
  cmd?: string;
  text?: string;
  dim?: boolean;
  ok?: boolean;
  warn?: boolean;
  accent?: boolean;
}

// ── Todos / agents / project catalog wire types ────────────────────

export interface TodoItemWire {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
}

export interface TodosUpdatedEvent {
  sessionId: string;
  todos: TodoItemWire[];
}

export interface AgentCatalogEntry {
  name: string;
  description: string;
  whenToUse: string;
}

export interface ProjectEntryWire {
  name: string;
  path: string;
  absPath: string;
  description: string;
  content: string;
  bytes: number;
  truncated: boolean;
  source?: 'project' | 'user';
}

export interface ProjectEntriesResult {
  contextFiles: ProjectEntryWire[];
  skills: ProjectEntryWire[];
  agents: ProjectEntryWire[];
}

// ── Extensions wire types ──────────────────────────────────────────

export interface ExtensionsDisabledSet {
  agents: string[];
  skills: string[];
}

export interface AgentExtensionEntry {
  name: string;
  description: string;
  whenToUse: string;
  source: 'builtin' | 'project' | 'user';
  path?: string;
  enabled: boolean;
}

export interface SkillExtensionEntry {
  name: string;
  description: string;
  source: 'project' | 'user';
  path: string;
  absPath: string;
  enabled: boolean;
}

/** Standard mutation reply for config/pool operations. */
export interface McpOpResult {
  ok: boolean;
  error?: string;
}

/** mcpImport reply — imported carries the server count written. */
export interface McpImportResult {
  ok: boolean;
  imported?: number;
  error?: string;
}

export interface McpRawConfigResult {
  ok: boolean;
  error?: string;
  config?: Record<string, unknown>;
}

/**
 * Pool status push. The Electron shell broadcast an empty
 * `tide:mcp:statusChanged` ping (renderer re-fetched via mcpList); the
 * payload is a discriminated kind so future pushes (logs, per-server
 * transitions) can join the same message without a schema break.
 */
export type McpEvent = { kind: 'statusChanged' };

export interface TideRPC {
  bun: RPCSchema<{
    requests: {
      settingsGet: {
        params: {};
        response: { overrides: ShortcutOverrides; defaults: Record<string, string[]> };
      };
      settingsSetShortcut: {
        params: { id: string; keys: string[] | null };
        response: { overrides: ShortcutOverrides };
      };
      settingsResetShortcuts: {
        params: {};
        response: { overrides: ShortcutOverrides };
      };
      eventsSubscribe: {
        params: { sessionId: string; lastSeq: number | null };
        response: { batches: FlushBatch[] };
      };
      eventsUnsubscribe: {
        params: { sessionId: string };
        response: {};
      };
      sessionList: {
        params: { workspaceId: string };
        response: SessionHeader[];
      };
      sessionListDispatches: {
        params: { parentId: string };
        response: SessionHeader[];
      };
      sessionGet: {
        params: { sessionId: string };
        response: HydratedSession | null;
      };
      sessionCreate: {
        params: { workspaceId: string; title: string; modelId: string; opts?: SessionCreateOpts };
        response: HydratedSession;
      };
      sessionUpdateSettings: {
        params: { sessionId: string; patch: SessionSettingsPatch };
        response: {};
      };
      sessionAddMessage: {
        params: { sessionId: string; role: 'user' | 'assistant' | 'system'; content: string; extra?: SessionMessageExtra };
        response: {};
      };
      sessionAddAssistantMessage: {
        params: { sessionId: string; message: AssistantMessageInput };
        response: {};
      };
      sessionFinalizeAssistantMessage: {
        params: { sessionId: string; messageId: string; message: FinalizeAssistantMessageInput };
        response: {};
      };
      sessionAddUsage: {
        params: { sessionId: string; delta: SessionUsageDelta; lastStepUsage?: SessionUsageDelta };
        response: {};
      };
      sessionDelete: {
        params: { sessionId: string };
        response: {};
      };
      sessionClearAll: {
        params: {};
        response: { ok: boolean };
      };
      sessionRename: {
        params: { sessionId: string; title: string };
        response: {};
      };
      sessionGenerateTitle: {
        params: { sessionId: string };
        response: { title: string | null };
      };
      sessionArchive: {
        params: { sessionId: string };
        response: {};
      };
      sessionUnarchive: {
        params: { sessionId: string };
        response: {};
      };
      sessionListArchived: {
        params: { workspaceId: string };
        response: ArchivedSessionHeader[];
      };
      sessionCreateWorktree: {
        params: { sessionId: string; opts: { branchName: string; baseBranch: string; configFiles?: string[] } };
        response: SessionWorktree;
      };
      sessionRemoveWorktree: {
        params: { sessionId: string };
        response: {};
      };
      sessionFork: {
        params: { sourceId: string; newModelId: string; opts?: SessionCreateOpts };
        response: HydratedSession;
      };
      sessionListV2: {
        params: { workspacePath: string; opts?: SessionListOptsV2 };
        response: { sessions: SessionMetaV2[]; nextCursor: string | null };
      };
      sessionMessagesV2: {
        params: { sessionId: string; opts?: SessionWindowOptsV2 };
        response: { messages: SessionMessageV2[]; nextBefore: string | null };
      };
      chatSend: {
        params: ChatSendParams;
        response: ChatSendResult;
      };
      chatAbort: {
        params: { sessionId: string };
        response: {};
      };
      chatApproveTools: {
        params: { sessionId: string; toolCallIds: string[]; newMode?: SessionAutonomyMode; remember?: boolean };
        response: {};
      };
      chatRejectTools: {
        params: { sessionId: string; toolCallIds: string[]; reason?: string };
        response: {};
      };
      chatSubmitFollowup: {
        params: ChatSubmitFollowupParams;
        response: { resolved: boolean };
      };
      chatUpdateMode: {
        params: { sessionId: string; mode: SessionAutonomyMode };
        response: {};
      };
      terminalCreate: {
        params: { terminalId: string; sessionId: string; cols?: number; rows?: number };
        response: {};
      };
      terminalWrite: {
        params: { terminalId: string; data: string };
        response: {};
      };
      terminalResize: {
        params: { terminalId: string; cols: number; rows: number };
        response: {};
      };
      terminalStop: {
        params: { terminalId: string };
        response: {};
      };
      terminalKill: {
        params: { terminalId: string };
        response: {};
      };
      terminalDispose: {
        params: {};
        response: {};
      };
      terminalScrollback: {
        params: { terminalId: string };
        response: TerminalScrollbackResult;
      };
      terminalGetPid: {
        params: { terminalId: string };
        response: { pid: number | null };
      };
      processIsAlive: {
        params: { pid: number };
        response: { alive: boolean };
      };
      mcpList: {
        params: { workspaceId?: string };
        response: McpServerStatus[];
      };
      mcpAdd: {
        params: { name: string; config: McpServerConfig; scope: McpScope };
        response: McpOpResult;
      };
      mcpUpdate: {
        params: { name: string; config: McpServerConfig; scope: McpScope };
        response: McpOpResult;
      };
      mcpRemove: {
        params: { name: string; scope: McpScope };
        response: McpOpResult;
      };
      mcpApprove: {
        params: { name: string };
        response: { ok: boolean };
      };
      mcpRetry: {
        params: { name: string; scope: McpScope; workspaceId?: string };
        response: { ok: boolean };
      };
      mcpAuthenticate: {
        params: { name: string; scope: McpScope; workspaceId?: string };
        response: { ok: boolean };
      };
      mcpReinitialize: {
        params: Record<string, never>;
        response: { ok: boolean };
      };
      mcpSetSecret: {
        params: { name: string; value: string };
        response: { ok: boolean };
      };
      mcpHasSecret: {
        params: { name: string };
        response: { has: boolean };
      };
      mcpClearSecret: {
        params: { name: string };
        response: { ok: boolean };
      };
      mcpReauthorize: {
        params: { name: string; scope: McpScope; workspaceId?: string };
        response: { ok: boolean };
      };
      mcpScan: {
        params: Record<string, never>;
        response: McpScanResult;
      };
      mcpImport: {
        params: { servers: Array<{ name: string; config: McpServerConfig }>; scope: McpScope };
        response: McpImportResult;
      };
      mcpSetEnabled: {
        params: { name: string; enabled: boolean; scope: McpScope };
        response: { ok: boolean };
      };
      mcpReadRaw: {
        params: { scope: McpScope };
        response: McpRawConfigResult;
      };
      mcpWriteRaw: {
        params: { config: Record<string, unknown>; scope: McpScope };
        response: McpOpResult;
      };
      mcpWorkspaceActivated: {
        params: { workspaceId: string; workspaceRoot: string };
        response: { ok: boolean };
      };
      ragStatus: {
        params: { workspaceId: string };
        response: RagStatus | { error: string };
      };
      ragDownloadModel: {
        params: {};
        response: RagWorkspaceOpResult;
      };
      ragModelExists: {
        params: {};
        response: boolean;
      };
      ragEnableWorkspace: {
        params: { workspaceId: string };
        response: RagWorkspaceOpResult;
      };
      ragDisableWorkspace: {
        params: { workspaceId: string };
        response: RagWorkspaceOpResult;
      };
      ragInitWorkspace: {
        params: { workspaceId: string };
        response: RagInitResult;
      };
      sourcesList: {
        params: { workspaceId?: string };
        response: SourcesListResult;
      };
      sourcesAdd: {
        params: { name: string; kind: SourceKind; location: string; enabledWorkspaceIds?: string[] };
        response: SourcesAddResult;
      };
      sourcesUpdate: {
        params: SourcesUpdateParams;
        response: SourcesOpResult;
      };
      sourcesRemove: {
        params: { id: string };
        response: SourcesOpResult;
      };
      sourcesSetEnabled: {
        params: { id: string; workspaceId: string; enabled: boolean };
        response: SourcesOpResult;
      };
      sourcesReindex: {
        params: { id: string };
        response: SourcesOpResult;
      };
      workspaceList: {
        params: {};
        response: Workspace[];
      };
      workspaceGet: {
        params: { workspaceId: string };
        response: Workspace | null;
      };
      workspaceAdd: {
        params: { input: WorkspaceAddInput };
        response: Workspace;
      };
      workspaceUpdate: {
        params: { workspaceId: string; patch: Partial<Workspace> };
        response: Workspace | null;
      };
      workspaceArchive: {
        params: { workspaceId: string };
        response: {};
      };
      workspaceUnarchive: {
        params: { workspaceId: string };
        response: {};
      };
      workspaceDelete: {
        params: { workspaceId: string };
        response: { ok: boolean; error?: string };
      };
      workspacesExist: {
        params: { paths: string[] };
        response: Record<string, boolean>;
      };
      lastSessionGet: {
        params: {};
        response: { sessionId: string | null; workspaceId: string | null };
      };
      lastSessionSet: {
        params: { sessionId: string | null; workspaceId: string | null };
        response: {};
      };
      workspaceListBranches: {
        params: { workspaceId: string };
        response: string[];
      };
      workspaceListConfigFiles: {
        params: { workspaceId: string };
        response: string[];
      };
      fileTreeGet: {
        params: { workspaceId: string };
        response: FileNode[];
      };
      workspaceContextGet: {
        params: { workspaceId: string };
        response: string;
      };
      workspaceFileRead: {
        params: { workspaceId: string; relPath: string };
        response: WorkspaceFileReadResult;
      };
      gitRepoDetect: {
        params: { dirPath: string };
        response: GitRepoInfo | null;
      };
      dialogPickDirectory: {
        params: {};
        response: { path: string | null };
      };
      dialogPickFiles: {
        params: {};
        response: { paths: string[] };
      };
      externalFileRead: {
        params: { filePath: string };
        response: ExternalFileContent | null;
      };
      imageFileRead: {
        params: { absPath?: string; workspaceId?: string; relPath?: string };
        response: ImageFileContent | null;
      };
      clipboardFileSave: {
        params: { name: string; dataBase64: string };
        response: { path: string };
      };
      envInfoGet: {
        params: {};
        response: EnvInfo;
      };
      diagnosticsGet: {
        params: {};
        response: DiagnosticsInfo;
      };
      permissionStatusGet: {
        params: {};
        response: MacPermissionStatus;
      };
      permissionRequest: {
        params: { type: MacPermissionType };
        response: { result: 'opened' | 'unavailable' };
      };
      consentShouldShow: {
        params: {};
        response: { shouldShow: boolean };
      };
      mermaidRepair: {
        params: { source: string; error: string };
        response: MermaidRepairResult;
      };
      logSend: {
        params: { level: string; tag: string; msg: string; args?: unknown[] };
        response: {};
      };
      shellOpenExternal: {
        params: { url: string };
        response: { ok: boolean };
      };
      shellShowItemInFolder: {
        params: { fullPath: string };
        response: {};
      };
      shellOpenPath: {
        params: { path: string };
        response: ShellOpResult;
      };
      openInAppDetect: {
        params: {};
        response: ExternalApp[];
      };
      openInAppOpen: {
        params: { target: ExternalAppTarget; sessionId?: string };
        response: ShellOpResult;
      };
      windowIsFullScreen: {
        params: {};
        response: { fullscreen: boolean };
      };
      windowMinimize: {
        params: {};
        response: {};
      };
      windowToggleMaximize: {
        params: {};
        response: { maximized: boolean };
      };
      windowClose: {
        params: {};
        response: {};
      };
      settingsGetAgent: {
        params: {};
        response: AgentSettingsWire;
      };
      settingsUpdateAgent: {
        params: { patch: Partial<AgentSettingsWire> };
        response: AgentSettingsWire;
      };
      settingsGetGeneral: {
        params: {};
        response: GeneralSettingsWire;
      };
      settingsUpdateGeneral: {
        params: { patch: Partial<GeneralSettingsWire> };
        response: GeneralSettingsWire;
      };
      providerList: {
        params: {};
        response: Provider[];
      };
      providerAdd: {
        params: { input: { name: string; apiStyle: ApiStyle; baseUrl: string; apiKey?: string; models?: { alias: string; modelId: string; contextWindow: number }[] } };
        response: Provider;
      };
      providerUpdate: {
        params: { providerId: string; patch: Partial<Provider> };
        response: Provider | null;
      };
      providerDelete: {
        params: { providerId: string };
        response: { ok: boolean };
      };
      providerProbeModels: {
        params: { input: ProviderProbeInput };
        response: ProviderProbeResult;
      };
      providerDetectProtocol: {
        params: { baseUrl: string; apiKey: string };
        response: ProviderDetectResult;
      };
      providerTestConnection: {
        params: { input: ProviderTestInput };
        response: ProviderTestResult;
      };
      modelCatalogResolve: {
        params: ModelCatalogResolveInput;
        response: ModelCatalogResolveResult;
      };
      modelCatalogRefresh: {
        params: {};
        response: { ok: boolean };
      };
      providerUsageWindows: {
        params: { providerId: string };
        response: ProviderUsageWindowsResult;
      };
      providerUsageReport: {
        params: { providerId: string };
        response: ProviderUsageReportWire | null;
      };
      gitStatus: {
        params: GitSessionScope;
        response: GitFileChange[];
      };
      gitLog: {
        params: GitSessionScope & { limit?: number };
        response: GitCommit[];
      };
      gitCommitFiles: {
        params: GitSessionScope & { sha: string };
        response: GitFileChange[];
      };
      gitCommitFileDiff: {
        params: GitSessionScope & { sha: string; filePath: string };
        response: DiffHunk[];
      };
      gitBulk: {
        params: GitSessionScope & { op: GitBulkOp; opts?: { message?: string } };
        response: GitOpResult;
      };
      gitStashList: {
        params: GitSessionScope;
        response: GitStash[];
      };
      gitBranchInfo: {
        params: GitSessionScope;
        response: GitBranchInfoResult;
      };
      gitRecentBranches: {
        params: GitSessionScope;
        response: string[];
      };
      gitCheckout: {
        params: GitSessionScope & { branch: string };
        response: GitOpResult;
      };
      gitCreateBranch: {
        params: GitSessionScope & { branchName: string; sha?: string };
        response: GitOpResult;
      };
      gitStage: {
        params: GitSessionScope & { filePath: string; stage: boolean };
        response: GitOpResult;
      };
      gitCommit: {
        params: GitSessionScope & { message: string };
        response: GitCommitResult;
      };
      gitDiff: {
        params: GitSessionScope & { filePath: string; staged: boolean; contextLines?: number };
        response: DiffHunk[];
      };
      gitHeadSha: {
        params: GitSessionScope;
        response: { sha: string | null };
      };
      gitRestoreFile: {
        params: GitSessionScope & { filePath: string; sha: string };
        response: GitOpResult;
      };
      gitAmend: {
        params: GitSessionScope & { message: string | null };
        response: GitCommitResult;
      };
      gitRevert: {
        params: GitSessionScope & { sha: string };
        response: GitRevertResult;
      };
      gitFetch: {
        params: GitSessionScope;
        response: GitOpResult;
      };
      gitPush: {
        params: GitSessionScope;
        response: GitOpResult;
      };
      gitPull: {
        params: GitSessionScope;
        response: GitOpResult;
      };
      gitAheadBehind: {
        params: GitSessionScope;
        response: GitAheadBehindResult | null;
      };
      gitBranchesDetailed: {
        params: GitSessionScope;
        response: GitBranchDetailed[];
      };
      gitDeleteBranch: {
        params: GitSessionScope & { name: string; force: boolean };
        response: GitOpResult;
      };
      gitMergeBranch: {
        params: GitSessionScope & { name: string };
        response: GitMergeResult;
      };
      gitConflictFiles: {
        params: GitSessionScope;
        response: GitConflictEntry[];
      };
      gitResolveFile: {
        params: GitSessionScope & { filePath: string; side: 'ours' | 'theirs' };
        response: GitOpResult;
      };
      gitStagedDiff: {
        params: GitSessionScope;
        response: { text: string };
      };
      gitCommitMessage: {
        params: GitSessionScope & { sha: string };
        response: { text: string };
      };
      gitDiscardFile: {
        params: GitSessionScope & { filePath: string };
        response: GitOpResult;
      };
      scriptRun: {
        params: { workspaceId: string; command: string };
        response: ScriptRunResult;
      };
      scriptStop: {
        params: { workspaceId: string; command: string };
        response: { ok: boolean; reason?: string };
      };
      scriptLines: {
        params: { workspaceId: string };
        response: { lines: ScriptTerminalLine[] };
      };
      scriptPorts: {
        params: { workspaceId: string };
        response: { ports: ScriptPort[] };
      };
      agentList: {
        params: {};
        response: AgentCatalogEntry[];
      };
      projectEntriesList: {
        params: { workspaceId: string };
        response: ProjectEntriesResult;
      };
      todosList: {
        params: { sessionId: string };
        response: { todos: TodoItemWire[] };
      };
      extensionsList: {
        params: {};
        response: ExtensionsDisabledSet;
      };
      extensionsSetEnabled: {
        params: { domain: 'agents' | 'skills'; name: string; enabled: boolean };
        response: {};
      };
      extensionsListAgents: {
        params: { workspaceRoot: string };
        response: AgentExtensionEntry[];
      };
      extensionsListSkills: {
        params: { workspaceRoot: string };
        response: SkillExtensionEntry[];
      };
      updaterStatus: {
        params: Record<string, never>;
        response: { status: UpdateStatusWire | null };
      };
      updaterCheckNow: {
        params: Record<string, never>;
        response: { ok: boolean; error?: string };
      };
      updaterReleaseNotes: {
        params: { version: string };
        response: { markdown: string | null };
      };
      /** Consent action 1 — download only; stops at ready. */
      updaterDownload: {
        params: Record<string, never>;
        response: { ok: boolean; error?: string };
      };
      /** Consent action 2 — apply a prepared update (swap + relaunch). */
      updaterApply: {
        params: Record<string, never>;
        response: { ok: boolean; error?: string };
      };
    };
    messages: {};
  }>
  webview: RPCSchema<{
    requests: {};
    messages: {
      orchestratorEvents: { params: FlushBatch };
      agentEvents: { params: AgentEvent };
      updateStatus: { params: UpdateStatusWire };
      terminalOutput: { params: { terminalId: string; data: string; seq: number } };
      terminalExit: { params: { terminalId: string; code: number | null } };
      terminalPorts: { params: { terminalId: string; ports: TerminalPort[] } };
      mcpEvents: { params: McpEvent };
      ragProgress: { params: RagProgressMessage };
      sourcesProgress: { params: SourceProgressEvent };
      workspaceProgress: { params: WorkspaceProgressEvent };
      gitChanged: { params: { workspaceId: string } };
      todosUpdated: { params: TodosUpdatedEvent };
      scriptOutput: { params: ScriptOutputEvent };
      scriptExit: { params: ScriptExitEvent };
      scriptPorts: { params: ScriptPortsEvent };
    };
  }>;
}
