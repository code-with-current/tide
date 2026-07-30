/**
 * Compaction settings — when/how the agent layer summarizes older
 * conversation to stay under the model's context window. Lives in
 * config.json under `compaction`; editable from Settings → Agent.
 *
 * See docs/plans/2026-07-22-vercel-ai-sdk-migration-design.md Section 8.
 */
export interface CompactionSettings {
  /** Master switch. When false, long sessions eventually hit the context wall. */
  enabled: boolean;
  /** Fraction of context window that triggers compaction. Range [0.5, 0.95]. */
  threshold: number;
  /** Number of user/assistant pairs preserved verbatim at the tail. */
  keepRecentTurns: number;
  /** What to do if the compaction step itself fails. */
  onFailure: 'truncate' | 'fail' | 'warn';
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  threshold: 0.75,
  keepRecentTurns: 3,
  onFailure: 'truncate',
};

/**
 * Clamp/repair a settings object. Used at load time and when the user
 * edits the Settings panel — prevents bad values from reaching the
 * compaction loop. Returns a new object; input is not mutated.
 */
export function validateCompactionSettings(input: Partial<CompactionSettings> | undefined): CompactionSettings {
  const out: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...input };
  if (typeof out.threshold !== 'number' || !Number.isFinite(out.threshold)) {
    out.threshold = DEFAULT_COMPACTION_SETTINGS.threshold;
  }
  out.threshold = Math.min(0.95, Math.max(0.5, out.threshold));
  if (typeof out.keepRecentTurns !== 'number' || !Number.isFinite(out.keepRecentTurns)) {
    out.keepRecentTurns = DEFAULT_COMPACTION_SETTINGS.keepRecentTurns;
  }
  out.keepRecentTurns = Math.max(1, Math.floor(out.keepRecentTurns));
  if (out.onFailure !== 'truncate' && out.onFailure !== 'fail' && out.onFailure !== 'warn') {
    out.onFailure = DEFAULT_COMPACTION_SETTINGS.onFailure;
  }
  if (typeof out.enabled !== 'boolean') out.enabled = DEFAULT_COMPACTION_SETTINGS.enabled;
  return out;
}
