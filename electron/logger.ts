/** Tide logging system: structured, leveled, file-backed (no external deps). Each call writes to both the log file (sync, survives crashes) and the console. Rotates at 5MB (one .old backup) and installs global error handlers. */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface Logger {
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

// ── Module state (set once by initLogger) ──────────────────────────────

let logFile: string | null = null;
let minLevel: LogLevel = 'info';

/** Rotate when the log exceeds 5 MB. One .old backup is kept. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** True once initLogger has run. Before that, logs are console-only. */
let initialized = false;

// ── Internal write ─────────────────────────────────────────────────────

// ── ANSI color codes (for console mirror only — file stays plain) ──────
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
};

/** Level → { ansi color, console method } */
const LEVEL_STYLE: Record<LogLevel, { color: string; method: 'error' | 'warn' | 'log' }> = {
  error: { color: C.red, method: 'error' },
  warn: { color: C.yellow, method: 'warn' },
  info: { color: C.green, method: 'log' },
  debug: { color: C.gray, method: 'log' },
};

/** Format a log line: ISO timestamp + level + tag + message + optional args JSON. */
function formatLine(level: LogLevel, tag: string, msg: string, args: unknown[]): string {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] [${tag}] ${msg}`;
  if (args.length === 0) return base;
  const serialized = args
    .map((a) => {
      if (a instanceof Error) return JSON.stringify({ message: a.message, stack: a.stack });
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');
  return `${base} ${serialized}`;
}

/** Format a COLORIZED line for the terminal (ANSI codes — NOT for file output). */
function formatLineColored(level: LogLevel, tag: string, msg: string, args: unknown[]): string {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const style = LEVEL_STYLE[level];
  const levelStr = `${style.color}${level.toUpperCase().padEnd(5)}${C.reset}`;
  const tagStr = `${C.cyan}${tag}${C.reset}`;
  const tsStr = `${C.dim}${ts}${C.reset}`;
  let line = `${tsStr} ${levelStr} ${tagStr} ${msg}`;
  if (args.length > 0) {
    const serialized = args
      .map((a) => {
        if (a instanceof Error) return JSON.stringify({ message: a.message, stack: a.stack });
        if (typeof a === 'object' && a !== null) {
          try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
      })
      .join(' ');
    line += ` ${C.dim}${serialized}${C.reset}`;
  }
  return line;
}

/** Mirror a COLORIZED line to the appropriate console method. */
function consoleMirror(level: LogLevel, tag: string, msg: string, args: unknown[]): void {
  const line = formatLineColored(level, tag, msg, args);
  const method = LEVEL_STYLE[level].method;
  console[method](line);
}

/** Rotate the log file if it has grown too large. Best-effort. */
function rotateIfNeeded(): void {
  if (!logFile) return;
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > MAX_LOG_BYTES) {
      const backup = `${logFile}.old`;
      try {
        // Remove an existing .old first (only one backup kept).
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
        fs.renameSync(logFile, backup);
      } catch {
        // Rename failed — keep writing to the current file rather than dropping logs.
      }
    }
  } catch {
    // Stat failed (file vanished?) — non-fatal; the append below recreates it.
  }
}

/** Core write: level-filter, format, mirror to console (colored), append to file (plain). */
function write(level: LogLevel, tag: string, msg: string, args: unknown[]): void {
  // Level filter — drop anything below the configured minimum.
  if (LEVEL_ORDER[level] > LEVEL_ORDER[minLevel]) return;

  // Console: colorized (ANSI). File: plain (no escape codes — keeps it grep-clean).
  consoleMirror(level, tag, msg, args);

  if (logFile) {
    try {
      const plainLine = formatLine(level, tag, msg, args);
      rotateIfNeeded();
      fs.appendFileSync(logFile, plainLine + '\n', 'utf8');
    } catch {
      // File write failed (disk full, permissions). The console mirror already
      // captured it. Don't throw (logging must never crash the app).
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/** Create a namespaced logger. The tag prefixes every line. */
export function createLogger(tag: string): Logger {
  return {
    error: (msg, ...args) => write('error', tag, msg, args),
    warn: (msg, ...args) => write('warn', tag, msg, args),
    info: (msg, ...args) => write('info', tag, msg, args),
    debug: (msg, ...args) => write('debug', tag, msg, args),
  };
}

/** Initialize logging once after userData resolves; idempotent. `logDir` holds tide.log, `level` defaults to 'debug' (dev) / 'info' (prod). */
export function initLogger(logDir: string, level?: LogLevel): void {
  if (initialized) return;
  initialized = true;

  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'tide.log');
  } catch {
    // Can't create the log dir — fall back to console-only. initLogger must
    // never throw (it runs on the app's boot critical path).
    logFile = null;
  }

  minLevel = level ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

  const log = createLogger('logger');
  log.info('logging initialized', { logFile: logFile ?? 'console-only', level: minLevel });

  // ── Global error capture ────────────────────────────────────────────
  // These are the highest-value handlers — without them, silent crashes
  // leave zero diagnostic record. Log the error (sync flush to file), then
  // let Electron's default crash behavior proceed (don't swallow).
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', reason);
  });
}

/** Runtime level override (for a future settings toggle or env var). */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** Forward a renderer log line (via IPC `tide:log`) to the central file; unknown levels are dropped. */
export function forwardLog(level: string, tag: string, msg: string, args?: unknown[]): void {
  if (level in LEVEL_ORDER) {
    write(level as LogLevel, tag, msg, args ?? []);
  }
}
