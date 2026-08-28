import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Icon } from '../icon';
import { rangeToMarkdown, trimSelectionValue, wrapMarkdownSelectionForChat } from './selection-markdown';

interface TextSelectionMenuProps {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Receives the selection wrapped as a markdown code block. */
  onAddToChat?: (markdownBlock: string) => void;
}

interface MenuPosition {
  x: number;
  y: number;
  show: boolean;
}

interface SelectionPayload {
  plainText: string;
  markdownText: string;
  rect: DOMRect;
}

const DESKTOP_MENU_SIDE_MARGIN_PX = 8;
const DESKTOP_MENU_FALLBACK_WIDTH_PX = 280;

/** Minimal stand-in for upstream's `focusChatInput` (composer not in port scope). */
const focusChatInput = (): void => {
  const input = document.querySelector<HTMLElement>('[data-chat-input]');
  input?.focus();
};

export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({ containerRef, onAddToChat }) => {
  const [position, setPosition] = React.useState<MenuPosition>({ x: 0, y: 0, show: false });
  const [selectedText, setSelectedText] = React.useState('');
  const [selectedTextMarkdown, setSelectedTextMarkdown] = React.useState('');
  const isDraggingRef = React.useRef(false);
  const [isOpening, setIsOpening] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuWidthRef = React.useRef(DESKTOP_MENU_FALLBACK_WIDTH_PX);
  const pendingSelectionRef = React.useRef<SelectionPayload | null>(null);
  const openRafRef = React.useRef<number | null>(null);
  const mouseUpTimeoutRef = React.useRef<number | null>(null);
  const isMenuVisibleRef = React.useRef(false);

  React.useEffect(() => {
    isMenuVisibleRef.current = position.show;
  }, [position.show]);

  React.useEffect(() => {
    return () => {
      if (openRafRef.current !== null) {
        window.cancelAnimationFrame(openRafRef.current);
        openRafRef.current = null;
      }
      if (mouseUpTimeoutRef.current !== null) {
        window.clearTimeout(mouseUpTimeoutRef.current);
        mouseUpTimeoutRef.current = null;
      }
    };
  }, []);

  const hideMenu = React.useCallback(() => {
    pendingSelectionRef.current = null;

    if (!isMenuVisibleRef.current) {
      return;
    }

    if (openRafRef.current !== null) {
      window.cancelAnimationFrame(openRafRef.current);
      openRafRef.current = null;
    }
    setIsOpening(false);

    setPosition((prev) => ({ ...prev, show: false }));
    setSelectedText('');
    setSelectedTextMarkdown('');
    isMenuVisibleRef.current = false;
  }, []);

  const getDesktopClampedX = React.useCallback((anchorX: number) => {
    if (typeof window === 'undefined') {
      return anchorX;
    }

    const viewportWidth = window.innerWidth;
    const menuWidth = menuWidthRef.current;
    const halfWidth = menuWidth / 2;
    const minX = DESKTOP_MENU_SIDE_MARGIN_PX + halfWidth;
    const maxX = viewportWidth - DESKTOP_MENU_SIDE_MARGIN_PX - halfWidth;

    if (minX > maxX) {
      return viewportWidth / 2;
    }

    return Math.min(Math.max(anchorX, minX), maxX);
  }, []);

  const showMenu = React.useCallback(() => {
    if (!pendingSelectionRef.current) return;

    const { plainText, markdownText, rect } = pendingSelectionRef.current;
    const shouldAnimateIn = !position.show;

    // Position menu above the selection
    const menuX = getDesktopClampedX(rect.left + rect.width / 2);
    const menuY = rect.top - 10;

    setSelectedText(plainText);
    setSelectedTextMarkdown(markdownText);
    setPosition({
      x: menuX,
      y: menuY,
      show: true,
    });
    isMenuVisibleRef.current = true;

    if (shouldAnimateIn) {
      setIsOpening(true);
      if (openRafRef.current !== null) {
        window.cancelAnimationFrame(openRafRef.current);
      }
      openRafRef.current = window.requestAnimationFrame(() => {
        setIsOpening(false);
        openRafRef.current = null;
      });
    }
  }, [getDesktopClampedX, position.show]);

  React.useLayoutEffect(() => {
    if (!position.show || !menuRef.current) {
      return;
    }

    const measuredWidth = menuRef.current.offsetWidth;
    if (!Number.isFinite(measuredWidth) || measuredWidth <= 0 || measuredWidth === menuWidthRef.current) {
      return;
    }

    menuWidthRef.current = measuredWidth;
    setPosition((prev) => ({
      ...prev,
      x: getDesktopClampedX(prev.x),
    }));
  }, [getDesktopClampedX, position.show]);

  React.useEffect(() => {
    if (!position.show) {
      return;
    }

    const handleViewportResize = () => {
      setPosition((prev) => ({
        ...prev,
        x: getDesktopClampedX(prev.x),
      }));
    };

    window.addEventListener('resize', handleViewportResize);
    return () => {
      window.removeEventListener('resize', handleViewportResize);
    };
  }, [getDesktopClampedX, position.show]);

  const handleSelectionChange = React.useCallback(() => {
    const selection = window.getSelection();
    const container = containerRef.current;

    if (!selection || !container) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    const text = trimSelectionValue(selection.toString());

    // Only show if we have text and the selection is within our container
    if (!text) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    // Check if selection is within the container
    const range = selection.getRangeAt(0);

    if (!container.contains(range.commonAncestorContainer)) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    // Get selection coordinates
    const rect = range.getBoundingClientRect();

    // Store the selection but don't show menu yet if dragging
    pendingSelectionRef.current = {
      plainText: text,
      markdownText: rangeToMarkdown(range, text),
      rect,
    };

    // Only show menu if we're not currently dragging
    if (!isDraggingRef.current) {
      showMenu();
    }
  }, [containerRef, hideMenu, showMenu]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Track when dragging starts
    const handleMouseDown = () => {
      isDraggingRef.current = true;
      hideMenu();
    };

    // Track when dragging stops
    const handleMouseUp = () => {
      isDraggingRef.current = false;
      // Check if we have a pending selection to show
      if (pendingSelectionRef.current) {
        if (mouseUpTimeoutRef.current !== null) {
          window.clearTimeout(mouseUpTimeoutRef.current);
        }
        // Small delay to ensure selection is finalized
        mouseUpTimeoutRef.current = window.setTimeout(() => {
          mouseUpTimeoutRef.current = null;
          const selection = window.getSelection();
          if (selection && selection.toString().trim()) {
            showMenu();
          } else {
            hideMenu();
          }
        }, 10);
      }
    };

    // Listen for selection changes during drag
    document.addEventListener('selectionchange', handleSelectionChange);

    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);

    // Hide menu when clicking outside
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current
        && !menuRef.current.contains(e.target as Node)
        && !window.getSelection()?.toString().trim()
      ) {
        hideMenu();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      if (mouseUpTimeoutRef.current !== null) {
        window.clearTimeout(mouseUpTimeoutRef.current);
        mouseUpTimeoutRef.current = null;
      }
      document.removeEventListener('selectionchange', handleSelectionChange);
      container.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [containerRef, handleSelectionChange, hideMenu, showMenu]);

  const handleAddToChat = React.useCallback(() => {
    if (!selectedTextMarkdown || !onAddToChat) return;

    const markdownBlock = wrapMarkdownSelectionForChat(selectedTextMarkdown);
    onAddToChat(markdownBlock);

    hideMenu();

    // Clear selection
    window.getSelection()?.removeAllRanges();
    queueMicrotask(() => {
      focusChatInput();
    });
  }, [selectedTextMarkdown, onAddToChat, hideMenu]);

  const handleCopy = React.useCallback(async () => {
    if (!selectedText) return;

    try {
      await navigator.clipboard.writeText(selectedText);
    } catch (error) {
      console.error('Failed to copy:', error);
    }

    hideMenu();
    window.getSelection()?.removeAllRanges();
  }, [selectedText, hideMenu]);

  if (!position.show) return null;

  // Desktop: Show as a popup above the selection
  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%)',
      }}
    >
      <div
        className={cn(
          'flex items-center gap-1 whitespace-nowrap',
          'rounded-lg border border-[var(--interactive-border)]',
          'bg-[var(--surface-elevated)] shadow-none',
          'px-1.5 py-1',
          'transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform]',
          isOpening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0',
        )}
      >
        {onAddToChat ? (
          <>
            <button
              onClick={handleAddToChat}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded-md',
                'text-sm font-medium',
                'text-[var(--surface-foreground)]',
                'hover:bg-[var(--interactive-hover)]',
                'transition-colors duration-150',
              )}
              title="Add the selection to the current chat"
              type="button"
            >
              <Icon name="add" className="h-4 w-4" />
              <span className="whitespace-nowrap">Add to chat</span>
            </button>

            <div className="w-px h-4 bg-[var(--interactive-border)]" />
          </>
        ) : null}

        <button
          onClick={handleCopy}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md',
            'text-sm font-medium',
            'text-[var(--surface-foreground)]',
            'hover:bg-[var(--interactive-hover)]',
            'transition-colors duration-150',
          )}
          title="Copy"
          type="button"
        >
          <Icon name="file-copy" className="h-4 w-4" />
          <span className="whitespace-nowrap">Copy</span>
        </button>
      </div>
    </div>,
    document.body,
  );
};
