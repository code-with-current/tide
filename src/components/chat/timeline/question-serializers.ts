/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/questionSerializers.ts — ADAPTED (Ruling 3).
 *  Upstream parses OpenCode's multi-question `QuestionRequest` shape
 *  (`{ id, sessionID, questions: [{ header, question, multiple, options }] }`).
 *  Tide's `ask_followup_question` tool emits ONE question:
 *  `{ question: string, options: [{ label, description? }] (max 4), multiple: boolean }`
 *  (electron/agent/tools/ask-followup.ts). The serializers are rewritten for that
 *  shape — output contract (markdown + stable JSON strings for the card's copy
 *  buttons) is preserved; `header` no longer exists so the question text is the
 *  markdown heading, and the JSON envelope is flat. */

export interface FollowupQuestionOption {
  label: string;
  description?: string;
}

export interface FollowupQuestionPayload {
  question: string;
  options: FollowupQuestionOption[];
  multiple: boolean;
}

/**
 * Render a followup question as Markdown the user can paste into another
 * tool (chat with a companion model, issue tracker, doc, etc.).
 *
 * Layout:
 *   ## <question>
 *
 *   _Select all that apply._   (only when multiple)
 *
 *   - **<label>** — <description>   (description elided when blank)
 */
export function serializeQuestionAsMarkdown(payload: FollowupQuestionPayload): string {
  const lines: string[] = [];
  lines.push(`## ${payload.question}`);
  lines.push('');
  if (payload.multiple) {
    lines.push('_Select all that apply._');
    lines.push('');
  }
  payload.options.forEach((option) => {
    const label = option.label;
    const description = option.description?.trim();
    lines.push(description ? `- **${label}** — ${description}` : `- **${label}**`);
  });
  return lines.join('\n').trimEnd();
}

/**
 * Render a followup question as a stable JSON envelope. `description` is
 * normalised to `null` when absent so consumers do not have to distinguish
 * `undefined` from a missing key. Tool-call routing fields (`toolCallId`)
 * stay out of the envelope — they are local concerns, not content.
 */
export function serializeQuestionAsJson(payload: FollowupQuestionPayload): string {
  const normalized: { question: string; multiple: boolean; options: Array<{ label: string; description: string | null }> } = {
    question: payload.question,
    multiple: Boolean(payload.multiple),
    options: payload.options.map((option) => ({
      label: option.label,
      description: option.description ?? null,
    })),
  };
  return JSON.stringify(normalized, null, 2);
}
