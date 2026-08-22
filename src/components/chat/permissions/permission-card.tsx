import { ShieldAlert, ShieldBan, Timer, MessageCircleQuestion, FileClock, PencilLine } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AutonomyMode, ToolCall } from '@/types';
import { Chip, type ChipTone } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { SplitButton } from '@/components/ui/split-button';

const PERMISSION_TIMEOUT_SECONDS = 10 * 60;

const RISK_LABEL: Record<ToolCall['riskTier'], string> = {
  read_only: 'read-only',
  write: 'write',
  destructive: 'destructive',
};

const TOOL_LABEL: Record<string, string> = {
  bash: 'run a shell command',
  git: 'run a git command',
  edit_file: 'edit a file',
  multi_edit: 'edit a file',
  write_file: 'write a file',
  notebook_edit: 'edit a notebook',
};

/** Visual tone per gate state. Carried by icon + label too, so meaning is
 *  never color-alone (a11y: color-contrast / color-only rules). */
type Tone = {
  border: string;
  bar: string;
  icon: string;
  title: string;
  chip: ChipTone;
  label: string;
  expire: string;
};
const TONES: Record<'ask' | 'blocked', Tone> = {
  ask: {
    border: 'border-warning/40',
    bar: 'bg-warning/[0.07]',
    icon: 'text-warning',
    title: 'text-warning',
    chip: 'warn',
    label: 'Permission required',
    expire: 'auto-reject',
  },
  blocked: {
    border: 'border-destructive/40',
    bar: 'bg-destructive/[0.07]',
    icon: 'text-destructive',
    title: 'text-destructive',
    chip: 'bad',
    label: 'Blocked by plan mode',
    expire: 'auto-cancel',
  },
};

/** Permission card for tool approval. 'blocked' (plan mode) → escalate/cancel only; 'ask' → Approve + mode escalation. Used inline in TurnBlock and in the Inspector. */
export function PermissionCard({
  call,
  timeoutAt,
  onApprove,
  onReject,
  variant = 'inline',
}: {
  call: ToolCall;
  /** Epoch ms when the orchestrator will auto-reject. Optional. */
  timeoutAt?: number;
  /** Approve, optionally escalating the autonomy mode for the turn and/or
   *  adding an "always allow" rule (session = runtime, project = .agent/settings.json). */
  onApprove?: (newMode?: AutonomyMode, remember?: boolean) => void;
  onReject?: (reason?: string) => void;
  /** 'inline' (default — flat secondary links, used in the chat TurnBlock) or
   *  'split' (secondary actions collapsed into SplitButton dropdowns, used in
   *  the Inspector's cramped Review section). Same callbacks either way. */
  variant?: 'inline' | 'split';
}) {
  const blocked = call.gateDecision === 'blocked';
  const tone = TONES[blocked ? 'blocked' : 'ask'];
  const Icon = blocked ? ShieldBan : ShieldAlert;

  // Derive the initial countdown from `timeoutAt` if provided; else default.
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

  // Auto-reject when the countdown hits zero. Blocked prompts also expire
  // (treated as cancel) so a forgotten plan-mode ask can't wedge the turn.
  useEffect(() => {
    if (remaining === 0 && onReject) {
      onReject(blocked ? 'cancelled (timeout)' : 'permission timeout');
    }
  }, [remaining, onReject, blocked]);

  const mm = Math.floor(remaining / 60).toString().padStart(1, '0');
  const ss = (remaining % 60).toString().padStart(2, '0');

  const action = TOOL_LABEL[call.toolName] ?? 'run a tool';
  const isCommand = call.toolName === 'bash' || call.display?.kind === 'command';
  const command = isCommand
    ? (call.display?.kind === 'command' ? call.display.command : call.argPreview) || '(no command)'
    : call.argPreview;

  const handleReject = () => {
    if (explaining && reason.trim()) onReject?.(reason.trim());
    else onReject?.();
  };

  return (
    <div
      role="alertdialog"
      aria-label={`${tone.label}: ${call.toolName}`}
      className={`bg-card border ${tone.border} rounded-lg overflow-hidden text-[0.9286rem] animate-slide-up shadow-sm @container`}
    >
      {/* Header — tone band. Icon + label carry the meaning; color reinforces. */}
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 ${tone.bar} border-b border-input`}>
        <Icon className={`size-3.5 ${tone.icon}`} aria-hidden="true" />
        <span className={`font-medium text-xs ${tone.title}`}>{tone.label}</span>
        <Chip tone={tone.chip}>
          {RISK_LABEL[call.riskTier]} · {call.toolName}
        </Chip>
        {/* ml-auto (not a flex-1 spacer) plays well with flex-wrap: when the
            chip + countdown don't fit one line, the countdown wraps right-aligned. */}
        <span className="ml-auto text-muted-foreground text-[0.7857rem] flex items-center gap-1 tabular-nums">
          <Timer className="size-2.5" aria-hidden="true" /> {tone.expire} {mm}:{ss}
        </span>
      </div>

      <div className="p-3 space-y-2.5">
        {/* foreground/80 keeps the load-bearing line above the 4.5:1 floor
            even on a card background; muted is reserved for secondary text. */}
        <div className="text-xs text-foreground/80">
          {blocked ? (
            <>
              Plan mode is read-only — writes aren't allowed. Switch to edit
              mode to let this and the rest of the turn's writes run.
            </>
          ) : (
            <>Tide wants to {action}.</>
          )}
        </div>

        {/* What the tool will do — one clean render path for both states. */}
        <div className="font-mono text-xs px-3 py-2 rounded-md bg-background border border-input text-foreground break-all">
          {isCommand ? (
            <>
              <span className="text-muted-foreground/70 select-none">$</span>{' '}
              {command}
            </>
          ) : (
            <>
              <span className="text-muted-foreground/70">{call.toolName}</span>
              {command ? ` ${command}` : ''}
            </>
          )}
        </div>

        {explaining && !blocked && (
          <input
            autoFocus
            type="text"
            placeholder="Why reject? (optional, goes back to the model)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleReject();
              if (e.key === 'Escape') setExplaining(false);
            }}
            aria-label="Reason for rejecting (optional)"
            className="w-full text-xs bg-background border border-input rounded-md px-2 py-1.5 text-foreground placeholder:text-muted-foreground/70 outline-none transition-colors focus-visible:border-warning/60 focus-visible:ring-2 focus-visible:ring-warning/25"
          />
        )}

        {/* Action area — two render paths:
            inline (default): flat primary buttons + a wrapped secondary link row.
              Used in the chat TurnBlock where width is generous.
            split: SplitButton dropdowns that collapse the secondary actions
              behind Reject▾ / Approve▾. Used in the Inspector's narrow Review
              section. Same callbacks either way; only presentation differs. */}
        {variant === 'split' ? (
          blocked ? (
            // Blocked mode has no Approve variants — render plain buttons
            // (Cancel + Switch to full mode), no dropdowns.
            <div className="flex items-center gap-2 mt-2.5">
              <Button variant="secondary" size="sm" onClick={() => onReject?.('cancelled in plan mode')} disabled={!onReject}>
                Cancel
              </Button>
              <Button variant="default" size="sm" className="ml-auto" onClick={() => onApprove?.('full')} disabled={!onApprove}>
                Switch to full mode
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 mt-2.5">
              <SplitButton
                label={explaining ? 'Send' : 'Reject'}
                onPrimary={handleReject}
                  variant="destructive"
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
                label="Approve"
                onPrimary={() => onApprove?.()}
                variant="default"
                menuAlign="end"
                toggleAriaLabel="More approve options"
                items={[
                  {
                    label: 'Always Allow',
                    hint: 'Save rule to .agent/settings.json',
                    icon: <FileClock />,
                    onSelect: () => onApprove?.(undefined, true),
                  },
                  {
                    label: 'Switch to Full Mode',
                    hint: 'Auto-run all tools (bash, edits, git) this turn',
                    icon: <PencilLine />,
                    onSelect: () => onApprove?.('full'),
                  },
                ]}
              />
            </div>
          )
        ) : (
          <>
            {/* Primary row — exactly two solid buttons. Width-aware via a container
                query on the card root: stacked full-width in a narrow panel (the
                right Inspector panel), side-by-side once the container is ≥300px.
                Secondary actions live on a wrapped link row below so this row
                never holds more than two buttons. */}
            <div className="flex flex-col @[300px]:flex-row items-stretch @[300px]:items-center gap-2">
              {blocked ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onReject?.('cancelled in plan mode')}
                    disabled={!onReject}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    className="@[300px]:ml-auto"
                    onClick={() => onApprove?.('full')}
                    disabled={!onApprove}
                  >
                    Switch to full mode
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="destructive" size="sm" onClick={handleReject} disabled={!onReject}>
                    {explaining ? 'Send' : 'Reject'}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    className="@[300px]:ml-auto"
                    onClick={() => onApprove?.()}
                    disabled={!onApprove}
                  >
                    Approve
                  </Button>
                </>
              )}
            </div>

            {/* Secondary actions — subtle links that wrap to as many lines as the
                panel needs. Escalation + reject-with-reason; deliberately not in
                the primary row. Hidden in blocked state (the only forward path
                there is mode escalation, already in the primary row). */}
            {!blocked && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7857rem] mt-1">
                <button
                  type="button"
                  onClick={() => setExplaining((v) => !v)}
                  className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                >
                  {explaining ? 'Cancel' : 'Reject & explain'}
                </button>
                <span className="text-muted-foreground/30 select-none">·</span>
                <button
                  type="button"
                  onClick={() => onApprove?.('full')}
                  disabled={!onApprove}
                  title="Approve and switch to full mode — all tools auto-run"
                  className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-50 disabled:pointer-events-none"
                >
                  full mode
                </button>
                <button
                  type="button"
                  onClick={() => onApprove?.(undefined, true)}
                  disabled={!onApprove}
                  title="Always allow — saves a rule to .agent/settings.json"
                  className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-50 disabled:pointer-events-none"
                >
                  always allow
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
