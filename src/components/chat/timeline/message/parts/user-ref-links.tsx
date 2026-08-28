/**
 * Contract (matches the composer): attachments & @file mentions persist in
 * message content as `[/label/](target)` markdown links; parseRefLinks lifts
 * them into a chip row. Clicking a chip opens the file (or paste content) in
 * the right-panel viewer.
 */

import React from 'react';
import { ClipboardPaste, FileCode2, FileText, Image as ImageIcon } from 'lucide-react';

import type { MessageAttachment } from '@/types';
import { Button } from '@/components/ui/button';
import { useUi, type OpenFile } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { languageForPath } from '../../panel-actions-context';

export interface UserRefLink {
  label: string;
  target: string;
}

export interface UserMentionMeta {
  name: string;
  kind: 'skill' | 'agent' | 'context' | 'mcp';
  source?: string;
  filePath?: string;
  description?: string;
}

/** Image extensions — used to infer isImage when no attachment metadata is
 *  available (e.g. old sessions whose attachments[] wasn't persisted). */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

/** Split content into (chips, body): chips = `[/label/](target)` links wherever
 *  they appear (attachments cluster at the start), order preserved; body =
 *  remaining text with the link syntax stripped. The label's wrapping slashes
 *  make the pattern unambiguous vs. ordinary markdown links. */
// oxlint-disable-next-line react/only-export-components -- helpers + component co-location follows panel-actions-context.tsx precedent.
export function parseRefLinks(content: string): { chips: UserRefLink[]; body: string } {
  const chips: UserRefLink[] = [];
  const re = /\[\/([^\]]*)\/\]\(([^)]*)\)/g;
  const body = content
    .replace(re, (_m, label: string, target: string) => {
      chips.push({ label, target });
      return '';
    })
    .replace(/[ \t]*\n[ \t]*(?=\S)/g, '\n')
    .trimStart();
  return { chips, body };
}

/** Chip icon mirroring the composer's attachment chips: image/code/paste/text. */
function refIcon(target: string, label: string) {
  const ext = target.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
    return <ImageIcon className="size-3 shrink-0" />;
  }
  if (
    ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'rb', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'swift', 'kt', 'vue', 'svelte'].includes(ext)
  ) {
    return <FileCode2 className="size-3 shrink-0" />;
  }
  if (/paste/i.test(label)) {
    return <ClipboardPaste className="size-3 shrink-0" />;
  }
  return <FileText className="size-3 shrink-0" />;
}

/** Resolve a chip click into an OpenFile for the right-panel viewer: pasted/
 *  virtual attachments carry inlineContent; browsed files fall back to absPath;
 *  workspace-relative targets read from disk like any other viewer file. */
function buildOpenFileForChip(chip: UserRefLink, attachments?: MessageAttachment[]): OpenFile {
  const attachment = attachments?.find(
    (a) => a.path === chip.target || a.absPath === chip.target || a.path === chip.label,
  );
  const isAbsolute = /^(?:\/|~\/|[A-Za-z]:[\\/])/.test(chip.target);
  const isImageByExt = IMAGE_EXTS.has(chip.target.split('.').pop()?.toLowerCase() ?? '');
  const absPath = attachment?.absPath ?? (isAbsolute ? chip.target : undefined);

  if (attachment) {
    return {
      id: chip.target,
      path: attachment.path,
      language: attachment.kind === 'image' ? 'image' : languageForPath(attachment.path),
      inlineContent: attachment.content,
      bytes: attachment.bytes,
      isImage: attachment.kind === 'image' || isImageByExt,
      external: true,
      ...(absPath ? { absPath } : {}),
    };
  }
  if (isAbsolute) {
    return {
      id: chip.target,
      path: chip.label.replace(/^\/|\/$/g, ''),
      language: languageForPath(chip.target),
      isImage: isImageByExt,
      external: true,
      absPath: chip.target,
    };
  }
  return {
    id: chip.target,
    path: chip.target,
    language: languageForPath(chip.target),
    isImage: isImageByExt,
  };
}

export const UserRefChips: React.FC<{
  chips: UserRefLink[];
  attachments?: MessageAttachment[];
  sessionId?: string | null;
}> = ({ chips, attachments, sessionId }) => {
  const handleClick = React.useCallback(
    (chip: UserRefLink) => {
      if (!sessionId) return;
      const ui = useUi.getState();
      ui.openFile(sessionId, buildOpenFileForChip(chip, attachments));
      const tabs = useTabs.getState();
      tabs.addTab(sessionId, 'files');
      tabs.setActive(sessionId, 'files');
      ui.setRightPanel(true);
    },
    [attachments, sessionId],
  );

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {chips.map((chip, i) => (
        <Button
          variant="outline"
          size="xs"
          key={`${chip.target}-${i}`}
          title={`Open ${chip.target} in viewer`}
          onClick={() => handleClick(chip)}
        >
          {refIcon(chip.target, chip.label)}
          <span className="truncate">{chip.label}</span>
        </Button>
      ))}
    </div>
  );
};
