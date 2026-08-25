/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/markdown/markdownImageAssets.ts.
 *  Adaptation seam (documented): upstream validated local markdown images via
 *  an upstream server route (`/api/sessions/:id/markdown-image-grants`,
 *  through `runtimeFetch` + a runtime URL resolver) or a VSCode workspace fs
 *  bridge. Tide (Electron renderer, no such server) has neither, so the
 *  local-file grant pipeline degrades honestly: `prepareLocalMarkdownImages`
 *  reports every local source as `missing` (the gallery filters those out) and
 *  `resolveMarkdownImageSource` keeps its http/data-URL behavior verbatim,
 *  including the full size + magic-byte signature validation for data URLs.
 *  Remote and data-URL images — everything Tide can actually load — behave
 *  exactly as upstream. Wiring local-file images would need a Tide IPC grant
 *  seam (future task).
 */
const MAX_MARKDOWN_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export type PreparedMarkdownImage =
  | { status: 'ready'; path: string; outsideFileGrant?: string; expiresAt?: number }
  | { status: 'missing' | 'error' };

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new DOMException('Image load aborted', 'AbortError');
};

const hasImageSignature = async (blob: Blob, mimeType: string): Promise<boolean> => {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  switch (mimeType) {
    case 'image/png':
      return bytes[0] === 0x89 && ascii(1, 4) === 'PNG'
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif': {
      const gif = ascii(0, 6);
      return gif === 'GIF87a' || gif === 'GIF89a';
    }
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    default:
      return false;
  }
};

const validateImageBlob = async (blob: Blob, mimeType: string): Promise<void> => {
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) throw new Error('Unsupported image type');
  if (blob.size > MAX_MARKDOWN_IMAGE_BYTES) throw new Error('Image is too large');
  if (!await hasImageSignature(blob, mimeType)) throw new Error('Unsupported image data');
};

const validateDataImage = async (source: string): Promise<void> => {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/i.exec(source);
  if (!match?.[1] || match[2] === undefined) throw new Error('Invalid image data URL');
  if (match[2].length > Math.ceil(MAX_MARKDOWN_IMAGE_BYTES * 4 / 3) + 4) throw new Error('Image is too large');
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    throw new Error('Invalid image data URL');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  await validateImageBlob(new Blob([bytes]), match[1].toLowerCase());
};

export const isLocalMarkdownImageSource = (source: string): boolean => (
  !/^(?:https?:)?\/\//i.test(source)
  && !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(source)
);

/**
 * Mark every local image source as missing. Tide has no server-side grant
 * route for message-scoped local files (see header) — the gallery drops
 * missing candidates, which is the documented degradation for this port.
 */
export const prepareLocalMarkdownImages = async ({
  sources,
  signal,
}: {
  sources: readonly string[];
  directory: string;
  sessionId: string;
  messageId: string;
  signal: AbortSignal;
}): Promise<Map<string, PreparedMarkdownImage>> => {
  throwIfAborted(signal);
  return new Map(sources.map((source) => [source, { status: 'missing' } as PreparedMarkdownImage]));
};

export const resolveMarkdownImageSource = async (
  source: string,
  signal: AbortSignal,
): Promise<string> => {
  throwIfAborted(signal);
  if (/^(?:https?:)?\/\//i.test(source)) return source;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(source)) {
    await validateDataImage(source);
    throwIfAborted(signal);
    return source;
  }
  throw new Error('Local image has not been prepared');
};
