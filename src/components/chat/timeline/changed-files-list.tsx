/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/ChangedFilesList.tsx — ADAPTED.
 *  - `FileTypeIcon` (upstream app component) → the ported ../icon shim's FileTypeIcon.
 *  - `ChangedFileEntry` union narrowed to `ChangedFile` (the GitChangedFile variant fed the
 *    excluded PendingChangesBar — see changed-files.ts header).
 *  - useI18n → literal English. Logic and layout otherwise unchanged. */
import React from 'react';
import { FileTypeIcon } from './icon';
import { type ChangedFile, getDisplayPath, getFileStats } from './changed-files';

interface ChangedFilesListProps {
  files: ChangedFile[];
  currentDirectory: string;
  onOpenFile: (file: ChangedFile) => void;
}

export const ChangedFilesList: React.FC<ChangedFilesListProps> = ({ files, currentDirectory, onOpenFile }) => {
  return (
    <>
      <div className="flex items-center gap-1.5 px-2 py-1 typography-ui-label font-medium text-muted-foreground">
        <span>Changed files</span>
        <span className="typography-meta tabular-nums">{files.length}</span>
      </div>

      <div className="max-h-[260px] overflow-y-auto">
        {files.map((file, index) => {
          const { fileName, dirPart } = getDisplayPath(file, currentDirectory);
          const stats = getFileStats(file);

          return (
            <button
              key={`${file.path}:${index}`}
              type="button"
              className="relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 typography-ui-label outline-hidden select-none text-left hover:bg-interactive-hover"
              title={`Open ${file.path}`}
              onClick={() => onOpenFile(file)}
            >
              <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="min-w-0 flex-1 flex items-baseline overflow-hidden" title={file.path}>
                {dirPart ? (
                  <>
                    <span
                      className="min-w-0 truncate text-muted-foreground"
                      style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                    >
                      {dirPart}
                    </span>
                    <span className="flex-shrink-0">
                      <span className="text-muted-foreground">/</span>
                      <span className="text-foreground">{fileName}</span>
                    </span>
                  </>
                ) : (
                  <span className="truncate text-foreground">{fileName}</span>
                )}
              </span>
              {(stats.additions > 0 || stats.deletions > 0) ? (
                <span className="flex-shrink-0 inline-flex items-baseline gap-1 text-[0.75rem] tabular-nums">
                  {stats.additions > 0 ? <span style={{ color: 'var(--status-success)' }}>+{stats.additions}</span> : null}
                  {stats.deletions > 0 ? <span style={{ color: 'var(--status-error)' }}>-{stats.deletions}</span> : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
};
