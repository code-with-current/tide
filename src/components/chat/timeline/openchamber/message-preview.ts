/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/lib/messagePreview.ts.
 *  Adaptation: `Part` from '@opencode-ai/sdk/v2' → vendored `OcPart`; logic unchanged. */
import type { OcPart } from './types/opencode-parts';

export function getFullText(parts: OcPart[]): string {
  return parts
    .filter((p): p is OcPart & { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

export function getMessagePreview(parts: OcPart[], maxLength = 80): string {
  const full = getFullText(parts);
  const singleLine = full.replace(/\n/g, ' ');
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}…` : singleLine;
}
