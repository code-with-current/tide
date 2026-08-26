import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Electrobun launcher sets ELECTROBUN_INSTALL_ROOT_NAME per channel ("dev",
 * "stable", "canary"). Unset or empty means we're outside the shell (tests,
 * spike scripts) — must fail safe to the dev data dir, never production data.
 * Under the Electron shell the launcher env is absent, so fall back to
 * `process.defaultApp` (true only when the app is launched via `electron .`,
 * i.e. a dev build; packaged apps leave it undefined).
 */
export function isDevBuild(): boolean {
  // Node's Process type carries neither Electron extension (bun types), so probe structurally.
  const versions = process.versions as Record<string, string | undefined>;
  if (versions['electron']) return (process as { defaultApp?: boolean }).defaultApp === true;
  const channel = process.env['ELECTROBUN_INSTALL_ROOT_NAME'];
  return channel !== 'stable' && channel !== 'canary';
}

/** App version for MCP clientInfo etc. The Electron shell sets TIDE_APP_VERSION = app.getVersion() at boot; otherwise read package.json. */
export function appVersion(): string {
  const fromEnv = process.env['TIDE_APP_VERSION'];
  if (fromEnv) return fromEnv;
  try {
    return require('../../../package.json').version as string;
  } catch {
    return '0.0.0';
  }
}
