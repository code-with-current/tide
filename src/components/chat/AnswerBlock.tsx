import { memo, useState } from 'react';
import { Copy, Check, GitFork } from 'lucide-react';
import { MemoizedMarkdown } from './MemoizedMarkdown';
import { ForkSessionDialog } from '@/components/modals/ForkSessionDialog';

export const AnswerBlock = memo(function AnswerBlock({
  text,
  streaming,
  stopped,
  hasProcessContent,
  sessionId,
  sessionTitle,
  sessionModelId,
  sessionProviderId,
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
  const [forkOpen, setForkOpen] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // The hairline separator only renders when there's process content above.
  const Separator = hasProcessContent
    ? <div className="border-t border-input my-1" />
    : null;

  // Empty answer (tool-only turn, pre-text, failed, or stopped). Return null — no placeholder.
  if (!text && !streaming) {
    return null;
  }
  if (!text) {
    return null;
  }

  // Hover action bar: copy + fork. Only shows when not streaming (the turn is complete).
  const showActions = !streaming;

  return (
    <>
      {Separator}

      <div className="group/answer relative">
        <div className="prose-chat">
          <MemoizedMarkdown content={text} streaming={streaming} />
        </div>

        {showActions && (
          <div className="absolute -bottom-12 left-0 flex items-center gap-2 opacity-0 group-hover/answer:opacity-100 transition-opacity rounded-lg px-2 py-1.5 bg-muted/50">
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copied ? 'Copied' : 'Copy answer'}
              title={copied ? 'Copied' : 'Copy'}
              className="inline-flex items-center justify-center size-6 rounded text-muted-foreground/50 hover:text-primary hover:bg-muted transition-colors"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
            {sessionId && (
              <button
                type="button"
                onClick={() => setForkOpen(true)}
                aria-label="Fork session from here"
                title="Fork session from here"
                className="inline-flex items-center justify-center size-6 rounded text-muted-foreground/50 hover:text-primary hover:bg-muted transition-colors"
              >
                <GitFork className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {stopped && (
        <div className="mt-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-warning font-mono">
          <span className="size-1.5 bg-warning" />
           Stopped
        </div>
      )}

      {streaming && (
        <span className="cursor-blink inline-block ml-0.5" />
      )}

      {sessionId && forkOpen && (
        <ForkSessionDialog
          open={forkOpen}
          onOpenChange={setForkOpen}
          sourceSessionId={sessionId}
          sourceTitle={sessionTitle ?? 'this session'}
          sourceModelId={sessionModelId}
          sourceProviderId={sessionProviderId}
        />
      )}
    </>
  );
});
