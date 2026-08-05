/** Strip leading `/command` and `@agent` tokens so a title reflects the task, not the invocation. Only leading tokens are stripped. */
export function stripCommandPrefix(msg: string): string {
  return msg
    .trim()
    // Strip leading attachment / @file link blocks ([/label/](target)) from the composer's display format.
    .replace(/(?:^|\n)\s*\[\/[^\]]*\/\]\([^)]*\)\s*/g, ' ')
    .replace(/^\/[A-Za-z0-9_-]+(?:\s+|$)/, '')
    .replace(/^@[A-Za-z0-9_-]+(?:\s+|$)/, '')
    .trim();
}
