/**
 * API client — the single swap point between mock data and real IPC.
 *
 * - In a plain browser (Vite dev server alone): every method returns from
 *   the in-memory store in `../mock/data`. No Electron required.
 * - Inside Electron: `window.tideIpc` is present (injected by the preload
 *   script via contextBridge), and every method calls through IPC to the
 *   main process. The mock data is still returned by the main process today;
 *   swap the main-process handlers for real implementations later.
 *
 * Components that import these helpers do not change either way.
 */

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
  RagInitProgressEvent,
  RagInitResult,
  RagStatus,
  RagWorkspaceOpResult,
  Workspace,
  WorkspaceScript,
} from '@/types';

// ── Electron detection ──────────────────────────────────────────
// In Electron, `window.tideIpc` is injected by preload.ts via contextBridge.
// In a browser it's undefined — we fall back to mock data.
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

/** Built-in sub-agents for the @mention picker + dispatch_agent catalog. */
export async function listAgents(): Promise<{ name: string; description: string; whenToUse: string }[]> {
  if (ipc && (ipc as any).listAgents) return (ipc as any).listAgents();
  // Mock fallback (dev without Electron) — keep the 8 catalog names in sync
  // with electron/agent/agents/registry.ts.
  return [
    { name: 'general-purpose', description: 'General-purpose analyst for research and synthesis.', whenToUse: 'Multi-step research or analysis.' },
    { name: 'explore', description: 'Read-only code locator.', whenToUse: 'Finding files, symbols, or call sites.' },
    { name: 'workflow-orchestrator', description: 'State-machine workflow design.', whenToUse: 'Designing business-process workflows with failure recovery.' },
    { name: 'task-distributor', description: 'Queue + scheduling design.', whenToUse: 'Designing task queues, worker pools, scheduling.' },
    { name: 'multi-agent-coordinator', description: 'Multi-agent coordination design.', whenToUse: 'Coordinating many agents with dependencies.' },
    { name: 'agent-organizer', description: 'Team assembly + sequencing.', whenToUse: 'Planning which agents to use for which subtask.' },
    { name: 'codebase-orchestrator', description: 'Refactor governance with approval gates.', whenToUse: 'Repo-wide refactor planning.' },
    { name: 'context-manager', description: 'Shared-state system design.', whenToUse: 'Designing shared context/state storage and retrieval.' },
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

/** Todos for a session — model-maintained via the todo_write tool. */
export async function listTodos(sessionId: string): Promise<{
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
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
  opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string },
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
  patch: { modelId?: string; autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string },
): Promise<void> {
  if (ipc) return ipc.updateSessionSettings(sessionId, patch);
  await delay(50);
}

export async function addMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): Promise<void> {
  if (ipc) return ipc.addMessage(sessionId, role, content);
}

/**
 * Persist a full assistant message (with reasoning + tool calls). Used by
 * the agent-loop path. Falls back to addMessage(content) when the IPC
 * surface isn't available.
 */
export async function addAssistantMessage(
  sessionId: string,
  message: {
    content: string;
    reasoning?: string;
    reasoningTokens?: number;
    reasoningMs?: number;
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

/**
 * Accumulate a turn's usage into the session's cumulative totals. Drives the
 * context-window meter in the right panel. No-op when the IPC surface is
 * unavailable (mock mode) — usage is purely informational.
 */
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
): Promise<void> {
  if (ipc && (ipc as any).addSessionUsage) {
    return (ipc as any).addSessionUsage(sessionId, delta);
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

/**
 * Best-effort LLM title generation. Returns the new title or null (placeholder
 * kept). Fire-and-forget — caller should not await on the critical path; just
 * invalidate the sessions query on resolve so the sidebar picks up the rename.
 */
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

export async function listBranches(workspaceId: string): Promise<string[]> {
  if (ipc) return ipc.listBranches(workspaceId);
  return [];
}

export async function listConfigFiles(workspaceId: string): Promise<string[]> {
  if (ipc) return ipc.listConfigFiles(workspaceId);
  return [];
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

/** Resolve a model against the LiteLLM catalog — returns match state + full
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
// Git source control
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
export async function gitStage(workspaceId: string, filePath: string, stage: boolean, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
  if (ipc) return ipc.gitStage(workspaceId, filePath, stage, sessionId);
  return { ok: false };
}
export async function gitCommit(workspaceId: string, message: string, sessionId?: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
  if (ipc) return ipc.gitCommit(workspaceId, message, sessionId);
  return { ok: false };
}
export async function gitDiff(workspaceId: string, filePath: string, staged: boolean, sessionId?: string): Promise<DiffHunk[]> {
  if (ipc) return ipc.gitDiff(workspaceId, filePath, staged, sessionId);
  return [];
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
