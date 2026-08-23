/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/message/parts/AssistantTextPart.tsx.
 *  Adaptations: `streamPerfCount`/`streamPerfObserve` probes dropped (Task 2's
 *  convention — the stream-debug store is not ported); SDK `Part` → `OcPart`;
 *  `ContentChangeReason` from ../types; renderer/hook point at Tide's ported
 *  modules. Logic otherwise ported faithfully (re-indented 4-space to 2-space). */

import React from 'react';
import type { OcPart } from '../../types/opencode-parts';
import { MarkdownRenderer } from '../../markdown/markdown-renderer';
import type { StreamPhase, ToolPopupContent } from '../types';
import type { ContentChangeReason } from '../types';
import { useStreamingTextThrottle } from '../../hooks/use-streaming-text-throttle';
import { resolveAssistantDisplayText, shouldRenderAssistantText } from './assistant-text-visibility';
import { GeneratedJsonResultCard } from './generated-json-result-card';
import { parseGeneratedJsonResult } from './generated-json-result';

type PartWithText = OcPart & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

interface AssistantTextPartProps {
  part: OcPart;
  sessionId?: string;
  messageId: string;
  streamPhase: StreamPhase;
  chatRenderMode?: 'sorted' | 'live';
  onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;
  onShowPopup?: (content: ToolPopupContent) => void;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
  part,
  messageId,
  streamPhase,
  chatRenderMode = 'live',
  onShowPopup,
}) => {
  // Use part directly from props — parent provides the latest version from the store.
  // No store subscription here to avoid re-render cascade from unrelated delta events.
  const partWithText = part as PartWithText;
  const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
  const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
  const valueText = typeof partWithText.value === 'string' ? partWithText.value : '';
  const textContent = [rawText, contentText, valueText].reduce((best, candidate) => {
    return candidate.length > best.length ? candidate : best;
  }, '');
  const isStreamingPhase = streamPhase === 'streaming';
  const isCooldownPhase = streamPhase === 'cooldown';
  const isStreaming = chatRenderMode === 'live' && (isStreamingPhase || isCooldownPhase);

  const throttledTextContent = useStreamingTextThrottle({
    text: textContent,
    isStreaming,
    identityKey: `${messageId}:${part.id ?? 'text'}`,
  });

  const displayTextContent = resolveAssistantDisplayText({
    textContent,
    throttledTextContent,
    isStreaming,
  });

  const time = partWithText.time;
  const isFinalized = Boolean(time && typeof time.end !== 'undefined');

  const isRenderableTextPart = part.type === 'text' || part.type === 'reasoning';
  if (!isRenderableTextPart) {
    return null;
  }

  if (!shouldRenderAssistantText({
    displayTextContent,
    isFinalized,
  })) {
    return null;
  }

  const generatedResult = !isStreaming && isFinalized ? parseGeneratedJsonResult(displayTextContent) : null;
  if (generatedResult) {
    return (
      <div
        className={`group/assistant-text relative break-words ${chatRenderMode === 'live' ? 'my-1' : ''}`}
        key={part.id || `${messageId}-text`}
      >
        <GeneratedJsonResultCard result={generatedResult} />
      </div>
    );
  }

  return (
    <div
      className={`group/assistant-text relative break-words ${chatRenderMode === 'live' ? 'my-1' : ''}`}
      key={part.id || `${messageId}-text`}
    >
      <MarkdownRenderer
        content={displayTextContent}
        part={part}
        messageId={messageId}
        isAnimated={false}
        isStreaming={isStreaming}
        disableStreamAnimation={chatRenderMode === 'sorted'}
        variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
        enableFileReferences={isFinalized}
        onShowPopup={onShowPopup}
      />
    </div>
  );
};

export default React.memo(AssistantTextPart);
export { AssistantTextPart };
