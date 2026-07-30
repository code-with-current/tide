import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Settings page header: title + optional description + optional action. */
export function SettingsHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-xs text-muted-foreground mt-1 max-w-prose">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** A titled group with optional hint. */
export function SettingsGroup({
  title,
  hint,
  children,
  className,
}: {
  title?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('mb-5', className)}>
      {title && (
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">{title}</h2>
          {hint && <span className="text-[11px] text-muted-foreground/60">{hint}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A bordered row with a label/description on the left and a control on the right. */
export function SettingsRow({
  title,
  description,
  children,
  last,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-4 px-4 py-2.5',
        !last && 'border-b border-input',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        {description && <div className="text-[11px] text-muted-foreground/60 mt-0.5">{description}</div>}
      </div>
      {children && <div className="flex-shrink-0">{children}</div>}
    </div>
  );
}

/** Card wrapper used to group related rows. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg bg-card border border-border overflow-hidden', className)}>
      {children}
    </div>
  );
}
