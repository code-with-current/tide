/** UsageRing — composer meter for the active provider's token usage
 *  (informational, never blocks). Primary source: the provider's own quota
 *  API (z.ai 5-hour/weekly windows, OpenRouter/DeepSeek balance, Fireworks
 *  spend) — real limits and reset times straight from the provider.
 *  Fallback for providers without a usage API: locally-metered rolling
 *  windows vs the user-configured limits. Click opens the detail popover. */

import { Clock3, Signal } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useProviderUsage, useProviderUsageReport, useProviders, type ProviderUsageReport } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { matchPresetByBaseUrl } from '@/lib/provider-presets';
import { ProviderLogo } from '@/components/primitives/provider-logo';
import { cn, formatContext } from '@/lib/utils';
import type { ApiStyle } from '@/types';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'resets now';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `resets in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `resets in ${h}h ${m % 60}m`;
  return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
}

function tone(percent: number): string {
  if (percent >= 90) return 'var(--destructive)';
  if (percent >= 70) return 'var(--warning)';
  return 'var(--success)';
}

function formatAmount(v: number, unit: 'tokens' | 'USD' | 'credits'): string {
  if (unit === 'USD') return `$${v.toFixed(2)}`;
  if (unit === 'credits') return String(v);
  return formatContext(v);
}

function unitSuffix(unit: 'tokens' | 'USD' | 'credits'): string {
  if (unit === 'USD') return '';
  if (unit === 'credits') return ' credits';
  return ' tokens';
}

function RingSvg({ percent, muted }: { percent: number; muted?: boolean }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const stroke = muted ? 'var(--muted-foreground)' : tone(percent);
  const fill = muted ? 0.12 : Math.min(1, Math.max(0, percent / 100));
  return (
    <svg viewBox="0 0 20 20" className="size-[18px] shrink-0" aria-hidden>
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
      <circle
        cx="10" cy="10" r={r} fill="none"
        stroke={stroke}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - fill)}
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
}

/** One usage window: label + reset chip on the first line, amount right,
 *  progress bar, percent + countdown below. Balance/spend rows (no
 *  allowance) skip the bar and show the amount statement instead. */
function WindowRow({
  label, percent, used, limit, unit, resetsAt,
}: {
  label: string;
  percent?: number;
  used?: number;
  limit?: number;
  unit: 'tokens' | 'USD' | 'credits';
  resetsAt?: number;
}) {
  const pct = percent ?? (limit && used != null ? (used / limit) * 100 : undefined);
  const metered = pct != null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="text-[0.7143rem] font-semibold uppercase tracking-wider text-muted-foreground/70">{label}</span>
        {resetsAt ? (
          <span
            className="inline-flex items-center gap-0.5 rounded-full bg-secondary/70 px-1.5 py-px text-[0.6429rem] font-medium text-muted-foreground/80 tabular-nums"
            title={`Resets at ${new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
          >
            <Clock3 className="size-2.5" aria-hidden="true" />
            {formatCountdown(resetsAt - Date.now())}
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[0.7857rem] tabular-nums text-foreground/90">
          {used != null ? formatAmount(used, unit) : '—'}
          {limit != null ? (
            <span className="text-muted-foreground/55"> / {formatAmount(limit, unit)}</span>
          ) : used != null ? (
            <span className="text-muted-foreground/45">{unitSuffix(unit)}</span>
          ) : null}
        </span>
      </div>
      {metered ? (
        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${Math.min(100, pct)}%`, background: tone(pct) }}
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${label} usage`}
          />
        </div>
      ) : null}
      <div className="flex justify-between text-[0.6429rem] text-muted-foreground/55">
        <span>
          {metered
            ? `${Math.round(pct)}% used`
            : label.toLowerCase().includes('spend')
              ? 'Rated spend, last 30 days'
              : 'Available balance'}
        </span>
      </div>
    </div>
  );
}

function ReportRows({ report }: { report: ProviderUsageReport }) {
  return (
    <>
      {report.windows.slice(0, 3).map((w) => (
        <WindowRow key={w.label} {...w} />
      ))}
    </>
  );
}

/** Provider header — the real brand mark on its accent tile (matching the
 *  model picker), name, and the plan or data-source line beneath. */
function ProviderHeader({
  name, planName, source, apiStyle, presetId,
}: {
  name: string;
  planName?: string;
  source?: string;
  apiStyle: ApiStyle;
  presetId?: string;
}) {
  const subtitle = planName ?? (source ? `Via ${source} quota API` : 'Local usage estimate');
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn('size-7 rounded-lg flex items-center justify-center shrink-0', !presetId && 'bg-secondary text-foreground')}
        style={presetId ? { background: 'var(--secondary)' } : undefined}
        aria-hidden="true"
      >
        <ProviderLogo apiStyle={apiStyle} presetId={presetId} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[0.85rem] font-semibold leading-tight truncate">{name}</div>
        <div className="text-[0.6786rem] text-muted-foreground/60 truncate">{subtitle}</div>
      </div>
    </div>
  );
}

export function UsageRing() {
  const selectedProviderId = useUi((s) => s.selectedProviderId);
  const { data: providers } = useProviders();
  const provider = providers?.find((p) => p.id === selectedProviderId);
  const { data: report } = useProviderUsageReport(provider?.id);
  const { data: local } = useProviderUsage(provider?.id);
  if (!provider) return null;

  const preset = matchPresetByBaseUrl(provider.baseUrl);
  // Primary: provider-API report. Fallback: local windows + manual limits.
  // Prefer a window with a real percent for the ring; balance/spend-only
  // reports (DeepSeek, Fireworks) leave the ring muted with no % text.
  const primary = report?.windows.find((w) => w.percent != null) ?? report?.windows[0];
  const percent = primary?.percent;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1.5 h-7 text-muted-foreground bg-background transition-colors duration-200 hover:bg-secondary/60 hover:text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          title={`${provider.name} usage`}
          aria-label={`Usage for ${provider.name}`}
        >
          <RingSvg percent={percent ?? 0} muted={percent == null && !provider.limits?.fiveHourTokens} />
          {percent != null ? (
            <span className="font-mono text-[0.7143rem] tabular-nums text-muted-foreground/80">
              {Math.round(percent)}%
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-[17.5rem] p-0 gap-0 overflow-hidden">
        {/* Header band — brand mark + name + plan/source */}
        <div className="px-3.5 py-3 border-b border-border bg-gradient-to-b from-secondary/40 to-transparent">
          <ProviderHeader
            name={provider.name}
            planName={report?.planName}
            source={report ? report.source : undefined}
            apiStyle={provider.apiStyle}
            presetId={preset?.id}
          />
        </div>

        {/* Windows */}
        <div className="px-3.5 py-3 space-y-3">
          {report ? (
            <ReportRows report={report} />
          ) : (
            <>
              <WindowRow
                label="5-Hour Window"
                used={local?.fiveHour.tokens}
                limit={provider.limits?.fiveHourTokens}
                unit="tokens"
                resetsAt={local?.fiveHour.newestAt ? local.fiveHour.newestAt + FIVE_HOUR_MS : undefined}
              />
              <WindowRow
                label="7-Day Window"
                used={local?.weekly.tokens}
                limit={provider.limits?.weeklyTokens}
                unit="tokens"
                resetsAt={local?.weekly.newestAt ? local.weekly.newestAt + WEEK_MS : undefined}
              />
            </>
          )}
        </div>

        {/* Footer — data provenance */}
        <div className="px-3.5 py-2 border-t border-border bg-secondary/25 flex items-center gap-1.5">
          <Signal className="size-3 text-muted-foreground/50 shrink-0" aria-hidden="true" />
          <span className="text-[0.6786rem] leading-snug text-muted-foreground/60">
            {report
              ? 'Live from the provider\u2019s quota API.'
              : 'No provider usage API — metered locally from turn usage. Set limits in Settings → LLM Providers.'}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
