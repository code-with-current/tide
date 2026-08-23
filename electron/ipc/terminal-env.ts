/** Host-private environment variables that must never leak into PTY shells.
 *  ARGV0 (AppImage/Electron) makes zsh rewrite argv[0] for every external
 *  command, breaking venv detection and other $0 consumers. NODE_CHANNEL_FD /
 *  ELECTRON_RUN_AS_NODE are Electron IPC artifacts invalid in a child shell.
 *  BASH_ENV / ENV / BASH_XTRACEFD would auto-source or trace arbitrary files
 *  in non-interactive shells. */
const STRIP = new Set([
  'ARGV0',
  'NODE_CHANNEL_FD',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'BASH_ENV',
  'ENV',
  'BASH_XTRACEFD',
]);

export function sanitizePtyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (STRIP.has(key) || value === undefined) continue;
    out[key] = value;
  }
  return out;
}
