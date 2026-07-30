import { describe, it, expect } from 'vitest';
import { DEFAULT_COMPACTION_SETTINGS, validateCompactionSettings, type CompactionSettings } from '../compaction';

describe('CompactionSettings', () => {
  it('exports a default with the documented shape', () => {
    expect(DEFAULT_COMPACTION_SETTINGS).toEqual({
      enabled: true,
      threshold: 0.75,
      keepRecentTurns: 3,
      onFailure: 'truncate',
    });
  });

  it('validates a well-formed settings object', () => {
    const s: CompactionSettings = { enabled: true, threshold: 0.8, keepRecentTurns: 5, onFailure: 'fail' };
    expect(validateCompactionSettings(s)).toEqual(s);
  });

  it('clamps threshold into [0.5, 0.95]', () => {
    expect(validateCompactionSettings({ ...DEFAULT_COMPACTION_SETTINGS, threshold: 0.1 }).threshold).toBe(0.5);
    expect(validateCompactionSettings({ ...DEFAULT_COMPACTION_SETTINGS, threshold: 1.2 }).threshold).toBe(0.95);
  });

  it('clamps keepRecentTurns to >= 1', () => {
    expect(validateCompactionSettings({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTurns: 0 }).keepRecentTurns).toBe(1);
  });

  it('rejects unknown onFailure values, falling back to default', () => {
    expect(validateCompactionSettings({ ...DEFAULT_COMPACTION_SETTINGS, onFailure: 'bogus' as any }).onFailure).toBe('truncate');
  });

  it('returns the full default when input is undefined', () => {
    expect(validateCompactionSettings(undefined)).toEqual(DEFAULT_COMPACTION_SETTINGS);
  });

  it('fills missing fields from defaults when given a partial', () => {
    const out = validateCompactionSettings({ threshold: 0.6 });
    expect(out).toEqual({ ...DEFAULT_COMPACTION_SETTINGS, threshold: 0.6 });
  });

  it('falls back to default threshold when given NaN or non-numeric', () => {
    expect(validateCompactionSettings({ ...DEFAULT_COMPACTION_SETTINGS, threshold: NaN }).threshold).toBe(0.75);
    expect(validateCompactionSettings({ ...DEFAULT_COMPACTION_SETTINGS, threshold: 'oops' as any }).threshold).toBe(0.75);
  });
});
