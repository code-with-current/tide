import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchUrl, originOf } from '../../../electron/knowledge/fetchers/url.js';

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchUrl', () => {
  it('converts HTML into one document with title, origin, and visible text only', async () => {
    const fetchMock = vi.fn(
      () =>
        htmlResponse(`<!doctype html>
<html>
<head><title>Install Guide &mdash; Acme</title></head>
<body>
<nav>Menu Junk</nav>
<script>var secretToken = "should-not-appear";</script>
<main><h1>Getting Started</h1><p>The quick install steps are here.</p></main>
</body>
</html>`),
    );
    vi.stubGlobal('fetch', fetchMock);

    const docs = await fetchUrl('https://docs.example.com/guide/');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://docs.example.com/guide/',
      expect.objectContaining({ headers: { 'user-agent': 'Tide/0.2 knowledge-indexer' } }),
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Install Guide &mdash; Acme');
    expect(docs[0].origin).toBe('docs.example.com/guide');
    expect(docs[0].content).toContain('The quick install steps are here.');
    expect(docs[0].content).not.toContain('secretToken');
  });

  it('falls back to the url as title when no <title> is present', async () => {
    vi.stubGlobal('fetch', () => htmlResponse('<html><body><p>Bare page</p></body></html>'));

    const [doc] = await fetchUrl('https://example.org/bare');

    expect(doc.title).toBe('https://example.org/bare');
    expect(doc.content).toContain('Bare page');
  });

  it('passes non-HTML content through raw without conversion', async () => {
    vi.stubGlobal(
      'fetch',
      () =>
        new Response('# Readme\n\n- keep **markdown** intact\n', {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        }),
    );

    const [doc] = await fetchUrl('https://example.com/readme.md');

    expect(doc.title).toBe('https://example.com/readme.md');
    expect(doc.origin).toBe('example.com/readme.md');
    expect(doc.content).toBe('# Readme\n\n- keep **markdown** intact\n');
  });

  it('throws with the status included on http errors', async () => {
    vi.stubGlobal('fetch', () => new Response('gone', { status: 404 }));

    await expect(fetchUrl('https://example.com/missing')).rejects.toThrow(
      'fetch failed: 404 https://example.com/missing',
    );
  });

  it('maps a timeout abort to a readable error', async () => {
    vi.stubGlobal(
      'fetch',
      () => new Promise<Response>((_, reject) => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))),
    );

    await expect(fetchUrl('https://slow.example.com')).rejects.toThrow(/timed out after 15s/);
  });

  it('rejects non-http schemes before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchUrl('file:///etc/passwd')).rejects.toThrow(/unsupported url/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('originOf', () => {
  it('joins hostname and pathname and drops the trailing slash', () => {
    expect(originOf('https://example.com/')).toBe('example.com');
    expect(originOf('https://example.com/a/b?q=1#frag')).toBe('example.com/a/b');
  });
});
