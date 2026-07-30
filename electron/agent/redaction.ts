/**
 * Secret blocklist + redaction for tool outputs (design doc §5.6).
 *
 * MVP scope: refuse files whose path looks like a secret. This catches the
 * common cases (`.env`, `id_rsa`, `*.pem`, `*.key`) without the complexity
 * of a regex content scanner. The full content-scanning layer is a
 * follow-up — it requires running on every tool result and deciding where
 * to draw the line on false positives.
 *
 * Refusal happens at the tool layer (the tool returns a `rejected` result)
 * rather than silently scrubbing — the model needs to know it can't have
 * the file so it can ask for a non-secret alternative.
 */

import * as path from 'path';

/** Returns true if the given path is on the secret blocklist. */
export function isSecretPath(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  const ext = path.extname(base).toLowerCase();

  // Exact-name secrets
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === 'credentials' || base === 'credentials.json') return true;
  if (base.startsWith('id_rsa') || base.startsWith('id_ecdsa') || base.startsWith('id_ed25519')) return true;
  if (base === 'htpasswd' || base === '.htpasswd') return true;
  if (base === '.npmrc' || base === '.pypirc' || base === '.netrc') return true;

  // Extension-based
  if (['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks'].includes(ext)) return true;

  return false;
}

/**
 * Minimal inline-content redaction. Pass any tool output through this before
 * returning it to the model. Currently a passthrough — kept as a hook so
 * every read tool calls it now, and a future regex scanner slots in here
 * without touching call sites.
 */
export function redact(content: string): string {
  // TODO: regex-based scanner for AWS keys (AKIA…), GitHub tokens (ghp_…),
  //       JWTs, generic high-entropy strings, private key headers. For now
  //       we rely on isSecretPath blocking the common files.
  return content;
}
