/** URL fetcher: downloads one http(s) resource and normalizes it into a
 *  SourceDocument. HTML / XHTML is converted to visible text via html-to-text;
 *  any other content type passes through raw. Body reads are capped so peak
 *  memory stays bounded regardless of response size. */
import { convert } from 'html-to-text';
import type { SourceDocument } from '../types.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CHARS = 2 * 1024 * 1024;
const USER_AGENT = 'Tide/0.2 knowledge-indexer';

export async function fetchUrl(url: string): Promise<SourceDocument[]> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`unsupported url: ${url}`);
  let res: Response;
  let body: string;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
    body = await readBody(res);
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new Error(`fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw e;
  }
  const origin = originOf(url);
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() || url;
    const text = convert(body, { wordWrap: false });
    if (!text.trim()) return [];
    return [{ title, origin, content: text }];
  }
  if (!body.trim()) return [];
  return [{ title: url, origin, content: body }];
}

export function originOf(url: string): string {
  const u = new URL(url);
  return `${u.hostname}${u.pathname.replace(/\/$/, '')}`;
}

async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > MAX_CHARS) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return (text + decoder.decode()).slice(0, MAX_CHARS);
}
