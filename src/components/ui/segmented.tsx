import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label?: ReactNode;
  icon?: ReactNode;
  title?: string;
  accent?: boolean;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'inline-flex bg-secondary border border-border rounded-md p-0.5 gap-px',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center gap-1 rounded font-medium transition-colors',
              size === 'sm' ? 'px-2 py-1 text-[0.8571rem]' : 'px-2.5 py-1 text-[0.8571rem]',
              active
                ? cn(
                    'bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.3),inset_0_0_0_1px_rgba(255,255,255,0.04)]',
                    opt.accent && 'text-primary',
                  )
                : 'text-muted-foreground/60 hover:text-muted',
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
