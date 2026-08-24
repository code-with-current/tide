/**
 * Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/components/TurnActivity.tsx.
 * Near-verbatim pass-through wrapper around ProgressiveGroup. Import-path
 * rewrites only, plus: `ContentChangeReason` comes from the ported
 * `message/types` (upstream imports the type from its useChatAutoFollow hook);
 * the `onContentChange` prop is kept but only forwarded — Tide's auto-follow
 * hook is ResizeObserver-driven (T4 ruling, same seam as tool-part).
 * Named export per project convention instead of upstream's default export.
 */

import React from 'react';

import { ProgressiveGroup } from '../message/parts/progressive-group';
import type { TurnActivityRecord } from '../lib/turns/types';
import type { ToolPopupContent } from '../message/types';
import type { StreamPhase } from '../message/types';
import type { ContentChangeReason } from '../message/types';

interface DiffStats {
  additions: number;
  deletions: number;
  files: number;
}

interface TurnActivityProps {
  parts: TurnActivityRecord[];
  isExpanded: boolean;
  collapsedPreviewCount?: number;
  onToggle: () => void;
  isMobile: boolean;
  expandedTools: Set<string>;
  onToggleTool: (toolId: string) => void;
  onShowPopup: (content: ToolPopupContent) => void;
  onContentChange?: (reason?: ContentChangeReason) => void;
  streamPhase: StreamPhase;
  showHeader: boolean;
  animateRows?: boolean;
  animatedToolIds?: Set<string>;
  diffStats?: DiffStats;
  renderJustificationActions?: (activity: TurnActivityRecord) => React.ReactNode;
}

const TurnActivity: React.FC<TurnActivityProps> = (props) => {
  return <ProgressiveGroup {...props} />;
};

export const TurnActivityMemoized = React.memo(TurnActivity);
