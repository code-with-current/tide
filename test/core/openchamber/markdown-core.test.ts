/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/markdown/markdownCore.test.ts.
 *  Vitest rewrite of the upstream bun:test file: `mock.module` becomes
 *  `vi.mock`, and the app-link expectations change to match the Tide port
 *  (upstream kept `obsidian://`-style app links via isAppLinkUrl; the Tide
 *  port has no app-link runtime, so only local file: URLs are force-kept).
 *  DOM-dependent decorate/mermaid cases from the upstream suite are not ported
 *  (node env, no DOM). */
import { describe, expect, test, vi } from 'vitest';

type SanitizeAttribute = {
  attrName: string;
  attrValue: string;
  forceKeepAttr?: boolean;
};

class TestAnchorElement {
  target = '';

  setAttribute(name: string, value: string): void {
    if (name === 'target') this.target = value;
  }
}

const sanitizeHooks = vi.hoisted(() => ({
  hooks: {} as {
    uponSanitizeAttribute?: (node: unknown, data: SanitizeAttribute) => void;
    afterSanitizeAttributes?: (node: unknown) => void;
  },
}));

vi.mock('dompurify', () => ({
  default: {
    isSupported: true,
    addHook: (name: 'uponSanitizeAttribute' | 'afterSanitizeAttributes', hook: never) => {
      sanitizeHooks.hooks[name] = hook;
    },
    sanitize: (html: string) => html.replace(/ href="([^"]*)"/g, (attribute, href: string) => {
      const anchor = new TestAnchorElement();
      const data: SanitizeAttribute = { attrName: 'href', attrValue: href };
      sanitizeHooks.hooks.uponSanitizeAttribute?.(anchor, data);
      sanitizeHooks.hooks.afterSanitizeAttributes?.(anchor);

      return data.forceKeepAttr || /^(?:https?|mailto|tel):/i.test(href) ? attribute : '';
    }),
  },
}));

vi.mock('../../../src/components/chat/timeline/markdown/markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
}));

Object.assign(globalThis, {
  window: {},
  HTMLAnchorElement: TestAnchorElement,
});

import {
  __markdownImageCandidateCacheForTests,
  extractMarkdownImageCandidates,
  renderMarkdownSync,
} from '../../../src/components/chat/timeline/markdown/markdown-core';
import { escapeRawMarkdownHtml, isLocalFileUrl, MARKDOWN_FORBIDDEN_TAGS } from '../../../src/components/chat/timeline/markdown/markdown-security';
import { resolveMarkdownImageSource } from '../../../src/components/chat/timeline/markdown/markdown-image-assets';

describe('markdown sanitization', () => {
  test('turns raw assistant HTML into inert visible text', () => {
    const payload = '<style>@import url("https://example.test/theme.css");</style>';

    expect(escapeRawMarkdownHtml(payload)).toBe(
      '&lt;style&gt;@import url(&quot;https://example.test/theme.css&quot;);&lt;/style&gt;',
    );
  });

  test('forbids script and stylesheet elements as active content', () => {
    expect(MARKDOWN_FORBIDDEN_TAGS).toContain('script');
    expect(MARKDOWN_FORBIDDEN_TAGS).toContain('style');
  });

  test('allows only local file URLs through the sanitizer policy', () => {
    expect(isLocalFileUrl('file:///private/tmp/report%20viewer.html')).toBe(true);
    expect(isLocalFileUrl('file://localhost/private/tmp/REPORT.md')).toBe(true);
    expect(isLocalFileUrl('file://remote-host/share/report.html')).toBe(false);
    expect(isLocalFileUrl('javascript:alert(1)')).toBe(false);
  });

  test('keeps local file links while stripping blocked schemes', () => {
    const html = renderMarkdownSync([
      '[file](file:///workspace/notes.md)',
      '[web](https://example.test/docs)',
      '[script](javascript:alert(1))',
      '[diagnostic](ms-msdt:/id%20PCWDiagnostic)',
    ].join('\n\n'), 'inline');

    expect(html).toContain('href="file:///workspace/notes.md"');
    expect(html).toContain('href="https://example.test/docs"');
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).not.toContain('href="ms-msdt:/id%20PCWDiagnostic"');
  });
});

describe('Markdown images', () => {
  test('renders assistant images as icon-ready text without loading the source', () => {
    const html = renderMarkdownSync([
      '[linked image](packages/vscode/extension.jpg)',
      '![image syntax](packages/vscode/extension.jpg)',
    ].join('\n\n'), 'label');

    expect(html).toContain('data-tide-markdown-image-label="true"');
    expect(html).toContain('extension.jpg');
    expect(html).not.toContain('image syntax');
    expect(html).not.toContain('<img');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test('keeps non-chat Markdown images inline', () => {
    const html = renderMarkdownSync([
      '[remote link](https://example.test/image.png)',
      '![remote image](https://example.test/image.png)',
    ].join('\n\n'));

    expect(html).toContain('<a href="https://example.test/image.png"');
    expect(html).toContain('<img src="https://example.test/image.png" alt="remote image">');
    expect(html).not.toContain('data-tide-markdown-image-label');
  });

  test('collects image syntax across mixed Markdown and ignores links and code', () => {
    const candidates = extractMarkdownImageCandidates([
      [
        'Before [local link](screens/first%20view.png) and `![code](ignored.png)`.',
        '',
        '- ![duplicate](screens/first%20view.png)',
        '- ![remote](https://example.test/second.webp?size=2)',
        '',
        '```md',
        '![fenced](ignored-too.jpg)',
        '```',
      ].join('\n'),
      'After ![third](data:image/png;base64,AAAA).',
    ]);

    expect(candidates).toEqual([
      { source: 'screens/first%20view.png', filename: 'first view.png' },
      { source: 'https://example.test/second.webp?size=2', filename: 'second.webp' },
      { source: 'data:image/png;base64,AAAA', filename: 'third' },
    ]);
  });

  test('does not add an ordinary local image link to the gallery', () => {
    expect(extractMarkdownImageCandidates(['[download](screens/image.png)'])).toEqual([]);
  });

  test('limits one finalized message gallery to twelve unique candidates', () => {
    const markdown = Array.from({ length: 14 }, (_, index) => `![image ${index}](screens/${index}.png)`).join('\n');

    const candidates = extractMarkdownImageCandidates([markdown]);

    expect(candidates).toHaveLength(12);
    expect(candidates.at(-1)?.source).toBe('screens/11.png');
  });

  test('memoizes candidate scans per markdown source', () => {
    __markdownImageCandidateCacheForTests.reset();
    const markdown = '![image](screens/once.png)';

    extractMarkdownImageCandidates([markdown]);
    extractMarkdownImageCandidates([markdown]);

    expect(__markdownImageCandidateCacheForTests.stats().scans).toBe(1);
    __markdownImageCandidateCacheForTests.reset();
  });
});

describe('Markdown image source resolution', () => {
  test('rejects local paths that were never prepared', async () => {
    await expect(resolveMarkdownImageSource('screens/image.png', new AbortController().signal))
      .rejects.toThrow('Local image has not been prepared');
  });
});
