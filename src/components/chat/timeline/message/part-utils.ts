import type { TimelinePart } from '../types/message-parts';

type PartWithText = TimelinePart & { text?: string; content?: string; value?: string };

const isValidPart = (part: unknown): part is TimelinePart => {
  return Boolean(part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string');
};

export const normalizeParts = (parts: TimelinePart[]): TimelinePart[] => {
  return parts.filter(isValidPart);
};

export const extractTextContent = (part: TimelinePart): string => {
  const partWithText = part as PartWithText;
  const rawText = partWithText.text;
  if (typeof rawText === 'string') {
    return rawText;
  }
  return partWithText.content || partWithText.value || '';
};

export const isEmptyTextPart = (part: TimelinePart): boolean => {
  if (part.type !== 'text') {
    return false;
  }
  const text = extractTextContent(part);
  return !text || text.trim().length === 0;
};

type PartWithSynthetic = TimelinePart & { synthetic?: boolean };

interface VisibleFilterOptions {
  includeReasoning?: boolean;
}

export const filterVisibleParts = (parts: TimelinePart[], options: VisibleFilterOptions = {}): TimelinePart[] => {
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
