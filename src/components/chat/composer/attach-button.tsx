import { Paperclip, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Tip } from '@/components/ui/quick-tooltip';
import * as api from '@/lib/api/client';
import { Button } from '@/components/ui/button';

export interface AttachedFile {
  path: string;
  kind: 'code' | 'image' | 'text' | 'paste';
  /** Inline contents for code/text/paste kinds. Undefined for image. */
  content?: string;
  /** Byte count of the original file, if known. */
  bytes?: number;
  /** True if `content` was truncated to fit the attachment budget. */
  truncated?: boolean;
  /** Absolute on-disk path (kept so the viewer can re-read the file after
   *  a reload, when inline content is no longer in memory). */
  absPath?: string;
}

/** Map a file extension to an attachment kind. */
export function kindForPath(p: string): AttachedFile['kind'] {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'rb', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'swift', 'kt', 'vue', 'svelte'].includes(ext)) return 'code';
  return 'text';
}

/** Extract a short display name from an absolute path. */
export function shortName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}

/** Read a file from disk and build an AttachedFile. Shared by AttachButton + composer paste handler. Images attach by path; code/text files are inline'd. */
export async function attachFromPath(
  filePath: string,
): Promise<AttachedFile | null> {
  const kind = kindForPath(filePath);
  if (kind === 'image') {
    return { path: shortName(filePath), kind, absPath: filePath };
  }
  const result = await api.readExternalFile(filePath);
  if (result) {
    return {
      path: shortName(filePath),
      kind,
      content: result.content,
      bytes: result.bytes,
      truncated: result.truncated,
      absPath: filePath,
    };
  }
  return { path: shortName(filePath), kind: 'text', content: '[read failed]', absPath: filePath };
}

/** Attach button: opens the native OS file picker for external files (anywhere on disk); selected files are read via IPC and added as attachments. */
export function AttachButton({
  onAdd,
}: {
  onAdd: (file: AttachedFile) => void;
}) {
  const [loading, setLoading] = useState(false);

  const handlePick = async () => {
    setLoading(true);
    try {
      const paths = await api.pickFiles();
      for (const filePath of paths) {
        const attached = await attachFromPath(filePath);
        if (attached) onAdd(attached);
      }
    } catch {
      // User cancelled or error — silent
    } finally {
      setLoading(false);
    }
  };

  return (
    <Tip label="Attach external file" side="right">
      <Button
        variant="ghost"
        size={'icon-sm'}
        onClick={handlePick}
        disabled={loading}
        className="size-8 rounded-md flex items-center justify-center text-input-foreground hover:text-foreground hover:bg-secondary transition-colors"
        aria-label="Attach external file"
      >
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
      </Button>
    </Tip>
  );
}
