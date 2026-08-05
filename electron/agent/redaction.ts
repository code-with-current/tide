/** Secret blocklist + redaction for tool outputs (design doc §5.6): MVP refuses files whose path looks like a secret (.env, id_rsa, *.pem, *.key, …) at the tool layer so the model knows it can't have the file. Content scanning is a follow-up. */

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

/** Minimal inline-content redaction (currently passthrough). Hook every read tool through it now so a future regex scanner slots in here without touching call sites. */
export function redact(content: string): string {
  // TODO: regex-based scanner for AWS keys (AKIA…), GitHub tokens (ghp_…),
  //       JWTs, generic high-entropy strings, private key headers. For now
  //       we rely on isSecretPath blocking the common files.
  return content;
}
