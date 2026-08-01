/**
 * SessionHero — the status-first summary at the top of the Inspector tab.
 *
 * Replaces the old non-collapsible session header + the bottom context-window
 * section. Pins the three most-checked numbers (iteration, tool count, cost)
 * and the context-window meter at the top of the panel so they're always one
 * glance away, and shows the session's status as a chip (color + icon + text,
 * never color alone — a11y).
 *
 * When the session is blocked on a permission prompt, the third stat swaps
 * from Cost to a "Waiting mm:ss" timer — answering "how long has this been
 * sitting?" with the metric that matters in that moment.
 */
import { useEffect, useState } from 'react';
import { Loader2, ShieldAlert, AlertTriangle, Pause, CircleStop, DollarSign, Cpu, Wrench } from 'lucide-react';
import type { Session, SessionStream, HeroStatus } from '@/types';
import { Badge } from '@/components/ui/badge';
import { useModelOption, useAgentSettings } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { cn, formatNumber, formatRelative } from '@/lib/utils';

const CONTEXT_WARN_PCT = 80; // compaction threshold — amber ring above this

/**
 * Derive the hero status from the three runtime signals. Pure function so it
 * can be unit-tested in isolation.
 *
 * Priority order (most actionable first):
 *   1. blocked     — a permission card is pending; the user can unblock now
 *   2. error       — session ended in error; needs attention
 *   3. spend_capped— hit the spend limit; needs attention
 *   4. running     — a turn is in flight
 *   5. idle        — default
 *
 * Note: `blocked` beats `running` because a turn that's waiting on a
 * permission gate is technically isStreaming=true but not making progress —
 * the actionable framing is "blocked", not "running".
 */
export function deriveHeroStatus(
  session: Pick<Session, 'status'>,
  stream: Pick<SessionStream, 'isStreaming' | 'permissionRequest' | 'error'> | null | undefined,
): HeroStatus {
  if (stream?.permissionRequest?.toolCalls.length) return 'blocked';
  if (session.status === 'error' || stream?.error) return 'error';
  if (session.status === 'spend_capped') return 'spend_capped';
  if (stream?.isStreaming) return 'running';
  return 'idle';
}

// ─── status chip presentation ──────────────────────────────────────────
const STATUS_META: Record<
  HeroStatus,
  { label: string; icon: typeof Loader2; chipClass: string; iconClass: string }
> = {
  running: {
    label: 'Running',
    icon: Loader2,
    chipClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
    iconClass: 'animate-spin',
  },
  idle: {
    label: 'Idle',
    icon: Pause,
    chipClass: 'bg-secondary text-muted-foreground border-border',
    iconClass: '',
  },
  blocked: {
    label: 'Blocked',
    icon: ShieldAlert,
    chipClass: 'bg-amber-500/12 text-amber-300 border-amber-500/30',
    iconClass: '',
  },
  error: {
    label: 'Error',
    icon: AlertTriangle,
    chipClass: 'bg-destructive/12 text-destructive border-destructive/30',
    iconClass: '',
  },
  spend_capped: {
    label: 'Spend capped',
    icon: CircleStop,
    chipClass: 'bg-destructive/12 text-destructive border-destructive/30',
    iconClass: '',
  },
};

export function SessionHero({ session }: { session: Session }) {
  const stream = useUi((s) => (session.id ? s.streams[session.id] : undefined));
  const status = deriveHeroStatus(session, stream);

  // Iteration cap for the "Iteration: N / maxSteps" stat. Comes from the
  // user-configurable agentSettings (Settings → Permissions & caps) rather
  // than a hardcoded number, so it stays correct if the cap is changed.
  const { data: agentSettings } = useAgentSettings();
  const maxSteps = agentSettings?.maxSteps ?? 100;

  // Context-window math (moved here from the old ContextWindowSection).
  const model = useModelOption(null, session.modelId);
  const contextWindow = model?.contextWindow ?? 200_000;
  const u = session.usage;
  const liveContext = u.inputTokens + u.outputTokens + u.cacheWrite + u.reasoningTokens;
  const pctUsed = Math.min(100, (liveContext / contextWindow) * 100);
  const seg = (n: number) => Math.min(100, (n / contextWindow) * 100);
  const segments = [
    { label: 'Cache read', tokens: u.cacheRead, pct: seg(u.cacheRead), cls: 'bg-slate-500' },
    { label: 'Input', tokens: u.inputTokens, pct: seg(u.inputTokens), cls: 'bg-sky-400' },
    { label: 'Reasoning', tokens: u.reasoningTokens, pct: seg(u.reasoningTokens), cls: 'bg-purple-400' },
    { label: 'Output', tokens: u.outputTokens, pct: seg(u.outputTokens), cls: 'bg-primary' },
  ];

  // "Waiting" timer: counts up from when the prompt went pending.
  const [waitSecs, setWaitSecs] = useState(0);
  useEffect(() => {
    if (status !== 'blocked') { setWaitSecs(0); return; }
    const t = setInterval(() => setWaitSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [status]);
  const mm = Math.floor(waitSecs / 60).toString();
  const ss = (waitSecs % 60).toString().padStart(2, '0');

  const meta = STATUS_META[status];
  const Icon = meta.icon;

  return (
    <div className="px-3 py-2.5 border-b border-border bg-gradient-to-b from-card to-background">
      {/* Title row + status chip */}
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="text-[0.8rem] font-semibold truncate leading-tight">{session.title}</div>
          <div className="text-[0.8rem] flex items-center gap-1.5 mt-0.5">
            <Badge variant="outline" className="font-mono text-[0.9rem]">{session.id}</Badge>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">started {formatRelative(session.createdAt)}</span>
          </div>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[0.8rem] font-semibold whitespace-nowrap shrink-0',
            meta.chipClass,
          )}
        >
          <Icon className={cn('size-3', meta.iconClass)} aria-hidden="true" />
          {meta.label}
        </span>
      </div>

      {/* Stat strip — the three most-checked numbers. */}
      <div className="grid grid-cols-3 gap-px mt-3 bg-border border border-border rounded-md overflow-hidde">
        <Stat icon={<Cpu className="size-3" />} label="Iteration">
          <span className="text-[0.75rem]">{stream?.iteration ?? u.calls}</span><span className="text-[0.75rem] text-muted-foreground font-normal"> / {maxSteps}</span>
        </Stat>
        <Stat icon={<Wrench className="size-3" />} label="Tools">
          <span className="text-[0.75rem]">{formatNumber(u.calls)}</span><span className="text-[0.75rem] text-muted-foreground font-normal"> calls</span>
        </Stat>
        {status === 'blocked' ? (
          <Stat icon={<Loader2 className="size-3 animate-spin" />} label="Waiting">
            {mm}:{ss}
          </Stat>
        ) : (
          <Stat icon={<DollarSign className="size-2.5" />} label="Cost">
            <span className="text-[0.75rem]">{session.costUsd.toFixed(3)}</span><span className="text-[0.75rem] text-muted-foreground font-normal"> USD</span>
          </Stat>
        )}
      </div>

      {/* Pinned context-window meter (moved from the bottom section). */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between text-[0.65rem] mb-1.5">
          <span className="font-semibold uppercase tracking-wider text-muted-foreground">Context</span>
          <span className="font-mono text-muted-foreground">
            <span className="text-foreground text-[0.75rem] font-semibold">{formatNumber(liveContext)}</span> / {formatNumber(contextWindow)} ·{' '}
            <span className={pctUsed >= CONTEXT_WARN_PCT ? 'text-amber-300 text-[0.75rem]' : 'text-[0.75rem]'}>{pctUsed.toFixed(1)}%</span>
          </span>
        </div>
        <div
          className={cn(
            'relative h-1.5 rounded-full overflow-hidden bg-muted',
            pctUsed >= CONTEXT_WARN_PCT && 'ring-1 ring-amber-500/40',
          )}
          role="progressbar"
          aria-label="Context window usage"
          aria-valuenow={Math.round(pctUsed)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="absolute inset-0 flex">
            {segments.map((s, i) => (
              <div
                key={i}
                className={cn('h-full', s.cls)}
                style={{ width: `${s.pct}%` }}
                title={`${s.label}: ${formatNumber(s.tokens)} tok`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One cell of the 3-stat strip. */
function Stat({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="bg-background px-2.5 py-2">
      <div className="flex items-center gap-1 text-[0.70rem] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="font-mono text-[13px] font-semibold mt-0.5 tabular-nums tracking-tight items-center justify-center">{children}</div>
    </div>
  );
}
