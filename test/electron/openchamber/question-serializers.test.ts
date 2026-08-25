/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/__tests__/questionSerializers.test.ts — ADAPTED.
 *  bun:test → vitest; fixtures rewritten for Tide's single-question ask_followup_question
 *  shape ({ question, options: [{label, description?}], multiple }) per Ruling 3 — no
 *  header field, flat JSON envelope. */
import { describe, test, expect } from 'vitest';
import {
  serializeQuestionAsJson,
  serializeQuestionAsMarkdown,
  type FollowupQuestionPayload,
} from '../../../src/components/chat/timeline/question-serializers';

function makePayload(overrides: Partial<FollowupQuestionPayload> & { question: string }): FollowupQuestionPayload {
  return {
    options: [],
    multiple: false,
    ...overrides,
  };
}

describe('serializeQuestionAsMarkdown', () => {
  test('renders the question as heading and labelled options', () => {
    const md = serializeQuestionAsMarkdown(
      makePayload({
        question: 'Which mode should we use?',
        options: [{ label: 'safe', description: 'Default' }, { label: 'aggressive' }],
      }),
    );
    expect(md.startsWith('## Which mode should we use?')).toBe(true);
    expect(md.includes('- **safe** — Default')).toBe(true);
    expect(md.includes('- **aggressive**')).toBe(true);
    expect(md.includes(' — ')).toBe(true);
  });

  test('emits multi-select hint only when multiple is true', () => {
    const single = serializeQuestionAsMarkdown(makePayload({ question: 'pick', options: [{ label: 'a' }] }));
    const multi = serializeQuestionAsMarkdown(
      makePayload({ question: 'pick', multiple: true, options: [{ label: 'a' }] }),
    );
    expect(single.includes('_Select all that apply._')).toBe(false);
    expect(multi.includes('_Select all that apply._')).toBe(true);
  });

  test('elides description when it is blank or whitespace', () => {
    const md = serializeQuestionAsMarkdown(
      makePayload({
        question: 'q?',
        options: [{ label: 'x', description: '   ' }, { label: 'y', description: '' }],
      }),
    );
    expect(md.includes('- **x**\n')).toBe(true);
    expect(md.includes('- **y**')).toBe(true);
    expect(md.includes(' — ')).toBe(false);
  });

  test('returns trimmed output (no trailing blank line)', () => {
    const md = serializeQuestionAsMarkdown(makePayload({ question: 'q?', options: [{ label: 'a' }] }));
    expect(md.endsWith('\n')).toBe(false);
    expect(md.endsWith('- **a**')).toBe(true);
  });

  test('handles zero options', () => {
    const md = serializeQuestionAsMarkdown(makePayload({ question: 'free?' }));
    expect(md.includes('## free?')).toBe(true);
  });
});

describe('serializeQuestionAsJson', () => {
  test('produces canonical envelope preserving description strings', () => {
    const json = serializeQuestionAsJson(
      makePayload({
        question: 'pick?',
        options: [{ label: 'a', description: 'A desc' }, { label: 'b' }],
      }),
    );
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      question: 'pick?',
      multiple: false,
      options: [
        { label: 'a', description: 'A desc' },
        { label: 'b', description: null },
      ],
    });
  });

  test('preserves multiple flag', () => {
    const parsed = JSON.parse(serializeQuestionAsJson(makePayload({ question: 'q?', multiple: true })));
    expect(parsed.multiple).toBe(true);
  });
});
