/** Updater wiring — port of electron/updater.ts semantics onto the Electrobun
 *  Updater (bsdiff patch chains / full-tar fallback from a static
 *  release.baseUrl; the dev channel never reports updates by design).
 *
 *  Differences from the Electron shell, all consequences of the devkit API:
 *  - No app-update.yml bootstrap, so checks also run in dev builds — the
 *    devkit answers "no-update / Dev channel - updates disabled" itself.
 *  - No ad-hoc-signature "manual download" mode: the Electrobun updater
 *    swaps the bundle transactionally and doesn't validate against a
 *    code-signature pinned to the running build.
 *  - electron-updater staged the download and installed on quit
 *    (autoInstallOnAppQuit); the devkit has no install-on-quit mode, so the
 *    port keeps the two consent actions separate: updaterDownload stages
 *    the bundle (a prepared update persists on disk), updaterApply swaps
 *    and relaunches. applyUpdate routes through the quit-approval flow
 *    (before-quit handlers — including the app's abort/dispose lifecycle —
 *    run before the helper swaps the bundle).
 *
 *  Consent model: checks are automatic (boot-delayed + periodic, gated on
 *  the autoUpdateCheck setting), but every check STOPS at "available" —
 *  nothing downloads until the user clicks Download (release dialog or
 *  Settings → Updates), and nothing applies until Restart Now. A prepared
 *  update is re-detected at boot (updateInfo().updateReady), so "Later"
 *  survives restarts and the pill re-prompts. The devkit swallows
 *  download/apply failures into `error` status entries, so readiness is
 *  read back from updateInfo() after each step and failures are
 *  republished as an error snapshot (the retry affordance) if no entry
 *  surfaced one.
 *
 *  The status stream is reduced here into the UpdateStatusWire phase model
 *  and pushed via the updateStatus message; the renderer store just holds
 *  the latest snapshot. The updater is injectable so tests drive fakes. */

import { Updater as ElectrobunUpdater } from 'electrobun/main';
import type { UpdateStatusEntry } from 'electrobun/main';
import { createLogger } from './core/logger.js';
import { getGeneralSettings } from './core/store.js';
import type { UpdatePhase, UpdateStatusWire } from '../shared/rpc';

const log = createLogger('updater');

/** Courtesy delay before the first check — just enough for the window and
 *  splash paint to land; the check then runs in the background while the
 *  splash screen is still up, so the pill already knows the answer by the
 *  time the user reaches the main screen. */
export const CHECK_DELAY_MS = 500;
/** Periodic re-check cadence (Task 4.1: 4h). */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Structural slice of the devkit Updater the wiring touches. */
export interface ElectrobunUpdaterLike {
  onStatusChange(cb: ((entry: UpdateStatusEntry) => void) | null): void;
  checkForUpdate(): Promise<{ updateAvailable: boolean; updateReady: boolean; version: string; error: string }>;
  downloadUpdate(): Promise<void>;
  applyUpdate(): Promise<void>;
  updateInfo(): { updateAvailable: boolean; updateReady: boolean; version: string; error: string };
  getLocalInfo(): Promise<{ version: string; channel: string }>;
}

export interface UpdaterDeps {
  /** Pushes a reduced snapshot to the webview (the updateStatus message). */
  send: (status: UpdateStatusWire) => void;
}

export interface UpdaterOpts {
  /** Devkit updater — injectable for tests. */
  updater?: ElectrobunUpdaterLike;
  /** General-settings gate for the automatic schedule (manual checks bypass). */
  autoCheckEnabled?: () => boolean;
  checkDelayMs?: number;
  checkIntervalMs?: number;
  /** Release-notes fetcher — injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** GitHub repo backing the updater's release channel — release notes are the
 *  matching GitHub Release body for tag v<version>. */
const GITHUB_REPO = 'code-with-current/tide';

/** Per-version in-memory cache of release-note lookups (successful ones and
 *  definitive 404s — transient network failures stay uncached so a retry
 *  after coming online can succeed). */
const releaseNotesCache = new Map<string, string | null>();

/** Fetch the markdown body of the GitHub Release tagged v<version>.
 *  Graceful null on any failure (offline, rate limit, missing release) —
 *  the UI falls back to an intentional "details unavailable" note while
 *  keeping the version + Download affordance. */
async function fetchReleaseNotes(
  rawVersion: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const version = rawVersion.trim().replace(/^v/, '');
  if (!version || !/^[\w.+-]+$/.test(version)) return null;
  if (releaseNotesCache.has(version)) return releaseNotesCache.get(version)!;
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${version}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (res.ok) {
      const body = (await res.json()) as { body?: unknown };
      const markdown = typeof body.body === 'string' && body.body.trim() ? body.body : null;
      releaseNotesCache.set(version, markdown);
      return markdown;
    }
    if (res.status === 404) releaseNotesCache.set(version, null);
    return null;
  } catch {
    return null;
  }
}

const DUMMY_RELEASE_NOTES = `## \u2728 Highlights

- **Consent-driven updates** \u2014 downloading now starts only after you click *Update* (#142)
- Splash screen shows the **live app version**, sourced from the bundle (#150)
- Update pill, dialog, and Settings \u2192 Updates now share one state machine (#142)

### Fixed

- RAG indexing crashed on chunks longer than 512 tokens \u2014 the embedder now truncates (#148)
- macOS keychain writes failed while the login keychain was locked (#151)

### Under the hood

\`\`\`ts
// code blocks render too
const pill = phase === 'available' ? 'Update ready' : 'Up to date';
\`\`

> **Local preview** \u2014 this changelog is a placeholder for canary builds whose
> GitHub Release does not exist yet. The real notes come from the release body.

| Area | Change |
| --- | --- |
| updater | consent flow, progress dialog |
| shell | version badge, quit lifecycle |
`;

/** Map one devkit status entry onto the coarse UI phase. */
function phaseOf(status: UpdateStatusEntry['status']): UpdatePhase | null {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'checking':
      return 'checking';
    case 'no-update':
    case 'check-complete':
      return 'not-available';
    case 'update-available':
      return 'available';
    case 'download-complete':
      return 'downloaded';
    case 'applying':
    case 'extracting':
    case 'replacing-app':
    case 'launching-new-version':
    case 'complete':
      return 'applying';
    case 'error':
      return 'error';
    // Patch-chain and bundle-download bookkeeping — all interior states of a
    // download; patch-failed explicitly falls back to the full bundle.
    case 'download-starting':
    case 'downloading':
    case 'download-progress':
    case 'checking-local-tar':
    case 'local-tar-found':
    case 'local-tar-missing':
    case 'fetching-patch':
    case 'patch-found':
    case 'patch-not-found':
    case 'downloading-patch':
    case 'applying-patch':
    case 'patch-applied':
    case 'extracting-version':
    case 'patch-chain-complete':
    case 'patch-failed':
    case 'downloading-full-bundle':
    case 'decompressing':
      return 'downloading';
    default:
      return null;
  }
}

/** Pure reducer: folds one devkit status entry into the UI snapshot.
 *  Exported for unit tests. `info` is the devkit updateInfo() state at
 *  emission time — entries don't carry the target version, the info
 *  snapshot does. */
export function reduceUpdateStatus(
  prev: UpdateStatusWire | null,
  entry: UpdateStatusEntry,
  info: { version: string; updateAvailable: boolean; updateReady: boolean },
  currentVersion: string,
): UpdateStatusWire {
  const phase = phaseOf(entry.status);
  if (phase === null) return prev ?? idleStatus(currentVersion);
  const base: UpdateStatusWire = prev ?? idleStatus(currentVersion);
  const next: UpdateStatusWire = {
    ...base,
    phase,
    message: entry.message,
    currentVersion,
  };
  next.lastCheckedAt =
    phase === 'not-available' || phase === 'error' ? entry.timestamp : base.lastCheckedAt;
  next.version = info.updateAvailable || info.updateReady
    ? (info.version || base.version)
    : phase === 'downloading' || phase === 'downloaded'
      ? base.version
      : null;
  next.percent =
    phase === 'downloading'
      ? (entry.details?.progress ?? (entry.details?.totalBytes && entry.details.bytesDownloaded !== undefined
        ? Math.min(99, Math.floor((entry.details.bytesDownloaded / entry.details.totalBytes) * 100))
        : base.percent))
      : phase === 'downloaded'
        ? 100
        : null;
  next.error = phase === 'error' ? (entry.details?.errorMessage ?? entry.message) : null;
  return next;
}

function idleStatus(currentVersion: string): UpdateStatusWire {
  return {
    phase: 'idle',
    message: '',
    currentVersion,
    version: null,
    percent: null,
    error: null,
    lastCheckedAt: null,
  };
}

export function registerUpdaterRpc(deps: UpdaterDeps, opts: UpdaterOpts = {}) {
  const updater = opts.updater ?? ElectrobunUpdater;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const autoCheckEnabled = opts.autoCheckEnabled ?? (() => {
    try { return getGeneralSettings().autoUpdateCheck !== false; }
    catch { return true; }
  });
  const checkDelayMs = opts.checkDelayMs ?? CHECK_DELAY_MS;
  const checkIntervalMs = opts.checkIntervalMs ?? CHECK_INTERVAL_MS;

  let currentVersion = '0.0.0-dev';
  let current: UpdateStatusWire | null = null;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let consentInFlight = false;

  function publish(next: UpdateStatusWire): void {
    current = next;
    deps.send(next);
  }

  function onEntry(entry: UpdateStatusEntry): void {
    // "Later" keeps a prepared bundle on disk — a later periodic check that
    // finds nothing new must not clobber the ready snapshot (the pill would
    // lose its Restart-to-update prompt until the next boot).
    const phase = phaseOf(entry.status);
    if (current?.phase === 'downloaded' && (phase === 'checking' || phase === 'not-available')) return;
    publish(reduceUpdateStatus(current, entry, updater.updateInfo(), currentVersion));
  }

  /** Explicit stop-at-available publication from the check result. The
   *  devkit's `update-available` entry usually got there first via onEntry;
   *  this guarantees the target version rides the wire even when it didn't,
   *  and refreshes the version when a later check finds a newer one. Never
   *  regresses a consent flow already past available. */
  function ensureAvailable(version: string): void {
    const base = current ?? idleStatus(currentVersion);
    if (base.phase === 'downloading' || base.phase === 'downloaded' || base.phase === 'applying') return;
    if (base.phase === 'available' && (!version || base.version === version)) return;
    publish({ ...base, phase: 'available', version: version || base.version, percent: null, error: null });
  }

  /** Failure publication for paths where the devkit threw instead of
   *  emitting an error entry. Keeps the target version (retry affordance)
   *  and dedupes against the entry-driven snapshot when both fire. */
  function publishError(error: string): void {
    const base = current ?? idleStatus(currentVersion);
    if (base.phase === 'error' && base.error === error) return;
    publish({ ...base, phase: 'error', error, percent: null });
  }

  /** Check only — the consent model stops here. Skipped while a consent
   *  action is in flight so a periodic tick can't stack a `checking`
   *  snapshot over the user-approved download/apply. The devkit
   *  deduplicates concurrent calls, so re-entrancy from the periodic tick
   *  racing a manual check is safe. */
  async function runCheck(): Promise<void> {
    if (consentInFlight) return;
    const info = await updater.checkForUpdate();
    if (!info.updateAvailable) return;
    ensureAvailable(info.version);
  }

  function schedule(): void {
    if (disposed || !autoCheckEnabled()) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      void runCheck().catch((e) => log.warn('auto-check failed', { err: e instanceof Error ? e.message : String(e) }));
      intervalTimer = setInterval(() => {
        void runCheck().catch((e) => log.warn('periodic check failed', { err: e instanceof Error ? e.message : String(e) }));
      }, checkIntervalMs);
    }, checkDelayMs);
  }

  return {
    handlers: {
      updaterStatus: (_: Record<string, never>) => ({ status: current }),
      updaterCheckNow: async (_: Record<string, never>) => {
        try {
          await runCheck();
          return { ok: true };
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          return { ok: false, error };
        }
      },
      /** Changelog for a version: the GitHub Release body for tag
       *  v<version>. Graceful null — offline/missing releases render
       *  the dialog's "details unavailable" fallback. */
      updaterReleaseNotes: async ({ version }: { version: string }) => {
        let markdown = await fetchReleaseNotes(version, fetchImpl);
        // Local canary testing: unreleased versions have no GitHub Release.
        // Real canary builds always do (CI tags them), so this placeholder
        // only ever surfaces on hand-built local test bundles.
        if (markdown === null && process.env['ELECTROBUN_INSTALL_ROOT_NAME'] === 'canary') {
          markdown = DUMMY_RELEASE_NOTES;
        }
        return { markdown };
      },
      /** Consent action 1 — download only, stops at ready. Nothing applies
       *  until updaterApply. Skips the download when a bundle is already
       *  prepared (retry after a failed apply, or a restart while ready). */
      updaterDownload: async (_: Record<string, never>) => {
        if (consentInFlight) return { ok: false, error: 'update already in progress' };
        const initial = updater.updateInfo();
        if (!initial.updateReady && !initial.updateAvailable) {
          return { ok: false, error: 'no update available' };
        }
        if (initial.updateReady) return { ok: true };
        consentInFlight = true;
        try {
          await updater.downloadUpdate();
          const info = updater.updateInfo();
          if (!info.updateReady) {
            const error = info.error || (info.updateAvailable ? 'update download failed' : 'no update available');
            publishError(error);
            return { ok: false, error };
          }
          return { ok: true };
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          publishError(error);
          return { ok: false, error };
        } finally {
          consentInFlight = false;
        }
      },
      /** Consent action 2 — apply a prepared update (swap + relaunch via the
       *  quit-approval flow). Requires a ready bundle; the download step
       *  never runs implicitly. */
      updaterApply: async (_: Record<string, never>) => {
        if (consentInFlight) return { ok: false, error: 'update already in progress' };
        if (!updater.updateInfo().updateReady) {
          return { ok: false, error: 'update not downloaded' };
        }
        consentInFlight = true;
        try {
          await updater.applyUpdate();
          return { ok: true };
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          publishError(error);
          return { ok: false, error };
        } finally {
          consentInFlight = false;
        }
      },
    },
    /** Registers the status listener and starts the automatic schedule. */
    start(): void {
      updater.onStatusChange(onEntry);
      void updater.getLocalInfo().then((info) => {
        if (disposed) return;
        if (info.version) currentVersion = info.version;
        // Seed the snapshot so updaterStatus answers before any entry fires
        // (onStatusChange registration itself reconciles native results and
        // may emit, but a fresh install has no history).
        if (!current) current = idleStatus(currentVersion);
        // Boot re-detection: a prepared update persists on disk, so "Later"
        // from a previous session must land back at ready (the pill
        // re-prompts Restart to update). Explicit publication guarantees it
        // even when reconciliation emitted nothing.
        const live = updater.updateInfo();
        if (live.updateReady) {
          const base = current ?? idleStatus(currentVersion);
          if (base.phase !== 'downloaded' && base.phase !== 'downloading' && base.phase !== 'applying') {
            publish({
              ...base,
              phase: 'downloaded',
              version: live.version || base.version,
              percent: 100,
              error: null,
            });
          }
        }
      }).catch(() => {});
      schedule();
    },
    /** Stops timers (tests, and defense in depth against post-quit ticks). */
    dispose(): void {
      disposed = true;
      if (checkTimer !== null) clearTimeout(checkTimer);
      if (intervalTimer !== null) clearInterval(intervalTimer);
      checkTimer = null;
      intervalTimer = null;
    },
  };
}

export type UpdaterRpc = ReturnType<typeof registerUpdaterRpc>;
