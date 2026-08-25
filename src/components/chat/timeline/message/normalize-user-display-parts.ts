/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/message/normalizeUserDisplayParts.ts.
 *  Ported faithfully (re-indented 4-space → 2-space); SDK `Part` becomes
 *  Tide's structural `TimelinePart`. The synthetic GitHub issue/PR attachment parts
 *  are kept even though Tide's adapter never emits synthetic parts —
 *  `hiddenUserMessage` and `filterVisibleParts` depend on this normalization
 *  contract, and the downstream file-attachment renderer those parts target is
 *  permanently dropped (ruling 2), so they simply flow through unrendered. */

import type { TimelinePart } from '../types/message-parts';

const GITHUB_ISSUE_CONTEXT_PREFIX = 'GitHub issue context (JSON)';
const GITHUB_PR_CONTEXT_PREFIX = 'GitHub pull request context (JSON)';

type GitHubIssueContextPayload = {
  issue?: {
    number?: unknown;
    title?: unknown;
    url?: unknown;
  };
};

type GitHubPrContextPayload = {
  pr?: {
    number?: unknown;
    title?: unknown;
    url?: unknown;
  };
};

const isPositiveNumber = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
};

const parseSyntheticJsonPayload = <T>(text: string, prefix: string): T | null => {
  const normalizedText = text.trimStart();
  if (!normalizedText.startsWith(prefix)) {
    return null;
  }

  const jsonStart = normalizedText.indexOf('{');
  if (jsonStart < 0) {
    return null;
  }

  try {
    return JSON.parse(normalizedText.slice(jsonStart)) as T;
  } catch {
    return null;
  }
};

const buildGitHubAttachmentPart = (text: string): TimelinePart | null => {
  const issuePayload = parseSyntheticJsonPayload<GitHubIssueContextPayload>(text, GITHUB_ISSUE_CONTEXT_PREFIX);
  if (issuePayload) {
    const issue = issuePayload.issue;
    const number = issue?.number;
    const title = issue?.title;
    const url = issue?.url;
    if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
      return null;
    }

    return {
      type: 'file',
      mime: 'application/vnd.github.issue-link',
      filename: `Issue #${number}: ${title}`,
      url,
    } as unknown as TimelinePart;
  }

  const prPayload = parseSyntheticJsonPayload<GitHubPrContextPayload>(text, GITHUB_PR_CONTEXT_PREFIX);
  if (prPayload) {
    const pr = prPayload.pr;
    const number = pr?.number;
    const title = pr?.title;
    const url = pr?.url;
    if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
      return null;
    }

    return {
      type: 'file',
      mime: 'application/vnd.github.pull-request-link',
      filename: `PR #${number}: ${title}`,
      url,
    } as unknown as TimelinePart;
  }

  return null;
};

const shouldKeepSyntheticUserText = (text: string, planModeEnabled: boolean): boolean => {
  const trimmed = text.trim();
  if (planModeEnabled && trimmed.startsWith('User has requested to enter plan mode')) return true;
  if (planModeEnabled && trimmed.startsWith('The plan at ')) return true;
  if (trimmed.startsWith('The following tool was executed by the user')) return true;
  return false;
};

export const normalizeUserDisplayParts = (parts: TimelinePart[], options?: { planModeEnabled?: boolean }): TimelinePart[] => {
  const planModeEnabled = options?.planModeEnabled === true;
  return parts
    .filter((part) => {
      const synthetic = (part as { synthetic?: boolean }).synthetic === true;
      if (!synthetic) return true;
      if (part.type !== 'text') return false;
      const text = (part as { text?: unknown }).text;
      if (typeof text !== 'string') {
        return false;
      }

      const normalizedText = text.trimStart();
      return shouldKeepSyntheticUserText(text, planModeEnabled)
        || normalizedText.startsWith(GITHUB_ISSUE_CONTEXT_PREFIX)
        || normalizedText.startsWith(GITHUB_PR_CONTEXT_PREFIX);
    })
    .map((part) => {
      const rawPart = part as Record<string, unknown>;
      if (rawPart.type === 'compaction') {
        return { type: 'text', text: '/compact' } as TimelinePart;
      }
      if (rawPart.type === 'text') {
        const text = typeof rawPart.text === 'string' ? rawPart.text.trim() : '';
        const synthetic = rawPart.synthetic === true;

        if (synthetic) {
          const attachmentPart = buildGitHubAttachmentPart(text);
          if (attachmentPart) {
            return attachmentPart;
          }
        }

        if (text.startsWith('The following tool was executed by the user')) {
          return { type: 'text', text: '/shell' } as TimelinePart;
        }
      }
      return part;
    });
};
