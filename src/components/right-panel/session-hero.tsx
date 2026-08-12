/** SessionHero: compact Inspector header — title, status chip, meta line, and
 *  a stat grid (total time, last active, tokens, cost). Usage stats live in the
 *  Context Window section below. */
import { useMemo, type ReactNode } from 'react';
import { Loader2, ShieldAlert, AlertTriangle, Pause, CircleStop } from 'lucide-react';
import type { Session, SessionStream, HeroStatus } from '@/types';
import { useShallow } from 'zustand/react/shallow';
import { useUi } from '@/lib/stores/ui';
import { cn, formatRelative } from '@/lib/utils';

/**
 * Derive the hero status from the three runtime signals. Pure function so it
 * can be unit-tested in isolation.
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

/** Format a millisecond duration compactly: 45s · 4m 12s · 1h 23m. */
function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function Stat({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0 rounded-md bg-secondary/40 border border-border px-2 py-1.5" title={title}>
      <span className="text-[0.6rem] uppercase tracking-wider text-muted-foreground/60 font-medium truncate">{label}</span>
      <span className="text-[0.85rem] font-semibold tabular-nums leading-none truncate">{value}</span>
    </div>
  );
}

export function SessionHero({ session }: { session: Session }) {
  // Only subscribe to the fields needed for the status chip.
  const streamFields = useUi(
    useShallow((s) => {
      if (!session.id) return null;
      const st = s.streams[session.id];
      if (!st) return null;
      return {
        isStreaming: st.isStreaming,
        permissionRequest: st.permissionRequest,
        error: st.error,
      };
    }),
  );
  const status = deriveHeroStatus(session, streamFields);
  const meta = STATUS_META[status];
  const Icon = meta.icon;

  // Cumulative working time = sum of each assistant turn's wall-clock totalMs.
  const { turns, totalMs } = useMemo(() => {
    let t = 0, ms = 0;
    for (const m of session.messages ?? []) {
      if (m.role === 'assistant') {
        t++;
        ms += m.totalMs ?? 0;
      }
    }
    return { turns: t, totalMs: ms };
  }, [session.messages]);

  return (
    <div className="bg-background">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[0.85rem] font-semibold truncate leading-tight">{session.title || 'Untitled'}</div>
          <div className="text-[0.7rem] text-muted-foreground flex items-center gap-1.5 mt-1 min-w-0">
            <span className="font-mono truncate">{session.modelId}</span>
            <span className="text-muted-foreground/40 shrink-0">·</span>
            <span className="shrink-0">{turns} {turns === 1 ? 'turn' : 'turns'}</span>
            <span className="text-muted-foreground/40 shrink-0">·</span>
            <span className="shrink-0">started {formatRelative(session.createdAt)}</span>
          </div>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[0.72rem] font-semibold whitespace-nowrap shrink-0',
            meta.chipClass,
          )}
        >
          <Icon className={cn('size-3', meta.iconClass)} aria-hidden="true" />
          {meta.label}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-1.5 mt-2.5">
        <Stat label="Total time" value={formatDuration(totalMs)} title="Cumulative working time across turns" />
        <Stat label="Last active" value={formatRelative(session.updatedAt)} title="Most recent activity" />
      </div>
    </div>
  );
}
