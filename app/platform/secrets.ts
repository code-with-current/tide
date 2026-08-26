/**
 * Platform secrets backend (macOS Keychain via the `security` CLI).
 *
 * Backend priority for the safeStorage-shaped API:
 *   1. Electron `safeStorage` (frozen Electron shell keeps decrypting its
 *      existing config.json blobs — loaded via createRequire so the
 *      Electrobun build never statically pulls in `electron`);
 *   2. macOS keychain (this implementation);
 *   3. null on every other platform (honest stubs; Windows/Linux are Task 4.6).
 *
 * Empirical `security` CLI semantics this module relies on (probed on macOS):
 *   - `security -i` reads whitespace-tokenized commands from stdin, supports
 *     NO quoting and has no `quit` command — the session runs until EOF, so
 *     secrets are fed via stdin (`input` option) and NEVER appear in argv
 *     (argv is briefly visible to same-user processes via ps);
 *   - a failed command inside `-i` does not abort the session and the final
 *     exit status reflects the last command — a delete-miss at the head of a
 *     delete+add batch is therefore harmless;
 *   - `add-generic-password -X <hex>` stores decoded bytes; with the payload
 *     hex-encoded twice the stored data is always printable ASCII hex, so
 *     `find-generic-password -w` echoes it verbatim (security would otherwise
 *     re-hex non-printable data on read);
 *   - `-X` must be the LAST option: an empty payload would otherwise swallow
 *     a following token as its argument;
 *   - a missing item exits 44 with "could not be found" on stderr.
 *
 * Handle scheme (`kcv2`): the ciphertext blob stored in config files is
 * `kcv2:<accountId>:<salt>:<verifier>` where accountId and salt are fresh
 * random 16-byte values per write and verifier = sha256(salt || plaintext)
 * truncated to 16 bytes. Nothing in the handle is derivable from the
 * plaintext, so a leaked handle is not an offline verification oracle for
 * low-entropy secrets, and two entries holding the same plaintext never
 * share a verifier. `kcv1:` handles (plaintext-hash accounts, written by the
 * interim 2.3 shim) are still readable so interim data keeps decrypting, and
 * non-handle input passes through unchanged (plaintext-fallback data) —
 * except Electron `v10` blobs, which throw (see decryptString).
 *
 * VITEST is checked explicitly: under test the backend reports unavailable so
 * no test can ever reach the real keychain.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { isV10Blob } from './key-migration.js';

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface MacKeychainBackend extends SafeStorageLike {
  getSecret(name: string): string | null;
  setSecret(name: string, value: string): void;
  deleteSecret(name: string): void;
}

const KEYCHAIN_SERVICE = 'tide';
const HANDLE_PREFIX = 'kcv2';
const LEGACY_HANDLE_PREFIX = 'kcv1';
const ACCOUNT_INFIX = 'kcv2-';

/** Stored keychain data for an empty value (an empty -X payload is not
 *  expressible — see header). Not valid hex, so it cannot collide with the
 *  envelope of any non-empty value. */
const EMPTY_ENVELOPE = '-';

interface ExecFailure extends Error {
  status?: number;
  stderr?: string;
}

function inVitestEnv(): boolean {
  return !!process.env['VITEST'];
}

function isDarwin(): boolean {
  return process.platform === 'darwin';
}

function macKeychainActive(): boolean {
  return isDarwin() && !inVitestEnv();
}

let electronSafeStorage: SafeStorageLike | null | undefined;

function loadElectronSafeStorage(): SafeStorageLike | null {
  if (electronSafeStorage !== undefined) return electronSafeStorage;
  electronSafeStorage = null;
  const versions = process.versions as Record<string, string | undefined>;
  if (versions['electron']) {
    try {
      const req = createRequire(import.meta.url);
      const electron = req('electron') as { safeStorage?: SafeStorageLike };
      if (electron?.safeStorage) electronSafeStorage = electron.safeStorage;
    } catch {
      electronSafeStorage = null;
    }
  }
  return electronSafeStorage;
}

function isItemMissing(err: unknown): boolean {
  const e = err as ExecFailure;
  return e.status === 44 || /could not be found/i.test(String(e.stderr ?? ''));
}

function describeFailure(err: unknown): string {
  const e = err as ExecFailure;
  return e.stderr || e.message || String(err);
}

/** Interactive session: commands on stdin, secrets never in argv. */
function securityInteractive(script: string): string {
  return execFileSync('security', ['-i'], {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** One-shot read; the value comes back on stdout and never touches argv. */
function keychainRead(account: string): string | null {
  try {
    return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r?\n$/, '');
  } catch (err) {
    if (isItemMissing(err)) return null;
    throw new Error(`keychain read failed for account ${account}: ${describeFailure(err)}`);
  }
}

/** Interactive-mode accounts must be single tokens: the -i tokenizer has no
 *  quoting, so whitespace/control characters would split or inject commands. */
function assertTokenSafe(account: string): void {
  if (!/^[!-~]{1,512}$/.test(account)) {
    throw new Error(`invalid keychain account name: ${JSON.stringify(account.slice(0, 40))}`);
  }
}

function toEnvelope(value: string): string {
  return value === '' ? EMPTY_ENVELOPE : Buffer.from(value, 'utf8').toString('hex');
}

function fromEnvelope(data: string): string {
  if (data === EMPTY_ENVELOPE) return '';
  if (!/^[0-9a-f]+$/i.test(data) || data.length % 2 !== 0) {
    throw new Error('keychain item does not hold a tide secret envelope');
  }
  return Buffer.from(data, 'hex').toString('utf8');
}

function keychainSet(account: string, value: string): void {
  assertTokenSafe(account);
  const payload = Buffer.from(toEnvelope(value), 'utf8').toString('hex');
  const script =
    `delete-generic-password -a ${account} -s ${KEYCHAIN_SERVICE}\n` +
    `add-generic-password -a ${account} -s ${KEYCHAIN_SERVICE} -U -X ${payload}\n`;
  try {
    securityInteractive(script);
  } catch (err) {
    throw new Error(`keychain write failed for account ${account}: ${describeFailure(err)}`);
  }
}

function keychainDelete(account: string): void {
  assertTokenSafe(account);
  try {
    securityInteractive(`delete-generic-password -a ${account} -s ${KEYCHAIN_SERVICE}\n`);
  } catch (err) {
    if (isItemMissing(err)) return;
    throw new Error(`keychain delete failed for account ${account}: ${describeFailure(err)}`);
  }
}

function keychainGet(name: string): string | null {
  assertTokenSafe(name);
  const data = keychainRead(name);
  return data === null ? null : fromEnvelope(data);
}

function verificationValue(salt: Buffer, plainText: string): string {
  return createHash('sha256')
    .update(Buffer.concat([salt, Buffer.from(plainText, 'utf8')]))
    .digest('hex')
    .slice(0, 32);
}

function macKeychainBackend(): MacKeychainBackend {
  return {
    isEncryptionAvailable: () => true,
    setSecret(name: string, value: string): void {
      keychainSet(name, value);
    },
    getSecret(name: string): string | null {
      return keychainGet(name);
    },
    deleteSecret(name: string): void {
      keychainDelete(name);
    },
    encryptString(plainText: string): Buffer {
      const accountId = randomBytes(16).toString('hex');
      const salt = randomBytes(16);
      const verifier = verificationValue(salt, plainText);
      keychainSet(ACCOUNT_INFIX + accountId, plainText);
      return Buffer.from(`${HANDLE_PREFIX}:${accountId}:${salt.toString('hex')}:${verifier}`, 'utf8');
    },
    decryptString(encrypted: Buffer): string {
      // Legacy Electron v10 blobs must not fall through the plaintext
      // passthrough below — that would surface ciphertext garbage as an API
      // key. Throwing routes callers to their missing-key handling until the
      // key-migration module rewrites the entry as a kcv2 handle.
      if (isV10Blob(encrypted)) {
        throw new Error('legacy Electron safeStorage blob (migration required)');
      }
      const text = encrypted.toString('utf8');
      if (text.startsWith(`${LEGACY_HANDLE_PREFIX}:`)) {
        const account = text.slice(LEGACY_HANDLE_PREFIX.length + 1);
        const raw = keychainRead(account);
        if (raw === null) throw new Error(`keychain item not found: ${account}`);
        return raw;
      }
      if (text.startsWith(`${HANDLE_PREFIX}:`)) {
        const parts = text.split(':');
        if (
          parts.length !== 4 ||
          !parts.slice(1).every((field) => /^[0-9a-f]{32}$/.test(field))
        ) {
          throw new Error('malformed kcv2 secret handle');
        }
        const [, accountId, saltHex, verifier] = parts;
        const data = keychainRead(ACCOUNT_INFIX + accountId);
        if (data === null) throw new Error(`keychain item not found: ${ACCOUNT_INFIX + accountId}`);
        const plainText = fromEnvelope(data);
        if (verificationValue(Buffer.from(saltHex, 'hex'), plainText) !== verifier) {
          throw new Error('keychain verification mismatch');
        }
        return plainText;
      }
      return text;
    },
  };
}

function backend(): SafeStorageLike | null {
  const native = loadElectronSafeStorage();
  if (native) return native;
  if (macKeychainActive()) return macKeychainBackend();
  return null;
}

export function isEncryptionAvailable(): boolean {
  return backend()?.isEncryptionAvailable() ?? false;
}

export function encryptString(plainText: string): Buffer {
  const b = backend();
  if (!b) throw new Error('safeStorage backend unavailable');
  return b.encryptString(plainText);
}

export function decryptString(encrypted: Buffer): string {
  const b = backend();
  if (!b) throw new Error('safeStorage backend unavailable');
  return b.decryptString(encrypted);
}

export function getSecret(name: string): string | null {
  if (!macKeychainActive()) return null;
  return keychainGet(name);
}

export function setSecret(name: string, value: string): void {
  if (!macKeychainActive()) return;
  keychainSet(name, value);
}

export function deleteSecret(name: string): void {
  if (!macKeychainActive()) return;
  keychainDelete(name);
}

/** Test-only seam: the raw macOS backend with all runtime gating
 *  (Electron passthrough, vitest suppression, platform check) bypassed, so
 *  unit tests exercise the real implementation against a mocked exec. */
export function __macKeychainForTests(): MacKeychainBackend {
  return macKeychainBackend();
}
