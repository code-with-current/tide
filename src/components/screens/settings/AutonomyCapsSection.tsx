import { useEffect, useState } from 'react';
import {
  Map,
  Shield,
  Pencil,
  Zap,
  Repeat,
  Timer,
  Lock,
  Check,
  DollarSign,
  Brain,
  ScrollText,
  AlertTriangle,
  Pause,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/ui/segmented';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';
import { cn } from '@/lib/utils';
import type { AutonomyMode } from '@/types';

type AgentSettingsState = {
  defaultAutonomy: AutonomyMode;
  maxSteps: number;
  permissionTimeoutMin: number;
  planModeDryRun: boolean;
  auditShellCommands: boolean;
};

// Risk-tier metadata drives both the visual accent and the helper copy.
// Ordered low → high autonomy so the grid reads as a spectrum.
const MODES: {
  value: AutonomyMode;
  icon: typeof Map;
  label: string;
  hint: string;
  tier: 'info' | 'success' | 'warning' | 'danger';
  recommended?: boolean;
}[] = [
  { value: 'plan', icon: Map, label: 'Plan only', hint: 'Proposes changes, never executes', tier: 'info' },
  { value: 'ask', icon: Shield, label: 'Ask', hint: 'Confirm every edit & shell call', tier: 'success', recommended: true },
  { value: 'edit', icon: Pencil, label: 'Edit', hint: 'Auto-edits files, asks before shell', tier: 'warning' },
  { value: 'full', icon: Zap, label: 'Full access', hint: 'Direct access to this machine', tier: 'danger' },
];

const TIERStyles: Record<
  'info' | 'success' | 'warning' | 'danger',
  { dot: string; ring: string; tint: string; glow: string; text: string }
> = {
  info: {
    dot: 'bg-[var(--info)]',
    ring: 'border-[var(--info)]/45',
    tint: 'bg-[var(--info)]/10',
    glow: 'shadow-[0_0_0_1px_var(--info)]',
    text: 'text-[var(--info)]',
  },
  success: {
    dot: 'bg-[var(--success)]',
    ring: 'border-[var(--success)]/45',
    tint: 'bg-[var(--success)]/10',
    glow: 'shadow-[0_0_0_1px_var(--success)]',
    text: 'text-[var(--success)]',
  },
  warning: {
    dot: 'bg-[var(--warning)]',
    ring: 'border-[var(--warning)]/45',
    tint: 'bg-[var(--warning)]/10',
    glow: 'shadow-[0_0_0_1px_var(--warning)]',
    text: 'text-[var(--warning)]',
  },
  danger: {
    dot: 'bg-[var(--error)]',
    ring: 'border-[var(--error)]/45',
    tint: 'bg-[var(--error)]/10',
    glow: 'shadow-[0_0_0_1px_var(--error)]',
    text: 'text-[var(--error)]',
  },
};

export function AutonomyCapsSection() {
  const [settings, setSettings] = useState<AgentSettingsState | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    window.tideIpc?.getAgentSettings().then((s) => setSettings(s as AgentSettingsState));
  }, []);

  // Auto-save: whenever a field changes, persist it. The savingKey flag drives
  // a tiny "saved" pulse on the edited control so the user sees confirmation.
  const update = <K extends keyof AgentSettingsState>(key: K, value: AgentSettingsState[K]) => {
    if (!settings) return;
    const next = { ...settings, [key]: value };
    setSettings(next);
    setSavingKey(key);
    window.tideIpc?.updateAgentSettings({ [key]: value }).then(() => {
      setTimeout(() => setSavingKey(null), 900);
    });
  };

  if (!settings) {
    return <SettingsHeader title="Permissions & caps" description="Loading…" />;
  }

  return (
    <>
      <SettingsHeader
        title="Permissions & caps"
        description="How much the agent can do without asking, and the limits that catch runaway turns."
      />

      {/* ── Default autonomy: risk-tier picker ── */}
      <SettingsGroup title="Default permissions for new sessions">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {MODES.map((m) => {
            const active = settings.defaultAutonomy === m.value;
            const s = TIERStyles[m.tier];
            const Icon = m.icon;
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => update('defaultAutonomy', m.value)}
                className={cn(
                  'group relative text-left rounded-xl border p-3 transition-all duration-150 cursor-pointer overflow-hidden',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  active
                    ? cn(s.tint, s.ring)
                    : 'bg-card border-border hover:border-border/80 hover:bg-secondary/60',
                )}
              >
                {/* Top accent stripe — only visible when active, tinted by tier. */}
                <span
                  className={cn(
                    'absolute inset-x-0 top-0 h-[2px] transition-opacity',
                    active ? s.dot : 'opacity-0',
                  )}
                />
                <div className="flex items-start justify-between">
                  <div
                    className={cn(
                      'flex items-center justify-center size-7 rounded-lg border transition-colors',
                      active ? cn(s.tint, s.ring) : 'bg-secondary/50 border-border',
                    )}
                  >
                    <Icon className={cn('size-3.5', active ? s.text : 'text-muted-foreground')} />
                  </div>
                  {active ? (
                    <span className={cn('flex items-center justify-center size-4 rounded-full', s.dot)}>
                      <Check className="size-2.5 text-black" />
                    </span>
                  ) : m.recommended ? (
                    <span className="text-[8.5px] uppercase tracking-wide font-semibold text-muted-foreground/55">
                      recommended
                    </span>
                  ) : null}
                </div>
                <div className="mt-2.5 flex items-center gap-1.5">
                  <span className={cn('text-[12.5px] font-semibold', active && 'text-foreground')}>
                    {m.label}
                  </span>
                  {m.value === 'full' && <Lock className={cn('size-3', active ? s.text : 'text-muted-foreground/50')} />}
                </div>
                <div className="text-[10.5px] text-muted-foreground/65 mt-0.5 leading-snug">{m.hint}</div>
              </button>
            );
          })}
        </div>
        {savingKey === 'defaultAutonomy' && (
          <div className="mt-1.5 text-[10px] text-[var(--success)] flex items-center gap-1">
            <Check className="size-2.5" /> Saved
          </div>
        )}
      </SettingsGroup>

      {/* ── Active limits ── the two caps that are actually enforced today */}
      <SettingsGroup title="Limits">
        <Card>
          <SettingsRow
            title="Iteration cap per turn"
            description="Max model calls per user turn before a forced iteration_limit stop."
          >
            <NumberField
              icon={<Repeat className="size-3.5" />}
              value={settings.maxSteps}
              unit="turns"
              saved={savingKey === 'maxSteps'}
              onChange={(v) => v > 0 && update('maxSteps', v)}
            />
          </SettingsRow>
          <SettingsRow
            title="Permission-prompt timeout"
            description="Auto-reject if the user doesn't decide within this window."
            last
          >
            <NumberField
              icon={<Timer className="size-3.5" />}
              value={settings.permissionTimeoutMin}
              unit="min"
              saved={savingKey === 'permissionTimeoutMin'}
              onChange={(v) => v > 0 && update('permissionTimeoutMin', v)}
            />
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* ── Safety nets ── */}
      <SettingsGroup title="Safety nets">
        <Card>
          <SettingsRow
            title="Plan mode is a dry run"
            description="Mutating tools return a not-executed result so the model can reason about them."
          >
            <div className="flex items-center gap-2">
              {savingKey === 'planModeDryRun' && <SavedDot />}
              <Switch
                checked={settings.planModeDryRun}
                onCheckedChange={(v) => update('planModeDryRun', v)}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title="Audit log in Full access"
            description="Persist every shell command to a tamper-evident, append-only log."
            last
          >
            <div className="flex items-center gap-2">
              {savingKey === 'auditShellCommands' && <SavedDot />}
              <Switch
                checked={settings.auditShellCommands}
                onCheckedChange={(v) => update('auditShellCommands', v)}
              />
            </div>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* ── Coming soon ── spend & token caps that aren't wired yet */}
      <SettingsGroup
        title="Spend & reasoning caps"
        hint={
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/45 font-semibold">
            <Pause className="size-2.5" /> Coming soon
          </span>
        }
      >
        <Card className="opacity-60">
          <SettingsRow title="Spend cap per session" description="Pauses the loop when the running usage total crosses this.">
            <NumberField icon={<DollarSign className="size-3.5" />} value={5} unit="USD" disabled onChange={() => {}} />
          </SettingsRow>
          <SettingsRow title="Daily spend cap" description="Hard stop across all sessions on this machine.">
            <NumberField icon={<DollarSign className="size-3.5" />} value={20} unit="USD" disabled onChange={() => {}} />
          </SettingsRow>
          <SettingsRow
            title="Reasoning token cap per turn"
            description="Pause if a single turn blows through this many reasoning tokens."
            last
          >
            <NumberField icon={<Brain className="size-3.5" />} value={20000} unit="tok" disabled onChange={() => {}} />
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* ── Behavior on cap hit ── also not wired; group with the other soons */}
      <SettingsGroup title="On cap hit">
        <Card className="opacity-60">
          <SettingsRow title="Iteration cap" description="Behavior when the iteration limit is reached.">
            <Segmented
              size="sm"
              value="wrap"
              onChange={() => {}}
              options={[
                { value: 'wrap', label: 'Wrap up' },
                { value: 'abort', label: 'Abort' },
              ]}
            />
          </SettingsRow>
          <SettingsRow title="Spend cap" description="Behavior when running spend crosses the cap." last>
            <Segmented
              size="sm"
              value="pause"
              onChange={() => {}}
              options={[
                { value: 'pause', label: 'Pause & ask' },
                { value: 'abort', label: 'Abort turn' },
              ]}
            />
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* ── Footnote: what each tier actually gates ── */}
      <div className="mt-2 rounded-lg border border-border/60 bg-secondary/20 px-3.5 py-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground/80 mb-1.5">
          <ScrollText className="size-3" /> How permissions escalate
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground/60">
          <span className="text-[var(--info)]">Plan</span> only proposes.{' '}
          <span className="text-[var(--success)]">Ask</span> confirms every edit and shell call.{' '}
          <span className="text-[var(--warning)]">Edit</span> auto-edits but still gates the shell.{' '}
          <span className="text-[var(--error)]">Full</span> skips the gate entirely — combine with the
          audit log above.
        </p>
      </div>

      {/* Tiny risk reminder when Full is the default — nudge toward the audit log. */}
      {settings.defaultAutonomy === 'full' && !settings.auditShellCommands && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/5 px-3 py-2">
          <AlertTriangle className="size-3.5 text-[var(--error)] mt-px shrink-0" />
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            Full access is on without an audit log. Consider enabling the audit log above so every
            shell command is recorded.
          </p>
        </div>
      )}
    </>
  );
}

// ── NumberField ── a compact numeric input with a leading icon and a
// trailing unit chip. Built inline (not shared) because the layout is
// specific to caps: icon | input | unit | optional saved pulse.
function NumberField({
  icon,
  value,
  unit,
  saved,
  disabled,
  onChange,
}: {
  icon: React.ReactNode;
  value: number;
  unit: string;
  saved?: boolean;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={cn(
          'flex items-center gap-1 rounded-md border bg-secondary/40 pl-2 pr-1 h-8 transition-colors',
          disabled ? 'border-border/50 opacity-70' : 'border-border focus-within:border-primary/50',
        )}
      >
        <span className={cn('text-muted-foreground/60', disabled && 'opacity-60')}>{icon}</span>
        <Input
          type="number"
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          className={cn(
            'h-6 w-14 text-xs border-0 bg-transparent px-1 shadow-none focus-visible:ring-0',
            '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          )}
        />
        <span
          className={cn(
            'text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded',
            disabled ? 'text-muted-foreground/40 bg-secondary' : 'text-muted-foreground/70 bg-secondary',
          )}
        >
          {unit}
        </span>
      </div>
      {saved && <SavedDot />}
    </div>
  );
}

function SavedDot() {
  return (
    <span className="flex items-center gap-0.5 text-[9px] text-[var(--success)] animate-in fade-in duration-200">
      <Check className="size-2.5" /> saved
    </span>
  );
}
