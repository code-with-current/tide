/** Ported from openchamber/openchamber (MIT): packages/ui/src/lib/timeFormat.ts.
 *  Adaptation per task ruling: i18n (`getCurrentIntlLocale`) and the
 *  `TimeFormatPreference` UI-store setting are stripped — locale resolves from
 *  `Intl` directly and `hour12` stays undefined (host default format). The
 *  `preference` parameter is retained in the signatures so callers port
 *  unchanged and a Tide setting can be threaded through later. */

type TimePrecision = 'minute' | 'second';

/** Upstream store preference type, vendored: Tide has no equivalent store yet. */
export type TimeFormatPreference = 'system' | '12h' | '24h';

const getHour12Option = (preference: TimeFormatPreference): boolean | undefined => {
  if (preference === '12h') return true;
  if (preference === '24h') return false;
  return undefined;
};

const getCurrentIntlLocale = (): string =>
  (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().locale) || 'en-US';

export const formatTimeForPreference = (
  timestamp: number | Date,
  preference: TimeFormatPreference = 'system',
  options: { precision?: TimePrecision; hour?: 'numeric' | '2-digit'; fallback?: string } = {},
): string => {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return options.fallback ?? '';
  }

  return date.toLocaleTimeString(getCurrentIntlLocale(), {
    hour: options.hour ?? 'numeric',
    minute: '2-digit',
    second: options.precision === 'second' ? '2-digit' : undefined,
    hour12: getHour12Option(preference),
  });
};

export const formatDateTimeForPreference = (
  timestamp: number | Date,
  preference: TimeFormatPreference = 'system',
  options: Intl.DateTimeFormatOptions,
): string => {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return date.toLocaleString(getCurrentIntlLocale(), {
    ...options,
    hour12: options.hour ? getHour12Option(preference) : options.hour12,
  });
};
