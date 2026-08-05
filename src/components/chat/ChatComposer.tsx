import { useState, useRef, useReducer, useEffect, useCallback, useMemo } from 'react';
import { ClipboardPaste, FileCode2, FileText, Image as ImageIcon } from 'lucide-react';
import { Chip } from '@/components/primitives';
import { cn } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';
import { useModelOption, supportsThinking } from '@/lib/queries';
import { ModelSelector } from './composer/ModelSelector';
import { PermissionModeSelector } from './composer/PermissionModeSelector';
import { ThinkingLevelSelector } from './composer/ThinkingLevelSelector';
import { AttachButton, kindForPath, shortName } from './composer/AttachButton';
import { MentionButton, useMentionCatalog, type Mention } from './composer/MentionButton';
import { SlashPicker, filterMentions, detectSlashQueryAt, detectAtQueryAt } from './composer/SlashPicker';
import { ProjectFilePicker } from './composer/ProjectFilePicker';
import { SendStopButton } from './composer/SendStopButton';
import { QueuedMessages } from './composer/QueuedMessages';
import type { MessageAttachment } from '@/types';
import * as api from '@/lib/api/client';

export interface ChatComposerPayload {
  /** Display text — user's typed words with `/{name}` references where chips
   *  were placed. Stored as message.content for the chat UI. Does NOT include
   *  skill file content (that bloats the bubble). */
  text: string;
  /** Enriched text — display text + full skill/agent content blocks injected
   *  inline. Sent to the orchestrator as the user message. If absent, same
   *  as `text` (no mentions to inject). */
  promptText?: string;
  /** Mention metadata for chip rendering in the chat bubble. */
  mentions?: Array<{
    name: string;
    kind: 'skill' | 'agent' | 'context' | 'mcp';
    source?: 'project' | 'user' | 'builtin';
  }>;
  attachments: MessageAttachment[];
}

export interface ChatComposerProps {
  /** Session this composer is bound to. Required for queue behavior. */
  sessionId?: string;
  placeholder?: string;
  /** Initially-filled textarea (used by the running-session composer). */
  defaultValue?: string;
  /** Compact = used in the running session; full = empty-state composer. */
  compact?: boolean;
  /** Whether a turn is currently running. Drives Send/Stop + queue routing. */
  inProgress?: boolean;
  onSubmit?: (payload: ChatComposerPayload) => void;
  onStop?: () => void;
  /** Live text callback — used by EmptyChatState to auto-suggest a
   *  worktree branch name as the user types. Optional; not needed for
   *  the running-session composer. */
  onChange?: (text: string) => void;
}

/** Build the guidance block a mention contributes to the outgoing prompt: fenced content for content-bearing mentions, a dispatch hint for built-in agents, or a name-only reference otherwise. */
function mentionBlock(m: Mention): string {
  if (m.content) {
    const kindLabel = m.kind === 'context' ? 'project context' : m.kind;
    const src = m.filePath ?? m.name;
    return `<${kindLabel} src="${src}">\n${m.content}\n</${kindLabel}>`;
  }
  if (m.kind === 'agent' && m.description) {
    return `[User wants to use the "${m.name}" agent — ${m.description} Dispatch via the dispatch_agent tool if the task matches, or apply its approach directly.]`;
  }
  return `[User referenced: ${m.name}]`;
}

/** Chip class lookup — kind drives the tint, source drives the border style. */
function chipClasses(_m: Mention): string {
  const base = 'inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 border text-[11px] font-mono align-middle select-none rounded-md bg-foreground/10 text-foreground/70';

  return `${base}`;
}

export function ChatComposer({
  sessionId,
  placeholder = 'Ask Tide to build, fix, or explain… (Shift+Enter for newline)',
  defaultValue = '',
  compact = false,
  inProgress = false,
  onSubmit,
  onStop,
  onChange,
}: ChatComposerProps) {
  // Editor is UNCONTROLLED — the contentEditable div is the source of truth
  // and React doesn't manage its children. We bump `version` on input/chip
  // changes to trigger re-renders for the chars counter + send-button state.
  const editorRef = useRef<HTMLDivElement>(null);

  // Thinking support — hide the selector entirely when the model doesn't
  // support reasoning, instead of dimming it.
  const selectedModelId = useUi((s) => s.selectedModelId);
  const selectedProviderId = useUi((s) => s.selectedProviderId);
  const modelOption = useModelOption(selectedProviderId, selectedModelId);
  const thinkingSupported = modelOption
    ? (modelOption.reasoning ?? supportsThinking(modelOption.modelId))
    : false;

  const mentionsRef = useRef<Map<string, Mention>>(new Map());
  const chipIdCounter = useRef(0);
  // Last known editor selection (tracked via `selectionchange` so clicking the @ button — which moves focus out of the editor — still knows where to drop the chip).
  const savedRangeRef = useRef<Range | null>(null);
  const [, bumpVersion] = useReducer((x: number) => x + 1, 0);

  // Attachments + pending paste reads live in the shared UI store (not local
  // useState) so they persist across the two ChatComposer instances (chat
  // view + empty/new-session view) — otherwise switching sessions/workspaces
  // remounts the composer and drops pasted files.
  const attachments = useUi((s) => s.composerAttachments);
  const pendingReads = useUi((s) => s.composerPendingReads);
  const addAttachment = useUi((s) => s.addComposerAttachment);
  const removeAttachment = useUi((s) => s.removeComposerAttachment);
  const clearAttachments = useUi((s) => s.clearComposerAttachments);
  const bumpPendingReads = useUi((s) => s.bumpComposerPendingReads);
  const setMainView = useUi((s) => s.setMainView);
  const enqueue = useUi((s) => s.enqueueMessage);
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const catalog = useMentionCatalog(activeWorkspaceId);

  // Slash-picker state. `slashRangeRef` = live Range over `/query` (ref, not state, to avoid render storms as it mutates); `slashQuery` = string after the slash (null = closed, the reactive signal).
  const slashRangeRef = useRef<Range | null>(null);
  const slashRectRef = useRef<DOMRect | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashHighlight, setSlashHighlight] = useState(0);

  // ── @ trigger state (project file/folder picker) ──
  const atRangeRef = useRef<Range | null>(null);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [atHighlight, setAtHighlight] = useState(0);
  const [projectFiles, setProjectFiles] = useState<{ path: string; kind: 'file' | 'dir' }[]>([]);

  // Load project file list once when workspace changes.
  useEffect(() => {
    if (!activeWorkspaceId) { setProjectFiles([]); return; }
    api.getFileTree(activeWorkspaceId).then((nodes) => {
      const flat: { path: string; kind: 'file' | 'dir' }[] = [];
      const walk = (ns: any[], depth = 0) => {
        if (depth > 4) return;
        for (const n of ns) {
          if (flat.length >= 500) return;
          flat.push({ path: n.path, kind: n.kind });
          if (n.kind === 'dir' && n.children) walk(n.children, depth + 1);
        }
      };
      walk(nodes);
      flat.sort((a, b) => a.path.localeCompare(b.path));
      setProjectFiles(flat);
    }).catch(() => setProjectFiles([]));
  }, [activeWorkspaceId]);

  /** Re-scan the editor for a `/query` pattern at the cursor. Called on
   *  every input + selection change so the picker tracks typing in real
   *  time. Closes the picker when no slash pattern is present. */
  const detectSlash = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      setSlashQuery(null);
      return;
    }
    const result = detectSlashQueryAt(editor);
    if (!result) {
      slashRangeRef.current = null;
      slashRectRef.current = null;
      setSlashQuery(null);
      return;
    }
    slashRangeRef.current = result.range;
    slashRectRef.current = result.rect;
    // Only update state if the query actually changed — avoids a render
    // storm on every caret move within the same query.
    setSlashQuery((prev) => (prev === result.query ? prev : result.query));
    setSlashHighlight(0);
  }, []);

  /** Re-scan for `@query` — project file/folder references. Same pattern
   *  as detectSlash but for @. */
  const detectAt = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) { setAtQuery(null); return; }
    const result = detectAtQueryAt(editor);
    if (!result) {
      atRangeRef.current = null;
      setAtQuery(null);
      return;
    }
    atRangeRef.current = result.range;
    setAtQuery((prev) => (prev === result.query ? prev : result.query));
    setAtHighlight(0);
  }, []);

  // Combined detection — runs on every input/selection change.
  const detectTriggers = useCallback(() => {
    detectSlash();
    detectAt();
  }, [detectSlash, detectAt]);

  // Filtered project files for the @ query.
  const atItems = useMemo(() => {
    if (atQuery === null) return [];
    const q = atQuery.trim().toLowerCase();
    if (!q) return projectFiles.slice(0, 20);
    return projectFiles
      .filter((f) => f.path.toLowerCase().includes(q))
      .slice(0, 20);
  }, [projectFiles, atQuery]);

  const slashItems = useMemo(
    () => (slashQuery === null ? [] : filterMentions(catalog, slashQuery)),
    [catalog, slashQuery],
  );

  // Track the editor's selection via `selectionchange`: save only in-editor positions so the picker stealing focus keeps the last position, and re-run slash detection so the picker tracks caret/mouse/arrow moves in real time.
  useEffect(() => {
    const handler = () => {
      const editor = editorRef.current;
      if (!editor) return;
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
        savedRangeRef.current = sel.getRangeAt(0).cloneRange();
      }
      detectTriggers();
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [detectTriggers]);

  // Seed initial text once on mount. Subsequent `defaultValue` changes are
  // ignored — the editor is uncontrolled, matching the prior textarea's
  // behavior (the parent remounts the composer to "reset" it).
  useEffect(() => {
    if (defaultValue && editorRef.current && editorRef.current.innerText.trim() === '') {
      editorRef.current.textContent = defaultValue;
      bumpVersion();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeChip = useCallback((chipId: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const chip = editor.querySelector(`[data-mention-id="${CSS.escape(chipId)}"]`);
    if (!chip) return;
    // Remove the chip AND any adjacent whitespace the insertion added,
    // so deleting a chip doesn't leave a dangling nbsp gap.
    const next = chip.nextSibling;
    if (next && next.nodeType === Node.TEXT_NODE && next.textContent === '\u00A0') {
      next.remove();
    }
    chip.remove();
    mentionsRef.current.delete(chipId);
    bumpVersion();
  }, []);

  /** Build a chip DOM element for a mention. Vanilla DOM because the
   *  contentEditable's children aren't React-managed — React would fight
   *  us on every re-render. The chip carries `contentEditable=false` so
   *  the cursor treats it as an atomic inline object. */
  const buildChipElement = useCallback((m: Mention, chipId: string): HTMLElement => {
    const chip = document.createElement('span');
    chip.contentEditable = 'false';
    chip.dataset.mentionId = chipId;
    chip.className = chipClasses(m);
    chip.title = m.filePath
      ? `${m.filePath}${m.content ? `\n${m.content.slice(0, 200)}${m.content.length > 200 ? '…' : ''}` : ''}`
      : m.description;

    const label = document.createElement('span');
    label.textContent = `/${m.name}`;
    chip.appendChild(label);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.className = 'text-muted-foreground/60 hover:text-destructive px-0.5 leading-none rounded-xl';
    btn.setAttribute('aria-label', `Remove ${m.name}`);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeChip(chipId);
    });
    chip.appendChild(btn);

    return chip;
  }, [removeChip]);

  /** Insert a mention as an inline chip at the last known cursor position (uses `savedRangeRef`), falling back to appending at the end if no position was saved. */
  const insertMention = useCallback((m: Mention) => {
    const editor = editorRef.current;
    if (!editor) return;

    const chipId = `chip-${++chipIdCounter.current}`;
    mentionsRef.current.set(chipId, m);
    const chip = buildChipElement(m, chipId);

    // Resolve the insertion point. Prefer the saved range; validate that
    // its nodes are still in the editor (a stale range after a clear/reset
    // would otherwise throw when we try to insert into detached nodes).
    let range: Range | null = null;
    if (savedRangeRef.current) {
      const saved = savedRangeRef.current;
      const startInEditor =
        saved.startContainer && editor.contains(saved.startContainer);
      const endInEditor =
        saved.endContainer && editor.contains(saved.endContainer);
      if (startInEditor && endInEditor) {
        range = saved;
      }
    }
    if (!range) {
      // No saved position — append at end as a sensible default.
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    // Apply the range to the live selection so insertNode lands correctly.
    // editor.focus() first so the selection takes effect in the editor.
    editor.focus();
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    range.deleteContents();
    range.insertNode(chip);

    // Trailing nbsp gives the cursor somewhere to land after the chip;
    // without it, the cursor sits inside the chip span and the next
    // keystroke overwrites it.
    const trailing = document.createTextNode('\u00A0');
    chip.after(trailing);

    // Move selection past the trailing space + save it as the new "last
    // known position" so consecutive picks land in order.
    const newRange = document.createRange();
    newRange.setStartAfter(trailing);
    newRange.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(newRange);
    savedRangeRef.current = newRange.cloneRange();

    bumpVersion();
  }, [buildChipElement]);

  const handleMention = useCallback((m: Mention) => {
    insertMention(m);
  }, [insertMention]);

  /** Intercept paste: force text-only (no rich HTML) and turn long pastes (>10 lines) into virtual attachments. */
  const PASTE_LINE_THRESHOLD = 10;
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // Pasted FILES (e.g. from Finder) take precedence over text — they arrive as a FileList on clipboardData and are attached like browsed files. The File's content is read directly via the File API; webUtils.getPathForFile is used opportunistically for a real on-disk path.
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      const wu = (typeof window !== 'undefined' ? (window as any).webUtils : undefined) as
        | { getPathForFile?: (f: File) => string }
        | undefined;
      for (const f of Array.from(files)) {
        const name = f.name || 'pasted-file';
        // Prefer the real on-disk path so the chip matches a browsed file's
        // 2-segment shortName; fall back to the bare filename.
        const realPath = wu?.getPathForFile?.(f) || name;
        const kind = kindForPath(name);
        if (kind === 'image') {
          // Images attach by path only (no inline content), matching the
          // browsed-file behavior in AttachButton.
          addAttachment({ path: shortName(realPath), kind, absPath: realPath });
          continue;
        }
        // Read the File's content directly (async); bump pendingReads so send() stays disabled until content lands in `attachments`, otherwise send() could snapshot state and drop the attachment.
        bumpPendingReads(1);
        f.text().then((content) => {
          const MAX = 200_000; // matches the IPC read cap in readExternalFile
          const truncated = content.length > MAX;
          addAttachment({
            path: shortName(realPath),
            kind,
            content: truncated ? content.slice(0, MAX) : content,
            bytes: f.size,
            truncated,
            absPath: realPath,
          });
        }).catch(() => {
          addAttachment({ path: shortName(realPath), kind: 'text', content: '[read failed]', absPath: realPath });
        }).finally(() => bumpPendingReads(-1));
      }
      return;
    }

    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const lineCount = text.split('\n').length;
    if (lineCount <= PASTE_LINE_THRESHOLD) {
      // Insert as plain text — no formatting, no nested chips from external
      // sources. execCommand is deprecated but still the cleanest way to
      // insert text at the cursor in a contentEditable.
      e.preventDefault();
      document.execCommand('insertText', false, text);
      return;
    }
    // Long paste → virtual attachment (unchanged behavior).
    e.preventDefault();
    const name = `Pasted - ${lineCount} lines.txt`;
    addAttachment({ path: name, kind: 'paste', content: text });
  };

  /** Open the slash picker via button click by inserting `/` at the cursor so existing slash detection picks it up — unifies the button and typing trigger into one picker. */
  const openSlashFromButton = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    let range: Range;
    if (savedRangeRef.current && editor.contains(savedRangeRef.current.startContainer)) {
      range = savedRangeRef.current;
    } else {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    sel?.removeAllRanges();
    sel?.addRange(range);
    // Insert just `/` (no trailing nbsp) so cursor lands right after it — required for `\/(\w*)$` to match with empty query and open the picker; a nbsp would yield `/ ` which breaks the regex.
    const textNode = document.createTextNode('/');
    range.deleteContents();
    range.insertNode(textNode);
    // Place cursor right after the slash character (offset 1 within the text node).
    const newRange = document.createRange();
    newRange.setStart(textNode, 1);
    newRange.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(newRange);
    savedRangeRef.current = newRange.cloneRange();
    // Detect triggers on the next tick — the selection needs to propagate
    // before detectSlashQueryAt/detectAtQueryAt reads window.getSelection().
    requestAnimationFrame(() => detectTriggers());
    bumpVersion();
  }, [detectTriggers]);

  const pickSlashMention = useCallback((m: Mention) => {
    const range = slashRangeRef.current;
    if (range) {
      // Validate the saved range's nodes are still in the editor — the
      // user could in theory have moved focus elsewhere between the
      // picker opening and the click.
      const editor = editorRef.current;
      if (editor && editor.contains(range.startContainer) && editor.contains(range.endContainer)) {
        savedRangeRef.current = range;
      }
    }
    setSlashQuery(null);
    slashRangeRef.current = null;
    insertMention(m);
  }, [insertMention]);

  /** Pick a project file from the @ picker — inserts the file path as text. */
  const pickAtFile = useCallback((filePath: string) => {
    const range = atRangeRef.current;
    const editor = editorRef.current;
    if (range && editor && editor.contains(range.startContainer)) {
      savedRangeRef.current = range;
    }
    setAtQuery(null);
    atRangeRef.current = null;
    // Replace the @query with the file path (keep the @ as a reference marker).
    insertMention({
      id: `file_${Date.now()}`,
      kind: 'context',
      name: filePath,
      description: 'Project file',
      content: undefined,
      source: 'project',
      filePath,
    });
  }, [insertMention]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Don't intercept Enter during IME composition (CJK input).
    if (e.nativeEvent.isComposing) return;

    // When the slash picker is open, intercept navigation keys. These
    // MUST run before the Enter-to-send check below, otherwise pressing
    // Enter to confirm a picker selection would submit the turn.
    if (slashQuery !== null && slashItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashHighlight((i) => (i + 1) % slashItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashHighlight((i) => (i - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = slashItems[slashHighlight];
        if (item) pickSlashMention(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashQuery(null);
        slashRangeRef.current = null;
        return;
      }
      if (e.key === 'Tab') {
        // Tab also confirms the highlighted item — matches common IDE
        // autocomplete behavior. preventDefault so focus doesn't leave
        // the editor.
        e.preventDefault();
        const item = slashItems[slashHighlight];
        if (item) pickSlashMention(item);
        return;
      }
    } else if (slashQuery !== null && e.key === 'Escape') {
      // Picker open but no items — Escape still closes it.
      e.preventDefault();
      setSlashQuery(null);
      slashRangeRef.current = null;
      return;
    }

    // ── @ file picker keyboard navigation ──
    if (atQuery !== null && atItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAtHighlight((i) => (i + 1) % atItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAtHighlight((i) => (i - 1 + atItems.length) % atItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = atItems[atHighlight];
        if (item) pickAtFile(item.path);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAtQuery(null);
        atRangeRef.current = null;
        return;
      }
    } else if (atQuery !== null && e.key === 'Escape') {
      e.preventDefault();
      setAtQuery(null);
      atRangeRef.current = null;
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  /** Walk the editor DOM and produce both a display string (for the chat bubble) and a prompt string (for the model); chips contribute a `/{name}` token to display and a full content block to the prompt. */
  const buildOutgoingContent = useCallback((): {
    displayText: string;
    promptText: string;
    mentions: Array<{ name: string; kind: 'skill' | 'agent' | 'context' | 'mcp'; source?: 'project' | 'user' | 'builtin'; filePath?: string; description?: string }>;
  } => {
    const editor = editorRef.current;
    if (!editor) return { displayText: '', promptText: '', mentions: [] as Array<{ name: string; kind: 'skill' | 'agent' | 'context' | 'mcp'; source?: 'project' | 'user' | 'builtin'; filePath?: string; description?: string }> };

    let displayText = '';
    let promptText = '';
    const mentions: Array<{ name: string; kind: 'skill' | 'agent' | 'context' | 'mcp'; source?: 'project' | 'user' | 'builtin'; filePath?: string; description?: string }> = [];

    const walk = (node: Node) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent ?? '';
          displayText += text;
          promptText += text;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const el = child as HTMLElement;
          const id = el.dataset.mentionId;
          if (id) {
            const m = mentionsRef.current.get(id);
            if (m) {
              // Display: emit a markdown link so the chat bubble can render
              // the chip ABOVE the text. Skills/agents use the bare /name
              // form (inline text chip); file references use the
              // [/path/](absPath) form (chip above text).
              if (m.kind === 'context') {
                const target = m.filePath ?? m.name;
                displayText += `[/${m.name}/](${target})`;
              } else {
                displayText += `/${m.name}`;
              }
              // Prompt: for skills/agents WITH a file path, emit the LOAD_SKILL marker so the orchestrator runs the skill as a sub-agent BEFORE the model thinks (inlining the body produces a CRITICAL directive GLM-5.2 ignores). For entries without absPath (built-in agents, context files), fall back to the inline content block.
              if (m.absPath && (m.kind === 'skill' || m.kind === 'agent')) {
                promptText += `\n[[LOAD_SKILL:${m.absPath}|${m.name}]]\n`;
              } else {
                promptText += `\n${mentionBlock(m)}\n`;
              }
              // Metadata for chip rendering + chat bubble tooltips.
              mentions.push({ name: m.name, kind: m.kind, source: m.source, filePath: m.filePath, description: m.description });
            }
          } else if (el.tagName === 'BR') {
            // <br> is a line break — preserve it as a newline. Without this,
            // soft-wrapped lines (Shift+Enter) collapse into the prior line.
            displayText += '\n';
            promptText += '\n';
          } else {
            // Block-level elements (DIV, P, etc.) start a new visual line — without prefixing a newline here, multi-line input collapses to a single line on send (textContent reads "line1line2" instead of "line1\nline2").
            const isBlock =
              el.tagName === 'DIV' ||
              el.tagName === 'P' ||
              (typeof getComputedStyle === 'function' &&
                getComputedStyle(el).display !== 'inline');
            const sep = isBlock && (displayText || promptText) ? '\n' : '';
            displayText += sep;
            promptText += sep;
            walk(el);
          }
        }
      });
    };
    walk(editor);

    displayText = displayText.replace(/\u00A0/g, ' ').trim();
    promptText = promptText.replace(/\u00A0/g, ' ').trim();

    const existingNames = new Set(mentions.map((m) => m.name.toLowerCase()));
    const slashMatch = displayText.match(/^\/([\w][\w.-]*)\s?/);
    if (slashMatch) {
      const name = slashMatch[1].toLowerCase();
      if (!existingNames.has(name)) {
        const found = catalog.find((m) => m.name.toLowerCase() === name);
        if (found) {
          const rest = promptText.slice(slashMatch[0].length).trim();
          // Built-in commands (like /compact) — pass through as-is, MainScreen
          // intercepts them. No skill file to load, no guidance block to inject.
          if (found.source === 'builtin' && found.kind === 'skill' && !found.absPath) {
            promptText = `/${found.name}${rest ? ` ${rest}` : ''}`;
          } else if (found.absPath) {
            // Orchestrator-driven load (reliable): runSdkTurn reads the file BEFORE the model thinks and replaces the marker with the body wrapped in a strong "follow this first" directive. This doesn't depend on the model calling any tool — GLM-5.2 ignores "call load_skill first" directives. The load_skill tool stays available for future model-initiated skill discovery.
            promptText = `[[LOAD_SKILL:${found.absPath}|${found.name}]]${rest ? `\n${rest}` : ''}`;
          } else {
            // No file (built-in agent, mocked MCP) — inline the guidance block.
            promptText = `\n${mentionBlock(found)}\n` + (rest ? `\n${rest}\n` : '');
          }
          mentions.push({ name: found.name, kind: found.kind, source: found.source });
        }
      }
    }

    return { displayText, promptText, mentions };
  }, [catalog]);

  const hasEditorContent = (): boolean => {
    const editor = editorRef.current;
    if (!editor) return false;
    if (editor.innerText.trim().length > 0) return true;
    return editor.querySelector('[data-mention-id]') !== null;
  };

  const send = () => {
    // Safety net: the send button is disabled while paste-file reads are
    // pending, but the Enter key path bypasses the button. Refuse to send
    // until reads land so attachments aren't dropped.
    if (pendingReads > 0) return;
    const { displayText, promptText, mentions } = buildOutgoingContent();
    // Allow send if there's editor content (text or chips) OR attachments.
    if (!displayText && attachments.length === 0 && mentions.length === 0) return;

    // Encode attachments as markdown links prepended to display text. The link TARGET carries the absolute path so the viewer can re-read via readExternalFile even after a reload (inline content is gone and attachments[] isn't persisted). The LABEL stays as the short display name, making chips part of message.content AND re-openable across reloads.
    const attachmentLinks = attachments.length > 0
      ? attachments.map((a) => `[/${a.path}/](${a.absPath ?? a.path})`).join(' ') + '\n'
      : '';
    const textWithAttachments = attachmentLinks + displayText;

    const hasMentions = mentions.length > 0;
    const payload: ChatComposerPayload = {
      text: textWithAttachments,
      // Only include promptText when it differs from displayText (i.e.,
      // there are mentions with content). Saves the caller from checking.
      promptText: hasMentions ? promptText : undefined,
      mentions: hasMentions ? mentions : undefined,
      attachments: attachments.map((a) => ({
        path: a.path,
        kind: a.kind,
        content: a.content,
        bytes: a.bytes,
        truncated: a.truncated,
        absPath: a.absPath,
      })),
    };

    if (inProgress && sessionId) {
      const queueText = payload.attachments.length
        ? `${payload.text}\n\n[Attached: ${payload.attachments.map((a) => a.path).join(', ')} — re-attach after queue flush]`
        : payload.text;
      enqueue(sessionId, queueText);
      clearEditor();
      return;
    }

    onSubmit?.(payload);
    clearEditor();
    setMainView('chat');
  };

  const clearEditor = () => {
    const editor = editorRef.current;
    if (editor) editor.innerHTML = '';
    mentionsRef.current.clear();
    clearAttachments();
    bumpVersion();
  };

  // Compute current state for the bottom row. Reads from DOM on each render
  // (cheap — small tree) so the chars counter + send button stay accurate
  // without a separate text state.
  const editorText = editorRef.current?.innerText ?? '';
  const editorEmpty = !hasEditorContent();
  const chipCount = mentionsRef.current.size;

  return (
    <div className="flex flex-col gap-0 relative">
      {sessionId && (
        <QueuedMessages
          sessionId={sessionId}
          inProgress={inProgress}
          onSendItem={(text) => onSubmit?.({ text, attachments: [] })}
        />
      )}

      {/* Slash picker — floating above the composer via absolute positioning. */}
      {slashQuery !== null && (
        <div className="absolute bottom-full left-0 right-0 mb-1 z-50">
          <SlashPicker
            items={slashItems}
            highlightedIndex={slashHighlight}
            onPick={pickSlashMention}
            onHighlight={setSlashHighlight}
          />
        </div>
      )}

      {/* @ file picker — same floating popover approach for project files. */}
      {atQuery !== null && (
        <div className="absolute bottom-full left-0 right-0 mb-1 z-50">
          <ProjectFilePicker
            items={atItems}
            highlightedIndex={atHighlight}
            onPick={pickAtFile}
            onHighlight={setAtHighlight}
          />
        </div>
      )}

      <div className="border border-input bg-card rounded-md flex overflow-hidden focus-within:border-ring focus-within:shadow-xs focus-within:ring-[3px] focus-within:ring-ring/50 hover:border-ring hover:ring-[3px] hover:ring-ring/50 shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground">
        {/* ====================================================
            LEFT — vertical toolbar (attach, @).
           ==================================================== */}
        <div className="flex flex-col items-center gap-1 py-2 px-1">
          <AttachButton onAdd={addAttachment} />
          <MentionButton onPick={handleMention} onClickTrigger={openSlashFromButton} />
        </div>

        {/* ====================================================
            CENTER — contentEditable + attachment chips + bottom row
           ==================================================== */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          {/* Placeholder — sibling of the editor (NOT wrapping it).
              Wrapping causes React to destroy+recreate the contentEditable,
              losing all chips and text on re-render. */}
          {editorEmpty && (
            <div
              aria-hidden="true"
              className={cn(
                'absolute left-0 right-0 pointer-events-none text-sm text-muted-foreground/60',
                // When attachments are present, offset the placeholder below
                // the attachment chip row so it doesn't overlap them.
                attachments.length > 0 ? 'top-[2rem]' : 'top-0',
                compact ? 'py-2 px-3' : 'py-3 px-3',
              )}
            >
              {placeholder}
            </div>
          )}

          {/* Attachment chips above the editor. Mentions are NOT here —
              they live inline in the editor itself. Each chip shows a
              file-type icon (paste/code/text/image) so pasted files render
              like picker-selected attachments. */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {attachments.map((a) => (
                <span
                  key={a.path}
                  className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 border text-[11px] font-mono rounded-md border-border bg-foreground/15 text-foreground/70"
                  title={a.kind === 'paste' ? a.content : a.path}
                >
                  {a.kind === 'paste' && <ClipboardPaste className="size-3 shrink-0" />}
                  {a.kind === 'code' && <FileCode2 className="size-3 shrink-0" />}
                  {a.kind === 'text' && <FileText className="size-3 shrink-0" />}
                  {a.kind === 'image' && <ImageIcon className="size-3 shrink-0" />}
                  <span className="truncate max-w-[16rem]">{a.path}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.path)}
                    className="text-muted-foreground/60 hover:text-destructive px-0.5"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div
            ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label={placeholder}
              onInput={() => {
                bumpVersion();
                detectTriggers();
                // Fire live text to the parent — EmptyChatState uses this
                // to auto-suggest a worktree branch name as the user types.
                onChange?.(editorRef.current?.innerText ?? '');
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              className={cn(
                'chat-composer-editor',
                'w-full bg-transparent border-0 resize-none outline-none text-sm focus:outline-none',
                // min-height: 4 rows compact (~5rem at 14px text + 1.5 line-height),
                // 6 rows full (~8.5rem). Grows naturally with content beyond that.
                compact ? 'min-h-[5.25rem] py-2 px-3' : 'min-h-[5.25rem] py-3 px-3',
              )}
          />

          {/* Bottom row — selectors, counters, send/stop */}
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            <PermissionModeSelector />
            <ModelSelector />
            {thinkingSupported && <ThinkingLevelSelector />}

            {!compact && attachments.length > 0 && (
              <Chip className="ml-1">{attachments.length} attached</Chip>
            )}
            {!compact && chipCount > 0 && (
              <Chip className="ml-1">{chipCount} mentioned</Chip>
            )}
            {!compact && (
              <span className="ml-2 text-[11px] text-muted-foreground/60 font-mono">
                {editorText.length} chars
              </span>
            )}

            <div className="flex-1" />

            {inProgress && (!editorEmpty || attachments.length > 0) && (
              <SendStopButton
                mode="stop"
                onSend={() => send()}
                onStop={() => onStop?.()}
              />
            )}
            <SendStopButton
              mode={!editorEmpty || attachments.length > 0 ? 'send' : inProgress ? 'stop' : 'send'}
              willQueue={inProgress && !!sessionId}
              disabled={pendingReads > 0 || (!inProgress && editorEmpty && attachments.length === 0)}
              onSend={() => send()}
              onStop={() => onStop?.()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
