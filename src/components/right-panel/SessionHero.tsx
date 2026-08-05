/** SessionHero: compact Inspector header — title, ID, start time, status chip. Usage stats live in the Context Window section below. */
import { Loader2, ShieldAlert, AlertTriangle, Pause, CircleStop } from 'lucide-react';
import type { Session, SessionStream, HeroStatus } from '@/types';
import { Badge } from '@/components/ui/badge';
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

  return (
    <div className="px-3 py-2.5 border-b border-border bg-gradient-to-b from-card to-background">
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
    </div>
  );
}
