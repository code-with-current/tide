/**
 * Preload script — runs in the renderer process before the page loads.
 *
 * Exposes a narrow, named API to the renderer via `contextBridge`. The renderer
 * never gets direct access to `ipcRenderer`, Node, or the filesystem — only
 * the specific methods listed here.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tideIpc', {
  // ── Workspaces ──
  listWorkspaces: () => ipcRenderer.invoke('tide:listWorkspaces'),
  getWorkspace: (id: string) => ipcRenderer.invoke('tide:getWorkspace', id),

  // ── Last session (cross-restart persistence) ──
  getLastSession: () => ipcRenderer.invoke('tide:getLastSession'),
  setLastSession: (sessionId: string | null, workspaceId: string | null) =>
    ipcRenderer.invoke('tide:setLastSession', sessionId, workspaceId),

  // ── File dialog (real) ──
  pickDirectory: () => ipcRenderer.invoke('tide:pickDirectory'),
  pickFiles: () => ipcRenderer.invoke('tide:pickFiles'),
  readExternalFile: (filePath: string) => ipcRenderer.invoke('tide:readExternalFile', filePath),
  detectExternalApps: () => ipcRenderer.invoke('tide:openInApp:detect'),
  getDiagnostics: () => ipcRenderer.invoke('tide:getDiagnostics'),
  openInApp: (target, sessionId) => ipcRenderer.invoke('tide:openInApp:open', target, sessionId),
  // Settings (settings.json) — shortcut overrides + platform-aware defaults.
  getSettings: () => ipcRenderer.invoke('tide:settings:get'),
  setShortcut: (id, keys) => ipcRenderer.invoke('tide:settings:setShortcut', id, keys),
  resetShortcuts: () => ipcRenderer.invoke('tide:settings:resetShortcuts'),
  // Extensions (extensions.json) — enable/disable per agent or skill, plus
  // unified catalogs (builtins + project + user) for the management panel.
  listExtensions: () => ipcRenderer.invoke('tide:extensions:list'),
  setExtensionEnabled: (domain: 'agents' | 'skills', name: string, enabled: boolean) =>
    ipcRenderer.invoke('tide:extensions:setEnabled', domain, name, enabled),
  listExtensionAgents: (workspaceRoot: string) =>
    ipcRenderer.invoke('tide:extensions:listAgents', workspaceRoot),
  listExtensionSkills: (workspaceRoot: string) =>
    ipcRenderer.invoke('tide:extensions:listSkills', workspaceRoot),
  listExtensionMcp: (workspaceRoot: string) =>
    ipcRenderer.invoke('tide:extensions:listMcp', workspaceRoot),
  // MCP (mcp.json / .mcp.json) — server management + connection status.
  // add/update/remove take a scope ('user' for global, 'project' for the
  // active workspace's .mcp.json). Status pushes arrive on
  // 'tide:mcp:statusChanged'; the renderer re-fetches via mcpList.
  mcpList: (workspaceId?: string) =>
    ipcRenderer.invoke('tide:mcp:list', workspaceId),
  mcpAdd: (name: string, config: unknown, scope: 'user' | 'project') =>
    ipcRenderer.invoke('tide:mcp:add', name, config, scope),
  mcpUpdate: (name: string, config: unknown, scope: 'user' | 'project') =>
    ipcRenderer.invoke('tide:mcp:update', name, config, scope),
  mcpRemove: (name: string, scope: 'user' | 'project') =>
    ipcRenderer.invoke('tide:mcp:remove', name, scope),
  mcpApprove: (name: string) =>
    ipcRenderer.invoke('tide:mcp:approve', name),
  mcpRetry: (name: string, scope: 'user' | 'project', workspaceId?: string) =>
    ipcRenderer.invoke('tide:mcp:retry', name, scope, workspaceId),
  mcpSetSecret: (name: string, value: string) =>
    ipcRenderer.invoke('tide:mcp:setSecret', name, value),
  mcpHasSecret: (name: string) =>
    ipcRenderer.invoke('tide:mcp:hasSecret', name),
  mcpClearSecret: (name: string) =>
    ipcRenderer.invoke('tide:mcp:clearSecret', name),
  mcpReauthorize: (name: string, scope: 'user' | 'project', workspaceId?: string) =>
    ipcRenderer.invoke('tide:mcp:reauthorize', name, scope, workspaceId),
  mcpScan: () =>
    ipcRenderer.invoke('tide:mcp:scan'),
  mcpImport: (servers: Array<{ name: string; config: unknown }>, scope: 'user' | 'project') =>
    ipcRenderer.invoke('tide:mcp:import', servers, scope),
  mcpSetEnabled: (name: string, enabled: boolean, scope: 'user' | 'project') =>
    ipcRenderer.invoke('tide:mcp:setEnabled', name, enabled, scope),
  mcpReadRaw: (scope: 'user' | 'project') =>
    ipcRenderer.invoke('tide:mcp:readRaw', scope),
  mcpWriteRaw: (config: Record<string, unknown>, scope: 'user' | 'project') =>
    ipcRenderer.invoke('tide:mcp:writeRaw', config, scope),
  mcpWorkspaceActivated: (workspaceId: string, workspaceRoot: string) =>
    ipcRenderer.invoke('tide:mcp:workspaceActivated', workspaceId, workspaceRoot),
  onMcpStatusChanged: (callback: () => void) =>
    ipcRenderer.on('tide:mcp:statusChanged', () => callback()),
  removeAllMcpListeners: () => {
    ipcRenderer.removeAllListeners('tide:mcp:statusChanged');
  },
  // Reveal a file/folder in the OS file manager (Finder/Explorer).
  showItemInFolder: (fullPath: string) => {
    const { shell } = require('electron');
    shell.showItemInFolder(fullPath);
  },
  detectGitRepo: (dirPath: string) => ipcRenderer.invoke('tide:detectGitRepo', dirPath),
  addWorkspace: (input: { path: string; name?: string; repository?: string }) =>
    ipcRenderer.invoke('tide:addWorkspace', input),

  // ── Sessions ──
  listSessions: (workspaceId: string) => ipcRenderer.invoke('tide:listSessions', workspaceId),
  listAgents: () => ipcRenderer.invoke('tide:listAgents'),
  // Project-level entries (CLAUDE.md / AGENT.md + .claude|.agent/skills|agents).
  listProjectEntries: (workspaceId: string) => ipcRenderer.invoke('tide:listProjectEntries', workspaceId),
  // Todos — model-maintained via the todo_write tool. Live updates arrive
  // on 'todos:updated' so the floating panel reflects progress in real time.
  listTodos: (sessionId: string) => ipcRenderer.invoke('tide:listTodos', sessionId),
  subscribeTodos: () => ipcRenderer.invoke('tide:subscribeTodos'),
  onTodosUpdated: (callback: (data: { sessionId: string; todos: any[] }) => void) =>
    ipcRenderer.on('todos:updated', (_e, data) => callback(data)),
  removeTodosListener: () => ipcRenderer.removeAllListeners('todos:updated'),
  getSession: (id: string) => ipcRenderer.invoke('tide:getSession', id),
  createSession: (workspaceId: string, title: string, modelId: string, opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max' }) =>
    ipcRenderer.invoke('tide:createSession', workspaceId, title, modelId, opts),
  updateSessionSettings: (sessionId: string, patch: { modelId?: string; autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max' }) =>
    ipcRenderer.invoke('tide:updateSessionSettings', sessionId, patch),
  addMessage: (sessionId: string, role: 'user' | 'assistant' | 'system', content: string) =>
    ipcRenderer.invoke('tide:addMessage', sessionId, role, content),
  addAssistantMessage: (sessionId: string, message: {
    content: string;
    reasoning?: string;
    reasoningTokens?: number;
    reasoningMs?: number;
    toolCalls?: any[];
    timeline?: any[];
    turn?: any;
  }) =>
    ipcRenderer.invoke('tide:addAssistantMessage', sessionId, message),
  addSessionUsage: (
    sessionId: string,
    delta: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number; calls?: number; costUsd?: number },
  ) => ipcRenderer.invoke('tide:addSessionUsage', sessionId, delta),
  deleteSession: (id: string) => ipcRenderer.invoke('tide:deleteSession', id),
  clearAllSessions: () => ipcRenderer.invoke('tide:clearAllSessions'),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke('tide:renameSession', sessionId, title),
  generateSessionTitle: (sessionId: string) =>
    ipcRenderer.invoke('tide:generateSessionTitle', sessionId),
  getAgentSettings: () =>
    ipcRenderer.invoke('tide:getAgentSettings'),
  updateAgentSettings: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('tide:updateAgentSettings', patch),
  archiveSession: (sessionId: string) =>
    ipcRenderer.invoke('tide:archiveSession', sessionId),
  unarchiveSession: (sessionId: string) =>
    ipcRenderer.invoke('tide:unarchiveSession', sessionId),
  listArchivedSessions: (workspaceId: string) =>
    ipcRenderer.invoke('tide:listArchivedSessions', workspaceId),
  createWorktree: (sessionId: string, opts: { branchName: string; baseBranch: string; configFiles?: string[] }) =>
    ipcRenderer.invoke('tide:session:createWorktree', sessionId, opts),
  removeWorktree: (sessionId: string) =>
    ipcRenderer.invoke('tide:session:removeWorktree', sessionId),
  listBranches: (workspaceId: string) =>
    ipcRenderer.invoke('tide:workspace:listBranches', workspaceId),
  listConfigFiles: (workspaceId: string) =>
    ipcRenderer.invoke('tide:workspace:listConfigFiles', workspaceId),

  // ── Providers (real persistence) ──
  listProviders: () => ipcRenderer.invoke('tide:listProviders'),
  addProvider: (input: {
    name: string;
    apiStyle: 'openai' | 'anthropic';
    baseUrl: string;
    apiKey?: string;
    models?: { alias: string; modelId: string; contextWindow: number }[];
  }) => ipcRenderer.invoke('tide:addProvider', input),
  updateProvider: (id: string, patch: any) => ipcRenderer.invoke('tide:updateProvider', id, patch),
  deleteProvider: (id: string) => ipcRenderer.invoke('tide:deleteProvider', id),
  // Probe the provider's /models endpoint with the form's current values
  // (works in the add form before the provider is saved). Returns the list
  // of model ids the API exposes, or an error message.
  probeProviderModels: (input: { apiStyle: 'openai' | 'anthropic'; baseUrl: string; apiKey: string }) =>
    ipcRenderer.invoke('tide:provider:probeModels', input),
  testProviderConnection: (input: { apiStyle: 'openai' | 'anthropic'; baseUrl: string; apiKey: string; modelId: string }) =>
    ipcRenderer.invoke('tide:provider:testConnection', input),

  // Resolve a model against the LiteLLM catalog — returns match state +
  // full metadata. Used by the Fetch Models dialog to enrich rows with
  // price / context / capabilities.
  modelCatalog: {
    resolve: (input: { catalogId?: string; modelId: string; contextWindow: number }) =>
      ipcRenderer.invoke('tide:modelCatalog:resolve', input),
  },

  // ── Logging (renderer → main file) ──
  // Forwards renderer log calls to the central log file via IPC.
  log: {
    send: (level: string, tag: string, msg: string, args?: unknown[]) =>
      ipcRenderer.invoke('tide:log', { level, tag, msg, args }),
  },

  // ── File explorer ──
  getFileTree: (workspaceId: string) => ipcRenderer.invoke('tide:getFileTree', workspaceId),

  // ── Workspace context for the system prompt ──
  getWorkspaceContext: (workspaceId: string) =>
    ipcRenderer.invoke('tide:getWorkspaceContext', workspaceId),

  // ── Read a file from a workspace (sandboxed to root) ──
  readFileInWorkspace: (workspaceId: string, relPath: string) =>
    ipcRenderer.invoke('tide:readFileInWorkspace', workspaceId, relPath),

  // ── Terminal seed ──
  getTerminalLines: (sessionId: string) => ipcRenderer.invoke('tide:getTerminalLines', sessionId),
  // ── Real terminal (bottom panel) ──
  terminalStart: (terminalId: string, sessionId: string) => ipcRenderer.invoke('terminal:start', terminalId, sessionId),
  terminalInput: (terminalId: string, input: string) => ipcRenderer.invoke('terminal:input', terminalId, input),
  terminalKill: (terminalId: string) => ipcRenderer.invoke('terminal:kill', terminalId),
  terminalStop: (terminalId: string) => ipcRenderer.invoke('terminal:stop', terminalId),
  terminalResize: (terminalId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', terminalId, cols, rows),
  onTerminalOutput: (callback: (data: { terminalId: string; data: string }) => void) =>
    ipcRenderer.on('terminal:output', (_e, data) => callback(data)),
  onTerminalExit: (callback: (data: { terminalId: string; code: number | null }) => void) =>
    ipcRenderer.on('terminal:exit', (_e, data) => callback(data)),
  onTerminalPorts: (callback: (data: { terminalId: string; ports: { port: number; url: string; label: string }[] }) => void) =>
    ipcRenderer.on('terminal:ports', (_e, data) => callback(data)),
  removeAllTerminalListeners: () => {
    ipcRenderer.removeAllListeners('terminal:output');
    ipcRenderer.removeAllListeners('terminal:exit');
    ipcRenderer.removeAllListeners('terminal:ports');
  },

  // ── Workspace scripts (real process execution) ──
  runScript: (workspaceId: string, command: string) =>
    ipcRenderer.invoke('tide:script:run', { workspaceId, command }),
  stopScript: (workspaceId: string, command: string) =>
    ipcRenderer.invoke('tide:script:stop', { workspaceId, command }),
  getScriptPorts: (workspaceId: string) =>
    ipcRenderer.invoke('tide:getScriptPorts', workspaceId),
  onScriptOutput: (callback: (data: any) => void) =>
    ipcRenderer.on('script:output', (_e, data) => callback(data)),
  onScriptExit: (callback: (data: any) => void) =>
    ipcRenderer.on('script:exit', (_e, data) => callback(data)),
  onScriptPorts: (callback: (data: any) => void) =>
    ipcRenderer.on('script:ports', (_e, data) => callback(data)),
  removeAllScriptListeners: () => {
    ipcRenderer.removeAllListeners('script:output');
    ipcRenderer.removeAllListeners('script:exit');
    ipcRenderer.removeAllListeners('script:ports');
  },
  updateWorkspace: (id: string, patch: any) =>
    ipcRenderer.invoke('tide:updateWorkspace', id, patch),
  archiveWorkspace: (id: string) => ipcRenderer.invoke('tide:archiveWorkspace', id),
  unarchiveWorkspace: (id: string) => ipcRenderer.invoke('tide:unarchiveWorkspace', id),
  deleteWorkspace: (id: string) => ipcRenderer.invoke('tide:deleteWorkspace', id),

  // ── Git source control ──
  // sessionId is optional — when the active session has a worktree, the
  // operation runs against the worktree path instead of the workspace's
  // main checkout. Source Control + Inspector both pass it through.
  gitStatus: (workspaceId: string, sessionId?: string) =>
    ipcRenderer.invoke('tide:gitStatus', workspaceId, sessionId),
  gitStage: (workspaceId: string, filePath: string, stage: boolean, sessionId?: string) =>
    ipcRenderer.invoke('tide:gitStage', workspaceId, filePath, stage, sessionId),
  gitCommit: (workspaceId: string, message: string, sessionId?: string) =>
    ipcRenderer.invoke('tide:gitCommit', workspaceId, message, sessionId),
  gitDiff: (workspaceId: string, filePath: string, staged: boolean, sessionId?: string) =>
    ipcRenderer.invoke('tide:gitDiff', workspaceId, filePath, staged, sessionId),

  // ── RAG (Memory & RAG panel) ──
  ragStatus: (workspaceId: string) =>
    ipcRenderer.invoke('tide:rag:status', workspaceId),
  downloadRagModel: () => ipcRenderer.invoke('tide:rag:downloadModel'),
  enableRagWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke('tide:rag:enableWorkspace', workspaceId),
  disableRagWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke('tide:rag:disableWorkspace', workspaceId),
  initRagWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke('tide:rag:initWorkspace', workspaceId),
  onRagInitProgress: (cb: (e: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('tide:rag:initProgress', listener);
    return () => ipcRenderer.off('tide:rag:initProgress', listener);
  },

  // ── Agent (tool-calling loop) ──
  runTurn: (payload) => ipcRenderer.invoke('agent:runTurn', payload),
  abortTurn: (sessionId) => ipcRenderer.invoke('agent:abort', sessionId),
  approveToolCalls: (sessionId, toolCallIds, newMode, remember) =>
    ipcRenderer.invoke('agent:tool:approve', sessionId, toolCallIds, newMode, remember),
  rejectToolCalls: (sessionId, toolCallIds, reason) =>
    ipcRenderer.invoke('agent:tool:reject', sessionId, toolCallIds, reason),
  submitFollowup: (sessionId, toolCallId, answer) =>
    ipcRenderer.invoke('agent:followup:submit', sessionId, toolCallId, answer),
  updateMode: (sessionId, mode) =>
    ipcRenderer.invoke('agent:updateMode', sessionId, mode),
  onAgentEvent: (callback) => {
    ipcRenderer.on('agent:event', (_e, event) => callback(event));
  },
  removeAllAgentListeners: () => {
    ipcRenderer.removeAllListeners('agent:event');
  },

  // ── Chat streaming (legacy) ──
  chatStream: (payload: {
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
    modelId: string;
    providerId: string;
  }) => ipcRenderer.invoke('tide:chat:stream', payload),
  chatAbort: () => ipcRenderer.invoke('tide:chat:abort'),

  // ── Chat event listeners (main → renderer push) ──
  onChatDelta: (callback: (data: { text: string }) => void) =>
    ipcRenderer.on('chat:delta', (_e, data) => callback(data)),
  onChatDone: (callback: (data: { aborted?: boolean }) => void) =>
    ipcRenderer.on('chat:done', (_e, data) => callback(data)),
  onChatError: (callback: (data: { message: string }) => void) =>
    ipcRenderer.on('chat:error', (_e, data) => callback(data)),
  // Remove all chat event listeners.
  removeAllChatListeners: () => {
    ipcRenderer.removeAllListeners('chat:delta');
    ipcRenderer.removeAllListeners('chat:done');
    ipcRenderer.removeAllListeners('chat:error');
  },
});
