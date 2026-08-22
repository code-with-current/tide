/** ShortcutCapture: clickable kbd display that captures the next key combo when active. Idle shows binding, click listens, Escape cancels, Backspace clears. */
import { useEffect, useRef, useState } from 'react';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { eventToTokens } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';

export interface ShortcutCaptureProps {
  /** Current binding as display tokens. Empty = unbound. */
  keys: string[];
  /** Fired with the captured token array when the user presses a combo.
   *  Callers persist it (typically via useUi.setShortcut). */
  onCapture: (tokens: string[]) => void;
  /** Optional: fired when the user presses Backspace while listening, to
   *  clear the binding entirely. If omitted, Backspace captures as a key. */
  onClear?: () => void;
  /** Disable interaction (e.g. for unimplemented actions). */
  disabled?: boolean;
  className?: string;
}

export function ShortcutCapture({ keys, onCapture, onClear, disabled, className }: ShortcutCaptureProps) {
  const [listening, setListening] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!listening) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      // Always prevent default while listening so the key doesn't also fire
      // its bound action (e.g. pressing T while rebinding shouldn't toggle
      // the terminal).
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels capture without emitting.
      if (e.key === 'Escape') {
        setListening(false);
        return;
      }
      // Backspace clears (if a clear handler is wired) and exits.
      if (e.key === 'Backspace' && onClear) {
        onClear();
        setListening(false);
        return;
      }
      // Otherwise normalize + emit. eventToTokens returns null for pure
      // modifier presses (Shift alone etc.) — in that case keep listening.
      const tokens = eventToTokens(e);
      if (!tokens) return;
      onCapture(tokens);
      setListening(false);
    };
    // capture phase so we beat any other window-level listeners.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [listening, onCapture, onClear]);

  // Click-outside cancels listening.
  useEffect(() => {
    if (!listening) return;
    const onDown = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setListening(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [listening]);

  if (listening) {
    return (
      <button
        ref={btnRef}
        type="button"
        className={cn(
          'inline-flex items-center gap-1 h-6 px-2 rounded border border-warning/60 bg-warning/10',
          'text-[0.75rem] font-medium text-warning animate-pulse',
          className,
        )}
      >
        Press keys…
        <span className="text-warning/60 ml-1">Esc to cancel</span>
      </button>
    );
  }

  return (
    <button
      ref={btnRef}
      type="button"
      disabled={disabled}
      onClick={() => setListening(true)}
      title={disabled ? 'Not yet wired' : 'Click to rebind'}
      className={cn(
        'inline-flex items-center gap-1 rounded transition-colors',
        'hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        disabled && 'opacity-50 cursor-not-allowed',
        keys.length === 0 && 'px-2 py-0.5 text-[0.75rem] text-muted-foreground italic',
        className,
      )}
    >
      {keys.length === 0 ? (
        'Unbound'
      ) : (
        <KbdGroup>
          {keys.map((k, i) => (
            <Kbd key={i}>{k}</Kbd>
          ))}
        </KbdGroup>
      )}
    </button>
  );
}
