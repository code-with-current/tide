/** Platform-aware shell + environment helpers: source the login shell once at startup to capture full env (PATH, JAVA_HOME, etc.), then reuse it for fast tool subprocess execution. */
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/** Paths commonly used by version managers and package managers. */
const EXTRA_PATHS_UNIX = [
  '/usr/local/bin', '/usr/local/sbin',
  '/opt/homebrew/bin', '/opt/homebrew/sbin',
  '/opt/homebrew/lib/bin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
];

/** Capture the full environment from the user's login shell (runs once at module load). */
let resolvedShellEnv: Record<string, string> | null = null;

function captureShellEnv(): Record<string, string> {
  if (resolvedShellEnv) return resolvedShellEnv;

  if (process.platform === 'win32') {
    // Windows: no login shell concept; use process.env as-is.
    resolvedShellEnv = { ...process.env } as Record<string, string>;
    return resolvedShellEnv;
  }

  // Unix: source the login shell and capture `env` output.
  // This runs nvm/fnm/conda/asdf init, oh-my-zsh (in non-interactive mode),
  // and any custom exports the user has in their shell config.
  const shell = process.env['SHELL'] || '/bin/sh';
  try {
    // Use non-interactive login shell (-l) to source profile + rc files.
    // Timeout: 10s max — if the shell hangs, fall back to process.env.
    const output = execSync(
      `${shell} -l -c 'env'`,
      { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const env: Record<string, string> = {};
    for (const line of output.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.slice(0, idx);
        const value = line.slice(idx + 1);
        env[key] = value;
      }
    }
    resolvedShellEnv = env;
  } catch {
    // Shell failed or timed out — fall back to process.env + PATH augmentation.
    resolvedShellEnv = { ...process.env } as Record<string, string>;
  }

  return resolvedShellEnv;
}

// Capture at module load (app startup). The 1-2s cost is paid once.
captureShellEnv();

/** Build the tool subprocess environment: captured shell env merged with overrides and PATH safety-net entries. */
export function toolEnv(extra?: Record<string, string>): Record<string, string> {
  // Start with the captured shell environment (has all user customizations).
  const env = { ...captureShellEnv(), ...extra };

  if (process.platform === 'win32') {
    env['CI'] = env['CI'] ?? '1';
    return env as Record<string, string>;
  }

  // Augment PATH with common binary locations as a safety net in case
  // the shell capture missed something.
  const home = os.homedir();
  const safetyPaths = [
    path.join(home, '.local', 'bin'),
    '/opt/local/bin',
    '/opt/local/sbin',
  ];

  const currentPath = (env['PATH'] ?? '').split(':');
  const allPaths = [...currentPath, ...EXTRA_PATHS_UNIX, ...safetyPaths];
  env['PATH'] = allPaths
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i) // dedupe
    .join(':');
  env['CI'] = env['CI'] ?? '1';

  return env as Record<string, string>;
}

/** The shell binary to use for command execution. */
export function toolShell(): string {
  if (process.platform === 'win32') return process.env['ComSpec'] || 'cmd.exe';
  return '/bin/sh';
}

/** Wrap a command to execute through the platform shell: `/bin/sh -c` on Unix, `cmd.exe /c` on Windows. */
export function wrapWithShell(
  command: string,
  args: string[] = [],
): { command: string; args: string[] } {
  const fullCommand = `${command} ${args.join(' ')}`;

  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/c', fullCommand] };
  }

  // Fast POSIX shell — toolEnv() provides the full resolved environment.
  return {
    command: '/bin/sh',
    args: ['-c', fullCommand],
  };
}

/** Kill a process tree: signal the process group (Unix) or `taskkill /T /F` (Windows). */
export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch { /* already dead */ }
  } else {
    try { process.kill(-pid, signal); } catch { /* already dead */ }
  }
}
