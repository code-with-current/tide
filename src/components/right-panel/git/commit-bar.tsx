/** CommitBar v2 — Summary + Description + agent-generated message.
 *  ✨ inside the Summary field dispatches the commit-writer sub-agent with the
 *  staged diff; its report streams into Summary (tinted) until the user types
 *  (dismiss) or it completes. ⌥ Amend prefills from HEAD and repoints the
 *  primary action at gitCommit --amend. With nothing staged the primary button
 *  stage-alls first, then commits. */

import { useEffect, useRef, useState } from 'react';
import { GitCommitHorizontal, Loader2, Sparkles, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import * as api from '@/lib/api/client';
import type { GitFileChange } from '@/lib/api/client';
import { toast } from '@/lib/toast';
import { useGitAgentAction } from '@/hooks/use-git-agent-action';

/** Pull the proposed message out of the agent's report — it promises the
 *  message in a fenced code block. Partial-tolerant: an unclosed fence while
 *  streaming still yields the text so far. */
function extractMessage(report: string): string {
  const m = report.match(/```(?:\w+)?[ \t]*\n([\s\S]*?)(?:```|$)/);
  return (m ? m[1] : report).trim();
}

const MAX_DIFF_CHARS = 50_000;

export function CommitBar({
  workspaceId,
  gitSessionId,
  sessionId,
  staged,
  hasConflicts,
  hasChanges,
  onCommit,
  onAmend,
  onStageAll,
  disabled,
}: {
  workspaceId: string;
  /** Worktree-aware session id for git fetches (staged diff, HEAD message). */
  gitSessionId?: string | null;
  /** Active session — the ✨ dispatch turn runs here. */
  sessionId?: string | null;
  staged: GitFileChange[];
  hasConflicts: boolean;
  hasChanges: boolean;
  onCommit: (message: string) => Promise<{ ok: boolean; sha?: string; error?: string }>;
  onAmend: (message: string) => Promise<{ ok: boolean; sha?: string; error?: string }>;
  onStageAll: () => Promise<void>;
  disabled?: boolean;
}) {
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flashSha, setFlashSha] = useState<string | null>(null);
  // Suggestion is live (streaming or just finished) until the user types.
  const [suggesting, setSuggesting] = useState(false);
  const dismissedRef = useRef(false);
  const { run, state: agentState } = useGitAgentAction();
  const generating = agentState.status === 'running';

  // Amend ON → prefill from HEAD's full message (subject + body).
  useEffect(() => {
    if (!amend) return;
    let cancelled = false;
    void api.gitCommitMessage(workspaceId, 'HEAD', gitSessionId ?? undefined).then((msg) => {
      if (cancelled || !msg) return;
      const [subject, ...rest] = msg.split('\n');
      setSummary(subject.trim());
      setDescription(rest.join('\n').replace(/^\s+/, '').trimEnd());
    });
    return () => { cancelled = true; };
  }, [amend, workspaceId, gitSessionId]);

  // Stream / apply the agent's suggestion. Typing sets dismissedRef and stops
  // every later update (including the final one) from clobbering the user.
  useEffect(() => {
    if (!suggesting || dismissedRef.current) return;
    if (agentState.status === 'running' || agentState.status === 'done') {
      const message = extractMessage(agentState.report);
      if (!message) return;
      const [subject, ...rest] = message.split('\n');
      setSummary(subject.trim());
      setDescription(rest.join('\n').replace(/^\s+/, '').trimEnd());
      if (agentState.status === 'done') setSuggesting(false);
    } else if (agentState.status === 'error') {
      setSuggesting(false);
      toast.error('commit-writer failed', { description: agentState.error ?? undefined });
    }
  }, [agentState, suggesting]);

  const stagedAdd = staged.reduce((n, c) => n + (c.additions ?? 0), 0);
  const stagedDel = staged.reduce((n, c) => n + (c.deletions ?? 0), 0);

  const canSubmit =
    summary.trim().length > 0 && !hasConflicts && !busy && !disabled && (amend || hasChanges);

  const buildMessage = () =>
    description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();

  const handleGenerate = async () => {
    if (generating) return;
    dismissedRef.current = false;
    let diff = '';
    try {
      diff = await api.gitStagedDiff(workspaceId, gitSessionId ?? undefined);
    } catch { /* treated as empty below */ }
    if (!diff.trim()) {
      toast.error('Nothing staged', { description: 'Stage changes to generate a commit message.' });
      return;
    }
    if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… (truncated)`;
    setSuggesting(true);
    const res = run({
      sessionId,
      agent: 'commit-writer',
      task: `Draft a conventional commit message for the staged diff below. Do NOT commit — report only the proposed message. Reply with the message in a fenced code block: subject line, blank line, then an optional body.\n\n<staged-diff>\n${diff}\n</staged-diff>`,
    });
    if (res.status === 'error') {
      setSuggesting(false);
      toast.error('Could not dispatch commit-writer', { description: 'Needs an active, idle session.' });
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      let res;
      if (amend) {
        res = await onAmend(buildMessage());
      } else {
        if (staged.length === 0) await onStageAll();
        res = await onCommit(buildMessage());
      }
      if (res.ok && res.sha) {
        setFlashSha(res.sha);
        setTimeout(() => setFlashSha(null), 1500);
        setSummary('');
        setDescription('');
        setAmend(false);
      } else if (!res.ok) {
        toast.error('Commit failed', { description: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const summaryTint = suggesting && !dismissedRef.current;

  return (
    <div className="space-y-1.5 min-w-0 my-2">
      {/* Summary + trailing ✨ */}
      <div className="relative">
        <input
          value={summary}
          onChange={(e) => {
            dismissedRef.current = true;
            setSuggesting(false);
            setSummary(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={amend ? 'Amended subject…' : 'Summary (commit message)'}
          className={cn(
            'w-full bg-input border border-input rounded-md pr-8 pl-2 @sm:pl-2.5 py-1.5 text-[0.85rem] text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-accent/40 focus:ring-1 focus:ring-ring/20 transition-colors duration-150',
            summaryTint && 'bg-primary/5 border-primary/30',
          )}
          aria-label="Commit summary"
        />
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating}
          title={generating ? 'commit-writer is drafting…' : 'Generate commit message (commit-writer agent)'}
          aria-label="Generate commit message with the commit-writer agent"
          className={cn(
            'absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 transition-colors',
            generating
              ? 'text-primary cursor-default'
              : 'text-muted-foreground/60 hover:text-primary hover:bg-primary/10',
          )}
        >
          {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        </button>
      </div>

      {/* Description */}
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={amend ? 'Amended description… (Shift+Enter for newline)' : 'Description… (Shift+Enter for newline)'}
        rows={2}
        className="w-full bg-input border border-input rounded-md px-2 @sm:px-2.5 py-1.5 text-[0.85rem] text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-accent/40 focus:ring-1 focus:ring-ring/20 resize-none transition-colors duration-150 scroll"
        aria-label="Commit description"
      />

      {/* Footer — amend toggle, staged counter, primary action */}
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          onClick={() => setAmend((v) => !v)}
          aria-pressed={amend}
          title="Amend the last commit instead of creating a new one"
          className={cn(
            'flex-shrink-0 h-6 px-1.5 rounded-md text-[11px] transition-colors',
            amend
              ? 'bg-destructive/15 text-destructive font-medium'
              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
          )}
        >
          ⌥ Amend
        </button>
        <span className="flex-shrink-0 text-[11px] font-mono tabular-nums text-muted-foreground whitespace-nowrap">
          {staged.length} staged · <span className="text-success">+{stagedAdd}</span> <span className="text-destructive">−{stagedDel}</span>
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant={amend ? 'destructive' : 'default'}
          className={cn('flex-shrink-0 transition-opacity h-6', !canSubmit && 'opacity-50')}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {flashSha ? (
            <>
              <Check className="size-3.5" />
              <span className="font-mono">{flashSha}</span>
            </>
          ) : busy || disabled ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <GitCommitHorizontal className="size-3.5" />
          )}
          {!flashSha && (amend ? 'Amend last commit' : staged.length > 0 ? 'Commit' : 'Stage all & commit')}
        </Button>
      </div>

      {hasConflicts && (
        <p className="text-[11px] text-destructive/90">
          Resolve merge conflicts before committing.
        </p>
      )}
    </div>
  );
}
