/**
 * OAuth authProvider for MCP remote servers.
 *
 * Implements the PKCE flow used by the MCP SDK's streamable-http transport:
 *   401 → metadata discovery → browser auth at the server's authorization
 *   endpoint → `tide://oauth/callback?code=...&state=...` redirect → the SDK
 *   exchanges the auth code for tokens → this provider persists them via
 *   Electron `safeStorage` (Keychain on macOS, DPAPI on Windows, libsecret
 *   on Linux; falls back to base64 when no OS keychain is available).
 *
 * The provider is per-server-name: each remote MCP server has its own entry
 * in `mcp-oauth-tokens.json` (the file is a name → encrypted-blob map; the
 * blobs are opaque ciphertext so the file itself carries no secrets).
 *
 * The `tide://` scheme is registered as privileged in main.ts (BEFORE app
 * ready) and Tide registers itself as the OS handler for it
 * (`app.setAsDefaultProtocolClient`). On macOS the OS hands the callback URL
 * to the running instance via `open-url`; on Windows/Linux a second instance
 * is launched with the URL as the last argv arg, and `requestSingleInstanceLock`
 * forwards it to the primary instance via `second-instance`.
 *
 * Storage shape:
 *   {
 *     "github": "<base64 ciphertext>",
 *     "linear": "<base64 ciphertext>"
 *   }
 *
 * The ciphertext decrypts to a JSON blob matching `StoredTokens`.
 */
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../logger';

const log = createLogger('mcp/oauth');

const OAUTH_TOKENS_FILE = 'mcp-oauth-tokens.json';
const REDIRECT_URL = 'tide://oauth/callback';

/**
 * Pending OAuth authorization URLs, keyed by server name.
 *
 * The auth flow is DEFERRED: when the SDK's `auth()` decides authorization is
 * needed, it calls `redirectToAuthorization(url)`. We do NOT open the browser
 * there (that would pop it during every init/reload). Instead we stash the URL
 * and set the connection to `needs_oauth`. The user then clicks "Authenticate"
 * in the MCP settings UI, which calls `consumePendingAuthUrl(name)` → opens
 * the browser. This keeps the browser launch user-initiated.
 *
 * One URL per server; a new flow overwrites the previous.
 */
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

function tokensFilePath(): string {
  return path.join(app.getPath('userData'), OAUTH_TOKENS_FILE);
}

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
  try {
    return JSON.parse(fs.readFileSync(tokensFilePath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeTokensFile(data: OAuthTokensFile): void {
  const filePath = tokensFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic-ish: write to a temp file then rename over the target. Avoids a
  // truncated file if the process is killed mid-write.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
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

/**
 * Called by the `tide://` handler when the OS hands us a callback URL.
 *
 * Parses `code` / `state` / `error` from the query string and forwards to the
 * connection pool's `completeOAuthCallback`, which calls `finishAuth(code)`
 * on the transport that started the flow. Errors are logged; unknown /
 * duplicate callbacks are ignored.
 *
 * NB: this is intentionally a thin parser — it can't import the pool (which
 * imports this module), so it delegates via the `completer` registered below.
 */
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

/**
 * PKCE code-verifier storage — per server-name, alongside the OAuth tokens.
 *
 * The SDK's PKCE flow is split across two async boundaries:
 *   1. It generates a verifier + challenges, calls `saveCodeVerifier()`, then
 *      `redirectToAuthorization()` (we open the browser). Control returns.
 *   2. Later, after the `tide://oauth/callback` round-trip, the SDK calls
 *      `codeVerifier()` to retrieve the SAME verifier it saved in step 1, so it
 *      can complete the token exchange. That exchange happens inside the SDK
 *      (server-to-server) and never touches Tide.
 *
 * So the verifier must persist between those two calls — we store it next to
 * the tokens. Reused per server-name; each new flow overwrites the previous.
 */
function verifierFilePath(): string {
  return path.join(app.getPath('userData'), 'mcp-oauth-verifiers.json');
}
function readVerifiersFile(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(verifierFilePath(), 'utf-8'));
  } catch {
    return {};
  }
}
function writeVerifiersFile(data: Record<string, string>): void {
  const filePath = verifierFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * DCR client-information storage — per server-name, encrypted like the tokens.
 *
 * When an MCP server's authorization server supports Dynamic Client
 * Registration (RFC 7591), the SDK registers Tide as a client and gets back
 * credentials (client_id, optional client_secret, issue/expiry timestamps).
 * Those MUST persist between sessions — otherwise every reconnect re-registers
 * a new client and the old one leaks on the server. Stored next to the tokens,
 * encrypted via safeStorage.
 *
 * Shape matches the SDK's `OAuthClientInformation` (the core creds subset of
 * `OAuthClientInformationMixed`).
 */
interface StoredClientInfo {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  token_endpoint_auth_method?: string;
}
function clientInfoFilePath(): string {
  return path.join(app.getPath('userData'), 'mcp-oauth-clients.json');
}
function readClientInfoFile(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(clientInfoFilePath(), 'utf-8'));
  } catch {
    return {};
  }
}
function writeClientInfoFile(data: Record<string, string>): void {
  const filePath = clientInfoFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
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

/**
 * Build an `OAuthClientProvider` the MCP SDK expects for SSE / streamable-HTTP
 * servers that require authorization (the 401 → metadata → browser auth →
 * callback → token exchange flow).
 *
 * Implements the full SDK v1.30 `OAuthClientProvider` interface:
 *   - `redirectUrl` / `clientMetadata`: static OAuth client identity.
 *   - `clientInformation()` / `saveClientInformation()`: per-server registered
 *     client credentials, persisted so DCR (Dynamic Client Registration) only
 *     happens once per server — returning sessions reuse the registered client.
 *   - `tokens()` (READER): returns stored tokens so a returning session skips
 *     the browser round-trip. This is the method the OLD implementation got
 *     wrong (it was a writer named `tokens`).
 *   - `saveTokens()`: persist after a successful exchange.
 *   - `redirectToAuthorization()`: open the user's browser at the server's
 *     authorization URL.
 *   - `saveCodeVerifier()` / `codeVerifier()`: PKCE verifier persistence.
 *   - `invalidateCredentials()`: drop tokens + client info on dead refresh.
 *
 * The SDK's `OAuthTokens` shape is SNAKE_CASE (`access_token`, `refresh_token`,
 * `expires_in`) — `expires_in` is a relative TTL in SECONDS (the raw OAuth spec
 * field), NOT absolute millis. We convert to absolute millis on write and back
 * to relative seconds on read so expiry survives app restarts, while keeping
 * the SDK contract exact.
 */
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

    /** The SDK calls this when authorization is needed. We DEFER the browser
     *  launch — stash the URL and return. The connection is marked
     *  `needs_oauth` by the caller (connectServer catches the resulting
     *  Unauthorized), and the user launches the browser explicitly via the
     *  "Authenticate" button. This prevents the browser popping on every
     *  init/reload. */
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
