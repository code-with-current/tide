export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(s) ? 'http://' : 'https://';
  return scheme + s;
}

export function isNavigableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
