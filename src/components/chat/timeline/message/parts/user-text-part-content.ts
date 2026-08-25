/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/message/parts/userTextPartContent.ts.
 *  Adaptation: upstream injects agent-mention and skill links via
 *  `@/lib/messages/inlineMessageLinks` (`buildAgentHref`/`buildSkillHref`,
 *  upstream app-link helpers on the delete-on-sight list — Tide has no
 *  app-link runtime). Those branches are dropped; instead Tide's own mention
 *  metadata (composer slash-picks) renders known `/name` tokens as chip spans
 *  via `tide-user-mention-chip` (styled in chat-timeline.css). File mentions
 *  are NOT handled here — they persist as `[/label/](target)` links which
 *  parseRefLinks lifts into chips before this runs. Text stays escaped with
 *  preserved hard line breaks. `SKILL_TOKEN_PATTERN` is kept for downstream
 *  consumers (Task 4+). */

import type { AgentMentionInfo } from '../types';
import type { UserMentionMeta } from './user-ref-links';

export const SKILL_TOKEN_PATTERN = /(^|\s)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/g;

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

const escapeHtml = (text: string): string => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

const mapNonFencedSegments = (markdown: string, mapSegment: (segment: string) => string): string => {
  return markdown
    .split(FENCED_CODE_SEGMENT_PATTERN)
    .map((segment, index) => (index % 2 === 1 ? segment : mapSegment(segment)))
    .join('');
};

// In Markdown a single "\n" is a soft break (rendered as a space). Users type plain
// text where each newline is meant literally, so convert soft breaks into hard breaks
// (two trailing spaces) outside of fenced code blocks, where newlines are already literal.
const applyHardLineBreaks = (markdown: string): string => {
  return mapNonFencedSegments(markdown, (segment) => segment.replace(/ *\n/g, '  \n'));
};

const MENTION_SPLIT_RE = /(\/[a-zA-Z][\w-]*)/g;

/** Escape a segment while wrapping known-mention `/name` tokens in chip spans.
 *  Mirrors the legacy renderUserBody: tokens preceded by ':' stay plain (URL
 *  paths like https://), unknown names stay plain, 'context' mentions are
 *  excluded (they render as file chips above the text). */
const escapeHtmlWithMentionChips = (segment: string, known: Map<string, UserMentionMeta>): string => {
  if (known.size === 0) return escapeHtml(segment);

  const parts = segment.split(MENTION_SPLIT_RE);
  return parts
    .map((part, i) => {
      if (/^\/[a-zA-Z][\w-]*$/.test(part)) {
        const prev = i > 0 ? parts[i - 1] : '';
        if (prev.endsWith(':')) return escapeHtml(part);
        const meta = known.get(part.slice(1));
        if (!meta) return escapeHtml(part);
        const title = [meta.description ?? meta.name, meta.filePath]
          .filter((s): s is string => Boolean(s))
          .map((s) => escapeHtml(s))
          .join('&#10;');
        return `<span class="tide-user-mention-chip" title="${escapeHtml(title)}">${escapeHtml(part)}</span>`;
      }
      return escapeHtml(part);
    })
    .join('');
};

export const prepareUserMarkdownContent = ({
  textContent,
  agentMention,
  skillNames,
  mentions,
}: {
  textContent: string;
  agentMention?: AgentMentionInfo;
  skillNames: ReadonlySet<string>;
  mentions?: UserMentionMeta[];
}): string => {
  void agentMention; // Seam: upstream agent/skill link injection dropped (see header).
  void skillNames;

  // Known non-context mentions → inline chip spans (escaped around them).
  const known = new Map<string, UserMentionMeta>();
  for (const m of mentions ?? []) {
    if (m.kind === 'context') continue;
    known.set(m.name, m);
  }

  let content = mapNonFencedSegments(textContent, (segment) => escapeHtmlWithMentionChips(segment, known));

  // Preserve user newlines (markdown soft breaks would otherwise collapse to spaces)
  return applyHardLineBreaks(content);
};
