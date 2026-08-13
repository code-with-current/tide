/** OAuth authProvider for MCP remote servers. Credentials stored in config.json:
 *  user-scoped servers use the top-level mcpOAuth; project-scoped servers use
 *  the workspace object's mcpOAuth (per-workspace isolation).
 *  Uses tide://oauth/callback (prod) or tide-dev://oauth/callback (dev) as the
 *  redirect URI. */
import { app, safeStorage } from 'electron';
import * as store from '../../store.js';
import { createLogger } from '../../logger';

const log = createLogger('mcp/oauth');

const PROTOCOL = app.isPackaged ? 'tide' : 'tide-dev';
const REDIRECT_URL = `${PROTOCOL}://oauth/callback`;

const pendingAuthUrls = new Map<string, URL>();

export function setPendingAuthUrl(serverName: string, url: URL): void {
  pendingAuthUrls.set(serverName, url);
}

export function consumePendingAuthUrl(serverName: string): URL | undefined {
  const url = pendingAuthUrls.get(serverName);
  if (url) pendingAuthUrls.delete(serverName);
  return url;
}

export function hasPendingAuthUrl(serverName: string): boolean {
  return pendingAuthUrls.has(serverName);
}

// ─── Scope-aware config access ────────────────────────────────────────

interface OAuthScope {
  scope?: 'user' | 'project' | 'builtin';
  workspaceId?: string;
}

type OAuthSection = { tokens?: Record<string, string>; clients?: Record<string, string>; verifiers?: Record<string, string> };

function readOAuthSection(ctx: OAuthScope): OAuthSection {
  if (ctx.scope === 'project' && ctx.workspaceId) {
    return store.getWorkspaceMcpOAuth(ctx.workspaceId) ?? {};
  }
  return store.getMcpOAuth() ?? {};
}

function writeOAuthSection(ctx: OAuthScope, data: OAuthSection): void {
  if (ctx.scope === 'project' && ctx.workspaceId) {
    store.setWorkspaceMcpOAuth(ctx.workspaceId, data);
  } else {
    store.setMcpOAuth(data);
  }
}

/** Read one named sub-section (tokens/clients/verifiers) from OAuth storage. */
function readSection(ctx: OAuthScope, section: keyof OAuthSection): Record<string, string> {
  return readOAuthSection(ctx)[section] ?? {};
}

/** Write one named sub-section into OAuth storage (read-modify-write the parent). */
function writeSection(ctx: OAuthScope, section: keyof OAuthSection, data: Record<string, string>): void {
  const full = readOAuthSection(ctx);
  full[section] = data;
  writeOAuthSection(ctx, full);
}

// ─── Token storage ────────────────────────────────────────────────────

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
}

type TokenMap = Record<string, string>;

function decrypt(encoded: string): string | undefined {
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      : Buffer.from(encoded, 'base64').toString();
  } catch { return undefined; }
}

function encrypt(json: string): string {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json).toString('base64')
    : Buffer.from(json).toString('base64');
}

/** Decrypt + parse stored tokens. undefined if absent or unreadable. */
export function getOAuthTokens(serverName: string, ctx: OAuthScope = {}): StoredTokens | undefined {
  const file = readSection(ctx, 'tokens');
  const encoded = file[serverName];
  if (!encoded) return undefined;
  const json = decrypt(encoded);
  if (!json) return undefined;
  try { return JSON.parse(json); } catch { return undefined; }
}

/** Encrypt + persist tokens for a server. */
export function storeOAuthTokens(serverName: string, tokens: StoredTokens, ctx: OAuthScope = {}): void {
  log.info('tokens stored', { server: serverName, scope: ctx.scope ?? 'user' });
  const file = readSection(ctx, 'tokens');
  file[serverName] = encrypt(JSON.stringify(tokens));
  writeSection(ctx, 'tokens', file);
}

/** Remove a server's stored tokens. */
export function clearOAuthTokens(serverName: string, ctx: OAuthScope = {}): void {
  log.info('tokens cleared', { server: serverName, scope: ctx.scope ?? 'user' });
  const file = readSection(ctx, 'tokens');
  delete file[serverName];
  writeSection(ctx, 'tokens', file);
}

// ─── OAuth callback bridge ────────────────────────────────────────────

type OAuthCompleter = (code: string, state?: string) => void;
let completer: OAuthCompleter | undefined;

export function registerOAuthCompleter(fn: OAuthCompleter): void {
  completer = fn;
}

export function handleOAuthCallback(url: string): void {
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state') ?? undefined;
    const error = parsed.searchParams.get('error');
    if (error) { log.warn('oauth callback error', { error }); return; }
    if (code) { log.info('oauth callback received'); completer?.(code, state); }
  } catch (e) { log.warn('callback handler failed', { error: String(e) }); }
}

// ─── PKCE verifier + DCR client storage ───────────────────────────────

interface StoredClientInfo {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  token_endpoint_auth_method?: string;
}

function getClientInfo(serverName: string, ctx: OAuthScope): StoredClientInfo | undefined {
  const file = readSection(ctx, 'clients');
  const encoded = file[serverName];
  if (!encoded) return undefined;
  const json = decrypt(encoded);
  if (!json) return undefined;
  try { return JSON.parse(json); } catch { return undefined; }
}

function storeClientInfo(serverName: string, info: StoredClientInfo, ctx: OAuthScope): void {
  const file = readSection(ctx, 'clients');
  file[serverName] = encrypt(JSON.stringify(info));
  writeSection(ctx, 'clients', file);
}

function clearClientInfo(serverName: string, ctx: OAuthScope): void {
  const file = readSection(ctx, 'clients');
  if (file[serverName]) { delete file[serverName]; writeSection(ctx, 'clients', file); }
}

// ─── Auth provider factory ────────────────────────────────────────────

/** Build the SDK OAuthClientProvider. For project-scoped servers, pass
 *  workspaceId so credentials are stored in the workspace object in config.json. */
export function createAuthProvider(serverName: string, ctx: OAuthScope = {}) {
  return {
    get redirectUrl(): string { return REDIRECT_URL; },
    clientMetadata: {
      client_name: 'Tide',
      client_uri: 'https://tide.codes',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },

    async clientInformation() {
      const info = getClientInfo(serverName, ctx);
      if (!info) return undefined;
      if (info.client_secret_expires_at !== undefined && info.client_secret_expires_at !== 0 && info.client_secret_expires_at < Date.now() / 1000) {
        clearClientInfo(serverName, ctx);
        return undefined;
      }
      return info;
    },

    async saveClientInformation(info: { client_id: string; client_secret?: string; client_id_issued_at?: number; client_secret_expires_at?: number; token_endpoint_auth_method?: string }) {
      storeClientInfo(serverName, {
        client_id: info.client_id, client_secret: info.client_secret,
        client_id_issued_at: info.client_id_issued_at, client_secret_expires_at: info.client_secret_expires_at,
        token_endpoint_auth_method: info.token_endpoint_auth_method,
      }, ctx);
    },

    async tokens() {
      const stored = getOAuthTokens(serverName, ctx);
      if (!stored) return undefined;
      let expires_in: number | undefined;
      if (stored.expires_at) {
        const remaining = Math.floor((stored.expires_at - Date.now()) / 1000);
        expires_in = remaining > 0 ? remaining : undefined;
      }
      return {
        access_token: stored.access_token, refresh_token: stored.refresh_token,
        expires_in, token_type: stored.token_type ?? 'Bearer', scope: stored.scope,
      };
    },

    async saveTokens(tokens: { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string }) {
      storeOAuthTokens(serverName, {
        access_token: tokens.access_token, refresh_token: tokens.refresh_token,
        token_type: tokens.token_type, scope: tokens.scope,
        expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      }, ctx);
    },

    async redirectToAuthorization(authorizationUrl: URL) {
      log.info('oauth authorization needed', { server: serverName, scope: ctx.scope ?? 'user' });
      setPendingAuthUrl(serverName, authorizationUrl);
    },

    async saveCodeVerifier(codeVerifier: string) {
      const file = readSection(ctx, 'verifiers');
      file[serverName] = codeVerifier;
      writeSection(ctx, 'verifiers', file);
    },

    async codeVerifier() {
      const file = readSection(ctx, 'verifiers');
      const v = file[serverName];
      if (!v) throw new Error(`No stored PKCE code verifier for "${serverName}"`);
      return v;
    },

    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
      if (scope === 'all' || scope === 'tokens') clearOAuthTokens(serverName, ctx);
      if (scope === 'all' || scope === 'verifier') {
        const file = readSection(ctx, 'verifiers');
        delete file[serverName];
        writeSection(ctx, 'verifiers', file);
      }
      if (scope === 'all' || scope === 'client') clearClientInfo(serverName, ctx);
    },
  } satisfies Record<string, unknown>;
}
