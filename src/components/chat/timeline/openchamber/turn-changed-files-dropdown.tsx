/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/TurnChangedFilesDropdown.tsx — ADAPTED.
 *  - `@base-ui/react` Popover → Tide shadcn Popover (PopoverTrigger asChild + PopoverContent;
 *    the portal-into-dialog dance is Radix's own portal handling now).
 *  - Dropped: useDirectoryStore/useIsGitRepo/useUIStore (OpenChamber stores). The git-repo
 *    skip is gone (PendingChangesBar is out of scope), `currentDirectory` is a prop
 *    (default '' renders raw paths), and opening a file is an optional `onOpenFile` prop —
 *    upstream's openContextDiff/navigateToDiff mobile branches have no Tide equivalent yet
 *    (Task 8 wires the diff viewer); without the prop the click just closes the popover.
 *  - Part filter narrowed to Tide edit tools (FILE_EDIT_TOOLS) via the adapted changed-files
 *    extractor; TurnActivityRecord comes from the ported lib/turns/types. */

import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { TurnActivityRecord } from './lib/turns/types';
import {
  type ChangedFile,
  extractChangedFiles,
} from './changed-files';
import { ChangedFilesList } from './changed-files-list';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from './changed-files-popover';
import { Icon } from './icon';

interface TurnChangedFilesDropdownProps {
  activityParts: TurnActivityRecord[] | undefined;
  directory?: string;
  onOpenFile?: (file: ChangedFile) => void;
}

export const TurnChangedFilesDropdown: React.FC<TurnChangedFilesDropdownProps> = React.memo(({
  activityParts,
  directory,
  onOpenFile,
}) => {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const currentDirectory = directory ?? '';

  const changedFiles = React.useMemo<ChangedFile[]>(() => {
    if (!activityParts || activityParts.length === 0) return [];
    const toolParts = activityParts.map((activity) => activity.part);
    return extractChangedFiles(toolParts);
  }, [activityParts]);

  if (changedFiles.length === 0) return null;

  const handleOpenFile = (file: ChangedFile) => {
    onOpenFile?.(file);
    setIsExpanded(false);
  };

  const fileCount = changedFiles.length;
  const label = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;

  return (
    <Popover open={isExpanded} onOpenChange={setIsExpanded}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-sm text-muted-foreground/60 hover:text-muted-foreground tabular-nums"
              aria-label={`${label} changed in this turn`}
            >
              <Icon name="file-edit" className="h-3.5 w-3.5" />
              <span className="message-footer__label">{label}</span>
              {isExpanded ? (
                <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
              ) : (
                <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label} changed in this turn</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        style={changedFilesPopoverStyle}
        className={`${changedFilesPopoverClassName} transition-all duration-150 ease-out`}
      >
        <ChangedFilesList
          files={changedFiles}
          currentDirectory={currentDirectory}
          onOpenFile={handleOpenFile}
        />
      </PopoverContent>
    </Popover>
  );
});

TurnChangedFilesDropdown.displayName = 'TurnChangedFilesDropdown';
