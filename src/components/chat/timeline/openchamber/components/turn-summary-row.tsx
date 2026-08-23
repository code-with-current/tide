import React from 'react';
import { Icon } from '../icon';
import { getMessagePreview } from '../message-preview';
import type { Turn, TurnChangedFile, TurnDiffStats } from '../lib/turns/types';

interface TurnSummaryRowProps {
  turn: Turn;
  diffStats?: TurnDiffStats;
  changedFiles?: TurnChangedFile[];
  expanded: boolean;
  onToggle: () => void;
}

/** Compact-view header for a finished turn: collapsed it IS the whole row,
 *  expanded it sits above the full turn content as the collapse affordance. */
export const TurnSummaryRow: React.FC<TurnSummaryRowProps> = React.memo(({
  turn,
  diffStats,
  changedFiles,
  expanded,
  onToggle,
}) => {
  const preview = getMessagePreview(turn.userMessage?.parts ?? [], 80);
  const fileCount = changedFiles?.length ?? diffStats?.files ?? 0;

  return (
    <button
      type="button"
      className="flex w-full items-center gap-1.5 border-t border-border/20 px-2 py-1.5 text-left typography-ui-label text-muted-foreground outline-hidden select-none hover:bg-interactive-hover"
      onClick={onToggle}
    >
      <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-foreground/80">{preview}</span>
      {diffStats && (
        <span className="shrink-0 tabular-nums">
          <span style={{ color: 'var(--status-success)' }}>+{diffStats.additions}</span>{' '}
          <span style={{ color: 'var(--status-error)' }}>−{diffStats.deletions}</span>
        </span>
      )}
      {fileCount > 0 && (
        <span className="shrink-0 tabular-nums text-muted-foreground/80">
          {fileCount} {fileCount === 1 ? 'file' : 'files'}
        </span>
      )}
    </button>
  );
});

TurnSummaryRow.displayName = 'TurnSummaryRow';
