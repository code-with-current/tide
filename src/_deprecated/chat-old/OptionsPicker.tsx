import { useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Parsed shape of an ```options fenced block.
 * Matches what the system prompt tells the model to emit.
 */
export interface OptionsBlock {
  question: string;
  /** true = checkboxes (multi-select), false/omitted = radios (single). */
  multiple?: boolean;
  options: string[];
}

/** Parse the inner text of an ```options fence; returns null on malformed JSON. Handles plain-string and object-form options (label + description). */
export function parseOptionsBlock(json: string): OptionsBlock | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.question !== 'string') return null;
    if (!Array.isArray(parsed.options)) return null;
    // Normalize each option to a display string: plain string (as-is); {label, description} → "label — description" (or label); {value, text} → same pattern with value as label; other → JSON.stringify fallback.
    const opts = parsed.options.map((o: unknown) => {
      if (typeof o === 'string') return o;
      if (typeof o === 'number' || typeof o === 'boolean') return String(o);
      if (o && typeof o === 'object') {
        const obj = o as Record<string, unknown>;
        const label = obj.label ?? obj.text ?? obj.value ?? obj.name;
        const desc = obj.description ?? obj.desc ?? obj.detail;
        if (typeof label === 'string') {
          return typeof desc === 'string' && desc ? `${label} — ${desc}` : label;
        }
      }
      return JSON.stringify(o);
    });
    if (opts.length === 0) return null;
    return {
      question: parsed.question,
      multiple: parsed.multiple === true,
      options: opts,
    };
  } catch {
    return null;
  }
}

/** Interactive picker for an ```options block: radios (single-select) or checkboxes (multi-select); submit disabled until a selection is made. */
export function OptionsPicker({
  block,
  disabled = false,
  onPick,
}: {
  block: OptionsBlock;
  /** Disable after the user has picked once (the picker is single-use). */
  disabled?: boolean;
  onPick: (selection: string[]) => void;
}) {
  const multiple = block.multiple === true;
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const toggle = (option: string) => {
    if (disabled || submitted) return;
    if (multiple) {
      setSelected((s) => (s.includes(option) ? s.filter((o) => o !== option) : [...s, option]));
    } else {
      setSelected([option]);
    }
  };

  const handleSubmit = () => {
    if (selected.length === 0 || submitted) return;
    setSubmitted(true);
    onPick(selected);
  };

  return (
    <div className="rounded-lg border border-border bg-secondary overflow-hidden">
      {/* Header — same visual weight as a tool card */}
      <div className="px-3 py-2 border-b border-input bg-card flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
          {multiple ? 'Choose any' : 'Choose one'}
        </span>
        <div className="flex-1" />
        {submitted && (
          <span className="text-[10px] text-success font-medium flex items-center gap-1">
            <Check className="size-3" /> answered
          </span>
        )}
      </div>

      {/* Question */}
      <div className="px-3 pt-3 pb-1.5 text-sm text-foreground">{block.question}</div>

      {/* Options */}
      <div className="px-2 pb-2 flex flex-col gap-0.5">
        {block.options.map((option, i) => {
          const isSelected = selected.includes(option);
          return (
            <Button
              key={i}
             
              onClick={() => toggle(option)}
              disabled={disabled || submitted}
              className={cn(
                'flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-sm transition-colors',
                'hover:bg-accent disabled:hover:bg-transparent disabled:cursor-default',
                isSelected ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {/* Radio circle or checkbox square */}
              <span
                className={cn(
                  'flex-shrink-0 size-4 border flex items-center justify-center transition-colors',
                  multiple ? 'rounded-[3px]' : 'rounded-full',
                  isSelected
                    ? 'bg-primary border-accent text-white'
                    : 'border-border bg-transparent',
                )}
              >
                {isSelected &&
                  (multiple ? <Check className="size-3" /> : <span className="size-1.5 rounded-full bg-white" />)}
              </span>
              <span className="flex-1">{option}</span>
            </Button>
          );
        })}
      </div>

      {/* Submit row */}
      <div className="px-3 py-2 border-t border-input flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground/60">
          {selected.length === 0
            ? 'Pick an option below'
            : multiple
              ? `${selected.length} selected`
              : 'Ready'}
        </span>
        <div className="flex-1" />
        <Button
         
          onClick={handleSubmit}
          disabled={selected.length === 0 || submitted || disabled}
          className={cn(
            'text-xs font-medium px-3 py-1.5 rounded-md transition-colors',
            selected.length > 0 && !submitted
              ? 'bg-primary text-white hover:bg-accent/90'
              : 'bg-primary text-muted-foreground/60 cursor-default',
          )}
        >
          {submitted ? 'Sent' : 'Send'}
        </Button>
      </div>
    </div>
  );
}

