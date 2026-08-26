import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../app/platform/paths.js', () => ({
  appDataDir: () => '/tmp/tide-mock-appdata',
}));

import {
  createAuthProvider,
  enableOAuthLoopback,
  ensureOAuthLoopback,
  registerOAuthCompleter,
} from '../../../app/core/agent/mcp/oauth';

const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/callback$/;

describe('oauth redirect coordinator', () => {
  it('falls back to the tide:// scheme until loopback is enabled', () => {
    expect(createAuthProvider('srv').redirectUrl).toMatch(/^tide(-dev)?:\/\/oauth\/callback$/);
  });

  it('uses the loopback URL once enabled', async () => {
    await enableOAuthLoopback();
    expect(createAuthProvider('srv').redirectUrl).toMatch(LOOPBACK_RE);
  });

  it('declares the same redirect_uris in client metadata', async () => {
    const provider = createAuthProvider('srv') as { clientMetadata: { redirect_uris: string[] } };
    expect(provider.clientMetadata.redirect_uris).toEqual([createAuthProvider('srv').redirectUrl]);
  });

  it('delivers a callback hit to the registered completer', async () => {
    const completer = vi.fn();
    registerOAuthCompleter(completer);
    const url = createAuthProvider('srv').redirectUrl;
    const res = await fetch(`${url}?code=abc&state=xyz`);
    expect(res.status).toBe(200);
    expect(completer).toHaveBeenCalledExactlyOnceWith('abc', 'xyz');
  });

  it('rotates to a fresh port after the server closed on a hit', async () => {
    const before = createAuthProvider('srv').redirectUrl;
    await ensureOAuthLoopback();
    const after = createAuthProvider('srv').redirectUrl;
    expect(after).toMatch(LOOPBACK_RE);
    expect(after).not.toBe(before);
    // Idempotent while running: no further rotation.
    await ensureOAuthLoopback();
    expect(createAuthProvider('srv').redirectUrl).toBe(after);
  });
});
