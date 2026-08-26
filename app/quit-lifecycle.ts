/** Quit-time lifecycle (owed from the 3.3 review). Electrobun routes every
 *  quit through a synchronous quit-approval: the devkit's requestQuitApproval
 *  emits the before-quit event (native quit requests, SIGINT/SIGTERM,
 *  Utils.quit, process.exit, and Updater.applyUpdate all land here) and only
 *  then begins shutdown — quitGracefully gives handlers a 5s budget. The
 *  cleanup below is therefore fully synchronous and ordered:
 *
 *    1. abortAllTurns — persists aborted turns; the emissions it buffers
 *       ride the sink, which must still be alive.
 *    2. terminal dispose — kills PTY children while the sinks that would
 *       deliver their exit output still work.
 *    3. sink dispose — clears the flush interval and performs the final
 *       flush, the last durable write of the process.
 *
 *  Every step is idempotent, so repeated before-quit emissions (e.g. a
 *  cancelled applyUpdate approval followed by a real quit) are harmless.
 *  The handler never sets a response — it never vetoes a quit. */

import { app } from 'electrobun/main';
import { createLogger } from './core/logger.js';

const log = createLogger('quit-lifecycle');

export interface QuitLifecycleDeps {
  /** Orchestrator export: aborts + persists every active turn. */
  abortAllTurns: () => void;
  /** Terminal domain: kills all PTY sessions (3.4's terminalDispose). */
  disposeTerminals: () => void;
  /** Events domain sink: clear timer + final flush. */
  disposeSink: () => void;
}

export function registerQuitLifecycle(deps: QuitLifecycleDeps): () => void {
  const onBeforeQuit = () => {
    // Each step gets its own guard: a failure in one must not skip the rest,
    // and none of them may block shutdown.
    const steps: Array<[name: string, run: () => void]> = [
      ['abort-turns', deps.abortAllTurns],
      ['dispose-terminals', deps.disposeTerminals],
      ['dispose-sink', deps.disposeSink],
    ];
    for (const [name, run] of steps) {
      try {
        run();
        // Success-path breadcrumb: the updater's applyUpdate rides this path
        // during a version swap, where there is no other observable trace.
        log.info(`quit step ${name} ok`);
      } catch (e) {
        log.warn(`quit step ${name} failed`, { err: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  app.on('before-quit', onBeforeQuit);
  return onBeforeQuit;
}
