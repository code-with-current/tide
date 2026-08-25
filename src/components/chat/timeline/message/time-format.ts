/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/message/timeFormat.ts.
 *  Adaptation: i18n (`getCurrentIntlLocale`, `useI18nStore` + `formatMessage`)
 *  replaced with literal English ("Yesterday, {time}") and `Intl`-resolved
 *  locale; `TimeFormatPreference` comes from Tide's ported `../lib/time-format`
 *  instead of the upstream UI store. Logic otherwise unchanged. */

import { formatTimeForPreference, type TimeFormatPreference } from '../lib/time-format';

const isSameDay = (left: Date, right: Date): boolean => {
  return (
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
  );
};

const isYesterday = (date: Date, now: Date): boolean => {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return isSameDay(date, yesterday);
};

const isValidTimestamp = (timestamp: number): boolean => {
  return Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime());
};

const getCurrentIntlLocale = (): string =>
  (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().locale) || 'en-US';

export const formatTimestampForDisplay = (timestamp: number, timeFormatPreference: TimeFormatPreference): string => {
  if (!isValidTimestamp(timestamp)) {
    return '';
  }

  const date = new Date(timestamp);
  const now = new Date();
  const timePart = formatTimeForPreference(date, timeFormatPreference);
  const locale = getCurrentIntlLocale();

  if (isSameDay(date, now)) {
    return timePart;
  }

  if (isYesterday(date, now)) {
    // Upstream: i18n key `common.date.yesterdayWithTime` ({ time }).
    return `Yesterday, ${timePart}`;
  }

  const monthPart = date.toLocaleString(locale, { month: 'short' });
  const dayPart = date.getDate();
  const datePart = `${monthPart} ${dayPart}`;

  if (date.getFullYear() === now.getFullYear()) {
    return `${datePart}, ${timePart}`;
  }

  return `${datePart}, ${date.getFullYear()}, ${timePart}`;
};
