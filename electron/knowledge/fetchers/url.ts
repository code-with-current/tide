/** URL fetcher: downloads one http(s) resource and normalizes it into a
 *  SourceDocument. HTML is converted to visible text via html-to-text;
 *  any other content type passes through raw. */
import { convert } from 'html-to-text';
import type { SourceDocument } from '../types.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CHARS = 2 * 1024 * 1024;
const USER_AGENT = 'Tide/0.2 knowledge-indexer';

export async function fetchUrl(url: string): Promise<SourceDocument[]> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`unsupported url: ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new Error(`fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw e;
  }
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
  const contentType = res.headers.get('content-type') ?? '';
  const body = (await res.text()).slice(0, MAX_CHARS);
  const origin = originOf(url);
  if (contentType.includes('text/html')) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() || url;
    return [{ title, origin, content: convert(body, { wordWrap: false }) }];
  }
  return [{ title: url, origin, content: body }];
}

export function originOf(url: string): string {
  const u = new URL(url);
  return `${u.hostname}${u.pathname.replace(/\/$/, '')}`;
}
