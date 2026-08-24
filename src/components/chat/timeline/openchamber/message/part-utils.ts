/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/message/partUtils.ts.
 *  Pure part helpers — ported faithfully (re-indented 4-space → 2-space);
 *  `Part` from `@opencode-ai/sdk/v2` becomes Tide's structural `OcPart`. */

import type { OcPart } from '../types/opencode-parts';

type PartWithText = OcPart & { text?: string; content?: string; value?: string };

const isValidPart = (part: unknown): part is OcPart => {
  return Boolean(part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string');
};

export const normalizeParts = (parts: OcPart[]): OcPart[] => {
  return parts.filter(isValidPart);
};

export const extractTextContent = (part: OcPart): string => {
  const partWithText = part as PartWithText;
  const rawText = partWithText.text;
  if (typeof rawText === 'string') {
    return rawText;
  }
  return partWithText.content || partWithText.value || '';
};

export const isEmptyTextPart = (part: OcPart): boolean => {
  if (part.type !== 'text') {
    return false;
  }
  const text = extractTextContent(part);
  return !text || text.trim().length === 0;
};

type PartWithSynthetic = OcPart & { synthetic?: boolean };

interface VisibleFilterOptions {
  includeReasoning?: boolean;
}

export const filterVisibleParts = (parts: OcPart[], options: VisibleFilterOptions = {}): OcPart[] => {
  const { includeReasoning = true } = options;
  const validParts = normalizeParts(parts);

  // Check if there are any non-synthetic parts
  const hasNonSynthetic = validParts.some((part) => {
    const partWithSynthetic = part as PartWithSynthetic;
    return !partWithSynthetic.synthetic;
  });

  return validParts.filter((part) => {
    const partWithSynthetic = part as PartWithSynthetic;
    const isSynthetic = Boolean(partWithSynthetic.synthetic);

    if (isSynthetic && part.type === 'text') {
      const text = extractTextContent(part);
      if (text.includes('<system-reminder>')) {
        return false;
      }
    }

    // Only filter out synthetic parts if there are non-synthetic parts present
    // Otherwise, show synthetic parts so the message is displayed
    if (isSynthetic && hasNonSynthetic) {
      return false;
    }
    if (!includeReasoning && part.type === 'reasoning') {
      return false;
    }
    const isPatchPart = part.type === 'patch';

    return !isPatchPart;
  });
};
