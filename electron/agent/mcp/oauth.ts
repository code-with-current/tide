/** OAuth authProvider for MCP remote servers: implements the PKCE flow (401 → metadata → browser auth → `tide://oauth/callback` → token exchange), persisting per-server tokens via Electron `safeStorage` (ciphertext blobs in mcp.json). */
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../logger';
import { readFullUserMcpConfig, writeFullUserMcpConfig } from './config';

const log = createLogger('mcp/oauth');

const OAUTH_TOKENS_FILE = 'mcp-oauth-tokens.json';
const REDIRECT_URL = 'tide://oauth/callback';

/** Pending OAuth authorization URLs keyed by server name; auth is deferred so the browser only opens when the user clicks "Authenticate" (one URL per server). */
const pendingAuthUrls = new Map<string, URL>();

/** Stash the authorization URL produced during a deferred auth flow. */
export function setPendingAuthUrl(serverName: string, url: URL): void {
  pendingAuthUrls.set(serverName, url);
}

/** Read + clear the stashed authorization URL for a server (for the
 *  "Authenticate" button). Returns undefined if no flow is pending. */
export function consumePendingAuthUrl(serverName: string): URL | undefined {
  const url = pendingAuthUrls.get(serverName);
  if (url) pendingAuthUrls.delete(serverName);
  return url;
}

/** Check whether a flow is pending WITHOUT consuming it (for status checks). */
export function hasPendingAuthUrl(serverName: string): boolean {
  return pendingAuthUrls.has(serverName);
}

/** Tokens are now stored in the unified mcp.json under oauth.tokens.
 *  These helpers read/write that section without touching mcpServers. */

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Absolute epoch millis when the access token expires. Converted to/from
   *  the relative `expires_in` (SECONDS) the OAuth spec / SDK uses. */
  expires_at?: number;
  token_type?: string;
  scope?: string;
}

/** On-disk map: server name → encrypted token blob (base64 ciphertext). */
type OAuthTokensFile = Record<string, string>;

function readTokensFile(): OAuthTokensFile {
  const full = readFullUserMcpConfig();
  const oauth = full.oauth as Record<string, unknown> | undefined;
  return (oauth?.tokens as OAuthTokensFile) ?? {};
}

function writeTokensFile(data: OAuthTokensFile): void {
  const full = readFullUserMcpConfig();
  if (!full.oauth || typeof full.oauth !== 'object') full.oauth = {};
  (full.oauth as Record<string, unknown>).tokens = data;
  writeFullUserMcpConfig(full);
}

/** Decrypt + parse the stored token blob for a server. undefined if absent
 *  or unreadable (treat as "not logged in"; the SDK will re-trigger auth). */
export function getOAuthTokens(serverName: string): StoredTokens | undefined {
  const file = readTokensFile();
  const encoded = file[serverName];
  if (!encoded) return undefined;
  try {
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      : Buffer.from(encoded, 'base64').toString();
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** Encrypt + persist tokens for a server, overwriting any prior entry. */
export function storeOAuthTokens(serverName: string, tokens: StoredTokens): void {
  log.info('tokens stored', { server: serverName, hasRefresh: Boolean(tokens.refreshToken) });
  const file = readTokensFile();
  const json = JSON.stringify(tokens);
  file[serverName] = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json).toString('base64')
    : Buffer.from(json).toString('base64');
  writeTokensFile(file);
}

/** Remove a server's stored tokens (logout). No-op if absent. */
export function clearOAuthTokens(serverName: string): void {
  log.info('tokens cleared', { server: serverName });
  const file = readTokensFile();
  delete file[serverName];
  writeTokensFile(file);
}

/** Called by the `tide://` handler: parses code/state/error from the callback URL and forwards to the pool's completer (thin parser to avoid circular import). */
type OAuthCompleter = (code: string, state?: string) => void;
let completer: OAuthCompleter | undefined;

/** Register the pool's completion callback (called once at pool init). */
export function registerOAuthCompleter(fn: OAuthCompleter): void {
  completer = fn;
}

export function handleOAuthCallback(url: string): void {
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state') ?? undefined;
    const error = parsed.searchParams.get('error');
    if (error) {
      log.warn('oauth callback error', { error, hasState: Boolean(state) });
      return;
    }
    if (code) {
      log.info('oauth callback received', { hasState: Boolean(state) });
      completer?.(code, state);
    }
  } catch (e) {
    log.warn('callback handler failed', { error: String(e) });
  }
}

/** PKCE code-verifier storage per server-name: persists the verifier across the two async boundaries of the SDK's PKCE flow (save before redirect, retrieve after callback). */
/** Verifiers stored in mcp.json under oauth.verifiers. */
function readVerifiersFile(): Record<string, string> {
  const full = readFullUserMcpConfig();
  const oauth = full.oauth as Record<string, unknown> | undefined;
  return (oauth?.verifiers as Record<string, string>) ?? {};
}
function writeVerifiersFile(data: Record<string, string>): void {
  const full = readFullUserMcpConfig();
  if (!full.oauth || typeof full.oauth !== 'object') full.oauth = {};
  (full.oauth as Record<string, unknown>).verifiers = data;
  writeFullUserMcpConfig(full);
}

/** DCR client-information storage per server-name (encrypted): persists RFC 7591 Dynamic Client Registration credentials so reconnects reuse the registered client instead of leaking stale ones. */
interface StoredClientInfo {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  token_endpoint_auth_method?: string;
}
/** Client info stored in mcp.json under oauth.clients. */
function readClientInfoFile(): Record<string, string> {
  const full = readFullUserMcpConfig();
  const oauth = full.oauth as Record<string, unknown> | undefined;
  return (oauth?.clients as Record<string, string>) ?? {};
}
function writeClientInfoFile(data: Record<string, string>): void {
  const full = readFullUserMcpConfig();
  if (!full.oauth || typeof full.oauth !== 'object') full.oauth = {};
  (full.oauth as Record<string, unknown>).clients = data;
  writeFullUserMcpConfig(full);
}
function getClientInfo(serverName: string): StoredClientInfo | undefined {
  const file = readClientInfoFile();
  const encoded = file[serverName];
  if (!encoded) return undefined;
  try {
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      : Buffer.from(encoded, 'base64').toString();
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
function storeClientInfo(serverName: string, info: StoredClientInfo): void {
  log.info('client info stored', { server: serverName, hasSecret: Boolean(info.client_secret) });
  const file = readClientInfoFile();
  const json = JSON.stringify(info);
  file[serverName] = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json).toString('base64')
    : Buffer.from(json).toString('base64');
  writeClientInfoFile(file);
}
function clearClientInfo(serverName: string): void {
  const file = readClientInfoFile();
  if (file[serverName]) {
    delete file[serverName];
    writeClientInfoFile(file);
  }
}

/** Build the SDK v1.30 `OAuthClientProvider` for authorized remote servers; converts the SDK's snake_case/relative-seconds `expires_in` to absolute millis on write and back on read. */
export function createAuthProvider(serverName: string) {
  return {
    get redirectUrl(): string {
      return REDIRECT_URL;
    },
    // OAuthClientMetadata requires redirect_uris (an array). grant/response
    // types advertise the authorization_code + PKCE flow we implement.
    clientMetadata: {
      client_name: 'Tide',
      client_uri: 'https://tide.codes',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },

    async clientInformation() {
      // Returns stored DCR client credentials so a returning session reuses
      // the already-registered client instead of re-registering. undefined
      // → the SDK will attempt registration (URL-based ID or DCR) if needed.
      const info = getClientInfo(serverName);
      if (!info) return undefined;
      // Honor client_secret_expires_at: 0 means never expires (RFC 7591);
      // a positive value that's now past means the creds are dead → drop them.
      if (
        info.client_secret_expires_at !== undefined &&
        info.client_secret_expires_at !== 0 &&
        info.client_secret_expires_at < Date.now() / 1000
      ) {
        clearClientInfo(serverName);
        return undefined;
      }
      return info;
    },

    /** Persist registered client credentials after DCR (or URL-based client ID). */
    async saveClientInformation(info: {
      client_id: string;
      client_secret?: string;
      client_id_issued_at?: number;
      client_secret_expires_at?: number;
      token_endpoint_auth_method?: string;
    }) {
      storeClientInfo(serverName, {
        client_id: info.client_id,
        client_secret: info.client_secret,
        client_id_issued_at: info.client_id_issued_at,
        client_secret_expires_at: info.client_secret_expires_at,
        token_endpoint_auth_method: info.token_endpoint_auth_method,
      });
    },

    /** Load stored tokens → convert absolute millis back to relative `expires_in`
     *  seconds (what the SDK expects). Returns undefined if none stored. */
    async tokens(): Promise<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    } | undefined> {
      const stored = getOAuthTokens(serverName);
      if (!stored) return undefined;
      let expires_in: number | undefined;
      if (stored.expires_at) {
        const remaining = Math.floor((stored.expires_at - Date.now()) / 1000);
        // Only report a TTL if the token isn't already expired; the SDK treats
        // expires_in ≤ 0 as "expired" and will attempt refresh/re-auth.
        expires_in = remaining > 0 ? remaining : undefined;
      }
      return {
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
        expires_in,
        token_type: stored.token_type ?? 'Bearer',
        scope: stored.scope,
      };
    },

    /** Persist tokens after a successful exchange. The SDK passes the raw OAuth
     *  response shape (snake_case, `expires_in` in SECONDS). We store absolute
     *  millis so an expiry check survives a process restart. */
    async saveTokens(tokens: {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    }) {
      storeOAuthTokens(serverName, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        scope: tokens.scope,
        expires_at: tokens.expires_in
          ? Date.now() + tokens.expires_in * 1000
          : undefined,
      });
    },

    /** SDK authorization hook: defer the browser launch by stashing the URL; the user opens it via the "Authenticate" button so it doesn't pop on every init/reload. */
    async redirectToAuthorization(authorizationUrl: URL) {
      log.info('oauth authorization needed', { server: serverName, url: authorizationUrl.origin });
      setPendingAuthUrl(serverName, authorizationUrl);
    },

    async saveCodeVerifier(codeVerifier: string) {
      const file = readVerifiersFile();
      file[serverName] = codeVerifier;
      writeVerifiersFile(file);
    },

    async codeVerifier(): Promise<string> {
      const file = readVerifiersFile();
      const v = file[serverName];
      if (!v) throw new Error(`No stored PKCE code verifier for "${serverName}"`);
      return v;
    },

    /** Drop stored credentials when the server says they're invalid.
     *  scope='all'|'client' also clears the registered client (forces re-DCR);
     *  'tokens'|'verifier' clears only the auth artifacts. */
    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
      if (scope === 'all' || scope === 'tokens') clearOAuthTokens(serverName);
      if (scope === 'all' || scope === 'verifier') {
        const file = readVerifiersFile();
        delete file[serverName];
        writeVerifiersFile(file);
      }
      if (scope === 'all' || scope === 'client') clearClientInfo(serverName);
      log.info('credentials invalidated', { server: serverName, scope });
    },
  } satisfies Record<string, unknown>;
}
