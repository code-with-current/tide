import { describe, it, expect } from 'vitest';
import {
  SOURCE_KINDS,
  KIND_LABELS,
  LOCATION_PLACEHOLDERS,
  validateSourceInput,
  isHttpUrl,
  relativeTime,
  isSourceEnabledFor,
  enablementLabel,
  displayStatus,
  progressDetail,
} from '../../../src/components/screens/settings/sources/source-utils';

describe('validateSourceInput', () => {
  it('accepts a valid input for every kind', () => {
    expect(validateSourceInput('Page', 'url', 'https://example.com/a')).toBeNull();
    expect(validateSourceInput('Docs', 'docs', '/tmp/notes')).toBeNull();
    expect(validateSourceInput('Site', 'crawl', 'http://example.com')).toBeNull();
    expect(validateSourceInput('Repo', 'repo', 'https://github.com/o/r.git')).toBeNull();
    expect(validateSourceInput('Repo', 'repo', 'git@github.com:o/r.git')).toBeNull();
  });

  it('rejects missing name / kind / location', () => {
    expect(validateSourceInput('  ', 'url', 'https://x.dev')).toMatch(/name/i);
    expect(validateSourceInput('N', 'nope' as never, 'https://x.dev')).toMatch(/kind/i);
    expect(validateSourceInput('N', 'url', '   ')).toMatch(/location/i);
  });

  it('requires http(s) URLs for url and crawl kinds', () => {
    expect(validateSourceInput('N', 'url', 'not-a-url')).toMatch(/http/i);
    expect(validateSourceInput('N', 'url', 'ftp://example.com')).toMatch(/http/i);
    expect(validateSourceInput('N', 'crawl', '/local/path')).toMatch(/http/i);
  });

  it('requires a git-shaped location for repo kind', () => {
    expect(validateSourceInput('N', 'repo', 'just text')).toMatch(/git/i);
    expect(
      validateSourceInput('N', 'repo', 'file:///tmp/fixtures/repo'),
    ).toBeNull();
    expect(
      validateSourceInput('N', 'repo', 'ssh://git@host.team/repo.git'),
    ).toBeNull();
  });
});

describe('isHttpUrl', () => {
  it('parses only http and https schemes', () => {
    expect(isHttpUrl('https://a.b/c?d=1')).toBe(true);
    expect(isHttpUrl('http://localhost:3000')).toBe(true);
    expect(isHttpUrl('file:///etc/hosts')).toBe(false);
    expect(isHttpUrl('example.com')).toBe(false);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-08-23T12:00:00Z');

  it('renders never for null/undefined timestamps', () => {
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime(undefined, now)).toBe('never');
  });

  it('buckets into just now / minutes / hours / days / date', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(relativeTime(now - 45 * 86_400_000, now)).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it('clamps future timestamps to just now', () => {
    expect(relativeTime(now + 60_000, now)).toBe('just now');
  });
});

describe('enablement helpers', () => {
  const star = { enabledWorkspaceIds: ['*'] };
  const scoped = { enabledWorkspaceIds: ['ws-1', 'ws-2'] };

  it("'*' covers every workspace; concrete lists match exactly", () => {
    expect(isSourceEnabledFor(star, 'any-ws')).toBe(true);
    expect(isSourceEnabledFor(star, null)).toBe(true);
    expect(isSourceEnabledFor(scoped, 'ws-1')).toBe(true);
    expect(isSourceEnabledFor(scoped, 'ws-9')).toBe(false);
  });

  it('labels the enablement scope', () => {
    expect(enablementLabel(star)).toBe('all workspaces');
    expect(enablementLabel(scoped)).toBe('2 workspaces');
    expect(enablementLabel({ enabledWorkspaceIds: ['ws-1'] })).toBe('1 workspace');
  });
});

describe('displayStatus', () => {
  const src = { id: 's1', status: 'idle' as const };

  it('ignores events for other sources and passes through db status', () => {
    expect(displayStatus(src, { sourceId: 'other', phase: 'embedding' })).toBe('idle');
    expect(displayStatus(src, null)).toBe('idle');
  });

  it('maps live phases onto indexing/error', () => {
    expect(displayStatus(src, { sourceId: 's1', phase: 'fetching' })).toBe('indexing');
    expect(displayStatus(src, { sourceId: 's1', phase: 'chunking' })).toBe('indexing');
    expect(displayStatus(src, { sourceId: 's1', phase: 'embedding' })).toBe('indexing');
    expect(displayStatus(src, { sourceId: 's1', phase: 'failed', error: 'boom' })).toBe('error');
  });

  it('defers to db status once the terminal done event lands', () => {
    const queued = { id: 's1', status: 'queued' as const };
    expect(displayStatus(queued, { sourceId: 's1', phase: 'done' })).toBe('queued');
  });
});

describe('progressDetail', () => {
  it('describes fetching with current url or page count', () => {
    expect(progressDetail({ sourceId: 's', phase: 'fetching', current: 'https://example.com/x' })).toContain(
      'Fetching',
    );
    expect(progressDetail({ sourceId: 's', phase: 'fetching', pagesSeen: 7 })).toContain('7 pages');
    expect(progressDetail({ sourceId: 's', phase: 'fetching' })).toMatch(/Fetching/);
  });

  it('describes embedding progress as n/total', () => {
    expect(
      progressDetail({ sourceId: 's', phase: 'embedding', chunksEmbedded: 3, chunksTotal: 12 }),
    ).toBe('Embedding 3/12');
  });

  it('surfaces failure messages and hides detail on done', () => {
    expect(progressDetail({ sourceId: 's', phase: 'failed', error: 'ECONNREFUSED' })).toContain(
      'ECONNREFUSED',
    );
    expect(progressDetail({ sourceId: 's', phase: 'done' })).toBeNull();
  });
});

describe('kind tables are exhaustive', () => {
  it('every kind has a label and placeholder', () => {
    for (const kind of SOURCE_KINDS) {
      expect(KIND_LABELS[kind]).toBeTruthy();
      expect(LOCATION_PLACEHOLDERS[kind]).toBeTruthy();
    }
  });
});
