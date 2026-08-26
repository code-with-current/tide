import { describe, expect, it } from 'vitest';
import {
  useUpdateStore,
  hasUpdate,
  canDownloadUpdate,
  canRestartUpdate,
  type UpdateStatusWire,
} from '@/lib/stores/update-store';

function status(
  phase: UpdateStatusWire['phase'],
  over: Partial<UpdateStatusWire> = {},
): UpdateStatusWire {
  return {
    phase,
    message: '',
    currentVersion: '1.0.0',
    version: null,
    percent: null,
    error: null,
    lastCheckedAt: null,
    ...over,
  };
}

describe('update-store — consent affordances', () => {
  it('hasUpdate is true only while an update is showing or in flight', () => {
    for (const phase of ['available', 'downloading', 'downloaded', 'applying'] as const) {
      expect(hasUpdate(status(phase))).toBe(true);
    }
    for (const phase of ['idle', 'checking', 'not-available', 'error'] as const) {
      expect(hasUpdate(status(phase))).toBe(false);
    }
    expect(hasUpdate(null)).toBe(false);
  });

  it('canDownloadUpdate: available consents, error retries only with a known version', () => {
    expect(canDownloadUpdate(status('available', { version: '1.1.0' }))).toBe(true);
    // Failed consent-driven download keeps the target version → retryable.
    expect(canDownloadUpdate(status('error', { version: '1.1.0', error: 'HTTP 500' }))).toBe(true);
    // A failed check never knew a version — "Check now" is the retry, not download.
    expect(canDownloadUpdate(status('error', { error: 'Failed to parse URL' }))).toBe(false);
    expect(canDownloadUpdate(status('checking'))).toBe(false);
    expect(canDownloadUpdate(status('downloading', { version: '1.1.0' }))).toBe(false);
    expect(canDownloadUpdate(status('downloaded', { version: '1.1.0' }))).toBe(false);
    expect(canDownloadUpdate(null)).toBe(false);
  });

  it('canRestartUpdate: only a prepared bundle (ready on disk) can apply', () => {
    expect(canRestartUpdate(status('downloaded', { version: '1.1.0' }))).toBe(true);
    expect(canRestartUpdate(status('available', { version: '1.1.0' }))).toBe(false);
    expect(canRestartUpdate(status('downloading', { version: '1.1.0' }))).toBe(false);
    expect(canRestartUpdate(status('error', { version: '1.1.0' }))).toBe(false);
    expect(canRestartUpdate(null)).toBe(false);
  });

  it('setStatus holds the latest snapshot across a consent sequence', () => {
    const { setStatus } = useUpdateStore.getState();
    setStatus(status('checking'));
    setStatus(status('available', { version: '1.1.0', lastCheckedAt: 42 }));
    expect(useUpdateStore.getState().status).toMatchObject({ phase: 'available', version: '1.1.0', lastCheckedAt: 42 });
    setStatus(status('downloading', { version: '1.1.0', percent: 40 }));
    expect(useUpdateStore.getState().status).toMatchObject({ phase: 'downloading', percent: 40 });
    setStatus(status('downloaded', { version: '1.1.0', percent: 100 }));
    expect(useUpdateStore.getState().status).toMatchObject({ phase: 'downloaded', percent: 100 });
    setStatus(status('applying', { version: '1.1.0' }));
    expect(useUpdateStore.getState().status).toMatchObject({ phase: 'applying' });
    setStatus(status('error', { version: '1.1.0', error: 'boom', percent: null }));
    expect(useUpdateStore.getState().status).toMatchObject({ phase: 'error', error: 'boom', version: '1.1.0' });
  });
});

describe('update-store — dialog state machine', () => {
  it('opens the release dialog from the pill and closes it (dialog-level Later/dismiss)', () => {
    useUpdateStore.getState().closeDialog();
    useUpdateStore.getState().openReleaseDialog();
    expect(useUpdateStore.getState().dialog).toBe('release');
    useUpdateStore.getState().closeDialog();
    expect(useUpdateStore.getState().dialog).toBeNull();
  });

  it('opening the progress dialog replaces the release dialog (Download swaps surfaces)', () => {
    useUpdateStore.getState().openReleaseDialog();
    useUpdateStore.getState().openProgressDialog();
    expect(useUpdateStore.getState().dialog).toBe('progress');
    useUpdateStore.getState().closeDialog();
  });

  it('later keeps the ready snapshot untouched (the prepared update survives dismiss)', () => {
    const { setStatus, openProgressDialog, closeDialog } = useUpdateStore.getState();
    setStatus(status('downloaded', { version: '1.1.0', percent: 100 }));
    openProgressDialog();
    expect(useUpdateStore.getState().dialog).toBe('progress');
    closeDialog();
    expect(useUpdateStore.getState().dialog).toBeNull();
    expect(useUpdateStore.getState().status).toMatchObject({ phase: 'downloaded', version: '1.1.0' });
  });
});
