/** Keychain backend gate for app/platform/secrets.ts:
 *  - secrets never appear in `security` argv (ps-visibility fix) — every
 *    mutation runs through `security -i` with commands on stdin;
 *  - set is delete-then-add (fresh random item per write, no plaintext-
 *    derived account);
 *  - kcv2 handles carry a per-entry random salt; the verification value is
 *    sha256(salt || plaintext) so two entries with identical plaintext never
 *    share a verifier (no offline oracle over the stored handle);
 *  - vitest / non-darwin never shell out (backend reports unavailable).
 *  child_process.execFileSync is fully mocked — these tests must never touch
 *  the real keychain. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as secrets from '../../../app/platform/secrets';

const exec = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; input: string | null }>,
  items: new Map<string, string>(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const flagValue = (tokens: string[], flag: string): string => {
    const i = tokens.indexOf(flag);
    if (i === -1 || i + 1 >= tokens.length) throw new Error(`mock: missing value for ${flag}`);
    return tokens[i + 1];
  };
  const execFileSync = (file: string, args: string[], options: { input?: string } = {}): string => {
    exec.calls.push({ file, args: [...args], input: options.input ?? null });
    if (file !== 'security') throw new Error(`mock: unexpected binary ${file}`);
    if (args[0] === '-i') {
      const lines = (options.input ?? '').split('\n').filter((l) => l.trim() !== '');
      let lastFailed = false;
      let stderr = '';
      for (const line of lines) {
        const tokens = line.split(/\s+/);
        if (tokens[0] === 'delete-generic-password') {
          const account = flagValue(tokens, '-a');
          if (exec.items.has(account)) {
            exec.items.delete(account);
            lastFailed = false;
          } else {
            stderr += 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n';
            lastFailed = true;
          }
        } else if (tokens[0] === 'add-generic-password') {
          // -X carries hex of the stored data text; decode like the real CLI.
          exec.items.set(flagValue(tokens, '-a'), Buffer.from(flagValue(tokens, '-X'), 'hex').toString('utf8'));
          lastFailed = false;
        } else {
          lastFailed = true;
        }
      }
      if (lastFailed) {
        const err = new Error('security interactive session failed') as Error & { status: number; stderr: string };
        err.status = 44;
        err.stderr = stderr || 'security: command failed';
        throw err;
      }
      return 'password has been deleted.\n';
    }
    if (args[0] === 'find-generic-password') {
      const account = flagValue(args, '-a');
      if (!exec.items.has(account)) {
        const err = new Error('could not be found') as Error & { status: number; stderr: string };
        err.status = 44;
        err.stderr = 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.';
        throw err;
      }
      return exec.items.get(account) + '\n';
    }
    throw new Error(`mock: unexpected security args ${args.join(' ')}`);
  };
  return { ...actual, execFileSync };
});

const REAL_PLATFORM = process.platform;
const HAD_VITEST = process.env['VITEST'];

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** Run body with the vitest suppression lifted (exec is mocked, so this is safe). */
function withoutVitestEnv<T>(body: () => T): T {
  delete process.env['VITEST'];
  try {
    return body();
  } finally {
    if (HAD_VITEST !== undefined) process.env['VITEST'] = HAD_VITEST;
  }
}

function interactiveCalls(): Array<{ args: string[]; input: string | null }> {
  return exec.calls.filter((c) => c.args[0] === '-i');
}

function stdinLines(call: { input: string | null }): string[] {
  return (call.input ?? '').split('\n').filter((l) => l.trim() !== '');
}

beforeEach(() => {
  exec.calls.length = 0;
  exec.items.clear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
  if (HAD_VITEST !== undefined) process.env['VITEST'] = HAD_VITEST;
});

describe('mac keychain backend (test seam, mocked exec)', () => {
  const mac = () => secrets.__macKeychainForTests();

  it('isEncryptionAvailable reports true', () => {
    expect(mac().isEncryptionAvailable()).toBe(true);
  });

  it('round-trips a value with spaces, quotes, newlines, tabs and unicode', () => {
    const nasty = 'p@ss "quoted" \'single\'\n\tline2 Ω∑--';
    mac().setSecret('tide-test-acct', nasty);
    expect(mac().getSecret('tide-test-acct')).toBe(nasty);
  });

  it('round-trips an empty value', () => {
    mac().setSecret('tide-test-empty', '');
    expect(mac().getSecret('tide-test-empty')).toBe('');
  });

  it('getSecret returns null for a missing item', () => {
    expect(mac().getSecret('tide-test-missing')).toBeNull();
  });

  it('deleteSecret removes the item and tolerates a missing item', () => {
    mac().setSecret('tide-test-del', 'x');
    mac().deleteSecret('tide-test-del');
    expect(mac().getSecret('tide-test-del')).toBeNull();
    expect(() => mac().deleteSecret('tide-test-del')).not.toThrow();
  });

  it('rejects account names that could inject interactive commands', () => {
    expect(() => mac().setSecret('bad\nadd-generic-password -a evil', 'x')).toThrow();
    expect(() => mac().setSecret('has space', 'x')).toThrow();
    expect(() => mac().setSecret('', 'x')).toThrow();
    expect(exec.calls.length).toBe(0);
  });

  it('mutations run via security -i: value never in argv, delete-then-add on set', () => {
    const value = 'argv-secret-value';
    mac().setSecret('tide-test-argv', value);
    const interactive = interactiveCalls();
    expect(interactive.length).toBeGreaterThan(0);
    for (const call of exec.calls) {
      expect(call.args.join(' ')).not.toContain(value);
      expect(call.file).toBe('security');
    }
    const lines = stdinLines(interactive[interactive.length - 1]);
    expect(lines[0]).toMatch(/^delete-generic-password -a tide-test-argv -s tide$/);
    expect(lines[1]).toMatch(/^add-generic-password -a tide-test-argv -s tide -U -X [0-9a-f]+$/);
    // -X strictly last: an empty payload can never swallow a following token.
    expect(lines[1].endsWith(`-X ${Buffer.from(Buffer.from('argv-secret-value').toString('hex')).toString('hex')}`)).toBe(true);
  });

  it('find reads via one-shot -w stdout (no value in argv, no -i stdin)', () => {
    mac().setSecret('tide-test-find', 'findme');
    mac().getSecret('tide-test-find');
    const find = exec.calls.find((c) => c.args[0] === 'find-generic-password');
    expect(find).toBeDefined();
    expect(find.args).toEqual(['find-generic-password', '-s', 'tide', '-a', 'tide-test-find', '-w']);
    expect(find.args.join(' ')).not.toContain('findme');
  });
});

describe('kcv2 handle scheme (salted verifier, no plaintext-derived account)', () => {
  const mac = () => secrets.__macKeychainForTests();

  it('encryptString produces a kcv2 handle with random account, salt and verifier', () => {
    const handle = mac().encryptString('hunter2').toString('utf8');
    expect(handle).toMatch(/^kcv2:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{32}$/);
    expect(handle).not.toContain('hunter2');
    // account must not be derivable from the plaintext
    const other = mac().encryptString('hunter2').toString('utf8');
    expect(handle.split(':')[1]).not.toBe(other.split(':')[1]);
  });

  it('identical plaintext in two entries yields DIFFERENT verification values', () => {
    const a = mac().encryptString('same-plaintext').toString('utf8').split(':');
    const b = mac().encryptString('same-plaintext').toString('utf8').split(':');
    expect(a[3]).not.toBe(b[3]);
    expect(a[2]).not.toBe(b[2]); // per-entry salt drives the difference
  });

  it('same entry + same plaintext verifies equal and decrypts back', () => {
    const handle = mac().encryptString('stable-value');
    expect(mac().decryptString(handle)).toBe('stable-value');
    expect(mac().decryptString(handle)).toBe('stable-value');
  });

  it('secret value never appears in any argv during encrypt/decrypt', () => {
    const value = 'never-in-argv-token';
    const handle = mac().encryptString(value);
    mac().decryptString(handle);
    for (const call of exec.calls) {
      expect(call.args.join(' ')).not.toContain(value);
    }
  });

  it('detects a swapped/tampered keychain item via the verifier', () => {
    const handle = mac().encryptString('original').toString('utf8');
    const account = `kcv2-${handle.split(':')[1]}`;
    // Swap in a different entry's data under the same account.
    const other = mac().encryptString('attacker-value');
    exec.items.set(account, exec.items.get(`kcv2-${other.toString('utf8').split(':')[1]}`)!);
    expect(() => mac().decryptString(Buffer.from(handle, 'utf8'))).toThrow(/mismatch|not found/i);
  });

  it('decryptString throws for a handle whose keychain item is gone', () => {
    const handle = mac().encryptString('gone').toString('utf8');
    exec.items.delete(`kcv2-${handle.split(':')[1]}`);
    expect(() => mac().decryptString(Buffer.from(handle, 'utf8'))).toThrow(/not found/i);
  });

  it('still reads legacy kcv1 handles (raw plaintext items from the 2.3 shim)', () => {
    exec.items.set('kcv1-abc123def456', 'legacy-raw-value');
    expect(mac().decryptString(Buffer.from('kcv1:kcv1-abc123def456', 'utf8'))).toBe('legacy-raw-value');
  });

  it('passes non-handle ciphertext through unchanged (plaintext fallback data)', () => {
    expect(exec.calls.length).toBe(0);
    expect(mac().decryptString(Buffer.from('plaintext-config-value', 'utf8'))).toBe('plaintext-config-value');
    expect(exec.calls.length).toBe(0);
  });

  it('throws on Electron v10 blobs instead of passing garbage through', () => {
    // v10 + one AES block: structurally a legacy Electron safeStorage blob.
    const blob = Buffer.concat([Buffer.from('v10', 'latin1'), Buffer.alloc(16, 0x41)]);
    expect(() => mac().decryptString(blob)).toThrow(/v10|migration/i);
  });
});

describe('backend selection and suppression', () => {
  it('isEncryptionAvailable is false under VITEST (never shells out)', () => {
    expect(process.env['VITEST']).toBeTruthy();
    expect(secrets.isEncryptionAvailable()).toBe(false);
    expect(() => secrets.encryptString('x')).toThrow(/unavailable/);
    expect(() => secrets.decryptString(Buffer.from('kcv2:' + '0'.repeat(32) + ':' + '0'.repeat(32) + ':' + '0'.repeat(32)))).toThrow(/unavailable/);
    expect(exec.calls.length).toBe(0);
  });

  it('raw API is inert under VITEST: getSecret null, set/delete no-op', () => {
    expect(secrets.getSecret('anything')).toBeNull();
    secrets.setSecret('anything', 'v');
    secrets.deleteSecret('anything');
    expect(exec.calls.length).toBe(0);
  });

  it('non-darwin is an honest stub even with VITEST unset', () => {
    setPlatform('linux');
    withoutVitestEnv(() => {
      expect(secrets.isEncryptionAvailable()).toBe(false);
      expect(secrets.getSecret('x')).toBeNull();
      expect(() => secrets.encryptString('x')).toThrow(/unavailable/);
      secrets.setSecret('x', 'v');
      secrets.deleteSecret('x');
    });
    expect(exec.calls.length).toBe(0);
  });

  it('darwin without VITEST selects the keychain backend through the public API', () => {
    setPlatform('darwin');
    withoutVitestEnv(() => {
      expect(secrets.isEncryptionAvailable()).toBe(true);
      const handle = secrets.encryptString('public-path-value');
      expect(secrets.decryptString(handle)).toBe('public-path-value');
      expect(secrets.getSecret('public-raw')).toBeNull();
      secrets.setSecret('public-raw', 'raw-value');
      expect(secrets.getSecret('public-raw')).toBe('raw-value');
      secrets.deleteSecret('public-raw');
      expect(secrets.getSecret('public-raw')).toBeNull();
    });
    for (const call of exec.calls) {
      expect(call.args.join(' ')).not.toContain('public-path-value');
      expect(call.args.join(' ')).not.toContain('raw-value');
    }
  });

  it('darwin under VITEST stays suppressed (vitest wins over platform)', () => {
    setPlatform('darwin');
    expect(process.env['VITEST']).toBeTruthy();
    expect(secrets.isEncryptionAvailable()).toBe(false);
    expect(exec.calls.length).toBe(0);
  });
});
