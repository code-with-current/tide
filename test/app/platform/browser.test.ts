import { describe, expect, it, vi } from 'vitest';
import { openInBrowser, setBrowserOpener } from '../../../app/platform/browser';

describe('browser opener seam', () => {
  it('routes through the injected opener', async () => {
    const opener = vi.fn();
    setBrowserOpener(opener);
    await openInBrowser('https://example.com/oauth');
    expect(opener).toHaveBeenCalledExactlyOnceWith('https://example.com/oauth');
  });

  it('awaits async openers', async () => {
    let opened = false;
    setBrowserOpener(async (url) => {
      expect(url).toBe('https://example.com/late');
      await new Promise((r) => setTimeout(r, 10));
      opened = true;
    });
    await openInBrowser('https://example.com/late');
    expect(opened).toBe(true);
  });

  it('rejects when no opener is set outside the Electron shell', async () => {
    setBrowserOpener(undefined);
    await expect(openInBrowser('https://example.com/nowhere')).rejects.toThrow(/no browser opener/i);
  });
});
