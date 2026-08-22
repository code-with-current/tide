/** Pure config storage (no Electron imports, fully testable). Encryption is injected via CryptoOps (the store.ts wrapper wires Electron's safeStorage at load); public surface mirrors store.ts exactly. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger.js';
import type { Provider, Workspace, RagConfig, EmbedderId } from '../src/types';

const log = createLogger('config');

export interface StoredProvider {
  id: string;
  name: string;
  apiStyle: 'openai' | 'anthropic';
  baseUrl: string;
  /** Encrypted API key (base64 of encrypted bytes when safeStorage is available). */
  encryptedKey: string | null;
  enabled: boolean;
  models: { id: string; alias: string; modelId: string; contextWindow: number; providerId: string; role?: string; catalogId?: string; reasoning?: boolean; reasoningMandatory?: boolean; supportedEfforts?: string[]; priceLabel?: string; inputCostPerToken?: number; outputCostPerToken?: number; cacheReadCostPerToken?: number; cacheWriteCostPerToken?: number; max_completion_tokens?: number; maxInputTokens?: number }[];
}

export interface Config {
  providers: StoredProvider[];
  workspaces: Workspace[];
  lastSessionId?: string | null;
  lastWorkspaceId?: string | null;
  secrets?: Record<string, string>;
  agentSettings?: AgentSettings;
  generalSettings?: GeneralSettings;
  ragEnabledWorkspaces?: string[];
  /** Global/user-scoped MCP server configs (migrated from mcp.json). */
  mcpServers?: Record<string, unknown>;
  /** Global MCP OAuth credentials (migrated from mcp.json). */
  mcpOAuth?: { tokens?: Record<string, string>; clients?: Record<string, string>; verifiers?: Record<string, string> };
  /** Disabled extensions (migrated from extensions.json). */
  extensions?: { disabled: { agents: string[]; skills: string[]; mcp: string[] } };
}

export interface AgentSettings {
  /** Default autonomy mode for new sessions. */
  defaultAutonomy: 'plan' | 'ask' | 'edit' | 'full';
  /** Max model calls per turn before forced stop. */
  maxSteps: number;
  /** Auto-reject permission prompts after this many minutes. */
  permissionTimeoutMin: number;
  /** Plan mode returns not-executed results for mutating tools (vs blocking). */
  planModeDryRun: boolean;
  /** Append-only audit log of every shell command in full mode. */
  auditShellCommands: boolean;
  /** Compaction: summarize old turns when context approaches the window limit. */
  compactionEnabled: boolean;
  /** Fraction of context window that triggers compaction. Range [0.5, 0.95]. */
  compactionThreshold: number;
  /** Number of user/assistant pairs preserved verbatim at the tail. */
  compactionKeepTurns: number;
  /** Experimental: allow dispatch_agent to run sub-agents in the background,
   *  detached from the turn (results arrive as synthetic queued messages). */
  experimentalBackgroundDispatch: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  defaultAutonomy: 'ask',
  maxSteps: 100,
  permissionTimeoutMin: 10,
  planModeDryRun: true,
  auditShellCommands: true,
  compactionEnabled: true,
  compactionThreshold: 0.75,
  compactionKeepTurns: 3,
  experimentalBackgroundDispatch: false,
};

export const DEFAULT_CONFIG: Config = {
  providers: [],
  workspaces: [],
  lastSessionId: null,
  lastWorkspaceId: null,
  secrets: {},
  ragEnabledWorkspaces: [],
};

export interface GeneralSettings {
  /** Launch Tide automatically when the user logs in (OS login items). */
  startAtLogin: boolean;
  /** Show OS notifications for turn completion, errors, etc. */
  notifications: boolean;
  /** Play in-app sounds for turn completion and permission prompts. */
  notificationSound: boolean;
  /** Append Co-authored-by trailer to git commits made by the agent. */
  gitCoAuthored: boolean;
  /** Co-author display name (default: "Tide"). */
  gitCoAuthorName: string;
  /** Co-author email — GitHub no-reply format for attribution. */
  gitCoAuthorEmail: string;
  /** Model override for background utility tasks (session-title generation,
   *  commit-message generation). Absent = the session's current model. */
  utilityModel?: { providerId: string; modelId: string } | null;
  /** Automatically check for app updates on startup (default: true). */
  autoUpdateCheck: boolean;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  startAtLogin: false,
  notifications: true,
  notificationSound: true,
  gitCoAuthored: true,
  gitCoAuthorName: 'Tide',
  gitCoAuthorEmail: '314188112+tide-codes@users.noreply.github.com',
  autoUpdateCheck: true,
};

// ── RAG config hydration: fill missing fields at read time and clamp chunkTokens to the recorded embedder's max (so a workspace flipped from local to cloud doesn't keep an un-embeddable chunk size).

export const DEFAULT_RAG_CONFIG: RagConfig = {
  embedderId: 'local-code-512',
  dim: 384,
  cloudAllowed: false,
  chunkTokens: 384,
};

/** Max input tokens per embedder variant. Mirrors the Embedder.maxTokens
 *  values in electron/rag/*. Kept here so hydration doesn't import the
 *  embedder modules (which would pull electron into the pure store layer). */
const MAX_TOKENS: Record<EmbedderId, number> = {
  'local-code-512': 512,
  'cloud-base': 256,
};

/** Fill missing fields + clamp chunkTokens to the recorded embedder's max.
 *  Applied at every workspace read so old persisted state hydrates cleanly. */
export function hydrateRagConfig(input: Partial<RagConfig> | undefined): RagConfig {
  const embedderId: EmbedderId = input?.embedderId ?? DEFAULT_RAG_CONFIG.embedderId;
  const max = MAX_TOKENS[embedderId];
  const chunkTokens = Math.min(
    input?.chunkTokens ?? DEFAULT_RAG_CONFIG.chunkTokens,
    max,
  );
  return {
    embedderId,
    // dim is fixed for the whole family; ignore any persisted value.
    dim: 384,
    cloudAllowed: input?.cloudAllowed ?? DEFAULT_RAG_CONFIG.cloudAllowed,
    chunkTokens,
  };
}

export interface CryptoOps {
  encrypt: (s: string) => string;
  decrypt: (s: string) => string;
}

export interface WorkspaceCascadeOps {
  /** Archive every session whose workspaceId === wid. */
  archiveSessionsByWorkspace?: (wid: string) => void;
  /** Unarchive every archived session whose workspaceId === wid. */
  unarchiveSessionsByWorkspace?: (wid: string) => void;
  /** Permanently delete every session (active OR archived) whose workspaceId === wid. */
  deleteSessionsByWorkspace?: (wid: string) => void;
}

export function createConfigStore(rootDir: string, crypto: CryptoOps) {
  const configPath = path.join(rootDir, 'config.json');
  let cache: Config | null = null;

  function read(): Config {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Config;
    } catch {
      cache = structuredClone(DEFAULT_CONFIG);
    }
    // One-time migration: fold mcp.json + extensions.json into config.json.
    migrateLegacyFiles();
    return cache;
  }

  /** Merge legacy standalone config files into config.json. Runs once; renames
   *  the old files so it doesn't re-run. Also moves any workspace .mcp.json
   *  oauth sections into the workspace object's mcpOAuth. */
  function migrateLegacyFiles(): void {
    if (!cache) return;
    let changed = false;
    // 1. Migrate mcp.json → config.mcpServers + config.mcpOAuth
    const mcpPath = path.join(rootDir, 'mcp.json');
    try {
      if (fs.existsSync(mcpPath) && !cache.mcpServers) {
        const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
        cache.mcpServers = mcp.mcpServers ?? mcp; // handle wrapped or flat
        if (mcp.oauth) cache.mcpOAuth = mcp.oauth;
        changed = true;
        fs.renameSync(mcpPath, mcpPath + '.migrated');
        log.info('migrated mcp.json → config.json');
      }
    } catch (e) { log.warn('mcp.json migration failed', { err: String(e) }); }
    // 2. Migrate extensions.json → config.extensions
    const extPath = path.join(rootDir, 'extensions.json');
    try {
      if (fs.existsSync(extPath) && !cache.extensions) {
        const ext = JSON.parse(fs.readFileSync(extPath, 'utf-8'));
        cache.extensions = {
          disabled: {
            agents: ext.disabled?.agents ?? [],
            skills: ext.disabled?.skills ?? [],
            mcp: ext.disabled?.mcp ?? ['tide-filesystem'],
          },
        };
        changed = true;
        fs.renameSync(extPath, extPath + '.migrated');
        log.info('migrated extensions.json → config.json');
      }
    } catch (e) { log.warn('extensions.json migration failed', { err: String(e) }); }
    // 3. Move workspace .mcp.json oauth sections → workspace.mcpOAuth
    for (const ws of cache.workspaces ?? []) {
      if (ws.mcpOAuth) continue; // already migrated
      try {
        const wsMcpPath = path.join(ws.path, '.mcp.json');
        if (fs.existsSync(wsMcpPath)) {
          const wsMcp = JSON.parse(fs.readFileSync(wsMcpPath, 'utf-8'));
          if (wsMcp.oauth) {
            ws.mcpOAuth = wsMcp.oauth;
            delete wsMcp.oauth;
            fs.writeFileSync(wsMcpPath, JSON.stringify(wsMcp, null, 2), 'utf-8');
            changed = true;
            log.info('migrated workspace oauth → config.json', { workspace: ws.id });
          }
        }
      } catch { /* workspace .mcp.json not readable — skip */ }
    }
    if (changed) write(cache);
  }

  function write(cfg: Config): void {
    cache = cfg;
    const serialized = JSON.stringify(cfg, null, 2);
    try {
      fs.writeFileSync(configPath, serialized, 'utf-8');
    } catch (firstErr) {
      // The config dir may have been deleted/moved under us (e.g. the user
      // wiped ~/.tide while the app ran). Recreate it once and retry so the
      // write self-heals instead of silently dropping the user's change.
      try {
        fs.mkdirSync(rootDir, { recursive: true });
        fs.writeFileSync(configPath, serialized, 'utf-8');
        log.warn('config write failed then recovered after recreating dir', { rootDir });
      } catch (e) {
        // Genuinely unwritable (permissions, disk full). Log prominently —
        // the in-memory cache still serves the session, so the app keeps
        // working, but the change will be lost on restart.
        log.error('failed to write config and could not recover', {
          rootDir,
          firstErr,
          err: e,
        });
      }
    }
  }

  // ── Provider ops ──────────────────────────────────────────────

  function listProviders(): Provider[] {
    return read().providers.map((p) => ({
      id: p.id,
      name: p.name,
      apiStyle: p.apiStyle,
      baseUrl: p.baseUrl,
      apiKey: crypto.decrypt(p.encryptedKey ?? ''),
      enabled: p.enabled,
      models: p.models,
    }));
  }

  function addProvider(input: {
    name: string;
    apiStyle: 'openai' | 'anthropic';
    baseUrl: string;
    apiKey?: string;
    models?: { alias: string; modelId: string; contextWindow: number; catalogId?: string; reasoning?: boolean; reasoningMandatory?: boolean; supportedEfforts?: string[]; priceLabel?: string; inputCostPerToken?: number; outputCostPerToken?: number; cacheReadCostPerToken?: number; cacheWriteCostPerToken?: number; max_completion_tokens?: number; maxInputTokens?: number }[];
  }): Provider {
    const cfg = read();
    const id = `p_${Math.random().toString(36).slice(2, 10)}`;
    const models = (input.models ?? []).map((m) => ({
      id: `m_${Math.random().toString(36).slice(2, 8)}`,
      alias: m.alias,
      modelId: m.modelId,
      contextWindow: m.contextWindow,
      providerId: id,
      catalogId: m.catalogId,
      reasoning: m.reasoning,
      reasoningMandatory: m.reasoningMandatory,
      supportedEfforts: m.supportedEfforts,
      priceLabel: m.priceLabel,
      inputCostPerToken: m.inputCostPerToken,
      outputCostPerToken: m.outputCostPerToken,
      cacheReadCostPerToken: m.cacheReadCostPerToken,
      cacheWriteCostPerToken: m.cacheWriteCostPerToken,
    }));
    const stored: StoredProvider = {
      id,
      name: input.name,
      apiStyle: input.apiStyle,
      baseUrl: input.baseUrl,
      encryptedKey: crypto.encrypt(input.apiKey ?? ''),
      enabled: true,
      models,
    };
    cfg.providers.push(stored);
    write(cfg);
    return {
      id,
      name: input.name,
      apiStyle: input.apiStyle,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      enabled: true,
      models,
    };
  }

  function updateProvider(
    id: string,
    patch: Partial<Pick<Provider, 'name' | 'apiStyle' | 'baseUrl' | 'enabled' | 'models' | 'apiKey'>>,
  ): Provider | null {
    const cfg = read();
    const idx = cfg.providers.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const stored = cfg.providers[idx];

    if (patch.name !== undefined) stored.name = patch.name;
    // apiStyle must be mutable so an existing provider can switch protocols
    // (e.g. z.ai Anthropic → OpenAI endpoint) via Edit, instead of delete +
    // re-add. Without this, the UI's apiStyle patch was silently dropped.
    if (patch.apiStyle !== undefined) stored.apiStyle = patch.apiStyle;
    if (patch.baseUrl !== undefined) stored.baseUrl = patch.baseUrl;
    if (patch.enabled !== undefined) stored.enabled = patch.enabled;
    if (patch.models !== undefined) {
      stored.models = patch.models.map((m) => ({ ...m, providerId: id }));
    }
    if (patch.apiKey !== undefined) {
      stored.encryptedKey = crypto.encrypt(patch.apiKey);
    }

    cfg.providers[idx] = stored;
    write(cfg);

    return {
      id: stored.id,
      name: stored.name,
      apiStyle: stored.apiStyle,
      baseUrl: stored.baseUrl,
      apiKey: crypto.decrypt(stored.encryptedKey ?? ''),
      enabled: stored.enabled,
      models: stored.models,
    };
  }

  function deleteProvider(id: string): boolean {
    const cfg = read();
    const before = cfg.providers.length;
    cfg.providers = cfg.providers.filter((p) => p.id !== id);
    write(cfg);
    return cfg.providers.length < before;
  }

  // ── Workspace ops ─────────────────────────────────────────────

  function listWorkspaces(): Workspace[] {
    // Hydrate ragConfig on read so callers (handlers.ts, store.ts wrapper,
    // rag status IPC) always see a fully-shaped RagConfig, including
    // workspaces persisted before this feature existed. Returns shallow
    // copies so a caller mutating the result can't dirty the cache.
    return read().workspaces.map((ws) => ({
      ...ws,
      ragConfig: hydrateRagConfig(ws.ragConfig),
    }));
  }

  function addWorkspace(ws: Workspace): void {
    const cfg = read();
    cfg.workspaces.push(ws);
    write(cfg);
  }

  function updateWorkspace(id: string, patch: Partial<Workspace>): void {
    const cfg = read();
    const ws = cfg.workspaces.find((w) => w.id === id);
    if (!ws) return;
    Object.assign(ws, patch);
    write(cfg);
  }

  // ── Workspace lifecycle (Phase 3 implements these in 3.4/3.6) ─

  function archiveWorkspace(id: string, cascade?: WorkspaceCascadeOps): void {
    const cfg = read();
    const ws = cfg.workspaces.find((w) => w.id === id);
    if (!ws) return;
    ws.archivedAt = new Date().toISOString();
    write(cfg);
    cascade?.archiveSessionsByWorkspace?.(id);
  }
  function unarchiveWorkspace(id: string, cascade?: WorkspaceCascadeOps): void {
    const cfg = read();
    const ws = cfg.workspaces.find((w) => w.id === id);
    if (!ws) return;
    delete ws.archivedAt;
    write(cfg);
    cascade?.unarchiveSessionsByWorkspace?.(id);
  }
  function deleteWorkspace(id: string, cascade?: WorkspaceCascadeOps): void {
    const cfg = read();
    const ws = cfg.workspaces.find((w) => w.id === id);
    if (!ws) return;
    if (!ws.archivedAt) {
      throw new Error('Workspace must be archived before deletion');
    }
    cascade?.deleteSessionsByWorkspace?.(id);

    // Clean dangling pointers.
    if (cfg.lastWorkspaceId === id) cfg.lastWorkspaceId = null;

    cfg.workspaces = cfg.workspaces.filter((w) => w.id !== id);
    write(cfg);
  }

  // ── Last-session persistence ─────────────────────────────────
  // Survives app restarts independent of renderer localStorage (which
  // is scoped to the dev server port and may change between runs).

  function getLastSession(): { sessionId: string | null; workspaceId: string | null } {
    const cfg = read();
    return {
      sessionId: cfg.lastSessionId ?? null,
      workspaceId: cfg.lastWorkspaceId ?? null,
    };
  }

  function setLastSession(sessionId: string | null, workspaceId: string | null): void {
    const cfg = read();
    cfg.lastSessionId = sessionId;
    cfg.lastWorkspaceId = workspaceId;
    write(cfg);
  }

  // ── Third-party tool secrets ─────────────────────────────────
  // Encrypted at rest (same path as provider keys). Tools like web_search
  // read these at runtime to authenticate against external APIs. Never
  // logged, never sent to the renderer.

  function getSecret(service: string): string | undefined {
    const cfg = read();
    const stored = cfg.secrets?.[service];
    if (!stored) return undefined;
    return crypto.decrypt(stored);
  }

  function setSecret(service: string, value: string): void {
    const cfg = read();
    if (!cfg.secrets) cfg.secrets = {};
    cfg.secrets[service] = crypto.encrypt(value);
    write(cfg);
  }

  function getAgentSettings(): AgentSettings {
    const cfg = read();
    return { ...DEFAULT_AGENT_SETTINGS, ...cfg.agentSettings };
  }

  function updateAgentSettings(patch: Partial<AgentSettings>): void {
    const cfg = read();
    const current = { ...DEFAULT_AGENT_SETTINGS, ...cfg.agentSettings };
    cfg.agentSettings = { ...current, ...patch };
    write(cfg);
  }

  function getGeneralSettings(): GeneralSettings {
    const cfg = read();
    return { ...DEFAULT_GENERAL_SETTINGS, ...cfg.generalSettings };
  }

  function updateGeneralSettings(patch: Partial<GeneralSettings>): void {
    const cfg = read();
    const current = { ...DEFAULT_GENERAL_SETTINGS, ...cfg.generalSettings };
    cfg.generalSettings = { ...current, ...patch };
    write(cfg);
  }

  // ── MCP config (merged from mcp.json) ──────────────────────────

  function getMcpServers(): Record<string, unknown> {
    return read().mcpServers ?? {};
  }
  function setMcpServers(servers: Record<string, unknown>): void {
    const cfg = read();
    cfg.mcpServers = servers;
    write(cfg);
  }
  function getMcpOAuth(): Config['mcpOAuth'] {
    return read().mcpOAuth;
  }
  function setMcpOAuth(oauth: Config['mcpOAuth']): void {
    const cfg = read();
    cfg.mcpOAuth = oauth;
    write(cfg);
  }
  function getWorkspaceMcpOAuth(workspaceId: string): Config['mcpOAuth'] {
    const ws = read().workspaces.find((w) => w.id === workspaceId);
    return ws?.mcpOAuth;
  }
  function setWorkspaceMcpOAuth(workspaceId: string, oauth: Config['mcpOAuth']): void {
    const cfg = read();
    const ws = cfg.workspaces.find((w) => w.id === workspaceId);
    if (ws) { ws.mcpOAuth = oauth; write(cfg); }
  }

  // ── Extensions config (merged from extensions.json) ────────────

  function getExtensions(): NonNullable<Config['extensions']> {
    const cfg = read();
    return cfg.extensions ?? {
      disabled: { agents: [], skills: [], mcp: ['tide-filesystem'] },
    };
  }
  function setExtensions(ext: NonNullable<Config['extensions']>): void {
    const cfg = read();
    cfg.extensions = ext;
    write(cfg);
  }

  return {
    listProviders,
    addProvider,
    updateProvider,
    deleteProvider,
    listWorkspaces,
    addWorkspace,
    updateWorkspace,
    archiveWorkspace,
    unarchiveWorkspace,
    deleteWorkspace,
    getLastSession,
    setLastSession,
    getSecret,
    setSecret,
    getAgentSettings,
    updateAgentSettings,
    getGeneralSettings,
    updateGeneralSettings,
    listRagEnabledWorkspaces,
    addRagEnabledWorkspace,
    removeRagEnabledWorkspace,
    getMcpServers,
    setMcpServers,
    getMcpOAuth,
    setMcpOAuth,
    getWorkspaceMcpOAuth,
    setWorkspaceMcpOAuth,
    getExtensions,
    setExtensions,
  };

  function listRagEnabledWorkspaces(): string[] {
    return read().ragEnabledWorkspaces ?? [];
  }
  function addRagEnabledWorkspace(workspaceId: string): void {
    const cfg = read();
    const current = cfg.ragEnabledWorkspaces ?? [];
    if (current.includes(workspaceId)) return;
    cfg.ragEnabledWorkspaces = [...current, workspaceId];
    write(cfg);
  }
  function removeRagEnabledWorkspace(workspaceId: string): void {
    const cfg = read();
    const current = cfg.ragEnabledWorkspaces ?? [];
    cfg.ragEnabledWorkspaces = current.filter((id) => id !== workspaceId);
    write(cfg);
  }
}
