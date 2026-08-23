/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/message/parts/ReasoningPart.tsx.
 *  Adaptations:
 *  - Ruling 1: the `motion` dependency is NOT added. Upstream animates the
 *    expand/collapse height with `animate(element, { height: 'auto' | '0px' },
 *    { duration: 0.2, ease: 'easeOut' })`. The replacement below is a CSS
 *    transition approximation: measure `scrollHeight`, transition between px
 *    values, and settle to `height:auto` after an expand transition ends (the
 *    standard technique for animating to auto without a library). Fidelity
 *    difference: none visible in normal use; only a mid-transition content
 *    growth (streaming while collapsing) lands at the pre-growth height for the
 *    remaining ~200ms instead of tracking — acceptable per the ruling.
 *  - Ruling 5: upstream's `ScrollableOverlay` app component becomes a plain
 *    `overflow-y-auto` div with the same max-height contract. Lost while
 *    uncompensated: its gradient scroll shadows and `userIntentOnly` wheel
 *    capture — the box now always scrolls natively.
 *  - `useUIStore` chatRenderMode read → prop with upstream's own default
 *    ('live', matching AssistantTextPart's prop default).
 *  - i18n (`useI18n`) → literal English; SDK `Part` → `OcPart`; `Icon` from the
 *    lucide shim (`arrow-down-s` → ChevronDown).
 *  Summary extraction, expansion state machine, and auto-expand logic ported
 *  verbatim. */

import React from 'react';
import type { OcPart } from '../../types/opencode-parts';
import { cn } from '@/lib/utils';
import type { ContentChangeReason } from '../types';
import { Icon } from '../../icon';
import { BusyDots } from './busy-dots';
import { MarkdownRenderer } from '../../markdown/markdown-renderer';
import { useStreamingTextThrottle } from '../../hooks/use-streaming-text-throttle';
import type { StreamPhase } from '../types';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

type PartWithText = OcPart & { text?: string; content?: string; time?: { start?: number; end?: number } };

type ReasoningVariant = 'thinking' | 'justification';

const cleanReasoningText = (text: string): string => {
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

const SUMMARY_MAX_CHARS = 80;
const EXPANDED_CONTENT_UNMOUNT_DELAY_MS = 200;
const EXPANDED_CONTENT_TRANSITION_MS = 200;

/** Strip common markdown syntax so the header preview reads as plain text. */
const stripMarkdown = (text: string): string =>
  text
    // Empty HTML comments are frequently appended by model tool wrappers.
    .replace(/<!--\s*-->/g, '')
    // Fenced code blocks → keep inner text on one line
    .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner: string) => inner.trim())
    // Inline code
    .replace(/`([^`]+)`/g, '$1')
    // Bold + italic (*** / __)
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    // Headings (# ## ###)
    .replace(/^#{1,6}\s+/gm, '')
    // Links [label](url) → label
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Blockquote markers
    .replace(/^>\s?/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Remaining leading/trailing punctuation from stripped markers
    .trim();

const getReasoningSummary = (text: string): string => {
  if (!text) {
    return '';
  }

  // Strip markdown, then collapse all whitespace runs into single spaces.
  const flat = stripMarkdown(text).replace(/\s+/g, ' ').trim();

  if (flat.length <= SUMMARY_MAX_CHARS) {
    return flat;
  }

  // Cut at a word boundary before the limit, then append ellipsis.
  const cut = flat.lastIndexOf(' ', SUMMARY_MAX_CHARS);
  const end = cut > 0 ? cut : SUMMARY_MAX_CHARS;
  return `${flat.substring(0, end).trimEnd()}…`;
};

type ReasoningTimelineBlockProps = {
  text: string;
  variant: ReasoningVariant;
  onContentChange?: (reason?: ContentChangeReason) => void;
  blockId: string;
  time?: { start?: number; end?: number };
  showDuration?: boolean;
  isStreaming?: boolean;
  actions?: React.ReactNode;
  /** Override the initial expanded state. Defaults to `isStreaming`. */
  defaultExpanded?: boolean;
};

type ExpansionState = {
  expanded: boolean;
  source: 'auto' | 'user';
};

/**
 * Ruling-1 seam: CSS-transition approximation of upstream's
 * `animate(element, { height: 'auto' | px }, { duration: 0.2, ease: 'easeOut' })`.
 * Animates between measured pixel heights; expansion settles to `height: auto`
 * on transition end. Exposes a `stop()` shaped like motion's controls so the
 * surrounding effect logic ports unchanged.
 */
const animateHeight = (
  element: HTMLElement,
  target: 'auto' | '0px',
  onSettled: () => void,
): { stop: () => void } => {
  element.style.transition = `height ${EXPANDED_CONTENT_TRANSITION_MS}ms ease-out`;

  const fromHeight = element.style.height === 'auto' || element.style.height === ''
    ? `${element.scrollHeight}px`
    : element.style.height;
  element.style.height = fromHeight;
  // Force a style flush so the transition runs from the current height.
  void element.offsetHeight;

  const settled = () => {
    element.removeEventListener('transitionend', settled);
    element.style.transition = '';
    onSettled();
  };
  element.addEventListener('transitionend', settled);

  if (target === 'auto') {
    element.style.height = `${element.scrollHeight}px`;
  } else {
    element.style.height = '0px';
  }

  // Safety net: if transitionend never fires (element hidden / prefers-reduced-motion
  // disabling transitions), settle after the nominal duration.
  const fallbackTimer = window.setTimeout(settled, EXPANDED_CONTENT_TRANSITION_MS + 80);

  return {
    stop: () => {
      window.clearTimeout(fallbackTimer);
      element.removeEventListener('transitionend', settled);
      const computedHeight = `${element.scrollHeight}px`;
      element.style.transition = '';
      element.style.height = computedHeight;
    },
  };
};

export const ReasoningTimelineBlock: React.FC<ReasoningTimelineBlockProps> = ({
  text,
  variant,
  onContentChange,
  blockId,
  time,
  isStreaming = false,
  actions,
  defaultExpanded,
}) => {
  const hasEnded = typeof time?.end === 'number';
  const canAutoExpand = isStreaming && !hasEnded;
  const [expansion, setExpansion] = React.useState<ExpansionState>(() => {
    if (defaultExpanded === true) {
      return { expanded: true, source: 'user' };
    }
    return { expanded: canAutoExpand, source: 'auto' };
  });
  const isExpanded = expansion.source === 'auto'
    ? canAutoExpand && expansion.expanded
    : expansion.expanded;
  const [shouldRenderExpandedContent, setShouldRenderExpandedContent] = React.useState(defaultExpanded === true || canAutoExpand);
  const contentId = React.useId();
  const contentRef = React.useRef<HTMLDivElement>(null);
  const contentAnimationRef = React.useRef<{ stop: () => void } | null>(null);
  const contentMountedRef = React.useRef(false);
  // Stable handle to onContentChange so the height-animation layout effect can
  // signal auto-follow without taking onContentChange as a dependency (which
  // would risk re-running — and thus restarting — the animation on re-render).
  const onContentChangeRef = React.useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const summary = React.useMemo(() => getReasoningSummary(text), [text]);
  const toggleAriaLabel = isExpanded
    ? 'Collapse reasoning'
    : 'Expand reasoning';

  const handleToggle = React.useCallback(() => {
    setShouldRenderExpandedContent(true);
    setExpansion({ expanded: !isExpanded, source: 'user' });
    onContentChange?.('structural');
  }, [isExpanded, onContentChange]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleToggle();
    }
  }, [handleToggle]);

  React.useLayoutEffect(() => {
    setExpansion((prev) => {
      if (prev.source === 'user') {
        return prev;
      }
      if (prev.expanded === canAutoExpand) {
        return prev;
      }
      return { expanded: canAutoExpand, source: 'auto' };
    });
  }, [canAutoExpand]);

  React.useEffect(() => {
    if (text.trim().length === 0) {
      return;
    }
    onContentChange?.('structural');
  }, [onContentChange, text]);

  React.useEffect(() => {
    if (isExpanded || isStreaming) {
      setShouldRenderExpandedContent(true);
      return;
    }

    if (!shouldRenderExpandedContent) {
      return;
    }

    if (typeof window === 'undefined') {
      setShouldRenderExpandedContent(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShouldRenderExpandedContent(false);
    }, EXPANDED_CONTENT_UNMOUNT_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isExpanded, isStreaming, shouldRenderExpandedContent]);

  React.useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }

    contentAnimationRef.current?.stop();

    if (!contentMountedRef.current) {
      contentMountedRef.current = true;
      if (!isExpanded) {
        element.style.height = '0px';
        element.style.overflow = 'hidden';
        return;
      }

      element.style.height = '0px';
      element.style.overflow = 'hidden';

      const animation = animateHeight(element, 'auto', () => {
        if (contentAnimationRef.current !== animation) {
          return;
        }
        contentAnimationRef.current = null;
        element.style.overflow = 'visible';
        element.style.height = 'auto';
      });
      contentAnimationRef.current = animation;

      return () => {
        animation.stop();
        if (contentAnimationRef.current === animation) {
          contentAnimationRef.current = null;
        }
      };
    }

    element.style.overflow = 'hidden';

    if (isExpanded) {
      element.style.height = '0px';
    } else {
      element.style.height = `${element.scrollHeight}px`;
      // Only the COLLAPSE animation needs the guard: it shrinks the
      // timeline and the trailing async scroll events can be misread as a
      // user scroll-away. Expansion grows the timeline and re-pins cleanly,
      // and guarding it caused a faint scroll fight while thinking streams.
      onContentChangeRef.current?.('animation');
    }

    const animation = animateHeight(element, isExpanded ? 'auto' : '0px', () => {
      if (contentAnimationRef.current !== animation) {
        return;
      }
      contentAnimationRef.current = null;
      if (isExpanded) {
        element.style.overflow = 'visible';
        element.style.height = 'auto';
      } else {
        element.style.overflow = 'hidden';
      }
    });
    contentAnimationRef.current = animation;

    return () => {
      animation.stop();
      if (contentAnimationRef.current === animation) {
        contentAnimationRef.current = null;
      }
    };
  }, [isExpanded]);

  React.useEffect(() => {
    return () => {
      contentAnimationRef.current?.stop();
      contentAnimationRef.current = null;
    };
  }, []);

  if (!text || text.trim().length === 0) {
    return null;
  }

  const variantLabel = variant === 'justification' ? 'Justification' : 'Thinking';

  const reasoningBody = (
    <>
      <div data-message-text-export-source="true">
        <MarkdownRenderer
          content={text}
          messageId={blockId}
          isAnimated={false}
          isStreaming={isStreaming}
          variant="reasoning"
        />
      </div>
      {actions ? (
        <div className="mt-2 mb-1 flex items-center justify-start gap-1.5" data-message-actions="true">
          <div className="flex items-center gap-1.5" data-message-action-group="true">
            {actions}
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <div data-reasoning-block-id={blockId} data-message-text-export-root="true">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        aria-label={toggleAriaLabel}
        className={cn(
          'group/tool flex gap-1.5 pr-2 pl-px py-1.5 rounded-xl cursor-pointer items-center',
        )}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <div className="relative h-3.5 w-3.5 flex-shrink-0 cursor-pointer">
            <div
              className={cn(
                'absolute inset-0 transition-opacity',
                isExpanded && 'opacity-0',
                !isExpanded && 'group-hover/tool:opacity-0',
              )}
              style={{ color: 'var(--tools-icon)' }}
            >
              <Icon name="brain-ai-3" className="h-3.5 w-3.5" />
            </div>
            <div
              className={cn(
                'absolute inset-0 transition-opacity flex items-center justify-center',
                isExpanded && 'opacity-100',
                !isExpanded && 'opacity-0 group-hover/tool:opacity-100',
              )}
              style={{ color: 'var(--tools-icon)' }}
            >
              {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
            </div>
          </div>

          {isStreaming ? (
            <span className={cn('flex items-center gap-1', TOOL_ROW_TITLE_CLASS)} style={{ color: 'var(--tools-title)' }}>
              <span>{variantLabel}</span>
              <BusyDots />
            </span>
          ) : isExpanded ? (
            <span
              className={TOOL_ROW_TITLE_CLASS}
              style={{ color: 'var(--tools-title)' }}
            >
              {variantLabel}
            </span>
          ) : (
            <span
              className={TOOL_ROW_TITLE_CLASS}
              style={{ color: 'var(--tools-title)' }}
            >
              {variantLabel}
            </span>
          )}
        </div>

        <div className={cn('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
          {!isStreaming && !isExpanded && summary ? (
            <span
              className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
              style={{ color: 'var(--tools-description)', opacity: 0.8 }}
              title={summary}
            >
              {summary}
            </span>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
        </div>
      </div>

      {shouldRenderExpandedContent ? (
        <div
          ref={contentRef}
          id={contentId}
          aria-hidden={!isExpanded}
          style={{
            height: isExpanded ? 'auto' : '0px',
            overflow: isExpanded ? 'visible' : 'hidden',
            overflowAnchor: 'none',
          }}
        >
          <div
            className="relative ml-2 pl-3 pb-1 pt-0.5"
            style={{
              opacity: isExpanded ? 1 : 0,
              transform: isExpanded ? 'translateY(0)' : 'translateY(-4px)',
              transition: 'opacity 180ms ease-out, transform 180ms ease-out',
            }}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 bottom-0 w-px"
              style={{ backgroundColor: 'var(--tools-border)' }}
            />
            {isStreaming ? (
              // While streaming, let the thinking grow inline — no
              // capped, independently-scrollable box. The chat's own
              // auto-follow then handles following / releasing, so the
              // box never captures the wheel or fights the user's
              // scroll. The max-height scroll box is applied only once
              // the thinking has finished (the branch below).
              <div className="p-0">
                {reasoningBody}
              </div>
            ) : (
              // Ruling-5 seam: upstream ScrollableOverlay → plain overflow-auto
              // div with the same max-height contract (scroll shadows and the
              // userIntentOnly wheel capture are not replicated).
              <div className="max-h-80 overflow-y-auto p-0">
                {reasoningBody}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};

type ReasoningPartProps = {
  part: OcPart;
  onContentChange?: (reason?: ContentChangeReason) => void;
  messageId: string;
  streamPhase?: StreamPhase;
  /** Store seam — upstream reads `chatRenderMode` from its UI store. */
  chatRenderMode?: 'sorted' | 'live';
};

const ReasoningPart = React.memo(({
  part,
  onContentChange,
  messageId,
  streamPhase,
  chatRenderMode = 'live',
}: ReasoningPartProps) => {
  const partWithText = part as PartWithText;
  const rawText = partWithText.text || partWithText.content || '';
  const textContent = React.useMemo(() => cleanReasoningText(rawText), [rawText]);
  const time = partWithText.time;
  const canBeStreaming = streamPhase === undefined || streamPhase !== 'completed';
  const isStreaming = chatRenderMode === 'live' && canBeStreaming && typeof time?.end !== 'number';
  const throttledText = useStreamingTextThrottle({
    text: textContent,
    isStreaming,
    identityKey: `${messageId}:${part.id ?? 'reasoning'}`,
  });

  // Show reasoning even if time.end isn't set yet (during streaming)
  // Only hide if there's no text content
  if (!throttledText || throttledText.trim().length === 0) {
    return null;
  }

  return (
    <ReasoningTimelineBlock
      text={throttledText}
      variant="thinking"
      onContentChange={onContentChange}
      blockId={part.id || `${messageId}-reasoning`}
      time={time}
      isStreaming={isStreaming}
    />
  );
});

export default ReasoningPart;
export { ReasoningPart };
