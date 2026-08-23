/** PermissionCard — approval prompt for a gated tool call. One design for all
 *  surfaces (floating overlay, inline tool row): elevated card with a colored
 *  accent rail, a single header line, the exact command, and split actions.
 *  'blocked' (plan mode) swaps to a destructive rail with escalate/cancel. */

import { ShieldAlert, ShieldBan, Timer, MessageCircleQuestion, FileClock, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AutonomyMode, ToolCall } from '@/types';
import { allowRuleLabel } from '@/lib/permission-label';
import { Button } from '@/components/ui/button';
import { SplitButton } from '@/components/ui/split-button';

const PERMISSION_TIMEOUT_SECONDS = 10 * 60;

const RISK_LABEL: Record<ToolCall['riskTier'], string> = {
  read_only: 'read-only',
  write: 'write',
  destructive: 'destructive',
};

export function PermissionCard({
  call,
  timeoutAt,
  onApprove,
  onReject,
}: {
  call: ToolCall;
  /** Epoch ms when the orchestrator will auto-reject. Optional. */
  timeoutAt?: number;
  /** Approve, optionally escalating the autonomy mode for the turn and/or
   *  adding an "always allow" rule ('session' = in-memory for this app run,
   *  true = persisted to .agent/settings.json). */
  onApprove?: (newMode?: AutonomyMode, remember?: boolean | 'session') => void;
  onReject?: (reason?: string) => void;
}) {
  const blocked = call.gateDecision === 'blocked';
  const rail = blocked ? 'bg-destructive' : 'bg-warning';
  const iconTone = blocked ? 'text-destructive' : 'text-warning';

  const initialRemaining = timeoutAt
    ? Math.max(0, Math.floor((timeoutAt - Date.now()) / 1000))
    : PERMISSION_TIMEOUT_SECONDS;
  const [remaining, setRemaining] = useState(initialRemaining);
  const [explaining, setExplaining] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    const t = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (remaining === 0 && onReject) {
      onReject(blocked ? 'cancelled (timeout)' : 'permission timeout');
    }
  }, [remaining, onReject, blocked]);

  const mm = Math.floor(remaining / 60).toString().padStart(1, '0');
  const ss = (remaining % 60).toString().padStart(2, '0');

  const isCommand = call.toolName === 'bash' || call.display?.kind === 'command';
  const command = isCommand
    ? (call.display?.kind === 'command' ? call.display.command : call.argPreview) || '(no command)'
    : call.argPreview;

  // Dynamic per-command label — mirrors the exact session rule main derives
  // (e.g. `cat` → "cat *", `git push` → "git push *", edits → "src/lib/*").
  const allowDisplay = allowRuleLabel(call);

  const handleReject = () => {
    if (explaining && reason.trim()) onReject?.(reason.trim());
    else onReject?.();
  };

  return (
    <div
      role="alertdialog"
      aria-label={`${blocked ? 'Blocked by plan mode' : 'Permission required'}: ${call.toolName}`}
      className="relative overflow-hidden rounded-xl border border-border bg-card shadow-lg shadow-black/25 ring-1 ring-black/5 animate-slide-up"
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${rail}`} aria-hidden="true" />

      {/* Header — one line: identity + tier + countdown */}
      <div className="flex items-center gap-2 pl-4 pr-3 pt-2.5">
        {blocked ? (
          <ShieldBan className={`size-4 shrink-0 ${iconTone}`} aria-hidden="true" />
        ) : (
          <ShieldAlert className={`size-4 shrink-0 ${iconTone}`} aria-hidden="true" />
        )}
        <span className="text-[0.9286rem] font-semibold text-foreground font-mono">
          {call.toolName}
        </span>
        <span
          className={`rounded px-1.5 py-px text-[0.6429rem] font-medium uppercase tracking-wide ${
            blocked ? 'bg-destructive/15 text-destructive' : 'bg-warning/15 text-warning'
          }`}
        >
          {blocked ? 'blocked · plan mode' : RISK_LABEL[call.riskTier]}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[0.7857rem] text-muted-foreground/60 tabular-nums">
          <Timer className="size-3" aria-hidden="true" />
          {mm}:{ss}
        </span>
      </div>

      {/* The exact action — the command/args speak for themselves */}
      <div className="px-4 pt-2 pb-1">
        {blocked && (
          <p className="text-[0.7857rem] leading-snug text-muted-foreground/80 pb-1.5">
            Plan mode is read-only. Switch to full mode to let this and the
            rest of the turn's writes run.
          </p>
        )}
        <div className="rounded-lg border border-input bg-background/70 px-3 py-2 font-mono text-xs text-foreground break-all">
          {isCommand ? (
            <>
              <span className="text-muted-foreground/60 select-none">$ </span>
              {command}
            </>
          ) : (
            command || <span className="text-muted-foreground/50">no arguments</span>
          )}
        </div>
      </div>

      {explaining && !blocked && (
        <div className="px-4 pt-1.5">
          <input
            autoFocus
            type="text"
            placeholder="Why reject? (goes back to the model)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleReject();
              if (e.key === 'Escape') setExplaining(false);
            }}
            aria-label="Reason for rejecting (optional)"
            className="w-full text-xs bg-background border border-input rounded-md px-2 py-1.5 text-foreground placeholder:text-muted-foreground/70 outline-none transition-colors focus-visible:border-warning/60 focus-visible:ring-2 focus-visible:ring-warning/25"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between gap-2 px-4 pt-2 pb-3">
        {blocked ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onReject?.('cancelled in plan mode')}
              disabled={!onReject}
            >
              Cancel
            </Button>
            <Button variant="default" size="sm" onClick={() => onApprove?.('full')} disabled={!onApprove}>
              <Zap className="size-3.5" />
              Switch to full mode
            </Button>
          </>
        ) : (
          <>
            <SplitButton
              label={explaining ? 'Send' : 'Reject'}
              onPrimary={handleReject}
              variant="ghost"
              menuAlign="start"
              toggleAriaLabel="More reject options"
              items={[
                {
                  label: 'Reject & explain',
                  hint: 'Send a reason back to the model',
                  icon: <MessageCircleQuestion />,
                  onSelect: () => setExplaining((v) => !v),
                },
              ]}
            />
            <SplitButton
              label="Allow"
              onPrimary={() => onApprove?.()}
              variant="default"
              menuAlign="end"
              toggleAriaLabel="More allow options"
              items={[
                ...(allowDisplay
                  ? [{
                      label: `Allow (${allowDisplay})`,
                      hint: 'Auto-allow matching calls this session',
                      icon: <FileClock />,
                      onSelect: () => onApprove?.(undefined, 'session'),
                    }]
                  : []),
                {
                  label: 'Switch to Full Mode',
                  hint: 'All tools auto-run for the rest of this turn',
                  icon: <Zap />,
                  onSelect: () => onApprove?.('full'),
                },
              ]}
            />
          </>
        )}
      </div>
    </div>
  );
}
