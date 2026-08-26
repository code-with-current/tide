/** API client — the single swap point between mock data and real IPC. Uses the Electrobun RPC bridge when inside a webview, otherwise falls back to the in-memory mock store (plain browser dev). */

import { rpc, setTerminalOutputCallback, setTerminalExitCallback, setTerminalPortsCallback, onMcpEvent, onRagProgress, onSourcesProgress, onWorkspaceProgress, onGitChanged as onGitChangedRpc, onTodosUpdated as onTodosUpdatedRpc, setScriptOutputCallback, setScriptExitCallback, setScriptPortsCallback } from './rpc';
import type {
  McpImportResult,
  McpOpResult,
  McpRawConfigResult,
  McpScanResult,
  McpScope,
  McpServerConfig,
  McpServerStatus,
  UpdateStatusWire,
} from '@shared/rpc';
import type { RunTurnPayload } from '@/lib/agent/events';
import {
  allSessions,
  fileTree,
  providers as mockProviders,
  sessionsByWorkspace,
  terminalLines,
  workspaces as mockWorkspaces,
} from '../mock/data';
import type {
  ApiStyle,
  ArchivedHeader,
  DiffHunk,
  KnowledgeSource,
  Provider,
  ProviderModelMeta,
  RagDownloadProgressEvent,
  RagInitProgressEvent,
  RagInitResult,
  RagStatus,
  SourceKind,
  SourceProgressEvent,
  WorkspaceProgressEvent,
  RagWorkspaceOpResult,
  Workspace,
  WorkspaceScript,
  Session,
} from '@/types';
import type { FlushBatchV2, MessageWithPartsV2, SessionMetaV2 } from '@/types/session-v2';

// ── Mock helpers (browser fallback) ─────────────────────────────
const delay = (ms = 120) => new Promise<void>((r) => setTimeout(r, ms));

const clone = <T>(v: T): T =>
  typeof structuredClone !== 'undefined'
    ? structuredClone(v)
    : JSON.parse(JSON.stringify(v));

// ============================================================
// Settings (settings.json — shortcut overrides)
// Electrobun RPC bridge; null in browser dev so the caller keeps
// hardcoded defaults.
// ============================================================

export async function getSettings(): Promise<{
  overrides: Record<string, string[]>;
  defaults: Record<string, string[]>;
} | null> {
  if (rpc) return rpc.request.settingsGet({});
  return null;
}

export async function setShortcut(
  id: string,
  keys: string[] | null,
): Promise<Record<string, string[]> | null> {
  if (rpc) return (await rpc.request.settingsSetShortcut({ id, keys })).overrides;
  return null;
}

export async function resetShortcuts(): Promise<Record<string, string[]> | null> {
  if (rpc) return (await rpc.request.settingsResetShortcuts({})).overrides;
  return null;
}

// ============================================================
// File dialog + git detection (native dialogs via the Electrobun RPC
// bridge — devkit Utils.openFileDialog; browser returns null/empty)
// ============================================================

export async function pickDirectory(): Promise<string | null> {
  if (rpc) return (await rpc.request.dialogPickDirectory({})).path;
  return null;
}

export async function pickFiles(): Promise<string[]> {
  if (rpc) return (await rpc.request.dialogPickFiles({})).paths;
  return [];
}

export async function readExternalFile(filePath: string): Promise<{ content: string; bytes: number; truncated: boolean } | null> {
  if (rpc) return rpc.request.externalFileRead({ filePath });
  return null;
}

/** Read an image as a base64 data URL for <img> rendering in the viewer.
 *  Accepts an absolute path (external attachment) or workspace+relPath. */
export async function readImageFile(input: { absPath?: string; workspaceId?: string; relPath?: string }): Promise<{ dataUrl: string; bytes: number } | null> {
  if (rpc) return rpc.request.imageFileRead(input);
  return null;
}

/** base64 of raw bytes. String.fromCharCode must not be spread over the whole
 *  buffer — argument lists cap around 64KB (RangeError) — so encode in 32KB
 *  chunks. */
export function arrayBufferToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const CHUNK = 32 * 1024;
  let binary = '';
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Persist clipboard-blob bytes (pasted screenshots have no file on disk) so
 *  the attachment gets a real absolute path. Takes base64 on the RPC wire
 *  (ArrayBuffer doesn't survive it). */
export async function saveClipboardFile(name: string, bytes: ArrayBuffer): Promise<string> {
  if (rpc) {
    const b64 = arrayBufferToBase64(bytes);
    return (await rpc.request.clipboardFileSave({ name, dataBase64: b64 })).path;
  }
  return '';
}

export interface GitRepoInfo {
  branch: string;
  headCommit: string;
  fileCount: number;
  isRepo: boolean;
}

export async function detectGitRepo(dirPath: string): Promise<GitRepoInfo | null> {
  if (rpc) return rpc.request.gitRepoDetect({ dirPath });
  return null;
}

export async function addWorkspace(input: {
  path: string;
  name?: string;
  repository?: string;
  template?: import('@/lib/templates').TemplateId;
  scripts?: WorkspaceScript[];
  initGit?: boolean;
  requestId?: string;
}): Promise<Workspace> {
  if (rpc) return rpc.request.workspaceAdd({ input });
  await delay(300);
  return {
    id: `ws_${Math.random().toString(36).slice(2, 10)}`,
    name: input.name || input.path.split('/').pop() || 'workspace',
    path: input.path,
    branch: 'main',
    headCommit: 'unknown',
    isDefault: false,
    fileCount: 0,
    worktreeLocation: '.agent/worktrees/',
    scripts: input.scripts ?? [],
  };
}

// ============================================================
// Workspaces
// ============================================================

export async function listWorkspaces(): Promise<Workspace[]> {
  if (rpc) return rpc.request.workspaceList({});
  await delay();
  return clone(mockWorkspaces);
}

export async function getWorkspace(id: string): Promise<Workspace | undefined> {
  if (rpc) return (await rpc.request.workspaceGet({ workspaceId: id })) ?? undefined;
  await delay();
  return clone(mockWorkspaces.find((w) => w.id === id));
}

export async function getLastSession(): Promise<{ sessionId: string | null; workspaceId: string | null }> {
  if (rpc) return rpc.request.lastSessionGet({});
  await delay();
  return { sessionId: null, workspaceId: null };
}

export async function setLastSession(sessionId: string | null, workspaceId: string | null): Promise<void> {
  if (rpc) {
    await rpc.request.lastSessionSet({ sessionId, workspaceId });
    return;
  }
}

/** Batch liveness probe: which workspace folders still exist on disk? */
export async function workspacesExist(paths: string[]): Promise<Record<string, boolean>> {
  if (rpc) return rpc.request.workspacesExist({ paths });
  return {};
}

/** Subscribe to the add-workspace progress pushes. No-op with no backend. */
export function subscribeWorkspaceProgress(cb: (e: WorkspaceProgressEvent) => void): () => void {
  if (rpc) return onWorkspaceProgress(cb);
  return () => {};
}

// ============================================================
// Sessions
// ============================================================

export async function listSessions(workspaceId: string): Promise<any[]> {
  if (rpc) return rpc.request.sessionList({ workspaceId });
  await delay();
  return clone(sessionsByWorkspace[workspaceId] ?? []);
}

export async function listDispatches(parentId: string): Promise<any[]> {
  if (rpc) return rpc.request.sessionListDispatches({ parentId });
  await delay();
  return [];
}

/** Built-in sub-agents for the @mention picker + dispatch_agent catalog. */
export async function listAgents(): Promise<{ name: string; description: string; whenToUse: string }[]> {
  if (rpc) return rpc.request.agentList({});
  // Mock fallback (browser dev) — keep the catalog names in sync
  // with src/lib/prompts/agents/.
  return [
    { name: 'general-purpose', description: 'Broad-spectrum investigator with direct tool access.', whenToUse: 'Multi-step research, analysis, or execution.' },
    { name: 'explore', description: 'Read-only code locator and search strategist.', whenToUse: 'Finding files, symbols, or call sites.' },
    { name: 'code-reviewer', description: 'Finds correctness bugs in a diff with verification.', whenToUse: 'Reviewing changes for runtime-correctness bugs.' },
    { name: 'simplifier', description: 'Applies reuse/simplification/efficiency/altitude cleanups.', whenToUse: 'Cleaning up changed code and applying fixes.' },
    { name: 'codebase-orchestrator', description: 'Refactor governance with approval gates.', whenToUse: 'Repo-wide refactor planning.' },
  ];
}

export interface ProjectEntry {
  name: string;
  path: string;
  /** Absolute path — handed to the model so it can read_file the entry. */
  absPath: string;
  description: string;
  content: string;
  bytes: number;
  truncated: boolean;
  /** Where the entry was found — drives a badge in the picker. */
  source?: 'project' | 'user';
}

/** Scan a workspace for CLAUDE.md/AGENT.md + .claude|.agent/skills|agents.
 *  Returns empty lists if the workspace has none. */
export async function listProjectEntries(workspaceId: string): Promise<{
  contextFiles: ProjectEntry[];
  skills: ProjectEntry[];
  agents: ProjectEntry[];
}> {
  if (rpc) return rpc.request.projectEntriesList({ workspaceId });
  return { contextFiles: [], skills: [], agents: [] };
}

/** Todos for a session — model-maintained via the todo_write tool. Flat list. */
export async function listTodos(sessionId: string): Promise<{
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
}[]> {
  if (rpc) return (await rpc.request.todosList({ sessionId })).todos;
  return [];
}

/** Live todo updates pushed from the main process — the RPC bridge's
 *  todosUpdated message arrives without a subscribe call. */
export function onTodosUpdated(cb: (data: { sessionId: string; todos: any[] }) => void): () => void {
  if (rpc) return onTodosUpdatedRpc(cb);
  return () => {};
}

export async function getSession(id: string): Promise<any> {
  if (rpc) return rpc.request.sessionGet({ sessionId: id });
  await delay();
  return clone(allSessions.find((s) => s.id === id));
}

export async function createSession(
  workspaceId: string,
  title: string,
  modelId: string,
  opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string; kind?: 'main' | 'subagent' },
): Promise<any> {
  if (rpc) return rpc.request.sessionCreate({ workspaceId, title, modelId, opts });
  await delay(200);
  return {
    id: `s_${Math.random().toString(36).slice(2, 10)}`,
    workspaceId, title, modelId, messages: [],
    providerId: opts?.providerId,
    autonomyMode: opts?.autonomyMode ?? 'ask',
    thinkingLevel: opts?.thinkingLevel ?? 'medium',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function updateSessionSettings(
  sessionId: string,
  patch: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max' },
): Promise<void> {
  if (rpc) {
    await rpc.request.sessionUpdateSettings({ sessionId, patch });
    return;
  }
  await delay(50);
}

export async function addMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  extra?: { attachments?: any[]; mentions?: any[] },
): Promise<void> {
  if (rpc) {
    await rpc.request.sessionAddMessage({ sessionId, role, content, extra });
    return;
  }
}

/** Persist a full assistant message (with reasoning + tool calls). Used by the agent-loop path. Falls back to addMessage(content) when no backend is available. */
export async function addAssistantMessage(
  sessionId: string,
  message: {
    content: string;
    reasoning?: string;
    reasoningTokens?: number;
    reasoningMs?: number;
    totalMs?: number;
    toolCalls?: any[];
    timeline?: any[];
    turn?: any;
  },
): Promise<void> {
  if (rpc) {
    await rpc.request.sessionAddAssistantMessage({ sessionId, message });
    return;
  }
  await addMessage(sessionId, 'assistant', message.content);
}

/** Upsert the final assistant message by messageId — updates the streaming
 *  partial in place (avoids partial + finalize duplicates). */
export async function finalizeAssistantMessage(
  sessionId: string,
  messageId: string,
  message: {
    content: string;
    blocks?: any[];
    reasoning?: string;
    reasoningTokens?: number;
    reasoningMs?: number;
    totalMs?: number;
    toolCalls?: any[];
    timeline?: any[];
    turn?: any;
    compactionInfo?: { tokensBefore: number; tokensAfter: number };
    stopReason?: string | null;
  },
): Promise<void> {
  if (rpc) {
    await rpc.request.sessionFinalizeAssistantMessage({ sessionId, messageId, message });
    return;
  }
  await addMessage(sessionId, 'assistant', message.content);
}

/** Accumulate a turn's usage into the session's cumulative totals (drives the context-window meter in the right panel). No-op without a backend (mock mode) — usage is purely informational. */
export async function addSessionUsage(
  sessionId: string,
  delta: {
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoningTokens?: number;
    calls?: number;
    costUsd?: number;
  },
  lastStepUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoningTokens?: number;
    calls?: number;
    costUsd?: number;
  },
): Promise<void> {
  if (rpc) {
    await rpc.request.sessionAddUsage({ sessionId, delta, lastStepUsage });
    return;
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (rpc) {
    await rpc.request.sessionDelete({ sessionId: id });
    return;
  }
}

export async function clearAllSessions(): Promise<{ ok: boolean }> {
  if (rpc) return rpc.request.sessionClearAll({});
  return { ok: false };
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  if (rpc) {
    await rpc.request.sessionRename({ sessionId, title });
    return;
  }
}

/** Best-effort LLM title generation. Returns the new title or null (placeholder kept). Fire-and-forget — don't await on the critical path; just invalidate the sessions query on resolve so the sidebar picks up the rename. */
export async function generateSessionTitle(sessionId: string): Promise<string | null> {
  if (rpc) return (await rpc.request.sessionGenerateTitle({ sessionId })).title;
  return null;
}

export async function archiveSession(sessionId: string): Promise<void> {
  if (rpc) {
    await rpc.request.sessionArchive({ sessionId });
    return;
  }
}

export async function unarchiveSession(sessionId: string): Promise<void> {
  if (rpc) {
    await rpc.request.sessionUnarchive({ sessionId });
    return;
  }
}

export async function listArchivedSessions(workspaceId: string): Promise<ArchivedHeader[]> {
  if (rpc) return rpc.request.sessionListArchived({ workspaceId });
  return [];
}

// ─── Worktree lifecycle ────────────────────────────────────────────
// Per-session git isolation. createWorktree runs `git worktree add`
// against the session's workspace; the orchestrator picks up
// session.worktree.path on the next turn.

export interface WorktreeInfo {
  branch: string;
  path: string;
  baseBranch: string;
  baseCommit: string;
  ahead: number;
  behind: number;
}

export async function createWorktree(
  sessionId: string,
  opts: { branchName: string; baseBranch: string; configFiles?: string[] },
): Promise<WorktreeInfo> {
  if (rpc) return rpc.request.sessionCreateWorktree({ sessionId, opts });
  throw new Error('RPC unavailable');
}

export async function removeWorktree(sessionId: string): Promise<void> {
  if (rpc) {
    await rpc.request.sessionRemoveWorktree({ sessionId });
    return;
  }
}

/** Fork a session into a new session with a different model; an LLM summary of the source conversation is generated and stored as the first message. */
export async function forkSession(
  sourceId: string,
  newModelId: string,
  opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string },
): Promise<Session> {
  if (rpc) return rpc.request.sessionFork({ sourceId, newModelId, opts }) as Promise<Session>;
  throw new Error('forkSession requires the app backend');
}

export async function listBranches(workspaceId: string): Promise<string[]> {
  if (rpc) return rpc.request.workspaceListBranches({ workspaceId });
  return [];
}

export async function listConfigFiles(workspaceId: string): Promise<string[]> {
  if (rpc) return rpc.request.workspaceListConfigFiles({ workspaceId });
  return [];
}

// ─── Part-normalized v2 sessions + event stream ────────────────────

/** List v2 sessions by workspace path. Browser dev mode resolves empty —
 *  there is no v2 store without the main process. */
export async function listSessionsV2(
  workspacePath: string,
  opts?: { archived?: boolean; cursor?: string | null; limit?: number },
): Promise<{ sessions: SessionMetaV2[]; nextCursor: string | null }> {
  if (rpc) return rpc.request.sessionListV2({ workspacePath, opts });
  return { sessions: [], nextCursor: null };
}

export async function listSessionMessagesV2(
  sessionId: string,
  opts?: { limit?: number; before?: string | null },
): Promise<{ messages: MessageWithPartsV2[]; nextBefore: string | null }> {
  if (rpc) return rpc.request.sessionMessagesV2({ sessionId, opts });
  return { messages: [], nextBefore: null };
}

/** (Re)subscribe to a session's event stream. Persisted events (seq > lastSeq)
 *  replay synchronously as the response batches; live batches arrive as
 *  orchestratorEvents pushes. Browser dev resolves empty. */
export async function eventsSubscribe(sessionId: string, lastSeq: number | null): Promise<FlushBatchV2[]> {
  if (rpc) return (await rpc.request.eventsSubscribe({ sessionId, lastSeq })).batches;
  return [];
}

/** Drop the live subscription for a session — session switches must not
 *  leak pushes. */
export async function eventsUnsubscribe(sessionId: string): Promise<void> {
  if (rpc) await rpc.request.eventsUnsubscribe({ sessionId });
}

/** Live event-batch pushes. The RPC bridge delivers batches via its own
 *  orchestratorEvents message (consumed by the stream store), so this is a
 *  reserved no-op kept for the v2 read-path API. */
export function subscribeEvents(_cb: (batch: FlushBatchV2) => void): () => void {
  return () => {};
}

// ============================================================
// Chat — the turn loop (send/abort + permission & followup commands).
// Electrobun RPC tier; no-op mock in browser dev.
// ============================================================

export type ChatSendResult = { accepted: true } | { accepted: false; error: string };

/** Start a turn. The Electrobun RPC bridge follows the job pattern: the
 *  request returns as soon as the main process accepts (or pre-flight
 *  rejects) — all streaming arrives as events. */
export async function chatSend(payload: RunTurnPayload): Promise<ChatSendResult> {
  if (rpc) return rpc.request.chatSend(payload);
  return { accepted: true };
}

/** Abort a session's in-flight turn (fire-and-forget — the orchestrator's
 *  turn_end event with the partial work drives cleanup). */
export function chatAbort(sessionId: string): void {
  if (rpc) {
    void rpc.request.chatAbort({ sessionId });
    return;
  }
}

/** Approve gated tool calls; `newMode` escalates autonomy for the turn,
 *  `remember` persists a permission rule. */
export function chatApproveTools(
  sessionId: string,
  toolCallIds: string[],
  newMode?: 'plan' | 'ask' | 'edit' | 'full',
  remember?: boolean,
): void {
  if (rpc) {
    void rpc.request.chatApproveTools({ sessionId, toolCallIds, newMode, remember });
    return;
  }
}

/** Reject gated tool calls with an optional reason. */
export function chatRejectTools(sessionId: string, toolCallIds: string[], reason?: string): void {
  if (rpc) {
    void rpc.request.chatRejectTools({ sessionId, toolCallIds, reason });
    return;
  }
}

/** Answer a live ask_followup_question. True = the paused turn's awaiting
 *  tool resolved; false = no pending ask (send it as a user message). */
export async function chatSubmitFollowup(
  sessionId: string,
  toolCallId: string,
  answer: string,
): Promise<boolean> {
  if (rpc) return (await rpc.request.chatSubmitFollowup({ sessionId, toolCallId, answer })).resolved;
  return false;
}

/** Live-update the autonomy mode on a running turn (mid-stream). */
export function chatUpdateMode(sessionId: string, mode: 'plan' | 'ask' | 'edit' | 'full'): void {
  if (rpc) {
    void rpc.request.chatUpdateMode({ sessionId, mode });
    return;
  }
}

// ============================================================
// Terminals — the bottom-panel PTYs. Electrobun RPC tier; browser dev
// has no real terminals.
// ============================================================

export interface TerminalPort {
  port: number;
  url: string;
  label: string;
}

export type TerminalSnapshot =
  | { alive: true; data: string; seq: number }
  | { alive: false };

/** True when a real terminal backend exists (Electrobun RPC) — terminal
 *  components gate instance creation on this. */
export function hasTerminalBackend(): boolean {
  return Boolean(rpc);
}

export async function terminalStart(
  terminalId: string,
  sessionId: string,
  size?: { cols: number; rows: number },
): Promise<void> {
  if (rpc) return void (await rpc.request.terminalCreate({ terminalId, sessionId, cols: size?.cols, rows: size?.rows }));
}

export async function terminalSnapshot(terminalId: string): Promise<TerminalSnapshot | undefined> {
  if (rpc) return rpc.request.terminalScrollback({ terminalId });
  return undefined;
}

export function terminalInput(terminalId: string, data: string): void {
  if (rpc) {
    void rpc.request.terminalWrite({ terminalId, data });
    return;
  }
}

export function terminalResize(terminalId: string, cols: number, rows: number): void {
  if (rpc) {
    void rpc.request.terminalResize({ terminalId, cols, rows });
    return;
  }
}

/** Stop the foreground process (Ctrl+C / SIGINT escalation) — the shell
 *  itself stays alive. */
export function terminalStop(terminalId: string): void {
  if (rpc) {
    void rpc.request.terminalStop({ terminalId });
    return;
  }
}

export function terminalKill(terminalId: string): void {
  if (rpc) {
    void rpc.request.terminalKill({ terminalId });
    return;
  }
}

/** Shell pid for a terminal (null if no PTY) — anchor for liveness checks. */
export async function terminalGetPid(terminalId: string): Promise<number | null> {
  if (rpc) return (await rpc.request.terminalGetPid({ terminalId })).pid;
  return null;
}

export async function processIsAlive(pid: number): Promise<boolean> {
  if (rpc) return (await rpc.request.processIsAlive({ pid })).alive;
  return false;
}

export interface TerminalEventHandlers {
  onOutput(data: { terminalId: string; data: string; seq?: number }): void;
  onExit(data: { terminalId: string; code: number | null }): void;
  onPorts(data: { terminalId: string; ports: TerminalPort[] }): void;
}

/** Subscribe to the terminal push events (output/exit/ports). Registers the
 *  RPC message callbacks exactly once; a no-op with no backend. */
export function subscribeTerminalEvents(handlers: TerminalEventHandlers): void {
  if (rpc) {
    setTerminalOutputCallback(handlers.onOutput);
    setTerminalExitCallback(handlers.onExit);
    setTerminalPortsCallback(handlers.onPorts);
    return;
  }
}

// ============================================================
// MCP (mcp.json / .mcp.json) — server management + connection status.
// Electrobun RPC first, browser mock last (empty pool — the settings
// panel renders its empty state).
// ============================================================

export async function mcpList(workspaceId?: string): Promise<McpServerStatus[]> {
  if (rpc) return rpc.request.mcpList({ workspaceId });
  return [];
}

export async function mcpAdd(name: string, config: McpServerConfig, scope: McpScope): Promise<McpOpResult> {
  if (rpc) return rpc.request.mcpAdd({ name, config, scope });
  return { ok: true };
}

export async function mcpUpdate(name: string, config: McpServerConfig, scope: McpScope): Promise<McpOpResult> {
  if (rpc) return rpc.request.mcpUpdate({ name, config, scope });
  return { ok: true };
}

export async function mcpRemove(name: string, scope: McpScope): Promise<McpOpResult> {
  if (rpc) return rpc.request.mcpRemove({ name, scope });
  return { ok: true };
}

/** First-connect consent — the approval gate is removed upstream, so this is
 *  a vestigial channel that always succeeds. */
export async function mcpApprove(name: string): Promise<{ ok: boolean }> {
  if (rpc) return rpc.request.mcpApprove({ name });
  return { ok: true };
}

export async function mcpRetry(name: string, scope: McpScope, workspaceId?: string): Promise<{ ok: boolean }> {
  if (rpc) return rpc.request.mcpRetry({ name, scope, workspaceId });
  return { ok: true };
}

/** OAuth sign-in (user-initiated): opens the browser + re-runs connect. */
export async function mcpAuthenticate(name: string, scope: McpScope, workspaceId?: string): Promise<{ ok: boolean }> {
  if (rpc) return rpc.request.mcpAuthenticate({ name, scope, workspaceId });
  return { ok: true };
}

/** Re-initialize ALL servers — disconnect + reconnect from config. */
export async function mcpReinitialize(): Promise<{ ok: boolean }> {
  if (rpc) return rpc.request.mcpReinitialize({});
  return { ok: true };
}

export async function mcpSetSecret(name: string, value: string): Promise<{ ok: boolean }> {
  if (rpc) return rpc.request.mcpSetSecret({ name, value });
  return { ok: true };
}

export async function mcpHasSecret(name: string): Promise<boolean> {
  if (rpc) return (await rpc.request.mcpHasSecret({ name })).has;
  return false;
}

export async function mcpClearSecret(name: string): Promise<{ ok: boolean }> {
  if (rpc) return rpc.request.mcpClearSecret({ name });
  return { ok: true };
}

/** Re-authorize: clear stored OAuth tokens + retry the connection. */
export async function mcpReauthorize(name: string, scope: McpScope, workspaceId?: string): Promise<{ ok: boolean }> {
  if (rpc) return rpc.request.mcpReauthorize({ name, scope, workspaceId });
  return { ok: true };
}

export async function mcpScan(): Promise<McpScanResult> {
  if (rpc) return rpc.request.mcpScan({});
  return { servers: [], alreadyImported: [] };
}

export async function mcpImport(
  servers: Array<{ name: string; config: McpServerConfig }>,
  scope: McpScope,
): Promise<McpImportResult> {
  if (rpc) return rpc.request.mcpImport({ servers, scope });
  return { ok: true, imported: servers.length };
}

export async function mcpSetEnabled(name: string, enabled: boolean, scope: McpScope): Promise<{ ok: boolean }> {
  if (rpc) return rpc.request.mcpSetEnabled({ name, enabled, scope });
  return { ok: true };
}

export async function mcpReadRaw(scope: McpScope): Promise<McpRawConfigResult> {
  if (rpc) return rpc.request.mcpReadRaw({ scope });
  return { ok: false, error: 'No MCP backend' };
}

export async function mcpWriteRaw(config: Record<string, unknown>, scope: McpScope): Promise<McpOpResult> {
  if (rpc) return rpc.request.mcpWriteRaw({ config, scope });
  return { ok: true };
}

/** Tell the main process the active workspace changed so the MCP pool can
 *  connect that workspace's project-scoped servers (.mcp.json at its root). */
export async function mcpWorkspaceActivated(workspaceId: string, workspaceRoot: string): Promise<{ ok: boolean }> {
  if (rpc) return rpc.request.mcpWorkspaceActivated({ workspaceId, workspaceRoot });
  return { ok: true };
}

/** Subscribe to pool status pushes (the panel re-fetches via mcpList).
 *  Returns an unsubscribe; a no-op with no backend. */
export function subscribeMcpStatus(callback: () => void): () => void {
  if (rpc) {
    return onMcpEvent((event) => {
      if (event.kind === 'statusChanged') callback();
    });
  }
  return () => {};
}

// ============================================================
// Providers & models — Electrobun RPC first, browser mock last.
// ============================================================

export async function listProviders(): Promise<Provider[]> {
  if (rpc) return rpc.request.providerList({});
  await delay();
  return clone(mockProviders);
}

export interface AddProviderInput {
  name: string;
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey?: string;
  models?: { alias: string; modelId: string; contextWindow: number }[];
}

export async function addProvider(input: AddProviderInput): Promise<Provider> {
  if (rpc) return rpc.request.providerAdd({ input });
  await delay(300);
  return {
    id: `p_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name,
    apiStyle: input.apiStyle,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    enabled: true,
    models: [],
  };
}

export async function updateProvider(id: string, patch: Partial<Provider>): Promise<Provider | null> {
  if (rpc) return rpc.request.providerUpdate({ providerId: id, patch });
  await delay(200);
  return null; // mock: no persistence
}

export async function deleteProvider(id: string): Promise<boolean> {
  if (rpc) return (await rpc.request.providerDelete({ providerId: id })).ok;
  await delay(200);
  return true;
}

/** Probe the provider's /models endpoint using the form's current values
 *  (works in the add form before the provider is saved). Returns the list
 *  of model ids the API exposes, or an error string. Never throws. */
export async function probeProviderModels(input: {
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey: string;
}): Promise<{ ok: true; models: ProviderModelMeta[] } | { ok: false; error: string }> {
  if (rpc) return rpc.request.providerProbeModels({ input });
  return { ok: false, error: 'IPC unavailable' };
}

/** Auto-detect the API protocol (OpenAI vs Anthropic) from baseUrl + key by
 *  racing /models probes. Used by the Add Provider wizard. */
export async function detectProviderProtocol(input: {
  baseUrl: string;
  apiKey: string;
}): Promise<{ apiStyle: ApiStyle; models: ProviderModelMeta[] } | { error: string }> {
  if (rpc) return rpc.request.providerDetectProtocol(input);
  return { error: 'IPC unavailable' };
}

/** Test a provider connection end-to-end with a minimal chat completion. */
export async function testProviderConnection(input: {
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (rpc) return rpc.request.providerTestConnection({ input });
  return { ok: false, error: 'IPC unavailable' };
}

/** Resolve a model against the models.dev catalog — returns match state + full
 *  metadata. Used by the Fetch Models dialog to enrich rows with price /
 *  context / capabilities. Returns null when IPC is unavailable. */
export async function resolveModelCatalog(input: {
  catalogId?: string;
  modelId: string;
  contextWindow: number;
}) {
  if (rpc) return rpc.request.modelCatalogResolve(input);
  return null;
}

/** Ask the main process to pull a fresh models.dev catalog in the background.
 *  Fired by the splash screen at every app open; resolves immediately — the
 *  fetch + re-enrichment continue in the main process. */
export function refreshModelCatalog() {
  if (rpc) return rpc.request.modelCatalogRefresh({});
  return Promise.resolve({ ok: false });
}

/** Rolling usage windows metered against per-provider token limits. */
export async function providerUsageWindows(providerId: string): Promise<{
  fiveHour: { tokens: number; oldestAt: number; newestAt: number };
  weekly: { tokens: number; oldestAt: number; newestAt: number };
} | null> {
  if (rpc) return rpc.request.providerUsageWindows({ providerId });
  return null;
}

/** Provider-API usage report (z.ai quota / OpenRouter credits). Null when the
 *  provider has no API. */
export interface ProviderUsageReportResult {
  source: string;
  planName?: string;
  windows: { label: string; percent?: number; used?: number; limit?: number; unit: 'tokens' | 'USD' | 'credits'; resetsAt?: number }[];
}

export async function providerUsageReport(providerId: string): Promise<ProviderUsageReportResult | null> {
  if (rpc) return rpc.request.providerUsageReport({ providerId });
  return null;
}

// ============================================================
// File explorer
// ============================================================

export async function getFileTree(_workspaceId: string): Promise<typeof fileTree> {
  if (rpc) return rpc.request.fileTreeGet({ workspaceId: _workspaceId });
  await delay();
  return clone(fileTree);
}

// ============================================================
// Workspace context (for system prompt)
// ============================================================

export async function getWorkspaceContext(workspaceId: string): Promise<string> {
  if (rpc) return rpc.request.workspaceContextGet({ workspaceId });
  await delay();
  return '';
}

export interface EnvInfo {
  platform: string;
  arch: string;
  release: string;
  /** Login shell the bash tool wraps commands in ($SHELL on Unix, ComSpec on Windows). */
  shell: string;
  /** True while saved provider keys await migration off the legacy Electron
   *  safeStorage encryption (carried over from pre-Electrobun installs). */
  keysNeedMigration?: boolean;
}

/** Host platform/shell — injected into the system prompt so the model uses the
 *  right shell dialect without guessing. Undefined outside a backend (mocks, tests). */
export async function getEnvInfo(): Promise<EnvInfo | undefined> {
  if (rpc) return rpc.request.envInfoGet({});
  return undefined;
}

/** Live version/platform info for the About + splash screens. */
export interface Diagnostics {
  appVersion: string;
  runtime: string;
  runtimeVersion: string;
  chrome: string;
  platform: string;
  userDataPath: string;
}

export async function getDiagnostics(): Promise<Diagnostics | null> {
  if (rpc) return rpc.request.diagnosticsGet({});
  return null;
}

export type ReadFileResult =
  | { ok: true; content: string; truncated: boolean; bytes: number }
  | { ok: false; reason: string };

export async function readFileInWorkspace(
  workspaceId: string,
  relPath: string,
): Promise<ReadFileResult | null> {
  if (rpc) return rpc.request.workspaceFileRead({ workspaceId, relPath });
  await delay();
  return null;
}

// ============================================================
// Terminal seed (mock)
// ============================================================

export async function getTerminalLines(_sessionId: string): Promise<typeof terminalLines> {
  if (rpc) return [];
  await delay(80);
  return clone(terminalLines);
}

// ============================================================
// Workspace scripts — output/exit/ports pushes ride the RPC
// scriptOutput/scriptExit/scriptPorts messages.
// ============================================================

export async function runScript(workspaceId: string, command: string): Promise<{ ok: boolean; pid?: number; reason?: string }> {
  if (rpc) return rpc.request.scriptRun({ workspaceId, command });
  await delay(50);
  return { ok: true };
}

export async function stopScript(workspaceId: string, command: string): Promise<{ ok: boolean; reason?: string }> {
  if (rpc) return rpc.request.scriptStop({ workspaceId, command });
  await delay(50);
  return { ok: true };
}

export async function getScriptPorts(workspaceId: string): Promise<{ port: number; label: string; url: string }[]> {
  if (rpc) return (await rpc.request.scriptPorts({ workspaceId })).ports;
  await delay(50);
  return [];
}

export async function getScriptLines(workspaceId: string): Promise<unknown[]> {
  if (rpc) return (await rpc.request.scriptLines({ workspaceId })).lines;
  return [];
}

export interface ScriptEventHandlers {
  onOutput(data: { workspaceId: string; command: string; stream: string; line: string }): void;
  onExit(data: { workspaceId: string; command: string; code: number | null }): void;
  onPorts(data: { workspaceId: string; ports: { port: number; label: string; url: string }[] }): void;
}

/** Subscribe to script push events (output/exit/ports). Registers the RPC
 *  message callbacks exactly once. */
export function subscribeScriptEvents(handlers: ScriptEventHandlers): void {
  if (rpc) {
    setScriptOutputCallback(handlers.onOutput);
    setScriptExitCallback(handlers.onExit);
    setScriptPortsCallback(handlers.onPorts);
    return;
  }
}

export function removeScriptListeners(): void {
  if (rpc) {
    setScriptOutputCallback(null);
    setScriptExitCallback(null);
    setScriptPortsCallback(null);
    return;
  }
}

export async function updateWorkspace(id: string, patch: any): Promise<any> {
  if (rpc) return rpc.request.workspaceUpdate({ workspaceId: id, patch });
  await delay(50);
}

export async function archiveWorkspace(id: string): Promise<void> {
  if (rpc) {
    await rpc.request.workspaceArchive({ workspaceId: id });
    return;
  }
}

export async function unarchiveWorkspace(id: string): Promise<void> {
  if (rpc) {
    await rpc.request.workspaceUnarchive({ workspaceId: id });
    return;
  }
}

export async function deleteWorkspace(id: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.workspaceDelete({ workspaceId: id });
  return { ok: false, error: 'no backend' };
}

// ============================================================
// Git
// ============================================================

export interface GitFileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
  staged: boolean;
  additions: number;
  deletions: number;
}

export async function gitStatus(workspaceId: string, sessionId?: string): Promise<GitFileChange[]> {
  if (rpc) return rpc.request.gitStatus({ workspaceId, sessionId });
  return [];
}

/** Subscribe to the git watcher's change pings (renderer refetches gitStatus).
 *  Returns an unsubscribe; a no-op with no backend. */
export function subscribeGitChanged(cb: (msg: { workspaceId: string }) => void): () => void {
  if (rpc) return onGitChangedRpc(cb);
  return () => {};
}

export interface GitCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  /** Short parent SHAs, first-parent first. */
  parents: string[];
  /** True when this commit is HEAD. */
  isHead?: boolean;
  /** Branch names whose tip is this sha. */
  branchHeads?: string[];
  /** Tags pointing at this sha (annotated tags peeled to the commit). */
  tags?: string[];
}

export async function gitLog(workspaceId: string, sessionId?: string, limit?: number): Promise<GitCommit[]> {
  if (rpc) return rpc.request.gitLog({ workspaceId, sessionId, limit });
  return [];
}

export async function gitCommitFiles(workspaceId: string, sha: string, sessionId?: string): Promise<GitFileChange[]> {
  if (rpc) return rpc.request.gitCommitFiles({ workspaceId, sha, sessionId });
  return [];
}

export async function gitCommitFileDiff(workspaceId: string, sha: string, filePath: string, sessionId?: string): Promise<DiffHunk[]> {
  if (rpc) return rpc.request.gitCommitFileDiff({ workspaceId, sha, filePath, sessionId });
  return [];
}

export type GitBulkOp = 'stage-all' | 'unstage-all' | 'restore-all' | 'stash' | 'stash-pop';

export async function gitBulk(workspaceId: string, op: GitBulkOp, sessionId?: string, opts?: { message?: string }): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitBulk({ workspaceId, sessionId, op, opts });
  return { ok: false };
}

export interface GitStash { ref: string; message: string; }

export async function gitStashList(workspaceId: string, sessionId?: string): Promise<GitStash[]> {
  if (rpc) return rpc.request.gitStashList({ workspaceId, sessionId });
  return [];
}
export async function gitBranchInfo(workspaceId: string, sessionId?: string): Promise<{ branch: string | null; headCommit: string | null }> {
  if (rpc) return rpc.request.gitBranchInfo({ workspaceId, sessionId });
  return { branch: null, headCommit: null };
}
export async function gitRecentBranches(workspaceId: string, sessionId?: string): Promise<string[]> {
  if (rpc) return rpc.request.gitRecentBranches({ workspaceId, sessionId });
  return [];
}
export async function gitCheckout(workspaceId: string, branch: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitCheckout({ workspaceId, sessionId, branch });
  return { ok: false };
}
export async function gitCreateBranch(workspaceId: string, branchName: string, sessionId?: string, sha?: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitCreateBranch({ workspaceId, sessionId, branchName, sha });
  return { ok: false };
}
export async function gitStage(workspaceId: string, filePath: string, stage: boolean, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitStage({ workspaceId, sessionId, filePath, stage });
  return { ok: false };
}
export async function gitCommit(workspaceId: string, message: string, sessionId?: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
  if (rpc) return rpc.request.gitCommit({ workspaceId, sessionId, message });
  return { ok: false };
}
export async function gitDiff(workspaceId: string, filePath: string, staged: boolean, sessionId?: string, contextLines?: number): Promise<DiffHunk[]> {
  if (rpc) return rpc.request.gitDiff({ workspaceId, sessionId, filePath, staged, contextLines });
  return [];
}

export async function gitHeadSha(workspaceId: string, sessionId?: string): Promise<string | null> {
  if (rpc) return (await rpc.request.gitHeadSha({ workspaceId, sessionId })).sha;
  return null;
}

export async function gitRestoreFile(workspaceId: string, filePath: string, sha: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitRestoreFile({ workspaceId, sessionId, filePath, sha });
  return { ok: false, error: 'IPC unavailable' };
}

export type GitConflictState =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them';

export interface GitConflictEntry { path: string; state: GitConflictState; }

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

export async function gitAmend(workspaceId: string, message: string | null, sessionId?: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
  if (rpc) return rpc.request.gitAmend({ workspaceId, sessionId, message });
  return { ok: false };
}
export async function gitRevert(workspaceId: string, sha: string, sessionId?: string): Promise<{ ok: boolean; newSha?: string; error?: string }> {
  if (rpc) return rpc.request.gitRevert({ workspaceId, sessionId, sha });
  return { ok: false };
}
export async function gitFetch(workspaceId: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitFetch({ workspaceId, sessionId });
  return { ok: false };
}
export async function gitPush(workspaceId: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitPush({ workspaceId, sessionId });
  return { ok: false };
}
export async function gitPull(workspaceId: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitPull({ workspaceId, sessionId });
  return { ok: false };
}
export async function gitAheadBehind(workspaceId: string, sessionId?: string): Promise<{ ahead: number; behind: number } | null> {
  if (rpc) return rpc.request.gitAheadBehind({ workspaceId, sessionId });
  return null;
}
export async function gitBranchesDetailed(workspaceId: string, sessionId?: string): Promise<GitBranchDetailed[]> {
  if (rpc) return rpc.request.gitBranchesDetailed({ workspaceId, sessionId });
  return [];
}
export async function gitDeleteBranch(workspaceId: string, name: string, force: boolean, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitDeleteBranch({ workspaceId, sessionId, name, force });
  return { ok: false };
}
export async function gitMergeBranch(workspaceId: string, name: string, sessionId?: string): Promise<{ ok: boolean; conflicts?: GitConflictEntry[]; error?: string }> {
  if (rpc) return rpc.request.gitMergeBranch({ workspaceId, sessionId, name });
  return { ok: false };
}
export async function gitConflictFiles(workspaceId: string, sessionId?: string): Promise<GitConflictEntry[]> {
  if (rpc) return rpc.request.gitConflictFiles({ workspaceId, sessionId });
  return [];
}
export async function gitResolveFile(workspaceId: string, filePath: string, side: 'ours' | 'theirs', sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitResolveFile({ workspaceId, sessionId, filePath, side });
  return { ok: false };
}
export async function gitStagedDiff(workspaceId: string, sessionId?: string): Promise<string> {
  if (rpc) return (await rpc.request.gitStagedDiff({ workspaceId, sessionId })).text;
  return '';
}
export async function gitCommitMessage(workspaceId: string, sha: string, sessionId?: string): Promise<string> {
  if (rpc) return (await rpc.request.gitCommitMessage({ workspaceId, sessionId, sha })).text;
  return '';
}
export async function gitDiscardFile(workspaceId: string, filePath: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.gitDiscardFile({ workspaceId, sessionId, filePath });
  return { ok: false, error: 'IPC unavailable' };
}

// ============================================================
// RAG status (Memory & RAG panel)
// ============================================================

/** Read-only RAG status snapshot. Returns {error} on main-process failure
 *  or when IPC isn't available (browser dev mode). */
export async function ragStatus(workspaceId: string): Promise<RagStatus | { error: string }> {
  if (rpc) return rpc.request.ragStatus({ workspaceId });
  return {
    embedderId: null, dim: 384, enabledWorkspaces: [], cloudAllowed: false,
    chunkTokens: 384, localAvailable: null, cloudConfigured: false,
    chunkCount: 0, initState: 'never', lastIngestedAt: null, state: 'no-index',
  };
}

export async function downloadRagModel(): Promise<RagWorkspaceOpResult> {
  if (rpc) return rpc.request.ragDownloadModel({});
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}
export async function ragModelExists(): Promise<boolean> {
  if (rpc) return rpc.request.ragModelExists({});
  return false;
}
export async function enableRagWorkspace(workspaceId: string): Promise<RagWorkspaceOpResult> {
  if (rpc) return rpc.request.ragEnableWorkspace({ workspaceId });
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}
export async function disableRagWorkspace(workspaceId: string): Promise<RagWorkspaceOpResult> {
  if (rpc) return rpc.request.ragDisableWorkspace({ workspaceId });
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}
export async function initRagWorkspace(workspaceId: string): Promise<RagInitResult> {
  if (rpc) return rpc.request.ragInitWorkspace({ workspaceId });
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}
export function subscribeRagInitProgress(cb: (e: RagInitProgressEvent) => void): () => void {
  if (rpc) {
    return onRagProgress((msg) => {
      if (msg.kind === 'init') cb(msg.event);
    });
  }
  return () => {};
}
export function subscribeRagDownloadProgress(cb: (e: RagDownloadProgressEvent) => void): () => void {
  if (rpc) {
    return onRagProgress((msg) => {
      if (msg.kind === 'download') cb(msg.event);
    });
  }
  return () => {};
}

// ============================================================
// Knowledge sources (settings → Knowledge)
// ============================================================

export interface SourcesListResult {
  sources: KnowledgeSource[];
  /** Ids enabled for the requested workspace ('*' sources resolved). Empty when no workspaceId is given. */
  enabledSourceIds: string[];
}

export async function listSources(workspaceId?: string): Promise<SourcesListResult> {
  if (rpc) return rpc.request.sourcesList({ workspaceId });
  return { sources: [], enabledSourceIds: [] };
}

export interface AddSourceInput {
  name: string;
  kind: SourceKind;
  location: string;
  /** ['*'] = available in all workspaces (default). */
  enabledWorkspaceIds?: string[];
}

/** Add a source. The row is persisted immediately; the first index pass runs
 *  in the background and reports via subscribeSourcesProgress. */
export async function addSource(input: AddSourceInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (rpc) return rpc.request.sourcesAdd(input);
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}

export async function updateSource(
  id: string,
  patch: { name?: string; location?: string; enabledWorkspaceIds?: string[] },
): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.sourcesUpdate({ id, patch });
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}

export async function removeSource(id: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.sourcesRemove({ id });
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}

export async function setSourceEnabled(id: string, workspaceId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.sourcesSetEnabled({ id, workspaceId, enabled });
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}

export async function reindexSource(id: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.sourcesReindex({ id });
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}

export function subscribeSourcesProgress(cb: (e: SourceProgressEvent) => void): () => void {
  if (rpc) return onSourcesProgress(cb);
  return () => {};
}

// ============================================================
// macOS permissions (consent screen) — no-op on non-mac.
// ============================================================

export type PermissionStatus = {
  platform: 'mac' | 'other';
  accessibility: 'authorized' | 'denied' | 'restricted' | 'not determined' | null;
  fullDiskAccess: 'authorized' | 'denied' | 'restricted' | 'not determined' | null;
  folders: 'unknown' | null;
};
export type PermissionType = 'accessibility' | 'fullDiskAccess' | 'folders';

export async function getPermissionStatus(): Promise<PermissionStatus> {
  if (rpc) return rpc.request.permissionStatusGet({});
  // Browser dev fallback — treated as non-mac so the consent screen won't show.
  return { platform: 'other', accessibility: null, fullDiskAccess: null, folders: null };
}

export async function requestPermission(type: PermissionType): Promise<'opened' | 'unavailable'> {
  if (rpc) return (await rpc.request.permissionRequest({ type })).result;
  return 'unavailable';
}

export async function shouldShowConsent(): Promise<boolean> {
  if (rpc) return (await rpc.request.consentShouldShow({})).shouldShow;
  return false;
}

// ============================================================
// Settings (agent + general), shell ops, extensions, open-in-app,
// window queries — the 3.7 catch-all surface.
// ============================================================

export interface AgentSettings {
  defaultAutonomy: string;
  maxSteps: number;
  permissionTimeoutMin: number;
  planModeDryRun: boolean;
  auditShellCommands: boolean;
  compactionEnabled?: boolean;
  compactionThreshold?: number;
  compactionKeepTurns?: number;
  experimentalBackgroundDispatch: boolean;
}

export async function getAgentSettings(): Promise<AgentSettings | null> {
  if (rpc) return rpc.request.settingsGetAgent({});
  return null;
}

export async function updateAgentSettings(patch: Partial<AgentSettings>): Promise<AgentSettings | null> {
  if (rpc) return rpc.request.settingsUpdateAgent({ patch: patch as Record<string, never> });
  return null;
}

export interface GeneralSettings {
  startAtLogin: boolean;
  notifications: boolean;
  notificationSound: boolean;
  gitCoAuthored: boolean;
  gitCoAuthorName: string;
  gitCoAuthorEmail: string;
  autoUpdateCheck: boolean;
  titleModel?: { providerId: string; modelId: string } | null;
  commitMessageModel?: { providerId: string; modelId: string } | null;
}

export async function getGeneralSettings(): Promise<GeneralSettings | null> {
  if (rpc) return rpc.request.settingsGetGeneral({});
  return null;
}

export async function updateGeneralSettings(patch: Partial<GeneralSettings>): Promise<GeneralSettings | null> {
  if (rpc) return rpc.request.settingsUpdateGeneral({ patch: patch as Record<string, never> });
  return null;
}

// ============================================================
// Updater (Electrobun Updater behind the RPC bridge — 3.7 residue
// migration. Browser fallbacks are inert so the pill/settings keep
// their idle renderings.)
// ============================================================

export async function getUpdaterStatus(): Promise<UpdateStatusWire | null> {
  if (rpc) return (await rpc.request.updaterStatus({})).status;
  return null;
}

export async function checkForUpdates(): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.updaterCheckNow({});
  return { ok: false, error: 'IPC unavailable' };
}

/** Changelog markdown for a version (the GitHub Release body for
 *  v<version>); null when unavailable — callers render the
 *  "details unavailable" fallback. */
export async function getReleaseNotes(version: string): Promise<string | null> {
  if (rpc) return (await rpc.request.updaterReleaseNotes({ version })).markdown;
  return null;
}

/** Consent action 1 — download only; stops at ready. */
export async function downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.updaterDownload({});
  return { ok: false, error: 'IPC unavailable' };
}

/** Consent action 2 — apply a prepared update (swap + relaunch). */
export async function applyUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.updaterApply({});
  return { ok: false, error: 'IPC unavailable' };
}

/** Ask the system model to repair a broken mermaid diagram (last resort
 *  after the renderer's local sanitize chain). */
export async function mermaidRepair(input: { source: string; error: string }): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  if (rpc) return rpc.request.mermaidRepair(input);
  return { ok: false, error: 'IPC unavailable' };
}

/** Forward a renderer log line into the central log file (fire-and-forget). */
export function sendLog(level: string, tag: string, msg: string, args?: unknown[]): void {
  if (rpc) {
    void rpc.request.logSend({ level, tag, msg, args });
    return;
  }
}

/** Open a URL in the OS default browser / handler. */
export function openExternal(url: string): void {
  if (rpc) {
    void rpc.request.shellOpenExternal({ url });
    return;
  }
}

/** Reveal a file in the OS file manager (Finder/Explorer). */
export function showItemInFolder(fullPath: string): void {
  if (rpc) {
    void rpc.request.shellShowItemInFolder({ fullPath });
    return;
  }
}

/** Open a file/folder with the default application. */
export async function openPath(path: string): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.shellOpenPath({ path });
  return { ok: false, error: 'IPC unavailable' };
}

export interface ExternalAppInfo {
  id: 'finder' | 'terminal' | 'vscode' | 'zed';
  label: string;
  available: boolean;
  iconDataUrl?: string | null;
}

/** Detect external apps (Finder/Terminal/editors) available on this machine. */
export async function detectExternalApps(): Promise<ExternalAppInfo[]> {
  if (rpc) return rpc.request.openInAppDetect({});
  return [];
}

/** Open a session's resolved folder in an external app. */
export async function openInApp(
  target: ExternalAppInfo['id'],
  sessionId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (rpc) return rpc.request.openInAppOpen({ target, sessionId });
  return { ok: false, error: 'IPC unavailable' };
}

/** Query the native fullscreen state (initial value only — the devkit has
 *  no fullscreen-transition push, so the renderer keeps the queried value
 *  until the next query). */
export function minimizeWindow(): void {
  void rpc?.request.windowMinimize({});
}

export function toggleMaximizeWindow(): void {
  void rpc?.request.windowToggleMaximize({});
}

export function closeWindow(): void {
  void rpc?.request.windowClose({});
}

export async function isFullScreen(): Promise<boolean> {
  if (rpc) return (await rpc.request.windowIsFullScreen({})).fullscreen;
  return false;
}

export async function listExtensions(): Promise<{ agents: string[]; skills: string[] }> {
  if (rpc) return rpc.request.extensionsList({});
  return { agents: [], skills: [] };
}

export async function setExtensionEnabled(
  domain: 'agents' | 'skills',
  name: string,
  enabled: boolean,
): Promise<void> {
  if (rpc) {
    await rpc.request.extensionsSetEnabled({ domain, name, enabled });
    return;
  }
}

export async function listExtensionAgents(workspaceRoot: string): Promise<{
  name: string;
  description: string;
  whenToUse: string;
  source: 'builtin' | 'project' | 'user';
  path?: string;
  enabled: boolean;
}[]> {
  if (rpc) return rpc.request.extensionsListAgents({ workspaceRoot });
  return [];
}

export async function listExtensionSkills(workspaceRoot: string): Promise<{
  name: string;
  description: string;
  source: 'project' | 'user';
  path: string;
  absPath: string;
  enabled: boolean;
}[]> {
  if (rpc) return rpc.request.extensionsListSkills({ workspaceRoot });
  return [];
}
