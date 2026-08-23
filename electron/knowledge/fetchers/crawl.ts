/** Same-origin crawl fetcher: breadth-first walk from a root URL staying on
 *  one hostname, bounded by page count and depth. Each page is downloaded once
 *  via the shared raw fetcher; links come from a regex over the raw HTML so no
 *  DOM parser is needed. Individual page failures are skipped, not fatal. */
import type { SourceDocument } from '../types.js';
import { fetchRaw, toDocuments } from './url.js';

export const DEFAULT_MAX_PAGES = 50;
export const DEFAULT_MAX_DEPTH = 2;

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  /** Progress hook fired after each page is processed. */
  onPage?: (pagesSeen: number, current: string) => void;
}

interface QueueEntry {
  url: string;
  depth: number;
}

export async function fetchCrawl(rootUrl: string, opts: CrawlOptions = {}): Promise<SourceDocument[]> {
  const start = new URL(rootUrl);
  if (!/^https?:$/.test(start.protocol)) throw new Error(`unsupported crawl root: ${rootUrl}`);

  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  // Keys are strings — seeding with the URL object itself would never match.
  const seen = new Set<string>([normalize(start).toString()]);
  let queue: QueueEntry[] = [{ url: start.toString(), depth: 0 }];
  const docs: SourceDocument[] = [];
  let pagesSeen = 0;

  while (queue.length > 0 && pagesSeen < maxPages) {
    const level = queue;
    queue = [];
    for (const entry of level) {
      if (entry.depth > maxDepth || pagesSeen >= maxPages) continue;

      let pageDocs: SourceDocument[] = [];
      let linked: string[] = [];
      try {
        const page = await fetchPage(entry.url);
        pageDocs = page.docs;
        linked = page.links;
      } catch {
        continue;
      }

      pagesSeen += 1;
      docs.push(...pageDocs);
      opts.onPage?.(pagesSeen, entry.url);

      for (const href of linked) {
        const next = normalize(href);
        if (next.hostname !== start.hostname) continue;
        const key = next.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ url: key, depth: entry.depth + 1 });
      }
    }
  }
  return docs;
}

async function fetchPage(url: string): Promise<{ docs: SourceDocument[]; links: string[] }> {
  const { contentType, body } = await fetchRaw(url);
  const links = isHtml(contentType) ? extractLinks(body, url) : [];
  return { docs: toDocuments(body, url, contentType), links };
}

function isHtml(contentType: string): boolean {
  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const hrefRe = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(hrefRe)) {
    const href = match[1] ?? match[2] ?? match[3];
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(resolved.protocol)) continue;
    resolved.hash = '';
    links.push(resolved.toString());
  }
  return links;
}

function normalize(u: URL): URL {
  const copy = new URL(u.toString());
  copy.hash = '';
  if (copy.pathname.length > 1) copy.pathname = copy.pathname.replace(/\/$/, '');
  return copy;
}
