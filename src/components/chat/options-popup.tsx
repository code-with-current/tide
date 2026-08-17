import { useState, useEffect, useRef } from 'react';
import { X, CornerDownLeft, MessageCircleQuestion, Check, Send, Circle, CheckCircle2 } from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** OptionsPopup: "model is asking you a question" surface rendered above the composer (blocks until answered). Shows option chips + free-text fallback; state lives in the ui store. */
export function OptionsPopup({
  onSubmit,
}: {
  onSubmit: (selection: string[]) => void;
}) {
  const activeSessionId = useUi((s) => s.activeSessionId);
  const opts = useUi((s) => (activeSessionId ? s.pendingOptions[activeSessionId] : undefined));
  const dismiss = useUi((s) => s.dismissOptionsPopup);

  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [exiting, setExiting] = useState(false);
  // For multiple-selection mode: which options are toggled on.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Brief flash state for single-select click feedback (chip turns accent
  // for ~120ms before the popup dismisses).
  const [flashChip, setFlashChip] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isMultiple = opts?.multiple ?? false;

  // Reset state when the popup opens for a new question OR when the active
  // session changes — draft text/selection must never bleed between sessions.
  useEffect(() => {
    if (opts) {
      setText('');
      setSubmitted(false);
      setExiting(false);
      setSelected(new Set());
      setFlashChip(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts?.messageId, activeSessionId]);

  // Esc to dismiss.
  useEffect(() => {
    if (!opts) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitted) {
        e.preventDefault();
        e.stopPropagation();
        startDismiss();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts, submitted]);

  if (!opts) return null;

  const startDismiss = () => {
    setExiting(true);
    setTimeout(() => dismiss(activeSessionId!), 150);
  };

  const handleSubmit = (selection: string[]) => {
    if (submitted || selection.length === 0) return;
    setSubmitted(true);
    onSubmit(selection);
    startDismiss();
  };

  const handleChipClick = (option: string) => {
    if (submitted) return;
    if (isMultiple) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(option)) next.delete(option);
        else next.add(option);
        return next;
      });
    } else {
      // Single select: flash + submit immediately.
      setFlashChip(option);
      setTimeout(() => handleSubmit([option]), 120);
    }
  };

  const handleMultipleSubmit = () => {
    handleSubmit(Array.from(selected));
  };

  const handleTextInput = () => {
    const answer = text.trim();
    if (!answer) return;
    handleSubmit([answer]);
  };

  return (
    <div
      className={cn(
        'absolute bottom-full left-0 right-0 mb-2 z-30',
        exiting ? 'animate-slide-down' : 'animate-slide-up',
      )}
    >
      <div
        role="dialog"
        aria-label="Tide is asking a question"
        className={cn(
          'rounded-xl border bg-card shadow-2xl overflow-hidden',
          'border-primary/30',
        )}
      >
        {/* Accent left border — signals "model needs your input" */}
        <div className="flex">
          <div className="w-1 bg-primary flex-shrink-0" />

          <div className="flex-1 min-w-0">
            {/* Header — icon + "Tide is asking" label + question + dismiss */}
            <div className="px-3.5 pt-3 pb-2.5 flex items-start gap-2.5">
              <div className="size-9 rounded-lg bg-warning/10 border border-warning/20 flex items-center justify-center shrink-0 mt-0.5">
                <MessageCircleQuestion className="size-5 text-warning" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-primary/70 mb-0.5">
                  Tide is asking
                </div>
                <div className="text-sm font-medium text-foreground leading-snug">
                  {opts.question}
                </div>
              </div>
              <button
                type="button"
                onClick={() => !submitted && startDismiss()}
                className="text-muted-foreground/50 hover:text-foreground p-1 rounded hover:bg-accent shrink-0 transition-colors cursor-pointer"
                title="Dismiss (Esc)"
                aria-label="Dismiss"
              >
                <X className="size-3.5" />
              </button>
            </div>

            {/* Option chips — 2-column grid */}
            {opts.options.length > 0 && (
              <div className="px-3.5 pb-2">
                {/* Selection-mode indicator — tells the user whether they can
                    pick one (radio) or many (checkbox). Matches the mental
                    model of standard form controls. */}
                <div className="flex items-center gap-1.5 mb-1.5 text-[10px] text-muted-foreground/60">
                  {isMultiple ? (
                    <>
                      <CheckCircle2 className="size-3" />
                      <span>Select one or more</span>
                    </>
                  ) : (
                    <>
                      <Circle className="size-3" />
                      <span>Select one</span>
                    </>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-1.5">
                  {opts.options.slice(0, 8).map((option, i) => {
                    const isSelected = selected.has(option);
                    const isFlashing = flashChip === option;
                    return (
                      <button
                        key={i}
                        type="button"
                        role={isMultiple ? 'checkbox' : 'radio'}
                        aria-checked={isSelected || !!isFlashing}
                        disabled={submitted}
                        onClick={() => handleChipClick(option)}
                        className={cn(
                          'group flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-[12px] text-left transition-all',
                          'cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
                          isFlashing || isSelected
                            ? 'border-primary/50 bg-primary/10 text-foreground'
                            : 'border-border bg-background hover:border-primary/30 hover:bg-secondary text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {/* Radio (single) or Checkbox (multiple) icon — empty
                            circle/square when unselected, filled when selected.
                            Visual signal that matches the selection mode. */}
                        {isMultiple ? (
                          isSelected || isFlashing ? (
                            <div className="size-3.5 rounded-[3px] bg-primary flex items-center justify-center shrink-0">
                              <Check className="size-2.5 text-primary-foreground" />
                            </div>
                          ) : (
                            <div className="size-3.5 rounded-[3px] border border-muted-foreground/30 shrink-0" />
                          )
                        ) : (
                          isSelected || isFlashing ? (
                            <div className="size-3.5 rounded-full border-[3px] border-primary shrink-0" />
                          ) : (
                            <div className="size-3.5 rounded-full border border-muted-foreground/30 shrink-0" />
                          )
                        )}
                        <span className="truncate">{option}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Multiple-selection submit bar */}
                {isMultiple && selected.size > 0 && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {selected.size} selected
                    </span>
                    <Button
                      variant="default"
                      size="sm"
                      disabled={submitted}
                      onClick={handleMultipleSubmit}
                      className="h-7 text-[11px] gap-1.5"
                    >
                      <Send className="size-3" /> Submit
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Separator between chips and free-text input */}
            {opts.options.length > 0 && (
              <div className="px-3.5">
                <div className="border-t border-input/60" />
              </div>
            )}

            {/* Free-text input — the fallback for custom answers */}
            <div className="flex items-center gap-2 px-3.5 py-2.5">
              <Input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleTextInput();
                  }
                }}
                disabled={submitted}
                placeholder={opts.options.length > 0 ? 'Or type your own answer…' : 'Type your answer…'}
                className="h-8 text-[12.5px] flex-1 bg-background/50"
              />
              <span className="hidden sm:flex items-center gap-1 text-[10px] text-muted-foreground/40 flex-shrink-0">
                <kbd className="font-mono">
                  <CornerDownLeft className="size-3" />
                </kbd>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
