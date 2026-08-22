import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import tideLogoUrl from '@/assets/tide-logo.png';
import tideTextUrl from '@/assets/tide-text.png';


export type ChipTone = 'default' | 'accent' | 'ok' | 'warn' | 'bad' | 'info' | 'reason' | 'openai' | 'anthropic';

const chipToneClass: Record<ChipTone, string> = {
  default: 'border-border bg-secondary text-muted-foreground',
  accent: 'text-primary bg-primary/10 border-primary/25',
  ok: 'text-success bg-success/10 border-success/25',
  warn: 'text-warning bg-warning/10 border-warning/25',
  bad: 'text-destructive bg-destructive/10 border-destructive/25',
  info: 'text-info bg-info/10 border-info/25',
  reason: 'text-reasoning bg-reasoning/10 border-reasoning/25',
  openai: 'text-openai bg-openai/10 border-openai/25',
  anthropic: 'text-anthropic bg-anthropic/10 border-anthropic/25',
};

export function Chip({
  tone = 'default',
  children,
  className,
}: {
  tone?: ChipTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.7857rem] font-medium border whitespace-nowrap',
        chipToneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

type DotTone = 'ok' | 'warn' | 'bad' | 'muted' | 'accent' | 'info';

const dotToneClass: Record<DotTone, string> = {
  ok: 'bg-success shadow-[0_0_8px_rgba(74,222,128,0.6)]',
  warn: 'bg-warning',
  bad: 'bg-destructive',
  muted: 'bg-muted-foreground/60',
  accent: 'bg-primary',
  info: 'bg-info shadow-[0_0_8px_rgba(96,165,250,0.6)]',
};

/** Status dot. `pulse="heartbeat"` = scale+glow for in-progress; `pulse="soft"` = opacity pulse. */
export function Dot({
  tone = 'muted',
  pulse,
  className,
}: {
  tone?: DotTone;
  pulse?: 'heartbeat' | 'soft';
  className?: string;
}) {
  const pulseClass = pulse === 'heartbeat' ? 'animate-heartbeat' : pulse === 'soft' ? 'animate-pulse-soft' : '';
  return <span className={cn('dot', dotToneClass[tone], pulseClass, className)} />;
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        'font-mono text-[0.7857rem] px-1.5 py-0.5 bg-secondary rounded text-muted-foreground',
        className,
      )}
    >
      {children}
    </code>
  );
}

/** Round avatar with provider initial. */
export function Avatar({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full text-[0.7857rem] font-semibold flex-shrink-0',
        className,
      )}
      style={style}
    >
      {children}
    </span>
  );
}

/** The Tide app icon. Rendered from the bundled PNG so it stays crisp at
 *  every size and matches the installed app icon exactly. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <img
      src={tideLogoUrl}
      alt="Tide"
      width={size}
      height={size}
      aria-hidden
      className="rounded-[22%] object-contain"
      style={{ width: size, height: size }}
    />
  );
}


export function LogoText({ size = 24 }: { size?: number }) {
  return (
    <img
      src={tideTextUrl}
      alt="Tide"
      height={size}
      aria-hidden
      className="rounded-[22%] object-contain"
      style={{ height: size }}
    />
  );
}
