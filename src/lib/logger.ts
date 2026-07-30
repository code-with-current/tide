/**
 * Renderer-side logger — forwards to the main process's central log file
 * via the tide:log IPC. Mirrors the main-process createLogger API so the
 * two sides are symmetric.
 *
 * Usage:
 *   import { createLogger } from '@/lib/logger';
 *   const log = createLogger('streamReducer');
 *   log.warn('stream error', { sessionId });
 *
 * In non-Electron contexts (tests, SSR) it falls back to console.
 */

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ipc = typeof window !== 'undefined' ? (window as unknown as { tideIpc?: { log?: { send: (level: string, tag: string, msg: string, args?: unknown[]) => void } } }).tideIpc : undefined;

export interface RendererLogger {
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

/** Create a renderer logger that forwards to the main log file. */
export function createLogger(tag: string): RendererLogger {
  const send = (level: LogLevel) => (msg: string, ...args: unknown[]) => {
    // Forward to main (fire-and-forget — logging must never block the renderer).
    if (ipc?.log) {
      try {
        ipc.log.send(level, tag, msg, args.length > 0 ? args : undefined);
      } catch {
        /* IPC not ready — fall through to console */
      }
    }
    // Mirror to devtools console so renderer output is visible during dev.
    const line = `[${tag}] ${msg}`;
    switch (level) {
      case 'error': console.error(line, ...args); break;
      case 'warn': console.warn(line, ...args); break;
      default: console.log(line, ...args);
    }
  };
  return {
    error: send('error'),
    warn: send('warn'),
    info: send('info'),
    debug: send('debug'),
  };
}
