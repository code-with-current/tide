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

function tokensFilePath(): string {
  return path.join(app.getPath('userData'), OAUTH_TOKENS_FILE);
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Absolute epoch millis when the access token expires. */
  expiresAt?: number;
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
 * In-flight PKCE flows keyed by the random `state` we issue per attempt.
 * The browser round-trip is asynchronous from the SDK's perspective: when
 * the SDK calls `authorize()`, we open the user's browser, then await the
 * matching callback here. The promise is resolved with the auth code, which
 * the SDK exchanges for tokens (the exchange itself happens server-to-server
 * inside the SDK and never touches Tide).
 *
 * A `state` value must be unique per attempt; reusing it would let a stale
 * browser tab from a prior flow complete the current one. We don't generate
 * state here (the SDK owns it) — we just index whatever string it gave us.
 */
const pendingAuths = new Map<
  string,
  { resolve: (code: string) => void; reject: (e: Error) => void }
>();

/**
 * Called by the `tide://` handler when the OS hands us a callback URL.
 *
 * Parses `code` / `state` / `error` from the query string and resolves or
 * rejects the matching pending flow. Unknown / duplicate / mismatched
 * callbacks are ignored (the URL may be from an abandoned attempt or an
 * unrelated `tide://` invocation).
 */
export function handleOAuthCallback(url: string): void {
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    const error = parsed.searchParams.get('error');
    if (error) {
      log.warn('oauth callback error', { error, state: Boolean(state) });
      if (state && pendingAuths.has(state)) {
        pendingAuths.get(state)!.reject(new Error(error));
        pendingAuths.delete(state);
      }
      return;
    }
    if (code && state && pendingAuths.has(state)) {
      log.info('oauth callback received', { state: state.slice(0, 8) + '…' });
      pendingAuths.get(state)!.resolve(code);
      pendingAuths.delete(state);
    }
  } catch (e) {
    log.warn('callback handler failed', { error: String(e) });
  }
}

/**
 * Build the `OAuthClientAuthProvider` the MCP SDK expects. The shape is the
 * minimal subset the SDK calls into — TypeScript-wise it satisfies the
 * interface structurally without dragging the SDK types into this module.
 *
 * - `redirectUrl`: where the browser should send the user after authorizing.
 *   Must match what the server registered; we always use `tide://oauth/callback`.
 * - `clientMetadata`: identifies Tide to the server during metadata discovery.
 * - `clientInformation()`: per-server registered client credentials. We don't
 *   do dynamic client registration yet → return null (public client).
 * - `tokens()`: SDK callback after a successful exchange — persist for next run.
 * - `clear()`: SDK callback on logout / 401-with-dead-refresh — drop our copy.
 *
 * Note: `expiresAt` arrives as a relative TTL in SECONDS from the SDK (per the
 * OAuth spec) but we persist absolute epoch MILLIS so expiry checks are just a
 * comparison, not "now + ttl". The conversion happens here.
 */
export function createAuthProvider(serverName: string) {
  return {
    redirectUrl: REDIRECT_URL,
    clientMetadata: { name: 'Tide', version: app.getVersion() },
    async clientInformation() {
      return null;
    },
    async tokens(tokens: {
      accessToken: string;
      refreshToken?: string;
      /** Relative TTL in SECONDS, per the OAuth spec. */
      expiresAt?: number;
    }) {
      storeOAuthTokens(serverName, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt
          ? Date.now() + tokens.expiresAt * 1000
          : undefined,
      });
    },
    async clear() {
      clearOAuthTokens(serverName);
    },
  };
}
