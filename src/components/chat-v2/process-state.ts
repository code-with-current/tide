/** Pure open/closed derivation for the compact-mode process container.
 * Answer-gated: open while process streams, closes when the answer actively
 * streams, re-opens if process resumes after an answer stretch. The user's
 * click during a turn pins their choice (returned unchanged until reset). */
export interface ProcessOpenInput {
  streaming: boolean;
  hasProcess: boolean;
  answerActive: boolean;
  /** Phase of the most recent growth — distinguishes first-open from
   * re-open-after-answer without tracking timestamps. Accepted for
   * documentation; does not change the outcome (process-resumed turns have
   * answerActive: false, which opens). */
  lastPhase?: 'process' | 'answer';
  userPinned: boolean | null;
}

export function deriveProcessOpen(input: ProcessOpenInput): boolean {
  const { streaming, hasProcess, answerActive, userPinned } = input;
  if (userPinned !== null) return userPinned;
  if (!hasProcess) return false;
  if (!streaming) return false;
  return !answerActive;
}
