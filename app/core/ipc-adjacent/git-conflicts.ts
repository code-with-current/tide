/** Pure parser for `git status --porcelain` conflict entries.
 *
 *  The caller runs `git status --porcelain -z`: records are NUL-delimited
 *  and paths are emitted raw — no C-style quoting to strip, so paths with
 *  spaces or non-ASCII bytes pass through verbatim. Non-conflict records
 *  (including `RR` rename/rename) are ignored: only the seven unmerged
 *  statuses are surfaced. */

export type ConflictState =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them';

export interface ConflictEntry {
  path: string;
  state: ConflictState;
}

const CONFLICT_STATES: Record<string, ConflictState> = {
  UU: 'both-modified',
  AA: 'both-added',
  DD: 'both-deleted',
  AU: 'added-by-us',
  UA: 'added-by-them',
  DU: 'deleted-by-us',
  UD: 'deleted-by-them',
};

export function parseConflictEntries(porcelainOutput: string): ConflictEntry[] {
  const entries: ConflictEntry[] = [];
  for (const record of porcelainOutput.split('\0')) {
    if (record.length < 4) continue;
    const state = CONFLICT_STATES[record.slice(0, 2)];
    if (!state) continue;
    entries.push({ path: record.slice(3), state });
  }
  return entries;
}
