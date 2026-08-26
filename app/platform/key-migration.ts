/**
 * One-way migration of provider API keys from Electron safeStorage's `v10`
 * blobs to the kcv2 keychain handles (app/platform/secrets.ts).
 *
 * The Electron shell encrypted keys with Chromium's macOS OSCrypt: the
 * config.json `encryptedKey` is base64 of `"v10" || AES-128-CBC ciphertext`
 * where key = PBKDF2-HMAC-SHA1(keychain password, "saltysalt", 1003, 16
 * bytes) and the IV is fixed at 16 space bytes (0x20). The password lives in
 * the macOS keychain under service "tide Safe Storage" (account "tide Key")
 * and is ACL-locked to the Electron binary — a headless read fails, but the
 * first read from an interactive session triggers macOS's one-time GUI
 * authorization dialog (Always Allow). That prompt is the designed trigger
 * for this migration on a real user machine.
 *
 * Rewriting goes through the same store path as the renderer's key edit
 * (`updateProvider` → `crypto.encrypt` → kcv2 handle), never through raw
 * config writes, so the store cache stays coherent. No plaintext or blob
 * backups are written; on any failure the v10 blobs are left untouched and
 * `keysNeedMigration` stays surfaced so the existing re-enter-key UI applies.
 *
 * VITEST is checked explicitly: the real keychain reader refuses to shell
 * out under test — tests inject a fake reader.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import * as fs from 'node:fs';
import { createLogger } from '../core/logger.js';

const log = createLogger('key-migration');

const V10_PREFIX = 'v10';
const PBKDF2_SALT = 'saltysalt';
const PBKDF2_ITERATIONS = 1003;
const KEY_BYTES = 16;
/** Chromium's macOS OSCrypt uses a fixed IV of 16 space bytes. */
const FIXED_IV = Buffer.alloc(16, 0x20);

/** Keychain services that may hold the Electron safeStorage password, in
 *  try order. The live item on user machines is `tide Safe Storage`
 *  (account `tide Key`) — probed and confirmed; `Tide Safe Storage` covers
 *  a packaged build whose app name resolved to the productName. */
const ELECTRON_SERVICES = ['tide Safe Storage', 'Tide Safe Storage'];

export interface ProviderKeyMigrationDeps {
  /** Reads the Electron safeStorage password. Null = unavailable (missing
   *  item, user denied, headless). Throwing is treated the same. */
  readPassword: () => Promise<string | null>;
  /** Re-stores one decrypted key. Return false if the write did not land. */
  reencrypt: (providerId: string, plainKey: string) => boolean;
}

export interface KeyMigrationOutcome {
  /** v10-encrypted provider keys found in config.json. */
  v10Count: number;
  /** Keys successfully re-stored as kcv2 handles. */
  migrated: number;
  /** True while any v10 key remains unmigrated. */
  keysNeedMigration: boolean;
}

function inVitestEnv(): boolean {
  return !!process.env['VITEST'];
}

/** Structural v10 check: 3-byte ASCII prefix + at least one AES block. */
export function isV10Blob(value: Buffer): boolean {
  return (
    value.length >= 3 + 16 &&
    (value.length - 3) % 16 === 0 &&
    value.subarray(0, 3).toString('latin1') === V10_PREFIX
  );
}

/** Decrypt a Chromium OSCrypt macOS v10 blob. Returns null on any mismatch:
 *  bad prefix, bad block layout, wrong password (PKCS#7 or UTF-8 check
 *  fails) — the caller treats null as "could not migrate this key". */
export function decryptV10(blob: Buffer, password: string): string | null {
  if (!isV10Blob(blob)) return null;
  try {
    const key = pbkdf2Sync(password, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_BYTES, 'sha1');
    const decipher = createDecipheriv('aes-128-cbc', key, FIXED_IV);
    // final() strips and validates PKCS#7 (throws on a wrong password's
    // garbage); the fatal UTF-8 decode filters the rare survivor, since API
    // keys are ASCII.
    const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}

interface ExecFailure extends Error {
  code?: number;
  stderr?: string;
}

function isItemMissing(err: unknown): boolean {
  const e = err as ExecFailure;
  return e.code === 44 || /could not be found/i.test(String(e.stderr ?? ''));
}

/** Read the Electron safeStorage password from the macOS keychain. Async so
 *  the one-time GUI authorization (ACL-locked item) never blocks boot. */
export async function readElectronSafeStoragePassword(): Promise<string | null> {
  if (inVitestEnv() || process.platform !== 'darwin') {
    return null;
  }
  const execFileAsync = promisify(execFile);
  for (const service of ELECTRON_SERVICES) {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password', '-s', service, '-w',
      ]);
      const password = stdout.replace(/\r?\n$/, '');
      if (password) return password;
    } catch (err) {
      if (isItemMissing(err)) continue;
      log.warn('electron safeStorage password read failed', {
        service,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  return null;
}

interface StoredConfig {
  providers?: Array<{ id: string; encryptedKey?: string | null }>;
}

function readConfig(configPath: string): StoredConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as StoredConfig;
  } catch {
    return null;
  }
}

/** Provider ids whose encryptedKey is a v10 blob. Empty when config.json is
 *  absent/unparseable (fresh install — nothing to migrate). */
export function scanV10ProviderIds(configPath: string): string[] {
  const cfg = readConfig(configPath);
  if (!cfg?.providers) return [];
  const ids: string[] = [];
  for (const p of cfg.providers) {
    if (!p.encryptedKey) continue;
    try {
      if (isV10Blob(Buffer.from(p.encryptedKey, 'base64'))) ids.push(p.id);
    } catch {
      /* not base64 — plaintext-fallback data, not ours to migrate */
    }
  }
  return ids;
}

/** Decrypt every v10 provider key with the Electron password and re-store it
 *  through `reencrypt`. Partial success is per-key: a key that fails to
 *  decrypt (wrong password, corrupt blob) is left as-is and keeps
 *  keysNeedMigration true. */
export async function migrateV10ProviderKeys(
  configPath: string,
  deps: ProviderKeyMigrationDeps,
): Promise<KeyMigrationOutcome> {
  const v10Ids = scanV10ProviderIds(configPath);
  if (v10Ids.length === 0) return { v10Count: 0, migrated: 0, keysNeedMigration: false };

  let password: string | null = null;
  try {
    password = await deps.readPassword();
  } catch (err) {
    log.warn('electron password reader threw', { err: err instanceof Error ? err.message : String(err) });
  }
  if (password === null) {
    return { v10Count: v10Ids.length, migrated: 0, keysNeedMigration: true };
  }

  const cfg = readConfig(configPath);
  if (!cfg?.providers) {
    return { v10Count: v10Ids.length, migrated: 0, keysNeedMigration: true };
  }

  let migrated = 0;
  for (const provider of cfg.providers) {
    if (!provider.encryptedKey) continue;
    let blob: Buffer;
    try {
      blob = Buffer.from(provider.encryptedKey, 'base64');
    } catch {
      continue;
    }
    if (!isV10Blob(blob)) continue;
    const plain = decryptV10(blob, password);
    if (plain === null || plain === '') continue;
    if (deps.reencrypt(provider.id, plain)) migrated++;
  }
  return { v10Count: v10Ids.length, migrated, keysNeedMigration: migrated < v10Ids.length };
}

export interface KeyMigrationBootOpts {
  /** Path to config.json inside the app data dir. */
  configPath: string;
  /** Re-store one decrypted key (boot wires this to store.updateProvider). */
  reencrypt: (providerId: string, plainKey: string) => boolean;
  /** Injectable for the live E2E; defaults to the real keychain reader. */
  readPassword?: () => Promise<string | null>;
}

let keysNeedMigration = false;

export function getKeysNeedMigration(): boolean {
  return keysNeedMigration;
}

/** Boot hook: synchronously scans config.json for v10 keys (no keychain
 *  access, so it never delays startup) and, when present, flips the surfaced
 *  flag and fires one async migration attempt. The attempt may block on the
 *  one-time macOS GUI authorization — that is by design and happens off the
 *  boot path. */
export function bootstrapProviderKeyMigration(opts: KeyMigrationBootOpts): void {
  const v10Ids = scanV10ProviderIds(opts.configPath);
  if (v10Ids.length === 0) return;
  keysNeedMigration = true;
  log.info('v10 provider keys detected', { count: v10Ids.length });
  const readPassword = opts.readPassword ?? readElectronSafeStoragePassword;
  void migrateV10ProviderKeys(opts.configPath, {
    readPassword,
    reencrypt: opts.reencrypt,
  }).then((outcome) => {
    if (!outcome.keysNeedMigration) {
      keysNeedMigration = false;
      log.info('provider keys migrated from electron safeStorage', { migrated: outcome.migrated });
    } else {
      log.warn('provider key migration incomplete', {
        migrated: outcome.migrated,
        total: outcome.v10Count,
      });
    }
  }).catch((err: unknown) => {
    log.warn('provider key migration failed', { err: err instanceof Error ? err.message : String(err) });
  });
}

/** Test seam: reset the surfaced flag between tests. */
export function __resetKeyMigrationForTests(): void {
  keysNeedMigration = false;
}
