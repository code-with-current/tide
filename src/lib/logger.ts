/** Renderer logger — forwards to the main process via the `tide:log` IPC, mirroring the main-process createLogger API. Falls back to console in non-Electron contexts. */

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

import { sendLog } from './api/client';

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
    try {
      sendLog(level, tag, msg, args.length > 0 ? args : undefined);
    } catch {
      /* IPC not ready — fall through to console */
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
