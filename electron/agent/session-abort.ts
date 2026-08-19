/** Session-scoped abort registry. Turn signals die with their turn;
 *  background dispatches must survive turn end but die with the session —
 *  they attach to these controllers instead of the turn's signal. */
const controllers = new Map<string, AbortController>();

export function sessionSignal(sessionId: string): AbortSignal {
  let c = controllers.get(sessionId);
  if (!c || c.signal.aborted) {
    c = new AbortController();
    controllers.set(sessionId, c);
  }
  return c.signal;
}

export function abortSession(sessionId: string): void {
  controllers.get(sessionId)?.abort();
  controllers.delete(sessionId);
}

export function releaseSession(sessionId: string): void {
  controllers.delete(sessionId);
}

export function abortAllSessions(): void {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
}
