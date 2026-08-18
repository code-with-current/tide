/** Push-based git change detection for the Git Panel.
 *
 * The renderer's gitStatus query only refetches on invalidation (agent git
 * tools, manual actions) — edits made outside Tide (editor, terminal, another
 * app) were invisible until the 60s staleTime elapsed. This watcher observes
 * the working tree and broadcasts `tide:gitChanged` so the renderer can
 * refetch immediately.
 *
 * Uses recursive fs.watch where supported (macOS FSEvents / Windows). Linux
 * doesn't support recursive watch, so it falls back to polling
 * `git status --porcelain` and emitting only when the output changes.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
import { toolEnv } from '../agent/tools/tool-env';

interface WatchEntry {
  root: string;
  close: () => void;
}

const watchers = new Map<string, WatchEntry>();
const WATCH_DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 2500;

function emit(workspaceId: string) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('tide:gitChanged', { workspaceId });
  }
}

function porcelainSnapshot(root: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain'], { cwd: root, env: toolEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

export function startGitWatcher(workspaceId: string, root: string) {
  const existing = watchers.get(workspaceId);
  if (existing) {
    if (existing.root === root) return;
    existing.close();
  }

  let debounce: NodeJS.Timeout | undefined;
  const scheduleEmit = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      emit(workspaceId);
    }, WATCH_DEBOUNCE_MS);
  };

  let closed = false;
  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (closed) return;
      // Git-internal churn that never affects `git status` output shown in the panel.
      const f = String(filename ?? '');
      if (f.endsWith('.lock') || f.startsWith('.git/COMMIT_EDITMSG')) return;
      scheduleEmit();
    });
    watchers.set(workspaceId, {
      root,
      close: () => {
        closed = true;
        clearTimeout(debounce);
        watcher.close();
      },
    });
  } catch {
    // Linux: recursive watch unsupported (ERR_FEATURE_UNUSABLE) — poll instead.
    let last: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    const poll = async () => {
      if (closed) return;
      const snap = await porcelainSnapshot(root);
      if (closed) return;
      if (last !== null && snap !== last) emit(workspaceId);
      last = snap;
      if (!closed) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    void poll();
    watchers.set(workspaceId, {
      root,
      close: () => {
        closed = true;
        clearTimeout(timer);
      },
    });
  }
}
