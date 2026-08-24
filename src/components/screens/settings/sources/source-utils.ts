import type { KnowledgeSource, SourceKind, SourceProgressEvent } from '@/types';

/** Pure helpers for the Knowledge Sources settings section (no JSX) so they
 *  can be unit-tested in the node vitest environment. */

export const SOURCE_KINDS: readonly SourceKind[] = ['url', 'docs', 'crawl', 'repo'] as const;

export const KIND_LABELS: Record<SourceKind, string> = {
  url: 'URL',
  docs: 'Docs',
  crawl: 'Crawl',
  repo: 'Repo',
};

export const LOCATION_PLACEHOLDERS: Record<SourceKind, string> = {
  url: 'https://example.com/page',
  docs: '/path/to/folder-or-file.md',
  crawl: 'https://example.com (follows same-domain links)',
  repo: 'https://github.com/owner/repo.git',
};

/** Returns an error message, or null when the input is valid. */
export function validateSourceInput(
  name: string,
  kind: SourceKind,
  location: string,
): string | null {
  if (!name.trim()) return 'Name is required';
  if (!SOURCE_KINDS.includes(kind)) return 'Choose a source kind';
  if (!location.trim()) return 'Location is required';
  if ((kind === 'url' || kind === 'crawl') && !isHttpUrl(location.trim())) {
    return 'Enter a valid http(s) URL';
  }
  if (kind === 'repo' && !isGitLocation(location.trim())) {
    return 'Enter a git URL (https://, ssh://, git@host:path or file://)';
  }
  return null;
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isGitLocation(value: string): boolean {
  return (
    /^(https?|ssh|git|file):\/\//i.test(value) || /^git@[\w.-]+:[^\s]/i.test(value)
  );
}

export function relativeTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return 'never';
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) return 'just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Whether this source participates in searches for the given workspace
 *  ('["*"]' enablement covers every workspace). */
export function isSourceEnabledFor(
  source: Pick<KnowledgeSource, 'enabledWorkspaceIds'>,
  workspaceId: string | null | undefined,
): boolean {
  if (!workspaceId) return true;
  return (
    source.enabledWorkspaceIds.includes('*') ||
    source.enabledWorkspaceIds.includes(workspaceId)
  );
}

/** Human label for the toggle's enablement scope ('*' vs a concrete count). */
export function enablementLabel(source: Pick<KnowledgeSource, 'enabledWorkspaceIds'>): string {
  if (source.enabledWorkspaceIds.includes('*')) return 'all workspaces';
  const n = source.enabledWorkspaceIds.length;
  return n === 1 ? '1 workspace' : `${n} workspaces`;
}

/** DB status overlaid with the latest live progress event so rows flip to
 *  indexing/error immediately instead of waiting for the refetch. */
export function displayStatus(
  source: Pick<KnowledgeSource, 'id' | 'status'>,
  event: SourceProgressEvent | null | undefined,
): KnowledgeSource['status'] {
  if (!event || event.sourceId !== source.id) return source.status;
  if (event.phase === 'failed') return 'error';
  if (event.phase === 'done') return source.status;
  return 'indexing';
}

/** One-line detail for an in-flight ingestion event (status line under the name). */
export function progressDetail(event: SourceProgressEvent): string | null {
  switch (event.phase) {
    case 'fetching': {
      if (event.current) return `Fetching ${truncate(event.current, 48)}`;
      if (event.pagesSeen != null) return `Fetched ${event.pagesSeen} pages`;
      return 'Fetching…';
    }
    case 'chunking':
      return event.current ? `Reading ${truncate(event.current, 48)}` : 'Reading…';
    case 'embedding':
      if (event.chunksTotal != null && event.chunksEmbedded != null) {
        return `Embedding ${event.chunksEmbedded}/${event.chunksTotal}`;
      }
      return 'Embedding…';
    case 'done':
      return null;
    case 'failed':
      return event.error ? truncate(event.error, 120) : 'Indexing failed';
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
