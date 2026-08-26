/** Key migration gate for app/platform/key-migration.ts:
 *  - decryptV10 round-trips against synthetic blobs built with Chromium's
 *    macOS OSCrypt scheme (v10 + AES-128-CBC, PBKDF2-HMAC-SHA1 key from
 *    "saltysalt"/1003, fixed 16-space IV);
 *  - wrong password / corrupt input → null, never a throw;
 *  - migration outcome table: success rewrites config with no v10 left,
 *    failure (password unavailable) sets the flag and leaves config
 *    byte-identical, partial mixes per-key, reencrypt misses count as
 *    failures;
 *  - the real keychain reader is inert under vitest;
 *  - the surfaced flag flips through bootstrapProviderKeyMigration.
 *  All blobs are synthetic — no real keychain access anywhere. */
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetKeyMigrationForTests,
  bootstrapProviderKeyMigration,
  decryptV10,
  getKeysNeedMigration,
  isV10Blob,
  migrateV10ProviderKeys,
  readElectronSafeStoragePassword,
} from '../../../app/platform/key-migration';

const SALT = 'saltysalt';
const ITERATIONS = 1003;
const IV = Buffer.alloc(16, 0x20);

function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ITERATIONS, 16, 'sha1');
}

function encryptV10(plaintext: string, password: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', deriveKey(password), IV);
  return Buffer.concat([Buffer.from('v10', 'latin1'), cipher.update(plaintext, 'utf8'), cipher.final()]);
}

function provider(id: string, encryptedKey: string | null): { id: string; encryptedKey: string | null } {
  return { id, encryptedKey };
}

let tmpDir: string;
let configPath: string;
const PASSWORD = 'synthetic-throwaway-password';

function writeConfig(providers: Array<{ id: string; encryptedKey: string | null }>): void {
  fs.writeFileSync(configPath, JSON.stringify({ providers }, null, 2), 'utf-8');
}

function readConfig(): { providers: Array<{ id: string; encryptedKey: string | null }> } {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

/** Fake reencrypt that rewrites the key in config.json as a kcv2-ish handle
 *  (the real boot path routes through store.updateProvider, which produces
 *  real handles; tests only need "no v10 remains"). */
function fakeReencrypt(id: string, plainKey: string): boolean {
  const cfg = readConfig();
  const stored = cfg.providers.find((p) => p.id === id);
  if (!stored) return false;
  stored.encryptedKey = Buffer.from(`kcv2:${plainKey.length}:${plainKey}`).toString('base64');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
  return true;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-key-migration-'));
  configPath = path.join(tmpDir, 'config.json');
  __resetKeyMigrationForTests();
});

afterEach(() => {
  __resetKeyMigrationForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isV10Blob', () => {
  it('accepts prefix + block-aligned ciphertext', () => {
    expect(isV10Blob(encryptV10('sk-test', PASSWORD))).toBe(true);
  });

  it('rejects short, misaligned, and wrong-prefix input', () => {
    expect(isV10Blob(Buffer.from('v10'))).toBe(false);
    expect(isV10Blob(Buffer.from('v10' + 'a'.repeat(15)))).toBe(false);
    expect(isV10Blob(Buffer.from('v11' + 'a'.repeat(16)))).toBe(false);
    expect(isV10Blob(Buffer.from('kcv2:abcd'))).toBe(false);
    expect(isV10Blob(Buffer.alloc(0))).toBe(false);
  });
});

describe('decryptV10', () => {
  it('round-trips a synthetic blob', () => {
    const blob = encryptV10('sk-synthetic-key-123', PASSWORD);
    expect(decryptV10(blob, PASSWORD)).toBe('sk-synthetic-key-123');
  });

  it('handles multi-block and exactly-one-block plaintexts', () => {
    const short = 'abc'; // 1 block after padding
    const long = 'x'.repeat(31); // 2 blocks
    expect(decryptV10(encryptV10(short, PASSWORD), PASSWORD)).toBe(short);
    expect(decryptV10(encryptV10(long, PASSWORD), PASSWORD)).toBe(long);
  });

  it('returns null on wrong password', () => {
    const blob = encryptV10('sk-synthetic-key-123', PASSWORD);
    expect(decryptV10(blob, 'wrong-password')).toBeNull();
  });

  it('returns null on corrupt or non-v10 input', () => {
    expect(decryptV10(Buffer.alloc(0), PASSWORD)).toBeNull();
    expect(decryptV10(Buffer.from('kcv2:deadbeef'), PASSWORD)).toBeNull();
    const flipped = encryptV10('sk-synthetic-key-123', PASSWORD);
    flipped[flipped.length - 1] ^= 0xff;
    expect(decryptV10(flipped, PASSWORD)).toBeNull();
  });
});

describe('migrateV10ProviderKeys', () => {
  it('success: rewrites config, no v10 remains, flag false', async () => {
    writeConfig([
      provider('p_a', encryptV10('sk-aaa', PASSWORD).toString('base64')),
      provider('p_b', encryptV10('sk-bbb', PASSWORD).toString('base64')),
    ]);
    const outcome = await migrateV10ProviderKeys(configPath, {
      readPassword: () => Promise.resolve(PASSWORD),
      reencrypt: fakeReencrypt,
    });
    expect(outcome).toEqual({ v10Count: 2, migrated: 2, keysNeedMigration: false });
    const cfg = readConfig();
    expect(cfg.providers.every((p) => !isV10Blob(Buffer.from(p.encryptedKey ?? '', 'base64')))).toBe(true);
  });

  it('failure: password unavailable sets flag and leaves config untouched', async () => {
    const before = encryptV10('sk-aaa', PASSWORD).toString('base64');
    writeConfig([provider('p_a', before)]);
    const outcome = await migrateV10ProviderKeys(configPath, {
      readPassword: () => Promise.resolve(null),
      reencrypt: fakeReencrypt,
    });
    expect(outcome).toEqual({ v10Count: 1, migrated: 0, keysNeedMigration: true });
    expect(readConfig().providers[0]!.encryptedKey).toBe(before);
  });

  it('failure: reader throws is treated as unavailable', async () => {
    writeConfig([provider('p_a', encryptV10('sk-aaa', PASSWORD).toString('base64'))]);
    const outcome = await migrateV10ProviderKeys(configPath, {
      readPassword: () => Promise.reject(new Error('exit 51')),
      reencrypt: fakeReencrypt,
    });
    expect(outcome.keysNeedMigration).toBe(true);
    expect(outcome.migrated).toBe(0);
  });

  it('partial: mixed v10 and plain keys migrate per-key', async () => {
    writeConfig([
      provider('p_v10', encryptV10('sk-aaa', PASSWORD).toString('base64')),
      provider('p_plain', Buffer.from('kcv2:plain-already').toString('base64')),
      provider('p_none', null),
    ]);
    const outcome = await migrateV10ProviderKeys(configPath, {
      readPassword: () => Promise.resolve(PASSWORD),
      reencrypt: fakeReencrypt,
    });
    expect(outcome).toEqual({ v10Count: 1, migrated: 1, keysNeedMigration: false });
    const cfg = readConfig();
    expect(isV10Blob(Buffer.from(cfg.providers[0]!.encryptedKey ?? '', 'base64'))).toBe(false);
    expect(cfg.providers[1]!.encryptedKey).toBe(Buffer.from('kcv2:plain-already').toString('base64'));
  });

  it('wrong password: every key fails, flag stays true, config untouched', async () => {
    const originalA = encryptV10('sk-aaa', PASSWORD).toString('base64');
    const originalB = encryptV10('sk-bbb', PASSWORD).toString('base64');
    writeConfig([provider('p_a', originalA), provider('p_b', originalB)]);
    const outcome = await migrateV10ProviderKeys(configPath, {
      readPassword: () => Promise.resolve('definitely-not-the-password'),
      reencrypt: fakeReencrypt,
    });
    expect(outcome).toEqual({ v10Count: 2, migrated: 0, keysNeedMigration: true });
    expect(readConfig().providers.map((p) => p.encryptedKey)).toEqual([originalA, originalB]);
  });

  it('reencrypt miss (provider vanished) counts as unmigrated', async () => {
    writeConfig([provider('p_a', encryptV10('sk-aaa', PASSWORD).toString('base64'))]);
    const outcome = await migrateV10ProviderKeys(configPath, {
      readPassword: () => Promise.resolve(PASSWORD),
      reencrypt: () => false,
    });
    expect(outcome).toEqual({ v10Count: 1, migrated: 0, keysNeedMigration: true });
  });

  it('missing or unparseable config is a no-op success', async () => {
    const outcome = await migrateV10ProviderKeys(path.join(tmpDir, 'absent.json'), {
      readPassword: () => Promise.resolve(PASSWORD),
      reencrypt: fakeReencrypt,
    });
    expect(outcome).toEqual({ v10Count: 0, migrated: 0, keysNeedMigration: false });
  });
});

describe('bootstrapProviderKeyMigration', () => {
  it('no v10 keys: flag stays false, reader never called', () => {
    writeConfig([provider('p_plain', Buffer.from('kcv2:plain').toString('base64'))]);
    const readPassword = vi.fn(() => Promise.resolve(PASSWORD));
    bootstrapProviderKeyMigration({ configPath, reencrypt: fakeReencrypt, readPassword });
    expect(getKeysNeedMigration()).toBe(false);
    expect(readPassword).not.toHaveBeenCalled();
  });

  it('v10 keys: flag flips true, then false once migration lands', async () => {
    writeConfig([provider('p_a', encryptV10('sk-aaa', PASSWORD).toString('base64'))]);
    const readPassword = vi.fn(() => Promise.resolve(PASSWORD));
    bootstrapProviderKeyMigration({ configPath, reencrypt: fakeReencrypt, readPassword });
    expect(getKeysNeedMigration()).toBe(true);
    await vi.waitFor(() => expect(getKeysNeedMigration()).toBe(false));
    expect(readPassword).toHaveBeenCalledTimes(1);
  });

  it('v10 keys that cannot migrate: flag stays true', async () => {
    writeConfig([provider('p_a', encryptV10('sk-aaa', PASSWORD).toString('base64'))]);
    bootstrapProviderKeyMigration({
      configPath,
      reencrypt: fakeReencrypt,
      readPassword: () => Promise.resolve(null),
    });
    expect(getKeysNeedMigration()).toBe(true);
    await vi.waitFor(() => expect(getKeysNeedMigration()).toBe(true));
  });
});

describe('readElectronSafeStoragePassword', () => {
  it('never shells out under vitest', async () => {
    await expect(readElectronSafeStoragePassword()).resolves.toBeNull();
  });
});
