/** Ported from openchamber/openchamber (MIT): packages/ui/src/lib/url.ts.
 *  PURE SUBSET: only the classification/favicon/loopback helpers are ported.
 *  Dropped per task ruling: `openExternalUrl`, `openConfirmedAppLinkUrl`,
 *  `isAppLinkUrl` and the scheme allow/block sets — they exist only to drive
 *  upstream's desktop-bridge/VSCode app-link confirmation flows, which Tide
 *  does not port. T3 consumers that need to open a URL use `window.open`
 *  directly. Locale is resolved from `Intl` (no i18n runtime). */

const parseUrlSafely = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export const isExternalHttpUrl = (url: string): boolean => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
};

/** Lowercased URL scheme without the trailing colon, or null when unparseable. */
export const getUrlScheme = (url: string): string | null => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return null;
  }
  return parsed.protocol.replace(/:$/, '').toLowerCase();
};

export const getExternalFaviconUrl = (url: string): string | null => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return null;
  }

  return `https://icons.duckduckgo.com/ip3/${parsed.hostname.toLowerCase()}.ico`;
};

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * Returns true when the URL is an http(s) URL pointing at a loopback host
 * (localhost, 127.0.0.1, 0.0.0.0, ::1). Used to decide whether to offer an in-app
 * preview pane instead of opening the system browser.
 */
export const isLoopbackHttpUrl = (url: string): boolean => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
};

const LOOPBACK_URL_PATTERN
  // eslint-disable-next-line no-control-regex
  = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s<>"'`\u0000-\u001f]*)?/gi;

/**
 * Extracts loopback http(s) URLs from a free-text string. Returns unique URLs
 * in order of first appearance. Trailing punctuation that is unlikely to be
 * part of a real URL is stripped.
 */
export const extractLoopbackUrls = (text: string): string[] => {
  if (!text) {
    return [];
  }
  const matches = text.match(LOOPBACK_URL_PATTERN);
  if (!matches || matches.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[),.;:!?'"`]+$/g, '');
    if (!cleaned || !isLoopbackHttpUrl(cleaned)) {
      continue;
    }
    if (seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
};
