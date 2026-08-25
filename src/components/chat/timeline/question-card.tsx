/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/QuestionCard.tsx — ADAPTED (Ruling 3).
 *  Upstream renders OpenCode's multi-question `QuestionRequest` (tabs + summary view,
 *  sessionActions responders, sync/UI stores). Tide's followup surface is ONE question
 *  from the `ask_followup_question` tool part — `{ question, options: [{label, description?}],
 *  multiple }` — so the multi-question tabs/summary machinery is dropped. Adaptations:
 *  - Props: toolCallId + question fields parsed from the pending tool part (option
 *    descriptions live in the part's input; the followup part's `mode` is passed through).
 *    Answer submission calls `onAnswerFollowup(toolCallId, answer, mode)` — plain prop
 *    now, threaded by Task 8 into submitFollowup.
 *  - Dismiss submits an empty answer (Tide's IPC has no reject path for followups).
 *  - Checkbox/Radio (upstream ui) → shadcn adapters; RadioGroup uses index values so
 *    duplicate labels stay legal.
 *  - Dropped: session-store responders, isFromSubagent badge, isMobile, i18n (literal
 *    English), toast on copy (clipboard result is silent).
 *  - `@/lib/ime` isIMECompositionEvent → local isComposing check.
 *  - CustomAnswerTextarea + sizing logic ported verbatim. */

import React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import {
  serializeQuestionAsJson,
  serializeQuestionAsMarkdown,
  type FollowupQuestionPayload,
} from './question-serializers';
import {
  QUESTION_CUSTOM_TEXTAREA_MIN_HEIGHT,
  getQuestionCustomTextareaHeight,
} from './question-textarea-sizing';

interface QuestionCardProps extends FollowupQuestionPayload {
  toolCallId: string;
  /** The followup part's mode (Tide FollowupMode) — passed back on answer submission. */
  mode?: unknown;
  onAnswerFollowup?: (toolCallId: string, answer: string, mode?: unknown) => void;
}

interface CustomAnswerTextareaProps {
  value: string;
  placeholder: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

const CustomAnswerTextarea = React.memo(function CustomAnswerTextarea({
  value,
  placeholder,
  disabled,
  onValueChange,
  onKeyDown,
}: CustomAnswerTextareaProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [localValue, setLocalValue] = React.useState(value);
  const [height, setHeight] = React.useState(QUESTION_CUSTOM_TEXTAREA_MIN_HEIGHT);
  const [isScrollable, setIsScrollable] = React.useState(false);

  React.useEffect(() => {
    setLocalValue(value);
  }, [value]);

  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const nextHeight = getQuestionCustomTextareaHeight({
      scrollHeight: textarea.scrollHeight,
      currentHeight: height,
    });
    const nextScrollable = textarea.scrollHeight > (nextHeight ?? height);
    if (isScrollable !== nextScrollable) {
      setIsScrollable(nextScrollable);
    }
    if (nextHeight !== null) {
      setHeight(nextHeight);
    }
  }, [height, isScrollable, localValue]);

  return (
    <textarea
      ref={textareaRef}
      value={localValue}
      onChange={(event) => {
        const nextValue = event.target.value;
        setLocalValue(nextValue);
        onValueChange(nextValue);
      }}
      placeholder={placeholder}
      disabled={disabled}
      rows={2}
      onKeyDown={onKeyDown}
      style={{ height }}
      className={cn(
        'w-full bg-transparent border border-border/30 focus:border-primary rounded px-2 py-1 outline-none typography-meta text-foreground placeholder:text-muted-foreground/50 transition-colors resize-none',
        isScrollable ? 'overflow-y-auto' : 'overflow-hidden',
      )}
      autoFocus
    />
  );
});

const isIMECompositionEvent = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
  e.nativeEvent.isComposing;

export const QuestionCard: React.FC<QuestionCardProps> = ({
  toolCallId,
  question,
  options,
  multiple,
  mode,
  onAnswerFollowup,
}) => {
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);
  const [selectedOptions, setSelectedOptions] = React.useState<string[]>([]);
  const [isCustomMode, setIsCustomMode] = React.useState(false);
  const [customText, setCustomText] = React.useState('');

  React.useEffect(() => {
    setSelectedOptions([]);
    setIsCustomMode(false);
    setCustomText('');
    setHasResponded(false);
  }, [toolCallId]);

  const isMultiple = Boolean(multiple);
  const hasSelection = isCustomMode ? customText.trim().length > 0 : selectedOptions.length > 0;

  const handleToggleOption = React.useCallback(
    (label: string) => {
      setIsCustomMode(false);
      setSelectedOptions((prev) => {
        if (isMultiple) {
          const exists = prev.includes(label);
          return exists ? prev.filter((item) => item !== label) : [...prev, label];
        }
        return [label];
      });
    },
    [isMultiple],
  );

  const handleSubmit = React.useCallback(() => {
    if (!hasSelection) return;
    const answer = isCustomMode
      ? customText.trim()
      : selectedOptions.join(', ');
    setIsResponding(true);
    onAnswerFollowup?.(toolCallId, answer, mode);
    setHasResponded(true);
    setIsResponding(false);
  }, [customText, hasSelection, isCustomMode, mode, onAnswerFollowup, selectedOptions, toolCallId]);

  const handleDismiss = React.useCallback(() => {
    setIsResponding(true);
    onAnswerFollowup?.(toolCallId, '', mode);
    setHasResponded(true);
    setIsResponding(false);
  }, [mode, onAnswerFollowup, toolCallId]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isIMECompositionEvent(e)) return;

      if (e.key === 'Enter' && !e.shiftKey && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleCopy = React.useCallback(async (getText: () => string) => {
    try {
      await navigator.clipboard.writeText(getText());
    } catch {
      // Clipboard denial is non-fatal for a copy affordance — stay silent.
    }
  }, []);

  if (hasResponded) {
    return null;
  }

  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
          <div className="px-2 py-1.5 border-b border-border/20">
            <div className="flex items-center gap-2">
              <Icon name="question" className="h-3.5 w-3.5 text-primary" />
              <span className="typography-meta font-medium text-muted-foreground">Input needed</span>
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => handleCopy(() => serializeQuestionAsMarkdown({ question, options, multiple }))}
                  title="Copy as Markdown"
                  aria-label="Copy as Markdown"
                  className="flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground hover:bg-interactive-hover/30 transition-colors"
                >
                  <Icon name="file-text" className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy(() => serializeQuestionAsJson({ question, options, multiple }))}
                  title="Copy as JSON"
                  aria-label="Copy as JSON"
                  className="flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground hover:bg-interactive-hover/30 transition-colors"
                >
                  <Icon name="code-box" className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>

          <div className="px-2 py-2">
            <div className="typography-meta font-medium text-foreground mb-1.5">{question}</div>

            {isMultiple ? (
              <div className="typography-micro text-muted-foreground mb-1.5">Select all that apply.</div>
            ) : null}

            <div className="space-y-0.5">
              {isMultiple ? (
                options.map((option, index) => {
                  const selected = selectedOptions.includes(option.label);
                  return (
                    <button
                      key={`${index}:${option.label}`}
                      type="button"
                      onClick={() => handleToggleOption(option.label)}
                      disabled={isResponding}
                      className={cn(
                        'w-full px-1.5 py-1 text-left rounded transition-colors',
                        'hover:bg-interactive-hover/30',
                        selected ? 'bg-interactive-selection/20' : null,
                        isResponding ? 'opacity-60 cursor-not-allowed' : null,
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 shrink-0">
                          <Checkbox
                            checked={selected}
                            onCheckedChange={() => handleToggleOption(option.label)}
                            disabled={isResponding}
                          />
                        </div>
                        <OptionBody option={option} selected={selected} />
                      </div>
                    </button>
                  );
                })
              ) : (
                <RadioGroup
                  value={selectedOptions[0] ?? ''}
                  onValueChange={(value) => {
                    const option = options[Number(value)];
                    if (option) handleToggleOption(option.label);
                  }}
                  disabled={isResponding}
                  className="gap-0"
                >
                  {options.map((option, index) => {
                    const selected = selectedOptions.includes(option.label);
                    return (
                      <label
                        key={`${index}:${option.label}`}
                        className={cn(
                          'w-full px-1.5 py-1 flex items-start gap-2 rounded transition-colors cursor-pointer',
                          'hover:bg-interactive-hover/30',
                          selected ? 'bg-interactive-selection/20' : null,
                          isResponding ? 'opacity-60 cursor-not-allowed' : null,
                        )}
                      >
                        <div className="mt-0.5 shrink-0">
                          <RadioGroupItem value={String(index)} disabled={isResponding} />
                        </div>
                        <OptionBody option={option} selected={selected} />
                      </label>
                    );
                  })}
                </RadioGroup>
              )}

              <button
                type="button"
                onClick={() => {
                  setIsCustomMode(true);
                  setSelectedOptions([]);
                }}
                disabled={isResponding}
                className={cn(
                  'w-full px-1.5 py-1 text-left rounded transition-colors',
                  'hover:bg-interactive-hover/30',
                  isCustomMode ? 'bg-interactive-selection/20' : null,
                  isResponding ? 'opacity-60 cursor-not-allowed' : null,
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    name="edit"
                    className={cn('h-3.5 w-3.5', isCustomMode ? 'text-primary' : 'text-muted-foreground/50')}
                  />
                  <span className={cn('typography-meta', isCustomMode ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    Other (type an answer)
                  </span>
                </div>
              </button>

              {isCustomMode ? (
                <div className="pl-6 pr-1 pt-0.5">
                  <CustomAnswerTextarea
                    value={customText}
                    onValueChange={setCustomText}
                    placeholder="Your answer"
                    disabled={isResponding}
                    onKeyDown={handleKeyDown}
                  />
                </div>
              ) : null}
            </div>
          </div>

          <div className="px-2 pb-1.5 pt-1 flex items-center gap-1.5 border-t border-border/20">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isResponding || !hasSelection}
              className={cn(
                'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-colors',
                'bg-[rgb(var(--status-success)/0.1)] text-[var(--status-success)] hover:bg-[rgb(var(--status-success)/0.2)]',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              <Icon name="check" className="h-3 w-3" />
              Submit
            </button>

            <button
              type="button"
              onClick={handleDismiss}
              disabled={isResponding}
              className={cn(
                'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-colors',
                'bg-[rgb(var(--status-error)/0.1)] text-[var(--status-error)] hover:bg-[rgb(var(--status-error)/0.2)]',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              <Icon name="close" className="h-3 w-3" />
              Dismiss
            </button>

            {isResponding ? (
              <div className="ml-auto">
                <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

const OptionBody: React.FC<{
  option: { label: string; description?: string };
  selected: boolean;
}> = React.memo(function OptionBody({ option, selected }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        <span className={cn('typography-meta break-all', selected ? 'text-foreground font-medium' : 'text-foreground/80')}>
          {option.label}
        </span>
      </div>
      {option.description ? (
        <div className="typography-micro text-muted-foreground break-words">{option.description}</div>
      ) : null}
    </div>
  );
});
