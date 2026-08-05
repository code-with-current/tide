/** ask_followup_question tool: model emits a structured question; the renderer surfaces an interactive picker and the model's turn pauses until the user answers. */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';
import { waitForFollowupPick } from '../followup-resolver';

interface FollowupOption {
  label: string;
  description?: string;
}

/** Shared body — normalizes the two accepted option shapes and renders the question for the model + UI. No ctx dependency. `_multiple` is accepted but unused by the echo path; Phase 3 Task 3.3 (the awaiting execute) consumes it for single- vs multi-select. Underscored to satisfy noUnusedParameters. */
export async function runAskFollowup(
  question: string,
  options: unknown[],
  _multiple: boolean,
): Promise<ToolResult> {
  if (!question) return { status: 'failed', output: 'Missing required arg: question' };
  // Normalize options: accept [{label, description}] (canonical) or ["str"] (legacy/forgiving).
  // Plain-string options get wrapped so downstream rendering never sees `undefined`.
  const opts: FollowupOption[] = options.map((o: unknown) => {
    if (typeof o === 'string') return { label: o };
    if (o && typeof o === 'object') {
      const obj = o as Record<string, unknown>;
      const label = typeof obj.label === 'string' ? obj.label
        : typeof obj.value === 'string' ? obj.value
        : typeof obj.text === 'string' ? obj.text
        : String(o);
      const description = typeof obj.description === 'string' ? obj.description : undefined;
      return { label, description };
    }
    return { label: String(o) };
  });
  if (opts.length > 4) {
    return { status: 'failed', output: `Too many options (${opts.length}). Max 4 — narrow it down.` };
  }

  // Render a text version of the question for the model + UI.
  const optionText = opts.length > 0
    ? '\n\n' + opts.map((o, i) => {
        const desc = o.description ? ` — ${o.description}` : '';
        return `${i + 1}. ${o.label}${desc}`;
      }).join('\n')
    : '';

  const displayText = `**${question}**${optionText}`;

  return {
    status: 'executed',
    output: `Question surfaced to the user. Stop here and wait for their answer — do not proceed with an assumption.`,
    meta: opts.length > 0 ? `${opts.length} options` : 'open-ended',
    display: { kind: 'text', text: displayText },
  };
}

const followupOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

export const askFollowupTool: ToolRegistration = {
  name: 'ask_followup_question',
  definition: {
    name: 'ask_followup_question',
    description:
      'Ask the user a structured question when you need them to decide between concrete options. ' +
      'Use for approach selection, file-path choice, API-style decisions — not for every response. ' +
      'The user picks one option (or types a custom answer) and the turn resumes. Use sparingly: ' +
      'for a simple missing detail, just ask in plain text.\n\n' +
      'FORMAT REQUIREMENT — options MUST be an array of objects with a `label` field:\n' +
      '  options: [{ "label": "Approach A", "description": "optional one-liner" }, ...]\n' +
      'Plain strings (["A", "B"]) are REJECTED. Max 4 options.\n\n' +
      'IMPORTANT: When you call this tool, DO NOT also write the question or options as text, ' +
      'Markdown, JSON blocks, or numbered lists. The tool call alone surfaces the popup — emitting ' +
      'a duplicate as prose causes the user to see the question twice. Either call this tool (no ' +
      'prose) OR ask in plain text (no tool call) — never both.\n\n' +
      'Stop emitting text after the tool call. The turn ends here; the user answers via the popup.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask.' },
        options: {
          type: 'array',
          description: 'Concrete options the user can pick from. Max 4. Each item MUST be an object with at least a `label` field — plain strings are rejected.',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short option label (one line).' },
              description: { type: 'string', description: 'Optional one-line context for this option.' },
            },
            required: ['label'],
          },
        },
        multiple: {
          type: 'boolean',
          description: 'True if the user can pick multiple options. Default false (single-select).',
        },
      },
      required: ['question'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 5_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, _ctx) =>
    runAskFollowup(
      String(args.question ?? ''),
      Array.isArray(args.options) ? args.options : [],
      Boolean(args.multiple),
    ),
};

// ─── SDK factory (Phase 3 Task 3.3) ───────────────────────────────────
// HITL execute: emits a `followup` event, then awaits the user's pick on followup-resolver. streamText pauses the step while this awaits; once the pick arrives (submitFollowup IPC handler), execute returns and the model continues with the answer in the tool_result. Aborting the turn resolves the pick as null → fallback.

export function createAskFollowupTool(ctx: ToolContext) {
  return tool({
    description:
      'Ask the user a structured question when you need them to decide between concrete options. ' +
      'Use for approach selection, file-path choice, API-style decisions — not for every response. ' +
      'The user picks one option (or types a custom answer) and the turn resumes. Use sparingly: ' +
      'for a simple missing detail, just ask in plain text. options MUST be an array of {label} ' +
      'objects (plain strings rejected); max 4. Do NOT also emit the question as prose.',
    inputSchema: z.object({
      question: z.string().describe('The question to ask.'),
      options: z.array(followupOptionSchema).min(1).max(4).optional().describe(
        'Concrete options the user can pick from. Max 4. Each item MUST be an object with a `label` field.',
      ),
      multiple: z.boolean().optional().describe('True if the user can pick multiple options. Default false.'),
    }),
    execute: async ({ question, options, multiple }, { toolCallId }) =>
      withPermission(ctx, 'ask_followup_question', { question, options, multiple }, async () => {
        // Normalize options to label strings for the popup.
        const labels = (options ?? []).map((o) => o.label);
        ctx.emit({
          type: 'followup',
          toolCallId,
          question,
          options: labels,
          multiple: Boolean(multiple),
        });
        const pick = await waitForFollowupPick(ctx.sessionId, toolCallId);
        const answered = pick.answer != null;
        return {
          status: (answered ? 'executed' : 'rejected') as ToolResult['status'],
          output: answered ? `User picked: ${pick.answer}` : 'User did not answer the question.',
          display: { kind: 'text' as const, text: answered ? `**${pick.answer}**` : '_(no answer)_' },
        } satisfies ToolResult;
      }),
  });
}
