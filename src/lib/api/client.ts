/** API client — the single swap point between mock data and real IPC. Uses `window.tideIpc` (Electron preload) when present, otherwise falls back to the in-memory mock store. */

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
  Provider,
  ProviderModelMeta,
  RagDownloadProgressEvent,
  RagInitProgressEvent,
  RagInitResult,
  RagStatus,
  WorkspaceProgressEvent,
  RagWorkspaceOpResult,
  Workspace,
  WorkspaceScript,
  Session,
} from '@/types';
import type { FlushBatchV2, MessageWithPartsV2, SessionMetaV2 } from '@/types/session-v2';

// ── Electron detection ──────────────────────────────────────────
const ipc = typeof window !== 'undefined' ? window.tideIpc : undefined;

// ── Mock helpers (browser fallback) ─────────────────────────────
const delay = (ms = 120) => new Promise<void>((r) => setTimeout(r, ms));

const clone = <T>(v: T): T =>
  typeof structuredClone !== 'undefined'
    ? structuredClone(v)
    : JSON.parse(JSON.stringify(v));

// ============================================================
// File dialog + git detection (Electron only — browser returns null/empty)
// ============================================================

export async function pickDirectory(): Promise<string | null> {
  if (ipc) return ipc.pickDirectory();
  return null;
}

export async function pickFiles(): Promise<string[]> {
  if (ipc) return ipc.pickFiles();
  return [];
}

export async function readExternalFile(filePath: string): Promise<{ content: string; bytes: number; truncated: boolean } | null> {
  if (ipc) return ipc.readExternalFile(filePath);
  return null;
}

/** Read an image as a base64 data URL for <img> rendering in the viewer.
 *  Accepts an absolute path (external attachment) or workspace+relPath. */
export async function readImageFile(input: { absPath?: string; workspaceId?: string; relPath?: string }): Promise<{ dataUrl: string; bytes: number } | null> {
  if (ipc) return ipc.readImageFile(input);
  return null;
}

export interface GitRepoInfo {
  branch: string;
  headCommit: string;
  fileCount: number;
  isRepo: boolean;
}

export async function detectGitRepo(dirPath: string): Promise<GitRepoInfo | null> {
  if (ipc) return ipc.detectGitRepo(dirPath);
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
  if (ipc) return ipc.addWorkspace(input);
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
  if (ipc) return ipc.listWorkspaces();
  await delay();
  return clone(mockWorkspaces);
}

export async function getWorkspace(id: string): Promise<Workspace | undefined> {
  if (ipc) return ipc.getWorkspace(id);
  await delay();
  return clone(mockWorkspaces.find((w) => w.id === id));
}

export async function getLastSession(): Promise<{ sessionId: string | null; workspaceId: string | null }> {
  if (ipc) return ipc.getLastSession();
  await delay();
  return { sessionId: null, workspaceId: null };
}

export async function setLastSession(sessionId: string | null, workspaceId: string | null): Promise<void> {
  if (ipc) return ipc.setLastSession(sessionId, workspaceId);
}

// ============================================================
// Sessions
// ============================================================

export async function listSessions(workspaceId: string): Promise<any[]> {
  if (ipc) return ipc.listSessions(workspaceId);
  await delay();
  return clone(sessionsByWorkspace[workspaceId] ?? []);
}

export async function listDispatches(parentId: string): Promise<any[]> {
  if (ipc) return ipc.listDispatches(parentId);
  await delay();
  return [];
}

/** Built-in sub-agents for the @mention picker + dispatch_agent catalog. */
export async function listAgents(): Promise<{ name: string; description: string; whenToUse: string }[]> {
  if (ipc && (ipc as any).listAgents) return (ipc as any).listAgents();
  // Mock fallback (dev without Electron) — keep the catalog names in sync
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
  if (ipc && (ipc as any).listProjectEntries) return (ipc as any).listProjectEntries(workspaceId);
  return { contextFiles: [], skills: [], agents: [] };
}

/** Todos for a session — model-maintained via the todo_write tool. Flat list. */
export async function listTodos(sessionId: string): Promise<{
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
}[]> {
  if (ipc && (ipc as any).listTodos) return (ipc as any).listTodos(sessionId);
  return [];
}

/** Subscribe to live todo updates pushed from the main process. */
export async function subscribeTodos(): Promise<void> {
  if (ipc && (ipc as any).subscribeTodos) return (ipc as any).subscribeTodos();
}

export function onTodosUpdated(cb: (data: { sessionId: string; todos: any[] }) => void): void {
  if (ipc && (ipc as any).onTodosUpdated) (ipc as any).onTodosUpdated(cb);
}

export function removeTodosListener(): void {
  if (ipc && (ipc as any).removeTodosListener) (ipc as any).removeTodosListener();
}

export async function getSession(id: string): Promise<any> {
  if (ipc) return ipc.getSession(id);
  await delay();
  return clone(allSessions.find((s) => s.id === id));
}

export async function createSession(
  workspaceId: string,
  title: string,
  modelId: string,
  opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string },
): Promise<any> {
  if (ipc) return ipc.createSession(workspaceId, title, modelId, opts);
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
  if (ipc) return ipc.updateSessionSettings(sessionId, patch);
  await delay(50);
}

export async function addMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  extra?: { attachments?: any[]; mentions?: any[] },
): Promise<void> {
  if (ipc) return ipc.addMessage(sessionId, role, content, extra);
}

/** Persist a full assistant message (with reasoning + tool calls). Used by the agent-loop path. Falls back to addMessage(content) when the IPC surface isn't available. */
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
  if (ipc && (ipc as any).addAssistantMessage) {
    return (ipc as any).addAssistantMessage(sessionId, message);
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
    reasoning?: string;
    reasoningTokens?: number;
    reasoningMs?: number;
    totalMs?: number;
    toolCalls?: any[];
    timeline?: any[];
    turn?: any;
  },
): Promise<void> {
  if (ipc && (ipc as any).finalizeAssistantMessage) {
    return (ipc as any).finalizeAssistantMessage(sessionId, messageId, message);
  }
  await addMessage(sessionId, 'assistant', message.content);
}

/** Accumulate a turn's usage into the session's cumulative totals (drives the context-window meter in the right panel). No-op when the IPC surface is unavailable (mock mode) — usage is purely informational. */
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
  if (ipc && (ipc as any).addSessionUsage) {
    return (ipc as any).addSessionUsage(sessionId, delta, lastStepUsage);
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (ipc) return ipc.deleteSession(id);
}

export async function clearAllSessions(): Promise<{ ok: boolean }> {
  if (ipc) return ipc.clearAllSessions();
  return { ok: false };
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  if (ipc) await ipc.renameSession(sessionId, title);
}

/** Best-effort LLM title generation. Returns the new title or null (placeholder kept). Fire-and-forget — don't await on the critical path; just invalidate the sessions query on resolve so the sidebar picks up the rename. */
export async function generateSessionTitle(sessionId: string): Promise<string | null> {
  if (ipc) return ipc.generateSessionTitle(sessionId);
  return null;
}

export async function archiveSession(sessionId: string): Promise<void> {
  if (ipc) await ipc.archiveSession(sessionId);
}

export async function unarchiveSession(sessionId: string): Promise<void> {
  if (ipc) await ipc.unarchiveSession(sessionId);
}

export async function listArchivedSessions(workspaceId: string): Promise<ArchivedHeader[]> {
  if (ipc) return ipc.listArchivedSessions(workspaceId);
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
  if (!ipc) throw new Error('IPC unavailable');
  return ipc.createWorktree(sessionId, opts);
}

export async function removeWorktree(sessionId: string): Promise<void> {
  if (ipc) await ipc.removeWorktree(sessionId);
}

/** Fork a session into a new session with a different model; an LLM summary of the source conversation is generated and stored as the first message. */
export async function forkSession(
  sourceId: string,
  newModelId: string,
  opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string },
): Promise<Session> {
  if (ipc) return ipc.forkSession(sourceId, newModelId, opts);
  throw new Error('forkSession requires Electron IPC');
}

export async function listBranches(workspaceId: string): Promise<string[]> {
  if (ipc) return ipc.listBranches(workspaceId);
  return [];
}

export async function listConfigFiles(workspaceId: string): Promise<string[]> {
  if (ipc) return ipc.listConfigFiles(workspaceId);
  return [];
}

// ─── Part-normalized v2 sessions + event stream ────────────────────

/** List v2 sessions by workspace path. Browser dev mode resolves empty —
 *  there is no v2 store without the main process. */
export async function listSessionsV2(
  workspacePath: string,
  opts?: { archived?: boolean; cursor?: string | null; limit?: number },
): Promise<{ sessions: SessionMetaV2[]; nextCursor: string | null }> {
  if (ipc && ipc.sessionListV2) return ipc.sessionListV2(workspacePath, opts);
  return { sessions: [], nextCursor: null };
}

export async function listSessionMessagesV2(
  sessionId: string,
  opts?: { limit?: number; before?: string | null },
): Promise<{ messages: MessageWithPartsV2[]; nextBefore: string | null }> {
  if (ipc && ipc.sessionMessagesV2) return ipc.sessionMessagesV2(sessionId, opts);
  return { messages: [], nextBefore: null };
}

/** (Re)subscribe to a session's event stream. Persisted events (seq > lastSeq)
 *  replay as tide:events batches before live push begins. */
export async function eventsSubscribe(sessionId: string, lastSeq: number | null): Promise<void> {
  if (ipc && ipc.eventsSubscribe) return ipc.eventsSubscribe(sessionId, lastSeq);
}

export function subscribeEvents(cb: (batch: FlushBatchV2) => void): () => void {
  if (ipc && ipc.onEvents) return ipc.onEvents(cb);
  return () => {};
}

// ============================================================
// Providers & models
// ============================================================

export async function listProviders(): Promise<Provider[]> {
  if (ipc) return ipc.listProviders();
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
  if (ipc) return ipc.addProvider(input);
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
  if (ipc) return ipc.updateProvider(id, patch);
  await delay(200);
  return null; // mock: no persistence
}

export async function deleteProvider(id: string): Promise<boolean> {
  if (ipc) return ipc.deleteProvider(id);
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
  if (ipc && ipc.probeProviderModels) return ipc.probeProviderModels(input);
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
  if (ipc && ipc.modelCatalog?.resolve) return ipc.modelCatalog.resolve(input);
  return null;
}

/** Ask the main process to pull a fresh models.dev catalog in the background.
 *  Fired by the splash screen at every app open; resolves immediately — the
 *  fetch + re-enrichment continue in the main process. */
export function refreshModelCatalog() {
  if (ipc && ipc.modelCatalog?.refresh) return ipc.modelCatalog.refresh();
  return Promise.resolve({ ok: false });
}

// ============================================================
// File explorer
// ============================================================

export async function getFileTree(_workspaceId: string): Promise<typeof fileTree> {
  if (ipc) return ipc.getFileTree(_workspaceId);
  await delay();
  return clone(fileTree);
}

// ============================================================
// Workspace context (for system prompt)
// ============================================================

export async function getWorkspaceContext(workspaceId: string): Promise<string> {
  if (ipc) return ipc.getWorkspaceContext(workspaceId);
  await delay();
  return '';
}

export interface EnvInfo {
  platform: string;
  arch: string;
  release: string;
  /** Login shell the bash tool wraps commands in ($SHELL on Unix, ComSpec on Windows). */
  shell: string;
}

/** Host platform/shell — injected into the system prompt so the model uses the
 *  right shell dialect without guessing. Undefined outside Electron (mocks, tests). */
export async function getEnvInfo(): Promise<EnvInfo | undefined> {
  if (ipc && (ipc as any).getEnvInfo) return (ipc as any).getEnvInfo();
  return undefined;
}

export type ReadFileResult =
  | { ok: true; content: string; truncated: boolean; bytes: number }
  | { ok: false; reason: string };

export async function readFileInWorkspace(
  workspaceId: string,
  relPath: string,
): Promise<ReadFileResult | null> {
  if (ipc) return ipc.readFileInWorkspace(workspaceId, relPath);
  await delay();
  return null;
}

// ============================================================
// Terminal seed (mock)
// ============================================================

export async function getTerminalLines(_sessionId: string): Promise<typeof terminalLines> {
  if (ipc) return ipc.getTerminalLines(_sessionId);
  await delay(80);
  return clone(terminalLines);
}

// ============================================================
// Workspace scripts
// ============================================================

export async function runScript(workspaceId: string, command: string): Promise<{ ok: boolean; pid?: number; reason?: string }> {
  if (ipc) return ipc.runScript(workspaceId, command);
  await delay(50);
  return { ok: true };
}

export async function stopScript(workspaceId: string, command: string): Promise<{ ok: boolean; reason?: string }> {
  if (ipc) return ipc.stopScript(workspaceId, command);
  await delay(50);
  return { ok: true };
}

export async function getScriptPorts(workspaceId: string): Promise<{ port: number; label: string; url: string }[]> {
  if (ipc) return ipc.getScriptPorts(workspaceId);
  await delay(50);
  return [];
}

export async function updateWorkspace(id: string, patch: any): Promise<any> {
  if (ipc) return ipc.updateWorkspace(id, patch);
  await delay(50);
}

export async function archiveWorkspace(id: string): Promise<void> {
  if (ipc) await ipc.archiveWorkspace(id);
}

export async function unarchiveWorkspace(id: string): Promise<void> {
  if (ipc) await ipc.unarchiveWorkspace(id);
}

export async function deleteWorkspace(id: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.deleteWorkspace(id);
  return { ok: false, error: 'not in electron' };
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
  if (ipc) return ipc.gitStatus(workspaceId, sessionId);
  return [];
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
}

export async function gitLog(workspaceId: string, sessionId?: string, limit?: number): Promise<GitCommit[]> {
  if (ipc) return ipc.gitLog(workspaceId, sessionId, limit);
  return [];
}

export async function gitCommitFiles(workspaceId: string, sha: string, sessionId?: string): Promise<GitFileChange[]> {
  if (ipc) return ipc.gitCommitFiles(workspaceId, sha, sessionId);
  return [];
}

export async function gitCommitFileDiff(workspaceId: string, sha: string, filePath: string, sessionId?: string): Promise<DiffHunk[]> {
  if (ipc) return ipc.gitCommitFileDiff(workspaceId, sha, filePath, sessionId);
  return [];
}

export type GitBulkOp = 'stage-all' | 'unstage-all' | 'restore-all' | 'stash' | 'stash-pop';

export async function gitBulk(workspaceId: string, op: GitBulkOp, sessionId?: string, opts?: { message?: string }): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitBulk(workspaceId, op, sessionId, opts);
  return { ok: false };
}

export interface GitStash { ref: string; message: string; }

export async function gitStashList(workspaceId: string, sessionId?: string): Promise<GitStash[]> {
  if (ipc) return ipc.gitStashList(workspaceId, sessionId);
  return [];
}
export async function gitBranchInfo(workspaceId: string, sessionId?: string): Promise<{ branch: string | null; headCommit: string | null }> {
  if (ipc) return ipc.gitBranchInfo(workspaceId, sessionId);
  return { branch: null, headCommit: null };
}
export async function gitRecentBranches(workspaceId: string, sessionId?: string): Promise<string[]> {
  if (ipc) return ipc.gitRecentBranches(workspaceId, sessionId);
  return [];
}
export async function gitCheckout(workspaceId: string, branch: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitCheckout(workspaceId, branch, sessionId);
  return { ok: false };
}
export async function gitCreateBranch(workspaceId: string, branchName: string, sessionId?: string, sha?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitCreateBranch(workspaceId, branchName, sessionId, sha);
  return { ok: false };
}
export async function gitStage(workspaceId: string, filePath: string, stage: boolean, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitStage(workspaceId, filePath, stage, sessionId);
  return { ok: false };
}
export async function gitCommit(workspaceId: string, message: string, sessionId?: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
  if (ipc) return ipc.gitCommit(workspaceId, message, sessionId);
  return { ok: false };
}
export async function gitDiff(workspaceId: string, filePath: string, staged: boolean, sessionId?: string, contextLines?: number): Promise<DiffHunk[]> {
  if (ipc) return ipc.gitDiff(workspaceId, filePath, staged, sessionId, contextLines);
  return [];
}

export async function gitHeadSha(workspaceId: string, sessionId?: string): Promise<string | null> {
  if (ipc) return ipc.gitHeadSha(workspaceId, sessionId);
  return null;
}

export async function gitRestoreFile(workspaceId: string, filePath: string, sha: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitRestoreFile(workspaceId, filePath, sha, sessionId);
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
  if (ipc) return ipc.gitAmend(workspaceId, message, sessionId);
  return { ok: false };
}
export async function gitRevert(workspaceId: string, sha: string, sessionId?: string): Promise<{ ok: boolean; newSha?: string; error?: string }> {
  if (ipc) return ipc.gitRevert(workspaceId, sha, sessionId);
  return { ok: false };
}
export async function gitFetch(workspaceId: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitFetch(workspaceId, sessionId);
  return { ok: false };
}
export async function gitPush(workspaceId: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitPush(workspaceId, sessionId);
  return { ok: false };
}
export async function gitPull(workspaceId: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitPull(workspaceId, sessionId);
  return { ok: false };
}
export async function gitAheadBehind(workspaceId: string, sessionId?: string): Promise<{ ahead: number; behind: number } | null> {
  if (ipc) return ipc.gitAheadBehind(workspaceId, sessionId);
  return null;
}
export async function gitBranchesDetailed(workspaceId: string, sessionId?: string): Promise<GitBranchDetailed[]> {
  if (ipc) return ipc.gitBranchesDetailed(workspaceId, sessionId);
  return [];
}
export async function gitDeleteBranch(workspaceId: string, name: string, force: boolean, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitDeleteBranch(workspaceId, name, force, sessionId);
  return { ok: false };
}
export async function gitMergeBranch(workspaceId: string, name: string, sessionId?: string): Promise<{ ok: boolean; conflicts?: GitConflictEntry[]; error?: string }> {
  if (ipc) return ipc.gitMergeBranch(workspaceId, name, sessionId);
  return { ok: false };
}
export async function gitConflictFiles(workspaceId: string, sessionId?: string): Promise<GitConflictEntry[]> {
  if (ipc) return ipc.gitConflictFiles(workspaceId, sessionId);
  return [];
}
export async function gitResolveFile(workspaceId: string, filePath: string, side: 'ours' | 'theirs', sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitResolveFile(workspaceId, filePath, side, sessionId);
  return { ok: false };
}
export async function gitStagedDiff(workspaceId: string, sessionId?: string): Promise<string> {
  if (ipc) return ipc.gitStagedDiff(workspaceId, sessionId);
  return '';
}
export async function gitCommitMessage(workspaceId: string, sha: string, sessionId?: string): Promise<string> {
  if (ipc) return ipc.gitCommitMessage(workspaceId, sha, sessionId);
  return '';
}
export async function gitDiscardFile(workspaceId: string, filePath: string, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitDiscardFile(workspaceId, filePath, sessionId);
  return { ok: false, error: 'IPC unavailable' };
}

// ============================================================
// RAG status (Memory & RAG panel)
// ============================================================

/** Read-only RAG status snapshot. Returns {error} on main-process failure
 *  or when IPC isn't available (browser dev mode). */
export async function ragStatus(workspaceId: string): Promise<RagStatus | { error: string }> {
  if (ipc && ipc.ragStatus) return ipc.ragStatus(workspaceId);
  return {
    embedderId: null, dim: 384, enabledWorkspaces: [], cloudAllowed: false,
    chunkTokens: 384, localAvailable: null, cloudConfigured: false,
    chunkCount: 0, initState: 'never', lastIngestedAt: null, state: 'no-index',
  };
}

export async function downloadRagModel(): Promise<RagWorkspaceOpResult> {
  if (ipc && ipc.downloadRagModel) return ipc.downloadRagModel();
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}
export async function ragModelExists(): Promise<boolean> {
  if (ipc && ipc.ragModelExists) return ipc.ragModelExists();
  return false;
}
export async function enableRagWorkspace(workspaceId: string): Promise<RagWorkspaceOpResult> {
  if (ipc && ipc.enableRagWorkspace) return ipc.enableRagWorkspace(workspaceId);
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}
export async function disableRagWorkspace(workspaceId: string): Promise<RagWorkspaceOpResult> {
  if (ipc && ipc.disableRagWorkspace) return ipc.disableRagWorkspace(workspaceId);
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}
export async function initRagWorkspace(workspaceId: string): Promise<RagInitResult> {
  if (ipc && ipc.initRagWorkspace) return ipc.initRagWorkspace(workspaceId);
  return { ok: false, error: 'IPC unavailable (browser dev mode)' };
}
export function subscribeRagInitProgress(cb: (e: RagInitProgressEvent) => void): () => void {
  if (ipc && ipc.onRagInitProgress) return ipc.onRagInitProgress(cb as (e: unknown) => void);
  return () => {};
}
export function subscribeRagDownloadProgress(cb: (e: RagDownloadProgressEvent) => void): () => void {
  if (ipc && ipc.onRagDownloadProgress) return ipc.onRagDownloadProgress(cb as (e: unknown) => void);
  return () => {};
}
export function subscribeWorkspaceProgress(cb: (e: WorkspaceProgressEvent) => void): () => void {
  if (ipc && ipc.onWorkspaceProgress) return ipc.onWorkspaceProgress(cb as (e: unknown) => void);
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
  if (ipc) return ipc.permissionStatus();
  // Browser dev fallback — treated as non-mac so the consent screen won't show.
  return { platform: 'other', accessibility: null, fullDiskAccess: null, folders: null };
}

export async function requestPermission(type: PermissionType): Promise<'opened' | 'unavailable'> {
  if (ipc) return ipc.requestPermission(type);
  return 'unavailable';
}

export async function shouldShowConsent(): Promise<boolean> {
  if (ipc) return ipc.shouldShowConsent();
  return false;
}
