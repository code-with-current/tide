import { describe, expect, it, vi } from 'vitest';
import {
  reduceUpdateStatus,
  registerUpdaterRpc,
  type ElectrobunUpdaterLike,
} from '../../app/updater';
import type { UpdateStatusEntry } from 'electrobun/main';
import type { UpdateStatusWire } from '../../shared/rpc';

function entry(
  status: UpdateStatusEntry['status'],
  over: Partial<UpdateStatusEntry> = {},
): UpdateStatusEntry {
  return { status, message: `msg:${status}`, timestamp: 1_700_000_000_000, ...over };
}

const INFO_IDLE = { version: '', hash: '', updateAvailable: false, updateReady: false, error: '' };

function seed(): UpdateStatusWire {
  return {
    phase: 'idle',
    message: '',
    currentVersion: '1.0.0',
    version: null,
    percent: null,
    error: null,
    lastCheckedAt: null,
  };
}

describe('reduceUpdateStatus — phase mapping', () => {
  it('maps check/available/idle phases directly', () => {
    expect(reduceUpdateStatus(seed(), entry('checking'), INFO_IDLE, '1.0.0').phase).toBe('checking');
    expect(reduceUpdateStatus(seed(), entry('idle'), INFO_IDLE, '1.0.0').phase).toBe('idle');
    expect(
      reduceUpdateStatus(seed(), entry('update-available'), { ...INFO_IDLE, version: '1.1.0', updateAvailable: true }, '1.0.0'),
    ).toMatchObject({ phase: 'available', version: '1.1.0' });
  });

  it('maps no-update and check-complete to not-available and stamps lastCheckedAt', () => {
    for (const status of ['no-update', 'check-complete'] as const) {
      const out = reduceUpdateStatus(seed(), entry(status, { timestamp: 42 }), INFO_IDLE, '1.0.0');
      expect(out.phase).toBe('not-available');
      expect(out.lastCheckedAt).toBe(42);
    }
  });

  it('maps every patch-chain interior state to downloading', () => {
    const interiors = [
      'download-starting', 'downloading', 'download-progress',
      'checking-local-tar', 'local-tar-found', 'local-tar-missing',
      'fetching-patch', 'patch-found', 'patch-not-found', 'downloading-patch',
      'applying-patch', 'patch-applied', 'extracting-version', 'patch-chain-complete',
      'patch-failed', 'downloading-full-bundle', 'decompressing',
    ] as const;
    for (const status of interiors) {
      expect(reduceUpdateStatus(seed(), entry(status), INFO_IDLE, '1.0.0').phase).toBe('downloading');
    }
  });

  it('maps apply handoff states to applying', () => {
    for (const status of ['applying', 'extracting', 'replacing-app', 'launching-new-version', 'complete'] as const) {
      expect(reduceUpdateStatus(seed(), entry(status), INFO_IDLE, '1.0.0').phase).toBe('applying');
    }
  });

  it('carries progress percent from download-progress details', () => {
    const out = reduceUpdateStatus(
      seed(),
      entry('download-progress', { details: { progress: 37, bytesDownloaded: 370, totalBytes: 1000 } }),
      INFO_IDLE,
      '1.0.0',
    );
    expect(out.phase).toBe('downloading');
    expect(out.percent).toBe(37);
  });

  it('derives percent from bytes when progress is absent', () => {
    const out = reduceUpdateStatus(
      seed(),
      entry('downloading', { details: { bytesDownloaded: 200, totalBytes: 800 } }),
      INFO_IDLE,
      '1.0.0',
    );
    expect(out.percent).toBe(25);
  });

  it('forces 100 percent on download-complete and keeps the version', () => {
    const mid = reduceUpdateStatus(
      seed(),
      entry('download-progress', { details: { progress: 60 } }),
      { ...INFO_IDLE, version: '1.1.0', updateAvailable: true },
      '1.0.0',
    );
    const out = reduceUpdateStatus(
      mid,
      entry('download-complete'),
      { ...INFO_IDLE, version: '1.1.0', updateAvailable: true, updateReady: true },
      '1.0.0',
    );
    expect(out).toMatchObject({ phase: 'downloaded', percent: 100, version: '1.1.0' });
  });

  it('surfaces error entries with the detail message preferred', () => {
    const out = reduceUpdateStatus(
      seed(),
      entry('error', { details: { errorMessage: 'HTTP 404' } }),
      { ...INFO_IDLE, error: 'Failed to check' },
      '1.0.0',
    );
    expect(out.phase).toBe('error');
    expect(out.error).toBe('HTTP 404');
    expect(out.lastCheckedAt).toBe(1_700_000_000_000);
  });

  it('clears stale fields across phase transitions', () => {
    let s = reduceUpdateStatus(seed(), entry('update-available'), { ...INFO_IDLE, version: '1.1.0', updateAvailable: true }, '1.0.0');
    s = reduceUpdateStatus(s, entry('no-update', { timestamp: 5 }), INFO_IDLE, '1.0.0');
    expect(s.version).toBeNull();
    expect(s.percent).toBeNull();
    expect(s.error).toBeNull();
  });
});

/** Scriptable devkit-Updater fake. Mirrors the devkit's swallowing error
 *  model: download/apply failures emit an `error` status entry and RESOLVE
 *  (readiness must be read from updateInfo), they only reject when the
 *  script says so via the *Throw options. The script object is read on every
 *  call so tests can flip it between attempts (retry flows). */
function fakeUpdater(script: {
  check?: { updateAvailable: boolean };
  /** Check resolves carrying an error (the unset-baseUrl shape: fetch fails
   *  inside the devkit, which returns updateAvailable:false + error). */
  checkError?: string;
  /** checkForUpdate rejects outright. */
  checkThrow?: Error;
  /** Download fails the devkit way: error entry emitted, resolves, not ready. */
  download?: Error;
  /** downloadUpdate rejects outright (re-entrancy guards etc.). */
  downloadThrow?: Error;
  /** Withholds the update-available status entry — exercises the explicit
   *  available publication from the check result. */
  silentAvailable?: boolean;
  /** Bundle already prepared from a previous install (updateReady at start). */
  preReady?: boolean;
  /** Target version reported by updateInfo when nothing else overrides it. */
  infoVersion?: string;
  /** downloadUpdate awaits this before completing (consent-in-flight tests). */
  hangDownload?: Promise<void>;
  apply?: Error;
}) {
  const calls: string[] = [];
  let listener: ((e: UpdateStatusEntry) => void) | null = null;
  const info = {
    version: script.infoVersion ?? (script.check?.updateAvailable ? '1.1.0' : '1.0.0'),
    hash: '',
    updateAvailable: !!script.check?.updateAvailable,
    updateReady: !!script.preReady,
    error: script.checkError ?? '',
  };
  const fake: ElectrobunUpdaterLike = {
    onStatusChange(cb) { listener = cb; },
    async checkForUpdate() {
      calls.push('check');
      if (script.checkThrow) throw script.checkThrow;
      if (script.checkError) {
        listener?.(entry('error', { details: { errorMessage: script.checkError } }));
        return { ...info, updateAvailable: false };
      }
      listener?.(entry('checking'));
      if (script.check?.updateAvailable && !script.silentAvailable) {
        listener?.(entry('update-available'));
      } else if (!script.check?.updateAvailable) {
        listener?.(entry('no-update'));
      }
      return { ...info, updateAvailable: !!script.check?.updateAvailable };
    },
    async downloadUpdate() {
      calls.push('download');
      if (script.hangDownload) await script.hangDownload;
      if (script.downloadThrow) throw script.downloadThrow;
      if (script.download) {
        info.error = script.download.message;
        listener?.(entry('error', { details: { errorMessage: script.download.message } }));
        return;
      }
      info.updateReady = true;
      listener?.(entry('download-complete'));
    },
    async applyUpdate() {
      calls.push('apply');
      if (script.apply) throw script.apply;
    },
    updateInfo() { return { ...info }; },
    async getLocalInfo() { return { version: '1.0.0', channel: 'stable' }; },
  };
  return { fake, calls, emit: (e: UpdateStatusEntry) => listener?.(e) };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('registerUpdaterRpc — consent-driven flow', () => {
  it('stops at available when a check finds an update — no download, no apply', async () => {
    const { fake, calls } = fakeUpdater({ check: { updateAvailable: true } });
    const sent: UpdateStatusWire[] = [];
    const rpc = registerUpdaterRpc(
      { send: (s) => sent.push(s) },
      { updater: fake, autoCheckEnabled: () => true, checkDelayMs: 0, checkIntervalMs: 3_600_000 },
    );
    rpc.start();
    rpc.dispose();
    await rpc.handlers.updaterCheckNow({});
    expect(calls).toEqual(['check']);
    expect(sent.map((s) => s.phase)).toEqual(['checking', 'available']);
    expect(rpc.handlers.updaterStatus({}).status).toMatchObject({ phase: 'available', version: '1.1.0' });
  });

  it('publishes available with the check-result version even when no status entry fired', async () => {
    const { fake, calls } = fakeUpdater({ check: { updateAvailable: true }, silentAvailable: true });
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake });
    await rpc.handlers.updaterCheckNow({});
    expect(calls).toEqual(['check']);
    expect(rpc.handlers.updaterStatus({}).status).toMatchObject({ phase: 'available', version: '1.1.0' });
  });

  it('updaterDownload downloads but never applies', async () => {
    const { fake, calls } = fakeUpdater({ check: { updateAvailable: true } });
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake, autoCheckEnabled: () => false });
    rpc.start();
    await rpc.handlers.updaterCheckNow({});
    await expect(rpc.handlers.updaterDownload({})).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['check', 'download']);
    expect(rpc.handlers.updaterStatus({}).status).toMatchObject({ phase: 'downloaded', version: '1.1.0' });
    rpc.dispose();
  });

  it('updaterDownload is a no-op when the bundle is already prepared (Later survived a restart)', async () => {
    const { fake, calls } = fakeUpdater({ check: { updateAvailable: true }, preReady: true });
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake });
    await rpc.handlers.updaterCheckNow({});
    await expect(rpc.handlers.updaterDownload({})).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['check']);
  });

  it('updaterApply applies a prepared update', async () => {
    const { fake, calls } = fakeUpdater({ check: { updateAvailable: true } });
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake, autoCheckEnabled: () => false });
    rpc.start();
    await rpc.handlers.updaterCheckNow({});
    await rpc.handlers.updaterDownload({});
    await expect(rpc.handlers.updaterApply({})).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['check', 'download', 'apply']);
    rpc.dispose();
  });

  it('updaterApply without a prepared bundle resolves {ok:false} and never applies', async () => {
    const { fake, calls } = fakeUpdater({ check: { updateAvailable: true } });
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake });
    await rpc.handlers.updaterCheckNow({});
    await expect(rpc.handlers.updaterApply({})).resolves.toMatchObject({ ok: false, error: 'update not downloaded' });
    expect(calls).toEqual(['check']);
  });

  it('download with nothing available resolves {ok:false} without touching apply', async () => {
    const { fake, calls } = fakeUpdater({});
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake });
    await expect(rpc.handlers.updaterDownload({})).resolves.toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it('an error mid-download surfaces phase error, returns {ok:false}, and the retry works', async () => {
    const script = { check: { updateAvailable: true }, download: new Error('HTTP 500') };
    const { fake, calls } = fakeUpdater(script);
    const sent: UpdateStatusWire[] = [];
    const rpc = registerUpdaterRpc({ send: (s) => sent.push(s) }, { updater: fake, autoCheckEnabled: () => false });
    rpc.start();
    await rpc.handlers.updaterCheckNow({});
    await expect(rpc.handlers.updaterDownload({})).resolves.toMatchObject({ ok: false, error: 'HTTP 500' });
    expect(sent.at(-1)).toMatchObject({ phase: 'error', error: 'HTTP 500', version: '1.1.0' });
    script.download = undefined;
    await expect(rpc.handlers.updaterDownload({})).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['check', 'download', 'download']);
    expect(rpc.handlers.updaterStatus({}).status).toMatchObject({ phase: 'downloaded' });
    await expect(rpc.handlers.updaterApply({})).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['check', 'download', 'download', 'apply']);
    rpc.dispose();
  });

  it('an apply failure is reported as {ok:false} with an error snapshot published', async () => {
    const { fake } = fakeUpdater({ check: { updateAvailable: true }, apply: new Error('no prepared update') });
    const sent: UpdateStatusWire[] = [];
    const rpc = registerUpdaterRpc({ send: (s) => sent.push(s) }, { updater: fake });
    await rpc.handlers.updaterCheckNow({});
    await rpc.handlers.updaterDownload({});
    await expect(rpc.handlers.updaterApply({})).resolves.toMatchObject({ ok: false, error: 'no prepared update' });
    expect(sent.at(-1)).toMatchObject({ phase: 'error', error: 'no prepared update' });
  });

  it('a check while a consent download is in flight is skipped (no state stacking over the consent flow)', async () => {
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });
    const { fake, calls } = fakeUpdater({ check: { updateAvailable: true }, hangDownload: hang });
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake });
    await rpc.handlers.updaterCheckNow({});
    const downloading = rpc.handlers.updaterDownload({});
    await expect(rpc.handlers.updaterCheckNow({})).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['check', 'download']);
    release();
    await expect(downloading).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['check', 'download']);
  });

  it('boot detects a persisted ready update (updateReady at start → status ready)', async () => {
    const { fake, calls } = fakeUpdater({ preReady: true, infoVersion: '1.1.0' });
    const sent: UpdateStatusWire[] = [];
    const rpc = registerUpdaterRpc(
      { send: (s) => sent.push(s) },
      { updater: fake, autoCheckEnabled: () => false, checkDelayMs: 60_000, checkIntervalMs: 3_600_000 },
    );
    rpc.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc.handlers.updaterStatus({}).status).toMatchObject({ phase: 'downloaded', version: '1.1.0', percent: 100 });
    expect(calls).toEqual([]);
    rpc.dispose();
  });

  it('a periodic check while an update sits ready never clobbers the ready snapshot', async () => {
    const { fake, calls } = fakeUpdater({ preReady: true, infoVersion: '1.1.0' });
    const sent: UpdateStatusWire[] = [];
    const rpc = registerUpdaterRpc(
      { send: (s) => sent.push(s) },
      { updater: fake, autoCheckEnabled: () => true, checkDelayMs: 60_000, checkIntervalMs: 3_600_000 },
    );
    rpc.start();
    // Let the boot detection publish ready before the check lands.
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc.handlers.updaterStatus({}).status).toMatchObject({ phase: 'downloaded' });
    await rpc.handlers.updaterCheckNow({});
    expect(calls).toEqual(['check']);
    expect(rpc.handlers.updaterStatus({}).status).toMatchObject({ phase: 'downloaded', version: '1.1.0' });
    rpc.dispose();
  });

  it('does not download when the check finds nothing', async () => {
    const { fake, calls } = fakeUpdater({ check: { updateAvailable: false } });
    const rpc = registerUpdaterRpc(
      { send: () => {} },
      { updater: fake, autoCheckEnabled: () => true, checkDelayMs: 0, checkIntervalMs: 3_600_000 },
    );
    rpc.start();
    rpc.dispose();
    await rpc.handlers.updaterCheckNow({});
    expect(calls).toEqual(['check']);
  });

  it('reports a manual check failure as {ok:false} instead of throwing', async () => {
    const { fake } = fakeUpdater({ checkThrow: new Error('network down') });
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake });
    await expect(rpc.handlers.updaterCheckNow({})).resolves.toMatchObject({ ok: false, error: 'network down' });
  });

  it('forwards devkit status entries as reduced snapshots', async () => {
    const { fake, emit } = fakeUpdater({});
    const sent: UpdateStatusWire[] = [];
    const rpc = registerUpdaterRpc({ send: (s) => sent.push(s) }, { updater: fake, autoCheckEnabled: () => false });
    rpc.start();
    await new Promise((r) => setTimeout(r, 0));
    emit(entry('checking'));
    emit(entry('update-available'));
    expect(sent.map((s) => s.phase)).toEqual(['checking', 'available']);
    expect(sent[1].currentVersion).toBe('1.0.0');
    rpc.dispose();
  });

  it('surfaces an errored check as a status error without throwing, and the schedule survives (unset baseUrl shape)', async () => {
    const { fake, calls } = fakeUpdater({ checkError: 'Failed to parse URL' });
    const sent: UpdateStatusWire[] = [];
    const rpc = registerUpdaterRpc(
      { send: (s) => sent.push(s) },
      { updater: fake, autoCheckEnabled: () => true, checkDelayMs: 0, checkIntervalMs: 3_600_000 },
    );
    rpc.start();
    rpc.dispose();
    await expect(rpc.handlers.updaterCheckNow({})).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['check']);
    expect(sent.at(-1)).toMatchObject({ phase: 'error', error: 'Failed to parse URL' });
  });

  it('schedules nothing when autoCheckEnabled is false', () => {
    vi.useFakeTimers();
    try {
      const { fake, calls } = fakeUpdater({});
      const rpc = registerUpdaterRpc(
        { send: () => {} },
        { updater: fake, autoCheckEnabled: () => false, checkDelayMs: 10, checkIntervalMs: 10 },
      );
      rpc.start();
      vi.advanceTimersByTime(1000);
      expect(calls).toHaveLength(0);
      rpc.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the boot-delayed check then the periodic one', () => {
    vi.useFakeTimers();
    try {
      const { fake, calls } = fakeUpdater({});
      const rpc = registerUpdaterRpc(
        { send: () => {} },
        { updater: fake, autoCheckEnabled: () => true, checkDelayMs: 100, checkIntervalMs: 200 },
      );
      rpc.start();
      vi.advanceTimersByTime(99);
      expect(calls).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(calls).toEqual(['check']);
      vi.advanceTimersByTime(200);
      expect(calls).toEqual(['check', 'check']);
      rpc.dispose();
      vi.advanceTimersByTime(1000);
      expect(calls).toEqual(['check', 'check']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('periodic re-checks while an update sits at available never download', () => {
    vi.useFakeTimers();
    try {
      const { fake, calls } = fakeUpdater({ check: { updateAvailable: true } });
      const rpc = registerUpdaterRpc(
        { send: () => {} },
        { updater: fake, autoCheckEnabled: () => true, checkDelayMs: 100, checkIntervalMs: 200 },
      );
      rpc.start();
      vi.advanceTimersByTime(100 + 3 * 200);
      expect(calls).toEqual(['check', 'check', 'check', 'check']);
      rpc.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('registerUpdaterRpc — updaterReleaseNotes', () => {
  it('fetches the GitHub release body for tide/v<version> and caches per version', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      jsonRes({ body: '## What changed\n- update flow' }),
    );
    const { fake } = fakeUpdater({});
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake, fetchImpl });
    await expect(rpc.handlers.updaterReleaseNotes({ version: '1.2.0' })).resolves.toEqual({
      markdown: '## What changed\n- update flow',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/code-with-current/tide/releases/tags/tide/v1.2.0',
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    // Cached — a second lookup for the same version doesn't refetch.
    await expect(rpc.handlers.updaterReleaseNotes({ version: '1.2.0' })).resolves.toEqual({
      markdown: '## What changed\n- update flow',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('strips a leading v and accepts v-prefixed input', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ body: 'notes' }));
    const { fake } = fakeUpdater({});
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake, fetchImpl });
    await expect(rpc.handlers.updaterReleaseNotes({ version: 'v1.2.1' })).resolves.toEqual({ markdown: 'notes' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/code-with-current/tide/releases/tags/tide/v1.2.1',
      expect.anything(),
    );
  });

  it('returns null markdown on 404 (no such release) and caches the miss', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ message: 'Not Found' }, 404));
    const { fake } = fakeUpdater({});
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake, fetchImpl });
    await expect(rpc.handlers.updaterReleaseNotes({ version: '9.9.9' })).resolves.toEqual({ markdown: null });
    await expect(rpc.handlers.updaterReleaseNotes({ version: '9.9.9' })).resolves.toEqual({ markdown: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache non-404 HTTP failures (rate limits clear)', async () => {
    let status = 403;
    const fetchImpl = vi.fn(async () => jsonRes({ message: 'rate limited' }, status));
    const { fake } = fakeUpdater({});
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake, fetchImpl });
    await expect(rpc.handlers.updaterReleaseNotes({ version: '1.4.0' })).resolves.toEqual({ markdown: null });
    status = 200;
    fetchImpl.mockImplementation(async () => jsonRes({ body: 'recovered' }));
    await expect(rpc.handlers.updaterReleaseNotes({ version: '1.4.0' })).resolves.toEqual({ markdown: 'recovered' });
  });

  it('returns null markdown on network failure (offline) and stays retryable', async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return jsonRes({ body: 'back online' });
    });
    const { fake } = fakeUpdater({});
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake, fetchImpl });
    await expect(rpc.handlers.updaterReleaseNotes({ version: '1.3.0' })).resolves.toEqual({ markdown: null });
    fail = false;
    await expect(rpc.handlers.updaterReleaseNotes({ version: '1.3.0' })).resolves.toEqual({ markdown: 'back online' });
  });

  it('rejects malformed versions without fetching (URL-injection guard)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ body: 'x' }));
    const { fake } = fakeUpdater({});
    const rpc = registerUpdaterRpc({ send: () => {} }, { updater: fake, fetchImpl });
    for (const version of ['', '  ', '../../etc', 'a b', 'v']) {
      await expect(rpc.handlers.updaterReleaseNotes({ version })).resolves.toEqual({ markdown: null });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
