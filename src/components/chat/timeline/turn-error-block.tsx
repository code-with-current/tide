/** Turn-failure block: collapsible — header (Failed + Retry), body the full
 * error (JSON payloads pretty-printed as text). */

import { ChevronRight, RotateCw, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Extract the human message from an error body. Provider failures arrive
 * as `prefix…: {json}` where the json carries the real reason — often
 * nested (`error.message`, the Anthropic shape). JSON with a message shows
 * only that; JSON without one pretty-prints; non-JSON passes through. */
function prettyError(error: string): string {
  const start = error.indexOf("{");
  const end = error.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(error.slice(start, end + 1));
      const message =
        typeof parsed?.message === "string"
          ? parsed.message
          : typeof parsed?.error?.message === "string"
            ? parsed.error.message
            : undefined;
      if (message) return message;
      return typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
    } catch {
      /* not valid JSON — fall through */
    }
  }
  return error;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Interleave plain text with clickable links (port-pill link styling). */
function withLinks(text: string) {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    nodes.push(
      <a
        key={idx}
        href={m[0]}
        target="_blank"
        rel="noreferrer"
        className="text-info underline decoration-info/40 hover:decoration-info break-all"
      >
        {m[0]}
      </a>,
    );
    last = idx + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function TurnErrorBlock({ error, onRetry }: { error: string; onRetry?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 max-w-[75%] overflow-hidden rounded-lg border border-destructive/20 text-[0.8rem]">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")}
          />
          <TriangleAlert className="size-3.5 shrink-0 text-destructive/70" />
          <span className="text-muted-foreground">Failed</span>
        </button>
        {onRetry && (
          <Button
            variant="ghost"
            size="xs"
            className="h-6 shrink-0 px-2 text-[0.75rem]"
            onClick={onRetry}
          >
            <RotateCw className="size-3" />
            Retry
          </Button>
        )}
      </div>
      {open && (
        <pre className="max-h-64 overflow-auto border-t border-destructive/15 bg-destructive/[0.04] px-3 py-2 font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground/80">
          {withLinks(prettyError(error))}
        </pre>
      )}
    </div>
  );
}
