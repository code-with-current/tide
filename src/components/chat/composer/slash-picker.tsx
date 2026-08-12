import { Bot, Wrench, FileText, Plug } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Mention, MentionKind } from './mention-button';

/** Icon per mention kind — matches the toolbar picker's tab icons. */
const kindIcon: Record<MentionKind, typeof Bot> = {
  agent: Bot,
  skill: Wrench,
  context: FileText,
  mcp: Plug,
};

const kindColor: Record<MentionKind, string> = {
  agent: 'text-primary bg-primary/10 p-2 rounded-md',
  skill: 'text-info bg-info/10 p-2 rounded-md',
  context: 'text-muted-foreground bg-muted-foreground/10 p-2 rounded-md',
  mcp: 'text-reasoning bg-reasoning/10 p-2 rounded-md',
};

export interface SlashPickerProps {
  /** Already-filtered list to render (parent owns the filtering). */
  items: Mention[];
  /** Index of the highlighted (keyboard-selected) item. */
  highlightedIndex: number;
  /** Pick an item (click or Enter key). */
  onPick: (m: Mention) => void;
  /** Highlight changes from hover or arrow keys. */
  onHighlight: (index: number) => void;
}

/** Mention suggestions panel — rendered inline above the composer (NOT a floating portal), so it pushes the composer down instead of floating over content. Flat list (no tabs) keeps the UX fast and uncluttered. Keyboard navigation (Arrow/Enter/Escape) is handled by the parent (ChatComposer). */
export function SlashPicker({
  items,
  highlightedIndex,
  onPick,
  onHighlight,
}: SlashPickerProps) {
  return (
    <div
      role="listbox"
      aria-label="Slash suggestions"
      className="rounded-md border border-border bg-popover shadow-lg overflow-hidden"
    >
      <div className="max-h-[260px] overflow-y-auto overflow-x-hidden scroll py-1">
        {items.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground/60">
            No matches. Press Esc to keep typing.
          </div>
        )}
        {items.map((m, i) => {
          const Icon = kindIcon[m.kind];
          return (
            <span
              key={m.id}
              role="option"
              aria-selected={i === highlightedIndex}
              onMouseEnter={() => onHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); onPick(m); }}
              className={cn(
                'w-full text-left px-3 py-2 flex items-start gap-2 transition-colors',
                i === highlightedIndex ? 'bg-secondary' : 'hover:bg-secondary',
              )}
            >
              <span className={cn('mt-0.5', kindColor[m.kind])}>
                <Icon className="size-3.5" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium font-mono">/{m.name}</span>
                  {(m.source === 'project' || m.source === 'user') && (
                    <span
                      className={cn(
                        'text-[9px] uppercase tracking-wider bg-secondary border border-input px-1 py-px rounded',
                        m.source === 'project' ? 'text-secondary-foreground/60/70' : 'text-primary/70',
                      )}
                    >
                      {m.source}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground/60 truncate">{m.description}</div>
              </div>
            </span>
          );
        })}
      </div>
      <div className="px-3 py-1.5 border-t border-input text-[10px] text-muted-foreground/80 flex items-center gap-2">
        <kbd className="font-mono text-[10px] px-1 py-0 bg-primary text-primary-foreground border border-border rounded">↑↓</kbd>
        Navigate
        <kbd className="font-mono text-[10px] px-1 py-0 bg-primary text-primary-foreground border border-border rounded ml-1">↵</kbd>
        Select
        <kbd className="font-mono text-[10px] px-1 py-0 bg-primary text-primary-foreground border border-border rounded ml-1">esc</kbd>
        Dismiss
      </div>
    </div>
  );
}

/** Filter a mention catalog by a slash query. Matches if the query appears anywhere in the name OR description (case-insensitive); name matches rank higher (prefix beats substring) so `/ref` puts `refactor` before `web-refresh`. Exported so the parent (ChatComposer) owns filtering — the picker stays purely presentational. */
export function filterMentions(catalog: Mention[], query: string, limit = 8): Mention[] {
  const q = query.trim().toLowerCase();
  if (!q) return catalog.slice(0, limit);
  const scored: Array<{ m: Mention; score: number }> = [];
  for (const m of catalog) {
    const name = m.name.toLowerCase();
    const desc = m.description.toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 100 - name.length;
    else if (name.includes(q)) score = 50 - name.indexOf(q);
    else if (desc.includes(q)) score = 10;
    if (score >= 0) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.m);
}

/** Detect a `/query` at the editor's cursor. Returns { query, range, rect } when the cursor sits at the end of a slash token preceded by start-of-text or whitespace; null otherwise. Triggers: `/ref|`, `hello /ref|`, `/|`. Does NOT trigger mid-word (e.g. `https://example|`, `and/or|`) to avoid matching URLs. */
export function detectSlashQueryAt(
  editor: HTMLElement,
): { query: string; range: Range; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const maybeNode: Node | null = sel.anchorNode;
  if (!maybeNode || !editor.contains(maybeNode)) return null;
  // After the null check, bind to a non-null const so TS narrows cleanly
  // through the rest of the function (Range.setStart requires `Node`).
  const node: Node = maybeNode;
  if (node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent ?? '';
  const offset = sel.anchorOffset;
  const before = text.slice(0, offset);

  // Match a /query at the end of the preceding text. The slash must be
  // at the start of the text node OR immediately after whitespace. The
  // query itself is word characters only — anything else (space, slash,
  // punctuation) closes the picker.
  const match = before.match(/(?:^|\s)\/(\w*)$/);
  if (!match) return null;

  const query = match[1];
  // The match's full length includes the leading whitespace/start + the
  // slash. We want the Range to cover ONLY the `/query` part, so the
  // leading-offset is: cursor - query.length - 1 (for the slash).
  const slashStart = offset - query.length - 1;
  if (slashStart < 0) return null;

  const range = document.createRange();
  range.setStart(node, slashStart);
  range.setEnd(node, offset);

  return { query, range, rect: range.getBoundingClientRect() };
}

/** Detect an `@query` at the editor's cursor — same logic as detectSlashQueryAt but for `@` (project file/folder references). Triggers: `@src/|`, `look at @index|`. Unlike `/`, the query allows path characters (/, ., _) so the user can type `@src/components/Foo` to narrow down. */
export function detectAtQueryAt(
  editor: HTMLElement,
): { query: string; range: Range } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const maybeNode: Node | null = sel.anchorNode;
  if (!maybeNode || !editor.contains(maybeNode)) return null;
  const node: Node = maybeNode;
  if (node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent ?? '';
  const offset = sel.anchorOffset;
  const before = text.slice(0, offset);

  // @query: @ followed by word chars, path separators, dots, dashes.
  const match = before.match(/(?:^|\s)@([\w./-]*)$/);
  if (!match) return null;

  const query = match[1];
  const atStart = offset - query.length - 1;
  if (atStart < 0) return null;

  const range = document.createRange();
  range.setStart(node, atStart);
  range.setEnd(node, offset);

  return { query, range };
}
