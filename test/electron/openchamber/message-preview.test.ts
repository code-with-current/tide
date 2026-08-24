/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/lib/messagePreview.test.ts.
 *  bun:test → vitest; `Part` → vendored `OcPart`. Logic unchanged. */
import { describe, expect, test } from 'vitest';
import type { OcPart } from '../../../src/components/chat/timeline/openchamber/types/opencode-parts';
import {
  getFullText,
  getMessagePreview,
} from '../../../src/components/chat/timeline/openchamber/message-preview';

const textPart = (text: string): OcPart => ({ type: 'text', text } as OcPart);

describe('messagePreview', () => {
  test('joins text parts for full text', () => {
    expect(getFullText([textPart('hello'), textPart('world')])).toBe('hello\nworld');
  });

  test('collapses newlines and truncates previews', () => {
    expect(getMessagePreview([textPart('line one\nline two')], 80)).toBe('line one line two');
    expect(getMessagePreview([textPart('abcdefghijklmnopqrstuvwxyz')], 10)).toBe('abcdefghij…');
  });

  test('returns empty string when there is no text', () => {
    expect(getMessagePreview([])).toBe('');
    expect(getFullText([{ type: 'file' } as OcPart])).toBe('');
  });
});
