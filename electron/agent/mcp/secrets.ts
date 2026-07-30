/**
 * MCP secret storage — resolves {{secret:name}} placeholders from
 * Electron's safeStorage (OS keychain).
 *
 * Two patterns coexist in MCP configs:
 *   1. Inline values — passed through as-is (e.g. "PROXY_API_KEY": "sk-xxx")
 *   2. Placeholder secrets — {{secret:name}} resolved from safeStorage
 */
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const SECRETS_FILE = 'mcp-secrets.json';

function secretsFilePath(): string {
  return path.join(app.getPath('userData'), SECRETS_FILE);
}

interface SecretsFile {
  [key: string]: string; // name → base64-encoded encrypted value
}

function readSecrets(): SecretsFile {
  try {
    const raw = fs.readFileSync(secretsFilePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSecrets(secrets: SecretsFile): void {
  const filePath = secretsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

/** Store a secret value (encrypted via safeStorage). */
export function setSecret(name: string, value: string): void {
  const secrets = readSecrets();
  if (!safeStorage.isEncryptionAvailable()) {
    secrets[name] = Buffer.from(value).toString('base64');
  } else {
    secrets[name] = safeStorage.encryptString(value).toString('base64');
  }
  writeSecrets(secrets);
}

/** Retrieve a secret value (decrypted). Returns undefined if not stored. */
export function getSecret(name: string): string | undefined {
  const secrets = readSecrets();
  const encoded = secrets[name];
  if (!encoded) return undefined;
  if (!safeStorage.isEncryptionAvailable()) {
    return Buffer.from(encoded, 'base64').toString();
  }
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return undefined;
  }
}

/** Delete a stored secret. */
export function clearSecret(name: string): void {
  const secrets = readSecrets();
  delete secrets[name];
  writeSecrets(secrets);
}

/** Check if a secret is stored. */
export function hasSecret(name: string): boolean {
  return name in readSecrets();
}

/**
 * Resolve all {{secret:name}} placeholders in an env object.
 * Returns the resolved values + a list of missing secret names.
 */
export function resolveSecrets(
  values: Record<string, string>,
): { resolved: Record<string, string>; missing: string[] } {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  const placeholderRe = /^\{\{secret:([^}]+)\}\}$/;

  for (const [key, value] of Object.entries(values)) {
    const match = value.match(placeholderRe);
    if (match) {
      const secretName = match[1];
      const secretValue = getSecret(secretName);
      if (secretValue !== undefined) {
        resolved[key] = secretValue;
      } else {
        missing.push(secretName);
      }
    } else {
      resolved[key] = value; // inline — pass through
    }
  }

  return { resolved, missing };
}

/**
 * Resolve placeholders in an args array.
 */
export function resolveArgsSecrets(
  args: string[],
): { resolved: string[]; missing: string[] } {
  const resolved: string[] = [];
  const missing: string[] = [];
  const placeholderRe = /^\{\{secret:([^}]+)\}\}$/;

  for (const arg of args) {
    const match = arg.match(placeholderRe);
    if (match) {
      const secretName = match[1];
      const secretValue = getSecret(secretName);
      if (secretValue !== undefined) {
        resolved.push(secretValue);
      } else {
        missing.push(secretName);
        resolved.push(arg);
      }
    } else {
      resolved.push(arg);
    }
  }

  return { resolved, missing };
}
