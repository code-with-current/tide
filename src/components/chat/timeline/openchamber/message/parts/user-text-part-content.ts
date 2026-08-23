/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/message/parts/userTextPartContent.ts.
 *  Adaptation: upstream injects agent-mention and skill links via
 *  `@/lib/messages/inlineMessageLinks` (`buildAgentHref`/`buildSkillHref`,
 *  OpenChamber app-link helpers on the delete-on-sight list — Tide has no
 *  app-link runtime). Those branches are dropped: mentions/skills render as the
 *  plain typed text, still escaped and with preserved hard line breaks.
 *  `SKILL_TOKEN_PATTERN` is kept for downstream consumers (Task 4+). */

import type { AgentMentionInfo } from '../types';

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

export const prepareUserMarkdownContent = ({
  textContent,
  agentMention,
  skillNames,
}: {
  textContent: string;
  agentMention?: AgentMentionInfo;
  skillNames: ReadonlySet<string>;
}): string => {
  void agentMention; // Seam: mention/skill link injection dropped (see header).
  void skillNames;

  let content = mapNonFencedSegments(textContent, escapeHtml);

  // Preserve user newlines (markdown soft breaks would otherwise collapse to spaces)
  return applyHardLineBreaks(content);
};
