import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchCrawl } from '../../../app/core/knowledge/fetchers/crawl.js';

function page(links: string[], body = 'text'): string {
  const anchors = links.map((href) => `<a href="${href}">link</a>`).join('');
  return `<html><head><title>t</title></head><body>${anchors}<p>${body}</p></body></html>`;
}

function site(pages: Record<string, string>, opts: { fail?: string[] } = {}): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (opts.fail?.includes(url)) {
      return Promise.resolve(new Response('boom', { status: 500 }));
    }
    const body = pages[url];
    if (body === undefined) return Promise.resolve(new Response('gone', { status: 404 }));
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    );
  });
}

function fetchedUrls(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCrawl', () => {
  it('walks breadth-first within one hop of the root and returns one doc per page', async () => {
    const mock = site({
      'https://example.com/': page(['/a', '/b']),
      'https://example.com/a': page([]),
      'https://example.com/b': page([]),
    });
    vi.stubGlobal('fetch', mock);

    const docs = await fetchCrawl('https://example.com/');

    expect(docs.map((d) => d.origin)).toEqual([
      'example.com',
      'example.com/a',
      'example.com/b',
    ]);
  });

  it('excludes cross-host links entirely', async () => {
    const mock = site({
      'https://example.com/': page(['https://other.com/x', '/local', '//cdn.example.net/y']),
      'https://example.com/local': page([]),
    });
    vi.stubGlobal('fetch', mock);

    const docs = await fetchCrawl('https://example.com/');

    expect(fetchedUrls(mock)).not.toContain('https://other.com/x');
    expect(fetchedUrls(mock)).not.toContain('https://cdn.example.net/y');
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.origin.startsWith('example.com'))).toBe(true);
  });

  it('enforces maxDepth so deeper levels are never fetched', async () => {
    const mock = site({
      'https://example.com/': page(['/d1']),
      'https://example.com/d1': page(['/d2']),
      'https://example.com/d2': page(['/d3']),
      'https://example.com/d3': page([]),
    });
    vi.stubGlobal('fetch', mock);

    const docs = await fetchCrawl('https://example.com/', { maxDepth: 1 });

    expect(fetchedUrls(mock)).toEqual(['https://example.com/', 'https://example.com/d1']);
    expect(docs).toHaveLength(2);
  });

  it('stops at maxPages even when more pages are linked', async () => {
    const pages: Record<string, string> = {
      'https://example.com/p0': page(['/p1', '/p2', '/p3', '/p4', '/p5', '/p6', '/p7', '/p8', '/p9']),
      'https://example.com/p1': page([]),
      'https://example.com/p2': page([]),
    };
    const mock = site(pages);
    vi.stubGlobal('fetch', mock);

    const docs = await fetchCrawl('https://example.com/p0', { maxPages: 3 });

    expect(fetchedUrls(mock)).toHaveLength(3);
    expect(docs).toHaveLength(3);
  });

  it('dedupes by normalized url so cycles terminate with a single fetch per page', async () => {
    const mock = site({
      'https://example.com/': page(['/a', '/a#section', '/a/']),
      'https://example.com/a': page(['/', 'mailto:x@example.com', 'javascript:void(0)', '#anchor']),
    });
    vi.stubGlobal('fetch', mock);

    const docs = await fetchCrawl('https://example.com/');

    expect(fetchedUrls(mock)).toEqual(['https://example.com/', 'https://example.com/a']);
    expect(docs).toHaveLength(2);
  });

  it('tolerates individual page failures and keeps crawling the rest', async () => {
    const mock = site(
      {
        'https://example.com/': page(['/ok', '/broken']),
        'https://example.com/ok': page([]),
        'https://example.com/broken': page(['/unreachable']),
        'https://example.com/unreachable': page([]),
      },
      { fail: ['https://example.com/broken'] },
    );
    vi.stubGlobal('fetch', mock);

    const docs = await fetchCrawl('https://example.com/');

    expect(docs.map((d) => d.origin)).toEqual(['example.com', 'example.com/ok']);
  });

  it('reports progress through onPage in crawl order', async () => {
    const mock = site({
      'https://example.com/': page(['/x', '/y']),
      'https://example.com/x': page([]),
      'https://example.com/y': page([]),
    });
    vi.stubGlobal('fetch', mock);

    const seen: Array<[number, string]> = [];
    await fetchCrawl('https://example.com/', { onPage: (n, url) => seen.push([n, url]) });

    expect(seen).toEqual([
      [1, 'https://example.com/'],
      [2, 'https://example.com/x'],
      [3, 'https://example.com/y'],
    ]);
  });

  it('rejects non-http crawl roots before fetching anything', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);

    await expect(fetchCrawl('file:///etc')).rejects.toThrow(/unsupported crawl root/);
    expect(mock).not.toHaveBeenCalled();
  });

  it('counts failed fetches against the page budget', async () => {
    const mock = site({
      'https://example.com/': page(['/dead1', '/dead2', '/dead3', '/dead4', '/dead5']),
    });
    vi.stubGlobal('fetch', mock);

    const docs = await fetchCrawl('https://example.com/', { maxPages: 3 });

    expect(fetchedUrls(mock)).toHaveLength(3);
    expect(docs.map((d) => d.origin)).toEqual(['example.com']);
  });

  it('reports page progress through onPage', async () => {
    const mock = site({
      'https://example.com/': page(['/a']),
      'https://example.com/a': page([]),
    });
    vi.stubGlobal('fetch', mock);
    const seen: Array<[number, string]> = [];

    await fetchCrawl('https://example.com/', { onPage: (n, current) => seen.push([n, current]) });

    expect(seen).toEqual([
      [1, 'https://example.com/'],
      [2, 'https://example.com/a'],
    ]);
  });
});
