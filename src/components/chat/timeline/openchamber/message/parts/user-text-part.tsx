/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/message/parts/UserTextPart.tsx.
 *  Adaptations:
 *  - Store seams (ruling 6): `useUIStore` reads (`userMessageRenderingMode`,
 *    `collapsibleUserMessages`) become props `renderingMode` (default 'markdown')
 *    and `collapsible` (default true); `useSkillsStore` becomes a `skills`
 *    name-set prop (default empty); `useEffectiveDirectory` becomes `directory?`.
 *    Skill open (`openContextFile` UI-store action) becomes an optional
 *    `onOpenSkill` callback — skill tokens render as plain text when absent.
 *  - `@/lib/messages/inlineMessageLinks` (`buildAgentMentionUrl`,
 *    `parseSkillHref`) is an OpenChamber app-link helper on the delete-on-sight
 *    list: agent mentions render as plain text (the markdown path already drops
 *    mention/skill link injection in user-text-part-content).
 *  - `@/lib/messages/terminalContext` (`extractTerminalContexts`) dropped — a
 *    synthetic OpenCode-server helper whose shapes Tide's adapter never emits.
 *  - i18n (`useI18n`) → literal English; `Icon` from the lucide shim
 *    (`arrow-up-s` → ArrowUp).
 *  Truncation/expand measurement logic ported verbatim. */

import React from 'react';
import { cn } from '@/lib/utils';
import type { OcPart } from '../../types/opencode-parts';
import type { AgentMentionInfo } from '../types';
import { SimpleMarkdownRenderer } from '../../markdown/markdown-renderer';
import { Icon } from '../../icon';
import { prepareUserMarkdownContent, SKILL_TOKEN_PATTERN } from './user-text-part-content';

type PartWithText = OcPart & { text?: string; content?: string; value?: string };

type UserTextPartProps = {
  part: OcPart;
  messageId: string;
  isMobile: boolean;
  agentMention?: AgentMentionInfo;
  /** Store seam — upstream reads `userMessageRenderingMode` from its UI store. */
  renderingMode?: 'markdown' | 'plain';
  /** Store seam — upstream reads `collapsibleUserMessages` from its UI store. */
  collapsible?: boolean;
  /** Store seam — upstream reads known skill names from its skills store. */
  skills?: ReadonlySet<string>;
  /** Callback seam — opens a skill file; skill tokens render plain when absent. */
  onOpenSkill?: (name: string) => void;
};

const normalizeUserMessageRenderingMode = (mode: unknown): 'markdown' | 'plain' => {
  return mode === 'markdown' ? 'markdown' : 'plain';
};

const UserTextPart: React.FC<UserTextPartProps> = ({
  part,
  messageId,
  agentMention,
  renderingMode = 'markdown',
  collapsible = true,
  skills,
  onOpenSkill,
}) => {
  const partWithText = part as PartWithText;
  const rawText = partWithText.text;
  const textContent = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';

  const [isExpanded, setIsExpanded] = React.useState(false);
  const [isTruncated, setIsTruncated] = React.useState(false);
  const collapsibleUserMessages = collapsible;
  const skillNames = React.useMemo(() => new Set(skills ?? []), [skills]);
  const normalizedRenderingMode = normalizeUserMessageRenderingMode(renderingMode);
  const isCollapsed = collapsibleUserMessages && !isExpanded;
  const textRef = React.useRef<HTMLDivElement>(null);

  const hasActiveSelectionInElement = React.useCallback((element: HTMLElement): boolean => {
    if (typeof window === 'undefined') {
      return false;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false;
    }

    const range = selection.getRangeAt(0);
    return element.contains(range.startContainer) || element.contains(range.endContainer);
  }, []);

  React.useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    if (!collapsibleUserMessages || isExpanded) return;

    const checkTruncation = () => {
      setIsTruncated(el.scrollHeight > el.clientHeight);
    };

    checkTruncation();
    // A just-sent message mounts while its turn is still settling, so the
    // synchronous read can land before the clamp has its final geometry.
    // One deferred re-read covers that without waiting for an observer.
    const initialFrame = window.requestAnimationFrame(checkTruncation);

    // `el` is the clamped box: once line-clamp pins it to two lines its own
    // size stops changing, so observing it alone freezes the first
    // measurement. Markdown settles after mount (highlighting, late layout),
    // and a message measured while still short would never regain the
    // expand affordance. The children keep their natural height under the
    // clamp, so they are what reports content growth.
    const resizeObserver = new ResizeObserver(checkTruncation);
    resizeObserver.observe(el);

    const observeChildren = () => {
      for (const child of Array.from(el.children)) {
        resizeObserver.observe(child);
      }
    };
    observeChildren();

    // The renderer swaps subtrees as it settles; re-observe the new children.
    const mutationObserver = new MutationObserver(() => {
      observeChildren();
      checkTruncation();
    });
    mutationObserver.observe(el, { childList: true, subtree: true });

    return () => {
      window.cancelAnimationFrame(initialFrame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [collapsibleUserMessages, textContent, isExpanded]);

  React.useEffect(() => {
    if (!collapsibleUserMessages) {
      setIsExpanded(false);
      setIsTruncated(false);
    }
  }, [collapsibleUserMessages]);

  const handleClick = React.useCallback(() => {
    const element = textRef.current;
    if (!element) {
      return;
    }

    if (hasActiveSelectionInElement(element)) {
      return;
    }

    // Measure at click time instead of trusting the observed flag: whether
    // the text is clipped right now is what decides if expanding does
    // anything, and the flag can still be catching up on a fresh message.
    if (collapsibleUserMessages && !isExpanded && element.scrollHeight > element.clientHeight) {
      setIsTruncated(true);
      setIsExpanded(true);
    }
  }, [collapsibleUserMessages, hasActiveSelectionInElement, isExpanded]);

  const handleCollapse = React.useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setIsExpanded(false);
  }, []);

  const processedMarkdownContent = React.useMemo(() => {
    return prepareUserMarkdownContent({
      textContent,
      agentMention,
      skillNames,
    });
  }, [agentMention, skillNames, textContent]);

  const plainTextContent = React.useMemo(() => {
    // Seam: skill tokens only become buttons when `onOpenSkill` is provided
    // (upstream always had the store-backed handler); otherwise plain text.
    if (!onOpenSkill) {
      return [textContent];
    }

    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    SKILL_TOKEN_PATTERN.lastIndex = 0;

    while ((match = SKILL_TOKEN_PATTERN.exec(textContent)) !== null) {
      const prefix = match[1] || '';
      const skillName = match[2];
      const slashIndex = match.index + prefix.length;
      if (!skillNames.has(skillName)) continue;

      if (match.index > cursor) nodes.push(textContent.slice(cursor, match.index));
      if (prefix) nodes.push(prefix);
      nodes.push(
        <button
          key={`skill-${slashIndex}-${skillName}`}
          type="button"
          className="text-primary hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            onOpenSkill(skillName);
          }}
        >
          /{skillName}
        </button>,
      );
      cursor = slashIndex + skillName.length + 1;
    }

    if (cursor < textContent.length) nodes.push(textContent.slice(cursor));

    return nodes.length > 0 ? nodes : [textContent];
  }, [textContent, skillNames, onOpenSkill]);

  if (!textContent || textContent.trim().length === 0) {
    return null;
  }

  return (
    <div className="relative" key={part.id || `${messageId}-user-text`}>
      {collapsibleUserMessages && isExpanded && (
        <button
          type="button"
          onClick={handleCollapse}
          className="absolute top-0 right-0 z-10 flex items-center justify-center rounded-sm bg-[var(--surface-elevated)] p-0.5 text-[var(--surface-mutedForeground)] hover:text-[var(--surface-foreground)] hover:bg-[var(--interactive-hover)] transition-colors"
          aria-label="Collapse message"
        >
          <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
        </button>
      )}
      <div
        className={cn(
          'break-words font-sans typography-markdown-body',
          isExpanded && 'pb-3',
          normalizedRenderingMode === 'plain' && 'whitespace-pre-wrap',
          isCollapsed && 'line-clamp-2',
          collapsibleUserMessages && isTruncated && !isExpanded && 'cursor-pointer',
        )}
        ref={textRef}
        onClick={handleClick}
      >
        {normalizedRenderingMode === 'markdown' ? (
          <SimpleMarkdownRenderer
            content={processedMarkdownContent}
            className={cn(
              "[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0",
              isCollapsed && [
                "[&_.markdown-content>*]:my-0",
                "[&_[data-component='markdown-code']]:my-0",
                "[&_[data-component='markdown-code']]:inline",
                "[&_[data-component='markdown-code']]:border-0",
                "[&_[data-component='markdown-code']]:bg-transparent",
                "[&_[data-component='markdown-code']>*:first-child]:hidden",
                "[&_[data-component='markdown-code']>div]:inline",
                "[&_[data-component='markdown-code']>div]:p-0",
                "[&_[data-component='markdown-code']_pre]:inline",
                "[&_[data-component='markdown-code']_code]:inline",
                '[&_[data-md-code-line]]:!inline',
                '[&_[data-md-code-line-number]]:hidden',
                '[&_[data-md-code-line-break]]:!inline',
              ],
            )}
            disableLinkSafety
            enableFileReferences={false}
          />
        ) : (
          plainTextContent
        )}
      </div>
    </div>
  );
};

export default React.memo(UserTextPart);
export { UserTextPart };
