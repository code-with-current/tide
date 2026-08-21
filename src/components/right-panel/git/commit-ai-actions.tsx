/** CommitAiActions — ✨ Explain / ✨ Review on the commit details sheet.
 *  Explain runs a plain model turn on the active session (no sub-agent);
 *  Review dispatches the code-reviewer agent with the commit's per-file
 *  diffs — numstat-only past the size cap, and the prompt says so (the
 *  agent runs in the workspace and can fetch the rest itself). Finished
 *  results are cached per sha for the app lifetime so reopening the sheet
 *  doesn't refetch; ✕ dismisses a card and drops its cache entry. Both
 *  actions share one session turn slot, so a click while a turn is running
 *  queues behind it instead of erroring. */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import * as api from '@/lib/api/client';
import type { GitFileChange } from '@/lib/api/client';
import type { DiffHunk } from '@/types';

import { toast } from '@/lib/toast';
import { useGitAgentAction } from '@/hooks/use-git-agent-action';

type CommitDetail = { sha: string; author: string; date: string; subject: string };

/** sha → finished reports; survives sheet close/unmount. */
const CACHE = new Map<string, { explain?: string; review?: string }>();

const MAX_FILES = 10;
const MAX_DIFF_LINES = 2000;

/** 'pending' covers preparing/queued/streaming (live text comes from the hook). */
type Slot = { phase: 'pending'; queued: boolean } | { phase: 'done'; text: string } | null;

function numstatLine(f: GitFileChange): string {
  return `- ${f.path} +${f.additions ?? 0}/−${f.deletions ?? 0}`;
}

function serializeDiff(hunks: DiffHunk[]): string {
  return hunks
    .map((h) => [h.header, ...h.lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : l.type === 'hunk' ? '@' : ' '} ${l.text}`)].join('\n'))
    .join('\n');
}

/** Split a finished report into finding paragraphs, each linked to the
 *  changed file it names (longest path match wins, basename fallback). */
function parseFindings(report: string, files: GitFileChange[]): { text: string; file?: GitFileChange }[] {
  const byPath = [...files].sort((a, b) => b.path.length - a.path.length);
  return report
    .split(/\n{2,}/)
    .map((p) => p.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '').trim())
    .filter((p) => p.length > 0)
    .map((text) => {
      let file = byPath.find((f) => text.includes(f.path));
      if (!file) {
        const byBase = files.filter((f) => text.includes(f.path.split('/').pop() ?? '\0'));
        if (byBase.length === 1) file = byBase[0];
      }
      return { text, file };
    });
}

export function CommitAiActions({
  commit,
  files,
  filesLoading,
  workspaceId,
  gitSessionId,
  onOpenFile,
}: {
  commit: CommitDetail;
  files: GitFileChange[] | undefined;
  filesLoading: boolean;
  workspaceId: string | null;
  /** Worktree-aware session id for git fetches (per-file diffs). */
  gitSessionId?: string | null;
  onOpenFile: (f: GitFileChange) => void;
}) {
  const { run: runExplain, state: explainState, reset: resetExplain } = useGitAgentAction();
  const { run: runReview, state: reviewState, reset: resetReview } = useGitAgentAction();
  const [explainSlot, setExplainSlot] = useState<Slot>(null);
  const [reviewSlot, setReviewSlot] = useState<Slot>(null);
  const [pending, setPending] = useState<'explain' | 'review' | null>(null);

  const anyRunning = explainState.status === 'running' || reviewState.status === 'running';

  // (Re)seed from cache when the sheet switches commits.
  useEffect(() => {
    resetExplain();
    resetReview();
    const c = CACHE.get(commit.sha);
    setExplainSlot(c?.explain != null ? { phase: 'done', text: c.explain } : null);
    setReviewSlot(c?.review != null ? { phase: 'done', text: c.review } : null);
    setPending(null);
  }, [commit.sha, resetExplain, resetReview]);

  const fireExplain = useCallback(() => {
    if (!workspaceId) {
      setExplainSlot(null);
      toast.error('Could not explain commit', { description: 'Needs a workspace.' });
      return;
    }
    const list = files ?? [];
    const task = [
      `Explain commit ${commit.sha} in 2-4 sentences: what it changes and why. Plain prose, no file list.`,
      '',
      `Subject: ${commit.subject || '(no subject)'}`,
      `Author: ${commit.author}`,
      `Files changed (${list.length}, numstat):`,
      list.map(numstatLine).join('\n') || '(none)',
    ].join('\n');
    setExplainSlot({ phase: 'pending', queued: false });
    const res = runExplain({ workspaceId, task });
    if (res.status === 'error') {
      setExplainSlot(null);
      toast.error('Could not explain commit', { description: 'Needs an active, idle session.' });
    }
  }, [workspaceId, files, commit.sha, commit.subject, commit.author, runExplain]);

  const fireReview = useCallback(async () => {
    if (!workspaceId) {
      setReviewSlot(null);
      toast.error('Could not dispatch code-reviewer', { description: 'Needs a workspace.' });
      return;
    }
    setReviewSlot({ phase: 'pending', queued: false });
    const list = files ?? [];
    let capped = list.length > MAX_FILES;
    let diffSection = '';
    if (!capped && list.length > 0) {
      const parts: string[] = [];
      let totalLines = 0;
      for (const f of list) {
        let hunks: DiffHunk[] = [];
        try {
          hunks = await api.gitCommitFileDiff(workspaceId, commit.sha, f.path, gitSessionId ?? undefined);
        } catch { /* skip unreadable files */ }
        totalLines += hunks.reduce((n, h) => n + h.lines.length, 0);
        const text = serializeDiff(hunks);
        parts.push(`--- ${f.path}\n${text || '(no text changes)'}`);
      }
      if (totalLines > MAX_DIFF_LINES) capped = true;
      else diffSection = parts.join('\n\n');
    }
    const task = [
      `Review the code changes in git commit ${commit.sha} ("${commit.subject || '(no subject)'}") for correctness bugs, risky changes, and security issues — not style.`,
      '',
      `Changed files (${list.length}, numstat):`,
      list.map(numstatLine).join('\n') || '(none)',
      '',
      capped
        ? `This commit is large, so the full diffs are omitted. You run in the workspace — inspect the files yourself (e.g. \`git show ${commit.sha} -- <path>\`) before reporting.`
        : `Per-file diffs:\n${diffSection}`,
      '',
      'Report each finding as its own short paragraph starting with the file path it concerns (e.g. `src/foo.ts — ...`). If nothing is wrong, say so briefly.',
    ].join('\n');
    const res = runReview({ workspaceId, agent: 'code-reviewer', task });
    if (res.status === 'error') {
      setReviewSlot(null);
      toast.error('Could not dispatch code-reviewer', { description: 'Needs an active, idle session.' });
    }
  }, [workspaceId, files, gitSessionId, commit.sha, commit.subject, runReview]);

  // Settle finished/failed runs into the slot + cache.
  useEffect(() => {
    if (explainState.status === 'done') {
      if (explainSlot?.phase === 'pending') {
        const text = explainState.report.trim();
        setExplainSlot({ phase: 'done', text });
        const c = CACHE.get(commit.sha) ?? {};
        c.explain = text;
        CACHE.set(commit.sha, c);
      }
    } else if (explainState.status === 'error' && explainSlot) {
      setExplainSlot(null);
      toast.error('Explain failed', { description: explainState.error ?? undefined });
    }
  }, [explainState, explainSlot, commit.sha]);

  useEffect(() => {
    if (reviewState.status === 'done') {
      if (reviewSlot?.phase === 'pending') {
        const text = reviewState.report.trim();
        setReviewSlot({ phase: 'done', text });
        const c = CACHE.get(commit.sha) ?? {};
        c.review = text;
        CACHE.set(commit.sha, c);
      }
    } else if (reviewState.status === 'error' && reviewSlot) {
      setReviewSlot(null);
      toast.error('code-reviewer failed', { description: reviewState.error ?? undefined });
    }
  }, [reviewState, reviewSlot, commit.sha]);

  // Fire the queued action once the session's turn slot is free.
  useEffect(() => {
    if (!pending || anyRunning) return;
    const kind = pending;
    setPending(null);
    if (kind === 'explain') fireExplain();
    else void fireReview();
  }, [pending, anyRunning, fireExplain, fireReview]);

  const startExplain = () => {
    if (filesLoading || explainSlot?.phase === 'pending' || pending === 'explain') return;
    const cached = CACHE.get(commit.sha)?.explain;
    if (cached != null && explainSlot === null) {
      setExplainSlot({ phase: 'done', text: cached });
      return;
    }
    if (anyRunning) {
      setPending('explain');
      setExplainSlot({ phase: 'pending', queued: true });
      return;
    }
    fireExplain();
  };

  const startReview = () => {
    if (filesLoading || reviewSlot?.phase === 'pending' || pending === 'review') return;
    const cached = CACHE.get(commit.sha)?.review;
    if (cached != null && reviewSlot === null) {
      setReviewSlot({ phase: 'done', text: cached });
      return;
    }
    if (anyRunning) {
      setPending('review');
      setReviewSlot({ phase: 'pending', queued: true });
      return;
    }
    void fireReview();
  };

  const dismissExplain = () => {
    setExplainSlot(null);
    setPending((p) => (p === 'explain' ? null : p));
    const c = CACHE.get(commit.sha);
    if (c) { delete c.explain; CACHE.set(commit.sha, c); }
  };

  const dismissReview = () => {
    setReviewSlot(null);
    setPending((p) => (p === 'review' ? null : p));
    const c = CACHE.get(commit.sha);
    if (c) { delete c.review; CACHE.set(commit.sha, c); }
  };

  const explainLive = explainState.status === 'running';
  const reviewLive = reviewState.status === 'running';
  const explainText = explainLive ? explainState.report : explainSlot?.phase === 'done' ? explainSlot.text : '';
  const reviewText = reviewLive ? reviewState.report : reviewSlot?.phase === 'done' ? reviewSlot.text : '';

  return (
    <>
      {/* Actions row */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-input flex-shrink-0">
        <AiButton
          label="Explain"
          title="Explain this commit with AI (runs a turn on the active session)"
          busy={explainLive || explainSlot?.phase === 'pending'}
          disabled={filesLoading || pending !== null}
          onClick={startExplain}
        />
        <AiButton
          label="Review"
          title="Review this commit with the code-reviewer agent"
          busy={reviewLive || reviewSlot?.phase === 'pending'}
          disabled={filesLoading || pending !== null}
          onClick={startReview}
        />
      </div>

      {/* Results */}
      {(explainSlot || reviewSlot) && (
        <div className="max-h-56 overflow-y-auto scroll border-b border-input flex-shrink-0">
          {explainSlot && (
            <ResultCard
              title="Explain"
              busy={explainSlot.phase === 'pending'}
              queued={explainSlot.phase === 'pending' && explainSlot.queued}
              text={explainText}
              onDismiss={dismissExplain}
            />
          )}
          {reviewSlot && (
            <ResultCard
              title="Review"
              busy={reviewSlot.phase === 'pending'}
              queued={reviewSlot.phase === 'pending' && reviewSlot.queued}
              text={reviewText}
              onDismiss={dismissReview}
            >
              {reviewSlot.phase === 'done' && reviewSlot.text && (
                <ul className="space-y-1.5">
                  {parseFindings(reviewSlot.text, files ?? []).map(({ text, file }, i) => (
                    <li key={i}>
                      <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">{text}</p>
                      {file && (
                        <button
                          type="button"
                          onClick={() => onOpenFile(file)}
                          title={`Open ${file.path} diff at this commit`}
                          className="mt-0.5 inline-flex items-center gap-1 max-w-full font-mono text-[11px] text-primary/80 hover:text-primary transition-colors"
                        >
                          <span aria-hidden>→</span>
                          <span className="truncate">{file.path}</span>
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </ResultCard>
          )}
        </div>
      )}
    </>
  );
}

function AiButton({ label, title, busy, disabled, onClick }: {
  label: string;
  title: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-label={title}
      className="flex items-center gap-1 h-6 px-1.5 rounded-md text-[11px] text-muted-foreground/80 hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50 disabled:pointer-events-none"
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
      {label}
    </button>
  );
}

function ResultCard({ title, busy, queued, text, onDismiss, children }: {
  title: string;
  busy: boolean;
  queued: boolean;
  text: string;
  onDismiss: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="m-2 rounded-md border border-border/60 bg-secondary/30 px-2.5 py-2">
      <div className="flex items-center gap-1.5 mb-1">
        {busy ? (
          <Loader2 className="size-3 animate-spin text-primary/70" />
        ) : (
          <Sparkles className="size-3 text-primary/70" />
        )}
        <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDismiss}
          className="flex items-center justify-center size-5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-secondary transition-colors"
          title={`Dismiss ${title.toLowerCase()}`}
          aria-label={`Dismiss ${title.toLowerCase()}`}
        >
          <X className="size-3" />
        </button>
      </div>
      {busy ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground/70">
          {queued ? 'Waiting for the current turn to finish…' : text || 'Thinking…'}
        </p>
      ) : children ?? (
        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">{text}</p>
      )}
    </div>
  );
}
