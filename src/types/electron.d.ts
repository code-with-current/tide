/**
 * TypeScript declaration for the Electron preload bridge.
 */

declare global {
  interface Window {
    tideIpc?: {
      // Workspaces
      listWorkspaces(): Promise<import('./index').Workspace[]>;
      getWorkspace(id: string): Promise<import('./index').Workspace | undefined>;

      // Last session (cross-restart persistence via config.json)
      getLastSession(): Promise<{ sessionId: string | null; workspaceId: string | null }>;
      setLastSession(sessionId: string | null, workspaceId: string | null): Promise<void>;

      // File dialog (real)
      pickDirectory(): Promise<string | null>;
      pickFiles(): Promise<string[]>;
      readExternalFile(filePath: string): Promise<{ content: string; bytes: number; truncated: boolean } | null>;
      // Open the active session's project folder in an external app. The path
      // is resolved server-side from sessionId (worktree.path → workspace.path
      // → HOME), so the renderer never passes an arbitrary path.
      detectExternalApps(): Promise<import('./index').ExternalApp[]>;
      getDiagnostics(): Promise<{
        appVersion: string;
        electron: string;
        chrome: string;
        node: string;
        platform: string;
        userDataPath: string;
      }>;
      openInApp(
        target: import('./index').ExternalAppTarget,
        sessionId?: string,
      ): Promise<{ ok: boolean; error?: string }>;
      // settings.json — shortcut overrides + platform-aware defaults.
      getSettings(): Promise<{
        overrides: Record<string, string[]>;
        defaults: Record<string, string[]>;
      }>;
      setShortcut(id: string, keys: string[] | null): Promise<Record<string, string[]>>;
      resetShortcuts(): Promise<Record<string, string[]>>;
      // extensions.json — allowlist of disabled agents/skills + unified
      // catalogs (builtins + project + user) for the Extensions panel.
      listExtensions(): Promise<{ agents: string[]; skills: string[] }>;
      setExtensionEnabled(
        domain: 'agents' | 'skills',
        name: string,
        enabled: boolean,
      ): Promise<{ agents: string[]; skills: string[] }>;
      listExtensionAgents(workspaceRoot: string): Promise<{
        name: string;
        description: string;
        whenToUse: string;
        source: 'builtin' | 'project' | 'user';
        path?: string;
        enabled: boolean;
      }[]>;
      listExtensionSkills(workspaceRoot: string): Promise<{
        name: string;
        description: string;
        source: 'project' | 'user';
        path: string;
        absPath: string;
        enabled: boolean;
      }[]>;
      listExtensionMcp(workspaceRoot: string): Promise<{
        runtimeReady: boolean;
        servers: { name: string; command: string }[];
      }>;
      // MCP server management (mcp.json / .mcp.json). Each add/update/remove
      // targets a scope: 'user' (global, ~/.tide/mcp.json) or 'project'
      // (the active workspace's .mcp.json). The status list merges both.
      mcpList(workspaceId?: string): Promise<{
        name: string;
        scope: 'user' | 'project';
        config: import('../../electron/agent/mcp/types').McpServerConfig;
        status:
          | 'connecting'
          | 'connected'
          | 'error'
          | 'disconnected'
          | 'needs_approval'
          | 'needs_credentials'
          | 'needs_oauth';
        toolCount: number;
        error?: string;
        transport: 'stdio' | 'sse' | 'http';
        enabled: boolean;
      }[]>;
      mcpAdd(
        name: string,
        config: import('../../electron/agent/mcp/types').McpServerConfig,
        scope: 'user' | 'project',
      ): Promise<{ ok: boolean; error?: string }>;
      mcpUpdate(
        name: string,
        config: import('../../electron/agent/mcp/types').McpServerConfig,
        scope: 'user' | 'project',
      ): Promise<{ ok: boolean; error?: string }>;
      mcpRemove(name: string, scope: 'user' | 'project'): Promise<{ ok: boolean; error?: string }>;
      mcpApprove(name: string): Promise<{ ok: boolean }>;
      mcpRetry(
        name: string,
        scope: 'user' | 'project',
        workspaceId?: string,
      ): Promise<{ ok: boolean }>;
      mcpSetSecret(name: string, value: string): Promise<{ ok: boolean }>;
      mcpHasSecret(name: string): Promise<boolean>;
      mcpClearSecret(name: string): Promise<{ ok: boolean }>;
      mcpReauthorize(name: string, scope: 'user' | 'project', workspaceId?: string): Promise<{ ok: boolean }>;
      mcpScan(): Promise<{
        servers: Array<{
          name: string;
          config: { type: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string };
          source: string;
          sourceFile: string;
        }>;
        alreadyImported: string[];
      }>;
      mcpImport(
        servers: Array<{ name: string; config: unknown }>,
        scope: 'user' | 'project',
      ): Promise<{ ok: boolean; imported?: number; error?: string }>;
      mcpSetEnabled(name: string, enabled: boolean, scope: 'user' | 'project'): Promise<{ ok: boolean }>;
      mcpReadRaw(scope: 'user' | 'project'): Promise<{
        ok: boolean;
        error?: string;
        config?: Record<string, unknown>;
      }>;
      mcpWriteRaw(
        config: Record<string, unknown>,
        scope: 'user' | 'project',
      ): Promise<{ ok: boolean; error?: string }>;
      mcpWorkspaceActivated(workspaceId: string, workspaceRoot: string): Promise<{ ok: boolean }>;
      onMcpStatusChanged(callback: () => void): void;
      removeAllMcpListeners(): void;
      showItemInFolder(fullPath: string): void;
      detectGitRepo(dirPath: string): Promise<{ branch: string; headCommit: string; fileCount: number; isRepo: boolean } | null>;
      addWorkspace(input: {
        path: string;
        name?: string;
        repository?: string;
        /** Optional project template to scaffold (New Project → From Template). */
        template?: import('@/lib/templates').TemplateId;
      }): Promise<import('./index').Workspace>;

      // Sessions
      listSessions(workspaceId: string): Promise<any[]>;
      /** Built-in sub-agents for the @mention picker + dispatch_agent tool catalog. */
      listAgents(): Promise<{ name: string; description: string; whenToUse: string }[]>;
      /** Project-level entries (CLAUDE.md / AGENT.md + .claude|.agent/skills|agents).
       *  Also includes user-level skills/agents (~/.claude/, ~/.agent/),
       *  deduped by name with project entries taking precedence. The
       *  `source` field distinguishes origin for the picker badge. */
      listProjectEntries(workspaceId: string): Promise<{
        contextFiles: { name: string; path: string; absPath: string; description: string; content: string; bytes: number; truncated: boolean; source?: 'project' | 'user' }[];
        skills: { name: string; path: string; absPath: string; description: string; content: string; bytes: number; truncated: boolean; source?: 'project' | 'user' }[];
        agents: { name: string; path: string; absPath: string; description: string; content: string; bytes: number; truncated: boolean; source?: 'project' | 'user' }[];
      }>;
      // Todos — model-maintained via the todo_write tool. Live updates stream
      // via onTodosUpdated; the floating panel subscribes per active session.
      listTodos(sessionId: string): Promise<{ content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: 'high' | 'medium' | 'low' }[]>;
      subscribeTodos(): Promise<void>;
      onTodosUpdated(callback: (data: { sessionId: string; todos: any[] }) => void): void;
      removeTodosListener(): void;
      getSession(id: string): Promise<any>;
      createSession(workspaceId: string, title: string, modelId: string, opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string }): Promise<any>;
      updateSessionSettings(sessionId: string, patch: { modelId?: string; autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string }): Promise<void>;
      addMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): Promise<void>;
      addAssistantMessage(
        sessionId: string,
        message: { content: string; reasoning?: string; reasoningTokens?: number; toolCalls?: any[] },
      ): Promise<void>;
      addSessionUsage(
        sessionId: string,
        delta: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number; calls?: number; costUsd?: number },
      ): Promise<void>;
      deleteSession(id: string): Promise<void>;
      clearAllSessions: () => Promise<{ ok: boolean }>;
      renameSession(sessionId: string, title: string): Promise<void>;
      generateSessionTitle(sessionId: string): Promise<string | null>;
      getAgentSettings(): Promise<{ defaultAutonomy: string; maxSteps: number; permissionTimeoutMin: number; planModeDryRun: boolean; auditShellCommands: boolean }>;
      updateAgentSettings(patch: Record<string, unknown>): Promise<{ defaultAutonomy: string; maxSteps: number; permissionTimeoutMin: number; planModeDryRun: boolean; auditShellCommands: boolean }>;
      archiveSession(sessionId: string): Promise<void>;
      unarchiveSession(sessionId: string): Promise<void>;
      listArchivedSessions(workspaceId: string): Promise<import('./index').ArchivedHeader[]>;
      createWorktree(
        sessionId: string,
        opts: { branchName: string; baseBranch: string; configFiles?: string[] },
      ): Promise<{ branch: string; path: string; baseBranch: string; baseCommit: string; ahead: number; behind: number }>;
      removeWorktree(sessionId: string): Promise<void>;
      listBranches(workspaceId: string): Promise<string[]>;
      listConfigFiles(workspaceId: string): Promise<string[]>;

      // Providers (real persistence)
      listProviders(): Promise<import('./index').Provider[]>;
      addProvider(input: {
        name: string;
        apiStyle: import('./index').ApiStyle;
        baseUrl: string;
        apiKey?: string;
        models?: { alias: string; modelId: string; contextWindow: number }[];
      }): Promise<import('./index').Provider>;
      updateProvider(id: string, patch: any): Promise<import('./index').Provider | null>;
      deleteProvider(id: string): Promise<boolean>;
      /** Probe the provider's /models endpoint using the form's current values. */
      probeProviderModels(input: {
        apiStyle: import('./index').ApiStyle;
        baseUrl: string;
        apiKey: string;
      }): Promise<{ ok: true; models: import('./index').ProviderModelMeta[] } | { ok: false; error: string }>;
      /** Test provider connection by sending a minimal chat completion. */
      testProviderConnection(input: {
        apiStyle: import('./index').ApiStyle;
        baseUrl: string;
        apiKey: string;
        modelId: string;
      }): Promise<{ ok: true } | { ok: false; error: string }>;
      /** Resolve a model against the LiteLLM catalog — returns match state +
       *  full metadata. Shapes mirror ModelMeta / MatchResult / CatalogEntry
       *  from electron/agent/model-catalog.ts and model-prices.ts. */
      modelCatalog: {
        resolve(input: {
          catalogId?: string;
          modelId: string;
          contextWindow: number;
        }): Promise<{
          meta: {
            contextWindow: number;
            maxOutputTokens: number;
            supportsReasoning: boolean;
            supportsFunctionCalling: boolean;
            supportsPromptCaching: boolean;
            supportsVision: boolean;
            mode: string;
            isValidForMainRole: boolean;
            pricing: { inputPerToken: number; outputPerToken: number } | null;
            resolvedCatalogId: string | null;
          };
          match: {
            state: 'matched' | 'ambiguous' | 'none';
            matches: Array<{
              catalogId: string;
              mode: string;
              maxInputTokens: number;
              maxOutputTokens: number;
              inputCostPerToken: number;
              outputCostPerToken: number;
              supportsReasoning: boolean;
              supportsFunctionCalling: boolean;
              supportsVision: boolean;
              supportsPromptCaching: boolean;
            }>;
          };
        }>;
      };

      /** Forward a renderer log line to the central log file (via IPC → main). */
      log: {
        send(level: string, tag: string, msg: string, args?: unknown[]): Promise<void>;
      };

      // File explorer
      getFileTree(workspaceId: string): Promise<import('./index').FileNode[]>;

      // Workspace context for the system prompt (package.json + README + top-level tree)
      getWorkspaceContext(workspaceId: string): Promise<string>;

      // Read a file from a workspace, sandboxed to its root. Returns null on failure.
      readFileInWorkspace(
        workspaceId: string,
        relPath: string,
      ): Promise<
        | { ok: true; content: string; truncated: boolean; bytes: number }
        | { ok: false; reason: string }
      >;

      // Terminal seed
      getTerminalLines(sessionId: string): Promise<any[]>;
      // ── Real terminal (bottom panel) ──
      terminalStart: (terminalId: string, sessionId: string) => Promise<void>;
      terminalInput: (terminalId: string, input: string) => Promise<void>;
      terminalKill: (terminalId: string) => Promise<void>;
      terminalStop: (terminalId: string) => Promise<void>;
      terminalResize: (terminalId: string, cols: number, rows: number) => Promise<void>;
      onTerminalOutput(callback: (data: { terminalId: string; data: string }) => void): void;
      onTerminalExit(callback: (data: { terminalId: string; code: number | null }) => void): void;
      onTerminalPorts(callback: (data: { terminalId: string; ports: { port: number; url: string; label: string }[] }) => void): void;
      removeAllTerminalListeners(): void;

      // Workspace scripts (real process execution)
      runScript(workspaceId: string, command: string): Promise<{ ok: boolean; pid?: number; reason?: string }>;
      stopScript(workspaceId: string, command: string): Promise<{ ok: boolean; reason?: string }>;
      getScriptPorts(workspaceId: string): Promise<{ port: number; label: string; url: string }[]>;
      onScriptOutput(callback: (data: { workspaceId: string; command: string; stream: string; line: string }) => void): void;
      onScriptExit(callback: (data: { workspaceId: string; command: string; code: number | null }) => void): void;
      onScriptPorts(callback: (data: { workspaceId: string; ports: { port: number; label: string; url: string }[] }) => void): void;
      removeAllScriptListeners(): void;
      updateWorkspace(id: string, patch: any): Promise<any>;
      archiveWorkspace: (id: string) => Promise<void>;
      unarchiveWorkspace: (id: string) => Promise<void>;
      deleteWorkspace: (id: string) => Promise<{ ok: boolean; error?: string }>;

      // ── Git source control ──
      gitStatus: (workspaceId: string, sessionId?: string) => Promise<any[]>;
      gitStage: (workspaceId: string, filePath: string, stage: boolean, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      gitCommit: (workspaceId: string, message: string, sessionId?: string) => Promise<{ ok: boolean; sha?: string; error?: string }>;
      gitDiff: (workspaceId: string, filePath: string, staged: boolean, sessionId?: string) => Promise<any[]>;

      // ── RAG (Memory & RAG panel) ──
      ragStatus: (workspaceId: string) => Promise<import('./index').RagStatus | { error: string }>;
      downloadRagModel: () => Promise<import('./index').RagWorkspaceOpResult>;
      enableRagWorkspace: (workspaceId: string) => Promise<import('./index').RagWorkspaceOpResult>;
      disableRagWorkspace: (workspaceId: string) => Promise<import('./index').RagWorkspaceOpResult>;
      initRagWorkspace: (workspaceId: string) => Promise<import('./index').RagInitResult>;
      onRagInitProgress: (cb: (e: import('./index').RagInitProgressEvent) => void) => () => void;

      // ─────────────────────────────────────────────────────────
      // Agent (tool-calling loop). Replaces the old chat:stream trio.
      // ─────────────────────────────────────────────────────────
      runTurn(
        payload: import('../lib/agent/events').RunTurnPayload,
      ): Promise<void>;
      abortTurn(sessionId: string): Promise<void>;
      approveToolCalls(sessionId: string, toolCallIds: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: 'session' | 'project'): Promise<void>;
      rejectToolCalls(
        sessionId: string,
        toolCallIds: string[],
        reason?: string,
      ): Promise<void>;
      submitFollowup(sessionId: string, toolCallId: string, answer: string): Promise<void>;
      /** Live-update the autonomy mode on a running turn (mid-stream). */
      updateMode(sessionId: string, mode: import('./index').AutonomyMode): Promise<void>;
      onAgentEvent(
        callback: (event: import('../lib/agent/events').AgentEvent) => void,
      ): void;
      removeAllAgentListeners(): void;

      // ─────────────────────────────────────────────────────────
      // Legacy chat streaming — kept for back-compat during migration.
      // Internally routes to the agent loop for Anthropic providers.
      // ─────────────────────────────────────────────────────────
      chatStream(payload: {
        messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
        modelId: string;
        providerId: string;
      }): Promise<void>;
      chatAbort(): Promise<void>;
      onChatDelta(callback: (data: { text: string }) => void): void;
      onChatDone(callback: (data: { aborted?: boolean }) => void): void;
      onChatError(callback: (data: { message: string }) => void): void;
      removeAllChatListeners(): void;
    };
  }
}

export {};
