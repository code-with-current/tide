/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/message/parts/JustificationBlock.tsx.
 *  Adaptation: upstream reads `chatRenderMode` from its UI store; per ruling 6
 *  that becomes a prop (default 'sorted', matching MessageBody's seam).
 *  `Part` becomes `TimelinePart`; `ContentChangeReason` comes from ../types.
 *  Otherwise ported faithfully (re-indented 4-space to 2-space). */

import React from 'react';
import type { TimelinePart } from '../../types/message-parts';
import type { ContentChangeReason } from '../types';
import { ReasoningTimelineBlock } from './reasoning-part';

type PartWithText = TimelinePart & { text?: string; content?: string; time?: { start?: number; end?: number } };

const cleanJustificationText = (text: string): string => {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return '';
  }

  return text
    .split('\n')
    .map((line: string) => line.replace(/^>\s?/, '').trimEnd())
    .filter((line: string) => line.trim().length > 0)
    .join('\n')
    .trim();
};

interface JustificationBlockProps {
  part: TimelinePart;
  messageId: string;
  onContentChange?: (reason?: ContentChangeReason) => void;
  actions?: React.ReactNode;
  chatRenderMode?: 'sorted' | 'live';
}

const JustificationBlock: React.FC<JustificationBlockProps> = ({
  part,
  messageId,
  onContentChange,
  actions,
  chatRenderMode = 'live',
}) => {
  const partWithText = part as PartWithText;
  const rawText = partWithText.text || partWithText.content || '';
  const textContent = React.useMemo(() => cleanJustificationText(rawText), [rawText]);
  const time = partWithText.time;

  // Don't render if there's no text content
  if (!textContent || textContent.trim().length === 0) {
    return null;
  }

  return (
    <ReasoningTimelineBlock
      text={textContent}
      variant="justification"
      onContentChange={onContentChange}
      blockId={part.id || `${messageId}-justification`}
      time={time}
      showDuration={chatRenderMode !== 'sorted'}
      actions={actions}
    />
  );
};

export default React.memo(JustificationBlock);
