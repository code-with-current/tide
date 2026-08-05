import { FileText } from 'lucide-react';
import type { OpenFile } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';

/** Right-panel "file viewer": mocked current-state file with line numbers + changed-line highlights. (Production would read the actual worktree file through Shiki; content is path-keyed for now so each opened file has believable content.) */
export function FileViewerTab({ file }: { file: OpenFile }) {
  const content = FILE_CONTENT[file.path] ?? FALLBACK(file.path);
  const changedSet = new Set(file.changedLines ?? []);
  const lines = content.split('\n');

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-input flex-shrink-0 bg-secondary/40">
        <FileText className="size-3.5 text-muted-foreground/60" />
        <code className="font-mono text-[11px] text-muted-foreground truncate">{file.path}</code>
        <span className="text-[10px] text-muted-foreground/60">·</span>
        <span className="text-[10px] text-muted-foreground/60">{lines.length} lines</span>
        <span className="text-[10px] text-muted-foreground/60">·</span>
        <span className="text-[10px] text-muted-foreground/60 uppercase">{file.language}</span>
        <div className="flex-1" />
        {changedSet.size > 0 && (
          <span className="text-[10px] text-success flex items-center gap-1">
            <span className="size-1.5 rounded-sm bg-success/50" /> {changedSet.size} changed
          </span>
        )}
      </div>

      {/* Code body — line numbers + content, mono font, highlighted changed lines */}
      <div className="flex-1 overflow-auto scroll py-2 min-h-0 font-mono text-[12px] leading-[1.6]">
        {lines.map((line, i) => {
          const lineNo = i + 1;
          const changed = changedSet.has(lineNo);
          return (
            <div
              key={i}
              className={cn(
                'flex items-start px-3 hover:bg-secondary/50',
                changed && 'bg-success/[0.08]',
              )}
            >
              <span
                className={cn(
                  'select-none w-10 pr-3 text-right tabular-nums flex-shrink-0',
                  changed ? 'text-success' : 'text-muted-foreground/60/60',
                )}
              >
                {lineNo}
              </span>
              <span className={cn('whitespace-pre flex-1', changed ? 'text-[#b6f5cb]' : 'text-[#d4d4d8]')}>
                {line || ' '}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================
// Mocked file contents — keyed by workspace-relative path.
// In production, replaced by `read_file` from the orchestrator + Shiki.
// =============================================================

const FILE_CONTENT: Record<string, string> = {
  'src/parser.ts': `export interface ParseResult {
  ok: boolean;
  value: string;
  error?: string;
}

/** Parse user input from the form. Empty strings are valid (returns ok + empty value) instead of throwing — see parser.test.ts. */
export function parseInput(input: string): ParseResult {
  if (typeof input !== "string") {
    return { ok: false, value: "", error: "Input must be a string" };
  }

  const trimmed = input?.trim() ?? "";
  if (trimmed.length === 0) {
    return { ok: true, value: "" } satisfies ParseResult;
  }

  // Tokenize on whitespace, quotes respected.
  const tokens = tokenize(trimmed);
  return { ok: true, value: tokens.join(" ") };
}

function tokenize(input: string): string[] {
  // ... existing tokenizer
  return input.split(/\\s+/);
}
`,
  'src/parser.test.ts': `import { describe, it, expect } from "vitest";
import { parseInput } from "./parser";

describe("parseInput", () => {
  it("handles non-string input", () => {
    expect(parseInput(undefined as unknown as string).ok).toBe(false);
  });

  it("handles empty string", () => {
    const result = parseInput("");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("");
  });

  it("handles whitespace-only input", () => {
    const result = parseInput("   \\t  ");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("");
  });

  it("parses valid input", () => {
    expect(parseInput("hello world").value).toBe("hello world");
  });
});
`,
};

function FALLBACK(path: string): string {
  return `// ${path}
//
// (No preview available for this file in the mock.)
// In production, this view would show the file's current contents
// read directly from the worktree at .agent/worktrees/<session>/${path}`;
}
