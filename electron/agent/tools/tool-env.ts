/**
 * Platform-aware shell + environment helpers for tool execution.
 *
 * macOS GUI apps inherit a minimal PATH. Version managers (nvm, fnm, asdf,
 * mise) inject their paths via shell init scripts (~/.zshrc, ~/.bashrc).
 * Custom env vars (JAVA_HOME, GOPATH, ANDROID_HOME, conda activation) also
 * live in these scripts.
 *
 * Solution: source the login shell ONCE at app startup, capture the full
 * environment, and reuse it for every tool call. This gives us:
 *   - All env vars from the user's shell config (1.7s cost paid once, not per-call)
 *   - Fast tool execution (~0.05s per call via /bin/sh)
 *
 * Used by: bash, background-shell, git, grep, and MCP stdio transports.
 */
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

/**
 * Capture the full environment from the user's login shell.
 * Runs once at module load (app startup). Sources ~/.zshrc, ~/.bashrc,
 * nvm, conda, etc. — capturing ALL env vars, not just PATH.
 */
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
  const shell = process.env.SHELL || '/bin/sh';
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

/**
 * Build the environment for tool subprocesses. Uses the captured login shell
 * env (all vars from ~/.zshrc: PATH, JAVA_HOME, GOPATH, conda, etc.) merged
 * with any extra overrides. Adds common PATH entries as a safety net.
 */
export function toolEnv(extra?: Record<string, string>): Record<string, string> {
  // Start with the captured shell environment (has all user customizations).
  const env = { ...captureShellEnv(), ...extra };

  if (process.platform === 'win32') {
    env.CI = env.CI ?? '1';
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

  const currentPath = (env.PATH ?? '').split(':');
  const allPaths = [...currentPath, ...EXTRA_PATHS_UNIX, ...safetyPaths];
  env.PATH = allPaths
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i) // dedupe
    .join(':');
  env.CI = env.CI ?? '1';

  return env as Record<string, string>;
}

/** The shell binary to use for command execution. */
export function toolShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return '/bin/sh';
}

/**
 * Wrap a command so it executes through the platform-appropriate shell.
 *
 * Returns `{ command, args }` suitable for `spawn(command, args, ...)`.
 *
 * On Unix: `/bin/sh -c "command args"` — fast (~0.05s startup).
 * Env vars (PATH, JAVA_HOME, GOPATH, conda, etc.) are provided by toolEnv(),
 * which captures them from the login shell at app startup.
 *
 * On Windows: `cmd.exe /c "command args"`.
 */
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

/**
 * Kill a process tree platform-aware. On Unix, sends a signal to the
 * process group (negative PID). On Windows, uses `taskkill /T /F` to
 * recursively kill the process tree.
 */
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
