/** UsageRing — top-bar circular meter for the active provider's token
 *  usage (informational, never blocks). Primary source: the provider's own
 *  quota API (z.ai 5-hour/weekly windows, OpenRouter credits) — real
 *  limits and reset times straight from the provider. Fallback for
 *  providers without a usage API: locally-metered rolling windows vs the
 *  user-configured limits. Click opens the detail popover. */

import { Gauge } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useProviderUsage, useProviderUsageReport, useProviders, type ProviderUsageReport } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { formatContext } from '@/lib/utils';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
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
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[0.7143rem] uppercase tracking-wider text-muted-foreground/60 font-semibold">{label}</span>
        <span className="font-mono text-[0.7857rem] tabular-nums text-foreground/85">
          {used != null ? formatAmount(used, unit) : '—'}
          {limit != null ? <span className="text-muted-foreground/50"> / {formatAmount(limit, unit)}</span> : null}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.min(100, pct ?? 0)}%`, background: tone(pct ?? 0) }}
        />
      </div>
      <div className="flex justify-between text-[0.7143rem] text-muted-foreground/50">
        <span>{pct != null ? `${Math.round(pct)}% used` : 'usage unknown'}</span>
        {resetsAt ? (
          <span className="tabular-nums">resets in {formatCountdown(resetsAt - Date.now())}</span>
        ) : null}
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

export function UsageRing() {
  const selectedProviderId = useUi((s) => s.selectedProviderId);
  const { data: providers } = useProviders();
  const provider = providers?.find((p) => p.id === selectedProviderId);
  const { data: report } = useProviderUsageReport(provider?.id);
  const { data: local } = useProviderUsage(provider?.id);
  if (!provider) return null;

  // Primary: provider-API report. Fallback: local windows + manual limits.
  const primary = report?.windows.find((w) => w.unit !== 'credits') ?? report?.windows[0];
  const percent = primary?.percent;
  const hasApi = !!report;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1.5 h-7 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground cursor-pointer"
          title={`${provider.name} — ${hasApi ? 'provider-reported usage' : 'local usage estimate'}`}
          aria-label="Provider usage"
        >
          <RingSvg percent={percent ?? 0} muted={!hasApi && !provider.limits?.fiveHourTokens} />
          {percent != null ? (
            <span className="font-mono text-[0.7143rem] tabular-nums text-muted-foreground/80">
              {Math.round(percent)}%
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={6} className="w-64 p-3 space-y-3">
        <div className="flex items-center gap-2 pb-1 border-b border-border">
          <Gauge className="size-3.5 text-primary" />
          <span className="text-[0.85rem] font-semibold truncate">{provider.name}</span>
          {report?.planName ? (
            <span className="ml-auto max-w-[7rem] truncate text-[0.7143rem] text-muted-foreground/50">{report.planName}</span>
          ) : (
            <span className="ml-auto text-[0.7143rem] text-muted-foreground/50">
              {hasApi ? report!.source : 'local'}
            </span>
          )}
        </div>

        {report ? (
          <ReportRows report={report} />
        ) : (
          <>
            <WindowRow
              label="5 hours"
              used={local?.fiveHour.tokens}
              limit={provider.limits?.fiveHourTokens}
              unit="tokens"
              resetsAt={local?.fiveHour.newestAt ? local.fiveHour.newestAt + FIVE_HOUR_MS : undefined}
            />
            <WindowRow
              label="7 days"
              used={local?.weekly.tokens}
              limit={provider.limits?.weeklyTokens}
              unit="tokens"
              resetsAt={local?.weekly.newestAt ? local.weekly.newestAt + WEEK_MS : undefined}
            />
          </>
        )}

        <p className="text-[0.6429rem] leading-snug text-muted-foreground/40 pt-0.5 border-t border-border/60">
          {hasApi
            ? 'Reported live by the provider\u2019s quota API.'
            : 'No provider usage API — locally metered from turn usage. Set limits in Settings → LLM Providers.'}
        </p>
      </PopoverContent>
    </Popover>
  );
}
