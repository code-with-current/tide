/**
 * Strip leading slash-command (`/skill ...`) and @agent (`@agent ...`) tokens
 * from a message so a session title reflects the task, not the invocation.
 *
 * Used two ways:
 *   1. Immediate placeholder title at session creation — locally stripped,
 *      zero latency, so the sidebar never shows the raw `/command` text.
 *   2. Input to the LLM title generator — the model summarizes the subject,
 *      not the command name.
 *
 * Only leading tokens are stripped; a `/` or `@` mid-message is left alone.
 * If the message was only the command (no subject), returns '' and callers
 * fall back to the raw text.
 */
export function stripCommandPrefix(msg: string): string {
  return msg
    .trim()
    .replace(/^\/[A-Za-z0-9_-]+(?:\s+|$)/, '')
    .replace(/^@[A-Za-z0-9_-]+(?:\s+|$)/, '')
    .trim();
}
