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
