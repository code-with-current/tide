/** CommitDetailsPanel — floating side panel (like the file viewer) showing a
 *  commit's metadata + changed files. Clicking a file expands its diff (at
 *  this commit) inline. Enriched: full message body, parent shas (clickable
 *  → navigate), tags, author avatar, absolute date + relative, and the AI
 *  explain/review actions. */
import { useEffect, useMemo, useState } from 'react';
import { X, GitCommitHorizontal, GitMerge, GitBranch, Tag, Loader2, ChevronRight, Copy, Check } from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { SkeletonBar } from '@/components/ui/loading-rows';
import { useSession, useCommitFiles, useGitLog } from '@/lib/queries';
import * as api from '@/lib/api/client';
import type { GitFileChange } from '@/lib/api/client';
import type { DiffHunk } from '@/types';
import { cn, formatRelative } from '@/lib/utils';
import { DiffView } from '@/components/chat/blocks/diff-view';
import { CommitAiActions } from './commit-ai-actions';

export interface CommitDetail {
  sha: string;
  author: string;
  date: string;
  subject: string;
  parents?: string[];
  tags?: string[];
  branchHeads?: string[];
  isHead?: boolean;
}

const STATUS_TONE: Record<GitFileChange['status'], string> = {
  added: 'text-emerald-500',
  modified: 'text-amber-500',
  deleted: 'text-red-500',
  renamed: 'text-sky-500',
  untracked: 'text-muted-foreground',
};

function hueOf(seed: string): number {
  return [...seed].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
}

function initialsOf(author: string): string {
  return author.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function CommitDetailsPanel({ commit }: { commit: CommitDetail }) {
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const activeSessionId = useUi((s) => s.activeSessionId);
  const setCommitDetail = useUi((s) => s.setCommitDetail);
  const { data: activeSession } = useSession(activeSessionId);
  const gitSessionId = activeSession?.worktree ? activeSessionId : undefined;

  const { data: files, isLoading } = useCommitFiles(activeWorkspaceId, commit.sha, gitSessionId);

  // Full message body (subject line comes in via commit; the body needs
  // fetching — gitLog only carries the subject).
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBody(null);
    if (activeWorkspaceId) {
      void api.gitCommitMessage(activeWorkspaceId, commit.sha, gitSessionId ?? undefined).then((msg) => {
        if (cancelled) return;
        const full = (msg ?? '').trim();
        const subject = commit.subject || '';
        // Strip the subject line (and its newline) — the panel renders it above.
        const rest = full.startsWith(subject) ? full.slice(subject.length).replace(/^\s+/, '') : full;
        setBody(rest || '');
      }).catch(() => { if (!cancelled) setBody(''); });
    }
    return () => { cancelled = true; };
  }, [commit.sha, commit.subject, activeWorkspaceId, gitSessionId]);

  // History index — lets parent-chip clicks jump to any ancestor commit.
  const { data: history } = useGitLog(activeWorkspaceId, gitSessionId, 500);
  const bySha = useMemo(() => {
    const m = new Map<string, typeof history extends readonly (infer T)[] | undefined ? T : never>();
    for (const c of history ?? []) m.set(c.sha, c);
    return m;
  }, [history]);

  // Inline-expandable diff: click a file to fetch its diff at this commit and
  // expand a DiffView below the row. Click again (or another file) to toggle.
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diffHunks, setDiffHunks] = useState<DiffHunk[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);

  const totals = useMemo(() => {
    let a = 0, d = 0;
    for (const f of files ?? []) { a += f.additions ?? 0; d += f.deletions ?? 0; }
    return { a, d, n: files?.length ?? 0 };
  }, [files]);

  const handleFile = async (f: GitFileChange) => {
    if (expandedPath === f.path) { setExpandedPath(null); setDiffHunks([]); return; }
    setExpandedPath(f.path);
    setDiffHunks([]);
    setDiffLoading(true);
    try {
      if (activeWorkspaceId) {
        const hunks = await api.gitCommitFileDiff(activeWorkspaceId, commit.sha, f.path, gitSessionId ?? undefined);
        setDiffHunks(hunks);
      }
    } catch { /* empty diff */ }
    setDiffLoading(false);
  };

  // Finding → file links open (and scroll to) that file's diff expansion.
  const openFile = (f: GitFileChange) => {
    if (expandedPath === f.path) return;
    void handleFile(f);
    requestAnimationFrame(() => {
      document.querySelector(`[data-commit-file="${CSS.escape(f.path)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };

  const goSha = (sha: string) => {
    const c = bySha.get(sha);
    if (c) setCommitDetail(c);
  };

  const hue = hueOf(commit.author);

  return (
    <div className="flex flex-col h-full min-h-0 bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-input flex-shrink-0">
        <GitCommitHorizontal className="size-3.5 text-muted-foreground/60 flex-shrink-0" />
        <ShaChip sha={commit.sha} />
        {(commit.tags?.length ?? 0) > 0 && (
          <span className="flex flex-shrink-0 items-center gap-0.5">
            {commit.tags!.slice(0, 3).map((t) => (
              <span key={t} className="flex items-center gap-0.5 rounded bg-warning/15 px-1 py-px font-mono text-[0.7143rem] text-warning" title={`tag ${t}`}>
                <Tag className="size-2.5" />
                {t}
              </span>
            ))}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setCommitDetail(null)}
          className="flex items-center justify-center size-6 rounded text-muted-foreground/60 hover:text-foreground hover:bg-secondary transition-colors"
          title="Close"
          aria-label="Close commit details"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Subject + enriched meta */}
      <div className="px-3 py-2.5 border-b border-input flex-shrink-0">
        <div className="text-[0.9286rem] font-medium leading-snug text-foreground">{commit.subject || '(no subject)'}</div>
        {body && (
          <p className="mt-1.5 whitespace-pre-wrap text-[0.8571rem] leading-relaxed text-muted-foreground/85">{body}</p>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className="flex size-4 flex-shrink-0 items-center justify-center rounded-full text-[0.5rem] font-semibold text-white"
            style={{ background: `hsl(${hue} 40% 42%)` }}
            title={commit.author}
          >
            {initialsOf(commit.author)}
          </span>
          <span className="truncate text-[0.7857rem] text-muted-foreground/80" title={commit.author}>{commit.author}</span>
          <span className="text-muted-foreground/30">·</span>
          <span className="flex-shrink-0 text-[0.7857rem] text-muted-foreground/60" title={formatAbsolute(commit.date)}>
            {formatRelative(commit.date)}
          </span>
        </div>
        {(commit.parents?.length ?? 0) > 0 && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[0.7857rem] font-mono text-muted-foreground/50">
            {commit.parents!.length > 1 ? <GitMerge className="size-3 flex-shrink-0" /> : <GitCommitHorizontal className="size-3 flex-shrink-0 rotate-90" />}
            {commit.parents!.map((p, i) => (
              <span key={p} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-muted-foreground/30">+</span>}
                <button
                  type="button"
                  onClick={() => goSha(p)}
                  disabled={!bySha.has(p)}
                  title={bySha.has(p) ? `Go to ${p}` : `${p} (outside loaded history)`}
                  className={cn(
                    'rounded px-0.5 transition-colors',
                    bySha.has(p) ? 'text-primary/70 hover:text-primary hover:bg-primary/10' : 'cursor-default opacity-60',
                  )}
                >
                  {p}
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2 text-[0.7857rem] font-mono tabular-nums">
          <span className="text-muted-foreground/50">{totals.n} {totals.n === 1 ? 'file' : 'files'}</span>
          <span className="text-emerald-500">+{totals.a}</span>
          <span className="text-red-500">−{totals.d}</span>
          <div className="flex-1" />
          {commit.isHead && (
            <span className="flex items-center gap-1 rounded bg-primary/15 px-1.5 py-px font-sans text-[0.7143rem] text-primary">
              <GitBranch className="size-2.5" /> HEAD{(commit.branchHeads?.length ?? 0) > 0 ? ` · ${commit.branchHeads![0]}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* AI actions + results (explain card, review findings) */}
      <CommitAiActions
        commit={commit}
        files={files}
        filesLoading={isLoading}
        workspaceId={activeWorkspaceId}
        gitSessionId={gitSessionId}
        onOpenFile={openFile}
      />

      {/* Changed files */}
      <div className="flex-1 min-h-0 overflow-y-auto scroll">
        {isLoading ? (
          <div aria-hidden>
            {[...Array(4)].map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5"
              >
                <SkeletonBar className="size-3 shrink-0 rounded-[3px]" />
                <SkeletonBar className="h-3 w-3 shrink-0 rounded-[3px]" />
                <SkeletonBar className="h-3" style={{ width: `${35 + i * 10}%` }} />
                <span className="flex-1" />
                <SkeletonBar className="h-2 w-7 shrink-0" />
              </div>
            ))}
          </div>
        ) : totals.n === 0 ? (
          <div className="flex items-center justify-center h-24 text-[0.8571rem] text-muted-foreground/50">No files in this commit.</div>
        ) : (
          files!.map((f) => (
            <div key={f.path} data-commit-file={f.path}>
              <CommitFileRow
                file={f}
                expanded={expandedPath === f.path}
                onClick={() => handleFile(f)}
              />
              {expandedPath === f.path && (
                <div className="border-b border-border/40 bg-background/50">
                  {diffLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="size-4 animate-spin text-muted-foreground/50" />
                    </div>
                  ) : diffHunks.length > 0 ? (
                    <DiffView hunks={diffHunks} />
                  ) : (
                    <div className="px-3 py-2 text-[0.7857rem] text-muted-foreground/50">No text changes (binary or rename).</div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CommitFileRow({ file, expanded, onClick }: { file: GitFileChange; expanded: boolean; onClick: () => void }) {
  const name = file.path.split('/').pop() ?? file.path;
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.length - name.length) : '';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors border-b border-border/40 group',
        expanded ? 'bg-secondary/40' : 'hover:bg-secondary/50',
      )}
    >
      <ChevronRight className={cn('size-3 flex-shrink-0 text-muted-foreground/50 transition-transform', expanded && 'rotate-90')} />
      <span className="min-w-0 flex-1 flex items-baseline gap-1">
        <span className={cn('text-[0.7857rem] font-mono uppercase flex-shrink-0', STATUS_TONE[file.status])}>
          {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M'}
        </span>
        <span className="text-[0.8571rem] truncate text-foreground">{name}</span>
        {dir && <span className="text-[0.7857rem] text-muted-foreground/40 truncate">{dir}</span>}
      </span>
      <span className="flex-shrink-0 text-[0.7857rem] font-mono tabular-nums">
        {file.additions ? <span className="text-emerald-500">+{file.additions}</span> : null}
        {file.additions && file.deletions ? ' ' : null}
        {file.deletions ? <span className="text-red-500">−{file.deletions}</span> : null}
      </span>
    </button>
  );
}

function ShaChip({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(sha).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); };
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${sha}`}
      className="inline-flex items-center gap-1 font-mono text-[0.7857rem] text-primary/80 hover:text-primary transition-colors"
    >
      {sha}
      {copied ? <Check className="size-3" /> : <Copy className="size-3 opacity-50" />}
    </button>
  );
}
