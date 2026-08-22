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
      getPathForFile(file: File): string;
      saveClipboardFile(name: string, bytes: ArrayBuffer): Promise<string>;
      readExternalFile(filePath: string): Promise<{ content: string; bytes: number; truncated: boolean } | null>;
      readImageFile(input: { absPath?: string; workspaceId?: string; relPath?: string }): Promise<{ dataUrl: string; bytes: number } | null>;
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
      getEnvInfo(): Promise<{
        platform: string;
        arch: string;
        release: string;
        shell: string;
      }>;
      openInApp(
        target: import('./index').ExternalAppTarget,
        sessionId?: string,
      ): Promise<{ ok: boolean; error?: string }>;
      // macOS permissions (consent screen). No-op on non-mac.
      permissionStatus(): Promise<{
        platform: 'mac' | 'other';
        accessibility: 'authorized' | 'denied' | 'restricted' | 'not determined' | null;
        fullDiskAccess: 'authorized' | 'denied' | 'restricted' | 'not determined' | null;
        folders: 'unknown' | null;
      }>;
      requestPermission(type: 'accessibility' | 'fullDiskAccess' | 'folders'): Promise<'opened' | 'unavailable'>;
      shouldShowConsent(): Promise<boolean>;
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
        scope: 'user' | 'project' | 'builtin' | 'builtin';
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
        toolNames: string[];
        error?: string;
        transport: 'stdio' | 'sse' | 'http';
        enabled: boolean;
      }[]>;
      mcpAdd(
        name: string,
        config: import('../../electron/agent/mcp/types').McpServerConfig,
        scope: 'user' | 'project' | 'builtin',
      ): Promise<{ ok: boolean; error?: string }>;
      mcpUpdate(
        name: string,
        config: import('../../electron/agent/mcp/types').McpServerConfig,
        scope: 'user' | 'project' | 'builtin',
      ): Promise<{ ok: boolean; error?: string }>;
      mcpRemove(name: string, scope: 'user' | 'project' | 'builtin'): Promise<{ ok: boolean; error?: string }>;
      mcpApprove(name: string): Promise<{ ok: boolean }>;
      mcpRetry(
        name: string,
        scope: 'user' | 'project' | 'builtin',
        workspaceId?: string,
      ): Promise<{ ok: boolean }>;
      /** OAuth sign-in: opens the browser (user-initiated) + re-runs connect. */
      mcpAuthenticate(
        name: string,
        scope: 'user' | 'project' | 'builtin',
        workspaceId?: string,
      ): Promise<{ ok: boolean }>;
      /** Re-initialize ALL servers — disconnect + reconnect from config. */
      mcpReinitialize(): Promise<{ ok: boolean }>;
      mcpSetSecret(name: string, value: string): Promise<{ ok: boolean }>;
      mcpHasSecret(name: string): Promise<boolean>;
      mcpClearSecret(name: string): Promise<{ ok: boolean }>;
      mcpReauthorize(name: string, scope: 'user' | 'project' | 'builtin', workspaceId?: string): Promise<{ ok: boolean }>;
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
        scope: 'user' | 'project' | 'builtin',
      ): Promise<{ ok: boolean; imported?: number; error?: string }>;
      mcpSetEnabled(name: string, enabled: boolean, scope: 'user' | 'project' | 'builtin'): Promise<{ ok: boolean }>;
      mcpReadRaw(scope: 'user' | 'project' | 'builtin'): Promise<{
        ok: boolean;
        error?: string;
        config?: Record<string, unknown>;
      }>;
      mcpWriteRaw(
        config: Record<string, unknown>,
        scope: 'user' | 'project' | 'builtin',
      ): Promise<{ ok: boolean; error?: string }>;
      mcpWorkspaceActivated(workspaceId: string, workspaceRoot: string): Promise<{ ok: boolean }>;
      onMcpStatusChanged(callback: () => void): void;
      removeAllMcpListeners(): void;
      onNavigateToSession(callback: (sessionId: string) => void): void;
      isFullScreen(): Promise<boolean>;
      onFullscreenChanged(callback: (fullscreen: boolean) => void): () => void;
      showItemInFolder(fullPath: string): void;
      /** Open an http(s) URL in the system browser. No-op for other schemes. */
      openExternal(url: string): void;
      detectGitRepo(dirPath: string): Promise<{ branch: string; headCommit: string; fileCount: number; isRepo: boolean } | null>;
      addWorkspace(input: {
        path: string;
        name?: string;
        repository?: string;
        /** Optional project template to scaffold (New Project → From Template). */
        template?: import('@/lib/templates').TemplateId;
        /** Optional lifecycle scripts to persist on the new workspace
         *  (Existing Project flow: install = setup kind, running = run kind).
         *  Saved only — not executed during creation. */
        scripts?: import('./index').WorkspaceScript[];
        /** Existing local folder flow: run `git init` when the folder isn't
         *  already a git repo. Ignored for clone/scaffold flows. */
        initGit?: boolean;
        /** Correlates tide:workspace:progress milestone events back to this
         *  request (the workspace id doesn't exist yet). */
        requestId?: string;
      }): Promise<import('./index').Workspace>;
      /** Subscribe to workspace-creation milestones (tide:workspace:progress). */
      onWorkspaceProgress: (cb: (e: import('./index').WorkspaceProgressEvent) => void) => () => void;

      // Sessions
      listSessions(workspaceId: string): Promise<any[]>;
      /** Sub-agent dispatch child headers for a parent session, newest first. */
      listDispatches(parentId: string): Promise<any[]>;
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
      listTodos(sessionId: string): Promise<{ content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority?: 'high' | 'medium' | 'low' }[]>;
      subscribeTodos(): Promise<void>;
      onTodosUpdated(callback: (data: { sessionId: string; todos: any[] }) => void): void;
      removeTodosListener(): void;
      getSession(id: string): Promise<any>;
      createSession(workspaceId: string, title: string, modelId: string, opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string }): Promise<any>;
      updateSessionSettings(sessionId: string, patch: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max' }): Promise<void>;
      addMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string, extra?: { attachments?: any[]; mentions?: any[] }): Promise<void>;
      addAssistantMessage(
        sessionId: string,
        message: { content: string; reasoning?: string; reasoningTokens?: number; toolCalls?: any[] },
      ): Promise<void>;
      finalizeAssistantMessage(
        sessionId: string,
        messageId: string,
        message: { content: string; reasoning?: string; reasoningTokens?: number; toolCalls?: any[]; timeline?: any[]; turn?: any },
      ): Promise<void>;
      addSessionUsage(
        sessionId: string,
        delta: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number; calls?: number; costUsd?: number },
        lastStepUsage?: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number; calls?: number; costUsd?: number },
      ): Promise<void>;
      deleteSession(id: string): Promise<void>;
      clearAllSessions: () => Promise<{ ok: boolean }>;
      renameSession(sessionId: string, title: string): Promise<void>;
      generateSessionTitle(sessionId: string): Promise<string | null>;
      getAgentSettings(): Promise<{ defaultAutonomy: string; maxSteps: number; permissionTimeoutMin: number; planModeDryRun: boolean; auditShellCommands: boolean; experimentalBackgroundDispatch: boolean }>;
      updateAgentSettings(patch: Record<string, unknown>): Promise<{ defaultAutonomy: string; maxSteps: number; permissionTimeoutMin: number; planModeDryRun: boolean; auditShellCommands: boolean; experimentalBackgroundDispatch: boolean }>;
      getGeneralSettings(): Promise<{ startAtLogin: boolean; notifications: boolean; notificationSound: boolean; gitCoAuthored: boolean; gitCoAuthorName: string; gitCoAuthorEmail: string; autoUpdateCheck: boolean; titleModel?: { providerId: string; modelId: string } | null; commitMessageModel?: { providerId: string; modelId: string } | null }>;
      updateGeneralSettings(patch: Record<string, unknown>): Promise<{ startAtLogin: boolean; notifications: boolean; notificationSound: boolean; gitCoAuthored: boolean; gitCoAuthorName: string; gitCoAuthorEmail: string; autoUpdateCheck: boolean }>;
      archiveSession(sessionId: string): Promise<void>;
      unarchiveSession(sessionId: string): Promise<void>;
      listArchivedSessions(workspaceId: string): Promise<import('./index').ArchivedHeader[]>;
      createWorktree(
        sessionId: string,
        opts: { branchName: string; baseBranch: string; configFiles?: string[] },
      ): Promise<{ branch: string; path: string; baseBranch: string; baseCommit: string; ahead: number; behind: number }>;
      removeWorktree(sessionId: string): Promise<void>;
      forkSession(
        sourceId: string,
        newModelId: string,
        opts?: { autonomyMode?: 'ask' | 'plan' | 'edit' | 'full'; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max'; providerId?: string },
      ): Promise<import('./index').Session>;
      listBranches(workspaceId: string): Promise<string[]>;
      listConfigFiles(workspaceId: string): Promise<string[]>;

      // Part-normalized v2 sessions — paged by cursor / nextBefore message ids.
      sessionListV2(
        workspacePath: string,
        opts?: { archived?: boolean; cursor?: string | null; limit?: number },
      ): Promise<{ sessions: import('./session-v2').SessionMetaV2[]; nextCursor: string | null }>;
      sessionMessagesV2(
        sessionId: string,
        opts?: { limit?: number; before?: string | null },
      ): Promise<{ messages: import('./session-v2').MessageWithPartsV2[]; nextBefore: string | null }>;
      /** (Re)subscribe to a session's event stream — persisted events
       *  (seq > lastSeq) replay as tide:events batches before live push. */
      eventsSubscribe(sessionId: string, lastSeq: number | null): Promise<void>;
      /** Live + replayed event batches pushed on the tide:events channel. */
      onEvents: (cb: (batch: import('./session-v2').FlushBatchV2) => void) => () => void;

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
      /** Auto-detect the API protocol (OpenAI vs Anthropic) by probing both /models endpoints. */
      detectProviderProtocol(input: {
        baseUrl: string;
        apiKey: string;
      }): Promise<{ apiStyle: 'openai' | 'anthropic'; models: import('./index').ProviderModelMeta[] } | { error: string }>;
      /** Test provider connection by sending a minimal chat completion. */
      testProviderConnection(input: {
        apiStyle: import('./index').ApiStyle;
        baseUrl: string;
        apiKey: string;
        modelId: string;
      }): Promise<{ ok: true } | { ok: false; error: string }>;
      /** Resolve a model against the models.dev catalog — returns match state +
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

        /** Splash-screen trigger: pull a fresh models.dev catalog in the
         *  background. Resolves immediately; the fetch + re-enrichment
         *  continue in the main process. */
        refresh(): Promise<{ ok: boolean }>;
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
      terminalStart: (terminalId: string, sessionId: string, size?: { cols: number; rows: number }) => Promise<void>;
      /** Snapshot re-attach: scrollback + seq for a live PTY (alive:false → spawn fresh). */
      terminalSnapshot: (terminalId: string) => Promise<{ alive: true; data: string; seq: number } | { alive: false }>;
      terminalInput: (terminalId: string, input: string) => Promise<void>;
      terminalKill: (terminalId: string) => Promise<void>;
      terminalStop: (terminalId: string) => Promise<void>;
      terminalResize: (terminalId: string, cols: number, rows: number) => Promise<void>;
      /** Shell pid for a terminal (null if no PTY). Anchor for liveness checks. */
      terminalGetPid: (terminalId: string) => Promise<number | null>;
      /** Is a process (by pid) still alive? Used for port-liveness + Run/Stop. */
      processIsAlive: (pid: number) => Promise<boolean>;
      onTerminalOutput(callback: (data: { terminalId: string; data: string; seq?: number }) => void): void;
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
      /** Batch liveness probe: maps each path → whether the folder still exists.
       *  Drives the sidebar's "missing workspace" indicator. */
      workspacesExist: (paths: string[]) => Promise<Record<string, boolean>>;

      // ── Git ──
      gitStatus: (workspaceId: string, sessionId?: string) => Promise<any[]>;
      onGitChanged: (callback: (payload: { workspaceId: string }) => void) => (() => void) | undefined;
      gitLog: (workspaceId: string, sessionId?: string, limit?: number) => Promise<any[]>;
      gitCommitFiles: (workspaceId: string, sha: string, sessionId?: string) => Promise<any[]>;
      gitCommitFileDiff: (workspaceId: string, sha: string, filePath: string, sessionId?: string) => Promise<any[]>;
      gitBulk: (workspaceId: string, op: string, sessionId?: string, opts?: { message?: string }) => Promise<{ ok: boolean; error?: string }>;
      gitStashList: (workspaceId: string, sessionId?: string) => Promise<any[]>;
      gitBranchInfo: (workspaceId: string, sessionId?: string) => Promise<{ branch: string | null; headCommit: string | null }>;
      gitRecentBranches: (workspaceId: string, sessionId?: string) => Promise<string[]>;
      gitCheckout: (workspaceId: string, branch: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      gitCreateBranch: (workspaceId: string, branchName: string, sessionId?: string, sha?: string) => Promise<{ ok: boolean; error?: string }>;
      gitStage: (workspaceId: string, filePath: string, stage: boolean, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      gitCommit: (workspaceId: string, message: string, sessionId?: string) => Promise<{ ok: boolean; sha?: string; error?: string }>;
      gitDiff: (workspaceId: string, filePath: string, staged: boolean, sessionId?: string, contextLines?: number) => Promise<any[]>;
      gitHeadSha: (workspaceId: string, sessionId?: string) => Promise<string | null>;
      gitRestoreFile: (workspaceId: string, filePath: string, sha: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      gitAmend: (workspaceId: string, message: string | null, sessionId?: string) => Promise<{ ok: boolean; sha?: string; error?: string }>;
      gitRevert: (workspaceId: string, sha: string, sessionId?: string) => Promise<{ ok: boolean; newSha?: string; error?: string }>;
      gitFetch: (workspaceId: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      gitPush: (workspaceId: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      gitPull: (workspaceId: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      gitAheadBehind: (workspaceId: string, sessionId?: string) => Promise<{ ahead: number; behind: number } | null>;
      gitBranchesDetailed: (workspaceId: string, sessionId?: string) => Promise<import('../lib/api/client').GitBranchDetailed[]>;
      gitDeleteBranch: (workspaceId: string, name: string, force: boolean, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      gitMergeBranch: (workspaceId: string, name: string, sessionId?: string) => Promise<{ ok: boolean; conflicts?: import('../lib/api/client').GitConflictEntry[]; error?: string }>;
      gitConflictFiles: (workspaceId: string, sessionId?: string) => Promise<import('../lib/api/client').GitConflictEntry[]>;
      gitResolveFile: (workspaceId: string, filePath: string, side: 'ours' | 'theirs', sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      gitStagedDiff: (workspaceId: string, sessionId?: string) => Promise<string>;
      gitCommitMessage: (workspaceId: string, sha: string, sessionId?: string) => Promise<string>;
      gitDiscardFile: (workspaceId: string, filePath: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;

      // ── RAG (Memory & RAG panel) ──
      ragStatus: (workspaceId: string) => Promise<import('./index').RagStatus | { error: string }>;
      downloadRagModel: () => Promise<import('./index').RagWorkspaceOpResult>;
      ragModelExists: () => Promise<boolean>;
      enableRagWorkspace: (workspaceId: string) => Promise<import('./index').RagWorkspaceOpResult>;
      disableRagWorkspace: (workspaceId: string) => Promise<import('./index').RagWorkspaceOpResult>;
      initRagWorkspace: (workspaceId: string) => Promise<import('./index').RagInitResult>;
      onRagInitProgress: (cb: (e: import('./index').RagInitProgressEvent) => void) => () => void;
      onRagDownloadProgress: (cb: (e: import('./index').RagDownloadProgressEvent) => void) => () => void;

      // ─────────────────────────────────────────────────────────
      // Agent (tool-calling loop). Replaces the old chat:stream trio.
      // ─────────────────────────────────────────────────────────
      runTurn(
        payload: import('../lib/agent/events').RunTurnPayload,
      ): Promise<void>;
      abortTurn(sessionId: string): Promise<void>;
      approveToolCalls(sessionId: string, toolCallIds: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean): Promise<void>;
      rejectToolCalls(
        sessionId: string,
        toolCallIds: string[],
        reason?: string,
      ): Promise<void>;
      /** Resolves the live paused ask. True = resolved; false = no pending ask
       *  (the turn already ended) — callers should deliver the answer as a
       *  regular user message instead of dropping it. */
      submitFollowup(sessionId: string, toolCallId: string, answer: string): Promise<boolean>;
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

      // ── Auto-updater (electron-updater → GitHub releases) ──
      updater: {
        checkForUpdates(): Promise<{ ok: boolean; error?: string }>;
        installUpdate(): Promise<{ ok: boolean }>;
        getStatus(): Promise<import('../../electron/updater').UpdateStatus>;
      };
      onUpdaterStatus(callback: (status: import('../../electron/updater').UpdateStatus) => void): void;
      removeUpdaterListeners(): void;
    };
  }
}

export {};
