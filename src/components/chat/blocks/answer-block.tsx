import { memo, useState } from 'react';
import { Copy, Check, GitFork } from 'lucide-react';
import { MemoizedMarkdown } from '../memoized-markdown';
import { initiateFork } from '@/lib/queries';
import { cn } from '@/lib/utils';

export const AnswerBlock = memo(function AnswerBlock({
  text,
  streaming,
  stopped,
  hasProcessContent,
  sessionId,
  sessionTitle: _sessionTitle,
  sessionModelId: _sessionModelId,
  sessionProviderId: _sessionProviderId,
}: {
  text: string;
  streaming: boolean;
  stopped?: boolean;
  hasProcessContent: boolean;
  sessionId?: string | null;
  sessionTitle?: string;
  sessionModelId?: string;
  sessionProviderId?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (!text && !streaming) return null;
  if (!text) return null;

  const showActions = !streaming;

  return (
    <>
      {hasProcessContent && <div className="h-2" />}

      <figure className="group/answer relative rounded-lg pt-2">
        <div className="pb-2.5">
          <div className="prose-chat">
            <MemoizedMarkdown content={text} streaming={streaming} />
          </div>

          {streaming && (
            <span className="cursor-blink inline-block ml-0.5 align-baseline" />
          )}

          {stopped && (
            <div className="mt-1.5 inline-flex items-center gap-1 text-[0.7143rem] uppercase tracking-wider text-warning font-mono">
              <span className="size-1.5 rounded-full bg-warning" />
              Stopped
            </div>
          )}

        </div>

        {showActions && (
          <div className="flex items-center gap-0.5 px-2 pb-1.5">
            <span className="mr-auto" />

            <div className="flex items-center gap-0.5 opacity-60 transition-opacity group-hover/answer:opacity-100">
              <button
                type="button"
                onClick={handleCopy}
                aria-label={copied ? 'Copied' : 'Copy'}
                title={copied ? 'Copied' : 'Copy'}
                className={cn(
                  'inline-flex items-center gap-1 h-7 px-2 rounded-md text-[0.7857rem] font-medium',
                  'transition-colors cursor-pointer',
                  copied
                    ? 'text-success bg-success/10'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
                )}
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              {sessionId && (
                <button
                  type="button"
                  onClick={() => initiateFork(sessionId, text, 'result')}
                  aria-label="Fork the Result"
                  title="Fork the Result"
                  className={cn(
                    'inline-flex items-center gap-1 h-7 px-2 rounded-md text-[0.7857rem] font-medium',
                    'text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer',
                  )}
                >
                  <GitFork className="size-3" />
                  Fork
                </button>
              )}
            </div>

          </div>
        )}
      </figure>
    </>
  );
});
