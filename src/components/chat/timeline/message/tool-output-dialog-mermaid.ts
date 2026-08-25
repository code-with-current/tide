/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/message/toolOutputDialogMermaid.ts.
 *  Adaptation: i18n types (`I18nKey`/`I18nParams`) are stripped —
 *  `MermaidLoadFailure.key` now carries the literal English message (upstream
 *  key `chat.toolOutputDialog.mermaid.dataUrlMalformed` → same text). Logic
 *  otherwise ported verbatim (re-indented 4-space to 2-space). */

export class MermaidLoadFailure extends Error {
  key: string;

  constructor(key: string) {
    super(key);
    this.name = 'MermaidLoadFailure';
    this.key = key;
  }
}

const mermaidLoadFailure = (key: string): MermaidLoadFailure => new MermaidLoadFailure(key);

export const isMermaidLoadFailure = (value: unknown): value is MermaidLoadFailure => value instanceof MermaidLoadFailure;

export const nextMermaidLoadRequestId = (current: number): number => current + 1;

export const isCurrentMermaidLoadRequest = (current: number, requestId: number): boolean => current === requestId;

const decodeMermaidDataUrl = (value: string): string => {
  const commaIndex = value.indexOf(',');
  if (commaIndex < 0) {
    throw mermaidLoadFailure('Malformed mermaid data URL');
  }

  const metadata = value.slice(0, commaIndex).toLowerCase();
  const payload = value.slice(commaIndex + 1);
  if (metadata.includes(';base64')) {
    return atob(payload);
  }
  return decodeURIComponent(payload);
};

export const getMermaidDataUrlSourcePromise = (value: string): Promise<string> => Promise.resolve().then(() => decodeMermaidDataUrl(value));
