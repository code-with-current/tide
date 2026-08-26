import { describe, expect, it } from 'vitest';
import { stopReasonToSound } from '@/lib/sounds';

describe('stopReasonToSound', () => {
  it('stays silent for user-initiated aborts', () => {
    expect(stopReasonToSound('aborted')).toBeNull();
  });

  it('maps failure stop reasons to the error sound', () => {
    for (const reason of [
      'refusal',
      'max_tokens',
      'iteration_limit',
      'content_filter',
      'spend_cap',
      'permission_timeout',
    ] as const) {
      expect(stopReasonToSound(reason)).toBe('error');
    }
  });

  it('maps normal endings to the done sound', () => {
    for (const reason of ['end_turn', 'tool_use', 'pause_turn'] as const) {
      expect(stopReasonToSound(reason)).toBe('done');
    }
  });
});
