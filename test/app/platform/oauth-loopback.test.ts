import { afterAll, describe, expect, it } from 'vitest';
import { startLoopbackServer } from '../../../app/platform/oauth-loopback';

const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

describe('oauth loopback', () => {
  it('delivers query params and closes', async () => {
    const got = new Promise<URLSearchParams>((resolve) => {
      startLoopbackServer((q) => resolve(q)).then((s) => {
        closers.push(s.close);
        void (async () => {
          const res = await fetch(`http://127.0.0.1:${s.port}/callback?code=abc&state=xyz`);
          expect(res.status).toBe(200);
          expect(await res.text()).toContain('close this tab');
        })();
      });
    });
    const q = await got;
    expect(q.get('code')).toBe('abc');
    expect(q.get('state')).toBe('xyz');
  });

  it('rejects non-callback paths with 404 without delivering', async () => {
    const got = new Promise<URLSearchParams>((resolve) => {
      startLoopbackServer((q) => resolve(q)).then((s) => {
        closers.push(s.close);
        void (async () => {
          const res = await fetch(`http://127.0.0.1:${s.port}/other?code=nope`);
          expect(res.status).toBe(404);
        })();
      });
    });
    await expect(Promise.race([got, new Promise((r) => setTimeout(r, 300, 'timeout'))])).resolves.toBe('timeout');
  });

  it('stops listening after the first callback hit', async () => {
    const { port, close } = await startLoopbackServer(() => {});
    closers.push(close);
    const first = await fetch(`http://127.0.0.1:${port}/callback?code=one`);
    expect(first.status).toBe(200);
    let refused = false;
    for (let i = 0; i < 20 && !refused; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/callback?code=two`);
      } catch {
        refused = true;
      }
      if (!refused) await new Promise((r) => setTimeout(r, 50));
    }
    expect(refused).toBe(true);
  });
});
